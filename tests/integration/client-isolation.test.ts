/**
 * MKT-003 security/isolation integration test — the Client as the HARD
 * security boundary (real PostgreSQL + real API subprocess).
 *
 * Proofs (issue #9 security contract, TENANT-AC-03/04, MKT-003-AC-01..04):
 *   - a user from ANOTHER Agency cannot read or mutate a foreign Client —
 *     and the response is BYTE-IDENTICAL to the unknown-Client 404 (no
 *     existence/traversal oracle);
 *   - foreign Client identifiers cause NO traversal/read side effects: no
 *     material-mutation events, no data changes;
 *   - forged Agency/User/Client/Workspace identifiers, authority headers,
 *     body fields and query parameters cannot elevate or change the
 *     canonical owner scope;
 *   - membership WITHOUT the required role is rejected server-side (403);
 *   - stale membership state (revoked/disabled) loses access immediately,
 *     derived from durable state — proven across an API process RESTART;
 *   - a disabled Client cannot be used where policy forbids; a deleted
 *     Client is a terminal tombstone whose identifiers cannot be replayed
 *     back to life (API 404s + DB trigger exception on direct UPDATE);
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

async function makeClient(agencyId: string, name: string, slug?: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name, ...(slug === undefined ? {} : { slug }) },
  });
  assert.equal(response.status, 201, `create client: ${JSON.stringify(response.body)}`);
  return response.body['clientId'] as string;
}

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-platform-roles': '["platform_administrator"]',
  'x-role': 'agency_owner',
  'x-agency-role': 'agency_admin',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-user-id': 'REPLACED_PER_TEST',
  'x-memberships': '[{"role":"agency_owner"}]',
  'x-workspace-id': '00000000-0000-0000-0000-0000000000ff',
} as Record<string, string>;

// Shared fixtures: agency A with members, agency B with a foreign owner.
const ownerA: User = { userId: '', token: '' };
const operatorA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA = '';
let clientB = '';

before(async () => {
  stack = await bootStack('clientiso');
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

  clientA = await makeClient(agencyA, 'Client A One');
  clientB = await makeClient(agencyB, 'Client B One');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a foreign Client identifier yields the SAME 404 as an unknown one — no existence oracle (TENANT-AC-04)', async () => {
  const unknownId = '00000000-0000-0000-0000-0000000000aa';

  for (const [description, pathName, method, body] of [
    ['foreign read', `/api/clients/${clientB}`, 'GET', undefined],
    ['foreign profile', `/api/clients/${clientB}/profile`, 'PATCH', { name: 'Hacked', version: 1 }],
    ['foreign lifecycle', `/api/clients/${clientB}/status`, 'PATCH', { status: 'disabled', version: 1 }],
    ['foreign ownership-context', `/api/clients/${clientB}/ownership-context`, 'GET', undefined],
    ['unknown read', `/api/clients/${unknownId}`, 'GET', undefined],
    ['unknown profile', `/api/clients/${unknownId}/profile`, 'PATCH', { name: 'Hacked', version: 1 }],
    ['unknown lifecycle', `/api/clients/${unknownId}/status`, 'PATCH', { status: 'deleted', version: 1 }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: ownerA.token,
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 404, `${description} must be a hard-boundary 404`);
    // The error payload must not distinguish foreign from unknown.
    const errorBody = response.body['error'] as Record<string, unknown>;
    assert.equal(errorBody['code'], 'NOT_FOUND', `${description}: uniform NOT_FOUND code`);
  }

  // Byte-identical error SHAPE for foreign vs unknown: same code, same message
  // format — the only variable is the caller's own supplied id. No owning
  // agency or other tenant information ever leaks.
  const foreign = await apiCall(port(), `/api/clients/${clientB}`, { token: ownerA.token });
  const unknown = await apiCall(port(), '/api/clients/00000000-0000-0000-0000-0000000000bb', {
    token: ownerA.token,
  });
  const foreignError = foreign.body['error'] as Record<string, unknown>;
  const unknownError = unknown.body['error'] as Record<string, unknown>;
  assert.equal(foreignError['code'], unknownError['code']);
  assert.equal(foreignError['message'], `client not found: ${clientB}`);
  assert.equal(unknownError['message'], 'client not found: 00000000-0000-0000-0000-0000000000bb');
  assert.equal(
    JSON.stringify(foreignError).includes(agencyB),
    false,
    'the OWNING agency id must never leak through the boundary',
  );
});

test('foreign identifiers cause NO traversal/read side effects (TENANT-AC-04: rejection before dependent traversal)', async () => {
  const eventsBefore = api!.logRecords().filter((record) =>
    record.event.startsWith('clients.client.'),
  ).length;
  const nameBefore = await (async () => {
    const read = await apiCall(port(), `/api/clients/${clientB}`, { token: ownerB.token });
    assert.equal(read.status, 200);
    return read.body['name'] as string;
  })();

  // Foreign traversal attempts against agency B's client by agency A's owner.
  await Promise.all([
    apiCall(port(), `/api/clients/${clientB}`, { token: ownerA.token }),
    apiCall(port(), `/api/clients/${clientB}/profile`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { name: 'Pwned', version: 1 },
    }),
    apiCall(port(), `/api/clients/${clientB}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'deleted', version: 1 },
    }),
    apiCall(port(), `/api/clients/${clientB}/ownership-context`, { token: ownerA.token }),
  ]);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const newEvents = api!
    .logRecords()
    .filter((record) => record.event.startsWith('clients.client.'))
    .slice(eventsBefore);
  assert.equal(
    newEvents.length,
    0,
    'foreign attempts must not emit material-mutation records (no traversal)',
  );

  // The foreign client's durable state is untouched.
  const readAfter = await apiCall(port(), `/api/clients/${clientB}`, { token: ownerB.token });
  assert.equal(readAfter.status, 200);
  assert.equal(readAfter.body['name'], nameBefore, 'no data change through foreign identifiers');
  assert.equal(readAfter.body['version'], 1, 'no version churn through foreign identifiers');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ status: string; version: number }>(
      'SELECT status, version FROM clients WHERE client_id = $1',
      [clientB],
    );
    assert.equal(rows.rows[0]!.status, 'active');
    assert.equal(Number(rows.rows[0]!.version), 1);
  } finally {
    await db.close();
  }
});

test('forged authority headers cannot elevate or change the canonical owner scope (MKT-003-AC-04)', async () => {
  const headers = {
    ...FORGED_HEADERS,
    'x-agency-id': agencyA,
    'x-client-id': clientA,
    'x-user-id': ownerA.userId,
  };

  // Agency B's owner claims to be agency A's owner via headers: still 404 on
  // A's client, 403 on A-scoped mutations.
  const read = await apiCall(port(), `/api/clients/${clientA}`, {
    token: ownerB.token,
    headers,
  });
  assert.equal(read.status, 404, 'forged headers cannot cross the boundary');

  const create = await apiCall(port(), `/api/agencies/${agencyA}/clients`, {
    token: ownerB.token,
    headers,
    body: { name: 'Forged Client' },
  });
  assert.equal(create.status, 403, 'forged headers cannot grant agency roles');

  // Agency A's low-privilege collaborator claims platform/owner roles.
  const promote = await apiCall(port(), `/api/agencies/${agencyA}/clients`, {
    token: collaboratorA.token,
    headers,
    body: { name: 'Forged Client 2' },
  });
  assert.equal(promote.status, 403, 'forged headers cannot elevate agency role');

  const mutate = await apiCall(port(), `/api/clients/${clientA}/status`, {
    token: collaboratorA.token,
    headers,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(mutate.status, 403, 'forged headers cannot elevate for lifecycle ops');

  // Forged headers do not change the canonical context either.
  const context = await apiCall(port(), `/api/clients/${clientA}/ownership-context`, {
    token: collaboratorA.token,
    headers,
  });
  assert.equal(context.status, 200);
  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['agencyId'], agencyA, 'scope derives from durable ownership only');
  assert.equal(scope['clientId'], clientA);
});

test('forged body authority fields are rejected with 422, never trusted (MKT-003-AC-04)', async () => {
  // Ownership cannot be smuggled through the body on create.
  for (const body of [
    { name: 'X', agencyId: agencyB },
    { name: 'X', clientId: clientB },
    { name: 'X', workspaceId: '00000000-0000-0000-0000-0000000000cc' },
    { name: 'X', tenantId: agencyB },
    { name: 'X', ownerId: ownerB.userId },
  ]) {
    const response = await apiCall(port(), `/api/agencies/${agencyA}/clients`, {
      token: ownerA.token,
      body,
    });
    assert.equal(response.status, 422, `smuggled authority field rejected: ${JSON.stringify(body)}`);
  }
  // ...nor on lifecycle/profile mutations.
  for (const [pathName, body] of [
    [`/api/clients/${clientA}/profile`, { name: 'X', version: 1, agencyId: agencyB }],
    [`/api/clients/${clientA}/profile`, { name: 'X', version: 1, workspaceId: clientB }],
    [`/api/clients/${clientA}/status`, { status: 'disabled', version: 1, clientId: clientB }],
    [`/api/clients/${clientA}/status`, { status: 'disabled', version: 1, agencyId: agencyB }],
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
    `/api/agencies/${agencyA}/clients?clientId=${clientB}&agencyId=${agencyB}&workspaceId=00000000-0000-0000-0000-0000000000dd`,
    { token: ownerA.token },
  );
  assert.equal(response.status, 200);
  const clients = response.body['clients'] as Record<string, unknown>[];
  assert.deepEqual(
    clients.map((client) => client['clientId']),
    [clientA],
    'query-string identifiers cannot widen the scope',
  );
  assert.equal(response.body['agencyId'], agencyA);
});

test('membership without the required role is rejected server-side (TENANT-AC-03)', async () => {
  // operator/collaborator of agency A: reads fine, mutations forbidden.
  for (const user of [operatorA, collaboratorA]) {
    const read = await apiCall(port(), `/api/clients/${clientA}`, { token: user.token });
    assert.equal(read.status, 200);

    const create = await apiCall(port(), `/api/agencies/${agencyA}/clients`, {
      token: user.token,
      body: { name: 'Should Not Create' },
    });
    assert.equal(create.status, 403, `create forbidden for ${user.userId}`);

    const profile = await apiCall(port(), `/api/clients/${clientA}/profile`, {
      token: user.token,
      method: 'PATCH',
      body: { name: 'Should Not Rename', version: 1 },
    });
    assert.equal(profile.status, 403);

    const status = await apiCall(port(), `/api/clients/${clientA}/status`, {
      token: user.token,
      method: 'PATCH',
      body: { status: 'disabled', version: 1 },
    });
    assert.equal(status.status, 403);
  }

  // An agency_owner of agency A cannot manage B's clients (cross-tenant).
  const foreignCreate = await apiCall(port(), `/api/agencies/${agencyB}/clients`, {
    token: ownerA.token,
    body: { name: 'Should Not Create' },
  });
  assert.equal(foreignCreate.status, 403, 'cross-agency create is 403 (agency exists, no membership)');

  // ...and cannot even SEE B's clients through the list route.
  const foreignList = await apiCall(port(), `/api/agencies/${agencyB}/clients`, {
    token: ownerA.token,
  });
  assert.equal(foreignList.status, 403, 'cross-agency list is 403 (agency-level boundary)');
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
  const readSuspended = await apiCall(port(), `/api/clients/${clientA}`, {
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
      body: { status: 'active', version: (disabled.body['version'] as number) },
    },
  );
  assert.equal(reenabled.status, 200);
  const revoked = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${membership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'revoked', version: (reenabled.body['version'] as number) },
    },
  );
  assert.equal(revoked.status, 200);

  const readRevoked = await apiCall(port(), `/api/clients/${clientA}`, {
    token: collaboratorA.token,
  });
  assert.equal(readRevoked.status, 404, 'revoked membership → no ownership-agency membership → 404');

  // RESTART the API process: authorization still derives from durable state
  // (a process-local cache would have been wiped either way — this proves
  // the fresh process derives the SAME denial).
  api!.child.kill('SIGKILL');
  api = await spawnApi(stack!.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  adminTokenCache = null;
  const readAfterRestart = await apiCall(port(), `/api/clients/${clientA}`, {
    token: collaboratorA.token,
  });
  assert.equal(readAfterRestart.status, 404, 'denial survives process restart (durable state)');

  // Re-adding the member restores access through a NEW membership identity.
  await addMembership(agencyA, collaboratorA, 'client_collaborator');
  const readReadded = await apiCall(port(), `/api/clients/${clientA}`, {
    token: collaboratorA.token,
  });
  assert.equal(readReadded.status, 200, 're-added membership restores access immediately');
});

test('a disabled Client cannot be used where policy forbids, and history is not rewritten (MKT-003-AC-03)', async () => {
  const client = await makeClient(agencyA, 'Policy Client');
  const created = await apiCall(port(), `/api/clients/${client}`, { token: ownerA.token });
  const createdAt = created.body['createdAt'] as string;
  const createdBy = created.body['createdBy'] as string;

  const disable = await apiCall(port(), `/api/clients/${client}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disable.status, 200);

  // New use is blocked...
  const profile = await apiCall(port(), `/api/clients/${client}/profile`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { name: 'Blocked', version: 2 },
  });
  assert.equal(profile.status, 409, 'disabled client blocks new authorized use');
  // ...but the historical record is intact and readable.
  const read = await apiCall(port(), `/api/clients/${client}`, { token: ownerA.token });
  assert.equal(read.status, 200);
  assert.equal(read.body['createdAt'], createdAt, 'created_at not rewritten');
  assert.equal(read.body['createdBy'], createdBy, 'provenance not rewritten');
  assert.equal(read.body['status'], 'disabled', 'status IS the durable lifecycle fact');
});

test('a deleted Client is a terminal tombstone — stale identifiers never resurrect (MKT-003-AC-03)', async () => {
  const client = await makeClient(agencyA, 'Doomed Client', 'doomed-client');
  const del = await apiCall(port(), `/api/clients/${client}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(del.status, 200);

  // Every replay of the stale identifier fails closed.
  const read = await apiCall(port(), `/api/clients/${client}`, { token: ownerA.token });
  assert.equal(read.status, 404);
  const resurrect = await apiCall(port(), `/api/clients/${client}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(resurrect.status, 404, 'resurrection through the API is impossible');

  // Even a DIRECT database update is rejected by the terminal trigger.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () => db.query("UPDATE clients SET status = 'active' WHERE client_id = $1", [client]),
      /deleted and terminal/,
      'DB trigger must make deleted clients terminal',
    );

    // The tombstone row survives as history with its immutable identity.
    const rows = await db.query<{ status: string; agency_id: string }>(
      'SELECT status, agency_id FROM clients WHERE client_id = $1',
      [client],
    );
    assert.equal(rows.rows.length, 1, 'history preserved');
    assert.equal(rows.rows[0]!.status, 'deleted');
    assert.equal(rows.rows[0]!.agency_id, agencyA, 'ownership survives deletion');
  } finally {
    await db.close();
  }

  // A NEW client may reuse the slug — with a NEW immutable identity.
  const successor = await makeClient(agencyA, 'Doomed Client Reborn', 'doomed-client');
  assert.notEqual(successor, client, 'new identity, not a resurrection');
  const oldStillDead = await apiCall(port(), `/api/clients/${client}`, { token: ownerA.token });
  assert.equal(oldStillDead.status, 404, 'the old identifier stays dead');
});

test('anonymous calls never reach authorization (401 across every client path)', async () => {
  for (const [pathName, method, body] of [
    [`/api/agencies/${agencyA}/clients`, 'POST', { name: 'Anon' }],
    [`/api/agencies/${agencyA}/clients`, 'GET', undefined],
    [`/api/clients/${clientA}`, 'GET', undefined],
    [`/api/clients/${clientA}/ownership-context`, 'GET', undefined],
    [`/api/clients/${clientA}/profile`, 'PATCH', { name: 'Anon', version: 1 }],
    [`/api/clients/${clientA}/status`, 'PATCH', { status: 'deleted', version: 1 }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 401, `${method} ${pathName} must require authentication`);
  }
});
