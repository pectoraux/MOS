/**
 * /clients module implementation (MKT-003).
 *
 * Owns the clients table: Client identity, Agency→Client ownership and the
 * canonical owner resolution every Client-scoped operation must pass through
 * (implementation-contract §2: "Authorization MUST resolve the canonical
 * owner before dependent traversal"). Agency/membership authorization stays
 * in /agencies (dependency matrix: /clients ──→ /agencies, /auth); this
 * module composes Client ownership WITH that authority — it never invents a
 * second one.
 *
 * Concurrency (issue #9): creation is DB-fenced; lifecycle/profile mutations
 * are row-locked CAS transactions with deterministic conflict behavior.
 * Authorization derives from durable state on every call — no process-local
 * cache authority.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { ClientsModuleApi, ClientsModuleDeps } from '../public.ts';
import { composeClientOwnerContext, isLegalClientTransition } from '../public.ts';
import { assertValidClientSlug, ClientsStore, deriveClientSlug } from './clients-store.ts';

export function createClientsModule(deps: ClientsModuleDeps): ClientsModuleApi {
  const store = new ClientsStore(deps.db, deps.clock, deps.ids);
  const { agencies } = deps;

  return {
    async createClient(input) {
      // Agency ownership resolution from durable state BEFORE any write.
      const agency = await agencies.getAgency(input.agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', input.agencyId);
      }
      if (agency.status !== 'active') {
        throw new ConflictError(
          `agency ${input.agencyId} is disabled; clients cannot be created`,
        );
      }

      const slug = input.slug === undefined ? deriveClientSlug(input.name) : input.slug;
      assertValidClientSlug(slug);

      const inserted = await store.insertClient({
        agencyId: input.agencyId,
        name: input.name,
        slug,
        actorId: input.actorId,
      });
      if (inserted === 'taken') {
        throw new ConflictError(
          `agency ${input.agencyId} already has a live client with slug '${slug}'`,
        );
      }
      return inserted;
    },

    async getClient(clientId) {
      return store.getClient(clientId);
    },

    async resolveClientOwnership(clientId) {
      const client = await store.getClient(clientId);
      // Tombstones never resolve: a deleted Client is indistinguishable from
      // an unknown one at the ownership boundary (uniform 404 upstream).
      if (client === null || client.status === 'deleted') return null;
      const agency = await agencies.getAgency(client.agencyId);
      if (agency === null) return null; // defensive: FK guarantees existence
      return composeClientOwnerContext(client, agency, deps.clock.nowIso());
    },

    async listClientsForAgency(agencyId) {
      const agency = await agencies.getAgency(agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', agencyId);
      }
      return store.listLiveClientsForAgency(agencyId);
    },

    async updateClientProfile(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check.
        const current = await store.lockClient(tx, input.clientId);
        if (current === null) {
          throw new NotFoundError('client', input.clientId);
        }
        if (current.status === 'deleted') {
          throw new NotFoundError('client', input.clientId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `client version mismatch: current version is ${current.version}`,
          );
        }
        // Policy (MKT-003-AC-03): a disabled Client blocks new authorized use
        // without rewriting history. Re-enable is the explicit lifecycle path.
        if (current.status !== 'active') {
          throw new ConflictError(
            `client ${input.clientId} is ${current.status}; profile changes require an active client (re-enable first)`,
          );
        }
        const outcome = await store.updateClientRow(tx, {
          clientId: input.clientId,
          name: input.name,
          status: undefined,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('client update lost the version race');
        }
        const updated = await store.lockClient(tx, input.clientId);
        if (updated === null) {
          throw new Error(`updated client ${input.clientId} could not be read back`);
        }
        return updated;
      });
    },

    async setClientStatus(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + frozen
        // transition table — deterministic conflict behavior under
        // concurrent lifecycle operations (MKT-003-AC-02).
        const current = await store.lockClient(tx, input.clientId);
        if (current === null) {
          throw new NotFoundError('client', input.clientId);
        }
        if (current.status === 'deleted') {
          // Terminal tombstone: replaying stale identifiers cannot resurrect.
          throw new NotFoundError('client', input.clientId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `client version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalClientTransition(current.status, input.status)) {
          throw new ConflictError(
            `illegal client transition ${current.status} → ${input.status}`,
          );
        }
        const outcome = await store.updateClientRow(tx, {
          clientId: input.clientId,
          name: undefined,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('client update lost the version race');
        }
        const updated = await store.lockClient(tx, input.clientId);
        if (updated === null) {
          throw new Error(`updated client ${input.clientId} could not be read back`);
        }
        return updated;
      });
    },
  };
}
