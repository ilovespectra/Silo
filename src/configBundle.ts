import archiver from "archiver";
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import * as tarStream from "tar-stream";
import { createGunzip } from "zlib";

const FORMAT = "silo-config";
const FORMAT_VERSION = 1;
export const CONFIG_MANIFEST = "silo-config.json";
const STAGING = ".config-import-staging";
const READY_MARKER = ".config-import-ready";

// Durable configuration and indexes. Regenerable caches (thumbnails, previews, media) and phone backups are excluded.
const CONFIG_ENTRIES = [
  "browser-state.json",
  "content-settings.json",
  // Records before vectors: both grow during indexing, and records must never point past the archived vectors.
  "semantic-index/records.jsonl",
  "semantic-index/progress.json",
  "semantic-index/vectors.bin",
  "semantic-index/coverage.json",
  "semantic-index/discovered-totals.json",
  "semantic-index/worker-failures.json",
  "semantic-index/pending-work.json",
  "face-index",
  "pets",
  "geo-index.jsonl",
  "geocode-cache.json",
  "geocode-search-cache.json",
  "duplicate-index.json",
  "aesthetic-index.jsonl",
  "source-clone-status.json",
  "content-safety-index.json",
  "google-accounts.json",
  "contacts.json",
  "phone-cache/backup-destination.json",
  "phone-cache/backup-state.json",
  ".env",
];
const INDEX_CONFIG_ENTRIES = new Set([
  "semantic-index/records.jsonl",
  "semantic-index/progress.json",
  "semantic-index/vectors.bin",
  "semantic-index/coverage.json",
  "semantic-index/discovered-totals.json",
  "semantic-index/worker-failures.json",
  "semantic-index/pending-work.json",
  "face-index",
  "pets",
  "geo-index.jsonl",
  "geocode-cache.json",
  "geocode-search-cache.json",
  "duplicate-index.json",
  "aesthetic-index.jsonl",
  "content-safety-index.json",
]);
const INDEX_CONFIG_ROOTS = new Set([
  "semantic-index",
  "face-index",
  "pets",
  "geo-index.jsonl",
  "geocode-cache.json",
  "geocode-search-cache.json",
  "duplicate-index.json",
  "aesthetic-index.jsonl",
  "content-safety-index.json",
]);
const ALLOWED_ROOTS = new Set(
  CONFIG_ENTRIES.map((entry) => entry.split("/")[0]).concat(CONFIG_MANIFEST),
);
// These folders hold other data (e.g. phone backups); only the listed files inside them are replaced.
const MERGE_ROOTS = new Set(["phone-cache"]);

export interface ConfigManifest {
  format: string;
  version: number;
  exportedAt: number;
  appVersion: string;
  entries: string[];
  rendererPrefs: Record<string, string>;
}

const exists = (target: string) =>
  fsPromises.lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

export interface ConfigTransferProgress {
  operation: "export" | "import";
  phase: "preparing" | "copying" | "compressing" | "reading" | "validating" | "complete";
  percent: number | null;
  message: string;
}

export type ConfigTransferProgressReporter = (
  progress: ConfigTransferProgress,
) => void;

interface TreeSize {
  bytes: number;
  files: number;
}

async function measureTree(root: string): Promise<TreeSize> {
  const stats = await fsPromises.lstat(root);
  if (stats.isSymbolicLink())
    throw new Error(`Config export refuses symbolic links: ${root}`);
  if (stats.isFile()) return { bytes: stats.size, files: 1 };
  if (!stats.isDirectory())
    throw new Error(`Config export found an unsupported item: ${root}`);
  let bytes = 0;
  let files = 0;
  for (const child of await fsPromises.readdir(root)) {
    const size = await measureTree(path.join(root, child));
    bytes += size.bytes;
    files += size.files;
  }
  return { bytes, files };
}

async function copyTreeWithProgress(
  source: string,
  destination: string,
  onFileBytes: (bytes: number) => void,
): Promise<void> {
  const stats = await fsPromises.lstat(source);
  if (stats.isSymbolicLink())
    throw new Error(`Config export refuses symbolic links: ${source}`);
  if (stats.isDirectory()) {
    await fsPromises.mkdir(destination, { recursive: true, mode: stats.mode });
    for (const child of await fsPromises.readdir(source))
      await copyTreeWithProgress(
        path.join(source, child),
        path.join(destination, child),
        onFileBytes,
      );
    return;
  }
  if (!stats.isFile())
    throw new Error(`Config export found an unsupported item: ${source}`);
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  const input = createReadStream(source);
  input.on("data", (chunk: Buffer | string) =>
    onFileBytes(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)),
  );
  await pipeline(input, createWriteStream(destination, { mode: stats.mode & 0o777 }));
  await fsPromises.utimes(destination, stats.atime, stats.mtime).catch(() => {});
}

