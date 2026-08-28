/**
 * /executions persistence (executions + execution_transitions tables,
 * migration 011).
 *
 * DB backstops (migration 011 + implementation-contract §7, §8, §24, §25):
 *   - Execution identity, the task linkage, the retry provenance, the
 *     attempt number, the kind, the runtime class, the idempotency identity,
 *     the server-derived Workspace/Client/Agency scope and the provenance
 *     are IMMUTABLE (trigger) — an execution can never float to another
 *     linkage, never re-declare its runtime resource, and can never cross
 *     the tenant boundary;
 *   - the scope-chain trigger rejects a workspace outside the recorded
 *     Client and a client outside the recorded Agency on INSERT and UPDATE;
 *   - the frozen execution transition table is enforced by the database
 *     itself (trigger): illegal transitions, self-loops and every
 *     transition out of a TERMINAL state are rejected even under direct SQL
 *     rewrites;
 *   - the retry classification is SET-ONCE, exclusively by the transition
 *     INTO failed (trigger);
 *   - (workspace_id, idempotency_key) is UNIQUE-fenced on executions — the
 *     §8 storage end of "The persistence/database layer must enforce
 *     uniqueness for the logical idempotency key";
 *   - (retry_of_execution_id, attempt_number) is UNIQUE-fenced for retries
 *     — concurrent duplicate retries of the same prior converge to exactly
 *     one next attempt;
 *   - (execution_id, idempotency_key) is UNIQUE-fenced on the append-only
 *     transition history — the idempotency ledger; history rows reject
 *     UPDATE and DELETE (trigger), and only legal machine pairs with the
 *     §24 payload contracts (failure classification, reconciliation
 *     evidence shape) can be recorded at all;
 *   - every mutable execution row carries a version CAS token (row-locked
 *     transitions).
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ExecutionKind,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionTaskLink,
  ExecutionTransitionRecord,
  RetryClassification,
  RuntimeClass,
} from '../public.ts';

interface ExecutionRow extends DbRow {
  execution_id: string;
  workflow_instance_id: string | null;
  node_id: string | null;
  external_request_ref: string | null;
  retry_of_execution_id: string | null;
  attempt_number: number | string;
  execution_kind: string;
  runtime_class: string;
  idempotency_key: string;
  create_fingerprint: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  status: string;
  retry_classification: string | null;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface ExecutionTransitionRow extends DbRow {
  transition_id: string;
  execution_id: string;
  idempotency_key: string;
  from_status: string;
  to_status: string;
  retry_classification: string | null;
  evidence_ref: string | null;
  reason: string;
  created_by: string | null;
  created_at: Date;
}

const EXECUTION_SELECT = `
  SELECT execution_id, workflow_instance_id, node_id, external_request_ref,
         retry_of_execution_id, attempt_number, execution_kind, runtime_class,
         idempotency_key, create_fingerprint, workspace_id, client_id, agency_id,
         status, retry_classification, created_by, version, created_at, updated_at
  FROM executions
`;

const EXECUTION_TRANSITION_SELECT = `
  SELECT transition_id, execution_id, idempotency_key, from_status, to_status,
         retry_classification, evidence_ref, reason, created_by, created_at
  FROM execution_transitions
`;

/**
 * The unique-constraint names this store classifies into domain conflicts
 * (postgres unique-violation error code 23505 with the constraint name in
 * `constraint`). Classification keeps the driver error shape confined to
 * this storage layer.
 */
export type ExecutionsInsertConflict =
  | 'idempotency-key-fence' // executions_idempotency_key_unique (§8 logical key)
  | 'retry-attempt-fence'; // executions_retry_attempt_unique (duplicate next attempt)

