export declare class RendererRecovery {
    private now;
    private failures;
    constructor(now?: () => number);
    plan(reason: string, shuttingDown: boolean): {
        restart: boolean;
        delay: number;
        manual: boolean;
    };
}
