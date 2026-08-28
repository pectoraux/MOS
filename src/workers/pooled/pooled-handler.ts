/**
 * The MKT-011 pooled worker job handler (`executions.pooled.run`).
 *
 * THE PROTOCOL (state-driven, never sequence-driven — any crash point
 * converges on redelivery):
 *
 *   1. Load the dispatch + execution from durable state.
 *   2. TERMINAL execution → CONVERGED return (redelivery after completion
 *      mutates nothing — EXEC-AC-03).
 *   3. Recorded outcome without the terminal transition (crash between
 *      outcome record and transition) → apply the terminal transition from
 *      the recorded verdict; the task is NEVER re-run.
 *   4. Tenant-controlled states: pausing/paused → record the
 *      'deferred-paused' outcome and complete the job (the recovery pass
 *      re-arms a fresh cycle once the tenant resumes); unknown/reconciling
 *      → reconciliation owns the execution (never auto-driven).
 *   5. Drive the machine to running through the transition port
 *      (created→queued→starting→running — belt-and-braces for crash
 *      windows; every edge idempotency-keyed per dispatch cycle).
 *   6. Run the task runner under the §8 LOGICAL TASK key (stable across
 *      retry ATTEMPTS — MKT-010's retry is a new execution row of the same
 *      linkage, so attempt 1 and attempt 2 derive the same task key and
 *      pure runners converge to ONE content-addressed artifact).
 *   7. Success → record the set-once outcome → running→succeeded.
 *      UnknownExternalOutcomeError → record outcome 'unknown' →
 *      running→unknown (never success, never blindly retried — frozen
 *      rule; reconciliation decides).
 *      Other runner errors → rethrow (the platform queue retries with
 *      backoff; the recovery pass terminalizes failed when the job dies).
 *
 * Every lifecycle mutation goes through /executions.transitionExecution —
 * the handler is an authorized CALLER of the execution authority, never a
 * second one (AGENTS.md: no worker may become an alternate authority).
 */

import { ConflictError, PermanentExecutionFailureError } from '../../platform/errors/errors.ts';
import {
  isLegalExecutionTransition,
  isTerminalExecutionStatus,
} from '../../modules/executions/public.ts';
import type { ExecutionRecord, ExecutionStatus, ExecutionsModuleApi } from '../../modules/executions/public.ts';
import type { JobHandler, JobHandlerContext } from '../worker-host.ts';
import type { Logger } from '../../platform/observability/contract.ts';
import type {
  ExecutionDispatchRecord,
  PooledRunResult,
  TaskRunner,
} from './contract.ts';
import { deriveTaskKey } from './contract.ts';
import type { ExecutionDispatchesStore } from './execution-dispatches-store.ts';

export interface PooledHandlerDeps {
  readonly executions: ExecutionsModuleApi;
  readonly store: ExecutionDispatchesStore;
  readonly runners: ReadonlyMap<string, TaskRunner>;
  readonly logger: Logger;
}

interface PooledJobPayload {
  readonly dispatchId: string;
  readonly executionId: string;
  readonly cycle: number;
}

export function createPooledRunHandler(deps: PooledHandlerDeps): JobHandler {
  return async (ctx: JobHandlerContext): Promise<PooledRunResult> => {
    const payload = parsePayload(ctx.job.payload);
    const dispatch = await deps.store.getByDispatchId(payload.dispatchId);
    if (dispatch === null) {
      throw new PermanentExecutionFailureError(
        `pooled job references unknown dispatch ${payload.dispatchId}`,
      );
    }
    if (dispatch.executionId !== payload.executionId || dispatch.cycle !== payload.cycle) {
      throw new PermanentExecutionFailureError(
        `pooled job payload does not match dispatch ${dispatch.dispatchId} (execution/cycle drift)`,
      );
    }

    let execution = await deps.executions.getExecution(dispatch.executionId);
    if (execution === null) {
      throw new PermanentExecutionFailureError(`dispatch ${dispatch.dispatchId} references unknown execution`);
    }

    // (2) TERMINAL → converged redelivery.
    if (isTerminalExecutionStatus(execution.status)) {
      return {
        executionId: execution.executionId,
        dispatchId: dispatch.dispatchId,
        cycle: dispatch.cycle,
        verdict: 'converged',
        executionStatus: execution.status,
        ...(dispatch.outputRef !== null ? { outputRef: dispatch.outputRef } : {}),
      };
    }

    // (3) Recorded outcome, missing terminal transition (crash window):
    // apply the verdict WITHOUT re-running the task.
    if (dispatch.outcome === 'succeeded' || dispatch.outcome === 'unknown') {
      execution = await applyRecordedOutcome(deps, dispatch, execution, dispatch.outcome);
      return {
        executionId: execution.executionId,
        dispatchId: dispatch.dispatchId,
        cycle: dispatch.cycle,
        verdict: dispatch.outcome,
        executionStatus: execution.status,
        ...(dispatch.outputRef !== null ? { outputRef: dispatch.outputRef } : {}),
      };
    }

    // (4) Tenant-controlled / reconciliation-owned states.
    if (execution.status === 'pausing' || execution.status === 'paused') {
      await recordOutcomeConverging(deps, dispatch, 'deferred-paused', null, null, 'tenant paused the execution mid-dispatch');
      return {
        executionId: execution.executionId,
        dispatchId: dispatch.dispatchId,
        cycle: dispatch.cycle,
        verdict: 'deferred-paused',
        executionStatus: execution.status,
      };
    }
    if (execution.status === 'unknown' || execution.status === 'reconciling') {
      // Reconciliation owns this execution — the pooled path never
      // auto-drives an UNKNOWN outcome (frozen rule).
      return {
        executionId: execution.executionId,
        dispatchId: dispatch.dispatchId,
        cycle: dispatch.cycle,
        verdict: 'converged',
        executionStatus: execution.status,
      };
    }

    // (5) Drive to running (idempotent; converges when already moved).
    execution = await step(deps, dispatch, execution, 'queued');
    execution = await step(deps, dispatch, execution, 'starting');
    execution = await step(deps, dispatch, execution, 'running');
    if (execution.status !== 'running') {
      // Tenant control or another driver moved it — not an error; the
      // recovery pass and the tenant's commands own the rest.
      return {
        executionId: execution.executionId,
        dispatchId: dispatch.dispatchId,
        cycle: dispatch.cycle,
        verdict: 'converged',
        executionStatus: execution.status,
      };
    }

    // (6) Run the task under the §8 LOGICAL TASK key.
    const runner = deps.runners.get(dispatch.taskKind);
    if (runner === undefined) {
      throw new PermanentExecutionFailureError(
        `no pooled task runner registered for kind '${dispatch.taskKind}'`,
      );
    }
    const taskKey = deriveTaskKey(execution, dispatch);
    let result;
    try {
      result = await runner({
        execution,
        dispatch,
        input: dispatch.input,
        taskKey,
        attempt: ctx.job.attempts,
        logger: ctx.logger,
      });
    } catch (error) {
      if (isUnknownOutcomeError(error)) {
        // (7b) UNKNOWN: record + transition; the JOB completes with the
        // unknown verdict (it delivered its finding; the EXECUTION awaits
        // reconciliation).
        await recordOutcomeConverging(deps, dispatch, 'unknown', null, null, String((error as Error).message));
        execution = await step(deps, dispatch, execution, 'unknown', `unknown external outcome: ${(error as Error).message}`);
        return {
          executionId: execution.executionId,
          dispatchId: dispatch.dispatchId,
          cycle: dispatch.cycle,
          verdict: 'unknown',
          executionStatus: execution.status,
        };
      }
      throw error;
    }

    // (7a) Success: record the outcome FIRST (set-once), then the terminal
    // transition — a crash between them re-enters at (3) and applies the
    // verdict without re-running the task.
    await recordOutcomeConverging(deps, dispatch, 'succeeded', result.outputRef, result.output, '');
    execution = await step(deps, dispatch, execution, 'succeeded', '');
    return {
      executionId: execution.executionId,
      dispatchId: dispatch.dispatchId,
      cycle: dispatch.cycle,
      verdict: 'succeeded',
      executionStatus: execution.status,
      outputRef: result.outputRef,
    };
  };
}

