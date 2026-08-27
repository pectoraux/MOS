/**
 * /credentials API routes (MKT-005).
 *
 *   POST   /api/agencies/:agencyId/credentials            create reference (owner|admin|platform admin)
 *   GET    /api/agencies/:agencyId/credentials            list live references (any active member)
 *   GET    /api/credentials/:credentialId                 read reference (member of OWNING agency)
 *   PATCH  /api/credentials/:credentialId/status          lifecycle transition (owner|admin|platform admin, CAS)
 *
 * Credential references are OPAQUE, NON-SECRET records (CRED-001): the
 * routes accept only reference metadata (kind/label/scope + an opaque
 * backend handle) — never secret material — and the serialized response
 * never includes the backend handle. Material resolution has NO route: it
 * happens exclusively inside the /credentials module for authorized
 * server-side execution contexts (implementation-contract §21).
 *
 * Authorization follows the established hard-boundary posture: the owning
 * agency is resolved from durable reference state BEFORE authorize (uniform
 * 404 for unknown/deleted/foreign identifiers — no cross-tenant oracle).
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
import { validateObject, intField, optionalString, stringField } from '../platform/http/validation.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { requireAgencyAccess, requireCredentialAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type { CredentialRecord, CredentialStatus } from '../modules/credentials/public.ts';

const CREDENTIAL_STATUS_PATTERN = /^(active|disabled|deleted)$/;

/**
 * Fields that are always server-derived on CREATE — plus every
 * material-shaped key is rejected so nothing secret can even be smuggled
 * into a reference payload (defense in depth beyond the module guard).
 */
const CREDENTIAL_CREATE_AUTHORITY_FIELDS = [
  'credentialId',
  'agencyId',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Material-shaped keys are rejected outright on the reference surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
  'value',
] as const;

const CREDENTIAL_CAS_AUTHORITY_FIELDS = [
  'credentialId',
  'agencyId',
  'clientId',
  'kind',
  'label',
  'secretHandle',
  'createdBy',
  'createdAt',
  'updatedAt',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'accessKey',
  'value',
] as const;

function serializeCredential(reference: CredentialRecord): Record<string, unknown> {
  // Opaque, non-secret reference representation. Deliberately excludes the
  // backend handle: internal plumbing never leaves the server boundary.
  return {
    credentialId: reference.credentialId,
    agencyId: reference.agencyId,
    ...(reference.clientId === null ? {} : { clientId: reference.clientId }),
    kind: reference.kind,
    label: reference.label,
    status: reference.status,
    version: reference.version,
    ...(reference.createdBy === null ? {} : { createdBy: reference.createdBy }),
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
  };
}

export function registerCredentialsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('credentials.api');

  /** Resolves the canonical agency owner scope; 404 BEFORE dependent traversal. */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId };
  }

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/credentials — register a credential
  // REFERENCE (opaque, non-secret). The backend handle must already resolve
  // in the configured secret backend (fail closed inside the module).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/credentials',
    defineMutationRoute<{ agencyId: string }, CredentialRecord>({
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
          kind: string;
          label: string;
          secretHandle: string;
          clientId: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: CREDENTIAL_CREATE_AUTHORITY_FIELDS,
          fields: {
            kind: stringField({ minLength: 2, maxLength: 49 }),
            label: stringField({ minLength: 1, maxLength: 100 }),
            secretHandle: stringField({ minLength: 1, maxLength: 99 }),
            clientId: optionalString({ minLength: 36, maxLength: 36 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          kind: string;
          label: string;
          secretHandle: string;
          clientId: string | undefined;
        };
        // Client-scope narrowing requires the canonical Client ownership —
        // resolved from durable state, never from caller claims: the client
        // must exist, be live and BELONG to the path agency.
        let clientId: string | null = null;
        if (body.clientId !== undefined) {
          const ownership = await modules.clients.resolveClientOwnership(body.clientId);
          if (ownership === null || ownership.client.agencyId !== ctx.params.agencyId) {
            throw new NotFoundError('client', body.clientId);
          }
          clientId = ownership.client.clientId;
        }
        return modules.credentials.createCredentialReference({
          agencyId: ctx.params.agencyId,
          clientId,
          kind: body.kind,
          label: body.label,
          secretHandle: body.secretHandle,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('credentials.reference.created', undefined, {
          credential_id: ctx.result.credentialId,
          agency_id: ctx.result.agencyId,
          kind: ctx.result.kind,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'credentials.reference.created',
          targetType: 'credential',
          targetId: ctx.result.credentialId,
          afterVersion: ctx.result.version,
          idempotencyKey: `credentials.reference.created:${ctx.result.credentialId}`,
          details: { kind: ctx.result.kind, label: ctx.result.label },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeCredential(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/credentials — live references of the agency.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId/credentials',
    defineQueryRoute<{ agencyId: string }, readonly CredentialRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.credentials.listCredentialReferences(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          credentials: ctx.result.map(serializeCredential),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/credentials/:credentialId — read one reference (member of the
  // OWNING agency; uniform 404 for foreign/unknown/deleted).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/credentials/:credentialId',
    defineQueryRoute<{ credentialId: string }, CredentialRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireCredentialAccess(modules, ctx.principal, ctx.params.credentialId);
      },
      execute: async (ctx) => {
        const reference = await modules.credentials.getCredentialReference(ctx.params.credentialId);
        if (reference === null || reference.status === 'deleted') {
          throw new NotFoundError('credential', ctx.params.credentialId);
        }
        return reference;
      },
      respond: (ctx) => jsonResponse(200, serializeCredential(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/credentials/:credentialId/status — lifecycle transition
  // (owner|admin|platform admin, CAS; frozen transition table; deleted is
  // terminal).
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/credentials/:credentialId/status',
    defineMutationRoute<{ credentialId: string }, CredentialRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const reference = await modules.credentials.getCredentialReference(params.credentialId);
        if (reference === null) {
          throw new NotFoundError('credential', params.credentialId);
        }
        return reference.clientId === null
          ? { kind: 'agency', agencyId: reference.agencyId }
          : { kind: 'client', agencyId: reference.agencyId, clientId: reference.clientId };
      },
      authorize: async (ctx) => {
        await requireCredentialAccess(modules, ctx.principal, ctx.params.credentialId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: CREDENTIAL_CAS_AUTHORITY_FIELDS,
          fields: {
            status: stringField({ pattern: CREDENTIAL_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: CredentialStatus; version: number };
        return modules.credentials.setCredentialStatus({
          credentialId: ctx.params.credentialId,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('credentials.reference.status_changed', undefined, {
          credential_id: ctx.result.credentialId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'credentials.reference.status_changed',
          targetType: 'credential',
          targetId: ctx.result.credentialId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `credentials.reference.status_changed:${ctx.result.credentialId}:${ctx.result.version}`,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeCredential(ctx.result)),
    }),
  );
}
