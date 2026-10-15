import archiver from "archiver";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "http";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import {
  IndexedShareFile,
  IndexedShareRootIdentity,
  openIndexedShareFile,
} from "./indexedShareResolver";
import { LIBRARY_SHARE_PAGE } from "./librarySharePage";

const mime = require("mime") as { getType(filePath: string): string | null };
const MAX_PAGE_SIZE = 72;
const MAX_DOWNLOAD_ITEMS = 10_000;
const MAX_REQUEST_BODY = 1_000_000;
const MAX_SHARED_SOURCES = 20;
const imageSvgExtension = ".svg";

export type LibraryShareSelection =
  | { type: "source"; id: string }
  | { type: "folder"; id: string };

export interface LibraryShareSource {
  id: string;
  label: string;
  rootPath: string;
  kind: string;
  available: boolean;
}

interface ShareNetworkInterface {
  address: string;
  netmask: string;
}

interface ShareSourceSnapshot extends LibraryShareSource {
  canonicalRoot: string;
  publicId: string;
  rootIdentity: IndexedShareRootIdentity;
  selectionKey: string;
  folderId?: string;
  allowedPaths?: Set<string>;
}

interface ShareDigitalFolder {
  id: string;
  name: string;
  filePaths: string[];
  hidden?: boolean;
}

interface ShareContext {
  token: string;
  sources: ShareSourceSnapshot[];
  network: ShareNetworkInterface;
  port: number;
  server: Server;
  transfers: Map<string, { ids: string[] | null; expiresAt: number }>;
}

export interface LibraryShareServerOptions {
  getSources(): Promise<LibraryShareSource[]>;
  getDigitalFolders(): Promise<ShareDigitalFolder[]>;
  getIndexedFiles(sourceRoots: string[]): IndexedShareFile[];
  search(query: string, sourceRoots: string[]): Promise<IndexedShareFile[]>;
  getThumbnail(filePath: string): Promise<Buffer | null>;
  networkInterface?: ShareNetworkInterface;
}

export interface LibraryShareStatus {
  active: boolean;
  url?: string;
  sources: Array<{ id: string; label: string }>;
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)))
    return null;
  const bytes = parts.map(Number);
  if (bytes.some((part) => part < 0 || part > 255)) return null;
  return (
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  );
}

function isPrivateIPv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  return (
    (value >>> 24) === 10 ||
    (value >>> 16) === 0xa9fe ||
    (value >>> 20) === 0xac1 ||
    (value >>> 16) === 0xc0a8
  );
}

function getLanInterface(): ShareNetworkInterface {
  const interfaces = os.networkInterfaces();
  const candidates: Array<{ name: string; address: string; netmask: string }> = [];
  for (const [name, entries] of Object.entries(interfaces))
    for (const entry of entries ?? [])
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        isPrivateIPv4(entry.address) &&
        ipv4Number(entry.netmask) !== null
      )
        candidates.push({ name, address: entry.address, netmask: entry.netmask });
  candidates.sort((left, right) => {
    const preferred = (name: string) => (/^en\d+$/.test(name) ? 0 : 1);
    return preferred(left.name) - preferred(right.name);
  });
  const selected = candidates[0];
  if (!selected)
    throw new Error("Connect this Mac to a private Wi-Fi or Ethernet network before sharing.");
  return { address: selected.address, netmask: selected.netmask };
}

