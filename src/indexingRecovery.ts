import * as fs from "fs";
import * as path from "path";

export interface RecoveryStage {
  id: string;
  progress: () => { status: string; message: string };
  start: () => Promise<unknown>;
  onDiagnostic?: (
    event: "blocked" | "start" | "yield" | "complete" | "error",
    details: Record<string, unknown>,
  ) => void;
  ready: () => boolean;
  unresolvedWork?: () => string | null;
  needsInitialCheck?: boolean;
  /** Recheck a transient startup stage once for each new process. */
  checkOnStartup?: boolean;
  lane?: "clip" | "analysis" | "disk" | "light" | "background";
  /** Maximum uninterrupted background turn before a runnable peer gets a turn. */
  sliceMs?: number;
  /** Called at a slice boundary before the scheduler decides whether to yield. */
  onTimeSlice?: () => void;
  blockedReason?: () => string;
  pause?: () => Promise<unknown> | unknown;
  resume?: () => Promise<unknown> | unknown;
}

interface RecoveryRecord {
  attempts: number;
  error: string;
  retryAt: number;
  running: boolean;
  checked: boolean;
  userPaused: boolean;
}

export class IndexingRecovery {
  private records = new Map<string, RecoveryRecord>();
  private reportedBlockedReasons = new Map<string, string>();
  private stopped = false;
  private tickRunning = false;
  private activeLanes = new Set<string>();
  private fairYieldedStages = new Set<string>();
  private fairRequested = new Set<string>();
  private readonly fairnessQueue: string[];
  private requested = new Set<string>();
  private persistenceError = "";
  private externalBlockReason = "";
  private readonly externalBlockReasons = new Map<string, string>();
  private nextExternalBlockId = 0;
  private interactiveSearchActive = false;
  private searchPausedStages = new Set<string>();
  private priorityPausedStages = new Set<string>();
  private searchTransition: Promise<void> = Promise.resolve();
  constructor(
    private stages: RecoveryStage[],
    private now = Date.now,
    private statePath?: string,
  ) {
    this.fairnessQueue = stages.map((stage) => stage.id);
    this.restore();
  }

  private restore() {
    if (!this.statePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (saved?.version !== 1) return;
      const stageIds = new Set(this.stages.map((stage) => stage.id));
      for (const [id, value] of Object.entries(saved.records ?? {})) {
        const record = value as Partial<RecoveryRecord>;
        if (
          !stageIds.has(id) ||
          !Number.isInteger(record.attempts) ||
          (record.attempts as number) < 0 ||
          typeof record.error !== "string" ||
          !Number.isFinite(record.retryAt) ||
          typeof record.running !== "boolean" ||
          typeof record.checked !== "boolean" ||
          (record.userPaused !== undefined &&
            typeof record.userPaused !== "boolean")
        )
          continue;
        const restored: RecoveryRecord = {
          attempts: record.attempts as number,
          error: record.error,
          retryAt: record.retryAt as number,
          running: false,
          checked: record.checked,
          userPaused: record.userPaused === true,
        };
        if (record.running) {
          restored.checked = false;
          if (!restored.userPaused) {
            restored.error = "Processing was interrupted and is ready to resume.";
            restored.retryAt = this.now();
            this.requested.add(id);
          }
        }
        this.records.set(id, restored);
      }
      for (const stage of this.stages) {
        if (!stage.checkOnStartup) continue;
        const record = this.records.get(stage.id);
        if (!record || record.userPaused) continue;
        record.checked = false;
        record.error = "";
        record.retryAt = 0;
      }
      for (const id of Array.isArray(saved.requested) ? saved.requested : [])
        if (typeof id === "string" && stageIds.has(id)) {
          if (!this.records.get(id)?.userPaused) this.requested.add(id);
        }
    } catch {
      this.records.clear();
      this.requested.clear();
      this.persistenceError =
        "Saved indexing recovery state could not be read; fresh recovery state is in use.";
    }
  }

