import { parentPort } from "worker_threads";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import "numkong";
import { Index, MetricKind, ScalarKind } from "usearch";
import {
  defaultSearchPerformanceSettings,
  getSearchPerformanceMachineInfo,
  SearchPerformanceSettings,
} from "./contentSettings";
import {
  VectorSearchDiagnostics,
  VectorSearchGroup,
  VectorSearchKind,
  VectorSearchResponse,
} from "./persistedVectorIndex";

const VECTOR_SIZE = 512;
const VECTOR_BYTES = VECTOR_SIZE * Float32Array.BYTES_PER_ELEMENT;
const MAX_VECTOR_WINDOW_BYTES = 2 * 1024 * 1024;
const MAX_ADD_BATCH = 128;
const INDEX_LIMIT_PER_KIND = 500;
const SAVE_DEBOUNCE_MS = 30_000;
const INDEX_VERSION = 1;

type Partition = {
  sourcePath: string;
  kind: VectorSearchKind;
  filePath: string;
  index: Index;
  keys: Set<number>;
  dirty: boolean;
};

type ManifestPartition = {
  id: string;
  sourcePath: string;
  kind: VectorSearchKind;
  keys: number[];
};

type Manifest = {
  version: number;
  dimensions: number;
  metric: string;
  quantization: string;
  partitions: ManifestPartition[];
};

type WorkerMessage = {
  type: "initialize" | "search" | "upsert" | "remove" | "flush" | "close" | "pause" | "resume" | "set-settings";
  requestId?: number;
  vectorsPath?: string;
  cacheDirectory?: string;
  groups?: VectorSearchGroup[];
  sourcePaths?: string[];
  imageQuery?: Float32Array;
  documentQuery?: Float32Array;
  limit?: number;
  sourcePath?: string;
  kind?: VectorSearchKind;
  key?: number;
  settings?: SearchPerformanceSettings;
};

const partitions = new Map<string, Partition>();
let vectorsPath = "";
let cacheDirectory = "";
let closing = false;
let saveTimer: NodeJS.Timeout | null = null;
let messageQueue = Promise.resolve();
let paused = false;
let performanceSettings = defaultSearchPerformanceSettings();
let manifestDirty = false;

const indexConfig = {
  dimensions: VECTOR_SIZE,
  metric: MetricKind.Cos,
  quantization: ScalarKind.F16,
  connectivity: 16,
  expansion_add: 128,
  expansion_search: 48,
  multi: false,
};

function partitionId(sourcePath: string, kind: VectorSearchKind): string {
  return crypto
    .createHash("sha256")
    .update(`${sourcePath}\0${kind}`)
    .digest("hex")
    .slice(0, 24);
}

function createPartition(sourcePath: string, kind: VectorSearchKind): Partition {
  const id = partitionId(sourcePath, kind);
  return {
    sourcePath,
    kind,
    filePath: path.join(cacheDirectory, `${id}.usearch`),
    index: new Index(indexConfig),
    keys: new Set<number>(),
    dirty: true,
  };
}

function reportProgress(processed: number, total: number) {
  parentPort?.postMessage({
    type: "progress",
    fraction: total ? Math.min(1, processed / total) : 1,
    records: processed,
  });
}

async function waitIfPaused() {
  while (paused && !closing) await new Promise<void>((resolve) => setTimeout(resolve, 40));
}

async function paceBackgroundWork(workMs: number) {
  const dutyPercent = Math.max(
    5,
    Math.min(100, performanceSettings.backgroundWorkPercent),
  );
  let remaining = Math.ceil(workMs * ((100 - dutyPercent) / dutyPercent));
  while (remaining > 0 && !closing) {
    await waitIfPaused();
    const slice = Math.min(50, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, slice));
    remaining -= slice;
  }
}

