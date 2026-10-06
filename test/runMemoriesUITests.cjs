/* UI-only regressions: no Electron, generation, media decoding or file exports. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const files = ["src/components/MemoriesPage.tsx", "src/components/MemoriesLauncher.tsx"];
const program = ts.createProgram(files.map((file) => path.join(root, file)), {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX, moduleResolution: ts.ModuleResolutionKind.NodeJs,
  esModuleInterop: true, strict: true, skipLibCheck: true, noEmit: true,
  lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => root, getCanonicalFileName: (file) => file, getNewLine: () => "\n",
}));
const previousTSX = require.extensions[".tsx"];
const previousTS = require.extensions[".ts"];
const previousCSS = require.extensions[".css"];
const transpile = (module, filename) => {
  assert.ok([...files, "src/memoryTypes.ts"].some((file) => path.join(root, file) === filename), "Only transpile memories UI");
  const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } });
  module._compile(result.outputText, filename);
};
require.extensions[".tsx"] = transpile;
require.extensions[".ts"] = transpile;
require.extensions[".css"] = () => {};
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { default: MemoriesPage, MemoryCover } = require("../src/components/MemoriesPage.tsx");
const { default: MemoriesLauncher } = require("../src/components/MemoriesLauncher.tsx");
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = require("react-dom/client");
const { act: legacyAct, Simulate } = require("react-dom/test-utils");
const act = React.act || legacyAct;
const memory = (id, count = 30) => ({
  id, title: `Story ${id}`, description: "A warm afternoon, remembered.", query: "afternoon",
  mood: "gentle", defaultDuration: id === "a" ? 52 : 45, createdAt: 1,
  media: Array.from({ length: count }, (_, index) => ({
    path: `/original/${index}.jpg`, name: `${index}.jpg`, modified: 1,
    type: index % 3 ? "image" : "video", thumbnailUrl: index < 3 ? `data:image/png;base64,preview${index}` : null,
  })),
});
function fixture(suggestions = [memory("a")]) {
  let state = { suggestions, settings: { showOnLaunch: true, removeAfterDownload: true }, generating: false, message: "" };
  const calls = { reads: 0, generations: [], dismissals: [], settings: [], tracks: 0, viewIds: [], exports: [], cancels: 0, subscriptions: 0, unsubscriptions: 0 };
  let listener;
  let finish;
  const api = {
    getMemories: async (prepareViews) => { calls.reads++; calls.prepareViews = [...(calls.prepareViews || []), Boolean(prepareViews)]; return state; },
    generateMemories: async (replace) => { calls.generations.push(replace); state = { ...state, suggestions: [memory("new")] }; return state; },
    dismissMemory: async (id) => { calls.dismissals.push(id); state = { ...state, suggestions: state.suggestions.filter((item) => item.id !== id) }; return state; },
    updateMemorySettings: async (settings) => { calls.settings.push(settings); state = { ...state, settings: { ...state.settings, ...settings } }; return state; },
    getMemorySoundtracks: async (id) => { calls.tracks++; return [
      { id: `original:${id}`, name: "Original audio", source: "original", rights: "Original clip audio" },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `library${i}`, name: `Track ${i}`, source: "library", rights: "Review downloadable use at the source." })),
    ]; },
    viewMemory: async (id) => { calls.viewIds.push(id); return { ok: true, path: `/cache/${id}.mp4` }; },
    exportMemory: (options) => { calls.exports.push(options); return new Promise((resolve) => { finish = (result) => {
      if (result.ok && state.settings.removeAfterDownload) state = { ...state, suggestions: state.suggestions.filter((item) => item.id !== options.suggestionId) };
      resolve(result);
    }; }); },
    cancelMemoryExport: async () => { calls.cancels++; finish?.({ ok: false, canceled: true }); },
    onMemoryExportProgress: (callback) => { calls.subscriptions++; listener = callback; return () => { calls.unsubscriptions++; listener = undefined; }; },
  };
  return { api, calls, progress: (value) => listener?.(value), finish: (value) => finish(value) };
}
let renderer;
const mount = async (element) => {
  renderer = createRoot(document.getElementById("root"));
  await act(async () => { renderer.render(element); });
};
const unmount = async () => { await act(async () => renderer.unmount()); assert.equal(document.querySelectorAll('[role="dialog"]').length, 0); };
const buttons = () => Array.from((document.querySelector('[role="dialog"]') || document).querySelectorAll("button"));
const button = (label) => { const found = buttons().find((item) => item.textContent === label || item.getAttribute("aria-label") === label); assert.ok(found, `Button exists: ${label}`); return found; };
const click = async (label) => { const target = button(label); assert.equal(target.disabled, false, `${label} enabled`); await act(async () => target.click()); };
const change = async (target, value) => { await act(async () => { Simulate.change(target, { target: { value, checked: value } }); }); };
const checkbox = (label) => Array.from(document.querySelectorAll("label")).find((item) => item.textContent.includes(label))?.querySelector("input");

async function run() {
  const server = renderToStaticMarkup(React.createElement(MemoryCover, { memory: memory("server", 100) }));
  assert.equal((server.match(/<img /g) || []).length, 3);
  assert.ok(!server.includes("/original/"), "Never load originals in covers");
  const allThumbs = memory("many"); allThumbs.media.forEach((item) => { item.thumbnailUrl = "data:image/png;base64,test"; });
  assert.equal((renderToStaticMarkup(React.createElement(MemoryCover, { memory: allThumbs })).match(/<img /g) || []).length, 5);
  assert.match(fs.readFileSync(path.join(root, "src/styles/Memories.css"), "utf8"), /prefers-reduced-motion/);
  console.log("✓ strict TypeScript, server-rendered covers limited to five, reduced motion");

  const startup = fixture([memory("a"), memory("b"), memory("c"), memory("d")]);
  let explores = 0;
  const launcher = (ready) => React.createElement(React.StrictMode, null, React.createElement(MemoriesLauncher, { api: startup.api, ready, onExplore: () => explores++ }));
  await mount(launcher(false)); assert.equal(startup.calls.reads, 0);
  await act(async () => renderer.render(launcher(true)));
  assert.equal(startup.calls.reads, 1);
  assert.deepEqual(startup.calls.prepareViews, [true], "Popup waits for pre-rendered movies");
  assert.equal(document.querySelectorAll(".memories-launcher-card").length, 3);
  await act(async () => renderer.render(launcher(true))); assert.equal(startup.calls.reads, 1);
  await change(checkbox("Don’t show"), true);
  await click("Explore memories");
  assert.equal(explores, 1); assert.deepEqual(startup.calls.settings, [{ showOnLaunch: false }]);
  assert.deepEqual(startup.calls.generations, []);
  await unmount();
  const keep = fixture([memory("k")]);
  let keepExplores = 0;
  await mount(React.createElement(MemoriesLauncher, { api: keep.api, ready: true, onExplore: () => keepExplores++ }));
  await click("Close dialog");
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  assert.deepEqual(keep.calls.settings, [], "Closing without opt-out keeps the launch setting");
  assert.equal(keepExplores, 0); await unmount();
  const failing = fixture([memory("f")]);
  failing.api.updateMemorySettings = async () => { throw new Error("Settings locked"); };
  let failingExplores = 0;
  await mount(React.createElement(MemoriesLauncher, { api: failing.api, ready: true, onExplore: () => failingExplores++ }));
  await change(checkbox("Don’t show"), true);
  await click("Explore memories");
  assert.match(document.querySelector('[role="alert"]').textContent, /Settings locked/);
  assert.equal(failingExplores, 0, "Failed opt-out does not navigate away silently");
  await change(checkbox("Don’t show"), false);
  await click("Explore memories"); assert.equal(failingExplores, 1);
  await unmount();
  const empty = fixture([]);
  await mount(React.createElement(MemoriesLauncher, { api: empty.api, ready: true, onExplore() {} }));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  assert.deepEqual(empty.calls.generations, []); await unmount();
  const hidden = fixture(); await hidden.api.updateMemorySettings({ showOnLaunch: false });
  await mount(React.createElement(MemoriesLauncher, { api: hidden.api, ready: true, onExplore() {} }));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0); await unmount();
  console.log("✓ cached-only ready launcher, stable read, three cards, persisted opt-out, empty/disabled suppression");

  const direct = fixture([memory("popup")]);
  await mount(React.createElement(MemoriesLauncher, { api: direct.api, ready: true, onExplore() { assert.fail("Watching a popup card should not navigate away"); } }));
  await click("Watch memory: Story popup");
  assert.deepEqual(direct.calls.viewIds, ["popup"]);
  assert.equal(document.querySelector("video").getAttribute("src"), "app-media://stream/%2Fcache%2Fpopup.mp4");
  await click("Done"); await unmount();
  console.log("✓ startup popup card plays its pre-rendered movie directly");

  const page = fixture();
  await mount(React.createElement(MemoriesPage, { api: page.api, ready: false }));
  assert.equal(page.calls.reads, 0);
  await act(async () => renderer.render(React.createElement(MemoriesPage, { api: page.api, ready: true })));
  assert.equal(page.calls.reads, 1); assert.deepEqual(page.calls.prepareViews, [true], "Saved memory movies are prepared before the page shows their cards");
  assert.equal(page.calls.tracks, 0); assert.deepEqual(page.calls.generations, []);
  const sliders = document.querySelectorAll('input[type="range"]');
  assert.equal(sliders[0].min, "20"); assert.equal(sliders[0].max, "24");
  assert.ok(document.body.textContent.includes("3.0s each"), "default cut holds each item for about three seconds");
  assert.equal(sliders.length, 2, "movie length is fixed instead of adjustable");
  assert.equal(sliders[1].value, "0.18"); assert.equal(sliders[1].max, "0.6");
  assert.ok(document.body.textContent.includes("1 minute · 60 seconds"));
  assert.equal(document.querySelector(".memories-settings-dropdown").open, false, "advanced controls are collapsed by default");
  assert.ok(document.querySelector(".memories-meta").textContent.includes("Landscape · 16:9"));
  assert.equal(document.querySelectorAll("select").length, 1, "there is no framing selector");
  await act(async () => document.querySelector(".memories-settings-dropdown summary").click());
  assert.equal(document.querySelector(".memories-settings-dropdown").open, true);
  await change(sliders[0], "24");
  await click("Watch memory: Story a");
  assert.deepEqual(page.calls.viewIds, ["a"]);
  assert.equal(page.calls.exports.length, 0, "Viewing must not invoke the save/export flow");
  const viewVideo = document.querySelector("video");
  assert.equal(viewVideo.getAttribute("src"), "app-media://stream/%2Fcache%2Fa.mp4");
  assert.equal(viewVideo.autoplay, true); assert.equal(viewVideo.controls, false);
  Object.defineProperty(viewVideo, "duration", { configurable: true, value: 93 });
  await act(async () => viewVideo.dispatchEvent(new dom.window.Event("loadedmetadata")));
  Object.defineProperty(viewVideo, "currentTime", { configurable: true, writable: true, value: 17.25 });
  await act(async () => viewVideo.dispatchEvent(new dom.window.Event("timeupdate")));
  const playhead = document.querySelector(".memories-playback-slider");
  assert.equal(playhead.max, "93", "scrubber maximum matches actual video duration");
  assert.equal(playhead.value, "17.25", "scrubber follows the actual playpoint");
  assert.ok(document.querySelector(".memories-playback-time").textContent.includes("0:17 / 1:33"));
  await change(playhead, "42.5");
  assert.equal(viewVideo.currentTime, 42.5, "scrubbing seeks to the selected video playpoint");
  assert.ok(document.querySelector(".memories-playback-time").textContent.includes("0:42 / 1:33"));
  await click("Done");
  assert.equal(page.calls.exports.length, 0, "Cached viewing does not render or export a movie");
  await click("Browse mood soundtracks"); assert.equal(page.calls.tracks, 1);
  const selects = document.querySelectorAll("select");
  assert.equal(selects[0].options.length, 13);
  await change(selects[0], "library0");
  assert.equal(button("Make a movie").disabled, false, "library songs need no rights checkbox");
  assert.ok(document.body.textContent.includes("personal viewing only"), "personal-use notice shown for library songs");
  await click("Make a movie"); await click("Choose location & export");
  assert.deepEqual(page.calls.exports[0], { suggestionId: "a", count: 24, duration: 60, soundtrackId: "library0", originalAudio: 0.18 });
  assert.equal(button("Close dialog").disabled, true);
  await act(async () => page.progress({ suggestionId: "unrelated", phase: "rendering", completed: 1, total: 2, message: "WRONG STORY" }));
  assert.ok(!document.body.textContent.includes("WRONG STORY"));
  await act(async () => page.progress({ suggestionId: "a", phase: "rendering", completed: 1, total: 2, message: "Rendering this story" }));
  assert.ok(document.body.textContent.includes("Rendering this story"));
  assert.equal(page.calls.subscriptions, 1, "Progress subscription is only used for export");
  await click("Cancel export"); assert.equal(page.calls.cancels, 1);
  assert.equal(document.querySelectorAll(".memories-card").length, 1);
  await click("Choose location & export");
  await act(async () => page.finish({ ok: true, path: "/saved movies/story #1.mp4" }));
  const video = document.querySelector("video");
  assert.equal(video.getAttribute("src"), "app-media://stream/%2Fsaved%20movies%2Fstory%20%231.mp4");
  assert.equal(video.autoplay, false); assert.equal(video.controls, false);
  assert.equal(document.querySelectorAll(".memories-card").length, 0, "Successful download refreshes removed suggestions");
  await click("Done"); assert.equal(page.calls.unsubscriptions, 1);
  await click("Generate memories"); assert.deepEqual(page.calls.generations, [true]);
  await change(checkbox("Show on launch"), false);
  assert.deepEqual(page.calls.settings, [{ showOnLaunch: false }]);
  await click("Clear suggestions"); await click("Clear suggestions");
  assert.deepEqual(page.calls.dismissals, ["new"]);
  await unmount();
  console.log("✓ pre-rendered full-resolution playback, on-demand tracks, personal-use notice, export controls, progress and settings");

  const short = fixture([memory("tiny", 2)]);
  await mount(React.createElement(MemoriesPage, { api: short.api }));
  assert.equal(document.querySelectorAll("select")[0].value, "original:tiny", "Placeholder follows manager ID contract");
  assert.equal(document.querySelector('input[type="range"]').value, "2");
  assert.equal(document.querySelector('input[type="range"]').disabled, true);
  await click("Make a movie"); assert.equal(short.calls.tracks, 1);
  await click("Choose location & export");
  assert.equal(short.calls.exports[0].soundtrackId, "original:tiny", "Original-only export uses the API-minted ID");
  assert.equal("rightsAcknowledged" in short.calls.exports[0], false, "No rights flag is sent");
  await click("Cancel export"); await click("Done");
  await click("Remove suggestion: Story tiny"); assert.deepEqual(short.calls.dismissals, ["tiny"]); await unmount();
  const flaky = fixture([memory("flaky")]);
  const listTracks = flaky.api.getMemorySoundtracks;
  let failTracks = true;
  flaky.api.getMemorySoundtracks = async (id) => { if (failTracks) { failTracks = false; throw new Error("Audio index busy"); } return listTracks(id); };
  await mount(React.createElement(MemoriesPage, { api: flaky.api }));
  await click("Make a movie");
  assert.equal(flaky.calls.exports.length, 0); assert.equal(document.querySelectorAll('[role="dialog"]').length, 0, "No export with placeholder ID");
  assert.match(document.querySelector('[role="alert"]').textContent, /Audio index busy/);
  await click("Make a movie"); await click("Choose location & export");
  assert.equal(flaky.calls.exports[0].soundtrackId, "original:flaky");
  await click("Cancel export"); await click("Done"); await unmount();
  const broken = fixture(); broken.api.getMemories = async () => { throw new Error("Cache unavailable; try Refresh."); };
  await mount(React.createElement(MemoriesPage, { api: broken.api }));
  assert.match(document.querySelector('[role="alert"]').textContent, /Cache unavailable/); await unmount();
  console.log("✓ short collections capped, manual suggestion-only removal, visible backend errors");

  const rendering = fixture([memory("first"), memory("second"), memory("broken")]);
  const base = await rendering.api.getMemories();
  let pushPreviews;
  rendering.api.getMemories = async () => ({ ...base, previews: {
    first: { status: "rendering", progress: 0.42, etaSeconds: 65 }, second: { status: "queued" }, broken: { status: "failed" } } });
  rendering.api.onMemoryPreviewProgress = (callback) => { pushPreviews = callback; return () => { pushPreviews = undefined; }; };
  await mount(React.createElement(MemoriesPage, { api: rendering.api }));
  assert.equal(document.querySelectorAll(".memories-card").length, 2, "stories whose movie failed are hidden");
  assert.ok(document.body.textContent.includes("Preparing memory… 42%"));
  assert.ok(document.body.textContent.includes("About 1:05 left"));
  assert.ok(document.body.textContent.includes("Waiting to prepare"));
  assert.equal(document.querySelectorAll(".memories-spinner").length, 2);
  await act(async () => button("Preparing memory: Story second").click());
  assert.equal(rendering.calls.viewIds.length, 0, "a preparing memory never opens an empty player");
  assert.match(document.querySelector(".memories-toast").textContent, /Please wait for “Story first” to finish processing/);
  await act(async () => pushPreviews({ first: { status: "ready", progress: 1 }, second: { status: "rendering", progress: 0.1 } }));
  await click("Watch memory: Story first");
  assert.deepEqual(rendering.calls.viewIds, ["first"], "ready memories play as soon as their status arrives");
  await click("Done"); await unmount();
  console.log("✓ per-card preparing spinner, progress and ETA, wait notice, failed stories hidden");

  const music = fixture([memory("song")]);
  const requests = [];
  const songFile = { id: `library:${"b".repeat(64)}`, name: "Bad Kids.mp3", path: "/Volumes/LISTEN/Black Lips/Bad Kids.mp3",
    sourceId: "listen", sourceLabel: "LISTEN", folder: "Black Lips", size: 6_000_000, modified: 1 };
  music.api.browseMemoryAudio = async (request) => {
    requests.push(request);
    if (request.query) return { sources: [], folders: [], files: [songFile], total: 1 };
    if (!request.sourceId) return { sources: [{ id: "listen", label: "LISTEN", count: 3 }], folders: [], files: [], total: 0 };
    if (!request.folder) return { sources: [{ id: "listen", label: "LISTEN", count: 3 }], folders: [{ name: "Black Lips", path: "Black Lips", count: 3 }], files: [], total: 0 };
    return { sources: [{ id: "listen", label: "LISTEN", count: 3 }], folders: [], files: [songFile], total: 1 };
  };
  const chosen = [];
  music.api.setMemorySoundtrack = async (id, trackId) => { chosen.push([id, trackId]); return await music.api.getMemories(); };
  await mount(React.createElement(MemoriesPage, { api: music.api }));
  await click("Browse your audio library…");
  const dialog = () => document.querySelector('[role="dialog"]');
  assert.ok(dialog().textContent.includes("Choose a song · Story song"));
  assert.ok(!document.querySelector('input[type="file"]'), "no native file picker");
  await act(async () => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent.includes("LISTEN")).click());
  await act(async () => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent.includes("Black Lips")).click());
  assert.deepEqual(requests.at(-1), { sourceId: "listen", folder: "Black Lips", query: "", sort: "name", direction: "asc", limit: 200 });
  assert.ok(dialog().textContent.includes("Audio library") && dialog().textContent.includes("Black Lips"), "breadcrumbs show the nested location");
  await change(dialog().querySelector('select[aria-label="Sort audio"]'), "modified");
  assert.equal(requests.at(-1).sort, "modified");
  await act(async () => { Simulate.change(dialog().querySelector('input[type="search"]'), { target: { value: "bad kids" } }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  assert.equal(requests.at(-1).query, "bad kids", "search is debounced and scoped like the file browser");
  await act(async () => button("Preview Bad Kids.mp3").click());
  assert.equal(dialog().querySelector("audio").getAttribute("src"), "app-media://stream/%2FVolumes%2FLISTEN%2FBlack%20Lips%2FBad%20Kids.mp3");
  await act(async () => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent.includes("Use song")).click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0, "picking closes the explorer");
  assert.deepEqual(chosen, [["song", songFile.id]], "the browsed song becomes the memory's song");
  assert.equal(document.querySelectorAll("select")[0].value, songFile.id, "the soundtrack menu shows the browsed song");
  await unmount();
  console.log("✓ in-app audio explorer: sources, nested folders, sort, search, preview and choosing a song");
}
run().then(() => console.log("Memories UI tests passed.")).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  require.extensions[".tsx"] = previousTSX;
  if (previousTS) require.extensions[".ts"] = previousTS; else delete require.extensions[".ts"];
  require.extensions[".css"] = previousCSS;
  dom.window.close();
});
