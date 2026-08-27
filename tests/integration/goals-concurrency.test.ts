/**
 * MKT-006 concurrency integration test — Goal lifecycle/content invariants
 * under parallel operations (real PostgreSQL + real API subprocess).
 *
 * Proofs (exactly-one-winner assertions, not mere absence of errors):
 *   - concurrent CAS content updates at the same version: exactly ONE
 *     winner; no lost updates (final version = base + 1);
 *   - concurrent lifecycle transitions at the same version (including
 *     competing terminal outcomes): exactly one winner with deterministic
 *     conflict behavior;
 *   - concurrent DISTINCT creations ALL succeed (no lost creates — every
 *     server-generated identity persists);
 *   - identity/ownership/scope/provenance immutability and the terminal
 *     freeze hold against direct database mutations (the trigger backstops
 *     fire on every UPDATE path).
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
let clientId = '';

before(async () => {
  stack = await bootStack('goalconc');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  const admin = await adminToken();
  const createUser = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: 'owner@goalconc.test', displayName: 'Goal Concurrency Owner' },
  });
  assert.equal(createUser.status, 201);
  const userId = createUser.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'goalconc-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: 'owner@goalconc.test', password: 'goalconc-password-123' },
  });
  assert.equal(login.status, 200);
  ownerToken = login.body['token'] as string;

  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: 'Goal Concurrency Agency', ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;

  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: ownerToken,
    body: { name: 'Goal Concurrency Client' },
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

function goalBody(objective: string): Record<string, unknown> {
  return {
    objective,
    successCriteria: [
      { metric: 'qualified_leads', comparator: '>=', targetValue: 100, unit: 'count' },
    ],
  };
}

async function createGoal(objective: string) {
  return apiCall(port(), `/api/clients/${clientId}/goals`, {
    token: ownerToken,
    body: goalBody(objective),
  });
}

test('concurrent CAS content updates at the same version yield exactly one winner', async () => {
  const created = await createGoal('Contended objective');
  assert.equal(created.status, 201);
  const goalId = created.body['goalId'] as string;

  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      apiCall(port(), `/api/goals/${goalId}/profile`, {
        token: ownerToken,
        method: 'PATCH',
        body: { ...goalBody(`Contended objective v${index}`), version: 1 },
      }),
    ),
  );
  const statuses = attempts.map((attempt) => attempt.status).sort();
  assert.deepEqual(
    statuses,
    [200, 409, 409, 409, 409, 409, 409, 409],
    'exactly one 200 winner; every other contender is a 409 CAS loss',
  );

  // No lost update: the winner's objective is durable, version is base + 1.
  const winnerObjectives = attempts
    .filter((attempt) => attempt.status === 200)
    .map((attempt) => attempt.body['objective'] as string);
  assert.equal(winnerObjectives.length, 1);
  const read = await apiCall(port(), `/api/goals/${goalId}`, { token: ownerToken });
  assert.equal(read.status, 200);
  assert.equal(read.body['objective'], winnerObjectives[0]);
  assert.equal(read.body['version'], 2, 'exactly one version bump — no double increments');
});

test('concurrent lifecycle transitions at the same version yield exactly one winner (incl. competing terminal outcomes)', async () => {
  // Round 1: draft → active vs draft → abandoned.
  const first = await createGoal('Lifecycle race one');
  assert.equal(first.status, 201);
  const firstId = first.body['goalId'] as string;
  const races = await Promise.all([
    apiCall(port(), `/api/goals/${firstId}/status`, {
      token: ownerToken,
      method: 'PATCH',
      body: { status: 'active', version: 1 },
    }),
    apiCall(port(), `/api/goals/${firstId}/status`, {
      token: ownerToken,
      method: 'PATCH',
      body: { status: 'abandoned', version: 1 },
    }),
  ]);
  assert.equal(races.filter((attempt) => attempt.status === 200).length, 1);
  assert.equal(races.filter((attempt) => attempt.status === 409).length, 1);
  const readFirst = await apiCall(port(), `/api/goals/${firstId}`, { token: ownerToken });
  assert.equal(readFirst.status, 200);
  assert.equal(readFirst.body['version'], 2);

  // Round 2: 8 concurrent identical terminal transitions — one winner.
  const second = await createGoal('Lifecycle race two');
  assert.equal(second.status, 201);
  const secondId = second.body['goalId'] as string;
  const activated = await apiCall(port(), `/api/goals/${secondId}/status`, {
    token: ownerToken,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(activated.status, 200);
  const terminalRaces = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/goals/${secondId}/status`, {
        token: ownerToken,
        method: 'PATCH',
        body: { status: 'achieved', version: 2 },
      }),
    ),
  );
  assert.deepEqual(
    terminalRaces.map((attempt) => attempt.status).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
    'exactly one terminal transition wins',
  );
  const readSecond = await apiCall(port(), `/api/goals/${secondId}`, { token: ownerToken });
  assert.equal(readSecond.body['status'], 'achieved');
  assert.equal(readSecond.body['version'], 3, 'exactly one version bump');
});

test('concurrent distinct creations ALL succeed — every server-generated identity persists', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) => createGoal(`Distinct objective ${index}`)),
  );
  for (const attempt of attempts) {
    assert.equal(attempt.status, 201, 'no lost creates under parallel insertion');
  }
  const goalIds = attempts.map((attempt) => attempt.body['goalId'] as string);
  assert.equal(new Set(goalIds).size, 8, 'identities are distinct');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM goals WHERE client_id = $1',
      [clientId],
    );
    // 3 goals from the earlier tests + 8 here.
    assert.equal(rows.rows[0]!.count, '11', 'every goal row is durable');
  } finally {
    await db.close();
  }
});

test('database backstops: identity, ownership, scope and provenance are immutable; terminal rows are frozen', async () => {
  const created = await createGoal('Backstop objective');
  assert.equal(created.status, 201);
  const goalId = created.body['goalId'] as string;
  const achieved = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: ownerToken,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(achieved.status, 200);
  const done = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: ownerToken,
    method: 'PATCH',
    body: { status: 'achieved', version: 2 },
  });
  assert.equal(done.status, 200);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Identity / ownership / provenance immutability on the LIVE (non-terminal)
    // rows first — using a fresh non-terminal goal.
    const live = await createGoal('Backstop live objective');
    assert.equal(live.status, 201);
    const liveId = live.body['goalId'] as string;

    await assert.rejects(
      () =>
        db.query('UPDATE goals SET goal_id = $1 WHERE goal_id = $2', [
          '00000000-0000-0000-0000-000000001001',
          liveId,
        ]),
      /goal_id .* is immutable/,
    );
    await assert.rejects(
      () => db.query('UPDATE goals SET client_id = $1 WHERE goal_id = $2', [
        '00000000-0000-0000-0000-000000001002',
        liveId,
      ]),
      /cannot change Client ownership/,
    );
    await assert.rejects(
      () => db.query('UPDATE goals SET created_by = $1 WHERE goal_id = $2', [
        '00000000-0000-0000-0000-000000001003',
        liveId,
      ]),
      /provenance is immutable/,
    );
    await assert.rejects(
      () => db.query('UPDATE goals SET created_at = now() WHERE goal_id = $1', [liveId]),
      /provenance is immutable/,
    );

    // Terminal freeze: EVERY content-changing update on the achieved row is
    // rejected — status, content, even a bare version bump.
    await assert.rejects(
      () => db.query('UPDATE goals SET objective = $1 WHERE goal_id = $2', ['Rewritten', goalId]),
      /is achieved and frozen/,
      'terminal objective rewrite must be rejected',
    );
    await assert.rejects(
      () => db.query("UPDATE goals SET status = 'active' WHERE goal_id = $1", [goalId]),
      /is achieved and frozen/,
      'terminal status resurrection must be rejected',
    );
    await assert.rejects(
      () => db.query('UPDATE goals SET version = version + 1 WHERE goal_id = $1', [goalId]),
      /is achieved and frozen/,
      'even a bare version bump on terminal history must be rejected',
    );

    // A pure no-op UPDATE stays legal (changes nothing).
    const noOp = await db.query<{ objective: string; version: number | string }>(
      'UPDATE goals SET objective = objective WHERE goal_id = $1 RETURNING objective, version',
      [goalId],
    );
    assert.equal(noOp.rows[0]!.objective, 'Backstop objective');
    assert.equal(Number(noOp.rows[0]!.version), 3, 'no-op write does not churn the version');

    // The success_criteria non-empty CHECK fences even direct INSERTs.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO goals (goal_id, client_id, objective, success_criteria)
           VALUES ($1, $2, 'Criteria-less', '[]'::jsonb)`,
          ['00000000-0000-0000-0000-000000001004', clientId],
        ),
      /success_criteria/,
      'the DB rejects a goal without measurable success criteria (GOAL-AC-01 storage fence)',
    );

    // Legitimate mutation on the LIVE row still works (no over-blocking).
    const ok = await db.query<{ objective: string }>(
      "UPDATE goals SET objective = 'Legitimately Renamed', version = version + 1 WHERE goal_id = $1 RETURNING objective",
      [liveId],
    );
    assert.equal(ok.rows[0]!.objective, 'Legitimately Renamed');
  } finally {
    await db.close();
  }
});
