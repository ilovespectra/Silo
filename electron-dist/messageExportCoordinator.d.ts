import { ExportOptions, ExportResult, MessageThread, MessageHistoryEntry } from "./messageManager";
export declare class MessageExportCoordinator {
    private messageManager;
    private pdfGenerator;
    constructor(userDataPath?: string);
    setBackupDestination(destination: string | null): void;
    private log;
    private logError;
    exportMessages(options: ExportOptions): Promise<ExportResult>;
    getDeviceThreads(deviceId: string, platform: "ios" | "android", refresh?: boolean, deviceName?: string): Promise<MessageThread[]>;
    getMessageAttachmentDataUrl(deviceId: string, messageId: string, partId: string): Promise<string | null>;
    listMessageHistory(): Promise<MessageHistoryEntry[]>;
    restoreMessages(backupPath: string, deviceId: string): Promise<{
        success: boolean;
        message: string;
    }>;
    listAvailableBackups(baseDir: string): Promise<any[]>;
}
