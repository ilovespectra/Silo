/* Deterministic tests for the local topic profile and its refresh scheduling. No Electron, models or real files. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const { MemoryTopicProfile, RefreshScheduler } = require("../src/memoryTopicProfile.ts");
const { discoverMemoryStories } = require("../src/memoryDiscovery.ts");
const { MemoryManager } = require("../src/memoryManager.ts");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 5, 12).getTime();
const AXES = { garden: 0, sailing: 1, paragliding: 2, screenshot: 3 };
const unit = (axis) => { const vector = new Float32Array(4); vector[AXES[axis]] = 1; return vector; };

/** A fake index: records, vectors, capture times and a revision counter the test controls. */
function archive(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "silo-topic-profile-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const index = { records: new Map(), vectors: new Map(), captured: new Map(), revision: 0, vectorReads: 0 };
  const add = (source, topic, count, { modified, captured, prefix = topic } = {}) => {
    const paths = [];
    for (let i = 0; i < count; i++) {
      const filePath = `${source}/${prefix}-${index.records.size}.jpg`;
      index.records.set(filePath, { path: filePath, sourcePath: source, modified: modified ?? NOW - 800 * DAY, signature: `1:${i}` });
      index.vectors.set(filePath, unit(topic));
      if (captured) index.captured.set(filePath, captured);
      paths.push(filePath);
    }
    index.revision += 1;
    return paths;
  };
  const deps = {
    statePath: path.join(directory, "topic-profile.json"),
    topics: [{ id: "garden", prompt: "garden" }, { id: "sailing", prompt: "sailing" }, { id: "paragliding", prompt: "paragliding" }],
    distractorPrompts: ["screenshot"],
    revision: () => index.revision,
    records: () => Array.from(index.records.values()),
    vectors: async (paths) => {
      index.vectorReads += 1;
      return new Map(paths.flatMap((filePath) => index.vectors.has(filePath) ? [[filePath, index.vectors.get(filePath)]] : []));
    },
    embedPrompts: async (prompts) => prompts.map((prompt) => unit(prompt)),
    captureTime: async (filePath) => index.captured.get(filePath) ?? null,
    now: () => NOW,
  };
  const make = () => new MemoryTopicProfile(deps, { recentDays: 120, ...options });
  return { index, add, deps, make };
}

const topic = (snapshot, id) => snapshot.topics.find((item) => item.id === id);
const seeded = (seed = 42) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

function ideasFrom(profile, index, seed) {
  const snapshot = profile.getSnapshot();
  const images = Array.from(index.records.values()).map((record) =>
    ({ path: record.path, modified: record.modified, captured: profile.captureTimeOf(record.path) }));
  return discoverMemoryStories({
    images, now: NOW, random: seeded(seed),
    concepts: snapshot.topics.filter((item) => item.estimatedCount >= 5)
      .map((item) => ({ id: item.id, paths: item.paths, count: item.estimatedCount })),
    topics: snapshot.topics.map((item) => ({ id: item.id, interest: item.interest, lift: item.lift,
      recentCount: item.recentCount, recentPaths: item.recentPaths })),
  });
}

