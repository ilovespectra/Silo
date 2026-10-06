export declare const CLONE_ARCHIVE_MANIFEST_NAME = "silo-clone-manifest.json";
export declare const CLONE_ARCHIVE_EXTENSION = ".zip";
export interface CloneArchiveFile {
    localPath: string;
    /** Path inside the archive, using either separator; stored with "/". */
    archivePath: string;
    size: number;
    modified: number;
    sha256: string;
    mode?: number;
}
export interface CloneArchiveDirectory {
    archivePath: string;
    modified?: number;
}
export interface CloneArchiveProgress {
    phase: "compressing" | "verifying" | "extracting";
    processedBytes: number;
    totalBytes: number;
    processedFiles: number;
    totalFiles: number;
    currentFile: string;
}
export interface WriteCloneArchiveOptions {
    archivePath: string;
    files: CloneArchiveFile[];
    directories?: CloneArchiveDirectory[];
    /** Built after every file was read and hash-checked; stored as the last entry. */
    buildManifest: () => Record<string, unknown>;
    isCancelled?: () => boolean;
    onProgress?: (progress: CloneArchiveProgress) => void;
    compressionLevel?: number;
}
export interface WriteCloneArchiveResult {
    archivePath: string;
    archiveBytes: number;
    storedFiles: number;
    verifiedFiles: number;
}
export interface ExtractCloneArchiveOptions {
    isCancelled?: () => boolean;
    onProgress?: (progress: CloneArchiveProgress) => void;
}
export interface ExtractCloneArchiveResult {
    destinationRoot: string;
    extractedFiles: number;
    restoredAliases: number;
    totalBytes: number;
}
export declare function toArchiveName(relativePath: string): string;
/** Resolves an archive entry name under root, rejecting traversal and absolute names. */
export declare function safeArchiveTarget(root: string, entryName: string): string;
/**
 * Re-reads every stored file from the finished archive and compares its SHA-256 with
 * the hash taken while compressing. Returns the number of verified files.
 */
export declare function verifyCloneArchive(archivePath: string, expected: Map<string, string>, options?: {
    isCancelled?: () => boolean;
    onProgress?: (progress: CloneArchiveProgress) => void;
    totalBytes?: number;
}): Promise<number>;
/**
 * Streams files into a zip64-capable archive one at a time (bounded memory and file
 * handles), hashes each source while reading, appends the manifest last, verifies the
 * whole archive by reading it back, and only then renames it into place.
 */
export declare function writeCloneArchive(options: WriteCloneArchiveOptions): Promise<WriteCloneArchiveResult>;
/** Reads only the manifest from a Silo clone archive. */
export declare function readCloneArchiveManifest(archivePath: string): Promise<Record<string, unknown>>;
/**
 * Extracts a verified Silo clone archive into a new folder below destinationParent.
 * Every file is SHA-256-checked against the archive manifest before it is renamed into
 * place, duplicate aliases are restored as hard links (or verified copies), and the
 * manifest is written last so a partial extraction is never mistaken for a clone.
 */
export declare function extractCloneArchive(archivePath: string, destinationParent: string, options?: ExtractCloneArchiveOptions): Promise<ExtractCloneArchiveResult>;
