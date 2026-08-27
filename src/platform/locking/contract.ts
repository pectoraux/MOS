/**
 * Distributed locking port — advisory mutual exclusion behind the platform
 * boundary (MKT-005, issue #13 MKT-005-AC-03; frozen topology
 * spec/architecture.md §21 "Redis … locks").
 *
 * Contract rules:
 *   - locks are ADVISORY coordination for work distribution (e.g. avoiding
 *     duplicate background effort); durable correctness NEVER depends on
 *     them — PostgreSQL fences (unique constraints, CAS, FOR UPDATE) remain
 *     the authority for exactly-once semantics. A lost/expired lease can
 *     cause duplicate EFFORT, never duplicate COMMITTED state;
 *   - FAIL-CLOSED: when the lock backend is unavailable, `acquire` throws
 *     BackendUnavailableError — it NEVER silently grants a lease, because an
 *     unguarded "exclusive" section would be a false safety claim;
 *   - leases carry a TTL: mutual exclusion is guaranteed only until TTL
 *     expiry; callers whose work can exceed the TTL must treat the section
 *     as unguarded after expiry (and rely on DB fences for correctness);
 *   - `release` is owner-checked compare-and-delete: only the lease token
 *     holder can release, so a slow holder cannot release a lease already
 *     re-granted to someone else;
 *   - no business state is readable through this port — it cannot become an
 *     authority of any kind.
 *
 * Concrete backends live under adapters/ and are wired only at the
 * composition root. With no backend configured, the composition root wires
 * the documented degenerate UnavailableLock adapter (acquire always throws
 * — fail-closed) because a lock is not a capability that can be safely
 * faked, unlike a cache.
 */

export interface LockPort {
  /**
   * Tries to acquire `key` for `ttlMs`. Returns an opaque lease token on
   * success, or null when the lease is currently held. THROWS
   * BackendUnavailableError when the backend is unavailable (fail-closed).
   */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /**
   * Releases the lease iff `token` still owns it (compare-and-delete).
   * Returns true when the lease was released; false when it was not held
   * or already re-granted/expired. Throws on backend failure.
   */
  release(key: string, token: string): Promise<boolean>;
}

/** Lock keys are namespaced ASCII labels (`platform.<concern>.<name>` style). */
export const LOCK_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,200}$/;
