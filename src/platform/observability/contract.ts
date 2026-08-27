/**
 * Observability contract (OBS-001 / OBS-AC-02).
 *
 * Structured observability records expose the required execution/runtime
 * fields and are APPEND-ONLY. The observability surface intentionally offers:
 *   - NO read-back/query API for log records,
 *   - NO mutation API for any business or execution state.
 *
 * Observability is therefore structurally incapable of becoming an
 * execution-state authority (spec/architecture.md §2.1, AGENTS.md authority
 * rules: "treating Redis/queues/logging as a system of record" is forbidden).
 * PostgreSQL remains the application system of record; observability records
 * describe execution, they never decide it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured, append-oriented observability record. */
export interface ObservabilityRecord {
  /** ISO 8601 UTC timestamp of emission. */
  readonly timestamp: string;
  readonly level: LogLevel;
  /** Dot-namespaced event identifier, e.g. 'http.request', 'job.succeeded'. */
  readonly event: string;
  /** Correlation identity of the flow this record belongs to. */
  readonly correlation_id: string;
  /** Immediate cause of this record's unit of work (job id) when applicable. */
  readonly causation_id: string | null;
  /** Actor principal when known. */
  readonly actor: string | null;
  /** Producing component, e.g. 'platform.http', 'workers', 'modules/goals'. */
  readonly module: string;
  /** Human-readable summary. */
  readonly msg?: string | undefined;
  /** Execution/runtime fields (job_id, worker_id, attempt, duration_ms, status, ...). */
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Append-only sink for observability records.
 *
 * The interface exposes exactly one method, `write`. There is deliberately no
 * read, update or delete operation: sinks are not a queryable authority.
 * (The OBS-AC-02 static test asserts this surface.)
 */
export interface ObservabilitySink {
  write(record: ObservabilityRecord): void;
}

/** Logger bound to a producing component. */
export interface Logger {
  debug(event: string, msg?: string, fields?: Record<string, unknown>): void;
  info(event: string, msg?: string, fields?: Record<string, unknown>): void;
  warn(event: string, msg?: string, fields?: Record<string, unknown>): void;
  error(event: string, msg?: string, fields?: Record<string, unknown>): void;
  /** Emits at the given level. */
  log(level: LogLevel, event: string, msg?: string, fields?: Record<string, unknown>): void;
}

/** Logger factory bound to the platform's sinks and level policy. */
export interface LoggerFactory {
  forModule(module: string): Logger;
}

/**
 * Metrics port (OBS-001 "metrics"). In-process registry: counters and
 * histograms with string label values. `snapshot()` renders an exposition
 * copy — reading metrics is for observation only and can never feed a
 * business lifecycle decision.
 */
export interface Metrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  /** Immutable copy of the current registry state. */
  snapshot(): Readonly<Record<string, ReadonlyArray<{ labels: string; value: number }>>>;
}

/** Field names required on every observability record. */
export const REQUIRED_RECORD_FIELDS: ReadonlyArray<keyof ObservabilityRecord> = [
  'timestamp',
  'level',
  'event',
  'correlation_id',
  'causation_id',
  'actor',
  'module',
];

/**
 * Validates the required-field contract. Returns violations (empty = valid).
 *
 * Required fields must be PRESENT. `causation_id` and `actor` are nullable by
 * contract — `null` is a valid value for them ("no causation/actor known"),
 * while `undefined` means the field was not emitted at all.
 */
export function validateRecord(record: ObservabilityRecord): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const field of REQUIRED_RECORD_FIELDS) {
    const value = record[field];
    if (value === undefined) {
      violations.push(`missing required field: ${String(field)}`);
    }
  }
  if (typeof record.timestamp !== 'string' || Number.isNaN(Date.parse(record.timestamp))) {
    violations.push('timestamp must be an ISO 8601 string');
  }
  if (typeof record.correlation_id !== 'string' || record.correlation_id.length === 0) {
    violations.push('correlation_id must be a non-empty string');
  }
  if (record.causation_id !== null && typeof record.causation_id !== 'string') {
    violations.push('causation_id must be a string or null');
  }
  if (record.actor !== null && typeof record.actor !== 'string') {
    violations.push('actor must be a string or null');
  }
  if (typeof record.module !== 'string' || record.module.length === 0) {
    violations.push('module must be a non-empty string');
  }
  if (typeof record.event !== 'string' || record.event.length === 0) {
    violations.push('event must be a non-empty string');
  }
  return violations;
}
