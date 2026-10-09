import type { SearchPerformanceSettings } from "./contentSettings";
export type VectorSearchKind = "image" | "document";
export interface VectorSearchGroup {
    sourcePath: string;
    kind: VectorSearchKind;
    keys: BigUint64Array;
}
export interface VectorSearchHit {
    key: number;
    confidence: number;
}
export declare class PersistedVectorIndex {
    private readonly vectorsPath;
    private readonly cacheDirectory;
    private readonly onProgress;
    private readonly onError;
    private settings;
    private readonly worker;
    private nextRequestId;
    private readonly pending;
    private resolveReady;
    private rejectReady;
    private readonly ready;
    private failed;
    private readySettled;
    private closing;
    constructor(vectorsPath: string, cacheDirectory: string, onProgress: (fraction: number, records: number) => void, onError: (error: Error) => void, settings: SearchPerformanceSettings);
    initialize(groups: VectorSearchGroup[]): Promise<void>;
    search(sourcePaths: string[], imageQuery: Float32Array, documentQuery: Float32Array, limit: number): Promise<VectorSearchHit[]>;
    setPaused(paused: boolean): void;
    updateSettings(settings: SearchPerformanceSettings): void;
    upsert(sourcePath: string, kind: VectorSearchKind, key: number): void;
    remove(sourcePath: string, kind: VectorSearchKind, key: number): void;
    shutdown(timeoutMs: number): Promise<void>;
    private request;
    private fail;
}
