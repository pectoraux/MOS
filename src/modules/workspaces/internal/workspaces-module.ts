/**
 * /workspaces module implementation (MKT-004).
 *
 * Owns the workspaces table: Workspace identity, Client→Workspace ownership
 * and the canonical owner resolution every Workspace-scoped operation must
 * pass through (implementation-contract §2: "Authorization MUST resolve the
 * canonical owner before dependent traversal"). The Client owner is resolved
 * THROUGH /clients resolveClientOwnership — the /workspaces module never
 * re-derives Client ownership and never bypasses it. Agency/membership
 * authorization stays in /agencies (dependency matrix: /workspaces ──→
 * /clients); this module composes Workspace ownership WITH that authority —
 * it never invents a second one (issue #11 MKT-004-AC-08).
 *
 * Concurrency (issue #11): creation is DB-fenced; lifecycle/profile mutations
 * are row-locked CAS transactions with deterministic conflict behavior.
 * Authorization derives from durable state on every call — no process-local
 * cache authority.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { WorkspacesModuleApi, WorkspacesModuleDeps } from '../public.ts';
import { composeWorkspaceOwnerContext, isLegalWorkspaceTransition } from '../public.ts';
import { assertValidWorkspaceSlug, WorkspacesStore, deriveWorkspaceSlug } from './workspaces-store.ts';

export function createWorkspacesModule(deps: WorkspacesModuleDeps): WorkspacesModuleApi {
  const store = new WorkspacesStore(deps.db, deps.clock, deps.ids);
  const { clients } = deps;

  return {
    async createWorkspace(input) {
      // CANONICAL Client owner resolution from durable state BEFORE any write
      // (issue #11 MKT-004-AC-02). Unknown or tombstoned Client → 404;
      // disabled Client blocks new use (409) without rewriting history.
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; workspaces cannot be created`,
        );
      }

      const slug =
        input.slug === undefined ? deriveWorkspaceSlug(input.name) : input.slug;
      assertValidWorkspaceSlug(slug);

      const inserted = await store.insertWorkspace({
        clientId: input.clientId,
        name: input.name,
        slug,
        actorId: input.actorId,
      });
      if (inserted === 'taken') {
        throw new ConflictError(
          `client ${input.clientId} already has a live workspace with slug '${slug}'`,
        );
      }
      return inserted;
    },

    async getWorkspace(workspaceId) {
      return store.getWorkspace(workspaceId);
    },

    async resolveWorkspaceOwnership(workspaceId) {
      const workspace = await store.getWorkspace(workspaceId);
      // Tombstones never resolve: a deleted Workspace is indistinguishable
      // from an unknown one at the ownership boundary (uniform 404 upstream).
      if (workspace === null || workspace.status === 'deleted') return null;
      // Canonical Client ownership THROUGH /clients — the ONLY Client
      // ownership authority. A deleted (tombstoned) Client never resolves, so
      // an orphaned workspace identifier is indistinguishable from unknown.
      const clientOwnership = await clients.resolveClientOwnership(workspace.clientId);
      if (clientOwnership === null) return null;
      return composeWorkspaceOwnerContext(workspace, clientOwnership, deps.clock.nowIso());
    },

    async listWorkspacesForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listLiveWorkspacesForClient(clientId);
    },

    async updateWorkspaceProfile(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await store.lockWorkspace(tx, input.workspaceId);
        if (current === null || current.status === 'deleted') {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `workspace version mismatch: current version is ${current.version}`,
          );
        }
        // Policy (issue #11 acceptance contract): a disabled workspace or a
        // disabled Client blocks new authorized use (409) without rewriting
        // history. Re-enable / client re-enable are the explicit paths.
        if (current.status !== 'active') {
          throw new ConflictError(
            `workspace ${input.workspaceId} is ${current.status}; profile changes require an active workspace (re-enable first)`,
          );
        }
        const client = await clients.getClient(current.clientId);
        if (client === null || client.status === 'deleted') {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (client.status !== 'active') {
          throw new ConflictError(
            `client ${current.clientId} is ${client.status}; workspace changes require an active client (re-enable the client first)`,
          );
        }
        const outcome = await store.updateWorkspaceRow(tx, {
          workspaceId: input.workspaceId,
          name: input.name,
          status: undefined,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('workspace update lost the version race');
        }
        const updated = await store.lockWorkspace(tx, input.workspaceId);
        if (updated === null) {
          throw new Error(`updated workspace ${input.workspaceId} could not be read back`);
        }
        return updated;
      });
    },

    async setWorkspaceStatus(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + frozen
        // transition table — deterministic conflict behavior under
        // concurrent lifecycle operations (issue #11 MKT-004-AC-07).
        const current = await store.lockWorkspace(tx, input.workspaceId);
        if (current === null) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (current.status === 'deleted') {
          // Terminal tombstone: replaying stale identifiers cannot resurrect.
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `workspace version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalWorkspaceTransition(current.status, input.status)) {
          throw new ConflictError(
            `illegal workspace transition ${current.status} → ${input.status}`,
          );
        }
        // Client policy (issue #11 security contract): a Workspace may never
        // resurrect Client authority for new use — a transition TO active
        // requires an active owning Client. Shrinking transitions (disable /
        // delete) stay available under a disabled Client without rewriting
        // any historical Client-owned record.
        if (input.status === 'active') {
          const client = await clients.getClient(current.clientId);
          if (client === null || client.status === 'deleted') {
            throw new NotFoundError('workspace', input.workspaceId);
          }
          if (client.status !== 'active') {
            throw new ConflictError(
              `client ${current.clientId} is ${client.status}; its workspaces cannot be (re-)enabled`,
            );
          }
        }
        const outcome = await store.updateWorkspaceRow(tx, {
          workspaceId: input.workspaceId,
          name: undefined,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('workspace update lost the version race');
        }
        const updated = await store.lockWorkspace(tx, input.workspaceId);
        if (updated === null) {
          throw new Error(`updated workspace ${input.workspaceId} could not be read back`);
        }
        return updated;
      });
    },
  };
}
