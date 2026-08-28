/**
 * /executions sandbox persistence (sandboxes + sandbox_transitions tables,
 * migration 013 — MKT-012).
 *
 * The durable runtime ENVIRONMENT identity and its lifecycle ledger
 * (tenant-runtime-v1.2.md / implementation-contract-v1.2.md §1). DB
 * backstops behind this store:
 *   - the sandbox identity tuple (sandbox_id + client_id + workspace_id +
 *     runtime_class + environment_identity) contains NO execution ownership
 *     and is IMMUTABLE (trigger); execution_id is never Sandbox identity —
 *     the Execution→Sandbox relationship is the LEASE (migration 011);
 *   - the FROZEN 8-edge sandbox state machine, terminal immutability
 *     (failed/released) and the one-way payload evidence (descriptor at
 *     ready, prepare_error at failed, released_at at released) are
 *     row-trigger-enforced;
 *   - the LIVE-ENVIRONMENT fence: at most ONE live sandbox per (workspace,
 *     runtime_class, environment_identity) — persistent/dedicated reuse
 *     converges, a crash never creates a second sandbox, and a failed or
 *     released environment may be re-provisioned as a NEW row;
 *   - the §8 provisioning fence: (workspace_id, idempotency_key) UNIQUE
 *     with a provision fingerprint (a duplicate converges, a key reused for
 *     a different command is rejected by the module);
 *   - the sandbox_transitions ledger is append-only, idempotency-keyed per
 *     sandbox, legal-pair-checked and from_status-consistent with the
 *     sandbox row (FOR UPDATE — the MKT-010 audit-erratum backstop applied
 *     from day one);
 *   - the TEARDOWN GATE: no sandbox may enter releasing/cancelled/released
 *     while an ACTIVE lease controls it;
 *   - NOTHING in this store mutates executions: a sandbox may never
 *     transition an Execution directly (tenant-runtime-v1.2.md "Lifecycle
 *     authority").
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  RuntimeClass,
  SandboxConcurrencyContract,
  SandboxRecord,
  SandboxStatus,
  SandboxTransitionRecord,
} from '../public.ts';

interface SandboxRow extends DbRow {
  sandbox_id: string;
  client_id: string;
  workspace_id: string;
  runtime_class: string;
  environment_identity: string;
  capabilities: unknown;
  concurrency_contract: string;
  status: string;
  resource_descriptor: string | null;
  prepare_error: string | null;
  released_at: Date | null;
  version: number | string;
  idempotency_key: string;
  provision_fingerprint: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SandboxTransitionRow extends DbRow {
  sandbox_transition_id: string;
  sandbox_id: string;
  idempotency_key: string;
  from_status: string;
  to_status: string;
  reason: string | null;
  created_by: string | null;
  created_at: Date;
}

const SANDBOX_SELECT = `
  SELECT sandbox_id, client_id, workspace_id, runtime_class, environment_identity,
         capabilities, concurrency_contract, status, resource_descriptor, prepare_error,
         released_at, version, idempotency_key, provision_fingerprint, created_by,
         created_at, updated_at
  FROM sandboxes
`;

const SANDBOX_TRANSITION_SELECT = `
  SELECT sandbox_transition_id, sandbox_id, idempotency_key, from_status, to_status,
         reason, created_by, created_at
  FROM sandbox_transitions
`;

/**
 * The unique-constraint names this store classifies into domain conflicts
 * (postgres 23505). Classification keeps the driver error shape confined to
 * this storage layer.
 */
export type SandboxInsertConflict =
  | 'key-fence' // sandboxes_key_unique (the §8 logical command fence)
  | 'environment-fence'; // sandboxes_live_environment_unique (the reuse fence)

