import { Worker } from "worker_threads";
import * as path from "path";
import type { SearchPerformanceSettings } from "./contentSettings";

export type VectorSearchKind = "image" | "document";

export interface VectorSearchGroup {
  sourcePath: string;
  kind: VectorSearchKind;
  keys: BigUint64Array;
}

export interface VectorSearchHit {
  key: number;
  confidence: number;
}

interface VectorSearchWorkerResponse {
  type: "progress" | "ready" | "reply" | "error";
  requestId?: number;
  fraction?: number;
  records?: number;
  hits?: VectorSearchHit[];
  error?: string;
}

export class PersistedVectorIndex {
  private readonly worker: Worker;
  private nextRequestId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private failed = false;
  private readySettled = false;
  private closing = false;

  constructor(
    private readonly vectorsPath: string,
    private readonly cacheDirectory: string,
    private readonly onProgress: (fraction: number, records: number) => void,
    private readonly onError: (error: Error) => void,
    private settings: SearchPerformanceSettings,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(path.join(__dirname, "searchVectorIndexWorker.js"));
    this.worker.on("message", (message: VectorSearchWorkerResponse) => {
      if (message.type === "progress") {
        this.onProgress(message.fraction ?? 0, message.records ?? 0);
        return;
      }
      if (message.type === "ready") {
        this.readySettled = true;
        this.resolveReady();
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.error || "The local search index failed.");
        this.fail(error);
        return;
      }
      if (message.type === "reply" && Number.isSafeInteger(message.requestId)) {
        const pending = this.pending.get(message.requestId as number);
        if (!pending) return;
        this.pending.delete(message.requestId as number);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.hits ?? undefined);
      }
    });
    this.worker.on("error", (cause) =>
      this.fail(cause instanceof Error ? cause : new Error(String(cause))),
    );
    this.worker.on("exit", (code) => {
      if (code !== 0 && !this.failed && !this.closing)
        this.fail(new Error(`The local search worker exited with code ${code}.`));
    });
  }

  initialize(groups: VectorSearchGroup[]): Promise<void> {
    const transferList: ArrayBuffer[] = [];
    for (const group of groups) transferList.push(group.keys.buffer as ArrayBuffer);
    this.worker.postMessage(
      {
        type: "initialize",
        vectorsPath: this.vectorsPath,
        cacheDirectory: this.cacheDirectory,
        settings: this.settings,
        groups,
      },
      transferList,
    );
    return this.ready;
  }

  async search(
    sourcePaths: string[],
    imageQuery: Float32Array,
    documentQuery: Float32Array,
    limit: number,
  ): Promise<VectorSearchHit[]> {
    await this.ready;
    return (await this.request({
      type: "search",
      sourcePaths,
      imageQuery,
      documentQuery,
      limit,
    })) as VectorSearchHit[];
  }

  setPaused(paused: boolean) {
    if (this.failed) return;
    this.worker.postMessage({ type: paused ? "pause" : "resume" });
  }

  updateSettings(settings: SearchPerformanceSettings) {
    if (this.failed) return;
    this.settings = { ...settings };
    this.worker.postMessage({ type: "set-settings", settings: this.settings });
  }

  upsert(sourcePath: string, kind: VectorSearchKind, key: number) {
    if (this.failed) return;
    this.worker.postMessage({ type: "upsert", sourcePath, kind, key });
  }

  remove(sourcePath: string, kind: VectorSearchKind, key: number) {
    if (this.failed) return;
    this.worker.postMessage({ type: "remove", sourcePath, kind, key });
  }

  async shutdown(timeoutMs: number): Promise<void> {
    if (this.failed || this.closing) return;
    this.closing = true;
    if (!this.readySettled) {
      await this.worker.terminate();
      return;
    }
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.request({ type: "flush" }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out saving the local search index.")),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      // A later launch reconciles unsaved vector additions from the saved records.
    } finally {
      if (timeout) clearTimeout(timeout);
      await this.worker.terminate();
    }
  }

  private request(message: Record<string, unknown>): Promise<unknown> {
    if (this.failed) return Promise.reject(new Error("The local search index is unavailable."));
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...message, requestId });
    });
  }

  private fail(error: Error) {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.readySettled = true;
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onError(error);
  }
}
