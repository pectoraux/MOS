/**
 * Structured logger (OBS-001 / OBS-AC-02).
 *
 * Every record satisfies the required-field contract from contract.ts and
 * carries the ambient correlation identity (OBS-AC-01) automatically.
 * Secret-shaped keys in `fields` are redacted before reaching any sink
 * (spec/security-threat-model.md: "Secret exfiltration — log scrubbing").
 */

import type { Logger, LogLevel, LoggerFactory, ObservabilityRecord, ObservabilitySink } from './contract.ts';
import { currentCorrelation } from './correlation.ts';
import { validateRecord } from './contract.ts';
import type { Clock } from '../clock/clock.ts';

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY_RE = /password|secret|token|credential|authorization|api[-_]?key/i;

/** Best-effort deep redaction of secret-shaped keys. Returns a plain copy. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactSecrets(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactSecrets(nested, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  readonly sink: ObservabilitySink;
  readonly clock: Clock;
  readonly minLevel: LogLevel;
}

class StructuredLogger implements Logger {
  private readonly module: string;
  private readonly options: LoggerOptions;

  constructor(module: string, options: LoggerOptions) {
    this.module = module;
    this.options = options;
  }

  debug(event: string, msg?: string, fields?: Record<string, unknown>): void {
    this.log('debug', event, msg, fields);
  }

  info(event: string, msg?: string, fields?: Record<string, unknown>): void {
    this.log('info', event, msg, fields);
  }

  warn(event: string, msg?: string, fields?: Record<string, unknown>): void {
    this.log('warn', event, msg, fields);
  }

  error(event: string, msg?: string, fields?: Record<string, unknown>): void {
    this.log('error', event, msg, fields);
  }

  log(level: LogLevel, event: string, msg?: string, fields?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.options.minLevel]) return;

    const correlation = currentCorrelation();
    const record: ObservabilityRecord = {
      timestamp: this.options.clock.nowIso(),
      level,
      event,
      correlation_id: correlation.correlationId,
      causation_id: correlation.causationId,
      actor: correlation.actor,
      module: this.module,
      ...(msg === undefined ? {} : { msg }),
      ...(fields === undefined ? {} : { fields: redactSecrets(fields) as Record<string, unknown> }),
    };

    const violations = validateRecord(record);
    if (violations.length > 0) {
      // A malformed record is itself an observability defect; emit a safe
      // fallback record rather than silently dropping evidence.
      this.options.sink.write({
        timestamp: this.options.clock.nowIso(),
        level: 'error',
        event: 'observability.record.invalid',
        correlation_id: record.correlation_id === '' ? 'unattributed' : record.correlation_id,
        causation_id: null,
        actor: null,
        module: 'platform.observability',
        msg: 'record failed required-field validation',
        fields: { violations },
      });
      return;
    }

    this.options.sink.write(record);
  }
}

export function createLoggerFactory(options: LoggerOptions): LoggerFactory {
  return {
    forModule(module: string): Logger {
      return new StructuredLogger(module, options);
    },
  };
}
