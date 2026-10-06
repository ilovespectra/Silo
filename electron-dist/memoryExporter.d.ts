import { MemoryExportOptions, MemoryExportProgress, MemorySuggestion, MemorySoundtrack } from "./memoryTypes";
export interface MemoryExporterDependencies {
    ffmpegPath: () => string;
    resolveLocalPath: (mediaPath: string) => Promise<string>;
    /** Return a converted temporary image, never modify the source. Main may wrap getConvertedImageBuffer. */
    prepareImage?: (localPath: string) => Promise<string>;
    /** Test-only/custom landscape output size; portrait dimensions are normalized. */
    dimensions?: {
        width: number;
        height: number;
    };
    /** Per-subprocess deadline; defaults to five minutes. */
    timeoutMs?: number;
}
export type MemoryExportSoundtrack = Pick<MemorySoundtrack, "path" | "name" | "source">;
export declare class MemoryExportCancelledError extends Error {
    constructor();
}
/** Sequential, bounded-memory movie export. Originals are read-only inputs. */
/**
 * Fits the complete photo inside the 16:9 canvas over a softly blurred fill.
 */
export declare function framedFilter(width: number, height: number): string;
export declare class MemoryExporter {
    private readonly deps;
    private controller?;
    private child?;
    constructor(deps: MemoryExporterDependencies);
    cancel(): void;
    private checkCancelled;
    private ffmpeg;
    render(suggestion: MemorySuggestion, options: MemoryExportOptions, soundtrack: MemoryExportSoundtrack, destination: string, progress?: (value: MemoryExportProgress) => void): Promise<void>;
}
