import type { MemoryMedia } from "./memoryTypes";

export interface MemorySafetyFolder {
  id: string;
  name: string;
  filePaths: string[];
}

export const MEMORY_EXPLICIT_SCORE_THRESHOLD = 0.2;
// Require a clear explicit-content advantage so affectionate kissing, swimwear,
// and ordinary bare skin are not removed by small classifier score differences.
export const MEMORY_EXPLICIT_SCORE_MARGIN = 0.05;

/** A result is explicit only when the visual model has a clear score advantage. */
export function isMemoryVisualContentExplicit(unsafeScore: number, safeScore: number): boolean {
  if (!Number.isFinite(unsafeScore) || !Number.isFinite(safeScore)) return true;
  return unsafeScore >= MEMORY_EXPLICIT_SCORE_THRESHOLD &&
    unsafeScore - safeScore >= MEMORY_EXPLICIT_SCORE_MARGIN;
}

/** Confirms an explicit prompted-folder tag against current folder membership. */
export function hasValidPromptedMemoryFolderContext(
  filePath: string,
  media: Pick<MemoryMedia, "promptedMemoryFolderId"> | undefined,
  folders: readonly MemorySafetyFolder[],
): boolean {
  const folderId = media?.promptedMemoryFolderId;
  if (typeof folderId !== "string" || !folderId) return false;
  return folders.some((folder) =>
    folder.id === folderId && folder.filePaths.includes(filePath),
  );
}
