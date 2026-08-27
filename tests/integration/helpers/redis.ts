/**
 * Integration-test Redis harness (MKT-005).
 *
 * Boots a REAL Redis server (advisory cache/lock backend) so the
 * cache/lock adapter tests run against the actual RESP protocol
 * implementation — not a mock or emulation.
 *
 * Provisioning follows the ICU-60 pattern (tests/integration/helpers/pg.ts):
 *   - MOS_TEST_REDIS_SERVER may point at a pre-provisioned redis-server
 *     binary (deterministic override for prepared environments);
 *   - otherwise the harness downloads the PINNED Redis source tarball
 *     (SHA-256 verified), compiles redis-server ONCE into .test-deps/ and
 *     caches it for every later run (concurrent-safe via atomic rename);
 *   - when neither download nor compilation is possible the harness FAILS
 *     LOUDLY — per the no-false-green rule a missing integration dependency
 *     must never be reported as a pass.
 */

import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort } from './pg.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const testDepsDir = path.join(repoRoot, '.test-deps');

/** Pinned Redis source release (deterministic protocol behavior in CI). */
const REDIS_VERSION = '7.2.12';
const REDIS_TARBALL_URL = `https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz`;
const REDIS_TARBALL_SHA256 = '97c60478a7c777ac914ca9d87a7e88ba265926456107e758c62d8f971d0196bc';

const redisBuildDir = path.join(testDepsDir, `redis-${REDIS_VERSION}`);
const cachedServer = path.join(redisBuildDir, `redis-${REDIS_VERSION}`, 'src', 'redis-server');

/** Returns the path to a real redis-server binary, provisioning it if needed. */
export function ensureRedisServer(): string {
  const override = process.env['MOS_TEST_REDIS_SERVER'];
  if (override !== undefined && override !== '') {
    if (!fs.existsSync(override)) {
      throw new Error(`MOS_TEST_REDIS_SERVER=${override} does not exist`);
    }
    return override;
  }
  if (fs.existsSync(cachedServer)) return cachedServer;

  fs.mkdirSync(testDepsDir, { recursive: true });
  process.stderr.write(`[redis-harness] building redis-server ${REDIS_VERSION} from pinned source\n`);

  // Download + verify into a process-private file, publish atomically.
  const tarball = path.join(testDepsDir, `redis-${REDIS_VERSION}.tar.gz`);
  if (!fs.existsSync(tarball) || sha256OfFile(tarball) !== REDIS_TARBALL_SHA256) {
    const privateTarball = `${tarball}.part-${process.pid}`;
    downloadFile(REDIS_TARBALL_URL, privateTarball);
    const digest = sha256OfFile(privateTarball);
    if (digest !== REDIS_TARBALL_SHA256) {
      fs.rmSync(privateTarball, { force: true });
      throw new Error(`redis source integrity mismatch: sha256 ${digest} != ${REDIS_TARBALL_SHA256}`);
    }
    try {
      fs.renameSync(privateTarball, tarball);
    } catch {
      // another concurrent process published first — the verified tarball exists
    }
  }

  // Extract + compile into a process-unique staging dir, install atomically.
  const staging = path.join(testDepsDir, `redis-staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'inherit' });
    const sourceDir = path.join(staging, `redis-${REDIS_VERSION}`);
    execFileSync('make', ['-j', String(os.cpus().length), 'redis-server'], {
      cwd: sourceDir,
      stdio: 'inherit',
      timeout: 600_000,
    });
    if (!fs.existsSync(path.join(sourceDir, 'src', 'redis-server'))) {
      throw new Error('redis compiled but src/redis-server missing');
    }
    try {
      fs.renameSync(staging, redisBuildDir);
    } catch {
      // Another concurrent process installed it first — use theirs.
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `Failed to provision redis-server for integration tests: ${String(error)}. ` +
        'Fix the environment (gcc/make + network) or set MOS_TEST_REDIS_SERVER — ' +
        'a missing integration dependency must never be reported as a pass (no-false-green rule).',
    );
  }

  if (!fs.existsSync(cachedServer)) {
    throw new Error('redis-server provisioning failed: binary not present after install');
  }
  return cachedServer;
}

export interface RedisServerHandle {
  readonly port: number;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** Kills the server (used by outage tests + teardown). */
  stop(): Promise<void>;
}

/**
 * Boots an isolated redis-server on a free ephemeral port (no persistence:
 * pure in-memory advisory cache/lock semantics). Resolves once the server
 * answers PING with PONG over a raw socket (independent of the adapter
 * under test).
 */
export async function startRedisServer(): Promise<RedisServerHandle> {
  const serverPath = ensureRedisServer();
  const port = await findFreePort();
  const child = spawn(
    serverPath,
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--daemonize', 'no'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[redis-server stderr] ${chunk.toString('utf8')}`);
  });

  try {
    await waitForRedisReady(port, 30_000);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  return {
    port,
    child,
    stop: async () => {
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          setTimeout(resolve, 200);
        }, 2_000).unref();
      });
    },
  };
}

/** Raw-socket PING/PONG probe — independent of the adapter under test. */
function waitForRedisReady(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = (): void => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const fail = (error: Error): void => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`redis-server did not become ready on port ${port}: ${error.message}`));
        } else {
          setTimeout(attempt, 150);
        }
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.once('data', (chunk: Buffer) => {
          const ok = chunk.toString('utf8').startsWith('+PONG');
          socket.destroy();
          if (ok) resolve();
          else if (Date.now() > deadline) {
            reject(new Error(`redis-server answered unexpectedly: ${chunk.toString('utf8')}`));
          } else {
            setTimeout(attempt, 150);
          }
        });
        socket.write('*1\r\n$4\r\nPING\r\n');
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
