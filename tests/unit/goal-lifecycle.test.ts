/**
 * MKT-006 unit tests — the frozen Goal lifecycle table and the canonical
 * owner-context composer (pure functions, no DB).
 *
 * Proofs:
 *   - GOAL_TRANSITIONS is exactly the frozen business-intent machine:
 *     draft → active/abandoned, active → achieved/abandoned, and
 *     achieved/abandoned are TERMINAL (no outgoing edges) — business
 *     history cannot be rewritten, and there are NO execution semantics
 *     (no pause/resume/running: a Goal is not a workflow, architecture.md
 *     §7);
 *   - every illegal transition (including every resurrection out of a
 *     terminal state) is rejected by isLegalGoalTransition;
 *   - composeGoalOwnerContext derives the canonical scope from the CLIENT
 *     OWNERSHIP and the goal row only (never from caller input) and is
 *   - pure: identical inputs compose identical outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_COMPARATORS,
  GOAL_TRANSITIONS,
  composeGoalOwnerContext,
  isLegalGoalTransition,
  type GoalRecord,
} from '../../src/modules/goals/public.ts';
import type { ClientOwnerContext } from '../../src/modules/clients/public.ts';
import type { WorkspaceRecord } from '../../src/modules/workspaces/public.ts';

test('GOAL_TRANSITIONS is exactly the frozen business-intent lifecycle', () => {
  assert.deepEqual([...Object.keys(GOAL_TRANSITIONS)].sort(), [
    'abandoned',
    'achieved',
    'active',
    'draft',
  ]);
  assert.deepEqual([...GOAL_TRANSITIONS.draft], ['active', 'abandoned']);
  assert.deepEqual([...GOAL_TRANSITIONS.active], ['achieved', 'abandoned']);
  assert.deepEqual([...GOAL_TRANSITIONS.achieved], []);
  assert.deepEqual([...GOAL_TRANSITIONS.abandoned], []);
});

test('terminal Goal states are terminal — no resurrection, no execution semantics', () => {
  for (const terminal of ['achieved', 'abandoned'] as const) {
    for (const target of ['draft', 'active', 'achieved', 'abandoned'] as const) {
      assert.equal(
        isLegalGoalTransition(terminal, target),
        false,
        `${terminal} → ${target} must be illegal (terminal business history)`,
      );
    }
  }
  // No execution-flavored states exist anywhere in the machine.
  const allStates = Object.keys(GOAL_TRANSITIONS).join(' ').toLowerCase();
  for (const executionState of ['paused', 'running', 'queued', 'blocked', 'retry']) {
    assert.equal(allStates.includes(executionState), false);
  }
});

test('the legal Goal transitions are exactly the frozen set', () => {
  const legal: ReadonlyArray<[string, string]> = [
    ['draft', 'active'],
    ['draft', 'abandoned'],
    ['active', 'achieved'],
    ['active', 'abandoned'],
  ];
  const all: ReadonlyArray<string> = ['draft', 'active', 'achieved', 'abandoned'];
  for (const from of all) {
    for (const to of all) {
      const expected = legal.some(([f, t]) => f === from && t === to);
      assert.equal(
        isLegalGoalTransition(from as never, to as never),
        expected,
        `${from} → ${to} legality must be ${expected}`,
      );
    }
  }
});

test('comparators are the closed measurability set', () => {
  assert.deepEqual([...GOAL_COMPARATORS], ['>=', '>', '<=', '<', '==']);
});

const clientOwnership: ClientOwnerContext = {
  scope: { kind: 'client', agencyId: 'agency-1', clientId: 'client-1' },
  client: {
    clientId: 'client-1',
    agencyId: 'agency-1',
    name: 'Client One',
    slug: 'client-one',
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  agency: { agencyId: 'agency-1', slug: 'agency-one', status: 'active' },
  resolvedAt: '2026-01-02T00:00:00.000Z',
};

const baseGoal: GoalRecord = {
  goalId: 'goal-1',
  clientId: 'client-1',
  workspaceId: null,
  objective: 'Grow qualified pipeline',
  successCriteria: [
    { metric: 'qualified_leads', comparator: '>=', targetValue: 100, unit: 'count', description: null },
  ],
  metrics: [{ name: 'cpa', unit: 'USD', description: 'observed only' }],
  constraints: [{ kind: 'resource', description: 'Budget cap 10k' }],
  timeHorizon: { startsOn: '2026-01-01', endsOn: '2026-03-31' },
  status: 'draft',
  createdBy: 'user-9',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('composeGoalOwnerContext derives the scope from durable ownership only', () => {
  const context = composeGoalOwnerContext(baseGoal, clientOwnership, null, '2026-02-01T00:00:00.000Z');
  assert.deepEqual(context.scope, {
    kind: 'goal',
    agencyId: 'agency-1',
    clientId: 'client-1',
    workspaceId: null,
    goalId: 'goal-1',
  });
  assert.equal(context.goal, baseGoal);
  assert.equal(context.client, clientOwnership.client);
  assert.equal(context.clientOwnership, clientOwnership);
  assert.equal(context.workspace, null);
  assert.equal(context.resolvedAt, '2026-02-01T00:00:00.000Z');
});

test('composeGoalOwnerContext carries the workspace row for workspace-scoped goals', () => {
  const scoped: GoalRecord = { ...baseGoal, goalId: 'goal-2', workspaceId: 'workspace-7' };
  const workspace: WorkspaceRecord = {
    workspaceId: 'workspace-7',
    clientId: 'client-1',
    name: 'Launch',
    slug: 'launch',
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const context = composeGoalOwnerContext(scoped, clientOwnership, workspace, '2026-02-01T00:00:00.000Z');
  assert.equal(context.scope.workspaceId, 'workspace-7');
  assert.equal(context.workspace, workspace);
});

test('composeGoalOwnerContext is pure — identical inputs compose identical outputs', () => {
  const first = composeGoalOwnerContext(baseGoal, clientOwnership, null, '2026-02-01T00:00:00.000Z');
  const second = composeGoalOwnerContext(baseGoal, clientOwnership, null, '2026-02-01T00:00:00.000Z');
  assert.deepEqual(first, second);
});
