import { promises as fsPromises } from "fs";
import path from "path";

export interface ThumbnailPregenProgress {
  status: "idle" | "waiting" | "scanning" | "generating" | "complete" | "error";
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
  listRemoteMediaFiles: (sourcePath: string) => Promise<string[]>;
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
  private rerunRequested = false;
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
    if (this.runPromise) {
      this.rerunRequested = true;
      return this.runPromise;
    }
    this.runPromise = (async () => {
      do {
        this.rerunRequested = false;
        await this.run();
      } while (this.rerunRequested);
    })().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  private async run() {
    this.update(
      {
        status: "scanning",
        total: 0,
        processed: 0,
        generated: 0,
        failed: 0,
        message: "Finding photos and videos…",
      },
      true,
    );
    try {
      const files: string[] = [];
      for (const root of new Set(await this.deps.getSourceRoots())) {
        await this.waitForIndexingIdle();
        await this.collect(root, files);
      }
      this.update(
        {
          status: "generating",
          total: files.length,
          message: "Generating thumbnails…",
        },
        true,
      );
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const filePath = files[next++];
          let waitMessage = this.deps.getIndexingWaitMessage();
          while (waitMessage) {
            if (
              this.progress.status !== "waiting" ||
              this.progress.message !== waitMessage
            )
              this.update({ status: "waiting", message: waitMessage }, true);
            await new Promise((resolve) => setTimeout(resolve, 250));
            waitMessage = this.deps.getIndexingWaitMessage();
          }
          this.update({
            status: "generating",
            message: "Generating thumbnails…",
          });
          while (this.deps.isInteractiveBusy())
            await new Promise((resolve) => setTimeout(resolve, 250));
          const ok = await this.deps.generate(filePath).catch(() => false);
          this.progress.processed += 1;
          if (ok) this.progress.generated += 1;
          else this.progress.failed += 1;
          this.update({});
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      this.update(
        {
          status: "complete",
          message: `${this.progress.generated.toLocaleString()} thumbnails ready${this.progress.failed ? ` · ${this.progress.failed.toLocaleString()} unavailable` : ""}.`,
        },
        true,
      );
    } catch (error) {
      this.update(
        {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
  }

  // Iterative walk keeps memory flat on very large libraries.
  private async collect(root: string, files: string[]) {
    if (this.deps.isRemotePath(root)) {
      await this.waitForIndexingIdle();
      files.push(...(await this.deps.listRemoteMediaFiles(root)));
      return;
    }
    const stack = [root];
    while (stack.length > 0) {
      await this.waitForIndexingIdle();
      const directory = stack.pop()!;
      let handle;
      try {
        handle = await fsPromises.opendir(directory);
      } catch {
        continue;
      }
      for await (const entry of handle) {
        await this.waitForIndexingIdle();
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile() && this.deps.isMedia(entry.name))
          files.push(fullPath);
      }
      if (files.length % 2000 === 0)
        this.update({
          total: files.length,
          message: `Finding photos and videos… ${files.length.toLocaleString()}`,
        });
    }
  }

  private async waitForIndexingIdle() {
    while (this.deps.getIndexingWaitMessage())
      await new Promise((resolve) => setTimeout(resolve, 100));
  }

  private update(patch: Partial<ThumbnailPregenProgress>, force = false) {
    this.progress = { ...this.progress, ...patch };
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    this.deps.onProgress(this.getProgress());
  }
}
