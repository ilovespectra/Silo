import { createServer, Server, ServerResponse } from "http";
import { createHash, randomBytes } from "crypto";
import { safeStorage, shell } from "electron";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { isAudioFile } from "./utils/audioTypes";

const CLOUD_PREFIX = "/__cloud__";
const DRIVE_SEGMENT = "gdrive";
const PHOTOS_SEGMENT = "gphotos";
const ALL_DRIVES_PATH = `${CLOUD_PREFIX}/all/drive/All Drives`;
const ALL_PHOTOS_PATH = `${CLOUD_PREFIX}/all/photos/All Photos`;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const PICKER_API = "https://photospicker.googleapis.com/v1";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const LARGE_EMAIL_QUERY = "larger:5M -in:trash";

/**
 * photoslibrary.readonly was removed on 2025-04-01, so a user's full Photos
 * library is unreachable. The Picker API is the supported replacement.
 */
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  // Moves large emails to Gmail Trash after Silo saves a verified copy; cannot permanently delete.
  GMAIL_MODIFY_SCOPE,
];

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleAccountSummary {
  id: string;
  email: string;
  driveRootPath: string;
  photosRootPath: string;
  pickedCount: number;
  needsReauth: boolean;
  gmailAccess: boolean;
}

export interface GoogleStorageQuota {
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
}

export type GoogleReclaimKind = "drive" | "gmail";

export interface GoogleReclaimItem {
  id: string;
  kind: GoogleReclaimKind;
  name: string;
  detail: string;
  size: number;
  modified: number;
}

export interface GoogleReclaimOverview {
  accountId: string;
  email: string;
  storage: GoogleStorageQuota | null;
  driveFiles: GoogleReclaimItem[];
  emails: GoogleReclaimItem[];
  gmailAccess: boolean;
  driveError?: string;
  gmailError?: string;
  destination: string | null;
}

export interface GoogleReclaimProgress {
  accountId: string;
  done: number;
  total: number;
  bytes: number;
  current: string;
}

export interface GoogleReclaimResult {
  ok: boolean;
  canceled?: boolean;
  trashed: number;
  bytes: number;
  failed: Array<{ id: string; name: string; error: string }>;
  destination: string | null;
  error?: string;
}

export interface GoogleAccountsState {
  configured: boolean;
  accounts: GoogleAccountSummary[];
  allDrivesPath: string;
  allPhotosPath: string;
  totalPickedCount: number;
  message: string;
  storageWarning?: string;
}

export interface CloudFileInfo {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: number;
  isDirectory: boolean;
  type: string;
  extension: string;
}

interface PickedMediaItem {
  id: string;
  name: string;
  baseUrl: string;
  mimeType: string;
  modified: number;
}

interface StoredAccount {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  needsReauth?: boolean;
  scopes?: string[];
}

const GOOGLE_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "application/pdf",
  "application/vnd.google-apps.spreadsheet": "application/pdf",
  "application/vnd.google-apps.presentation": "application/pdf",
  "application/vnd.google-apps.drawing": "image/png",
};

