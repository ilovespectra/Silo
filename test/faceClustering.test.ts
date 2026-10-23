import assert = require("assert");
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { FaceIndexer, FaceRecord, PersonCluster } from "../src/faceIndexer";

function descriptor(first: number, second: number): number[] {
  const values = new Array(128).fill(0);
  values[0] = first;
  values[1] = second;
  const length = Math.sqrt(first * first + second * second) || 1;
  return values.map((value) => value / length);
}

function face(
  id: string,
  imagePath: string,
  values: number[],
  x = 0.1,
): FaceRecord {
  return {
    id,
    imagePath,
    signature: "1:1",
    box: { x, y: 0.1, width: 0.25, height: 0.25 },
    score: 0.9,
    descriptor: values,
    cropPath: `/tmp/${id}.jpg`,
    personIds: [],
  };
}

function cluster(
  id: string,
  faceIds: string[],
  values: number[],
  manual = false,
  name?: string,
): PersonCluster {
  const clusterName = name ?? `Person ${id}`;
  return {
    id,
    name: clusterName,
    nameSource:
      !manual && /^Person \d+$/.test(clusterName) ? "automatic" : "user",
    faceIds,
    manualPhotoPaths: [],
    confirmedPhotoPaths: [],
    rejectedPhotoPaths: [],
    centroid: values,
    createdAt: 1,
    manual,
  };
}

