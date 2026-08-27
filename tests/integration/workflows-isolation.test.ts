/**
 * MKT-008 security/isolation integration test — the Workflow graph model
 * domain inside the tenant boundaries (real PostgreSQL + real API
 * subprocess).
 *
 * Proofs (cross-tenant posture; security-threat-model "Cross-tenant
 * traversal": negative tests using two Agencies / two Clients / two
 * Workspaces):
 *   - a foreign Workflow identifier (owned by ANOTHER Agency) yields the
 *     SAME 404 as an unknown one — no traversal/existence oracle, and the
 *     rejection happens BEFORE any dependent traversal (no
 *     material-mutation events, no data changes under PARALLEL probes);
 *   - a workflow of another Client in the SAME agency never leaks through
 *     Workspace listing routes (data-level boundary);
 *   - a Workflow cannot be created under a Workspace of ANOTHER Agency or
 *     an unknown Workspace (uniform 404 — the workspace path segment is
 *     not a traversal);
 *   - a foreign definition identifier under a foreign workflow is the
 *     same uniform 404 (the explicit version reference never leaks);
 *   - forged authority headers, body fields and query parameters cannot
 *     elevate or change the canonical owner scope;
 *   - membership WITHOUT the required role is rejected server-side (403);
 *   - stale membership state (disabled/revoked) loses access immediately,
 *     derived from durable state — proven across an API process RESTART;
 *   - a deleted Workspace tombstone makes every workflow route a uniform
 *     404 (a Workflow can never resurrect tombstoned Workspace authority);
 *   - direct-database re-parenting of a Workflow across the Workspace/
 *     Client/Agency boundaries is rejected by the immutability and
 *     scope-chain triggers; the definition version identity and the
 *     playbook provenance link can never be reassigned — the database
 *     backstops;
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

function nodeBody(nodeId: string, nodeType: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId,
    nodeType,
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
    ...overrides,
  };
}

function definitionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    graph: {
      nodes: [nodeBody('a', 'function'), nodeBody('t', 'terminal')],
      edges: [{ fromNode: 'a', toNode: 't', edgeType: 'success', predicateRef: null, joinSemantics: null }],
    },
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
    ...overrides,
  };
}

async function makeWorkflow(workspaceId: string, name: string, token: string): Promise<string> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name },
  });
  assert.equal(response.status, 201, `create workflow: ${JSON.stringify(response.body)}`);
  return response.body['workflowId'] as string;
}

async function makeDefinition(workflowId: string, token: string): Promise<string> {
  const response = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token,
    body: definitionBody(),
  });
  assert.equal(response.status, 201, `create definition: ${JSON.stringify(response.body)}`);
  return response.body['workflowDefinitionId'] as string;
}

const ownerA: User = { userId: '', token: '' };
const memberA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let workspaceA1 = '';
let workspaceA2 = '';
let workspaceB = '';
let workflowA1 = '';
let workflowB = '';
let definitionB = '';

before(async () => {
  stack = await bootStack('workflowisolation');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(ownerA, await makeUser('owner-a@workflows.test', 'Agency A Owner', 'isolation-owner-a-pass'));
  Object.assign(memberA, await makeUser('member-a@workflows.test', 'Agency A Member', 'isolation-member-a-pass'));
  Object.assign(ownerB, await makeUser('owner-b@workflows.test', 'Agency B Owner', 'isolation-owner-b-pass'));

  agencyA = await makeAgency('Isolation Agency A', ownerA);
  agencyB = await makeAgency('Isolation Agency B', ownerB);

  const membership = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: await adminToken(),
    body: { userId: memberA.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);

  clientA1 = await makeClient(agencyA, 'Client A1');
  clientA2 = await makeClient(agencyA, 'Client A2');
  workspaceA1 = await makeWorkspace(clientA1, 'Workspace A1');
  workspaceA2 = await makeWorkspace(clientA2, 'Workspace A2');
  workspaceB = await makeWorkspace(await makeClient(agencyB, 'Client B'), 'Workspace B');

  workflowA1 = await makeWorkflow(workspaceA1, 'Agency A Workflow', ownerA.token);
  workflowB = await makeWorkflow(workspaceB, 'Agency B Workflow', ownerB.token);
  definitionB = await makeDefinition(workflowB, ownerB.token);
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a foreign Workflow identifier yields the SAME 404 as an unknown one — no traversal/existence oracle', async () => {
  const foreign = await apiCall(port(), `/api/workflows/${workflowB}`, { token: ownerA.token });
  const unknown = await apiCall(port(), '/api/workflows/00000000-0000-4000-8000-000000000000', {
    token: ownerA.token,
  });
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  // Shape-equal payloads (the message echoes the probed id by design).
  assert.equal(
    (foreign.body['error'] as Record<string, unknown>)['code'],
    (unknown.body['error'] as Record<string, unknown>)['code'],
  );

  // Every workflow-scoped surface repeats the posture.
  for (const path of [
    `/api/workflows/${workflowB}/ownership-context`,
    `/api/workflows/${workflowB}/definitions`,
    `/api/workflows/${workflowB}/definitions/${definitionB}`,
    `/api/workflows/${workflowB}/profile`,
  ]) {
    const method = path.endsWith('/profile') ? 'PATCH' : 'GET';
    const body = method === 'PATCH' ? { name: 'Hijack', version: 1 } : undefined;
    const probe = await apiCall(port(), path, { token: ownerA.token, method, body });
    assert.equal(probe.status, 404, `${path} must be a uniform 404 for a foreign workflow`);
  }
});

test('parallel foreign probes cause zero traversal side effects', async () => {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const before = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workflows WHERE workflow_id = $1`,
      [workflowB],
    );
    const beforeDefinitions = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workflow_definitions WHERE workflow_id = $1`,
      [workflowB],
    );
    const beforeAudit = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE agency_id = $1`,
      [agencyB],
    );

    const probes = await Promise.all(
      Array.from({ length: 8 }, () =>
        apiCall(port(), `/api/workflows/${workflowB}/definitions`, {
          token: memberA.token,
          body: definitionBody(),
        }),
      ),
    );
    for (const probe of probes) {
      assert.equal(probe.status, 404);
    }

    const after = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workflows WHERE workflow_id = $1`,
      [workflowB],
    );
    const afterDefinitions = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workflow_definitions WHERE workflow_id = $1`,
      [workflowB],
    );
    const afterAudit = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE agency_id = $1`,
      [agencyB],
    );
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
    assert.equal(afterDefinitions.rows[0]!.count, beforeDefinitions.rows[0]!.count);
    assert.equal(afterAudit.rows[0]!.count, beforeAudit.rows[0]!.count);
  } finally {
    await db.close();
  }
});

test('a Workflow cannot be created under a Workspace of ANOTHER Agency or an unknown Workspace (uniform 404)', async () => {
  const foreignWorkspace = await apiCall(port(), `/api/workspaces/${workspaceB}/workflows`, {
    token: ownerA.token,
    body: { name: 'Cross-tenant workflow' },
  });
  assert.equal(foreignWorkspace.status, 404);
  const unknownWorkspace = await apiCall(port(), '/api/workspaces/00000000-0000-4000-8000-000000000000/workflows', {
    token: ownerA.token,
    body: { name: 'Unknown workspace workflow' },
  });
  assert.equal(unknownWorkspace.status, 404);
});

test('listing surfaces never leak foreign workflows (data-level boundaries)', async () => {
  // A workflow of another Client's workspace in the SAME agency exists…
  const workflowA2 = await makeWorkflow(workspaceA2, 'Client A2 Workflow', ownerA.token);
  // …but Workspace A1 lists only its own workflows (not A2's, not B's).
  const listA1 = await apiCall(port(), `/api/workspaces/${workspaceA1}/workflows`, {
    token: memberA.token,
  });
  assert.equal(listA1.status, 200);
  const idsA1 = (listA1.body['workflows'] as Record<string, unknown>[]).map(
    (workflow) => workflow['workflowId'],
  );
  assert.deepEqual(idsA1, [workflowA1]);
  // And Workspace A2 lists only its own.
  const listA2 = await apiCall(port(), `/api/workspaces/${workspaceA2}/workflows`, {
    token: memberA.token,
  });
  assert.equal(listA2.status, 200);
  assert.deepEqual(
    (listA2.body['workflows'] as Record<string, unknown>[]).map((w) => w['workflowId']),
    [workflowA2],
  );

  // Agency B's member never lists Agency A's workspace.
  const listB = await apiCall(port(), `/api/workspaces/${workspaceA1}/workflows`, {
    token: ownerB.token,
  });
  assert.equal(listB.status, 404);
});

test('forged authority headers, body fields and query parameters cannot change the canonical owner scope', async () => {
  // Forged body fields on create: identity/scope are rejected as
  // authority fields (never accepted, never honored).
  const forged = await apiCall(port(), `/api/workspaces/${workspaceA1}/workflows`, {
    token: ownerA.token,
    body: {
      name: 'Forged scope',
      workflowId: '00000000-0000-4000-8000-0000000000ff',
      workspaceId: workspaceB,
      clientId: clientA2,
      agencyId: agencyB,
      version: 42,
      createdBy: ownerB.userId,
    },
  });
  assert.equal(forged.status, 422);
  const details = ((forged.body['error'] as Record<string, unknown>)['details'] as string[]).join(' ');
  assert.ok(details.includes('forbidden authority field'), details);

  // Forged headers are inert: the canonical owner is resolved from durable
  // state, never from the request.
  const headerProbe = await apiCall(port(), `/api/workflows/${workflowA1}`, {
    token: memberA.token,
    headers: { 'x-mos-agency-id': agencyB, 'x-mos-client-id': clientA2, 'x-mos-workspace-id': workspaceB },
  });
  assert.equal(headerProbe.status, 200);
  assert.equal(headerProbe.body['agencyId'], agencyA);
  assert.equal(headerProbe.body['clientId'], clientA1);
  assert.equal(headerProbe.body['workspaceId'], workspaceA1);

  // Forged authority fields on definition create are rejected too.
  const forgedDefinition = await apiCall(port(), `/api/workflows/${workflowA1}/definitions`, {
    token: ownerA.token,
    body: {
      ...definitionBody(),
      workflowDefinitionId: '00000000-0000-4000-8000-0000000000fe',
      versionNumber: 999,
      status: 'active',
    },
  });
  assert.equal(forgedDefinition.status, 422);
});

test('membership without the required role is rejected server-side (403)', async () => {
  // agency_operator may read but not create workflows.
  const read = await apiCall(port(), `/api/workflows/${workflowA1}`, { token: memberA.token });
  assert.equal(read.status, 200);
  const create = await apiCall(port(), `/api/workspaces/${workspaceA1}/workflows`, {
    token: memberA.token,
    body: { name: 'Operator attempt' },
  });
  assert.equal(create.status, 403);
});

test('stale membership loses access immediately, derived from durable state — proven across an API process RESTART', async () => {
  const staleUser = await makeUser('stale@workflows.test', 'Stale Member', 'isolation-stale-pass');
  const membership = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: await adminToken(),
    body: { userId: staleUser.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  const membershipId = membership.body['membershipId'] as string;
  const membershipVersion = membership.body['version'] as number;

  const before = await apiCall(port(), `/api/workflows/${workflowA1}`, { token: staleUser.token });
  assert.equal(before.status, 200);

  // Suspend the membership (CAS on the membership route).
  const disable = await apiCall(port(), `/api/agencies/${agencyA}/memberships/${membershipId}`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'disabled', version: membershipVersion },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));

  const afterDisable = await apiCall(port(), `/api/workflows/${workflowA1}`, { token: staleUser.token });
  assert.equal(afterDisable.status, 403);

  // RESTART the API process: authorization still derives from durable
  // state, never from process-local caches.
  api?.child.kill('SIGKILL');
  api = await spawnApi(stack!.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  adminTokenCache = null;
  const afterRestart = await apiCall(port(), `/api/workflows/${workflowA1}`, { token: staleUser.token });
  assert.equal(afterRestart.status, 403);
});

test('a deleted Workspace tombstone makes every workflow route a uniform 404', async () => {
  const tombstoneClient = await makeClient(agencyA, 'Tombstone Client');
  const tombstoneWorkspace = await makeWorkspace(tombstoneClient, 'Tombstone Workspace');
  const workflow = await makeWorkflow(tombstoneWorkspace, 'Doomed Workflow', ownerA.token);
  const definition = await makeDefinition(workflow, ownerA.token);

  const read = await apiCall(port(), `/api/workspaces/${tombstoneWorkspace}`, { token: ownerA.token });
  const deleteWorkspace = await apiCall(port(), `/api/workspaces/${tombstoneWorkspace}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'deleted', version: read.body['version'] },
  });
  assert.equal(deleteWorkspace.status, 200, JSON.stringify(deleteWorkspace.body));

  for (const path of [
    `/api/workflows/${workflow}`,
    `/api/workflows/${workflow}/ownership-context`,
    `/api/workflows/${workflow}/definitions`,
    `/api/workflows/${workflow}/definitions/${definition}`,
    `/api/workflows/${workflow}/profile`,
    `/api/workspaces/${tombstoneWorkspace}/workflows`,
  ]) {
    const method = path.endsWith('/profile') ? 'PATCH' : 'GET';
    const body = method === 'PATCH' ? { name: 'Resurrect', version: 1 } : undefined;
    const probe = await apiCall(port(), path, { token: ownerA.token, method, body });
    assert.equal(probe.status, 404, `${path} must be a uniform 404 after the workspace tombstone`);
  }
});

test('direct-database re-parenting is rejected: Workspace scope, Client/Agency ownership, version identity and playbook provenance are immutable', async () => {
  const workflow = await makeWorkflow(workspaceA1, 'DB Backstop Workflow', ownerA.token);
  const definition = await makeDefinition(workflow, ownerA.token);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () =>
        db.query('UPDATE workflows SET workspace_id = $1 WHERE workflow_id = $2', [workspaceB, workflow]),
      /cannot change Workspace scope/,
    );
    await assert.rejects(
      () => db.query('UPDATE workflows SET agency_id = $1 WHERE workflow_id = $2', [agencyB, workflow]),
      /cannot change Agency ownership|does not belong to agency/,
    );
    await assert.rejects(
      () =>
        db.query('UPDATE workflow_definitions SET workflow_id = $1 WHERE workflow_definition_id = $2', [
          workflowB,
          definition,
        ]),
      /cannot change workflow ownership/,
    );
    await assert.rejects(
      () =>
        db.query(
          'UPDATE workflow_definitions SET playbook_version_id = $1 WHERE workflow_definition_id = $2',
          ['00000000-0000-4000-8000-000000000000', definition],
        ),
      /playbook provenance is immutable|not usable by this workflow client/,
    );
    await assert.rejects(
      () =>
        db.query('UPDATE workflow_definitions SET created_by = $1 WHERE workflow_definition_id = $2', [
          ownerB.userId,
          definition,
        ]),
      /provenance is immutable/,
    );
  } finally {
    await db.close();
  }
});

test('created_by provenance is never an authorization path', async () => {
  // ownerB is the creator of nothing here; a workflow created by ownerA
  // stays invisible to ownerB regardless of any creator claim.
  const probe = await apiCall(port(), `/api/workflows/${workflowA1}?createdBy=${ownerB.userId}`, {
    token: ownerB.token,
  });
  assert.equal(probe.status, 404);
});

test('anonymous calls never reach authorization', async () => {
  // GET on the read surfaces (no body — a body would 405 before auth).
  for (const path of [
    `/api/workspaces/${workspaceA1}/workflows`,
    `/api/workflows/${workflowA1}`,
    `/api/workflows/${workflowA1}/definitions`,
  ]) {
    const response = await apiCall(port(), path, { method: 'GET' });
    assert.equal(response.status, 401, `${path} must demand authentication`);
  }
  // POST on the mutation surface carries a body but no token.
  const create = await apiCall(port(), `/api/workspaces/${workspaceA1}/workflows`, {
    body: { name: 'Anonymous' },
  });
  assert.equal(create.status, 401);
});
