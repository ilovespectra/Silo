import type { SearchPerformanceSettings } from "./contentSettings";
export declare function confidenceSettingToMinimumThreshold(confidence: number): number;
export interface IndexableFile {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    modified: number;
    isDirectory: boolean;
    type: string;
    extension: string;
}
export interface SearchResult extends IndexableFile {
    confidence: number;
}
export interface IndexProgress {
    status: "idle" | "scanning" | "loading-model" | "indexing" | "paused" | "complete" | "error";
    total: number;
    indexed: number;
    remaining: number;
    errors: number;
    currentFile: string | null;
    message: string;
}
type ScanSource = (sourcePath: string, onFile: (file: IndexableFile) => void, isCancelled: () => boolean, shouldPauseForSearch?: () => boolean) => Promise<void>;
type ProgressListener = (progress: IndexProgress) => void;
type SearchProgressListener = (results: SearchResult[], scanned: number, total: number, mode?: "ann") => void;
type SourceCoverageStatus = "pending" | "scanning" | "completed" | "error" | "unavailable";
type DiagnosticListener = (event: string, details?: Record<string, unknown>) => void;
export declare class SemanticIndexer {
    private readonly userDataPath;
    private canonicalUserDataPath;
    private readonly canonicalSourcePaths;
    private readonly indexDirectory;
    private readonly recordsPath;
    private readonly vectorsPath;
    private readonly progressPath;
    private readonly modelCachePath;
    private readonly scanSource;
    private readonly onProgress;
    private readonly onDiagnostic;
    private latestRecords;
    private readonly latestRecordsByVectorKey;
    private persistedVectorIndex;
    private vectorIndexBuildPromise;
    private performanceSettings;
    private vectorIndexReady;
    private resolveVectorIndexReady;
    private rejectVectorIndexReady;
    private readonly textRecordIds;
    private readonly textRecordPaths;
    private readonly textRecordTerms;
    private readonly textPostingTerms;
    private readonly textPostings;
    private readonly activeTextSearches;
    private readonly indexedRecordListeners;
    private backgroundIndexWorkListener;
    private readonly searchEmbeddingCache;
    private indexedSearchSnapshotCache;
    private readonly processingPaths;
    private demoFileLimit;
    private readonly recordCountsBySource;
    private readonly discoveredTotalsBySource;
    private readonly workerFailures;
    private retryableErrorCountCache;
    private pendingCheckpoint;
    private recoveryFileWriteChain;
    private recoveryFileWriteSequence;
    private restoredSourcePaths;
    private progress;
    private clipRuntime;
    private clipRuntimePromise;
    private embeddingWorker;
    private readonly embeddingExitDetails;
    private embeddingRequestId;
    private readonly embeddingRequests;
    private readonly inferenceQueue;
    private inferenceSequence;
    private inferenceActive;
    private activeSearchCount;
    private searchChain;
    private runPromise;
    private queuedSourcePaths;
    private pauseRequested;
    private auditTotal;
    private auditIndexed;
    private auditErrors;
    private readonly sourceCoverage;
    private readonly sourcesWithExcludedRecords;
    private coverageWriteQueue;
    private summaryWriteQueue;
    private reconciliation;
    private reconciliationPromise;
    private searchDiscovery;
    getReconciliationProgress(): {
        running: boolean;
        source: string;
        sourcePath: string;
        sourceIndex: number;
        sourceCount: number;
        scanned: number;
        changed: number;
        startedAt: number;
        message: string;
        error: string;
    };
    getSourceCoverageProgress(sourcePaths: string[]): {
        sources: {
            status: SourceCoverageStatus;
            completedAt: number;
            error: string;
            sourcePath: string;
        }[];
        total: number;
        completed: number;
        scanning: number;
        errors: number;
        unavailable: number;
        pending: number;
    };
    private setSourceCoverage;
    private fileWatchers;
    private watchedSources;
    private revision;
    private loaded;
    private loadComplete;
    private writeChain;
    private recordsBoundaryChecked;
    private dirtyWatchSources;
    private watchHolds;
    private reconciliationTimeout;
    private isWatching;
    private filesToIndex;
    constructor(userDataPath: string, modelCachePath: string, scanSource: ScanSource, onProgress: ProgressListener, onDiagnostic?: DiagnosticListener, indexStoragePath?: string);
    setBackgroundIndexWorkListener(listener: ((changedFiles: Map<string, string>) => void) | null): void;
    setPerformanceSettings(settings: SearchPerformanceSettings): void;
    initialize(onLoadProgress?: (fraction: number, records: number) => void): Promise<void>;
    /** False while the saved index is still being read; partial counts are shown meanwhile. */
    isLoaded(): boolean;
    whenLoaded(): Promise<void>;
    prepareVectorSearch(onProgress: (fraction: number, records: number) => void): Promise<void>;
    flushVectorSearch(): Promise<void>;
    private beginInteractiveSearch;
    private endInteractiveSearch;
    private openIndex;
    getProgress(): IndexProgress;
    isSearchActive(): boolean;
    setDemoFileLimit(limit: number | null): void;
    private demoFilePaths;
    /** Cumulative counts from all current records, not just the active indexing batch. */
    getIndexSummary(sourcePaths?: string[]): {
        indexed: number;
        errors: number;
        total: number;
        discoveredTotal: number;
        remaining: number;
    };
    getRetryableFiles(sourcePaths: string[]): Map<string, string>;
    getSourceCoverageErrors(sourcePaths: string[]): string[];
    hasPendingIndexWork(): boolean;
    getRetryableErrorCount(sourcePaths: string[]): number;
    private updateRecordCounts;
    private setLatestRecord;
    private indexSearchableText;
    private considerTextSearchRecord;
    private publishTextSearchBatch;
    private onTextSearchProgress;
    private deleteLatestRecord;
    /** Changes whenever any indexed record is added, changed, reindexed or removed. */
    getRevision(): number;
    /** Embedded images with their root and signature, for incremental consumers. */
    getIndexedImageRecords(sourcePaths: string[]): {
        path: string;
        sourcePath: string;
        size: number;
        modified: number;
        signature: string;
    }[];
    private persistDiscoveredTotals;
    getIndexedImages(sourcePaths: string[]): IndexableFile[];
    getIndexedFiles(sourcePaths: string[]): IndexableFile[];
    start(sourcePaths: string[], changedFiles?: Map<string, string>): Promise<void>;
    startFullScan(sourcePaths: string[]): Promise<void>;
    pause(): Promise<void>;
    private holdReason;
    private heldSourcePaths;
    private activeSourcePaths;
    /**
     * Block indexing for a system reason (memory pressure, cache drive missing). Running
     * work stops at its next checkpoint; everything indexed so far is already persisted.
     * Returns the sources that were interrupted or requested while held so the caller
     * can resume them once the hold is released.
     */
    setHold(reason: string | null): Promise<string[]>;
    getHoldReason(): string | null;
    /**
     * Start watching sources for file changes and auto-reconcile the index.
     * This is called automatically on app startup and whenever a new source is added.
     */
    startWatching(sourcePaths: string[]): Promise<void>;
    /**
     * Stop watching all sources for file changes.
     */
    stopWatching(): void;
    /**
     * Reconcile the index with the actual filesystem to detect new, modified, and deleted files.
     * Returns a map of filePath -> sourcePath for files that need to be re-indexed.
     */
    reconcileIndex(sourcePaths: string[], onSourceReady?: (changes: Map<string, string>) => void): Promise<Map<string, string>>;
    private runReconciliation;
    /**
     * Returns true if this is a remote path (phone or cloud) that requires special handling.
     */
    private isRemotePath;
    /**
     * Check if a source folder is currently accessible.
     */
    private isSourceAccessible;
    /**
     * Scan a source specifically for reconciliation (just file list, not full recursive scan).
     */
    private scanSourceForReconciliation;
    /**
     * Schedule reconciliation to run after a debounce period.
     * Prevents excessive reconciliation from rapid file changes.
     */
    private scheduleReconciliation;
    /** True when candidate lies inside a held path (or, with containsHold, a source holds one). */
    private isHeld;
    /**
     * Suspends watcher-driven rescans for a folder that is being bulk-written (phone backups).
     * Release reconciles affected sources once, so new files are indexed exactly one time.
     */
    holdWatchReconciliation(folder: string): void;
    releaseWatchReconciliation(folder: string): void;
    /**
     * Get the current watch status for UI display.
     */
    getWatchStatus(): {
        isWatching: boolean;
        watchedSourceCount: number;
    };
    preloadClipModel(): Promise<void>;
    search(query: string, minimumConfidence: number, sourcePaths: string[], isCancelled?: () => boolean, onSearchProgress?: SearchProgressListener): Promise<SearchResult[]>;
    /**
     * Stream filename and path matches from the loaded index before CLIP finishes
     * embedding or scoring a query.
     */
    searchTextMatches(query: string, sourcePaths: string[], isCancelled?: () => boolean, onMatches?: (matches: IndexableFile[], scanned: number, total: number, capped: boolean) => void): Promise<IndexableFile[]>;
    classifyUnsafeImages(sourcePaths: string[], unsafePrompt: string, safePrompt: string): Promise<string[]>;
    /** CLIP text embeddings for prompts, computed locally. */
    embedPreviewImage(filePath: string): Promise<Float32Array>;
    embedPrompts(prompts: string[]): Promise<Float32Array[]>;
    /** Stored image embeddings for specific paths, read by offset so the whole vector file isn't loaded. */
    getImageVectors(paths: string[]): Promise<Map<string, Float32Array>>;
    /**
     * Assigns a bounded random sample of indexed photos to whichever prompt fits best.
     * Counts reveal what a library is mostly about; matches are best-first per prompt.
     * Reads only sampled vectors by offset and yields regularly to keep main responsive.
     */
    classifyImageConcepts(prompts: string[], sourcePaths: string[], options?: {
        sampleLimit?: number;
        topPerPrompt?: number;
        minimumSimilarity?: number;
        include?: (file: {
            path: string;
            size: number;
        }) => boolean;
    }): Promise<Array<{
        count: number;
        matches: Array<{
            path: string;
            similarity: number;
        }>;
    }>>;
    private runSearch;
    private preservePendingFiles;
    private run;
    private loadClipRuntime;
    private runInference;
    private finishInference;
    private embedText;
    private embedImage;
    private embedImageFile;
    private ensureEmbeddingWorker;
    private failEmbeddingWorker;
    private requestWorkerEmbedding;
    private embedTextFile;
    private extractText;
    private isIndexable;
    private inferType;
    private shouldRetryFailure;
    private signature;
    private loadWorkerRecovery;
    private writeRecoveryFile;
    private persistWorkerFailures;
    private checkpointPendingWork;
    private normalize;
    /**
     * Every index write goes through one chain: concurrent appends raced for the same
     * vector offset, and a kill mid-line glued the next record onto a partial one.
     */
    private appendLines;
    private serializeWrite;
    /** A partial line left by a crash is isolated so it can never swallow the next record. */
    private ensureRecordsLineBoundary;
    /** Resolves once queued index writes are on disk; used before quitting. */
    flushWrites(): Promise<void>;
    private appendRecord;
    private appendFailure;
    private createRecord;
    private loadRecords;
    private updateProgress;
    private emitProgress;
    private persistProgress;
}
export {};
