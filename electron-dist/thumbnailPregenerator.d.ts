export interface ThumbnailPregenProgress {
    status: "idle" | "waiting" | "scanning" | "generating" | "complete" | "error";
    total: number;
    processed: number;
    generated: number;
    failed: number;
    message: string;
}
interface Dependencies {
    /** Enabled local, phone, and cloud source roots. */
    getSourceRoots: () => Promise<string[]>;
    isMedia: (fileName: string) => boolean;
    isRemotePath: (sourcePath: string) => boolean;
    listRemoteMediaFiles: (sourcePath: string) => Promise<string[]>;
    /** Renders and caches one thumbnail; resolves false when it could not be produced. */
    generate: (filePath: string) => Promise<boolean>;
    /** True while user-visible thumbnail requests are waiting, so background work yields. */
    isInteractiveBusy: () => boolean;
    /** Returns a message while CLIP, face clustering, or location indexing is active. */
    getIndexingWaitMessage: () => string | null;
    onProgress: (progress: ThumbnailPregenProgress) => void;
}
export declare class ThumbnailPregenerator {
    private readonly deps;
    private progress;
    private runPromise;
    private rerunRequested;
    private lastEmit;
    constructor(deps: Dependencies);
    getProgress(): {
        status: "error" | "idle" | "scanning" | "complete" | "waiting" | "generating";
        total: number;
        processed: number;
        generated: number;
        failed: number;
        message: string;
    };
    setWaiting(message: string): void;
    start(): Promise<void>;
    private run;
    private collect;
    private update;
}
export {};
