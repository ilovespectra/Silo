export interface DigitalFolderScopedFile {
  path: string;
}

/** Keep the visible list inside both the active folder and selected sources. */
export function filterToDigitalFolderScope<T extends DigitalFolderScopedFile>(
  files: readonly T[],
  folderFilePaths: ReadonlySet<string> | null,
  isVisibleForSelectedSources: (filePath: string) => boolean,
): T[] {
  return files.filter(
    (file) =>
      (!folderFilePaths || folderFilePaths.has(file.path)) &&
      isVisibleForSelectedSources(file.path),
  );
}
