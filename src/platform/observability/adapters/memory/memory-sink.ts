/**
 * In-memory sink: collects observability records for inspection in tests and
 * diagnostics. Records are exposed as an immutable snapshot copy — the sink
 * itself remains append-only (no update/delete of collected records).
 */

import type { ObservabilityRecord, ObservabilitySink } from '../../contract.ts';

export class MemorySink implements ObservabilitySink {
  private readonly records: ObservabilityRecord[] = [];

  write(record: ObservabilityRecord): void {
    this.records.push(record);
  }

  /** Immutable copy of all records collected so far, in emission order. */
  snapshot(): ReadonlyArray<ObservabilityRecord> {
    return this.records.map((record) => ({ ...record }));
  }

  get size(): number {
    return this.records.length;
  }
}
