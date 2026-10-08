import type { GeocodedLocation } from "./geocoder";
export interface PersistedUiState {
    currentPath: string | null;
    exploded: boolean;
    sortField: "name" | "size" | "modified" | "type" | "source" | "magic" | "people" | "mapped";
    sortAscending: boolean;
    includedType: string;
    viewMode: "list" | "grid";
    showFilters: boolean;
    confidence: number;
}
export interface IndexSource {
    path: string;
    addedAt: number;
}
export interface DigitalFolder {
    id: string;
    name: string;
    filePaths: string[];
    createdAt: number;
    hidden?: boolean;
}
export declare const FAVORITES_FOLDER_ID = "__favorites__";
export declare const REFUSE_FOLDER_ID = "__refuse__";
export interface NameIndexEntry {
    name: string;
    filePaths: {
        path: string;
        confirmed: boolean;
    }[];
    addedAt: number;
    sourceType: "person" | "pet" | "manual";
    sourceId?: string;
}
export interface FileMetadata {
    displayName?: string;
    year?: number;
    keywords: string[];
    updatedAt: number;
}
export interface GeoFileSnapshot {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    modified: number;
    isDirectory: false;
    type: string;
    extension: string;
    sourcePath: string;
}
export interface GeoOverride {
    file: GeoFileSnapshot;
    location: GeocodedLocation;
    updatedAt: number;
}
export interface PersistedAppState {
    version: 1;
    ui: PersistedUiState;
    indexSources: IndexSource[];
    digitalFolders: DigitalFolder[];
    nameIndex: NameIndexEntry[];
    fileMetadata: Record<string, FileMetadata>;
    geoOverrides: Record<string, GeoOverride>;
    /** Sources are enabled by default, so only exclusions are stored. */
    disabledSourceIds: string[];
    /** Explicitly enabled IDs override context-dependent defaults for snapshots. */
    enabledSourceIds: string[];
}
export declare class StateStore {
    private readonly filePath;
    private state;
    private writeChain;
    constructor(userDataPath: string);
    initialize(): Promise<void>;
    getState(): PersistedAppState;
    /** Search reads this small live view instead of cloning the full library state. */
    getSearchState(): Pick<PersistedAppState, "digitalFolders" | "nameIndex" | "fileMetadata">;
    updateUi(update: Partial<PersistedUiState>): Promise<PersistedAppState>;
    addIndexSource(sourcePath: string): Promise<PersistedAppState>;
    removeIndexSource(sourcePath: string): Promise<PersistedAppState>;
    setSourceEnabled(sourceId: string, enabled: boolean): Promise<PersistedAppState>;
    setAllSourcesEnabled(sourceIds: string[], enabled: boolean): Promise<PersistedAppState>;
    createDigitalFolder(name: string): Promise<PersistedAppState>;
    renameDigitalFolder(folderId: string, name: string): Promise<PersistedAppState>;
    moveDigitalFolder(sourceId: string, targetId: string, after: boolean): Promise<PersistedAppState>;
    deleteDigitalFolder(folderId: string): Promise<PersistedAppState>;
    setDigitalFolderHidden(folderId: string, hidden: boolean): Promise<PersistedAppState>;
    addDigitalFolderReference(folderId: string, filePath: string): Promise<PersistedAppState>;
    addDigitalFolderReferences(folderId: string, filePaths: string[]): Promise<PersistedAppState>;
    removeDigitalFolderReference(folderId: string, filePath: string): Promise<PersistedAppState>;
    updateNameIndex(name: string, filePaths: string[], sourceType: "person" | "pet" | "manual", sourceId?: string): Promise<PersistedAppState>;
    confirmNameFile(name: string, filePath: string): Promise<PersistedAppState>;
    rejectNameFile(name: string, filePath: string): Promise<PersistedAppState>;
    updateFileMetadata(filePaths: string[], update: {
        displayName?: string | null;
        keywords?: string[];
        mergeKeywords?: boolean;
        year?: number | null;
    }): Promise<PersistedAppState>;
    setGeoOverrides(files: GeoFileSnapshot[], location: GeocodedLocation): Promise<PersistedAppState>;
    clearGeoOverrides(filePaths: string[]): Promise<PersistedAppState>;
    private write;
}
