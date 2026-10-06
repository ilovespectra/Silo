"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioLibraryCache = void 0;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const indexingPathPolicy_1 = require("./indexingPathPolicy");
class AudioLibraryCache {
    constructor(userDataPath) {
        this.snapshot = {
            version: 1,
            sourceIds: [],
            scannedAt: 0,
            files: [],
            extensions: [],
        };
        this.scanPromise = null;
        this.cancelled = false;
        this.sourceCooldowns = new Map();
        this.cachePath = path_1.default.join(userDataPath, "audio-library-index.json");
    }
    async initialize() {
        await fs_1.promises.mkdir(path_1.default.dirname(this.cachePath), { recursive: true });
        try {
            const stored = JSON.parse(await fs_1.promises.readFile(this.cachePath, "utf8"));
            if (stored.version === 1 && Array.isArray(stored.files))
                this.snapshot = {
                    version: 1,
                    sourceIds: Array.isArray(stored.sourceIds) ? stored.sourceIds : [],
                    scannedAt: Number(stored.scannedAt) || 0,
                    files: stored.files.filter((file) => file && typeof file.path === "string"),
                    extensions: Array.isArray(stored.extensions) ? stored.extensions : [],
                    failedSources: Array.isArray(stored.failedSources)
                        ? stored.failedSources
                        : [],
                    sourceErrors: stored.sourceErrors ?? {},
                    sourceScannedAt: stored.sourceScannedAt ?? {},
                    sourceCooldownUntil: stored.sourceCooldownUntil ?? {},
                };
            this.sourceCooldowns = new Map(Object.entries(this.snapshot.sourceCooldownUntil ?? {}));
        }
        catch {
            // First launch: an empty cache will be populated on the audio screen.
        }
    }
    getSnapshot() {
        return {
            ...this.snapshot,
            files: this.snapshot.files,
            sourceIds: [...this.snapshot.sourceIds],
            extensions: [...this.snapshot.extensions],
            failedSources: [...(this.snapshot.failedSources ?? [])],
        };
    }
    cancelScan() {
        this.cancelled = true;
    }
    async scan(sources, isRemotePath, isAudio, listRemoteFiles, onProgress, force = false) {
        if (this.scanPromise)
            return this.scanPromise;
        this.cancelled = false;
        if (force)
            for (const source of sources)
                this.sourceCooldowns.delete(source.id);
        const pending = this.scanImpl(sources, isRemotePath, isAudio, listRemoteFiles, onProgress, force).finally(() => {
            this.scanPromise = null;
        });
        this.scanPromise = pending;
        return pending;
    }
    async scanImpl(sources, isRemotePath, isAudio, listRemoteFiles, onProgress, force) {
        const sourceIds = sources.map((source) => source.id);
        const next = new Map(this.snapshot.files
            .filter((file) => file.sourceId && sourceIds.includes(file.sourceId))
            .map((file) => [file.path, file]));
        const failedSources = new Set((this.snapshot.failedSources ?? []).filter((id) => sourceIds.includes(id)));
        const sourceScannedAt = { ...(this.snapshot.sourceScannedAt ?? {}) };
        const sourceErrors = { ...(this.snapshot.sourceErrors ?? {}) };
        for (const [sourceIndex, source] of sources.entries()) {
            if (this.cancelled)
                return this.getSnapshot();
            const previousScan = sourceScannedAt[source.id] ?? 0;
            const sourceIsFresh = previousScan > 0 && Date.now() - previousScan < 24 * 60 * 60 * 1000;
            if (sourceIsFresh && !force && !failedSources.has(source.id)) {
                const cachedCount = Array.from(next.values()).filter((file) => file.sourceId === source.id).length;
                onProgress({
                    source: source.label,
                    scanned: cachedCount,
                    audioFound: cachedCount,
                    sourceIndex: sourceIndex + 1,
                    sourceCount: sources.length,
                    phase: "source-complete",
                    message: `Using cached inventory for ${source.label} (${cachedCount.toLocaleString()} audio files).`,
                });
                continue;
            }
            const retryAt = this.sourceCooldowns.get(source.id) ?? 0;
            if (retryAt > Date.now() && !force) {
                failedSources.add(source.id);
                onProgress({
                    source: source.label,
                    scanned: 0,
                    audioFound: 0,
                    sourceIndex: sourceIndex + 1,
                    sourceCount: sources.length,
                    phase: "cooldown",
                    message: `${source.label} retry cooling down until ${new Date(retryAt).toLocaleTimeString()}; keeping its cached results.`,
                });
                continue;
            }
            let audioFound = 0;
            let scanned = 0;
            let succeeded = false;
            let lastError;
            for (let attempt = 0; attempt < 3 && !succeeded; attempt += 1) {
                if (attempt > 0) {
                    onProgress({
                        source: source.label,
                        scanned,
                        audioFound,
                        sourceIndex: sourceIndex + 1,
                        sourceCount: sources.length,
                        phase: "retrying",
                        message: `Retry ${attempt} of 2 for ${source.label}…`,
                    });
                    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
                }
                if (this.cancelled)
                    return this.getSnapshot();
                scanned = 0;
                audioFound = 0;
                const sourceFiles = new Map();
                try {
                    if (isRemotePath(source.rootPath)) {
                        const remoteFiles = await listRemoteFiles(source);
                        for (const file of remoteFiles) {
                            if (this.cancelled)
                                return this.getSnapshot();
                            scanned += 1;
                            if (!file.isDirectory &&
                                (file.type === "audio" || isAudio(file.name))) {
                                sourceFiles.set(file.path, {
                                    ...file,
                                    type: "audio",
                                    extension: path_1.default.extname(file.name).toLowerCase(),
                                    sourceId: source.id,
                                    sourceLabel: source.label,
                                });
                                audioFound += 1;
                            }
                        }
                    }
                    else {
                        const appDataPath = path_1.default.resolve(path_1.default.dirname(this.cachePath));
                        const canonicalAppDataPath = await fs_1.promises
                            .realpath(appDataPath)
                            .catch(() => appDataPath);
                        const canonicalSourcePath = await fs_1.promises
                            .realpath(source.rootPath)
                            .catch(() => path_1.default.resolve(source.rootPath));
                        const isSiloAppData = (candidatePath) => (0, indexingPathPolicy_1.isAppDataPath)(candidatePath, source.rootPath, canonicalSourcePath, appDataPath, canonicalAppDataPath);
                        if (isSiloAppData(source.rootPath)) {
                            succeeded = true;
                            sourceScannedAt[source.id] = Date.now();
                            for (const [filePath, file] of next)
                                if (file.sourceId === source.id)
                                    next.delete(filePath);
                            break;
                        }
                        if (await (0, indexingPathPolicy_1.isSiloCloneDirectory)(source.rootPath)) {
                            succeeded = true;
                            sourceScannedAt[source.id] = Date.now();
                            for (const [filePath, file] of next)
                                if (file.sourceId === source.id)
                                    next.delete(filePath);
                            break;
                        }
                        const stack = [{ directory: source.rootPath, relativePath: "" }];
                        const visitedDirectories = new Set();
                        let unreadableEntries = 0;
                        let rootOpened = false;
                        while (stack.length > 0) {
                            if (this.cancelled)
                                return this.getSnapshot();
                            const current = stack.pop();
                            if (isSiloAppData(current.directory))
                                continue;
                            if (await (0, indexingPathPolicy_1.isSiloCloneDirectory)(current.directory))
                                continue;
                            let directory;
                            try {
                                const realDirectory = await fs_1.promises.realpath(current.directory);
                                if (visitedDirectories.has(realDirectory))
                                    continue;
                                visitedDirectories.add(realDirectory);
                                directory = await fs_1.promises.opendir(current.directory);
                                if (current.directory === source.rootPath)
                                    rootOpened = true;
                            }
                            catch (error) {
                                if (current.directory === source.rootPath)
                                    throw error;
                                unreadableEntries += 1;
                                continue;
                            }
                            for await (const entry of directory) {
                                if (this.cancelled)
                                    return this.getSnapshot();
                                const fullPath = path_1.default.join(current.directory, entry.name);
                                if (isSiloAppData(fullPath))
                                    continue;
                                if (entry.isDirectory() && await (0, indexingPathPolicy_1.isSiloCloneDirectory)(fullPath))
                                    continue;
                                const relativePath = path_1.default.join(current.relativePath, entry.name);
                                let stats;
                                try {
                                    stats = await fs_1.promises.stat(fullPath);
                                }
                                catch {
                                    unreadableEntries += 1;
                                    continue;
                                }
                                scanned += 1;
                                if (stats.isDirectory()) {
                                    stack.push({ directory: fullPath, relativePath });
                                }
                                else if (stats.isFile() && isAudio(entry.name)) {
                                    sourceFiles.set(fullPath, {
                                        name: entry.name,
                                        path: fullPath,
                                        relativePath,
                                        size: stats.size,
                                        modified: stats.mtimeMs,
                                        isDirectory: false,
                                        type: "audio",
                                        extension: path_1.default.extname(entry.name).toLowerCase(),
                                        sourceId: source.id,
                                        sourceLabel: source.label,
                                    });
                                    audioFound += 1;
                                }
                                if (scanned % 500 === 0)
                                    onProgress({
                                        source: source.label,
                                        scanned,
                                        audioFound,
                                        sourceIndex: sourceIndex + 1,
                                        sourceCount: sources.length,
                                        phase: "scanning",
                                        message: `Scanning ${source.label}: ${scanned.toLocaleString()} entries, ${audioFound.toLocaleString()} audio files…`,
                                    });
                            }
                        }
                        if (!rootOpened)
                            throw new Error(`Source unavailable: ${source.rootPath}`);
                        if (unreadableEntries > 0) {
                            // Keep discovered files and older records, but never mark partial
                            // coverage as fresh. Retry this source after the cooldown.
                            for (const [filePath, file] of sourceFiles)
                                next.set(filePath, file);
                            throw new Error(`${unreadableEntries} entries could not be read; partial audio results retained.`);
                        }
                    }
                    // Replace this source atomically only after its scan completed successfully.
                    for (const [filePath, file] of next)
                        if (file.sourceId === source.id)
                            next.delete(filePath);
                    for (const [filePath, file] of sourceFiles)
                        next.set(filePath, file);
                    succeeded = true;
                }
                catch (error) {
                    lastError = error;
                    if (error instanceof Error &&
                        error.message.startsWith("DRIVE_PERMISSION_REQUIRED:"))
                        break;
                }
            }
            if (succeeded) {
                failedSources.delete(source.id);
                delete sourceErrors[source.id];
                this.sourceCooldowns.delete(source.id);
                sourceScannedAt[source.id] = Date.now();
                onProgress({
                    source: source.label,
                    scanned,
                    audioFound,
                    sourceIndex: sourceIndex + 1,
                    sourceCount: sources.length,
                    phase: "source-complete",
                    message: `Scanned ${source.label}: ${audioFound.toLocaleString()} audio files.`,
                });
            }
            else {
                failedSources.add(source.id);
                sourceErrors[source.id] = {
                    message: lastError instanceof Error ? lastError.message : String(lastError),
                    lastAttemptAt: Date.now(),
                };
                this.sourceCooldowns.set(source.id, Date.now() + 5 * 60 * 1000);
                onProgress({
                    source: source.label,
                    scanned,
                    audioFound,
                    sourceIndex: sourceIndex + 1,
                    sourceCount: sources.length,
                    phase: "cooldown",
                    message: `${source.label} failed after retries; keeping its previous cached results. ${lastError instanceof Error ? lastError.message : String(lastError)}`,
                });
            }
            // Checkpoint each completed source; a later source failure no longer discards prior work.
            const checkpointFiles = Array.from(next.values());
            const checkpointExtensions = Array.from(new Set(checkpointFiles.map((file) => file.extension || "(no extension)"))).sort((first, second) => first.localeCompare(second));
            this.snapshot = {
                version: 1,
                sourceIds: sources.map((item) => item.id),
                scannedAt: failedSources.size === 0 &&
                    sourceIds.every((id) => sourceScannedAt[id])
                    ? Date.now()
                    : 0,
                files: checkpointFiles,
                extensions: checkpointExtensions,
                failedSources: Array.from(failedSources),
                sourceScannedAt,
                sourceErrors,
                sourceCooldownUntil: Object.fromEntries(this.sourceCooldowns),
            };
            await this.persistSnapshot();
        }
        const files = Array.from(next.values()).sort((first, second) => (second.modified || 0) - (first.modified || 0) ||
            first.path.localeCompare(second.path));
        const extensions = Array.from(new Set(files.map((file) => file.extension || "(no extension)"))).sort((first, second) => first.localeCompare(second));
        this.snapshot = {
            version: 1,
            sourceIds: sources.map((source) => source.id),
            scannedAt: failedSources.size === 0 && sourceIds.every((id) => sourceScannedAt[id])
                ? Date.now()
                : 0,
            files,
            extensions,
            failedSources: Array.from(failedSources),
            sourceScannedAt,
            sourceErrors,
            sourceCooldownUntil: Object.fromEntries(this.sourceCooldowns),
        };
        await this.persistSnapshot();
        return this.getSnapshot();
    }
    async persistSnapshot() {
        const temporary = `${this.cachePath}.tmp`;
        await fs_1.promises.writeFile(temporary, JSON.stringify(this.snapshot));
        await fs_1.promises.rename(temporary, this.cachePath);
    }
}
exports.AudioLibraryCache = AudioLibraryCache;
