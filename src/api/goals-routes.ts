/**
 * /goals API routes (MKT-006).
 *
 *   POST   /api/clients/:clientId/goals              create (owner|admin|platform admin)
 *   GET    /api/clients/:clientId/goals              list goals in ALL lifecycle states (any active member)
 *   GET    /api/goals/:goalId                        read (member of the agency owning the CLIENT)
 *   GET    /api/goals/:goalId/ownership-context      canonical owner context (read-only)
 *   PATCH  /api/goals/:goalId/profile                CAS content update (owner|admin|platform admin)
 *   PATCH  /api/goals/:goalId/status                 CAS lifecycle transition (owner|admin|platform admin)
 *
 * The Goal is the Client-owned business-intent object (tenant-runtime-model
 * ownership matrix: "Goal | Client | business-intent object") with an
 * optional Workspace organizational scope INSIDE the owning Client. The
 * Client remains the HARD security boundary. Every route resolves the
 * canonical owner from durable state BEFORE authorize/validate/execute
 * (implementation-contract §2 + §23 pipeline): client-scoped routes resolve
 * the /clients canonical owner; goal-scoped routes resolve the goal →
 * client → agency chain (plus the scoped workspace row). A Goal ID is never
 * an authorization credential, and cross-tenant identifiers yield a UNIFORM
 * 404 (no traversal/existence oracle — GOAL-AC-02).
 *
 * NO Workflow/Playbook/Execution/Deployment authority is introduced here:
 * these routes persist measurable business intent only (architecture.md §7
 * "Goal is not a workflow").
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
  numberField,
  objectField,
  optionalArrayField,
  optionalIsoDateField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess, requireGoalAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type { FieldSpec } from '../platform/http/validation.ts';
import type {
  GoalConstraint,
  GoalConstraintKind,
  GoalMetric,
  GoalOwnerContext,
  GoalRecord,
  GoalStatus,
  GoalSuccessCriterion,
  GoalTimeHorizon,
} from '../modules/goals/public.ts';

const GOAL_STATUS_PATTERN = /^(draft|active|achieved|abandoned)$/;
const GOAL_COMPARATOR_PATTERN = /^(>=|>|<=|<|==)$/;
const GOAL_CONSTRAINT_KIND_PATTERN = /^(resource|risk|time|other)$/;

/** Fields that are always server-derived on CREATE (authority fields). */
const GOAL_CREATE_AUTHORITY_FIELDS = [
  'goalId',
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
 * legitimate ONLY on the lifecycle route; the immutable scope/identity/
 * provenance fields are rejected everywhere.
 */
const GOAL_CAS_AUTHORITY_FIELDS = [
  'goalId',
  'clientId',
  'workspaceId',
  'agencyId',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/** Strict measurable-criterion item shape (GOAL-AC-01). */
const successCriterionField = objectField<{
  metric: string;
  comparator: string;
  targetValue: number;
  unit: string | undefined;
  description: string | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    metric: stringField({ minLength: 1, maxLength: 100 }),
    comparator: stringField({ pattern: GOAL_COMPARATOR_PATTERN }),
    targetValue: numberField(),
    unit: optionalString({ maxLength: 50 }),
    description: optionalString({ maxLength: 500 }),
  },
});

const metricField = objectField<{
  name: string;
  unit: string | undefined;
  description: string | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    name: stringField({ minLength: 1, maxLength: 100 }),
    unit: optionalString({ maxLength: 50 }),
    description: optionalString({ maxLength: 500 }),
  },
});

const constraintField = objectField<{
  kind: string;
  description: string;
}>({
  forbiddenKeys: [],
  fields: {
    kind: stringField({ pattern: GOAL_CONSTRAINT_KIND_PATTERN }),
    description: stringField({ minLength: 1, maxLength: 500 }),
  },
});

const timeHorizonField = objectField<{
  startsOn: string | undefined;
  endsOn: string | undefined;
}>({
  forbiddenKeys: [],
  fields: {
    startsOn: optionalIsoDateField(),
    endsOn: optionalIsoDateField(),
  },
});

/**
 * Nullable time horizon: absent, explicit null (clear) or a strict object.
 * The content routes use full-replacement semantics — an omitted or null
 * horizon means "no horizon", exactly like the module's `null`.
 */
const nullableTimeHorizonField: FieldSpec<{
  startsOn: string | undefined;
  endsOn: string | undefined;
} | null> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined || value === null) return null;
    return timeHorizonField.parse(value, problems);
  },
};

