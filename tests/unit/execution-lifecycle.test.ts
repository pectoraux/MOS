/**
 * MKT-010 unit tests — the frozen EXECUTION state machine and the
 * normalized-model tables (pure functions and tables, no DB).
 *
 * Proofs (implementation-contract §7 "Execution contract", §8 "Execution
 * idempotency", §9 "Runtime contract", §24 "Error/recovery contract";
 * state-machines.md "Execution" as superseded for Execution/Sandbox
 * semantics by state-machines-v1.2.md; work-items.md MKT-010; EXEC-AC-01..03):
 *   1. EXECUTION_STATUSES is EXACTLY the eleven canonical states;
 *   2. EXECUTION_TRANSITIONS is EXACTLY the frozen machine — the fourteen
 *      legal edges (created→queued; queued→starting; starting→running;
 *      running→{pausing, succeeded, failed, cancelled, unknown};
 *      pausing→paused; paused→running; unknown→reconciling;
 *      reconciling→{succeeded, failed, unknown}), no self-loops, no
 *      skip-edges, and NO outgoing transitions from the three terminal
 *      states;
 *   3. isLegalExecutionTransition is exhaustive over the full 11×11 from ×
 *      to matrix — every cell not in the machine is illegal (created→running
 *      skip, queued→running skip, running→created back-edge,
 *      paused→cancelled — cancellation is reachable ONLY from running —
 *      paused→succeeded, unknown→succeeded — UNKNOWN never resolves to
 *      success without reconciliation — every terminal→*, every self-loop);
 *   4. isTerminalExecutionStatus is true exactly for succeeded/failed/
 *      cancelled — and FALSE for unknown and reconciling (the v1.2
 *      correction: "UNKNOWN is non-terminal until reconciled");
 *   5. the EXECUTION machine and the WORKFLOW INSTANCE machine are
 *      distinct authorities: instance-only states (draft/ready/blocked)
 *      are never execution states, and execution-only states (created/
 *      queued/starting/pausing/unknown/reconciling) are never instance
 *      states — the execution machine carries the runtime attempt
 *      lifecycle, the instance machine the workflow lifecycle intent;
 *   6. the normalized-model tables: the four execution kinds, the four
 *      frozen runtime classes, the three sandbox classes (pooled-worker
 *      holds no sandbox) and the two retry classifications.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_KINDS,
  EXECUTION_STATUSES,
  EXECUTION_TERMINAL_STATUSES,
  EXECUTION_TRANSITIONS,
  RETRY_CLASSIFICATIONS,
  RUNTIME_CLASSES,
  SANDBOX_RUNTIME_CLASSES,
  isLegalExecutionTransition,
  isTerminalExecutionStatus,
  composeExecutionOwnerContext,
  type ExecutionStatus,
} from '../../src/modules/executions/public.ts';
import {
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_INSTANCE_TRANSITIONS,
} from '../../src/modules/workflows/public.ts';

const STATUSES: readonly ExecutionStatus[] = [
  'created',
  'queued',
  'starting',
  'running',
  'pausing',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  'reconciling',
];

test('EXECUTION_STATUSES is exactly the eleven canonical states', () => {
  assert.deepEqual([...EXECUTION_STATUSES], STATUSES);
});

test('EXECUTION_TRANSITIONS is exactly the frozen execution machine (state-machines-v1.2)', () => {
  assert.deepEqual([...Object.keys(EXECUTION_TRANSITIONS)].sort(), [
    'cancelled',
    'created',
    'failed',
    'paused',
    'pausing',
    'queued',
    'reconciling',
    'running',
    'starting',
    'succeeded',
    'unknown',
  ]);
  // The fourteen frozen edges.
  assert.deepEqual(EXECUTION_TRANSITIONS.created, ['queued']);
  assert.deepEqual(EXECUTION_TRANSITIONS.queued, ['starting']);
  assert.deepEqual(EXECUTION_TRANSITIONS.starting, ['running']);
  assert.deepEqual(EXECUTION_TRANSITIONS.running, [
    'pausing',
    'succeeded',
    'failed',
    'cancelled',
    'unknown',
  ]);
  assert.deepEqual(EXECUTION_TRANSITIONS.pausing, ['paused']);
  assert.deepEqual(EXECUTION_TRANSITIONS.paused, ['running']);
  assert.deepEqual(EXECUTION_TRANSITIONS.succeeded, []);
  assert.deepEqual(EXECUTION_TRANSITIONS.failed, []);
  assert.deepEqual(EXECUTION_TRANSITIONS.cancelled, []);
  // The v1.2 reconciliation pair: UNKNOWN resolves only through
  // RECONCILING, which may legitimately conclude back in UNKNOWN.
  assert.deepEqual(EXECUTION_TRANSITIONS.unknown, ['reconciling']);
  assert.deepEqual(EXECUTION_TRANSITIONS.reconciling, ['succeeded', 'failed', 'unknown']);
});

test('isLegalExecutionTransition is exhaustive: every non-frozen cell is illegal', () => {
  const legal = new Set<string>();
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = EXECUTION_TRANSITIONS[from].includes(to);
      assert.equal(
        isLegalExecutionTransition(from, to),
        expected,
        `(${from} → ${to}) legality must match the table`,
      );
      if (expected) legal.add(`${from}→${to}`);
    }
  }
  // The exhaustive legal set — exactly the fourteen frozen edges.
  assert.deepEqual([...legal].sort(), [
    'created→queued',
    'paused→running',
    'pausing→paused',
    'queued→starting',
    'reconciling→failed',
    'reconciling→succeeded',
    'reconciling→unknown',
    'running→cancelled',
    'running→failed',
    'running→pausing',
    'running→succeeded',
    'running→unknown',
    'starting→running',
    'unknown→reconciling',
  ]);
  // Adversarial spot checks (the audit's adversarial angles):
  // Cancellation is reachable ONLY from running.
  for (const from of STATUSES) {
    assert.equal(
      isLegalExecutionTransition(from, 'cancelled'),
      from === 'running',
      `cancelled must be reachable only from running (not ${from})`,
    );
  }
  // UNKNOWN is reachable ONLY from running and reconciling — never from
  // paused/created/queued (outcome visibility is lost while RUNNING).
  for (const from of STATUSES) {
    assert.equal(
      isLegalExecutionTransition(from, 'unknown'),
      from === 'running' || from === 'reconciling',
      `unknown must be reachable only from running/reconciling (not ${from})`,
    );
  }
  // Nothing transitions INTO created (born there) and nothing resumes by
  // skipping the pipeline (created→running, queued→running are illegal).
  assert.ok(!isLegalExecutionTransition('created', 'running'));
  assert.ok(!isLegalExecutionTransition('queued', 'running'));
  assert.ok(!isLegalExecutionTransition('created', 'starting'));
  // UNKNOWN never resolves to success without reconciliation.
  assert.ok(!isLegalExecutionTransition('unknown', 'succeeded'));
  assert.ok(!isLegalExecutionTransition('unknown', 'failed'));
  assert.ok(!isLegalExecutionTransition('unknown', 'running'));
  // PAUSED only ever resumes.
  assert.ok(!isLegalExecutionTransition('paused', 'succeeded'));
  assert.ok(!isLegalExecutionTransition('paused', 'cancelled'));
  assert.ok(!isLegalExecutionTransition('paused', 'unknown'));
  // No self-loops anywhere.
  for (const status of STATUSES) {
    assert.ok(!isLegalExecutionTransition(status, status), `self-loop ${status} is illegal`);
  }
});

test('isTerminalExecutionStatus is true exactly for the three terminal states — UNKNOWN is NOT terminal (v1.2)', () => {
  for (const status of STATUSES) {
    const expected = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    assert.equal(isTerminalExecutionStatus(status), expected, `${status} terminality`);
  }
  assert.deepEqual([...EXECUTION_TERMINAL_STATUSES], ['succeeded', 'failed', 'cancelled']);
  // The v1.2 correction, verbatim: "UNKNOWN is non-terminal until
  // reconciled or explicitly closed by an authorized policy-defined
  // terminalization path."
  assert.ok(!isTerminalExecutionStatus('unknown'));
  assert.ok(EXECUTION_TRANSITIONS.unknown.length > 0, 'unknown has an outgoing reconciliation path');
  assert.ok(!isTerminalExecutionStatus('reconciling'));
  assert.ok(EXECUTION_TRANSITIONS.reconciling.length > 0, 'reconciling has outgoing decision paths');
});

test('the execution machine and the workflow instance machine are distinct authorities', () => {
  const executionStates = new Set<string>(EXECUTION_STATUSES as readonly string[]);
  const instanceStates = new Set<string>(WORKFLOW_INSTANCE_STATUSES as readonly string[]);
  // Instance-only states never appear on executions.
  for (const instanceOnly of ['draft', 'ready', 'blocked']) {
    assert.ok(!executionStates.has(instanceOnly), `${instanceOnly} is a workflow-instance state, never an execution state`);
  }
  // Execution-only states never appear on workflow instances.
  for (const executionOnly of ['created', 'queued', 'starting', 'pausing', 'unknown', 'reconciling']) {
    assert.ok(!instanceStates.has(executionOnly), `${executionOnly} is an execution state, never a workflow-instance state`);
  }
  // The shared state names (running/paused/succeeded/failed/cancelled) do
  // not blend the machines: the execution machine carries the runtime
  // attempt lifecycle (11 states) and the instance machine the workflow
  // lifecycle intent (8 states) — two distinct state SETS even where a
  // shared name has an analogous edge (paused→running in both).
  assert.equal(EXECUTION_STATUSES.length, 11);
  assert.equal(WORKFLOW_INSTANCE_STATUSES.length, 8);
  const sharedNames = [...executionStates].filter((state) => instanceStates.has(state));
  assert.deepEqual([...sharedNames].sort(), [
    'cancelled',
    'failed',
    'paused',
    'running',
    'succeeded',
  ]);
  // Where the names differ in semantics the edge sets prove it: running
  // branches to pausing/unknown on executions but to paused/blocked on
  // instances; terminal states have no outgoing edges in EITHER machine.
  const executionRunning = EXECUTION_TRANSITIONS.running as readonly string[];
  const instanceRunning = WORKFLOW_INSTANCE_TRANSITIONS.running as readonly string[];
  assert.ok(executionRunning.includes('pausing'));
  assert.ok(!instanceRunning.includes('pausing'));
  assert.ok(executionRunning.includes('unknown'));
  assert.ok(!instanceRunning.includes('unknown'));
  assert.ok(instanceRunning.includes('blocked'));
  assert.ok(!executionRunning.includes('blocked'));
  for (const terminal of ['succeeded', 'failed', 'cancelled'] as const) {
    assert.deepEqual(EXECUTION_TRANSITIONS[terminal], []);
    assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS[terminal], []);
  }
});

test('the normalized-model tables are the frozen closed sets', () => {
  // EXEC-AC-01: all execution kinds use ONE normalized Execution identity.
  assert.deepEqual([...EXECUTION_KINDS], ['deterministic', 'ai', 'human', 'extension']);
  // §9: the frozen runtime class list.
  assert.deepEqual([...RUNTIME_CLASSES], [
    'pooled-worker',
    'ephemeral-sandbox',
    'persistent-sandbox',
    'dedicated-runtime',
  ]);
  // Only the sandbox classes lease runtime environments (tenant-runtime
  // compute allocation: pooled-worker is shared-pool work).
  assert.deepEqual([...SANDBOX_RUNTIME_CLASSES], [
    'ephemeral-sandbox',
    'persistent-sandbox',
    'dedicated-runtime',
  ]);
  // §24: retryable failures declare whether retry is safe.
  assert.deepEqual([...RETRY_CLASSIFICATIONS], ['safe', 'unsafe']);
});

test('composeExecutionOwnerContext is a pure composition of the canonical owner context', () => {
  const execution = {
    executionId: '00000000-0000-4000-8000-000000000001',
    taskLink: { kind: 'workflow-node' as const, workflowInstanceId: '00000000-0000-4000-8000-000000000002', nodeId: 'n1' },
    retryOfExecutionId: null,
    attemptNumber: 1,
    executionKind: 'ai' as const,
    runtimeClass: 'pooled-worker' as const,
    idempotencyKey: 'key-1',
    createFingerprint: 'a'.repeat(64),
    workspaceId: '00000000-0000-4000-8000-000000000003',
    clientId: '00000000-0000-4000-8000-000000000004',
    agencyId: '00000000-0000-4000-8000-000000000005',
    status: 'created' as const,
    retryClassification: null,
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const workspace = {
    workspaceId: execution.workspaceId,
    clientId: execution.clientId,
    name: 'w',
    slug: 'w',
    status: 'active' as const,
    createdBy: null,
    version: 1,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };
  const client = {
    clientId: execution.clientId,
    agencyId: execution.agencyId,
    name: 'c',
    slug: 'c',
    status: 'active' as const,
    createdBy: null,
    version: 1,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };
  const agency = {
    agencyId: execution.agencyId,
    slug: 'a',
    status: 'active' as const,
  };
  const first = composeExecutionOwnerContext(execution, workspace, client, agency, '2026-01-01T00:00:01.000Z');
  const second = composeExecutionOwnerContext(execution, workspace, client, agency, '2026-01-01T00:00:01.000Z');
  assert.deepEqual(first, second);
  assert.equal(first.scope.kind, 'execution');
  assert.equal(first.scope.executionId, execution.executionId);
  assert.equal(first.scope.workspaceId, execution.workspaceId);
  assert.equal(first.scope.clientId, execution.clientId);
  assert.equal(first.scope.agencyId, execution.agencyId);
  assert.equal(first.execution, execution);
  assert.equal(first.workspace, workspace);
  assert.equal(first.client, client);
  assert.equal(first.agency, agency);
});
