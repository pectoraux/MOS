/**
 * /agencies API routes (MKT-002).
 *
 *   POST   /api/agencies                                        create agency + owner (platform admin)
 *   GET    /api/agencies/:agencyId                              read (member | platform admin)
 *   PATCH  /api/agencies/:agencyId/profile                      rename (owner|admin|platform admin, CAS)
 *   PATCH  /api/agencies/:agencyId/status                       disable/enable (platform admin, CAS)
 *   GET    /api/agencies/:agencyId/memberships                  list (member | platform admin)
 *   POST   /api/agencies/:agencyId/memberships                  add member (owner|admin|platform admin)
 *   PATCH  /api/agencies/:agencyId/memberships/:membershipId    role XOR status change (owner|admin|platform admin, CAS)
 *
 * Client CRUD/isolation is NOT here (MKT-003) and neither is Workspace
 * authorization (MKT-004). Agency-scoped ownership is resolved from the route
 * path BEFORE any dependent traversal (implementation-contract §2); a
 * caller-supplied UUID is never an authorization (security-threat-model).
 */

import { InvalidRequestError, NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import { validateObject, intField, optionalString, stringField } from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireAgencyAccess, requirePlatformAdministrator } from './authorize.ts';
import type {
  AgencyRecord,
  AgencyRoleKey,
  MembershipRecord,
  MembershipStatus,
} from '../modules/agencies/public.ts';
import { AGENCY_ROLE_KEYS } from '../modules/agencies/public.ts';
import { isUuid } from '../platform/ids/ids.ts';

const AGENCY_ROLE_PATTERN = new RegExp(`^(${AGENCY_ROLE_KEYS.join('|')})$`);
const AGENCY_STATUS_PATTERN = /^(active|disabled)$/;
const MEMBERSHIP_STATUS_PATTERN = /^(active|disabled|revoked)$/;
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Fields that are always server-derived on CREATE. */
const AGENCY_CREATE_AUTHORITY_FIELDS = [
  'agencyId',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'ownerMembershipId',
] as const;

/** CAS mutations legitimately receive `version` (the CAS token); the rest is server-derived. */
const AGENCY_CAS_AUTHORITY_FIELDS = [
  'agencyId',
  'status',
  'createdBy',
  'createdAt',
  'updatedAt',
  'ownerMembershipId',
] as const;

function serializeAgency(agency: AgencyRecord): Record<string, unknown> {
  return {
    agencyId: agency.agencyId,
    name: agency.name,
    slug: agency.slug,
    status: agency.status,
    version: agency.version,
    createdAt: agency.createdAt,
    updatedAt: agency.updatedAt,
  };
}

function serializeMembership(membership: MembershipRecord): Record<string, unknown> {
  return {
    membershipId: membership.membershipId,
    agencyId: membership.agencyId,
    userId: membership.userId,
    role: membership.role,
    status: membership.status,
    version: membership.version,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
    ...(membership.revokedAt === null ? {} : { revokedAt: membership.revokedAt }),
  };
}

