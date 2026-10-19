/* Opt-in regression: run with `node test/runDeferredMemoryAudioTest.cjs`. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../src/memoryManager.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true },
}).outputText;
const implementation = { exports: {} };
const typeSource = fs.readFileSync(path.join(__dirname, "../src/memoryTypes.ts"), "utf8");
const typeModule = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(typeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(require, typeModule, typeModule.exports);
const managerRequire = (id) => id === "./memoryTypes" ? typeModule.exports : require(id);
new Function("require", "module", "exports", compiled)(managerRequire, implementation, implementation.exports);
const { MemoryManager } = implementation.exports;
const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8");
const exporterSource = fs.readFileSync(path.join(__dirname, "../src/memoryExporter.ts"), "utf8");

function photos(prefix, count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/fixture/${prefix}/${index}.jpg`,
    name: `${index}.jpg`,
    type: "image",
    modified: index * 1000,
  }));
}

const libraryId = (filePath) =>
  `library:${crypto.createHash("sha256").update(filePath).digest("hex")}`;

test("deferred audio indexing assigns distinct theme-matched songs and persists them", async (t) => {
  const temporaryRoot = process.env.SILO_TEST_TMPDIR || os.tmpdir();
  await fsp.mkdir(temporaryRoot, { recursive: true });
  const root = await fsp.mkdtemp(path.join(temporaryRoot, "memory-deferred-audio-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let audioFiles = [];
  const manager = new MemoryManager(root, {
    search: async (query) => photos(query),
    thumb: async () => null,
    listAudio: async () => audioFiles,
    isAllowed: async (filePath) => !filePath.startsWith("/music/"),
    isAudioAvailable: async (file) => file.path.startsWith("/music/"),
  });

  assert.match(mainSource,
    /sendToRenderer\("audio-library-cache-changed", snapshot\.scannedAt\);\s*void refreshMemorySoundtracksAfterAudioIndexing\(\)/,
    "successful audio indexing must trigger the saved-memory soundtrack refresh");
  assert.match(mainSource,
    /async function refreshMemorySoundtracksAfterAudioIndexing\(\): Promise<void> \{[\s\S]*?memoryManager\.refreshSoundtracks\(\)/,
    "the index-completion handler must assign newly indexed library tracks");
  assert.match(mainSource,
    /memoryPreviewStatus\.delete\(id\);[\s\S]*?prepareMemoryPreviews\(changedCards\)/,
    "previews created before audio indexing must be regenerated with the chosen songs");

  const audioStage = /id: "audio",([\s\S]*?)id: "quality"/.exec(mainSource);
  assert.ok(audioStage, "the automatic audio recovery stage must exist");
  assert.doesNotMatch(audioStage[1], /searchSettled\(\)/,
    "paused or errored search must not block independent audio discovery");
  assert.doesNotMatch(audioStage[1], /analysisIdle\(\)/,
    "long-running photo and face indexing must not hold up soundtrack discovery");
  assert.match(mainSource, /\(\) => semanticIndexer\.isSearchActive\(\)/,
    "the throttled audio scan must still yield while a user search is active");
  assert.match(mainSource, /isAudioAvailable: async \(file\)[\s\S]*?resolveLocalPath\(file\.path\)/,
    "library songs must be validated as audio files without visual photo safety");
  const exportVerifier = /async function verifyMemoryExport\([\s\S]*?\n\}/.exec(mainSource);
  assert.ok(exportVerifier, "the export verifier must exist");
  assert.match(exportVerifier[0], /resolveLocalPath\(soundtrack\.path\)/,
    "library exports must validate the resolved local audio path");
  assert.doesNotMatch(exportVerifier[0], /memoryAllowed\(soundtrack\.path\)/,
    "the photo-only safety gate must not reject the selected soundtrack");
  assert.match(exporterSource, /musicPath = await this\.deps\.resolveLocalPath\(soundtrack\.path\)/,
    "preview/export rendering must open the selected song through the source resolver");
  assert.match(exporterSource, /amix=inputs=2:duration=first/,
    "the selected library song must be mixed into the final movie audio");

  const generated = await manager.generate();
  assert.equal(generated.suggestions.length, 5);
  assert.ok(generated.suggestions.every((card) => !card.soundtrackId),
    "cards created before audio indexing completes should wait for real library songs");

  audioFiles = [
    { name: "Beach Holiday Waves.mp3", path: "/music/Seaside Ensemble/Beach Holiday Waves.mp3", size: 2_000_000 },
    { name: "Cake Dessert Treats.mp3", path: "/music/Sweet Kitchen/Cake Dessert Treats.mp3", size: 2_100_000 },
    { name: "Rally Car Racing.mp3", path: "/music/Race Crew/Rally Car Racing.mp3", size: 2_200_000 },
    { name: "Stormy Sea Ocean.mp3", path: "/music/Sea Voices/Stormy Sea Ocean.mp3", size: 2_300_000 },
    { name: "Candid Portrait Expressions.mp3", path: "/music/Portrait Band/Candid Portrait Expressions.mp3", size: 2_400_000 },
  ];
  const refreshed = await manager.refreshSoundtracks();
  assert.equal(refreshed.changedIds.length, 5);
  assert.equal(new Set(refreshed.state.suggestions.map((card) => card.soundtrackId)).size, 5,
    "stories should not repeat a library track");

  const themes = [
    ["Beach Days", /beach|holiday/i],
    ["Sweet Treats", /cake|dessert|treat/i],
    ["Rally Car Weekend", /rally|car|racing/i],
    ["Stormy Seas", /stormy|sea|ocean/i],
    ["Portraits", /candid|portrait|expression/i],
  ];
  for (const [title, expectedTrack] of themes) {
    const card = refreshed.state.suggestions.find((item) => item.title === title);
    assert.ok(card, `missing ${title} story`);
    const track = audioFiles.find((file) => libraryId(file.path) === card.soundtrackId);
    assert.ok(track && expectedTrack.test(`${track.name} ${track.path}`),
      `${title} should choose a matching library song, got ${track?.name ?? "no track"}`);
  }

  const firstTrackId = refreshed.state.suggestions[0].soundtrackId;
  assert.ok(firstTrackId);
  assert.equal((await manager.resolveSoundtrack(firstTrackId, refreshed.state.suggestions[0].id)).source, "library",
    "selected source songs must pass audio availability checks even when image safety rejects them");

  const restarted = new MemoryManager(root, {
    search: async (query) => photos(query),
    thumb: async () => null,
    listAudio: async () => audioFiles,
    isAllowed: async (filePath) => !filePath.startsWith("/music/"),
    isAudioAvailable: async (file) => file.path.startsWith("/music/"),
  });
  const persisted = await restarted.getState();
  assert.deepEqual(persisted.suggestions.map((card) => card.soundtrackId),
    refreshed.state.suggestions.map((card) => card.soundtrackId));
});
