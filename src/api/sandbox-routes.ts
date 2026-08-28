/**
 * Sandbox lifecycle API routes (MKT-012 — execution sandboxes: RUNTIME-001,
 * acceptance RUNTIME-AC-01..04 with the v1.4 supersession of AC-02).
 *
 *   POST   /api/workspaces/:workspaceId/sandboxes            provision a sandbox (owner|admin|platform admin)
 *   GET    /api/workspaces/:workspaceId/sandboxes            the Workspace's sandboxes in ALL states (any active member)
 *   GET    /api/sandboxes/:sandboxId                         read one sandbox (any active member)
 *   GET    /api/sandboxes/:sandboxId/transitions             append-only transition history (any active member)
 *   GET    /api/sandboxes/:sandboxId/leases                  the leases ever held on the sandbox (any active member)
 *   POST   /api/sandboxes/:sandboxId/prepare                 the prepare protocol: requested → preparing → ready|failed (owner|admin|platform admin)
 *   POST   /api/sandboxes/:sandboxId/cancel                  the cancel protocol: → cancelled → released (owner|admin|platform admin)
 *   POST   /api/sandboxes/:sandboxId/release                 the release protocol: → releasing → released (owner|admin|platform admin)
 *
 * The sandbox is the runtime ENVIRONMENT identity of the chain the work
 * order fixes — Execution → Runtime Class → Sandbox → Lease → Worker —
 * Workspace/Client-scoped, with NO execution ownership in its identity
 * (tenant-runtime-v1.2.md; implementation-contract-v1.2.md §1). Its
 * lifecycle and lease records are governed through the execution/runtime
 * contract exposed by /executions (implementation-clarifications-v1.2.md
 * "Runtime authority") — these routes expose exactly that module surface;
 * there is NO second runtime engine here: a sandbox never transitions an
 * Execution, and Workflow orchestration / AI-provider routing stay out of
 * the sandbox layer.
 *
 * Route validation is the ENVELOPE (types, bounds, authority-field
 * rejection — including explicit rejection of credential-shaped fields per
 * RUNTIME-AC-03: sandbox credentials are injected just-in-time and never
 * travel in request or durable payloads); the frozen 8-edge sandbox
 * machine, the §8 provisioning fences, the reuse fence, the teardown gate
 * and the lease concurrency contract are the /executions MODULE authority
 * and run there on every command (the DB triggers are the final backstops).
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
  optionalArrayField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireSandboxAccess, requireWorkspaceAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  RuntimeClass,
  SandboxConcurrencyContract,
  SandboxLifecycleOutcome,
  SandboxRecord,
  SandboxTransitionRecord,
  SandboxProvisionOutcome,
} from '../modules/executions/public.ts';

const SANDBOX_CLASS_PATTERN = /^(ephemeral-sandbox|persistent-sandbox|dedicated-runtime)$/;
const SANDBOX_CONCURRENCY_PATTERN = /^(exclusive|concurrent-safe)$/;
const SANDBOX_CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
 * Sandbox lifecycle COMMAND keys are bounded to 100 characters: the module
 * derives per-edge ledger keys from them (see the module's bound).
 */
const SANDBOX_COMMAND_KEY_MAX_LENGTH = 100;
const SANDBOX_ENVIRONMENT_IDENTITY_MAX_LENGTH = 200;

/**
 * Fields that are always server-derived on PROVISION (authority fields).
 * The credential-shaped names are rejected EXPLICITLY (RUNTIME-AC-03:
 * sandbox credentials are policy-scoped, injected just-in-time and absent
 * from request and durable payloads — a static architecture test pins this
 * list).
 */
const SANDBOX_PROVISION_AUTHORITY_FIELDS = [
  'sandboxId',
  'workspaceId',
  'clientId',
  'agencyId',
  'status',
  'version',
  'resourceDescriptor',
  'prepareError',
  'releasedAt',
  'provisionFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Credential-shaped fields are never accepted on any sandbox payload.
  'credentials',
  'credentialRef',
  'credentialId',
  'secrets',
  'secretRef',
  'token',
  'apiKey',
  'password',
] as const;

