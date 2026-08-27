/**
 * /goals module implementation (MKT-006).
 *
 * Owns the goals table: Goal identity, measurable content, lifecycle and
 * the canonical owner resolution every Goal-scoped operation must pass
 * through (implementation-contract §2: "Authorization MUST resolve the
 * canonical owner before dependent traversal"). The owning Client is
 * resolved THROUGH /clients resolveClientOwnership and the optional
 * Workspace scope THROUGH /workspaces resolveWorkspaceOwnership — the
 * /goals module never re-derives ownership and never bypasses it.
 * Agency/membership authorization stays in /agencies (dependency matrix:
 * /goals ──→ /clients, /workspaces); this module composes Goal ownership
 * WITH that authority — it never invents a second one, and it introduces
 * NO workflow/playbook/execution authority (a Goal is not a workflow,
 * architecture.md §7).
 *
 * Concurrency (MKT-006): lifecycle/content mutations are row-locked CAS
 * transactions with deterministic conflict behavior. Authorization derives
 * from durable state on every call — no process-local cache authority.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { GoalsModuleApi, GoalsModuleDeps } from '../public.ts';
import { composeGoalOwnerContext, isLegalGoalTransition } from '../public.ts';
import {
  assertMeasurableCriteria,
  assertValidTimeHorizon,
  GoalsStore,
} from './goals-store.ts';

export function createGoalsModule(deps: GoalsModuleDeps): GoalsModuleApi {
  const store = new GoalsStore(deps.db, deps.clock, deps.ids);
  const { clients, workspaces } = deps;

  return {
    async createGoal(input) {
      // CANONICAL Client owner resolution from durable state BEFORE any write.
      // Unknown or tombstoned Client → 404; disabled Client blocks new use
      // (409) without rewriting history (mirrors /workspaces policy).
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; goals cannot be created`,
        );
      }

      // Optional Workspace scope: resolved canonically THROUGH /workspaces.
      // Unknown, tombstoned, or belonging to a DIFFERENT Client → uniform
      // 404 (a foreign workspace identifier is not a traversal/existence
      // oracle — GOAL-AC-02 posture); disabled Workspace blocks new use.
      // The DB scope trigger is the final backstop against races.
      if (input.workspaceId !== null) {
        const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
        if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== input.clientId) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (workspaceOwnership.workspace.status !== 'active') {
          throw new ConflictError(
            `workspace ${input.workspaceId} is ${workspaceOwnership.workspace.status}; goals cannot be scoped to it`,
          );
        }
      }

      // Measurability at the authority boundary (GOAL-AC-01): the module
      // itself never persists criteria that are not structurally measurable.
      assertMeasurableCriteria(input.successCriteria);
      assertValidTimeHorizon(input.timeHorizon);

      return store.insertGoal({
        clientId: input.clientId,
        workspaceId: input.workspaceId,
        objective: input.objective,
        successCriteria: input.successCriteria,
        metrics: input.metrics,
        constraints: input.constraints,
        timeHorizon: input.timeHorizon,
        actorId: input.actorId,
      });
    },

    async getGoal(goalId) {
      return store.getGoal(goalId);
    },

    async resolveGoalOwnership(goalId) {
      const goal = await store.getGoal(goalId);
      if (goal === null) return null;
      // Canonical Client ownership THROUGH /clients — the ONLY Client
      // ownership authority. A deleted (tombstoned) Client never resolves,
      // so a goal owned by a tombstoned Client is indistinguishable from
      // an unknown goal identifier (uniform 404 upstream).
      const clientOwnership = await clients.resolveClientOwnership(goal.clientId);
      if (clientOwnership === null) return null;
      // The Workspace row is exposed as-is for workspace-scoped goals
      // (tombstones included): deleting an organizational boundary never
      // erases Client-owned business history — liveness/activeness gates
      // NEW use only (updateGoalContent / activation).
      const workspace =
        goal.workspaceId === null ? null : await workspaces.getWorkspace(goal.workspaceId);
      return composeGoalOwnerContext(goal, clientOwnership, workspace, deps.clock.nowIso());
    },

    async listGoalsForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listGoalsForClient(clientId);
    },

    async updateGoalContent(input) {
      // Measurability holds across every content update too: criteria can
      // be re-baselined, but only onto structurally measurable shapes.
      assertMeasurableCriteria(input.successCriteria);
      assertValidTimeHorizon(input.timeHorizon);

      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await store.lockGoal(tx, input.goalId);
        if (current === null) {
          throw new NotFoundError('goal', input.goalId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `goal version mismatch: current version is ${current.version}`,
          );
        }
        // Terminal business history is immutable — ConflictError (the DB
        // terminal-frozen trigger is the final backstop).
        if (current.status === 'achieved' || current.status === 'abandoned') {
          throw new ConflictError(
            `goal ${input.goalId} is ${current.status} and frozen; content cannot be changed`,
          );
        }
        // Policy: content mutation is NEW use — it requires an ACTIVE
        // Client and, when workspace-scoped, an ACTIVE Workspace (disabled
        // boundaries block new use without rewriting history; a tombstoned
        // Client was already rejected as a uniform 404 at resolution —
        // re-checked fresh here inside the transaction).
        await assertBoundariesAllowNewUse(deps, current);

        const outcome = await store.updateGoalContentRow(tx, {
          goalId: input.goalId,
          objective: input.objective,
          successCriteria: input.successCriteria,
          metrics: input.metrics,
          constraints: input.constraints,
          timeHorizon: input.timeHorizon,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('goal update lost the version race');
        }
        const updated = await store.lockGoal(tx, input.goalId);
        if (updated === null) {
          throw new Error(`updated goal ${input.goalId} could not be read back`);
        }
        return updated;
      });
    },

    async setGoalStatus(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + frozen
        // transition table — deterministic conflict behavior under
        // concurrent lifecycle operations.
        const current = await store.lockGoal(tx, input.goalId);
        if (current === null) {
          throw new NotFoundError('goal', input.goalId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `goal version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalGoalTransition(current.status, input.status)) {
          throw new ConflictError(
            `illegal goal transition ${current.status} → ${input.status}`,
          );
        }
        // Boundary policy: activation is NEW use — a Goal may never
        // resurrect disabled-boundary authority. Terminal transitions
        // (achieved/abandoned) record history and stay available for any
        // non-terminal goal regardless of boundary state.
        if (input.status === 'active') {
          await assertBoundariesAllowNewUse(deps, current);
        }
        const outcome = await store.updateGoalStatusRow(tx, {
          goalId: input.goalId,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('goal update lost the version race');
        }
        const updated = await store.lockGoal(tx, input.goalId);
        if (updated === null) {
          throw new Error(`updated goal ${input.goalId} could not be read back`);
        }
        return updated;
      });
    },
  };
}

/**
 * Boundary policy shared by content updates and activation (new use):
 * the owning Client must be live and ACTIVE, and a workspace-scoped goal
 * requires its Workspace live and ACTIVE. Tombstoned boundaries surface as
 * the uniform 404 of the goal itself (never an oracle for which boundary
 * failed); disabled boundaries block new use (409) without rewriting
 * history. Resolved FRESH inside the caller's transaction — never cached.
 */
async function assertBoundariesAllowNewUse(
  deps: GoalsModuleDeps,
  goal: { goalId: string; clientId: string; workspaceId: string | null },
): Promise<void> {
  const client = await deps.clients.getClient(goal.clientId);
  if (client === null || client.status === 'deleted') {
    // A tombstoned Client is indistinguishable from an unknown goal — the
    // goal itself no longer resolves canonically.
    throw new NotFoundError('goal', goal.goalId);
  }
  if (client.status !== 'active') {
    throw new ConflictError(
      `client ${goal.clientId} is ${client.status}; its goals cannot be activated or edited`,
    );
  }
  if (goal.workspaceId !== null) {
    const workspace = await deps.workspaces.getWorkspace(goal.workspaceId);
    if (workspace === null || workspace.status === 'deleted') {
      throw new NotFoundError('goal', goal.goalId);
    }
    if (workspace.status !== 'active') {
      throw new ConflictError(
        `workspace ${goal.workspaceId} is ${workspace.status}; its goals cannot be activated or edited`,
      );
    }
  }
}