test("a batch of new paragliding photos changes prevalence and the next suggestions; a couple of files does not", async (t) => {
  const a = archive(t);
  a.add("/A", "garden", 400);
  a.add("/A", "sailing", 60);
  const profile = a.make();
  await profile.refresh();
  assert.equal(topic(profile.getSnapshot(), "paragliding").estimatedCount, 0);
  assert.ok(!ideasFrom(profile, a.index, 1).some((idea) => /Paragliding/.test(idea.title)));

  // Two recent files are noise: no emerging story, no meaningful change.
  a.add("/A", "paragliding", 2, { modified: NOW - 3 * DAY, captured: NOW - 3 * DAY });
  let result = await profile.refresh();
  assert.equal(result.changed, false, "two files must not churn suggestions");
  assert.equal(topic(profile.getSnapshot(), "paragliding").lift, 1);
  assert.ok(!ideasFrom(profile, a.index, 1).some((idea) => /New: Paragliding/.test(idea.title)));

  a.add("/A", "paragliding", 30, { modified: NOW - 5 * DAY, captured: NOW - 6 * DAY });
  result = await profile.refresh();
  assert.equal(result.changed, true);
  assert.equal(result.classified, 30, "only the new batch is classified");
  const paragliding = topic(profile.getSnapshot(), "paragliding");
  assert.equal(paragliding.recentCount, 32);
  assert.ok(paragliding.lift >= 4, `lift ${paragliding.lift}`);
  let leading = 0;
  for (let seed = 1; seed <= 10; seed++)
    if (ideasFrom(profile, a.index, seed).slice(0, 4).some((idea) => idea.title === "New: Paragliding")) leading += 1;
  assert.ok(leading >= 8, `emerging topic led in ${leading}/10 orderings`);

  // The next generated suggestions include the new interest.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-topic-manager-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const manager = new MemoryManager(root, {
    search: async () => [], thumb: async () => null, listAudio: () => [], isAllowed: () => true,
    discover: async () => ideasFrom(profile, a.index, 3).map((idea) => ({ ...idea,
      load: async () => idea.paths.map((filePath) => ({ path: filePath, name: path.basename(filePath), type: "image",
        modified: a.index.records.get(filePath).modified })) })),
  });
  const state = await manager.generate();
  assert.ok(state.suggestions.some((card) => /Paragliding/.test(card.title)), state.suggestions.map((card) => card.title).join(" | "));
});

test("changed and deleted records update the profile incrementally; an unchanged revision reads nothing", async (t) => {
  const a = archive(t);
  const garden = a.add("/A", "garden", 50);
  a.add("/A", "sailing", 20);
  const profile = a.make();
  let result = await profile.refresh();
  assert.equal(result.classified, 70);
  const reads = a.index.vectorReads;
  result = await profile.refresh();
  assert.deepEqual(result, { recomputed: false, changed: false, classified: 0, removed: 0 });
  assert.equal(a.index.vectorReads, reads, "same revision: no vector reads");

  a.index.revision += 1; // e.g. a reindex that changed nothing
  result = await profile.refresh();
  assert.equal(result.classified, 0);
  assert.equal(a.index.vectorReads, reads, "unchanged signatures are not reread");

  // One garden photo re-edited into a sailing shot (new signature), ten deleted.
  a.index.records.get(garden[0]).signature = "2:edited";
  a.index.vectors.set(garden[0], unit("sailing"));
  for (const filePath of garden.slice(1, 11)) a.index.records.delete(filePath);
  a.index.revision += 1;
  result = await profile.refresh();
  assert.equal(result.classified, 1);
  assert.equal(result.removed, 11);
  const snapshot = profile.getSnapshot();
  assert.equal(topic(snapshot, "garden").estimatedCount, 39);
  assert.equal(topic(snapshot, "sailing").estimatedCount, 21);

  // Persisted state: a restart reclassifies nothing.
  const restarted = a.make();
  result = await restarted.refresh();
  assert.equal(result.classified, 0);
  assert.equal(topic(restarted.getSnapshot(), "sailing").estimatedCount, 21);
});

