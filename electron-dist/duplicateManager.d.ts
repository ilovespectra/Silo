import type { IndexableFile } from "./semanticIndexer";
export interface DuplicateFile extends IndexableFile {
    hash: string;
    sourceId: string;
}
export interface DuplicateGroup {
    id: string;
    sourceId: string;
    hash: string;
    size: number;
    reclaimableBytes: number;
    keepPath: string;
    files: DuplicateFile[];
}
export interface DuplicateTrashEntry {
    id: string;
    originalPath: string;
    trashPath: string;
    size: number;
    hash: string;
    deletedAt: number;
}
export interface DuplicateState {
    status: "idle" | "scanning" | "paused" | "complete" | "error";
    scanned: number;
    total: number;
    duplicateFiles: number;
    reclaimableBytes: number;
    trashBytes: number;
    permanentlyClearedBytes: number;
    message: string;
    groups: DuplicateGroup[];
    trash: DuplicateTrashEntry[];
}
type Listener = (state: DuplicateState) => void;
export declare class DuplicateManager {
    private readonly indexPath;
    private readonly trashManifestPath;
    private readonly trashDirectory;
    private readonly listener;
    private readonly hashes;
    private readonly retryableFailures;
    private groups;
    private trash;
    private permanentlyClearedBytes;
    private scanPromise;
    private pauseRequested;
    private prunePromise;
    private writeChain;
    private state;
    constructor(userDataPath: string, listener?: Listener, indexStoragePath?: string);
    initialize(): Promise<void>;
    /** Drops files that no longer exist so removed copies don't linger as stale groups. */
    pruneMissing(): Promise<boolean>;
    private runPruneMissing;
    getState(): DuplicateState;
    getRetryableFailureCount(): number;
    scan(files: IndexableFile[], sourceRoots?: string[]): Promise<DuplicateState>;
    pause(): Promise<void>;
    quarantine(groupIds: string[]): Promise<DuplicateState>;
    quarantineFiles(filePaths: string[]): Promise<DuplicateState>;
    private matchesHash;
    restore(ids: string[]): Promise<DuplicateState>;
    clearTrash(ids?: string[]): Promise<DuplicateState>;
    private runScan;
    private hashFile;
    private move;
    private recalculate;
    private emit;
    private persistIndex;
    private persistTrash;
    /** Writes run one at a time, each via its own temp file, so overlapping saves can't clobber each other. */
    private writeAtomic;
}
export {};
