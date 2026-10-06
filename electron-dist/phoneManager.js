"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PhoneManager = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const fs_1 = require("fs");
const audioTypes_1 = require("./utils/audioTypes");
const indexingPathPolicy_1 = require("./indexingPathPolicy");
const mime = require("mime");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// Per-path tracing runs inside indexing hot loops; unbounded output once filled the
// disk and (through a slow stdout pipe) the heap. Opt in with SILO_DEBUG_PHONE=1.
const PHONE_DEBUG = process.env.SILO_DEBUG_PHONE === "1";
function debugLog(...args) {
    if (!PHONE_DEBUG)
        return;
    try {
        console.log(...args);
    }
    catch {
        // Ignore EPIPE during shutdown.
    }
}
/** Virtual prefix; kept absolute so existing path guards accept it. */
const PHONE_PREFIX = "/__phone__";
const PHONE_BACKUP_PREFIX = "/__phone_backup__";
const ANDROID_STORAGE_ROOT = "/sdcard";
const IOS_STORAGE_ROOT = "/";
const VIDEO_EXTENSIONS = new Set([
    ".3g2",
    ".3gp",
    ".avi",
    ".f4v",
    ".flv",
    ".m2t",
    ".m2ts",
    ".m2v",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp2v",
    ".mp4",
    ".mpe",
    ".mpeg",
    ".mpg",
    ".mts",
    ".mxf",
    ".ogv",
    ".qt",
    ".ts",
    ".vob",
    ".webm",
    ".wmv",
]);
const BINARY_SEARCH_PATHS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(process.env.HOME || "", "Library/Android/sdk/platform-tools"),
    path.join(process.env.HOME || "", "Android/Sdk/platform-tools"),
];
// afcclient talks the AFC protocol directly, so iOS needs no FUSE layer.
const IOS_BINARIES = ["idevice_id", "ideviceinfo", "idevicepair", "afcclient", "idevicebackup2"];
const ANDROID_BINARIES = ["adb"];
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
// afcclient colourises its prompt even when stdout is a pipe.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(value) {
    return value.replace(ANSI_PATTERN, "");
}
function classifyPhoneFile(fileName, isDirectory) {
    if (isDirectory)
        return "folder";
    const mimeType = mime.getType(fileName);
    const group = mimeType?.split("/")[0];
    const extension = path.extname(fileName).toLowerCase();
    if (group === "video" || VIDEO_EXTENSIONS.has(extension))
        return "video";
    if (group === "image")
        return "image";
    if ((0, audioTypes_1.isAudioFile)(fileName, mimeType))
        return "audio";
    if (group === "text" || mimeType === "application/pdf")
        return "document";
    if (extension === ".heic" || extension === ".heif")
        return "image";
    return "other";
}
function joinRemote(base, name) {
    return base === "/" ? `/${name}` : `${base}/${name}`;
}
class PhoneManager {
    namedDevice(device) {
        return {
            ...device,
            name: this.deviceNames[`${device.platform}:${device.id}`] || device.name,
        };
    }
    async renameDevice(deviceId, platform, name) {
        const clean = name.trim();
        if (!clean || clean.length > 100)
            throw new Error("Enter a phone name between 1 and 100 characters.");
        this.deviceNames[`${platform}:${deviceId}`] = clean;
        this.deviceNameWrites = this.deviceNameWrites
            .catch(() => undefined)
            .then(async () => {
            const filePath = path.join(this.pullCacheRoot, "device-names.json");
            await fsPromises.writeFile(`${filePath}.tmp`, JSON.stringify(this.deviceNames));
            await fsPromises.rename(`${filePath}.tmp`, filePath);
        });
        await this.deviceNameWrites;
        for (const [key, manifest] of this.backupManifests) {
            if (key === `${platform}:${deviceId}`)
                manifest.progress.deviceName = clean;
        }
        return clean;
    }
    constructor(userDataPath, onBackupProgress = () => undefined) {
        this.binaries = new Map();
        this.adbServerStarted = false;
        this.backupManifests = new Map();
        this.connectedDeviceKeys = new Set();
        this.backupJobs = new Map();
        this.backupWriteChain = Promise.resolve();
        this.backupDestinationPath = null;
        this.deviceNames = {};
        this.deviceNameWrites = Promise.resolve();
        // Limit concurrent executions to prevent overwhelming the system
        this.activeRunCount = 0;
        this.MAX_CONCURRENT_RUNS = 1; // Reduced from 3 to prevent memory exhaustion
        this.runQueue = [];
        this.listingIndexes = new Map();
        this.listingRevision = 0;
        this.pullCacheRoot = path.join(userDataPath, "phone-cache");
        this.backupStatePath = path.join(this.pullCacheRoot, "backup-state.json");
        this.backupDestinationConfigPath = path.join(this.pullCacheRoot, "backup-destination.json");
        this.onBackupProgress = onBackupProgress;
        this.log(`Constructor called with userDataPath: ${userDataPath}`);
        this.log(`Pull cache root: ${this.pullCacheRoot}`);
    }
    // Safe logging that handles EPIPE errors during shutdown
    trace(...args) {
        debugLog("[PhoneManager]", ...args);
    }
    log(...args) {
        try {
            console.log("[PhoneManager]", ...args);
        }
        catch {
            // Silently ignore EPIPE and other console errors during shutdown
        }
    }
    logError(...args) {
        try {
            console.error("[PhoneManager]", ...args);
        }
        catch {
            // Silently ignore errors during shutdown
        }
    }
    async queueRun(fn, priority = false) {
        const queueSize = this.runQueue.length;
        const activeCount = this.activeRunCount;
        this.trace(`queueRun: Queueing task (queue size: ${queueSize}, active: ${activeCount}/${this.MAX_CONCURRENT_RUNS})`);
        return new Promise((resolve, reject) => {
            const task = async () => {
                const startTime = Date.now();
                this.trace(`queueRun: Starting task (${this.activeRunCount - 1}/${this.MAX_CONCURRENT_RUNS} already running)`);
                try {
                    const result = await fn();
                    const elapsed = Date.now() - startTime;
                    this.trace(`queueRun: Task completed in ${elapsed}ms`);
                    resolve(result);
                }
                catch (err) {
                    const elapsed = Date.now() - startTime;
                    this.logError(`queueRun: Task failed after ${elapsed}ms:`, err);
                    reject(err);
                }
                finally {
                    this.activeRunCount -= 1;
                    this.trace(`queueRun: Task finished, active count now: ${this.activeRunCount}`);
                    this.processRunQueue();
                }
            };
            if (priority)
                this.runQueue.unshift(task);
            else
                this.runQueue.push(task);
            this.processRunQueue();
        });
    }
    processRunQueue() {
        while (this.activeRunCount < this.MAX_CONCURRENT_RUNS &&
            this.runQueue.length > 0) {
            this.activeRunCount += 1;
            const task = this.runQueue.shift();
            if (task) {
                this.trace(`processRunQueue: Starting queued task (${this.activeRunCount}/${this.MAX_CONCURRENT_RUNS})`);
                void task();
            }
        }
    }
    async initialize() {
        this.trace(`Initializing...`);
        try {
            await fsPromises.mkdir(this.pullCacheRoot, { recursive: true });
            try {
                const stored = JSON.parse(await fsPromises.readFile(path.join(this.pullCacheRoot, "device-names.json"), "utf8"));
                this.deviceNames = Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "string" && value.trim()));
            }
            catch {
                /* No saved phone aliases yet. */
            }
            // Load backup destination
            try {
                const destConfig = JSON.parse(await fsPromises.readFile(this.backupDestinationConfigPath, "utf8"));
                if (destConfig.destination !== null) {
                    try {
                        await fsPromises.access(destConfig.destination);
                        this.backupDestinationPath = destConfig.destination;
                        this.log(`Loaded backup destination: ${destConfig.destination}`);
                    }
                    catch {
                        this.log(`Backup destination no longer accessible, clearing: ${destConfig.destination}`);
                    }
                }
            }
            catch {
                // Destination config doesn't exist yet, that's fine
            }
            try {
                const stored = JSON.parse(await fsPromises.readFile(this.backupStatePath, "utf8"));
                for (const [key, manifest] of Object.entries(stored)) {
                    manifest.progress.failedFiles =
                        Number(manifest.progress.failedFiles) || 0;
                    if (["scanning", "backing-up"].includes(manifest.progress.status)) {
                        manifest.progress.status = "idle";
                        manifest.progress.message =
                            "Backup was interrupted and will resume when the phone reconnects.";
                    }
                    this.backupManifests.set(key, manifest);
                    this.invalidateListingIndexes();
                }
            }
            catch {
                await this.persistBackupState();
            }
            this.log(`Initialization complete, cache directory ready`);
        }
        catch (error) {
            this.logError(`Failed to initialize cache directory:`, error);
            throw error;
        }
    }
    getBackupStates() {
        return Array.from(this.backupManifests.values()).map((manifest) => ({
            ...manifest.progress,
        }));
    }
    /** Local folder holding a device's backed-up files, when a backup exists. */
    getBackupRoot(platform, deviceId) {
        const manifest = this.backupManifests.get(this.deviceKey(platform, deviceId));
        if (!manifest || !Object.keys(manifest.files).length)
            return null;
        const cacheRoot = manifest.cacheRoot ?? this.backupDestinationPath ?? this.pullCacheRoot;
        return path.join(cacheRoot, platform, deviceId);
    }
    async getOfflineBackups() {
        const backups = [];
        for (const [key, manifest] of this.backupManifests) {
            const progress = manifest.progress;
            const cacheRoot = manifest.cacheRoot ?? this.backupDestinationPath ?? this.pullCacheRoot;
            if (manifest.snapshots?.length) {
                for (const snapshot of manifest.snapshots) {
                    const rootPath = this.virtualPath(progress.platform, progress.deviceId, "/", true, snapshot.id);
                    const present = await this.hasSnapshotFile(manifest, snapshot, cacheRoot);
                    if (!present)
                        continue;
                    backups.push({
                        id: progress.deviceId,
                        snapshotId: snapshot.id,
                        platform: progress.platform,
                        name: progress.deviceName,
                        rootPath,
                        snapshotAt: snapshot.createdAt,
                        totalFiles: snapshot.totalFiles,
                        failedFiles: snapshot.failedFiles,
                    });
                }
                continue;
            }
            if (!progress.lastBackupAt)
                continue;
            let present = false;
            for (const [virtualPath, signature] of Object.entries(manifest.files)) {
                if (!this.isPhonePath(virtualPath))
                    continue;
                const cached = this.localCachePath(virtualPath, cacheRoot);
                const expectedSize = Number(signature.split(":", 1)[0]);
                present = await fsPromises.stat(cached).then((stats) => stats.isFile() && stats.size === expectedSize, () => false);
                if (present)
                    break;
            }
            if (!present)
                continue;
            backups.push({
                id: progress.deviceId,
                snapshotId: `legacy-${progress.lastBackupAt}`,
                platform: progress.platform,
                name: progress.deviceName,
                rootPath: this.virtualPath(progress.platform, progress.deviceId, "/", true),
                snapshotAt: progress.lastBackupAt,
                totalFiles: progress.totalFiles,
                failedFiles: progress.failedFiles,
            });
        }
        return backups;
    }
    async hasSnapshotFile(manifest, snapshot, cacheRoot) {
        const device = manifest.progress;
        for (const [remotePath, signature] of Object.entries(snapshot.files)) {
            const virtualPath = this.virtualPath(device.platform, device.deviceId, remotePath, true, snapshot.id);
            const cached = this.localCachePath(virtualPath, cacheRoot);
            const expectedSize = Number(signature.split(":", 1)[0]);
            const present = await fsPromises.stat(cached).then((stats) => stats.isFile() && stats.size === expectedSize, () => false);
            if (present)
                return true;
        }
        return false;
    }
    async isSnapshotComplete(manifest, snapshot, cacheRoot) {
        const entries = Object.entries(snapshot.files);
        if (!entries.length)
            return false;
        const device = manifest.progress;
        for (const [remotePath, signature] of entries) {
            const virtualPath = this.virtualPath(device.platform, device.deviceId, remotePath, true, snapshot.id);
            const cached = this.localCachePath(virtualPath, cacheRoot);
            const expectedSize = Number(signature.split(":", 1)[0]);
            const present = await fsPromises.stat(cached).then((stats) => stats.isFile() && stats.size === expectedSize, () => false);
            if (!present)
                return false;
        }
        return true;
    }
    async getRestoreArchives() {
        const archives = [];
        const activeRoot = path.resolve(this.backupDestinationPath ?? this.pullCacheRoot);
        for (const manifest of this.backupManifests.values()) {
            for (const archive of manifest.restoreArchives ?? []) {
                try {
                    const archiveRoot = this.getRegisteredArchivePath(archive, manifest, activeRoot);
                    const manifestPath = path.join(archiveRoot, archive.deviceId, "Manifest.plist");
                    const present = await fsPromises
                        .stat(manifestPath)
                        .then((stats) => stats.isFile(), () => false);
                    if (!present)
                        continue;
                    const deviceModel = archive.deviceModel ??
                        (await this.readRestoreArchivePlistString(archiveRoot, archive.deviceId, "Product Type"));
                    archives.push({ ...archive, archivePath: archiveRoot, deviceModel });
                }
                catch {
                    // Disconnected, moved, or malformed archives stay hidden until available.
                }
            }
        }
        return archives.sort((first, second) => second.createdAt - first.createdAt);
    }
    getRegisteredArchivePath(archive, manifest, activeRoot) {
        if (!archive.id ||
            !/^[A-Za-z0-9._-]+$/.test(archive.id) ||
            archive.id === "." ||
            archive.id === ".." ||
            !/^[A-Za-z0-9._-]+$/.test(archive.deviceId) ||
            archive.deviceId === "." ||
            archive.deviceId === "..")
            throw new Error("Invalid restore archive registration.");
        const recordedRoot = path.resolve(archive.backupRoot ?? manifest.cacheRoot ?? this.pullCacheRoot);
        if (recordedRoot !== activeRoot)
            throw new Error("Select the drive containing this restore archive.");
        const safeDeviceId = archive.deviceId.replace(/[^A-Za-z0-9._-]/g, "_");
        const candidates = [
            path.join(activeRoot, ".silo-phone-restores", "ios", safeDeviceId, archive.id, "backup"),
            path.join(activeRoot, "Device Restores", "iOS", safeDeviceId, archive.id, "backup"),
        ];
        const registeredPath = path.resolve(archive.archivePath);
        const expectedPath = candidates.find((candidate) => path.resolve(candidate) === registeredPath);
        if (!expectedPath)
            throw new Error("Restore archive path is outside its backup folder.");
        return expectedPath;
    }
    async readRestoreArchivePlistString(archiveRoot, deviceId, key) {
        if (process.platform !== "darwin")
            throw new Error("iPhone restore archive inspection requires macOS.");
        const { stdout } = await execFileAsync("/usr/bin/plutil", [
            "-extract",
            key,
            "raw",
            "-o",
            "-",
            path.join(archiveRoot, deviceId, key === "SnapshotState" ? "Status.plist" : "Info.plist"),
        ], { timeout: 10000 });
        const value = stdout.trim();
        if (!value)
            throw new Error(`Restore archive is missing ${key}.`);
        return value;
    }
    async replaceRestoreArchivePlistString(infoPlistPath, key, value) {
        await execFileAsync("/usr/bin/plutil", ["-replace", key, "-string", value, infoPlistPath], { timeout: 10000 });
    }
    compareProductVersions(first, second) {
        const parse = (version) => {
            const match = version.match(/^\s*(\d+(?:\.\d+){0,3})/);
            if (!match)
                throw new Error("Could not verify the iOS version compatibility.");
            return match[1].split(".").map(Number);
        };
        const left = parse(first);
        const right = parse(second);
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
            const difference = (left[index] ?? 0) - (right[index] ?? 0);
            if (difference)
                return Math.sign(difference);
        }
        return 0;
    }
    async cloneRestoreArchiveForDevice(sourceRoot, targetRoot, sourceDeviceId, targetDevice) {
        const measureArchive = async (directory) => {
            let totalBytes = 0;
            const entries = await fsPromises.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(directory, entry.name);
                if (entry.isSymbolicLink())
                    throw new Error("Restore archives containing symbolic links are not supported.");
                if (entry.isDirectory())
                    totalBytes += await measureArchive(entryPath);
                else if (entry.isFile())
                    totalBytes += (await fsPromises.stat(entryPath)).size;
            }
            return totalBytes;
        };
        const archiveBytes = await measureArchive(sourceRoot);
        await fsPromises.mkdir(path.dirname(targetRoot), { recursive: true });
        try {
            await execFileAsync("/bin/cp", ["-cR", sourceRoot, targetRoot]);
        }
        catch {
            await fsPromises.rm(targetRoot, { recursive: true, force: true });
            const disk = await fsPromises.statfs(path.dirname(targetRoot));
            const availableBytes = disk.bavail * disk.bsize;
            const reserveBytes = 5 * 1024 * 1024 * 1024;
            if (availableBytes < archiveBytes + reserveBytes)
                throw new Error("This drive cannot make a space-efficient restore copy and does not have enough free space for a separate working copy.");
            await fsPromises.cp(sourceRoot, targetRoot, {
                recursive: true,
                errorOnExist: true,
                force: false,
                preserveTimestamps: true,
            });
        }
        const infoPlistPath = path.join(targetRoot, sourceDeviceId, "Info.plist");
        const targetSerial = await this.run("ideviceinfo", ["-u", targetDevice.id, "-k", "SerialNumber"], 8000);
        if (!targetSerial.ok || !targetSerial.stdout.trim())
            throw new Error("Silo could not verify the connected device serial number.");
        await this.replaceRestoreArchivePlistString(infoPlistPath, "Target Identifier", targetDevice.id);
        await this.replaceRestoreArchivePlistString(infoPlistPath, "Serial Number", targetSerial.stdout.trim());
        await this.replaceRestoreArchivePlistString(infoPlistPath, "Unique Identifier", targetDevice.id.toUpperCase());
    }
    async verifyEncryptedRestoreArchive(archivePath, deviceId) {
        const manifestPath = path.join(archivePath, deviceId, "Manifest.plist");
        if (process.platform !== "darwin")
            throw new Error("Encrypted iPhone backup verification requires macOS.");
        try {
            const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", "IsEncrypted", "raw", "-o", "-", manifestPath], { timeout: 10000 });
            if (stdout.trim().toLowerCase() !== "true")
                throw new Error("not encrypted");
        }
        catch {
            throw new Error("Silo could not verify that this iPhone restore archive is encrypted, so it will not retain the archive.");
        }
    }
    async createRestoreArchive(device, password) {
        if (device.platform !== "ios")
            throw new Error("Native restore archives are currently supported for iPhone and iPad only.");
        if (device.status !== "ready" || !device.rootPath)
            throw new Error("Connect and trust the iPhone or iPad before creating a restore archive.");
        if (!device.model)
            throw new Error("Silo could not verify the iPhone or iPad model for this restore archive.");
        if (password.trim().length < 8)
            throw new Error("Use an encrypted-backup password with at least 8 characters.");
        const key = this.deviceKey(device.platform, device.id);
        const activeBrowseableBackup = this.backupJobs.get(key);
        if (activeBrowseableBackup)
            await activeBrowseableBackup;
        const manifest = this.backupManifests.get(key) ?? {
            files: {},
            progress: this.emptyBackupProgress(device),
        };
        const backupRoot = this.backupDestinationPath ?? this.pullCacheRoot;
        const safeDeviceId = device.id.replace(/[^A-Za-z0-9._-]/g, "_");
        const deviceArchiveRoot = path.join(backupRoot, ".silo-phone-restores", "ios", safeDeviceId);
        const disk = await fsPromises.statfs(backupRoot);
        const availableBytes = disk.bavail * disk.bsize;
        const reserveBytes = 5 * 1024 * 1024 * 1024;
        if (availableBytes <= reserveBytes)
            throw new Error("The restore destination must have more than 5 GB free before Silo can start.");
        await fsPromises.mkdir(deviceArchiveRoot, { recursive: true });
        const createdAt = Date.now();
        const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
        let archiveId = `${safeDeviceId}-${timestamp}`;
        let suffix = 1;
        while (await fsPromises
            .access(path.join(deviceArchiveRoot, archiveId))
            .then(() => true, () => false)) {
            archiveId = `${safeDeviceId}-${timestamp}-${suffix++}`;
        }
        const stageRoot = path.join(deviceArchiveRoot, `.${archiveId}.partial`);
        const finalRoot = path.join(deviceArchiveRoot, archiveId);
        const stagedArchivePath = path.join(stageRoot, "backup");
        const finalArchivePath = path.join(finalRoot, "backup");
        await fsPromises.rm(stageRoot, { recursive: true, force: true });
        await fsPromises.mkdir(stagedArchivePath, { recursive: true });
        try {
            const environment = { BACKUP_PASSWORD: password };
            await this.runLongOperation("idevicebackup2", ["-u", device.id, "encryption", "on"], environment);
            await this.runLongOperation("idevicebackup2", ["-u", device.id, "backup", "--full", stagedArchivePath], environment);
            await this.verifyEncryptedRestoreArchive(stagedArchivePath, device.id);
            const snapshotState = await this.readRestoreArchivePlistString(stagedArchivePath, device.id, "SnapshotState");
            if (snapshotState.toLowerCase() !== "finished")
                throw new Error("The iPhone restore archive did not finish cleanly.");
            const archivedModel = await this.readRestoreArchivePlistString(stagedArchivePath, device.id, "Product Type");
            if (device.model && archivedModel !== device.model)
                throw new Error("The saved archive does not match the connected device model.");
            await fsPromises.writeFile(path.join(stageRoot, "SiloArchive.json"), JSON.stringify({
                id: archiveId,
                platform: device.platform,
                deviceId: device.id,
                deviceName: device.name,
                deviceModel: archivedModel,
                createdAt,
                encrypted: true,
                restoreTool: "idevicebackup2",
            }, null, 2));
            await fsPromises.rename(stageRoot, finalRoot);
            const archive = {
                id: archiveId,
                deviceId: device.id,
                platform: "ios",
                deviceName: device.name,
                deviceModel: archivedModel,
                backupRoot,
                archivePath: finalArchivePath,
                createdAt,
                encrypted: true,
            };
            manifest.restoreArchives ?? (manifest.restoreArchives = []);
            manifest.restoreArchives.push(archive);
            this.backupManifests.set(key, manifest);
            this.invalidateListingIndexes();
            await this.persistBackupState();
            return { ...archive };
        }
        catch (error) {
            await fsPromises.rm(stageRoot, { recursive: true, force: true });
            throw error;
        }
    }
    async restoreDeviceFromArchive(device, archiveId, password) {
        if (device.platform !== "ios")
            throw new Error("This restore archive is for an iPhone or iPad.");
        if (device.status !== "ready" || !device.rootPath)
            throw new Error("Connect and trust the iPhone or iPad before restoring it.");
        if (!password.trim())
            throw new Error("Enter the encrypted-backup password.");
        const archives = await this.getRestoreArchives();
        const archive = archives.find((candidate) => candidate.id === archiveId);
        if (!archive)
            throw new Error("That restore archive is unavailable on the selected backup drive.");
        const recordedDeviceId = archive.deviceId;
        const manifest = this.backupManifests.get(this.deviceKey("ios", recordedDeviceId));
        if (!manifest)
            throw new Error("That restore archive is not registered in Silo.");
        const archiveRoot = this.getRegisteredArchivePath(archive, manifest, path.resolve(this.backupDestinationPath ?? this.pullCacheRoot));
        const realBackupRoot = await fsPromises.realpath(this.backupDestinationPath ?? this.pullCacheRoot);
        const realArchiveRoot = await fsPromises.realpath(archiveRoot);
        if (!(0, indexingPathPolicy_1.isPathWithin)(realArchiveRoot, realBackupRoot))
            throw new Error("The selected iPhone restore archive is outside its backup drive.");
        await this.verifyEncryptedRestoreArchive(realArchiveRoot, recordedDeviceId);
        const snapshotState = await this.readRestoreArchivePlistString(realArchiveRoot, recordedDeviceId, "SnapshotState");
        if (snapshotState.toLowerCase() !== "finished")
            throw new Error("The iPhone restore archive is incomplete and cannot be restored.");
        const archivedModel = await this.readRestoreArchivePlistString(realArchiveRoot, recordedDeviceId, "Product Type");
        if (!device.model || device.model !== archivedModel)
            throw new Error("This restore archive requires the same iPhone or iPad model.");
        const sourceTargetIdentifier = await this.readRestoreArchivePlistString(realArchiveRoot, recordedDeviceId, "Target Identifier");
        if (sourceTargetIdentifier.toLowerCase() !== recordedDeviceId.toLowerCase())
            throw new Error("The restore archive’s device identity does not match its Silo registration.");
        await this.readRestoreArchivePlistString(realArchiveRoot, recordedDeviceId, "Serial Number");
        const archivedVersion = await this.readRestoreArchivePlistString(realArchiveRoot, recordedDeviceId, "Product Version");
        const targetVersion = await this.run("ideviceinfo", ["-u", device.id, "-k", "ProductVersion"], 8000);
        if (!targetVersion.ok || !targetVersion.stdout.trim())
            throw new Error("Silo could not verify the connected iPhone or iPad software version.");
        if (this.compareProductVersions(targetVersion.stdout, archivedVersion) < 0)
            throw new Error("Update the target iPhone or iPad to the archive’s iOS version or later before restoring.");
        let restoreRoot = realArchiveRoot;
        let temporaryRestoreRoot = null;
        if (recordedDeviceId !== device.id) {
            temporaryRestoreRoot = path.join(path.dirname(realArchiveRoot), `.restore-${device.id.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}`);
            try {
                await this.cloneRestoreArchiveForDevice(realArchiveRoot, temporaryRestoreRoot, recordedDeviceId, device);
                restoreRoot = temporaryRestoreRoot;
            }
            catch (error) {
                await fsPromises.rm(temporaryRestoreRoot, { recursive: true, force: true });
                throw error;
            }
        }
        try {
            await this.runLongOperation("idevicebackup2", [
                "-u",
                device.id,
                "-s",
                recordedDeviceId,
                "restore",
                "--system",
                "--settings",
                restoreRoot,
            ], { BACKUP_PASSWORD: password });
        }
        finally {
            if (temporaryRestoreRoot)
                await fsPromises.rm(temporaryRestoreRoot, { recursive: true, force: true });
        }
    }
    async setBackupDestination(destination) {
        if (destination !== null) {
            try {
                await fsPromises.access(destination);
            }
            catch {
                throw new Error(`Backup destination is not accessible: ${destination}`);
            }
        }
        this.backupDestinationPath = destination;
        // Persist the destination to file
        try {
            const configContent = JSON.stringify({ destination }, null, 2);
            const tempPath = this.backupDestinationConfigPath + ".tmp";
            await fsPromises.writeFile(tempPath, configContent, "utf8");
            await fsPromises.rename(tempPath, this.backupDestinationConfigPath);
            this.log(`Saved backup destination: ${destination}`);
        }
        catch (error) {
            this.logError(`Failed to persist backup destination:`, error);
        }
        return destination;
    }
    async getBackupDestination() {
        return this.backupDestinationPath;
    }
    backupDevice(device) {
        this.log(`backupDevice called for ${device.platform}:${device.id} (${device.name})`);
        const key = this.deviceKey(device.platform, device.id);
        const active = this.backupJobs.get(key);
        if (active) {
            this.log(`Backup already in progress for ${key}`);
            return active;
        }
        this.log(`Starting backup for ${key}`);
        const job = this.runBackup(device).finally(() => {
            this.log(`Backup finished for ${key}`);
            this.backupJobs.delete(key);
        });
        this.backupJobs.set(key, job);
        return job;
    }
    async runBackup(device) {
        this.log(`runBackup started for ${device.platform}:${device.id}`);
        this.log(`runBackup: Using destination: ${this.backupDestinationPath || "default (local cache)"}`);
        if (device.status !== "ready" || !device.rootPath)
            throw new Error("The phone is not trusted and ready for backup.");
        const key = this.deviceKey(device.platform, device.id);
        const manifest = this.backupManifests.get(key) ?? {
            files: {},
            progress: this.emptyBackupProgress(device),
        };
        const backupDir = manifest.cacheRoot ?? this.backupDestinationPath ?? this.pullCacheRoot;
        manifest.cacheRoot = backupDir;
        this.backupManifests.set(key, manifest);
        this.invalidateListingIndexes();
        try {
            this.log(`runBackup: updating status to scanning for ${key}`);
            this.updateBackup(manifest, {
                status: "scanning",
                currentFile: null,
                message: `Scanning ${device.name} for files...`,
            });
            const files = (await this.listPhoneFilesRecursively(device.rootPath)).filter((file) => !file.isDirectory);
            const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
            const remainingBytes = files.reduce((sum, file) => {
                const signature = `${file.size}:${file.modified}`;
                return sum + (manifest.files[file.path] === signature ? 0 : file.size);
            }, 0);
            // Check disk space on the actual backup destination
            this.log(`runBackup: Checking disk space on ${backupDir} for ${this.formatBytes(remainingBytes)} of new data`);
            const disk = await fsPromises.statfs(backupDir);
            const freeBytes = disk.bavail * disk.bsize;
            const reserveBytes = 5 * 1024 * 1024 * 1024;
            if (remainingBytes > Math.max(0, freeBytes - reserveBytes)) {
                const location = this.backupDestinationPath
                    ? `external drive (${this.backupDestinationPath})`
                    : "Mac storage";
                throw new Error(`Not enough free disk space on ${location} to back up ${device.name}. ` +
                    `${this.formatBytes(remainingBytes)} is needed while preserving a 5 GB safety reserve. ` +
                    `Available: ${this.formatBytes(Math.max(0, freeBytes - reserveBytes))}`);
            }
            this.updateBackup(manifest, {
                status: "backing-up",
                totalFiles: files.length,
                completedFiles: 0,
                totalBytes,
                completedBytes: 0,
                copiedFiles: 0,
                failedFiles: 0,
                message: `Backing up ${files.length.toLocaleString()} files from ${device.name}...`,
            });
            for (const file of files) {
                const signature = `${file.size}:${file.modified}`;
                const localPath = this.localCachePath(file.path);
                let cached = manifest.files[file.path] === signature;
                if (cached) {
                    cached = await fsPromises.stat(localPath).then((stats) => stats.isFile() && (file.size === 0 || stats.size === file.size), () => false);
                }
                if (!cached) {
                    try {
                        await this.materialize(file.path, true);
                        manifest.files[file.path] = signature;
                        this.invalidateListingIndexes();
                        manifest.progress.copiedFiles += 1;
                    }
                    catch (error) {
                        manifest.progress.failedFiles += 1;
                        this.logError(`Backup skipped inaccessible file ${file.path}:`, error);
                    }
                }
                manifest.progress.completedFiles += 1;
                manifest.progress.completedBytes += file.size;
                manifest.progress.currentFile = file.relativePath || file.name;
                manifest.progress.message = `${manifest.progress.completedFiles.toLocaleString()} of ${manifest.progress.totalFiles.toLocaleString()} files backed up`;
                this.onBackupProgress({ ...manifest.progress });
                await this.persistBackupState();
                await new Promise((resolve) => setImmediate(resolve));
            }
            const snapshot = await this.createBrowseableSnapshot(device, manifest, files, backupDir);
            manifest.progress.status = "complete";
            manifest.progress.currentFile = null;
            manifest.progress.lastBackupAt = snapshot.createdAt;
            manifest.progress.message =
                snapshot.failedFiles > 0
                    ? `${device.name} browseable snapshot saved with ${snapshot.failedFiles.toLocaleString()} inaccessible files skipped.`
                    : `${device.name} browseable snapshot saved.`;
            await this.persistBackupState();
            this.onBackupProgress({ ...manifest.progress });
            return { ...manifest.progress };
        }
        catch (error) {
            manifest.progress.status = "error";
            manifest.progress.currentFile = null;
            manifest.progress.message =
                error instanceof Error ? error.message : "Phone backup failed.";
            await this.persistBackupState();
            this.onBackupProgress({ ...manifest.progress });
            return { ...manifest.progress };
        }
    }
    async createBrowseableSnapshot(device, manifest, files, backupDir) {
        const snapshotFiles = {};
        const sourceFiles = [];
        let failedFiles = manifest.progress.failedFiles;
        for (const file of files) {
            const parsed = this.parsePhonePath(file.path);
            if (!parsed || parsed.offlineBackup)
                continue;
            const remotePath = path.posix.normalize(parsed.remotePath);
            if (remotePath === "/" || remotePath.startsWith("/../") || remotePath === "/..") {
                failedFiles += 1;
                continue;
            }
            const signature = `${file.size}:${file.modified}`;
            const source = this.localCachePath(file.path, backupDir);
            const stats = await fsPromises.stat(source).catch(() => null);
            if (!stats?.isFile() || stats.size !== file.size) {
                failedFiles += 1;
                continue;
            }
            snapshotFiles[remotePath] = signature;
            sourceFiles.push({ remotePath, source, signature });
        }
        const latest = manifest.snapshots?.at(-1);
        const latestHasSameFiles = latest &&
            Object.keys(latest.files).length === Object.keys(snapshotFiles).length &&
            Object.entries(snapshotFiles).every(([remotePath, signature]) => latest.files[remotePath] === signature);
        if (latestHasSameFiles && (await this.isSnapshotComplete(manifest, latest, backupDir))) {
            return latest;
        }
        const createdAt = Date.now();
        let snapshotId = String(createdAt);
        let suffix = 1;
        while (manifest.snapshots?.some((snapshot) => snapshot.id === snapshotId)) {
            snapshotId = `${createdAt}-${suffix++}`;
        }
        const snapshotsRoot = path.join(backupDir, ".silo-phone-snapshots", device.platform, device.id, "snapshots");
        const stageRoot = path.join(snapshotsRoot, `.${snapshotId}.partial`);
        const finalRoot = path.join(snapshotsRoot, snapshotId);
        await fsPromises.mkdir(snapshotsRoot, { recursive: true });
        await fsPromises.rm(stageRoot, { recursive: true, force: true });
        await fsPromises.mkdir(stageRoot, { recursive: true });
        try {
            let fallbackCopyBytes = 0;
            for (const { remotePath, source } of sourceFiles) {
                const relative = remotePath.replace(/^\/+/, "");
                const destination = path.resolve(stageRoot, relative);
                const pathFromRoot = path.relative(stageRoot, destination);
                if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
                    failedFiles += 1;
                    continue;
                }
                await fsPromises.mkdir(path.dirname(destination), { recursive: true });
                try {
                    await fsPromises.link(source, destination);
                }
                catch (error) {
                    const code = error.code;
                    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code || "")) {
                        throw error;
                    }
                    const sourceStats = await fsPromises.stat(source);
                    const disk = await fsPromises.statfs(snapshotsRoot);
                    const availableBytes = disk.bavail * disk.bsize - 5 * 1024 * 1024 * 1024;
                    if (sourceStats.size > availableBytes - fallbackCopyBytes) {
                        throw new Error(`Not enough free space to retain a dated browseable copy of ${device.name} while preserving a 5 GB safety reserve.`);
                    }
                    await fsPromises.copyFile(source, destination, fs_1.constants.COPYFILE_EXCL);
                    fallbackCopyBytes += sourceStats.size;
                }
            }
            const snapshot = {
                id: snapshotId,
                createdAt,
                totalFiles: Object.keys(snapshotFiles).length,
                failedFiles,
                files: snapshotFiles,
            };
            await fsPromises.writeFile(path.join(stageRoot, ".silo-snapshot.json"), JSON.stringify(snapshot, null, 2));
            await fsPromises.rename(stageRoot, finalRoot);
            manifest.snapshots ?? (manifest.snapshots = []);
            manifest.snapshots.push(snapshot);
            this.invalidateListingIndexes();
            return snapshot;
        }
        catch (error) {
            await fsPromises.rm(stageRoot, { recursive: true, force: true });
            throw error;
        }
    }
    updateBackup(manifest, update) {
        manifest.progress = { ...manifest.progress, ...update };
        this.trace(`updateBackup: emitting progress for ${manifest.progress.deviceId} - status: ${manifest.progress.status}, completed: ${manifest.progress.completedFiles}/${manifest.progress.totalFiles}`);
        this.onBackupProgress({ ...manifest.progress });
        this.trace(`updateBackup: progress callback invoked`);
    }
    emptyBackupProgress(device) {
        return {
            deviceId: device.id,
            platform: device.platform,
            deviceName: device.name,
            status: "idle",
            totalFiles: 0,
            completedFiles: 0,
            totalBytes: 0,
            completedBytes: 0,
            copiedFiles: 0,
            failedFiles: 0,
            currentFile: null,
            message: "Waiting for the phone to connect.",
            lastBackupAt: null,
        };
    }
    deviceKey(platform, deviceId) {
        return `${platform}:${deviceId}`;
    }
    formatBytes(bytes) {
        const units = ["B", "KB", "MB", "GB", "TB"];
        if (bytes <= 0)
            return "0 B";
        const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
    }
    localCachePath(candidate, explicitRoot) {
        const parsed = this.parsePhonePath(candidate);
        if (!parsed)
            return candidate;
        const manifest = this.backupManifests.get(this.deviceKey(parsed.platform, parsed.deviceId));
        const root = explicitRoot ?? manifest?.cacheRoot ?? this.backupDestinationPath ?? this.pullCacheRoot;
        if (parsed.offlineBackup && parsed.snapshotId) {
            return path.join(root, ".silo-phone-snapshots", parsed.platform, parsed.deviceId, "snapshots", parsed.snapshotId, parsed.remotePath.replace(/^\//, ""));
        }
        return path.join(root, parsed.platform, parsed.deviceId, parsed.remotePath.replace(/^\//, ""));
    }
    persistBackupState() {
        this.backupWriteChain = this.backupWriteChain.then(async () => {
            const serialized = Object.fromEntries(this.backupManifests);
            const temporaryPath = `${this.backupStatePath}.tmp`;
            await fsPromises.writeFile(temporaryPath, JSON.stringify(serialized, null, 2));
            await fsPromises.rename(temporaryPath, this.backupStatePath);
        });
        return this.backupWriteChain;
    }
    async resolveBinary(name) {
        if (this.binaries.has(name)) {
            const cached = this.binaries.get(name);
            this.trace(`resolveBinary: ${name} found in cache: ${cached || "not found"}`);
            return cached;
        }
        this.trace(`resolveBinary: Searching for ${name} in ${BINARY_SEARCH_PATHS.length} paths`);
        for (const directory of BINARY_SEARCH_PATHS) {
            if (!directory)
                continue;
            const candidate = path.join(directory, name);
            try {
                await fsPromises.access(candidate, fs_1.constants.X_OK);
                this.trace(`resolveBinary: Found ${name} at ${candidate}`);
                this.binaries.set(name, candidate);
                return candidate;
            }
            catch {
                // Continue searching
            }
        }
        debugLog(`[PhoneManager] resolveBinary: ${name} not found in any search path`);
        this.binaries.set(name, null);
        return null;
    }
    async run(binaryName, args, timeout = 20000, stdin) {
        const discoveryCommand = ["idevice_id", "ideviceinfo", "idevicepair"].includes(binaryName) ||
            (binaryName === "adb" &&
                (args[0] === "devices" ||
                    args[0] === "start-server" ||
                    args.includes("getprop")));
        return this.queueRun(async () => {
            this.trace(`run: Executing ${binaryName} with args:`, args, `(timeout: ${timeout}ms)`);
            const binary = await this.resolveBinary(binaryName);
            if (!binary) {
                this.logError(`run: ${binaryName} not installed`);
                return { stdout: "", stderr: `${binaryName} not installed`, ok: false };
            }
            try {
                this.trace(`run: Using binary at ${binary}`);
                const child = execFileAsync(binary, args, {
                    timeout,
                    maxBuffer: 64 * 1024 * 1024,
                    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
                });
                if (stdin !== undefined) {
                    this.trace(`run: Sending stdin (${stdin.length} bytes)`);
                    child.child.stdin?.end(stdin);
                }
                const { stdout, stderr } = await child;
                this.trace(`run: Command completed successfully, stdout length: ${stdout.length}, stderr length: ${stderr.length}`);
                if (stdout.length > 0) {
                    this.trace(`run: stdout preview: ${stdout.slice(0, 200)}${stdout.length > 200 ? "..." : ""}`);
                }
                if (stderr.length > 0) {
                    this.trace(`run: stderr: ${stderr.slice(0, 200)}`);
                }
                return { stdout, stderr, ok: true };
            }
            catch (error) {
                const err = error;
                this.logError(`run: Command failed for ${binaryName}:`, {
                    stdout: err.stdout?.slice(0, 200),
                    stderr: err.stderr?.slice(0, 200),
                    message: err.message,
                });
                return {
                    stdout: err.stdout ?? "",
                    stderr: err.stderr ?? err.message ?? "command failed",
                    ok: false,
                };
            }
        }, discoveryCommand);
    }
    async runLongOperation(binaryName, args, environment = {}) {
        return this.queueRun(async () => {
            const binary = await this.resolveBinary(binaryName);
            if (!binary)
                throw new Error(`${binaryName} is not installed.`);
            await new Promise((resolve, reject) => {
                const child = (0, child_process_1.spawn)(binary, args, {
                    env: {
                        ...process.env,
                        NO_COLOR: "1",
                        TERM: "dumb",
                        ...environment,
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                });
                let outputTail = "";
                const append = (chunk) => {
                    outputTail = `${outputTail}${chunk.toString()}`.slice(-12000);
                };
                child.stdout.on("data", append);
                child.stderr.on("data", append);
                child.once("error", reject);
                child.once("close", (code, signal) => {
                    if (code === 0) {
                        resolve();
                        return;
                    }
                    const detail = outputTail.trim();
                    reject(new Error(detail ||
                        `${binaryName} exited ${signal ? `after ${signal}` : `with code ${code}`}.`));
                });
            });
        });
    }
    async getTooling() {
        debugLog(`[PhoneManager] getTooling: Checking available binaries...`);
        const missingIos = [];
        for (const binary of IOS_BINARIES) {
            const found = await this.resolveBinary(binary);
            if (!found) {
                debugLog(`[PhoneManager] getTooling: iOS binary ${binary} is missing`);
                missingIos.push(binary);
            }
            else {
                debugLog(`[PhoneManager] getTooling: iOS binary ${binary} found at ${found}`);
            }
        }
        const missingAndroid = [];
        for (const binary of ANDROID_BINARIES) {
            const found = await this.resolveBinary(binary);
            if (!found) {
                debugLog(`[PhoneManager] getTooling: Android binary ${binary} is missing`);
                missingAndroid.push(binary);
            }
            else {
                debugLog(`[PhoneManager] getTooling: Android binary ${binary} found at ${found}`);
            }
        }
        const result = {
            ios: {
                available: missingIos.length === 0,
                missing: missingIos,
                installHint: "brew install libimobiledevice",
            },
            android: {
                available: missingAndroid.length === 0,
                missing: missingAndroid,
                installHint: "brew install --cask android-platform-tools",
            },
        };
        debugLog(`[PhoneManager] getTooling: iOS available: ${result.ios.available}, Android available: ${result.android.available}`);
        return result;
    }
    // ---------------------------------------------------------------- discovery
    async listDevices() {
        debugLog(`[PhoneManager] listDevices: Starting device discovery...`);
        try {
            const [ios, android] = await Promise.all([
                this.listIosDevices(),
                this.listAndroidDevices(),
            ]);
            debugLog(`[PhoneManager] listDevices: Found ${ios.length} iOS devices and ${android.length} Android devices`);
            const allDevices = [...ios, ...android].map((device) => this.namedDevice(device));
            this.connectedDeviceKeys = new Set(allDevices
                .filter((device) => device.status === "ready")
                .map((device) => this.deviceKey(device.platform, device.id)));
            allDevices.forEach((device) => {
                debugLog(`[PhoneManager] listDevices: Device: ${device.name} (${device.platform}) - Status: ${device.status}, Root: ${device.rootPath}`);
            });
            return allDevices;
        }
        catch (error) {
            console.error(`[PhoneManager] listDevices: Error during discovery:`, error);
            // Return empty array on error instead of throwing to prevent app crash
            return [];
        }
    }
    async listIosDevices() {
        debugLog(`[PhoneManager] listIosDevices: Scanning for iOS devices...`);
        const listed = await this.run("idevice_id", ["-l"], 8000);
        if (!listed.ok) {
            debugLog(`[PhoneManager] listIosDevices: idevice_id failed or no output`);
            return [];
        }
        const udids = listed.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        debugLog(`[PhoneManager] listIosDevices: Found ${udids.length} UDIDs:`, udids);
        const devices = [];
        for (const udid of udids) {
            debugLog(`[PhoneManager] listIosDevices: Checking device ${udid}`);
            const paired = await this.run("idevicepair", ["-u", udid, "validate"], 8000);
            const trusted = paired.ok;
            debugLog(`[PhoneManager] listIosDevices: Device ${udid} trusted: ${trusted}`);
            const name = trusted
                ? (await this.run("ideviceinfo", ["-u", udid, "-k", "DeviceName"], 8000)).stdout.trim()
                : "";
            debugLog(`[PhoneManager] listIosDevices: Device ${udid} name: ${name || "unknown"}`);
            const model = trusted
                ? (await this.run("ideviceinfo", ["-u", udid, "-k", "ProductType"], 8000)).stdout.trim()
                : null;
            debugLog(`[PhoneManager] listIosDevices: Device ${udid} model: ${model || "unknown"}`);
            const device = {
                id: udid,
                platform: "ios",
                name: name || "iPhone / iPad",
                model: model || null,
                status: trusted ? "ready" : "untrusted",
                rootPath: trusted
                    ? this.virtualPath("ios", udid, IOS_STORAGE_ROOT)
                    : null,
                message: trusted
                    ? "Trusted and ready to browse."
                    : "Unlock the device and tap Trust This Computer.",
            };
            debugLog(`[PhoneManager] listIosDevices: Created device entry:`, device);
            devices.push(device);
        }
        return devices;
    }
    async listAndroidDevices() {
        debugLog(`[PhoneManager] listAndroidDevices: Scanning for Android devices...`);
        if (!this.adbServerStarted) {
            debugLog(`[PhoneManager] listAndroidDevices: Starting ADB server...`);
            await this.run("adb", ["start-server"], 15000);
            this.adbServerStarted = true;
            debugLog(`[PhoneManager] listAndroidDevices: ADB server started`);
        }
        const listed = await this.run("adb", ["devices", "-l"], 10000);
        if (!listed.ok) {
            debugLog(`[PhoneManager] listAndroidDevices: adb devices failed`);
            return [];
        }
        debugLog(`[PhoneManager] listAndroidDevices: adb devices output:`, listed.stdout);
        const devices = [];
        const lines = listed.stdout.split("\n").slice(1);
        debugLog(`[PhoneManager] listAndroidDevices: Processing ${lines.length} lines`);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith("*")) {
                debugLog(`[PhoneManager] listAndroidDevices: Skipping line: ${line}`);
                continue;
            }
            const [serial, state, ...rest] = line.split(/\s+/);
            if (!serial || !state) {
                debugLog(`[PhoneManager] listAndroidDevices: Skipping invalid line: ${line}`);
                continue;
            }
            debugLog(`[PhoneManager] listAndroidDevices: Found device ${serial}, state: ${state}`);
            const descriptor = rest.join(" ");
            const modelMatch = /model:(\S+)/.exec(descriptor);
            const model = modelMatch ? modelMatch[1].replace(/_/g, " ") : null;
            debugLog(`[PhoneManager] listAndroidDevices: Device ${serial} model: ${model || "unknown"}`);
            if (state === "unauthorized") {
                debugLog(`[PhoneManager] listAndroidDevices: Device ${serial} is unauthorized`);
                devices.push({
                    id: serial,
                    platform: "android",
                    name: model || "Android device",
                    model,
                    status: "unauthorized",
                    rootPath: null,
                    message: "Unlock the device and tap Allow on the USB debugging prompt.",
                });
                continue;
            }
            if (state !== "device") {
                debugLog(`[PhoneManager] listAndroidDevices: Device ${serial} state is ${state}`);
                devices.push({
                    id: serial,
                    platform: "android",
                    name: model || "Android device",
                    model,
                    status: "offline",
                    rootPath: null,
                    message: `Device is ${state}. Reconnect the cable.`,
                });
                continue;
            }
            debugLog(`[PhoneManager] listAndroidDevices: Device ${serial} is ready, getting model name...`);
            const nameResult = await this.run("adb", ["-s", serial, "shell", "getprop", "ro.product.model"], 8000);
            const deviceName = nameResult.stdout.trim() || model || "Android device";
            debugLog(`[PhoneManager] listAndroidDevices: Device ${serial} name: ${deviceName}`);
            const device = {
                id: serial,
                platform: "android",
                name: deviceName,
                model,
                status: "ready",
                rootPath: this.virtualPath("android", serial, ANDROID_STORAGE_ROOT),
                message: "Authorized and ready to browse.",
            };
            debugLog(`[PhoneManager] listAndroidDevices: Created device entry:`, device);
            devices.push(device);
        }
        return devices;
    }
    // --------------------------------------------------------------- connecting
    async connect(deviceId, platform) {
        debugLog(`[PhoneManager] connect: Connecting to ${platform} device ${deviceId}`);
        const result = platform === "ios"
            ? await this.connectIos(deviceId)
            : await this.connectAndroid(deviceId);
        debugLog(`[PhoneManager] connect: Connection result:`, result);
        return this.namedDevice(result);
    }
    async connectIos(udid) {
        debugLog(`[PhoneManager] connectIos: Connecting to iOS device ${udid}`);
        const validated = await this.run("idevicepair", ["-u", udid, "validate"], 10000);
        debugLog(`[PhoneManager] connectIos: Validation result: ${validated.ok}`);
        if (!validated.ok) {
            // Triggers the on-device "Trust This Computer" prompt.
            debugLog(`[PhoneManager] connectIos: Device not trusted, attempting to pair...`);
            const paired = await this.run("idevicepair", ["-u", udid, "pair"], 45000);
            debugLog(`[PhoneManager] connectIos: Pair result: ${paired.ok}`);
            if (!paired.ok) {
                console.error(`[PhoneManager] connectIos: Pairing failed: ${paired.stderr}`);
                return {
                    id: udid,
                    platform: "ios",
                    name: "iPhone / iPad",
                    model: null,
                    status: "untrusted",
                    rootPath: null,
                    message: "Unlock the device and tap Trust This Computer, then try again.",
                };
            }
        }
        debugLog(`[PhoneManager] connectIos: Probing device with afcclient...`);
        const probe = await this.run("afcclient", ["-u", udid, "ls", "/"], 15000);
        debugLog(`[PhoneManager] connectIos: Probe result: ${probe.ok}, stdout length: ${probe.stdout.length}`);
        if (!probe.ok) {
            console.error(`[PhoneManager] connectIos: afcclient probe failed: ${probe.stderr}`);
            return {
                id: udid,
                platform: "ios",
                name: "iPhone / iPad",
                model: null,
                status: "error",
                rootPath: null,
                message: `Could not open the device: ${probe.stderr.trim()}`,
            };
        }
        // Log what afcclient returned
        debugLog(`[PhoneManager] connectIos: afcclient ls / returned:`, probe.stdout.slice(0, 500));
        debugLog(`[PhoneManager] connectIos: Getting device name...`);
        const name = (await this.run("ideviceinfo", ["-u", udid, "-k", "DeviceName"], 8000)).stdout.trim();
        debugLog(`[PhoneManager] connectIos: Device name: ${name || "unknown"}`);
        debugLog(`[PhoneManager] connectIos: Getting device model...`);
        const model = (await this.run("ideviceinfo", ["-u", udid, "-k", "ProductType"], 8000)).stdout.trim();
        debugLog(`[PhoneManager] connectIos: Device model: ${model || "unknown"}`);
        const device = {
            id: udid,
            platform: "ios",
            name: name || "iPhone / iPad",
            model: model || null,
            status: "ready",
            rootPath: this.virtualPath("ios", udid, IOS_STORAGE_ROOT),
            message: "Trusted and ready to browse.",
        };
        debugLog(`[PhoneManager] connectIos: Created device:`, device);
        return device;
    }
    async connectAndroid(serial) {
        debugLog(`[PhoneManager] connectAndroid: Connecting to Android device ${serial}`);
        const state = await this.run("adb", ["-s", serial, "get-state"], 10000);
        const trimmed = state.stdout.trim();
        debugLog(`[PhoneManager] connectAndroid: Device state: ${trimmed}`);
        if (!state.ok || trimmed !== "device") {
            debugLog(`[PhoneManager] connectAndroid: Device not ready, state: ${trimmed}`);
            return {
                id: serial,
                platform: "android",
                name: "Android device",
                model: null,
                status: trimmed === "unauthorized" ? "unauthorized" : "offline",
                rootPath: null,
                message: "Unlock the device and tap Allow on the USB debugging prompt, then try again.",
            };
        }
        debugLog(`[PhoneManager] connectAndroid: Getting device model...`);
        const name = await this.run("adb", ["-s", serial, "shell", "getprop ro.product.model"], 8000);
        const deviceName = name.stdout.trim() || "Android device";
        debugLog(`[PhoneManager] connectAndroid: Device name: ${deviceName}`);
        const device = {
            id: serial,
            platform: "android",
            name: deviceName,
            model: name.stdout.trim() || null,
            status: "ready",
            rootPath: this.virtualPath("android", serial, ANDROID_STORAGE_ROOT),
            message: "Authorized and ready to browse.",
        };
        debugLog(`[PhoneManager] connectAndroid: Created device:`, device);
        return device;
    }
    async disconnect() {
        debugLog(`[PhoneManager] disconnect: Disconnecting (no-op)`);
        // Nothing is mounted, so disconnecting is only a UI-level action.
    }
    async unmountAll() {
        debugLog(`[PhoneManager] unmountAll: Cleaning up (no-op)`);
        // Retained for shutdown symmetry; AFC and adb hold no mounts.
    }
    // -------------------------------------------------------------- path scheme
    virtualPath(platform, deviceId, remotePath, offlineBackup = false, snapshotId) {
        const normalized = remotePath.startsWith("/")
            ? remotePath
            : `/${remotePath}`;
        const suffix = normalized === "/" ? "" : normalized;
        const prefix = offlineBackup ? PHONE_BACKUP_PREFIX : PHONE_PREFIX;
        const snapshot = offlineBackup && snapshotId
            ? `/snapshot/${snapshotId}`
            : "";
        const virtual = `${prefix}/${platform}/${deviceId}${snapshot}${suffix}`;
        debugLog(`[PhoneManager] virtualPath: ${remotePath} -> ${virtual}`);
        return virtual;
    }
    isPhonePath(candidate) {
        const isPhone = typeof candidate === "string" &&
            (candidate.startsWith(`${PHONE_PREFIX}/`) ||
                candidate.startsWith(`${PHONE_BACKUP_PREFIX}/`));
        if (isPhone) {
            debugLog(`[PhoneManager] isPhonePath: ${candidate} is a phone path`);
        }
        return isPhone;
    }
    parsePhonePath(candidate) {
        if (!this.isPhonePath(candidate))
            return null;
        debugLog(`[PhoneManager] parsePhonePath: Parsing ${candidate}`);
        const offlineBackup = candidate.startsWith(`${PHONE_BACKUP_PREFIX}/`);
        const prefix = offlineBackup ? PHONE_BACKUP_PREFIX : PHONE_PREFIX;
        const remainder = candidate.slice(prefix.length + 1);
        debugLog(`[PhoneManager] parsePhonePath: Remainder: ${remainder}`);
        const platformEnd = remainder.indexOf("/");
        if (platformEnd < 0) {
            debugLog(`[PhoneManager] parsePhonePath: No platform found`);
            return null;
        }
        const platform = remainder.slice(0, platformEnd);
        if (platform !== "ios" && platform !== "android") {
            debugLog(`[PhoneManager] parsePhonePath: Invalid platform: ${platform}`);
            return null;
        }
        const afterPlatform = remainder.slice(platformEnd + 1);
        const deviceEnd = afterPlatform.indexOf("/");
        if (deviceEnd < 0) {
            debugLog(`[PhoneManager] parsePhonePath: No device ID found, using entire afterPlatform as ID`);
            return {
                platform: platform,
                deviceId: afterPlatform,
                remotePath: "/",
                offlineBackup,
                snapshotId: null,
            };
        }
        let remotePath = afterPlatform.slice(deviceEnd) || "/";
        let snapshotId = null;
        if (offlineBackup) {
            const snapshotMatch = remotePath.match(/^\/snapshot\/([^/]+)(\/.*)?$/);
            if (snapshotMatch) {
                snapshotId = snapshotMatch[1];
                remotePath = snapshotMatch[2] || "/";
            }
        }
        const result = {
            platform: platform,
            deviceId: afterPlatform.slice(0, deviceEnd),
            remotePath,
            offlineBackup,
            snapshotId,
        };
        debugLog(`[PhoneManager] parsePhonePath: Parsed to:`, result);
        return result;
    }
    // ------------------------------------------------------------------ listing
    async listPhoneFiles(virtualPath, exploded) {
        debugLog(`[PhoneManager] listPhoneFiles: Listing files for ${virtualPath}, exploded: ${exploded}`);
        const parsed = this.parsePhonePath(virtualPath);
        if (!parsed) {
            debugLog(`[PhoneManager] listPhoneFiles: Failed to parse path: ${virtualPath}`);
            return [];
        }
        debugLog(`[PhoneManager] listPhoneFiles: Parsed to:`, parsed);
        if (parsed.offlineBackup ||
            !this.connectedDeviceKeys.has(this.deviceKey(parsed.platform, parsed.deviceId)))
            return this.listCachedPhoneFiles(parsed.platform, parsed.deviceId, parsed.remotePath, parsed.offlineBackup, parsed.snapshotId);
        const result = parsed.platform === "android"
            ? await this.listAndroidFiles(parsed.deviceId, parsed.remotePath, exploded)
            : await this.listIosFiles(parsed.deviceId, parsed.remotePath, exploded);
        debugLog(`[PhoneManager] listPhoneFiles: Found ${result.length} files`);
        if (result.length === 0) {
            debugLog(`[PhoneManager] listPhoneFiles: No files found for ${virtualPath}`);
        }
        else if (result.length > 0 && result.length <= 5) {
            debugLog(`[PhoneManager] listPhoneFiles: First few files:`, result.map((f) => f.name));
        }
        else if (result.length > 5) {
            debugLog(`[PhoneManager] listPhoneFiles: First 5 of ${result.length} files:`, result.slice(0, 5).map((f) => f.name));
        }
        return result;
    }
    /**
     * Directory tree over a backup manifest, built once per manifest revision. Listing a
     * folder used to walk (and parse) every manifest entry, which is O(files x folders)
     * during a recursive indexing scan of a large phone backup.
     */
    cachedListingIndex(platform, deviceId, manifest, snapshot, snapshotId) {
        const key = `${this.deviceKey(platform, deviceId)}|${snapshotId ?? ""}`;
        const source = snapshot ? snapshot.files : manifest.files;
        const cached = this.listingIndexes.get(key);
        if (cached && cached.source === source && cached.revision === this.listingRevision)
            return cached;
        const dirs = new Map();
        const addChild = (parent, name, node) => {
            let children = dirs.get(parent);
            if (!children) {
                children = new Map();
                dirs.set(parent, children);
            }
            if (node.kind === "dir" && children.get(name)?.kind === "dir")
                return false;
            children.set(name, node);
            return true;
        };
        for (const [entryKey, signature] of Object.entries(source)) {
            let virtualPath = entryKey;
            let remote;
            if (snapshot) {
                remote = path.posix.normalize(`/${entryKey}`);
                virtualPath = this.virtualPath(platform, deviceId, entryKey, true, snapshotId || undefined);
            }
            else {
                const parsed = this.parsePhonePath(entryKey);
                if (!parsed || parsed.platform !== platform || parsed.deviceId !== deviceId)
                    continue;
                remote = path.posix.normalize(parsed.remotePath);
            }
            const segments = remote.split("/").filter(Boolean);
            if (!segments.length)
                continue;
            let parent = "/";
            for (let position = 0; position < segments.length - 1; position += 1) {
                const name = segments[position];
                addChild(parent, name, { kind: "dir" });
                parent = path.posix.join(parent, name);
            }
            addChild(parent, segments[segments.length - 1], { kind: "file", virtualPath, signature });
        }
        const index = {
            source,
            revision: this.listingRevision,
            dirs,
            hasFile: new Map(),
        };
        // Keep only a few device/snapshot trees resident.
        this.listingIndexes.delete(key);
        this.listingIndexes.set(key, index);
        while (this.listingIndexes.size > 4)
            this.listingIndexes.delete(this.listingIndexes.keys().next().value);
        return index;
    }
    async cachedDirectoryHasFile(index, directory) {
        const known = index.hasFile.get(directory);
        if (known !== undefined)
            return known;
        let found = false;
        for (const [name, child] of index.dirs.get(directory) ?? []) {
            if (child.kind === "dir") {
                found = await this.cachedDirectoryHasFile(index, path.posix.join(directory, name));
            }
            else {
                const expectedSize = Number(child.signature.split(":", 1)[0]);
                found = await fsPromises.stat(this.localCachePath(child.virtualPath)).then((stats) => stats.isFile() && Number.isFinite(expectedSize) && stats.size === expectedSize, () => false);
            }
            if (found)
                break;
        }
        index.hasFile.set(directory, found);
        return found;
    }
    invalidateListingIndexes() {
        this.listingRevision += 1;
        this.listingIndexes.clear();
    }
    async listCachedPhoneFiles(platform, deviceId, requestedRemotePath, offlineBackup, snapshotId) {
        const manifest = this.backupManifests.get(this.deviceKey(platform, deviceId));
        if (!manifest)
            return [];
        const requested = path.posix.normalize(`/${requestedRemotePath}`).replace(/\/$/, "") || "/";
        const entries = new Map();
        const snapshot = snapshotId
            ? manifest.snapshots?.find((entry) => entry.id === snapshotId)
            : undefined;
        const index = this.cachedListingIndex(platform, deviceId, manifest, snapshot, snapshotId);
        const children = index.dirs.get(requested);
        if (!children)
            return [];
        for (const [name, child] of children) {
            const childRemotePath = path.posix.join(requested, name);
            const childVirtualPath = this.virtualPath(platform, deviceId, childRemotePath, offlineBackup, snapshotId || undefined);
            if (child.kind === "dir") {
                // A folder is listed only when at least one cached file below it is intact.
                if (!(await this.cachedDirectoryHasFile(index, childRemotePath)))
                    continue;
                entries.set(name, {
                    name, path: childVirtualPath, relativePath: name, size: 0, modified: 0,
                    isDirectory: true, type: "folder", extension: "",
                });
                continue;
            }
            const [sizeText, modifiedText] = child.signature.split(":");
            const expectedSize = Number(sizeText);
            const stats = await fsPromises.stat(this.localCachePath(child.virtualPath)).catch(() => null);
            if (!stats?.isFile() || !Number.isFinite(expectedSize) || stats.size !== expectedSize)
                continue;
            entries.set(name, {
                name, path: childVirtualPath, relativePath: name, size: stats.size,
                modified: Number(modifiedText) || stats.mtimeMs, isDirectory: false,
                type: classifyPhoneFile(name, false), extension: path.extname(name).toLowerCase(),
            });
        }
        return Array.from(entries.values()).sort((first, second) => Number(second.isDirectory) - Number(first.isDirectory) || first.name.localeCompare(second.name));
    }
    /** Recursively lists every entry on a connected device for explicit source cloning. */
    async listPhoneFilesRecursively(virtualPath, onFile, isCancelled = () => false) {
        if (!this.parsePhonePath(virtualPath))
            return [];
        const stack = [{ path: virtualPath, relativePath: "" }];
        const visited = new Set();
        const files = [];
        while (stack.length > 0) {
            if (isCancelled())
                break;
            const current = stack.pop();
            const folderPath = current.path;
            if (visited.has(folderPath))
                continue;
            visited.add(folderPath);
            const entries = await this.listPhoneFiles(folderPath, false);
            for (const entry of entries) {
                if ((0, indexingPathPolicy_1.isPhoneDerivativePath)(entry.path))
                    continue;
                const relativePath = path.posix.join(current.relativePath, entry.name);
                const file = { ...entry, relativePath };
                if (onFile)
                    onFile(file);
                else
                    files.push(file);
                if (entry.isDirectory)
                    stack.push({ path: entry.path, relativePath });
            }
        }
        return files;
    }
    async listAndroidFiles(serial, remotePath, exploded) {
        debugLog(`[PhoneManager] listAndroidFiles: Listing files on device ${serial} at ${remotePath}, exploded: ${exploded}`);
        // First, let's test if we can access the path
        debugLog(`[PhoneManager] listAndroidFiles: Testing access to ${remotePath}`);
        const testResult = await this.run("adb", [
            "-s",
            serial,
            "shell",
            `ls ${shellQuote(remotePath)} 2>/dev/null | head -1`,
        ], 10000);
        debugLog(`[PhoneManager] listAndroidFiles: Test access result: ${testResult.ok}, sample: ${testResult.stdout.slice(0, 100)}`);
        // Resolve /sdcard symlink to /storage/emulated/0 if needed
        let actualPath = remotePath;
        if (remotePath === "/sdcard") {
            debugLog(`[PhoneManager] listAndroidFiles: /sdcard is a symlink, trying /storage/emulated/0 instead`);
            // Check if /storage/emulated/0 has content
            const emulatedTest = await this.run("adb", ["-s", serial, "shell", `ls /storage/emulated/0 2>/dev/null | head -1`], 10000);
            if (emulatedTest.ok && emulatedTest.stdout) {
                actualPath = "/storage/emulated/0";
                debugLog(`[PhoneManager] listAndroidFiles: Resolved /sdcard to ${actualPath}`);
            }
        }
        // Log the device's storage paths
        debugLog(`[PhoneManager] listAndroidFiles: Checking device storage...`);
        const storageResult = await this.run("adb", [
            "-s",
            serial,
            "shell",
            "df -h 2>/dev/null | grep -E '(sdcard|storage|emulated|data)'",
        ], 10000);
        debugLog(`[PhoneManager] listAndroidFiles: Device storage info:`, storageResult.stdout.slice(0, 500));
        // Also check what's in /sdcard
        const sdcardResult = await this.run("adb", ["-s", serial, "shell", "ls -la /sdcard 2>/dev/null | head -20"], 10000);
        debugLog(`[PhoneManager] listAndroidFiles: /sdcard contents (first 20):`, sdcardResult.stdout);
        // Also try /storage/emulated/0 which is another common path
        const emulatedResult = await this.run("adb", [
            "-s",
            serial,
            "shell",
            "ls -la /storage/emulated/0 2>/dev/null | head -20",
        ], 10000);
        debugLog(`[PhoneManager] listAndroidFiles: /storage/emulated/0 contents (first 20):`, emulatedResult.stdout);
        const findArgs = exploded
            ? `find ${shellQuote(actualPath)} -mindepth 1`
            : `find ${shellQuote(actualPath)} -mindepth 1 -maxdepth 1`;
        const command = `${findArgs} -exec stat -c '%F|%s|%Y|%n' {} + 2>/dev/null`;
        debugLog(`[PhoneManager] listAndroidFiles: Command: adb -s ${serial} shell "${command}"`);
        const result = await this.run("adb", ["-s", serial, "shell", command], exploded ? 180000 : 30000);
        debugLog(`[PhoneManager] listAndroidFiles: Command result ok: ${result.ok}, stdout length: ${result.stdout.length}`);
        if (!result.stdout) {
            debugLog(`[PhoneManager] listAndroidFiles: No stdout from command`);
            return [];
        }
        const files = [];
        const lines = result.stdout.split("\n");
        debugLog(`[PhoneManager] listAndroidFiles: Processing ${lines.length} lines`);
        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, "");
            if (!line)
                continue;
            const first = line.indexOf("|");
            const second = line.indexOf("|", first + 1);
            const third = line.indexOf("|", second + 1);
            if (first < 0 || second < 0 || third < 0) {
                debugLog(`[PhoneManager] listAndroidFiles: Skipping malformed line: ${line.slice(0, 100)}`);
                continue;
            }
            const isDirectory = line.slice(0, first) === "directory";
            const size = Number(line.slice(first + 1, second));
            const modifiedSeconds = Number(line.slice(second + 1, third));
            const fullRemotePath = line.slice(third + 1);
            if (!fullRemotePath) {
                debugLog(`[PhoneManager] listAndroidFiles: Skipping line with no path`);
                continue;
            }
            const name = fullRemotePath.split("/").filter(Boolean).pop() || fullRemotePath;
            const fileInfo = {
                name,
                path: this.virtualPath("android", serial, fullRemotePath),
                relativePath: fullRemotePath.startsWith(remotePath)
                    ? fullRemotePath.slice(remotePath.length).replace(/^\//, "")
                    : name,
                size: Number.isFinite(size) ? size : 0,
                modified: Number.isFinite(modifiedSeconds) ? modifiedSeconds * 1000 : 0,
                isDirectory,
                type: classifyPhoneFile(name, isDirectory),
                extension: isDirectory ? "" : path.extname(name).toLowerCase(),
            };
            files.push(fileInfo);
        }
        debugLog(`[PhoneManager] listAndroidFiles: Created ${files.length} file entries`);
        return files;
    }
    async iosListNames(udid, remotePath) {
        debugLog(`[PhoneManager] iosListNames: Listing names on iOS device ${udid} at ${remotePath}`);
        const result = await this.run("afcclient", ["-u", udid, "ls", remotePath], 30000);
        debugLog(`[PhoneManager] iosListNames: Command result ok: ${result.ok}, stdout length: ${result.stdout.length}`);
        if (!result.ok) {
            debugLog(`[PhoneManager] iosListNames: afcclient failed: ${result.stderr}`);
            return [];
        }
        const stripped = stripAnsi(result.stdout);
        debugLog(`[PhoneManager] iosListNames: Stripped output length: ${stripped.length}`);
        debugLog(`[PhoneManager] iosListNames: First 200 chars of output:`, stripped.slice(0, 200));
        const names = stripped
            .split("\n")
            .map((line) => line.replace(/\r$/, "").trim())
            .filter((name) => name && name !== "." && name !== "..");
        debugLog(`[PhoneManager] iosListNames: Found ${names.length} names:`, names.slice(0, 20));
        return names;
    }
    /** One afcclient session answers every stat in a directory, avoiding N spawns. */
    async iosStatBatch(udid, remotePaths) {
        debugLog(`[PhoneManager] iosStatBatch: Getting stats for ${remotePaths.length} paths on ${udid}`);
        const stats = new Map();
        if (remotePaths.length === 0) {
            debugLog(`[PhoneManager] iosStatBatch: No paths to stat`);
            return stats;
        }
        const script = `${remotePaths
            .map((remotePath) => `info "${remotePath.replace(/"/g, '\\"')}"`)
            .join("\n")}\nquit\n`;
        debugLog(`[PhoneManager] iosStatBatch: Script length: ${script.length} bytes`);
        const result = await this.run("afcclient", ["-u", udid], Math.max(30000, remotePaths.length * 60), script);
        debugLog(`[PhoneManager] iosStatBatch: Command result ok: ${result.ok}, stdout length: ${result.stdout.length}`);
        if (!result.stdout) {
            debugLog(`[PhoneManager] iosStatBatch: No stdout from afcclient`);
            return stats;
        }
        // Each info prints one flat JSON object, in command order.
        const blocks = stripAnsi(result.stdout).match(/\{[^{}]*\}/g) ?? [];
        debugLog(`[PhoneManager] iosStatBatch: Found ${blocks.length} JSON blocks`);
        if (blocks.length !== remotePaths.length) {
            debugLog(`[PhoneManager] iosStatBatch: Warning: ${blocks.length} blocks but ${remotePaths.length} paths requested`);
        }
        blocks.forEach((block, index) => {
            const remotePath = remotePaths[index];
            if (!remotePath) {
                debugLog(`[PhoneManager] iosStatBatch: No path for index ${index}`);
                return;
            }
            try {
                const parsed = JSON.parse(block);
                const stat = {
                    size: Number(parsed.st_size ?? 0),
                    // AFC reports nanoseconds.
                    modified: Math.round(Number(parsed.st_mtime ?? 0) / 1e6),
                    isDirectory: parsed.st_ifmt === "S_IFDIR",
                };
                stats.set(remotePath, stat);
                debugLog(`[PhoneManager] iosStatBatch: Stat for ${remotePath}:`, stat);
            }
            catch (error) {
                debugLog(`[PhoneManager] iosStatBatch: Failed to parse JSON for ${remotePath}:`, error);
                // Skip entries the device refused to describe.
            }
        });
        return stats;
    }
    async listIosFiles(udid, remotePath, exploded, rootPath = remotePath, depth = 0) {
        // Prevent infinite recursion on deeply nested structures
        // For backups (exploded=true), limit to depth 0 only (don't recurse at all)
        // For browsing (exploded=false), allow depth 2
        const MAX_DEPTH = exploded ? 0 : 2;
        if (depth > MAX_DEPTH) {
            debugLog(`[PhoneManager] listIosFiles: Max recursion depth (${MAX_DEPTH}) reached, stopping at ${remotePath}`);
            return [];
        }
        // Yield to event loop every 100ms to keep UI responsive during long operations
        if (depth === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        debugLog(`[PhoneManager] listIosFiles: Listing iOS files on ${udid} at ${remotePath}, exploded: ${exploded}, rootPath: ${rootPath}, depth: ${depth}`);
        const names = await this.iosListNames(udid, remotePath);
        if (names.length === 0) {
            debugLog(`[PhoneManager] listIosFiles: No names found at ${remotePath}`);
            return [];
        }
        debugLog(`[PhoneManager] listIosFiles: Got ${names.length} names from afcclient`);
        const fullPaths = names.map((name) => joinRemote(remotePath, name));
        debugLog(`[PhoneManager] listIosFiles: Full paths:`, fullPaths.slice(0, 5));
        const stats = await this.iosStatBatch(udid, fullPaths);
        debugLog(`[PhoneManager] listIosFiles: Got ${stats.size} stats back for ${fullPaths.length} paths`);
        const entries = [];
        fullPaths.forEach((fullPath, index) => {
            const name = names[index];
            let stat = stats.get(fullPath);
            // If stat is missing, infer properties from path/name
            if (!stat) {
                debugLog(`[PhoneManager] listIosFiles: No stat found for ${fullPath}, inferring from path`);
                // Assume directories if path ends with common dir patterns, otherwise files
                const isDir = fullPath.endsWith("/") ||
                    ["DCIM", "Photos", "Downloads", "Documents", "Library"].some((dir) => fullPath.includes(`/${dir}/`) || fullPath.endsWith(`/${dir}`));
                stat = {
                    size: 0,
                    modified: Date.now(),
                    isDirectory: isDir,
                };
            }
            const entry = {
                name,
                path: this.virtualPath("ios", udid, fullPath),
                relativePath: fullPath.startsWith(rootPath)
                    ? fullPath.slice(rootPath.length).replace(/^\//, "")
                    : name,
                size: stat.size,
                modified: stat.modified,
                isDirectory: stat.isDirectory,
                type: classifyPhoneFile(name, stat.isDirectory),
                extension: stat.isDirectory ? "" : path.extname(name).toLowerCase(),
            };
            entries.push(entry);
        });
        debugLog(`[PhoneManager] listIosFiles: Created ${entries.length} entries, ${entries.filter((e) => e.isDirectory).length} directories, ${entries.filter((e) => !e.isDirectory).length} files`);
        if (!exploded) {
            debugLog(`[PhoneManager] listIosFiles: Returning non-exploded entries (${entries.length})`);
            return entries;
        }
        debugLog(`[PhoneManager] listIosFiles: Exploding directories...`);
        const files = entries.filter((entry) => !entry.isDirectory);
        debugLog(`[PhoneManager] listIosFiles: ${files.length} files, ${entries.length - files.length} directories`);
        for (const entry of entries.filter((item) => item.isDirectory)) {
            debugLog(`[PhoneManager] listIosFiles: Processing directory: ${entry.path}`);
            const parsed = this.parsePhonePath(entry.path);
            if (!parsed) {
                debugLog(`[PhoneManager] listIosFiles: Failed to parse directory path: ${entry.path}`);
                continue;
            }
            const subFiles = await this.listIosFiles(udid, parsed.remotePath, true, rootPath, depth + 1);
            debugLog(`[PhoneManager] listIosFiles: Found ${subFiles.length} files in ${parsed.remotePath}`);
            files.push(...subFiles);
        }
        debugLog(`[PhoneManager] listIosFiles: Total files after exploding: ${files.length}`);
        return files;
    }
    // -------------------------------------------------------------- downloading
    /** Copies a device file into the local cache so normal file code paths work. */
    async materialize(candidate, force = false) {
        debugLog(`[PhoneManager] materialize: Materializing ${candidate}`);
        const parsed = this.parsePhonePath(candidate);
        if (!parsed) {
            debugLog(`[PhoneManager] materialize: Not a phone path, returning as-is`);
            return candidate;
        }
        const { platform, deviceId, remotePath } = parsed;
        debugLog(`[PhoneManager] materialize: Platform: ${platform}, device: ${deviceId}, remote: ${remotePath}`);
        const localPath = this.localCachePath(candidate);
        debugLog(`[PhoneManager] materialize: Local cache path: ${localPath}`);
        if (parsed.offlineBackup) {
            const stats = await fsPromises.stat(localPath).catch(() => null);
            if (stats?.isFile())
                return localPath;
            throw new Error(`This file is missing from the saved phone copy: ${remotePath}`);
        }
        try {
            if (force)
                throw new Error("refresh requested");
            await fsPromises.access(localPath);
            debugLog(`[PhoneManager] materialize: File already cached at ${localPath}`);
            return localPath;
        }
        catch {
            debugLog(`[PhoneManager] materialize: File not in cache, pulling...`);
            await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
            if (force)
                await fsPromises.rm(localPath, { force: true });
        }
        const pulled = platform === "android"
            ? await this.run("adb", ["-s", deviceId, "pull", remotePath, localPath], 120000)
            : await this.run("afcclient", ["-u", deviceId, "get", remotePath, localPath], 120000);
        if (!pulled.ok) {
            console.error(`[PhoneManager] materialize: Failed to pull file: ${pulled.stderr}`);
            throw new Error(`Could not read file from device: ${remotePath}`);
        }
        debugLog(`[PhoneManager] materialize: Successfully pulled file to ${localPath}`);
        return localPath;
    }
    async statPhoneFile(candidate) {
        debugLog(`[PhoneManager] statPhoneFile: Getting stat for ${candidate}`);
        const parsed = this.parsePhonePath(candidate);
        if (!parsed) {
            debugLog(`[PhoneManager] statPhoneFile: Not a phone path`);
            return null;
        }
        const { platform, deviceId, remotePath } = parsed;
        const name = remotePath.split("/").filter(Boolean).pop() || remotePath;
        debugLog(`[PhoneManager] statPhoneFile: Platform: ${platform}, device: ${deviceId}, remote: ${remotePath}, name: ${name}`);
        if (parsed.offlineBackup) {
            const localPath = this.localCachePath(candidate);
            const stats = await fsPromises.stat(localPath).catch(() => null);
            if (!stats?.isFile())
                return null;
            return {
                name,
                path: candidate,
                relativePath: name,
                size: stats.size,
                modified: stats.mtimeMs,
                isDirectory: false,
                type: classifyPhoneFile(name, false),
                extension: path.extname(name).toLowerCase(),
            };
        }
        if (platform === "ios") {
            debugLog(`[PhoneManager] statPhoneFile: Getting iOS stat for ${remotePath}`);
            const stats = await this.iosStatBatch(deviceId, [remotePath]);
            const stat = stats.get(remotePath);
            if (!stat) {
                debugLog(`[PhoneManager] statPhoneFile: No stat found for ${remotePath}`);
                return null;
            }
            const result = {
                name,
                path: candidate,
                relativePath: name,
                size: stat.size,
                modified: stat.modified,
                isDirectory: stat.isDirectory,
                type: classifyPhoneFile(name, stat.isDirectory),
                extension: stat.isDirectory ? "" : path.extname(name).toLowerCase(),
            };
            debugLog(`[PhoneManager] statPhoneFile: Stat result:`, result);
            return result;
        }
        debugLog(`[PhoneManager] statPhoneFile: Getting Android stat for ${remotePath}`);
        const result = await this.run("adb", [
            "-s",
            deviceId,
            "shell",
            `stat -c '%F|%s|%Y|%n' ${shellQuote(remotePath)} 2>/dev/null`,
        ], 15000);
        debugLog(`[PhoneManager] statPhoneFile: Command result ok: ${result.ok}`);
        const line = result.stdout.split("\n")[0]?.replace(/\r$/, "");
        if (!line) {
            debugLog(`[PhoneManager] statPhoneFile: No output from stat command`);
            return null;
        }
        debugLog(`[PhoneManager] statPhoneFile: Stat output: ${line}`);
        const first = line.indexOf("|");
        const second = line.indexOf("|", first + 1);
        const third = line.indexOf("|", second + 1);
        if (first < 0 || second < 0 || third < 0) {
            debugLog(`[PhoneManager] statPhoneFile: Malformed stat output: ${line}`);
            return null;
        }
        const isDirectory = line.slice(0, first) === "directory";
        const fileInfo = {
            name,
            path: candidate,
            relativePath: name,
            size: Number(line.slice(first + 1, second)) || 0,
            modified: (Number(line.slice(second + 1, third)) || 0) * 1000,
            isDirectory,
            type: classifyPhoneFile(name, isDirectory),
            extension: isDirectory ? "" : path.extname(name).toLowerCase(),
        };
        debugLog(`[PhoneManager] statPhoneFile: Stat result:`, fileInfo);
        return fileInfo;
    }
}
exports.PhoneManager = PhoneManager;
