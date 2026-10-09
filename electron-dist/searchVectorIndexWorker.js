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
const worker_threads_1 = require("worker_threads");
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const usearch_1 = require("usearch");
const contentSettings_1 = require("./contentSettings");
const VECTOR_SIZE = 512;
const VECTOR_BYTES = VECTOR_SIZE * Float32Array.BYTES_PER_ELEMENT;
const MAX_VECTOR_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_ADD_BATCH = 1024;
const INDEX_LIMIT_PER_KIND = 500;
const SAVE_DEBOUNCE_MS = 30000;
const INDEX_VERSION = 1;
const partitions = new Map();
let vectorsPath = "";
let cacheDirectory = "";
let ready = false;
let closing = false;
let saveTimer = null;
let messageQueue = Promise.resolve();
let paused = false;
let performanceSettings = (0, contentSettings_1.defaultSearchPerformanceSettings)();
const indexConfig = {
    dimensions: VECTOR_SIZE,
    metric: usearch_1.MetricKind.Cos,
    quantization: usearch_1.ScalarKind.F16,
    connectivity: 16,
    expansion_add: 128,
    expansion_search: 96,
    multi: false,
};
function partitionId(sourcePath, kind) {
    return crypto
        .createHash("sha256")
        .update(`${sourcePath}\0${kind}`)
        .digest("hex")
        .slice(0, 24);
}
function createPartition(sourcePath, kind) {
    const id = partitionId(sourcePath, kind);
    return {
        sourcePath,
        kind,
        filePath: path.join(cacheDirectory, `${id}.usearch`),
        index: new usearch_1.Index(indexConfig),
        keys: new Set(),
        dirty: true,
    };
}
function reportProgress(processed, total) {
    worker_threads_1.parentPort?.postMessage({
        type: "progress",
        fraction: total ? Math.min(1, processed / total) : 1,
        records: processed,
    });
}
async function waitIfPaused() {
    while (paused && !closing)
        await new Promise((resolve) => setTimeout(resolve, 40));
}
async function paceBackgroundWork(workMs) {
    const dutyPercent = Math.max(20, Math.min(100, performanceSettings.backgroundWorkPercent));
    let remaining = Math.ceil(workMs * ((100 - dutyPercent) / dutyPercent));
    while (remaining > 0 && !closing) {
        await waitIfPaused();
        const slice = Math.min(50, remaining);
        await new Promise((resolve) => setTimeout(resolve, slice));
        remaining -= slice;
    }
}
async function readAndAdd(partition, keys, vectorHandle, progress) {
    for (let start = 0; start < keys.length;) {
        await waitIfPaused();
        const batchStartedAt = Date.now();
        const batchKeys = [keys[start]];
        const startOffset = keys[start] * VECTOR_BYTES;
        let lastEnd = startOffset + VECTOR_BYTES;
        let end = start + 1;
        while (end < keys.length &&
            end - start < MAX_ADD_BATCH &&
            (keys[end] + 1) * VECTOR_BYTES - startOffset <= MAX_VECTOR_WINDOW_BYTES) {
            batchKeys.push(keys[end]);
            lastEnd = (keys[end] + 1) * VECTOR_BYTES;
            end += 1;
        }
        const byteLength = lastEnd - startOffset;
        const buffer = Buffer.allocUnsafeSlow(byteLength);
        const { bytesRead } = await vectorHandle.read(buffer, 0, byteLength, startOffset);
        if (bytesRead !== byteLength)
            throw new Error("Saved vectors are incomplete; the ANN index cannot be prepared.");
        const addKeys = [];
        const vectors = new Float32Array(batchKeys.length * VECTOR_SIZE);
        for (let index = 0; index < batchKeys.length; index += 1) {
            const localStart = batchKeys[index] * VECTOR_BYTES - startOffset;
            if (localStart + VECTOR_BYTES > bytesRead)
                continue;
            const vector = new Float32Array(buffer.buffer, buffer.byteOffset + localStart, VECTOR_SIZE);
            vectors.set(vector, addKeys.length * VECTOR_SIZE);
            addKeys.push(batchKeys[index]);
        }
        if (addKeys.length) {
            const keyArray = BigUint64Array.from(addKeys, (key) => BigInt(key));
            partition.index.add(keyArray, vectors.subarray(0, addKeys.length * VECTOR_SIZE), performanceSettings.indexThreads);
            for (const key of addKeys)
                partition.keys.add(key);
            partition.dirty = true;
        }
        progress.processed += batchKeys.length;
        reportProgress(progress.processed, progress.total);
        start = end;
        await new Promise((resolve) => setImmediate(resolve));
        await paceBackgroundWork(Math.max(1, Date.now() - batchStartedAt));
    }
}
async function atomicWriteIndex(partition) {
    if (!partition.dirty)
        return;
    const temporaryPath = `${partition.filePath}.tmp`;
    partition.index.save(temporaryPath);
    await fsPromises.rm(partition.filePath, { force: true });
    await fsPromises.rename(temporaryPath, partition.filePath);
    partition.dirty = false;
}
async function saveAll() {
    await fsPromises.mkdir(cacheDirectory, { recursive: true });
    for (const partition of partitions.values())
        await atomicWriteIndex(partition);
    const manifest = {
        version: INDEX_VERSION,
        dimensions: VECTOR_SIZE,
        metric: usearch_1.MetricKind.Cos,
        quantization: usearch_1.ScalarKind.F16,
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
}
function scheduleSave() {
    if (saveTimer)
        clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        messageQueue = messageQueue
            .then(() => saveAll())
            .catch((error) => worker_threads_1.parentPort?.postMessage({ type: "error", error: String(error) }));
    }, SAVE_DEBOUNCE_MS);
}
async function loadManifest() {
    try {
        const parsed = JSON.parse(await fsPromises.readFile(path.join(cacheDirectory, "manifest.json"), "utf8"));
        if (parsed.version !== INDEX_VERSION ||
            parsed.dimensions !== VECTOR_SIZE ||
            parsed.metric !== usearch_1.MetricKind.Cos ||
            parsed.quantization !== usearch_1.ScalarKind.F16 ||
            !Array.isArray(parsed.partitions))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
async function initialize(message) {
    vectorsPath = message.vectorsPath || "";
    cacheDirectory = message.cacheDirectory || "";
    performanceSettings = message.settings ?? (0, contentSettings_1.defaultSearchPerformanceSettings)((0, contentSettings_1.getSearchPerformanceMachineInfo)().availableProcessors);
    await fsPromises.mkdir(cacheDirectory, { recursive: true });
    const groups = message.groups ?? [];
    const currentById = new Map();
    let total = 0;
    for (const group of groups) {
        const id = partitionId(group.sourcePath, group.kind);
        const normalizedKeys = Array.from(group.keys, (key) => Number(key)).sort((first, second) => first - second);
        currentById.set(id, {
            sourcePath: group.sourcePath,
            kind: group.kind,
            keys: BigUint64Array.from(normalizedKeys, (key) => BigInt(key)),
        });
        total += normalizedKeys.length;
    }
    reportProgress(0, total);
    const saved = await loadManifest();
    const savedById = new Map((saved?.partitions ?? []).map((entry) => [entry.id, entry]));
    let processed = 0;
    const vectorHandle = await fsPromises.open(vectorsPath, "r").catch(() => null);
    if (!vectorHandle && total > 0)
        throw new Error("The saved vector file is unavailable; the ANN index cannot be prepared.");
    try {
        for (const [id, group] of currentById) {
            const currentKeys = Array.from(group.keys, (key) => Number(key));
            const previous = savedById.get(id);
            let partition = createPartition(group.sourcePath, group.kind);
            if (previous && previous.sourcePath === group.sourcePath && previous.kind === group.kind) {
                try {
                    partition.index.load(partition.filePath);
                    const previousKeys = new Set(previous.keys);
                    if (partition.index.size() !== previousKeys.size)
                        throw new Error("Index key manifest mismatch.");
                    partition.keys = previousKeys;
                    partition.dirty = false;
                }
                catch {
                    partition = createPartition(group.sourcePath, group.kind);
                }
            }
            const currentSet = new Set(currentKeys);
            const retained = new Set();
            if (partition.keys.size) {
                const removed = Array.from(partition.keys).filter((key) => !currentSet.has(key));
                if (removed.length) {
                    partition.index.remove(BigUint64Array.from(removed, (key) => BigInt(key)));
                    partition.dirty = true;
                }
                for (const key of partition.keys)
                    if (currentSet.has(key))
                        retained.add(key);
            }
            const additions = currentKeys.filter((key) => !retained.has(key));
            partition.keys = retained;
            partitions.set(id, partition);
            processed += retained.size;
            reportProgress(processed, total);
            if (additions.length && vectorHandle) {
                const buildProgress = { processed, total };
                await readAndAdd(partition, additions, vectorHandle, buildProgress);
                processed = buildProgress.processed;
            }
            await atomicWriteIndex(partition);
            savedById.delete(id);
        }
    }
    finally {
        await vectorHandle?.close();
    }
    for (const stale of savedById.values())
        await fsPromises.rm(path.join(cacheDirectory, `${stale.id}.usearch`), { force: true });
    await saveAll();
    ready = true;
    reportProgress(total, total);
    worker_threads_1.parentPort?.postMessage({ type: "ready" });
}
async function search(message) {
    const sourcePaths = new Set(message.sourcePaths ?? []);
    const imageQuery = message.imageQuery;
    const documentQuery = message.documentQuery;
    if (!imageQuery || !documentQuery)
        return [];
    const candidates = [];
    const perPartitionLimit = Math.max(1, Math.min(INDEX_LIMIT_PER_KIND, message.limit ?? INDEX_LIMIT_PER_KIND));
    for (const partition of partitions.values()) {
        if (!sourcePaths.has(partition.sourcePath) || partition.index.size() === 0)
            continue;
        const query = partition.kind === "image" ? imageQuery : documentQuery;
        const count = Math.min(perPartitionLimit, partition.index.size());
        const matches = partition.index.search(query, count, performanceSettings.searchThreads);
        for (let index = 0; index < matches.keys.length; index += 1) {
            const key = Number(matches.keys[index]);
            if (Number.isSafeInteger(key) && key >= 0 && Number.isFinite(matches.distances[index]))
                candidates.push({ key, kind: partition.kind, query });
        }
    }
    if (!candidates.length)
        return [];
    candidates.sort((first, second) => first.key - second.key);
    const exact = new Map();
    const handle = await fsPromises.open(vectorsPath, "r").catch(() => null);
    if (!handle)
        return [];
    try {
        for (let start = 0; start < candidates.length;) {
            let end = start + 1;
            const firstOffset = candidates[start].key * VECTOR_BYTES;
            while (end < candidates.length &&
                end - start < MAX_ADD_BATCH &&
                (candidates[end].key + 1) * VECTOR_BYTES - firstOffset <= MAX_VECTOR_WINDOW_BYTES)
                end += 1;
            const byteLength = (candidates[end - 1].key + 1) * VECTOR_BYTES - firstOffset;
            const buffer = Buffer.allocUnsafeSlow(byteLength);
            const { bytesRead } = await handle.read(buffer, 0, byteLength, firstOffset);
            for (let index = start; index < end; index += 1) {
                const candidate = candidates[index];
                const localOffset = candidate.key * VECTOR_BYTES - firstOffset;
                if (localOffset + VECTOR_BYTES > bytesRead)
                    continue;
                const vector = new Float32Array(buffer.buffer, buffer.byteOffset + localOffset, VECTOR_SIZE);
                let similarity = 0;
                for (let dimension = 0; dimension < VECTOR_SIZE; dimension += 1)
                    similarity += candidate.query[dimension] * vector[dimension];
                if (Number.isFinite(similarity))
                    exact.set(candidate.key, similarity);
            }
            start = end;
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    finally {
        await handle.close();
    }
    const imageHits = [];
    const documentHits = [];
    for (const candidate of candidates) {
        const similarity = exact.get(candidate.key);
        if (similarity === undefined)
            continue;
        const hit = {
            key: candidate.key,
            confidence: Math.max(0, Math.min(100, similarity * 100)),
        };
        (candidate.kind === "image" ? imageHits : documentHits).push(hit);
    }
    const sortAndLimit = (hits) => hits.sort((first, second) => second.confidence - first.confidence).slice(0, INDEX_LIMIT_PER_KIND);
    return [...sortAndLimit(imageHits), ...sortAndLimit(documentHits)];
}
async function applyUpsert(message) {
    if (!message.sourcePath || !message.kind || !Number.isSafeInteger(message.key) || message.key < 0)
        return;
    const id = partitionId(message.sourcePath, message.kind);
    let partition = partitions.get(id);
    if (!partition) {
        partition = createPartition(message.sourcePath, message.kind);
        partitions.set(id, partition);
    }
    const key = message.key;
    if (partition.keys.has(key))
        return;
    const handle = await fsPromises.open(vectorsPath, "r").catch(() => null);
    if (!handle)
        return;
    try {
        const buffer = Buffer.alloc(VECTOR_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, VECTOR_BYTES, key * VECTOR_BYTES);
        if (bytesRead !== VECTOR_BYTES)
            return;
        partition.index.add(BigInt(key), new Float32Array(buffer.buffer, buffer.byteOffset, VECTOR_SIZE), performanceSettings.indexThreads);
        partition.keys.add(key);
        partition.dirty = true;
        scheduleSave();
    }
    finally {
        await handle.close();
    }
}
function applyRemove(message) {
    if (!message.sourcePath || !message.kind || !Number.isSafeInteger(message.key))
        return;
    const partition = partitions.get(partitionId(message.sourcePath, message.kind));
    const key = message.key;
    if (!partition || !partition.keys.delete(key))
        return;
    if (partition.index.contains(BigInt(key)))
        partition.index.remove(BigInt(key));
    partition.dirty = true;
    scheduleSave();
}
async function handle(message) {
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
        const hits = await search(message);
        worker_threads_1.parentPort?.postMessage({ type: "reply", requestId: message.requestId, hits });
        return;
    }
    if (message.type === "flush") {
        if (saveTimer)
            clearTimeout(saveTimer);
        saveTimer = null;
        await saveAll();
        worker_threads_1.parentPort?.postMessage({ type: "reply", requestId: message.requestId });
        return;
    }
    if (message.type === "close") {
        closing = true;
        if (saveTimer)
            clearTimeout(saveTimer);
        saveTimer = null;
        await saveAll();
        worker_threads_1.parentPort?.postMessage({ type: "reply", requestId: message.requestId });
        worker_threads_1.parentPort?.close();
    }
}
worker_threads_1.parentPort?.on("message", (message) => {
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
    messageQueue = messageQueue
        .then(() => handle(message))
        .catch((error) => {
        const response = {
            type: message.type === "initialize" ? "error" : "reply",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
        };
        worker_threads_1.parentPort?.postMessage(response);
    });
});
