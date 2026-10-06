import * as path from "path";
import * as fsPromises from "fs/promises";
import type { GeocodedLocation } from "./geocoder";

export interface PersistedUiState {
  currentPath: string | null;
  exploded: boolean;
  sortField:
    | "name"
    | "size"
    | "modified"
    | "type"
    | "source"
    | "magic"
    | "people"
    | "mapped";
  sortAscending: boolean;
  includedType: string;
  viewMode: "list" | "grid";
  showFilters: boolean;
  confidence: number;
}

export interface IndexSource {
  path: string;
  addedAt: number;
}

export interface DigitalFolder {
  id: string;
  name: string;
  filePaths: string[];
  createdAt: number;
  hidden?: boolean;
}

export const FAVORITES_FOLDER_ID = "__favorites__";
export const REFUSE_FOLDER_ID = "__refuse__";

function favoritesFolder(): DigitalFolder {
  return {
    id: FAVORITES_FOLDER_ID,
    name: "Favorites",
    filePaths: [],
    createdAt: 0,
  };
}

function refuseFolder(): DigitalFolder {
  return {
    id: REFUSE_FOLDER_ID,
    name: "Refuse",
    filePaths: [],
    createdAt: 0,
    hidden: true,
  };
}

export interface NameIndexEntry {
  name: string;
  filePaths: { path: string; confirmed: boolean }[];
  addedAt: number;
  sourceType: "person" | "pet" | "manual";
  sourceId?: string;
}

export interface FileMetadata {
  displayName?: string;
  year?: number;
  keywords: string[];
  updatedAt: number;
}

export interface GeoFileSnapshot {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: number;
  isDirectory: false;
  type: string;
  extension: string;
  sourcePath: string;
}

export interface GeoOverride {
  file: GeoFileSnapshot;
  location: GeocodedLocation;
  updatedAt: number;
}

export interface PersistedAppState {
  version: 1;
  ui: PersistedUiState;
  indexSources: IndexSource[];
  digitalFolders: DigitalFolder[];
  nameIndex: NameIndexEntry[];
  fileMetadata: Record<string, FileMetadata>;
  geoOverrides: Record<string, GeoOverride>;
  /** Sources are enabled by default, so only exclusions are stored. */
  disabledSourceIds: string[];
  /** Explicitly enabled IDs override context-dependent defaults for snapshots. */
  enabledSourceIds: string[];
}

const defaultState: PersistedAppState = {
  version: 1,
  ui: {
    currentPath: null,
    exploded: false,
    sortField: "name",
    sortAscending: true,
    includedType: "all",
    viewMode: "grid",
    showFilters: false,
    confidence: 25,
  },
  indexSources: [],
  digitalFolders: [favoritesFolder(), refuseFolder()],
  nameIndex: [],
  fileMetadata: {},
  geoOverrides: {},
  disabledSourceIds: [],
  enabledSourceIds: [],
};

