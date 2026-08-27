/**
 * /clients API routes (MKT-003).
 *
 *   POST   /api/agencies/:agencyId/clients             create (owner|admin|platform admin)
 *   GET    /api/agencies/:agencyId/clients             list live clients (any active member)
 *   GET    /api/clients/:clientId                      read (member of OWNING agency)
 *   GET    /api/clients/:clientId/ownership-context    canonical owner context (read-only)
 *   PATCH  /api/clients/:clientId/profile              rename (owner|admin|platform admin, CAS)
 *   PATCH  /api/clients/:clientId/status               lifecycle transition (owner|admin|platform admin, CAS)
 *
 * Client is the HARD security/data boundary (architecture.md §2). Every
 * Client-scoped route resolves the canonical owner from durable state
 * BEFORE authorize/validate/execute (implementation-contract §2 + §23
 * pipeline); cross-tenant identifiers yield a UNIFORM 404 (no
 * traversal/existence oracle — issue #9 TENANT-AC-04). Workspace
 * persistence/authorization is NOT here (MKT-004).
 */

import { NotFoundError } from '../platform/errors/errors.ts';
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
import { requireAgencyAccess, requireClientAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type { ClientOwnerContext, ClientRecord, ClientStatus } from '../modules/clients/public.ts';

const CLIENT_STATUS_PATTERN = /^(active|disabled|deleted)$/;
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Fields that are always server-derived on CREATE (TENANT-AC-02). */
const CLIENT_CREATE_AUTHORITY_FIELDS = [
  'clientId',
  'agencyId',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/**
 * CAS mutations legitimately receive `version` (the CAS token); `status` is
 * legitimate ONLY on the lifecycle route. Everything else is server-derived.
 */
const CLIENT_CAS_AUTHORITY_FIELDS = [
  'clientId',
  'agencyId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

function serializeClient(client: ClientRecord): Record<string, unknown> {
  return {
    clientId: client.clientId,
    agencyId: client.agencyId,
    name: client.name,
    slug: client.slug,
    status: client.status,
    version: client.version,
    ...(client.createdBy === null ? {} : { createdBy: client.createdBy }),
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

function serializeOwnerContext(ownership: ClientOwnerContext): Record<string, unknown> {
  return {
    scope: ownership.scope,
    client: serializeClient(ownership.client),
    agency: ownership.agency,
    resolvedAt: ownership.resolvedAt,
  };
}

export function registerClientsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('clients.api');

  /** Agency owner scope; 404 BEFORE any dependent traversal (§2). */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId };
  }

  /**
   * Canonical Client owner scope (MKT-003-AC-01): resolved from durable state
   * before authorize/validate/execute. Unknown, deleted and (for the caller)
   * foreign identifiers all surface as the same 404 here or in authorize —
   * never as a traversal.
   */
  async function clientOwner(clientId: string): Promise<OwnerScope> {
    const ownership = await modules.clients.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    return {
      kind: 'client',
      agencyId: ownership.client.agencyId,
      clientId: ownership.client.clientId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/clients — create a Client owned by the
  // Agency. Ownership (agencyId) comes from the PATH only; identity, status,
  // provenance and timestamps are server-derived (TENANT-AC-02).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/clients',
    defineMutationRoute<{ agencyId: string }, ClientRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; slug: string | undefined }>(ctx.request.body, {
          forbiddenKeys: CLIENT_CREATE_AUTHORITY_FIELDS,
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            slug: optionalString({ minLength: 2, maxLength: 63, pattern: SLUG_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; slug: string | undefined };
        return modules.clients.createClient({
          agencyId: ctx.params.agencyId,
          name: body.name,
          slug: body.slug,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('clients.client.created', undefined, {
          client_id: ctx.result.clientId,
          agency_id: ctx.result.agencyId,
          client_slug: ctx.result.slug,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'clients.client.created',
          targetType: 'client',
          targetId: ctx.result.clientId,
          afterVersion: ctx.result.version,
          idempotencyKey: `clients.client.created:${ctx.result.clientId}`,
          details: { slug: ctx.result.slug },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeClient(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/clients — live clients of the agency.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId/clients',
    defineQueryRoute<{ agencyId: string }, readonly ClientRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.clients.listClientsForAgency(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          clients: ctx.result.map(serializeClient),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId — read. Cross-tenant/unknown/deleted → 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId',
    defineQueryRoute<{ clientId: string }, ClientOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeClient(ctx.result.client)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/ownership-context — read-only evidence
  // surface for the CANONICAL owner context (MKT-003-AC-01): which Agency
  // owns this Client, resolved server-side from durable state. Informational
  // only — enforcement is per-route and never trusts client claims.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/ownership-context',
    defineQueryRoute<{ clientId: string }, ClientOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeOwnerContext(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/clients/:clientId/profile — CAS rename (slug immutable,
  // mirroring agencies). Disabled clients reject new use (409) without
  // rewriting history; deleted are 404 at owner resolution.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/clients/:clientId/profile',
    defineMutationRoute<{ clientId: string }, ClientRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['slug', 'status', ...CLIENT_CAS_AUTHORITY_FIELDS],
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; version: number };
        return modules.clients.updateClientProfile({
          clientId: ctx.params.clientId,
          name: body.name,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('clients.client.profile_updated', undefined, {
          client_id: ctx.result.clientId,
          agency_id: ctx.result.agencyId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'clients.client.profile_updated',
          targetType: 'client',
          targetId: ctx.result.clientId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `clients.client.profile_updated:${ctx.result.clientId}:${ctx.result.version}`,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeClient(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/clients/:clientId/status — lifecycle transition
  // (active ⇄ disabled → deleted terminal), CAS + frozen transition table.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/clients/:clientId/status',
    defineMutationRoute<{ clientId: string }, ClientRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['name', 'slug', ...CLIENT_CAS_AUTHORITY_FIELDS],
          fields: {
            status: stringField({ pattern: CLIENT_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: ClientStatus; version: number };
        return modules.clients.setClientStatus({
          clientId: ctx.params.clientId,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('clients.client.status_changed', undefined, {
          client_id: ctx.result.clientId,
          agency_id: ctx.result.agencyId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'clients.client.status_changed',
          targetType: 'client',
          targetId: ctx.result.clientId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `clients.client.status_changed:${ctx.result.clientId}:${ctx.result.version}`,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeClient(ctx.result)),
    }),
  );
}
