/**
 * Cache port — advisory cache capability behind the platform boundary
 * (MKT-005, issue #13 MKT-005-AC-03; frozen topology spec/architecture.md §21
 * lists Redis for "queues / locks / cache" — while the durable QUEUE
 * authority stays PostgreSQL, the cache capability is exactly this seam).
 *
 * Contract rules:
 *   - a cache is ADVISORY ONLY: PostgreSQL is the authoritative system of
 *     record; every consumer MUST be correct with the cache fully absent
 *     (misses, evictions and outages never change durable state decisions);
 *   - failures surface EXPLICITLY as BackendUnavailableError — the port
 *     never fabricates values, never treats a backend outage as a hit, and
 *     never silently swallows errors; callers decide how to degrade;
 *   - `get` returning null means "not cached" (a miss) — it is never proof
 *     of anything about authoritative state;
 *   - no read-back/query API for business state exists here: this port
 *     cannot become an authority (OBS-AC-02 posture applied to
 *     infrastructure capabilities).
 *
 * Concrete backends live under adapters/ and are wired only at the
 * composition root. With no backend configured, the composition root wires
 * the documented degenerate NoCache adapter (always-miss/no-op) — correct,
 * because a cache may be entirely absent.
 */

export interface CachePort {
  /** Cached value or null on miss. Throws BackendUnavailableError on backend failure. */
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key` for at most `ttlMs`. Throws on backend failure. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Removes `key` (absent key is a no-op). Throws on backend failure. */
  delete(key: string): Promise<void>;
}

/** Cache keys are namespaced ASCII labels (`platform.<concern>.<name>` style). */
export const CACHE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,200}$/;
