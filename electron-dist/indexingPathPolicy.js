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
exports.isWithinSiloClone = exports.invalidateSiloCloneDirectoryCache = exports.isSiloCloneDirectory = exports.isAppDataPath = exports.canonicalPathFromSource = exports.isPathWithin = exports.isNonLibraryPath = exports.isPhoneDerivativePath = void 0;
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const indexingStorage_1 = require("./indexingStorage");
const CLONE_MARKERS = [
    ".silo-clone-in-progress.json",
    "silo-clone-manifest.json",
];
const cloneMarkerCache = new Map();
const cloneMarkerChecks = new Map();
const CLONE_MARKER_CACHE_LIMIT = 4096;
const NEGATIVE_MARKER_CACHE_MS = 2000;
// iOS-generated derivatives (thumbnail strips, caches) duplicate every real photo.
const PHONE_DERIVATIVE_PATTERN = /(^|[\\/])PhotoData[\\/](Thumbnails|Caches|MISC|Metadata|CPLAssets[\\/]\.thumbnails)([\\/]|$)/i;
/** Phone-generated thumbnails and caches: never indexed, browsed for memories, or backed up. */
function isPhoneDerivativePath(candidatePath) {
    return PHONE_DERIVATIVE_PATTERN.test(candidatePath);
}
exports.isPhoneDerivativePath = isPhoneDerivativePath;
// Software trees (dependencies, app bundles, VCS internals) hold thousands of files and no memories.
const NON_LIBRARY_SEGMENT = /(^|[\\/])(node_modules|bower_components|\.git|\.svn|\.hg|__pycache__|\.Trashes|\.cache|\.silo-phone-restores|[^\\/]+\.(app|asar|framework|bundle|plugin|kext|xpc|appex|xcodeproj|xcassets))([\\/]|$)/i;
/** True for paths inside software trees that are never indexed or scanned for search. */
function isNonLibraryPath(candidatePath) {
    return NON_LIBRARY_SEGMENT.test(candidatePath);
}
exports.isNonLibraryPath = isNonLibraryPath;
/** True when candidate is root itself or is below it at a path boundary. */
function isPathWithin(candidatePath, rootPath) {
    const candidate = path.resolve(candidatePath);
    const root = path.resolve(rootPath);
    const relative = path.relative(root, candidate);
    return (relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)));
}
exports.isPathWithin = isPathWithin;
/** Map a path discovered below a possibly aliased source root to its real-root spelling. */
function canonicalPathFromSource(sourcePath, canonicalSourcePath, candidatePath) {
    const source = path.resolve(sourcePath);
    const candidate = path.resolve(candidatePath);
    const relative = path.relative(source, candidate);
    if (relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        return candidate;
    }
    return path.resolve(canonicalSourcePath, relative);
}
exports.canonicalPathFromSource = canonicalPathFromSource;
/**
 * Identify Silo-owned app data both lexically and through a source-root alias.
 * This protects every current/future generated index below userData without
 * hiding phone contents exposed through the virtual /__phone__ and
 * /__phone_backup__ roots.
 */
function isAppDataPath(candidatePath, sourcePath, canonicalSourcePath, appDataPath, canonicalAppDataPath) {
    const indexStorageRoots = (0, indexingStorage_1.getIndexStorageExclusionRoots)();
    const canonicalCandidate = canonicalPathFromSource(sourcePath, canonicalSourcePath, candidatePath);
    return (isPathWithin(candidatePath, appDataPath) ||
        indexStorageRoots.some((root) => isPathWithin(candidatePath, root)) ||
        isPathWithin(canonicalCandidate, canonicalAppDataPath) ||
        indexStorageRoots.some((root) => isPathWithin(canonicalCandidate, root)));
}
exports.isAppDataPath = isAppDataPath;
async function isSiloCloneDirectory(directoryPath) {
    const key = path.resolve(directoryPath);
    const cached = cloneMarkerCache.get(key);
    if (cached && (cached.value || Date.now() - cached.checkedAt < NEGATIVE_MARKER_CACHE_MS))
        return cached.value;
    const pending = cloneMarkerChecks.get(key);
    if (pending)
        return pending;
    const check = readCloneMarkers(key);
    cloneMarkerChecks.set(key, check);
    try {
        const value = await check;
        cloneMarkerCache.delete(key);
        cloneMarkerCache.set(key, { value, checkedAt: Date.now() });
        if (cloneMarkerCache.size > CLONE_MARKER_CACHE_LIMIT)
            cloneMarkerCache.delete(cloneMarkerCache.keys().next().value);
        return value;
    }
    finally {
        cloneMarkerChecks.delete(key);
    }
}
exports.isSiloCloneDirectory = isSiloCloneDirectory;
async function readCloneMarkers(directoryPath) {
    for (const markerName of CLONE_MARKERS) {
        try {
            const marker = JSON.parse(await fsPromises.readFile(path.join(directoryPath, markerName), "utf8"));
            if (marker?.format === "silo-source-clone" && marker.version === 1)
                return true;
        }
        catch {
            // Missing, partial, or unrelated marker files do not hide user data.
        }
    }
    return false;
}
function invalidateSiloCloneDirectoryCache(directoryPath) {
    cloneMarkerCache.delete(path.resolve(directoryPath));
}
exports.invalidateSiloCloneDirectoryCache = invalidateSiloCloneDirectoryCache;
async function isWithinSiloClone(candidatePath, sourcePath) {
    const source = path.resolve(sourcePath);
    let current = path.resolve(candidatePath);
    if (!isPathWithin(current, source))
        return false;
    while (isPathWithin(current, source)) {
        if (await isSiloCloneDirectory(current))
            return true;
        if (current === source)
            break;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return false;
}
exports.isWithinSiloClone = isWithinSiloClone;
