import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as fsPromises from "fs/promises";
import { IndexableFile } from "./semanticIndexer";

const AUTO_CLUSTER_DISTANCE = 0.48;
const COMBINE_CLUSTER_DISTANCE = 0.4;
// Stricter than auto-clustering: a suggestion must sit close to an actual confirmed face.
const TRAINED_MATCH_DISTANCE = 0.42;
const MAX_EXEMPLARS = 64;
const USE_STRICT_X64_FACE_CLUSTERING = process.arch === "x64";
const FACE_WASM_THREAD_LIMIT = 1;
const FACE_STATE_CHECKPOINT_INTERVAL = 1000;

export type PersonStatus = "unconfirmed" | "confirmed" | "banned";
export type PersonNameSource = "automatic" | "user";

export interface FaceIndexProgress {
  status:
    | "idle"
    | "loading-model"
    | "indexing"
    | "paused"
    | "complete"
    | "error";
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
  box: { x: number; y: number; width: number; height: number };
  score: number;
  descriptor: number[];
  cropPath: string;
  personIds: string[];
  manual?: boolean;
  descriptorStatus?: "pending" | "ready" | "unavailable";
}

export interface FacePersonAssignment {
  faceId: string;
  personId?: string;
  newName?: string;
}

interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FaceEdit {
  box?: FaceBox;
  imagePath?: string;
  signature?: string;
  cropPath?: string;
  descriptor?: number[];
  descriptorStatus?: "pending" | "ready" | "unavailable";
  score?: number;
  deleted?: boolean;
  created?: boolean;
}

export interface PersonCluster {
  id: string;
  name: string;
  nameSource?: PersonNameSource;
  faceIds: string[];
  manualPhotoPaths: string[];
  confirmedPhotoPaths: string[];
  rejectedPhotoPaths: string[];
  centroid: number[];
  createdAt: number;
  manual: boolean;
  selectedCoverPhotoPath?: string | null; // User-selected profile picture
  status?: "confirmed" | "banned";
  trainedAt?: number;
  recognitionPending?: boolean;
  recognitionFailed?: boolean;
  suggestedFaceIds?: string[];
}

export interface PersonSummary {
  id: string;
  name: string;
  nameSource: PersonNameSource;
  faceCount: number;
  photoCount: number;
  coverCropUrl: string | null;
  manual: boolean;
  selectedCoverPhotoPath?: string | null; // User-selected profile picture
  confirmedCount: number;
  reviewableCount: number;
  hiddenCount: number;
  fullyConfirmed: boolean;
  status: PersonStatus;
  suggestedCount: number;
  trainedAt: number | null;
  recognitionPending: boolean;
  recognitionFailed: boolean;
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

interface FaceState {
  version: 1;
  faceRecordVersion?: number;
  stateJournalVersion?: number;
  people: PersonCluster[];
  faceEdits?: Record<string, FaceEdit>;
  bannedFaces?: { [personId: string]: BannedFace };
  bannedPhotoPaths?: string[];
  missingPhotoPaths?: string[];
}

interface FaceJournalEntry {
  imagePath: string;
  signature: string;
  faces: FaceRecord[];
  createdPeople?: PersonCluster[];
}

interface FaceStateJournalEntry {
  version: 1;
  sequence: number;
  people?: Record<string, PersonCluster | null>;
  personPatches?: Record<
    string,
    Partial<
      Pick<
        PersonCluster,
        | "centroid"
        | "suggestedFaceIds"
        | "recognitionPending"
        | "recognitionFailed"
      >
    >
  >;
  faceEdits?: Record<string, FaceEdit | null>;
  personFlags?: Record<
    string,
    Pick<PersonCluster, "recognitionPending" | "recognitionFailed">
  >;
  bannedFaces?: Record<string, BannedFace>;
}

export interface BannedFace {
  personId: string;
  personName: string;
  confidence: number; // 0-100, higher = stricter matching
  reason: {
    type: "banned-people" | "explicit" | "other";
    description?: string;
  };
  addedAt: number;
}

interface FaceRuntime {
  faceapi: any;
  sharp: any;
}

type IndexedImagesProvider = () => IndexableFile[] | Promise<IndexableFile[]>;
type ProgressListener = (progress: FaceIndexProgress) => void;

// Serialized people (null = did not exist) on each side of one user edit; only changed people are kept.
interface EditStep {
  label: string;
  before: Map<string, string | null>;
  after: Map<string, string | null>;
  facesBefore: Map<string, string | null>;
  facesAfter: Map<string, string | null>;
  recomputePersonIds: string[];
  bannedBefore: string | null;
  bannedAfter: string | null;
  faceEditsBefore: Map<string, string | null>;
  faceEditsAfter: Map<string, string | null>;
}

interface FaceRuntimeSnapshot {
  box: FaceBox;
  cropPath: string;
  descriptor: number[];
  descriptorStatus: NonNullable<FaceRecord["descriptorStatus"]>;
  score: number;
}

export interface FaceEditScope {
  personIds?: string[];
  faceIds?: string[];
  captureNewPeople?: boolean;
  captureNewFaceEdits?: boolean;
  trackBannedFaces?: boolean;
  trackPeople?: boolean;
}
const MAX_EDIT_HISTORY = 100;

const initialProgress: FaceIndexProgress = {
  status: "idle",
  total: 0,
  processed: 0,
  remaining: 0,
  faces: 0,
  people: 0,
  errors: 0,
  currentFile: null,
  message: "Waiting for indexed photos.",
};

export class FaceIndexer {
  private readonly directory: string;
  private readonly recordsPath: string;
  private readonly statePath: string;
  private readonly stateJournalPath: string;
  private readonly progressPath: string;
  private readonly cropsDirectory: string;
  private readonly modelPath: string;
  private readonly wasmPath: string;
  private readonly getIndexedImages: IndexedImagesProvider;
  private readonly onProgress: ProgressListener;
  private readonly faces = new Map<string, FaceRecord>();
  private readonly facesByImage = new Map<string, FaceRecord[]>();
  private readonly baseFaceBoxes = new Map<string, FaceBox>();
  private readonly baseFaceCrops = new Map<string, string>();
  private readonly processedSignatures = new Map<string, string>();
  private readonly centroidDescriptorCounts = new Map<string, number>();
  private state: FaceState = { version: 1, people: [], bannedFaces: {} };
  private progress = { ...initialProgress };
  private runtime: FaceRuntime | null = null;
  private runPromise: Promise<void> | null = null;
  private pauseRequested = false;
  private bannedPhotoPaths = new Set<string>();
  private recognitionListener: (change: {
    added: string[];
    removed: string[];
  }) => void = () => undefined;
  private recognitionProgressListener: (personIds: string[]) => void = () => undefined;
  private stateWriteChain: Promise<void> = Promise.resolve();
  private stateJournalSequence = 0;
  private recordWriteChain: Promise<void> = Promise.resolve();
  private faceRecordVersion = 0;
  private recoveryJournal: FaceJournalEntry[] = [];
  private undoStack: EditStep[] = [];
  private redoStack: EditStep[] = [];
  private missingPhotos = new Set<string>();
  // True when a photo is hidden from review (content protection / another person's ban).
  private hiddenPhoto: (photoPath: string, ownerBanned: boolean) => boolean =
    () => false;
  private peopleChangeListener: () => void = () => undefined;
  private photoPeopleCache: Map<string, string[]> | null = null;
  private readonly faceDescriptorJobs = new Map<string, Promise<void>>();
  private readonly pendingRecognitionJobs = new Map<
    string,
    Set<string> | null
  >();
  private recognitionProducerTimer: NodeJS.Timeout | null = null;
  private recognitionProducerRunning = false;
  private refreshBannedFacesPending = false;
  private faceDescriptorChain: Promise<void> = Promise.resolve();
  private backgroundWorkPercent = 5;

  constructor(
    userDataPath: string,
    modelPath: string,
    wasmPath: string,
    getIndexedImages: IndexedImagesProvider,
    onProgress: ProgressListener,
    indexStoragePath: string = userDataPath,
    backgroundWorkPercent = 5,
    private readonly hasActiveInteractiveSearch: () => boolean = () => false,
    private readonly resolveImagePath: (filePath: string) => Promise<string> = async (filePath) => filePath,
  ) {
    this.directory = path.join(indexStoragePath, "face-index");
    this.recordsPath = path.join(this.directory, "faces.jsonl");
    this.statePath = path.join(this.directory, "people.json");
    this.stateJournalPath = path.join(this.directory, "people-edits.jsonl");
    this.progressPath = path.join(this.directory, "progress.json");
    this.cropsDirectory = path.join(this.directory, "crops");
    this.modelPath = modelPath;
    this.wasmPath = wasmPath;
    this.getIndexedImages = getIndexedImages;
    this.onProgress = onProgress;
    this.setBackgroundWorkPercent(backgroundWorkPercent);
  }

  setBackgroundWorkPercent(percent: number) {
    if (!Number.isFinite(percent)) return;
    this.backgroundWorkPercent = Math.max(
      5,
      Math.min(100, Math.round(percent)),
    );
  }

  async initialize() {
    await fsPromises.mkdir(this.cropsDirectory, { recursive: true });
    let savedFaceRecordVersion: number | null = null;
    let hasJournalVersion = false;
    let savedStateJournalVersion = 0;
    try {
      this.state = JSON.parse(
        await fsPromises.readFile(this.statePath, "utf8"),
      ) as FaceState;
      const storedVersion = this.state.faceRecordVersion;
      if (Number.isSafeInteger(storedVersion) && storedVersion! >= 0) {
        savedFaceRecordVersion = storedVersion!;
        hasJournalVersion = true;
      }
      if (
        Number.isSafeInteger(this.state.stateJournalVersion) &&
        this.state.stateJournalVersion! >= 0
      )
        savedStateJournalVersion = this.state.stateJournalVersion!;
    } catch {
      this.state = { version: 1, people: [], bannedFaces: {} };
    }
    await this.loadStateJournal(savedStateJournalVersion);
    await this.loadRecords(savedFaceRecordVersion);
    this.applyPersistedFaceEdits();
    try {
      this.progress = {
        ...initialProgress,
        ...JSON.parse(await fsPromises.readFile(this.progressPath, "utf8")),
      };
      if (["loading-model", "indexing"].includes(this.progress.status)) {
        this.progress.status = "paused";
        this.progress.message =
          "Face indexing was interrupted and is ready to resume.";
      }
    } catch {
      await this.persistProgress();
    }
    const recoveredJournal = this.recoveryJournal.length > 0;
    this.reconcilePeople();
    let migratedNameSources = false;
    for (const person of this.state.people) {
      if (person.nameSource) continue;
      person.nameSource = /^Person \d+$/.test(person.name)
        ? "automatic"
        : "user";
      migratedNameSources = true;
    }
    if (!hasJournalVersion || recoveredJournal || migratedNameSources)
      await this.persistState();
    this.bannedPhotoPaths = new Set(this.state.bannedPhotoPaths ?? []);
    this.missingPhotos = new Set(this.state.missingPhotoPaths ?? []);
    const recognitionNeedsRefresh = !hasJournalVersion || recoveredJournal;
    void this.recheckMissingPhotos().then((restoredPhotos) => {
      // Stored suggestions are already current on a clean launch. Matching every
      // cached face against every trained person on each open burned CPU without
      // changing anything; refresh only after journal recovery or photo restore.
      const pendingRecognition = this.state.people.some(
        (person) => person.recognitionPending && person.status === "confirmed",
      );
      if (recognitionNeedsRefresh || restoredPhotos || pendingRecognition)
        void this.refreshRecognition();
    });
    void this.resumePendingFaceDescriptors();
  }

  setHiddenPhotoPredicate(
    predicate: (photoPath: string, ownerBanned: boolean) => boolean,
  ) {
    this.hiddenPhoto = predicate;
  }

  setPeopleChangeListener(listener: () => void) {
    this.peopleChangeListener = listener;
  }

  /** Photos whose files were deleted stop counting toward people and their confirmation progress. */
  async markMissingPhotos(photoPaths: string[]) {
    let changed = false;
    for (const photoPath of photoPaths) {
      if (this.missingPhotos.has(photoPath)) continue;
      this.missingPhotos.add(photoPath);
      changed = true;
    }
    if (!changed) return;
    this.state.missingPhotoPaths = Array.from(this.missingPhotos);
    await this.persistState();
  }

  private async recheckMissingPhotos(): Promise<boolean> {
    const restored: string[] = [];
    for (const photoPath of this.missingPhotos) {
      if (
        await fsPromises.access(photoPath).then(
          () => true,
          () => false,
        )
      )
        restored.push(photoPath);
    }
    if (restored.length === 0) return false;
    restored.forEach((photoPath) => this.missingPhotos.delete(photoPath));
    this.state.missingPhotoPaths = Array.from(this.missingPhotos);
    await this.persistState();
    return true;
  }

  /** Called when the set of photos hidden by banned people changes. */
  setRecognitionListener(
    listener: (change: { added: string[]; removed: string[] }) => void,
  ) {
    this.recognitionListener = listener;
  }

  setRecognitionProgressListener(listener: (personIds: string[]) => void) {
    this.recognitionProgressListener = listener;
  }

  getBannedPhotoPaths(): ReadonlySet<string> {
    return this.bannedPhotoPaths;
  }