async function readAndAdd(
  partition: Partition,
  keys: number[],
  vectorHandle: fsPromises.FileHandle,
  progress: { processed: number; total: number },
) {
  for (let start = 0; start < keys.length; ) {
    await waitIfPaused();
    const batchStartedAt = Date.now();
    const batchKeys = [keys[start]];
    const startOffset = keys[start] * VECTOR_BYTES;
    let lastEnd = startOffset + VECTOR_BYTES;
    let end = start + 1;
    while (
      end < keys.length &&
      end - start < MAX_ADD_BATCH &&
      (keys[end] + 1) * VECTOR_BYTES - startOffset <= MAX_VECTOR_WINDOW_BYTES
    ) {
      batchKeys.push(keys[end]);
      lastEnd = (keys[end] + 1) * VECTOR_BYTES;
      end += 1;
    }
    const byteLength = lastEnd - startOffset;
    const buffer = Buffer.allocUnsafeSlow(byteLength);
    const { bytesRead } = await vectorHandle.read(buffer, 0, byteLength, startOffset);
    if (bytesRead !== byteLength)
      throw new Error("Saved vectors are incomplete; the ANN index cannot be prepared.");
    const addKeys: number[] = [];
    const vectors = new Float32Array(batchKeys.length * VECTOR_SIZE);
    for (let index = 0; index < batchKeys.length; index += 1) {
      const localStart = batchKeys[index] * VECTOR_BYTES - startOffset;
      if (localStart + VECTOR_BYTES > bytesRead) continue;
      const vector = new Float32Array(
        buffer.buffer,
        buffer.byteOffset + localStart,
        VECTOR_SIZE,
      );
      vectors.set(vector, addKeys.length * VECTOR_SIZE);
      addKeys.push(batchKeys[index]);
    }
    if (addKeys.length) {
      const keyArray = BigUint64Array.from(addKeys, (key) => BigInt(key));
      partition.index.add(
        keyArray,
        vectors.subarray(0, addKeys.length * VECTOR_SIZE),
        performanceSettings.indexThreads,
      );
      for (const key of addKeys) partition.keys.add(key);
      partition.dirty = true;
    }
    progress.processed += batchKeys.length;
    reportProgress(progress.processed, progress.total);
    start = end;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await paceBackgroundWork(Math.max(1, Date.now() - batchStartedAt));
  }
}

async function atomicWriteIndex(partition: Partition) {
  if (!partition.dirty) return;
  const temporaryPath = `${partition.filePath}.tmp`;
  partition.index.save(temporaryPath);
  await fsPromises.rm(partition.filePath, { force: true });
  await fsPromises.rename(temporaryPath, partition.filePath);
  partition.dirty = false;
}

