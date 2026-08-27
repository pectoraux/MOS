/**
 * Background worker host (PLAT-001 async worker model, PLAT-AC-02).
 *
 * Workers claim durable jobs from the PostgreSQL queue (FOR UPDATE SKIP
 * LOCKED — concurrent workers never double-claim), execute the registered
 * handler inside a correlation context RESTORED from the durable job row
 * (OBS-AC-01: correlation identity crosses the process boundary through the
 * database, not through memory), and complete/fail with CAS checks.
 *
 * Failure semantics follow the typed error contract: retryable errors retry
 * with exponential backoff until max_attempts, non-retryable errors (and
 * exhausted retries) become 'dead'. Unexpected errors are treated as
 * retryable (bounded by max_attempts) — never silently swallowed.
 *
 * The worker records structured events (job.claimed, job.succeeded,
 * job.failed, job.dead) and metrics; observability describes execution and
 * never decides it (OBS-AC-02).
 */

import type { Logger, Metrics } from '../platform/observability/contract.ts';
import { withCorrelation } from '../platform/observability/correlation.ts';
import type { JobRecord } from '../platform/queue/contract.ts';
import { toAppError } from '../platform/errors/errors.ts';
import type { JobErrorRecord } from '../platform/queue/contract.ts';

export interface JobHandlerContext {
  readonly job: JobRecord;
  readonly logger: Logger;
  /** Runs `fn` under the job's correlation identity (already active for the handler itself). */
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<Record<string, unknown>>;

export type JobHandlerRegistry = ReadonlyMap<string, JobHandler>;

export interface WorkerHostOptions {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly retryBackoffBaseMs: number;
  /** Drain mode: process jobs until the queue is empty (including retries), then stop. */
  readonly drain: boolean;
}

export interface WorkerHostDeps {
  readonly claim: (workerId: string, limit: number) => Promise<ReadonlyArray<JobRecord>>;
  readonly complete: (
    jobId: string,
    output: Record<string, unknown>,
    version: number,
  ) => Promise<JobRecord>;
  readonly fail: (
    jobId: string,
    error: JobErrorRecord,
    version: number,
    retryBackoffBaseMs: number,
  ) => Promise<JobRecord>;
  readonly hasPending: () => Promise<boolean>;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock: { nowMs(): number; nowIso(): string };
}

export class WorkerHost {
  private readonly deps: WorkerHostDeps;
  private readonly handlers: JobHandlerRegistry;
  private readonly options: WorkerHostOptions;
  private stopping = false;
  private inFlight = 0;

  constructor(deps: WorkerHostDeps, handlers: JobHandlerRegistry, options: WorkerHostOptions) {
    this.deps = deps;
    this.handlers = handlers;
    this.options = options;
  }

  /** Requests a graceful stop: finish in-flight jobs, stop claiming. */
  stop(): void {
    this.stopping = true;
  }

  /** Runs the claim/execute loop. Returns when stopped, or (drain mode) when the queue is empty. */
  async run(): Promise<void> {
    this.deps.logger.info('worker.started', undefined, {
      worker_id: this.options.workerId,
      drain: this.options.drain,
    });

    while (!this.stopping) {
      const claimed = await this.deps.claim(this.options.workerId, this.options.batchSize);

      if (claimed.length === 0) {
        if (this.options.drain) {
          const pending = await this.deps.hasPending();
          if (!pending) break;
        }
        await sleep(this.options.pollIntervalMs);
        continue;
      }

      for (const job of claimed) {
        if (this.stopping) break;
        this.inFlight += 1;
        try {
          await this.executeJob(job);
        } finally {
          this.inFlight -= 1;
        }
      }
    }

    // Graceful shutdown: wait for any in-flight execution started above.
    while (this.inFlight > 0) {
      await sleep(10);
    }

    this.deps.logger.info('worker.stopped', undefined, {
      worker_id: this.options.workerId,
      metrics: this.deps.metrics.snapshot(),
    });
  }

  private async executeJob(job: JobRecord): Promise<void> {
    const startedMs = this.deps.clock.nowMs();

    // Correlation identity crosses the worker process boundary via the
    // durable job row; restore it as the ambient context for this execution.
    await withCorrelation(
      {
        correlationId: job.correlationId,
        causationId: job.jobId,
        actor: job.submittedBy,
      },
      async () => {
        this.deps.logger.info('job.claimed', undefined, {
          job_id: job.jobId,
          worker_id: this.options.workerId,
          attempt: job.attempts,
          handler_kind: job.handlerKind,
          queue: job.queue,
        });
        this.deps.metrics.increment('platform_jobs_claimed', { handler: job.handlerKind });

        const handler = this.handlers.get(job.handlerKind);
        if (handler === undefined) {
          await this.failJob(job, {
            code: 'PERMANENT_EXECUTION_FAILURE',
            message: `No handler registered for kind '${job.handlerKind}'`,
            retryable: false,
            retrySafe: false,
          });
          return;
        }

        try {
          const output = await handler({ job, logger: this.deps.logger });
          const completed = await this.deps.complete(job.jobId, output, job.version);
          this.deps.metrics.increment('platform_jobs_succeeded', { handler: job.handlerKind });
          this.deps.metrics.observe('platform_job_duration_ms', this.deps.clock.nowMs() - startedMs, {
            handler: job.handlerKind,
            outcome: 'succeeded',
          });
          this.deps.logger.info('job.succeeded', undefined, {
            job_id: job.jobId,
            worker_id: this.options.workerId,
            attempt: completed.attempts,
            duration_ms: this.deps.clock.nowMs() - startedMs,
          });
        } catch (error) {
          const appError = toAppError(error);
          await this.failJob(job, {
            code: appError.code,
            message: appError.message,
            retryable: appError.retryable,
            retrySafe: appError.retrySafe,
          });
          this.deps.metrics.observe('platform_job_duration_ms', this.deps.clock.nowMs() - startedMs, {
            handler: job.handlerKind,
            outcome: 'failed',
          });
        }
      },
    );
  }

  private async failJob(job: JobRecord, error: Omit<JobErrorRecord, 'attempt' | 'workerId' | 'at'>): Promise<void> {
    const record: JobErrorRecord = {
      ...error,
      attempt: job.attempts,
      workerId: this.options.workerId,
      at: this.deps.clock.nowIso(),
    };
    const updated = await this.deps.fail(job.jobId, record, job.version, this.options.retryBackoffBaseMs);
    if (updated.status === 'dead') {
      this.deps.metrics.increment('platform_jobs_dead', { handler: job.handlerKind });
      this.deps.logger.error('job.dead', record.message, {
        job_id: job.jobId,
        worker_id: this.options.workerId,
        attempt: updated.attempts,
        max_attempts: updated.maxAttempts,
        error_code: record.code,
      });
    } else {
      this.deps.metrics.increment('platform_jobs_retried', { handler: job.handlerKind });
      this.deps.logger.warn('job.failed', record.message, {
        job_id: job.jobId,
        worker_id: this.options.workerId,
        attempt: updated.attempts,
        error_code: record.code,
        retry_scheduled_at: updated.runAfter.toISOString(),
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