/** Payload envelope validation (poisoned payloads die permanently). */
function parsePayload(payload: Record<string, unknown>): PooledJobPayload {
  const dispatchId = payload['dispatchId'];
  const executionId = payload['executionId'];
  const cycle = payload['cycle'];
  if (typeof dispatchId !== 'string' || typeof executionId !== 'string' || typeof cycle !== 'number') {
    throw new PermanentExecutionFailureError('pooled job payload must carry dispatchId, executionId and cycle');
  }
  return { dispatchId, executionId, cycle };
}

function isUnknownOutcomeError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'UNKNOWN_EXTERNAL_OUTCOME'
  );
}

/**
 * One idempotent, CAS-tolerant lifecycle step keyed per dispatch cycle —
 * replays converge to the recorded transition; CAS losses re-read; an
 * illegal edge (state moved elsewhere) returns the current record.
 */
async function step(
  deps: PooledHandlerDeps,
  dispatch: ExecutionDispatchRecord,
  current: ExecutionRecord,
  to: ExecutionStatus,
  reason?: string,
): Promise<ExecutionRecord> {
  let execution = current;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (isTerminalExecutionStatus(execution.status)) return execution;
    if (execution.status === to) return execution;
    if (!isLegalExecutionTransition(execution.status, to)) return execution;
    try {
      const outcome = await deps.executions.transitionExecution({
        executionId: execution.executionId,
        to,
        expectedVersion: execution.version,
        idempotencyKey: `pooled:${dispatch.dispatchId}:${dispatch.cycle}:${to}`,
        retryClassification: null,
        evidenceRef: null,
        reason: reason ?? `pooled drive ${to}`,
        actorId: null,
      });
      return outcome.execution;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const reread = await deps.executions.getExecution(execution.executionId);
      if (reread === null) throw error;
      execution = reread;
    }
  }
  return execution;
}

/** Records the outcome; a version CAS loss converges (already recorded). */
async function recordOutcomeConverging(
  deps: PooledHandlerDeps,
  dispatch: ExecutionDispatchRecord,
  verdict: 'succeeded' | 'unknown' | 'deferred-paused',
  outputRef: string | null,
  output: Record<string, unknown> | null,
  reason: string,
): Promise<void> {
  try {
    await deps.store.recordOutcome(dispatch.dispatchId, dispatch.version, verdict, outputRef, output, reason);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const current = await deps.store.getByDispatchId(dispatch.dispatchId);
    if (current === null || current.outcome === null) throw error;
    // Outcome already recorded by a concurrent delivery — converged.
    deps.logger.info('pooled.outcome.converged', undefined, {
      dispatch_id: dispatch.dispatchId,
      verdict: current.outcome,
    });
  }
}

/** Applies the terminal transition implied by a recorded outcome (3). */
async function applyRecordedOutcome(
  deps: PooledHandlerDeps,
  dispatch: ExecutionDispatchRecord,
  execution: ExecutionRecord,
  outcome: 'succeeded' | 'unknown',
): Promise<ExecutionRecord> {
  return step(deps, dispatch, execution, outcome, `applied recorded ${outcome} outcome`);
}
