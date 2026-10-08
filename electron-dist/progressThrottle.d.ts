export interface StatusProgress {
    status: string;
}
interface Scheduler {
    now: () => number;
    setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}
/** Coalesces frequent progress updates while forwarding every stage transition immediately. */
export declare function createProgressThrottle<T extends StatusProgress>(send: (progress: T) => void, intervalMs?: number, scheduler?: Scheduler): (progress: T) => void;
export {};
