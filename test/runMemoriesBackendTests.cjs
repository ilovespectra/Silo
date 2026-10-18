const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

// Executes the real Memories integration from src/main.ts (AST-extracted) against
// mocked services and a throwaway temp directory. Never touches real user data.
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const { fileTextLooksExplicit, NSFW_VISUAL_PROMPT, SAFE_VISUAL_PROMPT } = require("../src/contentPolicy.ts");
const { MemoryExportCancelledError } = require("../src/memoryExporter.ts");
const {
  getDefaultMemoryDuration,
  isMemoryDurationAllowed,
  MEMORY_DURATION_SECONDS,
  MEMORY_DEFAULT_SELECTION_COUNT,
  MEMORY_MIN_SELECTION_COUNT,
  getMemorySelectionMinimum,
  MEMORY_MAGIC_SCORE_THRESHOLD,
  MEMORY_EXPORT_LIMITS,
  selectMemoryPhotoCandidates,
} = require("../src/memoryTypes.ts");
const { MemoryManager } = require("../src/memoryManager.ts");
const {
  hasValidPromptedMemoryFolderContext,
  isMemoryVisualContentExplicit,
} = require("../src/memorySafetyPolicy.ts");
const { AestheticScorer } = require("../src/aestheticScorer.ts");
const { RefreshScheduler } = require("../src/memoryTopicProfile.ts");
const {
  isPersonalPhotoPath, personalPhotoRejection, nonPersonalFolderKeyword, PERSONAL_PHOTO_MIN_BYTES,
  isPromptedVideoPhotoEligible, currentPromptedVideoIndexingImage,
} = require("../src/memoryDiscovery.ts");
const exifr = require("exifr");

// VM-realm objects fail strict deepEqual on prototype identity.
const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const mainPath = path.join(__dirname, "../src/main.ts");
const text = fs.readFileSync(mainPath, "utf8");
const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
const functions = new Map();
const handlers = new Map();
function walk(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "ipcMain.handle" && ts.isStringLiteral(node.arguments[0]))
    handlers.set(node.arguments[0].text, node);
  ts.forEachChild(node, walk);
}
walk(ast);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "silo-memories-backend-test-"));
const userData = path.join(root, "userData");
const library = path.join(root, "library");
fs.mkdirSync(path.join(userData, "thumbnail-cache"), { recursive: true });
fs.mkdirSync(library, { recursive: true });

const vectorByName = (name) => {
  if (name.startsWith("beach")) return [0.5, 0, 0, 0];
  if (name.startsWith("crowd")) return [0.5, 0.5, 0, 0];
  if (name.startsWith("dull")) return [0.1, 0, 0.5, 0];
  if (name.startsWith("vector-graphic")) return [0, 1, 0, 0];
  return [0.3, 0, 0, 0];
};
const opened = [];
const thumbnailCalls = [];
const searchCalls = [];
const magicRankCalls = [];
const magicFilterCalls = [];
const dialogCalls = [];
const renderCalls = [];
const previewEvents = [];
const magicScores = new Map();
let metadataReads = 0;
let searchResults = [];
let indexedImages = [];
const missingVectorPaths = new Set();
const safetyVectors = new Map();
const progress = { semantic: "complete", face: "complete" };

const context = vm.createContext({
  console, path, os, URL, Buffer, Date, Math, Number, String, Array, Set, Map, Object, Error, Promise,
  Float32Array, JSON,
  process: { arch: "arm64" },
  createHash: crypto.createHash,
  fsPromises: {
    ...fsp,
    opendir: async (directory, ...rest) => {
      opened.push(directory);
      const logical = "/Photos";
      const physical = path.join(library, path.relative(logical, directory));
      return fsp.opendir(directory === logical || directory.startsWith(logical + path.sep) ? physical : directory, ...rest);
    },
    readdir: async (directory, ...rest) => {
      if (directory === path.join(userData, "memories", "previews")) return fsp.readdir(directory, ...rest);
      throw new Error("Memories must stream library directories with opendir");
    },
  },
  app: { getPath: (name) => { assert.equal(name, "userData"); return userData; } },
  indexStoragePath: (...segments) => path.join(userData, ...segments),
  stateStore: {
    getState: () => { metadataReads++; return { fileMetadata: context.__metadata, digitalFolders: context.__folders, nameIndex: context.__names }; },
    getSearchState: () => ({ fileMetadata: context.__metadata, digitalFolders: context.__folders, nameIndex: context.__names }),
  },
  __folders: [],
  __names: [],
  __people: [],
  __metadata: {},
  __geoPhotos: [],
  geoIndexer: { getState: () => ({ photos: context.__geoPhotos }) },
  contentSettingsStore: { getPublicSettings: () => { throw new Error("Memories must not consult reveal toggles"); } },
  hiddenPaths: new Set(),
  getHiddenFolderPaths: (except) => { assert.equal(except, undefined); return context.hiddenPaths; },
  faceIndexer: { getBannedPhotoPaths: () => context.banned, getProgress: () => ({ status: progress.face }),
    getPeople: () => context.__people, getPerson: (id) => context.__people.find((person) => person.id === id) },
  aestheticScorer: {
    rankDistinct: async function (items, preset, threshold) {
      magicRankCalls.push({ items, preset, threshold });
      const order = await this.filterSimilar(items.map((item) => item.path), threshold);
      return { order, scores: Object.fromEntries(items.map((item) => [item.path, magicScores.get(item.path) ?? 50])), analyzed: items.length, total: items.length, running: false };
    },
    filterSimilar: async (paths, threshold) => { assert.equal(threshold, 0.85); magicFilterCalls.push(paths); return paths; },
  },
  banned: new Set(),
  semanticUnsafePaths: new Set(),
  fileTextLooksExplicit, NSFW_VISUAL_PROMPT, SAFE_VISUAL_PROMPT, MEMORY_DURATION_SECONDS, MEMORY_EXPORT_LIMITS,
  hasValidPromptedMemoryFolderContext, isMemoryVisualContentExplicit,
  MEMORY_DEFAULT_SELECTION_COUNT, MEMORY_MIN_SELECTION_COUNT, getMemorySelectionMinimum, MEMORY_MAGIC_SCORE_THRESHOLD, selectMemoryPhotoCandidates,
  getDefaultMemoryDuration, isMemoryDurationAllowed, MemoryExportCancelledError,
  isRemotePath: (value) => value.startsWith("/__phone__/"),
  phoneManager: {
    isPhonePath: (value) => value.startsWith("/__phone__/"),
    parsePhonePath: () => null,
    getBackupRoot: () => null,
    listPhoneFiles: async () => [],
    statPhoneFile: async () => null,
  },
  memoryContentSafetyCache: new Map(),
  memoryContentSafetyInFlight: new Map(),
  getMemoryExplicitPromptVectors: async () => ({
    unsafe: new Float32Array([1, 0, 0, 0]),
    safe: new Float32Array([0, 1, 0, 0]),
  }),
  fullAccessEnabled: () => context.__fullAccess,
  __fullAccess: true,
  isSiloInternalRoot: async () => false,
  isPathWithin: (candidate, parent) => candidate === parent || candidate.startsWith(parent + path.sep),
  resolveLocalPath: async (value) => value === "/Photos" || value.startsWith("/Photos" + path.sep)
    ? path.join(library, path.relative("/Photos", value)) : value,
  PIPELINE_BUSY_STATUSES: new Set(["scanning", "loading-model", "indexing"]),
  getAllIndexSources: async () => [library, "/__phone__/ios/ready"],
  semanticIndexer: {
    getProgress: () => ({ status: progress.semantic, currentFile: progress.currentFile ?? null }),
    getIndexedImages: () => indexedImages,
    getImageVectors: async (paths) => new Map(paths.filter((filePath) => !missingVectorPaths.has(filePath))
      .map((filePath) => [filePath, new Float32Array(safetyVectors.get(filePath) ?? vectorByName(path.basename(filePath)))])),
    search: async (...args) => {
      searchCalls.push(args);
      const include = args[5];
      return typeof include === "function" ? searchResults.filter(include) : searchResults;
    },
    embedPrompts: async (prompts) => {
      if (prompts.length === 3 && prompts[1] === `a photo of ${NSFW_VISUAL_PROMPT}`) {
        assert.deepEqual(plain(prompts), [prompts[0], `a photo of ${NSFW_VISUAL_PROMPT}`, `a photo of ${SAFE_VISUAL_PROMPT}`]);
        return [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0]), new Float32Array([0, 0, 1, 0])];
      }
      return prompts.map(() => new Float32Array([1, 0, 0, 0]));
    },
    embedPreviewImage: async (file) => {
      if (file.startsWith(path.join(userData, "thumbnail-cache") + path.sep))
        return new Float32Array(JSON.parse(await fsp.readFile(file, "utf8")));
      return new Float32Array(vectorByName(path.basename(file)));
    },
  },
  getThumbnail: async (filePath, force, size) => {
    thumbnailCalls.push([filePath, force, size]);
    const key = crypto.createHash("sha1").update(filePath).digest("hex");
    await fsp.writeFile(path.join(userData, "thumbnail-cache", `${key}.jpg`), JSON.stringify(vectorByName(path.basename(filePath))));
    return `thumb://local/${key}.jpg`;
  },
  getConvertedImageBuffer: async (file, size, quality, cacheName) => {
    assert.deepEqual([size, quality, cacheName], [2048, 90, "memory-image-cache"]);
    if (file.endsWith(".bad")) throw new Error("sips failed");
    return Buffer.from(`converted:${file}`);
  },
  mainWindow: { isDestroyed: () => false },
  sendToRenderer(channel, payload) { if (channel === "memory-preview-progress") previewEvents.push(payload); },
  memoryPreviewStatus: new Map(),
  memoryPreviewEmitTimer: null,
  setTimeout,
  clearTimeout,
  dialog: { showSaveDialog: async (...args) => { dialogCalls.push(args); return context.__dialog(); } },
  __dialog: async () => ({ canceled: false, filePath: path.join(root, "out.mp4") }),
  memoryManager: null,
  memoryPromptVectors: async () => ({
    junk: [new Float32Array([0, 1, 0, 0])],
    good: [new Float32Array([1, 0, 0, 0])],
    nonPhoto: [new Float32Array([0, 1, 0, 0])],
  }),
  memoryExporter: null,
  memoryExportRunning: false,
  memoryExportCancelRequested: false,
  memoryExportScratch: null,
  memoryPreviewQueue: Promise.resolve(),
  memoryPreviewCards: new Map(),
  cleanupMemoryImageCache: async () => {},
  memoryRenderQueue: Promise.resolve(),
  memoryFrameVectors: new Map(),
  memoryUnsafeVideoPaths: new Set(),
  memoryMetadataSnapshot: null,
  MEMORY_PREVIEW_RENDER_VERSION: 8,
  isPersonalPhotoPath,
  personalPhotoRejection,
  nonPersonalFolderKeyword,
  isPromptedVideoPhotoEligible,
  currentPromptedVideoIndexingImage,
  PERSONAL_PHOTO_MIN_BYTES,
  os: require("os"),
  exifr,
  audioLibraryCache: null,
  memoryMusicDirectoryCache: null,
  memoryExifCache: new Map(),
  memoryPhotoPromptVectors: null,
  MEMORY_DEFAULT_MOVIE_DIRECTORY: () => path.join(userData, "memories", "previews"),
  consumeDemoMemoryPreview: async () => true,
  runtimeLog() {},
  MEMORY_DUPLICATE_SIMILARITY: 0.85,
  MEMORY_SEARCH_MIN_CONFIDENCE: 20,
  MEMORY_NAMED_IMAGE_EXTENSIONS: new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".avif"]),
  MEMORY_VIDEO_EXTENSIONS: new Set([".mov", ".mp4", ".m4v", ".webm"]),
});
function evaluate(source) {
  return vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
}
for (const name of [
  "memoryFileMetadata", "memoryObviousNonPhotoPath", "memoryAllowed", "memoryContentAllowed", "memorySearchImageEligible", "memoryLiveVideo", "memoryThumbnailFile", "memoryVideoCandidates",
  "memoryTopCounts", "memoryPersonalRejectionSummary", "memoryErrorDetails",
  "memoryDot", "memoryImageContentFactor", "memoryImageIsObviousNonPhoto", "filterMemoryPhotos", "normalizeMemoryName", "memoryNameMatches", "memoryPathInRoots", "memoryPromptContext", "applyMemoryPromptContext", "namedMemoryMedia", "searchMemoryMedia", "readMemoryExif", "applyMemoryPhotoQuality",
  "promptedVideoPhotoCandidate", "searchPromptedMemoryMedia", "memoryVideoMatchesForPhotos", "memoryMusicDirectories",
  "prepareMemoryExportImage", "memoryExportOptions", "verifyMemoryExport",
  "memoryPreviewOptions", "memoryPreviewFileName", "memoryTitleStem", "memoryMovieDirectory", "findMemoryMovie", "runMemoryRender",
  "prepareMemoryPreviewsNow", "prepareMemoryPreviews", "prepareAllMemoryPreviews", "setMemoryPreviewStatus",
  "memoryPreviewStatuses", "openMemoryMovie", "rememberMemoryMovieTitles",
]) {
  assert(functions.has(name), `missing ${name}`);
  evaluate(functions.get(name).getText(ast));
}
// Keep the broad suite's path-only stub; the folder-policy test invokes the
// extracted real visual gate directly through this saved function reference.
context.__memoryContentAllowedIntegration = context.memoryContentAllowed;
context.memoryContentAllowed = async (filePath) => context.memoryAllowed(filePath);
assert(functions.has("getIndexableRootsFromSources"), "missing getIndexableRootsFromSources");
evaluate(functions.get("getIndexableRootsFromSources").getText(ast));
const handler = (name) => {
  assert(handlers.has(name), `missing handler ${name}`);
  return evaluate(`(${handlers.get(name).arguments[1].getText(ast)})`);
};

