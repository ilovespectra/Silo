import { promises as fsPromises } from "fs";
import path from "path";

export interface ThumbnailPregenProgress {
  status: "idle" | "waiting" | "scanning" | "generating" | "paused" | "complete" | "error";
  total: number;
  processed: number;
  generated: number;
  failed: number;
  message: string;
}

interface Dependencies {
  /** Enabled local, phone, and cloud source roots. */
  getSourceRoots: () => Promise<string[]>;
  isMedia: (fileName: string) => boolean;
  isRemotePath: (sourcePath: string) => boolean;
  listRemoteMediaFiles: (
    sourcePath: string,
    isCancelled: () => boolean,
  ) => Promise<string[]>;
  /** Renders and caches one thumbnail; resolves false when it could not be produced. */
  generate: (filePath: string) => Promise<boolean>;
  /** True while user-visible thumbnail requests are waiting, so background work yields. */
  isInteractiveBusy: () => boolean;
  /** Returns a message while CLIP, face clustering, or location indexing is active. */
  getIndexingWaitMessage: () => string | null;
  onProgress: (progress: ThumbnailPregenProgress) => void;
}

const CONCURRENCY = 2;
const PROGRESS_INTERVAL_MS = 500;

export class ThumbnailPregenerator {
  private progress: ThumbnailPregenProgress = {
    status: "idle",
    total: 0,
    processed: 0,
    generated: 0,
    failed: 0,
    message: "Thumbnails are generated after indexing finishes.",
  };
  private runPromise: Promise<void> | null = null;
  private pauseRequested = false;
  private discoveredFiles: string[] = [];
  private discoveredFileSet = new Set<string>();
  private nextFile = 0;
  private scanComplete = false;
  private lastEmit = 0;

  constructor(private readonly deps: Dependencies) {}

  getProgress() {
    return { ...this.progress };
  }

  setWaiting(message: string) {
    if (this.runPromise) return;
    this.update({ status: "waiting", message }, true);
  }

  start() {
    // Recovery can request the same stage more than once. Share active work;
    // never queue a second walk behind it.
    if (this.runPromise) return this.runPromise;
    if (this.progress.status === "complete" || this.progress.status === "error")
      this.resetWork();
    this.pauseRequested = false;
    this.runPromise = this.run().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  /** Stop at the next safe checkpoint and keep the in-process file cursor. */
  async pause() {
    await this.stop("Thumbnail generation paused at a safe checkpoint.");
  }

  /** Shutdown cancellation is resumable: cached output is reused on next launch. */
  async cancel() {
    await this.stop("Thumbnail generation cancelled; it can resume after restart.");
  }

  /** Add a changed source file to active discovery/generation without queuing a second run. */
  includeFile(filePath: string) {
    if (
      !this.runPromise ||
      ["complete", "error", "paused"].includes(this.progress.status)
    )
      return false;
    if (this.deps.isMedia(filePath)) this.addFile(filePath);
    return true;
  }

  /** The recovery scheduler calls this before its queued resume tick. */
  resume() {
    this.pauseRequested = false;
    if (this.progress.status === "paused")
      this.update(
        { status: "waiting", message: "Waiting for a thumbnail processing slot…" },
        true,
      );
  }

  private async stop(message: string) {
    this.pauseRequested = true;
    if (this.runPromise) {
      await this.runPromise;
      return;
    }
    this.update({ status: "paused", message }, true);
  }

  private resetWork() {
    this.discoveredFiles = [];
    this.discoveredFileSet.clear();
    this.nextFile = 0;
    this.scanComplete = false;
    this.update(
      { total: 0, processed: 0, generated: 0, failed: 0 },
      true,
    );
  }

  private async run() {
    try {
      if (!this.scanComplete) {
        this.update(
          {
            status: "scanning",
            total: this.discoveredFiles.length,
            message: "Finding photos and videos…",
          },
          true,
        );
        for (const root of new Set(await this.deps.getSourceRoots())) {
          if (!(await this.waitForIndexingIdle())) return this.markPaused();
          if (!(await this.collect(root))) return this.markPaused();
        }
        this.scanComplete = true;
      }

      this.update(
        {
          status: "generating",
          total: this.discoveredFiles.length,
          message: "Generating thumbnails…",
        },
        true,
      );
      const worker = async () => {
        while (this.nextFile < this.discoveredFiles.length) {
          if (!(await this.waitForIndexingIdle())) return;
          if (this.pauseRequested) return;
          while (this.deps.isInteractiveBusy()) {
            if (this.pauseRequested) return;
            this.update(
              { status: "waiting", message: "Waiting for file previews requested in Silo…" },
              true,
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (this.pauseRequested) return;
          // Another worker may have claimed the last queued path while this one
          // was waiting for indexing or interactive thumbnail demand.
          if (this.nextFile >= this.discoveredFiles.length) return;
          const filePath = this.discoveredFiles[this.nextFile++];
          this.update({ status: "generating", message: "Generating thumbnails…" });
          const ok = await this.deps.generate(filePath).catch(() => false);
          this.progress.processed += 1;
          if (ok) this.progress.generated += 1;
          else this.progress.failed += 1;
          this.update({});
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (this.pauseRequested) return this.markPaused();
      this.update(
        {
          status: "complete",
          total: this.discoveredFiles.length,
          message: `${this.progress.generated.toLocaleString()} thumbnails ready${this.progress.failed ? ` · ${this.progress.failed.toLocaleString()} unavailable` : ""}.`,
        },
        true,
      );
    } catch (error) {
      if (this.pauseRequested) return this.markPaused();
      this.update(
        {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
  }

  private markPaused() {
    this.update(
      {
        status: "paused",
        total: this.discoveredFiles.length,
        message: "Thumbnail generation paused at a safe checkpoint.",
      },
      true,
    );
  }

  private addFile(filePath: string) {
    if (this.discoveredFileSet.has(filePath)) return;
    this.discoveredFileSet.add(filePath);
    this.discoveredFiles.push(filePath);
    this.update({
      total: this.discoveredFiles.length,
      message: `Finding photos and videos… ${this.discoveredFiles.length.toLocaleString()}`,
    });
  }

  // Iterative walk keeps memory flat on very large libraries.
  private async collect(root: string): Promise<boolean> {
    if (this.deps.isRemotePath(root)) {
      if (!(await this.waitForIndexingIdle())) return false;
      const files = await this.deps.listRemoteMediaFiles(
        root,
        () => this.pauseRequested,
      );
      files.forEach((filePath) => this.addFile(filePath));
      return !this.pauseRequested;
    }
    const stack = [root];
    while (stack.length > 0) {
      if (!(await this.waitForIndexingIdle())) return false;
      const directory = stack.pop()!;
      let handle;
      try {
        handle = await fsPromises.opendir(directory);
      } catch {
        continue;
      }
      for await (const entry of handle) {
        if (!(await this.waitForIndexingIdle())) return false;
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile() && this.deps.isMedia(entry.name))
          this.addFile(fullPath);
      }
    }
    return true;
  }

  private async waitForIndexingIdle(): Promise<boolean> {
    while (true) {
      if (this.pauseRequested) return false;
      const message = this.deps.getIndexingWaitMessage();
      if (!message) return true;
      if (
        this.progress.status !== "waiting" ||
        this.progress.message !== message
      )
        this.update({ status: "waiting", message }, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private update(patch: Partial<ThumbnailPregenProgress>, force = false) {
    this.progress = { ...this.progress, ...patch };
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    this.deps.onProgress(this.getProgress());
  }
}
