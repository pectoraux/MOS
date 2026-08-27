/**
 * Redis distributed-lock adapter (MKT-005, AC-03) — advisory mutual
 * exclusion over the RESP protocol client.
 *
 * Acquire is `SET key token NX PX ttl` (atomic test-and-set with expiry);
 * the lease token is a fresh random value so only the lease OWNER can
 * release (compare-and-delete via a small Lua script — the only atomic
 * owner-checked delete in Redis).
 *
 * FAIL-CLOSED: while Redis is unavailable, `acquire` throws
 * BackendUnavailableError — it never silently grants a lease. Durable
 * correctness never depends on these locks (PostgreSQL fences own
 * exactly-once semantics); see the locking port contract.
 */

import { randomBytes } from 'node:crypto';
import { BackendUnavailableError } from '../../../errors/errors.ts';
import type { LockPort } from '../../contract.ts';
import { RespClient, RespConnectionError, RespServerError } from '../../../redis/resp/resp-client.ts';

/** Owner-checked compare-and-delete (atomic). */
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export interface RedisLockOptions {
  readonly host: string;
  readonly port: number;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /** True → TLS transport (rediss://). */
  readonly secure?: boolean | undefined;
  readonly timeoutMs: number;
  /** Key prefix namespacing this deployment's lock keys. */
  readonly keyPrefix: string;
}

export class RedisLock implements LockPort {
  private readonly options: RedisLockOptions;
  private client: RespClient | null = null;

  constructor(options: RedisLockOptions) {
    this.options = options;
  }

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new BackendUnavailableError('lock TTL must be a positive integer of milliseconds', false);
    }
    const token = randomBytes(16).toString('hex');
    // SET key token NX PX ttl — atomically claims the lease or returns null.
    const reply = await this.command('SET', this.prefixed(key), token, 'NX', 'PX', ttlMs);
    if (reply === null) return null; // currently held
    if (reply !== 'OK') {
      throw new BackendUnavailableError(`Redis lock acquire returned an unexpected reply for key '${key}'`);
    }
    return token;
  }

  async release(key: string, token: string): Promise<boolean> {
    const reply = await this.command('EVAL', RELEASE_SCRIPT, '1', this.prefixed(key), token);
    if (typeof reply !== 'number') {
      throw new BackendUnavailableError(`Redis lock release returned an unexpected reply for key '${key}'`);
    }
    return reply === 1;
  }

  /** Closes the underlying connection (used by tests and shutdown paths). */
  async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.close();
      this.client = null;
    }
  }

  private async command(...args: ReadonlyArray<string | number>): Promise<unknown> {
    try {
      let client = this.client;
      if (client === null || client.isClosed) {
        client = new RespClient(this.connectionOptions());
        this.client = client;
      }
      await client.connect();
      return await client.command(args);
    } catch (error) {
      if (this.client !== null) {
        await this.client.close().catch(() => undefined);
        this.client = null;
      }
      if (error instanceof RespServerError) {
        throw new BackendUnavailableError(`Redis command failed: ${error.message}`);
      }
      if (error instanceof RespConnectionError) {
        throw new BackendUnavailableError(`Redis lock backend unavailable: ${error.message}`);
      }
      throw error;
    }
  }

  private connectionOptions() {
    return {
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      password: this.options.password,
      secure: this.options.secure,
      timeoutMs: this.options.timeoutMs,
    };
  }

  private prefixed(key: string): string {
    return `${this.options.keyPrefix}${key}`;
  }
}