function normalizeRemoteIPv4(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isOnShareSubnet(remoteAddress: string | undefined, network: ShareNetworkInterface): boolean {
  if (!remoteAddress) return false;
  const remote = ipv4Number(normalizeRemoteIPv4(remoteAddress));
  const host = ipv4Number(network.address);
  const mask = ipv4Number(network.netmask);
  return remote !== null && host !== null && mask !== null && (remote & mask) === (host & mask);
}

function itemId(token: string, selectionKey: string, rootPath: string, relativePath: string): string {
  return createHmac("sha256", token)
    .update(`${selectionKey}\0${rootPath}\0${relativePath}`)
    .digest("base64url")
    .slice(0, 24);
}

function sourceId(token: string, selectionKey: string, rootPath: string): string {
  return createHmac("sha256", token)
    .update(`source\0${selectionKey}\0${rootPath}`)
    .digest("base64url")
    .slice(0, 20);
}

function mediaType(file: IndexedShareFile): "image" | "video" | null {
  const extension = file.extension || path.extname(file.name);
  if (extension.toLowerCase() === imageSvgExtension) return null;
  const mimeType = mime.getType(file.name) ?? mime.getType(extension);
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  return null;
}

function safeFolder(value: string): string | null {
  if (!value) return "";
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function setBaseHeaders(response: ServerResponse) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("x-frame-options", "DENY");
}

function attachmentName(name: string): string {
  const safe = name.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "photo";
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return "invalid";
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    const suffixLength = Number(match[2]);
    if (!suffixLength) return "invalid";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return "invalid";
  return { start, end };
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY) throw new Error("Download selection is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function comparableName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 100) || "Library";
}

export class LibraryShareServer {
  private context: ShareContext | null = null;

  constructor(private readonly options: LibraryShareServerOptions) {}

  getStatus(): LibraryShareStatus {
    if (!this.context) return { active: false, sources: [] };
    return {
      active: true,
      url: `http://${this.context.network.address}:${this.context.port}/share/${this.context.token}`,
      sources: this.context.sources.map(({ publicId, label }) => ({ id: publicId, label })),
    };
  }

  async start(selections: LibraryShareSelection[]): Promise<LibraryShareStatus> {
    if (this.context) await this.stop();
    if (!Array.isArray(selections) || selections.length === 0)
      throw new Error("Choose at least one local library or virtual folder to share.");
    if (selections.length > MAX_SHARED_SOURCES)
      throw new Error(`Choose no more than ${MAX_SHARED_SOURCES} libraries or folders.`);

    const [allSources, allFolders] = await Promise.all([
      this.options.getSources(),
      this.options.getDigitalFolders(),
    ]);
    const validSelections = selections.filter((selection): selection is LibraryShareSelection =>
      selection && typeof selection === "object" &&
      (selection.type === "source" || selection.type === "folder") &&
      typeof selection.id === "string" && selection.id.length > 0,
    );
    if (validSelections.length !== selections.length)
      throw new Error("A selected library or virtual folder is invalid.");
    const selectionKeys = validSelections.map(({ type, id }) => `${type}:${id}`);
    if (new Set(selectionKeys).size !== selectionKeys.length)
      throw new Error("A library or virtual folder was selected more than once.");

    const localSources = allSources.filter((source) =>
      source.kind === "local" && source.available,
    );
    const sources: ShareSourceSnapshot[] = [];
    const addSourceSnapshot = async (
      source: LibraryShareSource,
      selectionKey: string,
      label: string,
      folderId?: string,
      allowedPaths?: Set<string>,
    ) => {
      if (source.kind !== "local" || !source.available)
        throw new Error("Only available local libraries can be shared.");
      const canonicalRoot = await fsPromises.realpath(source.rootPath);
      const rootStat = await fsPromises.stat(canonicalRoot);
      if (!rootStat.isDirectory())
        throw new Error("A selected library is no longer a folder.");
      sources.push({
        ...source,
        label,
        canonicalRoot,
        publicId: "",
        rootIdentity: { device: rootStat.dev, inode: rootStat.ino },
        selectionKey,
        ...(folderId ? { folderId } : {}),
        ...(allowedPaths ? { allowedPaths } : {}),
      });
    };

    for (const selection of validSelections) {
      const selectionKey = `${selection.type}:${selection.id}`;
      if (selection.type === "source") {
        const source = localSources.find((candidate) => candidate.id === selection.id);
        if (!source) throw new Error("Only available local libraries can be shared.");
        await addSourceSnapshot(source, selectionKey, source.label);
        continue;
      }

      const folder = allFolders.find((candidate) => candidate.id === selection.id && !candidate.hidden);
      if (!folder) throw new Error("That virtual folder is no longer available to share.");
      const pathsBySource = new Map<string, Set<string>>();
      for (const rawPath of folder.filePaths) {
        if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) continue;
        const memberPath = path.resolve(rawPath);
        const source = localSources
          .filter((candidate) => {
            const relative = path.relative(path.resolve(candidate.rootPath), memberPath);
            return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
          })
          .sort((left, right) => path.resolve(right.rootPath).length - path.resolve(left.rootPath).length)[0];
        if (!source) continue;
        const paths = pathsBySource.get(source.id) ?? new Set<string>();
        paths.add(memberPath);
        pathsBySource.set(source.id, paths);
      }
      if (!pathsBySource.size)
        throw new Error(`“${folder.name}” has no indexed files inside available local libraries.`);
      for (const [sourceId, allowedPaths] of pathsBySource) {
        const source = localSources.find((candidate) => candidate.id === sourceId)!;
        await addSourceSnapshot(
          source,
          selectionKey,
          `${folder.name} · ${source.label}`,
          folder.id,
          allowedPaths,
        );
      }
    }

    if (!sources.length)
      throw new Error("No available local libraries or virtual folders were found.");
    if (sources.length > MAX_SHARED_SOURCES)
      throw new Error(`The selection spans more than ${MAX_SHARED_SOURCES} local libraries.`);

    const sourceLabelCounts = new Map<string, number>();
    for (const source of sources) {
      const baseLabel = comparableName(source.label);
      const count = (sourceLabelCounts.get(baseLabel) ?? 0) + 1;
      sourceLabelCounts.set(baseLabel, count);
      source.label = count === 1 ? baseLabel : `${baseLabel} (${count})`;
    }

    const network = this.options.networkInterface ?? getLanInterface();
    if ((!isPrivateIPv4(network.address) && !this.options.networkInterface) || ipv4Number(network.netmask) === null)
      throw new Error("Silo can share only through a private local network.");
    const token = randomBytes(32).toString("base64url");
    for (const source of sources)
      source.publicId = sourceId(token, source.selectionKey, source.rootPath);

    const server = createServer((request, response) => {
      setBaseHeaders(response);
      void this.handleRequest(request, response, token).catch((error) => {
        if (response.headersSent) response.destroy();
        else json(response, 500, { error: error instanceof Error ? error.message : "Share request failed." });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, network.address, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Silo could not start the local sharing server.");
    }
    this.context = {
      token,
      sources,
      network,
      port: address.port,
      server,
      transfers: new Map(),
    };
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const context = this.context;
    if (!context) return;
    this.context = null;
    context.transfers.clear();
    context.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!context.server.listening) return resolve();
      context.server.close(() => resolve());
    });
  }

  private async currentSources(context: ShareContext): Promise<ShareSourceSnapshot[]> {
    const [registered, folders] = await Promise.all([
      this.options.getSources(),
      this.options.getDigitalFolders(),
    ]);
    return context.sources.flatMap((shared) => {
      const sourceStillAvailable = registered.some((source) =>
        source.kind === "local" &&
        source.available &&
        source.id === shared.id &&
        path.resolve(source.rootPath) === path.resolve(shared.rootPath),
      );
      if (!sourceStillAvailable) return [];
      if (!shared.folderId) return [shared];

      const folder = folders.find((candidate) =>
        candidate.id === shared.folderId && !candidate.hidden,
      );
      if (!folder) return [];
      const root = path.resolve(shared.rootPath);
      const allowedPaths = new Set(folder.filePaths.flatMap((memberPath) => {
        if (typeof memberPath !== "string" || !path.isAbsolute(memberPath)) return [];
        const resolved = path.resolve(memberPath);
        const relative = path.relative(root, resolved);
        return relative !== "" && !path.isAbsolute(relative) &&
          relative !== ".." && !relative.startsWith(`..${path.sep}`)
          ? [resolved]
          : [];
      }));
      return allowedPaths.size ? [{ ...shared, allowedPaths }] : [];
    });
  }

  private async currentFiles(context: ShareContext, sources: ShareSourceSnapshot[]) {
    const results: Array<{
      file: IndexedShareFile;
      source: ShareSourceSnapshot;
      type: "image" | "video";
      id: string;
    }> = [];
    for (const source of sources)
      for (const file of this.options.getIndexedFiles([source.rootPath])) {
        if (source.allowedPaths && !source.allowedPaths.has(path.resolve(file.path)))
          continue;
        const type = mediaType(file);
        if (!type || file.relativePath.includes("\0")) continue;
        results.push({
          file,
          source,
          type,
          id: itemId(context.token, source.publicId, source.rootPath, file.relativePath),
        });
      }
    return results;
  }

  private async findItem(context: ShareContext, id: string) {
    if (!/^[A-Za-z0-9_-]{24}$/.test(id)) return null;
    const sources = await this.currentSources(context);
    const records = await this.currentFiles(context, sources);
    return records.find((entry) => entry.id === id) ?? null;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse, expectedToken: string) {
    const context = this.context;
    if (!context || context.token !== expectedToken) return json(response, 404, { error: "Share is no longer active." });
    if (!isOnShareSubnet(request.socket.remoteAddress, context.network))
      return json(response, 403, { error: "This share is available only on the same local network." });

    const url = new URL(request.url ?? "/", "http://silo.local");
    const parts = url.pathname.split("/").filter(Boolean);
    const token = parts[1];
    if (parts[0] === "share" && parts.length === 2 && this.safeEqualToken(token, context.token)) {
      if (request.method !== "GET") return json(response, 405, { error: "Method not allowed." });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(LIBRARY_SHARE_PAGE);
      return;
    }
    if (parts[0] !== "api" || !this.safeEqualToken(token, context.token))
      return json(response, 404, { error: "Not found." });
    if (request.method === "GET" && parts[2] === "sources" && parts.length === 3)
      return this.sendSources(context, response);
    if (request.method === "GET" && parts[2] === "items" && parts.length === 3)
      return this.sendItems(context, url, response);
    if (request.method === "GET" && parts[2] === "thumb" && parts.length === 4)
      return this.sendThumbnail(context, parts[3], response);
    if (request.method === "GET" && parts[2] === "media" && parts.length === 4)
      return this.sendMedia(context, request, response, parts[3], false);
    if (request.method === "GET" && parts[2] === "download" && parts.length === 4)
      return this.sendMedia(context, request, response, parts[3], true);
    if (request.method === "POST" && parts[2] === "download" && parts.length === 3)
      return this.sendArchive(context, request, response);
    return json(response, 404, { error: "Not found." });
  }

  private safeEqualToken(received: string | undefined, expected: string): boolean {
    if (!received || received.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  }

  private async sendSources(context: ShareContext, response: ServerResponse) {
    const sources = await this.currentSources(context);
    json(response, 200, {
      sources: sources.map(({ publicId, label }) => ({ id: publicId, label })),
    });
  }

  private async sendItems(context: ShareContext, url: URL, response: ServerResponse) {
    const sources = await this.currentSources(context);
    const publicSourceId = url.searchParams.get("source") ?? "";
    const source = sources.find((candidate) => candidate.publicId === publicSourceId);
    if (!source) return json(response, 404, { error: "Shared library is unavailable." });
    const folder = safeFolder(url.searchParams.get("folder") ?? "");
    if (folder === null) return json(response, 400, { error: "Invalid folder path." });
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 160);
    const explode = url.searchParams.get("explode") === "1";
    const filterType = url.searchParams.get("type") ?? "all";
    const sort = url.searchParams.get("sort") ?? "modified-desc";
    const offset = Math.max(0, Math.min(1_000_000, Number(url.searchParams.get("offset")) || 0));
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(url.searchParams.get("limit")) || MAX_PAGE_SIZE));
    const allEntries = await this.currentFiles(context, [source]);
    const entries = allEntries.filter((entry) => {
      const relative = entry.file.relativePath.split(path.sep).join("/");
      if (!query) return true;
      return Boolean(relative) && relative.length > 0;
    });

    let items: Array<Record<string, unknown>>;
    if (query) {
      const roots = [source.rootPath];
      const recordByPath = new Map(entries.map((entry) => [path.resolve(entry.file.path), entry]));
      let searchResults: IndexedShareFile[] = [];
      try {
        searchResults = await this.options.search(query, roots);
      } catch {
        searchResults = [];
      }
      const ranked: typeof entries = [];
      const seen = new Set<string>();
      for (const result of searchResults) {
        const match = recordByPath.get(path.resolve(result.path));
        if (match && !seen.has(match.id)) {
          seen.add(match.id);
          ranked.push(match);
        }
      }
      const lowered = query.toLocaleLowerCase();
      for (const entry of entries) {
        const haystack = `${entry.file.name} ${entry.file.relativePath}`.toLocaleLowerCase();
        if (haystack.includes(lowered) && !seen.has(entry.id)) {
          seen.add(entry.id);
          ranked.push(entry);
        }
      }
      items = ranked.map((entry) => this.publicItem(context, entry));
    } else {
      const prefix = folder ? `${folder}/` : "";
      const directFiles = entries.filter((entry) => {
        const relative = entry.file.relativePath.split(path.sep).join("/");
        if (explode) {
          return folder ? relative.startsWith(prefix) && relative !== folder : true;
        }
        const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
        return parent === folder;
      });
      const folders = new Map<string, string>();
      for (const entry of entries) {
        const relative = entry.file.relativePath.split(path.sep).join("/");
        if (explode) continue;
        if (!relative.startsWith(prefix)) continue;
        const remainder = relative.slice(prefix.length);
        const slash = remainder.indexOf("/");
        if (slash <= 0) continue;
        const name = remainder.slice(0, slash);
        const childPath = prefix + name;
        folders.set(childPath, name);
      }
      const folderItems = Array.from(folders, ([relativePath, name]) => ({
        id: "",
        kind: "folder",
        name,
        relativePath,
        size: 0,
        modified: 0,
        mediaType: "folder",
      }));
      const fileItems = directFiles.map((entry) => this.publicItem(context, entry));
      items = [...folderItems, ...fileItems];
    }

    if (filterType === "image") {
      items = items.filter((item) => item.kind !== "folder" && item.mediaType === "image");
    } else if (filterType === "video") {
      items = items.filter((item) => item.kind !== "folder" && item.mediaType === "video");
    }

    const sortField = sort || "modified-desc";
    items = items.sort((left, right) => {
      const leftKind = Number(left.kind === "folder");
      const rightKind = Number(right.kind === "folder");
      if (left.kind !== right.kind) {
        if (sortField.startsWith("name") || sortField.startsWith("modified") || sortField.startsWith("size"))
          return left.kind === "folder" ? -1 : 1;
        return leftKind - rightKind;
      }
      const leftValue = left.kind === "folder" ? String(left.name) : String(left.name);
      const rightValue = right.kind === "folder" ? String(right.name) : String(right.name);
      switch (sortField) {
        case "name-asc": return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
        case "name-desc": return rightValue.localeCompare(leftValue, undefined, { numeric: true, sensitivity: "base" });
        case "size-asc": return Number(left.size ?? 0) - Number(right.size ?? 0);
        case "size-desc": return Number(right.size ?? 0) - Number(left.size ?? 0);
        case "modified-asc": return Number(left.modified ?? 0) - Number(right.modified ?? 0);
        case "modified-desc":
        default: return Number(right.modified ?? 0) - Number(left.modified ?? 0);
      }
    });

    const page = items.slice(offset, offset + limit);
    json(response, 200, {
      items: page,
      total: items.length,
      nextOffset: offset + page.length < items.length ? offset + page.length : null,
    });
  }

  private publicItem(
    _context: ShareContext,
    entry: { file: IndexedShareFile; source: ShareSourceSnapshot; type: "image" | "video"; id: string },
  ) {
    return {
      id: entry.id,
      kind: "file",
      name: entry.file.name,
      relativePath: entry.file.relativePath.split(path.sep).join("/"),
      size: entry.file.size,
      modified: entry.file.modified,
      mediaType: entry.type,
    };
  }

  private async sendThumbnail(context: ShareContext, id: string, response: ServerResponse) {
    const entry = await this.findItem(context, id);
    if (!entry) return json(response, 404, { error: "Photo is unavailable." });
    const opened = await openIndexedShareFile(entry.source.rootPath, entry.source.canonicalRoot, entry.file, entry.source.rootIdentity);
    try {
      const thumbnail = await this.options.getThumbnail(opened.path);
      if (!thumbnail) return json(response, 404, { error: "Preview is unavailable." });
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": String(thumbnail.length),
        "cache-control": "private, max-age=300",
      });
      response.end(thumbnail);
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  private async sendMedia(context: ShareContext, request: IncomingMessage, response: ServerResponse, id: string, download: boolean) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return json(response, 405, { error: "Method not allowed." });
    const entry = await this.findItem(context, id);
    if (!entry) return json(response, 404, { error: "Photo or video is unavailable." });
    const opened = await openIndexedShareFile(entry.source.rootPath, entry.source.canonicalRoot, entry.file, entry.source.rootIdentity);
    const range = parseRange(request.headers.range, opened.size);
    if (range === "invalid") {
      await opened.handle.close();
      response.writeHead(416, { "content-range": `bytes */${opened.size}`, "accept-ranges": "bytes" });
      response.end();
      return;
    }
    const status = range ? 206 : 200;
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, opened.size - 1);
    const contentLength = opened.size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = {
      "content-type": mime.getType(entry.file.name) ?? "application/octet-stream",
      "content-length": String(contentLength),
      "accept-ranges": "bytes",
      "content-disposition": download ? attachmentName(entry.file.name) : `inline; filename*=UTF-8''${encodeURIComponent(entry.file.name)}`,
      "cache-control": "private, no-store",
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${opened.size}`;
    response.writeHead(status, headers);
    if (request.method === "HEAD" || opened.size === 0) {
      await opened.handle.close();
      response.end();
      return;
    }
    const stream = opened.handle.createReadStream({ start, end, autoClose: true });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  private async sendArchive(context: ShareContext, request: IncomingMessage, response: ServerResponse) {
    const body = await readRequestBody(request);
    const contentType = request.headers["content-type"] ?? "";
    let fields: Record<string, unknown>;
    try {
      if (contentType.includes("application/json"))
        fields = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      else
        fields = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
    } catch {
      return json(response, 400, { error: "Invalid download request." });
    }
    const all = fields.all === "1" || fields.all === true;
    let ids: string[] = [];
    if (!all) {
      try {
        ids = JSON.parse(typeof fields.items === "string" ? fields.items : "[]") as string[];
      } catch {
        return json(response, 400, { error: "Invalid item selection." });
      }
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_DOWNLOAD_ITEMS || ids.some((id) => typeof id !== "string"))
        return json(response, 400, { error: `Select between 1 and ${MAX_DOWNLOAD_ITEMS.toLocaleString()} items.` });
    }
    const sources = await this.currentSources(context);
    const entries = await this.currentFiles(context, sources);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const chosen = all ? entries : Array.from(new Set(ids)).flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    });
    if (!chosen.length) return json(response, 404, { error: "No current photos or videos were found for this download." });

    const token = randomBytes(4).toString("hex");
    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("warning", (error) => archive.destroy(error));
    archive.on("error", () => response.destroy());
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": attachmentName(`Silo-photos-${new Date().toISOString().slice(0, 10)}-${token}.zip`),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    archive.pipe(response);
    let activeSource: NodeJS.ReadableStream | null = null;
    response.on("close", () => {
      if (response.writableEnded) return;
      archive.abort();
      (activeSource as NodeJS.ReadableStream & { destroy?: () => void } | null)?.destroy?.();
    });
    let writtenEntries = 0;
    const entryWaiters: Array<() => void> = [];
    archive.on("entry", () => {
      writtenEntries += 1;
      entryWaiters.shift()?.();
    });
    const waitForEntry = () => {
      const target = writtenEntries + 1;
      if (writtenEntries >= target) return Promise.resolve();
      return new Promise<void>((resolve) => entryWaiters.push(resolve));
    };
    let archivedCount = 0;
    try {
      for (const entry of chosen) {
        let opened;
        try {
          opened = await openIndexedShareFile(entry.source.rootPath, entry.source.canonicalRoot, entry.file, entry.source.rootIdentity);
        } catch {
          continue;
        }
        const source = opened.handle.createReadStream({ autoClose: true });
        activeSource = source;
        const sourceName = comparableName(entry.source.label);
        const archivePath = `${sourceName}/${entry.file.relativePath.split(path.sep).join("/")}`;
        const complete = waitForEntry();
        source.on("error", (error) => archive.destroy(error));
        archive.append(source, { name: archivePath, store: /\.(?:jpe?g|heic|heif|png|gif|webp|tiff?|mp4|m4v|mov|avi|mkv|webm)$/i.test(entry.file.name) });
        await complete;
        activeSource = null;
        archivedCount += 1;
      }
      if (!archivedCount) {
        archive.abort();
        return response.destroy();
      }
      await archive.finalize();
    } catch (error) {
      archive.destroy(error instanceof Error ? error : undefined);
      response.destroy();
    }
  }
}

export function isValidShareSubnet(address: string, network: ShareNetworkInterface): boolean {
  return isOnShareSubnet(address, network);
}
