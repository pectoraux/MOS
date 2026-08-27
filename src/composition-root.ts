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
 *
 * MKT-003 additions:
 *   - the /clients module is constructed here (dependency matrix:
 *     /clients ──→ /agencies, /auth) owning Client identity, Agency→Client
 *     ownership and canonical owner resolution.
 *
 * MKT-004 additions:
 *   - the /workspaces module is constructed here (dependency matrix:
 *     /workspaces ──→ /clients) owning Workspace identity, Client→Workspace
 *     ownership and canonical owner resolution THROUGH /clients.
 *
 * MKT-005 additions (issue #13 — extend existing authorities, never
 * duplicate them):
 *   - the object-store port gains the production S3-compatible adapter
 *     (SigV4 over fetch — no SDK) next to the existing memory/fs adapters;
 *     the MKT-001 ObjectStore contract is untouched;
 *   - the advisory cache/lock capabilities are wired: a real Redis adapter
 *     when MOS_REDIS_URL is configured, or the documented degenerate
 *     adapters otherwise (NoCache + fail-closed UnavailableLock). The
 *     durable queue authority REMAINS the PostgreSQL queue — Redis is never
 *     wired as a queue or workflow authority;
 *   - the secret backend (file-based SecretStore) is wired once and handed
 *     to the /credentials module — the only consumer of material;
 *   - the /credentials (CRED-001) and /audit (AUD-001) modules are
 *     constructed here with platform ports only.
 *
 * MKT-006 additions:
 *   - the /goals module is constructed here (dependency matrix:
 *     /goals ──→ /clients, /workspaces) owning Goal identity, measurable
 *     content, lifecycle and canonical owner resolution THROUGH /clients
 *     (and /workspaces for the optional scope).
 *
 * MKT-007 additions:
 *   - the /playbooks module is constructed here (dependency matrix:
 *     /playbooks ──→ /agencies, /clients, /goals) owning Playbook
 *     identity, the Agency-or-Client ownership relation, the optional
 *     Goal link, the versioned strategy artifact with its declarative
 *     deployment metadata and the frozen version lifecycle. NO
 *     workflow/deployment/execution engine is wired (architecture.md §8:
 *     Deployment references immutable Playbook Versions and does not
 *     mutate them — /deployments is a later Work Item).
 */

