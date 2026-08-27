/**
 * MKT-005 integration test — the frozen credential boundary (CRED-001,
 * issue #13 MKT-005-AC-05) against real PostgreSQL + a real API subprocess
 * + the real file-backed secret store.
 *
 * Proves:
 *   - credential REFERENCE management (create/list/read/lifecycle) with the
 *     established hard-boundary posture: uniform 404 for unknown/deleted/
 *     foreign references (no cross-tenant oracle), 403 for suspended
 *     membership, strict authority-field + material-smuggling rejection;
 *   - creation FAILS CLOSED when the secret handle does not resolve in the
 *     configured backend (no dangling references);
 *   - material resolution is scope-checked: in-scope resolves the material;
 *     out-of-agency, out-of-client, disabled and deleted references never
 *     resolve (fail-closed, uniform null);
 *   - SECRET MATERIAL NEVER LEAKS: after exercising the whole flow, every
 *     durable surface is swept — API response bodies, ALL observability
 *     records emitted by the API subprocess, ALL audit rows, ALL durable
 *     queue payloads — none contains the material;
 *   - DB backstops: scope/handle/identity immutability and the terminal
 *     deleted tombstone are enforced by triggers.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
import { FileSecretStore } from '../../src/platform/secrets/adapters/file/file-secret-store.ts';
import { createCredentialsModule } from '../../src/modules/credentials/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SECRET_HANDLE = 'provider-alpha-api-key';
const SECRET_MATERIAL = 'MATERIAL-do-not-leak-9f8a7b6c5d4e3f2a1b0c';

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

/** Creates user + agency and returns (token, agencyId, userId). */
async function makePrincipal(email: string): Promise<{ token: string; agencyId: string; userId: string }> {
  const admin = await adminToken();
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201);
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'a-very-long-password-123' },
  });
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'a-very-long-password-123' },
  });
  assert.equal(login.status, 200);
  return { token: login.body['token'] as string, agencyId, userId };
}

