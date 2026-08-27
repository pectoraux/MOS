/**
 * MKT-008 concurrency integration test — exactly-one-winner semantics for
 * the versioned Workflow definition domain on real PostgreSQL + a real API
 * subprocess.
 *
 * Proofs (implementation-contract §3 "version/CAS token where concurrent
 * mutation is possible"; §4 "A Workflow Definition is versioned and
 * immutable after activation"; work-items.md MKT-008 acceptance
 * "versioning tests"):
 *   - concurrent definition CREATION serializes to DISTINCT sequential
 *     version numbers (no duplicates, no gaps — the workflow row lock
 *     assigns MAX+1 under serialization, and the UNIQUE fence backstops);
 *   - concurrent identical definition CONTENT updates (same CAS token)
 *     yield EXACTLY ONE winner — the losers get 409, the version bumps
 *     once;
 *   - concurrent identical definition LIFECYCLE transitions (same CAS
 *     token) yield EXACTLY ONE winner — for the editorial review step AND
 *     for activation;
 *   - concurrent identical container profile updates yield EXACTLY ONE
 *     winner;
 *   - database backstops: activated content rewrites and the explicit
 *     version identity reassignment are rejected under and after races.
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

const owner: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';

before(async () => {
  stack = await bootStack('workflowconcurrency');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@workflow-concurrency.test', 'Concurrency Owner', 'concurrency-owner-pass'));
  agencyId = await makeAgency('Concurrency Agency', owner);
  clientId = await makeClient(agencyId, 'Concurrency Client');
  workspaceId = await makeWorkspace(clientId, 'Concurrency Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('concurrent definition CREATION serializes to distinct sequential version numbers (no duplicates, no gaps)', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Version Allocation Race' },
  });
  assert.equal(created.status, 201);
  const workflowId = created.body['workflowId'] as string;

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
        token: owner.token,
        body: definitionBody({
          concurrencyLimits: { maxConcurrentWorkflows: index + 1 },
        }),
      }),
    ),
  );
  const numbers = results
    .map((response) => {
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body['versionNumber'] as number;
    })
    .sort((a, b) => a - b);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);

  // A 9th create after the race continues the sequence.
  const ninth = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: definitionBody(),
  });
  assert.equal(ninth.status, 201);
  assert.equal(ninth.body['versionNumber'], 9);

  // The UNIQUE fence is visible in the database: exactly 9 rows.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM workflow_definitions WHERE workflow_id = $1',
      [workflowId],
    );
    assert.equal(Number(rows.rows[0]!.count), 9);
  } finally {
    await db.close();
  }
});

test('concurrent identical definition CONTENT updates yield exactly one winner', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Content CAS Race' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: definitionBody(),
  });
  assert.equal(definition.status, 201);
  const definitionId = definition.body['workflowDefinitionId'] as string;

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/profile`, {
        token: owner.token,
        method: 'PATCH',
        body: { ...definitionBody(), version: 1 },
      }),
    ),
  );
  const winners = results.filter((response) => response.status === 200);
  const losers = results.filter((response) => response.status === 409);
  assert.equal(winners.length, 1, `exactly one winner: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(losers.length, 7);
  assert.equal(winners[0]!.body['version'], 2);
});

test('concurrent identical definition LIFECYCLE transitions yield exactly one winner (review and activation)', async () => {
  // --- editorial review race ---
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Review CAS Race' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: definitionBody(),
  });
  const definitionId = definition.body['workflowDefinitionId'] as string;

  const reviewResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
        token: owner.token,
        method: 'PATCH',
        body: { status: 'review', version: 1 },
      }),
    ),
  );
  assert.equal(reviewResults.filter((r) => r.status === 200).length, 1);
  assert.equal(reviewResults.filter((r) => r.status === 409).length, 7);

  // --- activation race (the immutability point) ---
  const activationResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
        token: owner.token,
        method: 'PATCH',
        body: { status: 'active', version: 2 },
      }),
    ),
  );
  assert.equal(activationResults.filter((r) => r.status === 200).length, 1);
  assert.equal(activationResults.filter((r) => r.status === 409).length, 7);

  // The single activated winner is now immutable.
  const read = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}`, {
    token: owner.token,
  });
  assert.equal(read.body['status'], 'active');
  const contentAttempt = await apiCall(
    port(),
    `/api/workflows/${workflowId}/definitions/${definitionId}/profile`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { ...definitionBody(), version: 3 },
    },
  );
  assert.equal(contentAttempt.status, 409);
});

test('concurrent identical container PROFILE updates yield exactly one winner', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Profile CAS Race' },
  });
  const workflowId = created.body['workflowId'] as string;

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/workflows/${workflowId}/profile`, {
        token: owner.token,
        method: 'PATCH',
        body: { name: 'Race Winner', version: 1 },
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
});

test('database backstops: activated content rewrites and version identity reassignment are rejected under and after races', async () => {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'DB Race Backstop' },
  });
  const workflowId = created.body['workflowId'] as string;
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: definitionBody(),
  });
  const definitionId = definition.body['workflowDefinitionId'] as string;
  assert.equal(
    (
      await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
        token: owner.token,
        method: 'PATCH',
        body: { status: 'review', version: 1 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
        token: owner.token,
        method: 'PATCH',
        body: { status: 'active', version: 2 },
      })
    ).status,
    200,
  );

  // Direct database rewrites of the activated definition race-tamper: the
  // trigger rejects them regardless of when they arrive.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const tampering = Promise.all([
      db.query(`UPDATE workflow_definitions SET graph = '{}'::jsonb WHERE workflow_definition_id = $1`, [
        definitionId,
      ]),
      db.query(`UPDATE workflow_definitions SET version_number = 999 WHERE workflow_definition_id = $1`, [
        definitionId,
      ]),
      db.query(`UPDATE workflow_definitions SET input_schema = '{}'::jsonb WHERE workflow_definition_id = $1`, [
        definitionId,
      ]),
    ]);
    await assert.rejects(() => tampering, /immutable after activation|identity and provenance are immutable|number .* is immutable/);
  } finally {
    await db.close();
  }

  // The definition still resolves byte-for-byte through the explicit
  // reference.
  const read = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}`, {
    token: owner.token,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body['status'], 'active');
  assert.deepEqual(read.body['graph'], definitionBody().graph);
});
