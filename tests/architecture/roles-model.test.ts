/**
 * MKT-002-AC-03 — static test: the required initial roles are represented
 * WITHOUT conflating role assignment with tenant ownership.
 *
 * Proofs (pure static analysis of the actual sources — no database needed):
 *   1. The canonical role registries exported by the module public contracts
 *      contain EXACTLY the frozen initial role set (architecture.md §5):
 *      Platform Administrator, Agency Owner, Agency Admin, Agency
 *      Operator/Strategist, Client Collaborator, Human Agent/Field Agent,
 *      Platform Developer/Extension Publisher.
 *   2. The database migration's CHECK constraints enumerate the SAME role
 *      keys as the code registries — the persistence layer can never drift
 *      from the code model.
 *   3. Role assignment is orthogonal to tenant ownership STRUCTURALLY:
 *      - `agencies` has NO owner/role column (ownership = membership role);
 *      - `users` has NO role/admin column (platform roles live only in
 *        user_platform_roles);
 *      - the only `role` columns in the schema are the two assignment tables.
 *   4. Membership lifecycle columns (active/disabled/revoked) and the
 *      revoked-terminal DB backstop exist in the actual migration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENCY_ROLE_DEFINITIONS,
  AGENCY_ROLE_KEYS,
  MEMBERSHIP_TRANSITIONS,
} from '../../src/modules/agencies/public.ts';
import {
  PLATFORM_ROLE_DEFINITIONS,
  PLATFORM_ROLE_KEYS,
} from '../../src/modules/users/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '002_identity_agencies.sql'),
  'utf8',
);

/** Extracts the CREATE TABLE block for `table` from the migration SQL. */
function createTableBlock(table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf(');', start);
  assert.ok(end > start, `migration ${table} block must terminate`);
  return migration.slice(start, end);
}

