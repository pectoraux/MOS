/**
 * In-memory metrics registry (OBS-001).
 *
 * Counters accumulate; histograms retain observations. The registry is
 * process-local observability state: `snapshot()` exists for exposition
 * (tests, diagnostics, future scrape endpoints) and MUST NOT be consulted by
 * business or lifecycle logic (OBS-AC-02: observability is not an
 * execution-state authority).
 */

import type { Metrics } from './contract.ts';

interface Series {
  labels: string;
  value: number;
}

export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, Series>();
  private readonly histograms = new Map<string, Series[]>();
  private readonly maxObservationsPerSeries: number;

  constructor(maxObservationsPerSeries = 10_000) {
    this.maxObservationsPerSeries = maxObservationsPerSeries;
  }

  increment(name: string, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels);
    const existing = this.counters.get(`${name}${key}`);
    if (existing === undefined) {
      this.counters.set(`${name}${key}`, { labels: key, value: 1 });
    } else {
      existing.value += 1;
    }
  }

  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels);
    const series = this.histograms.get(`${name}${key}`) ?? [];
    series.push({ labels: key, value });
    if (series.length > this.maxObservationsPerSeries) {
      series.splice(0, series.length - this.maxObservationsPerSeries);
    }
    this.histograms.set(`${name}${key}`, series);
  }

  snapshot(): Readonly<Record<string, ReadonlyArray<{ labels: string; value: number }>>> {
    const out: Record<string, ReadonlyArray<{ labels: string; value: number }>> = {};
    for (const [compositeKey, series] of this.counters) {
      out[compositeKey] = [{ ...series }];
    }
    for (const [compositeKey, series] of this.histograms) {
      out[compositeKey] = series.map((entry) => ({ ...entry }));
    }
    return out;
  }
}

function labelKey(labels?: Readonly<Record<string, string>>): string {
  if (labels === undefined) return '';
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}