/**
 * The lifecycle protocol commands (prepare/cancel/release) carry ONLY the
 * §8 command key — every other field is server-derived state.
 */
const SANDBOX_PROTOCOL_AUTHORITY_FIELDS = [
  'sandboxId',
  'workspaceId',
  'clientId',
  'agencyId',
  'runtimeClass',
  'environmentIdentity',
  'capabilities',
  'concurrencyContract',
  'status',
  'fromStatus',
  'toStatus',
  'resourceDescriptor',
  'prepareError',
  'releasedAt',
  'version',
  'replayed',
  'createdBy',
  'createdAt',
  'updatedAt',
  'credentials',
  'secrets',
  'token',
] as const;

/** The validated provision envelope. */
type ValidatedProvisionEnvelope = {
  readonly runtimeClass: string;
  readonly environmentIdentity: string | undefined;
  readonly capabilities: string[] | undefined;
  readonly concurrencyContract: string | undefined;
  readonly idempotencyKey: string;
};

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeSandbox(sandbox: SandboxRecord): Record<string, unknown> {
  return {
    sandboxId: sandbox.sandboxId,
    workspaceId: sandbox.workspaceId,
    clientId: sandbox.clientId,
    runtimeClass: sandbox.runtimeClass,
    environmentIdentity: sandbox.environmentIdentity,
    capabilities: sandbox.capabilities,
    concurrencyContract: sandbox.concurrencyContract,
    status: sandbox.status,
    ...(sandbox.resourceDescriptor === null
      ? {}
      : { resourceDescriptor: sandbox.resourceDescriptor }),
    ...(sandbox.prepareError === null ? {} : { prepareError: sandbox.prepareError }),
    ...(sandbox.releasedAt === null ? {} : { releasedAt: sandbox.releasedAt }),
    idempotencyKey: sandbox.idempotencyKey,
    version: sandbox.version,
    ...(sandbox.createdBy === null ? {} : { createdBy: sandbox.createdBy }),
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
  };
}

function serializeSandboxTransition(
  transition: SandboxTransitionRecord,
): Record<string, unknown> {
  return {
    transitionId: transition.transitionId,
    sandboxId: transition.sandboxId,
    idempotencyKey: transition.idempotencyKey,
    fromStatus: transition.fromStatus,
    toStatus: transition.toStatus,
    ...(transition.reason === null ? {} : { reason: transition.reason }),
    ...(transition.createdBy === null ? {} : { createdBy: transition.createdBy }),
    createdAt: transition.createdAt,
  };
}

function serializeProvisionOutcome(outcome: SandboxProvisionOutcome): Record<string, unknown> {
  return {
    sandbox: serializeSandbox(outcome.sandbox),
    replayed: outcome.replayed,
  };
}

function serializeLifecycleOutcome(outcome: SandboxLifecycleOutcome): Record<string, unknown> {
  return {
    sandbox: serializeSandbox(outcome.sandbox),
    transition: serializeSandboxTransition(outcome.transition),
    replayed: outcome.replayed,
  };
}

