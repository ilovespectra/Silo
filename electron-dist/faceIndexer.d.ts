import { IndexableFile } from "./semanticIndexer";
export type PersonStatus = "unconfirmed" | "confirmed" | "banned";
export interface FaceIndexProgress {
    status: "idle" | "loading-model" | "indexing" | "paused" | "complete" | "error";
    total: number;
    processed: number;
    remaining: number;
    faces: number;
    people: number;
    errors: number;
    currentFile: string | null;
    message: string;
}
export interface FaceRecord {
    id: string;
    imagePath: string;
    signature: string;
    box: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    score: number;
    descriptor: number[];
    cropPath: string;
    personIds: string[];
    manual?: boolean;
}
interface FaceBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface PersonCluster {
    id: string;
    name: string;
    faceIds: string[];
    manualPhotoPaths: string[];
    confirmedPhotoPaths: string[];
    rejectedPhotoPaths: string[];
    centroid: number[];
    createdAt: number;
    manual: boolean;
    selectedCoverPhotoPath?: string | null;
    status?: "confirmed" | "banned";
    trainedAt?: number;
    suggestedFaceIds?: string[];
}
export interface PersonSummary {
    id: string;
    name: string;
    faceCount: number;
    photoCount: number;
    coverCropUrl: string | null;
    manual: boolean;
    selectedCoverPhotoPath?: string | null;
    confirmedCount: number;
    reviewableCount: number;
    hiddenCount: number;
    fullyConfirmed: boolean;
    status: PersonStatus;
    suggestedCount: number;
    trainedAt: number | null;
}
export interface PersonDetail extends PersonSummary {
    photoPaths: string[];
    confirmedPhotoPaths: string[];
    suggestedPhotoPaths: string[];
    faces: Array<{
        id: string;
        imagePath: string;
        cropUrl: string;
        score: number;
    }>;
}
export interface BannedFace {
    personId: string;
    personName: string;
    confidence: number;
    reason: {
        type: "banned-people" | "explicit" | "other";
        description?: string;
    };
    addedAt: number;
}
type IndexedImagesProvider = () => IndexableFile[] | Promise<IndexableFile[]>;
type ProgressListener = (progress: FaceIndexProgress) => void;
export declare class FaceIndexer {
    private readonly hasActiveInteractiveSearch;
    private readonly directory;
    private readonly recordsPath;
    private readonly statePath;
    private readonly progressPath;
    private readonly cropsDirectory;
    private readonly modelPath;
    private readonly wasmPath;
    private readonly getIndexedImages;
    private readonly onProgress;
    private readonly faces;
    private readonly facesByImage;
    private readonly baseFaceBoxes;
    private readonly baseFaceCrops;
    private readonly processedSignatures;
    private readonly centroidDescriptorCounts;
    private state;
    private progress;
    private runtime;
    private runPromise;
    private pauseRequested;
    private bannedPhotoPaths;
    private recognitionChain;
    private recognitionListener;
    private stateWriteChain;
    private recordWriteChain;
    private faceRecordVersion;
    private recoveryJournal;
    private undoStack;
    private redoStack;
    private missingPhotos;
    private hiddenPhoto;
    private peopleChangeListener;
    private photoPeopleCache;
    private backgroundWorkPercent;
    constructor(userDataPath: string, modelPath: string, wasmPath: string, getIndexedImages: IndexedImagesProvider, onProgress: ProgressListener, indexStoragePath?: string, backgroundWorkPercent?: number, hasActiveInteractiveSearch?: () => boolean);
    setBackgroundWorkPercent(percent: number): void;
    initialize(): Promise<void>;
    setHiddenPhotoPredicate(predicate: (photoPath: string, ownerBanned: boolean) => boolean): void;
    setPeopleChangeListener(listener: () => void): void;
    /** Photos whose files were deleted stop counting toward people and their confirmation progress. */
    markMissingPhotos(photoPaths: string[]): Promise<void>;
    private recheckMissingPhotos;
    /** Called when the set of photos hidden by banned people changes. */
    setRecognitionListener(listener: (change: {
        added: string[];
        removed: string[];
    }) => void): void;
    getBannedPhotoPaths(): ReadonlySet<string>;
    /** Runs a user edit and records what it changed so it can be undone and redone. */
    recordEdit<T>(label: string, edit: () => Promise<T>): Promise<T>;
    getEditHistory(): {
        undoLabel: string;
        redoLabel: string;
    };
    undo(): Promise<string | null>;
    redo(): Promise<string | null>;
    private restoreSnapshot;
    getProgress(): {
        status: "error" | "idle" | "loading-model" | "indexing" | "paused" | "complete";
        total: number;
        processed: number;
        remaining: number;
        faces: number;
        people: number;
        errors: number;
        currentFile: string | null;
        message: string;
    };
    start(): Promise<void>;
    pause(): Promise<void>;
    getPeople(): PersonSummary[];
    getPerson(personId: string): PersonDetail | null;
    confirmAllPhotos(personId: string): Promise<PersonDetail | null>;
    /** Marks a fully confirmed person as known and searches every indexed face for more photos of them. */
    trainPerson(personId: string): Promise<PersonDetail | null>;
    banPerson(personId: string, confidence?: number): Promise<PersonDetail | null>;
    /**
     * Moves photos out of one person into another (or a newly created person), or just removes them when
     * `target` is null. The source's faces on each photo travel with it, and moved photos count as confirmed.
     */
    movePhotos(sourceId: string, imagePaths: string[], target: {
        personId?: string;
        newName?: string;
    } | null): Promise<{
        people: PersonSummary[];
        destinationId: string | null;
    }>;
    unbanPerson(personId: string): Promise<PersonDetail | null>;
    acceptSuggestions(personId: string, imagePaths: string[]): Promise<PersonDetail | null>;
    rejectSuggestions(personId: string, imagePaths: string[]): Promise<PersonDetail | null>;
    createPerson(name: string): Promise<PersonSummary[]>;
    renamePerson(personId: string, name: string): Promise<PersonSummary[]>;
    deletePerson(personId: string): Promise<PersonSummary[]>;
    assignFace(personId: string, faceId: string): Promise<PersonDetail | null>;
    addPhoto(personId: string, imagePath: string): Promise<PersonDetail | null>;
    confirmPhoto(personId: string, imagePath: string): Promise<PersonDetail | null>;
    confirmPhotos(personId: string, imagePaths: string[]): Promise<PersonDetail | null>;
    private newManualPerson;
    /**
     * Adds photos to a person as confirmed. A photo with exactly one detected face gets that face assigned
     * (taking it out of any unnamed automatic cluster); otherwise it is added as a manual photo.
     */
    addPhotosToPerson(target: {
        personId?: string;
        newName?: string;
    }, imagePaths: string[]): Promise<{
        people: PersonSummary[];
        personId: string;
        personName: string;
    }>;
    /**
     * Merges every photo and face of `sourceId` into `targetId`, keeping each photo's confirmed or
     * unconfirmed state, then deletes the source. The target keeps its name, status, and profile picture.
     */
    mergePeople(sourceId: string, targetId: string): Promise<{
        detail: PersonDetail | null;
        moved: number;
        confirmed: number;
    }>;
    removePhoto(personId: string, imagePath: string): Promise<PersonDetail | null>;
    private afterPersonPhotosChanged;
    setSelectedCoverPhoto(personId: string, photoPath: string | null): Promise<PersonDetail | null>;
    getBannedFaces(): Promise<BannedFace[]>;
    addBannedFace(personId: string, reason: {
        type: "banned-people" | "explicit" | "other";
        description?: string;
    }, confidence?: number): Promise<BannedFace[]>;
    removeBannedFace(personId: string): Promise<BannedFace[]>;
    setBannedFaceConfidence(personId: string, confidence: number): Promise<BannedFace[]>;
    getFaceBoxes(imagePath: string): {
        score: number;
        x: number;
        y: number;
        width: number;
        height: number;
    }[];
    getFacesForImage(imagePath: string): {
        id: string;
        imagePath: string;
        box: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        cropUrl: string;
        score: number;
        personIds: string[];
    }[];
    updateFaceBox(faceId: string, box: FaceBox, localPath?: string): Promise<{
        id: string;
        imagePath: string;
        box: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        cropUrl: string;
        score: number;
        personIds: string[];
    }[]>;
    deleteFace(faceId: string): Promise<{
        id: string;
        imagePath: string;
        box: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        cropUrl: string;
        score: number;
        personIds: string[];
    }[]>;
    createFaceBox(imagePath: string, localPath: string, box: FaceBox): Promise<{
        id: string;
        imagePath: string;
        box: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        cropUrl: string;
        score: number;
        personIds: string[];
    }[]>;
    getPeopleForImages(imagePaths: string[]): {
        [k: string]: string[];
    };
    private run;
    private processImage;
    private findOrCreateCluster;
    private loadRuntime;
    private appendProcessed;
    private loadRecords;
    private reconcilePeople;
    private combineSimilarClusters;
    private canCombineClusters;
    private mergeAutomaticClusters;
    private normalized;
    private boxOverlap;
    private summarizePerson;
    private photoPathsOf;
    private suggestedFacesOf;
    private requireFullyConfirmed;
    private indexFace;
    private replaceImageFaces;
    private isFaceDeleted;
    /** Descriptors of faces the user has verified as this person, sampled to keep matching fast. */
    private exemplarsOf;
    /** Best face per image within `maxDistance` of any exemplar; yields periodically to keep the main process responsive. */
    private matchFaces;
    private refreshSuggestions;
    private refreshBannedPhotos;
    /** Re-runs matching for every confirmed and banned person (after indexing finds new faces). */
    private refreshRecognition;
    private queueRecognition;
    private updateCentroid;
    private addDescriptorToCentroid;
    private distance;
    private signature;
    private newId;
    private cropUrl;
    private rebaseCropPath;
    private requirePerson;
    private paceBackgroundWork;
    private emitProgress;
    private updateProgress;
    private persistProgress;
    private persistState;
}
export {};
