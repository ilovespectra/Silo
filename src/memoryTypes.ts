export type MemoryMood = "gentle" | "bright" | "energetic" | "dramatic";
export interface MemoryMedia {
  path: string;
  name: string;
  type: "image" | "video";
  modified: number;
  thumbnailUrl?: string | null;
  liveVideoPath?: string;
  /** Set only for a user-prompted Memory that explicitly names this live virtual folder. */
  promptedMemoryFolderId?: string;
  /** A saved people, place, keyword, alias, or folder tag matched by this prompt. */
  userNamed?: boolean;
  /** Transient entity identifiers used to preserve mixed-tag coverage during selection. */
  memoryGroups?: string[];
}
export interface MemorySuggestion {
  id: string;
  title: string;
  description: string;
  query: string;
  mood: MemoryMood;
  /** Memories are always rendered as one-minute movies. */
  defaultDuration?: number;
  /** Discovery key (e.g. "place:croatia"), used to rotate story ideas. */
  storyKey?: string;
  /** Library song picked for this story; previews and exports default to it. */
  soundtrackId?: string;
  media: MemoryMedia[];
  createdAt: number;
  downloadedAt?: number;
}
export interface MemorySoundtrack {
  id: string;
  name: string;
  path?: string;
  source: "original" | "library";
  rights: string;
}
export interface MemorySettings {
  showOnLaunch: boolean;
  /** Folder for saved memory movies; null keeps them in Silo's app storage. */
  movieDirectory?: string | null;
}
export interface MemoryGenerationProgress {
  phase: "scanning" | "matching" | "assembling" | "finishing";
  label: string;
  progress: number;
  etaSeconds?: number;
}
export interface MemoryMusicAvailability {
  available: boolean;
  scanning: boolean;
  sourceCount: number;
  indexedTrackCount: number;
  cacheAvailable: boolean;
}
export interface MemoryGenerationStatus {
  generating: boolean;
  /** How many stories this run is trying to create. */
  expected: number;
  progress?: MemoryGenerationProgress;
}
export interface MemoryState {
  suggestions: MemorySuggestion[];
  settings: MemorySettings;
  generating: boolean;
  message: string;
  /** Saved stories waiting in reserve; playable even when their source is offline. */
  reserveCount?: number;
  /** Progress for a generation pass in flight. */
  generationProgress?: MemoryGenerationProgress;
  /** Background movie status per suggestion id. */
  previews?: Record<string, MemoryPreviewStatus>;
}
export interface MemoryPreviewStatus {
  status: "queued" | "rendering" | "ready" | "failed";
  /** 0..1 while rendering. */
  progress?: number;
  etaSeconds?: number;
}
export type MemoryAudioSort = "name" | "modified" | "size";
export interface MemoryAudioBrowseRequest {
  /** Omit to list sources (or search every source). */
  sourceId?: string;
  /** Folder relative to the source root; "" is the root. */
  folder?: string;
  query?: string;
  sort?: MemoryAudioSort;
  direction?: "asc" | "desc";
  offset?: number;
  limit?: number;
}
export interface MemoryAudioBrowseFile {
  /** Soundtrack id usable for export and as a memory's song. */
  id: string;
  name: string;
  path: string;
  sourceId: string;
  sourceLabel: string;
  folder: string;
  size: number;
  modified: number;
}
export interface MemoryAudioBrowseResult {
  sources: { id: string; label: string; count: number }[];
  folders: { name: string; path: string; count: number }[];
  files: MemoryAudioBrowseFile[];
  /** Matching files before paging. */
  total: number;
}
export interface MemoryExportOptions {
  suggestionId: string;
  count: number;
  duration: number;
  soundtrackId: string;
  originalAudio: number;
  /** True only when the user explicitly acknowledged rights for a library track. */
  rightsAcknowledged?: boolean;
}
export const MEMORY_DURATION_SECONDS = 60;
export const MEMORY_EXPORT_LIMITS = { minCount: 14, maxCount: 24, minDuration: MEMORY_DURATION_SECONDS, maxDuration: MEMORY_DURATION_SECONDS } as const;
export const MEMORY_DEFAULT_SELECTION_COUNT = 20;
/** Every generated memory and rendered movie must contain at least this many distinct media items. */
export const MEMORY_MIN_SELECTION_COUNT = 14;

