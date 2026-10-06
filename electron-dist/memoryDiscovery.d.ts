import type { MemoryMood } from "./memoryTypes";
/** Pure story mining: no Electron, no file I/O. Main supplies index snapshots. */
export interface DiscoveryImage {
    path: string;
    modified: number;
    /** EXIF capture time when known; preferred over the file time for date stories. */
    captured?: number;
}
export interface DiscoveryPlace {
    path: string;
    city: string | null;
    region: string | null;
    country: string | null;
}
export interface DiscoveryGroup {
    name: string;
    paths: string[];
}
export interface MemoryConcept {
    id: string;
    /** Short noun used in combined titles ("Croatian Seaside"). */
    label: string;
    title: string;
    prompt: string;
    mood: MemoryMood;
    /** Scenery concepts combine with places; activities combine with years. */
    scenery?: boolean;
}
export interface DiscoveredConcept {
    id: string;
    /** Best matches first. */
    paths: string[];
    count: number;
}
/** Per-topic signals from the local topic profile (see memoryTopicProfile.ts). */
export interface TopicSignal {
    id: string;
    /** Long-term interest relative to the strongest topic, 0..1. */
    interest: number;
    /** Recent share divided by long-term share; 1 = nothing new. */
    lift: number;
    recentCount: number;
    /** Recently captured matches, newest first. */
    recentPaths: string[];
}
export interface DiscoveryInput {
    images: DiscoveryImage[];
    places?: DiscoveryPlace[];
    people?: DiscoveryGroup[];
    pets?: DiscoveryGroup[];
    concepts?: DiscoveredConcept[];
    topics?: TopicSignal[];
    now?: number;
    random?: () => number;
}
export type StoryKind = "on-this-day" | "season" | "year" | "event" | "place" | "person" | "pet" | "concept" | "recent" | "folder";
export interface StoryIdea {
    key: string;
    kind: StoryKind;
    title: string;
    description: string;
    query: string;
    mood: MemoryMood;
    /** Ordered best-first; at most MAX_STORY_PATHS, spread across the story's time range. */
    paths: string[];
    /** How central this subject is to the library; drives ordering. */
    weight: number;
}
export declare const MIN_STORY_PHOTOS = 4;
/** Recent photos needed before a topic counts as emerging; one or two files never do. */
export declare const MIN_EMERGING_PHOTOS = 6;
export declare const MEMORY_CONCEPTS: readonly MemoryConcept[];
/** Never story material; images closest to these are dropped. */
export declare const MEMORY_JUNK_PROMPTS: readonly string[];
export declare const MEMORY_PHOTO_PROMPTS: readonly string[];
/**
 * Cheap path/size test for "a photo from the user's life": camera formats, real file
 * sizes, outside app bundles, artwork/icon folders, and folders that hold music (album art).
 */
export declare function isPersonalPhotoPath(filePath: string, size: number | undefined, musicDirectories?: ReadonlySet<string>): boolean;
/** Folder names people chose themselves ("Croatia 2019", "Sailing with Dad"). */
export declare function meaningfulFolderName(folder: string): string | null;
export declare function discoverMemoryStories(input: DiscoveryInput): StoryIdea[];
