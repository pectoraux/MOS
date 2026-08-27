/**
 * /workflows module implementation (MKT-008 — the Workflow DEFINITION
 * sub-authority of the frozen "Workflow definition + instance state"
 * authority, spec/implementation-contract.md §1).
 *
 * Owns the workflows + workflow_definitions tables: Workflow identity and
 * the Workspace-scoped ownership relation (scope chain Agency → Client →
 * Workspace → Workflow, with Client/Agency ownership SERVER-DERIVED from
 * the canonical /workspaces owner resolution), the versioned typed graph
 * definitions with their schemas and declarative policy blocks, the frozen
 * definition lifecycle (draft → review → active → retired, immutable after
 * activation) and the canonical owner resolution every workflow-scoped
 * operation must pass through (implementation-contract §2: "Authorization
 * MUST resolve the canonical owner before dependent traversal").
 *
 * Graph validation is THE authority here: every create and every content
 * update runs the exhaustive typed-graph validation (the frozen §4 MUST
 * list — dangling nodes/edges, invalid node types, impossible joins,
 * duplicate node IDs, illegal cycles, unresolved schema mappings, explicit
 * bounded loops) before anything is persisted, whatever the caller did
 * upstream. The optional Playbook-version provenance link is resolved
 * through /playbooks' EXPLICIT version reference (unknown, foreign or
 * Client-incompatible versions are uniformly unresolvable).
 *
 * This module introduces NO runtime authority: no workflow-instance state
 * machine, no run/task/execution lifecycle, no retry orchestration, no
 * deployment binding (architecture.md §10/§11 — the instance machine is
 * MKT-009's extension of this module; Executions are /executions,
 * MKT-010; deployment binding is /deployments, MKT-040). Agency/
 * membership authorization stays in /agencies (dependency matrix:
 * /workflows ──→ /workspaces, /playbooks for MKT-008); this module
 * composes Workflow ownership WITH that authority — it never invents a
 * second one.
 *
 * Concurrency (MKT-008): definition version-number assignment is
 * serialized by the workflow row lock; content/lifecycle mutations are
 * row-locked CAS transactions with deterministic conflict behavior.
 * Authorization derives from durable state on every call — no
 * process-local cache authority.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { WorkflowsModuleApi, WorkflowsModuleDeps } from '../public.ts';
import { composeWorkflowOwnerContext, isLegalWorkflowDefinitionTransition } from '../public.ts';
import { validateWorkflowDefinitionContent } from './workflow-graph.ts';
import { WorkflowsStore } from './workflows-store.ts';

export function createWorkflowsModule(deps: WorkflowsModuleDeps): WorkflowsModuleApi {
  const store = new WorkflowsStore(deps.db, deps.clock, deps.ids);
  const { workspaces, playbooks } = deps;

  return {
    async createWorkflow(input) {
      // CANONICAL Workspace owner resolution from durable state BEFORE any
      // write: the workspace row → its Client → the owning Agency. Unknown
      // or tombstoned Workspace/Client → 404; disabled boundaries block new
      // use (409) without rewriting history.
      const ownership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', input.workspaceId);
      }
      if (ownership.workspace.status !== 'active') {
        throw new ConflictError(
          `workspace ${input.workspaceId} is ${ownership.workspace.status}; workflows cannot be created in it`,
        );
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${ownership.client.clientId} is ${ownership.client.status}; workflows cannot be created for it`,
        );
      }
      if (ownership.clientOwnership.agency.status !== 'active') {
        throw new ConflictError(
          `agency ${ownership.clientOwnership.agency.agencyId} is ${ownership.clientOwnership.agency.status}; workflows cannot be created in it`,
        );
      }

      return store.insertWorkflow({
        workspaceId: ownership.workspace.workspaceId,
        // Client and Agency ownership are SERVER-DERIVED from the
        // canonical Workspace owner — never caller inputs.
        clientId: ownership.client.clientId,
        agencyId: ownership.clientOwnership.agency.agencyId,
        name: input.name,
        description: input.description,
        actorId: input.actorId,
      });
    },

    async getWorkflow(workflowId) {
      return store.getWorkflow(workflowId);
    },

    async resolveWorkflowOwnership(workflowId) {
      const workflow = await store.getWorkflow(workflowId);
      if (workflow === null) return null;

      // Canonical Workspace owner resolution THROUGH /workspaces — the
      // ONLY Workspace ownership authority. A deleted (tombstoned)
      // Workspace or Client never resolves, so a workflow owned by a
      // tombstoned boundary is indistinguishable from an unknown workflow
      // identifier (uniform 404 upstream).
      const ownership = await workspaces.resolveWorkspaceOwnership(workflow.workspaceId);
      if (ownership === null) return null;
      return composeWorkflowOwnerContext(
        workflow,
        ownership.workspace,
        ownership.client,
        ownership.clientOwnership.agency,
        deps.clock.nowIso(),
      );
    },

    async listWorkflowsForWorkspace(workspaceId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', workspaceId);
      }
      return store.listWorkflowsForWorkspace(workspaceId);
    },

    async updateWorkflowProfile(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await store.lockWorkflow(tx, input.workflowId);
        if (current === null) {
          throw new NotFoundError('workflow', input.workflowId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `workflow version mismatch: current version is ${current.version}`,
          );
        }
        // Policy: profile mutation is NEW use — it requires ACTIVE
        // Workspace, Client and Agency boundaries (a tombstoned boundary
        // was already rejected as a uniform 404 at resolution; re-checked
        // fresh here inside the transaction).
        await assertBoundariesAllowNewUse(deps, current);

        const outcome = await store.updateWorkflowProfileRow(tx, {
          workflowId: input.workflowId,
          name: input.name,
          description: input.description,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('workflow update lost the version race');
        }
        const updated = await store.lockWorkflow(tx, input.workflowId);
        if (updated === null) {
          throw new Error(`updated workflow ${input.workflowId} could not be read back`);
        }
        return updated;
      });
    },

    async createWorkflowDefinition(input) {
      // THE GRAPH AUTHORITY: the exhaustive typed-graph validation runs at
      // this module boundary on every create — the module itself never
      // persists an illegal graph, whatever the caller did upstream.
      assertValidDefinitionContent(input.content);

      return deps.db.transaction(async (tx) => {
        // The workflow row lock serializes version-number assignment:
        // concurrent creates get DISTINCT sequential numbers, and the
        // (workflow_id, version_number) UNIQUE fence never fires in
        // ordinary operation.
        const workflow = await store.lockWorkflow(tx, input.workflowId);
        if (workflow === null) {
          throw new NotFoundError('workflow', input.workflowId);
        }
        // Policy: creating a definition is NEW use — it requires ACTIVE
        // Workspace, Client and Agency boundaries.
        await assertBoundariesAllowNewUse(deps, workflow);

        if (input.playbookVersionId !== null) {
          await assertPlayablePlaybookVersion(deps, input.playbookVersionId, workflow.clientId);
        }

        return store.insertWorkflowDefinition(tx, {
          workflowId: input.workflowId,
          content: input.content,
          playbookVersionId: input.playbookVersionId,
          actorId: input.actorId,
        });
      });
    },

    async getWorkflowDefinition(definitionId) {
      // The EXPLICIT version reference: any lifecycle state, byte for
      // byte, forever — there is no floating resolution and no state
      // filtering anywhere.
      return store.getWorkflowDefinition(definitionId);
    },

    async listWorkflowDefinitions(workflowId) {
      // Canonical owner resolution before dependent traversal (§2).
      const workflow = await store.getWorkflow(workflowId);
      if (workflow === null) {
        throw new NotFoundError('workflow', workflowId);
      }
      const ownership = await workspaces.resolveWorkspaceOwnership(workflow.workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workflow', workflowId);
      }
      return store.listWorkflowDefinitions(workflowId);
    },

    async updateWorkflowDefinitionContent(input) {
      // Structural validity holds across every content update too: the
      // graph authority re-validates the full typed contract.
      assertValidDefinitionContent(input.content);

      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await store.lockWorkflowDefinition(tx, input.definitionId);
        if (current === null) {
          throw new NotFoundError('workflow definition', input.definitionId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `workflow definition version mismatch: current version is ${current.version}`,
          );
        }
        // ACTIVATED definitions are immutable ("immutable after
        // activation") and RETIRED definitions are frozen terminal
        // history — ConflictError (the DB active-immutability trigger is
        // the final backstop).
        if (current.status === 'active' || current.status === 'retired') {
          throw new ConflictError(
            `workflow definition ${input.definitionId} is ${current.status} and frozen; content cannot be changed`,
          );
        }
        // Policy: content mutation is NEW use — it requires ACTIVE
        // boundaries.
        const workflow = await store.lockWorkflow(tx, current.workflowId);
        if (workflow === null) {
          throw new NotFoundError('workflow definition', input.definitionId);
        }
        await assertBoundariesAllowNewUse(deps, workflow);

        const outcome = await store.updateWorkflowDefinitionContentRow(tx, {
          definitionId: input.definitionId,
          content: input.content,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('workflow definition update lost the version race');
        }
        const updated = await store.lockWorkflowDefinition(tx, input.definitionId);
        if (updated === null) {
          throw new Error(`updated workflow definition ${input.definitionId} could not be read back`);
        }
        return updated;
      });
    },

    async setWorkflowDefinitionStatus(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + frozen
        // transition table — deterministic conflict behavior under
        // concurrent lifecycle operations.
        const current = await store.lockWorkflowDefinition(tx, input.definitionId);
        if (current === null) {
          throw new NotFoundError('workflow definition', input.definitionId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `workflow definition version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalWorkflowDefinitionTransition(current.status, input.status)) {
          throw new ConflictError(
            `illegal workflow definition transition ${current.status} → ${input.status}`,
          );
        }
        // Boundary policy: ACTIVATION is NEW use. A definition may never
        // resurrect disabled-boundary authority. The editorial
        // draft → review transition and the history-recording
        // active → retired retirement stay available regardless of
        // boundary state.
        if (input.status === 'active') {
          const workflow = await store.lockWorkflow(tx, current.workflowId);
          if (workflow === null) {
            throw new NotFoundError('workflow definition', input.definitionId);
          }
          await assertBoundariesAllowNewUse(deps, workflow);
          // An ACTIVATED definition is immutable and deployable by
          // reference — it must never rest on a still-CAS-editable
          // playbook version: the pinned playbook version (when linked)
          // must be PUBLISHED (immutable itself). Retired and draft
          // playbook versions are rejected (a new definition version
          // links the successor).
          if (current.playbookVersionId !== null) {
            const playbookVersion = await playbooks.getPlaybookVersion(current.playbookVersionId);
            if (playbookVersion === null || playbookVersion.status !== 'published') {
              throw new ConflictError(
                `workflow definition ${input.definitionId} pins playbook version ${current.playbookVersionId} which is ${playbookVersion === null ? 'unresolvable' : playbookVersion.status}; activation requires a published playbook version`,
              );
            }
          }
        }
        const outcome = await store.updateWorkflowDefinitionStatusRow(tx, {
          definitionId: input.definitionId,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('workflow definition update lost the version race');
        }
        const updated = await store.lockWorkflowDefinition(tx, input.definitionId);
        if (updated === null) {
          throw new Error(`updated workflow definition ${input.definitionId} could not be read back`);
        }
        return updated;
      });
    },
  };
}

/**
 * The graph authority assertion: runs the exhaustive typed-graph
 * validation and surfaces every problem as one 422.
 */
