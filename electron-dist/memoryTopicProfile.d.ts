/**
 * Local, incremental topic profile for Memories. Each sampled photo is assigned to the
 * closest prompt of a fixed, extensible vocabulary using its existing CLIP vector; no
 * embeddings are recomputed and nothing leaves the machine. Electron-free for tests.
 */
export interface ProfileRecord {
    path: string;
    sourcePath: string;
    modified: number;
    /** Index signature (size:mtime); a change means the photo must be reclassified. */
    signature: string;
}
export interface ProfileTopic {
    id: string;
    prompt: string;
}
export interface TopicProfileDependencies {
    statePath: string;
    topics: readonly ProfileTopic[];
    /** Prompts that compete for photos but are never reported (screenshots, generic shots). */
    distractorPrompts: readonly string[];
    /** Monotonic counter that changes whenever indexed records change. */
    revision(): number | string;
    /** Current personal-photo records with vectors; privacy filtering happens in the caller. */
    records(): ProfileRecord[] | Promise<ProfileRecord[]>;
    vectors(paths: string[]): Promise<Map<string, Float32Array>>;
    embedPrompts(prompts: string[]): Promise<Float32Array[]>;
    /** EXIF capture time in ms, or null when unknown. */
    captureTime(filePath: string): Promise<number | null>;
    now?(): number;
}
export interface TopicProfileOptions {
    /** Older photos are sampled deterministically down to about this many. */
    sampleTarget?: number;
    /** Photos modified within this window are always included at full resolution. */
    recentDays?: number;
    minimumSimilarity?: number;
    /** EXIF reads per refresh; the rest fall back to the indexed modification time. */
    captureReadsPerRefresh?: number;
    /** Recent photos a topic needs before it can count as emerging. */
    minEmerging?: number;
}
export interface TopicSummary {
    id: string;
    /** Estimated photos in the archive (inverse-probability weighted sample). */
    estimatedCount: number;
    /** Share of the whole archive. */
    archiveShare: number;
    /** Mean share across sources, so one huge source cannot hide another's interests. */
    sourceBalancedShare: number;
    /** Long-term interest relative to the top topic, 0..1. */
    interest: number;
    meanConfidence: number;
    recentCount: number;
    /** Recent share / long-term share (smoothed); 1 means nothing new. */
    lift: number;
    bySource: Record<string, number>;
    /** Highest-confidence matches. */
    paths: string[];
    /** Recently captured matches, newest first. */
    recentPaths: string[];
}
export interface TopicProfileSnapshot {
    revision: string;
    fingerprint: string;
    generatedAt: number;
    sampledPhotos: number;
    topics: TopicSummary[];
}
export interface RefreshResult {
    /** False when the index revision was unchanged and nothing was read. */
    recomputed: boolean;
    /** True when the ranked topic picture changed enough to refresh suggestions. */
    changed: boolean;
    classified: number;
    removed: number;
}
/** Stable [0,1) value per path: membership in the sample never flickers between refreshes. */
export declare function sampleUnit(filePath: string): number;
export declare class MemoryTopicProfile {
    private readonly deps;
    private entries;
    private sources;
    private sourceIndex;
    private sampleRate;
    private lastRevision;
    private snapshot;
    private loaded?;
    private refreshing?;
    private promptVectors?;
    private readonly vocabularyKey;
    private readonly options;
    constructor(deps: TopicProfileDependencies, options?: TopicProfileOptions);
    getSnapshot(): TopicProfileSnapshot | null;
    /** Capture time recorded for a sampled photo, when EXIF provided one. */
    captureTimeOf(filePath: string): number | undefined;
    /** Single-flight: concurrent callers share one refresh. */
    refresh(): Promise<RefreshResult>;
    private load;
    private source;
    private refreshOnce;
    private summarize;
    /** Coarse view of the ranking: small count drift does not count as a change. */
    private fingerprint;
    private persist;
}
/**
 * Debounced, single-flight trigger: waits for a quiet period, defers while indexing is
 * busy, never overlaps runs, and collapses notifications during a run into one rerun.
 */
export declare class RefreshScheduler {
    private readonly options;
    private timer;
    private running;
    private dirty;
    constructor(options: {
        delayMs: number;
        isBusy(): boolean;
        run(): Promise<void>;
        setTimer?(callback: () => void, delay: number): unknown;
        clearTimer?(handle: unknown): void;
    });
    notify(): void;
    private fire;
}