/** Selection floor for the movie's total media item count, including photos and clips. */
export function getMemorySelectionMinimum(available: number): number {
  const maximum = Math.min(MEMORY_EXPORT_LIMITS.maxCount, Math.max(0, Math.floor(available)));
  return Math.min(MEMORY_MIN_SELECTION_COUNT, maximum);
}

/** Prefer images, then fill the requested total with distinct video clips as needed. */
export function selectMemoryExportMedia(media: MemoryMedia[], count: number): MemoryMedia[] {
  const target = Math.min(MEMORY_EXPORT_LIMITS.maxCount, Math.floor(count), media.length);
  if (target < MEMORY_MIN_SELECTION_COUNT) return [];
  const images = media.filter((item) => item.type === "image");
  const selected: MemoryMedia[] = [];
  const selectedPaths = new Set(selected.map((item) => item.path));
  const add = (item: MemoryMedia) => {
    if (selected.length >= target || selectedPaths.has(item.path)) return;
    selected.push(item);
    selectedPaths.add(item.path);
  };
  for (const item of images) add(item);
  for (const item of media) add(item);
  if (selected.length < target) return [];
  return selected.sort((first, second) =>
    first.modified - second.modified || first.path.localeCompare(second.path));
}
export const MEMORY_MAGIC_SCORE_THRESHOLD = 90;

export function selectMemoryPhotoCandidates<T extends { score: number; magicScore?: number }>(candidates: T[]): T[] {
  const ranked = candidates.slice().sort((first, second) => {
    const firstMagic = typeof first.magicScore === "number" && Number.isFinite(first.magicScore) ? first.magicScore : -1;
    const secondMagic = typeof second.magicScore === "number" && Number.isFinite(second.magicScore) ? second.magicScore : -1;
    return secondMagic - firstMagic || second.score - first.score;
  });
  const preferred = ranked.filter((candidate) => candidate.magicScore !== undefined &&
    Number.isFinite(candidate.magicScore) && candidate.magicScore >= MEMORY_MAGIC_SCORE_THRESHOLD);
  const fallback = ranked.filter((candidate) => !preferred.includes(candidate));
  const target = Math.min(MEMORY_EXPORT_LIMITS.maxCount, Math.max(MEMORY_DEFAULT_SELECTION_COUNT, preferred.length));
  const ordered = [...preferred, ...fallback];
  const groupFrequency = new Map<string, number>();
  for (const candidate of ordered) {
    const groups = (candidate as T & { memoryGroups?: unknown }).memoryGroups;
    if (!Array.isArray(groups)) continue;
    for (const group of groups)
      if (typeof group === "string") groupFrequency.set(group, (groupFrequency.get(group) ?? 0) + 1);
  }
  const selected: T[] = [];
  const selectedPaths = new Set<string>();
  const groupsByPath = new Map<string, Set<string>>();
  for (const candidate of ordered) {
    const groups = (candidate as T & { path?: unknown; memoryGroups?: unknown }).memoryGroups;
    const filePath = (candidate as T & { path?: unknown }).path;
    if (typeof filePath === "string" && Array.isArray(groups))
      groupsByPath.set(filePath, new Set(groups.filter((group): group is string => typeof group === "string")));
  }
  const groupKeys = Array.from(groupFrequency.keys()).sort((first, second) =>
    groupFrequency.get(first)! - groupFrequency.get(second)! || first.localeCompare(second));
  const coveredGroups = new Set<string>();
  for (const group of groupKeys) {
    if (coveredGroups.has(group) || selected.length >= target) continue;
    const candidate = ordered.find((item) => {
      const filePath = (item as T & { path?: unknown }).path;
      return typeof filePath === "string" && !selectedPaths.has(filePath) &&
        (groupsByPath.get(filePath)?.has(group) ?? false);
    });
    if (!candidate) continue;
    selected.push(candidate);
    const filePath = (candidate as T & { path?: unknown }).path;
    if (typeof filePath === "string") selectedPaths.add(filePath);
    for (const member of groupsByPath.get(String(filePath)) ?? []) coveredGroups.add(member);
  }
  for (const candidate of ordered) {
    const filePath = (candidate as T & { path?: unknown }).path;
    if (typeof filePath === "string" && selectedPaths.has(filePath)) continue;
    selected.push(candidate);
    if (typeof filePath === "string") selectedPaths.add(filePath);
    if (selected.length >= target) break;
  }
  return selected.slice(0, target);
}

