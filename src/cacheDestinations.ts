import { createHash, randomBytes } from "crypto";
import { constants, createReadStream, readFileSync, realpathSync } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

export const CACHE_DESTINATIONS = [
  {
    id: "semantic-index",
    entry: "semantic-index",
    name: "Search index and embeddings",
    description: "Saved file records and offline search vectors. Rebuildable, but expensive to recreate.",
    estimatePerTenThousand: "About 25–60 MB",
    estimateBytesPerTenThousand: 60 * 1024 * 1024,
    kind: "rebuildable-index",
  },
  {
    id: "face-index",
    entry: "face-index",
    name: "People and face data",
    description: "People assignments, face matches, edit history, and small face crops.",
    estimatePerTenThousand: "About 100–500 MB",
    estimateBytesPerTenThousand: 500 * 1024 * 1024,
    kind: "user-edited-index",
  },
  {
    id: "pets",
    entry: "pets",
    name: "Pet clusters",
    description: "Animal-photo matches and cluster summaries.",
    estimatePerTenThousand: "About 20–60 MB",
    estimateBytesPerTenThousand: 60 * 1024 * 1024,
    kind: "rebuildable-index",
  },
  {
    id: "thumbnail-cache",
    entry: "thumbnail-cache",
    name: "Photo and video thumbnails",
    description: "Generated small previews used by Browse, People, Places, and other grids.",
    estimatePerTenThousand: "About 200–800 MB",
    estimateBytesPerTenThousand: 800 * 1024 * 1024,
    kind: "disposable-cache",
  },
  {
    id: "preview-cache",
    entry: "preview-cache",
    name: "Document previews",
    description: "Generated document and media previews; contents vary with the files you open.",
    estimatePerTenThousand: "Usually under 1 GB; varies by file type",
    estimateBytesPerTenThousand: 1024 * 1024 * 1024,
    kind: "disposable-cache",
  },
  {
    id: "media-cache",
    entry: "media-cache",
    name: "Converted media",
    description: "Temporary compatible copies made when a source video or audio file cannot play directly.",
    estimatePerTenThousand: "Highly variable; may approach source-media size",
    estimateBytesPerTenThousand: 0,
    kind: "disposable-cache",
  },
  {
    id: "memory-image-cache",
    entry: "memory-image-cache",
    name: "Memories image previews",
    description: "Temporary resized images created while generating Memory previews.",
    estimatePerTenThousand: "About 0–2 GB; generated on demand",
    estimateBytesPerTenThousand: 2 * 1024 * 1024 * 1024,
    kind: "disposable-cache",
  },
  {
    id: "cloud-cache",
    entry: "cloud-cache",
    name: "Cloud media downloads",
    description: "Local copies Silo downloads for cloud previews and offline work; remote originals stay in your cloud account.",
    estimatePerTenThousand: "Highly variable; can approach the downloaded media size",
    estimateBytesPerTenThousand: 0,
    kind: "disposable-cache",
  },
  {
    id: "browser-session-data",
    entry: "browser-session-data",
    name: "Browser cache and web session data",
    description: "Chromium cache plus Silo web-session storage such as cookies and local site data. Keep it on a drive that stays connected.",
    estimatePerTenThousand: "Usually under 500 MB; depends on web sessions",
    estimateBytesPerTenThousand: 500 * 1024 * 1024,
    kind: "session-data",
  },
  {
    id: "geo-index.jsonl",
    entry: "geo-index.jsonl",
    name: "Places index",
    description: "Photo coordinates, named places, and location assignments.",
    estimatePerTenThousand: "About 5–25 MB",
    estimateBytesPerTenThousand: 25 * 1024 * 1024,
    kind: "user-edited-index",
  },
  {
    id: "geocode-cache.json",
    entry: "geocode-cache.json",
    name: "Place-name cache",
    description: "Local results that turn photo coordinates into city and country names.",
    estimatePerTenThousand: "About 1–10 MB",
    estimateBytesPerTenThousand: 10 * 1024 * 1024,
    kind: "disposable-cache",
  },
  {
    id: "geocode-search-cache.json",
    entry: "geocode-search-cache.json",
    name: "Place-search cache",
    description: "Recently searched map locations and their coordinates.",
    estimatePerTenThousand: "Usually under 5 MB",
    estimateBytesPerTenThousand: 5 * 1024 * 1024,
    kind: "disposable-cache",
  },
  {
    id: "duplicate-index.json",
    entry: "duplicate-index.json",
    name: "Duplicate index",
    description: "File hashes and duplicate-group results.",
    estimatePerTenThousand: "About 5–30 MB",
    estimateBytesPerTenThousand: 30 * 1024 * 1024,
    kind: "rebuildable-index",
  },
  {
    id: "aesthetic-index.jsonl",
    entry: "aesthetic-index.jsonl",
    name: "Photo quality analysis",
    description: "Saved ratings and signals used by photo curation tools.",
    estimatePerTenThousand: "About 5–20 MB",
    estimateBytesPerTenThousand: 20 * 1024 * 1024,
    kind: "rebuildable-index",
  },
  {
    id: "content-safety-index.json",
    entry: "content-safety-index.json",
    name: "Content-safety index",
    description: "Local safety scan results used to keep sensitive photos out of Memories.",
    estimatePerTenThousand: "About 5–25 MB",
    estimateBytesPerTenThousand: 25 * 1024 * 1024,
    kind: "rebuildable-index",
  },
  {
    id: "audio-library-index.json",
    entry: "audio-library-index.json",
    name: "Music library index",
    description: "Audio file names, locations, and scan details used by Memories music matching.",
    estimatePerTenThousand: "About 10–50 MB",
    estimateBytesPerTenThousand: 50 * 1024 * 1024,
    kind: "rebuildable-index",
  },
  {
    id: "library-stats.json",
    entry: "library-stats.json",
    name: "Library inventory summary",
    description: "Saved counts and source fingerprints that avoid rescanning unchanged folders.",
    estimatePerTenThousand: "Usually under 5 MB",
    estimateBytesPerTenThousand: 5 * 1024 * 1024,
    kind: "rebuildable-index",
  },
] as const;