async function setup() {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "face-cluster-test-"),
  );
  const indexer = new FaceIndexer(
    directory,
    directory,
    directory,
    () => [],
    () => undefined,
  );
  await indexer.initialize();
  return { directory, indexer };
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function checkManualFaceRecognitionRunsInBackground() {
  const { directory, indexer } = await setup();
  try {
    const sharp = require("sharp");
    const imagePath = path.join(directory, "manual-face-source.jpg");
    await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: { r: 120, g: 150, b: 180 },
      },
    })
      .jpeg()
      .toFile(imagePath);

    let releaseOldDescriptor!: () => void;
    let startedOldDescriptor!: () => void;
    let startedLatestDescriptor!: () => void;
    const oldDescriptorStarted = new Promise<void>(
      (resolve) => (startedOldDescriptor = resolve),
    );
    const latestDescriptorStarted = new Promise<void>(
      (resolve) => (startedLatestDescriptor = resolve),
    );
    const oldDescriptorGate = new Promise<void>(
      (resolve) => (releaseOldDescriptor = resolve),
    );
    (indexer as any).descriptorForFaceBox = async (
      _localPath: string,
      box: FaceRecord["box"],
    ) => {
      if (box.x < 0.2) {
        startedOldDescriptor();
        await oldDescriptorGate;
        return { descriptor: descriptor(1, 0), score: 0.91 };
      }
      startedLatestDescriptor();
      return { descriptor: descriptor(0, 1), score: 0.97 };
    };

    const createdFaces = await indexer.createFaceBox(imagePath, imagePath, {
      x: 0.1,
      y: 0.1,
      width: 0.25,
      height: 0.25,
    });
    const created = createdFaces[0];
    assert.equal(created.descriptorStatus, "pending");
    await oldDescriptorStarted;
    assert.equal(
      indexer.getFacesForImage(imagePath)[0].descriptorStatus,
      "pending",
      "saving a manual face must return while recognition runs",
    );

    await indexer.updateFaceBox(
      created.id,
      { x: 0.4, y: 0.3, width: 0.25, height: 0.25 },
      imagePath,
    );
    releaseOldDescriptor();
    await latestDescriptorStarted;
    await waitFor(
      () => indexer.getFacesForImage(imagePath)[0]?.descriptorStatus === "ready",
      "the updated face box should receive its own recognition descriptor",
    );
    const updated = indexer.getFacesForImage(imagePath)[0];
    assert.equal(updated.box.x, 0.4);
    assert.deepStrictEqual(
      (indexer as any).faces.get(created.id).descriptor,
      descriptor(0, 1),
      "a delayed result for the old box must never overwrite the current box",
    );

    await indexer.assignFaces([{ faceId: created.id, newName: "Test Person" }]);
    const person = (indexer as any).state.people.find(
      (item: PersonCluster) => item.name === "Test Person",
    ) as PersonCluster;
    let releaseTraining!: () => void;
    let trainingStarted!: () => void;
    const trainingGate = new Promise<void>((resolve) => (releaseTraining = resolve));
    const trainingStartedPromise = new Promise<void>(
      (resolve) => (trainingStarted = resolve),
    );
    (indexer as any).refreshSuggestions = async () => {
      trainingStarted();
      await trainingGate;
    };
    const recognitionEvents: string[][] = [];
    indexer.setRecognitionProgressListener((personIds) =>
      recognitionEvents.push(personIds),
    );
    const trainingDetail = await Promise.race([
      indexer.trainPerson(person.id),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Training IPC waited for recognition")), 500),
      ),
    ]);
    assert.equal(trainingDetail.recognitionPending, true);
    await trainingStartedPromise;
    releaseTraining();
    await waitFor(
      () =>
        !indexer.getPerson(person.id)?.recognitionPending &&
        recognitionEvents.some((personIds) => personIds.includes(person.id)),
      "background recognition should clear its pending state and notify the UI",
    );

    const additionalPath = path.join(directory, "manual-assignment-refresh.jpg");
    await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: { r: 180, g: 130, b: 100 },
      },
    })
      .jpeg()
      .toFile(additionalPath);
    const additionalFace = (
      await indexer.createFaceBox(additionalPath, additionalPath, {
        x: 0.2,
        y: 0.2,
        width: 0.25,
        height: 0.25,
      })
    )[0];
    await waitFor(
      () =>
        indexer.getFacesForImage(additionalPath)[0]?.descriptorStatus ===
        "ready",
      "the second manual face descriptor should finish before assignment",
    );

    let releaseAssignmentRefresh!: () => void;
    let signalAssignmentRefreshStarted!: () => void;
    const assignmentRefreshGate = new Promise<void>(
      (resolve) => (releaseAssignmentRefresh = resolve),
    );
    const assignmentRefreshStarted = new Promise<void>(
      (resolve) => (signalAssignmentRefreshStarted = resolve),
    );
    (indexer as any).refreshSuggestions = async () => {
      signalAssignmentRefreshStarted();
      await assignmentRefreshGate;
    };
    person.status = "confirmed";
    person.trainedAt = Date.now();
    const assignmentResult = await Promise.race([
      indexer.assignFaces([
        { faceId: additionalFace.id, personId: person.id },
      ]),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Manual assignment waited for retraining")),
          500,
        ),
      ),
    ]);
    assert.equal(assignmentResult[0].id, person.id);
    assert.equal(
      indexer.getPerson(person.id)?.recognitionPending,
      true,
      "assignment to a trained person persists a pending background refresh",
    );
    await assignmentRefreshStarted;
    releaseAssignmentRefresh();
    await waitFor(
      () => !indexer.getPerson(person.id)?.recognitionPending,
      "manual assignment refresh completes in the background",
    );

    const reopened = new FaceIndexer(
      directory,
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await reopened.initialize();
    assert.equal(
      reopened.getFacesForImage(imagePath)[0]?.descriptorStatus,
      "ready",
      "the completed descriptor must survive app restart",
    );

    const failureIndexer = new FaceIndexer(
      path.join(directory, "failure-case"),
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await failureIndexer.initialize();
    (failureIndexer as any).descriptorForFaceBox = async () => {
      throw new Error("synthetic model failure");
    };
    const failedFaces = await failureIndexer.createFaceBox(
      imagePath,
      imagePath,
      { x: 0.55, y: 0.1, width: 0.25, height: 0.25 },
    );
    await waitFor(
      () =>
        failureIndexer.getFacesForImage(imagePath).some(
          (face) => face.id === failedFaces[failedFaces.length - 1]?.id && face.descriptorStatus === "unavailable",
        ),
      "failed recognition should become unavailable instead of staying pending forever",
    );
    await (failureIndexer as any).faceDescriptorChain;
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

async function checkFaceRedetectionGuards() {
  const { directory, indexer } = await setup();
  try {
    const dismissedPath = "/library/dismissed-face.jpg";
    const dismissed = face("dismissed-original", dismissedPath, descriptor(1, 0), 0.2);
    dismissed.signature = "100:200";
    (indexer as any).indexFace(dismissed);
    await indexer.deleteFace(dismissed.id);

    const reopened = new FaceIndexer(
      directory,
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await reopened.initialize();
    const jitteredRedetection = face(
      "dismissed-redetected",
      dismissedPath,
      descriptor(1, 0),
      0.207,
    );
    jitteredRedetection.signature = dismissed.signature;
    (reopened as any).replaceImageFaces(dismissedPath, [jitteredRedetection]);
    assert.equal(
      reopened.getFacesForImage(dismissedPath).length,
      0,
      "a saved dismissal must suppress a jittered redetection after restart",
    );

    const changedFile = face(
      "changed-file-face",
      dismissedPath,
      descriptor(1, 0),
      0.207,
    );
    changedFile.signature = "101:201";
    (reopened as any).replaceImageFaces(dismissedPath, [changedFile]);
    assert.equal(
      reopened.getFacesForImage(dismissedPath).length,
      1,
      "changing the image signature must permit fresh detections",
    );

    const duplicatePath = "/library/duplicate-boxes.jpg";
    const weaker = face("duplicate-weaker", duplicatePath, descriptor(0, 1), 0.1);
    const stronger = face("duplicate-stronger", duplicatePath, descriptor(0, 1), 0.105);
    weaker.score = 0.72;
    stronger.score = 0.96;
    (reopened as any).replaceImageFaces(duplicatePath, [weaker, stronger]);
    assert.deepStrictEqual(
      reopened.getFacesForImage(duplicatePath).map((item) => item.id),
      [stronger.id],
      "near-identical detector boxes should keep the higher-confidence face",
    );

    const groupPath = "/library/two-faces.jpg";
    const left = face("group-left", groupPath, descriptor(1, 0), 0.05);
    const right = face("group-right", groupPath, descriptor(0, 1), 0.66);
    (reopened as any).replaceImageFaces(groupPath, [left, right]);
    assert.equal(
      reopened.getFacesForImage(groupPath).length,
      2,
      "distinct faces in the same group photo must remain separate",
    );

    const manual = face("manual-region", groupPath, descriptor(0, 1), 0.06);
    manual.manual = true;
    (reopened as any).state.faceEdits[manual.id] = { created: true };
    const overlappingDetection = face(
      "overlapping-detection",
      groupPath,
      descriptor(1, 0),
      0.065,
    );
    const secondGroupFace = face(
      "separate-detection",
      groupPath,
      descriptor(0, 1),
      0.68,
    );
    (reopened as any).replaceImageFaces(groupPath, [
      manual,
      overlappingDetection,
      secondGroupFace,
    ]);
    assert.deepStrictEqual(
      reopened.getFacesForImage(groupPath).map((item) => item.id).sort(),
      [manual.id, secondGroupFace.id].sort(),
      "manual face boxes must prevent a duplicate detector box without hiding another group member",
    );

    const personWithAnotherFace = cluster(
      "confirmed-group-member",
      [manual.id, secondGroupFace.id],
      descriptor(1, 0),
      true,
      "Confirmed person",
    );
    personWithAnotherFace.confirmedPhotoPaths.push(groupPath);
    manual.personIds = [personWithAnotherFace.id];
    secondGroupFace.personIds = [personWithAnotherFace.id];
    (reopened as any).state.people = [personWithAnotherFace];
    await reopened.deleteFace(manual.id);
    assert(
      personWithAnotherFace.confirmedPhotoPaths.includes(groupPath),
      "deleting one face must retain confirmation while another face for that person remains in the photo",
    );

    const onlyFacePath = "/library/only-face.jpg";
    const onlyFace = face("only-confirmed-face", onlyFacePath, descriptor(1, 0));
    (reopened as any).replaceImageFaces(onlyFacePath, [onlyFace]);
    const onlyFacePerson = cluster(
      "only-face-person",
      [onlyFace.id],
      descriptor(1, 0),
      true,
      "Another person",
    );
    onlyFacePerson.confirmedPhotoPaths.push(onlyFacePath);
    onlyFace.personIds = [onlyFacePerson.id];
    (reopened as any).state.people.push(onlyFacePerson);
    await reopened.deleteFace(onlyFace.id);
    assert(
      !onlyFacePerson.confirmedPhotoPaths.includes(onlyFacePath),
      "deleting a person's sole face must clear that person's explicit photo confirmation",
    );
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}


async function checkFaceInferenceThreadLimit() {
  const Module = require("module") as any;
  const originalLoad = Module._load;
  const calls: string[] = [];
  const faceapi = {
    tf: {
      setBackend: async (backend: string) => calls.push(`backend:${backend}`),
      ready: async () => calls.push("ready"),
    },
    nets: {
      tinyFaceDetector: { loadFromDisk: async () => calls.push("detector") },
      faceLandmark68Net: { loadFromDisk: async () => calls.push("landmarks") },
      faceRecognitionNet: { loadFromDisk: async () => calls.push("recognition") },
    },
  };
  const wasm = {
    setThreadsCount: (count: number) => calls.push(`threads:${count}`),
    setWasmPaths: () => calls.push("wasm-paths"),
  };
  const sharp = Object.assign(() => undefined, {
    concurrency: (count: number) => calls.push(`sharp:${count}`),
  });
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "@vladmandic/face-api/dist/face-api.node-wasm.js") return faceapi;
    if (request === "@tensorflow/tfjs-backend-wasm") return wasm;
    if (request === "sharp") return sharp;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const indexer = new FaceIndexer("/unused", "/models", "/wasm", () => [], () => undefined);
    await (indexer as any).loadRuntime();
    assert.deepStrictEqual(calls.slice(0, 5), [
      "sharp:1",
      "threads:1",
      "wasm-paths",
      "backend:wasm",
      "ready",
    ]);
  } finally {
    Module._load = originalLoad;
  }
}

async function checkFaceJournalRecovery() {
  const { directory } = await setup();
  try {
    const faceDirectory = path.join(directory, "face-index");
    const statePath = path.join(faceDirectory, "people.json");
    const recordsPath = path.join(faceDirectory, "faces.jsonl");
    const recoveredFace = face(
      "recovered-face",
      "/photos/recovered.jpg",
      descriptor(1, 0),
    );
    recoveredFace.personIds = ["recovered-person"];
    const newPerson = cluster(
      "recovered-person",
      [],
      descriptor(1, 0),
      false,
      "Person 17",
    );

    await fsPromises.appendFile(
      recordsPath,
      `${JSON.stringify({
        imagePath: recoveredFace.imagePath,
        signature: recoveredFace.signature,
        faces: [recoveredFace],
        createdPeople: [newPerson],
      })}\n`,
    );

    const recoveredIndexer = new FaceIndexer(
      directory,
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await recoveredIndexer.initialize();
    const recoveredState = JSON.parse(await fsPromises.readFile(statePath, "utf8"));
    assert.equal(recoveredState.faceRecordVersion, 1);
    assert.equal(recoveredState.people.length, 1);
    assert.equal(recoveredState.people[0].name, "Person 17");
    assert.deepStrictEqual(recoveredState.people[0].faceIds, ["recovered-face"]);

    const reopenedIndexer = new FaceIndexer(
      directory,
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await reopenedIndexer.initialize();
    const reopenedState = (reopenedIndexer as any).state;
    assert.equal(reopenedState.people.length, 1);
    assert.deepStrictEqual(reopenedState.people[0].faceIds, ["recovered-face"]);
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

async function checkMovedFaceBoxSurvivesRestart() {
  const { directory, indexer } = await setup();
  try {
    const imagePath = "/photos/moved-box.jpg";
    const moved = face("moved-box-face", imagePath, descriptor(1, 0), 0.1);
    const person = cluster("moved-box-person", [moved.id], descriptor(1, 0));
    moved.personIds = [person.id];
    (indexer as any).state.people = [person];
    const image = {
      name: "moved-box.jpg",
      path: imagePath,
      relativePath: imagePath,
      size: 1,
      modified: 1,
      isDirectory: false,
      type: "image",
      extension: ".jpg",
    };
    await (indexer as any).appendProcessed(image, [moved], false);
    await (indexer as any).persistState();
    const peopleCheckpoint = await fsPromises.readFile(
      path.join(directory, "face-index", "people.json"),
      "utf8",
    );

    const expected = { x: 0.42, y: 0.31, width: 0.25, height: 0.25 };
    await indexer.recordEdit(
      "Move face box",
      () => indexer.updateFaceBox(moved.id, expected),
      {
        faceIds: [moved.id],
        trackPeople: false,
        trackBannedFaces: false,
      },
    );
    assert.deepStrictEqual(indexer.getFacesForImage(imagePath)[0].box, expected);
    assert.equal(
      await fsPromises.readFile(
        path.join(directory, "face-index", "people.json"),
        "utf8",
      ),
      peopleCheckpoint,
      "a box move should append a small edit record without rewriting the People checkpoint",
    );
    const movedBeforeUndo = new FaceIndexer(
      directory,
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await movedBeforeUndo.initialize();
    assert.deepStrictEqual(
      movedBeforeUndo.getFacesForImage(imagePath)[0].box,
      expected,
      "a moved square must replay from the edit journal before any checkpoint",
    );
    const moveStep = (indexer as any).undoStack.at(-1);
    assert.equal(
      moveStep.before.size,
      0,
      "moving a box must not serialize whole People clusters",
    );
    assert.deepEqual(moveStep.recomputePersonIds, [person.id]);
    assert.equal(await indexer.undo(), "Move face box");
    assert.equal(indexer.getFacesForImage(imagePath)[0].box.x, 0.1);
    assert.equal(
      indexer.getFacesForImage(imagePath)[0].hasDescriptor,
      true,
      "undo restores the recognition vector invalidated by moving the box",
    );
    assert.deepEqual(
      (indexer as any).state.people[0].centroid,
      descriptor(1, 0),
    );

    const reopened = new FaceIndexer(
      directory,
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await reopened.initialize();
    assert.deepStrictEqual(
      reopened.getFacesForImage(imagePath)[0].box,
      { x: 0.1, y: 0.1, width: 0.25, height: 0.25 },
      "undo of a moved square survives reopening the face index",
    );
    assert.equal(
      reopened.getFacesForImage(imagePath)[0].hasDescriptor,
      true,
      "undo persists the prior face descriptor across restart",
    );
    assert.equal(await indexer.redo(), "Move face box");
    const redone = new FaceIndexer(
      directory,
      directory,
      directory,
      () => [],
      () => undefined,
    );
    await redone.initialize();
    assert.deepStrictEqual(
      redone.getFacesForImage(imagePath)[0].box,
      expected,
      "redo of a moved square also survives reopening the face index",
    );
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

async function checkRecognitionProducerYieldsAndKeepsSuggestions() {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "face-recognition-producer-test-"),
  );
  let activeSearch = false;
  const indexer = new FaceIndexer(
    directory,
    directory,
    directory,
    () => [],
    () => undefined,
    directory,
    100,
    () => activeSearch,
  );
  try {
    await indexer.initialize();
    const owned = face(
      "producer-owned",
      "/photos/producer-owned.jpg",
      descriptor(1, 0),
    );
    const oldSuggestion = face(
      "producer-old-suggestion",
      "/photos/producer-old-suggestion.jpg",
      descriptor(0.99, 0.1),
    );
    const newDistantCandidate = face(
      "producer-new-distant",
      "/photos/producer-new-distant.jpg",
      descriptor(-1, 0),
    );
    for (const item of [owned, oldSuggestion, newDistantCandidate])
      (indexer as any).indexFace(item);
    const person = cluster(
      "producer-person",
      [owned.id],
      descriptor(1, 0),
      false,
      "Producer Person",
    );
    person.status = "confirmed";
    person.trainedAt = 1;
    person.confirmedPhotoPaths = [owned.imagePath];
    person.suggestedFaceIds = [oldSuggestion.id];
    (indexer as any).state.people = [person];

    await (indexer as any).refreshSuggestions(
      person,
      new Set([newDistantCandidate.id]),
    );
    assert.deepEqual(
      person.suggestedFaceIds,
      [oldSuggestion.id],
      "an incremental candidate pass must keep older valid suggestions",
    );

    let releaseRecognition!: () => void;
    let startedRecognition!: () => void;
    const recognitionGate = new Promise<void>(
      (resolve) => (releaseRecognition = resolve),
    );
    const recognitionStarted = new Promise<void>(
      (resolve) => (startedRecognition = resolve),
    );
    (indexer as any).refreshSuggestions = async () => {
      startedRecognition();
      await recognitionGate;
    };
    activeSearch = true;
    person.recognitionPending = true;
    await indexer.start([]);
    assert.equal(indexer.getProgress().status, "complete");

    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(
      indexer.getPerson(person.id)?.recognitionPending,
      true,
      "recognition must stay queued while an interactive search is active",
    );
    activeSearch = false;
    await recognitionStarted;
    assert.equal(
      indexer.getProgress().status,
      "complete",
      "the face scan should finish before its recognition refresh completes",
    );
    releaseRecognition();
    await waitFor(
      () => !indexer.getPerson(person.id)?.recognitionPending,
      "the queued recognition pass should finish after the search ends",
    );
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

async function checkRecognitionWaitsForFaceScanStartup() {
  const { directory, indexer } = await setup();
  try {
    let releaseImages!: (images: any[]) => void;
    const imagesReady = new Promise<any[]>((resolve) => {
      releaseImages = resolve;
    });
    (indexer as any).getIndexedImages = () => imagesReady;
    const sourceFace = face(
      "scan-start-source",
      "/library/scan-start-source.jpg",
      descriptor(1, 0),
    );
    (indexer as any).indexFace(sourceFace);
    const person = cluster(
      "scan-start-person",
      [sourceFace.id],
      sourceFace.descriptor,
      true,
      "Scan Start Person",
    );
    person.status = "confirmed";
    person.trainedAt = 1;
    person.recognitionPending = true;
    (indexer as any).state.people = [person];

    let recognitionStarted = false;
    (indexer as any).refreshSuggestions = async () => {
      recognitionStarted = true;
    };
    const scan = indexer.start();
    (indexer as any).requestRecognitionReindex([person.id]);
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(
      recognitionStarted,
      false,
      "recognition waits while the face scan is still loading its image list",
    );

    releaseImages([]);
    await scan;
    await waitFor(
      () => recognitionStarted,
      "recognition starts after the face scan has settled",
    );
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  await checkFaceInferenceThreadLimit();
  await checkManualFaceRecognitionRunsInBackground();
  await checkFaceRedetectionGuards();
  await checkFaceJournalRecovery();
  await checkMovedFaceBoxSurvivesRestart();
  await checkRecognitionProducerYieldsAndKeepsSuggestions();
  await checkRecognitionWaitsForFaceScanStartup();
  const { directory, indexer } = await setup();
  try {
    const closeA = descriptor(1, 0);
    const closeB = descriptor(0.94, 0.34);
    const far = descriptor(0, 1);
    const faces = (indexer as any).faces as Map<string, FaceRecord>;
    faces.set("a", face("a", "/photos/a.jpg", closeA));
    faces.set("b", face("b", "/photos/b.jpg", closeB));
    faces.set("c", face("c", "/photos/c.jpg", far));
    const first = cluster("1", ["a"], closeA);
    const second = cluster("2", ["b"], closeB);
    const third = cluster("3", ["c"], far);
    (indexer as any).state.people = [first, second, third];

    const combined = await (indexer as any).combineSimilarClusters();
    assert.equal(
      combined,
      1,
      "close mutual-nearest automatic clusters should merge",
    );
    assert.equal((indexer as any).state.people.length, 2);
    assert.ok(first.faceIds.includes("a") && first.faceIds.includes("b"));
    assert.ok(faces.get("b")!.personIds.includes(first.id));
    assert.ok(
      (indexer as any).state.people.some(
        (person: PersonCluster) => person.id === third.id,
      ),
    );

    const manualFace = face("manual-face", "/photos/manual.jpg", closeA);
    const autoFace = face("auto-face", "/photos/auto.jpg", closeB);
    faces.clear();
    faces.set(manualFace.id, manualFace);
    faces.set(autoFace.id, autoFace);
    (indexer as any).state.people = [
      cluster("4", [manualFace.id], closeA, true, "Named person"),
      cluster("5", [autoFace.id], closeB),
    ];
    assert.equal(
      await (indexer as any).combineSimilarClusters(),
      0,
      "manual clusters must be protected",
    );

    const sameImageA = face("same-a", "/photos/group.jpg", closeA, 0.05);
    const sameImageB = face("same-b", "/photos/group.jpg", closeB, 0.65);
    faces.clear();
    faces.set(sameImageA.id, sameImageA);
    faces.set(sameImageB.id, sameImageB);
    (indexer as any).state.people = [
      cluster("6", [sameImageA.id], closeA),
      cluster("7", [sameImageB.id], closeB),
    ];
    assert.equal(
      await (indexer as any).combineSimilarClusters(),
      0,
      "different faces in one photo must not merge",
    );

    const editable = face("editable", "/photos/editable.jpg", closeA, 0.12);
    faces.clear();
    (indexer as any).facesByImage.clear();
    (indexer as any).baseFaceBoxes.clear();
    (indexer as any).indexFace(editable);
    const editablePerson = cluster("8", [editable.id], closeA);
    editable.personIds = [editablePerson.id];
    (indexer as any).state.people = [editablePerson];

    const cover = await indexer.setSelectedCoverPhoto("8", editable.imagePath);
    assert.equal(
      cover?.selectedCoverPhotoPath,
      editable.imagePath,
      "unconfirmed detected photos can be used as profile pictures",
    );
    await assert.rejects(
      indexer.setSelectedCoverPhoto("8", "/photos/unrelated.jpg"),
      /not in this person's collection/,
    );
    const clearedCover = await indexer.setSelectedCoverPhoto("8", null);
    assert.equal(clearedCover?.selectedCoverPhotoPath, null);

    await indexer.recordEdit(
      "Move face box",
      () =>
        indexer.updateFaceBox(editable.id, {
          x: 0.4,
          y: 0.3,
          width: 0.25,
          height: 0.25,
        }),
      {
        faceIds: [editable.id],
        trackPeople: false,
        trackBannedFaces: false,
      },
    );
    assert.equal(indexer.getFacesForImage(editable.imagePath)[0].box.x, 0.4);
    assert.equal(await indexer.undo(), "Move face box");
    assert.equal(indexer.getFacesForImage(editable.imagePath)[0].box.x, 0.12);
    assert.equal(await indexer.redo(), "Move face box");
    assert.equal(indexer.getFacesForImage(editable.imagePath)[0].box.x, 0.4);

    await indexer.recordEdit(
      "Delete detected face",
      () => indexer.deleteFace(editable.id),
      { faceIds: [editable.id], trackBannedFaces: false },
    );
    assert.equal(indexer.getFacesForImage(editable.imagePath).length, 0);
    assert.equal(await indexer.undo(), "Delete detected face");
    assert.equal(indexer.getFacesForImage(editable.imagePath).length, 1);
    assert.equal(await indexer.redo(), "Delete detected face");
    assert.equal(indexer.getFacesForImage(editable.imagePath).length, 0);

    const groupPath = "/photos/group-memory.jpg";
    const groupFaceA = face("group-face-a", groupPath, closeA, 0.08);
    const groupFaceB = face("group-face-b", groupPath, closeB, 0.62);
    faces.clear();
    (indexer as any).facesByImage.clear();
    (indexer as any).baseFaceBoxes.clear();
    (indexer as any).baseFaceCrops.clear();
    (indexer as any).indexFace(groupFaceA);
    (indexer as any).indexFace(groupFaceB);
    const automaticA = cluster("automatic-a", [groupFaceA.id], closeA, false, "Person 10");
    const automaticB = cluster("automatic-b", [groupFaceB.id], closeB, false, "Person 11");
    groupFaceA.personIds = [automaticA.id];
    groupFaceB.personIds = [automaticB.id];
    const untouched = cluster("untouched", [], far, false, "Person 99");
    (indexer as any).state.people = [automaticA, automaticB, untouched];
    const changedSummaries = await indexer.assignFaces([
      { faceId: groupFaceA.id, newName: "Alice Example" },
      { faceId: groupFaceB.id, newName: "Bob Example" },
    ]);
    assert.deepEqual(
      changedSummaries.map((person) => person.name).sort(),
      ["Alice Example", "Bob Example"],
      "manual assignment returns summaries only for the newly changed named clusters",
    );
    const namedAlice = (indexer as any).state.people.find(
      (person: PersonCluster) => person.name === "Alice Example",
    ) as PersonCluster;
    const namedBob = (indexer as any).state.people.find(
      (person: PersonCluster) => person.name === "Bob Example",
    ) as PersonCluster;
    assert(automaticA.faceIds.includes(groupFaceA.id), "naming a face must retain its automatic cluster membership");
    assert(automaticB.faceIds.includes(groupFaceB.id), "naming another face must retain its automatic cluster membership");
    assert(namedAlice.faceIds.includes(groupFaceA.id) && namedBob.faceIds.includes(groupFaceB.id));
    assert(namedAlice.confirmedPhotoPaths.includes(groupPath), "an explicit assignment confirms the photo for Alice");
    assert(namedBob.confirmedPhotoPaths.includes(groupPath), "an explicit assignment confirms the photo for Bob");
    assert.deepEqual(
      indexer.getFacesForImage(groupPath).map((item) => item.personIds).sort((a, b) => a[0].localeCompare(b[0])),
      [[automaticA.id, namedAlice.id], [automaticB.id, namedBob.id]].sort((a, b) => a[0].localeCompare(b[0])),
      "the group photo is duplicated into both named clusters without moving either face out of its automatic cluster",
    );
    await indexer.assignFaces([
      { faceId: groupFaceA.id, newName: "Alice Alternate" },
    ]);
    const alternateAlice = (indexer as any).state.people.find(
      (person: PersonCluster) => person.name === "Alice Alternate",
    ) as PersonCluster;
    assert(namedAlice.faceIds.includes(groupFaceA.id));
    assert(alternateAlice.faceIds.includes(groupFaceA.id));
    assert(
      groupFaceA.personIds.includes(namedAlice.id) &&
        groupFaceA.personIds.includes(alternateAlice.id),
      "assigning a face to another named person adds membership without moving it",
    );

    const addedPath = "/photos/added-to-person.jpg";
    const addedFace = face("added-face", addedPath, far);
    (indexer as any).facesByImage.clear();
    (indexer as any).baseFaceBoxes.clear();
    (indexer as any).baseFaceCrops.clear();
    (indexer as any).indexFace(addedFace);
    const automaticAdded = cluster("automatic-added", [addedFace.id], far, false, "Person 12");
    (indexer as any).state.people = [automaticAdded];
    const created = await indexer.createPerson("Carol Example");
    const carol = (indexer as any).state.people.find(
      (person: PersonCluster) => person.name === "Carol Example",
    ) as PersonCluster;
    assert(created.some((person: any) => person.id === carol.id));
    await indexer.addPhotosToPerson({ personId: carol.id }, [addedPath]);
    assert(automaticAdded.faceIds.includes(addedFace.id), "adding an existing photo to a person must not remove its prior face-cluster membership");
    assert(carol.faceIds.includes(addedFace.id));
    assert(carol.confirmedPhotoPaths.includes(addedPath));

    console.log("Face clustering tests passed");
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
