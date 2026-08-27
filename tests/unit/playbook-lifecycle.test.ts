/**
 * MKT-007 unit tests — the frozen Playbook Version lifecycle table and the
 * pure owner-context composer (pure functions, no DB).
 *
 * Proofs (spec/state-machines.md "Playbook Version:
 * DRAFT → REVIEW → PUBLISHED → RETIRED"; PLAY-AC-01 "published Playbook
 * version is immutable"; architecture.md §8; tenant-runtime-model
 * ownership matrix "Playbook | Agency or Client"):
 *   1. PLAYBOOK_VERSION_TRANSITIONS is EXACTLY the frozen machine — the
 *      four states, the three forward edges, no back-edges, no
 *      skip-edges, and no outgoing transitions from terminal `retired`;
 *   2. isLegalPlaybookVersionTransition is exhaustive over the full
 *      from × to matrix — every cell not in the frozen machine is
 *      illegal (draft→published, draft→retired, review→draft,
 *      review→retired, published→review, every retired→*, self-loops);
 *   3. the lifecycle carries NO execution semantics (running/paused/
 *      queued/dispatched/blocked are not playbook version states);
 *   4. composePlaybookOwnerContext is a pure composition of the durable
 *      rows — agency-scoped, client-scoped and goal-linked shapes all
 *      derive the scope from the playbook row, never from arguments the
 *      caller could influence;
 *   5. PLAYBOOK_RUNTIME_CLASSES is exactly the frozen compute-allocation
 *      list (tenant-runtime-model).
 *
 * The strategy/deployment-metadata shape assertions live inside the
 * module (internal) and are proven at the API boundary by the MKT-007
 * integration suites (422 validation matrix + round-trips).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBOOK_RUNTIME_CLASSES,
  PLAYBOOK_VERSION_TRANSITIONS,
  composePlaybookOwnerContext,
  isLegalPlaybookVersionTransition,
  type PlaybookRecord,
  type PlaybookVersionStatus,
} from '../../src/modules/playbooks/public.ts';
import type { AgencyRecord } from '../../src/modules/agencies/public.ts';
import type { ClientOwnerContext, ClientRecord } from '../../src/modules/clients/public.ts';
import type { GoalRecord } from '../../src/modules/goals/public.ts';

const STATUSES: readonly PlaybookVersionStatus[] = ['draft', 'review', 'published', 'retired'];

test('PLAYBOOK_VERSION_TRANSITIONS is exactly the frozen Playbook Version machine', () => {
  assert.deepEqual([...Object.keys(PLAYBOOK_VERSION_TRANSITIONS)].sort(), [
    'draft',
    'published',
    'retired',
    'review',
  ]);
  // The three forward edges of DRAFT → REVIEW → PUBLISHED → RETIRED.
  assert.deepEqual(PLAYBOOK_VERSION_TRANSITIONS.draft, ['review']);
  assert.deepEqual(PLAYBOOK_VERSION_TRANSITIONS.review, ['published']);
  assert.deepEqual(PLAYBOOK_VERSION_TRANSITIONS.published, ['retired']);
  // Terminal: no outgoing transitions from retired.
  assert.deepEqual(PLAYBOOK_VERSION_TRANSITIONS.retired, []);
});

test('isLegalPlaybookVersionTransition is exhaustive: every non-frozen cell is illegal', () => {
  const legal: ReadonlyArray<[PlaybookVersionStatus, PlaybookVersionStatus]> = [
    ['draft', 'review'],
    ['review', 'published'],
    ['published', 'retired'],
  ];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = legal.some(([f, t]) => f === from && t === to);
      assert.equal(
        isLegalPlaybookVersionTransition(from, to),
        expected,
        `${from} → ${to} must be ${expected ? 'legal' : 'illegal'}`,
      );
    }
  }
  // Spot-check the most tempting illegal transitions explicitly.
  assert.equal(isLegalPlaybookVersionTransition('draft', 'published'), false, 'review is mandatory');
  assert.equal(isLegalPlaybookVersionTransition('draft', 'retired'), false, 'retirement only from published');
  assert.equal(isLegalPlaybookVersionTransition('review', 'draft'), false, 'no back-edge');
  assert.equal(isLegalPlaybookVersionTransition('review', 'retired'), false, 'retirement only from published');
  assert.equal(isLegalPlaybookVersionTransition('published', 'review'), false, 'no back-edge');
  assert.equal(isLegalPlaybookVersionTransition('published', 'draft'), false, 'no back-edge');
  for (const to of STATUSES) {
    assert.equal(isLegalPlaybookVersionTransition('retired', to), false, 'retired is terminal');
  }
});

test('the playbook version lifecycle carries no execution semantics', () => {
  const statusText = JSON.stringify(Object.keys(PLAYBOOK_VERSION_TRANSITIONS));
  for (const executionState of ['running', 'paused', 'queued', 'dispatched', 'blocked', 'active']) {
    assert.ok(
      !statusText.includes(executionState),
      `playbook version states must not contain execution state '${executionState}'`,
    );
  }
});

function playbookFixture(overrides: Partial<PlaybookRecord> = {}): PlaybookRecord {
  return {
    playbookId: 'pb-0001',
    agencyId: 'ag-0001',
    clientId: null,
    goalId: null,
    name: 'Inbound playbook',
    description: '',
    createdBy: 'user-0001',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function agencyFixture(): AgencyRecord {
  return {
    agencyId: 'ag-0001',
    name: 'Test Agency',
    slug: 'test-agency',
    status: 'active',
    createdBy: 'user-0001',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function clientRecordFixture(): ClientRecord {
  return {
    clientId: 'cl-0001',
    agencyId: 'ag-0001',
    name: 'Test Client',
    slug: 'test-client',
    status: 'active',
    createdBy: 'user-0001',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function clientOwnershipFixture(): ClientOwnerContext {
  return {
    scope: { kind: 'client', agencyId: 'ag-0001', clientId: 'cl-0001' },
    client: clientRecordFixture(),
    agency: { agencyId: 'ag-0001', slug: 'test-agency', status: 'active' },
    resolvedAt: '2026-01-01T00:00:00.000Z',
  };
}

function goalFixture(): GoalRecord {
  return {
    goalId: 'goal-0001',
    clientId: 'cl-0001',
    workspaceId: null,
    objective: 'Grow qualified pipeline',
    successCriteria: [
      { metric: 'qualified_leads', comparator: '>=', targetValue: 100, unit: null, description: null },
    ],
    metrics: [],
    constraints: [],
    timeHorizon: null,
    status: 'active',
    createdBy: 'user-0001',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('composePlaybookOwnerContext derives the agency-scoped context from the durable rows', () => {
  const playbook = playbookFixture();
  const agency = agencyFixture();
  const context = composePlaybookOwnerContext(playbook, agency, null, null, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(context.scope, {
    kind: 'playbook',
    agencyId: 'ag-0001',
    clientId: null,
    goalId: null,
    playbookId: 'pb-0001',
  });
  assert.equal(context.playbook, playbook);
  assert.equal(context.agency, agency);
  assert.equal(context.clientOwnership, null);
  assert.equal(context.goal, null);
  assert.equal(context.resolvedAt, '2026-01-02T00:00:00.000Z');
});

test('composePlaybookOwnerContext derives the client-scoped goal-linked context from the durable rows', () => {
  const playbook = playbookFixture({ clientId: 'cl-0001', goalId: 'goal-0001' });
  const agency = agencyFixture();
  const clientOwnership = clientOwnershipFixture();
  const goal = goalFixture();
  const context = composePlaybookOwnerContext(
    playbook,
    agency,
    clientOwnership,
    goal,
    '2026-01-02T00:00:00.000Z',
  );
  assert.deepEqual(context.scope, {
    kind: 'playbook',
    agencyId: 'ag-0001',
    clientId: 'cl-0001',
    goalId: 'goal-0001',
    playbookId: 'pb-0001',
  });
  assert.equal(context.clientOwnership, clientOwnership);
  assert.equal(context.goal, goal);
});

test('composePlaybookOwnerContext is pure — the same inputs compose the same context', () => {
  const playbook = playbookFixture({ clientId: 'cl-0001', goalId: 'goal-0001' });
  const agency = agencyFixture();
  const clientOwnership = clientOwnershipFixture();
  const goal = goalFixture();
  const first = composePlaybookOwnerContext(playbook, agency, clientOwnership, goal, 't1');
  const second = composePlaybookOwnerContext(playbook, agency, clientOwnership, goal, 't1');
  assert.deepEqual(first, second);
  // The scope is derived from the PLAYBOOK row only — a different playbook
  // row composes a different scope, never a mixture.
  const other = composePlaybookOwnerContext(
    playbookFixture({ playbookId: 'pb-0002', clientId: null, goalId: null }),
    agency,
    null,
    null,
    't1',
  );
  assert.equal(other.scope.playbookId, 'pb-0002');
  assert.equal(other.scope.clientId, null);
  assert.equal(other.scope.goalId, null);
});

test('PLAYBOOK_RUNTIME_CLASSES is exactly the frozen compute-allocation list', () => {
  assert.deepEqual([...PLAYBOOK_RUNTIME_CLASSES].sort(), [
    'dedicated-runtime',
    'ephemeral-sandbox',
    'persistent-sandbox',
    'pooled-worker',
  ]);
});
