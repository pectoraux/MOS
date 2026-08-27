/**
 * Composition root (spec/module-dependency-matrix.md: "Provider SDKs,
 * concrete queue/storage clients, sandbox drivers, browser drivers and
 * external integration adapters are wired at the composition root").
 *
 * This is the ONLY place in src/ where concrete adapters are imported.
 * API routes, workers and domain modules depend on the contracts in
 * src/platform/<concern>/contract.ts exclusively — enforced by the static
 * architecture checker (tools/arch-check).
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
import type { AppServices } from './platform/app-services.ts';
import type { ObservabilitySink } from './platform/observability/contract.ts';

export interface AppOptions {
  /** Additional observability sinks (e.g., test collectors). */
  readonly extraSinks?: ReadonlyArray<ObservabilitySink> | undefined;
  /** Override the primary sink (tests capture records without console noise). */
  readonly primarySink?: ObservabilitySink | undefined;
}

export async function buildAppServices(config: AppConfig, options: AppOptions = {}): Promise<AppServices> {
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

  const auth = new InternalTokenAuthenticator(config.internalApiToken);

  return {
    config,
    clock,
    ids,
    db,
    queue,
    objects,
    auth,
    observability: {
      sink,
      loggerFactory,
      metrics,
    },
  };
}

/** Loads config from the environment and builds wired services. */
export async function bootstrapApp(options: AppOptions = {}): Promise<AppServices> {
  const config = loadConfig(process.env);
  const services = await buildAppServices(config, options);
  await runMigrations(services.db);
  return services;
}

export { loadConfig };
