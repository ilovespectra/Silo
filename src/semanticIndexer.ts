import * as path from "path";
import { isPersonalPhotoPath } from "./memoryDiscovery";
import * as fsPromises from "fs/promises";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";
import * as readline from "readline";
import { defaultSearchPerformanceSettings } from "./contentSettings";
import type { SearchPerformanceSettings } from "./contentSettings";
import type { IndexerGovernor } from "./indexerGovernor";
import { DEFAULT_SEMANTIC_SEARCH_CONFIDENCE } from "./searchSettings";
import {
  isAppDataPath,
  isNonLibraryPath,
  isPathWithin,
  isPhoneDerivativePath,
  isSiloCloneDirectory,
  isWithinSiloClone,
} from "./indexingPathPolicy";
import { formatDemoFileSample, selectDemoFilePaths } from "./demoLimits";
import {
  PersistedVectorIndex,
  VectorSearchDiagnostics,
  VectorSearchGroup,
  VectorSearchKind,
} from "./persistedVectorIndex";
import { ChildProcess, execFile, fork } from "child_process";
import { promisify } from "util";
import { getIndexStorageExclusionRevision } from "./indexingStorage";

const execFileAsync = promisify(execFile);
const SLOW_EMBEDDING_REQUEST_WARNING_MS = 90_000;
const SEMANTIC_PRELOAD_TIMEOUT_MS = 5 * 60_000;

class UnreadableImageError extends Error {
  constructor() {
    super(
      "This file could not be read as an image; it may be damaged or have the wrong extension.",
    );
  }
}

// Decoder verdicts about the file itself; retrying an unchanged file repeats them.
const PERMANENT_IMAGE_FAILURE =
  /unsupported image format|could not be read as an image|corrupt|premature end|bad seek|invalid (?:marker|image|dimensions)|exceeds(?: the 100 million)? pixels?(?: limit)?|not a (?:valid )?(?:jpeg|png|tiff|gif|webp)|vipsjpeg|vipspng|heif: |unable to decode/i;

export function isPermanentImageFailure(message: string | undefined): boolean {
  return Boolean(message && PERMANENT_IMAGE_FAILURE.test(message));
}

class EmbeddingProcessError extends Error {
  constructor(
    message: string,
    readonly nativeImageCrash = false,
  ) {
    super(message);
  }
}

interface WorkerFailure {
  signature: string;
  attempts: number;
  message: string;
  timestamp: number;
}

type SemanticIndexLoadPhase = "reading" | "validating" | "finalizing";
type SemanticIndexLoadProgress = (
  fraction: number,
  records: number,
  phase: SemanticIndexLoadPhase,
  phaseProgress: number | null,
) => void;

const MODEL_ID = "Xenova/clip-vit-base-patch32";
const VECTOR_SIZE = 512;
const VECTOR_BYTES = VECTOR_SIZE * Float32Array.BYTES_PER_ELEMENT;
const SEARCH_VECTOR_WINDOW_BYTES = 8 * 1024 * 1024;
const SEARCH_MAX_RECORDS_PER_WINDOW = 4096;
const SEARCH_FIRST_WINDOW_RECORDS = 512;
const SEARCH_RESULTS_PER_TYPE = 500;
const SEARCH_RESULT_PRUNE_THRESHOLD = SEARCH_RESULTS_PER_TYPE * 2;
const SEARCH_TEXT_RESULT_LIMIT = 5000;
const SEARCH_EMBEDDING_CACHE_LIMIT = 32;
const RECONCILIATION_DEBOUNCE_MS = 1000; // Debounce reconciliation checks
const RECONCILIATION_PUBLISH_BATCH_SIZE = 512;
const RECONCILIATION_PUBLISH_INTERVAL_MS = 5000;
const RECONCILIATION_REPLAY_BATCH_SIZE = 64;
const INCREMENTAL_BATCH_SIZE = 250;
const PENDING_WORK_CHECKPOINT_INTERVAL_MS = 2 * 60 * 1000;

export function confidenceSettingToMinimumThreshold(confidence: number): number {
  const setting = Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, confidence))
    : DEFAULT_SEMANTIC_SEARCH_CONFIDENCE;
  return setting;
}

const plainTextExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".php",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
  ".ico",
  ".svg",
]);

export interface IndexableFile {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: number;
  isDirectory: boolean;
  type: string;
  extension: string;
}

export interface SourceScanCheckpoint {
  /** Remaining filesystem directories, including the directory being resumed. */
  resumeDirectories?: string[];
  /** Subdirectories already covered by another selected source root. */
  excludeDirectories?: string[];
  /** Persist a committed batch before advancing the durable directory cursor. */
  onCheckpoint?: (
    pendingDirectories: string[],
    discoveredFiles: IndexableFile[],
  ) => Promise<void>;
}

export interface SearchResult extends IndexableFile {
  confidence: number;
}

export interface IndexProgress {
  status:
    | "idle"
    | "scanning"
    | "loading-model"
    | "indexing"
    | "paused"
    | "complete"
    | "error";
  total: number;
  indexed: number;
  remaining: number;
  /** Files still waiting in the persisted-work queue, including beyond this batch. */
  queuedRemaining: number;
  errors: number;
  currentFile: string | null;
  message: string;
}

interface IndexRecord {
  path: string;
  name: string;
  sourcePath: string;
  relativePath: string;
  size: number;
  modified: number;
  type: string;
  extension: string;
  signature: string;
  vectorOffset: number;
  error?: string;
}

interface ActiveTextSearch {
  queryTerms: string[];
  sourcePaths: Set<string>;
  demoPaths: Set<string> | null;
  total: number;
  onMatches?: (
    matches: IndexableFile[],
    scanned: number,
    total: number,
    capped: boolean,
  ) => void;
  seenRecordIds: Set<number>;
  matches: IndexableFile[];
  batch: IndexableFile[];
  scanned: number;
  capped: boolean;
  lastPublishedAt: number;
}

function searchTermSet(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function searchTerms(value: string): string[] {
  return Array.from(searchTermSet(value));
}

interface ClipRuntime {
  worker?: true;
  child?: ChildProcess;
  tokenizer?: any;
  processor?: any;
  textModel?: any;
  visionModel?: any;
  RawImage?: any;
}

type ScanSource = (
  sourcePath: string,
  onFile: (file: IndexableFile) => void,
  isCancelled: () => boolean,
  shouldPauseForSearch?: () => boolean,
  checkpoint?: SourceScanCheckpoint,
) => Promise<void>;
type ProgressListener = (progress: IndexProgress) => void;
type SearchProgressListener = (
  results: SearchResult[],
  scanned: number,
  total: number,
  mode?: "ann" | "exact",
) => void;
type SourceCoverageStatus =
  | "pending"
  | "scanning"
  | "completed"
  | "error"
  | "unavailable";
interface SourceCoverage {
  status: SourceCoverageStatus;
  completedAt: number;
  error: string;
}

interface ReconciliationWalkCheckpoint {
  version: 1;
  sourcePath: string;
  canonicalSourcePath: string;
  sourceDevice: number;
  pendingDirectories: string[];
  journalOffset: number;
}

export interface SourcePathAlias {
  /** Selected path retained as the stable path and source root. */
  primaryRoot: string;
  /** Equivalent spelling beneath macOS's mounted Data volume. */
  aliasRoot: string;
  /** Broad source root whose recursive walk contains aliasRoot. */
  containerRoot: string;
}

/**
 * Find only macOS Data-volume aliases that are independently selected and
 * verified as the same directory object. This avoids treating hard links or
 * similarly named paths as interchangeable.
 */
export async function findMacDataVolumeSourceAliases(
  sourcePaths: readonly string[],
  platform = process.platform,
  statPath: (value: string) => Promise<{
    dev: number;
    ino: number;
    isDirectory: () => boolean;
  }> = (value) => fsPromises.stat(value),
): Promise<SourcePathAlias[]> {
  const containerRoot = path.resolve("/System/Volumes/Data");
  const roots = new Set(
    sourcePaths
      .filter(
        (sourcePath) =>
          typeof sourcePath === "string" &&
          path.isAbsolute(sourcePath) &&
          !sourcePath.startsWith("/__phone__/") &&
          !sourcePath.startsWith("/__cloud__/"),
      )
      .map((sourcePath) => path.resolve(sourcePath)),
  );
  if (platform !== "darwin" || !roots.has(containerRoot)) return [];

  const aliases: SourcePathAlias[] = [];
  for (const primaryRoot of roots) {
    if (
      primaryRoot === path.parse(primaryRoot).root ||
      primaryRoot === containerRoot ||
      isPathWithin(primaryRoot, containerRoot)
    )
      continue;
    const relativeRoot = path.relative(path.parse(primaryRoot).root, primaryRoot);
    const aliasRoot = path.resolve(containerRoot, relativeRoot);
    if (aliasRoot === primaryRoot) continue;
    try {
      const [primaryStats, aliasStats] = await Promise.all([
        statPath(primaryRoot),
        statPath(aliasRoot),
      ]);
      if (
        primaryStats.isDirectory() &&
        aliasStats.isDirectory() &&
        primaryStats.dev === aliasStats.dev &&
        primaryStats.ino === aliasStats.ino
      )
        aliases.push({ primaryRoot, aliasRoot, containerRoot });
    } catch {
      // Missing or inaccessible counterparts are not aliases.
    }
  }
  return aliases;
}

export function mapSourcePathAlias(
  filePath: string,
  sourcePath: string,
  aliases: readonly SourcePathAlias[],
): { filePath: string; sourcePath: string } | null {
  for (const alias of aliases) {
    if (
      !isPathWithin(filePath, alias.aliasRoot) ||
      !(
        sourcePath === alias.containerRoot ||
        sourcePath === alias.aliasRoot ||
        isPathWithin(alias.aliasRoot, sourcePath)
      )
    )
      continue;
    const relativePath = path.relative(alias.aliasRoot, filePath);
    return {
      filePath: path.resolve(alias.primaryRoot, relativePath),
      sourcePath: alias.primaryRoot,
    };
  }
  return null;
}

export function coalesceAliasedPendingWork(
  entries: Iterable<[string, string]>,
  aliases: readonly SourcePathAlias[],
): Map<string, string> {
  const coalesced = new Map<string, string>();
  for (const [filePath, sourcePath] of entries) {
    const mapped = mapSourcePathAlias(filePath, sourcePath, aliases);
    const nextPath = mapped?.filePath ?? filePath;
    const nextSource = mapped?.sourcePath ?? sourcePath;
    if (!coalesced.has(nextPath)) coalesced.set(nextPath, nextSource);
  }
  return coalesced;
}

export function getExcludedSourceAliasDirectories(
  sourcePath: string,
  aliases: readonly SourcePathAlias[],
): string[] {
  return aliases
    .filter(
      (alias) =>
        sourcePath !== alias.primaryRoot &&
        isPathWithin(alias.aliasRoot, sourcePath),
    )
    .map((alias) => alias.aliasRoot);
}
type DiagnosticListener = (
  event: string,
  details?: Record<string, unknown>,
) => void;

function sanitizeWorkerDiagnosticText(value: unknown, limit: number) {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "[path]")
    .trim()
    .slice(0, limit);
  return sanitized || undefined;
}

function sanitizeWorkerDiagnosticStack(value: unknown, limit: number) {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>)]*/g, (absolutePath) => {
      const location = absolutePath.match(/:\d+(?::\d+)?$/)?.[0] ?? "";
      const pathWithoutLocation = location
        ? absolutePath.slice(0, -location.length)
        : absolutePath;
      const fileName = pathWithoutLocation.split(/[\\/]/).filter(Boolean).pop();
      return `${fileName ? `[path]/${fileName}` : "[path]"}${location}`;
    })
    .trim()
    .slice(0, limit);
  return sanitized || undefined;
}

const initialProgress: IndexProgress = {
  status: "idle",
  total: 0,
  indexed: 0,
  remaining: 0,
  queuedRemaining: 0,
  errors: 0,
  currentFile: null,
  message: "No index has been started.",
};

export class SemanticIndexer {
  private readonly userDataPath: string;
  private canonicalUserDataPath: string;
  private readonly canonicalSourcePaths = new Map<string, string>();
  private activeSourcePathAliases: SourcePathAlias[] = [];
  private sourcePathAliasSignature = "";
  private readonly indexStorageRoot: string;
  private readonly indexDirectory: string;
  private readonly recordsPath: string;
  private readonly vectorsPath: string;
  private readonly progressPath: string;
  private readonly modelCachePath: string;
  private readonly resolveFilePath: (filePath: string) => Promise<string>;
  private readonly scanSource: ScanSource;
  private readonly onProgress: ProgressListener;
  private readonly onDiagnostic: DiagnosticListener;
  private latestRecords = new Map<string, IndexRecord>();
  private readonly latestRecordsByVectorKey = new Map<number, IndexRecord>();
  private persistedVectorIndex: PersistedVectorIndex | null = null;
  private vectorIndexBuildPromise: Promise<void> | null = null;
  private performanceSettings: SearchPerformanceSettings =
    defaultSearchPerformanceSettings();
  private indexerGovernor: IndexerGovernor | null = null;
  private vectorIndexReadyState = false;
  /** Set when the native ANN index cannot be built; searches then scan vectors exactly. */
  private vectorIndexFailed = false;
  private readonly textRecordIds = new Map<string, number>();
  private readonly textRecordPaths: string[] = [];
  private readonly textRecordPostingSources: Array<Set<string>> = [];
  private readonly textRecordTerms: Array<Set<string>> = [];
  private readonly searchIndexabilityCache = new WeakMap<
    IndexRecord,
    {
      path: string;
      sourcePath: string;
      type: string;
      extension: string;
      canonicalSourcePath: string;
      canonicalUserDataPath: string;
      exclusionRevision: number;
      value: boolean;
    }
  >();
  private readonly textPostingTerms: Array<Set<string>> = [];
  private readonly textPostingsBySource = new Map<
    string,
    Map<string, number[]>
  >();
  private readonly latestVectorKeysBySource = new Map<string, Set<number>>();
  private readonly activeTextSearches = new Set<ActiveTextSearch>();
  private readonly indexedRecordListeners = new Set<
    (record: IndexRecord) => void
  >();
  private backgroundIndexWorkListener:
    | ((changedFiles: Map<string, string>) => void)
    | null = null;
  private readonly searchEmbeddingCache = new Map<
    string,
    { document: Float32Array; image: Float32Array }
  >();
  private indexedSearchSnapshotCache: {
    revision: number;
    sourceKey: string;
    records: IndexRecord[];
  } | null = null;
  private readonly processingPaths = new Set<string>();
  private demoFileLimit: number | null = null;
  private readonly demoFilePathCache = new Map<
    string,
    { revision: number; limit: number; paths: Set<string> }
  >();
  private readonly recordCountsBySource = new Map<
    string,
    { total: number; indexed: number; indexedImages: number; errors: number }
  >();
  private readonly discoveredTotalsBySource = new Map<string, number>();
  private readonly workerFailures = new Map<string, WorkerFailure>();
  private retryableErrorCountCache: {
    sourceKey: string;
    calculatedAt: number;
    count: number;
  } | null = null;
  private pendingCheckpoint = false;
  private pendingWorkCheckpointAt = 0;
  private pendingWorkCheckpointPromise: Promise<void> | null = null;
  private pendingWorkMutationVersion = 0;
  private pendingWorkSnapshotVersion = 0;
  private checkpointOnPause = true;
  private recoveryFileWriteChain: Promise<void> = Promise.resolve();
  private recoveryFileWriteSequence = 0;
  private restoredSourcePaths: string[] = [];
  private progress: IndexProgress = { ...initialProgress };
  private clipRuntime: ClipRuntime | null = null;
  private clipRuntimePromise: Promise<ClipRuntime> | null = null;
  private embeddingWorker: ChildProcess | null = null;
  private readonly embeddingExitDetails = new WeakMap<
    ChildProcess,
    {
      pendingCount: number;
      requestTypes: string[];
      failureReason?: string;
    }
  >();
  private embeddingRequestId = 0;
  private readonly embeddingRequests = new Map<
    number,
    {
      type: "preload" | "text" | "image";
      timer: NodeJS.Timeout | null;
      timeoutTimer: NodeJS.Timeout | null;
      resolve: (values: number[]) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly inferenceQueue: Array<{
    priority: number;
    sequence: number;
    task: () => void;
  }> = [];
  private inferenceSequence = 0;
  private inferenceActive = false;
  private activeSearchCount = 0;
  private searchChain: Promise<void> = Promise.resolve();
  private runPromise: Promise<void> | null = null;
  private queuedSourcePaths: string[] | null = null;
  private pauseRequested = false;
  private auditTotal = 0;
  private auditIndexed = 0;
  private auditErrors = 0;
  private readonly sourceCoverage = new Map<string, SourceCoverage>();
  private readonly sourcesWithExcludedRecords = new Set<string>();
  private coverageWriteQueue: Promise<void> = Promise.resolve();
  private summaryWriteQueue: Promise<void> = Promise.resolve();
  private reconciliation = {
    running: false,
    source: "",
    sourcePath: "",
    sourceIndex: 0,
    sourceCount: 0,
    scanned: 0,
    changed: 0,
    startedAt: 0,
    message: "",
    error: "",
  };
  private reconciliationPromise: Promise<Map<string, string>> | null = null;
  private reconciliationCancelRequested = false;
  private searchDiscovery = {
    running: false,
    source: "",
    sourcePath: "",
    sourceIndex: 0,
    sourceCount: 0,
    scanned: 0,
    changed: 0,
    startedAt: 0,
    message: "",
    error: "",
  };
  getReconciliationProgress() {
    const active = this.searchDiscovery.running
      ? this.searchDiscovery
      : this.reconciliation.running
        ? this.reconciliation
        : this.searchDiscovery.startedAt > this.reconciliation.startedAt
          ? this.searchDiscovery
          : this.reconciliation;
    return { ...active };
  }

  getSourceCoverageProgress(sourcePaths: string[]) {
    const counts = {
      total: 0,
      completed: 0,
      scanning: 0,
      errors: 0,
      unavailable: 0,
      pending: 0,
    };
    const sources = Array.from(
      new Set(sourcePaths.filter((root) => root.trim())),
    ).map((sourcePath) => {
      if (!this.sourceCoverage.has(sourcePath)) {
        this.sourceCoverage.set(sourcePath, {
          status: "pending",
          completedAt: 0,
          error: "",
        });
      }
      const coverage = this.sourceCoverage.get(sourcePath)!;
      counts.total += 1;
      if (coverage.status === "error") counts.errors += 1;
      else counts[coverage.status] += 1;
      return { sourcePath, ...coverage };
    });
    return { ...counts, sources };
  }

  private async setSourceCoverage(
    sourcePath: string,
    status: SourceCoverageStatus,
    error = "",
  ) {
    const previous = this.sourceCoverage.get(sourcePath);
    this.sourceCoverage.set(sourcePath, {
      status,
      error,
      completedAt:
        status === "completed" ? Date.now() : (previous?.completedAt ?? 0),
    });
    // Coverage remains valid in memory for this session even when a removable
    // cache destination disappears. persistSourceCoverage records the failure;
    // don't let a sidecar write reject an otherwise handled source scan.
    await this.persistSourceCoverage().catch(() => undefined);
  }

  private async persistSourceCoverage() {
    const snapshot = JSON.stringify({
      version: 1,
      sources: Array.from(this.sourceCoverage.entries()),
    });
    const coveragePath = path.join(this.indexDirectory, "coverage.json");
    // Serialize atomic replacements so an older batch cannot overwrite newer coverage.
    const write = this.coverageWriteQueue.then(async () => {
      await fsPromises.mkdir(this.indexDirectory, { recursive: true });
      await fsPromises.writeFile(`${coveragePath}.tmp`, snapshot, "utf8");
      await fsPromises.rename(`${coveragePath}.tmp`, coveragePath);
    });
    this.coverageWriteQueue = write.catch((error) => {
      this.onDiagnostic("source-coverage-persist-error", {
        message: String(error),
      });
    });
    await write;
  }

  private sourceWalkCheckpointNames(sourcePath: string) {
    const key = createHash("sha256")
      .update(path.resolve(sourcePath))
      .digest("hex");
    return {
      stateName: `source-walk-${key}.json`,
      journalPath: path.join(this.indexDirectory, `source-walk-${key}.jsonl`),
    };
  }

  private async loadSourceWalkCheckpoint(
    sourcePath: string,
    canonicalSourcePath: string,
    sourceDevice: number,
  ) {
    const { stateName, journalPath } = this.sourceWalkCheckpointNames(sourcePath);
    let saved: ReconciliationWalkCheckpoint | null = null;
    try {
      const parsed = JSON.parse(
        await fsPromises.readFile(path.join(this.indexDirectory, stateName), "utf8"),
      );
      const journalStats = await fsPromises.stat(journalPath).catch(() => null);
      if (
        parsed.version === 1 &&
        parsed.sourcePath === sourcePath &&
        parsed.canonicalSourcePath === canonicalSourcePath &&
        parsed.sourceDevice === sourceDevice &&
        Array.isArray(parsed.pendingDirectories) &&
        parsed.pendingDirectories.every(
          (directory: unknown) =>
            typeof directory === "string" && path.isAbsolute(directory),
        ) &&
        Number.isSafeInteger(parsed.journalOffset) &&
        parsed.journalOffset >= 0 &&
        (parsed.journalOffset === 0 ||
          (journalStats && journalStats.size >= parsed.journalOffset))
      ) {
        saved = parsed as ReconciliationWalkCheckpoint;
      }
    } catch {
      /* Missing or invalid walk state starts a safe full source walk. */
    }

    if (!saved) {
      await Promise.all([
        fsPromises.unlink(path.join(this.indexDirectory, stateName)).catch(() => undefined),
        fsPromises.unlink(journalPath).catch(() => undefined),
      ]);
      saved = {
        version: 1,
        sourcePath,
        canonicalSourcePath,
        sourceDevice,
        pendingDirectories: [sourcePath],
        journalOffset: 0,
      };
      await this.writeRecoveryFile(stateName, saved);
    }
    return { stateName, journalPath, state: saved };
  }

  private async paceReconciliationWork(
    workMs: number,
    shouldYieldForIndexing: () => boolean,
  ) {
    const shouldYield = () =>
      this.activeSearchCount > 0 || shouldYieldForIndexing();
    const dutyPercent = Math.max(
      5,
      Math.min(100, this.performanceSettings.backgroundWorkPercent),
    );
    if (this.indexerGovernor) {
      await this.indexerGovernor.paceAfterWork(
        Math.max(1, workMs),
        shouldYield,
        () => this.reconciliationCancelRequested,
        dutyPercent,
      );
      return;
    }
    let cooldownRemaining = Math.ceil(
      Math.max(1, workMs) * ((100 - dutyPercent) / dutyPercent),
    );
    while (cooldownRemaining > 0 && !this.reconciliationCancelRequested) {
      if (shouldYield()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
        continue;
      }
      const sliceMs = Math.min(50, cooldownRemaining);
      await new Promise<void>((resolve) => setTimeout(resolve, sliceMs));
      cooldownRemaining -= sliceMs;
    }
  }

  private async replaySourceWalkJournal(
    state: ReconciliationWalkCheckpoint,
    journalPath: string,
    sourcePath: string,
    onFile: (file: IndexableFile) => void,
    shouldYieldForIndexing: () => boolean = () => false,
    excludedDirectories: readonly string[] = [],
  ) {
    if (state.journalOffset === 0) return;
    const releaseDiscoveryLane =
      this.indexerGovernor?.enterLane("source-discovery") ?? (() => undefined);
    const input = fs.createReadStream(journalPath, {
      start: 0,
      end: state.journalOffset - 1,
    });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let replayedSincePacing = 0;
    let replayCpuBaseline = process.cpuUsage();
    try {
      for await (const line of lines) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (
          !Array.isArray(row) ||
          row.length !== 4 ||
          typeof row[0] !== "string" ||
          !path.isAbsolute(row[0]) ||
          !Number.isFinite(row[1]) ||
          row[1] < 0 ||
          !Number.isFinite(row[2]) ||
          typeof row[3] !== "string"
        )
          throw new Error("Saved source discovery checkpoint is invalid.");
        if (
          excludedDirectories.some((directory) =>
            isPathWithin(row[0], directory),
          )
        )
          continue;
        const relativePath = path.relative(sourcePath, row[0]);
        if (
          relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath)
        )
          throw new Error("Saved source discovery path is outside its source.");
        while (shouldYieldForIndexing() && !this.reconciliationCancelRequested)
          await new Promise<void>((resolve) => setTimeout(resolve, 75));
        if (this.reconciliationCancelRequested)
          throw new Error("Source discovery was cancelled during shutdown.");
        if (replayedSincePacing >= RECONCILIATION_REPLAY_BATCH_SIZE) {
          const cpuSinceLastBatch = process.cpuUsage(replayCpuBaseline);
          await this.paceReconciliationWork(
            (cpuSinceLastBatch.user + cpuSinceLastBatch.system) / 1000,
            shouldYieldForIndexing,
          );
          replayCpuBaseline = process.cpuUsage();
          replayedSincePacing = 0;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        replayedSincePacing += 1;
        let stats;
        try {
          stats = await fsPromises.lstat(row[0]);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          throw error;
        }
        // Journal rows describe paths discovered in an earlier process. Refresh
        // their metadata now so edits and removals made while Silo was closed
        // are reflected before the source can be marked complete.
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        onFile({
          path: row[0],
          name: path.basename(row[0]),
          relativePath,
          size: stats.size,
          modified: stats.mtimeMs,
          isDirectory: false,
          type: row[3],
          extension: path.extname(row[0]).toLowerCase(),
        });
      }
    } finally {
      lines.close();
      input.destroy();
      releaseDiscoveryLane();
    }
  }

