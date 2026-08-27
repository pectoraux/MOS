/**
 * /credentials module implementation (MKT-005, CRED-001).
 *
 * Owns the credential_references table: opaque credential references with
 * immutable tenant scope, lifecycle and an opaque backend handle. Secret
 * material is resolved EXCLUSIVELY here, through the platform SecretStore
 * port, after a fail-closed scope check — never persisted, never logged,
 * never serialized to any durable surface (implementation-contract §21).
 *
 * Agency membership/role authorization is NOT re-implemented here (no
 * second authorization authority): routes resolve the caller's agency
 * authorization through /agencies exactly like MKT-003/004, and the
 * module-level resolution scope is supplied by authorized server-side
 * callers from durable ownership state.
 *
 * Concurrency (issue #13): creation is DB-fenced; lifecycle mutations are
 * row-locked CAS transactions. Creation fails closed when the secret
 * backend cannot resolve the handle — dangling references are refused.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  CredentialsModuleApi,
  CredentialsModuleDeps,
} from '../public.ts';
import { isLegalCredentialTransition } from '../public.ts';
import {
  assertValidCredentialKind,
  assertValidCredentialLabel,
  assertValidSecretHandle,
  CredentialsStore,
} from './credentials-store.ts';

export function createCredentialsModule(deps: CredentialsModuleDeps): CredentialsModuleApi {
  const store = new CredentialsStore(deps.db, deps.clock, deps.ids);
  const { secrets } = deps;

  return {
    async createCredentialReference(input) {
      assertValidCredentialKind(input.kind);
      assertValidCredentialLabel(input.label);
      assertValidSecretHandle(input.secretHandle);

      // Fail closed: a reference whose handle does not resolve in the
      // configured secret backend is refused up front (no dangling
      // references). This checks RESOLVABILITY, never the material itself.
      const handleResolvable = await secrets.exists(input.secretHandle);
      if (!handleResolvable) {
        throw new ConflictError(
          `secret handle '${input.secretHandle}' does not resolve in the configured secret backend`,
        );
      }

      const inserted = await store.insertCredentialReference({
        agencyId: input.agencyId,
        clientId: input.clientId,
        kind: input.kind,
        label: input.label,
        secretHandle: input.secretHandle,
        actorId: input.actorId,
      });
      if (inserted === 'taken') {
        throw new ConflictError(
          `agency ${input.agencyId} already has a live credential reference with label '${input.label}'`,
        );
      }
      return inserted;
    },

    async getCredentialReference(credentialId) {
      return store.getCredentialReference(credentialId);
    },

    async listCredentialReferences(agencyId) {
      return store.listLiveCredentialReferences(agencyId);
    },

    async setCredentialStatus(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + frozen
        // transition table — deterministic conflict behavior under
        // concurrent lifecycle operations.
        const current = await store.lockCredentialReference(tx, input.credentialId);
        if (current === null || current.status === 'deleted') {
          // Terminal tombstone: replaying stale identifiers cannot resurrect.
          throw new NotFoundError('credential', input.credentialId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `credential version mismatch: current version is ${current.version}`,
          );
        }
        if (!isLegalCredentialTransition(current.status, input.status)) {
          throw new ConflictError(
            `illegal credential transition ${current.status} → ${input.status}`,
          );
        }
        const outcome = await store.updateCredentialReferenceStatus(tx, {
          credentialId: input.credentialId,
          status: input.status,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('credential update lost the version race');
        }
        const updated = await store.lockCredentialReference(tx, input.credentialId);
        if (updated === null) {
          throw new Error(`updated credential ${input.credentialId} could not be read back`);
        }
        return updated;
      });
    },

    async resolveCredentialMaterial(input) {
      const reference = await store.getCredentialReference(input.credentialId);
      // Uniform null: unknown, tombstoned or disabled references never
      // resolve (fail-closed; no existence oracle for foreign callers).
      if (reference === null || reference.status !== 'active') return null;

      // Exact scope match required: the requester's agency must own the
      // reference, and a Client-narrowed reference resolves ONLY in that
      // Client's scope (a credential ID is never an authorization — the
      // scope was resolved from durable ownership state by the caller).
      if (reference.agencyId !== input.scope.agencyId) return null;
      if (reference.clientId !== null && reference.clientId !== input.scope.clientId) {
        return null;
      }

      // The ONLY sanctioned handle→material path in the system. Fails
      // closed (throws) when the backend is unavailable.
      const material = await secrets.resolve(reference.secretHandle);
      return { credentialId: reference.credentialId, material };
    },
  };
}
