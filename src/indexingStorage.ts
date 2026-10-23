import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { constants as fsConstants, createReadStream, realpathSync } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

const INDEX_STORAGE_SETTINGS_FILE = "index-storage.json";

interface IndexStorageSettings {
  format: string;
  version: number;
  path: string;
  knownPaths?: string[];
  pendingPath?: string;
  allowLocalFallback?: boolean;
}

export const LOCAL_INDEX_STORAGE_RESERVE_BYTES = 10 * 1024 * 1024 * 1024;

function freeBytesAt(storageRoot: string) {
  return fsPromises.statfs(storageRoot).then(
    (stats) => stats.bavail * stats.bsize,
  );
}

async function migrationBytes(sourceRoots: readonly string[]) {
  let requiredBytes = 0;
  for (const sourceRoot of new Set(sourceRoots.map((root) => path.resolve(root)))) {
    for (const entry of INDEX_STORAGE_ENTRIES) {
      const source = path.join(sourceRoot, entry);
      if (await exists(source)) requiredBytes += (await summarizeTree(source)).bytes;
    }
  }
  return requiredBytes;
}

export async function getLocalIndexStorageFreeBytes(storageRoot: string) {
  return freeBytesAt(storageRoot);
}

export async function assertLocalIndexStorageCapacity(
  storageRoot: string,
  additionalBytes = 0,
) {
  const freeBytes = await freeBytesAt(storageRoot);
  if (freeBytes < LOCAL_INDEX_STORAGE_RESERVE_BYTES + additionalBytes)
    throw new Error(
      `Local cache fallback is paused to preserve at least ${Math.round(LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB of free space. Reconnect the selected destination or free space.`,
    );
  return freeBytes;
}

let activeIndexStorageRoot = "";
let indexStorageExclusionRoots: string[] = [];
let canonicalIndexStorageExclusionRoots: string[] | null = null;
let indexStorageExclusionRevision = 0;