export type CacheDestinationId = (typeof CACHE_DESTINATIONS)[number]["id"];
export type CacheDestinationRoots = Partial<Record<CacheDestinationId, string>>;

const SETTINGS_FILE = "cache-destinations.json";
const DESTINATION_FREE_SPACE_RESERVE = 512 * 1024 * 1024;

// Chromium keeps session-specific files beside Silo's own userData files on a
// fresh profile. Copy only Chromium-owned entries when relocating sessionData.
export const BROWSER_SESSION_DATA_ENTRIES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "ShaderCache",
  "Local Storage",
  "Session Storage",
  "Cookies",
  "Cookies-journal",
  "Network",
  "Shared Dictionary",
  "Service Worker",
  "blob_storage",
  "databases",
  "IndexedDB",
  "WebStorage",
  "Dictionaries",
  "DevTools",
  "Local State",
] as const;

export function isCacheDestinationId(value: unknown): value is CacheDestinationId {
  return CACHE_DESTINATIONS.some((item) => item.id === value);
}

/** Existing default-path profiles should keep using their current cache roots. */
export async function hasExistingDefaultCacheProfile(userDataPath: string): Promise<boolean> {
  const knownEntries = [
    path.join(userDataPath, "browser-state.json"),
    path.join(userDataPath, "index-storage.json"),
    ...CACHE_DESTINATIONS
      .filter((item) => item.id !== "browser-session-data")
      .map((item) => path.join(userDataPath, item.entry)),
  ];
  for (const candidate of knownEntries) {
    try {
      await fsPromises.lstat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

export function getCacheDestinationRoot(
  id: CacheDestinationId,
  roots: CacheDestinationRoots,
  fallbackRoot: string,
  pathApi: typeof path = path,
) {
  const selected = roots[id];
  return pathApi.resolve(typeof selected === "string" && selected.trim() ? selected : fallbackRoot);
}

export function getCacheEntryPath(
  id: CacheDestinationId,
  roots: CacheDestinationRoots,
  fallbackRoot: string,
  ...segments: string[]
) {
  const item = CACHE_DESTINATIONS.find((candidate) => candidate.id === id)!;
  return path.join(getCacheDestinationRoot(id, roots, fallbackRoot), item.entry, ...segments);
}

export function getCacheEntryPathForPlatform(
  id: CacheDestinationId,
  roots: CacheDestinationRoots,
  fallbackRoot: string,
  segments: string[],
  pathApi: typeof path,
) {
  const item = CACHE_DESTINATIONS.find((candidate) => candidate.id === id)!;
  return pathApi.join(getCacheDestinationRoot(id, roots, fallbackRoot, pathApi), item.entry, ...segments);
}

export function getCacheDestinationEntryRoots(
  roots: CacheDestinationRoots,
  fallbackRoot: string,
) {
  return CACHE_DESTINATIONS.map((item) =>
    path.join(getCacheDestinationRoot(item.id, roots, fallbackRoot), item.entry),
  );
}

export async function findUnavailableCacheDestinations(
  roots: CacheDestinationRoots,
  fallbackRoot: string,
) {
  const unavailable: Array<{ id: CacheDestinationId; name: string; root: string }> = [];
  for (const item of CACHE_DESTINATIONS) {
    const root = getCacheDestinationRoot(item.id, roots, fallbackRoot);
    try {
      const stats = await fsPromises.stat(root);
      if (!stats.isDirectory()) throw new Error("Not a folder");
      await fsPromises.access(root, constants.R_OK | constants.W_OK);
    } catch {
      unavailable.push({ id: item.id, name: item.name, root });
    }
  }
  return unavailable;
}

export async function readCacheDestinationRoots(userDataPath: string): Promise<CacheDestinationRoots | null> {
  const settingsPath = path.join(userDataPath, SETTINGS_FILE);
  let stored: unknown;
  try {
    stored = JSON.parse(await fsPromises.readFile(settingsPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  if (!stored || typeof stored !== "object" || (stored as any).format !== "silo-cache-destinations" || (stored as any).version !== 1 || !(stored as any).roots || typeof (stored as any).roots !== "object")
    throw new Error("The saved cache destination settings are invalid.");
  const roots: CacheDestinationRoots = {};
  for (const item of CACHE_DESTINATIONS) {
    const value = (stored as any).roots[item.id];
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new Error(`The saved destination for ${item.name} is invalid.`);
    roots[item.id] = path.resolve(value);
  }
  return roots;
}

/** Read only the browser-session destination before Electron emits `ready`. */
export function readCacheDestinationRootsSync(userDataPath: string): CacheDestinationRoots | null {
  try {
    const value = JSON.parse(readFileSync(path.join(userDataPath, SETTINGS_FILE), "utf8")) as {
      format?: unknown;
      version?: unknown;
      roots?: Record<string, unknown>;
    };
    if (value.format !== "silo-cache-destinations" || value.version !== 1 || !value.roots)
      return null;
    const roots: CacheDestinationRoots = {};
    for (const item of CACHE_DESTINATIONS) {
      const root = value.roots[item.id];
      if (typeof root === "string" && path.isAbsolute(root)) roots[item.id] = root;
    }
    return roots;
  } catch {
    return null;
  }
}

export async function writeCacheDestinationRoots(userDataPath: string, roots: CacheDestinationRoots) {
  const normalized: CacheDestinationRoots = {};
  for (const item of CACHE_DESTINATIONS) {
    const value = roots[item.id];
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new Error(`Choose an absolute folder for ${item.name}.`);
    normalized[item.id] = path.resolve(value);
  }
  await fsPromises.mkdir(userDataPath, { recursive: true });
  const target = path.join(userDataPath, SETTINGS_FILE);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fsPromises.writeFile(
    temporary,
    JSON.stringify({ format: "silo-cache-destinations", version: 1, roots: normalized }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await fsPromises.rename(temporary, target);
}

function pathWithin(candidate: string, parent: string, pathApi: typeof path = path) {
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

function canonicalPath(target: string) {
  let unresolved = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(unresolved), ...suffix);
    } catch {
      const parent = path.dirname(unresolved);
      if (parent === unresolved) return path.resolve(target);
      suffix.unshift(path.basename(unresolved));
      unresolved = parent;
    }
  }
}

export function isProbablyRemovablePath(
  target: string,
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
  pathApi: typeof path = path,
) {
  const resolved = pathApi.resolve(target);
  if (platform === "darwin") return pathWithin(resolved, "/Volumes", pathApi);
  if (platform === "win32") {
    const selectedDrive = pathApi.parse(resolved).root.toLowerCase();
    const profileDrive = pathApi.parse(pathApi.resolve(userDataPath)).root.toLowerCase();
    return Boolean(selectedDrive && profileDrive && selectedDrive !== profileDrive);
  }
  return false;
}

export async function inspectCacheDestination(target: string, userDataPath: string) {
  if (!path.isAbsolute(target)) throw new Error("Choose an absolute destination folder.");
  const selectedPath = path.resolve(target);
  const selectedCanonical = canonicalPath(selectedPath);
  const appData = path.resolve(userDataPath);
  const appDataCanonical = canonicalPath(appData);
  if (
    pathWithin(selectedCanonical, appDataCanonical) ||
    pathWithin(appDataCanonical, selectedCanonical)
  )
    throw new Error("Choose a cache folder outside Silo's app profile.");
  const stats = await fsPromises.stat(selectedCanonical);
  if (!stats.isDirectory()) throw new Error("The cache destination must be a folder.");
  await fsPromises.access(selectedCanonical, constants.R_OK | constants.W_OK);
  const volume = await fsPromises.statfs(selectedCanonical);
  const freeBytes = volume.bavail * volume.bsize;
  return {
    path: selectedCanonical,
    freeBytes,
    removable: isProbablyRemovablePath(selectedPath, appData),
  };
}

async function treeBytes(target: string): Promise<number> {
  let stats: Awaited<ReturnType<typeof fsPromises.lstat>>;
  try {
    stats = await fsPromises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`Cache transfer refuses symbolic links: ${target}`);
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) throw new Error(`Unsupported cache entry: ${target}`);
  let total = 0;
  for (const name of await fsPromises.readdir(target)) total += await treeBytes(path.join(target, name));
  return total;
}

async function hashFile(target: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function treeDigest(target: string): Promise<string> {
  const stats = await fsPromises.lstat(target);
  if (stats.isSymbolicLink()) throw new Error(`Cache transfer refuses symbolic links: ${target}`);
  if (stats.isFile()) return `file:${stats.size}:${await hashFile(target)}`;
  if (!stats.isDirectory()) throw new Error(`Unsupported cache entry: ${target}`);
  const digest = createHash("sha256");
  for (const name of (await fsPromises.readdir(target)).sort()) {
    digest.update(name);
    digest.update("\0");
    digest.update(await treeDigest(path.join(target, name)));
    digest.update("\n");
  }
  return `dir:${digest.digest("hex")}`;
}

async function copyTree(source: string, destination: string) {
  const stats = await fsPromises.lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`Cache transfer refuses symbolic links: ${source}`);
  if (stats.isDirectory()) {
    await fsPromises.mkdir(destination, { recursive: true });
    for (const name of await fsPromises.readdir(source))
      await copyTree(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!stats.isFile()) throw new Error(`Unsupported cache entry: ${source}`);
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  await fsPromises.copyFile(source, destination, constants.COPYFILE_EXCL);
}

export async function measureCacheEntry(root: string, entry: string) {
  return treeBytes(path.join(root, entry));
}

export async function copyBrowserSessionDataVerified(
  sourcePath: string,
  destinationRoot: string,
  userDataPath: string,
) {
  const item = CACHE_DESTINATIONS.find((candidate) => candidate.id === "browser-session-data")!;
  const targetDirectory = path.join(destinationRoot, item.entry);
  await inspectCacheDestination(destinationRoot, userDataPath);
  await fsPromises.mkdir(targetDirectory, { recursive: true });
  const copied: string[] = [];
  for (const entry of BROWSER_SESSION_DATA_ENTRIES) {
    const source = path.join(sourcePath, entry);
    const target = path.join(targetDirectory, entry);
    const result = await copyPathVerified(source, target, destinationRoot, userDataPath);
    if (result.copied) copied.push(entry);
  }
  return copied;
}

export async function copyCacheEntryVerified(
  entry: string,
  sourceRoot: string,
  destinationRoot: string,
  userDataPath: string,
) {
  if (!CACHE_DESTINATIONS.some((item) => item.entry === entry))
    throw new Error("Unknown Silo cache entry.");
  const sourceBase = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (sourceBase === destination) return { copied: false, bytes: 0 };
  return copyPathVerified(path.join(sourceBase, entry), path.join(destination, entry), destination, userDataPath);
}

export async function copyPathVerified(
  source: string,
  target: string,
  destinationRoot: string,
  userDataPath: string,
) {
  const destination = path.resolve(destinationRoot);
  const sourcePath = path.resolve(source);
  const targetPath = path.resolve(target);
  const sourceCanonical = canonicalPath(sourcePath);
  const targetCanonical = canonicalPath(targetPath);
  if (pathWithin(sourceCanonical, targetCanonical) || pathWithin(targetCanonical, sourceCanonical))
    throw new Error("Choose a destination separate from the current cache folder.");
  const sourceExists = await fsPromises.lstat(sourcePath).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (!sourceExists) return { copied: false, bytes: 0 };
  const bytes = await treeBytes(sourcePath);
  await inspectCacheDestination(destination, userDataPath);
  const space = await fsPromises.statfs(destination);
  const available = space.bavail * space.bsize;
  if (available < bytes + DESTINATION_FREE_SPACE_RESERVE)
    throw new Error(`The selected drive needs ${(bytes / 1024 ** 3).toFixed(2)} GiB for this cache plus a 512 MiB safety margin.`);

  await fsPromises.mkdir(destination, { recursive: true });
  const entryName = path.basename(targetPath);
  const staging = path.join(destination, `.silo-cache-transfer-${entryName}-${randomBytes(6).toString("hex")}`);
  const stagedEntry = path.join(staging, entryName);
  try {
    if (await fsPromises.lstat(targetPath).then(() => true, () => false)) {
      const [sourceHash, targetHash] = await Promise.all([treeDigest(sourcePath), treeDigest(targetPath)]);
      if (sourceHash !== targetHash)
        throw new Error(`A different ${entryName} already exists at the selected destination. Both copies were preserved.`);
      return { copied: false, bytes };
    }
    await copyTree(sourcePath, stagedEntry);
    const [sourceHash, stagedHash] = await Promise.all([treeDigest(sourcePath), treeDigest(stagedEntry)]);
    if (sourceHash !== stagedHash)
      throw new Error(`Cache verification failed for ${entryName}; the original copy was preserved.`);
    await fsPromises.rename(stagedEntry, targetPath);
    return { copied: true, bytes };
  } finally {
    await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function getCacheDestinationEstimates() {
  return CACHE_DESTINATIONS.map(({ id, entry, name, description, estimatePerTenThousand, estimateBytesPerTenThousand, kind }) => ({
    id,
    entry,
    name,
    description,
    estimatePerTenThousand,
    estimateBytesPerTenThousand,
    kind,
  }));
}
