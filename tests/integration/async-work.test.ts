/**
 * PLAT-AC-02 — integration test: "long-running work runs asynchronously".
 *
 * Proof (real PostgreSQL server + real OS subprocesses, no mocks):
 *   1. A long-running operation (≥1500ms of real CPU work) submitted over
 *      HTTP returns 202 + durable operation identifier in a small fraction of
 *      the work duration — the work does NOT run in the request path.
 *   2. A separate worker PROCESS claims the durable job, executes it and
 *      records the result; the operation status converges to 'succeeded'.
 *   3. The result references a real immutable artifact in the object store,
 *      verified by content digest.
 *   4. Durable idempotency: same key + payload converges to the same logical
 *      job; same key + different payload → 409 IDEMPOTENCY_CONFLICT.
 *   5. Retry semantics: a retryable failure re-runs the SAME job (attempt 2,
 *      append-oriented attempt history); a non-retryable typed failure marks
 *      the job dead without retrying.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnWorker,
  waitFor,
  type ApiCallResult,
  type IntegrationStack,
} from './helpers/harness.ts';

let stack: IntegrationStack | null = null;
let api: ({ port: number; child: ChildProcessWithoutNullStreams }) | null = null;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

before(async () => {
  stack = await bootStack('asyncwork');
  api = await spawnApi(stack.env);
});

after(async () => {
  // Failure-safe teardown: before() may have died partway (e.g. API spawn
  // failure) — always stop what actually started so the test process exits.
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('long-running operation returns 202 immediately and is completed by a separate worker process', async () => {
  const { stack } = the();
  const submittedAt = Date.now();
  const response = await submit({ durationMs: 1500 });
  const requestDurationMs = Date.now() - submittedAt;

  assert.equal(response.status, 202, 'long-running mutation must return 202 Accepted');
  assert.ok(response.headers['location'] !== undefined, 'must return a Location header');
  const operationId = response.body['operationId'] as string;
  assert.ok(typeof operationId === 'string' && operationId.length > 0, 'durable operation identifier required');
  assert.equal(response.body['status'], 'pending');

  // The submission must return well before the 1500ms of work completes:
  // long-running work runs asynchronously, not in the request path.
  assert.ok(
    requestDurationMs < 1000,
    `submission must not block on the work (took ${requestDurationMs}ms for 1500ms of work)`,
  );

  // While the work has not started, status is queryable and non-terminal.
  const early = await getOperation(operationId);
  assert.equal(early.status, 200);
  assert.equal(early.body['status'], 'pending');

  // A SEPARATE worker process executes the durable job and drains the queue.
  const worker = await spawnWorker(stack.env);
  assert.equal(await worker.exitCode(), 0, 'drain-mode worker must exit cleanly');

  const final = await waitFor(
    `operation ${operationId} to succeed`,
    () => getOperation(operationId),
    (r) => r.body['status'] === 'succeeded',
  );

  assert.equal(final.body['attempts'], 1);
  const resultPayload = final.body['result'] as Record<string, unknown>;
  assert.ok(typeof resultPayload === 'object' && resultPayload !== null);

  // The result references a REAL immutable artifact, verified by digest.
  const artifact = resultPayload['artifact'] as Record<string, unknown>;
  const key = artifact['key'] as string;
  assert.equal(key, artifact['digest'], 'artifact key is its content digest');
  const artifactPath = path.join(stack.env.objectStoreDir, key.slice(0, 2), key);
  const artifactBytes = fs.readFileSync(artifactPath);
  assert.equal(
    createHash('sha256').update(artifactBytes).digest('hex'),
    key,
    'stored artifact content must match its digest',
  );
  const artifactJson = JSON.parse(artifactBytes.toString('utf8')) as Record<string, unknown>;
  assert.equal(artifactJson['jobId'], operationId);
  assert.ok((artifactJson['hashes'] as number) > 0, 'handler performed real work');
});

test('idempotent submission: same key + payload converges; same key + different payload → 409', async () => {
  const { stack } = the();
  const first = await submit({ durationMs: 100 }, 'idem-key-001');
  assert.equal(first.status, 202);
  assert.equal(first.body['idempotentReplay'], false);
  const operationId = first.body['operationId'] as string;

  const replay = await submit({ durationMs: 100 }, 'idem-key-001');
  assert.equal(replay.status, 202);
  assert.equal(replay.body['operationId'], operationId, 'same logical operation identity');
  assert.equal(replay.body['idempotentReplay'], true);
  assert.equal(replay.headers['idempotency-replayed'], 'true');

  const conflict = await submit({ durationMs: 200 }, 'idem-key-001');
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body['error'] as Record<string, unknown>)['code'], 'IDEMPOTENCY_CONFLICT');

  // Drain the single logical job — duplicates must not create a second row.
  const worker = await spawnWorker(stack.env);
  await worker.exitCode();

  const rows = await stack.pg.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform_jobs WHERE idempotency_key = 'idem-key-001'`,
  );
  assert.equal(rows.rows[0]?.count, '1', 'duplicate submissions must not create a second logical job');
});

test('retryable failure re-runs the SAME job; non-retryable failure dies with the typed error', async () => {
  const { stack } = the();
  // Retryable path: attempt 1 fails by declaration, attempt 2 succeeds.
  const retry = await submit({ durationMs: 100, failFirstAttempts: 1 }, 'retry-key-001');
  const retryOperationId = retry.body['operationId'] as string;

  const worker = await spawnWorker(stack.env, { MOS_JOB_RETRY_BACKOFF_BASE_MS: '50' });
  await worker.exitCode();

  const final = await waitFor(
    `retry operation ${retryOperationId} to succeed`,
    () => getOperation(retryOperationId),
    (r) => r.body['status'] === 'succeeded',
  );
  assert.equal(final.body['attempts'], 2, 'exactly one retry, same logical job identity');

  const attempts = await stack.pg.pool.query<{ attempt_no: number; outcome: string }>(
    `SELECT attempt_no, outcome FROM platform_job_attempts WHERE job_id = $1 ORDER BY attempt_no`,
    [retryOperationId],
  );
  assert.deepEqual(
    attempts.rows.map((row) => [row.attempt_no, row.outcome]),
    [[1, 'failed'], [2, 'succeeded']],
    'durable append-oriented attempt history',
  );

  // Non-retryable path: invalid input (typed InvalidRequestError) must NOT retry.
  const dead = await submit({ durationMs: 0 }, 'dead-key-001');
  assert.equal(dead.status, 202);
  const deadOperationId = dead.body['operationId'] as string;

  const deadWorker = await spawnWorker(stack.env);
  await deadWorker.exitCode();

  const deadFinal = await waitFor(
    `operation ${deadOperationId} to reach a terminal state`,
    () => getOperation(deadOperationId),
    (r) => r.body['status'] === 'dead',
  );
  assert.equal(deadFinal.body['status'], 'dead');
  assert.equal(deadFinal.body['attempts'], 1, 'non-retryable failure must not be retried');
  const deadError = deadFinal.body['error'] as Record<string, unknown>;
  assert.equal(deadError['code'], 'INVALID_REQUEST');
  assert.equal(deadError['retryable'], false);
});

test('API contract guards: 401 without token, 422 on authority fields, 404 unknown operation, 405 wrong method', async () => {
  const { stack, api } = the();
  const unauthorized = await apiCall(api.port, '/api/platform/operations', {
    body: { handler: 'platform.sample.long-running-work', input: { durationMs: 10 } },
  });
  assert.equal(unauthorized.status, 401);

  const authorityInjection = await apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs: 10 },
      status: 'succeeded', // a caller cannot grant itself a terminal state
    },
  });
  assert.equal(authorityInjection.status, 422);
  const details = (authorityInjection.body['error'] as Record<string, unknown>)['details'] as ReadonlyArray<string>;
  assert.match(details.join('; '), /forbidden authority field/);

  const unknown = await apiCall(api.port, '/api/platform/operations/00000000-0000-7000-8000-000000000000', {
    token: stack.env.internalApiToken,
  });
  assert.equal(unknown.status, 404);

  const wrongMethod = await apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    method: 'DELETE',
  });
  assert.equal(wrongMethod.status, 405);
});

async function submit(
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<ApiCallResult> {
  const body: Record<string, unknown> = {
    handler: 'platform.sample.long-running-work',
    input,
  };
  if (idempotencyKey !== undefined) body['idempotencyKey'] = idempotencyKey;
  const { stack, api } = the();
  return apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    body,
  });
}

async function getOperation(operationId: string): Promise<ApiCallResult> {
  const { stack, api } = the();
  return apiCall(api.port, `/api/platform/operations/${operationId}`, {
    token: stack.env.internalApiToken,
  });
}
