/**
 * MKT-003 integration test — Client API contract on a real PostgreSQL +
 * real API subprocess:
 *
 *   - TENANT-AC-01: an Agency can own multiple Clients with distinct
 *     immutable Client identities (rows verified directly in the database);
 *   - TENANT-AC-02: Client identity, ownership, provenance and timestamps
 *     are server-derived; caller-supplied authority fields are rejected;
 *   - MKT-003-AC-01: the canonical owner context is resolved server-side
 *     from durable state and exposed read-only;
 *   - MKT-003-AC-03: the frozen lifecycle (disable blocks new use without
 *     rewriting history; delete is a terminal tombstone);
 *   - read/mutation authorization matrix incl. platform admin and the
 *     internal service principal; correlated §23 records for material
 *     mutations.
 *
 * Cross-tenant isolation and concurrency proofs live in
 * client-isolation.test.ts / client-concurrency.test.ts.
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

before(async () => {
  stack = await bootStack('clientsapi');
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

test('an Agency can own multiple Clients with distinct immutable identities (TENANT-AC-01)', async () => {
  const owner = await makeUser('owner@acme.test', 'Acme Owner', 'owner-password-123');
  const agencyId = await makeAgency('Acme & Co Ltd', owner);

  const first = await makeClient(agencyId, 'Acme Retail');
  const second = await makeClient(agencyId, 'Acme Wholesale');
  const third = await makeClient(agencyId, 'Acme Direct');

  assert.ok(first.clientId !== second.clientId && second.clientId !== third.clientId);
  for (const client of [first, second, third]) {
    assert.equal(client.clientId.length, 36, 'server-generated uuid identity');
  }

  // Database verification: every Client row carries the SAME agency ownership
  // and a DISTINCT identity.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ client_id: string; agency_id: string; status: string }>(
      'SELECT client_id, agency_id, status FROM clients WHERE agency_id = $1 ORDER BY created_at',
      [agencyId],
    );
    assert.equal(rows.rows.length, 3, 'all three clients persisted under the agency');
    assert.deepEqual(
      rows.rows.map((row) => row.agency_id),
      [agencyId, agencyId, agencyId],
      'Agency→Client ownership on every row',
    );
    assert.equal(new Set(rows.rows.map((row) => row.client_id)).size, 3, 'distinct identities');
    for (const row of rows.rows) {
      assert.equal(row.status, 'active');
    }
  } finally {
    await db.close();
  }

  // All three are listed for agency members.
  const list = await apiCall(port(), `/api/agencies/${agencyId}/clients`, { token: owner.token });
  assert.equal(list.status, 200);
  assert.equal((list.body['clients'] as unknown[]).length, 3);

  // Per-tenant uniqueness: ANOTHER agency may own a client with the same slug.
  const otherOwner = await makeUser('owner@zenith.test', 'Zenith Owner', 'zenith-password-1');
  const otherAgency = await makeAgency('Zenith Group', otherOwner);
  const sameSlug = await makeClient(otherAgency, 'Acme Retail');
  assert.equal(sameSlug.clientId !== first.clientId, true, 'distinct identity across agencies');
});

test('client creation derives server-authoritative fields and rejects authority/unknown fields (TENANT-AC-02)', async () => {
  const owner = await makeUser('owner2@beta.test', 'Beta Owner', 'beta-password-12');
  const agencyId = await makeAgency('Beta Agency', owner);

  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: owner.token,
    body: { name: 'Beta Retail' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body['agencyId'], agencyId, 'ownership from the PATH, not the body');
  assert.equal(created.body['status'], 'active', 'status is server-derived');
  assert.equal(created.body['version'], 1, 'version is server-derived');
  assert.equal(created.body['slug'], 'beta-retail', 'slug derived from the name');
  assert.ok(typeof created.body['createdAt'] === 'string');
  assert.ok(typeof created.body['updatedAt'] === 'string');
  assert.equal(created.body['createdBy'], owner.userId, 'provenance is the server-derived caller');

  // Authority/unknown fields in the body are rejected, never trusted.
  for (const body of [
    { name: 'X', clientId: '00000000-0000-0000-0000-000000000001' },
    { name: 'X', agencyId: '00000000-0000-0000-0000-000000000002' },
    { name: 'X', status: 'active' },
    { name: 'X', version: 7 },
    { name: 'X', createdBy: '00000000-0000-0000-0000-000000000003' },
    { name: 'X', createdAt: '2020-01-01T00:00:00Z' },
    { name: 'X', updatedAt: '2020-01-01T00:00:00Z' },
    { name: 'X', workspaceId: '00000000-0000-0000-0000-000000000004' },
    { name: 'X', tenantId: '00000000-0000-0000-0000-000000000005' },
  ]) {
    const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
      token: owner.token,
      body,
    });
    assert.equal(response.status, 422, `authority field must be rejected: ${JSON.stringify(body)}`);
  }

  // Slug validation when explicitly supplied.
  const badSlug = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: owner.token,
    body: { name: 'Whatever', slug: 'Not A Slug!' },
  });
  assert.equal(badSlug.status, 422);
});

test('client read follows the authorization matrix (member roles | platform admin | service | stranger | anonymous)', async () => {
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

  // Every active member role may READ the client (incl. collaborator — the
  // client-scoped role). Reads stay intra-agency.
  for (const user of [owner, operator, collaborator]) {
    const read = await apiCall(port(), `/api/clients/${client.clientId}`, { token: user.token });
    assert.equal(read.status, 200, `member read for ${user.userId}`);
  }
  // Platform administrator (platform operator semantics, mirrors /agencies).
  const platformRead = await apiCall(port(), `/api/clients/${client.clientId}`, { token: admin });
  assert.equal(platformRead.status, 200);
  // Internal service principal.
  const serviceRead = await apiCall(port(), `/api/clients/${client.clientId}`, {
    token: stack!.env.internalApiToken,
  });
  assert.equal(serviceRead.status, 200);
  // Stranger (member of ANOTHER agency) → hard-boundary 404.
  const strangerRead = await apiCall(port(), `/api/clients/${client.clientId}`, {
    token: stranger.token,
  });
  assert.equal(strangerRead.status, 404);
  // Anonymous → 401 before authorization.
  const anonymousRead = await apiCall(port(), `/api/clients/${client.clientId}`, {});
  assert.equal(anonymousRead.status, 401);

  // Platform admin can also CREATE (operator semantics).
  const platformCreate = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: admin,
    body: { name: 'Platform-Created Client' },
  });
  assert.equal(platformCreate.status, 201);
});

test('client profile update is CAS-guarded, owner/admin-only, slug-immutable', async () => {
  const owner = await makeUser('owner4@epsilon.test', 'Epsilon Owner', 'epsilon-pass-12');
  const operator = await makeUser('op4@epsilon.test', 'Epsilon Operator', 'epsilon-op-pass-1');
  const agencyId = await makeAgency('Epsilon Agency', owner);
  const addOperator = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(addOperator.status, 201);
  const client = await makeClient(agencyId, 'Epsilon Retail');

  const updated = await apiCall(port(), `/api/clients/${client.clientId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Epsilon Retail Renamed', version: client.version },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body['name'], 'Epsilon Retail Renamed');
  assert.equal(updated.body['version'], client.version + 1, 'CAS version bump');
  assert.equal(updated.body['slug'], 'epsilon-retail', 'slug is immutable');

  // Stale version → 409 (CAS loss).
  const stale = await apiCall(port(), `/api/clients/${client.clientId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Stale Update', version: client.version },
  });
  assert.equal(stale.status, 409);

  // Wrong agency role (operator) → 403.
  const asOperator = await apiCall(port(), `/api/clients/${client.clientId}/profile`, {
    token: operator.token,
    method: 'PATCH',
    body: { name: 'Operator Update', version: client.version + 1 },
  });
  assert.equal(asOperator.status, 403);

  // Slug/authority fields in the body → 422.
  for (const body of [
    { name: 'X', version: 2, slug: 'new-slug' },
    { name: 'X', version: 2, agencyId: '00000000-0000-0000-0000-000000000009' },
    { name: 'X', version: 2, status: 'active' },
    { name: 'X', version: 2, workspaceId: '00000000-0000-0000-0000-000000000010' },
  ]) {
    const response = await apiCall(port(), `/api/clients/${client.clientId}/profile`, {
      token: owner.token,
      method: 'PATCH',
      body,
    });
    assert.equal(response.status, 422, `profile authority field rejected: ${JSON.stringify(body)}`);
  }
});

test('the canonical ownership-context resolves server-side from durable state (MKT-003-AC-01)', async () => {
  const owner = await makeUser('owner5@zeta.test', 'Zeta Owner', 'zeta-password-12');
  const agencyId = await makeAgency('Zeta Agency', owner);
  const client = await makeClient(agencyId, 'Zeta Client');

  const context = await apiCall(port(), `/api/clients/${client.clientId}/ownership-context`, {
    token: owner.token,
  });
  assert.equal(context.status, 200, JSON.stringify(context.body));

  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'client');
  assert.equal(scope['agencyId'], agencyId);
  assert.equal(scope['clientId'], client.clientId);

  const contextClient = context.body['client'] as Record<string, unknown>;
  assert.equal(contextClient['agencyId'], agencyId, 'ownership derived from the client ROW');
  assert.equal(contextClient['status'], 'active');

  const contextAgency = context.body['agency'] as Record<string, unknown>;
  assert.equal(contextAgency['agencyId'], agencyId);
  assert.equal(contextAgency['slug'], 'zeta-agency');
  assert.equal(contextAgency['status'], 'active');
  assert.ok(typeof context.body['resolvedAt'] === 'string');

  // The owning agency's STATUS is durable state — changing it is reflected in
  // a FRESH resolution (no cache between calls). Agency slug is immutable by
  // design (MKT-002), so status is the mutable dimension here.
  const admin = await adminToken();
  const agency = await apiCall(port(), `/api/agencies/${agencyId}`, { token: admin });
  const disabled = await apiCall(port(), `/api/agencies/${agencyId}/status`, {
    token: admin,
    method: 'PATCH',
    body: { status: 'disabled', version: agency.body['version'] as number },
  });
  assert.equal(disabled.status, 200);
  const contextAfter = await apiCall(port(), `/api/clients/${client.clientId}/ownership-context`, {
    token: owner.token,
  });
  const agencyAfter = contextAfter.body['agency'] as Record<string, unknown>;
  assert.equal(agencyAfter['status'], 'disabled', 'fresh durable resolution on every call');
  assert.equal(agencyAfter['slug'], 'zeta-agency', 'slug remains the durable immutable anchor');

  // Re-enable to leave the fixture in a clean state.
  const reenabled = await apiCall(port(), `/api/agencies/${agencyId}/status`, {
    token: admin,
    method: 'PATCH',
    body: { status: 'active', version: disabled.body['version'] as number },
  });
  assert.equal(reenabled.status, 200);
});

test('client material mutations emit correlated structured records (§23)', async () => {
  const owner = await makeUser('owner6@eta.test', 'Eta Owner', 'eta-password-123');
  const agencyId = await makeAgency('Eta Agency', owner);
  const correlationId = '7c3d5e1f-0a9b-8c7d-6e5f-4a3b2c1d0e9f';

  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: owner.token,
    body: { name: 'Eta Client' },
    correlationId,
  });
  assert.equal(created.status, 201);
  const clientId = created.body['clientId'] as string;

  const updated = await apiCall(port(), `/api/clients/${clientId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Eta Client Renamed', version: 1 },
    correlationId,
  });
  assert.equal(updated.status, 200);
  const statusChanged = await apiCall(port(), `/api/clients/${clientId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 2 },
    correlationId,
  });
  assert.equal(statusChanged.status, 200);

  await sleep(150); // structured records are flushed asynchronously
  const records = api!.logRecords();
  for (const event of [
    'clients.client.created',
    'clients.client.profile_updated',
    'clients.client.status_changed',
  ]) {
    const saw = records.some(
      (record) => record.event === event && record.correlation_id === correlationId,
    );
    assert.ok(saw, `${event} record carries the request correlation id`);
  }
});

test('listing is agency-scoped: only the caller agency\'s LIVE clients are visible', async () => {
  const ownerA = await makeUser('owner7@theta.test', 'Theta Owner', 'theta-password-12');
  const ownerB = await makeUser('owner7@iota.test', 'Iota Owner', 'iota-password-123');
  const agencyA = await makeAgency('Theta Agency', ownerA);
  const agencyB = await makeAgency('Iota Agency', ownerB);

  const keep = await makeClient(agencyA, 'Theta Keep');
  const tombstone = await makeClient(agencyA, 'Theta Gone');
  await makeClient(agencyB, 'Iota Only');

  const deleted = await apiCall(port(), `/api/clients/${tombstone.clientId}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'deleted', version: 1 },
  });
  assert.equal(deleted.status, 200);

  const listA = await apiCall(port(), `/api/agencies/${agencyA}/clients`, { token: ownerA.token });
  assert.equal(listA.status, 200);
  const clientsA = listA.body['clients'] as Record<string, unknown>[];
  assert.deepEqual(
    clientsA.map((client) => client['clientId']).sort(),
    [keep.clientId].sort(),
    'tombstones excluded; other agencies never visible',
  );
});

test('client lifecycle follows the frozen table; disabling blocks new use without rewriting history (MKT-003-AC-03)', async () => {
  const owner = await makeUser('owner8@kappa.test', 'Kappa Owner', 'kappa-password-12');
  const agencyId = await makeAgency('Kappa Agency', owner);
  const client = await makeClient(agencyId, 'Kappa Retail');
  const createdFields = {
    createdAt: '' as string,
    createdBy: '' as string,
  };
  const before = await apiCall(port(), `/api/clients/${client.clientId}`, { token: owner.token });
  createdFields.createdAt = before.body['createdAt'] as string;
  createdFields.createdBy = before.body['createdBy'] as string;

  // active → active is illegal (no self-transitions).
  const self = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(self.status, 409, 'self-transition rejected');

  // Disable: new authorized use is blocked...
  const disabled = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body['status'], 'disabled');

  const profileOnDisabled = await apiCall(port(), `/api/clients/${client.clientId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Nope', version: 2 },
  });
  assert.equal(profileOnDisabled.status, 409, 'disabled client blocks profile mutation');

  // ...but history is NOT rewritten: the record and its provenance survive.
  const readDisabled = await apiCall(port(), `/api/clients/${client.clientId}`, {
    token: owner.token,
  });
  assert.equal(readDisabled.status, 200, 'history remains readable');
  assert.equal(readDisabled.body['createdAt'], createdFields.createdAt, 'created_at untouched');
  assert.equal(readDisabled.body['createdBy'], createdFields.createdBy, 'provenance untouched');

  // Re-enable is the explicit recovery path; the frozen table allows it.
  const reenabled = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(reenabled.status, 200);
  assert.equal(reenabled.body['status'], 'active');

  const profileAfterReenable = await apiCall(port(), `/api/clients/${client.clientId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Kappa Retail Renamed', version: 3 },
  });
  assert.equal(profileAfterReenable.status, 200, 'active client accepts mutations again');

  // Illegal body shape on the lifecycle route (name/slug are authority fields).
  const badShape = await apiCall(port(), `/api/clients/${client.clientId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 4, name: 'Smuggled' },
  });
  assert.equal(badShape.status, 422);
});

test('creating a client under a disabled Agency is rejected (agency lifecycle fences new tenants)', async () => {
  const owner = await makeUser('owner9@lambda.test', 'Lambda Owner', 'lambda-password-12');
  const agencyId = await makeAgency('Lambda Agency', owner);
  await makeClient(agencyId, 'Lambda Client');

  const admin = await adminToken();
  const agency = await apiCall(port(), `/api/agencies/${agencyId}`, { token: admin });
  const disabled = await apiCall(port(), `/api/agencies/${agencyId}/status`, {
    token: admin,
    method: 'PATCH',
    body: { status: 'disabled', version: agency.body['version'] as number },
  });
  assert.equal(disabled.status, 200);

  const createOnDisabled = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: owner.token,
    body: { name: 'Should Not Create' },
  });
  assert.equal(createOnDisabled.status, 409, 'disabled agency blocks new client creation');
});
