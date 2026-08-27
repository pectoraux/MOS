/**
 * Server-side authorization helpers for identity routes (MKT-002) and Client
 * tenancy routes (MKT-003).
 *
 * Every check resolves the caller's authorization context FRESH from durable
 * state (users + agency memberships in PostgreSQL) — headers, body fields or
 * client-side claims are never trusted (issue #6 security contract:
 * "frontend-only checks are never authoritative", "A raw Agency/User ID is
 * not an authorization credential").
 *
 * MKT-003 (issue #9): Client is the hard security/data boundary, so
 * cross-tenant probes get a UNIFORM 404 — a Client identifier belonging to
 * another Agency is indistinguishable from an unknown identifier (no
 * existence/traversal oracle, TENANT-AC-04). Intra-tenant failures (suspended
 * membership, wrong role) are 403s exactly like /agencies.
 */

import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { AgencyRoleKey, AuthorizationContext } from '../modules/agencies/public.ts';
import type { ClientOwnerContext } from '../modules/clients/public.ts';
import type { ApplicationModules } from './application.ts';

/**
 * True for callers that act at platform level: the internal service
 * principal (MKT-001 machine-to-machine) or a user holding the
 * platform_administrator role.
 */
export function isPlatformAdministrator(
  modules: ApplicationModules,
  principal: Principal,
  context: AuthorizationContext | null,
): boolean {
  if (principal.kind === 'service') return true;
  return context !== null && context.platformRoles.includes('platform_administrator');
}

/** Requires a platform administrator; ForbiddenError otherwise. */
export async function requirePlatformAdministrator(
  modules: ApplicationModules,
  principal: Principal,
): Promise<AuthorizationContext | null> {
  const context = await resolveContext(modules, principal);
  if (!isPlatformAdministrator(modules, principal, context)) {
    throw new ForbiddenError('Platform administrator role required');
  }
  return context;
}

/** Resolves the user's authorization context (null for non-user principals). */
export async function resolveContext(
  modules: ApplicationModules,
  principal: Principal,
): Promise<AuthorizationContext | null> {
  if (principal.kind !== 'user') return null;
  return modules.agencies.resolveAuthorizationContext(principal.userId);
}

/**
 * Agency-scoped access check. The agency must exist (404 otherwise — resolved
 * BEFORE any dependent traversal, implementation-contract §2). Allowed:
 * service principals, platform administrators, and users with an ACTIVE
 * membership in the agency (optionally restricted to `roles`). A disabled
 * membership or a disabled user never authorizes (MKT-002-AC-05).
 */
export async function requireAgencyAccess(
  modules: ApplicationModules,
  principal: Principal,
  agencyId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<void> {
  const agency = await modules.agencies.getAgency(agencyId);
  if (agency === null) {
    throw new NotFoundError('agency', agencyId);
  }

  if (principal.kind === 'service') return;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return;

  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined || membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in this agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
}

/**
 * Client-scoped access check (issue #9 MKT-003-AC-01/TENANT-AC-03/04).
 *
 * Step 1 resolves the CANONICAL Client ownership from durable state
 * (client row → owning Agency) BEFORE anything else — a deleted tombstone or
 * an unknown identifier is a uniform 404. Step 2 authorizes the caller
 * against the OWNING agency's durable membership state:
 *
 *   - service principal and platform administrators (platform operators,
 *     mirroring requireAgencyAccess) pass;
 *   - a caller with NO membership in the OWNING agency gets the SAME 404 as
 *     for an unknown Client — a foreign Client identifier is not a
 *     traversal/existence oracle (TENANT-AC-04, security-threat-model
 *     "Cross-tenant traversal");
 *   - a suspended (disabled) membership or disabled identity never
 *     authorizes (403, MKT-002-AC-05 semantics at Client scope);
 *   - `roles` optionally restricts to specific agency roles (403 otherwise).
 *
 * Returns the canonical owner context the operation is scoped to.
 */
export async function requireClientAccess(
  modules: ApplicationModules,
  principal: Principal,
  clientId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<ClientOwnerContext> {
  const ownership = await modules.clients.resolveClientOwnership(clientId);
  if (ownership === null) {
    throw new NotFoundError('client', clientId);
  }

  if (principal.kind === 'service') return ownership;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return ownership;

  const membership = context.memberships.find(
    (entry) => entry.agencyId === ownership.client.agencyId,
  );
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown Client (uniform 404, no cross-tenant oracle).
    throw new NotFoundError('client', clientId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the client agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return ownership;
}
