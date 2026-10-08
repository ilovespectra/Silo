"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProgressThrottle = void 0;
const defaultScheduler = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
};
/** Coalesces frequent progress updates while forwarding every stage transition immediately. */
function createProgressThrottle(send, intervalMs = 250, scheduler = defaultScheduler) {
    let lastSentAt = 0;
    let lastStatus = null;
    let pending = null;
    let timer = null;
    const deliver = () => {
        timer = null;
        const progress = pending;
        pending = null;
        if (!progress)
            return;
        lastSentAt = scheduler.now();
        lastStatus = progress.status;
        send(progress);
    };
    return (progress) => {
        pending = progress;
        const waitMs = intervalMs - (scheduler.now() - lastSentAt);
        if (progress.status !== lastStatus || waitMs <= 0) {
            if (timer !== null)
                scheduler.clearTimeout(timer);
            deliver();
            return;
        }
        if (timer === null)
            timer = scheduler.setTimeout(deliver, waitMs);
    };
}
exports.createProgressThrottle = createProgressThrottle;
