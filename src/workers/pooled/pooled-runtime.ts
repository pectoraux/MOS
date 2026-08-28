/**
 * The MKT-011 pooled runtime service: DISPATCH (the runtime handoff
 * command), RELAY (transactional-outbox drain into the durable queue) and
 * RECOVERY (dead-job terminalization, deferred-paused re-arm, stale
 * sandbox-lease release).
 *
 * Authority discipline (the whole file):
 *   - execution state changes ONLY through /executions.transitionExecution;
 *   - queue submissions ONLY through the platform JobQueue port;
 *   - this service owns exactly ONE table: execution_dispatches (the
 *     handoff record — queue plumbing correlated to execution identity,
 *     never execution state).
 *
 * Dispatch protocol (crash-safe at every point):
 *   1. record the outbox row (UNIQUE per execution — the §8 database
 *      fence; duplicate commands converge, different commands conflict);
 *   2. apply created → queued through the transition port with the CALLER's
 *      command key (a crash between (1) and (2) is recovered by the worker
 *      handler, which drives from whatever durable state it finds — the
 *      protocol is state-driven, never sequence-driven).
 *
 * Relay protocol: claim 'recorded' rows FOR UPDATE SKIP LOCKED → submit to
 * the durable queue under the cycle-scoped key
 * `execution-dispatch:{executionId}:{cycle}` → CAS the row to 'submitted'
 * with its job id. A crash between submit and CAS re-submits later and
 * CONVERGES on the queue's (queue, handler, key) fence.
 *
 * Recovery protocol (idempotent, each pass):
 *   - a dispatch whose job died while its execution is non-terminal and
 *     drivable is terminalized to failed through the transition port,
 *     walking the legal machine edges (created→queued→starting→running if
 *     needed) with the §24 classification derived from the recorded job
 *     error's retrySafe verdict;
 *   - a dispatch whose job completed with verdict 'deferred-paused' while
 *     its execution is again drivable (tenant resumed it) is RE-ARMED
 *     (cycle + 1 → the relay submits a fresh job);
 *   - an expired ACTIVE sandbox lease is released through the module's
 *     idempotent release operation (the MKT-010-documented stale-lease
 *     recovery automation — release never terminalizes the execution).
 */

import {
  ConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
} from '../../platform/errors/errors.ts';
import { isLegalExecutionTransition, isTerminalExecutionStatus } from '../../modules/executions/public.ts';
import type { ExecutionRecord, ExecutionStatus } from '../../modules/executions/public.ts';
import type { JobErrorRecord } from '../../platform/queue/contract.ts';
import {
  POOLED_HANDLER_KIND,
  POOLED_INPUT_MAX_JSON_LENGTH,
  POOLED_QUEUE,
  pooledTaskKindProblem,
  type DispatchCommandInput,
  type DispatchOutcome,
  type ExecutionDispatchRecord,
  type PooledRuntimeDeps,
} from './contract.ts';
import { ExecutionDispatchesStore, fingerprintDispatchCommand } from './execution-dispatches-store.ts';

const DRIVEABLE_STATUSES: readonly ExecutionStatus[] = ['created', 'queued', 'starting', 'running'];
const ID_KEY_MAX = 200;

/** §24 classification derived from the recorded job error (fail-closed). */
export function classificationFromJobError(error: JobErrorRecord | null): 'safe' | 'unsafe' {
  return error !== null && error.retrySafe === true ? 'safe' : 'unsafe';
}

export class PooledRuntimeService {
  private readonly store: ExecutionDispatchesStore;
  private readonly deps: PooledRuntimeDeps;
  private stopping = false;

  constructor(deps: PooledRuntimeDeps) {
    this.deps = deps;
    this.store = new ExecutionDispatchesStore(deps.db, deps.ids);
  }

  stop(): void {
    this.stopping = true;
  }

  // -------------------------------------------------------------------------
  // DISPATCH — the runtime handoff command (POST /api/executions/:id/dispatch)
  // -------------------------------------------------------------------------

