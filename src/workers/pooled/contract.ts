/**
 * MKT-011 — POOLED WORKER EXECUTION (work-items.md: "execute normal tasks
 * through shared workers with durable queues and idempotency";
 * requirements.md RUNTIME-001 "pooled worker execution"; acceptance
 * RUNTIME-AC-01 "pooled worker path handles normal AI/API/data tasks" and
 * EXEC-AC-03 "retry does not create duplicate logical execution effects").
 *
 * ARCHITECTURAL PLACEMENT (frozen-conformant, deliberately NOT the
 * /executions module): the MKT-010 architecture boundary pins
 * ExecutionsModuleApi to identity/lifecycle with NO engine authority — no
 * dispatch, no dequeue, no workers (tests/architecture/executions-boundary
 * "must not carry engine authority … MKT-011 — the pooled worker
 * authority"). The pooled worker path therefore lives HERE, in the worker
 * runtime area, as the composition architecture.md §14 draws it:
 *
 *     Workflow → Task → Execution → Runtime Class → Worker or Sandbox Lease
 *
 * "The default runtime uses pooled workers" — this module IS that leg. It
 * composes the frozen authorities and NEVER becomes a second one:
 *
 *   - execution lifecycle is mutated ONLY through /executions' single
 *     transition port (transitionExecution) — the worker is an authorized
 *     CALLER of the execution authority, exactly like the API routes;
 *   - queue/job state is platform plumbing (the queue contract: "The queue
 *     is infrastructure, never a business authority");
 *   - the dispatch outbox (execution_dispatches, migration 012) records
 *     only the runtime handoff — never execution state;
 *   - task runners are provider-neutral capabilities; provider transports
 *     stay behind platform ports (composition-root wiring).
 *
 * RUNTIME-AC-01 task classes: the pooled path is task-class-generic — the
 * registry carries normal AI/API/data-class runners. MKT-011 ships
 * `data.transform` (deterministic data work with a content-addressed
 * artifact) and `api.request` (a bounded outbound API call through the
 * HttpCallPort). AI-class EXECUTIONS ride the identical path (the execution
 * kind is caller-declared and orthogonal); genuine model invocation is the
 * /ai-runtime authority (MKT-017+) and is NOT fabricated here.
 *
 * EXEC-AC-03 idempotency discipline — at-least-once delivery, exactly-once
 * logical effects:
 *   - one dispatch per Execution identity (DB UNIQUE);
 *   - one queue job per dispatch cycle (queue (queue, handler, key) fence);
 *   - every lifecycle transition keyed `pooled:{dispatchId}:{cycle}:{edge}`
 *     — job redelivery/retry replays CONVERGE to the recorded transition
 *     rows instead of re-applying (the /executions idempotency fence);
 *   - task outputs are content-addressed artifacts (identical output →
 *     identical key → no duplicate logical artifact);
 *   - the dispatch outcome is SET-ONCE (DB trigger) — a redelivery that
 *     finds a recorded outcome never re-runs the task.
 */

import { createHash } from 'node:crypto';
import {
  PermanentExecutionFailureError,
  ProviderUnavailableError,
  UnknownExternalOutcomeError,
} from '../../platform/errors/errors.ts';
import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { HttpCallPort } from '../../platform/http/outbound.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { Logger, Metrics } from '../../platform/observability/contract.ts';
import type { CorrelationContext } from '../../platform/observability/correlation.ts';
import type { ObjectStore } from '../../platform/objects/contract.ts';
import type { JobQueue } from '../../platform/queue/contract.ts';
import type { ExecutionRecord, ExecutionStatus, ExecutionsModuleApi } from '../../modules/executions/public.ts';

/** The durable queue partition and handler kind of the pooled path. */
export const POOLED_QUEUE = 'executions.pooled';
export const POOLED_HANDLER_KIND = 'executions.pooled.run';

/** The runner kinds MKT-011 registers (the registry stays extensible). */
export const POOLED_TASK_KINDS = ['data.transform', 'api.request'] as const;
export type PooledTaskKind = (typeof POOLED_TASK_KINDS)[number];

const TASK_KIND_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Envelope validation shared by the route and the dispatch command. */
export function pooledTaskKindProblem(taskKind: string): string | null {
  if (!TASK_KIND_PATTERN.test(taskKind) || taskKind.length > 100) {
    return `taskKind must match ^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$ (max 100 chars): ${taskKind}`;
  }
  return null;
}

/** Max canonical-JSON length of the dispatch input snapshot. */
export const POOLED_INPUT_MAX_JSON_LENGTH = 32_768;

/** The dispatch lifecycle statuses (mirrors migration 012). */
export type DispatchStatus = 'recorded' | 'submitted';

