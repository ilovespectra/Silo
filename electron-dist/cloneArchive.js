"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractCloneArchive = exports.readCloneArchiveManifest = exports.writeCloneArchive = exports.verifyCloneArchive = exports.safeArchiveTarget = exports.toArchiveName = exports.CLONE_ARCHIVE_EXTENSION = exports.CLONE_ARCHIVE_MANIFEST_NAME = void 0;
const archiver_1 = __importDefault(require("archiver"));
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const stream_1 = require("stream");
const promises_2 = require("stream/promises");
const yauzl_1 = __importDefault(require("yauzl"));
exports.CLONE_ARCHIVE_MANIFEST_NAME = "silo-clone-manifest.json";
exports.CLONE_ARCHIVE_EXTENSION = ".zip";
// Already-compressed formats gain almost nothing from deflate, so they are stored
// as-is; this keeps bulk media archives fast without changing their bytes.
const PRECOMPRESSED_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".heic", ".heif", ".png", ".gif", ".webp", ".avif", ".jxl",
    ".arw", ".cr2", ".cr3", ".nef", ".dng", ".raf", ".orf", ".rw2",
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".3gp", ".hevc",
    ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wma",
    ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".dmg", ".pkg",
    ".docx", ".xlsx", ".pptx", ".pages", ".numbers", ".key", ".epub",
]);
function cancelledError() {
    return new Error("Source clone cancelled.");
}
function toArchiveName(relativePath) {
    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
        throw new Error(`Unsafe archive path: ${relativePath}`);
    return segments.join("/");
}
exports.toArchiveName = toArchiveName;
/** Resolves an archive entry name under root, rejecting traversal and absolute names. */
function safeArchiveTarget(root, entryName) {
    if (entryName.includes("\\") || entryName.includes("\u0000") || /^[a-zA-Z]:/.test(entryName) || entryName.startsWith("/"))
        throw new Error(`Archive entry has an unsafe path: ${entryName}`);
    const segments = entryName.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
        throw new Error(`Archive entry has an unsafe path: ${entryName}`);
    const resolvedRoot = path_1.default.resolve(root);
    const target = path_1.default.resolve(resolvedRoot, ...segments);
    if (!target.startsWith(`${resolvedRoot}${path_1.default.sep}`))
        throw new Error(`Archive entry escapes the extraction folder: ${entryName}`);
    return target;
}
exports.safeArchiveTarget = safeArchiveTarget;
function openZip(archivePath) {
    return new Promise((resolve, reject) => {
        yauzl_1.default.open(archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true }, (error, zipfile) => (error || !zipfile ? reject(error ?? new Error("Could not open archive.")) : resolve(zipfile)));
    });
}
function openEntryStream(zipfile, entry) {
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error(`Could not read ${entry.fileName}.`)) : resolve(stream));
    });
}
/** Visits every central-directory entry in order; the visitor may read the entry before the next one is requested. */
async function forEachZipEntry(zipfile, visit) {
    await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
        zipfile.on("error", fail);
        zipfile.on("end", () => {
            if (settled)
                return;
            settled = true;
            resolve();
        });
        zipfile.on("entry", (entry) => {
            visit(entry).then(() => { if (!settled)
                zipfile.readEntry(); }, fail);
        });
        zipfile.readEntry();
    });
}
function isSymlinkEntry(entry) {
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    return (unixMode & 0o170000) === 0o120000;
}
async function hashStream(stream, onBytes, isCancelled) {
    const hash = (0, crypto_1.createHash)("sha256");
    for await (const chunk of stream) {
        if (isCancelled?.()) {
            stream.destroy();
            throw cancelledError();
        }
        hash.update(chunk);
        onBytes?.(chunk.length);
    }
    return hash.digest("hex");
}
async function readManifest(zipfile, entry) {
    if (entry.uncompressedSize > 512 * 1024 * 1024)
        throw new Error("The archive manifest is unexpectedly large.");
    const chunks = [];
    for await (const chunk of await openEntryStream(zipfile, entry))
        chunks.push(chunk);
    const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (manifest.format !== "silo-source-clone" || manifest.version !== 1)
        throw new Error("This zip is not a Silo clone archive.");
    return manifest;
}
function manifestFiles(manifest) {
    return (Array.isArray(manifest.files) ? manifest.files : []);
}
function manifestAliases(manifest) {
    return (Array.isArray(manifest.aliases) ? manifest.aliases : []);
}
/**
 * Re-reads every stored file from the finished archive and compares its SHA-256 with
 * the hash taken while compressing. Returns the number of verified files.
 */