function columnsOf(block: string): string[] {
  // Column definition lines look like "    name       text        NOT NULL..."
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

test('the frozen initial role set is represented exactly, split by scope', () => {
  // Union of the two registries is exactly the 7 required roles — the
  // issue #6 / architecture.md §5 "at minimum" set for MKT-002.
  const expected = new Set([
    'platform_administrator', // Platform Administrator
    'platform_developer', // Platform Developer/Extension Publisher
    'agency_owner', // Agency Owner
    'agency_admin', // Agency Admin
    'agency_operator', // Agency Operator/Strategist
    'client_collaborator', // Client Collaborator
    'human_agent', // Human Agent/Field Agent
  ]);
  const union = new Set<string>([...PLATFORM_ROLE_KEYS, ...AGENCY_ROLE_KEYS]);
  assert.deepEqual([...union].sort(), [...expected].sort(), 'exact role set representation');

  // Labels preserve the frozen human-readable names.
  const labels = new Map<string, string>();
  for (const definition of [...PLATFORM_ROLE_DEFINITIONS, ...AGENCY_ROLE_DEFINITIONS]) {
    labels.set(definition.key, definition.label);
  }
  assert.equal(labels.get('platform_administrator'), 'Platform Administrator');
  assert.equal(labels.get('platform_developer'), 'Platform Developer/Extension Publisher');
  assert.equal(labels.get('agency_owner'), 'Agency Owner');
  assert.equal(labels.get('agency_admin'), 'Agency Admin');
  assert.equal(labels.get('agency_operator'), 'Agency Operator/Strategist');
  assert.equal(labels.get('client_collaborator'), 'Client Collaborator');
  assert.equal(labels.get('human_agent'), 'Human Agent/Field Agent');

  // Scope split: platform roles attach to user identity, agency roles to
  // memberships — no overlap, no cross-scope leakage.
  for (const definition of PLATFORM_ROLE_DEFINITIONS) {
    assert.equal(definition.scope, 'platform');
  }
  for (const definition of AGENCY_ROLE_DEFINITIONS) {
    assert.equal(definition.scope, 'agency');
  }
  assert.equal(PLATFORM_ROLE_KEYS.length, 2);
  assert.equal(AGENCY_ROLE_KEYS.length, 5);
});

test('the migration CHECK constraints enumerate the same role keys as the code registries', () => {
  const platformBlock = createTableBlock('user_platform_roles');
  const membershipBlock = createTableBlock('agency_memberships');

  for (const key of PLATFORM_ROLE_KEYS) {
    assert.ok(platformBlock.includes(`'${key}'`), `platform role '${key}' must be DB-checkable`);
  }
  // No agency role leaks into the platform table's CHECK.
  for (const key of AGENCY_ROLE_KEYS) {
    assert.ok(!platformBlock.includes(`'${key}'`), `agency role '${key}' must not be a platform role`);
  }
  for (const key of AGENCY_ROLE_KEYS) {
    assert.ok(membershipBlock.includes(`'${key}'`), `agency role '${key}' must be DB-checkable`);
  }
  // No platform role leaks into the membership CHECK.
  for (const key of PLATFORM_ROLE_KEYS) {
    assert.ok(!membershipBlock.includes(`'${key}'`), `platform role '${key}' must not be an agency role`);
  }
});

test('role assignment is orthogonal to tenant ownership (no conflation columns)', () => {
  const agenciesBlock = createTableBlock('agencies');
  const agenciesColumns = columnsOf(agenciesBlock);
  for (const column of agenciesColumns) {
    assert.ok(
      !/owner|admin|role/.test(column),
      `agencies must not carry ownership/role columns (found '${column}') — ownership is the agency_owner membership role`,
    );
  }

  const usersBlock = createTableBlock('users');
  const usersColumns = columnsOf(usersBlock);
  for (const column of usersColumns) {
    assert.ok(
      !/role|admin|owner/.test(column),
      `users must not carry role columns (found '${column}') — platform roles live in user_platform_roles`,
    );
  }

  // The only role columns in the whole schema are the two assignment tables.
  const tables = [
    'users',
    'user_platform_roles',
    'auth_credentials',
    'auth_sessions',
    'agencies',
    'agency_memberships',
  ];
  const roleColumns: string[] = [];
  for (const table of tables) {
    if (table === 'user_platform_roles' || table === 'agency_memberships') continue;
    for (const column of columnsOf(createTableBlock(table))) {
      if (/role/.test(column)) roleColumns.push(`${table}.${column}`);
    }
  }
  assert.deepEqual(roleColumns, [], 'no role column outside the assignment tables');

  // Assignment table shapes: explicit membership identity + ownership refs.
  const membershipColumns = columnsOf(createTableBlock('agency_memberships'));
  for (const required of ['membership_id', 'agency_id', 'user_id', 'role', 'status', 'version']) {
    assert.ok(membershipColumns.includes(required), `agency_memberships.${required} required (AC-02)`);
  }
  const platformRoleColumns = columnsOf(createTableBlock('user_platform_roles'));
  assert.ok(platformRoleColumns.includes('user_id'), 'user_platform_roles.user_id required');
  assert.ok(platformRoleColumns.includes('role'), 'user_platform_roles.role required');
});

test('membership lifecycle persistence supports active/disabled/revoked with a terminal backstop', () => {
  const membershipBlock = createTableBlock('agency_memberships');
  assert.ok(
    membershipBlock.includes("'active', 'disabled', 'revoked'"),
    'membership status CHECK must cover active/disabled/revoked',
  );
  assert.ok(
    migration.includes('agency_memberships_revoked_terminal'),
    'the revoked-terminal DB trigger must exist',
  );
  // The code transition table matches the DB statuses.
  assert.deepEqual(
    [...Object.keys(MEMBERSHIP_TRANSITIONS)].sort(),
    ['active', 'disabled', 'revoked'],
  );
  // Duplicate membership creation is DB-fenced (issue #6 concurrency contract).
  assert.ok(
    migration.includes('agency_memberships_membership_fence'),
    'the membership uniqueness fence index must exist',
  );
  assert.ok(
    migration.includes("WHERE status IN ('active', 'disabled')"),
    'the fence must target non-revoked memberships',
  );
});