async function saveAll() {
  await fsPromises.mkdir(cacheDirectory, { recursive: true });
  for (const partition of partitions.values()) await atomicWriteIndex(partition);
  if (!manifestDirty) return;
  const manifest: Manifest = {
    version: INDEX_VERSION,
    dimensions: VECTOR_SIZE,
    metric: MetricKind.Cos,
    quantization: ScalarKind.F16,
    partitions: Array.from(partitions.entries())
      .map(([id, partition]) => ({
        id,
        sourcePath: partition.sourcePath,
        kind: partition.kind,
        keys: Array.from(partition.keys).sort((first, second) => first - second),
      }))
      .sort((first, second) => first.id.localeCompare(second.id)),
  };
  const manifestPath = path.join(cacheDirectory, "manifest.json");
  const temporaryPath = `${manifestPath}.tmp`;
  await fsPromises.writeFile(temporaryPath, JSON.stringify(manifest));
  await fsPromises.rm(manifestPath, { force: true });
  await fsPromises.rename(temporaryPath, manifestPath);
  manifestDirty = false;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    messageQueue = messageQueue
      .then(() => saveAll())
      .catch((error) =>
        parentPort?.postMessage({ type: "error", error: String(error) }),
      );
  }, SAVE_DEBOUNCE_MS);
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(
      await fsPromises.readFile(path.join(cacheDirectory, "manifest.json"), "utf8"),
    ) as Manifest;
    if (
      parsed.version !== INDEX_VERSION ||
      parsed.dimensions !== VECTOR_SIZE ||
      parsed.metric !== MetricKind.Cos ||
      parsed.quantization !== ScalarKind.F16 ||
      !Array.isArray(parsed.partitions)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

async function initialize(message: WorkerMessage) {
  vectorsPath = message.vectorsPath || "";
  cacheDirectory = message.cacheDirectory || "";
  performanceSettings = message.settings ?? defaultSearchPerformanceSettings(
    getSearchPerformanceMachineInfo().availableProcessors,
  );
  await fsPromises.mkdir(cacheDirectory, { recursive: true });
  const groups = message.groups ?? [];
  const currentById = new Map<
    string,
    { sourcePath: string; kind: VectorSearchKind; keys: number[] }
  >();
  let total = 0;
  for (const group of groups) {
    const id = partitionId(group.sourcePath, group.kind);
    const currentKeys = Array.from(group.keys, (key) => Number(key)).sort(
      (first, second) => first - second,
    );
    currentById.set(id, {
      sourcePath: group.sourcePath,
      kind: group.kind,
      keys: currentKeys,
    });
    total += currentKeys.length;
  }
  reportProgress(0, total);

  const saved = await loadManifest();
  const savedById = new Map((saved?.partitions ?? []).map((entry) => [entry.id, entry]));
  manifestDirty = saved === null || savedById.size !== currentById.size;
  let processed = 0;
  const vectorHandle = await fsPromises.open(vectorsPath, "r").catch(() => null);
  if (!vectorHandle && total > 0)
    throw new Error("The saved vector file is unavailable; the ANN index cannot be prepared.");
  try {
    for (const [id, group] of currentById) {
      const currentKeys = group.keys;
      const previous = savedById.get(id);
      let partition = createPartition(group.sourcePath, group.kind);
      if (previous && previous.sourcePath === group.sourcePath && previous.kind === group.kind) {
        try {
          partition.index.load(partition.filePath);
          const previousKeys = new Set(previous.keys);
          if (partition.index.size() !== previousKeys.size) throw new Error("Index key manifest mismatch.");
          partition.keys = previousKeys;
          partition.dirty = false;
        } catch {
          partition = createPartition(group.sourcePath, group.kind);
          manifestDirty = true;
        }
      }
      const currentSet = new Set(currentKeys);
      if (partition.keys.size) {
        const removed = Array.from(partition.keys).filter((key) => !currentSet.has(key));
        if (removed.length) {
          partition.index.remove(BigUint64Array.from(removed, (key) => BigInt(key)));
          partition.dirty = true;
          manifestDirty = true;
          for (const key of removed) partition.keys.delete(key);
        }
      }
      const additions = currentKeys.filter((key) => !partition.keys.has(key));
      if (additions.length) manifestDirty = true;
      partitions.set(id, partition);
      processed += partition.keys.size;
      reportProgress(processed, total);
      if (additions.length && vectorHandle) {
        const buildProgress = { processed, total };
        await readAndAdd(partition, additions, vectorHandle, buildProgress);
        processed = buildProgress.processed;
      }
      await atomicWriteIndex(partition);
      savedById.delete(id);
    }
  } finally {
    await vectorHandle?.close();
  }
  if (savedById.size) manifestDirty = true;
  for (const stale of savedById.values())
    await fsPromises.rm(path.join(cacheDirectory, `${stale.id}.usearch`), { force: true });
  await saveAll();
  reportProgress(total, total);
  parentPort?.postMessage({ type: "ready" });
}

async function search(message: WorkerMessage): Promise<VectorSearchResponse> {
  const searchStartedAt = performance.now();
  const sourcePaths = new Set(message.sourcePaths ?? []);
  const imageQuery = message.imageQuery;
  const documentQuery = message.documentQuery;
  const perPartitionLimit = Math.max(1, Math.min(INDEX_LIMIT_PER_KIND, message.limit ?? INDEX_LIMIT_PER_KIND));
  const partitionTimings: VectorSearchDiagnostics["slowestPartitions"] = [];
  let indexedRecords = 0;
  let partitionSearchMs = 0;
  let candidateSortMs = 0;
  let vectorOpenMs = 0;
  let vectorReadMs = 0;
  let vectorBytesRead = 0;
  let rerankMs = 0;
  let yieldMs = 0;
  let finalSortMs = 0;
  let vectorsAvailable = false;
  const diagnostics = (
    candidateCount: number,
    partitionCount: number,
  ): VectorSearchDiagnostics => {
    const durationMs = Math.round((performance.now() - searchStartedAt) * 10) / 10;
    const measuredMs =
      partitionSearchMs + candidateSortMs + vectorOpenMs + vectorReadMs +
      rerankMs + yieldMs + finalSortMs;
    return {
      durationMs,
      sourceCount: sourcePaths.size,
      partitionCount,
      indexedRecords,
      candidateCount,
      searchThreads: performanceSettings.searchThreads,
      perPartitionLimit,
      expansionSearch: indexConfig.expansion_search,
      partitionSearchMs: Math.round(partitionSearchMs * 10) / 10,
      candidateSortMs: Math.round(candidateSortMs * 10) / 10,
      vectorOpenMs: Math.round(vectorOpenMs * 10) / 10,
      vectorReadMs: Math.round(vectorReadMs * 10) / 10,
      vectorBytesRead,
      rerankMs: Math.round(rerankMs * 10) / 10,
      yieldMs: Math.round(yieldMs * 10) / 10,
      finalSortMs: Math.round(finalSortMs * 10) / 10,
      unattributedMs: Math.round(Math.max(0, durationMs - measuredMs) * 10) / 10,
      vectorsAvailable,
      slowestPartitions: partitionTimings
        .sort((first, second) => second.durationMs - first.durationMs)
        .slice(0, 5),
    };
  };
  if (!imageQuery || !documentQuery)
    return { hits: [], diagnostics: diagnostics(0, 0) };
  const candidates: Array<{ key: number; kind: VectorSearchKind; query: Float32Array }> = [];
  let partitionCount = 0;
  for (const partition of partitions.values()) {
    if (!sourcePaths.has(partition.sourcePath) || partition.index.size() === 0) continue;
    partitionCount += 1;
    const query = partition.kind === "image" ? imageQuery : documentQuery;
    const partitionSize = partition.index.size();
    indexedRecords += partitionSize;
    const count = Math.min(perPartitionLimit, partitionSize);
    const partitionStartedAt = performance.now();
    const matches = partition.index.search(
      query,
      count,
      performanceSettings.searchThreads,
    );
    const partitionDurationMs = performance.now() - partitionStartedAt;
    partitionSearchMs += partitionDurationMs;
    const candidatesBeforePartition = candidates.length;
    for (let index = 0; index < matches.keys.length; index += 1) {
      const key = Number(matches.keys[index]);
      if (Number.isSafeInteger(key) && key >= 0 && Number.isFinite(matches.distances[index]))
        candidates.push({ key, kind: partition.kind, query });
    }
    partitionTimings.push({
      sourceKey: partitionId(partition.sourcePath, partition.kind),
      kind: partition.kind,
      indexedRecords: partitionSize,
      candidateCount: candidates.length - candidatesBeforePartition,
      durationMs: Math.round(partitionDurationMs * 10) / 10,
    });
  }
  if (!candidates.length)
    return { hits: [], diagnostics: diagnostics(0, partitionCount) };

  const candidateSortStartedAt = performance.now();
  candidates.sort((first, second) => first.key - second.key);
  candidateSortMs = performance.now() - candidateSortStartedAt;
  const exact = new Map<number, number>();
  const vectorOpenStartedAt = performance.now();
  const handle = await fsPromises.open(vectorsPath, "r").catch(() => null);
  vectorOpenMs = performance.now() - vectorOpenStartedAt;
  if (!handle)
    return { hits: [], diagnostics: diagnostics(candidates.length, partitionCount) };
  vectorsAvailable = true;
  try {
    for (let start = 0; start < candidates.length; ) {
      let end = start + 1;
      const firstOffset = candidates[start].key * VECTOR_BYTES;
      while (
        end < candidates.length &&
        end - start < MAX_ADD_BATCH &&
        (candidates[end].key + 1) * VECTOR_BYTES - firstOffset <= MAX_VECTOR_WINDOW_BYTES
      ) end += 1;
      const byteLength = (candidates[end - 1].key + 1) * VECTOR_BYTES - firstOffset;
      const buffer = Buffer.allocUnsafeSlow(byteLength);
      const readStartedAt = performance.now();
      const { bytesRead } = await handle.read(buffer, 0, byteLength, firstOffset);
      vectorReadMs += performance.now() - readStartedAt;
      vectorBytesRead += bytesRead;
      const rerankStartedAt = performance.now();
      for (let index = start; index < end; index += 1) {
        const candidate = candidates[index];
        const localOffset = candidate.key * VECTOR_BYTES - firstOffset;
        if (localOffset + VECTOR_BYTES > bytesRead) continue;
        const vector = new Float32Array(
          buffer.buffer,
          buffer.byteOffset + localOffset,
          VECTOR_SIZE,
        );
        let similarity = 0;
        for (let dimension = 0; dimension < VECTOR_SIZE; dimension += 1)
          similarity += candidate.query[dimension] * vector[dimension];
        if (Number.isFinite(similarity)) exact.set(candidate.key, similarity);
      }
      rerankMs += performance.now() - rerankStartedAt;
      start = end;
      const yieldStartedAt = performance.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
      yieldMs += performance.now() - yieldStartedAt;
    }
  } finally {
    await handle.close();
  }
  const imageHits: Array<{ key: number; confidence: number }> = [];
  const documentHits: Array<{ key: number; confidence: number }> = [];
  const finalSortStartedAt = performance.now();
  for (const candidate of candidates) {
    const similarity = exact.get(candidate.key);
    if (similarity === undefined) continue;
    const hit = {
      key: candidate.key,
      confidence: Math.max(0, Math.min(100, similarity * 100)),
    };
    (candidate.kind === "image" ? imageHits : documentHits).push(hit);
  }
  const sortAndLimit = (hits: Array<{ key: number; confidence: number }>) =>
    hits.sort((first, second) => second.confidence - first.confidence).slice(0, INDEX_LIMIT_PER_KIND);
  const hits = [...sortAndLimit(imageHits), ...sortAndLimit(documentHits)];
  finalSortMs = performance.now() - finalSortStartedAt;
  return { hits, diagnostics: diagnostics(candidates.length, partitionCount) };
}

async function applyUpsert(message: WorkerMessage) {
  if (!message.sourcePath || !message.kind || !Number.isSafeInteger(message.key) || message.key! < 0)
    return;
  const id = partitionId(message.sourcePath, message.kind);
  let partition = partitions.get(id);
  if (!partition) {
    partition = createPartition(message.sourcePath, message.kind);
    partitions.set(id, partition);
  }
  const key = message.key as number;
  if (partition.keys.has(key)) return;
  const handle = await fsPromises.open(vectorsPath, "r").catch(() => null);
  if (!handle) return;
  try {
    const buffer = Buffer.alloc(VECTOR_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, VECTOR_BYTES, key * VECTOR_BYTES);
    if (bytesRead !== VECTOR_BYTES) return;
    partition.index.add(
      BigInt(key),
      new Float32Array(buffer.buffer, buffer.byteOffset, VECTOR_SIZE),
      performanceSettings.indexThreads,
    );
    partition.keys.add(key);
    partition.dirty = true;
    manifestDirty = true;
    scheduleSave();
  } finally {
    await handle.close();
  }
}

function applyRemove(message: WorkerMessage) {
  if (!message.sourcePath || !message.kind || !Number.isSafeInteger(message.key)) return;
  const partition = partitions.get(partitionId(message.sourcePath, message.kind));
  const key = message.key as number;
  if (!partition || !partition.keys.delete(key)) return;
  if (partition.index.contains(BigInt(key))) partition.index.remove(BigInt(key));
  partition.dirty = true;
  manifestDirty = true;
  scheduleSave();
}

async function handle(message: WorkerMessage) {
  if (message.type === "initialize") {
    await initialize(message);
    return;
  }
  if (message.type === "upsert") {
    await applyUpsert(message);
    return;
  }
  if (message.type === "remove") {
    applyRemove(message);
    return;
  }
  if (message.type === "search") {
    const result = await search(message);
    parentPort?.postMessage({
      type: "reply",
      requestId: message.requestId,
      hits: result.hits,
      diagnostics: result.diagnostics,
    });
    return;
  }
  if (message.type === "flush") {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    await saveAll();
    parentPort?.postMessage({ type: "reply", requestId: message.requestId });
    return;
  }
  if (message.type === "close") {
    closing = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    await saveAll();
    parentPort?.postMessage({ type: "reply", requestId: message.requestId });
    parentPort?.close();
  }
}

parentPort?.on("message", (message: WorkerMessage) => {
  if (message.type === "set-settings" && message.settings) {
    performanceSettings = message.settings;
    return;
  }
  if (message.type === "pause") {
    paused = true;
    return;
  }
  if (message.type === "resume") {
    paused = false;
    return;
  }
  // Queries can use partitions that are already loaded while initialization
  // continues to reconcile and add later partitions. Serializing searches
  // behind the whole build made the main process fall back to a full vector
  // scan for every query during startup.
  if (message.type === "search") {
    void handle(message).catch((error) => {
      parentPort?.postMessage({
        type: "reply",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  messageQueue = messageQueue
    .then(() => handle(message))
    .catch((error) => {
      const response = {
        type: message.type === "initialize" ? "error" : "reply",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      };
      parentPort?.postMessage(response);
    });
});
