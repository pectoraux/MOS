/**
 * MKT-011 CORRECTION regression (PR #20 blocking finding) — RECONCILIATION
 * OWNERSHIP ordering in the pooled handler, pinned at the handler level
 * with deterministic fakes (no timing, no I/O):
 *
 *   - the unknown/reconciling ownership guard PRECEDES the recorded-outcome
 *     replay: a stale/reclaimed delivery that still carries a recorded
 *     'succeeded' or 'unknown' verdict must be INERT against an execution
 *     reconciliation owns (no reconciling → succeeded | unknown — those
 *     edges are frozen reconciliation decisions, v1.2 §2; no outcome
 *     overwrite; the task is never re-run);
 *   - the same ownership is re-asserted after EVERY CAS re-read inside
 *     step(): a delivery that read a drivable status (e.g. running) and
 *     then loses the version race to reconciliation must STOP — not apply
 *     the now-machine-legal reconciliation edge the race exposed;
 *   - recorded-outcome crash recovery is PRESERVED for executions still in
 *     a pooled-drivable state (running): the verdict applies through the
 *     transition port without re-running the task.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPooledRunHandler } from '../../src/workers/pooled/pooled-handler.ts';
import { ConflictError } from '../../src/platform/errors/errors.ts';
import type {
  ExecutionRecord,
  ExecutionStatus,
  ExecutionsModuleApi,
} from '../../src/modules/executions/public.ts';
import type {
  ExecutionDispatchRecord,
  TaskRunner,
} from '../../src/workers/pooled/contract.ts';
import type { ExecutionDispatchesStore } from '../../src/workers/pooled/execution-dispatches-store.ts';
import type { Logger } from '../../src/platform/observability/contract.ts';
import type { JobRecord } from '../../src/platform/queue/contract.ts';

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  log() {},
};

function executionRecord(status: ExecutionStatus, version: number): ExecutionRecord {
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
    status,
    retryClassification: null,
    createdBy: null,
    version,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

function dispatchRecord(overrides: Partial<ExecutionDispatchRecord> = {}): ExecutionDispatchRecord {
  return {
    dispatchId: 'disp-1',
    executionId: 'exec-1',
    taskKind: 'data.transform',
    input: { records: [{ v: 1 }] },
    inputRef: null,
    queueName: 'executions.pooled',
    handlerKind: 'executions.pooled.run',
    maxAttempts: 5,
    dispatchStatus: 'submitted',
    jobId: 'job-1',
    cycle: 1,
    outcome: null,
    outputRef: null,
    output: null,
    outcomeReason: '',
    idempotencyKey: 'dispatch-key',
    createFingerprint: 'b'.repeat(64),
    correlationId: 'corr-1',
    causationId: null,
    createdBy: null,
    version: 2,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function jobContext(attempts = 1): { job: JobRecord; logger: Logger } {
  return {
    job: {
      jobId: 'job-1',
      queue: 'executions.pooled',
      handlerKind: 'executions.pooled.run',
      payload: { dispatchId: 'disp-1', executionId: 'exec-1', cycle: 1 },
      idempotencyKey: 'execution-dispatch:exec-1:1',
      status: 'running',
      attempts,
      maxAttempts: 5,
      runAfter: new Date(),
      claimedBy: 'worker-1',
      claimedAt: new Date(),
      correlationId: 'corr-1',
      causationId: null,
      submittedBy: 'relay',
      result: null,
      error: null,
      version: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    logger: silentLogger,
  };
}

interface RecordedTransition {
  readonly to: ExecutionStatus;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

/**
 * Fake executions module: records every attempted transition. Optionally
 * simulates the version race the blocking finding described — the FIRST
 * transition attempt loses the CAS conflict because a concurrent driver
 * (reconciliation) moved the execution, after which reads observe the
 * racing state.
 */