export function registerAgenciesRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('agencies.api');

  /** Resolves the canonical agency owner scope; 404 BEFORE dependent traversal. */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId };
  }

  // -------------------------------------------------------------------------
  // POST /api/agencies — platform admin provisions the commercial tenant.
  // The founding owner is resolved server-side (by id or by email) and the
  // agency_owner ROLE is assigned via a membership row — ownership is never
  // a column on agencies (role assignment ⟂ tenant ownership).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies',
    defineMutationRoute<
      Record<string, string>,
      { agency: AgencyRecord; ownerMembership: MembershipRecord }
    >({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) => {
        const body = validateObject<{
          name: string;
          slug: string | undefined;
          ownerUserId: string | undefined;
          ownerUserEmail: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: AGENCY_CREATE_AUTHORITY_FIELDS,
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            slug: optionalString({ minLength: 2, maxLength: 63, pattern: SLUG_PATTERN }),
            ownerUserId: optionalString({ minLength: 36, maxLength: 36 }),
            ownerUserEmail: optionalString({
              minLength: 3,
              maxLength: 254,
              pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            }),
          },
        });
        const hasId = body.ownerUserId !== undefined;
        const hasEmail = body.ownerUserEmail !== undefined;
        if (hasId === hasEmail) {
          throw new InvalidRequestError('Exactly one of ownerUserId or ownerUserEmail is required', [
            'body: supply ownerUserId XOR ownerUserEmail',
          ]);
        }
        if (hasId && !isUuid(body.ownerUserId!)) {
          throw new InvalidRequestError('ownerUserId must be a UUID', ['ownerUserId: not a UUID']);
        }
        return body;
      },
      execute: async (ctx) => {
        const body = ctx.validated as {
          name: string;
          slug: string | undefined;
          ownerUserId: string | undefined;
          ownerUserEmail: string | undefined;
        };
        let ownerUserId = body.ownerUserId;
        if (ownerUserId === undefined) {
          const owner = await modules.users.getUserByEmail(body.ownerUserEmail!);
          if (owner === null) {
            throw new NotFoundError('user (owner email)', body.ownerUserEmail!);
          }
          ownerUserId = owner.userId;
        }
        return modules.agencies.createAgency({
          name: body.name,
          slug: body.slug,
          ownerUserId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: (ctx) => {
        logger.info('agencies.agency.created', undefined, {
          agency_id: ctx.result.agency.agencyId,
          owner_membership_id: ctx.result.ownerMembership.membershipId,
          owner_user_id: ctx.result.ownerMembership.userId,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          agency: serializeAgency(ctx.result.agency),
          ownerMembership: serializeMembership(ctx.result.ownerMembership),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId',
    defineQueryRoute<{ agencyId: string }, AgencyRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        const agency = await modules.agencies.getAgency(ctx.params.agencyId);
        if (agency === null) {
          throw new NotFoundError('agency', ctx.params.agencyId);
        }
        return agency;
      },
      respond: (ctx) => jsonResponse(200, serializeAgency(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/agencies/:agencyId/profile (owner|admin|platform admin)
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/agencies/:agencyId/profile',
    defineMutationRoute<{ agencyId: string }, AgencyRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['slug', ...AGENCY_CAS_AUTHORITY_FIELDS],
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; version: number };
        return modules.agencies.updateAgencyProfile({
          agencyId: ctx.params.agencyId,
          name: body.name,
          expectedVersion: body.version,
        });
      },
      emit: (ctx) => {
        logger.info('agencies.agency.profile_updated', undefined, {
          agency_id: ctx.result.agencyId,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAgency(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/agencies/:agencyId/status (platform admin)
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/agencies/:agencyId/status',
    defineMutationRoute<{ agencyId: string }, AgencyRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['name', 'slug', ...AGENCY_CAS_AUTHORITY_FIELDS.filter((f) => f !== 'status')],
          fields: {
            status: stringField({ pattern: AGENCY_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: 'active' | 'disabled'; version: number };
        return modules.agencies.setAgencyStatus({
          agencyId: ctx.params.agencyId,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: (ctx) => {
        logger.info('agencies.agency.status_changed', undefined, {
          agency_id: ctx.result.agencyId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAgency(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/memberships
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId/memberships',
    defineQueryRoute<{ agencyId: string }, readonly MembershipRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.agencies.listMemberships(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          memberships: ctx.result.map(serializeMembership),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/memberships (owner|admin|platform admin)
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/memberships',
    defineMutationRoute<{ agencyId: string }, MembershipRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => {
        const body = validateObject<{
          userId: string | undefined;
          userEmail: string | undefined;
          role: string;
        }>(ctx.request.body, {
          forbiddenKeys: [
            'membershipId',
            'status',
            'version',
            'agencyId',
            'createdAt',
            'updatedAt',
            'revokedAt',
          ],
          fields: {
            userId: optionalString({ minLength: 36, maxLength: 36 }),
            userEmail: optionalString({
              minLength: 3,
              maxLength: 254,
              pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            }),
            role: stringField({ pattern: AGENCY_ROLE_PATTERN }),
          },
        });
        const hasId = body.userId !== undefined;
        const hasEmail = body.userEmail !== undefined;
        if (hasId === hasEmail) {
          throw new InvalidRequestError('Exactly one of userId or userEmail is required', [
            'body: supply userId XOR userEmail',
          ]);
        }
        if (hasId && !isUuid(body.userId!)) {
          throw new InvalidRequestError('userId must be a UUID', ['userId: not a UUID']);
        }
        return body;
      },
      execute: async (ctx) => {
        const body = ctx.validated as {
          userId: string | undefined;
          userEmail: string | undefined;
          role: AgencyRoleKey;
        };
        let userId = body.userId;
        if (userId === undefined) {
          const user = await modules.users.getUserByEmail(body.userEmail!);
          if (user === null) {
            throw new NotFoundError('user (email)', body.userEmail!);
          }
          userId = user.userId;
        }
        return modules.agencies.addMembership({
          agencyId: ctx.params.agencyId,
          userId,
          role: body.role,
        });
      },
      emit: (ctx) => {
        logger.info('agencies.membership.created', undefined, {
          membership_id: ctx.result.membershipId,
          agency_id: ctx.result.agencyId,
          member_user_id: ctx.result.userId,
          role: ctx.result.role,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(201, serializeMembership(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/agencies/:agencyId/memberships/:membershipId
  // (owner|admin|platform admin; role XOR status; CAS version)
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/agencies/:agencyId/memberships/:membershipId',
    defineMutationRoute<{ agencyId: string; membershipId: string }, MembershipRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          role: string | undefined;
          status: string | undefined;
          version: number;
        }>(ctx.request.body, {
          forbiddenKeys: [
            'membershipId',
            'agencyId',
            'userId',
            'createdAt',
            'updatedAt',
            'revokedAt',
          ],
          fields: {
            role: optionalString({ pattern: AGENCY_ROLE_PATTERN }),
            status: optionalString({ pattern: MEMBERSHIP_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          role: AgencyRoleKey | undefined;
          status: MembershipStatus | undefined;
          version: number;
        };
        // The membership must belong to the path agency — a foreign
        // membership id is never actionable through this route.
        const membership = await modules.agencies.listMemberships(ctx.params.agencyId);
        if (!membership.some((entry) => entry.membershipId === ctx.params.membershipId)) {
          throw new NotFoundError('membership', ctx.params.membershipId);
        }
        return modules.agencies.updateMembership({
          membershipId: ctx.params.membershipId,
          role: body.role,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: (ctx) => {
        logger.info('agencies.membership.updated', undefined, {
          membership_id: ctx.result.membershipId,
          agency_id: ctx.result.agencyId,
          member_user_id: ctx.result.userId,
          role: ctx.result.role,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeMembership(ctx.result)),
    }),
  );
}
