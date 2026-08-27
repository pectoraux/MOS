/**
 * Integration-test harness: real PostgreSQL, real subprocesses.
 *
 * The API server and the background worker run as SEPARATE OS PROCESSES
 * (exactly like production topology) — proving the asynchronous work
 * boundary (PLAT-AC-02) and correlation propagation across it (OBS-AC-01)
 * through real durable state (PostgreSQL) and real material logging records
 * (JSON lines on subprocess stdout), not in-memory fakes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObservabilityRecord } from '../../../src/platform/observability/contract.ts';
import { runMigrations } from '../../../src/platform/db/migrate.ts';
import { PgDb } from '../../../src/platform/db/adapters/postgres/pg-db.ts';
import type { EmbeddedPgHandle } from './pg.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface TestStackEnv {
  readonly databaseUrl: string;
  readonly internalApiToken: string;
  readonly objectStoreDir: string;
}

export interface SpawnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: () => string[];
  readonly logRecords: () => ObservabilityRecord[];
  readonly exitCode: () => Promise<number | null>;
}

export async function migrate(databaseUrl: string): Promise<void> {
  const db = new PgDb(databaseUrl, 2);
  try {
    await runMigrations(db);
  } finally {
    await db.close();
  }
}

/** Spawns the API entrypoint on an EPHEMERAL port; resolves once it logs api.started. */
export async function spawnApi(env: TestStackEnv): Promise<SpawnedProcess & { port: number }> {
  const child = spawnNode(['src/entrypoints/api.ts'], env, {
    MOS_HTTP_PORT: '0',
    MOS_LOG_LEVEL: 'info',
  });
  const started = await waitForLine(child, (line) => line.includes('"api.started"'), 60_000);
  const port = extractPort(started);
  if (port === null) {
    child.kill('SIGKILL');
    throw new Error(`api.started log line did not include a port: ${started}`);
  }
  return { ...wrap(child), port };
}

/** Spawns the worker entrypoint (drain mode exits 0 once the queue is empty). */
export async function spawnWorker(env: TestStackEnv, extraEnv: Record<string, string> = {}): Promise<SpawnedProcess> {
  const child = spawnNode(['src/entrypoints/worker.ts', '--drain'], env, {
    MOS_LOG_LEVEL: 'info',
    MOS_WORKER_POLL_INTERVAL_MS: '50',
    ...extraEnv,
  });
  return wrap(child);
}

function spawnNode(
  args: ReadonlyArray<string>,
  env: TestStackEnv,
  extraEnv: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MOS_DATABASE_URL: env.databaseUrl,
      MOS_INTERNAL_API_TOKEN: env.internalApiToken,
      MOS_ENV: 'test',
      MOS_OBJECT_STORE: 'fs',
      MOS_OBJECT_STORE_DIR: env.objectStoreDir,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface subprocess stderr for diagnosis while keeping stdout structured.
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[subprocess stderr] ${chunk.toString('utf8')}`);
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function wrap(child: ChildProcessWithoutNullStreams): SpawnedProcess {
  const lines: string[] = [];
  const append = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') lines.push(line);
    }
  };
  child.stdout.on('data', append);
  return {
    child,
    stdoutLines: () => [...lines],
    logRecords: () =>
      lines
        .map((line) => {
          try {
            return JSON.parse(line) as ObservabilityRecord;
          } catch {
            return null;
          }
        })
        .filter((record): record is ObservabilityRecord => record !== null),
    // 'close' (not 'exit'): resolves only after stdout has been fully flushed
    // and all buffered data events have been delivered.
    exitCode: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null && lines.length >= 0 && child.stdout.readableEnded) {
          resolve(child.exitCode);
        } else {
          child.on('close', (code) => resolve(code));
        }
      }),
  };
}

function waitForLine(
  child: ChildProcessWithoutNullStreams,
  predicate: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const buffered: string[] = [];
    let settled = false;
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        buffered.push(line);
        if (!settled && predicate(line)) {
          settled = true;
          clearTimeout(timer);
          resolve(line);
        }
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`timed out after ${timeoutMs}ms waiting for process output; got: ${buffered.join('\n').slice(0, 2000)}`));
      }
    }, timeoutMs);
    child.stdout.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`process exited (code ${code}) before producing the expected output; got: ${buffered.join('\n').slice(0, 2000)}`));
      }
    });
  });
}

function extractPort(startedLine: string): number | null {
  const match = startedLine.match(/"port"\s*:\s*(\d+)/);
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

export async function waitFor<T>(
  description: string,
  probe: () => Promise<T>,
  isDone: (value: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await probe();
    if (isDone(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
    }
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApiCallOptions {
  readonly token?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly method?: string | undefined;
  readonly body?: unknown | undefined;
}

export interface ApiCallResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export async function apiCall(port: number, pathName: string, options: ApiCallOptions = {}): Promise<ApiCallResult> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.correlationId !== undefined) headers['x-correlation-id'] = options.correlationId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, headers: responseHeaders, body };
}

export interface IntegrationStack {
  readonly pg: EmbeddedPgHandle;
  readonly env: TestStackEnv;
}

/** Boots an isolated stack: fresh embedded PostgreSQL + migrations + object store dir. */
export async function bootStack(label: string): Promise<IntegrationStack> {
  const { startEmbeddedPg } = await import('./pg.ts');
  const pgHandle = await startEmbeddedPg(`mos_${label}`);
  await migrate(pgHandle.databaseUrl);
  const objectStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), `mos-objects-${label}-`));
  return {
    pg: pgHandle,
    env: {
      databaseUrl: pgHandle.databaseUrl,
      internalApiToken: 'integration-test-token',
      objectStoreDir,
    },
  };
}

export async function shutdownStack(stack: IntegrationStack): Promise<void> {
  await stack.pg.stop();
  fs.rmSync(stack.env.objectStoreDir, { recursive: true, force: true });
}

export { repoRoot };