function fakeExecutions(initial: ExecutionRecord, conflictThen?: ExecutionRecord) {
  let current = initial;
  const transitions: RecordedTransition[] = [];
  const api = {
    getExecution: async (): Promise<ExecutionRecord> => current,
    transitionExecution: async (input: {
      readonly to: ExecutionStatus;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
    }) => {
      transitions.push({ to: input.to, expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey });
      if (conflictThen !== undefined && transitions.length === 1) {
        current = conflictThen;
        throw new ConflictError('version race: reconciliation moved the execution');
      }
      current = { ...current, status: input.to, version: current.version + 1 };
      return { execution: current, transition: null, replayed: false };
    },
  };
  return {
    api: api as unknown as ExecutionsModuleApi,
    transitions,
    read: (): ExecutionRecord => current,
  };
}

/** Fake dispatch store: records outcome writes (there must be none while reconciliation owns). */
function fakeStore(dispatch: ExecutionDispatchRecord) {
  let current = dispatch;
  const outcomeWrites: string[] = [];
  const store = {
    getByDispatchId: async (): Promise<ExecutionDispatchRecord> => current,
    recordOutcome: async (
      _dispatchId: string,
      _expectedVersion: number,
      verdict: string,
    ): Promise<ExecutionDispatchRecord> => {
      outcomeWrites.push(verdict);
      current = { ...current, outcome: verdict as ExecutionDispatchRecord['outcome'] };
      return current;
    },
  };
  return { store: store as unknown as ExecutionDispatchesStore, outcomeWrites };
}

