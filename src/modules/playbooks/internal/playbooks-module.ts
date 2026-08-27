/**
 * /playbooks module implementation (MKT-007).
 *
 * Owns the playbooks + playbook_versions tables: Playbook identity, the
 * Agency-or-Client ownership relation, the optional Goal link, the
 * versioned strategy content with its declarative deployment metadata, the
 * frozen version lifecycle and the canonical owner resolution every
 * playbook-scoped operation must pass through (implementation-contract §2:
 * "Authorization MUST resolve the canonical owner before dependent
 * traversal"). The owning Agency is resolved directly for Agency-scoped
 * playbooks and THROUGH /clients resolveClientOwnership for Client-scoped
 * playbooks; the optional Goal link is resolved THROUGH /goals — the
 * /playbooks module never re-derives ownership and never bypasses it.
 * Agency/membership authorization stays in /agencies (dependency matrix:
 * /playbooks ──→ /agencies, /clients, /goals); this module composes
 * Playbook ownership WITH that authority — it never invents a second one,
 * and it introduces NO workflow/deployment/execution authority
 * (architecture.md §8: Deployment references the exact Playbook Version
 * and does not mutate it; the versioned strategy artifact is used to
 * PRODUCE workflow definitions in MKT-008 — it is not one).
 *
 * Concurrency (MKT-007): version-number assignment is serialized by the
 * playbook row lock; content/lifecycle mutations are row-locked CAS
 * transactions with deterministic conflict behavior. Authorization derives
 * from durable state on every call — no process-local cache authority.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { PlaybooksModuleApi, PlaybooksModuleDeps } from '../public.ts';
import { composePlaybookOwnerContext, isLegalPlaybookVersionTransition } from '../public.ts';
import {
  assertValidDeploymentMetadata,
  assertValidStrategy,
  PlaybooksStore,
} from './playbooks-store.ts';

export function createPlaybooksModule(deps: PlaybooksModuleDeps): PlaybooksModuleApi {
  const store = new PlaybooksStore(deps.db, deps.clock, deps.ids);
  const { agencies, clients, goals } = deps;

  return {
    async createAgencyPlaybook(input) {
      // CANONICAL Agency resolution from durable state BEFORE any write.
      // Unknown Agency → 404; disabled Agency blocks new use (409)
      // without rewriting history.
      const agency = await agencies.getAgency(input.agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', input.agencyId);
      }
      if (agency.status !== 'active') {
        throw new ConflictError(
          `agency ${input.agencyId} is ${agency.status}; agency-scoped playbooks cannot be created`,
        );
      }

      return store.insertPlaybook({
        agencyId: input.agencyId,
        clientId: null,
        goalId: null,
        name: input.name,
        description: input.description,
        actorId: input.actorId,
      });
    },

    async createClientPlaybook(input) {
      // CANONICAL Client owner resolution from durable state BEFORE any
      // write. Unknown or tombstoned Client → 404; disabled Client blocks
      // new use (409) without rewriting history.
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; client-scoped playbooks cannot be created`,
        );
      }

      // Optional Goal link: resolved canonically THROUGH /goals. Unknown or
      // belonging to a DIFFERENT Client → uniform 404 (a foreign goal
      // identifier is not a traversal/existence oracle); the DB
      // goal-within-client trigger is the final backstop against races.
      // Goal lifecycle state does NOT gate the link (terminal goals are
      // concluded history, not boundaries — documented policy).
      if (input.goalId !== null) {
        const goal = await goals.getGoal(input.goalId);
        if (goal === null || goal.clientId !== input.clientId) {
          throw new NotFoundError('goal', input.goalId);
        }
      }

      return store.insertPlaybook({
        // Agency ownership is SERVER-DERIVED from the canonical Client
        // ownership — never a caller input.
        agencyId: ownership.client.agencyId,
        clientId: input.clientId,
        goalId: input.goalId,
        name: input.name,
        description: input.description,
        actorId: input.actorId,
      });
    },

    async getPlaybook(playbookId) {
      return store.getPlaybook(playbookId);
    },

    async resolvePlaybookOwnership(playbookId) {
      const playbook = await store.getPlaybook(playbookId);
      if (playbook === null) return null;

      // The owning Agency record — resolved through /agencies for BOTH
      // scopes (the /agencies module is the Agency authority; for
      // Client-scoped playbooks the agency_id column is itself derived
      // from canonical Client ownership at creation). An unknown Agency
      // (defensive — agencies carry no tombstone) never resolves.
      const agency = await agencies.getAgency(playbook.agencyId);
      if (agency === null) return null;

      if (playbook.clientId === null) {
        // Agency-scoped reusable operational IP: the owning Agency is the
        // canonical owner.
        return composePlaybookOwnerContext(playbook, agency, null, null, deps.clock.nowIso());
      }

      // Client-scoped: canonical Client ownership THROUGH /clients — the
      // ONLY Client ownership authority. A deleted (tombstoned) Client
      // never resolves, so a playbook owned by a tombstoned Client is
      // indistinguishable from an unknown playbook identifier (uniform 404
      // upstream).
      const clientOwnership = await clients.resolveClientOwnership(playbook.clientId);
      if (clientOwnership === null) return null;
      // The linked Goal row is exposed as-is (terminal goals included):
      // concluded business intent never erases the playbook's recorded
      // provenance — goal state gates nothing here.
      const goal = playbook.goalId === null ? null : await goals.getGoal(playbook.goalId);
      return composePlaybookOwnerContext(
        playbook,
        agency,
        clientOwnership,
        goal,
        deps.clock.nowIso(),
      );
    },

    async listPlaybooksForAgency(agencyId) {
      // Canonical owner resolution before dependent traversal (§2).
      const agency = await agencies.getAgency(agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', agencyId);
      }
      return store.listPlaybooksForAgency(agencyId);
    },

    async listPlaybooksForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listPlaybooksForClient(clientId);
    },

    async updatePlaybookProfile(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await store.lockPlaybook(tx, input.playbookId);
        if (current === null) {
          throw new NotFoundError('playbook', input.playbookId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `playbook version mismatch: current version is ${current.version}`,
          );
        }
        // Policy: profile mutation is NEW use — it requires an ACTIVE
        // owning Agency and, for Client-scoped playbooks, an ACTIVE
        // Client (disabled boundaries block new use without rewriting
        // history; a tombstoned Client was already rejected as a uniform
        // 404 at resolution — re-checked fresh here inside the
        // transaction).
        await assertBoundariesAllowNewUse(deps, current);

        const outcome = await store.updatePlaybookProfileRow(tx, {
          playbookId: input.playbookId,
          name: input.name,
          description: input.description,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('playbook update lost the version race');
        }
        const updated = await store.lockPlaybook(tx, input.playbookId);
        if (updated === null) {
          throw new Error(`updated playbook ${input.playbookId} could not be read back`);
        }
        return updated;
      });
    },

    async createPlaybookVersion(input) {
      // Structural validity at the authority boundary: the module itself
      // never persists a malformed strategy or deployment-metadata shape,
      // whatever the caller did upstream.
      assertValidStrategy(input.strategy);
      assertValidDeploymentMetadata(input.deploymentMetadata);

      return deps.db.transaction(async (tx) => {
        // The playbook row lock serializes version-number assignment:
        // concurrent creates get DISTINCT sequential numbers, and the
        // (playbook_id, version_number) UNIQUE fence never fires in
        // ordinary operation.
        const playbook = await store.lockPlaybook(tx, input.playbookId);
        if (playbook === null) {
          throw new NotFoundError('playbook', input.playbookId);
        }
        // Policy: creating a version is NEW use — it requires an ACTIVE
        // owning Agency and, for Client-scoped playbooks, an ACTIVE
        // Client.
        await assertBoundariesAllowNewUse(deps, playbook);

        return store.insertPlaybookVersion(tx, {
          playbookId: input.playbookId,
          strategy: input.strategy,
          deploymentMetadata: input.deploymentMetadata,
          actorId: input.actorId,
        });
      });
    },

    async getPlaybookVersion(versionId) {
      // The EXPLICIT version reference: any lifecycle state, byte for
      // byte, forever (PLAY-AC-02 contract end — there is no floating
      // resolution and no state filtering anywhere).
      return store.getPlaybookVersion(versionId);
    },

    async listPlaybookVersions(playbookId) {
      // Canonical owner resolution before dependent traversal (§2).
      const playbook = await store.getPlaybook(playbookId);
      if (playbook === null) {
        throw new NotFoundError('playbook', playbookId);
      }
      if (playbook.clientId !== null) {
        const ownership = await clients.resolveClientOwnership(playbook.clientId);
        if (ownership === null) {
          throw new NotFoundError('playbook', playbookId);
        }
      } else {
        const agency = await agencies.getAgency(playbook.agencyId);
        if (agency === null) {
          throw new NotFoundError('playbook', playbookId);
        }
      }
      return store.listPlaybookVersions(playbookId);
    },

    async updatePlaybookVersionContent(input) {
      // Structural validity holds across every content update too.
      assertValidStrategy(input.strategy);
      assertValidDeploymentMetadata(input.deploymentMetadata);

      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await store.lockPlaybookVersion(tx, input.versionId);
        if (current === null) {
          throw new NotFoundError('playbook version', input.versionId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `playbook version mismatch: current version is ${current.version}`,
          );
        }
        // PUBLISHED versions are immutable (PLAY-AC-01) and RETIRED
        // versions are frozen terminal history — ConflictError (the DB
        // published-immutable trigger is the final backstop).
        if (current.status === 'published' || current.status === 'retired') {
          throw new ConflictError(
            `playbook version ${input.versionId} is ${current.status} and frozen; content cannot be changed`,
          );
        }
        // Policy: content mutation is NEW use — it requires an ACTIVE
        // owning Agency and, for Client-scoped playbooks, an ACTIVE
        // Client.
        const playbook = await store.lockPlaybook(tx, current.playbookId);
        if (playbook === null) {
          throw new NotFoundError('playbook version', input.versionId);
        }
        await assertBoundariesAllowNewUse(deps, playbook);

        const outcome = await store.updatePlaybookVersionContentRow(tx, {
          versionId: input.versionId,
          strategy: input.strategy,
          deploymentMetadata: input.deploymentMetadata,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('playbook version update lost the version race');
        }
        const updated = await store.lockPlaybookVersion(tx, input.versionId);
        if (updated === null) {
          throw new Error(`updated playbook version ${input.versionId} could not be read back`);
        }
        return updated;
      });
    },

    async setPlaybookVersionStatus(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + frozen
        // transition table — deterministic conflict behavior under
        // concurrent lifecycle operations.
        const current = await store.lockPlaybookVersion(tx, input.versionId);
        if (current === null) {
          throw new NotFoundError('playbook version', input.versionId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `playbook version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalPlaybookVersionTransition(current.status, input.status)) {
          throw new ConflictError(
            `illegal playbook version transition ${current.status} → ${input.status}`,
          );
        }
        // Boundary policy: publication is activation — NEW use. A version
        // may never resurrect disabled-boundary authority. The editorial
        // draft → review transition and the history-recording
        // published → retired retirement stay available regardless of
        // boundary state.
        if (input.status === 'published') {
          const playbook = await store.lockPlaybook(tx, current.playbookId);
          if (playbook === null) {
            throw new NotFoundError('playbook version', input.versionId);
          }
          await assertBoundariesAllowNewUse(deps, playbook);
        }
        const outcome = await store.updatePlaybookVersionStatusRow(tx, {
          versionId: input.versionId,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('playbook version update lost the version race');
        }
        const updated = await store.lockPlaybookVersion(tx, input.versionId);
        if (updated === null) {
          throw new Error(`updated playbook version ${input.versionId} could not be read back`);
        }
        return updated;
      });
    },
  };
}

/**
 * Boundary policy shared by new-use mutations (profile updates, version
 * creation, content updates, publication): the owning Agency must be live
 * and ACTIVE, and a Client-scoped playbook requires its Client live and
 * ACTIVE. Tombstoned boundaries surface as the uniform 404 of the playbook
 * itself (never an oracle for which boundary failed); disabled boundaries
 * block new use (409) without rewriting history. Resolved FRESH inside the
 * caller's transaction — never cached.
 */
async function assertBoundariesAllowNewUse(
  deps: PlaybooksModuleDeps,
  playbook: { playbookId: string; agencyId: string; clientId: string | null },
): Promise<void> {
  const agency = await deps.agencies.getAgency(playbook.agencyId);
  if (agency === null) {
    throw new NotFoundError('playbook', playbook.playbookId);
  }
  if (agency.status !== 'active') {
    throw new ConflictError(
      `agency ${playbook.agencyId} is ${agency.status}; its playbooks cannot be used for new work`,
    );
  }
  if (playbook.clientId !== null) {
    const client = await deps.clients.getClient(playbook.clientId);
    if (client === null || client.status === 'deleted') {
      // A tombstoned Client is indistinguishable from an unknown playbook —
      // the playbook itself no longer resolves canonically.
      throw new NotFoundError('playbook', playbook.playbookId);
    }
    if (client.status !== 'active') {
      throw new ConflictError(
        `client ${playbook.clientId} is ${client.status}; its playbooks cannot be used for new work`,
      );
    }
  }
}
