import * as v8 from "v8";

/**
 * Hysteresis-based heap pressure monitor. Electron's V8 uses pointer compression,
 * which caps the main-process heap near 4 GB regardless of --max-old-space-size, so
 * background work must back off before the hard limit rather than rely on flags.
 */
export interface HeapSample {
  used: number;
  limit: number;
}

export interface HeapGuardOptions {
  /** Enter pressure at this fraction of the heap limit. */
  highRatio?: number;
  /** Leave pressure once usage falls below this fraction for `settleMs`. */
  lowRatio?: number;
  settleMs?: number;
  sample?: () => HeapSample;
  now?: () => number;
  collect?: () => void;
  onPressure: (sample: HeapSample) => void | Promise<void>;
  onRelief: (sample: HeapSample) => void | Promise<void>;
}

export function defaultHeapSample(): HeapSample {
  const stats = v8.getHeapStatistics();
  return { used: stats.used_heap_size, limit: stats.heap_size_limit };
}

export function defaultCollect() {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

export class HeapGuard {
  private underPressure = false;
  private belowSince: number | null = null;
  private busy = false;
  private readonly highRatio: number;
  private readonly lowRatio: number;
  private readonly settleMs: number;
  private readonly sample: () => HeapSample;
  private readonly now: () => number;
  private readonly collect: () => void;

  constructor(private readonly options: HeapGuardOptions) {
    this.highRatio = options.highRatio ?? 0.7;
    this.lowRatio = options.lowRatio ?? 0.45;
    this.settleMs = options.settleMs ?? 20000;
    this.sample = options.sample ?? defaultHeapSample;
    this.now = options.now ?? Date.now;
    this.collect = options.collect ?? defaultCollect;
  }

  isUnderPressure() {
    return this.underPressure;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let current = this.sample();
      const ratio = () => (current.limit > 0 ? current.used / current.limit : 0);
      if (!this.underPressure) {
        if (ratio() < this.highRatio) return;
        // A full collection may resolve transient garbage without pausing work.
        this.collect();
        current = this.sample();
        if (ratio() < this.highRatio) return;
        this.underPressure = true;
        this.belowSince = null;
        await this.options.onPressure(current);
        this.collect();
        return;
      }
      if (ratio() >= this.lowRatio) {
        this.belowSince = null;
        this.collect();
        return;
      }
      this.belowSince ??= this.now();
      if (this.now() - this.belowSince < this.settleMs) return;
      this.underPressure = false;
      this.belowSince = null;
      await this.options.onRelief(current);
    } finally {
      this.busy = false;
    }
  }
}
