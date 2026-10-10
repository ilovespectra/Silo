"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IndexingRecovery = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class IndexingRecovery {
    constructor(stages, now = Date.now, statePath) {
        this.stages = stages;
        this.now = now;
        this.statePath = statePath;
        this.records = new Map();
        this.stopped = false;
        this.tickRunning = false;
        this.activeLanes = new Set();
        this.requested = new Set();
        this.persistenceError = "";
        this.externalBlockReason = "";
        this.interactiveSearchActive = false;
        this.searchPausedStages = new Set();
        this.searchTransition = Promise.resolve();
        this.restore();
    }
    restore() {
        if (!this.statePath)
            return;
        try {
            const saved = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
            if (saved?.version !== 1)
                return;
            const stageIds = new Set(this.stages.map((stage) => stage.id));
            for (const [id, value] of Object.entries(saved.records ?? {})) {
                const record = value;
                if (!stageIds.has(id) ||
                    !Number.isInteger(record.attempts) ||
                    record.attempts < 0 ||
                    typeof record.error !== "string" ||
                    !Number.isFinite(record.retryAt) ||
                    typeof record.running !== "boolean" ||
                    typeof record.checked !== "boolean" ||
                    (record.userPaused !== undefined &&
                        typeof record.userPaused !== "boolean"))
                    continue;
                const restored = {
                    attempts: record.attempts,
                    error: record.error,
                    retryAt: record.retryAt,
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
            for (const id of Array.isArray(saved.requested) ? saved.requested : [])
                if (typeof id === "string" && stageIds.has(id)) {
                    if (!this.records.get(id)?.userPaused)
                        this.requested.add(id);
                }
        }
        catch {
            this.records.clear();
            this.requested.clear();
        }
    }
    persist() {
        if (!this.statePath)
            return;
        try {
            fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
            const temporaryPath = `${this.statePath}.tmp`;
            fs.writeFileSync(temporaryPath, JSON.stringify({
                version: 1,
                records: Object.fromEntries(this.records),
                requested: Array.from(this.requested),
            }), { encoding: "utf8", mode: 0o600 });
            fs.renameSync(temporaryPath, this.statePath);
            this.persistenceError = "";
        }
        catch (error) {
            this.persistenceError =
                error instanceof Error ? error.message : String(error);
            console.error("[IndexingRecovery] Retry state could not be saved", error);
        }
    }
    details(id) {
        const record = this.records.get(id);
        const stage = this.stages.find((item) => item.id === id);
        const blocker = this.externalBlockReason ||
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
            resumeQueued: this.requested.has(id),
            recoveryRunning: record?.running ?? false,
            userPaused: record?.userPaused ?? false,
            blockedReason: blocker,
            persistenceError: this.persistenceError,
        };
    }
    stop() {
        this.stopped = true;
    }
    async setBlocked(reason) {
        this.externalBlockReason = reason ?? "";
        if (this.externalBlockReason) {
            await this.pauseActiveStages();
            this.persist();
            return;
        }
        await this.tick();
    }
    setSearchActive(active) {
        this.interactiveSearchActive = active;
        this.searchTransition = this.searchTransition.catch(() => undefined).then(async () => {
            if (active) {
                if (!this.interactiveSearchActive)
                    return;
                // Search indexing and audio inventory yield at their own batch boundaries.
                await this.pauseActiveStages(new Set(["search", "audio"]), true);
                this.persist();
                return;
            }
            if (this.interactiveSearchActive)
                return;
            if (this.externalBlockReason) {
                this.searchPausedStages.clear();
                return;
            }
            for (const id of this.searchPausedStages) {
                const stage = this.stages.find((item) => item.id === id);
                if (!stage?.resume)
                    continue;
                try {
                    await stage.resume();
                }
                catch (error) {
                    console.error(`[IndexingRecovery] Could not resume ${id}`, error);
                }
            }
            this.searchPausedStages.clear();
            await this.tick();
        });
        return this.searchTransition;
    }
    async pauseActiveStages(excludedIds = new Set(), rememberForSearch = false) {
        const busyStatuses = new Set([
            "scanning",
            "indexing",
            "loading-model",
            "clustering",
            "generating",
        ]);
        const activeStages = this.stages.filter((stage) => !excludedIds.has(stage.id) &&
            (!rememberForSearch || Boolean(stage.pause)) &&
            busyStatuses.has(stage.progress().status));
        const pauses = [];
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
            if (!stage.pause)
                continue;
            pauses.push(Promise.resolve()
                .then(() => stage.pause())
                .then(() => undefined)
                .catch((error) => {
                console.error(`[IndexingRecovery] Could not pause ${stage.id}`, error);
            }));
        }
        await Promise.all(pauses);
    }
    pause(id) {
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
        this.persist();
    }
    clearUserPause(id) {
        const record = this.records.get(id);
        if (!record || !record.userPaused)
            return;
        record.userPaused = false;
        record.checked = false;
        record.attempts = 0;
        record.error = "";
        record.retryAt = 0;
        this.requested.delete(id);
        this.persist();
    }
    request(id) {
        const stage = this.stages.find((item) => item.id === id);
        if (!stage)
            throw new Error("This index does not support recovery.");
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
        if (record.userPaused)
            return;
        record.checked = false;
        record.error = "";
        record.retryAt = 0;
        if (!record.running)
            record.attempts = 0;
        this.records.set(id, record);
        this.requested.add(id);
        this.persist();
        void this.tick();
    }
    queue(id) {
        const stage = this.stages.find((item) => item.id === id);
        if (!stage)
            throw new Error("This index does not support recovery.");
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
        if (!record.running)
            record.attempts = 0;
        this.records.set(id, record);
        this.requested.add(id);
        this.persist();
    }
    async retry(id) {
        this.queue(id);
        // Accept immediately even during startup / contention. The scheduler starts
        // the queued request as soon as its dependency and resource lane are ready.
        await this.tick();
    }
    async tick() {
        if (this.stopped ||
            this.externalBlockReason ||
            this.tickRunning)
            return;
        this.tickRunning = true;
        try {
            const ordered = [...this.stages].sort((first, second) => Number(this.requested.has(second.id)) -
                Number(this.requested.has(first.id)) ||
                Number(second.id === "search") - Number(first.id === "search"));
            for (const stage of ordered) {
                if (this.stopped ||
                    this.externalBlockReason ||
                    (this.interactiveSearchActive && stage.id !== "semantic-runtime") ||
                    !stage.ready())
                    continue;
                const progress = stage.progress();
                const record = this.records.get(stage.id);
                const interrupted = progress.status === "paused" && /interrupted/i.test(progress.message);
                const manuallyRequested = this.requested.has(stage.id);
                const needed = manuallyRequested ||
                    interrupted ||
                    (progress.status === "paused" && !record?.userPaused) ||
                    progress.status === "error" ||
                    Boolean(record?.error) ||
                    (stage.needsInitialCheck && !record?.checked);
                if (!needed ||
                    record?.running ||
                    (!manuallyRequested && (record?.retryAt ?? 0) > this.now()))
                    continue;
                if (stage.lane && this.activeLanes.has(stage.lane))
                    continue;
                if (record && record.attempts >= 3 && record.retryAt <= this.now())
                    record.attempts = 0;
                if (record?.userPaused && !manuallyRequested)
                    continue;
                this.requested.delete(stage.id);
                // Reserve the lane immediately; independent lanes can proceed.
                void this.run(stage);
            }
        }
        finally {
            this.tickRunning = false;
        }
    }
    async run(stage) {
        const record = this.records.get(stage.id) ?? {
            attempts: 0,
            error: "",
            retryAt: 0,
            running: false,
            checked: false,
            userPaused: false,
        };
        record.running = true;
        if (stage.lane)
            this.activeLanes.add(stage.lane);
        record.attempts += 1;
        this.records.set(stage.id, record);
        try {
            this.persist();
            await stage.start();
            const progress = stage.progress();
            if (progress.status === "error")
                throw new Error(progress.message);
            if (progress.status === "paused") {
                if (!record.userPaused)
                    if (this.externalBlockReason ||
                        this.interactiveSearchActive ||
                        this.searchPausedStages.has(stage.id)) {
                        record.checked = false;
                        record.error = "";
                        record.retryAt = 0;
                        this.requested.add(stage.id);
                        this.persist();
                        return;
                    }
                    else {
                        throw new Error(progress.message || "Indexing paused before completion.");
                    }
                record.checked = false;
                record.error = "";
                record.retryAt = 0;
                return;
            }
            const unresolved = stage.unresolvedWork?.();
            if (unresolved)
                throw new Error(unresolved);
            record.checked = true;
            record.error = "";
            record.attempts = 0;
            record.retryAt = 0;
        }
        catch (error) {
            record.error = error instanceof Error ? error.message : String(error);
            record.retryAt =
                this.now() +
                    (record.attempts >= 3 ? 5 * 60000 : 10000 * 2 ** (record.attempts - 1));
        }
        finally {
            record.running = false;
            if (stage.lane)
                this.activeLanes.delete(stage.lane);
            this.persist();
            setImmediate(() => void this.tick());
        }
    }
}
exports.IndexingRecovery = IndexingRecovery;
