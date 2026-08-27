/**
 * Integration-test PostgreSQL harness.
 *
 * Boots a REAL PostgreSQL server (embedded-postgres: official PostgreSQL 18
 * binaries shipped in @embedded-postgres/linux-x64) so integration tests run
 * against the actual system of record — not a mock or emulation.
 *
 * The bundled binaries link ICU 60; hosts with newer ICU (e.g. Ubuntu 24.04
 * ships ICU 76) need libicu60 on the library path. The harness downloads the
 * Ubuntu libicu60 package ONCE into .test-deps/ and extracts it locally when
 * the host does not provide it. When neither download nor system ICU 60 is
 * available the harness FAILS LOUDLY with instructions — per the no-false-
 * green rule (docs/architecture/IMPLEMENTATION-GOVERNANCE.md), a missing
 * integration dependency must never be reported as a pass.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const testDepsDir = path.join(repoRoot, '.test-deps');

const ICU_DEB_URL = 'https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu60_60.2-3ubuntu3_amd64.deb';

/** SHA-256 of the pinned libicu60 package (integrity: a truncated download must fail loudly). */
const ICU_DEB_SHA256 = '7a2f29ea19f2a14007fd84f25eb88db4fb3ca43bdb07fdb681329d2b5daca500';

/**
 * Returns a directory containing libicuuc.so.60, or null when the host already
 * provides ICU 60.
 *
 * Concurrent-safe: test files run in parallel processes. Downloads go to
 * process-unique temp files, extraction happens into a staging directory, and
 * the result is installed with an atomic rename — a partially-downloaded or
 * partially-extracted library can never be observed by another process
 * (a truncated ICU library makes the PostgreSQL binaries die with SIGBUS).
 */
export function ensureIcu60(): string | null {
  const override = process.env['MOS_TEST_ICU_LIB_DIR'];
  if (override !== undefined && override !== '') {
    return override;
  }
  if (systemHasIcu60()) return null;

  const libDir = path.join(testDepsDir, 'icu60', 'usr', 'lib', 'x86_64-linux-gnu');
  if (fs.existsSync(path.join(libDir, 'libicuuc.so.60'))) {
    return libDir;
  }

  fs.mkdirSync(testDepsDir, { recursive: true });
  const debPath = path.join(testDepsDir, 'libicu60.deb');
  let verifiedDeb: string;
  if (fs.existsSync(debPath) && sha256OfFile(debPath) === ICU_DEB_SHA256) {
    verifiedDeb = debPath;
  } else {
    // Download into a process-private file, verify, then publish atomically.
    // Even if a concurrent process wins the publish, this process extracts
    // from its own verified copy.
    const privateDeb = `${debPath}.verified-${process.pid}`;
    downloadVerified(ICU_DEB_URL, privateDeb, ICU_DEB_SHA256);
    verifiedDeb = privateDeb;
    if (!fs.existsSync(debPath)) {
      try {
        fs.renameSync(privateDeb, debPath);
        verifiedDeb = debPath;
      } catch {
        // Another process published first; keep using the private copy.
      }
    }
  }

  // Extract into a process-unique staging directory, then install atomically.
  const staging = path.join(testDepsDir, `icu60-staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  execFileSync('dpkg-deb', ['-x', verifiedDeb, staging], { stdio: 'inherit' });
  fs.rmSync(`${debPath}.verified-${process.pid}`, { force: true });
  const stagedLib = path.join(staging, 'usr', 'lib', 'x86_64-linux-gnu', 'libicuuc.so.60');
  if (!fs.existsSync(stagedLib)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('libicu60 extracted but libicuuc.so.60 missing');
  }

  const installDir = path.join(testDepsDir, 'icu60');
  try {
    fs.renameSync(staging, installDir);
  } catch {
    // Another concurrent process installed it first — use theirs.
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(libDir, 'libicuuc.so.60'))) {
    throw new Error('libicu60 provisioning failed: libicuuc.so.60 not present after install');
  }
  return libDir;
}

function downloadVerified(url: string, targetPath: string, expectedSha256: string): void {
  process.stderr.write(`[pg-harness] downloading libicu60 for embedded PostgreSQL (${url})\n`);
  const tempPath = `${targetPath}.part-${process.pid}`;
  execFileSync(
    process.execPath,
    [
      '-e',
      `const fs=require('fs');const https=require('https');const file=fs.createWriteStream(${JSON.stringify(tempPath)});https.get(${JSON.stringify(url)},r=>{if(r.statusCode!==200){process.exit(3)}r.pipe(file);file.on('finish',()=>file.close())}).on('error',()=>process.exit(4));`,
    ],
    { stdio: 'inherit', timeout: 120_000 },
  );
  if (!fs.existsSync(tempPath)) {
    throw new Error('libicu60 download failed');
  }
  const digest = sha256OfFile(tempPath);
  if (digest !== expectedSha256) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`libicu60 download integrity mismatch: sha256 ${digest} != ${expectedSha256}`);
  }
  fs.renameSync(tempPath, targetPath);
}

function sha256OfFile(filePath: string): string {
  return execFileSync('sha256sum', [filePath], { encoding: 'utf8' }).split(/\s+/)[0] ?? '';
}

function systemHasIcu60(): boolean {
  try {
    const output = execFileSync('ldconfig', ['-p'], { encoding: 'utf8' });
    return output.includes('libicuuc.so.60');
  } catch {
    return false;
  }
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export interface EmbeddedPgHandle {
  readonly port: number;
  readonly databaseUrl: string;
  readonly pool: pg.Pool;
  stop(): Promise<void>;
}

/**
 * Boots an isolated embedded PostgreSQL server + fresh database and returns a
 * connected pool. The server process tree inherits LD_LIBRARY_PATH so the
 * ICU-linked binaries resolve their shared libraries.
 */
export async function startEmbeddedPg(databaseName: string): Promise<EmbeddedPgHandle> {
  const icuDir = ensureIcu60();
  if (icuDir !== null) {
    const existing = process.env['LD_LIBRARY_PATH'] ?? '';
    if (!existing.split(':').includes(icuDir)) {
      process.env['LD_LIBRARY_PATH'] = existing === '' ? icuDir : `${icuDir}:${existing}`;
    }
  }

  const port = await findFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `mos-pgdata-${databaseName}-`));

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  try {
    await instance.initialise();
    await instance.start();
    await instance.createDatabase(databaseName);
  } catch (error) {
    try {
      await instance.stop();
    } catch {
      // already stopped or never started
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      `Failed to start embedded PostgreSQL for integration tests: ${String(error)}. ` +
        'Integration tests require a real PostgreSQL; a missing dependency must be fixed, not skipped ' +
        '(no-false-green rule, docs/architecture/IMPLEMENTATION-GOVERNANCE.md).',
      { cause: error },
    );
  }

  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/${databaseName}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  return {
    port,
    databaseUrl,
    pool,
    async stop() {
      await pool.end();
      await instance.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
