/**
 * /executions API routes (MKT-010 — the normalized Execution model:
 * EXEC-001, acceptance EXEC-AC-01..03).
 *
 *   POST   /api/workspaces/:workspaceId/executions                          create execution — first attempt or explicit retry (owner|admin|platform admin)
 *   GET    /api/workspaces/:workspaceId/executions                          list the Workspace's executions in ALL states (any active member)
 *   GET    /api/executions/:executionId                                     read (member of the owning agency)
 *   GET    /api/executions/:executionId/transitions                         append-only transition history (any active member)
 *   POST   /api/executions/:executionId/transitions                         apply ONE lifecycle transition, idempotency-fenced CAS command (owner|admin|platform admin)
 *   POST   /api/executions/:executionId/sandbox-leases                      acquire the sandbox lease, idempotency-fenced (owner|admin|platform admin)
 *   GET    /api/executions/:executionId/sandbox-leases                      the leases ever held, oldest first (any active member)
 *   POST   /api/executions/:executionId/sandbox-leases/:leaseId/release     release a lease — idempotent, never terminalizes (owner|admin|platform admin)
 *
 * The Execution is the ACTUAL RUNTIME ATTEMPT identity (architecture.md
 * §11) — the transition from the MKT-009 Workflow Instance's lifecycle
 * INTENT to a concrete attempt. One normalized identity serves ALL
 * execution kinds (deterministic, AI, human, extension — EXEC-AC-01).
 * Every route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (implementation-contract §2: the execution →
 * workspace → client → agency chain), authorizes against the SAME
 * /agencies membership authority as every other scoped check (no second
 * authorization authority) and rejects every authority field caller-side
 * (identity, scope, provenance, attempt number and lifecycle state are
 * server-derived). Cross-tenant and unknown identifiers yield a UNIFORM 404
 * (no traversal/existence oracle) — a lease id belonging to a DIFFERENT
 * execution is indistinguishable from an unknown one under this execution.
 *
 * Route validation is the ENVELOPE (types, bounds, authority-field
 * rejection, linkage shape); the frozen state-machine guards, the §8
 * idempotency fences, the §24 retry-classification contract, the retry
 * gate and the sandbox-lease eligibility are the /executions MODULE
 * authority and run there on every command (the DB triggers are the final
 * backstops).
 *
 * NO execution engine is introduced here: these routes record execution
 * IDENTITY, LIFECYCLE, idempotency, retry classification and the
 * runtime-resource lease relationship — there is no dispatch, no queue
 * consumption, no worker assignment, no node-instance bookkeeping, no
 * input/output payload and no automatic retry orchestration (the pooled
 * worker authority is MKT-011). The task linkage is reference data the
 * authorized caller supplies (workflow instance + node, or an explicitly
 * declared external request); /executions never resolves it through
 * /workflows — the frozen dependency matrix points the other way.
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
import {
  intField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireExecutionAccess, requireWorkspaceAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  ExecutionCreateOutcome,
  ExecutionKind,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionTaskLink,
  ExecutionTransitionOutcome,
  ExecutionTransitionRecord,
  LeaseAcquireOutcome,
  LeaseReleaseOutcome,
  RuntimeClass,
  SandboxLeaseRecord,
} from '../modules/executions/public.ts';

const EXECUTION_KIND_PATTERN = /^(deterministic|ai|human|extension)$/;
const RUNTIME_CLASS_PATTERN = /^(pooled-worker|ephemeral-sandbox|persistent-sandbox|dedicated-runtime)$/;
const RETRY_CLASSIFICATION_PATTERN = /^(safe|unsafe)$/;
/** Lease expiry metadata: an ISO-8601 UTC timestamp. */
const LEASE_EXPIRES_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const EXECUTION_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const EXECUTION_NODE_ID_MAX_LENGTH = 200;
const EXECUTION_EXTERNAL_REF_MAX_LENGTH = 200;
const EXECUTION_EVIDENCE_REF_MAX_LENGTH = 512;

/**
 * Valid lifecycle transition TARGETS (never 'created' — an execution is
 * BORN there; nothing transitions into it).
 */
const EXECUTION_TARGET_PATTERN =
  /^(queued|starting|running|pausing|paused|succeeded|failed|cancelled|unknown|reconciling)$/;

