/**
 * /playbooks API routes (MKT-007).
 *
 *   POST   /api/agencies/:agencyId/playbooks                    create Agency-scoped playbook (owner|admin|platform admin)
 *   GET    /api/agencies/:agencyId/playbooks                    list Agency-scoped reusable IP (any active member)
 *   POST   /api/clients/:clientId/playbooks                     create Client-scoped playbook, optional Goal link (owner|admin|platform admin)
 *   GET    /api/clients/:clientId/playbooks                     list Client-scoped playbooks (any active member)
 *   GET    /api/playbooks/:playbookId                           read (member of the owning agency)
 *   GET    /api/playbooks/:playbookId/ownership-context         canonical owner context (read-only)
 *   PATCH  /api/playbooks/:playbookId/profile                   CAS container profile update (owner|admin|platform admin)
 *   POST   /api/playbooks/:playbookId/versions                  create the next DRAFT version (owner|admin|platform admin)
 *   GET    /api/playbooks/:playbookId/versions                  list versions in ALL lifecycle states (any active member)
 *   GET    /api/playbooks/:playbookId/versions/:versionId       read the EXPLICIT version reference (any active member)
 *   PATCH  /api/playbooks/:playbookId/versions/:versionId/profile  CAS content update, draft/review only (owner|admin|platform admin)
 *   PATCH  /api/playbooks/:playbookId/versions/:versionId/status   CAS lifecycle transition (owner|admin|platform admin)
 *
 * The Playbook is the reusable, versioned strategy artifact (PLAY-001)
 * owned by an Agency (reusable operational IP) or a Client
 * (tenant-runtime-model ownership matrix). The Client remains the HARD
 * security boundary. Every route resolves the canonical owner from
 * durable state BEFORE authorize/validate/execute (implementation-contract
 * §2 + §23 pipeline): agency-scoped routes resolve the Agency;
 * client-scoped routes resolve the /clients canonical owner; playbook- and
 * version-scoped routes resolve the playbook → agency-or-client → agency
 * chain (plus the linked Goal row when set). A Playbook or version ID is
 * never an authorization credential, and cross-tenant identifiers yield a
 * UNIFORM 404 (no traversal/existence oracle).
 *
 * NO Workflow/Deployment/Execution authority is introduced here
 * (architecture.md §8): these routes persist versioned strategy content
 * and declarative deployment metadata only. The EXPLICIT version
 * reference surface (GET .../versions/:versionId — any lifecycle state,
 * byte for byte, forever) is the contract end future Workflow/Deployment
 * authorities pin (PLAY-AC-02); there is no floating "latest" route.
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
import {
  arrayField,
  intField,
  objectField,
  optionalArrayField,
  optionalString,
  recordField,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireAgencyAccess, requireClientAccess, requirePlaybookAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  PlaybookCapabilityRequirement,
  PlaybookDeploymentMetadata,
  PlaybookDomainPackRequirement,
  PlaybookOwnerContext,
  PlaybookRecord,
  PlaybookStrategy,
  PlaybookStrategyTemplate,
  PlaybookTrigger,
  PlaybookVersionRecord,
  PlaybookVersionStatus,
} from '../modules/playbooks/public.ts';

const PLAYBOOK_VERSION_STATUS_PATTERN = /^(draft|review|published|retired)$/;
const PLAYBOOK_CAPABILITY_KIND_PATTERN = /^(integration|extension)$/;
const PLAYBOOK_RUNTIME_CLASS_PATTERN =
  /^(pooled-worker|ephemeral-sandbox|persistent-sandbox|dedicated-runtime)$/;
const PLAYBOOK_TRIGGER_KIND_PATTERN = /^(manual|schedule|event)$/;

/** Fields that are always server-derived on CREATE (authority fields). */
const PLAYBOOK_CREATE_AUTHORITY_FIELDS = [
  'playbookId',
  'agencyId',
  'clientId',
  'version',
  'status',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/**
 * CAS mutations legitimately receive `version` (the CAS token); `status` is
 * legitimate ONLY on the version lifecycle route; the immutable ownership /
 * identity / provenance fields are rejected everywhere.
 */
const PLAYBOOK_CAS_AUTHORITY_FIELDS = [
  'playbookId',
  'agencyId',
  'clientId',
  'goalId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/** Fields that are always server-derived on version CREATE (authority fields). */
const PLAYBOOK_VERSION_CREATE_AUTHORITY_FIELDS = [
  'versionId',
  'playbookId',
  'versionNumber',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

const PLAYBOOK_VERSION_CAS_AUTHORITY_FIELDS = [
  'versionId',
  'playbookId',
  'versionNumber',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

// ---------------------------------------------------------------------------
// Strict field specs (strategy artifact + declarative deployment metadata)
// ---------------------------------------------------------------------------

const strategyTemplateField = objectField<{
  name: string;
  description: string | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    name: stringField({ minLength: 1, maxLength: 200 }),
    description: optionalString({ maxLength: 2000 }),
  },
});

const strategyField = objectField<{
  summary: string;
  templates: ReadonlyArray<{ name: string; description: string | undefined }>;
}>({
  forbiddenKeys: [],
  fields: {
    summary: stringField({ minLength: 1, maxLength: 2000 }),
    templates: arrayField({ minItems: 0, maxItems: 50, item: strategyTemplateField }),
  },
});

const domainPackField = objectField<{
  name: string;
  versionConstraint: string | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    name: stringField({ minLength: 1, maxLength: 100 }),
    versionConstraint: optionalString({ maxLength: 100 }),
  },
});

