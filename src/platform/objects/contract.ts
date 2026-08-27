/**
 * Object storage abstraction (PLAT-001 / spec/implementation-contract.md §25).
 *
 * Large immutable artifacts live in object storage referenced durably from
 * PostgreSQL. This port is provider-neutral: the filesystem and in-memory
 * adapters satisfy it today; an S3-class adapter can be added later without
 * touching any consumer (wired at the composition root only).
 *
 * Keys are content addresses (SHA-256 digests): content is immutable by
 * construction and re-putting identical content converges to the same key.
 */

export interface StoredObject {
  /** Content-addressed key (sha256 hex digest). */
  readonly key: string;
  readonly digest: string;
  readonly size: number;
  readonly contentType: string;
  readonly createdAt: string;
}

export interface RetrievedObject extends StoredObject {
  readonly bytes: Uint8Array;
}

export interface PutOptions {
  readonly contentType?: string | undefined;
}

export interface ObjectStore {
  /**
   * Stores immutable content. Idempotent: identical content returns the same
   * key without duplicating storage.
   */
  put(bytes: Uint8Array, options?: PutOptions): Promise<StoredObject>;
  /** Reads an object by key; returns null when absent. */
  get(key: string): Promise<RetrievedObject | null>;
  /** Checks existence without reading content. */
  exists(key: string): Promise<boolean>;
}
