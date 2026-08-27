/**
 * Composite sink: fans each record out to multiple sinks (e.g., console for
 * material records + in-memory collection for diagnostics).
 */

import type { ObservabilityRecord, ObservabilitySink } from '../../contract.ts';

export class CompositeSink implements ObservabilitySink {
  private readonly sinks: ReadonlyArray<ObservabilitySink>;

  constructor(sinks: ReadonlyArray<ObservabilitySink>) {
    this.sinks = sinks;
  }

  write(record: ObservabilityRecord): void {
    for (const sink of this.sinks) {
      sink.write(record);
    }
  }
}
