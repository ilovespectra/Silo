export interface GoogleConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}
export interface GoogleAccountSummary {
    id: string;
    email: string;
    driveRootPath: string;
    photosRootPath: string;
    pickedCount: number;
    needsReauth: boolean;
}
export interface GoogleAccountsState {
    configured: boolean;
    accounts: GoogleAccountSummary[];
    allDrivesPath: string;
    allPhotosPath: string;
    totalPickedCount: number;
    message: string;
}
export interface CloudFileInfo {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    modified: number;
    isDirectory: boolean;
    type: string;
    extension: string;
}
export declare function loadGoogleEnv(envPath: string): Promise<GoogleConfig | null>;
export declare class GoogleManager {
    private config;
    private accounts;
    private pickedItems;
    private accountsPath;
    private cacheRoot;
    private authServer;
    constructor(userDataPath: string, cacheRoot?: string);
    initialize(config: GoogleConfig | null): Promise<void>;
    getState(): GoogleAccountsState;
    addAccount(): Promise<GoogleAccountsState>;
    private waitForAuthCode;
    private closeAuthServer;
    removeAccount(accountId: string): Promise<GoogleAccountsState>;
    private persist;
    private accessToken;
    private fetchEmail;
    private apiFetch;
    isCloudPath(candidate: string): boolean;
    private buildPath;
    private parseCloudPath;
    listFiles(virtualPath: string, exploded: boolean): Promise<CloudFileInfo[]>;
    /** Lists files and directories with complete paths relative to the selected source. */
    listFilesRecursively(virtualPath: string, onFile?: (file: CloudFileInfo) => void, isCancelled?: () => boolean): Promise<CloudFileInfo[]>;
    /** The aggregate view shows one folder per connected account. */
    private listAllDriveRoots;
    private listAllPickedPhotos;
    private listDriveChildren;
    private listDriveRecursive;
    createDriveFolder(parentPath: string, name: string): Promise<void>;
    renameDriveFile(filePath: string, name: string): Promise<void>;
    trashDriveFile(filePath: string): Promise<void>;
    uploadToDrive(parentPath: string, localPath: string): Promise<void>;
    startPhotoPicker(accountId: string): Promise<{
        pickerUri: string;
        sessionId: string;
        accountId: string;
    }>;
    pollPhotoPicker(accountId: string, sessionId: string): Promise<{
        ready: boolean;
        count: number;
    }>;
    private collectPickedItems;
    private listPickedPhotos;
    clearPickedPhotos(accountId?: string): void;
    /** Downloads a cloud file into the local cache so normal file code paths work. */
    materialize(virtualPath: string): Promise<string>;
    private fetchPickedPhoto;
    private fetchDriveFile;
    statCloudFile(virtualPath: string): Promise<CloudFileInfo | null>;
}