/** The set-once run verdict of a dispatch cycle. */
export type DispatchOutcomeVerdict = 'succeeded' | 'failed' | 'unknown' | 'deferred-paused';

/** Immutable storage shape of one pooled dispatch (execution_dispatches). */
export interface ExecutionDispatchRecord {
  readonly dispatchId: string;
  readonly executionId: string;
  readonly taskKind: string;
  readonly input: Record<string, unknown>;
  readonly inputRef: string | null;
  readonly queueName: string;
  readonly handlerKind: string;
  readonly maxAttempts: number;
  readonly dispatchStatus: DispatchStatus;
  readonly jobId: string | null;
  readonly cycle: number;
  readonly outcome: DispatchOutcomeVerdict | null;
  readonly outputRef: string | null;
  readonly output: Record<string, unknown> | null;
  readonly outcomeReason: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The outcome of a dispatch command: 201 fresh / 200 replayed semantics. */
export interface DispatchOutcome {
  readonly dispatch: ExecutionDispatchRecord;
  readonly execution: ExecutionRecord;
  readonly replayed: boolean;
}

/** The dispatch command input (route envelope → command). */
export interface DispatchCommandInput {
  readonly executionId: string;
  readonly taskKind: string;
  readonly input: Record<string, unknown>;
  readonly inputRef: string | null;
  readonly maxAttempts: number | null;
  readonly idempotencyKey: string;
  readonly actorId: string | null;
  readonly correlation: CorrelationContext;
}

/** What the pooled handler reports back as the job result (plumbing data). */
export interface PooledRunResult extends Record<string, unknown> {
  readonly executionId: string;
  readonly dispatchId: string;
  readonly cycle: number;
  readonly verdict: 'succeeded' | 'unknown' | 'converged' | 'deferred-paused';
  readonly executionStatus: ExecutionStatus;
  readonly outputRef?: string;
}

/**
 * Provider-neutral task runner contract (RUNTIME-AC-01). Runners MUST be
 * idempotent under the §8 task idempotency key: at-least-once delivery
 * means a runner may re-run after a crash — its logical effects must
 * converge (content-addressed artifacts, idempotent external calls).
 *
 * Error taxonomy runners throw (the typed platform errors carry the
 * retryable/retrySafe classification the §24 sweep consumes):
 *   - ProviderUnavailableError(retrySafe: true)  → job retries;
 *   - UnknownExternalOutcomeError                → execution records
 *     UNKNOWN (never success; never blindly retried);
 *   - PermanentExecutionFailureError             → job dies (no retry).
 */
export interface TaskRunnerContext {
  readonly execution: ExecutionRecord;
  readonly dispatch: ExecutionDispatchRecord;
  readonly input: Record<string, unknown>;
  /** The §8 task idempotency key — stable across attempts of the logical task. */
  readonly taskKey: string;
  /** The current queue-job attempt (1-based) — for deterministic retry proofs. */
  readonly attempt: number;
  readonly logger: Logger;
}

export interface TaskRunnerResult {
  /** Reference to the content-addressed output artifact (object-store key). */
  readonly outputRef: string;
  /** Inline summary recorded on the dispatch outcome (bounded JSON). */
  readonly output: Record<string, unknown>;
}

export type TaskRunner = (ctx: TaskRunnerContext) => Promise<TaskRunnerResult>;

export interface TaskRunnerDeps {
  readonly objects: ObjectStore;
  readonly clock: Clock;
  readonly http: HttpCallPort;
}

/** Builds the MKT-011 runner registry (data + api classes). */
export function buildPooledTaskRunners(deps: TaskRunnerDeps): Map<string, TaskRunner> {
  const runners = new Map<string, TaskRunner>();
  runners.set('data.transform', dataTransformRunner(deps));
  runners.set('api.request', apiRequestRunner(deps));
  return runners;
}

// ---------------------------------------------------------------------------
// data.transform — normal DATA-class pooled work: a deterministic
// normalize/sort/aggregate transform over an inline dataset, output as a
// content-addressed artifact. Pure: identical input → identical artifact
// key → retries converge to ONE logical artifact (EXEC-AC-03).
// ---------------------------------------------------------------------------

interface DataTransformInput {
  readonly records: ReadonlyArray<Record<string, unknown>>;
  readonly sortBy: string | null;
  readonly failFirstAttempts: number;
}

function parseDataTransformInput(input: Record<string, unknown>): DataTransformInput {
  const records = input['records'];
  const sortBy = input['sortBy'] ?? null;
  const failFirstAttempts = input['failFirstAttempts'] ?? 0;

  if (!Array.isArray(records) || records.length < 1 || records.length > 1000) {
    throw new PermanentExecutionFailureError(
      'data.transform input: records must be an array of 1..1000 rows',
      ['records: the inline dataset rows (JSON objects)'],
    );
  }
  for (const row of records) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new PermanentExecutionFailureError('data.transform input: every record must be a JSON object');
    }
  }
  if (sortBy !== null && (typeof sortBy !== 'string' || sortBy.length < 1 || sortBy.length > 100)) {
    throw new PermanentExecutionFailureError('data.transform input: sortBy must be a field name of 1..100 chars');
  }
  if (
    typeof failFirstAttempts !== 'number' ||
    !Number.isSafeInteger(failFirstAttempts) ||
    failFirstAttempts < 0 ||
    failFirstAttempts > 25
  ) {
    throw new PermanentExecutionFailureError('data.transform input: failFirstAttempts must be an integer 0..25');
  }
  return {
    records: records as ReadonlyArray<Record<string, unknown>>,
    sortBy: sortBy as string | null,
    failFirstAttempts,
  };
}

