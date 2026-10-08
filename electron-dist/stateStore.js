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
exports.StateStore = exports.REFUSE_FOLDER_ID = exports.FAVORITES_FOLDER_ID = void 0;
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
const searchSettings_1 = require("./searchSettings");
exports.FAVORITES_FOLDER_ID = "__favorites__";
exports.REFUSE_FOLDER_ID = "__refuse__";
function favoritesFolder() {
    return {
        id: exports.FAVORITES_FOLDER_ID,
        name: "Favorites",
        filePaths: [],
        createdAt: 0,
    };
}
function refuseFolder() {
    return {
        id: exports.REFUSE_FOLDER_ID,
        name: "Refuse",
        filePaths: [],
        createdAt: 0,
        hidden: true,
    };
}
const defaultState = {
    version: 1,
    ui: {
        currentPath: null,
        exploded: false,
        sortField: "name",
        sortAscending: true,
        includedType: "all",
        viewMode: "grid",
        showFilters: false,
        confidence: searchSettings_1.DEFAULT_SEMANTIC_SEARCH_CONFIDENCE,
    },
    indexSources: [],
    digitalFolders: [favoritesFolder(), refuseFolder()],
    nameIndex: [],
    fileMetadata: {},
    geoOverrides: {},
    disabledSourceIds: [],
    enabledSourceIds: [],
};
class StateStore {
    constructor(userDataPath) {
        this.state = structuredClone(defaultState);
        this.writeChain = Promise.resolve();
        this.filePath = path.join(userDataPath, "browser-state.json");
    }
    async initialize() {
        try {
            const stored = JSON.parse(await fsPromises.readFile(this.filePath, "utf8"));
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
                    ...(!folderIds.has(exports.FAVORITES_FOLDER_ID) ? [favoritesFolder()] : []),
                    ...(!folderIds.has(exports.REFUSE_FOLDER_ID) ? [refuseFolder()] : []),
                    ...folders.map((folder) => folder.id === exports.REFUSE_FOLDER_ID
                        ? { ...folder, hidden: true }
                        : folder),
                ],
                nameIndex: Array.isArray(stored.nameIndex) ? stored.nameIndex : [],
                fileMetadata: stored.fileMetadata && typeof stored.fileMetadata === "object"
                    ? stored.fileMetadata
                    : {},
                geoOverrides: stored.geoOverrides && typeof stored.geoOverrides === "object"
                    ? stored.geoOverrides
                    : {},
                disabledSourceIds: Array.isArray(stored.disabledSourceIds)
                    ? stored.disabledSourceIds
                    : [],
                enabledSourceIds: Array.isArray(stored.enabledSourceIds)
                    ? stored.enabledSourceIds
                    : [],
            };
        }
        catch {
            await this.write();
        }
    }
    getState() {
        return structuredClone(this.state);
    }
    /** Search reads this small live view instead of cloning the full library state. */
    getSearchState() {
        return {
            digitalFolders: this.state.digitalFolders,
            nameIndex: this.state.nameIndex,
            fileMetadata: this.state.fileMetadata,
        };
    }
    async updateUi(update) {
        this.state.ui = { ...this.state.ui, ...update };
        await this.write();
        return this.getState();
    }
    async addIndexSource(sourcePath) {
        if (!this.state.indexSources.some((source) => source.path === sourcePath)) {
            this.state.indexSources.push({ path: sourcePath, addedAt: Date.now() });
            await this.write();
        }
        return this.getState();
    }
    async removeIndexSource(sourcePath) {
        this.state.indexSources = this.state.indexSources.filter((source) => source.path !== sourcePath);
        this.state.disabledSourceIds = this.state.disabledSourceIds.filter((sourceId) => sourceId !== sourcePath);
        this.state.enabledSourceIds = this.state.enabledSourceIds.filter((sourceId) => sourceId !== sourcePath);
        await this.write();
        return this.getState();
    }
    async setSourceEnabled(sourceId, enabled) {
        const disabled = new Set(this.state.disabledSourceIds);
        const explicitlyEnabled = new Set(this.state.enabledSourceIds);
        if (enabled)
            disabled.delete(sourceId);
        else
            disabled.add(sourceId);
        if (enabled)
            explicitlyEnabled.add(sourceId);
        else
            explicitlyEnabled.delete(sourceId);
        this.state.disabledSourceIds = Array.from(disabled);
        this.state.enabledSourceIds = Array.from(explicitlyEnabled);
        await this.write();
        return this.getState();
    }
    async setAllSourcesEnabled(sourceIds, enabled) {
        const disabled = new Set(this.state.disabledSourceIds);
        const explicitlyEnabled = new Set(this.state.enabledSourceIds);
        for (const sourceId of sourceIds) {
            if (enabled) {
                disabled.delete(sourceId);
                explicitlyEnabled.add(sourceId);
            }
            else {
                disabled.add(sourceId);
                explicitlyEnabled.delete(sourceId);
            }
        }
        this.state.disabledSourceIds = Array.from(disabled);
        this.state.enabledSourceIds = Array.from(explicitlyEnabled);
        await this.write();
        return this.getState();
    }
    async createDigitalFolder(name) {
        const cleanName = name.trim();
        if (!cleanName)
            throw new Error("Enter a folder name.");
        const folder = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name: cleanName,
            filePaths: [],
            createdAt: Date.now(),
        };
        this.state.digitalFolders.push(folder);
        await this.write();
        return this.getState();
    }
    async renameDigitalFolder(folderId, name) {
        const cleanName = name.trim();
        if (!cleanName)
            throw new Error("Enter a folder name.");
        const folder = this.state.digitalFolders.find((item) => item.id === folderId);
        if (!folder)
            throw new Error("Digital folder not found.");
        folder.name = cleanName;
        await this.write();
        return this.getState();
    }
    async moveDigitalFolder(sourceId, targetId, after) {
        const folders = [...this.state.digitalFolders];
        const source = folders.findIndex((folder) => folder.id === sourceId);
        if (source < 0 || !folders.some((folder) => folder.id === targetId))
            throw new Error("Digital folder not found.");
        if (sourceId === targetId)
            return this.getState();
        const [folder] = folders.splice(source, 1);
        const target = folders.findIndex((item) => item.id === targetId);
        folders.splice(target + (after ? 1 : 0), 0, folder);
        this.state.digitalFolders = folders;
        await this.write();
        return this.getState();
    }
    async deleteDigitalFolder(folderId) {
        if (folderId === exports.FAVORITES_FOLDER_ID || folderId === exports.REFUSE_FOLDER_ID)
            throw new Error("Built-in folders cannot be deleted.");
        this.state.digitalFolders = this.state.digitalFolders.filter((folder) => folder.id !== folderId);
        await this.write();
        return this.getState();
    }
    async setDigitalFolderHidden(folderId, hidden) {
        const folder = this.state.digitalFolders.find((item) => item.id === folderId);
        if (!folder)
            throw new Error("Digital folder not found.");
        if (folderId === exports.REFUSE_FOLDER_ID)
            folder.hidden = true;
        else
            folder.hidden = Boolean(hidden);
        await this.write();
        return this.getState();
    }
    async addDigitalFolderReference(folderId, filePath) {
        const folder = this.state.digitalFolders.find((item) => item.id === folderId);
        if (!folder)
            throw new Error("Digital folder not found.");
        if (!folder.filePaths.includes(filePath))
            folder.filePaths.push(filePath);
        await this.write();
        return this.getState();
    }
    async addDigitalFolderReferences(folderId, filePaths) {
        const folder = this.state.digitalFolders.find((item) => item.id === folderId);
        if (!folder)
            throw new Error("Digital folder not found.");
        const existing = new Set(folder.filePaths);
        for (const filePath of filePaths) {
            if (existing.has(filePath))
                continue;
            existing.add(filePath);
            folder.filePaths.push(filePath);
        }
        await this.write();
        return this.getState();
    }
    async removeDigitalFolderReference(folderId, filePath) {
        const folder = this.state.digitalFolders.find((item) => item.id === folderId);
        if (!folder)
            throw new Error("Digital folder not found.");
        folder.filePaths = folder.filePaths.filter((item) => item !== filePath);
        await this.write();
        return this.getState();
    }
    async updateNameIndex(name, filePaths, sourceType, sourceId) {
        const existing = this.state.nameIndex.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            existing.filePaths = filePaths.map((path) => ({
                path,
                confirmed: false,
            }));
            existing.sourceType = sourceType;
            if (sourceId)
                existing.sourceId = sourceId;
        }
        else {
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
    async confirmNameFile(name, filePath) {
        const entry = this.state.nameIndex.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (entry) {
            const file = entry.filePaths.find((f) => f.path === filePath);
            if (file)
                file.confirmed = true;
            await this.write();
        }
        return this.getState();
    }
    async rejectNameFile(name, filePath) {
        const entry = this.state.nameIndex.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (entry) {
            entry.filePaths = entry.filePaths.filter((f) => f.path !== filePath);
            if (entry.filePaths.length === 0) {
                this.state.nameIndex = this.state.nameIndex.filter((e) => e.name !== name);
            }
            await this.write();
        }
        return this.getState();
    }
    async updateFileMetadata(filePaths, update) {
        if (update.year !== undefined &&
            update.year !== null &&
            (!Number.isInteger(update.year) || update.year < 1 || update.year > 9999))
            throw new Error("Enter a year between 1 and 9999.");
        for (const filePath of new Set(filePaths)) {
            const current = this.state.fileMetadata[filePath] ?? {
                keywords: [],
                updatedAt: 0,
            };
            const next = {
                ...current,
                keywords: update.keywords === undefined
                    ? current.keywords
                    : Array.from(new Set([
                        ...(update.mergeKeywords ? current.keywords : []),
                        ...update.keywords
                            .map((keyword) => keyword.trim())
                            .filter(Boolean),
                    ])),
                updatedAt: Date.now(),
            };
            if (update.displayName !== undefined) {
                const displayName = update.displayName?.trim();
                if (displayName)
                    next.displayName = displayName;
                else
                    delete next.displayName;
            }
            if (update.year !== undefined) {
                if (update.year === null)
                    delete next.year;
                else
                    next.year = update.year;
            }
            if (!next.displayName &&
                next.keywords.length === 0 &&
                next.year === undefined)
                delete this.state.fileMetadata[filePath];
            else
                this.state.fileMetadata[filePath] = next;
        }
        await this.write();
        return this.getState();
    }
    async setGeoOverrides(files, location) {
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
    async clearGeoOverrides(filePaths) {
        for (const filePath of filePaths)
            delete this.state.geoOverrides[filePath];
        await this.write();
        return this.getState();
    }
    write() {
        this.writeChain = this.writeChain.then(async () => {
            await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
            const temporaryPath = `${this.filePath}.tmp`;
            await fsPromises.writeFile(temporaryPath, JSON.stringify(this.state, null, 2));
            await fsPromises.rename(temporaryPath, this.filePath);
        });
        return this.writeChain;
    }
}
exports.StateStore = StateStore;
