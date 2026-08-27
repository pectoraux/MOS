/**
 * Redis cache adapter (MKT-005, AC-03) — advisory cache over the RESP
 * protocol client. PostgreSQL remains the authoritative system of record;
 * this adapter ONLY accelerates reads. Backend failures surface as
 * BackendUnavailableError (never fabricated values); the adapter
 * re-establishes the connection lazily so a Redis outage degrades to
 * explicit errors and recovery is automatic once Redis returns.
 */

import { BackendUnavailableError } from '../../../errors/errors.ts';
import type { CachePort } from '../../contract.ts';
import { RespClient, RespConnectionError, RespServerError } from '../../../redis/resp/resp-client.ts';

export interface RedisCacheOptions {
  readonly host: string;
  readonly port: number;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /** True → TLS transport (rediss://). */
  readonly secure?: boolean | undefined;
  readonly timeoutMs: number;
  /** Key prefix namespacing this deployment's cache keys. */
  readonly keyPrefix: string;
}

export class RedisCache implements CachePort {
  private readonly options: RedisCacheOptions;
  private client: RespClient | null = null;

  constructor(options: RedisCacheOptions) {
    this.options = options;
  }

  async get(key: string): Promise<string | null> {
    const reply = await this.command('GET', this.prefixed(key));
    if (reply === null) return null;
    if (typeof reply !== 'string') {
      throw new BackendUnavailableError(`Redis GET returned an unexpected reply type for key '${key}'`);
    }
    return reply;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new BackendUnavailableError('cache TTL must be a positive integer of milliseconds', false);
    }
    const reply = await this.command('SET', this.prefixed(key), value, 'PX', ttlMs);
    if (reply !== 'OK') {
      throw new BackendUnavailableError(`Redis SET did not acknowledge storage of key '${key}'`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.command('DEL', this.prefixed(key));
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
      // Any connection/protocol failure tears the connection down so the
      // next call attempts a fresh one (fail now, recover later).
      if (this.client !== null) {
        await this.client.close().catch(() => undefined);
        this.client = null;
      }
      if (error instanceof RespServerError) {
        throw new BackendUnavailableError(`Redis command failed: ${error.message}`);
      }
      if (error instanceof RespConnectionError) {
        throw new BackendUnavailableError(`Redis cache backend unavailable: ${error.message}`);
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
