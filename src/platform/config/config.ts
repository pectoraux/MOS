/**
 * Explicit, validated configuration (platform runtime conventions).
 *
 * Every process (api, worker) starts from an explicit config object derived
 * from the environment. Configuration is validated once at startup and the
 * process fails fast on invalid values — no silent defaults for security-
 * relevant settings (the internal API token defaults to unset, which makes
 * authenticated routes fail closed).
 *
 * MKT-002 additions: user-session TTL and the optional (both-or-neither)
 * bootstrap platform administrator. The bootstrap credential is start-time
 * configuration only — it is never persisted as raw material; only the
 * scrypt verifier lands in the auth-owned credential store.
 */

import { ConfigError } from '../errors/errors.ts';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';
export type EnvironmentName = 'dev' | 'test' | 'prod';
export type ObjectStoreKind = 'memory' | 'fs';

export interface AppConfig {
  /** Environment label. */
  readonly env: EnvironmentName;
  /** PostgreSQL connection string (system of record). */
  readonly databaseUrl: string;
  /** HTTP listener host. */
  readonly httpHost: string;
  /** HTTP listener port. */
  readonly httpPort: number;
  /** Maximum accepted request body size in bytes. */
  readonly httpMaxBodyBytes: number;
  /** Minimum structured log level. */
  readonly logLevel: LogLevelName;
  /** Object store abstraction implementation kind. */
  readonly objectStore: ObjectStoreKind;
  /** Filesystem root for the fs object store. */
  readonly objectStoreDir: string;
  /** Bearer token for the platform HTTP authenticator; empty = fail closed. */
  readonly internalApiToken: string;
  /** User session lifetime in milliseconds (MKT-002 /auth sessions). */
  readonly authSessionTtlMs: number;
  /** Bootstrap platform administrator email; empty = no bootstrap. */
  readonly bootstrapAdminEmail: string;
  /** Bootstrap platform administrator initial password; empty = no bootstrap. */
  readonly bootstrapAdminPassword: string;
  /** Worker identity label; empty = generated at startup. */
  readonly workerId: string;
  /** Worker poll interval in milliseconds. */
  readonly workerPollIntervalMs: number;
  /** Maximum jobs claimed per poll batch. */
  readonly workerBatchSize: number;
  /** Default maximum attempts per job. */
  readonly jobMaxAttempts: number;
  /** Base delay for exponential retry backoff. */
  readonly jobRetryBackoffBaseMs: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];

  const envName = readEnum(env, 'MOS_ENV', ['dev', 'test', 'prod'], 'dev', problems);
  const logLevel = readEnum(env, 'MOS_LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info', problems);

  const databaseUrl = env['MOS_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    problems.push('MOS_DATABASE_URL is required (PostgreSQL is the system of record)');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('MOS_DATABASE_URL must be a postgres:// or postgresql:// URL');
  }

  const httpHost = env['MOS_HTTP_HOST'] ?? '127.0.0.1';
  // Port 0 is allowed: listen on an ephemeral port (used by tests and
  // sidecar processes that report their actual port in api.startup logs).
  const httpPort = readInt(env, 'MOS_HTTP_PORT', 8080, 0, 65535, problems);
  const httpMaxBodyBytes = readInt(env, 'MOS_HTTP_MAX_BODY_BYTES', 1_048_576, 1, 67_108_864, problems);

  const objectStore = readEnum(env, 'MOS_OBJECT_STORE', ['memory', 'fs'], 'memory', problems);
  const objectStoreDir = env['MOS_OBJECT_STORE_DIR'] ?? './var/objects';

  const internalApiToken = env['MOS_INTERNAL_API_TOKEN'] ?? '';

  const authSessionTtlMs = readInt(env, 'MOS_AUTH_SESSION_TTL_MS', 12 * 60 * 60 * 1000, 60_000, 2_592_000_000, problems);

  const bootstrapAdminEmail = (env['MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL'] ?? '').trim().toLowerCase();
  const bootstrapAdminPassword = env['MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD'] ?? '';
  if ((bootstrapAdminEmail === '') !== (bootstrapAdminPassword === '')) {
    problems.push(
      'MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL and MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be set together (both or neither)',
    );
  } else if (bootstrapAdminPassword !== '' && bootstrapAdminPassword.length < 12) {
    problems.push('MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be at least 12 characters when set');
  }

  const workerId = env['MOS_WORKER_ID'] ?? '';
  const workerPollIntervalMs = readInt(env, 'MOS_WORKER_POLL_INTERVAL_MS', 500, 1, 60_000, problems);
  const workerBatchSize = readInt(env, 'MOS_WORKER_BATCH_SIZE', 5, 1, 100, problems);
  const jobMaxAttempts = readInt(env, 'MOS_JOB_MAX_ATTEMPTS', 5, 1, 100, problems);
  const jobRetryBackoffBaseMs = readInt(env, 'MOS_JOB_RETRY_BACKOFF_BASE_MS', 1_000, 1, 3_600_000, problems);

  if (problems.length > 0) {
    throw new ConfigError('Invalid platform configuration', problems);
  }

  return {
    env: envName,
    databaseUrl: databaseUrl!,
    httpHost,
    httpPort,
    httpMaxBodyBytes,
    logLevel,
    objectStore,
    objectStoreDir,
    internalApiToken,
    authSessionTtlMs,
    bootstrapAdminEmail,
    bootstrapAdminPassword,
    workerId,
    workerPollIntervalMs,
    workerBatchSize,
    jobMaxAttempts,
    jobRetryBackoffBaseMs,
  };
}

function readEnum<T extends string>(
  env: Env,
  name: string,
  allowed: ReadonlyArray<T>,
  fallback: T,
  problems: string[],
): T {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  for (const candidate of allowed) {
    if (raw === candidate) return candidate;
  }
  problems.push(`${name} must be one of: ${allowed.join(', ')}`);
  return fallback;
}

function readInt(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || `${parsed}` !== raw.trim() || parsed < min || parsed > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return parsed;
}
