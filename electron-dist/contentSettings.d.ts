export interface ContentPreferences {
    showNsfw: boolean;
    safeSearch: boolean;
    theme: "system" | "dark" | "light";
    autoplayGlobe: boolean;
    showBannedPeople: boolean;
}
export interface PublicContentSettings extends ContentPreferences {
    parentalPasswordSet: boolean;
}
export declare class ContentSettingsStore {
    private readonly filePath;
    private settings;
    private writeChain;
    constructor(userDataPath: string);
    initialize(): Promise<void>;
    getPublicSettings(): PublicContentSettings;
    setParentalPassword(currentPassword: string, newPassword: string): Promise<PublicContentSettings>;
    updatePreferences(update: Partial<ContentPreferences>, password?: string): Promise<PublicContentSettings>;
    private verify;
    private persist;
}
