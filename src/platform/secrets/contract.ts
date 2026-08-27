/**
 * Secret-store abstraction — the infrastructure half of the frozen credential
 * boundary (CRED-001 / spec/implementation-contract.md §21).
 *
 * The /credentials module (MKT-005) owns durable *credential references* in
 * PostgreSQL: opaque identifiers, scope and lifecycle — never secret
 * material. THIS port is the only sanctioned way to turn an opaque backend
 * handle into material, inside an authorized server-side execution context.
 *
 * Contract rules (issue #13 MKT-005-AC-05):
 *   - the surface is RESOLUTION-ONLY: `resolve` and `exists`. There is
 *     deliberately no `put`/`delete` — secret provisioning is a deployment
 *     concern (mounted secret files, vault policies), never an application
 *     API, so no public mutation path can write material;
 *   - implementations MUST fail closed: an unavailable backend, a missing
 *     handle or an unreadable secret raises SecretResolutionError — it never
 *     returns empty/partial material and never falls back to a default;
 *   - handles are opaque ASCII labels; implementations MUST reject handle
 *     forms that could traverse out of the backend namespace (path
 *     traversal, absolute paths, …);
 *   - material is returned as raw bytes and MUST never be persisted to
 *     domain tables, logs, audit records or durable queue payloads
 *     (spec/implementation-contract.md §21 — enforced by integration tests).
 *
 * Any concrete secret backend is implementation-defined behind this port and
 * wired only at the composition root.
 */

export interface SecretStore {
  /**
   * Resolves secret material for an opaque backend handle.
   * Throws SecretResolutionError (fail-closed) when the backend is
   * unavailable, the handle is unknown, or the material cannot be read.
   */
  resolve(handle: string): Promise<Uint8Array>;
  /**
   * True when the backend can resolve `handle` (used to fail reference
   * creation closed when the handle does not exist). Also fail-closed:
   * backend unavailability raises SecretResolutionError rather than `false`.
   */
  exists(handle: string): Promise<boolean>;
}
