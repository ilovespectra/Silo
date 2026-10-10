"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyShelterCloneSource = exports.readShelterCloneManifest = exports.getShelterFreshness = void 0;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const cloneArchive_1 = require("./cloneArchive");
var shelterFreshness_1 = require("./shelterFreshness");
Object.defineProperty(exports, "getShelterFreshness", { enumerable: true, get: function () { return shelterFreshness_1.getShelterFreshness; } });
function normalizedRelativePath(value) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || path_1.default.isAbsolute(value) || /^[a-zA-Z]:/.test(value))
        throw new Error("The Fallout Shelter manifest contains an unsafe file path.");
    const segments = value.split(/[\\/]+/).filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === "." || segment === ".."))
        throw new Error("The Fallout Shelter manifest contains an unsafe file path.");
    return segments.join("/");
}
function hasSha256(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
async function hashFile(filePath) {
    const hash = (0, crypto_1.createHash)("sha256");
    for await (const chunk of fs_1.default.createReadStream(filePath))
        hash.update(chunk);
    return hash.digest("hex");
}
async function hashStableFile(filePath) {
    const before = await promises_1.default.stat(filePath);
    if (!before.isFile())
        return null;
    const digest = await hashFile(filePath);
    const after = await promises_1.default.stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.dev !== after.dev || before.ino !== after.ino)
        return null;
    return digest;
}
async function readCloneManifest(clonePath) {
    const manifest = path_1.default.extname(clonePath).toLowerCase() === ".zip"
        ? await (0, cloneArchive_1.readCloneArchiveManifest)(clonePath)
        : JSON.parse(await promises_1.default.readFile(path_1.default.join(clonePath, "silo-clone-manifest.json"), "utf8"));
    if (manifest.format !== "silo-source-clone" || manifest.version !== 1 || manifest.complete !== true)
        throw new Error("The latest Fallout Shelter clone is incomplete or has no supported manifest.");
    if (!Array.isArray(manifest.files) || !Array.isArray(manifest.aliases))
        throw new Error("The Fallout Shelter clone manifest is missing its file inventory.");
    return manifest;
}
async function readShelterCloneManifest(clonePath) {
    return readCloneManifest(clonePath);
}
exports.readShelterCloneManifest = readShelterCloneManifest;
async function listCloneFiles(root) {
    const actual = new Map();
    const stack = [{ absolute: root, relative: "" }];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of await promises_1.default.readdir(current.absolute, { withFileTypes: true })) {
            if (!current.relative && entry.name === "silo-clone-manifest.json")
                continue;
            const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
            const absolute = path_1.default.join(current.absolute, entry.name);
            if (entry.isSymbolicLink()) {
                actual.set(normalizedRelativePath(relative), "");
            }
            else if (entry.isDirectory()) {
                stack.push({ absolute, relative });
            }
            else if (entry.isFile()) {
                actual.set(normalizedRelativePath(relative), absolute);
            }
        }
    }
    return actual;
}
async function verifyShelterCloneSource(clonePath, sourceId, sourceFiles) {
    const result = {
        verified: false,
        verifiedFiles: 0,
        totalFiles: sourceFiles.length,
        missingFiles: 0,
        changedFiles: 0,
        extraFiles: 0,
    };
    if (!sourceFiles.length) {
        result.error = "The selected source currently contains no files to verify.";
        return result;
    }
    const manifest = await readCloneManifest(clonePath);
    const physicalFiles = new Map();
    const actualStoredDigests = new Map();
    const sourceManifestFiles = new Map();
    const records = new Map();
    const changedSourcePaths = new Set();
    let destinationIntegrity = true;
    for (const raw of manifest.files) {
        if (raw.error || !hasSha256(raw.sha256))
            throw new Error("The Fallout Shelter clone manifest contains an unverified file.");
        const relative = normalizedRelativePath(raw.path);
        if (records.has(relative))
            throw new Error("The Fallout Shelter clone manifest contains duplicate file paths.");
        records.set(relative, raw.sha256.toLowerCase());
        physicalFiles.set(relative, raw.sha256.toLowerCase());
        if (raw.sourceId === sourceId) {
            const sourceRelative = normalizedRelativePath(raw.sourceRelativePath ?? raw.path);
            if (sourceManifestFiles.has(sourceRelative))
                throw new Error("The Fallout Shelter manifest maps a source file more than once.");
            sourceManifestFiles.set(sourceRelative, { digest: raw.sha256.toLowerCase(), storedPath: relative });
        }
    }
    const aliasRecords = new Map();
    for (const raw of manifest.aliases) {
        if (!hasSha256(raw.sha256))
            throw new Error("The Fallout Shelter clone manifest contains an invalid duplicate hash.");
        const relative = normalizedRelativePath(raw.path);
        const canonicalPath = normalizedRelativePath(raw.canonicalPath);
        const canonicalDigest = records.get(canonicalPath);
        if (!canonicalDigest || canonicalDigest !== raw.sha256.toLowerCase())
            throw new Error("A Fallout Shelter duplicate does not point to its verified canonical file.");
        if (records.has(relative) || aliasRecords.has(relative))
            throw new Error("The Fallout Shelter clone manifest contains duplicate file paths.");
        aliasRecords.set(relative, { digest: raw.sha256.toLowerCase(), canonicalPath });
        if (raw.materialized === true)
            physicalFiles.set(relative, raw.sha256.toLowerCase());
        if (raw.sourceId === sourceId) {
            const sourceRelative = normalizedRelativePath(raw.sourceRelativePath ?? raw.path);
            if (sourceManifestFiles.has(sourceRelative))
                throw new Error("The Fallout Shelter manifest maps a source file more than once.");
            sourceManifestFiles.set(sourceRelative, { digest: raw.sha256.toLowerCase(), storedPath: canonicalPath });
        }
    }
    const zip = path_1.default.extname(clonePath).toLowerCase() === ".zip";
    const actualFiles = zip ? null : await listCloneFiles(clonePath);
    if (zip) {
        try {
            await (0, cloneArchive_1.verifyCloneArchive)(clonePath, records);
            for (const [relative, expectedDigest] of records)
                actualStoredDigests.set(relative, expectedDigest);
        }
        catch (error) {
            destinationIntegrity = false;
            result.error = error instanceof Error ? error.message : "The Fallout Shelter archive failed integrity verification.";
        }
    }
    else {
        for (const [relative, expectedDigest] of physicalFiles) {
            const actualPath = actualFiles.get(relative);
            if (!actualPath) {
                destinationIntegrity = false;
                continue;
            }
            const actualDigest = await hashStableFile(actualPath).catch(() => null);
            if (actualDigest !== expectedDigest) {
                destinationIntegrity = false;
            }
            else {
                actualStoredDigests.set(relative, actualDigest);
            }
        }
        for (const relative of actualFiles.keys()) {
            if (!physicalFiles.has(relative))
                result.extraFiles += 1;
        }
        for (const relative of physicalFiles.keys()) {
            if (!actualFiles.has(relative))
                destinationIntegrity = false;
        }
        if (!destinationIntegrity && !result.error)
            result.error = "One or more stored Fallout Shelter files failed SHA-256 or presence checks.";
    }
    const currentSourceFiles = new Map();
    for (const file of sourceFiles) {
        const relative = normalizedRelativePath(file.relativePath);
        if (currentSourceFiles.has(relative))
            throw new Error("The live source contains duplicate relative file paths.");
        currentSourceFiles.set(relative, file.localPath);
    }
    for (const [relative, localPath] of currentSourceFiles) {
        const stored = sourceManifestFiles.get(relative);
        if (!stored) {
            result.missingFiles += 1;
            continue;
        }
        const sourceDigest = await hashStableFile(localPath).catch(() => null);
        const storedDigest = actualStoredDigests.get(stored.storedPath);
        const materializedAliasDigest = aliasRecords.get(relative)?.digest;
        if (!sourceDigest || sourceDigest !== stored.digest || storedDigest !== stored.digest ||
            (materializedAliasDigest && materializedAliasDigest !== stored.digest)) {
            changedSourcePaths.add(relative);
            continue;
        }
        result.verifiedFiles += 1;
    }
    for (const relative of sourceManifestFiles.keys()) {
        if (!currentSourceFiles.has(relative))
            result.extraFiles += 1;
    }
    result.changedFiles = changedSourcePaths.size;
    result.verified = result.verifiedFiles === result.totalFiles &&
        result.missingFiles === 0 && result.changedFiles === 0 && result.extraFiles === 0 &&
        destinationIntegrity && !result.error;
    return result;
}
exports.verifyShelterCloneSource = verifyShelterCloneSource;
