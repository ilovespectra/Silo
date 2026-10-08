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
exports.prepareConfiguredIndexStorage = exports.prepareExternalIndexStorage = exports.migrateIndexStorageEntries = exports.migrateIndexStorageRoots = exports.validateIndexStorageDestination = exports.ExternalIndexStorageUnavailableError = exports.INDEX_STORAGE_ENTRIES = exports.stageIndexStorageRoot = exports.writeIndexStorageRoot = exports.setLocalIndexStorageFallback = exports.getIndexStorageSettings = exports.readIndexStorageRoot = exports.createIndexStoragePathResolver = exports.getActiveIndexStorageRoot = exports.getLocalFallbackIndexStorageRoot = exports.getIndexStorageExclusionRoots = exports.setIndexStorageExclusionRoots = exports.setActiveIndexStorageRoot = exports.assertLocalIndexStorageCapacity = exports.getLocalIndexStorageFreeBytes = exports.LOCAL_INDEX_STORAGE_RESERVE_BYTES = void 0;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const INDEX_STORAGE_SETTINGS_FILE = "index-storage.json";
exports.LOCAL_INDEX_STORAGE_RESERVE_BYTES = 10 * 1024 * 1024 * 1024;
function freeBytesAt(storageRoot) {
    return fsPromises.statfs(storageRoot).then((stats) => stats.bavail * stats.bsize);
}
async function migrationBytes(sourceRoots) {
    let requiredBytes = 0;
    for (const sourceRoot of new Set(sourceRoots.map((root) => path.resolve(root)))) {
        for (const entry of exports.INDEX_STORAGE_ENTRIES) {
            const source = path.join(sourceRoot, entry);
            if (await exists(source))
                requiredBytes += (await summarizeTree(source)).bytes;
        }
    }
    return requiredBytes;
}
async function getLocalIndexStorageFreeBytes(storageRoot) {
    return freeBytesAt(storageRoot);
}
exports.getLocalIndexStorageFreeBytes = getLocalIndexStorageFreeBytes;
async function assertLocalIndexStorageCapacity(storageRoot, additionalBytes = 0) {
    const freeBytes = await freeBytesAt(storageRoot);
    if (freeBytes < exports.LOCAL_INDEX_STORAGE_RESERVE_BYTES + additionalBytes)
        throw new Error(`Local cache fallback is paused to preserve at least ${Math.round(exports.LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB of free space. Reconnect the selected destination or free space.`);
    return freeBytes;
}
exports.assertLocalIndexStorageCapacity = assertLocalIndexStorageCapacity;
let activeIndexStorageRoot = "";
let indexStorageExclusionRoots = [];
function canonicalizeStoragePath(storageRoot) {
    const resolved = path.resolve(storageRoot);
    try {
        return fs_1.realpathSync.native(resolved);
    }
    catch {
        return resolved;
    }
}
function setActiveIndexStorageRoot(storageRoot) {
    const resolved = path.resolve(storageRoot);
    activeIndexStorageRoot = canonicalizeStoragePath(resolved);
    indexStorageExclusionRoots = [resolved];
}
exports.setActiveIndexStorageRoot = setActiveIndexStorageRoot;
function setIndexStorageExclusionRoots(storageRoots) {
    indexStorageExclusionRoots = Array.from(new Set(storageRoots.map((storageRoot) => path.resolve(storageRoot))));
}
exports.setIndexStorageExclusionRoots = setIndexStorageExclusionRoots;
function getIndexStorageExclusionRoots() {
    return Array.from(new Set(indexStorageExclusionRoots.flatMap((storageRoot) => [
        storageRoot,
        canonicalizeStoragePath(storageRoot),
    ])));
}
exports.getIndexStorageExclusionRoots = getIndexStorageExclusionRoots;
function getLocalFallbackIndexStorageRoot(userDataPath) {
    const resolvedUserDataPath = path.resolve(userDataPath);
    return path.join(path.dirname(resolvedUserDataPath), `${path.basename(resolvedUserDataPath)}-local-index-fallback`);
}
exports.getLocalFallbackIndexStorageRoot = getLocalFallbackIndexStorageRoot;
function getLegacyLocalFallbackIndexStorageRoot(userDataPath) {
    return path.join(path.resolve(userDataPath), ".silo-local-fallback-index");
}
function getActiveIndexStorageRoot() {
    return activeIndexStorageRoot;
}
exports.getActiveIndexStorageRoot = getActiveIndexStorageRoot;
function createIndexStoragePathResolver(getStorageRoot) {
    return (...segments) => path.join(getStorageRoot(), ...segments);
}
exports.createIndexStoragePathResolver = createIndexStoragePathResolver;
async function readIndexStorageRoot(userDataPath) {
    return (await readIndexStorageSettings(userDataPath)).path;
}
exports.readIndexStorageRoot = readIndexStorageRoot;
async function getIndexStorageSettings(userDataPath) {
    const settings = await readIndexStorageSettings(userDataPath);
    return {
        path: settings.path,
        allowLocalFallback: settings.allowLocalFallback !== false,
    };
}
exports.getIndexStorageSettings = getIndexStorageSettings;
async function setLocalIndexStorageFallback(userDataPath, enabled) {
    const settings = await readIndexStorageSettings(userDataPath);
    const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
    const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify({ ...settings, allowLocalFallback: enabled }, null, 2), { mode: 0o600 });
    await fsPromises.rename(temporaryPath, settingsPath);
    return enabled;
}
exports.setLocalIndexStorageFallback = setLocalIndexStorageFallback;
async function readIndexStorageSettings(userDataPath) {
    const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
    let settings;
    try {
        settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return {
                format: "silo-index-storage",
                version: 1,
                path: path.resolve(userDataPath),
                allowLocalFallback: true,
            };
        throw new Error(`Could not read the index storage setting: ${String(error)}`);
    }
    const storedPath = settings?.path;
    const pendingPath = settings?.pendingPath;
    const allowLocalFallback = settings
        ?.allowLocalFallback;
    if (settings?.format !== "silo-index-storage" ||
        settings?.version !== 1 ||
        typeof storedPath !== "string" ||
        !path.isAbsolute(storedPath))
        throw new Error("The saved index storage setting is invalid.");
    if (pendingPath !== undefined &&
        (typeof pendingPath !== "string" || !path.isAbsolute(pendingPath)))
        throw new Error("The pending index storage setting is invalid.");
    if (allowLocalFallback !== undefined &&
        typeof allowLocalFallback !== "boolean")
        throw new Error("The local fallback preference is invalid.");
    return {
        format: "silo-index-storage",
        version: 1,
        path: path.resolve(storedPath),
        ...(typeof pendingPath === "string"
            ? { pendingPath: path.resolve(pendingPath) }
            : {}),
        ...(typeof allowLocalFallback === "boolean" ? { allowLocalFallback } : {}),
    };
}
async function writeIndexStorageRoot(userDataPath, storageRoot) {
    if (!path.isAbsolute(storageRoot))
        throw new Error("Index storage path must be absolute.");
    const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
    const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
    const currentSettings = await readIndexStorageSettings(userDataPath);
    await fsPromises.writeFile(temporaryPath, JSON.stringify({
        ...currentSettings,
        format: "silo-index-storage",
        version: 1,
        path: path.resolve(storageRoot),
        pendingPath: undefined,
    }, null, 2), { mode: 0o600 });
    await fsPromises.rename(temporaryPath, settingsPath);
}
exports.writeIndexStorageRoot = writeIndexStorageRoot;
async function stageIndexStorageRoot(userDataPath, storageRoot) {
    if (!path.isAbsolute(storageRoot))
        throw new Error("Index storage path must be absolute.");
    const settings = await readIndexStorageSettings(userDataPath);
    const nextRoot = path.resolve(storageRoot);
    if (settings.pendingPath)
        throw new Error("An index storage move is already waiting for restart.");
    if (nextRoot === settings.path)
        return false;
    if (path.resolve(settings.path) !== path.resolve(userDataPath) &&
        (isPathWithin(nextRoot, settings.path) ||
            isPathWithin(settings.path, nextRoot)))
        throw new Error("Choose a cache folder separate from the current cache folder.");
    await validateExternalVolume(userDataPath, nextRoot);
    const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
    const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify({ ...settings, pendingPath: nextRoot }, null, 2), { mode: 0o600 });
    await fsPromises.rename(temporaryPath, settingsPath);
    return true;
}
exports.stageIndexStorageRoot = stageIndexStorageRoot;
exports.INDEX_STORAGE_ENTRIES = [
    "semantic-index",
    "face-index",
    "pets",
    "thumbnail-cache",
    "preview-cache",
    "media-cache",
    "memory-image-cache",
    "cloud-cache",
    "geo-index.jsonl",
    "geocode-cache.json",
    "geocode-search-cache.json",
    "duplicate-index.json",
    "aesthetic-index.jsonl",
    "content-safety-index.json",
    "audio-library-index.json",
    "library-stats.json",
];
async function exists(target) {
    return fsPromises.lstat(target).then(() => true, (error) => {
        if (error.code === "ENOENT")
            return false;
        throw error;
    });
}
async function hashFile(filePath) {
    const hash = (0, crypto_1.createHash)("sha256");
    await new Promise((resolve, reject) => {
        const input = (0, fs_1.createReadStream)(filePath);
        input.on("data", (chunk) => hash.update(chunk));
        input.on("error", reject);
        input.on("end", resolve);
    });
    return hash.digest("hex");
}
async function getExistingAncestor(targetPath) {
    let ancestor = path.resolve(targetPath);
    while (!(await exists(ancestor))) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor)
            throw new Error(`No existing parent directory for index storage: ${targetPath}`);
        ancestor = parent;
    }
    return ancestor;
}
function isPathWithin(candidatePath, rootPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
    return (relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)));
}
class ExternalIndexStorageUnavailableError extends Error {
    constructor(storageRoot) {
        super(`Could not open the selected external storage drive at ${storageRoot}. Indexing is paused for that drive.`);
        this.storageRoot = storageRoot;
        this.name = "ExternalIndexStorageUnavailableError";
    }
}
exports.ExternalIndexStorageUnavailableError = ExternalIndexStorageUnavailableError;
async function validateExternalVolume(userDataPath, storageRoot) {
    if (isPathWithin(storageRoot, userDataPath) ||
        isPathWithin(userDataPath, storageRoot))
        throw new Error("External index storage must be separate from Silo app data.");
    const [existingAncestor, userData] = await Promise.all([
        getExistingAncestor(storageRoot),
        fsPromises.stat(userDataPath),
    ]);
    const volume = await fsPromises.stat(existingAncestor);
    if (volume.dev === userData.dev) {
        if (!(await exists(storageRoot)))
            throw new ExternalIndexStorageUnavailableError(storageRoot);
        throw new Error(`The selected index storage must be on a separate external volume: ${storageRoot}.`);
    }
}
async function validateIndexStorageDestination(userDataPath, storageRoot) {
    await validateExternalVolume(userDataPath, storageRoot);
    const settings = await readIndexStorageSettings(userDataPath);
    if (path.resolve(settings.path) !== path.resolve(userDataPath) &&
        (isPathWithin(storageRoot, settings.path) ||
            isPathWithin(settings.path, storageRoot)))
        throw new Error("Choose a cache folder separate from the current cache folder.");
    const sourceRoots = new Set([settings.path, path.resolve(userDataPath)]);
    let requiredBytes = 0;
    for (const sourceRoot of sourceRoots) {
        for (const entry of exports.INDEX_STORAGE_ENTRIES) {
            const source = path.join(sourceRoot, entry);
            if (await exists(source))
                requiredBytes += (await summarizeTree(source)).bytes;
        }
    }
    await assertEnoughSpace(storageRoot, requiredBytes);
    return { requiredBytes };
}
exports.validateIndexStorageDestination = validateIndexStorageDestination;
async function assertEnoughSpace(root, requiredBytes) {
    const stats = await fsPromises.statfs(root);
    const availableBytes = stats.bavail * stats.bsize;
    const reserveBytes = 512 * 1024 * 1024;
    if (availableBytes < requiredBytes + reserveBytes)
        throw new Error(`The selected drive does not have enough free space for the verified index migration. Required: ${requiredBytes.toLocaleString()} bytes plus a 512 MiB safety margin.`);
}
async function summarizeTree(target) {
    const stats = await fsPromises.lstat(target);
    if (stats.isSymbolicLink())
        throw new Error(`Index storage migration refuses symbolic links: ${target}`);
    if (stats.isFile())
        return { files: 1, bytes: stats.size };
    if (!stats.isDirectory())
        throw new Error(`Unsupported item in index storage: ${target}`);
    const total = { files: 0, bytes: 0 };
    for (const name of await fsPromises.readdir(target)) {
        const child = await summarizeTree(path.join(target, name));
        total.files += child.files;
        total.bytes += child.bytes;
    }
    return total;
}
async function collectMigrationNodes(source, target, staged, nodes) {
    const stats = await fsPromises.lstat(source);
    if (stats.isSymbolicLink())
        throw new Error(`Index storage migration refuses symbolic links: ${source}`);
    if (stats.isDirectory()) {
        nodes.push({ source, target, staged, kind: "directory", size: 0 });
        const names = (await fsPromises.readdir(source)).sort();
        for (const name of names)
            await collectMigrationNodes(path.join(source, name), path.join(target, name), path.join(staged, name), nodes);
        return;
    }
    if (!stats.isFile())
        throw new Error(`Unsupported item in index storage: ${source}`);
    nodes.push({ source, target, staged, kind: "file", size: stats.size });
}
function migrationNodeKey(node) {
    return `${path.resolve(node.source)}\u0000${node.kind}`;
}
async function assertTargetMatches(node) {
    if (!(await exists(node.target)))
        return false;
    const stats = await fsPromises.lstat(node.target);
    if (stats.isSymbolicLink())
        throw new Error(`Index storage destination refuses symbolic links: ${node.target}`);
    if (node.kind === "directory") {
        if (!stats.isDirectory())
            throw new Error(`Index storage destination conflicts with ${node.source}`);
        return true;
    }
    if (!stats.isFile())
        throw new Error(`Index storage destination conflicts with ${node.source}`);
    const destinationHash = await hashFile(node.target);
    if (stats.size !== node.size || destinationHash !== node.hash)
        throw new Error(`Index storage contains different files at ${node.target}; the local original was preserved.`);
    return true;
}
async function migrateIndexStorageRoots(sourceRoots, storageRoot, entries = exports.INDEX_STORAGE_ENTRIES, onProgress, beforeSourceRemoval) {
    const destinationRoot = path.resolve(storageRoot);
    const sources = Array.from(new Set(sourceRoots.map((source) => path.resolve(source))))
        .filter((source) => source !== destinationRoot);
    for (const source of sources) {
        if (isPathWithin(source, destinationRoot) || isPathWithin(destinationRoot, source))
            throw new Error("Index storage migration source and destination must be separate.");
    }
    await fsPromises.mkdir(destinationRoot, { recursive: true });
    const sourceEntries = [];
    const nodes = [];
    let requiredBytes = 0;
    for (let rootIndex = 0; rootIndex < sources.length; rootIndex += 1) {
        const sourceRoot = sources[rootIndex];
        for (const name of entries) {
            const source = path.join(sourceRoot, name);
            if (!(await exists(source)))
                continue;
            const staged = path.join(destinationRoot, `.silo-index-migration-${process.pid}`, String(rootIndex), name);
            const before = nodes.length;
            await collectMigrationNodes(source, path.join(destinationRoot, name), staged, nodes);
            sourceEntries.push(source);
            for (const node of nodes.slice(before))
                if (node.kind === "file")
                    requiredBytes += node.size;
        }
    }
    await assertEnoughSpace(destinationRoot, requiredBytes);
    if (nodes.length === 0) {
        await beforeSourceRemoval?.();
        return { filesVerified: 0, bytesVerified: 0 };
    }
    const stagingRoot = path.join(destinationRoot, `.silo-index-migration-${process.pid}-${(0, crypto_1.randomBytes)(8).toString("hex")}`);
    const stagedNodes = nodes.map((node) => ({
        ...node,
        staged: node.staged.replace(path.join(destinationRoot, `.silo-index-migration-${process.pid}`), stagingRoot),
    }));
    const progress = { filesVerified: 0, bytesVerified: 0 };
    try {
        for (const node of stagedNodes) {
            if (node.kind === "directory") {
                await fsPromises.mkdir(node.staged, { recursive: true });
                continue;
            }
            await fsPromises.mkdir(path.dirname(node.staged), { recursive: true });
            await fsPromises.copyFile(node.source, node.staged);
            const [sourceHash, stagedHash, stagedStats] = await Promise.all([
                hashFile(node.source),
                hashFile(node.staged),
                fsPromises.stat(node.staged),
            ]);
            if (node.size !== stagedStats.size || sourceHash !== stagedHash)
                throw new Error(`Checksum verification failed for ${node.source}; the local original was preserved.`);
            node.hash = sourceHash;
            progress.filesVerified += 1;
            progress.bytesVerified += node.size;
            if (progress.filesVerified % 500 === 0)
                onProgress?.(progress.filesVerified, progress.bytesVerified);
        }
        const byTarget = new Map();
        for (const node of stagedNodes) {
            const key = path.resolve(node.target);
            const previous = byTarget.get(key);
            if (previous) {
                if (previous.kind !== node.kind ||
                    (node.kind === "file" && (previous.size !== node.size || previous.hash !== node.hash)))
                    throw new Error(`Index storage sources contain conflicting data at ${node.target}; all originals were preserved.`);
            }
            else {
                byTarget.set(key, node);
            }
            await assertTargetMatches(node);
        }
        for (const node of Array.from(byTarget.values())
            .filter((entry) => entry.kind === "directory")
            .sort((first, second) => first.target.length - second.target.length)) {
            if (!(await assertTargetMatches(node)))
                await fsPromises.mkdir(node.target, { recursive: true });
        }
        for (const node of byTarget.values()) {
            if (node.kind !== "file" || await assertTargetMatches(node))
                continue;
            await fsPromises.mkdir(path.dirname(node.target), { recursive: true });
            await fsPromises.rename(node.staged, node.target);
        }
        for (const node of stagedNodes)
            if (node.kind === "file" && !(await assertTargetMatches(node)))
                throw new Error(`Index storage commit verification failed for ${node.target}; all originals were preserved.`);
        const originalKeys = new Set(nodes.map(migrationNodeKey));
        const currentNodes = [];
        for (const source of sourceEntries) {
            const sourceRoot = sources.find((candidate) => isPathWithin(source, candidate));
            const entryName = path.relative(sourceRoot, source);
            await collectMigrationNodes(source, path.join(destinationRoot, entryName), "", currentNodes);
        }
        if (currentNodes.length !== nodes.length ||
            currentNodes.some((node) => !originalKeys.has(migrationNodeKey(node))))
            throw new Error("Index storage sources changed during migration; all originals were preserved.");
        for (const node of nodes) {
            if (node.kind !== "file")
                continue;
            const stats = await fsPromises.stat(node.source);
            if (stats.size !== node.size || await hashFile(node.source) !== node.hash)
                throw new Error(`Index storage source changed during migration: ${node.source}; all originals were preserved.`);
        }
        await beforeSourceRemoval?.();
        for (const source of sourceEntries)
            await fsPromises.rm(source, { recursive: true, force: true });
        onProgress?.(progress.filesVerified, progress.bytesVerified);
        return progress;
    }
    finally {
        await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => { });
    }
}
exports.migrateIndexStorageRoots = migrateIndexStorageRoots;
async function migrateIndexStorageEntries(userDataPath, storageRoot, entries = exports.INDEX_STORAGE_ENTRIES, onProgress) {
    return migrateIndexStorageRoots([userDataPath], storageRoot, entries, onProgress);
}
exports.migrateIndexStorageEntries = migrateIndexStorageEntries;
async function prepareExternalIndexStorage(userDataPath, storageRoot, onProgress) {
    await validateExternalVolume(userDataPath, storageRoot);
    await fsPromises.mkdir(storageRoot, { recursive: true });
    const [userDataStats, storageStats] = await Promise.all([
        fsPromises.stat(userDataPath),
        fsPromises.stat(storageRoot),
    ]);
    if (userDataStats.dev === storageStats.dev)
        throw new Error(`Selected index storage is not on an external volume: ${storageRoot}`);
    return migrateIndexStorageEntries(userDataPath, storageRoot, exports.INDEX_STORAGE_ENTRIES, onProgress);
}
exports.prepareExternalIndexStorage = prepareExternalIndexStorage;
async function prepareConfiguredIndexStorage(userDataPath, onProgress) {
    const settings = await readIndexStorageSettings(userDataPath);
    const storageRoot = settings.pendingPath ?? settings.path;
    if (path.resolve(storageRoot) === path.resolve(userDataPath))
        return {
            storageRoot: path.resolve(userDataPath),
            selectedStorageRoot: path.resolve(userDataPath),
            usingLocalFallback: false,
            destinationAvailable: true,
            localFallbackEnabled: settings.allowLocalFallback !== false,
            migrationCompleted: false,
            migrationError: null,
            filesVerified: 0,
            bytesVerified: 0,
        };
    const localFallbackRoot = getLocalFallbackIndexStorageRoot(userDataPath);
    const legacyFallbackRoot = getLegacyLocalFallbackIndexStorageRoot(userDataPath);
    try {
        await validateExternalVolume(userDataPath, storageRoot);
    }
    catch (error) {
        if (!(error instanceof ExternalIndexStorageUnavailableError))
            throw error;
        const unavailableMessage = `The selected cache destination is unavailable: ${storageRoot}`;
        if (settings.allowLocalFallback === false)
            return {
                // Keep all cache paths pointed at the selected destination while it is
                // offline. The caller blocks indexing until this path is writable.
                storageRoot: path.resolve(storageRoot),
                selectedStorageRoot: path.resolve(storageRoot),
                usingLocalFallback: false,
                destinationAvailable: false,
                localFallbackEnabled: false,
                migrationCompleted: false,
                migrationError: unavailableMessage,
                filesVerified: 0,
                bytesVerified: 0,
            };
        try {
            await fsPromises.mkdir(localFallbackRoot, { recursive: true });
            const sourceRoots = [path.resolve(userDataPath), legacyFallbackRoot];
            const requiredBytes = await migrationBytes(sourceRoots);
            await assertLocalIndexStorageCapacity(localFallbackRoot, requiredBytes);
            let legacyFilesVerified = 0;
            let legacyBytesVerified = 0;
            if (path.resolve(legacyFallbackRoot) !== path.resolve(localFallbackRoot) &&
                (await exists(legacyFallbackRoot))) {
                const legacyResult = await migrateIndexStorageRoots([legacyFallbackRoot], localFallbackRoot, exports.INDEX_STORAGE_ENTRIES, onProgress);
                legacyFilesVerified = legacyResult.filesVerified;
                legacyBytesVerified = legacyResult.bytesVerified;
            }
            const result = await migrateIndexStorageRoots([path.resolve(userDataPath)], localFallbackRoot, exports.INDEX_STORAGE_ENTRIES, onProgress);
            return {
                storageRoot: localFallbackRoot,
                selectedStorageRoot: path.resolve(storageRoot),
                usingLocalFallback: true,
                destinationAvailable: false,
                localFallbackEnabled: true,
                migrationCompleted: false,
                migrationError: null,
                filesVerified: legacyFilesVerified + result.filesVerified,
                bytesVerified: legacyBytesVerified + result.bytesVerified,
            };
        }
        catch (fallbackError) {
            return {
                // If fallback preparation fails, keep cache paths bound to the selected
                // destination. The caller pauses indexing until fallback or the volume
                // becomes available; it must never silently redirect these caches.
                storageRoot: path.resolve(storageRoot),
                selectedStorageRoot: path.resolve(storageRoot),
                usingLocalFallback: false,
                destinationAvailable: false,
                localFallbackEnabled: true,
                migrationCompleted: false,
                migrationError: fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError),
                filesVerified: 0,
                bytesVerified: 0,
            };
        }
    }
    await fsPromises.mkdir(storageRoot, { recursive: true });
    const sourceRoots = new Set([
        settings.path,
        path.resolve(userDataPath),
        localFallbackRoot,
        legacyFallbackRoot,
    ]);
    sourceRoots.delete(storageRoot);
    for (const sourceRoot of sourceRoots)
        if (!(await exists(sourceRoot)))
            sourceRoots.delete(sourceRoot);
    const fallbackWasPresent = sourceRoots.has(localFallbackRoot) || sourceRoots.has(legacyFallbackRoot);
    const result = await migrateIndexStorageRoots(Array.from(sourceRoots), storageRoot, exports.INDEX_STORAGE_ENTRIES, onProgress, settings.pendingPath
        ? () => writeIndexStorageRoot(userDataPath, storageRoot)
        : undefined);
    return {
        storageRoot,
        selectedStorageRoot: path.resolve(storageRoot),
        usingLocalFallback: false,
        destinationAvailable: true,
        localFallbackEnabled: settings.allowLocalFallback !== false,
        migrationCompleted: fallbackWasPresent,
        migrationError: null,
        filesVerified: result.filesVerified,
        bytesVerified: result.bytesVerified,
    };
}
exports.prepareConfiguredIndexStorage = prepareConfiguredIndexStorage;
