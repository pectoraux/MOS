/**
 * MKT-008 functional integration test — the Workflow graph model domain
 * inside the real platform (real PostgreSQL + real API subprocess).
 *
 * Proofs (WF-001 "Implement one deterministic Workflow Graph authority
 * with typed node/edge contracts"; work-items.md MKT-008 acceptance
 * "graph validation, cycle/edge rules, versioning tests";
 * implementation-contract §4):
 *   - a Workspace-scoped Workflow persists with SERVER-DERIVED Client and
 *     Agency ownership resolved through the canonical /workspaces owner
 *     chain (never caller-supplied);
 *   - Workflow Definitions persist with EXPLICIT sequential version
 *     numbers and their graph/schemas/policy blocks round-trip EXACTLY
 *     through the API AND through direct DB jsonb verification;
 *   - every §4 MUST-list rejection fires at the API: invalid node types,
 *     dangling edges, duplicate node IDs, illegal cycles without a
 *     bounded loop contract, unresolved schema mappings, impossible
 *     joins, implicit joins;
 *   - the EXPLICIT version reference never floats: a retired version
 *     reference returns EXACTLY its own content forever, and a foreign
 *     definition id under this workflow is a uniform 404;
 *   - the activation lifecycle is exactly draft → review → active →
 *     retired; ACTIVATED definitions are immutable at the API (409) AND
 *     the database rejects direct rewrites; retired rows are frozen;
 *   - the Playbook → Workflow provenance link pins an explicit playbook
 *     version through /playbooks' explicit reference (unknown/cross-
 *     Client → uniform 404), and activation requires a PUBLISHED playbook
 *     version (an activated definition never rests on a CAS-editable
 *     draft);
 *   - the database backstops identity, scope, the explicit version fence
 *     and the playbook scope;
 *   - disabled boundaries block new use (409) without rewriting history;
 *   - every mutation lands in the append-only audit trail with the
 *     workflow-scoped tenant scope and correlation.
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

function edgeBody(fromNode: string, toNode: string, edgeType: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { fromNode, toNode, edgeType, predicateRef: null, joinSemantics: null, ...overrides };
}

/** A rich VALID definition body exercising the frozen control constructs. */
function definitionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    graph: {
      nodes: [
        nodeBody('generate', 'function', {
          inputMapping: { campaignName: { source: 'workflow_input', path: 'campaignName' } },
          retryPolicy: { maxAttempts: 3, backoffMs: 1000 },
          timeout: { seconds: 300 },
          idempotencyKeyStrategy: 'node',
        }),
        nodeBody('approve', 'approval', {
          inputMapping: { copy: { source: 'node_output', nodeId: 'generate', path: 'out' } },
          outputSchema: { type: 'object', properties: { approved: { type: 'boolean', description: null } }, required: [] },
          humanApproval: { required: true, approverPolicyRef: 'policy/approvers' },
        }),
        nodeBody('gate', 'condition', {
          outputSchema: { type: 'object', properties: { branch: { type: 'string', description: null } }, required: [] },
        }),
        nodeBody('refine', 'function', {
          outputSchema: { type: 'object', properties: { copy: { type: 'string', description: null } }, required: [] },
        }),
        nodeBody('polish', 'loop', {
          loop: { maxIterations: 3, termination: { kind: 'predicate', predicateRef: 'policy/copy-good' } },
          outputSchema: { type: 'object', properties: { iterations: { type: 'number', description: null } }, required: [] },
        }),
        nodeBody('publish', 'api_action', {
          outputSchema: { type: 'object', properties: { url: { type: 'string', description: null } }, required: [] },
          executionPolicyRef: 'policy/publish-rate',
        }),
        nodeBody('merge', 'join', {
          join: { semantics: 'all', predecessors: ['polish', 'publish'], threshold: null },
          outputSchema: { type: 'object', properties: { done: { type: 'boolean', description: null } }, required: [] },
        }),
        nodeBody('record', 'terminal', {
          inputMapping: { url: { source: 'node_output', nodeId: 'publish', path: 'url' } },
          outputSchema: { type: 'object', properties: { outcome: { type: 'string', description: null } }, required: [] },
        }),
      ],
      edges: [
        edgeBody('generate', 'approve', 'success'),
        edgeBody('approve', 'gate', 'success'),
        edgeBody('gate', 'polish', 'conditional', { predicateRef: 'policy/approved' }),
        edgeBody('gate', 'record', 'conditional', { predicateRef: 'policy/rejected' }),
        edgeBody('polish', 'refine', 'success'),
        edgeBody('refine', 'polish', 'success'),
        edgeBody('polish', 'publish', 'conditional', { predicateRef: 'policy/copy-good' }),
        edgeBody('polish', 'merge', 'join', { joinSemantics: 'all' }),
        edgeBody('publish', 'merge', 'join', { joinSemantics: 'all' }),
        edgeBody('merge', 'record', 'success'),
      ],
    },
    inputSchema: {
      type: 'object',
      properties: {
        campaignName: { type: 'string', description: null },
        budget: { type: 'number', description: null },
      },
      required: ['campaignName'],
    },
    outputSchema: { type: 'object', properties: { outcome: { type: 'string', description: null } }, required: ['outcome'] },
    retryPolicyDefaults: { maxAttempts: 2, backoffMs: 500 },
    concurrencyLimits: { maxConcurrentWorkflows: 5, maxConcurrentNodes: 10 },
    timeoutPolicy: { defaultTimeoutSeconds: 600, maxTimeoutSeconds: 3600 },
    compensation: [{ nodeId: 'publish', compensateViaNodeId: 'generate' }],
    ...overrides,
  };
}

