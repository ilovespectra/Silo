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
exports.MemoryManager = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const memoryTypes_1 = require("./memoryTypes");
const THEMES = [
    { title: "Beach Days", query: "sunny beach sand ocean seaside holiday", mood: "bright" },
    { title: "Sweet Treats", query: "cakes desserts ice cream sweet treats", mood: "bright" },
    { title: "Rally Car Weekend", query: "rally cars motorsport racing weekend", mood: "energetic" },
    { title: "Stormy Seas", query: "stormy sea ocean waves dramatic clouds", mood: "dramatic" },
    { title: "Portraits", query: "portrait people faces candid expressions", mood: "gentle" },
    { title: "Cozy Family", query: "cozy family together home warm moments", mood: "gentle" },
    { title: "Golden Hour", query: "golden hour sunset warm sunlight scenery", mood: "gentle" },
    { title: "Mountain Air", query: "mountains hiking alpine landscape adventure", mood: "dramatic" },
    { title: "Little Celebrations", query: "birthday celebration party friends smiling", mood: "bright" },
    { title: "City After Dark", query: "city night lights streets neon skyline", mood: "energetic" },
    { title: "Garden Stories", query: "flowers garden plants spring blooms", mood: "gentle" },
    { title: "Best Friends", query: "friends together laughing candid people", mood: "bright" },
    { title: "Snow Day", query: "snow winter snowy landscape outdoors", mood: "bright" },
    { title: "Small Wonders", query: "close up macro delicate details nature", mood: "gentle" },
    { title: "Road Trip", query: "road trip travel countryside scenic roads", mood: "energetic" },
    { title: "Pets at Play", query: "pets dogs cats playing animals", mood: "bright" },
    { title: "Rainy Windows", query: "rain rainy windows reflections quiet indoors", mood: "gentle" },
    { title: "On the Move", query: "sports cycling running action outdoors", mood: "energetic" },
    { title: "Autumn Walks", query: "autumn leaves forest woodland fall colors", mood: "gentle" },
    { title: "Big Skies", query: "dramatic sky clouds expansive landscape horizon", mood: "dramatic" },
];
const MOOD_WORDS = {
    gentle: ["gentle", "soft", "calm", "acoustic", "piano", "cozy", "ambient", "family"],
    bright: ["bright", "happy", "sunny", "joy", "upbeat", "summer", "pop"],
    energetic: ["energetic", "dance", "rock", "driving", "racing", "electronic", "beat"],
    dramatic: ["dramatic", "cinematic", "epic", "orchestral", "storm", "intense"],
};
const DEFAULT_SETTINGS = { showOnLaunch: true, movieDirectory: null };
const MAX_CARDS = 5;
/** Saved extras whose movies are pre-rendered, so they play while sources are offline. */
const RESERVE_CARDS = 5;
const OFFLINE_PROMOTIONS = 3;
const MAX_IDEA_ATTEMPTS = 40;
const MAX_RECENT_KEYS = 80;
const MAX_MEDIA = 24;
const MAX_CACHE_MEDIA = 30;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const RIGHTS = "Song from your music library. Memory movies are for personal viewing only: don't share or upload them, the music is copyrighted.";
const MUSIC_EXTENSION = /\.(mp3|m4a|aac|flac|alac|wav|aiff?|ogg|opus)$/i;
const NOT_MUSIC = /(voice ?memos?|recordings?|ringtones?|podcasts?|audiobooks?|sound ?effects?|\bsfx\b|samples?|whatsapp|telegram|attachments|voicemail|notifications?|alarms?|system sounds|garageband|phone backups?)/i;
const STOP_WORDS = new Set(["photo", "photos", "with", "from", "your", "days", "the", "and", "over", "years",
    "year", "this", "week", "ago", "memories", "moments", "story", "inspired", "across", "library", "folder"]);
