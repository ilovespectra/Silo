import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import {
  getDefaultMemoryDuration,
  MEMORY_DEFAULT_SELECTION_COUNT,
  MEMORY_MIN_SELECTION_COUNT,
  MemoryAudioBrowseRequest, MemoryAudioBrowseResult, MemoryAudioBrowseFile,
  MemoryGenerationProgress,
  MemoryGenerationStatus,
  MemoryMedia, MemoryMood, MemorySettings, MemorySoundtrack,
  MemoryState, MemorySuggestion,
} from "./memoryTypes";

export interface MemoryAudioFile {
  name: string;
  path: string;
  sourceLabel?: string;
  size?: number;
  modified?: number;
  sourceId?: string;
  /** Path relative to its source root, used for folder browsing. */
  relativePath?: string;
}

/** Main supplies ready, safety-filtered, all-source search and the cached audio index.
 * Never implement these callbacks by scanning the inventory inside this manager.
 */
export interface MemoryManagerDependencies {
  search(query: string): Promise<MemoryMedia[]>;
  /** Prompted videos use confidence-first personal-photo matching and never Magic order. */
  searchPrompted?(query: string): Promise<MemoryMedia[]>;
  /** True when a story's movie is finished, so it can leave the editable set for the Memory Book. */
  hasMovie?(card: MemorySuggestion): Promise<boolean>;
  /** Magic's ordered image filter removes shots above the duplicate-similarity threshold. */
  filterImages?(paths: string[]): Promise<string[]>;
  thumb(path: string): string | null | undefined | Promise<string | null | undefined>;
  listAudio(): MemoryAudioFile[] | Promise<MemoryAudioFile[]>;
  isAllowed(path: string): boolean | Promise<boolean>;
  findLiveVideo?(file: MemoryMedia): Promise<string | null | undefined>;
  /** Story ideas mined from the library (time, places, people, pets, subjects, folders). */
  discover?(): Promise<MemoryStoryCandidate[]>;
  /** Records why a search step failed; failures are otherwise swallowed per step. */
  onSearchError?(stage: string, error: unknown): void;
  /** Path-free counts explaining each generation step, for diagnostics. */
  onTrace?(event: string, details: Record<string, unknown>): void;
  /** Live status while a generation pass runs. */
  onGenerationProgress?(status: MemoryGenerationStatus): void;
}

export interface MemoryStoryCandidate {
  key: string;
  title: string;
  description: string;
  query: string;
  mood: MemoryMood;
  /** Loaded lazily; only ideas actually tried pay for vector reads. */
  load(): Promise<(MemoryMedia & { score?: number })[]>;
}

interface Theme {
  title: string;
  query: string;
  mood: MemoryMood;
}