test("capture dates, source boundaries, sampling, privacy-filtered paths and duplicates", async (t) => {
  const a = archive(t, { sampleTarget: 400 });
  // A recently copied folder of 2015 shots is not an emerging interest.
  const copied = a.add("/A", "sailing", 12, { modified: NOW - 2 * DAY, captured: new Date(2015, 9, 4, 10).getTime() });
  a.add("/A", "garden", 2000);
  a.add("/B", "sailing", 80);
  const profile = a.make();
  await profile.refresh();
  const snapshot = profile.getSnapshot();
  const sailing = topic(snapshot, "sailing");
  assert.equal(sailing.recentCount, 0, "capture time, not file time, decides recency");
  assert.ok(snapshot.sampledPhotos < 2092 && snapshot.sampledPhotos >= 300, `sampled ${snapshot.sampledPhotos}`);
  assert.ok(Math.abs(topic(snapshot, "garden").estimatedCount - 2000) < 400, "sampled counts are re-weighted");
  assert.ok(sailing.sourceBalancedShare > 0.45, "a small source's interest is not hidden by a large one");
  assert.ok(sailing.archiveShare < 0.1);
  assert.ok(sailing.interest > 0.3 && sailing.interest > 4 * sailing.archiveShare, `interest ${sailing.interest}`);
  assert.ok(sailing.bySource["/B"] > 0.9 && (sailing.bySource["/A"] ?? 0) < 0.05);

  // Date stories use the capture date (October 2015) rather than the copy date.
  const ideas = ideasFrom(profile, a.index, 5);
  assert.ok(ideas.some((idea) => idea.key === "on-this-day:2015"), ideas.map((idea) => idea.key).join(" "));

  // Paths missing from the caller's privacy-filtered image list never reach a story.
  const hidden = new Set(copied);
  const visibleImages = Array.from(a.index.records.values()).filter((record) => !hidden.has(record.path))
    .map((record) => ({ path: record.path, modified: record.modified }));
  const filtered = discoverMemoryStories({ images: visibleImages, now: NOW, random: seeded(2),
    concepts: [{ id: "sailing", paths: sailing.paths, count: sailing.estimatedCount }] });
  assert.ok(filtered.every((idea) => idea.paths.every((filePath) => !hidden.has(filePath))));

  // Identical photo sets from two ideas become one card.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-topic-duplicates-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const same = sailing.paths.slice(0, 8).map((filePath) => ({ path: filePath, name: path.basename(filePath), type: "image", modified: 1 }));
  const manager = new MemoryManager(root, {
    search: async () => [], thumb: async () => null, listAudio: () => [], isAllowed: () => true,
    discover: async () => ["one", "two"].map((key) => ({ key, title: key, description: key, query: key, mood: "bright", load: async () => same })),
  });
  assert.equal((await manager.generate()).suggestions.length, 1);
});

test("refresh is debounced, waits for indexing, never overlaps, and collapses notifications into one rerun", async () => {
  const timers = [];
  let busy = true;
  let running = 0;
  let maxRunning = 0;
  let runs = 0;
  let release;
  const scheduler = new RefreshScheduler({
    delayMs: 1000,
    isBusy: () => busy,
    setTimer: (callback, delay) => { const handle = { callback, delay, cleared: false }; timers.push(handle); return handle; },
    clearTimer: (handle) => { handle.cleared = true; },
    run: async () => {
      runs += 1; running += 1; maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => { release = resolve; });
      running -= 1;
    },
  });
  const fireLive = async () => {
    const live = timers.filter((timer) => !timer.cleared && !timer.fired);
    for (const timer of live) { timer.fired = true; timer.callback(); }
    await new Promise(setImmediate);
    return live.length;
  };
  for (let i = 0; i < 5; i++) scheduler.notify();
  assert.equal(timers.filter((timer) => !timer.cleared).length, 1, "notifications collapse into one pending timer");
  assert.equal(await fireLive(), 1);
  assert.equal(runs, 0, "busy indexing defers the refresh");
  busy = false;
  await fireLive();
  assert.equal(runs, 1);
  scheduler.notify(); scheduler.notify(); scheduler.notify();
  assert.equal(timers.filter((timer) => !timer.cleared && !timer.fired).length, 0, "no timer starts while running");
  release();
  await new Promise(setImmediate);
  assert.equal(await fireLive(), 1, "exactly one rerun is scheduled after the run");
  assert.equal(runs, 2);
  release();
  await new Promise(setImmediate);
  assert.equal(await fireLive(), 0, "nothing further without new notifications");
  assert.equal(maxRunning, 1, "runs never overlap");
});

test("concurrent refresh callers share one computation", async (t) => {
  const a = archive(t);
  a.add("/A", "garden", 30);
  const profile = a.make();
  const [first, second] = await Promise.all([profile.refresh(), profile.refresh()]);
  assert.equal(first, second);
  assert.equal(a.index.vectorReads, 1);
});
