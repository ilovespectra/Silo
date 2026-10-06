export interface CachedAudioFile {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    modified: number;
    isDirectory: boolean;
    type: string;
    extension: string;
    sourceId?: string;
    sourceLabel?: string;
}
export interface AudioLibraryCacheSnapshot {
    version: 1;
    sourceIds: string[];
    scannedAt: number;
    files: CachedAudioFile[];
    extensions: string[];
    stale?: boolean;
    failedSources?: string[];
    sourceScannedAt?: Record<string, number>;
    sourceCooldownUntil?: Record<string, number>;
    sourceErrors?: Record<string, {
        message: string;
        lastAttemptAt: number;
    }>;
}
export interface AudioLibraryScanProgress {
    source: string;
    scanned: number;
    audioFound: number;
    sourceIndex: number;
    sourceCount: number;
    phase: "scanning" | "retrying" | "cooldown" | "source-complete";
    message: string;
}
export declare class AudioLibraryCache {
    private cachePath;
    private snapshot;
    private scanPromise;
    private cancelled;
    private sourceCooldowns;
    constructor(userDataPath: string);
    initialize(): Promise<void>;
    getSnapshot(): AudioLibraryCacheSnapshot;
    cancelScan(): void;
    scan(sources: Array<{
        id: string;
        rootPath: string;
        kind: string;
        label: string;
    }>, isRemotePath: (value: string) => boolean, isAudio: (fileName: string) => boolean, listRemoteFiles: (source: {
        id: string;
        rootPath: string;
        kind: string;
        label: string;
    }) => Promise<CachedAudioFile[]>, onProgress: (progress: AudioLibraryScanProgress) => void, force?: boolean): Promise<AudioLibraryCacheSnapshot>;
    private scanImpl;
    private persistSnapshot;
}