import fs from 'node:fs';
import { loadConfig, type AppConfig } from './platform/config/config.ts';
import { SystemClock } from './platform/clock/clock.ts';
import { CryptoIdGenerator } from './platform/ids/ids.ts';
import { PgDb } from './platform/db/adapters/postgres/pg-db.ts';
import { runMigrations } from './platform/db/migrate.ts';
import { PgQueue } from './platform/queue/adapters/postgres/pg-queue.ts';
import { MemoryObjectStore } from './platform/objects/adapters/memory/memory-object-store.ts';
import { FsObjectStore } from './platform/objects/adapters/fs/fs-object-store.ts';
import { S3ObjectStore } from './platform/objects/adapters/s3/s3-object-store.ts';
import { RedisCache } from './platform/cache/adapters/redis/redis-cache.ts';
import { NoCache } from './platform/cache/adapters/none/no-cache.ts';
import { RedisLock } from './platform/locking/adapters/redis/redis-lock.ts';
import { UnavailableLock } from './platform/locking/adapters/none/unavailable-lock.ts';
import { FileSecretStore } from './platform/secrets/adapters/file/file-secret-store.ts';
import { ConsoleSink } from './platform/observability/adapters/console/console-sink.ts';
import { CompositeSink } from './platform/observability/adapters/composite/composite-sink.ts';
import { createLoggerFactory } from './platform/observability/logger.ts';
import { InMemoryMetrics } from './platform/observability/metrics.ts';
import { InternalTokenAuthenticator } from './platform/http/auth/adapters/internal-token/internal-token-authenticator.ts';
import { CompositeAuthenticator } from './platform/http/auth/adapters/composite/composite-authenticator.ts';
import { ConfigError } from './platform/errors/errors.ts';
import type { AppServices } from './platform/app-services.ts';
import type { ObservabilitySink } from './platform/observability/contract.ts';
import type { Logger } from './platform/observability/contract.ts';
import type { CachePort } from './platform/cache/contract.ts';
import type { LockPort } from './platform/locking/contract.ts';
import { createUsersModule } from './modules/users/public.ts';
import { createAuthModule } from './modules/auth/public.ts';
import { createAgenciesModule } from './modules/agencies/public.ts';
import { createClientsModule } from './modules/clients/public.ts';
import { createWorkspacesModule } from './modules/workspaces/public.ts';
import { createCredentialsModule } from './modules/credentials/public.ts';
import { createAuditModule } from './modules/audit/public.ts';
import { createGoalsModule } from './modules/goals/public.ts';
import { createPlaybooksModule } from './modules/playbooks/public.ts';
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

  // Object store: the MKT-001 port, now with the production S3-compatible
  // adapter behind the SAME contract (wired here only — consumers unchanged).
  const objects =
    config.objectStore === 's3'
      ? new S3ObjectStore({
          endpoint: config.s3!.endpoint,
          region: config.s3!.region,
          bucket: config.s3!.bucket,
          accessKeyId: config.s3!.accessKeyId,
          secretAccessKey: config.s3!.secretAccessKey,
          pathStyle: config.s3!.pathStyle,
          requestTimeoutMs: config.s3!.requestTimeoutMs,
        })
      : config.objectStore === 'fs'
        ? new FsObjectStore(config.objectStoreDir)
        : new MemoryObjectStore();

  // Advisory cache/lock capabilities (MKT-005): a real Redis backend when
  // configured; otherwise the documented degenerate adapters. PostgreSQL
  // remains the authoritative system of record and durable queue authority
  // — Redis is wired ONLY for advisory cache and advisory locks.
  let cache: CachePort;
  let locks: LockPort;
  if (config.redis !== null) {
    const redis = config.redis;
    const shared = {
      host: redis.host,
      port: redis.port,
      username: redis.username === '' ? undefined : redis.username,
      password: redis.password === '' ? undefined : redis.password,
      secure: redis.secure,
      timeoutMs: config.redisTimeoutMs,
    };
    cache = new RedisCache({ ...shared, keyPrefix: 'mos:cache:' });
    locks = new RedisLock({ ...shared, keyPrefix: 'mos:lock:' });
  } else {
    cache = new NoCache();
    locks = new UnavailableLock();
  }

  // Secret backend: resolution-only file store (mounted-secret model).
  // Fail fast when the backend directory is absent: a half-configured
  // secret backend must abort startup, not silently fail at first resolve.
  if (!fs.existsSync(config.secretsDir) || !fs.statSync(config.secretsDir).isDirectory()) {
    throw new ConfigError('Secret backend directory does not exist', [
      `MOS_SECRETS_DIR=${config.secretsDir}: create the directory and mount secret files as <handle>.secret`,
    ]);
  }
  const secrets = new FileSecretStore({ dir: config.secretsDir });

  const primarySink = options.primarySink ?? new ConsoleSink();
  const sink =
    options.extraSinks === undefined || options.extraSinks.length === 0
      ? primarySink
      : new CompositeSink([primarySink, ...options.extraSinks]);

  const loggerFactory = createLoggerFactory({ sink, clock, minLevel: config.logLevel });
  const metrics = new InMemoryMetrics();

  // Module wiring (dependency matrix: /auth → /users; /agencies → /users;
  // /clients → /agencies, /auth; /workspaces → /clients; /credentials and
  // /audit import no other module — they take platform ports + plain data;
  // /goals → /clients, /workspaces; /playbooks → /agencies, /clients,
  // /goals).
  const users = createUsersModule({ db, clock, ids });
  const auth = createAuthModule({
    db,
    clock,
    ids,
    users,
    sessionTtlMs: config.authSessionTtlMs,
  });
  const agencies = createAgenciesModule({ db, clock, ids, users });
  const clients = createClientsModule({ db, clock, ids, agencies });
  const workspaces = createWorkspacesModule({ db, clock, ids, clients });
  const credentials = createCredentialsModule({ db, clock, ids, secrets });
  const audit = createAuditModule({ db, clock, ids });
  const goals = createGoalsModule({ db, clock, ids, clients, workspaces });
  const playbooks = createPlaybooksModule({ db, clock, ids, agencies, clients, goals });

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
      cache,
      locks,
      secrets,
      auth: authenticator,
      observability: {
        sink,
        loggerFactory,
        metrics,
      },
    },
    modules: { users, auth, agencies, clients, workspaces, credentials, audit, goals, playbooks },
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