const capabilityField = objectField<{
  kind: string;
  name: string;
  versionConstraint: string | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    kind: stringField({ pattern: PLAYBOOK_CAPABILITY_KIND_PATTERN }),
    name: stringField({ minLength: 1, maxLength: 100 }),
    versionConstraint: optionalString({ maxLength: 100 }),
  },
});

const runtimeRequirementsField = objectField<{
  runtimeClass: string | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    runtimeClass: optionalString({ pattern: PLAYBOOK_RUNTIME_CLASS_PATTERN }),
  },
});

/**
 * Nullable runtime requirements: absent, explicit null (no requirements)
 * or a strict object with an optional runtime class from the frozen
 * compute-allocation list.
 */
const nullableRuntimeRequirementsField: FieldSpec<{ runtimeClass: string | undefined } | null> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined || value === null) return null;
    return runtimeRequirementsField.parse(value, problems);
  },
};

/**
 * Optional free-form trigger configuration: declarative data the future
 * Deployment authority resolves — structurally bounded (object, limited
 * key count), never interpreted here.
 */
const optionalConfigField: FieldSpec<Record<string, unknown> | undefined> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined) return undefined;
    return recordField({ maxDepthKeys: 20 }).parse(value, problems);
  },
};

const triggerField = objectField<{
  kind: string;
  config: Record<string, unknown> | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    kind: stringField({ pattern: PLAYBOOK_TRIGGER_KIND_PATTERN }),
    config: optionalConfigField,
  },
});

type ValidatedDeploymentMetadata = {
  readonly requiredDomainPacks?: ReadonlyArray<{ name: string; versionConstraint: string | undefined }> | undefined;
  readonly requiredCapabilities?: ReadonlyArray<{ kind: string; name: string; versionConstraint: string | undefined }> | undefined;
  readonly runtimeRequirements: { runtimeClass: string | undefined } | null;
  readonly triggers?: ReadonlyArray<{ kind: string; config: Record<string, unknown> | undefined }> | undefined;
};

/**
 * Nullable deployment metadata: absent or explicit null means "no declared
 * requirements" (normalized server-side to the empty metadata). Full
 * replacement semantics on content updates, exactly like the module input.
 */