  /** Runs a user edit and records what it changed so it can be undone and redone. */
  async recordEdit<T>(
    label: string,
    edit: () => Promise<T>,
    scope?: FaceEditScope,
  ): Promise<T> {
    const trackPeople = !scope || scope.trackPeople !== false;
    const trackedPersonIds = new Set(scope?.personIds ?? []);
    const trackedFaceIds = new Set(scope?.faceIds ?? []);
    if (scope) {
      for (const faceId of trackedFaceIds)
        for (const personId of this.faces.get(faceId)?.personIds ?? [])
          trackedPersonIds.add(personId);
    }
    const captureNewPeople =
      trackPeople && (scope?.captureNewPeople ?? !scope);
    const peopleIdsBefore = captureNewPeople
      ? new Set(this.state.people.map((person) => person.id))
      : null;
    const before = new Map<string, string | null>();
    if (!scope) {
      for (const person of this.state.people)
        before.set(person.id, JSON.stringify(person));
    } else if (trackPeople) {
      for (const personId of trackedPersonIds) {
        const person = this.state.people.find((item) => item.id === personId);
        if (person) before.set(personId, JSON.stringify(person));
      }
    }
    const facesBefore = new Map<string, string | null>();
    for (const faceId of trackedFaceIds) {
      const face = this.faces.get(faceId);
      if (!face) continue;
      const snapshot: FaceRuntimeSnapshot = {
        box: { ...face.box },
        cropPath: face.cropPath,
        descriptor: [...face.descriptor],
        descriptorStatus: face.descriptor.length
          ? "ready"
          : face.descriptorStatus ?? "unavailable",
        score: face.score,
      };
      facesBefore.set(faceId, JSON.stringify(snapshot));
    }
    const trackBannedFaces = scope?.trackBannedFaces ?? !scope;
    const bannedBefore = trackBannedFaces
      ? JSON.stringify(this.state.bannedFaces ?? {})
      : null;
    const faceEditsBefore = new Map<string, string | null>();
    let faceEditIdsBefore: Set<string> | null = null;
    if (!scope) {
      for (const [id, value] of Object.entries(this.state.faceEdits ?? {}))
        faceEditsBefore.set(id, JSON.stringify(value));
    } else {
      for (const faceId of trackedFaceIds) {
        const value = this.state.faceEdits?.[faceId];
        faceEditsBefore.set(faceId, value ? JSON.stringify(value) : null);
      }
      if (scope.captureNewFaceEdits)
        faceEditIdsBefore = new Set(Object.keys(this.state.faceEdits ?? {}));
    }
    const result = await edit();
    if (peopleIdsBefore)
      for (const person of this.state.people)
        if (!peopleIdsBefore.has(person.id)) trackedPersonIds.add(person.id);
    const step: EditStep = {
      label,
      before: new Map(),
      after: new Map(),
      facesBefore: new Map(),
      facesAfter: new Map(),
      recomputePersonIds: trackPeople ? [] : [...trackedPersonIds],
      bannedBefore,
      bannedAfter: trackBannedFaces
        ? JSON.stringify(this.state.bannedFaces ?? {})
        : null,
      faceEditsBefore: new Map(),
      faceEditsAfter: new Map(),
    };
    const currentPeople = new Map<string, PersonCluster>();
    for (const person of this.state.people) {
      if (
        trackPeople &&
        (!scope || trackedPersonIds.has(person.id)) ||
        Boolean(
          trackPeople &&
            peopleIdsBefore &&
            !peopleIdsBefore.has(person.id),
        )
      )
        currentPeople.set(person.id, person);
    }
    const personIds = trackPeople
      ? new Set([...before.keys(), ...trackedPersonIds])
      : new Set<string>();
    for (const personId of personIds) {
      const nowPerson = currentPeople.get(personId);
      const now = nowPerson ? JSON.stringify(nowPerson) : null;
      const was = before.get(personId) ?? null;
      if (was === now) continue;
      step.before.set(personId, was);
      step.after.set(personId, now);
    }
    const currentFaceEdits = this.state.faceEdits ?? {};
    if (!scope)
      for (const faceId of Object.keys(currentFaceEdits))
        trackedFaceIds.add(faceId);
    if (faceEditIdsBefore)
      for (const faceId of Object.keys(currentFaceEdits))
        if (!faceEditIdsBefore.has(faceId)) trackedFaceIds.add(faceId);
    const faceEditIds = new Set([
      ...faceEditsBefore.keys(),
      ...trackedFaceIds,
    ]);
    for (const faceId of faceEditIds) {
      const was = faceEditsBefore.get(faceId) ?? null;
      const now = currentFaceEdits[faceId]
        ? JSON.stringify(currentFaceEdits[faceId])
        : null;
      if (was === now) continue;
      step.faceEditsBefore.set(faceId, was);
      step.faceEditsAfter.set(faceId, now);
    }
    for (const faceId of trackedFaceIds) {
      const face = this.faces.get(faceId);
      if (!face) continue;
      const snapshot: FaceRuntimeSnapshot = {
        box: { ...face.box },
        cropPath: face.cropPath,
        descriptor: [...face.descriptor],
        descriptorStatus: face.descriptor.length
          ? "ready"
          : face.descriptorStatus ?? "unavailable",
        score: face.score,
      };
      const now = JSON.stringify(snapshot);
      const was = facesBefore.get(faceId) ?? null;
      if (was === now) continue;
      step.facesBefore.set(faceId, was);
      step.facesAfter.set(faceId, now);
    }
    if (
      step.before.size > 0 ||
      (step.bannedBefore !== null && step.bannedBefore !== step.bannedAfter) ||
      step.faceEditsBefore.size > 0 ||
      step.facesBefore.size > 0
    ) {
      this.undoStack.push(step);
      if (this.undoStack.length > MAX_EDIT_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this.peopleChangeListener();
    }
    return result;
  }

  getEditHistory() {
    return {
      undoLabel: this.undoStack[this.undoStack.length - 1]?.label ?? null,
      redoLabel: this.redoStack[this.redoStack.length - 1]?.label ?? null,
    };
  }

  async undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    await this.restoreSnapshot(
      step.before,
      step.bannedBefore,
      step.faceEditsBefore,
      step.facesBefore,
      step.recomputePersonIds,
    );
    this.redoStack.push(step);
    this.peopleChangeListener();
    return step.label;
  }

  async redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    await this.restoreSnapshot(
      step.after,
      step.bannedAfter,
      step.faceEditsAfter,
      step.facesAfter,
      step.recomputePersonIds,
    );
    this.undoStack.push(step);
    this.peopleChangeListener();
    return step.label;
  }

  private async restoreSnapshot(
    snapshot: Map<string, string | null>,
    bannedFaces: string | null,
    faceEdits: Map<string, string | null>,
    faces: Map<string, string | null>,
    recomputePersonIds: string[],
  ) {
    for (const [personId, serialized] of snapshot) {
      const index = this.state.people.findIndex(
        (person) => person.id === personId,
      );
      if (serialized === null) {
        if (index >= 0) this.state.people.splice(index, 1);
      } else if (index >= 0) {
        this.state.people[index] = JSON.parse(serialized) as PersonCluster;
      } else {
        this.state.people.push(JSON.parse(serialized) as PersonCluster);
      }
    }
    if (bannedFaces !== null) this.state.bannedFaces = JSON.parse(bannedFaces);
    this.state.faceEdits ??= {};
    for (const [faceId, serialized] of faceEdits) {
      if (serialized === null) delete this.state.faceEdits[faceId];
      else this.state.faceEdits[faceId] = JSON.parse(serialized) as FaceEdit;
    }
    for (const [faceId, serialized] of faceEdits) {
      if (serialized !== null) continue;
      const face = this.faces.get(faceId);
      if (face) {
        face.box = { ...(this.baseFaceBoxes.get(faceId) ?? face.box) };
        const override = this.state.faceEdits[faceId]?.box;
        if (override) face.box = { ...override };
        face.cropPath = this.rebaseCropPath(
          this.state.faceEdits[faceId]?.cropPath ??
            this.baseFaceCrops.get(faceId) ??
            face.cropPath,
        );
        const descriptorEdit = this.state.faceEdits[faceId];
        if (descriptorEdit?.descriptor) face.descriptor = [...descriptorEdit.descriptor];
        if (descriptorEdit?.descriptorStatus)
          face.descriptorStatus = descriptorEdit.descriptorStatus;
        if (face.manual && !this.state.faceEdits[faceId])
          this.state.faceEdits[faceId] = { deleted: true };
      }
    }
    for (const [faceId, serialized] of faces) {
      const face = this.faces.get(faceId);
      if (!face || serialized === null) continue;
      const restored = JSON.parse(serialized) as FaceRuntimeSnapshot;
      face.box = { ...restored.box };
      face.cropPath = this.rebaseCropPath(restored.cropPath);
      face.descriptor = [...restored.descriptor];
      face.descriptorStatus = restored.descriptorStatus;
      face.score = restored.score;
      // Keep undo/redo durable even when the prior state had no explicit edit
      // override and the append-only face journal already contains the moved box.
      this.state.faceEdits[faceId] = {
        ...this.state.faceEdits[faceId],
        ...(face.manual ? { created: true } : {}),
        box: { ...face.box },
        cropPath: face.cropPath,
        descriptor: [...face.descriptor],
        descriptorStatus: face.descriptorStatus,
        score: face.score,
      };
    }
    // Face -> person links are derived from people, so rebuild them to match the restored state.
    for (const face of this.faces.values()) face.personIds = [];
    for (const person of this.state.people)
      for (const faceId of person.faceIds)
        this.faces.get(faceId)?.personIds.push(person.id);
    const peopleToRecompute = new Set([
      ...snapshot.keys(),
      ...recomputePersonIds,
    ]);
    for (const personId of peopleToRecompute) {
      const person = this.state.people.find((item) => item.id === personId);
      if (!person) continue;
      this.updateCentroid(person);
      if (recomputePersonIds.includes(personId) && person.status === "confirmed" && person.trainedAt) {
        person.recognitionPending = true;
        person.recognitionFailed = false;
      }
    }
    this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({
      personIds: [...snapshot.keys()],
      personPatchIds: recomputePersonIds,
      faceIds: [...faceEdits.keys(), ...faces.keys()],
      ...(bannedFaces === null ? {} : { bannedFaces: this.state.bannedFaces ?? {} }),
    });
    await this.resumePendingFaceDescriptors();
    for (const personId of recomputePersonIds) {
      const person = this.state.people.find((item) => item.id === personId);
      if (person?.status === "confirmed" && person.trainedAt)
        this.schedulePersonRecognition(person);
    }
  }

  getProgress() {
    return { ...this.progress };
  }

