import * as path from 'path';
import * as fsPromises from 'fs/promises';

const snapshotPattern = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:\.(?:backup|previous))?$/;
const timeMachineMarkers = new Set(['Backups.backupdb', '.timemachine']);
const timeMachineManifest = 'backup_manifest.plist';

export interface TimeMachineFileMetadata {
  backupTimestamp: number;
  backupSet: string;
  logicalPath: string;
  versionKey: string;
}

function parseSnapshotName(name: string): number | null {
  const match = snapshotPattern.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function pathSegments(filePath: string): string[] {
  return path.resolve(filePath).split(path.sep).filter(Boolean);
}

export function parseTimeMachineFile(
  filePath: string,
  size: number,
  modified: number,
  created: number,
  mode: number,
): TimeMachineFileMetadata | null {
  const segments = pathSegments(filePath);
  const snapshotIndex = segments.findIndex((segment) => parseSnapshotName(segment) !== null);
  if (snapshotIndex < 0 || snapshotIndex === segments.length - 1) return null;

  const backupTimestamp = parseSnapshotName(segments[snapshotIndex])!;
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

export function shouldSkipTimeMachineEntry(name: string): boolean {
  return name === 'Latest'
    || name === '.DS_Store'
    || name.endsWith('.inProgress')
    || name.startsWith('.com.apple.TimeMachine');
}

export async function isTimeMachineDirectory(directoryPath: string): Promise<boolean> {
  const selectedSegments = pathSegments(directoryPath);
  if (selectedSegments.some((segment) => timeMachineMarkers.has(segment) || parseSnapshotName(segment) !== null)) {
    return true;
  }

  try {
    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    return entries.some((entry) => (
      timeMachineMarkers.has(entry.name)
      || entry.name === timeMachineManifest
      || parseSnapshotName(entry.name) !== null
    ));
  } catch {
    return false;
  }
}

export function sortTimeMachineEntries<T extends { name: string }>(entries: T[]): T[] {
  return [...entries].sort((first, second) => {
    const firstTimestamp = parseSnapshotName(first.name) || 0;
    const secondTimestamp = parseSnapshotName(second.name) || 0;
    if (firstTimestamp !== secondTimestamp) return secondTimestamp - firstTimestamp;
    return first.name.localeCompare(second.name);
  });
}

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
export async function sortTimeMachineEntriesAsync<T extends { name: string }>(
  entries: T[],
  batchSize = 100,
): Promise<T[]> {
  if (entries.length <= 1) return entries;

  const resolved = entries.map((entry) => ({
    entry,
    timestamp: parseSnapshotName(entry.name) || 0,
  }));

  resolved.sort((first, second) => {
    if (first.timestamp !== second.timestamp) return second.timestamp - first.timestamp;
    return first.entry.name < second.entry.name ? -1 : first.entry.name > second.entry.name ? 1 : 0;
  });

  const sorted: T[] = new Array(resolved.length);
  for (let i = 0; i < resolved.length; i += 1) sorted[i] = resolved[i].entry;

  // Only need to yield for genuinely large directories; keeps small scans fast.
  if (sorted.length > batchSize) {
    for (let offset = batchSize; offset < sorted.length; offset += batchSize) {
      await new Promise<void>((resolve) => setImmediate(() => resolve()));
    }
  }

  return sorted;
}