  private persist() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.tmp`;
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify({
          version: 1,
          records: Object.fromEntries(this.records),
          requested: Array.from(this.requested),
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      fs.renameSync(temporaryPath, this.statePath);
      this.persistenceError = "";
    } catch (error) {
      this.persistenceError =
        error instanceof Error ? error.message : String(error);
      console.error("[IndexingRecovery] Retry state could not be saved", error);
    }
  }

  private report(
    stage: RecoveryStage,
    event: "blocked" | "start" | "yield" | "complete" | "error",
    details: Record<string, unknown>,
  ) {
    try {
      stage.onDiagnostic?.(event, details);
    } catch {
      // Diagnostic callbacks must never interrupt recovery.
    }
  }

  private reportBlocked(stage: RecoveryStage, reason: string) {
    if (!stage.onDiagnostic || this.reportedBlockedReasons.get(stage.id) === reason)
      return;
    this.reportedBlockedReasons.set(stage.id, reason);
    this.report(stage, "blocked", { reason });
  }

  details(id: string) {
    const record = this.records.get(id);
    const stage = this.stages.find((item) => item.id === id);
    const blocker =
      this.externalBlockReason ||
      (this.interactiveSearchActive && stage?.id !== "semantic-runtime"
        ? "Waiting for interactive search to finish."
        : "") ||
      (stage && !stage.ready()
        ? stage.blockedReason?.() ||
          "Waiting for another active index to release resources."
        : stage?.lane && this.activeLanes.has(stage.lane) && !record?.running
          ? `Waiting for the ${stage.lane} processing lane.`
          : "");
    return {
      attempts: record?.attempts ?? 0,
      recoveryError: record?.error ?? "",
      retryAt: record?.retryAt ?? 0,
      retryExhausted: (record?.attempts ?? 0) >= 3 && Boolean(record?.error),
      resumeQueued: this.requested.has(id) || this.fairRequested.has(id),
      recoveryRunning: record?.running ?? false,
      userPaused: record?.userPaused ?? false,
      canPause: Boolean(stage?.pause),
      blockedReason: blocker,
      persistenceError: this.persistenceError,
    };
  }

  stop() {
    this.stopped = true;
  }

  async setBlocked(reason: string | null) {
    if (reason) this.externalBlockReasons.set("index-storage", reason);
    else this.externalBlockReasons.delete("index-storage");
    await this.refreshExternalBlock();
  }

  /** Add a temporary independent hold without clearing storage or other holds. */
  async acquireBlock(reason: string): Promise<() => Promise<void>> {
    const id = `temporary-${++this.nextExternalBlockId}`;
    this.externalBlockReasons.set(id, reason);
    try {
      await this.refreshExternalBlock(true);
    } catch (error) {
      this.externalBlockReasons.delete(id);
      await this.refreshExternalBlock().catch((refreshError) => {
        console.error("[IndexingRecovery] Could not restore processing after a failed temporary hold", refreshError);
      });
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.externalBlockReasons.delete(id);
      await this.refreshExternalBlock();
    };
  }

  private async refreshExternalBlock(requireSuccessfulPause = false) {
    const wasBlocked = Boolean(this.externalBlockReason);
    this.externalBlockReason = Array.from(this.externalBlockReasons.values()).join(" · ");
    if (this.externalBlockReason) {
      if (!wasBlocked || requireSuccessfulPause)
        await this.pauseActiveStages(new Set(), false, requireSuccessfulPause);
      this.persist();
      return;
    }
    if (wasBlocked) await this.tick();
  }

  setSearchActive(active: boolean): Promise<void> {
    this.interactiveSearchActive = active;
    this.searchTransition = this.searchTransition.catch(() => undefined).then(async () => {
      if (active) {
        if (!this.interactiveSearchActive) return;
        // Search indexing and audio inventory yield at their own batch boundaries.
        await this.pauseActiveStages(new Set(["search", "audio"]), true);
        this.persist();
        return;
      }
      if (this.interactiveSearchActive) return;
      if (this.externalBlockReason) {
        this.searchPausedStages.clear();
        return;
      }
      for (const id of this.searchPausedStages) {
        const stage = this.stages.find((item) => item.id === id);
        if (!stage?.resume) continue;
        try {
          await stage.resume();
        } catch (error) {
          console.error(`[IndexingRecovery] Could not resume ${id}`, error);
        }
      }
      this.searchPausedStages.clear();
      await this.tick();
    });
    return this.searchTransition;
  }

  private async pauseActiveStages(
    excludedIds = new Set<string>(),
    rememberForSearch = false,
    requireSuccessfulPause = false,
  ) {
    const busyStatuses = new Set([
      "scanning",
      "indexing",
      "loading-model",
      "clustering",
      "generating",
    ]);
    const activeStages = this.stages.filter(
      (stage) =>
        !excludedIds.has(stage.id) &&
        (!rememberForSearch || Boolean(stage.pause)) &&
        (busyStatuses.has(stage.progress().status) ||
          this.records.get(stage.id)?.running === true),
    );
    const pauses: Promise<void>[] = [];
    const failures: string[] = [];
    for (const stage of activeStages) {
      const record = this.records.get(stage.id) ?? {
        attempts: 0,
        error: "",
        retryAt: 0,
        running: false,
        checked: false,
        userPaused: false,
      };
      if (!record.userPaused) {
        record.checked = false;
        record.error = "";
        record.retryAt = 0;
        this.records.set(stage.id, record);
        this.requested.add(stage.id);
        if (rememberForSearch && stage.pause)
          this.searchPausedStages.add(stage.id);
      }
      if (!stage.pause) continue;
      pauses.push(
        Promise.resolve()
          .then(() => stage.pause!())
          .then(() => undefined)
          .catch((error) => {
            console.error(`[IndexingRecovery] Could not pause ${stage.id}`, error);
            failures.push(stage.id);
          }),
      );
    }
    await Promise.all(pauses);
    if (requireSuccessfulPause && failures.length)
      throw new Error(`Could not safely pause these background tasks: ${failures.join(", ")}.`);
  }

  pause(id: string) {
    if (!this.stages.some((stage) => stage.id === id))
      throw new Error("This index does not support recovery.");
    const record = this.records.get(id) ?? {
      attempts: 0,
      error: "",
      retryAt: 0,
      running: false,
      checked: false,
      userPaused: false,
    };
    record.userPaused = true;
    record.checked = false;
    record.error = "";
    record.retryAt = 0;
    this.records.set(id, record);
    this.requested.delete(id);
    this.fairRequested.delete(id);
    this.persist();
  }

  async pauseStage(id: string) {
    const stage = this.stages.find((item) => item.id === id);
    if (!stage?.pause)
      throw new Error("This index cannot be paused safely.");
    this.pause(id);
    try {
      await stage.pause();
      this.persist();
    } catch (error) {
      const record = this.records.get(id);
      if (record) {
        record.userPaused = false;
        record.checked = false;
        record.error = `Pause failed: ${error instanceof Error ? error.message : String(error)}`;
        record.retryAt = this.now();
        this.requested.add(id);
      }
      this.persist();
      void this.tick();
      throw error;
    }
  }

  clearUserPause(id: string) {
    const record = this.records.get(id);
    if (!record || !record.userPaused) return;
    record.userPaused = false;
    record.checked = false;
    record.attempts = 0;
    record.error = "";
    record.retryAt = 0;
    this.requested.delete(id);
    this.fairRequested.delete(id);
    this.persist();
  }

  async requestWithPriority(id: string, pauseIds: string[] = []) {
    if (this.stopped)
      throw new Error("Silo is shutting down. Reopen it to resume indexing.");
    if (!this.stages.some((item) => item.id === id))
      throw new Error("This index does not support recovery.");
    const target = this.records.get(id);
    if (target?.userPaused) return;

    const stagesToPause: RecoveryStage[] = [];
    for (const pauseId of pauseIds) {
      const stage = this.stages.find((item) => item.id === pauseId);
      const record = this.records.get(pauseId);
      if (!stage?.pause || record?.userPaused) continue;
      if (this.priorityPausedStages.has(pauseId)) continue;
      if (
        !["scanning", "indexing", "loading-model", "clustering", "generating"].includes(
          stage.progress().status,
        )
      )
        continue;
      const priorityRecord = record ?? {
        attempts: 0,
        error: "",
        retryAt: 0,
        running: false,
        checked: false,
        userPaused: false,
      };
      priorityRecord.checked = false;
      priorityRecord.error = "";
      priorityRecord.retryAt = 0;
      this.records.set(pauseId, priorityRecord);
      this.priorityPausedStages.add(pauseId);
      stagesToPause.push(stage);
    }
    this.persist();
    // Queue the priority work while the current stage still owns its lane.
    // Once pause() lets that run drain, the scheduler starts search first.
    this.request(id);
    await Promise.all(
      stagesToPause.map(async (stage) => {
        try {
          await stage.pause?.();
        } catch (error) {
          this.priorityPausedStages.delete(stage.id);
          console.error(
            `[IndexingRecovery] Could not yield ${stage.id} to ${id}`,
            error,
          );
        }
      }),
    );
  }

  request(id: string) {
    const stage = this.stages.find((item) => item.id === id);
    if (!stage) throw new Error("This index does not support recovery.");
    if (this.stopped)
      throw new Error("Silo is shutting down. Reopen it to resume indexing.");
    const record = this.records.get(id) ?? {
      attempts: 0,
      error: "",
      retryAt: 0,
      running: false,
      checked: false,
      userPaused: false,
    };
    if (record.userPaused) return;
    record.checked = false;
    record.error = "";
    record.retryAt = 0;
    if (!record.running) record.attempts = 0;
    this.records.set(id, record);
    this.fairRequested.delete(id);
    this.requested.add(id);
    this.persist();
    void this.tick();
  }

  /** Queue progressive work without clearing its retry backoff or user pause. */
  requestFairly(id: string) {
    const stage = this.stages.find((item) => item.id === id);
    if (!stage) return;
    if (this.stopped) return;
    const record = this.records.get(id) ?? {
      attempts: 0,
      error: "",
      retryAt: 0,
      running: false,
      checked: false,
      userPaused: false,
    };
    if (
      record.userPaused ||
      (record.error && record.retryAt > this.now())
    )
      return;
    record.checked = false;
    this.records.set(id, record);
    this.fairRequested.add(id);
    this.persist();
    void this.tick();
  }

  queue(id: string) {
    const stage = this.stages.find((item) => item.id === id);
    if (!stage) throw new Error("This index does not support recovery.");
    if (this.stopped)
      throw new Error("Silo is shutting down. Reopen it to resume indexing.");
    const record = this.records.get(id) ?? {
      attempts: 0,
      error: "",
      retryAt: 0,
      running: false,
      checked: false,
      userPaused: false,
    };
    record.userPaused = false;
    record.checked = false;
    record.error = "";
    record.retryAt = 0;
    if (!record.running) record.attempts = 0;
    this.records.set(id, record);
    this.requested.add(id);
    this.fairRequested.delete(id);
    this.persist();
  }

  async retry(id: string) {
    this.queue(id);
    // Accept immediately even during startup / contention. The scheduler starts
    // the queued request as soon as its dependency and resource lane are ready.
    await this.tick();
  }

  async restart(id: string) {
    const stage = this.stages.find((item) => item.id === id);
    if (!stage) throw new Error("This index does not support recovery.");
    const record = this.records.get(id);
    const active = ["scanning", "indexing", "loading-model", "clustering", "generating"]
      .includes(stage.progress().status) || Boolean(record?.running);
    if (active) {
      if (!stage.pause)
        throw new Error("This index cannot be stopped safely while it is running.");
      await this.pauseStage(id);
    }
    await this.retry(id);
  }

  async tick() {
    if (
      this.stopped ||
      this.externalBlockReason ||
      this.tickRunning
    )
      return;
    this.tickRunning = true;
    try {
      const ordered = [...this.stages].sort((first, second) => {
        const requestedDifference =
          Number(this.requested.has(second.id)) -
          Number(this.requested.has(first.id));
        if (requestedDifference) return requestedDifference;
        return (
          this.fairnessQueue.indexOf(first.id) -
          this.fairnessQueue.indexOf(second.id)
        );
      });
      for (const stage of ordered) {
        if (this.stopped) continue;
        if (this.externalBlockReason) {
          this.reportBlocked(stage, this.externalBlockReason);
          continue;
        }
        if (this.interactiveSearchActive && stage.id !== "semantic-runtime") {
          this.reportBlocked(stage, "Waiting for interactive search to finish.");
          continue;
        }
        if (!stage.ready()) {
          this.reportBlocked(
            stage,
            stage.blockedReason?.() || "Waiting for another active index to release resources.",
          );
          continue;
        }
        const progress = stage.progress();
        const record = this.records.get(stage.id);
        const interrupted =
          progress.status === "paused" && /interrupted/i.test(progress.message);
        const manuallyRequested = this.requested.has(stage.id);
        const needed =
          manuallyRequested ||
          this.fairRequested.has(stage.id) ||
          interrupted ||
          (progress.status === "paused" && !record?.userPaused) ||
          progress.status === "error" ||
          Boolean(record?.error) ||
          (stage.needsInitialCheck && !record?.checked);
        if (
          !needed ||
          record?.running ||
          (!manuallyRequested && (record?.retryAt ?? 0) > this.now())
        )
          continue;
        if (stage.lane && this.activeLanes.has(stage.lane)) {
          this.reportBlocked(stage, `Waiting for the ${stage.lane} processing lane.`);
          continue;
        }
        if (record && record.attempts >= 3 && record.retryAt <= this.now())
          record.attempts = 0;
        if (record?.userPaused && !manuallyRequested) continue;
        this.requested.delete(stage.id);
        this.fairRequested.delete(stage.id);
        this.reportedBlockedReasons.delete(stage.id);
        this.rotateFairness(stage);
        // Reserve the lane immediately; independent lanes can proceed.
        void this.run(stage);
      }
    } finally {
      this.tickRunning = false;
    }
  }

  private rotateFairness(stage: RecoveryStage) {
    if (this.fairnessQueue.length < 2) return;
    const index = this.fairnessQueue.indexOf(stage.id);
    if (index < 0) return;
    this.fairnessQueue.splice(index, 1);
    this.fairnessQueue.push(stage.id);
  }

  private hasRunnablePeer(stage: RecoveryStage) {
    if (!stage.lane) return false;
    const busyStatuses = new Set([
      "scanning",
      "indexing",
      "loading-model",
      "clustering",
      "generating",
    ]);
    return this.stages.some((candidate) => {
      if (candidate.id === stage.id || candidate.lane !== stage.lane) return false;
      const record = this.records.get(candidate.id);
      if (record?.running || record?.userPaused) return false;
      const progress = candidate.progress();
      const needed =
        this.requested.has(candidate.id) ||
        this.fairRequested.has(candidate.id) ||
        (progress.status === "paused" && !record?.userPaused) ||
        progress.status === "error" ||
        Boolean(record?.error) ||
        (candidate.needsInitialCheck && !record?.checked);
      return (
        needed &&
        (record?.retryAt ?? 0) <= this.now() &&
        !busyStatuses.has(progress.status) &&
        candidate.ready()
      );
    });
  }

  private async yieldForRunnablePeer(stage: RecoveryStage) {
    const record = this.records.get(stage.id);
    if (
      this.stopped ||
      !record?.running ||
      record.userPaused ||
      this.externalBlockReason ||
      this.interactiveSearchActive
    )
      return false;
    try {
      stage.onTimeSlice?.();
    } catch (error) {
      console.error(`[IndexingRecovery] Slice callback failed for ${stage.id}`, error);
    }
    if (!this.hasRunnablePeer(stage)) return false;
    this.fairYieldedStages.add(stage.id);
    this.report(stage, "yield", { lane: stage.lane, sliceMs: stage.sliceMs });
    try {
      await stage.pause?.();
      return true;
    } catch (error) {
      this.fairYieldedStages.delete(stage.id);
      console.error(`[IndexingRecovery] Could not yield ${stage.id}`, error);
      return false;
    }
  }

  private async run(stage: RecoveryStage) {
    const record = this.records.get(stage.id) ?? {
      attempts: 0,
      error: "",
      retryAt: 0,
      running: false,
      checked: false,
      userPaused: false,
    };
    record.running = true;
    if (stage.lane) this.activeLanes.add(stage.lane);
    record.attempts += 1;
    this.records.set(stage.id, record);
    this.report(stage, "start", { attempt: record.attempts });
    let sliceTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSlice = () => {
      if (!stage.sliceMs || !stage.pause || this.stopped) return;
      sliceTimer = setTimeout(() => {
        sliceTimer = undefined;
        void this.yieldForRunnablePeer(stage).then((yielded) => {
          if (!yielded && record.running) scheduleSlice();
        });
      }, stage.sliceMs);
    };
    try {
      this.persist();
      scheduleSlice();
      await stage.start();
      const progress = stage.progress();
      if (progress.status === "error") throw new Error(progress.message);
      if (progress.status === "paused") {
        const fairlyYielded = this.fairYieldedStages.delete(stage.id);
        if (fairlyYielded && !record.userPaused) {
          record.checked = false;
          record.error = "";
          record.retryAt = 0;
          record.attempts = Math.max(0, record.attempts - 1);
          this.persist();
          return;
        }
        const priorityPaused = this.priorityPausedStages.delete(stage.id);
        if (priorityPaused && !record.userPaused) {
          record.checked = false;
          record.error = "";
          record.retryAt = 0;
          this.requested.add(stage.id);
          this.persist();
          return;
        }
        if (!record.userPaused)
          if (
            this.externalBlockReason ||
            this.interactiveSearchActive ||
            this.searchPausedStages.has(stage.id)
          ) {
            record.checked = false;
            record.error = "";
            record.retryAt = 0;
            this.requested.add(stage.id);
            this.persist();
            return;
          } else {
            throw new Error(progress.message || "Indexing paused before completion.");
          }
        record.checked = false;
        record.error = "";
        record.retryAt = 0;
        return;
      }
      const unresolved = stage.unresolvedWork?.();
      if (unresolved) throw new Error(unresolved);
      record.checked = true;
      record.error = "";
      record.attempts = 0;
      record.retryAt = 0;
      this.report(stage, "complete", { status: progress.status });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.retryAt =
        this.now() +
        (record.attempts >= 3 ? 5 * 60000 : 10000 * 2 ** (record.attempts - 1));
      this.report(stage, "error", {
        attempt: record.attempts,
        retryAt: record.retryAt,
        message: record.error,
      });
    } finally {
      if (sliceTimer) clearTimeout(sliceTimer);
      this.fairYieldedStages.delete(stage.id);
      this.priorityPausedStages.delete(stage.id);
      record.running = false;
      if (stage.lane) this.activeLanes.delete(stage.lane);
      this.persist();
      setImmediate(() => void this.tick());
    }
  }
}
