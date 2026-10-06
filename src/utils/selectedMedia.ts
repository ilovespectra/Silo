interface MediaFile {
  path: string;
  type: string;
  isDirectory: boolean;
}

/** Memory is proportional to the selection, never the complete inventory. */
export function selectedMedia<T extends MediaFile>(
  targets: readonly string[],
  files: readonly T[],
  results: readonly T[],
): T[] {
  if (!targets.length) return [];
  const requested = new Set(targets);
  const selected = new Map<string, T>();
  const inspect = (file: T) => {
    if (!requested.has(file.path)) return;
    if (!file.isDirectory && (file.type === "image" || file.type === "video"))
      selected.set(file.path, file);
    else selected.delete(file.path);
  };
  for (const file of files) inspect(file);
  // Search results retain precedence for paths appearing in both inventories.
  for (const file of results) inspect(file);
  return Array.from(selected.values());
}
