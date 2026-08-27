/**
 * MKT-009 unit tests — the frozen Workflow INSTANCE state machine
 * (pure functions and tables, no DB).
 *
 * Proofs (implementation-contract §5 "Workflow instance state machine";
 * state-machines.md "Workflow Instance"; WF-AC-01 "legal workflow
 * transitions exactly match frozen state machine — exhaustive unit test";
 * WF-AC-02 "invalid transitions are rejected"):
 *   1. WORKFLOW_INSTANCE_STATUSES is EXACTLY the eight canonical §5 states;
 *   2. WORKFLOW_INSTANCE_TRANSITIONS is EXACTLY the frozen machine — the
 *      nine legal edges (draft→ready; ready→running; running→{paused,
 *      blocked, succeeded, failed, cancelled}; paused→running;
 *      blocked→running), no self-loops, no skip-edges, no back-edges
 *      except the two declared resumptions, and NO outgoing transitions
 *      from the three terminal states;
 *   3. isLegalWorkflowInstanceTransition is exhaustive over the full 8×8
 *      from × to matrix — every cell not in the machine is illegal
 *      (draft→running skip, ready→draft back-edge, running→ready,
 *      paused→cancelled — cancellation is reachable ONLY from running —
 *      blocked→succeeded, every terminal→*, every self-loop);
 *   4. isTerminalWorkflowInstanceStatus is true exactly for
 *      succeeded/failed/cancelled — the terminal, immutable states;
 *   5. the INSTANCE machine and the DEFINITION machine are distinct
 *      authorities: definition-only states (review/active/retired) are
 *      never instance states, and instance-only states (running/paused/
 *      blocked/succeeded/failed/cancelled/ready) are never definition
 *      states — the instance machine carries the runtime lifecycle, the
 *      definition machine the editorial/activation lifecycle, and the two
 *      never blend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_DEFINITION_TRANSITIONS,
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_INSTANCE_TERMINAL_STATUSES,
  WORKFLOW_INSTANCE_TRANSITIONS,
  isLegalWorkflowInstanceTransition,
  isTerminalWorkflowInstanceStatus,
  type WorkflowDefinitionStatus,
  type WorkflowInstanceStatus,
} from '../../src/modules/workflows/public.ts';

const STATUSES: readonly WorkflowInstanceStatus[] = [
  'draft',
  'ready',
  'running',
  'paused',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
];

test('WORKFLOW_INSTANCE_STATUSES is exactly the eight canonical §5 states', () => {
  assert.deepEqual([...WORKFLOW_INSTANCE_STATUSES], STATUSES);
});

test('WORKFLOW_INSTANCE_TRANSITIONS is exactly the frozen §5 machine', () => {
  assert.deepEqual([...Object.keys(WORKFLOW_INSTANCE_TRANSITIONS)].sort(), [
    'blocked',
    'cancelled',
    'draft',
    'failed',
    'paused',
    'ready',
    'running',
    'succeeded',
  ]);
  // The nine frozen edges.
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.draft, ['ready']);
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.ready, ['running']);
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.running, [
    'paused',
    'blocked',
    'succeeded',
    'failed',
    'cancelled',
  ]);
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.paused, ['running']);
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.blocked, ['running']);
  // Terminal: no outgoing transitions at all.
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.succeeded, []);
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.failed, []);
  assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS.cancelled, []);
});

test('isLegalWorkflowInstanceTransition is exhaustive: every non-frozen cell is illegal (WF-AC-01/02)', () => {
  const legal: ReadonlyArray<[WorkflowInstanceStatus, WorkflowInstanceStatus]> = [
    ['draft', 'ready'],
    ['ready', 'running'],
    ['running', 'paused'],
    ['running', 'blocked'],
    ['running', 'succeeded'],
    ['running', 'failed'],
    ['running', 'cancelled'],
    ['paused', 'running'],
    ['blocked', 'running'],
  ];
  let legalCount = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = legal.some(([f, t]) => f === from && t === to);
      if (expected) legalCount += 1;
      assert.equal(
        isLegalWorkflowInstanceTransition(from, to),
        expected,
        `${from} → ${to} must be ${expected ? 'legal' : 'illegal'}`,
      );
    }
  }
  // Exactly nine legal cells in the whole 8×8 matrix.
  assert.equal(legalCount, 9);
  // Spot-check the most tempting illegal transitions explicitly.
  assert.equal(isLegalWorkflowInstanceTransition('draft', 'running'), false, 'ready is mandatory before running');
  assert.equal(isLegalWorkflowInstanceTransition('draft', 'cancelled'), false, 'cancellation is not an escape from draft');
  assert.equal(isLegalWorkflowInstanceTransition('ready', 'draft'), false, 'no back-edge');
  assert.equal(isLegalWorkflowInstanceTransition('running', 'ready'), false, 'running never rewinds to ready');
  assert.equal(isLegalWorkflowInstanceTransition('running', 'draft'), false, 'running never rewinds to draft');
  assert.equal(isLegalWorkflowInstanceTransition('paused', 'cancelled'), false, 'cancel is reachable ONLY from running');
  assert.equal(isLegalWorkflowInstanceTransition('paused', 'succeeded'), false, 'paused must resume before terminating');
  assert.equal(isLegalWorkflowInstanceTransition('blocked', 'failed'), false, 'blocked must resume before terminating');
  assert.equal(isLegalWorkflowInstanceTransition('blocked', 'cancelled'), false, 'blocked must resume before cancelling');
  assert.equal(isLegalWorkflowInstanceTransition('succeeded', 'running'), false, 'terminal states are immutable');
  assert.equal(isLegalWorkflowInstanceTransition('failed', 'running'), false, 'terminal states are immutable');
  assert.equal(isLegalWorkflowInstanceTransition('cancelled', 'running'), false, 'terminal states are immutable');
  assert.equal(isLegalWorkflowInstanceTransition('succeeded', 'failed'), false, 'terminal states never morph');
  assert.equal(isLegalWorkflowInstanceTransition('cancelled', 'succeeded'), false, 'terminal states never morph');
});

test('isTerminalWorkflowInstanceStatus is true exactly for the three terminal states', () => {
  assert.deepEqual([...WORKFLOW_INSTANCE_TERMINAL_STATUSES].sort(), [
    'cancelled',
    'failed',
    'succeeded',
  ]);
  for (const status of STATUSES) {
    const expected = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    assert.equal(
      isTerminalWorkflowInstanceStatus(status),
      expected,
      `${status} must be ${expected ? 'terminal' : 'non-terminal'}`,
    );
  }
});

test('the instance machine and the definition machine are distinct authorities', () => {
  const definitionStatuses = Object.keys(
    WORKFLOW_DEFINITION_TRANSITIONS,
  ) as readonly WorkflowDefinitionStatus[];
  // Definition-only states never appear as instance states.
  for (const definitionOnly of ['review', 'active', 'retired'] as const) {
    assert.equal(
      (WORKFLOW_INSTANCE_STATUSES as readonly string[]).includes(definitionOnly),
      false,
      `${definitionOnly} is a Workflow DEFINITION state, never an instance state`,
    );
    assert.equal(
      definitionStatuses.includes(definitionOnly),
      true,
      `${definitionOnly} belongs to the definition machine`,
    );
  }
  // Instance-only states never appear as definition states.
  for (const instanceOnly of [
    'ready',
    'running',
    'paused',
    'blocked',
    'succeeded',
    'failed',
    'cancelled',
  ] as const) {
    assert.equal(
      (definitionStatuses as readonly string[]).includes(instanceOnly),
      false,
      `${instanceOnly} is a Workflow INSTANCE state, never a definition state`,
    );
  }
  // The two machines' edge sets are disjoint: no edge of one machine is an
  // edge of the other (serialized "from→to" pairs never overlap — the
  // shared 'draft' label resolves differently in each machine).
  const instanceEdges = new Set<string>();
  for (const [from, targets] of Object.entries(WORKFLOW_INSTANCE_TRANSITIONS)) {
    for (const to of targets) instanceEdges.add(`${from}→${to}`);
  }
  const definitionEdges = new Set<string>();
  for (const [from, targets] of Object.entries(WORKFLOW_DEFINITION_TRANSITIONS)) {
    for (const to of targets) definitionEdges.add(`${from}→${to}`);
  }
  for (const edge of instanceEdges) {
    assert.equal(
      definitionEdges.has(edge),
      false,
      `instance edge ${edge} is not an edge of the definition machine`,
    );
  }
  for (const edge of definitionEdges) {
    assert.equal(
      instanceEdges.has(edge),
      false,
      `definition edge ${edge} is not an edge of the instance machine`,
    );
  }
  assert.equal(instanceEdges.size, 9);
  assert.equal(definitionEdges.size, 3);
});
