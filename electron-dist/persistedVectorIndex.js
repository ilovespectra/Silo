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
exports.PersistedVectorIndex = void 0;
const worker_threads_1 = require("worker_threads");
const path = __importStar(require("path"));
class PersistedVectorIndex {
    constructor(vectorsPath, cacheDirectory, onProgress, onError, settings) {
        this.vectorsPath = vectorsPath;
        this.cacheDirectory = cacheDirectory;
        this.onProgress = onProgress;
        this.onError = onError;
        this.settings = settings;
        this.nextRequestId = 0;
        this.pending = new Map();
        this.failed = false;
        this.readySettled = false;
        this.closing = false;
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.worker = new worker_threads_1.Worker(path.join(__dirname, "searchVectorIndexWorker.js"));
        this.worker.on("message", (message) => {
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
                const pending = this.pending.get(message.requestId);
                if (!pending)
                    return;
                this.pending.delete(message.requestId);
                if (message.error)
                    pending.reject(new Error(message.error));
                else
                    pending.resolve(message.hits ?? undefined);
            }
        });
        this.worker.on("error", (cause) => this.fail(cause instanceof Error ? cause : new Error(String(cause))));
        this.worker.on("exit", (code) => {
            if (code !== 0 && !this.failed && !this.closing)
                this.fail(new Error(`The local search worker exited with code ${code}.`));
        });
    }
    initialize(groups) {
        const transferList = [];
        for (const group of groups)
            transferList.push(group.keys.buffer);
        this.worker.postMessage({
            type: "initialize",
            vectorsPath: this.vectorsPath,
            cacheDirectory: this.cacheDirectory,
            settings: this.settings,
            groups,
        }, transferList);
        return this.ready;
    }
    async search(sourcePaths, imageQuery, documentQuery, limit) {
        await this.ready;
        return (await this.request({
            type: "search",
            sourcePaths,
            imageQuery,
            documentQuery,
            limit,
        }));
    }
    setPaused(paused) {
        if (this.failed)
            return;
        this.worker.postMessage({ type: paused ? "pause" : "resume" });
    }
    updateSettings(settings) {
        if (this.failed)
            return;
        this.settings = { ...settings };
        this.worker.postMessage({ type: "set-settings", settings: this.settings });
    }
    upsert(sourcePath, kind, key) {
        if (this.failed)
            return;
        this.worker.postMessage({ type: "upsert", sourcePath, kind, key });
    }
    remove(sourcePath, kind, key) {
        if (this.failed)
            return;
        this.worker.postMessage({ type: "remove", sourcePath, kind, key });
    }
    async shutdown(timeoutMs) {
        if (this.failed || this.closing)
            return;
        this.closing = true;
        if (!this.readySettled) {
            await this.worker.terminate();
            return;
        }
        let timeout = null;
        try {
            await Promise.race([
                this.request({ type: "flush" }),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("Timed out saving the local search index.")), timeoutMs);
                }),
            ]);
        }
        catch {
            // A later launch reconciles unsaved vector additions from the saved records.
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            await this.worker.terminate();
        }
    }
    request(message) {
        if (this.failed)
            return Promise.reject(new Error("The local search index is unavailable."));
        const requestId = ++this.nextRequestId;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            this.worker.postMessage({ ...message, requestId });
        });
    }
    fail(error) {
        if (this.failed || this.closing)
            return;
        this.failed = true;
        this.readySettled = true;
        this.rejectReady(error);
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
        this.onError(error);
    }
}
exports.PersistedVectorIndex = PersistedVectorIndex;