async function createDefinition(
  workflowId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workflows/${workflowId}/definitions`, { token, body });
}

async function transitionDefinition(
  workflowId: string,
  definitionId: string,
  status: string,
  casVersion: number,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
    token,
    method: 'PATCH',
    body: { status, version: casVersion },
  });
}

/** Creates a playbook (Agency- or Client-scoped) and one draft version; returns ids. */
async function makePlaybookVersion(
  path: string,
  strategySummary: string,
): Promise<{ playbookId: string; versionId: string }> {
  const created = await apiCall(port(), path, {
    token: await adminToken(),
    body: { name: `Playbook ${strategySummary}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const playbookId = created.body['playbookId'] as string;
  const version = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token: await adminToken(),
    body: { strategy: { summary: strategySummary, templates: [{ name: 'T1' }] } },
  });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  return { playbookId, versionId: version.body['versionId'] as string };
}

const owner: User = { userId: '', token: '' };
const operator: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';

before(async () => {
  stack = await bootStack('workflowapi');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@workflows.test', 'Workflows Owner', 'workflows-owner-pass'));
  Object.assign(operator, await makeUser('operator@workflows.test', 'Workflows Operator', 'workflows-operator-pass'));
  agencyId = await makeAgency('Workflows Agency', owner);
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  clientId = await makeClient(agencyId, 'Workflows Client');
  workspaceId = await makeWorkspace(clientId, 'Launch Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a Workspace-scoped Workflow persists with server-derived Client and Agency ownership (WF-001 scope chain)', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Launch Campaign Workflow', description: 'First typed graph' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const workflow = created.body;
  const workflowId = workflow['workflowId'] as string;

  // Identity/scope/provenance are server-derived from the canonical
  // Workspace owner chain — never caller inputs.
  assert.ok(workflowId !== undefined && workflowId !== '');
  assert.equal(workflow['workspaceId'], workspaceId);
  assert.equal(workflow['clientId'], clientId);
  assert.equal(workflow['agencyId'], agencyId);
  assert.equal(workflow['name'], 'Launch Campaign Workflow');
  assert.equal(workflow['description'], 'First typed graph');
  assert.equal(workflow['version'], 1);
  assert.equal(workflow['createdBy'], owner.userId);
  assert.ok((workflow['createdAt'] as string).endsWith('Z'));

  // Lists under the workspace and reads by id.
  const list = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: operator.token,
  });
  assert.equal(list.status, 200);
  const workflows = list.body['workflows'] as Record<string, unknown>[];
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!['workflowId'], workflowId);

  const read = await apiCall(port(), `/api/workflows/${workflowId}`, { token: operator.token });
  assert.equal(read.status, 200);
  assert.equal(read.body['name'], 'Launch Campaign Workflow');

  // The ownership-context surface resolves the full canonical chain.
  const context = await apiCall(port(), `/api/workflows/${workflowId}/ownership-context`, {
    token: operator.token,
  });
  assert.equal(context.status, 200);
  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'workflow');
  assert.equal(scope['agencyId'], agencyId);
  assert.equal(scope['clientId'], clientId);
  assert.equal(scope['workspaceId'], workspaceId);
  assert.equal((context.body['workspace'] as Record<string, unknown>)['workspaceId'], workspaceId);
  assert.equal((context.body['client'] as Record<string, unknown>)['clientId'], clientId);
  assert.equal((context.body['agency'] as Record<string, unknown>)['agencyId'], agencyId);
});

