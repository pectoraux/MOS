/**
 * MKT-009 static tests — the Workflow INSTANCE state machine is
 * structurally correct in the ACTUAL migration and module contract (pure
 * static analysis, no DB).
 *
 * Proofs (implementation-contract §5 "Workflow instance state machine":
 * "only /workflows may mutate workflow-instance state"; "transitions use
 * CAS/version checks"; "terminal states are immutable"; "duplicate
 * transition requests are idempotent"; state-machines.md "Workflow
 * Instance" DRAFT → READY → RUNNING with PAUSED/BLOCKED returns and
 * SUCCEEDED/FAILED/CANCELLED terminal; work-items.md MKT-009 "implement
 * one deterministic lifecycle authority for Workflow instances";
 * WF-AC-01..04 instance/state portions):
 *   1. migration 010 creates `workflow_instances` with the required
 *      contract fields: immutable opaque id, owning Workflow reference,
 *      the EXPLICIT pinned definition version reference, server-derived
 *      Workspace/Client/Agency scope, the §5 status with version CAS and
 *      provenance — and NO input/output payload, NO node-instance state,
 *      NO task columns (an instance is a lifecycle identity only; run
 *      semantics are /executions, MKT-010);
 *   2. the status CHECK enumerates EXACTLY the same eight §5 states as the
 *      code WORKFLOW_INSTANCE_STATUSES table, and the SQL predicate
 *      function `workflow_instance_transition_legal` encodes EXACTLY the
 *      nine legal edges of the code WORKFLOW_INSTANCE_TRANSITIONS table
 *      (persistence can never drift from code — WF-AC-01);
 *   3. the frozen-§5 trigger rejects every illegal status change on the
 *      instance row — including self-loops and every transition out of a
 *      TERMINAL state (terminal immutability backstopped by the database);
 *   4. the (workflow_instance_id, idempotency_key) UNIQUE fence on the
 *      append-only transition history exists (§5 "duplicate transition
 *      requests are idempotent") and the history table rejects UPDATE and
 *      DELETE (append-only evidence) — and, per the MKT-009 history-ledger
 *      erratum (spec/errata/MKT-009-history-ledger.md), the corrective
 *      migration 014 REPLACES the history trigger function with the
 *      current-status CONSISTENCY backstop: a recorded transition's
 *      from_status must equal the instance's durable current status
 *      (FOR UPDATE row resolution, fabricated-history and unknown-instance
 *      rejection — the same integrity guarantee as the execution and
 *      sandbox ledgers);
 *   5. the identity/pin/scope IMMUTABILITY triggers exist on
 *      workflow_instances (the pinned definition reference can never
 *      float; the instance can never cross the Workflow or tenant
 *      boundary) and the ACTIVE-definition pin trigger rejects any insert
 *      pinning a non-ACTIVE or foreign definition;
 *   6. the /workflows module owns the instance surface: the public
 *      WorkflowsModuleApi carries exactly the five instance operations
 *      (create/get/list/history/transition) with NO execution authority
 *      (no dispatch/execute/retry orchestration methods), the transition
 *      operation is the SINGLE mutation port, and the routes register the
 *      instance paths only under /api/workflows/:workflowId — the
 *      WF-AC-04 instance/state portion: only /workflows may mutate
 *      workflow-instance state;
 *   7. no floating version pointer anywhere on the instance surface:
 *      instances pin the EXPLICIT workflowDefinitionId and there is no
 *      latest/current resolution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_INSTANCE_TERMINAL_STATUSES,
  WORKFLOW_INSTANCE_TRANSITIONS,
} from '../../src/modules/workflows/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(repoRoot, 'src', 'platform', 'db', 'migrations');
const migration010 = readFileSync(
  join(migrationsDir, '010_workflow_instances.sql'),
  'utf8',
);
const migration014 = readFileSync(
  join(migrationsDir, '014_workflow_instance_history_backstop.sql'),
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

test('the workflow_instances table carries the required §5 lifecycle contract fields (MKT-009 data contract)', () => {
  const columns = columnsOf(createTableBlock(migration010, 'workflow_instances'));
  for (const required of [
    'workflow_instance_id', // immutable opaque identifier (server-generated)
    'workflow_id', // owning Workflow reference (the scope chain)
    'workflow_definition_id', // the EXPLICIT pinned definition version
    'workspace_id', // server-derived Workspace scope
    'client_id', // server-derived Client ownership
    'agency_id', // server-derived Agency ownership
    'status', // the frozen §5 state machine
    'created_by', // provenance (server-derived)
    'version', // CAS token ("transitions use CAS/version checks")
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `workflow_instances.${required} required`);
  }
  assert.ok(
    migration010.includes(
      "workflow_definition_id  uuid        NOT NULL REFERENCES workflow_definitions(workflow_definition_id)",
    ),
    'the pinned definition must be a NOT NULL FK to workflow_definitions',
  );
  assert.ok(
    !/workflow_definition_id\s+uuid[^\n]*ON DELETE CASCADE/.test(migration010),
    'the pinned definition FK must NOT cascade — an instance protects its pinned definition row',
  );
  // The instance is a LIFECYCLE IDENTITY ONLY: no run input/output payload,
  // no node-instance state, no task/execution structures.
  for (const forbidden of ['input_payload', 'run_input', 'output', 'node_instances', 'task_id', 'execution_id', 'current_node']) {
    assert.ok(
      !columns.includes(forbidden),
      `workflow_instances.${forbidden} is execution semantics (/executions, MKT-010) — absent here`,
    );
  }
});

test('the status CHECK and the SQL transition predicate describe EXACTLY the code §5 machine (WF-AC-01)', () => {
  const block = createTableBlock(migration010, 'workflow_instances');
  const statusCheck = block.match(/CHECK \(status IN \(([^)]*)\)\)/);
  assert.ok(statusCheck !== null, 'workflow_instances.status carries the §5 state CHECK');
  const sqlStatuses = statusCheck[1]!
    .split(',')
    .map((item) => item.trim().replace(/'/g, ''))
    .sort();
  assert.deepEqual(
    sqlStatuses,
    [...WORKFLOW_INSTANCE_STATUSES].slice().sort(),
    'the DB status CHECK enumerates EXACTLY the code WORKFLOW_INSTANCE_STATUSES table',
  );

  // The SQL predicate function encodes EXACTLY the code transition table:
  // the parsed SQL edge set equals the code edge set, edge for edge.
  const predicate = migration010.slice(
    migration010.indexOf('CREATE OR REPLACE FUNCTION workflow_instance_transition_legal'),
    migration010.indexOf('$$ LANGUAGE plpgsql IMMUTABLE;'),
  );
  assert.ok(predicate.length > 0, 'the frozen-§5 predicate function exists');
  const sqlEdges = sqlLegalEdges(predicate);
  const codeEdges = new Set<string>();
  for (const from of WORKFLOW_INSTANCE_STATUSES) {
    for (const to of WORKFLOW_INSTANCE_TRANSITIONS[from]) {
      codeEdges.add(`${from}→${to}`);
    }
  }
  assert.deepEqual(
    [...sqlEdges].sort(),
    [...codeEdges].sort(),
    'the SQL predicate and the code transition table describe the SAME nine frozen edges',
  );
  // Terminal states: no outgoing edges in either representation.
  for (const terminal of WORKFLOW_INSTANCE_TERMINAL_STATUSES) {
    assert.deepEqual(WORKFLOW_INSTANCE_TRANSITIONS[terminal], []);
    assert.ok(
      !predicate.includes(`(from_status = '${terminal}'`),
      `terminal ${terminal} must have no SQL outgoing edges`,
    );
  }
});

/** Parses the SQL predicate's legal (from → to) edges. */
function sqlLegalEdges(predicate: string): Set<string> {
  const normalized = predicate.replace(/\s+/g, ' ');
  const edges = new Set<string>();
  // Single-target disjuncts: (from_status = 'X' AND to_status = 'Y').
  for (const match of normalized.matchAll(/\(from_status = '(\w+)' AND to_status = '(\w+)'\)/g)) {
    edges.add(`${match[1]}→${match[2]}`);
  }
  // IN-list disjuncts: (from_status = 'X' AND to_status IN ('a', 'b', …)).
  for (const match of normalized.matchAll(
    /\(from_status = '(\w+)' AND to_status IN \(([^)]*)\)\)/g,
  )) {
    for (const target of match[2]!.split(',')) {
      edges.add(`${match[1]}→${target.trim().replace(/'/g, '')}`);
    }
  }
  return edges;
}