  private async persistSourceWalkCheckpoint(
    state: ReconciliationWalkCheckpoint,
    stateName: string,
    journalPath: string,
    pendingDirectories: string[],
    discoveredFiles: IndexableFile[],
    sourcePath: string,
  ): Promise<ReconciliationWalkCheckpoint> {
    const rows: string[] = [];
    for (const file of discoveredFiles) {
      if (!file.isDirectory && this.isIndexable(file, sourcePath))
        rows.push(JSON.stringify([file.path, file.size, file.modified, file.type]));
    }
    const contents = rows.length ? Buffer.from(`${rows.join("\n")}\n`, "utf8") : null;
    await fsPromises.mkdir(this.indexDirectory, { recursive: true });
    let handle: Awaited<ReturnType<typeof fsPromises.open>>;
    try {
      handle = await fsPromises.open(journalPath, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      handle = await fsPromises.open(journalPath, "w+");
    }
    let nextOffset = state.journalOffset;
    try {
      // Any bytes beyond the last committed offset came from a checkpoint
      // interrupted before its atomic state-file replacement.
      await handle.truncate(state.journalOffset);
      if (contents) {
        await handle.write(contents, 0, contents.length, state.journalOffset);
        nextOffset += contents.length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const nextState: ReconciliationWalkCheckpoint = {
      ...state,
      pendingDirectories: Array.from(new Set(pendingDirectories)),
      journalOffset: nextOffset,
    };
    await this.writeRecoveryFile(stateName, nextState);
    return nextState;
  }

  private async clearSourceWalkCheckpoint(
    state: ReconciliationWalkCheckpoint,
    stateName: string,
    journalPath: string,
  ) {
    try {
      await fsPromises.unlink(path.join(this.indexDirectory, stateName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // If cleanup is blocked, make the next launch start at the root rather
        // than treating an old completed journal as current discovery.
        await this.writeRecoveryFile(stateName, {
          ...state,
          pendingDirectories: [state.sourcePath],
          journalOffset: 0,
        });
        return;
      }
    }
    await fsPromises.unlink(journalPath).catch(() => undefined);
  }

  private async coalesceAliasedRecords(
    aliases: readonly SourcePathAlias[],
  ): Promise<number> {
    const aliasRecords = Array.from(this.latestRecords.values()).filter(
      (record) =>
        mapSourcePathAlias(record.path, record.sourcePath, aliases) !== null,
    );
    if (!aliasRecords.length) return 0;

    const operations = aliasRecords.map((aliasRecord) => {
      const mapped = mapSourcePathAlias(
        aliasRecord.path,
        aliasRecord.sourcePath,
        aliases,
      )!;
      const existingCanonical = this.latestRecords.get(mapped.filePath);
      const winner =
        existingCanonical &&
        (existingCanonical.vectorOffset >= 0 || aliasRecord.vectorOffset < 0)
          ? existingCanonical
          : aliasRecord;
      const canonicalRecord: IndexRecord = {
        ...winner,
        path: mapped.filePath,
        name: path.basename(mapped.filePath),
        sourcePath: mapped.sourcePath,
        relativePath: path
          .relative(mapped.sourcePath, mapped.filePath)
          .split(path.sep)
          .join("/"),
      };
      const canonicalNeedsWrite =
        winner === aliasRecord ||
        !existingCanonical ||
        existingCanonical.sourcePath !== canonicalRecord.sourcePath ||
        existingCanonical.relativePath !== canonicalRecord.relativePath;
      return {
        aliasPath: aliasRecord.path,
        canonicalPath: mapped.filePath,
        canonicalRecord,
        canonicalNeedsWrite,
      };
    });

    // Append the canonical owner before its alias tombstone. A crash between
    // these lines can leave duplicates for the next pass, but cannot lose the
    // only usable embedding.
    for (let offset = 0; offset < operations.length; offset += 500) {
      const batch = operations.slice(offset, offset + 500);
      const lines: string[] = [];
      for (const operation of batch) {
        if (operation.canonicalNeedsWrite)
          lines.push(JSON.stringify(operation.canonicalRecord));
        lines.push(JSON.stringify({ path: operation.aliasPath, deleted: true }));
      }
      await this.appendLines(lines);

      for (const operation of batch) {
        this.deleteLatestRecord(operation.aliasPath);
        this.deleteLatestRecord(operation.canonicalPath);
        this.setLatestRecord(operation.canonicalRecord);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.retryableErrorCountCache = null;
    this.demoFilePathCache.clear();
    return operations.length;
  }

  private async configureSourcePathAliases(sourcePaths: string[]) {
    const aliases = await findMacDataVolumeSourceAliases(sourcePaths);
    const signature = aliases
      .map((alias) => `${alias.primaryRoot}\0${alias.aliasRoot}`)
      .sort()
      .join("\n");
    if (signature === this.sourcePathAliasSignature) return;

    const queuedBefore = this.filesToIndex?.size ?? 0;
    const coalescedQueue = coalesceAliasedPendingWork(
      this.filesToIndex ?? [],
      aliases,
    );
    let queueChanged = coalescedQueue.size !== queuedBefore;
    if (!queueChanged) {
      const coalescedEntries = coalescedQueue.entries();
      for (const [filePath, sourcePath] of this.filesToIndex ?? []) {
        const nextEntry = coalescedEntries.next().value as
          | [string, string]
          | undefined;
        if (
          !nextEntry ||
          nextEntry[0] !== filePath ||
          nextEntry[1] !== sourcePath
        ) {
          queueChanged = true;
          break;
        }
      }
    }

    const recordsCoalesced = await this.coalesceAliasedRecords(aliases);
    if (queueChanged) {
      this.filesToIndex = coalescedQueue.size ? coalescedQueue : null;
      this.pendingWorkMutationVersion += 1;
      await this.checkpointPendingWork(sourcePaths, true);
    }
    this.activeSourcePathAliases = aliases;
    this.sourcePathAliasSignature = signature;
    if (queueChanged || recordsCoalesced)
      this.onDiagnostic("semantic-source-aliases-coalesced", {
        aliases: aliases.length,
        queuedBefore,
        queuedAfter: coalescedQueue.size,
        recordsCoalesced,
      });
  }

  private excludedDirectoriesForSource(sourcePath: string): string[] {
    return getExcludedSourceAliasDirectories(
      sourcePath,
      this.activeSourcePathAliases,
    );
  }

  private isExcludedSourceAliasPath(filePath: string, sourcePath: string): boolean {
    return this.excludedDirectoriesForSource(sourcePath).some((excludedRoot) =>
      isPathWithin(filePath, excludedRoot),
    );
  }

  // File watching and reconciliation
  private fileWatchers = new Map<string, fs.FSWatcher>(); // sourcePath -> watcher
  private watchedSources = new Set<string>();
  private revision = 0;
  private loaded: Promise<void> = Promise.resolve();
  private loadComplete = true;
  private writeChain: Promise<void> = Promise.resolve();
  private recordsBoundaryChecked = false;
  private dirtyWatchSources = new Set<string>();
  private watchHolds = new Map<string, number>();
  private reconciliationTimeout: NodeJS.Timeout | null = null;
  private isWatching = false;
  private filesToIndex: Map<string, string> | null = null; // filePath -> sourcePath for incremental indexing

  constructor(
    userDataPath: string,
    modelCachePath: string,
    scanSource: ScanSource,
    onProgress: ProgressListener,
    onDiagnostic: DiagnosticListener = () => undefined,
    indexStoragePath: string = userDataPath,
    resolveFilePath: (filePath: string) => Promise<string> = async (filePath) => filePath,
  ) {
    this.userDataPath = path.resolve(userDataPath);
    this.canonicalUserDataPath = this.userDataPath;
    this.indexStorageRoot = path.resolve(indexStoragePath);
    this.indexDirectory = path.join(this.indexStorageRoot, "semantic-index");
    this.recordsPath = path.join(this.indexDirectory, "records.jsonl");
    this.vectorsPath = path.join(this.indexDirectory, "vectors.bin");
    this.progressPath = path.join(this.indexDirectory, "progress.json");
    this.modelCachePath = modelCachePath;
    this.resolveFilePath = resolveFilePath;
    this.scanSource = scanSource;
    this.onProgress = onProgress;
    this.onDiagnostic = onDiagnostic;
    this.resetVectorIndexReady();
  }

  setBackgroundIndexWorkListener(
    listener: ((changedFiles: Map<string, string>) => void) | null,
  ) {
    this.backgroundIndexWorkListener = listener;
  }

  addIndexedImageListener(
    listener: (image: {
      path: string;
      sourcePath: string;
      name: string;
      relativePath: string;
      size: number;
      modified: number;
      type: string;
      extension: string;
      isDirectory: false;
    }) => void,
  ) {
    const wrapped = (record: IndexRecord) => {
      if (record.type !== "image" || record.vectorOffset < 0) return;
      listener({
        path: record.path,
        sourcePath: record.sourcePath,
        name: record.name,
        relativePath: record.relativePath,
        size: record.size,
        modified: record.modified,
        type: record.type,
        extension: record.extension,
        isDirectory: false,
      });
    };
    this.indexedRecordListeners.add(wrapped);
    return () => this.indexedRecordListeners.delete(wrapped);
  }

  setPerformanceSettings(settings: SearchPerformanceSettings) {
    this.performanceSettings = { ...settings };
    this.indexerGovernor?.setPaceLimitPercent(
      this.performanceSettings.backgroundWorkPercent,
    );
    this.persistedVectorIndex?.updateSettings(this.performanceSettings);
  }

  setIndexerGovernor(governor: IndexerGovernor | null) {
    this.indexerGovernor = governor;
    if (governor)
      governor.setPaceLimitPercent(
        this.performanceSettings.backgroundWorkPercent,
      );
  }

  async initialize(onLoadProgress?: SemanticIndexLoadProgress) {
    this.loadComplete = false;
    const task = this.openIndex(onLoadProgress);
    this.loaded = task.then(() => undefined, () => undefined).then(() => {
      this.loadComplete = true;
    });
    // Searches and concept scans queue behind the load instead of seeing a partial index.
    this.searchChain = this.loaded;
    return task;
  }

  /** False while the saved index is still being read; partial counts are shown meanwhile. */
  isLoaded(): boolean {
    return this.loadComplete;
  }

  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  async prepareVectorSearch(
    onProgress: (fraction: number, records: number) => void,
  ): Promise<void> {
    await this.loaded;
    if (this.vectorIndexBuildPromise) return this.vectorIndexBuildPromise;
    const build = this.buildVectorSearch(onProgress);
    this.vectorIndexBuildPromise = build;
    try {
      await build;
    } catch (error) {
      if (this.vectorIndexBuildPromise === build)
        this.vectorIndexBuildPromise = null;
      throw error;
    }
  }

  private resetVectorIndexReady() {
    this.vectorIndexReadyState = false;
  }

  private async buildVectorSearch(
    onProgress: (fraction: number, records: number) => void,
  ): Promise<void> {
    type GroupBuffer = {
      sourcePath: string;
      kind: VectorSearchKind;
      count: number;
      next: number;
      keys: BigUint64Array;
    };
    const grouped = new Map<string, Map<VectorSearchKind, GroupBuffer>>();
    const getGroup = (sourcePath: string, kind: VectorSearchKind) => {
      let byKind = grouped.get(sourcePath);
      if (!byKind) {
        byKind = new Map();
        grouped.set(sourcePath, byKind);
      }
      let group = byKind.get(kind);
      if (!group) {
        group = {
          sourcePath,
          kind,
          count: 0,
          next: 0,
          keys: new BigUint64Array(0),
        };
        byKind.set(kind, group);
      }
      return group;
    };
    const yieldToInteractiveSearch = async () => {
      // This pass only groups saved vector keys so the worker can reuse its
      // persisted ANN partitions. Artificially applying the 5% indexing budget
      // here delayed every startup before the fast index was even available.
      // Yield to the event loop and let an active search finish, but keep the
      // metadata pass moving at full speed when the app is otherwise idle.
      await new Promise<void>((resolve) => setImmediate(resolve));
      while (this.activeSearchCount > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
    };

    const groupBuildStartedAt = Date.now();
    this.onDiagnostic("semantic-ann-groups-start", {
      records: this.latestRecordsByVectorKey.size,
    });
    let lastGroupProgressAt = groupBuildStartedAt;
    const reportGroupProgress = (phase: "counting" | "filling", records: number) => {
      const now = Date.now();
      if (now - lastGroupProgressAt < 15000) return;
      lastGroupProgressAt = now;
      this.onDiagnostic("semantic-ann-groups-progress", {
        phase,
        records,
        total: this.latestRecordsByVectorKey.size,
        elapsedMs: now - groupBuildStartedAt,
      });
    };

    // Count first, then allocate only the transferable typed arrays. Keeping a
    // second full set of JS-number arrays here made large libraries spike RSS.
    let processed = 0;
    for (const [key, record] of this.latestRecordsByVectorKey) {
      const kind: VectorSearchKind = record.type === "image" ? "image" : "document";
      getGroup(record.sourcePath, kind).count += 1;
      processed += 1;
      if (processed % 8192 === 0) {
        await yieldToInteractiveSearch();
        reportGroupProgress("counting", processed);
      }
    }
    for (const byKind of grouped.values())
      for (const group of byKind.values())
        group.keys = new BigUint64Array(group.count);

    processed = 0;
    for (const [key, record] of this.latestRecordsByVectorKey) {
      const kind: VectorSearchKind = record.type === "image" ? "image" : "document";
      const group = getGroup(record.sourcePath, kind);
      group.keys[group.next++] = BigInt(key);
      processed += 1;
      if (processed % 8192 === 0) {
        await yieldToInteractiveSearch();
        reportGroupProgress("filling", processed);
      }
    }
    const groups: VectorSearchGroup[] = [];
    for (const byKind of grouped.values())
      for (const group of byKind.values())
        groups.push({
          sourcePath: group.sourcePath,
          kind: group.kind,
          keys: group.keys,
        });
    grouped.clear();
    this.onDiagnostic("semantic-ann-groups-ready", {
      records: this.latestRecordsByVectorKey.size,
      elapsedMs: Date.now() - groupBuildStartedAt,
    });
    this.persistedVectorIndex = new PersistedVectorIndex(
      this.vectorsPath,
      path.join(this.indexDirectory, "ann"),
      onProgress,
      (error) => this.onDiagnostic("semantic-ann-index-error", { message: error.message }),
      this.performanceSettings,
    );
    const failedIndex = this.persistedVectorIndex;
    try {
      await failedIndex.initialize(groups);
      this.vectorIndexFailed = false;
      this.vectorIndexReadyState = true;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.persistedVectorIndex = null;
      this.vectorIndexFailed = true;
      this.vectorIndexReadyState = false;
      await failedIndex.shutdown(1000).catch(() => undefined);
      throw normalized;
    }
  }

  /** True when semantic search runs as an exact vector scan because the ANN index failed. */
  usesExactVectorSearch(): boolean {
    return this.vectorIndexFailed;
  }

  async flushVectorSearch(): Promise<void> {
    await this.persistedVectorIndex?.shutdown(6500);
  }

  private beginInteractiveSearch() {
    this.activeSearchCount += 1;
    this.persistedVectorIndex?.setPaused(true);
  }

  private endInteractiveSearch() {
    this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
    if (this.activeSearchCount === 0)
      this.persistedVectorIndex?.setPaused(false);
  }

  private async openIndex(onLoadProgress?: SemanticIndexLoadProgress) {
    await fsPromises.mkdir(this.indexDirectory, { recursive: true });
    this.canonicalUserDataPath = await fsPromises
      .realpath(this.userDataPath)
      .catch(() => this.userDataPath);
    await this.loadRecords(onLoadProgress);
    await this.loadWorkerRecovery();
    try {
      const saved = JSON.parse(
        await fsPromises.readFile(
          path.join(this.indexDirectory, "discovered-totals.json"),
          "utf8",
        ),
      );
      for (const entry of saved.sources ?? []) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          entry[0].trim() &&
          Number.isSafeInteger(entry[1]) &&
          entry[1] >= 0
        )
          this.discoveredTotalsBySource.set(entry[0], entry[1]);
      }
      let totalsChanged = false;
      for (const sourcePath of this.sourcesWithExcludedRecords)
        totalsChanged = this.discoveredTotalsBySource.delete(sourcePath) || totalsChanged;
      if (totalsChanged) await this.persistDiscoveredTotals();
    } catch {
      /* Missing or invalid totals are reconstructed by recursive discovery. */
    }
    try {
      const saved = JSON.parse(
        await fsPromises.readFile(
          path.join(this.indexDirectory, "coverage.json"),
          "utf8",
        ),
      );
      for (const [root, coverage] of saved.sources ?? []) {
        if (
          typeof root !== "string" ||
          !root.trim() ||
          !coverage ||
          ![
            "pending",
            "scanning",
            "completed",
            "error",
            "unavailable",
          ].includes(coverage.status)
        )
          continue;
        const completedAt = Number(coverage.completedAt) || 0;
        this.sourceCoverage.set(root, {
          status:
            coverage.status === "scanning" ||
            (coverage.status === "completed" && !completedAt)
              ? "pending"
              : coverage.status,
          completedAt,
          error: typeof coverage.error === "string" ? coverage.error : "",
        });
      }
    } catch {
      /* Missing / invalid coverage never implies successful discovery. */
    }
    try {
      this.progress = {
        ...initialProgress,
        ...JSON.parse(await fsPromises.readFile(this.progressPath, "utf8")),
      };
      if (
        ["scanning", "loading-model", "indexing"].includes(this.progress.status)
      ) {
        this.progress.status = "paused";
        this.progress.message =
          "Indexing was interrupted and is ready to resume.";
      }
    } catch {
      await this.persistProgress();
    }
  }

  getProgress(): IndexProgress {
    return {
      ...this.progress,
      queuedRemaining: this.filesToIndex?.size ?? 0,
    };
  }

  isSearchActive(): boolean {
    return this.activeSearchCount > 0;
  }

  setDemoFileLimit(limit: number | null): void {
    if (this.demoFileLimit === limit) return;
    this.demoFileLimit = limit;
    this.demoFilePathCache.clear();
  }

  private demoFilePaths(sourcePaths: string[]): Set<string> | null {
    if (this.demoFileLimit === null) return null;
    const activeSources = new Set(
      this.watchedSources.size > 0
        ? [...this.watchedSources, ...sourcePaths]
        : sourcePaths,
    );
    const sourceKey = Array.from(activeSources).sort().join("\0");
    const cached = this.demoFilePathCache.get(sourceKey);
    if (
      cached?.revision === this.revision &&
      cached.limit === this.demoFileLimit
    ) {
      this.demoFilePathCache.delete(sourceKey);
      this.demoFilePathCache.set(sourceKey, cached);
      return cached.paths;
    }
    const eligible = Array.from(this.latestRecords.values()).filter(
      (record) =>
        activeSources.has(record.sourcePath) &&
        this.isIndexable(record, record.sourcePath),
    );
    const paths = selectDemoFilePaths(
      eligible,
      Array.from(activeSources),
      this.demoFileLimit,
    );
    this.demoFilePathCache.set(sourceKey, {
      revision: this.revision,
      limit: this.demoFileLimit,
      paths,
    });
    while (this.demoFilePathCache.size > 8)
      this.demoFilePathCache.delete(this.demoFilePathCache.keys().next().value!);
    return paths;
  }

  /**
   * Running counters add one per attempt, so a retried file can land in both
   * indexed and errors. At completion, use the per-file record counts instead.
   */
  private reconcileCompletedCounts(sourcePaths: string[]) {
    const roots = Array.from(new Set([...this.watchedSources, ...sourcePaths]));
    const summary = this.getIndexSummary(roots);
    this.auditTotal = summary.total;
    this.auditIndexed = summary.indexed;
    this.auditErrors = summary.errors;
    return {
      total: summary.total,
      indexed: summary.indexed,
      errors: summary.errors,
      remaining: summary.remaining,
    };
  }

  /** Cumulative counts from all current records, not just the active indexing batch. */
  getIndexSummary(sourcePaths?: string[]) {
    if (this.demoFileLimit !== null) {
      const roots = sourcePaths ?? Array.from(this.recordCountsBySource.keys());
      const allowedPaths = this.demoFilePaths(roots) ?? new Set<string>();
      const records = Array.from(allowedPaths, (filePath) =>
        this.latestRecords.get(filePath),
      ).filter((record): record is IndexRecord => Boolean(record));
      let discoveredTotal = 0;
      const activeRoots = new Set(roots);
      for (const [sourcePath, count] of this.discoveredTotalsBySource)
        if (activeRoots.has(sourcePath)) discoveredTotal += count;
      const indexed = records.filter((record) => record.vectorOffset >= 0).length;
      const errors = records.filter((record) => record.vectorOffset < 0 && record.error).length;
      const total = Math.min(
        this.demoFileLimit,
        Math.max(discoveredTotal, indexed + errors),
      );
      return {
        indexed,
        errors,
        total,
        discoveredTotal: total,
        remaining: Math.max(0, total - indexed - errors),
      };
    }
    const roots = sourcePaths ? new Set(sourcePaths) : null;
    let indexed = 0;
    let errors = 0;
    let discoveredTotal = 0;
    for (const [sourcePath, counts] of this.recordCountsBySource) {
      if (roots && !roots.has(sourcePath)) continue;
      indexed += counts.indexed;
      errors += counts.errors;
    }
    for (const [sourcePath, count] of this.discoveredTotalsBySource) {
      if (roots && !roots.has(sourcePath)) continue;
      discoveredTotal += count;
    }
    const total = Math.max(discoveredTotal, indexed + errors);
    return {
      indexed,
      errors,
      total,
      discoveredTotal,
      remaining: Math.max(0, total - indexed - errors),
    };
  }

  /** Count persisted indexed photos without rebuilding a file list. */
  getIndexedImageCount(sourcePaths?: string[]): number {
    const roots = sourcePaths ?? Array.from(this.recordCountsBySource.keys());
    if (this.demoFileLimit !== null) {
      const demoPaths = this.demoFilePaths(roots);
      let count = 0;
      for (const filePath of demoPaths ?? []) {
        const record = this.latestRecords.get(filePath);
        if (
          record?.type === "image" &&
          record.vectorOffset >= 0 &&
          this.isIndexable(record, record.sourcePath)
        )
          count += 1;
      }
      return count;
    }
    const activeSources = new Set(roots);
    let count = 0;
    for (const [sourcePath, counts] of this.recordCountsBySource)
      if (activeSources.has(sourcePath)) count += counts.indexedImages;
    return count;
  }

  /** Forget one configured source's durable search records without touching its files. */
  async removeSourceIndex(
    sourcePath: string,
    retainedSourcePaths: string[] = [],
  ): Promise<{ removedPaths: string[]; rollback: () => Promise<void> }> {
    await this.loaded;
    await this.writeChain;
    if (this.activeSourcePaths.includes(sourcePath))
      throw new Error("The source index is still active. Retry removal after indexing pauses.");
    const replacementRoots = Array.from(new Set(retainedSourcePaths))
      .filter((root) => root !== sourcePath)
      .sort((first, second) => second.length - first.length);
    const removedPaths: string[] = [];
    const rehomedRecords: IndexRecord[] = [];
    const queuedRehomes = new Map<string, string>();
    const previousRecords = new Map<string, IndexRecord>();
    for (const [filePath, record] of this.latestRecords) {
      if (record.sourcePath !== sourcePath) continue;
      previousRecords.set(filePath, record);
      const replacementRoot = replacementRoots.find((root) =>
        isPathWithin(filePath, root),
      );
      if (replacementRoot) {
        const relativePath = path
          .relative(replacementRoot, filePath)
          .split(path.sep)
          .join("/");
        rehomedRecords.push({ ...record, sourcePath: replacementRoot, relativePath });
      } else {
        removedPaths.push(filePath);
      }
    }

    for (const [filePath, queuedSource] of this.filesToIndex ?? []) {
      if (queuedSource !== sourcePath) continue;
      const replacementRoot = replacementRoots.find((root) =>
        isPathWithin(filePath, root),
      );
      if (replacementRoot) queuedRehomes.set(filePath, replacementRoot);
    }

    const previousFilesToIndex = this.filesToIndex ? new Map(this.filesToIndex) : null;
    const previousWorkerFailures = new Map(this.workerFailures);
    const previousDiscoveredTotals = new Map(this.discoveredTotalsBySource);
    const previousSourceCoverage = new Map(this.sourceCoverage);
    const previousExcludedRecords = new Set(this.sourcesWithExcludedRecords);
    const previousCanonicalSources = new Map(this.canonicalSourcePaths);
    const previousDirtySources = new Set(this.dirtyWatchSources);
    const previousWatchedSources = new Set(this.watchedSources);
    const previousRestoredSources = [...this.restoredSourcePaths];
    const previousQueuedSources = this.queuedSourcePaths ? [...this.queuedSourcePaths] : null;
    const journalSize = await fsPromises.stat(this.recordsPath)
      .then((stat) => stat.size, () => 0);
    let journalChanged = false;
    let rolledBack = false;

    const rollback = async () => {
      if (rolledBack) return;
      rolledBack = true;
      const errors: string[] = [];
      if (journalChanged) {
        try {
          await this.appendLines(Array.from(previousRecords, ([filePath, record]) =>
            JSON.stringify(record ?? { path: filePath, deleted: true }),
          ));
        } catch (error) {
          errors.push(`journal: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const filePath of previousRecords.keys()) this.deleteLatestRecord(filePath);
      for (const record of previousRecords.values()) this.setLatestRecord(record);
      this.filesToIndex = previousFilesToIndex ? new Map(previousFilesToIndex) : null;
      this.pendingWorkMutationVersion += 1;
      this.workerFailures.clear();
      for (const [filePath, failure] of previousWorkerFailures)
        this.workerFailures.set(filePath, failure);
      this.discoveredTotalsBySource.clear();
      for (const [root, count] of previousDiscoveredTotals)
        this.discoveredTotalsBySource.set(root, count);
      this.sourceCoverage.clear();
      for (const [root, coverage] of previousSourceCoverage)
        this.sourceCoverage.set(root, coverage);
      this.sourcesWithExcludedRecords.clear();
      for (const root of previousExcludedRecords) this.sourcesWithExcludedRecords.add(root);
      this.canonicalSourcePaths.clear();
      for (const [root, canonical] of previousCanonicalSources)
        this.canonicalSourcePaths.set(root, canonical);
      this.dirtyWatchSources = new Set(previousDirtySources);
      this.watchedSources = new Set(previousWatchedSources);
      this.restoredSourcePaths = [...previousRestoredSources];
      this.queuedSourcePaths = previousQueuedSources ? [...previousQueuedSources] : null;
      try {
        await Promise.all([
          this.persistDiscoveredTotals(),
          this.persistSourceCoverage(),
          this.persistWorkerFailures(),
          this.checkpointPendingWork(this.restoredSourcePaths, true),
        ]);
      } catch (error) {
        errors.push(`sidecars: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.reconcileCompletedCounts(Array.from(this.watchedSources));
      if (errors.length) throw new Error(`Index rollback was incomplete (${errors.join("; ")}).`);
    };

    try {
      // Write replacement records and tombstones before changing the live maps.
      if (removedPaths.length || rehomedRecords.length) {
        try {
          await this.appendLines([
            ...rehomedRecords.map((record) => JSON.stringify(record)),
            ...removedPaths.map((filePath) =>
              JSON.stringify({ path: filePath, deleted: true }),
            ),
          ]);
          journalChanged = true;
        } catch (error) {
          await fsPromises.truncate(this.recordsPath, journalSize).catch(() => undefined);
          throw error;
        }
      }

      for (const replacement of rehomedRecords) this.setLatestRecord(replacement);
      for (const filePath of removedPaths) {
        this.workerFailures.delete(filePath);
        this.deletePendingFile(filePath);
        this.deleteLatestRecord(filePath);
      }
      for (const [filePath, queuedSource] of this.filesToIndex ?? []) {
        if (queuedSource !== sourcePath) continue;
        const replacementRoot = queuedRehomes.get(filePath);
        if (replacementRoot) {
          this.filesToIndex?.set(filePath, replacementRoot);
          this.pendingWorkMutationVersion += 1;
        } else this.deletePendingFile(filePath);
      }
      this.discoveredTotalsBySource.delete(sourcePath);
      this.sourceCoverage.delete(sourcePath);
      this.sourcesWithExcludedRecords.delete(sourcePath);
      this.canonicalSourcePaths.delete(sourcePath);
      this.dirtyWatchSources.delete(sourcePath);
      this.watchedSources.delete(sourcePath);
      this.restoredSourcePaths = this.restoredSourcePaths.filter((root) => root !== sourcePath);
      if (this.queuedSourcePaths)
        this.queuedSourcePaths = this.queuedSourcePaths.filter((root) => root !== sourcePath);
      await Promise.all([
        this.persistDiscoveredTotals(),
        this.persistSourceCoverage(),
        this.persistWorkerFailures(),
        this.checkpointPendingWork(this.restoredSourcePaths, true),
      ]);
      this.reconcileCompletedCounts(Array.from(this.watchedSources));
      return { removedPaths, rollback };
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new Error(
          `Source index removal failed: ${error instanceof Error ? error.message : String(error)}. ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    }
  }

  getRetryableFiles(sourcePaths: string[]) {
    const roots = new Set(sourcePaths);
    const demoPaths = this.demoFilePaths(sourcePaths);
    const changedFiles = new Map<string, string>();
    for (const record of this.latestRecords.values())
      if (
        roots.has(record.sourcePath) &&
        (!demoPaths || demoPaths.has(record.path)) &&
        this.shouldRetryFailure(record)
      )
        changedFiles.set(record.path, record.sourcePath);
    return changedFiles;
  }

  getSourceCoverageErrors(sourcePaths: string[]) {
    return this.getSourceCoverageProgress(sourcePaths).sources
      .filter((source) => source.status === "error")
      .map((source) => source.sourcePath);
  }

  hasPendingIndexWork() {
    return Boolean(this.filesToIndex?.size || this.restoredSourcePaths.length);
  }

  getRetryableErrorCount(sourcePaths: string[]) {
    const sourceKey = Array.from(new Set(sourcePaths)).sort().join("\0");
    const now = Date.now();
    if (
      this.retryableErrorCountCache?.sourceKey === sourceKey &&
      now - this.retryableErrorCountCache.calculatedAt < 1000
    ) return this.retryableErrorCountCache.count;
    const roots = new Set(sourcePaths);
    const demoPaths = this.demoFilePaths(sourcePaths);
    let count = 0;
    for (const record of this.latestRecords.values())
      if (
        roots.has(record.sourcePath) &&
        (!demoPaths || demoPaths.has(record.path)) &&
        this.shouldRetryFailure(record)
      )
        count += 1;
    this.retryableErrorCountCache = { sourceKey, calculatedAt: now, count };
    return count;
  }

  private updateRecordCounts(record: IndexRecord, direction: 1 | -1) {
    let counts = this.recordCountsBySource.get(record.sourcePath);
    if (!counts) {
      counts = { total: 0, indexed: 0, indexedImages: 0, errors: 0 };
      this.recordCountsBySource.set(record.sourcePath, counts);
    }
    if (record.vectorOffset >= 0) {
      counts.total += direction;
      counts.indexed += direction;
      if (record.type === "image") counts.indexedImages += direction;
    } else if (record.error) {
      counts.total += direction;
      counts.errors += direction;
    }
    if (counts.total <= 0) this.recordCountsBySource.delete(record.sourcePath);
  }

  private setLatestRecord(record: IndexRecord, replaceExisting = true) {
    const previous = replaceExisting
      ? this.latestRecords.get(record.path)
      : undefined;
    if (previous) this.updateRecordCounts(previous, -1);
    this.latestRecords.set(record.path, record);
    this.updateRecordCounts(record, 1);
    if (previous && previous.vectorOffset >= 0) {
      const previousKey = previous.vectorOffset / VECTOR_BYTES;
      this.removeLatestVectorRecord(previous);
      if (this.persistedVectorIndex)
        this.persistedVectorIndex.remove(
          previous.sourcePath,
          previous.type === "image" ? "image" : "document",
          previousKey,
        );
    }
    if (record.vectorOffset >= 0) {
      const vectorKey = record.vectorOffset / VECTOR_BYTES;
      this.addLatestVectorRecord(record);
      this.persistedVectorIndex?.upsert(
        record.sourcePath,
        record.type === "image" ? "image" : "document",
        vectorKey,
      );
    }
    const recordId = this.indexSearchableText(record);
    for (const search of this.activeTextSearches)
      this.considerTextSearchRecord(search, recordId, record);
    this.revision += 1;
    if (record.vectorOffset >= 0)
      for (const listener of this.indexedRecordListeners) listener(record);
  }

  private removeLatestVectorRecord(record: IndexRecord) {
    if (record.vectorOffset < 0) return;
    const vectorKey = record.vectorOffset / VECTOR_BYTES;
    if (this.latestRecordsByVectorKey.get(vectorKey)?.path !== record.path)
      return;
    this.latestRecordsByVectorKey.delete(vectorKey);
    const sourceKeys = this.latestVectorKeysBySource.get(record.sourcePath);
    sourceKeys?.delete(vectorKey);
    if (sourceKeys?.size === 0)
      this.latestVectorKeysBySource.delete(record.sourcePath);
  }

  private addLatestVectorRecord(record: IndexRecord) {
    const vectorKey = record.vectorOffset / VECTOR_BYTES;
    const previousOwner = this.latestRecordsByVectorKey.get(vectorKey);
    if (previousOwner && previousOwner.path !== record.path)
      this.removeLatestVectorRecord(previousOwner);
    this.latestRecordsByVectorKey.set(vectorKey, record);
    let sourceKeys = this.latestVectorKeysBySource.get(record.sourcePath);
    if (!sourceKeys)
      this.latestVectorKeysBySource.set(record.sourcePath, sourceKeys = new Set());
    sourceKeys.add(vectorKey);
  }

  private indexSearchableText(record: IndexRecord): number {
    let recordId = this.textRecordIds.get(record.path);
    if (recordId === undefined) {
      recordId = this.textRecordPaths.length;
      this.textRecordIds.set(record.path, recordId);
      this.textRecordPaths.push(record.path);
      this.textRecordPostingSources.push(new Set());
      this.textRecordTerms.push(new Set());
      this.textPostingTerms.push(new Set());
    }
    const currentTermSet = searchTermSet(`${record.name} ${record.relativePath}`);
    const indexedTerms = this.textPostingTerms[recordId];
    const indexedSources = this.textRecordPostingSources[recordId];
    const sourceAlreadyIndexed = indexedSources.has(record.sourcePath);
    // Replace the current set before extending postings: unchanged records may
    // share these sets, while postings retain terms from older path versions.
    this.textRecordTerms[recordId] = currentTermSet;
    for (const term of currentTermSet) {
      if (indexedTerms.has(term)) continue;
      indexedTerms.add(term);
      if (sourceAlreadyIndexed)
        this.addTextPosting(record.sourcePath, term, recordId);
    }
    if (!sourceAlreadyIndexed) {
      for (const term of indexedTerms)
        this.addTextPosting(record.sourcePath, term, recordId);
      indexedSources.add(record.sourcePath);
    }
    let termsUnchanged = currentTermSet.size === indexedTerms.size;
    if (termsUnchanged)
      for (const term of currentTermSet)
        if (!indexedTerms.has(term)) {
          termsUnchanged = false;
          break;
        }
    if (termsUnchanged)
      this.textRecordTerms[recordId] = indexedTerms;
    return recordId;
  }

  private addTextPosting(sourcePath: string, term: string, recordId: number) {
    let sourcePostings = this.textPostingsBySource.get(sourcePath);
    if (!sourcePostings)
      this.textPostingsBySource.set(sourcePath, sourcePostings = new Map());
    const posting = sourcePostings.get(term) ?? [];
    posting.push(recordId);
    sourcePostings.set(term, posting);
  }

  private considerTextSearchRecord(
    search: ActiveTextSearch,
    recordId: number,
    record: IndexRecord,
  ) {
    if (!search.sourcePaths.has(record.sourcePath) ||
      search.seenRecordIds.has(recordId)) return;
    search.seenRecordIds.add(recordId);
    search.scanned += 1;
    if (
      !this.isSearchRecordIndexable(record) ||
      (search.demoPaths && !search.demoPaths.has(record.path))
    )
      return;
    const terms = this.textRecordTerms[recordId];
    if (!terms || !search.queryTerms.every((term) => terms.has(term))) return;
    if (search.matches.length >= SEARCH_TEXT_RESULT_LIMIT) {
      search.capped = true;
      return;
    }
    const file: IndexableFile = {
      name: record.name,
      path: record.path,
      relativePath: record.relativePath,
      size: record.size,
      modified: record.modified,
      isDirectory: false,
      type: record.type,
      extension: record.extension,
    };
    search.matches.push(file);
    search.batch.push(file);
    const now = Date.now();
    if (
      search.matches.length === 1 ||
      search.batch.length >= 64 ||
      now - search.lastPublishedAt >= 50
    )
      this.publishTextSearchBatch(search);
  }

  private publishTextSearchBatch(search: ActiveTextSearch) {
    search.onMatches?.(
      search.batch.splice(0),
      search.scanned,
      search.total,
      search.capped,
    );
    search.lastPublishedAt = Date.now();
  }

  private onTextSearchProgress(search: ActiveTextSearch, force: boolean) {
    const now = Date.now();
    if (force || now - search.lastPublishedAt >= 50)
      search.onMatches?.([], search.scanned, search.total, search.capped);
    search.lastPublishedAt = now;
  }

  private deleteLatestRecord(filePath: string) {
    const previous = this.latestRecords.get(filePath);
    if (!previous) return;
    this.latestRecords.delete(filePath);
    this.updateRecordCounts(previous, -1);
    if (previous.vectorOffset >= 0) {
      const vectorKey = previous.vectorOffset / VECTOR_BYTES;
      this.removeLatestVectorRecord(previous);
      this.persistedVectorIndex?.remove(
        previous.sourcePath,
        previous.type === "image" ? "image" : "document",
        vectorKey,
      );
    }
    this.revision += 1;
  }

  /** Changes whenever any indexed record is added, changed, reindexed or removed. */
  getRevision(): number {
    return this.revision;
  }

  /** Embedded images with their root and signature, for incremental consumers. */
  getIndexedImageRecords(sourcePaths: string[]) {
    const activeSources = new Set(sourcePaths);
    const demoPaths = this.demoFilePaths(sourcePaths);
    const result: { path: string; sourcePath: string; size: number; modified: number; signature: string }[] = [];
    for (const record of this.latestRecords.values())
      if (record.type === "image" && record.vectorOffset >= 0 && activeSources.has(record.sourcePath)
        && this.isIndexable(record, record.sourcePath) && (!demoPaths || demoPaths.has(record.path)))
        result.push({ path: record.path, sourcePath: record.sourcePath, size: record.size,
          modified: record.modified, signature: record.signature });
    return result;
  }

  private async persistDiscoveredTotals() {
    const snapshot = JSON.stringify({
      version: 1,
      sources: Array.from(this.discoveredTotalsBySource.entries()),
    });
    const target = path.join(this.indexDirectory, "discovered-totals.json");
    const write = this.summaryWriteQueue.catch(() => undefined).then(async () => {
      await fsPromises.writeFile(`${target}.tmp`, snapshot, "utf8");
      await fsPromises.rename(`${target}.tmp`, target);
    });
    this.summaryWriteQueue = write.catch((error) => {
      this.onDiagnostic("index-summary-persist-error", {
        message: String(error),
      });
    });
    await write;
  }

  getIndexedImages(sourcePaths: string[]): IndexableFile[] {
    const activeSources = new Set(sourcePaths);
    const demoPaths = this.demoFilePaths(sourcePaths);
    return Array.from(this.latestRecords.values())
      .filter(
        (record) =>
          record.type === "image" &&
          record.vectorOffset >= 0 &&
          activeSources.has(record.sourcePath) &&
          this.isIndexable(record, record.sourcePath) &&
          (!demoPaths || demoPaths.has(record.path)),
      )
      .map((record) => ({
        name: record.name,
        path: record.path,
        relativePath: record.relativePath,
        size: record.size,
        modified: record.modified,
        isDirectory: false,
        type: record.type,
        extension: record.extension,
      }));
  }

  getIndexedFiles(sourcePaths: string[]): IndexableFile[] {
    const activeSources = new Set(sourcePaths);
    const demoPaths = this.demoFilePaths(sourcePaths);
    return Array.from(this.latestRecords.values())
      .filter(
        (record) =>
          activeSources.has(record.sourcePath) &&
          this.isIndexable(record, record.sourcePath) &&
          (!demoPaths || demoPaths.has(record.path)),
      )
      .map((record) => ({
        name: record.name,
        path: record.path,
        relativePath: record.relativePath,
        size: record.size,
        modified: record.modified,
        isDirectory: false,
        type: record.type,
        extension: record.extension,
      }));
  }

  start(sourcePaths: string[], changedFiles?: Map<string, string>): Promise<void> {
    // Work requested while the saved index is still opening would re-embed known files.
    if (!this.loadComplete) return this.loaded.then(() => this.start(sourcePaths, changedFiles));
    if (this.holdReason) {
      this.heldSourcePaths = Array.from(new Set([...this.heldSourcePaths, ...sourcePaths]));
      return this.updateProgress({ status: "paused", message: this.holdReason }, true);
    }
    this.pauseRequested = false;
    this.checkpointOnPause = true;
    const restoredSources = [...this.restoredSourcePaths];
    const requestedSources = Array.from(
      new Set([...restoredSources, ...sourcePaths]),
    );
    this.restoredSourcePaths = [];
    if (changedFiles) {
      if (!this.filesToIndex) this.filesToIndex = new Map();
      for (const [filePath, sourcePath] of changedFiles) {
        this.filesToIndex.set(filePath, sourcePath);
      }
      if (changedFiles.size)
        this.pendingWorkMutationVersion += changedFiles.size;
    }
    let resumeFullScanAfterPendingQueue =
      Boolean(this.filesToIndex?.size) && restoredSources.length > 0;
    if (this.runPromise) {
      const queuedSources = new Set([
        ...(this.queuedSourcePaths ?? []),
        ...requestedSources,
      ]);
      if (queuedSources.size !== (this.queuedSourcePaths?.length ?? 0)) {
        this.queuedSourcePaths = Array.from(queuedSources);
        this.pendingWorkMutationVersion += 1;
      }
      return this.runPromise;
    }

    const releaseGovernorLane =
      this.indexerGovernor?.enterLane("search") ?? (() => undefined);

    console.log(
      "[SemanticIndexer] Starting indexing with sources:",
      requestedSources,
    );
    // Defer the run body until after runPromise is registered. A checkpoint or
    // progress callback may request another start synchronously during setup.
    const runPromise = Promise.resolve().then(async () => {
      let nextSourcePaths: string[] | null = requestedSources;
      let aliasSourceSignature = "";
      const configureAliasesFor = async (roots: string[]) => {
        const combined = Array.from(
          new Set([...this.watchedSources, ...roots]),
        );
        const nextSignature = combined.slice().sort().join("\n");
        if (nextSignature === aliasSourceSignature) return;
        aliasSourceSignature = nextSignature;
        await this.configureSourcePathAliases(combined);
      };
      try {
        await configureAliasesFor(requestedSources);
        await this.checkpointPendingWork(
          requestedSources,
          Boolean(changedFiles?.size),
        );
        while (nextSourcePaths !== null && !this.pauseRequested) {
          await configureAliasesFor(nextSourcePaths);
          this.queuedSourcePaths = null;
          this.activeSourcePaths = nextSourcePaths;
          await this.run(nextSourcePaths);
          if (this.progress.status === "error") {
            nextSourcePaths = null;
          } else if (this.queuedSourcePaths !== null) {
            nextSourcePaths = this.queuedSourcePaths;
          } else if (this.filesToIndex?.size) {
            nextSourcePaths = this.activeSourcePaths.length
              ? this.activeSourcePaths
              : requestedSources;
          } else if (resumeFullScanAfterPendingQueue) {
            resumeFullScanAfterPendingQueue = false;
            nextSourcePaths = requestedSources;
          } else {
            nextSourcePaths = null;
          }
        }
      } finally {
        releaseGovernorLane();
        this.runPromise = null;
        this.queuedSourcePaths = null;
        this.activeSourcePaths = [];
      }
    });
    this.runPromise = runPromise;
    return runPromise;
  }

  async startFullScan(sourcePaths: string[]): Promise<void> {
    await this.loaded;
    while (this.runPromise) await this.runPromise;
    if (this.filesToIndex) this.pendingWorkMutationVersion += 1;
    this.filesToIndex = null;
    this.queuedSourcePaths = null;
    await this.start(sourcePaths);
  }

  async pause(options: { checkpoint?: boolean } = {}) {
    const interruptedSources = Array.from(
      new Set([
        ...this.activeSourcePaths,
        ...(this.queuedSourcePaths ?? []),
        ...this.restoredSourcePaths,
        ...Array.from(this.filesToIndex?.values() ?? []),
      ]),
    );
    this.checkpointOnPause = options.checkpoint !== false;
    this.pauseRequested = true;
    this.queuedSourcePaths = null;
    if (this.runPromise) await this.runPromise.catch(() => undefined);
    if (interruptedSources.length || this.filesToIndex?.size)
      await this.checkpointPendingWork(
        interruptedSources,
        this.checkpointOnPause,
      );
    if (!this.runPromise) {
      await this.updateProgress(
        { status: "paused", message: this.holdReason ?? "Indexing paused." },
        true,
      );
    }
  }

  private holdReason: string | null = null;
  private heldSourcePaths: string[] = [];
  private activeSourcePaths: string[] = [];

  /**
   * Block indexing for a system reason (memory pressure, cache drive missing). Running
   * work stops at its next checkpoint; everything indexed so far is already persisted.
   * Returns the sources that were interrupted or requested while held so the caller
   * can resume them once the hold is released.
   */
  async setHold(reason: string | null): Promise<string[]> {
    if (reason) {
      const wasHeld = this.holdReason !== null;
      this.holdReason = reason;
      if (!wasHeld && this.runPromise) {
        this.heldSourcePaths = Array.from(
          new Set([...this.heldSourcePaths, ...this.activeSourcePaths, ...(this.queuedSourcePaths ?? [])]),
        );
        await this.pause();
        await this.runPromise?.catch(() => undefined);
        await this.updateProgress({ status: "paused", message: reason }, true);
      }
      return [];
    }
    this.holdReason = null;
    const resume = this.heldSourcePaths;
    this.heldSourcePaths = [];
    return resume;
  }

  getHoldReason() {
    return this.holdReason;
  }

  /**
   * Start watching sources for file changes and auto-reconcile the index.
   * This is called automatically on app startup and whenever a new source is added.
   */
  async startWatching(sourcePaths: string[]): Promise<void> {
    const appDataPath = this.userDataPath;
    const canonicalAppDataPath = await fsPromises
      .realpath(appDataPath)
      .catch(() => appDataPath);
    const requestedSources = new Set<string>();
    const canonicalSourcePaths = new Map<string, string>();
    this.canonicalSourcePaths.clear();
    for (const sourcePath of sourcePaths) {
      if (this.isRemotePath(sourcePath)) {
        requestedSources.add(sourcePath);
        continue;
      }
      const canonicalSourcePath = await fsPromises
        .realpath(sourcePath)
        .catch(() => path.resolve(sourcePath));
      if (
        isNonLibraryPath(sourcePath) ||
        isAppDataPath(
          sourcePath,
          sourcePath,
          canonicalSourcePath,
          appDataPath,
          canonicalAppDataPath,
        )
      )
        continue;
      if (await isSiloCloneDirectory(sourcePath)) continue;
      requestedSources.add(sourcePath);
      canonicalSourcePaths.set(sourcePath, canonicalSourcePath);
      this.canonicalSourcePaths.set(sourcePath, canonicalSourcePath);
    }
    await this.configureSourcePathAliases(Array.from(requestedSources));
    for (const [sourcePath, watcher] of this.fileWatchers) {
      if (!requestedSources.has(sourcePath)) {
        watcher.close();
        this.fileWatchers.delete(sourcePath);
      }
    }

    this.watchedSources = requestedSources;
    this.isWatching = false;

    console.log(
      "[SemanticIndexer] Starting file watches for sources:",
      sourcePaths,
    );

    for (const sourcePath of requestedSources) {
      // Skip if already watching or if path is remote (phone/cloud)
      if (this.fileWatchers.has(sourcePath) || this.isRemotePath(sourcePath)) {
        continue;
      }

      try {
        await fsPromises.access(sourcePath, fs.constants.R_OK);
        const canonicalSourcePath =
          canonicalSourcePaths.get(sourcePath) ?? path.resolve(sourcePath);
        const watcher = fs.watch(
          sourcePath,
          { recursive: true, persistent: false },
          (eventType, fileName) => {
            if (!fileName) return; // Some events don't have a filename
            const changedPath = path.resolve(sourcePath, fileName.toString());
            void (async () => {
              if (
                isNonLibraryPath(changedPath) ||
                isAppDataPath(
                  changedPath,
                  sourcePath,
                  canonicalSourcePath,
                  appDataPath,
                  canonicalAppDataPath,
                ) ||
                (await isWithinSiloClone(changedPath, sourcePath))
              )
                return;
              this.dirtyWatchSources.add(sourcePath);
              // Writes below a held path (an active phone backup) wait for release.
              if (this.isHeld(changedPath)) return;
              this.scheduleReconciliation();
            })();
          },
        );

        watcher.on("error", (error) => {
          console.log(
            `[SemanticIndexer] Watch error for ${sourcePath}:`,
            error.message,
          );
          // Continue watching, errors are often transient
        });

        this.fileWatchers.set(sourcePath, watcher);
        this.isWatching = true;
        console.log(`[SemanticIndexer] Watching source: ${sourcePath}`);
      } catch (error) {
        console.log(
          `[SemanticIndexer] Cannot watch source (may be unavailable): ${sourcePath}`,
          error instanceof Error ? error.message : "",
        );
        // Source is unavailable - don't delete index, just skip watching
      }
    }
  }

  /**
   * Stop watching all sources for file changes.
   */
  stopWatching(): void {
    console.log("[SemanticIndexer] Stopping file watches");
    for (const [sourcePath, watcher] of this.fileWatchers) {
      try {
        watcher.close();
      } catch (error) {
        console.log(
          `[SemanticIndexer] Error closing watcher for ${sourcePath}:`,
          error,
        );
      }
    }
    this.fileWatchers.clear();
    this.watchedSources.clear();
    this.isWatching = false;

    if (this.reconciliationTimeout) {
      clearTimeout(this.reconciliationTimeout);
      this.reconciliationTimeout = null;
    }
  }

  /**
   * Reconcile the index with the actual filesystem to detect new, modified, and deleted files.
   * Returns a map of filePath -> sourcePath for files that need to be re-indexed.
   */
  async reconcileIndex(
    sourcePaths: string[],
    onChangesAvailable?: (changes: Map<string, string>) => void,
    shouldYieldForIndexing: () => boolean = () => false,
  ): Promise<Map<string, string>> {
    await this.loaded;
    if (this.reconciliationCancelRequested) return new Map();
    if (this.reconciliationPromise) {
      await this.reconciliationPromise;
      return this.reconcileIndex(
        sourcePaths,
        onChangesAvailable,
        shouldYieldForIndexing,
      );
    }
    const releaseDiscoveryLane =
      this.indexerGovernor?.enterLane("source-discovery") ?? (() => undefined);
    const pending = this.runReconciliation(
      sourcePaths,
      onChangesAvailable,
      shouldYieldForIndexing,
    ).finally(() => {
      releaseDiscoveryLane();
      this.reconciliationPromise = null;
      // Watch events that arrive during a full source walk are coalesced into
      // the dirty-root set. Schedule one follow-up pass after the active walk
      // completes instead of letting every debounce callback queue a waiter.
      if (!this.reconciliationCancelRequested && this.dirtyWatchSources.size)
        this.scheduleReconciliation();
    });
    this.reconciliationPromise = pending;
    return pending;
  }

  private async runReconciliation(
    sourcePaths: string[],
    onChangesAvailable?: (changes: Map<string, string>) => void,
    shouldYieldForIndexing: () => boolean = () => false,
  ): Promise<Map<string, string>> {
    sourcePaths = Array.from(new Set(sourcePaths));
    await this.configureSourcePathAliases(
      Array.from(new Set([...this.watchedSources, ...sourcePaths])),
    );
    const excludedAliasDirectoriesBySource = new Map(
      sourcePaths.map((sourcePath) => [
        sourcePath,
        this.excludedDirectoriesForSource(sourcePath),
      ]),
    );
    const isExcludedAliasPath = (filePath: string, sourcePath: string) =>
      (excludedAliasDirectoriesBySource.get(sourcePath) ?? []).some(
        (excludedRoot) => isPathWithin(filePath, excludedRoot),
      );
    this.getSourceCoverageProgress(sourcePaths);
    this.reconciliation = {
      running: true,
      source: "",
      sourcePath: "",
      sourceIndex: 0,
      sourceCount: sourcePaths.length,
      scanned: 0,
      changed: 0,
      startedAt: Date.now(),
      message: "Discovering new and changed files…",
      error: "",
    };
    try {
      const changesFound = new Map<string, string>(); // filePath -> sourcePath
      const publishChanges = (changes: Map<string, string>) => {
        if (!changes.size || !onChangesAvailable) return;
        try {
          onChangesAvailable(new Map(changes));
        } catch (error) {
          this.onDiagnostic("reconciliation-change-publish-error", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };
      const deletedPaths: string[] = [];
      const seenFiles = new Set<string>(); // files found on disk
      const accessibleSources = new Set<string>();
      const completedWalkCheckpoints: Array<{
        state: ReconciliationWalkCheckpoint;
        stateName: string;
        journalPath: string;
      }> = [];
      let auditTotal = 0;
      let auditIndexed = 0;
      let auditErrors = 0;

      // Check each source for changes
      for (const sourcePath of sourcePaths) {
        this.reconciliation.sourcePath = sourcePath;
        this.reconciliation.sourceIndex += 1;
        this.reconciliation.source = path.basename(sourcePath) || "Source";
        this.reconciliation.message = `Checking source ${this.reconciliation.sourceIndex} of ${sourcePaths.length}: ${this.reconciliation.source}`;
        // Remote inventory is only covered by the full provider scan, not this skip.
        if (this.isRemotePath(sourcePath)) continue;
        if (!(await this.isSourceAccessible(sourcePath))) {
          await this.setSourceCoverage(sourcePath, "unavailable");
          continue;
        }
        const canonicalSourcePath = await fsPromises
          .realpath(sourcePath)
          .catch(() => path.resolve(sourcePath));
        this.canonicalSourcePaths.set(sourcePath, canonicalSourcePath);
        await this.setSourceCoverage(sourcePath, "scanning");
        const previousDiscoveredTotal = this.discoveredTotalsBySource.get(sourcePath);
        let sourceFileCount = 0;
        let unpublishedChanges = new Map<string, string>();
        let lastPublishedAt = Date.now();
        let walkState: ReconciliationWalkCheckpoint | null = null;
        let walkStateName = "";
        let walkJournalPath = "";
        const observedSourceFiles = new Set<string>();
        const journaledSourceFiles = new Set<string>();
        const observeFile = (file: IndexableFile) => {
          if (isExcludedAliasPath(file.path, sourcePath)) return;
          this.reconciliation.scanned += 1;
          if (observedSourceFiles.has(file.path)) return;
          observedSourceFiles.add(file.path);
          seenFiles.add(file.path);

          if (!this.isIndexable(file, sourcePath)) return;
          auditTotal += 1;
          sourceFileCount += 1;

          const stored = this.latestRecords.get(file.path);
          const currentSig = this.signature(file);

          // File is new or modified
          if (
            !stored ||
            stored.signature !== currentSig ||
            this.shouldRetryFailure(stored)
          ) {
            changesFound.set(file.path, sourcePath);
            unpublishedChanges.set(file.path, sourcePath);
            this.reconciliation.changed = changesFound.size;
            if (
              unpublishedChanges.size >= RECONCILIATION_PUBLISH_BATCH_SIZE ||
              Date.now() - lastPublishedAt >= RECONCILIATION_PUBLISH_INTERVAL_MS
            ) {
              publishChanges(unpublishedChanges);
              unpublishedChanges = new Map();
              lastPublishedAt = Date.now();
            }
          } else if (stored.vectorOffset >= 0) {
            auditIndexed += 1;
          } else if (stored.error) {
            auditErrors += 1;
          }
        };
        try {
          const sourceStats = await fsPromises.stat(sourcePath);
          const checkpoint = await this.loadSourceWalkCheckpoint(
            sourcePath,
            canonicalSourcePath,
            sourceStats.dev,
          );
          walkState = checkpoint.state;
          walkStateName = checkpoint.stateName;
          walkJournalPath = checkpoint.journalPath;
          if (walkState.journalOffset > 0) {
            this.onDiagnostic("source-walk-resumed", {
              source: path.basename(sourcePath) || "Source",
              journalBytes: walkState.journalOffset,
              pendingDirectories: walkState.pendingDirectories.length,
            });
          }
          await this.replaySourceWalkJournal(
            walkState,
            walkJournalPath,
            sourcePath,
            (file) => {
              observeFile(file);
              journaledSourceFiles.add(file.path);
            },
            () =>
              this.activeSearchCount > 0 || shouldYieldForIndexing(),
          );
          const scanCheckpoint: SourceScanCheckpoint = {
            resumeDirectories: walkState.pendingDirectories,
            excludeDirectories:
              excludedAliasDirectoriesBySource.get(sourcePath) ?? [],
            onCheckpoint: async (pendingDirectories, discoveredFiles) => {
              const newFiles: IndexableFile[] = [];
              const checkpointPaths = new Set<string>();
              for (const file of discoveredFiles) {
                if (
                  !this.isIndexable(file, sourcePath) ||
                  journaledSourceFiles.has(file.path) ||
                  checkpointPaths.has(file.path)
                )
                  continue;
                checkpointPaths.add(file.path);
                newFiles.push(file);
              }
              walkState = await this.persistSourceWalkCheckpoint(
                walkState!,
                walkStateName,
                walkJournalPath,
                pendingDirectories,
                newFiles,
                sourcePath,
              );
              for (const file of newFiles) journaledSourceFiles.add(file.path);
            },
          };
          await this.scanSourceForReconciliation(
            sourcePath,
            observeFile,
            shouldYieldForIndexing,
            scanCheckpoint,
          );
        } catch (error) {
          if (this.reconciliationCancelRequested) {
            await this.setSourceCoverage(sourcePath, "pending");
            throw error;
          }
          this.reconciliation.error =
            error instanceof Error ? error.message : String(error);
          if (previousDiscoveredTotal === undefined)
            this.discoveredTotalsBySource.delete(sourcePath);
          else this.discoveredTotalsBySource.set(sourcePath, previousDiscoveredTotal);
          await this.setSourceCoverage(
            sourcePath,
            "error",
            this.reconciliation.error,
          );
          continue;
        }
        this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
        await this.persistDiscoveredTotals();
        await this.setSourceCoverage(sourcePath, "completed");
        accessibleSources.add(sourcePath);
        if (walkState) {
          completedWalkCheckpoints.push({
            state: walkState,
            stateName: walkStateName,
            journalPath: walkJournalPath,
          });
        }
        // Publish the tail of this source after a complete walk. Intermediate
        // batches let Search make fair progress during large source discovery;
        // deletion decisions remain deferred until every source is verified.
        publishChanges(unpublishedChanges);
      }

      if (this.reconciliationCancelRequested) return changesFound;

      // Check for deleted files (in index but not on disk)
      for (const [filePath, record] of this.latestRecords.entries()) {
        if (!accessibleSources.has(record.sourcePath)) continue;
        // Legacy records of phone thumbnails/caches are retired too.
        const derivative = isPhoneDerivativePath(filePath);
        if (derivative || (!seenFiles.has(filePath) && this.isIndexable(record as any, record.sourcePath))) {
          this.deleteLatestRecord(filePath);
          deletedPaths.push(filePath);
        }
      }

      if (deletedPaths.length > 0) {
        await this.appendLines(
          deletedPaths.map((filePath) => JSON.stringify({ path: filePath, deleted: true })),
        );
        console.log(
          `[SemanticIndexer] Reconciliation removed ${deletedPaths.length} deleted files`,
        );
      }
      for (const checkpoint of completedWalkCheckpoints) {
        await this.clearSourceWalkCheckpoint(
          checkpoint.state,
          checkpoint.stateName,
          checkpoint.journalPath,
        );
      }

      if (changesFound.size > 0) {
        console.log(
          `[SemanticIndexer] Reconciliation found ${changesFound.size} files to re-index`,
        );
      }

      // A watcher pass over a few changed roots must not shrink library-wide totals.
      const coversLibrary = Array.from(this.watchedSources).every(
        (sourcePath) => this.isRemotePath(sourcePath) || sourcePaths.includes(sourcePath),
      );
      if (!coversLibrary) return changesFound;
      this.auditTotal = auditTotal;
      this.auditIndexed = auditIndexed;
      this.auditErrors = auditErrors;
      if (!this.runPromise)
        await this.updateProgress(
          {
            total: auditTotal,
            indexed: auditIndexed,
            remaining: changesFound.size,
            errors: auditErrors,
            message: `${auditIndexed.toLocaleString()} of ${auditTotal.toLocaleString()} original files have CLIP embeddings.`,
          },
          true,
        );

      return changesFound;
    } catch (error) {
      if (this.reconciliationCancelRequested) {
        this.reconciliation.message =
          "Source discovery paused during shutdown; it will resume on next launch.";
        this.reconciliation.error = "";
        return new Map();
      }
      console.error("[SemanticIndexer] Reconciliation error:", error);
      this.reconciliation.error =
        error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.reconciliation.running = false;
    }
  }

  /**
   * Returns true if this is a remote path (phone or cloud) that requires special handling.
   */
  private isRemotePath(sourcePath: string): boolean {
    return (
      sourcePath.startsWith("/__phone__/") ||
      sourcePath.startsWith("/__phone_backup__/") ||
      sourcePath.startsWith("/__cloud__/")
    );
  }

  /**
   * Check if a source folder is currently accessible.
   */
  private async isSourceAccessible(sourcePath: string): Promise<boolean> {
    if (this.isRemotePath(sourcePath)) {
      // Remote paths are handled differently, assume accessible for now
      return true;
    }
    try {
      await fsPromises.access(sourcePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scan a source specifically for reconciliation (just file list, not full recursive scan).
   */
  private async scanSourceForReconciliation(
    sourcePath: string,
    onFile: (file: IndexableFile) => void,
    shouldYieldForIndexing: () => boolean = () => false,
    checkpoint?: SourceScanCheckpoint,
  ): Promise<void> {
    // Use the standard scanSource for now, but could be optimized
    // to use a shallow scan for reconciliation
    await this.scanSource(
      sourcePath,
      onFile,
      () => this.reconciliationCancelRequested,
      () => this.activeSearchCount > 0 || shouldYieldForIndexing(),
      checkpoint,
    );
    if (this.reconciliationCancelRequested)
      throw new Error("Source discovery was cancelled during shutdown.");
  }

  async cancelReconciliation() {
    this.reconciliationCancelRequested = true;
    await this.reconciliationPromise?.catch(() => undefined);
    this.reconciliationCancelRequested = false;
  }

  /**
   * Schedule reconciliation to run after a debounce period.
   * Prevents excessive reconciliation from rapid file changes.
   */
  private scheduleReconciliation(): void {
    if (this.reconciliationTimeout) {
      clearTimeout(this.reconciliationTimeout);
    }

    this.reconciliationTimeout = setTimeout(async () => {
      this.reconciliationTimeout = null;
      // Keep dirty roots queued while a scan is running. reconcileIndex callers
      // serialize by awaiting the active promise; doing that once per watcher
      // debounce creates an unbounded chain of rescans on busy or large roots.
      if (this.reconciliationPromise) return;

      // Only roots that actually changed are rescanned, and never while their writes are held.
      const sources = Array.from(this.dirtyWatchSources).filter(
        (sourcePath) => this.watchedSources.has(sourcePath) && !this.isHeld(sourcePath, true),
      );
      if (sources.length === 0) return;
      sources.forEach((sourcePath) => this.dirtyWatchSources.delete(sourcePath));

      console.log("[SemanticIndexer] Running debounced reconciliation for", sources.length, "changed source(s)");
      try {
        const changedFiles = await this.reconcileIndex(sources);
        if (changedFiles.size > 0) {
          console.log(
            `[SemanticIndexer] Queueing ${changedFiles.size} changed files for incremental indexing`,
          );
          this.backgroundIndexWorkListener?.(changedFiles);
        }
      } catch (error) {
        // Preserve the retry request and let future watcher activity or the
        // recovery loop retry it; never turn a transient scan error into an
        // unhandled rejection that can take down the app.
        sources.forEach((sourcePath) => this.dirtyWatchSources.add(sourcePath));
        this.onDiagnostic("watch-reconciliation-error", {
          sourceCount: sources.length,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, RECONCILIATION_DEBOUNCE_MS);
  }

  /** True when candidate lies inside a held path (or, with containsHold, a source holds one). */
  private isHeld(candidate: string, containsHold = false): boolean {
    for (const held of this.watchHolds.keys())
      if (isPathWithin(candidate, held) || (containsHold && isPathWithin(held, candidate))) return true;
    return false;
  }

  /**
   * Suspends watcher-driven rescans for a folder that is being bulk-written (phone backups).
   * Release reconciles affected sources once, so new files are indexed exactly one time.
   */
  holdWatchReconciliation(folder: string): void {
    const key = path.resolve(folder);
    this.watchHolds.set(key, (this.watchHolds.get(key) ?? 0) + 1);
  }

  releaseWatchReconciliation(folder: string): void {
    const key = path.resolve(folder);
    const count = (this.watchHolds.get(key) ?? 0) - 1;
    if (count > 0) {
      this.watchHolds.set(key, count);
      return;
    }
    this.watchHolds.delete(key);
    for (const sourcePath of this.watchedSources)
      if (!this.isRemotePath(sourcePath) && (isPathWithin(key, sourcePath) || isPathWithin(sourcePath, key)))
        this.dirtyWatchSources.add(sourcePath);
    if (this.dirtyWatchSources.size) this.scheduleReconciliation();
  }

  /**
   * Get the current watch status for UI display.
   */
  getWatchStatus(): { isWatching: boolean; watchedSourceCount: number } {
    return {
      isWatching: this.isWatching,
      watchedSourceCount: this.watchedSources.size,
    };
  }

  async preloadClipModel(): Promise<void> {
    // Pre-load the CLIP model to avoid delays on first search
    await this.loadClipRuntime();
  }

  async search(
    query: string,
    minimumConfidence: number,
    sourcePaths: string[],
    isCancelled: () => boolean = () => false,
    onSearchProgress?: SearchProgressListener,
    include?: (file: { path: string; size: number; type: string }) => boolean,
  ): Promise<SearchResult[]> {
    const confidenceThreshold = Number.isFinite(minimumConfidence)
      ? Math.max(0, Math.min(100, minimumConfidence))
      : 0;
    await this.loaded;
    // Searches temporarily take priority over background indexing and model
    // work. The ANN worker still answers from partitions ready so far.
    this.beginInteractiveSearch();
    try {
      return await this.runSearch(
        query,
        confidenceThreshold,
        sourcePaths,
        isCancelled,
        onSearchProgress,
        include,
      );
    } finally {
      this.endInteractiveSearch();
    }
  }

  /**
   * Stream filename and path matches from the loaded index before CLIP finishes
   * embedding or scoring a query.
   */
  async searchTextMatches(
    query: string,
    sourcePaths: string[],
    isCancelled: () => boolean = () => false,
    onMatches?: (
      matches: IndexableFile[],
      scanned: number,
      total: number,
      capped: boolean,
    ) => void,
  ): Promise<IndexableFile[]> {
    const queryTerms = searchTerms(query);
    const uniqueSourcePaths = Array.from(new Set(sourcePaths));
    if (!queryTerms.length || uniqueSourcePaths.length === 0 || isCancelled())
      return [];
    if (isCancelled()) return [];

    const total = uniqueSourcePaths.reduce(
      (count, sourcePath) => count + (this.recordCountsBySource.get(sourcePath)?.total ?? 0),
      0,
    );

    const search: ActiveTextSearch = {
      queryTerms,
      sourcePaths: new Set(uniqueSourcePaths),
      demoPaths: this.demoFilePaths(uniqueSourcePaths),
      total,
      onMatches,
      seenRecordIds: new Set(),
      matches: [],
      batch: [],
      scanned: 0,
      capped: false,
      lastPublishedAt: 0,
    };
    this.activeTextSearches.add(search);
    try {
      const sourcePostings = queryTerms.map((term) => {
        const lists: Array<{ sourcePath: string; recordIds: number[] }> = [];
        let count = 0;
        for (const sourcePath of uniqueSourcePaths) {
          const recordIds = this.textPostingsBySource.get(sourcePath)?.get(term) ?? [];
          if (!recordIds.length) continue;
          lists.push({ sourcePath, recordIds });
          count += recordIds.length;
        }
        return { lists, count };
      }).sort((first, second) => first.count - second.count);
      if (this.loadComplete && sourcePostings.some(({ count }) => count === 0))
        return [];
      this.beginInteractiveSearch();
      try {
        let index = 0;
        const candidates = sourcePostings[0]?.lists ?? [];
        for (const { sourcePath, recordIds } of candidates) {
          for (const recordId of recordIds) {
            if (isCancelled() || search.capped) break;
            const record = this.latestRecords.get(this.textRecordPaths[recordId]);
            if (
              record && record.sourcePath === sourcePath &&
              queryTerms.every((term) => this.textRecordTerms[recordId].has(term))
            )
              this.considerTextSearchRecord(search, recordId, record);
            index += 1;
            if (index % 512 === 0) {
              this.onTextSearchProgress(search, false);
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
          if (isCancelled() || search.capped) break;
        }
        while (!this.loadComplete && !isCancelled() && !search.capped) {
          this.onTextSearchProgress(search, false);
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
        }
        if (search.batch.length || search.capped)
          this.publishTextSearchBatch(search);
        return search.matches;
      } finally {
        this.endInteractiveSearch();
      }
    } finally {
      this.activeTextSearches.delete(search);
    }
  }

  classifyUnsafeImages(
    sourcePaths: string[],
    unsafePrompt: string,
    safePrompt: string,
  ): Promise<string[]> {
    const result = this.searchChain.then(async () => {
      if (sourcePaths.length === 0 || this.latestRecords.size === 0) return [];
      const runtime = await this.loadClipRuntime();
      const unsafeVector = await this.embedText(
        `a photo of ${unsafePrompt}`,
        runtime,
      );
      const safeVector = await this.embedText(
        `a photo of ${safePrompt}`,
        runtime,
      );
      const vectorBuffer = await fsPromises
        .readFile(this.vectorsPath)
        .catch(() => Buffer.alloc(0));
      if (vectorBuffer.byteLength < VECTOR_BYTES) return [];
      const vectors = new Float32Array(
        vectorBuffer.buffer,
        vectorBuffer.byteOffset,
        Math.floor(vectorBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
      const activeSources = new Set(sourcePaths);
      const demoPaths = this.demoFilePaths(sourcePaths);
      const unsafePaths: string[] = [];
      let checkedImages = 0;
      for (const record of this.latestRecords.values()) {
        if (
          record.type !== "image" ||
          record.vectorOffset < 0 ||
          !activeSources.has(record.sourcePath) ||
          (demoPaths && !demoPaths.has(record.path))
        )
          continue;
        const vectorStart =
          record.vectorOffset / Float32Array.BYTES_PER_ELEMENT;
        let unsafeSimilarity = 0;
        let safeSimilarity = 0;
        for (let index = 0; index < VECTOR_SIZE; index += 1) {
          const value = vectors[vectorStart + index];
          unsafeSimilarity += unsafeVector[index] * value;
          safeSimilarity += safeVector[index] * value;
        }
        if (
          unsafeSimilarity >= 0.2 &&
          unsafeSimilarity - safeSimilarity >= 0.008
        )
          unsafePaths.push(record.path);
        checkedImages += 1;
        if (checkedImages % 1000 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return unsafePaths;
    });
    this.searchChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** CLIP text embeddings for prompts, computed locally. */
  async embedPreviewImage(filePath: string): Promise<Float32Array> {
    const runtime = await this.loadClipRuntime();
    return this.embedImage(filePath, runtime);
  }

  async embedPrompts(prompts: string[]): Promise<Float32Array[]> {
    const runtime = await this.loadClipRuntime();
    const vectors: Float32Array[] = [];
    for (const prompt of prompts)
      vectors.push(await this.embedText(prompt, runtime));
    return vectors;
  }

  /** Stored image embeddings for specific paths, read by offset so the whole vector file isn't loaded. */
  async getImageVectors(paths: string[]): Promise<Map<string, Float32Array>> {
    await this.loaded;
    const vectors = new Map<string, Float32Array>();
    const sourcePaths = Array.from(
      new Set(Array.from(this.latestRecords.values(), (record) => record.sourcePath)),
    );
    const demoPaths = this.demoFilePaths(sourcePaths);
    const handle = await fsPromises
      .open(this.vectorsPath, "r")
      .catch(() => null);
    if (!handle) return vectors;
    try {
      for (const filePath of paths) {
        if (demoPaths && !demoPaths.has(filePath)) continue;
        const record = this.latestRecords.get(filePath);
        if (!record || record.type !== "image" || record.vectorOffset < 0)
          continue;
        const buffer = Buffer.alloc(VECTOR_BYTES);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          VECTOR_BYTES,
          record.vectorOffset,
        );
        if (bytesRead === VECTOR_BYTES)
          vectors.set(
            filePath,
            new Float32Array(buffer.buffer, buffer.byteOffset, VECTOR_SIZE),
          );
      }
    } finally {
      await handle.close();
    }
    return vectors;
  }

  /**
   * Assigns a bounded random sample of indexed photos to whichever prompt fits best.
   * Counts reveal what a library is mostly about; matches are best-first per prompt.
   * Reads only sampled vectors by offset and yields regularly to keep main responsive.
   */
  classifyImageConcepts(
    prompts: string[],
    sourcePaths: string[],
    options: {
      sampleLimit?: number;
      topPerPrompt?: number;
      minimumSimilarity?: number;
      include?: (file: { path: string; size: number }) => boolean;
    } = {},
  ): Promise<Array<{ count: number; matches: Array<{ path: string; similarity: number }> }>> {
    const result = this.searchChain.then(async () => {
      const sampleLimit = options.sampleLimit ?? 20000;
      const topPerPrompt = options.topPerPrompt ?? 240;
      const minimumSimilarity = options.minimumSimilarity ?? 0.2;
      const output = prompts.map(() => ({ count: 0, matches: [] as Array<{ path: string; similarity: number }> }));
      const activeSources = new Set(sourcePaths);
      const demoPaths = this.demoFilePaths(sourcePaths);
      const eligible: IndexRecord[] = [];
      for (const record of this.latestRecords.values())
        if (record.type === "image" && record.vectorOffset >= 0 && activeSources.has(record.sourcePath)
          && this.isIndexable(record, record.sourcePath) && (!demoPaths || demoPaths.has(record.path))
          && (!options.include || options.include(record)))
          eligible.push(record);
      if (!eligible.length || !prompts.length) return output;
      const stride = Math.max(1, Math.ceil(eligible.length / sampleLimit));
      const offset = Math.floor(Math.random() * stride);
      const sample: IndexRecord[] = [];
      for (let index = offset; index < eligible.length; index += stride) sample.push(eligible[index]);
      sample.sort((a, b) => a.vectorOffset - b.vectorOffset);
      const runtime = await this.loadClipRuntime();
      const promptVectors: Float32Array[] = [];
      for (const prompt of prompts) promptVectors.push(await this.embedText(prompt, runtime));
      const handle = await fsPromises.open(this.vectorsPath, "r").catch(() => null);
      if (!handle) return output;
      const trim = (list: Array<{ path: string; similarity: number }>) => {
        list.sort((a, b) => b.similarity - a.similarity);
        list.length = Math.min(list.length, topPerPrompt);
      };
      try {
        const BATCH = 256;
        for (let start = 0; start < sample.length; start += BATCH) {
          const batch = sample.slice(start, start + BATCH);
          const buffers = await Promise.all(batch.map(async (record) => {
            const buffer = Buffer.alloc(VECTOR_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, VECTOR_BYTES, record.vectorOffset);
            return bytesRead === VECTOR_BYTES ? buffer : null;
          }));
          for (let index = 0; index < batch.length; index++) {
            const buffer = buffers[index];
            if (!buffer) continue;
            const vector = new Float32Array(buffer.buffer, buffer.byteOffset, VECTOR_SIZE);
            let best = -1;
            let bestSimilarity = -Infinity;
            for (let prompt = 0; prompt < promptVectors.length; prompt++) {
              const query = promptVectors[prompt];
              let similarity = 0;
              for (let dimension = 0; dimension < VECTOR_SIZE; dimension++)
                similarity += query[dimension] * vector[dimension];
              if (similarity > bestSimilarity) { bestSimilarity = similarity; best = prompt; }
            }
            if (best < 0 || bestSimilarity < minimumSimilarity) continue;
            const entry = output[best];
            entry.count += 1;
            entry.matches.push({ path: batch[index].path, similarity: bestSimilarity });
            if (entry.matches.length > topPerPrompt * 2) trim(entry.matches);
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        await handle.close();
      }
      output.forEach((entry) => trim(entry.matches));
      return output;
    });
    this.searchChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runSearch(
    query: string,
    minimumConfidence: number,
    sourcePaths: string[],
    isCancelled: () => boolean,
    onSearchProgress?: SearchProgressListener,
    include?: (file: { path: string; size: number; type: string }) => boolean,
  ): Promise<SearchResult[]> {
    const cleanQuery = query.trim();
    if (isCancelled() || !cleanQuery || sourcePaths.length === 0) return [];

    const searchStartedAt = Date.now();
    const embeddingStartedAt = searchStartedAt;
    let embeddingMs = 0;
    let retrievalMs = 0;
    const runtime = await this.loadClipRuntime();
    if (isCancelled()) return [];
    const embeddingKey = cleanQuery.toLowerCase();
    let searchEmbeddings = this.searchEmbeddingCache.get(embeddingKey);
    if (searchEmbeddings) {
      this.searchEmbeddingCache.delete(embeddingKey);
      this.searchEmbeddingCache.set(embeddingKey, searchEmbeddings);
    } else {
      const [document, image] = await Promise.all([
        this.embedText(cleanQuery, runtime, 10),
        this.embedText(`a photo of ${cleanQuery}`, runtime, 10),
      ]);
      searchEmbeddings = { document, image };
      this.searchEmbeddingCache.set(embeddingKey, searchEmbeddings);
      if (this.searchEmbeddingCache.size > SEARCH_EMBEDDING_CACHE_LIMIT) {
        const oldestKey = this.searchEmbeddingCache.keys().next().value;
        if (oldestKey) this.searchEmbeddingCache.delete(oldestKey);
      }
    }
    embeddingMs = Date.now() - embeddingStartedAt;
    if (isCancelled()) return [];

    const selectedSources = new Set(sourcePaths);
    const indexedRecordCount = Array.from(selectedSources).reduce(
      (count, sourcePath) =>
        count + (this.recordCountsBySource.get(sourcePath)?.indexed ?? 0),
      0,
    );
    let hits: Array<{ key: number; confidence: number }>;
    let annDiagnostics: VectorSearchDiagnostics | undefined;
    let searchMode: "ann" | "exact" = "exact";
    const retrievalStartedAt = Date.now();
    if (this.vectorIndexFailed || include) {
      hits = await this.exactVectorSearch(
        sourcePaths,
        searchEmbeddings.image,
        searchEmbeddings.document,
        isCancelled,
        include,
      );
    } else if (this.persistedVectorIndex) {
      searchMode = "ann";
      onSearchProgress?.([], 0, indexedRecordCount, "ann");
      try {
        const annResponse = await this.persistedVectorIndex.search(
          sourcePaths,
          searchEmbeddings.image,
          searchEmbeddings.document,
          SEARCH_RESULTS_PER_TYPE,
        );
        hits = annResponse.hits;
        annDiagnostics = annResponse.diagnostics;
      } catch (error) {
        if (isCancelled()) return [];
        searchMode = "exact";
        this.onDiagnostic("semantic-ann-search-error", {
          message: error instanceof Error ? error.message : String(error),
        });
        hits = await this.exactVectorSearch(
          sourcePaths,
          searchEmbeddings.image,
          searchEmbeddings.document,
          isCancelled,
          include,
        );
      }
    } else {
      // While the worker is being created, keep this query responsive and let
      // filename/path matching provide immediate results. The next query can
      // use the ANN worker as soon as its first partition is available.
      searchMode = "ann";
      hits = [];
      onSearchProgress?.([], 0, indexedRecordCount, "ann");
    }
    retrievalMs = Date.now() - retrievalStartedAt;
    if (isCancelled()) return [];

    const results: SearchResult[] = [];
    for (const hit of hits) {
      const record = this.latestRecordsByVectorKey.get(hit.key);
      if (
        !record ||
        record.vectorOffset / VECTOR_BYTES !== hit.key ||
        !sourcePaths.includes(record.sourcePath) ||
        hit.confidence < minimumConfidence
      )
        continue;
      results.push({
        name: record.name,
        path: record.path,
        relativePath: record.relativePath,
        size: record.size,
        modified: record.modified,
        isDirectory: false,
        type: record.type,
        extension: record.extension,
        confidence: hit.confidence,
      });
    }
    results.sort((first, second) => second.confidence - first.confidence);
    if (!isCancelled()) {
      onSearchProgress?.(results, hits.length, indexedRecordCount, searchMode);
      const durationMs = Date.now() - searchStartedAt;
      if (durationMs >= 1500)
        this.onDiagnostic("semantic-search-slow", {
          durationMs,
          embeddingMs,
          retrievalMs,
          indexedRecords: indexedRecordCount,
          returnedCandidates: hits.length,
          mode: searchMode,
          annReady: this.vectorIndexReadyState,
          annFailed: this.vectorIndexFailed,
          ...(annDiagnostics ? { ann: annDiagnostics } : {}),
        });
    }
    return isCancelled() ? [] : results;
  }

  /**
   * Brute-force cosine scan of vectors.bin, used when the native ANN index is
   * unavailable (for example a missing native addon) so semantic results and
   * memories still work. Confidence matches the ANN worker's exact re-ranking.
   */
  private async exactVectorSearch(
    sourcePaths: string[],
    imageQuery: Float32Array,
    documentQuery: Float32Array,
    isCancelled: () => boolean,
    include?: (file: { path: string; size: number; type: string }) => boolean,
  ): Promise<Array<{ key: number; confidence: number }>> {
    const sources = new Set(sourcePaths);
    const demoPaths = include ? this.demoFilePaths(sourcePaths) : null;
    const wanted = new Map<number, boolean>();
    for (const sourcePath of sources) {
      for (const key of this.latestVectorKeysBySource.get(sourcePath) ?? []) {
        const record = this.latestRecordsByVectorKey.get(key);
        if (record?.sourcePath === sourcePath && record.vectorOffset >= 0 &&
          (!include || ((!demoPaths || demoPaths.has(record.path)) && include(record))))
          wanted.set(key, record.type === "image");
      }
    }
    if (!wanted.size) return [];
    const handle = await fsPromises.open(this.vectorsPath, "r").catch((error: unknown) => {
      if (include) throw error;
      return null;
    });
    if (!handle) return [];
    const imageHits: Array<{ key: number; confidence: number }> = [];
    const documentHits: Array<{ key: number; confidence: number }> = [];
    const chunkVectors = 2048;
    const buffer = Buffer.allocUnsafeSlow(chunkVectors * VECTOR_BYTES);
    try {
      const keys = Array.from(wanted.keys()).sort((first, second) => first - second);
      let index = 0;
      while (index < keys.length) {
        if (isCancelled()) return [];
        const firstKey = keys[index];
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, firstKey * VECTOR_BYTES);
        if (bytesRead < VECTOR_BYTES) break;
        while (index < keys.length) {
          const key = keys[index];
          const localOffset = (key - firstKey) * VECTOR_BYTES;
          if (localOffset + VECTOR_BYTES > bytesRead) break;
          index += 1;
          const isImage = wanted.get(key)!;
          const query = isImage ? imageQuery : documentQuery;
          const vector = new Float32Array(buffer.buffer, buffer.byteOffset + localOffset, VECTOR_SIZE);
          let similarity = 0;
          for (let dimension = 0; dimension < VECTOR_SIZE; dimension += 1)
            similarity += query[dimension] * vector[dimension];
          if (!Number.isFinite(similarity)) continue;
          (isImage ? imageHits : documentHits).push({
            key,
            confidence: Math.max(0, Math.min(100, similarity * 100)),
          });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (const hits of include ? [imageHits, documentHits] : []) {
          if (hits.length > SEARCH_RESULT_PRUNE_THRESHOLD) {
            hits.sort((first, second) => second.confidence - first.confidence);
            hits.length = SEARCH_RESULTS_PER_TYPE;
          }
        }
      }
    } finally {
      await handle.close();
    }
    const top = (hits: Array<{ key: number; confidence: number }>) =>
      hits.sort((first, second) => second.confidence - first.confidence).slice(0, SEARCH_RESULTS_PER_TYPE);
    return [...top(imageHits), ...top(documentHits)];
  }

  private preservePendingFiles(
    pending: Array<{ file: IndexableFile; sourcePath: string }>,
    startIndex: number,
    preserveDiscoveredFiles: boolean,
    durableQueueAlreadyContainsPending = false,
  ) {
    if (durableQueueAlreadyContainsPending) return;
    const queued = new Map<string, string>();
    if (preserveDiscoveredFiles)
      for (const { file, sourcePath } of pending.slice(startIndex))
        queued.set(file.path, sourcePath);
    for (const [filePath, sourcePath] of this.filesToIndex ?? [])
      if (!queued.has(filePath)) queued.set(filePath, sourcePath);
    this.filesToIndex = queued.size ? queued : null;
    this.pendingWorkMutationVersion += 1;
  }

  private deletePendingFile(filePath: string) {
    if (this.filesToIndex?.delete(filePath))
      this.pendingWorkMutationVersion += 1;
  }

  private takePendingQueueBatch(
    queue: Map<string, string>,
    limit: number,
  ): Array<[string, string]> {
    const batch: Array<[string, string]> = [];
    for (const entry of queue) {
      batch.push(entry);
      if (batch.length >= limit) break;
    }
    return batch;
  }

  private async run(sourcePaths: string[]) {
    const pending: Array<{ file: IndexableFile; sourcePath: string }> = [];
    const demoTypeCounts = new Map<string, number>();
    const demoCandidatesByType = new Map<
      string,
      Array<{ file: IndexableFile; sourcePath: string }>
    >();
    let demoSampleMessage = "";
    let nextPendingIndex = 0;
    let isIncremental = false;
    try {
      // Check if we're doing incremental indexing (only specific files)
      isIncremental = this.filesToIndex !== null;
      let filesToIndex = this.filesToIndex;
      // The queue is the durable source of truth. Snapshot only the next bounded
      // batch for this run; watcher additions remain appended to the same Map.
      const incrementalBatchEntries = filesToIndex
        ? this.takePendingQueueBatch(filesToIndex, INCREMENTAL_BATCH_SIZE)
        : [];
      const demoPaths = this.demoFilePaths(sourcePaths);
      let demoSlotsRemaining =
        this.demoFileLimit === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, this.demoFileLimit - (demoPaths?.size ?? 0));
      let demoLimitReached = false;
      const allowDemoFile = (filePath: string) => {
        if (!demoPaths || demoPaths.has(filePath)) return true;
        if (demoSlotsRemaining <= 0) {
          demoLimitReached = true;
          return false;
        }
        demoPaths.add(filePath);
        demoSlotsRemaining -= 1;
        return true;
      };

      const statusMsg = isIncremental
        ? `Re-indexing ${filesToIndex!.size} changed file${filesToIndex!.size === 1 ? "" : "s"}...`
        : `Discovering files across ${sourcePaths.length} source${sourcePaths.length === 1 ? "" : "s"}...`;

      await this.updateProgress(
        {
          status: "scanning",
          total: isIncremental && this.auditTotal > 0 ? this.auditTotal : 0,
          indexed: isIncremental ? this.auditIndexed : 0,
          remaining:
            isIncremental && this.auditTotal > 0
              ? Math.max(
                  0,
                  this.auditTotal - this.auditIndexed - this.auditErrors,
                )
              : (filesToIndex?.size ?? 0),
          errors: isIncremental ? this.auditErrors : 0,
          currentFile: null,
          message: statusMsg,
        },
        true,
      );

      const seenPaths = new Set<string>();
      const sourceFileStats: Map<string, { found: number; pending: number }> =
        new Map();

      // Reuse the existing bounded demo sample so repeat launches do not walk
      // every directory just to rediscover files already represented in cache.
      if (!isIncremental && this.demoFileLimit !== null && demoPaths) {
        for (const record of this.latestRecords.values()) {
          if (!demoPaths.has(record.path) || !sourcePaths.includes(record.sourcePath))
            continue;
          const candidates = demoCandidatesByType.get(record.type) ?? [];
          candidates.push({
            file: {
              name: record.name,
              path: record.path,
              relativePath: record.relativePath,
              size: record.size,
              modified: record.modified,
              isDirectory: false,
              type: record.type,
              extension: record.extension,
            },
            sourcePath: record.sourcePath,
          });
          demoCandidatesByType.set(record.type, candidates);
          demoTypeCounts.set(
            record.type,
            (demoTypeCounts.get(record.type) ?? 0) + 1,
          );
          seenPaths.add(record.path);
        }
        demoPaths.clear();
        for (const candidates of demoCandidatesByType.values())
          for (const candidate of candidates) demoPaths.add(candidate.file.path);
        demoSlotsRemaining = Math.max(
          0,
          this.demoFileLimit - demoPaths.size,
        );
      }

      let candidateCount = 0;
      let existingErrors = 0;
      let indexed = 0;

      if (isIncremental) {
        // Incremental mode: only process the changed files
        console.log(
          `[SemanticIndexer] Processing the next ${incrementalBatchEntries.length} of ${filesToIndex!.size} queued files`,
        );
        for (const sourcePath of new Set(
          incrementalBatchEntries.map(([, sourcePath]) => sourcePath),
        )) {
          if (!this.isRemotePath(sourcePath))
            this.canonicalSourcePaths.set(
              sourcePath,
              await fsPromises.realpath(sourcePath).catch(() => path.resolve(sourcePath)),
            );
        }
        for (const [filePath, sourcePath] of incrementalBatchEntries) {
          if (this.pauseRequested) break;

          try {
            const stats = await fsPromises.stat(await this.resolveFilePath(filePath));
            if (stats.isDirectory()) {
              this.deletePendingFile(filePath);
              continue;
            }

            const file: IndexableFile = {
              name: path.basename(filePath),
              path: filePath,
              relativePath: filePath,
              size: stats.size,
              modified: stats.mtime.getTime(),
              isDirectory: false,
              type: this.inferType(filePath),
              extension: path.extname(filePath).toLowerCase(),
            };

            if (!this.isIndexable(file, sourcePath) || !allowDemoFile(filePath)) {
              this.deletePendingFile(filePath);
              continue;
            }
            seenPaths.add(filePath);
            candidateCount += 1;

            const failure = this.workerFailures.get(file.path);
            if (
              failure?.signature === this.signature(file) &&
              failure.attempts >= 3
            ) {
              existingErrors += 1;
              this.deletePendingFile(filePath);
              continue;
            }
            // Always re-index in incremental mode
            pending.push({ file, sourcePath });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") {
              this.deletePendingFile(filePath);
              this.deleteLatestRecord(filePath);
            } else {
              console.warn(
                `[SemanticIndexer] Error accessing changed file ${filePath}:`,
                error instanceof Error ? error.message : String(error),
              );
              // Preserve transient I/O and permission failures for recovery.
              throw error;
            }
          }
        }
        sourceFileStats.set("(incremental)", {
          found: candidateCount,
          pending: pending.length,
        });
      } else {
        // Full scan mode: scan all sources
        sourcePaths = Array.from(new Set(sourcePaths));
        this.getSourceCoverageProgress(sourcePaths);
        this.searchDiscovery = {
          running: true,
          source: "",
          sourcePath: "",
          sourceIndex: 0,
          sourceCount: sourcePaths.length,
          scanned: 0,
          changed: 0,
          startedAt: Date.now(),
          message: "Discovering files…",
          error: "",
        };
        let lastDiscoveryUpdate = 0;
        try {
          for (const sourcePath of sourcePaths) {
            if (this.pauseRequested) break;
            this.searchDiscovery.sourcePath = sourcePath;
            let sourceFileCount =
              this.demoFileLimit === null
                ? 0
                : Array.from(demoCandidatesByType.values())
                    .flat()
                    .filter((candidate) => candidate.sourcePath === sourcePath).length;
            const demoSourcesRemaining =
              sourcePaths.length - this.searchDiscovery.sourceIndex;
            const demoSourceTarget =
              this.demoFileLimit === null
                ? Number.POSITIVE_INFINITY
                : Math.ceil(
                    demoSlotsRemaining / Math.max(1, demoSourcesRemaining),
                  );
            let demoSourceCandidates = 0;
            let demoSourceSampleReached = demoSourceTarget <= 0;
            const previousDiscoveredTotal = this.discoveredTotalsBySource.get(sourcePath);
            this.searchDiscovery.sourceIndex += 1;
            this.searchDiscovery.source = path.basename(sourcePath) || "Source";
            this.searchDiscovery.message = `Reading ${this.searchDiscovery.source} · source ${this.searchDiscovery.sourceIndex} of ${sourcePaths.length}`;
            this.progress.message = this.searchDiscovery.message;
            this.emitProgress();

            if (!(await this.isSourceAccessible(sourcePath))) {
              await this.setSourceCoverage(sourcePath, "unavailable");
              continue;
            }
            if (!this.isRemotePath(sourcePath))
              this.canonicalSourcePaths.set(
                sourcePath,
                await fsPromises.realpath(sourcePath).catch(() => path.resolve(sourcePath)),
              );
            await this.setSourceCoverage(sourcePath, "scanning");
            this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
            try {
              if (!demoSourceSampleReached) await this.scanSource(
                sourcePath,
                (file) => {
                  if (this.isExcludedSourceAliasPath(file.path, sourcePath))
                    return;
                  this.searchDiscovery.scanned += 1;
                  if (Date.now() - lastDiscoveryUpdate >= 500) {
                    lastDiscoveryUpdate = Date.now();
                    this.progress.total = candidateCount;
                    this.progress.indexed = indexed;
                    this.progress.errors = existingErrors;
                    this.progress.remaining = pending.length;
                    const observedIndexable = Array.from(
                      demoTypeCounts.values(),
                    ).reduce((sum, count) => sum + count, 0);
                    this.progress.message =
                      this.demoFileLimit === null
                        ? `${this.searchDiscovery.message} · ${this.searchDiscovery.scanned.toLocaleString()} entries inspected · ${candidateCount.toLocaleString()} indexable · ${pending.length.toLocaleString()} pending`
                        : `${this.searchDiscovery.message} · ${this.searchDiscovery.scanned.toLocaleString()} entries inspected · ${observedIndexable.toLocaleString()} indexable files counted by type`;
                    this.emitProgress();
                  }
                  if (!this.isIndexable(file, sourcePath)) return;
                  if (seenPaths.has(file.path)) return;
                  seenPaths.add(file.path);
                  if (this.demoFileLimit !== null) {
                    if (!allowDemoFile(file.path)) {
                      demoLimitReached = true;
                      demoSourceSampleReached = true;
                      return;
                    }
                    sourceFileCount += 1;
                    demoSourceCandidates += 1;
                    demoTypeCounts.set(
                      file.type,
                      (demoTypeCounts.get(file.type) ?? 0) + 1,
                    );
                    const candidates = demoCandidatesByType.get(file.type) ?? [];
                    candidates.push({ file, sourcePath });
                    demoCandidatesByType.set(file.type, candidates);
                    this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
                    if (demoSourceCandidates >= demoSourceTarget) {
                      demoSourceSampleReached = true;
                      if (demoSlotsRemaining <= 0) demoLimitReached = true;
                    }
                    return;
                  }

                  sourceFileCount += 1;
                  this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
                  if (!allowDemoFile(file.path)) return;
                  candidateCount += 1;
                  const stored = this.latestRecords.get(file.path);
                  if (
                    !stored ||
                    stored.signature !== this.signature(file) ||
                    this.shouldRetryFailure(stored)
                  ) {
                    pending.push({ file, sourcePath });
                    this.searchDiscovery.changed = pending.length;
                  } else if (stored.error) {
                    existingErrors += 1;
                  } else {
                    indexed += 1;
                  }
                  if (candidateCount % 1000 === 0) {
                    this.progress.total = candidateCount;
                    this.progress.indexed = indexed;
                    this.progress.errors = existingErrors;
                    this.progress.remaining = pending.length;
                    this.progress.message = `Discovered ${candidateCount.toLocaleString()} indexable files in ${path.basename(sourcePath)}...`;
                    this.emitProgress();
                  }
                },
                () => this.pauseRequested || demoSourceSampleReached,
                () => this.activeSearchCount > 0,
                {
                  excludeDirectories:
                    this.excludedDirectoriesForSource(sourcePath),
                },
              );
            } catch (error) {
              this.searchDiscovery.error =
                error instanceof Error ? error.message : String(error);
              if (previousDiscoveredTotal === undefined)
                this.discoveredTotalsBySource.delete(sourcePath);
              else
                this.discoveredTotalsBySource.set(sourcePath, previousDiscoveredTotal);
              await this.setSourceCoverage(
                sourcePath,
                "error",
                this.searchDiscovery.error,
              );
              continue;
            }
            if (this.pauseRequested) {
              if (previousDiscoveredTotal === undefined)
                this.discoveredTotalsBySource.delete(sourcePath);
              else
                this.discoveredTotalsBySource.set(sourcePath, previousDiscoveredTotal);
            } else {
              this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
              await this.persistDiscoveredTotals();
            }
            await this.setSourceCoverage(
              sourcePath,
              this.pauseRequested ? "pending" : "completed",
            );

            sourceFileStats.set(sourcePath, {
              found: sourceFileCount,
              pending: 0,
            });
          }
        } catch (error) {
          this.searchDiscovery.error =
            error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          this.searchDiscovery.running = false;
          this.searchDiscovery.message = this.pauseRequested
            ? "Source discovery paused."
            : `Inspected ${this.searchDiscovery.scanned.toLocaleString()} entries across ${this.searchDiscovery.sourceIndex} sources.`;
        }
      }

      if (!isIncremental && this.demoFileLimit !== null && !this.pauseRequested) {
        const candidates = Array.from(demoCandidatesByType.values())
          .flat()
          .sort((first, second) =>
            first.file.path.localeCompare(second.file.path),
          );
        const selectedPaths = selectDemoFilePaths(
          candidates.map(({ file, sourcePath }) => ({
            path: file.path,
            sourcePath,
            type: file.type,
          })),
          sourcePaths,
          this.demoFileLimit,
          Object.fromEntries(demoTypeCounts),
        );
        const selectedTypeCounts: Record<string, number> = {};
        const pendingBySource = new Map<string, number>();
        for (const candidate of candidates) {
          if (!selectedPaths.has(candidate.file.path)) continue;
          const { file, sourcePath } = candidate;
          candidateCount += 1;
          selectedTypeCounts[file.type] =
            (selectedTypeCounts[file.type] ?? 0) + 1;
          const stored = this.latestRecords.get(file.path);
          if (
            !stored ||
            stored.signature !== this.signature(file) ||
            this.shouldRetryFailure(stored)
          ) {
            pending.push({ file, sourcePath });
            pendingBySource.set(
              sourcePath,
              (pendingBySource.get(sourcePath) ?? 0) + 1,
            );
          } else if (stored.error || stored.vectorOffset < 0) {
            existingErrors += 1;
          } else {
            indexed += 1;
          }
        }
        for (const [sourcePath, stats] of sourceFileStats)
          stats.pending = pendingBySource.get(sourcePath) ?? 0;
        demoSampleMessage = formatDemoFileSample(
          selectedTypeCounts,
          Object.fromEntries(demoTypeCounts),
        );
        this.auditTotal = candidateCount;
        this.auditIndexed = indexed;
        this.auditErrors = existingErrors;
        this.searchDiscovery.changed = pending.length;
      }

      // Camera photos first so memories, people and places have material
      // long before app assets, logs and documents finish on slow machines.
      const tier = (file: IndexableFile) =>
        file.type !== "image" ? 2 : isPersonalPhotoPath(file.path, file.size) ? 0 : 1;
      const tiers = new Map(pending.map(({ file }) => [file.path, tier(file)]));
      pending.sort((first, second) =>
        tiers.get(first.file.path)! - tiers.get(second.file.path)! ||
        first.file.modified - second.file.modified ||
        (first.file.path < second.file.path
          ? -1
          : first.file.path > second.file.path
            ? 1
            : 0),
      );

      await this.updateProgress(
        {
          total:
            isIncremental && this.auditTotal > 0
              ? this.auditTotal
              : candidateCount,
          indexed:
            isIncremental && this.auditTotal > 0 ? this.auditIndexed : indexed,
          remaining:
            isIncremental && this.auditTotal > 0
              ? Math.max(
                  0,
                  this.auditTotal - this.auditIndexed - this.auditErrors,
                )
              : pending.length,
          errors:
            isIncremental && this.auditTotal > 0
              ? this.auditErrors
              : existingErrors,
          currentFile: null,
          ...(demoSampleMessage
            ? { message: demoSampleMessage }
            : demoLimitReached
              ? {
                  message: `Demo sample is limited to ${this.demoFileLimit?.toLocaleString()} indexable files; additional files remain untouched.`,
                }
              : {}),
        },
        true,
      );

      if (this.pauseRequested) {
        this.preservePendingFiles(
          pending,
          0,
          isIncremental || this.demoFileLimit !== null,
        );
        await this.checkpointPendingWork(sourcePaths, this.checkpointOnPause);
        await this.updateProgress(
          { status: "paused", message: "Indexing paused." },
          true,
        );
        return;
      }

      if (pending.length === 0) {
        // Build a more informative message
        let message = isIncremental
          ? "All changes indexed."
          : "Index is up to date.";
        if (!isIncremental && candidateCount === 0) {
          message = `No indexable files found (${sourcePaths.length} source${sourcePaths.length === 1 ? "" : "s"} scanned).`;
        } else if (!isIncremental && candidateCount > 0 && indexed > 0) {
          message = `All ${candidateCount.toLocaleString()} indexable files are already indexed.`;
        }
        if (demoSampleMessage) message = `${demoSampleMessage} ${message}`;

        console.log(
          "[SemanticIndexer] No pending files to index. Message:",
          message,
        );
        console.log(
          "[SemanticIndexer] Source stats:",
          Object.fromEntries(sourceFileStats),
        );

        if (this.filesToIndex?.size) {
          this.queuedSourcePaths = sourcePaths;
          await this.updateProgress(
            {
              status: "scanning",
              message: `${this.filesToIndex.size.toLocaleString()} saved files remain in the queue.`,
            },
            true,
          );
          await this.checkpointPendingWork(sourcePaths);
        } else {
          await this.updateProgress(
            { ...this.reconcileCompletedCounts(sourcePaths), status: "complete", message },
            true,
          );
          await this.checkpointPendingWork([], true);
        }
        return;
      }

      await this.updateProgress(
        {
          status: "loading-model",
          message: demoSampleMessage
            ? `${demoSampleMessage} Loading the offline search model...`
            : "Loading offline CLIP model...",
        },
        true,
      );
      let runtime: ClipRuntime;
      try {
        runtime = await this.loadClipRuntime();
      } catch (error) {
        // Runtime construction/preload failures belong to the infrastructure,
        // never to whichever file happens to be first in the batch.
        throw error instanceof EmbeddingProcessError
          ? error
          : new EmbeddingProcessError(
              `Semantic model initialization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
      }
      await this.updateProgress(
        {
          status: "indexing",
          message: demoSampleMessage
            ? `${demoSampleMessage} Creating search embeddings...`
            : "Creating semantic embeddings...",
        },
        true,
      );

      for (let index = 0; index < pending.length; index += 1) {
        nextPendingIndex = index;
        if (this.pauseRequested) {
          this.preservePendingFiles(
            pending,
            index,
            isIncremental || this.demoFileLimit !== null,
          );
          await this.checkpointPendingWork(sourcePaths, this.checkpointOnPause);
          await this.updateProgress(
            {
              status: "paused",
              currentFile: null,
              message: "Indexing paused with the remaining queue saved.",
            },
            true,
          );
          return;
        }

        const { file, sourcePath } = pending[index];
        await this.updateProgress({ currentFile: file.name }, false);
        this.processingPaths.add(file.path);
        const fileWorkStartedAt = Date.now();
        let succeeded = false;
        try {
          const vector =
            file.type === "image"
              ? await this.embedImage(file.path, runtime)
              : await this.embedTextFile(file, runtime);
          await this.appendRecord(file, sourcePath, vector);
          succeeded = true;
        } catch (error) {
          // A dead decoder/model process is not a bad file. Preserve the index
          // and stop this run; an explicit later request can start a new child.
          if (error instanceof EmbeddingProcessError) {
            if (file.type === "image" && error.nativeImageCrash) {
              const signature = this.signature(file);
              const previous = this.workerFailures.get(file.path);
              const attempts = Math.min(
                3,
                (previous?.signature === signature ? previous.attempts : 0) + 1,
              );
              this.workerFailures.set(file.path, {
                signature,
                attempts,
                message: error.message,
                timestamp: Date.now(),
              });
              try {
                await this.persistWorkerFailures();
                if (attempts >= 3) {
                  await this.appendFailure(
                    file,
                    sourcePath,
                    "Semantic image worker crashed 3 times for this unchanged file. Skipped until the file changes; repair or re-export the image to retry. The original file has not been modified.",
                  );
                  nextPendingIndex = index + 1;
                  this.deletePendingFile(file.path);
                  this.auditErrors += 1;
                  this.progress.errors += 1;
                }
              } catch {
                // A recovery-state write failure must not replace the worker
                // exception and discard this batch's unprocessed files.
                if (previous) this.workerFailures.set(file.path, previous);
                else this.workerFailures.delete(file.path);
                this.onDiagnostic("semantic-worker-failure-persist-error", {
                  message: "Worker failure could not be saved.",
                });
              }
            }
            throw error;
          }
          await this.appendFailure(
            file,
            sourcePath,
            error instanceof Error ? error.message : "Indexing failed.",
          );
        } finally {
          this.processingPaths.delete(file.path);
        }
        nextPendingIndex = index + 1;
        if (succeeded && this.workerFailures.delete(file.path))
          await this.persistWorkerFailures();
        this.deletePendingFile(file.path);
        if (succeeded) {
          this.auditIndexed += 1;
          this.progress.indexed =
            this.auditTotal > 0 ? this.auditIndexed : this.progress.indexed + 1;
        } else {
          this.auditErrors += 1;
          this.progress.errors = this.auditErrors;
        }
        this.progress.remaining =
          this.auditTotal > 0
            ? Math.max(
                0,
                this.auditTotal - this.auditIndexed - this.auditErrors,
              )
            : Math.max(0, this.progress.remaining - 1);
        this.emitProgress();
        if (index % 10 === 9) {
          await this.persistProgress();
          if (isIncremental) await this.checkpointPendingWork(sourcePaths);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        // Treat the preference as a ceiling; the shared governor also backs
        // off for system load, battery, memory pressure, and thermal state.
        const fileWorkMs = Math.max(1, Date.now() - fileWorkStartedAt);
        if (this.indexerGovernor) {
          await this.indexerGovernor.paceAfterWork(
            fileWorkMs,
            () => this.activeSearchCount > 0,
            () => this.pauseRequested,
            this.performanceSettings.backgroundWorkPercent,
          );
        } else {
          let cooldownRemaining = Math.ceil(
            fileWorkMs *
              ((100 - this.performanceSettings.backgroundWorkPercent) /
                this.performanceSettings.backgroundWorkPercent),
          );
          while (
            cooldownRemaining > 0 &&
            this.activeSearchCount === 0 &&
            !this.pauseRequested
          ) {
            const sliceMs = Math.min(50, cooldownRemaining);
            await new Promise<void>((resolve) => setTimeout(resolve, sliceMs));
            cooldownRemaining -= sliceMs;
          }
        }
        // An active search gets the next inference slot.
        while (this.activeSearchCount > 0 && !this.pauseRequested)
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
      }

      if (this.filesToIndex && this.filesToIndex.size > 0) {
        this.queuedSourcePaths = sourcePaths;
        await this.checkpointPendingWork(sourcePaths);
        await this.updateProgress(
          {
            status: "scanning",
            currentFile: null,
            message: `${this.auditIndexed.toLocaleString()} of ${this.auditTotal.toLocaleString()} original files indexed. Continuing in the background...`,
          },
          true,
        );
      } else {
        const completedCounts = this.reconcileCompletedCounts(sourcePaths);
        await this.updateProgress(
          {
            ...completedCounts,
            status: "complete",
            currentFile: null,
            message: `${this.auditIndexed.toLocaleString()} of ${this.auditTotal.toLocaleString()} original files have CLIP embeddings.${demoSampleMessage ? ` ${demoSampleMessage}` : ""}`,
          },
          true,
        );
        await this.checkpointPendingWork([], true);
      }
    } catch (error) {
      // Keep the unfinished chronological queue and source scan roots so the
      // recovery manager can retry in this session or resume after a restart.
      const interruptedSources = [
        ...sourcePaths,
        ...(this.queuedSourcePaths ?? []),
      ];
      this.queuedSourcePaths = null;
      this.preservePendingFiles(
        pending,
        nextPendingIndex,
        isIncremental || this.demoFileLimit !== null,
      );
      this.progress.remaining = this.filesToIndex?.size ?? 0;
      try {
        await this.checkpointPendingWork(interruptedSources, true);
      } catch (checkpointError) {
        this.onDiagnostic("semantic-worker-checkpoint-error", {
          message: "Interrupted work could not be saved.",
        });
        console.error(
          "[SemanticIndexer] Pending checkpoint failed",
          checkpointError,
        );
      }
      await this.updateProgress(
        {
          status: "error",
          currentFile: null,
          message:
            error instanceof EmbeddingProcessError &&
            nextPendingIndex > 0 &&
            this.workerFailures.get(pending[nextPendingIndex - 1]?.file.path)
              ?.attempts === 3
              ? "Repeat-crashing image skipped after 3 attempts. Repair or re-export the image to retry; restart indexing to resume the remaining files. Original preserved."
              : error instanceof Error
                ? error.message
                : "Indexing failed.",
        },
        true,
      );
    }
  }

  private async loadClipRuntime(): Promise<ClipRuntime> {
    if (this.clipRuntime) return this.clipRuntime;
    if (!this.clipRuntimePromise) {
      let child: ChildProcess;
      try {
        child = this.ensureEmbeddingWorker();
      } catch {
        throw new EmbeddingProcessError(
          "Semantic embedding process could not be started.",
        );
      }
      const promise = (async () => {
        await this.requestWorkerEmbedding("preload", {}, child);
        if (this.embeddingWorker !== child)
          throw new EmbeddingProcessError(
            "Semantic embedding process is unavailable.",
          );
        this.clipRuntime = { worker: true, child };
        return this.clipRuntime;
      })().catch((error) => {
        if (this.clipRuntimePromise === promise) this.clipRuntimePromise = null;
        throw error;
      });
      this.clipRuntimePromise = promise;
    }
    return this.clipRuntimePromise;
  }

  private runInference<T>(task: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.inferenceQueue.push({
        priority,
        sequence: this.inferenceSequence++,
        task: () => {
          this.inferenceActive = true;
          void task().then(
            (value) => {
              resolve(value);
              this.finishInference();
            },
            (error) => {
              reject(error);
              this.finishInference();
            },
          );
        },
      });
      this.inferenceQueue.sort(
        (first, second) => second.priority - first.priority || first.sequence - second.sequence,
      );
      if (!this.inferenceActive) this.inferenceQueue.shift()?.task();
    });
  }

  private finishInference(): void {
    this.inferenceActive = false;
    this.inferenceQueue.shift()?.task();
  }

  private async embedText(text: string, runtime: ClipRuntime, priority = 0) {
    return this.runInference(async () => {
      if (runtime.worker)
        return this.normalize(
          await this.requestWorkerEmbedding(
            "text",
            { text: text.slice(0, 8000) },
            runtime.child,
          ),
        );
      const inputs = runtime.tokenizer!([text.slice(0, 8000)], {
        padding: true,
        truncation: true,
      });
      const output = await runtime.textModel!(inputs);
      return this.normalize(output.text_embeds.data);
    }, priority);
  }

  private async embedImage(filePath: string, runtime: ClipRuntime) {
    return this.runInference(async () => {
      const localPath = await this.resolveFilePath(filePath);
      // Intel builds of libheif lack HEVC, so macOS converts HEIC with sips first.
      const heifFirst =
        process.platform === "darwin" && /\.(heic|heif)$/i.test(localPath);
      try {
        if (heifFirst) throw new Error("HEIC is decoded by macOS.");
        return await this.embedImageFile(localPath, runtime);
      } catch (originalError) {
        if (originalError instanceof EmbeddingProcessError) throw originalError;
        if (process.platform !== "darwin") throw originalError;

        const temporaryDirectory = await fsPromises.mkdtemp(
          path.join(os.tmpdir(), "semantic-image-"),
        );
        const convertedPath = path.join(temporaryDirectory, "converted.jpg");
        try {
          await execFileAsync("sips", [
            "-s",
            "format",
            "jpeg",
            localPath,
            "--out",
            convertedPath,
          ]).catch(() => undefined);
          const converted = await fsPromises
            .stat(convertedPath)
            .then((stat) => stat.size > 0)
            .catch(() => false);
          if (!converted) {
            if (heifFirst) return await this.embedImageFile(localPath, runtime);
            throw new UnreadableImageError();
          }
          return await this.embedImageFile(convertedPath, runtime);
        } catch (conversionError) {
          if (conversionError instanceof EmbeddingProcessError || heifFirst)
            throw conversionError;
          if (conversionError instanceof UnreadableImageError)
            throw conversionError;
          const originalMessage =
            originalError instanceof Error
              ? originalError.message
              : "Image decoding failed.";
          const conversionMessage =
            conversionError instanceof Error
              ? conversionError.message
              : "macOS image conversion failed.";
          throw new Error(
            `${originalMessage} (macOS fallback: ${conversionMessage})`,
          );
        } finally {
          await fsPromises.rm(temporaryDirectory, {
            recursive: true,
            force: true,
          });
        }
      }
    });
  }

  private async embedImageFile(filePath: string, runtime: ClipRuntime) {
    if (runtime.worker)
      return this.normalize(
        await this.requestWorkerEmbedding("image", { filePath }, runtime.child),
      );
    const image = await runtime.RawImage!.read(filePath);
    const inputs = await runtime.processor!(image);
    const output = await runtime.visionModel!(inputs);
    return this.normalize(output.image_embeds.data);
  }

  private ensureEmbeddingWorker() {
    if (this.embeddingWorker) return this.embeddingWorker;
    // worker_threads cannot contain Sharp/libvips/ONNX native crashes.
    const worker = fork(path.join(__dirname, "semanticWorker.js"), [], {
      execPath: process.execPath,
      execArgv: [],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        SEMANTIC_MODEL_CACHE_PATH: this.modelCachePath,
        OMP_NUM_THREADS: "2",
        OPENBLAS_NUM_THREADS: "2",
        MKL_NUM_THREADS: "2",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    });
    this.embeddingWorker = worker;
    let stderrTail = "";
    let disconnectTimer: NodeJS.Timeout | undefined;
    // Only native stderr, never request payloads, image contents or environment.
    worker.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    worker.on("spawn", () => this.onDiagnostic("semantic-worker-online"));
    worker.on("message", (message: any) => {
      if (this.embeddingWorker !== worker || !message) return;
      if (message.type === "diagnostic") {
        if (
          message.event === "semantic-worker-preload-phase" &&
          ["preload", "text", "image"].includes(message.requestType) &&
          typeof message.phase === "string" &&
          ["started", "completed", "failed"].includes(message.status)
        ) {
          this.onDiagnostic("semantic-worker-preload-phase", {
            requestType: message.requestType,
            phase: message.phase.slice(0, 120),
            status: message.status,
            ...(Number.isFinite(message.durationMs)
              ? { durationMs: Math.max(0, Math.min(600_000, message.durationMs)) }
              : {}),
          });
        }
        return;
      }
      if (!Number.isInteger(message.id)) return;
      const request = this.embeddingRequests.get(message.id);
      if (!request) return;
      this.embeddingRequests.delete(message.id);
      if (request.timer) clearTimeout(request.timer);
      if (request.timeoutTimer) clearTimeout(request.timeoutTimer);
      if (typeof message.error === "string") {
        const diagnosticMessage = sanitizeWorkerDiagnosticText(
          message.error,
          1200,
        );
        const phase = sanitizeWorkerDiagnosticText(message.phase, 120);
        const stack = sanitizeWorkerDiagnosticStack(message.stack, 1800);
        // A bad file is recorded on its index row; logging each one would bury
        // real worker and renderer events in crash diagnostics.
        if (
          message.infrastructure ||
          request.type !== "image" ||
          !isPermanentImageFailure(diagnosticMessage)
        )
          this.onDiagnostic("semantic-worker-request-failed", {
            requestType: request.type,
            infrastructure: Boolean(message.infrastructure),
            ...(diagnosticMessage ? { message: diagnosticMessage } : {}),
            ...(phase ? { phase } : {}),
            ...(stack ? { stack } : {}),
          });
        const error =
          message.infrastructure || request.type === "preload"
            ? new EmbeddingProcessError(
                `Semantic model initialization failed: ${diagnosticMessage ?? "Worker initialization failed."}`,
              )
            : new Error(diagnosticMessage ?? "Semantic worker request failed.");
        request.reject(error);
        if (error instanceof EmbeddingProcessError)
          this.failEmbeddingWorker(worker, error);
      } else if (
        Array.isArray(message.values) &&
        message.values.length ===
          (request.type === "preload" ? 0 : VECTOR_SIZE) &&
        message.values.every(
          (value: unknown) =>
            typeof value === "number" && Number.isFinite(value),
        )
      ) {
        request.resolve(message.values);
      } else {
        const error = new EmbeddingProcessError(
          "Invalid semantic embedding response.",
        );
        request.reject(error);
        this.failEmbeddingWorker(worker, error);
      }
    });
    worker.on("error", () => {
      if (this.embeddingWorker !== worker) return;
      this.onDiagnostic("semantic-worker-error", {
        pendingCount: this.embeddingRequests.size,
      });
      this.failEmbeddingWorker(
        worker,
        new EmbeddingProcessError("Semantic embedding process failed."),
      );
    });
    worker.on("exit", (code, signal) => {
      if (disconnectTimer) clearTimeout(disconnectTimer);
      const pending =
        this.embeddingWorker === worker
          ? [...this.embeddingRequests.values()]
          : [];
      this.onDiagnostic("semantic-worker-exit", {
        code,
        signal,
        stderr: stderrTail
          .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "[path]")
          .slice(-2000),
        ...(this.embeddingExitDetails.get(worker) ?? {
          pendingCount: pending.length,
          requestTypes: [...new Set(pending.map((request) => request.type))],
        }),
      });
      this.failEmbeddingWorker(
        worker,
        new EmbeddingProcessError(
          `Semantic embedding process exited (${signal ?? code}).`,
          (signal !== null || (code !== null && code !== 0)) &&
            pending.some((request) => request.type === "image"),
        ),
      );
    });
    worker.on("disconnect", () => {
      if (this.embeddingWorker !== worker) return;
      // Native crashes commonly disconnect IPC just before exit reports SIGTRAP.
      // Give exit a bounded grace period rather than replacing its signal.
      disconnectTimer = setTimeout(() => {
        this.failEmbeddingWorker(
          worker,
          new EmbeddingProcessError(
            "Semantic embedding IPC disconnected without an exit report.",
          ),
        );
      }, 250);
    });
    return worker;
  }

  private failEmbeddingWorker(
    worker: ChildProcess,
    error: EmbeddingProcessError,
  ) {
    if (this.embeddingWorker !== worker) return;
    const diagnosticReason = error.message
      .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "[path]")
      .slice(0, 1200);
    const previousExitDetails = this.embeddingExitDetails.get(worker);
    this.embeddingExitDetails.set(worker, {
      pendingCount: this.embeddingRequests.size,
      requestTypes: [
        ...new Set(
          [...this.embeddingRequests.values()].map((request) => request.type),
        ),
      ],
      failureReason: diagnosticReason || previousExitDetails?.failureReason,
    });
    this.embeddingWorker = null;
    this.clipRuntime = null;
    this.clipRuntimePromise = null;
    for (const request of this.embeddingRequests.values()) {
      if (request.timer) clearTimeout(request.timer);
      if (request.timeoutTimer) clearTimeout(request.timeoutTimer);
      request.reject(error);
    }
    this.embeddingRequests.clear();
    // SIGKILL also stops a decoder hung inside native code; never auto-respawn.
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill("SIGKILL");
  }

  private requestWorkerEmbedding(
    type: "preload" | "text" | "image",
    payload: { text?: string; filePath?: string } = {},
    child?: ChildProcess,
  ): Promise<number[]> {
    const worker = child ?? this.ensureEmbeddingWorker();
    if (this.embeddingWorker !== worker || !worker.connected)
      return Promise.reject(
        new EmbeddingProcessError("Semantic embedding process is unavailable."),
      );
    const id = ++this.embeddingRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A slow model request is not a failed request: keep it pending so the
        // persisted index can continue as soon as the worker responds. In
        // particular, never kill the only semantic worker because one file
        // takes longer than expected on a slower machine.
        this.onDiagnostic("semantic-worker-slow-request", {
          requestType: type,
          pendingCount: this.embeddingRequests.size,
          thresholdMs: SLOW_EMBEDDING_REQUEST_WARNING_MS,
        });
      }, SLOW_EMBEDDING_REQUEST_WARNING_MS);
      const timeoutTimer =
        type === "preload"
          ? setTimeout(() => {
              if (
                this.embeddingWorker !== worker ||
                !this.embeddingRequests.has(id)
              )
                return;
              this.onDiagnostic("semantic-worker-request-timeout", {
                requestType: type,
                pendingCount: this.embeddingRequests.size,
                timeoutMs: SEMANTIC_PRELOAD_TIMEOUT_MS,
              });
              // A preload that never answers can otherwise keep startup search
              // readiness pending forever. Kill this worker and let recovery retry.
              this.failEmbeddingWorker(
                worker,
                new EmbeddingProcessError(
                  `Offline semantic model preload timed out after ${Math.round(SEMANTIC_PRELOAD_TIMEOUT_MS / 60000)} minutes.`,
                ),
              );
            }, SEMANTIC_PRELOAD_TIMEOUT_MS)
          : null;
      this.embeddingRequests.set(id, { type, timer, timeoutTimer, resolve, reject });
      try {
        worker.send({ id, type, ...payload }, (error) => {
          if (error && worker.connected)
            this.failEmbeddingWorker(
              worker,
              new EmbeddingProcessError("Semantic embedding IPC send failed."),
            );
        });
      } catch {
        this.failEmbeddingWorker(
          worker,
          new EmbeddingProcessError("Semantic embedding IPC send failed."),
        );
      }
    });
  }

  private async embedTextFile(file: IndexableFile, runtime: ClipRuntime) {
    const text = await this.extractText(file);
    if (!text.trim()) throw new Error("No readable text found.");
    return this.embedText(`${file.name}\n${text}`, runtime);
  }

  private async extractText(file: IndexableFile) {
    const localPath = await this.resolveFilePath(file.path);
    if (file.extension === ".pdf") {
      if (file.size > 50 * 1024 * 1024)
        throw new Error("PDF is larger than 50 MB.");
      const { PDFParse } = require("pdf-parse") as any;
      const parser = new PDFParse({
        data: await fsPromises.readFile(localPath),
      });
      try {
        const result = await parser.getText();
        return String(result.text || "").slice(0, 8000);
      } finally {
        await parser.destroy();
      }
    }
    if (!plainTextExtensions.has(file.extension))
      throw new Error("Document format is not text-readable.");
    const handle = await fsPromises.open(localPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(file.size, 256 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .replace(/\0/g, " ")
        .slice(0, 8000);
    } finally {
      await handle.close();
    }
  }

  private isSearchRecordIndexable(record: IndexRecord) {
    const sourcePath = record.sourcePath;
    const canonicalSourcePath =
      this.canonicalSourcePaths.get(sourcePath) ?? path.resolve(sourcePath);
    const exclusionRevision = getIndexStorageExclusionRevision();
    const cached = this.searchIndexabilityCache.get(record);
    if (
      cached &&
      cached.path === record.path &&
      cached.sourcePath === sourcePath &&
      cached.type === record.type &&
      cached.extension === record.extension &&
      cached.canonicalSourcePath === canonicalSourcePath &&
      cached.canonicalUserDataPath === this.canonicalUserDataPath &&
      cached.exclusionRevision === exclusionRevision
    )
      return cached.value;

    const value = this.isIndexable(record, sourcePath);
    this.searchIndexabilityCache.set(record, {
      path: record.path,
      sourcePath,
      type: record.type,
      extension: record.extension,
      canonicalSourcePath,
      canonicalUserDataPath: this.canonicalUserDataPath,
      exclusionRevision,
      value,
    });
    return value;
  }

  private isIndexable(
    file: Pick<IndexableFile, "path" | "type" | "extension"> & { isDirectory?: boolean },
    sourcePath = "",
  ) {
    if (isPathWithin(file.path, this.indexStorageRoot)) return false;
    if (
      sourcePath &&
      isAppDataPath(
        file.path,
        sourcePath,
        this.canonicalSourcePaths.get(sourcePath) ?? path.resolve(sourcePath),
        this.userDataPath,
        this.canonicalUserDataPath,
      )
    )
      return false;
    if (file.isDirectory) return false;
    if (isPhoneDerivativePath(file.path) || isNonLibraryPath(file.path)) return false;
    if (file.type === "image") return true;
    return (
      file.type === "document" &&
      (file.extension === ".pdf" || plainTextExtensions.has(file.extension))
    );
  }

  private inferType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    if (imageExtensions.has(extension)) return "image";
    if (extension === ".pdf" || plainTextExtensions.has(extension))
      return "document";
    return "other";
  }

  private shouldRetryFailure(record: IndexRecord): boolean {
    const failure = this.workerFailures.get(record.path);
    if (
      record.error &&
      failure?.signature === record.signature &&
      failure.attempts >= 3
    )
      return false;
    // Unchanged files the decoder rejected stay parked; a new signature
    // (the file was repaired or replaced) re-queues them through discovery.
    if (
      record.vectorOffset < 0 &&
      record.type === "image" &&
      isPermanentImageFailure(record.error)
    )
      return false;
    // A persisted record without a vector is either a saved failure or an
    // interrupted/incomplete entry. Retry incomplete entries even if crash
    // recovery state is present; only a recorded, capped failure stays parked.
    return record.vectorOffset < 0;
  }

  private signature(file: IndexableFile) {
    return `${file.size}:${file.modified}`;
  }

  private async loadWorkerRecovery() {
    try {
      const entries = JSON.parse(
        await fsPromises.readFile(
          path.join(this.indexDirectory, "worker-failures.json"),
          "utf8",
        ),
      );
      for (const [filePath, failure] of entries) {
        if (
          typeof filePath === "string" &&
          typeof failure?.signature === "string" &&
          Number.isInteger(failure.attempts) &&
          failure.attempts >= 1 &&
          failure.attempts <= 3 &&
          typeof failure.message === "string" &&
          Number.isFinite(failure.timestamp)
        ) {
          this.workerFailures.set(filePath, failure);
        }
      }
    } catch {
      /* Missing or invalid recovery state is not a file failure. */
    }
    try {
      const saved = JSON.parse(
        await fsPromises.readFile(
          path.join(this.indexDirectory, "pending-work.json"),
          "utf8",
        ),
      );
      const entries: Map<string, string> = new Map();
      for (const entry of saved.entries ?? []) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          entry.every((value) => typeof value === "string" && value.trim())
        )
          entries.set(entry[0], entry[1]);
      }
      if (entries.size) this.filesToIndex = entries;
      this.restoredSourcePaths = Array.from(
        new Set([
          ...(Array.isArray(saved.sources)
            ? saved.sources.filter(
                (root: unknown) => typeof root === "string" && root.trim(),
              )
            : []),
          ...entries.values(),
        ]),
      );
      this.pendingCheckpoint = true;
      this.pendingWorkMutationVersion = 1;
      this.pendingWorkSnapshotVersion = 1;
      this.pendingWorkCheckpointAt = Date.now();
    } catch {
      /* No interrupted queue to restore. */
    }
  }

  private async writeRecoveryFile(name: string, value: unknown) {
    const snapshot = JSON.stringify(value);
    const task = this.recoveryFileWriteChain.then(async () => {
      await fsPromises.mkdir(this.indexDirectory, { recursive: true });
      const target = path.join(this.indexDirectory, name);
      const temporaryPath = `${target}.${process.pid}.${++this.recoveryFileWriteSequence}.tmp`;
      try {
        await fsPromises.writeFile(temporaryPath, snapshot, "utf8");
        await fsPromises.rename(temporaryPath, target);
      } catch (error) {
        await fsPromises.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    this.recoveryFileWriteChain = task.catch(() => undefined);
    await task;
  }

  private persistWorkerFailures() {
    return this.writeRecoveryFile(
      "worker-failures.json",
      Array.from(this.workerFailures),
    );
  }

  private async checkpointPendingWork(
    sources: string[],
    force = false,
  ): Promise<void> {
    if (force) this.pendingCheckpoint = true;
    const checkpointDue =
      Date.now() - this.pendingWorkCheckpointAt >=
      PENDING_WORK_CHECKPOINT_INTERVAL_MS;
    if (
      !force &&
      (!this.pendingCheckpoint ||
        this.pendingWorkSnapshotVersion === this.pendingWorkMutationVersion ||
        !checkpointDue)
    )
      return;

    if (this.pendingWorkCheckpointPromise) {
      const inFlight = this.pendingWorkCheckpointPromise;
      if (!force) return inFlight;
      await inFlight;
      if (this.pendingWorkSnapshotVersion === this.pendingWorkMutationVersion)
        return;
      return this.checkpointPendingWork(sources, true);
    }

    const operation = Promise.resolve().then(async () => {
      do {
        const snapshotVersion = this.pendingWorkMutationVersion;
        await this.writePendingWorkCheckpoint(sources, this.filesToIndex);
        this.pendingWorkSnapshotVersion = snapshotVersion;
        this.pendingWorkCheckpointAt = Date.now();
      } while (
        force &&
        this.pendingWorkSnapshotVersion !== this.pendingWorkMutationVersion
      );
    });
    this.pendingWorkCheckpointPromise = operation;
    try {
      await operation;
    } finally {
      if (this.pendingWorkCheckpointPromise === operation)
        this.pendingWorkCheckpointPromise = null;
    }
  }

  /** Stream bounded chunks so a large saved queue never needs one giant stringify. */
  private async writePendingWorkCheckpoint(
    sources: string[],
    entries: Map<string, string> | null,
  ) {
    const task = this.recoveryFileWriteChain.then(async () => {
      await fsPromises.mkdir(this.indexDirectory, { recursive: true });
      const target = path.join(this.indexDirectory, "pending-work.json");
      const temporaryPath = `${target}.${process.pid}.${++this.recoveryFileWriteSequence}.tmp`;
      let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
      try {
        handle = await fsPromises.open(temporaryPath, "w");
        await handle.writeFile('{"version":1,"entries":[', "utf8");
        const roots = new Set([
          ...sources,
          ...(this.queuedSourcePaths ?? []),
        ]);
        let batch: Array<[string, string]> = [];
        let wroteEntries = false;
        const writeBatch = async () => {
          if (!batch.length) return;
          const serialized = JSON.stringify(batch);
          await handle!.writeFile(
            `${wroteEntries ? "," : ""}${serialized.slice(1, -1)}`,
            "utf8",
          );
          wroteEntries = true;
          batch = [];
        };
        for (const entry of entries ?? []) {
          batch.push(entry);
          roots.add(entry[1]);
          if (batch.length >= 256) await writeBatch();
        }
        await writeBatch();
        await handle.writeFile(
          `],"sources":${JSON.stringify(Array.from(roots))}}`,
          "utf8",
        );
        await handle.sync();
        await handle.close();
        handle = null;
        await fsPromises.rename(temporaryPath, target);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await fsPromises.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    this.recoveryFileWriteChain = task.catch(() => undefined);
    await task;
  }

  private normalize(values: Iterable<number>) {
    const vector = Float32Array.from(values);
    if (vector.length !== VECTOR_SIZE)
      throw new Error(`Unexpected embedding size: ${vector.length}`);
    let squaredLength = 0;
    for (const value of vector) squaredLength += value * value;
    const length = Math.sqrt(squaredLength) || 1;
    for (let index = 0; index < vector.length; index += 1)
      vector[index] /= length;
    return vector;
  }

  /**
   * Every index write goes through one chain: concurrent appends raced for the same
   * vector offset, and a kill mid-line glued the next record onto a partial one.
   */
  private appendLines(lines: string[]): Promise<void> {
    if (!lines.length) return this.writeChain;
    return this.serializeWrite(async () => {
      await this.ensureRecordsLineBoundary();
      await fsPromises.appendFile(this.recordsPath, `${lines.join("\n")}\n`);
    });
  }

  private serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const task = this.writeChain.then(write, write);
    this.writeChain = task.then(() => undefined, () => undefined);
    return task;
  }

  /** A partial line left by a crash is isolated so it can never swallow the next record. */
  private async ensureRecordsLineBoundary() {
    if (this.recordsBoundaryChecked) return;
    this.recordsBoundaryChecked = true;
    const handle = await fsPromises.open(this.recordsPath, "r").catch(() => null);
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) await fsPromises.appendFile(this.recordsPath, "\n");
    } finally {
      await handle.close();
    }
  }

  /** Resolves once queued index writes are on disk; used before quitting. */
  flushWrites(): Promise<void> {
    return this.writeChain;
  }

  private async appendRecord(
    file: IndexableFile,
    sourcePath: string,
    vector: Float32Array,
  ) {
    const record = await this.serializeWrite(async () => {
      await this.ensureRecordsLineBoundary();
      const vectorHandle = await fsPromises.open(this.vectorsPath, "a");
      let vectorOffset = 0;
      try {
        vectorOffset = (await vectorHandle.stat()).size;
        const vectorBuffer = Buffer.from(
          vector.buffer,
          vector.byteOffset,
          vector.byteLength,
        );
        await vectorHandle.write(vectorBuffer, 0, vectorBuffer.length, null);
        await vectorHandle.sync();
      } finally {
        await vectorHandle.close();
      }
      const created = this.createRecord(file, sourcePath, vectorOffset);
      await fsPromises.appendFile(this.recordsPath, `${JSON.stringify(created)}\n`);
      return created;
    });
    this.setLatestRecord(record);
  }

  private async appendFailure(
    file: IndexableFile,
    sourcePath: string,
    error: string,
  ) {
    const record = { ...this.createRecord(file, sourcePath, -1), error };
    await this.appendLines([JSON.stringify(record)]);
    this.setLatestRecord(record);
  }

  private createRecord(
    file: IndexableFile,
    sourcePath: string,
    vectorOffset: number,
  ): IndexRecord {
    return {
      path: file.path,
      name: file.name,
      sourcePath,
      relativePath: path.relative(sourcePath, file.path),
      size: file.size,
      modified: file.modified,
      type: file.type,
      extension: file.extension,
      signature: this.signature(file),
      vectorOffset,
    };
  }

  private async loadRecords(onLoadProgress?: SemanticIndexLoadProgress) {
    let highestVectorEnd = 0;
    let recordCount = 0;
    const typeCount: Record<string, number> = {};
    const canonicalRoots = new Map<string, string>();
    const excludedPaths = new Set<string>();
    let corruptLines = 0;
    let journalRowsRead = 0;
    // Directory-level memo: per-file checks re-read marker files for every ancestor.
    const cloneChecks = new Map<string, Promise<boolean>>();
    const inClone = (directory: string, root: string): Promise<boolean> => {
      const key = `${root}\0${directory}`;
      let check = cloneChecks.get(key);
      if (!check) {
        check = (async () => {
          if (!isPathWithin(directory, root)) return false;
          if (await isSiloCloneDirectory(directory)) return true;
          const parent = path.dirname(directory);
          return directory !== path.resolve(root) && parent !== directory && inClone(parent, root);
        })();
        cloneChecks.set(key, check);
      }
      return check;
    };
    // offset -> path: an offset claimed twice means the earlier record's vector was overwritten.
    const offsetOwners = new Map<number, string>();

    try {
      // Stream the file instead of loading it all into memory to avoid OOM with large indexes
      const readline = require("readline") as any;
      let recordsStats = await fsPromises.stat(this.recordsPath).catch(() => null);
      if (!recordsStats) {
        // Establish the journal before creating a stream. Starting a read stream
        // for a missing file can emit ENOENT before readline has attached its
        // error listener during a fresh profile's first startup.
        await fsPromises.writeFile(this.recordsPath, "", { flag: "a" });
        recordsStats = await fsPromises.stat(this.recordsPath);
      }
      const totalBytes = recordsStats.size;
      const journalReadProgressShare = 0.7;
      onLoadProgress?.(0, this.latestRecords.size, "reading", 0);
      const fileStream = fs.createReadStream(this.recordsPath);
      let lastReport = 0;
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (onLoadProgress && totalBytes && Date.now() - lastReport > 500) {
          lastReport = Date.now();
          const readFraction = totalBytes
            ? Math.min(1, fileStream.bytesRead / totalBytes)
            : 0;
          onLoadProgress(
            readFraction * journalReadProgressShare,
            this.latestRecords.size,
            "reading",
            readFraction,
          );
        }
        if (!line.trim()) continue;
        journalRowsRead += 1;
        try {
          let record: IndexRecord & { deleted?: boolean };
          try {
            record = JSON.parse(line);
          } catch {
            // A crash mid-write leaves a partial line; a later record may be glued onto it.
            corruptLines += 1;
            const glued = line.lastIndexOf('{"path":');
            if (glued <= 0) continue;
            record = JSON.parse(line.slice(glued));
          }
          if (record.deleted) {
            if (typeof record.path === "string")
              this.latestRecords.delete(record.path);
            continue;
          }
          if (typeof record.path !== "string" || typeof record.sourcePath !== "string")
            continue;
          // Collapse append-only history first. Validating paths, probing clone
          // markers, and rebuilding text postings for every old version made
          // large journals spend minutes doing work on records that are
          // immediately superseded by a later row.
          this.latestRecords.delete(record.path);
          this.latestRecords.set(record.path, record);
        } catch {
          corruptLines += 1;
        }
      }

      if (totalBytes > 0)
        onLoadProgress?.(
          journalReadProgressShare,
          this.latestRecords.size,
          "validating",
          0,
        );

      // Validate in place so startup does not allocate a second large Map.
      const replayedRecords = this.latestRecords;
      this.onDiagnostic("semantic-record-history-collapsed", {
        journalRowsRead,
        recordsToValidate: replayedRecords.size,
      });
      let lastValidationReport = Date.now();
      let validatedRows = 0;
      const recordsToValidate = replayedRecords.size;
      for (const record of replayedRecords.values()) {
        let accepted = false;
        try {
          // Legacy records from software trees stay on disk but are never held
          // in memory. Check only their final version after history collapse.
          if (isNonLibraryPath(record.path)) continue;
          let canonicalRoot = canonicalRoots.get(record.sourcePath);
          if (!canonicalRoot) {
            canonicalRoot = this.isRemotePath(record.sourcePath)
              ? record.sourcePath
              : await fsPromises
                  .realpath(record.sourcePath)
                  .catch(() => path.resolve(record.sourcePath));
            canonicalRoots.set(record.sourcePath, canonicalRoot);
            this.canonicalSourcePaths.set(record.sourcePath, canonicalRoot);
          }
          if (
            isAppDataPath(
              record.path,
              record.sourcePath,
              canonicalRoot,
              this.userDataPath,
              this.canonicalUserDataPath,
            )
          ) {
            excludedPaths.add(record.path);
            this.sourcesWithExcludedRecords.add(record.sourcePath);
            continue;
          }
          if (
            !this.isRemotePath(record.sourcePath) &&
            await inClone(path.dirname(path.resolve(record.path)), record.sourcePath)
          ) {
            excludedPaths.add(record.path);
            this.sourcesWithExcludedRecords.add(record.sourcePath);
            continue;
          }
          if (record.vectorOffset >= 0) {
            const previousOwner = offsetOwners.get(record.vectorOffset);
            if (
              previousOwner !== undefined &&
              previousOwner !== record.path &&
              this.latestRecords.get(previousOwner)?.vectorOffset === record.vectorOffset
            )
              this.deleteLatestRecord(previousOwner);
            offsetOwners.set(record.vectorOffset, record.path);
          }
          this.setLatestRecord(record, false);
          accepted = true;
          recordCount += 1;
          typeCount[record.type] = (typeCount[record.type] || 0) + 1;
          if (record.vectorOffset >= 0)
            highestVectorEnd = Math.max(
              highestVectorEnd,
              record.vectorOffset + VECTOR_BYTES,
            );
        } catch {
          corruptLines += 1;
        } finally {
          if (!accepted) replayedRecords.delete(record.path);
          validatedRows += 1;
          if (validatedRows % 256 === 0)
            await new Promise<void>((resolve) => setImmediate(resolve));
          if (
            onLoadProgress &&
            (Date.now() - lastValidationReport > 500 ||
              validatedRows === recordsToValidate)
          ) {
            lastValidationReport = Date.now();
            const validationFraction = recordsToValidate
              ? validatedRows / recordsToValidate
              : 1;
            onLoadProgress(
              journalReadProgressShare +
                (1 - journalReadProgressShare) * validationFraction,
              recordCount,
              "validating",
              validationFraction,
            );
          }
        }
      }
      onLoadProgress?.(1, recordCount, "finalizing", null);
      cloneChecks.clear();
      offsetOwners.clear();
      console.log(`[INDEXER] Loaded ${recordCount} records:`, typeCount);
      if (corruptLines) this.onDiagnostic("semantic-records-corrupt-lines-skipped", { lines: corruptLines });
      if (excludedPaths.size > 0) {
        const paths = Array.from(excludedPaths);
        for (let index = 0; index < paths.length; index += 1000) {
          await this.appendLines(
            paths.slice(index, index + 1000).map((filePath) => JSON.stringify({ path: filePath, deleted: true })),
          );
        }
        this.onDiagnostic("semantic-internal-records-pruned", {
          records: excludedPaths.size,
        });
      }
    } catch (error) {
      // File doesn't exist yet, create empty one
      if ((error as any).code === "ENOENT") {
        await fsPromises.writeFile(this.recordsPath, "");
      }
    }
    try {
      const stats = await fsPromises.stat(this.vectorsPath);
      // Only a torn trailing vector is trimmed; truncating to the highest loaded offset
      // once destroyed vectors whose records sat beyond an unreadable line.
      const whole = stats.size - (stats.size % VECTOR_BYTES);
      if (whole < stats.size) await fsPromises.truncate(this.vectorsPath, whole);
      if (highestVectorEnd > whole) {
        // Records pointing past the file lost their vectors; drop them so they re-embed once.
        let lost = 0;
        for (const [filePath, record] of this.latestRecords)
          if (record.vectorOffset >= 0 && record.vectorOffset + VECTOR_BYTES > whole) {
            this.deleteLatestRecord(filePath);
            lost += 1;
          }
        this.onDiagnostic("semantic-records-missing-vectors", { records: lost });
      }
    } catch {
      await fsPromises.writeFile(this.vectorsPath, Buffer.alloc(0));
    }
    onLoadProgress?.(1, recordCount, "finalizing", null);
  }

  private async updateProgress(
    update: Partial<IndexProgress>,
    persist: boolean,
  ) {
    this.progress = { ...this.progress, ...update };
    this.emitProgress();
    if (persist) await this.persistProgress();
  }

  private emitProgress() {
    this.onProgress(this.getProgress());
  }

  private async persistProgress() {
    const temporaryPath = `${this.progressPath}.tmp`;
    await fsPromises.writeFile(
      temporaryPath,
      JSON.stringify(this.getProgress(), null, 2),
    );
    await fsPromises.rename(temporaryPath, this.progressPath);
  }
}