/**
 * Shared body fields for create and CAS content update. successCriteria is
 * REQUIRED (GOAL-AC-01: a Goal cannot persist without measurable criteria);
 * metrics/constraints are optional (absent → empty); timeHorizon is
 * nullable (absent/null → no horizon).
 */
function goalContentSpec() {
  return {
    objective: stringField({ minLength: 1, maxLength: 2000 }),
    successCriteria: arrayField({ minItems: 1, maxItems: 20, item: successCriterionField }),
    metrics: optionalArrayField({ minItems: 0, maxItems: 20, item: metricField }),
    constraints: optionalArrayField({ minItems: 0, maxItems: 50, item: constraintField }),
    timeHorizon: nullableTimeHorizonField,
  } as const;
}

/** Normalized validated content → module input types. */
interface ValidatedGoalContent {
  readonly objective: string;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly metrics: readonly GoalMetric[];
  readonly constraints: readonly GoalConstraint[];
  readonly timeHorizon: GoalTimeHorizon | null;
}

function toModuleContent(body: {
  objective: string;
  successCriteria: ReadonlyArray<{
    metric: string;
    comparator: string;
    targetValue: number;
    unit: string | undefined;
    description: string | undefined;
  }>;
  metrics?:
    | ReadonlyArray<{
        name: string;
        unit: string | undefined;
        description: string | undefined;
      }>
    | undefined;
  constraints?: ReadonlyArray<{ kind: string; description: string }> | undefined;
  timeHorizon:
    | { startsOn: string | undefined; endsOn: string | undefined }
    | null
    | undefined;
}): ValidatedGoalContent {
  return {
    objective: body.objective,
    successCriteria: body.successCriteria.map((criterion) => ({
      metric: criterion.metric,
      comparator: criterion.comparator as GoalSuccessCriterion['comparator'],
      targetValue: criterion.targetValue,
      unit: criterion.unit ?? null,
      description: criterion.description ?? null,
    })),
    metrics: (body.metrics ?? []).map((metric) => ({
      name: metric.name,
      unit: metric.unit ?? null,
      description: metric.description ?? null,
    })),
    constraints: (body.constraints ?? []).map((constraint) => ({
      kind: constraint.kind as GoalConstraintKind,
      description: constraint.description,
    })),
    timeHorizon:
      body.timeHorizon === undefined || body.timeHorizon === null
        ? null
        : {
            startsOn: body.timeHorizon.startsOn ?? null,
            endsOn: body.timeHorizon.endsOn ?? null,
          },
  };
}