test('Workflow profile updates are CAS-guarded', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Profile Target' },
  });
  assert.equal(created.status, 201);
  const workflowId = created.body['workflowId'] as string;

  const updated = await apiCall(port(), `/api/workflows/${workflowId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Profile Target v2', description: 'Renamed', version: 1 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body['name'], 'Profile Target v2');
  assert.equal(updated.body['version'], 2);

  const stale = await apiCall(port(), `/api/workflows/${workflowId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Profile Target v3', version: 1 },
  });
  assert.equal(stale.status, 409);
});

test('a valid typed graph definition persists with EXACT round-trips incl. direct DB jsonb verification (versioning test)', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Graph Round-Trip' },
  });
  assert.equal(created.status, 201);
  const workflowId = created.body['workflowId'] as string;

  const body = definitionBody();
  const first = await createDefinition(workflowId, body, owner.token);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body['versionNumber'], 1);
  assert.equal(first.body['status'], 'draft');
  assert.equal(first.body['playbookVersionId'], undefined, 'unlinked definitions serialize no playbook reference');
  assert.ok((first.body['workflowDefinitionId'] as string).length > 0);

  // The graph round-trips EXACTLY through the API.
  assert.deepEqual(first.body['graph'], body['graph']);
  assert.deepEqual(first.body['inputSchema'], body['inputSchema']);
  assert.deepEqual(first.body['outputSchema'], body['outputSchema']);
  assert.deepEqual(first.body['retryPolicyDefaults'], body['retryPolicyDefaults']);
  assert.deepEqual(first.body['concurrencyLimits'], body['concurrencyLimits']);
  assert.deepEqual(first.body['timeoutPolicy'], body['timeoutPolicy']);
  assert.deepEqual(first.body['compensation'], body['compensation']);

  // Direct database verification: the jsonb columns hold exactly the
  // submitted content (PostgreSQL is the system of record).
  const definitionId = first.body['workflowDefinitionId'] as string;
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{
      version_number: number;
      status: string;
      playbook_version_id: string | null;
      graph: Record<string, unknown>;
      input_schema: Record<string, unknown>;
      retry_policy_defaults: Record<string, unknown>;
      compensation: Record<string, unknown>[];
    }>(
      `SELECT version_number, status, playbook_version_id, graph, input_schema,
              retry_policy_defaults, compensation
       FROM workflow_definitions WHERE workflow_definition_id = $1`,
      [definitionId],
    );
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0]!;
    assert.equal(Number(row.version_number), 1);
    assert.equal(row.status, 'draft');
    assert.equal(row.playbook_version_id, null);
    assert.deepEqual(row.graph, body['graph']);
    assert.deepEqual(row.input_schema, body['inputSchema']);
    assert.deepEqual(row.retry_policy_defaults, body['retryPolicyDefaults']);
    assert.deepEqual(row.compensation, body['compensation']);
  } finally {
    await db.close();
  }

  // The second definition gets the next sequential version number.
  const second = await createDefinition(workflowId, definitionBody({ outputSchema: { type: 'object', properties: {}, required: [] } }), owner.token);
  assert.equal(second.status, 201);
  assert.equal(second.body['versionNumber'], 2);
});