export class SandboxesStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertSandbox(
    tx: DbTransaction,
    input: {
      sandboxId: string;
      workspaceId: string;
      clientId: string;
      runtimeClass: RuntimeClass;
      environmentIdentity: string;
      capabilities: readonly string[];
      concurrencyContract: SandboxConcurrencyContract;
      idempotencyKey: string;
      provisionFingerprint: string;
      actorId: string | null;
    },
  ): Promise<SandboxRecord | SandboxInsertConflict> {
    const now = this.clock.nowIso();
    let result;
    try {
      result = await tx.query(
        `INSERT INTO sandboxes (sandbox_id, client_id, workspace_id, runtime_class,
                                environment_identity, capabilities, concurrency_contract,
                                status, idempotency_key, provision_fingerprint,
                                created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'requested', $8, $9, $10, $11, $11)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
        [
          input.sandboxId,
          input.clientId,
          input.workspaceId,
          input.runtimeClass,
          input.environmentIdentity,
          JSON.stringify(input.capabilities),
          input.concurrencyContract,
          input.idempotencyKey,
          input.provisionFingerprint,
          input.actorId,
          now,
        ],
      );
    } catch (error) {
      const conflict = classifySandboxInsertConflict(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    if (result.rowCount !== 1) return 'key-fence';
    const created = await tx.query<SandboxRow>(`${SANDBOX_SELECT} WHERE sandbox_id = $1`, [
      input.sandboxId,
    ]);
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted sandbox ${input.sandboxId} could not be read back`);
    }
    return toSandboxRecord(row);
  }

  async getSandbox(sandboxId: string): Promise<SandboxRecord | null> {
    const result = await this.db.query<SandboxRow>(`${SANDBOX_SELECT} WHERE sandbox_id = $1`, [
      sandboxId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toSandboxRecord(row);
  }

  /** The §8 provisioning probe: the recorded sandbox for one command key. */
  async findSandboxByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<SandboxRecord | null> {
    const result = await tx.query<SandboxRow>(
      `${SANDBOX_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSandboxRecord(row);
  }

  /**
   * The REUSE probe: the LIVE sandbox for one reusable environment key
   * (same workspace + runtime class + environment identity). 'Live' = every
   * state except the two terminal teardown outcomes — the module checks the
   * kind before using this probe (an ephemeral environment is never reused).
   */
  async findLiveSandboxByEnvironment(
    tx: DbTransaction,
    workspaceId: string,
    runtimeClass: RuntimeClass,
    environmentIdentity: string,
  ): Promise<SandboxRecord | null> {
    const result = await tx.query<SandboxRow>(
      `${SANDBOX_SELECT}
       WHERE workspace_id = $1 AND runtime_class = $2 AND environment_identity = $3
         AND status NOT IN ('failed', 'released')
       ORDER BY created_at, sandbox_id`,
      [workspaceId, runtimeClass, environmentIdentity],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSandboxRecord(row);
  }

  /** Locks the sandbox row (FOR UPDATE) — every protocol step serializes here. */
  async lockSandbox(tx: DbTransaction, sandboxId: string): Promise<SandboxRecord | null> {
    const result = await tx.query<SandboxRow>(`${SANDBOX_SELECT} WHERE sandbox_id = $1 FOR UPDATE`, [
      sandboxId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toSandboxRecord(row);
  }

  /** Re-reads the sandbox row THROUGH the caller's (locked) transaction. */
  async rereadSandbox(tx: DbTransaction, sandboxId: string): Promise<SandboxRecord | null> {
    const result = await tx.query<SandboxRow>(`${SANDBOX_SELECT} WHERE sandbox_id = $1`, [
      sandboxId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toSandboxRecord(row);
  }

  /**
   * CAS lifecycle transition on the CALLER'S transaction (row locked there).
   * Only `status`, the target state's set-once payload evidence
   * (resource_descriptor / prepare_error / released_at), `version` and
   * `updated_at` ever change — the frozen-machine, identity-immutability
   * and release-gate triggers are the database backstops behind this write.
   *
   * The set-once evidence columns are SET monotonically through COALESCE:
   * the caller passes the value when the edge enters the corresponding
   * state (ready/failed/released) and null to PRESERVE the recorded value
   * on every later edge (an already-set value is immutable — a value→value
   * change is rejected by the identity trigger even if it slips through).
   */
  async updateSandboxStatusRow(
    tx: DbTransaction,
    input: {
      sandboxId: string;
      status: SandboxStatus;
      resourceDescriptor: string | null;
      prepareError: string | null;
      releasedAt: Date | null;
      expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE sandboxes SET status = $1,
              resource_descriptor = COALESCE($2::text, resource_descriptor),
              prepare_error = COALESCE($3::text, prepare_error),
              released_at = COALESCE($4::timestamptz, released_at),
              version = version + 1, updated_at = $5
       WHERE sandbox_id = $6 AND version = $7`,
      [
        input.status,
        input.resourceDescriptor,
        input.prepareError,
        input.releasedAt,
        now,
        input.sandboxId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, input.sandboxId);
  }

  /**
   * The idempotency-fenced append of one applied transition. MUST run on a
   * transaction that already holds the sandbox row lock (lockSandbox) —
   * that lock serializes same-key requests, so concurrent duplicates
   * resolve through findSandboxTransitionByKey BEFORE the insert and the
   * UNIQUE fence is a pure backstop. Returns 'fenced' when the
   * (sandbox, idempotency_key) pair already exists.
   */
  async insertSandboxTransition(
    tx: DbTransaction,
    input: {
      sandboxId: string;
      idempotencyKey: string;
      fromStatus: SandboxStatus;
      toStatus: SandboxStatus;
      reason: string | null;
      actorId: string | null;
    },
  ): Promise<SandboxTransitionRecord | 'fenced'> {
    const transitionId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO sandbox_transitions (sandbox_transition_id, sandbox_id, idempotency_key,
                                        from_status, to_status, reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sandbox_id, idempotency_key) DO NOTHING`,
      [
        transitionId,
        input.sandboxId,
        input.idempotencyKey,
        input.fromStatus,
        input.toStatus,
        input.reason,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fenced';
    const created = await tx.query<SandboxTransitionRow>(
      `${SANDBOX_TRANSITION_SELECT} WHERE sandbox_transition_id = $1`,
      [transitionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted sandbox transition ${transitionId} could not be read back`);
    }
    return toSandboxTransitionRecord(row);
  }

  /**
   * The recorded transition for one request key, read THROUGH the caller's
   * (locked) transaction — the replay-convergence lookup.
   */
  async findSandboxTransitionByKey(
    tx: DbTransaction,
    sandboxId: string,
    idempotencyKey: string,
  ): Promise<SandboxTransitionRecord | null> {
    const result = await tx.query<SandboxTransitionRow>(
      `${SANDBOX_TRANSITION_SELECT}
       WHERE sandbox_id = $1 AND idempotency_key = $2`,
      [sandboxId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSandboxTransitionRecord(row);
  }

  /** The most recent recorded transition of one sandbox (the settled-state evidence). */
  async lastSandboxTransition(
    tx: DbTransaction,
    sandboxId: string,
  ): Promise<SandboxTransitionRecord | null> {
    const result = await tx.query<SandboxTransitionRow>(
      `${SANDBOX_TRANSITION_SELECT}
       WHERE sandbox_id = $1 ORDER BY created_at DESC, sandbox_transition_id DESC LIMIT 1`,
      [sandboxId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSandboxTransitionRecord(row);
  }

  async listSandboxTransitions(sandboxId: string): Promise<readonly SandboxTransitionRecord[]> {
    const result = await this.db.query<SandboxTransitionRow>(
      `${SANDBOX_TRANSITION_SELECT}
       WHERE sandbox_id = $1 ORDER BY created_at, sandbox_transition_id`,
      [sandboxId],
    );
    return result.rows.map(toSandboxTransitionRecord);
  }

  async listSandboxesForWorkspace(workspaceId: string): Promise<readonly SandboxRecord[]> {
    const result = await this.db.query<SandboxRow>(
      `${SANDBOX_SELECT} WHERE workspace_id = $1 ORDER BY created_at, sandbox_id`,
      [workspaceId],
    );
    return result.rows.map(toSandboxRecord);
  }
}

/** Classifies a postgres unique-violation on the sandbox INSERT. */
function classifySandboxInsertConflict(error: unknown): SandboxInsertConflict | null {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code !== '23505') return null;
  if (candidate.constraint === 'sandboxes_live_environment_unique') {
    return 'environment-fence';
  }
  return 'key-fence';
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  sandboxId: string,
): Promise<'not-found' | 'version-conflict'> {
  const result = await tx.query('SELECT 1 FROM sandboxes WHERE sandbox_id = $1', [sandboxId]);
  return result.rowCount === 1 ? 'version-conflict' : 'not-found';
}

function toSandboxRecord(row: SandboxRow): SandboxRecord {
  const capabilities = Array.isArray(row.capabilities)
    ? row.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    sandboxId: row.sandbox_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    runtimeClass: row.runtime_class as SandboxRecord['runtimeClass'],
    environmentIdentity: row.environment_identity,
    capabilities,
    concurrencyContract: row.concurrency_contract as SandboxConcurrencyContract,
    status: row.status as SandboxStatus,
    resourceDescriptor: row.resource_descriptor,
    prepareError: row.prepare_error,
    releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
    idempotencyKey: row.idempotency_key,
    provisionFingerprint: row.provision_fingerprint,
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSandboxTransitionRecord(row: SandboxTransitionRow): SandboxTransitionRecord {
  return {
    transitionId: row.sandbox_transition_id,
    sandboxId: row.sandbox_id,
    idempotencyKey: row.idempotency_key,
    fromStatus: row.from_status as SandboxStatus,
    toStatus: row.to_status as SandboxStatus,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
