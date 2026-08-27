/**
 * Password verifier (scrypt via node:crypto — no external packages).
 *
 * Verifier format: `scrypt$N$r$p$saltB64$hashB64`. Verification is constant
 * time and fails CLOSED on any malformed verifier (an unreadable credential
 * never authenticates).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, verifier: string): boolean {
  const parts = verifier.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  if (n <= 0 || r <= 0 || p <= 0 || n * r * p >= 2 ** 31) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0 || expected.length > 1024) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
