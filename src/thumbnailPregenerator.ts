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
  private pauseRequested = false;
  private lastEmit = 0;

  constructor(private readonly deps: Dependencies) {}

  getProgress() {
    return { ...this.progress };
  }

  setWaiting(message: string) {
    if (this.runPromise) return;
    this.update({ status: "waiting", message }, true);
  }

  start(): Promise<void> {
    if (this.runPromise) {
      if (this.pauseRequested)
        return this.runPromise.then(() => this.start());
      this.rerunRequested = true;
      return this.runPromise;
    }
    this.pauseRequested = false;
    this.runPromise = (async () => {
      do {
        this.rerunRequested = false;
        await this.run();
      } while (this.rerunRequested && !this.pauseRequested);
    })().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  /** Finish current filesystem work, then leave the generated-thumbnail cache checkpointed. */
  async pause() {
    this.pauseRequested = true;
    this.rerunRequested = false;
    await this.runPromise?.catch(() => undefined);
    this.update(
      { status: "paused", message: "Paused · generated thumbnails are saved." },
      true,
    );
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
        if (this.pauseRequested) return this.updatePaused();
        await this.waitForIndexingIdle();
        if (this.pauseRequested) return this.updatePaused();
        await this.collect(root, files);
      }
      if (this.pauseRequested) return this.updatePaused();
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
        while (next < files.length && !this.pauseRequested) {
          const filePath = files[next++];
          let waitMessage = this.deps.getIndexingWaitMessage();
          while (waitMessage && !this.pauseRequested) {
            if (
              this.progress.status !== "waiting" ||
              this.progress.message !== waitMessage
            )
              this.update({ status: "waiting", message: waitMessage }, true);
            await new Promise((resolve) => setTimeout(resolve, 250));
            waitMessage = this.deps.getIndexingWaitMessage();
          }
          if (this.pauseRequested) return;
          this.update({
            status: "generating",
            message: "Generating thumbnails…",
          });
          while (this.deps.isInteractiveBusy() && !this.pauseRequested)
            await new Promise((resolve) => setTimeout(resolve, 250));
          if (this.pauseRequested) return;
          const ok = await this.deps.generate(filePath).catch(() => false);
          this.progress.processed += 1;
          if (ok) this.progress.generated += 1;
          else this.progress.failed += 1;
          this.update({});
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (this.pauseRequested) return this.updatePaused();
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

  private updatePaused() {
    this.update(
      { status: "paused", message: "Paused · generated thumbnails are saved." },
      true,
    );
  }

  // Iterative walk keeps memory flat on very large libraries.
  private async collect(root: string, files: string[]) {
    if (this.pauseRequested) return;
    if (this.deps.isRemotePath(root)) {
      await this.waitForIndexingIdle();
      if (this.pauseRequested) return;
      files.push(...(await this.deps.listRemoteMediaFiles(root)));
      return;
    }
    const stack = [root];
    while (stack.length > 0 && !this.pauseRequested) {
      await this.waitForIndexingIdle();
      if (this.pauseRequested) return;
      const directory = stack.pop()!;
      let handle;
      try {
        handle = await fsPromises.opendir(directory);
      } catch {
        continue;
      }
      for await (const entry of handle) {
        if (this.pauseRequested) return;
        await this.waitForIndexingIdle();
        if (this.pauseRequested) return;
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
    while (!this.pauseRequested && this.deps.getIndexingWaitMessage())
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
