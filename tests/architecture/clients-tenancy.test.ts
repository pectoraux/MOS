/**
 * MKT-003 static tests — the Client tenancy model is structurally correct in
 * the ACTUAL migration and module contract (pure static analysis, no DB).
 *
 * Proofs (issue #9 TENANT-AC-02 / MKT-003-AC-02/03, spec/tenant-runtime-model
 * "Client | Agency | hard data/security tenant"):
 *   1. migration 003 creates `clients` with the required contract fields:
 *      immutable opaque id, Agency ownership reference, lifecycle status,
 *      version CAS, server-derived timestamps + provenance;
 *   2. Client ownership is EXACTLY the agency_id foreign key — no owner/role/
 *      user columns on clients, and no client_id column on agencies/users
 *      (ownership never flows upward past the boundary; role assignment
 *      stays in the MKT-002 assignment tables);
 *   3. the migration status CHECK enumerates the same lifecycle as the code
 *      CLIENT_TRANSITIONS table (persistence can never drift from code);
 *   4. the (agency_id, slug) uniqueness fence is PARTIAL (live clients only)
 *      and per-agency — per-tenant uniqueness, tombstones excluded;
 *   5. the identity/ownership/provenance IMMUTABILITY trigger exists
 *      (client_id, agency_id, created_by, created_at can never be reassigned
 *      through ANY update path — TENANT-AC-02);
 *   6. the deleted-terminal trigger exists (tombstones never resurrect);
 *   7. the /clients public contract exposes the canonical owner-context
 *      resolution surface and imports only allowed authorities.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_TRANSITIONS,
  composeClientOwnerContext,
  isLegalClientTransition,
} from '../../src/modules/clients/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration003 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '003_clients.sql'),
  'utf8',
);
const migration002 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '002_identity_agencies.sql'),
  'utf8',
);
const clientsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'clients', 'public.ts'),
  'utf8',
);

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf(');', start);
  assert.ok(end > start, `${table} block must terminate`);
  return migration.slice(start, end);
}

function columnsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

test('the clients table carries the required tenancy contract fields (TENANT-AC-02)', () => {
  const columns = columnsOf(createTableBlock(migration003, 'clients'));
  for (const required of [
    'client_id', // immutable opaque identifier (server-generated)
    'agency_id', // Agency ownership reference (FK)
    'name',
    'slug',
    'status', // lifecycle
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `clients.${required} required`);
  }
  // Server-generated identity + ownership FK backstop.
  assert.ok(
    migration003.includes('agency_id   uuid        NOT NULL REFERENCES agencies(agency_id)'),
    'agency ownership must be a NOT NULL FK to agencies',
  );
});

test('Client ownership is exactly the agency_id FK — no conflation in either direction', () => {
  // clients has NO owner/role/user columns beyond agency_id + provenance.
  const clientsColumns = columnsOf(createTableBlock(migration003, 'clients'));
  for (const column of clientsColumns) {
    if (column === 'agency_id' || column === 'created_by') continue; // ownership + provenance
    assert.ok(
      !/owner|role|user|admin/.test(column),
      `clients must not carry ownership/role/user columns (found '${column}')`,
    );
  }
  // created_by is provenance ONLY — it is not an ownership/authorization column
  // (documented; enforcement is that no route/module reads it for authorization).
  assert.ok(
    migration003.includes('created_by  uuid        REFERENCES users(user_id)'),
    'created_by is a nullable provenance reference',
  );

  // Ownership never flows UPWARD: agencies/users gain no client reference.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'agencies'], // 003 must not touch the frozen 002 tables
    [migration003, 'users'],
  ] as const) {
    if (migration === migration003) {
      assert.ok(!createTableBlockSafe(migration, table), '003 must not redefine 002 tables');
      continue;
    }
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/client/.test(column),
        `${table}.${column} — tenant ownership must not leak above the Client boundary`,
      );
    }
  }
});

function createTableBlockSafe(migration: string, table: string): boolean {
  return migration.includes(`CREATE TABLE IF NOT EXISTS ${table} (`);
}

test('the migration status CHECK and the code transition table describe ONE lifecycle', () => {
  const clientsBlock = createTableBlock(migration003, 'clients');
  assert.ok(
    clientsBlock.includes("'active', 'disabled', 'deleted'"),
    'client status CHECK must cover active/disabled/deleted',
  );
  assert.deepEqual(
    [...Object.keys(CLIENT_TRANSITIONS)].sort(),
    ['active', 'deleted', 'disabled'],
    'code transition table statuses match the DB CHECK',
  );
  assert.equal(isLegalClientTransition('deleted', 'active'), false, 'deleted is terminal in code');
  assert.equal(CLIENT_TRANSITIONS.deleted.length, 0, 'no outgoing transitions from deleted');
});

test('per-tenant slug uniqueness is a partial-unique DB fence over live clients (AC-02)', () => {
  assert.ok(
    migration003.includes('clients_agency_slug_fence'),
    'the client uniqueness fence index must exist',
  );
  assert.ok(
    migration003.includes('ON clients (agency_id, slug) WHERE status IN'),
    'the fence must be scoped to (agency_id, slug)',
  );
  assert.ok(
    migration003.includes("('active', 'disabled')"),
    'the fence must exclude deleted tombstones',
  );
});

test('Client identity, ownership and provenance are DB-backstopped immutable (TENANT-AC-02)', () => {
  assert.ok(
    migration003.includes('clients_identity_immutable'),
    'the identity/ownership immutability trigger must exist',
  );
  const triggerBody = migration003.slice(
    migration003.indexOf('CREATE OR REPLACE FUNCTION clients_identity_immutable'),
    migration003.indexOf('$$ LANGUAGE plpgsql;', migration003.indexOf('clients_identity_immutable')),
  );
  assert.ok(triggerBody.includes('NEW.client_id <> OLD.client_id'), 'client_id immutability');
  assert.ok(triggerBody.includes('NEW.agency_id <> OLD.agency_id'), 'agency ownership immutability');
  assert.ok(
    triggerBody.includes('NEW.created_at <> OLD.created_at'),
    'created_at immutability',
  );
  assert.ok(
    triggerBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'),
    'created_by immutability',
  );
});

test('deleted Clients are terminal tombstones in the database (MKT-003-AC-03)', () => {
  assert.ok(
    migration003.includes('clients_deleted_terminal'),
    'the deleted-terminal trigger must exist',
  );
  assert.ok(
    migration003.includes("OLD.status = 'deleted' AND NEW.status <> 'deleted'"),
    'the terminal backstop must reject every resurrection attempt',
  );
});

test('the /clients public contract exposes canonical owner resolution over allowed dependencies only', () => {
  // Canonical owner-context surface (MKT-003-AC-01).
  assert.ok(
    clientsPublic.includes('export interface ClientOwnerContext'),
    'ClientOwnerContext must be part of the public contract',
  );
  assert.ok(
    clientsPublic.includes('resolveClientOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    clientsPublic.includes("kind: 'client'"),
    'the owner context must carry the client-scoped OwnerScope shape',
  );
  assert.ok(
    typeof composeClientOwnerContext === 'function',
    'the pure composer must be exported',
  );

  // Dependency matrix: /clients ──→ /agencies, /auth (+ platform shared
  // kernel). The public entry must not import any other module.
  const imports = [...clientsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['agencies'],
    'public.ts may only import /agencies among module publics (matrix: /clients → /agencies, /auth; /auth is not needed directly)',
  );
  for (const forbidden of ['workspaces', 'users', 'goals', 'playbooks']) {
    assert.ok(
      !imports.includes(forbidden),
      `/clients must not depend on /${forbidden} (frozen matrix)`,
    );
  }
});
