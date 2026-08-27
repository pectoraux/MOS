/**
 * MKT-005 integration test — the append-only audit authority (AUD-001,
 * issue #13 MKT-005-AC-06/07) against real PostgreSQL + a real API
 * subprocess.
 *
 * Proves:
 *   - material mutations persist DURABLE audit events with every §22 field:
 *     server-owned identity/timestamp, actor derived from the authenticated
 *     principal (never a request field), agency/client/workspace scope from
 *     the canonical owner chain, action, target, correlation identity,
 *     before/after versions and result;
 *   - CORRELATION-LINKED across the sync boundary: a caller-supplied
 *     x-correlation-id (UUID) flows into the audit row of the mutation it
 *     caused; failed logins record result='failed' events;
 *   - APPEND-ONLY: UPDATE and DELETE on audit_events are rejected by the
 *     database itself — history cannot be rewritten even by server-side
 *     SQL;
 *   - REPLAY CONVERGENCE: duplicate idempotency-keyed emissions converge to
 *     ONE durable row (replayed duplicates cannot fabricate history);
 *   - NO PUBLIC FABRICATION PATH: /api/audit/* routes do not exist (404),
 *     and no other route writes audit rows for its callers;
 *   - audit rows exist BEFORE the response claims completion (the pipeline
 *     emits before responding — asserted by querying immediately after the
 *     response arrives).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createAuditModule } from '../../src/modules/audit/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

interface AuditRow {
  [column: string]: unknown;
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
  before_version: number | string | null;
  after_version: number | string | null;
  result: string;
  details: Record<string, unknown>;
}

async function auditRows(where: string, params: unknown[] = []): Promise<AuditRow[]> {
  assert.ok(db !== null);
  const result = await db.query<AuditRow>(`SELECT * FROM audit_events WHERE ${where}`, params as never[]);
  return result.rows as AuditRow[];
}

before(async () => {
  stack = await bootStack('audit');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
});

after(async () => {
  await db?.close();
  if (api !== null) {
    api.child.kill('SIGTERM');
    await api.exitCode();
  }
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------

test('AC-06/07: a material mutation persists a complete, correlation-linked audit row BEFORE claiming completion', async () => {
  const admin = await adminToken();
  const correlationId = randomUUID();

  // Material mutation with a caller-supplied correlation identity (UUID).
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    correlationId,
    body: { email: 'audited@marketingos.test', displayName: 'Audited User' },
  });
  assert.equal(user.status, 201);
  const userId = user.body['userId'] as string;

  // The audit row exists IMMEDIATELY — the 201 response only happens after
  // the emit step persisted it (pipeline order: execute → emit → respond).
  const rows = await auditRows('action = $1 AND target_id = $2', ['users.user.created', userId]);
  assert.equal(rows.length, 1, 'exactly one audit row per material mutation');
  const row = rows[0]!;
  assert.equal(row.actor, `user:${await adminUserId()}`);
  assert.equal(row.target_type, 'user');
  assert.equal(row.result, 'succeeded');
  assert.equal(Number(row.after_version), 1);
  assert.equal(row.correlation_id, correlationId, 'caller correlation id flows into the durable audit row');
  assert.ok(typeof row.event_id === 'string' && row.event_id.length > 0, 'server-owned event identity');
  assert.ok(!Number.isNaN(Date.parse(row.occurred_at.toISOString())), 'server-owned timestamp');
  assert.equal(row.agency_id, null, 'platform-scoped mutation');
  assert.equal(row.idempotency_key, `users.user.created:${userId}`);
});

// The bootstrap admin's user id is needed for actor assertions (resolved lazily).
let adminUserIdCache: string | null = null;
async function adminUserId(): Promise<string> {
  if (adminUserIdCache !== null) return adminUserIdCache;
  const context = await apiCall(port(), '/api/auth/authorization-context', { token: await adminToken() });
  assert.equal(context.status, 200);
  adminUserIdCache = (context.body['principal'] as Record<string, unknown>)['userId'] as string;
  assert.ok(typeof adminUserIdCache === 'string');
  return adminUserIdCache;
}

test('AC-06/07: tenant-scoped mutations record the canonical owner scope and CAS versions', async () => {
  const admin = await adminToken();
  const correlationId = randomUUID();

  // Agency → Client → Workspace chain with audit rows at each level.
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    correlationId,
    body: { email: 'owner@audit-tenant.test', displayName: 'Audit Owner' },
  });
  assert.equal(user.status, 201);
  const ownerId = user.body['userId'] as string;

  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    correlationId,
    body: { name: 'Audit Agency', ownerUserId: ownerId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;

  // Login as the owner to mutate with a user principal actor.
  await apiCall(port(), `/api/users/${ownerId}/credential`, {
    token: admin,
    body: { password: 'audit-owner-pass-123' },
  });
  const ownerLogin = await apiCall(port(), '/api/auth/login', {
    correlationId,
    body: { email: 'owner@audit-tenant.test', password: 'audit-owner-pass-123' },
  });
  assert.equal(ownerLogin.status, 200);
  const ownerToken = ownerLogin.body['token'] as string;

  const clientCorrelation = randomUUID();
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: ownerToken,
    correlationId: clientCorrelation,
    body: { name: 'Audit Client' },
  });
  assert.equal(client.status, 201);
  const clientId = client.body['clientId'] as string;

  const clientAudit = await auditRows('action = $1 AND target_id = $2', ['clients.client.created', clientId]);
  assert.equal(clientAudit.length, 1);
  const clientRow = clientAudit[0]!;
  assert.equal(clientRow.agency_id, agencyId, 'agency scope from the canonical owner chain');
  assert.equal(clientRow.correlation_id, clientCorrelation);
  assert.equal(clientRow.result, 'succeeded');
  assert.equal(Number(clientRow.after_version), 1);

  // CAS transition records before/after versions.
  const statusCorrelation = randomUUID();
  const disable = await apiCall(port(), `/api/clients/${clientId}/status`, {
    token: ownerToken,
    correlationId: statusCorrelation,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disable.status, 200);
  const statusAudit = await auditRows('action = $1 AND target_id = $2', ['clients.client.status_changed', clientId]);
  assert.equal(statusAudit.length, 1);
  assert.equal(Number(statusAudit[0]!.before_version), 1);
  assert.equal(Number(statusAudit[0]!.after_version), 2);
  assert.equal(statusAudit[0]!.correlation_id, statusCorrelation);
  assert.deepEqual(statusAudit[0]!.details, { status: 'disabled' });

  // Login events are auditable authorization events (succeeded + failed).
  const successAudit = await auditRows('action = $1 AND correlation_id = $2', ['auth.login.succeeded', correlationId]);
  assert.ok(successAudit.length >= 1, 'successful login recorded');
  assert.equal(successAudit[0]!.actor, `user:${ownerId}`);

  const failedLogin = await apiCall(port(), '/api/auth/login', {
    body: { email: 'owner@audit-tenant.test', password: 'wrong-password-12345' },
  });
  assert.equal(failedLogin.status, 401);
  const failedAudit = await auditRows("action = 'auth.login.failed' AND result = 'failed'");
  assert.ok(failedAudit.length >= 1, 'failed login recorded as a failed material authorization event');
  assert.ok(!JSON.stringify(failedAudit).includes('wrong-password-12345'), 'audit never carries the password');
});

test('AC-06: APPEND-ONLY — the database rejects UPDATE and DELETE on audit_events', async () => {
  assert.ok(db !== null);
  const rows = await auditRows('action = $1', ['users.user.created']);
  assert.ok(rows.length > 0);
  const victim = rows[0]!;

  await assert.rejects(
    db.query('UPDATE audit_events SET result = $1 WHERE event_id = $2', ['failed', victim.event_id]),
    /append-only/,
  );
  await assert.rejects(
    db.query('UPDATE audit_events SET actor = $1 WHERE event_id = $2', ['forged:actor', victim.event_id]),
    /append-only/,
  );
  await assert.rejects(
    db.query('DELETE FROM audit_events WHERE event_id = $1', [victim.event_id]),
    /append-only/,
  );
  // The row is untouched after the rejected rewrites.
  const after = await auditRows('event_id = $1', [victim.event_id]);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.actor, victim.actor);
  assert.equal(after[0]!.result, victim.result);
});

test('AC-06: REPLAY CONVERGENCE — duplicate idempotency-keyed emissions converge to ONE row', async () => {
  assert.ok(stack !== null && db !== null);
  const audit = createAuditModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator() });
  const key = `replay.probe:${randomUUID()}`;

  const first = await audit.appendAuditEvent({
    actor: 'service:test',
    action: 'platform.operation.submitted',
    agencyId: null,
    clientId: null,
    workspaceId: null,
    targetType: 'platform_operation',
    targetId: '0192-op',
    correlationId: 'corr-replay-probe',
    causationId: null,
    idempotencyKey: key,
    beforeVersion: null,
    afterVersion: null,
    result: 'succeeded',
    details: { handler: 'probe' },
  });
  assert.equal(first.replayed, false);

  // A replayed emission of the SAME logical event converges.
  const replay = await audit.appendAuditEvent({
    actor: 'service:test',
    action: 'platform.operation.submitted',
    agencyId: null,
    clientId: null,
    workspaceId: null,
    targetType: 'platform_operation',
    targetId: '0192-op',
    correlationId: 'corr-replay-probe',
    causationId: null,
    idempotencyKey: key,
    beforeVersion: null,
    afterVersion: null,
    result: 'succeeded',
    details: { handler: 'probe' },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.event.eventId, first.event.eventId, 'the ORIGINAL durable event is returned');

  const rows = await auditRows('idempotency_key = $1', [key]);
  assert.equal(rows.length, 1, 'exactly one durable row for the logical event');
});

test('AC-06: the append guard refuses material-shaped details (§21 backstop at the authority itself)', async () => {
  assert.ok(stack !== null && db !== null);
  const audit = createAuditModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator() });
  await assert.rejects(
    audit.appendAuditEvent({
      actor: 'service:test',
      action: 'platform.operation.submitted',
      agencyId: null,
      clientId: null,
      workspaceId: null,
      targetType: 'platform_operation',
      targetId: '0192-op',
      correlationId: 'corr-guard-probe',
      causationId: null,
      idempotencyKey: null,
      beforeVersion: null,
      afterVersion: null,
      result: 'succeeded',
      details: { secret: 'leak' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      return true;
    },
  );
});

test('AC-06: NO PUBLIC FABRICATION PATH — audit routes do not exist', async () => {
  const admin = await adminToken();
  for (const [method, pathName] of [
    ['POST', '/api/audit/events'],
    ['GET', '/api/audit/events'],
    ['POST', '/api/audit'],
    ['PATCH', '/api/audit/events/0192'],
    ['DELETE', '/api/audit/events/0192'],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: admin,
      method,
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
    });
    assert.equal(response.status, 404, `${method} ${pathName} must not exist`);
  }
});

test('AC-07: correlation survives the ASYNC boundary — job submission audit carries the request correlation into durable rows', async () => {
  const correlationId = randomUUID();
  const submitted = await apiCall(port(), '/api/platform/operations', {
    token: 'integration-test-token',
    correlationId,
    body: { handler: 'platform.sample.long-running-work', input: { durationMs: 30 } },
  });
  assert.equal(submitted.status, 202);
  const operationId = submitted.body['operationId'] as string;

  // The submission audit row carries the caller correlation identity…
  const submitAudit = await auditRows('action = $1 AND target_id = $2', ['platform.operation.submitted', operationId]);
  assert.equal(submitAudit.length, 1);
  assert.equal(submitAudit[0]!.correlation_id, correlationId);
  assert.ok(String(submitAudit[0]!.actor).startsWith('service:'), 'service-principal actor recorded');

  // …and the durable job row carries the SAME identity across the queue
  // boundary (the worker restores it from PostgreSQL — OBS-AC-01).
  assert.ok(db !== null);
  const job = await db.query<{ correlation_id: string; payload: unknown }>(
    'SELECT correlation_id, payload FROM platform_jobs WHERE job_id = $1',
    [operationId],
  );
  assert.equal(job.rows[0]?.correlation_id, correlationId);
  assert.ok(!JSON.stringify(job.rows[0]?.payload).includes(BOOTSTRAP_PASSWORD), 'queue payload never carries secrets');
});