export function registerSandboxRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('executions.sandboxes.api');

  /**
   * Canonical Workspace owner scope for Workspace-scoped sandbox routes
   * (mirrors the executions routes): resolved through /workspaces canonical
   * owner resolution before authorize/validate/execute.
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
   * Canonical Sandbox owner scope: the sandbox row → its owning Workspace →
   * the owning Client → the owning Agency, resolved from durable state
   * before authorize/validate/execute. Unknown, deleted-boundary and (for
   * the caller) foreign identifiers all surface as the same 404 here or in
   * authorize — never as a traversal.
   */
  async function sandboxOwner(sandboxId: string): Promise<OwnerScope> {
    const ownership = await modules.executions.resolveSandboxOwnership(sandboxId);
    if (ownership === null) {
      throw new NotFoundError('sandbox', sandboxId);
    }
    return {
      kind: 'sandbox',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      sandboxId: ownership.scope.sandboxId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/workspaces/:workspaceId/sandboxes — provision a
  // WORKSPACE-SCOPED sandbox: the runtime ENVIRONMENT identity, born
  // REQUESTED. The §8 logical idempotency key is REQUIRED (duplicate of the
  // same command converges; a key reused for a different command is a 409);
  // the reusable classes (persistent/dedicated) require the caller-named
  // environmentIdentity (a second provisioning of the same LIVE environment
  // converges to it — reuse), the ephemeral class forbids it (server nonce).
  // Provisioning is NEW USE (ACTIVE boundaries required).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/sandboxes',
    defineMutationRoute<{ workspaceId: string }, SandboxProvisionOutcome>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedProvisionEnvelope>(ctx.request.body, {
          forbiddenKeys: SANDBOX_PROVISION_AUTHORITY_FIELDS,
          fields: {
            runtimeClass: stringField({ pattern: SANDBOX_CLASS_PATTERN }),
            environmentIdentity: optionalString({
              minLength: 1,
              maxLength: SANDBOX_ENVIRONMENT_IDENTITY_MAX_LENGTH,
            }),
            capabilities: optionalArrayField({
              minItems: 0,
              maxItems: 16,
              item: stringField({ pattern: SANDBOX_CAPABILITY_PATTERN }),
            }),
            concurrencyContract: optionalString({ pattern: SANDBOX_CONCURRENCY_PATTERN }),
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: SANDBOX_COMMAND_KEY_MAX_LENGTH,
            }),
          },
        }),
      execute: async (ctx) => {
        const envelope = ctx.validated as ValidatedProvisionEnvelope;
        return modules.executions.provisionSandbox({
          workspaceId: ctx.params.workspaceId,
          runtimeClass: envelope.runtimeClass as RuntimeClass,
          environmentIdentity: envelope.environmentIdentity ?? null,
          capabilities: envelope.capabilities ?? [],
          concurrencyContract: (envelope.concurrencyContract ?? 'exclusive') as SandboxConcurrencyContract,
          idempotencyKey: envelope.idempotencyKey,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.sandbox.provisioned', undefined, {
          workspace_id: ctx.result.sandbox.workspaceId,
          sandbox_id: ctx.result.sandbox.sandboxId,
          runtime_class: ctx.result.sandbox.runtimeClass,
          concurrency_contract: ctx.result.sandbox.concurrencyContract,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.sandbox.provisioned',
          targetType: 'sandbox',
          targetId: ctx.result.sandbox.sandboxId,
          afterVersion: ctx.result.sandbox.version,
          // Keyed by the sandbox identity: a replayed duplicate converges
          // to the same single audit row (append-only trail).
          idempotencyKey: `executions.sandbox.provisioned:${ctx.result.sandbox.sandboxId}`,
          details: {
            runtimeClass: ctx.result.sandbox.runtimeClass,
            environmentIdentity: ctx.result.sandbox.environmentIdentity,
            concurrencyContract: ctx.result.sandbox.concurrencyContract,
            // Audit details carry JSON scalars only — the capability list is
            // serialized (the full record is the durable sandbox row).
            capabilities: ctx.result.sandbox.capabilities.join(','),
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, serializeProvisionOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/sandboxes — every sandbox of the
  // Workspace in EVERY lifecycle state (terminal history is visible
  // business record).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/sandboxes',
    defineQueryRoute<{ workspaceId: string }, readonly SandboxRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.executions.listSandboxesForWorkspace(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          sandboxes: ctx.result.map(serializeSandbox),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/sandboxes/:sandboxId — read one sandbox (any state).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/sandboxes/:sandboxId',
    defineQueryRoute<{ sandboxId: string }, SandboxRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireSandboxAccess(modules, ctx.principal, ctx.params.sandboxId);
      },
      execute: async (ctx) => {
        const sandbox = await modules.executions.getSandbox(ctx.params.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', ctx.params.sandboxId);
        }
        return sandbox;
      },
      respond: (ctx) => jsonResponse(200, serializeSandbox(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/sandboxes/:sandboxId/transitions — the append-only
  // applied-transition history (every lifecycle decision, the provisioning
  // and teardown idempotency ledger).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/sandboxes/:sandboxId/transitions',
    defineQueryRoute<{ sandboxId: string }, readonly SandboxTransitionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireSandboxAccess(modules, ctx.principal, ctx.params.sandboxId);
      },
      execute: async (ctx) => {
        const sandbox = await modules.executions.getSandbox(ctx.params.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', ctx.params.sandboxId);
        }
        return modules.executions.getSandboxTransitions(ctx.params.sandboxId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          sandboxId: ctx.params.sandboxId,
          transitions: ctx.result.map(serializeSandboxTransition),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/sandboxes/:sandboxId/leases — the leases ever held on this
  // sandbox, oldest first (read-only evidence of the Execution→Sandbox
  // relationships).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/sandboxes/:sandboxId/leases',
    defineQueryRoute<
      { sandboxId: string },
      ReturnType<typeof serializeSandbox>[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireSandboxAccess(modules, ctx.principal, ctx.params.sandboxId);
      },
      execute: async (ctx) => {
        const sandbox = await modules.executions.getSandbox(ctx.params.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', ctx.params.sandboxId);
        }
        const leases = await modules.executions.listSandboxLeases(ctx.params.sandboxId);
        return leases.map((lease) => ({
          sandboxLeaseId: lease.sandboxLeaseId,
          sandboxId: lease.sandboxId,
          executionId: lease.executionId,
          workspaceId: lease.workspaceId,
          clientId: lease.clientId,
          status: lease.status,
          concurrencyContract: lease.concurrencyContract,
          ...(lease.acquiredBy === null ? {} : { acquiredBy: lease.acquiredBy }),
          ...(lease.releasedAt === null ? {} : { releasedAt: lease.releasedAt }),
          ...(lease.expiresAt === null ? {} : { expiresAt: lease.expiresAt }),
          idempotencyKey: lease.idempotencyKey,
          version: lease.version,
          createdAt: lease.createdAt,
          updatedAt: lease.updatedAt,
        }));
      },
      respond: (ctx) =>
        jsonResponse(200, {
          sandboxId: ctx.params.sandboxId,
          leases: ctx.result,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/sandboxes/:sandboxId/prepare — the PREPARE protocol: the
  // recorded requested → preparing edge, the driver provisioning, and the
  // settle edge preparing → ready (resource descriptor) | failed (recorded
  // provisioning failure). State-driven convergence: duplicates and
  // crash-window re-attempts converge on the SAME sandbox.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/sandboxes/:sandboxId/prepare',
    defineMutationRoute<{ sandboxId: string }, SandboxLifecycleOutcome>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => sandboxOwner(params.sandboxId),
      authorize: async (ctx) => {
        await requireSandboxAccess(modules, ctx.principal, ctx.params.sandboxId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ idempotencyKey: string }>(ctx.request.body, {
          forbiddenKeys: SANDBOX_PROTOCOL_AUTHORITY_FIELDS,
          fields: {
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: SANDBOX_COMMAND_KEY_MAX_LENGTH,
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { idempotencyKey: string };
        return modules.executions.prepareSandbox({
          sandboxId: ctx.params.sandboxId,
          idempotencyKey: body.idempotencyKey,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.sandbox.prepared', undefined, {
          sandbox_id: ctx.result.sandbox.sandboxId,
          from_status: ctx.result.transition.fromStatus,
          to_status: ctx.result.transition.toStatus,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.sandbox.prepared',
          targetType: 'sandbox',
          targetId: ctx.result.sandbox.sandboxId,
          afterVersion: ctx.result.sandbox.version,
          idempotencyKey: `executions.sandbox.prepared:${ctx.result.transition.transitionId}`,
          details: {
            toStatus: ctx.result.transition.toStatus,
            replayed: ctx.result.replayed,
            transitionId: ctx.result.transition.transitionId,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeLifecycleOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/sandboxes/:sandboxId/cancel — the CANCEL protocol: the frozen
  // cancel edge (preparing|ready → cancelled; requested cannot be cancelled
  // — REQUESTED's only forward edge is PREPARING) and the teardown
  // completion (cancelled → released). Gated on zero active leases.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/sandboxes/:sandboxId/cancel',
    defineMutationRoute<{ sandboxId: string }, SandboxLifecycleOutcome>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => sandboxOwner(params.sandboxId),
      authorize: async (ctx) => {
        await requireSandboxAccess(modules, ctx.principal, ctx.params.sandboxId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ idempotencyKey: string }>(ctx.request.body, {
          forbiddenKeys: SANDBOX_PROTOCOL_AUTHORITY_FIELDS,
          fields: {
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: SANDBOX_COMMAND_KEY_MAX_LENGTH,
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { idempotencyKey: string };
        return modules.executions.cancelSandbox({
          sandboxId: ctx.params.sandboxId,
          idempotencyKey: body.idempotencyKey,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.sandbox.cancelled', undefined, {
          sandbox_id: ctx.result.sandbox.sandboxId,
          from_status: ctx.result.transition.fromStatus,
          to_status: ctx.result.transition.toStatus,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.sandbox.cancelled',
          targetType: 'sandbox',
          targetId: ctx.result.sandbox.sandboxId,
          afterVersion: ctx.result.sandbox.version,
          idempotencyKey: `executions.sandbox.cancelled:${ctx.result.transition.transitionId}`,
          details: {
            toStatus: ctx.result.transition.toStatus,
            replayed: ctx.result.replayed,
            transitionId: ctx.result.transition.transitionId,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeLifecycleOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/sandboxes/:sandboxId/release — the RELEASE protocol: the
  // graceful teardown (ready → releasing → released; also completes
  // cancelled → released and re-drives crash-window releasing sandboxes).
  // IDEMPOTENT and recoverable; gated on zero active leases; NEVER
  // terminalizes any Execution.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/sandboxes/:sandboxId/release',
    defineMutationRoute<{ sandboxId: string }, SandboxLifecycleOutcome>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => sandboxOwner(params.sandboxId),
      authorize: async (ctx) => {
        await requireSandboxAccess(modules, ctx.principal, ctx.params.sandboxId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ idempotencyKey: string }>(ctx.request.body, {
          forbiddenKeys: SANDBOX_PROTOCOL_AUTHORITY_FIELDS,
          fields: {
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: SANDBOX_COMMAND_KEY_MAX_LENGTH,
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { idempotencyKey: string };
        return modules.executions.releaseSandbox({
          sandboxId: ctx.params.sandboxId,
          idempotencyKey: body.idempotencyKey,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('executions.sandbox.released', undefined, {
          sandbox_id: ctx.result.sandbox.sandboxId,
          from_status: ctx.result.transition.fromStatus,
          to_status: ctx.result.transition.toStatus,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'executions.sandbox.released',
          targetType: 'sandbox',
          targetId: ctx.result.sandbox.sandboxId,
          afterVersion: ctx.result.sandbox.version,
          idempotencyKey: `executions.sandbox.released:${ctx.result.transition.transitionId}`,
          details: {
            toStatus: ctx.result.transition.toStatus,
            replayed: ctx.result.replayed,
            transitionId: ctx.result.transition.transitionId,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeLifecycleOutcome(ctx.result)),
    }),
  );
}
