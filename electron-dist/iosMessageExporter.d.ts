export interface IOSMessageExportResult {
    success: boolean;
    messageCount: number;
    threadCount: number;
    path: string;
    message: string;
}
/**
 * iOS Message Exporter
 * Uses imessage-exporter (https://github.com/ReagentX/imessage-exporter)
 * to export messages from local macOS message database
 *
 * Installation: brew install imessage-exporter
 */
export declare class IOSMessageExporter {
    private log;
    private logError;
    /**
     * Check if imessage-exporter is installed
     */
    isInstalled(): Promise<boolean>;
    /**
     * Get the path to imessage-exporter
     */
    getExecutablePath(): Promise<string | null>;
    /**
     * Export messages to a specified format and directory
     */
    exportMessages(outputDir: string, format?: "html" | "json" | "txt"): Promise<IOSMessageExportResult>;
    /**
     * Check if user has Full Disk Access (required for accessing message database)
     */
    checkFullDiskAccess(): Promise<boolean>;
    /**
     * Get install instructions for imessage-exporter
     */
    getInstallInstructions(): string;
}
