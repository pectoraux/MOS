/**
 * MKT-004 integration test — Workspace API contract on a real PostgreSQL +
 * real API subprocess:
 *
 *   - TENANT-AC-05 (positive): a Client can own multiple Workspaces with
 *     distinct immutable identities, each with exactly one immutable
 *     client_id (rows verified directly in the database); per-Client slug
 *     uniqueness allows the same slug under a DIFFERENT Client;
 *   - MKT-004-AC-01: Workspace identity/ownership/provenance are
 *     server-derived; caller-supplied authority fields are rejected;
 *   - MKT-004-AC-02: the canonical owner context is resolved server-side
 *     from durable state (workspace → client → agency) and exposed
 *     read-only, fresh on every call;
 *   - MKT-004-AC-06: the frozen lifecycle (disable blocks new use without
 *     rewriting history; delete is a terminal tombstone; client policy —
 *     disabled client fences new workspaces and re-enable, deleted client
 *     is a uniform 404);
 *   - read/mutation authorization matrix incl. platform admin and the
 *     internal service principal; correlated §23 records for material
 *     mutations.
 *
 * Cross-tenant isolation and concurrency proofs live in
 * workspace-isolation.test.ts / workspace-concurrency.test.ts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  sleep,
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

interface Client {
  readonly clientId: string;
  readonly version: number;
}

async function makeClient(agencyId: string, name: string, slug?: string): Promise<Client> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name, ...(slug === undefined ? {} : { slug }) },
  });
  assert.equal(response.status, 201, `create client: ${JSON.stringify(response.body)}`);
  return {
    clientId: response.body['clientId'] as string,
    version: response.body['version'] as number,
  };
}

interface Workspace {
  readonly workspaceId: string;
  readonly version: number;
}

async function makeWorkspace(
  clientId: string,
  name: string,
  slug?: string,
): Promise<Workspace> {
  const response = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name, ...(slug === undefined ? {} : { slug }) },
  });
  assert.equal(response.status, 201, `create workspace: ${JSON.stringify(response.body)}`);
  return {
    workspaceId: response.body['workspaceId'] as string,
    version: response.body['version'] as number,
  };
}

before(async () => {
  stack = await bootStack('wspapi');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a Client can own multiple Workspaces with distinct immutable identities (TENANT-AC-05)', async () => {
  const owner = await makeUser('owner@acme.test', 'Acme Owner', 'owner-password-123');
  const agencyId = await makeAgency('Acme & Co Ltd', owner);
  const client = await makeClient(agencyId, 'Acme Retail');

  const first = await makeWorkspace(client.clientId, 'Acme Growth Room');
  const second = await makeWorkspace(client.clientId, 'Acme Retention Room');
  const third = await makeWorkspace(client.clientId, 'Acme Brand Room');

  assert.ok(
    first.workspaceId !== second.workspaceId && second.workspaceId !== third.workspaceId,
  );
  for (const workspace of [first, second, third]) {
    assert.equal(workspace.workspaceId.length, 36, 'server-generated uuid identity');
  }

  // Database verification: every Workspace row carries the SAME Client
  // ownership and a DISTINCT identity.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ workspace_id: string; client_id: string; status: string }>(
      'SELECT workspace_id, client_id, status FROM workspaces WHERE client_id = $1 ORDER BY created_at',
      [client.clientId],
    );
    assert.equal(rows.rows.length, 3, 'all three workspaces persisted under the client');
    assert.deepEqual(
      rows.rows.map((row) => row.client_id),
      [client.clientId, client.clientId, client.clientId],
      'Client→Workspace ownership on every row',
    );
    assert.equal(new Set(rows.rows.map((row) => row.workspace_id)).size, 3, 'distinct identities');
    for (const row of rows.rows) {
      assert.equal(row.status, 'active');
    }
  } finally {
    await db.close();
  }

  // All three are listed for client members.
  const list = await apiCall(port(), `/api/clients/${client.clientId}/workspaces`, {
    token: owner.token,
  });
  assert.equal(list.status, 200);
  assert.equal((list.body['workspaces'] as unknown[]).length, 3);

  // Per-Client uniqueness: ANOTHER client (same agency) may own a workspace
  // with the same slug — the fence is per-Client, not per-Agency.
  const otherClient = await makeClient(agencyId, 'Acme Wholesale');
  const sameSlug = await makeWorkspace(otherClient.clientId, 'Acme Growth Room');
  assert.equal(
    sameSlug.workspaceId !== first.workspaceId,
    true,
    'distinct identity across clients (same agency, same slug)',
  );
});

test('workspace creation derives server-authoritative fields and rejects authority/unknown fields (MKT-004-AC-01)', async () => {
  const owner = await makeUser('owner2@beta.test', 'Beta Owner', 'beta-password-12');
  const agencyId = await makeAgency('Beta Agency', owner);
  const client = await makeClient(agencyId, 'Beta Retail');

  const created = await apiCall(port(), `/api/clients/${client.clientId}/workspaces`, {
    token: owner.token,
    body: { name: 'Beta Growth' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body['clientId'], client.clientId, 'ownership from the PATH, not the body');
  assert.equal(created.body['status'], 'active', 'status is server-derived');
  assert.equal(created.body['version'], 1, 'version is server-derived');
  assert.equal(created.body['slug'], 'beta-growth', 'slug derived from the name');
  assert.ok(typeof created.body['createdAt'] === 'string');
  assert.ok(typeof created.body['updatedAt'] === 'string');
  assert.equal(created.body['createdBy'], owner.userId, 'provenance is the server-derived caller');

  // Authority/unknown fields in the body are rejected, never trusted.
  for (const body of [
    { name: 'X', workspaceId: '00000000-0000-0000-0000-000000000001' },
    { name: 'X', clientId: '00000000-0000-0000-0000-000000000002' },
    { name: 'X', agencyId: '00000000-0000-0000-0000-000000000003' },
    { name: 'X', status: 'active' },
    { name: 'X', version: 7 },
    { name: 'X', createdBy: '00000000-0000-0000-0000-000000000004' },
    { name: 'X', createdAt: '2020-01-01T00:00:00Z' },
    { name: 'X', updatedAt: '2020-01-01T00:00:00Z' },
    { name: 'X', tenantId: '00000000-0000-0000-0000-000000000005' },
  ]) {
    const response = await apiCall(port(), `/api/clients/${client.clientId}/workspaces`, {
      token: owner.token,
      body,
    });
    assert.equal(response.status, 422, `authority field must be rejected: ${JSON.stringify(body)}`);
  }

  // Slug validation when explicitly supplied.
  const badSlug = await apiCall(port(), `/api/clients/${client.clientId}/workspaces`, {
    token: owner.token,
    body: { name: 'Whatever', slug: 'Not A Slug!' },
  });
  assert.equal(badSlug.status, 422);
});

test('workspace read follows the authorization matrix (member roles | platform admin | service | stranger | anonymous)', async () => {
  const owner = await makeUser('owner3@gamma.test', 'Gamma Owner', 'gamma-password-12');
  const operator = await makeUser('op3@gamma.test', 'Gamma Operator', 'gamma-op-pass-1');
  const collaborator = await makeUser('collab3@gamma.test', 'Gamma Collab', 'gamma-col-pass-1');
  const stranger = await makeUser('stranger3@delta.test', 'Delta Stranger', 'delta-pass-1234');
  const agencyId = await makeAgency('Gamma Agency', owner);

  const admin = await adminToken();
  for (const [user, role] of [
    [operator, 'agency_operator'],
    [collaborator, 'client_collaborator'],
  ] as const) {
    const add = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
      token: admin,
      body: { userId: user.userId, role },
    });
    assert.equal(add.status, 201);
  }
  const strangerAgency = await makeAgency('Delta Agency', stranger);
  assert.ok(strangerAgency.length === 36);

  const client = await makeClient(agencyId, 'Gamma Client');
  const workspace = await makeWorkspace(client.clientId, 'Gamma Growth Room');

  // Every active member role may READ the workspace (same matrix as clients).
  for (const user of [owner, operator, collaborator]) {
    const read = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
      token: user.token,
    });
    assert.equal(read.status, 200, `member read for ${user.userId}`);
  }
  // Platform administrator (platform operator semantics, mirrors /clients).
  const platformRead = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: admin,
  });
  assert.equal(platformRead.status, 200);
  // Internal service principal.
  const serviceRead = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: stack!.env.internalApiToken,
  });
  assert.equal(serviceRead.status, 200);
  // Stranger (member of ANOTHER agency) → hard-boundary 404.
  const strangerRead = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: stranger.token,
  });
  assert.equal(strangerRead.status, 404);
  // Anonymous → 401 before authorization.
  const anonymousRead = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {});
  assert.equal(anonymousRead.status, 401);

  // Platform admin can also CREATE (operator semantics).
  const platformCreate = await apiCall(port(), `/api/clients/${client.clientId}/workspaces`, {
    token: admin,
    body: { name: 'Platform-Created Workspace' },
  });
  assert.equal(platformCreate.status, 201);
});

test('workspace profile update is CAS-guarded, owner/admin-only, slug-immutable', async () => {
  const owner = await makeUser('owner4@epsilon.test', 'Epsilon Owner', 'epsilon-pass-12');
  const operator = await makeUser('op4@epsilon.test', 'Epsilon Operator', 'epsilon-op-pass-1');
  const agencyId = await makeAgency('Epsilon Agency', owner);
  const addOperator = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(addOperator.status, 201);
  const client = await makeClient(agencyId, 'Epsilon Retail');
  const workspace = await makeWorkspace(client.clientId, 'Epsilon Growth');

  const updated = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Epsilon Growth Renamed', version: workspace.version },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body['name'], 'Epsilon Growth Renamed');
  assert.equal(updated.body['version'], workspace.version + 1, 'CAS version bump');
  assert.equal(updated.body['slug'], 'epsilon-growth', 'slug is immutable');

  // Stale version → 409 (CAS loss).
  const stale = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Stale Update', version: workspace.version },
  });
  assert.equal(stale.status, 409);

  // Wrong agency role (operator) → 403.
  const asOperator = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/profile`, {
    token: operator.token,
    method: 'PATCH',
    body: { name: 'Operator Update', version: workspace.version + 1 },
  });
  assert.equal(asOperator.status, 403);

  // Slug/authority fields in the body → 422.
  for (const body of [
    { name: 'X', version: 2, slug: 'new-slug' },
    { name: 'X', version: 2, clientId: '00000000-0000-0000-0000-000000000009' },
    { name: 'X', version: 2, agencyId: '00000000-0000-0000-0000-000000000010' },
    { name: 'X', version: 2, workspaceId: '00000000-0000-0000-0000-000000000011' },
    { name: 'X', version: 2, status: 'active' },
  ]) {
    const response = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/profile`, {
      token: owner.token,
      method: 'PATCH',
      body,
    });
    assert.equal(response.status, 422, `profile authority field rejected: ${JSON.stringify(body)}`);
  }
});

test('the canonical ownership-context resolves server-side from durable state (MKT-004-AC-02)', async () => {
  const owner = await makeUser('owner5@zeta.test', 'Zeta Owner', 'zeta-password-12');
  const agencyId = await makeAgency('Zeta Agency', owner);
  const client = await makeClient(agencyId, 'Zeta Client');
  const workspace = await makeWorkspace(client.clientId, 'Zeta Growth Room');

  const context = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}/ownership-context`,
    { token: owner.token },
  );
  assert.equal(context.status, 200, JSON.stringify(context.body));

  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'workspace');
  assert.equal(scope['agencyId'], agencyId);
  assert.equal(scope['clientId'], client.clientId);
  assert.equal(scope['workspaceId'], workspace.workspaceId);

  const contextWorkspace = context.body['workspace'] as Record<string, unknown>;
  assert.equal(contextWorkspace['clientId'], client.clientId, 'ownership derived from the workspace ROW');
  assert.equal(contextWorkspace['status'], 'active');

  const contextClient = context.body['client'] as Record<string, unknown>;
  assert.equal(contextClient['agencyId'], agencyId, 'client ownership derived from the client ROW');
  assert.equal(contextClient['clientId'], client.clientId);

  const contextAgency = context.body['agency'] as Record<string, unknown>;
  assert.equal(contextAgency['agencyId'], agencyId);
  assert.equal(contextAgency['slug'], 'zeta-agency');
  assert.equal(contextAgency['status'], 'active');
  assert.ok(typeof context.body['resolvedAt'] === 'string');

  // The owning CLIENT's status is durable state — changing it is reflected in
  // a FRESH resolution (no cache between calls): workspace → client → agency
  // is re-derived from durable rows on every call.
  const admin = await adminToken();
  const disabled = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: admin,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disabled.status, 200);
  const contextAfter = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}/ownership-context`,
    { token: owner.token },
  );
  assert.equal(contextAfter.status, 200, 'reads stay available under a disabled client');
  const clientAfter = contextAfter.body['client'] as Record<string, unknown>;
  assert.equal(clientAfter['status'], 'disabled', 'fresh durable resolution on every call');

  // Re-enable to leave the fixture in a clean state.
  const reenabled = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: admin,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(reenabled.status, 200);
});

test('workspace material mutations emit correlated structured records (§23)', async () => {
  const owner = await makeUser('owner6@eta.test', 'Eta Owner', 'eta-password-123');
  const agencyId = await makeAgency('Eta Agency', owner);
  const client = await makeClient(agencyId, 'Eta Client');
  const correlationId = '8d4e6f2a-1b0c-9d8e-7f6a-5b4c3d2e1f0a';

  const created = await apiCall(port(), `/api/clients/${client.clientId}/workspaces`, {
    token: owner.token,
    body: { name: 'Eta Workspace' },
    correlationId,
  });
  assert.equal(created.status, 201);
  const workspaceId = created.body['workspaceId'] as string;

  const updated = await apiCall(port(), `/api/workspaces/${workspaceId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Eta Workspace Renamed', version: 1 },
    correlationId,
  });
  assert.equal(updated.status, 200);
  const statusChanged = await apiCall(port(), `/api/workspaces/${workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 2 },
    correlationId,
  });
  assert.equal(statusChanged.status, 200);

  await sleep(150); // structured records are flushed asynchronously
  const records = api!.logRecords();
  for (const event of [
    'workspaces.workspace.created',
    'workspaces.workspace.profile_updated',
    'workspaces.workspace.status_changed',
  ]) {
    const saw = records.some(
      (record) => record.event === event && record.correlation_id === correlationId,
    );
    assert.ok(saw, `${event} record carries the request correlation id`);
  }
});

test('listing is Client-scoped: only the caller Client\'s LIVE workspaces are visible (TENANT-AC-05)', async () => {
  const ownerA = await makeUser('owner7@theta.test', 'Theta Owner', 'theta-password-12');
  const agencyId = await makeAgency('Theta Agency', ownerA);

  // Two clients inside the SAME agency: workspaces never cross the Client
  // boundary even intra-agency.
  const clientOne = await makeClient(agencyId, 'Theta One');
  const clientTwo = await makeClient(agencyId, 'Theta Two');

  const keep = await makeWorkspace(clientOne.clientId, 'Theta Keep');
  const tombstone = await makeWorkspace(clientOne.clientId, 'Theta Gone');
  await makeWorkspace(clientTwo.clientId, 'Theta Other Client Workspace');

  const deleted = await apiCall(port(), `/api/workspaces/${tombstone.workspaceId}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(deleted.status, 200);

  const listOne = await apiCall(port(), `/api/clients/${clientOne.clientId}/workspaces`, {
    token: ownerA.token,
  });
  assert.equal(listOne.status, 200);
  const workspacesOne = listOne.body['workspaces'] as Record<string, unknown>[];
  assert.deepEqual(
    workspacesOne.map((workspace) => workspace['workspaceId']).sort(),
    [keep.workspaceId].sort(),
    'tombstones excluded; other clients\' workspaces never visible',
  );
  assert.equal(listOne.body['clientId'], clientOne.clientId);

  const listTwo = await apiCall(port(), `/api/clients/${clientTwo.clientId}/workspaces`, {
    token: ownerA.token,
  });
  const workspacesTwo = listTwo.body['workspaces'] as Record<string, unknown>[];
  assert.equal(workspacesTwo.length, 1, 'client two sees exactly its own workspace');
  assert.notEqual(
    workspacesTwo[0]!['workspaceId'],
    keep.workspaceId,
    'client one\'s workspace never leaks into client two\'s list',
  );

  // Unknown/deleted CLIENT on the list route → 404 (no oracle).
  const unknownClientList = await apiCall(
    port(),
    '/api/clients/00000000-0000-0000-0000-0000000000aa/workspaces',
    { token: ownerA.token },
  );
  assert.equal(unknownClientList.status, 404);
});

test('workspace lifecycle follows the frozen table; disabling blocks new use without rewriting history (MKT-004-AC-06)', async () => {
  const owner = await makeUser('owner8@kappa.test', 'Kappa Owner', 'kappa-password-12');
  const agencyId = await makeAgency('Kappa Agency', owner);
  const client = await makeClient(agencyId, 'Kappa Retail');
  const workspace = await makeWorkspace(client.clientId, 'Kappa Growth');
  const before = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: owner.token,
  });
  const createdAt = before.body['createdAt'] as string;
  const createdBy = before.body['createdBy'] as string;

  // active → active is illegal (no self-transitions).
  const self = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(self.status, 409, 'self-transition rejected');

  // Disable: new authorized use is blocked...
  const disabled = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body['status'], 'disabled');

  const profileOnDisabled = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}/profile`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { name: 'Nope', version: 2 },
    },
  );
  assert.equal(profileOnDisabled.status, 409, 'disabled workspace blocks profile mutation');

  // ...but history is NOT rewritten: the record and its provenance survive.
  const readDisabled = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: owner.token,
  });
  assert.equal(readDisabled.status, 200, 'history remains readable');
  assert.equal(readDisabled.body['createdAt'], createdAt, 'created_at untouched');
  assert.equal(readDisabled.body['createdBy'], createdBy, 'provenance untouched');

  // Re-enable is the explicit recovery path; the frozen table allows it.
  const reenabled = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(reenabled.status, 200);
  assert.equal(reenabled.body['status'], 'active');

  const profileAfterReenable = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}/profile`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { name: 'Kappa Growth Renamed', version: 3 },
    },
  );
  assert.equal(profileAfterReenable.status, 200, 'active workspace accepts mutations again');

  // Illegal body shape on the lifecycle route (name/slug are authority fields).
  const badShape = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 4, name: 'Smuggled' },
  });
  assert.equal(badShape.status, 422);
});

test('Client lifecycle policy fences Workspaces without rewriting history (MKT-004-AC-06)', async () => {
  const owner = await makeUser('owner9@lambda.test', 'Lambda Owner', 'lambda-password-12');
  const agencyId = await makeAgency('Lambda Agency', owner);
  const client = await makeClient(agencyId, 'Lambda Retail');
  const workspace = await makeWorkspace(client.clientId, 'Lambda Growth');
  const before = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: owner.token,
  });
  const createdAt = before.body['createdAt'] as string;

  // Disable the CLIENT: existing workspace reads stay available...
  const disabled = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disabled.status, 200);

  const readUnderDisabledClient = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}`,
    { token: owner.token },
  );
  assert.equal(
    readUnderDisabledClient.status,
    200,
    'history remains readable under a disabled client',
  );
  assert.equal(readUnderDisabledClient.body['createdAt'], createdAt, 'history untouched');

  // ...new use is blocked: create → 409...
  const createOnDisabled = await apiCall(
    port(),
    `/api/clients/${client.clientId}/workspaces`,
    { token: owner.token, body: { name: 'Should Not Create' } },
  );
  assert.equal(createOnDisabled.status, 409, 'disabled client blocks new workspace creation');

  // ...workspace mutations → 409...
  const profileOnDisabledClient = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}/profile`,
    { token: owner.token, method: 'PATCH', body: { name: 'Blocked', version: 1 } },
  );
  assert.equal(profileOnDisabledClient.status, 409, 'disabled client blocks workspace mutations');

  // ...and (re-)enabling a workspace under a disabled client → 409 (a
  // workspace may never resurrect Client authority for new use).
  const disableWorkspace = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}/status`,
    { token: owner.token, method: 'PATCH', body: { status: 'disabled', version: 1 } },
  );
  assert.equal(disableWorkspace.status, 200, 'shrinking transition allowed under disabled client');
  const enableUnderDisabledClient = await apiCall(
    port(),
    `/api/workspaces/${workspace.workspaceId}/status`,
    { token: owner.token, method: 'PATCH', body: { status: 'active', version: 2 } },
  );
  assert.equal(
    enableUnderDisabledClient.status,
    409,
    'workspace cannot resurrect disabled-client authority',
  );

  // DELETE the client: every workspace route is a uniform 404 — the
  // tombstone client never resolves, so its workspaces cannot be used to
  // resurrect access.
  const del = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 2 },
  });
  assert.equal(del.status, 200);

  for (const [pathName, method, body] of [
    [`/api/workspaces/${workspace.workspaceId}`, 'GET', undefined],
    [`/api/workspaces/${workspace.workspaceId}/ownership-context`, 'GET', undefined],
    [
      `/api/workspaces/${workspace.workspaceId}/profile`,
      'PATCH',
      { name: 'Resurrect', version: 3 },
    ],
    [
      `/api/workspaces/${workspace.workspaceId}/status`,
      'PATCH',
      { status: 'active', version: 3 },
    ],
    [`/api/clients/${client.clientId}/workspaces`, 'GET', undefined],
    [`/api/clients/${client.clientId}/workspaces`, 'POST', { name: 'Resurrect' }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: owner.token,
      method,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 404, `${method} ${pathName} must be 404 under a tombstoned client`);
  }

  // The workspace ROW survives as history with its immutable ownership (the
  // client tombstone is not rewritten either).
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ status: string; client_id: string }>(
      'SELECT status, client_id FROM workspaces WHERE workspace_id = $1',
      [workspace.workspaceId],
    );
    assert.equal(rows.rows.length, 1, 'workspace history preserved');
    assert.equal(rows.rows[0]!.status, 'disabled');
    assert.equal(rows.rows[0]!.client_id, client.clientId, 'ownership survives client deletion');
  } finally {
    await db.close();
  }
});

test('a deleted Workspace is a terminal tombstone — stale identifiers never resurrect (MKT-004-AC-06)', async () => {
  const owner = await makeUser('owner10@mu.test', 'Mu Owner', 'mu-password-12');
  const agencyId = await makeAgency('Mu Agency', owner);
  const client = await makeClient(agencyId, 'Mu Retail');
  const workspace = await makeWorkspace(client.clientId, 'Doomed Room', 'doomed-room');

  const del = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(del.status, 200);

  // Every replay of the stale identifier fails closed.
  const read = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: owner.token,
  });
  assert.equal(read.status, 404);
  const resurrect = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(resurrect.status, 404, 'resurrection through the API is impossible');

  // The tombstone row survives as history with its immutable identity.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ status: string; client_id: string }>(
      'SELECT status, client_id FROM workspaces WHERE workspace_id = $1',
      [workspace.workspaceId],
    );
    assert.equal(rows.rows.length, 1, 'history preserved');
    assert.equal(rows.rows[0]!.status, 'deleted');
    assert.equal(rows.rows[0]!.client_id, client.clientId, 'ownership survives deletion');
  } finally {
    await db.close();
  }

  // A NEW workspace may reuse the slug — with a NEW immutable identity.
  const successor = await makeWorkspace(client.clientId, 'Doomed Room Reborn', 'doomed-room');
  assert.notEqual(successor.workspaceId, workspace.workspaceId, 'new identity, not a resurrection');
  const oldStillDead = await apiCall(port(), `/api/workspaces/${workspace.workspaceId}`, {
    token: owner.token,
  });
  assert.equal(oldStillDead.status, 404, 'the old identifier stays dead');
});
