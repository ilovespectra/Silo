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

async function checkFacePreparationCheckpoint() {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "face-preparation-test-"),
  );
  try {
    const images = Array.from({ length: 40 }, (_, index) => ({
      name: `photo-${index}.jpg`,
      path: `/photos/photo-${index}.jpg`,
      relativePath: `photo-${index}.jpg`,
      size: 100_000 + index,
      modified: index,
      isDirectory: false,
      type: "image",
      extension: "jpg",
    }));
    let pacedBatches = 0;
    let pacingStoppedForPause = false;
    const governor = {
      setPaceLimitPercent: () => undefined,
      enterLane: () => () => undefined,
      paceAfterWork: async (
        _workMs: number,
        _shouldYield: () => boolean,
        shouldStop: () => boolean,
      ) => {
        pacedBatches += 1;
        pacingStoppedForPause = shouldStop();
      },
    };
    const indexer = new FaceIndexer(
      directory,
      directory,
      directory,
      () => images,
      () => undefined,
      directory,
      5,
      () => false,
      undefined,
      governor as any,
    );
    await indexer.initialize();

    const classifierBatches: string[][] = [];
    let announceFirstBatch!: () => void;
    let releaseFirstBatch!: () => void;
    const firstBatchStarted = new Promise<void>((resolve) => {
      announceFirstBatch = resolve;
    });
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    indexer.setPeoplePhotoClassifier(async (batch) => {
      classifierBatches.push(batch.map((image) => image.path));
      if (classifierBatches.length === 1) {
        announceFirstBatch();
        await firstBatchGate;
      }
      return new Set<string>();
    });

    (indexer as any).loadRuntime = async () => ({ faceapi: {}, sharp: {} });
    (indexer as any).processImage = async (image: (typeof images)[number]) => {
      (indexer as any).processedSignatures.set(
        image.path,
        `${image.size}:${image.modified}`,
      );
    };
    (indexer as any).combineSimilarClusters = async () => 0;
    (indexer as any).refreshRecognition = async () => undefined;

    const firstRun = indexer.start();
    await firstBatchStarted;
    const pause = indexer.pause();
    releaseFirstBatch();
    await pause;
    await firstRun;

    assert.equal(classifierBatches.length, 1);
    assert.equal(classifierBatches[0].length, 32);
    assert.equal(pacedBatches, 1, "each classification batch enters the shared duty governor");
    assert.equal(pacingStoppedForPause, true, "a scheduler pause interrupts the throttle wait");
    assert.equal(indexer.getProgress().status, "paused");
    assert.match(indexer.getProgress().message, /paused while preparing photos/i);

    const resumedIndexer = new FaceIndexer(
      directory,
      directory,
      directory,
      () => images,
      () => undefined,
    );
    await resumedIndexer.initialize();
    const resumedBatches: string[][] = [];
    resumedIndexer.setPeoplePhotoClassifier(async (batch) => {
      resumedBatches.push(batch.map((image) => image.path));
      return new Set<string>();
    });
    (resumedIndexer as any).loadRuntime = async () => ({ faceapi: {}, sharp: {} });
    (resumedIndexer as any).processImage = async (image: (typeof images)[number]) => {
      (resumedIndexer as any).processedSignatures.set(
        image.path,
        `${image.size}:${image.modified}`,
      );
    };
    (resumedIndexer as any).combineSimilarClusters = async () => 0;
    (resumedIndexer as any).refreshRecognition = async () => undefined;

    await resumedIndexer.start();
    assert.deepStrictEqual(
      classifierBatches.map((batch) => batch.length),
      [32],
      "the interrupted process completed only its first bounded classifier batch",
    );
    assert.deepStrictEqual(
      resumedBatches.map((batch) => batch.length),
      [8],
      "a fresh indexer resumes from durable per-photo classification checkpoints",
    );
    assert.equal(
      new Set([...classifierBatches, ...resumedBatches].flat()).size,
      40,
    );
    assert.equal(resumedIndexer.getProgress().status, "complete");
    assert.equal(resumedIndexer.getProgress().processed, 40);
    assert.equal(resumedIndexer.getProgress().remaining, 0);
    assert.equal(resumedIndexer.getProgress().preparationProcessed, 40);
    assert.equal(
      await fsPromises.stat(path.join(directory, "face-index", "photo-classification.jsonl")).then(() => true, () => false),
      false,
      "completed face work removes its temporary classification journal",
    );
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

async function checkLargeFaceQueueResumeWithinProcess() {
  const directory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "face-queue-resume-test-"),
  );
  try {
    const images = Array.from({ length: 600 }, (_, index) => ({
      name: `queue-photo-${index}.jpg`,
      path: `/photos/queue-photo-${index}.jpg`,
      relativePath: `queue-photo-${index}.jpg`,
      size: 120_000 + index,
      modified: index,
      isDirectory: false,
      type: "image",
      extension: "jpg",
    }));
    let providerCalls = 0;
    let classifierCalls = 0;
    let pauseDuringQueue: Promise<void> | null = null;
    const processedPaths: string[] = [];
    const governor = {
      setPaceLimitPercent: () => undefined,
      enterLane: () => () => undefined,
      paceAfterWork: async () => undefined,
    };
    let indexer!: FaceIndexer;
    indexer = new FaceIndexer(
      directory,
      directory,
      directory,
      () => {
        providerCalls += 1;
        return images;
      },
      (progress) => {
        if (
          !pauseDuringQueue &&
          progress.phase === "building-queue" &&
          progress.message.includes("256 of")
        )
          pauseDuringQueue = indexer.pause();
      },
      directory,
      5,
      () => false,
      undefined,
      governor as any,
    );
    await indexer.initialize();
    indexer.setPeoplePhotoClassifier(async () => {
      classifierCalls += 1;
      return new Set<string>();
    });
    (indexer as any).loadRuntime = async () => ({ faceapi: {}, sharp: {} });
    (indexer as any).processImage = async (image: (typeof images)[number]) => {
      processedPaths.push(image.path);
      (indexer as any).processedSignatures.set(
        image.path,
        `${image.size}:${image.modified}`,
      );
    };
    (indexer as any).combineSimilarClusters = async () => 0;
    (indexer as any).refreshRecognition = async () => undefined;

    await indexer.start();
    assert.ok(pauseDuringQueue, "large queue construction should be pausable");
    await pauseDuringQueue;
    assert.equal(indexer.getProgress().status, "paused");
    assert.equal(
      (indexer as any).preparation.pendingBuildCursor,
      256,
      "the queue cursor is retained at the cooperative pause boundary",
    );

    await indexer.start();
    assert.equal(providerCalls, 1, "resume reuses the current source snapshot");
    assert.equal(classifierCalls, 19, "resume does not classify the same queue again");
    assert.equal(processedPaths.length, images.length);
    assert.equal(new Set(processedPaths).size, images.length);
    assert.equal(indexer.getProgress().status, "complete");
    assert.equal(indexer.getProgress().processed, images.length);
    assert.equal(indexer.getProgress().remaining, 0);
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  await checkFaceInferenceThreadLimit();
  await checkFaceJournalRecovery();
  await checkFacePreparationCheckpoint();
  await checkLargeFaceQueueResumeWithinProcess();
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
    (indexer as any).state.people = [cluster("8", [editable.id], closeA)];

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

    await indexer.recordEdit("Move face box", () =>
      indexer.updateFaceBox(editable.id, {
        x: 0.4,
        y: 0.3,
        width: 0.25,
        height: 0.25,
      }),
    );
    assert.equal(indexer.getFacesForImage(editable.imagePath)[0].box.x, 0.4);
    assert.equal(await indexer.undo(), "Move face box");
    assert.equal(indexer.getFacesForImage(editable.imagePath)[0].box.x, 0.12);
    assert.equal(await indexer.redo(), "Move face box");
    assert.equal(indexer.getFacesForImage(editable.imagePath)[0].box.x, 0.4);

    await indexer.recordEdit("Delete detected face", () =>
      indexer.deleteFace(editable.id),
    );
    assert.equal(indexer.getFacesForImage(editable.imagePath).length, 0);
    assert.equal(await indexer.undo(), "Delete detected face");
    assert.equal(indexer.getFacesForImage(editable.imagePath).length, 1);
    assert.equal(await indexer.redo(), "Delete detected face");
    assert.equal(indexer.getFacesForImage(editable.imagePath).length, 0);

    console.log("Face clustering tests passed");
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
