import * as path from "path";
import * as fsPromises from "fs/promises";
import { randomUUID } from "crypto";
import type { GeocodedLocation } from "./geocoder";
import { DEFAULT_SEMANTIC_SEARCH_CONFIDENCE } from "./searchSettings";

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
  messageSort: "oldest" | "newest" | "favorites";
  showHiddenMessages: boolean;
}

export interface MessageDisplayFlags {
  favorite: boolean;
  hidden: boolean;
}

export interface IndexSource {
  path: string;
  addedAt: number;
  kind?: "machine";
  volumeUUID?: string;
  resumeAfterEject?: {
    wasDisabled: boolean;
    wasExplicitlyEnabled: boolean;
  };
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
  people?: string[];
  places?: string[];
  updatedAt: number;
}

export interface MediaPlaylist {
  id: string;
  name: string;
  kind: "audio" | "video";
  filePaths: string[];
  createdAt: number;
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
  mediaPlaylists: MediaPlaylist[];
  nameIndex: NameIndexEntry[];
  fileMetadata: Record<string, FileMetadata>;
  searchFeedback: Record<string, "confirmed" | "removed">;
  messageFlags: Record<string, MessageDisplayFlags>;
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
    confidence: DEFAULT_SEMANTIC_SEARCH_CONFIDENCE,
    messageSort: "newest",
    showHiddenMessages: false,
  },
  indexSources: [],
  digitalFolders: [favoritesFolder(), refuseFolder()],
  mediaPlaylists: [],
  nameIndex: [],
  fileMetadata: {},
  searchFeedback: {},
  messageFlags: {},
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
        ui: {
          ...defaultState.ui,
          ...stored.ui,
          messageSort:
            stored.ui?.messageSort === "oldest" ||
            stored.ui?.messageSort === "favorites"
              ? stored.ui.messageSort
              : "newest",
          showHiddenMessages: stored.ui?.showHiddenMessages === true,
        },
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
        mediaPlaylists: Array.isArray(stored.mediaPlaylists)
          ? stored.mediaPlaylists.flatMap((playlist) => {
              if (
                !playlist ||
                typeof playlist !== "object" ||
                typeof playlist.id !== "string" ||
                typeof playlist.name !== "string" ||
                (playlist.kind !== "audio" && playlist.kind !== "video") ||
                !Array.isArray(playlist.filePaths)
              )
                return [];
              return [{
                id: playlist.id,
                name: playlist.name.slice(0, 100),
                kind: playlist.kind,
                filePaths: Array.from(new Set(playlist.filePaths.filter((item) => typeof item === "string" && item.length <= 4096))),
                createdAt: Number.isFinite(playlist.createdAt) ? playlist.createdAt : Date.now(),
                updatedAt: Number.isFinite(playlist.updatedAt) ? playlist.updatedAt : Date.now(),
              }];
            })
          : [],
        nameIndex: Array.isArray(stored.nameIndex) ? stored.nameIndex : [],
        fileMetadata:
          stored.fileMetadata && typeof stored.fileMetadata === "object"
            ? stored.fileMetadata
            : {},
        searchFeedback:
          stored.searchFeedback && typeof stored.searchFeedback === "object"
            ? Object.fromEntries(
                Object.entries(stored.searchFeedback).filter(
                  ([, value]) => value === "confirmed" || value === "removed",
                ),
              )
            : {},
        messageFlags:
          stored.messageFlags && typeof stored.messageFlags === "object"
            ? Object.fromEntries(
                Object.entries(stored.messageFlags).flatMap(([key, value]) => {
                  if (
                    !key ||
                    key.length > 4096 ||
                    !value ||
                    typeof value !== "object" ||
                    Array.isArray(value)
                  )
                    return [];
                  const flags = {
                    favorite: (value as Partial<MessageDisplayFlags>).favorite === true,
                    hidden: (value as Partial<MessageDisplayFlags>).hidden === true,
                  };
                  return flags.favorite || flags.hidden ? [[key, flags]] : [];
                }),
              )
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

  /** Source-list refreshes need only these small fields, not file metadata and folders. */
  getSourcesState(): Pick<PersistedAppState, "indexSources" | "disabledSourceIds" | "enabledSourceIds"> {
    return {
      indexSources: structuredClone(this.state.indexSources),
      disabledSourceIds: [...this.state.disabledSourceIds],
      enabledSourceIds: [...this.state.enabledSourceIds],
    };
  }

  /** Search reads this small live view instead of cloning the full library state. */
  getSearchState(): Pick<
    PersistedAppState,
    "digitalFolders" | "nameIndex" | "fileMetadata" | "searchFeedback"
  > {
    return {
      digitalFolders: this.state.digitalFolders,
      nameIndex: this.state.nameIndex,
      fileMetadata: this.state.fileMetadata,
      searchFeedback: this.state.searchFeedback,
    };
  }

  async updateUi(update: Partial<PersistedUiState>) {
    this.state.ui = { ...this.state.ui, ...update };
    await this.write();
    return this.getState();
  }

  async updateSearchFeedback(
    filePaths: string[],
    disposition: "confirmed" | "removed",
  ) {
    for (const filePath of new Set(filePaths))
      this.state.searchFeedback[filePath] = disposition;
    await this.write();
    return this.getState();
  }

  async updateMessageFlags(
    messageKey: string,
    update: Partial<MessageDisplayFlags>,
  ) {
    const next = {
      ...(this.state.messageFlags[messageKey] ?? {
        favorite: false,
        hidden: false,
      }),
      ...update,
    };
    if (!next.favorite && !next.hidden) delete this.state.messageFlags[messageKey];
    else this.state.messageFlags[messageKey] = next;
    await this.write();
    return this.getState();
  }

  async addIndexSource(sourcePath: string, volumeUUID?: string) {
    const existing = this.state.indexSources.find((source) => source.path === sourcePath);
    if (existing) {
      if (!existing.volumeUUID && volumeUUID) {
        const previous = this.state;
        this.state = structuredClone(this.state);
        this.state.indexSources.find((source) => source.path === sourcePath)!.volumeUUID = volumeUUID;
        try {
          await this.write();
        } catch (error) {
          this.state = previous;
          throw error;
        }
      }
    } else {
      this.state.indexSources.push({
        path: sourcePath,
        addedAt: Date.now(),
        ...(volumeUUID ? { volumeUUID } : {}),
      });
      await this.write();
    }
    return this.getState();
  }

  async addMachineSource(sourcePath: string) {
    const existing = this.state.indexSources.find((source) => source.path === sourcePath);
    if (existing) {
      if (existing.kind !== "machine") {
        existing.kind = "machine";
        await this.write();
      }
    } else {
      this.state.indexSources.push({ path: sourcePath, addedAt: Date.now(), kind: "machine" });
      await this.write();
    }
    return this.getState();
  }

  async removeIndexSource(sourcePath: string) {
    const previous = this.state;
    this.state = structuredClone(this.state);
    this.state.indexSources = this.state.indexSources.filter(
      (source) => source.path !== sourcePath,
    );
    this.state.disabledSourceIds = this.state.disabledSourceIds.filter(
      (sourceId) => sourceId !== sourcePath,
    );
    this.state.enabledSourceIds = this.state.enabledSourceIds.filter(
      (sourceId) => sourceId !== sourcePath,
    );
    try {
      await this.write();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return this.getState();
  }

  async setSourceEnabled(sourceId: string, enabled: boolean) {
    const previousDisabled = this.state.disabledSourceIds;
    const previousEnabled = this.state.enabledSourceIds;
    const previousSources = this.state.indexSources;
    const disabled = new Set(previousDisabled);
    const explicitlyEnabled = new Set(previousEnabled);
    if (enabled) disabled.delete(sourceId);
    else disabled.add(sourceId);
    if (enabled) explicitlyEnabled.add(sourceId);
    else explicitlyEnabled.delete(sourceId);
    this.state.disabledSourceIds = Array.from(disabled);
    this.state.enabledSourceIds = Array.from(explicitlyEnabled);
    this.state.indexSources = previousSources.map((source) => {
      if (source.path !== sourceId || !source.resumeAfterEject) return source;
      const { resumeAfterEject: _resume, ...rest } = source;
      return rest;
    });
    try {
      await this.write();
    } catch (error) {
      this.state.disabledSourceIds = previousDisabled;
      this.state.enabledSourceIds = previousEnabled;
      this.state.indexSources = previousSources;
      throw error;
    }
  }

  async setAllSourcesEnabled(sourceIds: string[], enabled: boolean) {
    const previousDisabled = this.state.disabledSourceIds;
    const previousEnabled = this.state.enabledSourceIds;
    const previousSources = this.state.indexSources;
    const selectedIds = new Set(sourceIds);
    this.state.indexSources = previousSources.map((source) => {
      if (!selectedIds.has(source.path) || !source.resumeAfterEject) return source;
      const { resumeAfterEject: _resume, ...rest } = source;
      return rest;
    });
    const disabled = new Set(previousDisabled);
    const explicitlyEnabled = new Set(previousEnabled);
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
    try {
      await this.write();
    } catch (error) {
      this.state.disabledSourceIds = previousDisabled;
      this.state.enabledSourceIds = previousEnabled;
      this.state.indexSources = previousSources;
      throw error;
    }
  }

  async prepareSourcesForEject(sourcePaths: string[]) {
    const targets = new Set(sourcePaths);
    const previous = this.state;
    this.state = structuredClone(this.state);
    const disabled = new Set(this.state.disabledSourceIds);
    const explicitlyEnabled = new Set(this.state.enabledSourceIds);
    const affected: string[] = [];
    for (const source of this.state.indexSources) {
      if (!targets.has(source.path)) continue;
      source.resumeAfterEject = {
        wasDisabled: disabled.has(source.path),
        wasExplicitlyEnabled: explicitlyEnabled.has(source.path),
      };
      disabled.add(source.path);
      explicitlyEnabled.delete(source.path);
      affected.push(source.path);
    }
    this.state.disabledSourceIds = Array.from(disabled);
    this.state.enabledSourceIds = Array.from(explicitlyEnabled);
    try {
      await this.write();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return affected;
  }

  async restoreSourcesAfterEjectFailure(sourcePaths: string[]) {
    const targets = new Set(sourcePaths);
    const previous = this.state;
    this.state = structuredClone(this.state);
    const disabled = new Set(this.state.disabledSourceIds);
    const explicitlyEnabled = new Set(this.state.enabledSourceIds);
    for (const source of this.state.indexSources) {
      if (!targets.has(source.path) || !source.resumeAfterEject) continue;
      if (source.resumeAfterEject.wasDisabled) disabled.add(source.path);
      else disabled.delete(source.path);
      if (source.resumeAfterEject.wasExplicitlyEnabled) explicitlyEnabled.add(source.path);
      else explicitlyEnabled.delete(source.path);
      delete source.resumeAfterEject;
    }
    this.state.disabledSourceIds = Array.from(disabled);
    this.state.enabledSourceIds = Array.from(explicitlyEnabled);
    try {
      await this.write();
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }

  async resumeSourcesAfterVolumeReturn(volumeUUIDs: string[]) {
    const returnedVolumes = new Set(volumeUUIDs);
    if (!returnedVolumes.size) return [];
    const previous = this.state;
    this.state = structuredClone(this.state);
    const disabled = new Set(this.state.disabledSourceIds);
    const explicitlyEnabled = new Set(this.state.enabledSourceIds);
    const resumed: string[] = [];
    for (const source of this.state.indexSources) {
      const resume = source.resumeAfterEject;
      if (!resume || !source.volumeUUID || !returnedVolumes.has(source.volumeUUID)) continue;
      if (resume.wasDisabled) disabled.add(source.path);
      else disabled.delete(source.path);
      if (resume.wasExplicitlyEnabled) explicitlyEnabled.add(source.path);
      else explicitlyEnabled.delete(source.path);
      delete source.resumeAfterEject;
      resumed.push(source.path);
    }
    if (!resumed.length) {
      this.state = previous;
      return [];
    }
    this.state.disabledSourceIds = Array.from(disabled);
    this.state.enabledSourceIds = Array.from(explicitlyEnabled);
    try {
      await this.write();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return resumed;
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
      people?: string[];
      places?: string[];
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
        ...(update.people === undefined ? {} : { people: current.people ?? [] }),
        ...(update.places === undefined ? {} : { places: current.places ?? [] }),
      };
      if (update.people !== undefined)
        next.people = Array.from(new Set(update.people.map((value) => value.trim()).filter(Boolean)));
      if (update.places !== undefined)
        next.places = Array.from(new Set(update.places.map((value) => value.trim()).filter(Boolean)));
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
        (next.people?.length ?? 0) === 0 &&
        (next.places?.length ?? 0) === 0 &&
        next.year === undefined
      )
        delete this.state.fileMetadata[filePath];
      else this.state.fileMetadata[filePath] = next;
    }
    await this.write();
    return this.getState();
  }

  async createMediaPlaylist(name: string, kind: "audio" | "video") {
    const cleanName = name.trim().slice(0, 100);
    if (!cleanName) throw new Error("Enter a playlist name.");
    if (kind !== "audio" && kind !== "video") throw new Error("Choose a valid playlist type.");
    const playlist: MediaPlaylist = {
      id: randomUUID(),
      name: cleanName,
      kind,
      filePaths: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.mediaPlaylists.push(playlist);
    await this.write();
    return this.getState();
  }

  async addMediaPlaylistFiles(playlistId: string, filePaths: string[]) {
    const playlist = this.state.mediaPlaylists.find((item) => item.id === playlistId);
    if (!playlist) throw new Error("Playlist not found.");
    const existing = new Set(playlist.filePaths);
    for (const filePath of filePaths) {
      if (typeof filePath !== "string" || !filePath.trim() || filePath.length > 4096) continue;
      if (!existing.has(filePath)) {
        existing.add(filePath);
        playlist.filePaths.push(filePath);
      }
    }
    playlist.updatedAt = Date.now();
    await this.write();
    return this.getState();
  }

  async removeMediaPlaylistFile(playlistId: string, filePath: string) {
    const playlist = this.state.mediaPlaylists.find((item) => item.id === playlistId);
    if (!playlist) throw new Error("Playlist not found.");
    playlist.filePaths = playlist.filePaths.filter((item) => item !== filePath);
    playlist.updatedAt = Date.now();
    await this.write();
    return this.getState();
  }

  async deleteMediaPlaylist(playlistId: string) {
    this.state.mediaPlaylists = this.state.mediaPlaylists.filter((item) => item.id !== playlistId);
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