export function getMemoryDurationBounds(_count: number): { min: number; max: number } {
  return { min: MEMORY_DURATION_SECONDS, max: MEMORY_DURATION_SECONDS };
}

export function getDefaultMemoryDuration(_count: number): number {
  return MEMORY_DURATION_SECONDS;
}

export function isMemoryDurationAllowed(_count: number, duration: number): boolean {
  return Number.isFinite(duration) && duration === MEMORY_DURATION_SECONDS;
}
export interface MemoryExportProgress {
  phase: "preparing" | "rendering" | "mixing" | "complete" | "cancelled" | "error";
  suggestionId: string;
  completed: number;
  total: number;
  message: string;
}
/** A finished movie in the memories folder, kept even after its card is removed. */
export interface SavedMemoryMovie {
  path: string;
  title: string;
  modified: number;
  size: number;
  /** A story retired by Generate whose movie is still being prepared; `path` is empty until it is. */
  pending?: MemorySuggestion;
}

export interface MemoriesAPI {
  getMemories(prepareViews?: boolean): Promise<MemoryState>;
  getMemoryMusicAvailability(): Promise<MemoryMusicAvailability>;
  generateMemories(replace?: boolean, customTopic?: string): Promise<MemoryState>;
  dismissMemory(id: string): Promise<MemoryState>;
  renameMemory(id: string, title: string): Promise<MemoryState>;
  updateMemorySettings(settings: Partial<MemorySettings>): Promise<MemoryState>;
  selectMemoryDirectory(): Promise<MemoryState>;
  getMemorySoundtracks(id: string): Promise<MemorySoundtrack[]>;
  /** In-app audio explorer over the indexed audio library. */
  browseMemoryAudio?(request: MemoryAudioBrowseRequest): Promise<MemoryAudioBrowseResult>;
  /** Makes a library song this memory's soundtrack; its movie re-renders in the background. */
  setMemorySoundtrack?(id: string, soundtrackId: string): Promise<MemoryState>;
  viewMemory(id: string): Promise<{ ok: boolean; path?: string; error?: string; preparing?: boolean; upgradeRequired?: boolean }>;
  revealMemory(id: string): Promise<{ ok: boolean; path?: string; error?: string; preparing?: boolean; upgradeRequired?: boolean }>;
  exportMemory(options: MemoryExportOptions): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  cancelMemoryExport(): Promise<void>;
  onMemoryExportProgress(callback: (progress: MemoryExportProgress) => void): () => void;
  /** Optional so older bridges keep working; cards fall back to polling state. */
  onMemoryPreviewProgress?(callback: (previews: Record<string, MemoryPreviewStatus>) => void): () => void;
  onMemoriesChanged?(callback: (state: MemoryState) => void): () => void;
  /** Live generation status, so the page can show placeholders while stories are found. */
  onMemoryGenerationProgress?(callback: (status: MemoryGenerationStatus) => void): () => void;
  /** Movies in the memories folder that no longer have a card. */
  listSavedMemoryMovies?(): Promise<SavedMemoryMovie[]>;
  renameSavedMemoryMovie?(moviePath: string, title: string): Promise<{ ok: boolean; error?: string }>;
  revealSavedMemoryMovie?(moviePath: string): Promise<{ ok: boolean; error?: string }>;
}