test('the DB backstops terminal immutability, the idempotency fence and the append-only history (§5 rules)', () => {
  // Terminal immutability + illegal transitions + self-loops rejected by
  // the instance-row trigger.
  assert.ok(
    migration010.includes('workflow_instances_frozen_state_machine'),
    'the frozen-§5 state-machine trigger exists on workflow_instances',
  );
  assert.ok(
    migration010.includes('terminal states are immutable'),
    'the trigger names terminal-state immutability',
  );
  assert.ok(
    migration010.includes('no self-loops in the frozen state machine'),
    'the trigger rejects self-transitions',
  );
  // §5 "duplicate transition requests are idempotent": the storage fence.
  assert.ok(
    migration010.includes('UNIQUE (workflow_instance_id, idempotency_key)'),
    'the (instance, idempotency_key) UNIQUE fence exists',
  );
  // The history table itself.
  const historyColumns = columnsOf(createTableBlock(migration010, 'workflow_instance_transitions'));
  for (const required of [
    'transition_id',
    'workflow_instance_id',
    'idempotency_key',
    'from_status',
    'to_status',
    'reason',
    'created_by',
    'created_at',
  ]) {
    assert.ok(historyColumns.includes(required), `workflow_instance_transitions.${required} required`);
  }
  assert.ok(
    migration010.includes('workflow_instance_transitions_append_only'),
    'the append-only trigger exists on the history table',
  );
  assert.ok(
    migration010.includes('BEFORE UPDATE OR DELETE ON workflow_instance_transitions'),
    'history rows reject UPDATE and DELETE',
  );
  assert.ok(
    migration010.includes('workflow_instance_transitions_legal'),
    'an illegal pair cannot even be recorded as history',
  );
});

