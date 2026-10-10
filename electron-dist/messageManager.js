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
exports.MessageManager = exports.messagePartKey = void 0;
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const crypto_1 = require("crypto");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const MAX_MMS_ATTACHMENT_BYTES = 32 * 1024 * 1024;
function parseContentQueryRows(output, terminalField) {
    const records = [];
    for (const line of output.split(/\r?\n/)) {
        const row = line.match(/^\s*Row:\s*\d+\s+(.*)$/)?.[1];
        if (!row)
            continue;
        const terminalMarker = terminalField
            ? new RegExp(`(?:^|,\\s*)${terminalField}=`).exec(row)
            : null;
        const parseable = terminalMarker
            ? row.slice(0, terminalMarker.index)
            : row;
        const markers = Array.from(parseable.matchAll(/(?:^|,\s*)([A-Za-z_][A-Za-z0-9_]*)=/g));
        const record = {};
        markers.forEach((marker, index) => {
            const valueStart = marker.index + marker[0].length;
            const valueEnd = markers[index + 1]?.index ?? parseable.length;
            record[marker[1].toLowerCase()] = parseable
                .slice(valueStart, valueEnd)
                .trim();
        });
        if (terminalMarker && terminalField) {
            const valueStart = terminalMarker.index + terminalMarker[0].length;
            record[terminalField.toLowerCase()] = row.slice(valueStart).trim();
        }
        records.push(record);
    }
    return records;
}
function isDatabaseNull(value) {
    return !value || value.trim().toLowerCase() === "null";
}
function mmsPartFileName(partId, name, contentLocation) {
    const candidate = name || contentLocation || `attachment-${partId}`;
    const leaf = candidate.split(/[\\/]/).pop()?.trim() || `attachment-${partId}`;
    return leaf.replace(/[\u0000-\u001f]/g, "_").slice(0, 180);
}
function messagePartKey(messageId, partId) {
    return `${messageId}:${partId}`;
}
exports.messagePartKey = messagePartKey;
class MessageManager {
    constructor(adbPath, userDataPath = "") {
        this.adbPath = null;
        this.backupDestinationPath = null;
        this.adbPath = adbPath || null;
        this.userDataPath = userDataPath;
        this.historyPath = path.join(userDataPath, "message-history");
    }
    setBackupDestination(destination) {
        this.backupDestinationPath = destination;
        this.log(`Backup destination set to: ${destination || "default (local cache)"}`);
    }
    log(...args) {
        try {
            console.log("[MessageManager]", ...args);
        }
        catch {
            // Silently ignore EPIPE and other console errors during shutdown
        }
    }
    logError(...args) {
        try {
            console.error("[MessageManager]", ...args);
        }
        catch {
            // Silently ignore errors during shutdown
        }
    }
    async resolveAdb() {
        if (this.adbPath)
            return this.adbPath;
        const paths = [
            "/opt/homebrew/bin/adb",
            "/usr/local/bin/adb",
            "/usr/bin/adb",
            "adb",
        ];
        for (const p of paths) {
            try {
                await execFileAsync(p, ["--version"]);
                this.adbPath = p;
                return this.adbPath;
            }
            catch {
                continue;
            }
        }
        throw new Error("adb not found");
    }
    async adbShell(deviceId, command, timeout = 30000) {
        const adb = await this.resolveAdb();
        try {
            const { stdout } = await execFileAsync(adb, ["-s", deviceId, "shell", command], { timeout, maxBuffer: 100 * 1024 * 1024 });
            return stdout;
        }
        catch (error) {
            const err = error;
            throw new Error(`ADB command failed: ${err.message}`);
        }
    }
    async adbPull(deviceId, remotePath, localPath) {
        const adb = await this.resolveAdb();
        try {
            await execFileAsync(adb, ["-s", deviceId, "pull", remotePath, localPath], {
                timeout: 60000,
            });
        }
        catch (error) {
            const err = error;
            this.logError(`Failed to pull ${remotePath}: ${err.message}`);
        }
    }
    async getSMSMessages(deviceId) {
        this.log(`Fetching SMS messages from ${deviceId}`);
        // Query SMS database
        const query = "content query --uri content://sms/ --projection _id:thread_id:address:body:date:type:read";
        try {
            const output = await this.adbShell(deviceId, query);
            const messages = [];
            const lines = output.split("\n").filter((line) => line.includes("_id="));
            for (const line of lines) {
                try {
                    const msg = this.parseSMSLine(line);
                    if (msg)
                        messages.push(msg);
                }
                catch (e) {
                    this.logError(`Failed to parse SMS line: ${line}`);
                }
            }
            this.log(`Found ${messages.length} SMS messages`);
            return messages;
        }
        catch (error) {
            this.logError(`Failed to fetch SMS: ${error}`);
            return [];
        }
    }
    async getMMSMessages(deviceId, includeAttachments = true) {
        this.log(`Fetching MMS messages from ${deviceId}`);
        let messageOutput;
        try {
            messageOutput = await this.adbShell(deviceId, "content query --uri content://mms/ --projection _id:thread_id:date:msg_box:read");
        }
        catch (error) {
            this.logError(`Failed to fetch MMS: ${error}`);
            return [];
        }
        const messages = new Map();
        for (const row of parseContentQueryRows(messageOutput)) {
            const message = this.parseMMSLine(row);
            if (message)
                messages.set(message.id, message);
        }
        if (messages.size === 0)
            return [];
        try {
            const partsOutput = await this.adbShell(deviceId, "content query --uri content://mms/part --projection _id:mid:ct:name:cl:_data:text", 120000);
            for (const row of parseContentQueryRows(partsOutput, "text")) {
                const message = messages.get(row.mid);
                if (!message || isDatabaseNull(row._id) || isDatabaseNull(row.ct))
                    continue;
                const contentType = row.ct.toLowerCase();
                const part = {
                    id: row._id,
                    contentType: row.ct,
                };
                if (contentType === "text/plain" && !isDatabaseNull(row.text)) {
                    part.text = row.text;
                }
                else if (contentType !== "application/smil") {
                    part.fileName = mmsPartFileName(row._id, row.name, row.cl);
                    part.attachmentAvailable = false;
                    if (includeAttachments && this.userDataPath) {
                        try {
                            const cached = await this.cacheMMSAttachment(deviceId, message.id, part);
                            Object.assign(part, cached);
                        }
                        catch (error) {
                            this.logError(`Failed to cache MMS attachment ${message.id}/${part.id}:`, error);
                        }
                    }
                }
                message.parts.push(part);
            }
        }
        catch (error) {
            this.logError(`Failed to fetch MMS parts: ${error}`);
        }
        const addressByThread = new Map();
        const representativeByThread = new Map();
        for (const message of messages.values()) {
            const threadId = message.threadId || `mms:${message.id}`;
            representativeByThread.set(threadId, representativeByThread.get(threadId) ?? message);
        }
        const representatives = Array.from(representativeByThread.entries());
        for (let offset = 0; offset < representatives.length; offset += 6) {
            await Promise.all(representatives.slice(offset, offset + 6).map(async ([threadId, message]) => {
                try {
                    const address = await this.getMMSAddress(deviceId, message);
                    if (address)
                        addressByThread.set(threadId, address);
                }
                catch (error) {
                    this.logError(`Failed to resolve MMS address for ${threadId}:`, error);
                }
            }));
        }
        for (const message of messages.values()) {
            const threadId = message.threadId || `mms:${message.id}`;
            message.address = addressByThread.get(threadId) || threadId;
            message.body = message.parts
                .map((part) => part.text)
                .filter(Boolean)
                .join("\n");
        }
        this.log(`Found ${messages.size} MMS messages`);
        return Array.from(messages.values());
    }
    parseSMSLine(line) {
        // Format: Row: 0 _id=123 address=5551234567 body=Hello World date=1629999999000 type=1 read=1
        const parts = {};
        // Extract known fields with proper boundary handling
        const idMatch = line.match(/_id=(\d+)/);
        const threadMatch = line.match(/thread_id=(\d+)/);
        const addressMatch = line.match(/address=(.*?)(?=,\s*body=)/);
        const dateMatch = line.match(/date=(\d+)/);
        const typeMatch = line.match(/type=([12])/);
        const readMatch = line.match(/read=([01])/);
        if (!idMatch || !addressMatch)
            return null;
        parts._id = idMatch[1];
        parts.address = addressMatch[1];
        parts.date = dateMatch ? dateMatch[1] : "0";
        parts.type = typeMatch ? typeMatch[1] : "1";
        parts.read = readMatch ? readMatch[1] : "0";
        // Extract body - everything after "body=" until the next key or end of line
        const bodyMatch = line.match(/body=(.*?)(?=,\s*date=)/);
        parts.body = bodyMatch ? bodyMatch[1].trim() : "";
        return {
            id: parts._id,
            address: parts.address,
            body: parts.body,
            date: parseInt(parts.date) || 0,
            type: (parseInt(parts.type) === 1 ? 1 : 2),
            read: (parseInt(parts.read) === 1 ? 1 : 0),
            threadId: threadMatch?.[1],
        };
    }
    parseMMSLine(row) {
        const id = row._id;
        const timestamp = Number(row.date);
        const messageBox = Number(row.msg_box);
        const read = Number(row.read);
        if (!/^\d+$/.test(id || ""))
            return null;
        return {
            id,
            address: "",
            body: "",
            date: Number.isFinite(timestamp) && timestamp > 0
                ? timestamp < 1000000000000
                    ? timestamp * 1000
                    : timestamp
                : 0,
            type: (messageBox === 2 || messageBox === 4 ? 2 : 1),
            read: (read === 1 ? 1 : 0),
            threadId: /^\d+$/.test(row.thread_id || "") ? row.thread_id : undefined,
            parts: [],
        };
    }
    async getMMSAddress(deviceId, message) {
        const output = await this.adbShell(deviceId, `content query --uri content://mms/${message.id}/addr --projection address:type`);
        const expectedType = message.type === 2 ? "151" : "137";
        const rows = parseContentQueryRows(output);
        const addresses = rows
            .filter((row) => row.type === expectedType || !row.type)
            .map((row) => row.address)
            .filter((address) => !isDatabaseNull(address))
            .filter((address) => address.toLowerCase() !== "insert-address-token");
        return Array.from(new Set(addresses)).join(", ");
    }
    messageAttachmentPath(deviceId, messageId, partId) {
        const deviceKey = (0, crypto_1.createHash)("sha256")
            .update(`android:${deviceId}`)
            .digest("hex");
        return path.join(this.userDataPath, "message-attachments", deviceKey, messageId, `${partId}.bin`);
    }
    async cacheMMSAttachment(deviceId, messageId, part) {
        const destination = this.messageAttachmentPath(deviceId, messageId, part.id);
        const existing = await fsPromises.stat(destination).catch(() => null);
        if (existing?.isFile() &&
            existing.size > 0 &&
            existing.size <= MAX_MMS_ATTACHMENT_BYTES) {
            return { attachmentAvailable: true, attachmentSize: existing.size };
        }
        const data = await this.readMMSAttachmentBytes(deviceId, part.id);
        if (data.length === 0)
            throw new Error("The MMS attachment was empty or unavailable.");
        if (data.length > MAX_MMS_ATTACHMENT_BYTES)
            throw new Error("The MMS attachment exceeds the 32 MiB limit.");
        await fsPromises.mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}-${Date.now()}.tmp`;
        await fsPromises.writeFile(temporary, data, { flag: "wx" });
        await fsPromises.rename(temporary, destination);
        return { attachmentAvailable: true, attachmentSize: data.length };
    }
    async readMMSAttachmentBytes(deviceId, partId) {
        if (!/^\d+$/.test(partId))
            throw new Error("The MMS part identifier is invalid.");
        const adb = await this.resolveAdb();
        const { stdout } = await execFileAsync(adb, [
            "-s",
            deviceId,
            "exec-out",
            "content",
            "read",
            "--uri",
            `content://mms/part/${partId}`,
        ], {
            encoding: "buffer",
            timeout: 120000,
            maxBuffer: MAX_MMS_ATTACHMENT_BYTES,
        });
        return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    }
    async getMessageThreads(deviceId, includeAttachments = true) {
        this.log(`Building message threads from ${deviceId}`);
        const [smsMessages, mmsMessages] = await Promise.all([
            this.getSMSMessages(deviceId),
            this.getMMSMessages(deviceId, includeAttachments),
        ]);
        // Group by thread (for now, use address as thread identifier)
        const threadsMap = new Map();
        for (const msg of smsMessages) {
            const threadId = msg.threadId || msg.address;
            if (!threadsMap.has(threadId)) {
                threadsMap.set(threadId, {
                    threadId,
                    address: msg.address,
                    messageCount: 0,
                    lastMessageDate: 0,
                    messages: [],
                });
            }
            const thread = threadsMap.get(threadId);
            thread.messages.push(msg);
            thread.messageCount++;
            thread.lastMessageDate = Math.max(thread.lastMessageDate, msg.date);
        }
        for (const msg of mmsMessages) {
            const threadId = msg.threadId || `mms:${msg.id}`;
            const thread = threadsMap.get(threadId);
            const address = msg.address && msg.address !== threadId
                ? msg.address
                : thread?.address || msg.address || threadId;
            if (!thread) {
                threadsMap.set(threadId, {
                    threadId,
                    address,
                    messageCount: 1,
                    lastMessageDate: msg.date,
                    messages: [msg],
                });
                continue;
            }
            thread.messages.push(msg);
            thread.messageCount++;
            thread.lastMessageDate = Math.max(thread.lastMessageDate, msg.date);
            if (thread.address === threadId && address !== threadId)
                thread.address = address;
        }
        // Sort messages by date within each thread
        for (const thread of threadsMap.values()) {
            thread.messages.sort((a, b) => a.date - b.date);
        }
        const threads = Array.from(threadsMap.values());
        threads.sort((first, second) => second.lastMessageDate - first.lastMessageDate);
        this.log(`Built ${threads.length} message threads`);
        return threads;
    }
    async getDeviceMessageThreads(deviceId, platform, refresh = false, deviceName = deviceId) {
        if (!refresh) {
            const cached = await this.readMessageHistory(deviceId, platform);
            if (cached) {
                if (platform !== "android" || cached.mmsCoverageVersion === 1)
                    return cached.threads;
                const refreshed = await this.getMessageThreads(deviceId, true);
                if (refreshed.length === 0)
                    return cached.threads;
                await this.saveMessageHistory(deviceId, platform, deviceName, refreshed);
                return refreshed;
            }
        }
        const threads = platform === "android"
            ? await this.getMessageThreads(deviceId, true)
            : await this.getIOSMessageThreads(deviceId, refresh);
        if (threads.length > 0)
            await this.saveMessageHistory(deviceId, platform, deviceName, threads);
        return threads;
    }
    async findCachedMessageAttachment(deviceId, messageId, partId) {
        if (!/^\d+$/.test(messageId) || !/^\d+$/.test(partId))
            return null;
        const history = await this.readMessageHistory(deviceId, "android");
        if (!history)
            return null;
        for (const thread of history.threads) {
            const message = thread.messages.find((candidate) => candidate.id === messageId && "parts" in candidate);
            const part = message?.parts.find((candidate) => candidate.id === partId);
            if (!part?.attachmentAvailable)
                continue;
            const filePath = this.messageAttachmentPath(deviceId, messageId, partId);
            const stats = await fsPromises.stat(filePath).catch(() => null);
            if (!stats?.isFile() ||
                stats.size === 0 ||
                stats.size > MAX_MMS_ATTACHMENT_BYTES ||
                stats.size !== part.attachmentSize)
                return null;
            return { part, path: filePath };
        }
        return null;
    }
    async getMessageAttachmentFilePath(deviceId, messageId, partId) {
        return ((await this.findCachedMessageAttachment(deviceId, messageId, partId))
            ?.path ?? null);
    }
    async getMessageAttachmentDataUrl(deviceId, messageId, partId) {
        const attachment = await this.findCachedMessageAttachment(deviceId, messageId, partId);
        if (!attachment)
            return null;
        const data = await fsPromises.readFile(attachment.path);
        const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.part.contentType)
            ? attachment.part.contentType
            : "application/octet-stream";
        return `data:${contentType};base64,${data.toString("base64")}`;
    }
    async listMessageHistory() {
        await fsPromises.mkdir(this.historyPath, { recursive: true });
        const entries = await fsPromises
            .readdir(this.historyPath, { withFileTypes: true })
            .catch(() => []);
        const histories = [];
        const knownKeys = new Set();
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json"))
                continue;
            try {
                const record = JSON.parse(await fsPromises.readFile(path.join(this.historyPath, entry.name), "utf8"));
                histories.push({
                    deviceId: record.deviceId,
                    platform: record.platform,
                    deviceName: record.deviceName,
                    threadCount: record.threads.length,
                    lastMessageDate: record.threads.reduce((latest, thread) => Math.max(latest, thread.lastMessageDate), 0),
                });
                knownKeys.add(`${record.platform}:${record.deviceId}`);
            }
            catch {
                continue;
            }
        }
        const backupRoots = [
            path.join(this.userDataPath, "ios-message-backups"),
            ...(this.backupDestinationPath
                ? [path.join(this.backupDestinationPath, "ios", "ios-message-backups")]
                : []),
        ];
        for (const backupRoot of backupRoots) {
            const backups = await fsPromises
                .readdir(backupRoot, { withFileTypes: true })
                .catch(() => []);
            for (const backup of backups) {
                if (!backup.isDirectory() || knownKeys.has(`ios:${backup.name}`))
                    continue;
                const manifest = path.join(backupRoot, backup.name, "Manifest.db");
                if (!(await fsPromises.access(manifest).then(() => true, () => false)))
                    continue;
                histories.push({
                    deviceId: backup.name,
                    platform: "ios",
                    deviceName: `iPhone (${backup.name.slice(0, 8)})`,
                    threadCount: 0,
                    lastMessageDate: 0,
                });
                knownKeys.add(`ios:${backup.name}`);
            }
        }
        return histories.sort((first, second) => second.lastMessageDate - first.lastMessageDate);
    }
    historyFile(deviceId, platform) {
        const key = (0, crypto_1.createHash)("sha256")
            .update(`${platform}:${deviceId}`)
            .digest("hex");
        return path.join(this.historyPath, `${key}.json`);
    }
    async readMessageHistory(deviceId, platform) {
        try {
            return JSON.parse(await fsPromises.readFile(this.historyFile(deviceId, platform), "utf8"));
        }
        catch {
            return null;
        }
    }
    async saveMessageHistory(deviceId, platform, deviceName, threads) {
        await fsPromises.mkdir(this.historyPath, { recursive: true });
        const destination = this.historyFile(deviceId, platform);
        const temporary = `${destination}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
        await fsPromises.writeFile(temporary, JSON.stringify({
            deviceId,
            platform,
            deviceName,
            mmsCoverageVersion: platform === "android" ? 1 : undefined,
            threads,
        }), "utf8");
        await fsPromises.rename(temporary, destination);
    }
    async getIOSMessageThreads(deviceId, refresh) {
        if (process.platform !== "darwin")
            throw new Error("Reading iPhone Messages from device backups is currently supported on macOS only.");
        if (!this.userDataPath)
            throw new Error("Message backup directory is unavailable.");
        const backupRoot = path.join(this.backupDestinationPath || this.userDataPath, this.backupDestinationPath
            ? "ios/ios-message-backups"
            : "ios-message-backups");
        const deviceBackup = path.join(backupRoot, deviceId);
        const manifestPath = path.join(deviceBackup, "Manifest.db");
        // Check if backup exists
        let backupExists = false;
        try {
            await fsPromises.access(manifestPath);
            backupExists = true;
        }
        catch {
            backupExists = false;
        }
        // Only do full backup if:
        // 1. Backup doesn't exist (first time), OR
        // 2. User explicitly refreshed AND backup doesn't exist
        if (!backupExists || refresh) {
            if (!refresh) {
                throw new Error("No Silo iPhone message backup exists yet. Choose Refresh iPhone Messages to create one.");
            }
            this.log(`Creating iPhone message backup at: ${backupRoot} (destination: ${this.backupDestinationPath || "default"})`);
            await fsPromises.mkdir(backupRoot, { recursive: true });
            try {
                await execFileAsync("idevicebackup2", ["-u", deviceId, "backup", backupRoot], {
                    timeout: 20 * 60 * 1000,
                    maxBuffer: 20 * 1024 * 1024,
                });
            }
            catch (error) {
                const processError = error;
                const message = [
                    processError.message,
                    processError.stdout,
                    processError.stderr,
                ]
                    .filter(Boolean)
                    .join("\n");
                // Handle specific errors
                if (/protocol version exchange|error code -1/i.test(message)) {
                    throw new Error("iPhone trust issue detected. " +
                        "Please: 1) Disconnect iPhone, 2) Wait 5 seconds, 3) Reconnect iPhone, " +
                        '4) Tap "Trust" on the iPhone screen, 5) Try again.');
                }
                const location = this.backupDestinationPath
                    ? `external drive (${this.backupDestinationPath})`
                    : "Mac storage";
                if (/ErrorCode 105|Insufficient free disk space/i.test(message))
                    throw new Error(`The iPhone backup needs more free space on your ${location} before Messages can be loaded. Free disk space, then choose Refresh iPhone Messages again.`);
                if (/password|encrypt/i.test(message))
                    throw new Error("This iPhone uses encrypted backups. Create an unencrypted local backup or provide the backup password directly in Terminal.");
                throw new Error(`Could not create the trusted iPhone backup: ${message}`);
            }
        }
        else {
            // Backup exists - just load messages from it (fast operation)
            this.log(`Loading messages from existing iPhone backup at: ${deviceBackup}`);
        }
        const fileId = (await this.sqliteValue(manifestPath, "SELECT fileID FROM Files WHERE domain='HomeDomain' AND relativePath='Library/SMS/sms.db' LIMIT 1;")).trim();
        if (!fileId)
            throw new Error("The iPhone backup does not contain Messages data.");
        const smsDatabase = path.join(deviceBackup, fileId.slice(0, 2), fileId);
        const query = `
      SELECT json_object(
        'threadId', CAST(c.ROWID AS TEXT),
        'address', COALESCE(c.chat_identifier, h.id, ''),
        'displayName', COALESCE(c.display_name, c.chat_identifier, h.id, ''),
        'id', CAST(m.ROWID AS TEXT),
        'body', COALESCE(m.text, ''),
        'date', m.date,
        'type', CASE WHEN m.is_from_me = 1 THEN 2 ELSE 1 END,
        'read', CASE WHEN m.is_read = 1 THEN 1 ELSE 0 END
      )
      FROM chat_message_join cmj
      JOIN chat c ON c.ROWID = cmj.chat_id
      JOIN message m ON m.ROWID = cmj.message_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      ORDER BY c.ROWID, m.date;
    `;
        const output = await this.sqliteValue(smsDatabase, query);
        const threads = new Map();
        for (const line of output.split("\n").filter(Boolean)) {
            const row = JSON.parse(line);
            const date = this.appleMessageDate(row.date);
            const thread = threads.get(row.threadId) ?? {
                threadId: row.threadId,
                address: row.address,
                displayName: row.displayName,
                messageCount: 0,
                lastMessageDate: 0,
                messages: [],
            };
            thread.messages.push({
                id: row.id,
                address: row.address,
                body: row.body,
                date,
                type: row.type,
                read: row.read,
                threadId: row.threadId,
            });
            thread.messageCount += 1;
            thread.lastMessageDate = Math.max(thread.lastMessageDate, date);
            threads.set(row.threadId, thread);
        }
        return Array.from(threads.values()).sort((first, second) => second.lastMessageDate - first.lastMessageDate);
    }
    async sqliteValue(databasePath, query) {
        const { stdout } = await execFileAsync("/usr/bin/sqlite3", [databasePath, query], {
            timeout: 120000,
            maxBuffer: 100 * 1024 * 1024,
        });
        return stdout;
    }
    appleMessageDate(value) {
        const numeric = Number(value) || 0;
        const seconds = numeric > 1e15 ? numeric / 1e9 : numeric > 1e12 ? numeric / 1e6 : numeric;
        return Math.round((seconds + 978307200) * 1000);
    }
    async exportToXML(threads, outputPath, attachmentPaths = new Map()) {
        this.log(`Exporting ${threads.length} threads to XML: ${outputPath}`);
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += "<messages>\n";
        for (const thread of threads) {
            xml += `  <thread id="${this.escapeXml(thread.threadId)}" address="${this.escapeXml(thread.address)}" messageCount="${thread.messageCount}" lastDate="${thread.lastMessageDate}">\n`;
            for (const msg of thread.messages) {
                const isMMSMessage = msg.parts !== undefined;
                if (isMMSMessage) {
                    xml += `    <mms id="${this.escapeXml(msg.id)}" date="${msg.date}" type="${msg.type}" read="${msg.read}">\n`;
                    const mmsParts = msg.parts;
                    for (const part of mmsParts) {
                        xml += `      <part id="${this.escapeXml(part.id)}" contentType="${this.escapeXml(part.contentType)}">\n`;
                        if (part.text) {
                            xml += `        <text>${this.escapeXml(part.text)}</text>\n`;
                        }
                        if (part.fileName) {
                            const exportPath = attachmentPaths.get(messagePartKey(msg.id, part.id));
                            if (exportPath) {
                                xml += `        <attachment fileName="${this.escapeXml(part.fileName)}" path="${this.escapeXml(exportPath)}" size="${part.attachmentSize ?? 0}" />\n`;
                            }
                            else {
                                xml += `        <attachment fileName="${this.escapeXml(part.fileName)}" available="${part.attachmentAvailable ? "true" : "false"}" exported="false" />\n`;
                            }
                        }
                        xml += `      </part>\n`;
                    }
                    xml += `    </mms>\n`;
                }
                else {
                    const sms = msg;
                    xml += `    <sms id="${this.escapeXml(sms.id)}" date="${sms.date}" type="${sms.type}" read="${sms.read}">\n`;
                    xml += `      <body>${this.escapeXml(sms.body)}</body>\n`;
                    xml += `    </sms>\n`;
                }
            }
            xml += `  </thread>\n`;
        }
        xml += "</messages>\n";
        await fsPromises.writeFile(outputPath, xml, "utf8");
        this.log(`XML export complete: ${outputPath}`);
        return outputPath;
    }
    async exportToReadableText(threads, outputPath, attachmentPaths = new Map()) {
        this.log(`Exporting ${threads.length} threads to text: ${outputPath}`);
        let text = "MESSAGE BACKUP - Human Readable Format\n";
        text += `Generated: ${new Date().toLocaleString()}\n`;
        text += `Total Conversations: ${threads.length}\n`;
        text += `Total Messages: ${threads.reduce((sum, t) => sum + t.messageCount, 0)}\n`;
        text += "\n" + "=".repeat(80) + "\n\n";
        for (const thread of threads) {
            text += `CONVERSATION: ${thread.address}\n`;
            if (thread.displayName) {
                text += `Display Name: ${thread.displayName}\n`;
            }
            text += `Messages: ${thread.messageCount}\n`;
            text += `Last Message: ${new Date(thread.lastMessageDate).toLocaleString()}\n`;
            text += "-".repeat(80) + "\n\n";
            for (const msg of thread.messages) {
                const date = new Date(msg.date);
                const isMMSMessage = msg.parts !== undefined;
                const isSent = msg.type === 2;
                const direction = isSent ? "→ SENT" : "← RECEIVED";
                text += `[${date.toLocaleString()}] ${direction}\n`;
                if (isMMSMessage) {
                    const mmsParts = msg.parts;
                    if (mmsParts.length === 0) {
                        text += "[Media - No text content]\n";
                    }
                    else {
                        for (const part of mmsParts) {
                            if (part.text) {
                                text += `${part.text}\n`;
                            }
                            if (part.fileName) {
                                const exportPath = attachmentPaths.get(messagePartKey(msg.id, part.id));
                                text += exportPath
                                    ? `[Attachment: ${part.fileName} — ${exportPath}]\n`
                                    : `[Attachment not exported: ${part.fileName}]\n`;
                            }
                            else if (!part.text) {
                                text += `[${part.contentType}]\n`;
                            }
                        }
                    }
                }
                else {
                    const sms = msg;
                    text += `${sms.body}\n`;
                }
                text += "\n";
            }
            text += "\n" + "=".repeat(80) + "\n\n";
        }
        await fsPromises.writeFile(outputPath, text, "utf8");
        this.log(`Text export complete: ${outputPath}`);
        return outputPath;
    }
    escapeXml(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }
    async createThreadFolders(threads, baseDir) {
        this.log(`Creating ${threads.length} thread folders in ${baseDir}`);
        const folderMap = new Map();
        for (const thread of threads) {
            const folderName = `${thread.address}${thread.displayName ? ` (${thread.displayName})` : ""}`;
            const folderPath = path.join(baseDir, folderName);
            try {
                await fsPromises.mkdir(folderPath, { recursive: true });
                folderMap.set(thread.threadId, folderPath);
            }
            catch (error) {
                this.logError(`Failed to create folder ${folderPath}: ${error}`);
            }
        }
        return folderMap;
    }
}
exports.MessageManager = MessageManager;
