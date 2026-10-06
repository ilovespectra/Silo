import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { MessageThread, SMSMessage, MMSMessage } from "./messageManager";

const execFileAsync = promisify(execFile);

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
export class IOSMessageExporter {
  private log(...args: any[]): void {
    try {
      console.log("[IOSMessageExporter]", ...args);
    } catch {
      // Silently ignore errors during shutdown
    }
  }

  private logError(...args: any[]): void {
    try {
      console.error("[IOSMessageExporter]", ...args);
    } catch {
      // Silently ignore errors during shutdown
    }
  }

  /**
   * Check if imessage-exporter is installed
   */
  async isInstalled(): Promise<boolean> {
    try {
      const result = await execFileAsync("which", ["imessage-exporter"]);
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the path to imessage-exporter
   */
  async getExecutablePath(): Promise<string | null> {
    try {
      const result = await execFileAsync("which", ["imessage-exporter"]);
      return result.stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Export messages to a specified format and directory
   */
  async exportMessages(
    outputDir: string,
    format: "html" | "json" | "txt" = "html",
  ): Promise<IOSMessageExportResult> {
    try {
      const exePath = await this.getExecutablePath();
      if (!exePath) {
        return {
          success: false,
          messageCount: 0,
          threadCount: 0,
          path: "",
          message:
            "imessage-exporter is not installed. Install with: brew install imessage-exporter",
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
        timeout: 120000, // 2 minute timeout for large message databases
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
        messageCount:
          htmlFiles > 0 ? htmlFiles * 50 : jsonFiles > 0 ? jsonFiles * 100 : 0, // Estimates
        threadCount: files.length,
        path: outputDir,
        message: `Messages exported successfully to ${outputDir}`,
      };
    } catch (error) {
      this.logError("Export failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
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
  async checkFullDiskAccess(): Promise<boolean> {
    try {
      // Try to access the messages database directly
      const dbPath = path.join(
        process.env.HOME || "",
        "Library/Messages/chat.db",
      );
      await fsPromises.access(dbPath);
      this.log("Full Disk Access is available");
      return true;
    } catch {
      this.log(
        "Full Disk Access is not available - app cannot access message database",
      );
      return false;
    }
  }

  /**
   * Get install instructions for imessage-exporter
   */
  getInstallInstructions(): string {
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
