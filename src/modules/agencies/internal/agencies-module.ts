/**
 * /agencies module implementation (MKT-002).
 *
 * Owns agencies + agency_memberships. User identity is resolved through the
 * /users public contract (dependency matrix: /agencies → /users, /auth).
 * Membership state changes are CAS-guarded and converge without lost updates;
 * duplicate memberships are DB-fenced; permission resolution derives from
 * durable state on every call (issue #6 concurrency contract).
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  AgenciesModuleApi,
  AgenciesModuleDeps,
  MembershipWithAgency,
} from '../public.ts';
import { composeAuthorizationContext, isLegalMembershipTransition } from '../public.ts';
import { AgenciesStore, assertValidSlug, deriveSlug } from './agencies-store.ts';

export function createAgenciesModule(deps: AgenciesModuleDeps): AgenciesModuleApi {
  const store = new AgenciesStore(deps.db, deps.clock, deps.ids);
  const { users } = deps;

  return {
    async createAgency(input) {
      const owner = await users.getUser(input.ownerUserId);
      if (owner === null) {
        throw new NotFoundError('user', input.ownerUserId);
      }
      const slug = input.slug === undefined ? deriveSlug(input.name) : input.slug;
      assertValidSlug(slug);

      const { agencyId } = await store.insertAgencyWithOwner({
        name: input.name,
        slug,
        ownerUserId: input.ownerUserId,
        actorId: input.actorId,
      });

      const agency = await store.requireAgency(agencyId);
      const memberships = await store.listMemberships(agencyId);
      const ownerMembership = memberships.find(
        (membership) => membership.userId === input.ownerUserId,
      );
      if (ownerMembership === undefined) {
        throw new Error(`owner membership for agency ${agencyId} was not created`);
      }
      return { agency, ownerMembership };
    },

    async getAgency(agencyId) {
      return store.getAgency(agencyId);
    },

    async updateAgencyProfile(input) {
      await store.requireAgency(input.agencyId);
      return store.updateAgencyProfile(input);
    },

    async setAgencyStatus(input) {
      await store.requireAgency(input.agencyId);
      return store.setAgencyStatus(input);
    },

    async listMemberships(agencyId) {
      await store.requireAgency(agencyId);
      return store.listMemberships(agencyId);
    },

    async addMembership(input) {
      const agency = await store.requireAgency(input.agencyId);
      if (agency.status !== 'active') {
        throw new ConflictError(`agency ${input.agencyId} is disabled; memberships cannot be added`);
      }
      const user = await users.getUser(input.userId);
      if (user === null) {
        throw new NotFoundError('user', input.userId);
      }
      const inserted = await store.insertMembership(input);
      if (inserted === 'taken') {
        throw new ConflictError(
          `user ${input.userId} already has a non-revoked membership in agency ${input.agencyId}`,
        );
      }
      return inserted;
    },

    async updateMembership(input) {
      if ((input.role === undefined) === (input.status === undefined)) {
        throw new InvalidRequestError('Exactly one of role or status must change', [
          'body: supply either role or status (not both, not neither)',
        ]);
      }

      try {
        return await deps.db.transaction(async (tx) => {
          // CAS-serialized: row lock + explicit version check.
          const current = await store.lockMembership(tx, input.membershipId);
          if (current === null) {
            throw new NotFoundError('membership', input.membershipId);
          }
          if (current.version !== input.expectedVersion) {
            throw new ConflictError(
              `membership version mismatch: current version is ${current.version}`,
            );
          }

          if (
            input.status !== undefined &&
            !isLegalMembershipTransition(current.status, input.status)
          ) {
            throw new ConflictError(
              `illegal membership transition ${current.status} → ${input.status}`,
            );
          }

          // Last-active-owner guard: demotion, disable or revocation of the
          // final active agency_owner would orphan the Agency. Owner rows are
          // locked so the invariant is checked race-free; the pathological
          // simultaneous demotion of the last two owners surfaces as a PG
          // deadlock which is mapped to a retryable conflict below.
          const losingOwnership =
            current.status === 'active' &&
            current.role === 'agency_owner' &&
            ((input.role !== undefined && input.role !== 'agency_owner') ||
              (input.status !== undefined && input.status !== 'active'));
          if (losingOwnership) {
            const others = await store.lockOtherActiveOwners(
              tx,
              current.agencyId,
              current.membershipId,
            );
            if (others.length === 0) {
              throw new ConflictError(
                'cannot remove the last active agency owner; grant agency_owner to another member first',
              );
            }
          }

          const outcome = await store.updateMembershipRow(tx, input);
          if (outcome !== 'ok') {
            // Row was locked and version-verified above; treat as lost race.
            throw new ConflictError('membership update lost the version race');
          }
          // Read back INSIDE the transaction so the returned record includes
          // the just-applied change.
          const updated = await store.getMembership(tx, input.membershipId);
          if (updated === null) {
            throw new Error(`updated membership ${input.membershipId} could not be read back`);
          }
          return updated;
        });
      } catch (error) {
        if (isPgDeadlock(error)) {
          throw new ConflictError(
            'concurrent membership updates deadlocked; retry with the current version',
          );
        }
        throw error;
      }
    },

    async listMembershipsForUser(userId) {
      return store.listMembershipsForUser(userId);
    },

    async resolveAuthorizationContext(userId) {
      const user = await users.getUser(userId);
      if (user === null) return null;
      const memberships: readonly MembershipWithAgency[] = await store.listMembershipsForUser(
        userId,
      );
      return composeAuthorizationContext(user, memberships, deps.clock.nowIso());
    },
  };
}

function isPgDeadlock(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === '40P01' ||
      (error as { code?: unknown }).code === '40P02')
  );
}
