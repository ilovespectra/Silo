import { createHash, randomBytes } from "crypto";
import { createReadStream, realpathSync } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

const INDEX_STORAGE_SETTINGS_FILE = "index-storage.json";

interface IndexStorageSettings {
  format: string;
  version: number;
  path: string;
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
}

export function setIndexStorageExclusionRoots(storageRoots: readonly string[]) {
  indexStorageExclusionRoots = Array.from(
    new Set(storageRoots.map((storageRoot) => path.resolve(storageRoot))),
  );
  canonicalIndexStorageExclusionRoots = null;
}

export function getIndexStorageExclusionRoots() {
  if (canonicalIndexStorageExclusionRoots) return canonicalIndexStorageExclusionRoots;
  canonicalIndexStorageExclusionRoots = Array.from(
    new Set(
      indexStorageExclusionRoots.flatMap((storageRoot) => [
        storageRoot,
        canonicalizeStoragePath(storageRoot),
      ]),
    ),
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
    allowLocalFallback: settings.allowLocalFallback !== false,
  };
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
    allowLocalFallback !== undefined &&
    typeof allowLocalFallback !== "boolean"
  )
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

export async function writeIndexStorageRoot(
  userDataPath: string,
  storageRoot: string,
) {
  if (!path.isAbsolute(storageRoot))
    throw new Error("Index storage path must be absolute.");
  const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
  const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
  const currentSettings = await readIndexStorageSettings(userDataPath);
  await fsPromises.writeFile(
    temporaryPath,
    JSON.stringify(
      {
        ...currentSettings,
        format: "silo-index-storage",
        version: 1,
        path: path.resolve(storageRoot),
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
  const settingsPath = path.join(userDataPath, INDEX_STORAGE_SETTINGS_FILE);
  const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
  await fsPromises.writeFile(
    temporaryPath,
    JSON.stringify(
      { ...settings, pendingPath: nextRoot },
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

type ProgressListener = (filesVerified: number, bytesVerified: number) => void;

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

  const [existingAncestor, userData] = await Promise.all([
    getExistingAncestor(storageRoot),
    fsPromises.stat(userDataPath),
  ]);
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

  const volume = await fsPromises.stat(existingAncestor);
  if (volume.dev === userData.dev) {
    if (!(await exists(storageRoot)))
      throw new ExternalIndexStorageUnavailableError(storageRoot);
    throw new Error(
      `The selected index storage must be on a separate external volume: ${storageRoot}.`,
    );
  }
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

export async function migrateIndexStorageRoots(
  sourceRoots: readonly string[],
  storageRoot: string,
  entries: readonly string[] = INDEX_STORAGE_ENTRIES,
  onProgress?: ProgressListener,
  beforeSourceRemoval?: () => Promise<void>,
): Promise<IndexStorageMigrationResult> {
  const destinationRoot = path.resolve(storageRoot);
  const sources = Array.from(new Set(sourceRoots.map((source) => path.resolve(source))))
    .filter((source) => source !== destinationRoot);
  for (const source of sources) {
    if (isPathWithin(source, destinationRoot) || isPathWithin(destinationRoot, source))
      throw new Error("Index storage migration source and destination must be separate.");
  }

  await fsPromises.mkdir(destinationRoot, { recursive: true });
  const sourceEntries: string[] = [];
  const nodes: MigrationNode[] = [];
  let requiredBytes = 0;
  for (let rootIndex = 0; rootIndex < sources.length; rootIndex += 1) {
    const sourceRoot = sources[rootIndex];
    for (const name of entries) {
      const source = path.join(sourceRoot, name);
      if (!(await exists(source))) continue;
      const staged = path.join(destinationRoot, `.silo-index-migration-${process.pid}`, String(rootIndex), name);
      const before = nodes.length;
      await collectMigrationNodes(source, path.join(destinationRoot, name), staged, nodes);
      sourceEntries.push(source);
      for (const node of nodes.slice(before))
        if (node.kind === "file") requiredBytes += node.size;
    }
  }
  await assertEnoughSpace(destinationRoot, requiredBytes);
  if (nodes.length === 0) {
    await beforeSourceRemoval?.();
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

    const originalKeys = new Set(nodes.map(migrationNodeKey));
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
    if (currentNodes.length !== nodes.length ||
        currentNodes.some((node) => !originalKeys.has(migrationNodeKey(node))))
      throw new Error("Index storage sources changed during migration; all originals were preserved.");
    for (const node of nodes) {
      if (node.kind !== "file") continue;
      const stats = await fsPromises.stat(node.source);
      if (stats.size !== node.size || await hashFile(node.source) !== node.hash)
        throw new Error(`Index storage source changed during migration: ${node.source}; all originals were preserved.`);
    }

    await beforeSourceRemoval?.();
    for (const source of sourceEntries)
      await fsPromises.rm(source, { recursive: true, force: true });
    onProgress?.(progress.filesVerified, progress.bytesVerified);
    return progress;
  } finally {
    await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
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
  const [userDataStats, storageStats] = await Promise.all([
    fsPromises.stat(userDataPath),
    fsPromises.stat(storageRoot),
  ]);
  if (userDataStats.dev === storageStats.dev)
    throw new Error(`Selected index storage is not on an external volume: ${storageRoot}`);
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
) {
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
      migrationError: null as string | null,
      filesVerified: 0,
      bytesVerified: 0,
    };

  const localFallbackRoot = getLocalFallbackIndexStorageRoot(userDataPath);
  const legacyFallbackRoot = getLegacyLocalFallbackIndexStorageRoot(userDataPath);
  try {
    await validateExternalVolume(userDataPath, storageRoot);
  } catch (error) {
    if (!(error instanceof ExternalIndexStorageUnavailableError)) throw error;
    const unavailableMessage =
      `The selected cache destination is unavailable: ${storageRoot}`;
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
      if (
        path.resolve(legacyFallbackRoot) !== path.resolve(localFallbackRoot) &&
        (await exists(legacyFallbackRoot))
      ) {
        const legacyResult = await migrateIndexStorageRoots(
          [legacyFallbackRoot],
          localFallbackRoot,
          INDEX_STORAGE_ENTRIES,
          onProgress,
        );
        legacyFilesVerified = legacyResult.filesVerified;
        legacyBytesVerified = legacyResult.bytesVerified;
      }
      const result = await migrateIndexStorageRoots(
        [path.resolve(userDataPath)],
        localFallbackRoot,
        INDEX_STORAGE_ENTRIES,
        onProgress,
      );
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
    if (!(await exists(sourceRoot))) sourceRoots.delete(sourceRoot);
  const fallbackWasPresent =
    sourceRoots.has(localFallbackRoot) || sourceRoots.has(legacyFallbackRoot);
  const result = await migrateIndexStorageRoots(
    Array.from(sourceRoots),
    storageRoot,
    INDEX_STORAGE_ENTRIES,
    onProgress,
    settings.pendingPath
      ? () => writeIndexStorageRoot(userDataPath, storageRoot)
      : undefined,
  );
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