function assertValidDefinitionContent(content: unknown): void {
  const problems = validateWorkflowDefinitionContent(content);
  if (problems.length > 0) {
    throw new InvalidRequestError('Workflow definition is not structurally valid', problems);
  }
}

/**
 * Playbook-version provenance resolution: the linked version must exist
 * and be USABLE by the workflow's Client — Agency-scoped reusable
 * operational IP (playbook client scope NULL) or a playbook of the SAME
 * Client that owns the workflow. Unknown, cross-Agency and cross-Client
 * versions are all the SAME uniform 404 (a foreign playbook version
 * identifier is not a traversal/existence oracle). Playbook version
 * lifecycle state does NOT gate the link (draft versions may be linked
 * while the workflow definition itself is still editable; only
 * ACTIVATION requires a published playbook version).
 */
async function assertPlayablePlaybookVersion(
  deps: WorkflowsModuleDeps,
  playbookVersionId: string,
  clientId: string,
): Promise<void> {
  const version = await deps.playbooks.getPlaybookVersion(playbookVersionId);
  if (version === null) {
    throw new NotFoundError('playbook version', playbookVersionId);
  }
  const playbook = await deps.playbooks.getPlaybook(version.playbookId);
  if (playbook === null || (playbook.clientId !== null && playbook.clientId !== clientId)) {
    throw new NotFoundError('playbook version', playbookVersionId);
  }
}

