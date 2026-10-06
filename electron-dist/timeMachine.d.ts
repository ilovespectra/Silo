export interface TimeMachineFileMetadata {
    backupTimestamp: number;
    backupSet: string;
    logicalPath: string;
    versionKey: string;
}
export declare function parseTimeMachineFile(filePath: string, size: number, modified: number, created: number, mode: number): TimeMachineFileMetadata | null;
export declare function shouldSkipTimeMachineEntry(name: string): boolean;
export declare function isTimeMachineDirectory(directoryPath: string): Promise<boolean>;
export declare function sortTimeMachineEntries<T extends {
    name: string;
}>(entries: T[]): T[];
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
export declare function sortTimeMachineEntriesAsync<T extends {
    name: string;
}>(entries: T[], batchSize?: number): Promise<T[]>;
