import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import * as readline from "readline";
import { PersistedVectorIndex, type VectorSearchGroup } from "./persistedVectorIndex";
import type { SearchPerformanceSettings } from "./contentSettings";
import { defaultSearchPerformanceSettings } from "./contentSettings";
import type { IndexerGovernor } from "./indexerGovernor";
import type { IndexableFile, IndexProgress, SourceScanCheckpoint, SearchResult } from "./semanticIndexer";

const VECTOR_SIZE = 512;
const VECTOR_BYTES = VECTOR_SIZE * Float32Array.BYTES_PER_ELEMENT;
const VIDEO_EXTENSIONS = new Set([
  ".3g2", ".3gp", ".avi", ".f4v", ".flv", ".m2t", ".m2ts", ".m2v",
  ".m4v", ".mkv", ".mov", ".mp2v", ".mp4", ".mpe", ".mpeg", ".mpg",
  ".mts", ".mxf", ".ogv", ".qt", ".ts", ".vob", ".webm", ".wmv",
]);
const MAX_PENDING_FILES = 10_000;
const MAX_SEARCH_RESULTS = 500;
const INITIAL_PROGRESS: IndexProgress = {
  status: "idle", total: 0, indexed: 0, remaining: 0, queuedRemaining: 0,
  errors: 0, currentFile: null, message: "Video semantic indexing has not run yet.",
};

type ScanSource = (
  sourcePath: string,
  onFile: (file: IndexableFile) => void,
  isCancelled: () => boolean,
  shouldPauseForSearch?: () => boolean,
  checkpoint?: SourceScanCheckpoint,
) => Promise<void>;
type VideoRecord = {
  path: string;
  sourcePath: string;
  name: string;
  relativePath: string;
  size: number;
  modified: number;
  extension: string;
  signature: string;
  vectorOffset: number;
  attempts: number;
  error?: string;
  lastSeenRun?: string;
};
type PendingVideo = { sourcePath: string; version: number };
type Diagnostic = (event: string, details?: Record<string, unknown>) => void;
type ProgressListener = (progress: IndexProgress) => void;

type FfmpegResult = { code: number | null; stderr: string };

export function isSemanticVideo(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function resolveFfmpegPath(): string {
  const packagedPath = require("ffmpeg-static") as string | null;
  if (!packagedPath) throw new Error("Silo's bundled video decoder is unavailable.");
  const unpackedPath = packagedPath.includes(`${path.sep}app.asar${path.sep}`)
    ? packagedPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : packagedPath;
  const candidate = fs.existsSync(unpackedPath) ? unpackedPath : packagedPath;
  if (!fs.existsSync(candidate)) throw new Error("Silo's bundled video decoder is missing.");
  return candidate;
}

function runFfmpeg(
  binary: string,
  args: string[],
  timeoutMs: number,
  isCancelled: () => boolean = () => false,
): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = "";
    let settled = false;
    let cancelled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancelCheck);
      reject(error);
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2 * 1024 * 1024);
    });
    child.once("error", (error) => finishError(error));
    const timeout = setTimeout(() => {
      child.kill();
      finishError(new Error("Video decoding exceeded the time limit."));
    }, timeoutMs);
    const cancelCheck = setInterval(() => {
      if (!isCancelled() || cancelled) return;
      cancelled = true;
      child.kill();
      finishError(new Error("Video indexing was paused."));
    }, 200);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancelCheck);
      resolve({ code, stderr });
    });
  });
}

async function readVideoDuration(binary: string, filePath: string, isCancelled: () => boolean) {
  const probe = await runFfmpeg(
    binary,
    ["-hide_banner", "-protocol_whitelist", "file,pipe,crypto,data", "-i", filePath],
    30_000,
    isCancelled,
  );
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(probe.stderr);
  if (!match) throw new Error("Video duration is unavailable; midpoint frame was not indexed.");
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Video duration is invalid; midpoint frame was not indexed.");
  return duration;
}

