/**
 * MKT-006 security/isolation integration test — the Goal domain inside the
 * Client hard boundary (real PostgreSQL + real API subprocess).
 *
 * Proofs (GOAL-AC-02 "goal cannot silently execute outside authorized
 * Client scope — authorization test"):
 *   - a foreign Goal identifier (owned by a Client of ANOTHER Agency)
 *     yields the SAME 404 as an unknown one — no traversal/existence
 *     oracle, and the rejection happens BEFORE any dependent traversal (no
 *     material-mutation events, no data changes under parallel probes);
 *   - a Goal of another Client in the SAME agency never leaks through
 *     Client-scoped routes (data-level Client boundary);
 *   - a Goal cannot be created scoped to a Workspace of ANOTHER Client —
 *     the foreign workspace yields the same 404 as an unknown workspace
 *     (scope rejection before traversal, no oracle);
 *   - forged authority headers, body fields and query parameters cannot
 *     elevate or change the canonical owner scope;
 *   - membership WITHOUT the required role is rejected server-side (403);
 *   - stale membership state (disabled/revoked) loses access immediately,
 *     derived from durable state — proven across an API process RESTART;
 *   - a deleted Client tombstone makes every goal route a uniform 404 (a
 *     Goal can never resurrect tombstoned Client authority);
 *   - direct-database re-parenting of a Goal across the Client boundary is
 *     rejected by the immutability trigger, and the Workspace scope can
 *     never be reassigned nor pointed at another Client's workspace — the
 *     database backstop (GOAL-AC-02 at the storage layer);
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

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

async function addMembership(agencyId: string, user: User, role: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: user.userId, role },
  });
  assert.equal(response.status, 201, `add membership: ${JSON.stringify(response.body)}`);
  return response.body['membershipId'] as string;
}

async function makeClient(agencyId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create client: ${JSON.stringify(response.body)}`);
  return response.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create workspace: ${JSON.stringify(response.body)}`);
  return response.body['workspaceId'] as string;
}

function goalBody(): Record<string, unknown> {
  return {
    objective: 'Grow qualified pipeline',
    successCriteria: [
      { metric: 'qualified_leads', comparator: '>=', targetValue: 100, unit: 'count' },
    ],
  };
}

async function makeGoal(clientId: string, token: string, workspaceId?: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: { ...goalBody(), ...(workspaceId === undefined ? {} : { workspaceId }) },
  });
  assert.equal(response.status, 201, `create goal: ${JSON.stringify(response.body)}`);
  return response.body['goalId'] as string;
}

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-platform-roles': '["platform_administrator"]',
  'x-role': 'agency_owner',
  'x-agency-role': 'agency_admin',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-workspace-id': 'REPLACED_PER_TEST',
  'x-goal-id': 'REPLACED_PER_TEST',
  'x-user-id': 'REPLACED_PER_TEST',
  'x-memberships': '[{"role":"agency_owner"}]',
} as Record<string, string>;

// Shared fixtures: agency A with members (two clients), agency B foreign.
const ownerA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceB = '';
let goalA1 = '';
let goalA2 = '';
let goalB = '';

before(async () => {
  stack = await bootStack('goaliso');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  const admin = await adminToken();
  const createUser = async (email: string, name: string): Promise<User> => {
    const create = await apiCall(port(), '/api/users', { token: admin, body: { email, displayName: name } });
    assert.equal(create.status, 201);
    const userId = create.body['userId'] as string;
    await apiCall(port(), `/api/users/${userId}/credential`, {
      token: admin,
      body: { password: 'iso-password-123' },
    });
    const login = await apiCall(port(), '/api/auth/login', {
      body: { email, password: 'iso-password-123' },
    });
    assert.equal(login.status, 200);
    return { userId, token: login.body['token'] as string };
  };

  Object.assign(ownerA, await createUser('owner-a@goaliso.test', 'Agency A Owner'));
  Object.assign(collaboratorA, await createUser('collab-a@goaliso.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@goaliso.test', 'Agency B Owner'));

  agencyA = await makeAgency('Goal Isolation Agency A', ownerA);
  agencyB = await makeAgency('Goal Isolation Agency B', ownerB);
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  // Two clients under agency A (intra-agency boundary) + one under agency B.
  clientA1 = await makeClient(agencyA, 'Client A One');
  clientA2 = await makeClient(agencyA, 'Client A Two');
  clientB = await makeClient(agencyB, 'Client B One');

  workspaceA1 = await makeWorkspace(clientA1, 'Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Workspace B');

  goalA1 = await makeGoal(clientA1, ownerA.token);
  goalA2 = await makeGoal(clientA2, ownerA.token);
  goalB = await makeGoal(clientB, ownerB.token, workspaceB);
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a foreign Goal identifier yields the SAME 404 as an unknown one — no existence oracle (GOAL-AC-02)', async () => {
  const unknownId = '00000000-0000-0000-0000-0000000000aa';

  for (const [description, pathName, method, body] of [
    ['foreign read', `/api/goals/${goalB}`, 'GET', undefined],
    ['foreign profile', `/api/goals/${goalB}/profile`, 'PATCH', { ...goalBody(), version: 1 }],
    ['foreign lifecycle', `/api/goals/${goalB}/status`, 'PATCH', { status: 'active', version: 1 }],
    ['foreign ownership-context', `/api/goals/${goalB}/ownership-context`, 'GET', undefined],
    ['unknown read', `/api/goals/${unknownId}`, 'GET', undefined],
    ['unknown profile', `/api/goals/${unknownId}/profile`, 'PATCH', { ...goalBody(), version: 1 }],
    ['unknown lifecycle', `/api/goals/${unknownId}/status`, 'PATCH', { status: 'active', version: 1 }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: ownerA.token,
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 404, `${description} must be a hard-boundary 404`);
    const errorBody = response.body['error'] as Record<string, unknown>;
    assert.equal(errorBody['code'], 'NOT_FOUND', `${description}: uniform NOT_FOUND code`);
  }

  // Byte-identical error SHAPE for foreign vs unknown: same code, same
  // message format — the only variable is the caller's own supplied id. No
  // owning client/agency/workspace or other tenant information ever leaks.
  const foreign = await apiCall(port(), `/api/goals/${goalB}`, { token: ownerA.token });
  const unknown = await apiCall(port(), '/api/goals/00000000-0000-0000-0000-0000000000bb', {
    token: ownerA.token,
  });
  const foreignError = foreign.body['error'] as Record<string, unknown>;
  const unknownError = unknown.body['error'] as Record<string, unknown>;
  assert.equal(foreignError['code'], unknownError['code']);
  assert.equal(foreignError['message'], `goal not found: ${goalB}`);
  assert.equal(unknownError['message'], 'goal not found: 00000000-0000-0000-0000-0000000000bb');
  for (const secret of [agencyB, clientB, workspaceB]) {
    assert.equal(
      JSON.stringify(foreignError).includes(secret),
      false,
      'the owning agency/client/workspace ids must never leak through the boundary',
    );
  }

  // The same uniform 404 holds for goal creation under a foreign CLIENT
  // identifier (ownership from the PATH resolves through /clients first).
  const foreignCreate = await apiCall(port(), `/api/clients/${clientB}/goals`, {
    token: ownerA.token,
    body: goalBody(),
  });
  assert.equal(foreignCreate.status, 404, 'foreign client on the create path → uniform 404');
  const unknownCreate = await apiCall(
    port(),
    '/api/clients/00000000-0000-0000-0000-0000000000cc/goals',
    { token: ownerA.token, body: goalBody() },
  );
  assert.equal(unknownCreate.status, 404);
});

test('foreign Goal identifiers cause NO traversal/read side effects (rejection before dependent traversal)', async () => {
  const eventsBefore = api!.logRecords().filter((record) =>
    record.event.startsWith('goals.goal.'),
  ).length;
  const objectiveBefore = await (async () => {
    const read = await apiCall(port(), `/api/goals/${goalB}`, { token: ownerB.token });
    assert.equal(read.status, 200);
    return read.body['objective'] as string;
  })();

  // Foreign traversal attempts against agency B's goal by agency A's
  // owner — in PARALLEL.
  await Promise.all([
    apiCall(port(), `/api/goals/${goalB}`, { token: ownerA.token }),
    apiCall(port(), `/api/goals/${goalB}/profile`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { ...goalBody(), version: 1 },
    }),
    apiCall(port(), `/api/goals/${goalB}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'active', version: 1 },
    }),
    apiCall(port(), `/api/goals/${goalB}/ownership-context`, { token: ownerA.token }),
    apiCall(port(), `/api/clients/${clientB}/goals`, {
      token: ownerA.token,
      body: goalBody(),
    }),
  ]);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const newEvents = api!
    .logRecords()
    .filter((record) => record.event.startsWith('goals.goal.'))
    .slice(eventsBefore);
  assert.equal(
    newEvents.length,
    0,
    'foreign attempts must not emit material-mutation records (no traversal)',
  );

  // The foreign goal's durable state is untouched.
  const readAfter = await apiCall(port(), `/api/goals/${goalB}`, { token: ownerB.token });
  assert.equal(readAfter.status, 200);
  assert.equal(readAfter.body['objective'], objectiveBefore, 'no data change through foreign identifiers');
  assert.equal(readAfter.body['version'], 1, 'no version churn through foreign identifiers');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM goals WHERE client_id = $1',
      [clientB],
    );
    assert.equal(count.rows[0]!.count, '1', 'no goal was created under the foreign client');
  } finally {
    await db.close();
  }
});

test('a Goal cannot be scoped to a Workspace of ANOTHER Client — uniform 404, no oracle (GOAL-AC-02 scope proof)', async () => {
  // Agency A's owner attempts to create a goal under client A1 but scoped
  // to agency B's workspace. The foreign workspace must yield the SAME 404
  // as an unknown workspace — indistinguishable (no existence oracle).
  const unknownWorkspace = '00000000-0000-0000-0000-0000000000dd';
  for (const [label, workspaceId] of [
    ['foreign workspace', workspaceB],
    ['unknown workspace', unknownWorkspace],
  ] as const) {
    const response = await apiCall(port(), `/api/clients/${clientA1}/goals`, {
      token: ownerA.token,
      body: { ...goalBody(), workspaceId },
    });
    assert.equal(response.status, 404, `${label} scope must be a uniform 404`);
    const errorBody = response.body['error'] as Record<string, unknown>;
    assert.equal(errorBody['code'], 'NOT_FOUND');
    assert.equal(errorBody['message'], `workspace not found: ${workspaceId}`);
  }

  // Nothing was persisted — no goal row, no orphan scope.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM goals WHERE workspace_id = $1',
      [workspaceB],
    );
    assert.equal(rows.rows[0]!.count, '1', 'exactly the original client B goal touches workspace B');
  } finally {
    await db.close();
  }
});

test('goals never cross the Client boundary even inside one Agency (data-level Client boundary)', async () => {
  // Client A1's list shows ONLY its own goals — never A2's.
  const listA1 = await apiCall(port(), `/api/clients/${clientA1}/goals`, {
    token: ownerA.token,
  });
  assert.equal(listA1.status, 200);
  const idsA1 = (listA1.body['goals'] as Record<string, unknown>[]).map((goal) => goal['goalId']);
  assert.deepEqual(idsA1, [goalA1], 'client A1 list shows exactly its own goal');

  // The canonical ownership context of A2's goal derives from the goal's
  // OWN client row — never from the caller or the route.
  const contextA2 = await apiCall(port(), `/api/goals/${goalA2}/ownership-context`, {
    token: ownerA.token,
  });
  assert.equal(contextA2.status, 200, 'same-agency member may address the goal by id');
  const scope = contextA2.body['scope'] as Record<string, unknown>;
  assert.equal(scope['clientId'], clientA2, 'scope derives from the goal ROW ownership');
  assert.equal(scope['agencyId'], agencyA);

  // Workspace-scoped goals of client B never leak their scope into A's
  // reads: A's owner gets 404 on B's workspace-scoped goal (probed above)
  // and B's workspace itself is 404 for A's members.
  const workspaceLeak = await apiCall(port(), `/api/workspaces/${workspaceB}`, {
    token: ownerA.token,
  });
  assert.equal(workspaceLeak.status, 404);
});

test('forged authority headers cannot elevate or change the canonical owner scope', async () => {
  const headers = {
    ...FORGED_HEADERS,
    'x-agency-id': agencyA,
    'x-client-id': clientA1,
    'x-workspace-id': workspaceA1,
    'x-goal-id': goalA1,
    'x-user-id': ownerA.userId,
  };

  // Agency B's owner claims to be agency A's owner via headers: still 404 on
  // A's goal, 404 on A-scoped creation.
  const read = await apiCall(port(), `/api/goals/${goalA1}`, {
    token: ownerB.token,
    headers,
  });
  assert.equal(read.status, 404, 'forged headers cannot cross the boundary');

  const create = await apiCall(port(), `/api/clients/${clientA1}/goals`, {
    token: ownerB.token,
    headers,
    body: goalBody(),
  });
  assert.equal(create.status, 404, 'forged headers cannot grant client ownership');

  // Agency A's low-privilege collaborator claims platform/owner roles.
  const promote = await apiCall(port(), `/api/clients/${clientA1}/goals`, {
    token: collaboratorA.token,
    headers,
    body: goalBody(),
  });
  assert.equal(promote.status, 403, 'forged headers cannot elevate agency role');

  const mutate = await apiCall(port(), `/api/goals/${goalA1}/status`, {
    token: collaboratorA.token,
    headers,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(mutate.status, 403, 'forged headers cannot elevate for lifecycle ops');

  // Forged headers do not change the canonical context either.
  const context = await apiCall(port(), `/api/goals/${goalA1}/ownership-context`, {
    token: collaboratorA.token,
    headers,
  });
  assert.equal(context.status, 200);
  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['agencyId'], agencyA, 'scope derives from durable ownership only');
  assert.equal(scope['clientId'], clientA1);
  assert.equal(scope['goalId'], goalA1);
});

test('forged body authority fields are rejected with 422, never trusted', async () => {
  // Client ownership cannot be smuggled through the body on create.
  for (const body of [
    { ...goalBody(), clientId: clientB },
    { ...goalBody(), agencyId: agencyB },
    { ...goalBody(), goalId: goalB },
    { ...goalBody(), tenantId: agencyB },
    { ...goalBody(), ownerId: ownerB.userId },
    { ...goalBody(), createdBy: ownerB.userId },
    { ...goalBody(), status: 'active' },
    { ...goalBody(), version: 9 },
  ]) {
    const response = await apiCall(port(), `/api/clients/${clientA1}/goals`, {
      token: ownerA.token,
      body,
    });
    assert.equal(response.status, 422, `smuggled authority field rejected: ${JSON.stringify(body)}`);
  }
  // ...nor on lifecycle/content mutations.
  for (const [pathName, body] of [
    [`/api/goals/${goalA1}/profile`, { ...goalBody(), version: 1, clientId: clientB }],
    [`/api/goals/${goalA1}/profile`, { ...goalBody(), version: 1, workspaceId: workspaceB }],
    [`/api/goals/${goalA1}/status`, { status: 'active', version: 1, workspaceId: workspaceB }],
    [`/api/goals/${goalA1}/status`, { status: 'active', version: 1, clientId: clientB }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: ownerA.token,
      method: 'PATCH',
      body: body as unknown as Record<string, unknown>,
    });
    assert.equal(response.status, 422, `authority field rejected on ${pathName}`);
  }
});

test('forged query identifiers never change the list scope', async () => {
  const response = await apiCall(
    port(),
    `/api/clients/${clientA1}/goals?goalId=${goalB}&clientId=${clientB}&agencyId=${agencyB}&workspaceId=${workspaceB}`,
    { token: ownerA.token },
  );
  assert.equal(response.status, 200);
  const goals = response.body['goals'] as Record<string, unknown>[];
  assert.deepEqual(
    goals.map((goal) => goal['goalId']),
    [goalA1],
    'query-string identifiers cannot widen the scope',
  );
  assert.equal(response.body['clientId'], clientA1);
});

test('membership without the required role is rejected server-side', async () => {
  // Collaborator of agency A: reads fine, mutations forbidden.
  const read = await apiCall(port(), `/api/goals/${goalA1}`, { token: collaboratorA.token });
  assert.equal(read.status, 200);

  const create = await apiCall(port(), `/api/clients/${clientA1}/goals`, {
    token: collaboratorA.token,
    body: goalBody(),
  });
  assert.equal(create.status, 403, `create forbidden for ${collaboratorA.userId}`);

  const profile = await apiCall(port(), `/api/goals/${goalA1}/profile`, {
    token: collaboratorA.token,
    method: 'PATCH',
    body: { ...goalBody(), version: 1 },
  });
  assert.equal(profile.status, 403);

  const status = await apiCall(port(), `/api/goals/${goalA1}/status`, {
    token: collaboratorA.token,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(status.status, 403);

  // An agency_owner of agency A cannot manage B's client goals
  // (cross-tenant create path).
  const foreignCreate = await apiCall(port(), `/api/clients/${clientB}/goals`, {
    token: ownerA.token,
    body: goalBody(),
  });
  assert.equal(foreignCreate.status, 404, 'cross-agency create via foreign client → 404');
});

test('stale membership state cannot bypass authorization (immediate, durable, restart-proof)', async () => {
  const admin = await adminToken();

  // Disable the collaborator's membership → suspended insider: 403, not 200.
  const memberships = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: admin,
  });
  const membership = (memberships.body['memberships'] as Record<string, unknown>[]).find(
    (entry) => entry['userId'] === collaboratorA.userId,
  )!;
  const disabled = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${membership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'disabled', version: membership['version'] as number },
    },
  );
  assert.equal(disabled.status, 200);
  const readSuspended = await apiCall(port(), `/api/goals/${goalA1}`, {
    token: collaboratorA.token,
  });
  assert.equal(readSuspended.status, 403, 'disabled membership never authorizes');

  // Re-enable, then REVOKE: revoked is terminal — the user is no longer a
  // member of the owning agency → hard-boundary 404.
  const reenabled = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${membership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'active', version: disabled.body['version'] as number },
    },
  );
  assert.equal(reenabled.status, 200);
  const revoked = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${membership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'revoked', version: reenabled.body['version'] as number },
    },
  );
  assert.equal(revoked.status, 200);

  const readRevoked = await apiCall(port(), `/api/goals/${goalA1}`, {
    token: collaboratorA.token,
  });
  assert.equal(readRevoked.status, 404, 'revoked membership → no owning-agency membership → 404');

  // RESTART the API process: authorization still derives from durable state.
  api!.child.kill('SIGKILL');
  api = await spawnApi(stack!.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  adminTokenCache = null;
  const readAfterRestart = await apiCall(port(), `/api/goals/${goalA1}`, {
    token: collaboratorA.token,
  });
  assert.equal(readAfterRestart.status, 404, 'denial survives process restart (durable state)');

  // Re-adding the member restores access through a NEW membership identity.
  await addMembership(agencyA, collaboratorA, 'client_collaborator');
  const readReadded = await apiCall(port(), `/api/goals/${goalA1}`, {
    token: collaboratorA.token,
  });
  assert.equal(readReadded.status, 200, 're-added membership restores access immediately');
});

test('a deleted Client tombstone makes every goal route a uniform 404 — no resurrection', async () => {
  // Fresh client + goal owned by agency B.
  const client = await makeClient(agencyB, 'Doomed Goals Client');
  const goal = await makeGoal(client, ownerB.token);

  // Tombstone the CLIENT.
  const del = await apiCall(port(), `/api/clients/${client}/status`, {
    token: ownerB.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(del.status, 200);

  // Every goal route now 404s: the client tombstone never resolves, so its
  // goal identifiers cannot resurrect access.
  for (const [pathName, method, body] of [
    [`/api/goals/${goal}`, 'GET', undefined],
    [`/api/goals/${goal}/ownership-context`, 'GET', undefined],
    [`/api/goals/${goal}/profile`, 'PATCH', { ...goalBody(), version: 1 }],
    [`/api/goals/${goal}/status`, 'PATCH', { status: 'active', version: 1 }],
    [`/api/clients/${client}/goals`, 'GET', undefined],
    [`/api/clients/${client}/goals`, 'POST', goalBody()],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: ownerB.token,
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 404, `${method} ${pathName} must be 404 under a tombstoned client`);
  }
});

test('a Goal can never be re-parented across the Client boundary — DB backstop (GOAL-AC-02 storage proof)', async () => {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Cross-AGENCY and cross-CLIENT (same agency) re-parenting are both
    // rejected by the immutability trigger.
    await assert.rejects(
      () => db.query('UPDATE goals SET client_id = $1 WHERE goal_id = $2', [clientB, goalA2]),
      /cannot change Client ownership/,
      'cross-agency re-parenting must be rejected',
    );
    await assert.rejects(
      () => db.query('UPDATE goals SET client_id = $1 WHERE goal_id = $2', [clientA1, goalA2]),
      /cannot change Client ownership/,
      'intra-agency cross-client re-parenting must be rejected',
    );
    // Identity can never be reassigned.
    await assert.rejects(
      () =>
        db.query('UPDATE goals SET goal_id = $1 WHERE goal_id = $2', [
          '00000000-0000-0000-0000-0000000000ee',
          goalA2,
        ]),
      /goal_id .* is immutable/,
      'goal identity must be immutable',
    );
    // Workspace scope can never be reassigned (once set — including moves
    // WITHIN the same client and NULL → set: scope is durable identity).
    await assert.rejects(
      () =>
        db.query('UPDATE goals SET workspace_id = $1 WHERE goal_id = $2', [
          workspaceA1,
          goalB,
        ]),
      /Workspace scope is immutable once set/,
      'workspace scope must be immutable once set',
    );
    await assert.rejects(
      () =>
        db.query('UPDATE goals SET workspace_id = $1 WHERE goal_id = $2', [
          workspaceA1,
          goalA2,
        ]),
      /Workspace scope is immutable once set/,
      'attaching a scope to an unscoped goal must be rejected too',
    );
    // A workspace of ANOTHER client can never be attached through the
    // storage layer — the scope backstop fires on direct INSERT (the
    // UPDATE path is already fenced by scope immutability above).
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO goals (goal_id, client_id, workspace_id, objective, success_criteria)
           VALUES ($1, $2, $3, 'Smuggled scope', '[{"metric":"x","comparator":">=","targetValue":1}]'::jsonb)`,
          ['00000000-0000-0000-0000-0000000000ff', clientA1, workspaceB],
        ),
      /does not belong to client/,
      'cross-client workspace attachment must be rejected by the scope trigger',
    );
    // Provenance can never be rewritten.
    await assert.rejects(
      () =>
        db.query('UPDATE goals SET created_by = $1 WHERE goal_id = $2', [
          '00000000-0000-0000-0000-0000000000ef',
          goalA2,
        ]),
      /provenance is immutable/,
      'provenance must be immutable',
    );

    // Legitimate mutable fields still work (the triggers do not over-block).
    const ok = await db.query<{ objective: string }>(
      "UPDATE goals SET objective = 'Renamed Legitimately', version = version + 1 WHERE goal_id = $1 RETURNING objective",
      [goalA2],
    );
    assert.equal(ok.rows[0]!.objective, 'Renamed Legitimately');
  } finally {
    await db.close();
  }
});

test('created_by provenance is never an authorization path', async () => {
  // The collaborator is NOT the creator of A1's goal but IS a member: reads
  // succeed on MEMBERSHIP, not on provenance.
  const read = await apiCall(port(), `/api/goals/${goalA1}`, { token: collaboratorA.token });
  assert.equal(read.status, 200);

  // Agency B's owner cannot read A1's goal even though a (hypothetical)
  // shared creator id could be claimed — provenance carries no authority.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Point A1's goal provenance at owner B — the trigger rejects even this
    // durable-state attempt; and regardless, authorization NEVER consults
    // created_by.
    await assert.rejects(
      () => db.query('UPDATE goals SET created_by = $1 WHERE goal_id = $2', [
        ownerB.userId,
        goalA1,
      ]),
      /provenance is immutable/,
    );
  } finally {
    await db.close();
  }
  const foreignRead = await apiCall(port(), `/api/goals/${goalA1}`, { token: ownerB.token });
  assert.equal(foreignRead.status, 404, 'provenance never authorizes cross-tenant reads');
});

test('anonymous calls never reach authorization (401 across every goal path)', async () => {
  for (const [pathName, method, body] of [
    [`/api/clients/${clientA1}/goals`, 'POST', goalBody()],
    [`/api/clients/${clientA1}/goals`, 'GET', undefined],
    [`/api/goals/${goalA1}`, 'GET', undefined],
    [`/api/goals/${goalA1}/ownership-context`, 'GET', undefined],
    [`/api/goals/${goalA1}/profile`, 'PATCH', { ...goalBody(), version: 1 }],
    [`/api/goals/${goalA1}/status`, 'PATCH', { status: 'active', version: 1 }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 401, `${method} ${pathName} must require authentication`);
  }
});
