/**
 * Integration-test MinIO harness (MKT-005).
 *
 * Boots a REAL S3-compatible object-storage server (MinIO: the standard
 * self-hosted S3 implementation) so the production S3ObjectStore adapter is
 * proven against a genuine SigV4-validating S3 endpoint — not a mock.
 *
 * Provisioning follows the ICU-60 pattern (tests/integration/helpers/pg.ts):
 *   - MOS_TEST_MINIO may point at a pre-provisioned minio binary;
 *   - otherwise the harness downloads the PINNED MinIO release binary
 *     (SHA-256 verified) ONCE into .test-deps/ and caches it;
 *   - when the download is impossible the harness FAILS LOUDLY — per the
 *     no-false-green rule a missing integration dependency must never be
 *     reported as a pass.
 */

import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort } from './pg.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const testDepsDir = path.join(repoRoot, '.test-deps');

/** Pinned MinIO release (deterministic S3 protocol behavior in CI). */
const MINIO_VERSION = 'RELEASE.2025-09-07T16-13-09Z';
const MINIO_URL = `https://dl.min.io/server/minio/release/linux-amd64/archive/minio.${MINIO_VERSION}`;
const MINIO_SHA256 = '7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f';

const minioDir = path.join(testDepsDir, `minio-${MINIO_VERSION}`);
const cachedBinary = path.join(minioDir, 'minio');

export interface MinioCredentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface MinioServerHandle {
  readonly port: number;
  readonly endpoint: string;
  readonly credentials: MinioCredentials;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  stop(): Promise<void>;
}

/** Returns the path to a real minio binary, provisioning it if needed. */
export function ensureMinio(): string {
  const override = process.env['MOS_TEST_MINIO'];
  if (override !== undefined && override !== '') {
    if (!fs.existsSync(override)) {
      throw new Error(`MOS_TEST_MINIO=${override} does not exist`);
    }
    return override;
  }
  if (fs.existsSync(cachedBinary)) return cachedBinary;

  fs.mkdirSync(testDepsDir, { recursive: true });
  process.stderr.write(`[minio-harness] downloading minio ${MINIO_VERSION} (pinned release)\n`);

  const binary = path.join(minioDir, 'minio');
  const stagingDir = path.join(testDepsDir, `minio-staging-${process.pid}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  const staged = path.join(stagingDir, 'minio');

  try {
    downloadFile(MINIO_URL, staged);
    const digest = sha256OfFile(staged);
    if (digest !== MINIO_SHA256) {
      throw new Error(`minio download integrity mismatch: sha256 ${digest} != ${MINIO_SHA256}`);
    }
    fs.chmodSync(staged, 0o755);
    try {
      fs.renameSync(stagingDir, minioDir);
    } catch {
      // Another concurrent process installed it first — use theirs.
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(
      `Failed to provision minio for integration tests: ${String(error)}. ` +
        'Fix the environment (network) or set MOS_TEST_MINIO — a missing integration ' +
        'dependency must never be reported as a pass (no-false-green rule).',
    );
  }

  if (!fs.existsSync(binary)) {
    throw new Error('minio provisioning failed: binary not present after install');
  }
  return binary;
}

/**
 * Boots an isolated MinIO server on a free ephemeral port with fresh
 * credentials and data dir. Resolves once /minio/health/live answers 200.
 */
export async function startMinio(): Promise<MinioServerHandle> {
  const binary = ensureMinio();
  const port = await findFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-minio-data-'));
  const credentials: MinioCredentials = {
    accessKey: 'mos-test-access-key',
    secretKey: 'mos-test-secret-key-0123456789',
  };

  const child = spawn(
    binary,
    ['server', dataDir, '--address', `127.0.0.1:${port}`, '--console-address', '127.0.0.1:0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MINIO_ROOT_USER: credentials.accessKey,
        MINIO_ROOT_PASSWORD: credentials.secretKey,
      },
    },
  );
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[minio stderr] ${chunk.toString('utf8')}`);
  });

  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await waitForMinioHealthy(endpoint, 60_000);
  } catch (error) {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    endpoint,
    credentials,
    child,
    stop: async () => {
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          setTimeout(resolve, 200);
        }, 3_000).unref();
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function waitForMinioHealthy(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(2_000) })
        .then((response) => {
          if (response.status === 200) {
            resolve();
          } else if (Date.now() > deadline) {
            reject(new Error(`minio health check returned ${response.status}`));
          } else {
            setTimeout(attempt, 200);
          }
        })
        .catch(() => {
          if (Date.now() > deadline) {
            reject(new Error('minio did not become healthy in time'));
          } else {
            setTimeout(attempt, 200);
          }
        });
    };
    attempt();
  });
}

const downloader = "const fs=require('fs');const https=require('https');const file=fs.createWriteStream(TARGET);const get=u=>https.get(u,r=>{if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){r.resume();get(r.headers.location);return}if(r.statusCode!==200){process.exit(3)}r.pipe(file);file.on('finish',()=>{file.close(()=>process.exit(0))})}).on('error',()=>process.exit(4));get(URL);";

function downloadFile(url: string, targetPath: string): void {
  const script = downloader
    .replace('TARGET', JSON.stringify(targetPath))
    .replace('URL', JSON.stringify(url));
  execFileSync(process.execPath, ['-e', script], { stdio: 'inherit', timeout: 600_000 });
  if (!fs.existsSync(targetPath)) {
    throw new Error(`download failed: ${url}`);
  }
}

function sha256OfFile(filePath: string): string {
  return execFileSync('sha256sum', [filePath], { encoding: 'utf8' }).split(/\s+/)[0] ?? '';
}

/**
 * Creates a bucket on the MinIO server using the PRODUCTION SigV4 signer
 * (src/platform/objects/sigv4.ts) — the same request-signing path the S3
 * adapter itself uses. This doubles as an independent proof that the
 * signer produces AWS-SigV4-valid requests (MinIO validates signatures
 * server-side and rejects anything else with 403).
 */
export async function createBucket(handle: MinioServerHandle, bucket: string): Promise<void> {
  const { signSigV4 } = await import('../../../src/platform/objects/sigv4.ts');
  const host = `127.0.0.1:${handle.port}`;
  const signed = signSigV4(
    {
      method: 'PUT',
      path: `/${encodeURIComponent(bucket)}`,
      queryString: '',
      headers: { host },
      payloadHash: sha256HexOfEmpty(),
    },
    {
      accessKeyId: handle.credentials.accessKey,
      secretAccessKey: handle.credentials.secretKey,
      region: 'us-east-1',
      service: 's3',
    },
  );
  const response = await fetch(`${handle.endpoint}/${encodeURIComponent(bucket)}`, {
    method: 'PUT',
    headers: { ...signed.signedHeaders, authorization: signed.authorizationHeader },
    signal: AbortSignal.timeout(10_000),
  });
  // 200 = created; 409 (BucketAlreadyOwnedByYou) = already there — both fine.
  if (response.status !== 200 && response.status !== 409) {
    const body = await response.text().catch(() => '');
    throw new Error(`createBucket failed: ${response.status} ${body.slice(0, 200)}`);
  }
  await response.body?.cancel().catch(() => undefined);
}

function sha256HexOfEmpty(): string {
  return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}
