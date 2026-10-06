import { MemoryAudioBrowseRequest, MemoryAudioBrowseResult, MemoryMedia, MemoryMood, MemorySettings, MemorySoundtrack, MemoryState, MemorySuggestion } from "./memoryTypes";
export interface MemoryAudioFile {
    name: string;
    path: string;
    sourceLabel?: string;
    size?: number;
    modified?: number;
    sourceId?: string;
    /** Path relative to its source root, used for folder browsing. */
    relativePath?: string;
}
/** Main supplies ready, safety-filtered, all-source search and the cached audio index.
 * Never implement these callbacks by scanning the inventory inside this manager.
 */
export interface MemoryManagerDependencies {
    search(query: string): Promise<MemoryMedia[]>;
    /** Magic's ordered image filter removes shots above the duplicate-similarity threshold. */
    filterImages?(paths: string[]): Promise<string[]>;
    thumb(path: string): string | null | undefined | Promise<string | null | undefined>;
    listAudio(): MemoryAudioFile[] | Promise<MemoryAudioFile[]>;
    isAllowed(path: string): boolean | Promise<boolean>;
    findLiveVideo?(file: MemoryMedia): Promise<string | null | undefined>;
    /** Story ideas mined from the library (time, places, people, pets, subjects, folders). */
    discover?(): Promise<MemoryStoryCandidate[]>;
}
export interface MemoryStoryCandidate {
    key: string;
    title: string;
    description: string;
    query: string;
    mood: MemoryMood;
    /** Loaded lazily; only ideas actually tried pay for vector reads. */
    load(): Promise<(MemoryMedia & {
        score?: number;
    })[]>;
}
/** Constructor is deliberately Electron-free: pass app.getPath("userData") from main. */
export declare class MemoryManager {
    private readonly deps;
    private readonly statePath;
    private state;
    private cursor;
    private reserve;
    private audioIndex?;
    private recentKeys;
    private dismissed;
    private initialization?;
    private generation?;
    private writes;
    constructor(userDataPath: string, deps: MemoryManagerDependencies);
    initialize(): Promise<void>;
    private allowed;
    private safeMedia;
    /** Drops photos above the duplicate-similarity ceiling; null when that cannot be verified. */
    private distinctImages;
    /** Stored cards were de-duplicated when built; only safety is re-checked, so a
     * disconnected source or a busy similarity service never hides saved stories. */
    private visible;
    private visibleSuggestions;
    private visibleReserve;
    private parseCards;
    private load;
    private persist;
    getState(): Promise<MemoryState>;
    /** Reserve stories, so main can pre-render their movies for offline viewing. */
    getReserve(): Promise<MemorySuggestion[]>;
    generate(replace?: boolean, customTopic?: string): Promise<MemoryState>;
    /**
     * The archive's topics changed: rotate the oldest saved extras so the next suggestions
     * reflect it, without touching visible cards or the offline-playable minimum.
     */
    refreshForProfileChange(): Promise<MemoryState>;
    /** Turns ranked hits into one story, or null when fewer than four distinct allowed photos remain. */
    private buildCard;
    private generateOnce;
    /** Gives each story without a song its own track, distinct from the other stories' songs and artists. */
    private assignSoundtracks;
    dismiss(id: string): Promise<MemoryState>;
    private applySettings;
    updateSettings(settings: Partial<MemorySettings>): Promise<MemoryState>;
    getSuggestion(id: string): Promise<MemorySuggestion | undefined>;
    getSettings(): Promise<MemorySettings>;
    markDownloaded(id: string): Promise<MemoryState>;
    private original;
    /** Music pool for one generation, so each story is scored against the same snapshot. */
    private musicPool;
    /**
     * Picks a song whose artist/album/title echoes the story (place, subject, folder names)
     * or its mood, with variety: never a song or artist another current story already uses.
     */
    private pickSoundtrack;
    /**
     * Folder-by-folder (or searched) view of the indexed audio library, for the in-app
     * song explorer. Only one page of files is returned and every file is safety-checked.
     */
    browseAudio(request?: MemoryAudioBrowseRequest): Promise<MemoryAudioBrowseResult>;
    /** Use a library song for this memory; returns undefined when the card or song is gone. */
    setSoundtrack(id: string, soundtrackId: string): Promise<MemorySuggestion | undefined>;
    getSoundtracks(id: string): Promise<MemorySoundtrack[]>;
    /** Resolve only IDs minted from the current audio index, never accept an arbitrary path.
     * This validates availability/safety, NOT licensing. Export must separately obtain rights approval.
     */
    resolveSoundtrack(soundtrackId: string, suggestionId?: string): Promise<MemorySoundtrack | undefined>;
}
