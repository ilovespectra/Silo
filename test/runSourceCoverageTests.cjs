const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { applyDemoSourceLimit } = require("../electron-dist/demoLimits.js");

// Execute the actual main-process functions/providers, without launching Electron
// or loading models. AST extraction avoids maintaining copies of production logic.
const text = fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8");
const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
const functions = new Map();
const handlers = new Map();
const constructors = new Map();
function walk(node) {
  if (ts.isFunctionDeclaration(node) && node.name)
    functions.set(node.name.text, node);
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "ipcMain.handle" &&
    ts.isStringLiteral(node.arguments[0])
  )
    handlers.set(node.arguments[0].text, node.arguments[1]);
  if (ts.isNewExpression(node))
    constructors.set(node.expression.getText(ast), node);
  ts.forEachChild(node, walk);
}
walk(ast);
const calls = [];
const timers = [];
const local = "/local";
const hidden = "/unchecked";
const offline = "/offline";
const phone = "/__phone__/ios/ready";
const offlinePhone = "/__phone_backup__/ios/ready/snapshot/123";
const cloud = "/__cloud__/drive/ready";
const photos = "/__cloud__/photos/ready";
const all = [local, hidden, phone, cloud, photos];
const image = (root) => ({
  path: `${root}/photo.jpg`,
  name: "photo.jpg",
  type: "image",
  extension: ".jpg",
});
const audio = (root) => ({
  path: `${root}/song.mp3`,
  name: "song.mp3",
  extension: ".mp3",
  sourceId: root,
});
const state = {
  indexSources: [{ path: local }, { path: hidden }, { path: offline }, { path: local }],
  disabledSourceIds: [hidden, phone, cloud, photos, offlinePhone],
  enabledSourceIds: [],
};
let storedAudio = {
  scannedAt: Date.now(),
  sourceIds: all,
  sourceScannedAt: Object.fromEntries(all.map((id) => [id, Date.now()])),
  files: all.map(audio),
  failedSources: [],
};
let offlineBackups = [];
const semantic = {
  startWatching: async (roots) => calls.push(["watch", [...roots]]),
  stopWatching: () => {
    throw new Error("Checkbox changes must not stop watching");
  },
  start: async (roots) => calls.push(["start", [...roots]]),
  startFullScan: async (roots) => calls.push(["full-scan", [...roots]]),
  reconcileIndex: async (roots) => {
    calls.push(["reconcile", [...roots]]);
    return new Map();
  },
  getIndexedImages: (roots) => {
    calls.push(["images", [...roots]]);
    return roots.map(image);
  },
  getIndexedFiles: (roots) => {
    calls.push(["files", [...roots]]);
    return roots.map(image);
  },
  getProgress: () => ({
    status: "complete",
    message: "",
    indexed: 0,
    total: 0,
    errors: 0,
  }),
  classifyUnsafeImages: async (roots) => {
    calls.push(["safety", [...roots]]);
    return [];
  },
};
const context = vm.createContext({
  console: { log() {} },
  app: { getPath: () => "/silo-app-data" },
  lifetimeLicensed: true,
  fullAccessEnabled: () => true,
  DEMO_LIMITS: { sources: 2 },
  applyDemoSourceLimit,
  notifyDemoLimitReached() {},
  requestSourceProcessingStages() {},
  requestIndexRecoveryStages() {},
  path,
  Set,
  Map,
  Date,
  stateStore: {
    getState: () => state,
    setSourceEnabled: async (id, enabled) => {
      state.disabledSourceIds = state.disabledSourceIds.filter(
        (value) => value !== id,
      );
      state.enabledSourceIds = state.enabledSourceIds.filter(
        (value) => value !== id,
      );
      if (!enabled) state.disabledSourceIds.push(id);
      else state.enabledSourceIds.push(id);
    },
    setAllSourcesEnabled: async (ids, enabled) => {
      state.disabledSourceIds = enabled ? [] : ids;
      state.enabledSourceIds = enabled ? ids : [];
    },
    removeIndexSource: async (root) => {
      state.indexSources = state.indexSources.filter(
        (source) => source.path !== root,
      );
    },
  },
  scannedPhoneDevices: [
    {
      platform: "ios",
      id: "ready",
      name: "Ready phone",
      rootPath: phone,
      status: "ready",
    },
    {
      platform: "android",
      id: "locked",
      name: "Locked phone",
      rootPath: "/__phone__/android/locked",
      status: "locked",
    },
  ],
  googleManager: {
    getState: () => ({
      accounts: [
        {
          email: "ready",
          driveRootPath: cloud,
          photosRootPath: photos,
          pickedCount: 1,
          needsReauth: false,
        },
        {
          email: "expired",
          driveRootPath: "/__cloud__/drive/expired",
          photosRootPath: "/__cloud__/photos/expired",
          pickedCount: 1,
          needsReauth: true,
        },
      ],
    }),
    isCloudPath: (value) => value.startsWith("/__cloud__/"),
  },
  phoneManager: {
    isPhonePath: (value) => value.startsWith("/__phone__/"),
    parsePhonePath: (value) => {
      const offlineBackup = value.startsWith("/__phone_backup__/");
      const prefix = offlineBackup ? "/__phone_backup__/" : "/__phone__/";
      if (!value.startsWith(prefix)) return null;
      const [platform, deviceId, ...segments] = value.slice(prefix.length).split("/");
      if (!platform || !deviceId) return null;
      let remotePath = segments.length ? `/${segments.join("/")}` : "/";
      let snapshotId = null;
      const snapshotMatch = offlineBackup && remotePath.match(/^\/snapshot\/([^/]+)(\/.*)?$/);
      if (snapshotMatch) {
        snapshotId = snapshotMatch[1];
        remotePath = snapshotMatch[2] || "/";
      }
      return { platform, deviceId, remotePath, offlineBackup, snapshotId };
    },
    getBackupStates: () => [],
    getBackupRoot: () => null,
    getOfflineBackups: async () => offlineBackups,
  },
  getSourceCloneStatus: async () => ({}),
  fs: { constants: { R_OK: 4 } },
  enabledSourcePathCache: new Set(),
  enabledSourceCacheReady: false,
  sourceListCache: null,
  sourceListCacheAt: 0,
  sourceListPromise: null,
  semanticIndexer: semantic,
  faceIndexer: {
    getProgress: () => ({ status: "complete" }),
    start: async () => {},
  },
  petIndexer: { getProgress: () => ({ status: "complete" }) },
  aestheticScorer: {
    analyzeInBackground: async (files) =>
      calls.push(["quality", files.map((file) => file.path)]),
  },
  duplicateManager: {
    scan: async (files, roots) => {
      calls.push(["duplicates", [...roots]]);
      return { groups: [] };
    },
    getState: () => ({ status: "complete" }),
  },
  filterDuplicateState: (value) => value,
  geoIndexer: {
    start: async (files, roots) => calls.push(["geo", [...roots]]),
    getState: () => ({
      photos: all.map((root) => ({
        ...image(root),
        country: "US",
        region: root,
      })),
    }),
    getStatus: () => ({ status: "complete" }),
  },
  geoCheckPromise: null,
  mainWindow: null,
  runtimeLog() {},
  sendToRenderer() {},
  startupIndexReconciliationSettled: true,
  analysisBlocker: () => "",
  analysisIdle: () => true,
  diskIdle: () => true,
  searchSettled: () => true,
  getThumbnailIndexingWaitMessage: () => null,
  PIPELINE_BUSY_STATUSES: new Set(["scanning", "loading-model", "indexing"]),
  magicLibraryProgress: { running: false },
  magicKickTimer: null,
  setTimeout: (callback) => {
    timers.push(callback);
    return 1;
  },
  clearTimeout() {},
  isRemotePath: (value) => value.startsWith("/__"),
  isAppDataPath: (candidate, source, canonicalSource, appData, canonicalAppData) => {
    const within = (value, root) => {
      const relative = path.relative(path.resolve(root), path.resolve(value));
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    return within(candidate, appData) || within(path.resolve(canonicalSource, path.relative(path.resolve(source), path.resolve(candidate))), canonicalAppData);
  },
  isPathWithin: (candidate, root) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  },
  safetyScanPromise: null,
  semanticUnsafePaths: new Set(),
  safetyCachePath: "/cache",
  NSFW_VISUAL_PROMPT: "",
  SAFE_VISUAL_PROMPT: "",
  fsPromises: {
    access: async (filePath) => { if (filePath === offline) throw new Error("Volume disconnected"); },
    realpath: async (filePath) => filePath,
    writeFile: async () => {}, rename: async () => {},
  },
  filterForContentSafety: (files) => files,
  getVisibleDemoMapPhotos: (mapPhotos, sourcePaths) =>
    mapPhotos.filter((photo) =>
      sourcePaths.some((sourcePath) =>
        photo.path.startsWith(`${sourcePath}${path.sep}`),
      ),
    ),
  audioInventoryRunning: false,
  audioInventoryProgress: null,
  audioLibraryCache: {
    getSnapshot: () => storedAudio,
    scan: async (sources) => {
      calls.push(["audio", sources.map((source) => source.rootPath)]);
      storedAudio = {
        ...storedAudio,
        sourceIds: sources.map((source) => source.id),
        files: sources.map((source) => audio(source.id)),
      };
      return storedAudio;
    },
  },
  mime: { getType: () => "audio/mpeg" },
  isAudioFile: () => true,
});
function evaluate(source) {
  return vm.runInContext(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    context,
  );
}
for (const name of [
  "buildSourceList",
  "listSources",
  "sourceIncludesSiloAppData",
  "isSiloAppDataRoot",
  "getIndexableRootsFromSources",
  "getAllIndexSources",
  "getEnabledIndexSources",
  "fileIsInEnabledSource",
  "filterForEnabledSources",
  "indexNewSources",
  "kickGeoCheck",
  "refreshSemanticSafetyIndex",
  "kickMagicBackground",
  "getVisibleAudioSnapshot",
  "refreshAudioInventory",
]) {
  assert(functions.has(name), name);
  evaluate(functions.get(name).getText(ast));
}
function handler(name) {
  assert(handlers.has(name), name);
  return evaluate(`(${handlers.get(name).getText(ast)})`);
}
function rootsFor(name) {
  return calls.filter((call) => call[0] === name).at(-1)?.[1];
}
function equalRoots(actual, expected = all) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

