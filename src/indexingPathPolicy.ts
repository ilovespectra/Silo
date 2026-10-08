import * as path from "path";
import * as fsPromises from "fs/promises";
import { getIndexStorageExclusionRoots } from "./indexingStorage";

const CLONE_MARKERS = [
  ".silo-clone-in-progress.json",
  "silo-clone-manifest.json",
];
const cloneMarkerCache = new Map<string, { value: boolean; checkedAt: number }>();
const cloneMarkerChecks = new Map<string, Promise<boolean>>();
const CLONE_MARKER_CACHE_LIMIT = 4096;
const NEGATIVE_MARKER_CACHE_MS = 2000;
// iOS-generated derivatives (thumbnail strips, caches) duplicate every real photo.
const PHONE_DERIVATIVE_PATTERN = /(^|[\\/])PhotoData[\\/](Thumbnails|Caches|MISC|Metadata|CPLAssets[\\/]\.thumbnails)([\\/]|$)/i;
export const MAC_DATA_VOLUME_ROOT = path.resolve("/System/Volumes/Data");
const MAC_DATA_VOLUME_EXCLUDED_ROOTS = new Set([
  "System",
  "Volumes",
  "home",
  "dev",
  "cores",
  ".Spotlight-V100",
  ".fseventsd",
  ".Trashes",
  ".TemporaryItems",
  ".DocumentRevisions-V100",
]);

/** Phone-generated thumbnails and caches: never indexed, browsed for memories, or backed up. */
export function isPhoneDerivativePath(candidatePath: string): boolean {
  return PHONE_DERIVATIVE_PATTERN.test(candidatePath);
}

export function isMacDataVolumeSourceRoot(sourceRoot: string): boolean {
  return path.resolve(sourceRoot) === MAC_DATA_VOLUME_ROOT;
}

export async function getMacDataVolumeDeviceId(sourceRoot: string): Promise<number | null> {
  if (!isMacDataVolumeSourceRoot(sourceRoot)) return null;
  try {
    const stats = await fsPromises.stat(MAC_DATA_VOLUME_ROOT);
    return stats.isDirectory() ? stats.dev : null;
  } catch {
    return null;
  }
}

export function isMacDataVolumePathExcluded(candidatePath: string, sourceRoot: string): boolean {
  if (!isMacDataVolumeSourceRoot(sourceRoot)) return false;
  const relative = path.relative(MAC_DATA_VOLUME_ROOT, path.resolve(candidatePath));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return false;
  const segments = relative.split(path.sep);
  if (MAC_DATA_VOLUME_EXCLUDED_ROOTS.has(segments[0])) return true;
  if (segments[0] === "private" && ["var", "tmp"].includes(segments[1])) return true;
  return segments.some((segment, index) =>
    (segment === "Caches" || segment === "Logs") && segments[index - 1] === "Library",
  );
}

// Software trees (dependencies, app bundles, VCS internals) hold thousands of files and no memories.
const NON_LIBRARY_SEGMENT = /(^|[\\/])(node_modules|bower_components|\.git|\.svn|\.hg|__pycache__|\.Trashes|\.cache|\.silo-phone-restores|[^\\/]+\.(app|asar|framework|bundle|plugin|kext|xpc|appex|xcodeproj|xcassets))([\\/]|$)/i;

/** True for paths inside software trees that are never indexed or scanned for search. */
export function isNonLibraryPath(candidatePath: string): boolean {
  return NON_LIBRARY_SEGMENT.test(candidatePath);
}

/** True when candidate is root itself or is below it at a path boundary. */
export function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Map a path discovered below a possibly aliased source root to its real-root spelling. */
export function canonicalPathFromSource(
  sourcePath: string,
  canonicalSourcePath: string,
  candidatePath: string,
): string {
  const source = path.resolve(sourcePath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(source, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return candidate;
  }
  return path.resolve(canonicalSourcePath, relative);
}

/**
 * Identify Silo-owned app data both lexically and through a source-root alias.
 * This protects every current/future generated index below userData without
 * hiding phone contents exposed through the virtual /__phone__ and
 * /__phone_backup__ roots.
 */
export function isAppDataPath(
  candidatePath: string,
  sourcePath: string,
  canonicalSourcePath: string,
  appDataPath: string,
  canonicalAppDataPath: string,
): boolean {
  const indexStorageRoots = getIndexStorageExclusionRoots();
  const canonicalCandidate = canonicalPathFromSource(
    sourcePath,
    canonicalSourcePath,
    candidatePath,
  );
  return (
    isPathWithin(candidatePath, appDataPath) ||
    indexStorageRoots.some((root) => isPathWithin(candidatePath, root)) ||
    isPathWithin(canonicalCandidate, canonicalAppDataPath) ||
    indexStorageRoots.some((root) => isPathWithin(canonicalCandidate, root))
  );
}

export async function isSiloCloneDirectory(directoryPath: string): Promise<boolean> {
  const key = path.resolve(directoryPath);
  const cached = cloneMarkerCache.get(key);
  if (cached && (cached.value || Date.now() - cached.checkedAt < NEGATIVE_MARKER_CACHE_MS))
    return cached.value;
  const pending = cloneMarkerChecks.get(key);
  if (pending) return pending;
  const check = readCloneMarkers(key);
  cloneMarkerChecks.set(key, check);
  try {
    const value = await check;
    cloneMarkerCache.delete(key);
    cloneMarkerCache.set(key, { value, checkedAt: Date.now() });
    if (cloneMarkerCache.size > CLONE_MARKER_CACHE_LIMIT)
      cloneMarkerCache.delete(cloneMarkerCache.keys().next().value!);
    return value;
  } finally {
    cloneMarkerChecks.delete(key);
  }
}

async function readCloneMarkers(directoryPath: string): Promise<boolean> {
  for (const markerName of CLONE_MARKERS) {
    try {
      const marker = JSON.parse(
        await fsPromises.readFile(path.join(directoryPath, markerName), "utf8"),
      );
      if (marker?.format === "silo-source-clone" && marker.version === 1)
        return true;
    } catch {
      // Missing, partial, or unrelated marker files do not hide user data.
    }
  }
  return false;
}

export function invalidateSiloCloneDirectoryCache(directoryPath: string) {
  cloneMarkerCache.delete(path.resolve(directoryPath));
}

export async function isWithinSiloClone(
  candidatePath: string,
  sourcePath: string,
): Promise<boolean> {
  const source = path.resolve(sourcePath);
  let current = path.resolve(candidatePath);
  if (!isPathWithin(current, source)) return false;
  while (isPathWithin(current, source)) {
    if (await isSiloCloneDirectory(current)) return true;
    if (current === source) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}
