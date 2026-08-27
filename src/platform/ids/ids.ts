/**
 * Identifier generation port.
 *
 * Identifiers are opaque, immutable and generated server-side
 * (spec/implementation-contract.md §3: no externally supplied identifier
 * may override a server-derived authority value).
 *
 * UUIDv7 is used for entity identifiers: time-ordered (index-friendly for the
 * append-oriented platform tables) while remaining opaque.
 */

export interface IdGenerator {
  /** Generates a fresh opaque identifier (UUID v7). */
  newId(): string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns true when `value` is a canonical lowercase UUID string. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Cryptographically random IdGenerator based on UUID v7. */
export class CryptoIdGenerator implements IdGenerator {
  newId(): string {
    return uuidv7();
  }
}

/**
 * UUID v7: 48-bit big-endian Unix millisecond timestamp + version/variant
 * bits + 74 random bits (RFC 9562). Randomness from crypto.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const now = Date.now();
  const ts = BigInt(now);
  // 48-bit timestamp into bytes 0..5 (big endian)
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // version 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant 10xx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
