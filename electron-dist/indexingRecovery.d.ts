export interface RecoveryStage {
    id: string;
    progress: () => {
        status: string;
        message: string;
    };
    start: () => Promise<unknown>;
    ready: () => boolean;
    unresolvedWork?: () => string | null;
    needsInitialCheck?: boolean;
    lane?: "analysis" | "disk" | "light" | "background";
    blockedReason?: () => string;
    pause?: () => Promise<unknown> | unknown;
    resume?: () => Promise<unknown> | unknown;
}
export declare class IndexingRecovery {
    private stages;
    private now;
    private statePath?;
    private records;
    private stopped;
    private tickRunning;
    private activeLanes;
    private requested;
    private persistenceError;
    private externalBlockReason;
    private interactiveSearchActive;
    private searchPausedStages;
    private searchTransition;
    constructor(stages: RecoveryStage[], now?: () => number, statePath?: string | undefined);
    private restore;
    private persist;
    details(id: string): {
        attempts: number;
        recoveryError: string;
        retryAt: number;
        retryExhausted: boolean;
        resumeQueued: boolean;
        recoveryRunning: boolean;
        userPaused: boolean;
        blockedReason: string;
        persistenceError: string;
    };
    stop(): void;
    setBlocked(reason: string | null): Promise<void>;
    setSearchActive(active: boolean): Promise<void>;
    private pauseActiveStages;
    pause(id: string): void;
    clearUserPause(id: string): void;
    request(id: string): void;
    queue(id: string): void;
    retry(id: string): Promise<void>;
    tick(): Promise<void>;
    private run;
}