export class StateStore {
  private readonly filePath: string;
  private state: PersistedAppState = structuredClone(defaultState);
  private writeChain = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "browser-state.json");
  }

  async initialize() {
    try {
      const stored = JSON.parse(
        await fsPromises.readFile(this.filePath, "utf8"),
      ) as Partial<PersistedAppState>;
      const folders = Array.isArray(stored.digitalFolders)
        ? stored.digitalFolders
        : [];
      const folderIds = new Set(folders.map((folder) => folder.id));
      this.state = {
        ...structuredClone(defaultState),
        ...stored,
        ui: { ...defaultState.ui, ...stored.ui },
        indexSources: Array.isArray(stored.indexSources)
          ? stored.indexSources
          : [],
        digitalFolders: [
          ...(!folderIds.has(FAVORITES_FOLDER_ID) ? [favoritesFolder()] : []),
          ...(!folderIds.has(REFUSE_FOLDER_ID) ? [refuseFolder()] : []),
          ...folders.map((folder) =>
            folder.id === REFUSE_FOLDER_ID
              ? { ...folder, hidden: true }
              : folder,
          ),
        ],
        nameIndex: Array.isArray(stored.nameIndex) ? stored.nameIndex : [],
        fileMetadata:
          stored.fileMetadata && typeof stored.fileMetadata === "object"
            ? stored.fileMetadata
            : {},
        geoOverrides:
          stored.geoOverrides && typeof stored.geoOverrides === "object"
            ? stored.geoOverrides
            : {},
        disabledSourceIds: Array.isArray(stored.disabledSourceIds)
          ? stored.disabledSourceIds
          : [],
        enabledSourceIds: Array.isArray(stored.enabledSourceIds)
          ? stored.enabledSourceIds
          : [],
      };
    } catch {
      await this.write();
    }
  }

  getState(): PersistedAppState {
    return structuredClone(this.state);
  }

  async updateUi(update: Partial<PersistedUiState>) {
    this.state.ui = { ...this.state.ui, ...update };
    await this.write();
    return this.getState();
  }

  async addIndexSource(sourcePath: string) {
    if (!this.state.indexSources.some((source) => source.path === sourcePath)) {
      this.state.indexSources.push({ path: sourcePath, addedAt: Date.now() });
      await this.write();
    }
    return this.getState();
  }

  async removeIndexSource(sourcePath: string) {
    this.state.indexSources = this.state.indexSources.filter(
      (source) => source.path !== sourcePath,
    );
    this.state.disabledSourceIds = this.state.disabledSourceIds.filter(
      (sourceId) => sourceId !== sourcePath,
    );
    this.state.enabledSourceIds = this.state.enabledSourceIds.filter(
      (sourceId) => sourceId !== sourcePath,
    );
    await this.write();
    return this.getState();
  }

  async setSourceEnabled(sourceId: string, enabled: boolean) {
    const disabled = new Set(this.state.disabledSourceIds);
    const explicitlyEnabled = new Set(this.state.enabledSourceIds);
    if (enabled) disabled.delete(sourceId);
    else disabled.add(sourceId);
    if (enabled) explicitlyEnabled.add(sourceId);
    else explicitlyEnabled.delete(sourceId);
    this.state.disabledSourceIds = Array.from(disabled);
    this.state.enabledSourceIds = Array.from(explicitlyEnabled);
    await this.write();
    return this.getState();
  }

  async setAllSourcesEnabled(sourceIds: string[], enabled: boolean) {
    const disabled = new Set(this.state.disabledSourceIds);
    const explicitlyEnabled = new Set(this.state.enabledSourceIds);
    for (const sourceId of sourceIds) {
      if (enabled) {
        disabled.delete(sourceId);
        explicitlyEnabled.add(sourceId);
      } else {
        disabled.add(sourceId);
        explicitlyEnabled.delete(sourceId);
      }
    }
    this.state.disabledSourceIds = Array.from(disabled);
    this.state.enabledSourceIds = Array.from(explicitlyEnabled);
    await this.write();
    return this.getState();
  }

  async createDigitalFolder(name: string) {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Enter a folder name.");
    const folder: DigitalFolder = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: cleanName,
      filePaths: [],
      createdAt: Date.now(),
    };
    this.state.digitalFolders.push(folder);
    await this.write();
    return this.getState();
  }

  async renameDigitalFolder(folderId: string, name: string) {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Enter a folder name.");
    const folder = this.state.digitalFolders.find(
      (item) => item.id === folderId,
    );
    if (!folder) throw new Error("Digital folder not found.");
    folder.name = cleanName;
    await this.write();
    return this.getState();
  }

  async moveDigitalFolder(sourceId: string, targetId: string, after: boolean) {
    const folders = [...this.state.digitalFolders];
    const source = folders.findIndex((folder) => folder.id === sourceId);
    if (source < 0 || !folders.some((folder) => folder.id === targetId))
      throw new Error("Digital folder not found.");
    if (sourceId === targetId) return this.getState();
    const [folder] = folders.splice(source, 1);
    const target = folders.findIndex((item) => item.id === targetId);
    folders.splice(target + (after ? 1 : 0), 0, folder);
    this.state.digitalFolders = folders;
    await this.write();
    return this.getState();
  }

  async deleteDigitalFolder(folderId: string) {
    if (folderId === FAVORITES_FOLDER_ID || folderId === REFUSE_FOLDER_ID)
      throw new Error("Built-in folders cannot be deleted.");
    this.state.digitalFolders = this.state.digitalFolders.filter(
      (folder) => folder.id !== folderId,
    );
    await this.write();
    return this.getState();
  }

  async setDigitalFolderHidden(folderId: string, hidden: boolean) {
    const folder = this.state.digitalFolders.find(
      (item) => item.id === folderId,
    );
    if (!folder) throw new Error("Digital folder not found.");
    if (folderId === REFUSE_FOLDER_ID) folder.hidden = true;
    else folder.hidden = Boolean(hidden);
    await this.write();
    return this.getState();
  }

  async addDigitalFolderReference(folderId: string, filePath: string) {
    const folder = this.state.digitalFolders.find(
      (item) => item.id === folderId,
    );
    if (!folder) throw new Error("Digital folder not found.");
    if (!folder.filePaths.includes(filePath)) folder.filePaths.push(filePath);
    await this.write();
    return this.getState();
  }

  async addDigitalFolderReferences(folderId: string, filePaths: string[]) {
    const folder = this.state.digitalFolders.find(
      (item) => item.id === folderId,
    );
    if (!folder) throw new Error("Digital folder not found.");
    const existing = new Set(folder.filePaths);
    for (const filePath of filePaths) {
      if (existing.has(filePath)) continue;
      existing.add(filePath);
      folder.filePaths.push(filePath);
    }
    await this.write();
    return this.getState();
  }

  async removeDigitalFolderReference(folderId: string, filePath: string) {
    const folder = this.state.digitalFolders.find(
      (item) => item.id === folderId,
    );
    if (!folder) throw new Error("Digital folder not found.");
    folder.filePaths = folder.filePaths.filter((item) => item !== filePath);
    await this.write();
    return this.getState();
  }

  async updateNameIndex(
    name: string,
    filePaths: string[],
    sourceType: "person" | "pet" | "manual",
    sourceId?: string,
  ) {
    const existing = this.state.nameIndex.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      existing.filePaths = filePaths.map((path) => ({
        path,
        confirmed: false,
      }));
      existing.sourceType = sourceType;
      if (sourceId) existing.sourceId = sourceId;
    } else {
      this.state.nameIndex.push({
        name,
        filePaths: filePaths.map((path) => ({ path, confirmed: false })),
        addedAt: Date.now(),
        sourceType,
        sourceId,
      });
    }
    await this.write();
    return this.getState();
  }

  async confirmNameFile(name: string, filePath: string) {
    const entry = this.state.nameIndex.find(
      (e) => e.name.toLowerCase() === name.toLowerCase(),
    );
    if (entry) {
      const file = entry.filePaths.find((f) => f.path === filePath);
      if (file) file.confirmed = true;
      await this.write();
    }
    return this.getState();
  }

  async rejectNameFile(name: string, filePath: string) {
    const entry = this.state.nameIndex.find(
      (e) => e.name.toLowerCase() === name.toLowerCase(),
    );
    if (entry) {
      entry.filePaths = entry.filePaths.filter((f) => f.path !== filePath);
      if (entry.filePaths.length === 0) {
        this.state.nameIndex = this.state.nameIndex.filter(
          (e) => e.name !== name,
        );
      }
      await this.write();
    }
    return this.getState();
  }

  async updateFileMetadata(
    filePaths: string[],
    update: {
      displayName?: string | null;
      keywords?: string[];
      mergeKeywords?: boolean;
      year?: number | null;
    },
  ) {
    if (
      update.year !== undefined &&
      update.year !== null &&
      (!Number.isInteger(update.year) || update.year < 1 || update.year > 9999)
    )
      throw new Error("Enter a year between 1 and 9999.");
    for (const filePath of new Set(filePaths)) {
      const current = this.state.fileMetadata[filePath] ?? {
        keywords: [],
        updatedAt: 0,
      };
      const next: FileMetadata = {
        ...current,
        keywords:
          update.keywords === undefined
            ? current.keywords
            : Array.from(
                new Set([
                  ...(update.mergeKeywords ? current.keywords : []),
                  ...update.keywords
                    .map((keyword) => keyword.trim())
                    .filter(Boolean),
                ]),
              ),
        updatedAt: Date.now(),
      };
      if (update.displayName !== undefined) {
        const displayName = update.displayName?.trim();
        if (displayName) next.displayName = displayName;
        else delete next.displayName;
      }
      if (update.year !== undefined) {
        if (update.year === null) delete next.year;
        else next.year = update.year;
      }
      if (
        !next.displayName &&
        next.keywords.length === 0 &&
        next.year === undefined
      )
        delete this.state.fileMetadata[filePath];
      else this.state.fileMetadata[filePath] = next;
    }
    await this.write();
    return this.getState();
  }

  async setGeoOverrides(files: GeoFileSnapshot[], location: GeocodedLocation) {
    for (const file of files) {
      this.state.geoOverrides[file.path] = {
        file,
        location,
        updatedAt: Date.now(),
      };
    }
    await this.write();
    return this.getState();
  }

  async clearGeoOverrides(filePaths: string[]) {
    for (const filePath of filePaths) delete this.state.geoOverrides[filePath];
    await this.write();
    return this.getState();
  }

  private write() {
    this.writeChain = this.writeChain.then(async () => {
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fsPromises.writeFile(
        temporaryPath,
        JSON.stringify(this.state, null, 2),
      );
      await fsPromises.rename(temporaryPath, this.filePath);
    });
    return this.writeChain;
  }
}