export async function loadGoogleEnv(
  envPath: string,
): Promise<GoogleConfig | null> {
  try {
    const raw = await fsPromises.readFile(envPath, "utf8");
    const values = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      values.set(
        trimmed.slice(0, separator).trim(),
        trimmed
          .slice(separator + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
    }
    const clientId = values.get("GOOGLE_CLIENT_ID");
    const clientSecret = values.get("GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      redirectUri:
        values.get("GOOGLE_REDIRECT_URI") ||
        "http://127.0.0.1:3001/oauth/callback",
    };
  } catch {
    return null;
  }
}

function classifyCloudFile(mimeType: string, fileName = ""): string {
  if (mimeType === "application/vnd.google-apps.folder") return "folder";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (isAudioFile(fileName, mimeType)) return "audio";
  if (mimeType.startsWith("text/") || mimeType === "application/pdf")
    return "document";
  if (mimeType.startsWith("application/vnd.google-apps.")) return "document";
  return "other";
}

export class GoogleManager {
  private config: GoogleConfig | null = null;
  private accounts = new Map<string, StoredAccount>();
  private pickedItems = new Map<string, Map<string, PickedMediaItem>>();
  private accountsPath: string;
  private reclaimSettingsPath: string;
  private cacheRoot: string;
  private authServer: Server | null = null;
  private storageWarning: string | null = null;

  constructor(userDataPath: string, cacheRoot: string = userDataPath) {
    this.accountsPath = path.join(userDataPath, "google-accounts.json");
    this.reclaimSettingsPath = path.join(userDataPath, "google-reclaim.json");
    this.cacheRoot = path.join(cacheRoot, "cloud-cache");
  }

  async initialize(config: GoogleConfig | null): Promise<void> {
    this.config = config;
    await fsPromises.mkdir(this.cacheRoot, { recursive: true });
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.accountsPath, "utf8");
    } catch {
      return; // First run, or the account file was cleared.
    }

    let stored: StoredAccount[];
    let legacyPlaintext = false;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { format?: unknown }).format ===
          "silo-google-accounts-encrypted"
      ) {
        const envelope = parsed as { version?: unknown; ciphertext?: unknown };
        if (envelope.version !== 1 || typeof envelope.ciphertext !== "string")
          throw new Error("Google token storage has an unsupported format.");
        if (!this.secureTokenStorageAvailable()) {
          this.storageWarning =
            "Google sign-in is locked because this system has no secure OS credential store. The saved account file was left untouched.";
          return;
        }
        const decrypted = safeStorage.decryptString(
          Buffer.from(envelope.ciphertext, "base64"),
        );
        stored = JSON.parse(decrypted) as StoredAccount[];
      } else if (Array.isArray(parsed)) {
        if (!this.secureTokenStorageAvailable()) {
          this.storageWarning =
            "Google sign-in is paused because saved tokens are not encrypted and this system has no secure OS credential store. The saved account file was left untouched.";
          return;
        }
        stored = parsed as StoredAccount[];
        legacyPlaintext = true;
      } else {
        throw new Error("Google account storage is invalid.");
      }
      if (!Array.isArray(stored))
        throw new Error("Google account storage is invalid.");
    } catch (error) {
      this.storageWarning =
        error instanceof Error
          ? `Google account storage could not be opened: ${error.message}`
          : "Google account storage could not be opened.";
      return;
    }

    for (const account of stored) {
      // Accounts saved before identity scopes were requested have no usable email.
      if (!account.email || account.email === "Google account") {
        account.needsReauth = true;
      }
      this.accounts.set(account.id, account);
    }
    if (legacyPlaintext) {
      try {
        await this.persist();
      } catch {
        this.storageWarning =
          "Google tokens were loaded from an older plaintext file, but Silo could not migrate it to OS-encrypted storage. Check file permissions before reconnecting.";
      }
    }
  }

  private secureTokenStorageAvailable(): boolean {
    try {
      return (
        safeStorage.isEncryptionAvailable() &&
        safeStorage.getSelectedStorageBackend() !== "basic_text"
      );
    } catch {
      return false;
    }
  }

  getState(): GoogleAccountsState {
    if (!this.config) {
      return {
        configured: false,
        accounts: [],
        allDrivesPath: ALL_DRIVES_PATH,
        allPhotosPath: ALL_PHOTOS_PATH,
        totalPickedCount: 0,
        message:
          "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env, then restart.",
      };
    }

    const accounts = Array.from(this.accounts.values()).map((account) => ({
      id: account.id,
      email: account.email,
      driveRootPath: this.buildPath(
        DRIVE_SEGMENT,
        account.id,
        "root",
        "My Drive",
      ),
      photosRootPath: this.buildPath(
        PHOTOS_SEGMENT,
        account.id,
        "picked",
        "Picked Photos",
      ),
      pickedCount: this.pickedItems.get(account.id)?.size ?? 0,
      needsReauth: Boolean(account.needsReauth),
      gmailAccess: Boolean(account.scopes?.includes(GMAIL_MODIFY_SCOPE)),
    }));

    return {
      configured: true,
      accounts,
      allDrivesPath: ALL_DRIVES_PATH,
      allPhotosPath: ALL_PHOTOS_PATH,
      totalPickedCount: accounts.reduce(
        (total, account) => total + account.pickedCount,
        0,
      ),
      message:
        accounts.length === 0
          ? "Add a Google account to browse Drive and Photos."
          : `${accounts.length} account${accounts.length === 1 ? "" : "s"} connected.`,
      ...(this.storageWarning ? { storageWarning: this.storageWarning } : {}),
    };
  }

  // -------------------------------------------------------------------- auth

  async addAccount(): Promise<GoogleAccountsState> {
    if (!this.config) return this.getState();
    if (!this.secureTokenStorageAvailable()) {
      this.storageWarning =
        "Google sign-in is disabled because this system has no secure OS credential store.";
      return {
        ...this.getState(),
        message: this.storageWarning,
        storageWarning: this.storageWarning,
      };
    }

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expectedState = randomBytes(24).toString("base64url");
    const redirect = new URL(this.config.redirectUri);
    const port = Number(redirect.port || 3001);

    const codePromise = this.waitForAuthCode(
      port,
      redirect.pathname,
      expectedState,
    );

    const authUrl = new URL(AUTH_ENDPOINT);
    authUrl.searchParams.set("client_id", this.config.clientId);
    authUrl.searchParams.set("redirect_uri", this.config.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    // select_account lets a second or third account be added.
    authUrl.searchParams.set("prompt", "consent select_account");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", expectedState);
    await shell.openExternal(authUrl.toString());

    let code: string;
    try {
      code = await codePromise;
    } catch (error) {
      return {
        ...this.getState(),
        message:
          error instanceof Error
            ? error.message
            : "Authorization was cancelled.",
      };
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: this.config.redirectUri,
      }),
    });

    if (!response.ok) {
      return {
        ...this.getState(),
        message: `Token exchange failed: ${await response.text()}`,
      };
    }

    const payload = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const email = await this.fetchEmail(payload.access_token);
    const id =
      email || createHash("sha1").update(payload.access_token).digest("hex");
    const existing = this.accounts.get(id);

    this.accounts.set(id, {
      id,
      email: email || "Google account",
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? existing?.refreshToken ?? null,
      expiresAt: Date.now() + payload.expires_in * 1000,
      needsReauth: false,
      scopes: payload.scope ? payload.scope.split(/\s+/).filter(Boolean) : existing?.scopes,
    });
    await this.persist();

    return {
      ...this.getState(),
      message: `${email || "Account"} connected.`,
    };
  }

  private waitForAuthCode(
    port: number,
    callbackPath: string,
    expectedState: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.closeAuthServer();
        reject(new Error("Timed out waiting for Google authorization."));
      }, 300000);

      const finish = (
        response: ServerResponse,
        body: string,
        outcome: () => void,
      ) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          `<html><body style="font-family:system-ui;background:#0b0b0c;color:#f4f1ed;display:grid;place-items:center;height:100vh;margin:0"><p>${body}</p></body></html>`,
        );
        clearTimeout(timer);
        this.closeAuthServer();
        outcome();
      };

      this.closeAuthServer();
      this.authServer = createServer((request, response) => {
        const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== callbackPath) {
          response.writeHead(404);
          response.end();
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          finish(
            response,
            "Authorization denied. You can close this tab.",
            () => reject(new Error(`Authorization denied: ${error}`)),
          );
          return;
        }
        if (url.searchParams.get("state") !== expectedState) {
          finish(response, "Invalid state. You can close this tab.", () =>
            reject(new Error("OAuth state mismatch.")),
          );
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          finish(response, "No code returned. You can close this tab.", () =>
            reject(new Error("No authorization code returned.")),
          );
          return;
        }
        finish(response, "Connected. You can close this tab.", () =>
          resolve(code),
        );
      });

      this.authServer.on("error", (serverError) => {
        clearTimeout(timer);
        reject(serverError);
      });
      this.authServer.listen(port, "127.0.0.1");
    });
  }

  private closeAuthServer(): void {
    this.authServer?.close();
    this.authServer = null;
  }

  async removeAccount(accountId: string): Promise<GoogleAccountsState> {
    const account = this.accounts.get(accountId);
    if (account?.refreshToken) {
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: account.refreshToken }),
      }).catch(() => undefined);
    }
    this.accounts.delete(accountId);
    this.pickedItems.delete(accountId);
    await this.persist();
    return this.getState();
  }

  private async persist(): Promise<void> {
    if (!this.secureTokenStorageAvailable())
      throw new Error(
        "Google tokens cannot be saved without secure OS credential storage.",
      );
    const plaintext = JSON.stringify(
      Array.from(this.accounts.values()),
      null,
      2,
    );
    const ciphertext = safeStorage.encryptString(plaintext).toString("base64");
    const envelope = JSON.stringify({
      format: "silo-google-accounts-encrypted",
      version: 1,
      ciphertext,
    });
    const temporaryPath = `${this.accountsPath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(temporaryPath, envelope, { mode: 0o600 });
    await fsPromises.chmod(temporaryPath, 0o600).catch(() => undefined);
    await fsPromises.rename(temporaryPath, this.accountsPath);
    this.storageWarning = null;
  }

  private async accessToken(accountId: string): Promise<string> {
    const account = this.accounts.get(accountId);
    if (!account || !this.config)
      throw new Error("That Google account is not connected.");
    if (Date.now() < account.expiresAt - 60000) return account.accessToken;

    if (!account.refreshToken) {
      account.needsReauth = true;
      await this.persist();
      throw new Error(`Sign in to ${account.email} again.`);
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      account.needsReauth = true;
      await this.persist();
      throw new Error(`Session expired for ${account.email}. Sign in again.`);
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };
    account.accessToken = payload.access_token;
    if (payload.scope) account.scopes = payload.scope.split(/\s+/).filter(Boolean);
    account.expiresAt = Date.now() + payload.expires_in * 1000;
    account.needsReauth = false;
    await this.persist();
    return account.accessToken;
  }

  private async fetchEmail(accessToken: string): Promise<string | null> {
    try {
      const response = await fetch(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!response.ok) return null;
      return ((await response.json()) as { email?: string }).email ?? null;
    } catch {
      return null;
    }
  }

  private async apiFetch(
    accountId: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const token = await this.accessToken(accountId);
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    });
  }

  // ------------------------------------------------------------ path helpers

  isCloudPath(candidate: string): boolean {
    return (
      typeof candidate === "string" && candidate.startsWith(`${CLOUD_PREFIX}/`)
    );
  }

  private buildPath(
    segment: string,
    accountId: string,
    id: string,
    name: string,
  ): string {
    return `${CLOUD_PREFIX}/${segment}/${encodeURIComponent(accountId)}/${encodeURIComponent(id)}/${name.replace(/\//g, "_")}`;
  }

  private parseCloudPath(candidate: string): {
    segment: string;
    accountId: string;
    id: string;
    name: string;
  } | null {
    if (!this.isCloudPath(candidate)) return null;
    const parts = candidate.slice(CLOUD_PREFIX.length + 1).split("/");
    if (parts.length < 3) return null;
    return {
      segment: parts[0],
      accountId: decodeURIComponent(parts[1]),
      id: decodeURIComponent(parts[2]),
      name: parts.slice(3).join("/"),
    };
  }

  // ------------------------------------------------------------------ listing

  async listFiles(
    virtualPath: string,
    exploded: boolean,
  ): Promise<CloudFileInfo[]> {
    if (virtualPath === ALL_DRIVES_PATH)
      return this.listAllDriveRoots(exploded);
    if (virtualPath === ALL_PHOTOS_PATH) return this.listAllPickedPhotos();

    const parsed = this.parseCloudPath(virtualPath);
    if (!parsed) return [];
    if (parsed.segment === PHOTOS_SEGMENT)
      return this.listPickedPhotos(parsed.accountId);
    if (parsed.segment !== DRIVE_SEGMENT) return [];

    return exploded
      ? this.listDriveRecursive(parsed.accountId, parsed.id)
      : this.listDriveChildren(parsed.accountId, parsed.id);
  }

  /** Lists files and directories with complete paths relative to the selected source. */
  async listFilesRecursively(
    virtualPath: string,
    onFile?: (file: CloudFileInfo) => void,
    isCancelled: () => boolean = () => false,
  ): Promise<CloudFileInfo[]> {
    if (virtualPath === ALL_PHOTOS_PATH) return this.listAllPickedPhotos(onFile, isCancelled);
    const parsed = this.parseCloudPath(virtualPath);
    if (!parsed) return [];
    if (parsed.segment === PHOTOS_SEGMENT)
      return this.listPickedPhotos(parsed.accountId, onFile, isCancelled);
    if (parsed.segment !== DRIVE_SEGMENT) return [];

    const entries: CloudFileInfo[] = [];
    const queue: Array<{ folderId: string; relativePath: string }> = [
      { folderId: parsed.id, relativePath: "" },
    ];
    const visited = new Set<string>();
    while (queue.length > 0) {
      if (isCancelled()) break;
      const current = queue.shift()!;
      if (visited.has(current.folderId)) continue;
      visited.add(current.folderId);
      for (const child of await this.listDriveChildren(
        parsed.accountId,
        current.folderId,
      )) {
        const relativePath = path.join(current.relativePath, child.name);
        const entry = { ...child, relativePath };
        if (onFile) onFile(entry);
        else entries.push(entry);
        if (child.isDirectory) {
          const childPath = this.parseCloudPath(child.path);
          if (childPath) queue.push({ folderId: childPath.id, relativePath });
        }
      }
    }
    return entries;
  }

  /** The aggregate view shows one folder per connected account. */
  private async listAllDriveRoots(exploded: boolean): Promise<CloudFileInfo[]> {
    if (!exploded) {
      return Array.from(this.accounts.values()).map((account) => ({
        name: account.email,
        path: this.buildPath(DRIVE_SEGMENT, account.id, "root", account.email),
        relativePath: account.email,
        size: 0,
        modified: Date.now(),
        isDirectory: true,
        type: "folder",
        extension: "",
      }));
    }

    const files: CloudFileInfo[] = [];
    for (const account of this.accounts.values()) {
      try {
        files.push(...(await this.listDriveRecursive(account.id, "root")));
      } catch {
        // Skip accounts that need re-authentication.
      }
    }
    return files;
  }

  private listAllPickedPhotos(
    onFile?: (file: CloudFileInfo) => void,
    isCancelled: () => boolean = () => false,
  ): CloudFileInfo[] {
    const files: CloudFileInfo[] = [];
    for (const accountId of this.pickedItems.keys()) {
      if (isCancelled()) break;
      if (onFile) this.listPickedPhotos(accountId, onFile, isCancelled);
      else files.push(...this.listPickedPhotos(accountId, undefined, isCancelled));
    }
    return files;
  }

  private async listDriveChildren(
    accountId: string,
    folderId: string,
  ): Promise<CloudFileInfo[]> {
    const results: CloudFileInfo[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
      url.searchParams.set(
        "fields",
        "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
      );
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await this.apiFetch(accountId, url.toString());
      if (!response.ok) {
        const details = (await response.json().catch(() => null)) as {
          error?: {
            errors?: Array<{ reason?: string }>;
            details?: Array<{ reason?: string }>;
          };
        } | null;
        const reasons = [
          ...(details?.error?.errors ?? []),
          ...(details?.error?.details ?? []),
        ].map((item) => item.reason);
        if (
          response.status === 403 &&
          reasons.some(
            (reason) =>
              reason === "insufficientPermissions" ||
              reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
          )
        ) {
          const account = this.accounts.get(accountId);
          if (account) {
            account.needsReauth = true;
            await this.persist();
          }
          throw new Error(
            "DRIVE_PERMISSION_REQUIRED: Reconnect this Google account and approve Google Drive access. Automatic retries will resume after authorization.",
          );
        }
        throw new Error(
          `Drive request failed: ${response.status}${reasons.filter(Boolean).length ? ` (${reasons.filter(Boolean).join(", ")})` : ""}`,
        );
      }

      const payload = (await response.json()) as {
        nextPageToken?: string;
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          size?: string;
          modifiedTime?: string;
        }>;
      };

      for (const file of payload.files) {
        const isDirectory =
          file.mimeType === "application/vnd.google-apps.folder";
        results.push({
          name: file.name,
          path: this.buildPath(DRIVE_SEGMENT, accountId, file.id, file.name),
          relativePath: file.name,
          size: Number(file.size ?? 0),
          modified: file.modifiedTime
            ? new Date(file.modifiedTime).getTime()
            : 0,
          isDirectory,
          type: classifyCloudFile(file.mimeType, file.name),
          extension: isDirectory ? "" : path.extname(file.name).toLowerCase(),
        });
      }
      pageToken = payload.nextPageToken;
    } while (pageToken);

    return results;
  }

  private async listDriveRecursive(
    accountId: string,
    rootId: string,
  ): Promise<CloudFileInfo[]> {
    const files: CloudFileInfo[] = [];
    const queue: Array<{ folderId: string; relativePath: string }> = [
      { folderId: rootId, relativePath: "" },
    ];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const { folderId, relativePath } = queue.shift()!;
      if (seen.has(folderId)) continue;
      seen.add(folderId);

      const children = await this.listDriveChildren(accountId, folderId);
      for (const child of children) {
        const childRelativePath = path.join(relativePath, child.name);
        if (child.isDirectory) {
          const parsed = this.parseCloudPath(child.path);
          if (parsed)
            queue.push({
              folderId: parsed.id,
              relativePath: childRelativePath,
            });
        } else {
          files.push({ ...child, relativePath: childRelativePath });
        }
      }
    }
    return files;
  }

  // --------------------------------------------------------------- drive edit

  async createDriveFolder(parentPath: string, name: string): Promise<void> {
    const parsed = this.parseCloudPath(parentPath);
    if (!parsed) throw new Error("Invalid Drive folder.");
    const response = await this.apiFetch(
      parsed.accountId,
      `${DRIVE_API}/files`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parsed.id],
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Could not create folder: ${response.status}`);
  }

  async renameDriveFile(filePath: string, name: string): Promise<void> {
    const parsed = this.parseCloudPath(filePath);
    if (!parsed) throw new Error("Invalid Drive file.");
    const response = await this.apiFetch(
      parsed.accountId,
      `${DRIVE_API}/files/${encodeURIComponent(parsed.id)}?supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (!response.ok)
      throw new Error(`Could not rename file: ${response.status}`);
  }

  async trashDriveFile(filePath: string): Promise<void> {
    const parsed = this.parseCloudPath(filePath);
    if (!parsed) throw new Error("Invalid Drive file.");
    const response = await this.apiFetch(
      parsed.accountId,
      `${DRIVE_API}/files/${encodeURIComponent(parsed.id)}?supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      },
    );
    if (!response.ok)
      throw new Error(`Could not trash file: ${response.status}`);
  }

  async uploadToDrive(parentPath: string, localPath: string): Promise<void> {
    const parsed = this.parseCloudPath(parentPath);
    if (!parsed) throw new Error("Invalid Drive folder.");
    const contents = await fsPromises.readFile(localPath);
    const boundary = `boundary${randomBytes(12).toString("hex")}`;
    const metadata = JSON.stringify({
      name: path.basename(localPath),
      parents: [parsed.id],
    });

    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      contents,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const response = await this.apiFetch(
      parsed.accountId,
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  }

  // ----------------------------------------------------------------- reclaim

  /** Turns a failed Google response into a short, actionable message. */
  private async describeFailure(accountId: string, response: Response, action: string): Promise<string> {
    const details = (await response.json().catch(() => null)) as {
      error?: { message?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> };
    } | null;
    const reasons = [...(details?.error?.errors ?? []), ...(details?.error?.details ?? [])]
      .map((item) => item.reason ?? "");
    if (response.status === 401 || reasons.some((reason) => reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
      const account = this.accounts.get(accountId);
      if (account) { account.needsReauth = true; await this.persist(); }
      return `Reconnect this Google account and approve access to ${action}.`;
    }
    if (reasons.includes("insufficientFilePermissions") || reasons.includes("cannotTrash") || reasons.includes("cannotModifyTrashedState"))
      return "Only files you own can be moved to trash.";
    if (response.status === 404) return "It no longer exists in Google.";
    if (response.status === 429 || reasons.includes("rateLimitExceeded") || reasons.includes("userRateLimitExceeded"))
      return "Google is rate limiting requests. Try again in a minute.";
    return details?.error?.message || `Google returned ${response.status}.`;
  }

  async getReclaimDestination(): Promise<string | null> {
    try {
      const stored = JSON.parse(await fsPromises.readFile(this.reclaimSettingsPath, "utf8")) as { destination?: unknown };
      return typeof stored.destination === "string" && path.isAbsolute(stored.destination) ? stored.destination : null;
    } catch {
      return null;
    }
  }

  async setReclaimDestination(destination: string): Promise<void> {
    if (!path.isAbsolute(destination)) throw new Error("Choose an absolute folder.");
    await fsPromises.writeFile(this.reclaimSettingsPath, JSON.stringify({ destination }, null, 2), { mode: 0o600 });
  }

  gmailTrashUrl(accountId: string): string {
    const email = this.accounts.get(accountId)?.email ?? "";
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#trash`;
  }

  async getStorageQuota(accountId: string): Promise<GoogleStorageQuota> {
    const response = await this.apiFetch(accountId, `${DRIVE_API}/about?fields=storageQuota`);
    if (!response.ok) throw new Error(await this.describeFailure(accountId, response, "Google Drive"));
    const { storageQuota: quota } = (await response.json()) as {
      storageQuota: { limit?: string; usage?: string; usageInDrive?: string; usageInDriveTrash?: string };
    };
    return {
      limit: quota.limit ? Number(quota.limit) : null,
      usage: Number(quota.usage ?? 0),
      usageInDrive: Number(quota.usageInDrive ?? 0),
      usageInDriveTrash: Number(quota.usageInDriveTrash ?? 0),
    };
  }

  /** Largest files this account owns; native Docs/Sheets are skipped because a PDF copy is not a faithful backup. */
  async listLargeDriveFiles(accountId: string, limit = 200): Promise<GoogleReclaimItem[]> {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("q", "'me' in owners and trashed = false and not mimeType contains 'application/vnd.google-apps.'");
    url.searchParams.set("orderBy", "quotaBytesUsed desc");
    url.searchParams.set("pageSize", String(limit));
    url.searchParams.set("fields", "files(id, name, mimeType, size, quotaBytesUsed, modifiedTime)");
    const response = await this.apiFetch(accountId, url.toString());
    if (!response.ok) throw new Error(await this.describeFailure(accountId, response, "Google Drive"));
    const payload = (await response.json()) as {
      files: Array<{ id: string; name: string; mimeType: string; size?: string; quotaBytesUsed?: string; modifiedTime?: string }>;
    };
    return payload.files
      .filter((file) => !file.mimeType.startsWith("application/vnd.google-apps."))
      .map((file) => ({
        id: file.id,
        kind: "drive" as const,
        name: file.name,
        detail: file.mimeType,
        size: Number(file.quotaBytesUsed ?? file.size ?? 0),
        modified: file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0,
      }))
      .filter((file) => file.size > 0);
  }

  /** Emails over 5 MB, largest first. */
  async listLargeEmails(accountId: string, limit = 100): Promise<GoogleReclaimItem[]> {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set("q", LARGE_EMAIL_QUERY);
    url.searchParams.set("maxResults", String(limit));
    const response = await this.apiFetch(accountId, url.toString());
    if (!response.ok) throw new Error(await this.describeFailure(accountId, response, "Gmail"));
    const { messages = [] } = (await response.json()) as { messages?: Array<{ id: string }> };
    const items: GoogleReclaimItem[] = [];
    for (let index = 0; index < messages.length; index += 10) {
      const batch = await Promise.all(messages.slice(index, index + 10).map(async ({ id }): Promise<GoogleReclaimItem | null> => {
        const detail = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
        detail.searchParams.set("format", "metadata");
        for (const header of ["Subject", "From"]) detail.searchParams.append("metadataHeaders", header);
        const message = await this.apiFetch(accountId, detail.toString());
        if (!message.ok) return null;
        const payload = (await message.json()) as {
          sizeEstimate?: number; internalDate?: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
        };
        const header = (name: string) => payload.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
        return {
          id,
          kind: "gmail",
          name: header("Subject") || "(no subject)",
          detail: header("From"),
          size: payload.sizeEstimate ?? 0,
          modified: Number(payload.internalDate ?? 0),
        };
      }));
      items.push(...batch.filter((item): item is GoogleReclaimItem => item !== null));
    }
    return items.sort((a, b) => b.size - a.size);
  }

  /** Accounts connected before scopes were saved: ask Google what this token can do. */
  private async loadGrantedScopes(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    try {
      const token = await this.accessToken(accountId);
      if (account.scopes) return;
      const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
      if (!response.ok) return;
      const { scope } = (await response.json()) as { scope?: string };
      if (!scope) return;
      account.scopes = scope.split(/\s+/).filter(Boolean);
      await this.persist();
    } catch {
      // The overview reports connection problems itself.
    }
  }

  async getReclaimOverview(accountId: string): Promise<GoogleReclaimOverview> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("That Google account is not connected.");
    if (!account.scopes) await this.loadGrantedScopes(accountId);
    const gmailAccess = Boolean(account.scopes?.includes(GMAIL_MODIFY_SCOPE));
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const [storage, drive, gmail] = await Promise.allSettled([
      this.getStorageQuota(accountId),
      this.listLargeDriveFiles(accountId),
      gmailAccess ? this.listLargeEmails(accountId) : Promise.reject(new Error("Reconnect this Google account and allow Gmail access to free up email space.")),
    ]);
    return {
      accountId,
      email: account.email,
      storage: storage.status === "fulfilled" ? storage.value : null,
      driveFiles: drive.status === "fulfilled" ? drive.value : [],
      emails: gmail.status === "fulfilled" ? gmail.value : [],
      gmailAccess,
      driveError: drive.status === "rejected" ? message(drive.reason) : storage.status === "rejected" ? message(storage.reason) : undefined,
      gmailError: gmail.status === "rejected" ? message(gmail.reason) : undefined,
      destination: await this.getReclaimDestination(),
    };
  }

  /** Writes a stream to `target` via a partial file, returning its byte count and MD5. */
  private async writeVerified(target: string, chunks: AsyncIterable<Uint8Array>): Promise<{ bytes: number; md5: string }> {
    const partial = `${target}.silo-partial`;
    const hash = createHash("md5");
    let bytes = 0;
    const handle = await fsPromises.open(partial, "w");
    try {
      for await (const chunk of chunks) {
        await handle.write(chunk);
        hash.update(chunk);
        bytes += chunk.byteLength;
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsPromises.rm(partial, { force: true });
      throw error;
    }
    await handle.close();
    return { bytes, md5: hash.digest("hex") };
  }

  private async uniqueTarget(directory: string, name: string, id: string): Promise<string> {
    const safe = name.replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim().slice(0, 180) || id;
    const first = path.join(directory, safe);
    try { await fsPromises.access(first); } catch { return first; }
    const extension = path.extname(safe);
    return path.join(directory, `${safe.slice(0, safe.length - extension.length)} (${id.slice(0, 8)})${extension}`);
  }

  private async backupDriveFile(accountId: string, id: string, directory: string): Promise<{ name: string; bytes: number }> {
    const metaResponse = await this.apiFetch(accountId, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=name,mimeType,size,md5Checksum,ownedByMe,trashed&supportsAllDrives=true`);
    if (!metaResponse.ok) throw new Error(await this.describeFailure(accountId, metaResponse, "Google Drive"));
    const meta = (await metaResponse.json()) as { name: string; mimeType: string; size?: string; md5Checksum?: string; ownedByMe?: boolean; trashed?: boolean };
    if (meta.trashed) throw new Error("It is already in Google Drive trash.");
    if (meta.ownedByMe === false) throw new Error("Only files you own can be moved to trash.");
    if (meta.mimeType.startsWith("application/vnd.google-apps.")) throw new Error("Google Docs, Sheets and Slides are skipped.");
    const download = await this.apiFetch(accountId, `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    if (!download.ok || !download.body) throw new Error(await this.describeFailure(accountId, download, "Google Drive"));
    const target = await this.uniqueTarget(directory, meta.name, id);
    const written = await this.writeVerified(target, download.body as unknown as AsyncIterable<Uint8Array>);
    const expectedSize = meta.size === undefined ? null : Number(meta.size);
    if ((expectedSize !== null && written.bytes !== expectedSize) || (meta.md5Checksum && written.md5 !== meta.md5Checksum)) {
      await fsPromises.rm(`${target}.silo-partial`, { force: true });
      throw new Error("The downloaded copy did not match Google's checksum, so it was not trashed.");
    }
    await fsPromises.rename(`${target}.silo-partial`, target);
    return { name: meta.name, bytes: written.bytes };
  }

  private async backupEmail(accountId: string, id: string, directory: string): Promise<{ name: string; bytes: number }> {
    const response = await this.apiFetch(accountId, `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=raw`);
    if (!response.ok) throw new Error(await this.describeFailure(accountId, response, "Gmail"));
    const message = (await response.json()) as { raw?: string; internalDate?: string; sizeEstimate?: number };
    if (!message.raw) throw new Error("Gmail did not return the message contents.");
    const raw = Buffer.from(message.raw, "base64url");
    const subject = /^Subject:\s*(.*)$/im.exec(raw.subarray(0, 65536).toString("utf8"))?.[1]?.trim() || "(no subject)";
    const date = new Date(Number(message.internalDate ?? Date.now())).toISOString().slice(0, 10);
    const target = await this.uniqueTarget(directory, `${date} ${subject}.eml`, id);
    const expected = createHash("md5").update(raw).digest("hex");
    const written = await this.writeVerified(target, (async function* () { yield raw; })());
    const reread = createHash("md5").update(await fsPromises.readFile(`${target}.silo-partial`)).digest("hex");
    if (written.bytes !== raw.length || written.md5 !== expected || reread !== expected) {
      await fsPromises.rm(`${target}.silo-partial`, { force: true });
      throw new Error("The saved email did not verify, so it was not trashed.");
    }
    await fsPromises.rename(`${target}.silo-partial`, target);
    return { name: subject, bytes: raw.length };
  }

  /** Saves a verified local copy of each item, then moves only verified items to Google's trash. */
  async backupAndTrash(
    accountId: string,
    items: Array<{ id: string; kind: GoogleReclaimKind }>,
    onProgress: (progress: GoogleReclaimProgress) => void,
    isCancelled: () => boolean,
  ): Promise<GoogleReclaimResult> {
    const account = this.accounts.get(accountId);
    if (!account) return { ok: false, trashed: 0, bytes: 0, failed: [], destination: null, error: "That Google account is not connected." };
    const destination = await this.getReclaimDestination();
    if (!destination) return { ok: false, trashed: 0, bytes: 0, failed: [], destination, error: "Choose a backup folder first." };
    const accountFolder = path.join(destination, account.email.replace(/[\/\\:*?"<>|]/g, "_"));
    const folders = { drive: path.join(accountFolder, "Google Drive"), gmail: path.join(accountFolder, "Gmail") };
    try {
      await fsPromises.mkdir(folders.drive, { recursive: true });
      await fsPromises.mkdir(folders.gmail, { recursive: true });
    } catch (error) {
      return { ok: false, trashed: 0, bytes: 0, failed: [], destination, error: `Silo cannot write to ${destination}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const failed: GoogleReclaimResult["failed"] = [];
    let trashed = 0;
    let bytes = 0;
    for (const [index, item] of items.entries()) {
      if (isCancelled()) return { ok: failed.length === 0, canceled: true, trashed, bytes, failed, destination };
      onProgress({ accountId, done: index, total: items.length, bytes, current: item.kind === "gmail" ? "Saving email…" : "Saving file…" });
      let saved: { name: string; bytes: number } | null = null;
      try {
        saved = item.kind === "gmail"
          ? await this.backupEmail(accountId, item.id, folders.gmail)
          : await this.backupDriveFile(accountId, item.id, folders.drive);
        onProgress({ accountId, done: index, total: items.length, bytes, current: `Moving “${saved.name}” to trash…` });
        const response = item.kind === "gmail"
          ? await this.apiFetch(accountId, `${GMAIL_API}/messages/${encodeURIComponent(item.id)}/trash`, { method: "POST" })
          : await this.apiFetch(accountId, `${DRIVE_API}/files/${encodeURIComponent(item.id)}?supportsAllDrives=true`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
          });
        if (!response.ok) throw new Error(`Saved locally, but not trashed: ${await this.describeFailure(accountId, response, item.kind === "gmail" ? "Gmail" : "Google Drive")}`);
        trashed += 1;
        bytes += saved.bytes;
      } catch (error) {
        failed.push({ id: item.id, name: saved?.name ?? item.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    onProgress({ accountId, done: items.length, total: items.length, bytes, current: "Done" });
    return { ok: failed.length === 0, trashed, bytes, failed, destination };
  }

  /** Permanently empties this account's Drive trash; this is what returns Drive space. */
  async emptyDriveTrash(accountId: string): Promise<void> {
    const response = await this.apiFetch(accountId, `${DRIVE_API}/files/trash`, { method: "DELETE" });
    if (!response.ok) throw new Error(await this.describeFailure(accountId, response, "Google Drive"));
  }

  // ------------------------------------------------------------------ photos

  async startPhotoPicker(
    accountId: string,
  ): Promise<{ pickerUri: string; sessionId: string; accountId: string }> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("That Google account is not connected.");

    const response = await this.apiFetch(accountId, `${PICKER_API}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok)
      throw new Error(
        `Could not start the Photos picker: ${response.status} ${await response.text()}`,
      );

    const payload = (await response.json()) as {
      id: string;
      pickerUri: string;
    };

    // The browser may be signed into a different account than the session owner.
    const pickerUrl = new URL(payload.pickerUri);
    if (account.email.includes("@")) {
      pickerUrl.searchParams.set("authuser", account.email);
    }

    await shell.openExternal(pickerUrl.toString());
    return {
      pickerUri: pickerUrl.toString(),
      sessionId: payload.id,
      accountId,
    };
  }

  async pollPhotoPicker(
    accountId: string,
    sessionId: string,
  ): Promise<{ ready: boolean; count: number }> {
    const current = this.pickedItems.get(accountId)?.size ?? 0;
    const response = await this.apiFetch(
      accountId,
      `${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) return { ready: false, count: current };

    const payload = (await response.json()) as { mediaItemsSet?: boolean };
    if (!payload.mediaItemsSet) return { ready: false, count: current };

    await this.collectPickedItems(accountId, sessionId);
    return { ready: true, count: this.pickedItems.get(accountId)?.size ?? 0 };
  }

  private async collectPickedItems(
    accountId: string,
    sessionId: string,
  ): Promise<void> {
    let bucket = this.pickedItems.get(accountId);
    if (!bucket) {
      bucket = new Map<string, PickedMediaItem>();
      this.pickedItems.set(accountId, bucket);
    }

    let pageToken: string | undefined;
    do {
      const url = new URL(`${PICKER_API}/mediaItems`);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await this.apiFetch(accountId, url.toString());
      if (!response.ok) return;

      const payload = (await response.json()) as {
        nextPageToken?: string;
        mediaItems?: Array<{
          id: string;
          createTime?: string;
          mediaFile?: { baseUrl: string; mimeType: string; filename: string };
        }>;
      };

      for (const item of payload.mediaItems ?? []) {
        if (!item.mediaFile) continue;
        bucket.set(item.id, {
          id: item.id,
          name: item.mediaFile.filename || `${item.id}.jpg`,
          baseUrl: item.mediaFile.baseUrl,
          mimeType: item.mediaFile.mimeType,
          modified: item.createTime ? new Date(item.createTime).getTime() : 0,
        });
      }
      pageToken = payload.nextPageToken;
    } while (pageToken);
  }

  private listPickedPhotos(
    accountId: string,
    onFile?: (file: CloudFileInfo) => void,
    isCancelled: () => boolean = () => false,
  ): CloudFileInfo[] {
    const bucket = this.pickedItems.get(accountId);
    if (!bucket) return [];
    const files: CloudFileInfo[] = [];
    for (const item of bucket.values()) {
      if (isCancelled()) break;
      const file: CloudFileInfo = {
        name: item.name,
        path: this.buildPath(PHOTOS_SEGMENT, accountId, item.id, item.name),
        relativePath: item.name,
        size: 0,
        modified: item.modified,
        isDirectory: false,
        type: classifyCloudFile(item.mimeType, item.name),
        extension: path.extname(item.name).toLowerCase(),
      };
      if (onFile) onFile(file);
      else files.push(file);
    }
    return files;
  }

  clearPickedPhotos(accountId?: string): void {
    if (accountId) this.pickedItems.delete(accountId);
    else this.pickedItems.clear();
  }

  // -------------------------------------------------------------- downloads

  /** Downloads a cloud file into the local cache so normal file code paths work. */
  async materialize(virtualPath: string): Promise<string> {
    const parsed = this.parseCloudPath(virtualPath);
    if (!parsed) return virtualPath;

    const localPath = path.join(
      this.cacheRoot,
      parsed.segment,
      createHash("sha1")
        .update(`${parsed.accountId}:${parsed.id}`)
        .digest("hex"),
      parsed.name || parsed.id,
    );

    try {
      await fsPromises.access(localPath);
      return localPath;
    } catch {
      await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
    }

    const response =
      parsed.segment === PHOTOS_SEGMENT
        ? await this.fetchPickedPhoto(parsed.accountId, parsed.id)
        : await this.fetchDriveFile(parsed.accountId, parsed.id);
    if (!response.ok)
      throw new Error(`Could not download ${parsed.name}: ${response.status}`);

    await fsPromises.writeFile(
      localPath,
      Buffer.from(await response.arrayBuffer()),
    );
    return localPath;
  }

  private async fetchPickedPhoto(
    accountId: string,
    itemId: string,
  ): Promise<Response> {
    const item = this.pickedItems.get(accountId)?.get(itemId);
    if (!item)
      throw new Error("This photo is no longer in the picked session.");
    const suffix = item.mimeType.startsWith("video/") ? "dv" : "d";
    return this.apiFetch(accountId, `${item.baseUrl}=${suffix}`);
  }

  private async fetchDriveFile(
    accountId: string,
    fileId: string,
  ): Promise<Response> {
    const metadata = await this.apiFetch(
      accountId,
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=mimeType&supportsAllDrives=true`,
    );
    const mimeType = metadata.ok
      ? ((await metadata.json()) as { mimeType: string }).mimeType
      : "";

    const exportType = GOOGLE_EXPORT_TYPES[mimeType];
    if (exportType) {
      return this.apiFetch(
        accountId,
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportType)}`,
      );
    }
    return this.apiFetch(
      accountId,
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    );
  }

  async statCloudFile(virtualPath: string): Promise<CloudFileInfo | null> {
    const parsed = this.parseCloudPath(virtualPath);
    if (!parsed) return null;

    if (parsed.segment === PHOTOS_SEGMENT) {
      const item = this.pickedItems.get(parsed.accountId)?.get(parsed.id);
      if (!item) return null;
      return {
        name: item.name,
        path: virtualPath,
        relativePath: item.name,
        size: 0,
        modified: item.modified,
        isDirectory: false,
        type: classifyCloudFile(item.mimeType, item.name),
        extension: path.extname(item.name).toLowerCase(),
      };
    }

    const response = await this.apiFetch(
      parsed.accountId,
      `${DRIVE_API}/files/${encodeURIComponent(parsed.id)}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`,
    );
    if (!response.ok) return null;

    const file = (await response.json()) as {
      name: string;
      mimeType: string;
      size?: string;
      modifiedTime?: string;
    };
    const isDirectory = file.mimeType === "application/vnd.google-apps.folder";
    return {
      name: file.name,
      path: virtualPath,
      relativePath: file.name,
      size: Number(file.size ?? 0),
      modified: file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0,
      isDirectory,
      type: classifyCloudFile(file.mimeType, file.name),
      extension: isDirectory ? "" : path.extname(file.name).toLowerCase(),
    };
  }
}
