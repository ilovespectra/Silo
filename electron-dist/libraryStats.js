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
exports.LibraryStatsManager = void 0;
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const indexingPathPolicy_1 = require("./indexingPathPolicy");
const inventoryFingerprint_1 = require("./inventoryFingerprint");
const CATEGORIES = ["image", "video", "audio", "document", "archive", "other"];
function emptyCategories() {
    return Object.fromEntries(CATEGORIES.map((category) => [category, { files: 0, bytes: 0 }]));
}
function normalizeCategory(type) {
    return CATEGORIES.includes(type) ? type : "other";
}
function withinOrSame(candidate, parent) {
    return (0, indexingPathPolicy_1.isPathWithin)(candidate, parent);
}
class LibraryStatsManager {
    constructor(userDataPath, scanSource, onUpdate = () => undefined) {
        this.inventories = new Map();
        this.errors = new Map();
        this.currentSources = [];
        this.queuedSources = null;
        this.runPromise = null;
        this.progress = {
            currentSourceId: null,
            currentSource: "",
            sourceIndex: 0,
            sourceCount: 0,
            scannedEntries: 0,
            currentSourceFiles: 0,
            message: "Inventory has not been measured yet.",
        };
        this.cachePath = path.join(userDataPath, "library-stats.json");
        this.scanSource = scanSource;
        this.onUpdate = onUpdate;
    }
    async initialize() {
        try {
            const stored = JSON.parse(await fsPromises.readFile(this.cachePath, "utf8"));
            if (stored.version !== 1 || !Array.isArray(stored.sources))
                return;
            for (const entry of stored.sources) {
                if (!entry || typeof entry.id !== "string" || typeof entry.rootPath !== "string" ||
                    typeof entry.canonicalPath !== "string" || !Number.isFinite(entry.scannedAt) ||
                    !Number.isSafeInteger(entry.fileCount) || !Number.isFinite(entry.totalBytes) ||
                    !Number.isSafeInteger(entry.unknownSizeFiles ?? 0) ||
                    !entry.categories || typeof entry.fingerprint !== "string")
                    continue;
                const categories = emptyCategories();
                for (const category of CATEGORIES) {
                    const value = entry.categories[category];
                    if (value && Number.isFinite(value.files) && Number.isFinite(value.bytes))
                        categories[category] = { files: value.files, bytes: value.bytes };
                }
                this.inventories.set(entry.id, { ...entry, categories });
            }
        }
        catch {
            // An empty or corrupt statistics cache is rebuilt on demand.
        }
    }
    requestRefresh(sources) {
        this.currentSources = sources.map((source) => ({ ...source }));
        if (this.runPromise) {
            this.queuedSources = this.currentSources;
            return this.getSnapshot();
        }
        const firstBatch = this.currentSources;
        this.progress = {
            currentSourceId: null,
            currentSource: "",
            sourceIndex: 0,
            sourceCount: firstBatch.filter((source) => source.available && source.rootPath).length,
            scannedEntries: 0,
            currentSourceFiles: 0,
            message: "Preparing a fresh source inventory…",
        };
        this.runPromise = this.runBatches(firstBatch).finally(() => {
            this.runPromise = null;
            this.queuedSources = null;
            this.progress = { ...this.progress, currentSourceId: null, currentSource: "", message: "Inventory scan complete." };
            this.publish();
        });
        this.publish();
        return this.getSnapshot();
    }
    async waitForIdle() {
        await this.runPromise;
    }
    getSnapshot(sources = this.currentSources) {
        const sourceRows = sources.map((source) => {
            const inventory = this.inventories.get(source.id);
            const active = this.progress.currentSourceId === source.id && Boolean(this.runPromise);
            const status = active
                ? "scanning"
                : this.errors.has(source.id)
                    ? "error"
                    : !source.available
                        ? "offline"
                        : inventory
                            ? "ready"
                            : "pending";
            return {
                ...source,
                status,
                scannedAt: inventory?.scannedAt ?? 0,
                fileCount: inventory?.fileCount ?? null,
                totalBytes: inventory?.totalBytes ?? null,
                unknownSizeFiles: inventory?.unknownSizeFiles ?? null,
                categories: inventory?.categories ?? emptyCategories(),
                fingerprint: inventory?.fingerprint ?? null,
                error: this.errors.get(source.id) ?? "",
                overlapsAnotherSource: false,
                stale: status !== "ready" || Date.now() - (inventory?.scannedAt ?? 0) > 15 * 60 * 1000,
                canonicalPath: inventory?.canonicalPath ?? source.rootPath,
                isLocal: source.kind === "local" || source.kind === "machine",
            };
        });
        const inventoryRows = sourceRows.filter((source) => source.fileCount !== null && source.rootPath);
        const contributing = inventoryRows.filter((source, index) => {
            if (!source.isLocal) {
                return inventoryRows.findIndex((item) => item.kind === source.kind && item.rootPath === source.rootPath) === index;
            }
            const canonical = source.canonicalPath;
            const sameRootEarlier = inventoryRows.slice(0, index).some((item) => item.isLocal && item.canonicalPath === canonical);
            if (sameRootEarlier)
                return false;
            const hasParent = inventoryRows.some((item) => item.isLocal && item.canonicalPath !== canonical && withinOrSame(canonical, item.canonicalPath));
            return !hasParent;
        });
        for (const row of sourceRows) {
            row.overlapsAnotherSource = inventoryRows.some((other) => other.id !== row.id && other.isLocal && row.isLocal &&
                (withinOrSame(row.canonicalPath, other.canonicalPath) || withinOrSame(other.canonicalPath, row.canonicalPath)));
        }
        const categories = emptyCategories();
        let fileCount = 0;
        let totalBytes = 0;
        let unknownSizeFiles = 0;
        let lastInventoryAt = 0;
        for (const source of contributing) {
            fileCount += source.fileCount ?? 0;
            totalBytes += source.totalBytes ?? 0;
            unknownSizeFiles += source.unknownSizeFiles ?? 0;
            if (source.scannedAt > 0)
                lastInventoryAt = lastInventoryAt === 0 ? source.scannedAt : Math.min(lastInventoryAt, source.scannedAt);
            for (const category of CATEGORIES) {
                categories[category].files += source.categories[category].files;
                categories[category].bytes += source.categories[category].bytes;
            }
        }
        return {
            running: Boolean(this.runPromise),
            progress: { ...this.progress },
            totals: {
                fileCount,
                totalBytes,
                unknownSizeFiles,
                categories,
                sourceCount: sources.length,
                uniqueSourceCount: contributing.length,
                staleSourceCount: sourceRows.filter((source) => source.stale).length,
                lastInventoryAt,
            },
            sources: sourceRows.map(({ canonicalPath: _canonical, isLocal: _local, ...source }) => source),
        };
    }
    async runBatches(initial) {
        let batch = initial;
        while (batch) {
            this.currentSources = batch;
            await this.scanBatch(batch);
            batch = this.queuedSources;
            this.queuedSources = null;
        }
    }
    async scanBatch(sources) {
        const available = sources.filter((source) => source.available && source.rootPath);
        this.progress = {
            ...this.progress,
            sourceCount: available.length,
            sourceIndex: 0,
            scannedEntries: 0,
            currentSourceFiles: 0,
            message: available.length ? "Measuring connected source inventories…" : "No available sources to inventory.",
        };
        this.publish();
        for (const [index, source] of available.entries()) {
            this.progress = {
                ...this.progress,
                currentSourceId: source.id,
                currentSource: source.label,
                sourceIndex: index + 1,
                scannedEntries: 0,
                currentSourceFiles: 0,
                message: `Scanning ${source.label} (${index + 1} of ${available.length})…`,
            };
            this.publish();
            const categories = emptyCategories();
            const fingerprint = new inventoryFingerprint_1.InventoryFingerprint();
            let fileCount = 0;
            let totalBytes = 0;
            let unknownSizeFiles = 0;
            try {
                const canonicalPath = source.kind === "local" || source.kind === "machine"
                    ? await fsPromises.realpath(source.rootPath).catch(() => path.resolve(source.rootPath))
                    : source.rootPath;
                await this.scanSource(source.rootPath, (file) => {
                    this.progress.scannedEntries += 1;
                    if (file.isDirectory)
                        return;
                    const sizeKnown = Number.isFinite(file.size) && file.size >= 0;
                    const size = sizeKnown ? file.size : 0;
                    const modified = Number.isFinite(file.modified) ? file.modified : 0;
                    const category = normalizeCategory(file.type);
                    fileCount += 1;
                    totalBytes += size;
                    if (!sizeKnown)
                        unknownSizeFiles += 1;
                    categories[category].files += 1;
                    categories[category].bytes += size;
                    fingerprint.add(file.relativePath || file.path, size, modified);
                    this.progress.currentSourceFiles = fileCount;
                    if (this.progress.scannedEntries % 1000 === 0) {
                        this.progress.message = `Scanning ${source.label}: ${this.progress.scannedEntries.toLocaleString()} entries · ${fileCount.toLocaleString()} files.`;
                        this.publish();
                    }
                }, () => false);
                const inventory = {
                    id: source.id,
                    rootPath: source.rootPath,
                    canonicalPath,
                    kind: source.kind,
                    scannedAt: Date.now(),
                    fileCount,
                    totalBytes,
                    unknownSizeFiles,
                    categories,
                    fingerprint: fingerprint.finish(),
                };
                this.inventories.set(source.id, inventory);
                this.errors.delete(source.id);
                await this.persist();
            }
            catch (error) {
                this.errors.set(source.id, error instanceof Error ? error.message : String(error));
            }
            this.progress = {
                ...this.progress,
                currentSourceId: null,
                currentSource: "",
                message: this.errors.has(source.id)
                    ? `${source.label} inventory failed; last-known totals retained.`
                    : `Measured ${source.label}: ${fileCount.toLocaleString()} files.`,
            };
            this.publish();
        }
    }
    async persist() {
        const temporaryPath = `${this.cachePath}.tmp`;
        await fsPromises.mkdir(path.dirname(this.cachePath), { recursive: true });
        await fsPromises.writeFile(temporaryPath, JSON.stringify({
            version: 1,
            sources: Array.from(this.inventories.values()),
        }));
        await fsPromises.rename(temporaryPath, this.cachePath);
    }
    publish() {
        this.onUpdate(this.getSnapshot());
    }
}
exports.LibraryStatsManager = LibraryStatsManager;
