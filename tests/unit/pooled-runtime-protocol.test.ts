/**
 * MKT-011 unit tests — the pure pooled-protocol logic:
 *   - the §8 TASK key derivation (stable across RETRY ATTEMPTS of the same
 *     logical task — the EXEC-AC-03 convergence precondition);
 *   - the dispatch command fingerprint (convergence predicate);
 *   - the §24 classification mapping from recorded job errors (fail-closed);
 *   - the task-kind envelope pattern;
 *   - runner input validation (data.transform determinism inputs,
 *     api.request fail-closed envelope);
 *   - the HttpCallPort request envelope guard (https-or-loopback, bounds).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveTaskKey,
  pooledTaskKindProblem,
  buildPooledTaskRunners,
  POOLED_TASK_KINDS,
} from '../../src/workers/pooled/contract.ts';
import { fingerprintDispatchCommand } from '../../src/workers/pooled/execution-dispatches-store.ts';
import { classificationFromJobError } from '../../src/workers/pooled/pooled-runtime.ts';
import { httpCallRequestProblem } from '../../src/platform/http/outbound.ts';
import {
  PermanentExecutionFailureError,
  ProviderUnavailableError,
} from '../../src/platform/errors/errors.ts';
import type { ExecutionRecord } from '../../src/modules/executions/public.ts';
import type { JobErrorRecord } from '../../src/platform/queue/contract.ts';
import type { HttpCallRequest } from '../../src/platform/http/outbound.ts';

function executionWithLinkage(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: 'exec-1',
    taskLink: { kind: 'workflow-node', workflowInstanceId: 'wfi-1', nodeId: 'node-a' },
    retryOfExecutionId: null,
    attemptNumber: 1,
    executionKind: 'deterministic',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'create-key',
    createFingerprint: 'a'.repeat(64),
    workspaceId: 'ws-1',
    clientId: 'cl-1',
    agencyId: 'ag-1',
    status: 'running',
    retryClassification: null,
    createdBy: null,
    version: 4,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('the §8 task key derives from the LOGICAL TASK, not the execution row identity', () => {
  const dispatch = { input: { records: [{ a: 1 }] }, inputRef: null };
  const attempt1 = executionWithLinkage({ executionId: 'exec-attempt-1', attemptNumber: 1 });
  const attempt2 = executionWithLinkage({
    executionId: 'exec-attempt-2',
    attemptNumber: 2,
    retryOfExecutionId: 'exec-attempt-1',
  });

  const key1 = deriveTaskKey(attempt1, dispatch);
  const key2 = deriveTaskKey(attempt2, dispatch);
  assert.equal(key1, key2, 'retry attempts of the same logical task derive the SAME §8 task key');

  // A different linkage or a different input is a DIFFERENT logical task.
  const otherNode = deriveTaskKey(
    executionWithLinkage({ taskLink: { kind: 'workflow-node', workflowInstanceId: 'wfi-1', nodeId: 'node-b' } }),
    dispatch,
  );
  assert.notEqual(key1, otherNode);
  const otherInput = deriveTaskKey(attempt1, {
    input: { records: [{ a: 2 }] },
    inputRef: null,
  });
  assert.notEqual(key1, otherInput);
  const externalLink = deriveTaskKey(
    executionWithLinkage({ taskLink: { kind: 'external-request', externalRequestRef: 'ext-1' } }),
    dispatch,
  );
  assert.match(externalLink, /^pooled-task:ext:ext-1:/);
  assert.match(key1, /^pooled-task:wf:wfi-1:node-a:/);
});

test('the dispatch command fingerprint is canonical (key order does not matter)', () => {
  const a = fingerprintDispatchCommand({
    taskKind: 'data.transform',
    input: { x: 1, y: { b: 2, a: 1 } },
    inputRef: null,
    maxAttempts: 5,
  });
  const b = fingerprintDispatchCommand({
    taskKind: 'data.transform',
    input: { y: { a: 1, b: 2 }, x: 1 },
    inputRef: null,
    maxAttempts: 5,
  });
  assert.equal(a, b, 'same logical command converges regardless of key order');
  const c = fingerprintDispatchCommand({
    taskKind: 'data.transform',
    input: { x: 1, y: { b: 2, a: 1 } },
    inputRef: null,
    maxAttempts: 3,
  });
  assert.notEqual(a, c, 'a different attempt policy is a different command');
});

test('§24 classification from recorded job errors is fail-closed', () => {
  const retrySafeTrue: JobErrorRecord = {
    code: 'PROVIDER_UNAVAILABLE',
    message: 'transient',
    retryable: true,
    retrySafe: true,
    attempt: 1,
    workerId: 'w',
    at: '2025-01-01T00:00:00.000Z',
  };
  const retrySafeNull: JobErrorRecord = { ...retrySafeTrue, retrySafe: null, code: 'TIMEOUT' };
  const retrySafeFalse: JobErrorRecord = {
    ...retrySafeTrue,
    retrySafe: false,
    code: 'PERMANENT_EXECUTION_FAILURE',
    retryable: false,
  };
  assert.equal(classificationFromJobError(retrySafeTrue), 'safe');
  assert.equal(classificationFromJobError(retrySafeNull), 'unsafe', 'unknown safety fails closed');
  assert.equal(classificationFromJobError(retrySafeFalse), 'unsafe');
  assert.equal(classificationFromJobError(null), 'unsafe', 'no recorded error fails closed');
});

test('the task-kind envelope pattern accepts the registered kinds and rejects malformed ones', () => {
  for (const kind of POOLED_TASK_KINDS) {
    assert.equal(pooledTaskKindProblem(kind), null);
  }
  assert.ok(pooledTaskKindProblem('no-dot') !== null);
  assert.ok(pooledTaskKindProblem('Data.Transform') !== null);
  assert.ok(pooledTaskKindProblem('a'.repeat(101)) !== null);
});

test('data.transform validation rejects malformed input permanently', async () => {
  const runners = buildPooledTaskRunners({
    objects: null as never,
    clock: null as never,
    http: null as never,
  });
  const runner = runners.get('data.transform')!;
  const ctx = {
    execution: executionWithLinkage(),
    dispatch: { input: {}, inputRef: null } as never,
    input: {},
    taskKey: 't',
    attempt: 1,
    logger: null as never,
  };
  await assert.rejects(runner(ctx), PermanentExecutionFailureError, 'records required');
  await assert.rejects(
    runner({ ...ctx, input: { records: 'nope' } }),
    PermanentExecutionFailureError,
  );
  await assert.rejects(
    runner({ ...ctx, input: { records: [{ a: 1 }], failFirstAttempts: -1 } }),
    PermanentExecutionFailureError,
  );
});

test('data.transform fails first attempts as retryable-PROVEN-SAFE, then converges deterministically', async () => {
  const puts: string[] = [];
  const runners = buildPooledTaskRunners({
    objects: {
      put: async (bytes: Uint8Array) => {
        const key = `k${puts.length}`;
        puts.push(new TextDecoder().decode(bytes));
        return { key, digest: key, size: bytes.byteLength };
      },
    } as never,
    clock: null as never,
    http: null as never,
  });
  const runner = runners.get('data.transform')!;
  const input = { records: [{ a: 2, b: 'x' }, { a: 1, b: 'y' }], sortBy: 'a', failFirstAttempts: 1 };
  const ctx = {
    execution: executionWithLinkage(),
    dispatch: { input, inputRef: null } as never,
    input,
    taskKey: 'task-key-1',
    attempt: 1,
    logger: null as never,
  };
  await assert.rejects(runner(ctx), ProviderUnavailableError);

  const result = await runner({ ...ctx, attempt: 2 });
  assert.equal(result.outputRef, 'k0');
  const artifact = JSON.parse(puts[0]!);
  assert.equal(artifact.taskKey, 'task-key-1');
  assert.deepEqual(artifact.rows, [{ a: 1, b: 'y' }, { a: 2, b: 'x' }], 'sorted by the declared field');
  // Identical rerun → identical artifact content (content-addressed convergence).
  const rerun = await runner({ ...ctx, attempt: 3, input: { ...input, failFirstAttempts: 0 } });
  assert.equal(puts[1], puts[0], 'pure runner: identical output bytes');
  assert.ok(rerun.outputRef.length > 0);
});

test('api.request validation rejects the runtime-owned header and malformed envelopes', async () => {
  const runners = buildPooledTaskRunners({
    objects: null as never,
    clock: null as never,
    http: null as never,
  });
  const runner = runners.get('api.request')!;
  const ctx = {
    execution: executionWithLinkage(),
    dispatch: { input: {}, inputRef: null } as never,
    input: {},
    taskKey: 't',
    attempt: 1,
    logger: null as never,
  };
  await assert.rejects(runner(ctx), PermanentExecutionFailureError, 'url required');
  await assert.rejects(
    runner({
      ...ctx,
      input: { url: 'https://example.test', headers: { 'Idempotency-Key': 'x' } },
    }),
    PermanentExecutionFailureError,
    'the idempotency-key header is runtime-owned',
  );
  await assert.rejects(
    runner({ ...ctx, input: { url: 'https://example.test', timeoutMs: 0 } }),
    PermanentExecutionFailureError,
  );
});

test('the HttpCallPort envelope guard: https-or-loopback, bounded caps, bodyless methods', () => {
  const base: HttpCallRequest = {
    url: 'https://example.test/x',
    method: 'GET',
    headers: {},
    body: null,
    timeoutMs: 1000,
    sizeCapBytes: 1024,
  };
  assert.equal(httpCallRequestProblem(base), null);
  assert.match(httpCallRequestProblem({ ...base, url: 'http://example.test/x' })!, /https/);
  assert.equal(
    httpCallRequestProblem({ ...base, url: 'http://127.0.0.1:9/x' }),
    null,
    'loopback http is permitted (test/internal endpoints)',
  );
  assert.match(httpCallRequestProblem({ ...base, url: 'not-a-url' })!, /valid absolute URL/);
  assert.match(httpCallRequestProblem({ ...base, timeoutMs: 0 })!, /timeoutMs/);
  assert.match(httpCallRequestProblem({ ...base, sizeCapBytes: 0 })!, /sizeCapBytes/);
  assert.match(httpCallRequestProblem({ ...base, body: 'x' })!, /must not carry a body/);
});
