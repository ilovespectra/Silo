/** Common audio codecs, containers, sample formats, and tracker/module formats. */
export declare const AUDIO_EXTENSIONS: Set<string>;
export declare function audioExtension(fileName: string): string;
export declare function isAudioFile(fileName: string, mimeType?: string | null): boolean;
