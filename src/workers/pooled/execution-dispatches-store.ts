/**
 * Storage for the pooled dispatch outbox (execution_dispatches, migration
 * 012) — the MKT-011 pooled runtime's OWN table. It NEVER touches
 * executions / execution_transitions / execution_sandbox_leases: execution
 * state changes only through the /executions transition port.
 *
 * Concurrency model:
 *   - INSERT converges on the UNIQUE (execution_id) fence (probe-back for
 *     replay/conflict classification);
 *   - relay claims 'recorded' rows with FOR UPDATE SKIP LOCKED (concurrent
 *     relays never double-process; the queue's own (queue, handler, key)
 *     fence is the second backstop);
 *   - every UPDATE is CAS on version.
 */

import { createHash } from 'node:crypto';
import { ConflictError } from '../../platform/errors/errors.ts';
import type { Db, DbRow, DbTransaction, QueryParam } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type {
  DispatchOutcomeVerdict,
  DispatchStatus,
  ExecutionDispatchRecord,
} from './contract.ts';

interface DispatchRow extends DbRow {
  dispatch_id: string;
  execution_id: string;
  task_kind: string;
  input: Record<string, unknown>;
  input_ref: string | null;
  queue_name: string;
  handler_kind: string;
  max_attempts: number;
  dispatch_status: DispatchStatus;
  job_id: string | null;
  cycle: number;
  outcome: DispatchOutcomeVerdict | null;
  output_ref: string | null;
  output: Record<string, unknown> | null;
  outcome_reason: string;
  idempotency_key: string;
  create_fingerprint: string;
  correlation_id: string;
  causation_id: string | null;
  created_by: string | null;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

export interface InsertDispatchParams {
  readonly executionId: string;
  readonly taskKind: string;
  readonly input: Record<string, unknown>;
  readonly inputRef: string | null;
  readonly queueName: string;
  readonly handlerKind: string;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly actorId: string | null;
}

/** Fingerprint of the logical dispatch command (convergence predicate). */
export function fingerprintDispatchCommand(params: {
  readonly taskKind: string;
  readonly input: Record<string, unknown>;
  readonly inputRef: string | null;
  readonly maxAttempts: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ input: params.input })))
    .update(`|${params.taskKind}|${params.inputRef ?? ''}|${params.maxAttempts}`)
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalize(v)]);
  }
  return value;
}

export class ExecutionDispatchesStore {
  private readonly db: Db;
  private readonly ids: IdGenerator;

  constructor(db: Db, ids: IdGenerator) {
    this.db = db;
    this.ids = ids;
  }

  /**
   * Inserts the outbox row; on the (execution_id) fence returns the
   * existing row for convergence/conflict classification by the caller.
   */
  async insertDispatch(
    tx: DbTransaction,
    params: InsertDispatchParams,
  ): Promise<{ inserted: ExecutionDispatchRecord } | { existing: ExecutionDispatchRecord }> {
    const dispatchId = this.ids.newId();
    const fingerprint = fingerprintDispatchCommand(params);
    const result = await tx.query<DispatchRow>(
      `INSERT INTO execution_dispatches
         (dispatch_id, execution_id, task_kind, input, input_ref, queue_name,
          handler_kind, max_attempts, dispatch_status, cycle,
          idempotency_key, create_fingerprint, correlation_id, causation_id, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'recorded', 1, $9, $10, $11, $12, $13)
       ON CONFLICT (execution_id) DO NOTHING
       RETURNING *`,
      [
        dispatchId,
        params.executionId,
        params.taskKind,
        JSON.stringify(params.input),
        params.inputRef,
        params.queueName,
        params.handlerKind,
        params.maxAttempts,
        params.idempotencyKey,
        fingerprint,
        params.correlationId,
        params.causationId,
        params.actorId,
      ],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return { inserted: toRecord(row) };
    }
    const existing = await this.findByExecutionId(tx, params.executionId);
    if (existing === null) {
      throw new Error(
        `dispatch fence fired for execution ${params.executionId} but no existing dispatch could be read back`,
      );
    }
    return { existing };
  }