/** Fields that are always server-derived on CREATE (authority fields). */
const EXECUTION_CREATE_AUTHORITY_FIELDS = [
  'executionId',
  'workspaceId',
  'clientId',
  'agencyId',
  'status',
  'retryClassification',
  'attemptNumber',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/**
 * The transition command envelope: `to` is the target state, `version` the
 * CAS token, `idempotencyKey` the logical command key, `retryClassification`
 * the §24 declaration REQUIRED on to=failed, `evidenceRef` the authoritative
 * external-evidence reference accepted only on reconciliation decisions and
 * `reason` optional bounded evidence. Every execution authority field is
 * rejected caller-side — the current status is server-derived state, never
 * an input.
 */
const EXECUTION_TRANSITION_AUTHORITY_FIELDS = [
  'executionId',
  'workspaceId',
  'clientId',
  'agencyId',
  'taskLink',
  'workflowInstanceId',
  'nodeId',
  'externalRequestRef',
  'retryOfExecutionId',
  'attemptNumber',
  'executionKind',
  'runtimeClass',
  'status',
  'currentStatus',
  'fromStatus',
  'replayed',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/** Fields that are always server-derived on lease ACQUIRE (authority fields). */
const LEASE_ACQUIRE_AUTHORITY_FIELDS = [
  'sandboxLeaseId',
  'executionId',
  'workspaceId',
  'clientId',
  'agencyId',
  'status',
  'acquiredBy',
  'releasedAt',
  'version',
  'createdAt',
  'updatedAt',
] as const;

/** The release command carries no caller-supplied payload at all. */
const LEASE_RELEASE_AUTHORITY_FIELDS = [
  'sandboxLeaseId',
  'executionId',
  'workspaceId',
  'clientId',
  'agencyId',
  'sandboxId',
  'status',
  'acquiredBy',
  'releasedAt',
  'expiresAt',
  'idempotencyKey',
  'version',
  'createdAt',
  'updatedAt',
] as const;

/** The validated create envelope (flat task-linkage shape). */
type ValidatedCreateEnvelope = {
  readonly workflowInstanceId: string | undefined;
  readonly nodeId: string | undefined;
  readonly externalRequestRef: string | undefined;
  readonly retryOfExecutionId: string | undefined;
  readonly executionKind: string | undefined;
  readonly runtimeClass: string | undefined;
  readonly idempotencyKey: string;
};

/**
 * Normalizes the validated flat envelope into the module's create input:
 * exactly ONE create shape (first attempt with task link + kind + runtime
 * class, or an explicit retry inheriting all of them). The module remains
 * the authority for the same contracts; this normalization keeps the
 * envelope error precise.
 */
function toModuleCreateInput(
  envelope: ValidatedCreateEnvelope,
): {
  taskLink: ExecutionTaskLink | null;
  retryOfExecutionId: string | null;
  executionKind: ExecutionKind | null;
  runtimeClass: RuntimeClass | null;
} {
  const hasWorkflowNode =
    envelope.workflowInstanceId !== undefined || envelope.nodeId !== undefined;
  const hasExternal = envelope.externalRequestRef !== undefined;
  const hasRetry = envelope.retryOfExecutionId !== undefined;
  const shapeCount = (hasWorkflowNode ? 1 : 0) + (hasExternal ? 1 : 0) + (hasRetry ? 1 : 0);
  if (shapeCount !== 1) {
    throw new InvalidRequestError(
      'An execution is created from exactly ONE shape: workflowInstanceId + nodeId, externalRequestRef, or retryOfExecutionId',
      [
        'first attempt: task-linkage coordinates (workflowInstanceId + nodeId, or externalRequestRef) + executionKind + runtimeClass',
        'retry attempt: retryOfExecutionId alone (kind/runtime/linkage are inherited)',
      ],
    );
  }
  if (hasRetry) {
    if (envelope.executionKind !== undefined || envelope.runtimeClass !== undefined) {
      throw new InvalidRequestError(
        'A retry inherits its kind and runtime class from the prior attempt',
        ['executionKind and runtimeClass must be omitted on a retry create'],
      );
    }
    return {
      taskLink: null,
      retryOfExecutionId: envelope.retryOfExecutionId!,
      executionKind: null,
      runtimeClass: null,
    };
  }
  if (envelope.executionKind === undefined || envelope.runtimeClass === undefined) {
    throw new InvalidRequestError(
      'A first-attempt execution requires executionKind and runtimeClass',
      ['both are required alongside the task-linkage coordinates'],
    );
  }
  if (hasWorkflowNode) {
    if (envelope.workflowInstanceId === undefined || envelope.nodeId === undefined) {
      throw new InvalidRequestError(
        'A workflow-node task link requires both workflowInstanceId and nodeId',
        ['the logical Task coordinates are the workflow instance plus the node'],
      );
    }
    return {
      taskLink: {
        kind: 'workflow-node',
        workflowInstanceId: envelope.workflowInstanceId,
        nodeId: envelope.nodeId,
      },
      retryOfExecutionId: null,
      executionKind: envelope.executionKind as ExecutionKind,
      runtimeClass: envelope.runtimeClass as RuntimeClass,
    };
  }
  return {
    taskLink: {
      kind: 'external-request',
      externalRequestRef: envelope.externalRequestRef!,
    },
    retryOfExecutionId: null,
    executionKind: envelope.executionKind as ExecutionKind,
    runtimeClass: envelope.runtimeClass as RuntimeClass,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeTaskLink(taskLink: ExecutionTaskLink): Record<string, unknown> {
  return taskLink.kind === 'workflow-node'
    ? {
        kind: taskLink.kind,
        workflowInstanceId: taskLink.workflowInstanceId,
        nodeId: taskLink.nodeId,
      }
    : {
        kind: taskLink.kind,
        externalRequestRef: taskLink.externalRequestRef,
      };
}

function serializeExecution(execution: ExecutionRecord): Record<string, unknown> {
  return {
    executionId: execution.executionId,
    taskLink: serializeTaskLink(execution.taskLink),
    ...(execution.retryOfExecutionId === null
      ? {}
      : { retryOfExecutionId: execution.retryOfExecutionId }),
    attemptNumber: execution.attemptNumber,
    executionKind: execution.executionKind,
    runtimeClass: execution.runtimeClass,
    workspaceId: execution.workspaceId,
    clientId: execution.clientId,
    agencyId: execution.agencyId,
    status: execution.status,
    ...(execution.retryClassification === null
      ? {}
      : { retryClassification: execution.retryClassification }),
    version: execution.version,
    ...(execution.createdBy === null ? {} : { createdBy: execution.createdBy }),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
  };
}

function serializeExecutionTransition(
  transition: ExecutionTransitionRecord,
): Record<string, unknown> {
  return {
    transitionId: transition.transitionId,
    executionId: transition.executionId,
    idempotencyKey: transition.idempotencyKey,
    fromStatus: transition.fromStatus,
    toStatus: transition.toStatus,
    ...(transition.retryClassification === null
      ? {}
      : { retryClassification: transition.retryClassification }),
    ...(transition.evidenceRef === null ? {} : { evidenceRef: transition.evidenceRef }),
    ...(transition.reason === '' ? {} : { reason: transition.reason }),
    ...(transition.createdBy === null ? {} : { createdBy: transition.createdBy }),
    createdAt: transition.createdAt,
  };
}

function serializeExecutionTransitionOutcome(
  outcome: ExecutionTransitionOutcome,
): Record<string, unknown> {
  return {
    execution: serializeExecution(outcome.execution),
    transition: serializeExecutionTransition(outcome.transition),
    replayed: outcome.replayed,
  };
}

function serializeExecutionCreateOutcome(outcome: ExecutionCreateOutcome): Record<string, unknown> {
  return {
    execution: serializeExecution(outcome.execution),
    replayed: outcome.replayed,
  };
}

function serializeSandboxLease(lease: SandboxLeaseRecord): Record<string, unknown> {
  return {
    sandboxLeaseId: lease.sandboxLeaseId,
    sandboxId: lease.sandboxId,
    executionId: lease.executionId,
    workspaceId: lease.workspaceId,
    clientId: lease.clientId,
    status: lease.status,
    ...(lease.acquiredBy === null ? {} : { acquiredBy: lease.acquiredBy }),
    ...(lease.releasedAt === null ? {} : { releasedAt: lease.releasedAt }),
    ...(lease.expiresAt === null ? {} : { expiresAt: lease.expiresAt }),
    idempotencyKey: lease.idempotencyKey,
    version: lease.version,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
  };
}

function serializeLeaseAcquireOutcome(outcome: LeaseAcquireOutcome): Record<string, unknown> {
  return {
    lease: serializeSandboxLease(outcome.lease),
    replayed: outcome.replayed,
  };
}

function serializeLeaseReleaseOutcome(outcome: LeaseReleaseOutcome): Record<string, unknown> {
  return {
    lease: serializeSandboxLease(outcome.lease),
    execution: serializeExecution(outcome.execution),
    replayed: outcome.replayed,
  };
}

export function registerExecutionsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('executions.api');

  /**
   * Canonical Workspace owner scope for Workspace-scoped Execution routes:
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
   * Canonical Execution owner scope: the execution row → its owning
   * Workspace → the owning Client → the owning Agency, resolved from
   * durable state before authorize/validate/execute. Unknown,
   * deleted-boundary and (for the caller) foreign identifiers all
   * surface as the same 404 here or in authorize — never as a traversal.
   */
  async function executionOwner(executionId: string): Promise<OwnerScope> {
    const ownership = await modules.executions.resolveExecutionOwnership(executionId);
    if (ownership === null) {
      throw new NotFoundError('execution', executionId);
    }
    return {
      kind: 'execution',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      executionId: ownership.scope.executionId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/workspaces/:workspaceId/executions — create a
  // WORKSPACE-SCOPED Execution: either a FIRST ATTEMPT (task-linkage
  // coordinates + executionKind + runtimeClass) or an EXPLICIT RETRY
  // (retryOfExecutionId alone — linkage/kind/runtime inherited, gated on a
  // FAILED + retry-safe prior; UNKNOWN is never automatically retryable).
  // The §8 logical idempotency key is REQUIRED: a duplicate of the same
  // logical command converges to the existing execution (201 fresh /
  // 200 replayed); a key reused for a different command is a 409.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/executions',
    defineMutationRoute<{ workspaceId: string }, ExecutionCreateOutcome>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedCreateEnvelope>(ctx.request.body, {
          forbiddenKeys: EXECUTION_CREATE_AUTHORITY_FIELDS,
          fields: {
            workflowInstanceId: optionalString({ maxLength: 64 }),
            nodeId: optionalString({ minLength: 1, maxLength: EXECUTION_NODE_ID_MAX_LENGTH }),
            externalRequestRef: optionalString({
              minLength: 1,
              maxLength: EXECUTION_EXTERNAL_REF_MAX_LENGTH,
            }),
            retryOfExecutionId: optionalString({ maxLength: 64 }),
            executionKind: optionalString({ pattern: EXECUTION_KIND_PATTERN }),
            runtimeClass: optionalString({ pattern: RUNTIME_CLASS_PATTERN }),
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: EXECUTION_IDEMPOTENCY_KEY_MAX_LENGTH,
            }),
          },
        }),
      execute: async (ctx) => {
        const envelope = ctx.validated as ValidatedCreateEnvelope;
        const shape = toModuleCreateInput(envelope);
        return modules.executions.createExecution({
          workspaceId: ctx.params.workspaceId,
          taskLink: shape.taskLink,
          retryOfExecutionId: shape.retryOfExecutionId,
          executionKind: shape.executionKind,
          runtimeClass: shape.runtimeClass,
          idempotencyKey: envelope.idempotencyKey,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.created', undefined, {
          workspace_id: ctx.result.execution.workspaceId,
          execution_id: ctx.result.execution.executionId,
          execution_kind: ctx.result.execution.executionKind,
          runtime_class: ctx.result.execution.runtimeClass,
          attempt_number: ctx.result.execution.attemptNumber,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.created',
          targetType: 'execution',
          targetId: ctx.result.execution.executionId,
          afterVersion: ctx.result.execution.version,
          // Keyed by the execution identity: a replayed duplicate converges
          // to the same single audit row (append-only trail).
          idempotencyKey: `executions.created:${ctx.result.execution.executionId}`,
          details: {
            executionKind: ctx.result.execution.executionKind,
            runtimeClass: ctx.result.execution.runtimeClass,
            taskLinkKind: ctx.result.execution.taskLink.kind,
            attemptNumber: ctx.result.execution.attemptNumber,
            retryOfExecutionId: ctx.result.execution.retryOfExecutionId,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, serializeExecutionCreateOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/executions — every execution of the
  // Workspace in EVERY lifecycle state (terminal history is visible
  // business record, not hidden).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/executions',
    defineQueryRoute<{ workspaceId: string }, readonly ExecutionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.executions.listExecutionsForWorkspace(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          executions: ctx.result.map(serializeExecution),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/executions/:executionId — read one execution (any state).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/executions/:executionId',
    defineQueryRoute<{ executionId: string }, ExecutionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId);
      },
      execute: async (ctx) => {
        const execution = await modules.executions.getExecution(ctx.params.executionId);
        if (execution === null) {
          throw new NotFoundError('execution', ctx.params.executionId);
        }
        return execution;
      },
      respond: (ctx) => jsonResponse(200, serializeExecution(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/executions/:executionId/transitions — the append-only
  // applied-transition history (the authoritative record of every state
  // decision, every §24 retry classification and every reconciliation
  // decision, and the idempotency ledger). Read-only evidence.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/executions/:executionId/transitions',
    defineQueryRoute<{ executionId: string }, readonly ExecutionTransitionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId);
      },
      execute: async (ctx) => {
        const execution = await modules.executions.getExecution(ctx.params.executionId);
        if (execution === null) {
          throw new NotFoundError('execution', ctx.params.executionId);
        }
        return modules.executions.getExecutionTransitions(ctx.params.executionId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          executionId: ctx.params.executionId,
          transitions: ctx.result.map(serializeExecutionTransition),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/executions/:executionId/transitions — apply ONE lifecycle
  // transition: the single authorized mutation port for execution state.
  // The command carries the target state (`to`), the CAS token (`version`)
  // and the logical command key (`idempotencyKey`) — a duplicate request
  // converges to the recorded transition (replayed=true; no state change,
  // no new history row), while a key reused with a different target is a
  // 409. A transition INTO failed REQUIRES its §24 retry classification;
  // the reconciliation evidence reference is accepted only on
  // reconciling → succeeded | failed | unknown decisions. Illegal
  // transitions, stale CAS tokens and terminal-state writes are 409/422s
  // from the module authority (the frozen-machine DB trigger is the final
  // backstop).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/executions/:executionId/transitions',
    defineMutationRoute<
      { executionId: string },
      ExecutionTransitionOutcome
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => executionOwner(params.executionId),
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          to: string;
          version: number;
          idempotencyKey: string;
          retryClassification: string | undefined;
          evidenceRef: string | undefined;
          reason: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: EXECUTION_TRANSITION_AUTHORITY_FIELDS,
          fields: {
            to: stringField({ pattern: EXECUTION_TARGET_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: EXECUTION_IDEMPOTENCY_KEY_MAX_LENGTH,
            }),
            retryClassification: optionalString({ pattern: RETRY_CLASSIFICATION_PATTERN }),
            evidenceRef: optionalString({ maxLength: EXECUTION_EVIDENCE_REF_MAX_LENGTH }),
            reason: optionalString({ maxLength: 2000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          to: ExecutionStatus;
          version: number;
          idempotencyKey: string;
          retryClassification: string | undefined;
          evidenceRef: string | undefined;
          reason: string | undefined;
        };
        return modules.executions.transitionExecution({
          executionId: ctx.params.executionId,
          to: body.to,
          expectedVersion: body.version,
          idempotencyKey: body.idempotencyKey,
          retryClassification:
            body.retryClassification === undefined ? null : (body.retryClassification as 'safe' | 'unsafe'),
          evidenceRef: body.evidenceRef === undefined ? null : body.evidenceRef,
          reason: body.reason === undefined ? null : body.reason,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.transitioned', undefined, {
          execution_id: ctx.result.execution.executionId,
          from_status: ctx.result.transition.fromStatus,
          to_status: ctx.result.transition.toStatus,
          retry_classification: ctx.result.transition.retryClassification,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.transitioned',
          targetType: 'execution',
          targetId: ctx.result.execution.executionId,
          beforeVersion: ctx.result.execution.version - (ctx.result.replayed ? 0 : 1),
          afterVersion: ctx.result.execution.version,
          // Keyed by the RECORDED transition id: a replayed duplicate
          // converges to the same single audit row (append-only trail).
          idempotencyKey: `executions.transitioned:${ctx.result.transition.transitionId}`,
          details: {
            fromStatus: ctx.result.transition.fromStatus,
            toStatus: ctx.result.transition.toStatus,
            retryClassification: ctx.result.transition.retryClassification,
            evidenceRef: ctx.result.transition.evidenceRef,
            replayed: ctx.result.replayed,
            transitionId: ctx.result.transition.transitionId,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, serializeExecutionTransitionOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/executions/:executionId/sandbox-leases — acquire the SANDBOX
  // LEASE (the durable Execution→Sandbox relationship,
  // implementation-contract-v1.2.md §1). Concurrency-safe and idempotent:
  // the database permits exactly ONE ACTIVE LEASE PER SANDBOX and one per
  // execution; a duplicate of the same logical acquisition command
  // converges (201 fresh / 200 replayed). Only a NON-TERMINAL
  // sandbox-class execution may acquire (pooled-worker executions hold no
  // sandbox). The optional expiresAt records the expiry/recovery metadata.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/executions/:executionId/sandbox-leases',
    defineMutationRoute<{ executionId: string }, LeaseAcquireOutcome>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => executionOwner(params.executionId),
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          sandboxId: string;
          idempotencyKey: string;
          expiresAt: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: LEASE_ACQUIRE_AUTHORITY_FIELDS,
          fields: {
            sandboxId: stringField({ minLength: 1, maxLength: 200 }),
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: EXECUTION_IDEMPOTENCY_KEY_MAX_LENGTH,
            }),
            expiresAt: optionalString({ pattern: LEASE_EXPIRES_AT_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          sandboxId: string;
          idempotencyKey: string;
          expiresAt: string | undefined;
        };
        return modules.executions.acquireExecutionSandboxLease({
          executionId: ctx.params.executionId,
          sandboxId: body.sandboxId,
          idempotencyKey: body.idempotencyKey,
          expiresAt: body.expiresAt === undefined ? null : body.expiresAt,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.sandbox_lease.acquired', undefined, {
          execution_id: ctx.result.lease.executionId,
          sandbox_id: ctx.result.lease.sandboxId,
          sandbox_lease_id: ctx.result.lease.sandboxLeaseId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.sandbox_lease.acquired',
          targetType: 'execution_sandbox_lease',
          targetId: ctx.result.lease.sandboxLeaseId,
          afterVersion: ctx.result.lease.version,
          // Keyed by the lease identity: a replayed duplicate converges to
          // the same single audit row.
          idempotencyKey: `executions.sandbox_lease.acquired:${ctx.result.lease.sandboxLeaseId}`,
          details: {
            executionId: ctx.result.lease.executionId,
            sandboxId: ctx.result.lease.sandboxId,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, serializeLeaseAcquireOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/executions/:executionId/sandbox-leases — the leases ever held
  // by this execution, oldest first (active + released history — read-only
  // evidence of the runtime resource relationship).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/executions/:executionId/sandbox-leases',
    defineQueryRoute<{ executionId: string }, readonly SandboxLeaseRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId);
      },
      execute: async (ctx) => {
        const execution = await modules.executions.getExecution(ctx.params.executionId);
        if (execution === null) {
          throw new NotFoundError('execution', ctx.params.executionId);
        }
        return modules.executions.listExecutionSandboxLeases(ctx.params.executionId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          executionId: ctx.params.executionId,
          leases: ctx.result.map(serializeSandboxLease),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/executions/:executionId/sandbox-leases/:leaseId/release —
  // release a sandbox lease: IDEMPOTENT (releasing an already-released
  // lease converges — 200 replayed, no write) and NEVER terminalizing (the
  // unchanged execution record is returned in the response as proof). A
  // lease id belonging to a DIFFERENT execution is indistinguishable from
  // an unknown one (uniform 404 under this execution). Releasing a STALE
  // lease (expires_at passed) is the deterministic pre-worker recovery
  // path. The body is empty — release carries no caller payload.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/executions/:executionId/sandbox-leases/:leaseId/release',
    defineMutationRoute<
      { executionId: string; leaseId: string },
      LeaseReleaseOutcome
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => executionOwner(params.executionId),
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: LEASE_RELEASE_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        return modules.executions.releaseExecutionSandboxLease({
          executionId: ctx.params.executionId,
          sandboxLeaseId: ctx.params.leaseId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.sandbox_lease.released', undefined, {
          execution_id: ctx.result.lease.executionId,
          sandbox_id: ctx.result.lease.sandboxId,
          sandbox_lease_id: ctx.result.lease.sandboxLeaseId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.sandbox_lease.released',
          targetType: 'execution_sandbox_lease',
          targetId: ctx.result.lease.sandboxLeaseId,
          afterVersion: ctx.result.lease.version,
          // Keyed by the lease identity and its post-release version: an
          // idempotent re-release converges to the same single audit row.
          idempotencyKey: `executions.sandbox_lease.released:${ctx.result.lease.sandboxLeaseId}`,
          details: {
            executionId: ctx.result.lease.executionId,
            sandboxId: ctx.result.lease.sandboxId,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeLeaseReleaseOutcome(ctx.result)),
    }),
  );
}
