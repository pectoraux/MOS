/**
 * /executions sandbox-lease persistence (execution_sandbox_leases table,
 * migration 011).
 *
 * The durable Execution→Sandbox relationship (implementation-contract-v1.2.md
 * §1 / tenant-runtime-v1.2.md). DB backstops:
 *   - the lease identity tuple (sandbox_lease_id + sandbox_id + execution_id
 *     + client_id + workspace_id), the acquisition provenance, the
 *     idempotency key and the expiry metadata are IMMUTABLE (trigger);
 *   - AT MOST ONE ACTIVE LEASE PER SANDBOX (partial UNIQUE index — "the
 *     backstop preventing two conflicting active leases for the same
 *     sandbox"; the strict v1.2 concurrency invariant, since no sandbox
 *     contract declaring safe concurrency exists before MKT-012);
 *   - at most ONE ACTIVE LEASE PER EXECUTION (partial UNIQUE index);
 *   - a lease can only be INSERTED for a NON-TERMINAL execution whose
 *     runtime class is a SANDBOX class (trigger — a pooled-worker execution
 *     holds no sandbox);
 *   - the ONLY legal lease mutation is ACTIVE → RELEASED with released_at
 *     recorded; released leases are frozen terminal rows (trigger);
 *   - (execution_id, idempotency_key) is UNIQUE-fenced — the lease
 *     acquisition idempotency ledger ("Lease acquisition is
 *     concurrency-safe and idempotent");
 *   - releasing a lease NEVER terminalizes the Execution: nothing in this
 *     store (or its triggers) mutates executions.status — the release
 *     returns the unchanged execution record as living proof.
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { SandboxLeaseRecord } from '../public.ts';

interface SandboxLeaseRow extends DbRow {
  sandbox_lease_id: string;
  sandbox_id: string;
  execution_id: string;
  workspace_id: string;
  client_id: string;
  status: string;
  acquired_by: string | null;
  released_at: Date | null;
  expires_at: Date | null;
  version: number | string;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

const SANDBOX_LEASE_SELECT = `
  SELECT sandbox_lease_id, sandbox_id, execution_id, workspace_id, client_id,
         status, acquired_by, released_at, expires_at, version, idempotency_key,
         created_at, updated_at
  FROM execution_sandbox_leases
`;

/**
 * The unique-constraint names this store classifies into domain conflicts
 * (postgres unique-violation error code 23505 with the constraint name in
 * `constraint`). Classification keeps the driver error shape confined to
 * this storage layer.
 */
export type SandboxLeaseInsertConflict =
  | 'acquisition-key-fence' // execution_sandbox_leases_key_unique (same logical command)
  | 'sandbox-controlled' // one_active_per_sandbox (exactly one permitted controller)
  | 'execution-holds-lease'; // one_active_per_execution

export class SandboxLeasesStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertSandboxLease(
    tx: DbTransaction,
    input: {
      sandboxId: string;
      executionId: string;
      workspaceId: string;
      clientId: string;
      idempotencyKey: string;
      expiresAt: Date | null;
      actorId: string | null;
    },
  ): Promise<SandboxLeaseRecord | SandboxLeaseInsertConflict> {
    const leaseId = this.ids.newId();
    const now = this.clock.nowIso();
    let result;
    try {
      result = await tx.query(
        `INSERT INTO execution_sandbox_leases (sandbox_lease_id, sandbox_id, execution_id,
                                                workspace_id, client_id, status, acquired_by,
                                                released_at, expires_at, version,
                                                idempotency_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, NULL, $7, 1, $8, $9, $9)
         ON CONFLICT (execution_id, idempotency_key) DO NOTHING`,
        [
          leaseId,
          input.sandboxId,
          input.executionId,
          input.workspaceId,
          input.clientId,
          input.actorId,
          input.expiresAt,
          input.idempotencyKey,
          now,
        ],
      );
    } catch (error) {
      const conflict = classifyLeaseInsertConflict(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    if (result.rowCount !== 1) return 'acquisition-key-fence';
    const created = await tx.query<SandboxLeaseRow>(
      `${SANDBOX_LEASE_SELECT} WHERE sandbox_lease_id = $1`,
      [leaseId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted sandbox lease ${leaseId} could not be read back`);
    }
    return toSandboxLeaseRecord(row);
  }

  /**
   * The lease recorded for one acquisition request key on one execution,
   * read THROUGH the caller's (locked) transaction — the replay-convergence
   * lookup.
   */
  async findLeaseByKey(
    tx: DbTransaction,
    executionId: string,
    idempotencyKey: string,
  ): Promise<SandboxLeaseRecord | null> {
    const result = await tx.query<SandboxLeaseRow>(
      `${SANDBOX_LEASE_SELECT} WHERE execution_id = $1 AND idempotency_key = $2`,
      [executionId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSandboxLeaseRecord(row);
  }

  /** Locks the lease row (FOR UPDATE) and returns it — release serialized. */
  async lockSandboxLease(
    tx: DbTransaction,
    sandboxLeaseId: string,
  ): Promise<SandboxLeaseRecord | null> {
    const result = await tx.query<SandboxLeaseRow>(
      `${SANDBOX_LEASE_SELECT} WHERE sandbox_lease_id = $1 FOR UPDATE`,
      [sandboxLeaseId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSandboxLeaseRecord(row);
  }

  /**
   * The ACTIVE → RELEASED transition on the caller's (locked) transaction.
   * Only `status`, `released_at`, `version` and `updated_at` change — the
   * lease-immutability trigger is the database backstop behind this write.
   * This write NEVER touches the executions table: releasing a lease never
   * terminalizes the Execution.
   */
  async releaseSandboxLeaseRow(
    tx: DbTransaction,
    sandboxLeaseId: string,
  ): Promise<'ok' | 'not-found'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE execution_sandbox_leases SET status = 'released', released_at = $1,
              version = version + 1, updated_at = $1
       WHERE sandbox_lease_id = $2 AND status = 'active'`,
      [now, sandboxLeaseId],
    );
    if (result.rowCount === 1) return 'ok';
    return 'not-found';
  }

  async listSandboxLeases(executionId: string): Promise<readonly SandboxLeaseRecord[]> {
    const result = await this.db.query<SandboxLeaseRow>(
      `${SANDBOX_LEASE_SELECT} WHERE execution_id = $1 ORDER BY created_at, sandbox_lease_id`,
      [executionId],
    );
    return result.rows.map(toSandboxLeaseRecord);
  }
}

/**
 * Classifies a postgres unique-violation on the lease INSERT into the domain
 * conflict it represents. Anything else propagates untouched.
 */
function classifyLeaseInsertConflict(error: unknown): SandboxLeaseInsertConflict | null {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code !== '23505') return null;
  if (candidate.constraint === 'execution_sandbox_leases_one_active_per_sandbox') {
    return 'sandbox-controlled';
  }
  if (candidate.constraint === 'execution_sandbox_leases_one_active_per_execution') {
    return 'execution-holds-lease';
  }
  return 'acquisition-key-fence';
}

function toSandboxLeaseRecord(row: SandboxLeaseRow): SandboxLeaseRecord {
  return {
    sandboxLeaseId: row.sandbox_lease_id,
    sandboxId: row.sandbox_id,
    executionId: row.execution_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    status: row.status as 'active' | 'released',
    acquiredBy: row.acquired_by,
    releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    idempotencyKey: row.idempotency_key,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
