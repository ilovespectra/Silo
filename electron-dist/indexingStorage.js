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
exports.prepareConfiguredIndexStorage = exports.prepareExternalIndexStorage = exports.migrateIndexStorageEntries = exports.validateIndexStorageDestination = exports.INDEX_STORAGE_ENTRIES = exports.stageIndexStorageRoot = exports.writeIndexStorageRoot = exports.readIndexStorageRoot = exports.getActiveIndexStorageRoot = exports.setActiveIndexStorageRoot = void 0;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const INDEX_STORAGE_SETTINGS_FILE = "index-storage.json";
let activeIndexStorageRoot = "";
function setActiveIndexStorageRoot(storageRoot) {
    activeIndexStorageRoot = path.resolve(storageRoot);
}
exports.setActiveIndexStorageRoot = setActiveIndexStorageRoot;
function getActiveIndexStorageRoot() {
    return activeIndexStorageRoot;
}
exports.getActiveIndexStorageRoot = getActiveIndexStorageRoot;
async function readIndexStorageRoot(userDataPath) {
    return (await readIndexStorageSettings(userDataPath)).path;
}
exports.readIndexStorageRoot = readIndexStorageRoot;
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
            };
        throw new Error(`Could not read the index storage setting: ${String(error)}`);
    }
    const storedPath = settings?.path;
    const pendingPath = settings?.pendingPath;
    if (settings?.format !== "silo-index-storage" ||
        settings?.version !== 1 ||
        typeof storedPath !== "string" ||
        !path.isAbsolute(storedPath))
        throw new Error("The saved index storage setting is invalid.");
    if (pendingPath !== undefined &&
        (typeof pendingPath !== "string" || !path.isAbsolute(pendingPath)))
        throw new Error("The pending index storage setting is invalid.");
    return {
        format: "silo-index-storage",
        version: 1,
        path: path.resolve(storedPath),
        ...(typeof pendingPath === "string"
            ? { pendingPath: path.resolve(pendingPath) }
            : {}),
    };
}
async function writeIndexStorageRoot(userDataPath, storageRoot) {
    if (!path.isAbsolute(storageRoot))
        throw new Error("Index storage path must be absolute.");
    const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
    const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify({ format: "silo-index-storage", version: 1, path: path.resolve(storageRoot) }, null, 2), { mode: 0o600 });
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
async function validateExternalVolume(userDataPath, storageRoot) {
    if (isPathWithin(storageRoot, userDataPath) ||
        isPathWithin(userDataPath, storageRoot))
        throw new Error("External index storage must be separate from Silo app data.");
    const [existingAncestor, userData] = await Promise.all([
        getExistingAncestor(storageRoot),
        fsPromises.stat(userDataPath),
    ]);
    const volume = await fsPromises.stat(existingAncestor);
    if (volume.dev === userData.dev)
        throw new Error(`The selected index storage drive is unavailable or is not external: ${storageRoot}. Indexing is paused and local storage will not be used as a fallback.`);
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
async function migrateEntry(source, destination, progress, onProgress) {
    const sourceStats = await fsPromises.lstat(source);
    if (sourceStats.isSymbolicLink())
        throw new Error(`Index storage migration refuses symbolic links: ${source}`);
    if (sourceStats.isDirectory()) {
        const destinationExists = await exists(destination);
        if (destinationExists) {
            const destinationStats = await fsPromises.lstat(destination);
            if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink())
                throw new Error(`Index storage destination conflicts with ${source}`);
        }
        else {
            await fsPromises.mkdir(destination, { recursive: true });
        }
        for (const name of await fsPromises.readdir(source))
            await migrateEntry(path.join(source, name), path.join(destination, name), progress, onProgress);
        await fsPromises.rmdir(source);
        return;
    }
    if (!sourceStats.isFile())
        throw new Error(`Unsupported item in index storage: ${source}`);
    if (await exists(destination)) {
        const destinationStats = await fsPromises.lstat(destination);
        if (!destinationStats.isFile() || destinationStats.isSymbolicLink())
            throw new Error(`Index storage destination conflicts with ${source}`);
        const [sourceHash, destinationHash] = await Promise.all([
            hashFile(source),
            hashFile(destination),
        ]);
        if (sourceStats.size !== destinationStats.size || sourceHash !== destinationHash)
            throw new Error(`Index storage contains different files at ${destination}; the local original was preserved.`);
    }
    else {
        await fsPromises.mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.silo-migrating-${(0, crypto_1.randomBytes)(8).toString("hex")}`;
        try {
            await fsPromises.copyFile(source, temporary);
            const [sourceHash, copiedHash] = await Promise.all([
                hashFile(source),
                hashFile(temporary),
            ]);
            if (sourceStats.size !== (await fsPromises.stat(temporary)).size || sourceHash !== copiedHash)
                throw new Error(`Checksum verification failed for ${source}; the local original was preserved.`);
            await fsPromises.rename(temporary, destination);
        }
        catch (error) {
            await fsPromises.rm(temporary, { force: true });
            throw error;
        }
    }
    await fsPromises.unlink(source);
    progress.filesVerified += 1;
    progress.bytesVerified += sourceStats.size;
    if (progress.filesVerified % 500 === 0)
        onProgress?.(progress.filesVerified, progress.bytesVerified);
}
async function migrateIndexStorageEntries(userDataPath, storageRoot, entries = exports.INDEX_STORAGE_ENTRIES, onProgress) {
    let requiredBytes = 0;
    let expectedFiles = 0;
    const sources = [];
    for (const name of entries) {
        const source = path.join(userDataPath, name);
        if (!(await exists(source)))
            continue;
        const summary = await summarizeTree(source);
        requiredBytes += summary.bytes;
        expectedFiles += summary.files;
        sources.push(name);
    }
    await assertEnoughSpace(storageRoot, requiredBytes);
    const progress = { filesVerified: 0, bytesVerified: 0 };
    for (const name of sources) {
        await migrateEntry(path.join(userDataPath, name), path.join(storageRoot, name), progress, onProgress);
    }
    onProgress?.(progress.filesVerified, progress.bytesVerified);
    if (progress.filesVerified !== expectedFiles ||
        progress.bytesVerified !== requiredBytes)
        throw new Error("Index storage verification totals did not match the local source manifest; Silo was not started.");
    return progress;
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
            filesVerified: 0,
            bytesVerified: 0,
        };
    let filesVerified = 0;
    let bytesVerified = 0;
    if (settings.pendingPath) {
        await validateExternalVolume(userDataPath, storageRoot);
        await fsPromises.mkdir(storageRoot, { recursive: true });
        const sourceRoots = new Set([settings.path, path.resolve(userDataPath)]);
        for (const sourceRoot of sourceRoots) {
            if (sourceRoot === storageRoot)
                continue;
            if (sourceRoot !== path.resolve(userDataPath))
                await fsPromises.stat(sourceRoot);
            const result = await migrateIndexStorageEntries(sourceRoot, storageRoot, exports.INDEX_STORAGE_ENTRIES, onProgress);
            filesVerified += result.filesVerified;
            bytesVerified += result.bytesVerified;
        }
        await writeIndexStorageRoot(userDataPath, storageRoot);
    }
    else {
        await validateExternalVolume(userDataPath, storageRoot);
        await fsPromises.mkdir(storageRoot, { recursive: true });
        const result = await migrateIndexStorageEntries(userDataPath, storageRoot, exports.INDEX_STORAGE_ENTRIES, onProgress);
        filesVerified = result.filesVerified;
        bytesVerified = result.bytesVerified;
    }
    return { storageRoot, filesVerified, bytesVerified };
}
exports.prepareConfiguredIndexStorage = prepareConfiguredIndexStorage;
