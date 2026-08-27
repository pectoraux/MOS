/**
 * Time port. Application code never calls Date.now()/new Date() directly so
 * that deterministic time can be injected in tests and scheduled work can be
 * reasoned about (retry backoff, timeouts, lease expiry).
 */

export interface Clock {
  /** Current wall-clock time in milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Current wall-clock time as an ISO 8601 UTC string. */
  nowIso(): string;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }
}

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  private currentMs: number;

  constructor(startMs: number = 0) {
    this.currentMs = startMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }
}
