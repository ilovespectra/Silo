const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const sharp = require("sharp");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const { IndexingRecovery } = require("../src/indexingRecovery.ts");
const { ThumbnailPregenerator } = require("../src/thumbnailPregenerator.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

async function createImage(filePath, color) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({
    create: { width: 24, height: 18, channels: 3, background: color },
  })
    .jpeg()
    .toFile(filePath);
}

async function run() {
  const tempRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "silo-thumbnail-pregen-"),
  );
  const sourceRoot = path.join(tempRoot, "source");
  const cacheRoot = path.join(tempRoot, "thumbnail-cache");
  const imagePaths = [
    path.join(sourceRoot, "one.jpg"),
    path.join(sourceRoot, "nested", "two.jpg"),
    path.join(sourceRoot, "nested", "three.jpg"),
  ];
  await createImage(imagePaths[0], "red");
  await createImage(imagePaths[1], "green");
  await createImage(imagePaths[2], "blue");
  await fsPromises.writeFile(path.join(sourceRoot, "notes.txt"), "not media");

  let renderCount = 0;
  let generationCalls = 0;
  let gateNextImage = false;
  let releaseGate;
  let signalGateStarted;
  let gateStarted = new Promise((resolve) => {
    signalGateStarted = resolve;
  });
  let gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  const pregen = new ThumbnailPregenerator({
    getSourceRoots: async () => [sourceRoot, sourceRoot],
    isMedia: (fileName) => /\.(?:jpe?g|png|gif|webp|tiff?|bmp|heic|avif|mp4|mov|m4v|webm)$/i.test(fileName),
    isRemotePath: (sourcePath) => sourcePath.startsWith("remote:"),
    listRemoteMediaFiles: async (_sourcePath, isCancelled) =>
      (isCancelled() ? [] : []),
    generate: async (filePath) => {
      generationCalls += 1;
      if (gateNextImage && path.basename(filePath) === "four.jpg") {
        signalGateStarted?.();
        await gate;
      } else if (generationCalls <= 2) {
        if (generationCalls === 2) signalGateStarted?.();
        await gate;
      }
      const stats = await fsPromises.stat(filePath);
      const cacheFile = path.join(
        cacheRoot,
        `${path.basename(filePath)}-${stats.size}-${stats.mtimeMs}.jpg`,
      );
      try {
        await fsPromises.access(cacheFile);
        return true;
      } catch {
        await fsPromises.mkdir(cacheRoot, { recursive: true });
        await sharp(filePath)
          .resize({ width: 200, height: 200, fit: "inside" })
          .jpeg()
          .toFile(cacheFile);
        renderCount += 1;
        return true;
      }
    },
    isInteractiveBusy: () => false,
    getIndexingWaitMessage: () => null,
    onProgress: () => undefined,
  });
  const recovery = new IndexingRecovery([
    {
      id: "thumbnails",
      lane: "disk",
      needsInitialCheck: true,
      progress: () => pregen.getProgress(),
      ready: () => true,
      start: () => pregen.start(),
      pause: () => pregen.pause(),
      resume: () => pregen.resume(),
    },
  ]);

  try {
    await recovery.tick();
    await waitUntil(() => generationCalls >= 2, "thumbnail workers did not start");
    const shared = pregen.start();
    assert.equal(pregen.start(), shared, "concurrent start requests share one run");

    const pause = recovery.pauseStage("thumbnails");
    await delay(20);
    releaseGate?.();
    await pause;
    await waitUntil(
      () => !recovery.details("thumbnails").recoveryRunning,
      "scheduler did not release the paused thumbnail stage",
    );
    assert.equal(pregen.getProgress().status, "paused");
    assert.equal(generationCalls, 2, "pause stops before another file is scheduled");
    assert.equal(recovery.details("thumbnails").userPaused, true);

    await recovery.retry("thumbnails");
    await waitUntil(
      () => pregen.getProgress().status === "complete" && !recovery.details("thumbnails").recoveryRunning,
      "thumbnail recovery did not resume to completion",
    );
    assert.equal(pregen.getProgress().total, 3, "duplicate roots are scanned once");
    assert.equal(pregen.getProgress().processed, 3);
    assert.equal(pregen.getProgress().generated, 3);
    assert.equal(pregen.getProgress().failed, 0);
    assert.equal(renderCount, 3, "the fixture's photos were really rendered");
    for (const imagePath of imagePaths) {
      const stats = await fsPromises.stat(imagePath);
      await fsPromises.access(
        path.join(cacheRoot, `${path.basename(imagePath)}-${stats.size}-${stats.mtimeMs}.jpg`),
      );
    }

    await recovery.restart("thumbnails");
    await waitUntil(
      () => recovery.details("thumbnails").recoveryRunning,
      "manual restart did not enter the recovery scheduler",
    );
    await waitUntil(
      () => pregen.getProgress().status === "complete" && !recovery.details("thumbnails").recoveryRunning,
      "manual restart did not complete",
    );
    assert.equal(renderCount, 3, "restart reuses cached thumbnails without rerendering");

    const fourth = path.join(sourceRoot, "four.jpg");
    await createImage(fourth, "yellow");
    gateNextImage = true;
    gateStarted = new Promise((resolve) => {
      signalGateStarted = resolve;
    });
    gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    await recovery.retry("thumbnails");
    await waitUntil(() => generationCalls >= 7, "new-source thumbnail pass did not begin");
    await gateStarted;
    const restart = recovery.restart("thumbnails");
    await delay(20);
    releaseGate?.();
    await restart;
    await waitUntil(
      () => pregen.getProgress().status === "complete" && !recovery.details("thumbnails").recoveryRunning,
      "active-stage restart did not drain and resume safely",
    );
    assert.equal(pregen.getProgress().total, 4);
    assert.equal(pregen.getProgress().processed, 4);
    assert.equal(renderCount, 4, "active restart does not render cached files twice");

    recovery.stop();
    await pregen.cancel();
    assert.equal(pregen.getProgress().status, "paused", "shutdown cancellation is resumable");
    console.log("✓ thumbnail generation scans, pauses, resumes, restarts, and reuses real cache output");
  } finally {
    recovery.stop();
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
