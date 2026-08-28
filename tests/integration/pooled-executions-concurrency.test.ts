/**
 * MKT-011 concurrency integration tests — the pooled path's fences under
 * parallel commands and parallel workers (real embedded PostgreSQL 18, real
 * API process, real drain-mode worker processes).
 *
 * Proofs (EXEC-AC-03 concurrency posture; implementation-contract §8 "the
 * database, not application check-then-insert, is the duplicate fence"):
 *   1. N concurrent DUPLICATE dispatch commands (same key, same command)
 *      converge to ONE dispatch row and ONE queue job — exactly one 201,
 *      the rest 200 replays;
 *   2. N concurrent DISTINCT-key dispatch commands against the SAME
 *      execution resolve to exactly ONE winner (the per-execution UNIQUE
 *      fence) — one 201, the rest 409;
 *   3. TWO worker processes draining the same queue partition process N
 *      distinct dispatched executions: every job completes with exactly
 *      one successful attempt-owner, every execution reaches succeeded
 *      with the exact frozen-machine history (SKIP LOCKED never
 *      double-claims; the idempotency-fenced transitions converge).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnWorker,
  waitFor,
  type IntegrationStack,
} from './helpers/harness.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('pooledconc');
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

async function makeTenant(label: string): Promise<{ workspaceId: string; ownerToken: string }> {
  const admin = await adminToken();
  const email = `${label}-owner@marketingos.test`;
  const user = await apiCall(port(), '/api/users', { token: admin, body: { email, displayName: label } });
  assert.equal(user.status, 201);
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: `${label}-pass-123` } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: `${label}-pass-123` } });
  assert.equal(login.status, 200);
  const ownerToken = login.body['token'] as string;
  const agency = await apiCall(port(), '/api/agencies', { token: admin, body: { name: `${label} agency`, ownerUserId: userId } });
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, { token: admin, body: { name: `${label} client` } });
  const clientId = client.body['clientId'] as string;
  const ws = await apiCall(port(), `/api/clients/${clientId}/workspaces`, { token: admin, body: { name: `${label} ws` } });
  assert.equal(ws.status, 201);
  return { workspaceId: ws.body['workspaceId'] as string, ownerToken };
}

let counter = 0;
async function createPooledExecution(workspaceId: string, ownerToken: string): Promise<string> {
  counter += 1;
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: ownerToken,
    body: {
      workflowInstanceId: `00000000-0000-7000-8000-${String(9000 + counter).padStart(12, '0')}`,
      nodeId: `node-${counter}`,
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey: `conc-create-${counter}`,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

test('8 concurrent duplicate dispatch commands converge to one dispatch row and one job', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('dup8');
  const executionId = await createPooledExecution(tenant.workspaceId, tenant.ownerToken);
  const body = {
    taskKind: 'data.transform',
    input: { records: [{ c: 1 }] },
    idempotencyKey: 'conc-dup-key',
  };

  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      apiCall(port(), `/api/executions/${executionId}/dispatch`, { token: tenant.ownerToken, body }),
    ),
  );
  const created = responses.filter((r) => r.status === 201);
  const replayed = responses.filter((r) => r.status === 200);
  assert.equal(created.length, 1, 'exactly one create wins the fence');
  assert.equal(replayed.length, 7, 'the rest converge as replays');
  const dispatchId = (created[0]!.body['dispatch'] as Record<string, unknown>)['dispatchId'] as string;
  for (const response of replayed) {
    assert.equal(
      (response.body['dispatch'] as Record<string, unknown>)['dispatchId'],
      dispatchId,
      'every replay converges to the SAME dispatch identity',
    );
  }

  const rows = await st.pg.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM execution_dispatches WHERE execution_id = $1`,
    [executionId],
  );
  assert.equal(rows.rows[0]?.count, '1', 'one dispatch row (DB fence)');

  // Drain and verify ONE job and a clean single completion.
  const worker = await spawnWorker(st.env);
  assert.equal(await worker.exitCode(), 0);
  const jobCount = await st.pg.pool.query<{ count: string; attempts: string }>(
    `SELECT count(*)::text AS count, max(attempts)::text AS attempts FROM platform_jobs WHERE idempotency_key = $1`,
    [`execution-dispatch:${executionId}:1`],
  );
  assert.equal(jobCount.rows[0]?.count, '1', 'one queue job');
  assert.equal(jobCount.rows[0]?.attempts, '1', 'one attempt');

  const final = await waitFor(
    `execution ${executionId} succeeded`,
    () => apiCall(port(), `/api/executions/${executionId}`, { token: tenant.ownerToken }),
    (r) => r.body['status'] === 'succeeded',
  );
  assert.equal(final.body['status'], 'succeeded');
});

test('6 concurrent distinct-key dispatch commands against one execution: exactly one winner', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('distinct6');
  const executionId = await createPooledExecution(tenant.workspaceId, tenant.ownerToken);

  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      apiCall(port(), `/api/executions/${executionId}/dispatch`, {
        token: tenant.ownerToken,
        body: {
          taskKind: 'data.transform',
          input: { records: [{ d: index }] },
          idempotencyKey: `conc-distinct-${index}`,
        },
      }),
    ),
  );
  const created = responses.filter((r) => r.status === 201);
  const conflicts = responses.filter((r) => r.status === 409);
  assert.equal(created.length, 1, 'the per-execution UNIQUE fence admits exactly one dispatch');
  assert.equal(conflicts.length, 5, 'every other dispatch command is a conflict');

  const rows = await st.pg.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM execution_dispatches WHERE execution_id = $1`,
    [executionId],
  );
  assert.equal(rows.rows[0]?.count, '1');
});

test('two worker processes drain 8 distinct dispatches: each job exactly once, all executions succeed', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('scale8');
  const executionIds: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const executionId = await createPooledExecution(tenant.workspaceId, tenant.ownerToken);
    executionIds.push(executionId);
    const dispatched = await apiCall(port(), `/api/executions/${executionId}/dispatch`, {
      token: tenant.ownerToken,
      body: {
        taskKind: 'data.transform',
        input: { records: [{ i: index }] },
        idempotencyKey: `conc-scale-${index}`,
      },
    });
    assert.equal(dispatched.status, 201);
  }

  // TWO drain workers racing on the same queue partition (SKIP LOCKED must
  // prevent double-claims; the pooled handler must be convergence-safe).
  const workers = await Promise.all([spawnWorker(st.env), spawnWorker(st.env)]);
  const codes = await Promise.all(workers.map((worker) => worker.exitCode()));
  assert.deepEqual(codes, [0, 0], 'both drain workers exit cleanly');

  const jobRows = await st.pg.pool.query<{ job_id: string; attempts: string; status: string }>(
    `SELECT job_id, attempts::text AS attempts, status
     FROM platform_jobs
     WHERE idempotency_key = ANY($1::text[])`,
    [executionIds.map((executionId) => `execution-dispatch:${executionId}:1`)],
  );
  assert.equal(jobRows.rows.length, 8, 'one job per dispatch');
  for (const job of jobRows.rows) {
    assert.equal(job.status, 'succeeded');
    assert.equal(job.attempts, '1', `job ${job.job_id} processed exactly once`);
  }

  for (const executionId of executionIds) {
    const final = await waitFor(
      `execution ${executionId} succeeded`,
      () => apiCall(port(), `/api/executions/${executionId}`, { token: tenant.ownerToken }),
      (r) => r.body['status'] === 'succeeded',
    );
    assert.equal(final.body['status'], 'succeeded');
    const history = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token: tenant.ownerToken,
    });
    const pairs = (history.body['transitions'] as ReadonlyArray<Record<string, unknown>>).map(
      (t) => `${t['fromStatus']}→${t['toStatus']}`,
    );
    assert.deepEqual(pairs, ['created→queued', 'queued→starting', 'starting→running', 'running→succeeded']);
  }
});
