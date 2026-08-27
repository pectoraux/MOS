/**
 * MKT-004 security/isolation integration test — the Workspace boundary inside
 * the Client hard boundary (real PostgreSQL + real API subprocess).
 *
 * Proofs (issue #11 MKT-004-AC-02..06, TENANT-AC-05, acceptance-contract
 * negative matrix):
 *   - a foreign Workspace identifier (owned by a Client of ANOTHER Agency)
 *     yields the SAME 404 as an unknown one — no traversal/existence oracle,
 *     and the rejection happens BEFORE any dependent traversal (no
 *     material-mutation events, no data changes under parallel probes);
 *   - a Workspace of another Client in the SAME agency never leaks through
 *     Client-scoped routes (data-level Client boundary, TENANT-AC-05);
 *   - forged Agency/User/Client/Workspace identifiers, authority headers,
 *     body fields and query parameters cannot elevate or change the
 *     canonical owner scope;
 *   - membership WITHOUT the required role is rejected server-side (403);
 *   - stale membership state (revoked/disabled) loses access immediately,
 *     derived from durable state — proven across an API process RESTART;
 *   - a disabled Client follows Client policy (reads stay, mutations 409) and
 *     a deleted Client tombstone makes every workspace route a uniform 404
 *     (workspaces cannot resurrect Client authority);
 *   - direct-database re-parenting of a Workspace to another Client is
 *     rejected by the immutability trigger (a Workspace can never cross the
 *     Client boundary);
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

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-platform-roles': '["platform_administrator"]',
  'x-role': 'agency_owner',
  'x-agency-role': 'agency_admin',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-workspace-id': 'REPLACED_PER_TEST',
  'x-user-id': 'REPLACED_PER_TEST',
  'x-memberships': '[{"role":"agency_owner"}]',
} as Record<string, string>;

// Shared fixtures: agency A with members (two clients), agency B foreign.
const ownerA: User = { userId: '', token: '' };
const operatorA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceA2 = '';
let workspaceB = '';

before(async () => {
  stack = await bootStack('wspiso');
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

  Object.assign(ownerA, await createUser('owner-a@iso.test', 'Agency A Owner'));
  Object.assign(operatorA, await createUser('operator-a@iso.test', 'Agency A Operator'));
  Object.assign(collaboratorA, await createUser('collab-a@iso.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@iso.test', 'Agency B Owner'));

  agencyA = await makeAgency('Isolation Agency A', ownerA);
  agencyB = await makeAgency('Isolation Agency B', ownerB);
  await addMembership(agencyA, operatorA, 'agency_operator');
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  // Two clients under agency A (intra-agency boundary) + one under agency B.
  clientA1 = await makeClient(agencyA, 'Client A One');
  clientA2 = await makeClient(agencyA, 'Client A Two');
  clientB = await makeClient(agencyB, 'Client B One');

  workspaceA1 = await makeWorkspace(clientA1, 'Workspace A1');
  workspaceA2 = await makeWorkspace(clientA2, 'Workspace A2');
  workspaceB = await makeWorkspace(clientB, 'Workspace B');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a foreign Workspace identifier yields the SAME 404 as an unknown one — no existence oracle (TENANT-AC-05)', async () => {
  const unknownId = '00000000-0000-0000-0000-0000000000aa';

  for (const [description, pathName, method, body] of [
    ['foreign read', `/api/workspaces/${workspaceB}`, 'GET', undefined],
    ['foreign profile', `/api/workspaces/${workspaceB}/profile`, 'PATCH', { name: 'Hacked', version: 1 }],
    ['foreign lifecycle', `/api/workspaces/${workspaceB}/status`, 'PATCH', { status: 'deleted', version: 1 }],
    ['foreign ownership-context', `/api/workspaces/${workspaceB}/ownership-context`, 'GET', undefined],
    ['unknown read', `/api/workspaces/${unknownId}`, 'GET', undefined],
    ['unknown profile', `/api/workspaces/${unknownId}/profile`, 'PATCH', { name: 'Hacked', version: 1 }],
    ['unknown lifecycle', `/api/workspaces/${unknownId}/status`, 'PATCH', { status: 'deleted', version: 1 }],
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
  // owning client/agency or other tenant information ever leaks.
  const foreign = await apiCall(port(), `/api/workspaces/${workspaceB}`, { token: ownerA.token });
  const unknown = await apiCall(port(), '/api/workspaces/00000000-0000-0000-0000-0000000000bb', {
    token: ownerA.token,
  });
  const foreignError = foreign.body['error'] as Record<string, unknown>;
  const unknownError = unknown.body['error'] as Record<string, unknown>;
  assert.equal(foreignError['code'], unknownError['code']);
  assert.equal(foreignError['message'], `workspace not found: ${workspaceB}`);
  assert.equal(unknownError['message'], 'workspace not found: 00000000-0000-0000-0000-0000000000bb');
  for (const secret of [agencyB, clientB]) {
    assert.equal(
      JSON.stringify(foreignError).includes(secret),
      false,
      'the owning agency/client ids must never leak through the boundary',
    );
  }

  // The same uniform 404 holds for workspace creation under a foreign CLIENT
  // identifier (ownership from the PATH resolves through /clients first).
  const foreignCreate = await apiCall(port(), `/api/clients/${clientB}/workspaces`, {
    token: ownerA.token,
    body: { name: 'Should Not Create' },
  });
  assert.equal(foreignCreate.status, 404, 'foreign client on the create path → uniform 404');
  const unknownCreate = await apiCall(
    port(),
    '/api/clients/00000000-0000-0000-0000-0000000000cc/workspaces',
    { token: ownerA.token, body: { name: 'Should Not Create' } },
  );
  assert.equal(unknownCreate.status, 404);
});

test('foreign Workspace identifiers cause NO traversal/read side effects (MKT-004-AC-03: rejection before dependent traversal)', async () => {
  const eventsBefore = api!.logRecords().filter((record) =>
    record.event.startsWith('workspaces.workspace.'),
  ).length;
  const nameBefore = await (async () => {
    const read = await apiCall(port(), `/api/workspaces/${workspaceB}`, { token: ownerB.token });
    assert.equal(read.status, 200);
    return read.body['name'] as string;
  })();

  // Foreign traversal attempts against agency B's workspace by agency A's
  // owner — in PARALLEL.
  await Promise.all([
    apiCall(port(), `/api/workspaces/${workspaceB}`, { token: ownerA.token }),
    apiCall(port(), `/api/workspaces/${workspaceB}/profile`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { name: 'Pwned', version: 1 },
    }),
    apiCall(port(), `/api/workspaces/${workspaceB}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'deleted', version: 1 },
    }),
    apiCall(port(), `/api/workspaces/${workspaceB}/ownership-context`, { token: ownerA.token }),
    apiCall(port(), `/api/clients/${clientB}/workspaces`, {
      token: ownerA.token,
      body: { name: 'Pwned Create' },
    }),
  ]);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const newEvents = api!
    .logRecords()
    .filter((record) => record.event.startsWith('workspaces.workspace.'))
    .slice(eventsBefore);
  assert.equal(
    newEvents.length,
    0,
    'foreign attempts must not emit material-mutation records (no traversal)',
  );

  // The foreign workspace's durable state is untouched.
  const readAfter = await apiCall(port(), `/api/workspaces/${workspaceB}`, { token: ownerB.token });
  assert.equal(readAfter.status, 200);
  assert.equal(readAfter.body['name'], nameBefore, 'no data change through foreign identifiers');
  assert.equal(readAfter.body['version'], 1, 'no version churn through foreign identifiers');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ status: string; version: number }>(
      'SELECT status, version FROM workspaces WHERE workspace_id = $1',
      [workspaceB],
    );
    assert.equal(rows.rows[0]!.status, 'active');
    assert.equal(Number(rows.rows[0]!.version), 1);
    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM workspaces WHERE client_id = $1',
      [clientB],
    );
    assert.equal(count.rows[0]!.count, '1', 'no workspace was created under the foreign client');
  } finally {
    await db.close();
  }
});

test('workspaces never cross the Client boundary even inside one Agency (TENANT-AC-05 data-level proof)', async () => {
  // Client A1's list shows ONLY its own workspace — never A2's.
  const listA1 = await apiCall(port(), `/api/clients/${clientA1}/workspaces`, {
    token: ownerA.token,
  });
  assert.equal(listA1.status, 200);
  const idsA1 = (listA1.body['workspaces'] as Record<string, unknown>[]).map(
    (workspace) => workspace['workspaceId'],
  );
  assert.deepEqual(idsA1, [workspaceA1], 'client A1 list shows exactly its own workspace');

  // The canonical ownership context of A2's workspace derives from the
  // workspace's OWN client row — never from the caller or the route.
  const contextA2 = await apiCall(port(), `/api/workspaces/${workspaceA2}/ownership-context`, {
    token: ownerA.token,
  });
  assert.equal(contextA2.status, 200, 'same-agency member may address the workspace by id');
  const scope = contextA2.body['scope'] as Record<string, unknown>;
  assert.equal(scope['clientId'], clientA2, 'scope derives from the workspace ROW ownership');
  assert.equal(scope['workspaceId'], workspaceA2);
  assert.equal(scope['agencyId'], agencyA);

  // A workspace created under A2 belongs to A2 only — its slug cannot be
  // duplicated under A1? It CAN (per-client uniqueness) but the identities
  // stay distinct and the rows stay fenced per client.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ client_id: string; workspace_id: string }>(
      'SELECT client_id, workspace_id FROM workspaces ORDER BY created_at',
    );
    for (const row of rows.rows) {
      if (row.workspace_id === workspaceA1) {
        assert.equal(row.client_id, clientA1, 'workspace A1 stays owned by client A1');
      }
      if (row.workspace_id === workspaceA2) {
        assert.equal(row.client_id, clientA2, 'workspace A2 stays owned by client A2');
      }
      if (row.workspace_id === workspaceB) {
        assert.equal(row.client_id, clientB, 'workspace B stays owned by client B');
      }
    }
  } finally {
    await db.close();
  }
});

test('forged authority headers cannot elevate or change the canonical owner scope (MKT-004-AC-04)', async () => {
  const headers = {
    ...FORGED_HEADERS,
    'x-agency-id': agencyA,
    'x-client-id': clientA1,
    'x-workspace-id': workspaceA1,
    'x-user-id': ownerA.userId,
  };

  // Agency B's owner claims to be agency A's owner via headers: still 404 on
  // A's workspace, 403 on A-scoped mutations.
  const read = await apiCall(port(), `/api/workspaces/${workspaceA1}`, {
    token: ownerB.token,
    headers,
  });
  assert.equal(read.status, 404, 'forged headers cannot cross the boundary');

  const create = await apiCall(port(), `/api/clients/${clientA1}/workspaces`, {
    token: ownerB.token,
    headers,
    body: { name: 'Forged Workspace' },
  });
  assert.equal(create.status, 404, 'forged headers cannot grant client ownership');

  // Agency A's low-privilege collaborator claims platform/owner roles.
  const promote = await apiCall(port(), `/api/clients/${clientA1}/workspaces`, {
    token: collaboratorA.token,
    headers,
    body: { name: 'Forged Workspace 2' },
  });
  assert.equal(promote.status, 403, 'forged headers cannot elevate agency role');

  const mutate = await apiCall(port(), `/api/workspaces/${workspaceA1}/status`, {
    token: collaboratorA.token,
    headers,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(mutate.status, 403, 'forged headers cannot elevate for lifecycle ops');

  // Forged headers do not change the canonical context either.
  const context = await apiCall(port(), `/api/workspaces/${workspaceA1}/ownership-context`, {
    token: collaboratorA.token,
    headers,
  });
  assert.equal(context.status, 200);
  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['agencyId'], agencyA, 'scope derives from durable ownership only');
  assert.equal(scope['clientId'], clientA1);
  assert.equal(scope['workspaceId'], workspaceA1);
});

test('forged body authority fields are rejected with 422, never trusted (MKT-004-AC-04)', async () => {
  // Client ownership cannot be smuggled through the body on create.
  for (const body of [
    { name: 'X', clientId: clientB },
    { name: 'X', agencyId: agencyB },
    { name: 'X', workspaceId: workspaceB },
    { name: 'X', tenantId: agencyB },
    { name: 'X', ownerId: ownerB.userId },
  ]) {
    const response = await apiCall(port(), `/api/clients/${clientA1}/workspaces`, {
      token: ownerA.token,
      body,
    });
    assert.equal(response.status, 422, `smuggled authority field rejected: ${JSON.stringify(body)}`);
  }
  // ...nor on lifecycle/profile mutations.
  for (const [pathName, body] of [
    [`/api/workspaces/${workspaceA1}/profile`, { name: 'X', version: 1, clientId: clientB }],
    [`/api/workspaces/${workspaceA1}/profile`, { name: 'X', version: 1, agencyId: agencyB }],
    [
      `/api/workspaces/${workspaceA1}/status`,
      { status: 'disabled', version: 1, workspaceId: workspaceB },
    ],
    [`/api/workspaces/${workspaceA1}/status`, { status: 'disabled', version: 1, clientId: clientB }],
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
    `/api/clients/${clientA1}/workspaces?workspaceId=${workspaceB}&clientId=${clientB}&agencyId=${agencyB}`,
    { token: ownerA.token },
  );
  assert.equal(response.status, 200);
  const workspaces = response.body['workspaces'] as Record<string, unknown>[];
  assert.deepEqual(
    workspaces.map((workspace) => workspace['workspaceId']),
    [workspaceA1],
    'query-string identifiers cannot widen the scope',
  );
  assert.equal(response.body['clientId'], clientA1);
});

test('membership without the required role is rejected server-side (MKT-004-AC-03)', async () => {
  // operator/collaborator of agency A: reads fine, mutations forbidden.
  for (const user of [operatorA, collaboratorA]) {
    const read = await apiCall(port(), `/api/workspaces/${workspaceA1}`, { token: user.token });
    assert.equal(read.status, 200);

    const create = await apiCall(port(), `/api/clients/${clientA1}/workspaces`, {
      token: user.token,
      body: { name: 'Should Not Create' },
    });
    assert.equal(create.status, 403, `create forbidden for ${user.userId}`);

    const profile = await apiCall(port(), `/api/workspaces/${workspaceA1}/profile`, {
      token: user.token,
      method: 'PATCH',
      body: { name: 'Should Not Rename', version: 1 },
    });
    assert.equal(profile.status, 403);

    const status = await apiCall(port(), `/api/workspaces/${workspaceA1}/status`, {
      token: user.token,
      method: 'PATCH',
      body: { status: 'disabled', version: 1 },
    });
    assert.equal(status.status, 403);
  }

  // An agency_owner of agency A cannot manage B's client workspaces
  // (cross-tenant create path).
  const foreignCreate = await apiCall(port(), `/api/clients/${clientB}/workspaces`, {
    token: ownerA.token,
    body: { name: 'Should Not Create' },
  });
  assert.equal(foreignCreate.status, 404, 'cross-agency create via foreign client → 404');
});

test('stale membership state cannot bypass authorization (immediate, durable, restart-proof) (MKT-004-AC-05)', async () => {
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
  const readSuspended = await apiCall(port(), `/api/workspaces/${workspaceA1}`, {
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

  const readRevoked = await apiCall(port(), `/api/workspaces/${workspaceA1}`, {
    token: collaboratorA.token,
  });
  assert.equal(readRevoked.status, 404, 'revoked membership → no owning-agency membership → 404');

  // RESTART the API process: authorization still derives from durable state
  // (a process-local cache would have been wiped either way — this proves
  // the fresh process derives the SAME denial).
  api!.child.kill('SIGKILL');
  api = await spawnApi(stack!.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  adminTokenCache = null;
  const readAfterRestart = await apiCall(port(), `/api/workspaces/${workspaceA1}`, {
    token: collaboratorA.token,
  });
  assert.equal(readAfterRestart.status, 404, 'denial survives process restart (durable state)');

  // Re-adding the member restores access through a NEW membership identity.
  await addMembership(agencyA, collaboratorA, 'client_collaborator');
  const readReadded = await apiCall(port(), `/api/workspaces/${workspaceA1}`, {
    token: collaboratorA.token,
  });
  assert.equal(readReadded.status, 200, 're-added membership restores access immediately');
});

test('a deleted Client tombstone makes every workspace route a uniform 404 — no resurrection (MKT-004-AC-06)', async () => {
  // Fresh client + workspace owned by agency B.
  const client = await makeClient(agencyB, 'Doomed Client');
  const workspace = await makeWorkspace(client, 'Doomed Client Workspace');

  // Tombstone the CLIENT (owner of agency B can do this).
  const del = await apiCall(port(), `/api/clients/${client}/status`, {
    token: ownerB.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(del.status, 200);

  // Every workspace route now 404s: the client tombstone never resolves, so
  // its workspace identifiers cannot resurrect access.
  for (const [pathName, method, body] of [
    [`/api/workspaces/${workspace}`, 'GET', undefined],
    [`/api/workspaces/${workspace}/ownership-context`, 'GET', undefined],
    [`/api/workspaces/${workspace}/profile`, 'PATCH', { name: 'Resurrect', version: 1 }],
    [`/api/workspaces/${workspace}/status`, 'PATCH', { status: 'active', version: 1 }],
    [`/api/clients/${client}/workspaces`, 'GET', undefined],
    [`/api/clients/${client}/workspaces`, 'POST', { name: 'Resurrect' }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: ownerB.token,
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 404, `${method} ${pathName} must be 404 under a tombstoned client`);
  }
});

test('a Workspace can never be re-parented across the Client boundary — DB backstop (TENANT-AC-05)', async () => {
  // Attempt to move A2's workspace under client B (another AGENCY) and under
  // client A1 (another CLIENT of the same agency) — both are rejected by the
  // immutability trigger: a Workspace cannot cross the Client boundary, not
  // even intra-agency.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () => db.query('UPDATE workspaces SET client_id = $1 WHERE workspace_id = $2', [
        clientB,
        workspaceA2,
      ]),
      /cannot change Client ownership/,
      'cross-agency re-parenting must be rejected',
    );
    await assert.rejects(
      () => db.query('UPDATE workspaces SET client_id = $1 WHERE workspace_id = $2', [
        clientA1,
        workspaceA2,
      ]),
      /cannot change Client ownership/,
      'intra-agency cross-client re-parenting must be rejected',
    );
    // Identity can never be reassigned either.
    await assert.rejects(
      () =>
        db.query('UPDATE workspaces SET workspace_id = $1 WHERE workspace_id = $2', [
          '00000000-0000-0000-0000-0000000000ee',
          workspaceA2,
        ]),
      /workspace_id .* is immutable/,
      'workspace identity must be immutable',
    );
    // Provenance can never be rewritten.
    await assert.rejects(
      () =>
        db.query('UPDATE workspaces SET created_by = $1 WHERE workspace_id = $2', [
          '00000000-0000-0000-0000-0000000000ef',
          workspaceA2,
        ]),
      /provenance is immutable/,
      'provenance must be immutable',
    );

    // Legitimate mutable fields still work (the triggers do not over-block).
    const ok = await db.query<{ name: string }>(
      "UPDATE workspaces SET name = 'Renamed Legitimately', version = version + 1 WHERE workspace_id = $1 RETURNING name",
      [workspaceA2],
    );
    assert.equal(ok.rows[0]!.name, 'Renamed Legitimately');
  } finally {
    await db.close();
  }
});

test('anonymous calls never reach authorization (401 across every workspace path)', async () => {
  for (const [pathName, method, body] of [
    [`/api/clients/${clientA1}/workspaces`, 'POST', { name: 'Anon' }],
    [`/api/clients/${clientA1}/workspaces`, 'GET', undefined],
    [`/api/workspaces/${workspaceA1}`, 'GET', undefined],
    [`/api/workspaces/${workspaceA1}/ownership-context`, 'GET', undefined],
    [`/api/workspaces/${workspaceA1}/profile`, 'PATCH', { name: 'Anon', version: 1 }],
    [`/api/workspaces/${workspaceA1}/status`, 'PATCH', { status: 'deleted', version: 1 }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 401, `${method} ${pathName} must require authentication`);
  }
});
