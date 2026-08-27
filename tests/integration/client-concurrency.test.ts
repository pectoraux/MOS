/**
 * MKT-003 concurrency integration test — Client lifecycle/ownership
 * invariants under parallel operations (real PostgreSQL + real API
 * subprocess; issue #9 MKT-003-AC-02).
 *
 * Proofs (exactly-one-winner assertions, not mere absence of errors):
 *   - concurrent duplicate slug creation: exactly ONE 201, the rest 409 —
 *     the (agency_id, slug) partial unique fence decides race-free;
 *   - concurrent CAS profile updates at the same version: exactly one
 *     winner; no lost updates (final version = base + 1);
 *   - concurrent lifecycle transitions at the same version: exactly one
 *     winner with deterministic conflict behavior;
 *   - concurrent distinct-slug creations ALL succeed (no lost creates);
 *   - ownership/identity/provenance immutability holds against direct
 *     database mutations (the trigger backstop fires on every UPDATE).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

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

let ownerToken = '';
let agencyId = '';

before(async () => {
  stack = await bootStack('clientconc');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  const admin = await adminToken();
  const createUser = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: 'owner@conc.test', displayName: 'Concurrency Owner' },
  });
  assert.equal(createUser.status, 201);
  const userId = createUser.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'conc-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: 'owner@conc.test', password: 'conc-password-123' },
  });
  assert.equal(login.status, 200);
  ownerToken = login.body['token'] as string;

  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: 'Concurrency Agency', ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

function createClient(name: string, slug?: string) {
  return apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: ownerToken,
    body: { name, ...(slug === undefined ? {} : { slug }) },
  });
}

test('concurrent duplicate slug creation yields exactly one winner (DB fence)', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) => createClient(`Racing Client ${index}`, 'racing-slug')),
  );
  const statuses = attempts.map((attempt) => attempt.status).sort();
  assert.deepEqual(
    statuses,
    [201, 409, 409, 409, 409, 409, 409, 409],
    `exactly one 201 and seven 409s, got ${statuses.join(',')}`,
  );
  const winner = attempts.find((attempt) => attempt.status === 201)!;

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ client_id: string }>(
      "SELECT client_id FROM clients WHERE agency_id = $1 AND slug = 'racing-slug' AND status <> 'deleted'",
      [agencyId],
    );
    assert.equal(rows.rows.length, 1, 'exactly one live row despite 8 concurrent inserts');
    assert.equal(rows.rows[0]!.client_id, winner.body['clientId']);
  } finally {
    await db.close();
  }
});

test('concurrent CAS profile updates converge with exactly one winner per version', async () => {
  const created = await createClient('CAS Client');
  assert.equal(created.status, 201);
  const clientId = created.body['clientId'] as string;

  // Eight parallel renames, all at version 1: exactly one wins.
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      apiCall(port(), `/api/clients/${clientId}/profile`, {
        token: ownerToken,
        method: 'PATCH',
        body: { name: `CAS Winner ${index}`, version: 1 },
      }),
    ),
  );
  const statuses = attempts.map((attempt) => attempt.status).sort();
  assert.deepEqual(
    statuses,
    [200, 409, 409, 409, 409, 409, 409, 409],
    `exactly one 200 and seven 409s, got ${statuses.join(',')}`,
  );

  const winner = attempts.find((attempt) => attempt.status === 200)!;
  const read = await apiCall(port(), `/api/clients/${clientId}`, { token: ownerToken });
  assert.equal(read.body['name'], winner.body['name'], "the winner's write survived");
  assert.equal(read.body['version'], 2, 'exactly one version increment — no lost updates');

  // Sequential update at the CURRENT version still works (convergence).
  const followUp = await apiCall(port(), `/api/clients/${clientId}/profile`, {
    token: ownerToken,
    method: 'PATCH',
    body: { name: 'CAS Follow-up', version: 2 },
  });
  assert.equal(followUp.status, 200);
  assert.equal(followUp.body['version'], 3);
});

test('concurrent lifecycle transitions are serialized with deterministic conflict behavior', async () => {
  const created = await createClient('Lifecycle Race Client');
  assert.equal(created.status, 201);
  const clientId = created.body['clientId'] as string;

  // Two legal-but-competing transitions at the same version.
  const [disable, del] = await Promise.all([
    apiCall(port(), `/api/clients/${clientId}/status`, {
      token: ownerToken,
      method: 'PATCH',
      body: { status: 'disabled', version: 1 },
    }),
    apiCall(port(), `/api/clients/${clientId}/status`, {
      token: ownerToken,
      method: 'PATCH',
      body: { status: 'deleted', version: 1 },
    }),
  ]);
  const statuses = [disable.status, del.status].sort();
  assert.ok(
    statuses[0] === 200 && (statuses[1] === 409 || statuses[1] === 404),
    `exactly one winner with deterministic conflict, got ${statuses.join(',')}`,
  );
  const winner = disable.status === 200 ? disable : del;

  // The durable final state matches the winner's transition exactly.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ status: string; version: number }>(
      'SELECT status, version FROM clients WHERE client_id = $1',
      [clientId],
    );
    assert.equal(rows.rows[0]!.status, winner.body['status']);
    assert.equal(Number(rows.rows[0]!.version), 2, 'exactly one version increment');
  } finally {
    await db.close();
  }
});

test('concurrent distinct-slug creations all succeed (no lost creates)', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) => createClient(`Distinct Client ${index}`)),
  );
  for (const attempt of attempts) {
    assert.equal(attempt.status, 201, `parallel create should succeed: ${JSON.stringify(attempt.body)}`);
  }
  const ids = new Set(attempts.map((attempt) => attempt.body['clientId'] as string));
  assert.equal(ids.size, 8, 'eight distinct client identities');

  const list = await apiCall(port(), `/api/agencies/${agencyId}/clients`, { token: ownerToken });
  assert.equal(list.status, 200);
  const listed = (list.body['clients'] as Record<string, unknown>[]).filter((client) =>
    ids.has(client['clientId'] as string),
  );
  assert.equal(listed.length, 8, 'every concurrent create is durably visible');
});

test('ownership, identity and provenance are immutable against direct database mutation (TENANT-AC-02)', async () => {
  const created = await createClient('Immutable Client', 'immutable-client');
  assert.equal(created.status, 201);
  const clientId = created.body['clientId'] as string;

  // A second agency to attempt re-parenting into.
  const admin = await adminToken();
  const otherAgency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: 'Other Agency', ownerUserId: created.body['createdBy'] as string },
  });
  assert.equal(otherAgency.status, 201);
  const otherAgencyId = (otherAgency.body['agency'] as Record<string, unknown>)['agencyId'] as string;

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Agency ownership can never be reassigned (tenant migration is
    // structurally impossible — TENANT-AC-02).
    await assert.rejects(
      () => db.query('UPDATE clients SET agency_id = $1 WHERE client_id = $2', [otherAgencyId, clientId]),
      /cannot change Agency ownership/,
      'agency ownership must be immutable',
    );
    // Identity can never be reassigned.
    await assert.rejects(
      () =>
        db.query('UPDATE clients SET client_id = $1 WHERE client_id = $2', [
          '00000000-0000-0000-0000-0000000000ee',
          clientId,
        ]),
      /client_id .* is immutable/,
      'client identity must be immutable',
    );
    // Provenance can never be rewritten.
    await assert.rejects(
      () =>
        db.query('UPDATE clients SET created_by = $1 WHERE client_id = $2', [
          '00000000-0000-0000-0000-0000000000ef',
          clientId,
        ]),
      /provenance is immutable/,
      'provenance must be immutable',
    );
    await assert.rejects(
      () =>
        db.query('UPDATE clients SET created_at = $1 WHERE client_id = $2', [
          new Date('2020-01-01T00:00:00Z'),
          clientId,
        ]),
      /provenance is immutable/,
      'created_at must be immutable',
    );

    // Legitimate mutable fields still work (the triggers do not over-block).
    const ok = await db.query<{ name: string }>(
      "UPDATE clients SET name = 'Immutable Client Renamed', version = version + 1 WHERE client_id = $1 RETURNING name",
      [clientId],
    );
    assert.equal(ok.rows[0]!.name, 'Immutable Client Renamed');
  } finally {
    await db.close();
  }
});