/** Extract exactly one resized still from the midpoint of a video's duration. */
export async function extractMidpointFrame(
  filePath: string,
  destinationPath: string,
  options: { ffmpegPath?: string; isCancelled?: () => boolean } = {},
): Promise<void> {
  const binary = options.ffmpegPath ?? resolveFfmpegPath();
  const isCancelled = options.isCancelled ?? (() => false);
  const duration = await readVideoDuration(binary, filePath, isCancelled);
  const result = await runFfmpeg(
    binary,
    [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-protocol_whitelist", "file,pipe,crypto,data",
      "-ss", String(duration / 2), "-i", filePath,
      "-map", "0:v:0", "-frames:v", "1",
      "-vf", "scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease",
      "-f", "image2", "-vcodec", "mjpeg", "-q:v", "4", destinationPath,
    ],
    120_000,
    isCancelled,
  );
  if (result.code !== 0) throw new Error("The midpoint frame could not be decoded from this video.");
  const stats = await fsPromises.stat(destinationPath).catch(() => null);
  if (!stats?.isFile() || stats.size === 0)
    throw new Error("The video decoder did not produce a midpoint still.");
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "[path]").slice(0, 500) || "Video indexing failed.";
}

function isVideoLikeFile(file: IndexableFile) {
  return !file.isDirectory && isSemanticVideo(file.path);
}

export class VideoSemanticIndexer {
  private readonly directory: string;
  private readonly recordsPath: string;
  private readonly vectorsPath: string;
  private readonly pendingPath: string;
  private readonly progressPath: string;
  private readonly scanSource: ScanSource;
  private readonly embedFrame: (framePath: string) => Promise<Float32Array>;
  private readonly embedPrompts: (prompts: string[]) => Promise<Float32Array[]>;
  private readonly resolveFilePath: (filePath: string) => Promise<string>;
  private readonly onDiagnostic: Diagnostic;
  private readonly onProgress: ProgressListener;
  private readonly ffmpegPath?: string;
  private readonly governor: IndexerGovernor | null;
  private performanceSettings: SearchPerformanceSettings = defaultSearchPerformanceSettings();
  private records = new Map<string, VideoRecord>();
  private recordsByVectorKey = new Map<number, VideoRecord>();
  private pendingRoots = new Set<string>();
  private pendingFiles = new Map<string, PendingVideo>();
  private nextPendingVersion = 0;
  private vectorIndex: PersistedVectorIndex | null = null;
  private vectorIndexFailed = false;
  private loaded = false;
  private runPromise: Promise<void> | null = null;
  private pauseRequested = false;
  private progress: IndexProgress = { ...INITIAL_PROGRESS };
  private activeSearches = 0;
  private runVersion = 0;
  private persistPendingPromise: Promise<void> = Promise.resolve();
  private persistProgressPromise: Promise<void> = Promise.resolve();
  private lastProgressPersistAt = 0;

  constructor(options: {
    storageRoot: string;
    scanSource: ScanSource;
    embedFrame: (framePath: string) => Promise<Float32Array>;
    embedPrompts: (prompts: string[]) => Promise<Float32Array[]>;
    resolveFilePath?: (filePath: string) => Promise<string>;
    onDiagnostic?: Diagnostic;
    onProgress?: ProgressListener;
    ffmpegPath?: string;
    governor?: IndexerGovernor | null;
  }) {
    this.directory = path.join(path.resolve(options.storageRoot), "semantic-index", "videos");
    this.recordsPath = path.join(this.directory, "records.jsonl");
    this.vectorsPath = path.join(this.directory, "vectors.bin");
    this.pendingPath = path.join(this.directory, "pending.json");
    this.progressPath = path.join(this.directory, "progress.json");
    this.scanSource = options.scanSource;
    this.embedFrame = options.embedFrame;
    this.embedPrompts = options.embedPrompts;
    this.resolveFilePath = options.resolveFilePath ?? (async (value) => value);
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.onProgress = options.onProgress ?? (() => undefined);
    this.ffmpegPath = options.ffmpegPath;
    this.governor = options.governor ?? null;
  }