/** A runner whose invocation is itself a failure (none of these paths may run the task). */
function forbiddingRunner(): { runner: TaskRunner; calls: () => number } {
  let calls = 0;
  return {
    runner: async () => {
      calls += 1;
      throw new Error('the task runner must never be invoked on these paths');
    },
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// The blocking finding, pinned: ownership guard BEFORE recorded-outcome replay
// ---------------------------------------------------------------------------

test('ownership: a recorded unknown verdict on stale work is INERT while the execution is RECONCILING', async () => {
  const fx = fakeExecutions(executionRecord('reconciling', 9));
  const fs = fakeStore(dispatchRecord({ outcome: 'unknown' }));
  const runner = forbiddingRunner();
  const handler = createPooledRunHandler({
    executions: fx.api,
    store: fs.store,
    runners: new Map([['data.transform', runner.runner]]),
    logger: silentLogger,
  });

  const result = (await handler(jobContext())) as Record<string, unknown>;

  assert.equal(result['verdict'], 'converged', 'the delivery converges inert');
  assert.equal(result['executionStatus'], 'reconciling');
  assert.equal(fx.transitions.length, 0, 'NO transition attempted from reconciling (no synthesized reconciling→unknown)');
  assert.equal(fs.outcomeWrites.length, 0, 'the recorded verdict evidence is not rewritten');
  assert.equal(runner.calls(), 0, 'the task is never re-run');
});

test('ownership: a recorded succeeded verdict on stale work is INERT while the execution is RECONCILING', async () => {
  const fx = fakeExecutions(executionRecord('reconciling', 9));
  const fs = fakeStore(dispatchRecord({ outcome: 'succeeded', outputRef: 'c'.repeat(64) }));
  const runner = forbiddingRunner();
  const handler = createPooledRunHandler({
    executions: fx.api,
    store: fs.store,
    runners: new Map([['data.transform', runner.runner]]),
    logger: silentLogger,
  });

  const result = (await handler(jobContext())) as Record<string, unknown>;

  assert.equal(result['verdict'], 'converged', 'the delivery converges inert');
  assert.equal(result['executionStatus'], 'reconciling');
  assert.equal(fx.transitions.length, 0, 'NO transition attempted from reconciling (no synthesized reconciling→succeeded)');
  assert.equal(fs.outcomeWrites.length, 0);
  assert.equal(runner.calls(), 0);
});

test('ownership: a recorded outcome on stale work is INERT while the execution is UNKNOWN (awaiting reconciliation)', async () => {
  const fx = fakeExecutions(executionRecord('unknown', 8));
  const fs = fakeStore(dispatchRecord({ outcome: 'unknown' }));
  const runner = forbiddingRunner();
  const handler = createPooledRunHandler({
    executions: fx.api,
    store: fs.store,
    runners: new Map([['data.transform', runner.runner]]),
    logger: silentLogger,
  });

  const result = (await handler(jobContext())) as Record<string, unknown>;

  assert.equal(result['verdict'], 'converged');
  assert.equal(result['executionStatus'], 'unknown');
  assert.equal(fx.transitions.length, 0, 'NO transition attempted from unknown (unknown→reconciling is reconciliation\'s to drive)');
  assert.equal(fs.outcomeWrites.length, 0);
  assert.equal(runner.calls(), 0);
});

// ---------------------------------------------------------------------------
// The version-race variant, pinned: ownership re-asserted after CAS re-reads
// ---------------------------------------------------------------------------

test('ownership: a delivery that loses the version race to reconciliation STOPS instead of applying the exposed reconciliation edge', async () => {
  // The handler reads the execution as running (guard passes), then its
  // first transition attempt CAS-conflicts because reconciliation moved the
  // execution to reconciling. The re-read inside step() must observe
  // ownership and return — never apply the now-machine-legal
  // reconciling → succeeded edge.
  const fx = fakeExecutions(
    executionRecord('running', 5),
    executionRecord('reconciling', 6),
  );
  const fs = fakeStore(dispatchRecord({ outcome: 'succeeded', outputRef: 'd'.repeat(64) }));
  const runner = forbiddingRunner();
  const handler = createPooledRunHandler({
    executions: fx.api,
    store: fs.store,
    runners: new Map([['data.transform', runner.runner]]),
    logger: silentLogger,
  });

  const result = (await handler(jobContext())) as Record<string, unknown>;

  assert.equal(fx.transitions.length, 1, 'exactly ONE transition attempt — the CAS-conflicted one, never a retry FROM reconciling');
  assert.equal(fx.transitions[0]!.to, 'succeeded');
  assert.equal(fx.transitions[0]!.expectedVersion, 5, 'the attempt was against the running record it had read');
  assert.equal(fx.read().status, 'reconciling', 'the fake execution was never moved by the pooled path');
  assert.equal(result['executionStatus'], 'reconciling', 'the handler reports the reconciliation-owned state it converged to');
  assert.equal(runner.calls(), 0, 'the task is never re-run');
});

// ---------------------------------------------------------------------------
// The preserved behavior, pinned: recorded-outcome crash recovery on
// pooled-drivable executions (no over-reach)
// ---------------------------------------------------------------------------

test('preserved: a recorded succeeded verdict on a RUNNING execution applies running→succeeded WITHOUT re-running the task', async () => {
  const fx = fakeExecutions(executionRecord('running', 5));
  const fs = fakeStore(dispatchRecord({ outcome: 'succeeded', outputRef: 'e'.repeat(64) }));
  const runner = forbiddingRunner();
  const handler = createPooledRunHandler({
    executions: fx.api,
    store: fs.store,
    runners: new Map([['data.transform', runner.runner]]),
    logger: silentLogger,
  });

  const result = (await handler(jobContext())) as Record<string, unknown>;

  assert.equal(result['verdict'], 'succeeded');
  assert.equal(result['executionStatus'], 'succeeded');
  assert.equal(result['outputRef'], 'e'.repeat(64), 'the recorded artifact evidence is carried through');
  assert.deepEqual(
    fx.transitions.map((t) => [t.to, t.expectedVersion, t.idempotencyKey]),
    [['succeeded', 5, 'pooled:disp-1:1:succeeded']],
    'exactly one transition through the port, per-cycle idempotency-keyed',
  );
  assert.equal(runner.calls(), 0, 'the task is NEVER re-run in the crash window');
});

test('preserved: a recorded unknown verdict on a RUNNING execution applies running→unknown WITHOUT re-running the task', async () => {
  const fx = fakeExecutions(executionRecord('running', 5));
  const fs = fakeStore(dispatchRecord({ outcome: 'unknown' }));
  const runner = forbiddingRunner();
  const handler = createPooledRunHandler({
    executions: fx.api,
    store: fs.store,
    runners: new Map([['data.transform', runner.runner]]),
    logger: silentLogger,
  });

  const result = (await handler(jobContext())) as Record<string, unknown>;

  assert.equal(result['verdict'], 'unknown');
  assert.equal(result['executionStatus'], 'unknown');
  assert.deepEqual(
    fx.transitions.map((t) => [t.to, t.idempotencyKey]),
    [['unknown', 'pooled:disp-1:1:unknown']],
  );
  assert.equal(runner.calls(), 0);
});
