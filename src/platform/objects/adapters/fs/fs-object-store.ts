/**
 * Filesystem object store adapter: content-addressed immutable objects under a
 * configured root. Layout: <root>/<first-2-hex>/<digest> plus a sidecar
 * <root>/<first-2-hex>/<digest>.meta.json. Identical content converges to the
 * same path; stored bytes are never rewritten.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectStore, PutOptions, RetrievedObject, StoredObject } from '../../contract.ts';
import { digestOf } from '../../digest.ts';

export class FsObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async put(bytes: Uint8Array, options?: PutOptions): Promise<StoredObject> {
    const digest = digestOf(bytes);
    const shard = digest.slice(0, 2);
    const dir = join(this.root, shard);
    await mkdir(dir, { recursive: true });

    const contentPath = join(dir, digest);
    const metaPath = `${contentPath}.meta.json`;

    const meta: StoredObject = {
      key: digest,
      digest,
      size: bytes.byteLength,
      contentType: options?.contentType ?? 'application/octet-stream',
      createdAt: new Date().toISOString(),
    };

    try {
      const existingMeta = JSON.parse(await readFile(metaPath, 'utf8')) as StoredObject;
      // Content-addressed key already present — idempotent put.
      return existingMeta;
    } catch {
      // Not present yet: write content first, then metadata (content is the
      // source of truth; a torn meta file is recreated on next put).
    }

    await writeFile(contentPath, bytes, { flag: 'wx' }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    });
    await writeFile(metaPath, `${JSON.stringify(meta)}\n`, { flag: 'wx' }).catch(
      async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw error;
      },
    );
    return meta;
  }

  async get(key: string): Promise<RetrievedObject | null> {
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    const contentPath = join(this.root, key.slice(0, 2), key);
    try {
      const bytes = new Uint8Array(await readFile(contentPath));
      let meta: StoredObject;
      try {
        meta = JSON.parse(await readFile(`${contentPath}.meta.json`, 'utf8')) as StoredObject;
      } catch {
        meta = {
          key,
          digest: key,
          size: bytes.byteLength,
          contentType: 'application/octet-stream',
          createdAt: new Date(0).toISOString(),
        };
      }
      return { ...meta, bytes };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(key)) return false;
    try {
      await readFile(join(this.root, key.slice(0, 2), key));
      return true;
    } catch {
      return false;
    }
  }
}
