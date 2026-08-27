/**
 * MKT-004 concurrency integration test — Workspace lifecycle/ownership
 * invariants under parallel operations (real PostgreSQL + real API
 * subprocess; issue #11 MKT-004-AC-07).
 *
 * Proofs (exactly-one-winner assertions, not mere absence of errors):
 *   - concurrent duplicate slug creation under one Client: exactly ONE 201,
 *     the rest 409 — the (client_id, slug) partial unique fence decides
 *     race-free;
 *   - the same slug races fine under a DIFFERENT client (per-Client fence);
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
let clientId = '';

before(async () => {
  stack = await bootStack('wspconc');
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

  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: ownerToken,
    body: { name: 'Concurrency Client' },
  });
  assert.equal(client.status, 201);
  clientId = client.body['clientId'] as string;
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

function createWorkspace(name: string, slug?: string) {
  return apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: ownerToken,
    body: { name, ...(slug === undefined ? {} : { slug }) },
  });
}

test('concurrent duplicate slug creation yields exactly one winner (DB fence)', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      createWorkspace(`Racing Workspace ${index}`, 'racing-slug'),
    ),
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
    const rows = await db.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspaces WHERE client_id = $1 AND slug = 'racing-slug' AND status <> 'deleted'",
      [clientId],
    );
    assert.equal(rows.rows.length, 1, 'exactly one live row despite 8 concurrent inserts');
    assert.equal(rows.rows[0]!.workspace_id, winner.body['workspaceId']);
  } finally {
    await db.close();
  }
});

test('the same slug races fine under a DIFFERENT client (per-Client fence)', async () => {
  const other = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: ownerToken,
    body: { name: 'Concurrency Client Two' },
  });
  assert.equal(other.status, 201);
  const otherClientId = other.body['clientId'] as string;

  // The winning slug from the previous test can be re-used under another
  // client — and races resolve the same way there.
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      apiCall(port(), `/api/clients/${otherClientId}/workspaces`, {
        token: ownerToken,
        body: { name: 'Racing Workspace Other', slug: 'racing-slug' },
      }),
    ),
  );
  const statuses = attempts.map((attempt) => attempt.status).sort();
  assert.deepEqual(
    statuses,
    [201, 409, 409, 409],
    `exactly one 201 under the second client, got ${statuses.join(',')}`,
  );

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ client_id: string }>(
      "SELECT client_id FROM workspaces WHERE slug = 'racing-slug' AND status <> 'deleted'",
    );
    assert.equal(rows.rows.length, 2, 'one live row per client — the fence is per-Client');
    assert.deepEqual(
      new Set(rows.rows.map((row) => row.client_id)),
      new Set([clientId, otherClientId]),
    );
  } finally {
    await db.close();
  }
});

test('concurrent CAS profile updates converge with exactly one winner per version', async () => {
  const created = await createWorkspace('CAS Workspace');
  assert.equal(created.status, 201);
  const workspaceId = created.body['workspaceId'] as string;

  // Eight parallel renames, all at version 1: exactly one wins.
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      apiCall(port(), `/api/workspaces/${workspaceId}/profile`, {
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
  const read = await apiCall(port(), `/api/workspaces/${workspaceId}`, { token: ownerToken });
  assert.equal(read.body['name'], winner.body['name'], "the winner's write survived");
  assert.equal(read.body['version'], 2, 'exactly one version increment — no lost updates');

  // Sequential update at the CURRENT version still works (convergence).
  const followUp = await apiCall(port(), `/api/workspaces/${workspaceId}/profile`, {
    token: ownerToken,
    method: 'PATCH',
    body: { name: 'CAS Follow-up', version: 2 },
  });
  assert.equal(followUp.status, 200);
  assert.equal(followUp.body['version'], 3);
});

test('concurrent lifecycle transitions are serialized with deterministic conflict behavior', async () => {
  const created = await createWorkspace('Lifecycle Race Workspace');
  assert.equal(created.status, 201);
  const workspaceId = created.body['workspaceId'] as string;

  // Two legal-but-competing transitions at the same version.
  const [disable, del] = await Promise.all([
    apiCall(port(), `/api/workspaces/${workspaceId}/status`, {
      token: ownerToken,
      method: 'PATCH',
      body: { status: 'disabled', version: 1 },
    }),
    apiCall(port(), `/api/workspaces/${workspaceId}/status`, {
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
      'SELECT status, version FROM workspaces WHERE workspace_id = $1',
      [workspaceId],
    );
    assert.equal(rows.rows[0]!.status, winner.body['status']);
    assert.equal(Number(rows.rows[0]!.version), 2, 'exactly one version increment');
  } finally {
    await db.close();
  }
});

test('concurrent distinct-slug creations all succeed (no lost creates)', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) => createWorkspace(`Distinct Workspace ${index}`)),
  );
  for (const attempt of attempts) {
    assert.equal(attempt.status, 201, `parallel create should succeed: ${JSON.stringify(attempt.body)}`);
  }
  const ids = new Set(attempts.map((attempt) => attempt.body['workspaceId'] as string));
  assert.equal(ids.size, 8, 'eight distinct workspace identities');

  const list = await apiCall(port(), `/api/clients/${clientId}/workspaces`, { token: ownerToken });
  assert.equal(list.status, 200);
  const listed = (list.body['workspaces'] as Record<string, unknown>[]).filter((workspace) =>
    ids.has(workspace['workspaceId'] as string),
  );
  assert.equal(listed.length, 8, 'every concurrent create is durably visible');
});

test('ownership, identity and provenance are immutable against direct database mutation (MKT-004-AC-01)', async () => {
  const created = await createWorkspace('Immutable Workspace', 'immutable-workspace');
  assert.equal(created.status, 201);
  const workspaceId = created.body['workspaceId'] as string;

  // A second client to attempt re-parenting into.
  const otherClient = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: ownerToken,
    body: { name: 'Immutable Other Client' },
  });
  assert.equal(otherClient.status, 201);
  const otherClientId = otherClient.body['clientId'] as string;

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Client ownership can never be reassigned (crossing the Client
    // boundary is structurally impossible — issue #11 MKT-004-AC-01).
    await assert.rejects(
      () => db.query('UPDATE workspaces SET client_id = $1 WHERE workspace_id = $2', [
        otherClientId,
        workspaceId,
      ]),
      /cannot change Client ownership/,
      'client ownership must be immutable',
    );
    // Identity can never be reassigned.
    await assert.rejects(
      () =>
        db.query('UPDATE workspaces SET workspace_id = $1 WHERE workspace_id = $2', [
          '00000000-0000-0000-0000-0000000000ee',
          workspaceId,
        ]),
      /workspace_id .* is immutable/,
      'workspace identity must be immutable',
    );
    // Provenance can never be rewritten.
    await assert.rejects(
      () =>
        db.query('UPDATE workspaces SET created_by = $1 WHERE workspace_id = $2', [
          '00000000-0000-0000-0000-0000000000ef',
          workspaceId,
        ]),
      /provenance is immutable/,
      'provenance must be immutable',
    );
    await assert.rejects(
      () =>
        db.query('UPDATE workspaces SET created_at = $1 WHERE workspace_id = $2', [
          new Date('2020-01-01T00:00:00Z'),
          workspaceId,
        ]),
      /provenance is immutable/,
      'created_at must be immutable',
    );

    // Legitimate mutable fields still work (the triggers do not over-block).
    const ok = await db.query<{ name: string }>(
      "UPDATE workspaces SET name = 'Immutable Workspace Renamed', version = version + 1 WHERE workspace_id = $1 RETURNING name",
      [workspaceId],
    );
    assert.equal(ok.rows[0]!.name, 'Immutable Workspace Renamed');
  } finally {
    await db.close();
  }
});