const MAX_CUSTOM_TOPIC_LENGTH = 120;
const TITLE_CONNECTORS = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to", "with"]);
function normalizeCustomTopic(value) {
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}
function customTopicTitle(topic) {
    return topic.split(" ").map((word, index) => {
        const normalized = word.toLocaleLowerCase();
        if (index > 0 && TITLE_CONNECTORS.has(normalized))
            return normalized;
        return `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`;
    }).join(" ");
}
function customTopicMood(topic) {
    const words = new Set(topic.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u));
    if (["storm", "stormy", "thunder", "lightning", "night", "dark", "fog", "mist"].some(word => words.has(word)))
        return "dramatic";
    if (["sail", "sailing", "paraglide", "paragliding", "hiking", "climbing", "skiing", "surfing", "cycling", "running", "racing", "kayaking"].some(word => words.has(word)))
        return "energetic";
    if (["sunny", "sun", "beach", "summer", "celebration", "birthday", "picnic", "holiday", "golden", "sunset"].some(word => words.has(word)))
        return "bright";
    return "gentle";
}
/** Songs only: no voice memos, ringtones, podcasts or tiny sound effects. */
function isMusicTrack(file) {
    if (!MUSIC_EXTENSION.test(file.path) || NOT_MUSIC.test(file.path))
        return false;
    return !Number.isFinite(file.size) || (file.size >= 1.5 * 1024 * 1024 && file.size <= 60 * 1024 * 1024);
}
function storyWords(card) {
    const folders = card.media.map(item => path.basename(path.dirname(item.path)));
    return Array.from(new Set(`${card.title} ${card.query} ${card.description} ${folders.join(" ")}`
        .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 4 && !STOP_WORDS.has(word))));
}
function artistOf(filePath) {
    return path.basename(path.dirname(path.dirname(filePath))).toLowerCase();
}
function text(value, max = 4096) {
    return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}
function mediaValue(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const item = value;
    if (!text(item.path) || !text(item.name) || !["image", "video"].includes(item.type)
        || !Number.isFinite(item.modified))
        return undefined;
    return {
        path: item.path, name: item.name, type: item.type, modified: item.modified,
        ...(typeof item.thumbnailUrl === "string" && item.thumbnailUrl.length <= 128 * 1024
            ? { thumbnailUrl: item.thumbnailUrl } : {}),
        ...(text(item.liveVideoPath) && item.type === "image" ? { liveVideoPath: item.liveVideoPath } : {}),
    };
}
function signature(media) {
    return (0, crypto_1.createHash)("sha256").update(JSON.stringify(media.map(item => item.path).sort())).digest("hex");
}
function audioId(filePath) {
    return `library:${(0, crypto_1.createHash)("sha256").update(filePath).digest("hex")}`;
}
/** A bounded, chronological selection; each time bucket chooses its strongest match.
 * Search order is the score fallback, so the adapter need not extend MemoryMedia.
 */