test('the §4 MUST-list rejections fire at the API with precise problems', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Validation Target' },
  });
  const workflowId = created.body['workflowId'] as string;

  async function expectProblems(body: Record<string, unknown>, ...fragments: string[]): Promise<void> {
    const response = await createDefinition(workflowId, body, owner.token);
    assert.equal(response.status, 422, JSON.stringify(response.body));
    const problems = ((response.body['error'] as Record<string, unknown>)['details'] as string[]) ?? [];
    for (const fragment of fragments) {
      assert.ok(
        problems.some((problem) => problem.includes(fragment)),
        `expected a problem containing '${fragment}' in ${JSON.stringify(problems)}`,
      );
    }
  }

  // Invalid node type.
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [nodeBody('a', 'robot_overlord'), nodeBody('t', 'terminal')],
        edges: [edgeBody('a', 't', 'success')],
      },
    }),
    'frozen node classes',
  );

  // Duplicate node IDs.
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [nodeBody('a', 'function'), nodeBody('a', 'terminal')],
        edges: [],
      },
    }),
    'duplicate node id a',
  );

  // Dangling edge.
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [nodeBody('a', 'function'), nodeBody('t', 'terminal')],
        edges: [edgeBody('a', 'ghost', 'success')],
      },
    }),
    'toNode ghost does not exist',
  );

  // Illegal cycle without a bounded loop construct.
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [nodeBody('a', 'function'), nodeBody('b', 'function'), nodeBody('t', 'terminal')],
        edges: [edgeBody('a', 'b', 'success'), edgeBody('b', 'a', 'success'), edgeBody('b', 't', 'success')],
      },
    }),
    'illegal cycle',
  );

  // Unresolved schema mapping (workflow input property not declared).
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [
          nodeBody('a', 'function', {
            inputMapping: { topic: { source: 'workflow_input', path: 'topic' } },
          }),
          nodeBody('t', 'terminal'),
        ],
        edges: [edgeBody('a', 't', 'success')],
      },
    }),
    "input property 'topic' is not declared",
  );

  // Impossible join (declared predecessor without a join edge).
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [
          nodeBody('a', 'function'),
          nodeBody('b', 'function'),
          nodeBody('j', 'join', {
            join: { semantics: 'all', predecessors: ['a', 'b', 'missing'], threshold: null },
          }),
          nodeBody('t', 'terminal'),
        ],
        edges: [
          edgeBody('a', 'j', 'join', { joinSemantics: 'all' }),
          edgeBody('b', 'j', 'join', { joinSemantics: 'all' }),
          edgeBody('j', 't', 'success'),
          edgeBody('a', 'b', 'success'),
        ],
      },
    }),
    'declared predecessor missing has no join edge',
  );

  // Implicit join (two edges converge on a non-join node).
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [nodeBody('a', 'function'), nodeBody('b', 'function'), nodeBody('mid', 'function'), nodeBody('t', 'terminal')],
        edges: [
          edgeBody('a', 'b', 'success'),
          edgeBody('a', 'mid', 'success'),
          edgeBody('b', 'mid', 'success'),
          edgeBody('mid', 't', 'success'),
        ],
      },
    }),
    'converge without a join contract',
  );

  // Missing human approval on an approval node.
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [nodeBody('a', 'approval'), nodeBody('t', 'terminal')],
        edges: [edgeBody('a', 't', 'success')],
      },
    }),
    'approval nodes must declare',
  );

  // A loop node without its explicit bounded contract.
  await expectProblems(
    definitionBody({
      graph: {
        nodes: [
          nodeBody('a', 'function'),
          nodeBody('spin', 'loop'),
          nodeBody('t', 'terminal'),
        ],
        edges: [edgeBody('a', 'spin', 'success'), edgeBody('spin', 't', 'success')],
      },
    }),
    'bounded iteration/termination contract',
  );
});