test('the MKT-009 history-ledger erratum backstop: migration 014 gives the history trigger from_status consistency (spec/errata/MKT-009-history-ledger.md)', () => {
  // Migration 010 itself remains UNTOUCHED (applied and
  // checksummed-immutable on main): its history trigger verified only the
  // legal pair. The correction lives in migration 014 as a CREATE OR
  // REPLACE of the same trigger function — exactly the MKT-010 erratum
  // correction pattern for execution_transitions_legal().
  assert.ok(
    !migration010.includes('fabricated applied transition rejected'),
    'migration 010 itself is untouched (the backstop arrives via the corrective migration 014)',
  );
  assert.ok(
    migration014.includes(
      'CREATE OR REPLACE FUNCTION workflow_instance_transitions_legal()',
    ),
    'migration 014 replaces the history trigger function with the consistency-augmented body',
  );
  // The replaced body keeps the frozen-§5 legal-pair check FIRST (the
  // illegal-pair rejection is unchanged defense in depth).
  assert.ok(
    migration014.includes('illegal workflow instance transition % → % cannot be recorded'),
    'the replaced body keeps the frozen-§5 legal-pair check',
  );
  // THE CONSISTENCY BACKSTOP: the trigger resolves the instance's CURRENT
  // durable status concurrency-safely (FOR UPDATE — the authorized writer
  // already holds the row lock) and rejects fabricated history.
  assert.ok(
    /FROM workflow_instances\s+WHERE workflow_instance_id = NEW\.workflow_instance_id\s+FOR UPDATE/.test(
      migration014.replace(/\s+/g, ' '),
    ),
    'the history trigger resolves the instance row concurrency-safely (FOR UPDATE)',
  );
  assert.ok(
    migration014.includes('cannot record a transition for unknown workflow instance'),
    'a history row for an unknown instance is rejected',
  );
  assert.ok(
    migration014.includes('fabricated applied transition rejected'),
    'a fabricated-but-legal history row whose from_status mismatches the durable status is rejected',
  );
  // No scope over-reach: the corrective migration changes ONLY the trigger
  // function body — no table, no trigger wiring, no state machine, no
  // authority change (WF-AC-04 intact).
  assert.ok(
    !migration014.includes('CREATE TABLE'),
    'the corrective migration creates no table',
  );
  assert.ok(
    !migration014.includes('CREATE TRIGGER'),
    'the corrective migration rewires no trigger (the BEFORE INSERT wiring from migration 010 is unchanged)',
  );
  assert.ok(
    !migration014.includes('ALTER TABLE'),
    'the corrective migration alters no table shape',
  );
});

