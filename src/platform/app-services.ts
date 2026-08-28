/**
 * Application services contract.
 *
 * The set of platform-level services handed to API routes and job handlers
 * via dependency injection. Declared here (contracts only — no concrete
 * adapters) so that api/, workers/ and modules/ never import infrastructure
 * implementations directly. Concrete wiring happens exclusively in
 * src/composition-root.ts (spec/module-dependency-matrix.md "Composition root").
 *
 * MKT-005 additions (issue #13): `cache` and `locks` expose the ADVISORY
 * cache/lock capabilities (never authority — PostgreSQL remains the system
 * of record and durable queue authority); `secrets` is the resolution-only
 * secret backend behind the /credentials module's frozen boundary.
 */

import type { AppConfig } from './config/config.ts';
import type { Clock } from './clock/clock.ts';
import type { Db } from './db/contract.ts';
import type { HttpCallPort } from './http/outbound.ts';
import type { RequestAuthenticator } from './http/auth/contract.ts';
import type { IdGenerator } from './ids/ids.ts';
import type { JobQueue } from './queue/contract.ts';
import type { LoggerFactory, Metrics, ObservabilitySink } from './observability/contract.ts';
import type { ObjectStore } from './objects/contract.ts';
import type { CachePort } from './cache/contract.ts';
import type { LockPort } from './locking/contract.ts';
import type { SecretStore } from './secrets/contract.ts';

export interface AppServices {
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly db: Db;
  readonly queue: JobQueue;
  readonly objects: ObjectStore;
  /** Advisory cache (MKT-005) — correctness never depends on it. */
  readonly cache: CachePort;
  /** Advisory distributed locks (MKT-005) — fail-closed when unavailable. */
  readonly locks: LockPort;
  /** Resolution-only secret backend (MKT-005, CRED-001) — used by /credentials. */
  readonly secrets: SecretStore;
  /** Bounded provider-neutral outbound HTTP (MKT-011 pooled api.request runner). */
  readonly httpCalls: HttpCallPort;
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
