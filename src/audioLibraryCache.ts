import { promises as fsPromises } from "fs";
import path from "path";
import { isAppDataPath, isSiloCloneDirectory } from "./indexingPathPolicy";

const AUDIO_SCAN_DIRECTORY_WORKERS = 1;
const AUDIO_SCAN_COOLDOWN_EVERY_ENTRIES = 256;
const AUDIO_SCAN_COOLDOWN_MIN_MS = 20;
const AUDIO_SCAN_COOLDOWN_MAX_MS = 300;

export interface CachedAudioFile {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: number;
  isDirectory: boolean;
  type: string;
  extension: string;
  sourceId?: string;
  sourceLabel?: string;
}

export interface AudioLibraryCacheSnapshot {
  version: 1;
  sourceIds: string[];
  scannedAt: number;
  files: CachedAudioFile[];
  extensions: string[];
  stale?: boolean;
  failedSources?: string[];
  sourceScannedAt?: Record<string, number>;
  sourceCooldownUntil?: Record<string, number>;
  sourceErrors?: Record<string, { message: string; lastAttemptAt: number }>;
}

export interface AudioLibraryScanProgress {
  source: string;
  scanned: number;
  audioFound: number;
  sourceIndex: number;
  sourceCount: number;
  phase: "scanning" | "retrying" | "cooldown" | "source-complete";
  message: string;
  files?: CachedAudioFile[];
}

export class AudioLibraryCache {
  private cachePath: string;
  private snapshot: AudioLibraryCacheSnapshot = {
    version: 1,
    sourceIds: [],
    scannedAt: 0,
    files: [],
    extensions: [],
  };
  private scanPromise: Promise<AudioLibraryCacheSnapshot> | null = null;
  private cancelled = false;
  private sourceCooldowns = new Map<string, number>();

  constructor(userDataPath: string) {
    this.cachePath = path.join(userDataPath, "audio-library-index.json");
  }

  async initialize() {
    await fsPromises.mkdir(path.dirname(this.cachePath), { recursive: true });
    try {
      const stored = JSON.parse(
        await fsPromises.readFile(this.cachePath, "utf8"),
      ) as AudioLibraryCacheSnapshot;
      if (stored.version === 1 && Array.isArray(stored.files))
        this.snapshot = {
          version: 1,
          sourceIds: Array.isArray(stored.sourceIds) ? stored.sourceIds : [],
          scannedAt: Number(stored.scannedAt) || 0,
          files: stored.files.filter(
            (file) => file && typeof file.path === "string",
          ),
          extensions: Array.isArray(stored.extensions) ? stored.extensions : [],
          failedSources: Array.isArray(stored.failedSources)
            ? stored.failedSources
            : [],
          sourceErrors: stored.sourceErrors ?? {},
          sourceScannedAt: stored.sourceScannedAt ?? {},
          sourceCooldownUntil: stored.sourceCooldownUntil ?? {},
        };
      this.sourceCooldowns = new Map(
        Object.entries(this.snapshot.sourceCooldownUntil ?? {}),
      );
    } catch {
      // First launch: an empty cache will be populated on the audio screen.
    }
  }

  getSnapshot(): AudioLibraryCacheSnapshot {
    return {
      ...this.snapshot,
      files: this.snapshot.files,
      sourceIds: [...this.snapshot.sourceIds],
      extensions: [...this.snapshot.extensions],
      failedSources: [...(this.snapshot.failedSources ?? [])],
    };
  }

  cancelScan() {
    this.cancelled = true;
  }

  async scan(
    sources: Array<{
      id: string;
      rootPath: string;
      kind: string;
      label: string;
    }>,
    isRemotePath: (value: string) => boolean,
    isAudio: (fileName: string) => boolean,
    listRemoteFiles: (source: {
      id: string;
      rootPath: string;
      kind: string;
      label: string;
    }) => Promise<CachedAudioFile[]>,
    onProgress: (progress: AudioLibraryScanProgress) => void,
    force = false,
    shouldPauseForSearch: () => boolean = () => false,
  ) {
    if (this.scanPromise) return this.scanPromise;
    this.cancelled = false;
    if (force)
      for (const source of sources) this.sourceCooldowns.delete(source.id);
    const pending = this.scanImpl(
      sources,
      isRemotePath,
      isAudio,
      listRemoteFiles,
      onProgress,
      force,
      shouldPauseForSearch,
    ).finally(() => {
      this.scanPromise = null;
    });
    this.scanPromise = pending;
    return pending;
  }

