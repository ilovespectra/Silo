import { randomUUID } from "crypto";

export interface InventoryReference {
  inventoryToken: string;
  total: number;
}

/** Keeps large arrays out of Electron's native value serializer. */
export class InventoryTransfers {
  private entries = new Map<
    string,
    { owner: number; files: unknown[]; touched: number }
  >();
  constructor(private now = Date.now) {}
  create(files: unknown[], owner: number): InventoryReference {
    this.expire();
    // Failed/replaced renderer requests must not retain unlimited full inventories.
    const owned = Array.from(this.entries).filter(
      ([, entry]) => entry.owner === owner,
    );
    while (owned.length >= 4) this.entries.delete(owned.shift()![0]);
    while (this.entries.size >= 8)
      this.entries.delete(this.entries.keys().next().value!);
    const inventoryToken = randomUUID();
    this.entries.set(inventoryToken, { owner, files, touched: this.now() });
    return { inventoryToken, total: files.length };
  }
  read(token: string, offset: number, owner: number) {
    const entry = this.entries.get(token);
    if (!entry || entry.owner !== owner)
      throw new Error("Inventory expired or unavailable. Refresh the library.");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > entry.files.length
    )
      throw new Error("Invalid inventory page.");
    entry.touched = this.now();
    const items: unknown[] = [];
    let bytes = 0;
    let nextOffset = offset;
    while (nextOffset < entry.files.length && items.length < 1000) {
      const item = entry.files[nextOffset];
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > 512 * 1024)
        throw new Error("Inventory entry exceeds safe transfer size.");
      if (items.length && bytes + size > 512 * 1024) break;
      bytes += size;
      items.push(item);
      nextOffset++;
    }
    return { items, nextOffset, done: nextOffset === entry.files.length };
  }
  release(token: string, owner: number) {
    if (this.entries.get(token)?.owner === owner) this.entries.delete(token);
  }
  releaseOwner(owner: number) {
    for (const [token, entry] of this.entries)
      if (entry.owner === owner) this.entries.delete(token);
  }
  expire() {
    for (const [token, entry] of this.entries)
      if (this.now() - entry.touched > 10 * 60000) this.entries.delete(token);
  }
}
