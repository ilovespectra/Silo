"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageExportCoordinator = void 0;
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const messageManager_1 = require("./messageManager");
const messagePDFGenerator_1 = require("./messagePDFGenerator");
function safeExportSegment(value, fallback) {
    const leaf = path.basename(value)
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
        .trim()
        .slice(0, 100);
    return leaf && leaf !== "." && leaf !== ".." ? leaf : fallback;
}
class MessageExportCoordinator {
    constructor(userDataPath = "") {
        this.messageManager = new messageManager_1.MessageManager(undefined, userDataPath);
        this.pdfGenerator = new messagePDFGenerator_1.MessagePDFGenerator();
    }
    setBackupDestination(destination) {
        this.messageManager.setBackupDestination(destination);
    }
    log(...args) {
        try {
            console.log("[MessageExportCoordinator]", ...args);
        }
        catch {
            // Silently ignore EPIPE and other console errors during shutdown
        }
    }
    logError(...args) {
        try {
            console.error("[MessageExportCoordinator]", ...args);
        }
        catch {
            // Silently ignore errors during shutdown
        }
    }
    async exportMessages(options) {
        this.log(`Starting export for ${options.accountId}`);
        try {
            // Create backup directory
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupDir = path.join(options.outputDir, `message-backup-${timestamp}`);
            await fsPromises.mkdir(backupDir, { recursive: true });
            this.log(`Created backup dir: ${backupDir}`);
            // Fetch message threads
            let threads = await this.messageManager.getDeviceMessageThreads(options.deviceId, options.platform ?? "android", false);
            if (options.threadIds?.length) {
                const selected = new Set(options.threadIds);
                threads = threads.filter((thread) => selected.has(thread.threadId));
            }
            if (threads.length === 0) {
                return {
                    success: false,
                    threadCount: 0,
                    messageCount: 0,
                    attachmentCount: 0,
                    error: "No messages found on device",
                };
            }
            let xmlPath;
            let textPath;
            const pdfPaths = new Map();
            let totalAttachments = 0;
            const attachmentPaths = new Map();
            const exportedAttachments = [];
            if (options.includeAttachments) {
                for (const thread of threads) {
                    for (const message of thread.messages) {
                        if (!("parts" in message))
                            continue;
                        const mms = message;
                        for (const part of mms.parts) {
                            if (!part.fileName || !part.attachmentAvailable)
                                continue;
                            const source = await this.messageManager.getMessageAttachmentFilePath(options.deviceId, mms.id, part.id);
                            if (!source)
                                continue;
                            const relativePath = path.posix.join("attachments", safeExportSegment(thread.threadId, "conversation"), `${mms.id}-${part.id}-${safeExportSegment(part.fileName, "attachment")}`);
                            const destination = path.join(backupDir, ...relativePath.split("/"));
                            try {
                                await fsPromises.mkdir(path.dirname(destination), {
                                    recursive: true,
                                });
                                await fsPromises.copyFile(source, destination);
                                attachmentPaths.set((0, messageManager_1.messagePartKey)(mms.id, part.id), relativePath);
                                exportedAttachments.push({
                                    threadId: thread.threadId,
                                    messageId: mms.id,
                                    partId: part.id,
                                    contentType: part.contentType,
                                    fileName: part.fileName,
                                    path: relativePath,
                                    size: part.attachmentSize ?? 0,
                                });
                                totalAttachments++;
                            }
                            catch (error) {
                                this.logError(`Failed to export MMS attachment ${mms.id}/${part.id}:`, error);
                            }
                        }
                    }
                }
            }
            // XML export
            if (options.format === "xml" || options.format === "both") {
                xmlPath = path.join(backupDir, "messages-backup.xml");
                await this.messageManager.exportToXML(threads, xmlPath, attachmentPaths);
            }
            // Human-readable text export
            if (options.format === "xml" || options.format === "both") {
                textPath = path.join(backupDir, "messages-backup.txt");
                await this.messageManager.exportToReadableText(threads, textPath, attachmentPaths);
            }
            // PDF export - individual per thread
            if (options.format === "pdf" || options.format === "both") {
                const threadsDir = path.join(backupDir, "conversations");
                await fsPromises.mkdir(threadsDir, { recursive: true });
                for (const thread of threads) {
                    const fileName = `${thread.address.replace(/\//g, "_")}${thread.displayName
                        ? `_${thread.displayName.replace(/\//g, "_")}`
                        : ""}.pdf`;
                    const pdfPath = path.join(threadsDir, fileName);
                    try {
                        await this.pdfGenerator.generateThreadPDF(thread, pdfPath, attachmentPaths);
                        pdfPaths.set(thread.threadId, pdfPath);
                    }
                    catch (error) {
                        this.logError(`Failed to generate PDF for ${thread.threadId}: ${error}`);
                    }
                }
                // Combined PDF with all threads
                const combinedPath = path.join(backupDir, "all-conversations.pdf");
                try {
                    await this.pdfGenerator.generateCombinedPDF(threads, combinedPath, attachmentPaths);
                    pdfPaths.set("combined", combinedPath);
                }
                catch (error) {
                    this.logError(`Failed to generate combined PDF: ${error}`);
                }
            }
            // Create backup metadata
            const metadata = {
                exportedAt: new Date().toISOString(),
                accountId: options.accountId,
                deviceId: options.deviceId,
                threadCount: threads.length,
                messageCount: threads.reduce((sum, t) => sum + t.messageCount, 0),
                attachmentCount: totalAttachments,
                format: options.format,
                files: {
                    xml: xmlPath,
                    text: textPath,
                    pdfs: Array.from(pdfPaths.entries()).map(([id, p]) => ({
                        threadId: id,
                        path: p,
                    })),
                    attachments: exportedAttachments,
                },
            };
            const metadataPath = path.join(backupDir, "backup-metadata.json");
            await fsPromises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
            this.log(`Export complete: ${threads.length} threads, ${metadata.messageCount} messages`);
            return {
                success: true,
                threadCount: threads.length,
                messageCount: metadata.messageCount,
                attachmentCount: totalAttachments,
                xmlPath,
                textPath,
                pdfPaths,
                backupPath: backupDir,
            };
        }
        catch (error) {
            this.logError(`Export failed:`, error);
            return {
                success: false,
                threadCount: 0,
                messageCount: 0,
                attachmentCount: 0,
                error: error.message,
            };
        }
    }
    getDeviceThreads(deviceId, platform, refresh = false, deviceName = deviceId) {
        return this.messageManager.getDeviceMessageThreads(deviceId, platform, refresh, deviceName);
    }
    getMessageAttachmentDataUrl(deviceId, messageId, partId) {
        return this.messageManager.getMessageAttachmentDataUrl(deviceId, messageId, partId);
    }
    listMessageHistory() {
        return this.messageManager.listMessageHistory();
    }
    async restoreMessages(backupPath, deviceId) {
        this.log(`Restoring from ${backupPath}`);
        // TODO: Implement message restoration via ADB
        // This is complex as it requires pushing messages back to the SMS database
        return {
            success: false,
            message: "Message restoration not yet implemented",
        };
    }
    async listAvailableBackups(baseDir) {
        this.log(`Listing backups in ${baseDir}`);
        const backups = [];
        try {
            const entries = await fsPromises.readdir(baseDir, {
                withFileTypes: true,
            });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith("message-backup-")) {
                    const metadataPath = path.join(baseDir, entry.name, "backup-metadata.json");
                    try {
                        const metadataStr = await fsPromises.readFile(metadataPath, "utf8");
                        const metadata = JSON.parse(metadataStr);
                        backups.push({
                            name: entry.name,
                            path: path.join(baseDir, entry.name),
                            ...metadata,
                        });
                    }
                    catch (error) {
                        this.logError(`Failed to read metadata for ${entry.name}`);
                    }
                }
            }
        }
        catch (error) {
            this.logError(`Failed to list backups: ${error}`);
        }
        return backups;
    }
}
exports.MessageExportCoordinator = MessageExportCoordinator;
