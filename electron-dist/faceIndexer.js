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
exports.FaceIndexer = void 0;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const fsPromises = __importStar(require("fs/promises"));
const AUTO_CLUSTER_DISTANCE = 0.48;
const COMBINE_CLUSTER_DISTANCE = 0.4;
// Stricter than auto-clustering: a suggestion must sit close to an actual confirmed face.
const TRAINED_MATCH_DISTANCE = 0.42;
const MAX_EXEMPLARS = 64;
const FACE_WASM_THREAD_LIMIT = 2;
const MAX_EDIT_HISTORY = 100;
const initialProgress = {
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
class FaceIndexer {
    constructor(userDataPath, modelPath, wasmPath, getIndexedImages, onProgress, indexStoragePath = userDataPath) {
        this.faces = new Map();
        this.facesByImage = new Map();
        this.baseFaceBoxes = new Map();
        this.baseFaceCrops = new Map();
        this.processedSignatures = new Map();
        this.state = { version: 1, people: [], bannedFaces: {} };
        this.progress = { ...initialProgress };
        this.runtime = null;
        this.runPromise = null;
        this.pauseRequested = false;
        this.bannedPhotoPaths = new Set();
        this.recognitionChain = Promise.resolve();
        this.recognitionListener = () => undefined;
        this.stateWriteChain = Promise.resolve();
        this.undoStack = [];
        this.redoStack = [];
        this.missingPhotos = new Set();
        // True when a photo is hidden from review (content protection / another person's ban).
        this.hiddenPhoto = () => false;
        this.peopleChangeListener = () => undefined;
        this.photoPeopleCache = null;
        this.directory = path.join(indexStoragePath, "face-index");
        this.recordsPath = path.join(this.directory, "faces.jsonl");
        this.statePath = path.join(this.directory, "people.json");
        this.progressPath = path.join(this.directory, "progress.json");
        this.cropsDirectory = path.join(this.directory, "crops");
        this.modelPath = modelPath;
        this.wasmPath = wasmPath;
        this.getIndexedImages = getIndexedImages;
        this.onProgress = onProgress;
    }
    async initialize() {
        await fsPromises.mkdir(this.cropsDirectory, { recursive: true });
        await this.loadRecords();
        try {
            this.state = JSON.parse(await fsPromises.readFile(this.statePath, "utf8"));
        }
        catch {
            await this.persistState();
        }
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
        }
        catch {
            await this.persistProgress();
        }
        this.reconcilePeople();
        this.bannedPhotoPaths = new Set(this.state.bannedPhotoPaths ?? []);
        this.missingPhotos = new Set(this.state.missingPhotoPaths ?? []);
        void this.recheckMissingPhotos();
        void this.refreshRecognition();
    }
    setHiddenPhotoPredicate(predicate) {
        this.hiddenPhoto = predicate;
    }
    setPeopleChangeListener(listener) {
        this.peopleChangeListener = listener;
    }
    /** Photos whose files were deleted stop counting toward people and their confirmation progress. */
    async markMissingPhotos(photoPaths) {
        let changed = false;
        for (const photoPath of photoPaths) {
            if (this.missingPhotos.has(photoPath))
                continue;
            this.missingPhotos.add(photoPath);
            changed = true;
        }
        if (!changed)
            return;
        this.state.missingPhotoPaths = Array.from(this.missingPhotos);
        await this.persistState();
    }
    async recheckMissingPhotos() {
        const restored = [];
        for (const photoPath of this.missingPhotos) {
            if (await fsPromises.access(photoPath).then(() => true, () => false))
                restored.push(photoPath);
        }
        if (restored.length === 0)
            return;
        restored.forEach((photoPath) => this.missingPhotos.delete(photoPath));
        this.state.missingPhotoPaths = Array.from(this.missingPhotos);
        await this.persistState();
    }
    /** Called when the set of photos hidden by banned people changes. */
    setRecognitionListener(listener) {
        this.recognitionListener = listener;
    }
    getBannedPhotoPaths() {
        return this.bannedPhotoPaths;
    }
    /** Runs a user edit and records what it changed so it can be undone and redone. */
    async recordEdit(label, edit) {
        const before = new Map(this.state.people.map((person) => [person.id, JSON.stringify(person)]));
        const bannedBefore = JSON.stringify(this.state.bannedFaces ?? {});
        const faceEditsBefore = new Map(Object.entries(this.state.faceEdits ?? {}).map(([id, value]) => [
            id,
            JSON.stringify(value),
        ]));
        const result = await edit();
        const step = {
            label,
            before: new Map(),
            after: new Map(),
            bannedBefore,
            bannedAfter: JSON.stringify(this.state.bannedFaces ?? {}),
            faceEditsBefore: new Map(),
            faceEditsAfter: new Map(),
        };
        const present = new Set();
        for (const person of this.state.people) {
            present.add(person.id);
            const now = JSON.stringify(person);
            const was = before.get(person.id);
            if (was === now)
                continue;
            step.before.set(person.id, was ?? null);
            step.after.set(person.id, now);
        }
        for (const [personId, was] of before) {
            if (present.has(personId))
                continue;
            step.before.set(personId, was);
            step.after.set(personId, null);
        }
        const currentFaceEdits = this.state.faceEdits ?? {};
        const faceEditIds = new Set([
            ...faceEditsBefore.keys(),
            ...Object.keys(currentFaceEdits),
        ]);
        for (const faceId of faceEditIds) {
            const was = faceEditsBefore.get(faceId) ?? null;
            const now = currentFaceEdits[faceId]
                ? JSON.stringify(currentFaceEdits[faceId])
                : null;
            if (was === now)
                continue;
            step.faceEditsBefore.set(faceId, was);
            step.faceEditsAfter.set(faceId, now);
        }
        if (step.before.size > 0 ||
            step.bannedBefore !== step.bannedAfter ||
            step.faceEditsBefore.size > 0) {
            this.undoStack.push(step);
            if (this.undoStack.length > MAX_EDIT_HISTORY)
                this.undoStack.shift();
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
        if (!step)
            return null;
        await this.restoreSnapshot(step.before, step.bannedBefore, step.faceEditsBefore);
        this.redoStack.push(step);
        this.peopleChangeListener();
        return step.label;
    }
    async redo() {
        const step = this.redoStack.pop();
        if (!step)
            return null;
        await this.restoreSnapshot(step.after, step.bannedAfter, step.faceEditsAfter);
        this.undoStack.push(step);
        this.peopleChangeListener();
        return step.label;
    }
    async restoreSnapshot(snapshot, bannedFaces, faceEdits) {
        var _a;
        for (const [personId, serialized] of snapshot) {
            const index = this.state.people.findIndex((person) => person.id === personId);
            if (serialized === null) {
                if (index >= 0)
                    this.state.people.splice(index, 1);
            }
            else if (index >= 0) {
                this.state.people[index] = JSON.parse(serialized);
            }
            else {
                this.state.people.push(JSON.parse(serialized));
            }
        }
        this.state.bannedFaces = JSON.parse(bannedFaces);
        (_a = this.state).faceEdits ?? (_a.faceEdits = {});
        for (const [faceId, serialized] of faceEdits) {
            if (serialized === null)
                delete this.state.faceEdits[faceId];
            else
                this.state.faceEdits[faceId] = JSON.parse(serialized);
            const face = this.faces.get(faceId);
            if (face) {
                face.box = { ...(this.baseFaceBoxes.get(faceId) ?? face.box) };
                const override = this.state.faceEdits[faceId]?.box;
                if (override)
                    face.box = { ...override };
                face.cropPath = this.rebaseCropPath(this.state.faceEdits[faceId]?.cropPath ??
                    this.baseFaceCrops.get(faceId) ??
                    face.cropPath);
                if (face.manual && !this.state.faceEdits[faceId])
                    this.state.faceEdits[faceId] = { deleted: true };
            }
        }
        // Face -> person links are derived from people, so rebuild them to match the restored state.
        for (const face of this.faces.values())
            face.personIds = [];
        for (const person of this.state.people)
            for (const faceId of person.faceIds)
                this.faces.get(faceId)?.personIds.push(person.id);
        for (const personId of snapshot.keys()) {
            const person = this.state.people.find((item) => item.id === personId);
            if (person)
                this.updateCentroid(person);
        }
        await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
    }
    getProgress() {
        return { ...this.progress };
    }
    start() {
        if (this.runPromise)
            return this.runPromise;
        this.pauseRequested = false;
        this.runPromise = this.run().finally(() => {
            this.runPromise = null;
        });
        return this.runPromise;
    }
    async pause() {
        this.pauseRequested = true;
        if (!this.runPromise)
            await this.updateProgress({ status: "paused", message: "Face indexing paused." }, true);
    }
    getPeople() {
        return this.state.people
            .map((person) => this.summarizePerson(person))
            .filter((person) => person.photoCount > 0 ||
            person.manual ||
            person.status !== "unconfirmed")
            .sort((first, second) => second.photoCount - first.photoCount ||
            first.name.localeCompare(second.name));
    }
    getPerson(personId) {
        const person = this.state.people.find((item) => item.id === personId);
        if (!person)
            return null;
        const faces = person.faceIds
            .map((faceId) => this.faces.get(faceId))
            .filter((face) => Boolean(face))
            .filter((face) => !this.isFaceDeleted(face))
            .filter((face) => !person.rejectedPhotoPaths.includes(face.imagePath));
        return {
            ...this.summarizePerson(person),
            photoPaths: this.photoPathsOf(person),
            confirmedPhotoPaths: [...person.confirmedPhotoPaths],
            suggestedPhotoPaths: this.suggestedFacesOf(person).map((face) => face.imagePath),
            faces: faces.map((face) => ({
                id: face.id,
                imagePath: face.imagePath,
                cropUrl: this.cropUrl(face.cropPath),
                score: face.score,
            })),
        };
    }
    async confirmAllPhotos(personId) {
        const person = this.requirePerson(personId);
        const ownerBanned = person.status === "banned";
        // Only photos the user can actually see; hidden ones were never reviewed.
        const reviewable = this.photoPathsOf(person).filter((photoPath) => !this.hiddenPhoto(photoPath, ownerBanned));
        person.confirmedPhotoPaths = Array.from(new Set([...person.confirmedPhotoPaths, ...reviewable]));
        await this.persistState();
        return this.getPerson(personId);
    }
    /** Marks a fully confirmed person as known and searches every indexed face for more photos of them. */
    async trainPerson(personId) {
        const person = this.requireFullyConfirmed(personId);
        if (person.status !== "banned")
            person.status = "confirmed";
        person.trainedAt = Date.now();
        await this.queueRecognition(() => this.refreshSuggestions(person));
        await this.persistState();
        return this.getPerson(personId);
    }
    async banPerson(personId, confidence = 80) {
        const person = this.requirePerson(personId);
        person.status = "banned";
        person.trainedAt = Date.now();
        if (!this.state.bannedFaces)
            this.state.bannedFaces = {};
        this.state.bannedFaces[personId] = {
            personId,
            personName: person.name,
            confidence: this.state.bannedFaces[personId]?.confidence ??
                Math.max(0, Math.min(100, confidence)),
            reason: { type: "banned-people" },
            addedAt: Date.now(),
        };
        await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return this.getPerson(personId);
    }
    /**
     * Moves photos out of one person into another (or a newly created person), or just removes them when
     * `target` is null. The source's faces on each photo travel with it, and moved photos count as confirmed.
     */
    async movePhotos(sourceId, imagePaths, target) {
        const source = this.requirePerson(sourceId);
        let destination = null;
        if (target?.personId) {
            if (target.personId === sourceId)
                throw new Error("Choose a different person.");
            destination = this.requirePerson(target.personId);
        }
        else if (target?.newName !== undefined) {
            const name = target.newName.trim();
            if (!name)
                throw new Error("Enter a person name.");
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
                .filter((face) => Boolean(face) && face.imagePath === imagePath);
            const movingIds = new Set(movingFaces.map((face) => face.id));
            source.faceIds = source.faceIds.filter((faceId) => !movingIds.has(faceId));
            source.suggestedFaceIds = (source.suggestedFaceIds ?? []).filter((faceId) => this.faces.get(faceId)?.imagePath !== imagePath);
            source.manualPhotoPaths = source.manualPhotoPaths.filter((item) => item !== imagePath);
            source.confirmedPhotoPaths = source.confirmedPhotoPaths.filter((item) => item !== imagePath);
            if (!source.rejectedPhotoPaths.includes(imagePath))
                source.rejectedPhotoPaths.push(imagePath);
            for (const face of movingFaces)
                face.personIds = face.personIds.filter((personId) => personId !== sourceId);
            if (!destination)
                continue;
            if (movingFaces.length > 0) {
                for (const face of movingFaces) {
                    if (!destination.faceIds.includes(face.id))
                        destination.faceIds.push(face.id);
                    if (!face.personIds.includes(destination.id))
                        face.personIds.push(destination.id);
                }
            }
            else if (!destination.manualPhotoPaths.includes(imagePath)) {
                destination.manualPhotoPaths.push(imagePath);
            }
            if (!destination.confirmedPhotoPaths.includes(imagePath))
                destination.confirmedPhotoPaths.push(imagePath);
            destination.rejectedPhotoPaths = destination.rejectedPhotoPaths.filter((item) => item !== imagePath);
        }
        this.updateCentroid(source);
        if (destination)
            this.updateCentroid(destination);
        if (source.status === "banned" || destination?.status === "banned")
            await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return { people: this.getPeople(), destinationId: destination?.id ?? null };
    }
    async unbanPerson(personId) {
        const person = this.requirePerson(personId);
        if (person.status === "banned")
            person.status = "confirmed";
        if (this.state.bannedFaces)
            delete this.state.bannedFaces[personId];
        await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return this.getPerson(personId);
    }
    async acceptSuggestions(personId, imagePaths) {
        const person = this.requirePerson(personId);
        const accepted = new Set(imagePaths);
        for (const face of this.suggestedFacesOf(person)) {
            if (!accepted.has(face.imagePath))
                continue;
            if (!person.faceIds.includes(face.id))
                person.faceIds.push(face.id);
            if (!face.personIds.includes(personId))
                face.personIds.push(personId);
            if (!person.confirmedPhotoPaths.includes(face.imagePath))
                person.confirmedPhotoPaths.push(face.imagePath);
            person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter((item) => item !== face.imagePath);
        }
        person.suggestedFaceIds = (person.suggestedFaceIds ?? []).filter((faceId) => !accepted.has(this.faces.get(faceId)?.imagePath ?? ""));
        this.updateCentroid(person);
        if (person.status === "banned")
            await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return this.getPerson(personId);
    }
    async rejectSuggestions(personId, imagePaths) {
        const person = this.requirePerson(personId);
        const rejected = new Set(imagePaths);
        for (const imagePath of rejected)
            if (!person.rejectedPhotoPaths.includes(imagePath))
                person.rejectedPhotoPaths.push(imagePath);
        person.suggestedFaceIds = (person.suggestedFaceIds ?? []).filter((faceId) => !rejected.has(this.faces.get(faceId)?.imagePath ?? ""));
        if (person.status === "banned")
            await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return this.getPerson(personId);
    }
    async createPerson(name) {
        const cleanName = name.trim();
        if (!cleanName)
            throw new Error("Enter a person name.");
        const person = {
            id: this.newId("person"),
            name: cleanName,
            faceIds: [],
            manualPhotoPaths: [],
            confirmedPhotoPaths: [],
            rejectedPhotoPaths: [],
            centroid: [],
            createdAt: Date.now(),
            manual: true,
        };
        this.state.people.push(person);
        await this.persistState();
        return this.getPeople();
    }
    async renamePerson(personId, name) {
        const person = this.requirePerson(personId);
        const cleanName = name.trim();
        if (!cleanName)
            throw new Error("Enter a person name.");
        person.name = cleanName;
        await this.persistState();
        return this.getPeople();
    }
    async deletePerson(personId) {
        const wasBanned = Boolean(this.state.bannedFaces?.[personId]);
        this.state.people = this.state.people.filter((person) => person.id !== personId);
        for (const face of this.faces.values())
            face.personIds = face.personIds.filter((id) => id !== personId);
        if (wasBanned) {
            delete this.state.bannedFaces[personId];
            await this.queueRecognition(() => this.refreshBannedPhotos());
        }
        await this.persistState();
        return this.getPeople();
    }
    async assignFace(personId, faceId) {
        const person = this.requirePerson(personId);
        const face = this.faces.get(faceId);
        if (!face)
            throw new Error("Face not found.");
        if (!person.faceIds.includes(faceId))
            person.faceIds.push(faceId);
        if (!face.personIds.includes(personId))
            face.personIds.push(personId);
        person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter((item) => item !== face.imagePath);
        this.updateCentroid(person);
        await this.afterPersonPhotosChanged(person);
        return this.getPerson(personId);
    }
    async addPhoto(personId, imagePath) {
        const person = this.requirePerson(personId);
        if (!person.manualPhotoPaths.includes(imagePath))
            person.manualPhotoPaths.push(imagePath);
        person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter((item) => item !== imagePath);
        await this.afterPersonPhotosChanged(person);
        return this.getPerson(personId);
    }
    async confirmPhoto(personId, imagePath) {
        const person = this.requirePerson(personId);
        if (!person.confirmedPhotoPaths.includes(imagePath))
            person.confirmedPhotoPaths.push(imagePath);
        person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter((item) => item !== imagePath);
        await this.persistState();
        return this.getPerson(personId);
    }
    async confirmPhotos(personId, imagePaths) {
        const person = this.requirePerson(personId);
        const owned = new Set(this.photoPathsOf(person));
        const confirmed = new Set(person.confirmedPhotoPaths);
        for (const imagePath of imagePaths) {
            if (!owned.has(imagePath) || confirmed.has(imagePath))
                continue;
            confirmed.add(imagePath);
            person.confirmedPhotoPaths.push(imagePath);
        }
        await this.persistState();
        return this.getPerson(personId);
    }
    newManualPerson(name) {
        const cleanName = name.trim();
        if (!cleanName)
            throw new Error("Enter a person name.");
        const person = {
            id: this.newId("person"),
            name: cleanName,
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
    /**
     * Adds photos to a person as confirmed. A photo with exactly one detected face gets that face assigned
     * (taking it out of any unnamed automatic cluster); otherwise it is added as a manual photo.
     */
    async addPhotosToPerson(target, imagePaths) {
        const person = target.personId
            ? this.requirePerson(target.personId)
            : this.newManualPerson(target.newName ?? "");
        const affected = new Set([person]);
        for (const imagePath of new Set(imagePaths)) {
            person.rejectedPhotoPaths = person.rejectedPhotoPaths.filter((item) => item !== imagePath);
            const faces = this.facesByImage.get(imagePath) ?? [];
            const activeFaces = faces.filter((face) => !this.isFaceDeleted(face));
            const alreadyHasFace = activeFaces.some((face) => person.faceIds.includes(face.id));
            if (!alreadyHasFace && activeFaces.length === 1) {
                const face = activeFaces[0];
                for (const other of this.state.people) {
                    if (other.id === person.id ||
                        other.manual ||
                        other.status ||
                        !/^Person \d+$/.test(other.name))
                        continue;
                    if (!other.faceIds.includes(face.id))
                        continue;
                    other.faceIds = other.faceIds.filter((faceId) => faceId !== face.id);
                    face.personIds = face.personIds.filter((personId) => personId !== other.id);
                    affected.add(other);
                }
                person.faceIds.push(face.id);
                if (!face.personIds.includes(person.id))
                    face.personIds.push(person.id);
            }
            else if (!alreadyHasFace &&
                !person.manualPhotoPaths.includes(imagePath)) {
                person.manualPhotoPaths.push(imagePath);
            }
            if (!person.confirmedPhotoPaths.includes(imagePath))
                person.confirmedPhotoPaths.push(imagePath);
        }
        affected.forEach((item) => this.updateCentroid(item));
        if (person.status === "banned")
            await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
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
    async mergePeople(sourceId, targetId) {
        if (sourceId === targetId)
            throw new Error("Choose a different person to merge into.");
        const source = this.requirePerson(sourceId);
        const target = this.requirePerson(targetId);
        const sourcePhotos = new Set(this.photoPathsOf(source));
        const sourceConfirmed = new Set(source.confirmedPhotoPaths.filter((photoPath) => sourcePhotos.has(photoPath)));
        for (const faceId of source.faceIds) {
            const face = this.faces.get(faceId);
            if (!face || source.rejectedPhotoPaths.includes(face.imagePath))
                continue;
            if (!target.faceIds.includes(faceId))
                target.faceIds.push(faceId);
            face.personIds = Array.from(new Set([
                ...face.personIds.filter((personId) => personId !== sourceId),
                targetId,
            ]));
        }
        for (const photoPath of source.manualPhotoPaths)
            if (sourcePhotos.has(photoPath) &&
                !target.manualPhotoPaths.includes(photoPath))
                target.manualPhotoPaths.push(photoPath);
        // The user chose this merge, so the source's photos override earlier removals from the target.
        target.rejectedPhotoPaths = target.rejectedPhotoPaths.filter((photoPath) => !sourcePhotos.has(photoPath));
        for (const photoPath of sourceConfirmed)
            if (!target.confirmedPhotoPaths.includes(photoPath))
                target.confirmedPhotoPaths.push(photoPath);
        target.suggestedFaceIds = Array.from(new Set([
            ...(target.suggestedFaceIds ?? []),
            ...(source.suggestedFaceIds ?? []),
        ]));
        this.state.people = this.state.people.filter((person) => person.id !== sourceId);
        for (const face of this.faces.values())
            if (face.personIds.includes(sourceId))
                face.personIds = face.personIds.filter((personId) => personId !== sourceId);
        const sourceWasBanned = Boolean(this.state.bannedFaces?.[sourceId]);
        if (sourceWasBanned)
            delete this.state.bannedFaces[sourceId];
        this.updateCentroid(target);
        if (sourceWasBanned || target.status === "banned")
            await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return {
            detail: this.getPerson(targetId),
            moved: sourcePhotos.size,
            confirmed: sourceConfirmed.size,
        };
    }
    async removePhoto(personId, imagePath) {
        const person = this.requirePerson(personId);
        if (!person.rejectedPhotoPaths.includes(imagePath))
            person.rejectedPhotoPaths.push(imagePath);
        person.manualPhotoPaths = person.manualPhotoPaths.filter((item) => item !== imagePath);
        person.confirmedPhotoPaths = person.confirmedPhotoPaths.filter((item) => item !== imagePath);
        await this.afterPersonPhotosChanged(person);
        return this.getPerson(personId);
    }
    async afterPersonPhotosChanged(person) {
        if (person.status === "banned")
            await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
    }
    async setSelectedCoverPhoto(personId, photoPath) {
        const person = this.requirePerson(personId);
        // If setting a specific photo, verify it's actually in this person's photos
        if (photoPath !== null) {
            const allPhotos = this.photoPathsOf(person);
            if (!allPhotos.includes(photoPath)) {
                throw new Error("Selected photo is not in this person's collection.");
            }
        }
        person.selectedCoverPhotoPath = photoPath;
        await this.persistState();
        return this.getPerson(personId);
    }
    async getBannedFaces() {
        return Object.values(this.state.bannedFaces || {}).sort((a, b) => b.addedAt - a.addedAt);
    }
    async addBannedFace(personId, reason, confidence = 80) {
        const person = this.requirePerson(personId);
        const banned = {
            personId,
            personName: person.name,
            confidence: Math.max(0, Math.min(100, confidence)),
            reason,
            addedAt: Date.now(),
        };
        if (!this.state.bannedFaces)
            this.state.bannedFaces = {};
        this.state.bannedFaces[personId] = banned;
        person.status = "banned";
        await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return this.getBannedFaces();
    }
    async removeBannedFace(personId) {
        if (this.state.bannedFaces && personId in this.state.bannedFaces) {
            delete this.state.bannedFaces[personId];
            const person = this.state.people.find((item) => item.id === personId);
            if (person?.status === "banned")
                person.status = "confirmed";
            await this.queueRecognition(() => this.refreshBannedPhotos());
            await this.persistState();
        }
        return this.getBannedFaces();
    }
    async setBannedFaceConfidence(personId, confidence) {
        if (!this.state.bannedFaces || !(personId in this.state.bannedFaces)) {
            throw new Error("This person is not in the banned list.");
        }
        this.state.bannedFaces[personId].confidence = Math.max(0, Math.min(100, confidence));
        await this.queueRecognition(() => this.refreshBannedPhotos());
        await this.persistState();
        return this.getBannedFaces();
    }
    getFaceBoxes(imagePath) {
        return (this.facesByImage.get(imagePath) ?? [])
            .filter((face) => !this.isFaceDeleted(face))
            .map((face) => ({
            ...face.box,
            score: face.score,
        }));
    }
    getFacesForImage(imagePath) {
        return (this.facesByImage.get(imagePath) ?? [])
            .filter((face) => !this.isFaceDeleted(face))
            .map((face) => ({
            id: face.id,
            imagePath,
            box: { ...face.box },
            cropUrl: this.cropUrl(face.cropPath),
            score: face.score,
            personIds: this.state.people
                .filter((person) => person.faceIds.includes(face.id))
                .map((person) => person.id),
        }));
    }
    async updateFaceBox(faceId, box, localPath) {
        var _a, _b;
        const face = this.faces.get(faceId);
        if (!face || this.isFaceDeleted(face))
            throw new Error("Face not found.");
        const width = Math.max(0.001, Math.min(1, box.width));
        const height = Math.max(0.001, Math.min(1, box.height));
        const nextBox = {
            x: Math.max(0, Math.min(1 - width, box.x)),
            y: Math.max(0, Math.min(1 - height, box.y)),
            width,
            height,
        };
        if (localPath) {
            const sharp = require("sharp");
            const image = sharp(localPath);
            const metadata = await image.metadata();
            if (!metadata.width || !metadata.height)
                throw new Error("Could not read image dimensions.");
            const left = Math.max(0, Math.floor(nextBox.x * metadata.width));
            const top = Math.max(0, Math.floor(nextBox.y * metadata.height));
            const cropWidth = Math.min(metadata.width - left, Math.ceil(width * metadata.width));
            const cropHeight = Math.min(metadata.height - top, Math.ceil(height * metadata.height));
            const cropPath = path.join(this.cropsDirectory, `${face.id}-edit-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
            await image
                .extract({ left, top, width: cropWidth, height: cropHeight })
                .resize(256, 256, { fit: "cover" })
                .jpeg({ quality: 78 })
                .toFile(cropPath);
            face.cropPath = cropPath;
            (_a = this.state).faceEdits ?? (_a.faceEdits = {});
            this.state.faceEdits[faceId] = {
                ...this.state.faceEdits[faceId],
                cropPath,
            };
        }
        (_b = this.state).faceEdits ?? (_b.faceEdits = {});
        this.state.faceEdits[faceId] = {
            ...this.state.faceEdits[faceId],
            box: nextBox,
        };
        face.box = nextBox;
        await this.persistState();
        return this.getFacesForImage(face.imagePath);
    }
    async deleteFace(faceId) {
        var _a;
        const face = this.faces.get(faceId);
        if (!face)
            throw new Error("Face not found.");
        (_a = this.state).faceEdits ?? (_a.faceEdits = {});
        this.state.faceEdits[faceId] = {
            ...this.state.faceEdits[faceId],
            deleted: true,
        };
        face.personIds = [];
        for (const person of this.state.people) {
            person.faceIds = person.faceIds.filter((id) => id !== faceId);
            person.suggestedFaceIds = (person.suggestedFaceIds ?? []).filter((id) => id !== faceId);
            this.updateCentroid(person);
        }
        await this.persistState();
        return this.getFacesForImage(face.imagePath);
    }
    async createFaceBox(imagePath, localPath, box) {
        var _a;
        const sharp = require("sharp");
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
        const left = Math.max(0, Math.floor(normalized.x * metadata.width));
        const top = Math.max(0, Math.floor(normalized.y * metadata.height));
        const cropWidth = Math.min(metadata.width - left, Math.ceil(width * metadata.width));
        const cropHeight = Math.min(metadata.height - top, Math.ceil(height * metadata.height));
        if (cropWidth < 8 || cropHeight < 8)
            throw new Error("Select a larger area for the face.");
        const faceId = this.newId(`${imagePath}:manual-face`);
        const cropPath = path.join(this.cropsDirectory, `${faceId}.jpg`);
        await image
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .resize(256, 256, { fit: "cover" })
            .jpeg({ quality: 78 })
            .toFile(cropPath);
        const face = {
            id: faceId,
            imagePath,
            signature: `${stats.size}:${stats.mtimeMs}`,
            box: normalized,
            score: 1,
            descriptor: [],
            cropPath,
            personIds: [],
            manual: true,
        };
        (_a = this.state).faceEdits ?? (_a.faceEdits = {});
        this.state.faceEdits[faceId] = { created: true };
        const existing = this.facesByImage.get(imagePath) ?? [];
        await this.appendProcessed({
            name: path.basename(imagePath),
            path: imagePath,
            relativePath: imagePath,
            size: stats.size,
            modified: stats.mtimeMs,
            isDirectory: false,
            type: "image",
            extension: path.extname(imagePath),
        }, [...existing, face], false);
        await this.persistState();
        return this.getFacesForImage(imagePath);
    }
    getPeopleForImages(imagePaths) {
        if (this.photoPeopleCache)
            return Object.fromEntries(imagePaths.map((filePath) => [
                filePath,
                this.photoPeopleCache.get(filePath) ?? [],
            ]));
        const requested = new Set(imagePaths);
        const names = new Map();
        for (const person of this.state.people) {
            const personPaths = new Set(person.manualPhotoPaths);
            for (const faceId of person.faceIds) {
                const face = this.faces.get(faceId);
                if (face)
                    personPaths.add(face.imagePath);
            }
            for (const imagePath of personPaths) {
                if (person.rejectedPhotoPaths.includes(imagePath))
                    continue;
                const labels = names.get(imagePath) ?? new Set();
                labels.add(person.name);
                names.set(imagePath, labels);
            }
        }
        this.photoPeopleCache = new Map(Array.from(names, ([filePath, values]) => [filePath, Array.from(values)]));
        return Object.fromEntries(Array.from(requested, (imagePath) => [
            imagePath,
            Array.from(names.get(imagePath) ?? []),
        ]));
    }
    async run() {
        try {
            const imagesOrPromise = this.getIndexedImages();
            const images = imagesOrPromise instanceof Promise
                ? await imagesOrPromise
                : imagesOrPromise;
            const pending = images.filter((image) => this.processedSignatures.get(image.path) !== this.signature(image));
            const processed = images.length - pending.length;
            await this.updateProgress({
                total: images.length,
                processed,
                remaining: pending.length,
                errors: 0,
                faces: this.faces.size,
                people: this.getPeople().length,
                currentFile: null,
            }, true);
            if (pending.length === 0) {
                const combined = await this.combineSimilarClusters();
                await this.refreshRecognition();
                await this.updateProgress({
                    status: "complete",
                    people: this.getPeople().length,
                    message: images.length
                        ? combined > 0
                            ? `Face index is up to date. Bundled ${combined} similar cluster${combined === 1 ? "" : "s"}.`
                            : "Face index is up to date."
                        : "Waiting for indexed photos.",
                }, true);
                return;
            }
            await this.updateProgress({ status: "loading-model", message: "Loading offline face models..." }, true);
            const runtime = await this.loadRuntime();
            await this.updateProgress({ status: "indexing", message: "Detecting and clustering faces..." }, true);
            for (let index = 0; index < pending.length; index += 1) {
                if (this.pauseRequested) {
                    await this.updateProgress({
                        status: "paused",
                        currentFile: null,
                        message: "Face indexing paused.",
                    }, true);
                    return;
                }
                const image = pending[index];
                await this.updateProgress({ currentFile: image.name }, false);
                try {
                    await this.processImage(image, runtime);
                    await this.persistState();
                }
                catch {
                    this.progress.errors += 1;
                }
                this.progress.processed += 1;
                this.progress.remaining = Math.max(0, this.progress.remaining - 1);
                this.progress.faces = this.faces.size;
                this.progress.people = this.getPeople().length;
                this.emitProgress();
                if (index % 10 === 9)
                    await this.persistProgress();
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await this.updateProgress({ message: "Bundling similar face clusters..." }, true);
            const combined = await this.combineSimilarClusters();
            await this.updateProgress({ message: "Matching confirmed people..." }, false);
            await this.refreshRecognition();
            await this.persistState();
            await this.updateProgress({
                status: "complete",
                currentFile: null,
                remaining: 0,
                people: this.getPeople().length,
                message: combined > 0
                    ? `Face index is up to date. Bundled ${combined} similar cluster${combined === 1 ? "" : "s"}.`
                    : "Face index is up to date.",
            }, true);
        }
        catch (error) {
            await this.updateProgress({
                status: "error",
                currentFile: null,
                message: error instanceof Error ? error.message : "Face indexing failed.",
            }, true);
        }
    }
    async processImage(image, runtime) {
        const decoded = await runtime
            .sharp(image.path)
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
        const tensor = runtime.faceapi.tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels], "int32");
        let detections;
        try {
            detections = await runtime.faceapi
                .detectAllFaces(tensor, new runtime.faceapi.TinyFaceDetectorOptions({
                inputSize: 416,
                scoreThreshold: 0.45,
            }))
                .withFaceLandmarks()
                .withFaceDescriptors();
        }
        finally {
            tensor.dispose();
        }
        const records = [];
        for (let index = 0; index < detections.length; index += 1) {
            const detection = detections[index];
            const box = detection.detection.box;
            const padding = Math.max(box.width, box.height) * 0.22;
            const left = Math.max(0, Math.floor(box.x - padding));
            const top = Math.max(0, Math.floor(box.y - padding));
            const width = Math.min(info.width - left, Math.ceil(box.width + padding * 2));
            const height = Math.min(info.height - top, Math.ceil(box.height + padding * 2));
            if (width < 20 || height < 20)
                continue;
            const faceId = this.newId(`${image.path}:${index}:${image.modified}`);
            const cropPath = path.join(this.cropsDirectory, `${faceId}.jpg`);
            await runtime
                .sharp(data, { raw: info })
                .extract({ left, top, width, height })
                .resize(256, 256, { fit: "cover" })
                .jpeg({ quality: 78 })
                .toFile(cropPath);
            const descriptor = Array.from(detection.descriptor);
            const person = this.findOrCreateCluster(descriptor);
            const record = {
                id: faceId,
                imagePath: image.path,
                signature: this.signature(image),
                box: {
                    x: box.x / info.width,
                    y: box.y / info.height,
                    width: box.width / info.width,
                    height: box.height / info.height,
                },
                score: detection.detection.score,
                descriptor,
                cropPath,
                personIds: [person.id],
            };
            records.push(record);
            this.indexFace(record);
            person.faceIds.push(faceId);
            this.updateCentroid(person);
        }
        await this.appendProcessed(image, records);
    }
    findOrCreateCluster(descriptor) {
        let best = null;
        let bestDistance = Infinity;
        for (const person of this.state.people) {
            if (!person.centroid.length || person.manual)
                continue;
            const distance = this.distance(descriptor, person.centroid);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = person;
            }
        }
        if (best && bestDistance <= AUTO_CLUSTER_DISTANCE)
            return best;
        const person = {
            id: this.newId("person"),
            name: `Person ${this.state.people.length + 1}`,
            faceIds: [],
            manualPhotoPaths: [],
            confirmedPhotoPaths: [],
            rejectedPhotoPaths: [],
            centroid: [...descriptor],
            createdAt: Date.now(),
            manual: false,
        };
        this.state.people.push(person);
        return person;
    }
    async loadRuntime() {
        if (this.runtime)
            return this.runtime;
        const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
        const wasm = require("@tensorflow/tfjs-backend-wasm");
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
    async appendProcessed(image, records, markProcessed = true) {
        const manualFaces = (this.facesByImage.get(image.path) ?? []).filter((face) => face.manual && !records.some((record) => record.id === face.id));
        const updatedRecords = [...records, ...manualFaces];
        const entry = {
            imagePath: image.path,
            signature: markProcessed
                ? this.signature(image)
                : `manual:${this.signature(image)}`,
            faces: updatedRecords,
        };
        this.replaceImageFaces(image.path, updatedRecords);
        await fsPromises.appendFile(this.recordsPath, `${JSON.stringify(entry)}\n`);
        this.processedSignatures.set(image.path, entry.signature);
    }
    async loadRecords() {
        try {
            await fsPromises.access(this.recordsPath);
        }
        catch {
            await fsPromises.writeFile(this.recordsPath, "");
            return;
        }
        // Streamed so the main process keeps servicing the UI while the face cache loads.
        const lines = readline.createInterface({
            input: fs.createReadStream(this.recordsPath, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const entry = JSON.parse(line);
                this.processedSignatures.set(entry.imagePath, entry.signature);
                this.replaceImageFaces(entry.imagePath, entry.faces);
            }
            catch {
                lines.close();
                break;
            }
        }
    }
    reconcilePeople() {
        for (const person of this.state.people) {
            person.faceIds = person.faceIds.filter((id) => this.faces.has(id));
            this.updateCentroid(person);
        }
    }
    async combineSimilarClusters() {
        let combined = 0;
        let mergedThisRound = true;
        while (mergedThisRound) {
            mergedThisRound = false;
            const candidates = this.state.people.filter((person) => !person.manual &&
                !person.status &&
                /^Person \d+$/.test(person.name) &&
                person.faceIds.length > 0 &&
                person.centroid.length > 0);
            const nearest = new Map();
            for (let firstIndex = 0; firstIndex < candidates.length; firstIndex += 1) {
                const first = candidates[firstIndex];
                const firstCentroid = this.normalized(first.centroid);
                for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex += 1) {
                    const second = candidates[secondIndex];
                    if (!this.canCombineClusters(first, second))
                        continue;
                    const distance = this.distance(firstCentroid, this.normalized(second.centroid));
                    if (distance > COMBINE_CLUSTER_DISTANCE)
                        continue;
                    if (distance < (nearest.get(first.id)?.distance ?? Infinity))
                        nearest.set(first.id, { person: second, distance });
                    if (distance < (nearest.get(second.id)?.distance ?? Infinity))
                        nearest.set(second.id, { person: first, distance });
                }
            }
            const consumed = new Set();
            for (const first of candidates) {
                if (consumed.has(first.id))
                    continue;
                const match = nearest.get(first.id);
                if (!match || consumed.has(match.person.id))
                    continue;
                if (nearest.get(match.person.id)?.person.id !== first.id)
                    continue;
                const survivor = first.faceIds.length >= match.person.faceIds.length
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
        if (combined > 0)
            await this.persistState();
        return combined;
    }
    canCombineClusters(first, second) {
        const firstByImage = new Map();
        for (const faceId of first.faceIds) {
            const face = this.faces.get(faceId);
            if (!face)
                continue;
            const matches = firstByImage.get(face.imagePath) ?? [];
            matches.push(face);
            firstByImage.set(face.imagePath, matches);
        }
        for (const faceId of second.faceIds) {
            const face = this.faces.get(faceId);
            if (!face)
                continue;
            const sameImageFaces = firstByImage.get(face.imagePath);
            if (!sameImageFaces)
                continue;
            if (!sameImageFaces.some((other) => this.boxOverlap(other.box, face.box) >= 0.5))
                return false;
        }
        return true;
    }
    mergeAutomaticClusters(survivor, absorbed) {
        survivor.faceIds = Array.from(new Set([...survivor.faceIds, ...absorbed.faceIds]));
        survivor.manualPhotoPaths = Array.from(new Set([...survivor.manualPhotoPaths, ...absorbed.manualPhotoPaths]));
        survivor.confirmedPhotoPaths = Array.from(new Set([
            ...survivor.confirmedPhotoPaths,
            ...absorbed.confirmedPhotoPaths,
        ]));
        survivor.rejectedPhotoPaths = Array.from(new Set([...survivor.rejectedPhotoPaths, ...absorbed.rejectedPhotoPaths]));
        for (const faceId of absorbed.faceIds) {
            const face = this.faces.get(faceId);
            if (!face)
                continue;
            face.personIds = Array.from(new Set([
                ...face.personIds.filter((personId) => personId !== absorbed.id),
                survivor.id,
            ]));
        }
        this.state.people = this.state.people.filter((person) => person.id !== absorbed.id);
        this.updateCentroid(survivor);
    }
    normalized(values) {
        const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
        return values.map((value) => value / length);
    }
    boxOverlap(first, second) {
        const left = Math.max(first.x, second.x);
        const top = Math.max(first.y, second.y);
        const right = Math.min(first.x + first.width, second.x + second.width);
        const bottom = Math.min(first.y + first.height, second.y + second.height);
        const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
        const union = first.width * first.height + second.width * second.height - intersection;
        return union > 0 ? intersection / union : 0;
    }
    summarizePerson(person) {
        const faces = person.faceIds
            .map((id) => this.faces.get(id))
            .filter((face) => Boolean(face));
        const photos = this.photoPathsOf(person);
        const confirmed = new Set(person.confirmedPhotoPaths);
        const ownerBanned = person.status === "banned";
        const reviewable = photos.filter((photoPath) => !this.hiddenPhoto(photoPath, ownerBanned));
        const confirmedCount = reviewable.filter((photoPath) => confirmed.has(photoPath)).length;
        const selectedCoverPhotoPath = person.selectedCoverPhotoPath &&
            reviewable.includes(person.selectedCoverPhotoPath)
            ? person.selectedCoverPhotoPath
            : null;
        const coverFace = faces
            .filter((face) => !person.rejectedPhotoPaths.includes(face.imagePath) &&
            !this.hiddenPhoto(face.imagePath, ownerBanned))
            .sort((first, second) => Number(second.imagePath === selectedCoverPhotoPath) -
            Number(first.imagePath === selectedCoverPhotoPath) ||
            second.score - first.score ||
            second.box.width * second.box.height -
                first.box.width * first.box.height)[0];
        return {
            id: person.id,
            name: person.name,
            faceCount: faces.length,
            photoCount: photos.length,
            coverCropUrl: selectedCoverPhotoPath &&
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
            fullyConfirmed: reviewable.length > 0 && confirmedCount === reviewable.length,
            status: person.status ?? "unconfirmed",
            suggestedCount: this.suggestedFacesOf(person).length,
            trainedAt: person.trainedAt ?? null,
        };
    }
    photoPathsOf(person) {
        const rejected = new Set(person.rejectedPhotoPaths);
        const photos = new Set(person.manualPhotoPaths);
        for (const faceId of person.faceIds) {
            const face = this.faces.get(faceId);
            if (face)
                photos.add(face.imagePath);
        }
        return Array.from(photos).filter((photoPath) => !rejected.has(photoPath) && !this.missingPhotos.has(photoPath));
    }
    suggestedFacesOf(person) {
        const owned = new Set(this.photoPathsOf(person));
        const rejected = new Set(person.rejectedPhotoPaths);
        return (person.suggestedFaceIds ?? [])
            .map((faceId) => this.faces.get(faceId))
            .filter((face) => Boolean(face) &&
            !this.isFaceDeleted(face) &&
            !owned.has(face.imagePath) &&
            !rejected.has(face.imagePath));
    }
    requireFullyConfirmed(personId) {
        const person = this.requirePerson(personId);
        const summary = this.summarizePerson(person);
        if (!summary.fullyConfirmed)
            throw new Error(`Confirm all ${summary.reviewableCount.toLocaleString()} photos of ${person.name} first (${summary.confirmedCount.toLocaleString()} confirmed).`);
        return person;
    }
    indexFace(face) {
        face.cropPath = this.rebaseCropPath(face.cropPath);
        if (!this.baseFaceBoxes.has(face.id)) {
            this.baseFaceBoxes.set(face.id, { ...face.box });
            this.baseFaceCrops.set(face.id, face.cropPath);
        }
        const edit = this.state.faceEdits?.[face.id];
        if (edit?.box)
            face.box = { ...edit.box };
        if (edit?.cropPath)
            face.cropPath = this.rebaseCropPath(edit.cropPath);
        this.faces.set(face.id, face);
        const list = this.facesByImage.get(face.imagePath) ?? [];
        list.push(face);
        this.facesByImage.set(face.imagePath, list);
    }
    replaceImageFaces(imagePath, records) {
        const nextIds = new Set(records.map((face) => face.id));
        for (const oldFace of this.facesByImage.get(imagePath) ?? []) {
            if (nextIds.has(oldFace.id))
                continue;
            this.faces.delete(oldFace.id);
            this.baseFaceBoxes.delete(oldFace.id);
            this.baseFaceCrops.delete(oldFace.id);
            for (const person of this.state.people) {
                person.faceIds = person.faceIds.filter((id) => id !== oldFace.id);
                person.suggestedFaceIds = (person.suggestedFaceIds ?? []).filter((id) => id !== oldFace.id);
                this.updateCentroid(person);
            }
        }
        this.facesByImage.set(imagePath, []);
        for (const face of records)
            this.indexFace(face);
    }
    isFaceDeleted(face) {
        const edit = this.state.faceEdits?.[face.id];
        return Boolean(edit?.deleted || (face.manual && !edit?.created));
    }
    /** Descriptors of faces the user has verified as this person, sampled to keep matching fast. */
    exemplarsOf(person) {
        const confirmed = new Set(person.confirmedPhotoPaths);
        const rejected = new Set(person.rejectedPhotoPaths);
        const faces = [];
        const covered = new Set();
        for (const faceId of person.faceIds) {
            const face = this.faces.get(faceId);
            if (!face ||
                this.isFaceDeleted(face) ||
                !confirmed.has(face.imagePath) ||
                rejected.has(face.imagePath))
                continue;
            faces.push(face);
            covered.add(face.imagePath);
        }
        // Manually added photos have no assigned face; use it only when the photo has exactly one face.
        for (const imagePath of person.manualPhotoPaths) {
            if (covered.has(imagePath) || !confirmed.has(imagePath))
                continue;
            const imageFaces = this.facesByImage.get(imagePath) ?? [];
            const activeFaces = imageFaces.filter((face) => !this.isFaceDeleted(face));
            if (activeFaces.length === 1 && activeFaces[0].descriptor.length > 0)
                faces.push(activeFaces[0]);
        }
        faces.sort((first, second) => second.score - first.score);
        if (faces.length <= MAX_EXEMPLARS)
            return faces.map((face) => face.descriptor);
        const stride = faces.length / MAX_EXEMPLARS;
        return Array.from({ length: MAX_EXEMPLARS }, (_, index) => faces[Math.floor(index * stride)].descriptor);
    }
    /** Best face per image within `maxDistance` of any exemplar; yields periodically to keep the main process responsive. */
    async matchFaces(exemplars, maxDistance, skip) {
        const best = new Map();
        if (exemplars.length === 0)
            return best;
        let checked = 0;
        for (const face of this.faces.values()) {
            if (++checked % 2000 === 0)
                await new Promise((resolve) => setImmediate(resolve));
            if (skip(face) ||
                this.isFaceDeleted(face) ||
                face.descriptor.length === 0)
                continue;
            let nearest = Infinity;
            for (const exemplar of exemplars) {
                const distance = this.distance(face.descriptor, exemplar);
                if (distance < nearest)
                    nearest = distance;
                if (nearest <= maxDistance * 0.6)
                    break;
            }
            if (nearest > maxDistance)
                continue;
            const current = best.get(face.imagePath);
            if (!current || nearest < current.distance)
                best.set(face.imagePath, { face, distance: nearest });
        }
        return best;
    }
    async refreshSuggestions(person) {
        const owned = new Set(this.photoPathsOf(person));
        const rejected = new Set(person.rejectedPhotoPaths);
        const otherKnown = new Set(this.state.people
            .filter((item) => item.id !== person.id && item.status)
            .map((item) => item.id));
        const matches = await this.matchFaces(this.exemplarsOf(person), TRAINED_MATCH_DISTANCE, (face) => owned.has(face.imagePath) ||
            rejected.has(face.imagePath) ||
            face.personIds.some((personId) => otherKnown.has(personId)));
        person.suggestedFaceIds = Array.from(matches.values())
            .sort((first, second) => first.distance - second.distance)
            .map(({ face }) => face.id);
    }
    async refreshBannedPhotos() {
        const next = new Set();
        for (const person of this.state.people) {
            const banned = this.state.bannedFaces?.[person.id];
            if (person.status !== "banned" || !banned)
                continue;
            const photos = this.photoPathsOf(person);
            photos.forEach((photoPath) => next.add(photoPath));
            const rejected = new Set(person.rejectedPhotoPaths);
            // Confidence 0-100 maps to a match distance of 0.60 (loose) to 0.35 (strict).
            const maxDistance = 0.6 - (banned.confidence / 100) * 0.25;
            const matches = await this.matchFaces(this.exemplarsOf(person), maxDistance, (face) => next.has(face.imagePath) || rejected.has(face.imagePath));
            matches.forEach((_match, imagePath) => next.add(imagePath));
        }
        const added = Array.from(next).filter((photoPath) => !this.bannedPhotoPaths.has(photoPath));
        const removed = Array.from(this.bannedPhotoPaths).filter((photoPath) => !next.has(photoPath));
        this.bannedPhotoPaths = next;
        this.state.bannedPhotoPaths = Array.from(next);
        if (added.length > 0 || removed.length > 0)
            this.recognitionListener({ added, removed });
    }
    /** Re-runs matching for every confirmed and banned person (after indexing finds new faces). */
    refreshRecognition() {
        return this.queueRecognition(async () => {
            for (const person of this.state.people)
                if (person.status === "confirmed" && person.trainedAt)
                    await this.refreshSuggestions(person);
            await this.refreshBannedPhotos();
        });
    }
    queueRecognition(task) {
        const run = this.recognitionChain.then(task);
        this.recognitionChain = run.catch(() => undefined);
        return run;
    }
    updateCentroid(person) {
        const descriptors = person.faceIds
            .map((id) => this.faces.get(id)?.descriptor)
            .filter((item) => Boolean(item?.length));
        if (!descriptors.length) {
            if (!person.manual)
                person.centroid = [];
            return;
        }
        person.centroid = new Array(descriptors[0].length).fill(0);
        for (const descriptor of descriptors) {
            for (let index = 0; index < descriptor.length; index += 1)
                person.centroid[index] += descriptor[index];
        }
        for (let index = 0; index < person.centroid.length; index += 1)
            person.centroid[index] /= descriptors.length;
    }
    distance(first, second) {
        let sum = 0;
        for (let index = 0; index < first.length; index += 1) {
            const difference = first[index] - second[index];
            sum += difference * difference;
        }
        return Math.sqrt(sum);
    }
    signature(image) {
        return `${image.size}:${image.modified}`;
    }
    newId(seed) {
        return (0, crypto_1.createHash)("sha1")
            .update(`${seed}:${Date.now()}:${Math.random()}`)
            .digest("hex")
            .slice(0, 20);
    }
    // Crops are served by file name from the active storage root, so stored paths
    // stay valid after the index is moved (e.g. to an external drive).
    cropUrl(cropPath) {
        return `face-crop://local/${encodeURIComponent(path.basename(cropPath))}`;
    }
    rebaseCropPath(cropPath) {
        return path.join(this.cropsDirectory, path.basename(cropPath));
    }
    requirePerson(personId) {
        const person = this.state.people.find((item) => item.id === personId);
        if (!person)
            throw new Error("Person not found.");
        return person;
    }
    emitProgress() {
        this.onProgress({ ...this.progress });
    }
    async updateProgress(update, persist) {
        this.progress = { ...this.progress, ...update };
        this.emitProgress();
        if (persist)
            await this.persistProgress();
    }
    async persistProgress() {
        const temporary = `${this.progressPath}.tmp`;
        await fsPromises.writeFile(temporary, JSON.stringify(this.progress, null, 2));
        await fsPromises.rename(temporary, this.progressPath);
    }
    persistState() {
        this.photoPeopleCache = null;
        const data = JSON.stringify(this.state);
        const write = this.stateWriteChain.then(async () => {
            const temporary = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
            try {
                await fsPromises.writeFile(temporary, data);
                await fsPromises.rename(temporary, this.statePath);
            }
            finally {
                await fsPromises.rm(temporary, { force: true });
            }
        });
        this.stateWriteChain = write.catch(() => undefined);
        return write;
    }
}
exports.FaceIndexer = FaceIndexer;