  setPerformanceSettings(settings: SearchPerformanceSettings) {
    this.performanceSettings = { ...settings };
    this.vectorIndex?.updateSettings(this.performanceSettings);
  }

  async initialize() {
    await fsPromises.mkdir(this.directory, { recursive: true });
    await this.loadRecords();
    try {
      const saved = JSON.parse(await fsPromises.readFile(this.pendingPath, "utf8"));
      if (saved?.version === 1) {
        for (const root of Array.isArray(saved.roots) ? saved.roots : [])
          if (typeof root === "string" && root.trim()) this.pendingRoots.add(root);
        for (const entry of Array.isArray(saved.files) ? saved.files : []) {
          if (typeof entry?.path !== "string" || typeof entry?.sourcePath !== "string") continue;
          const version = Number.isSafeInteger(entry.version) ? entry.version : ++this.nextPendingVersion;
          this.nextPendingVersion = Math.max(this.nextPendingVersion, version);
          this.pendingFiles.set(entry.path, { sourcePath: entry.sourcePath, version });
        }
      }
    } catch {
      // A missing or partial queue is recovered by a fresh source walk.
    }
    try {
      const saved = JSON.parse(await fsPromises.readFile(this.progressPath, "utf8"));
      if (saved && typeof saved.status === "string") {
        this.progress = { ...INITIAL_PROGRESS, ...saved };
        if (["scanning", "loading-model", "indexing"].includes(this.progress.status)) {
          this.progress.status = "paused";
          this.progress.currentFile = null;
          this.progress.message = "Video indexing was interrupted; saved work will resume automatically.";
        }
      }
    } catch {
      // The records and pending queue are the authoritative recovery state.
    }
    this.loaded = true;
    await this.buildVectorSearch();
  }

  getProgress(): IndexProgress {
    return { ...this.progress, queuedRemaining: this.pendingFiles.size + this.pendingRoots.size };
  }

  getIndexedVideoCount(sourcePaths?: string[]) {
    const roots = sourcePaths ? new Set(sourcePaths) : null;
    let count = 0;
    for (const record of this.records.values())
      if (record.vectorOffset >= 0 && (!roots || roots.has(record.sourcePath))) count += 1;
    return count;
  }

  hasRecord(filePath: string) { return this.records.has(filePath); }

  async queueChangedFile(filePath: string, sourcePath: string) {
    if (!this.loaded || !sourcePath) return;
    const isIndexedVideo = this.records.has(filePath);
    if (!isSemanticVideo(filePath) && !isIndexedVideo) return;
    const virtualSource = /^\/(?:__phone__|__phone_backup__|__cloud__)\//.test(sourcePath);
    if (virtualSource) {
      await this.queueSourceRoots([sourcePath]);
      return;
    }
    this.nextPendingVersion += 1;
    this.pendingFiles.set(filePath, { sourcePath, version: this.nextPendingVersion });
    if (this.pendingFiles.size > MAX_PENDING_FILES) {
      const roots = new Set([...this.pendingFiles.values()].map((entry) => entry.sourcePath));
      roots.add(sourcePath);
      this.pendingFiles.clear();
      for (const root of roots) this.pendingRoots.add(root);
    }
    await this.persistPending();
  }

  async queueSourceRoots(sourcePaths: string[]) {
    for (const root of sourcePaths)
      if (typeof root === "string" && root.trim()) this.pendingRoots.add(root);
    if (this.pendingRoots.size) await this.persistPending();
  }

