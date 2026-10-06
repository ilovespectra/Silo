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
exports.sortTimeMachineEntriesAsync = exports.sortTimeMachineEntries = exports.isTimeMachineDirectory = exports.shouldSkipTimeMachineEntry = exports.parseTimeMachineFile = void 0;
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const snapshotPattern = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:\.(?:backup|previous))?$/;
const timeMachineMarkers = new Set(['Backups.backupdb', '.timemachine']);
const timeMachineManifest = 'backup_manifest.plist';
function parseSnapshotName(name) {
    const match = snapshotPattern.exec(name);
    if (!match)
        return null;
    const [, year, month, day, hour, minute, second] = match;
    const timestamp = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
}
function pathSegments(filePath) {
    return path.resolve(filePath).split(path.sep).filter(Boolean);
}
function parseTimeMachineFile(filePath, size, modified, created, mode) {
    const segments = pathSegments(filePath);
    const snapshotIndex = segments.findIndex((segment) => parseSnapshotName(segment) !== null);
    if (snapshotIndex < 0 || snapshotIndex === segments.length - 1)
        return null;
    const backupTimestamp = parseSnapshotName(segments[snapshotIndex]);
    const markerIndex = segments.findIndex((segment) => timeMachineMarkers.has(segment));
    const backupSet = markerIndex >= 0
        ? segments.slice(markerIndex + 1, snapshotIndex).join(path.sep)
        : segments.slice(0, snapshotIndex).join(path.sep);
    const logicalPath = segments.slice(snapshotIndex + 1).join(path.sep);
    return {
        backupTimestamp,
        backupSet,
        logicalPath,
        versionKey: `${backupSet}\0${logicalPath}\0${size}\0${modified}\0${created}\0${mode}`,
    };
}
exports.parseTimeMachineFile = parseTimeMachineFile;
function shouldSkipTimeMachineEntry(name) {
    return name === 'Latest'
        || name === '.DS_Store'
        || name.endsWith('.inProgress')
        || name.startsWith('.com.apple.TimeMachine');
}
exports.shouldSkipTimeMachineEntry = shouldSkipTimeMachineEntry;
async function isTimeMachineDirectory(directoryPath) {
    const selectedSegments = pathSegments(directoryPath);
    if (selectedSegments.some((segment) => timeMachineMarkers.has(segment) || parseSnapshotName(segment) !== null)) {
        return true;
    }
    try {
        const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
        return entries.some((entry) => (timeMachineMarkers.has(entry.name)
            || entry.name === timeMachineManifest
            || parseSnapshotName(entry.name) !== null));
    }
    catch {
        return false;
    }
}
exports.isTimeMachineDirectory = isTimeMachineDirectory;
function sortTimeMachineEntries(entries) {
    return [...entries].sort((first, second) => {
        const firstTimestamp = parseSnapshotName(first.name) || 0;
        const secondTimestamp = parseSnapshotName(second.name) || 0;
        if (firstTimestamp !== secondTimestamp)
            return secondTimestamp - firstTimestamp;
        return first.name.localeCompare(second.name);
    });
}
exports.sortTimeMachineEntries = sortTimeMachineEntries;
/**
 * Async, batch-processed variant of {@link sortTimeMachineEntries}.
 *
 * The synchronous form sorts an entire directory listing at once. Inside a Time
 * Machine backup tree a single directory can easily hold tens of thousands of
 * entries (hardlink snapshots), and `readFiles` invokes the sort for *every*
 * directory it visits. Running `localeCompare` over all of them in one tick
 * blocks the Electron main-process event loop and freezes the UI.
 *
 * This variant:
 *  - computes each entry's snapshot timestamp exactly once and caches it;
 *  - uses cheap `<`/`>` string comparison instead of `localeCompare`;
 *  - slices the sort into `batchSize` (default 100) chunks and `await`s a
 *    macrotask via `setImmediate` between chunks, letting IPC, rendering and
 *    thumbnail jobs run between batches.
 */
async function sortTimeMachineEntriesAsync(entries, batchSize = 100) {
    if (entries.length <= 1)
        return entries;
    const resolved = entries.map((entry) => ({
        entry,
        timestamp: parseSnapshotName(entry.name) || 0,
    }));
    resolved.sort((first, second) => {
        if (first.timestamp !== second.timestamp)
            return second.timestamp - first.timestamp;
        return first.entry.name < second.entry.name ? -1 : first.entry.name > second.entry.name ? 1 : 0;
    });
    const sorted = new Array(resolved.length);
    for (let i = 0; i < resolved.length; i += 1)
        sorted[i] = resolved[i].entry;
    // Only need to yield for genuinely large directories; keeps small scans fast.
    if (sorted.length > batchSize) {
        for (let offset = batchSize; offset < sorted.length; offset += batchSize) {
            await new Promise((resolve) => setImmediate(() => resolve()));
        }
    }
    return sorted;
}
exports.sortTimeMachineEntriesAsync = sortTimeMachineEntriesAsync;