const THEMES: readonly Theme[] = [
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

const MOOD_WORDS: Record<MemoryMood, readonly string[]> = {
  gentle: ["gentle", "soft", "calm", "acoustic", "piano", "cozy", "ambient", "family"],
  bright: ["bright", "happy", "sunny", "joy", "upbeat", "summer", "pop"],
  energetic: ["energetic", "dance", "rock", "driving", "racing", "electronic", "beat"],
  dramatic: ["dramatic", "cinematic", "epic", "orchestral", "storm", "intense"],
};
const DEFAULT_SETTINGS: MemorySettings = { showOnLaunch: true, movieDirectory: null };
/** Saved memories persist across runs; new generations are added in front, never replacing them. */
const MAX_CARDS = 60;
/** Fresh stories one generation run adds to the saved collection. */
const NEW_PER_RUN = 5;
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

function normalizeCustomTopic(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function customTopicQueries(topic: string): string[] {
  const normalized = normalizeCustomTopic(topic);
  if (!normalized) return [];
  const unique = new Set<string>();
  const tokens = normalized.split(/\s+/).filter(Boolean).map(word => word.toLocaleLowerCase());
  const meaningful = tokens.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  const variants = [normalized];
  if (meaningful.length) variants.push(meaningful.join(" "));
  variants.push(`photo of ${normalized}`);
  variants.push(`photos of ${normalized}`);
  variants.push(`a photo of ${normalized}`);
  if (meaningful.length > 1) {
    variants.push(meaningful.slice(0, Math.min(meaningful.length, 4)).join(" "));
    variants.push(meaningful.slice(-Math.min(meaningful.length, 4)).join(" "));
  }
  for (const word of meaningful) {
    variants.push(word);
  }
  for (const variant of variants) {
    const trimmed = normalizeCustomTopic(variant);
    if (trimmed) unique.add(trimmed);
  }
  return [...unique].slice(0, 8);
}

function customTopicTitle(topic: string): string {
  return topic.split(" ").map((word, index) => {
    const normalized = word.toLocaleLowerCase();
    if (index > 0 && TITLE_CONNECTORS.has(normalized)) return normalized;
    return `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`;
  }).join(" ");
}

function customTopicMood(topic: string): MemoryMood {
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
function isMusicTrack(file: MemoryAudioFile): boolean {
  if (!MUSIC_EXTENSION.test(file.path) || NOT_MUSIC.test(file.path)) return false;
  return !Number.isFinite(file.size) || ((file.size as number) >= 1.5 * 1024 * 1024 && (file.size as number) <= 60 * 1024 * 1024);
}

function storyWords(card: Pick<MemorySuggestion, "title" | "query" | "description" | "media">): string[] {
  const folders = card.media.map(item => path.basename(path.dirname(item.path)));
  return Array.from(new Set(`${card.title} ${card.query} ${card.description} ${folders.join(" ")}`
    .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 4 && !STOP_WORDS.has(word))));
}

function artistOf(filePath: string): string {
  return path.basename(path.dirname(path.dirname(filePath))).toLowerCase();
}

function text(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

function mediaValue(value: unknown): MemoryMedia | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as MemoryMedia;
  if (!text(item.path) || !text(item.name) || !["image", "video"].includes(item.type)
    || !Number.isFinite(item.modified)) return undefined;
  return {
    path: item.path, name: item.name, type: item.type, modified: item.modified,
    ...(typeof item.thumbnailUrl === "string" && item.thumbnailUrl.length <= 128 * 1024
      ? { thumbnailUrl: item.thumbnailUrl } : {}),
    ...(text(item.liveVideoPath) && item.type === "image" ? { liveVideoPath: item.liveVideoPath } : {}),
  };
}

function signature(media: MemoryMedia[]): string {
  return createHash("sha256").update(JSON.stringify(media.map(item => item.path).sort())).digest("hex");
}

const STORY_OVERLAP_THRESHOLD = 0.6;

function storyImagePaths(media: MemoryMedia[]): Set<string> {
  return new Set(media.filter(item => item.type === "image").map(item => item.path));
}

/** Reject a new story when most of its photos already make up a saved story. */
function materiallyOverlapsStory(media: MemoryMedia[], existing: MemoryMedia[][]): boolean {
  const incoming = storyImagePaths(media);
  if (!incoming.size) return false;
  for (const story of existing) {
    const prior = storyImagePaths(story);
    if (!prior.size) continue;
    let shared = 0;
    for (const filePath of incoming) if (prior.has(filePath)) shared++;
    if (shared / Math.min(incoming.size, prior.size) >= STORY_OVERLAP_THRESHOLD) return true;
  }
  return false;
}

function audioId(filePath: string): string {
  return `library:${createHash("sha256").update(filePath).digest("hex")}`;
}

/** A bounded, chronological selection; each time bucket chooses its strongest match.
 * Search order is the score fallback, so the adapter need not extend MemoryMedia.
 */
function diverse(items: { media: MemoryMedia; score: number }[], count: number): MemoryMedia[] {
  const sorted = items.slice().sort((a, b) => a.media.modified - b.media.modified || b.score - a.score);
  const size = Math.min(count, sorted.length);
  const result: MemoryMedia[] = [];
  for (let i = 0; i < size; i++) {
    const start = Math.floor(i * sorted.length / size);
    const end = Math.floor((i + 1) * sorted.length / size);
    let best = sorted[start];
    for (let j = start + 1; j < end; j++) if (sorted[j].score > best.score) best = sorted[j];
    result.push(best.media);
  }
  return result;
}

/** Constructor is deliberately Electron-free: pass app.getPath("userData") from main. */
export class MemoryManager {
  private readonly statePath: string;
  private state: MemoryState = { suggestions: [], settings: { ...DEFAULT_SETTINGS }, generating: false, message: "", generationProgress: undefined };
  private cursor = 0;
  private reserve: MemorySuggestion[] = [];
  private audioIndex?: { files: MemoryAudioFile[]; ids: Map<string, MemoryAudioFile> };
  private recentKeys: string[] = [];
  private dismissed = new Set<string>();
  private initialization?: Promise<void>;
  private generation?: Promise<MemoryState>;
  private generationReplaces = false;
  private generationExpected = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, private readonly deps: MemoryManagerDependencies) {
    this.statePath = path.join(userDataPath, "memories", "state.json");
  }

  initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.load();
    return this.initialization;
  }

  private async allowed(filePath: string): Promise<boolean> {
    try { return await this.deps.isAllowed(filePath) === true; } catch { return false; }
  }

  private async safeMedia(items: MemoryMedia[], limit: number): Promise<MemoryMedia[]> {
    const result: MemoryMedia[] = [];
    const seen = new Set<string>();
    for (const value of items.slice(0, limit)) {
      const item = mediaValue(value);
      if (!item || seen.has(item.path) || !await this.allowed(item.path)) continue;
      seen.add(item.path);
      if (item.liveVideoPath && !await this.allowed(item.liveVideoPath)) delete item.liveVideoPath;
      if (result.length >= 3) delete item.thumbnailUrl;
      result.push(item);
    }
    return result;
  }

  /** Drops photos above the duplicate-similarity ceiling; null when that cannot be verified. */
  private async distinctImages(paths: string[]): Promise<Set<string> | null> {
    if (!this.deps.filterImages) return new Set(paths);
    try {
      const kept = await this.deps.filterImages(paths);
      return Array.isArray(kept) ? new Set(kept) : null;
    } catch (error) {
      this.trace("memory-duplicate-check-failed", { message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private emitGenerationProgress() {
    try {
      this.deps.onGenerationProgress?.({ generating: this.state.generating, expected: this.generationExpected,
        ...(this.state.generationProgress ? { progress: this.state.generationProgress } : {}) });
    } catch { /* Progress display never affects generation. */ }
  }

  /** Rejection reasons for the current generation run, summarised in memory-generate-result. */
  private runRejections = new Map<string, number>();

  private trace(event: string, details: Record<string, unknown>) {
    try { this.deps.onTrace?.(event, details); } catch { /* Diagnostics never affect generation. */ }
  }

  /** Stored cards were de-duplicated when built; only safety is re-checked, so a
   * disconnected source or a busy similarity service never hides saved stories. */
  private async visible(cards: MemorySuggestion[], max: number, seen = new Set<string>()): Promise<MemorySuggestion[]> {
    const result: MemorySuggestion[] = [];
    for (const card of cards) {
      if (result.length >= max) break;
      if (this.dismissed.has(card.id)) continue;
      const media = await this.safeMedia(card.media, MAX_CACHE_MEDIA);
      if (this.dismissed.has(card.id) || media.filter(item => item.type === "image").length < 4) continue;
      const key = signature(media);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...card, media });
    }
    return result;
  }

  private async unfinished(cards: MemorySuggestion[]): Promise<MemorySuggestion[]> {
    if (!this.deps.hasMovie) return [];
    const result: MemorySuggestion[] = [];
    for (const card of cards) {
      if (!await this.deps.hasMovie(card).catch(() => false)) result.push(card);
    }
    return result;
  }

  private visibleSuggestions(): Promise<MemorySuggestion[]> {
    return this.visible(this.state.suggestions, MAX_CARDS);
  }

  private async visibleReserve(): Promise<MemorySuggestion[]> {
    const seen = new Set(this.state.suggestions.map(card => signature(card.media)));
    return this.visible(this.reserve, RESERVE_CARDS, seen);
  }

  private async parseCards(values: unknown, max: number): Promise<MemorySuggestion[]> {
    const cards: MemorySuggestion[] = [];
    if (!Array.isArray(values)) return cards;
    for (const value of values.slice(0, max)) {
      if (!value || !text(value.id, 200) || !text(value.title, 200)
        || !text(value.description, 1000) || !text(value.query, 1000)
        || !Object.prototype.hasOwnProperty.call(MOOD_WORDS, value.mood)
        || !Number.isFinite(value.createdAt) || !Array.isArray(value.media)) continue;
      const media = await this.safeMedia(value.media, MAX_CACHE_MEDIA);
      cards.push({
        id: value.id, title: value.title, description: value.description, query: value.query,
        mood: value.mood,
        defaultDuration: getDefaultMemoryDuration(Math.min(MEMORY_DEFAULT_SELECTION_COUNT, media.length)),
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

  private async load(): Promise<void> {
    try {
      const stat = await fs.stat(this.statePath);
      if (stat.size <= MAX_STATE_BYTES) {
        const raw = JSON.parse(await fs.readFile(this.statePath, "utf8"));
        if (raw && typeof raw === "object") {
          this.cursor = Number.isSafeInteger(raw.cursor) && raw.cursor >= 0 ? raw.cursor % THEMES.length : 0;
          this.applySettings(raw.settings);
          if (Array.isArray(raw.dismissed)) {
            this.dismissed = new Set(raw.dismissed.slice(-512).filter((id: unknown) => text(id, 200)));
          }
          if (Array.isArray(raw.recentKeys))
            this.recentKeys = raw.recentKeys.filter((key: unknown) => text(key, 1000)).slice(-MAX_RECENT_KEYS);
          this.state.suggestions = await this.parseCards(raw.suggestions, MAX_CARDS);
          this.reserve = await this.parseCards(raw.reserve, RESERVE_CARDS);
        }
      }
    } catch (error) {
      // Do not log exceptions: adapters and corrupt cache data can contain private paths.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.state.message = "Saved memories could not be read. Generate new suggestions to continue.";
      }
    }
    this.state.suggestions = await this.visibleSuggestions();
    this.reserve = await this.visibleReserve();
    await this.assignSoundtracks([...this.state.suggestions, ...this.reserve]);
    await this.persist();
  }

  private persist(): Promise<void> {
    const cards = (list: MemorySuggestion[], max: number) => list.slice(0, max).map(card => ({
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
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, this.statePath);
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
    });
    this.writes = write;
    return write;
  }

  private updateGenerationProgress(
    phase: MemoryGenerationProgress["phase"],
    completed: number,
    total: number,
    label: string,
    startedAt: number,
  ): void {
    const safeTotal = Math.max(1, total);
    const clamped = Math.max(0, Math.min(completed, safeTotal));
    const progress = clamped / safeTotal;
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const etaSeconds = progress > 0.05 && elapsedSeconds > 0
      ? Math.max(0, Math.round((elapsedSeconds / progress) * (1 - progress)))
      : undefined;
    this.state.generationProgress = { phase, label, progress, ...(etaSeconds !== undefined ? { etaSeconds } : {}) };
    this.emitGenerationProgress();
  }

  async getState(): Promise<MemoryState> {
    await this.initialize();
    return {
      suggestions: await this.visibleSuggestions(), settings: { ...this.state.settings },
      generating: this.state.generating, message: this.state.message,
      generationProgress: this.state.generationProgress,
      reserveCount: (await this.visibleReserve()).length,
    };
  }

  /** Reserve stories, so main can pre-render their movies for offline viewing. */
  async getReserve(): Promise<MemorySuggestion[]> {
    await this.initialize();
    return this.visibleReserve();
  }

  generate(replace = false, customTopic?: string): Promise<MemoryState> {
    if (this.generation) {
      // An automatic top-up is running: let it finish, then honour the user's Generate.
      if (replace && !this.generationReplaces) {
        const queued = this.generation.catch(() => undefined).then(() => this.generate(replace, customTopic));
        return queued;
      }
      return this.generation;
    }
    const normalizedTopic = customTopic === undefined ? undefined : normalizeCustomTopic(customTopic);
    if (normalizedTopic !== undefined && (normalizedTopic.length < 3 || normalizedTopic.length > MAX_CUSTOM_TOPIC_LENGTH))
      return this.getState().then(state => ({ ...state, message: `Enter a topic between 3 and ${MAX_CUSTOM_TOPIC_LENGTH} characters.` }));
    this.generationReplaces = replace;
    this.generation = this.generateOnce(replace, normalizedTopic).finally(() => { this.generation = undefined; this.generationReplaces = false; });
    return this.generation;
  }

  /**
   * The archive's topics changed: rotate the oldest saved extras so the next suggestions
   * reflect it, without touching visible cards or the offline-playable minimum.
   */
  async refreshForProfileChange(): Promise<MemoryState> {
    await this.initialize();
    if (this.generation) return this.generation;
    this.reserve = this.reserve.slice(0, Math.max(OFFLINE_PROMOTIONS, RESERVE_CARDS - 2));
    return this.generate(false);
  }

  /** Turns ranked hits into one story, or null when fewer than four distinct allowed photos remain. */
  private async buildCard(
    idea: { title: string; description: string; query: string; mood: MemoryMood; key?: string },
    hits: unknown,
    signatures: Set<string>,
    usedPaths: Set<string>,
    existingStories: MemoryMedia[][],
  ): Promise<MemorySuggestion | null> {
    const reject = (reason: string, counts: Record<string, number> = {}) => {
      this.runRejections.set(reason, (this.runRejections.get(reason) ?? 0) + 1);
      this.trace("memory-story-rejected", { story: idea.key?.split(":")[0] ?? "theme", reason, ...counts });
      return null;
    };
    if (!Array.isArray(hits)) return reject("search-returned-no-list");
    const candidates: { media: MemoryMedia; score: number }[] = [];
    const seen = new Set<string>();
    const limit = Math.min(hits.length, 200);
    let invalid = 0;
    let duplicate = 0;
    let blocked = 0;
    for (let i = 0; i < limit; i++) {
      const media = mediaValue(hits[i]);
      if (!media) { invalid++; continue; }
      if (seen.has(media.path)) { duplicate++; continue; }
      if (!await this.allowed(media.path)) { blocked++; continue; }
      seen.add(media.path);
      // Main can optionally supply a relevance score without changing the shared contract.
      const score = (hits[i] as MemoryMedia & { score?: number }).score;
      candidates.push({ media, score: typeof score === "number" && Number.isFinite(score) ? score : 1 - i / limit });
    }
    if (materiallyOverlapsStory(candidates.filter(item => item.media.type === "image").map(item => item.media), existingStories))
      return reject("overlaps-existing-story", { hits: hits.length, allowed: candidates.length,
        fresh: candidates.filter(item => !usedPaths.has(item.media.path)).length,
        images: candidates.filter(item => item.media.type === "image").length });
    // Do not refill a sparse prompt with photos already used by another story.
    const pool = candidates.filter(item => !usedPaths.has(item.media.path));
    const ranked = pool.filter(item => item.media.type === "image").sort((a, b) => b.score - a.score);
    const counts = { hits: hits.length, allowed: candidates.length, fresh: pool.length, images: ranked.length,
      invalid, duplicate, blocked, videos: pool.length - ranked.length };
    if (ranked.length < 4) return reject(hits.length ? "too-few-allowed-photos" : "no-search-hits", counts);
    // Best shot of each near-identical cluster survives; unverifiable sets are skipped, not wiped.
    const distinct = await this.distinctImages(ranked.map(item => item.media.path));
    if (!distinct) return reject("duplicate-check-unavailable", counts);
    const photos = ranked.filter(item => distinct.has(item.media.path));
    if (photos.length < 4) return reject("too-few-distinct-photos", { ...counts, distinct: photos.length });
    const videos = diverse(pool.filter(item => item.media.type === "video"), Math.min(6, MAX_MEDIA - Math.min(photos.length, 18)));
    const media = [...diverse(photos, MAX_MEDIA - videos.length), ...videos]
      .sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path));
    if (signatures.has(signature(media))) return reject("same-photos-as-existing-story", counts);
    if (materiallyOverlapsStory(media, existingStories))
      return reject("overlaps-existing-story", { ...counts, selected: media.filter(item => item.type === "image").length });
    for (let i = 0; i < media.length; i++) {
      const item = media[i];
      if (item.liveVideoPath && !await this.allowed(item.liveVideoPath)) delete item.liveVideoPath;
      if (item.type === "image" && !item.liveVideoPath && this.deps.findLiveVideo && await this.allowed(item.path)) {
        try {
          const live = await this.deps.findLiveVideo({ ...item });
          if (text(live) && await this.allowed(live)) item.liveVideoPath = live;
        } catch { /* Missing Live Photo companions are optional. */ }
      }
      // Only the first three covers need previews; never thumbnail the whole story.
      if (i < 3 && !item.thumbnailUrl && await this.allowed(item.path)) {
        try {
          const thumbnail = await this.deps.thumb(item.path);
          if (typeof thumbnail === "string" && thumbnail.length <= 128 * 1024) item.thumbnailUrl = thumbnail;
        } catch { /* A failed preview must not discard the story. */ }
      }
    }
    const safe = await this.safeMedia(media, MAX_MEDIA);
    const safeImages = safe.filter(item => item.type === "image").length;
    if (safeImages < 4) return reject("too-few-safe-photos", { ...counts, distinct: photos.length, safe: safeImages });
    if (signatures.has(signature(safe))) return reject("same-photos-as-existing-story", counts);
    if (materiallyOverlapsStory(safe, existingStories))
      return reject("overlaps-existing-story", { ...counts, selected: safeImages });
    return {
      id: randomUUID(), title: idea.title, query: idea.query, mood: idea.mood,
      defaultDuration: getDefaultMemoryDuration(Math.min(MEMORY_DEFAULT_SELECTION_COUNT, safe.length)),
      description: idea.description,
      ...(idea.key ? { storyKey: idea.key } : {}),
      media: safe, createdAt: Date.now(),
    };
  }

  private async generateOnce(replace: boolean, customTopic?: string): Promise<MemoryState> {
    await this.initialize();
    const startedAt = Date.now();
    this.runRejections = new Map();
    this.state.generating = true;
    this.state.generationProgress = { phase: "scanning", label: customTopic ? `Searching for “${customTopic}”...` : "Looking for memories...", progress: 0 };
    this.state.message = customTopic ? `Looking for “${customTopic}” in your library…` : "Looking for memories…";
    try {
      // Existing cards stay in place until replacements actually exist.
      const current = await this.visibleSuggestions();
      const reserve = await this.visibleReserve();
      const want = customTopic
        ? 1
        : replace
          ? NEW_PER_RUN + Math.max(0, RESERVE_CARDS - reserve.length)
          : Math.max(0, NEW_PER_RUN + RESERVE_CARDS - current.length - reserve.length);
      // Placeholders the page shows: one for a topic, a full set for Generate, open slots for top-ups.
      this.generationExpected = customTopic ? 1 : replace ? NEW_PER_RUN : Math.max(0, Math.min(want, NEW_PER_RUN - current.length));
      this.emitGenerationProgress();
      this.trace("memory-generate-start", { replace, customTopic: Boolean(customTopic), want,
        current: current.length, reserve: reserve.length, savedCards: this.state.suggestions.length, savedReserve: this.reserve.length });
      const signatures = new Set([...current, ...reserve].map(card => signature(card.media)));
      const existingStories = [...current, ...reserve].map(card => card.media);
      const usedKeys = new Set([...this.recentKeys,
        ...[...current, ...reserve].map(card => card.storyKey).filter((key): key is string => Boolean(key))]);
      const usedPaths = new Set(current.flatMap(card => card.media.map(item => item.path)));
      const produced: MemorySuggestion[] = [];
      // Thin stories (under 15 shots) are kept only as a last resort.
      const thin: MemorySuggestion[] = [];
      const take = (card: MemorySuggestion | null, allowThin = false) => {
        if (!card) return;
        if (!allowThin && card.media.length < MEMORY_MIN_SELECTION_COUNT) {
          thin.push(card);
          // Reserve its shots so later stories stay distinct if this one is used as a fallback.
          if (!customTopic) card.media.forEach(item => usedPaths.add(item.path));
          this.trace("memory-story-thin", { story: card.storyKey?.split(":")[0] ?? "theme", items: card.media.length });
          return;
        }
        const cardSignature = signature(card.media);
        if (signatures.has(cardSignature) || materiallyOverlapsStory(card.media, existingStories)) {
          this.trace("memory-story-rejected", { story: card.storyKey?.split(":")[0] ?? "theme", reason: "overlaps-existing-story" });
          return;
        }
        signatures.add(cardSignature);
        existingStories.push(card.media);
        produced.push(card);
        card.media.forEach(item => usedPaths.add(item.path));
        if (card.storyKey) {
          this.recentKeys = [...this.recentKeys.filter(key => key !== card.storyKey), card.storyKey].slice(-MAX_RECENT_KEYS);
        }
      };
      let searchFailed = false;
      const totalSteps = customTopic
        ? Math.max(2, customTopicQueries(customTopic).length + 1)
        : Math.max(2, Math.min(MAX_IDEA_ATTEMPTS, want ? 8 : 1) + 5);
      let completedSteps = 0;
      const advance = (phase: MemoryGenerationProgress["phase"], label: string, amount = 1) => {
        completedSteps += amount;
        this.updateGenerationProgress(phase, completedSteps, totalSteps, label, startedAt);
      };
      if (customTopic) {
        const queryVariants = customTopicQueries(customTopic);
        const tokenQueries = customTopic
          .split(/\s+/)
          .map((word) => normalizeCustomTopic(word))
          .filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLowerCase()));
        const broadQueries = Array.from(new Set([
          ...queryVariants,
          ...tokenQueries,
          ...tokenQueries.slice(0, 4).join(" ") ? [tokenQueries.slice(0, 4).join(" ")] : [],
          ...tokenQueries.map((word) => `photo of ${word}`),
          ...tokenQueries.map((word) => `${word} photos`),
        ].filter((query) => query.length >= 3 && query.length <= 160))).slice(0, 12);
        let searchErrors = 0;
        const mergedHits: (MemoryMedia & { score?: number })[] = [];
        const mergeSeen = new Set<string>();
        for (let index = 0; index < broadQueries.length; index++) {
          const query = broadQueries[index];
          try {
            const topicTitle = customTopicTitle(customTopic);
            advance("scanning", `Searching “${topicTitle}” (${index + 1}/${broadQueries.length})`, 1);
            const hits = await (this.deps.searchPrompted?.(query) ?? this.deps.search(query));
            if (!Array.isArray(hits)) {
              this.trace("memory-custom-query", { index, of: broadQueries.length, words: query.split(/\s+/).length, hits: -1 });
              continue;
            }
            const mergedBefore = mergedHits.length;
            for (const candidate of hits) {
              const media = mediaValue(candidate);
              if (!media || mergeSeen.has(media.path)) continue;
              mergeSeen.add(media.path);
              const score = (candidate as MemoryMedia & { score?: number }).score;
              mergedHits.push(typeof score === "number" && Number.isFinite(score) ? { ...media, score } : media);
            }
            this.trace("memory-custom-query", { index, of: broadQueries.length, words: query.split(/\s+/).length,
              hits: hits.length, added: mergedHits.length - mergedBefore, merged: mergedHits.length });
            const card = await this.buildCard({
              key: `custom:${createHash("sha1").update(customTopic.toLocaleLowerCase()).digest("hex").slice(0, 16)}`,
              title: topicTitle,
              description: `A story shaped by “${customTopic}” from your library.`,
              query: customTopic,
              mood: customTopicMood(customTopic),
            }, mergedHits, signatures, usedPaths, existingStories);
            if (card && card.media.length >= MEMORY_MIN_SELECTION_COUNT) {
              take(card);
              advance("matching", `Found a memory for “${topicTitle}”`, 1);
              break;
            }
            // Keep merging queries; the latest merged card is the fullest fallback.
            if (card) { thin.length = 0; thin.push(card); }
          } catch (error) {
            searchErrors += 1;
            this.deps.onSearchError?.("custom-topic", error);
            continue;
          }
        }
        // Only report search as unavailable when every query actually failed.
        if (!produced.length && searchErrors > 0 && searchErrors === broadQueries.length) searchFailed = true;
      } else if (want > 0 && this.deps.discover) {
        let ideas: MemoryStoryCandidate[] = [];
        try { ideas = await this.deps.discover(); } catch (error) { searchFailed = true; this.deps.onSearchError?.("discover", error); }
        if (!Array.isArray(ideas)) ideas = [];
        const valid = ideas.filter(idea => idea && text(idea.key, 1000) && text(idea.title, 200)
          && text(idea.description, 1000) && text(idea.query, 1000)
          && Object.prototype.hasOwnProperty.call(MOOD_WORDS, idea.mood) && typeof idea.load === "function");
        const ordered = [...valid.filter(idea => !usedKeys.has(idea.key)), ...valid.filter(idea => usedKeys.has(idea.key))];
        this.trace("memory-ideas", { ideas: ideas.length, valid: valid.length, alreadyUsed: valid.length - valid.filter(idea => !usedKeys.has(idea.key)).length });
        const ideaSteps = Math.min(ordered.length, MAX_IDEA_ATTEMPTS);
        for (let attempt = 0; attempt < ideaSteps && produced.length < want; attempt++) {
          const idea = ordered[attempt];
          advance("matching", `Reviewing story ideas (${attempt + 1}/${ideaSteps})`, 1);
          let hits: unknown;
          try { hits = await idea.load(); } catch (error) {
            this.runRejections.set("idea-load-failed", (this.runRejections.get("idea-load-failed") ?? 0) + 1);
            this.deps.onSearchError?.("idea", error);
            continue;
          }
          const card = await this.buildCard(idea, hits, signatures, usedPaths, existingStories);
          take(card);
        }
      }
      // Fixed-theme semantic search covers libraries the miners know little about.
      for (let attempt = 0; !customTopic && attempt < 5 && produced.length < want; attempt++) {
        const theme = THEMES[this.cursor];
        this.cursor = (this.cursor + 1) % THEMES.length;
        advance("assembling", `Finding ${theme.title.toLowerCase()} moments (${attempt + 1}/5)`, 1);
        let hits: MemoryMedia[];
        try { hits = await this.deps.search(theme.query); } catch (error) { searchFailed = true; this.deps.onSearchError?.("theme", error); continue; }
        take(await this.buildCard({ ...theme, key: `theme:${theme.title}`,
          description: `A ${theme.mood} story inspired by ${theme.title.toLowerCase()}.` }, hits, signatures, usedPaths, existingStories));
      }

      if (produced.length < want && thin.length) {
        const fallback = thin.sort((a, b) => b.media.length - a.media.length).slice(0, want - produced.length);
        this.trace("memory-thin-fallback", { used: fallback.length, items: fallback.map(card => card.media.length) });
        fallback.forEach(card => take(card, true));
      }

      let visible: MemorySuggestion[];
      let nextReserve: MemorySuggestion[];
      let promoted = 0;
      if (produced.length && customTopic) {
        // A requested topic joins the editable set without retiring anything.
        visible = [produced[0], ...current].slice(0, MAX_CARDS);
        const placed = new Set(visible.map(card => card.id));
        nextReserve = [...produced, ...reserve].filter(card => !placed.has(card.id)).slice(0, RESERVE_CARDS);
      } else if (produced.length && !replace) {
        // Automatic runs only top up the editable set; they never retire the user's cards.
        visible = [...current, ...produced].slice(0, Math.max(current.length, NEW_PER_RUN));
        const placed = new Set(visible.map(card => card.id));
        nextReserve = [...produced, ...reserve].filter(card => !placed.has(card.id)).slice(0, RESERVE_CARDS);
      } else if (produced.length || (replace && reserve.length)) {
        // Generate retires the editable set: finished movies move to the Memory Book
        // (the movie folder); unfinished stories wait in reserve so nothing is lost.
        const unfinished = await this.unfinished(current);
        let fresh: MemorySuggestion[];
        if (produced.length) {
          fresh = produced.slice(0, NEW_PER_RUN);
        } else {
          // Sources offline or exhausted: surface saved stories instead of an empty page.
          fresh = reserve.slice(0, OFFLINE_PROMOTIONS);
          promoted = fresh.length;
        }
        visible = fresh;
        const placed = new Set(visible.map(card => card.id));
        nextReserve = [...unfinished, ...produced, ...reserve].filter(card => !placed.has(card.id)).slice(0, RESERVE_CARDS);
      } else {
        visible = current;
        nextReserve = reserve;
      }
      this.state.suggestions = visible;
      this.reserve = nextReserve;
      advance("finishing", customTopic ? "Preparing your memory..." : "Finalizing the collection...", 1);
      await this.assignSoundtracks([...visible, ...nextReserve]);
      this.state.suggestions = await this.visibleSuggestions();
      this.reserve = await this.visibleReserve();
      await this.persist();
      const count = this.state.suggestions.length;
      this.trace("memory-generate-result", { produced: produced.length, visible: count, reserve: this.reserve.length,
        promoted, searchFailed, thin: thin.length, elapsedMs: Date.now() - startedAt,
        rejections: Array.from(this.runRejections).map(([reason, n]) => `${reason}:${n}`).join(",") });
      this.state.message = customTopic
        ? produced.length
          ? `Created a memory for “${customTopicTitle(customTopic)}”.`
          : searchFailed
            ? `Local search could not complete for “${customTopicTitle(customTopic)}”. Try again when indexing is ready.`
            : `Not enough distinct, strong photos matched “${customTopicTitle(customTopic)}”. Try another phrase or index more photos.`
        : produced.length
          ? `${Math.min(produced.length, NEW_PER_RUN)} new memor${Math.min(produced.length, NEW_PER_RUN) === 1 ? "y" : "ies"} ready to edit; finished ones moved to your Memory Book.`
          : promoted
            ? `Showing ${promoted} saved memor${promoted === 1 ? "y" : "ies"}; connect more sources for fresh ones.`
            : count
              ? ""
              : searchFailed
                ? "Search is not ready or unavailable. Try again when indexing is ready."
                : "No matching memories yet. Each story needs at least four distinct, allowed photos.";
    } finally {
      this.state.generating = false;
      this.state.generationProgress = undefined;
      this.generationExpected = 0;
      this.emitGenerationProgress();
    }
    return this.getState();
  }

  /** Gives each story without a song its own track, distinct from the other stories' songs and artists. */
  private async assignSoundtracks(cards: MemorySuggestion[]): Promise<void> {
    if (!cards.some(card => !card.soundtrackId)) return;
    const pool = await this.musicPool();
    if (!pool.length) return;
    const usedTracks = new Set(cards.map(card => card.soundtrackId).filter((id): id is string => Boolean(id)));
    const usedArtists = new Set<string>();
    for (const id of usedTracks) {
      const file = this.audioIndex?.ids.get(id);
      if (file) usedArtists.add(artistOf(file.path));
    }
    for (const card of cards) {
      if (card.soundtrackId) continue;
      const picked = await this.pickSoundtrack(card, pool, usedTracks, usedArtists);
      if (picked) card.soundtrackId = picked;
    }
  }

  async dismiss(id: string): Promise<MemoryState> {
    await this.initialize();
    if (text(id, 200)) {
      this.dismissed.add(id);
      if (this.dismissed.size > 512) this.dismissed.delete(this.dismissed.values().next().value as string);
      this.state.suggestions = this.state.suggestions.filter(card => card.id !== id);
      this.reserve = this.reserve.filter(card => card.id !== id);
      // A saved extra takes the dismissed card's place.
      const reserve = await this.visibleReserve();
      if (reserve.length && this.state.suggestions.length < NEW_PER_RUN) {
        this.state.suggestions.push(reserve[0]);
        this.reserve = this.reserve.filter(card => card.id !== reserve[0].id);
      }
      await this.persist();
    }
    return this.getState();
  }

  async rename(id: string, title: string): Promise<MemoryState> {
    await this.initialize();
    const normalized = title.trim().replace(/\s+/g, " ");
    if (!text(id, 200) || !normalized || normalized.length > 80 || normalized.includes("\0"))
      throw new Error("Enter a memory title between 1 and 80 characters.");
    const card = [...this.state.suggestions, ...this.reserve].find((item) => item.id === id);
    if (!card) throw new Error("That memory is no longer available.");
    card.title = normalized;
    await this.persist();
    return this.getState();
  }

  private applySettings(settings: Partial<MemorySettings> | undefined): void {
    if (!settings || typeof settings !== "object") return;
    for (const key of ["showOnLaunch"] as const) {
      if (typeof settings[key] === "boolean") this.state.settings[key] = settings[key]!;
    }
    const directory = settings.movieDirectory;
    if (directory === null) this.state.settings.movieDirectory = null;
    else if (text(directory) && path.isAbsolute(directory)) this.state.settings.movieDirectory = directory;
  }

  async updateSettings(settings: Partial<MemorySettings>): Promise<MemoryState> {
    await this.initialize();
    this.applySettings(settings);
    await this.persist();
    return this.getState();
  }

  async getSuggestion(id: string): Promise<MemorySuggestion | undefined> {
    return (await this.getState()).suggestions.find(card => card.id === id)
      ?? (await this.getReserve()).find(card => card.id === id);
  }

  async getSettings(): Promise<MemorySettings> {
    await this.initialize();
    return { ...this.state.settings };
  }

  async markDownloaded(id: string): Promise<MemoryState> {
    await this.initialize();
    const card = this.state.suggestions.find(item => item.id === id);
    if (card) {
      card.downloadedAt = Date.now();
      await this.persist();
    }
    return this.getState();
  }

  private original(card: MemorySuggestion): MemorySoundtrack {
    return { id: `original:${card.id}`, name: "Original audio", source: "original",
      rights: "Sound from your own clips. For personal viewing only." };
  }

  /** Music pool for one generation, so each story is scored against the same snapshot. */
  private async musicPool(): Promise<{ file: MemoryAudioFile; haystack: string; artist: string }[]> {
    let files: MemoryAudioFile[];
    try { files = await this.deps.listAudio(); } catch { return []; }
    if (!Array.isArray(files)) return [];
    return files.filter(file => file && text(file.path) && text(file.name) && isMusicTrack(file))
      .map(file => ({ file, haystack: `${file.name} ${file.path}`.toLowerCase(), artist: artistOf(file.path) }));
  }

  /**
   * Picks a song whose artist/album/title echoes the story (place, subject, folder names)
   * or its mood, with variety: never a song or artist another current story already uses.
   */
  private async pickSoundtrack(
    card: MemorySuggestion,
    pool: { file: MemoryAudioFile; haystack: string; artist: string }[],
    usedTracks: Set<string>,
    usedArtists: Set<string>,
  ): Promise<string | undefined> {
    if (!pool.length) return undefined;
    const words = storyWords(card);
    const moods = MOOD_WORDS[card.mood];
    const ranked: { file: MemoryAudioFile; artist: string; score: number }[] = [];
    for (const entry of pool) {
      let score = Math.random() * 2;
      for (const word of words) if (entry.haystack.includes(word)) score += 3;
      for (const word of moods) if (entry.haystack.includes(word)) score += 1;
      if (usedArtists.has(entry.artist)) score -= 4;
      if (ranked.length < 24 || score > ranked[ranked.length - 1].score) {
        ranked.push({ file: entry.file, artist: entry.artist, score });
        ranked.sort((a, b) => b.score - a.score);
        if (ranked.length > 24) ranked.pop();
      }
    }
    for (const { file, artist } of ranked) {
      const id = audioId(file.path);
      if (usedTracks.has(id) || !await this.allowed(file.path)) continue;
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
  async browseAudio(request: MemoryAudioBrowseRequest = {}): Promise<MemoryAudioBrowseResult> {
    let files: MemoryAudioFile[];
    try { files = await this.deps.listAudio(); } catch { files = []; }
    if (!Array.isArray(files)) files = [];
    const sourceOf = (file: MemoryAudioFile) => file.sourceId || file.sourceLabel || path.dirname(file.path);
    const relativeOf = (file: MemoryAudioFile) =>
      (file.relativePath || file.name).split(/[\\/]+/).filter(Boolean).join("/");
    const sources = new Map<string, { id: string; label: string; count: number }>();
    for (const file of files) {
      if (!file || !text(file.path) || !text(file.name)) continue;
      const id = sourceOf(file);
      const entry = sources.get(id) ?? { id, label: file.sourceLabel || path.basename(id) || id, count: 0 };
      entry.count += 1;
      sources.set(id, entry);
    }
    const folder = (request.folder ?? "").split(/[\\/]+/).filter(Boolean).join("/");
    const query = (request.query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const inScope = (file: MemoryAudioFile) => {
      if (request.sourceId && sourceOf(file) !== request.sourceId) return false;
      return !folder || relativeOf(file).startsWith(`${folder}/`);
    };
    const folders = new Map<string, number>();
    const matched: MemoryAudioFile[] = [];
    if (query.length || request.sourceId) {
      for (const file of files) {
        if (!file || !text(file.path) || !text(file.name) || !inScope(file)) continue;
        if (query.length) {
          const haystack = `${file.name} ${relativeOf(file)} ${file.sourceLabel ?? ""}`.toLowerCase();
          if (query.every((word) => haystack.includes(word))) matched.push(file);
          continue;
        }
        // Browsing: direct children are files; deeper paths roll up into their first folder.
        const rest = folder ? relativeOf(file).slice(folder.length + 1) : relativeOf(file);
        const slash = rest.indexOf("/");
        if (slash < 0) matched.push(file);
        else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
      }
    }
    const sort = request.sort ?? "name";
    const direction = request.direction === "desc" ? -1 : 1;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    matched.sort((a, b) => direction * (sort === "modified" ? (a.modified ?? 0) - (b.modified ?? 0)
      : sort === "size" ? (a.size ?? 0) - (b.size ?? 0) : collator.compare(a.name, b.name)));
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.floor(request.limit ?? 200)));
    const page: MemoryAudioBrowseFile[] = [];
    for (const file of matched.slice(offset, offset + limit)) {
      if (!await this.allowed(file.path)) continue;
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
  async setSoundtrack(id: string, soundtrackId: string): Promise<MemorySuggestion | undefined> {
    await this.initialize();
    if (!/^library:[a-f0-9]{64}$/.test(soundtrackId)) return undefined;
    const card = this.state.suggestions.find((item) => item.id === id) ?? this.reserve.find((item) => item.id === id);
    if (!card || !await this.resolveSoundtrack(soundtrackId, id)) return undefined;
    card.soundtrackId = soundtrackId;
    await this.persist();
    return { ...card };
  }

  async getSoundtracks(id: string): Promise<MemorySoundtrack[]> {
    const card = await this.getSuggestion(id);
    if (!card) return [];
    const result = [this.original(card)];
    const pool = await this.musicPool();
    const keywords = new Set([...MOOD_WORDS[card.mood], ...storyWords(card),
      ...card.query.toLowerCase().split(/\W+/).filter(word => word.length > 2)]);
    const top: { file: MemoryAudioFile; score: number }[] = [];
    // Score the cached index without per-file safety checks; only the shortlist is verified.
    for (const { file, haystack } of pool) {
      let score = 0;
      for (const word of keywords) if (haystack.includes(word)) score++;
      if (top.length >= 24 && score <= top[top.length - 1].score) continue;
      top.push({ file, score });
      top.sort((a, b) => b.score - a.score);
      if (top.length > 24) top.pop();
    }
    const picked = card.soundtrackId ? await this.resolveSoundtrack(card.soundtrackId, card.id) : undefined;
    if (picked) result.push(picked);
    for (const { file } of top) {
      if (result.length >= 13) break;
      const trackId = audioId(file.path);
      if (trackId === picked?.id || !await this.allowed(file.path)) continue;
      result.push({ id: trackId, name: file.name, path: file.path, source: "library",
        rights: `${RIGHTS}${text(file.sourceLabel, 200) ? ` Source: ${file.sourceLabel}.` : ""}` });
    }
    return result;
  }

  /** Resolve only IDs minted from the current audio index, never accept an arbitrary path.
   * This validates availability/safety, NOT licensing. Export must separately obtain rights approval.
   */
  async resolveSoundtrack(soundtrackId: string, suggestionId?: string): Promise<MemorySoundtrack | undefined> {
    await this.initialize();
    if (!text(soundtrackId, 250)) return undefined;
    if (soundtrackId.startsWith("original:")) {
      const id = soundtrackId.slice("original:".length);
      if (suggestionId !== undefined && id !== suggestionId) return undefined;
      const card = await this.getSuggestion(id);
      return card ? this.original(card) : undefined;
    }
    if (!/^library:[a-f0-9]{64}$/.test(soundtrackId)) return undefined;
    if (suggestionId !== undefined && !await this.getSuggestion(suggestionId)) return undefined;
    let files: MemoryAudioFile[];
    try { files = await this.deps.listAudio(); } catch { return undefined; }
    if (!Array.isArray(files)) return undefined;
    // Hashing every path per lookup is slow for large libraries; index once per audio snapshot.
    if (this.audioIndex?.files !== files) {
      const ids = new Map<string, MemoryAudioFile>();
      for (const file of files) if (file && text(file.path) && text(file.name)) ids.set(audioId(file.path), file);
      this.audioIndex = { files, ids };
    }
    const file = this.audioIndex.ids.get(soundtrackId);
    if (!file || !await this.allowed(file.path)) return undefined;
    return { id: soundtrackId, name: file.name, path: file.path, source: "library", rights: RIGHTS };
  }
}
