/**
 * MarketingOS module: /audit
 * Authority: Audit trail (spec/implementation-contract.md §1, §22).
 *
 * MKT-005 implements this authority (AUD-001, issue #13 MKT-005-AC-06):
 *
 *   - APPEND-ORIENTED persistence of material events: authorization
 *     (logins), lifecycle mutations (agencies/clients/workspaces/
 *     credentials), and — with later Work Items — execution, workflow and
 *     external-action events;
 *   - events are SERVER-OWNED: identity, timestamp, actor, scope, action,
 *     target, correlation and result are derived by server code from the
 *     authenticated principal, canonical owner scope and ambient
 *     correlation context. There is NO public mutation path: no HTTP route
 *     writes audit events, and the database itself rejects UPDATE/DELETE
 *     (append-only triggers, migration 006);
 *   - events are CORRELATION-LINKED (sync API and async worker boundaries
 *     share one correlation identity through durable context);
 *   - replay-deduplication: an idempotency key fences duplicate emissions
 *     of the same logical event (converge to the existing row);
 *   - secret material can never enter an audit record: the §21 backstop
 *     guard rejects material-like detail keys BEFORE insert (fail-closed).
 *
 * Observability records (logs/metrics) remain a separate, deliberately
 * non-authoritative stream (OBS-AC-02); this module is the DURABLE audit
 * authority. Reads are exposed to server-side callers only (no HTTP read
 * surface in MKT-005).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /audit ──→ /auth.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

/** Material mutation outcome recorded on the event. */
export type AuditResult = 'succeeded' | 'failed';

/** Durable audit event record (append-only; rows are written once). */
export interface AuditEventRecord {
  readonly eventId: string;
  readonly occurredAt: string;
  /** Server-derived actor description: 'user:<uuid>' | 'service:<label>' | 'anonymous'. */
  readonly actor: string;
  /** Dot-namespaced action, e.g. 'clients.created', 'auth.session.login.failed'. */
  readonly action: string;
  readonly agencyId: string | null;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string | null;
  readonly beforeVersion: number | null;
  readonly afterVersion: number | null;
  readonly result: AuditResult;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AuditEventInput {
  readonly actor: string;
  readonly action: string;
  readonly agencyId: string | null;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  /**
   * When supplied, a replayed emission of the SAME logical event converges
   * to the existing row (returns it with replayed=true). Events that may
   * legitimately repeat must be emitted WITHOUT a key.
   */
  readonly idempotencyKey: string | null;
  readonly beforeVersion: number | null;
  readonly afterVersion: number | null;
  readonly result: AuditResult;
  /** JSON-safe metadata WITHOUT secret material (guard-enforced). */
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AuditAppendResult {
  readonly event: AuditEventRecord;
  /** True when an existing event with the same idempotency key was returned. */
  readonly replayed: boolean;
}

/** Read-only, scope-filtered query over the immutable trail (server-side). */
export interface AuditEventFilter {
  readonly agencyId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface AuditModuleApi {
  /**
   * Appends one immutable audit event. Server-owned fields are set here.
   * Duplicate idempotency keys converge (replayed=true). Material-like
   * detail keys are REJECTED (fail-closed) per implementation-contract §21.
   */
  appendAuditEvent(input: AuditEventInput): Promise<AuditAppendResult>;
  /** Newest-first read over the trail, filtered server-side. */
  queryAuditEvents(filter: AuditEventFilter): Promise<readonly AuditEventRecord[]>;
}

export interface AuditModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export { createAuditModule } from './internal/audit-module.ts';
/**
 * The append guard (validation + §21 secret-leak backstop) — exported for
 * unit tests and future server-side emitters so the guard semantics are
 * part of the module contract. Pure function.
 */
export { assertValidAuditEvent } from './internal/audit-store.ts';
