/** Phone-generated thumbnails and caches: never indexed, browsed for memories, or backed up. */
export declare function isPhoneDerivativePath(candidatePath: string): boolean;
/** True for paths inside software trees that are never indexed or scanned for search. */
export declare function isNonLibraryPath(candidatePath: string): boolean;
/** True when candidate is root itself or is below it at a path boundary. */
export declare function isPathWithin(candidatePath: string, rootPath: string): boolean;
/** Map a path discovered below a possibly aliased source root to its real-root spelling. */
export declare function canonicalPathFromSource(sourcePath: string, canonicalSourcePath: string, candidatePath: string): string;
/**
 * Identify Silo-owned app data both lexically and through a source-root alias.
 * This protects every current/future generated index below userData without
 * hiding phone contents exposed through the virtual /__phone__ and
 * /__phone_backup__ roots.
 */
export declare function isAppDataPath(candidatePath: string, sourcePath: string, canonicalSourcePath: string, appDataPath: string, canonicalAppDataPath: string): boolean;
export declare function isSiloCloneDirectory(directoryPath: string): Promise<boolean>;
export declare function invalidateSiloCloneDirectoryCache(directoryPath: string): void;
export declare function isWithinSiloClone(candidatePath: string, sourcePath: string): Promise<boolean>;