function diverse(items, count) {
    const sorted = items.slice().sort((a, b) => a.media.modified - b.media.modified || b.score - a.score);
    const size = Math.min(count, sorted.length);
    const result = [];
    for (let i = 0; i < size; i++) {
        const start = Math.floor(i * sorted.length / size);
        const end = Math.floor((i + 1) * sorted.length / size);
        let best = sorted[start];
        for (let j = start + 1; j < end; j++)
            if (sorted[j].score > best.score)
                best = sorted[j];
        result.push(best.media);
    }
    return result;
}
/** Constructor is deliberately Electron-free: pass app.getPath("userData") from main. */
class MemoryManager {
    constructor(userDataPath, deps) {
        this.deps = deps;
        this.state = { suggestions: [], settings: { ...DEFAULT_SETTINGS }, generating: false, message: "" };
        this.cursor = 0;
        this.reserve = [];
        this.recentKeys = [];
        this.dismissed = new Set();
        this.writes = Promise.resolve();
        this.statePath = path.join(userDataPath, "memories", "state.json");
    }
    initialize() {
        if (!this.initialization)
            this.initialization = this.load();
        return this.initialization;
    }
    async allowed(filePath) {
        try {
            return await this.deps.isAllowed(filePath) === true;
        }
        catch {
            return false;
        }
    }
    async safeMedia(items, limit) {
        const result = [];
        const seen = new Set();
        for (const value of items.slice(0, limit)) {
            const item = mediaValue(value);
            if (!item || seen.has(item.path) || !await this.allowed(item.path))
                continue;
            seen.add(item.path);
            if (item.liveVideoPath && !await this.allowed(item.liveVideoPath))
                delete item.liveVideoPath;
            if (result.length >= 3)
                delete item.thumbnailUrl;
            result.push(item);
        }
        return result;
    }
    /** Drops photos above the duplicate-similarity ceiling; null when that cannot be verified. */
    async distinctImages(paths) {
        if (!this.deps.filterImages)
            return new Set(paths);
        try {
            const kept = await this.deps.filterImages(paths);
            return Array.isArray(kept) ? new Set(kept) : null;
        }
        catch {
            return null;
        }
    }
    /** Stored cards were de-duplicated when built; only safety is re-checked, so a
     * disconnected source or a busy similarity service never hides saved stories. */
    async visible(cards, max, seen = new Set()) {
        const result = [];
        for (const card of cards) {
            if (result.length >= max)
                break;
            if (this.dismissed.has(card.id))
                continue;
            const media = await this.safeMedia(card.media, MAX_CACHE_MEDIA);
            if (this.dismissed.has(card.id) || media.filter(item => item.type === "image").length < 4)
                continue;
            const key = signature(media);
            if (seen.has(key))
                continue;
            seen.add(key);
            result.push({ ...card, media });
        }
        return result;
    }
    visibleSuggestions() {
        return this.visible(this.state.suggestions, MAX_CARDS);
    }
    async visibleReserve() {
        const seen = new Set(this.state.suggestions.map(card => signature(card.media)));
        return this.visible(this.reserve, RESERVE_CARDS, seen);
    }
    async parseCards(values, max) {
        const cards = [];
        if (!Array.isArray(values))
            return cards;
        for (const value of values.slice(0, max)) {
            if (!value || !text(value.id, 200) || !text(value.title, 200)
                || !text(value.description, 1000) || !text(value.query, 1000)
                || !Object.prototype.hasOwnProperty.call(MOOD_WORDS, value.mood)
                || !Number.isFinite(value.createdAt) || !Array.isArray(value.media))
                continue;
            const media = await this.safeMedia(value.media, MAX_CACHE_MEDIA);
            cards.push({
                id: value.id, title: value.title, description: value.description, query: value.query,
                mood: value.mood,
                defaultDuration: (0, memoryTypes_1.getDefaultMemoryDuration)(Math.min(memoryTypes_1.MEMORY_DEFAULT_SELECTION_COUNT, media.length)),
                ...(text(value.storyKey, 1000) ? { storyKey: value.storyKey } : {}),
                ...(typeof value.soundtrackId === "string" && /^library:[a-f0-9]{64}$/.test(value.soundtrackId)
                    ? { soundtrackId: value.soundtrackId } : {}),
                createdAt: value.createdAt,
                media,
                ...(Number.isFinite(value.downloadedAt) ? { downloadedAt: value.downloadedAt } : {}),
            });
        }
        return cards;
    }
    async load() {
        try {
            const stat = await fs.stat(this.statePath);
            if (stat.size <= MAX_STATE_BYTES) {
                const raw = JSON.parse(await fs.readFile(this.statePath, "utf8"));
                if (raw && typeof raw === "object") {
                    this.cursor = Number.isSafeInteger(raw.cursor) && raw.cursor >= 0 ? raw.cursor % THEMES.length : 0;
                    this.applySettings(raw.settings);
                    if (Array.isArray(raw.dismissed)) {
                        this.dismissed = new Set(raw.dismissed.slice(-512).filter((id) => text(id, 200)));
                    }
                    if (Array.isArray(raw.recentKeys))
                        this.recentKeys = raw.recentKeys.filter((key) => text(key, 1000)).slice(-MAX_RECENT_KEYS);
                    this.state.suggestions = await this.parseCards(raw.suggestions, MAX_CARDS);
                    this.reserve = await this.parseCards(raw.reserve, RESERVE_CARDS);
                }
            }
        }
        catch (error) {
            // Do not log exceptions: adapters and corrupt cache data can contain private paths.
            if (error.code !== "ENOENT") {
                this.state.message = "Saved memories could not be read. Generate new suggestions to continue.";
            }
        }
        this.state.suggestions = await this.visibleSuggestions();
        this.reserve = await this.visibleReserve();
        await this.assignSoundtracks([...this.state.suggestions, ...this.reserve]);
        await this.persist();
    }
    persist() {
        const cards = (list, max) => list.slice(0, max).map(card => ({
            ...card, media: card.media.slice(0, MAX_CACHE_MEDIA),
        }));
        const data = JSON.stringify({
            version: 2, cursor: this.cursor, dismissed: [...this.dismissed].slice(-512),
            recentKeys: this.recentKeys.slice(-MAX_RECENT_KEYS),
            settings: this.state.settings, suggestions: cards(this.state.suggestions, MAX_CARDS),
            reserve: cards(this.reserve, RESERVE_CARDS),
        });
        const write = this.writes.catch(() => undefined).then(async () => {
            await fs.mkdir(path.dirname(this.statePath), { recursive: true });
            const temporary = `${this.statePath}.${(0, crypto_1.randomUUID)()}.tmp`;
            try {
                await fs.writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
                await fs.rename(temporary, this.statePath);
            }
            finally {
                await fs.unlink(temporary).catch(() => undefined);
            }
        });
        this.writes = write;
        return write;
    }
    async getState() {
        await this.initialize();
        return {
            suggestions: await this.visibleSuggestions(), settings: { ...this.state.settings },
            generating: this.state.generating, message: this.state.message,
            reserveCount: (await this.visibleReserve()).length,
        };
    }
    /** Reserve stories, so main can pre-render their movies for offline viewing. */
    async getReserve() {
        await this.initialize();
        return this.visibleReserve();
    }
    generate(replace = false, customTopic) {
        if (this.generation)
            return this.generation;
        const normalizedTopic = customTopic === undefined ? undefined : normalizeCustomTopic(customTopic);
        if (normalizedTopic !== undefined && (normalizedTopic.length < 3 || normalizedTopic.length > MAX_CUSTOM_TOPIC_LENGTH))
            return this.getState().then(state => ({ ...state, message: `Enter a topic between 3 and ${MAX_CUSTOM_TOPIC_LENGTH} characters.` }));
        this.generation = this.generateOnce(replace, normalizedTopic).finally(() => { this.generation = undefined; });
        return this.generation;
    }
    /**
     * The archive's topics changed: rotate the oldest saved extras so the next suggestions
     * reflect it, without touching visible cards or the offline-playable minimum.
     */
    async refreshForProfileChange() {
        await this.initialize();
        if (this.generation)
            return this.generation;
        this.reserve = this.reserve.slice(0, Math.max(OFFLINE_PROMOTIONS, RESERVE_CARDS - 2));
        return this.generate(false);
    }
    /** Turns ranked hits into one story, or null when fewer than four distinct allowed photos remain. */
    async buildCard(idea, hits, signatures, usedPaths) {
        if (!Array.isArray(hits))
            return null;
        const candidates = [];
        const seen = new Set();
        const limit = Math.min(hits.length, 200);
        for (let i = 0; i < limit; i++) {
            const media = mediaValue(hits[i]);
            if (!media || seen.has(media.path) || !await this.allowed(media.path))
                continue;
            seen.add(media.path);
            // Main can optionally supply a relevance score without changing the shared contract.
            const score = hits[i].score;
            candidates.push({ media, score: typeof score === "number" && Number.isFinite(score) ? score : 1 - i / limit });
        }
        const fresh = candidates.filter(item => !usedPaths.has(item.media.path));
        const pool = fresh.filter(item => item.media.type === "image").length >= 4 ? fresh : candidates;
        const ranked = pool.filter(item => item.media.type === "image").sort((a, b) => b.score - a.score);
        if (ranked.length < 4)
            return null;
        // Best shot of each near-identical cluster survives; unverifiable sets are skipped, not wiped.
        const distinct = await this.distinctImages(ranked.map(item => item.media.path));
        if (!distinct)
            return null;
        const photos = ranked.filter(item => distinct.has(item.media.path));
        if (photos.length < 4)
            return null;
        const videos = diverse(pool.filter(item => item.media.type === "video"), Math.min(6, MAX_MEDIA - Math.min(photos.length, 18)));
        const media = [...diverse(photos, MAX_MEDIA - videos.length), ...videos]
            .sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path));
        if (signatures.has(signature(media)))
            return null;
        for (let i = 0; i < media.length; i++) {
            const item = media[i];
            if (item.liveVideoPath && !await this.allowed(item.liveVideoPath))
                delete item.liveVideoPath;
            if (item.type === "image" && !item.liveVideoPath && this.deps.findLiveVideo && await this.allowed(item.path)) {
                try {
                    const live = await this.deps.findLiveVideo({ ...item });
                    if (text(live) && await this.allowed(live))
                        item.liveVideoPath = live;
                }
                catch { /* Missing Live Photo companions are optional. */ }
            }
            // Only the first three covers need previews; never thumbnail the whole story.
            if (i < 3 && !item.thumbnailUrl && await this.allowed(item.path)) {
                try {
                    const thumbnail = await this.deps.thumb(item.path);
                    if (typeof thumbnail === "string" && thumbnail.length <= 128 * 1024)
                        item.thumbnailUrl = thumbnail;
                }
                catch { /* A failed preview must not discard the story. */ }
            }
        }
        const safe = await this.safeMedia(media, MAX_MEDIA);
        if (safe.filter(item => item.type === "image").length < 4 || signatures.has(signature(safe)))
            return null;
        signatures.add(signature(safe));
        return {
            id: (0, crypto_1.randomUUID)(), title: idea.title, query: idea.query, mood: idea.mood,
            defaultDuration: (0, memoryTypes_1.getDefaultMemoryDuration)(Math.min(memoryTypes_1.MEMORY_DEFAULT_SELECTION_COUNT, safe.length)),
            description: idea.description,
            ...(idea.key ? { storyKey: idea.key } : {}),
            media: safe, createdAt: Date.now(),
        };
    }
    async generateOnce(replace, customTopic) {
        await this.initialize();
        this.state.generating = true;
        this.state.message = customTopic ? `Looking for “${customTopic}” in your library…` : "Looking for memories…";
        try {
            // Existing cards stay in place until replacements actually exist.
            const current = await this.visibleSuggestions();
            const reserve = await this.visibleReserve();
            const want = customTopic
                ? 1
                : replace
                    ? MAX_CARDS + RESERVE_CARDS
                    : Math.max(0, MAX_CARDS + RESERVE_CARDS - current.length - reserve.length);
            const signatures = new Set([...current, ...reserve].map(card => signature(card.media)));
            const usedKeys = new Set([...this.recentKeys,
                ...[...current, ...reserve].map(card => card.storyKey).filter((key) => Boolean(key))]);
            const usedPaths = new Set(current.flatMap(card => card.media.map(item => item.path)));
            const produced = [];
            const take = (card) => {
                if (!card)
                    return;
                produced.push(card);
                card.media.forEach(item => usedPaths.add(item.path));
                if (card.storyKey) {
                    this.recentKeys = [...this.recentKeys.filter(key => key !== card.storyKey), card.storyKey].slice(-MAX_RECENT_KEYS);
                }
            };
            let searchFailed = false;
            if (customTopic) {
                try {
                    const topicTitle = customTopicTitle(customTopic);
                    const hits = await this.deps.search(customTopic);
                    const topicKey = (0, crypto_1.createHash)("sha1").update(customTopic.toLocaleLowerCase()).digest("hex").slice(0, 16);
                    take(await this.buildCard({
                        key: `custom:${topicKey}`,
                        title: topicTitle,
                        description: `A story shaped by “${customTopic}” from your library.`,
                        query: customTopic,
                        mood: customTopicMood(customTopic),
                    }, hits, signatures, new Set()));
                }
                catch {
                    searchFailed = true;
                }
            }
            else if (want > 0 && this.deps.discover) {
                let ideas = [];
                try {
                    ideas = await this.deps.discover();
                }
                catch {
                    searchFailed = true;
                }
                if (!Array.isArray(ideas))
                    ideas = [];
                const valid = ideas.filter(idea => idea && text(idea.key, 1000) && text(idea.title, 200)
                    && text(idea.description, 1000) && text(idea.query, 1000)
                    && Object.prototype.hasOwnProperty.call(MOOD_WORDS, idea.mood) && typeof idea.load === "function");
                // Unused ideas first; previously shown ones only when the library has nothing new.
                const ordered = [...valid.filter(idea => !usedKeys.has(idea.key)), ...valid.filter(idea => usedKeys.has(idea.key))];
                for (let attempt = 0; attempt < Math.min(ordered.length, MAX_IDEA_ATTEMPTS) && produced.length < want; attempt++) {
                    const idea = ordered[attempt];
                    let hits;
                    try {
                        hits = await idea.load();
                    }
                    catch {
                        continue;
                    }
                    take(await this.buildCard(idea, hits, signatures, usedPaths));
                }
            }
            // Fixed-theme semantic search covers libraries the miners know little about.
            for (let attempt = 0; !customTopic && attempt < 5 && produced.length < want; attempt++) {
                const theme = THEMES[this.cursor];
                this.cursor = (this.cursor + 1) % THEMES.length;
                let hits;
                try {
                    hits = await this.deps.search(theme.query);
                }
                catch {
                    searchFailed = true;
                    continue;
                }
                take(await this.buildCard({ ...theme, key: `theme:${theme.title}`,
                    description: `A ${theme.mood} story inspired by ${theme.title.toLowerCase()}.` }, hits, signatures, usedPaths));
            }
            let visible;
            let nextReserve;
            let promoted = 0;
            if (produced.length) {
                visible = customTopic
                    ? [produced[0], ...current].slice(0, MAX_CARDS)
                    : replace ? produced.slice(0, MAX_CARDS) : [...current, ...produced].slice(0, MAX_CARDS);
                const placed = new Set(visible.map(card => card.id));
                const leftovers = [...produced, ...(replace || customTopic ? current : []), ...reserve].filter(card => !placed.has(card.id));
                // Old cards refill empty slots before going to reserve; nothing is discarded silently.
                while (visible.length < MAX_CARDS && leftovers.length)
                    visible.push(leftovers.shift());
                nextReserve = leftovers.slice(0, RESERVE_CARDS);
            }
            else if (!customTopic && replace && reserve.length) {
                // Sources offline or exhausted: surface saved stories whose movies are already rendered.
                const promote = reserve.slice(0, OFFLINE_PROMOTIONS);
                promoted = promote.length;
                visible = [...promote, ...current].slice(0, MAX_CARDS);
                const placed = new Set(visible.map(card => card.id));
                nextReserve = [...reserve, ...current].filter(card => !placed.has(card.id)).slice(0, RESERVE_CARDS);
            }
            else {
                visible = current;
                nextReserve = reserve;
            }
            this.state.suggestions = visible;
            this.reserve = nextReserve;
            await this.assignSoundtracks([...visible, ...nextReserve]);
            this.state.suggestions = await this.visibleSuggestions();
            this.reserve = await this.visibleReserve();
            await this.persist();
            const count = this.state.suggestions.length;
            this.state.message = customTopic
                ? produced.length
                    ? `Created a memory for “${customTopicTitle(customTopic)}”.`
                    : searchFailed
                        ? `Local search could not complete for “${customTopicTitle(customTopic)}”. Try again when indexing is ready.`
                        : `Not enough distinct, strong photos matched “${customTopicTitle(customTopic)}”. Try another phrase or index more photos.`
                : produced.length
                    ? `${produced.length} new memor${produced.length === 1 ? "y" : "ies"} found${this.reserve.length ? `, ${this.reserve.length} saved for later` : ""}.`
                    : promoted
                        ? `Showing ${promoted} saved memor${promoted === 1 ? "y" : "ies"}; connect more sources for fresh ones.`
                        : count
                            ? `No new stories right now; your ${count} existing memor${count === 1 ? "y is" : "ies are"} still here.`
                            : searchFailed
                                ? "Search is not ready or unavailable. Try again when indexing is ready."
                                : "No matching memories yet. Each story needs at least four distinct, allowed photos.";
        }
        finally {
            this.state.generating = false;
        }
        return this.getState();
    }
    /** Gives each story without a song its own track, distinct from the other stories' songs and artists. */
    async assignSoundtracks(cards) {
        if (!cards.some(card => !card.soundtrackId))
            return;
        const pool = await this.musicPool();
        if (!pool.length)
            return;
        const usedTracks = new Set(cards.map(card => card.soundtrackId).filter((id) => Boolean(id)));
        const usedArtists = new Set();
        for (const id of usedTracks) {
            const file = this.audioIndex?.ids.get(id);
            if (file)
                usedArtists.add(artistOf(file.path));
        }
        for (const card of cards) {
            if (card.soundtrackId)
                continue;
            const picked = await this.pickSoundtrack(card, pool, usedTracks, usedArtists);
            if (picked)
                card.soundtrackId = picked;
        }
    }
    async dismiss(id) {
        await this.initialize();
        if (text(id, 200)) {
            this.dismissed.add(id);
            if (this.dismissed.size > 512)
                this.dismissed.delete(this.dismissed.values().next().value);
            this.state.suggestions = this.state.suggestions.filter(card => card.id !== id);
            this.reserve = this.reserve.filter(card => card.id !== id);
            // A saved extra takes the dismissed card's place.
            const reserve = await this.visibleReserve();
            if (reserve.length && this.state.suggestions.length < MAX_CARDS) {
                this.state.suggestions.push(reserve[0]);
                this.reserve = this.reserve.filter(card => card.id !== reserve[0].id);
            }
            await this.persist();
        }
        return this.getState();
    }
    applySettings(settings) {
        if (!settings || typeof settings !== "object")
            return;
        for (const key of ["showOnLaunch"]) {
            if (typeof settings[key] === "boolean")
                this.state.settings[key] = settings[key];
        }
        const directory = settings.movieDirectory;
        if (directory === null)
            this.state.settings.movieDirectory = null;
        else if (text(directory) && path.isAbsolute(directory))
            this.state.settings.movieDirectory = directory;
    }
    async updateSettings(settings) {
        await this.initialize();
        this.applySettings(settings);
        await this.persist();
        return this.getState();
    }
    async getSuggestion(id) {
        return (await this.getState()).suggestions.find(card => card.id === id)
            ?? (await this.getReserve()).find(card => card.id === id);
    }
    async getSettings() {
        await this.initialize();
        return { ...this.state.settings };
    }
    async markDownloaded(id) {
        await this.initialize();
        const card = this.state.suggestions.find(item => item.id === id);
        if (card) {
            card.downloadedAt = Date.now();
            await this.persist();
        }
        return this.getState();
    }
    original(card) {
        return { id: `original:${card.id}`, name: "Original audio", source: "original",
            rights: "Sound from your own clips. For personal viewing only." };
    }
    /** Music pool for one generation, so each story is scored against the same snapshot. */
    async musicPool() {
        let files;
        try {
            files = await this.deps.listAudio();
        }
        catch {
            return [];
        }
        if (!Array.isArray(files))
            return [];
        return files.filter(file => file && text(file.path) && text(file.name) && isMusicTrack(file))
            .map(file => ({ file, haystack: `${file.name} ${file.path}`.toLowerCase(), artist: artistOf(file.path) }));
    }
    /**
     * Picks a song whose artist/album/title echoes the story (place, subject, folder names)
     * or its mood, with variety: never a song or artist another current story already uses.
     */
    async pickSoundtrack(card, pool, usedTracks, usedArtists) {
        if (!pool.length)
            return undefined;
        const words = storyWords(card);
        const moods = MOOD_WORDS[card.mood];
        const ranked = [];
        for (const entry of pool) {
            let score = Math.random() * 2;
            for (const word of words)
                if (entry.haystack.includes(word))
                    score += 3;
            for (const word of moods)
                if (entry.haystack.includes(word))
                    score += 1;
            if (usedArtists.has(entry.artist))
                score -= 4;
            if (ranked.length < 24 || score > ranked[ranked.length - 1].score) {
                ranked.push({ file: entry.file, artist: entry.artist, score });
                ranked.sort((a, b) => b.score - a.score);
                if (ranked.length > 24)
                    ranked.pop();
            }
        }
        for (const { file, artist } of ranked) {
            const id = audioId(file.path);
            if (usedTracks.has(id) || !await this.allowed(file.path))
                continue;
            usedTracks.add(id);
            usedArtists.add(artist);
            return id;
        }
        return undefined;
    }
    /**
     * Folder-by-folder (or searched) view of the indexed audio library, for the in-app
     * song explorer. Only one page of files is returned and every file is safety-checked.
     */
    async browseAudio(request = {}) {
        let files;
        try {
            files = await this.deps.listAudio();
        }
        catch {
            files = [];
        }
        if (!Array.isArray(files))
            files = [];
        const sourceOf = (file) => file.sourceId || file.sourceLabel || path.dirname(file.path);
        const relativeOf = (file) => (file.relativePath || file.name).split(/[\\/]+/).filter(Boolean).join("/");
        const sources = new Map();
        for (const file of files) {
            if (!file || !text(file.path) || !text(file.name))
                continue;
            const id = sourceOf(file);
            const entry = sources.get(id) ?? { id, label: file.sourceLabel || path.basename(id) || id, count: 0 };
            entry.count += 1;
            sources.set(id, entry);
        }
        const folder = (request.folder ?? "").split(/[\\/]+/).filter(Boolean).join("/");
        const query = (request.query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
        const inScope = (file) => {
            if (request.sourceId && sourceOf(file) !== request.sourceId)
                return false;
            return !folder || relativeOf(file).startsWith(`${folder}/`);
        };
        const folders = new Map();
        const matched = [];
        if (query.length || request.sourceId) {
            for (const file of files) {
                if (!file || !text(file.path) || !text(file.name) || !inScope(file))
                    continue;
                if (query.length) {
                    const haystack = `${file.name} ${relativeOf(file)} ${file.sourceLabel ?? ""}`.toLowerCase();
                    if (query.every((word) => haystack.includes(word)))
                        matched.push(file);
                    continue;
                }
                // Browsing: direct children are files; deeper paths roll up into their first folder.
                const rest = folder ? relativeOf(file).slice(folder.length + 1) : relativeOf(file);
                const slash = rest.indexOf("/");
                if (slash < 0)
                    matched.push(file);
                else
                    folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
            }
        }
        const sort = request.sort ?? "name";
        const direction = request.direction === "desc" ? -1 : 1;
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        matched.sort((a, b) => direction * (sort === "modified" ? (a.modified ?? 0) - (b.modified ?? 0)
            : sort === "size" ? (a.size ?? 0) - (b.size ?? 0) : collator.compare(a.name, b.name)));
        const offset = Math.max(0, Math.floor(request.offset ?? 0));
        const limit = Math.min(500, Math.max(1, Math.floor(request.limit ?? 200)));
        const page = [];
        for (const file of matched.slice(offset, offset + limit)) {
            if (!await this.allowed(file.path))
                continue;
            const relative = relativeOf(file);
            page.push({ id: audioId(file.path), name: file.name, path: file.path, sourceId: sourceOf(file),
                sourceLabel: sources.get(sourceOf(file))?.label ?? "", folder: relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "",
                size: file.size ?? 0, modified: file.modified ?? 0 });
        }
        return {
            sources: Array.from(sources.values()).sort((a, b) => collator.compare(a.label, b.label)),
            folders: Array.from(folders, ([name, count]) => ({ name, path: folder ? `${folder}/${name}` : name, count }))
                .sort((a, b) => collator.compare(a.name, b.name)),
            files: page,
            total: matched.length,
        };
    }
    /** Use a library song for this memory; returns undefined when the card or song is gone. */
    async setSoundtrack(id, soundtrackId) {
        await this.initialize();
        if (!/^library:[a-f0-9]{64}$/.test(soundtrackId))
            return undefined;
        const card = this.state.suggestions.find((item) => item.id === id) ?? this.reserve.find((item) => item.id === id);
        if (!card || !await this.resolveSoundtrack(soundtrackId, id))
            return undefined;
        card.soundtrackId = soundtrackId;
        await this.persist();
        return { ...card };
    }
    async getSoundtracks(id) {
        const card = await this.getSuggestion(id);
        if (!card)
            return [];
        const result = [this.original(card)];
        const pool = await this.musicPool();
        const keywords = new Set([...MOOD_WORDS[card.mood], ...storyWords(card),
            ...card.query.toLowerCase().split(/\W+/).filter(word => word.length > 2)]);
        const top = [];
        // Score the cached index without per-file safety checks; only the shortlist is verified.
        for (const { file, haystack } of pool) {
            let score = 0;
            for (const word of keywords)
                if (haystack.includes(word))
                    score++;
            if (top.length >= 24 && score <= top[top.length - 1].score)
                continue;
            top.push({ file, score });
            top.sort((a, b) => b.score - a.score);
            if (top.length > 24)
                top.pop();
        }
        const picked = card.soundtrackId ? await this.resolveSoundtrack(card.soundtrackId, card.id) : undefined;
        if (picked)
            result.push(picked);
        for (const { file } of top) {
            if (result.length >= 13)
                break;
            const trackId = audioId(file.path);
            if (trackId === picked?.id || !await this.allowed(file.path))
                continue;
            result.push({ id: trackId, name: file.name, path: file.path, source: "library",
                rights: `${RIGHTS}${text(file.sourceLabel, 200) ? ` Source: ${file.sourceLabel}.` : ""}` });
        }
        return result;
    }
    /** Resolve only IDs minted from the current audio index, never accept an arbitrary path.
     * This validates availability/safety, NOT licensing. Export must separately obtain rights approval.
     */
    async resolveSoundtrack(soundtrackId, suggestionId) {
        await this.initialize();
        if (!text(soundtrackId, 250))
            return undefined;
        if (soundtrackId.startsWith("original:")) {
            const id = soundtrackId.slice("original:".length);
            if (suggestionId !== undefined && id !== suggestionId)
                return undefined;
            const card = await this.getSuggestion(id);
            return card ? this.original(card) : undefined;
        }
        if (!/^library:[a-f0-9]{64}$/.test(soundtrackId))
            return undefined;
        if (suggestionId !== undefined && !await this.getSuggestion(suggestionId))
            return undefined;
        let files;
        try {
            files = await this.deps.listAudio();
        }
        catch {
            return undefined;
        }
        if (!Array.isArray(files))
            return undefined;
        // Hashing every path per lookup is slow for large libraries; index once per audio snapshot.
        if (this.audioIndex?.files !== files) {
            const ids = new Map();
            for (const file of files)
                if (file && text(file.path) && text(file.name))
                    ids.set(audioId(file.path), file);
            this.audioIndex = { files, ids };
        }
        const file = this.audioIndex.ids.get(soundtrackId);
        if (!file || !await this.allowed(file.path))
            return undefined;
        return { id: soundtrackId, name: file.name, path: file.path, source: "library", rights: RIGHTS };
    }
}
exports.MemoryManager = MemoryManager;
