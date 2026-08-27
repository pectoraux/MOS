/**
 * MKT-006 integration test — Goal API contract on a real PostgreSQL + real
 * API subprocess:
 *
 *   - GOAL-AC-01 (positive): a Goal persists WITH measurable success
 *     criteria — the criteria (named metric + comparator + numeric target,
 *     decimals included) round-trip exactly through the API AND through
 *     direct database reads (jsonb persisted verbatim);
 *   - workspace-scoped creation (scope within the owning Client) and
 *     client-wide creation (NULL scope);
 *   - ownership is server-derived: identity, scope, status, version,
 *     provenance are never caller-suppliable (authority fields → 422);
 *     createdBy equals the acting user;
 *   - the canonical owner context resolves server-side from durable state
 *     (goal → client → agency, plus the scoped workspace) and is exposed
 *     read-only, fresh on every call;
 *   - the frozen lifecycle: draft → active → achieved, draft → abandoned;
 *     terminal goals are frozen history (content update → 409; replayed /
 *     illegal transitions → 409);
 *   - CAS content update: version bump, content replaced, criteria must
 *     stay measurable;
 *   - validation matrix: empty criteria, bad comparator, non-numeric
 *     target, unknown criterion keys, non-array criteria, bad constraint
 *     kind, impossible time horizon → 422;
 *   - read/mutation authorization matrix incl. platform admin and the
 *     internal service principal; correlated audit records for material
 *     mutations (created / profile_updated / status_changed with goal
 *     scope, CAS versions and correlation id).
 *
 * Cross-tenant isolation and concurrency proofs live in
 * goals-isolation.test.ts / goals-concurrency.test.ts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

function goalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective: 'Grow qualified pipeline for the flagship product',
    successCriteria: [
      {
        metric: 'qualified_leads',
        comparator: '>=',
        targetValue: 100,
        unit: 'count',
        description: 'Marketing-qualified leads from paid + organic',
      },
      {
        metric: 'customer_acquisition_cost',
        comparator: '<=',
        targetValue: 12.5,
        unit: 'USD',
      },
    ],
    metrics: [{ name: 'share_of_voice', unit: '%', description: 'observed only' }],
    constraints: [
      { kind: 'resource', description: 'Monthly budget cap of 10k USD' },
      { kind: 'risk', description: 'No outreach to existing enterprise accounts' },
    ],
    timeHorizon: { startsOn: '2026-01-01', endsOn: '2026-03-31' },
    ...overrides,
  };
}

async function createGoal(clientId: string, body: Record<string, unknown>, token?: string) {
  return apiCall(port(), `/api/clients/${clientId}/goals`, {
    token: token ?? (await adminToken()),
    body,
  });
}

const owner: User = { userId: '', token: '' };
const operator: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';

before(async () => {
  stack = await bootStack('goalapi');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@goals.test', 'Goals Owner', 'goals-owner-pass'));
  Object.assign(operator, await makeUser('operator@goals.test', 'Goals Operator', 'goals-operator-pass'));
  agencyId = await makeAgency('Goals Agency', owner);
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  clientId = await makeClient(agencyId, 'Goals Client');
  workspaceId = await makeWorkspace(clientId, 'Goals Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('a Goal persists with measurable success criteria — exact round-trip incl. direct DB verification (GOAL-AC-01)', async () => {
  const created = await createGoal(clientId, goalBody(), owner.token);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const goal = created.body;
  const goalId = goal['goalId'] as string;

  // Identity/scope/provenance/version are server-derived.
  assert.ok(goalId !== undefined && goalId !== '');
  assert.equal(goal['clientId'], clientId);
  assert.equal(goal['status'], 'draft');
  assert.equal(goal['version'], 1);
  assert.equal(goal['createdBy'], owner.userId);
  assert.ok((goal['createdAt'] as string).endsWith('Z'));
  assert.ok((goal['updatedAt'] as string).endsWith('Z'));

  // Measurable criteria round-trip EXACTLY (metric + comparator + numeric
  // target, decimals preserved, optional fields carried).
  const criteria = goal['successCriteria'] as Record<string, unknown>[];
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0]!['metric'], 'qualified_leads');
  assert.equal(criteria[0]!['comparator'], '>=');
  assert.equal(criteria[0]!['targetValue'], 100);
  assert.equal(criteria[0]!['unit'], 'count');
  assert.equal(criteria[0]!['description'], 'Marketing-qualified leads from paid + organic');
  assert.equal(criteria[1]!['metric'], 'customer_acquisition_cost');
  assert.equal(criteria[1]!['comparator'], '<=');
  assert.equal(criteria[1]!['targetValue'], 12.5);
  assert.equal(criteria[1]!['unit'], 'USD');
  assert.equal(criteria[1]!['description'], undefined, 'omitted optional fields stay omitted');

  // Metrics / constraints / time horizon round-trip.
  const metrics = goal['metrics'] as Record<string, unknown>[];
  assert.deepEqual(metrics, [
    { name: 'share_of_voice', unit: '%', description: 'observed only' },
  ]);
  const constraints = goal['constraints'] as Record<string, unknown>[];
  assert.equal(constraints.length, 2);
  assert.deepEqual(constraints[0], { kind: 'resource', description: 'Monthly budget cap of 10k USD' });
  assert.deepEqual(goal['timeHorizon'], { startsOn: '2026-01-01', endsOn: '2026-03-31' });

  // Direct database verification: the criteria jsonb is persisted verbatim.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{
      client_id: string;
      workspace_id: string | null;
      objective: string;
      success_criteria: { metric: string; comparator: string; targetValue: number }[];
      status: string;
      created_by: string | null;
      version: string | number;
    }>(
      'SELECT client_id, workspace_id, objective, success_criteria, status, created_by, version FROM goals WHERE goal_id = $1',
      [goalId],
    );
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0]!;
    assert.equal(row.client_id, clientId);
    assert.equal(row.workspace_id, null, 'client-wide goal → NULL workspace scope');
    assert.equal(row.objective, 'Grow qualified pipeline for the flagship product');
    assert.equal(row.status, 'draft');
    assert.equal(row.created_by, owner.userId);
    assert.equal(Number(row.version), 1);
    assert.equal(row.success_criteria.length, 2, 'criteria persisted as a jsonb array');
    assert.equal(row.success_criteria[0]!.metric, 'qualified_leads');
    assert.equal(row.success_criteria[0]!.comparator, '>=');
    assert.equal(row.success_criteria[0]!.targetValue, 100);
    assert.equal(row.success_criteria[1]!.targetValue, 12.5, 'decimal targets persist exactly');
  } finally {
    await db.close();
  }

  // The read surface returns the same measurable state.
  const read = await apiCall(port(), `/api/goals/${goalId}`, { token: operator.token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body['successCriteria'], criteria);
});

test('a workspace-scoped Goal persists the scope and resolves its owner context through it', async () => {
  const created = await createGoal(clientId, { ...goalBody(), workspaceId }, owner.token);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const goalId = created.body['goalId'] as string;
  assert.equal(created.body['workspaceId'], workspaceId);

  const context = await apiCall(port(), `/api/goals/${goalId}/ownership-context`, {
    token: operator.token,
  });
  assert.equal(context.status, 200);
  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'goal');
  assert.equal(scope['agencyId'], agencyId, 'agency derives from the client ownership chain');
  assert.equal(scope['clientId'], clientId);
  assert.equal(scope['workspaceId'], workspaceId);
  assert.equal(scope['goalId'], goalId);
  const workspace = context.body['workspace'] as Record<string, unknown>;
  assert.equal(workspace['workspaceId'], workspaceId);
  assert.equal(workspace['clientId'], clientId);
  const client = context.body['client'] as Record<string, unknown>;
  assert.equal(client['clientId'], clientId);
  assert.equal((context.body['agency'] as Record<string, unknown>)['agencyId'], agencyId);

  // The client-wide goal from the previous test resolves with a NULL scope.
  const list = await apiCall(port(), `/api/clients/${clientId}/goals`, { token: operator.token });
  assert.equal(list.status, 200);
  const goals = list.body['goals'] as Record<string, unknown>[];
  assert.equal(goals.length, 2, 'both goals of the client are listed (business history visible)');
  const clientWide = goals.find((entry) => entry['workspaceId'] === undefined);
  assert.ok(clientWide !== undefined, 'client-wide goal listed without workspaceId');

  // A disabled CLIENT blocks new goal creation (policy), a deleted client
  // tombstone is a uniform 404 — asserted in goals-isolation.test.ts.
});

test('caller-supplied authority fields are rejected with 422 — ownership is server-derived', async () => {
  for (const extra of [
    { goalId: '00000000-0000-0000-0000-000000000001' },
    { clientId: '00000000-0000-0000-0000-000000000002' },
    { agencyId: '00000000-0000-0000-0000-000000000003' },
    { status: 'active' },
    { version: 7 },
    { createdBy: '00000000-0000-0000-0000-000000000004' },
    { createdAt: '2020-01-01T00:00:00Z' },
    { updatedAt: '2020-01-01T00:00:00Z' },
  ]) {
    const response = await createGoal(clientId, { ...goalBody(), ...extra }, owner.token);
    assert.equal(
      response.status,
      422,
      `authority field must be rejected: ${JSON.stringify(extra)}`,
    );
  }
});

test('non-measurable or malformed criteria are rejected with 422 (GOAL-AC-01 shape)', async () => {
  const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['empty criteria', { successCriteria: [] }],
    ['missing criteria', { successCriteria: undefined }],
    ['criteria not an array', { successCriteria: { metric: 'x' } }],
    [
      'criterion without metric',
      { successCriteria: [{ comparator: '>=', targetValue: 10 }] },
    ],
    [
      'criterion without comparator',
      { successCriteria: [{ metric: 'leads', targetValue: 10 }] },
    ],
    [
      'criterion without target',
      { successCriteria: [{ metric: 'leads', comparator: '>=' }] },
    ],
    [
      'prose comparator',
      { successCriteria: [{ metric: 'leads', comparator: 'at least', targetValue: 10 }] },
    ],
    [
      'string target',
      { successCriteria: [{ metric: 'leads', comparator: '>=', targetValue: '100' }] },
    ],
    [
      'null criterion',
      { successCriteria: [null] },
    ],
    [
      'unknown criterion key',
      {
        successCriteria: [
          { metric: 'leads', comparator: '>=', targetValue: 10, threshold: 'smuggled' },
        ],
      },
    ],
    [
      'bad constraint kind',
      { constraints: [{ kind: 'legal', description: 'x' }] },
    ],
    [
      'constraint without description',
      { constraints: [{ kind: 'resource' }] },
    ],
    [
      'impossible horizon',
      { timeHorizon: { startsOn: '2026-06-01', endsOn: '2026-05-01' } },
    ],
    [
      'malformed horizon date',
      { timeHorizon: { startsOn: '2026-02-30' } },
    ],
    [
      'non-ISO horizon date',
      { timeHorizon: { startsOn: '01/02/2026' } },
    ],
    ['objective missing', { objective: undefined }],
    ['objective empty', { objective: '' }],
    ['unknown top-level key', { smuggled: true }],
  ];
  for (const [label, overrides] of cases) {
    const body = { ...goalBody() };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete (body as Record<string, unknown>)[key];
      else (body as Record<string, unknown>)[key] = value;
    }
    const response = await createGoal(clientId, body, owner.token);
    assert.equal(response.status, 422, `${label} must be rejected (got ${response.status})`);
  }
});

test('CAS content update replaces the business content and bumps the version', async () => {
  const created = await createGoal(
    clientId,
    goalBody({ objective: 'Original objective' }),
    owner.token,
  );
  assert.equal(created.status, 201);
  const goalId = created.body['goalId'] as string;

  const updated = await apiCall(port(), `/api/goals/${goalId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: {
      objective: 'Re-baselined objective',
      successCriteria: [
        { metric: 'qualified_leads', comparator: '>=', targetValue: 250, unit: 'count' },
      ],
      metrics: [],
      constraints: [{ kind: 'time', description: 'Must conclude before the product launch' }],
      timeHorizon: null,
      version: 1,
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body['version'], 2);
  assert.equal(updated.body['objective'], 'Re-baselined objective');
  const criteria = updated.body['successCriteria'] as Record<string, unknown>[];
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0]!['targetValue'], 250);
  assert.deepEqual(updated.body['metrics'], [], 'cleared metrics serialize as an empty array');
  const constraints = updated.body['constraints'] as Record<string, unknown>[];
  assert.deepEqual(constraints, [
    { kind: 'time', description: 'Must conclude before the product launch' },
  ]);
  assert.equal(updated.body['timeHorizon'], undefined, 'cleared horizon stays cleared');

  // Stale version → 409; scope/identity are not content-updatable.
  const stale = await apiCall(port(), `/api/goals/${goalId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { ...goalBody(), version: 1 },
  });
  assert.equal(stale.status, 409);

  const smuggled = await apiCall(port(), `/api/goals/${goalId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { ...goalBody(), workspaceId, version: 2 },
  });
  assert.equal(smuggled.status, 422, 'workspace scope cannot be smuggled into a content update');

  // Content updates must still be measurable.
  const nonMeasurable = await apiCall(port(), `/api/goals/${goalId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { ...goalBody(), successCriteria: [], version: 2 },
  });
  assert.equal(nonMeasurable.status, 422);
});

test('the frozen lifecycle: draft → active → achieved, draft → abandoned; terminal history is frozen', async () => {
  // Path 1: draft → active → achieved.
  const first = await createGoal(clientId, goalBody(), owner.token);
  assert.equal(first.status, 201);
  const firstId = first.body['goalId'] as string;

  const activated = await apiCall(port(), `/api/goals/${firstId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body['status'], 'active');
  assert.equal(activated.body['version'], 2);

  const achieved = await apiCall(port(), `/api/goals/${firstId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'achieved', version: 2 },
  });
  assert.equal(achieved.status, 200);
  assert.equal(achieved.body['status'], 'achieved');
  assert.equal(achieved.body['version'], 3);

  // Terminal: every further mutation is rejected (business history frozen).
  const replay = await apiCall(port(), `/api/goals/${firstId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 3 },
  });
  assert.equal(replay.status, 409, 'achieved is terminal — no resurrection');

  const content = await apiCall(port(), `/api/goals/${firstId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { ...goalBody(), version: 3 },
  });
  assert.equal(content.status, 409, 'achieved history cannot be rewritten');

  // Reads still work — terminal goals stay visible business history.
  const read = await apiCall(port(), `/api/goals/${firstId}`, { token: operator.token });
  assert.equal(read.status, 200);
  assert.equal(read.body['status'], 'achieved');

  // Path 2: draft → abandoned (a draft may be abandoned directly).
  const second = await createGoal(clientId, goalBody(), owner.token);
  assert.equal(second.status, 201);
  const secondId = second.body['goalId'] as string;
  const abandoned = await apiCall(port(), `/api/goals/${secondId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'abandoned', version: 1 },
  });
  assert.equal(abandoned.status, 200);
  assert.equal(abandoned.body['status'], 'abandoned');

  // Illegal transitions from draft/active.
  const third = await createGoal(clientId, goalBody(), owner.token);
  assert.equal(third.status, 201);
  const thirdId = third.body['goalId'] as string;
  for (const status of ['achieved', 'draft']) {
    const illegal = await apiCall(port(), `/api/goals/${thirdId}/status`, {
      token: owner.token,
      method: 'PATCH',
      body: { status, version: 1 },
    });
    assert.equal(illegal.status, 409, `draft → ${status} must be illegal`);
  }
  const statusSmuggle = await apiCall(port(), `/api/goals/${thirdId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 1, objective: 'smuggled' },
  });
  assert.equal(statusSmuggle.status, 422, 'content fields cannot ride the lifecycle route');
});

test('authorization matrix: reads for any active member, mutations for owner/admin/platform/service only', async () => {
  const created = await createGoal(clientId, goalBody(), owner.token);
  assert.equal(created.status, 201);
  const goalId = created.body['goalId'] as string;

  // Operator (active member, non-admin role): reads OK, mutations 403.
  const read = await apiCall(port(), `/api/goals/${goalId}`, { token: operator.token });
  assert.equal(read.status, 200);
  const context = await apiCall(port(), `/api/goals/${goalId}/ownership-context`, {
    token: operator.token,
  });
  assert.equal(context.status, 200);
  const list = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token: operator.token,
  });
  assert.equal(list.status, 200);
  const create = await createGoal(clientId, goalBody(), operator.token);
  assert.equal(create.status, 403, 'operators cannot create goals');
  const profile = await apiCall(port(), `/api/goals/${goalId}/profile`, {
    token: operator.token,
    method: 'PATCH',
    body: { ...goalBody(), version: 1 },
  });
  assert.equal(profile.status, 403);
  const status = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: operator.token,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(status.status, 403);

  // Platform administrator: full access.
  const admin = await adminToken();
  const adminProfile = await apiCall(port(), `/api/goals/${goalId}/profile`, {
    token: admin,
    method: 'PATCH',
    body: { ...goalBody(), version: 1 },
  });
  assert.equal(adminProfile.status, 200, JSON.stringify(adminProfile.body));

  // Internal service principal: authorized machine-to-machine access.
  const service = await apiCall(port(), `/api/goals/${goalId}`, {
    headers: { authorization: `Bearer ${stack!.env.internalApiToken}` },
  });
  assert.equal(service.status, 200);
});

test('material goal mutations emit correlated audit records with goal scope and CAS versions', async () => {
  // The server only honors UUID-format x-correlation-id values (a non-UUID
  // is replaced by a fresh generated id — see server.ts).
  const correlationId = randomUUID();
  const created = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token: owner.token,
    correlationId,
    body: goalBody({ objective: 'Audited objective' }),
  });
  assert.equal(created.status, 201);
  const goalId = created.body['goalId'] as string;

  const updated = await apiCall(port(), `/api/goals/${goalId}/profile`, {
    token: owner.token,
    correlationId,
    method: 'PATCH',
    body: { ...goalBody(), version: 1 },
  });
  assert.equal(updated.status, 200);
  const activated = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: owner.token,
    correlationId,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(activated.status, 200);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{
      action: string;
      agency_id: string | null;
      client_id: string | null;
      workspace_id: string | null;
      target_type: string;
      target_id: string;
      correlation_id: string;
      before_version: string | number | null;
      after_version: string | number | null;
      idempotency_key: string | null;
    }>(
      `SELECT action, agency_id, client_id, workspace_id, target_type, target_id,
              correlation_id, before_version, after_version, idempotency_key
       FROM audit_events WHERE target_type = 'goal' AND target_id = $1 ORDER BY occurred_at`,
      [goalId],
    );
    assert.equal(rows.rows.length, 3, 'created + profile_updated + status_changed');
    const [created_, profiled, statused] = rows.rows;

    for (const row of rows.rows) {
      assert.equal(row.agency_id, agencyId, 'audit carries the owning agency');
      assert.equal(row.client_id, clientId, 'audit carries the owning client');
      assert.equal(row.correlation_id, correlationId, 'correlation propagated to audit');
    }
    assert.equal(created_!.action, 'goals.goal.created');
    assert.equal(Number(created_!.after_version), 1);
    assert.equal(created_!.before_version, null);
    assert.equal(created_!.idempotency_key, `goals.goal.created:${goalId}`);
    assert.equal(profiled!.action, 'goals.goal.profile_updated');
    assert.equal(Number(profiled!.before_version), 1);
    assert.equal(Number(profiled!.after_version), 2);
    assert.equal(statused!.action, 'goals.goal.status_changed');
    assert.equal(Number(statused!.before_version), 2);
    assert.equal(Number(statused!.after_version), 3);
  } finally {
    await db.close();
  }
});

test('boundary policy: a disabled Client blocks new goal creation (409) without rewriting history', async () => {
  const disabledClient = await makeClient(agencyId, 'Disabled Goals Client');

  // Two goals exist under the client before it is disabled.
  const first = await createGoal(disabledClient, goalBody(), owner.token);
  assert.equal(first.status, 201);
  const firstGoalId = first.body['goalId'] as string;
  const second = await createGoal(disabledClient, goalBody(), owner.token);
  assert.equal(second.status, 201);
  const secondGoalId = second.body['goalId'] as string;

  const disable = await apiCall(port(), `/api/clients/${disabledClient}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disable.status, 200);

  // New use is blocked (409); the existing goal stays READABLE (history).
  const blockedCreate = await createGoal(disabledClient, goalBody(), owner.token);
  assert.equal(blockedCreate.status, 409);
  const readExisting = await apiCall(port(), `/api/goals/${firstGoalId}`, {
    token: owner.token,
  });
  assert.equal(readExisting.status, 200, 'disabled client does not erase goal history');

  // Activation and content edits are NEW USE — blocked under a disabled
  // client (fresh versions, so the 409 is policy, not a CAS race).
  const blockedActivate = await apiCall(port(), `/api/goals/${firstGoalId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 1 },
  });
  assert.equal(blockedActivate.status, 409, 'activation is new use — blocked');
  const blockedProfile = await apiCall(port(), `/api/goals/${secondGoalId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { ...goalBody(), version: 1 },
  });
  assert.equal(blockedProfile.status, 409, 'content edit is new use — blocked');

  // Terminal transitions remain available (history recording is never
  // blocked, even under a disabled client).
  const abandon = await apiCall(port(), `/api/goals/${firstGoalId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'abandoned', version: 1 },
  });
  assert.equal(abandon.status, 200, 'terminal transition available under a disabled client');

  // Re-enable restores normal operation.
  const enable = await apiCall(port(), `/api/clients/${disabledClient}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(enable.status, 200);
  const restoredCreate = await createGoal(disabledClient, goalBody(), owner.token);
  assert.equal(restoredCreate.status, 201);
});