  start(sourcePaths: string[]): Promise<void> {
    if (!this.loaded) return Promise.reject(new Error("Video index has not been initialized."));
    if (this.runPromise) return this.runPromise;
    this.pauseRequested = false;
    let roots = Array.from(this.pendingRoots);
    let files = Array.from(this.pendingFiles, ([filePath, entry]) => ({ filePath, ...entry }));
    if (!roots.length && !files.length) roots = Array.from(new Set(sourcePaths));
    if (roots.length) {
      for (const root of roots) this.pendingRoots.add(root);
    }
    const pending = this.persistPending().then(() => this.run(roots, files)).finally(() => {
      this.runPromise = null;
      this.pauseRequested = false;
    });
    this.runPromise = pending;
    return pending;
  }

  async pause() {
    this.pauseRequested = true;
    await this.runPromise;
    this.progress.currentFile = null;
    if (["scanning", "indexing", "loading-model"].includes(this.progress.status)) {
      this.progress.status = "paused";
      this.progress.message = "Video indexing paused with its source checkpoint saved.";
      await this.persistProgress(true);
    }
  }

  async flush() {
    await this.runPromise?.catch(() => undefined);
    await Promise.all([this.persistPendingPromise, this.persistProgressPromise]);
    await this.vectorIndex?.shutdown(6500);
    this.vectorIndex = null;
  }

  async search(query: string, sourcePaths: string[], isCancelled: () => boolean = () => false): Promise<SearchResult[]> {
    if (!this.loaded || !query.trim() || !sourcePaths.length || isCancelled()) return [];
    const indexedCount = this.getIndexedVideoCount(sourcePaths);
    if (!indexedCount) return [];
    const [imageQuery] = await this.embedPrompts([`a photo of ${query.trim()}`]);
    if (isCancelled()) return [];
    this.activeSearches += 1;
    this.vectorIndex?.setPaused(true);
    try {
      let hits: Array<{ key: number; confidence: number }> = [];
      if (this.vectorIndex && !this.vectorIndexFailed) {
        try {
          const response = await this.vectorIndex.search(sourcePaths, imageQuery, imageQuery, MAX_SEARCH_RESULTS);
          hits = response.hits;
        } catch (error) {
          this.vectorIndexFailed = true;
          this.onDiagnostic("video-semantic-ann-search-failed", { message: safeError(error) });
        }
      }
      if (this.vectorIndexFailed || !this.vectorIndex)
        hits = await this.searchExact(sourcePaths, imageQuery, isCancelled);
      if (isCancelled()) return [];
      const results: SearchResult[] = [];
      for (const hit of hits) {
        const record = this.recordsByVectorKey.get(hit.key);
        if (!record || record.vectorOffset < 0 || !sourcePaths.includes(record.sourcePath)) continue;
        results.push({
          name: record.name, path: record.path, relativePath: record.relativePath,
          size: record.size, modified: record.modified, isDirectory: false,
          type: "video", extension: record.extension,
          confidence: hit.confidence,
        });
      }
      return results.sort((first, second) => second.confidence - first.confidence);
    } finally {
      this.activeSearches = Math.max(0, this.activeSearches - 1);
      if (this.activeSearches === 0) this.vectorIndex?.setPaused(false);
    }
  }

