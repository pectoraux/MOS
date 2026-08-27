/**
 * /users API routes (MKT-002).
 *
 *   POST   /api/users                                  create identity (platform admin)
 *   GET    /api/users/:userId                          read (self | platform admin)
 *   PATCH  /api/users/:userId/profile                  display name (self | admin, CAS)
 *   PATCH  /api/users/:userId/status                   enable/disable (platform admin, CAS)
 *   POST   /api/users/:userId/credential               provision/replace password (admin)
 *   POST   /api/users/:userId/platform-roles           grant platform role (admin)
 *   DELETE /api/users/:userId/platform-roles/:role     revoke platform role (admin)
 *
 * Caller-supplied authority fields (ids, status, versions, roles, timestamps)
 * are rejected at the validation step; identifiers and timestamps are always
 * server-derived. Disabling an identity also revokes every session (fail
 * closed, MKT-002-AC-05) — orchestrated here because it spans /users and
 * /auth, which the dependency matrix only joins at the application layer.
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
import { validateObject, intField, stringField } from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requirePlatformAdministrator } from './authorize.ts';
import type { PlatformRoleKey, UserRecord } from '../modules/users/public.ts';
import { PLATFORM_ROLE_KEYS } from '../modules/users/public.ts';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../modules/auth/public.ts';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS_PATTERN = /^(active|disabled)$/;
const PLATFORM_ROLE_PATTERN = new RegExp(`^(${PLATFORM_ROLE_KEYS.join('|')})$`);

const USER_AUTHORITY_FIELDS = [
  'userId',
  'status',
  'version',
  'platformRoles',
  'createdAt',
  'updatedAt',
] as const;

function serializeUser(user: UserRecord): Record<string, unknown> {
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    platformRoles: [...user.platformRoles],
    version: user.version,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function registerUsersRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('users.api');

  // User identity is PLATFORM-scoped (architecture.md §4: users live under
  // the platform, not under an agency) — the canonical owner for every
  // /users operation is the platform scope.
  const platformOwner: OwnerScope = { kind: 'platform' };

  // -------------------------------------------------------------------------
  // POST /api/users
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/users',
    defineMutationRoute<Record<string, string>, UserRecord>({
      authenticator: services.auth,
      resolveOwner: async () => platformOwner,
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ email: string; displayName: string }>(ctx.request.body, {
          forbiddenKeys: USER_AUTHORITY_FIELDS,
          fields: {
            email: stringField({ minLength: 3, maxLength: 254, pattern: EMAIL_PATTERN }),
            displayName: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { email: string; displayName: string };
        return modules.users.createUser(body);
      },
      emit: (ctx) => {
        logger.info('users.user.created', undefined, {
          user_id: ctx.result.userId,
          actor:
            ctx.principal.kind === 'service'
            ? ctx.principal.id
            : ctx.principal.kind === 'user'
              ? ctx.principal.userId
              : null,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(201, serializeUser(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/users/:userId
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/users/:userId',
    defineQueryRoute<{ userId: string }, UserRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'user' && ctx.principal.userId === ctx.params.userId) {
          return; // self read
        }
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      execute: async (ctx) => {
        const user = await modules.users.getUser(ctx.params.userId);
        if (user === null) {
          throw new NotFoundError('user', ctx.params.userId);
        }
        return user;
      },
      respond: (ctx) => jsonResponse(200, serializeUser(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/users/:userId/profile
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/users/:userId/profile',
    defineMutationRoute<{ userId: string }, UserRecord>({
      authenticator: services.auth,
      resolveOwner: async () => platformOwner,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'user' && ctx.principal.userId === ctx.params.userId) {
          return; // self rename
        }
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ displayName: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['email', 'userId', 'status', 'platformRoles', 'createdAt', 'updatedAt'],
          fields: {
            displayName: stringField({ minLength: 1, maxLength: 200 }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { displayName: string; version: number };
        return modules.users.updateProfile({
          userId: ctx.params.userId,
          displayName: body.displayName,
          expectedVersion: body.version,
        });
      },
      emit: (ctx) => {
        logger.info('users.user.profile_updated', undefined, {
          user_id: ctx.result.userId,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeUser(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/users/:userId/status (platform administrator)
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/users/:userId/status',
    defineMutationRoute<{ userId: string }, { user: UserRecord; revokedSessions: number }>({
      authenticator: services.auth,
      resolveOwner: async () => platformOwner,
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ status: string; version: number }>(ctx.request.body, {
          forbiddenKeys: ['email', 'displayName', 'userId', 'platformRoles', 'createdAt', 'updatedAt'],
          fields: {
            status: stringField({ pattern: STATUS_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: 'active' | 'disabled'; version: number };
        const user = await modules.users.setUserStatus({
          userId: ctx.params.userId,
          status: body.status,
          expectedVersion: body.version,
        });
        // Fail closed (MKT-002-AC-05): a disabled identity loses every
        // session immediately, not just at expiry.
        const revokedSessions =
          user.status === 'disabled' ? await modules.auth.revokeSessionsForUser(user.userId) : 0;
        return { user, revokedSessions };
      },
      emit: (ctx) => {
        logger.info('users.user.status_changed', undefined, {
          user_id: ctx.result.user.userId,
          status: ctx.result.user.status,
          revoked_sessions: ctx.result.revokedSessions,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          ...serializeUser(ctx.result.user),
          revokedSessions: ctx.result.revokedSessions,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/users/:userId/credential (platform administrator)
  // The password itself crosses into /auth only; /users records never hold
  // credential material (issue #6 data contract).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/users/:userId/credential',
    defineMutationRoute<{ userId: string }, { userId: string }>({
      authenticator: services.auth,
      resolveOwner: async () => platformOwner,
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ password: string }>(ctx.request.body, {
          forbiddenKeys: ['credentialId', 'verifier', 'scheme', 'status', 'userId'],
          fields: {
            password: stringField({
              minLength: MIN_PASSWORD_LENGTH,
              maxLength: MAX_PASSWORD_LENGTH,
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { password: string };
        if ((await modules.users.getUser(ctx.params.userId)) === null) {
          throw new NotFoundError('user', ctx.params.userId);
        }
        await modules.auth.issueCredential({ userId: ctx.params.userId, password: body.password });
        return { userId: ctx.params.userId };
      },
      emit: (ctx) => {
        logger.info('auth.credential.issued', undefined, {
          user_id: ctx.result.userId,
          actor:
            ctx.principal.kind === 'service'
            ? ctx.principal.id
            : ctx.principal.kind === 'user'
              ? ctx.principal.userId
              : null,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: () => jsonResponse(204, undefined),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/users/:userId/platform-roles (platform administrator)
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/users/:userId/platform-roles',
    defineMutationRoute<{ userId: string }, { user: UserRecord; role: PlatformRoleKey }>({
      authenticator: services.auth,
      resolveOwner: async () => platformOwner,
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ role: string }>(ctx.request.body, {
          forbiddenKeys: ['userId', 'grantedAt', 'version'],
          fields: {
            role: stringField({ pattern: PLATFORM_ROLE_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { role: PlatformRoleKey };
        const user = await modules.users.grantPlatformRole({
          userId: ctx.params.userId,
          role: body.role,
        });
        return { user, role: body.role };
      },
      emit: (ctx) => {
        logger.info('users.platform_role.granted', undefined, {
          user_id: ctx.result.user.userId,
          role: ctx.result.role,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeUser(ctx.result.user)),
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/users/:userId/platform-roles/:role (platform administrator)
  // -------------------------------------------------------------------------
  router.add(
    'DELETE',
    '/api/users/:userId/platform-roles/:role',
    defineMutationRoute<{ userId: string; role: string }, { user: UserRecord; role: string }>({
      authenticator: services.auth,
      resolveOwner: async () => platformOwner,
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) => {
        if (!PLATFORM_ROLE_KEYS.includes(ctx.params.role as PlatformRoleKey)) {
          throw new NotFoundError('platform role', ctx.params.role);
        }
        return {};
      },
      execute: async (ctx) => {
        const user = await modules.users.revokePlatformRole({
          userId: ctx.params.userId,
          role: ctx.params.role as PlatformRoleKey,
        });
        return { user, role: ctx.params.role };
      },
      emit: (ctx) => {
        logger.info('users.platform_role.revoked', undefined, {
          user_id: ctx.result.user.userId,
          role: ctx.result.role,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeUser(ctx.result.user)),
    }),
  );
}
