export declare const CONFIG_MANIFEST = "silo-config.json";
export interface ConfigManifest {
    format: string;
    version: number;
    exportedAt: number;
    appVersion: string;
    entries: string[];
    rendererPrefs: Record<string, string>;
}
export interface ConfigTransferProgress {
    operation: "export" | "import";
    phase: "preparing" | "copying" | "compressing" | "reading" | "validating" | "complete";
    percent: number | null;
    message: string;
}
export type ConfigTransferProgressReporter = (progress: ConfigTransferProgress) => void;
export declare function exportConfig(userData: string, target: string, appVersion: string, rendererPrefs: Record<string, string>, indexStoragePath?: string, onProgress?: ConfigTransferProgressReporter): Promise<{
    size: number;
    entries: string[];
}>;
/** Unpacks and validates a config into a staging folder; nothing in use is touched until restart. */
export declare function stageConfigImport(userData: string, archive: string, onProgress?: ConfigTransferProgressReporter): Promise<ConfigManifest>;
export declare function commitStagedImport(userData: string): Promise<void>;
export declare function cancelStagedImport(userData: string): Promise<void>;
export declare function applyPendingImport(userData: string, indexStoragePath?: string): Promise<boolean>;