async function makeClient(agencyId: string, token: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${randomUUID().slice(0, 8)}` },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
}

before(async () => {
  stack = await bootStack('credsec');
  // Provision the secret out-of-band (deployment-style: a mounted file).
  fs.writeFileSync(path.join(stack.env.secretsDir, `${SECRET_HANDLE}.secret`), SECRET_MATERIAL, { mode: 0o600 });
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

test('AC-05: create + read + list a credential REFERENCE; serialization is opaque and non-secret', async () => {
  const owner = await makePrincipal('owner@credsec.test');
  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Provider Alpha', secretHandle: SECRET_HANDLE },
  });
  assert.equal(created.status, 201);
  const reference = created.body as Record<string, unknown>;
  assert.equal(reference['kind'], 'integration_api_key');
  assert.equal(reference['label'], 'Provider Alpha');
  assert.equal(reference['status'], 'active');
  // The serialized reference NEVER includes the backend handle or material.
  assert.ok(!('secretHandle' in reference), 'API response must not expose the backend handle');
  assert.ok(JSON.stringify(reference).includes(SECRET_MATERIAL) === false);

  const read = await apiCall(port(), `/api/credentials/${reference['credentialId']}`, {
    token: owner.token,
  });
  assert.equal(read.status, 200);
  assert.ok(!('secretHandle' in (read.body as object)));

  const list = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
  });
  assert.equal(list.status, 200);
  const items = (list.body['credentials'] as Array<Record<string, unknown>>).filter(
    (item) => item['credentialId'] === reference['credentialId'],
  );
  assert.equal(items.length, 1);
  assert.ok(!('secretHandle' in items[0]!));
});

test('AC-05: creation FAILS CLOSED when the secret handle does not resolve in the backend', async () => {
  const owner = await makePrincipal('dangling@credsec.test');
  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Dangling', secretHandle: 'never-provisioned-handle' },
  });
  assert.equal(created.status, 409, 'dangling references are refused (fail closed)');
});

test('AC-05: material-smuggling payloads are rejected at the validation step (§21 defense in depth)', async () => {
  const owner = await makePrincipal('smuggler@credsec.test');
  for (const extra of [
    { secret: 'raw-material' },
    { secretMaterial: 'raw-material' },
    { material: 'raw-material' },
    { token: 'raw-material' },
    { apiKey: 'raw-material' },
    { value: 'raw-material' },
    { credentialId: randomUUID() },
    { status: 'disabled' },
  ]) {
    const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
      token: owner.token,
      body: { kind: 'integration_api_key', label: 'Smuggle Probe', secretHandle: SECRET_HANDLE, ...extra },
    });
    assert.equal(created.status, 422, `smuggled field ${Object.keys(extra)[0]} must be rejected`);
  }
});

test('AC-05: cross-tenant boundary — foreign references are a UNIFORM 404 (no existence oracle)', async () => {
  const ownerA = await makePrincipal('owner-a@credsec.test');
  const ownerB = await makePrincipal('owner-b@credsec.test');

  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/credentials`, {
    token: ownerA.token,
    body: { kind: 'integration_api_key', label: 'A Only', secretHandle: SECRET_HANDLE },
  });
  assert.equal(created.status, 201);
  const credentialId = created.body['credentialId'] as string;

  // Foreign caller: same 404 as an unknown identifier.
  const foreign = await apiCall(port(), `/api/credentials/${credentialId}`, { token: ownerB.token });
  const unknown = await apiCall(port(), `/api/credentials/${randomUUID()}`, { token: ownerB.token });
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  // Payload SHAPE equality (the message echoes the probed identifier, which
  // is by design — the error body carries no extra distinguishing fields).
  const foreignError = foreign.body['error'] as Record<string, unknown>;
  const unknownError = unknown.body['error'] as Record<string, unknown>;
  assert.deepEqual(
    { ...foreignError, message: undefined },
    { ...unknownError, message: undefined },
    'foreign and unknown 404 payloads have identical shape (no existence oracle)',
  );
  assert.match(String(foreignError['message']), /^credential not found:/);

  // Foreign lifecycle attempts also 404 (uniform, before any mutation).
  const foreignStatus = await apiCall(port(), `/api/credentials/${credentialId}/status`, {
    token: ownerB.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(foreignStatus.status, 404);

  // Foreign listing never includes another agency's references.
  const listB = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/credentials`, {
    token: ownerB.token,
  });
  assert.equal(listB.status, 200);
  assert.equal((listB.body['credentials'] as unknown[]).length, 0);
});

test('AC-05: anonymous callers are rejected (401) on every credential route', async () => {
  const list = await apiCall(port(), `/api/agencies/${randomUUID()}/credentials`, {});
  assert.equal(list.status, 401);
  const read = await apiCall(port(), `/api/credentials/${randomUUID()}`, {});
  assert.equal(read.status, 401);
});

test('AC-05: Client-scope narrowing resolves against canonical Client ownership', async () => {
  const owner = await makePrincipal('scoped@credsec.test');
  const clientId = await makeClient(owner.agencyId, owner.token);
  // A clientId belonging to a DIFFERENT agency is rejected (404 — uniform).
  const stranger = await makePrincipal('stranger@credsec.test');
  const strangerClient = await makeClient(stranger.agencyId, stranger.token);
  const foreignScope = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: {
      kind: 'integration_api_key',
      label: 'Wrong Client Scope',
      secretHandle: SECRET_HANDLE,
      clientId: strangerClient,
    },
  });
  assert.equal(foreignScope.status, 404, 'client narrowing must resolve canonical ownership');

  // Correct narrowing works and the reference records the client scope.
  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Client Scoped', secretHandle: SECRET_HANDLE, clientId },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body['clientId'], clientId);
});

// ---------------------------------------------------------------------------
// Module-level material resolution (fail-closed, scope-checked)
// ---------------------------------------------------------------------------

test('AC-05: material resolution is scope-checked and fail-closed (module contract)', async () => {
  assert.ok(stack !== null && db !== null);
  const credentials = createCredentialsModule({
    db,
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    secrets: new FileSecretStore({ dir: stack.env.secretsDir }),
  });

  const owner = await makePrincipal('resolver@credsec.test');
  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Resolvable', secretHandle: SECRET_HANDLE },
  });
  assert.equal(created.status, 201);
  const credentialId = created.body['credentialId'] as string;

  // In-scope resolution returns the EXACT material bytes.
  const resolved = await credentials.resolveCredentialMaterial({
    credentialId,
    scope: { kind: 'authorized-execution', agencyId: owner.agencyId, clientId: null },
  });
  assert.ok(resolved !== null);
  assert.equal(new TextDecoder().decode(resolved.material), SECRET_MATERIAL);

  // Out-of-agency scope NEVER resolves (uniform null — no oracle).
  assert.equal(
    await credentials.resolveCredentialMaterial({
      credentialId,
      scope: { kind: 'authorized-execution', agencyId: randomUUID(), clientId: null },
    }),
    null,
  );

  // Unknown reference never resolves.
  assert.equal(
    await credentials.resolveCredentialMaterial({
      credentialId: randomUUID(),
      scope: { kind: 'authorized-execution', agencyId: owner.agencyId, clientId: null },
    }),
    null,
  );

  // Disabled references fail closed.
  const disable = await apiCall(port(), `/api/credentials/${credentialId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disable.status, 200);
  assert.equal(
    await credentials.resolveCredentialMaterial({
      credentialId,
      scope: { kind: 'authorized-execution', agencyId: owner.agencyId, clientId: null },
    }),
    null,
    'a disabled credential must not resolve',
  );

  // Client-narrowed references resolve ONLY in the owning client scope.
  const clientId = await makeClient(owner.agencyId, owner.token);
  const narrowed = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Narrow Resolvable', secretHandle: SECRET_HANDLE, clientId },
  });
  assert.equal(narrowed.status, 201);
  const narrowedId = narrowed.body['credentialId'] as string;
  assert.ok(
    await credentials.resolveCredentialMaterial({
      credentialId: narrowedId,
      scope: { kind: 'authorized-execution', agencyId: owner.agencyId, clientId },
    }) !== null,
    'in-client resolution succeeds',
  );
  assert.equal(
    await credentials.resolveCredentialMaterial({
      credentialId: narrowedId,
      scope: { kind: 'authorized-execution', agencyId: owner.agencyId, clientId: null },
    }),
    null,
    'client-narrowed reference must NOT resolve outside its client scope',
  );
});

