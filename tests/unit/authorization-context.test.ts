/**
 * Unit tests: canonical authorization-context composition (MKT-002-AC-04).
 *
 * composeAuthorizationContext is the pure core of server-side role resolution:
 * it derives the per-request AuthorizationContext from a durable user record
 * and the user's memberships-with-agency read model. These tests use plain
 * fixtures (no DB) to prove: revoked memberships are excluded (terminal
 * history is not a grant) while active/disabled memberships are included;
 * field mapping is exact; platformRoles pass through in order; resolvedAt is
 * deterministically injected; inputs are never mutated; and a disabled user
 * still resolves (the composer is pure — enforcement happens upstream).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeAuthorizationContext,
  type AuthorizationContext,
  type MembershipWithAgency,
  type MembershipStatus,
  type AgencyRoleKey,
} from '../../src/modules/agencies/public.ts';
import type { UserRecord, PlatformRoleKey, UserStatus } from '../../src/modules/users/public.ts';

const USER_ID = '0192f6c0-0000-7000-8000-000000000001';
const ACME_AGENCY_ID = '0192f6c1-0000-7000-8000-0000000000a1';
const GLOBEX_AGENCY_ID = '0192f6c1-0000-7000-8000-0000000000b2';
const RESOLVED_AT = '2026-01-15T10:30:00.000Z';

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: USER_ID,
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    status: 'active',
    platformRoles: [],
    version: 3,
    createdAt: '2026-01-02T09:00:00.000Z',
    updatedAt: '2026-01-10T12:00:00.000Z',
    ...overrides,
  };
}

function makeMembership(
  role: AgencyRoleKey,
  status: MembershipStatus,
  overrides: Partial<MembershipWithAgency> = {},
): MembershipWithAgency {
  return {
    membershipId: '0192f6c2-0000-7000-8000-000000000011',
    agencyId: ACME_AGENCY_ID,
    userId: USER_ID,
    role,
    status,
    version: 1,
    createdAt: '2026-01-03T10:00:00.000Z',
    updatedAt: '2026-01-11T10:00:00.000Z',
    revokedAt: null,
    agencySlug: 'acme-co',
    agencyStatus: 'active',
    ...overrides,
  };
}

/** One membership per interesting case: active, disabled, revoked, and two agencies. */
function fixtureMemberships(): MembershipWithAgency[] {
  return [
    // Agency A (acme-co, active): owner membership that is active.
    makeMembership('agency_owner', 'active', {
      membershipId: '0192f6c2-0000-7000-8000-000000000011',
    }),
    // Agency A (acme-co, active): operator membership that is disabled.
    makeMembership('agency_operator', 'disabled', {
      membershipId: '0192f6c2-0000-7000-8000-000000000012',
    }),
    // Agency B (globex, disabled): revoked human_agent membership — terminal history.
    makeMembership('human_agent', 'revoked', {
      membershipId: '0192f6c2-0000-7000-8000-000000000013',
      agencyId: GLOBEX_AGENCY_ID,
      agencySlug: 'globex',
      agencyStatus: 'disabled',
      revokedAt: '2026-01-12T08:00:00.000Z',
      version: 4,
    }),
    // Agency B (globex, disabled): active client_collaborator membership.
    makeMembership('client_collaborator', 'active', {
      membershipId: '0192f6c2-0000-7000-8000-000000000014',
      agencyId: GLOBEX_AGENCY_ID,
      agencySlug: 'globex',
      agencyStatus: 'disabled',
      version: 2,
    }),
  ];
}

test('revoked memberships are excluded; active and disabled memberships are included', () => {
  const memberships = fixtureMemberships();
  const context: AuthorizationContext = composeAuthorizationContext(makeUser(), memberships, RESOLVED_AT);

  assert.equal(context.memberships.length, 3, 'only the three non-revoked memberships survive');
  assert.deepEqual(
    context.memberships.map((membership) => membership.membershipId),
    [memberships[0]?.membershipId, memberships[1]?.membershipId, memberships[3]?.membershipId],
  );
  for (const membership of context.memberships) {
    assert.notEqual(membership.membershipStatus, 'revoked', 'a revoked membership is never a grant');
  }
});

