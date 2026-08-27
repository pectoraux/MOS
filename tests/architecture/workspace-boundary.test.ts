/**
 * MKT-004 static tests — the Workspace boundary model is structurally correct
 * in the ACTUAL migration and module contract (pure static analysis, no DB).
 *
 * Proofs (issue #11 MKT-004-AC-01/02/08, TENANT-AC-05, spec/tenant-runtime-model
 * "Workspace | Client | organizational boundary", invariant 2: "Workspace IDs
 * never authorize access outside their Client"):
 *   1. migration 004 creates `workspaces` with the required contract fields:
 *      immutable opaque id, Client ownership reference, lifecycle status,
 *      version CAS, server-derived timestamps + provenance;
 *   2. Workspace ownership is EXACTLY the client_id foreign key — no owner/
 *      role/user columns on workspaces, and no workspace_id column on
 *      clients/agencies/users (the Client→Workspace relationship is stored
 *      ONLY here — never elsewhere as an alternate authority);
 *   3. the migration status CHECK enumerates the same lifecycle as the code
 *      WORKSPACE_TRANSITIONS table (persistence can never drift from code);
 *   4. the (client_id, slug) uniqueness fence is PARTIAL (live workspaces
 *      only) and per-client — per-Client uniqueness, tombstones excluded;
 *   5. the identity/ownership/provenance IMMUTABILITY trigger exists
 *      (workspace_id, client_id, created_by, created_at can never be
 *      reassigned through ANY update path — a Workspace can never cross the
 *      Client boundary);
 *   6. the deleted-terminal trigger exists (tombstones never resurrect);
 *   7. the /workspaces public contract exposes the canonical owner-context
 *      resolution surface and imports ONLY the allowed authority
 *      (/clients — frozen matrix: /workspaces ──→ /clients);
 *   8. no second authorization authority: the workspaces module surface has
 *      no permission/role engine and the API layer composes the SAME
 *      /agencies membership authority through requireClientAccess-style
 *      checks that resolve /clients canonical ownership first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_TRANSITIONS,
  composeWorkspaceOwnerContext,
  isLegalWorkspaceTransition,
} from '../../src/modules/workspaces/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration004 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '004_workspaces.sql'),
  'utf8',
);
const migration002 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '002_identity_agencies.sql'),
  'utf8',
);
const migration003 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '003_clients.sql'),
  'utf8',
);
const workspacesPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'workspaces', 'public.ts'),
  'utf8',
);
const workspacesRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'workspaces-routes.ts'),
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

test('the workspaces table carries the required boundary contract fields (issue #11 data contract)', () => {
  const columns = columnsOf(createTableBlock(migration004, 'workspaces'));
  for (const required of [
    'workspace_id', // immutable opaque identifier (server-generated)
    'client_id', // Client ownership reference (FK)
    'name',
    'slug',
    'status', // lifecycle
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `workspaces.${required} required`);
  }
  // Server-generated identity + Client ownership FK backstop.
  assert.ok(
    migration004.includes('client_id    uuid        NOT NULL REFERENCES clients(client_id)'),
    'Client ownership must be a NOT NULL FK to clients',
  );
});

test('Workspace ownership is exactly the client_id FK — no conflation, no alternate authority', () => {
  // workspaces has NO owner/role/user columns beyond client_id + provenance.
  const workspacesColumns = columnsOf(createTableBlock(migration004, 'workspaces'));
  for (const column of workspacesColumns) {
    if (column === 'client_id' || column === 'created_by') continue; // ownership + provenance
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `workspaces must not carry ownership/role/user columns (found '${column}')`,
    );
  }
  // created_by is provenance ONLY — documented; no route/module reads it for
  // authorization (enforced by construction: the module API never exposes it
  // as an authorization input).
  assert.ok(
    migration004.includes('created_by   uuid        REFERENCES users(user_id)'),
    'created_by is a nullable provenance reference',
  );

  // The Client→Workspace relationship lives ONLY in workspaces.client_id:
  // no workspace_id column leaks upward into clients/agencies/users, and
  // migration 004 must not redefine the earlier frozen tables.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/workspace/.test(column),
        `${table}.${column} — the Client→Workspace relationship must not leak above /workspaces`,
      );
    }
  }
  for (const table of ['agencies', 'users', 'clients']) {
    assert.ok(
      !migration004.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `004 must not redefine the frozen ${table} table`,
    );
  }
  // No new tables beyond workspaces in migration 004 (no permission engine).
  const createdTables = [...migration004.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['workspaces'],
    'migration 004 must create exactly the workspaces table — no second authority structures',
  );
});

test('the migration status CHECK and the code transition table describe ONE lifecycle', () => {
  const workspacesBlock = createTableBlock(migration004, 'workspaces');
  assert.ok(
    workspacesBlock.includes("'active', 'disabled', 'deleted'"),
    'workspace status CHECK must cover active/disabled/deleted',
  );
  assert.deepEqual(
    [...Object.keys(WORKSPACE_TRANSITIONS)].sort(),
    ['active', 'deleted', 'disabled'],
    'code transition table statuses match the DB CHECK',
  );
  assert.equal(isLegalWorkspaceTransition('deleted', 'active'), false, 'deleted is terminal in code');
  assert.equal(WORKSPACE_TRANSITIONS.deleted.length, 0, 'no outgoing transitions from deleted');
});

test('per-Client slug uniqueness is a partial-unique DB fence over live workspaces (AC-07)', () => {
  assert.ok(
    migration004.includes('workspaces_client_slug_fence'),
    'the workspace uniqueness fence index must exist',
  );
  assert.ok(
    migration004.includes('ON workspaces (client_id, slug) WHERE status IN'),
    'the fence must be scoped to (client_id, slug)',
  );
  assert.ok(
    migration004.includes("('active', 'disabled')"),
    'the fence must exclude deleted tombstones',
  );
});

test('Workspace identity, Client ownership and provenance are DB-backstopped immutable (AC-01)', () => {
  assert.ok(
    migration004.includes('workspaces_identity_immutable'),
    'the identity/ownership immutability trigger must exist',
  );
  const triggerBody = migration004.slice(
    migration004.indexOf('CREATE OR REPLACE FUNCTION workspaces_identity_immutable'),
    migration004.indexOf('$$ LANGUAGE plpgsql;', migration004.indexOf('workspaces_identity_immutable')),
  );
  assert.ok(triggerBody.includes('NEW.workspace_id <> OLD.workspace_id'), 'workspace_id immutability');
  assert.ok(triggerBody.includes('NEW.client_id <> OLD.client_id'), 'Client ownership immutability');
  assert.ok(
    triggerBody.includes('NEW.created_at <> OLD.created_at'),
    'created_at immutability',
  );
  assert.ok(
    triggerBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'),
    'created_by immutability',
  );
});

test('deleted Workspaces are terminal tombstones in the database (AC-06)', () => {
  assert.ok(
    migration004.includes('workspaces_deleted_terminal'),
    'the deleted-terminal trigger must exist',
  );
  assert.ok(
    migration004.includes("OLD.status = 'deleted' AND NEW.status <> 'deleted'"),
    'the terminal backstop must reject every resurrection attempt',
  );
});

test('the /workspaces public contract exposes canonical owner resolution over allowed dependencies only', () => {
  // Canonical owner-context surface (MKT-004-AC-02).
  assert.ok(
    workspacesPublic.includes('export interface WorkspaceOwnerContext'),
    'WorkspaceOwnerContext must be part of the public contract',
  );
  assert.ok(
    workspacesPublic.includes('resolveWorkspaceOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    workspacesPublic.includes("kind: 'workspace'"),
    'the owner context must carry the workspace-scoped OwnerScope shape',
  );
  assert.ok(
    typeof composeWorkspaceOwnerContext === 'function',
    'the pure composer must be exported',
  );

  // Dependency matrix: /workspaces ──→ /clients ONLY. The public entry must
  // not import any other module.
  const imports = [...workspacesPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['clients'],
    'public.ts may only import /clients among module publics (frozen matrix: /workspaces ──→ /clients)',
  );
  for (const forbidden of ['agencies', 'auth', 'users', 'goals', 'playbooks', 'workflows', 'executions', 'policies']) {
    assert.ok(
      !imports.includes(forbidden),
      `/workspaces must not depend on /${forbidden} (frozen matrix)`,
    );
  }
});

test('no second authorization authority: Workspace routes compose /clients ownership with /agencies membership (AC-08)', () => {
  // The route layer must use the shared authorize helpers (which resolve
  // canonical ownership first) — never a private permission engine.
  assert.ok(
    workspacesRoutes.includes('requireWorkspaceAccess'),
    'workspace routes must authorize through the shared requireWorkspaceAccess helper',
  );
  assert.ok(
    workspacesRoutes.includes('requireClientAccess'),
    'client-scoped workspace routes must authorize through requireClientAccess',
  );
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(workspacesRoutes),
    'workspace routes must not carry a private permission engine',
  );
  // Workspace ownership resolution goes THROUGH /clients canonical owner
  // resolution (the module composes it — never re-derives).
  assert.ok(
    workspacesPublic.includes('resolveClientOwnership'),
    'the workspaces module API documentation must compose /clients resolveClientOwnership',
  );
  // Migration 004 indexes are exactly the tenant fence + live listing index —
  // no permission structures.
  const permissionStructures = [
    ...migration004.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g),
  ].map((match) => match[1]!);
  assert.deepEqual(
    permissionStructures.sort(),
    ['workspaces_client_live_idx', 'workspaces_client_slug_fence'],
    'migration 004 indexes are exactly the tenant fence + live listing index',
  );
});
