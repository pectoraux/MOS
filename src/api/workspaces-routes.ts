/**
 * /workspaces API routes (MKT-004).
 *
 *   POST   /api/clients/:clientId/workspaces                create (owner|admin|platform admin)
 *   GET    /api/clients/:clientId/workspaces                list live workspaces (any active member)
 *   GET    /api/workspaces/:workspaceId                     read (member of the agency owning the CLIENT)
 *   GET    /api/workspaces/:workspaceId/ownership-context   canonical owner context (read-only)
 *   PATCH  /api/workspaces/:workspaceId/profile             rename (owner|admin|platform admin, CAS)
 *   PATCH  /api/workspaces/:workspaceId/status              lifecycle transition (owner|admin|platform admin, CAS)
 *
 * Workspace is an organizational/execution boundary inside exactly one Client
 * (architecture.md §2, tenant-runtime-model). The Client remains the HARD
 * security boundary. Every Workspace route resolves the canonical owner from
 * durable state BEFORE authorize/validate/execute (implementation-contract §2
 * + §23 pipeline): client-scoped routes resolve the /clients canonical owner;
 * workspace-scoped routes resolve the workspace → client → agency chain. A
 * Workspace ID is never an authorization credential, and cross-tenant
 * identifiers yield a UNIFORM 404 (no traversal/existence oracle — issue #11
 * TENANT-AC-05 / MKT-004-AC-03). Goals/Playbooks/Workflow/Execution are NOT
 * here (out of scope).
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
import { requireClientAccess, requireWorkspaceAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  WorkspaceOwnerContext,
  WorkspaceRecord,
  WorkspaceStatus,
} from '../modules/workspaces/public.ts';

const WORKSPACE_STATUS_PATTERN = /^(active|disabled|deleted)$/;
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Fields that are always server-derived on CREATE (issue #11 data contract). */
const WORKSPACE_CREATE_AUTHORITY_FIELDS = [
  'workspaceId',
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
const WORKSPACE_CAS_AUTHORITY_FIELDS = [
  'workspaceId',
  'clientId',
  'agencyId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

function serializeWorkspace(workspace: WorkspaceRecord): Record<string, unknown> {
  return {
    workspaceId: workspace.workspaceId,
    clientId: workspace.clientId,
    name: workspace.name,
    slug: workspace.slug,
    status: workspace.status,
    version: workspace.version,
    ...(workspace.createdBy === null ? {} : { createdBy: workspace.createdBy }),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function serializeOwnerContext(ownership: WorkspaceOwnerContext): Record<string, unknown> {
  return {
    scope: ownership.scope,
    workspace: serializeWorkspace(ownership.workspace),
    client: {
      clientId: ownership.client.clientId,
      agencyId: ownership.client.agencyId,
      name: ownership.client.name,
      slug: ownership.client.slug,
      status: ownership.client.status,
      version: ownership.client.version,
      ...(ownership.client.createdBy === null ? {} : { createdBy: ownership.client.createdBy }),
      createdAt: ownership.client.createdAt,
      updatedAt: ownership.client.updatedAt,
    },
    agency: ownership.clientOwnership.agency,
    resolvedAt: ownership.resolvedAt,
  };
}

export function registerWorkspacesRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('workspaces.api');

  /**
   * Canonical Client owner scope for Client-scoped Workspace routes: resolved
   * from durable state (through /clients canonical owner resolution) before
   * authorize/validate/execute. Unknown, deleted and (for the caller) foreign
   * Client identifiers all surface as the same 404 here or in authorize —
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

  /**
   * Canonical Workspace owner scope (MKT-004-AC-02): the workspace row → its
   * Client (through /clients) → the owning Agency, resolved from durable
   * state before authorize/validate/execute. Unknown, deleted-workspace,
   * deleted-client and (for the caller) foreign identifiers all surface as
   * the same 404 here or in authorize — never as a traversal.
   */
  async function workspaceOwner(workspaceId: string): Promise<OwnerScope> {
    const ownership = await modules.workspaces.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    return {
      kind: 'workspace',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/workspaces — create a Workspace owned by the
  // Client. Client ownership comes from the PATH and is resolved canonically
  // BEFORE authorization; Workspace identity, status, provenance and
  // timestamps are server-derived (issue #11 MKT-004-AC-01).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/workspaces',
    defineMutationRoute<{ clientId: string }, WorkspaceRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; slug: string | undefined }>(ctx.request.body, {
          forbiddenKeys: WORKSPACE_CREATE_AUTHORITY_FIELDS,
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            slug: optionalString({ minLength: 2, maxLength: 63, pattern: SLUG_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; slug: string | undefined };
        return modules.workspaces.createWorkspace({
          clientId: ctx.params.clientId,
          name: body.name,
          slug: body.slug,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('workspaces.workspace.created', undefined, {
          workspace_id: ctx.result.workspaceId,
          client_id: ctx.result.clientId,
          workspace_slug: ctx.result.slug,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workspaces.workspace.created',
          targetType: 'workspace',
          targetId: ctx.result.workspaceId,
          afterVersion: ctx.result.version,
          idempotencyKey: `workspaces.workspace.created:${ctx.result.workspaceId}`,
          details: { slug: ctx.result.slug },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeWorkspace(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/workspaces — live workspaces of the Client.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/workspaces',
    defineQueryRoute<{ clientId: string }, readonly WorkspaceRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.workspaces.listWorkspacesForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          workspaces: ctx.result.map(serializeWorkspace),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId — read. Cross-tenant/unknown/deleted →
  // uniform 404 (TENANT-AC-05).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workspaces/:workspaceId',
    defineQueryRoute<{ workspaceId: string }, WorkspaceOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.workspaces.resolveWorkspaceOwnership(
          ctx.params.workspaceId,
        );
        if (ownership === null) {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeWorkspace(ctx.result.workspace)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/ownership-context — read-only evidence
  // surface for the CANONICAL owner context (MKT-004-AC-02): which Client
  // owns this Workspace (and which Agency owns that Client), resolved
  // server-side from durable state. Informational only — enforcement is
  // per-route and never trusts client claims.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ownership-context',
    defineQueryRoute<{ workspaceId: string }, WorkspaceOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const ownership = await modules.workspaces.resolveWorkspaceOwnership(
          ctx.params.workspaceId,
        );
        if (ownership === null) {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeOwnerContext(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/workspaces/:workspaceId/profile — CAS rename (slug immutable,
  // mirroring clients). Disabled workspaces/clients reject new use (409)
  // without rewriting history; deleted are 404 at owner resolution.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/workspaces/:workspaceId/profile',
    defineMutationRoute<{ workspaceId: string }, WorkspaceRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['slug', 'status', ...WORKSPACE_CAS_AUTHORITY_FIELDS],
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; version: number };
        return modules.workspaces.updateWorkspaceProfile({
          workspaceId: ctx.params.workspaceId,
          name: body.name,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('workspaces.workspace.profile_updated', undefined, {
          workspace_id: ctx.result.workspaceId,
          client_id: ctx.result.clientId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workspaces.workspace.profile_updated',
          targetType: 'workspace',
          targetId: ctx.result.workspaceId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `workspaces.workspace.profile_updated:${ctx.result.workspaceId}:${ctx.result.version}`,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeWorkspace(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/workspaces/:workspaceId/status — lifecycle transition
  // (active ⇄ disabled → deleted terminal), CAS + frozen transition table.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/workspaces/:workspaceId/status',
    defineMutationRoute<{ workspaceId: string }, WorkspaceRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['name', 'slug', ...WORKSPACE_CAS_AUTHORITY_FIELDS],
          fields: {
            status: stringField({ pattern: WORKSPACE_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: WorkspaceStatus; version: number };
        return modules.workspaces.setWorkspaceStatus({
          workspaceId: ctx.params.workspaceId,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('workspaces.workspace.status_changed', undefined, {
          workspace_id: ctx.result.workspaceId,
          client_id: ctx.result.clientId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workspaces.workspace.status_changed',
          targetType: 'workspace',
          targetId: ctx.result.workspaceId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `workspaces.workspace.status_changed:${ctx.result.workspaceId}:${ctx.result.version}`,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeWorkspace(ctx.result)),
    }),
  );
}
