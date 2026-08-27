/**
 * MKT-005 integration test — PostgreSQL remains the durable queue authority
 * regardless of Redis state (issue #13 MKT-005-AC-02).
 *
 * Proves with real infrastructure (embedded PostgreSQL + compiled
 * redis-server + real API/worker subprocesses):
 *
 *   - with Redis CONFIGURED and RUNNING, async work flows through the
 *     PostgreSQL queue and completes, and RETRY recovery (transient failure
 *     → exponential backoff → completion) works — all through PostgreSQL;
 *   - a worker killed mid-execution leaves the job DURABLY visible in its
 *     last real state ('running', claimed, attempts recorded — never a
 *     fabricated success and never silent loss), and the queue keeps
 *     accepting and processing NEW work;
 *   - with Redis DOWN mid-run, API mutations (PostgreSQL + audit) still
 *     work, job submission still works and a fresh worker still drains the
 *     queue — Redis holds no queue/workflow state, so its outage can never
 *     become an alternate source of truth;
 *   - with NO Redis configured at all (degenerate adapters), the same full
 *     async flow works.
 *
 * Honest limitation (recorded in docs/implementation/MKT-005.md): the frozen
 * MKT-001 queue contract has no lease/visibility timeout, so a job whose
 * worker died mid-`running` stays durably 'running' until an operator or a
 * future platform Work Item adds claim recovery. MKT-005 proves such a job
 * is never silently acknowledged or lost — exactly the no-false-success
 * posture the recovery contract requires.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnWorker,
  waitFor,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { startRedisServer, type RedisServerHandle } from './helpers/redis.ts';

interface Stack {
  readonly integration: IntegrationStack;
  api: (SpawnedProcess & { port: number }) | null;
  redis: RedisServerHandle | null;
}

let stack: Stack | null = null;

const BOOTSTRAP_ENV = {
  MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: 'root@marketingos.test',
  MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: 'bootstrap-root-pass',
} as const;

async function boot(label: string, withRedis: boolean): Promise<Stack> {
  const integration = await bootStack(label);
  const redis = withRedis ? await startRedisServer() : null;
  const st: Stack = { integration, api: null, redis };
  st.api = await spawnApi(integration.env, { ...BOOTSTRAP_ENV, ...redisEnv(st) });
  return st;
}

function redisEnv(st: Stack): Record<string, string> {
  return st.redis === null
    ? {}
    : { MOS_REDIS_URL: `redis://127.0.0.1:${st.redis.port}`, MOS_REDIS_TIMEOUT_MS: '800' };
}

async function shutdown(st: Stack): Promise<void> {
  if (st.api !== null) {
    st.api.child.kill('SIGTERM');
    await st.api.exitCode();
  }
  if (st.redis !== null) await st.redis.stop();
  await shutdownStack(st.integration);
}

async function submitWork(
  st: Stack,
  idempotencyKey: string,
  input: { durationMs: number; failFirstAttempts?: number },
): Promise<string> {
  const submitted = await apiCall(st.api!.port, '/api/platform/operations', {
    token: 'integration-test-token',
    body: {
      handler: 'platform.sample.long-running-work',
      input,
      idempotencyKey,
    },
  });
  assert.equal(submitted.status, 202, `submission must be accepted (got ${submitted.status})`);
  return submitted.body['operationId'] as string;
}

async function waitForStatus(st: Stack, operationId: string, want: string | readonly string[]): Promise<Record<string, unknown>> {
  const wanted = Array.isArray(want) ? want : [want];
  return waitFor(`operation ${operationId} to reach ${wanted.join('|')}`, async () => {
    const status = await apiCall(st.api!.port, `/api/platform/operations/${operationId}`, {
      token: 'integration-test-token',
    });
    return status.body;
  }, (body) => wanted.includes(body['status'] as string), 60_000);
}

before(async () => {
  stack = await boot('queueauth', true);
});

after(async () => {
  if (stack !== null) await shutdown(stack);
});

test('AC-02: async work + RETRY recovery flow through the PostgreSQL queue with Redis configured and running', async () => {
  const st = stack!;
  // failFirstAttempts: 1 → the first attempt fails (retryable), the job is
  // rescheduled by the PostgreSQL queue with backoff and completes on retry.
  const operationId = await submitWork(st, 'queue-auth-retry-001', { durationMs: 60, failFirstAttempts: 1 });

  const worker = await spawnWorker(st.integration.env, redisEnv(st));
  const exit = await worker.exitCode();
  assert.equal(exit, 0);
  const final = await waitForStatus(st, operationId, 'succeeded');
  assert.ok((final['attempts'] as number) >= 2, 'the retry path ran through the durable queue');
});

test('AC-02: a worker killed mid-execution leaves the job durably visible (no fabricated success, no silent loss) and the queue keeps working', async () => {
  const st = stack!;
  // durationMs 8000 keeps the job running long enough to kill the worker.
  const operationId = await submitWork(st, 'queue-auth-crash-001', { durationMs: 8_000 });

  const worker = await spawnWorker(st.integration.env, redisEnv(st));
  await waitForStatus(st, operationId, 'running');

  // Kill the worker MID-EXECUTION (SIGKILL: no completion path can run).
  worker.child.kill('SIGKILL');
  await worker.exitCode();

  // The job is durably visible in 'running' with its attempt recorded —
  // never acknowledged as succeeded (no false success) and never lost.
  const stuck = await waitForStatus(st, operationId, 'running');
  assert.equal(stuck['claimedBy'] !== null, true, 'the dead worker holds a durable claim');
  assert.ok((stuck['attempts'] as number) >= 1, 'the attempt is recorded');

  // The queue itself is unharmed: NEW work is accepted and completed by a
  // fresh worker while the crashed job remains durably inspectable.
  const followUpId = await submitWork(st, 'queue-auth-crash-002', { durationMs: 40 });
  const fresh = await spawnWorker(st.integration.env, redisEnv(st));
  const exit = await fresh.exitCode();
  assert.equal(exit, 0);
  await waitForStatus(st, followUpId, 'succeeded');
});

test('AC-02: with Redis DOWN mid-run, PostgreSQL still accepts mutations, submissions and drains the queue', async () => {
  const st = stack!;
  // Stop Redis abruptly — no graceful drain, no state transfer.
  await st.redis!.stop();
  st.redis = null;

  // API mutations still work (PostgreSQL system of record + audit authority).
  const login = await apiCall(st.api!.port, '/api/auth/login', {
    body: { email: BOOTSTRAP_ENV.MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL, password: BOOTSTRAP_ENV.MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD },
  });
  assert.equal(login.status, 200, 'login (PostgreSQL-backed) works with Redis down');

  // A login emits a durable audit event — PostgreSQL authority unaffected.
  const agency = await apiCall(st.api!.port, '/api/agencies', {
    token: login.body['token'] as string,
    body: { name: 'Queue Authority Agency', ownerUserEmail: BOOTSTRAP_ENV.MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL },
  });
  assert.equal(agency.status, 201, 'material mutations (with audit writes) work with Redis down');

  // Job submission still works: the DURABLE queue is PostgreSQL. Include a
  // retry so recovery-through-PostgreSQL is exercised with Redis down too.
  const operationId = await submitWork(st, 'queue-auth-redis-down-001', { durationMs: 40, failFirstAttempts: 1 });

  // A worker started while Redis is DOWN still drains the queue (Redis is
  // wired for advisory cache/locks only — the worker host never needs it).
  const worker = await spawnWorker(st.integration.env, {});
  const exit = await worker.exitCode();
  assert.equal(exit, 0, 'worker drains the PostgreSQL queue with Redis down');
  const final = await waitForStatus(st, operationId, 'succeeded');
  assert.ok((final['attempts'] as number) >= 2, 'retry recovery ran on PostgreSQL alone');
});

test('AC-02: with NO Redis configured at all (degenerate adapters), the async flow is unchanged', async () => {
  const st = stack!;
  const operationId = await submitWork(st, 'queue-auth-no-redis-001', { durationMs: 40 });
  const worker = await spawnWorker(st.integration.env, {});
  const exit = await worker.exitCode();
  assert.equal(exit, 0);
  await waitForStatus(st, operationId, 'succeeded');
});
