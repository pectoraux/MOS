/**
 * Application services contract.
 *
 * The set of platform-level services handed to API routes and job handlers
 * via dependency injection. Declared here (contracts only — no concrete
 * adapters) so that api/, workers/ and modules/ never import infrastructure
 * implementations directly. Concrete wiring happens exclusively in
 * src/composition-root.ts (spec/module-dependency-matrix.md "Composition root").
 */

import type { AppConfig } from './config/config.ts';
import type { Clock } from './clock/clock.ts';
import type { Db } from './db/contract.ts';
import type { RequestAuthenticator } from './http/auth/contract.ts';
import type { IdGenerator } from './ids/ids.ts';
import type { JobQueue } from './queue/contract.ts';
import type { LoggerFactory, Metrics, ObservabilitySink } from './observability/contract.ts';
import type { ObjectStore } from './objects/contract.ts';

export interface AppServices {
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly db: Db;
  readonly queue: JobQueue;
  readonly objects: ObjectStore;
  readonly auth: RequestAuthenticator;
  readonly observability: {
    readonly sink: ObservabilitySink;
    readonly loggerFactory: LoggerFactory;
    readonly metrics: Metrics;
  };
}

/**
 * Material-mutation event emission (pipeline step 7). In MKT-001 this writes
 * a structured observability record; the append-only /audit authority that
 * persists audit events (AUD-001, MKT-005) will be wired here without
 * changing route definitions.
 */
export interface MaterialMutationEmitter {
  emit(event: string, data: Record<string, unknown>): void;
}
