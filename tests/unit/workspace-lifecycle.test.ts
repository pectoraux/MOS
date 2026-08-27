/**
 * MKT-004 unit tests — Workspace lifecycle transition table and the canonical
 * owner-context composition (pure functions, no database).
 *
 *   - the frozen Workspace lifecycle (active ⇄ disabled → deleted terminal)
 *     accepts exactly the legal transitions and rejects every illegal one,
 *     including every resurrection from `deleted` (issue #11 MKT-004-AC-06:
 *     "terminal/deleted state cannot be resurrected through stale
 *     identifiers");
 *   - composeWorkspaceOwnerContext produces the ONE canonical server-side
 *     owner context for Workspace-scoped operations (MKT-004-AC-02):
 *     workspace-scoped `scope` derived from the /clients canonical owner
 *     context plus the durable workspace row — never from caller claims.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_TRANSITIONS,
  composeWorkspaceOwnerContext,
  isLegalWorkspaceTransition,
  type WorkspaceRecord,
} from '../../src/modules/workspaces/public.ts';
import type { ClientOwnerContext, ClientRecord } from '../../src/modules/clients/public.ts';
import type { AgencyRecord } from '../../src/modules/agencies/public.ts';

test('workspace lifecycle accepts exactly the legal transitions', () => {
  assert.equal(isLegalWorkspaceTransition('active', 'disabled'), true, 'disable');
  assert.equal(isLegalWorkspaceTransition('active', 'deleted'), true, 'delete');
  assert.equal(isLegalWorkspaceTransition('disabled', 'active'), true, 're-enable');
  assert.equal(isLegalWorkspaceTransition('disabled', 'deleted'), true, 'delete from disabled');
});

test('workspace lifecycle rejects every illegal transition', () => {
  // No self-transitions (CAS + explicit lifecycle only).
  assert.equal(isLegalWorkspaceTransition('active', 'active'), false);
  assert.equal(isLegalWorkspaceTransition('disabled', 'disabled'), false);
  // Deleted is TERMINAL — no resurrection from a tombstone.
  assert.equal(isLegalWorkspaceTransition('deleted', 'active'), false, 'resurrect to active');
  assert.equal(isLegalWorkspaceTransition('deleted', 'disabled'), false, 'resurrect to disabled');
  assert.equal(isLegalWorkspaceTransition('deleted', 'deleted'), false, 're-delete');
});

test('the transition table itself is frozen (statuses and terminal shape)', () => {
  assert.deepEqual([...Object.keys(WORKSPACE_TRANSITIONS)].sort(), [
    'active',
    'deleted',
    'disabled',
  ]);
  assert.deepEqual([...WORKSPACE_TRANSITIONS.deleted], [], 'deleted has no outgoing transitions');
  assert.deepEqual([...WORKSPACE_TRANSITIONS.active].sort(), ['deleted', 'disabled']);
  assert.deepEqual([...WORKSPACE_TRANSITIONS.disabled].sort(), ['active', 'deleted']);
});

const workspace: WorkspaceRecord = {
  workspaceId: '8e07f2aa-9c97-4122-853e-110e5fa075aa',
  clientId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
  name: 'Acme Growth Room',
  slug: 'acme-growth-room',
  status: 'active',
  createdBy: 'a3a3a3a3-1111-2222-3333-444444444444',
  version: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

const client: ClientRecord = {
  clientId: workspace.clientId,
  agencyId: '0d8f6c21-31fd-4a3e-90ad-3fd1a1b2c3d4',
  name: 'Acme Retail',
  slug: 'acme-retail',
  status: 'active',
  createdBy: 'a3a3a3a3-1111-2222-3333-444444444444',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const agency: AgencyRecord = {
  agencyId: client.agencyId,
  name: 'Acme Agency',
  slug: 'acme-agency',
  status: 'active',
  createdBy: null,
  version: 3,
  createdAt: '2025-12-01T00:00:00.000Z',
  updatedAt: '2025-12-01T00:00:00.000Z',
};

const clientOwnership: ClientOwnerContext = {
  scope: { kind: 'client', agencyId: agency.agencyId, clientId: client.clientId },
  client,
  agency: {
    agencyId: agency.agencyId,
    slug: agency.slug,
    status: agency.status,
  },
  resolvedAt: '2026-06-01T11:00:00.000Z',
};

test('composeWorkspaceOwnerContext produces the canonical workspace-scoped owner context (AC-02)', () => {
  const resolvedAt = '2026-06-01T12:00:00.000Z';
  const ownership = composeWorkspaceOwnerContext(workspace, clientOwnership, resolvedAt);

  // The one canonical scope: this Workspace inside its owning Client inside
  // the owning Agency — every level derived from durable rows, none from
  // caller claims.
  assert.deepEqual(ownership.scope, {
    kind: 'workspace',
    agencyId: agency.agencyId,
    clientId: client.clientId,
    workspaceId: workspace.workspaceId,
  });
  // Durable workspace identity + ownership verbatim from the workspace row.
  assert.equal(ownership.workspace.workspaceId, workspace.workspaceId);
  assert.equal(ownership.workspace.clientId, client.clientId);
  assert.equal(ownership.workspace.status, 'active');
  // The Client ownership chain is carried through unchanged (/clients stays
  // the canonical Client owner resolution — no re-derivation here).
  assert.deepEqual(ownership.clientOwnership, clientOwnership);
  assert.equal(ownership.client.clientId, client.clientId);
  assert.equal(ownership.resolvedAt, resolvedAt);
});

test('composeWorkspaceOwnerContext is pure — the source records are never mutated', () => {
  const workspaceCopy: WorkspaceRecord = { ...workspace };
  const ownershipCopy: ClientOwnerContext = {
    ...clientOwnership,
    scope: { ...clientOwnership.scope },
    client: { ...clientOwnership.client },
    agency: { ...clientOwnership.agency },
  };
  composeWorkspaceOwnerContext(workspaceCopy, ownershipCopy, '2026-06-01T12:00:00.000Z');
  assert.deepEqual(workspaceCopy, workspace);
  assert.deepEqual(ownershipCopy, clientOwnership);
});
