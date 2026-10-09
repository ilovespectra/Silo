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
exports.AestheticScorer = void 0;
const fs_1 = require("fs");
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
// Bump when the raw measurements change so cached results are recomputed.
const METRICS_VERSION = 2;
const ANALYSIS_CONCURRENCY = 1;
const BACKGROUND_COOLDOWN_MIN_MS = 250;
const BACKGROUND_COOLDOWN_MAX_MS = 3000;
const DIVERSITY_WINDOW = 1500;
const RANK_CACHE_SIZE = 12;
// Every photo is compared against all prompts once; presets only choose which ones count.
const PROMPTS = [
    "a stunning professional photograph with beautiful composition and lighting",
    "an award-winning travel photograph",
    "a beautiful candid portrait photo with a sharp subject",
    "a breathtaking landscape photograph at golden hour",
    "a joyful photo of friends and family smiling together",
    "a dramatic wide scenic view of mountains, sea, or a city skyline",
    "a blurry out of focus photo",
    "a dark underexposed photo",
    "a screenshot of a phone screen",
    "a photo of a document, receipt or text",
    "an accidental photo of the floor, ceiling or inside of a pocket",
    "a boring snapshot with a cluttered background", // 11
];
const NEGATIVE = [6, 7, 8, 9, 10, 11];
const PRESETS = {
    balanced: {
        positive: [0, 1, 2, 3],
        weights: {
            clip: 0.32,
            sharpness: 0.18,
            exposure: 0.14,
            composition: 0.12,
            color: 0.1,
            contrast: 0.08,
            face: 0.08,
        },
        noFaceMultiplier: 1,
        largeFaceMultiplier: 1,
        duplicateSimilarity: 0.85,
    },
    people: {
        positive: [2, 4, 0],
        weights: {
            clip: 0.26,
            sharpness: 0.16,
            exposure: 0.14,
            composition: 0.08,
            color: 0.07,
            contrast: 0.07,
            face: 0.22,
        },
        noFaceMultiplier: 0.75,
        largeFaceMultiplier: 1,
        duplicateSimilarity: 0.85,
    },
    landscapes: {
        positive: [3, 5, 1, 0],
        weights: {
            clip: 0.3,
            sharpness: 0.14,
            exposure: 0.12,
            composition: 0.16,
            color: 0.16,
            contrast: 0.12,
            face: 0,
        },
        noFaceMultiplier: 1,
        largeFaceMultiplier: 0.85,
        duplicateSimilarity: 0.85,
    },
    variety: {
        positive: [0, 1, 2, 3, 4, 5],
        weights: {
            clip: 0.32,
            sharpness: 0.18,
            exposure: 0.14,
            composition: 0.12,
            color: 0.1,
            contrast: 0.08,
            face: 0.08,
        },
        noFaceMultiplier: 1,
        largeFaceMultiplier: 1,
        duplicateSimilarity: 0.78,
    },
};
const gauss = (value, center, width) => Math.exp(-(((value - center) / width) ** 2) / 2);
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
function dot(first, second) {
    let sum = 0;
    for (let index = 0; index < first.length; index += 1)
        sum += first[index] * second[index];
    return sum;
}
function hashPaths(items) {
    let hash = 2166136261;
    for (const item of items) {
        for (let index = 0; index < item.path.length; index += 1)
            hash = Math.imul(hash ^ item.path.charCodeAt(index), 16777619);
        hash = Math.imul(hash ^ 10, 16777619);
    }
    return `${items.length}:${(hash >>> 0).toString(36)}`;
}
/**
 * Local photo-quality ranking: CLIP prompt similarity plus classic photographic measurements
 * (exposure, contrast, sharpness, color, composition, faces). Nothing leaves the machine.
 */