export class ExecutionsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertExecution(
    tx: DbTransaction,
    input: {
      taskLink: ExecutionTaskLink;
      retryOfExecutionId: string | null;
      attemptNumber: number;
      executionKind: ExecutionKind;
      runtimeClass: RuntimeClass;
      idempotencyKey: string;
      createFingerprint: string;
      workspaceId: string;
      clientId: string;
      agencyId: string;
      actorId: string | null;
    },
  ): Promise<ExecutionRecord | ExecutionsInsertConflict> {
    const executionId = this.ids.newId();
    const now = this.clock.nowIso();
    const linkage = taskLinkColumns(input.taskLink);
    let result;
    try {
      result = await tx.query(
        `INSERT INTO executions (execution_id, workflow_instance_id, node_id, external_request_ref,
                                 retry_of_execution_id, attempt_number, execution_kind, runtime_class,
                                 idempotency_key, create_fingerprint, workspace_id, client_id, agency_id,
                                 status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'created', $14, $15, $15)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
        [
          executionId,
          linkage.workflowInstanceId,
          linkage.nodeId,
          linkage.externalRequestRef,
          input.retryOfExecutionId,
          input.attemptNumber,
          input.executionKind,
          input.runtimeClass,
          input.idempotencyKey,
          input.createFingerprint,
          input.workspaceId,
          input.clientId,
          input.agencyId,
          input.actorId,
          now,
        ],
      );
    } catch (error) {
      const conflict = classifyInsertConflict(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    if (result.rowCount !== 1) return 'idempotency-key-fence';
    const created = await tx.query<ExecutionRow>(
      `${EXECUTION_SELECT} WHERE execution_id = $1`,
      [executionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted execution ${executionId} could not be read back`);
    }
    return toExecutionRecord(row);
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | null> {
    const result = await this.db.query<ExecutionRow>(`${EXECUTION_SELECT} WHERE execution_id = $1`, [
      executionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toExecutionRecord(row);
  }

  /** The execution recorded for one §8 logical create key, or null. */
  async findExecutionByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<ExecutionRecord | null> {
    const result = await tx.query<ExecutionRow>(
      `${EXECUTION_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toExecutionRecord(row);
  }

  async listExecutionsForWorkspace(workspaceId: string): Promise<readonly ExecutionRecord[]> {
    const result = await this.db.query<ExecutionRow>(
      `${EXECUTION_SELECT} WHERE workspace_id = $1 ORDER BY created_at, execution_id`,
      [workspaceId],
    );
    return result.rows.map(toExecutionRecord);
  }

  async listExecutionsForTaskLink(
    workflowInstanceId: string,
    nodeId: string,
  ): Promise<readonly ExecutionRecord[]> {
    const result = await this.db.query<ExecutionRow>(
      `${EXECUTION_SELECT} WHERE workflow_instance_id = $1 AND node_id = $2
       ORDER BY created_at, execution_id`,
      [workflowInstanceId, nodeId],
    );
    return result.rows.map(toExecutionRecord);
  }

  /** Locks the execution row (FOR UPDATE) and returns it — CAS serialized. */
  async lockExecution(tx: DbTransaction, executionId: string): Promise<ExecutionRecord | null> {
    const result = await tx.query<ExecutionRow>(
      `${EXECUTION_SELECT} WHERE execution_id = $1 FOR UPDATE`,
      [executionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toExecutionRecord(row);
  }

  /** Re-reads the execution row THROUGH the caller's (locked) transaction. */
  async rereadExecution(tx: DbTransaction, executionId: string): Promise<ExecutionRecord | null> {
    const result = await tx.query<ExecutionRow>(`${EXECUTION_SELECT} WHERE execution_id = $1`, [
      executionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toExecutionRecord(row);
  }

  /**
   * CAS status transition on the CALLER'S transaction (row locked there).
   * Only `status`, `retry_classification` (set-once, to-failed only),
   * `version` and `updated_at` ever change — the frozen state-machine
   * trigger and the identity-immutability triggers are the database
   * backstops behind this write.
   */
  async updateExecutionStatusRow(
    tx: DbTransaction,
    input: {
      executionId: string;
      status: ExecutionStatus;
      retryClassification: RetryClassification | null;
      expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE executions SET status = $1, retry_classification = $2, version = version + 1, updated_at = $3
       WHERE execution_id = $4 AND version = $5`,
      [
        input.status,
        input.retryClassification,
        now,
        input.executionId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, input.executionId);
  }

  /**
   * The idempotency-fenced append of one applied transition. MUST run on a
   * transaction that already holds the execution row lock (lockExecution)
   * — that lock serializes same-key requests, so concurrent duplicates
   * resolve through findTransitionByKey BEFORE the insert and the UNIQUE
   * fence is a pure backstop. Returns 'fenced' when the
   * (execution, idempotency_key) pair already exists.
   */
  async insertExecutionTransition(
    tx: DbTransaction,
    input: {
      executionId: string;
      idempotencyKey: string;
      fromStatus: ExecutionStatus;
      toStatus: ExecutionStatus;
      retryClassification: RetryClassification | null;
      evidenceRef: string | null;
      reason: string;
      actorId: string | null;
    },
  ): Promise<ExecutionTransitionRecord | 'fenced'> {
    const transitionId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                           from_status, to_status, retry_classification,
                                           evidence_ref, reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (execution_id, idempotency_key) DO NOTHING`,
      [
        transitionId,
        input.executionId,
        input.idempotencyKey,
        input.fromStatus,
        input.toStatus,
        input.retryClassification,
        input.evidenceRef,
        input.reason,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fenced';
    const created = await tx.query<ExecutionTransitionRow>(
      `${EXECUTION_TRANSITION_SELECT} WHERE transition_id = $1`,
      [transitionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted execution transition ${transitionId} could not be read back`);
    }
    return toExecutionTransitionRecord(row);
  }

  /**
   * The recorded transition for one request key, read THROUGH the caller's
   * (locked) transaction — the replay-convergence lookup.
   */
  async findTransitionByKey(
    tx: DbTransaction,
    executionId: string,
    idempotencyKey: string,
  ): Promise<ExecutionTransitionRecord | null> {
    const result = await tx.query<ExecutionTransitionRow>(
      `${EXECUTION_TRANSITION_SELECT}
       WHERE execution_id = $1 AND idempotency_key = $2`,
      [executionId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toExecutionTransitionRecord(row);
  }

  async listExecutionTransitions(
    executionId: string,
  ): Promise<readonly ExecutionTransitionRecord[]> {
    const result = await this.db.query<ExecutionTransitionRow>(
      `${EXECUTION_TRANSITION_SELECT}
       WHERE execution_id = $1 ORDER BY created_at, transition_id`,
      [executionId],
    );
    return result.rows.map(toExecutionTransitionRecord);
  }
}

/**
 * Classifies a postgres unique-violation on the executions INSERT into the
 * domain conflict it represents (§8 logical-key fence vs duplicate retry
 * attempt). Anything else propagates untouched.
 */
function classifyInsertConflict(error: unknown): ExecutionsInsertConflict | null {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code !== '23505') return null;
  if (candidate.constraint === 'executions_retry_attempt_unique') return 'retry-attempt-fence';
  return 'idempotency-key-fence';
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  executionId: string,
): Promise<'not-found' | 'version-conflict'> {
  const existing = await tx.query<{ version: number | string }>(
    `SELECT version FROM executions WHERE execution_id = $1`,
    [executionId],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}

function taskLinkColumns(taskLink: ExecutionTaskLink): {
  workflowInstanceId: string | null;
  nodeId: string | null;
  externalRequestRef: string | null;
} {
  if (taskLink.kind === 'workflow-node') {
    return {
      workflowInstanceId: taskLink.workflowInstanceId,
      nodeId: taskLink.nodeId,
      externalRequestRef: null,
    };
  }
  return { workflowInstanceId: null, nodeId: null, externalRequestRef: taskLink.externalRequestRef };
}

export function toExecutionRecord(row: ExecutionRow): ExecutionRecord {
  const taskLink: ExecutionTaskLink =
    row.workflow_instance_id !== null
      ? {
          kind: 'workflow-node',
          workflowInstanceId: row.workflow_instance_id,
          nodeId: row.node_id ?? '',
        }
      : { kind: 'external-request', externalRequestRef: row.external_request_ref ?? '' };
  return {
    executionId: row.execution_id,
    taskLink,
    retryOfExecutionId: row.retry_of_execution_id,
    attemptNumber: Number(row.attempt_number),
    executionKind: row.execution_kind as ExecutionKind,
    runtimeClass: row.runtime_class as RuntimeClass,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    status: row.status as ExecutionStatus,
    retryClassification: row.retry_classification as RetryClassification | null,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toExecutionTransitionRecord(row: ExecutionTransitionRow): ExecutionTransitionRecord {
  return {
    transitionId: row.transition_id,
    executionId: row.execution_id,
    idempotencyKey: row.idempotency_key,
    fromStatus: row.from_status as ExecutionStatus,
    toStatus: row.to_status as ExecutionStatus,
    retryClassification: row.retry_classification as RetryClassification | null,
    evidenceRef: row.evidence_ref,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
