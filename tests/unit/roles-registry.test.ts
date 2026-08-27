/**
 * Unit tests: frozen initial role model (MKT-002 / issue #6 MKT-002-AC-03).
 *
 * Proves that the platform-scoped registry (/users public) and the
 * agency-scoped registry (/agencies public) together represent exactly the
 * seven frozen roles of spec/architecture.md §5, that each definition carries
 * its frozen label, scope and description, and — structurally — that role
 * assignment is orthogonal to tenant ownership (§5): no key appears in both
 * scopes and no registry leaks a role of the other scope.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_ROLE_DEFINITIONS,
  PLATFORM_ROLE_KEYS,
  type PlatformRoleKey,
} from '../../src/modules/users/public.ts';
import {
  AGENCY_ROLE_DEFINITIONS,
  AGENCY_ROLE_KEYS,
  type AgencyRoleKey,
} from '../../src/modules/agencies/public.ts';

interface ExpectedRole {
  readonly key: string;
  readonly label: string;
  readonly scope: 'platform' | 'agency';
}

/** The two platform-scoped roles owned by the /users module (§5, AC-03). */
const EXPECTED_PLATFORM_ROLES: ReadonlyArray<ExpectedRole> = [
  { key: 'platform_administrator', label: 'Platform Administrator', scope: 'platform' },
  { key: 'platform_developer', label: 'Platform Developer/Extension Publisher', scope: 'platform' },
];

/** The five agency-scoped roles owned by the /agencies module (§5, AC-03). */
const EXPECTED_AGENCY_ROLES: ReadonlyArray<ExpectedRole> = [
  { key: 'agency_owner', label: 'Agency Owner', scope: 'agency' },
  { key: 'agency_admin', label: 'Agency Admin', scope: 'agency' },
  { key: 'agency_operator', label: 'Agency Operator/Strategist', scope: 'agency' },
  { key: 'client_collaborator', label: 'Client Collaborator', scope: 'agency' },
  { key: 'human_agent', label: 'Human Agent/Field Agent', scope: 'agency' },
];

/** All seven frozen roles across both scopes (union must equal this set). */
const EXPECTED_ALL_KEYS: ReadonlyArray<string> = [...EXPECTED_PLATFORM_ROLES, ...EXPECTED_AGENCY_ROLES].map(
  (role) => role.key,
);

test('PLATFORM_ROLE_KEYS is exactly the two platform-scoped roles', () => {
  assert.equal(PLATFORM_ROLE_KEYS.length, 2);
  assert.deepEqual(
    [...PLATFORM_ROLE_KEYS].sort(),
    EXPECTED_PLATFORM_ROLES.map((role) => role.key).sort(),
    'platform key set must equal {platform_administrator, platform_developer}',
  );
});

test('AGENCY_ROLE_KEYS is exactly the five agency-scoped roles', () => {
  assert.equal(AGENCY_ROLE_KEYS.length, 5);
  assert.deepEqual(
    [...AGENCY_ROLE_KEYS].sort(),
    EXPECTED_AGENCY_ROLES.map((role) => role.key).sort(),
    'agency key set must equal the five frozen agency roles',
  );
});

test('the two registries union to exactly the seven frozen roles — no duplicates, no extras, none missing', () => {
  const union = [...PLATFORM_ROLE_KEYS, ...AGENCY_ROLE_KEYS];
  const distinct = new Set<string>(union);

  assert.equal(distinct.size, 7, 'exactly seven distinct role keys must exist');
  assert.equal(union.length, 7, 'no role key may appear in both registries');
  assert.deepEqual(
    [...distinct].sort(),
    [...EXPECTED_ALL_KEYS].sort(),
    'union must equal the seven frozen §5 roles',
  );

  // Direction-wise: every expected key is present, and nothing else is.
  for (const key of EXPECTED_ALL_KEYS) {
    assert.ok(distinct.has(key), `frozen role "${key}" must be represented by a registry`);
  }
});

