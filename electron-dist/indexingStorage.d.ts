export declare function setActiveIndexStorageRoot(storageRoot: string): void;
export declare function getActiveIndexStorageRoot(): string;
export declare function readIndexStorageRoot(userDataPath: string): Promise<string>;
export declare function writeIndexStorageRoot(userDataPath: string, storageRoot: string): Promise<void>;
export declare function stageIndexStorageRoot(userDataPath: string, storageRoot: string): Promise<boolean>;
export declare const INDEX_STORAGE_ENTRIES: readonly ["semantic-index", "face-index", "pets", "thumbnail-cache", "preview-cache", "media-cache", "memory-image-cache", "cloud-cache", "geo-index.jsonl", "geocode-cache.json", "geocode-search-cache.json", "duplicate-index.json", "aesthetic-index.jsonl", "content-safety-index.json", "audio-library-index.json", "library-stats.json"];
export interface IndexStorageMigrationResult {
    filesVerified: number;
    bytesVerified: number;
}
type ProgressListener = (filesVerified: number, bytesVerified: number) => void;
export declare function validateIndexStorageDestination(userDataPath: string, storageRoot: string): Promise<{
    requiredBytes: number;
}>;
export declare function migrateIndexStorageEntries(userDataPath: string, storageRoot: string, entries?: readonly string[], onProgress?: ProgressListener): Promise<IndexStorageMigrationResult>;
export declare function prepareExternalIndexStorage(userDataPath: string, storageRoot: string, onProgress?: ProgressListener): Promise<IndexStorageMigrationResult>;
export declare function prepareConfiguredIndexStorage(userDataPath: string, onProgress?: ProgressListener): Promise<{
    storageRoot: string;
    filesVerified: number;
    bytesVerified: number;
}>;
export {};
