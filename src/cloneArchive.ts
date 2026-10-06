import archiver from "archiver";
import { createHash } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import yauzl from "yauzl";

export const CLONE_ARCHIVE_MANIFEST_NAME = "silo-clone-manifest.json";
export const CLONE_ARCHIVE_EXTENSION = ".zip";

export interface CloneArchiveFile {
  localPath: string;
  /** Path inside the archive, using either separator; stored with "/". */
  archivePath: string;
  size: number;
  modified: number;
  sha256: string;
  mode?: number;
}

export interface CloneArchiveDirectory {
  archivePath: string;
  modified?: number;
}

export interface CloneArchiveProgress {
  phase: "compressing" | "verifying" | "extracting";
  processedBytes: number;
  totalBytes: number;
  processedFiles: number;
  totalFiles: number;
  currentFile: string;
}

export interface WriteCloneArchiveOptions {
  archivePath: string;
  files: CloneArchiveFile[];
  directories?: CloneArchiveDirectory[];
  /** Built after every file was read and hash-checked; stored as the last entry. */
  buildManifest: () => Record<string, unknown>;
  isCancelled?: () => boolean;
  onProgress?: (progress: CloneArchiveProgress) => void;
  compressionLevel?: number;
}

export interface WriteCloneArchiveResult {
  archivePath: string;
  archiveBytes: number;
  storedFiles: number;
  verifiedFiles: number;
}

export interface ExtractCloneArchiveOptions {
  isCancelled?: () => boolean;
  onProgress?: (progress: CloneArchiveProgress) => void;
}

export interface ExtractCloneArchiveResult {
  destinationRoot: string;
  extractedFiles: number;
  restoredAliases: number;
  totalBytes: number;
}

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

export function toArchiveName(relativePath: string) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`Unsafe archive path: ${relativePath}`);
  return segments.join("/");
}