const nullableDeploymentMetadataField: FieldSpec<ValidatedDeploymentMetadata | null> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined || value === null) return null;
    return objectField<ValidatedDeploymentMetadata>({
      forbiddenKeys: [],
      fields: {
        requiredDomainPacks: optionalArrayField({ minItems: 0, maxItems: 20, item: domainPackField }),
        requiredCapabilities: optionalArrayField({ minItems: 0, maxItems: 20, item: capabilityField }),
        runtimeRequirements: nullableRuntimeRequirementsField,
        triggers: optionalArrayField({ minItems: 0, maxItems: 20, item: triggerField }),
      },
    }).parse(value, problems);
  },
};

// ---------------------------------------------------------------------------
// Normalization → module input types
// ---------------------------------------------------------------------------

interface ValidatedStrategy {
  readonly summary: string;
  readonly templates: ReadonlyArray<{ name: string; description: string | undefined }>;
}

function toModuleStrategy(body: ValidatedStrategy): PlaybookStrategy {
  return {
    summary: body.summary,
    templates: body.templates.map(
      (template): PlaybookStrategyTemplate => ({
        name: template.name,
        description: template.description ?? null,
      }),
    ),
  };
}

function toModuleDeploymentMetadata(
  metadata: ValidatedDeploymentMetadata | null,
): PlaybookDeploymentMetadata {
  return {
    requiredDomainPacks: (metadata?.requiredDomainPacks ?? []).map(
      (pack): PlaybookDomainPackRequirement => ({
        name: pack.name,
        versionConstraint: pack.versionConstraint ?? null,
      }),
    ),
    requiredCapabilities: (metadata?.requiredCapabilities ?? []).map(
      (capability): PlaybookCapabilityRequirement => ({
        kind: capability.kind as PlaybookCapabilityRequirement['kind'],
        name: capability.name,
        versionConstraint: capability.versionConstraint ?? null,
      }),
    ),
    runtimeRequirements: {
      runtimeClass:
        metadata?.runtimeRequirements?.runtimeClass === undefined
          ? null
          : (metadata.runtimeRequirements.runtimeClass as PlaybookDeploymentMetadata['runtimeRequirements']['runtimeClass']),
    },
    triggers: (metadata?.triggers ?? []).map(
      (trigger): PlaybookTrigger => ({
        kind: trigger.kind as PlaybookTrigger['kind'],
        config: trigger.config === undefined ? null : trigger.config,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializePlaybook(playbook: PlaybookRecord): Record<string, unknown> {
  return {
    playbookId: playbook.playbookId,
    agencyId: playbook.agencyId,
    ...(playbook.clientId === null ? {} : { clientId: playbook.clientId }),
    ...(playbook.goalId === null ? {} : { goalId: playbook.goalId }),
    name: playbook.name,
    ...(playbook.description === '' ? {} : { description: playbook.description }),
    version: playbook.version,
    ...(playbook.createdBy === null ? {} : { createdBy: playbook.createdBy }),
    createdAt: playbook.createdAt,
    updatedAt: playbook.updatedAt,
  };
}

function serializePlaybookVersion(version: PlaybookVersionRecord): Record<string, unknown> {
  return {
    versionId: version.versionId,
    playbookId: version.playbookId,
    versionNumber: version.versionNumber,
    status: version.status,
    strategy: {
      summary: version.strategy.summary,
      templates: version.strategy.templates.map((template) => ({
        name: template.name,
        ...(template.description === null ? {} : { description: template.description }),
      })),
    },
    deploymentMetadata: {
      requiredDomainPacks: version.deploymentMetadata.requiredDomainPacks.map((pack) => ({
        name: pack.name,
        ...(pack.versionConstraint === null ? {} : { versionConstraint: pack.versionConstraint }),
      })),
      requiredCapabilities: version.deploymentMetadata.requiredCapabilities.map((capability) => ({
        kind: capability.kind,
        name: capability.name,
        ...(capability.versionConstraint === null
          ? {}
          : { versionConstraint: capability.versionConstraint }),
      })),
      runtimeRequirements:
        version.deploymentMetadata.runtimeRequirements.runtimeClass === null
          ? {}
          : { runtimeClass: version.deploymentMetadata.runtimeRequirements.runtimeClass },
      triggers: version.deploymentMetadata.triggers.map((trigger) => ({
        kind: trigger.kind,
        ...(trigger.config === null ? {} : { config: trigger.config }),
      })),
    },
    version: version.version,
    ...(version.createdBy === null ? {} : { createdBy: version.createdBy }),
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

function serializePlaybookOwnerContext(ownership: PlaybookOwnerContext): Record<string, unknown> {
  return {
    scope: ownership.scope,
    playbook: serializePlaybook(ownership.playbook),
    agency: {
      agencyId: ownership.agency.agencyId,
      name: ownership.agency.name,
      slug: ownership.agency.slug,
      status: ownership.agency.status,
      ...(ownership.agency.createdBy === null ? {} : { createdBy: ownership.agency.createdBy }),
      createdAt: ownership.agency.createdAt,
      updatedAt: ownership.agency.updatedAt,
    },
    ...(ownership.clientOwnership === null
      ? {}
      : {
          client: {
            clientId: ownership.clientOwnership.client.clientId,
            agencyId: ownership.clientOwnership.client.agencyId,
            name: ownership.clientOwnership.client.name,
            slug: ownership.clientOwnership.client.slug,
            status: ownership.clientOwnership.client.status,
            version: ownership.clientOwnership.client.version,
            ...(ownership.clientOwnership.client.createdBy === null
              ? {}
              : { createdBy: ownership.clientOwnership.client.createdBy }),
            createdAt: ownership.clientOwnership.client.createdAt,
            updatedAt: ownership.clientOwnership.client.updatedAt,
          },
        }),
    ...(ownership.goal === null
      ? {}
      : {
          goal: {
            goalId: ownership.goal.goalId,
            clientId: ownership.goal.clientId,
            objective: ownership.goal.objective,
            status: ownership.goal.status,
          },
        }),
    resolvedAt: ownership.resolvedAt,
  };
}

export function registerPlaybooksRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('playbooks.api');

  /**
   * Canonical Agency owner scope for Agency-scoped Playbook routes:
   * resolved from durable state before authorize/validate/execute.
   * Unknown Agency → 404.
   */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId: agency.agencyId };
  }

  /**
   * Canonical Client owner scope for Client-scoped Playbook routes:
   * resolved through /clients canonical owner resolution before
   * authorize/validate/execute. Unknown, deleted and (for the caller)
   * foreign Client identifiers all surface as the same 404 here or in
   * authorize — never as a traversal.
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
   * Canonical Playbook owner scope: the playbook row → its owning Agency
   * (directly, or through /clients for Client-scoped playbooks) → the
   * linked Goal row when set, resolved from durable state before
   * authorize/validate/execute. Unknown, deleted-client and (for the
   * caller) foreign identifiers all surface as the same 404 here or in
   * authorize — never as a traversal.
   */
  async function playbookOwner(playbookId: string): Promise<OwnerScope> {
    const ownership = await modules.playbooks.resolvePlaybookOwnership(playbookId);
    if (ownership === null) {
      throw new NotFoundError('playbook', playbookId);
    }
    return {
      kind: 'playbook',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      goalId: ownership.scope.goalId,
      playbookId: ownership.scope.playbookId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/playbooks — create an AGENCY-SCOPED
  // Playbook (reusable operational IP; client scope NULL). Agency ownership
  // comes from the PATH and is resolved canonically BEFORE authorization.
  // Playbook identity, provenance and timestamps are server-derived; the
  // client scope is deliberately NOT an input on this route (a Client
  // scope comes only from the Client-scoped route).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/playbooks',
    defineMutationRoute<{ agencyId: string }, PlaybookRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; description: string | undefined }>(ctx.request.body, {
          forbiddenKeys: [...PLAYBOOK_CREATE_AUTHORITY_FIELDS, 'goalId'],
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            description: optionalString({ maxLength: 2000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; description: string | undefined };
        return modules.playbooks.createAgencyPlaybook({
          agencyId: ctx.params.agencyId,
          name: body.name,
          description: body.description ?? '',
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('playbooks.playbook.created', undefined, {
          playbook_id: ctx.result.playbookId,
          agency_id: ctx.result.agencyId,
          client_scoped: false,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'playbooks.playbook.created',
          targetType: 'playbook',
          targetId: ctx.result.playbookId,
          afterVersion: ctx.result.version,
          idempotencyKey: `playbooks.playbook.created:${ctx.result.playbookId}`,
          details: { clientScoped: false },
        });
      },
      respond: (ctx) => jsonResponse(201, serializePlaybook(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/playbooks — the Agency's reusable
  // operational IP (Agency-scoped playbooks only; Client-scoped playbooks
  // list under their Client).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId/playbooks',
    defineQueryRoute<{ agencyId: string }, readonly PlaybookRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.playbooks.listPlaybooksForAgency(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          playbooks: ctx.result.map(serializePlaybook),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/playbooks — create a CLIENT-SCOPED
  // Playbook, optionally linked to a Goal of the SAME Client. Client
  // ownership comes from the PATH and is resolved canonically BEFORE
  // authorization; the optional goalId is scope INPUT (validated against
  // canonical goal ownership inside the module — never an authorization).
  // Agency ownership is SERVER-DERIVED from the canonical Client owner.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/playbooks',
    defineMutationRoute<{ clientId: string }, PlaybookRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          name: string;
          description: string | undefined;
          goalId: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: [...PLAYBOOK_CREATE_AUTHORITY_FIELDS, 'agencyId'],
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            description: optionalString({ maxLength: 2000 }),
            goalId: optionalString({ maxLength: 64 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          name: string;
          description: string | undefined;
          goalId: string | undefined;
        };
        return modules.playbooks.createClientPlaybook({
          clientId: ctx.params.clientId,
          goalId: body.goalId === undefined ? null : body.goalId,
          name: body.name,
          description: body.description ?? '',
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('playbooks.playbook.created', undefined, {
          playbook_id: ctx.result.playbookId,
          agency_id: ctx.result.agencyId,
          client_id: ctx.result.clientId,
          goal_id: ctx.result.goalId,
          client_scoped: true,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'playbooks.playbook.created',
          targetType: 'playbook',
          targetId: ctx.result.playbookId,
          afterVersion: ctx.result.version,
          idempotencyKey: `playbooks.playbook.created:${ctx.result.playbookId}`,
          details: { clientScoped: true, goalLinked: ctx.result.goalId !== null },
        });
      },
      respond: (ctx) => jsonResponse(201, serializePlaybook(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/playbooks — the Client's playbooks.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/playbooks',
    defineQueryRoute<{ clientId: string }, readonly PlaybookRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.playbooks.listPlaybooksForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          playbooks: ctx.result.map(serializePlaybook),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/playbooks/:playbookId — read. Cross-tenant/unknown/
  // deleted-client → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/playbooks/:playbookId',
    defineQueryRoute<{ playbookId: string }, PlaybookOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.playbooks.resolvePlaybookOwnership(ctx.params.playbookId);
        if (ownership === null) {
          throw new NotFoundError('playbook', ctx.params.playbookId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializePlaybook(ctx.result.playbook)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/playbooks/:playbookId/ownership-context — read-only evidence
  // surface for the CANONICAL owner context: which Agency owns this
  // Playbook (directly, or through which Client), plus the linked Goal
  // when set — resolved server-side from durable state. Informational
  // only — enforcement is per-route and never trusts client claims.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/playbooks/:playbookId/ownership-context',
    defineQueryRoute<{ playbookId: string }, PlaybookOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId);
      },
      execute: async (ctx) => {
        const ownership = await modules.playbooks.resolvePlaybookOwnership(ctx.params.playbookId);
        if (ownership === null) {
          throw new NotFoundError('playbook', ctx.params.playbookId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializePlaybookOwnerContext(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/playbooks/:playbookId/profile — CAS container profile
  // update (name, description). Ownership/scope/goal link and provenance
  // are immutable — rejected as authority fields.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/playbooks/:playbookId/profile',
    defineMutationRoute<{ playbookId: string }, PlaybookRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => playbookOwner(params.playbookId),
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; description: string | undefined; version: number }>(
          ctx.request.body,
          {
            forbiddenKeys: PLAYBOOK_CAS_AUTHORITY_FIELDS,
            fields: {
              name: stringField({ minLength: 1, maxLength: 200 }),
              description: optionalString({ maxLength: 2000 }),
              version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; description: string | undefined; version: number };
        return modules.playbooks.updatePlaybookProfile({
          playbookId: ctx.params.playbookId,
          name: body.name,
          description: body.description ?? '',
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('playbooks.playbook.profile_updated', undefined, {
          playbook_id: ctx.result.playbookId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'playbooks.playbook.profile_updated',
          targetType: 'playbook',
          targetId: ctx.result.playbookId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `playbooks.playbook.profile_updated:${ctx.result.playbookId}:${ctx.result.version}`,
        });
      },
      respond: (ctx) => jsonResponse(200, serializePlaybook(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/playbooks/:playbookId/versions — create the NEXT version as
  // a draft. The per-playbook monotonic version_number is assigned
  // SERVER-SIDE (never caller-suppliable); strategy and deployment
  // metadata are strict-validated and shape-asserted at the module
  // boundary.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/playbooks/:playbookId/versions',
    defineMutationRoute<{ playbookId: string }, PlaybookVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => playbookOwner(params.playbookId),
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          strategy: ValidatedStrategy;
          deploymentMetadata: ValidatedDeploymentMetadata | null;
        }>(ctx.request.body, {
          forbiddenKeys: [...PLAYBOOK_VERSION_CREATE_AUTHORITY_FIELDS],
          fields: {
            strategy: strategyField,
            deploymentMetadata: nullableDeploymentMetadataField,
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          strategy: ValidatedStrategy;
          deploymentMetadata: ValidatedDeploymentMetadata | null;
        };
        return modules.playbooks.createPlaybookVersion({
          playbookId: ctx.params.playbookId,
          strategy: toModuleStrategy(body.strategy),
          deploymentMetadata: toModuleDeploymentMetadata(body.deploymentMetadata),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('playbooks.version.created', undefined, {
          playbook_id: ctx.result.playbookId,
          version_id: ctx.result.versionId,
          version_number: ctx.result.versionNumber,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'playbooks.version.created',
          targetType: 'playbook_version',
          targetId: ctx.result.versionId,
          afterVersion: ctx.result.version,
          idempotencyKey: `playbooks.version.created:${ctx.result.versionId}`,
          details: {
            playbookId: ctx.result.playbookId,
            versionNumber: ctx.result.versionNumber,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializePlaybookVersion(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/playbooks/:playbookId/versions — every version in EVERY
  // lifecycle state (published and retired history is visible business
  // record, not hidden).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/playbooks/:playbookId/versions',
    defineQueryRoute<{ playbookId: string }, readonly PlaybookVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId);
      },
      execute: async (ctx) => {
        return modules.playbooks.listPlaybookVersions(ctx.params.playbookId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          playbookId: ctx.params.playbookId,
          versions: ctx.result.map(serializePlaybookVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/playbooks/:playbookId/versions/:versionId — read the EXPLICIT
  // version reference (PLAY-AC-02 contract surface): exactly this version,
  // in ANY lifecycle state, byte for byte, forever. A version id belonging
  // to a DIFFERENT playbook is indistinguishable from an unknown one
  // (uniform 404 under this playbook). There is deliberately no floating
  // "latest version" route anywhere — downstream Deployment/Workflow
  // authorities must pin an exact version.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/playbooks/:playbookId/versions/:versionId',
    defineQueryRoute<{ playbookId: string; versionId: string }, PlaybookVersionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId);
      },
      execute: async (ctx) => {
        const version = await modules.playbooks.getPlaybookVersion(ctx.params.versionId);
        if (version === null || version.playbookId !== ctx.params.playbookId) {
          throw new NotFoundError('playbook version', ctx.params.versionId);
        }
        return version;
      },
      respond: (ctx) => jsonResponse(200, serializePlaybookVersion(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/playbooks/:playbookId/versions/:versionId/profile — CAS
  // content update (strategy, deployment metadata), allowed ONLY while the
  // version is draft or review. PUBLISHED versions are immutable
  // (PLAY-AC-01 → 409; the DB trigger is the final backstop); RETIRED
  // versions are frozen terminal history.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/playbooks/:playbookId/versions/:versionId/profile',
    defineMutationRoute<{ playbookId: string; versionId: string }, PlaybookVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => playbookOwner(params.playbookId),
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          strategy: ValidatedStrategy;
          deploymentMetadata: ValidatedDeploymentMetadata | null;
          version: number;
        }>(ctx.request.body, {
          forbiddenKeys: ['status', ...PLAYBOOK_VERSION_CAS_AUTHORITY_FIELDS],
          fields: {
            strategy: strategyField,
            deploymentMetadata: nullableDeploymentMetadataField,
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          strategy: ValidatedStrategy;
          deploymentMetadata: ValidatedDeploymentMetadata | null;
          version: number;
        };
        const existing = await modules.playbooks.getPlaybookVersion(ctx.params.versionId);
        if (existing === null || existing.playbookId !== ctx.params.playbookId) {
          throw new NotFoundError('playbook version', ctx.params.versionId);
        }
        return modules.playbooks.updatePlaybookVersionContent({
          versionId: ctx.params.versionId,
          strategy: toModuleStrategy(body.strategy),
          deploymentMetadata: toModuleDeploymentMetadata(body.deploymentMetadata),
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('playbooks.version.content_updated', undefined, {
          playbook_id: ctx.result.playbookId,
          version_id: ctx.result.versionId,
          version_number: ctx.result.versionNumber,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'playbooks.version.content_updated',
          targetType: 'playbook_version',
          targetId: ctx.result.versionId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `playbooks.version.content_updated:${ctx.result.versionId}:${ctx.result.version}`,
          details: { versionNumber: ctx.result.versionNumber },
        });
      },
      respond: (ctx) => jsonResponse(200, serializePlaybookVersion(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/playbooks/:playbookId/versions/:versionId/status — CAS
  // lifecycle transition (draft → review → published → retired exactly;
  // published → retired is the content-preserving retirement). CAS +
  // frozen transition table; publication additionally requires an ACTIVE
  // owning boundary (activation is new use).
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/playbooks/:playbookId/versions/:versionId/status',
    defineMutationRoute<{ playbookId: string; versionId: string }, PlaybookVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => playbookOwner(params.playbookId),
      authorize: async (ctx) => {
        await requirePlaybookAccess(modules, ctx.principal, ctx.params.playbookId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['strategy', 'deploymentMetadata', ...PLAYBOOK_VERSION_CAS_AUTHORITY_FIELDS],
          fields: {
            status: stringField({ pattern: PLAYBOOK_VERSION_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: PlaybookVersionStatus; version: number };
        const existing = await modules.playbooks.getPlaybookVersion(ctx.params.versionId);
        if (existing === null || existing.playbookId !== ctx.params.playbookId) {
          throw new NotFoundError('playbook version', ctx.params.versionId);
        }
        return modules.playbooks.setPlaybookVersionStatus({
          versionId: ctx.params.versionId,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('playbooks.version.status_changed', undefined, {
          playbook_id: ctx.result.playbookId,
          version_id: ctx.result.versionId,
          version_number: ctx.result.versionNumber,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'playbooks.version.status_changed',
          targetType: 'playbook_version',
          targetId: ctx.result.versionId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `playbooks.version.status_changed:${ctx.result.versionId}:${ctx.result.version}`,
          details: { status: ctx.result.status, versionNumber: ctx.result.versionNumber },
        });
      },
      respond: (ctx) => jsonResponse(200, serializePlaybookVersion(ctx.result)),
    }),
  );
}
