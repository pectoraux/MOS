/**
 * MKT-006 static tests — the Goals domain model is structurally correct in
 * the ACTUAL migration and module contract (pure static analysis, no DB).
 *
 * Proofs (GOAL-001, GOAL-AC-01/02, spec/architecture.md §7 "Goal is the
 * top-level unit of business intent … Goal is not a workflow",
 * spec/tenant-runtime-model.md "Goal | Client | business-intent object",
 * spec/module-dependency-matrix.md "/goals ──→ /clients, /workspaces"):
 *   1. migration 007 creates `goals` with the required contract fields:
 *      immutable opaque id, Client ownership reference, optional Workspace
 *      scope, objective, non-empty jsonb success criteria, metrics,
 *      constraints, time horizon, lifecycle status, provenance, version
 *      CAS, server-derived timestamps;
 *   2. Goal ownership is EXACTLY the client_id FK (plus the optional
 *      workspace_id scope FK) — no owner/role/user columns on goals, and
 *      no goal_id column on clients/workspaces/agencies/users (the
 *      Client→Goal relationship is stored ONLY here — never elsewhere as
 *      an alternate authority);
 *   3. the migration status CHECK enumerates the same lifecycle as the
 *      code GOAL_TRANSITIONS table (persistence can never drift from
 *      code) and the terminal states match;
 *   4. measurable success criteria are DB-fenced (GOAL-AC-01): the
 *      success_criteria CHECK requires a NON-EMPTY array;
 *   5. the identity/scope/provenance IMMUTABILITY trigger exists
 *      (goal_id, client_id, workspace_id-once-set, created_by/created_at
 *      can never be reassigned through ANY update path — a Goal can never
 *      cross the Client boundary, GOAL-AC-02);
 *   6. the terminal-frozen trigger exists (achieved/abandoned history can
 *      never be rewritten);
 *   7. the workspace-within-client scope trigger exists (a workspace
 *      reference outside the owning Client is rejected by the database
 *      itself — the Client boundary cannot be crossed through the
 *      workspace column);
 *   8. the /goals public contract exposes the canonical owner-context
 *      resolution surface and imports ONLY the allowed authorities
 *      (/clients, /workspaces — frozen matrix: /goals ──→ /clients,
 *      /workspaces);
 *   9. no workflow/playbook/execution authority is introduced: the goals
 *      module surface carries no workflow/playbook/execution/deployment
 *      concepts, and the API layer composes the SAME /agencies membership
 *      authority through requireGoalAccess/requireClientAccess-style
 *      checks that resolve canonical ownership first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOAL_TRANSITIONS,
  composeGoalOwnerContext,
  isLegalGoalTransition,
} from '../../src/modules/goals/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration007 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '007_goals.sql'),
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
const migration004 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '004_workspaces.sql'),
  'utf8',
);
const goalsPublic = readFileSync(join(repoRoot, 'src', 'modules', 'goals', 'public.ts'), 'utf8');
const goalsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'goals', 'internal', 'goals-module.ts'),
  'utf8',
);
const goalsRoutes = readFileSync(join(repoRoot, 'src', 'api', 'goals-routes.ts'), 'utf8');

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

test('the goals table carries the required domain contract fields (GOAL-001 data contract)', () => {
  const columns = columnsOf(createTableBlock(migration007, 'goals'));
  for (const required of [
    'goal_id', // immutable opaque identifier (server-generated)
    'client_id', // Client ownership reference (FK) — hard boundary
    'workspace_id', // optional Workspace scope FK (within the Client)
    'objective', // the business objective statement
    'success_criteria', // measurable success criteria (non-empty jsonb array)
    'metrics', // additional observed metrics
    'constraints', // resource/risk/time/other constraints
    'time_horizon', // optional time horizon
    'status', // lifecycle
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `goals.${required} required`);
  }
  // Server-generated identity + Client ownership FK backstop; Workspace
  // scope is an OPTIONAL FK (client-wide goals have NULL scope).
  assert.ok(
    migration007.includes('client_id          uuid        NOT NULL REFERENCES clients(client_id)'),
    'Client ownership must be a NOT NULL FK to clients',
  );
  assert.ok(
    migration007.includes('workspace_id       uuid        REFERENCES workspaces(workspace_id)'),
    'Workspace scope must be a (nullable) FK to workspaces',
  );
});

test('Goal ownership is exactly the client_id FK + optional workspace scope — no conflation, no alternate authority', () => {
  // goals has NO owner/role/user columns beyond client_id + workspace scope
  // + provenance.
  const goalsColumns = columnsOf(createTableBlock(migration007, 'goals'));
  for (const column of goalsColumns) {
    if (column === 'client_id' || column === 'workspace_id' || column === 'created_by') continue;
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `goals must not carry ownership/role/user columns (found '${column}')`,
    );
  }
  // created_by is provenance ONLY — documented; no route/module reads it for
  // authorization (enforced by construction: the module API never exposes it
  // as an authorization input).
  assert.ok(
    migration007.includes('created_by         uuid        REFERENCES users(user_id)'),
    'created_by is a nullable provenance reference',
  );

  // The Client→Goal relationship lives ONLY in goals.client_id: no goal_id
  // column leaks upward into clients/workspaces/agencies/users, and
  // migration 007 must not redefine the earlier frozen tables.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/goal/.test(column),
        `${table}.${column} — the Client→Goal relationship must not leak above /goals`,
      );
    }
  }
  for (const table of ['agencies', 'users', 'clients', 'workspaces']) {
    assert.ok(
      !migration007.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `007 must not redefine the frozen ${table} table`,
    );
  }
  // No new tables beyond goals in migration 007 (no permission engine, no
  // workflow/playbook/execution structures).
  const createdTables = [...migration007.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['goals'],
    'migration 007 must create exactly the goals table — no second authority structures',
  );
});

test('the migration status CHECK and the code transition table describe ONE lifecycle', () => {
  const goalsBlock = createTableBlock(migration007, 'goals');
  assert.ok(
    goalsBlock.includes("'draft', 'active', 'achieved', 'abandoned'"),
    'goal status CHECK must cover draft/active/achieved/abandoned',
  );
  assert.deepEqual(
    [...Object.keys(GOAL_TRANSITIONS)].sort(),
    ['abandoned', 'achieved', 'active', 'draft'],
    'code transition table statuses match the DB CHECK',
  );
  assert.equal(isLegalGoalTransition('achieved', 'active'), false, 'achieved is terminal in code');
  assert.equal(isLegalGoalTransition('abandoned', 'draft'), false, 'abandoned is terminal in code');
  assert.equal(GOAL_TRANSITIONS.achieved.length, 0, 'no outgoing transitions from achieved');
  assert.equal(GOAL_TRANSITIONS.abandoned.length, 0, 'no outgoing transitions from abandoned');
  // The lifecycle carries NO execution semantics (architecture.md §7: "Goal
  // is not a workflow").
  const statusEnumeration = goalsBlock.slice(goalsBlock.indexOf('CHECK (status'));
  for (const executionState of ['running', 'paused', 'queued', 'dispatched', 'blocked']) {
    assert.ok(
      !statusEnumeration.includes(executionState),
      `goal status CHECK must not contain execution state '${executionState}'`,
    );
  }
});

test('measurable success criteria are DB-fenced (GOAL-AC-01 storage backstop)', () => {
  // The CHECK requires a NON-EMPTY jsonb array: a Goal cannot even be
  // persisted without success criteria.
  assert.ok(
    migration007.includes("jsonb_typeof(success_criteria) = 'array'"),
    'success_criteria must be CHECKed to be a jsonb array',
  );
  assert.ok(
    migration007.includes('jsonb_array_length(success_criteria) >= 1'),
    'success_criteria must be CHECKed to be non-empty',
  );
  // metrics / constraints are arrays too.
  assert.ok(
    migration007.includes("jsonb_typeof(metrics) = 'array'"),
    'metrics must be CHECKed to be a jsonb array',
  );
  assert.ok(
    migration007.includes("jsonb_typeof(constraints) = 'array'"),
    'constraints must be CHECKed to be a jsonb array',
  );
});

test('Goal identity, Client ownership, Workspace scope and provenance are DB-backstopped immutable (GOAL-AC-02)', () => {
  assert.ok(
    migration007.includes('goals_identity_immutable'),
    'the identity/scope immutability trigger must exist',
  );
  const triggerBody = migration007.slice(
    migration007.indexOf('CREATE OR REPLACE FUNCTION goals_identity_immutable'),
    migration007.indexOf('$$ LANGUAGE plpgsql;', migration007.indexOf('goals_identity_immutable')),
  );
  assert.ok(triggerBody.includes('NEW.goal_id <> OLD.goal_id'), 'goal_id immutability');
  assert.ok(triggerBody.includes('NEW.client_id <> OLD.client_id'), 'Client ownership immutability');
  assert.ok(
    triggerBody.includes('NEW.workspace_id IS DISTINCT FROM OLD.workspace_id'),
    'Workspace scope immutability (once set — including NULL ⇄ set)',
  );
  assert.ok(
    triggerBody.includes('NEW.created_at <> OLD.created_at'),
    'created_at immutability',
  );
  assert.ok(
    triggerBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'),
    'created_by immutability',
  );
});

test('terminal Goals are frozen business history in the database', () => {
  assert.ok(
    migration007.includes('goals_terminal_frozen'),
    'the terminal-frozen trigger must exist',
  );
  assert.ok(
    migration007.includes("OLD.status IN ('achieved', 'abandoned')"),
    'the freeze must cover both terminal states',
  );
  assert.ok(
    migration007.includes('ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*)'),
    'every content-changing update on a terminal row must be rejected',
  );
});

test('the workspace scope can never cross the Client boundary in the database (GOAL-AC-02 scope backstop)', () => {
  assert.ok(
    migration007.includes('goals_workspace_within_client'),
    'the workspace-within-client trigger must exist',
  );
  const triggerBody = migration007.slice(
    migration007.indexOf('CREATE OR REPLACE FUNCTION goals_workspace_within_client'),
    migration007.indexOf(
      '$$ LANGUAGE plpgsql;',
      migration007.indexOf('goals_workspace_within_client'),
    ),
  );
  assert.ok(
    triggerBody.includes('w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id'),
    'the trigger must require the workspace to belong to the goal client',
  );
  assert.ok(
    migration007.includes('BEFORE INSERT OR UPDATE ON goals'),
    'the scope backstop must fire on INSERT and UPDATE',
  );
});

test('the /goals public contract exposes canonical owner resolution over allowed dependencies only', () => {
  // Canonical owner-context surface.
  assert.ok(
    goalsPublic.includes('export interface GoalOwnerContext'),
    'GoalOwnerContext must be part of the public contract',
  );
  assert.ok(
    goalsPublic.includes('resolveGoalOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    goalsPublic.includes("kind: 'goal'"),
    'the owner context must carry the goal-scoped OwnerScope shape',
  );
  assert.ok(
    typeof composeGoalOwnerContext === 'function',
    'the pure composer must be exported',
  );

  // Dependency matrix: /goals ──→ /clients, /workspaces ONLY. The public
  // entry must not import any other module.
  const imports = [...goalsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['clients', 'workspaces'],
    'public.ts may only import /clients and /workspaces among module publics (frozen matrix: /goals ──→ /clients, /workspaces)',
  );
  for (const forbidden of [
    'agencies',
    'auth',
    'users',
    'playbooks',
    'workflows',
    'executions',
    'deployments',
    'policies',
    'audit',
  ]) {
    assert.ok(
      !imports.includes(forbidden),
      `/goals must not depend on /${forbidden} (frozen matrix)`,
    );
  }
});

test('no workflow/playbook/execution authority and no second authorization authority in the /goals implementation', () => {
  // The module implementation composes /clients + /workspaces canonical
  // ownership — it never re-derives and never invents an authority.
  assert.ok(
    goalsModule.includes('resolveClientOwnership'),
    'the goals module must resolve Client ownership THROUGH /clients',
  );
  assert.ok(
    goalsModule.includes('resolveWorkspaceOwnership'),
    'the goals module must resolve Workspace scope THROUGH /workspaces',
  );
  // The route layer must use the shared authorize helpers (which resolve
  // canonical ownership first) — never a private permission engine.
  assert.ok(
    goalsRoutes.includes('requireGoalAccess'),
    'goal routes must authorize through the shared requireGoalAccess helper',
  );
  assert.ok(
    goalsRoutes.includes('requireClientAccess'),
    'client-scoped goal routes must authorize through requireClientAccess',
  );
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(goalsRoutes),
    'goal routes must not carry a private permission engine',
  );
  // No workflow/playbook/execution/deployment authority structures leak
  // into the module or its routes (a Goal is not a workflow —
  // architecture.md §7). Structural markers, not docstring words:
  //   - the routes file registers ONLY /api/clients/:clientId/goals and
  //     /api/goals/:goalId* paths (never workflow/playbook/execution/
  //     deployment routes);
  //   - the public contract exports no workflow/playbook/execution/
  //     deployment types or functions.
  const registeredPaths = [...goalsRoutes.matchAll(/'\/api\/([\w:/:-]+)'/g)].map((match) =>
    match[1]!.replace(/:clientId|:goalId/g, '').replace(/\/+/g, '/'),
  );
  for (const path of registeredPaths) {
    assert.ok(
      path === 'clients/goals' || path === 'goals' || path.startsWith('goals/'),
      `goals routes must only register goals paths (found '${path}')`,
    );
  }
  const exportedAuthoritySymbols = [
    ...goalsPublic.matchAll(/export (?:interface|type|function|const) (\w+)/g),
  ].map((match) => match[1]!);
  for (const symbol of exportedAuthoritySymbols) {
    assert.ok(
      !/Playbook|Workflow|Execution|Deployment|TaskState/.test(symbol),
      `the goals public contract must not export ${symbol} (Goal is not a workflow)`,
    );
  }
  // Migration 007 indexes are exactly the listing surfaces — no permission
  // or authority structures.
  const createdIndexes = [...migration007.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdIndexes.sort(),
    ['goals_client_idx', 'goals_workspace_idx'],
    'migration 007 indexes are exactly the client listing + workspace scope surfaces',
  );
});
