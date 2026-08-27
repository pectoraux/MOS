/**
 * MKT-008 unit tests — the frozen Workflow Definition lifecycle table,
 * the frozen node/edge class lists and the pure owner-context composer
 * (pure functions, no DB).
 *
 * Proofs (implementation-contract §4 "A Workflow Definition is versioned
 * and immutable after activation"; work-items.md MKT-008 "immutable
 * deployed definitions"; architecture.md §10 node class list; §4 edge
 * type list; tenant-runtime-model ownership matrix "Workflow |
 * Workspace/Client"):
 *   1. WORKFLOW_DEFINITION_TRANSITIONS is EXACTLY the activation machine
 *      — the four states, the three forward edges (draft → review →
 *      active → retired), no back-edges, no skip-edges, and no outgoing
 *      transitions from terminal `retired`;
 *   2. isLegalWorkflowDefinitionTransition is exhaustive over the full
 *      from × to matrix — every cell not in the machine is illegal
 *      (draft→active, draft→retired, review→draft, review→retired,
 *      active→review, every retired→*, self-loops);
 *   3. the lifecycle carries NO runtime semantics (running/paused/queued/
 *      blocked are not definition states — the Workflow INSTANCE machine
 *      is MKT-009 and is not expressible here);
 *   4. WORKFLOW_NODE_TYPES is exactly the frozen architecture.md §10
 *      class list and WORKFLOW_EDGE_TYPES exactly the frozen §4 edge
 *      type list — closed sets the graph validation enforces;
 *   5. composeWorkflowOwnerContext is a pure composition of the durable
 *      rows — the scope derives from the workflow row, never from
 *      arguments the caller could influence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTABLE_NODE_TYPES,
  STRUCTURAL_NODE_TYPES,
  WORKFLOW_DEFINITION_TRANSITIONS,
  WORKFLOW_EDGE_TYPES,
  WORKFLOW_NODE_TYPES,
  composeWorkflowOwnerContext,
  isLegalWorkflowDefinitionTransition,
  type WorkflowDefinitionStatus,
  type WorkflowRecord,
} from '../../src/modules/workflows/public.ts';

const STATUSES: readonly WorkflowDefinitionStatus[] = ['draft', 'review', 'active', 'retired'];

test('WORKFLOW_DEFINITION_TRANSITIONS is exactly the activation machine', () => {
  assert.deepEqual([...Object.keys(WORKFLOW_DEFINITION_TRANSITIONS)].sort(), [
    'active',
    'draft',
    'retired',
    'review',
  ]);
  // The three forward edges of draft → review → active → retired.
  assert.deepEqual(WORKFLOW_DEFINITION_TRANSITIONS.draft, ['review']);
  assert.deepEqual(WORKFLOW_DEFINITION_TRANSITIONS.review, ['active']);
  assert.deepEqual(WORKFLOW_DEFINITION_TRANSITIONS.active, ['retired']);
  // Terminal: no outgoing transitions from retired.
  assert.deepEqual(WORKFLOW_DEFINITION_TRANSITIONS.retired, []);
});

test('isLegalWorkflowDefinitionTransition is exhaustive: every non-frozen cell is illegal', () => {
  const legal: ReadonlyArray<[WorkflowDefinitionStatus, WorkflowDefinitionStatus]> = [
    ['draft', 'review'],
    ['review', 'active'],
    ['active', 'retired'],
  ];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = legal.some(([f, t]) => f === from && t === to);
      assert.equal(
        isLegalWorkflowDefinitionTransition(from, to),
        expected,
        `${from} → ${to} must be ${expected ? 'legal' : 'illegal'}`,
      );
    }
  }
  // Spot-check the most tempting illegal transitions explicitly.
  assert.equal(isLegalWorkflowDefinitionTransition('draft', 'active'), false, 'review is mandatory before activation');
  assert.equal(isLegalWorkflowDefinitionTransition('draft', 'retired'), false, 'retirement only from active');
  assert.equal(isLegalWorkflowDefinitionTransition('review', 'draft'), false, 'no back-edge');
  assert.equal(isLegalWorkflowDefinitionTransition('active', 'review'), false, 'activated definitions never rewind');
  assert.equal(isLegalWorkflowDefinitionTransition('retired', 'draft'), false, 'terminal history is frozen');
  assert.equal(isLegalWorkflowDefinitionTransition('retired', 'active'), false, 'terminal history never resurrects');
});

test('the definition lifecycle carries NO runtime/instance semantics', () => {
  const allTargets = new Set<string>();
  for (const targets of Object.values(WORKFLOW_DEFINITION_TRANSITIONS)) {
    for (const target of targets) allTargets.add(target);
  }
  for (const runtimeState of ['running', 'paused', 'queued', 'dispatched', 'blocked', 'ready', 'cancelled']) {
    assert.equal(
      (allTargets as Set<string>).has(runtimeState),
      false,
      `${runtimeState} is a Workflow INSTANCE state (MKT-009), never a definition state`,
    );
    assert.equal(
      STATUSES.includes(runtimeState as WorkflowDefinitionStatus),
      false,
      `${runtimeState} is not a definition status`,
    );
  }
});

test('WORKFLOW_NODE_TYPES is exactly the frozen architecture.md §10 class list', () => {
  assert.deepEqual([...WORKFLOW_NODE_TYPES].sort(), [
    'ai_task',
    'api_action',
    'approval',
    'browser_task',
    'condition',
    'experiment',
    'extension_capability',
    'function',
    'human_task',
    'join',
    'loop',
    'terminal',
  ]);
  // The executable and structural lists partition the frozen classes.
  assert.deepEqual(
    [...EXECUTABLE_NODE_TYPES, ...STRUCTURAL_NODE_TYPES].sort(),
    [...WORKFLOW_NODE_TYPES].sort(),
  );
  for (const structural of STRUCTURAL_NODE_TYPES) {
    assert.equal(EXECUTABLE_NODE_TYPES.includes(structural), false);
  }
});

test('WORKFLOW_EDGE_TYPES is exactly the frozen §4 edge type list', () => {
  assert.deepEqual([...WORKFLOW_EDGE_TYPES].sort(), ['conditional', 'failure', 'join', 'success']);
});

test('composeWorkflowOwnerContext is a pure composition of the durable rows', () => {
  const workflow: WorkflowRecord = {
    workflowId: 'wf-1',
    workspaceId: 'ws-1',
    clientId: 'cl-1',
    agencyId: 'ag-1',
    name: 'Launch workflow',
    description: '',
    createdBy: 'user-1',
    version: 3,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
  };
  const workspace = {
    workspaceId: 'ws-1',
    clientId: 'cl-1',
    name: 'Launch workspace',
    slug: 'launch',
    status: 'active' as const,
    createdBy: 'user-1',
    version: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const client = {
    clientId: 'cl-1',
    agencyId: 'ag-1',
    name: 'Acme',
    slug: 'acme',
    status: 'active' as const,
    createdBy: 'user-1',
    version: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const agency = { agencyId: 'ag-1', slug: 'acme-agency', status: 'active' as const };
  const resolvedAt = '2025-01-03T00:00:00.000Z';

  const first = composeWorkflowOwnerContext(workflow, workspace, client, agency, resolvedAt);
  const second = composeWorkflowOwnerContext(workflow, workspace, client, agency, resolvedAt);
  assert.deepEqual(first, second);

  // The scope derives from the WORKFLOW row only — the same resolved
  // boundary rows always compose the same context.
  assert.deepEqual(first.scope, {
    kind: 'workflow',
    agencyId: 'ag-1',
    clientId: 'cl-1',
    workspaceId: 'ws-1',
    workflowId: 'wf-1',
  });
  assert.equal(first.workflow, workflow);
  assert.equal(first.workspace, workspace);
  assert.equal(first.client, client);
  assert.equal(first.agency, agency);
  assert.equal(first.resolvedAt, resolvedAt);
});