  private async scanImpl(
    sources: Array<{
      id: string;
      rootPath: string;
      kind: string;
      label: string;
    }>,
    isRemotePath: (value: string) => boolean,
    isAudio: (fileName: string) => boolean,
    listRemoteFiles: (source: {
      id: string;
      rootPath: string;
      kind: string;
      label: string;
    }) => Promise<CachedAudioFile[]>,
    onProgress: (progress: AudioLibraryScanProgress) => void,
    force: boolean,
    shouldPauseForSearch: () => boolean,
  ) {
    const waitForSearchIdle = async () => {
      while (!this.cancelled && shouldPauseForSearch())
        await new Promise((resolve) => setTimeout(resolve, 75));
      return !this.cancelled;
    };
    const sourceIds = sources.map((source) => source.id);
    const next = new Map(
      this.snapshot.files
        .filter((file) => file.sourceId && sourceIds.includes(file.sourceId))
        .map((file) => [file.path, file]),
    );
    const failedSources = new Set(
      (this.snapshot.failedSources ?? []).filter((id) =>
        sourceIds.includes(id),
      ),
    );
    const sourceScannedAt = { ...(this.snapshot.sourceScannedAt ?? {}) };
    const sourceErrors = { ...(this.snapshot.sourceErrors ?? {}) };
    for (const [sourceIndex, source] of sources.entries()) {
      if (this.cancelled) return this.getSnapshot();
      const previousScan = sourceScannedAt[source.id] ?? 0;
      const sourceIsFresh =
        previousScan > 0 && Date.now() - previousScan < 24 * 60 * 60 * 1000;
      if (sourceIsFresh && !force && !failedSources.has(source.id)) {
        const cachedCount = Array.from(next.values()).filter(
          (file) => file.sourceId === source.id,
        ).length;
        onProgress({
          source: source.label,
          scanned: cachedCount,
          audioFound: cachedCount,
          sourceIndex: sourceIndex + 1,
          sourceCount: sources.length,
          phase: "source-complete",
          message: `Using cached inventory for ${source.label} (${cachedCount.toLocaleString()} audio files).`,
        });
        continue;
      }
      const retryAt = this.sourceCooldowns.get(source.id) ?? 0;
      if (retryAt > Date.now() && !force) {
        failedSources.add(source.id);
        onProgress({
          source: source.label,
          scanned: 0,
          audioFound: 0,
          sourceIndex: sourceIndex + 1,
          sourceCount: sources.length,
          phase: "cooldown",
          message: `${source.label} retry cooling down until ${new Date(retryAt).toLocaleTimeString()}; keeping its cached results.`,
        });
        continue;
      }
      let audioFound = 0;
      let scanned = 0;
      let succeeded = false;
      let retryWholeSource = true;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3 && !succeeded; attempt += 1) {
        if (attempt > 0) {
          onProgress({
            source: source.label,
            scanned,
            audioFound,
            sourceIndex: sourceIndex + 1,
            sourceCount: sources.length,
            phase: "retrying",
            message: `Retry ${attempt} of 2 for ${source.label}…`,
          });
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** (attempt - 1)),
          );
        }
        if (this.cancelled) return this.getSnapshot();
        if (
          shouldPauseForSearch() &&
          !(await waitForSearchIdle())
        )
          return this.getSnapshot();
        scanned = 0;
        audioFound = 0;
        let cooldownWindowStartedAt = Date.now();
        let entriesSinceCooldown = 0;
        const coolDownAfterAudioEntry = () => {
          entriesSinceCooldown += 1;
          if (entriesSinceCooldown < AUDIO_SCAN_COOLDOWN_EVERY_ENTRIES)
            return null;
          const workMs = Math.max(0, Date.now() - cooldownWindowStartedAt);
          const cooldownMs = Math.min(
            AUDIO_SCAN_COOLDOWN_MAX_MS,
            Math.max(AUDIO_SCAN_COOLDOWN_MIN_MS, workMs),
          );
          return new Promise<void>((resolve) =>
            setTimeout(() => {
              entriesSinceCooldown = 0;
              cooldownWindowStartedAt = Date.now();
              resolve();
            }, cooldownMs),
          );
        };
        const sourceFiles = new Map<string, CachedAudioFile>();
        const pendingFiles: CachedAudioFile[] = [];
        const emitScanProgress = (message: string) => {
          const files = pendingFiles.splice(0);
          onProgress({
            source: source.label,
            scanned,
            audioFound,
            sourceIndex: sourceIndex + 1,
            sourceCount: sources.length,
            phase: "scanning",
            message,
            ...(files.length > 0 ? { files } : {}),
          });
        };
        try {
          if (isRemotePath(source.rootPath)) {
            if (
              shouldPauseForSearch() &&
              !(await waitForSearchIdle())
            )
              return this.getSnapshot();
            const remoteFiles = await listRemoteFiles(source);
            for (const file of remoteFiles) {
              if (this.cancelled) return this.getSnapshot();
              if (
                shouldPauseForSearch() &&
                !(await waitForSearchIdle())
              )
                return this.getSnapshot();
              const cooldown = coolDownAfterAudioEntry();
              if (cooldown) await cooldown;
              scanned += 1;
              if (
                !file.isDirectory &&
                (file.type === "audio" || isAudio(file.name))
              ) {
                sourceFiles.set(file.path, {
                  ...file,
                  type: "audio",
                  extension: path.extname(file.name).toLowerCase(),
                  sourceId: source.id,
                  sourceLabel: source.label,
                });
                audioFound += 1;
                pendingFiles.push(sourceFiles.get(file.path)!);
                if (audioFound === 1 || pendingFiles.length >= 24)
                  emitScanProgress(
                    `Scanning ${source.label}: ${scanned.toLocaleString()} entries, ${audioFound.toLocaleString()} audio files…`,
                  );
              }
              if (scanned % 500 === 0)
                emitScanProgress(
                  `Scanning ${source.label}: ${scanned.toLocaleString()} entries, ${audioFound.toLocaleString()} audio files…`,
                );
            }
            if (pendingFiles.length > 0)
              emitScanProgress(
                `Scanning ${source.label}: ${scanned.toLocaleString()} entries, ${audioFound.toLocaleString()} audio files…`,
              );
          } else {
            const appDataPath = path.resolve(path.dirname(this.cachePath));
            const canonicalAppDataPath = await fsPromises
              .realpath(appDataPath)
              .catch(() => appDataPath);
            const canonicalSourcePath = await fsPromises
              .realpath(source.rootPath)
              .catch(() => path.resolve(source.rootPath));
            const isSiloAppData = (candidatePath: string) =>
              isAppDataPath(
                candidatePath,
                source.rootPath,
                canonicalSourcePath,
                appDataPath,
                canonicalAppDataPath,
              );
            if (isSiloAppData(source.rootPath)) {
              succeeded = true;
              sourceScannedAt[source.id] = Date.now();
              for (const [filePath, file] of next)
                if (file.sourceId === source.id) next.delete(filePath);
              break;
            }
            if (await isSiloCloneDirectory(source.rootPath)) {
              succeeded = true;
              sourceScannedAt[source.id] = Date.now();
              for (const [filePath, file] of next)
                if (file.sourceId === source.id) next.delete(filePath);
              break;
            }
            const directoryQueue = [
              { directory: source.rootPath, relativePath: "" },
            ];
            let pendingDirectories = 1;
            const waitingWorkers: Array<() => void> = [];
            const visitedDirectories = new Set<string>();
            let unreadableEntries = 0;
            let rootOpened = false;
            let traversalError: unknown;
            let stopTraversal = false;
            const wakeWorkers = () => {
              waitingWorkers.splice(0).forEach((wake) => wake());
            };
            const enqueueDirectory = (item: {
              directory: string;
              relativePath: string;
            }) => {
              pendingDirectories += 1;
              directoryQueue.push(item);
              wakeWorkers();
            };
            const takeDirectory = async () => {
              while (true) {
                if (this.cancelled || stopTraversal) return undefined;
                const item = directoryQueue.shift();
                if (item) return item;
                if (pendingDirectories === 0) return undefined;
                await new Promise<void>((resolve) =>
                  waitingWorkers.push(resolve),
                );
              }
            };
            const scanDirectory = async (current: {
              directory: string;
              relativePath: string;
            }) => {
              if (this.cancelled) return;
              if (
                shouldPauseForSearch() &&
                !(await waitForSearchIdle())
              )
                return;
              if (isSiloAppData(current.directory)) return;
              if (await isSiloCloneDirectory(current.directory)) return;
              let directory;
              try {
                const realDirectory = await fsPromises.realpath(
                  current.directory,
                );
                if (visitedDirectories.has(realDirectory)) return;
                visitedDirectories.add(realDirectory);
                directory = await fsPromises.opendir(current.directory);
                if (current.directory === source.rootPath) rootOpened = true;
              } catch (error) {
                if (current.directory === source.rootPath) throw error;
                unreadableEntries += 1;
                return;
              }
              for await (const entry of directory) {
                if (this.cancelled || stopTraversal) return;
                if (
                  shouldPauseForSearch() &&
                  !(await waitForSearchIdle())
                )
                  return;
                const cooldown = coolDownAfterAudioEntry();
                if (cooldown) await cooldown;
                const fullPath = path.join(current.directory, entry.name);
                if (isSiloAppData(fullPath)) continue;
                if (
                  entry.isDirectory() &&
                  (await isSiloCloneDirectory(fullPath))
                )
                  continue;
                const relativePath = path.join(
                  current.relativePath,
                  entry.name,
                );
                let stats;
                try {
                  stats = await fsPromises.stat(fullPath);
                } catch {
                  unreadableEntries += 1;
                  continue;
                }
                scanned += 1;
                if (stats.isDirectory()) {
                  enqueueDirectory({ directory: fullPath, relativePath });
                } else if (stats.isFile() && isAudio(entry.name)) {
                  const file: CachedAudioFile = {
                    name: entry.name,
                    path: fullPath,
                    relativePath,
                    size: stats.size,
                    modified: stats.mtimeMs,
                    isDirectory: false,
                    type: "audio",
                    extension: path.extname(entry.name).toLowerCase(),
                    sourceId: source.id,
                    sourceLabel: source.label,
                  };
                  sourceFiles.set(fullPath, file);
                  pendingFiles.push(file);
                  audioFound += 1;
                  if (audioFound === 1 || pendingFiles.length >= 24)
                    emitScanProgress(
                      `Scanning ${source.label}: ${scanned.toLocaleString()} entries, ${audioFound.toLocaleString()} audio files…`,
                    );
                }
                if (scanned % 500 === 0)
                  emitScanProgress(
                    `Scanning ${source.label}: ${scanned.toLocaleString()} entries, ${audioFound.toLocaleString()} audio files…`,
                  );
              }
            };
            const worker = async () => {
              while (!this.cancelled && !stopTraversal) {
                const current = await takeDirectory();
                if (!current) return;
                try {
                  await scanDirectory(current);
                } catch (error) {
                  if (current.directory === source.rootPath) {
                    traversalError = error;
                    stopTraversal = true;
                  } else unreadableEntries += 1;
                } finally {
                  pendingDirectories -= 1;
                  wakeWorkers();
                }
              }
            };
            await Promise.all(
              Array.from({ length: AUDIO_SCAN_DIRECTORY_WORKERS }, () =>
                worker(),
              ),
            );
            if (this.cancelled) return this.getSnapshot();
            if (traversalError) throw traversalError;
            if (pendingFiles.length > 0)
              emitScanProgress(
                `Scanning ${source.label}: ${scanned.toLocaleString()} entries, ${audioFound.toLocaleString()} audio files…`,
              );
            if (!rootOpened)
              throw new Error(`Source unavailable: ${source.rootPath}`);
            if (unreadableEntries > 0) {
              // Keep discovered files and older records, but never mark partial
              // coverage as fresh. Retry this source after the cooldown.
              for (const [filePath, file] of sourceFiles)
                next.set(filePath, file);
              // A single unreadable nested entry should not trigger two more
              // complete walks of a potentially million-file source.
              retryWholeSource = false;
              throw new Error(
                `${unreadableEntries} entries could not be read; partial audio results retained.`,
              );
            }
          }
          // Replace this source atomically only after its scan completed successfully.
          for (const [filePath, file] of next)
            if (file.sourceId === source.id) next.delete(filePath);
          for (const [filePath, file] of sourceFiles) next.set(filePath, file);
          succeeded = true;
        } catch (error) {
          lastError = error;
          if (
            !retryWholeSource ||
            (error instanceof Error &&
              error.message.startsWith("DRIVE_PERMISSION_REQUIRED:"))
          )
            break;
        }
      }
      if (succeeded) {
        failedSources.delete(source.id);
        delete sourceErrors[source.id];
        this.sourceCooldowns.delete(source.id);
        sourceScannedAt[source.id] = Date.now();
        onProgress({
          source: source.label,
          scanned,
          audioFound,
          sourceIndex: sourceIndex + 1,
          sourceCount: sources.length,
          phase: "source-complete",
          message: `Scanned ${source.label}: ${audioFound.toLocaleString()} audio files.`,
        });
      } else {
        failedSources.add(source.id);
        sourceErrors[source.id] = {
          message:
            lastError instanceof Error ? lastError.message : String(lastError),
          lastAttemptAt: Date.now(),
        };
        this.sourceCooldowns.set(source.id, Date.now() + 5 * 60 * 1000);
        onProgress({
          source: source.label,
          scanned,
          audioFound,
          sourceIndex: sourceIndex + 1,
          sourceCount: sources.length,
          phase: "cooldown",
          message: `${source.label} failed after retries; keeping its previous cached results. ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        });
      }

      // Checkpoint each completed source; a later source failure no longer discards prior work.
      const checkpointFiles = Array.from(next.values());
      const checkpointExtensions = Array.from(
        new Set(
          checkpointFiles.map((file) => file.extension || "(no extension)"),
        ),
      ).sort((first, second) => first.localeCompare(second));
      this.snapshot = {
        version: 1,
        sourceIds: sources.map((item) => item.id),
        scannedAt:
          failedSources.size === 0 &&
          sourceIds.every((id) => sourceScannedAt[id])
            ? Date.now()
            : 0,
        files: checkpointFiles,
        extensions: checkpointExtensions,
        failedSources: Array.from(failedSources),
        sourceScannedAt,
        sourceErrors,
        sourceCooldownUntil: Object.fromEntries(this.sourceCooldowns),
      };
      await this.persistSnapshot();
    }

    const files = Array.from(next.values()).sort(
      (first, second) =>
        (second.modified || 0) - (first.modified || 0) ||
        first.path.localeCompare(second.path),
    );
    const extensions = Array.from(
      new Set(files.map((file) => file.extension || "(no extension)")),
    ).sort((first, second) => first.localeCompare(second));
    this.snapshot = {
      version: 1,
      sourceIds: sources.map((source) => source.id),
      scannedAt:
        failedSources.size === 0 && sourceIds.every((id) => sourceScannedAt[id])
          ? Date.now()
          : 0,
      files,
      extensions,
      failedSources: Array.from(failedSources),
      sourceScannedAt,
      sourceErrors,
      sourceCooldownUntil: Object.fromEntries(this.sourceCooldowns),
    };
    await this.persistSnapshot();
    return this.getSnapshot();
  }

  private async persistSnapshot() {
    const temporary = `${this.cachePath}.tmp`;
    await fsPromises.writeFile(temporary, JSON.stringify(this.snapshot));
    await fsPromises.rename(temporary, this.cachePath);
  }
}
