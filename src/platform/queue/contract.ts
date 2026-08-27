/**
 * Durable job queue abstraction (PLAT-001, MKT-001 concurrency/recovery
 * contract).
 *
 * Long-running work runs asynchronously through this port (PLAT-AC-02).
 * Jobs have durable identity, carry correlation identity across the worker
 * boundary (OBS-AC-01), and are fenced by a database uniqueness constraint
 * on the logical idempotency key (spec/implementation-contract.md §8).
 *
 * The queue is infrastructure, never a business authority: job status here is
 * platform execution plumbing for background work, distinct from the business
 * Workflow/Execution authorities that later Work Items introduce.
 */

import type { CorrelationContext } from '../observability/correlation.ts';

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'dead';

export interface JobSubmission {
  /** Registered handler kind that will execute the job. */
  readonly handlerKind: string;
  /** Handler input (JSON-serializable). */
  readonly payload: Record<string, unknown>;
  /** Logical idempotency key; duplicate submissions of the same key+payload converge. */
  readonly idempotencyKey?: string | undefined;
  /** Queue partition (default 'platform.default'). */
  readonly queue?: string | undefined;
  readonly maxAttempts?: number | undefined;
  /** Correlation identity captured at submission time (OBS-AC-01). */
  readonly correlation: CorrelationContext;
  /** Principal that submitted the job. */
  readonly submittedBy: string;
}

export interface JobErrorRecord {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retrySafe: boolean | null;
  readonly attempt: number;
  readonly workerId: string;
  readonly at: string;
}

export interface JobRecord {
  readonly jobId: string;
  readonly queue: string;
  readonly handlerKind: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string | null;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAfter: Date;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly submittedBy: string;
  readonly result: Record<string, unknown> | null;
  readonly error: JobErrorRecord | null;
  /** CAS token; optimistic-concurrency checks compare this value. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SubmitResult {
  readonly job: JobRecord;
  /** True when an existing job with the same idempotency key was returned. */
  readonly replayed: boolean;
}

export interface JobCompletion {
  readonly output: Record<string, unknown>;
}

/**
 * Port for the durable queue. Implementations MUST:
 *   - persist jobs before acknowledging submission;
 *   - claim jobs atomically such that concurrent workers never double-claim;
 *   - enforce idempotency-key uniqueness at the database level;
 *   - complete/fail jobs with CAS (version) checks;
 *   - persist correlation identity on job and attempt rows.
 */
export interface JobQueue {
  /** Submits a job; idempotent per (queue, handlerKind, idempotencyKey). */
  submit(submission: JobSubmission): Promise<SubmitResult>;
  /** Atomically claims up to `limit` runnable jobs for `workerId`. */
  claim(workerId: string, limit: number): Promise<ReadonlyArray<JobRecord>>;
  /** Marks a claimed job succeeded (CAS on version). */
  complete(jobId: string, completion: JobCompletion, version: number): Promise<JobRecord>;
  /**
   * Marks a claimed job failed. Retries (status back to pending with backoff)
   * when `retryable` and attempts remain; otherwise the job becomes 'dead'.
   */
  fail(
    jobId: string,
    error: JobErrorRecord,
    version: number,
    retryBackoffBaseMs: number,
  ): Promise<JobRecord>;
  /** Reads one job by id. */
  get(jobId: string): Promise<JobRecord | null>;
  /** True when any job is pending (used by drain-mode workers to wait for retries). */
  hasPending(): Promise<boolean>;
}

/**
 * Exponential backoff with full jitter for retry scheduling.
 * Pure function — unit tested.
 */
export function retryBackoffMs(attemptsMade: number, baseMs: number, jitter = Math.random): number {
  const safeAttempts = Math.max(attemptsMade, 1);
  const exponent = Math.min(safeAttempts - 1, 10);
  const capMs = Math.min(baseMs * 2 ** exponent, 60_000);
  const jitterFactor = 0.5 + jitter() * 0.5; // [0.5, 1.0)
  return Math.max(1, Math.round(capMs * jitterFactor));
}
