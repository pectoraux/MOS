/**
 * /workflows instance persistence (workflow_instances +
 * workflow_instance_transitions tables, migration 010).
 *
 * DB backstops (migration 010 + implementation-contract §3, §5, §25):
 *   - Workflow INSTANCE identity, the pinned definition version reference,
 *     the owning Workflow and the server-derived Workspace/Client/Agency
 *     scope are IMMUTABLE (trigger) — an instance can never float to
 *     another definition version and can never cross the Workflow or
 *     tenant boundary;
 *   - the scope-chain trigger rejects a workspace outside the recorded
 *     Client and a client outside the recorded Agency on INSERT and UPDATE;
 *   - an instance can only be INSERTED pinning an ACTIVE definition of the
 *     SAME workflow (trigger) — the explicit-version contract at the
 *     storage layer;
 *   - the frozen §5 transition table is enforced by the database itself
 *     (trigger): illegal transitions, self-loops and every transition out
 *     of a TERMINAL state are rejected even under direct SQL rewrites;
 *   - (workflow_instance_id, idempotency_key) is UNIQUE-fenced on the
 *     append-only transition history — the §5 storage end of "duplicate
 *     transition requests are idempotent"; history rows reject UPDATE and
 *     DELETE (trigger);
 *   - every mutable instance row carries a version CAS token (row-locked
 *     transitions).
 *
 * No uniqueness fence on instances per definition/workflow: instances are
 * append-oriented lifecycle identities (concurrent creation is serialized
 * by server-generated identity, not by content).
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  WorkflowInstanceRecord,
  WorkflowInstanceStatus,
  WorkflowInstanceTransitionRecord,
} from '../public.ts';

interface WorkflowInstanceRow extends DbRow {
  workflow_instance_id: string;
  workflow_id: string;
  workflow_definition_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  status: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowInstanceTransitionRow extends DbRow {
  transition_id: string;
  workflow_instance_id: string;
  idempotency_key: string;
  from_status: string;
  to_status: string;
  reason: string;
  created_by: string | null;
  created_at: Date;
}

const WORKFLOW_INSTANCE_SELECT = `
  SELECT workflow_instance_id, workflow_id, workflow_definition_id, workspace_id,
         client_id, agency_id, status, created_by, version, created_at, updated_at
  FROM workflow_instances
`;

const WORKFLOW_INSTANCE_TRANSITION_SELECT = `
  SELECT transition_id, workflow_instance_id, idempotency_key, from_status,
         to_status, reason, created_by, created_at
  FROM workflow_instance_transitions
`;

export class WorkflowInstancesStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertWorkflowInstance(
    tx: DbTransaction,
    input: {
      workflowId: string;
      workflowDefinitionId: string;
      workspaceId: string;
      clientId: string;
      agencyId: string;
      actorId: string | null;
    },
  ): Promise<WorkflowInstanceRecord> {
    const instanceId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO workflow_instances (workflow_instance_id, workflow_id, workflow_definition_id,
                                       workspace_id, client_id, agency_id, status,
                                       created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $8)`,
      [
        instanceId,
        input.workflowId,
        input.workflowDefinitionId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.actorId,
        now,
      ],
    );
    // Read back THROUGH THE CALLER'S TRANSACTION — the row is not visible
    // to other connections until the transaction commits.
    const created = await tx.query<WorkflowInstanceRow>(
      `${WORKFLOW_INSTANCE_SELECT} WHERE workflow_instance_id = $1`,
      [instanceId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted workflow instance ${instanceId} could not be read back`);
    }
    return toWorkflowInstanceRecord(row);
  }

  async getWorkflowInstance(instanceId: string): Promise<WorkflowInstanceRecord | null> {
    const result = await this.db.query<WorkflowInstanceRow>(
      `${WORKFLOW_INSTANCE_SELECT} WHERE workflow_instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowInstanceRecord(row);
  }

  async listWorkflowInstances(workflowId: string): Promise<readonly WorkflowInstanceRecord[]> {
    const result = await this.db.query<WorkflowInstanceRow>(
      `${WORKFLOW_INSTANCE_SELECT} WHERE workflow_id = $1 ORDER BY created_at, workflow_instance_id`,
      [workflowId],
    );
    return result.rows.map(toWorkflowInstanceRecord);
  }

  /** Locks the instance row (FOR UPDATE) and returns it — CAS serialized. */
  async lockWorkflowInstance(
    tx: DbTransaction,
    instanceId: string,
  ): Promise<WorkflowInstanceRecord | null> {
    const result = await tx.query<WorkflowInstanceRow>(
      `${WORKFLOW_INSTANCE_SELECT} WHERE workflow_instance_id = $1 FOR UPDATE`,
      [instanceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowInstanceRecord(row);
  }

  /** Re-reads the instance row THROUGH the caller's (locked) transaction. */
  async rereadWorkflowInstance(
    tx: DbTransaction,
    instanceId: string,
  ): Promise<WorkflowInstanceRecord | null> {
    const result = await tx.query<WorkflowInstanceRow>(
      `${WORKFLOW_INSTANCE_SELECT} WHERE workflow_instance_id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowInstanceRecord(row);
  }

  /**
   * CAS status transition on the CALLER'S transaction (row locked there).
   * Only `status`, `version` and `updated_at` ever change — the frozen
   * §5 state-machine trigger and the identity-immutability trigger are the
   * database backstops behind this write.
   */
  async updateWorkflowInstanceStatusRow(
    tx: DbTransaction,
    input: { instanceId: string; status: WorkflowInstanceStatus; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE workflow_instances SET status = $1, version = version + 1, updated_at = $2
       WHERE workflow_instance_id = $3 AND version = $4`,
      [input.status, now, input.instanceId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, 'workflow_instances', 'workflow_instance_id', input.instanceId);
  }

  /**
   * The idempotency-fenced append of one applied transition. MUST run on a
   * transaction that already holds the instance row lock
   * (lockWorkflowInstance) — that lock serializes same-key requests, so
   * concurrent duplicates resolve through findTransitionByKey BEFORE the
   * insert and the UNIQUE fence is a pure backstop. Returns 'fenced' when
   * the (instance, idempotency_key) pair already exists.
   */
  async insertWorkflowInstanceTransition(
    tx: DbTransaction,
    input: {
      instanceId: string;
      idempotencyKey: string;
      fromStatus: WorkflowInstanceStatus;
      toStatus: WorkflowInstanceStatus;
      reason: string;
      actorId: string | null;
    },
  ): Promise<WorkflowInstanceTransitionRecord | 'fenced'> {
    const transitionId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO workflow_instance_transitions (transition_id, workflow_instance_id,
                                                  idempotency_key, from_status, to_status,
                                                  reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workflow_instance_id, idempotency_key) DO NOTHING`,
      [
        transitionId,
        input.instanceId,
        input.idempotencyKey,
        input.fromStatus,
        input.toStatus,
        input.reason,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fenced';
    const created = await tx.query<WorkflowInstanceTransitionRow>(
      `${WORKFLOW_INSTANCE_TRANSITION_SELECT} WHERE transition_id = $1`,
      [transitionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted workflow instance transition ${transitionId} could not be read back`);
    }
    return toWorkflowInstanceTransitionRecord(row);
  }

  /**
   * The recorded transition for one request key, read THROUGH the caller's
   * (locked) transaction — the replay-convergence lookup.
   */
  async findTransitionByKey(
    tx: DbTransaction,
    instanceId: string,
    idempotencyKey: string,
  ): Promise<WorkflowInstanceTransitionRecord | null> {
    const result = await tx.query<WorkflowInstanceTransitionRow>(
      `${WORKFLOW_INSTANCE_TRANSITION_SELECT}
       WHERE workflow_instance_id = $1 AND idempotency_key = $2`,
      [instanceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowInstanceTransitionRecord(row);
  }

  async listWorkflowInstanceTransitions(
    instanceId: string,
  ): Promise<readonly WorkflowInstanceTransitionRecord[]> {
    const result = await this.db.query<WorkflowInstanceTransitionRow>(
      `${WORKFLOW_INSTANCE_TRANSITION_SELECT}
       WHERE workflow_instance_id = $1 ORDER BY created_at, transition_id`,
      [instanceId],
    );
    return result.rows.map(toWorkflowInstanceTransitionRecord);
  }
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  table: 'workflow_instances',
  idColumn: 'workflow_instance_id',
  id: string,
): Promise<'not-found' | 'version-conflict'> {
  const existing = await tx.query<{ version: number | string }>(
    `SELECT version FROM ${table} WHERE ${idColumn} = $1`,
    [id],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}

function toWorkflowInstanceRecord(row: WorkflowInstanceRow): WorkflowInstanceRecord {
  return {
    workflowInstanceId: row.workflow_instance_id,
    workflowId: row.workflow_id,
    workflowDefinitionId: row.workflow_definition_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    status: row.status as WorkflowInstanceStatus,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toWorkflowInstanceTransitionRecord(
  row: WorkflowInstanceTransitionRow,
): WorkflowInstanceTransitionRecord {
  return {
    transitionId: row.transition_id,
    workflowInstanceId: row.workflow_instance_id,
    idempotencyKey: row.idempotency_key,
    fromStatus: row.from_status as WorkflowInstanceStatus,
    toStatus: row.to_status as WorkflowInstanceStatus,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
