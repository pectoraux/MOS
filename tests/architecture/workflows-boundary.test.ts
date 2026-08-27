/**
 * MKT-008 static tests — the Workflow graph model is structurally correct
 * in the ACTUAL migration and module contract (pure static analysis, no
 * DB).
 *
 * Proofs (WF-001 "Implement one deterministic Workflow Graph authority
 * with typed node/edge contracts", spec/implementation-contract.md §4
 * "A Workflow Definition is versioned and immutable after activation …
 * Workflow validation MUST reject dangling nodes/edges, invalid node
 * types, impossible joins, duplicate node IDs, illegal cycles, and
 * unresolved schema mappings. Cycles are allowed only where an explicit
 * bounded loop construct declares its iteration/termination contract.",
 * spec/architecture.md §10 node class list, tenant-runtime-model.md
 * ownership matrix "Workflow | Workspace/Client", module-dependency-matrix
 * "/workflows ──→ /workspaces, /goals, /playbooks, /executions, /policies,
 * /audit"):
 *   1. migration 009 creates `workflows` + `workflow_definitions` with the
 *      required contract fields: immutable opaque ids, Workspace ownership
 *      reference with server-derived Client/Agency ownership, name/
 *      description, explicit version identity (workflow_definition_id +
 *      per-workflow version_number), activation status, playbook_version
 *      provenance reference, graph + schemas + declarative policy blocks
 *      as jsonb objects, provenance, version CAS, server-derived
 *      timestamps;
 *   2. Workflow ownership is EXACTLY the workspace_id FK plus the
 *      server-derived client_id/agency_id FKs — no owner/role/user columns
 *      on workflows, and no workflow_id column on workspaces/clients/
 *      agencies/users (the ownership relationship is stored ONLY here —
 *      never elsewhere as an alternate authority);
 *   3. the definition status CHECK enumerates the same activation
 *      lifecycle as the code WORKFLOW_DEFINITION_TRANSITIONS table
 *      (persistence can never drift from code), the terminal state
 *      matches, and NO runtime/instance states leak into the machine
 *      (DRAFT → READY → RUNNING … is the MKT-009 instance machine);
 *   4. the EXPLICIT version reference is DB-fenced: (workflow_id,
 *      version_number) is UNIQUE and version_number >= 1 — a version
 *      number is assigned exactly once per workflow;
 *   5. the ACTIVATION-immutability trigger exists ("immutable after
 *      activation"): active content (graph, schemas, policy blocks) can
 *      never change, the only legal transition out of active is the
 *      content-preserving active → retired, and retired rows are fully
 *      frozen;
 *   6. the identity/scope/provenance IMMUTABILITY triggers exist on both
 *      tables, and the scope backstops exist (a workspace outside the
 *      recorded Client, a client outside the recorded Agency, and a
 *      playbook version not usable by the workflow's Client are all
 *      rejected by the database itself);
 *   7. the /workflows public contract exposes the canonical owner-context
 *      resolution surface AND the explicit version reference surface
 *      (getWorkflowDefinition), and imports ONLY the allowed authorities
 *      (/workspaces, /playbooks — a subset of the frozen matrix; the
 *      runtime authorities arrive with later Work Items);
 *   8. no execution/deployment authority is introduced: the routes
 *      file registers ONLY workflow paths, the public contract exports no
 *      run/execution/deployment concepts and NO floating "latest version"
 *      pointer, the module composes canonical ownership (never a private
 *      permission engine), and the graph validation authority
 *      (validateWorkflowDefinitionContent) is exported for the frozen
 *      §4 MUST list. (MKT-009 extends the SAME /workflows authority with
 *      the §5 Workflow INSTANCE lifecycle surface — the deliberate,
 *      reviewed export-list change this test pins; execution authority
 *      stays forbidden.);
 *   9. migration 009 indexes are exactly the one listing surface — no
 *      permission or authority structures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_DEFINITION_TRANSITIONS,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_EDGE_TYPES,
  composeWorkflowOwnerContext,
  isLegalWorkflowDefinitionTransition,
} from '../../src/modules/workflows/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration009 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '009_workflows.sql'),
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
const workflowsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'workflows', 'public.ts'),
  'utf8',
);
const workflowsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'workflows', 'internal', 'workflows-module.ts'),
  'utf8',
);
const workflowsRoutes = readFileSync(join(repoRoot, 'src', 'api', 'workflows-routes.ts'), 'utf8');

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

test('the workflows and workflow_definitions tables carry the required domain contract fields (WF-001 data contract)', () => {
  const workflowsColumns = columnsOf(createTableBlock(migration009, 'workflows'));
  for (const required of [
    'workflow_id', // immutable opaque identifier (server-generated)
    'workspace_id', // Workspace ownership reference (the scope chain)
    'client_id', // server-derived Client ownership
    'agency_id', // server-derived Agency ownership
    'name', // workflow name
    'description', // workflow description
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(workflowsColumns.includes(required), `workflows.${required} required`);
  }
  assert.ok(
    migration009.includes('workspace_id      uuid        NOT NULL REFERENCES workspaces(workspace_id)'),
    'Workspace ownership must be a NOT NULL FK to workspaces',
  );
  assert.ok(
    migration009.includes('client_id         uuid        NOT NULL REFERENCES clients(client_id)'),
    'Client ownership must be a NOT NULL FK to clients',
  );
  assert.ok(
    migration009.includes('agency_id         uuid        NOT NULL REFERENCES agencies(agency_id)'),
    'Agency ownership must be a NOT NULL FK to agencies',
  );

  const definitionsColumns = columnsOf(createTableBlock(migration009, 'workflow_definitions'));
  for (const required of [
    'workflow_definition_id', // the explicit version reference deployments pin
    'workflow_id', // owning workflow FK
    'version_number', // per-workflow explicit monotonic version number
    'status', // activation lifecycle
    'playbook_version_id', // optional immutable Playbook provenance link
    'graph', // typed node + edge definitions (jsonb object)
    'input_schema', // workflow input schema (jsonb object)
    'output_schema', // workflow output schema (jsonb object)
    'retry_policy_defaults', // declarative §4 policy block
    'concurrency_limits', // declarative §4 policy block
    'timeout_policy', // declarative §4 policy block
    'compensation', // declarative §4 compensation declarations
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(definitionsColumns.includes(required), `workflow_definitions.${required} required`);
  }
  assert.ok(
    migration009.includes(
      'workflow_id             uuid        NOT NULL REFERENCES workflows(workflow_id)',
    ),
    'Definition ownership must be a NOT NULL FK to workflows',
  );
  assert.ok(
    migration009.includes('playbook_version_id     uuid        REFERENCES playbook_versions(version_id)'),
    'The playbook provenance link must be a (nullable) FK to playbook_versions',
  );
  // The graph, schemas and policy blocks are structurally fenced objects.
  assert.ok(
    migration009.includes("jsonb_typeof(graph) = 'object'"),
    'graph must be CHECKed to be a jsonb object',
  );
  assert.ok(
    migration009.includes("jsonb_typeof(input_schema) = 'object'"),
    'input_schema must be CHECKed to be a jsonb object',
  );
  assert.ok(
    migration009.includes("jsonb_typeof(output_schema) = 'object'"),
    'output_schema must be CHECKed to be a jsonb object',
  );
});

test('Workflow ownership is exactly the workspace_id FK + derived client/agency references — no conflation, no alternate authority', () => {
  // workflows has NO owner/role/user columns beyond workspace/client/
  // agency + provenance.
  const workflowsColumns = columnsOf(createTableBlock(migration009, 'workflows'));
  for (const column of workflowsColumns) {
    if (
      column === 'workspace_id' ||
      column === 'client_id' ||
      column === 'agency_id' ||
      column === 'created_by'
    ) {
      continue;
    }
    assert.ok(
      !/owner|role|user|admin|permission/.test(column),
      `workflows must not carry ownership/role/user columns (found '${column}')`,
    );
  }
  assert.ok(
    migration009.includes('created_by        uuid        REFERENCES users(user_id)'),
    'created_by is a nullable provenance reference',
  );

  // The Workspace→Workflow relationship lives ONLY in
  // workflows.workspace_id: no workflow_id column leaks upward into
  // workspaces/clients/agencies/users, and migration 009 must not
  // redefine the earlier frozen tables.
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
  ] as const) {
    for (const column of columnsOf(createTableBlock(migration, table))) {
      assert.ok(
        !/workflow/.test(column),
        `${table}.${column} — the Workflow relationship must not leak above /workflows`,
      );
    }
  }
  for (const table of ['agencies', 'users', 'clients', 'workspaces', 'playbooks', 'playbook_versions']) {
    assert.ok(
      !migration009.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `009 must not redefine the frozen ${table} table`,
    );
  }
  // No new tables beyond workflows + workflow_definitions in migration 009
  // (no permission engine, no instance/run/execution structures).
  const createdTables = [...migration009.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdTables,
    ['workflows', 'workflow_definitions'],
    'migration 009 must create exactly the workflows + workflow_definitions tables — no runtime/instance/execution structures',
  );
});

test('the migration status CHECK and the code transition table describe ONE frozen activation lifecycle', () => {
  const definitionsBlock = createTableBlock(migration009, 'workflow_definitions');
  assert.ok(
    definitionsBlock.includes("'draft', 'review', 'active', 'retired'"),
    'workflow definition status CHECK must cover draft/review/active/retired',
  );
  assert.deepEqual(
    [...Object.keys(WORKFLOW_DEFINITION_TRANSITIONS)].sort(),
    ['active', 'draft', 'retired', 'review'],
    'code transition table statuses match the DB CHECK',
  );
  assert.equal(isLegalWorkflowDefinitionTransition('retired', 'draft'), false, 'retired is terminal in code');
  assert.equal(isLegalWorkflowDefinitionTransition('draft', 'active'), false, 'review is mandatory in code');
  assert.equal(WORKFLOW_DEFINITION_TRANSITIONS.retired.length, 0, 'no outgoing transitions from retired');
  // The lifecycle carries NO instance/runtime semantics (state-machines.md
  // "Workflow Instance": DRAFT → READY → RUNNING → … belongs to MKT-009).
  const statusEnumeration = definitionsBlock.slice(definitionsBlock.indexOf('CHECK (status'));
  for (const instanceState of ['running', 'paused', 'queued', 'dispatched', 'blocked', 'ready', 'cancelled', 'succeeded', 'failed']) {
    assert.ok(
      !statusEnumeration.includes(instanceState),
      `workflow definition status CHECK must not contain instance state '${instanceState}'`,
    );
  }
});

test('the EXPLICIT version reference is DB-fenced (the storage end of the explicit-version contract)', () => {
  // Within one workflow a version number is assigned exactly once and can
  // never be duplicated or reassigned.
  assert.ok(
    migration009.includes(
      'CONSTRAINT workflow_definitions_number_unique UNIQUE (workflow_id, version_number)',
    ),
    'the (workflow_id, version_number) UNIQUE fence must exist',
  );
  assert.ok(
    migration009.includes('version_number          integer     NOT NULL CHECK (version_number >= 1)'),
    'version numbers start at 1 and are positive integers',
  );
  // The version identity trigger keeps the explicit reference stable —
  // INCLUDING the playbook provenance link.
  assert.ok(
    migration009.includes('workflow_definitions_identity_immutable'),
    'the version identity immutability trigger must exist',
  );
  const triggerBody = migration009.slice(
    migration009.indexOf('CREATE OR REPLACE FUNCTION workflow_definitions_identity_immutable'),
    migration009.indexOf('$$ LANGUAGE plpgsql;', migration009.indexOf('workflow_definitions_identity_immutable')),
  );
  assert.ok(triggerBody.includes('NEW.workflow_definition_id <> OLD.workflow_definition_id'), 'workflow_definition_id immutability');
  assert.ok(triggerBody.includes('NEW.workflow_id <> OLD.workflow_id'), 'definition workflow ownership immutability');
  assert.ok(triggerBody.includes('NEW.version_number <> OLD.version_number'), 'version_number immutability');
  assert.ok(triggerBody.includes('NEW.playbook_version_id IS DISTINCT FROM OLD.playbook_version_id'), 'playbook provenance immutability');
  assert.ok(triggerBody.includes('NEW.created_at <> OLD.created_at'), 'created_at immutability');
  assert.ok(triggerBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'), 'created_by immutability');
});

test('ACTIVATED definitions are DB-frozen immutable (immutable-after-activation storage backstop)', () => {
  assert.ok(
    migration009.includes('workflow_definitions_active_immutable'),
    'the activation-immutability trigger must exist',
  );
  const triggerBody = migration009.slice(
    migration009.indexOf('CREATE OR REPLACE FUNCTION workflow_definitions_active_immutable'),
    migration009.indexOf(
      '$$ LANGUAGE plpgsql;',
      migration009.indexOf('workflow_definitions_active_immutable'),
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
    triggerBody.includes("OLD.status = 'active'"),
    'active rows must be covered by the freeze',
  );
  assert.ok(
    triggerBody.includes("NEW.status NOT IN ('active', 'retired')"),
    'the only legal transition out of active is retirement',
  );
  assert.ok(
    triggerBody.includes('NEW.graph IS DISTINCT FROM OLD.graph'),
    'activated graph content is immutable',
  );
  assert.ok(
    triggerBody.includes('NEW.input_schema IS DISTINCT FROM OLD.input_schema'),
    'activated input schema is immutable',
  );
  assert.ok(
    triggerBody.includes('NEW.output_schema IS DISTINCT FROM OLD.output_schema'),
    'activated output schema is immutable',
  );
  assert.ok(
    triggerBody.includes('NEW.retry_policy_defaults IS DISTINCT FROM OLD.retry_policy_defaults') &&
      triggerBody.includes('NEW.concurrency_limits IS DISTINCT FROM OLD.concurrency_limits') &&
      triggerBody.includes('NEW.timeout_policy IS DISTINCT FROM OLD.timeout_policy') &&
      triggerBody.includes('NEW.compensation IS DISTINCT FROM OLD.compensation'),
    'activated declarative policy blocks are immutable',
  );
});

test('Workflow identity, scope and provenance are DB-backstopped immutable, with the full scope-chain backstop', () => {
  assert.ok(
    migration009.includes('workflows_identity_immutable'),
    'the workflow identity immutability trigger must exist',
  );
  const identityBody = migration009.slice(
    migration009.indexOf('CREATE OR REPLACE FUNCTION workflows_identity_immutable'),
    migration009.indexOf('$$ LANGUAGE plpgsql;', migration009.indexOf('workflows_identity_immutable')),
  );
  assert.ok(identityBody.includes('NEW.workflow_id <> OLD.workflow_id'), 'workflow_id immutability');
  assert.ok(identityBody.includes('NEW.workspace_id <> OLD.workspace_id'), 'Workspace scope immutability');
  assert.ok(identityBody.includes('NEW.client_id <> OLD.client_id'), 'Client ownership immutability');
  assert.ok(identityBody.includes('NEW.agency_id <> OLD.agency_id'), 'Agency ownership immutability');
  assert.ok(identityBody.includes('NEW.created_at <> OLD.created_at'), 'created_at immutability');
  assert.ok(identityBody.includes('NEW.created_by IS DISTINCT FROM OLD.created_by'), 'created_by immutability');

  // Scope-chain backstop: the workspace must belong to the recorded
  // Client AND the client to the recorded Agency.
  assert.ok(
    migration009.includes('workflows_scope_chain'),
    'the scope-chain trigger must exist',
  );
  const scopeBody = migration009.slice(
    migration009.indexOf('CREATE OR REPLACE FUNCTION workflows_scope_chain'),
    migration009.indexOf('$$ LANGUAGE plpgsql;', migration009.indexOf('workflows_scope_chain')),
  );
  assert.ok(
    scopeBody.includes('w.workspace_id = NEW.workspace_id') &&
      scopeBody.includes('w.client_id = NEW.client_id'),
    'the trigger must require the workspace to belong to the recorded Client',
  );
  assert.ok(
    scopeBody.includes('c.client_id = NEW.client_id') && scopeBody.includes('c.agency_id = NEW.agency_id'),
    'the trigger must require the client to belong to the recorded Agency',
  );
  assert.ok(
    migration009.includes('BEFORE INSERT OR UPDATE ON workflows'),
    'the scope backstop must fire on INSERT and UPDATE',
  );

  // Playbook-provenance scope backstop: a linked playbook version must
  // exist and be usable by the workflow's Client (Agency-scoped reusable
  // IP or the SAME Client).
  assert.ok(
    migration009.includes('workflow_definitions_playbook_scope'),
    'the playbook-scope trigger must exist',
  );
  const playbookScopeBody = migration009.slice(
    migration009.indexOf('CREATE OR REPLACE FUNCTION workflow_definitions_playbook_scope'),
    migration009.indexOf('$$ LANGUAGE plpgsql;', migration009.indexOf('workflow_definitions_playbook_scope')),
  );
  assert.ok(
    playbookScopeBody.includes('p.client_id IS NULL OR p.client_id = wf.client_id'),
    'the trigger must confine the playbook link to compatible Client scope',
  );
});

test('the /workflows public contract exposes canonical owner resolution AND the explicit version reference over allowed dependencies only', () => {
  // Canonical owner-context surface.
  assert.ok(
    workflowsPublic.includes('export interface WorkflowOwnerContext'),
    'WorkflowOwnerContext must be part of the public contract',
  );
  assert.ok(
    workflowsPublic.includes('resolveWorkflowOwnership'),
    'canonical ownership resolution must be part of the module API',
  );
  assert.ok(
    workflowsPublic.includes("kind: 'workflow'"),
    'the owner context must carry the workflow-scoped OwnerScope shape',
  );
  assert.ok(
    typeof composeWorkflowOwnerContext === 'function',
    'the pure composer must be exported',
  );
  // The explicit version reference surface.
  assert.ok(
    workflowsPublic.includes('getWorkflowDefinition('),
    'the explicit version reference resolution must be part of the module API',
  );
  assert.ok(
    workflowsPublic.includes('listWorkflowDefinitions('),
    'version listing must be part of the module API',
  );
  // The graph validation authority is exported (the frozen §4 MUST list).
  assert.ok(
    workflowsPublic.includes('validateWorkflowDefinitionContent'),
    'the graph validation authority must be exported from the public entry',
  );
  // The frozen typed node/edge class lists are exported and closed.
  assert.deepEqual(
    [...WORKFLOW_NODE_TYPES].length,
    12,
    'the frozen node class list has exactly the twelve architecture.md §10 classes',
  );
  assert.deepEqual([...WORKFLOW_EDGE_TYPES].sort(), ['conditional', 'failure', 'join', 'success']);

  // Dependency matrix: /workflows ──→ /workspaces, /goals, /playbooks,
  // /executions, /policies, /audit. MKT-008 uses exactly the /workspaces +
  // /playbooks subset — the public entry must not import any other module.
  const imports = [...workflowsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['playbooks', 'workspaces'],
    'public.ts may only import /workspaces and /playbooks among module publics (a subset of the frozen matrix row for /workflows)',
  );
  for (const forbidden of [
    'auth',
    'users',
    'agencies',
    'clients',
    'executions',
    'deployments',
    'policies',
    'audit',
    'jobs',
    'evidence',
    'goals',
  ]) {
    assert.ok(
      !imports.includes(forbidden),
      `/workflows must not depend on /${forbidden} (MKT-008 uses the /workspaces + /playbooks subset of the frozen matrix)`,
    );
  }
});

test('no execution/deployment/runtime authority and no floating version pointer in the /workflows implementation', () => {
  // The module implementation composes /workspaces + /playbooks canonical
  // ownership — it never re-derives and never invents an authority.
  assert.ok(
    workflowsModule.includes('resolveWorkspaceOwnership'),
    'the workflows module must resolve Workspace ownership THROUGH /workspaces',
  );
  assert.ok(
    workflowsModule.includes('resolveWorkflowOwnership'),
    'the workflows module must own the canonical workflow owner resolution',
  );
  assert.ok(
    workflowsModule.includes('validateWorkflowDefinitionContent'),
    'the workflows module must run the graph validation authority on every create/update',
  );
  // The route layer must use the shared authorize helpers (which resolve
  // canonical ownership first) — never a private permission engine.
  assert.ok(
    workflowsRoutes.includes('requireWorkflowAccess'),
    'workflow routes must authorize through the shared requireWorkflowAccess helper',
  );
  assert.ok(
    workflowsRoutes.includes('requireWorkspaceAccess'),
    'workspace-scoped workflow routes must authorize through requireWorkspaceAccess',
  );
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(workflowsRoutes),
    'workflow routes must not carry a private permission engine',
  );

  // No runtime/execution/deployment authority structures leak into the
  // module or its routes (architecture.md §10/§11). Structural markers,
  // not docstring words:
  //   - the routes file registers ONLY /api/workspaces/:workspaceId/
  //     workflows and /api/workflows/* paths (never run/instance/
  //     execution/deployment routes);
  const registeredPaths = [...workflowsRoutes.matchAll(/'\/api\/([\w:/:-]+)'/g)].map((match) =>
    match[1]!
      .replace(/:workspaceId|:workflowId|:definitionId|:instanceId/g, '')
      .replace(/\/+/g, '/'),
  );
  for (const path of registeredPaths) {
    assert.ok(
      path === 'workspaces/workflows' || path === 'workflows' || path.startsWith('workflows/'),
      `workflow routes must only register workflow paths (found '${path}')`,
    );
  }

  //   - the public contract exports EXACTLY the workflow-domain surface:
  //      the MKT-008 definition contract PLUS the MKT-009 §5 instance
  //      lifecycle state machine (records, the frozen transition table
  //      and its predicates — the "Workflow definition + instance state"
  //      authority of implementation-contract §1). Still NO run/execution/
  //      deployment authority types or functions and NO floating version
  //      pointer: content resolution happens only through explicit
  //      version references — downstream authorities pin an exact version.
  const exportedSymbols = [...workflowsPublic.matchAll(/export (?:interface|type|function|const) (\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(exportedSymbols)].sort(),
    [
      'EXECUTABLE_NODE_TYPES',
      'STRUCTURAL_NODE_TYPES',
      'WORKFLOW_DEFINITION_TRANSITIONS',
      'WORKFLOW_EDGE_TYPES',
      'WORKFLOW_INSTANCE_STATUSES',
      'WORKFLOW_INSTANCE_TERMINAL_STATUSES',
      'WORKFLOW_INSTANCE_TRANSITIONS',
      'WORKFLOW_NODE_TYPES',
      'WorkflowAgencySummary',
      'WorkflowClientRow',
      'WorkflowCompensationDeclaration',
      'WorkflowConcurrencyLimits',
      'WorkflowDefinitionContent',
      'WorkflowDefinitionRecord',
      'WorkflowDefinitionStatus',
      'WorkflowEdge',
      'WorkflowEdgeType',
      'WorkflowGraph',
      'WorkflowHumanApproval',
      'WorkflowIdempotencyKeyStrategy',
      'WorkflowInputMapping',
      'WorkflowInstanceRecord',
      'WorkflowInstanceStatus',
      'WorkflowInstanceTransitionOutcome',
      'WorkflowInstanceTransitionRecord',
      'WorkflowJoinContract',
      'WorkflowLoopContract',
      'WorkflowNode',
      'WorkflowNodeRetryPolicy',
      'WorkflowNodeTimeout',
      'WorkflowNodeType',
      'WorkflowOwnerContext',
      'WorkflowRecord',
      'WorkflowRetryPolicyDefaults',
      'WorkflowSchemaProperty',
      'WorkflowSchemaShape',
      'WorkflowTimeoutPolicy',
      'WorkflowsModuleApi',
      'WorkflowsModuleDeps',
      'composeWorkflowOwnerContext',
      'isLegalWorkflowDefinitionTransition',
      'isLegalWorkflowInstanceTransition',
      'isTerminalWorkflowInstanceStatus',
    ],
    'the public surface is exactly the workflow definition + instance lifecycle contract — any new export is a deliberate, reviewed change',
  );
  for (const symbol of exportedSymbols) {
    assert.ok(
      !/^(start|run|pause|resume|cancel|dispatch|execute|createInstance|WorkflowRun|WorkflowExecution|Execution)/i.test(
        symbol,
      ),
      `the public surface must not export execution/run authority '${symbol}'`,
    );
  }
  assert.ok(
    !/getLatest|latestVersion|currentVersion|resolveLatest/.test(workflowsPublic),
    'the public API must not expose a floating latest/current version pointer',
  );
  assert.ok(
    !/getLatest|latestVersion|currentVersion|resolveLatest/.test(workflowsRoutes),
    'the routes must not expose a floating latest/current version route',
  );
});

test('migration 009 indexes are exactly the one listing surface', () => {
  const createdIndexes = [...migration009.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    createdIndexes,
    ['workflows_workspace_idx'],
    'migration 009 indexes are exactly the workspace listing surface (definition lookups ride the PK and the UNIQUE fence)',
  );
});
