"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RendererRecovery = void 0;
class RendererRecovery {
    constructor(now = Date.now) {
        this.now = now;
        this.failures = [];
    }
    plan(reason, shuttingDown) {
        if (shuttingDown || reason === "clean-exit")
            return { restart: false, delay: 0, manual: false };
        this.failures = this.failures.filter((time) => this.now() - time < 5 * 60000);
        this.failures.push(this.now());
        if (this.failures.length > 2 || reason === "oom")
            return { restart: false, delay: 0, manual: true };
        return {
            restart: true,
            delay: this.failures.length === 1 ? 1000 : 5000,
            manual: false,
        };
    }
}
exports.RendererRecovery = RendererRecovery;