test('the identity/pin/scope immutability and ACTIVE-definition pin triggers exist (explicit-version contract)', () => {
  assert.ok(
    migration010.includes('workflow_instances_identity_immutable'),
    'the identity-immutability trigger exists on workflow_instances',
  );
  assert.ok(
    migration010.includes('definition reference is immutable'),
    'the pinned definition reference can never be reassigned (no floating version)',
  );
  assert.ok(
    migration010.includes('workflow_instances_scope_chain'),
    'the scope-chain trigger exists (workspace→client→agency backstop)',
  );
  assert.ok(
    migration010.includes('workflow_instances_active_definition'),
    'the ACTIVE-definition pin trigger exists on INSERT',
  );
  assert.ok(
    migration010.includes("wd.status = 'active'") &&
      migration010.includes('wd.workflow_id = NEW.workflow_id'),
    'the pin trigger requires an ACTIVE definition of the SAME workflow',
  );
});

test('the /workflows module owns the instance surface with ONE transition port and NO execution authority (WF-AC-04 instance portion)', () => {
  // The public API carries exactly the five instance operations.
  const apiBlock = workflowsPublic
    .slice(workflowsPublic.indexOf('export interface WorkflowsModuleApi'))
    .slice(0, workflowsPublic.indexOf('export interface WorkflowsModuleDeps') - workflowsPublic.indexOf('export interface WorkflowsModuleApi'));
  for (const operation of [
    'createWorkflowInstance(',
    'getWorkflowInstance(',
    'listWorkflowInstances(',
    'getWorkflowInstanceTransitions(',
    'transitionWorkflowInstance(',
  ]) {
    assert.ok(apiBlock.includes(operation), `WorkflowsModuleApi must expose ${operation}`);
  }
  // No execution/run/dispatch authority on the instance surface.
  for (const forbidden of [
    'dispatch',
    'executeWorkflow',
    'executeInstance',
    'runNode',
    'recordNodeOutcome',
    'produceTask',
    'createTask',
    'retryTransition',
  ]) {
    assert.ok(
      !apiBlock.includes(forbidden),
      `WorkflowsModuleApi must not carry execution authority '${forbidden}' (/executions, MKT-010)`,
    );
  }
  // The transition operation is the single mutation port, documented as
  // the §5 authority; the module implementation runs it under the row
  // lock with the idempotency check BEFORE CAS (converging duplicates).
  assert.ok(
    workflowsModule.includes('transitionWorkflowInstance'),
    'the module implements the transition port',
  );
  assert.ok(
    workflowsModule.includes('findTransitionByKey'),
    'the module checks the idempotency ledger before applying',
  );
  assert.ok(
    workflowsModule.includes('lockWorkflowInstance'),
    'every transition serializes on the instance row lock',
  );
  assert.ok(
    workflowsModule.includes('insertWorkflowInstanceTransition'),
    'every applied transition is recorded append-only',
  );
  // No second permission engine: routes authorize through the shared
  // helper, and the instance paths live only under the workflow route.
  assert.ok(workflowsRoutes.includes('requireWorkflowAccess'), 'routes authorize via requireWorkflowAccess');
  for (const path of [...workflowsRoutes.matchAll(/'\/api\/([\w:/:-]+)'/g)].map((m) =>
    m[1]!
      .replace(/:workspaceId|:workflowId|:definitionId|:instanceId/g, '')
      .replace(/\/+/, '/'),
  )) {
    assert.ok(
      path === 'workspaces/workflows' || path === 'workflows' || path.startsWith('workflows/'),
      `instance routes must stay under the workflow path (found '${path}')`,
    );
  }
});

test('no floating version pointer on the instance surface', () => {
  // Instances pin the EXPLICIT workflowDefinitionId; no latest/current
  // resolution exists anywhere in the module, the routes or the migration.
  for (const source of [workflowsPublic, workflowsRoutes, workflowsModule, migration010]) {
    assert.ok(
      !/getLatest|latestVersion|latestDefinition|resolveLatest/.test(source),
      'no floating latest-version pointer',
    );
  }
  assert.ok(
    workflowsPublic.includes('EXPLICIT workflow_definition_id reference') &&
      workflowsPublic.includes('EXPLICIT workflowDefinitionId (no floating "latest")'),
    'the public contract documents the explicit pin',
  );
});

test('the /workflows module internals hold exactly the expected files (module boundary intact)', () => {
  const internalFiles = readdirSync(
    join(repoRoot, 'src', 'modules', 'workflows', 'internal'),
  )
    .filter((name) => name.endsWith('.ts'))
    .sort();
  assert.deepEqual(internalFiles, [
    'workflow-graph.ts',
    'workflow-instances-store.ts',
    'workflows-module.ts',
    'workflows-store.ts',
  ]);
  assert.ok(
    existsSync(join(repoRoot, 'src', 'modules', 'workflows', 'public.ts')),
    'the single public entry exists',
  );
});
