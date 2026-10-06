import { MemoryMood, MemorySoundtrack } from "./memoryTypes";
/** Locally synthesized original scores, not recordings or third-party public-domain music. */
export declare const ORIGINAL_MEMORY_SOUNDTRACKS: MemorySoundtrack[];
/** Writes deterministic PCM in bounded chunks. The caller owns this temporary file. */
export declare function createOriginalSoundtrack(destination: string, duration: number, mood: MemoryMood, signal?: AbortSignal): Promise<void>;
