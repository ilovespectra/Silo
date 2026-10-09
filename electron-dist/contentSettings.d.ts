export interface ContentPreferences {
    showNsfw: boolean;
    safeSearch: boolean;
    theme: "system" | "dark" | "light";
    autoplayGlobe: boolean;
    preloadMapTextures: boolean;
    showBannedPeople: boolean;
}
export interface PublicContentSettings extends ContentPreferences {
    parentalPasswordSet: boolean;
}
export interface SearchPerformanceSettings {
    searchThreads: number;
    indexThreads: number;
    backgroundWorkPercent: number;
}
export interface SearchPerformanceMachineInfo {
    processor: string;
    logicalProcessors: number;
    availableProcessors: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    platform: string;
    architecture: string;
}
export interface SearchPerformanceSnapshot {
    settings: SearchPerformanceSettings;
    machine: SearchPerformanceMachineInfo;
}
export declare function getSearchPerformanceMachineInfo(): SearchPerformanceMachineInfo;
export declare function defaultSearchPerformanceSettings(availableProcessors?: number): SearchPerformanceSettings;
export declare class ContentSettingsStore {
    private readonly filePath;
    private settings;
    private writeChain;
    constructor(userDataPath: string);
    initialize(): Promise<void>;
    getPublicSettings(): PublicContentSettings;
    getSearchPerformanceSnapshot(): SearchPerformanceSnapshot;
    updateSearchPerformanceSettings(update: unknown): Promise<SearchPerformanceSnapshot>;
    setParentalPassword(currentPassword: string, newPassword: string): Promise<PublicContentSettings>;
    updatePreferences(update: Partial<ContentPreferences>, password?: string): Promise<PublicContentSettings>;
    private verify;
    private persist;
}
