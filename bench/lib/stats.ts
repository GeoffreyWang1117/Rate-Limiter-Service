/**
 * Latency recording for the benchmarks.
 *
 * Samples are kept individually rather than folded into a running mean. Tail
 * behaviour is the whole point of measuring a limiter -- a mean hides exactly
 * the requests that matter -- and at these sample counts the memory is free.
 */
export class Latencies {
  private samples: number[] = [];

  record(ms: number): void {
    this.samples.push(ms);
  }

  get count(): number {
    return this.samples.length;
  }

  /** Nearest-rank quantile. Returns NaN for an empty set rather than a misleading 0. */
  quantile(q: number): number {
    if (this.samples.length === 0) return NaN;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
    return sorted[Math.max(0, rank)];
  }

  get mean(): number {
    if (this.samples.length === 0) return NaN;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  get max(): number {
    return this.samples.length ? Math.max(...this.samples) : NaN;
  }

  summary() {
    return {
      count: this.count,
      mean: this.mean,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      p999: this.quantile(0.999),
      max: this.max,
    };
  }
}

export const fmt = (n: number, digits = 2): string =>
  Number.isFinite(n) ? n.toFixed(digits) : '-';

/**
 * Sleeps until an absolute deadline.
 *
 * The load generator schedules against absolute arrival times rather than
 * sleeping for a fixed gap after each request. Sleeping for a gap makes the
 * generator slow down whenever the system under test does, which is coordinated
 * omission: the run stops offering the load it claims to offer at exactly the
 * moment that load becomes interesting.
 */
export function sleepUntil(deadlineMs: number): Promise<void> {
  const delay = deadlineMs - Date.now();
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Mulberry32. Seeded so a benchmark run is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function table(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const width = Object.fromEntries(
    cols.map((c) => [
      c,
      Math.max(c.length, ...rows.map((r) => String(r[c]).length)),
    ])
  );
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => c.padStart(width[cols[i]])).join('  ');
  return [
    line(cols),
    '  ' + cols.map((c) => '-'.repeat(width[c])).join('  '),
    ...rows.map((r) => line(cols.map((c) => String(r[c])))),
  ].join('\n');
}