  private async run(roots: string[], files: Array<{ filePath: string; sourcePath: string; version: number }>) {
    const runId = `${Date.now()}-${++this.runVersion}`;
    let indexed = 0;
    let errors = 0;
    let total = files.length;
    const busy = () => this.pauseRequested || this.activeSearches > 0;
    try {
      await this.updateProgress({ status: "scanning", total, indexed: 0, errors: 0, remaining: 0, currentFile: null,
        message: roots.length ? `Discovering midpoint frames across ${roots.length} source${roots.length === 1 ? "" : "s"}…` : "Checking changed videos…" }, true);

      for (const sourcePath of roots) {
        if (busy()) return this.finishPaused();
        const stagingPath = path.join(this.directory, `discovery-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}.jsonl`);
        await fsPromises.writeFile(stagingPath, "", "utf8");
        let batch: string[] = [];
        const flushBatch = () => {
          if (!batch.length) return;
          fs.appendFileSync(stagingPath, `${batch.join("\n")}\n`, "utf8");
          batch = [];
        };
        await this.scanSource(sourcePath, (file) => {
          if (!isVideoLikeFile(file)) return;
          const record = this.records.get(file.path);
          if (record) record.lastSeenRun = runId;
          const signature = `${file.size}:${file.modified}`;
          if (record?.signature === signature && record.vectorOffset >= 0) return;
          if (record?.signature === signature && record.attempts >= 3) return;
          batch.push(JSON.stringify({ file, sourcePath }));
          total += 1;
          if (batch.length >= 64) flushBatch();
        }, busy, () => this.activeSearches > 0);
        flushBatch();
        if (busy()) return this.finishPaused();
        await this.updateProgress({ status: "indexing", total, message: `Indexing midpoint frames in ${path.basename(sourcePath) || "source"}…` }, true);
        const stream = fs.createReadStream(stagingPath, { encoding: "utf8" });
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
          if (busy()) { lines.close(); stream.destroy(); return this.finishPaused(); }
          if (!line) continue;
          let queued: { file: IndexableFile; sourcePath: string };
          try { queued = JSON.parse(line); } catch { continue; }
          const success = await this.indexVideo(queued.file, queued.sourcePath, busy);
          const indexedRecord = this.records.get(queued.file.path);
          if (indexedRecord) indexedRecord.lastSeenRun = runId;
          if (success) indexed += 1;
          else errors += 1;
          await this.updateProgress({
            status: "indexing", total, indexed, errors,
            remaining: Math.max(0, total - indexed - errors),
            currentFile: queued.file.name,
            message: `Indexed ${indexed.toLocaleString()} midpoint frame${indexed === 1 ? "" : "s"}${errors ? ` · ${errors.toLocaleString()} skipped` : ""}.`,
          }, false);
          if ((indexed > 0 && indexed % 10 === 0) || (errors > 0 && errors % 10 === 0))
            await this.persistPending();
          await this.paceAfterVideo(25, busy);
        }
        await fsPromises.rm(stagingPath, { force: true });
        if (busy()) return this.finishPaused();
        for (const [filePath, record] of this.records) {
          if (record.sourcePath === sourcePath && record.lastSeenRun !== runId)
            await this.deleteRecord(filePath);
          delete record.lastSeenRun;
        }
        this.pendingRoots.delete(sourcePath);
        await this.persistPending();
      }

      for (const pending of files) {
        if (busy()) return this.finishPaused();
        const current = this.pendingFiles.get(pending.filePath);
        if (!current || current.version !== pending.version) continue;
        const success = await this.indexChangedPath(pending.filePath, pending.sourcePath, busy);
        if (success) indexed += 1;
        else errors += 1;
        if (busy()) return this.finishPaused();
        if (this.pendingFiles.get(pending.filePath)?.version === pending.version)
          this.pendingFiles.delete(pending.filePath);
        await this.persistPending();
      }
      await this.updateProgress({
        status: "complete", total: Math.max(total, indexed + errors), indexed,
        errors, remaining: 0, currentFile: null,
        message: `Video midpoint index is up to date · ${this.getIndexedVideoCount().toLocaleString()} videos searchable${errors ? ` · ${errors.toLocaleString()} files skipped` : ""}.`,
      }, true);
      this.onDiagnostic("video-semantic-index-complete", { indexed, errors, roots: roots.length });
    } catch (error) {
      if (this.pauseRequested) return this.finishPaused();
      const message = safeError(error);
      await this.updateProgress({ status: "error", currentFile: null, message: `Video semantic indexing failed: ${message}` }, true);
      this.onDiagnostic("video-semantic-index-error", { message });
      throw error;
    }
  }

  private async indexChangedPath(filePath: string, sourcePath: string, isCancelled: () => boolean) {
    let stats: fs.Stats;
    let localPath: string;
    try {
      localPath = await this.resolveFilePath(filePath);
      stats = await fsPromises.stat(localPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        if (this.records.has(filePath)) await this.deleteRecord(filePath);
        return true;
      }
      throw error;
    }
    if (!stats.isFile() || !isSemanticVideo(filePath)) {
      if (this.records.has(filePath)) await this.deleteRecord(filePath);
      return true;
    }
    const file: IndexableFile = {
      name: path.basename(filePath), path: filePath, relativePath: path.relative(sourcePath, filePath),
      size: stats.size, modified: stats.mtimeMs, isDirectory: false, type: "video",
      extension: path.extname(filePath).toLowerCase(),
    };
    return this.indexVideo(file, sourcePath, isCancelled);
  }

  private async indexVideo(file: IndexableFile, sourcePath: string, isCancelled: () => boolean) {
    if (isCancelled()) return false;
    const signature = `${file.size}:${file.modified}`;
    const previous = this.records.get(file.path);
    if (previous?.signature === signature && previous.vectorOffset >= 0) return true;
    if (previous?.signature === signature && previous.attempts >= 3) return false;
    this.progress.currentFile = file.name;
    this.emitProgress();
    const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-video-midpoint-"));
    const framePath = path.join(temporaryDirectory, "midpoint.jpg");
    try {
      const localPath = await this.resolveFilePath(file.path);
      await extractMidpointFrame(localPath, framePath, { ffmpegPath: this.ffmpegPath, isCancelled });
      if (isCancelled()) return false;
      const vector = await this.embedFrame(framePath);
      if (vector.length !== VECTOR_SIZE || !Array.from(vector).every(Number.isFinite))
        throw new Error("The CLIP model returned an invalid video embedding.");
      const vectorOffset = await this.appendVector(vector);
      const record: VideoRecord = {
        path: file.path, sourcePath, name: file.name, relativePath: file.relativePath,
        size: file.size, modified: file.modified, extension: file.extension.toLowerCase(),
        signature, vectorOffset, attempts: 0,
      };
      await this.appendRecord(record);
      this.replaceRecord(record);
      return true;
    } catch (error) {
      if (isCancelled()) return false;
      const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;
      const message = safeError(error);
      const failure: VideoRecord = {
        path: file.path, sourcePath, name: file.name, relativePath: file.relativePath,
        size: file.size, modified: file.modified, extension: file.extension.toLowerCase(),
        signature, vectorOffset: -1, attempts, error: message,
      };
      await this.appendRecord(failure);
      this.replaceRecord(failure);
      this.onDiagnostic("video-semantic-file-failed", { extension: file.extension, attempts, message });
      return false;
    } finally {
      await fsPromises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async appendVector(vector: Float32Array) {
    const handle = await fsPromises.open(this.vectorsPath, "a");
    try {
      const offset = (await handle.stat()).size;
      const bytes = Buffer.from(vector.buffer, vector.byteOffset, VECTOR_BYTES);
      const { bytesWritten } = await handle.write(bytes, 0, VECTOR_BYTES, null);
      if (bytesWritten !== VECTOR_BYTES) throw new Error("The video embedding could not be saved completely.");
      await handle.sync();
      return offset;
    } finally { await handle.close(); }
  }

  private async appendRecord(record: VideoRecord) {
    await fsPromises.appendFile(this.recordsPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private replaceRecord(record: VideoRecord) {
    const previous = this.records.get(record.path);
    if (previous && previous.vectorOffset >= 0) {
      const previousKey = previous.vectorOffset / VECTOR_BYTES;
      this.recordsByVectorKey.delete(previousKey);
      this.vectorIndex?.remove(previous.sourcePath, "image", previousKey);
    }
    this.records.set(record.path, record);
    if (record.vectorOffset >= 0) {
      const vectorKey = record.vectorOffset / VECTOR_BYTES;
      this.recordsByVectorKey.set(vectorKey, record);
      this.vectorIndex?.upsert(record.sourcePath, "image", vectorKey);
    }
  }

  private async deleteRecord(filePath: string) {
    const previous = this.records.get(filePath);
    if (!previous) return;
    await fsPromises.appendFile(this.recordsPath, `${JSON.stringify({ path: filePath, deleted: true })}\n`, "utf8");
    this.records.delete(filePath);
    if (previous.vectorOffset >= 0) {
      const vectorKey = previous.vectorOffset / VECTOR_BYTES;
      this.recordsByVectorKey.delete(vectorKey);
      this.vectorIndex?.remove(previous.sourcePath, "image", vectorKey);
    }
  }

  private async loadRecords() {
    const vectorSize = await fsPromises.stat(this.vectorsPath).then((stats) => stats.size).catch(() => 0);
    const stream = fs.createReadStream(this.recordsPath, { encoding: "utf8" }).on("error", () => undefined);
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        if (typeof record?.path !== "string") continue;
        if (record.deleted === true) {
          const previous = this.records.get(record.path);
          if (previous && previous.vectorOffset >= 0)
            this.recordsByVectorKey.delete(previous.vectorOffset / VECTOR_BYTES);
          this.records.delete(record.path);
          continue;
        }
        const valid = typeof record.sourcePath === "string" &&
          typeof record.name === "string" && typeof record.relativePath === "string" &&
          Number.isFinite(record.size) && Number.isFinite(record.modified) &&
          typeof record.signature === "string" && Number.isSafeInteger(record.vectorOffset) &&
          record.vectorOffset >= -1 && Number.isSafeInteger(record.attempts);
        if (!valid) continue;
        if (record.vectorOffset >= 0 && record.vectorOffset + VECTOR_BYTES > vectorSize) continue;
        const previous = this.records.get(record.path);
        if (previous && previous.vectorOffset >= 0)
          this.recordsByVectorKey.delete(previous.vectorOffset / VECTOR_BYTES);
        const validRecord = record as VideoRecord;
        this.records.set(record.path, validRecord);
        if (validRecord.vectorOffset >= 0)
          this.recordsByVectorKey.set(validRecord.vectorOffset / VECTOR_BYTES, validRecord);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { lines.close(); stream.destroy(); }
  }

  private async buildVectorSearch() {
    const groups = new Map<string, number[]>();
    for (const record of this.records.values()) {
      if (record.vectorOffset < 0) continue;
      const keys = groups.get(record.sourcePath) ?? [];
      keys.push(record.vectorOffset / VECTOR_BYTES);
      groups.set(record.sourcePath, keys);
    }
    const vectorGroups: VectorSearchGroup[] = Array.from(groups, ([sourcePath, keys]) => ({
      sourcePath, kind: "image" as const, keys: BigUint64Array.from(keys, (key) => BigInt(key)),
    }));
    this.vectorIndex = new PersistedVectorIndex(
      this.vectorsPath,
      path.join(this.directory, "ann"),
      () => undefined,
      (error) => {
        this.vectorIndexFailed = true;
        this.onDiagnostic("video-semantic-ann-error", { message: safeError(error) });
      },
      this.performanceSettings,
    );
    try {
      await this.vectorIndex.initialize(vectorGroups);
      this.vectorIndexFailed = false;
    } catch (error) {
      this.vectorIndexFailed = true;
      this.onDiagnostic("video-semantic-ann-unavailable", { message: safeError(error) });
      await this.vectorIndex.shutdown(1000).catch(() => undefined);
      this.vectorIndex = null;
    }
  }

  private async searchExact(sourcePaths: string[], query: Float32Array, isCancelled: () => boolean) {
    const selected = Array.from(this.records.values())
      .filter((record) => record.vectorOffset >= 0 && sourcePaths.includes(record.sourcePath))
      .sort((first, second) => first.vectorOffset - second.vectorOffset);
    const handle = await fsPromises.open(this.vectorsPath, "r").catch(() => null);
    if (!handle) return [] as Array<{ key: number; confidence: number }>;
    const hits: Array<{ key: number; confidence: number }> = [];
    const buffer = Buffer.allocUnsafeSlow(VECTOR_BYTES * 512);
    try {
      let start = 0;
      while (start < selected.length) {
        if (isCancelled()) return [];
        const firstOffset = selected[start].vectorOffset;
        let end = start + 1;
        while (end < selected.length && end - start < 512 &&
          selected[end].vectorOffset + VECTOR_BYTES - firstOffset <= buffer.length) end += 1;
        const batch = selected.slice(start, end);
        const lastEnd = batch[batch.length - 1].vectorOffset + VECTOR_BYTES;
        const readLength = lastEnd - firstOffset;
        const { bytesRead } = await handle.read(buffer, 0, readLength, firstOffset);
        for (const record of batch) {
          const localOffset = record.vectorOffset - firstOffset;
          if (localOffset + VECTOR_BYTES > bytesRead) continue;
          const vector = new Float32Array(buffer.buffer, buffer.byteOffset + localOffset, VECTOR_SIZE);
          let similarity = 0;
          for (let dimension = 0; dimension < VECTOR_SIZE; dimension += 1)
            similarity += query[dimension] * vector[dimension];
          if (!Number.isFinite(similarity)) continue;
          hits.push({ key: record.vectorOffset / VECTOR_BYTES, confidence: Math.max(0, Math.min(100, similarity * 100)) });
        }
        if (hits.length > MAX_SEARCH_RESULTS * 2) {
          hits.sort((first, second) => second.confidence - first.confidence);
          hits.length = MAX_SEARCH_RESULTS;
        }
        start = end;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally { await handle.close(); }
    return hits.sort((first, second) => second.confidence - first.confidence).slice(0, MAX_SEARCH_RESULTS);
  }

  private async persistPending() {
    const snapshot = JSON.stringify({
      version: 1,
      roots: Array.from(this.pendingRoots),
      files: Array.from(this.pendingFiles, ([filePath, value]) => ({ path: filePath, ...value })),
    });
    const write = this.persistPendingPromise.catch(() => undefined).then(async () => {
      await fsPromises.mkdir(this.directory, { recursive: true });
      await fsPromises.writeFile(`${this.pendingPath}.tmp`, snapshot, { encoding: "utf8", mode: 0o600 });
      await fsPromises.rename(`${this.pendingPath}.tmp`, this.pendingPath);
    });
    this.persistPendingPromise = write;
    await write;
  }

  private async persistProgress(force = false) {
    if (!force && Date.now() - this.lastProgressPersistAt < 2000) return;
    this.lastProgressPersistAt = Date.now();
    const snapshot = JSON.stringify(this.progress);
    const write = this.persistProgressPromise.catch(() => undefined).then(async () => {
      await fsPromises.writeFile(`${this.progressPath}.tmp`, snapshot, { encoding: "utf8", mode: 0o600 });
      await fsPromises.rename(`${this.progressPath}.tmp`, this.progressPath);
    });
    this.persistProgressPromise = write;
    await write;
  }

  private async updateProgress(update: Partial<IndexProgress>, force: boolean) {
    this.progress = { ...this.progress, ...update };
    this.onProgress(this.getProgress());
    await this.persistProgress(force);
  }

  private emitProgress() { this.onProgress(this.getProgress()); }

  private finishPaused() {
    this.progress.status = "paused";
    this.progress.currentFile = null;
    this.progress.message = "Video indexing paused with its source checkpoint saved.";
    this.emitProgress();
    return this.persistProgress(true);
  }

  private async paceAfterVideo(workMs: number, isCancelled: () => boolean) {
    await this.governor?.paceAfterWork(workMs, () => this.activeSearches > 0, isCancelled,
      this.performanceSettings.backgroundWorkPercent);
  }
}
