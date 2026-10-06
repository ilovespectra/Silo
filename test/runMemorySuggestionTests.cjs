/* Model-free backend regression tests. No Electron, models, inventory scans, or exported files. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const source = require("node:fs").readFileSync(path.join(__dirname, "../src/memoryManager.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true },
}).outputText;
const implementation = { exports: {} };
const typeSource = require("node:fs").readFileSync(path.join(__dirname, "../src/memoryTypes.ts"), "utf8");
const typeModule = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(typeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(require, typeModule, typeModule.exports);
const managerRequire = (id) => id === "./memoryTypes" ? typeModule.exports : require(id);
new Function("require", "module", "exports", compiled)(managerRequire, implementation, implementation.exports);
const { MemoryManager } = implementation.exports;
const { getDefaultMemoryDuration, MEMORY_DEFAULT_SELECTION_COUNT } = typeModule.exports;

function photos(prefix, count = 8, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    path: `/fake/${prefix}/${i}.jpg`, name: `${i}.jpg`, type: "image", modified: offset + i * 1000,
  }));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-suggestions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queries = [];
  const thumbnails = [];
  const blocked = new Set();
  const deps = {
    search: async query => { queries.push(query); return photos(query); },
    thumb: async file => { thumbnails.push(file); return `preview:${file}`; },
    listAudio: async () => [],
    isAllowed: async file => !blocked.has(file),
    ...overrides,
  };
  const manager = new MemoryManager(root, deps);
  return { root, statePath: path.join(root, "memories", "state.json"), manager, deps, queries, thumbnails, blocked };
}

test("defaults, five cards, lazy covers, detached state, persistent settings and theme rotation", async t => {
  const f = await fixture(t);
  const initial = await f.manager.getState();
  assert.deepEqual(initial.settings, { showOnLaunch: true, removeAfterDownload: false, movieDirectory: null });
  assert.deepEqual(initial.suggestions, []);
  const state = await f.manager.generate();
  assert.equal(state.generating, false);
  assert.equal(state.suggestions.length, 5);
  assert.equal(f.queries.length, 5);
  assert.equal(f.thumbnails.length, 15);
  assert.deepEqual(state.suggestions.map(card => card.title), ["Beach Days", "Sweet Treats", "Rally Car Weekend", "Stormy Seas", "Portraits"]);
  for (const card of state.suggestions) {
    assert.equal(card.media.filter(item => item.thumbnailUrl).length, 3);
    assert.ok(card.media.slice(3).every(item => !item.thumbnailUrl));
    assert.ok(card.media.length >= 4 && card.media.length <= 24);
    assert.equal(card.defaultDuration, getDefaultMemoryDuration(Math.min(MEMORY_DEFAULT_SELECTION_COUNT, card.media.length)));
    assert.equal(card.orientation, undefined, "generated suggestions no longer carry portrait framing metadata");
  }
  assert.equal(new Set(state.suggestions.map(card => card.defaultDuration)).size, 1, "equal item counts receive the same brisk default pace");
  const photoPath = state.suggestions[0].media[0].path;
  state.suggestions[0].media[0].path = "/tampered";
  state.settings.showOnLaunch = false;
  assert.equal((await f.manager.getState()).suggestions[0].media[0].path, photoPath);
  assert.equal((await f.manager.getState()).settings.showOnLaunch, true);
  await f.manager.updateSettings({ showOnLaunch: false, unknown: true, removeAfterDownload: "invalid" });
  const restarted = new MemoryManager(f.root, f.deps);
  assert.equal((await restarted.getState()).settings.showOnLaunch, false);
  assert.equal((await restarted.getState()).suggestions.length, 5);
  assert.equal(f.thumbnails.length, 15, "cache read must not request previews");
  const second = await restarted.generate(true);
  assert.equal(second.suggestions[0].title, "Cozy Family");
  const titles = [...(await f.manager.getState()).suggestions.map(card => card.title), ...second.suggestions.map(card => card.title)];
  titles.push(...(await restarted.generate(true)).suggestions.map(card => card.title));
  titles.push(...(await restarted.generate(true)).suggestions.map(card => card.title));
  assert.equal(new Set(titles).size, 20, "twenty distinct creative themes");
  assert.equal((await restarted.generate(true)).suggestions[0].title, "Beach Days");
  const saved = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(saved.cursor, 5);
  assert.equal(saved.suggestions.length, 5);
  assert.equal(saved.settings.showOnLaunch, false);
});

test("custom topic searches locally, keeps its wording, and selects a matching library song", async t => {
  const f = await fixture(t, {
    listAudio: async () => [{ name: "Sunny Beach Melody.mp3", path: "/music/Sunny Beach Melody.mp3", size: 2_000_000 }],
  });
  const query = "sunny days at the beach";
  const state = await f.manager.generate(false, query);
  const [memory] = state.suggestions;

  assert.deepEqual(f.queries, [query]);
  assert.equal(state.suggestions.length, 1);
  assert.equal(memory.title, "Sunny Days at the Beach");
  assert.equal(memory.query, query);
  assert.equal(memory.mood, "bright");
  assert.match(memory.storyKey, /^custom:/);
  assert.match(memory.soundtrackId, /^library:/);
  assert.match(state.message, /Created a memory for/);
});

test("custom topics go to the front without discarding existing suggestions; invalid topics do not search", async t => {
  const f = await fixture(t);
  const initial = await f.manager.generate();
  const oldIds = initial.suggestions.map(memory => memory.id);
  const custom = await f.manager.generate(false, "rainy Sundays");

  assert.equal(custom.suggestions[0].title, "Rainy Sundays");
  assert.equal(custom.suggestions.length, 5);
  assert.equal(custom.suggestions.filter(memory => oldIds.includes(memory.id)).length, 4);
  assert.equal(custom.reserveCount, 1);
  const searchesBeforeInvalid = f.queries.length;
  const invalid = await f.manager.generate(false, "  ");
  assert.equal(f.queries.length, searchesBeforeInvalid);
  assert.match(invalid.message, /between 3 and 120 characters/);
});

test("Magic photo filtering removes near-duplicates from generated and persisted stories", async t => {
  const duplicates = new Set(["1.jpg", "3.jpg", "5.jpg", "7.jpg"]);
  const filterImages = async paths => paths.filter(filePath => !duplicates.has(path.basename(filePath)));
  const f = await fixture(t, { search: async query => photos(query, 8), filterImages });
  const generated = await f.manager.generate();
  assert.equal(generated.suggestions.length, 5);
  assert.ok(generated.suggestions.every(card => card.media.filter(item => item.type === "image").length === 4));
  const restarted = new MemoryManager(f.root, f.deps);
  const loaded = await restarted.getState();
  assert.equal(loaded.suggestions.length, 5);
  assert.ok(loaded.suggestions.every(card => card.media.filter(item => item.type === "image").length === 4));
});

test("legacy suggestions normalize to the fixed one-minute default", async t => {
  const f = await fixture(t);
  await f.manager.getState();
  const legacy = {
    id: "legacy-portrait", title: "Old portrait", description: "Saved story", query: "people",
    mood: "gentle", orientation: "portrait", defaultDuration: 61, createdAt: 10,
    media: photos("legacy", 4),
  };
  await fs.writeFile(f.statePath, JSON.stringify({ version: 1, cursor: 0, dismissed: [], settings: {}, suggestions: [legacy] }));
  const migrated = await new MemoryManager(f.root, f.deps).getState();
  assert.equal(migrated.suggestions[0].orientation, undefined);
  assert.equal(migrated.suggestions[0].defaultDuration, getDefaultMemoryDuration(4));
  const persisted = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(persisted.suggestions[0].orientation, undefined);
  assert.equal(persisted.suggestions[0].defaultDuration, getDefaultMemoryDuration(4));
});

test("single-flight searches, generating state, and concurrent dismiss/settings writes", async t => {
  const started = deferred();
  const release = deferred();
  let searches = 0;
  const f = await fixture(t, { search: async query => {
    searches++;
    if (searches === 1) { started.resolve(); await release.promise; }
    return photos(query);
  } });
  await f.manager.initialize();
  const first = f.manager.generate();
  const second = f.manager.generate(true);
  assert.strictEqual(first, second);
  await started.promise;
  assert.equal((await f.manager.getState()).generating, true);
  await f.manager.updateSettings({ showOnLaunch: false });
  release.resolve();
  const ready = await first;
  assert.equal(searches, 5);
  const id = ready.suggestions[0].id;
  await Promise.all([
    f.manager.dismiss(id),
    f.manager.updateSettings({ removeAfterDownload: true }),
    f.manager.updateSettings({ showOnLaunch: true }),
  ]);
  const persisted = await new MemoryManager(f.root, f.deps).getState();
  assert.equal(persisted.suggestions.length, 4);
  assert.ok(persisted.suggestions.every(card => card.id !== id));
  assert.deepEqual(persisted.settings, { showOnLaunch: true, removeAfterDownload: true, movieDirectory: null });
  assert.deepEqual((await fs.readdir(path.dirname(f.statePath))).sort(), ["state.json"]);
});

test("dismiss persists by ID but themes and photos can generate again", async t => {
  const f = await fixture(t, { search: async () => photos("same", 4) });
  const first = await f.manager.generate();
  assert.equal(first.suggestions.length, 1, "identical sets across themes are not separate stories");
  const id = first.suggestions[0].id;
  await f.manager.dismiss(id);
  const restarted = new MemoryManager(f.root, f.deps);
  assert.deepEqual((await restarted.getState()).suggestions, []);
  const regenerated = await restarted.generate();
  assert.equal(regenerated.suggestions.length, 1);
  assert.notEqual(regenerated.suggestions[0].id, id);
  assert.equal(await restarted.getSuggestion(id), undefined);
  assert.deepEqual(await restarted.getSoundtracks(id), []);
});

test("getState and cached lookup hide unsafe photos, Live Photo videos and dismissed stories", async t => {
  const f = await fixture(t, { findLiveVideo: async file => `${file.path}.mov` });
  const generated = await f.manager.generate();
  const card = generated.suggestions[0];
  assert.ok(card.media.every(item => item.liveVideoPath));
  f.blocked.add(card.media[0].liveVideoPath);
  const safe = await f.manager.getSuggestion(card.id);
  assert.equal(safe.media[0].liveVideoPath, undefined);
  for (const item of card.media.slice(0, 5)) f.blocked.add(item.path);
  assert.equal(await f.manager.getSuggestion(card.id), undefined, "under four remaining photos must hide the card");
  assert.equal((await f.manager.getState()).suggestions.length, 4);
  const cache = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  cache.dismissed = [generated.suggestions[1].id];
  await fs.writeFile(f.statePath, JSON.stringify(cache));
  const restarted = new MemoryManager(f.root, f.deps);
  assert.equal((await restarted.getState()).suggestions.length, 3);
  assert.equal(await restarted.getSuggestion(generated.suggestions[1].id), undefined);
});

test("empty, sparse, videos-only and failed search honestly return fewer; attempts rotate even when empty", async t => {
  let count = 0;
  const f = await fixture(t, { search: async () => { count++; return []; } });
  let state = await f.manager.generate();
  assert.deepEqual(state.suggestions, []);
  assert.equal(count, 5);
  assert.match(state.message, /four distinct, allowed photos/);
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).cursor, 5);
  f.deps.search = async () => photos("sparse", 3);
  assert.deepEqual((await f.manager.generate()).suggestions, []);
  f.deps.search = async () => photos("videos", 10).map(item => ({ ...item, type: "video" }));
  assert.deepEqual((await f.manager.generate()).suggestions, []);
  f.deps.search = async () => { throw new Error("private/path/from/index/not/ready"); };
  state = await f.manager.generate();
  assert.equal(state.generating, false);
  assert.deepEqual(state.suggestions, []);
  assert.match(state.message, /not ready or unavailable/);
  assert.ok(!state.message.includes("private"));
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).cursor, 0);
});

test("first 200 matches only, chronological diversity, score preference, bounded media and no duplicate paths", async t => {
  const f = await fixture(t, { search: async query => {
    const items = photos(query, 50);
    const scored = items.map((item, i) => ({ ...item, score: i % 2 === 0 ? 0 : 100 }));
    // Any attempt to read entry 201 fails: generation must be bounded at 200.
    Object.defineProperty(scored, 200, { get() { throw new Error("Unbounded search traversal"); } });
    return scored;
  } });
  const state = await f.manager.generate();
  for (const card of state.suggestions) {
    assert.equal(card.media.length, 24);
    assert.ok(card.media.every((item, i, list) => i === 0 || list[i - 1].modified <= item.modified));
    assert.ok(card.media[0].modified < 3000 && card.media.at(-1).modified > 46000);
    assert.ok(card.media.filter(item => Number.parseInt(item.name) % 2 === 1).length >= 20);
  }
  f.deps.search = async () => [...photos("duplicates", 3), ...photos("duplicates", 3)];
  const unchanged = await f.manager.generate(true);
  assert.deepEqual(unchanged.suggestions.map(card => card.id), state.suggestions.map(card => card.id),
    "a generate that finds nothing must keep existing cards");
  assert.match(unchanged.message, /existing memories are still here/);
});

test("generate never hides saved cards; discovery ideas fill five cards plus a reserve that covers offline sources", async t => {
  let online = true;
  let loads = 0;
  const idea = (key, prefix) => ({
    key, title: `Story ${key}`, description: `About ${key}.`, query: key, mood: "bright",
    load: async () => { loads++; if (!online) throw new Error("source offline"); return photos(prefix, 8); },
  });
  const ideas = Array.from({ length: 12 }, (_, i) => idea(`idea-${i}`, `idea-${i}`));
  const f = await fixture(t, {
    discover: async () => ideas,
    search: async () => { if (!online) throw new Error("offline"); return []; },
  });
  const first = await f.manager.generate();
  assert.equal(first.suggestions.length, 5);
  assert.equal(first.reserveCount, 5, "five extra stories are stockpiled");
  assert.ok(first.suggestions.every(card => card.storyKey && card.storyKey.startsWith("idea-")));
  assert.equal(loads, 10);
  // Sources disconnect: Generate promotes saved extras instead of wiping the page.
  online = false;
  const offline = await f.manager.generate(true);
  assert.equal(offline.suggestions.length, 5);
  const firstIds = new Set(first.suggestions.map(card => card.id));
  assert.equal(offline.suggestions.filter(card => !firstIds.has(card.id)).length, 3, "three saved extras promoted");
  assert.match(offline.message, /saved memories/);
  // Reserve extras also replace dismissed cards immediately.
  const reserveBefore = offline.reserveCount;
  const afterDismiss = await f.manager.dismiss(offline.suggestions[0].id);
  assert.equal(afterDismiss.suggestions.length, 5);
  assert.equal(afterDismiss.reserveCount, reserveBefore - 1);
  const persisted = JSON.parse(await fs.readFile(f.statePath, "utf8"));
  assert.equal(persisted.reserve.length, afterDismiss.reserveCount);
  assert.equal((await new MemoryManager(f.root, f.deps).getState()).reserveCount, afterDismiss.reserveCount);
});

test("similarity filter failures skip a story but never wipe saved cards", async t => {
  let failing = false;
  const f = await fixture(t, { filterImages: async paths => { if (failing) throw new Error("magic busy"); return paths; } });
  const first = await f.manager.generate();
  assert.equal(first.suggestions.length, 5);
  failing = true;
  assert.equal((await f.manager.getState()).suggestions.length, 5, "reads do not depend on the filter");
  const again = await f.manager.generate(true);
  assert.deepEqual(again.suggestions.map(card => card.id), first.suggestions.map(card => card.id));
});

test("movie destination accepts absolute folders or null only", async t => {
  const f = await fixture(t);
  await f.manager.updateSettings({ movieDirectory: "relative/folder" });
  assert.equal((await f.manager.getSettings()).movieDirectory, null);
  await f.manager.updateSettings({ movieDirectory: "/Volumes/Drive/Memories" });
  assert.equal((await new MemoryManager(f.root, f.deps).getSettings()).movieDirectory, "/Volumes/Drive/Memories");
  await f.manager.updateSettings({ movieDirectory: null });
  assert.equal((await f.manager.getSettings()).movieDirectory, null);
});

test("prefer disjoint stories where possible, otherwise preserve valid overlapping themes", async t => {
  let count = 0;
  const common = photos("common", 4);
  const f = await fixture(t, { search: async () => [...common, ...photos(`unique-${count++}`, 4)] });
  const state = await f.manager.generate();
  assert.equal(state.suggestions.length, 5);
  const first = new Set(state.suggestions[0].media.map(item => item.path));
  assert.ok(state.suggestions.slice(1).every(card => card.media.every(item => !first.has(item.path))));
  f.deps.search = async () => [...common, ...photos(`small-${count++}`, 1)];
  const overlapping = await f.manager.generate(true);
  assert.equal(overlapping.suggestions.length, 5, "do not discard all themes merely to avoid overlap");
  assert.ok(overlapping.suggestions.every(card => card.media.length === 5));
});

test("Live Photo failures and denied companions are optional; mixed stories still need four photos", async t => {
  const f = await fixture(t, {
    search: async query => [...photos(query, 4), ...photos(`${query}-videos`, 40).map(item => ({ ...item, type: "video" }))],
    findLiveVideo: async file => { if (file.name === "1.jpg") throw new Error("missing"); return `${file.path}.mov`; },
    isAllowed: file => !file.endsWith(".mov"),
    thumb: async () => { throw new Error("private thumbnail failure"); },
  });
  const state = await f.manager.generate();
  assert.equal(state.suggestions.length, 5);
  assert.ok(state.suggestions.every(card => card.media.filter(item => item.type === "image").length === 4));
  assert.ok(state.suggestions.every(card => card.media.every(item => !item.liveVideoPath && !item.thumbnailUrl)));
  assert.ok(!state.message.includes("private"));
});

test("safety revalidation fails closed during generation and before returning state", async t => {
  let allowed = true;
  const f = await fixture(t, { isAllowed: () => allowed, thumb: async () => { allowed = false; return "preview"; } });
  assert.deepEqual((await f.manager.generate()).suggestions, []);
  f.deps.isAllowed = async () => { throw new Error("private safety failure"); };
  assert.deepEqual((await f.manager.generate()).suggestions, []);
});

test("download timestamps or optional removal persist; replacing never touches original/exported files", async t => {
  const f = await fixture(t);
  const original = path.join(f.root, "original.jpg");
  const movie = path.join(f.root, "exported.mp4");
  await fs.writeFile(original, "original-content");
  await fs.writeFile(movie, "exported-content");
  const first = await f.manager.generate();
  const id = first.suggestions[0].id;
  const marked = await f.manager.markDownloaded(id);
  assert.ok(marked.suggestions.find(card => card.id === id).downloadedAt > 0);
  let restarted = new MemoryManager(f.root, f.deps);
  assert.ok((await restarted.getSuggestion(id)).downloadedAt > 0);
  await restarted.updateSettings({ removeAfterDownload: true });
  await restarted.markDownloaded(id);
  restarted = new MemoryManager(f.root, f.deps);
  assert.equal(await restarted.getSuggestion(id), undefined);
  await restarted.generate(true);
  assert.equal(await fs.readFile(original, "utf8"), "original-content");
  assert.equal(await fs.readFile(movie, "utf8"), "exported-content");
});

test("cached state is bounded to five cards by thirty media; malformed/oversized cache recovers safely", async t => {
  const f = await fixture(t);
  const generated = await f.manager.generate();
  const suggestions = Array.from({ length: 9 }, (_, i) => ({
    ...generated.suggestions[0], id: `cache-${i}`, media: photos(`cache-${i}`, 45).map(item => ({ ...item, thumbnailUrl: "provided" })),
  }));
  await fs.writeFile(f.statePath, JSON.stringify({ cursor: 999999, settings: null, suggestions }));
  let restarted = new MemoryManager(f.root, f.deps);
  const loaded = await restarted.getState();
  assert.equal(loaded.suggestions.length, 5);
  assert.ok(loaded.suggestions.every(card => card.media.length === 30));
  assert.ok(loaded.suggestions.every(card => card.media.filter(item => item.thumbnailUrl).length === 3));
  assert.equal(JSON.parse(await fs.readFile(f.statePath, "utf8")).suggestions.length, 5);
  await fs.writeFile(f.statePath, "{invalid/private/path");
  restarted = new MemoryManager(f.root, f.deps);
  const broken = await restarted.getState();
  assert.deepEqual(broken.suggestions, []);
  assert.ok(!broken.message.includes("private"));
  await fs.writeFile(f.statePath, " ".repeat(4 * 1024 * 1024 + 1));
  assert.deepEqual((await new MemoryManager(f.root, f.deps).getState()).suggestions, []);
});

test("soundtracks: original, the story's own picked song, then mood/story-ranked files, with a personal-use notice", async t => {
  let audio = [
    ...Array.from({ length: 20 }, (_, i) => ({ name: `Plain track ${i}.mp3`, path: `/audio/plain-${i}.mp3`, sourceLabel: i % 2 ? "Phone" : "Backup" })),
    { name: "Happy bright sunny summer.mp3", path: "/other-source/happy.mp3", sourceLabel: "User collection" },
    { name: "Sunny forbidden.mp3", path: "/audio/blocked.mp3" },
  ];
  const f = await fixture(t, { listAudio: async () => audio });
  f.blocked.add("/audio/blocked.mp3");
  const card = (await f.manager.generate()).suggestions[0];
  const tracks = await f.manager.getSoundtracks(card.id);
  assert.equal(tracks.length, 13);
  assert.equal(tracks[0].id, `original:${card.id}`);
  assert.equal(tracks[0].source, "original");
  assert.equal(tracks[0].path, undefined);
  assert.equal(tracks[1].path, "/other-source/happy.mp3");
  assert.equal(card.soundtrackId, tracks[1].id, "the best-matching song is picked for the story");
  const allCards = (await f.manager.getState()).suggestions;
  assert.equal(new Set(allCards.map(item => item.soundtrackId)).size, allCards.length, "every story plays a different song");
  assert.ok(tracks.every(track => /personal viewing only/i.test(track.rights)));
  assert.ok(tracks.slice(1).every(track => /Song from your music library/.test(track.rights)));
  assert.ok(tracks.every(track => !/public domain|royalty.free|licensed for use/i.test(track.rights)));
  assert.ok(tracks.every(track => track.path !== "/audio/blocked.mp3"));
  assert.equal(new Set(tracks.map(track => track.id)).size, tracks.length);
  assert.equal((await f.manager.resolveSoundtrack(tracks[1].id, card.id)).path, tracks[1].path);
  assert.equal((await f.manager.resolveSoundtrack(tracks[0].id, card.id)).source, "original");
  assert.equal(await f.manager.resolveSoundtrack(tracks[0].id, "wrong-card"), undefined);
  assert.equal(await f.manager.resolveSoundtrack("/etc/passwd", card.id), undefined);
  assert.equal(await f.manager.resolveSoundtrack("library:" + "0".repeat(64), card.id), undefined);
  assert.equal(await f.manager.resolveSoundtrack(tracks[1].id, "missing-card"), undefined);
  f.blocked.add(tracks[1].path);
  assert.equal(await f.manager.resolveSoundtrack(tracks[1].id), undefined);
  f.blocked.delete(tracks[1].path);
  audio = [];
  assert.equal(await f.manager.resolveSoundtrack(tracks[1].id), undefined, "stale IDs must be revalidated against the index");
  assert.equal((await f.manager.getSoundtracks(card.id)).length, 1);
  f.deps.listAudio = async () => { throw new Error("private audio failure"); };
  assert.equal((await f.manager.getSoundtracks(card.id)).length, 1);
  assert.equal(await f.manager.resolveSoundtrack(tracks[1].id), undefined);
});

test("audio explorer: sources, nested folders, search, sorting, paging, privacy and choosing a memory's song", async t => {
  const library = [
    ["listen", "LISTEN", "Black Lips/Arabia Mountain/01 Modern Art.mp3", 5_000_000, 30],
    ["listen", "LISTEN", "Black Lips/Arabia Mountain/02 Family Tree.mp3", 4_000_000, 10],
    ["listen", "LISTEN", "Black Lips/Good Bad Not Evil/03 Bad Kids.mp3", 6_000_000, 20],
    ["listen", "LISTEN", "Loose Track.m4a", 3_000_000, 40],
    ["phone", "Phone", "Recordings/Voice memo.m4a", 900_000, 50],
    ["listen", "LISTEN", "Secret/hidden.mp3", 5_000_000, 60],
  ].map(([sourceId, sourceLabel, relativePath, size, modified]) => ({
    sourceId, sourceLabel, relativePath, size, modified,
    name: path.basename(relativePath), path: `/Volumes/${sourceLabel}/${relativePath}`,
  }));
  const f = await fixture(t, { listAudio: async () => library });
  f.blocked.add("/Volumes/LISTEN/Secret/hidden.mp3");
  const root = await f.manager.browseAudio();
  assert.deepEqual(root.sources.map(s => [s.label, s.count]), [["LISTEN", 5], ["Phone", 1]]);
  assert.equal(root.files.length, 0, "the root lists sources, not every file");
  const listen = await f.manager.browseAudio({ sourceId: "listen" });
  assert.deepEqual(listen.folders.map(item => [item.name, item.count]), [["Black Lips", 3], ["Secret", 1]]);
  assert.deepEqual(listen.files.map(file => file.name), ["Loose Track.m4a"]);
  const artist = await f.manager.browseAudio({ sourceId: "listen", folder: "Black Lips" });
  assert.deepEqual(artist.folders.map(item => item.path), ["Black Lips/Arabia Mountain", "Black Lips/Good Bad Not Evil"]);
  const album = await f.manager.browseAudio({ sourceId: "listen", folder: "Black Lips/Arabia Mountain", sort: "size", direction: "desc" });
  assert.deepEqual(album.files.map(file => file.name), ["01 Modern Art.mp3", "02 Family Tree.mp3"]);
  assert.equal(album.files[0].folder, "Black Lips/Arabia Mountain");
  const search = await f.manager.browseAudio({ query: "black lips", sort: "modified" });
  assert.deepEqual(search.files.map(file => file.name), ["02 Family Tree.mp3", "03 Bad Kids.mp3", "01 Modern Art.mp3"]);
  const paged = await f.manager.browseAudio({ query: "black", limit: 2 });
  assert.equal(paged.files.length, 2); assert.equal(paged.total, 3);
  const hidden = await f.manager.browseAudio({ sourceId: "listen", folder: "Secret" });
  assert.equal(hidden.files.length, 0, "hidden files never reach the explorer");

  const card = (await f.manager.generate()).suggestions[0];
  const chosen = await f.manager.setSoundtrack(card.id, search.files[1].id);
  assert.equal(chosen.soundtrackId, search.files[1].id);
  assert.equal((await new MemoryManager(f.root, f.deps).getSuggestion(card.id)).soundtrackId, search.files[1].id, "the choice persists");
  assert.equal((await f.manager.getSoundtracks(card.id))[1].name, "03 Bad Kids.mp3", "the chosen song leads the soundtrack list");
  assert.equal(await f.manager.setSoundtrack(card.id, `library:${"0".repeat(64)}`), undefined, "unknown songs are rejected");
  assert.equal(await f.manager.setSoundtrack("missing", search.files[1].id), undefined);
});

test("audio path keywords and synchronous cached adapters are supported", async t => {
  const f = await fixture(t, {
    thumb: () => "sync-preview",
    listAudio: () => [
      { name: "Track 1.mp3", path: "/audio/plain/1.mp3" },
      { name: "Track 2.mp3", path: "/backup/bright/sunny/summer/2.mp3" },
      { name: "Track 2 duplicate.mp3", path: "/backup/bright/sunny/summer/2.mp3" },
    ],
    isAllowed: () => true,
  });
  const card = (await f.manager.generate()).suggestions[0];
  const tracks = await f.manager.getSoundtracks(card.id);
  assert.equal(tracks.length, 3);
  assert.equal(tracks[1].path, "/backup/bright/sunny/summer/2.mp3");
  assert.equal((await f.manager.resolveSoundtrack(tracks[1].id)).path, tracks[1].path);
  assert.ok(card.media.slice(0, 3).every(item => item.thumbnailUrl === "sync-preview"));
});

test("dismissal during asynchronous safety checks cannot leak a dismissed card", async t => {
  const f = await fixture(t);
  const card = (await f.manager.generate()).suggestions[0];
  const started = deferred();
  const release = deferred();
  let pause = true;
  f.deps.isAllowed = async file => {
    if (pause && file === card.media[0].path) {
      pause = false;
      started.resolve();
      await release.promise;
    }
    return true;
  };
  const pendingState = f.manager.getState();
  await started.promise;
  await f.manager.dismiss(card.id);
  release.resolve();
  assert.ok((await pendingState).suggestions.every(item => item.id !== card.id));
});
