/**
 * Minimal Redis RESP-2 protocol client (MKT-005).
 *
 * Speaks the public Redis/Valkey wire protocol (RESP-2) over node:net —
 * zero external SDK dependencies, keeping the frozen "no provider SDK
 * outside adapter boundaries" rule trivially satisfiable (there is no SDK
 * at all; the protocol library itself stays under platform/ and is imported
 * only by the Redis cache/lock adapters — asserted by architecture tests).
 *
 * Scope is deliberately narrow: one connection, serialized commands, the
 * reply types the cache/lock adapters need (simple string, error, integer,
 * bulk string, array). Pipelining/pub-sub/cluster routing are out of scope
 * for the advisory cache/lock seam.
 *
 * Failure semantics: any socket error, protocol error or mid-command
 * connection loss rejects the in-flight command with RespConnectionError.
 * The connection is then unusable; adapters re-establish a connection on
 * the next operation (which fails closed while the backend is down and
 * recovers automatically once the backend returns).
 */

import net from 'node:net';
import tls from 'node:tls';

export class RespConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespConnectionError';
  }
}

/** Redis reply value as produced by RESP-2 parsing. */
export type RespValue = string | number | null | ReadonlyArray<RespValue>;

export interface RespClientOptions {
  readonly host: string;
  readonly port: number;
  /** Per-command socket timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Username/password when the server requires AUTH (optional). */
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /** True → TLS transport (rediss://). */
  readonly secure?: boolean | undefined;
}

interface Pending {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RespClient {
  private readonly options: RespClientOptions;
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private closed = false;

  constructor(options: RespClientOptions) {
    this.options = options;
  }

  /** Opens the connection (idempotent for an open healthy connection). */
  async connect(): Promise<void> {
    if (this.socket !== null && !this.socket.destroyed && this.socket.readable) return;
    this.teardownSocket();
    this.closed = false;
    await new Promise<void>((resolve, reject) => {
      const socket: net.Socket = this.options.secure === true
        ? tls.connect({ host: this.options.host, port: this.options.port, rejectUnauthorized: true })
        : net.connect({ host: this.options.host, port: this.options.port });
      const fail = (error: Error): void => {
        this.teardownSocket();
        reject(new RespConnectionError(`could not connect to Redis at ${this.options.host}:${this.options.port}: ${error.message}`));
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        socket.on('error', (error) => this.failAllPending(error));
        socket.on('close', () => this.failAllPending(new RespConnectionError('Redis connection closed')));
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        this.socket = socket;
        resolve();
      });
    });
    if (this.options.password !== undefined && this.options.password !== '') {
      const authArgs =
        this.options.username !== undefined && this.options.username !== ''
          ? ['AUTH', this.options.username, this.options.password]
          : ['AUTH', this.options.password];
      const reply = await this.command(authArgs);
      if (reply !== 'OK') {
        this.close().catch(() => undefined);
        throw new RespConnectionError('Redis AUTH failed');
      }
    }
  }

