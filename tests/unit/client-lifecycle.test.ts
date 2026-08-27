/**
 * MKT-003 unit tests — Client lifecycle transition table and the canonical
 * owner-context composition (pure functions, no database).
 *
 *   - the frozen Client lifecycle (active ⇄ disabled → deleted terminal)
 *     accepts exactly the legal transitions and rejects every illegal one,
 *     including every resurrection from `deleted` (issue #9 MKT-003-AC-03:
 *     "deleted/revoked relationships cannot be resurrected by replaying
 *     stale identifiers");
 *   - composeClientOwnerContext produces the ONE canonical server-side owner
 *     context for Client-scoped operations (MKT-003-AC-01): client-scoped
 *     `scope`, durable client identity/ownership and the owning agency —
 *     derived from the inputs only, never from caller claims.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_TRANSITIONS,
  composeClientOwnerContext,
  isLegalClientTransition,
  type ClientRecord,
} from '../../src/modules/clients/public.ts';
import type { AgencyRecord } from '../../src/modules/agencies/public.ts';

test('client lifecycle accepts exactly the legal transitions', () => {
  assert.equal(isLegalClientTransition('active', 'disabled'), true, 'disable');
  assert.equal(isLegalClientTransition('active', 'deleted'), true, 'delete');
  assert.equal(isLegalClientTransition('disabled', 'active'), true, 're-enable');
  assert.equal(isLegalClientTransition('disabled', 'deleted'), true, 'delete from disabled');
});

test('client lifecycle rejects every illegal transition', () => {
  // No self-transitions (CAS + explicit lifecycle only).
  assert.equal(isLegalClientTransition('active', 'active'), false);
  assert.equal(isLegalClientTransition('disabled', 'disabled'), false);
  // Deleted is TERMINAL — no resurrection from a tombstone.
  assert.equal(isLegalClientTransition('deleted', 'active'), false, 'resurrect to active');
  assert.equal(isLegalClientTransition('deleted', 'disabled'), false, 'resurrect to disabled');
  assert.equal(isLegalClientTransition('deleted', 'deleted'), false, 're-delete');
  // No "undisable-by-profile" shortcut shape either.
});

test('the transition table itself is frozen (statuses and terminal shape)', () => {
  assert.deepEqual([...Object.keys(CLIENT_TRANSITIONS)].sort(), ['active', 'deleted', 'disabled']);
  assert.deepEqual([...CLIENT_TRANSITIONS.deleted], [], 'deleted has no outgoing transitions');
  assert.deepEqual([...CLIENT_TRANSITIONS.active].sort(), ['deleted', 'disabled']);
  assert.deepEqual([...CLIENT_TRANSITIONS.disabled].sort(), ['active', 'deleted']);
});

const client: ClientRecord = {
  clientId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
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

test('composeClientOwnerContext produces the canonical client-scoped owner context (AC-01)', () => {
  const resolvedAt = '2026-06-01T12:00:00.000Z';
  const ownership = composeClientOwnerContext(client, agency, resolvedAt);

  // The one canonical scope: this Client inside its owning Agency.
  assert.deepEqual(ownership.scope, {
    kind: 'client',
    agencyId: agency.agencyId,
    clientId: client.clientId,
  });
  // Durable client identity + ownership verbatim from the client row.
  assert.equal(ownership.client.clientId, client.clientId);
  assert.equal(ownership.client.agencyId, agency.agencyId);
  assert.equal(ownership.client.status, 'active');
  // Owning agency resolved server-side (slug/status snapshot).
  assert.deepEqual(ownership.agency, {
    agencyId: agency.agencyId,
    slug: agency.slug,
    status: agency.status,
  });
  assert.equal(ownership.resolvedAt, resolvedAt);
});

test('composeClientOwnerContext is pure — the source records are never mutated', () => {
  const clientCopy: ClientRecord = { ...client };
  const agencyCopy: AgencyRecord = { ...agency };
  composeClientOwnerContext(clientCopy, agencyCopy, '2026-06-01T12:00:00.000Z');
  assert.deepEqual(clientCopy, client);
  assert.deepEqual(agencyCopy, agency);
});
