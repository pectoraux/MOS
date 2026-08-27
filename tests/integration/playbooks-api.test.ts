/**
 * MKT-007 integration test — Playbook API contract on a real PostgreSQL +
 * real API subprocess:
 *
 *   - PLAY-001 (positive): versioned Playbooks persist — Agency-scoped
 *     reusable IP AND Client-scoped playbooks with an optional Goal link;
 *     version numbers are explicit, server-assigned and sequential
 *     (1, 2, 3, …); the strategy artifact and the declarative deployment
 *     metadata round-trip exactly through the API AND through direct
 *     database reads (jsonb persisted verbatim);
 *   - ownership is server-derived: identity, scope, goal link, status,
 *     version numbers, provenance are never caller-suppliable (authority
 *     fields → 422); createdBy equals the acting user; agency_id is
 *     derived from the canonical Client owner;
 *   - the canonical owner context resolves server-side from durable state
 *     (playbook → agency-or-client → agency, plus the linked goal) and is
 *     exposed read-only, fresh on every call;
 *   - PLAY-AC-01: a PUBLISHED version is immutable — content update → 409
 *     AND the database itself rejects a direct UPDATE; the only legal
 *     transition out of published is the content-preserving retirement;
 *     RETIRED versions are frozen terminal history that stays resolvable
 *     byte for byte;
 *   - PLAY-AC-02 (contract end): the EXPLICIT version reference — after
 *     newer versions are published and older ones retired, each version
 *     reference still resolves to EXACTLY its own content (no floating
 *     "latest" semantics anywhere);
 *   - the frozen lifecycle: draft → review → published → retired exactly;
 *     every other transition → 409;
 *   - CAS updates: container profile and version content bump versions;
 *   - validation matrix: empty summary, unnamed template, unknown
 *     capability kind, unknown runtime class, unknown trigger kind,
 *     unknown keys → 422;
 *   - read/mutation authorization matrix incl. platform admin and the
 *     internal service principal; correlated audit records for material
 *     mutations (created / profile_updated / version.created /
 *     version.content_updated / version.status_changed with playbook
 *     scope, CAS versions and correlation id);
 *   - boundary policy: a disabled Client blocks new use (409) without
 *     rewriting history.
 *
 * Cross-tenant isolation and concurrency proofs live in
 * playbooks-isolation.test.ts / playbooks-concurrency.test.ts.
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

async function makeGoal(clientId: string, token: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: {
      objective: 'Grow qualified pipeline for the playbook-linked goal',
      successCriteria: [
        { metric: 'qualified_leads', comparator: '>=', targetValue: 100, unit: 'count' },
      ],
    },
  });
  assert.equal(response.status, 201, `create goal: ${JSON.stringify(response.body)}`);
  return response.body['goalId'] as string;
}

function strategyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'Land-and-expand inbound motion for technical buyers',
    templates: [
      { name: 'SEO cluster', description: 'Programmatic topic clusters' },
      { name: 'Newsletter', description: 'Weekly technical newsletter' },
    ],
    ...overrides,
  };
}

function deploymentMetadataBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requiredDomainPacks: [{ name: 'b2b-inbound', versionConstraint: '>=2' }],
    requiredCapabilities: [
      { kind: 'integration', name: 'hubspot' },
      { kind: 'extension', name: 'content-review', versionConstraint: '^1' },
    ],
    runtimeRequirements: { runtimeClass: 'pooled-worker' },
    triggers: [
      { kind: 'manual' },
      { kind: 'schedule', config: { cron: '0 9 * * 1' } },
    ],
    ...overrides,
  };
}

async function createVersion(
  playbookId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/playbooks/${playbookId}/versions`, { token, body });
}

async function transitionVersion(
  playbookId: string,
  versionId: string,
  status: string,
  casVersion: number,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/status`, {
    token,
    method: 'PATCH',
    body: { status, version: casVersion },
  });
}

const owner: User = { userId: '', token: '' };
const operator: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let goalId = '';

before(async () => {
  stack = await bootStack('playbookapi');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@playbooks.test', 'Playbooks Owner', 'playbooks-owner-pass'));
  Object.assign(operator, await makeUser('operator@playbooks.test', 'Playbooks Operator', 'playbooks-operator-pass'));
  agencyId = await makeAgency('Playbooks Agency', owner);
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  clientId = await makeClient(agencyId, 'Playbooks Client');
  goalId = await makeGoal(clientId, owner.token);
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('an Agency-scoped Playbook persists with explicit sequential versions — exact round-trip incl. direct DB verification (PLAY-001)', async () => {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/playbooks`, {
    token: owner.token,
    body: { name: 'B2B Inbound Playbook', description: 'Reusable agency IP' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const playbook = created.body;
  const playbookId = playbook['playbookId'] as string;

  // Identity/scope/provenance/version are server-derived.
  assert.ok(playbookId !== undefined && playbookId !== '');
  assert.equal(playbook['agencyId'], agencyId);
  assert.equal(playbook['clientId'], undefined, 'agency-scoped playbook serializes no client scope');
  assert.equal(playbook['goalId'], undefined, 'agency-scoped playbook serializes no goal link');
  assert.equal(playbook['name'], 'B2B Inbound Playbook');
  assert.equal(playbook['description'], 'Reusable agency IP');
  assert.equal(playbook['version'], 1);
  assert.equal(playbook['createdBy'], owner.userId);
  assert.ok((playbook['createdAt'] as string).endsWith('Z'));

  // Three versions with EXPLICIT sequential server-assigned numbers.
  const first = await createVersion(playbookId, { strategy: strategyBody() }, owner.token);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body['versionNumber'], 1);
  assert.equal(first.body['status'], 'draft');
  const second = await createVersion(
    playbookId,
    { strategy: strategyBody({ summary: 'Second iteration' }) },
    owner.token,
  );
  assert.equal(second.status, 201);
  assert.equal(second.body['versionNumber'], 2);
  const third = await createVersion(
    playbookId,
    { strategy: strategyBody({ summary: 'Third iteration' }) },
    owner.token,
  );
  assert.equal(third.status, 201);
  assert.equal(third.body['versionNumber'], 3);

  // Strategy + deployment metadata round-trip EXACTLY on the first version.
  const withMetadata = await createVersion(
    playbookId,
    { strategy: strategyBody(), deploymentMetadata: deploymentMetadataBody() },
    owner.token,
  );
  assert.equal(withMetadata.status, 201, JSON.stringify(withMetadata.body));
  assert.equal(withMetadata.body['versionNumber'], 4);
  const metadata = withMetadata.body['deploymentMetadata'] as Record<string, unknown>;
  assert.deepEqual(metadata['requiredDomainPacks'], [{ name: 'b2b-inbound', versionConstraint: '>=2' }]);
  assert.deepEqual(metadata['requiredCapabilities'], [
    { kind: 'integration', name: 'hubspot' },
    { kind: 'extension', name: 'content-review', versionConstraint: '^1' },
  ]);
  assert.deepEqual(metadata['runtimeRequirements'], { runtimeClass: 'pooled-worker' });
  const triggers = metadata['triggers'] as Record<string, unknown>[];
  assert.equal(triggers.length, 2);
  assert.deepEqual(triggers[0], { kind: 'manual' });
  assert.deepEqual(triggers[1], { kind: 'schedule', config: { cron: '0 9 * * 1' } });

  // A version without declared metadata normalizes to the empty metadata.
  assert.deepEqual((first.body['deploymentMetadata'] as Record<string, unknown>), {
    requiredDomainPacks: [],
    requiredCapabilities: [],
    runtimeRequirements: {},
    triggers: [],
  });

  // Direct database verification: the version rows and jsonb are persisted
  // verbatim with sequential numbers.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{
      version_number: number;
      status: string;
      strategy: { summary: string; templates: { name: string }[] };
      deployment_metadata: unknown;
      created_by: string | null;
    }>(
      'SELECT version_number, status, strategy, deployment_metadata, created_by FROM playbook_versions WHERE playbook_id = $1 ORDER BY version_number',
      [playbookId],
    );
    assert.equal(rows.rows.length, 4, 'four version rows');
    assert.deepEqual(
      rows.rows.map((row) => row.version_number),
      [1, 2, 3, 4],
      'explicit sequential version numbers',
    );
    assert.equal(rows.rows[0]!.status, 'draft');
    assert.equal(rows.rows[0]!.created_by, owner.userId);
    assert.equal(rows.rows[0]!.strategy.summary, 'Land-and-expand inbound motion for technical buyers');
    assert.equal(rows.rows[0]!.strategy.templates.length, 2);
    assert.equal(rows.rows[0]!.strategy.templates[0]!.name, 'SEO cluster');
    const storedMetadata = rows.rows[3]!.deployment_metadata as Record<string, unknown>;
    assert.equal(
      (storedMetadata['requiredCapabilities'] as Record<string, unknown>[]).length,
      2,
      'deployment metadata persisted as jsonb verbatim',
    );

    const playbookRows = await db.query<{
      agency_id: string;
      client_id: string | null;
      goal_id: string | null;
      name: string;
    }>('SELECT agency_id, client_id, goal_id, name FROM playbooks WHERE playbook_id = $1', [
      playbookId,
    ]);
    assert.equal(playbookRows.rows.length, 1);
    assert.equal(playbookRows.rows[0]!.agency_id, agencyId);
    assert.equal(playbookRows.rows[0]!.client_id, null, 'agency-scoped → NULL client scope');
    assert.equal(playbookRows.rows[0]!.goal_id, null, 'agency-scoped → NULL goal link');
  } finally {
    await db.close();
  }

  // Listing shows every version in number order.
  const list = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token: operator.token,
  });
  assert.equal(list.status, 200);
  const versions = list.body['versions'] as Record<string, unknown>[];
  assert.equal(versions.length, 4);
  assert.deepEqual(
    versions.map((version) => version['versionNumber']),
    [1, 2, 3, 4],
  );

  // Agency listing shows the playbook (reusable operational IP).
  const agencyList = await apiCall(port(), `/api/agencies/${agencyId}/playbooks`, {
    token: operator.token,
  });
  assert.equal(agencyList.status, 200);
  const listed = agencyList.body['playbooks'] as Record<string, unknown>[];
  assert.ok(listed.some((entry) => entry['playbookId'] === playbookId));
});

test('a Client-scoped Playbook persists with its Goal link; ownership is server-derived from the canonical Client owner', async () => {
  const created = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Client Growth Playbook', description: 'For one client', goalId },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const playbook = created.body;
  const playbookId = playbook['playbookId'] as string;

  assert.equal(playbook['agencyId'], agencyId, 'agency ownership is derived from the client owner');
  assert.equal(playbook['clientId'], clientId);
  assert.equal(playbook['goalId'], goalId);

  // The canonical owner context surfaces the goal → client → agency chain.
  const context = await apiCall(port(), `/api/playbooks/${playbookId}/ownership-context`, {
    token: operator.token,
  });
  assert.equal(context.status, 200, JSON.stringify(context.body));
  const scope = context.body['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'playbook');
  assert.equal(scope['agencyId'], agencyId);
  assert.equal(scope['clientId'], clientId);
  assert.equal(scope['goalId'], goalId);
  assert.equal(scope['playbookId'], playbookId);
  const client = context.body['client'] as Record<string, unknown>;
  assert.equal(client['clientId'], clientId);
  const goal = context.body['goal'] as Record<string, unknown>;
  assert.equal(goal['goalId'], goalId);
  assert.equal(goal['clientId'], clientId);
  const agency = context.body['agency'] as Record<string, unknown>;
  assert.equal(agency['agencyId'], agencyId);

  // The Agency-scoped ownership context has NO client and NO goal.
  const agencyScoped = await apiCall(port(), `/api/agencies/${agencyId}/playbooks`, {
    token: owner.token,
    body: { name: 'Scope Probe Playbook' },
  });
  assert.equal(agencyScoped.status, 201);
  const agencyScopedId = agencyScoped.body['playbookId'] as string;
  const agencyContext = await apiCall(
    port(),
    `/api/playbooks/${agencyScopedId}/ownership-context`,
    { token: operator.token },
  );
  assert.equal(agencyContext.status, 200);
  assert.equal(agencyContext.body['client'], undefined);
  assert.equal(agencyContext.body['goal'], undefined);

  // The client listing shows the client playbook (not the agency-scoped one).
  const clientList = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: operator.token,
  });
  assert.equal(clientList.status, 200);
  const clientPlaybooks = clientList.body['playbooks'] as Record<string, unknown>[];
  assert.ok(clientPlaybooks.some((entry) => entry['playbookId'] === playbookId));
  assert.ok(
    !clientPlaybooks.some((entry) => entry['playbookId'] === agencyScopedId),
    'agency-scoped reusable IP never lists under a client',
  );

  // Direct DB verification of the linked row.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ agency_id: string; client_id: string; goal_id: string }>(
      'SELECT agency_id, client_id, goal_id FROM playbooks WHERE playbook_id = $1',
      [playbookId],
    );
    assert.equal(rows.rows[0]!.agency_id, agencyId);
    assert.equal(rows.rows[0]!.client_id, clientId);
    assert.equal(rows.rows[0]!.goal_id, goalId);
  } finally {
    await db.close();
  }
});

test('PUBLISHED versions are immutable: content updates are rejected AND the database rejects direct rewrites (PLAY-AC-01)', async () => {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Immutability Playbook' },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;

  const created = await createVersion(
    playbookId,
    { strategy: strategyBody(), deploymentMetadata: deploymentMetadataBody() },
    owner.token,
  );
  assert.equal(created.status, 201);
  const versionId = created.body['versionId'] as string;

  // draft → review → published.
  assert.equal((await transitionVersion(playbookId, versionId, 'review', 1, owner.token)).status, 200);
  const published = await transitionVersion(playbookId, versionId, 'published', 2, owner.token);
  assert.equal(published.status, 200);
  assert.equal(published.body['status'], 'published');

  // Content update on a published version → 409.
  const blockedContent = await apiCall(
    port(),
    `/api/playbooks/${playbookId}/versions/${versionId}/profile`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { strategy: strategyBody({ summary: 'Rewritten after publish' }), version: 3 },
    },
  );
  assert.equal(blockedContent.status, 409, 'published content cannot be edited (PLAY-AC-01)');

  // The only legal transition out of published is retirement.
  const blockedBack = await transitionVersion(playbookId, versionId, 'review', 3, owner.token);
  assert.equal(blockedBack.status, 409, 'published → review is illegal');

  // The database itself rejects a direct content rewrite.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () =>
        db.query(`UPDATE playbook_versions SET strategy = '{"summary":"tampered"}'::jsonb WHERE version_id = $1`, [
          versionId,
        ]),
      /published playbook version .* content is immutable/,
    );
    await assert.rejects(
      () =>
        db.query(`UPDATE playbook_versions SET deployment_metadata = '{}'::jsonb WHERE version_id = $1`, [
          versionId,
        ]),
      /published playbook version .* content is immutable/,
    );
  } finally {
    await db.close();
  }

  // Retirement preserves content and freezes the version terminally.
  const retired = await transitionVersion(playbookId, versionId, 'retired', 3, owner.token);
  assert.equal(retired.status, 200, 'published → retired is the content-preserving retirement');
  assert.equal(retired.body['status'], 'retired');
  assert.equal(
    (retired.body['strategy'] as Record<string, unknown>)['summary'],
    'Land-and-expand inbound motion for technical buyers',
    'retirement preserves the published content',
  );

  // Every mutation on a retired version is rejected.
  const blockedRetiredStatus = await transitionVersion(playbookId, versionId, 'draft', 4, owner.token);
  assert.equal(blockedRetiredStatus.status, 409, 'retired is terminal');
  const blockedRetiredContent = await apiCall(
    port(),
    `/api/playbooks/${playbookId}/versions/${versionId}/profile`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { strategy: strategyBody(), version: 4 },
    },
  );
  assert.equal(blockedRetiredContent.status, 409, 'retired content is frozen');

  // The database rejects even a no-op-ish rewrite attempt on retired rows.
  const db2 = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () =>
        db2.query(`UPDATE playbook_versions SET strategy = '{"summary":"tampered"}'::jsonb WHERE version_id = $1`, [
          versionId,
        ]),
      /retired and frozen/,
    );
  } finally {
    await db2.close();
  }
});

test('the EXPLICIT version reference never floats: each reference resolves to exactly its own content forever (PLAY-AC-02 contract end)', async () => {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Explicit Reference Playbook' },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;

  // v1 with distinct content, published.
  const v1 = await createVersion(
    playbookId,
    { strategy: strategyBody({ summary: 'Version one strategy' }) },
    owner.token,
  );
  assert.equal(v1.status, 201);
  const v1Id = v1.body['versionId'] as string;
  await transitionVersion(playbookId, v1Id, 'review', 1, owner.token);
  await transitionVersion(playbookId, v1Id, 'published', 2, owner.token);

  // v2 with different content, published.
  const v2 = await createVersion(
    playbookId,
    { strategy: strategyBody({ summary: 'Version two strategy' }) },
    owner.token,
  );
  assert.equal(v2.status, 201);
  const v2Id = v2.body['versionId'] as string;
  await transitionVersion(playbookId, v2Id, 'review', 1, owner.token);
  await transitionVersion(playbookId, v2Id, 'published', 2, owner.token);

  // Retire v1 — historical versions stay resolvable.
  await transitionVersion(playbookId, v1Id, 'retired', 3, owner.token);

  // The EXPLICIT v1 reference still resolves to EXACTLY v1 content — it
  // never floats to v2, even after v2 exists and v1 is retired.
  const readV1 = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${v1Id}`, {
    token: operator.token,
  });
  assert.equal(readV1.status, 200, 'retired version references stay resolvable');
  assert.equal(readV1.body['versionNumber'], 1);
  assert.equal(readV1.body['status'], 'retired');
  assert.equal((readV1.body['strategy'] as Record<string, unknown>)['summary'], 'Version one strategy');

  const readV2 = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${v2Id}`, {
    token: operator.token,
  });
  assert.equal(readV2.status, 200);
  assert.equal(readV2.body['versionNumber'], 2);
  assert.equal(readV2.body['status'], 'published');
  assert.equal((readV2.body['strategy'] as Record<string, unknown>)['summary'], 'Version two strategy');

  // The two references are distinct identities with distinct content.
  assert.notEqual(readV1.body['versionId'], readV2.body['versionId']);
  assert.notEqual(readV1.body['strategy'], readV2.body['strategy']);

  // A version id of a DIFFERENT playbook is indistinguishable from an
  // unknown one under this playbook (uniform 404).
  const otherPlaybook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Other Playbook' },
  });
  assert.equal(otherPlaybook.status, 201);
  const otherVersion = await createVersion(
    otherPlaybook.body['playbookId'] as string,
    { strategy: strategyBody() },
    owner.token,
  );
  assert.equal(otherVersion.status, 201);
  const foreignRead = await apiCall(
    port(),
    `/api/playbooks/${playbookId}/versions/${otherVersion.body['versionId']}`,
    { token: operator.token },
  );
  assert.equal(foreignRead.status, 404, 'a foreign version id is not an existence oracle');
});

test('authority fields are rejected on every input surface (422)', async () => {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Authority Field Playbook' },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;

  // Create: server-derived fields.
  for (const authorityField of ['playbookId', 'agencyId', 'clientId', 'version', 'status', 'createdBy', 'createdAt']) {
    const response = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
      token: owner.token,
      body: { name: 'Rejected', [authorityField]: 'injected' },
    });
    assert.equal(response.status, 422, `${authorityField} must be rejected on create`);
  }

  // Container profile: scope and identity are immutable.
  const profile = await apiCall(port(), `/api/playbooks/${playbookId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Renamed', version: 1, goalId },
  });
  assert.equal(profile.status, 422, 'goal link reassignment is rejected as an authority field');

  // Version create: explicit identity is server-assigned.
  for (const authorityField of ['versionId', 'playbookId', 'versionNumber', 'status', 'version', 'createdBy']) {
    const response = await createVersion(playbookId, {
      strategy: strategyBody(),
      [authorityField]: authorityField === 'status' ? 'published' : 'injected',
    }, owner.token);
    assert.equal(response.status, 422, `${authorityField} must be rejected on version create`);
  }

  // Version content update: status is not content.
  const created = await createVersion(playbookId, { strategy: strategyBody() }, owner.token);
  assert.equal(created.status, 201);
  const versionId = created.body['versionId'] as string;
  const content = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { strategy: strategyBody(), version: 1, status: 'published' },
  });
  assert.equal(content.status, 422, 'status is rejected on the content route');

  // Version status route: content is not lifecycle.
  const status = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'review', version: 1, strategy: strategyBody() },
  });
  assert.equal(status.status, 422, 'strategy is rejected on the status route');
});

test('CAS updates bump versions and replace content', async () => {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'CAS Playbook', description: 'Before' },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;

  // Container profile CAS.
  const profile = await apiCall(port(), `/api/playbooks/${playbookId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'CAS Playbook Renamed', description: 'After', version: 1 },
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.equal(profile.body['version'], 2);
  assert.equal(profile.body['name'], 'CAS Playbook Renamed');
  assert.equal(profile.body['description'], 'After');

  // Version content CAS.
  const created = await createVersion(
    playbookId,
    { strategy: strategyBody(), deploymentMetadata: deploymentMetadataBody() },
    owner.token,
  );
  assert.equal(created.status, 201);
  const versionId = created.body['versionId'] as string;
  const updated = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: {
      strategy: strategyBody({ summary: 'Revised draft summary' }),
      deploymentMetadata: { runtimeRequirements: { runtimeClass: 'ephemeral-sandbox' } },
      version: 1,
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body['version'], 2);
  assert.equal((updated.body['strategy'] as Record<string, unknown>)['summary'], 'Revised draft summary');
  const metadata = updated.body['deploymentMetadata'] as Record<string, unknown>;
  assert.deepEqual(metadata['runtimeRequirements'], { runtimeClass: 'ephemeral-sandbox' });
  assert.deepEqual(metadata['requiredDomainPacks'], [], 'full replacement semantics');

  // Stale CAS token → 409.
  const stale = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { strategy: strategyBody(), version: 1 },
  });
  assert.equal(stale.status, 409);

  // Stale container CAS → 409.
  const staleProfile = await apiCall(port(), `/api/playbooks/${playbookId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Stale', version: 1 },
  });
  assert.equal(staleProfile.status, 409);
});

test('illegal lifecycle transitions are rejected (frozen machine)', async () => {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Lifecycle Playbook' },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;

  // draft → published (skip review) is illegal.
  const skip = await createVersion(playbookId, { strategy: strategyBody() }, owner.token);
  assert.equal(skip.status, 201);
  const skipId = skip.body['versionId'] as string;
  assert.equal((await transitionVersion(playbookId, skipId, 'published', 1, owner.token)).status, 409);
  // draft → retired is illegal.
  assert.equal((await transitionVersion(playbookId, skipId, 'retired', 1, owner.token)).status, 409);

  // review → draft (back-edge) and review → retired are illegal.
  assert.equal((await transitionVersion(playbookId, skipId, 'review', 1, owner.token)).status, 200);
  assert.equal((await transitionVersion(playbookId, skipId, 'draft', 2, owner.token)).status, 409);
  assert.equal((await transitionVersion(playbookId, skipId, 'retired', 2, owner.token)).status, 409);

  // published → draft and published → review are illegal (covered further
  // in the immutability test); self-transitions are illegal.
  assert.equal((await transitionVersion(playbookId, skipId, 'published', 2, owner.token)).status, 200);
  assert.equal((await transitionVersion(playbookId, skipId, 'published', 3, owner.token)).status, 409);
  assert.equal((await transitionVersion(playbookId, skipId, 'review', 3, owner.token)).status, 409);

  // Stale CAS on a legal transition → 409.
  const second = await createVersion(playbookId, { strategy: strategyBody() }, owner.token);
  assert.equal(second.status, 201);
  const secondId = second.body['versionId'] as string;
  assert.equal((await transitionVersion(playbookId, secondId, 'review', 99, owner.token)).status, 409);
});

test('validation matrix: malformed strategy/metadata shapes are rejected (422)', async () => {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Validation Playbook' },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;

  const invalidBodies: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['empty summary', { strategy: { summary: '   ', templates: [] } }],
    ['missing summary', { strategy: { templates: [] } }],
    ['templates not an array', { strategy: { summary: 's', templates: 'nope' } }],
    ['unnamed template', { strategy: { summary: 's', templates: [{ description: 'no name' }] } }],
    ['strategy not an object', { strategy: 'summary text' }],
    ['unknown capability kind', { strategy: strategyBody(), deploymentMetadata: { requiredCapabilities: [{ kind: 'plugin', name: 'x' }] } }],
    ['unnamed capability', { strategy: strategyBody(), deploymentMetadata: { requiredCapabilities: [{ kind: 'integration' }] } }],
    ['unnamed domain pack', { strategy: strategyBody(), deploymentMetadata: { requiredDomainPacks: [{ versionConstraint: '>=1' }] } }],
    ['unknown runtime class', { strategy: strategyBody(), deploymentMetadata: { runtimeRequirements: { runtimeClass: 'serverless' } } }],
    ['unknown trigger kind', { strategy: strategyBody(), deploymentMetadata: { triggers: [{ kind: 'webhook' }] } }],
    ['unknown top-level key', { strategy: strategyBody(), workflowGraph: { nodes: [] } }],
    ['unknown metadata key', { strategy: strategyBody(), deploymentMetadata: { policySnapshot: 'x' } }],
  ];
  for (const [label, body] of invalidBodies) {
    const response = await createVersion(playbookId, body, owner.token);
    assert.equal(response.status, 422, `${label} must be rejected`);
  }

  // Container validation.
  const badName = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: '' },
  });
  assert.equal(badName.status, 422, 'empty playbook name is rejected');

  // Valid runtime classes from the frozen compute-allocation list pass.
  for (const runtimeClass of ['pooled-worker', 'ephemeral-sandbox', 'persistent-sandbox', 'dedicated-runtime']) {
    const response = await createVersion(
      playbookId,
      { strategy: strategyBody(), deploymentMetadata: { runtimeRequirements: { runtimeClass } } },
      owner.token,
    );
    assert.equal(response.status, 201, `${runtimeClass} is a valid runtime class`);
  }
});

test('authorization matrix: writes need owner/admin; reads need membership; service principal and platform admin pass; anonymous is 401', async () => {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    body: { name: 'Authorization Playbook' },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;

  // An operator (member without owner/admin role) can READ…
  const read = await apiCall(port(), `/api/playbooks/${playbookId}`, { token: operator.token });
  assert.equal(read.status, 200);
  const list = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token: operator.token,
  });
  assert.equal(list.status, 200);

  // …but not WRITE.
  const create = await createVersion(playbookId, { strategy: strategyBody() }, operator.token);
  assert.equal(create.status, 403, 'version creation requires owner/admin');
  const profile = await apiCall(port(), `/api/playbooks/${playbookId}/profile`, {
    token: operator.token,
    method: 'PATCH',
    body: { name: 'Nope', version: 1 },
  });
  assert.equal(profile.status, 403);
  const agencyCreate = await apiCall(port(), `/api/agencies/${agencyId}/playbooks`, {
    token: operator.token,
    body: { name: 'Nope' },
  });
  assert.equal(agencyCreate.status, 403);

  // Platform admin passes (both read and write).
  const admin = await adminToken();
  const adminCreate = await createVersion(playbookId, { strategy: strategyBody() }, admin);
  assert.equal(adminCreate.status, 201, 'platform administrator passes');

  // Internal service principal: authorized machine-to-machine access.
  const service = await apiCall(port(), `/api/playbooks/${playbookId}`, {
    headers: { authorization: `Bearer ${stack!.env.internalApiToken}` },
  });
  assert.equal(service.status, 200);
  const serviceCreate = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    headers: { authorization: `Bearer ${stack!.env.internalApiToken}` },
    body: { strategy: strategyBody() },
  });
  assert.equal(serviceCreate.status, 201, 'service principal can create versions');

  // Anonymous never reaches authorization.
  const anonymous = await apiCall(port(), `/api/playbooks/${playbookId}`);
  assert.equal(anonymous.status, 401);
  const anonymousCreate = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    body: { strategy: strategyBody() },
  });
  assert.equal(anonymousCreate.status, 401);
});

test('material playbook mutations emit correlated audit records with playbook scope and CAS versions', async () => {
  const correlationId = randomUUID();
  const created = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token: owner.token,
    correlationId,
    body: { name: 'Audited Playbook' },
  });
  assert.equal(created.status, 201);
  const playbookId = created.body['playbookId'] as string;

  const version = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token: owner.token,
    correlationId,
    body: { strategy: strategyBody() },
  });
  assert.equal(version.status, 201);
  const versionId = version.body['versionId'] as string;

  const updated = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/profile`, {
    token: owner.token,
    correlationId,
    method: 'PATCH',
    body: { strategy: strategyBody({ summary: 'Audited revision' }), version: 1 },
  });
  assert.equal(updated.status, 200);

  const toReview = await apiCall(
    port(),
    `/api/playbooks/${playbookId}/versions/${versionId}/status`,
    {
      token: owner.token,
      correlationId,
      method: 'PATCH',
      body: { status: 'review', version: 2 },
    },
  );
  assert.equal(toReview.status, 200);
  const toPublished = await apiCall(
    port(),
    `/api/playbooks/${playbookId}/versions/${versionId}/status`,
    {
      token: owner.token,
      correlationId,
      method: 'PATCH',
      body: { status: 'published', version: 3 },
    },
  );
  assert.equal(toPublished.status, 200);

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
       FROM audit_events
       WHERE (target_type = 'playbook' AND target_id = $1)
          OR (target_type = 'playbook_version' AND target_id = $2)
       ORDER BY occurred_at`,
      [playbookId, versionId],
    );
    // playbook.created + version.created + version.content_updated +
    // version.status_changed ×2.
    assert.equal(rows.rows.length, 5, JSON.stringify(rows.rows.map((row) => row.action)));
    const [created_, versionCreated, contentUpdated, toReview, toPublished] = rows.rows;

    for (const row of rows.rows) {
      assert.equal(row.agency_id, agencyId, 'audit carries the owning agency');
      assert.equal(row.client_id, clientId, 'audit carries the owning client for client-scoped playbooks');
      assert.equal(row.workspace_id, null, 'playbooks carry no workspace scope');
      assert.equal(row.correlation_id, correlationId, 'correlation propagated to audit');
    }

    assert.equal(created_!.action, 'playbooks.playbook.created');
    assert.equal(created_!.target_type, 'playbook');
    assert.equal(Number(created_!.after_version), 1);
    assert.equal(created_!.idempotency_key, `playbooks.playbook.created:${playbookId}`);

    assert.equal(versionCreated!.action, 'playbooks.version.created');
    assert.equal(versionCreated!.target_type, 'playbook_version');
    assert.equal(versionCreated!.idempotency_key, `playbooks.version.created:${versionId}`);

    assert.equal(contentUpdated!.action, 'playbooks.version.content_updated');
    assert.equal(Number(contentUpdated!.before_version), 1);
    assert.equal(Number(contentUpdated!.after_version), 2);

    assert.equal(toReview!.action, 'playbooks.version.status_changed');
    assert.equal(Number(toReview!.after_version), 3);
    assert.equal(toPublished!.action, 'playbooks.version.status_changed');
    assert.equal(Number(toPublished!.after_version), 4);
  } finally {
    await db.close();
  }
});

test('boundary policy: a disabled Client blocks new playbook use (409) without rewriting history', async () => {
  const disabledClient = await makeClient(agencyId, 'Disabled Playbooks Client');
  const goalInClient = await makeGoal(disabledClient, owner.token);

  const playbook = await apiCall(port(), `/api/clients/${disabledClient}/playbooks`, {
    token: owner.token,
    body: { name: 'Pre-disable Playbook', goalId: goalInClient },
  });
  assert.equal(playbook.status, 201);
  const playbookId = playbook.body['playbookId'] as string;
  const version = await createVersion(playbookId, { strategy: strategyBody() }, owner.token);
  assert.equal(version.status, 201);
  const versionId = version.body['versionId'] as string;

  const disable = await apiCall(port(), `/api/clients/${disabledClient}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disable.status, 200);

  // New use is blocked (409): creating playbooks and versions.
  const blockedCreate = await apiCall(port(), `/api/clients/${disabledClient}/playbooks`, {
    token: owner.token,
    body: { name: 'Blocked' },
  });
  assert.equal(blockedCreate.status, 409);
  const blockedVersion = await createVersion(playbookId, { strategy: strategyBody() }, owner.token);
  assert.equal(blockedVersion.status, 409, 'version creation is new use — blocked');

  // History stays READABLE.
  const read = await apiCall(port(), `/api/playbooks/${playbookId}`, { token: owner.token });
  assert.equal(read.status, 200, 'disabled client does not erase playbook history');
  const listVersions = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token: owner.token,
  });
  assert.equal(listVersions.status, 200);

  // Editorial and history transitions remain available; PUBLICATION (new
  // use) is blocked under a disabled client.
  assert.equal((await transitionVersion(playbookId, versionId, 'review', 1, owner.token)).status, 200);
  const blockedPublish = await transitionVersion(playbookId, versionId, 'published', 2, owner.token);
  assert.equal(blockedPublish.status, 409, 'publication is new use — blocked');

  // Re-enable restores normal operation.
  const enable = await apiCall(port(), `/api/clients/${disabledClient}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: 2 },
  });
  assert.equal(enable.status, 200);
  const restoredPublish = await transitionVersion(playbookId, versionId, 'published', 2, owner.token);
  assert.equal(restoredPublish.status, 200, 're-enabling restores publication');
});
