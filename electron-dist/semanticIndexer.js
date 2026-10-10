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
exports.SemanticIndexer = exports.confidenceSettingToMinimumThreshold = void 0;
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const contentSettings_1 = require("./contentSettings");
const searchSettings_1 = require("./searchSettings");
const indexingPathPolicy_1 = require("./indexingPathPolicy");
const demoLimits_1 = require("./demoLimits");
const persistedVectorIndex_1 = require("./persistedVectorIndex");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const SLOW_EMBEDDING_REQUEST_WARNING_MS = 90000;
class EmbeddingProcessError extends Error {
    constructor(message, nativeImageCrash = false) {
        super(message);
        this.nativeImageCrash = nativeImageCrash;
    }
}
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
const INCREMENTAL_BATCH_SIZE = 250;
function confidenceSettingToMinimumThreshold(confidence) {
    const setting = Number.isFinite(confidence)
        ? Math.max(0, Math.min(100, confidence))
        : searchSettings_1.DEFAULT_SEMANTIC_SEARCH_CONFIDENCE;
    return setting;
}
exports.confidenceSettingToMinimumThreshold = confidenceSettingToMinimumThreshold;
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
function searchTermSet(value) {
    return new Set(value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []);
}
function searchTerms(value) {
    return Array.from(searchTermSet(value));
}
function sanitizeWorkerDiagnosticText(value, limit) {
    if (typeof value !== "string")
        return undefined;
    const sanitized = value
        .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "[path]")
        .trim()
        .slice(0, limit);
    return sanitized || undefined;
}
function sanitizeWorkerDiagnosticStack(value, limit) {
    if (typeof value !== "string")
        return undefined;
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
const initialProgress = {
    status: "idle",
    total: 0,
    indexed: 0,
    remaining: 0,
    errors: 0,
    currentFile: null,
    message: "No index has been started.",
};
class SemanticIndexer {
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
    getSourceCoverageProgress(sourcePaths) {
        const counts = {
            total: 0,
            completed: 0,
            scanning: 0,
            errors: 0,
            unavailable: 0,
            pending: 0,
        };
        const sources = Array.from(new Set(sourcePaths.filter((root) => root.trim()))).map((sourcePath) => {
            if (!this.sourceCoverage.has(sourcePath)) {
                this.sourceCoverage.set(sourcePath, {
                    status: "pending",
                    completedAt: 0,
                    error: "",
                });
            }
            const coverage = this.sourceCoverage.get(sourcePath);
            counts.total += 1;
            if (coverage.status === "error")
                counts.errors += 1;
            else
                counts[coverage.status] += 1;
            return { sourcePath, ...coverage };
        });
        return { ...counts, sources };
    }
    async setSourceCoverage(sourcePath, status, error = "") {
        const previous = this.sourceCoverage.get(sourcePath);
        this.sourceCoverage.set(sourcePath, {
            status,
            error,
            completedAt: status === "completed" ? Date.now() : (previous?.completedAt ?? 0),
        });
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
        await this.coverageWriteQueue;
    }
    constructor(userDataPath, modelCachePath, scanSource, onProgress, onDiagnostic = () => undefined, indexStoragePath = userDataPath) {
        this.canonicalSourcePaths = new Map();
        this.latestRecords = new Map();
        this.latestRecordsByVectorKey = new Map();
        this.persistedVectorIndex = null;
        this.vectorIndexBuildPromise = null;
        this.performanceSettings = (0, contentSettings_1.defaultSearchPerformanceSettings)();
        this.textRecordIds = new Map();
        this.textRecordPaths = [];
        this.textRecordTerms = [];
        this.textPostingTerms = [];
        this.textPostings = new Map();
        this.activeTextSearches = new Set();
        this.indexedRecordListeners = new Set();
        this.backgroundIndexWorkListener = null;
        this.searchEmbeddingCache = new Map();
        this.indexedSearchSnapshotCache = null;
        this.processingPaths = new Set();
        this.demoFileLimit = null;
        this.recordCountsBySource = new Map();
        this.discoveredTotalsBySource = new Map();
        this.workerFailures = new Map();
        this.retryableErrorCountCache = null;
        this.pendingCheckpoint = false;
        this.recoveryFileWriteChain = Promise.resolve();
        this.recoveryFileWriteSequence = 0;
        this.restoredSourcePaths = [];
        this.progress = { ...initialProgress };
        this.clipRuntime = null;
        this.clipRuntimePromise = null;
        this.embeddingWorker = null;
        this.embeddingExitDetails = new WeakMap();
        this.embeddingRequestId = 0;
        this.embeddingRequests = new Map();
        this.inferenceQueue = [];
        this.inferenceSequence = 0;
        this.inferenceActive = false;
        this.activeSearchCount = 0;
        this.vectorIndexWaiterCount = 0;
        this.searchChain = Promise.resolve();
        this.runPromise = null;
        this.queuedSourcePaths = null;
        this.pauseRequested = false;
        this.auditTotal = 0;
        this.auditIndexed = 0;
        this.auditErrors = 0;
        this.sourceCoverage = new Map();
        this.sourcesWithExcludedRecords = new Set();
        this.coverageWriteQueue = Promise.resolve();
        this.summaryWriteQueue = Promise.resolve();
        this.reconciliation = {
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
        this.reconciliationPromise = null;
        this.searchDiscovery = {
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
        // File watching and reconciliation
        this.fileWatchers = new Map(); // sourcePath -> watcher
        this.watchedSources = new Set();
        this.revision = 0;
        this.loaded = Promise.resolve();
        this.loadComplete = true;
        this.writeChain = Promise.resolve();
        this.recordsBoundaryChecked = false;
        this.dirtyWatchSources = new Set();
        this.watchHolds = new Map();
        this.reconciliationTimeout = null;
        this.isWatching = false;
        this.filesToIndex = null; // filePath -> sourcePath for incremental indexing
        this.holdReason = null;
        this.heldSourcePaths = [];
        this.activeSourcePaths = [];
        this.userDataPath = path.resolve(userDataPath);
        this.canonicalUserDataPath = this.userDataPath;
        this.indexDirectory = path.join(indexStoragePath, "semantic-index");
        this.recordsPath = path.join(this.indexDirectory, "records.jsonl");
        this.vectorsPath = path.join(this.indexDirectory, "vectors.bin");
        this.progressPath = path.join(this.indexDirectory, "progress.json");
        this.modelCachePath = modelCachePath;
        this.scanSource = scanSource;
        this.onProgress = onProgress;
        this.onDiagnostic = onDiagnostic;
        this.vectorIndexReady = new Promise((resolve, reject) => {
            this.resolveVectorIndexReady = resolve;
            this.rejectVectorIndexReady = reject;
        });
    }
    setBackgroundIndexWorkListener(listener) {
        this.backgroundIndexWorkListener = listener;
    }
    setPerformanceSettings(settings) {
        this.performanceSettings = { ...settings };
        this.persistedVectorIndex?.updateSettings(this.performanceSettings);
    }
    async initialize(onLoadProgress) {
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
    isLoaded() {
        return this.loadComplete;
    }
    whenLoaded() {
        return this.loaded;
    }
    async prepareVectorSearch(onProgress) {
        await this.loaded;
        if (this.vectorIndexBuildPromise)
            return this.vectorIndexBuildPromise;
        const grouped = new Map();
        const getGroup = (sourcePath, kind) => {
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
        const backgroundYield = async (batchStartedAt) => {
            const workMs = Number(process.hrtime.bigint() - batchStartedAt) / 1000000;
            await new Promise((resolve) => setImmediate(resolve));
            let cooldownMs = Math.ceil(workMs *
                ((100 - this.performanceSettings.backgroundWorkPercent) /
                    this.performanceSettings.backgroundWorkPercent));
            while (cooldownMs > 0 && this.activeSearchCount === 0) {
                const sliceMs = Math.min(50, cooldownMs);
                await new Promise((resolve) => setTimeout(resolve, sliceMs));
                cooldownMs -= sliceMs;
            }
            while (this.activeSearchCount > this.vectorIndexWaiterCount)
                await new Promise((resolve) => setTimeout(resolve, 40));
        };
        // Count first, then allocate only the transferable typed arrays. Keeping a
        // second full set of JS-number arrays here made large libraries spike RSS.
        let processed = 0;
        let batchStartedAt = process.hrtime.bigint();
        for (const [key, record] of this.latestRecordsByVectorKey) {
            const kind = record.type === "image" ? "image" : "document";
            getGroup(record.sourcePath, kind).count += 1;
            processed += 1;
            if (processed % 8192 === 0) {
                await backgroundYield(batchStartedAt);
                batchStartedAt = process.hrtime.bigint();
            }
        }
        for (const byKind of grouped.values())
            for (const group of byKind.values())
                group.keys = new BigUint64Array(group.count);
        processed = 0;
        batchStartedAt = process.hrtime.bigint();
        for (const [key, record] of this.latestRecordsByVectorKey) {
            const kind = record.type === "image" ? "image" : "document";
            const group = getGroup(record.sourcePath, kind);
            group.keys[group.next++] = BigInt(key);
            processed += 1;
            if (processed % 8192 === 0) {
                await backgroundYield(batchStartedAt);
                batchStartedAt = process.hrtime.bigint();
            }
        }
        const groups = [];
        for (const byKind of grouped.values())
            for (const group of byKind.values())
                groups.push({
                    sourcePath: group.sourcePath,
                    kind: group.kind,
                    keys: group.keys,
                });
        grouped.clear();
        this.persistedVectorIndex = new persistedVectorIndex_1.PersistedVectorIndex(this.vectorsPath, path.join(this.indexDirectory, "ann"), onProgress, (error) => this.onDiagnostic("semantic-ann-index-error", { message: error.message }), this.performanceSettings);
        this.vectorIndexBuildPromise = this.persistedVectorIndex
            .initialize(groups)
            .then(() => {
            this.resolveVectorIndexReady();
        })
            .catch((error) => {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.rejectVectorIndexReady(normalized);
            throw normalized;
        });
        return this.vectorIndexBuildPromise;
    }
    async flushVectorSearch() {
        await this.persistedVectorIndex?.shutdown(6500);
    }
    beginInteractiveSearch() {
        this.activeSearchCount += 1;
    }
    endInteractiveSearch() {
        this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
    }
    async openIndex(onLoadProgress) {
        await fsPromises.mkdir(this.indexDirectory, { recursive: true });
        this.canonicalUserDataPath = await fsPromises
            .realpath(this.userDataPath)
            .catch(() => this.userDataPath);
        await this.loadRecords(onLoadProgress);
        await this.loadWorkerRecovery();
        try {
            const saved = JSON.parse(await fsPromises.readFile(path.join(this.indexDirectory, "discovered-totals.json"), "utf8"));
            for (const entry of saved.sources ?? []) {
                if (Array.isArray(entry) &&
                    entry.length === 2 &&
                    typeof entry[0] === "string" &&
                    entry[0].trim() &&
                    Number.isSafeInteger(entry[1]) &&
                    entry[1] >= 0)
                    this.discoveredTotalsBySource.set(entry[0], entry[1]);
            }
            let totalsChanged = false;
            for (const sourcePath of this.sourcesWithExcludedRecords)
                totalsChanged = this.discoveredTotalsBySource.delete(sourcePath) || totalsChanged;
            if (totalsChanged)
                await this.persistDiscoveredTotals();
        }
        catch {
            /* Missing or invalid totals are reconstructed by recursive discovery. */
        }
        try {
            const saved = JSON.parse(await fsPromises.readFile(path.join(this.indexDirectory, "coverage.json"), "utf8"));
            for (const [root, coverage] of saved.sources ?? []) {
                if (typeof root !== "string" ||
                    !root.trim() ||
                    !coverage ||
                    ![
                        "pending",
                        "scanning",
                        "completed",
                        "error",
                        "unavailable",
                    ].includes(coverage.status))
                    continue;
                const completedAt = Number(coverage.completedAt) || 0;
                this.sourceCoverage.set(root, {
                    status: coverage.status === "scanning" ||
                        (coverage.status === "completed" && !completedAt)
                        ? "pending"
                        : coverage.status,
                    completedAt,
                    error: typeof coverage.error === "string" ? coverage.error : "",
                });
            }
        }
        catch {
            /* Missing / invalid coverage never implies successful discovery. */
        }
        try {
            this.progress = {
                ...initialProgress,
                ...JSON.parse(await fsPromises.readFile(this.progressPath, "utf8")),
            };
            if (["scanning", "loading-model", "indexing"].includes(this.progress.status)) {
                this.progress.status = "paused";
                this.progress.message =
                    "Indexing was interrupted and is ready to resume.";
            }
        }
        catch {
            await this.persistProgress();
        }
    }
    getProgress() {
        return { ...this.progress };
    }
    isSearchActive() {
        return this.activeSearchCount > 0;
    }
    setDemoFileLimit(limit) {
        this.demoFileLimit = limit;
    }
    demoFilePaths(sourcePaths) {
        if (this.demoFileLimit === null)
            return null;
        const activeSources = new Set(this.watchedSources.size > 0
            ? [...this.watchedSources, ...sourcePaths]
            : sourcePaths);
        const eligible = Array.from(this.latestRecords.values()).filter((record) => activeSources.has(record.sourcePath) &&
            this.isIndexable(record, record.sourcePath));
        return (0, demoLimits_1.selectDemoFilePaths)(eligible, Array.from(activeSources), this.demoFileLimit);
    }
    /** Cumulative counts from all current records, not just the active indexing batch. */
    getIndexSummary(sourcePaths) {
        if (this.demoFileLimit !== null) {
            const roots = sourcePaths ?? Array.from(this.recordCountsBySource.keys());
            const allowedPaths = this.demoFilePaths(roots) ?? new Set();
            const records = Array.from(this.latestRecords.values()).filter((record) => allowedPaths.has(record.path));
            let discoveredTotal = 0;
            const activeRoots = new Set(roots);
            for (const [sourcePath, count] of this.discoveredTotalsBySource)
                if (activeRoots.has(sourcePath))
                    discoveredTotal += count;
            const indexed = records.filter((record) => record.vectorOffset >= 0).length;
            const errors = records.filter((record) => record.vectorOffset < 0 && record.error).length;
            const total = Math.min(this.demoFileLimit, Math.max(discoveredTotal, indexed + errors));
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
            if (roots && !roots.has(sourcePath))
                continue;
            indexed += counts.indexed;
            errors += counts.errors;
        }
        for (const [sourcePath, count] of this.discoveredTotalsBySource) {
            if (roots && !roots.has(sourcePath))
                continue;
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
    getRetryableFiles(sourcePaths) {
        const roots = new Set(sourcePaths);
        const demoPaths = this.demoFilePaths(sourcePaths);
        const changedFiles = new Map();
        for (const record of this.latestRecords.values())
            if (roots.has(record.sourcePath) &&
                (!demoPaths || demoPaths.has(record.path)) &&
                this.shouldRetryFailure(record))
                changedFiles.set(record.path, record.sourcePath);
        return changedFiles;
    }
    getSourceCoverageErrors(sourcePaths) {
        return this.getSourceCoverageProgress(sourcePaths).sources
            .filter((source) => source.status === "error")
            .map((source) => source.sourcePath);
    }
    hasPendingIndexWork() {
        return Boolean(this.filesToIndex?.size || this.restoredSourcePaths.length);
    }
    getRetryableErrorCount(sourcePaths) {
        const sourceKey = Array.from(new Set(sourcePaths)).sort().join("\0");
        const now = Date.now();
        if (this.retryableErrorCountCache?.sourceKey === sourceKey &&
            now - this.retryableErrorCountCache.calculatedAt < 1000)
            return this.retryableErrorCountCache.count;
        const roots = new Set(sourcePaths);
        const demoPaths = this.demoFilePaths(sourcePaths);
        let count = 0;
        for (const record of this.latestRecords.values())
            if (roots.has(record.sourcePath) &&
                (!demoPaths || demoPaths.has(record.path)) &&
                this.shouldRetryFailure(record))
                count += 1;
        this.retryableErrorCountCache = { sourceKey, calculatedAt: now, count };
        return count;
    }
    updateRecordCounts(record, direction) {
        let counts = this.recordCountsBySource.get(record.sourcePath);
        if (!counts) {
            counts = { total: 0, indexed: 0, errors: 0 };
            this.recordCountsBySource.set(record.sourcePath, counts);
        }
        if (record.vectorOffset >= 0) {
            counts.total += direction;
            counts.indexed += direction;
        }
        else if (record.error) {
            counts.total += direction;
            counts.errors += direction;
        }
        if (counts.total <= 0)
            this.recordCountsBySource.delete(record.sourcePath);
    }
    setLatestRecord(record, replaceExisting = true) {
        const previous = replaceExisting
            ? this.latestRecords.get(record.path)
            : undefined;
        if (previous)
            this.updateRecordCounts(previous, -1);
        this.latestRecords.set(record.path, record);
        this.updateRecordCounts(record, 1);
        if (previous && previous.vectorOffset >= 0) {
            const previousKey = previous.vectorOffset / VECTOR_BYTES;
            if (this.latestRecordsByVectorKey.get(previousKey)?.path === previous.path)
                this.latestRecordsByVectorKey.delete(previousKey);
            if (this.persistedVectorIndex)
                this.persistedVectorIndex.remove(previous.sourcePath, previous.type === "image" ? "image" : "document", previousKey);
        }
        if (record.vectorOffset >= 0) {
            const vectorKey = record.vectorOffset / VECTOR_BYTES;
            this.latestRecordsByVectorKey.set(vectorKey, record);
            this.persistedVectorIndex?.upsert(record.sourcePath, record.type === "image" ? "image" : "document", vectorKey);
        }
        const recordId = this.indexSearchableText(record);
        for (const search of this.activeTextSearches)
            this.considerTextSearchRecord(search, recordId, record);
        this.revision += 1;
        if (record.vectorOffset >= 0)
            for (const listener of this.indexedRecordListeners)
                listener(record);
    }
    indexSearchableText(record) {
        let recordId = this.textRecordIds.get(record.path);
        if (recordId === undefined) {
            recordId = this.textRecordPaths.length;
            this.textRecordIds.set(record.path, recordId);
            this.textRecordPaths.push(record.path);
            this.textRecordTerms.push(new Set());
            this.textPostingTerms.push(new Set());
        }
        const currentTermSet = searchTermSet(`${record.name} ${record.relativePath}`);
        const indexedTerms = this.textPostingTerms[recordId];
        // Replace the current set before extending postings: unchanged records may
        // share these sets, while postings retain terms from older path versions.
        this.textRecordTerms[recordId] = currentTermSet;
        for (const term of currentTermSet) {
            if (indexedTerms.has(term))
                continue;
            indexedTerms.add(term);
            const posting = this.textPostings.get(term) ?? [];
            posting.push(recordId);
            this.textPostings.set(term, posting);
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
    considerTextSearchRecord(search, recordId, record) {
        if (search.seenRecordIds.has(recordId))
            return;
        search.seenRecordIds.add(recordId);
        search.scanned += 1;
        if (!search.sourcePaths.has(record.sourcePath) ||
            !this.isIndexable(record, record.sourcePath) ||
            (search.demoPaths && !search.demoPaths.has(record.path)))
            return;
        const terms = this.textRecordTerms[recordId];
        if (!terms || !search.queryTerms.every((term) => terms.has(term)))
            return;
        if (search.matches.length >= SEARCH_TEXT_RESULT_LIMIT) {
            search.capped = true;
            return;
        }
        const file = {
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
        if (search.matches.length === 1 ||
            search.batch.length >= 64 ||
            now - search.lastPublishedAt >= 50)
            this.publishTextSearchBatch(search);
    }
    publishTextSearchBatch(search) {
        search.onMatches?.(search.batch.splice(0), search.scanned, this.latestRecords.size, search.capped);
        search.lastPublishedAt = Date.now();
    }
    onTextSearchProgress(search, force) {
        const now = Date.now();
        if (force || now - search.lastPublishedAt >= 50)
            search.onMatches?.([], search.scanned, this.latestRecords.size, search.capped);
        search.lastPublishedAt = now;
    }
    deleteLatestRecord(filePath) {
        const previous = this.latestRecords.get(filePath);
        if (!previous)
            return;
        this.latestRecords.delete(filePath);
        this.updateRecordCounts(previous, -1);
        if (previous.vectorOffset >= 0) {
            const vectorKey = previous.vectorOffset / VECTOR_BYTES;
            if (this.latestRecordsByVectorKey.get(vectorKey)?.path === previous.path)
                this.latestRecordsByVectorKey.delete(vectorKey);
            this.persistedVectorIndex?.remove(previous.sourcePath, previous.type === "image" ? "image" : "document", vectorKey);
        }
        this.revision += 1;
    }
    /** Changes whenever any indexed record is added, changed, reindexed or removed. */
    getRevision() {
        return this.revision;
    }
    /** Embedded images with their root and signature, for incremental consumers. */
    getIndexedImageRecords(sourcePaths) {
        const activeSources = new Set(sourcePaths);
        const demoPaths = this.demoFilePaths(sourcePaths);
        const result = [];
        for (const record of this.latestRecords.values())
            if (record.type === "image" && record.vectorOffset >= 0 && activeSources.has(record.sourcePath)
                && this.isIndexable(record, record.sourcePath) && (!demoPaths || demoPaths.has(record.path)))
                result.push({ path: record.path, sourcePath: record.sourcePath, size: record.size,
                    modified: record.modified, signature: record.signature });
        return result;
    }
    async persistDiscoveredTotals() {
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
        await this.summaryWriteQueue;
    }
    getIndexedImages(sourcePaths) {
        const activeSources = new Set(sourcePaths);
        const demoPaths = this.demoFilePaths(sourcePaths);
        return Array.from(this.latestRecords.values())
            .filter((record) => record.type === "image" &&
            activeSources.has(record.sourcePath) &&
            this.isIndexable(record, record.sourcePath) &&
            (!demoPaths || demoPaths.has(record.path)))
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
    getIndexedFiles(sourcePaths) {
        const activeSources = new Set(sourcePaths);
        const demoPaths = this.demoFilePaths(sourcePaths);
        return Array.from(this.latestRecords.values())
            .filter((record) => activeSources.has(record.sourcePath) &&
            this.isIndexable(record, record.sourcePath) &&
            (!demoPaths || demoPaths.has(record.path)))
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
    start(sourcePaths, changedFiles) {
        // Work requested while the saved index is still opening would re-embed known files.
        if (!this.loadComplete)
            return this.loaded.then(() => this.start(sourcePaths, changedFiles));
        if (this.holdReason) {
            this.heldSourcePaths = Array.from(new Set([...this.heldSourcePaths, ...sourcePaths]));
            return this.updateProgress({ status: "paused", message: this.holdReason }, true);
        }
        this.pauseRequested = false;
        const restoredSources = [...this.restoredSourcePaths];
        const requestedSources = Array.from(new Set([...restoredSources, ...sourcePaths]));
        this.restoredSourcePaths = [];
        if (changedFiles) {
            if (!this.filesToIndex)
                this.filesToIndex = new Map();
            for (const [filePath, sourcePath] of changedFiles) {
                this.filesToIndex.set(filePath, sourcePath);
            }
        }
        let resumeFullScanAfterPendingQueue = Boolean(this.filesToIndex?.size) && restoredSources.length > 0;
        if (this.runPromise) {
            this.queuedSourcePaths = Array.from(new Set([...(this.queuedSourcePaths ?? []), ...requestedSources]));
            return this.runPromise;
        }
        console.log("[SemanticIndexer] Starting indexing with sources:", requestedSources);
        // Defer the run body until after runPromise is registered. A checkpoint or
        // progress callback may request another start synchronously during setup.
        const runPromise = Promise.resolve().then(async () => {
            let nextSourcePaths = requestedSources;
            try {
                await this.checkpointPendingWork(requestedSources, true);
                while (nextSourcePaths !== null && !this.pauseRequested) {
                    this.queuedSourcePaths = null;
                    this.activeSourcePaths = nextSourcePaths;
                    await this.run(nextSourcePaths);
                    if (this.progress.status === "error") {
                        nextSourcePaths = null;
                    }
                    else if (this.queuedSourcePaths !== null) {
                        nextSourcePaths = this.queuedSourcePaths;
                    }
                    else if (this.filesToIndex?.size) {
                        nextSourcePaths = this.activeSourcePaths.length
                            ? this.activeSourcePaths
                            : requestedSources;
                    }
                    else if (resumeFullScanAfterPendingQueue) {
                        resumeFullScanAfterPendingQueue = false;
                        nextSourcePaths = requestedSources;
                    }
                    else {
                        nextSourcePaths = null;
                    }
                }
            }
            finally {
                this.runPromise = null;
                this.queuedSourcePaths = null;
                this.activeSourcePaths = [];
            }
        });
        this.runPromise = runPromise;
        return runPromise;
    }
    async startFullScan(sourcePaths) {
        await this.loaded;
        while (this.runPromise)
            await this.runPromise;
        this.filesToIndex = null;
        this.queuedSourcePaths = null;
        await this.start(sourcePaths);
    }
    async pause() {
        const interruptedSources = Array.from(new Set([
            ...this.activeSourcePaths,
            ...(this.queuedSourcePaths ?? []),
            ...this.restoredSourcePaths,
            ...Array.from(this.filesToIndex?.values() ?? []),
        ]));
        this.pauseRequested = true;
        this.queuedSourcePaths = null;
        if (this.runPromise)
            await this.runPromise.catch(() => undefined);
        if (interruptedSources.length || this.filesToIndex?.size)
            await this.checkpointPendingWork(interruptedSources, true);
        if (!this.runPromise) {
            await this.updateProgress({ status: "paused", message: this.holdReason ?? "Indexing paused." }, true);
        }
    }
    /**
     * Block indexing for a system reason (memory pressure, cache drive missing). Running
     * work stops at its next checkpoint; everything indexed so far is already persisted.
     * Returns the sources that were interrupted or requested while held so the caller
     * can resume them once the hold is released.
     */
    async setHold(reason) {
        if (reason) {
            const wasHeld = this.holdReason !== null;
            this.holdReason = reason;
            if (!wasHeld && this.runPromise) {
                this.heldSourcePaths = Array.from(new Set([...this.heldSourcePaths, ...this.activeSourcePaths, ...(this.queuedSourcePaths ?? [])]));
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
    async startWatching(sourcePaths) {
        const appDataPath = this.userDataPath;
        const canonicalAppDataPath = await fsPromises
            .realpath(appDataPath)
            .catch(() => appDataPath);
        const requestedSources = new Set();
        const canonicalSourcePaths = new Map();
        this.canonicalSourcePaths.clear();
        for (const sourcePath of sourcePaths) {
            if (this.isRemotePath(sourcePath)) {
                requestedSources.add(sourcePath);
                continue;
            }
            const canonicalSourcePath = await fsPromises
                .realpath(sourcePath)
                .catch(() => path.resolve(sourcePath));
            if ((0, indexingPathPolicy_1.isNonLibraryPath)(sourcePath) ||
                (0, indexingPathPolicy_1.isAppDataPath)(sourcePath, sourcePath, canonicalSourcePath, appDataPath, canonicalAppDataPath))
                continue;
            if (await (0, indexingPathPolicy_1.isSiloCloneDirectory)(sourcePath))
                continue;
            requestedSources.add(sourcePath);
            canonicalSourcePaths.set(sourcePath, canonicalSourcePath);
            this.canonicalSourcePaths.set(sourcePath, canonicalSourcePath);
        }
        for (const [sourcePath, watcher] of this.fileWatchers) {
            if (!requestedSources.has(sourcePath)) {
                watcher.close();
                this.fileWatchers.delete(sourcePath);
            }
        }
        this.watchedSources = requestedSources;
        this.isWatching = false;
        console.log("[SemanticIndexer] Starting file watches for sources:", sourcePaths);
        for (const sourcePath of requestedSources) {
            // Skip if already watching or if path is remote (phone/cloud)
            if (this.fileWatchers.has(sourcePath) || this.isRemotePath(sourcePath)) {
                continue;
            }
            try {
                await fsPromises.access(sourcePath, fs.constants.R_OK);
                const canonicalSourcePath = canonicalSourcePaths.get(sourcePath) ?? path.resolve(sourcePath);
                const watcher = fs.watch(sourcePath, { recursive: true, persistent: false }, (eventType, fileName) => {
                    if (!fileName)
                        return; // Some events don't have a filename
                    const changedPath = path.resolve(sourcePath, fileName.toString());
                    void (async () => {
                        if ((0, indexingPathPolicy_1.isNonLibraryPath)(changedPath) ||
                            (0, indexingPathPolicy_1.isAppDataPath)(changedPath, sourcePath, canonicalSourcePath, appDataPath, canonicalAppDataPath) ||
                            (await (0, indexingPathPolicy_1.isWithinSiloClone)(changedPath, sourcePath)))
                            return;
                        this.dirtyWatchSources.add(sourcePath);
                        // Writes below a held path (an active phone backup) wait for release.
                        if (this.isHeld(changedPath))
                            return;
                        this.scheduleReconciliation();
                    })();
                });
                watcher.on("error", (error) => {
                    console.log(`[SemanticIndexer] Watch error for ${sourcePath}:`, error.message);
                    // Continue watching, errors are often transient
                });
                this.fileWatchers.set(sourcePath, watcher);
                this.isWatching = true;
                console.log(`[SemanticIndexer] Watching source: ${sourcePath}`);
            }
            catch (error) {
                console.log(`[SemanticIndexer] Cannot watch source (may be unavailable): ${sourcePath}`, error instanceof Error ? error.message : "");
                // Source is unavailable - don't delete index, just skip watching
            }
        }
    }
    /**
     * Stop watching all sources for file changes.
     */
    stopWatching() {
        console.log("[SemanticIndexer] Stopping file watches");
        for (const [sourcePath, watcher] of this.fileWatchers) {
            try {
                watcher.close();
            }
            catch (error) {
                console.log(`[SemanticIndexer] Error closing watcher for ${sourcePath}:`, error);
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
    async reconcileIndex(sourcePaths, onSourceReady) {
        await this.loaded;
        if (this.reconciliationPromise) {
            await this.reconciliationPromise;
            return this.reconcileIndex(sourcePaths, onSourceReady);
        }
        const pending = this.runReconciliation(sourcePaths, onSourceReady).finally(() => {
            this.reconciliationPromise = null;
        });
        this.reconciliationPromise = pending;
        return pending;
    }
    async runReconciliation(sourcePaths, onSourceReady) {
        sourcePaths = Array.from(new Set(sourcePaths));
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
            const changesFound = new Map(); // filePath -> sourcePath
            const deletedPaths = [];
            const seenFiles = new Set(); // files found on disk
            const accessibleSources = new Set();
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
                if (this.isRemotePath(sourcePath))
                    continue;
                if (!(await this.isSourceAccessible(sourcePath))) {
                    await this.setSourceCoverage(sourcePath, "unavailable");
                    continue;
                }
                this.canonicalSourcePaths.set(sourcePath, await fsPromises.realpath(sourcePath).catch(() => path.resolve(sourcePath)));
                await this.setSourceCoverage(sourcePath, "scanning");
                const previousDiscoveredTotal = this.discoveredTotalsBySource.get(sourcePath);
                let sourceFileCount = 0;
                try {
                    await this.scanSourceForReconciliation(sourcePath, (file) => {
                        this.reconciliation.scanned += 1;
                        seenFiles.add(file.path);
                        if (!this.isIndexable(file, sourcePath))
                            return;
                        auditTotal += 1;
                        sourceFileCount += 1;
                        const stored = this.latestRecords.get(file.path);
                        const currentSig = this.signature(file);
                        // File is new or modified
                        if (!stored ||
                            stored.signature !== currentSig ||
                            this.shouldRetryFailure(stored)) {
                            changesFound.set(file.path, sourcePath);
                            this.reconciliation.changed = changesFound.size;
                        }
                        else if (stored.vectorOffset >= 0) {
                            auditIndexed += 1;
                        }
                        else if (stored.error) {
                            auditErrors += 1;
                        }
                    });
                }
                catch (error) {
                    this.reconciliation.error =
                        error instanceof Error ? error.message : String(error);
                    if (previousDiscoveredTotal === undefined)
                        this.discoveredTotalsBySource.delete(sourcePath);
                    else
                        this.discoveredTotalsBySource.set(sourcePath, previousDiscoveredTotal);
                    await this.setSourceCoverage(sourcePath, "error", this.reconciliation.error);
                    continue;
                }
                this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
                await this.persistDiscoveredTotals();
                await this.setSourceCoverage(sourcePath, "completed");
                accessibleSources.add(sourcePath);
                // Begin embeddings from finished sources while later roots are still
                // being inventoried. start() coalesces work without re-embedding successes.
                const sourceChanges = new Map(Array.from(changesFound).filter(([, root]) => root === sourcePath));
                if (sourceChanges.size)
                    onSourceReady?.(sourceChanges);
            }
            // Check for deleted files (in index but not on disk)
            for (const [filePath, record] of this.latestRecords.entries()) {
                if (!accessibleSources.has(record.sourcePath))
                    continue;
                // Legacy records of phone thumbnails/caches are retired too.
                const derivative = (0, indexingPathPolicy_1.isPhoneDerivativePath)(filePath);
                if (derivative || (!seenFiles.has(filePath) && this.isIndexable(record, record.sourcePath))) {
                    this.deleteLatestRecord(filePath);
                    deletedPaths.push(filePath);
                }
            }
            if (deletedPaths.length > 0) {
                await this.appendLines(deletedPaths.map((filePath) => JSON.stringify({ path: filePath, deleted: true })));
                console.log(`[SemanticIndexer] Reconciliation removed ${deletedPaths.length} deleted files`);
            }
            if (changesFound.size > 0) {
                console.log(`[SemanticIndexer] Reconciliation found ${changesFound.size} files to re-index`);
            }
            // A watcher pass over a few changed roots must not shrink library-wide totals.
            const coversLibrary = Array.from(this.watchedSources).every((sourcePath) => this.isRemotePath(sourcePath) || sourcePaths.includes(sourcePath));
            if (!coversLibrary)
                return changesFound;
            this.auditTotal = auditTotal;
            this.auditIndexed = auditIndexed;
            this.auditErrors = auditErrors;
            if (!this.runPromise)
                await this.updateProgress({
                    total: auditTotal,
                    indexed: auditIndexed,
                    remaining: changesFound.size,
                    errors: auditErrors,
                    message: `${auditIndexed.toLocaleString()} of ${auditTotal.toLocaleString()} original files have CLIP embeddings.`,
                }, true);
            return changesFound;
        }
        catch (error) {
            console.error("[SemanticIndexer] Reconciliation error:", error);
            this.reconciliation.error =
                error instanceof Error ? error.message : String(error);
            throw error;
        }
        finally {
            this.reconciliation.running = false;
        }
    }
    /**
     * Returns true if this is a remote path (phone or cloud) that requires special handling.
     */
    isRemotePath(sourcePath) {
        return (sourcePath.startsWith("/__phone__/") ||
            sourcePath.startsWith("/__phone_backup__/") ||
            sourcePath.startsWith("/__cloud__/"));
    }
    /**
     * Check if a source folder is currently accessible.
     */
    async isSourceAccessible(sourcePath) {
        if (this.isRemotePath(sourcePath)) {
            // Remote paths are handled differently, assume accessible for now
            return true;
        }
        try {
            await fsPromises.access(sourcePath, fs.constants.R_OK);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Scan a source specifically for reconciliation (just file list, not full recursive scan).
     */
    async scanSourceForReconciliation(sourcePath, onFile) {
        // Use the standard scanSource for now, but could be optimized
        // to use a shallow scan for reconciliation
        await this.scanSource(sourcePath, onFile, () => false, () => this.activeSearchCount > 0);
    }
    /**
     * Schedule reconciliation to run after a debounce period.
     * Prevents excessive reconciliation from rapid file changes.
     */
    scheduleReconciliation() {
        if (this.reconciliationTimeout) {
            clearTimeout(this.reconciliationTimeout);
        }
        this.reconciliationTimeout = setTimeout(async () => {
            this.reconciliationTimeout = null;
            // Only roots that actually changed are rescanned, and never while their writes are held.
            const sources = Array.from(this.dirtyWatchSources).filter((sourcePath) => this.watchedSources.has(sourcePath) && !this.isHeld(sourcePath, true));
            if (sources.length === 0)
                return;
            sources.forEach((sourcePath) => this.dirtyWatchSources.delete(sourcePath));
            console.log("[SemanticIndexer] Running debounced reconciliation for", sources.length, "changed source(s)");
            const changedFiles = await this.reconcileIndex(sources);
            if (changedFiles.size > 0) {
                console.log(`[SemanticIndexer] Queueing ${changedFiles.size} changed files for incremental indexing`);
                this.backgroundIndexWorkListener?.(changedFiles);
            }
        }, RECONCILIATION_DEBOUNCE_MS);
    }
    /** True when candidate lies inside a held path (or, with containsHold, a source holds one). */
    isHeld(candidate, containsHold = false) {
        for (const held of this.watchHolds.keys())
            if ((0, indexingPathPolicy_1.isPathWithin)(candidate, held) || (containsHold && (0, indexingPathPolicy_1.isPathWithin)(held, candidate)))
                return true;
        return false;
    }
    /**
     * Suspends watcher-driven rescans for a folder that is being bulk-written (phone backups).
     * Release reconciles affected sources once, so new files are indexed exactly one time.
     */
    holdWatchReconciliation(folder) {
        const key = path.resolve(folder);
        this.watchHolds.set(key, (this.watchHolds.get(key) ?? 0) + 1);
    }
    releaseWatchReconciliation(folder) {
        const key = path.resolve(folder);
        const count = (this.watchHolds.get(key) ?? 0) - 1;
        if (count > 0) {
            this.watchHolds.set(key, count);
            return;
        }
        this.watchHolds.delete(key);
        for (const sourcePath of this.watchedSources)
            if (!this.isRemotePath(sourcePath) && ((0, indexingPathPolicy_1.isPathWithin)(key, sourcePath) || (0, indexingPathPolicy_1.isPathWithin)(sourcePath, key)))
                this.dirtyWatchSources.add(sourcePath);
        if (this.dirtyWatchSources.size)
            this.scheduleReconciliation();
    }
    /**
     * Get the current watch status for UI display.
     */
    getWatchStatus() {
        return {
            isWatching: this.isWatching,
            watchedSourceCount: this.watchedSources.size,
        };
    }
    async preloadClipModel() {
        // Pre-load the CLIP model to avoid delays on first search
        await this.loadClipRuntime();
    }
    async search(query, minimumConfidence, sourcePaths, isCancelled = () => false, onSearchProgress) {
        const confidenceThreshold = Number.isFinite(minimumConfidence)
            ? Math.max(0, Math.min(100, minimumConfidence))
            : 0;
        await this.loaded;
        // Searches temporarily take priority between background embeddings while
        // results are ranked. Searches waiting for vector readiness are tracked
        // separately so vector-index construction can finish.
        this.activeSearchCount += 1;
        try {
            return await this.runSearch(query, confidenceThreshold, sourcePaths, isCancelled, onSearchProgress);
        }
        finally {
            this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
        }
    }
    /**
     * Stream filename and path matches from the loaded index before CLIP finishes
     * embedding or scoring a query.
     */
    async searchTextMatches(query, sourcePaths, isCancelled = () => false, onMatches) {
        const queryTerms = searchTerms(query);
        if (!queryTerms.length || sourcePaths.length === 0 || isCancelled())
            return [];
        if (isCancelled())
            return [];
        const search = {
            queryTerms,
            sourcePaths: new Set(sourcePaths),
            demoPaths: this.demoFilePaths(sourcePaths),
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
            const postings = queryTerms
                .map((term) => this.textPostings.get(term) ?? [])
                .sort((first, second) => first.length - second.length);
            const candidates = postings[0] ?? [];
            if (this.loadComplete && queryTerms.some((_, index) => postings[index].length === 0))
                return [];
            this.beginInteractiveSearch();
            try {
                let index = 0;
                while (!isCancelled() && !search.capped) {
                    while (index < candidates.length && !isCancelled() && !search.capped) {
                        const recordId = candidates[index++];
                        const record = this.latestRecords.get(this.textRecordPaths[recordId]);
                        if (record &&
                            queryTerms.every((term) => this.textRecordTerms[recordId].has(term)))
                            this.considerTextSearchRecord(search, recordId, record);
                        if (index > 0 && index % 512 === 0) {
                            this.onTextSearchProgress(search, false);
                            await new Promise((resolve) => setImmediate(resolve));
                        }
                    }
                    if (this.loadComplete || isCancelled() || search.capped)
                        break;
                    this.onTextSearchProgress(search, false);
                    await new Promise((resolve) => setTimeout(resolve, 40));
                }
                if (search.batch.length || search.capped)
                    this.publishTextSearchBatch(search);
                return search.matches;
            }
            finally {
                this.endInteractiveSearch();
            }
        }
        finally {
            this.activeTextSearches.delete(search);
        }
    }
    classifyUnsafeImages(sourcePaths, unsafePrompt, safePrompt) {
        const result = this.searchChain.then(async () => {
            if (sourcePaths.length === 0 || this.latestRecords.size === 0)
                return [];
            const runtime = await this.loadClipRuntime();
            const unsafeVector = await this.embedText(`a photo of ${unsafePrompt}`, runtime);
            const safeVector = await this.embedText(`a photo of ${safePrompt}`, runtime);
            const vectorBuffer = await fsPromises
                .readFile(this.vectorsPath)
                .catch(() => Buffer.alloc(0));
            if (vectorBuffer.byteLength < VECTOR_BYTES)
                return [];
            const vectors = new Float32Array(vectorBuffer.buffer, vectorBuffer.byteOffset, Math.floor(vectorBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT));
            const activeSources = new Set(sourcePaths);
            const demoPaths = this.demoFilePaths(sourcePaths);
            const unsafePaths = [];
            let checkedImages = 0;
            for (const record of this.latestRecords.values()) {
                if (record.type !== "image" ||
                    record.vectorOffset < 0 ||
                    !activeSources.has(record.sourcePath) ||
                    (demoPaths && !demoPaths.has(record.path)))
                    continue;
                const vectorStart = record.vectorOffset / Float32Array.BYTES_PER_ELEMENT;
                let unsafeSimilarity = 0;
                let safeSimilarity = 0;
                for (let index = 0; index < VECTOR_SIZE; index += 1) {
                    const value = vectors[vectorStart + index];
                    unsafeSimilarity += unsafeVector[index] * value;
                    safeSimilarity += safeVector[index] * value;
                }
                if (unsafeSimilarity >= 0.2 &&
                    unsafeSimilarity - safeSimilarity >= 0.008)
                    unsafePaths.push(record.path);
                checkedImages += 1;
                if (checkedImages % 1000 === 0)
                    await new Promise((resolve) => setImmediate(resolve));
            }
            return unsafePaths;
        });
        this.searchChain = result.then(() => undefined, () => undefined);
        return result;
    }
    /** CLIP text embeddings for prompts, computed locally. */
    async embedPreviewImage(filePath) {
        const runtime = await this.loadClipRuntime();
        return this.embedImage(filePath, runtime);
    }
    async embedPrompts(prompts) {
        const runtime = await this.loadClipRuntime();
        const vectors = [];
        for (const prompt of prompts)
            vectors.push(await this.embedText(prompt, runtime));
        return vectors;
    }
    /** Stored image embeddings for specific paths, read by offset so the whole vector file isn't loaded. */
    async getImageVectors(paths) {
        await this.loaded;
        const vectors = new Map();
        const sourcePaths = Array.from(new Set(Array.from(this.latestRecords.values(), (record) => record.sourcePath)));
        const demoPaths = this.demoFilePaths(sourcePaths);
        const handle = await fsPromises
            .open(this.vectorsPath, "r")
            .catch(() => null);
        if (!handle)
            return vectors;
        try {
            for (const filePath of paths) {
                if (demoPaths && !demoPaths.has(filePath))
                    continue;
                const record = this.latestRecords.get(filePath);
                if (!record || record.type !== "image" || record.vectorOffset < 0)
                    continue;
                const buffer = Buffer.alloc(VECTOR_BYTES);
                const { bytesRead } = await handle.read(buffer, 0, VECTOR_BYTES, record.vectorOffset);
                if (bytesRead === VECTOR_BYTES)
                    vectors.set(filePath, new Float32Array(buffer.buffer, buffer.byteOffset, VECTOR_SIZE));
            }
        }
        finally {
            await handle.close();
        }
        return vectors;
    }
    /**
     * Assigns a bounded random sample of indexed photos to whichever prompt fits best.
     * Counts reveal what a library is mostly about; matches are best-first per prompt.
     * Reads only sampled vectors by offset and yields regularly to keep main responsive.
     */
    classifyImageConcepts(prompts, sourcePaths, options = {}) {
        const result = this.searchChain.then(async () => {
            const sampleLimit = options.sampleLimit ?? 20000;
            const topPerPrompt = options.topPerPrompt ?? 240;
            const minimumSimilarity = options.minimumSimilarity ?? 0.2;
            const output = prompts.map(() => ({ count: 0, matches: [] }));
            const activeSources = new Set(sourcePaths);
            const demoPaths = this.demoFilePaths(sourcePaths);
            const eligible = [];
            for (const record of this.latestRecords.values())
                if (record.type === "image" && record.vectorOffset >= 0 && activeSources.has(record.sourcePath)
                    && this.isIndexable(record, record.sourcePath) && (!demoPaths || demoPaths.has(record.path))
                    && (!options.include || options.include(record)))
                    eligible.push(record);
            if (!eligible.length || !prompts.length)
                return output;
            const stride = Math.max(1, Math.ceil(eligible.length / sampleLimit));
            const offset = Math.floor(Math.random() * stride);
            const sample = [];
            for (let index = offset; index < eligible.length; index += stride)
                sample.push(eligible[index]);
            sample.sort((a, b) => a.vectorOffset - b.vectorOffset);
            const runtime = await this.loadClipRuntime();
            const promptVectors = [];
            for (const prompt of prompts)
                promptVectors.push(await this.embedText(prompt, runtime));
            const handle = await fsPromises.open(this.vectorsPath, "r").catch(() => null);
            if (!handle)
                return output;
            const trim = (list) => {
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
                        if (!buffer)
                            continue;
                        const vector = new Float32Array(buffer.buffer, buffer.byteOffset, VECTOR_SIZE);
                        let best = -1;
                        let bestSimilarity = -Infinity;
                        for (let prompt = 0; prompt < promptVectors.length; prompt++) {
                            const query = promptVectors[prompt];
                            let similarity = 0;
                            for (let dimension = 0; dimension < VECTOR_SIZE; dimension++)
                                similarity += query[dimension] * vector[dimension];
                            if (similarity > bestSimilarity) {
                                bestSimilarity = similarity;
                                best = prompt;
                            }
                        }
                        if (best < 0 || bestSimilarity < minimumSimilarity)
                            continue;
                        const entry = output[best];
                        entry.count += 1;
                        entry.matches.push({ path: batch[index].path, similarity: bestSimilarity });
                        if (entry.matches.length > topPerPrompt * 2)
                            trim(entry.matches);
                    }
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }
            finally {
                await handle.close();
            }
            output.forEach((entry) => trim(entry.matches));
            return output;
        });
        this.searchChain = result.then(() => undefined, () => undefined);
        return result;
    }
    async runSearch(query, minimumConfidence, sourcePaths, isCancelled, onSearchProgress) {
        const cleanQuery = query.trim();
        if (isCancelled() || !cleanQuery || sourcePaths.length === 0)
            return [];
        const runtime = await this.loadClipRuntime();
        if (isCancelled())
            return [];
        const embeddingKey = cleanQuery.toLowerCase();
        let searchEmbeddings = this.searchEmbeddingCache.get(embeddingKey);
        if (searchEmbeddings) {
            this.searchEmbeddingCache.delete(embeddingKey);
            this.searchEmbeddingCache.set(embeddingKey, searchEmbeddings);
        }
        else {
            const [document, image] = await Promise.all([
                this.embedText(cleanQuery, runtime, 10),
                this.embedText(`a photo of ${cleanQuery}`, runtime, 10),
            ]);
            searchEmbeddings = { document, image };
            this.searchEmbeddingCache.set(embeddingKey, searchEmbeddings);
            if (this.searchEmbeddingCache.size > SEARCH_EMBEDDING_CACHE_LIMIT) {
                const oldestKey = this.searchEmbeddingCache.keys().next().value;
                if (oldestKey)
                    this.searchEmbeddingCache.delete(oldestKey);
            }
        }
        if (isCancelled())
            return [];
        if (!(await this.waitForVectorIndexReady(isCancelled)))
            return [];
        const indexedRecordCount = this.latestRecordsByVectorKey.size;
        onSearchProgress?.([], 0, indexedRecordCount, "ann");
        const hits = await this.persistedVectorIndex.search(sourcePaths, searchEmbeddings.image, searchEmbeddings.document, SEARCH_RESULTS_PER_TYPE);
        if (isCancelled())
            return [];
        const results = [];
        for (const hit of hits) {
            const record = this.latestRecordsByVectorKey.get(hit.key);
            if (!record ||
                record.vectorOffset / VECTOR_BYTES !== hit.key ||
                !sourcePaths.includes(record.sourcePath) ||
                hit.confidence < minimumConfidence)
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
        if (!isCancelled())
            onSearchProgress?.(results, hits.length, indexedRecordCount, "ann");
        return isCancelled() ? [] : results;
    }
    async waitForVectorIndexReady(isCancelled) {
        if (isCancelled())
            return false;
        this.vectorIndexWaiterCount += 1;
        try {
            await this.vectorIndexReady;
            return !isCancelled();
        }
        finally {
            this.vectorIndexWaiterCount = Math.max(0, this.vectorIndexWaiterCount - 1);
        }
    }
    preservePendingFiles(pending, startIndex, preserveDiscoveredFiles) {
        const queued = new Map();
        if (preserveDiscoveredFiles)
            for (const { file, sourcePath } of pending.slice(startIndex))
                queued.set(file.path, sourcePath);
        for (const [filePath, sourcePath] of this.filesToIndex ?? [])
            if (!queued.has(filePath))
                queued.set(filePath, sourcePath);
        this.filesToIndex = queued.size ? queued : null;
    }
    async run(sourcePaths) {
        const pending = [];
        const demoTypeCounts = new Map();
        const demoCandidatesByType = new Map();
        let demoSampleMessage = "";
        let nextPendingIndex = 0;
        let isIncremental = false;
        try {
            // Check if we're doing incremental indexing (only specific files)
            isIncremental = this.filesToIndex !== null;
            let filesToIndex = this.filesToIndex;
            // Keep an incremental batch durable while it is being processed. Newly
            // changed files can still be appended by the watcher during this run.
            this.filesToIndex = filesToIndex ? new Map(filesToIndex) : null;
            const demoPaths = this.demoFilePaths(sourcePaths);
            let demoSlotsRemaining = this.demoFileLimit === null
                ? Number.POSITIVE_INFINITY
                : Math.max(0, this.demoFileLimit - (demoPaths?.size ?? 0));
            let demoLimitReached = false;
            const allowDemoFile = (filePath) => {
                if (!demoPaths || demoPaths.has(filePath))
                    return true;
                if (demoSlotsRemaining <= 0) {
                    demoLimitReached = true;
                    return false;
                }
                demoPaths.add(filePath);
                demoSlotsRemaining -= 1;
                return true;
            };
            if (filesToIndex) {
                const originalEntries = Array.from(filesToIndex.entries());
                const entries = await Promise.all(originalEntries.map(async ([filePath, sourcePath]) => {
                    let modified = this.latestRecords.get(filePath)?.modified ?? 0;
                    try {
                        const stats = await fsPromises.stat(filePath);
                        if (stats.isFile())
                            modified = stats.mtime.getTime();
                    }
                    catch {
                        // The normal incremental pass removes stale records for vanished files.
                    }
                    return { filePath, sourcePath, modified };
                }));
                entries.sort((first, second) => first.modified - second.modified ||
                    (first.filePath < second.filePath
                        ? -1
                        : first.filePath > second.filePath
                            ? 1
                            : 0));
                const orderedEntries = entries.map(({ filePath, sourcePath }) => [filePath, sourcePath]);
                const originalPaths = new Set(originalEntries.map(([filePath]) => filePath));
                const queuedDuringOrdering = Array.from(this.filesToIndex ?? []).filter(([filePath]) => !originalPaths.has(filePath));
                const batchEntries = orderedEntries.slice(0, INCREMENTAL_BATCH_SIZE);
                const remainingEntries = orderedEntries.slice(INCREMENTAL_BATCH_SIZE);
                filesToIndex = new Map(batchEntries);
                this.filesToIndex = new Map([
                    ...batchEntries,
                    ...remainingEntries,
                    ...queuedDuringOrdering,
                ]);
                if (remainingEntries.length || queuedDuringOrdering.length) {
                    this.queuedSourcePaths = sourcePaths;
                    console.log(`[SemanticIndexer] Processing ${filesToIndex.size} files now; ${this.filesToIndex.size - filesToIndex.size} queued`);
                }
            }
            const statusMsg = isIncremental
                ? `Re-indexing ${filesToIndex.size} changed file${filesToIndex.size === 1 ? "" : "s"}...`
                : `Discovering files across ${sourcePaths.length} source${sourcePaths.length === 1 ? "" : "s"}...`;
            await this.updateProgress({
                status: "scanning",
                total: isIncremental && this.auditTotal > 0 ? this.auditTotal : 0,
                indexed: isIncremental ? this.auditIndexed : 0,
                remaining: isIncremental && this.auditTotal > 0
                    ? Math.max(0, this.auditTotal - this.auditIndexed - this.auditErrors)
                    : (filesToIndex?.size ?? 0),
                errors: isIncremental ? this.auditErrors : 0,
                currentFile: null,
                message: statusMsg,
            }, true);
            const seenPaths = new Set();
            const sourceFileStats = new Map();
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
                    demoTypeCounts.set(record.type, (demoTypeCounts.get(record.type) ?? 0) + 1);
                    seenPaths.add(record.path);
                }
                demoPaths.clear();
                for (const candidates of demoCandidatesByType.values())
                    for (const candidate of candidates)
                        demoPaths.add(candidate.file.path);
                demoSlotsRemaining = Math.max(0, this.demoFileLimit - demoPaths.size);
            }
            let candidateCount = 0;
            let existingErrors = 0;
            let indexed = 0;
            if (isIncremental) {
                // Incremental mode: only process the changed files
                console.log(`[SemanticIndexer] Running in incremental mode for ${filesToIndex.size} files`);
                for (const sourcePath of new Set(filesToIndex.values())) {
                    if (!this.isRemotePath(sourcePath))
                        this.canonicalSourcePaths.set(sourcePath, await fsPromises.realpath(sourcePath).catch(() => path.resolve(sourcePath)));
                }
                for (const [filePath, sourcePath] of filesToIndex) {
                    if (this.pauseRequested)
                        break;
                    try {
                        const stats = await fsPromises.stat(filePath);
                        if (stats.isDirectory()) {
                            this.filesToIndex?.delete(filePath);
                            continue;
                        }
                        const file = {
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
                            this.filesToIndex?.delete(filePath);
                            continue;
                        }
                        seenPaths.add(filePath);
                        candidateCount += 1;
                        const failure = this.workerFailures.get(file.path);
                        if (failure?.signature === this.signature(file) &&
                            failure.attempts >= 3) {
                            existingErrors += 1;
                            this.filesToIndex?.delete(filePath);
                            continue;
                        }
                        // Always re-index in incremental mode
                        pending.push({ file, sourcePath });
                    }
                    catch (error) {
                        this.filesToIndex?.delete(filePath);
                        console.log(`[SemanticIndexer] Error accessing changed file ${filePath}:`, error instanceof Error ? error.message : "");
                        // File was deleted or inaccessible
                        this.deleteLatestRecord(filePath);
                    }
                }
                sourceFileStats.set("(incremental)", {
                    found: candidateCount,
                    pending: pending.length,
                });
            }
            else {
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
                        if (this.pauseRequested)
                            break;
                        this.searchDiscovery.sourcePath = sourcePath;
                        let sourceFileCount = this.demoFileLimit === null
                            ? 0
                            : Array.from(demoCandidatesByType.values())
                                .flat()
                                .filter((candidate) => candidate.sourcePath === sourcePath).length;
                        const demoSourcesRemaining = sourcePaths.length - this.searchDiscovery.sourceIndex;
                        const demoSourceTarget = this.demoFileLimit === null
                            ? Number.POSITIVE_INFINITY
                            : Math.ceil(demoSlotsRemaining / Math.max(1, demoSourcesRemaining));
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
                            this.canonicalSourcePaths.set(sourcePath, await fsPromises.realpath(sourcePath).catch(() => path.resolve(sourcePath)));
                        await this.setSourceCoverage(sourcePath, "scanning");
                        this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
                        try {
                            if (!demoSourceSampleReached)
                                await this.scanSource(sourcePath, (file) => {
                                    this.searchDiscovery.scanned += 1;
                                    if (Date.now() - lastDiscoveryUpdate >= 500) {
                                        lastDiscoveryUpdate = Date.now();
                                        this.progress.total = candidateCount;
                                        this.progress.indexed = indexed;
                                        this.progress.errors = existingErrors;
                                        this.progress.remaining = pending.length;
                                        const observedIndexable = Array.from(demoTypeCounts.values()).reduce((sum, count) => sum + count, 0);
                                        this.progress.message =
                                            this.demoFileLimit === null
                                                ? `${this.searchDiscovery.message} · ${this.searchDiscovery.scanned.toLocaleString()} entries inspected · ${candidateCount.toLocaleString()} indexable · ${pending.length.toLocaleString()} pending`
                                                : `${this.searchDiscovery.message} · ${this.searchDiscovery.scanned.toLocaleString()} entries inspected · ${observedIndexable.toLocaleString()} indexable files counted by type`;
                                        this.emitProgress();
                                    }
                                    if (!this.isIndexable(file, sourcePath))
                                        return;
                                    if (seenPaths.has(file.path))
                                        return;
                                    seenPaths.add(file.path);
                                    if (this.demoFileLimit !== null) {
                                        if (!allowDemoFile(file.path)) {
                                            demoLimitReached = true;
                                            demoSourceSampleReached = true;
                                            return;
                                        }
                                        sourceFileCount += 1;
                                        demoSourceCandidates += 1;
                                        demoTypeCounts.set(file.type, (demoTypeCounts.get(file.type) ?? 0) + 1);
                                        const candidates = demoCandidatesByType.get(file.type) ?? [];
                                        candidates.push({ file, sourcePath });
                                        demoCandidatesByType.set(file.type, candidates);
                                        this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
                                        if (demoSourceCandidates >= demoSourceTarget) {
                                            demoSourceSampleReached = true;
                                            if (demoSlotsRemaining <= 0)
                                                demoLimitReached = true;
                                        }
                                        return;
                                    }
                                    sourceFileCount += 1;
                                    this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
                                    if (!allowDemoFile(file.path))
                                        return;
                                    candidateCount += 1;
                                    const stored = this.latestRecords.get(file.path);
                                    if (!stored ||
                                        stored.signature !== this.signature(file) ||
                                        this.shouldRetryFailure(stored)) {
                                        pending.push({ file, sourcePath });
                                        this.searchDiscovery.changed = pending.length;
                                    }
                                    else if (stored.error) {
                                        existingErrors += 1;
                                    }
                                    else {
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
                                }, () => this.pauseRequested || demoSourceSampleReached, () => this.activeSearchCount > 0);
                        }
                        catch (error) {
                            this.searchDiscovery.error =
                                error instanceof Error ? error.message : String(error);
                            if (previousDiscoveredTotal === undefined)
                                this.discoveredTotalsBySource.delete(sourcePath);
                            else
                                this.discoveredTotalsBySource.set(sourcePath, previousDiscoveredTotal);
                            await this.setSourceCoverage(sourcePath, "error", this.searchDiscovery.error);
                            continue;
                        }
                        if (this.pauseRequested) {
                            if (previousDiscoveredTotal === undefined)
                                this.discoveredTotalsBySource.delete(sourcePath);
                            else
                                this.discoveredTotalsBySource.set(sourcePath, previousDiscoveredTotal);
                        }
                        else {
                            this.discoveredTotalsBySource.set(sourcePath, sourceFileCount);
                            await this.persistDiscoveredTotals();
                        }
                        await this.setSourceCoverage(sourcePath, this.pauseRequested ? "pending" : "completed");
                        sourceFileStats.set(sourcePath, {
                            found: sourceFileCount,
                            pending: 0,
                        });
                    }
                }
                catch (error) {
                    this.searchDiscovery.error =
                        error instanceof Error ? error.message : String(error);
                    throw error;
                }
                finally {
                    this.searchDiscovery.running = false;
                    this.searchDiscovery.message = this.pauseRequested
                        ? "Source discovery paused."
                        : `Inspected ${this.searchDiscovery.scanned.toLocaleString()} entries across ${this.searchDiscovery.sourceIndex} sources.`;
                }
            }
            if (!isIncremental && this.demoFileLimit !== null && !this.pauseRequested) {
                const candidates = Array.from(demoCandidatesByType.values())
                    .flat()
                    .sort((first, second) => first.file.path.localeCompare(second.file.path));
                const selectedPaths = (0, demoLimits_1.selectDemoFilePaths)(candidates.map(({ file, sourcePath }) => ({
                    path: file.path,
                    sourcePath,
                    type: file.type,
                })), sourcePaths, this.demoFileLimit, Object.fromEntries(demoTypeCounts));
                const selectedTypeCounts = {};
                const pendingBySource = new Map();
                for (const candidate of candidates) {
                    if (!selectedPaths.has(candidate.file.path))
                        continue;
                    const { file, sourcePath } = candidate;
                    candidateCount += 1;
                    selectedTypeCounts[file.type] =
                        (selectedTypeCounts[file.type] ?? 0) + 1;
                    const stored = this.latestRecords.get(file.path);
                    if (!stored ||
                        stored.signature !== this.signature(file) ||
                        this.shouldRetryFailure(stored)) {
                        pending.push({ file, sourcePath });
                        pendingBySource.set(sourcePath, (pendingBySource.get(sourcePath) ?? 0) + 1);
                    }
                    else if (stored.error || stored.vectorOffset < 0) {
                        existingErrors += 1;
                    }
                    else {
                        indexed += 1;
                    }
                }
                for (const [sourcePath, stats] of sourceFileStats)
                    stats.pending = pendingBySource.get(sourcePath) ?? 0;
                demoSampleMessage = (0, demoLimits_1.formatDemoFileSample)(selectedTypeCounts, Object.fromEntries(demoTypeCounts));
                this.auditTotal = candidateCount;
                this.auditIndexed = indexed;
                this.auditErrors = existingErrors;
                this.searchDiscovery.changed = pending.length;
            }
            pending.sort((first, second) => first.file.modified - second.file.modified ||
                (first.file.path < second.file.path
                    ? -1
                    : first.file.path > second.file.path
                        ? 1
                        : 0));
            if (isIncremental) {
                const activeBatch = pending.map(({ file, sourcePath }) => [file.path, sourcePath]);
                const activePaths = new Set(activeBatch.map(([filePath]) => filePath));
                const laterWork = Array.from(this.filesToIndex ?? []).filter(([filePath]) => !activePaths.has(filePath));
                this.filesToIndex = new Map([...activeBatch, ...laterWork]);
                await this.checkpointPendingWork(sourcePaths, true);
            }
            await this.updateProgress({
                total: isIncremental && this.auditTotal > 0
                    ? this.auditTotal
                    : candidateCount,
                indexed: isIncremental && this.auditTotal > 0 ? this.auditIndexed : indexed,
                remaining: isIncremental && this.auditTotal > 0
                    ? Math.max(0, this.auditTotal - this.auditIndexed - this.auditErrors)
                    : pending.length,
                errors: isIncremental && this.auditTotal > 0
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
            }, true);
            if (this.pauseRequested) {
                this.preservePendingFiles(pending, 0, isIncremental || this.demoFileLimit !== null);
                await this.checkpointPendingWork(sourcePaths, true);
                await this.updateProgress({ status: "paused", message: "Indexing paused." }, true);
                return;
            }
            if (pending.length === 0) {
                // Build a more informative message
                let message = isIncremental
                    ? "All changes indexed."
                    : "Index is up to date.";
                if (!isIncremental && candidateCount === 0) {
                    message = `No indexable files found (${sourcePaths.length} source${sourcePaths.length === 1 ? "" : "s"} scanned).`;
                }
                else if (!isIncremental && candidateCount > 0 && indexed > 0) {
                    message = `All ${candidateCount.toLocaleString()} indexable files are already indexed.`;
                }
                if (demoSampleMessage)
                    message = `${demoSampleMessage} ${message}`;
                console.log("[SemanticIndexer] No pending files to index. Message:", message);
                console.log("[SemanticIndexer] Source stats:", Object.fromEntries(sourceFileStats));
                if (this.filesToIndex?.size) {
                    this.queuedSourcePaths = sourcePaths;
                    await this.updateProgress({
                        status: "scanning",
                        message: `${this.filesToIndex.size.toLocaleString()} saved files remain in the chronological queue.`,
                    }, true);
                    await this.checkpointPendingWork(sourcePaths, true);
                }
                else {
                    await this.updateProgress({ status: "complete", message }, true);
                    await this.checkpointPendingWork([], true);
                }
                return;
            }
            await this.updateProgress({
                status: "loading-model",
                message: demoSampleMessage
                    ? `${demoSampleMessage} Loading the offline search model...`
                    : "Loading offline CLIP model...",
            }, true);
            let runtime;
            try {
                runtime = await this.loadClipRuntime();
            }
            catch (error) {
                // Runtime construction/preload failures belong to the infrastructure,
                // never to whichever file happens to be first in the batch.
                throw error instanceof EmbeddingProcessError
                    ? error
                    : new EmbeddingProcessError(`Semantic model initialization failed: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
            await this.updateProgress({
                status: "indexing",
                message: demoSampleMessage
                    ? `${demoSampleMessage} Creating search embeddings...`
                    : "Creating semantic embeddings...",
            }, true);
            for (let index = 0; index < pending.length; index += 1) {
                nextPendingIndex = index;
                if (this.pauseRequested) {
                    this.preservePendingFiles(pending, index, isIncremental || this.demoFileLimit !== null);
                    await this.checkpointPendingWork(sourcePaths, true);
                    await this.updateProgress({
                        status: "paused",
                        currentFile: null,
                        message: "Indexing paused with the remaining chronological queue saved.",
                    }, true);
                    return;
                }
                const { file, sourcePath } = pending[index];
                await this.updateProgress({ currentFile: file.name }, false);
                this.processingPaths.add(file.path);
                const fileWorkStartedAt = Date.now();
                let succeeded = false;
                try {
                    const vector = file.type === "image"
                        ? await this.embedImage(file.path, runtime)
                        : await this.embedTextFile(file, runtime);
                    await this.appendRecord(file, sourcePath, vector);
                    succeeded = true;
                }
                catch (error) {
                    // A dead decoder/model process is not a bad file. Preserve the index
                    // and stop this run; an explicit later request can start a new child.
                    if (error instanceof EmbeddingProcessError) {
                        if (file.type === "image" && error.nativeImageCrash) {
                            const signature = this.signature(file);
                            const previous = this.workerFailures.get(file.path);
                            const attempts = Math.min(3, (previous?.signature === signature ? previous.attempts : 0) + 1);
                            this.workerFailures.set(file.path, {
                                signature,
                                attempts,
                                message: error.message,
                                timestamp: Date.now(),
                            });
                            try {
                                await this.persistWorkerFailures();
                                if (attempts >= 3) {
                                    await this.appendFailure(file, sourcePath, "Semantic image worker crashed 3 times for this unchanged file. Skipped until the file changes; repair or re-export the image to retry. The original file has not been modified.");
                                    nextPendingIndex = index + 1;
                                    this.filesToIndex?.delete(file.path);
                                    this.auditErrors += 1;
                                    this.progress.errors += 1;
                                }
                            }
                            catch {
                                // A recovery-state write failure must not replace the worker
                                // exception and discard this batch's unprocessed files.
                                if (previous)
                                    this.workerFailures.set(file.path, previous);
                                else
                                    this.workerFailures.delete(file.path);
                                this.onDiagnostic("semantic-worker-failure-persist-error", {
                                    message: "Worker failure could not be saved.",
                                });
                            }
                        }
                        throw error;
                    }
                    await this.appendFailure(file, sourcePath, error instanceof Error ? error.message : "Indexing failed.");
                }
                finally {
                    this.processingPaths.delete(file.path);
                }
                nextPendingIndex = index + 1;
                if (succeeded && this.workerFailures.delete(file.path))
                    await this.persistWorkerFailures();
                this.filesToIndex?.delete(file.path);
                if (succeeded) {
                    this.auditIndexed += 1;
                    this.progress.indexed =
                        this.auditTotal > 0 ? this.auditIndexed : this.progress.indexed + 1;
                }
                else {
                    this.auditErrors += 1;
                    this.progress.errors = this.auditErrors;
                }
                this.progress.remaining =
                    this.auditTotal > 0
                        ? Math.max(0, this.auditTotal - this.auditIndexed - this.auditErrors)
                        : Math.max(0, this.progress.remaining - 1);
                this.emitProgress();
                if (index % 10 === 9) {
                    await this.persistProgress();
                    if (isIncremental)
                        await this.checkpointPendingWork(sourcePaths, true);
                }
                await new Promise((resolve) => setImmediate(resolve));
                // Treat the preference as a background work-time budget, not a claim
                // about total machine CPU usage. Interactive searches take priority.
                const fileWorkMs = Math.max(1, Date.now() - fileWorkStartedAt);
                let cooldownRemaining = Math.ceil(fileWorkMs *
                    ((100 - this.performanceSettings.backgroundWorkPercent) /
                        this.performanceSettings.backgroundWorkPercent));
                while (cooldownRemaining > 0 &&
                    this.activeSearchCount === 0 &&
                    !this.pauseRequested) {
                    const sliceMs = Math.min(50, cooldownRemaining);
                    await new Promise((resolve) => setTimeout(resolve, sliceMs));
                    cooldownRemaining -= sliceMs;
                }
                // An active search gets the next inference slot.
                while (this.activeSearchCount > 0 && !this.pauseRequested)
                    await new Promise((resolve) => setTimeout(resolve, 40));
            }
            if (this.filesToIndex && this.filesToIndex.size > 0) {
                this.queuedSourcePaths = sourcePaths;
                await this.checkpointPendingWork(sourcePaths, true);
                await this.updateProgress({
                    status: "scanning",
                    currentFile: null,
                    message: `${this.auditIndexed.toLocaleString()} of ${this.auditTotal.toLocaleString()} original files indexed. Continuing in the background...`,
                }, true);
            }
            else {
                await this.updateProgress({
                    status: "complete",
                    currentFile: null,
                    remaining: 0,
                    message: `${this.auditIndexed.toLocaleString()} of ${this.auditTotal.toLocaleString()} original files have CLIP embeddings.${demoSampleMessage ? ` ${demoSampleMessage}` : ""}`,
                }, true);
                await this.checkpointPendingWork([], true);
            }
        }
        catch (error) {
            // Keep the unfinished chronological queue and source scan roots so the
            // recovery manager can retry in this session or resume after a restart.
            const interruptedSources = [
                ...sourcePaths,
                ...(this.queuedSourcePaths ?? []),
            ];
            this.queuedSourcePaths = null;
            this.preservePendingFiles(pending, nextPendingIndex, isIncremental || this.demoFileLimit !== null);
            this.progress.remaining = this.filesToIndex?.size ?? 0;
            try {
                await this.checkpointPendingWork(interruptedSources, true);
            }
            catch (checkpointError) {
                this.onDiagnostic("semantic-worker-checkpoint-error", {
                    message: "Interrupted work could not be saved.",
                });
                console.error("[SemanticIndexer] Pending checkpoint failed", checkpointError);
            }
            await this.updateProgress({
                status: "error",
                currentFile: null,
                message: error instanceof EmbeddingProcessError &&
                    nextPendingIndex > 0 &&
                    this.workerFailures.get(pending[nextPendingIndex - 1]?.file.path)
                        ?.attempts === 3
                    ? "Repeat-crashing image skipped after 3 attempts. Repair or re-export the image to retry; restart indexing to resume the remaining files. Original preserved."
                    : error instanceof Error
                        ? error.message
                        : "Indexing failed.",
            }, true);
        }
    }
    async loadClipRuntime() {
        if (this.clipRuntime)
            return this.clipRuntime;
        if (!this.clipRuntimePromise) {
            let child;
            try {
                child = this.ensureEmbeddingWorker();
            }
            catch {
                throw new EmbeddingProcessError("Semantic embedding process could not be started.");
            }
            const promise = (async () => {
                await this.requestWorkerEmbedding("preload", {}, child);
                if (this.embeddingWorker !== child)
                    throw new EmbeddingProcessError("Semantic embedding process is unavailable.");
                this.clipRuntime = { worker: true, child };
                return this.clipRuntime;
            })().catch((error) => {
                if (this.clipRuntimePromise === promise)
                    this.clipRuntimePromise = null;
                throw error;
            });
            this.clipRuntimePromise = promise;
        }
        return this.clipRuntimePromise;
    }
    runInference(task, priority = 0) {
        return new Promise((resolve, reject) => {
            this.inferenceQueue.push({
                priority,
                sequence: this.inferenceSequence++,
                task: () => {
                    this.inferenceActive = true;
                    void task().then((value) => {
                        resolve(value);
                        this.finishInference();
                    }, (error) => {
                        reject(error);
                        this.finishInference();
                    });
                },
            });
            this.inferenceQueue.sort((first, second) => second.priority - first.priority || first.sequence - second.sequence);
            if (!this.inferenceActive)
                this.inferenceQueue.shift()?.task();
        });
    }
    finishInference() {
        this.inferenceActive = false;
        this.inferenceQueue.shift()?.task();
    }
    async embedText(text, runtime, priority = 0) {
        return this.runInference(async () => {
            if (runtime.worker)
                return this.normalize(await this.requestWorkerEmbedding("text", { text: text.slice(0, 8000) }, runtime.child));
            const inputs = runtime.tokenizer([text.slice(0, 8000)], {
                padding: true,
                truncation: true,
            });
            const output = await runtime.textModel(inputs);
            return this.normalize(output.text_embeds.data);
        }, priority);
    }
    async embedImage(filePath, runtime) {
        return this.runInference(async () => {
            try {
                return await this.embedImageFile(filePath, runtime);
            }
            catch (originalError) {
                if (originalError instanceof EmbeddingProcessError)
                    throw originalError;
                if (process.platform !== "darwin")
                    throw originalError;
                const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "semantic-image-"));
                const convertedPath = path.join(temporaryDirectory, "converted.jpg");
                try {
                    await execFileAsync("sips", [
                        "-s",
                        "format",
                        "jpeg",
                        filePath,
                        "--out",
                        convertedPath,
                    ]);
                    return await this.embedImageFile(convertedPath, runtime);
                }
                catch (conversionError) {
                    if (conversionError instanceof EmbeddingProcessError)
                        throw conversionError;
                    const originalMessage = originalError instanceof Error
                        ? originalError.message
                        : "Image decoding failed.";
                    const conversionMessage = conversionError instanceof Error
                        ? conversionError.message
                        : "macOS image conversion failed.";
                    throw new Error(`${originalMessage} (macOS fallback: ${conversionMessage})`);
                }
                finally {
                    await fsPromises.rm(temporaryDirectory, {
                        recursive: true,
                        force: true,
                    });
                }
            }
        });
    }
    async embedImageFile(filePath, runtime) {
        if (runtime.worker)
            return this.normalize(await this.requestWorkerEmbedding("image", { filePath }, runtime.child));
        const image = await runtime.RawImage.read(filePath);
        const inputs = await runtime.processor(image);
        const output = await runtime.visionModel(inputs);
        return this.normalize(output.image_embeds.data);
    }
    ensureEmbeddingWorker() {
        if (this.embeddingWorker)
            return this.embeddingWorker;
        // worker_threads cannot contain Sharp/libvips/ONNX native crashes.
        const worker = (0, child_process_1.fork)(path.join(__dirname, "semanticWorker.js"), [], {
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
        let disconnectTimer;
        // Only native stderr, never request payloads, image contents or environment.
        worker.stderr?.on("data", (chunk) => {
            stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
        });
        worker.on("spawn", () => this.onDiagnostic("semantic-worker-online"));
        worker.on("message", (message) => {
            if (this.embeddingWorker !== worker || !message)
                return;
            if (message.type === "diagnostic") {
                if (message.event === "semantic-worker-preload-phase" &&
                    ["preload", "text", "image"].includes(message.requestType) &&
                    typeof message.phase === "string" &&
                    ["started", "completed", "failed"].includes(message.status)) {
                    this.onDiagnostic("semantic-worker-preload-phase", {
                        requestType: message.requestType,
                        phase: message.phase.slice(0, 120),
                        status: message.status,
                        ...(Number.isFinite(message.durationMs)
                            ? { durationMs: Math.max(0, Math.min(600000, message.durationMs)) }
                            : {}),
                    });
                }
                return;
            }
            if (!Number.isInteger(message.id))
                return;
            const request = this.embeddingRequests.get(message.id);
            if (!request)
                return;
            this.embeddingRequests.delete(message.id);
            if (request.timer)
                clearTimeout(request.timer);
            if (typeof message.error === "string") {
                const diagnosticMessage = sanitizeWorkerDiagnosticText(message.error, 1200);
                const phase = sanitizeWorkerDiagnosticText(message.phase, 120);
                const stack = sanitizeWorkerDiagnosticStack(message.stack, 1800);
                this.onDiagnostic("semantic-worker-request-failed", {
                    requestType: request.type,
                    infrastructure: Boolean(message.infrastructure),
                    ...(diagnosticMessage ? { message: diagnosticMessage } : {}),
                    ...(phase ? { phase } : {}),
                    ...(stack ? { stack } : {}),
                });
                const error = message.infrastructure || request.type === "preload"
                    ? new EmbeddingProcessError(`Semantic model initialization failed: ${diagnosticMessage ?? "Worker initialization failed."}`)
                    : new Error(diagnosticMessage ?? "Semantic worker request failed.");
                request.reject(error);
                if (error instanceof EmbeddingProcessError)
                    this.failEmbeddingWorker(worker, error);
            }
            else if (Array.isArray(message.values) &&
                message.values.length ===
                    (request.type === "preload" ? 0 : VECTOR_SIZE) &&
                message.values.every((value) => typeof value === "number" && Number.isFinite(value))) {
                request.resolve(message.values);
            }
            else {
                const error = new EmbeddingProcessError("Invalid semantic embedding response.");
                request.reject(error);
                this.failEmbeddingWorker(worker, error);
            }
        });
        worker.on("error", () => {
            if (this.embeddingWorker !== worker)
                return;
            this.onDiagnostic("semantic-worker-error", {
                pendingCount: this.embeddingRequests.size,
            });
            this.failEmbeddingWorker(worker, new EmbeddingProcessError("Semantic embedding process failed."));
        });
        worker.on("exit", (code, signal) => {
            if (disconnectTimer)
                clearTimeout(disconnectTimer);
            const pending = this.embeddingWorker === worker
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
            this.failEmbeddingWorker(worker, new EmbeddingProcessError(`Semantic embedding process exited (${signal ?? code}).`, (signal !== null || (code !== null && code !== 0)) &&
                pending.some((request) => request.type === "image")));
        });
        worker.on("disconnect", () => {
            if (this.embeddingWorker !== worker)
                return;
            // Native crashes commonly disconnect IPC just before exit reports SIGTRAP.
            // Give exit a bounded grace period rather than replacing its signal.
            disconnectTimer = setTimeout(() => {
                this.failEmbeddingWorker(worker, new EmbeddingProcessError("Semantic embedding IPC disconnected without an exit report."));
            }, 250);
        });
        return worker;
    }
    failEmbeddingWorker(worker, error) {
        if (this.embeddingWorker !== worker)
            return;
        const diagnosticReason = error.message
            .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, "[path]")
            .slice(0, 1200);
        const previousExitDetails = this.embeddingExitDetails.get(worker);
        this.embeddingExitDetails.set(worker, {
            pendingCount: this.embeddingRequests.size,
            requestTypes: [
                ...new Set([...this.embeddingRequests.values()].map((request) => request.type)),
            ],
            failureReason: diagnosticReason || previousExitDetails?.failureReason,
        });
        this.embeddingWorker = null;
        this.clipRuntime = null;
        this.clipRuntimePromise = null;
        for (const request of this.embeddingRequests.values()) {
            if (request.timer)
                clearTimeout(request.timer);
            request.reject(error);
        }
        this.embeddingRequests.clear();
        // SIGKILL also stops a decoder hung inside native code; never auto-respawn.
        if (worker.exitCode === null && worker.signalCode === null)
            worker.kill("SIGKILL");
    }
    requestWorkerEmbedding(type, payload = {}, child) {
        const worker = child ?? this.ensureEmbeddingWorker();
        if (this.embeddingWorker !== worker || !worker.connected)
            return Promise.reject(new EmbeddingProcessError("Semantic embedding process is unavailable."));
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
            this.embeddingRequests.set(id, { type, timer, resolve, reject });
            try {
                worker.send({ id, type, ...payload }, (error) => {
                    if (error && worker.connected)
                        this.failEmbeddingWorker(worker, new EmbeddingProcessError("Semantic embedding IPC send failed."));
                });
            }
            catch {
                this.failEmbeddingWorker(worker, new EmbeddingProcessError("Semantic embedding IPC send failed."));
            }
        });
    }
    async embedTextFile(file, runtime) {
        const text = await this.extractText(file);
        if (!text.trim())
            throw new Error("No readable text found.");
        return this.embedText(`${file.name}\n${text}`, runtime);
    }
    async extractText(file) {
        if (file.extension === ".pdf") {
            if (file.size > 50 * 1024 * 1024)
                throw new Error("PDF is larger than 50 MB.");
            const { PDFParse } = require("pdf-parse");
            const parser = new PDFParse({
                data: await fsPromises.readFile(file.path),
            });
            try {
                const result = await parser.getText();
                return String(result.text || "").slice(0, 8000);
            }
            finally {
                await parser.destroy();
            }
        }
        if (!plainTextExtensions.has(file.extension))
            throw new Error("Document format is not text-readable.");
        const handle = await fsPromises.open(file.path, "r");
        try {
            const buffer = Buffer.alloc(Math.min(file.size, 256 * 1024));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return buffer
                .subarray(0, bytesRead)
                .toString("utf8")
                .replace(/\0/g, " ")
                .slice(0, 8000);
        }
        finally {
            await handle.close();
        }
    }
    isIndexable(file, sourcePath = "") {
        if (sourcePath &&
            (0, indexingPathPolicy_1.isAppDataPath)(file.path, sourcePath, this.canonicalSourcePaths.get(sourcePath) ?? path.resolve(sourcePath), this.userDataPath, this.canonicalUserDataPath))
            return false;
        if (file.isDirectory)
            return false;
        if ((0, indexingPathPolicy_1.isPhoneDerivativePath)(file.path) || (0, indexingPathPolicy_1.isNonLibraryPath)(file.path))
            return false;
        if (file.type === "image")
            return true;
        return (file.type === "document" &&
            (file.extension === ".pdf" || plainTextExtensions.has(file.extension)));
    }
    inferType(filePath) {
        const extension = path.extname(filePath).toLowerCase();
        if (imageExtensions.has(extension))
            return "image";
        if (extension === ".pdf" || plainTextExtensions.has(extension))
            return "document";
        return "other";
    }
    shouldRetryFailure(record) {
        const failure = this.workerFailures.get(record.path);
        if (failure?.signature === record.signature && failure.attempts >= 3)
            return false;
        return Boolean(record.error);
    }
    signature(file) {
        return `${file.size}:${file.modified}`;
    }
    async loadWorkerRecovery() {
        try {
            const entries = JSON.parse(await fsPromises.readFile(path.join(this.indexDirectory, "worker-failures.json"), "utf8"));
            for (const [filePath, failure] of entries) {
                if (typeof filePath === "string" &&
                    typeof failure?.signature === "string" &&
                    Number.isInteger(failure.attempts) &&
                    failure.attempts >= 1 &&
                    failure.attempts <= 3 &&
                    typeof failure.message === "string" &&
                    Number.isFinite(failure.timestamp)) {
                    this.workerFailures.set(filePath, failure);
                }
            }
        }
        catch {
            /* Missing or invalid recovery state is not a file failure. */
        }
        try {
            const saved = JSON.parse(await fsPromises.readFile(path.join(this.indexDirectory, "pending-work.json"), "utf8"));
            const entries = new Map();
            for (const entry of saved.entries ?? []) {
                if (Array.isArray(entry) &&
                    entry.length === 2 &&
                    entry.every((value) => typeof value === "string" && value.trim()))
                    entries.set(entry[0], entry[1]);
            }
            if (entries.size)
                this.filesToIndex = entries;
            this.restoredSourcePaths = Array.from(new Set([
                ...(Array.isArray(saved.sources)
                    ? saved.sources.filter((root) => typeof root === "string" && root.trim())
                    : []),
                ...entries.values(),
            ]));
            this.pendingCheckpoint = true;
        }
        catch {
            /* No interrupted queue to restore. */
        }
    }
    async writeRecoveryFile(name, value) {
        const snapshot = JSON.stringify(value);
        const task = this.recoveryFileWriteChain.then(async () => {
            await fsPromises.mkdir(this.indexDirectory, { recursive: true });
            const target = path.join(this.indexDirectory, name);
            const temporaryPath = `${target}.${process.pid}.${++this.recoveryFileWriteSequence}.tmp`;
            try {
                await fsPromises.writeFile(temporaryPath, snapshot, "utf8");
                await fsPromises.rename(temporaryPath, target);
            }
            catch (error) {
                await fsPromises.unlink(temporaryPath).catch(() => undefined);
                throw error;
            }
        });
        this.recoveryFileWriteChain = task.catch(() => undefined);
        await task;
    }
    persistWorkerFailures() {
        return this.writeRecoveryFile("worker-failures.json", Array.from(this.workerFailures));
    }
    async checkpointPendingWork(sources, force = false) {
        if (!force && !this.pendingCheckpoint)
            return;
        this.pendingCheckpoint = true;
        const entries = Array.from(this.filesToIndex ?? []);
        await this.writeRecoveryFile("pending-work.json", {
            version: 1,
            entries,
            sources: Array.from(new Set([
                ...sources,
                ...(this.queuedSourcePaths ?? []),
                ...entries.map(([, root]) => root),
            ])),
        });
    }
    normalize(values) {
        const vector = Float32Array.from(values);
        if (vector.length !== VECTOR_SIZE)
            throw new Error(`Unexpected embedding size: ${vector.length}`);
        let squaredLength = 0;
        for (const value of vector)
            squaredLength += value * value;
        const length = Math.sqrt(squaredLength) || 1;
        for (let index = 0; index < vector.length; index += 1)
            vector[index] /= length;
        return vector;
    }
    /**
     * Every index write goes through one chain: concurrent appends raced for the same
     * vector offset, and a kill mid-line glued the next record onto a partial one.
     */
    appendLines(lines) {
        if (!lines.length)
            return this.writeChain;
        return this.serializeWrite(async () => {
            await this.ensureRecordsLineBoundary();
            await fsPromises.appendFile(this.recordsPath, `${lines.join("\n")}\n`);
        });
    }
    serializeWrite(write) {
        const task = this.writeChain.then(write, write);
        this.writeChain = task.then(() => undefined, () => undefined);
        return task;
    }
    /** A partial line left by a crash is isolated so it can never swallow the next record. */
    async ensureRecordsLineBoundary() {
        if (this.recordsBoundaryChecked)
            return;
        this.recordsBoundaryChecked = true;
        const handle = await fsPromises.open(this.recordsPath, "r").catch(() => null);
        if (!handle)
            return;
        try {
            const { size } = await handle.stat();
            if (size === 0)
                return;
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            if (last[0] !== 0x0a)
                await fsPromises.appendFile(this.recordsPath, "\n");
        }
        finally {
            await handle.close();
        }
    }
    /** Resolves once queued index writes are on disk; used before quitting. */
    flushWrites() {
        return this.writeChain;
    }
    async appendRecord(file, sourcePath, vector) {
        const record = await this.serializeWrite(async () => {
            await this.ensureRecordsLineBoundary();
            const vectorHandle = await fsPromises.open(this.vectorsPath, "a");
            let vectorOffset = 0;
            try {
                vectorOffset = (await vectorHandle.stat()).size;
                const vectorBuffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
                await vectorHandle.write(vectorBuffer, 0, vectorBuffer.length, null);
                await vectorHandle.sync();
            }
            finally {
                await vectorHandle.close();
            }
            const created = this.createRecord(file, sourcePath, vectorOffset);
            await fsPromises.appendFile(this.recordsPath, `${JSON.stringify(created)}\n`);
            return created;
        });
        this.setLatestRecord(record);
    }
    async appendFailure(file, sourcePath, error) {
        const record = { ...this.createRecord(file, sourcePath, -1), error };
        await this.appendLines([JSON.stringify(record)]);
        this.setLatestRecord(record);
    }
    createRecord(file, sourcePath, vectorOffset) {
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
    async loadRecords(onLoadProgress) {
        let highestVectorEnd = 0;
        let recordCount = 0;
        const typeCount = {};
        const canonicalRoots = new Map();
        const excludedPaths = new Set();
        let corruptLines = 0;
        let journalRowsRead = 0;
        // Directory-level memo: per-file checks re-read marker files for every ancestor.
        const cloneChecks = new Map();
        const inClone = (directory, root) => {
            const key = `${root}\0${directory}`;
            let check = cloneChecks.get(key);
            if (!check) {
                check = (async () => {
                    if (!(0, indexingPathPolicy_1.isPathWithin)(directory, root))
                        return false;
                    if (await (0, indexingPathPolicy_1.isSiloCloneDirectory)(directory))
                        return true;
                    const parent = path.dirname(directory);
                    return directory !== path.resolve(root) && parent !== directory && inClone(parent, root);
                })();
                cloneChecks.set(key, check);
            }
            return check;
        };
        // offset -> path: an offset claimed twice means the earlier record's vector was overwritten.
        const offsetOwners = new Map();
        try {
            // Stream the file instead of loading it all into memory to avoid OOM with large indexes
            const readline = require("readline");
            let recordsStats = await fsPromises.stat(this.recordsPath).catch(() => null);
            if (!recordsStats) {
                // Establish the journal before creating a stream. Starting a read stream
                // for a missing file can emit ENOENT before readline has attached its
                // error listener during a fresh profile's first startup.
                await fsPromises.writeFile(this.recordsPath, "", { flag: "a" });
                recordsStats = await fsPromises.stat(this.recordsPath);
            }
            const totalBytes = recordsStats.size;
            const fileStream = fs.createReadStream(this.recordsPath);
            let lastReport = 0;
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });
            for await (const line of rl) {
                if (onLoadProgress && totalBytes && Date.now() - lastReport > 500) {
                    lastReport = Date.now();
                    onLoadProgress(Math.min(1, fileStream.bytesRead / totalBytes), this.latestRecords.size);
                }
                if (!line.trim())
                    continue;
                journalRowsRead += 1;
                try {
                    let record;
                    try {
                        record = JSON.parse(line);
                    }
                    catch {
                        // A crash mid-write leaves a partial line; a later record may be glued onto it.
                        corruptLines += 1;
                        const glued = line.lastIndexOf('{"path":');
                        if (glued <= 0)
                            continue;
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
                }
                catch {
                    corruptLines += 1;
                }
            }
            // Validate in place so startup does not allocate a second large Map.
            const replayedRecords = this.latestRecords;
            this.onDiagnostic("semantic-record-history-collapsed", {
                journalRowsRead,
                recordsToValidate: replayedRecords.size,
            });
            let lastValidationReport = Date.now();
            for (const record of replayedRecords.values()) {
                let accepted = false;
                try {
                    // Legacy records from software trees stay on disk but are never held
                    // in memory. Check only their final version after history collapse.
                    if ((0, indexingPathPolicy_1.isNonLibraryPath)(record.path))
                        continue;
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
                    if ((0, indexingPathPolicy_1.isAppDataPath)(record.path, record.sourcePath, canonicalRoot, this.userDataPath, this.canonicalUserDataPath)) {
                        excludedPaths.add(record.path);
                        this.sourcesWithExcludedRecords.add(record.sourcePath);
                        continue;
                    }
                    if (!this.isRemotePath(record.sourcePath) &&
                        await inClone(path.dirname(path.resolve(record.path)), record.sourcePath)) {
                        excludedPaths.add(record.path);
                        this.sourcesWithExcludedRecords.add(record.sourcePath);
                        continue;
                    }
                    if (record.vectorOffset >= 0) {
                        const previousOwner = offsetOwners.get(record.vectorOffset);
                        if (previousOwner !== undefined &&
                            previousOwner !== record.path &&
                            this.latestRecords.get(previousOwner)?.vectorOffset === record.vectorOffset)
                            this.deleteLatestRecord(previousOwner);
                        offsetOwners.set(record.vectorOffset, record.path);
                    }
                    this.setLatestRecord(record, false);
                    accepted = true;
                    recordCount += 1;
                    typeCount[record.type] = (typeCount[record.type] || 0) + 1;
                    if (record.vectorOffset >= 0)
                        highestVectorEnd = Math.max(highestVectorEnd, record.vectorOffset + VECTOR_BYTES);
                    if (onLoadProgress && Date.now() - lastValidationReport > 500) {
                        lastValidationReport = Date.now();
                        onLoadProgress(1, recordCount);
                    }
                }
                catch {
                    corruptLines += 1;
                }
                finally {
                    if (!accepted)
                        replayedRecords.delete(record.path);
                }
            }
            cloneChecks.clear();
            offsetOwners.clear();
            console.log(`[INDEXER] Loaded ${recordCount} records:`, typeCount);
            if (corruptLines)
                this.onDiagnostic("semantic-records-corrupt-lines-skipped", { lines: corruptLines });
            if (excludedPaths.size > 0) {
                const paths = Array.from(excludedPaths);
                for (let index = 0; index < paths.length; index += 1000) {
                    await this.appendLines(paths.slice(index, index + 1000).map((filePath) => JSON.stringify({ path: filePath, deleted: true })));
                }
                this.onDiagnostic("semantic-internal-records-pruned", {
                    records: excludedPaths.size,
                });
            }
        }
        catch (error) {
            // File doesn't exist yet, create empty one
            if (error.code === "ENOENT") {
                await fsPromises.writeFile(this.recordsPath, "");
            }
        }
        try {
            const stats = await fsPromises.stat(this.vectorsPath);
            // Only a torn trailing vector is trimmed; truncating to the highest loaded offset
            // once destroyed vectors whose records sat beyond an unreadable line.
            const whole = stats.size - (stats.size % VECTOR_BYTES);
            if (whole < stats.size)
                await fsPromises.truncate(this.vectorsPath, whole);
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
        }
        catch {
            await fsPromises.writeFile(this.vectorsPath, Buffer.alloc(0));
        }
        onLoadProgress?.(1, recordCount);
    }
    async updateProgress(update, persist) {
        this.progress = { ...this.progress, ...update };
        this.emitProgress();
        if (persist)
            await this.persistProgress();
    }
    emitProgress() {
        this.onProgress({ ...this.progress });
    }
    async persistProgress() {
        const temporaryPath = `${this.progressPath}.tmp`;
        await fsPromises.writeFile(temporaryPath, JSON.stringify(this.progress, null, 2));
        await fsPromises.rename(temporaryPath, this.progressPath);
    }
}
exports.SemanticIndexer = SemanticIndexer;
