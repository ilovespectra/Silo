const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { fork, spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
function waitForWorkerResponse(responses, id) {
  return new Promise((resolve) => {
    const onResponse = (response) => {
      if (response?.id !== id) return;
      responses.removeListener("response", onResponse);
      resolve(response);
    };
    responses.on("response", onResponse);
  });
}
function loadSource(name, overrides = {}, globals = {}) {
  const filename = path.join(root, "src", name);
  const sourceRequire = createRequire(filename);
  const mockedRequire = (moduleName) => {
    overrides.beforeRequire?.(moduleName);
    return (
      overrides[moduleName] ??
      (moduleName.startsWith("./") &&
      fs.existsSync(path.join(root, "src", `${moduleName.slice(2)}.ts`))
        ? loadSource(`${moduleName.slice(2)}.ts`)
        : sourceRequire(moduleName))
    );
  };
  mockedRequire.resolve = (moduleName) =>
    overrides.resolve?.(moduleName) ?? sourceRequire.resolve(moduleName);
  const exports = {};
  const context = vm.createContext({
    exports,
    module: { exports },
    __dirname: path.join(root, "electron-dist"),
    require: mockedRequire,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    ...globals,
  });
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInContext(output, context, { filename });
  return exports;
}

function makeIndexer(
  t,
  {
    fakeTimers = false,
    userDataPath,
    scanSource = async () => {},
    setImmediateImpl = setImmediate,
  } = {},
) {
  const ownsUserDataPath = !userDataPath;
  if (!userDataPath) {
    userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "semantic-worker-test-"),
    );
  }
  const children = [],
    diagnostics = [],
    timers = [];
  const { SemanticIndexer, confidenceSettingToMinimumThreshold } = loadSource(
    "semanticIndexer.ts",
    {
      child_process: {
        ...require("node:child_process"),
        fork: (filename, args, options) => {
          assert.equal(
            filename,
            path.join(root, "electron-dist", "semanticWorker.js"),
          );
          assert.equal(options.execPath, process.execPath);
          assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
          assert.equal(options.env.OMP_NUM_THREADS, "2");
          assert.equal(options.env.SEMANTIC_MODEL_CACHE_PATH, "offline-cache");
          assert.equal(options.execArgv.length, 0);
          const child = fork(
            path.join(__dirname, "fixtures", "semanticChild.cjs"),
            args,
            options,
          );
          assert.notEqual(child.pid, process.pid);
          children.push(child);
          return child;
        },
      },
    },
    fakeTimers
      ? {
          setTimeout: (callback, ms) => {
            assert.ok(ms === 90_000 || ms === 250);
            const timer = { callback, cleared: false, ms };
            timers.push(timer);
            return timer;
          },
          clearTimeout: (timer) => {
            timer.cleared = true;
          },
          setImmediate: setImmediateImpl,
        }
      : { setImmediate: setImmediateImpl },
  );
  const indexer = new SemanticIndexer(
    userDataPath,
    "offline-cache",
    scanSource,
    () => {},
    (event, details) => diagnostics.push({ event, details }),
  );
  t.after(async () => {
    const activeChildren = children.filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    const exits = activeChildren.map(
      (child) => new Promise((resolve) => child.once("exit", resolve)),
    );
    for (const child of activeChildren) child.kill("SIGKILL");
    await Promise.all(exits);
    await indexer.runPromise?.catch(() => undefined);
    await indexer.flushVectorSearch();
    await indexer.flushWrites();
    if (ownsUserDataPath)
      fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  return {
    indexer,
    children,
    confidenceSettingToMinimumThreshold,
    diagnostics,
    timers,
    userDataPath,
  };
}

if (
  process.env.SILO_REAL_SEMANTIC_SMOKE === "1" ||
  process.env.SILO_REAL_SEMANTIC_SMOKE_LOCAL === "1"
) {
  test("bundled offline model indexes a batch and finds the known document", async (t) => {
    if (process.env.SILO_REAL_SEMANTIC_SMOKE === "1") {
      assert.equal(process.platform, "win32");
      assert.equal(process.arch, "x64");
    }
    const modelCachePath = path.join(root, ".model-test-cache");
    const requiredModels = [
      path.join(
        modelCachePath,
        "Xenova",
        "clip-vit-base-patch32",
        "onnx",
        "text_model_quantized.onnx",
      ),
      path.join(
        modelCachePath,
        "Xenova",
        "clip-vit-base-patch32",
        "onnx",
        "vision_model_quantized.onnx",
      ),
      path.join(
        modelCachePath,
        "Xenova",
        "clip-vit-base-patch32",
        "tokenizer.json",
      ),
    ];
    for (const modelPath of requiredModels)
      assert.ok(fs.existsSync(modelPath), `Missing bundled model: ${modelPath}`);

    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "semantic-real-search-index-"),
    );
    const sourcePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "semantic-real-search-source-"),
    );
    let indexer;
    t.after(async () => {
      if (indexer?.embeddingWorker) {
        const child = indexer.embeddingWorker;
        const exited =
          child.exitCode === null && child.signalCode === null
            ? new Promise((resolve) => child.once("exit", resolve))
            : Promise.resolve();
        indexer.failEmbeddingWorker(child, new Error("Test cleanup"));
        await exited;
      }
      await indexer?.runPromise?.catch(() => undefined);
      await indexer?.flushVectorSearch();
      await indexer?.flushWrites();
      fs.rmSync(sourcePath, { recursive: true, force: true });
      fs.rmSync(userDataPath, { recursive: true, force: true });
    });

    const svg = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
        <rect width="256" height="256" fill="#91d8f2"/>
        <circle cx="205" cy="48" r="23" fill="#ffd66b"/>
        <path d="M0 173 Q44 157 86 173 T172 173 T256 173 V256 H0Z" fill="#358cc4"/>
        <path d="M0 204 Q44 188 86 204 T172 204 T256 204 V256 H0Z" fill="#17699f"/>
        <path d="M127 48 L127 174 L54 174Z" fill="#fffdf1"/>
        <path d="M137 78 L137 174 L204 174Z" fill="#f7f1da"/>
        <path d="M43 178 Q128 195 215 178 L199 198 H60Z" fill="#8b4f34"/>
        <path d="M128 39 V179" stroke="#65452e" stroke-width="5"/>
      </svg>
    `);
    const imagePath = path.join(sourcePath, "sailboat.png");
    await require("sharp")(svg).png().toFile(imagePath);

    const targetPath = path.join(sourcePath, "sailboat-notes.txt");
    const controlPaths = [
      path.join(sourcePath, "garden-notes.txt"),
      path.join(sourcePath, "winter-dog-notes.txt"),
    ];
    fs.writeFileSync(
      targetPath,
      "A sailboat on calm blue water, with its white sail visible beneath a clear sky.",
    );
    fs.writeFileSync(
      controlPaths[0],
      "A bowl of fresh apples and oranges on a kitchen table.",
    );
    fs.writeFileSync(
      controlPaths[1],
      "A dog running through deep snow during a winter storm.",
    );

    const { SemanticIndexer } = loadSource("semanticIndexer.ts");
    indexer = new SemanticIndexer(
      userDataPath,
      modelCachePath,
      async () => {},
      () => {},
    );
    await indexer.initialize();
    const batch = [imagePath, targetPath, ...controlPaths];
    await indexer.start(
      [sourcePath],
      new Map(batch.map((filePath) => [filePath, sourcePath])),
    );
    assert.equal(
      indexer.getProgress().status,
      "complete",
      indexer.getProgress().message,
    );
    assert.equal(indexer.latestRecords.size, batch.length);

    const imageVectors = await indexer.getImageVectors([imagePath]);
    assert.ok(imageVectors.has(imagePath), "the image received a stored embedding");
    assert.ok(
      Array.from(imageVectors.get(imagePath)).every(Number.isFinite),
      "the stored image embedding is finite",
    );

    await indexer.prepareVectorSearch(() => {});
    const results = await indexer.search(
      "a sailboat on calm blue water",
      23,
      [sourcePath],
    );
    assert.ok(results.length > 0, "semantic search returned a match");
    assert.equal(
      results[0].path,
      targetPath,
      `Expected the sailboat note first; got ${results
        .slice(0, 3)
        .map((result) => `${path.basename(result.path)} (${result.confidence.toFixed(1)})`)
        .join(", ")}`,
    );
    assert.ok(results[0].confidence >= 23);
  });
}

test("real child IPC preserves embedding APIs; native-style death rejects all pending and allows explicit retry", async (t) => {
  const { indexer, children, diagnostics } = makeIndexer(t);
  const runtime = await indexer.loadClipRuntime();
  const vector = await indexer.embedText("ordinary text", runtime);
  assert.equal(vector.length, 512);
  assert.equal(vector[0], 1);
  assert.equal(
    (await indexer.embedImageFile("/private/photo.jpg", runtime)).length,
    512,
  );
  const child = children[0];
  const exited = once(child, "exit");
  const pending = indexer.requestWorkerEmbedding(
    "text",
    { text: "hold" },
    child,
  );
  const crashing = indexer.requestWorkerEmbedding(
    "text",
    { text: "crash" },
    child,
  );
  const results = await Promise.allSettled([pending, crashing]);
  assert.ok(results.every((result) => result.status === "rejected"));
  await exited;
  assert.equal(indexer.embeddingRequests.size, 0);
  assert.equal(indexer.clipRuntime, null);
  assert.equal(indexer.clipRuntimePromise, null);
  assert.equal(children.length, 1, "no automatic restart");
  await assert.rejects(
    indexer.embedText("stale runtime", runtime),
    /unavailable/,
  );
  await assert.rejects(
    indexer.embedImage("/private/photo.jpg", runtime),
    /unavailable/,
  );
  assert.equal(
    children.length,
    1,
    "no macOS conversion retry after child death",
  );
  const exit = diagnostics.find(
    (entry) => entry.event === "semantic-worker-exit",
  );
  assert.equal(
    exit.details.signal,
    process.platform === "win32" ? null : "SIGKILL",
  );
  assert.equal(
    exit.details.code,
    process.platform === "win32" ? 1 : null,
  );
  assert.equal(exit.details.pendingCount, 2);
  assert.deepEqual(Array.from(exit.details.requestTypes), ["text"]);
  assert.ok(!JSON.stringify(diagnostics).includes("/private/"));
  const recovered = await indexer.loadClipRuntime();
  assert.equal(children.length, 2);
  assert.equal((await indexer.embedText("retry", recovered)).length, 512);
  // Delayed callbacks from the old process must not invalidate the new one.
  child.emit("exit", 1, null);
  assert.equal(indexer.embeddingWorker, children[1]);
  assert.equal(indexer.clipRuntime, recovered);
});

test("90-second slow-request warning preserves the pending request and worker", async (t) => {
  const { indexer, children, timers, diagnostics } = makeIndexer(t, {
    fakeTimers: true,
  });
  const runtime = await indexer.loadClipRuntime();
  assert.ok(timers[0].cleared);
  const pending = indexer.requestWorkerEmbedding(
    "text",
    { text: "hold" },
    runtime.child,
  );
  const outcome = pending.then(
    (values) => ({ values }),
    (error) => ({ error }),
  );
  timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(indexer.embeddingRequests.size, 1);
  assert.equal(children[0].exitCode, null);
  assert.equal(children[0].signalCode, null);
  assert.equal(indexer.clipRuntime, runtime);
  assert.equal(children.length, 1);
  assert.ok(
    diagnostics.some((entry) => entry.event === "semantic-worker-slow-request"),
  );

  children[0].send({ text: "release-held" });
  const result = await outcome;
  assert.equal(result.error, undefined);
  assert.equal(result.values.length, 512);
  assert.equal(indexer.embeddingRequests.size, 0);
  assert.ok(timers.every((timer) => timer.cleared));
});

test("malformed vectors retire the child instead of corrupting the index", async (t) => {
  const { indexer, children } = makeIndexer(t);
  const runtime = await indexer.loadClipRuntime();
  await assert.rejects(
    indexer.embedText("malformed", runtime),
    /Invalid semantic embedding response/,
  );
  assert.equal(indexer.embeddingRequests.size, 0);
  assert.equal(indexer.clipRuntime, null);
  assert.equal(children.length, 1);
});

test("indexing stops on child death, preserves stored vectors, and retains remaining work without queued retries", async (t) => {
  const { indexer, children, userDataPath } = makeIndexer(t);
  await indexer.initialize();
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-isolation-test-"),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const files = Array.from({ length: 251 }, (_, i) => {
    const filePath = path.join(temp, `${i}.txt`);
    fs.writeFileSync(filePath, "test");
    return filePath;
  });
  const priorRecord = { path: files[0], vectorOffset: 0, signature: "prior" };
  indexer.latestRecords.set(files[0], priorRecord);
  const sentinelPath = path.join(temp, "vectors.bin");
  const sentinel = Buffer.alloc(512 * 4, 7);
  fs.writeFileSync(sentinelPath, sentinel);
  indexer.vectorsPath = sentinelPath;
  indexer.persistProgress = async () => {};
  indexer.extractText = async () => "crash";
  indexer.appendFailure = async () =>
    assert.fail("A dead process must not write a file failure");
  indexer.appendRecord = async () =>
    assert.fail("No vector should be committed");
  await indexer.start([temp], new Map(files.map((file) => [file, temp])));
  assert.equal(indexer.getProgress().status, "error");
  assert.equal(
    children.length,
    1,
    "queued batches must not restart a dead process",
  );
  assert.equal(indexer.queuedSourcePaths, null);
  assert.equal(
    indexer.filesToIndex.size,
    files.length,
    "all interrupted and queued work remains available",
  );
  assert.equal(indexer.latestRecords.get(files[0]), priorRecord);
  assert.deepEqual(fs.readFileSync(sentinelPath), sentinel);
  const saved = JSON.parse(
    fs.readFileSync(
      path.join(userDataPath, "semantic-index", "pending-work.json"),
    ),
  );
  assert.equal(saved.entries.length, files.length);
  const { indexer: restarted } = makeIndexer(t, { userDataPath });
  await restarted.initialize();
  assert.equal(restarted.filesToIndex.size, files.length);
  assert.ok(restarted.restoredSourcePaths.includes(temp));
  await restarted.start([]);
  assert.equal(restarted.getIndexedFiles([temp]).length, files.length);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, "semantic-index", "pending-work.json"),
      ),
    ).entries.length,
    0,
  );
});

test("runtime construction and preload failures checkpoint all pending files and the batch remainder", async (t) => {
  for (const kind of ["construction", "preload"]) {
    const { indexer, userDataPath } = makeIndexer(t);
    await indexer.initialize();
    const sourcePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "semantic-startup-source-"),
    );
    t.after(() => fs.rmSync(sourcePath, { recursive: true, force: true }));
    const files = Array.from({ length: 251 }, (_, i) => {
      const file = path.join(sourcePath, `${i}.jpg`);
      fs.writeFileSync(file, "original");
      return file;
    });
    if (kind === "construction")
      indexer.ensureEmbeddingWorker = () => {
        throw new Error("constructor failed");
      };
    else
      indexer.loadClipRuntime = async () => {
        throw new Error("ONNX initialization failed");
      };
    indexer.appendFailure = async () =>
      assert.fail("Startup failure must not poison a file");
    await indexer.start(
      [sourcePath],
      new Map(files.map((file) => [file, sourcePath])),
    );
    assert.equal(indexer.getProgress().status, "error");
    assert.equal(indexer.getProgress().remaining, 251);
    assert.equal(indexer.queuedSourcePaths, null);
    assert.equal(indexer.filesToIndex.size, 251);
    assert.equal(indexer.workerFailures.size, 0);
    const { indexer: restarted } = makeIndexer(t, { userDataPath });
    await restarted.initialize();
    assert.equal(restarted.filesToIndex.size, 251);
    assert.ok(
      files.every((file) => restarted.filesToIndex.get(file) === sourcePath),
    );
  }
});

test("three native image crashes persist across restarts, quarantine only unchanged image, and preserve originals", async (t) => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-trap-test-"),
  );
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const sourcePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-trap-source-"),
  );
  t.after(() => fs.rmSync(sourcePath, { recursive: true, force: true }));
  const trap = path.join(sourcePath, "trap.heic");
  const good = path.join(sourcePath, "good.jpg");
  fs.writeFileSync(trap, "original trap image");
  fs.writeFileSync(good, "original good image");
  const trapMtime = new Date(Date.now() - 10_000);
  fs.utimesSync(trap, trapMtime, trapMtime);
  const original = fs.readFileSync(trap);
  const originalStats = fs.statSync(trap);
  let indexer;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const made = makeIndexer(t, { userDataPath });
    indexer = made.indexer;
    await indexer.initialize();
    await indexer.start(
      [sourcePath],
      new Map([
        [trap, sourcePath],
        [good, sourcePath],
      ]),
    );
    assert.equal(made.children.length, 1, "no retries inside the run");
    assert.equal(indexer.getProgress().status, "error");
    assert.equal(indexer.filesToIndex.has(trap), attempt < 3);
    assert.ok(indexer.filesToIndex.has(good));
    assert.equal(indexer.latestRecords.has(trap), attempt === 3);
    const failures = JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, "semantic-index", "worker-failures.json"),
      ),
    );
    assert.equal(failures[0][1].attempts, attempt);
    assert.match(
      failures[0][1].message,
      process.platform === "win32" ? /exited \(1\)/ : /SIGTRAP/,
    );
    assert.ok(failures[0][1].timestamp > 0);
    const exit = made.diagnostics.find(
      (entry) => entry.event === "semantic-worker-exit",
    );
    assert.equal(
      exit.details.signal,
      process.platform === "win32" ? null : "SIGTRAP",
    );
    assert.equal(
      exit.details.code,
      process.platform === "win32" ? 1 : null,
    );
    assert.equal(exit.details.pendingCount, 1);
    assert.deepEqual(Array.from(exit.details.requestTypes), ["image"]);
    assert.ok(exit.details.stderr.length <= 2000);
    assert.ok(!JSON.stringify(made.diagnostics).includes("/private/"));
    // Keep the crashing file first for the next explicit attempt.
    if (attempt < 3) {
      const saved = JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, "semantic-index", "pending-work.json"),
        ),
      );
      assert.equal(saved.entries.length, 2);
    }
  }
  assert.match(indexer.latestRecords.get(trap).error, /repair or re-export/i);
  assert.match(indexer.getProgress().message, /Original preserved/);
  assert.deepEqual(fs.readFileSync(trap), original);
  assert.equal(fs.statSync(trap).mtimeMs, originalStats.mtimeMs);
  const scanSource = async (sourcePath, onFile) => {
    for (const filePath of [trap, good]) {
      const stats = fs.statSync(filePath);
      onFile({
        path: filePath,
        name: path.basename(filePath),
        relativePath: path.basename(filePath),
        size: stats.size,
        modified: stats.mtime.getTime(),
        isDirectory: false,
        type: "image",
        extension: path.extname(filePath),
      });
    }
  };
  const { indexer: restarted, children } = makeIndexer(t, {
    userDataPath,
    scanSource,
  });
  await restarted.initialize();
  await restarted.start([]);
  assert.equal(restarted.getIndexedImages([sourcePath]).length, 2);
  const changes = await restarted.reconcileIndex([sourcePath]);
  assert.equal(changes.has(trap), false, "unchanged HEIC must not be retried");
  assert.ok(
    restarted.latestRecords.has(trap),
    "quarantine failure is retained",
  );
  restarted.filesToIndex = null;
  await restarted.start([sourcePath]);
  assert.equal(
    children.length,
    1,
    "full scan skips the unchanged repeat-crashing image",
  );
  await restarted.start([sourcePath], new Map([[trap, sourcePath]]));
  assert.equal(
    children.length,
    1,
    "explicit unchanged incremental work is skipped",
  );
  fs.appendFileSync(trap, "modified");
  await restarted.start([sourcePath], new Map([[trap, sourcePath]]));
  assert.equal(
    restarted.workerFailures.get(trap).attempts,
    1,
    "changed signature resets attempts",
  );
  assert.equal(
    children.length,
    1,
    "existing healthy worker is reused, not automatically respawned",
  );
  assert.equal(
    restarted.clipRuntime,
    null,
    "changed image was retried and crashed the existing worker",
  );
});

test("disconnect without exit uses a bounded fallback instead of leaving work hung", async (t) => {
  const { indexer, children, timers } = makeIndexer(t, { fakeTimers: true });
  const runtime = await indexer.loadClipRuntime();
  const pending = indexer.requestWorkerEmbedding(
    "text",
    { text: "hold" },
    runtime.child,
  );
  const rejected = assert.rejects(
    pending,
    /disconnected without an exit report/,
  );
  const exited = once(children[0], "exit");
  children[0].emit("disconnect");
  const grace = timers.find((timer) => timer.ms === 250);
  assert.ok(grace);
  grace.callback();
  await rejected;
  await exited;
  assert.equal(indexer.embeddingRequests.size, 0);
  assert.equal(children.length, 1);
  assert.ok(timers.every((timer) => timer.cleared));
});

test("failed recovery writes retain work and late queued starts cannot restart a dead worker", async (t) => {
  const { indexer, userDataPath, children } = makeIndexer(t);
  await indexer.initialize();
  const sourcePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "semantic-recovery-source-"),
  );
  t.after(() => fs.rmSync(sourcePath, { recursive: true, force: true }));
  const trap = path.join(sourcePath, "trap.heic");
  const good = path.join(sourcePath, "good.jpg");
  const queuedRoot = path.join(sourcePath, "queued-root");
  fs.writeFileSync(trap, "unchanged");
  fs.writeFileSync(good, "unchanged");
  const trapMtime = new Date(Date.now() - 10_000);
  fs.utimesSync(trap, trapMtime, trapMtime);
  indexer.persistWorkerFailures = async () => {
    throw new Error("disk unavailable");
  };
  const checkpoint = indexer.checkpointPendingWork.bind(indexer);
  indexer.checkpointPendingWork = async (...args) => {
    void indexer.start([queuedRoot], new Map([[good, sourcePath]]));
    await checkpoint(...args);
  };
  await indexer.start(
    [sourcePath],
    new Map([
      [trap, sourcePath],
      [good, sourcePath],
    ]),
  );
  assert.equal(indexer.getProgress().status, "error");
  assert.equal(indexer.filesToIndex.size, 2);
  assert.equal(children.length, 1);
  assert.equal(indexer.latestRecords.size, 0);
  const saved = JSON.parse(
    fs.readFileSync(
      path.join(userDataPath, "semantic-index", "pending-work.json"),
    ),
  );
  assert.equal(saved.entries.length, 2);
  assert.ok(saved.sources.includes(queuedRoot));
});

test("worker labels constructor failures as infrastructure rather than file errors", async () => {
  const port = new EventEmitter();
  const responses = new EventEmitter();
  port.postMessage = (response) => responses.emit("response", response);
  loadSource("semanticWorker.ts", {
    worker_threads: {
      parentPort: port,
      workerData: { modelCachePath: "offline" },
    },
    "@huggingface/transformers": {
      env: {},
      AutoTokenizer: {
        from_pretrained: async () => {
          throw new Error("model constructor failed");
        },
      },
    },
  });
  const response = waitForWorkerResponse(responses, 1);
  port.emit("message", {
    id: 1,
    type: "image",
    filePath: "/private/original.jpg",
  });
  const failure = await response;
  assert.equal(failure.infrastructure, true);
  assert.match(failure.error, /initialization failed/);
});

test("Electron executable supports fork IPC with ELECTRON_RUN_AS_NODE and no model loading", async () => {
  const child = fork(
    path.join(__dirname, "fixtures", "semanticChild.cjs"),
    [],
    {
      execPath: require("electron"),
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMP_NUM_THREADS: "2" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  try {
    const response = once(child, "message");
    child.send({ id: 1, type: "preload" });
    assert.deepEqual((await response)[0], { id: 1, values: [] });
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
});

test("worker supports both transports, bounded raw decoding, and existing tokenizer/model options without downloads", async () => {
  for (const transport of ["child", "thread"]) {
    const port = new EventEmitter();
    const fakeProcess = new EventEmitter();
    fakeProcess.env = { SEMANTIC_MODEL_CACHE_PATH: "offline-cache" };
    fakeProcess.connected = true;
    fakeProcess.exit = () => {};
    const responses = new EventEmitter();
    fakeProcess.send = (response, callback) => {
      responses.emit("response", response);
      callback?.(null);
    };
    port.postMessage = (response) => responses.emit("response", response);
    let decoderOptions, tokenizerOptions, modelOptions, rawArguments;
    let pixels = 100;
    const decoder = {
      metadata: async () => ({ width: pixels, height: pixels }),
      rotate() {
        return this;
      },
      toColourspace() {
        return this;
      },
      removeAlpha() {
        return this;
      },
      raw() {
        return this;
      },
      toBuffer: async () => ({
        data: Buffer.from([1, 2, 3]),
        info: { width: 1, height: 1, channels: 3 },
      }),
    };
    const sharp = (_path, options) => {
      decoderOptions = options;
      return decoder;
    };
    sharp.concurrency = (threads) => assert.equal(threads, 2);
    const transformers = {
      env: {},
      AutoTokenizer: {
        from_pretrained: async () => (text, options) => {
          tokenizerOptions = options;
          assert.equal(text[0].length, 8000);
          return {};
        },
      },
      AutoProcessor: { from_pretrained: async () => async () => ({}) },
      CLIPTextModelWithProjection: {
        from_pretrained: async (_id, options) => {
          modelOptions = options;
          return async () => ({ text_embeds: { data: [1, 2] } });
        },
      },
      CLIPVisionModelWithProjection: {
        from_pretrained: async () => async () => ({
          image_embeds: { data: [3, 4] },
        }),
      },
      RawImage: class {
        constructor(...args) {
          rawArguments = args;
        }
        static read() {
          throw new Error("Encoded RawImage.read must not run");
        }
      },
    };
    loadSource(
      "semanticWorker.ts",
      {
        worker_threads: {
          parentPort: transport === "thread" ? port : null,
          workerData:
            transport === "thread" ? { modelCachePath: "thread-cache" } : null,
        },
        "@huggingface/transformers": transformers,
        sharp,
      },
      { process: fakeProcess },
    );
    const receiver = transport === "thread" ? port : fakeProcess;
    const send = async (request) => {
      const response = waitForWorkerResponse(responses, request.id);
      receiver.emit("message", request);
      return response;
    };
    assert.equal((await send({ id: 1, type: "preload" })).values.length, 0);
    assert.equal(transformers.env.allowRemoteModels, false);
    assert.equal(
      transformers.env.cacheDir,
      transport === "thread" ? "thread-cache" : "offline-cache",
    );
    assert.deepEqual(
      Array.from(
        (await send({ id: 2, type: "text", text: "a".repeat(9000) })).values,
      ),
      [1, 2],
    );
    assert.equal(tokenizerOptions.padding, true);
    assert.equal(tokenizerOptions.truncation, true);
    assert.equal(modelOptions.dtype, "q8");
    assert.equal(modelOptions.session_options.intraOpNumThreads, 1);
    assert.deepEqual(
      Array.from(
        (await send({ id: 3, type: "image", filePath: "/test.jpg" })).values,
      ),
      [3, 4],
    );
    assert.equal(decoderOptions.limitInputPixels, 40_000_000);
    assert.equal(decoderOptions.failOn, "warning");
    assert.deepEqual(Array.from(rawArguments[0]), [1, 2, 3]);
    assert.deepEqual(rawArguments.slice(1), [1, 1, 3]);
    pixels = 10_000;
    assert.match(
      (await send({ id: 4, type: "image", filePath: "/huge.jpg" })).error,
      /40 million pixel/,
    );
    assert.equal(fakeProcess.env.OMP_NUM_THREADS, "2");
  }
});

test("x64 macOS loads Transformers through WASM without the unavailable native binding", (t) => {
  if (process.platform !== "darwin") {
    t.skip("The missing native binding is specific to the macOS x64 package.");
    return;
  }

  const script = `
    const assert = require("node:assert/strict");
    const Module = require("node:module");
    const runtime = require("onnxruntime-web/wasm");
    const originalLoad = Module._load;
    const bundledSharp = require("sharp");
    let interceptedNativeRuntime = false;
    let interceptedSharp = false;
    Module._load = function (request, parent, isMain) {
      if (request === "onnxruntime-node") {
        interceptedNativeRuntime = true;
        return {};
      }
      if (request === "sharp") {
        interceptedSharp = true;
        return bundledSharp;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      globalThis[Symbol.for("onnxruntime")] = runtime;
      const transformers = require("@huggingface/transformers");
      assert.equal(process.arch, "x64");
      assert.equal(interceptedNativeRuntime, true);
      assert.equal(interceptedSharp, true);
      assert.equal(typeof transformers.AutoTokenizer.from_pretrained, "function");
      assert.equal(typeof transformers.RawImage, "function");
      assert.equal(typeof runtime.InferenceSession.create, "function");
      console.log("x64-wasm-runtime-ready");
    } finally {
      Module._load = originalLoad;
    }
  `;
  const args = process.arch === "x64"
    ? ["-e", script]
    : ["-x86_64", process.execPath, "-e", script];
  const command = process.arch === "x64" ? process.execPath : "/usr/bin/arch";
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });

  if (
    process.arch !== "x64" &&
    (result.error?.code === "ENOEXEC" || /Bad CPU type/i.test(result.stderr ?? ""))
  ) {
    t.skip("Rosetta is unavailable for the x64 runtime smoke test.");
    return;
  }

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /x64-wasm-runtime-ready/);
});

test("Intel macOS uses local WASM sessions for compatible CLIP embeddings", async () => {
  const port = new EventEmitter();
  const fakeProcess = new EventEmitter();
  fakeProcess.arch = "x64";
  fakeProcess.platform = "darwin";
  fakeProcess.env = { SEMANTIC_MODEL_CACHE_PATH: "offline-cache" };
  fakeProcess.connected = true;
  fakeProcess.exit = () => {};
  const responses = new EventEmitter();
  fakeProcess.send = (response, callback) => {
    responses.emit("response", response);
    callback?.(null);
  };
  port.postMessage = (response) => responses.emit("response", response);

  const moduleLoader = { _load: () => assert.fail("loader was not patched") };
  const onnxruntime = {
    env: { wasm: {} },
    Tensor: class {
      constructor(type, data, dims) {
        Object.assign(this, { type, data, dims });
      }
    },
    InferenceSession: {
      create: async (modelData, options) => {
        const modelPath = Buffer.from(modelData).toString();
        assert.equal(options.executionProviders.length, 1);
        assert.equal(options.executionProviders[0], "wasm");
        const isText = modelPath.endsWith("text_model_quantized.onnx");
        return {
          inputNames: [isText ? "input_ids" : "pixel_values"],
          run: async (feeds) => {
            assert.deepEqual(Object.keys(feeds), [
              isText ? "input_ids" : "pixel_values",
            ]);
            assert.ok(feeds[Object.keys(feeds)[0]] instanceof onnxruntime.Tensor);
            return {
              [isText ? "text_embeds" : "image_embeds"]: {
                data: isText ? [1, 2] : [3, 4],
              },
            };
          },
        };
      },
    },
  };
  const transformers = {
    env: {},
    AutoTokenizer: {
      from_pretrained: async () => () => ({
        input_ids: {
          type: "int64",
          data: new BigInt64Array([1n, 2n]),
          dims: [1, 2],
        },
        attention_mask: {
          type: "int64",
          data: new BigInt64Array([1n, 1n]),
          dims: [1, 2],
        },
      }),
    },
    AutoProcessor: {
      from_pretrained: async () => async () => ({
        pixel_values: {
          type: "float32",
          data: new Float32Array([0.25]),
          dims: [1, 3, 1, 1],
        },
      }),
    },
    RawImage: class {},
  };
  const sharp = () => ({
    metadata: async () => ({ width: 1, height: 1 }),
    rotate() {
      return this;
    },
    toColourspace() {
      return this;
    },
    removeAlpha() {
      return this;
    },
    raw() {
      return this;
    },
    toBuffer: async () => ({
      data: Buffer.from([1, 2, 3]),
      info: { width: 1, height: 1, channels: 3 },
    }),
  });
  sharp.concurrency = (threads) => assert.equal(threads, 2);
  const fsMock = {
    existsSync: () => true,
    readFileSync: (filePath) => Buffer.from(filePath),
  };
  const asarRuntimePath = path.join(
    path.sep,
    "Applications",
    "Silo.app",
    "Contents",
    "Resources",
    "app.asar",
    "node_modules",
    "onnxruntime-web",
    "dist",
    "ort.wasm.min.js",
  );
  loadSource(
    "semanticWorker.ts",
    {
      worker_threads: { parentPort: port, workerData: { modelCachePath: "offline-cache" } },
      fs: fsMock,
      module: moduleLoader,
      "onnxruntime-web/wasm": onnxruntime,
      "@huggingface/transformers": transformers,
      sharp,
      beforeRequire: (moduleName) => {
        if (moduleName === "@huggingface/transformers") {
          const nativeRuntimeStub = moduleLoader._load("onnxruntime-node");
          assert.equal(typeof nativeRuntimeStub, "object");
          assert.equal(Object.keys(nativeRuntimeStub).length, 0);
          assert.equal(
            moduleLoader._load("sharp"),
            sharp,
            "Transformers must reuse the app's top-level Sharp module",
          );
        }
      },
      resolve: (moduleName) => {
        assert.equal(moduleName, "onnxruntime-web/wasm");
        return asarRuntimePath;
      },
    },
    { process: fakeProcess, Error },
  );
  const send = async (request) => {
    const response = waitForWorkerResponse(responses, request.id);
    port.emit("message", request);
    return response;
  };

  const preload = await send({ id: 1, type: "preload" });
  assert.equal(preload.id, 1);
  assert.equal(preload.error, undefined);
  assert.deepEqual(Array.from(preload.values), []);
  assert.equal(transformers.env.allowRemoteModels, false);
  assert.equal(transformers.env.cacheDir, "offline-cache");
  assert.equal(transformers.env.useWasmCache, false);
  assert.equal(onnxruntime.env.wasm.numThreads, 1);
  assert.equal(onnxruntime.env.wasm.proxy, false);
  for (const fileName of [
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
  ]) {
    const assetUrl = onnxruntime.env.wasm.wasmPaths[
      fileName.endsWith(".mjs") ? "mjs" : "wasm"
    ];
    assert.match(assetUrl, /app\.asar\.unpacked/);
    assert.ok(assetUrl.endsWith(fileName));
  }
  assert.deepEqual(
    Array.from((await send({ id: 2, type: "text", text: "search" })).values),
    [1, 2],
  );
  assert.deepEqual(
    Array.from((await send({ id: 3, type: "image", filePath: "/test.jpg" })).values),
    [3, 4],
  );
  assert.equal(fakeProcess.env.OMP_NUM_THREADS, "2");
});

test("confidence slider maps higher settings to stricter match thresholds", (t) => {
  const { confidenceSettingToMinimumThreshold } = makeIndexer(t);
  assert.equal(confidenceSettingToMinimumThreshold(0), 0);
  assert.equal(confidenceSettingToMinimumThreshold(25), 25);
  assert.equal(confidenceSettingToMinimumThreshold(100), 100);
  assert.equal(confidenceSettingToMinimumThreshold(Number.NaN), 23);
});

test("semantic search applies confidence and excludes unfinished or inactive records", async (t) => {
  const { indexer } = makeIndexer(t);
  const vectorBytes = 512 * Float32Array.BYTES_PER_ELEMENT;
  const records = [
    { path: "/photos/high.jpg", sourcePath: "/photos", vectorOffset: 0, type: "image" },
    { path: "/photos/weak.jpg", sourcePath: "/photos", vectorOffset: vectorBytes, type: "image" },
    { path: "/other/high.jpg", sourcePath: "/other", vectorOffset: vectorBytes * 2, type: "image" },
    { path: "/photos/processing.jpg", sourcePath: "/photos", vectorOffset: vectorBytes * 3, type: "image" },
    { path: "/photos/pending.jpg", sourcePath: "/photos", vectorOffset: -1, type: "image" },
  ];
  for (const record of records) {
    const completeRecord = {
      name: path.basename(record.path),
      relativePath: path.basename(record.path),
      size: 1,
      modified: 1,
      extension: "jpg",
      signature: "fixture",
      ...record,
    };
    indexer.latestRecords.set(record.path, completeRecord);
    if (record.path !== "/photos/processing.jpg" && record.vectorOffset >= 0)
      indexer.latestRecordsByVectorKey.set(record.vectorOffset / vectorBytes, completeRecord);
  }
  indexer.processingPaths.add("/photos/processing.jpg");
  indexer.demoFilePaths = () => null;
  indexer.loadClipRuntime = async () => ({});
  indexer.embedText = async () => {
    const queryVector = new Float32Array(512);
    queryVector[0] = 1;
    return queryVector;
  };
  indexer.vectorIndexReady = Promise.resolve();
  indexer.persistedVectorIndex = {
    search: async () => [
      { key: 0, confidence: 60 },
      { key: 1, confidence: 20 },
      { key: 2, confidence: 90 },
      { key: 3, confidence: 99 },
    ],
    shutdown: async () => {},
  };

  const strictResults = await indexer.search("cat", 25, ["/photos"]);
  assert.deepEqual(
    Array.from(strictResults, (result) => result.path),
    ["/photos/high.jpg"],
  );

  const relaxedResults = await indexer.search("cat", 19, ["/photos"]);
  assert.deepEqual(
    Array.from(relaxedResults, (result) => result.path),
    ["/photos/high.jpg", "/photos/weak.jpg"],
  );
});

test("semantic search discards results when cancelled during embedding", async (t) => {
  let cancelled = false;
  const { indexer } = makeIndexer(t);
  indexer.demoFilePaths = () => null;
  indexer.loadClipRuntime = async () => ({});
  indexer.embedText = async () => {
    cancelled = true;
    return new Float32Array(512);
  };
  indexer.persistedVectorIndex = {
    search: async () => {
      assert.fail("a cancelled semantic search must not query the vector index");
    },
    shutdown: async () => {},
  };

  const results = await indexer.search(
    "cat",
    0,
    ["/photos"],
    () => cancelled,
  );
  assert.equal(results.length, 0);
});

test("filename search streams its first match while the index is hydrating", async (t) => {
  const { indexer } = makeIndexer(t);
  indexer.demoFilePaths = () => null;
  indexer.loadComplete = false;

  let resolveStreamed;
  const streamed = new Promise((resolve) => {
    resolveStreamed = resolve;
  });
  const searchPromise = indexer.searchTextMatches(
    "first",
    ["/photos"],
    () => false,
    (matches) => {
      if (matches.length > 0) resolveStreamed(matches);
    },
  );

  try {
    for (let attempt = 0; attempt < 50 && indexer.activeTextSearches.size === 0; attempt++)
      await new Promise(setImmediate);
    assert.equal(indexer.activeTextSearches.size, 1);

    indexer.setLatestRecord({
      path: "/photos/first.jpg",
      name: "first.jpg",
      sourcePath: "/photos",
      relativePath: "first.jpg",
      size: 1,
      modified: 1,
      type: "image",
      extension: "jpg",
      signature: "fixture",
      vectorOffset: -1,
    });

    const streamedResults = await Promise.race([
      streamed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("The first filename match was not streamed.")), 2000),
      ),
    ]);
    assert.deepEqual(
      Array.from(streamedResults, (result) => result.path),
      ["/photos/first.jpg"],
    );
  } finally {
    indexer.loadComplete = true;
    await searchPromise;
  }
});