  async dispatchExecution(input: DispatchCommandInput): Promise<DispatchOutcome> {
    const kindProblem = pooledTaskKindProblem(input.taskKind);
    if (kindProblem !== null) {
      throw new InvalidRequestError(kindProblem);
    }
    if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > ID_KEY_MAX) {
      throw new InvalidRequestError(`idempotencyKey must be between 1 and ${ID_KEY_MAX} characters`);
    }
    const canonicalInput = JSON.stringify(input.input);
    if (canonicalInput.length > POOLED_INPUT_MAX_JSON_LENGTH) {
      throw new InvalidRequestError(`input exceeds the ${POOLED_INPUT_MAX_JSON_LENGTH}-character dispatch snapshot cap`, [
        'pass large payloads through inputRef (an object-store reference)',
      ]);
    }
    if (input.inputRef !== null && (input.inputRef.length < 1 || input.inputRef.length > 512)) {
      throw new InvalidRequestError('inputRef must be between 1 and 512 characters');
    }

    // Canonical ownership + boundary policy. Dispatch is NEW USE: it hands
    // the execution to the pooled runtime — the owning Workspace, Client
    // and Agency must all be live and ACTIVE (mirroring the module's
    // create/into-running policy).
    const ownership = await this.deps.executions.resolveExecutionOwnership(input.executionId);
    if (ownership === null) {
      throw new NotFoundError('execution', input.executionId);
    }
    if (ownership.workspace.status !== 'active') {
      throw new ConflictError(
        `workspace ${ownership.workspace.workspaceId} is ${ownership.workspace.status}; its executions cannot be handed to the pooled runtime`,
      );
    }
    if (ownership.client.status !== 'active') {
      throw new ConflictError(
        `client ${ownership.client.clientId} is ${ownership.client.status}; its executions cannot be handed to the pooled runtime`,
      );
    }
    if (ownership.agency.status !== 'active') {
      throw new ConflictError(
        `agency ${ownership.agency.agencyId} is ${ownership.agency.status}; its executions cannot be handed to the pooled runtime`,
      );
    }

    const execution = ownership.execution;
    if (execution.runtimeClass !== 'pooled-worker') {
      throw new ConflictError(
        `execution ${execution.executionId} declares runtime class '${execution.runtimeClass}'; only pooled-worker executions dispatch through the pooled path (sandbox classes acquire runtime environments through the sandbox authority)`,
      );
    }

    // (1) IDEMPOTENCE FIRST: an existing dispatch row for this execution
    // converges (same command fingerprint) or conflicts (§8 posture — one
    // dispatch per Execution identity, fenced by the database).
    const existing = await this.store.findByExecutionId(this.deps.db, execution.executionId);
    if (existing !== null) {
      const fingerprint = fingerprintDispatchCommand({
        taskKind: input.taskKind,
        input: input.input,
        inputRef: input.inputRef,
        maxAttempts: input.maxAttempts ?? existing.maxAttempts,
      });
      if (existing.createFingerprint !== fingerprint) {
        throw new ConflictError(
          `execution ${execution.executionId} is already dispatched (dispatch ${existing.dispatchId}, key '${existing.idempotencyKey}'); one execution carries exactly one dispatch`,
        );
      }
      if (existing.idempotencyKey !== input.idempotencyKey) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      // Replay: converge — and if the created→queued transition was lost to
      // a crash between outbox write and transition, apply it now.
      const after = await this.ensureQueued(execution, existing.idempotencyKey);
      const dispatch = await this.store.findByExecutionId(this.deps.db, execution.executionId);
      return { dispatch: dispatch ?? existing, execution: after, replayed: true };
    }

    if (execution.status !== 'created') {
      if (isTerminalExecutionStatus(execution.status)) {
        throw new ConflictError(
          `execution ${execution.executionId} is ${execution.status} (terminal) and frozen; it cannot be dispatched`,
        );
      }
      throw new ConflictError(
        `execution ${execution.executionId} is ${execution.status}; the pooled path dispatches executions from 'created' (state-driven protocol — the worker drives onward states)`,
      );
    }

