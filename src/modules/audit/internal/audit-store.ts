/**
 * /audit persistence (audit_events table) — append-only by database
 * backstop (migration 006): UPDATE and DELETE are rejected by triggers, so
 * this store can only INSERT and SELECT.
 *
 * The §21 secret-leak guard runs BEFORE insert: events whose details carry
 * material-like keys are refused (fail-closed) — secrets may never appear
 * in audit records.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditEventFilter,
} from '../public.ts';

interface AuditEventRow extends DbRow {
  event_id: string;
  occurred_at: Date;
  actor: string;
  action: string;
  agency_id: string | null;
  client_id: string | null;
  workspace_id: string | null;
  target_type: string;
  target_id: string;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string | null;
  before_version: number | null;
  after_version: number | null;
  result: string;
  details: unknown;
}

const AUDIT_SELECT = `
  SELECT event_id, occurred_at, actor, action, agency_id, client_id, workspace_id,
         target_type, target_id, correlation_id, causation_id, idempotency_key,
         before_version, after_version, result, details
  FROM audit_events
`;

/**
 * Detail keys that can never appear in an audit record
 * (implementation-contract §21 backstop — defense in depth beyond the
 * structural rule that details are built server-side from whitelisted
 * fields). Exact-key match, case-insensitive.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  'secret',
  'secrets',
  'secretmaterial',
  'material',
  'password',
  'token',
  'apikey',
  'accesskey',
  'secretaccesskey',
  'secretvalue',
  'credentialmaterial',
  'privatekey',
  'sessiontoken',
]);

const ACTION_PATTERN = /^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*){1,5}$/;

export function assertValidAuditEvent(input: AuditEventInput): void {
  const problems: string[] = [];
  if (!ACTION_PATTERN.test(input.action)) {
    problems.push(`action '${input.action}' must be a dot-namespaced identifier (e.g. 'clients.created')`);
  }
  if (input.actor === '') problems.push('actor must be a non-empty server-derived principal label');
  if (input.correlationId === '') problems.push('correlationId must be present (audit events are correlation-linked)');
  if (input.targetType === '' || input.targetId === '') {
    problems.push('targetType and targetId are required');
  }
  for (const [key, value] of Object.entries(input.details)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) {
      problems.push(`audit details key '${key}' can never carry secret material (implementation-contract §21)`);
    }
    if (typeof value === 'object' && value !== null) {
      problems.push(`audit details key '${key}' must be a JSON scalar (strings/numbers/booleans/null)`);
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('audit event rejected by the append guard', problems);
  }
}

export class AuditStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Appends one event; ON CONFLICT on the idempotency fence returns the
   * existing row with replayed=true (duplicate emissions converge).
   */
  async appendEvent(
    input: AuditEventInput,
  ): Promise<{ event: AuditEventRecord; replayed: boolean }> {
    assertValidAuditEvent(input);
    const eventId = this.ids.newId();
    const occurredAt = this.clock.nowIso();

    const result = await this.db.query(
      `INSERT INTO audit_events
         (event_id, occurred_at, actor, action, agency_id, client_id, workspace_id,
          target_type, target_id, correlation_id, causation_id, idempotency_key,
          before_version, after_version, result, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [
        eventId,
        occurredAt,
        input.actor,
        input.action,
        input.agencyId,
        input.clientId,
        input.workspaceId,
        input.targetType,
        input.targetId,
        input.correlationId,
        input.causationId,
        input.idempotencyKey,
        input.beforeVersion,
        input.afterVersion,
        input.result,
        JSON.stringify(input.details),
      ],
    );

    if (result.rowCount === 1) {
      const event = await this.getEvent(eventId);
      if (event === null) {
        throw new Error(`appended audit event ${eventId} could not be read back`);
      }
      return { event, replayed: false };
    }

    // Fence hit: an event with the same idempotency key already exists —
    // duplicate emission converges to the durable record.
    const existing = await this.db.query<AuditEventRow>(
      `${AUDIT_SELECT} WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new Error('audit idempotency fence conflict but no existing event could be read');
    }
    return { event: toAuditEventRecord(row), replayed: true };
  }

  async getEvent(eventId: string): Promise<AuditEventRecord | null> {
    const result = await this.db.query<AuditEventRow>(
      `${AUDIT_SELECT} WHERE event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAuditEventRecord(row);
  }

  async queryEvents(filter: AuditEventFilter): Promise<readonly AuditEventRecord[]> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter.agencyId !== undefined) {
      params.push(filter.agencyId);
      conditions.push(`agency_id = $${params.length}`);
    }
    if (filter.clientId !== undefined) {
      params.push(filter.clientId);
      conditions.push(`client_id = $${params.length}`);
    }
    if (filter.workspaceId !== undefined) {
      params.push(filter.workspaceId);
      conditions.push(`workspace_id = $${params.length}`);
    }
    if (filter.targetType !== undefined) {
      params.push(filter.targetType);
      conditions.push(`target_type = $${params.length}`);
    }
    if (filter.targetId !== undefined) {
      params.push(filter.targetId);
      conditions.push(`target_id = $${params.length}`);
    }
    if (filter.correlationId !== undefined) {
      params.push(filter.correlationId);
      conditions.push(`correlation_id = $${params.length}`);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    params.push(limit);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const result = await this.db.query<AuditEventRow>(
      `${AUDIT_SELECT} ${where} ORDER BY occurred_at DESC, event_id LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toAuditEventRecord);
  }
}

function toAuditEventRecord(row: AuditEventRow): AuditEventRecord {
  return {
    eventId: row.event_id,
    occurredAt: row.occurred_at.toISOString(),
    actor: row.actor,
    action: row.action,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    targetType: row.target_type,
    targetId: row.target_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    idempotencyKey: row.idempotency_key,
    beforeVersion: row.before_version === null ? null : Number(row.before_version),
    afterVersion: row.after_version === null ? null : Number(row.after_version),
    result: row.result as AuditEventRecord['result'],
    details: (row.details ?? {}) as Record<string, unknown>,
  };
}