async function verifyCloneArchive(archivePath, expected, options = {}) {
    const zipfile = await openZip(archivePath);
    const seen = new Set();
    let verifiedBytes = 0;
    let manifestFound = false;
    try {
        await forEachZipEntry(zipfile, async (entry) => {
            if (options.isCancelled?.())
                throw cancelledError();
            if (entry.fileName.endsWith("/"))
                return;
            if (entry.fileName === exports.CLONE_ARCHIVE_MANIFEST_NAME) {
                await readManifest(zipfile, entry);
                manifestFound = true;
                return;
            }
            const expectedHash = expected.get(entry.fileName);
            if (!expectedHash)
                throw new Error(`Archive contains an unexpected entry: ${entry.fileName}`);
            if (seen.has(entry.fileName))
                throw new Error(`Archive contains a duplicate entry: ${entry.fileName}`);
            const digest = await hashStream(await openEntryStream(zipfile, entry), (bytes) => {
                verifiedBytes += bytes;
            }, options.isCancelled);
            if (digest !== expectedHash)
                throw new Error(`SHA-256 mismatch inside archive: ${entry.fileName}`);
            seen.add(entry.fileName);
            options.onProgress?.({ phase: "verifying", processedBytes: verifiedBytes, totalBytes: options.totalBytes ?? 0,
                processedFiles: seen.size, totalFiles: expected.size, currentFile: entry.fileName });
        });
    }
    finally {
        zipfile.close();
    }
    if (!manifestFound)
        throw new Error("The archive is missing its Silo manifest.");
    if (seen.size !== expected.size) {
        const missing = Array.from(expected.keys()).find((name) => !seen.has(name));
        throw new Error(`Archive is missing ${expected.size - seen.size} file(s), including ${missing}.`);
    }
    return seen.size;
}
exports.verifyCloneArchive = verifyCloneArchive;
/**
 * Streams files into a zip64-capable archive one at a time (bounded memory and file
 * handles), hashes each source while reading, appends the manifest last, verifies the
 * whole archive by reading it back, and only then renames it into place.
 */
