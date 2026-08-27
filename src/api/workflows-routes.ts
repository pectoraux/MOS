/**
 * /workflows API routes (MKT-008 — the Workflow DEFINITION sub-authority).
 *
 *   POST   /api/workspaces/:workspaceId/workflows                        create Workflow (owner|admin|platform admin)
 *   GET    /api/workspaces/:workspaceId/workflows                        list the Workspace's workflows (any active member)
 *   GET    /api/workflows/:workflowId                                    read (member of the owning agency)
 *   GET    /api/workflows/:workflowId/ownership-context                  canonical owner context (read-only)
 *   PATCH  /api/workflows/:workflowId/profile                            CAS container profile update (owner|admin|platform admin)
 *   POST   /api/workflows/:workflowId/definitions                        create the next DRAFT definition version (owner|admin|platform admin)
 *   GET    /api/workflows/:workflowId/definitions                        list definitions in ALL lifecycle states (any active member)
 *   GET    /api/workflows/:workflowId/definitions/:definitionId          read the EXPLICIT version reference (any active member)
 *   PATCH  /api/workflows/:workflowId/definitions/:definitionId/profile  CAS content update, draft/review only (owner|admin|platform admin)
 *   PATCH  /api/workflows/:workflowId/definitions/:definitionId/status   CAS lifecycle transition (owner|admin|platform admin)
 *
 * The Workflow Definition is the typed, versioned graph artifact (WF-001)
 * a Playbook Version's strategy is turned into on the way to something
 * deployable. Every route resolves the canonical owner from durable state
 * BEFORE authorize/validate/execute (implementation-contract §2: the
 * workflow → workspace → client → agency chain), authorizes against the
 * SAME /agencies membership authority as every other scoped check (no
 * second authorization authority) and rejects every authority field
 * caller-side (identity, scope, provenance and version identity are
 * server-derived). Cross-tenant and unknown identifiers yield a UNIFORM
 * 404 (no traversal/existence oracle).
 *
 * Route validation is the ENVELOPE (types, bounds, authority-field
 * rejection, playbook reference shape); the exhaustive typed-graph
 * validation (the frozen §4 MUST list — dangling nodes/edges, invalid node
 * types, impossible joins, duplicate node IDs, illegal cycles, unresolved
 * schema mappings, explicit bounded loops) is the /workflows MODULE
 * authority and runs there on every create and content update.
 *
 * NO runtime authority is introduced here (architecture.md §10/§11):
 * these routes define and version immutable graphs only — there is no
 * instance creation, no start/pause/resume/cancel, no task dispatch and
 * no execution surface (the Workflow INSTANCE state machine is MKT-009;
 * Executions are /executions, MKT-010). The EXPLICIT version reference
 * surface (GET .../definitions/:definitionId — any lifecycle state, byte
 * for byte, forever) is the contract end future Deployment/Workflow-
 * instance authorities pin; there is no floating "latest" route.
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
  optionalString,
  recordField,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireWorkflowAccess, requireWorkspaceAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  WorkflowConcurrencyLimits,
  WorkflowDefinitionContent,
  WorkflowDefinitionRecord,
  WorkflowDefinitionStatus,
  WorkflowGraph,
  WorkflowOwnerContext,
  WorkflowRecord,
  WorkflowRetryPolicyDefaults,
  WorkflowSchemaShape,
  WorkflowTimeoutPolicy,
} from '../modules/workflows/public.ts';

const WORKFLOW_DEFINITION_STATUS_PATTERN = /^(draft|review|active|retired)$/;
const WORKFLOW_DEFINITION_ID_MAX_LENGTH = 64;

/** Fields that are always server-derived on CREATE (authority fields). */
const WORKFLOW_CREATE_AUTHORITY_FIELDS = [
  'workflowId',
  'workspaceId',
  'clientId',
  'agencyId',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/**
 * CAS mutations legitimately receive `version` (the CAS token); the
 * immutable ownership/identity/provenance fields are rejected everywhere.
 */
const WORKFLOW_CAS_AUTHORITY_FIELDS = [
  'workflowId',
  'workspaceId',
  'clientId',
  'agencyId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/** Fields that are always server-derived on definition CREATE (authority fields). */
const WORKFLOW_DEFINITION_CREATE_AUTHORITY_FIELDS = [
  'workflowDefinitionId',
  'workflowId',
  'versionNumber',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

const WORKFLOW_DEFINITION_CAS_AUTHORITY_FIELDS = [
  'workflowDefinitionId',
  'workflowId',
  'versionNumber',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

// ---------------------------------------------------------------------------
// Envelope field specs (the graph SEMANTICS are the module authority)
// ---------------------------------------------------------------------------

/**
 * The graph envelope: an object carrying a non-empty bounded array of node
 * objects and a bounded array of edge objects. Everything INSIDE the
 * nodes/edges (typed node contracts, edge legality, join semantics,
 * bounded loops, cycles, schema mappings) is validated exhaustively by
 * the /workflows module authority.
 */
const graphField: FieldSpec<Record<string, unknown>> = {
  required: true,
  parse: (value, problems) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push('must be an object with nodes and edges');
      return {};
    }
    const graph = value as Record<string, unknown>;
    const nodes = graph['nodes'];
    if (!Array.isArray(nodes)) {
      problems.push('nodes: must be an array of node definitions');
    } else if (nodes.length === 0) {
      problems.push('nodes: at least one node is required');
    } else if (nodes.length > 200) {
      problems.push('nodes: at most 200 nodes are allowed');
    } else if (nodes.some((node) => node === null || typeof node !== 'object' || Array.isArray(node))) {
      problems.push('nodes: every node definition must be an object');
    }
    const edges = graph['edges'];
    if (!Array.isArray(edges)) {
      problems.push('edges: must be an array of edge definitions');
    } else if (edges.length > 500) {
      problems.push('edges: at most 500 edges are allowed');
    } else if (edges.some((edge) => edge === null || typeof edge !== 'object' || Array.isArray(edge))) {
      problems.push('edges: every edge definition must be an object');
    }
    return graph;
  },
};

/** An object schema envelope (the schema shape is validated by the module authority). */
const schemaField: FieldSpec<Record<string, unknown>> = recordField({ maxDepthKeys: 200 });

/** Optional policy block: absent → the empty block (no defaults declared). */
const optionalPolicyObjectField: FieldSpec<Record<string, unknown> | undefined> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined) return undefined;
    return recordField({ maxDepthKeys: 20 }).parse(value, problems);
  },
};