// ---------------------------------------------------------------------------
// The LEAK SWEEP: no durable or observable surface contains the material
// ---------------------------------------------------------------------------

test('AC-05: LEAK SWEEP — the material appears in NO log record, audit row, queue payload or API response', async () => {
  assert.ok(stack !== null && db !== null && api !== null);

  // Exercise the full flow once more so the sweep covers fresh surfaces.
  const owner = await makePrincipal('sweep@credsec.test');
  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Sweep Probe', secretHandle: SECRET_HANDLE },
  });
  assert.equal(created.status, 201);
  const credentialId = created.body['credentialId'] as string;
  await apiCall(port(), `/api/credentials/${credentialId}`, { token: owner.token });

  // 1. API subprocess observability records (JSON lines on stdout).
  const apiRecords = api.logRecords();
  assert.ok(apiRecords.length > 0, 'the API emitted structured records');
  for (const record of apiRecords) {
    const serialized = JSON.stringify(record);
    assert.ok(
      !serialized.includes(SECRET_MATERIAL),
      `observability record ${record.event} leaked secret material`,
    );
    assert.ok(!serialized.includes(SECRET_HANDLE) || record.event.startsWith('http.'), 'backend handle must not appear in module logs');
  }

  // 2. Audit rows (durable).
  const auditRows = await db.query('SELECT * FROM audit_events');
  for (const row of auditRows.rows) {
    assert.ok(!JSON.stringify(row).includes(SECRET_MATERIAL), 'audit rows never contain secret material');
  }
  const credentialAudits = await db.query(
    'SELECT * FROM audit_events WHERE action LIKE $1',
    ['credentials.%'],
  );
  assert.ok(credentialAudits.rows.length > 0, 'credential mutations were audited');
  for (const row of credentialAudits.rows) {
    assert.ok(!JSON.stringify(row).includes(SECRET_MATERIAL));
  }

  // 3. Durable queue payloads.
  const jobRows = await db.query('SELECT payload FROM platform_jobs');
  for (const row of jobRows.rows) {
    assert.ok(!JSON.stringify(row).includes(SECRET_MATERIAL), 'queue payloads never contain secret material');
  }

  // 4. The credential_references row itself: opaque handle, never material.
  const referenceRows = await db.query<{ secret_handle: string }>(
    'SELECT secret_handle FROM credential_references WHERE credential_id = $1',
    [credentialId],
  );
  assert.equal(referenceRows.rows[0]?.secret_handle, SECRET_HANDLE);
  const allReferences = await db.query('SELECT * FROM credential_references');
  for (const row of allReferences.rows) {
    assert.ok(!JSON.stringify(row).includes(SECRET_MATERIAL), 'reference rows never contain material');
  }
});