class AestheticScorer {
    constructor(deps) {
        this.deps = deps;
        this.cache = new Map();
        this.vectors = new Map();
        this.rankCache = new Map();
        this.loaded = null;
        this.promptVectors = null;
        this.queue = [];
        this.backgroundQueue = [];
        this.libraryTotal = 0;
        this.running = false;
        this.backgroundPaused = false;
        this.generation = 0;
        this.requestTotal = 0;
        this.requestPaths = new Set();
    }
    /** Pause library-wide work while keeping user-requested ranking work available. */
    setBackgroundPaused(paused) {
        this.backgroundPaused = paused;
        if (!paused && (this.queue.length > 0 || this.backgroundQueue.length > 0))
            void this.drain();
    }
    /** Analyzes the whole library at low priority; whatever the user is viewing always goes first. */
    async analyzeInBackground(items) {
        await this.load();
        this.backgroundQueue = items.filter((item) => !this.isFresh(item));
        this.libraryTotal = items.length;
        if (this.backgroundQueue.length > 0)
            void this.drain();
        else
            this.emitProgress();
    }
    /** Ranks what is already analyzed and queues the rest; call again (e.g. on progress) for a fresher order. */
    async rank(items, presetId = "balanced") {
        await this.load();
        const preset = PRESETS[presetId] ?? PRESETS.balanced;
        const images = items.filter((item) => /\.(jpe?g|heic|heif|png|webp|tiff?|gif|bmp|avif|dng|cr2|nef|arw)$/i.test(item.path));
        const missing = images.filter((item) => !this.isFresh(item));
        this.requestPaths = new Set(images.map((item) => item.path));
        this.requestTotal = images.length;
        // The current view replaces older queued work so what the user is looking at finishes first.
        this.queue = missing;
        if (missing.length > 0)
            void this.drain();
        // Cached per preset + photo set + analysis generation, so switching presets back and forth is instant.
        const cacheKey = `${presetId}|${this.generation}|${hashPaths(items)}`;
        let ranked = this.rankCache.get(cacheKey);
        if (!ranked) {
            ranked = await this.computeRanking(items, images, preset);
            this.rankCache.set(cacheKey, ranked);
            if (this.rankCache.size > RANK_CACHE_SIZE)
                this.rankCache.delete(this.rankCache.keys().next().value);
        }
        return {
            order: ranked.order,
            scores: ranked.scores,
            analyzed: images.length - missing.length,
            total: images.length,
            running: this.running,
        };
    }
    /** Magic quality order with a hard pairwise CLIP-similarity ceiling. */
    async rankDistinct(items, presetId = "variety", maximumSimilarity = 0.85) {
        const ranked = await this.rank(items, presetId);
        const order = await this.filterSimilar(ranked.order, maximumSimilarity);
        return { ...ranked, order };
    }
    /** Keep the first Magic-ranked image from each similarity cluster. */
    async filterSimilar(paths, maximumSimilarity = 0.85) {
        if (!Number.isFinite(maximumSimilarity) || maximumSimilarity < 0 || maximumSimilarity > 1)
            throw new Error("Magic duplicate threshold must be between 0 and 1.");
        const uniquePaths = Array.from(new Set(paths));
        const missing = uniquePaths.filter((filePath) => !this.vectors.has(filePath));
        if (missing.length) {
            const loaded = await this.deps.imageVectors(missing);
            loaded.forEach((vector, filePath) => this.vectors.set(filePath, vector));
        }
        const order = [];
        const selected = [];
        for (const filePath of uniquePaths) {
            const vector = this.vectors.get(filePath);
            // A path without a comparable indexed image vector cannot be proven distinct.
            if (!vector || selected.some((other) => dot(vector, other) > maximumSimilarity))
                continue;
            order.push(filePath);
            selected.push(vector);
        }
        return order;
    }
    async computeRanking(items, images, preset) {
        const scored = images.filter((item) => this.isFresh(item) && this.cache.get(item.path)?.metrics);
        const clipRaw = new Map();
        for (const item of scored) {
            const sims = this.cache.get(item.path).metrics.clipSims;
            if (sims)
                clipRaw.set(item.path, mean(preset.positive.map((index) => sims[index])) -
                    mean(NEGATIVE.map((index) => sims[index])));
        }
        const clipValues = Array.from(clipRaw.values());
        const clipMean = mean(clipValues);
        const clipStd = Math.sqrt(mean(clipValues.map((value) => (value - clipMean) ** 2))) || 1;
        const scores = {};
        for (const item of scored) {
            const raw = clipRaw.get(item.path);
            const clip = raw === undefined
                ? 0.5
                : 1 / (1 + Math.exp(-((raw - clipMean) / clipStd) * 1.2));
            scores[item.path] = this.score(this.cache.get(item.path).metrics, clip, preset);
        }
        const byScore = scored
            .map((item) => item.path)
            .sort((first, second) => scores[second] - scores[first]);
        const order = await this.diversify(byScore, scores, preset.duplicateSimilarity);
        const included = new Set(order);
        for (const item of items)
            if (!included.has(item.path))
                order.push(item.path);
        return { order, scores };
    }
    score(metrics, clip, preset) {
        const exposure = gauss(metrics.meanLuma, 0.47, 0.18) *
            (1 - clamp01(metrics.clipped * 2.5));
        const contrast = gauss(metrics.lumaStd, 0.23, 0.11);
        const sharpness = 1 - Math.exp(-metrics.sharpness / 0.0025);
        const color = 0.6 * clamp01(metrics.colorfulness / 70) +
            0.4 * gauss(metrics.saturation, 0.38, 0.22);
        const composition = clamp01(metrics.composition * (1 - clamp01((metrics.clutter - 0.12) * 3)));
        const { weights } = preset;
        const parts = [
            [clip, weights.clip],
            [sharpness, weights.sharpness],
            [exposure, weights.exposure],
            [composition, weights.composition],
            [color, weights.color],
            [contrast, weights.contrast],
        ];
        if (metrics.face !== null && weights.face > 0)
            parts.push([metrics.face, weights.face]);
        const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
        let total = parts.reduce((sum, [value, weight]) => sum + value * weight, 0) /
            totalWeight;
        if (metrics.face === null)
            total *= preset.noFaceMultiplier;
        if (metrics.faceArea > 0.04)
            total *= preset.largeFaceMultiplier;
        if (metrics.screenshotLike)
            total *= 0.35;
        if (metrics.lowResolution)
            total *= 0.7;
        return Math.round(total * 1000) / 10;
    }
    /** Demotes near-identical shots (bursts) so the top of the list covers distinct moments. */
    async diversify(byScore, scores, threshold) {
        const window = byScore.slice(0, DIVERSITY_WINDOW);
        const needVectors = window.filter((filePath) => !this.vectors.has(filePath));
        if (needVectors.length > 0) {
            const loaded = await this.deps.imageVectors(needVectors);
            loaded.forEach((vector, filePath) => this.vectors.set(filePath, vector));
        }
        const kept = [];
        const keptVectors = [];
        const demoted = [];
        for (let index = 0; index < window.length; index += 1) {
            const filePath = window[index];
            const vector = this.vectors.get(filePath);
            if (vector &&
                keptVectors.some((other) => dot(vector, other) >= threshold)) {
                demoted.push(filePath);
            }
            else {
                kept.push(filePath);
                if (vector)
                    keptVectors.push(vector);
            }
            if (index % 100 === 99)
                await new Promise((resolve) => setImmediate(resolve));
        }
        const rest = [...demoted, ...byScore.slice(DIVERSITY_WINDOW)].sort((first, second) => scores[second] - scores[first]);
        return [...kept, ...rest];
    }
    isFresh(item) {
        const entry = this.cache.get(item.path);
        return Boolean(entry &&
            entry.version === METRICS_VERSION &&
            entry.signature === `${item.size}:${item.modified}`);
    }
    async drain() {
        if (this.running)
            return;
        this.running = true;
        try {
            this.emitProgress();
            this.promptVectors ?? (this.promptVectors = await this.deps
                .embedPrompts(PROMPTS)
                .catch(() => null));
            let lastEmit = 0;
            const worker = async () => {
                while (this.queue.length > 0 ||
                    (!this.backgroundPaused && this.backgroundQueue.length > 0)) {
                    const foreground = this.queue.length > 0;
                    const item = foreground
                        ? this.queue.shift()
                        : this.backgroundQueue.shift();
                    if (this.isFresh(item))
                        continue;
                    const workStartedAt = Date.now();
                    await this.analyze(item, foreground);
                    if (Date.now() - lastEmit > 1500) {
                        lastEmit = Date.now();
                        this.emitProgress();
                    }
                    // Keep photo analysis at a low duty cycle. Search pauses this queue;
                    // the cooldown also limits sustained CPU when no search is active.
                    if (!foreground) {
                        const workMs = Math.max(0, Date.now() - workStartedAt);
                        const cooldownMs = Math.min(BACKGROUND_COOLDOWN_MAX_MS, Math.max(BACKGROUND_COOLDOWN_MIN_MS, Math.round(workMs * 2)));
                        const cooldownUntil = Date.now() + cooldownMs;
                        while (Date.now() < cooldownUntil &&
                            !this.backgroundPaused &&
                            this.queue.length === 0) {
                            await new Promise((resolve) => setTimeout(resolve, Math.min(50, cooldownUntil - Date.now())));
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: ANALYSIS_CONCURRENCY }, worker));
        }
        finally {
            this.running = false;
            this.emitProgress();
        }
    }
    emitProgress() {
        let analyzed = 0;
        for (const filePath of this.requestPaths)
            if (this.cache.get(filePath)?.version === METRICS_VERSION)
                analyzed += 1;
        this.deps.onProgress({
            analyzed: Math.min(analyzed, this.requestTotal),
            total: this.requestTotal,
            running: this.running,
            libraryAnalyzed: Math.max(0, this.libraryTotal - this.backgroundQueue.length),
            libraryTotal: this.libraryTotal,
        });
    }
    async analyze(item, foreground) {
        let metrics = null;
        let preview = null;
        try {
            if (foreground) {
                const file = await this.deps.thumbnailFile(item.path);
                preview = file ? { file, dispose: async () => undefined } : null;
            }
            else {
                preview = await this.deps.temporaryPreview(item.path);
            }
            // No preview usually means an unplugged drive; leave it uncached so it is retried later.
            if (!preview)
                return;
            metrics = await this.measure(item, preview.file);
        }
        catch {
            metrics = null;
        }
        finally {
            await preview?.dispose().catch(() => undefined);
        }
        const entry = {
            path: item.path,
            signature: `${item.size}:${item.modified}`,
            version: METRICS_VERSION,
            metrics,
        };
        this.cache.set(item.path, entry);
        this.generation += 1;
        await fsPromises
            .appendFile(this.deps.cachePath, `${JSON.stringify(entry)}\n`)
            .catch(() => undefined);
    }
    async measure(item, thumbnail) {
        const sharp = require("sharp");
        const { data, info } = await sharp(thumbnail)
            .resize(256, 256, { fit: "inside" })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const width = info.width;
        const height = info.height;
        const channels = info.channels;
        const pixels = width * height;
        const luma = new Float32Array(pixels);
        let lumaSum = 0;
        let clipped = 0;
        let rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0, saturationSum = 0;
        for (let index = 0; index < pixels; index += 1) {
            const r = data[index * channels];
            const g = data[index * channels + 1];
            const b = data[index * channels + 2];
            const value = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            luma[index] = value;
            lumaSum += value;
            if (value < 0.03 || value > 0.97)
                clipped += 1;
            const rg = r - g;
            const yb = 0.5 * (r + g) - b;
            rgSum += rg;
            ybSum += yb;
            rgSq += rg * rg;
            ybSq += yb * yb;
            const max = Math.max(r, g, b);
            saturationSum += max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
        }
        const meanLuma = lumaSum / pixels;
        let variance = 0;
        for (let index = 0; index < pixels; index += 1)
            variance += (luma[index] - meanLuma) ** 2;
        const lumaStd = Math.sqrt(variance / pixels);
        // Hasler & Suesstrunk colorfulness.
        const rgMean = rgSum / pixels, ybMean = ybSum / pixels;
        const rgStd = Math.sqrt(Math.max(0, rgSq / pixels - rgMean ** 2));
        const ybStd = Math.sqrt(Math.max(0, ybSq / pixels - ybMean ** 2));
        const colorfulness = Math.sqrt(rgStd ** 2 + ybStd ** 2) +
            0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2);
        // Laplacian variance per 3x3 tile: a sharp subject on a soft background should still score as sharp.
        const tileSums = new Float64Array(9), tileSq = new Float64Array(9), tileCounts = new Float64Array(9);
        let gradientSum = 0, salientX = 0, salientY = 0, salientWeight = 0;
        for (let y = 1; y < height - 1; y += 1) {
            for (let x = 1; x < width - 1; x += 1) {
                const index = y * width + x;
                const laplacian = 4 * luma[index] -
                    luma[index - 1] -
                    luma[index + 1] -
                    luma[index - width] -
                    luma[index + width];
                const tile = Math.min(2, Math.floor((y / height) * 3)) * 3 +
                    Math.min(2, Math.floor((x / width) * 3));
                tileSums[tile] += laplacian;
                tileSq[tile] += laplacian * laplacian;
                tileCounts[tile] += 1;
                const gradient = Math.abs(luma[index + 1] - luma[index - 1]) +
                    Math.abs(luma[index + width] - luma[index - width]);
                gradientSum += gradient;
                const weight = gradient * gradient;
                salientX += (x / width) * weight;
                salientY += (y / height) * weight;
                salientWeight += weight;
            }
        }
        const tileVariances = Array.from(tileSums, (sum, tile) => tileCounts[tile]
            ? tileSq[tile] / tileCounts[tile] - (sum / tileCounts[tile]) ** 2
            : 0);
        const sharpness = 0.7 * Math.max(...tileVariances) + 0.3 * mean(tileVariances);
        const clutter = gradientSum / Math.max(1, (width - 2) * (height - 2));
        // Subject (edge-energy centroid) near a rule-of-thirds point, or deliberately centered.
        const cx = salientWeight ? salientX / salientWeight : 0.5;
        const cy = salientWeight ? salientY / salientWeight : 0.5;
        const thirds = Math.min(...[1 / 3, 2 / 3].flatMap((tx) => [1 / 3, 2 / 3].map((ty) => Math.hypot(cx - tx, cy - ty))));
        const composition = Math.max(clamp01(1 - thirds / 0.3), 0.85 * clamp01(1 - Math.hypot(cx - 0.5, cy - 0.5) / 0.3));
        const boxes = this.deps.faceBoxes(item.path);
        let face = null;
        let faceArea = 0;
        if (boxes.length > 0) {
            const largest = boxes.reduce((best, box) => box.width * box.height > best.width * best.height ? box : best);
            faceArea = largest.width * largest.height;
            const sizeScore = faceArea < 0.004 ? 0.35 : faceArea > 0.45 ? 0.6 : 1;
            const placement = largest.y + largest.height / 2 < 0.65 ? 1 : 0.7;
            const cropped = largest.x < 0.01 ||
                largest.y < 0.01 ||
                largest.x + largest.width > 0.99 ||
                largest.y + largest.height > 0.99;
            face =
                sizeScore *
                    placement *
                    (cropped ? 0.6 : 1) *
                    (0.7 + 0.3 * Math.min(1, largest.score));
        }
        const name = item.name || path.basename(item.path);
        const screenshotLike = /screen ?shot|screen_recording|^simulator/i.test(name) ||
            (/\.png$/i.test(name) &&
                boxes.length === 0 &&
                Math.abs(width / height - 0.462) < 0.03);
        let clipSims = null;
        if (this.promptVectors) {
            const vector = (await this.deps.imageVectors([item.path])).get(item.path);
            if (vector) {
                this.vectors.set(item.path, vector);
                clipSims = this.promptVectors.map((prompt) => Math.round(dot(vector, prompt) * 1e5) / 1e5);
            }
        }
        return {
            meanLuma,
            lumaStd,
            clipped: clipped / pixels,
            sharpness,
            colorfulness,
            saturation: saturationSum / pixels,
            composition,
            clutter,
            face,
            faceArea,
            screenshotLike,
            lowResolution: item.size > 0 && item.size < 120000,
            clipSims,
        };
    }
    load() {
        this.loaded ?? (this.loaded = (async () => {
            try {
                const lines = readline.createInterface({
                    input: (0, fs_1.createReadStream)(this.deps.cachePath, { encoding: "utf8" }),
                    crlfDelay: Infinity,
                });
                for await (const line of lines) {
                    if (!line.trim())
                        continue;
                    try {
                        const entry = JSON.parse(line);
                        this.cache.set(entry.path, entry);
                    }
                    catch {
                        // Skip a partially written trailing line.
                    }
                }
            }
            catch {
                await fsPromises.mkdir(path.dirname(this.deps.cachePath), {
                    recursive: true,
                });
            }
        })());
        return this.loaded;
    }
}
exports.AestheticScorer = AestheticScorer;
