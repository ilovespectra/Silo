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
export declare function defaultHeapSample(): HeapSample;
export declare function defaultCollect(): void;
export declare class HeapGuard {
    private readonly options;
    private underPressure;
    private belowSince;
    private busy;
    private readonly highRatio;
    private readonly lowRatio;
    private readonly settleMs;
    private readonly sample;
    private readonly now;
    private readonly collect;
    constructor(options: HeapGuardOptions);
    isUnderPressure(): boolean;
    tick(): Promise<void>;
}