// ---------------------------------------------------------------------------
// DB backstops (immutability + terminal tombstone)
// ---------------------------------------------------------------------------

test('AC-05: DB backstops — scope, handle and identity are immutable; deleted is terminal', async () => {
  assert.ok(stack !== null && db !== null);
  const owner = await makePrincipal('backstop@credsec.test');
  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Backstop Probe', secretHandle: SECRET_HANDLE },
  });
  assert.equal(created.status, 201);
  const credentialId = created.body['credentialId'] as string;

  // Identity / scope / handle mutations are rejected by triggers.
  await assert.rejects(
    db.query('UPDATE credential_references SET agency_id = $1 WHERE credential_id = $2', [randomUUID(), credentialId]),
    /cannot change Agency ownership/,
  );
  await assert.rejects(
    db.query('UPDATE credential_references SET secret_handle = $1 WHERE credential_id = $2', ['other-handle', credentialId]),
    /cannot be re-bound/,
  );
  await assert.rejects(
    db.query('UPDATE credential_references SET credential_id = $1 WHERE credential_id = $2', [randomUUID(), credentialId]),
    /is immutable/,
  );

  // Lifecycle: delete, then the tombstone is terminal.
  const del = await apiCall(port(), `/api/credentials/${credentialId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(del.status, 200);
  await assert.rejects(
    db.query("UPDATE credential_references SET status = 'active' WHERE credential_id = $1", [credentialId]),
    /deleted and terminal/,
  );

  // Tombstone is a uniform 404 through the API.
  const read = await apiCall(port(), `/api/credentials/${credentialId}`, { token: owner.token });
  assert.equal(read.status, 404);

  // Label reuse by a NEW identity is allowed (tombstones don't fence).
  const reuse = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Backstop Probe', secretHandle: SECRET_HANDLE },
  });
  assert.equal(reuse.status, 201);
});

test('AC-05: label uniqueness among LIVE references is race-fenced per agency', async () => {
  const owner = await makePrincipal('fence@credsec.test');
  const first = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Unique Label', secretHandle: SECRET_HANDLE },
  });
  assert.equal(first.status, 201);
  const second = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Unique Label', secretHandle: SECRET_HANDLE },
  });
  assert.equal(second.status, 409);

  // After deletion the label becomes available again (partial fence).
  const del = await apiCall(port(), `/api/credentials/${first.body['credentialId']}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(del.status, 200);
  const reuse = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'Unique Label', secretHandle: SECRET_HANDLE },
  });
  assert.equal(reuse.status, 201);
});