/** Optional compensation declarations: absent → none. */
const optionalCompensationField: FieldSpec<ReadonlyArray<Record<string, unknown>> | undefined> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined) return undefined;
    return arrayField({ minItems: 0, maxItems: 100, item: recordField({ maxDepthKeys: 8 }) }).parse(
      value,
      problems,
    ) as ReadonlyArray<Record<string, unknown>>;
  },
};

type ValidatedDefinitionEnvelope = {
  readonly graph: Record<string, unknown>;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly retryPolicyDefaults: Record<string, unknown> | undefined;
  readonly concurrencyLimits: Record<string, unknown> | undefined;
  readonly timeoutPolicy: Record<string, unknown> | undefined;
  readonly compensation: ReadonlyArray<Record<string, unknown>> | undefined;
};

/**
 * Normalizes a validated envelope into the module's definition content.
 * The deep typed-graph validation is the MODULE authority — the route
 * passes the envelope through and the module rejects any illegal graph.
 */
function toModuleContent(envelope: ValidatedDefinitionEnvelope): WorkflowDefinitionContent {
  return {
    graph: envelope.graph as unknown as WorkflowGraph,
    inputSchema: envelope.inputSchema as unknown as WorkflowSchemaShape,
    outputSchema: envelope.outputSchema as unknown as WorkflowSchemaShape,
    retryPolicyDefaults: (envelope.retryPolicyDefaults ??
      {}) as unknown as WorkflowRetryPolicyDefaults,
    concurrencyLimits: (envelope.concurrencyLimits ??
      {}) as unknown as WorkflowConcurrencyLimits,
    timeoutPolicy: (envelope.timeoutPolicy ?? {}) as unknown as WorkflowTimeoutPolicy,
    compensation: envelope.compensation ?? [],
  } as unknown as WorkflowDefinitionContent;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeWorkflow(workflow: WorkflowRecord): Record<string, unknown> {
  return {
    workflowId: workflow.workflowId,
    workspaceId: workflow.workspaceId,
    clientId: workflow.clientId,
    agencyId: workflow.agencyId,
    name: workflow.name,
    ...(workflow.description === '' ? {} : { description: workflow.description }),
    version: workflow.version,
    ...(workflow.createdBy === null ? {} : { createdBy: workflow.createdBy }),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function serializeWorkflowDefinition(definition: WorkflowDefinitionRecord): Record<string, unknown> {
  return {
    workflowDefinitionId: definition.workflowDefinitionId,
    workflowId: definition.workflowId,
    versionNumber: definition.versionNumber,
    status: definition.status,
    ...(definition.playbookVersionId === null
      ? {}
      : { playbookVersionId: definition.playbookVersionId }),
    graph: definition.content.graph,
    inputSchema: definition.content.inputSchema,
    outputSchema: definition.content.outputSchema,
    retryPolicyDefaults: definition.content.retryPolicyDefaults,
    concurrencyLimits: definition.content.concurrencyLimits,
    timeoutPolicy: definition.content.timeoutPolicy,
    compensation: definition.content.compensation,
    version: definition.version,
    ...(definition.createdBy === null ? {} : { createdBy: definition.createdBy }),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
}

function serializeWorkflowOwnerContext(ownership: WorkflowOwnerContext): Record<string, unknown> {
  return {
    scope: ownership.scope,
    workflow: serializeWorkflow(ownership.workflow),
    workspace: {
      workspaceId: ownership.workspace.workspaceId,
      clientId: ownership.workspace.clientId,
      name: ownership.workspace.name,
      slug: ownership.workspace.slug,
      status: ownership.workspace.status,
      version: ownership.workspace.version,
      ...(ownership.workspace.createdBy === null ? {} : { createdBy: ownership.workspace.createdBy }),
      createdAt: ownership.workspace.createdAt,
      updatedAt: ownership.workspace.updatedAt,
    },
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
    agency: {
      agencyId: ownership.agency.agencyId,
      slug: ownership.agency.slug,
      status: ownership.agency.status,
    },
    resolvedAt: ownership.resolvedAt,
  };
}

export function registerWorkflowsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('workflows.api');

  /**
   * Canonical Workspace owner scope for Workspace-scoped Workflow routes:
   * resolved through /workspaces canonical owner resolution before
   * authorize/validate/execute. Unknown, deleted and (for the caller)
   * foreign Workspace identifiers all surface as the same 404 here or in
   * authorize — never as a traversal.
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

  /**
   * Canonical Workflow owner scope: the workflow row → its owning
   * Workspace → the owning Client → the owning Agency, resolved from
   * durable state before authorize/validate/execute. Unknown,
   * deleted-boundary and (for the caller) foreign identifiers all
   * surface as the same 404 here or in authorize — never as a traversal.
   */
  async function workflowOwner(workflowId: string): Promise<OwnerScope> {
    const ownership = await modules.workflows.resolveWorkflowOwnership(workflowId);
    if (ownership === null) {
      throw new NotFoundError('workflow', workflowId);
    }
    return {
      kind: 'workflow',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      workflowId: ownership.scope.workflowId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/workspaces/:workspaceId/workflows — create a WORKSPACE-SCOPED
  // Workflow. Workspace ownership comes from the PATH and is resolved
  // canonically BEFORE authorization; Client and Agency ownership are
  // SERVER-DERIVED from the canonical Workspace owner inside the module.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/workflows',
    defineMutationRoute<{ workspaceId: string }, WorkflowRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; description: string | undefined }>(ctx.request.body, {
          forbiddenKeys: WORKFLOW_CREATE_AUTHORITY_FIELDS,
          fields: {
            name: stringField({ minLength: 1, maxLength: 200 }),
            description: optionalString({ maxLength: 2000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; description: string | undefined };
        return modules.workflows.createWorkflow({
          workspaceId: ctx.params.workspaceId,
          name: body.name,
          description: body.description ?? '',
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('workflows.workflow.created', undefined, {
          workflow_id: ctx.result.workflowId,
          workspace_id: ctx.result.workspaceId,
          client_id: ctx.result.clientId,
          agency_id: ctx.result.agencyId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workflows.workflow.created',
          targetType: 'workflow',
          targetId: ctx.result.workflowId,
          afterVersion: ctx.result.version,
          idempotencyKey: `workflows.workflow.created:${ctx.result.workflowId}`,
          details: { workspaceId: ctx.result.workspaceId },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeWorkflow(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/workflows — the Workspace's workflows.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/workflows',
    defineQueryRoute<{ workspaceId: string }, readonly WorkflowRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.workflows.listWorkflowsForWorkspace(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          workflows: ctx.result.map(serializeWorkflow),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workflows/:workflowId — read. Cross-tenant/unknown/
  // deleted-boundary → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workflows/:workflowId',
    defineQueryRoute<{ workflowId: string }, WorkflowOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.workflows.resolveWorkflowOwnership(ctx.params.workflowId);
        if (ownership === null) {
          throw new NotFoundError('workflow', ctx.params.workflowId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeWorkflow(ctx.result.workflow)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workflows/:workflowId/ownership-context — read-only evidence
  // surface for the CANONICAL owner context: which Workspace owns this
  // Workflow, under which Client and Agency — resolved server-side from
  // durable state. Informational only — enforcement is per-route and never
  // trusts client claims.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workflows/:workflowId/ownership-context',
    defineQueryRoute<{ workflowId: string }, WorkflowOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId);
      },
      execute: async (ctx) => {
        const ownership = await modules.workflows.resolveWorkflowOwnership(ctx.params.workflowId);
        if (ownership === null) {
          throw new NotFoundError('workflow', ctx.params.workflowId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeWorkflowOwnerContext(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/workflows/:workflowId/profile — CAS container profile update
  // (name, description). Scope and provenance are immutable — rejected as
  // authority fields.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/workflows/:workflowId/profile',
    defineMutationRoute<{ workflowId: string }, WorkflowRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workflowOwner(params.workflowId),
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ name: string; description: string | undefined; version: number }>(
          ctx.request.body,
          {
            forbiddenKeys: WORKFLOW_CAS_AUTHORITY_FIELDS,
            fields: {
              name: stringField({ minLength: 1, maxLength: 200 }),
              description: optionalString({ maxLength: 2000 }),
              version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as { name: string; description: string | undefined; version: number };
        return modules.workflows.updateWorkflowProfile({
          workflowId: ctx.params.workflowId,
          name: body.name,
          description: body.description ?? '',
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('workflows.workflow.profile_updated', undefined, {
          workflow_id: ctx.result.workflowId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workflows.workflow.profile_updated',
          targetType: 'workflow',
          targetId: ctx.result.workflowId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `workflows.workflow.profile_updated:${ctx.result.workflowId}:${ctx.result.version}`,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeWorkflow(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/workflows/:workflowId/definitions — create the NEXT
  // definition version as a draft. The per-workflow monotonic
  // version_number is assigned SERVER-SIDE (never caller-suppliable); the
  // graph, schemas and policy blocks are envelope-validated here and
  // exhaustively validated at the /workflows module authority; the
  // optional playbookVersionId provenance link is resolved through
  // /playbooks' explicit version reference inside the module.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/workflows/:workflowId/definitions',
    defineMutationRoute<{ workflowId: string }, WorkflowDefinitionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workflowOwner(params.workflowId),
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<
          ValidatedDefinitionEnvelope & { readonly playbookVersionId: string | undefined }
        >(ctx.request.body, {
          forbiddenKeys: WORKFLOW_DEFINITION_CREATE_AUTHORITY_FIELDS,
          fields: {
            graph: graphField,
            inputSchema: schemaField,
            outputSchema: schemaField,
            playbookVersionId: optionalString({ maxLength: WORKFLOW_DEFINITION_ID_MAX_LENGTH }),
            retryPolicyDefaults: optionalPolicyObjectField,
            concurrencyLimits: optionalPolicyObjectField,
            timeoutPolicy: optionalPolicyObjectField,
            compensation: optionalCompensationField,
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDefinitionEnvelope & {
          playbookVersionId: string | undefined;
        };
        return modules.workflows.createWorkflowDefinition({
          workflowId: ctx.params.workflowId,
          content: toModuleContent(body),
          playbookVersionId: body.playbookVersionId === undefined ? null : body.playbookVersionId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('workflows.definition.created', undefined, {
          workflow_id: ctx.result.workflowId,
          workflow_definition_id: ctx.result.workflowDefinitionId,
          version_number: ctx.result.versionNumber,
          status: ctx.result.status,
          playbook_version_id: ctx.result.playbookVersionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workflows.definition.created',
          targetType: 'workflow_definition',
          targetId: ctx.result.workflowDefinitionId,
          afterVersion: ctx.result.version,
          idempotencyKey: `workflows.definition.created:${ctx.result.workflowDefinitionId}`,
          details: {
            workflowId: ctx.result.workflowId,
            versionNumber: ctx.result.versionNumber,
            ...(ctx.result.playbookVersionId === null
              ? {}
              : { playbookVersionId: ctx.result.playbookVersionId }),
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeWorkflowDefinition(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workflows/:workflowId/definitions — every definition version
  // in EVERY lifecycle state (active and retired history is visible
  // business record, not hidden).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workflows/:workflowId/definitions',
    defineQueryRoute<{ workflowId: string }, readonly WorkflowDefinitionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId);
      },
      execute: async (ctx) => {
        return modules.workflows.listWorkflowDefinitions(ctx.params.workflowId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workflowId: ctx.params.workflowId,
          definitions: ctx.result.map(serializeWorkflowDefinition),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workflows/:workflowId/definitions/:definitionId — read the
  // EXPLICIT version reference: exactly this definition, in ANY lifecycle
  // state, byte for byte, forever. A definition id belonging to a
  // DIFFERENT workflow is indistinguishable from an unknown one (uniform
  // 404 under this workflow). There is deliberately no floating "latest
  // definition" route anywhere — downstream Deployment/Workflow-instance
  // authorities must pin an exact version.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workflows/:workflowId/definitions/:definitionId',
    defineQueryRoute<{ workflowId: string; definitionId: string }, WorkflowDefinitionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId);
      },
      execute: async (ctx) => {
        const definition = await modules.workflows.getWorkflowDefinition(ctx.params.definitionId);
        if (definition === null || definition.workflowId !== ctx.params.workflowId) {
          throw new NotFoundError('workflow definition', ctx.params.definitionId);
        }
        return definition;
      },
      respond: (ctx) => jsonResponse(200, serializeWorkflowDefinition(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/workflows/:workflowId/definitions/:definitionId/profile —
  // CAS content update (graph, schemas, policy blocks), allowed ONLY while
  // the definition is draft or review. ACTIVATED definitions are immutable
  // (409; the DB trigger is the final backstop); RETIRED definitions are
  // frozen terminal history. The playbook provenance link is immutable
  // once set — rejected as an authority field here.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/workflows/:workflowId/definitions/:definitionId/profile',
    defineMutationRoute<{ workflowId: string; definitionId: string }, WorkflowDefinitionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workflowOwner(params.workflowId),
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDefinitionEnvelope & { readonly version: number }>(
          ctx.request.body,
          {
            forbiddenKeys: ['playbookVersionId', 'status', ...WORKFLOW_DEFINITION_CAS_AUTHORITY_FIELDS],
            fields: {
              graph: graphField,
              inputSchema: schemaField,
              outputSchema: schemaField,
              retryPolicyDefaults: optionalPolicyObjectField,
              concurrencyLimits: optionalPolicyObjectField,
              timeoutPolicy: optionalPolicyObjectField,
              compensation: optionalCompensationField,
              version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDefinitionEnvelope & { version: number };
        const existing = await modules.workflows.getWorkflowDefinition(ctx.params.definitionId);
        if (existing === null || existing.workflowId !== ctx.params.workflowId) {
          throw new NotFoundError('workflow definition', ctx.params.definitionId);
        }
        return modules.workflows.updateWorkflowDefinitionContent({
          definitionId: ctx.params.definitionId,
          content: toModuleContent(body),
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('workflows.definition.content_updated', undefined, {
          workflow_id: ctx.result.workflowId,
          workflow_definition_id: ctx.result.workflowDefinitionId,
          version_number: ctx.result.versionNumber,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workflows.definition.content_updated',
          targetType: 'workflow_definition',
          targetId: ctx.result.workflowDefinitionId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `workflows.definition.content_updated:${ctx.result.workflowDefinitionId}:${ctx.result.version}`,
          details: { versionNumber: ctx.result.versionNumber },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeWorkflowDefinition(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/workflows/:workflowId/definitions/:definitionId/status —
  // CAS lifecycle transition (draft → review → active → retired exactly;
  // active → retired is the content-preserving retirement). CAS + frozen
  // transition table; ACTIVATION additionally requires ACTIVE owning
  // boundaries and (when a playbook version is linked) a PUBLISHED
  // playbook version (activation is new use).
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/workflows/:workflowId/definitions/:definitionId/status',
    defineMutationRoute<{ workflowId: string; definitionId: string }, WorkflowDefinitionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workflowOwner(params.workflowId),
      authorize: async (ctx) => {
        await requireWorkflowAccess(modules, ctx.principal, ctx.params.workflowId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: [
            'graph',
            'inputSchema',
            'outputSchema',
            'playbookVersionId',
            ...WORKFLOW_DEFINITION_CAS_AUTHORITY_FIELDS,
          ],
          fields: {
            status: stringField({ pattern: WORKFLOW_DEFINITION_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: WorkflowDefinitionStatus; version: number };
        const existing = await modules.workflows.getWorkflowDefinition(ctx.params.definitionId);
        if (existing === null || existing.workflowId !== ctx.params.workflowId) {
          throw new NotFoundError('workflow definition', ctx.params.definitionId);
        }
        return modules.workflows.setWorkflowDefinitionStatus({
          definitionId: ctx.params.definitionId,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('workflows.definition.status_changed', undefined, {
          workflow_id: ctx.result.workflowId,
          workflow_definition_id: ctx.result.workflowDefinitionId,
          version_number: ctx.result.versionNumber,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'workflows.definition.status_changed',
          targetType: 'workflow_definition',
          targetId: ctx.result.workflowDefinitionId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `workflows.definition.status_changed:${ctx.result.workflowDefinitionId}:${ctx.result.version}`,
          details: { status: ctx.result.status, versionNumber: ctx.result.versionNumber },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeWorkflowDefinition(ctx.result)),
    }),
  );
}
