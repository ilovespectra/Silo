export declare const LOCAL_INDEX_STORAGE_RESERVE_BYTES: number;
export declare function getLocalIndexStorageFreeBytes(storageRoot: string): Promise<number>;
export declare function assertLocalIndexStorageCapacity(storageRoot: string, additionalBytes?: number): Promise<number>;
export declare function setActiveIndexStorageRoot(storageRoot: string): void;
export declare function setIndexStorageExclusionRoots(storageRoots: readonly string[]): void;
export declare function getIndexStorageExclusionRoots(): string[];
export declare function getLocalFallbackIndexStorageRoot(userDataPath: string): string;
export declare function getActiveIndexStorageRoot(): string;
export declare function createIndexStoragePathResolver(getStorageRoot: () => string): (...segments: string[]) => string;
export declare function readIndexStorageRoot(userDataPath: string): Promise<string>;
export declare function getIndexStorageSettings(userDataPath: string): Promise<{
    path: string;
    allowLocalFallback: boolean;
}>;
export declare function setLocalIndexStorageFallback(userDataPath: string, enabled: boolean): Promise<boolean>;
export declare function writeIndexStorageRoot(userDataPath: string, storageRoot: string): Promise<void>;
export declare function stageIndexStorageRoot(userDataPath: string, storageRoot: string): Promise<boolean>;
export declare const INDEX_STORAGE_ENTRIES: readonly ["semantic-index", "face-index", "pets", "thumbnail-cache", "preview-cache", "media-cache", "memory-image-cache", "cloud-cache", "geo-index.jsonl", "geocode-cache.json", "geocode-search-cache.json", "duplicate-index.json", "aesthetic-index.jsonl", "content-safety-index.json", "audio-library-index.json", "library-stats.json"];
export interface IndexStorageMigrationResult {
    filesVerified: number;
    bytesVerified: number;
}
type ProgressListener = (filesVerified: number, bytesVerified: number) => void;
export declare class ExternalIndexStorageUnavailableError extends Error {
    readonly storageRoot: string;
    constructor(storageRoot: string);
}
export declare function validateIndexStorageDestination(userDataPath: string, storageRoot: string): Promise<{
    requiredBytes: number;
}>;
export declare function migrateIndexStorageRoots(sourceRoots: readonly string[], storageRoot: string, entries?: readonly string[], onProgress?: ProgressListener, beforeSourceRemoval?: () => Promise<void>): Promise<IndexStorageMigrationResult>;
export declare function migrateIndexStorageEntries(userDataPath: string, storageRoot: string, entries?: readonly string[], onProgress?: ProgressListener): Promise<IndexStorageMigrationResult>;
export declare function prepareExternalIndexStorage(userDataPath: string, storageRoot: string, onProgress?: ProgressListener): Promise<IndexStorageMigrationResult>;
export declare function prepareConfiguredIndexStorage(userDataPath: string, onProgress?: ProgressListener): Promise<{
    storageRoot: string;
    selectedStorageRoot: string;
    usingLocalFallback: boolean;
    destinationAvailable: boolean;
    localFallbackEnabled: boolean;
    migrationCompleted: boolean;
    migrationError: string | null;
    filesVerified: number;
    bytesVerified: number;
}>;
export {};
