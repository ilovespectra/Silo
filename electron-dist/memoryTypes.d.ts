export type MemoryMood = "gentle" | "bright" | "energetic" | "dramatic";
export interface MemoryMedia {
    path: string;
    name: string;
    type: "image" | "video";
    modified: number;
    thumbnailUrl?: string | null;
    liveVideoPath?: string;
}
export interface MemorySuggestion {
    id: string;
    title: string;
    description: string;
    query: string;
    mood: MemoryMood;
    /** Memories are always rendered as one-minute movies. */
    defaultDuration?: number;
    /** Discovery key (e.g. "place:croatia"), used to rotate story ideas. */
    storyKey?: string;
    /** Library song picked for this story; previews and exports default to it. */
    soundtrackId?: string;
    media: MemoryMedia[];
    createdAt: number;
    downloadedAt?: number;
}
export interface MemorySoundtrack {
    id: string;
    name: string;
    path?: string;
    source: "original" | "library";
    rights: string;
}
export interface MemorySettings {
    showOnLaunch: boolean;
    /** Folder for saved memory movies; null keeps them in Silo's app storage. */
    movieDirectory?: string | null;
}
export interface MemoryState {
    suggestions: MemorySuggestion[];
    settings: MemorySettings;
    generating: boolean;
    message: string;
    /** Saved stories waiting in reserve; playable even when their source is offline. */
    reserveCount?: number;
    /** Background movie status per suggestion id. */
    previews?: Record<string, MemoryPreviewStatus>;
}
export interface MemoryPreviewStatus {
    status: "queued" | "rendering" | "ready" | "failed";
    /** 0..1 while rendering. */
    progress?: number;
    etaSeconds?: number;
}
export type MemoryAudioSort = "name" | "modified" | "size";
export interface MemoryAudioBrowseRequest {
    /** Omit to list sources (or search every source). */
    sourceId?: string;
    /** Folder relative to the source root; "" is the root. */
    folder?: string;
    query?: string;
    sort?: MemoryAudioSort;
    direction?: "asc" | "desc";
    offset?: number;
    limit?: number;
}
export interface MemoryAudioBrowseFile {
    /** Soundtrack id usable for export and as a memory's song. */
    id: string;
    name: string;
    path: string;
    sourceId: string;
    sourceLabel: string;
    folder: string;
    size: number;
    modified: number;
}
export interface MemoryAudioBrowseResult {
    sources: {
        id: string;
        label: string;
        count: number;
    }[];
    folders: {
        name: string;
        path: string;
        count: number;
    }[];
    files: MemoryAudioBrowseFile[];
    /** Matching files before paging. */
    total: number;
}
export interface MemoryExportOptions {
    suggestionId: string;
    count: number;
    duration: number;
    soundtrackId: string;
    originalAudio: number;
    /** True only when the user explicitly acknowledged rights for a library track. */
    rightsAcknowledged?: boolean;
}
export declare const MEMORY_DURATION_SECONDS = 60;
export declare const MEMORY_EXPORT_LIMITS: {
    readonly minCount: 1;
    readonly maxCount: 24;
    readonly minDuration: 60;
    readonly maxDuration: 60;
};
export declare const MEMORY_DEFAULT_SELECTION_COUNT = 20;
export declare const MEMORY_MAGIC_SCORE_THRESHOLD = 90;
export declare function selectMemoryPhotoCandidates<T extends {
    score: number;
    magicScore?: number;
}>(candidates: T[]): T[];
export declare function getMemoryDurationBounds(_count: number): {
    min: number;
    max: number;
};
export declare function getDefaultMemoryDuration(_count: number): number;
export declare function isMemoryDurationAllowed(_count: number, duration: number): boolean;
export interface MemoryExportProgress {
    phase: "preparing" | "rendering" | "mixing" | "complete" | "cancelled" | "error";
    suggestionId: string;
    completed: number;
    total: number;
    message: string;
}
export interface MemoriesAPI {
    getMemories(prepareViews?: boolean): Promise<MemoryState>;
    generateMemories(replace?: boolean, customTopic?: string): Promise<MemoryState>;
    dismissMemory(id: string): Promise<MemoryState>;
    updateMemorySettings(settings: Partial<MemorySettings>): Promise<MemoryState>;
    selectMemoryDirectory(): Promise<MemoryState>;
    getMemorySoundtracks(id: string): Promise<MemorySoundtrack[]>;
    /** In-app audio explorer over the indexed audio library. */
    browseMemoryAudio?(request: MemoryAudioBrowseRequest): Promise<MemoryAudioBrowseResult>;
    /** Makes a library song this memory's soundtrack; its movie re-renders in the background. */
    setMemorySoundtrack?(id: string, soundtrackId: string): Promise<MemoryState>;
    viewMemory(id: string): Promise<{
        ok: boolean;
        path?: string;
        error?: string;
        preparing?: boolean;
        upgradeRequired?: boolean;
    }>;
    exportMemory(options: MemoryExportOptions): Promise<{
        ok: boolean;
        canceled?: boolean;
        path?: string;
        error?: string;
    }>;
    cancelMemoryExport(): Promise<void>;
    onMemoryExportProgress(callback: (progress: MemoryExportProgress) => void): () => void;
    /** Optional so older bridges keep working; cards fall back to polling state. */
    onMemoryPreviewProgress?(callback: (previews: Record<string, MemoryPreviewStatus>) => void): () => void;
}
