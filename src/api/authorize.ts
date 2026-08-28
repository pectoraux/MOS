/**
 * Server-side authorization helpers for identity routes (MKT-002), Client
 * tenancy routes (MKT-003), Workspace boundary routes (MKT-004), Goal
 * domain routes (MKT-006), credential-reference routes (MKT-005), Playbook
 * domain routes (MKT-007), Workflow definition routes (MKT-008) and
 * Execution lifecycle routes (MKT-010).
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
 *
 * MKT-004 (issue #11): Workspace is an organizational boundary inside one
 * Client — the SAME hard-boundary posture applies one level deeper. A
 * Workspace identifier is never an authorization credential (MKT-004-AC-02);
 * a foreign Workspace (owned by a Client of another Agency) is
 * indistinguishable from an unknown one (TENANT-AC-05), and the check
 * authorizes against the agency that owns the workspace's CLIENT — resolved
 * canonically BEFORE any dependent Workspace traversal.
 */

import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { AgencyRoleKey, AuthorizationContext } from '../modules/agencies/public.ts';
import type { ClientOwnerContext } from '../modules/clients/public.ts';
import type { CredentialRecord } from '../modules/credentials/public.ts';
import type { ExecutionOwnerContext } from '../modules/executions/public.ts';
import type { GoalOwnerContext } from '../modules/goals/public.ts';
import type { PlaybookOwnerContext } from '../modules/playbooks/public.ts';
import type { WorkflowOwnerContext } from '../modules/workflows/public.ts';
import type { WorkspaceOwnerContext } from '../modules/workspaces/public.ts';
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

/**
 * Workspace-scoped access check (issue #11 MKT-004-AC-02/03, TENANT-AC-05).
 *
 * Step 1 resolves the CANONICAL Workspace ownership from durable state
 * (workspace row → owning Client via /clients resolveClientOwnership → owning
 * Agency) BEFORE anything else — a deleted workspace tombstone, a deleted
 * Client tombstone or an unknown identifier is a uniform 404, all
 * indistinguishable. Step 2 authorizes the caller against the agency that
 * OWNS the workspace's Client, using the SAME durable membership authority as
 * requireClientAccess (no second authorization authority, MKT-004-AC-08):
 *
 *   - service principal and platform administrators pass;
 *   - a caller with NO membership in the owning agency gets the SAME 404 as
 *     for an unknown Workspace — a foreign Workspace identifier is not a
 *     traversal/existence oracle (TENANT-AC-05, security-threat-model
 *     "Cross-tenant traversal": negative tests using two Clients);
 *   - a suspended (disabled) membership or disabled identity never
 *     authorizes (403);
 *   - `roles` optionally restricts to specific agency roles (403 otherwise).
 *
 * Returns the canonical owner context the operation is scoped to. A
 * Workspace ID is NEVER itself an authorization credential — it only selects
 * WHICH durable ownership chain gets resolved.
 */
