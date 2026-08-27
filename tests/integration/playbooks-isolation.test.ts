/**
 * MKT-007 security/isolation integration test — the Playbooks domain
 * inside the tenant boundaries (real PostgreSQL + real API subprocess).
 *
 * Proofs (cross-tenant posture; security-threat-model "Cross-tenant
 * traversal": negative tests using two Agencies / two Clients):
 *   - a foreign Playbook identifier (Agency-scoped or Client-scoped,
 *     owned by ANOTHER Agency) yields the SAME 404 as an unknown one — no
 *     traversal/existence oracle, and the rejection happens BEFORE any
 *     dependent traversal (no material-mutation events, no data changes
 *     under PARALLEL probes);
 *   - a playbook of another Client in the SAME agency never leaks through
 *     Client-scoped routes (data-level boundary);
 *   - a playbook cannot be created under a Client of ANOTHER Agency (the
 *     foreign client yields the same 404 as an unknown client);
 *   - a playbook cannot be linked to a Goal of ANOTHER Client — the
 *     foreign goal yields the same 404 as an unknown goal (scope
 *     rejection before traversal, no oracle);
 *   - an Agency-scoped playbook of ANOTHER agency never lists under the
 *     foreign agency's listing routes;
 *   - forged authority headers, body fields and query parameters cannot
 *     elevate or change the canonical owner scope;
 *   - membership WITHOUT the required role is rejected server-side (403);
 *   - stale membership state (disabled/revoked) loses access immediately,
 *     derived from durable state — proven across an API process RESTART;
 *   - a deleted Client tombstone makes every playbook route a uniform 404
 *     (a Client-scoped Playbook can never resurrect tombstoned Client
 *     authority);
 *   - direct-database re-parenting of a Playbook across the Agency
 *     boundary is rejected by the immutability trigger; the Client scope
 *     and Goal link can never be reassigned nor pointed at another
 *     Agency's client / another Client's goal — the database backstops;
 *   - created_by provenance is never an authorization path;
 *   - anonymous calls never reach authorization.
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

interface User {
  readonly userId: string;
  readonly token: string;
}

async function makeUser(email: string, displayName: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  const cred = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  assert.equal(cred.status, 204);
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

async function addMembership(
  agencyId: string,
  user: User,
  role: string,
): Promise<{ membershipId: string; version: number }> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: user.userId, role },
  });
  assert.equal(response.status, 201, `add membership: ${JSON.stringify(response.body)}`);
  return {
    membershipId: response.body['membershipId'] as string,
    version: response.body['version'] as number,
  };
}

async function makeClient(agencyId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create client: ${JSON.stringify(response.body)}`);
  return response.body['clientId'] as string;
}

async function makeGoal(clientId: string, token: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: {
      objective: 'Isolation test goal',
      successCriteria: [{ metric: 'qualified_leads', comparator: '>=', targetValue: 10 }],
    },
  });
  assert.equal(response.status, 201, `create goal: ${JSON.stringify(response.body)}`);
  return response.body['goalId'] as string;
}

async function makeClientPlaybook(
  clientId: string,
  token: string,
  goalId?: string,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name: 'Isolation playbook', ...(goalId === undefined ? {} : { goalId }) },
  });
  assert.equal(response.status, 201, `create playbook: ${JSON.stringify(response.body)}`);
  return response.body['playbookId'] as string;
}

async function makeAgencyPlaybook(agencyId: string, token: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/playbooks`, {
    token,
    body: { name: 'Isolation agency playbook' },
  });
  assert.equal(response.status, 201, `create agency playbook: ${JSON.stringify(response.body)}`);
  return response.body['playbookId'] as string;
}

async function makeVersion(playbookId: string, token: string): Promise<string> {
  const response = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token,
    body: { strategy: { summary: 'Isolation strategy', templates: [] } },
  });
  assert.equal(response.status, 201, `create version: ${JSON.stringify(response.body)}`);
  return response.body['versionId'] as string;
}

const ownerA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let goalA1 = '';
let goalA2 = '';
let playbookA1 = '';
let playbookA2 = '';
let playbookB = '';
let agencyPlaybookA = '';
let agencyPlaybookB = '';

before(async () => {
  stack = await bootStack('playbookiso');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(ownerA, await makeUser('owner-a@playbooks.test', 'Agency A Owner', 'iso-agency-a-pass'));
  Object.assign(ownerB, await makeUser('owner-b@playbooks.test', 'Agency B Owner', 'iso-agency-b-pass'));
  agencyA = await makeAgency('Isolation Agency A', ownerA);
  agencyB = await makeAgency('Isolation Agency B', ownerB);
  clientA1 = await makeClient(agencyA, 'Isolation Client A1');
  clientA2 = await makeClient(agencyA, 'Isolation Client A2');
  clientB = await makeClient(agencyB, 'Isolation Client B');
  goalA1 = await makeGoal(clientA1, ownerA.token);
  goalA2 = await makeGoal(clientA2, ownerA.token);
  playbookA1 = await makeClientPlaybook(clientA1, ownerA.token, goalA1);
  playbookA2 = await makeClientPlaybook(clientA2, ownerA.token);
  playbookB = await makeClientPlaybook(clientB, ownerB.token);
  agencyPlaybookA = await makeAgencyPlaybook(agencyA, ownerA.token);
  agencyPlaybookB = await makeAgencyPlaybook(agencyB, ownerB.token);
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a foreign playbook identifier yields the SAME 404 as an unknown one — no traversal/existence oracle', async () => {
  const unknown = '00000000-0000-0000-0000-0000000000aa';
  for (const [label, playbookId] of [
    ['foreign client-scoped playbook', playbookB],
    ['foreign agency-scoped playbook', agencyPlaybookB],
    ['unknown playbook', unknown],
  ] as const) {
    const read = await apiCall(port(), `/api/playbooks/${playbookId}`, { token: ownerA.token });
    assert.equal(read.status, 404, `${label} read must be a uniform 404`);
    const context = await apiCall(port(), `/api/playbooks/${playbookId}/ownership-context`, {
      token: ownerA.token,
    });
    assert.equal(context.status, 404, `${label} ownership-context must be a uniform 404`);
    // The error payloads are SHAPE-equal (the message echoes the probed id
    // by design — no extra oracle surface).
    assert.deepEqual(
      Object.keys(read.body['error'] as Record<string, unknown>).sort(),
      Object.keys(context.body['error'] as Record<string, unknown>).sort(),
    );
  }

  // The same uniform 404 on the mutation surfaces (version routes under a
  // foreign playbook).
  const versionB = await makeVersion(playbookB, ownerB.token);
  const foreignVersion = await apiCall(
    port(),
    `/api/playbooks/${playbookB}/versions/${versionB}`,
    { token: ownerA.token },
  );
  assert.equal(foreignVersion.status, 404);
  const foreignCreate = await apiCall(port(), `/api/playbooks/${playbookB}/versions`, {
    token: ownerA.token,
    body: { strategy: { summary: 's', templates: [] } },
  });
  assert.equal(foreignCreate.status, 404, 'version creation under a foreign playbook is a uniform 404');
  const foreignStatus = await apiCall(
    port(),
    `/api/playbooks/${playbookB}/versions/${versionB}/status`,
    {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'review', version: 1 },
    },
  );
  assert.equal(foreignStatus.status, 404);
});

test('parallel foreign probes cause zero traversal side effects (no data changes, no material-mutation events)', async () => {
  const versionA = await makeVersion(playbookA1, ownerA.token);
  const probes = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/playbooks/${playbookB}`, { token: ownerA.token }),
    ),
  );
  for (const probe of probes) {
    assert.equal(probe.status, 404);
  }
  // Parallel mutation probes against the foreign playbook.
  const mutationProbes = await Promise.all([
    ...Array.from({ length: 4 }, () =>
      apiCall(port(), `/api/playbooks/${playbookB}/versions`, {
        token: ownerA.token,
        body: { strategy: { summary: 's', templates: [] } },
      }),
    ),
    ...Array.from({ length: 4 }, () =>
      apiCall(port(), `/api/playbooks/${playbookA1}/versions/${versionA}/status`, {
        token: ownerB.token,
        method: 'PATCH',
        body: { status: 'review', version: 1 },
      }),
    ),
  ]);
  for (const probe of mutationProbes) {
    assert.equal(probe.status, 404);
  }

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // No playbook row was created or mutated by the probes.
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM playbooks',
    );
    assert.equal(rows.rows[0]!.count, '5', 'exactly the 5 seeded playbooks exist');
    // No material-mutation events reference the foreign playbook.
    const events = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE target_id = $1`,
      [playbookB],
    );
    // agency B's own creation event exists — the probe itself created none.
    const probeEvents = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE target_id = $1 AND actor = $2`,
      [playbookB, `user:${ownerA.userId}`],
    );
    assert.equal(probeEvents.rows[0]!.count, '0', 'no probe emitted a material-mutation event');
    assert.ok(Number(events.rows[0]!.count) >= 1, 'the legitimate creation event still exists');
    // The version row of playbook A1 is untouched by agency B's probes.
    const status = await db.query<{ status: string; version: string }>(
      'SELECT status, version::text AS version FROM playbook_versions WHERE version_id = $1',
      [versionA],
    );
    assert.equal(status.rows[0]!.status, 'draft');
    assert.equal(status.rows[0]!.version, '1');
  } finally {
    await db.close();
  }
});

test('a playbook cannot be created under a Client of ANOTHER Agency (uniform 404, no oracle)', async () => {
  const unknownClient = '00000000-0000-0000-0000-0000000000bb';
  for (const [label, clientId] of [
    ['foreign client', clientB],
    ['unknown client', unknownClient],
  ] as const) {
    const response = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
      token: ownerA.token,
      body: { name: 'Cross-agency attempt' },
    });
    assert.equal(response.status, 404, `${label} must be a uniform 404`);
    const errorBody = response.body['error'] as Record<string, unknown>;
    assert.equal(errorBody['code'], 'NOT_FOUND');
  }
  // Agency-scoped creation under a foreign agency follows the /agencies
  // route convention (MKT-002): a non-member gets 403 — the AGENCY is the
  // commercial boundary, not the Client hard boundary (only Client-scoped
  // surfaces give the uniform 404).
  const foreignAgency = await apiCall(port(), `/api/agencies/${agencyB}/playbooks`, {
    token: ownerA.token,
    body: { name: 'Cross-agency attempt' },
  });
  assert.equal(foreignAgency.status, 403, 'agency routes reject non-members with 403');
  // The foreign agency's reusable IP never leaks to the non-member either.
  const foreignAgencyList = await apiCall(port(), `/api/agencies/${agencyB}/playbooks`, {
    token: ownerA.token,
  });
  assert.equal(foreignAgencyList.status, 403);
});

test('a playbook cannot be linked to a Goal of ANOTHER Client — foreign and unknown goals are indistinguishable', async () => {
  const unknownGoal = '00000000-0000-0000-0000-0000000000cc';
  for (const [label, goalId] of [
    ['goal of another client in the same agency', goalA2],
    ['goal of another agency client', await makeGoal(clientB, ownerB.token)],
    ['unknown goal', unknownGoal],
  ] as const) {
    const response = await apiCall(port(), `/api/clients/${clientA1}/playbooks`, {
      token: ownerA.token,
      body: { name: 'Bad link attempt', goalId },
    });
    assert.equal(response.status, 404, `${label} must be a uniform 404`);
    const errorBody = response.body['error'] as Record<string, unknown>;
    assert.equal(errorBody['code'], 'NOT_FOUND');
  }
});

test('listing surfaces never leak foreign playbooks (data-level boundaries)', async () => {
  // Agency A's client listing never shows agency B's playbooks.
  const listA1 = await apiCall(port(), `/api/clients/${clientA1}/playbooks`, { token: ownerA.token });
  assert.equal(listA1.status, 200);
  const a1Playbooks = listA1.body['playbooks'] as Record<string, unknown>[];
  for (const playbook of a1Playbooks) {
    assert.equal(playbook['clientId'], clientA1);
  }
  assert.ok(!a1Playbooks.some((entry) => entry['playbookId'] === playbookB));
  assert.ok(!a1Playbooks.some((entry) => entry['playbookId'] === playbookA2), 'the OTHER client of the same agency stays separate');

  // Agency A's agency-scoped listing never shows agency B's reusable IP.
  const agencyList = await apiCall(port(), `/api/agencies/${agencyA}/playbooks`, {
    token: ownerA.token,
  });
  assert.equal(agencyList.status, 200);
  const reusable = agencyList.body['playbooks'] as Record<string, unknown>[];
  assert.ok(reusable.some((entry) => entry['playbookId'] === agencyPlaybookA));
  assert.ok(!reusable.some((entry) => entry['playbookId'] === agencyPlaybookB));
  assert.ok(!reusable.some((entry) => entry['playbookId'] === playbookA1), 'client-scoped playbooks never list as agency IP');

  // A foreign caller cannot even list: agency B's owner on agency A's
  // AGENCY-scoped route gets the /agencies-convention 403 (commercial
  // boundary), while the CLIENT-scoped route gives the uniform 404 (hard
  // boundary — no membership in the owning agency).
  const foreignList = await apiCall(port(), `/api/agencies/${agencyA}/playbooks`, {
    token: ownerB.token,
  });
  assert.equal(foreignList.status, 403);
  const foreignClientList = await apiCall(port(), `/api/clients/${clientA1}/playbooks`, {
    token: ownerB.token,
  });
  assert.equal(foreignClientList.status, 404);
});

test('forged authority headers, body fields and query parameters cannot change the canonical owner scope', async () => {
  // Forged body fields are rejected as authority fields (422) — they never
  // reach the module.
  const forged = await apiCall(port(), `/api/clients/${clientA1}/playbooks`, {
    token: ownerA.token,
    body: { name: 'Forged', agencyId: agencyB, clientId: clientB },
  });
  assert.equal(forged.status, 422, 'forged scope fields are rejected before execution');

  // Forged headers never influence authorization.
  const headerProbe = await apiCall(port(), `/api/playbooks/${playbookA1}`, {
    token: ownerA.token,
    headers: { 'x-agency-id': agencyB, 'x-client-id': clientB, 'x-tenant': 'other' },
  });
  assert.equal(headerProbe.status, 200);
  assert.equal(headerProbe.body['agencyId'], agencyA, 'scope comes from durable state, not headers');
  assert.equal(headerProbe.body['clientId'], clientA1);

  // Forged query parameters are inert.
  const queryProbe = await apiCall(port(), `/api/playbooks/${playbookA1}?agencyId=${agencyB}`, {
    token: ownerA.token,
  });
  assert.equal(queryProbe.status, 200);
  assert.equal(queryProbe.body['agencyId'], agencyA);
});

test('membership without the required role is rejected server-side (403)', async () => {
  const operatorA: User = await makeUser('operator-a@playbooks.test', 'A Operator', 'iso-operator-pass');
  await addMembership(agencyA, operatorA, 'agency_operator');

  // Reads pass (active member of the owning agency).
  const read = await apiCall(port(), `/api/playbooks/${playbookA1}`, { token: operatorA.token });
  assert.equal(read.status, 200);

  // Writes are role-gated.
  const create = await apiCall(port(), `/api/playbooks/${playbookA1}/versions`, {
    token: operatorA.token,
    body: { strategy: { summary: 's', templates: [] } },
  });
  assert.equal(create.status, 403);
  const profile = await apiCall(port(), `/api/playbooks/${playbookA1}/profile`, {
    token: operatorA.token,
    method: 'PATCH',
    body: { name: 'Nope', version: 1 },
  });
  assert.equal(profile.status, 403);
});

test('stale membership loses access immediately, derived from durable state — proven across an API process RESTART', async () => {
  const staleUser: User = await makeUser('stale@playbooks.test', 'Stale Member', 'iso-stale-pass');
  const membership = await addMembership(agencyA, staleUser, 'agency_operator');

  const before = await apiCall(port(), `/api/playbooks/${playbookA1}`, {
    token: staleUser.token,
  });
  assert.equal(before.status, 200, 'active member can read');

  // Suspend the membership (CAS on the membership route).
  const suspend = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${membership.membershipId}`,
    {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'disabled', version: membership.version },
    },
  );
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));

  // Access is lost immediately.
  const denied = await apiCall(port(), `/api/playbooks/${playbookA1}`, {
    token: staleUser.token,
  });
  assert.equal(denied.status, 403, 'suspended membership never authorizes');

  // Proven across a RESTART: a fresh process derives the same denial from
  // durable state — no process-local authority.
  api!.child.kill('SIGKILL');
  api = await spawnApi(stack!.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  const deniedAfterRestart = await apiCall(port(), `/api/playbooks/${playbookA1}`, {
    token: staleUser.token,
  });
  assert.equal(deniedAfterRestart.status, 403, 'denial survives the restart');

  // Re-enabling restores access (durable state, not a cache).
  const resume = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${membership.membershipId}`,
    {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'active', version: suspend.body['version'] as number },
    },
  );
  assert.equal(resume.status, 200);
  const restored = await apiCall(port(), `/api/playbooks/${playbookA1}`, {
    token: staleUser.token,
  });
  assert.equal(restored.status, 200);
});

test('a deleted Client tombstone makes every playbook route a uniform 404', async () => {
  const tombstoneClient = await makeClient(agencyA, 'Tombstone Playbooks Client');
  const goalInClient = await makeGoal(tombstoneClient, ownerA.token);
  const playbook = await makeClientPlaybook(tombstoneClient, ownerA.token, goalInClient);
  const version = await makeVersion(playbook, ownerA.token);

  const del = await apiCall(port(), `/api/clients/${tombstoneClient}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  // Every playbook-scoped surface becomes a uniform 404.
  for (const [label, request] of [
    ['read', apiCall(port(), `/api/playbooks/${playbook}`, { token: ownerA.token })],
    [
      'ownership-context',
      apiCall(port(), `/api/playbooks/${playbook}/ownership-context`, { token: ownerA.token }),
    ],
    [
      'version read',
      apiCall(port(), `/api/playbooks/${playbook}/versions/${version}`, { token: ownerA.token }),
    ],
    [
      'version list',
      apiCall(port(), `/api/playbooks/${playbook}/versions`, { token: ownerA.token }),
    ],
    [
      'version create',
      apiCall(port(), `/api/playbooks/${playbook}/versions`, {
        token: ownerA.token,
        body: { strategy: { summary: 's', templates: [] } },
      }),
    ],
  ] as const) {
    const response = await request;
    assert.equal(response.status, 404, `${label} must be a uniform 404 after the client tombstone`);
  }
});

test('direct-database re-parenting is rejected: Agency ownership, Client scope and Goal link are immutable and scope-fenced', async () => {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // An Agency-scoped playbook cannot cross the Agency boundary — the
    // identity trigger rejects the agency change directly.
    await assert.rejects(
      () => db.query('UPDATE playbooks SET agency_id = $1 WHERE playbook_id = $2', [agencyB, agencyPlaybookA]),
      /cannot change Agency ownership/,
    );
    // A Client-scoped playbook cannot cross the Agency boundary either —
    // the client-within-agency scope backstop fires first (the client no
    // longer belongs to the new agency); whichever trigger fires, the
    // boundary holds.
    await assert.rejects(
      () => db.query('UPDATE playbooks SET agency_id = $1 WHERE playbook_id = $2', [agencyB, playbookA1]),
      /does not belong to agency|cannot change Agency ownership/,
    );
    // The Client scope can never migrate (including NULL ⇄ set). On an
    // UNLINKED playbook the identity trigger rejects it directly…
    await assert.rejects(
      () => db.query('UPDATE playbooks SET client_id = $1 WHERE playbook_id = $2', [clientA1, playbookA2]),
      /Client scope is immutable/,
    );
    await assert.rejects(
      () => db.query('UPDATE playbooks SET client_id = NULL WHERE playbook_id = $1', [playbookA2]),
      /Client scope is immutable/,
    );
    // …on a GOAL-LINKED playbook the goal-within-client scope backstop
    // fires first (the linked goal would no longer belong to the migrated
    // client); whichever trigger fires, the scope can never move.
    await assert.rejects(
      () => db.query('UPDATE playbooks SET client_id = $1 WHERE playbook_id = $2', [clientA2, playbookA1]),
      /Client scope is immutable|does not belong to client|requires Client scope/,
    );
    await assert.rejects(
      () => db.query('UPDATE playbooks SET client_id = NULL WHERE playbook_id = $1', [playbookA1]),
      /Client scope is immutable|requires Client scope/,
    );
    // The Goal link can never be re-pointed — the goal-within-client scope
    // backstop fires first for a foreign goal; whichever trigger fires,
    // the link can never move.
    await assert.rejects(
      () => db.query('UPDATE playbooks SET goal_id = $1 WHERE playbook_id = $2', [goalA2, playbookA1]),
      /Goal link is immutable|does not belong to client/,
    );
    // Provenance is immutable.
    await assert.rejects(
      () =>
        db.query('UPDATE playbooks SET created_by = $1 WHERE playbook_id = $2', [
          ownerB.userId,
          playbookA1,
        ]),
      /provenance is immutable/,
    );
    // Identity is immutable.
    await assert.rejects(
      () =>
        db.query('UPDATE playbooks SET playbook_id = $1 WHERE playbook_id = $2', [
          '00000000-0000-0000-0000-000000001001',
          playbookA1,
        ]),
      /playbook_id .* is immutable/,
    );

    // Scope backstops fire on INSERT too: a cross-agency client is
    // rejected, and a cross-client goal is rejected.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO playbooks (playbook_id, agency_id, client_id, name)
           VALUES ($1, $2, $3, 'Backstop probe')`,
          ['00000000-0000-0000-0000-000000001002', agencyA, clientB],
        ),
      /does not belong to agency/,
    );
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO playbooks (playbook_id, agency_id, client_id, goal_id, name)
           VALUES ($1, $2, $3, $4, 'Backstop probe')`,
          ['00000000-0000-0000-0000-000000001003', agencyA, clientA1, goalA2],
        ),
      /does not belong to client/,
    );
    // An agency-scoped playbook cannot carry a goal link at all.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO playbooks (playbook_id, agency_id, goal_id, name)
           VALUES ($1, $2, $3, 'Backstop probe')`,
          ['00000000-0000-0000-0000-000000001004', agencyA, goalA1],
        ),
      /requires Client scope/,
    );

    // Version identity: the explicit reference can never be reassigned.
    const version = await makeVersion(playbookA1, ownerA.token);
    await assert.rejects(
      () =>
        db.query('UPDATE playbook_versions SET playbook_id = $1 WHERE version_id = $2', [
          playbookA2,
          version,
        ]),
      /cannot change playbook ownership/,
    );
    await assert.rejects(
      () =>
        db.query('UPDATE playbook_versions SET version_number = 99 WHERE version_id = $1', [
          version,
        ]),
      /number .* is immutable/,
    );
    // The UNIQUE fence: duplicating a version number within a playbook is
    // rejected by the database itself.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO playbook_versions (version_id, playbook_id, version_number, strategy, deployment_metadata)
           VALUES ($1, $2, 1, '{"summary":"dup","templates":[]}', '{}'::jsonb)`,
          ['00000000-0000-0000-0000-000000001005', playbookA1],
        ),
      /playbook_versions_number_unique/,
    );
  } finally {
    await db.close();
  }
});

test('created_by provenance is never an authorization path', async () => {
  // ownerA created playbookA1. A user with NO membership reading it gets a
  // 404 — knowing (or even being) the creator changes nothing.
  const outsider: User = await makeUser('outsider@playbooks.test', 'Outsider', 'iso-outsider-pass');
  const read = await apiCall(port(), `/api/playbooks/${playbookA1}`, { token: outsider.token });
  assert.equal(read.status, 404, 'provenance knowledge is not access');

  // Even with the creator id forged into the request, authorization
  // derives from membership state only.
  const forged = await apiCall(port(), `/api/playbooks/${playbookA1}?createdBy=${ownerA.userId}`, {
    token: outsider.token,
  });
  assert.equal(forged.status, 404);
});

test('anonymous calls never reach authorization', async () => {
  for (const path of [
    `/api/playbooks/${playbookA1}`,
    `/api/playbooks/${playbookA1}/versions`,
    `/api/agencies/${agencyA}/playbooks`,
    `/api/clients/${clientA1}/playbooks`,
  ]) {
    const response = await apiCall(port(), path);
    assert.equal(response.status, 401, `${path} requires authentication`);
  }
});
