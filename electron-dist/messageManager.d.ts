export interface SMSMessage {
    id: string;
    address: string;
    body: string;
    date: number;
    type: 1 | 2;
    read: 0 | 1;
    threadId?: string;
}
export interface MMSMessage {
    id: string;
    address: string;
    body: string;
    date: number;
    type: 1 | 2;
    read: 0 | 1;
    threadId?: string;
    parts: MMSPart[];
}
export interface MMSPart {
    id: string;
    contentType: string;
    text?: string;
    fileName?: string;
    attachmentAvailable?: boolean;
    attachmentSize?: number;
}
export interface MessageThread {
    threadId: string;
    address: string;
    displayName?: string;
    messageCount: number;
    lastMessageDate: number;
    messages: (SMSMessage | MMSMessage)[];
}
export type MessageAttachmentPaths = Map<string, string>;
export declare function messagePartKey(messageId: string, partId: string): string;
export interface MessageHistoryEntry {
    deviceId: string;
    platform: "ios" | "android";
    deviceName: string;
    threadCount: number;
    lastMessageDate: number;
}
export interface ExportOptions {
    accountId: string;
    deviceId: string;
    outputDir: string;
    format: "xml" | "pdf" | "both";
    includeAttachments: boolean;
    platform?: "ios" | "android";
    threadIds?: string[];
}
export interface ExportResult {
    success: boolean;
    threadCount: number;
    messageCount: number;
    attachmentCount: number;
    xmlPath?: string;
    textPath?: string;
    pdfPaths?: Map<string, string>;
    backupPath?: string;
    error?: string;
}
export declare class MessageManager {
    private adbPath;
    private readonly userDataPath;
    private readonly historyPath;
    private backupDestinationPath;
    constructor(adbPath?: string, userDataPath?: string);
    setBackupDestination(destination: string | null): void;
    private log;
    private logError;
    private resolveAdb;
    private adbShell;
    private adbPull;
    getSMSMessages(deviceId: string): Promise<SMSMessage[]>;
    getMMSMessages(deviceId: string, includeAttachments?: boolean): Promise<MMSMessage[]>;
    private parseSMSLine;
    private parseMMSLine;
    private getMMSAddress;
    private messageAttachmentPath;
    private cacheMMSAttachment;
    private readMMSAttachmentBytes;
    getMessageThreads(deviceId: string, includeAttachments?: boolean): Promise<MessageThread[]>;
    getDeviceMessageThreads(deviceId: string, platform: "ios" | "android", refresh?: boolean, deviceName?: string): Promise<MessageThread[]>;
    private findCachedMessageAttachment;
    getMessageAttachmentFilePath(deviceId: string, messageId: string, partId: string): Promise<string | null>;
    getMessageAttachmentDataUrl(deviceId: string, messageId: string, partId: string): Promise<string | null>;
    listMessageHistory(): Promise<MessageHistoryEntry[]>;
    private historyFile;
    private readMessageHistory;
    private saveMessageHistory;
    private getIOSMessageThreads;
    private sqliteValue;
    private appleMessageDate;
    exportToXML(threads: MessageThread[], outputPath: string, attachmentPaths?: MessageAttachmentPaths): Promise<string>;
    exportToReadableText(threads: MessageThread[], outputPath: string, attachmentPaths?: MessageAttachmentPaths): Promise<string>;
    private escapeXml;
    createThreadFolders(threads: MessageThread[], baseDir: string): Promise<Map<string, string>>;
}
