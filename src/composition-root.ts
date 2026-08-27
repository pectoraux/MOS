/**
 * Composition root (spec/module-dependency-matrix.md: "Provider SDKs,
 * concrete queue/storage clients, sandbox drivers, browser drivers and
 * external integration adapters are wired at the composition root").
 *
 * This is the ONLY place in src/ where concrete adapters are imported.
 * API routes, workers and domain modules depend on the contracts in
 * src/platform/<concern>/contract.ts exclusively — enforced by the static
 * architecture checker (tools/arch-check).
 *
 * MKT-002 additions:
 *   - the /users, /auth and /agencies modules are constructed here with
 *     platform ports + the allowed module-to-module dependencies
 *     (/auth → /users; /agencies → /users);
 *   - the HTTP authenticator becomes a composite: user sessions (auth module)
 *     first, then the MKT-001 internal service token — both fail closed;
 *   - optional idempotent platform-administrator bootstrap from explicit
 *     configuration (never raw-material persistence: only the scrypt
 *     verifier lands in the auth-owned credential store).
 */

import { loadConfig, type AppConfig } from './platform/config/config.ts';
import { SystemClock } from './platform/clock/clock.ts';
import { CryptoIdGenerator } from './platform/ids/ids.ts';
import { PgDb } from './platform/db/adapters/postgres/pg-db.ts';
import { runMigrations } from './platform/db/migrate.ts';
import { PgQueue } from './platform/queue/adapters/postgres/pg-queue.ts';
import { MemoryObjectStore } from './platform/objects/adapters/memory/memory-object-store.ts';
import { FsObjectStore } from './platform/objects/adapters/fs/fs-object-store.ts';
import { ConsoleSink } from './platform/observability/adapters/console/console-sink.ts';
import { CompositeSink } from './platform/observability/adapters/composite/composite-sink.ts';
import { createLoggerFactory } from './platform/observability/logger.ts';
import { InMemoryMetrics } from './platform/observability/metrics.ts';
import { InternalTokenAuthenticator } from './platform/http/auth/adapters/internal-token/internal-token-authenticator.ts';
import { CompositeAuthenticator } from './platform/http/auth/adapters/composite/composite-authenticator.ts';
import type { AppServices } from './platform/app-services.ts';
import type { ObservabilitySink } from './platform/observability/contract.ts';
import type { Logger } from './platform/observability/contract.ts';
import { createUsersModule } from './modules/users/public.ts';
import { createAuthModule } from './modules/auth/public.ts';
import { createAgenciesModule } from './modules/agencies/public.ts';
import type { ApplicationModules } from './api/application.ts';

export interface AppOptions {
  /** Additional observability sinks (e.g., test collectors). */
  readonly extraSinks?: ReadonlyArray<ObservabilitySink> | undefined;
  /** Override the primary sink (tests capture records without console noise). */
  readonly primarySink?: ObservabilitySink | undefined;
}

interface Core {
  readonly services: AppServices;
  readonly modules: ApplicationModules;
}

function buildCore(config: AppConfig, options: AppOptions): Core {
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();

  const db = new PgDb(config.databaseUrl);
  const queue = new PgQueue(db, () => ids.newId());

  const objects =
    config.objectStore === 'fs'
      ? new FsObjectStore(config.objectStoreDir)
      : new MemoryObjectStore();

  const primarySink = options.primarySink ?? new ConsoleSink();
  const sink =
    options.extraSinks === undefined || options.extraSinks.length === 0
      ? primarySink
      : new CompositeSink([primarySink, ...options.extraSinks]);

  const loggerFactory = createLoggerFactory({ sink, clock, minLevel: config.logLevel });
  const metrics = new InMemoryMetrics();

  // Module wiring (dependency matrix: /auth → /users; /agencies → /users, /auth).
  const users = createUsersModule({ db, clock, ids });
  const auth = createAuthModule({
    db,
    clock,
    ids,
    users,
    sessionTtlMs: config.authSessionTtlMs,
  });
  const agencies = createAgenciesModule({ db, clock, ids, users });

  // Authentication order: user sessions first, then the internal service
  // token. Every path fails closed (CompositeAuthenticator).
  const authenticator = new CompositeAuthenticator([
    auth.requestAuthenticator,
    new InternalTokenAuthenticator(config.internalApiToken),
  ]);

  return {
    services: {
      config,
      clock,
      ids,
      db,
      queue,
      objects,
      auth: authenticator,
      observability: {
        sink,
        loggerFactory,
        metrics,
      },
    },
    modules: { users, auth, agencies },
  };
}

export async function buildAppServices(config: AppConfig, options: AppOptions = {}): Promise<AppServices> {
  return buildCore(config, options).services;
}

/**
 * Idempotent platform-administrator bootstrap. Runs only when explicitly
 * configured (both-or-neither enforced by config validation). If the email
 * is already registered, nothing changes — bootstrap never resets passwords.
 */
async function ensureBootstrapAdministrator(
  config: AppConfig,
  modules: ApplicationModules,
  logger: Logger,
): Promise<void> {
  if (config.bootstrapAdminEmail === '') return;

  const existing = await modules.users.getUserByEmail(config.bootstrapAdminEmail);
  if (existing !== null) {
    logger.info('identity.bootstrap.skipped', undefined, {
      email: config.bootstrapAdminEmail,
      reason: 'user already exists',
    });
    return;
  }

  const user = await modules.users.createUser({
    email: config.bootstrapAdminEmail,
    displayName: 'Platform Administrator',
  });
  await modules.users.grantPlatformRole({ userId: user.userId, role: 'platform_administrator' });
  await modules.auth.issueCredential({
    userId: user.userId,
    password: config.bootstrapAdminPassword,
  });
  logger.info('identity.bootstrap.created', undefined, { email: user.email });
}

/** Loads config from the environment and builds wired services. */
export async function bootstrapApp(options: AppOptions = {}): Promise<AppServices> {
  const config = loadConfig(process.env);
  const services = await buildAppServices(config, options);
  await runMigrations(services.db);
  return services;
}

/**
 * Full application bootstrap for the API process: services + identity
 * modules + migrations + (optionally) the bootstrap platform administrator.
 */
export async function bootstrapApplication(
  options: AppOptions = {},
): Promise<{ services: AppServices; modules: ApplicationModules }> {
  const config = loadConfig(process.env);
  const core = buildCore(config, options);
  await runMigrations(core.services.db);
  const logger = core.services.observability.loggerFactory.forModule('identity.bootstrap');
  await ensureBootstrapAdministrator(config, core.modules, logger);
  return core;
}

export { loadConfig };
