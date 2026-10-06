export type PhonePlatform = "ios" | "android";
export type PhoneStatus = "ready" | "untrusted" | "unauthorized" | "offline" | "connected" | "error";
export interface PhoneDevice {
    id: string;
    platform: PhonePlatform;
    name: string;
    model: string | null;
    status: PhoneStatus;
    rootPath: string | null;
    message: string;
}
export interface PhoneToolingEntry {
    available: boolean;
    missing: string[];
    installHint: string;
}
export interface PhoneTooling {
    ios: PhoneToolingEntry;
    android: PhoneToolingEntry;
}
export interface PhoneFileInfo {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    modified: number;
    isDirectory: boolean;
    type: string;
    extension: string;
}
export interface PhoneBackupProgress {
    deviceId: string;
    platform: PhonePlatform;
    deviceName: string;
    status: "idle" | "scanning" | "backing-up" | "complete" | "error";
    totalFiles: number;
    completedFiles: number;
    totalBytes: number;
    completedBytes: number;
    copiedFiles: number;
    failedFiles: number;
    currentFile: string | null;
    message: string;
    lastBackupAt: number | null;
}
export interface OfflinePhoneBackup {
    id: string;
    snapshotId: string;
    platform: PhonePlatform;
    name: string;
    rootPath: string;
    snapshotAt: number;
    totalFiles: number;
    failedFiles: number;
}
export interface PhoneRestoreArchive {
    id: string;
    deviceId: string;
    platform: "ios";
    deviceName: string;
    deviceModel: string | null;
    backupRoot?: string;
    archivePath: string;
    createdAt: number;
    encrypted: true;
}
export declare class PhoneManager {
    private binaries;
    private pullCacheRoot;
    private adbServerStarted;
    private readonly backupStatePath;
    private readonly backupDestinationConfigPath;
    private readonly onBackupProgress;
    private readonly backupManifests;
    private connectedDeviceKeys;
    private readonly backupJobs;
    private backupWriteChain;
    private backupDestinationPath;
    private deviceNames;
    private deviceNameWrites;
    private namedDevice;
    renameDevice(deviceId: string, platform: PhonePlatform, name: string): Promise<string>;
    private activeRunCount;
    private readonly MAX_CONCURRENT_RUNS;
    private runQueue;
    constructor(userDataPath: string, onBackupProgress?: (progress: PhoneBackupProgress) => void);
    private trace;
    private log;
    private logError;
    private queueRun;
    private processRunQueue;
    initialize(): Promise<void>;
    getBackupStates(): {
        deviceId: string;
        platform: PhonePlatform;
        deviceName: string;
        status: "error" | "idle" | "scanning" | "complete" | "backing-up";
        totalFiles: number;
        completedFiles: number;
        totalBytes: number;
        completedBytes: number;
        copiedFiles: number;
        failedFiles: number;
        currentFile: string | null;
        message: string;
        lastBackupAt: number | null;
    }[];
    /** Local folder holding a device's backed-up files, when a backup exists. */
    getBackupRoot(platform: PhonePlatform, deviceId: string): string | null;
    getOfflineBackups(): Promise<OfflinePhoneBackup[]>;
    private hasSnapshotFile;
    private isSnapshotComplete;
    getRestoreArchives(): Promise<PhoneRestoreArchive[]>;
    private getRegisteredArchivePath;
    private readRestoreArchivePlistString;
    private replaceRestoreArchivePlistString;
    private compareProductVersions;
    private cloneRestoreArchiveForDevice;
    private verifyEncryptedRestoreArchive;
    createRestoreArchive(device: PhoneDevice, password: string): Promise<PhoneRestoreArchive>;
    restoreDeviceFromArchive(device: PhoneDevice, archiveId: string, password: string): Promise<void>;
    setBackupDestination(destination: string | null): Promise<string | null>;
    getBackupDestination(): Promise<string | null>;
    backupDevice(device: PhoneDevice): Promise<PhoneBackupProgress>;
    private runBackup;
    private createBrowseableSnapshot;
    private updateBackup;
    private emptyBackupProgress;
    private deviceKey;
    private formatBytes;
    private localCachePath;
    private persistBackupState;
    private resolveBinary;
    private run;
    private runLongOperation;
    getTooling(): Promise<PhoneTooling>;
    listDevices(): Promise<PhoneDevice[]>;
    private listIosDevices;
    private listAndroidDevices;
    connect(deviceId: string, platform: PhonePlatform): Promise<PhoneDevice>;
    private connectIos;
    private connectAndroid;
    disconnect(): Promise<void>;
    unmountAll(): Promise<void>;
    virtualPath(platform: PhonePlatform, deviceId: string, remotePath: string, offlineBackup?: boolean, snapshotId?: string): string;
    isPhonePath(candidate: string): boolean;
    parsePhonePath(candidate: string): {
        platform: PhonePlatform;
        deviceId: string;
        remotePath: string;
        offlineBackup: boolean;
        snapshotId: string | null;
    } | null;
    listPhoneFiles(virtualPath: string, exploded: boolean): Promise<PhoneFileInfo[]>;
    private listingIndexes;
    /**
     * Directory tree over a backup manifest, built once per manifest revision. Listing a
     * folder used to walk (and parse) every manifest entry, which is O(files x folders)
     * during a recursive indexing scan of a large phone backup.
     */
    private cachedListingIndex;
    private cachedDirectoryHasFile;
    private invalidateListingIndexes;
    private listingRevision;
    private listCachedPhoneFiles;
    /** Recursively lists every entry on a connected device for explicit source cloning. */
    listPhoneFilesRecursively(virtualPath: string, onFile?: (file: PhoneFileInfo) => void, isCancelled?: () => boolean): Promise<PhoneFileInfo[]>;
    private listAndroidFiles;
    private iosListNames;
    /** One afcclient session answers every stat in a directory, avoiding N spawns. */
    private iosStatBatch;
    private listIosFiles;
    /** Copies a device file into the local cache so normal file code paths work. */
    materialize(candidate: string, force?: boolean): Promise<string>;
    statPhoneFile(candidate: string): Promise<PhoneFileInfo | null>;
}