function serializeGoal(goal: GoalRecord): Record<string, unknown> {
  return {
    goalId: goal.goalId,
    clientId: goal.clientId,
    ...(goal.workspaceId === null ? {} : { workspaceId: goal.workspaceId }),
    objective: goal.objective,
    successCriteria: goal.successCriteria.map((criterion) => ({
      metric: criterion.metric,
      comparator: criterion.comparator,
      targetValue: criterion.targetValue,
      ...(criterion.unit === null ? {} : { unit: criterion.unit }),
      ...(criterion.description === null ? {} : { description: criterion.description }),
    })),
    metrics: goal.metrics.map((metric) => ({
      name: metric.name,
      ...(metric.unit === null ? {} : { unit: metric.unit }),
      ...(metric.description === null ? {} : { description: metric.description }),
    })),
    constraints: goal.constraints.map((constraint) => ({
      kind: constraint.kind,
      description: constraint.description,
    })),
    ...(goal.timeHorizon === null ? {} : { timeHorizon: goal.timeHorizon }),
    status: goal.status,
    version: goal.version,
    ...(goal.createdBy === null ? {} : { createdBy: goal.createdBy }),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function serializeGoalOwnerContext(ownership: GoalOwnerContext): Record<string, unknown> {
  return {
    scope: ownership.scope,
    goal: serializeGoal(ownership.goal),
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
    ...(ownership.workspace === null
      ? {}
      : {
          workspace: {
            workspaceId: ownership.workspace.workspaceId,
            clientId: ownership.workspace.clientId,
            name: ownership.workspace.name,
            slug: ownership.workspace.slug,
            status: ownership.workspace.status,
            version: ownership.workspace.version,
            createdAt: ownership.workspace.createdAt,
            updatedAt: ownership.workspace.updatedAt,
          },
        }),
    resolvedAt: ownership.resolvedAt,
  };
}

export function registerGoalsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('goals.api');

  /**
   * Canonical Client owner scope for Client-scoped Goal routes: resolved
   * from durable state (through /clients canonical owner resolution) before
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
   * Canonical Goal owner scope: the goal row → its Client (through
   * /clients) → the owning Agency (plus the scoped Workspace row), resolved
   * from durable state before authorize/validate/execute. Unknown,
   * deleted-client and (for the caller) foreign identifiers all surface as
   * the same 404 here or in authorize — never as a traversal.
   */
  async function goalOwner(goalId: string): Promise<OwnerScope> {
    const ownership = await modules.goals.resolveGoalOwnership(goalId);
    if (ownership === null) {
      throw new NotFoundError('goal', goalId);
    }
    return {
      kind: 'goal',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      goalId: ownership.scope.goalId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/goals — create a Goal owned by the Client
  // (optionally scoped to a Workspace of the SAME Client). Client ownership
  // comes from the PATH and is resolved canonically BEFORE authorization;
  // the optional workspaceId is scope INPUT (validated against canonical
  // workspace ownership inside the module — never an authorization).
  // Goal identity, status, provenance and timestamps are server-derived.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/goals',
    defineMutationRoute<{ clientId: string }, GoalRecord>({
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
          objective: string;
          workspaceId: string | undefined;
          successCriteria: ReadonlyArray<{
            metric: string;
            comparator: string;
            targetValue: number;
            unit: string | undefined;
            description: string | undefined;
          }>;
          metrics?:
            | ReadonlyArray<{
                name: string;
                unit: string | undefined;
                description: string | undefined;
              }>
            | undefined;
          constraints?: ReadonlyArray<{ kind: string; description: string }> | undefined;
          timeHorizon:
            | { startsOn: string | undefined; endsOn: string | undefined }
            | null;
        }>(ctx.request.body, {
          forbiddenKeys: GOAL_CREATE_AUTHORITY_FIELDS,
          fields: {
            ...goalContentSpec(),
            workspaceId: optionalString({ maxLength: 64 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          objective: string;
          workspaceId: string | undefined;
          successCriteria: ReadonlyArray<{
            metric: string;
            comparator: string;
            targetValue: number;
            unit: string | undefined;
            description: string | undefined;
          }>;
          metrics?:
            | ReadonlyArray<{
                name: string;
                unit: string | undefined;
                description: string | undefined;
              }>
            | undefined;
          constraints?: ReadonlyArray<{ kind: string; description: string }> | undefined;
          timeHorizon:
            | { startsOn: string | undefined; endsOn: string | undefined }
            | null;
        };
        const content = toModuleContent(body);
        return modules.goals.createGoal({
          clientId: ctx.params.clientId,
          workspaceId: body.workspaceId === undefined ? null : body.workspaceId,
          objective: content.objective,
          successCriteria: content.successCriteria,
          metrics: content.metrics,
          constraints: content.constraints,
          timeHorizon: content.timeHorizon,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('goals.goal.created', undefined, {
          goal_id: ctx.result.goalId,
          client_id: ctx.result.clientId,
          workspace_id: ctx.result.workspaceId,
          status: ctx.result.status,
          criteria_count: ctx.result.successCriteria.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'goals.goal.created',
          targetType: 'goal',
          targetId: ctx.result.goalId,
          afterVersion: ctx.result.version,
          idempotencyKey: `goals.goal.created:${ctx.result.goalId}`,
          details: {
            status: ctx.result.status,
            criteriaCount: ctx.result.successCriteria.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeGoal(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/goals — the Client's goals in ALL lifecycle
  // states (terminal goals are visible business history, not tombstones).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/goals',
    defineQueryRoute<{ clientId: string }, readonly GoalRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.goals.listGoalsForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          goals: ctx.result.map(serializeGoal),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/goals/:goalId — read. Cross-tenant/unknown/deleted-client →
  // uniform 404 (GOAL-AC-02).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/goals/:goalId',
    defineQueryRoute<{ goalId: string }, GoalOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireGoalAccess(modules, ctx.principal, ctx.params.goalId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        const ownership = await modules.goals.resolveGoalOwnership(ctx.params.goalId);
        if (ownership === null) {
          throw new NotFoundError('goal', ctx.params.goalId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeGoal(ctx.result.goal)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/goals/:goalId/ownership-context — read-only evidence surface
  // for the CANONICAL owner context: which Client owns this Goal (and which
  // Agency owns that Client, plus the scoped Workspace when set), resolved
  // server-side from durable state. Informational only — enforcement is
  // per-route and never trusts client claims.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/goals/:goalId/ownership-context',
    defineQueryRoute<{ goalId: string }, GoalOwnerContext>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireGoalAccess(modules, ctx.principal, ctx.params.goalId);
      },
      execute: async (ctx) => {
        const ownership = await modules.goals.resolveGoalOwnership(ctx.params.goalId);
        if (ownership === null) {
          throw new NotFoundError('goal', ctx.params.goalId);
        }
        return ownership;
      },
      respond: (ctx) => jsonResponse(200, serializeGoalOwnerContext(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/goals/:goalId/profile — CAS content update (objective,
  // success criteria, metrics, constraints, time horizon). Scope (client /
  // workspace), identity and provenance are immutable — rejected as
  // authority fields. Terminal goals are frozen business history (409; the
  // DB trigger is the final backstop).
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/goals/:goalId/profile',
    defineMutationRoute<{ goalId: string }, GoalRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => goalOwner(params.goalId),
      authorize: async (ctx) => {
        await requireGoalAccess(modules, ctx.principal, ctx.params.goalId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          objective: string;
          version: number;
          successCriteria: ReadonlyArray<{
            metric: string;
            comparator: string;
            targetValue: number;
            unit: string | undefined;
            description: string | undefined;
          }>;
          metrics?:
            | ReadonlyArray<{
                name: string;
                unit: string | undefined;
                description: string | undefined;
              }>
            | undefined;
          constraints?: ReadonlyArray<{ kind: string; description: string }> | undefined;
          timeHorizon:
            | { startsOn: string | undefined; endsOn: string | undefined }
            | null;
        }>(ctx.request.body, {
          forbiddenKeys: ['status', ...GOAL_CAS_AUTHORITY_FIELDS],
          fields: {
            ...goalContentSpec(),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          objective: string;
          version: number;
          successCriteria: ReadonlyArray<{
            metric: string;
            comparator: string;
            targetValue: number;
            unit: string | undefined;
            description: string | undefined;
          }>;
          metrics?:
            | ReadonlyArray<{
                name: string;
                unit: string | undefined;
                description: string | undefined;
              }>
            | undefined;
          constraints?: ReadonlyArray<{ kind: string; description: string }> | undefined;
          timeHorizon:
            | { startsOn: string | undefined; endsOn: string | undefined }
            | null;
        };
        const content = toModuleContent(body);
        return modules.goals.updateGoalContent({
          goalId: ctx.params.goalId,
          objective: content.objective,
          successCriteria: content.successCriteria,
          metrics: content.metrics,
          constraints: content.constraints,
          timeHorizon: content.timeHorizon,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('goals.goal.profile_updated', undefined, {
          goal_id: ctx.result.goalId,
          client_id: ctx.result.clientId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'goals.goal.profile_updated',
          targetType: 'goal',
          targetId: ctx.result.goalId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `goals.goal.profile_updated:${ctx.result.goalId}:${ctx.result.version}`,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeGoal(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/goals/:goalId/status — CAS lifecycle transition
  // (draft → active → achieved/abandoned; draft → abandoned; terminal
  // states are frozen), CAS + frozen transition table.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/goals/:goalId/status',
    defineMutationRoute<{ goalId: string }, GoalRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => goalOwner(params.goalId),
      authorize: async (ctx) => {
        await requireGoalAccess(modules, ctx.principal, ctx.params.goalId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: [
            'objective',
            'successCriteria',
            'metrics',
            'constraints',
            'timeHorizon',
            ...GOAL_CAS_AUTHORITY_FIELDS,
          ],
          fields: {
            status: stringField({ pattern: GOAL_STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: GoalStatus; version: number };
        return modules.goals.setGoalStatus({
          goalId: ctx.params.goalId,
          status: body.status,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('goals.goal.status_changed', undefined, {
          goal_id: ctx.result.goalId,
          client_id: ctx.result.clientId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'goals.goal.status_changed',
          targetType: 'goal',
          targetId: ctx.result.goalId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `goals.goal.status_changed:${ctx.result.goalId}:${ctx.result.version}`,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeGoal(ctx.result)),
    }),
  );
}
