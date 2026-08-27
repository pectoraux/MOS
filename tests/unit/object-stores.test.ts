/**
 * Unit tests: object store adapters (memory + fs) and the digest helper.
 *
 * Both adapters must be content-addressed identically: put returns
 * key = digest = sha256 hex of the bytes with correct size; get returns the
 * identical bytes plus metadata; puts are idempotent per content; absent and
 * malformed keys return null/false.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryObjectStore } from '../../src/platform/objects/adapters/memory/memory-object-store.ts';
import { FsObjectStore } from '../../src/platform/objects/adapters/fs/fs-object-store.ts';
import { digestOf } from '../../src/platform/objects/digest.ts';
import type { ObjectStore } from '../../src/platform/objects/contract.ts';

const encoder = new TextEncoder();

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshFsStore(): FsObjectStore {
  const root = mkdtempSync(join(tmpdir(), 'mos-obj-'));
  tempRoots.push(root);
  return new FsObjectStore(root);
}

function registerStoreContract(label: string, makeStore: () => ObjectStore): void {
  test(`${label}: put returns key = digest = sha256 hex of the content with correct size`, async () => {
    const store = makeStore();
    const content = encoder.encode('hello marketingos');

    const stored = await store.put(content);

    assert.match(stored.key, /^[0-9a-f]{64}$/, 'key must be a sha256 hex digest');
    assert.equal(stored.key, digestOf(content));
    assert.equal(stored.digest, stored.key, 'key and digest are the same content address');
    assert.equal(stored.size, content.byteLength);
    assert.equal(stored.contentType, 'application/octet-stream', 'default content type');
    assert.ok(!Number.isNaN(Date.parse(stored.createdAt)), 'createdAt must be ISO 8601');
  });

  test(`${label}: put honors an explicit content type`, async () => {
    const store = makeStore();
    const stored = await store.put(encoder.encode('{"a":1}'), { contentType: 'application/json' });
    assert.equal(stored.contentType, 'application/json');

    const retrieved = await store.get(stored.key);
    assert.ok(retrieved !== null);
    assert.equal(retrieved.contentType, 'application/json');
  });

  test(`${label}: get returns the identical bytes and metadata`, async () => {
    const store = makeStore();
    const content = encoder.encode('goal artifact payload 🚀');
    const stored = await store.put(content);

    const retrieved = await store.get(stored.key);
    assert.ok(retrieved !== null, 'stored key must be retrievable');
    assert.deepEqual(Array.from(retrieved.bytes), Array.from(content), 'bytes must round-trip exactly');
    assert.equal(retrieved.key, stored.key);
    assert.equal(retrieved.digest, stored.digest);
    assert.equal(retrieved.size, stored.size);
    assert.equal(retrieved.contentType, stored.contentType);
    assert.equal(retrieved.createdAt, stored.createdAt);
  });

  test(`${label}: putting identical bytes twice returns the same key; different bytes diverge`, async () => {
    const store = makeStore();

    const first = await store.put(encoder.encode('same-content'));
    const again = await store.put(encoder.encode('same-content'));
    assert.equal(again.key, first.key, 'identical content converges to the same key');
    assert.equal(again.digest, first.digest);

    const other = await store.put(encoder.encode('different-content'));
    assert.notEqual(other.key, first.key, 'different content must address differently');
    assert.match(other.key, /^[0-9a-f]{64}$/);

    assert.ok((await store.get(first.key)) !== null);
    assert.ok((await store.get(other.key)) !== null);
  });

  test(`${label}: get of a nonexistent key returns null`, async () => {
    const store = makeStore();
    await store.put(encoder.encode('seed'));

    assert.equal(await store.get('does-not-exist'), null);
    // well-formed but absent digest
    assert.equal(await store.get('a'.repeat(64)), null);
  });

  test(`${label}: invalid key formats return null and never match`, async () => {
    const store = makeStore();

    for (const badKey of ['', 'XYZ', 'short', 'z'.repeat(64), '../etc/passwd', '/etc/passwd', 'a'.repeat(63)]) {
      assert.equal(await store.get(badKey), null, `get(${JSON.stringify(badKey)}) must return null`);
      assert.equal(await store.exists(badKey), false, `exists(${JSON.stringify(badKey)}) must return false`);
    }
  });

  test(`${label}: exists reports true only for stored keys`, async () => {
    const store = makeStore();
    const stored = await store.put(encoder.encode('exists-check'));

    assert.equal(await store.exists(stored.key), true);
    assert.equal(await store.exists('b'.repeat(64)), false);
    assert.equal(await store.exists('not-a-digest'), false);
  });
}

registerStoreContract('MemoryObjectStore', () => new MemoryObjectStore());
registerStoreContract('FsObjectStore', freshFsStore);

test('digestOf computes known sha256 values', () => {
  assert.equal(
    digestOf(encoder.encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    digestOf(new Uint8Array([])),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    digestOf(encoder.encode('hello marketingos')),
    '054272f9dfdf6742a6795c10c614cd0619f3e420741e2dff2a8de5b2b4b717fa',
  );
});

test('memory and fs adapters content-address identical bytes identically', async () => {
  const content = encoder.encode('cross-store consistency');
  const memoryKey = (await new MemoryObjectStore().put(content)).key;
  const fsKey = (await freshFsStore().put(content)).key;
  assert.equal(fsKey, memoryKey);
});
