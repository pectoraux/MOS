/**
 * Console sink: writes each observability record as a single JSON line to
 * stdout. This is the material logging channel used by api/worker processes;
 * integration tests parse these lines from subprocess stdout (OBS-AC-01).
 */

import type { ObservabilityRecord, ObservabilitySink } from '../../contract.ts';

export class ConsoleSink implements ObservabilitySink {
  write(record: ObservabilityRecord): void {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}
