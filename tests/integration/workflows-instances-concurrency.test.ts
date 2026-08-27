/**
 * MKT-009 concurrency integration test — exactly-one-winner and
 * convergence semantics for the Workflow instance state machine on real
 * PostgreSQL + a real API subprocess.
 *
 * Proofs (implementation-contract §5 "transitions use CAS/version checks";
 * "duplicate transition requests are idempotent"; work-items.md MKT-009
 * acceptance WF-AC-03 "duplicate events/executions converge idempotently —
 * integration/concurrency test"):
 *   - concurrent instance CREATION of one ACTIVE definition all succeeds
 *     with distinct server-generated identities (append-oriented; no
 *     content fence);
 *   - concurrent DUPLICATE transitions (same idempotency key, same
 *     target, same CAS token) converge: exactly ONE applies, every other
 *     request replays the recorded outcome (200, replayed=true), the
 *     version bumps ONCE and the history holds exactly ONE row — the
 *     at-least-once delivery model converges instead of erroring;
 *   - concurrent DISTINCT transitions with the SAME CAS token yield
 *     exactly one winner — the losers get deterministic 409s;
 *   - concurrent TERMINAL races (cancel vs succeed with the same CAS
 *     token) yield exactly one terminal outcome — terminal states are
 *     immutable, so the loser is rejected and the winner is final;
 *   - the idempotency fence is per-instance: the same key on a DIFFERENT
 *     instance is an independent command.
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

async function makeWorkflow(name: string): Promise<string> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name, description: '' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['workflowId'] as string;
}

async function makeActiveDefinition(workflowId: string): Promise<string> {
  const created = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: definitionBody(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const definitionId = created.body['workflowDefinitionId'] as string;
  let version = created.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: owner.token,
      method: 'PATCH',
      body: { status, version },
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    version = next.body['version'] as number;
  }
  return definitionId;
}

async function makeInstance(workflowId: string, definitionId: string): Promise<string> {
  const response = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['workflowInstanceId'] as string;
}

async function transition(
  workflowId: string,
  instanceId: string,
  to: string,
  version: number,
  idempotencyKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token: owner.token,
    body: { to, version, idempotencyKey },
  });
}

const owner: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';

before(async () => {
  stack = await bootStack('workflowinstancesconc');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@workflow-instances-conc.test', 'Concurrency Owner', 'instances-conc-owner-pass'));
  agencyId = await makeAgency('Instances Concurrency Agency', owner);
  clientId = await makeClient(agencyId, 'Instances Concurrency Client');
  workspaceId = await makeWorkspace(clientId, 'Instances Concurrency Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('concurrent instance CREATION of one ACTIVE definition all succeeds with distinct identities', async () => {
  const workflowId = await makeWorkflow('Creation Race Workflow');
  const definitionId = await makeActiveDefinition(workflowId);

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
        token: owner.token,
        body: {},
      }),
    ),
  );
  const ids = results.map((response) => {
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body['workflowInstanceId'] as string;
  });
  assert.equal(new Set(ids).size, 8, 'every instance has a distinct server-generated identity');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM workflow_instances WHERE workflow_id = $1',
      [workflowId],
    );
    assert.equal(Number(rows.rows[0]!.count), 8);
  } finally {
    await db.close();
  }
});

test('concurrent DUPLICATE transitions converge: one applies, the rest replay, the version bumps once (WF-AC-03)', async () => {
  const workflowId = await makeWorkflow('Duplicate Convergence Race Workflow');
  const definitionId = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // 8 concurrent copies of the SAME logical command (same key, same
  // target, same CAS token) — the at-least-once delivery storm.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => transition(workflowId, instanceId, 'ready', 1, 'race-stage-1')),
  );
  const applied = results.filter((response) => response.status === 200 && response.body['replayed'] === false);
  const replayed = results.filter((response) => response.status === 200 && response.body['replayed'] === true);
  assert.equal(applied.length, 1, `exactly one application: ${JSON.stringify(results.map((r) => [r.status, r.body['replayed']]))}`);
  assert.equal(replayed.length, 7, 'every duplicate converges to the recorded outcome');
  // Every response names the SAME recorded transition.
  const transitionIds = new Set(
    results.map((response) => (response.body['transition'] as Record<string, unknown>)['transitionId']),
  );
  assert.equal(transitionIds.size, 1);
  // The instance is READY with the version bumped exactly ONCE.
  const read = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: owner.token,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body['status'], 'ready');
  assert.equal(read.body['version'], 2);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM workflow_instance_transitions WHERE workflow_instance_id = $1',
      [instanceId],
    );
    assert.equal(Number(rows.rows[0]!.count), 1, 'exactly ONE history row for the duplicate storm');
  } finally {
    await db.close();
  }
});

test('concurrent DISTINCT transitions with the SAME CAS token yield exactly one winner', async () => {
  const workflowId = await makeWorkflow('Distinct CAS Race Workflow');
  const definitionId = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // Stage to RUNNING first — the only state from which the four
  // competitors are legal targets.
  const staged = await transition(workflowId, instanceId, 'ready', 1, 'distinct-stage');
  assert.equal(staged.status, 200);
  const started = await transition(workflowId, instanceId, 'running', 2, 'distinct-start');
  assert.equal(started.status, 200);

  // Concurrent competitors for the same CAS token: pause vs block vs
  // cancel vs succeed — exactly one can win.
  const targets = ['paused', 'blocked', 'cancelled', 'succeeded'] as const;
  const results = await Promise.all(
    targets.map((to, index) => transition(workflowId, instanceId, to, 3, `race-distinct-${index}`)),
  );
  const winners = results.filter((response) => response.status === 200);
  const losers = results.filter((response) => response.status === 409);
  assert.equal(winners.length, 1, `exactly one winner: ${JSON.stringify(results.map((r) => [r.status, r.body['message'] ?? r.body['error']]))}`);
  assert.equal(losers.length, targets.length - 1);

  // The winner's target is the instance's durable state.
  const read = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: owner.token,
  });
  assert.equal(read.status, 200);
  const finalStatus = read.body['status'] as string;
  const winner = winners[0]!;
  assert.equal(finalStatus, (winner.body['instance'] as Record<string, unknown>)['status']);
  assert.ok((['paused', 'blocked', 'cancelled', 'succeeded'] as const).includes(finalStatus as never));

  // The losers were rejected BEFORE any row was written: exactly one of
  // the four competitor commands has a history row (the two staging
  // commands each have their own).
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workflow_instance_transitions
       WHERE workflow_instance_id = $1 AND idempotency_key LIKE 'race-distinct-%'`,
      [instanceId],
    );
    assert.equal(Number(rows.rows[0]!.count), 1);
    const total = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM workflow_instance_transitions WHERE workflow_instance_id = $1',
      [instanceId],
    );
    assert.equal(Number(total.rows[0]!.count), 3);
  } finally {
    await db.close();
  }
});

test('concurrent TERMINAL race (cancel vs succeed): exactly one terminal outcome, and it is final', async () => {
  const workflowId = await makeWorkflow('Terminal Race Workflow');
  const definitionId = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // Bring the instance to running first (the only state with terminal
  // edges).
  const staged = await transition(workflowId, instanceId, 'ready', 1, 'terminal-race-stage');
  assert.equal(staged.status, 200);
  const started = await transition(workflowId, instanceId, 'running', 2, 'terminal-race-start');
  assert.equal(started.status, 200);

  // Fire cancel and succeed concurrently with the same CAS token.
  const results = await Promise.all([
    transition(workflowId, instanceId, 'cancelled', 3, 'terminal-race-cancel'),
    transition(workflowId, instanceId, 'succeeded', 3, 'terminal-race-succeed'),
  ]);
  const winners = results.filter((response) => response.status === 200);
  const losers = results.filter((response) => response.status === 409);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);

  // The winner is FINAL: the loser's target can never be reached anymore.
  const loserTarget = losers[0]!.body === results[0]!.body ? 'succeeded' : 'cancelled';
  const retryLoser = await transition(workflowId, instanceId, loserTarget, 4, 'terminal-race-retry');
  assert.equal(retryLoser.status, 409, 'terminal states are immutable — the race is settled');

  const read = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: owner.token,
  });
  const finalStatus = read.body['status'] as string;
  assert.ok(finalStatus === 'cancelled' || finalStatus === 'succeeded');
  assert.equal(read.body['version'], 4);
});

test('the idempotency fence is PER-INSTANCE: the same key on another instance is an independent command', async () => {
  const workflowId = await makeWorkflow('Fence Scope Workflow');
  const definitionId = await makeActiveDefinition(workflowId);
  const first = await makeInstance(workflowId, definitionId);
  const second = await makeInstance(workflowId, definitionId);

  // The same key applies independently on both instances.
  const firstResult = await transition(workflowId, first, 'ready', 1, 'shared-key');
  const secondResult = await transition(workflowId, second, 'ready', 1, 'shared-key');
  assert.equal(firstResult.status, 200);
  assert.equal(secondResult.status, 200);
  assert.equal(firstResult.body['replayed'], false);
  assert.equal(secondResult.body['replayed'], false);
  assert.notEqual(
    (firstResult.body['transition'] as Record<string, unknown>)['transitionId'],
    (secondResult.body['transition'] as Record<string, unknown>)['transitionId'],
  );

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ workflow_instance_id: string; count: string }>(
      `SELECT workflow_instance_id, COUNT(*)::text AS count
       FROM workflow_instance_transitions
       WHERE workflow_instance_id IN ($1, $2) AND idempotency_key = 'shared-key'
       GROUP BY workflow_instance_id`,
      [first, second],
    );
    assert.equal(rows.rows.length, 2);
    for (const row of rows.rows) {
      assert.equal(Number(row.count), 1);
    }
  } finally {
    await db.close();
  }
});