  /**
   * Sends one command and awaits its reply. Commands are serialized on the
   * connection; the reply for the oldest pending command is resolved first.
   */
  async command(args: ReadonlyArray<string | number>): Promise<RespValue> {
    if (this.socket === null || this.socket.destroyed) {
      await this.connect();
    }
    const socket = this.socket;
    if (socket === null) {
      throw new RespConnectionError('Redis connection is not open');
    }
    return new Promise<RespValue>((resolve, reject) => {
      let settled = false;
      const wrappedResolve = (value: RespValue): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((entry) => entry.resolve === wrappedResolve);
        if (index >= 0) this.pending.splice(index, 1);
        wrappedReject(new RespConnectionError(`Redis command timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);
      this.pending.push({ resolve: wrappedResolve, reject: wrappedReject, timer });
      socket.write(encodeCommand(args), (error) => {
        if (error != null) {
          const index = this.pending.findIndex((entry) => entry.resolve === wrappedResolve);
          if (index >= 0) this.pending.splice(index, 1);
          wrappedReject(new RespConnectionError(`Redis write failed: ${error.message}`));
        }
      });
    });
  }

  /** Closes the connection; safe to call repeatedly. */
  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.teardownSocket();
    this.failAllPending(new RespConnectionError('Redis client closed'));
    if (socket !== null && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.destroy();
        // Guarantee resolution even if 'close' never fires.
        setTimeout(resolve, 250);
      });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseReply(this.buffer);
      if (parsed === null) return; // incomplete reply: wait for more bytes
      this.buffer = this.buffer.subarray(parsed.consumed);
      const entry = this.pending.shift();
      if (entry === undefined) {
        this.failAllPending(new RespConnectionError('Redis protocol error: reply without a pending command'));
        return;
      }
      clearTimeout(entry.timer);
      if (parsed.value instanceof RespServerError) {
        entry.reject(parsed.value);
      } else {
        entry.resolve(parsed.value);
      }
    }
  }

  private failAllPending(error: Error): void {
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error instanceof RespConnectionError ? error : new RespConnectionError(error.message));
    }
  }

  private teardownSocket(): void {
    if (this.socket !== null) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = Buffer.alloc(0);
  }
}

/** Redis `-ERR …` inline error surfaced as a typed exception. */
export class RespServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespServerError';
  }
}

/** Encodes a command as a RESP-2 array of bulk strings. */
export function encodeCommand(args: ReadonlyArray<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = `${arg}`;
    parts.push(Buffer.from(`$${Buffer.byteLength(value, 'utf8')}\r\n`), Buffer.from(value), Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

interface ParsedReply {
  readonly value: RespValue | RespServerError;
  readonly consumed: number;
}

/**
 * Parses one complete RESP-2 reply from `buffer`; null when more bytes are
 * needed. Pure function — unit-testable without a server.
 */
export function parseReply(buffer: Buffer): ParsedReply | null {
  const line = readLine(buffer);
  if (line === null) return null;
  const [type, rest] = [buffer.subarray(0, 1).toString('ascii'), line.payload];

  switch (type) {
    case '+': // simple string
    case ':': {
      // integer
      if (type === ':') {
        const value = Number.parseInt(rest, 10);
        if (Number.isNaN(value)) return invalidReply(rest);
        return { value, consumed: line.consumed };
      }
      return { value: rest, consumed: line.consumed };
    }
    case '-': {
      return { value: new RespServerError(rest), consumed: line.consumed };
    }
    case '$': {
      const length = Number.parseInt(rest, 10);
      if (Number.isNaN(length)) return invalidReply(rest);
      if (length === -1) return { value: null, consumed: line.consumed };
      const total = line.consumed + length + 2; // payload + \r\n
      if (buffer.length < total) return null;
      return { value: buffer.subarray(line.consumed, line.consumed + length).toString('utf8'), consumed: total };
    }
    case '*': {
      const count = Number.parseInt(rest, 10);
      if (Number.isNaN(count)) return invalidReply(rest);
      if (count === -1) return { value: null, consumed: line.consumed };
      const items: RespValue[] = [];
      let consumed = line.consumed;
      for (let i = 0; i < count; i += 1) {
        const item = parseReply(buffer.subarray(consumed));
        if (item === null) return null;
        if (item.value instanceof RespServerError) {
          return { value: item.value, consumed: consumed + item.consumed };
        }
        items.push(item.value);
        consumed += item.consumed;
      }
      return { value: items, consumed };
    }
    default:
      return invalidReply(`${type}${rest}`);
  }
}

function invalidReply(dump: string): { value: RespServerError; consumed: number } {
  return { value: new RespServerError(`Malformed Redis reply: ${JSON.stringify(dump.slice(0, 80))}`), consumed: dump.length + 2 };
}

function readLine(buffer: Buffer): { payload: string; consumed: number } | null {
  const index = buffer.indexOf(0x0d, 0, 'ascii'); // \r
  if (index === -1 || index + 1 >= buffer.length || buffer[index + 1] !== 0x0a) return null;
  return { payload: buffer.subarray(1, index).toString('utf8'), consumed: index + 2 };
}