test('the EXPLICIT version reference never floats: retired references return exactly their own content forever', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Explicit Reference' },
  });
  const workflowId = created.body['workflowId'] as string;

  const v1 = await createDefinition(workflowId, definitionBody(), owner.token);
  assert.equal(v1.status, 201);
  const v1Id = v1.body['workflowDefinitionId'] as string;
  const v1Graph = v1.body['graph'];

  const v2 = await createDefinition(
    workflowId,
    definitionBody({
      inputSchema: { type: 'object', properties: { campaignName: { type: 'string' }, extra: { type: 'number' } }, required: [] },
    }),
    owner.token,
  );
  assert.equal(v2.status, 201);
  assert.equal(v2.body['versionNumber'], 2);
  const v2Id = v2.body['workflowDefinitionId'] as string;

  // Distinct version ids carry distinct content.
  assert.notEqual(v1Id, v2Id);
  assert.notDeepEqual(v1.body['inputSchema'], v2.body['inputSchema']);

  // Lifecycle: v1 goes draft → review → active → retired.
  assert.equal((await transitionDefinition(workflowId, v1Id, 'review', 1, owner.token)).status, 200);
  assert.equal((await transitionDefinition(workflowId, v1Id, 'active', 2, owner.token)).status, 200);
  assert.equal((await transitionDefinition(workflowId, v1Id, 'retired', 3, owner.token)).status, 200);

  // The retired v1 reference returns EXACTLY v1 content — byte for byte,
  // in any lifecycle state, forever (no floating latest, no filtering).
  const readV1 = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${v1Id}`, {
    token: operator.token,
  });
  assert.equal(readV1.status, 200);
  assert.equal(readV1.body['status'], 'retired');
  assert.deepEqual(readV1.body['graph'], v1Graph);
  assert.deepEqual(readV1.body['inputSchema'], v1.body['inputSchema']);
  assert.deepEqual(readV1.body['outputSchema'], v1.body['outputSchema']);

  // A foreign definition id under this workflow is a uniform 404.
  const foreign = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${v2Id.slice(0, 30)}${'0'.repeat(6)}`, {
    token: operator.token,
  });
  assert.equal(foreign.status, 404);

  // The listing surface shows every lifecycle state (immutable history).
  const list = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: operator.token,
  });
  assert.equal(list.status, 200);
  const definitions = list.body['definitions'] as Record<string, unknown>[];
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0]!['status'], 'retired');
  assert.equal(definitions[1]!['status'], 'draft');
});

test('the activation lifecycle is exactly draft → review → active → retired with CAS and illegal transitions rejected', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Lifecycle Target' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await createDefinition(workflowId, definitionBody(), owner.token);
  const definitionId = definition.body['workflowDefinitionId'] as string;

  // Skip transitions are illegal (review is mandatory).
  assert.equal((await transitionDefinition(workflowId, definitionId, 'active', 1, owner.token)).status, 409);
  assert.equal((await transitionDefinition(workflowId, definitionId, 'retired', 1, owner.token)).status, 409);

  // Legal walk with CAS.
  const review = await transitionDefinition(workflowId, definitionId, 'review', 1, owner.token);
  assert.equal(review.status, 200);
  assert.equal(review.body['status'], 'review');
  assert.equal(review.body['version'], 2);

  // Stale CAS token.
  assert.equal((await transitionDefinition(workflowId, definitionId, 'active', 1, owner.token)).status, 409);

  const active = await transitionDefinition(workflowId, definitionId, 'active', 2, owner.token);
  assert.equal(active.status, 200);
  assert.equal(active.body['status'], 'active');

  // No back-edge from active.
  assert.equal((await transitionDefinition(workflowId, definitionId, 'review', 3, owner.token)).status, 409);

  const retired = await transitionDefinition(workflowId, definitionId, 'retired', 3, owner.token);
  assert.equal(retired.status, 200);
  assert.equal(retired.body['status'], 'retired');

  // Terminal: nothing leaves retired.
  assert.equal((await transitionDefinition(workflowId, definitionId, 'draft', 4, owner.token)).status, 409);
  assert.equal((await transitionDefinition(workflowId, definitionId, 'review', 4, owner.token)).status, 409);
});