function canonicalizeStoragePath(storageRoot: string) {
  const resolved = path.resolve(storageRoot);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function setActiveIndexStorageRoot(storageRoot: string) {
  const resolved = path.resolve(storageRoot);
  activeIndexStorageRoot = canonicalizeStoragePath(resolved);
  indexStorageExclusionRoots = [resolved];
  canonicalIndexStorageExclusionRoots = null;
  indexStorageExclusionRevision += 1;
}

export function setIndexStorageExclusionRoots(storageRoots: readonly string[]) {
  indexStorageExclusionRoots = Array.from(
    new Set(storageRoots.map((storageRoot) => path.resolve(storageRoot))),
  );
  canonicalIndexStorageExclusionRoots = null;
  indexStorageExclusionRevision += 1;
}

export function getIndexStorageExclusionRevision() {
  return indexStorageExclusionRevision;
}

function storagePathAliases(storageRoot: string) {
  const canonical = canonicalizeStoragePath(storageRoot);
  const aliases = [storageRoot, canonical];
  // macOS resolves temporary and system paths through /private. Indexed
  // candidates can still carry the user-visible /var spelling, so retain
  // that lexical alias alongside the real path when excluding app data.
  if (
    process.platform === "darwin" &&
    /^\/private\/(?:var|tmp|etc)(?:\/|$)/.test(canonical)
  ) {
    aliases.push(canonical.slice("/private".length));
  }
  return aliases;
}

export function getIndexStorageExclusionRoots() {
  if (canonicalIndexStorageExclusionRoots) return canonicalIndexStorageExclusionRoots;
  canonicalIndexStorageExclusionRoots = Array.from(
    new Set(indexStorageExclusionRoots.flatMap(storagePathAliases)),
  );
  return canonicalIndexStorageExclusionRoots;
}

export function getLocalFallbackIndexStorageRoot(userDataPath: string) {
  const resolvedUserDataPath = path.resolve(userDataPath);
  return path.join(
    path.dirname(resolvedUserDataPath),
    `${path.basename(resolvedUserDataPath)}-local-index-fallback`,
  );
}

function getLegacyLocalFallbackIndexStorageRoot(userDataPath: string) {
  return path.join(path.resolve(userDataPath), ".silo-local-fallback-index");
}

export function getActiveIndexStorageRoot() {
  return activeIndexStorageRoot;
}

export function createIndexStoragePathResolver(getStorageRoot: () => string) {
  return (...segments: string[]) => path.join(getStorageRoot(), ...segments);
}

export async function readIndexStorageRoot(userDataPath: string) {
  return (await readIndexStorageSettings(userDataPath)).path;
}

export async function getIndexStorageSettings(userDataPath: string) {
  const settings = await readIndexStorageSettings(userDataPath);
  return {
    path: settings.path,
    knownPaths: settings.knownPaths ?? [],
    allowLocalFallback: settings.allowLocalFallback !== false,
  };
}

const MAX_INDEX_MARKER_JSON_BYTES = 8 * 1024 * 1024;

async function getIndexMarkerStats(markerPath: string) {
  try {
    return await fsPromises.stat(markerPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function hasNonEmptyIndexFile(storageRoot: string, relativePath: string) {
  const stats = await getIndexMarkerStats(path.join(storageRoot, relativePath));
  return Boolean(stats?.isFile() && stats.size > 0);
}

async function hasStructuredIndexData(
  storageRoot: string,
  relativePath: string,
  hasData: (value: any) => boolean,
) {
  const markerPath = path.join(storageRoot, relativePath);
  const stats = await getIndexMarkerStats(markerPath);
  if (!stats?.isFile() || stats.size === 0) return false;
  // Preserve oversized or malformed stores conservatively without loading them
  // into memory or mistaking them for an empty index.
  if (stats.size > MAX_INDEX_MARKER_JSON_BYTES) return true;
  try {
    return hasData(JSON.parse(await fsPromises.readFile(markerPath, "utf8")));
  } catch {
    return true;
  }
}

/**
 * Cache folders are disposable and may exist after a first launch without any
 * indexed data. Only recognize a root when a persisted index contains records.
 */
async function hasPersistedIndexData(storageRoot: string) {
  const recordFiles = [
    "semantic-index/records.jsonl",
    "semantic-index/vectors.bin",
    "face-index/faces.jsonl",
    "pets/clusters.jsonl",
    "geo-index.jsonl",
    "aesthetic-index.jsonl",
  ];
  for (const relativePath of recordFiles)
    if (await hasNonEmptyIndexFile(storageRoot, relativePath)) return true;

  const structuredMarkers: {
    relativePath: string;
    hasData: (value: any) => boolean;
  }[] = [
    {
      relativePath: "face-index/people.json",
      hasData: (value) =>
        (Array.isArray(value?.people) && value.people.length > 0) ||
        Object.keys(value?.faceEdits ?? {}).length > 0 ||
        Object.keys(value?.bannedFaces ?? {}).length > 0 ||
        (Array.isArray(value?.bannedPhotoPaths) &&
          value.bannedPhotoPaths.length > 0) ||
        (Array.isArray(value?.missingPhotoPaths) &&
          value.missingPhotoPaths.length > 0),
    },
    {
      relativePath: "pets/summary.json",
      hasData: (value) => Array.isArray(value) && value.length > 0,
    },
    {
      relativePath: "duplicate-index.json",
      hasData: (value) =>
        Object.keys(value?.hashes ?? {}).length > 0 ||
        (Array.isArray(value?.groups) && value.groups.length > 0),
    },
    {
      relativePath: "content-safety-index.json",
      hasData: (value) => Array.isArray(value?.paths) && value.paths.length > 0,
    },
    {
      relativePath: "audio-library-index.json",
      hasData: (value) => Array.isArray(value?.files) && value.files.length > 0,
    },
    {
      relativePath: "library-stats.json",
      hasData: (value) => Array.isArray(value?.sources) && value.sources.length > 0,
    },
  ];
  for (const { relativePath, hasData } of structuredMarkers)
    if (await hasStructuredIndexData(storageRoot, relativePath, hasData))
      return true;
  return false;
}

export async function findExistingIndexStorageRoots(
  candidates: readonly string[],
) {
  const found: string[] = [];
  for (const candidate of new Set(candidates.filter(Boolean).map((root) => path.resolve(root))))
    if (await hasPersistedIndexData(candidate)) found.push(candidate);
  return found;
}

export async function setLocalIndexStorageFallback(
  userDataPath: string,
  enabled: boolean,
) {
  const settings = await readIndexStorageSettings(userDataPath);
  const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
  const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
  await fsPromises.writeFile(
    temporaryPath,
    JSON.stringify({ ...settings, allowLocalFallback: enabled }, null, 2),
    { mode: 0o600 },
  );
  await fsPromises.rename(temporaryPath, settingsPath);
  return enabled;
}

async function readIndexStorageSettings(
  userDataPath: string,
): Promise<IndexStorageSettings> {
  const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
  let settings: unknown;
  try {
    settings = JSON.parse(await fsPromises.readFile(settingsPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        format: "silo-index-storage",
        version: 1,
        path: path.resolve(userDataPath),
        allowLocalFallback: true,
      };
    throw new Error(`Could not read the index storage setting: ${String(error)}`);
  }
  const storedPath = (settings as { path?: unknown })?.path;
  const pendingPath = (settings as { pendingPath?: unknown })?.pendingPath;
  const knownPaths = (settings as { knownPaths?: unknown })?.knownPaths;
  const allowLocalFallback = (settings as { allowLocalFallback?: unknown })
    ?.allowLocalFallback;
  if (
    (settings as { format?: unknown })?.format !== "silo-index-storage" ||
    (settings as { version?: unknown })?.version !== 1 ||
    typeof storedPath !== "string" ||
    !path.isAbsolute(storedPath)
  )
    throw new Error("The saved index storage setting is invalid.");
  if (
    pendingPath !== undefined &&
    (typeof pendingPath !== "string" || !path.isAbsolute(pendingPath))
  )
    throw new Error("The pending index storage setting is invalid.");
  if (
    knownPaths !== undefined &&
    (!Array.isArray(knownPaths) ||
      knownPaths.some((root) => typeof root !== "string" || !path.isAbsolute(root)))
  )
    throw new Error("The remembered index storage paths are invalid.");
  if (
    allowLocalFallback !== undefined &&
    typeof allowLocalFallback !== "boolean"
  )
    throw new Error("The local fallback preference is invalid.");
  return {
    format: "silo-index-storage",
    version: 1,
    path: path.resolve(storedPath),
    ...(Array.isArray(knownPaths)
      ? {
          knownPaths: Array.from(
            new Set(knownPaths.map((root) => path.resolve(root as string))),
          ),
        }
      : {}),
    ...(typeof pendingPath === "string"
      ? { pendingPath: path.resolve(pendingPath) }
      : {}),
    ...(typeof allowLocalFallback === "boolean" ? { allowLocalFallback } : {}),
  };
}

export async function writeIndexStorageRoot(
  userDataPath: string,
  storageRoot: string,
  knownPaths?: readonly string[],
  options: { replaceKnownPaths?: boolean } = {},
) {
  if (!path.isAbsolute(storageRoot))
    throw new Error("Index storage path must be absolute.");
  const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
  const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
  let currentSettings: IndexStorageSettings;
  try {
    currentSettings = await readIndexStorageSettings(userDataPath);
  } catch {
    const originalSettings = await fsPromises.readFile(settingsPath, "utf8");
    const recoveryPath = `${settingsPath}.recovery-${Date.now()}-${randomBytes(4).toString("hex")}.json`;
    await fsPromises.writeFile(recoveryPath, originalSettings, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    let recoveredPaths: string[] = [];
    try {
      const parsed = JSON.parse(originalSettings) as {
        path?: unknown;
        knownPaths?: unknown;
      };
      recoveredPaths = [
        ...(typeof parsed.path === "string" && path.isAbsolute(parsed.path)
          ? [parsed.path]
          : []),
        ...(Array.isArray(parsed.knownPaths)
          ? parsed.knownPaths.filter(
              (root): root is string =>
                typeof root === "string" && path.isAbsolute(root),
            )
          : []),
      ];
    } catch {
      // Keep the original settings file as a recovery copy even if its JSON
      // cannot be parsed; the user can still choose a cache folder safely.
    }
    currentSettings = {
      format: "silo-index-storage",
      version: 1,
      path: path.resolve(userDataPath),
      knownPaths: recoveredPaths,
    };
  }
  const nextKnownPaths = options.replaceKnownPaths
    ? knownPaths ?? [path.resolve(storageRoot)]
    : [
        ...(currentSettings.knownPaths ?? []),
        ...(knownPaths ?? []),
      ];
  await fsPromises.writeFile(
    temporaryPath,
    JSON.stringify(
      {
        ...currentSettings,
        format: "silo-index-storage",
        version: 1,
        path: path.resolve(storageRoot),
        knownPaths: Array.from(
          new Set(nextKnownPaths.map((root) => path.resolve(root))),
        ),
        pendingPath: undefined,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await fsPromises.rename(temporaryPath, settingsPath);
}

export async function stageIndexStorageRoot(
  userDataPath: string,
  storageRoot: string,
) {
  if (!path.isAbsolute(storageRoot))
    throw new Error("Index storage path must be absolute.");
  const settings = await readIndexStorageSettings(userDataPath);
  const nextRoot = path.resolve(storageRoot);
  if (settings.pendingPath)
    throw new Error("An index storage move is already waiting for restart.");
  if (nextRoot === settings.path) return false;
  if (
    path.resolve(settings.path) !== path.resolve(userDataPath) &&
    (isPathWithin(nextRoot, settings.path) ||
      isPathWithin(settings.path, nextRoot))
  )
    throw new Error(
      "Choose a cache folder separate from the current cache folder.",
    );
  await validateExternalVolume(userDataPath, nextRoot);
  const knownPaths = new Set(settings.knownPaths ?? []);
  if (
    path.resolve(settings.path) !== path.resolve(userDataPath) &&
    (await hasPersistedIndexData(settings.path))
  )
    knownPaths.add(path.resolve(settings.path));
  if (await hasPersistedIndexData(nextRoot)) knownPaths.add(nextRoot);
  const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
  const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
  await fsPromises.writeFile(
    temporaryPath,
      JSON.stringify(
      { ...settings, knownPaths: Array.from(knownPaths), pendingPath: nextRoot },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await fsPromises.rename(temporaryPath, settingsPath);
  return true;
}

export const INDEX_STORAGE_ENTRIES = [
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
] as const;

export interface IndexStorageMigrationResult {
  filesVerified: number;
  bytesVerified: number;
}

interface StorageTreeSummary {
  files: number;
  bytes: number;
}

export type IndexStorageMigrationPhase =
  | "scanning"
  | "reconciling"
  | "copying"
  | "committing"
  | "verifying"
  | "cleaning";

export interface IndexStorageMigrationProgress {
  phase: IndexStorageMigrationPhase;
  filesVerified: number;
  bytesVerified: number;
  totalFiles: number;
  totalBytes: number;
}

type ProgressListener = (
  filesVerified: number,
  bytesVerified: number,
  detail?: IndexStorageMigrationProgress,
) => void;

// Content-addressed caches: the same file name always describes the same
// item, so a temporary fallback copy can be merged into the destination.
// Every other entry is a self-consistent store that must never be mixed.
const MERGEABLE_INDEX_STORAGE_ENTRIES = new Set([
  "thumbnail-cache",
  "preview-cache",
  "media-cache",
  "memory-image-cache",
  "cloud-cache",
]);

const MIGRATION_STAGING_PATTERN = /^\.silo-index-migration-(\d+)(?:-[0-9a-f]+)?$/;

/**
 * Deletes bulky folders from a detached `rm` process. Large cache trees on
 * slow external drives can take minutes to delete; doing it out of process
 * keeps Silo's file worker threads free.
 */
function deleteInBackground(targets: readonly string[]) {
  if (!targets.length) return;
  try {
    const child = spawn("/bin/rm", ["-rf", "--", ...targets], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    void Promise.all(
      targets.map((target) => fsPromises.rm(target, { recursive: true, force: true }).catch(() => {})),
    );
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Moves staging folders left behind by interrupted migrations out of the way
 * (a cheap rename) and deletes them in the background so a large cleanup never
 * holds up startup or competes with a migration for the drive.
 */
async function removeStaleMigrationStaging(destinationRoot: string) {
  const names = await fsPromises.readdir(destinationRoot).catch(() => [] as string[]);
  const trash: string[] = [];
  for (const name of names) {
    const match = MIGRATION_STAGING_PATTERN.exec(name);
    if (!match) {
      if (name.startsWith(".silo-index-trash-")) trash.push(path.join(destinationRoot, name));
      continue;
    }
    const pid = Number(match[1]);
    if (pid === process.pid || processIsAlive(pid)) continue;
    const trashPath = path.join(destinationRoot, `.silo-index-trash-${name.slice(1)}`);
    await fsPromises
      .rename(path.join(destinationRoot, name), trashPath)
      .then(() => trash.push(trashPath))
      .catch(() => {});
  }
  return () => deleteInBackground(trash);
}

async function exists(target: string) {
  return fsPromises.lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

async function getExistingAncestor(targetPath: string) {
  let ancestor = path.resolve(targetPath);
  while (!(await exists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor)
      throw new Error(`No existing parent directory for index storage: ${targetPath}`);
    ancestor = parent;
  }
  return ancestor;
}

function isPathWithin(candidatePath: string, rootPath: string) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export class ExternalIndexStorageUnavailableError extends Error {
  constructor(readonly storageRoot: string) {
    super(`Could not open the selected external storage drive at ${storageRoot}. Indexing is paused for that drive.`);
    this.name = "ExternalIndexStorageUnavailableError";
  }
}

async function validateExternalVolume(userDataPath: string, storageRoot: string) {
  if (
    isPathWithin(storageRoot, userDataPath) ||
    isPathWithin(userDataPath, storageRoot)
  )
    throw new Error("External index storage must be separate from Silo app data.");

  // A missing drive root (e.g. an unplugged E:\ on Windows) means the
  // destination is offline, not that the setting is broken.
  const existingAncestor = await getExistingAncestor(storageRoot).catch(() => {
    throw new ExternalIndexStorageUnavailableError(storageRoot);
  });
  // On macOS, /Volumes itself is only a mount-point container. If the
  // selected volume is absent, treating that container as the destination
  // volume can pass the device check and make Silo try to create a path under
  // /Volumes. Report it as unavailable so the configured local fallback works.
  if (
    process.platform === "darwin" &&
    path.resolve(existingAncestor) === path.resolve("/Volumes") &&
    path.resolve(storageRoot) !== path.resolve("/Volumes")
  )
    throw new ExternalIndexStorageUnavailableError(storageRoot);
  try {
    await fsPromises.access(storageRoot, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new ExternalIndexStorageUnavailableError(storageRoot);
  }
  // Folders on the internal drive are allowed; they are created on demand.
}

export async function validateIndexStorageDestination(
  userDataPath: string,
  storageRoot: string,
) {
  await validateExternalVolume(userDataPath, storageRoot);
  const settings = await readIndexStorageSettings(userDataPath);
  if (
    path.resolve(settings.path) !== path.resolve(userDataPath) &&
    (isPathWithin(storageRoot, settings.path) ||
      isPathWithin(settings.path, storageRoot))
  )
    throw new Error(
      "Choose a cache folder separate from the current cache folder.",
    );
  const sourceRoots = new Set([settings.path, path.resolve(userDataPath)]);
  let requiredBytes = 0;
  for (const sourceRoot of sourceRoots) {
    for (const entry of INDEX_STORAGE_ENTRIES) {
      const source = path.join(sourceRoot, entry);
      if (await exists(source))
        requiredBytes += (await summarizeTree(source)).bytes;
    }
  }
  await assertEnoughSpace(storageRoot, requiredBytes);
  return { requiredBytes };
}

async function assertEnoughSpace(root: string, requiredBytes: number) {
  const stats = await fsPromises.statfs(root);
  const availableBytes = stats.bavail * stats.bsize;
  const reserveBytes = 512 * 1024 * 1024;
  if (availableBytes < requiredBytes + reserveBytes)
    throw new Error(
      `The selected drive does not have enough free space for the verified index migration. Required: ${requiredBytes.toLocaleString()} bytes plus a 512 MiB safety margin.`,
    );
}

async function summarizeTree(target: string): Promise<StorageTreeSummary> {
  const stats = await fsPromises.lstat(target);
  if (stats.isSymbolicLink())
    throw new Error(`Index storage migration refuses symbolic links: ${target}`);
  if (stats.isFile()) return { files: 1, bytes: stats.size };
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

interface MigrationNode {
  source: string;
  target: string;
  staged: string;
  kind: "directory" | "file";
  size: number;
  hash?: string;
}

async function collectMigrationNodes(
  source: string,
  target: string,
  staged: string,
  nodes: MigrationNode[],
): Promise<void> {
  const stats = await fsPromises.lstat(source);
  if (stats.isSymbolicLink())
    throw new Error(`Index storage migration refuses symbolic links: ${source}`);
  if (stats.isDirectory()) {
    nodes.push({ source, target, staged, kind: "directory", size: 0 });
    const names = (await fsPromises.readdir(source)).sort();
    for (const name of names)
      await collectMigrationNodes(
        path.join(source, name),
        path.join(target, name),
        path.join(staged, name),
        nodes,
      );
    return;
  }
  if (!stats.isFile())
    throw new Error(`Unsupported item in index storage: ${source}`);
  nodes.push({ source, target, staged, kind: "file", size: stats.size });
}

function migrationNodeKey(node: Pick<MigrationNode, "source" | "kind">) {
  return `${path.resolve(node.source)}\u0000${node.kind}`;
}

async function assertTargetMatches(node: MigrationNode): Promise<boolean> {
  if (!(await exists(node.target))) return false;
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
    throw new Error(
      `Index storage contains different files at ${node.target}; the local original was preserved.`,
    );
  return true;
}

export interface IndexStorageMigrationOptions {
  /**
   * "strict" fails when the destination already holds different data (used
   * for user-initiated moves). "keep-destination" is used when a previously
   * selected destination reconnects: its existing index stores win, and the
   * temporary local copies are archived beside their source instead of being
   * merged into (and corrupting) the destination's stores.
   */
  conflictPolicy?: "strict" | "keep-destination";
}

function formatGiB(bytes: number) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function describeIndexStorageMigrationProgress(
  detail: IndexStorageMigrationProgress,
) {
  const files = `${detail.filesVerified.toLocaleString()} of ${detail.totalFiles.toLocaleString()} files`;
  const bytes = `${formatGiB(detail.bytesVerified)} of ${formatGiB(detail.totalBytes)}`;
  switch (detail.phase) {
    case "scanning":
      return "Checking which cache files need to move…";
    case "reconciling":
      return "Comparing the local cache with the reconnected destination…";
    case "copying":
      return `Copying and verifying cache files: ${files} (${bytes}).`;
    case "committing":
      return "Placing verified cache files in the destination…";
    case "verifying":
      return `Confirming the local originals did not change: ${files} (${bytes}).`;
    case "cleaning":
      return "Cleaning up the temporary local cache…";
  }
}

function supersededArchiveRoot(sourceRoot: string, stamp: string) {
  return path.join(
    path.dirname(sourceRoot),
    `${path.basename(sourceRoot)}-superseded-${stamp}`,
  );
}

export async function migrateIndexStorageRoots(
  sourceRoots: readonly string[],
  storageRoot: string,
  entries: readonly string[] = INDEX_STORAGE_ENTRIES,
  onProgress?: ProgressListener,
  beforeSourceRemoval?: () => Promise<void>,
  options: IndexStorageMigrationOptions = {},
): Promise<IndexStorageMigrationResult> {
  const keepDestination = options.conflictPolicy === "keep-destination";
  const destinationRoot = path.resolve(storageRoot);
  const sources = Array.from(new Set(sourceRoots.map((source) => path.resolve(source))))
    .filter((source) => source !== destinationRoot);
  for (const source of sources) {
    if (isPathWithin(source, destinationRoot) || isPathWithin(destinationRoot, source))
      throw new Error("Index storage migration source and destination must be separate.");
  }

  const totals = { totalFiles: 0, totalBytes: 0 };
  const report = (
    phase: IndexStorageMigrationPhase,
    filesVerified: number,
    bytesVerified: number,
  ) =>
    onProgress?.(filesVerified, bytesVerified, {
      phase,
      filesVerified,
      bytesVerified,
      ...totals,
    });
  report("scanning", 0, 0);
  await fsPromises.mkdir(destinationRoot, { recursive: true });
  const deleteStaleStaging = await removeStaleMigrationStaging(destinationRoot);
  try {
    return await runIndexStorageMigration();
  } finally {
    deleteStaleStaging();
  }

  async function runIndexStorageMigration(): Promise<IndexStorageMigrationResult> {
  const archiveStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const superseded: { source: string; archive: string }[] = [];
  // Regenerable caches built while the destination was offline are dropped
  // rather than copied back file by file (often 100k+ thumbnails).
  const discarded: string[] = [];
  const sourceEntries: string[] = [];
  const sourceSnapshotKeys = new Set<string>();
  const nodes: MigrationNode[] = [];
  const claimedTargets = new Set<string>();
  let requiredBytes = 0;
  for (let rootIndex = 0; rootIndex < sources.length; rootIndex += 1) {
    const sourceRoot = sources[rootIndex];
    for (const name of entries) {
      const source = path.join(sourceRoot, name);
      if (!(await exists(source))) continue;
      const target = path.join(destinationRoot, name);
      const mergeable = MERGEABLE_INDEX_STORAGE_ENTRIES.has(name);
      if (keepDestination && mergeable) {
        discarded.push(source);
        continue;
      }
      if (
        keepDestination &&
        !mergeable &&
        ((await exists(target)) || claimedTargets.has(path.resolve(target)))
      ) {
        superseded.push({
          source,
          archive: path.join(supersededArchiveRoot(sourceRoot, archiveStamp), name),
        });
        continue;
      }
      const staged = path.join(destinationRoot, `.silo-index-migration-${process.pid}`, String(rootIndex), name);
      const collected: MigrationNode[] = [];
      await collectMigrationNodes(source, target, staged, collected);
      sourceEntries.push(source);
      for (const node of collected) {
        sourceSnapshotKeys.add(migrationNodeKey(node));
        const targetKey = path.resolve(node.target);
        if (
          keepDestination &&
          node.kind === "file" &&
          (claimedTargets.has(targetKey) || (await exists(node.target)))
        )
          continue; // The destination already has this cache file.
        claimedTargets.add(targetKey);
        nodes.push(node);
        if (node.kind === "file") {
          requiredBytes += node.size;
          totals.totalFiles += 1;
        }
      }
    }
  }
  totals.totalBytes = requiredBytes;
  await assertEnoughSpace(destinationRoot, requiredBytes);

  const archiveSuperseded = async () => {
    for (const { source, archive } of superseded) {
      await fsPromises.mkdir(path.dirname(archive), { recursive: true });
      await fsPromises.rename(source, archive);
    }
    const trash: string[] = [];
    for (const source of discarded) {
      const trashPath = `${source}.silo-discarded-${archiveStamp}`;
      await fsPromises.rename(source, trashPath).then(
        () => trash.push(trashPath),
        () => {},
      );
    }
    deleteInBackground(trash);
  };

  if (nodes.length === 0) {
    await beforeSourceRemoval?.();
    report("cleaning", 0, 0);
    await archiveSuperseded();
    for (const source of sourceEntries)
      await fsPromises.rm(source, { recursive: true, force: true });
    return { filesVerified: 0, bytesVerified: 0 };
  }

  const stagingRoot = path.join(destinationRoot, `.silo-index-migration-${process.pid}-${randomBytes(8).toString("hex")}`);
  const stagedNodes = nodes.map((node) => ({
    ...node,
    staged: node.staged.replace(
      path.join(destinationRoot, `.silo-index-migration-${process.pid}`),
      stagingRoot,
    ),
  }));
  const progress = { filesVerified: 0, bytesVerified: 0 };
  let lastReportAt = 0;
  const reportThrottled = (
    phase: IndexStorageMigrationPhase,
    filesVerified: number,
    bytesVerified: number,
  ) => {
    const now = Date.now();
    if (now - lastReportAt < 400 && filesVerified < totals.totalFiles) return;
    lastReportAt = now;
    report(phase, filesVerified, bytesVerified);
  };
  try {
    report("copying", 0, 0);
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
      reportThrottled("copying", progress.filesVerified, progress.bytesVerified);
    }

    report("committing", progress.filesVerified, progress.bytesVerified);
    const byTarget = new Map<string, MigrationNode>();
    for (const node of stagedNodes) {
      const key = path.resolve(node.target);
      const previous = byTarget.get(key);
      if (previous) {
        if (previous.kind !== node.kind ||
            (node.kind === "file" && (previous.size !== node.size || previous.hash !== node.hash)))
          throw new Error(`Index storage sources contain conflicting data at ${node.target}; all originals were preserved.`);
      } else {
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
      if (node.kind !== "file" || await assertTargetMatches(node)) continue;
      await fsPromises.mkdir(path.dirname(node.target), { recursive: true });
      await fsPromises.rename(node.staged, node.target);
    }

    for (const node of stagedNodes)
      if (node.kind === "file" && !(await assertTargetMatches(node)))
        throw new Error(`Index storage commit verification failed for ${node.target}; all originals were preserved.`);

    const currentNodes: MigrationNode[] = [];
    for (const source of sourceEntries) {
      const sourceRoot = sources.find((candidate) => isPathWithin(source, candidate))!;
      const entryName = path.relative(sourceRoot, source);
      await collectMigrationNodes(
        source,
        path.join(destinationRoot, entryName),
        "",
        currentNodes,
      );
    }
    if (currentNodes.length !== sourceSnapshotKeys.size ||
        currentNodes.some((node) => !sourceSnapshotKeys.has(migrationNodeKey(node))))
      throw new Error("Index storage sources changed during migration; all originals were preserved.");
    const verified = { files: 0, bytes: 0 };
    lastReportAt = 0;
    report("verifying", 0, 0);
    for (const node of stagedNodes) {
      if (node.kind !== "file") continue;
      const stats = await fsPromises.stat(node.source);
      if (stats.size !== node.size || await hashFile(node.source) !== node.hash)
        throw new Error(`Index storage source changed during migration: ${node.source}; all originals were preserved.`);
      verified.files += 1;
      verified.bytes += node.size;
      reportThrottled("verifying", verified.files, verified.bytes);
    }

    await beforeSourceRemoval?.();
    report("cleaning", progress.filesVerified, progress.bytesVerified);
    await archiveSuperseded();
    for (const source of sourceEntries)
      await fsPromises.rm(source, { recursive: true, force: true });
    return progress;
  } finally {
    await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
  }
}

export async function migrateIndexStorageEntries(
  userDataPath: string,
  storageRoot: string,
  entries: readonly string[] = INDEX_STORAGE_ENTRIES,
  onProgress?: ProgressListener,
): Promise<IndexStorageMigrationResult> {
  return migrateIndexStorageRoots([userDataPath], storageRoot, entries, onProgress);
}

export async function prepareExternalIndexStorage(
  userDataPath: string,
  storageRoot: string,
  onProgress?: ProgressListener,
): Promise<IndexStorageMigrationResult> {
  await validateExternalVolume(userDataPath, storageRoot);
  await fsPromises.mkdir(storageRoot, { recursive: true });
  return migrateIndexStorageEntries(
    userDataPath,
    storageRoot,
    INDEX_STORAGE_ENTRIES,
    onProgress,
  );
}

export async function prepareConfiguredIndexStorage(
  userDataPath: string,
  onProgress?: ProgressListener,
  options: { destinationUnavailable?: boolean } = {},
) {
  const settings = await readIndexStorageSettings(userDataPath);
  const storageRoot = settings.pendingPath ?? settings.path;
  const rememberedRoots = Array.from(
    new Set(
      (settings.knownPaths ?? []).map((root) => path.resolve(root)),
    ),
  );
  if (
    settings.pendingPath &&
    path.resolve(settings.path) !== path.resolve(userDataPath) &&
    !(await exists(settings.path))
  ) {
    // A staged destination change explicitly selects a new cache root. Retire
    // only the unavailable root being replaced; its files remain untouched,
    // while the new destination can rebuild derived indexes from originals.
    const unavailablePriorRoot = path.resolve(settings.path);
    for (let index = rememberedRoots.length - 1; index >= 0; index -= 1)
      if (rememberedRoots[index] === unavailablePriorRoot)
        rememberedRoots.splice(index, 1);
  }
  const missingRoots: string[] = [];
  for (const root of rememberedRoots) {
    if (root === path.resolve(storageRoot)) continue;
    if (!(await hasPersistedIndexData(root))) missingRoots.push(root);
  }
  if (path.resolve(storageRoot) === path.resolve(userDataPath))
    return {
      storageRoot: path.resolve(userDataPath),
      selectedStorageRoot: path.resolve(userDataPath),
      usingLocalFallback: false,
      destinationAvailable: true,
      localFallbackEnabled: settings.allowLocalFallback !== false,
      migrationCompleted: false,
      migrationError: null as string | null,
      missingRoots,
      filesVerified: 0,
      bytesVerified: 0,
    };

  const localFallbackRoot = getLocalFallbackIndexStorageRoot(userDataPath);
  const legacyFallbackRoot = getLegacyLocalFallbackIndexStorageRoot(userDataPath);
  try {
    // A drive that stopped responding is treated like a disconnected one so
    // Silo can open on its local cache instead of waiting on the drive.
    if (options.destinationUnavailable)
      throw new ExternalIndexStorageUnavailableError(storageRoot);
    await validateExternalVolume(userDataPath, storageRoot);
  } catch (error) {
    if (!(error instanceof ExternalIndexStorageUnavailableError)) throw error;
    const unavailableRoot = path.resolve(storageRoot);
    if (!missingRoots.includes(unavailableRoot)) missingRoots.push(unavailableRoot);
    const unavailableMessage =
      `The selected cache destination is unavailable: ${unavailableRoot}`;
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
        missingRoots,
        filesVerified: 0,
        bytesVerified: 0,
      };
    try {
      await fsPromises.mkdir(localFallbackRoot, { recursive: true });
      const sourceRoots = Array.from(
        new Set([
          ...rememberedRoots,
          path.resolve(userDataPath),
          legacyFallbackRoot,
        ]),
      ).filter(
        (root) =>
          path.resolve(root) !== path.resolve(localFallbackRoot) &&
          path.resolve(root) !== path.resolve(storageRoot),
      );
      const requiredBytes = await migrationBytes(sourceRoots);
      await assertLocalIndexStorageCapacity(localFallbackRoot, requiredBytes);
      const result = await migrateIndexStorageRoots(
        sourceRoots,
        localFallbackRoot,
        INDEX_STORAGE_ENTRIES,
        onProgress,
        undefined,
        { conflictPolicy: "strict" },
      );
      return {
        storageRoot: localFallbackRoot,
        selectedStorageRoot: path.resolve(storageRoot),
        usingLocalFallback: true,
        destinationAvailable: false,
        localFallbackEnabled: true,
        migrationCompleted: false,
        migrationError: null,
        missingRoots,
        filesVerified: result.filesVerified,
        bytesVerified: result.bytesVerified,
      };
    } catch (fallbackError) {
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
        migrationError:
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError),
        missingRoots,
        filesVerified: 0,
        bytesVerified: 0,
      };
    }
  }

  await fsPromises.mkdir(storageRoot, { recursive: true });
  const sourceRoots = new Set([
    settings.path,
    ...rememberedRoots,
    path.resolve(userDataPath),
    localFallbackRoot,
    legacyFallbackRoot,
  ]);
  sourceRoots.delete(storageRoot);
  for (const sourceRoot of sourceRoots)
    if (!(await exists(sourceRoot))) sourceRoots.delete(sourceRoot);
  const fallbackWasPresent =
    sourceRoots.has(localFallbackRoot) || sourceRoots.has(legacyFallbackRoot);
  const preserveKnownRoots = rememberedRoots.some(
    (root) => root !== path.resolve(storageRoot),
  );
  const storageRootHasIndexes = await hasPersistedIndexData(storageRoot);
  const committedKnownPaths = Array.from(
    new Set([
      ...(storageRootHasIndexes ? [path.resolve(storageRoot)] : []),
      ...missingRoots,
    ]),
  );
  const persistCommittedRoot = () =>
    writeIndexStorageRoot(userDataPath, storageRoot, committedKnownPaths, {
      replaceKnownPaths: true,
    });
  const result = await migrateIndexStorageRoots(
    Array.from(sourceRoots),
    storageRoot,
    INDEX_STORAGE_ENTRIES,
    onProgress,
    settings.pendingPath ? persistCommittedRoot : undefined,
    // Remembered roots and staged moves must reconcile strictly. Only ordinary
    // fallback reconnection may keep the destination's existing index stores.
    {
      conflictPolicy:
        settings.pendingPath || preserveKnownRoots
          ? "strict"
          : "keep-destination",
    },
  );
  if (!settings.pendingPath) await persistCommittedRoot();
  return {
    storageRoot,
    selectedStorageRoot: path.resolve(storageRoot),
    usingLocalFallback: false,
    destinationAvailable: true,
    localFallbackEnabled: settings.allowLocalFallback !== false,
    migrationCompleted: fallbackWasPresent,
    migrationError: null,
    missingRoots,
    filesVerified: result.filesVerified,
    bytesVerified: result.bytesVerified,
  };
}
