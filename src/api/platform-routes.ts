/**
 * Platform API routes (MKT-001).
 *
 * Conventions established here (spec/implementation-contract.md §23):
 *   - mutations run the full pipeline via defineMutationRoute;
 *   - long-running operations return 202 + durable operation identifier
 *     (the platform job id) plus a status link;
 *   - server-authoritative fields (job id, status, correlation id, submitter,
 *     timestamps, results) are derived server-side and REJECTED if supplied;
 *   - idempotent submission: same idempotency key + payload converges to the
 *     same operation; same key + different payload is a 409.
 *
 * Routes:
 *   GET  /api/platform/health              liveness (unauthenticated)
 *   POST /api/platform/operations          submit asynchronous operation (202)
 *   GET  /api/platform/operations/:id      operation status
 */

import type { AppServices } from '../platform/app-services.ts';
import { NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import { validateObject, optionalString, stringField, recordField, optionalInt } from '../platform/http/validation.ts';
import type { JobRecord } from '../platform/queue/contract.ts';
import { LONG_RUNNING_WORK_KIND } from '../workers/handlers.ts';

type SubmitOperationsBody = {
  readonly handler: string;
  readonly input: Record<string, unknown>;
  readonly idempotencyKey: string | undefined;
  readonly maxAttempts: number | undefined;
};

/**
 * Authority fields must never be accepted from callers
 * (spec/security-threat-model.md: "Authority injection").
 */
const FORBIDDEN_AUTHORITY_FIELDS = [
  'jobId',
  'operationId',
  'status',
  'result',
  'error',
  'attempts',
  'version',
  'correlationId',
  'causationId',
  'submittedBy',
  'createdAt',
  'updatedAt',
  'claimedBy',
] as const;

export function buildPlatformRouter(services: AppServices): Router {
  const router = new Router();
  const logger = services.observability.loggerFactory.forModule('platform.api');

  // Liveness (unauthenticated by design: exposes no state).
  router.add('GET', '/api/platform/health', async () =>
    jsonResponse(200, {
      status: 'ok',
      service: 'marketingos-platform-api',
      env: services.config.env,
      time: services.clock.nowIso(),
    }),
  );

  // Submit an asynchronous platform operation (long-running work).
  router.add(
    'POST',
    '/api/platform/operations',
    defineMutationRoute<Record<string, string>, { job: JobRecord; replayed: boolean }>({
      authenticator: services.auth,

      resolveOwner: async (): Promise<OwnerScope> => {
        // MKT-001 has no tenant hierarchy yet (MKT-002..004); platform
        // operations resolve to the platform scope. Tenant-scoped operations
        // will resolve Agency → Client → Workspace owners in later Work Items
        // BEFORE any dependent traversal (implementation-contract §2).
        return { kind: 'platform' };
      },

      authorize: async (ctx) => {
        // Fail-closed boundary convention: only service principals may submit
        // platform operations; user principals arrive with MKT-002.
        if (ctx.principal.kind !== 'service') {
          throw new NotFoundError('route', ctx.request.path);
        }
      },

      validate: (ctx) =>
        validateObject<SubmitOperationsBody>(ctx.request.body, {
          forbiddenKeys: FORBIDDEN_AUTHORITY_FIELDS,
          fields: {
            handler: stringField({ minLength: 1, maxLength: 200 }),
            input: recordField({ maxDepthKeys: 100 }),
            idempotencyKey: optionalString({ minLength: 8, maxLength: 200 }),
            maxAttempts: optionalInt({ min: 1, max: 100 }),
          },
        }),

      execute: async (ctx) => {
        const body = ctx.validated as SubmitOperationsBody;

        if (body.handler !== LONG_RUNNING_WORK_KIND) {
          throw new NotFoundError('handler', body.handler);
        }

        // Server-authoritative derivation: correlation identity comes from the
        // ambient request correlation context, submitter from the principal.
        const correlation = currentCorrelation();
        const submitResult = await services.queue.submit({
          handlerKind: body.handler,
          payload: body.input,
          ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
          ...(body.maxAttempts === undefined ? {} : { maxAttempts: body.maxAttempts }),
          correlation: {
            correlationId: correlation.correlationId,
            causationId: correlation.causationId,
            actor: ctx.principal.kind === 'service' ? ctx.principal.id : null,
          },
          submittedBy: ctx.principal.kind === 'service' ? ctx.principal.id : 'unknown',
        });
        return submitResult;
      },

      emit: (ctx) => {
        // Material-mutation observability event (pipeline step 7). The
        // append-only /audit authority (MKT-005) will persist audit events;
        // this structured record already carries correlation identity.
        logger.info('operation.submitted', undefined, {
          operation_id: ctx.result.job.jobId,
          handler: ctx.result.job.handlerKind,
          replayed: ctx.result.replayed,
          submitted_by: ctx.result.job.submittedBy,
          correlation_id: ctx.result.job.correlationId,
        });
      },

      respond: (ctx) =>
        jsonResponse(
          202,
          {
            operationId: ctx.result.job.jobId,
            status: ctx.result.job.status,
            correlationId: ctx.result.job.correlationId,
            idempotentReplay: ctx.result.replayed,
            links: { status: `/api/platform/operations/${ctx.result.job.jobId}` },
          },
          {
            Location: `/api/platform/operations/${ctx.result.job.jobId}`,
            ...(ctx.result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
          },
        ),
    }),
  );

  // Operation status.
  router.add(
    'GET',
    '/api/platform/operations/:operationId',
    defineQueryRoute<{ operationId: string }, JobRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind !== 'service') {
          throw new NotFoundError('route', ctx.request.path);
        }
      },
      execute: async (ctx) => {
        const job = await services.queue.get(ctx.params.operationId);
        if (job === null) {
          throw new NotFoundError('operation', ctx.params.operationId);
        }
        return job;
      },
      respond: (ctx) => jsonResponse(200, serializeOperation(ctx.result)),
    }),
  );

  return router;
}

export function serializeOperation(job: JobRecord): Record<string, unknown> {
  return {
    operationId: job.jobId,
    handler: job.handlerKind,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    correlationId: job.correlationId,
    submittedBy: job.submittedBy,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(job.result === null ? {} : { result: job.result }),
    ...(job.error === null ? {} : { error: job.error }),
  };
}