const safeReport = (
  reporter: ConfigTransferProgressReporter | undefined,
  progress: ConfigTransferProgress,
) => {
  try {
    reporter?.(progress);
  } catch {
    // A closed Settings window must not interrupt a file transfer.
  }
};

export async function exportConfig(
  userData: string,
  target: string,
  appVersion: string,
  rendererPrefs: Record<string, string>,
  indexStoragePath: string = userData,
  onProgress?: ConfigTransferProgressReporter,
) {
  safeReport(onProgress, {
    operation: "export",
    phase: "preparing",
    percent: null,
    message: "Checking config and index sizes…",
  });
  const entries: string[] = [];
  for (const entry of CONFIG_ENTRIES) {
    const root = INDEX_CONFIG_ENTRIES.has(entry) ? indexStoragePath : userData;
    if (await exists(path.join(root, entry))) entries.push(entry);
  }
  const entryRoots = entries.map((entry) => ({
    entry,
    source: path.join(INDEX_CONFIG_ENTRIES.has(entry) ? indexStoragePath : userData, entry),
  }));
  const sizes: TreeSize[] = [];
  for (const item of entryRoots) sizes.push(await measureTree(item.source));
  const totalBytes = sizes.reduce((sum, item) => sum + item.bytes, 0);
  const totalFiles = sizes.reduce((sum, item) => sum + item.files, 0);
  const manifest: ConfigManifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: Date.now(),
    appVersion,
    entries,
    rendererPrefs,
  };
  const temporary = await fsPromises.mkdtemp(
    path.join(indexStoragePath, ".silo-config-export-"),
  );
  let copiedBytes = 0;
  let lastCopyUpdate = 0;
  try {
    safeReport(onProgress, {
      operation: "export",
      phase: "copying",
      percent: 5,
      message: `Preparing ${totalFiles.toLocaleString()} files for backup…`,
    });
    for (const { entry, source } of entryRoots) {
      await copyTreeWithProgress(source, path.join(temporary, entry), (bytes) => {
        copiedBytes += bytes;
        const now = Date.now();
        if (now - lastCopyUpdate < 120 && copiedBytes < totalBytes) return;
        lastCopyUpdate = now;
        const ratio = totalBytes > 0 ? copiedBytes / totalBytes : 1;
        safeReport(onProgress, {
          operation: "export",
          phase: "copying",
          percent: Math.min(64, 5 + Math.floor(ratio * 59)),
          message: `Copying config and indexes (${Math.min(copiedBytes, totalBytes).toLocaleString()} of ${totalBytes.toLocaleString()} bytes)…`,
        });
      });
    }
    await fsPromises.writeFile(
      path.join(temporary, CONFIG_MANIFEST),
      JSON.stringify(manifest, null, 2),
    );
    safeReport(onProgress, {
      operation: "export",
      phase: "compressing",
      percent: 65,
      message: "Compressing the config backup…",
    });
    const archive = archiver("tar", { gzip: true, gzipOptions: { level: 6 } });
    archive.on("warning", (error) => archive.destroy(error));
    archive.on("progress", (progress) => {
      const ratio = progress.fs.totalBytes > 0
        ? progress.fs.processedBytes / progress.fs.totalBytes
        : progress.entries.total > 0
          ? progress.entries.processed / progress.entries.total
          : 0;
      safeReport(onProgress, {
        operation: "export",
        phase: "compressing",
        percent: Math.min(94, 65 + Math.floor(Math.min(1, ratio) * 29)),
        message: `Compressing backup (${Math.min(100, Math.floor(ratio * 100))}%)…`,
      });
    });
    const output = createWriteStream(target);
    const archiveDone = pipeline(archive, output);
    archive.directory(temporary, false);
    await Promise.all([archive.finalize(), archiveDone]);
  } finally {
    await fsPromises.rm(temporary, { recursive: true, force: true });
  }
  const { size } = await fsPromises.stat(target);
  safeReport(onProgress, {
    operation: "export",
    phase: "complete",
    percent: 100,
    message: "Config backup is ready.",
  });
  return { size, entries };
}

async function assertSafeTree(root: string, relative = ""): Promise<void> {
  for (const name of await fsPromises.readdir(path.join(root, relative))) {
    const child = path.join(relative, name);
    if (!relative && !ALLOWED_ROOTS.has(name))
      throw new Error(`Unexpected item in config: ${name}`);
    const stats = await fsPromises.lstat(path.join(root, child));
    if (stats.isSymbolicLink())
      throw new Error(`Config contains a link, which is not allowed: ${child}`);
    if (stats.isDirectory()) await assertSafeTree(root, child);
    else if (!stats.isFile())
      throw new Error(`Config contains an unsupported item: ${child}`);
  }
}

