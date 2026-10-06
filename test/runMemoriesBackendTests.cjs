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
  MEMORY_MAGIC_SCORE_THRESHOLD,
  MEMORY_EXPORT_LIMITS,
  selectMemoryPhotoCandidates,
} = require("../src/memoryTypes.ts");
const { MemoryManager } = require("../src/memoryManager.ts");
const { AestheticScorer } = require("../src/aestheticScorer.ts");
const { isPersonalPhotoPath } = require("../src/memoryDiscovery.ts");
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
  return [0.3, 0, 0, 0];
};
const opened = [];
const thumbnailCalls = [];
const searchCalls = [];
const magicRankCalls = [];
const dialogCalls = [];
const renderCalls = [];
const previewEvents = [];
const magicScores = new Map();
let metadataReads = 0;
let searchResults = [];
const progress = { semantic: "complete", face: "complete" };

const context = vm.createContext({
  console, path, os, URL, Buffer, Date, Math, Number, String, Array, Set, Map, Object, Error, Promise,
  Float32Array, JSON,
  createHash: crypto.createHash,
  fsPromises: {
    ...fsp,
    opendir: async (directory, ...rest) => { opened.push(directory); return fsp.opendir(directory, ...rest); },
    readdir: async (directory, ...rest) => {
      if (directory === path.join(userData, "memories", "previews")) return fsp.readdir(directory, ...rest);
      throw new Error("Memories must stream library directories with opendir");
    },
  },
  app: { getPath: (name) => { assert.equal(name, "userData"); return userData; } },
  indexStoragePath: (...segments) => path.join(userData, ...segments),
  stateStore: { getState: () => { metadataReads++; return { fileMetadata: context.__metadata }; } },
  __metadata: {},
  contentSettingsStore: { getPublicSettings: () => { throw new Error("Memories must not consult reveal toggles"); } },
  hiddenPaths: new Set(),
  getHiddenFolderPaths: (except) => { assert.equal(except, undefined); return context.hiddenPaths; },
  faceIndexer: { getBannedPhotoPaths: () => context.banned, getProgress: () => ({ status: progress.face }) },
  aestheticScorer: {
    rankDistinct: async (items, preset, threshold) => {
      magicRankCalls.push({ items, preset, threshold });
      return { order: items.map((item) => item.path), scores: Object.fromEntries(items.map((item) => [item.path, magicScores.get(item.path) ?? 50])), analyzed: items.length, total: items.length, running: false };
    },
    filterSimilar: async (paths, threshold) => { assert.equal(threshold, 0.85); return paths; },
  },
  banned: new Set(),
  semanticUnsafePaths: new Set(),
  fileTextLooksExplicit, NSFW_VISUAL_PROMPT, SAFE_VISUAL_PROMPT, MEMORY_DURATION_SECONDS, MEMORY_EXPORT_LIMITS,
  MEMORY_DEFAULT_SELECTION_COUNT, MEMORY_MAGIC_SCORE_THRESHOLD, selectMemoryPhotoCandidates,
  getDefaultMemoryDuration, isMemoryDurationAllowed, MemoryExportCancelledError,
  isRemotePath: (value) => value.startsWith("/__phone__/"),
  PIPELINE_BUSY_STATUSES: new Set(["scanning", "loading-model", "indexing"]),
  getAllIndexSources: async () => [library, "/__phone__/ios/ready"],
  semanticIndexer: {
    getProgress: () => ({ status: progress.semantic }),
    search: async (...args) => { searchCalls.push(args); return searchResults; },
    embedPrompts: async (prompts) => {
      assert.deepEqual(plain(prompts.slice(1)), [`a photo of ${NSFW_VISUAL_PROMPT}`, `a photo of ${SAFE_VISUAL_PROMPT}`]);
      return [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0]), new Float32Array([0, 0, 1, 0])];
    },
    embedPreviewImage: async (file) => {
      assert(file.startsWith(path.join(userData, "thumbnail-cache") + path.sep), "frame must come from thumbnail-cache");
      return new Float32Array(JSON.parse(await fsp.readFile(file, "utf8")));
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
  memoryExporter: null,
  memoryExportRunning: false,
  memoryExportCancelRequested: false,
  memoryExportScratch: null,
  memoryPreviewQueue: Promise.resolve(),
  memoryRenderQueue: Promise.resolve(),
  memoryFrameVectors: new Map(),
  memoryUnsafeVideoPaths: new Set(),
  memoryMetadataSnapshot: null,
  MEMORY_PREVIEW_RENDER_VERSION: 7,
  isPersonalPhotoPath,
  exifr,
  audioLibraryCache: null,
  memoryMusicDirectoryCache: null,
  memoryExifCache: new Map(),
  MEMORY_DEFAULT_MOVIE_DIRECTORY: () => path.join(userData, "memories", "previews"),
  consumeDemoMemoryPreview: async () => true,
  runtimeLog() {},
  MEMORY_DUPLICATE_SIMILARITY: 0.85,
  MEMORY_VIDEO_EXTENSIONS: new Set([".mov", ".mp4", ".m4v", ".webm"]),
});
function evaluate(source) {
  return vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
}
for (const name of [
  "memoryFileMetadata", "memoryAllowed", "memoryLiveVideo", "memoryThumbnailFile", "memoryVideoCandidates",
  "memoryDot", "filterMemoryPhotos", "searchMemoryMedia", "readMemoryExif", "applyMemoryPhotoQuality",
  "memoryMusicDirectories", "prepareMemoryExportImage", "memoryExportOptions", "verifyMemoryExport",
  "memoryPreviewOptions", "memoryPreviewFileName", "memoryMovieDirectory", "findMemoryMovie", "runMemoryRender",
  "prepareMemoryPreviewsNow", "prepareMemoryPreviews", "prepareAllMemoryPreviews", "setMemoryPreviewStatus",
  "memoryPreviewStatuses",
]) {
  assert(functions.has(name), `missing ${name}`);
  evaluate(functions.get(name).getText(ast));
}
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

  await test("memoryAllowed is strict regardless of reveal toggles", () => {
    const ok = path.join(library, "ok.jpg");
    assert.equal(context.memoryAllowed(ok), true);
    for (const bad of [undefined, null, 4, "", "a\0b"]) assert.equal(context.memoryAllowed(bad), false);
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
      ...Array.from({ length: 45 }, (_, i) => ({ path: path.join(story, `p${i}.jpg`), name: `p${i}.jpg`, type: "image",
        modified: 1000 + i, confidence: 90 - i })),
      { path: path.join(story, "doc.pdf"), name: "doc.pdf", type: "document", modified: 1, confidence: 99 },
      { path: "/__phone__/ios/ready/remote.jpg", name: "remote.jpg", type: "image", modified: 1, confidence: 10 },
    ];
    context.semanticUnsafePaths = new Set([path.join(story, "p0.jpg")]);
    opened.length = 0;
    const hits = await context.searchMemoryMedia("beach");
    assert.deepEqual(plain(searchCalls.at(-1).slice(0, 3)), ["beach", 24, [library, "/__phone__/ios/ready"]]);
    assert(hits.length <= 50, "manager only reads the first 50 hits");
    const photos = hits.filter((hit) => hit.type === "image");
    assert.equal(photos.length, 20);
    assert.equal(magicRankCalls.at(-1).preset, "variety");
    assert.equal(magicRankCalls.at(-1).threshold, 0.85);
    assert(!hits.some((hit) => hit.path.endsWith("p0.jpg") || hit.path.endsWith("doc.pdf")));
    assert.equal(photos.find((hit) => hit.path.endsWith("p1.jpg")).score, 50.089);
    const videos = hits.filter((hit) => hit.type === "video");
    assert.deepEqual(plain(videos.map((hit) => path.basename(hit.path))), ["beach.mov"]);
    assert.equal(videos[0].score, 50);
    assert(context.memoryUnsafeVideoPaths.has(path.join(story, "crowd.mov")));
    assert.equal(context.memoryAllowed(path.join(story, "crowd.mov")), false, "unsafe clip blocked for saved suggestions");
    assert.deepEqual(plain(opened), [story]);
    for (let i = 1; i < hits.length; i++) assert(hits[i - 1].score >= hits[i].score);
    context.semanticUnsafePaths = new Set();
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
    assert.equal(searchCalls.length, callsBefore + 1, "search must run against the available index");
    assert.equal(searchCalls.at(-1)[0], "already indexed");
    progress.semantic = "complete";
    progress.face = "complete";
    assert.deepEqual(plain(await context.searchMemoryMedia("   ")), []);
  });

  await test("MemoryManager generates from indexed photos while indexing continues", async () => {
    const story = path.join(library, "story");
    searchResults = Array.from({ length: 10 }, (_, i) => ({ path: path.join(story, `p${i}.jpg`), name: `p${i}.jpg`,
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

  await test("memory photos: icons, covers, screenshots, low-res and album-folder art are excluded", async () => {
    for (const bad of ["/x/icon.jpg", "/x/Covers/a.jpg", "/x/Some.app/Contents/Resources/a.jpg", "/x/shot.png",
      "/x/node_modules/pkg/a.jpg", "/Music/Black Lips/Album/folder.jpg"])
      assert.equal(isPersonalPhotoPath(bad, 4_000_000), false, bad);
    assert.equal(isPersonalPhotoPath("/Photos/2019/IMG_1.jpg", 50_000), false, "tiny files are thumbnails or icons");
    assert.equal(isPersonalPhotoPath("/Photos/2019/IMG_1.HEIC", 2_500_000), true);
    assert.equal(isPersonalPhotoPath("/Music/Black Lips/Arabia Mountain/art.jpg", 900_000,
      new Set(["/Music/Black Lips/Arabia Mountain"])), false, "images beside songs are album art");
    context.memoryExifCache.set("/q/low.jpg", { camera: true, width: 640, height: 480, takenAt: 0 });
    context.memoryExifCache.set("/q/cover.jpg", { camera: false, width: 1500, height: 1500, takenAt: 0 });
    context.memoryExifCache.set("/q/camera.jpg", { camera: true, width: 4032, height: 3024, takenAt: 1234 });
    const kept = await context.applyMemoryPhotoQuality(["low", "cover", "camera"].map((name) =>
      ({ path: `/q/${name}.jpg`, name, type: "image", modified: 1, score: 10 })));
    assert.deepEqual(plain(kept.map((item) => item.name)), ["camera"]);
    assert.equal(kept[0].modified, 1234, "capture date replaces file time");
    assert(kept[0].score > 10, "camera photos rank higher");
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
    assert.match(result.error, /newly hidden/);
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
    assert.deepEqual(plain(await update(null, { showOnLaunch: false, extra: 1 })), { showOnLaunch: false });
    assert.deepEqual(plain(await update(null, {})), {});
    for (const bad of [null, "x", [], { showOnLaunch: "yes" }, { removeAfterDownload: 1 }])
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