/**
 * Boundary policy shared by new-use mutations (profile updates, definition
 * creation, content updates, activation): the owning Workspace, its Client
 * and the owning Agency must all be live and ACTIVE. Tombstoned boundaries
 * surface as the uniform 404 of the workflow itself (never an oracle for
 * which boundary failed); disabled boundaries block new use (409) without
 * rewriting history. Resolved FRESH inside the caller's transaction —
 * never cached.
 */
async function assertBoundariesAllowNewUse(
  deps: WorkflowsModuleDeps,
  workflow: { workflowId: string; workspaceId: string },
): Promise<void> {
  const ownership = await deps.workspaces.resolveWorkspaceOwnership(workflow.workspaceId);
  if (ownership === null) {
    throw new NotFoundError('workflow', workflow.workflowId);
  }
  if (ownership.workspace.status !== 'active') {
    throw new ConflictError(
      `workspace ${ownership.workspace.workspaceId} is ${ownership.workspace.status}; its workflows cannot be used for new work`,
    );
  }
  if (ownership.client.status !== 'active') {
    throw new ConflictError(
      `client ${ownership.client.clientId} is ${ownership.client.status}; its workflows cannot be used for new work`,
    );
  }
  if (ownership.clientOwnership.agency.status !== 'active') {
    throw new ConflictError(
      `agency ${ownership.clientOwnership.agency.agencyId} is ${ownership.clientOwnership.agency.status}; its workflows cannot be used for new work`,
    );
  }
}