/** Unpacks and validates a config into a staging folder; nothing in use is touched until restart. */
export async function stageConfigImport(
  userData: string,
  archive: string,
  onProgress?: ConfigTransferProgressReporter,
): Promise<ConfigManifest> {
  const staging = path.join(userData, STAGING);
  await fsPromises.rm(staging, { recursive: true, force: true });
  await fsPromises.rm(path.join(userData, READY_MARKER), { force: true });
  await fsPromises.mkdir(staging, { recursive: true });
  try {
    const archiveStats = await fsPromises.stat(archive);
    if (archiveStats.size < 2) throw new Error("The selected config file is empty.");
    const firstBytes = Buffer.alloc(2);
    const handle = await fsPromises.open(archive, "r");
    try {
      await handle.read(firstBytes, 0, 2, 0);
    } finally {
      await handle.close();
    }
    if (firstBytes[0] !== 0x1f || firstBytes[1] !== 0x8b)
      throw new Error("This file is not a supported Silo config backup.");

    safeReport(onProgress, {
      operation: "import",
      phase: "reading",
      percent: 3,
      message: "Reading the config backup…",
    });
    const extractor = tarStream.extract();
    const gunzip = createGunzip();
    let compressedBytes = 0;
    let lastReadUpdate = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressedBytes += chunk.length;
        const now = Date.now();
        if (now - lastReadUpdate >= 120 || compressedBytes >= archiveStats.size) {
          lastReadUpdate = now;
          const ratio = Math.min(1, compressedBytes / archiveStats.size);
          safeReport(onProgress, {
            operation: "import",
            phase: "reading",
            percent: Math.min(67, 3 + Math.floor(ratio * 64)),
            message: `Reading backup data (${Math.floor(ratio * 100)}%)…`,
          });
        }
        callback(null, chunk);
      },
    });
    const extraction = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      extractor.once("error", fail);
      gunzip.once("error", fail);
      counter.once("error", fail);
      extractor.once("finish", resolve);
      extractor.on("entry", (header, stream, next) => {
        void (async () => {
          const name = header.name.replace(/\\/g, "/");
          const nameWithoutTrailingSlash = name.replace(/\/$/, "");
          const normalized = path.posix.normalize(nameWithoutTrailingSlash);
          const segments = normalized.split("/");
          if (
            !name ||
            name.startsWith("/") ||
            normalized === "." ||
            normalized !== nameWithoutTrailingSlash ||
            segments.some((segment) => segment === ".." || segment === "") ||
            !ALLOWED_ROOTS.has(segments[0])
          ) throw new Error(`Unexpected item in config: ${header.name}`);
          if (header.type === "directory") {
            await fsPromises.mkdir(path.join(staging, ...segments), { recursive: true });
            stream.resume();
            stream.once("end", () => next());
            return;
          }
          if (header.type !== "file")
            throw new Error(`Config contains an unsupported item: ${header.name}`);
          const destination = path.join(staging, ...segments);
          await fsPromises.mkdir(path.dirname(destination), { recursive: true });
          const output = createWriteStream(destination, { mode: header.mode & 0o777 });
          stream.once("error", (error) => output.destroy(error));
          output.once("error", (error) => stream.destroy(error));
          output.once("finish", () => next());
          stream.pipe(output);
        })().catch((error) => next(error as Error));
      });
      createReadStream(archive).pipe(counter).pipe(gunzip).pipe(extractor);
    });
    await extraction;
    safeReport(onProgress, {
      operation: "import",
      phase: "validating",
      percent: null,
      message: "Checking backup contents and compatibility…",
    });
    await assertSafeTree(staging);
    const manifest = JSON.parse(
      await fsPromises.readFile(path.join(staging, CONFIG_MANIFEST), "utf8"),
    ) as ConfigManifest;
    if (manifest.format !== FORMAT || typeof manifest.version !== "number")
      throw new Error("This file is not a Silo config.");
    if (manifest.version > FORMAT_VERSION)
      throw new Error(
        "This config was made by a newer version of Silo. Update Silo and try again.",
      );
    const filteredManifest = {
      ...manifest,
      rendererPrefs: Object.fromEntries(
        Object.entries(manifest.rendererPrefs ?? {}).filter(
          ([key, value]) =>
            key.startsWith("silo.") && typeof value === "string",
        ),
      ),
    };
    safeReport(onProgress, {
      operation: "import",
      phase: "complete",
      percent: 100,
      message: "Backup checked. Review its contents before restoring.",
    });
    return filteredManifest;
  } catch (error) {
    await fsPromises.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function commitStagedImport(userData: string) {
  if (!(await exists(path.join(userData, STAGING, CONFIG_MANIFEST))))
    throw new Error("No config is waiting to be restored.");
  await fsPromises.writeFile(
    path.join(userData, READY_MARKER),
    String(Date.now()),
  );
}

export async function cancelStagedImport(userData: string) {
  await fsPromises.rm(path.join(userData, STAGING), {
    recursive: true,
    force: true,
  });
  await fsPromises.rm(path.join(userData, READY_MARKER), { force: true });
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

async function treeManifest(root: string, relative = ""): Promise<string[]> {
  const current = path.join(root, relative);
  const stats = await fsPromises.lstat(current);
  if (stats.isSymbolicLink())
    throw new Error(`Config restore refuses symbolic links: ${current}`);
  if (stats.isFile())
    return [`file:${relative}:${stats.size}:${await hashFile(current)}`];
  if (!stats.isDirectory())
    throw new Error(`Config restore found an unsupported item: ${current}`);
  const children = (await fsPromises.readdir(current)).sort();
  const manifest = [`directory:${relative}`];
  for (const child of children)
    manifest.push(...await treeManifest(root, path.join(relative, child)));
  return manifest;
}

async function copyTreeVerified(source: string, destination: string) {
  const sourceManifest = await treeManifest(source);
  await fsPromises.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  const destinationManifest = await treeManifest(destination);
  if (JSON.stringify(sourceManifest) !== JSON.stringify(destinationManifest))
    throw new Error(`Config restore checksum verification failed for ${source}.`);
}

interface RestoreReplacement {
  target: string;
  backup: string | null;
}

async function replaceFromVerifiedCopy(
  source: string,
  target: string,
): Promise<RestoreReplacement> {
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = path.join(path.dirname(target), `.silo-restore-stage-${token}`);
  const backup = path.join(path.dirname(target), `.silo-restore-backup-${token}`);
  try {
    // Copy to a sibling of the target so the final rename stays on the destination volume.
    await copyTreeVerified(source, staged);
    const hadTarget = await exists(target);
    if (hadTarget) await fsPromises.rename(target, backup);
    try {
      await fsPromises.rename(staged, target);
    } catch (error) {
      if (hadTarget) await fsPromises.rename(backup, target);
      throw error;
    }
    return { target, backup: hadTarget ? backup : null };
  } catch (error) {
    await fsPromises.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function rollbackRestore(replacements: RestoreReplacement[]) {
  const failures: string[] = [];
  for (const replacement of replacements.reverse()) {
    try {
      await fsPromises.rm(replacement.target, { recursive: true, force: true });
      if (replacement.backup)
        await fsPromises.rename(replacement.backup, replacement.target);
    } catch (error) {
      failures.push(`${replacement.target}: ${String(error)}`);
    }
  }
  return failures;
}

export async function applyPendingImport(
  userData: string,
  indexStoragePath: string = userData,
) {
  const staging = path.join(userData, STAGING);
  if (!(await exists(path.join(userData, READY_MARKER)))) return false;
  const replacements: RestoreReplacement[] = [];
  try {
    for (const name of (await fsPromises.readdir(staging)).sort()) {
      if (name === CONFIG_MANIFEST) continue;
      const source = path.join(staging, name);
      if (MERGE_ROOTS.has(name)) {
        for (const child of (await fsPromises.readdir(source)).sort())
          replacements.push(await replaceFromVerifiedCopy(
            path.join(source, child),
            path.join(userData, name, child),
          ));
      } else {
        const targetRoot = INDEX_CONFIG_ROOTS.has(name)
          ? indexStoragePath
          : userData;
        replacements.push(await replaceFromVerifiedCopy(
          source,
          path.join(targetRoot, name),
        ));
      }
    }
  } catch (error) {
    const rollbackFailures = await rollbackRestore(replacements);
    if (rollbackFailures.length)
      throw new Error(
        `Config restore failed and rollback could not finish. The import and rollback copies were retained: ${rollbackFailures.join("; ")}. Original error: ${String(error)}`,
      );
    throw error;
  }

  // Keep the import available until every destination has been replaced successfully.
  for (const replacement of replacements)
    if (replacement.backup)
      await fsPromises.rm(replacement.backup, { recursive: true, force: true }).catch(() => {});
  await cancelStagedImport(userData).catch(() => {});
  return true;
}
