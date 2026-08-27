/**
 * MKT-005 unit tests — file-backed secret store (CRED-001 infrastructure):
 * resolution, existence probing, fail-closed behavior and traversal safety.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileSecretStore,
  SECRET_HANDLE_PATTERN,
} from '../../src/platform/secrets/adapters/file/file-secret-store.ts';
import { SecretResolutionError } from '../../src/platform/errors/errors.ts';

let dir: string;
let store: FileSecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-secrets-unit-'));
  store = new FileSecretStore({ dir });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function mountSecret(handle: string, material: string): void {
  fs.writeFileSync(path.join(dir, `${handle}.secret`), material, { mode: 0o600 });
}

test('resolves mounted secret material by opaque handle', async () => {
  mountSecret('provider-api-key', 'super-secret-material-123');
  const material = await store.resolve('provider-api-key');
  assert.deepEqual(new TextDecoder().decode(material), 'super-secret-material-123');
});

test('exists() distinguishes present vs absent handles', async () => {
  mountSecret('present', 'x');
  assert.equal(await store.exists('present'), true);
  assert.equal(await store.exists('absent'), false);
});

test('missing handle fails closed with a NON-retryable SecretResolutionError', async () => {
  await assert.rejects(store.resolve('never-mounted'), (error: unknown) => {
    assert.ok(error instanceof SecretResolutionError);
    assert.equal(error.retryable, false);
    return true;
  });
});

test('unreadable secret fails closed (no partial material, no fallback)', async () => {
  mountSecret('locked', 'material');
  fs.chmodSync(path.join(dir, 'locked.secret'), 0o000);
  try {
    await assert.rejects(store.resolve('locked'), (error: unknown) => {
      assert.ok(error instanceof SecretResolutionError);
      return true;
    });
  } finally {
    fs.chmodSync(path.join(dir, 'locked.secret'), 0o644);
  }
});

test('handles that could escape the backend namespace are rejected before any I/O', async () => {
  // Path traversal, absolute paths, extensions and separators are all
  // rejected by the opaque-label pattern — no file is ever touched.
  const hostile = ['../etc/passwd', '/etc/passwd', 'a/b', 'a..b', '.hidden', 'UPPER', 'a b', ''];
  for (const handle of hostile) {
    await assert.rejects(store.resolve(handle), (error: unknown) => {
      assert.ok(error instanceof SecretResolutionError);
      return true;
    }, `handle '${handle}' must be rejected`);
    await assert.rejects(store.exists(handle), (error: unknown) => {
      assert.ok(error instanceof SecretResolutionError);
      return true;
    }, `exists('${handle}') must be rejected`);
  }
  // A hostile handle must never have READ a file: no traversal happened.
  assert.equal(fs.existsSync(path.join(dir, 'passwd.secret')), false);
});

test('SECRET_HANDLE_PATTERN admits exactly the opaque label grammar', () => {
  for (const valid of ['a', 'provider-api-key', '0192-abc', 'a'.repeat(99)]) {
    assert.ok(SECRET_HANDLE_PATTERN.test(valid), `${valid} should be valid`);
  }
  for (const invalid of ['', 'A', 'a_b', 'a/b', 'a.b', '-leading', 'trailing-', 'a b', 'a'.repeat(100)]) {
    assert.ok(!SECRET_HANDLE_PATTERN.test(invalid), `${invalid} should be invalid`);
  }
});

test('material bytes are returned verbatim (binary-safe)', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 0, 10, 13]);
  fs.writeFileSync(path.join(dir, 'binary.secret'), bytes);
  const material = await store.resolve('binary');
  assert.deepEqual(Array.from(material), Array.from(bytes));
});
