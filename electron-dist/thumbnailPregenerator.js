"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThumbnailPregenerator = void 0;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const CONCURRENCY = 2;
const PROGRESS_INTERVAL_MS = 500;
class ThumbnailPregenerator {
    constructor(deps) {
        this.deps = deps;
        this.progress = {
            status: "idle",
            total: 0,
            processed: 0,
            generated: 0,
            failed: 0,
            message: "Thumbnails are generated after indexing finishes.",
        };
        this.runPromise = null;
        this.rerunRequested = false;
        this.lastEmit = 0;
    }
    getProgress() {
        return { ...this.progress };
    }
    setWaiting(message) {
        if (this.runPromise)
            return;
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
    async run() {
        this.update({
            status: "scanning",
            total: 0,
            processed: 0,
            generated: 0,
            failed: 0,
            message: "Finding photos and videos…",
        }, true);
        try {
            const files = [];
            for (const root of new Set(await this.deps.getSourceRoots()))
                await this.collect(root, files);
            this.update({
                status: "generating",
                total: files.length,
                message: "Generating thumbnails…",
            }, true);
            let next = 0;
            const worker = async () => {
                while (next < files.length) {
                    const filePath = files[next++];
                    let waitMessage = this.deps.getIndexingWaitMessage();
                    while (waitMessage) {
                        if (this.progress.status !== "waiting" ||
                            this.progress.message !== waitMessage)
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
                    if (ok)
                        this.progress.generated += 1;
                    else
                        this.progress.failed += 1;
                    this.update({});
                }
            };
            await Promise.all(Array.from({ length: CONCURRENCY }, worker));
            this.update({
                status: "complete",
                message: `${this.progress.generated.toLocaleString()} thumbnails ready${this.progress.failed ? ` · ${this.progress.failed.toLocaleString()} unavailable` : ""}.`,
            }, true);
        }
        catch (error) {
            this.update({
                status: "error",
                message: error instanceof Error ? error.message : String(error),
            }, true);
        }
    }
    // Iterative walk keeps memory flat on very large libraries.
    async collect(root, files) {
        if (this.deps.isRemotePath(root)) {
            files.push(...(await this.deps.listRemoteMediaFiles(root)));
            return;
        }
        const stack = [root];
        while (stack.length > 0) {
            const directory = stack.pop();
            let handle;
            try {
                handle = await fs_1.promises.opendir(directory);
            }
            catch {
                continue;
            }
            for await (const entry of handle) {
                if (entry.name.startsWith("."))
                    continue;
                const fullPath = path_1.default.join(directory, entry.name);
                if (entry.isDirectory())
                    stack.push(fullPath);
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
    update(patch, force = false) {
        this.progress = { ...this.progress, ...patch };
        const now = Date.now();
        if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS)
            return;
        this.lastEmit = now;
        this.deps.onProgress(this.getProgress());
    }
}
exports.ThumbnailPregenerator = ThumbnailPregenerator;