/** Resolves an archive entry name under root, rejecting traversal and absolute names. */
export function safeArchiveTarget(root: string, entryName: string) {
  if (entryName.includes("\\") || entryName.includes("\u0000") || /^[a-zA-Z]:/.test(entryName) || entryName.startsWith("/"))
    throw new Error(`Archive entry has an unsafe path: ${entryName}`);
  const segments = entryName.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`Archive entry has an unsafe path: ${entryName}`);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`))
    throw new Error(`Archive entry escapes the extraction folder: ${entryName}`);
  return target;
}

function openZip(archivePath: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true },
      (error, zipfile) => (error || !zipfile ? reject(error ?? new Error("Could not open archive.")) : resolve(zipfile)));
  });
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<Readable>((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) =>
      error || !stream ? reject(error ?? new Error(`Could not read ${entry.fileName}.`)) : resolve(stream));
  });
}

/** Visits every central-directory entry in order; the visitor may read the entry before the next one is requested. */
async function forEachZipEntry(zipfile: yauzl.ZipFile, visit: (entry: yauzl.Entry) => Promise<void>) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on("entry", (entry: yauzl.Entry) => {
      visit(entry).then(() => { if (!settled) zipfile.readEntry(); }, fail);
    });
    zipfile.readEntry();
  });
}

function isSymlinkEntry(entry: yauzl.Entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function hashStream(stream: Readable, onBytes?: (bytes: number) => void, isCancelled?: () => boolean) {
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    if (isCancelled?.()) {
      stream.destroy();
      throw cancelledError();
    }
    hash.update(chunk as Buffer);
    onBytes?.((chunk as Buffer).length);
  }
  return hash.digest("hex");
}

async function readManifest(zipfile: yauzl.ZipFile, entry: yauzl.Entry) {
  if (entry.uncompressedSize > 512 * 1024 * 1024)
    throw new Error("The archive manifest is unexpectedly large.");
  const chunks: Buffer[] = [];
  for await (const chunk of await openEntryStream(zipfile, entry)) chunks.push(chunk as Buffer);
  const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  if (manifest.format !== "silo-source-clone" || manifest.version !== 1)
    throw new Error("This zip is not a Silo clone archive.");
  return manifest;
}

type ManifestFile = { path: string; size: number; sha256?: string; modified?: number; error?: string };
type ManifestAlias = { path: string; canonicalPath: string; size: number; sha256: string };

function manifestFiles(manifest: Record<string, unknown>) {
  return (Array.isArray(manifest.files) ? manifest.files : []) as ManifestFile[];
}

function manifestAliases(manifest: Record<string, unknown>) {
  return (Array.isArray(manifest.aliases) ? manifest.aliases : []) as ManifestAlias[];
}

/**
 * Re-reads every stored file from the finished archive and compares its SHA-256 with
 * the hash taken while compressing. Returns the number of verified files.
 */
export async function verifyCloneArchive(
  archivePath: string,
  expected: Map<string, string>,
  options: { isCancelled?: () => boolean; onProgress?: (progress: CloneArchiveProgress) => void; totalBytes?: number } = {},
) {
  const zipfile = await openZip(archivePath);
  const seen = new Set<string>();
  let verifiedBytes = 0;
  let manifestFound = false;
  try {
    await forEachZipEntry(zipfile, async (entry) => {
      if (options.isCancelled?.()) throw cancelledError();
      if (entry.fileName.endsWith("/")) return;
      if (entry.fileName === CLONE_ARCHIVE_MANIFEST_NAME) {
        await readManifest(zipfile, entry);
        manifestFound = true;
        return;
      }
      const expectedHash = expected.get(entry.fileName);
      if (!expectedHash) throw new Error(`Archive contains an unexpected entry: ${entry.fileName}`);
      if (seen.has(entry.fileName)) throw new Error(`Archive contains a duplicate entry: ${entry.fileName}`);
      const digest = await hashStream(await openEntryStream(zipfile, entry), (bytes) => {
        verifiedBytes += bytes;
      }, options.isCancelled);
      if (digest !== expectedHash) throw new Error(`SHA-256 mismatch inside archive: ${entry.fileName}`);
      seen.add(entry.fileName);
      options.onProgress?.({ phase: "verifying", processedBytes: verifiedBytes, totalBytes: options.totalBytes ?? 0,
        processedFiles: seen.size, totalFiles: expected.size, currentFile: entry.fileName });
    });
  } finally {
    zipfile.close();
  }
  if (!manifestFound) throw new Error("The archive is missing its Silo manifest.");
  if (seen.size !== expected.size) {
    const missing = Array.from(expected.keys()).find((name) => !seen.has(name));
    throw new Error(`Archive is missing ${expected.size - seen.size} file(s), including ${missing}.`);
  }
  return seen.size;
}

/**
 * Streams files into a zip64-capable archive one at a time (bounded memory and file
 * handles), hashes each source while reading, appends the manifest last, verifies the
 * whole archive by reading it back, and only then renames it into place.
 */
export async function writeCloneArchive(options: WriteCloneArchiveOptions): Promise<WriteCloneArchiveResult> {
  const { archivePath, files } = options;
  const isCancelled = options.isCancelled ?? (() => false);
  const partialPath = `${archivePath}.silo-partial`;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const expected = new Map<string, string>();
  for (const file of files) {
    const name = toArchiveName(file.archivePath);
    if (expected.has(name)) throw new Error(`Duplicate archive path: ${name}`);
    expected.set(name, file.sha256);
  }
  if (await fsPromises.access(archivePath).then(() => true, () => false))
    throw new Error(`An archive already exists at ${archivePath}`);

  const output = fs.createWriteStream(partialPath, { flags: "wx" });
  const archive = archiver("zip", { zlib: { level: options.compressionLevel ?? 6 } });
  let archiveError: Error | null = null;
  const failed = new Promise<never>((_resolve, reject) => {
    const fail = (error: Error) => {
      archiveError ??= error;
      reject(error);
    };
    archive.on("error", fail);
    archive.on("warning", fail);
    output.on("error", fail);
  });
  failed.catch(() => undefined);
  const closed = new Promise<void>((resolve) => output.on("close", () => resolve()));
  archive.pipe(output);
  // archiver emits "entry" once per fully written entry, in append order.
  let appendedEntries = 0;
  let writtenEntries = 0;
  let entryWaiter: (() => void) | null = null;
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
    : new Promise<void>((resolve) => { entryWaiter = resolve; });

  let processedBytes = 0;
  let processedFiles = 0;
  let lastProgressAt = 0;
  const report = (currentFile: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    options.onProgress?.({ phase: "compressing", processedBytes, totalBytes, processedFiles,
      totalFiles: files.length, currentFile });
  };

  try {
    for (const directory of options.directories ?? []) {
      if (isCancelled()) throw cancelledError();
      archive.append("", { name: `${toArchiveName(directory.archivePath)}/`,
        date: directory.modified ? new Date(directory.modified) : new Date() });
      appendedEntries += 1;
    }
    await Promise.race([allEntriesWritten(), failed]);
    for (const file of files) {
      if (isCancelled()) throw cancelledError();
      if (archiveError) throw archiveError;
      const name = toArchiveName(file.archivePath);
      const before = await fsPromises.stat(file.localPath);
      if (before.size !== file.size || before.mtimeMs !== file.modified)
        throw new Error(`Source changed after preflight: ${file.archivePath}`);
      const hash = createHash("sha256");
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (isCancelled()) { callback(cancelledError()); return; }
          hash.update(chunk);
          processedBytes += chunk.length;
          report(name);
          callback(null, chunk);
        },
      });
      const source = fs.createReadStream(file.localPath);
      source.on("error", (error) => meter.destroy(error));
      const meterFailed = new Promise<never>((_resolve, reject) => meter.once("error", reject));
      meterFailed.catch(() => undefined);
      archive.append(source.pipe(meter), {
        name,
        date: new Date(file.modified),
        mode: file.mode !== undefined ? file.mode & 0o777 : 0o644,
        store: PRECOMPRESSED_EXTENSIONS.has(path.extname(name).toLowerCase()),
      });
      appendedEntries += 1;
      await Promise.race([allEntriesWritten(), meterFailed, failed]);
      if (hash.digest("hex") !== file.sha256)
        throw new Error(`Source content changed after hash preflight: ${file.archivePath}`);
      const after = await fsPromises.stat(file.localPath);
      if (after.size !== file.size || after.mtimeMs !== file.modified)
        throw new Error(`Source changed during compression: ${file.archivePath}`);
      processedFiles += 1;
      report(name);
    }
    if (isCancelled()) throw cancelledError();
    archive.append(JSON.stringify(options.buildManifest(), null, 2), { name: CLONE_ARCHIVE_MANIFEST_NAME, date: new Date() });
    report("", true);
    await Promise.race([archive.finalize(), failed]);
    await Promise.race([closed, failed]);
    const handle = await fsPromises.open(partialPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }

    const verifiedFiles = await verifyCloneArchive(partialPath, expected, {
      isCancelled, totalBytes,
      onProgress: (progress) => options.onProgress?.(progress),
    });
    await fsPromises.link(partialPath, archivePath);
    await fsPromises.unlink(partialPath);
    const stats = await fsPromises.stat(archivePath);
    return { archivePath, archiveBytes: stats.size, storedFiles: files.length, verifiedFiles };
  } catch (error) {
    archive.abort();
    output.destroy();
    await fsPromises.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads only the manifest from a Silo clone archive. */
export async function readCloneArchiveManifest(archivePath: string) {
  const zipfile = await openZip(archivePath);
  let manifest: Record<string, unknown> | null = null;
  try {
    await forEachZipEntry(zipfile, async (entry) => {
      if (!manifest && entry.fileName === CLONE_ARCHIVE_MANIFEST_NAME) manifest = await readManifest(zipfile, entry);
    });
  } finally {
    zipfile.close();
  }
  if (!manifest) throw new Error("This zip is not a Silo clone archive (no manifest).");
  return manifest as Record<string, unknown>;
}

/**
 * Extracts a verified Silo clone archive into a new folder below destinationParent.
 * Every file is SHA-256-checked against the archive manifest before it is renamed into
 * place, duplicate aliases are restored as hard links (or verified copies), and the
 * manifest is written last so a partial extraction is never mistaken for a clone.
 */
export async function extractCloneArchive(
  archivePath: string,
  destinationParent: string,
  options: ExtractCloneArchiveOptions = {},
): Promise<ExtractCloneArchiveResult> {
  const isCancelled = options.isCancelled ?? (() => false);
  const manifest = await readCloneArchiveManifest(archivePath);
  if (manifest.complete !== true)
    throw new Error("This archive was not marked complete and cannot be restored safely.");
  const expected = new Map<string, ManifestFile>();
  for (const file of manifestFiles(manifest)) {
    if (!file.sha256) continue;
    expected.set(toArchiveName(file.path), file);
  }
  const totalBytes = Array.from(expected.values()).reduce((sum, file) => sum + (file.size || 0), 0);

  const baseName = path.basename(archivePath, path.extname(archivePath)) || "Silo Clone";
  let destinationRoot = path.join(destinationParent, baseName);
  let suffix = 2;
  while (await fsPromises.access(destinationRoot).then(() => true, () => false))
    destinationRoot = path.join(destinationParent, `${baseName} (${suffix++})`);
  await fsPromises.mkdir(destinationRoot, { recursive: false });
  const marker = path.join(destinationRoot, ".silo-clone-in-progress.json");
  await fsPromises.writeFile(marker, JSON.stringify({ format: "silo-source-clone", version: 1,
    startedAt: new Date().toISOString(), extractingFrom: archivePath }), { mode: 0o600, flag: "wx" });

  try {
    return await extractInto(archivePath, destinationRoot, marker, manifest, expected, totalBytes, isCancelled, options);
  } catch (error) {
    // Only the folder created above is removed; nothing outside it is touched.
    await fsPromises.rm(destinationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractInto(
  archivePath: string,
  destinationRoot: string,
  marker: string,
  manifest: Record<string, unknown>,
  expected: Map<string, ManifestFile>,
  totalBytes: number,
  isCancelled: () => boolean,
  options: ExtractCloneArchiveOptions,
): Promise<ExtractCloneArchiveResult> {
  const zipfile = await openZip(archivePath);
  const extracted = new Set<string>();
  let processedBytes = 0;
  let lastProgressAt = 0;
  try {
    await forEachZipEntry(zipfile, async (entry) => {
      if (isCancelled()) throw cancelledError();
      if (entry.fileName === CLONE_ARCHIVE_MANIFEST_NAME) return;
      if (isSymlinkEntry(entry)) throw new Error(`Archive contains a symbolic link: ${entry.fileName}`);
      const target = safeArchiveTarget(destinationRoot, entry.fileName.replace(/\/+$/, ""));
      if (entry.fileName.endsWith("/")) {
        await fsPromises.mkdir(target, { recursive: true });
        return;
      }
      const record = expected.get(entry.fileName);
      if (!record) throw new Error(`Archive entry is not listed in its manifest: ${entry.fileName}`);
      if (extracted.has(entry.fileName)) throw new Error(`Archive contains a duplicate entry: ${entry.fileName}`);
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      const partial = `${target}.silo-partial`;
      const hash = createHash("sha256");
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (isCancelled()) { callback(cancelledError()); return; }
          hash.update(chunk);
          processedBytes += chunk.length;
          callback(null, chunk);
        },
      });
      try {
        await pipeline(await openEntryStream(zipfile, entry), meter, fs.createWriteStream(partial, { flags: "wx" }));
        if (hash.digest("hex") !== record.sha256)
          throw new Error(`SHA-256 mismatch while extracting: ${entry.fileName}`);
        const unixMode = (entry.externalFileAttributes >>> 16) & 0o777;
        if (unixMode) await fsPromises.chmod(partial, unixMode).catch(() => undefined);
        // The manifest keeps exact milliseconds; zip DOS timestamps are 2s and timezone-dependent.
        const modified = typeof record.modified === "number" && Number.isFinite(record.modified) && record.modified > 0
          ? record.modified / 1000
          : entry.getLastModDate();
        await fsPromises.utimes(partial, modified, modified).catch(() => undefined);
        await fsPromises.rename(partial, target);
      } catch (error) {
        await fsPromises.rm(partial, { force: true }).catch(() => undefined);
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
  } catch (error) {
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
    if (isCancelled()) throw cancelledError();
    const canonical = expected.get(toArchiveName(alias.canonicalPath));
    if (!canonical || canonical.sha256 !== alias.sha256)
      throw new Error(`Duplicate alias does not match its canonical file: ${alias.path}`);
    const canonicalPath = safeArchiveTarget(destinationRoot, toArchiveName(alias.canonicalPath));
    const aliasPath = safeArchiveTarget(destinationRoot, toArchiveName(alias.path));
    await fsPromises.mkdir(path.dirname(aliasPath), { recursive: true });
    try {
      await fsPromises.link(canonicalPath, aliasPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw error;
      await fsPromises.copyFile(canonicalPath, aliasPath, fs.constants.COPYFILE_EXCL);
    }
    alias.materialized = true;
    restoredAliases += 1;
  }

  await fsPromises.writeFile(path.join(destinationRoot, CLONE_ARCHIVE_MANIFEST_NAME), JSON.stringify({
    ...manifest,
    aliases,
    extractedFrom: path.basename(archivePath),
    extractedAt: new Date().toISOString(),
  }, null, 2));
  await fsPromises.rm(marker, { force: true });
  return { destinationRoot, extractedFiles: extracted.size, restoredAliases, totalBytes };
}
