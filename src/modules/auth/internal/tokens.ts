/**
 * Opaque session tokens.
 *
 * A session token is 32 random bytes (base64url, 43 chars, 256-bit entropy).
 * Only its SHA-256 hash is persisted; the raw value exists client-side after
 * login and is addressed by hash everywhere server-side.
 */

import { createHash, randomBytes } from 'node:crypto';

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