  async findByExecutionId(
    tx: DbTransaction | Db,
    executionId: string,
  ): Promise<ExecutionDispatchRecord | null> {
    const result = await tx.query<DispatchRow>(
      `SELECT * FROM execution_dispatches WHERE execution_id = $1`,
      [executionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** Relay scan: locks up to `limit` recorded rows FOR UPDATE SKIP LOCKED. */
  async claimRecorded(
    tx: DbTransaction,
    limit: number,
  ): Promise<ReadonlyArray<ExecutionDispatchRecord>> {
    const result = await tx.query<DispatchRow>(
      `SELECT * FROM execution_dispatches
       WHERE dispatch_id IN (
         SELECT dispatch_id FROM execution_dispatches
         WHERE dispatch_status = 'recorded'
         ORDER BY created_at ASC, dispatch_id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )`,
      [limit],
    );
    return result.rows.map(toRecord);
  }

  /** Binds the queue job (recorded → submitted), CAS on version. */
  async markSubmitted(
    tx: DbTransaction,
    dispatchId: string,
    jobId: string,
    expectedVersion: number,
  ): Promise<ExecutionDispatchRecord> {
    return this.casUpdate(tx, dispatchId, expectedVersion, {
      setSql: `dispatch_status = 'submitted',
               job_id = $3,
               updated_at = now()`,
      params: [jobId],
      conflictNote: 'dispatch submit race',
    });
  }

  /**
   * Records the set-once run outcome (verdict + output evidence). The DB
   * trigger rejects overwriting a final verdict; the ONLY legal re-record
   * replaces a 'deferred-paused' placeholder.
   */
  async recordOutcome(
    dispatchId: string,
    expectedVersion: number,
    outcome: DispatchOutcomeVerdict,
    outputRef: string | null,
    output: Record<string, unknown> | null,
    reason: string,
  ): Promise<ExecutionDispatchRecord> {
    return this.casUpdate(this.db, dispatchId, expectedVersion, {
      setSql: `outcome = $3,
               output_ref = $4,
               output = $5::jsonb,
               outcome_reason = $6,
               updated_at = now()`,
      params: [outcome, outputRef, JSON.stringify(output ?? {}), reason],
      conflictNote: 'dispatch outcome race',
    });
  }

  /**
   * Re-arms a deferred-paused dispatch for a new cycle (submitted →
   * recorded, cycle + 1) so the relay submits a FRESH queue job once the
   * tenant resumed the execution. Requires outcome = 'deferred-paused'
   * (DB-enforced).
   */
  async rearm(dispatchId: string, expectedVersion: number): Promise<ExecutionDispatchRecord> {
    return this.casUpdate(this.db, dispatchId, expectedVersion, {
      setSql: `dispatch_status = 'recorded',
               cycle = cycle + 1,
               updated_at = now()`,
      params: [],
      conflictNote: 'dispatch re-arm race',
    });
  }

  /**
   * The submitted dispatches, cursored by immutable dispatch_id (stable
   * under concurrent updates — updated_at pagination would skip rows when
   * swept rows move). Sweep input; joined against queue jobs by the caller.
   */
  async listSubmitted(
    limit: number,
    afterDispatchId: string | null = null,
  ): Promise<ReadonlyArray<ExecutionDispatchRecord>> {
    const result = await this.db.query<DispatchRow>(
      `SELECT * FROM execution_dispatches
       WHERE dispatch_status = 'submitted'
         AND ($1::uuid IS NULL OR dispatch_id > $1::uuid)
       ORDER BY dispatch_id ASC
       LIMIT $2`,
      [afterDispatchId, limit],
    );
    return result.rows.map(toRecord);
  }

  async getByDispatchId(dispatchId: string): Promise<ExecutionDispatchRecord | null> {
    const result = await this.db.query<DispatchRow>(
      `SELECT * FROM execution_dispatches WHERE dispatch_id = $1`,
      [dispatchId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  private async casUpdate(
    tx: DbTransaction | Db,
    dispatchId: string,
    expectedVersion: number,
    mutation: { setSql: string; params: ReadonlyArray<QueryParam>; conflictNote: string },
  ): Promise<ExecutionDispatchRecord> {
    // The mutation's placeholders number from $3: $1 = dispatch_id,
    // $2 = expected_version, then the mutation's own parameters.
    const result = await tx.query<DispatchRow>(
      `UPDATE execution_dispatches SET ${mutation.setSql}, version = version + 1
       WHERE dispatch_id = $1 AND version = $2
       RETURNING *`,
      [dispatchId, expectedVersion, ...mutation.params],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ConflictError(`CAS failure updating dispatch ${dispatchId} (${mutation.conflictNote})`);
    }
    return toRecord(row);
  }
}

function toRecord(row: DispatchRow): ExecutionDispatchRecord {
  return {
    dispatchId: row.dispatch_id,
    executionId: row.execution_id,
    taskKind: row.task_kind,
    input: row.input,
    inputRef: row.input_ref,
    queueName: row.queue_name,
    handlerKind: row.handler_kind,
    maxAttempts: row.max_attempts,
    dispatchStatus: row.dispatch_status,
    jobId: row.job_id,
    cycle: row.cycle,
    outcome: row.outcome,
    outputRef: row.output_ref,
    output: row.output,
    outcomeReason: row.outcome_reason,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
