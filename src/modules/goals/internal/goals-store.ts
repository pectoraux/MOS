/**
 * /goals persistence (goals table).
 *
 * DB backstops (migration 007 + implementation-contract §3, §25):
 *   - Goal identity + Client ownership + Workspace scope + provenance are
 *     IMMUTABLE (trigger) — a Goal can never cross the Client boundary and
 *     its Workspace scope can never migrate;
 *   - the optional workspace reference can never point outside the owning
 *     Client (trigger) — the scope backstop;
 *   - success_criteria is a NON-EMPTY jsonb array (CHECK) — a Goal cannot
 *     even be persisted without measurable success criteria (GOAL-AC-01);
 *   - terminal Goals (achieved/abandoned) reject every content-changing
 *     UPDATE (trigger) — business history is append-only;
 *   - every mutable row carries a version CAS token (row-locked
 *     transitions).
 *
 * No uniqueness fence: two Goals may legitimately carry identical content —
 * Goals are append-oriented business records, and concurrent creation is
 * serialized by server-generated identity, not by content.
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  GoalComparator,
  GoalConstraint,
  GoalMetric,
  GoalRecord,
  GoalStatus,
  GoalSuccessCriterion,
  GoalTimeHorizon,
} from '../public.ts';
import { GOAL_COMPARATORS } from '../public.ts';

interface GoalRow extends DbRow {
  goal_id: string;
  client_id: string;
  workspace_id: string | null;
  objective: string;
  success_criteria: unknown;
  metrics: unknown;
  constraints: unknown;
  time_horizon: unknown;
  status: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

const GOAL_SELECT = `
  SELECT goal_id, client_id, workspace_id, objective, success_criteria, metrics,
         constraints, time_horizon, status, created_by, version, created_at, updated_at
  FROM goals
`;

export interface GoalContentInput {
  readonly objective: string;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly metrics: readonly GoalMetric[];
  readonly constraints: readonly GoalConstraint[];
  readonly timeHorizon: GoalTimeHorizon | null;
}

/**
 * Defensive measurability assertion at the authority boundary: the module
 * never persists criteria that are not structurally measurable, whatever
 * the caller did upstream. Mirrors the DB CHECK (non-empty array) and adds
 * the per-criterion shape the jsonb CHECK cannot express.
 */
export function assertMeasurableCriteria(
  criteria: readonly GoalSuccessCriterion[],
): void {
  if (criteria.length === 0) {
    throw new InvalidRequestError('Goal requires at least one measurable success criterion', [
      'successCriteria: must contain at least 1 criterion (GOAL-AC-01)',
    ]);
  }
  const problems: string[] = [];
  criteria.forEach((criterion, index) => {
    if (typeof criterion.metric !== 'string' || criterion.metric.trim() === '') {
      problems.push(`successCriteria[${index}].metric: a named metric is required`);
    }
    if (!GOAL_COMPARATORS.includes(criterion.comparator)) {
      problems.push(
        `successCriteria[${index}].comparator: must be one of ${GOAL_COMPARATORS.join(', ')}`,
      );
    }
    if (typeof criterion.targetValue !== 'number' || !Number.isFinite(criterion.targetValue)) {
      problems.push(`successCriteria[${index}].targetValue: a finite numeric target is required`);
    }
  });
  if (problems.length > 0) {
    throw new InvalidRequestError('Success criteria are not measurable', problems);
  }
}

export function assertValidTimeHorizon(horizon: GoalTimeHorizon | null): void {
  if (horizon === null) return;
  if (horizon.startsOn !== null && !isIsoCalendarDate(horizon.startsOn)) {
    throw new InvalidRequestError('Invalid goal time horizon', [
      'timeHorizon.startsOn: must be an ISO calendar date (YYYY-MM-DD)',
    ]);
  }
  if (horizon.endsOn !== null && !isIsoCalendarDate(horizon.endsOn)) {
    throw new InvalidRequestError('Invalid goal time horizon', [
      'timeHorizon.endsOn: must be an ISO calendar date (YYYY-MM-DD)',
    ]);
  }
  if (horizon.startsOn !== null && horizon.endsOn !== null && horizon.endsOn < horizon.startsOn) {
    throw new InvalidRequestError('Invalid goal time horizon', [
      'timeHorizon.endsOn: must not be before startsOn',
    ]);
  }
}