function dataTransformRunner(deps: TaskRunnerDeps): TaskRunner {
  return async (ctx) => {
    const parsed = parseDataTransformInput(ctx.input);

    // Deterministic transient-failure injection for retry/recovery proofs
    // (the same parameterization discipline as the MKT-001 sample handler).
    // The runner is pure and its outputs content-addressed, so a retry
    // after this failure duplicates NOTHING (retrySafe: true, §24).
    if (ctx.attempt <= parsed.failFirstAttempts) {
      throw new ProviderUnavailableError(
        `data.transform simulated transient failure (attempt ${ctx.attempt} of ${parsed.failFirstAttempts + 1})`,
        true,
      );
    }

    const rows = [...parsed.records];
    if (parsed.sortBy !== null) {
      const key = parsed.sortBy;
      rows.sort((a, b) => stableCompare(a[key], b[key]));
    }
    const summary = {
      rowCount: rows.length,
      fieldUnion: [...new Set(rows.flatMap((row) => Object.keys(row)))].sort(),
    };

    const artifactBytes = new TextEncoder().encode(
      `${JSON.stringify({ taskKey: ctx.taskKey, kind: 'data.transform', summary, rows }, null, 2)}\n`,
    );
    const artifact = await deps.objects.put(artifactBytes, { contentType: 'application/json' });
    return {
      outputRef: artifact.key,
      output: { rowCount: rows.length, artifact: { key: artifact.key, digest: artifact.digest } },
    };
  };
}

function stableCompare(a: unknown, b: unknown): number {
  const sa = canon(a);
  const sb = canon(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function canon(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// api.request — normal API-class pooled work: ONE bounded outbound call
// through the HttpCallPort, with the frozen UNKNOWN semantics mapped from
// the transport outcome:
//   - transport refused (connection/DNS, provably unprocessed) → retryable;
//   - HTTP 5xx / 429 → retryable, fail-closed unsafe classification;
//   - HTTP 2xx/3xx/4xx response → deterministic verdict, no retry;
//   - timeout after send → UNKNOWN (cannot prove the external effect;
//     state-machines-v1.2.md — never success, never blindly retried;
//     reconciliation decides).
// ---------------------------------------------------------------------------

interface ApiRequestInput {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly timeoutMs: number;
  readonly sizeCapBytes: number;
  readonly expectStatus: readonly number[];
}

function parseApiRequestInput(input: Record<string, unknown>): ApiRequestInput {
  const url = input['url'];
  const method = input['method'] ?? 'GET';
  const headers = input['headers'] ?? {};
  const body = input['body'] ?? null;
  const timeoutMs = input['timeoutMs'] ?? 5000;
  const sizeCapBytes = input['sizeCapBytes'] ?? 65536;
  const expectStatus = input['expectStatus'] ?? [];

  if (typeof url !== 'string' || url.length < 8 || url.length > 2048) {
    throw new PermanentExecutionFailureError('api.request input: url must be a string of 8..2048 chars');
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method as string)) {
    throw new PermanentExecutionFailureError('api.request input: method must be GET|POST|PUT|PATCH|DELETE');
  }
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new PermanentExecutionFailureError('api.request input: headers must be an object');
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== 'string' || key.length > 100 || value.length > 2000) {
      throw new PermanentExecutionFailureError('api.request input: header values must be strings (bounded)');
    }
    if (key.toLowerCase() === 'idempotency-key') {
      throw new PermanentExecutionFailureError('api.request input: the idempotency-key header is runtime-owned');
    }
  }
  if (body !== null && (typeof body !== 'string' || body.length > 1_048_576)) {
    throw new PermanentExecutionFailureError('api.request input: body must be a string of at most 1MB');
  }
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new PermanentExecutionFailureError('api.request input: timeoutMs must be an integer 1..60000');
  }
  if (
    typeof sizeCapBytes !== 'number' ||
    !Number.isSafeInteger(sizeCapBytes) ||
    sizeCapBytes < 1 ||
    sizeCapBytes > 1_048_576
  ) {
    throw new PermanentExecutionFailureError('api.request input: sizeCapBytes must be an integer 1..1048576');
  }
  if (!Array.isArray(expectStatus) || expectStatus.length > 20 || expectStatus.some((s) => !Number.isSafeInteger(s))) {
    throw new PermanentExecutionFailureError('api.request input: expectStatus must be an array of HTTP status ints');
  }
  return {
    url,
    method: method as ApiRequestInput['method'],
    headers: headers as Record<string, string>,
    body: body as string | null,
    timeoutMs,
    sizeCapBytes,
    expectStatus: expectStatus as readonly number[],
  };
}

