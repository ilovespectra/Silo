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
exports.IOSMessageExporter = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * iOS Message Exporter
 * Uses imessage-exporter (https://github.com/ReagentX/imessage-exporter)
 * to export messages from local macOS message database
 *
 * Installation: brew install imessage-exporter
 */
class IOSMessageExporter {
    log(...args) {
        try {
            console.log("[IOSMessageExporter]", ...args);
        }
        catch {
            // Silently ignore errors during shutdown
        }
    }
    logError(...args) {
        try {
            console.error("[IOSMessageExporter]", ...args);
        }
        catch {
            // Silently ignore errors during shutdown
        }
    }
    /**
     * Check if imessage-exporter is installed
     */
    async isInstalled() {
        try {
            const result = await execFileAsync("which", ["imessage-exporter"]);
            return result.stdout.trim().length > 0;
        }
        catch {
            return false;
        }
    }
    /**
     * Get the path to imessage-exporter
     */
    async getExecutablePath() {
        try {
            const result = await execFileAsync("which", ["imessage-exporter"]);
            return result.stdout.trim();
        }
        catch {
            return null;
        }
    }
    /**
     * Export messages to a specified format and directory
     */
    async exportMessages(outputDir, format = "html") {
        try {
            const exePath = await this.getExecutablePath();
            if (!exePath) {
                return {
                    success: false,
                    messageCount: 0,
                    threadCount: 0,
                    path: "",
                    message: "imessage-exporter is not installed. Install with: brew install imessage-exporter",
                };
            }
            this.log(`Exporting messages to ${outputDir} in ${format} format`);
            // Create output directory if it doesn't exist
            await fsPromises.mkdir(outputDir, { recursive: true });
            // Run imessage-exporter
            // The tool will create files in the output directory
            const args = ["-f", format, "-o", outputDir];
            this.log(`Running: imessage-exporter ${args.join(" ")}`);
            const result = await execFileAsync(exePath, args, {
                timeout: 120000,
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            });
            this.log("Export completed successfully");
            this.log("Stdout:", result.stdout.slice(0, 500));
            // Count exported files to estimate message/thread count
            const files = await fsPromises.readdir(outputDir);
            const htmlFiles = files.filter((f) => f.endsWith(".html")).length;
            const jsonFiles = files.filter((f) => f.endsWith(".json")).length;
            return {
                success: true,
                messageCount: htmlFiles > 0 ? htmlFiles * 50 : jsonFiles > 0 ? jsonFiles * 100 : 0,
                threadCount: files.length,
                path: outputDir,
                message: `Messages exported successfully to ${outputDir}`,
            };
        }
        catch (error) {
            this.logError("Export failed:", error);
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            return {
                success: false,
                messageCount: 0,
                threadCount: 0,
                path: "",
                message: `Export failed: ${errorMessage}`,
            };
        }
    }
    /**
     * Check if user has Full Disk Access (required for accessing message database)
     */
    async checkFullDiskAccess() {
        try {
            // Try to access the messages database directly
            const dbPath = path.join(process.env.HOME || "", "Library/Messages/chat.db");
            await fsPromises.access(dbPath);
            this.log("Full Disk Access is available");
            return true;
        }
        catch {
            this.log("Full Disk Access is not available - app cannot access message database");
            return false;
        }
    }
    /**
     * Get install instructions for imessage-exporter
     */
    getInstallInstructions() {
        return `
To export your Apple Messages, you need to install imessage-exporter:

1. Open Terminal and run:
   brew install imessage-exporter

2. Grant Full Disk Access to Electron:
   - Go to System Settings > Privacy & Security > Full Disk Access
   - Add "Electron" or "solo: silo" to the list
   - Restart the app

3. Then you can export your messages using solo: silo
    `;
    }
}
exports.IOSMessageExporter = IOSMessageExporter;