test('ACTIVATED definitions are immutable: content updates 409 at the API AND the database rejects direct rewrites', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Immutability Target' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await createDefinition(workflowId, definitionBody(), owner.token);
  const definitionId = definition.body['workflowDefinitionId'] as string;

  // Draft content updates are legal.
  const draftUpdate = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: {
      graph: definitionBody().graph,
      inputSchema: definitionBody().inputSchema,
      outputSchema: definitionBody().outputSchema,
      concurrencyLimits: { maxConcurrentWorkflows: 9 },
      version: 1,
    },
  });
  assert.equal(draftUpdate.status, 200, JSON.stringify(draftUpdate.body));
  assert.deepEqual((draftUpdate.body['concurrencyLimits'] as Record<string, unknown>)['maxConcurrentWorkflows'], 9);

  // Activate.
  assert.equal((await transitionDefinition(workflowId, definitionId, 'review', 2, owner.token)).status, 200);
  assert.equal((await transitionDefinition(workflowId, definitionId, 'active', 3, owner.token)).status, 200);

  // Content update on the ACTIVATED definition → 409.
  const blocked = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: {
      graph: definitionBody().graph,
      inputSchema: definitionBody().inputSchema,
      outputSchema: definitionBody().outputSchema,
      version: 4,
    },
  });
  assert.equal(blocked.status, 409);

  // The DATABASE rejects a direct content rewrite of the activated row.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () =>
        db.query(
          `UPDATE workflow_definitions SET graph = '{"nodes":[],"edges":[]}'::jsonb
           WHERE workflow_definition_id = $1`,
          [definitionId],
        ),
      /immutable after activation/,
    );
  } finally {
    await db.close();
  }

  // Retirement preserves content; retired rows reject everything.
  const retired = await transitionDefinition(workflowId, definitionId, 'retired', 4, owner.token);
  assert.equal(retired.status, 200);
  assert.deepEqual(retired.body['graph'], draftUpdate.body['graph']);

  const db2 = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () =>
        db2.query(
          `UPDATE workflow_definitions SET timeout_policy = '{"defaultTimeoutSeconds":1}'::jsonb
           WHERE workflow_definition_id = $1`,
          [definitionId],
        ),
      /retired and frozen/,
    );
  } finally {
    await db2.close();
  }
});

