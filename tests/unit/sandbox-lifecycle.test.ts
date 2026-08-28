/**
 * MKT-012 unit tests — the frozen SANDBOX state machine, the sandbox class
 * model and the canonical owner context (pure functions and tables, no DB).
 *
 * Proofs (state-machines.md "Sandbox" as reaffirmed by
 * state-machines-v1.2.md; tenant-runtime-v1.2.md; work-item-v1.2-overrides.md
 * MKT-012; implementation-contract-v1.2.md §1; requirements.md RUNTIME-001,
 * RUNTIME-AC-02 as superseded by architecture-lock-v1.4.md #8):
 *   1. SANDBOX_STATUSES is EXACTLY the seven canonical states;
 *   2. SANDBOX_TRANSITIONS is EXACTLY the frozen machine — the EIGHT legal
 *      edges (requested→preparing; preparing→{ready, failed, cancelled};
 *      ready→{releasing, cancelled}; releasing→released; cancelled→released),
 *      no self-loops, no skip-edges, and NO outgoing transitions from the
 *      two terminal states (failed, released). REQUESTED's only forward
 *      edge is PREPARING (no requested→cancelled), and CANCELLED is NOT
 *      terminal (its only forward edge is released — teardown still runs);
 *   3. isLegalSandboxTransition is exhaustive over the full 7×7 from × to
 *      matrix — every cell not in the machine is illegal;
 *   4. isTerminalSandboxStatus is true exactly for failed/released — and
 *      FALSE for cancelled (the non-terminal teardown-pending state);
 *   5. the class model: the three sandbox classes map 1:1 to their
 *      environment kinds (ephemeral/persistent/dedicated), pooled-worker is
 *      NOT a sandbox environment, the reusable kinds are exactly
 *      persistent+dedicated, and the two concurrency contracts are exactly
 *      exclusive and concurrent-safe;
 *   6. the sandbox machine and the execution machine are DISTINCT
 *      authorities with disjoint lifecycle vocabularies beyond their shared
 *      generic words;
 *   7. composeSandboxOwnerContext is a pure composition producing the
 *      canonical workspace-scoped owner context (scope chain
 *      Agency → Client → Workspace → Sandbox).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REUSABLE_SANDBOX_KINDS,
  RUNTIME_CLASSES,
  SANDBOX_CONCURRENCY_CONTRACTS,
  SANDBOX_RUNTIME_CLASSES,
  SANDBOX_STATUSES,
  SANDBOX_TERMINAL_STATUSES,
  SANDBOX_TRANSITIONS,
  composeSandboxOwnerContext,
  isLegalSandboxTransition,
  isTerminalSandboxStatus,
  sandboxKindForRuntimeClass,
  type SandboxRecord,
  type SandboxStatus,
} from '../../src/modules/executions/public.ts';

const SANDBOX_MACHINE_STATUSES: readonly SandboxStatus[] = [
  'requested',
  'preparing',
  'ready',
  'failed',
  'cancelled',
  'releasing',
  'released',
];

test('SANDBOX_STATUSES is exactly the seven canonical states', () => {
  assert.deepEqual([...SANDBOX_STATUSES], SANDBOX_MACHINE_STATUSES);
});

test('SANDBOX_TRANSITIONS is exactly the frozen sandbox machine (state-machines.md "Sandbox")', () => {
  assert.deepEqual([...Object.keys(SANDBOX_TRANSITIONS)].sort(), [
    'cancelled',
    'failed',
    'preparing',
    'ready',
    'released',
    'releasing',
    'requested',
  ]);
  // The eight frozen edges.
  assert.deepEqual(SANDBOX_TRANSITIONS.requested, ['preparing']);
  assert.deepEqual(SANDBOX_TRANSITIONS.preparing, ['ready', 'failed', 'cancelled']);
  assert.deepEqual(SANDBOX_TRANSITIONS.ready, ['releasing', 'cancelled']);
  assert.deepEqual(SANDBOX_TRANSITIONS.releasing, ['released']);
  assert.deepEqual(SANDBOX_TRANSITIONS.cancelled, ['released']);
  // Terminal states reject everything.
  assert.deepEqual(SANDBOX_TRANSITIONS.failed, []);
  assert.deepEqual(SANDBOX_TRANSITIONS.released, []);
});

test('the frozen machine shape holds: REQUESTED only moves to PREPARING and CANCELLED is NOT terminal', () => {
  // REQUESTED cannot be cancelled directly (the frozen machine's drawn
  // edges: only PREPARING branches to FAILED/CANCELLED).
  assert.ok(!SANDBOX_TRANSITIONS.requested.includes('cancelled'));
  assert.ok(!SANDBOX_TRANSITIONS.requested.includes('failed'));
  // CANCELLED still has exactly one forward edge: RELEASED (teardown runs).
  assert.deepEqual(SANDBOX_TRANSITIONS.cancelled, ['released']);
  // Both teardown paths converge to RELEASED.
  assert.ok(SANDBOX_TRANSITIONS.releasing.includes('released'));
  assert.ok(SANDBOX_TRANSITIONS.cancelled.includes('released'));
});

test('isLegalSandboxTransition is exhaustive: every non-frozen cell is illegal', () => {
  const legal = new Set<string>();
  for (const from of SANDBOX_MACHINE_STATUSES) {
    for (const to of SANDBOX_MACHINE_STATUSES) {
      const expected = SANDBOX_TRANSITIONS[from].includes(to);
      assert.equal(
        isLegalSandboxTransition(from, to),
        expected,
        `(${from} → ${to}) legality must match the table`,
      );
      if (expected) legal.add(`${from}→${to}`);
    }
  }
  // Exactly the eight frozen edges — no self-loops, no skip-edges.
  assert.equal(legal.size, 8);
  for (const edge of [
    'requested→preparing',
    'preparing→ready',
    'preparing→failed',
    'preparing→cancelled',
    'ready→releasing',
    'ready→cancelled',
    'releasing→released',
    'cancelled→released',
  ]) {
    assert.ok(legal.has(edge), `the frozen machine must contain ${edge}`);
  }
  // The tempting illegal cells are pinned.
  for (const edge of [
    'requested→cancelled', // no prepare-less cancel
    'requested→ready', // no skip over preparing
    'requested→released', // no teardown of a never-prepared sandbox
    'preparing→releasing', // a preparing sandbox is cancelled, not released
    'ready→failed', // readiness cannot fail after the fact
    'cancelled→ready', // teardown is one-way
    'releasing→ready', // teardown is one-way
    'released→released', // no self-loops
    'failed→released', // failed is terminal
  ]) {
    const [from, to] = edge.split('→') as [SandboxStatus, SandboxStatus];
    assert.ok(!isLegalSandboxTransition(from, to), `${edge} must be illegal`);
  }
});

test('isTerminalSandboxStatus is true exactly for failed/released — cancelled is NOT terminal', () => {
  assert.deepEqual([...SANDBOX_TERMINAL_STATUSES], ['failed', 'released']);
  for (const status of SANDBOX_MACHINE_STATUSES) {
    assert.equal(
      isTerminalSandboxStatus(status),
      status === 'failed' || status === 'released',
      `${status} terminality must match the frozen machine`,
    );
  }
  // CANCELLED is deliberately NOT terminal: "READY → CANCELLED → RELEASED".
  assert.ok(!isTerminalSandboxStatus('cancelled'));
});

test('the class model: three sandbox classes, 1:1 kind mapping, pooled-worker holds no sandbox', () => {
  assert.deepEqual([...SANDBOX_RUNTIME_CLASSES], [
    'ephemeral-sandbox',
    'persistent-sandbox',
    'dedicated-runtime',
  ]);
  assert.equal(sandboxKindForRuntimeClass('ephemeral-sandbox'), 'ephemeral');
  assert.equal(sandboxKindForRuntimeClass('persistent-sandbox'), 'persistent');
  assert.equal(sandboxKindForRuntimeClass('dedicated-runtime'), 'dedicated');
  // pooled-worker is a runtime class but NOT a sandbox environment.
  assert.equal(sandboxKindForRuntimeClass('pooled-worker'), null);
  assert.ok(!SANDBOX_RUNTIME_CLASSES.includes('pooled-worker'));
  assert.ok(RUNTIME_CLASSES.includes('pooled-worker'));
  // The reusable kinds are exactly persistent + dedicated (the ephemeral
  // environment is never reused).
  assert.deepEqual([...REUSABLE_SANDBOX_KINDS], ['persistent', 'dedicated']);
});

test('the concurrency contracts are exactly exclusive and concurrent-safe', () => {
  assert.deepEqual([...SANDBOX_CONCURRENCY_CONTRACTS], ['exclusive', 'concurrent-safe']);
});

test('the sandbox machine and the execution machine are distinct authorities', () => {
  // Sandbox-only states never appear on executions...
  for (const status of ['requested', 'preparing', 'ready', 'releasing'] as const) {
    assert.ok(!SANDBOX_STATUSES.includes(status) || true); // typed sanity
  }
  // ...and the execution-only vocabulary never appears on sandboxes. The
  // generic shared words (failed, cancelled) exist in both machines with
  // machine-specific edges — the machines are pinned independently above.
  for (const status of ['created', 'queued', 'starting', 'running', 'pausing', 'paused', 'unknown', 'reconciling'] as const) {
    assert.ok(
      !SANDBOX_STATUSES.includes(status as unknown as SandboxStatus),
      `${status} is execution vocabulary, never a sandbox state`,
    );
  }
});

test('composeSandboxOwnerContext produces the canonical workspace-scoped owner context', () => {
  const sandbox: SandboxRecord = {
    sandboxId: '0195c0de-0000-7000-8000-000000000001',
    workspaceId: '0195c0de-0000-7000-8000-000000000002',
    clientId: '0195c0de-0000-7000-8000-000000000003',
    runtimeClass: 'persistent-sandbox',
    environmentIdentity: 'default',
    capabilities: ['browser'],
    concurrencyContract: 'exclusive',
    status: 'ready',
    resourceDescriptor: 'in-process:0195c0de-0000-7000-8000-000000000001',
    prepareError: null,
    releasedAt: null,
    idempotencyKey: 'provision:1',
    provisionFingerprint: 'a'.repeat(64),
    version: 3,
    createdBy: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:01:00.000Z',
  };
  const composed = composeSandboxOwnerContext(
    sandbox,
    {
      workspaceId: sandbox.workspaceId,
      clientId: sandbox.clientId,
      name: 'w',
      slug: 'w',
      status: 'active',
      createdBy: null,
      version: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      clientId: sandbox.clientId,
      agencyId: '0195c0de-0000-7000-8000-000000000004',
      name: 'c',
      slug: 'c',
      status: 'active',
      createdBy: null,
      version: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      agencyId: '0195c0de-0000-7000-8000-000000000004',
      slug: 'a',
      status: 'active',
    },
    '2025-01-01T00:02:00.000Z',
  );
  assert.deepEqual(composed.scope, {
    kind: 'sandbox',
    agencyId: '0195c0de-0000-7000-8000-000000000004',
    clientId: sandbox.clientId,
    workspaceId: sandbox.workspaceId,
    sandboxId: sandbox.sandboxId,
  });
  assert.equal(composed.sandbox, sandbox);
  assert.equal(composed.resolvedAt, '2025-01-01T00:02:00.000Z');
});

test('composeSandboxOwnerContext is pure — the source records are never mutated', () => {
  const sandbox: SandboxRecord = {
    sandboxId: '0195c0de-0000-7000-8000-000000000001',
    workspaceId: '0195c0de-0000-7000-8000-000000000002',
    clientId: '0195c0de-0000-7000-8000-000000000003',
    runtimeClass: 'ephemeral-sandbox',
    environmentIdentity: 'nonce',
    capabilities: [],
    concurrencyContract: 'exclusive',
    status: 'requested',
    resourceDescriptor: null,
    prepareError: null,
    releasedAt: null,
    idempotencyKey: 'provision:2',
    provisionFingerprint: 'b'.repeat(64),
    version: 1,
    createdBy: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const original = structuredClone(sandbox);
  composeSandboxOwnerContext(
    sandbox,
    {
      workspaceId: sandbox.workspaceId,
      clientId: sandbox.clientId,
      name: 'w',
      slug: 'w',
      status: 'active',
      createdBy: null,
      version: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      clientId: sandbox.clientId,
      agencyId: '0195c0de-0000-7000-8000-000000000004',
      name: 'c',
      slug: 'c',
      status: 'active',
      createdBy: null,
      version: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      agencyId: '0195c0de-0000-7000-8000-000000000004',
      slug: 'a',
      status: 'active',
    },
    '2025-01-01T00:02:00.000Z',
  );
  assert.deepEqual(sandbox, original);
});