    // (2) RECORD THE OUTBOX ROW (the fence is the UNIQUE(execution_id)).
    const recorded = await this.deps.db.transaction(async (tx) =>
      this.store.insertDispatch(tx, {
        executionId: execution.executionId,
        taskKind: input.taskKind,
        input: input.input,
        inputRef: input.inputRef,
        queueName: POOLED_QUEUE,
        handlerKind: POOLED_HANDLER_KIND,
        maxAttempts: input.maxAttempts ?? 5,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlation.correlationId,
        causationId: input.correlation.causationId,
        actorId: input.actorId,
      }),
    );

    if ('existing' in recorded) {
      // A concurrent duplicate won the fence: converge exactly like a
      // replay (identical command) or surface the one-dispatch conflict.
      const winner = recorded.existing;
      const fingerprint = fingerprintDispatchCommand({
        taskKind: input.taskKind,
        input: input.input,
        inputRef: input.inputRef,
        maxAttempts: input.maxAttempts ?? winner.maxAttempts,
      });
      if (winner.createFingerprint !== fingerprint || winner.idempotencyKey !== input.idempotencyKey) {
        throw new ConflictError(
          `execution ${execution.executionId} is already dispatched (dispatch ${winner.dispatchId}, key '${winner.idempotencyKey}'); one execution carries exactly one dispatch`,
        );
      }
      const after = await this.ensureQueued(execution, winner.idempotencyKey);
      const dispatch = await this.store.findByExecutionId(this.deps.db, execution.executionId);
      return { dispatch: dispatch ?? winner, execution: after, replayed: true };
    }

