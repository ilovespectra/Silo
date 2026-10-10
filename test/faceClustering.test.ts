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
  return {
    id,
    name: name ?? `Person ${id}`,
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

async function run() {
  await checkFaceInferenceThreadLimit();
  await checkFaceJournalRecovery();
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