test('the Playbook → Workflow provenance link pins an explicit playbook version with Client-boundary protection', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Provenance Target' },
  });
  const workflowId = created.body['workflowId'] as string;

  // An Agency-scoped playbook version (reusable IP) links fine.
  const agencyPlaybook = await makePlaybookVersion(`/api/agencies/${agencyId}/playbooks`, 'Agency IP strategy');
  const linked = await createDefinition(
    workflowId,
    definitionBody({ playbookVersionId: agencyPlaybook.versionId }),
    owner.token,
  );
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body['playbookVersionId'], agencyPlaybook.versionId);

  // A Client-scoped playbook version of the SAME Client links fine.
  const clientPlaybook = await makePlaybookVersion(`/api/clients/${clientId}/playbooks`, 'Client strategy');
  const linkedSameClient = await createDefinition(
    workflowId,
    definitionBody({ playbookVersionId: clientPlaybook.versionId }),
    owner.token,
  );
  assert.equal(linkedSameClient.status, 201);
  assert.equal(linkedSameClient.body['playbookVersionId'], clientPlaybook.versionId);

  // A Client-scoped playbook version of ANOTHER Client is uniformly
  // unresolvable (404 — no traversal/existence oracle).
  const otherClientId = await makeClient(agencyId, 'Other Client');
  const foreignPlaybook = await makePlaybookVersion(`/api/clients/${otherClientId}/playbooks`, 'Foreign strategy');
  const foreignLink = await createDefinition(
    workflowId,
    definitionBody({ playbookVersionId: foreignPlaybook.versionId }),
    owner.token,
  );
  assert.equal(foreignLink.status, 404);

  // An unknown playbook version is the same uniform 404.
  const unknownLink = await createDefinition(
    workflowId,
    definitionBody({ playbookVersionId: '00000000-0000-4000-8000-000000000000' }),
    owner.token,
  );
  assert.equal(unknownLink.status, 404);

  // Activation requires a PUBLISHED playbook version: the draft-linked
  // definition activates only after its playbook version is published.
  const draftLinked = await createDefinition(
    workflowId,
    definitionBody({ playbookVersionId: agencyPlaybook.versionId }),
    owner.token,
  );
  const draftId = draftLinked.body['workflowDefinitionId'] as string;
  assert.equal((await transitionDefinition(workflowId, draftId, 'review', 1, owner.token)).status, 200);
  const blockedActivation = await transitionDefinition(workflowId, draftId, 'active', 2, owner.token);
  assert.equal(blockedActivation.status, 409);
  assert.ok(
    JSON.stringify(blockedActivation.body).includes('published playbook version'),
    `activation refusal must name the published-playbook requirement: ${JSON.stringify(blockedActivation.body)}`,
  );

  // Publish the playbook version (draft → review → published — review is
  // mandatory in the frozen playbook machine); activation now succeeds.
  const toReview = await apiCall(
    port(),
    `/api/playbooks/${agencyPlaybook.playbookId}/versions/${agencyPlaybook.versionId}/status`,
    { token: await adminToken(), method: 'PATCH', body: { status: 'review', version: 1 } },
  );
  assert.equal(toReview.status, 200, JSON.stringify(toReview.body));
  const publish = await apiCall(
    port(),
    `/api/playbooks/${agencyPlaybook.playbookId}/versions/${agencyPlaybook.versionId}/status`,
    { token: await adminToken(), method: 'PATCH', body: { status: 'published', version: 2 } },
  );
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
  const activated = await transitionDefinition(workflowId, draftId, 'active', 2, owner.token);
  assert.equal(activated.status, 200);
  assert.equal(activated.body['status'], 'active');

  // The database itself rejects a cross-Client playbook link.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const workflowRow = await db.query<{ workflow_id: string }>(
      'SELECT workflow_id FROM workflows WHERE workflow_id = $1',
      [workflowId],
    );
    assert.equal(workflowRow.rows.length, 1);
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO workflow_definitions (workflow_definition_id, workflow_id, version_number, status,
                                              playbook_version_id, graph, input_schema, output_schema,
                                              compensation, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 99, 'draft', $2, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, now(), now())`,
          [workflowId, foreignPlaybook.versionId],
        ),
      /not usable by this workflow client/,
    );
  } finally {
    await db.close();
  }
});

test('the database backstops identity, scope, the version fence and the scope chain', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'DB Backstop Target' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await createDefinition(workflowId, definitionBody(), owner.token);
  const definitionId = definition.body['workflowDefinitionId'] as string;

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Workspace scope can never be re-parented.
    await assert.rejects(
      () =>
        db.query('UPDATE workflows SET workspace_id = $1 WHERE workflow_id = $2', [
          '00000000-0000-4000-8000-000000000000',
          workflowId,
        ]),
      /cannot change Workspace scope/,
    );
    // Client ownership can never be reassigned.
    await assert.rejects(
      () =>
        db.query('UPDATE workflows SET client_id = $1 WHERE workflow_id = $2', [
          '00000000-0000-4000-8000-000000000000',
          workflowId,
        ]),
      /Client ownership is immutable|client .* does not belong to agency/,
    );
    // The scope chain rejects a mismatched client on INSERT.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO workflows (workflow_id, workspace_id, client_id, agency_id, name, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'Bad chain', now(), now())`,
          [workspaceId, '00000000-0000-4000-8000-000000000000', agencyId],
        ),
      /does not belong to client/,
    );
    // The explicit version identity is immutable.
    await assert.rejects(
      () =>
        db.query('UPDATE workflow_definitions SET version_number = 99 WHERE workflow_definition_id = $1', [
          definitionId,
        ]),
      /number .* is immutable/,
    );
    // The (workflow_id, version_number) UNIQUE fence.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO workflow_definitions (workflow_definition_id, workflow_id, version_number, graph,
                                              input_schema, output_schema, compensation, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, now(), now())`,
          [workflowId],
        ),
      /duplicate key value violates unique constraint "workflow_definitions_number_unique"/,
    );
  } finally {
    await db.close();
  }
});

test('disabled boundaries block new use without rewriting history (boundary policy)', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Boundary Target' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await createDefinition(workflowId, definitionBody(), owner.token);
  const definitionId = definition.body['workflowDefinitionId'] as string;

  // Disable the workspace.
  const wsRead = await apiCall(port(), `/api/workspaces/${workspaceId}`, { token: owner.token });
  const disable = await apiCall(port(), `/api/workspaces/${workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: wsRead.body['version'] },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));

  // New use is blocked: creation and content updates 409.
  const blockedCreate = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Blocked' },
  });
  assert.equal(blockedCreate.status, 409);
  const blockedDefinition = await createDefinition(workflowId, definitionBody(), owner.token);
  assert.equal(blockedDefinition.status, 409);
  const blockedProfile = await apiCall(port(), `/api/workflows/${workflowId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Blocked rename', version: 1 },
  });
  assert.equal(blockedProfile.status, 409);

  // History stays readable.
  const read = await apiCall(port(), `/api/workflows/${workflowId}`, { token: operator.token });
  assert.equal(read.status, 200);

  // The editorial draft → review transition stays available.
  const review = await transitionDefinition(workflowId, definitionId, 'review', 1, owner.token);
  assert.equal(review.status, 200);

  // Re-enable: new use returns.
  const enable = await apiCall(port(), `/api/workspaces/${workspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: disable.body['version'] },
  });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  const restored = await createDefinition(workflowId, definitionBody(), owner.token);
  assert.equal(restored.status, 201);
});

test('every workflow mutation lands in the append-only audit trail with scope and correlation', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Audit Target' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await createDefinition(workflowId, definitionBody(), owner.token);
  const definitionId = definition.body['workflowDefinitionId'] as string;

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{
      action: string;
      agency_id: string;
      client_id: string;
      workspace_id: string;
      target_type: string;
      correlation_id: string;
    }>(
      `SELECT action, agency_id, client_id, workspace_id, target_type, correlation_id
       FROM audit_events
       WHERE (target_id = $1 AND target_type = 'workflow')
          OR (target_id = $2 AND target_type = 'workflow_definition')
       ORDER BY occurred_at, recorded_at`,
      [workflowId, definitionId],
    );
    const actions = rows.rows.map((row) => row.action);
    assert.deepEqual(actions.sort(), [
      'workflows.definition.created',
      'workflows.workflow.created',
    ]);
    for (const row of rows.rows) {
      assert.equal(row.agency_id, agencyId);
      assert.equal(row.client_id, clientId);
      assert.equal(row.workspace_id, workspaceId);
      assert.ok(row.correlation_id.length > 0, 'audit rows carry the correlation id');
    }
  } finally {
    await db.close();
  }
});
