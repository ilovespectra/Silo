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
exports.HeapGuard = exports.defaultCollect = exports.defaultHeapSample = void 0;
const v8 = __importStar(require("v8"));
function defaultHeapSample() {
    const stats = v8.getHeapStatistics();
    return { used: stats.used_heap_size, limit: stats.heap_size_limit };
}
exports.defaultHeapSample = defaultHeapSample;
function defaultCollect() {
    const gc = globalThis.gc;
    if (typeof gc === "function")
        gc();
}
exports.defaultCollect = defaultCollect;
class HeapGuard {
    constructor(options) {
        this.options = options;
        this.underPressure = false;
        this.belowSince = null;
        this.busy = false;
        this.highRatio = options.highRatio ?? 0.7;
        this.lowRatio = options.lowRatio ?? 0.45;
        this.settleMs = options.settleMs ?? 20000;
        this.sample = options.sample ?? defaultHeapSample;
        this.now = options.now ?? Date.now;
        this.collect = options.collect ?? defaultCollect;
    }
    isUnderPressure() {
        return this.underPressure;
    }
    async tick() {
        if (this.busy)
            return;
        this.busy = true;
        try {
            let current = this.sample();
            const ratio = () => (current.limit > 0 ? current.used / current.limit : 0);
            if (!this.underPressure) {
                if (ratio() < this.highRatio)
                    return;
                // A full collection may resolve transient garbage without pausing work.
                this.collect();
                current = this.sample();
                if (ratio() < this.highRatio)
                    return;
                this.underPressure = true;
                this.belowSince = null;
                await this.options.onPressure(current);
                this.collect();
                return;
            }
            if (ratio() >= this.lowRatio) {
                this.belowSince = null;
                this.collect();
                return;
            }
            this.belowSince ?? (this.belowSince = this.now());
            if (this.now() - this.belowSince < this.settleMs)
                return;
            this.underPressure = false;
            this.belowSince = null;
            await this.options.onRelief(current);
        }
        finally {
            this.busy = false;
        }
    }
}
exports.HeapGuard = HeapGuard;