  start(images?: IndexableFile[]) {
    if (this.runPromise) return this.runPromise;
    this.pauseRequested = false;
    this.runPromise = this.run(images).finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  async pause() {
    this.pauseRequested = true;
    if (this.runPromise) {
      await this.runPromise;
    } else {
      await this.updateProgress(
        { status: "paused", message: "Face indexing paused." },
        true,
      );
    }
  }

  getPeople(): PersonSummary[] {
    return this.state.people
      .map((person) => this.summarizePerson(person))
      .filter(
        (person) =>
          person.photoCount > 0 ||
          person.manual ||
          person.status !== "unconfirmed",
      )
      .sort(
        (first, second) =>
          second.photoCount - first.photoCount ||
          first.name.localeCompare(second.name),
    );
  }

  getPeopleByIds(personIds: string[]): PersonSummary[] {
    if (personIds.length === 0) return [];
    const requested = new Set(personIds);
    return this.state.people
      .filter((person) => requested.has(person.id))
      .map((person) => this.summarizePerson(person))
      .filter(
        (person) =>
          person.photoCount > 0 ||
          person.manual ||
          person.status !== "unconfirmed",
      );
  }

  getPersonIdsForFace(faceId: string): string[] {
    const personIds = new Set(this.faces.get(faceId)?.personIds ?? []);
    for (const person of this.state.people)
      if (person.suggestedFaceIds?.includes(faceId)) personIds.add(person.id);
    return [...personIds];
  }

  getPerson(personId: string): PersonDetail | null {
    const person = this.state.people.find((item) => item.id === personId);
    if (!person) return null;
    const faces = person.faceIds
      .map((faceId) => this.faces.get(faceId))
      .filter((face): face is FaceRecord => Boolean(face))
      .filter((face) => !this.isFaceDeleted(face))
      .filter((face) => !person.rejectedPhotoPaths.includes(face.imagePath));
    return {
      ...this.summarizePerson(person),
      photoPaths: this.photoPathsOf(person),
      confirmedPhotoPaths: [...person.confirmedPhotoPaths],
      suggestedPhotoPaths: this.suggestedFacesOf(person).map(
        (face) => face.imagePath,
      ),
      faces: faces.map((face) => ({
        id: face.id,
        imagePath: face.imagePath,
        cropUrl: this.cropUrl(face.cropPath),
        score: face.score,
      })),
    };
  }

  async confirmAllPhotos(personId: string) {
    const person = this.requirePerson(personId);
    const ownerBanned = person.status === "banned";
    // Only photos the user can actually see; hidden ones were never reviewed.
    const reviewable = this.photoPathsOf(person).filter(
      (photoPath) => !this.hiddenPhoto(photoPath, ownerBanned),
    );
    person.confirmedPhotoPaths = Array.from(
      new Set([...person.confirmedPhotoPaths, ...reviewable]),
    );
    await this.persistStateDelta({ personIds: [personId] });
    return this.getPerson(personId);
  }

  /** Marks a fully confirmed person as known and searches every indexed face for more photos of them. */
  async trainPerson(personId: string) {
    const person = this.requireFullyConfirmed(personId);
    if (person.status !== "banned") person.status = "confirmed";
    person.trainedAt = Date.now();
    person.recognitionPending = true;
    person.recognitionFailed = false;
    await this.persistStateDelta({ personIds: [personId] });
    this.schedulePersonRecognition(person);
    return this.getPerson(personId);
  }

  async banPerson(personId: string, confidence = 80) {
    const person = this.requirePerson(personId);
    person.status = "banned";
    person.trainedAt = Date.now();
    if (!this.state.bannedFaces) this.state.bannedFaces = {};
    this.state.bannedFaces[personId] = {
      personId,
      personName: person.name,
      confidence:
        this.state.bannedFaces[personId]?.confidence ??
        Math.max(0, Math.min(100, confidence)),
      reason: { type: "banned-people" },
      addedAt: Date.now(),
    };
    await this.persistStateDelta({
      personIds: [personId],
      bannedFaces: this.state.bannedFaces,
    });
    this.requestRecognitionReindex([], { refreshBanned: true });
    return this.getPerson(personId);
  }

  /**
   * Moves photos out of one person into another (or a newly created person), or just removes them when
   * `target` is null. The source's faces on each photo travel with it, and moved photos count as confirmed.
   */
  async movePhotos(
    sourceId: string,
    imagePaths: string[],
    target: { personId?: string; newName?: string } | null,
  ) {
    const source = this.requirePerson(sourceId);
    let destination: PersonCluster | null = null;
    if (target?.personId) {
      if (target.personId === sourceId)
        throw new Error("Choose a different person.");
      destination = this.requirePerson(target.personId);
    } else if (target?.newName !== undefined) {
      const name = target.newName.trim();
      if (!name) throw new Error("Enter a person name.");
      destination = {
        id: this.newId("person"),
        name,
        faceIds: [],
        manualPhotoPaths: [],
        confirmedPhotoPaths: [],
        rejectedPhotoPaths: [],
        centroid: [],
        createdAt: Date.now(),
        manual: true,
      };
      this.state.people.push(destination);
    }

    for (const imagePath of new Set(imagePaths)) {
      const movingFaces = source.faceIds
        .map((faceId) => this.faces.get(faceId))
        .filter(
          (face): face is FaceRecord =>
            Boolean(face) && face!.imagePath === imagePath,
        );
      const movingIds = new Set(movingFaces.map((face) => face.id));
      source.faceIds = source.faceIds.filter(
        (faceId) => !movingIds.has(faceId),
      );
      source.suggestedFaceIds = (source.suggestedFaceIds ?? []).filter(
        (faceId) => this.faces.get(faceId)?.imagePath !== imagePath,
      );
      source.manualPhotoPaths = source.manualPhotoPaths.filter(
        (item) => item !== imagePath,
      );
      source.confirmedPhotoPaths = source.confirmedPhotoPaths.filter(
        (item) => item !== imagePath,
      );
      if (!source.rejectedPhotoPaths.includes(imagePath))
        source.rejectedPhotoPaths.push(imagePath);
      for (const face of movingFaces)
        face.personIds = face.personIds.filter(
          (personId) => personId !== sourceId,
        );
      if (!destination) continue;

      if (movingFaces.length > 0) {
        for (const face of movingFaces) {
          if (!destination.faceIds.includes(face.id))
            destination.faceIds.push(face.id);
          if (!face.personIds.includes(destination.id))
            face.personIds.push(destination.id);
        }
      } else if (!destination.manualPhotoPaths.includes(imagePath)) {
        destination.manualPhotoPaths.push(imagePath);
      }
      if (!destination.confirmedPhotoPaths.includes(imagePath))
        destination.confirmedPhotoPaths.push(imagePath);
      destination.rejectedPhotoPaths = destination.rejectedPhotoPaths.filter(
        (item) => item !== imagePath,
      );
    }

    this.updateCentroid(source);
    if (destination) this.updateCentroid(destination);
    if (source.status === "banned" || destination?.status === "banned")
      this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({
      personIds: [source.id, ...(destination ? [destination.id] : [])],
    });
    return { people: this.getPeople(), destinationId: destination?.id ?? null };
  }

  async unbanPerson(personId: string) {
    const person = this.requirePerson(personId);
    if (person.status === "banned") person.status = "confirmed";
    if (this.state.bannedFaces) delete this.state.bannedFaces[personId];
    this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({
      personIds: [personId],
      bannedFaces: this.state.bannedFaces ?? {},
    });
    return this.getPerson(personId);
  }

  async acceptSuggestions(personId: string, imagePaths: string[]) {
    const person = this.requirePerson(personId);
    const accepted = new Set(imagePaths);
    for (const face of this.suggestedFacesOf(person)) {
      if (!accepted.has(face.imagePath)) continue;
      if (!person.faceIds.includes(face.id)) person.faceIds.push(face.id);
      if (!face.personIds.includes(personId)) face.personIds.push(personId);
      if (!person.confirmedPhotoPaths.includes(face.imagePath))
        person.confirmedPhotoPaths.push(face.imagePath);
      person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter(
        (item) => item !== face.imagePath,
      );
    }
    person.suggestedFaceIds = (person.suggestedFaceIds ?? []).filter(
      (faceId) => !accepted.has(this.faces.get(faceId)?.imagePath ?? ""),
    );
    this.updateCentroid(person);
    if (person.status === "banned")
      this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({ personIds: [personId] });
    return this.getPerson(personId);
  }

  async rejectSuggestions(personId: string, imagePaths: string[]) {
    const person = this.requirePerson(personId);
    const rejected = new Set(imagePaths);
    for (const imagePath of rejected)
      if (!person.rejectedPhotoPaths.includes(imagePath))
        person.rejectedPhotoPaths.push(imagePath);
    person.suggestedFaceIds = (person.suggestedFaceIds ?? []).filter(
      (faceId) => !rejected.has(this.faces.get(faceId)?.imagePath ?? ""),
    );
    await this.persistStateDelta({ personIds: [personId] });
    if (person.status === "banned")
      this.requestRecognitionReindex([], { refreshBanned: true });
    return this.getPerson(personId);
  }

  async createPerson(name: string) {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Enter a person name.");
    const person: PersonCluster = {
      id: this.newId("person"),
      name: cleanName,
      nameSource: "user",
      faceIds: [],
      manualPhotoPaths: [],
      confirmedPhotoPaths: [],
      rejectedPhotoPaths: [],
      centroid: [],
      createdAt: Date.now(),
      manual: true,
    };
    this.state.people.push(person);
    await this.persistStateDelta({ personIds: [person.id] });
    return this.getPeople();
  }

  async renamePerson(personId: string, name: string) {
    const person = this.requirePerson(personId);
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Enter a person name.");
    person.name = cleanName;
    person.nameSource = "user";
    await this.persistStateDelta({ personIds: [person.id] });
    return this.getPeople();
  }

  async deletePerson(personId: string) {
    const wasBanned = Boolean(this.state.bannedFaces?.[personId]);
    this.state.people = this.state.people.filter(
      (person) => person.id !== personId,
    );
    for (const face of this.faces.values())
      face.personIds = face.personIds.filter((id) => id !== personId);
    if (wasBanned) {
      delete this.state.bannedFaces![personId];
      this.requestRecognitionReindex([], { refreshBanned: true });
    }
    await this.persistStateDelta({
      personIds: [personId],
      ...(wasBanned ? { bannedFaces: this.state.bannedFaces ?? {} } : {}),
    });
    return this.getPeople();
  }

  async assignFace(personId: string, faceId: string) {
    const person = this.requirePerson(personId);
    const face = this.faces.get(faceId);
    if (!face) throw new Error("Face not found.");
    if (!person.faceIds.includes(faceId)) person.faceIds.push(faceId);
    if (!face.personIds.includes(personId)) face.personIds.push(personId);
    if (!person.confirmedPhotoPaths.includes(face.imagePath))
      person.confirmedPhotoPaths.push(face.imagePath);
    person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter(
      (item) => item !== face.imagePath,
    );
    this.updateCentroid(person);
    await this.afterPersonPhotosChanged(person);
    return this.getPerson(personId);
  }

  /** Assigns a photo's edited face boxes in one undoable operation. */
  async assignFaces(assignments: FacePersonAssignment[]) {
    if (!assignments.length) throw new Error("Select at least one face.");

    const seenFaces = new Set<string>();
    const prepared = assignments.map((assignment) => {
      if (seenFaces.has(assignment.faceId))
        throw new Error("A face can only be assigned once per save.");
      seenFaces.add(assignment.faceId);
      const face = this.faces.get(assignment.faceId);
      if (!face || this.isFaceDeleted(face))
        throw new Error("One of the selected face boxes no longer exists.");
      const personId = assignment.personId?.trim();
      const newName = assignment.newName?.trim();
      if (Boolean(personId) === Boolean(newName))
        throw new Error("Choose an existing person or enter a new name for each face.");
      return {
        face,
        person: personId ? this.requirePerson(personId) : null,
        newName,
      };
    });

    const newPeopleByName = new Map<string, PersonCluster>();
    const affected = new Set<PersonCluster>();
    for (const item of prepared) {
      let person: PersonCluster;
      if (item.person) {
        person = item.person;
      } else {
        const key = item.newName!.toLocaleLowerCase();
        person = newPeopleByName.get(key)!;
        if (!person) {
          person = {
            id: this.newId("person"),
            name: item.newName!,
            nameSource: "user",
            faceIds: [],
            manualPhotoPaths: [],
            confirmedPhotoPaths: [],
            rejectedPhotoPaths: [],
            centroid: [],
            createdAt: Date.now(),
            manual: true,
          };
          newPeopleByName.set(key, person);
          this.state.people.push(person);
        }
      }

      // Person assignment is additive: one detected face can belong to several
      // named clusters, which lets multi-person searches find the same group photo.
      if (!person.faceIds.includes(item.face.id)) person.faceIds.push(item.face.id);
      if (!item.face.personIds.includes(person.id))
        item.face.personIds.push(person.id);
      if (!person.confirmedPhotoPaths.includes(item.face.imagePath))
        person.confirmedPhotoPaths.push(item.face.imagePath);
      person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter(
        (imagePath) => imagePath !== item.face.imagePath,
      );
      affected.add(person);
    }

    for (const person of affected) {
      this.updateCentroid(person);
      if (person.status === "confirmed" && person.trainedAt) {
        person.recognitionPending = true;
        person.recognitionFailed = false;
      }
    }
    if (Array.from(affected).some((person) => person.status === "banned"))
      this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({
      personIds: Array.from(affected, (person) => person.id),
    });
    for (const person of affected)
      if (person.status === "confirmed" && person.trainedAt)
        this.schedulePersonRecognition(person);
    // Assignment affects only the clusters touched by this photo. Returning a
    // full People snapshot here made one manual edit resummarize every cluster
    // before the renderer immediately requested that full snapshot again.
    return Array.from(affected, (person) => this.summarizePerson(person));
  }

  async addPhoto(personId: string, imagePath: string) {
    const person = this.requirePerson(personId);
    if (!person.manualPhotoPaths.includes(imagePath))
      person.manualPhotoPaths.push(imagePath);
    person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter(
      (item) => item !== imagePath,
    );
    await this.afterPersonPhotosChanged(person);
    return this.getPerson(personId);
  }

  async confirmPhoto(personId: string, imagePath: string) {
    const person = this.requirePerson(personId);
    if (!person.confirmedPhotoPaths.includes(imagePath))
      person.confirmedPhotoPaths.push(imagePath);
    person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter(
      (item) => item !== imagePath,
    );
    await this.persistStateDelta({ personIds: [personId] });
    return this.getPerson(personId);
  }

  async confirmPhotos(personId: string, imagePaths: string[]) {
    const person = this.requirePerson(personId);
    const owned = new Set(this.photoPathsOf(person));
    const confirmed = new Set(person.confirmedPhotoPaths);
    for (const imagePath of imagePaths) {
      if (!owned.has(imagePath) || confirmed.has(imagePath)) continue;
      confirmed.add(imagePath);
      person.confirmedPhotoPaths.push(imagePath);
    }
    await this.persistStateDelta({ personIds: [personId] });
    return this.getPerson(personId);
  }

  private newManualPerson(name: string): PersonCluster {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Enter a person name.");
    const person: PersonCluster = {
      id: this.newId("person"),
      name: cleanName,
      nameSource: "user",
      faceIds: [],
      manualPhotoPaths: [],
      confirmedPhotoPaths: [],
      rejectedPhotoPaths: [],
      centroid: [],
      createdAt: Date.now(),
      manual: true,
    };
    this.state.people.push(person);
    return person;
  }

  /** Adds photos to a person's cluster as confirmed without removing other memberships. */
  async addPhotosToPerson(
    target: { personId?: string; newName?: string },
    imagePaths: string[],
  ) {
    const person = target.personId
      ? this.requirePerson(target.personId)
      : this.newManualPerson(target.newName ?? "");
    const affected = new Set<PersonCluster>([person]);
    for (const imagePath of new Set(imagePaths)) {
      person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter(
        (item) => item !== imagePath,
      );
      const faces = this.facesByImage.get(imagePath) ?? [];
      const activeFaces = faces.filter((face) => !this.isFaceDeleted(face));
      const alreadyHasFace = activeFaces.some((face) =>
        person.faceIds.includes(face.id),
      );
      if (!alreadyHasFace && activeFaces.length === 1) {
        const face = activeFaces[0];
        if (!person.faceIds.includes(face.id)) person.faceIds.push(face.id);
        if (!face.personIds.includes(person.id)) face.personIds.push(person.id);
      } else if (
        !alreadyHasFace &&
        !person.manualPhotoPaths.includes(imagePath)
      ) {
        person.manualPhotoPaths.push(imagePath);
      }
      if (!person.confirmedPhotoPaths.includes(imagePath))
        person.confirmedPhotoPaths.push(imagePath);
    }
    affected.forEach((item) => this.updateCentroid(item));
    if (person.status === "banned")
      this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({ personIds: [person.id] });
    return {
      people: this.getPeople(),
      personId: person.id,
      personName: person.name,
    };
  }

  /**
   * Merges every photo and face of `sourceId` into `targetId`, keeping each photo's confirmed or
   * unconfirmed state, then deletes the source. The target keeps its name, status, and profile picture.
   */
  async mergePeople(sourceId: string, targetId: string) {
    if (sourceId === targetId)
      throw new Error("Choose a different person to merge into.");
    const source = this.requirePerson(sourceId);
    const target = this.requirePerson(targetId);
    const sourcePhotos = new Set(this.photoPathsOf(source));
    const sourceConfirmed = new Set(
      source.confirmedPhotoPaths.filter((photoPath) =>
        sourcePhotos.has(photoPath),
      ),
    );

    for (const faceId of source.faceIds) {
      const face = this.faces.get(faceId);
      if (!face || source.rejectedPhotoPaths.includes(face.imagePath)) continue;
      if (!target.faceIds.includes(faceId)) target.faceIds.push(faceId);
      face.personIds = Array.from(
        new Set([
          ...face.personIds.filter((personId) => personId !== sourceId),
          targetId,
        ]),
      );
    }
    for (const photoPath of source.manualPhotoPaths)
      if (
        sourcePhotos.has(photoPath) &&
        !target.manualPhotoPaths.includes(photoPath)
      )
        target.manualPhotoPaths.push(photoPath);
    // The user chose this merge, so the source's photos override earlier removals from the target.
    target.rejectedPhotoPaths = target.rejectedPhotoPaths.filter(
      (photoPath) => !sourcePhotos.has(photoPath),
    );
    for (const photoPath of sourceConfirmed)
      if (!target.confirmedPhotoPaths.includes(photoPath))
        target.confirmedPhotoPaths.push(photoPath);
    target.suggestedFaceIds = Array.from(
      new Set([
        ...(target.suggestedFaceIds ?? []),
        ...(source.suggestedFaceIds ?? []),
      ]),
    );

    this.state.people = this.state.people.filter(
      (person) => person.id !== sourceId,
    );
    for (const face of this.faces.values())
      if (face.personIds.includes(sourceId))
        face.personIds = face.personIds.filter(
          (personId) => personId !== sourceId,
        );
    const sourceWasBanned = Boolean(this.state.bannedFaces?.[sourceId]);
    if (sourceWasBanned) delete this.state.bannedFaces![sourceId];
    this.updateCentroid(target);
    if (sourceWasBanned || target.status === "banned")
      this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({
      personIds: [sourceId, targetId],
      bannedFaces: this.state.bannedFaces ?? {},
    });
    return {
      detail: this.getPerson(targetId),
      moved: sourcePhotos.size,
      confirmed: sourceConfirmed.size,
    };
  }

  async removePhoto(personId: string, imagePath: string) {
    const person = this.requirePerson(personId);
    if (!person.rejectedPhotoPaths.includes(imagePath))
      person.rejectedPhotoPaths.push(imagePath);
    person.manualPhotoPaths = person.manualPhotoPaths.filter(
      (item) => item !== imagePath,
    );
    person.confirmedPhotoPaths = person.confirmedPhotoPaths.filter(
      (item) => item !== imagePath,
    );
    await this.afterPersonPhotosChanged(person);
    return this.getPerson(personId);
  }

  private async afterPersonPhotosChanged(person: PersonCluster) {
    if (person.status === "banned")
      this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({ personIds: [person.id] });
  }

  async setSelectedCoverPhoto(personId: string, photoPath: string | null) {
    const person = this.requirePerson(personId);
    // If setting a specific photo, verify it's actually in this person's photos
    if (photoPath !== null) {
      const allPhotos = this.photoPathsOf(person);
      if (!allPhotos.includes(photoPath)) {
        throw new Error("Selected photo is not in this person's collection.");
      }
    }
    person.selectedCoverPhotoPath = photoPath;
    await this.persistStateDelta({ personIds: [personId] });
    return this.getPerson(personId);
  }

  async getBannedFaces() {
    return Object.values(this.state.bannedFaces || {}).sort(
      (a, b) => b.addedAt - a.addedAt,
    );
  }

  async addBannedFace(
    personId: string,
    reason: {
      type: "banned-people" | "explicit" | "other";
      description?: string;
    },
    confidence: number = 80,
  ) {
    const person = this.requirePerson(personId);
    const banned: BannedFace = {
      personId,
      personName: person.name,
      confidence: Math.max(0, Math.min(100, confidence)),
      reason,
      addedAt: Date.now(),
    };
    if (!this.state.bannedFaces) this.state.bannedFaces = {};
    this.state.bannedFaces[personId] = banned;
    person.status = "banned";
    this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({
      personIds: [personId],
      bannedFaces: this.state.bannedFaces ?? {},
    });
    return this.getBannedFaces();
  }

  async removeBannedFace(personId: string) {
    if (this.state.bannedFaces && personId in this.state.bannedFaces) {
      delete this.state.bannedFaces[personId];
      const person = this.state.people.find((item) => item.id === personId);
      if (person?.status === "banned") person.status = "confirmed";
      this.requestRecognitionReindex([], { refreshBanned: true });
      await this.persistStateDelta({
        personIds: person ? [personId] : [],
        bannedFaces: this.state.bannedFaces ?? {},
      });
    }
    return this.getBannedFaces();
  }

  async setBannedFaceConfidence(personId: string, confidence: number) {
    if (!this.state.bannedFaces || !(personId in this.state.bannedFaces)) {
      throw new Error("This person is not in the banned list.");
    }
    this.state.bannedFaces[personId].confidence = Math.max(
      0,
      Math.min(100, confidence),
    );
    this.requestRecognitionReindex([], { refreshBanned: true });
    await this.persistStateDelta({
      personIds: [personId],
      bannedFaces: this.state.bannedFaces,
    });
    return this.getBannedFaces();
  }

  getFaceBoxes(imagePath: string) {
    return (this.facesByImage.get(imagePath) ?? [])
      .filter((face) => !this.isFaceDeleted(face))
      .map((face) => ({
        ...face.box,
        score: face.score,
      }));
  }

  getFacesForImage(imagePath: string) {
    return (this.facesByImage.get(imagePath) ?? [])
      .filter((face) => !this.isFaceDeleted(face))
      .map((face) => ({
        id: face.id,
        imagePath,
        box: { ...face.box },
        cropUrl: this.cropUrl(face.cropPath),
        score: face.score,
        hasDescriptor: face.descriptor.length > 0,
        descriptorStatus: face.descriptor.length
          ? "ready" as const
          : face.descriptorStatus ?? "unavailable" as const,
        personIds: [...face.personIds],
      }));
  }

  async updateFaceBox(faceId: string, box: FaceBox, localPath?: string) {
    const face = this.faces.get(faceId);
    if (!face || this.isFaceDeleted(face)) throw new Error("Face not found.");
    const width = Math.max(0.001, Math.min(1, box.width));
    const height = Math.max(0.001, Math.min(1, box.height));
    const nextBox = {
      x: Math.max(0, Math.min(1 - width, box.x)),
      y: Math.max(0, Math.min(1 - height, box.y)),
      width,
      height,
    };
    let imageRecord: IndexableFile | null = null;
    let nextCropPath: string | null = null;
    if (localPath) {
      const sharp = require("sharp") as (input: string) => any;
      const image = sharp(localPath);
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height)
        throw new Error("Could not read image dimensions.");
      const swapsDimensions = [5, 6, 7, 8].includes(
        Number(metadata.orientation ?? 1),
      );
      const orientedWidth = swapsDimensions ? metadata.height : metadata.width;
      const orientedHeight = swapsDimensions ? metadata.width : metadata.height;
      const left = Math.max(0, Math.floor(nextBox.x * orientedWidth));
      const top = Math.max(0, Math.floor(nextBox.y * orientedHeight));
      const cropWidth = Math.min(
        orientedWidth - left,
        Math.ceil(width * orientedWidth),
      );
      const cropHeight = Math.min(
        orientedHeight - top,
        Math.ceil(height * orientedHeight),
      );
      nextCropPath = path.join(
        this.cropsDirectory,
        `${face.id}-edit-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
      );
      await image
        .rotate()
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .resize(256, 256, { fit: "cover" })
        .jpeg({ quality: 78 })
        .toFile(nextCropPath);
      const stats = await fsPromises.stat(localPath);
      imageRecord = {
        name: path.basename(face.imagePath),
        path: face.imagePath,
        relativePath: face.imagePath,
        size: stats.size,
        modified: stats.mtimeMs,
        isDirectory: false,
        type: "image",
        extension: path.extname(face.imagePath),
      };
    }
    face.box = nextBox;
    if (nextCropPath) face.cropPath = nextCropPath;
    // A descriptor belongs to one exact crop. Drop the old vector now so a
    // moved box cannot keep training recognition against the previous face.
    face.descriptor = [];
    face.descriptorStatus = imageRecord ? "pending" : "unavailable";
    this.state.faceEdits ??= {};
    this.state.faceEdits[faceId] = {
      ...this.state.faceEdits[faceId],
      box: nextBox,
      ...(nextCropPath ? { cropPath: nextCropPath } : {}),
      descriptorStatus: face.descriptorStatus,
      descriptor: [],
    };
    const linkedPeople = new Set(face.personIds);
    const affectedPeople = this.state.people.filter((person) =>
      linkedPeople.has(person.id),
    );
    for (const person of affectedPeople) {
      this.updateCentroid(person);
      if (person.status === "confirmed" && person.trainedAt) {
        person.recognitionPending = true;
        person.recognitionFailed = false;
      }
    }
    await this.persistStateDelta({
      faceIds: [faceId],
      personPatchIds: affectedPeople.map((person) => person.id),
    });
    if (localPath && imageRecord)
      this.scheduleFaceDescriptor(face, imageRecord, localPath, nextBox);
    else
      for (const person of affectedPeople)
        if (person.status === "confirmed" && person.trainedAt)
          this.schedulePersonRecognition(person);
    return this.getFacesForImage(face.imagePath);
  }

  async deleteFace(faceId: string) {
    const face = this.faces.get(faceId);
    if (!face) throw new Error("Face not found.");
    this.state.faceEdits ??= {};
    this.state.faceEdits[faceId] = {
      ...this.state.faceEdits[faceId],
      deleted: true,
      imagePath: face.imagePath,
      signature: face.signature,
      box: { ...face.box },
    };
    const linkedPeople = new Set(face.personIds);
    face.personIds = [];
    for (const person of this.state.people) {
      const ownedFace = linkedPeople.has(person.id);
      if (!ownedFace) continue;
      person.faceIds = person.faceIds.filter((id) => id !== faceId);
      if (
        !person.manualPhotoPaths.includes(face.imagePath) &&
        !person.faceIds.some(
          (id) => this.faces.get(id)?.imagePath === face.imagePath,
        )
      ) {
        person.confirmedPhotoPaths = person.confirmedPhotoPaths.filter(
          (imagePath) => imagePath !== face.imagePath,
        );
      }
      this.updateCentroid(person);
      if (person.status === "confirmed" && person.trainedAt) {
        person.recognitionPending = true;
        person.recognitionFailed = false;
      }
    }
    await this.persistStateDelta({
      faceIds: [faceId],
      personIds: Array.from(linkedPeople),
    });
    for (const personId of linkedPeople) {
      const person = this.state.people.find((item) => item.id === personId);
      if (person?.status === "confirmed" && person.trainedAt)
        this.schedulePersonRecognition(person);
    }
    return this.getFacesForImage(face.imagePath);
  }

  async createFaceBox(imagePath: string, localPath: string, box: FaceBox) {
    const sharp = require("sharp") as (input: string) => any;
    const stats = await fsPromises.stat(localPath);
    const image = sharp(localPath);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height)
      throw new Error("Could not read image dimensions.");
    const width = Math.max(0.001, Math.min(1, box.width));
    const height = Math.max(0.001, Math.min(1, box.height));
    const normalized = {
      x: Math.max(0, Math.min(1 - width, box.x)),
      y: Math.max(0, Math.min(1 - height, box.y)),
      width,
      height,
    };
    const swapsDimensions = [5, 6, 7, 8].includes(
      Number(metadata.orientation ?? 1),
    );
    const orientedWidth = swapsDimensions ? metadata.height : metadata.width;
    const orientedHeight = swapsDimensions ? metadata.width : metadata.height;
    const left = Math.max(0, Math.floor(normalized.x * orientedWidth));
    const top = Math.max(0, Math.floor(normalized.y * orientedHeight));
    const cropWidth = Math.min(
      orientedWidth - left,
      Math.ceil(width * orientedWidth),
    );
    const cropHeight = Math.min(
      orientedHeight - top,
      Math.ceil(height * orientedHeight),
    );
    if (cropWidth < 8 || cropHeight < 8)
      throw new Error("Select a larger area for the face.");
    const faceId = this.newId(`${imagePath}:manual-face`);
    const cropPath = path.join(this.cropsDirectory, `${faceId}.jpg`);
    await image
      .rotate()
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize(256, 256, { fit: "cover" })
      .jpeg({ quality: 78 })
      .toFile(cropPath);
    const imageRecord: IndexableFile = {
      name: path.basename(imagePath),
      path: imagePath,
      relativePath: imagePath,
      size: stats.size,
      modified: stats.mtimeMs,
      isDirectory: false,
      type: "image",
      extension: path.extname(imagePath),
    };
    const face: FaceRecord = {
      id: faceId,
      imagePath,
      signature: `${stats.size}:${stats.mtimeMs}`,
      box: normalized,
      score: 1,
      descriptor: [],
      descriptorStatus: "pending",
      cropPath,
      personIds: [],
      manual: true,
    };
    this.state.faceEdits ??= {};
    this.state.faceEdits[faceId] = {
      created: true,
      descriptorStatus: "pending",
    };
    const existing = this.facesByImage.get(imagePath) ?? [];
    await this.appendProcessed(imageRecord, [...existing, face], false);
    await this.persistStateDelta({ faceIds: [faceId] });
    this.scheduleFaceDescriptor(face, imageRecord, localPath, normalized);
    return this.getFacesForImage(imagePath);
  }

  private scheduleFaceDescriptor(
    face: FaceRecord,
    image: IndexableFile,
    localPath: string,
    box: FaceBox,
  ) {
    if (this.faceDescriptorJobs.has(face.id)) return;
    const snapshot = { ...box };
    const task = this.faceDescriptorChain.then(async () => {
      await this.waitForRecognitionWindow();
      const workStartedAt = Date.now();
      const current = this.faces.get(face.id);
      if (
        current !== face ||
        this.isFaceDeleted(face) ||
        current.descriptorStatus !== "pending" ||
        !this.sameFaceBox(current.box, snapshot)
      )
        return;

      let result: { descriptor: number[]; score: number } | null = null;
      try {
        result = await this.descriptorForFaceBox(localPath, snapshot);
        const currentStats = await fsPromises.stat(localPath);
        if (
          currentStats.size !== image.size ||
          currentStats.mtimeMs !== image.modified
        )
          result = null;
      } catch {
        // Keep the manual box usable even when model inference is unavailable.
        result = null;
      }

      const latest = this.faces.get(face.id);
      if (
        latest !== face ||
        this.isFaceDeleted(face) ||
        latest.descriptorStatus !== "pending" ||
        !this.sameFaceBox(latest.box, snapshot)
      )
        return;

      const hasDescriptor = Boolean(result?.descriptor.length);
      latest.descriptor = hasDescriptor ? result!.descriptor : [];
      latest.descriptorStatus = hasDescriptor ? "ready" : "unavailable";
      if (hasDescriptor) latest.score = result!.score;
      this.state.faceEdits ??= {};
      this.state.faceEdits[face.id] = {
        ...this.state.faceEdits[face.id],
        descriptorStatus: latest.descriptorStatus,
        descriptor: latest.descriptor,
      };

      const affectedPeople = this.state.people.filter((person) =>
        person.faceIds.includes(face.id),
      );
      for (const person of affectedPeople) {
        this.updateCentroid(person);
        if (person.status === "confirmed" && person.trainedAt) {
          person.recognitionPending = true;
          person.recognitionFailed = false;
        }
      }
      await this.appendProcessed(
        image,
        this.facesByImage.get(image.path) ?? [latest],
        false,
      );
      await this.persistStateDelta({
        faceIds: [face.id],
        personPatchIds: affectedPeople.map((person) => person.id),
      });
      await this.paceBackgroundWork(Date.now() - workStartedAt);
      this.peopleChangeListener();
      for (const person of affectedPeople)
        if (person.status === "confirmed" && person.trainedAt)
          this.schedulePersonRecognition(person);
    });
    this.faceDescriptorChain = task.catch(() => undefined);
    this.faceDescriptorJobs.set(face.id, task);
    void task
      .catch(() => undefined)
      .finally(() => {
        if (this.faceDescriptorJobs.get(face.id) !== task) return;
        this.faceDescriptorJobs.delete(face.id);
        const latest = this.faces.get(face.id);
        if (
          latest &&
          !this.isFaceDeleted(latest) &&
          latest.descriptorStatus === "pending" &&
          !this.sameFaceBox(latest.box, snapshot)
        )
          void this.resumePendingFaceDescriptor(latest);
      });
  }

  private sameFaceBox(first: FaceBox, second: FaceBox) {
    return (
      first.x === second.x &&
      first.y === second.y &&
      first.width === second.width &&
      first.height === second.height
    );
  }

  private async resumePendingFaceDescriptors() {
    for (const face of this.faces.values()) {
      if (
        !face.manual ||
        face.descriptorStatus !== "pending" ||
        this.faceDescriptorJobs.has(face.id)
      )
        continue;
      await this.resumePendingFaceDescriptor(face);
    }
  }

  private async resumePendingFaceDescriptor(face: FaceRecord) {
    if (
      this.faceDescriptorJobs.has(face.id) ||
      face.descriptorStatus !== "pending" ||
      this.isFaceDeleted(face)
    )
      return;
    try {
      const localPath = await this.resolveImagePath(face.imagePath);
      const stats = await fsPromises.stat(localPath);
      const image: IndexableFile = {
        name: path.basename(face.imagePath),
        path: face.imagePath,
        relativePath: face.imagePath,
        size: stats.size,
        modified: stats.mtimeMs,
        isDirectory: false,
        type: "image",
        extension: path.extname(face.imagePath),
      };
      this.scheduleFaceDescriptor(face, image, localPath, { ...face.box });
    } catch {
      // Leave pending work visible; the source may be temporarily offline.
    }
  }

  getPeopleForImages(imagePaths: string[]) {
    if (this.photoPeopleCache)
      return Object.fromEntries(
        imagePaths.map((filePath) => [
          filePath,
          this.photoPeopleCache!.get(filePath) ?? [],
        ]),
      );
    const requested = new Set(imagePaths);
    const names = new Map<string, Set<string>>();
    for (const person of this.state.people) {
      const personPaths = new Set<string>(person.manualPhotoPaths);
      for (const faceId of person.faceIds) {
        const face = this.faces.get(faceId);
        if (face) personPaths.add(face.imagePath);
      }
      for (const imagePath of personPaths) {
        if (person.rejectedPhotoPaths.includes(imagePath)) continue;
        const labels = names.get(imagePath) ?? new Set<string>();
        labels.add(person.name);
        names.set(imagePath, labels);
      }
    }
    this.photoPeopleCache = new Map(
      Array.from(names, ([filePath, values]) => [filePath, Array.from(values)]),
    );
    return Object.fromEntries(
      Array.from(requested, (imagePath) => [
        imagePath,
        Array.from(names.get(imagePath) ?? []),
      ]),
    );
  }

  private async run(indexedBatch?: IndexableFile[]) {
    try {
      const imagesOrPromise = indexedBatch ?? this.getIndexedImages();
      const images = imagesOrPromise instanceof Promise
        ? await imagesOrPromise
        : imagesOrPromise;
      const pending = images.filter(
        (image) =>
          this.processedSignatures.get(image.path) !== this.signature(image),
      );
      const processed = images.length - pending.length;
      await this.updateProgress(
        {
          total: images.length,
          processed,
          remaining: pending.length,
          errors: 0,
          faces: this.faces.size,
          people: this.getPeople().length,
          currentFile: null,
        },
        true,
      );
      if (pending.length === 0) {
        const combined = await this.combineSimilarClusters();
        const pendingPeople = this.state.people
          .filter((person) => person.recognitionPending)
          .map((person) => person.id);
        this.requestRecognitionReindex(pendingPeople, {
          refreshBanned: true,
        });
        await this.updateProgress(
          {
            status: "complete",
            people: this.getPeople().length,
            message: images.length
              ? combined > 0
                ? `Face index is up to date. Bundled ${combined} similar cluster${combined === 1 ? "" : "s"}.`
                : "Face index is up to date."
              : "Waiting for indexed photos.",
          },
          true,
        );
        return;
      }
      await this.updateProgress(
        { status: "loading-model", message: "Loading offline face models..." },
        true,
      );
      const runtime = await this.loadRuntime();
      await this.updateProgress(
        { status: "indexing", message: "Detecting and clustering faces..." },
        true,
      );

      const candidateFaceIds = new Set<string>();
      for (let index = 0; index < pending.length; index += 1) {
        const workStartedAt = Date.now();
        if (this.pauseRequested) {
          await this.persistState();
          await this.updateProgress(
            {
              status: "paused",
              currentFile: null,
              message: "Face indexing paused.",
            },
            true,
          );
          return;
        }
        const image = pending[index];
        const existingFaceIds = new Set(
          (this.facesByImage.get(image.path) ?? []).map((face) => face.id),
        );
        await this.updateProgress({ currentFile: image.name }, false);
        try {
          await this.processImage(image, runtime);
          for (const face of this.facesByImage.get(image.path) ?? [])
            if (!existingFaceIds.has(face.id)) candidateFaceIds.add(face.id);
        } catch {
          this.progress.errors += 1;
        }
        this.progress.processed += 1;
        this.progress.remaining = Math.max(0, this.progress.remaining - 1);
        this.progress.faces = this.faces.size;
        // Summarizing every person's full face/photo set for each image made
        // progress accounting grow with the entire library. Refresh this label
        // at the same 25-photo cadence used by the People UI.
        if (this.progress.processed % 25 === 0 || this.progress.remaining === 0)
          this.progress.people = this.getPeople().length;
        this.emitProgress();
        if (index % 10 === 9) await this.persistProgress();
        if ((index + 1) % FACE_STATE_CHECKPOINT_INTERVAL === 0)
          await this.persistState();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await this.paceBackgroundWork(Date.now() - workStartedAt);
      }
      await this.updateProgress(
        { message: "Bundling similar face clusters..." },
        true,
      );
      const combined = await this.combineSimilarClusters();
      await this.updateProgress(
        { message: "Finishing face indexing..." },
        false,
      );
      await this.persistState();
      if (candidateFaceIds.size > 0)
        this.requestRecognitionReindex([], {
          allConfirmed: true,
          faceIds: [...candidateFaceIds],
          refreshBanned: true,
        });
      else {
        const pendingPeople = this.state.people
          .filter((person) => person.recognitionPending)
          .map((person) => person.id);
        this.requestRecognitionReindex(pendingPeople, {
          refreshBanned: true,
        });
      }
      await this.updateProgress(
        {
          status: "complete",
          currentFile: null,
          remaining: 0,
          people: this.getPeople().length,
          message:
            combined > 0
              ? `Face index is up to date. Bundled ${combined} similar cluster${combined === 1 ? "" : "s"}.`
              : "Face index is up to date.",
        },
        true,
      );
    } catch (error) {
      await this.updateProgress(
        {
          status: "error",
          currentFile: null,
          message:
            error instanceof Error ? error.message : "Face indexing failed.",
        },
        true,
      );
    }
  }

  private async processImage(image: IndexableFile, runtime: FaceRuntime) {
    const localPath = await this.resolveImagePath(image.path);
    const decoded = await runtime
      .sharp(localPath)
      .rotate()
      .resize({
        width: 1280,
        height: 1280,
        fit: "inside",
        withoutEnlargement: true,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data, info } = decoded;
    const tensor = runtime.faceapi.tf.tensor3d(
      new Uint8Array(data),
      [info.height, info.width, info.channels],
      "int32",
    );
    let detections: any[];
    try {
      detections = await runtime.faceapi
        .detectAllFaces(
          tensor,
          new runtime.faceapi.TinyFaceDetectorOptions({
            inputSize: 416,
            scoreThreshold: 0.45,
          }),
        )
        .withFaceLandmarks()
        .withFaceDescriptors();
    } finally {
      tensor.dispose();
    }

    const records: FaceRecord[] = [];
    const createdPeople: PersonCluster[] = [];
    for (let index = 0; index < detections.length; index += 1) {
      const detection = detections[index];
      const box = detection.detection.box;
      const padding = Math.max(box.width, box.height) * 0.22;
      const left = Math.max(0, Math.floor(box.x - padding));
      const top = Math.max(0, Math.floor(box.y - padding));
      const width = Math.min(
        info.width - left,
        Math.ceil(box.width + padding * 2),
      );
      const height = Math.min(
        info.height - top,
        Math.ceil(box.height + padding * 2),
      );
      if (width < 20 || height < 20) continue;
      const faceId = this.newId(`${image.path}:${index}:${image.modified}`);
      const cropPath = path.join(this.cropsDirectory, `${faceId}.jpg`);
      await runtime
        .sharp(data, { raw: info })
        .extract({ left, top, width, height })
        .resize(256, 256, { fit: "cover" })
        .jpeg({ quality: 78 })
        .toFile(cropPath);
      const descriptor = Array.from(detection.descriptor as Float32Array);
      const normalizedBox = {
        x: box.x / info.width,
        y: box.y / info.height,
        width: box.width / info.width,
        height: box.height / info.height,
      };
      const person = this.findOrCreateCluster(
        descriptor,
        image.path,
        normalizedBox,
        createdPeople,
      );
      const record: FaceRecord = {
        id: faceId,
        imagePath: image.path,
        signature: this.signature(image),
        box: normalizedBox,
        score: detection.detection.score,
        descriptor,
        cropPath,
        personIds: [person.id],
      };
      records.push(record);
      this.indexFace(record);
      person.faceIds.push(faceId);
      this.addDescriptorToCentroid(person, descriptor);
    }
    await this.appendProcessed(image, records, true, createdPeople);
  }

  private clusterExemplars(person: PersonCluster): FaceRecord[] {
    const faceIds = person.faceIds;
    if (faceIds.length <= MAX_EXEMPLARS)
      return faceIds
        .map((faceId) => this.faces.get(faceId))
        .filter((face): face is FaceRecord =>
          Boolean(face && face.descriptor.length > 0 && !this.isFaceDeleted(face)),
        );

    const stride = faceIds.length / MAX_EXEMPLARS;
    return Array.from({ length: MAX_EXEMPLARS }, (_, index) =>
      this.faces.get(faceIds[Math.floor(index * stride)]),
    ).filter((face): face is FaceRecord =>
      Boolean(face && face.descriptor.length > 0 && !this.isFaceDeleted(face)),
    );
  }

  private findOrCreateCluster(
    descriptor: number[],
    imagePath: string,
    box: FaceRecord["box"],
    createdPeople: PersonCluster[] = [],
  ) {
    let best: PersonCluster | null = null;
    if (!USE_STRICT_X64_FACE_CLUSTERING) {
      let bestDistance = Infinity;
      for (const person of this.state.people) {
        if (!person.centroid.length || person.manual) continue;
        // Keep the original bounded centroid comparison on non-x64 builds.
        const maximumDistance = best ? bestDistance : AUTO_CLUSTER_DISTANCE;
        const maximumSquared = maximumDistance * maximumDistance;
        let sum = 0;
        let rejected = false;
        for (let index = 0; index < descriptor.length; index += 1) {
          const difference = descriptor[index] - person.centroid[index];
          sum += difference * difference;
          if (sum > maximumSquared + 1e-12) {
            rejected = true;
            break;
          }
        }
        if (!rejected) {
          const distance = Math.sqrt(sum);
          if (
            distance <= AUTO_CLUSTER_DISTANCE &&
            (!best || distance < bestDistance)
          ) {
            bestDistance = distance;
            best = person;
          }
        }
      }
      if (best && bestDistance <= AUTO_CLUSTER_DISTANCE) return best;
    } else {
      let bestWorstDistance = Infinity;
      for (const person of this.state.people) {
        if (!person.centroid.length || person.manual || person.status) continue;
        const exemplars = this.clusterExemplars(person);
        if (exemplars.length === 0) continue;

        const facesInImage = this.facesByImage.get(imagePath) ?? [];
        if (
          person.faceIds.some((faceId) => {
            const existing = facesInImage.find((face) => face.id === faceId);
            return existing && this.boxOverlap(existing.box, box) < 0.5;
          })
        )
          continue;

        let worstDistance = 0;
        let rejected = false;
        for (const exemplar of exemplars) {
          if (exemplar.descriptor.length !== descriptor.length) {
            rejected = true;
            break;
          }
          const distance = this.distance(descriptor, exemplar.descriptor);
          if (distance > AUTO_CLUSTER_DISTANCE) {
            rejected = true;
            break;
          }
          worstDistance = Math.max(worstDistance, distance);
        }
        if (!rejected && worstDistance < bestWorstDistance) {
          bestWorstDistance = worstDistance;
          best = person;
        }
      }
    }
    if (best) return best;
    const person: PersonCluster = {
      id: this.newId("person"),
      name: `Person ${this.state.people.length + 1}`,
      nameSource: "automatic",
      faceIds: [],
      manualPhotoPaths: [],
      confirmedPhotoPaths: [],
      rejectedPhotoPaths: [],
      centroid: [...descriptor],
      createdAt: Date.now(),
      manual: false,
    };
    this.state.people.push(person);
    this.centroidDescriptorCounts.set(person.id, 0);
    createdPeople.push({ ...person, centroid: [...person.centroid] });
    return person;
  }

  private async loadRuntime(): Promise<FaceRuntime> {
    if (this.runtime) return this.runtime;
    const faceapi =
      require("@vladmandic/face-api/dist/face-api.node-wasm.js") as any;
    const wasm = require("@tensorflow/tfjs-backend-wasm") as any;
    const sharp = require("sharp");
    sharp.concurrency(1);
    // Bound inference parallelism so large libraries do not spawn a host-sized
    // worker pool while search and foreground app work need CPU time.
    wasm.setThreadsCount(FACE_WASM_THREAD_LIMIT);
    wasm.setWasmPaths(`${this.wasmPath}${path.sep}`);
    await faceapi.tf.setBackend("wasm");
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromDisk(this.modelPath),
      faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelPath),
      faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelPath),
    ]);
    this.runtime = { faceapi, sharp };
    return this.runtime;
  }

  private async descriptorForFaceBox(
    localPath: string,
    box: FaceBox,
  ): Promise<{ descriptor: number[]; score: number } | null> {
    try {
      const runtime = await this.loadRuntime();
      const decoded = await runtime
        .sharp(localPath)
        .rotate()
        .resize({
          width: 1280,
          height: 1280,
          fit: "inside",
          withoutEnlargement: true,
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const padding = Math.max(
        box.width * decoded.info.width,
        box.height * decoded.info.height,
      ) * 0.22;
      const left = Math.max(
        0,
        Math.floor(box.x * decoded.info.width - padding),
      );
      const top = Math.max(
        0,
        Math.floor(box.y * decoded.info.height - padding),
      );
      const width = Math.min(
        decoded.info.width - left,
        Math.ceil(box.width * decoded.info.width + padding * 2),
      );
      const height = Math.min(
        decoded.info.height - top,
        Math.ceil(box.height * decoded.info.height + padding * 2),
      );
      const crop = await runtime
        .sharp(decoded.data, { raw: decoded.info })
        .extract({ left, top, width, height })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const tensor = runtime.faceapi.tf.tensor3d(
        new Uint8Array(crop.data),
        [crop.info.height, crop.info.width, crop.info.channels],
        "int32",
      );
      try {
        const detections = await runtime.faceapi
          .detectAllFaces(
            tensor,
            new runtime.faceapi.TinyFaceDetectorOptions({
              inputSize: 416,
              scoreThreshold: 0.2,
            }),
          )
          .withFaceLandmarks()
          .withFaceDescriptors();
        const selected = detections.sort(
          (first: any, second: any) =>
            second.detection.box.width * second.detection.box.height -
            first.detection.box.width * first.detection.box.height,
        )[0];
        return selected
          ? {
              descriptor: Array.from(selected.descriptor as Float32Array),
              score: selected.detection.score,
            }
          : { descriptor: [], score: 0 };
      } finally {
        tensor.dispose();
      }
    } catch {
      // A saved box remains useful even when the local model cannot produce a
      // recognition vector; it simply won't train recognition until corrected.
      return null;
    }
  }

  private async appendProcessed(
    image: IndexableFile,
    records: FaceRecord[],
    markProcessed = true,
    createdPeople: PersonCluster[] = [],
  ) {
    const manualFaces = (this.facesByImage.get(image.path) ?? []).filter(
      (face) => face.manual && !records.some((record) => record.id === face.id),
    );
    const updatedRecords = [...records, ...manualFaces];
    const entry: FaceJournalEntry = {
      imagePath: image.path,
      signature: markProcessed
        ? this.signature(image)
        : `manual:${this.signature(image)}`,
      faces: updatedRecords,
      ...(createdPeople.length > 0 ? { createdPeople } : {}),
    };
    this.replaceImageFaces(image.path, updatedRecords);
    const write = this.recordWriteChain.then(async () => {
      await fsPromises.appendFile(this.recordsPath, `${JSON.stringify(entry)}\n`);
      this.faceRecordVersion += 1;
    });
    this.recordWriteChain = write.catch(() => undefined);
    await write;
    this.processedSignatures.set(image.path, entry.signature);
  }

  private async loadRecords(savedVersion: number | null) {
    try {
      await fsPromises.access(this.recordsPath);
    } catch {
      await fsPromises.writeFile(this.recordsPath, "");
      return;
    }
    // Streamed so the main process keeps servicing the UI while the face cache loads.
    const lines = readline.createInterface({
      input: fs.createReadStream(this.recordsPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as FaceJournalEntry;
        this.faceRecordVersion += 1;
        this.processedSignatures.set(entry.imagePath, entry.signature);
        this.replaceImageFaces(entry.imagePath, entry.faces, false);
        if (
          savedVersion !== null &&
          this.faceRecordVersion > savedVersion
        )
          this.recoveryJournal.push(entry);
      } catch {
        lines.close();
        break;
      }
    }
  }

  private reconcilePeople() {
    const peopleById = new Map(
      this.state.people.map((person) => [person.id, person]),
    );
    const replayedFaceIds = new Set<string>();
    const recoveredPeople = new Set<string>();

    for (const entry of this.recoveryJournal) {
      for (const seed of entry.createdPeople ?? []) {
        if (!seed?.id || peopleById.has(seed.id)) continue;
        const person: PersonCluster = {
          ...seed,
          faceIds: [],
          manualPhotoPaths: [...(seed.manualPhotoPaths ?? [])],
          confirmedPhotoPaths: [...(seed.confirmedPhotoPaths ?? [])],
          rejectedPhotoPaths: [...(seed.rejectedPhotoPaths ?? [])],
          centroid: [...(seed.centroid ?? [])],
        };
        this.state.people.push(person);
        peopleById.set(person.id, person);
        recoveredPeople.add(person.id);
      }
      for (const face of entry.faces ?? []) replayedFaceIds.add(face.id);
    }

    for (const person of this.state.people) {
      person.faceIds = Array.from(
        new Set(
          person.faceIds.filter(
            (id) => this.faces.has(id) && !replayedFaceIds.has(id),
          ),
        ),
      );
    }

    for (const faceId of replayedFaceIds) {
      const face = this.faces.get(faceId);
      if (!face) continue;
      for (const personId of face.personIds) {
        let person = peopleById.get(personId);
        if (!person) {
          person = {
            id: personId,
            name: `Person ${this.state.people.length + 1}`,
            nameSource: "automatic",
            faceIds: [],
            manualPhotoPaths: [],
            confirmedPhotoPaths: [],
            rejectedPhotoPaths: [],
            centroid: [],
            createdAt: Date.now(),
            manual: false,
          };
          this.state.people.push(person);
          peopleById.set(person.id, person);
          recoveredPeople.add(person.id);
        }
        if (!person.faceIds.includes(faceId)) person.faceIds.push(faceId);
      }
    }

    this.state.people = this.state.people.filter((person) => {
      const keep =
        !recoveredPeople.has(person.id) ||
        person.faceIds.length > 0 ||
        person.manualPhotoPaths.length > 0 ||
        person.confirmedPhotoPaths.length > 0 ||
        person.rejectedPhotoPaths.length > 0 ||
        Boolean(person.status);
      if (!keep) this.centroidDescriptorCounts.delete(person.id);
      return keep;
    });

    // The people checkpoint is authoritative for face ownership. Journal rows
    // may predate a later manual reassignment, so reconcile the in-memory links
    // after replay to prevent stale matches after restart.
    for (const face of this.faces.values()) {
      face.personIds = this.state.people
        .filter((person) => person.faceIds.includes(face.id))
        .map((person) => person.id);
    }
    for (const person of this.state.people) {
      this.updateCentroid(person);
    }
    this.recoveryJournal = [];
  }

  private splitInconsistentAutomaticClusters(): number {
    let splitCount = 0;
    let nextPersonNumber = this.state.people.reduce((maximum, person) => {
      const match = /^Person (\d+)$/.exec(person.name);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0) + 1;
    const candidates = [...this.state.people];

    const sampleSlot = (id: string, count: number) => {
      let hash = 2166136261;
      for (let index = 0; index < id.length; index += 1)
        hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
      return (hash >>> 0) % count;
    };

    for (const person of candidates) {
      if (
        person.manual ||
        person.status ||
        person.trainedAt ||
        person.nameSource !== "automatic" ||
        person.manualPhotoPaths.length > 0 ||
        person.confirmedPhotoPaths.length > 0 ||
        person.rejectedPhotoPaths.length > 0
      )
        continue;

      const clusterFaces = person.faceIds.map((faceId) =>
        this.faces.get(faceId),
      );
      // Leave an entire group untouched if any face has been edited, deleted,
      // manually added, or is unavailable. Rebuilding faceIds from a filtered
      // list would otherwise silently discard user data.
      if (
        clusterFaces.some(
          (face) =>
            !face ||
            face.manual ||
            Boolean(this.state.faceEdits?.[face.id]) ||
            !face.descriptor.length ||
            this.isFaceDeleted(face),
        )
      )
        continue;
      const faces = clusterFaces as FaceRecord[];
      if (faces.length < 2) continue;
      faces
        .sort((first, second) =>
          second.score - first.score || first.id.localeCompare(second.id),
        );

      const partitions: Array<{
        faces: FaceRecord[];
        exemplars: FaceRecord[];
        byImage: Map<string, FaceRecord[]>;
      }> = [];
      for (const face of faces) {
        let bestPartition: (typeof partitions)[number] | null = null;
        let bestWorstDistance = Infinity;
        for (const partition of partitions) {
          const sameImageFaces = partition.byImage.get(face.imagePath) ?? [];
          if (
            sameImageFaces.some(
              (other) => this.boxOverlap(other.box, face.box) < 0.5,
            )
          )
            continue;

          let worstDistance = 0;
          let rejected = false;
          for (const exemplar of partition.exemplars) {
            if (exemplar.descriptor.length !== face.descriptor.length) {
              rejected = true;
              break;
            }
            const distance = this.distance(
              face.descriptor,
              exemplar.descriptor,
            );
            if (distance > AUTO_CLUSTER_DISTANCE) {
              rejected = true;
              break;
            }
            worstDistance = Math.max(worstDistance, distance);
          }
          if (!rejected && worstDistance < bestWorstDistance) {
            bestWorstDistance = worstDistance;
            bestPartition = partition;
          }
        }

        if (!bestPartition) {
          bestPartition = { faces: [], exemplars: [], byImage: new Map() };
          partitions.push(bestPartition);
        }
        const priorCount = bestPartition.faces.length;
        bestPartition.faces.push(face);
        if (bestPartition.exemplars.length < MAX_EXEMPLARS) {
          bestPartition.exemplars.push(face);
        } else {
          const slot = sampleSlot(face.id, priorCount + 1);
          if (slot < MAX_EXEMPLARS)
            bestPartition.exemplars[slot] = face;
        }
        const sameImage = bestPartition.byImage.get(face.imagePath) ?? [];
        sameImage.push(face);
        bestPartition.byImage.set(face.imagePath, sameImage);
      }
      if (partitions.length < 2) continue;

      let primaryIndex = person.selectedCoverPhotoPath
        ? partitions.findIndex((partition) =>
            partition.faces.some(
              (face) => face.imagePath === person.selectedCoverPhotoPath,
            ),
          )
        : -1;
      if (primaryIndex < 0) {
        primaryIndex = partitions.reduce(
          (bestIndex, partition, index) =>
            partition.faces.length > partitions[bestIndex].faces.length
              ? index
              : bestIndex,
          0,
        );
      }
      const orderedPartitions = [
        partitions[primaryIndex],
        ...partitions.filter((_, index) => index !== primaryIndex),
      ];
      const assignedPeople: PersonCluster[] = [person];
      person.faceIds = orderedPartitions[0].faces.map((face) => face.id);
      person.suggestedFaceIds = undefined;
      this.updateCentroid(person);

      for (const partition of orderedPartitions.slice(1)) {
        const created: PersonCluster = {
          ...person,
          id: this.newId("person"),
          name: `Person ${nextPersonNumber++}`,
          nameSource: "automatic",
          faceIds: partition.faces.map((face) => face.id),
          manualPhotoPaths: [],
          confirmedPhotoPaths: [],
          rejectedPhotoPaths: [],
          centroid: [],
          createdAt: Date.now(),
          manual: false,
          selectedCoverPhotoPath: null,
          suggestedFaceIds: undefined,
        };
        this.state.people.push(created);
        this.updateCentroid(created);
        assignedPeople.push(created);
      }

      orderedPartitions.forEach((partition, index) => {
        const targetId = assignedPeople[index].id;
        for (const face of partition.faces)
          face.personIds = Array.from(
            new Set([
              ...face.personIds.filter((personId) => personId !== person.id),
              targetId,
            ]),
          );
      });
      splitCount += partitions.length - 1;
    }
    return splitCount;
  }

  private async combineSimilarClusters(): Promise<number> {
    let combined = USE_STRICT_X64_FACE_CLUSTERING
      ? this.splitInconsistentAutomaticClusters()
      : 0;
    let mergedThisRound = true;

    while (mergedThisRound) {
      mergedThisRound = false;
      const candidates = this.state.people.filter(
        (person) =>
          !person.manual &&
          !person.status &&
          person.nameSource === "automatic" &&
          person.faceIds.length > 0 &&
          person.centroid.length > 0,
      );
      const nearest = new Map<
        string,
        { person: PersonCluster; distance: number }
      >();
      const updateNearest = (
        currentId: string,
        nextPerson: PersonCluster,
        distance: number,
      ) => {
        const current = nearest.get(currentId);
        if (
          !current ||
          distance < current.distance ||
          (distance === current.distance &&
            nextPerson.id.localeCompare(current.person.id) < 0)
        ) {
          nearest.set(currentId, { person: nextPerson, distance });
        }
      };

      for (
        let firstIndex = 0;
        firstIndex < candidates.length;
        firstIndex += 1
      ) {
        const first = candidates[firstIndex];
        const firstCentroid = this.normalized(first.centroid);
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < candidates.length;
          secondIndex += 1
        ) {
          const second = candidates[secondIndex];
          if (!this.canCombineClusters(first, second)) continue;
          const distance = this.distance(
            firstCentroid,
            this.normalized(second.centroid),
          );
          if (distance > COMBINE_CLUSTER_DISTANCE) continue;
          updateNearest(first.id, second, distance);
          updateNearest(second.id, first, distance);
        }
      }

      const consumed = new Set<string>();
      for (const first of candidates) {
        if (consumed.has(first.id)) continue;
        const match = nearest.get(first.id);
        if (!match || consumed.has(match.person.id)) continue;
        if (nearest.get(match.person.id)?.person.id !== first.id) continue;
        const survivor =
          first.faceIds.length >= match.person.faceIds.length
            ? first
            : match.person;
        const absorbed = survivor.id === first.id ? match.person : first;
        this.mergeAutomaticClusters(survivor, absorbed);
        consumed.add(survivor.id);
        consumed.add(absorbed.id);
        combined += 1;
        mergedThisRound = true;
      }
    }

    if (combined > 0) await this.persistState();
    return combined;
  }

  private canCombineClusters(
    first: PersonCluster,
    second: PersonCluster,
  ): boolean {
    if (USE_STRICT_X64_FACE_CLUSTERING) {
      const firstExemplars = this.clusterExemplars(first);
      const secondExemplars = this.clusterExemplars(second);
      if (firstExemplars.length === 0 || secondExemplars.length === 0)
        return false;
      for (const firstFace of firstExemplars)
        for (const secondFace of secondExemplars)
          if (
            firstFace.descriptor.length !== secondFace.descriptor.length ||
            this.distance(firstFace.descriptor, secondFace.descriptor) >
              AUTO_CLUSTER_DISTANCE
          )
            return false;
    }

    const firstByImage = new Map<string, FaceRecord[]>();
    for (const faceId of first.faceIds) {
      const face = this.faces.get(faceId);
      if (!face) continue;
      const matches = firstByImage.get(face.imagePath) ?? [];
      matches.push(face);
      firstByImage.set(face.imagePath, matches);
    }
    for (const faceId of second.faceIds) {
      const face = this.faces.get(faceId);
      if (!face) continue;
      const sameImageFaces = firstByImage.get(face.imagePath);
      if (!sameImageFaces) continue;
      if (
        !sameImageFaces.some(
          (other) => this.boxOverlap(other.box, face.box) >= 0.5,
        )
      )
        return false;
    }
    return true;
  }

  private mergeAutomaticClusters(
    survivor: PersonCluster,
    absorbed: PersonCluster,
  ) {
    survivor.faceIds = Array.from(
      new Set([...survivor.faceIds, ...absorbed.faceIds]),
    );
    survivor.manualPhotoPaths = Array.from(
      new Set([...survivor.manualPhotoPaths, ...absorbed.manualPhotoPaths]),
    );
    survivor.confirmedPhotoPaths = Array.from(
      new Set([
        ...survivor.confirmedPhotoPaths,
        ...absorbed.confirmedPhotoPaths,
      ]),
    );
    survivor.rejectedPhotoPaths = Array.from(
      new Set([...survivor.rejectedPhotoPaths, ...absorbed.rejectedPhotoPaths]),
    );
    for (const faceId of absorbed.faceIds) {
      const face = this.faces.get(faceId);
      if (!face) continue;
      face.personIds = Array.from(
        new Set([
          ...face.personIds.filter((personId) => personId !== absorbed.id),
          survivor.id,
        ]),
      );
    }
    this.state.people = this.state.people.filter(
      (person) => person.id !== absorbed.id,
    );
    this.centroidDescriptorCounts.delete(absorbed.id);
    this.updateCentroid(survivor);
  }

  private normalized(values: number[]): number[] {
    const length =
      Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
    return values.map((value) => value / length);
  }

  private boxOverlap(
    first: FaceRecord["box"],
    second: FaceRecord["box"],
  ): number {
    const left = Math.max(first.x, second.x);
    const top = Math.max(first.y, second.y);
    const right = Math.min(first.x + first.width, second.x + second.width);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const union =
      first.width * first.height + second.width * second.height - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /** Treat modest detector jitter around one face as the same region. */
  private boxesRepresentSameFace(
    first: FaceRecord["box"],
    second: FaceRecord["box"],
    minimumCoverage = 0.55,
    centerScale = 0.45,
  ) {
    const left = Math.max(first.x, second.x);
    const top = Math.max(first.y, second.y);
    const right = Math.min(first.x + first.width, second.x + second.width);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const smallerArea = Math.min(
      first.width * first.height,
      second.width * second.height,
    );
    if (smallerArea <= 0 || intersection / smallerArea < minimumCoverage)
      return false;

    const centerDistance = Math.hypot(
      first.x + first.width / 2 - (second.x + second.width / 2),
      first.y + first.height / 2 - (second.y + second.height / 2),
    );
    return centerDistance <= Math.sqrt(smallerArea) * centerScale;
  }

  private summarizePerson(person: PersonCluster): PersonSummary {
    const faces = person.faceIds
      .map((id) => this.faces.get(id))
      .filter((face): face is FaceRecord => Boolean(face));
    const photos = this.photoPathsOf(person);
    const confirmed = new Set(person.confirmedPhotoPaths);
    const ownerBanned = person.status === "banned";
    const reviewable = photos.filter(
      (photoPath) => !this.hiddenPhoto(photoPath, ownerBanned),
    );
    const confirmedCount = reviewable.filter((photoPath) =>
      confirmed.has(photoPath),
    ).length;
    const selectedCoverPhotoPath =
      person.selectedCoverPhotoPath &&
      reviewable.includes(person.selectedCoverPhotoPath)
        ? person.selectedCoverPhotoPath
        : null;
    const coverFace = faces
      .filter(
        (face) =>
          !person.rejectedPhotoPaths.includes(face.imagePath) &&
          !this.hiddenPhoto(face.imagePath, ownerBanned),
      )
      .sort(
        (first, second) =>
          Number(second.imagePath === selectedCoverPhotoPath) -
            Number(first.imagePath === selectedCoverPhotoPath) ||
          second.score - first.score ||
          second.box.width * second.box.height -
            first.box.width * first.box.height,
      )[0];
    return {
      id: person.id,
      name: person.name,
      nameSource:
        person.nameSource ??
        (/^Person \d+$/.test(person.name) ? "automatic" : "user"),
      faceCount: faces.length,
      photoCount: photos.length,
      coverCropUrl:
        selectedCoverPhotoPath &&
        coverFace?.imagePath !== selectedCoverPhotoPath
          ? `app-media://stream/${encodeURIComponent(selectedCoverPhotoPath)}`
          : coverFace
            ? this.cropUrl(coverFace.cropPath)
            : null,
      selectedCoverPhotoPath,
      manual: person.manual,
      confirmedCount,
      reviewableCount: reviewable.length,
      hiddenCount: photos.length - reviewable.length,
      fullyConfirmed:
        reviewable.length > 0 && confirmedCount === reviewable.length,
      status: person.status ?? "unconfirmed",
      suggestedCount: this.suggestedFacesOf(person).length,
      trainedAt: person.trainedAt ?? null,
      recognitionPending: Boolean(person.recognitionPending),
      recognitionFailed: Boolean(person.recognitionFailed),
    };
  }

  private photoPathsOf(person: PersonCluster) {
    const rejected = new Set(person.rejectedPhotoPaths);
    const photos = new Set<string>(person.manualPhotoPaths);
    for (const faceId of person.faceIds) {
      const face = this.faces.get(faceId);
      if (face) photos.add(face.imagePath);
    }
    return Array.from(photos).filter(
      (photoPath) =>
        !rejected.has(photoPath) && !this.missingPhotos.has(photoPath),
    );
  }

  private suggestedFacesOf(person: PersonCluster) {
    const owned = new Set(this.photoPathsOf(person));
    const rejected = new Set(person.rejectedPhotoPaths);
    return (person.suggestedFaceIds ?? [])
      .map((faceId) => this.faces.get(faceId))
      .filter(
        (face): face is FaceRecord =>
          Boolean(face) &&
          !this.isFaceDeleted(face!) &&
          !owned.has(face!.imagePath) &&
          !rejected.has(face!.imagePath),
      );
  }

  private requireFullyConfirmed(personId: string) {
    const person = this.requirePerson(personId);
    const summary = this.summarizePerson(person);
    if (!summary.fullyConfirmed)
      throw new Error(
        `Confirm all ${summary.reviewableCount.toLocaleString()} photos of ${person.name} first (${summary.confirmedCount.toLocaleString()} confirmed).`,
      );
    return person;
  }

  private indexFace(face: FaceRecord) {
    face.cropPath = this.rebaseCropPath(face.cropPath);
    if (!this.baseFaceBoxes.has(face.id)) {
      this.baseFaceBoxes.set(face.id, { ...face.box });
      this.baseFaceCrops.set(face.id, face.cropPath);
    }
    const edit = this.state.faceEdits?.[face.id];
    if (edit?.box) face.box = { ...edit.box };
    if (edit?.cropPath) face.cropPath = this.rebaseCropPath(edit.cropPath);
    if (edit?.descriptor) face.descriptor = [...edit.descriptor];
    if (edit?.descriptorStatus) face.descriptorStatus = edit.descriptorStatus;
    if (Number.isFinite(edit?.score)) face.score = edit!.score!;
    this.faces.set(face.id, face);
    const list = this.facesByImage.get(face.imagePath) ?? [];
    list.push(face);
    this.facesByImage.set(face.imagePath, list);
  }

  /** State-journal edits load after the face-record journal, so reapply their face overrides. */
  private applyPersistedFaceEdits() {
    for (const face of this.faces.values()) {
      const edit = this.state.faceEdits?.[face.id];
      if (!edit) continue;
      if (edit.box) face.box = { ...edit.box };
      if (edit.cropPath) face.cropPath = this.rebaseCropPath(edit.cropPath);
      if (edit.descriptor) face.descriptor = [...edit.descriptor];
      if (edit.descriptorStatus) face.descriptorStatus = edit.descriptorStatus;
      if (Number.isFinite(edit.score)) face.score = edit.score!;
    }
  }

  private replaceImageFaces(
    imagePath: string,
    records: FaceRecord[],
    updatePeople = true,
  ) {
    const existingFaces = this.facesByImage.get(imagePath) ?? [];
    const manualRegions = [...existingFaces, ...records]
      .filter((face) => face.manual && !this.isFaceDeleted(face))
      .map((face) => face.box);
    const indexedSignature =
      records.find((face) => !face.manual)?.signature ?? records[0]?.signature;
    const dismissedRegions = Object.values(this.state.faceEdits ?? {})
      .filter(
        (edit) =>
          edit.deleted &&
          edit.imagePath === imagePath &&
          (!edit.signature ||
            !indexedSignature ||
            edit.signature === indexedSignature) &&
          edit.box,
      )
      .map((edit) => edit.box!);
    const retainedRecords: FaceRecord[] = [];
    for (const face of records) {
      if (this.isFaceDeleted(face)) continue;
      if (face.manual) {
        retainedRecords.push(face);
        continue;
      }
      if (
        dismissedRegions.some((box) =>
          this.boxesRepresentSameFace(box, face.box, 0.5, 0.65),
        ) ||
        manualRegions.some((box) =>
          this.boxesRepresentSameFace(box, face.box, 0.5, 0.65),
        )
      )
        continue;

      const duplicateIndex = retainedRecords.findIndex(
        (other) =>
          !other.manual &&
          this.boxesRepresentSameFace(other.box, face.box, 0.68, 0.4),
      );
      if (duplicateIndex < 0) retainedRecords.push(face);
      else if (face.score > retainedRecords[duplicateIndex].score)
        retainedRecords[duplicateIndex] = face;
    }

    const nextIds = new Set(retainedRecords.map((face) => face.id));
    for (const oldFace of existingFaces) {
      if (nextIds.has(oldFace.id)) continue;
      this.faces.delete(oldFace.id);
      this.baseFaceBoxes.delete(oldFace.id);
      this.baseFaceCrops.delete(oldFace.id);
      if (updatePeople) {
        for (const person of this.state.people) {
          const ownedFace = person.faceIds.includes(oldFace.id);
          person.faceIds = person.faceIds.filter((id) => id !== oldFace.id);
          person.suggestedFaceIds = (person.suggestedFaceIds ?? []).filter(
            (id) => id !== oldFace.id,
          );
          if (
            ownedFace &&
            !person.manualPhotoPaths.includes(imagePath) &&
            !person.faceIds.some(
              (id) => this.faces.get(id)?.imagePath === imagePath,
            )
          ) {
            person.confirmedPhotoPaths = person.confirmedPhotoPaths.filter(
              (photoPath) => photoPath !== imagePath,
            );
          }
          this.updateCentroid(person);
        }
      }
    }
    this.facesByImage.set(imagePath, []);
    for (const face of retainedRecords) this.indexFace(face);
  }

  private isFaceDeleted(face: FaceRecord) {
    const edit = this.state.faceEdits?.[face.id];
    return Boolean(edit?.deleted || (face.manual && !edit?.created));
  }

  /** Descriptors of faces the user has verified as this person, sampled to keep matching fast. */
  private exemplarsOf(person: PersonCluster): number[][] {
    const confirmed = new Set(person.confirmedPhotoPaths);
    const rejected = new Set(person.rejectedPhotoPaths);
    const faces: FaceRecord[] = [];
    const covered = new Set<string>();
    for (const faceId of person.faceIds) {
      const face = this.faces.get(faceId);
      if (
        !face ||
        this.isFaceDeleted(face) ||
        !confirmed.has(face.imagePath) ||
        rejected.has(face.imagePath)
      )
        continue;
      faces.push(face);
      covered.add(face.imagePath);
    }
    // Manually added photos have no assigned face; use it only when the photo has exactly one face.
    for (const imagePath of person.manualPhotoPaths) {
      if (covered.has(imagePath) || !confirmed.has(imagePath)) continue;
      const imageFaces = this.facesByImage.get(imagePath) ?? [];
      const activeFaces = imageFaces.filter(
        (face) => !this.isFaceDeleted(face),
      );
      if (activeFaces.length === 1 && activeFaces[0].descriptor.length > 0)
        faces.push(activeFaces[0]);
    }
    faces.sort((first, second) => second.score - first.score);
    if (faces.length <= MAX_EXEMPLARS)
      return faces.map((face) => face.descriptor);
    const stride = faces.length / MAX_EXEMPLARS;
    return Array.from(
      { length: MAX_EXEMPLARS },
      (_, index) => faces[Math.floor(index * stride)].descriptor,
    );
  }

  /** Best face per image within `maxDistance` of any exemplar; yields periodically to keep the main process responsive. */
  private async matchFaces(
    exemplars: number[][],
    maxDistance: number,
    skip: (face: FaceRecord) => boolean,
    candidateFaceIds?: ReadonlySet<string>,
  ) {
    const best = new Map<string, { face: FaceRecord; distance: number }>();
    if (exemplars.length === 0) return best;
    await this.waitForRecognitionWindow();
    let checked = 0;
    let chunkStartedAt = Date.now();
    const candidates = candidateFaceIds
      ? Array.from(candidateFaceIds, (faceId) => this.faces.get(faceId)).filter(
          (face): face is FaceRecord => Boolean(face),
        )
      : this.faces.values();
    for (const face of candidates) {
      checked += 1;
      if (checked % 128 === 0) {
        const workMs = Date.now() - chunkStartedAt;
        await this.waitForRecognitionWindow();
        await this.paceRecognitionWork(workMs);
        await this.waitForRecognitionWindow();
        chunkStartedAt = Date.now();
      }
      if (
        skip(face) ||
        this.isFaceDeleted(face) ||
        face.descriptor.length === 0
      )
        continue;
      let nearest = Infinity;
      for (const exemplar of exemplars) {
        const distance = this.distance(face.descriptor, exemplar);
        if (distance < nearest) nearest = distance;
        if (nearest <= maxDistance * 0.6) break;
      }
      if (nearest > maxDistance) continue;
      const current = best.get(face.imagePath);
      if (!current || nearest < current.distance)
        best.set(face.imagePath, { face, distance: nearest });
    }
    return best;
  }

  private async refreshSuggestions(
    person: PersonCluster,
    candidateFaceIds?: ReadonlySet<string>,
  ) {
    const owned = new Set(this.photoPathsOf(person));
    const rejected = new Set(person.rejectedPhotoPaths);
    const otherKnown = new Set(
      this.state.people
        .filter((item) => item.id !== person.id && item.status)
        .map((item) => item.id),
    );
    const matches = await this.matchFaces(
      this.exemplarsOf(person),
      TRAINED_MATCH_DISTANCE,
      (face) =>
        owned.has(face.imagePath) ||
        rejected.has(face.imagePath) ||
        face.personIds.some((personId) => otherKnown.has(personId)),
      candidateFaceIds,
    );
    const matchedFaceIds = Array.from(matches.values())
      .sort((first, second) => first.distance - second.distance)
      .map(({ face }) => face.id);
    if (!candidateFaceIds) {
      person.suggestedFaceIds = matchedFaceIds;
      return;
    }
    const existingSuggestions = (person.suggestedFaceIds ?? []).filter((faceId) => {
      if (candidateFaceIds.has(faceId)) return false;
      const face = this.faces.get(faceId);
      return Boolean(
        face &&
          !this.isFaceDeleted(face) &&
          face.descriptor.length > 0 &&
          !owned.has(face.imagePath) &&
          !rejected.has(face.imagePath) &&
          !face.personIds.some((personId) => otherKnown.has(personId)),
      );
    });
    person.suggestedFaceIds = Array.from(
      new Set([...existingSuggestions, ...matchedFaceIds]),
    );
  }

  private async refreshBannedPhotos() {
    const next = new Set<string>();
    for (const person of this.state.people) {
      const banned = this.state.bannedFaces?.[person.id];
      if (person.status !== "banned" || !banned) continue;
      const photos = this.photoPathsOf(person);
      photos.forEach((photoPath) => next.add(photoPath));
      const rejected = new Set(person.rejectedPhotoPaths);
      // Confidence 0-100 maps to a match distance of 0.60 (loose) to 0.35 (strict).
      const maxDistance = 0.6 - (banned.confidence / 100) * 0.25;
      const matches = await this.matchFaces(
        this.exemplarsOf(person),
        maxDistance,
        (face) => next.has(face.imagePath) || rejected.has(face.imagePath),
      );
      matches.forEach((_match, imagePath) => next.add(imagePath));
    }
    const added = Array.from(next).filter(
      (photoPath) => !this.bannedPhotoPaths.has(photoPath),
    );
    const removed = Array.from(this.bannedPhotoPaths).filter(
      (photoPath) => !next.has(photoPath),
    );
    this.bannedPhotoPaths = next;
    this.state.bannedPhotoPaths = Array.from(next);
    if (added.length > 0 || removed.length > 0)
      this.recognitionListener({ added, removed });
  }

  /** Queue matching as background work so scans and UI actions never wait on it. */
  private refreshRecognition() {
    this.requestRecognitionReindex([], {
      allConfirmed: true,
      refreshBanned:
        this.bannedPhotoPaths.size > 0 ||
        this.state.people.some((person) => person.status === "banned"),
    });
    return Promise.resolve();
  }

  private requestRecognitionReindex(
    personIds: readonly string[],
    options: {
      allConfirmed?: boolean;
      refreshBanned?: boolean;
      faceIds?: readonly string[];
    } = {},
  ) {
    const queuedPeople = new Set(personIds);
    if (options.allConfirmed)
      for (const person of this.state.people)
        if (person.status === "confirmed" && person.trainedAt)
          queuedPeople.add(person.id);
    for (const personId of queuedPeople) {
      const existing = this.pendingRecognitionJobs.get(personId);
      if (existing === null) continue;
      if (options.faceIds === undefined) {
        this.pendingRecognitionJobs.set(personId, null);
      } else {
        const candidates = existing ?? new Set<string>();
        for (const faceId of options.faceIds) candidates.add(faceId);
        this.pendingRecognitionJobs.set(personId, candidates);
      }
    }
    if (
      options.refreshBanned &&
      (this.bannedPhotoPaths.size > 0 ||
        Object.keys(this.state.bannedFaces ?? {}).length > 0)
    )
      this.refreshBannedFacesPending = true;
    if (this.pendingRecognitionJobs.size === 0 && !this.refreshBannedFacesPending)
      return;
    if (this.recognitionProducerTimer || this.recognitionProducerRunning) return;
    this.recognitionProducerTimer = setTimeout(() => {
      this.recognitionProducerTimer = null;
      void this.runRecognitionProducer();
    }, 250);
    this.recognitionProducerTimer.unref?.();
  }

  private async waitForRecognitionWindow() {
    while (
      this.hasActiveInteractiveSearch() ||
      this.pauseRequested ||
      this.runPromise !== null ||
      this.progress.status === "loading-model" ||
      this.progress.status === "indexing"
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async paceRecognitionWork(workMs: number) {
    let cooldownRemaining = Math.ceil(
      Math.max(1, workMs) *
        ((100 - this.backgroundWorkPercent) / this.backgroundWorkPercent),
    );
    while (cooldownRemaining > 0) {
      await this.waitForRecognitionWindow();
      const sliceMs = Math.min(50, cooldownRemaining);
      const startedAt = Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, sliceMs));
      cooldownRemaining -= Math.max(1, Date.now() - startedAt);
    }
  }

  private async runRecognitionProducer() {
    if (this.recognitionProducerRunning) return;
    this.recognitionProducerRunning = true;
    try {
      while (this.pendingRecognitionJobs.size > 0 || this.refreshBannedFacesPending) {
        await this.waitForRecognitionWindow();
        const queued = this.pendingRecognitionJobs.entries().next().value as
          | [string, Set<string> | null]
          | undefined;
        const personId = queued?.[0];
        if (personId) {
          const candidateFaceIds = queued![1];
          this.pendingRecognitionJobs.delete(personId);
          const person = this.state.people.find((item) => item.id === personId);
          if (!person || person.status !== "confirmed" || !person.trainedAt)
            continue;
          const wasPending = Boolean(person.recognitionPending);
          const previousSuggestions = (person.suggestedFaceIds ?? []).join("\u0000");
          try {
            await this.refreshSuggestions(person, candidateFaceIds ?? undefined);
            if (wasPending) person.recognitionFailed = false;
          } catch {
            if (wasPending) person.recognitionFailed = true;
          }
          if (this.state.people.find((item) => item.id === personId) !== person)
            continue;
          if (wasPending) person.recognitionPending = false;
          try {
            await this.persistStateDelta({ personPatchIds: [personId] });
          } catch {
            if (wasPending) {
              person.recognitionPending = true;
              person.recognitionFailed = true;
            }
          }
          const suggestionsChanged =
            previousSuggestions !== (person.suggestedFaceIds ?? []).join("\u0000");
          if (wasPending || suggestionsChanged) {
            this.peopleChangeListener();
            this.recognitionProgressListener([personId]);
          }
        } else if (this.refreshBannedFacesPending) {
          this.refreshBannedFacesPending = false;
          await this.refreshBannedPhotos();
          await this.persistState();
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.recognitionProducerRunning = false;
      if (this.pendingRecognitionJobs.size > 0 || this.refreshBannedFacesPending)
        this.requestRecognitionReindex([]);
    }
  }

  private schedulePersonRecognition(person: PersonCluster) {
    if (person.status !== "confirmed" || !person.trainedAt) return;
    this.requestRecognitionReindex([person.id]);
  }

  private updateCentroid(person: PersonCluster) {
    const rejected = new Set(person.rejectedPhotoPaths);
    const descriptors = person.faceIds
      .map((id) => this.faces.get(id))
      .filter(
        (face): face is FaceRecord =>
          Boolean(
            face &&
              !this.isFaceDeleted(face) &&
              !rejected.has(face.imagePath) &&
              face.descriptor.length,
          ),
      )
      .map((face) => face.descriptor);
    if (!descriptors.length) {
      if (!person.manual) person.centroid = [];
      this.centroidDescriptorCounts.set(person.id, 0);
      return;
    }
    person.centroid = new Array(descriptors[0].length).fill(0);
    for (const descriptor of descriptors) {
      for (let index = 0; index < descriptor.length; index += 1)
        person.centroid[index] += descriptor[index];
    }
    for (let index = 0; index < person.centroid.length; index += 1)
      person.centroid[index] /= descriptors.length;
    this.centroidDescriptorCounts.set(person.id, descriptors.length);
  }

  private addDescriptorToCentroid(person: PersonCluster, descriptor: number[]) {
    const count = this.centroidDescriptorCounts.get(person.id) ?? 0;
    if (count === 0 || person.centroid.length !== descriptor.length) {
      person.centroid = [...descriptor];
      this.centroidDescriptorCounts.set(person.id, 1);
      return;
    }
    const nextCount = count + 1;
    for (let index = 0; index < descriptor.length; index += 1) {
      person.centroid[index] +=
        (descriptor[index] - person.centroid[index]) / nextCount;
    }
    this.centroidDescriptorCounts.set(person.id, nextCount);
  }

  private distance(first: number[], second: number[]) {
    let sum = 0;
    for (let index = 0; index < first.length; index += 1) {
      const difference = first[index] - second[index];
      sum += difference * difference;
    }
    return Math.sqrt(sum);
  }

  private signature(image: IndexableFile) {
    return `${image.size}:${image.modified}`;
  }

  private newId(seed: string) {
    return createHash("sha1")
      .update(`${seed}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 20);
  }

  // Crops are served by file name from the active storage root, so stored paths
  // stay valid after the index is moved (e.g. to an external drive).
  private cropUrl(cropPath: string) {
    return `face-crop://local/${encodeURIComponent(path.basename(cropPath))}`;
  }

  private rebaseCropPath(cropPath: string) {
    return path.join(this.cropsDirectory, path.basename(cropPath));
  }

  private requirePerson(personId: string) {
    const person = this.state.people.find((item) => item.id === personId);
    if (!person) throw new Error("Person not found.");
    return person;
  }

  private async paceBackgroundWork(workMs: number) {
    const dutyPercent = this.backgroundWorkPercent;
    let cooldownRemaining = Math.ceil(
      Math.max(1, workMs) * ((100 - dutyPercent) / dutyPercent),
    );

    while (
      cooldownRemaining > 0 &&
      !this.pauseRequested &&
      !this.hasActiveInteractiveSearch()
    ) {
      const sliceMs = Math.min(50, cooldownRemaining);
      await new Promise<void>((resolve) => setTimeout(resolve, sliceMs));
      cooldownRemaining -= sliceMs;
    }
    // Let an active search take priority before beginning another face image.
    while (this.hasActiveInteractiveSearch() && !this.pauseRequested)
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }

  private emitProgress() {
    this.onProgress({ ...this.progress });
  }

  private async updateProgress(
    update: Partial<FaceIndexProgress>,
    persist: boolean,
  ) {
    this.progress = { ...this.progress, ...update };
    this.emitProgress();
    if (persist) await this.persistProgress();
  }

  private async persistProgress() {
    const temporary = `${this.progressPath}.tmp`;
    await fsPromises.writeFile(
      temporary,
      JSON.stringify(this.progress, null, 2),
    );
    await fsPromises.rename(temporary, this.progressPath);
  }

  private async loadStateJournal(savedVersion: number) {
    this.stateJournalSequence = savedVersion;
    let contents: string;
    try {
      contents = await fsPromises.readFile(this.stateJournalPath, "utf8");
    } catch {
      this.state.stateJournalVersion = savedVersion;
      return;
    }

    const peopleById = new Map(this.state.people.map((person) => [person.id, person]));
    this.state.faceEdits ??= {};
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      let entry: FaceStateJournalEntry;
      try {
        entry = JSON.parse(line) as FaceStateJournalEntry;
      } catch {
        // A torn final append is ignored; the next append begins on a new line.
        continue;
      }
      if (
        entry?.version !== 1 ||
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence < 1
      )
        continue;
      this.stateJournalSequence = Math.max(
        this.stateJournalSequence,
        entry.sequence,
      );
      if (entry.sequence <= savedVersion) continue;

      for (const [personId, person] of Object.entries(entry.people ?? {})) {
        if (person === null) {
          peopleById.delete(personId);
          continue;
        }
        if (!person || person.id !== personId) continue;
        peopleById.set(personId, person);
      }
      for (const [personId, patch] of Object.entries(
        entry.personPatches ?? {},
      )) {
        const person = peopleById.get(personId);
        if (!person || !patch || typeof patch !== "object") continue;
        if (Array.isArray(patch.centroid)) person.centroid = patch.centroid;
        if (Array.isArray(patch.suggestedFaceIds))
          person.suggestedFaceIds = patch.suggestedFaceIds;
        if (typeof patch.recognitionPending === "boolean")
          person.recognitionPending = patch.recognitionPending;
        if (typeof patch.recognitionFailed === "boolean")
          person.recognitionFailed = patch.recognitionFailed;
      }
      for (const [faceId, edit] of Object.entries(entry.faceEdits ?? {})) {
        if (edit === null) delete this.state.faceEdits[faceId];
        else if (edit && typeof edit === "object")
          this.state.faceEdits[faceId] = edit;
      }
      for (const [personId, flags] of Object.entries(entry.personFlags ?? {})) {
        const person = peopleById.get(personId);
        if (!person || !flags || typeof flags !== "object") continue;
        if (typeof flags.recognitionPending === "boolean")
          person.recognitionPending = flags.recognitionPending;
        if (typeof flags.recognitionFailed === "boolean")
          person.recognitionFailed = flags.recognitionFailed;
      }
      if (entry.bannedFaces) this.state.bannedFaces = entry.bannedFaces;
    }
    this.state.people = Array.from(peopleById.values());
    this.state.stateJournalVersion = this.stateJournalSequence;
  }

  private queueStateWrite<T>(operation: () => Promise<T>): Promise<T> {
    const write = this.stateWriteChain.then(operation);
    this.stateWriteChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /** Persist only the people and face edits touched by a user-facing face edit. */
  private async persistStateDelta(options: {
    personIds?: readonly string[];
    personPatchIds?: readonly string[];
    faceIds?: readonly string[];
    personFlagIds?: readonly string[];
    bannedFaces?: Record<string, BannedFace>;
  }) {
    await this.recordWriteChain;
    const peopleById = new Map(this.state.people.map((person) => [person.id, person]));
    const people = Object.fromEntries(
      Array.from(new Set(options.personIds ?? []), (personId) => {
        const person = peopleById.get(personId);
        return [personId, person ? JSON.parse(JSON.stringify(person)) : null];
      }),
    );
    const personPatches = Object.fromEntries(
      Array.from(new Set(options.personPatchIds ?? []), (personId) => {
        const person = peopleById.get(personId);
        return [
          personId,
          person
            ? {
                centroid: [...person.centroid],
                suggestedFaceIds: [...(person.suggestedFaceIds ?? [])],
                recognitionPending: Boolean(person.recognitionPending),
                recognitionFailed: Boolean(person.recognitionFailed),
              }
            : null,
        ];
      }).filter(([, patch]) => patch !== null),
    );
    const edits = this.state.faceEdits ?? {};
    const faceEdits = Object.fromEntries(
      Array.from(new Set(options.faceIds ?? []), (faceId) => [
        faceId,
        edits[faceId] ? JSON.parse(JSON.stringify(edits[faceId])) : null,
      ]),
    );
    const personFlags = Object.fromEntries(
      Array.from(new Set(options.personFlagIds ?? []), (personId) => {
        const person = peopleById.get(personId);
        return [
          personId,
          person
            ? {
                recognitionPending: Boolean(person.recognitionPending),
                recognitionFailed: Boolean(person.recognitionFailed),
              }
            : null,
        ];
      }).filter(([, flags]) => flags !== null),
    );
    if (
      Object.keys(people).length === 0 &&
      Object.keys(personPatches).length === 0 &&
      Object.keys(faceEdits).length === 0 &&
      Object.keys(personFlags).length === 0 &&
      options.bannedFaces === undefined
    )
      return;

    const snapshot = JSON.stringify({
      people,
      personPatches,
      faceEdits,
      personFlags,
      ...(options.bannedFaces === undefined
        ? {}
        : { bannedFaces: options.bannedFaces }),
    });
    await this.queueStateWrite(async () => {
      const entry: FaceStateJournalEntry = {
        version: 1,
        sequence: this.stateJournalSequence + 1,
        ...(JSON.parse(snapshot) as Omit<FaceStateJournalEntry, "version" | "sequence">),
      };
      const line = `\n${JSON.stringify(entry)}\n`;
      await fsPromises.appendFile(this.stateJournalPath, line, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.stateJournalSequence = entry.sequence;
      this.state.stateJournalVersion = entry.sequence;
      this.photoPeopleCache = null;
    });
  }

  private async persistState() {
    // A state checkpoint must never claim to include journal records that have
    // not reached disk yet. Waiting here also makes user edits a safe checkpoint.
    return this.queueStateWrite(async () => {
      await this.recordWriteChain;
      this.photoPeopleCache = null;
      const data = JSON.stringify({
        ...this.state,
        faceRecordVersion: this.faceRecordVersion,
        stateJournalVersion: this.stateJournalSequence,
      });
      const temporary = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await fsPromises.writeFile(temporary, data);
        await fsPromises.rename(temporary, this.statePath);
      } finally {
        await fsPromises.rm(temporary, { force: true });
      }
      await fsPromises.rm(this.stateJournalPath, { force: true }).catch(() => undefined);
    });
  }
}