    // (3) Apply created → queued through the single transition port with
    // the CALLER's command key. The relay submits the queue job only after
    // this transaction's outbox row is durable — a crash before (3) is
    // recovered by the handler (or the replay path above).
    const after = await this.ensureQueued(execution, input.idempotencyKey);
    this.deps.metrics.increment('pooled_dispatch_recorded', { task_kind: input.taskKind });
    return { dispatch: recorded.inserted, execution: after, replayed: false };
  }

  /** Reads one execution's dispatch (read evidence surface). */
  async getDispatch(executionId: string): Promise<ExecutionDispatchRecord | null> {
    return this.store.findByExecutionId(this.deps.db, executionId);
  }

  /**
   * Applies (or converges to) created → queued with the given command key.
   * Never throws for already-moved executions: the pooled protocol is
   * STATE-DRIVEN — every non-terminal, non-created state implies the
   * handoff transition already happened.
   */
  private async ensureQueued(execution: ExecutionRecord, key: string): Promise<ExecutionRecord> {
    if (execution.status !== 'created') return execution;
    try {
      const outcome = await this.deps.executions.transitionExecution({
        executionId: execution.executionId,
        to: 'queued',
        expectedVersion: execution.version,
        idempotencyKey: key,
        retryClassification: null,
        evidenceRef: null,
        reason: 'pooled runtime handoff',
        actorId: null,
      });
      return outcome.execution;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const current = await this.deps.executions.getExecution(execution.executionId);
      if (current === null) throw error;
      if (current.status === 'created') throw error; // genuine CAS loss on a still-created row
      return current; // someone already moved it onward — converged
    }
  }

  // -------------------------------------------------------------------------
  // RELAY — transactional outbox drain into the durable queue
  // -------------------------------------------------------------------------

  /** One relay pass; returns the number of dispatches submitted. */
  async relayOnce(limit: number): Promise<number> {
    return this.deps.db.transaction(async (tx) => {
      const claimed = await this.store.claimRecorded(tx, limit);
      let submitted = 0;
      for (const dispatch of claimed) {
        try {
          const result = await this.deps.queue.submit({
            handlerKind: dispatch.handlerKind,
            queue: dispatch.queueName,
            payload: {
              dispatchId: dispatch.dispatchId,
              executionId: dispatch.executionId,
              cycle: dispatch.cycle,
            },
            idempotencyKey: `execution-dispatch:${dispatch.executionId}:${dispatch.cycle}`,
            maxAttempts: dispatch.maxAttempts,
            correlation: {
              correlationId: dispatch.correlationId,
              causationId: dispatch.causationId,
              actor: dispatch.createdBy ?? 'pooled-runtime',
            },
            submittedBy: dispatch.createdBy ?? 'pooled-runtime',
          });
          await this.store.markSubmitted(tx, dispatch.dispatchId, result.job.jobId, dispatch.version);
          submitted += 1;
          if (result.replayed) {
            this.deps.logger.info('pooled.relay.resubmitted-converged', undefined, {
              dispatch_id: dispatch.dispatchId,
              job_id: result.job.jobId,
              note: 'queue fence converged a repeated submission (crash between submit and mark)',
            });
          }
        } catch (error) {
          if (error instanceof ConflictError) {
            // Another relay won the CAS — its submission is the same logical
            // command (queue fence); this row is already being marked.
            continue;
          }
          throw error;
        }
      }
      return submitted;
    });
  }

  // -------------------------------------------------------------------------
  // RECOVERY — dead-job terminalization, deferred-paused re-arm, stale
  // sandbox-lease release (idempotent; safe to run concurrently)
  // -------------------------------------------------------------------------

  async recoverOnce(batchLimit = 100): Promise<{
    failed: number;
    rearmed: number;
    leasesReleased: number;
  }> {
    let failed = 0;
    let rearmed = 0;

    // Paginated sweep on the IMMUTABLE dispatch_id cursor: every submitted
    // dispatch is examined exactly once per pass (a single page bounded by
    // the batch size would leave later dispatches unexamined — the oldest,
    // already-settled rows must never shadow fresh dead jobs). The cursor
    // is stable under the sweep's own updates (updated_at pagination would
    // skip rows as swept rows move); the sweep itself is idempotent.
    const MAX_PAGES = 1000;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const dispatches = await this.store.listSubmitted(batchLimit, cursor);
      if (dispatches.length === 0) break;
      cursor = dispatches[dispatches.length - 1]!.dispatchId;
      for (const dispatch of dispatches) {
        if (dispatch.jobId === null) continue;
        let job = null;
        try {
          job = await this.deps.queue.get(dispatch.jobId);
        } catch {
          continue;
        }
        if (job === null) continue;
        const execution = await this.deps.executions.getExecution(dispatch.executionId);
        if (execution === null || isTerminalExecutionStatus(execution.status)) continue;

        // (a) DEAD JOB: terminalize the stranded non-terminal execution to
        // failed (walking the legal machine edges), §24-classified from the
        // recorded job error. UNKNOWN / reconciling / paused executions are
        // NOT auto-failed: unknown requires reconciliation (frozen rule),
        // paused is tenant control.
        if (job.status === 'dead' && DRIVEABLE_STATUSES.includes(execution.status)) {
          const classification = classificationFromJobError(job.error);
          const reason =
            job.error === null
              ? 'pooled job died without a recorded error'
              : `pooled job died: ${job.error.code}: ${job.error.message}`;
          try {
            await this.terminalizeFailed(dispatch, execution, classification, reason);
            failed += 1;
            this.deps.logger.warn('pooled.recover.terminalized', reason, {
              dispatch_id: dispatch.dispatchId,
              execution_id: dispatch.executionId,
              classification,
            });
            this.deps.metrics.increment('pooled_recover_terminalized', { classification });
          } catch (error) {
            // Boundary-blocked walks (into running is new use) retry next
            // pass; CAS losses against a live driver are convergence.
            if (!(error instanceof ConflictError)) throw error;
          }
          continue;
        }

        // (b) DEFERRED-PAUSED RE-ARM: the job completed with the paused
        // verdict and the tenant has since resumed the execution into a
        // drivable state — hand it a fresh cycle (new queue job).
        if (
          job.status === 'succeeded' &&
          (job.result as { verdict?: string } | null)?.verdict === 'deferred-paused' &&
          dispatch.outcome === 'deferred-paused' &&
          DRIVEABLE_STATUSES.includes(execution.status)
        ) {
          try {
            await this.store.rearm(dispatch.dispatchId, dispatch.version);
            rearmed += 1;
            this.deps.logger.info('pooled.recover.rearmed', undefined, {
              dispatch_id: dispatch.dispatchId,
              execution_id: dispatch.executionId,
              execution_status: execution.status,
              next_cycle: dispatch.cycle + 1,
            });
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
          }
        }
      }
    }

    // (c) STALE SANDBOX-LEASE RELEASE (the MKT-010-documented recovery
    // automation): an expired ACTIVE lease is reclaimable through the
    // idempotent release operation — which never terminalizes.
    let leasesReleased = 0;
    const reclaimable = await this.deps.executions.listReclaimableSandboxLeases(
      this.deps.clock.nowIso(),
    );
    for (const lease of reclaimable) {
      try {
        await this.deps.executions.releaseExecutionSandboxLease({
          executionId: lease.executionId,
          sandboxLeaseId: lease.sandboxLeaseId,
          actorId: null,
        });
        leasesReleased += 1;
        this.deps.logger.info('pooled.recover.lease-released', undefined, {
          sandbox_lease_id: lease.sandboxLeaseId,
          sandbox_id: lease.sandboxId,
          execution_id: lease.executionId,
        });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
    }

    return { failed, rearmed, leasesReleased };
  }

  /**
   * Walks the frozen machine from the execution's current status to failed
   * (created→queued→starting→running→failed as needed), each edge through
   * the transition port with recovery-scoped idempotency keys, and the §24
   * classification recorded on the final edge.
   */
  private async terminalizeFailed(
    dispatch: ExecutionDispatchRecord,
    execution: ExecutionRecord,
    classification: 'safe' | 'unsafe',
    reason: string,
  ): Promise<ExecutionRecord> {
    const chain: readonly ExecutionStatus[] = ['created', 'queued', 'starting', 'running'];
    const position = chain.indexOf(execution.status);
    if (position === -1) {
      // Not a drivable position (paused/unknown/reconciling are handled by
      // the caller) — nothing to walk.
      return execution;
    }
    let current = execution;
    for (let index = position + 1; index < chain.length; index += 1) {
      current = await this.stepTransition(dispatch, current, chain[index]!, '');
      if (current.status !== chain[index]) {
        // Moved elsewhere concurrently (tenant control, another recovery) —
        // re-evaluate on the next pass instead of fighting.
        return current;
      }
    }
    return this.stepTransition(dispatch, current, 'failed', reason, classification);
  }

  /**
   * One idempotent, CAS-tolerant transition step: converges on replays,
   * tolerates CAS losses by re-reading, and RETURNS the current record
   * unchanged when the edge is no longer legal (state-driven protocol).
   */
  private async stepTransition(
    dispatch: ExecutionDispatchRecord,
    current: ExecutionRecord,
    to: ExecutionStatus,
    reason: string,
    classification?: 'safe' | 'unsafe',
  ): Promise<ExecutionRecord> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (isTerminalExecutionStatus(current.status)) return current;
      if (current.status === to) return current;
      if (!isLegalExecutionTransition(current.status, to)) return current;
      try {
        const outcome = await this.deps.executions.transitionExecution({
          executionId: current.executionId,
          to,
          expectedVersion: current.version,
          idempotencyKey: `pooled-recover:${dispatch.dispatchId}:${dispatch.cycle}:${to}`,
          retryClassification: to === 'failed' ? (classification ?? 'unsafe') : null,
          evidenceRef: null,
          reason,
          actorId: null,
        });
        return outcome.execution;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        const reread = await this.deps.executions.getExecution(current.executionId);
        if (reread === null) throw error;
        current = reread;
      }
    }
    return current;
  }

  // -------------------------------------------------------------------------
  // CONTINUOUS LOOP (production worker process; drain mode is orchestrated
  // by the entrypoint)
  // -------------------------------------------------------------------------

  async run(pollIntervalMs: number, batchSize: number): Promise<void> {
    this.deps.logger.info('pooled.runtime.started', undefined, { poll_interval_ms: pollIntervalMs });
    while (!this.stopping) {
      try {
        await this.relayOnce(batchSize);
        await this.recoverOnce(batchSize);
      } catch (error) {
        this.deps.logger.error('pooled.runtime.pass-failed', String(error), {});
      }
      await sleep(pollIntervalMs);
    }
    this.deps.logger.info('pooled.runtime.stopped', undefined, {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