test('each context membership maps exactly the authorization fields of its source row', () => {
  const memberships = fixtureMemberships();
  const context = composeAuthorizationContext(makeUser(), memberships, RESOLVED_AT);

  const expectedEntries = [
    {
      membershipId: '0192f6c2-0000-7000-8000-000000000011',
      agencyId: ACME_AGENCY_ID,
      agencySlug: 'acme-co',
      agencyStatus: 'active',
      role: 'agency_owner',
      membershipStatus: 'active',
    },
    {
      membershipId: '0192f6c2-0000-7000-8000-000000000012',
      agencyId: ACME_AGENCY_ID,
      agencySlug: 'acme-co',
      agencyStatus: 'active',
      role: 'agency_operator',
      membershipStatus: 'disabled',
    },
    {
      membershipId: '0192f6c2-0000-7000-8000-000000000014',
      agencyId: GLOBEX_AGENCY_ID,
      agencySlug: 'globex',
      agencyStatus: 'disabled',
      role: 'client_collaborator',
      membershipStatus: 'active',
    },
  ];

  assert.equal(context.memberships.length, expectedEntries.length);
  for (const expected of expectedEntries) {
    const entry = context.memberships.find((candidate) => candidate.membershipId === expected.membershipId);
    assert.ok(entry, `membership ${expected.membershipId} must be present in the context`);
    assert.deepEqual(entry, expected);
    // Only the six authorization fields are exposed — no userId/version/
    // timestamps/revokedAt leakage into the authorization read model.
    assert.deepEqual(
      [...Object.keys(entry)].sort(),
      ['agencyId', 'agencySlug', 'agencyStatus', 'membershipId', 'membershipStatus', 'role'],
    );
  }
});

test('platformRoles pass through exactly, order preserved, including the empty case', () => {
  const orderedRoles: readonly PlatformRoleKey[] = ['platform_developer', 'platform_administrator'];
  const withRoles = composeAuthorizationContext(
    makeUser({ platformRoles: orderedRoles }),
    fixtureMemberships(),
    RESOLVED_AT,
  );
  assert.deepEqual(withRoles.platformRoles, ['platform_developer', 'platform_administrator']);

  const withoutRoles = composeAuthorizationContext(makeUser(), [], RESOLVED_AT);
  assert.deepEqual(withoutRoles.platformRoles, []);
  assert.ok(Array.isArray(withoutRoles.platformRoles), 'platformRoles must be an array, not undefined');
});

test('the principal block carries the user identity with kind "user"', () => {
  const user = makeUser({
    userId: USER_ID,
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    status: 'active',
  });
  const context = composeAuthorizationContext(user, fixtureMemberships(), RESOLVED_AT);

  assert.deepEqual(context.principal, {
    kind: 'user',
    userId: USER_ID,
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    status: 'active',
  });
});

test('resolvedAt is the exact injected string (deterministic resolution time)', () => {
  const memberships = fixtureMemberships();
  const atFirst = composeAuthorizationContext(makeUser(), memberships, RESOLVED_AT);
  assert.equal(atFirst.resolvedAt, RESOLVED_AT);

  const otherInstant = '2026-02-01T00:00:00.000Z';
  const atSecond = composeAuthorizationContext(makeUser(), memberships, otherInstant);
  assert.equal(atSecond.resolvedAt, otherInstant);
});

test('the composer does not mutate its inputs', () => {
  const memberships = fixtureMemberships();
  const user = makeUser({ platformRoles: ['platform_administrator'] });
  const membershipsSnapshot = structuredClone(memberships);
  const userSnapshot = structuredClone(user);

  // Frozen input array: any attempted mutation would throw loudly in strict mode.
  const context = composeAuthorizationContext(user, Object.freeze(memberships), RESOLVED_AT);
  assert.equal(context.memberships.length, 3);

  assert.deepEqual(memberships, membershipsSnapshot, 'the membership input array must be untouched');
  assert.deepEqual(user, userSnapshot, 'the user record must be untouched');
});

test('an empty membership list resolves to an empty memberships array', () => {
  const context = composeAuthorizationContext(makeUser(), [], RESOLVED_AT);
  assert.ok(Array.isArray(context.memberships));
  assert.deepEqual(context.memberships, []);
  // The rest of the context still resolves fully.
  assert.equal(context.principal.kind, 'user');
  assert.equal(context.resolvedAt, RESOLVED_AT);
});

test('a disabled user still resolves: the composer is pure, enforcement is upstream', () => {
  const disabledStatus: UserStatus = 'disabled';
  const user = makeUser({ status: disabledStatus });
  const context = composeAuthorizationContext(user, fixtureMemberships(), RESOLVED_AT);

  assert.equal(context.principal.status, 'disabled', 'account status is carried in the context, not filtered');
  assert.equal(context.principal.kind, 'user');
  assert.equal(context.memberships.length, 3, 'memberships still resolve for a disabled user');
});