/** ISO calendar date (YYYY-MM-DD) that is a real calendar date. */
export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export class GoalsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertGoal(input: {
    clientId: string;
    workspaceId: string | null;
    actorId: string | null;
  } & GoalContentInput): Promise<GoalRecord> {
    const goalId = this.ids.newId();
    const now = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO goals (goal_id, client_id, workspace_id, objective, success_criteria,
                          metrics, constraints, time_horizon, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, 'draft', $9, $10, $10)`,
      [
        goalId,
        input.clientId,
        input.workspaceId,
        input.objective,
        JSON.stringify(input.successCriteria),
        JSON.stringify(input.metrics),
        JSON.stringify(input.constraints),
        input.timeHorizon === null ? null : JSON.stringify(input.timeHorizon),
        input.actorId,
        now,
      ],
    );
    const created = await this.getGoal(goalId);
    if (created === null) {
      throw new Error(`inserted goal ${goalId} could not be read back`);
    }
    return created;
  }

  async getGoal(goalId: string): Promise<GoalRecord | null> {
    const result = await this.db.query<GoalRow>(`${GOAL_SELECT} WHERE goal_id = $1`, [goalId]);
    const row = result.rows[0];
    return row === undefined ? null : toGoalRecord(row);
  }

  async listGoalsForClient(clientId: string): Promise<readonly GoalRecord[]> {
    const result = await this.db.query<GoalRow>(
      `${GOAL_SELECT} WHERE client_id = $1 ORDER BY created_at, goal_id`,
      [clientId],
    );
    return result.rows.map(toGoalRecord);
  }

  /** Locks the goal row (FOR UPDATE) and returns it — CAS serialized. */
  async lockGoal(tx: DbTransaction, goalId: string): Promise<GoalRecord | null> {
    const result = await tx.query<GoalRow>(`${GOAL_SELECT} WHERE goal_id = $1 FOR UPDATE`, [
      goalId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toGoalRecord(row);
  }

  /**
   * CAS content mutation on the CALLER'S transaction (the row was locked
   * there). Applies the mutable business content + version bump. The
   * immutability, scope and terminal-frozen triggers in the database are
   * the final backstops.
   */
  async updateGoalContentRow(
    tx: DbTransaction,
    input: { goalId: string; expectedVersion: number } & GoalContentInput,
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE goals SET objective = $1, success_criteria = $2::jsonb, metrics = $3::jsonb,
                       constraints = $4::jsonb, time_horizon = $5::jsonb,
                       version = version + 1, updated_at = $6
       WHERE goal_id = $7 AND version = $8`,
      [
        input.objective,
        JSON.stringify(input.successCriteria),
        JSON.stringify(input.metrics),
        JSON.stringify(input.constraints),
        input.timeHorizon === null ? null : JSON.stringify(input.timeHorizon),
        now,
        input.goalId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, input.goalId);
  }

  /** CAS lifecycle mutation on the CALLER'S transaction (row locked there). */
  async updateGoalStatusRow(
    tx: DbTransaction,
    input: { goalId: string; status: GoalStatus; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE goals SET status = $1, version = version + 1, updated_at = $2
       WHERE goal_id = $3 AND version = $4`,
      [input.status, now, input.goalId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, input.goalId);
  }

  async requireGoal(goalId: string): Promise<GoalRecord> {
    const goal = await this.getGoal(goalId);
    if (goal === null) {
      throw new NotFoundError('goal', goalId);
    }
    return goal;
  }
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  goalId: string,
): Promise<'not-found' | 'version-conflict'> {
  const existing = await tx.query<{ version: number | string }>(
    'SELECT version FROM goals WHERE goal_id = $1',
    [goalId],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}

function toGoalRecord(row: GoalRow): GoalRecord {
  return {
    goalId: row.goal_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    objective: row.objective,
    successCriteria: parseCriteria(row.success_criteria),
    metrics: parseMetrics(row.metrics),
    constraints: parseConstraints(row.constraints),
    timeHorizon: parseTimeHorizon(row.time_horizon),
    status: row.status as GoalStatus,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * jsonb rows arrive as already-parsed JSON. The shapes were validated at
 * write time (route validation + module assertion + DB CHECKs); these
 * parsers are defensive normalizers, never authority.
 */
function parseCriteria(raw: unknown): readonly GoalSuccessCriterion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      metric: String(record['metric'] ?? ''),
      comparator: record['comparator'] as GoalComparator,
      targetValue: Number(record['targetValue'] ?? Number.NaN),
      unit: record['unit'] === undefined || record['unit'] === null ? null : String(record['unit']),
      description:
        record['description'] === undefined || record['description'] === null
          ? null
          : String(record['description']),
    };
  });
}

function parseMetrics(raw: unknown): readonly GoalMetric[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      name: String(record['name'] ?? ''),
      unit: record['unit'] === undefined || record['unit'] === null ? null : String(record['unit']),
      description:
        record['description'] === undefined || record['description'] === null
          ? null
          : String(record['description']),
    };
  });
}

function parseConstraints(raw: unknown): readonly GoalConstraint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      kind: record['kind'] as GoalConstraint['kind'],
      description: String(record['description'] ?? ''),
    };
  });
}

function parseTimeHorizon(raw: unknown): GoalTimeHorizon | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    startsOn: record['startsOn'] === undefined || record['startsOn'] === null ? null : String(record['startsOn']),
    endsOn: record['endsOn'] === undefined || record['endsOn'] === null ? null : String(record['endsOn']),
  };
}
