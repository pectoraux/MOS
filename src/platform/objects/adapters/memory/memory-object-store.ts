/**
 * In-memory object store adapter. Development/testing implementation of the
 * ObjectStore port; content-addressed exactly like the fs adapter.
 */

import type { ObjectStore, PutOptions, RetrievedObject, StoredObject } from '../../contract.ts';
import { digestOf } from '../../digest.ts';

export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; meta: StoredObject }>();

  async put(bytes: Uint8Array, options?: PutOptions): Promise<StoredObject> {
    const digest = digestOf(bytes);
    const existing = this.objects.get(digest);
    if (existing !== undefined) {
      return existing.meta;
    }
    const meta: StoredObject = {
      key: digest,
      digest,
      size: bytes.byteLength,
      contentType: options?.contentType ?? 'application/octet-stream',
      createdAt: new Date().toISOString(),
    };
    this.objects.set(digest, { bytes: new Uint8Array(bytes), meta });
    return meta;
  }

  async get(key: string): Promise<RetrievedObject | null> {
    const entry = this.objects.get(key);
    if (entry === undefined) return null;
    return { ...entry.meta, bytes: new Uint8Array(entry.bytes) };
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}
