/**
 * Unit tests: membership lifecycle transition table (MKT-002, issue #6 data
 * contract: active/revoked/disabled membership semantics).
 *
 * Proves the exported table is exactly the frozen lifecycle — active may be
 * disabled or revoked, disabled may be re-activated or revoked, revoked is
 * terminal — and that isLegalMembershipTransition agrees with the table for
 * every one of the 3×3 status pairs (illegal pairs, self-transitions and any
 * transition out of revoked all return false).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBERSHIP_TRANSITIONS,
  isLegalMembershipTransition,
  type MembershipStatus,
} from '../../src/modules/agencies/public.ts';

const STATUSES: readonly MembershipStatus[] = ['active', 'disabled', 'revoked'];

/** The frozen transition table as specified by the MKT-002 data contract. */
const EXPECTED_TRANSITIONS: Readonly<Record<MembershipStatus, readonly MembershipStatus[]>> = {
  active: ['disabled', 'revoked'],
  disabled: ['active', 'revoked'],
  revoked: [],
};

test('MEMBERSHIP_TRANSITIONS is exactly the frozen lifecycle table', () => {
  assert.deepEqual(MEMBERSHIP_TRANSITIONS, {
    active: ['disabled', 'revoked'],
    disabled: ['active', 'revoked'],
    revoked: [],
  });
});

test('the table covers exactly the three membership statuses', () => {
  assert.deepEqual(
    Object.keys(MEMBERSHIP_TRANSITIONS).sort(),
    [...STATUSES].sort(),
    'the table must be keyed by exactly {active, disabled, revoked}',
  );
  // Compile-time readonly contract: consume the export as a Readonly record.
  const table: Readonly<Record<MembershipStatus, readonly MembershipStatus[]>> = MEMBERSHIP_TRANSITIONS;
  for (const status of STATUSES) {
    assert.ok(Array.isArray(table[status]));
  }
});

test('isLegalMembershipTransition matches the table for every one of the 3×3 pairs', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = EXPECTED_TRANSITIONS[from].includes(to);
      assert.equal(
        isLegalMembershipTransition(from, to),
        expected,
        `transition ${from} → ${to} must be ${expected ? 'legal' : 'illegal'}`,
      );
    }
  }
});

test('revoked is terminal: no legal transition out of revoked', () => {
  assert.deepEqual(MEMBERSHIP_TRANSITIONS.revoked, []);
  for (const to of STATUSES) {
    assert.equal(
      isLegalMembershipTransition('revoked', to),
      false,
      `revoked → ${to} must be illegal (revoked is terminal history)`,
    );
  }
});

test('self-transitions are illegal in every status', () => {
  for (const status of STATUSES) {
    assert.equal(
      isLegalMembershipTransition(status, status),
      false,
      `${status} → ${status} must be illegal`,
    );
    assert.ok(
      !MEMBERSHIP_TRANSITIONS[status].includes(status),
      `the table for "${status}" must not contain itself`,
    );
  }
});