const results = [];
async function test(name, body) {
  try { await body(); results.push(`ok - ${name}`); }
  catch (error) { results.push(`not ok - ${name}`); console.error(error); process.exitCode = 1; }
}

async function run() {
  await test("memory profile refresh cannot be postponed by steady indexing notifications", async () => {
    const timers = [];
    let finishFirstRun;
    let runs = 0;
    const scheduler = new RefreshScheduler({
      delayMs: 60_000,
      isBusy: () => false,
      run: () => {
        runs += 1;
        if (runs === 1) return new Promise((resolve) => { finishFirstRun = resolve; });
        return Promise.resolve();
      },
      setTimer: (callback) => { timers.push(callback); return callback; },
      clearTimer: () => {},
    });

    scheduler.notify();
    scheduler.notify();
    scheduler.notify();
    assert.equal(timers.length, 1, "steady indexed-photo updates share a fixed refresh deadline");
    timers.shift()();
    assert.equal(runs, 1, "the profile refresh starts while indexing is still active");

    scheduler.notify();
    scheduler.notify();
    finishFirstRun();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.length, 1, "updates during a refresh collapse into one follow-up");
    timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 2);
  });

  await test("memory search keeps every safe indexed image eligible and blocks NSFW on both architectures", async () => {
    const originalSearch = context.semanticIndexer.search;
    const originalArch = context.process.arch;
    const originalUnsafe = context.semanticUnsafePaths;
    const safeImages = Array.from({ length: 12 }, (_, i) => ({
      path: path.join(library, i % 2 ? `Photos/photo-${i}.png` : `Covers/cover-${i}.jpg`),
      name: i % 2 ? `photo-${i}.png` : `cover-${i}.jpg`,
      type: "image", size: 900 + i, modified: i, confidence: 95,
    }));
    const graphic = { path: path.join(library, "vector-graphic.jpg"), name: "vector-graphic.jpg",
      type: "image", size: 900_000, modified: 99, confidence: 98 };
    const unsafe = { path: path.join(library, "unsafe.jpg"), name: "unsafe.jpg",
      type: "image", size: 4_000_000, modified: 100, confidence: 99 };
    context.semanticUnsafePaths = new Set([unsafe.path]);
    context.semanticIndexer.search = async (_query, confidence, roots) => {
      assert.equal(confidence, 20);
      assert.deepEqual(plain(roots), [library, "/__phone__/ios/ready"],
        "Memories search every configured source regardless of its visibility checkbox");
      return [...safeImages, graphic, unsafe];
    };
    try {
      for (const arch of ["arm64", "x64"]) {
        context.process.arch = arch;
        const hits = await context.searchMemoryMedia("holiday");
        const selected = new Set(hits.filter((file) => file.type === "image").map((file) => file.path));
        assert.equal(selected.size, safeImages.length);
        assert(!selected.has(graphic.path), "clear graphic CLIP match is excluded");
        for (const image of safeImages) assert(selected.has(image.path), `safe image excluded: ${image.name}`);
        assert(!selected.has(unsafe.path), "NSFW indexed image is never exposed to Memories");
      }
    } finally {
      context.semanticIndexer.search = originalSearch;
      context.process.arch = originalArch;
      context.semanticUnsafePaths = originalUnsafe;
    }
  });

  await test("memory source roots keep offline local indexes and ready added sources", async () => {
    const originalFullAccess = context.__fullAccess;
    try {
      context.__fullAccess = true;
      const roots = await context.getIndexableRootsFromSources([
        { id: "/offline-drive/Photos", rootPath: "/offline-drive/Photos", available: false, enabled: false },
        { id: "/added/Camera", rootPath: "/added/Camera", available: true, enabled: false },
        { id: "phone", rootPath: "/__phone__/ios/ready", available: true, enabled: true },
        { id: "disconnected-phone", rootPath: "/__phone__/ios/gone", available: false, enabled: true },
      ]);
      assert.deepEqual(plain(roots), ["/offline-drive/Photos", "/added/Camera", "/__phone__/ios/ready"]);
      context.__fullAccess = false;
      const selectedRoots = await context.getIndexableRootsFromSources([
        { id: "/offline-drive/Photos", rootPath: "/offline-drive/Photos", available: false, enabled: false },
        { id: "/added/Camera", rootPath: "/added/Camera", available: true, enabled: true },
        { id: "/locked", rootPath: "/locked", available: true, enabled: true, demoLocked: true },
      ]);
      assert.deepEqual(plain(selectedRoots), ["/offline-drive/Photos", "/added/Camera"],
        "Memories includes all configured roots regardless of source selection state");
    } finally {
      context.__fullAccess = originalFullAccess;
    }
  });
  await test("Magic threshold prioritizes 90+ photos and fills brisk cuts with the best lower scores", async () => {
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      path: `/photo-${index}.jpg`, score: 100 - index, magicScore: index < 8 ? 98 - index : 89 - index,
    }));
    const selected = selectMemoryPhotoCandidates(candidates);
    assert.equal(MEMORY_MAGIC_SCORE_THRESHOLD, 90);
    assert.equal(MEMORY_DEFAULT_SELECTION_COUNT, 20);
    assert.equal(selected.length, 20);
    assert.equal(selected.filter((item) => item.magicScore >= 90).length, 8);
    assert.deepEqual(selected.slice(8).map((item) => item.path), candidates.slice(8, 20).map((item) => item.path));
    assert.equal(selectMemoryPhotoCandidates(candidates.map((item) => ({ ...item, magicScore: 95 }))).length, 24);
    assert.equal(selectMemoryPhotoCandidates(candidates.slice(0, 12)).length, 12, "uses available distinct photos rather than repeating them");
    assert.equal(context.memoryPreviewOptions({ id: "full", media: Array.from({ length: 24 }, () => ({})) }).count, 20);
    assert.equal(context.memoryPreviewOptions({ id: "short", media: Array.from({ length: 12 }, () => ({})) }).count, 12);
  });

  await test("Magic drops any photo over 85% cosine similarity and keeps distinct picks", async () => {
    const vectors = new Map([
      ["a", new Float32Array([1, 0])],
      ["b", new Float32Array([0.86, Math.sqrt(1 - 0.86 ** 2)])],
      ["c", new Float32Array([0.84, Math.sqrt(1 - 0.84 ** 2)])],
      ["d", new Float32Array([0, 1])],
    ]);
    const magic = new AestheticScorer({ imageVectors: async (paths) => new Map(paths.flatMap((item) => vectors.has(item) ? [[item, vectors.get(item)]] : [])) });
    assert.deepEqual(await magic.filterSimilar(["a", "b", "c", "d"], 0.85), ["a", "c", "d"]);
  });

  await test("Photo quality reports background analysis as running before prompt embedding finishes", async () => {
    const progress = [];
    let releasePrompts;
    const magic = new AestheticScorer({
      cachePath: path.join(root, "aesthetic-progress-test.jsonl"),
      thumbnailFile: async () => null,
      temporaryPreview: async () => null,
      faceBoxes: () => [],
      imageVectors: async () => new Map(),
      embedPrompts: () => new Promise((resolve) => { releasePrompts = resolve; }),
      onProgress: (next) => progress.push(next),
    });
    await magic.analyzeInBackground([
      { path: path.join(library, "pending.jpg"), size: 10, modified: 1, name: "pending.jpg" },
    ]);
    assert.equal(progress.at(-1).running, true);
    assert.equal(progress.at(-1).libraryAnalyzed, 0);
    assert.equal(progress.at(-1).libraryTotal, 1);
    releasePrompts([]);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
  });

  await test("IPC registration waits for servicesReady and services exist first", () => {
    const wrapper = text.indexOf("ipcMain.handle = ((");
    assert(wrapper > 0);
    const early = /EARLY_IPC_CHANNELS = new Set\(\[([^\]]*)\]/.exec(text)[1];
    for (const channel of ["get-memories", "generate-memories", "dismiss-memory", "update-memory-settings",
      "get-memory-soundtracks", "view-memory", "cancel-memory-export", "export-memory"]) {
      assert(handlers.get(channel).getStart(ast) > wrapper, `${channel} registered before wrapper`);
      assert(!early.includes(`"${channel}"`), `${channel} must wait for services`);
    }
    const ready = text.indexOf("resolveServicesReady();");
    assert(text.indexOf("memoryManager = new MemoryManager(") < ready);
    assert(text.indexOf("memoryExporter = new MemoryExporter(") < ready);
    assert(text.indexOf("await memoryManager.initialize();") < ready);
  });

  await test("prompted virtual folders override sexual-content filtering, but automatic checks do not", async () => {
    const folderPath = path.join(library, "Smutty Art");
    const explicit = path.join(folderPath, "explicit-porn-image.jpg");
    const kiss = path.join(library, "affectionate-kiss.jpg");
    const swimwear = path.join(library, "ordinary-swimwear.jpg");
    for (const filePath of [explicit, kiss, swimwear]) {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, "fixture image");
    }
    const folder = { id: "folder-smutty-art", name: "Smutty Art", filePaths: [explicit] };
    context.__folders = [folder];
    context.__metadata = { [explicit]: { displayName: "pornographic image", keywords: ["explicit"] } };
    context.semanticUnsafePaths = new Set([explicit]);
    context.memoryContentSafetyCache.clear();
    context.memoryContentSafetyInFlight.clear();
    safetyVectors.set(explicit, [0.9, 0.05, 0, 0]);
    safetyVectors.set(kiss, [0.24, 0.21, 0, 0]);
    safetyVectors.set(swimwear, [0.24, 0.21, 0, 0]);

    assert.equal(hasValidPromptedMemoryFolderContext(explicit,
      { promptedMemoryFolderId: folder.id }, [folder]), true);
    assert.equal(hasValidPromptedMemoryFolderContext(explicit,
      { promptedMemoryFolderId: "different-folder" }, [folder]), false);
    assert.equal(hasValidPromptedMemoryFolderContext(`${explicit}.other`,
      { promptedMemoryFolderId: folder.id }, [folder]), false);

    searchResults = [];
    const prompted = await context.searchPromptedMemoryMedia("explicit adult imagery", "Smutty Art");
    const chosen = prompted.find((photo) => photo.path === explicit);
    assert.ok(chosen, "a folder named by the prompt contributes its explicit image despite the classifier flags");
    assert.equal(chosen.promptedMemoryFolderId, folder.id);
    assert.equal(await context.__memoryContentAllowedIntegration(explicit, chosen), true,
      "the final Memory safety gate honors a currently valid prompted-folder membership");
    assert.equal(await context.__memoryContentAllowedIntegration(explicit), false,
      "the same content stays blocked outside the named-folder prompt");

    assert.equal(isMemoryVisualContentExplicit(0.24, 0.21), false,
      "a small score advantage does not exclude affectionate kissing or ordinary swimwear");
    assert.equal(isMemoryVisualContentExplicit(0.24, 0.18), true,
      "a clear explicit-content score advantage remains filtered outside a named folder");
    assert.equal(isMemoryVisualContentExplicit(Number.NaN, 0.9), true,
      "invalid classifier scores fail closed");
    assert.equal(await context.__memoryContentAllowedIntegration(kiss), true,
      "the configured safe-context score keeps affectionate kissing eligible");
    assert.equal(await context.__memoryContentAllowedIntegration(swimwear), true,
      "the configured safe-context score keeps ordinary swimwear eligible");

    folder.name = "Renamed Folder";
    assert.equal(await context.__memoryContentAllowedIntegration(explicit, chosen), true,
      "renaming does not revoke a prompt authorization already carried by the current live folder id and membership");
    folder.filePaths = [];
    assert.equal(await context.__memoryContentAllowedIntegration(explicit, chosen), false,
      "removing the photo from the folder revokes the override immediately");
    context.__folders = [];
    context.__metadata = {};
    context.semanticUnsafePaths = new Set();
    safetyVectors.clear();
  });

  await test("memoryAllowed is strict regardless of reveal toggles", () => {
    const ok = path.join(library, "ok.jpg");
    assert.equal(context.memoryAllowed(ok), true);
    for (const bad of [undefined, null, 4, "", "a\0b"]) assert.equal(context.memoryAllowed(bad), false);
    assert.equal(context.memoryAllowed(path.join(library, "phone-screenshot-2026.png")), false,
      "screenshot in the filename excludes it from Memories");
    assert.equal(context.memoryAllowed(path.join(library, "Screenshots", "IMG_2026.jpg")), false,
      "files inside screenshot-named folders are excluded from Memories");
    assert.equal(context.memoryAllowed(path.join(library, "Screen Shots", "IMG_2026.jpg")), false,
      "spaced screenshot folder names are also excluded");
    assert.equal(context.memoryAllowed(path.join(library, "Assets", "hero.jpg")), false,
      "application asset folders are excluded from Memories");
    assert.equal(context.memoryAllowed("/Applications/Example.app/Contents/Resources/icon.png"), false,
      "application bundle artwork is excluded");
    assert.equal(context.memoryAllowed(path.join(library, "app-icon.png")), false,
      "obvious app icon assets are excluded by filename");
    context.hiddenPaths = new Set([path.join(library, "refused.jpg"), path.join(library, "secret")]);
    assert.equal(context.memoryAllowed(path.join(library, "refused.jpg")), false);
    assert.equal(context.memoryAllowed(path.join(library, "secret", "deep", "x.mov")), false, "hidden descendants");
    assert.equal(context.memoryAllowed(path.join(library, "secretive", "x.jpg")), true, "sibling prefix allowed");
    context.banned = new Set([path.join(library, "banned.jpg")]);
    assert.equal(context.memoryAllowed(path.join(library, "banned.jpg")), false);
    context.semanticUnsafePaths = new Set([path.join(library, "unsafe.jpg")]);
    assert.equal(context.memoryAllowed(path.join(library, "unsafe.jpg")), false);
    assert.equal(context.memoryAllowed(path.join(library, "pinup nude.jpg")), false);
    context.__metadata = { [path.join(library, "tagged.jpg")]: { keywords: ["pinup nude"], updatedAt: 0 } };
    context.memoryMetadataSnapshot = null;
    assert.equal(context.memoryAllowed(path.join(library, "tagged.jpg")), false);
    assert.equal(context.memoryAllowed("__proto__"), true);
    const before = metadataReads;
    for (let i = 0; i < 200; i++) context.memoryAllowed(path.join(library, `n${i}.jpg`));
    assert(metadataReads - before <= 1, "state snapshot must be shared across a burst");
    context.hiddenPaths = new Set(); context.banned = new Set(); context.semanticUnsafePaths = new Set();
  });

  await test("Live Photo companion respects every casing and remote paths", async () => {
    const dir = path.join(library, "live");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "IMG_1.HEIC"), "");
    await fsp.writeFile(path.join(dir, "IMG_1.MOV"), "");
    const still = { path: path.join(dir, "IMG_1.HEIC"), name: "IMG_1.HEIC", type: "image", modified: 1 };
    const found = await context.memoryLiveVideo(still);
    assert(found && found.toLowerCase() === path.join(dir, "IMG_1.mov").toLowerCase());
    context.hiddenPaths = new Set([path.join(dir, "IMG_1.MOV")]);
    assert.equal(await context.memoryLiveVideo(still), undefined, "hidden under another casing");
    context.hiddenPaths = new Set();
    assert.equal(await context.memoryLiveVideo({ ...still, path: "/__phone__/ios/ready/IMG_1.HEIC" }), undefined);
    assert.equal(await context.memoryLiveVideo({ ...still, type: "video" }), undefined);
  });

  await test("thumbnail URL parsing is confined to thumbnail-cache", () => {
    const name = `${"a".repeat(40)}.jpg`;
    assert.equal(context.memoryThumbnailFile(`thumb://local/${name}`), path.join(userData, "thumbnail-cache", name));
    for (const bad of [null, "", "thumb://local/../x.jpg", `file:///${name}`, "thumb://local/%2e%2e/a.jpg", "not a url"])
      assert.equal(context.memoryThumbnailFile(bad), null, String(bad));
  });

  await test("search uses all sources, confidence scores, bounded opendir and frame safety", async () => {
    const story = path.join(library, "story");
    await fsp.mkdir(story, { recursive: true });
    for (const name of ["beach.mov", "crowd.mov", "dull.mp4", "notes.txt"]) await fsp.writeFile(path.join(story, name), name);
    await fsp.mkdir(path.join(story, "folder.mov"));
    searchResults = [
      ...Array.from({ length: 45 }, (_, i) => ({ path: path.join("/Photos/story", `p${i}.jpg`), name: `p${i}.jpg`, type: "image",
        modified: 1000 + i, confidence: 90 - i })),
      { path: path.join(story, "doc.pdf"), name: "doc.pdf", type: "document", modified: 1, confidence: 99 },
      { path: "/__phone__/ios/ready/remote.jpg", name: "remote.jpg", type: "image", modified: 1, confidence: 10 },
    ];
    context.semanticUnsafePaths = new Set([path.join("/Photos/story", "p0.jpg")]);
    opened.length = 0;
    const hits = await context.searchMemoryMedia("beach");
    assert.deepEqual(plain(searchCalls.at(-1).slice(0, 3)), ["beach", 20, [library, "/__phone__/ios/ready"]]);
    assert(hits.length <= 50, "manager only reads the first 50 hits");
    const photos = hits.filter((hit) => hit.type === "image");
    assert.equal(photos.length, 20);
    assert(magicFilterCalls.length > 0, "Magic still curates near-duplicate frames");
    assert(!hits.some((hit) => hit.path.endsWith("p0.jpg") || hit.path.endsWith("doc.pdf")));
    assert.equal(photos.find((hit) => hit.path.endsWith("p1.jpg")).score, 89,
      "semantic relevance determines photo order instead of the Magic score");
    const videos = hits.filter((hit) => hit.type === "video");
    assert.deepEqual(plain(videos.map((hit) => path.basename(hit.path))), ["beach.mov"]);
    assert.equal(videos[0].score, 50);
    assert(context.memoryUnsafeVideoPaths.has(path.join("/Photos/story", "crowd.mov")));
    assert.equal(context.memoryAllowed(path.join("/Photos/story", "crowd.mov")), false, "unsafe clip blocked for saved suggestions");
    assert.deepEqual(plain(opened), ["/Photos/story"]);
    for (let i = 1; i < hits.length; i++) assert(hits[i - 1].score >= hits[i].score);
    context.semanticUnsafePaths = new Set();
  });

  await test("custom prompts include digital folders, named pets, people and keywords", async () => {
    const dog = path.join(library, "dog");
    await fsp.mkdir(dog, { recursive: true });
    const files = Array.from({ length: 24 }, (_, i) => path.join(dog, `y${i}.jpg`));
    for (const file of files) await fsp.writeFile(file, Buffer.alloc(200_000));
    for (const file of files) context.memoryExifCache.set(file, null);
    context.__folders = [{ name: "Yoshimi", filePaths: files.slice(6, 18) }];
    context.__names = [{ name: "yoshimi", sourceType: "pet", filePaths: [{ path: files[18], confirmed: true }] }];
    context.__people = [{ id: "p1", name: "Yoshimi", confirmedPhotoPaths: [files[19]] }];
    context.__metadata = { [files[20]]: { keywords: ["Yoshimi"], updatedAt: 1 }, [files[21]]: { displayName: "unrelated", keywords: [], updatedAt: 1 } };
    searchResults = [];
    const hits = await context.searchMemoryMedia("photo of yoshimi");
    assert.equal(searchCalls.at(-1)[1], 20, "custom prompts search at 20% confidence");
    const names = new Set(hits.map((hit) => path.basename(hit.path)));
    assert(names.size >= MEMORY_MIN_SELECTION_COUNT, `only ${names.size} named photos`);
    for (const expected of ["y18.jpg", "y19.jpg", "y20.jpg"]) assert(names.has(expected), `missing ${expected}`);
    assert(!names.has("y21.jpg") && !names.has("y22.jpg"), "unnamed photos must not match");
    context.__folders = []; context.__names = []; context.__people = []; context.__metadata = {};
  });

  await test("named phone photos resolve through the phone cache", async () => {
    const phonePath = "/__phone__/ios/ready/DCIM/IMG_2050.JPG";
    const cachedPath = path.join(root, "cached-phone-photo.jpg");
    await fsp.writeFile(cachedPath, Buffer.alloc(200_000));
    const originalFolders = context.__folders;
    const originalResolve = context.resolveLocalPath;
    context.__folders = [{ name: "Family", filePaths: [phonePath] }];
    context.resolveLocalPath = async (value) => value === phonePath ? cachedPath : originalResolve(value);
    try {
      const named = await context.namedMemoryMedia("family", ["/__phone__/ios/ready"]);
      assert.equal(named.length, 1);
      assert.equal(named[0].path, phonePath, "the memory keeps the virtual source path");
    } finally {
      context.__folders = originalFolders;
      context.resolveLocalPath = originalResolve;
    }
  });

  await test("generated prompts include saved folder, mapped place and person names with extra keywords", async () => {
    const directory = path.join(library, "prompted-named");
    await fsp.mkdir(directory, { recursive: true });
    const folderPhoto = path.join(directory, "folder-photo.jpg");
    const placePhoto = path.join(directory, "place-photo.jpg");
    const personPhoto = path.join(directory, "person-photo.jpg");
    for (const filePath of [folderPhoto, placePhoto, personPhoto])
      await fsp.writeFile(filePath, Buffer.alloc(200_000));

    const original = {
      folders: context.__folders,
      names: context.__names,
      people: context.__people,
      geoPhotos: context.__geoPhotos,
      searchResults,
    };
    context.__folders = [{ name: "Lake Bled", filePaths: [folderPhoto] }];
    context.__names = [];
    context.__people = [{ id: "p-lake", name: "Maja", confirmedPhotoPaths: [personPhoto] }];
    context.__geoPhotos = [{ path: placePhoto, locationLabel: "Piran, Slovenia", city: "Piran",
      region: "Coastal", country: "Slovenia" }];
    searchResults = [];
    indexedImages = [];

    try {
      const folderHits = await context.searchPromptedMemoryMedia("Lake Bled summer picnic");
      assert(folderHits.some((hit) => hit.path === folderPhoto),
        "a saved virtual folder matches when extra prompt keywords follow its name");

      const placeHits = await context.searchPromptedMemoryMedia("Piran weekend coast");
      assert(placeHits.some((hit) => hit.path === placePhoto),
        "a mapped place label contributes its photos to a generated prompt");

      const personHits = await context.searchPromptedMemoryMedia("Maja birthday");
      assert(personHits.some((hit) => hit.path === personPhoto),
        "a saved person's confirmed photos contribute to a generated prompt");
    } finally {
      context.__folders = original.folders;
      context.__names = original.names;
      context.__people = original.people;
      context.__geoPhotos = original.geoPhotos;
      searchResults = original.searchResults;
    }
  });

  await test("separate prompt entity hits remain as a union and co-occurrence ranks first", async () => {
    const directory = path.join(library, "prompted-union");
    await fsp.mkdir(directory, { recursive: true });
    const together = path.join(directory, "together.jpg");
    const personOnly = path.join(directory, "person-only.jpg");
    const placeOnly = path.join(directory, "place-only.jpg");
    const folderOnly = path.join(directory, "folder-only.jpg");
    const unrelated = path.join(directory, "unrelated.jpg");
    for (const filePath of [together, personOnly, placeOnly, folderOnly, unrelated])
      await fsp.writeFile(filePath, Buffer.alloc(200_000));
    const original = {
      folders: context.__folders,
      people: context.__people,
      geoPhotos: context.__geoPhotos,
      metadata: context.__metadata,
      searchResults,
      indexedImages,
    };
    context.__folders = [{ name: "Lake Bled", filePaths: [together, folderOnly] }];
    context.__people = [{ id: "p-coast", name: "Maja", confirmedPhotoPaths: [together, personOnly] }];
    context.__geoPhotos = [
      { path: together, locationLabel: "Piran, Slovenia", city: "Piran", region: "Coastal", country: "Slovenia" },
      { path: placeOnly, locationLabel: "Piran, Slovenia", city: "Piran", region: "Coastal", country: "Slovenia" },
    ];
    context.__metadata = {};
    searchResults = [];
    indexedImages = [];

    try {
      const matches = await context.searchPromptedMemoryMedia("Maja in Piran Lake Bled");
      const byPath = new Map(matches.map((item) => [item.path, item]));
      assert(byPath.has(personOnly), "a person result survives when it does not also match the named place and folder");
      assert(byPath.has(placeOnly), "a place result survives as a union fallback");
      assert(byPath.has(folderOnly), "a folder result survives as a union fallback");
      assert(byPath.has(together), "a co-occurring photo remains available");
      assert(byPath.get(together).score > byPath.get(personOnly).score);
      assert(byPath.get(together).score > byPath.get(placeOnly).score);
      assert(byPath.get(together).score > byPath.get(folderOnly).score);
    } finally {
      context.__folders = original.folders;
      context.__people = original.people;
      context.__geoPhotos = original.geoPhotos;
      context.__metadata = original.metadata;
      searchResults = original.searchResults;
      indexedImages = original.indexedImages;
    }
  });

  await test("prompted videos filter confidence and junk before capping, without Magic ordering", async () => {
    const lowConfidence = Array.from({ length: 165 }, (_, index) => ({
      path: path.join("/Photos", `weak-${index}.jpg`), name: `weak-${index}.jpg`, type: "image",
      modified: index, size: 240_000, confidence: 19,
    }));
    const phonePhoto = { path: "/__phone__/ios/ready/DCIM/IMG_1.jpg", name: "IMG_1.jpg", type: "image",
      modified: 200, size: 30_000, confidence: 75 };
    const strongPhoto = { path: path.join("/Photos", "strong.jpg"), name: "strong.jpg", type: "image",
      modified: 300, size: 300_000, confidence: 88 };
    searchResults = [
      { path: path.join(library, "notes.pdf"), name: "notes.pdf", type: "document", modified: 1, size: 900_000, confidence: 99 },
      { path: path.join(library, "screenshot.png"), name: "screenshot.png", type: "image", modified: 2, size: 900_000, confidence: 98 },
      { path: path.join(library, "vector-graphic.jpg"), name: "vector-graphic.jpg", type: "image", modified: 2, size: 900_000, confidence: 96 },
      { path: "/Photos/Screenshots/IMG_2026.jpg", name: "IMG_2026.jpg", type: "image", modified: 3, size: 900_000, confidence: 97 },
      ...lowConfidence,
      phonePhoto,
      strongPhoto,
    ];
    indexedImages = [];
    progress.semantic = "complete";
    progress.currentFile = null;
    const magicCallsBefore = magicRankCalls.length;
    const result = await context.searchPromptedMemoryMedia("summer beach");
    const selected = new Set(result.map((item) => item.path));
    assert(selected.has(strongPhoto.path), "a strong match after 165 weak hits survives filtering before the cap");
    assert(selected.has(phonePhoto.path), "compressed phone JPEGs remain eligible for a prompted video");
    assert(!selected.has(lowConfidence[0].path), "the query relevance floor still applies");
    assert(!selected.has(path.join(library, "screenshot.png")), "named screenshots are excluded from Memories");
    assert(!selected.has(path.join(library, "vector-graphic.jpg")), "clear visual graphics are excluded from Memories");
    assert(!selected.has("/Photos/Screenshots/IMG_2026.jpg"), "photos in screenshot-named folders are excluded from Memories");
    assert(!selected.has(path.join(library, "notes.pdf")), "documents never reach the photo candidate pool");
    assert.equal(searchCalls.at(-1)[1], 20, "prompted semantic search uses the confidence floor");
    assert.equal(typeof searchCalls.at(-1)[5], "function", "NSFW and non-image safety filtering is applied inside the targeted search");
    assert.equal(magicRankCalls.length, magicCallsBefore, "Magic order does not select prompted-video media");

    const phoneClip = "/__phone__/ios/ready/DCIM/CLIP.MOV";
    const localClip = path.join(root, "phone-clip.mov");
    await fsp.writeFile(localClip, "phone video clip");
    const originalListPhoneFiles = context.phoneManager.listPhoneFiles;
    const originalResolveLocalPath = context.resolveLocalPath;
    context.phoneManager.listPhoneFiles = async (directory) => directory === path.dirname(phonePhoto.path)
      ? [{ path: phoneClip, name: "CLIP.MOV", isDirectory: false }] : [];
    context.resolveLocalPath = async (value) => value === phoneClip ? localClip : originalResolveLocalPath(value);
    try {
      const withPhoneClip = await context.searchPromptedMemoryMedia("summer beach");
      assert(withPhoneClip.some((item) => item.path === phoneClip && item.type === "video"),
        "a relevant uppercase MOV beside a matched phone photo is included");
    } finally {
      context.phoneManager.listPhoneFiles = originalListPhoneFiles;
      context.resolveLocalPath = originalResolveLocalPath;
    }
  });

  await test("prompted videos can score the uniquely active indexing image", async () => {
    const active = { path: path.join("/Photos", "in-flight.jpg"), name: "in-flight.jpg", type: "image",
      modified: 400, size: 250_000 };
    indexedImages = [active];
    missingVectorPaths.add(active.path);
    searchResults = [];
    progress.semantic = "indexing";
    progress.currentFile = active.name;
    const result = await context.searchPromptedMemoryMedia("garden");
    assert(result.some((item) => item.path === active.path), "the active image is embedded and query-scored");
    indexedImages = [];
    missingVectorPaths.delete(active.path);
    progress.semantic = "complete";
    progress.currentFile = null;
  });

  await test("video candidates: at most 4 directories and 12 clips", async () => {
    const dirs = Array.from({ length: 6 }, (_, i) => path.join(library, `bulk${i}`));
    for (const dir of dirs) {
      await fsp.mkdir(dir, { recursive: true });
      for (let i = 0; i < 20; i++) await fsp.writeFile(path.join(dir, `clip${i}.mp4`), "");
    }
    searchResults = dirs.flatMap((dir, d) => [0, 1].map((i) => ({ path: path.join(dir, `p${i}.jpg`), name: `p${i}.jpg`,
      type: "image", modified: d * 10 + i, confidence: 80 - d })));
    opened.length = 0;
    thumbnailCalls.length = 0;
    context.memoryFrameVectors.clear();
    await context.searchMemoryMedia("bulk");
    assert(opened.length <= 4, `opened ${opened.length}`);
    assert(thumbnailCalls.length <= 12, `thumbnailed ${thumbnailCalls.length}`);
    assert(thumbnailCalls.every(([, force, size]) => force === false && size === 480));
    assert.equal((await context.memoryVideoCandidates([dirs[0]], 12, 5)).length, 5, "per-directory entry bound");
  });

  await test("memory search uses the existing index while indexing is busy", async () => {
    searchResults = [];
    const callsBefore = searchCalls.length;
    progress.semantic = "indexing";
    progress.face = "scanning";
    assert.deepEqual(plain(await context.searchMemoryMedia("already indexed")), []);
    assert.equal(searchCalls.length, callsBefore + 2, "search must run against the available index and refill eligible photos");
    assert.equal(searchCalls.at(-1)[0], "already indexed");
    progress.semantic = "complete";
    progress.face = "complete";
    assert.deepEqual(plain(await context.searchMemoryMedia("   ")), []);
  });

  await test("MemoryManager generates from indexed photos while indexing continues", async () => {
    const story = path.join(library, "story");
    searchResults = Array.from({ length: 10 }, (_, i) => ({ path: path.join("/Photos/story", `p${i}.jpg`), name: `p${i}.jpg`,
      type: "image", modified: 1000 + i, confidence: 70 - i }));
    const manager = new MemoryManager(path.join(root, "manager"), {
      search: (query) => context.searchMemoryMedia(query), thumb: async () => null, listAudio: () => [],
      isAllowed: (value) => context.memoryAllowed(value), findLiveVideo: (file) => context.memoryLiveVideo(file),
    });
    progress.semantic = "indexing";
    progress.face = "scanning";
    const state = await manager.generate();
    progress.semantic = "complete";
    progress.face = "complete";
    assert(state.suggestions.length > 0, state.message);
    const media = state.suggestions.flatMap((card) => card.media.map((item) => path.basename(item.path)));
    assert(media.includes("beach.mov"));
    assert(!media.includes("crowd.mov") && !media.includes("dull.mp4"));
  });

  await test("custom prompts search the exact phrase and then planner entities", async () => {
    const hits = Array.from({ length: 16 }, (_, i) => ({
      path: path.join(library, `direct-prompt-${i}.jpg`), name: `direct-prompt-${i}.jpg`,
      type: "image", modified: 2000 + i, score: 100 - i,
    }));
    const calls = [];
    const manager = new MemoryManager(path.join(root, "manager-direct-prompt"), {
      search: async () => [],
      searchPrompted: async (query, contextQuery) => {
        calls.push(["search", query, contextQuery]);
        return hits;
      },
      planPromptedMemory: async () => {
        calls.push(["plan"]);
        return { title: "Planned title", queries: ["Maja birthday"], entities: ["Maja"] };
      },
      thumb: async () => null, listAudio: () => [], isAllowed: async () => true,
    });
    const result = await manager.generate(false, "Maja birthday");
    assert.equal(result.suggestions.length, 1, result.message);
    assert.deepEqual(calls.slice(0, 2), [
      ["search", "Maja birthday", "Maja birthday"],
      ["plan"],
    ]);
    assert(calls.some(([kind, query, contextQuery]) => kind === "search" && query === "Maja"
      && contextQuery === "Maja birthday"), "the exact named person is searched with the complete prompt context");
    assert.equal(result.suggestions[0].title, "Planned title");
  });

  await test("custom prompt planning expands failed exact searches across saved entities", async () => {
    const hits = Array.from({ length: 16 }, (_, i) => ({
      path: path.join(library, `planned-prompt-${i}.jpg`), name: `planned-prompt-${i}.jpg`,
      type: "image", modified: 3000 + i, score: 100 - i,
    }));
    const calls = [];
    const manager = new MemoryManager(path.join(root, "manager-planned-prompt"), {
      search: async () => [],
      searchPrompted: async (query, contextQuery) => {
        calls.push(["search", query, contextQuery]);
        return query === "Maja birthday at Lake Bled" ? [] : hits;
      },
      planPromptedMemory: async (topic) => {
        calls.push(["plan", topic]);
        return { title: "Birthday by the Lake", queries: ["Maja birthday Lake Bled"], entities: ["Maja", "Lake Bled"] };
      },
      thumb: async () => null, listAudio: () => [], isAllowed: async () => true,
    });
    const result = await manager.generate(false, "Maja birthday at Lake Bled");
    assert.equal(result.suggestions.length, 1, result.message);
    assert.deepEqual(calls.slice(0, 2), [
      ["search", "Maja birthday at Lake Bled", "Maja birthday at Lake Bled"],
      ["plan", "Maja birthday at Lake Bled"],
    ]);
    assert(calls.some(([kind, query, contextQuery]) => kind === "search" && query === "Lake Bled"
      && contextQuery === "Maja birthday at Lake Bled"), "planned place entity is searched with full prompt context");
    assert.equal(result.suggestions[0].title, "Birthday by the Lake");
  });

  await test("a mostly repeated prompted set never returns a short memory", async () => {
    const shared = Array.from({ length: 10 }, (_, i) => ({
      path: path.join(library, `overlap-${i}.jpg`), name: `overlap-${i}.jpg`, type: "image",
      modified: 100 + i, score: 90 - i,
    }));
    const firstOnly = Array.from({ length: 5 }, (_, i) => ({
      path: path.join(library, `first-${i}.jpg`), name: `first-${i}.jpg`, type: "image",
      modified: 200 + i, score: 80 - i,
    }));
    const secondOnly = Array.from({ length: 5 }, (_, i) => ({
      path: path.join(library, `second-${i}.jpg`), name: `second-${i}.jpg`, type: "image",
      modified: 300 + i, score: 80 - i,
    }));
    let returnOverlappingSet = false;
    const traces = [];
    const manager = new MemoryManager(path.join(root, "manager-similar-prompts"), {
      search: async () => [],
      searchPrompted: async () => returnOverlappingSet ? [...shared, ...secondOnly] : [...shared, ...firstOnly],
      thumb: async () => null, listAudio: () => [], isAllowed: async () => true,
      onTrace: (event, details) => traces.push({ event, details }),
    });
    const first = await manager.generate(false, "summer beach trip");
    assert.equal(first.suggestions.length, 1, first.message);
    const firstId = first.suggestions[0].id;
    returnOverlappingSet = true;
    const second = await manager.generate(false, "beach summer holiday");
    assert.equal(second.suggestions.length, 1, "the second prompt must not add a short memory");
    assert.equal(second.suggestions[0].id, firstId, "the original prompted memory remains available");
    assert(traces.some(({ event, details }) => event === "memory-story-thin" && details.photos === 5),
      "the 15-photo floor should explain why only five fresh photos were not returned");
  });

  await test("export options validation", () => {
    assert.equal(getDefaultMemoryDuration(1), 60);
    assert.equal(getDefaultMemoryDuration(24), 60);
    assert.equal(isMemoryDurationAllowed(1, 60), true);
    assert.equal(isMemoryDurationAllowed(24, 59), false);
    const base = { suggestionId: "s", soundtrackId: "original:s", count: 12, duration: 60, orientation: "auto", originalAudio: 0.2 };
    assert.deepEqual({ ...context.memoryExportOptions({ ...base, extra: "x" }) }, {
      suggestionId: "s", soundtrackId: "original:s", count: 12, duration: 60,
      originalAudio: 0.2, rightsAcknowledged: false,
    });
    assert.equal("orientation" in context.memoryExportOptions({ ...base, orientation: "portrait" }), false, "legacy framing inputs are discarded");
    assert.equal(context.memoryExportOptions({ ...base, rightsAcknowledged: true }).rightsAcknowledged, true);
    for (const bad of [null, [], "x", { ...base, count: 0 }, { ...base, count: 25 }, { ...base, count: 2.5 },
      { ...base, count: "12" }, { ...base, duration: 14 }, { ...base, duration: 59 }, { ...base, duration: 61 }, { ...base, duration: NaN },
      { ...base, originalAudio: -0.1 }, { ...base, originalAudio: 1.1 }, { ...base, orientation: "square" },
      { ...base, suggestionId: "" }, { ...base, soundtrackId: 5 }, { ...base, rightsAcknowledged: "yes" },
      { ...base, suggestionId: "x".repeat(201) }])
      assert.equal(context.memoryExportOptions(bad), null, JSON.stringify(bad));
    for (const ok of [{ ...base, count: 1, duration: 60, originalAudio: 0 }, { ...base, count: 24, duration: 60, originalAudio: 1 }])
      assert(context.memoryExportOptions(ok));
  });

  const exportPhoto = path.join(library, "export", "a.jpg");
  const suggestion = { id: "s1", title: "Beach / Days!", orientation: "landscape", mood: "bright",
    media: [{ path: exportPhoto, name: "a.jpg", type: "image", modified: 1 }] };
  const library_track = { id: `library:${"a".repeat(64)}`, name: "song", path: path.join(library, "song.mp3"), source: "library", rights: "" };
  await fsp.writeFile(library_track.path, "test soundtrack");
  let soundtrack = library_track;
  const movieSettings = { movieDirectory: null };
  const marked = [];
  context.memoryManager = {
    getSuggestion: async (id) => (id === suggestion.id ? structuredClone(suggestion) : undefined),
    getSettings: async () => ({ ...movieSettings }),
    getState: async () => ({ suggestions: [structuredClone(suggestion)] }),
    getReserve: async () => [],
    resolveSoundtrack: async (id, sid) => sid === suggestion.id && id === `original:${suggestion.id}`
      ? { id, name: "Original audio", source: "original", rights: "" }
      : (sid === suggestion.id && id === soundtrack.id ? { ...soundtrack } : undefined),
    markDownloaded: async (id) => { marked.push(id); throw new Error("bookkeeping failure"); },
    updateSettings: async (update) => update,
    dismiss: async (id) => id,
    getSoundtracks: async (id) => id,
  };
  let renderBehavior = async () => {};
  context.memoryExporter = {
    cancelled: 0,
    cancel() { this.cancelled++; },
    render: async (...args) => { renderCalls.push(args); await renderBehavior(...args); },
  };
  const exportMemory = handler("export-memory");
  const viewMemory = handler("view-memory");
  const cancel = handler("cancel-memory-export");
  const options = { suggestionId: "s1", soundtrackId: library_track.id, count: 1, duration: 60, orientation: "auto", originalAudio: 0.2 };

  await test("library soundtracks need no rights checkbox (personal use); malformed flags are still rejected", async () => {
    const before = renderCalls.length;
    context.__dialog = async () => ({ canceled: true });
    for (const value of [undefined, false])
      assert.deepEqual(plain(await exportMemory(null, { ...options, rightsAcknowledged: value })), { ok: false, canceled: true });
    assert.match((await exportMemory(null, { ...options, rightsAcknowledged: "true" })).error, /Invalid/);
    assert.equal(renderCalls.length, before);
    dialogCalls.length = 0;
    context.__dialog = async () => ({ canceled: false, filePath: path.join(root, "out.mp4") });
  });

  await test("Memories reject clear graphic vectors while preserving ambiguous photo vectors", () => {
    const prompts = {
      good: [new Float32Array([0, 1, 0, 0])],
      nonPhoto: [new Float32Array([1, 0, 0, 0])],
    };
    assert.equal(context.memoryImageIsObviousNonPhoto(new Float32Array([0.9, 0.1, 0, 0]), prompts), true,
      "a strong screenshot or graphic match is excluded");
    assert.equal(context.memoryImageIsObviousNonPhoto(new Float32Array([0.1, 0.9, 0, 0]), prompts), false,
      "a clear photo match remains eligible");
    assert.equal(context.memoryImageIsObviousNonPhoto(new Float32Array([0.3, 0.28, 0, 0]), prompts), false,
      "ambiguous content is kept to avoid false exclusions");
    assert.equal(context.memoryImageIsObviousNonPhoto(new Float32Array([0.9, 0.1, 0, 0]), { good: [], nonPhoto: [] }), false,
      "unavailable classifier prompts fail open");
  });

  await test("photo metadata only affects ranking; every safe indexed image stays eligible", async () => {
    for (const bad of ["/x/icon.jpg", "/x/Covers/a.jpg", "/x/Some.app/Contents/Resources/a.jpg", "/x/shot.png",
      "/x/node_modules/pkg/a.jpg", "/Music/Black Lips/Album/folder.jpg"])
      assert.equal(isPersonalPhotoPath(bad, 4_000_000), false, bad);
    assert.equal(isPersonalPhotoPath("/Photos/2019/IMG_1.jpg", 50_000), false, "very small files remain excluded");
    assert.equal(isPersonalPhotoPath("/Photos/2019/IMG_2.jpg", 100_000), process.arch === "x64",
      "x64 builds accept compressed phone photos below the legacy 150 KB floor");
    assert.equal(isPersonalPhotoPath("/Photos/2019/IMG_1.HEIC", 2_500_000), true);
    assert.equal(isPersonalPhotoPath("/Music/Black Lips/Arabia Mountain/art.jpg", 900_000,
      new Set(["/Music/Black Lips/Arabia Mountain"])), false, "images beside songs are album art");
    assert.equal(isPromptedVideoPhotoEligible("/__phone__/ios/id/DCIM/IMG_1.jpg", 30_000, undefined, true), true,
      "prompted videos admit compressed phone photos above the hard floor");
    assert.equal(isPromptedVideoPhotoEligible("/Photos/IMG_1.jpg", 30_000, undefined, false), false,
      "local photo eligibility keeps its existing cutoff");
    assert.equal(isPromptedVideoPhotoEligible("/__phone__/ios/id/Screenshots/IMG_2.jpg", 30_000, undefined, true), false,
      "the phone allowance does not admit screenshot folders");
    assert.equal(isPromptedVideoPhotoEligible("/__phone__/ios/id/DCIM/IMG_3.jpg", 23_999, undefined, true), false,
      "tiny phone files remain excluded");
    const activeImage = { name: "in-flight.jpg", path: "/Photos/in-flight.jpg" };
    assert.deepEqual(currentPromptedVideoIndexingImage([activeImage], "indexing", activeImage.name, new Set()), activeImage);
    assert.equal(currentPromptedVideoIndexingImage([activeImage], "paused", activeImage.name, new Set()), undefined);
    assert.equal(currentPromptedVideoIndexingImage([activeImage, { ...activeImage, path: "/Other/in-flight.jpg" }],
      "indexing", activeImage.name, new Set()), undefined, "ambiguous basenames are never guessed");
    assert.equal(currentPromptedVideoIndexingImage([activeImage], "indexing", activeImage.name, new Set([activeImage.path])), undefined);
    context.memoryExifCache.set("/q/low.jpg", { camera: false, width: 640, height: 480, takenAt: 0 });
    context.memoryExifCache.set("/q/cover.jpg", { camera: false, width: 1500, height: 1500, takenAt: 0 });
    context.memoryExifCache.set("/q/camera.jpg", { camera: true, width: 4032, height: 3024, takenAt: 1234 });
    const kept = await context.applyMemoryPhotoQuality(["low", "cover", "camera"].map((name) =>
      ({ path: `/q/${name}.jpg`, name, type: "image", modified: 1, score: 10 })));
    assert.deepEqual(plain(kept.map((item) => item.name)), ["low", "cover", "camera"]);
    assert.equal(kept[2].modified, 1234, "capture date replaces file time");
    assert(kept[2].score > kept[0].score, "camera metadata is only a ranking hint");
    assert(kept[1].score < 10, "generic square art is down-ranked, never excluded");
  });

  await test("successful export: sanitized options, scratch images, cleanup, ok despite bookkeeping error", async () => {
    let scratch;
    renderBehavior = async (card, opts, track, destination) => {
      assert.deepEqual({ ...opts }, {
        suggestionId: options.suggestionId, soundtrackId: options.soundtrackId,
        count: options.count, duration: options.duration, originalAudio: options.originalAudio,
        rightsAcknowledged: true,
      });
      assert.equal(track.path, library_track.path);
      assert.equal(destination, path.join(root, "out.mp4"));
      scratch = context.memoryExportScratch;
      assert(scratch && fs.existsSync(scratch) && scratch.startsWith(os.tmpdir()));
      const prepared = await context.prepareMemoryExportImage(exportPhoto);
      assert(prepared.startsWith(scratch + path.sep) && prepared !== exportPhoto);
      assert.equal(await fsp.readFile(prepared, "utf8"), `converted:${exportPhoto}`);
      assert.equal(await context.prepareMemoryExportImage(exportPhoto), prepared, "repeat source reuses file");
      assert.equal(await context.prepareMemoryExportImage("/x/photo.bad"), "/x/photo.bad", "falls back to read-only original");
    };
    const result = await exportMemory(null, { ...options, rightsAcknowledged: true, injected: "ignored" });
    assert.deepEqual(plain(result), { ok: true, path: path.join(root, "out.mp4") });
    assert.equal(dialogCalls.at(-1)[1].defaultPath, "Beach  Days.mp4");
    assert.deepEqual(marked, ["s1"]);
    assert(!fs.existsSync(scratch), "scratch removed");
    assert.equal(context.memoryExportScratch, null);
    assert.equal(context.memoryExportRunning, false);
    await assert.rejects(context.prepareMemoryExportImage(exportPhoto), /not active/);
    renderBehavior = async () => {};
  });

  await test("full-resolution memory is pre-rendered into a persistent cache; viewing never renders", async () => {
    const dialogsBefore = dialogCalls.length;
    const markedBefore = marked.length;
    let renderCount = 0;
    let midRender = null;
    renderBehavior = async (card, opts, track, destination, onProgress) => {
      renderCount++;
      assert.equal(card.id, suggestion.id);
      assert.equal(track.source, "original");
      assert.equal(opts.count, 1);
      assert.equal(opts.duration, 60, "every preview renders for one minute");
      assert(destination.includes(`${path.sep}memories${path.sep}previews${path.sep}`));
      onProgress({ suggestionId: card.id, phase: "rendering", completed: 1, total: 2, message: "" });
      midRender = plain(context.memoryPreviewStatus.get(card.id));
      await fsp.writeFile(destination, "full-resolution movie");
    };
    const pendingView = viewMemory(null, suggestion.id);
    assert.equal(context.memoryPreviewStatus.get(suggestion.id), undefined);
    const first = context.prepareMemoryPreviews([suggestion]);
    assert.equal(context.memoryPreviewStatus.get(suggestion.id).status, "queued");
    assert.equal(context.prepareMemoryPreviews([suggestion]), context.memoryPreviewQueue, "a queued story is not queued twice");
    assert.match((await pendingView).error, /being prepared/, "viewing before the movie exists explains it is preparing");
    await first;
    assert.equal(midRender.status, "rendering");
    assert.equal(midRender.progress, 0.5);
    assert.equal(context.memoryPreviewStatus.get(suggestion.id).status, "ready");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(previewEvents.length >= 1 && previewEvents.length <= 2, "progress events are throttled");
    assert.equal(plain(await context.memoryPreviewStatuses([suggestion]))[suggestion.id].status, "ready");
    const cachedPath = path.join(userData, "memories", "previews", context.memoryPreviewFileName(suggestion));
    assert.equal(await fsp.readFile(cachedPath, "utf8"), "full-resolution movie");
    await context.prepareMemoryPreviews([suggestion]);
    assert.equal(renderCount, 1, "A ready preview is reused rather than rendered again");
    const result = await viewMemory(null, suggestion.id);
    assert.deepEqual(plain(result), { ok: true, path: cachedPath });
    assert.equal(await fsp.readFile(result.path, "utf8"), "full-resolution movie");
    assert.equal(dialogCalls.length, dialogsBefore, "Viewing must not ask where to save");
    assert.equal(marked.length, markedBefore, "Viewing must not mark a movie as downloaded");
    assert.equal(renderCount, 1, "Opening the card is a cache-only operation");
    // A chosen destination receives a copy, so the movie survives with the source offline.
    movieSettings.movieDirectory = path.join(root, "chosen");
    await context.prepareMemoryPreviews([suggestion]);
    const saved = path.join(root, "chosen", "Silo Memories", context.memoryPreviewFileName(suggestion));
    assert.equal(await fsp.readFile(saved, "utf8"), "full-resolution movie");
    assert.equal(renderCount, 1, "Changing destination copies instead of re-rendering");
    assert.deepEqual(plain(await viewMemory(null, suggestion.id)), { ok: true, path: saved });
    // One failing story never aborts preparation of the others.
    renderBehavior = async () => { throw new Error("source offline"); };
    await context.prepareMemoryPreviews([{ ...suggestion, id: "other" }, suggestion]);
    assert.equal(context.memoryPreviewStatus.get("other").status, "failed", "failed stories are marked so cards can hide them");
    assert.equal(context.memoryPreviewStatus.get(suggestion.id).status, "ready");
    movieSettings.movieDirectory = null;
    renderBehavior = async () => {};
  });

  await test("suggestion and soundtrack are revalidated after the save dialog", async () => {
    const renders = renderCalls.length;
    context.__dialog = async () => { context.hiddenPaths = new Set([path.dirname(exportPhoto)]); return { canceled: false, filePath: path.join(root, "o.mp4") }; };
    let result = await exportMemory(null, { ...options, rightsAcknowledged: true });
    assert.match(result.error, /failed the current content safety check/);
    context.hiddenPaths = new Set();
    context.__dialog = async () => { context.banned = new Set([library_track.path]); return { canceled: false, filePath: path.join(root, "o.mp4") }; };
    result = await exportMemory(null, { ...options, rightsAcknowledged: true });
    assert.match(result.error, /Soundtrack/);
    context.banned = new Set();
    assert.equal(renderCalls.length, renders);
  });

  await test("cancellation during dialog and render; concurrent export rejected", async () => {
    const renders = renderCalls.length;
    context.__dialog = async () => { await cancel(null); return { canceled: false, filePath: path.join(root, "o.mp4") }; };
    assert.deepEqual(plain(await exportMemory(null, { ...options, rightsAcknowledged: true })), { ok: false, canceled: true });
    assert.equal(renderCalls.length, renders);
    context.__dialog = async () => ({ canceled: true });
    assert.deepEqual(plain(await exportMemory(null, { ...options, rightsAcknowledged: true })), { ok: false, canceled: true });
    context.__dialog = async () => ({ canceled: false, filePath: path.join(root, "o.mp4") });
    renderBehavior = async () => { throw new MemoryExportCancelledError(); };
    assert.deepEqual(plain(await exportMemory(null, { ...options, rightsAcknowledged: true })), { ok: false, canceled: true });
    renderBehavior = async () => { throw new Error("FFmpeg failed (1): boom"); };
    assert.deepEqual(plain(await exportMemory(null, { ...options, rightsAcknowledged: true })), { ok: false, error: "FFmpeg failed (1): boom" });
    let release;
    renderBehavior = () => new Promise((resolve) => { release = resolve; });
    const first = exportMemory(null, { ...options, rightsAcknowledged: true });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    assert.match((await exportMemory(null, { ...options, rightsAcknowledged: true })).error, /already rendering/);
    release();
    assert.equal((await first).ok, true);
    soundtrack = { id: "original:s1", name: "Original audio", source: "original", rights: "" };
    renderBehavior = async () => {};
    assert.equal((await exportMemory(null, { ...options, soundtrackId: "original:s1" })).ok, true, "original audio needs no acknowledgement");
    await cancel(null);
    assert.equal(context.memoryExportCancelRequested, false, "idle cancel leaves no stale flag");
  });

  await test("settings and id validation", async () => {
    const update = handler("update-memory-settings");
    assert.deepEqual(plain(await update(null, { showOnLaunch: false })), { showOnLaunch: false });
    assert.deepEqual(plain(await update(null, {})), {});
    for (const bad of [null, "x", [], { showOnLaunch: "yes" }, { extra: 1 }, { removeAfterDownload: 1 }, { movieDirectory: "/tmp/movies" }])
      assert.throws(() => update(null, bad), /Invalid memory settings/);
    for (const name of ["dismiss-memory", "get-memory-soundtracks"]) {
      const fn = handler(name);
      for (const bad of [undefined, 1, "", "x".repeat(201)]) assert.throws(() => fn(null, bad), /Invalid memory/);
      assert.equal(await fn(null, "s1"), "s1");
    }
  });
}

run()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    console.log(results.join("\n"));
  });