function apiRequestRunner(deps: TaskRunnerDeps): TaskRunner {
  return async (ctx) => {
    const parsed = parseApiRequestInput(ctx.input);

    const response = await deps.http.request({
      url: parsed.url,
      method: parsed.method,
      headers: { ...parsed.headers, 'idempotency-key': ctx.taskKey },
      body: parsed.body,
      timeoutMs: parsed.timeoutMs,
      sizeCapBytes: parsed.sizeCapBytes,
    });

    if (response.timedOut) {
      // The request was sent; the outcome cannot be proven. UNKNOWN —
      // never success, never blindly retried (frozen rule).
      throw new UnknownExternalOutcomeError(
        `api.request timed out after send against ${parsed.url}; external effect outcome is unknown and requires reconciliation`,
      );
    }
    if (response.transportRefused) {
      // Provably unprocessed (never reached the remote side) — retryable,
      // and safe: no external effect could have occurred.
      throw new ProviderUnavailableError(
        `api.request transport refused against ${parsed.url} (request was not processed)`,
        true,
      );
    }
    if (response.status >= 500 || response.status === 429) {
      // Server-side failure; the request WAS processed and rejected. A
      // retry is safe only for keyed idempotent endpoints — fail-closed:
      // retryable but unproven-safe (the §24 sweep then classifies the
      // deliberate-retry gate conservatively).
      throw new ProviderUnavailableError(`api.request received ${response.status} from ${parsed.url}`, null);
    }

    // A definitive HTTP verdict: deterministic, no retry.
    const expected =
      parsed.expectStatus.length === 0
        ? response.status >= 200 && response.status < 300
        : parsed.expectStatus.includes(response.status);
    if (!expected) {
      throw new PermanentExecutionFailureError(
        `api.request received unexpected status ${response.status} from ${parsed.url}`,
        [`expected ${parsed.expectStatus.length === 0 ? '2xx' : parsed.expectStatus.join('|')}`],
      );
    }

    const artifactBytes = new TextEncoder().encode(
      `${JSON.stringify(
        {
          taskKey: ctx.taskKey,
          kind: 'api.request',
          url: parsed.url,
          status: response.status,
          headers: response.headers,
          body: response.body,
        },
        null,
        2,
      )}\n`,
    );
    const artifact = await deps.objects.put(artifactBytes, { contentType: 'application/json' });
    return {
      outputRef: artifact.key,
      output: { status: response.status, artifact: { key: artifact.key, digest: artifact.digest } },
    };
  };
}

// ---------------------------------------------------------------------------
// Pooled runtime service dependencies.
// ---------------------------------------------------------------------------

export interface PooledRuntimeDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly queue: JobQueue;
  readonly executions: ExecutionsModuleApi;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Derives the §8 TASK idempotency key from the LOGICAL TASK — the task
 * linkage coordinates plus the dispatch input digest — NEVER from the
 * execution row identity (implementation-contract §8: "an idempotency key
 * derived from the logical Task, workflow instance, node instance, and
 * declared retry semantics"). Consequence: attempt 1 and its retry attempt
 * (a DIFFERENT execution row of the same linkage, MKT-010 §6) derive the
 * SAME task key, so pure runners converge to ONE content-addressed logical
 * artifact across attempts (EXEC-AC-03).
 */
export function deriveTaskKey(
  execution: ExecutionRecord,
  dispatch: Pick<ExecutionDispatchRecord, 'input' | 'inputRef'>,
): string {
  const inputDigest = createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(dispatch.input)))
    .update(`|${dispatch.inputRef ?? ''}`)
    .digest('hex');
  const linkage =
    execution.taskLink.kind === 'workflow-node'
      ? `wf:${execution.taskLink.workflowInstanceId}:${execution.taskLink.nodeId}`
      : `ext:${execution.taskLink.externalRequestRef}`;
  return `pooled-task:${linkage}:${inputDigest.slice(0, 32)}`;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalizeJson(v)]);
  }
  return value;
}