test('every platform role definition carries the frozen label, platform scope and a description', () => {
  assert.equal(PLATFORM_ROLE_DEFINITIONS.length, EXPECTED_PLATFORM_ROLES.length);

  for (const expected of EXPECTED_PLATFORM_ROLES) {
    const definition = PLATFORM_ROLE_DEFINITIONS.find((candidate) => candidate.key === expected.key);
    assert.ok(definition, `platform role "${expected.key}" must have a definition`);
    assert.equal(definition.label, expected.label);
    assert.equal(definition.scope, 'platform');
    assert.ok(
      typeof definition.description === 'string' && definition.description.trim().length > 0,
      `platform role "${expected.key}" must carry a non-empty description`,
    );
  }
});

test('every agency role definition carries the frozen label, agency scope and a description', () => {
  assert.equal(AGENCY_ROLE_DEFINITIONS.length, EXPECTED_AGENCY_ROLES.length);

  for (const expected of EXPECTED_AGENCY_ROLES) {
    const definition = AGENCY_ROLE_DEFINITIONS.find((candidate) => candidate.key === expected.key);
    assert.ok(definition, `agency role "${expected.key}" must have a definition`);
    assert.equal(definition.label, expected.label);
    assert.equal(definition.scope, 'agency');
    assert.ok(
      typeof definition.description === 'string' && definition.description.trim().length > 0,
      `agency role "${expected.key}" must carry a non-empty description`,
    );
  }
});

test('each KEYS export mirrors its DEFINITIONS registry exactly', () => {
  assert.deepEqual(
    PLATFORM_ROLE_KEYS,
    PLATFORM_ROLE_DEFINITIONS.map((definition) => definition.key),
    'PLATFORM_ROLE_KEYS must mirror PLATFORM_ROLE_DEFINITIONS',
  );
  assert.deepEqual(
    AGENCY_ROLE_KEYS,
    AGENCY_ROLE_DEFINITIONS.map((definition) => definition.key),
    'AGENCY_ROLE_KEYS must mirror AGENCY_ROLE_DEFINITIONS',
  );
});

test('role assignment is orthogonal to tenant ownership: scopes share no role key', () => {
  const platformKeySet = new Set<string>(PLATFORM_ROLE_KEYS);
  const agencyKeySet = new Set<string>(AGENCY_ROLE_KEYS);

  for (const key of platformKeySet) {
    assert.ok(!agencyKeySet.has(key), `platform role "${key}" must not also be an agency role`);
  }
  for (const key of agencyKeySet) {
    assert.ok(!platformKeySet.has(key), `agency role "${key}" must not also be a platform role`);
  }

  // And within/across the registries no key equals another (all seven pairwise distinct).
  const allKeys = [...PLATFORM_ROLE_KEYS, ...AGENCY_ROLE_KEYS];
  assert.equal(new Set(allKeys).size, allKeys.length, 'all role keys must be pairwise distinct');

  // Structural orthogonality also holds per-definition: scope is never mixed.
  for (const definition of PLATFORM_ROLE_DEFINITIONS) {
    assert.equal(definition.scope, 'platform');
  }
  for (const definition of AGENCY_ROLE_DEFINITIONS) {
    assert.equal(definition.scope, 'agency');
  }
});

test('role key registries are exposed as read-only arrays (compile-time contract)', () => {
  // The exports are consumed as ReadonlyArray here: if the modules ever expose
  // a mutable array of role keys, the compiler still accepts it, but this test
  // pins the runtime view alongside the readonly type usage.
  const platformKeys: readonly PlatformRoleKey[] = PLATFORM_ROLE_KEYS;
  const agencyKeys: readonly AgencyRoleKey[] = AGENCY_ROLE_KEYS;

  assert.ok(Array.isArray(platformKeys));
  assert.ok(Array.isArray(agencyKeys));
  assert.equal(platformKeys.length, 2);
  assert.equal(agencyKeys.length, 5);
});
