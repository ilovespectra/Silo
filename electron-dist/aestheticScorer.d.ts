export type MagicPresetId = "balanced" | "people" | "landscapes" | "variety";
export interface MagicItem {
    path: string;
    size: number;
    modified: number;
    name: string;
}
export interface MagicRankResult {
    order: string[];
    scores: Record<string, number>;
    analyzed: number;
    total: number;
    running: boolean;
}
export interface AestheticDeps {
    cachePath: string;
    thumbnailFile(filePath: string): Promise<string | null>;
    /** Throwaway preview for background work, so library-wide analysis doesn't fill the thumbnail cache. */
    temporaryPreview(filePath: string): Promise<{
        file: string;
        dispose(): Promise<void>;
    } | null>;
    faceBoxes(filePath: string): Array<{
        x: number;
        y: number;
        width: number;
        height: number;
        score: number;
    }>;
    imageVectors(paths: string[]): Promise<Map<string, Float32Array>>;
    embedPrompts(prompts: string[]): Promise<Float32Array[]>;
    onProgress(progress: {
        analyzed: number;
        total: number;
        running: boolean;
        libraryAnalyzed: number;
        libraryTotal: number;
    }): void;
}
/**
 * Local photo-quality ranking: CLIP prompt similarity plus classic photographic measurements
 * (exposure, contrast, sharpness, color, composition, faces). Nothing leaves the machine.
 */
export declare class AestheticScorer {
    private readonly deps;
    private readonly cache;
    private readonly vectors;
    private readonly rankCache;
    private loaded;
    private promptVectors;
    private queue;
    private backgroundQueue;
    private libraryTotal;
    private running;
    private generation;
    private requestTotal;
    private requestPaths;
    constructor(deps: AestheticDeps);
    /** Analyzes the whole library at low priority; whatever the user is viewing always goes first. */
    analyzeInBackground(items: MagicItem[]): Promise<void>;
    /** Ranks what is already analyzed and queues the rest; call again (e.g. on progress) for a fresher order. */
    rank(items: MagicItem[], presetId?: MagicPresetId): Promise<MagicRankResult>;
    /** Magic quality order with a hard pairwise CLIP-similarity ceiling. */
    rankDistinct(items: MagicItem[], presetId?: MagicPresetId, maximumSimilarity?: number): Promise<MagicRankResult>;
    /** Keep the first Magic-ranked image from each similarity cluster. */
    filterSimilar(paths: string[], maximumSimilarity?: number): Promise<string[]>;
    private computeRanking;
    private score;
    /** Demotes near-identical shots (bursts) so the top of the list covers distinct moments. */
    private diversify;
    private isFresh;
    private drain;
    private emitProgress;
    private analyze;
    private measure;
    private load;
}
