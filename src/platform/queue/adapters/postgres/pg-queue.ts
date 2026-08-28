/**
 * PostgreSQL-backed durable job queue (PLAT-001).
 *
 * PostgreSQL is the system of record for job state; recovery never depends on
 * any ephemeral broker (spec/architecture-lock.md, DEPLOY-AC-02 direction).
 * Claiming uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent workers never
 * double-claim; completion/failure use CAS on the row version; the logical
 * idempotency key is fenced by a UNIQUE partial index (spec/implementation-
 * contract.md §8: the database, not application check-then-insert, is the
 * duplicate fence).
 *
 * MKT-011 stale-claim recovery: a job left 'running' by a dead worker
 * (claimed_at older than the configured window) becomes reclaimable — a
 * concurrent claim may re-queue it when attempts remain, or dead it when
 * they do not. Reclaim uses the same SKIP LOCKED serialization, so at most
 * one worker holds a job at a time; a late completion from a superseded
 * worker fails its CAS and is surfaced as a ConflictError (the worker host
 * logs-and-continues — it must not crash on superseded work).
 */

import { ConflictError, IdempotencyConflictError } from '../../../errors/errors.ts';
import type { Db, DbRow } from '../../../db/contract.ts';
import {
  retryBackoffMs,
  type JobCompletion,
  type JobErrorRecord,
  type JobQueue,
  type JobRecord,
  type JobStatus,
  type JobSubmission,
  type SubmitResult,
} from '../../contract.ts';

interface JobRow extends DbRow {
  job_id: string;
  queue: string;
  handler_kind: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  correlation_id: string;
  causation_id: string | null;
  submitted_by: string;
  result: Record<string, unknown> | null;
  error: JobErrorRecord | null;
  version: string;
  created_at: Date;
  updated_at: Date;
}

export class PgQueue implements JobQueue {
  private readonly db: Db;
  private readonly newAttemptId: () => string;
  private readonly staleClaimMs: number;

  constructor(db: Db, newAttemptId: () => string, staleClaimMs = 0) {
    this.db = db;
    this.newAttemptId = newAttemptId;
    this.staleClaimMs = staleClaimMs;
  }