export async function requireWorkspaceAccess(
  modules: ApplicationModules,
  principal: Principal,
  workspaceId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<WorkspaceOwnerContext> {
  const ownership = await modules.workspaces.resolveWorkspaceOwnership(workspaceId);
  if (ownership === null) {
    throw new NotFoundError('workspace', workspaceId);
  }

  if (principal.kind === 'service') return ownership;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return ownership;

  const membership = context.memberships.find(
    (entry) => entry.agencyId === ownership.clientOwnership.client.agencyId,
  );
  if (membership === undefined) {
    // Hard boundary one level deeper: not a member of the agency owning the
    // workspace's CLIENT → indistinguishable from an unknown Workspace
    // (uniform 404, no cross-tenant oracle; rejection BEFORE any dependent
    // traversal — issue #11 MKT-004-AC-03).
    throw new NotFoundError('workspace', workspaceId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the workspace client agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return ownership;
}

/**
 * Goal-scoped access check (MKT-006, GOAL-AC-02).
 *
 * Step 1 resolves the CANONICAL Goal ownership from durable state (goal
 * row → owning Client via /clients resolveClientOwnership → owning Agency,
 * plus the scoped Workspace row when the Goal is workspace-scoped) BEFORE
 * anything else — an unknown goal, a goal whose Client is a deleted
 * tombstone: all resolve to a uniform 404, indistinguishable. Step 2
 * authorizes the caller against the agency that OWNS the goal's Client,
 * using the SAME durable membership authority as every other scoped check
 * (no second authorization authority):
 *
 *   - service principal and platform administrators pass;
 *   - a caller with NO membership in the owning agency gets the SAME 404 as
 *     for an unknown Goal — a foreign Goal identifier is not a
 *     traversal/existence oracle (GOAL-AC-02: a Goal can never be acted on
 *     outside its authorized Client scope; rejection happens BEFORE any
 *     dependent traversal);
 *   - a suspended (disabled) membership or disabled identity never
 *     authorizes (403);
 *   - `roles` optionally restricts to specific agency roles (403 otherwise).
 *
 * Returns the canonical owner context the operation is scoped to. A Goal
 * ID is NEVER itself an authorization credential — it only selects WHICH
 * durable ownership chain gets resolved.
 */
export async function requireGoalAccess(
  modules: ApplicationModules,
  principal: Principal,
  goalId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<GoalOwnerContext> {
  const ownership = await modules.goals.resolveGoalOwnership(goalId);
  if (ownership === null) {
    throw new NotFoundError('goal', goalId);
  }

  if (principal.kind === 'service') return ownership;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return ownership;

  const membership = context.memberships.find(
    (entry) => entry.agencyId === ownership.clientOwnership.client.agencyId,
  );
  if (membership === undefined) {
    // Hard boundary: not a member of the agency owning the goal's CLIENT →
    // indistinguishable from an unknown Goal (uniform 404, no cross-tenant
    // oracle; rejection BEFORE any dependent traversal — GOAL-AC-02).
    throw new NotFoundError('goal', goalId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the goal client agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return ownership;
}

/**
 * Playbook-scoped access check (MKT-007).
 *
 * Step 1 resolves the CANONICAL Playbook ownership from durable state
 * (playbook row → owning Agency directly for Agency-scoped reusable IP, or
 * playbook row → owning Client via /clients resolveClientOwnership → owning
 * Agency for Client-scoped playbooks, plus the linked Goal row when set)
 * BEFORE anything else — an unknown playbook and a playbook whose Client is
 * a deleted tombstone: all resolve to a uniform 404, indistinguishable.
 * Step 2 authorizes the caller against the OWNING agency, using the SAME
 * durable membership authority as every other scoped check (no second
 * authorization authority):
 *
 *   - service principal and platform administrators pass;
 *   - a caller with NO membership in the owning agency gets the SAME 404 as
 *     for an unknown Playbook — a foreign Playbook identifier is not a
 *     traversal/existence oracle (cross-tenant posture; rejection happens
 *     BEFORE any dependent traversal);
 *   - a suspended (disabled) membership or disabled identity never
 *     authorizes (403);
 *   - `roles` optionally restricts to specific agency roles (403 otherwise).
 *
 * Returns the canonical owner context the operation is scoped to. A
 * Playbook ID is NEVER itself an authorization credential — it only selects
 * WHICH durable ownership chain gets resolved.
 */
export async function requirePlaybookAccess(
  modules: ApplicationModules,
  principal: Principal,
  playbookId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<PlaybookOwnerContext> {
  const ownership = await modules.playbooks.resolvePlaybookOwnership(playbookId);
  if (ownership === null) {
    throw new NotFoundError('playbook', playbookId);
  }

  if (principal.kind === 'service') return ownership;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return ownership;

  const membership = context.memberships.find(
    (entry) => entry.agencyId === ownership.agency.agencyId,
  );
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown Playbook (uniform 404, no cross-tenant oracle;
    // rejection BEFORE any dependent traversal).
    throw new NotFoundError('playbook', playbookId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the playbook agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return ownership;
}

/**
 * Workflow-scoped access check (MKT-008).
 *
 * Step 1 resolves the CANONICAL Workflow ownership from durable state
 * (workflow row → its owning Workspace → the Client that owns it → the
 * owning Agency, all through /workspaces canonical owner resolution)
 * BEFORE anything else — an unknown workflow and a workflow whose
 * Workspace or Client is a deleted tombstone: all resolve to a uniform
 * 404, indistinguishable. Step 2 authorizes the caller against the OWNING
 * agency, using the SAME durable membership authority as every other
 * scoped check (no second authorization authority):
 *
 *   - service principal and platform administrators pass;
 *   - a caller with NO membership in the owning agency gets the SAME 404 as
 *     for an unknown Workflow — a foreign Workflow identifier is not a
 *     traversal/existence oracle (cross-tenant posture; rejection happens
 *     BEFORE any dependent traversal);
 *   - a suspended (disabled) membership or disabled identity never
 *     authorizes (403);
 *   - `roles` optionally restricts to specific agency roles (403 otherwise).
 *
 * Returns the canonical owner context the operation is scoped to. A
 * Workflow ID is NEVER itself an authorization credential — it only selects
 * WHICH durable ownership chain gets resolved.
 */
export async function requireWorkflowAccess(
  modules: ApplicationModules,
  principal: Principal,
  workflowId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<WorkflowOwnerContext> {
  const ownership = await modules.workflows.resolveWorkflowOwnership(workflowId);
  if (ownership === null) {
    throw new NotFoundError('workflow', workflowId);
  }

  if (principal.kind === 'service') return ownership;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return ownership;

  const membership = context.memberships.find(
    (entry) => entry.agencyId === ownership.agency.agencyId,
  );
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown Workflow (uniform 404, no cross-tenant oracle;
    // rejection BEFORE any dependent traversal).
    throw new NotFoundError('workflow', workflowId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the workflow agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return ownership;
}

/**
 * Execution-lifecycle access check (MKT-010).
 *
 * Step 1 loads the canonical Execution owner context (execution → its
 * Workspace → the owning Client → the owning Agency, all from durable
 * state): an unknown identifier OR a tombstoned boundary is a uniform 404
 * (indistinguishable). Step 2 authorizes the caller against the agency that
 * OWNS the execution's Workspace — the SAME durable membership authority as
 * every other scoped check (no second authorization authority):
 *
 *   - service principal and platform administrators pass;
 *   - a caller with NO membership in the owning agency gets the SAME 404 as
 *     for an unknown execution — a foreign execution id is not a
 *     traversal/existence oracle (cross-tenant posture);
 *   - a suspended membership or disabled identity never authorizes (403);
 *   - `roles` optionally restricts to specific agency roles (403 otherwise).
 */
export async function requireExecutionAccess(
  modules: ApplicationModules,
  principal: Principal,
  executionId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<ExecutionOwnerContext> {
  const ownership = await modules.executions.resolveExecutionOwnership(executionId);
  if (ownership === null) {
    throw new NotFoundError('execution', executionId);
  }

  if (principal.kind === 'service') return ownership;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return ownership;

  const membership = context.memberships.find(
    (entry) => entry.agencyId === ownership.agency.agencyId,
  );
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown Execution (uniform 404, no cross-tenant oracle;
    // rejection BEFORE any dependent traversal).
    throw new NotFoundError('execution', executionId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the execution agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return ownership;
}

/**
 * Credential-reference access check (MKT-005, issue #13 MKT-005-AC-05).
 *
 * Step 1 loads the durable credential reference: an unknown identifier OR a
 * deleted tombstone is a uniform 404 (indistinguishable). Step 2 authorizes
 * the caller against the agency that OWNS the reference — the SAME durable
 * membership authority as every other scoped check (no second authorization
 * authority):
 *
 *   - service principal and platform administrators pass;
 *   - a caller with NO membership in the owning agency gets the SAME 404 as
 *     for an unknown reference — a foreign credential id is not a
 *     traversal/existence oracle (cross-tenant posture);
 *   - a suspended membership or disabled identity never authorizes (403);
 *   - `roles` optionally restricts to specific agency roles (403 otherwise).
 *
 * Material RESOLUTION is never routed: this check guards only reference
 * management (create/list/read/lifecycle). The material itself resolves
 * exclusively inside the /credentials module for authorized server-side
 * execution contexts.
 */
export async function requireCredentialAccess(
  modules: ApplicationModules,
  principal: Principal,
  credentialId: string,
  roles?: ReadonlyArray<AgencyRoleKey>,
): Promise<CredentialRecord> {
  const reference = await modules.credentials.getCredentialReference(credentialId);
  if (reference === null || reference.status === 'deleted') {
    throw new NotFoundError('credential', credentialId);
  }

  if (principal.kind === 'service') return reference;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return reference;

  const membership = context.memberships.find((entry) => entry.agencyId === reference.agencyId);
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown reference (uniform 404, no cross-tenant oracle).
    throw new NotFoundError('credential', credentialId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the credential agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return reference;
}
