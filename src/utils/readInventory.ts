export interface InventoryReference {
  inventoryToken: string;
  total: number;
}

export async function readInventory<T>(
  api: NonNullable<Window["electron"]>,
  value: T[] | InventoryReference,
  isCancelled: () => boolean = () => false,
): Promise<T[]> {
  if (Array.isArray(value)) return value;
  const files: T[] = [];
  try {
    let offset = 0;
    while (offset < value.total && !isCancelled()) {
      const page = await api.readInventoryPage(value.inventoryToken, offset);
      if (page.nextOffset <= offset)
        throw new Error("Inventory transfer made no progress.");
      for (const file of page.items) files.push(file as T);
      offset = page.nextOffset;
      if (page.done) break;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (isCancelled()) return [];
    if (files.length !== value.total)
      throw new Error("Incomplete inventory transfer. Refresh to retry.");
    return files;
  } finally {
    await api.releaseInventory(value.inventoryToken).catch(() => undefined);
  }
}

type AudioSnapshot = Omit<AudioLibraryCacheSnapshot, "files"> & {
  files: FileInfo[];
};
const audioLoads = new WeakMap<object, Promise<AudioSnapshot>>();

export function loadAudioInventory(
  api: NonNullable<Window["electron"]>,
): Promise<AudioSnapshot> {
  const existing = audioLoads.get(api);
  if (existing) return existing;
  const pending = (async () => {
    const snapshot = await api.getAudioLibraryCache();
    return {
      ...snapshot,
      files: await readInventory<FileInfo>(api, snapshot.files),
    };
  })().finally(() => {
    if (audioLoads.get(api) === pending) audioLoads.delete(api);
  });
  audioLoads.set(api, pending);
  return pending;
}