  async submit(submission: JobSubmission): Promise<SubmitResult> {
    const queue = submission.queue ?? 'platform.default';
    const maxAttempts = submission.maxAttempts ?? 5;
    const idempotencyKey = submission.idempotencyKey ?? null;

    const inserted = await this.db.query<JobRow>(
      `INSERT INTO platform_jobs
         (job_id, queue, handler_kind, payload, idempotency_key, status,
          attempts, max_attempts, correlation_id, causation_id, submitted_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending', 0, $6, $7, $8, $9)
       ON CONFLICT (queue, handler_kind, idempotency_key)
         WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        crypto.randomUUID(),
        queue,
        submission.handlerKind,
        JSON.stringify(submission.payload),
        idempotencyKey,
        maxAttempts,
        submission.correlation.correlationId,
        submission.correlation.causationId,
        submission.submittedBy,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) {
      return { job: toJobRecord(row), replayed: false };
    }

    // A job with this idempotency key already exists — converge or conflict.
    const existing = await this.db.query<JobRow>(
      `SELECT * FROM platform_jobs
       WHERE queue = $1 AND handler_kind = $2 AND idempotency_key = $3`,
      [queue, submission.handlerKind, idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new ConflictError(
        `Idempotency fence hit for key '${idempotencyKey}' but no existing job could be read`,
      );
    }
    if (!payloadEquals(existingRow.payload, submission.payload)) {
      throw new IdempotencyConflictError(idempotencyKey ?? '');
    }
    return { job: toJobRecord(existingRow), replayed: true };
  }

  async claim(workerId: string, limit: number): Promise<ReadonlyArray<JobRecord>> {
    return this.db.transaction(async (tx) => {
      // Stale-claim recovery (MKT-011): when a reclaim window is configured,
      // a job whose claim has outlived the window is eligible again. An
      // exhausted stale job goes straight to 'dead' (it must not be
      // re-queued forever); otherwise it is re-claimed (attempts +1) by this
      // worker under the same SKIP LOCKED serialization.
      const staleEligible =
        this.staleClaimMs > 0
          ? `OR (status = 'running' AND claimed_at <= now() - (${this.staleClaimMs} * interval '1 millisecond'))`
          : '';
      const decided = await tx.query<JobRow>(
        `UPDATE platform_jobs SET
           status = CASE
                      WHEN status = 'running' AND attempts >= max_attempts THEN 'dead'
                      ELSE 'running'
                    END,
           attempts = CASE
                        WHEN status = 'running' AND attempts >= max_attempts THEN attempts
                        ELSE attempts + 1
                      END,
           claimed_by = $1,
           claimed_at = now(),
           version = version + 1,
           updated_at = now()
         WHERE job_id IN (
           SELECT job_id FROM platform_jobs
           WHERE (status = 'pending' AND run_after <= now())
             ${staleEligible}
           ORDER BY run_after ASC, created_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [workerId, limit],
      );

      for (const row of decided.rows) {
        if (row.status === 'dead') {
          // An exhausted stale claim dies without another attempt row —
          // the existing attempt history already records the crashes.
          await tx.query(
            `UPDATE platform_job_attempts SET finished_at = now(), outcome = 'dead',
                     error = COALESCE(error, $3::jsonb)
             WHERE job_id = $1 AND attempt_no = $2 AND finished_at IS NULL`,
            [row.job_id, row.attempts, JSON.stringify({
              code: 'STALE_CLAIM_EXPIRED',
              message: `claim expired; job reclaimed with attempts exhausted (attempts ${row.attempts} of ${row.max_attempts})`,
              retryable: false,
              retrySafe: false,
              attempt: row.attempts,
              workerId,
              at: new Date().toISOString(),
            })],
          );
          continue;
        }
        await tx.query(
          `INSERT INTO platform_job_attempts
             (attempt_id, job_id, attempt_no, worker_id, correlation_id, started_at, outcome)
           VALUES ($1, $2, $3, $4, $5, now(), 'running')`,
          [this.newAttemptId(), row.job_id, row.attempts, workerId, row.correlation_id],
        );
      }

      // Only re-claimed (running) rows are handed to the worker; rows this
      // pass sent to 'dead' are not executable.
      return decided.rows.filter((row) => row.status === 'running').map(toJobRecord);
    });
  }

  async complete(jobId: string, completion: JobCompletion, version: number): Promise<JobRecord> {
    return this.db.transaction(async (tx) => {
      const updated = await tx.query<JobRow>(
        `UPDATE platform_jobs SET
           status = 'succeeded',
           result = $2::jsonb,
           version = version + 1,
           updated_at = now()
         WHERE job_id = $1 AND version = $3 AND status = 'running'
         RETURNING *`,
        [jobId, JSON.stringify(completion.output), version],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new ConflictError(
          `CAS failure completing job ${jobId} at version ${version} (already completed, failed or superseded)`,
        );
      }
      await tx.query(
        `UPDATE platform_job_attempts SET finished_at = now(), outcome = 'succeeded'
         WHERE job_id = $1 AND attempt_no = $2`,
        [jobId, row.attempts],
      );
      return toJobRecord(row);
    });
  }

  async fail(
    jobId: string,
    error: JobErrorRecord,
    version: number,
    retryBackoffBaseMs: number,
  ): Promise<JobRecord> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<JobRow>(
        `SELECT attempts, max_attempts FROM platform_jobs WHERE job_id = $1`,
        [jobId],
      );
      const currentRow = current.rows[0];
      if (currentRow === undefined) {
        throw new ConflictError(`Job ${jobId} does not exist`);
      }

      const retry = error.retryable && currentRow.attempts < currentRow.max_attempts;
      const backoffMs = retryBackoffMs(currentRow.attempts, retryBackoffBaseMs);
      const nextStatus: JobStatus = retry ? 'pending' : 'dead';

      const updated = await tx.query<JobRow>(
        `UPDATE platform_jobs SET
           status = $3,
           error = $4::jsonb,
           run_after = CASE WHEN $3 = 'pending'
                            THEN now() + make_interval(secs => $5)
                            ELSE run_after END,
           version = version + 1,
           updated_at = now()
         WHERE job_id = $1 AND version = $2 AND status = 'running'
         RETURNING *`,
        [jobId, version, nextStatus, JSON.stringify(error), backoffMs / 1000],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new ConflictError(
          `CAS failure failing job ${jobId} at version ${version} (state was superseded)`,
        );
      }

      await tx.query(
        `UPDATE platform_job_attempts SET finished_at = now(), outcome = $3, error = $4::jsonb
         WHERE job_id = $1 AND attempt_no = $2`,
        [jobId, row.attempts, nextStatus === 'pending' ? 'failed' : 'dead', JSON.stringify(error)],
      );
      return toJobRecord(row);
    });
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const result = await this.db.query<JobRow>(`SELECT * FROM platform_jobs WHERE job_id = $1`, [
      jobId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toJobRecord(row);
  }

  async hasPending(): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM platform_jobs WHERE status = 'pending') AS exists`,
    );
    if (result.rows[0]?.exists === true) return true;
    if (this.staleClaimMs > 0) {
      // With a reclaim window configured, a stale 'running' job is pending
      // work (drain-mode workers must wait for its reclaim, not exit early).
      const stale = await this.db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM platform_jobs
           WHERE status = 'running'
             AND claimed_at <= now() - (${this.staleClaimMs} * interval '1 millisecond')
         ) AS exists`,
      );
      return stale.rows[0]?.exists === true;
    }
    return false;
  }
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    queue: row.queue,
    handlerKind: row.handler_kind,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: new Date(row.run_after),
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at === null ? null : new Date(row.claimed_at),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    submittedBy: row.submitted_by,
    result: row.result,
    error: row.error,
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function payloadEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return entries.map(([k, v]) => [k, canonicalize(v)]);
  }
  return value;
}
