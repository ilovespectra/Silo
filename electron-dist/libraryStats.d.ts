export type LibraryCategory = "image" | "video" | "audio" | "document" | "archive" | "other";
export type CategoryCounts = Record<LibraryCategory, {
    files: number;
    bytes: number;
}>;
export interface LibraryStatsSourceInput {
    id: string;
    label: string;
    kind: string;
    rootPath: string;
    available: boolean;
    offlineBackup?: boolean;
    snapshotAt?: number;
    message?: string;
}
export interface LibraryStatsFile {
    path: string;
    relativePath: string;
    size: number;
    modified: number;
    type: string;
    isDirectory: boolean;
}
type ScanSource = (sourcePath: string, onFile: (file: LibraryStatsFile) => void, isCancelled: () => boolean) => Promise<void>;
export interface LibraryStatsSource extends LibraryStatsSourceInput {
    status: "scanning" | "ready" | "offline" | "pending" | "error";
    scannedAt: number;
    fileCount: number | null;
    totalBytes: number | null;
    unknownSizeFiles: number | null;
    categories: CategoryCounts;
    fingerprint: string | null;
    error: string;
    overlapsAnotherSource: boolean;
    stale: boolean;
}
export interface LibraryStatsSnapshot {
    running: boolean;
    progress: {
        currentSourceId: string | null;
        currentSource: string;
        sourceIndex: number;
        sourceCount: number;
        scannedEntries: number;
        currentSourceFiles: number;
        message: string;
    };
    totals: {
        fileCount: number;
        totalBytes: number;
        unknownSizeFiles: number;
        categories: CategoryCounts;
        sourceCount: number;
        uniqueSourceCount: number;
        staleSourceCount: number;
        lastInventoryAt: number;
    };
    sources: LibraryStatsSource[];
}
export declare class LibraryStatsManager {
    private readonly cachePath;
    private readonly scanSource;
    private readonly onUpdate;
    private readonly inventories;
    private readonly errors;
    private currentSources;
    private queuedSources;
    private runPromise;
    private progress;
    constructor(userDataPath: string, scanSource: ScanSource, onUpdate?: (snapshot: LibraryStatsSnapshot) => void);
    initialize(): Promise<void>;
    requestRefresh(sources: LibraryStatsSourceInput[]): LibraryStatsSnapshot;
    waitForIdle(): Promise<void>;
    getSnapshot(sources?: LibraryStatsSourceInput[]): LibraryStatsSnapshot;
    private runBatches;
    private scanBatch;
    private persist;
    private publish;
}
export {};
