/**
 * Degenerate cache adapter (MKT-005) — the documented no-backend behavior.
 *
 * When no Redis backend is configured the composition root wires this
 * adapter: every read is a miss, writes and deletes are no-ops. This is the
 * CORRECT degenerate cache (a cache may be entirely absent without
 * affecting correctness — PostgreSQL is authoritative), and unlike a broken
 * backend it never needs to fabricate errors for ordinary callers.
 */

import type { CachePort } from '../../contract.ts';

export class NoCache implements CachePort {
  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string, _ttlMs: number): Promise<void> {
    /* no cache configured: writes are advisory and dropped */
  }

  async delete(_key: string): Promise<void> {
    /* no cache configured: nothing to invalidate */
  }
}