async function run() {
  const listed = await context.listSources();
  assert.equal(await context.isSiloAppDataRoot("/silo-app-data/semantic-index"), true);
  assert.equal(await context.isSiloAppDataRoot("/silo-app-data-sibling"), false);
  assert.equal(await context.isSiloAppDataRoot(phone), false, "virtual phone roots are not local app-data paths");
  const originalIndexSources = state.indexSources;
  state.indexSources = [...originalIndexSources, { path: "/silo-app-data/semantic-index" }];
  equalRoots(await context.getAllIndexSources());
  state.indexSources = originalIndexSources;
  assert.equal(
    listed.find((source) => source.rootPath === phone).enabled,
    false,
  );
  assert.equal(
    listed.find((source) => source.rootPath === phone).available,
    true,
  );
  assert.equal(listed.find((source) => source.rootPath === offline).available, false);
  assert(! (await context.getAllIndexSources()).includes(offline), "Disconnected local roots are omitted from indexers");
  assert.equal(
    listed.find((source) => source.rootPath.endsWith("/expired")).available,
    false,
  );
  equalRoots(await context.getEnabledIndexSources(), [local]);
  const visibilityCache = context.enabledSourcePathCache;
  equalRoots(await context.getAllIndexSources());
  assert.equal(
    context.enabledSourcePathCache,
    visibilityCache,
    "coverage must not replace visibility cache",
  );
  state.indexSources = [{ path: local }, { path: hidden }];
  assert.equal(context.fileIsInEnabledSource(`${hidden}/photo.jpg`), false);
  assert.equal(context.fileIsInEnabledSource("/local-other/photo.jpg"), false);

  for (const enabled of [true, false]) {
    await handler("set-source-enabled")(null, hidden, enabled);
    equalRoots(rootsFor("watch"));
  }
  await handler("set-all-sources-enabled")(null, false);
  equalRoots(rootsFor("watch"));
  equalRoots(await context.getEnabledIndexSources(), []);
  equalRoots(await context.getAllIndexSources());
  assert(
    !calls.some((call) => call[0] === "start"),
    "checkbox changes should not restart indexing",
  );

  await context.indexNewSources([hidden, phone, "/unconfigured"], "test");
  equalRoots(rootsFor("watch"));
  equalRoots(rootsFor("full-scan"));
  await handler("start-indexing")();
  equalRoots(rootsFor("reconcile"));
  equalRoots(rootsFor("watch"));
  assert(
    calls.some((call) => call[0] === "start" && call[1].includes(cloud)),
    "manual indexing must enumerate ready remote roots",
  );

  const faceProvider = constructors.get("FaceIndexer").arguments[3];
  await evaluate(`(${faceProvider.getText(ast)})`)();
  equalRoots(rootsFor("images"));
  const thumb = constructors.get("ThumbnailPregenerator").arguments[0];
  const rootsProvider = thumb.properties.find(
    (property) => property.name?.getText(ast) === "getSourceRoots",
  );
  equalRoots(await evaluate(rootsProvider.initializer.getText(ast))());
  const remoteProvider = thumb.properties.find(
    (property) => property.name?.getText(ast) === "listRemoteMediaFiles",
  );
  context.readSourceFiles = async (source) => [image(source.rootPath)];
  context.mime.getType = () => "image/jpeg";
  assert.equal(
    (await evaluate(`(${remoteProvider.initializer.getText(ast)})`)(phone))
      .length,
    1,
    "unchecked but ready phone remains eligible for thumbnail enumeration",
  );
  await context.kickGeoCheck();
  equalRoots(rootsFor("geo"));
  await context.refreshSemanticSafetyIndex();
  equalRoots(rootsFor("safety"));
  context.kickMagicBackground(0);
  await timers.pop()();
  equalRoots(rootsFor("images"));
  equalRoots(rootsFor("quality"), [image(local).path, image(hidden).path]);
  await handler("scan-duplicates")();
  equalRoots(rootsFor("duplicates"));

  const stages = evaluate(
    `(${constructors.get("IndexingRecovery").arguments[0].getText(ast)})`,
  );
  for (const id of ["search", "duplicates", "quality"])
    await stages.find((stage) => stage.id === id).start();
  equalRoots(rootsFor("watch"));
  equalRoots(rootsFor("duplicates"));
  equalRoots(rootsFor("images"));

  context.mime.getType = () => "audio/mpeg";
  // Restore one selected source without changing full inventory coverage.
  await handler("set-source-enabled")(null, local, true);
  const cacheResult = await handler("get-audio-library-cache")();
  equalRoots(
    cacheResult.files.map((file) => file.sourceId),
    [local],
  );
  assert.equal(
    cacheResult.stale,
    false,
    "unchecked sources must not make all-source coverage stale",
  );
  const scanResult = await context.refreshAudioInventory(123, true);
  equalRoots(rootsFor("audio"));
  equalRoots(storedAudio.files.map((file) => file.sourceId));
  equalRoots(
    scanResult.snapshot.files.map((file) => file.sourceId),
    [local],
  );
  storedAudio.sourceScannedAt[hidden] = 0;
  assert.equal(
    (await handler("get-audio-library-cache")()).stale,
    true,
    "missing unchecked coverage is stale",
  );
  await context.refreshAudioInventory(-1);
  equalRoots(rootsFor("audio"));

  assert.equal((await handler("get-country-summary")())[0].photoCount, 1);
  assert.equal((await handler("get-state-summary")(null, "US")).length, 1);
  await handler("set-all-sources-enabled")(null, false);
  assert.equal((await handler("get-country-summary")()).length, 0);
  const disabledBefore = [...state.disabledSourceIds];
  await handler("start-face-indexing-for-source")(null, hidden);
  assert.deepEqual(
    [...state.disabledSourceIds],
    disabledBefore,
    "face indexing must not override UI selection",
  );

  state.disabledSourceIds = state.disabledSourceIds.filter((id) => id !== offlinePhone && id !== local);
  offlineBackups = [{ id: "ready", snapshotId: "123", platform: "ios", name: "Stored iPhone", rootPath: offlinePhone, snapshotAt: 123, totalFiles: 2, failedFiles: 0 }];
  context.sourceListCacheAt = 0;
  const offlineListed = await context.listSources();
  assert.equal(offlineListed.find((item) => item.rootPath === offlinePhone).offlineBackup, true);
  assert.equal(offlineListed.find((item) => item.rootPath === offlinePhone).snapshotAt, 123);
  assert.equal(offlineListed.find((item) => item.rootPath === offlinePhone).enabled, true, "the saved copy remains searchable while its phone is connected");
  assert.equal(offlineListed.find((item) => item.rootPath === phone).enabled, false, "the connected device is not double-indexed beside its saved copy");
  equalRoots(await context.getAllIndexSources(), [...all.filter((root) => root !== phone), offlinePhone]);
  equalRoots(await context.getEnabledIndexSources(), [local, offlinePhone]);
  state.disabledSourceIds.push(offlinePhone);
  context.sourceListCacheAt = 0;
  assert(! (await context.getAllIndexSources()).includes(offlinePhone), "disabled dated copies are not indexed in the background");
  assert((await context.getAllIndexSources()).includes(phone), "disabling the saved copy restores the connected source for indexing");
  equalRoots(await context.getEnabledIndexSources(), [local]);

  // Visibility queries must continue to request selected roots.
  for (const name of [
    "semantic-search",
    "get-files",
    "get-person",
    "get-person-photo-files",
    "get-person-suggestion-files",
    "get-geo-state",
    "refresh-geo-state",
    "get-photos-by-region",
  ]) {
    assert(
      handlers.get(name).getText(ast).includes("getEnabledIndexSources"),
      name,
    );
  }
  // Startup must not derive watcher/reconciliation coverage from visibility.
  assert(
    text.includes(
      "const sources = await getAllIndexSources();\n  if (sources.length > 0)",
    ),
  );
  assert(
    handlers
      .get("get-indexing-overview")
      .getText(ast)
      .includes("not global coverage"),
  );
  console.log(
    "Source coverage tests passed: unchecked roots indexed by all pipelines, all-source watchers, ready-only remote roots, independent visibility cache, filtered audio/map results, and batch-scoped discovery.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
