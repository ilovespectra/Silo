import { createHash, randomUUID } from "crypto";
import { constants as fsConstants, createReadStream } from "fs";
import type * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { IndexableFile } from "./semanticIndexer";

export interface DuplicateFile extends IndexableFile {
  hash: string;
  sourceId: string;
}

export interface DuplicateGroup {
  id: string;
  sourceId: string;
  hash: string;
  size: number;
  reclaimableBytes: number;
  keepPath: string;
  files: DuplicateFile[];
}

export interface DuplicateTrashEntry {
  id: string;
  originalPath: string;
  trashPath: string;
  size: number;
  hash: string;
  deletedAt: number;
}

export interface DuplicateState {
  status: "idle" | "scanning" | "complete" | "error";
  scanned: number;
  total: number;
  duplicateFiles: number;
  reclaimableBytes: number;
  trashBytes: number;
  permanentlyClearedBytes: number;
  message: string;
  groups: DuplicateGroup[];
  trash: DuplicateTrashEntry[];
}

interface HashRecord {
  signature: string;
  hash: string;
}

type Listener = (state: DuplicateState) => void;

const statSignature = (stats: { size: number; mtimeMs: number }) =>
  `${stats.size}:${Math.round(stats.mtimeMs)}`;

function withinSource(filePath: string, sourceId: string) {
  const relative = path.relative(sourceId, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function safeSourceGroup(group: DuplicateGroup) {
  return (
    typeof group.sourceId === "string" &&
    path.isAbsolute(group.sourceId) &&
    group.files.length >= 2 &&
    group.files.every(
      (file) =>
        file.sourceId === group.sourceId &&
        withinSource(file.path, group.sourceId),
    ) &&
    new Set(group.files.map((file) => path.resolve(file.path))).size ===
      group.files.length
  );
}

async function realSourceMember(filePath: string, sourceId: string) {
  const [realFile, realRoot] = await Promise.all([
    fsPromises.realpath(filePath),
    fsPromises.realpath(sourceId),
  ]);
  return withinSource(realFile, realRoot);
}

async function volumeMounted(filePath: string, cache: Map<string, boolean>) {
  const match = /^\/Volumes\/[^/]+/.exec(filePath);
  if (!match) return true;
  const root = match[0];
  let mounted = cache.get(root);
  if (mounted === undefined) {
    mounted = await fsPromises.access(root).then(
      () => true,
      () => false,
    );
    cache.set(root, mounted);
  }
  return mounted;
}

export class DuplicateManager {
  private readonly indexPath: string;
  private readonly trashManifestPath: string;
  private readonly trashDirectory: string;
  private readonly listener: Listener;
  private readonly hashes = new Map<string, HashRecord>();
  private readonly retryableFailures = new Set<string>();
  private groups: DuplicateGroup[] = [];
  private trash: DuplicateTrashEntry[] = [];
  private permanentlyClearedBytes = 0;
  private scanPromise: Promise<DuplicateState> | null = null;
  private prunePromise: Promise<boolean> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private state: Omit<DuplicateState, "groups" | "trash"> = {
    status: "idle",
    scanned: 0,
    total: 0,
    duplicateFiles: 0,
    reclaimableBytes: 0,
    trashBytes: 0,
    permanentlyClearedBytes: 0,
    message: "Duplicate scan has not started.",
  };

  constructor(
    userDataPath: string,
    listener: Listener = () => undefined,
    indexStoragePath: string = userDataPath,
  ) {
    this.indexPath = path.join(indexStoragePath, "duplicate-index.json");
    this.trashManifestPath = path.join(userDataPath, "duplicate-trash.json");
    this.trashDirectory = path.join(userDataPath, "duplicate-trash", "files");
    this.listener = listener;
  }

  async initialize() {
    try {
      const stored = JSON.parse(
        await fsPromises.readFile(this.indexPath, "utf8"),
      ) as {
        hashes?: Record<string, HashRecord>;
        groups?: DuplicateGroup[];
      };
      for (const [filePath, record] of Object.entries(stored.hashes ?? {}))
        this.hashes.set(filePath, record);
      // Legacy groups lack source boundaries and must never remain removal candidates.
      this.groups = Array.isArray(stored.groups)
        ? stored.groups.filter(safeSourceGroup)
        : [];
    } catch {
      await this.persistIndex();
    }
    try {
      const stored = JSON.parse(
        await fsPromises.readFile(this.trashManifestPath, "utf8"),
      );
      this.trash = Array.isArray(stored)
        ? stored
        : Array.isArray(stored.entries)
          ? stored.entries
          : [];
      this.permanentlyClearedBytes = Array.isArray(stored)
        ? 0
        : Number(stored.permanentlyClearedBytes) || 0;
    } catch {
      await this.persistTrash();
    }
    this.recalculate(
      "idle",
      this.groups.length > 0
        ? `${this.groups.length.toLocaleString()} duplicate groups cached.`
        : "Ready to scan for exact duplicates.",
    );
    void this.pruneMissing();
  }

  /** Drops files that no longer exist so removed copies don't linger as stale groups. */
  pruneMissing() {
    this.prunePromise ??= this.runPruneMissing().finally(() => {
      this.prunePromise = null;
    });
    return this.prunePromise;
  }

  private async runPruneMissing() {
    const mounts = new Map<string, boolean>();
    let changed = false;
    const nextGroups: DuplicateGroup[] = [];
    for (const group of this.groups) {
      const present: DuplicateFile[] = [];
      for (let index = 0; index < group.files.length; index += 64) {
        const batch = group.files.slice(index, index + 64);
        const results = await Promise.all(
          batch.map(async (file) => {
            // Files on an unplugged drive are kept; they are unknown, not deleted.
            if (!(await volumeMounted(file.path, mounts))) return true;
            return fsPromises.access(file.path).then(
              () => true,
              () => false,
            );
          }),
        );
        batch.forEach((file, offset) => {
          if (results[offset]) present.push(file);
          else this.hashes.delete(file.path);
        });
      }
      if (present.length !== group.files.length) changed = true;
      if (present.length < 2) continue;
      const keepPath = present.some((file) => file.path === group.keepPath)
        ? group.keepPath
        : present[0].path;
      nextGroups.push({
        ...group,
        files: present,
        keepPath,
        reclaimableBytes: group.size * (present.length - 1),
      });
    }
    if (!changed) return false;
    this.groups = nextGroups;
    await this.persistIndex();
    this.recalculate(
      this.state.status === "scanning" ? "scanning" : "complete",
      `${this.groups.length.toLocaleString()} duplicate groups after removing entries for files that no longer exist.`,
    );
    return true;
  }

  getState(): DuplicateState {
    return { ...this.state, groups: this.groups, trash: this.trash };
  }

  getRetryableFailureCount() {
    return this.retryableFailures.size;
  }

  scan(files: IndexableFile[], sourceRoots: string[] = []) {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.runScan(files, sourceRoots).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async quarantine(groupIds: string[]) {
    const selected = new Set(groupIds);
    const groups = this.groups.filter((group) => selected.has(group.id));
    for (const group of groups) {
      if (!safeSourceGroup(group))
        throw new Error(
          "Unsafe cross-source duplicate group. Scan again before removing files.",
        );
      const keep = group.files.find((file) => file.path === group.keepPath);
      if (!(await realSourceMember(group.keepPath, group.sourceId)))
        throw new Error("Retained file resolves outside its source.");
      if (!keep || (await this.hashFile(keep.path)) !== group.hash)
        throw new Error(`The retained file changed: ${group.keepPath}`);
      for (const file of group.files) {
        if (file.path === group.keepPath) continue;
        if (!(await realSourceMember(file.path, group.sourceId)))
          throw new Error("Duplicate candidate resolves outside its source.");
        const [keepStats, fileStats] = await Promise.all([
          fsPromises.stat(group.keepPath),
          fsPromises.stat(file.path),
        ]);
        if (keepStats.dev === fileStats.dev && keepStats.ino === fileStats.ino)
          throw new Error(
            "The candidate is another reference to the retained file, not a duplicate copy.",
          );
        if ((await this.hashFile(file.path)) !== group.hash)
          throw new Error(`A duplicate changed since scanning: ${file.path}`);
      }
      for (const file of group.files) {
        if (file.path === group.keepPath) continue;
        const id = randomUUID();
        const trashPath = path.join(
          this.trashDirectory,
          `${id}${path.extname(file.path)}`,
        );
        await fsPromises.mkdir(this.trashDirectory, { recursive: true });
        await this.move(file.path, trashPath);
        this.trash.push({
          id,
          originalPath: file.path,
          trashPath,
          size: file.size,
          hash: group.hash,
          deletedAt: Date.now(),
        });
        this.hashes.delete(file.path);
        await this.persistTrash();
      }
    }
    this.groups = this.groups.filter((group) => !selected.has(group.id));
    await Promise.all([this.persistIndex(), this.persistTrash()]);
    this.recalculate(
      "complete",
      `Moved exact duplicates to review. One original from each group was preserved.`,
    );
    return this.getState();
  }

  async quarantineFiles(filePaths: string[]) {
    const selected = new Set(filePaths);
    const total = filePaths.length;
    let processed = 0;
    let moved = 0;
    let missing = 0;
    let skipped = 0;
    let lastProgressUpdate = 0;
    const updateProgress = () => {
      const now = Date.now();
      if (now - lastProgressUpdate < 500) return;
      lastProgressUpdate = now;
      try {
        this.listener({
          ...this.getState(),
          message: `Moving ${processed} / ${total}...`,
          scanned: processed,
          total,
        });
      } catch (err) {
        console.warn(
          `[DUPLICATE] Progress update failed (UI may be closed):`,
          err,
        );
      }
    };

    for (const group of this.groups) {
      if (!safeSourceGroup(group)) continue;
      // The protected original is never a removal candidate, even if requested.
      const requested = group.files.filter(
        (file) => selected.has(file.path) && file.path !== group.keepPath,
      );
      if (requested.length === 0) continue;

      // Prove the original exists and still has the group's content before touching any copy.
      let keepStats: fs.Stats;
      try {
        keepStats = await fsPromises.stat(group.keepPath);
        if (!(await realSourceMember(group.keepPath, group.sourceId)))
          throw new Error("outside source");
        if (!(await this.matchesHash(group.keepPath, keepStats, group.hash)))
          throw new Error("changed");
      } catch {
        skipped += requested.length;
        processed += requested.length;
        updateProgress();
        continue;
      }

      const removed = new Set<string>();
      for (const file of requested) {
        processed += 1;
        let stats: fs.Stats;
        try {
          stats = await fsPromises.stat(file.path);
        } catch {
          removed.add(file.path);
          missing += 1;
          continue;
        }
        // Same inode means another name for the original (hard link / case alias): removing it would remove the original.
        if (stats.dev === keepStats.dev && stats.ino === keepStats.ino) {
          skipped += 1;
          continue;
        }
        try {
          if (!(await realSourceMember(file.path, group.sourceId))) {
            skipped += 1;
            continue;
          }
          if (!(await this.matchesHash(file.path, stats, group.hash))) {
            skipped += 1;
            continue;
          }
          const id = randomUUID();
          const trashPath = path.join(
            this.trashDirectory,
            `${id}${path.extname(file.path)}`,
          );
          await fsPromises.mkdir(this.trashDirectory, { recursive: true });
          await this.move(file.path, trashPath);
          this.trash.push({
            id,
            originalPath: file.path,
            trashPath,
            size: file.size,
            hash: group.hash,
            deletedAt: Date.now(),
          });
          this.hashes.delete(file.path);
          removed.add(file.path);
          moved += 1;
        } catch (err) {
          console.warn(`[DUPLICATE] Failed to move ${file.path}:`, err);
          skipped += 1;
        }
        updateProgress();
      }
      group.files = group.files.filter((item) => !removed.has(item.path));
      await this.persistTrash();
      updateProgress();
    }

    this.groups = this.groups.filter((group) => group.files.length > 1);
    for (const group of this.groups)
      group.reclaimableBytes = group.size * (group.files.length - 1);
    await Promise.all([this.persistIndex(), this.persistTrash()]);

    let message = `Moved ${moved.toLocaleString()} duplicate${moved === 1 ? "" : "s"} to review. Every group kept its original.`;
    if (missing > 0)
      message += ` ${missing.toLocaleString()} already-removed file${missing === 1 ? " was" : "s were"} cleared from the list.`;
    if (skipped > 0)
      message += ` ${skipped.toLocaleString()} skipped because the original or copy could not be verified as identical.`;
    this.recalculate("complete", message);
    return this.getState();
  }

  private async matchesHash(filePath: string, stats: fs.Stats, hash: string) {
    const signature = statSignature(stats);
    // Removal must verify bytes again, even if size and mtime were preserved.
    const actual = await this.hashFile(filePath);
    this.hashes.set(filePath, { signature, hash: actual });
    return actual === hash;
  }

  async restore(ids: string[]) {
    const selected = new Set(ids);
    for (const entry of this.trash.filter((item) => selected.has(item.id))) {
      try {
        await fsPromises.access(entry.originalPath);
        throw new Error(
          `Cannot restore because a file already exists at ${entry.originalPath}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fsPromises.mkdir(path.dirname(entry.originalPath), {
        recursive: true,
      });
      await this.move(entry.trashPath, entry.originalPath);
      this.trash = this.trash.filter((item) => item.id !== entry.id);
      await this.persistTrash();
    }
    this.recalculate("complete", `Restored selected files.`);
    return this.getState();
  }

  async clearTrash(ids?: string[]) {
    const selected = ids ? new Set(ids) : null;
    const removing = this.trash.filter(
      (item) => !selected || selected.has(item.id),
    );
    for (const entry of removing)
      await fsPromises.rm(entry.trashPath, { force: true });
    this.permanentlyClearedBytes += removing.reduce(
      (sum, item) => sum + item.size,
      0,
    );
    const removedIds = new Set(removing.map((item) => item.id));
    this.trash = this.trash.filter((item) => !removedIds.has(item.id));
    await this.persistTrash();
    this.recalculate(
      "complete",
      `Permanently cleared ${removing.length.toLocaleString()} files.`,
    );
    return this.getState();
  }

  private async runScan(files: IndexableFile[], sourceRoots: string[]) {
    this.retryableFailures.clear();
    const roots = (await Promise.all(Array.from(new Set(
      sourceRoots
        .filter((root) => path.isAbsolute(root) && !root.startsWith("/__"))
        .map((root) => path.resolve(root)),
    )).map(async (root) =>
      await fsPromises.access(root, fsConstants.R_OK)
        .then(() => root, () => null),
    ))).filter((root): root is string => root !== null)
      .sort((first, second) => second.length - first.length);
    const uniqueFiles = new Map<string, IndexableFile & { sourceId: string }>();
    for (const file of files) {
      if (
        file.isDirectory ||
        !path.isAbsolute(file.path) ||
        file.path.startsWith("/__")
      )
        continue;
      const filePath = path.resolve(file.path);
      const sourceId = roots.find((root) => withinSource(filePath, root));
      // Ambiguous/unattributed files are not safe removal candidates.
      if (sourceId)
        uniqueFiles.set(filePath, { ...file, path: filePath, sourceId });
    }
    const localFiles = Array.from(uniqueFiles.values());
    const sizeGroups = new Map<
      string,
      Array<IndexableFile & { sourceId: string }>
    >();
    for (const file of localFiles) {
      const key = JSON.stringify([file.sourceId, file.size]);
      const group = sizeGroups.get(key) ?? [];
      group.push(file);
      sizeGroups.set(key, group);
    }
    const candidates = Array.from(sizeGroups.values())
      .filter((group) => group.length > 1)
      .flat();
    this.state = {
      ...this.state,
      status: "scanning",
      scanned: 0,
      total: candidates.length,
      message: `Hashing ${candidates.length.toLocaleString()} same-sized files...`,
    };
    this.emit();
    const byHash = new Map<string, DuplicateFile[]>();
    const seenInodes = new Map<string, Set<string>>();
    const realRoots = new Map<string, string>();
    for (let index = 0; index < candidates.length; index += 1) {
      const file = candidates[index];
      try {
        let realRoot = realRoots.get(file.sourceId);
        if (!realRoot) {
          realRoot = await fsPromises.realpath(file.sourceId);
          realRoots.set(file.sourceId, realRoot);
        }
        if (!withinSource(await fsPromises.realpath(file.path), realRoot))
          continue;
        // Real stat, not index metadata: the index can still list files that were removed.
        const stats = await fsPromises.stat(file.path);
        const signature = statSignature(stats);
        let record = this.hashes.get(file.path);
        if (!record || record.signature !== signature) {
          record = { signature, hash: await this.hashFile(file.path) };
          this.hashes.set(file.path, record);
        }
        const groupKey = JSON.stringify([file.sourceId, record.hash]);
        const inodes = seenInodes.get(groupKey) ?? new Set<string>();
        const inode = `${stats.dev}:${stats.ino}`;
        if (!inodes.has(inode)) {
          inodes.add(inode);
          seenInodes.set(groupKey, inodes);
          const group = byHash.get(groupKey) ?? [];
          group.push({
            ...file,
            size: stats.size,
            modified: stats.mtimeMs,
            hash: record.hash,
          });
          byHash.set(groupKey, group);
        }
      } catch {
        this.hashes.delete(file.path);
        this.retryableFailures.add(file.path);
      }
      this.state.scanned = index + 1;
      this.state.message = `Checked ${(index + 1).toLocaleString()} of ${candidates.length.toLocaleString()} candidates...`;
      if (index % 100 === 0 || index + 1 === candidates.length) this.emit();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.groups = Array.from(byHash.entries())
      .filter(([, group]) => group.length > 1)
      .map(([groupKey, group]) => {
        const files = [...group].sort(
          (first, second) =>
            first.modified - second.modified ||
            first.path.length - second.path.length ||
            first.path.localeCompare(second.path),
        );
        return {
          id: createHash("sha256").update(groupKey).digest("hex"),
          sourceId: files[0].sourceId,
          hash: files[0].hash,
          size: files[0].size,
          reclaimableBytes: files[0].size * (files.length - 1),
          keepPath: files[0].path,
          files,
        };
      })
      .sort(
        (first, second) => second.reclaimableBytes - first.reclaimableBytes,
      );
    await this.persistIndex();
    this.recalculate(
      "complete",
      `${this.groups.length.toLocaleString()} exact duplicate groups found within individual sources. Cross-source copies are excluded.`,
    );
    return this.getState();
  }

  private hashFile(filePath: string) {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  private async move(source: string, destination: string) {
    try {
      await fsPromises.rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fsPromises.copyFile(source, destination);
      await fsPromises.unlink(source);
    }
  }

  private recalculate(status: DuplicateState["status"], message: string) {
    this.state = {
      ...this.state,
      status,
      duplicateFiles: this.groups.reduce(
        (sum, group) => sum + group.files.length - 1,
        0,
      ),
      reclaimableBytes: this.groups.reduce(
        (sum, group) => sum + group.reclaimableBytes,
        0,
      ),
      trashBytes: this.trash.reduce((sum, item) => sum + item.size, 0),
      permanentlyClearedBytes: this.permanentlyClearedBytes,
      message,
    };
    this.emit();
  }

  private emit() {
    this.listener(this.getState());
  }

  private async persistIndex() {
    const data = JSON.stringify({
      hashes: Object.fromEntries(this.hashes),
      groups: this.groups,
    });
    await this.writeAtomic(this.indexPath, data);
  }

  private async persistTrash() {
    const data = JSON.stringify(
      {
        entries: this.trash,
        permanentlyClearedBytes: this.permanentlyClearedBytes,
      },
      null,
      2,
    );
    await this.writeAtomic(this.trashManifestPath, data);
  }

  /** Writes run one at a time, each via its own temp file, so overlapping saves can't clobber each other. */
  private writeAtomic(filePath: string, data: string) {
    const write = this.writeChain.then(async () => {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fsPromises.writeFile(temporary, data);
        await fsPromises.rename(temporary, filePath);
      } finally {
        await fsPromises.rm(temporary, { force: true });
      }
    });
    this.writeChain = write.catch(() => undefined);
    return write;
  }
}
