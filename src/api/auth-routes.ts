/**
 * /auth API routes (MKT-002).
 *
 *   POST /api/auth/login                    email+password → session token
 *   POST /api/auth/logout                   revoke the presented session
 *   GET  /api/auth/authorization-context    canonical server-side context
 *
 * Login is the authentication boundary itself: the §23 pipeline step
 * "authenticate" IS this operation (there is no prior principal to
 * authenticate). It still follows the remaining pipeline discipline:
 * strict body validation with authority-field rejection, server-derived
 * fields only (session id, token, expiry), material-mutation observability
 * record, normalized response. Logout and authorization-context use the
 * standard pipeline with the composite authenticator.
 */

import { UnauthorizedError } from '../platform/errors/errors.ts';
import { defineMutationRoute, jsonResponse, type OwnerScope } from '../platform/http/pipeline.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { validateObject, stringField } from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { recordMutationAudit } from './audit-emit.ts';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Authority fields never accepted from callers (security-threat-model: authority injection). */
const LOGIN_FORBIDDEN_FIELDS = [
  'token',
  'sessionId',
  'expiresAt',
  'userId',
  'principal',
  'roles',
  'platformRoles',
  'memberships',
] as const;

type LoginBody = {
  readonly email: string;
  readonly password: string;
};

export function registerAuthRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('auth.api');

  // ---------------------------------------------------------------------------
  // POST /api/auth/login
  // ---------------------------------------------------------------------------
  router.add('POST', '/api/auth/login', async (request) => {
    // Step 4 (validate) — first because steps 1–3 are the operation itself:
    // this endpoint AUTHENTICATES the caller (see module doc comment).
    const body = validateObject<LoginBody>(request.body, {
      forbiddenKeys: LOGIN_FORBIDDEN_FIELDS,
      fields: {
        email: stringField({ minLength: 3, maxLength: 254, pattern: EMAIL_PATTERN }),
        password: stringField({ minLength: 12, maxLength: 256 }),
      },
    });

    // Steps 5–6 (derive + execute): the module verifies the credential
    // against the durable auth store and opens the session. Failures are a
    // uniform 401 (no account enumeration).
    let credential;
    try {
      credential = await modules.auth.login({ email: body.email, password: body.password });
    } catch (error) {
      // Material AUTHORIZATION failure event (AUD-001): login attempts are
      // auditable security events. Best-effort with a loud log on audit
      // failure — the original 401 must not be masked (a failed login makes
      // no completion claim).
      try {
        await recordMutationAudit(modules, { kind: 'anonymous' }, { kind: 'platform' }, {
          action: 'auth.login.failed',
          targetType: 'user_email',
          targetId: body.email,
          result: 'failed',
          idempotencyKey: null,
          details: { reason: 'invalid_credentials' },
        });
      } catch (auditError) {
        logger.error('audit.append.failed', String(auditError), {
          action: 'auth.login.failed',
          correlation_id: currentCorrelation().correlationId,
        });
      }
      throw error;
    }

    // Step 7 (emit): material-mutation record with correlation identity,
    // then the DURABLE audit event (AUD-001) — the session is only claimed
    // (responded) after its audit row is persisted. Audit failure fails the
    // request instead of silently losing the event.
    const correlation = currentCorrelation();
    logger.info('auth.session.created', undefined, {
      session_id: credential.sessionId,
      user_id: credential.userId,
      correlation_id: correlation.correlationId,
    });
    await recordMutationAudit(
      modules,
      { kind: 'user', userId: credential.userId, email: body.email, displayName: body.email },
      { kind: 'platform' },
      {
        action: 'auth.login.succeeded',
        targetType: 'user',
        targetId: credential.userId,
        idempotencyKey: null,
        details: { sessionId: credential.sessionId },
      },
    );

    // Step 8 (respond): the raw token is shown exactly this once.
    return jsonResponse(200, {
      token: credential.token,
      tokenType: 'Bearer',
      sessionId: credential.sessionId,
      userId: credential.userId,
      expiresAt: credential.expiresAt,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/auth/logout — revoke the session presented on this request.
  // ---------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/auth/logout',
    defineMutationRoute<Record<string, string>, { revoked: boolean }>({
      authenticator: services.auth,

      resolveOwner: async (): Promise<OwnerScope> => {
        // Session revocation is platform-scoped (identity, not tenant data).
        return { kind: 'platform' };
      },

      authorize: async (ctx) => {
        if (ctx.principal.kind !== 'user') {
          throw new UnauthorizedError('Only user sessions can be revoked');
        }
      },

      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: ['token', 'sessionId', 'userId', 'status'],
          fields: {},
        }),

      execute: async (ctx) => {
        const header = ctx.request.headers['authorization'];
        const raw = Array.isArray(header) ? header[0] : header;
        const token = raw === undefined ? '' : raw.slice('Bearer '.length);
        return { revoked: await modules.auth.revokeSessionByToken(token) };
      },

      emit: async (ctx) => {
        const correlation = currentCorrelation();
        logger.info('auth.session.revoked', undefined, {
          user_id: ctx.principal.kind === 'user' ? ctx.principal.userId : ctx.principal.kind === 'service' ? ctx.principal.id : null,
          revoked: ctx.result.revoked,
          correlation_id: correlation.correlationId,
        });
        if (ctx.result.revoked) {
          await recordMutationAudit(modules, ctx.principal, ctx.owner, {
            action: 'auth.session.revoked',
            targetType: 'user',
            targetId: ctx.principal.kind === 'user' ? ctx.principal.userId : 'unknown',
            idempotencyKey: null,
          });
        }
      },

      respond: (ctx) =>
        jsonResponse(ctx.result.revoked ? 200 : 200, { revoked: ctx.result.revoked }),
    }),
  );

  // ---------------------------------------------------------------------------
  // GET /api/auth/authorization-context — canonical permission resolution
  // (MKT-002-AC-04). Informational read model for the CALLER'S OWN context;
  // enforcement happens per-route server-side and never trusts this output.
  // ---------------------------------------------------------------------------
  router.add('GET', '/api/auth/authorization-context', async (request) => {
    const principal = await services.auth.authenticate(request.headers);

    if (principal.kind === 'service') {
      return jsonResponse(200, {
        principal: { kind: 'service', id: principal.id, label: principal.label },
        platformRoles: [],
        memberships: [],
        resolvedAt: services.clock.nowIso(),
      });
    }
    if (principal.kind !== 'user') {
      throw new UnauthorizedError('Invalid credentials');
    }

    const context = await modules.agencies.resolveAuthorizationContext(principal.userId);
    if (context === null || context.principal.status !== 'active') {
      throw new UnauthorizedError('Invalid credentials');
    }
    return jsonResponse(200, context);
  });
}
