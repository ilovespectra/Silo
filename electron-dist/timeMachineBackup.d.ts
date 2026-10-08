type TimeMachineCommandRunner = (executable: string, args: string[]) => Promise<unknown>;
export declare function startConfiguredTimeMachineBackup(sourcePath: string, sourceRegistered: boolean, options?: {
    platform?: string;
    runCommand?: TimeMachineCommandRunner;
}): Promise<void>;
export {};