async function writeCloneArchive(options) {
    const { archivePath, files } = options;
    const isCancelled = options.isCancelled ?? (() => false);
    const partialPath = `${archivePath}.silo-partial`;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const expected = new Map();
    for (const file of files) {
        const name = toArchiveName(file.archivePath);
        if (expected.has(name))
            throw new Error(`Duplicate archive path: ${name}`);
        expected.set(name, file.sha256);
    }
    if (await promises_1.default.access(archivePath).then(() => true, () => false))
        throw new Error(`An archive already exists at ${archivePath}`);
    const output = fs_1.default.createWriteStream(partialPath, { flags: "wx" });
    const archive = (0, archiver_1.default)("zip", { zlib: { level: options.compressionLevel ?? 6 } });
    let archiveError = null;
    const failed = new Promise((_resolve, reject) => {
        const fail = (error) => {
            archiveError ?? (archiveError = error);
            reject(error);
        };
        archive.on("error", fail);
        archive.on("warning", fail);
        output.on("error", fail);
    });
    failed.catch(() => undefined);
    const closed = new Promise((resolve) => output.on("close", () => resolve()));
    archive.pipe(output);
    // archiver emits "entry" once per fully written entry, in append order.
    let appendedEntries = 0;
    let writtenEntries = 0;
    let entryWaiter = null;
    archive.on("entry", () => {
        writtenEntries += 1;
        if (entryWaiter && writtenEntries >= appendedEntries) {
            const waiter = entryWaiter;
            entryWaiter = null;
            waiter();
        }
    });
    const allEntriesWritten = () => writtenEntries >= appendedEntries
        ? Promise.resolve()
        : new Promise((resolve) => { entryWaiter = resolve; });
    let processedBytes = 0;
    let processedFiles = 0;
    let lastProgressAt = 0;
    const report = (currentFile, force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < 250)
            return;
        lastProgressAt = now;
        options.onProgress?.({ phase: "compressing", processedBytes, totalBytes, processedFiles,
            totalFiles: files.length, currentFile });
    };
    try {
        for (const directory of options.directories ?? []) {
            if (isCancelled())
                throw cancelledError();
            archive.append("", { name: `${toArchiveName(directory.archivePath)}/`,
                date: directory.modified ? new Date(directory.modified) : new Date() });
            appendedEntries += 1;
        }
        await Promise.race([allEntriesWritten(), failed]);
        for (const file of files) {
            if (isCancelled())
                throw cancelledError();
            if (archiveError)
                throw archiveError;
            const name = toArchiveName(file.archivePath);
            const before = await promises_1.default.stat(file.localPath);
            if (before.size !== file.size || before.mtimeMs !== file.modified)
                throw new Error(`Source changed after preflight: ${file.archivePath}`);
            const hash = (0, crypto_1.createHash)("sha256");
            const meter = new stream_1.Transform({
                transform(chunk, _encoding, callback) {
                    if (isCancelled()) {
                        callback(cancelledError());
                        return;
                    }
                    hash.update(chunk);
                    processedBytes += chunk.length;
                    report(name);
                    callback(null, chunk);
                },
            });
            const source = fs_1.default.createReadStream(file.localPath);
            source.on("error", (error) => meter.destroy(error));
            const meterFailed = new Promise((_resolve, reject) => meter.once("error", reject));
            meterFailed.catch(() => undefined);
            archive.append(source.pipe(meter), {
                name,
                date: new Date(file.modified),
                mode: file.mode !== undefined ? file.mode & 0o777 : 0o644,
                store: PRECOMPRESSED_EXTENSIONS.has(path_1.default.extname(name).toLowerCase()),
            });
            appendedEntries += 1;
            await Promise.race([allEntriesWritten(), meterFailed, failed]);
            if (hash.digest("hex") !== file.sha256)
                throw new Error(`Source content changed after hash preflight: ${file.archivePath}`);
            const after = await promises_1.default.stat(file.localPath);
            if (after.size !== file.size || after.mtimeMs !== file.modified)
                throw new Error(`Source changed during compression: ${file.archivePath}`);
            processedFiles += 1;
            report(name);
        }
        if (isCancelled())
            throw cancelledError();
        archive.append(JSON.stringify(options.buildManifest(), null, 2), { name: exports.CLONE_ARCHIVE_MANIFEST_NAME, date: new Date() });
        report("", true);
        await Promise.race([archive.finalize(), failed]);
        await Promise.race([closed, failed]);
        const handle = await promises_1.default.open(partialPath, "r+");
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        const verifiedFiles = await verifyCloneArchive(partialPath, expected, {
            isCancelled, totalBytes,
            onProgress: (progress) => options.onProgress?.(progress),
        });
        await promises_1.default.link(partialPath, archivePath);
        await promises_1.default.unlink(partialPath);
        const stats = await promises_1.default.stat(archivePath);
        return { archivePath, archiveBytes: stats.size, storedFiles: files.length, verifiedFiles };
    }
    catch (error) {
        archive.abort();
        output.destroy();
        await promises_1.default.rm(partialPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
exports.writeCloneArchive = writeCloneArchive;
/** Reads only the manifest from a Silo clone archive. */
async function readCloneArchiveManifest(archivePath) {
    const zipfile = await openZip(archivePath);
    let manifest = null;
    try {
        await forEachZipEntry(zipfile, async (entry) => {
            if (!manifest && entry.fileName === exports.CLONE_ARCHIVE_MANIFEST_NAME)
                manifest = await readManifest(zipfile, entry);
        });
    }
    finally {
        zipfile.close();
    }
    if (!manifest)
        throw new Error("This zip is not a Silo clone archive (no manifest).");
    return manifest;
}
exports.readCloneArchiveManifest = readCloneArchiveManifest;
/**
 * Extracts a verified Silo clone archive into a new folder below destinationParent.
 * Every file is SHA-256-checked against the archive manifest before it is renamed into
 * place, duplicate aliases are restored as hard links (or verified copies), and the
 * manifest is written last so a partial extraction is never mistaken for a clone.
 */
async function extractCloneArchive(archivePath, destinationParent, options = {}) {
    const isCancelled = options.isCancelled ?? (() => false);
    const manifest = await readCloneArchiveManifest(archivePath);
    if (manifest.complete !== true)
        throw new Error("This archive was not marked complete and cannot be restored safely.");
    const expected = new Map();
    for (const file of manifestFiles(manifest)) {
        if (!file.sha256)
            continue;
        expected.set(toArchiveName(file.path), file);
    }
    const totalBytes = Array.from(expected.values()).reduce((sum, file) => sum + (file.size || 0), 0);
    const baseName = path_1.default.basename(archivePath, path_1.default.extname(archivePath)) || "Silo Clone";
    let destinationRoot = path_1.default.join(destinationParent, baseName);
    let suffix = 2;
    while (await promises_1.default.access(destinationRoot).then(() => true, () => false))
        destinationRoot = path_1.default.join(destinationParent, `${baseName} (${suffix++})`);
    await promises_1.default.mkdir(destinationRoot, { recursive: false });
    const marker = path_1.default.join(destinationRoot, ".silo-clone-in-progress.json");
    await promises_1.default.writeFile(marker, JSON.stringify({ format: "silo-source-clone", version: 1,
        startedAt: new Date().toISOString(), extractingFrom: archivePath }), { mode: 0o600, flag: "wx" });
    try {
        return await extractInto(archivePath, destinationRoot, marker, manifest, expected, totalBytes, isCancelled, options);
    }
    catch (error) {
        // Only the folder created above is removed; nothing outside it is touched.
        await promises_1.default.rm(destinationRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
exports.extractCloneArchive = extractCloneArchive;
async function extractInto(archivePath, destinationRoot, marker, manifest, expected, totalBytes, isCancelled, options) {
    const zipfile = await openZip(archivePath);
    const extracted = new Set();
    let processedBytes = 0;
    let lastProgressAt = 0;
    try {
        await forEachZipEntry(zipfile, async (entry) => {
            if (isCancelled())
                throw cancelledError();
            if (entry.fileName === exports.CLONE_ARCHIVE_MANIFEST_NAME)
                return;
            if (isSymlinkEntry(entry))
                throw new Error(`Archive contains a symbolic link: ${entry.fileName}`);
            const target = safeArchiveTarget(destinationRoot, entry.fileName.replace(/\/+$/, ""));
            if (entry.fileName.endsWith("/")) {
                await promises_1.default.mkdir(target, { recursive: true });
                return;
            }
            const record = expected.get(entry.fileName);
            if (!record)
                throw new Error(`Archive entry is not listed in its manifest: ${entry.fileName}`);
            if (extracted.has(entry.fileName))
                throw new Error(`Archive contains a duplicate entry: ${entry.fileName}`);
            await promises_1.default.mkdir(path_1.default.dirname(target), { recursive: true });
            const partial = `${target}.silo-partial`;
            const hash = (0, crypto_1.createHash)("sha256");
            const meter = new stream_1.Transform({
                transform(chunk, _encoding, callback) {
                    if (isCancelled()) {
                        callback(cancelledError());
                        return;
                    }
                    hash.update(chunk);
                    processedBytes += chunk.length;
                    callback(null, chunk);
                },
            });
            try {
                await (0, promises_2.pipeline)(await openEntryStream(zipfile, entry), meter, fs_1.default.createWriteStream(partial, { flags: "wx" }));
                if (hash.digest("hex") !== record.sha256)
                    throw new Error(`SHA-256 mismatch while extracting: ${entry.fileName}`);
                const unixMode = (entry.externalFileAttributes >>> 16) & 0o777;
                if (unixMode)
                    await promises_1.default.chmod(partial, unixMode).catch(() => undefined);
                // The manifest keeps exact milliseconds; zip DOS timestamps are 2s and timezone-dependent.
                const modified = typeof record.modified === "number" && Number.isFinite(record.modified) && record.modified > 0
                    ? record.modified / 1000
                    : entry.getLastModDate();
                await promises_1.default.utimes(partial, modified, modified).catch(() => undefined);
                await promises_1.default.rename(partial, target);
            }
            catch (error) {
                await promises_1.default.rm(partial, { force: true }).catch(() => undefined);
                throw error;
            }
            extracted.add(entry.fileName);
            const now = Date.now();
            if (now - lastProgressAt >= 250 || extracted.size === expected.size) {
                lastProgressAt = now;
                options.onProgress?.({ phase: "extracting", processedBytes, totalBytes, processedFiles: extracted.size,
                    totalFiles: expected.size, currentFile: entry.fileName });
            }
        });
    }
    catch (error) {
        zipfile.close();
        throw error;
    }
    zipfile.close();
    if (extracted.size !== expected.size) {
        const missing = Array.from(expected.keys()).find((name) => !extracted.has(name));
        throw new Error(`Archive is missing ${expected.size - extracted.size} file(s), including ${missing}.`);
    }
    let restoredAliases = 0;
    const aliases = manifestAliases(manifest).map((alias) => ({ ...alias, materialized: false }));
    for (const alias of aliases) {
        if (isCancelled())
            throw cancelledError();
        const canonical = expected.get(toArchiveName(alias.canonicalPath));
        if (!canonical || canonical.sha256 !== alias.sha256)
            throw new Error(`Duplicate alias does not match its canonical file: ${alias.path}`);
        const canonicalPath = safeArchiveTarget(destinationRoot, toArchiveName(alias.canonicalPath));
        const aliasPath = safeArchiveTarget(destinationRoot, toArchiveName(alias.path));
        await promises_1.default.mkdir(path_1.default.dirname(aliasPath), { recursive: true });
        try {
            await promises_1.default.link(canonicalPath, aliasPath);
        }
        catch (error) {
            const code = error.code;
            if (code === "EEXIST")
                throw error;
            await promises_1.default.copyFile(canonicalPath, aliasPath, fs_1.default.constants.COPYFILE_EXCL);
        }
        alias.materialized = true;
        restoredAliases += 1;
    }
    await promises_1.default.writeFile(path_1.default.join(destinationRoot, exports.CLONE_ARCHIVE_MANIFEST_NAME), JSON.stringify({
        ...manifest,
        aliases,
        extractedFrom: path_1.default.basename(archivePath),
        extractedAt: new Date().toISOString(),
    }, null, 2));
    await promises_1.default.rm(marker, { force: true });
    return { destinationRoot, extractedFiles: extracted.size, restoredAliases, totalBytes };
}
