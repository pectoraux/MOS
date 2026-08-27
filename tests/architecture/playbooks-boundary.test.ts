/**
 * MKT-007 static tests — the Playbooks domain model is structurally
 * correct in the ACTUAL migration and module contract (pure static
 * analysis, no DB).
 *
 * Proofs (PLAY-001, PLAY-AC-01/02, spec/architecture.md §8 "A Playbook is
 * a versioned, reusable set of strategy/workflow templates. A published
 * Playbook Version is immutable. Deployment references the exact Playbook
 * Version and does not mutate it.", spec/tenant-runtime-model.md
 * ownership matrix "Playbook | Agency or Client | reusable operational
 * IP", spec/state-machines.md "Playbook Version:
 * DRAFT → REVIEW → PUBLISHED → RETIRED", spec/module-dependency-matrix.md
 * "/playbooks ──→ /agencies, /clients, /goals"):
 *   1. migration 008 creates `playbooks` + `playbook_versions` with the
 *      required contract fields: immutable opaque ids, Agency ownership
 *      reference, optional Client scope + Goal link, name/description,
 *      explicit version identity (version_id + per-playbook
 *      version_number), lifecycle status, strategy + deployment metadata
 *      jsonb objects, provenance, version CAS, server-derived timestamps;
 *   2. Playbook ownership is EXACTLY the agency_id FK (plus the optional
 *      client_id scope FK and goal_id link FK) — no owner/role/user
 *      columns on playbooks, and no playbook_id column on
 *      agencies/users/clients/workspaces/goals (the ownership
 *      relationship is stored ONLY here — never elsewhere as an alternate
 *      authority);
 *   3. the version status CHECK enumerates the same lifecycle as the code
 *      PLAYBOOK_VERSION_TRANSITIONS table (persistence can never drift
 *      from code), the terminal state matches, and NO execution states
 *      leak into the machine;
 *   4. the EXPLICIT version reference is DB-fenced: (playbook_id,
 *      version_number) is UNIQUE and version_number >= 1 — a version
 *      number is assigned exactly once per playbook (PLAY-AC-02 storage
 *      end of the explicit-version contract);
 *   5. the PUBLISHED-immutability trigger exists (PLAY-AC-01): published
 *      content (strategy, deployment_metadata) can never change, the
 *      only legal transition out of published is the content-preserving
 *      published → retired, and retired rows are fully frozen;
 *   6. the identity/scope/provenance IMMUTABILITY triggers exist on both
 *      tables, and the scope backstops exist (a client outside the
 *      owning Agency and a goal outside the owning Client are rejected
 *      by the database itself);
 *   7. the /playbooks public contract exposes the canonical owner-context
 *      resolution surface AND the explicit version reference surface
 *      (getPlaybookVersion), and imports ONLY the allowed authorities
 *      (/agencies, /clients, /goals — frozen matrix);
 *   8. no workflow/deployment/execution authority is introduced: the
 *      routes file registers ONLY playbook paths, the public contract
 *      exports no workflow/deployment/execution concepts, the module
 *      composes canonical ownership (never a private permission engine),
 *      and there is NO floating "latest version" content pointer in the
 *      public API — content resolves only through explicit version
 *      references (PLAY-AC-02);
 *   9. migration 008 indexes are exactly the two listing surfaces — no
 *      permission or authority structures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAYBOOK_VERSION_TRANSITIONS,
  composePlaybookOwnerContext,
  isLegalPlaybookVersionTransition,
} from '../../src/modules/playbooks/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration008 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '008_playbooks.sql'),
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
const migration007 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '007_goals.sql'),
  'utf8',
);
const playbooksPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'playbooks', 'public.ts'),
  'utf8',
);
const playbooksModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'playbooks', 'internal', 'playbooks-module.ts'),
  'utf8',
);
const playbooksRoutes = readFileSync(join(repoRoot, 'src', 'api', 'playbooks-routes.ts'), 'utf8');

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

test('the playbooks and playbook_versions tables carry the required domain contract fields (PLAY-001 data contract)', () => {
  const playbooksColumns = columnsOf(createTableBlock(migration008, 'playbooks'));
  for (const required of [
    'playbook_id', // immutable opaque identifier (server-generated)
    'agency_id', // Agency ownership reference (FK) — commercial tenant
    'client_id', // optional Client scope FK (Agency-or-Client ownership)
    'goal_id', // optional Goal link FK ("Goals produce plans/playbooks")
    'name', // playbook name
    'description', // playbook description
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(playbooksColumns.includes(required), `playbooks.${required} required`);
  }
  assert.ok(
    migration008.includes('agency_id         uuid        NOT NULL REFERENCES agencies(agency_id)'),
    'Agency ownership must be a NOT NULL FK to agencies',
  );
  assert.ok(
    migration008.includes('client_id         uuid        REFERENCES clients(client_id)'),
    'Client scope must be a (nullable) FK to clients',
  );
  assert.ok(
    migration008.includes('goal_id           uuid        REFERENCES goals(goal_id)'),
    'Goal link must be a (nullable) FK to goals',
  );

  const versionsColumns = columnsOf(createTableBlock(migration008, 'playbook_versions'));
  for (const required of [
    'version_id', // the explicit version reference deployments pin
    'playbook_id', // owning playbook FK
    'version_number', // per-playbook explicit monotonic version number
    'status', // version lifecycle (frozen machine)
    'strategy', // the versioned strategy artifact (jsonb object)
    'deployment_metadata', // declarative deployment metadata (jsonb object)
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(versionsColumns.includes(required), `playbook_versions.${required} required`);
  }
  assert.ok(
    migration008.includes(
      'playbook_id         uuid        NOT NULL REFERENCES playbooks(playbook_id)',
    ),
    'Version ownership must be a NOT NULL FK to playbooks',
  );
  // Strategy and deployment metadata are structurally fenced as objects.
  assert.ok(
    migration008.includes("jsonb_typeof(strategy) = 'object'"),
    'strategy must be CHECKed to be a jsonb object',
  );
  assert.ok(
    migration008.includes("jsonb_typeof(deployment_metadata) = 'object'"),
    'deployment_metadata must be CHECKed to be a jsonb object',
  );
});

test('Playbook ownership is exactly the agency_id FK + optional client/goal references — no conflation, no alternate authority', () => {
  // playbooks has NO owner/role/user columns beyond agency/client/goal +
  // provenance.
  const playbooksColumns = columnsOf(createTableBlock(migration008, 'playbooks'));
  for (const column of playbooksColumns) {
    if (column === 'agency_id' || column === 'client_id' || column === 'goal_id' || column === 'created_by') {
      continue;
    }
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `playbooks must not carry ownership/role/user columns (found '${column}')`,
    );
  }
  assert.ok(
    migration008.includes('created_by        uuid        REFERENCES users(user_id)'),
    'created_by is a nullable provenance reference',
  );

  // The Agency→Playbook relationship lives ONLY in playbooks.agency_id: no
  // playbook_id column leaks upward into agencies/users/clients/workspaces/
  // goals, and migration 008 must not redefine the earlier frozen tables.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
    [migration007, 'goals'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/playbook/.test(column),
        `${table}.${column} — the Playbook relationship must not leak above /playbooks`,
      );
    }
  }
  for (const table of ['agencies', 'users', 'clients', 'workspaces', 'goals']) {
    assert.ok(
      !migration008.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `008 must not redefine the frozen ${table} table`,
    );
  }
  // No new tables beyond playbooks + playbook_versions in migration 008
  // (no permission engine, no workflow/deployment/execution structures).
  const createdTables = [...migration008.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['playbooks', 'playbook_versions'],
    'migration 008 must create exactly the playbooks + playbook_versions tables — no second authority structures',
  );
});

test('the migration status CHECK and the code transition table describe ONE frozen lifecycle', () => {
  const versionsBlock = createTableBlock(migration008, 'playbook_versions');
  assert.ok(
    versionsBlock.includes("'draft', 'review', 'published', 'retired'"),
    'playbook version status CHECK must cover draft/review/published/retired',
  );
  assert.deepEqual(
    [...Object.keys(PLAYBOOK_VERSION_TRANSITIONS)].sort(),
    ['draft', 'published', 'retired', 'review'],
    'code transition table statuses match the DB CHECK',
  );
  assert.equal(isLegalPlaybookVersionTransition('retired', 'draft'), false, 'retired is terminal in code');
  assert.equal(isLegalPlaybookVersionTransition('draft', 'published'), false, 'review is mandatory in code');
  assert.equal(PLAYBOOK_VERSION_TRANSITIONS.retired.length, 0, 'no outgoing transitions from retired');
  // The lifecycle carries NO execution semantics (architecture.md §8: a
  // Playbook is a strategy artifact, not a workflow).
  const statusEnumeration = versionsBlock.slice(versionsBlock.indexOf('CHECK (status'));
  for (const executionState of ['running', 'paused', 'queued', 'dispatched', 'blocked', 'active']) {
    assert.ok(
      !statusEnumeration.includes(executionState),
      `playbook version status CHECK must not contain execution state '${executionState}'`,
    );
  }
});

test('the EXPLICIT version reference is DB-fenced (PLAY-AC-02 storage end)', () => {
  // Within one playbook a version number is assigned exactly once and can
  // never be duplicated or reassigned.
  assert.ok(
    migration008.includes('CONSTRAINT playbook_versions_number_unique UNIQUE (playbook_id, version_number)'),
    'the (playbook_id, version_number) UNIQUE fence must exist',
  );
  assert.ok(
    migration008.includes('version_number      integer     NOT NULL CHECK (version_number >= 1)'),
    'version numbers start at 1 and are positive integers',
  );
  // The version identity trigger keeps the explicit reference stable.
  assert.ok(
    migration008.includes('playbook_versions_identity_immutable'),
    'the version identity immutability trigger must exist',
  );
  const triggerBody = migration008.slice(
    migration008.indexOf('CREATE OR REPLACE FUNCTION playbook_versions_identity_immutable'),
    migration008.indexOf('$$ LANGUAGE plpgsql;', migration008.indexOf('playbook_versions_identity_immutable')),
  );
  assert.ok(triggerBody.includes('NEW.version_id <> OLD.version_id'), 'version_id immutability');
  assert.ok(triggerBody.includes('NEW.playbook_id <> OLD.playbook_id'), 'version playbook ownership immutability');
  assert.ok(triggerBody.includes('NEW.version_number <> OLD.version_number'), 'version_number immutability');
  assert.ok(triggerBody.includes('NEW.created_at <> OLD.created_at'), 'created_at immutability');
  assert.ok(triggerBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'), 'created_by immutability');
});

test('PUBLISHED versions are DB-frozen immutable (PLAY-AC-01 storage backstop)', () => {
  assert.ok(
    migration008.includes('playbook_versions_published_immutable'),
    'the published-immutability trigger must exist',
  );
  const triggerBody = migration008.slice(
    migration008.indexOf('CREATE OR REPLACE FUNCTION playbook_versions_published_immutable'),
    migration008.indexOf(
      '$$ LANGUAGE plpgsql;',
      migration008.indexOf('playbook_versions_published_immutable'),
    ),
  );
  assert.ok(
    triggerBody.includes("OLD.status = 'retired'"),
    'retired rows must be covered by the freeze',
  );
  assert.ok(
    triggerBody.includes('ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*)'),
    'retired rows must reject every content-changing update',
  );
  assert.ok(
    triggerBody.includes("OLD.status = 'published'"),
    'published rows must be covered by the freeze',
  );
  assert.ok(
    triggerBody.includes("NEW.status NOT IN ('published', 'retired')"),
    'the only legal transition out of published is retirement',
  );
  assert.ok(
    triggerBody.includes('NEW.strategy IS DISTINCT FROM OLD.strategy'),
    'published strategy content is immutable',
  );
  assert.ok(
    triggerBody.includes('NEW.deployment_metadata IS DISTINCT FROM OLD.deployment_metadata'),
    'published deployment metadata is immutable',
  );
});

test('Playbook identity, scope and provenance are DB-backstopped immutable, with scope backstops on both boundaries', () => {
  assert.ok(
    migration008.includes('playbooks_identity_immutable'),
    'the playbook identity immutability trigger must exist',
  );
  const identityBody = migration008.slice(
    migration008.indexOf('CREATE OR REPLACE FUNCTION playbooks_identity_immutable'),
    migration008.indexOf('$$ LANGUAGE plpgsql;', migration008.indexOf('playbooks_identity_immutable')),
  );
  assert.ok(identityBody.includes('NEW.playbook_id <> OLD.playbook_id'), 'playbook_id immutability');
  assert.ok(identityBody.includes('NEW.agency_id <> OLD.agency_id'), 'Agency ownership immutability');
  assert.ok(
    identityBody.includes('NEW.client_id IS DISTINCT FROM OLD.client_id'),
    'Client scope immutability (once set — including NULL ⇄ set)',
  );
  assert.ok(
    identityBody.includes('NEW.goal_id IS DISTINCT FROM OLD.goal_id'),
    'Goal link immutability (once set — including NULL ⇄ set)',
  );
  assert.ok(identityBody.includes('NEW.created_at <> OLD.created_at'), 'created_at immutability');
  assert.ok(
    identityBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'),
    'created_by immutability',
  );

  // Agency boundary backstop: a client-scoped playbook must reference a
  // Client of the SAME Agency.
  assert.ok(
    migration008.includes('playbooks_client_within_agency'),
    'the client-within-agency trigger must exist',
  );
  const agencyScopeBody = migration008.slice(
    migration008.indexOf('CREATE OR REPLACE FUNCTION playbooks_client_within_agency'),
    migration008.indexOf('$$ LANGUAGE plpgsql;', migration008.indexOf('playbooks_client_within_agency')),
  );
  assert.ok(
    agencyScopeBody.includes('c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id'),
    'the trigger must require the client to belong to the playbook agency',
  );
  assert.ok(
    migration008.includes('BEFORE INSERT OR UPDATE ON playbooks'),
    'the scope backstops must fire on INSERT and UPDATE',
  );

  // Client boundary backstop: a linked goal must belong to the playbook's
  // OWN Client (and requires Client scope).
  assert.ok(
    migration008.includes('playbooks_goal_within_client'),
    'the goal-within-client trigger must exist',
  );
  const goalScopeBody = migration008.slice(
    migration008.indexOf('CREATE OR REPLACE FUNCTION playbooks_goal_within_client'),
    migration008.indexOf('$$ LANGUAGE plpgsql;', migration008.indexOf('playbooks_goal_within_client')),
  );
  assert.ok(
    goalScopeBody.includes('g.goal_id = NEW.goal_id AND g.client_id = NEW.client_id'),
    'the trigger must require the goal to belong to the playbook client',
  );
});

test('the /playbooks public contract exposes canonical owner resolution AND the explicit version reference over allowed dependencies only', () => {
  // Canonical owner-context surface.
  assert.ok(
    playbooksPublic.includes('export interface PlaybookOwnerContext'),
    'PlaybookOwnerContext must be part of the public contract',
  );
  assert.ok(
    playbooksPublic.includes('resolvePlaybookOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    playbooksPublic.includes("kind: 'playbook'"),
    'the owner context must carry the playbook-scoped OwnerScope shape',
  );
  assert.ok(
    typeof composePlaybookOwnerContext === 'function',
    'the pure composer must be exported',
  );
  // The explicit version reference surface (PLAY-AC-02 contract end).
  assert.ok(
    playbooksPublic.includes('getPlaybookVersion('),
    'the explicit version reference resolution must be part of the module API',
  );
  assert.ok(
    playbooksPublic.includes('listPlaybookVersions('),
    'version listing must be part of the module API',
  );

  // Dependency matrix: /playbooks ──→ /agencies, /clients, /goals ONLY.
  // The public entry must not import any other module.
  const imports = [...playbooksPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['agencies', 'clients', 'goals'],
    'public.ts may only import /agencies, /clients and /goals among module publics (frozen matrix: /playbooks ──→ /agencies, /clients, /goals)',
  );
  for (const forbidden of [
    'auth',
    'users',
    'workspaces',
    'workflows',
    'executions',
    'deployments',
    'policies',
    'audit',
    'jobs',
    'evidence',
  ]) {
    assert.ok(
      !imports.includes(forbidden),
      `/playbooks must not depend on /${forbidden} (frozen matrix)`,
    );
  }
});

test('no workflow/deployment/execution authority and no floating version pointer in the /playbooks implementation', () => {
  // The module implementation composes /agencies + /clients + /goals
  // canonical ownership — it never re-derives and never invents an
  // authority.
  assert.ok(
    playbooksModule.includes('resolveClientOwnership'),
    'the playbooks module must resolve Client ownership THROUGH /clients',
  );
  assert.ok(
    playbooksModule.includes('resolvePlaybookOwnership'),
    'the playbooks module must own the canonical playbook owner resolution',
  );
  // The route layer must use the shared authorize helpers (which resolve
  // canonical ownership first) — never a private permission engine.
  assert.ok(
    playbooksRoutes.includes('requirePlaybookAccess'),
    'playbook routes must authorize through the shared requirePlaybookAccess helper',
  );
  assert.ok(
    playbooksRoutes.includes('requireAgencyAccess'),
    'agency-scoped playbook routes must authorize through requireAgencyAccess',
  );
  assert.ok(
    playbooksRoutes.includes('requireClientAccess'),
    'client-scoped playbook routes must authorize through requireClientAccess',
  );
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(playbooksRoutes),
    'playbook routes must not carry a private permission engine',
  );

  // No workflow/deployment/execution authority structures leak into the
  // module or its routes (architecture.md §8). Structural markers, not
  // docstring words:
  //   - the routes file registers ONLY /api/agencies/:agencyId/playbooks,
  //     /api/clients/:clientId/playbooks and /api/playbooks/* paths (never
  //     workflow/deployment/execution routes);
  const registeredPaths = [...playbooksRoutes.matchAll(/'\/api\/([\w:/:-]+)'/g)].map((match) =>
    match[1]!
      .replace(/:agencyId|:clientId|:playbookId|:versionId/g, '')
      .replace(/\/+/g, '/'),
  );
  for (const path of registeredPaths) {
    assert.ok(
      path === 'agencies/playbooks' ||
        path === 'clients/playbooks' ||
        path === 'playbooks' ||
        path.startsWith('playbooks/'),
      `playbook routes must only register playbook paths (found '${path}')`,
    );
  }

  //   - the public contract exports EXACTLY the playbook-domain surface:
  //      no workflow/deployment/execution authority types or functions
  //      (PlaybookDeploymentMetadata is the declarative metadata payload
  //      of the MKT-007 work item — data the /deployments authority will
  //      validate — never a Deployment authority), and NO floating
  //      version pointer: content resolution happens only through
  //      explicit version references (PLAY-AC-02 — downstream
  //      authorities pin an exact version).
  const exportedSymbols = [...playbooksPublic.matchAll(/export (?:interface|type|function|const) (\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(exportedSymbols)].sort(),
    [
      'PLAYBOOK_RUNTIME_CLASSES',
      'PLAYBOOK_VERSION_TRANSITIONS',
      'PlaybookCapabilityRequirement',
      'PlaybookDeploymentMetadata',
      'PlaybookDomainPackRequirement',
      'PlaybookOwnerContext',
      'PlaybookRecord',
      'PlaybookRuntimeClass',
      'PlaybookRuntimeRequirements',
      'PlaybookStrategy',
      'PlaybookStrategyTemplate',
      'PlaybookTrigger',
      'PlaybookVersionRecord',
      'PlaybookVersionStatus',
      'PlaybooksModuleApi',
      'PlaybooksModuleDeps',
      'composePlaybookOwnerContext',
      'isLegalPlaybookVersionTransition',
    ],
    'the public surface is exactly the playbook-domain contract — any new export is a deliberate, reviewed change',
  );
  assert.ok(
    !/getLatest|latestVersion|currentVersion|resolveLatest/.test(playbooksPublic),
    'the public API must not expose a floating latest/current version pointer',
  );
  assert.ok(
    !/getLatest|latestVersion|currentVersion|resolveLatest/.test(playbooksRoutes),
    'the routes must not expose a floating latest/current version route',
  );
});

test('migration 008 indexes are exactly the two listing surfaces', () => {
  const createdIndexes = [...migration008.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdIndexes.sort(),
    ['playbooks_agency_idx', 'playbooks_client_idx'],
    'migration 008 indexes are exactly the agency-scope + client-scope listing surfaces (version lookups ride the UNIQUE fence)',
  );
});
