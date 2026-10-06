const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const React = require("react");
const { JSDOM } = require("jsdom");

const text = fs.readFileSync(
  path.join(__dirname, "../src/components/AudioLibrary.tsx"),
  "utf8",
);
const css = fs.readFileSync(path.join(__dirname, "../src/App.css"), "utf8");
const ast = ts.createSourceFile(
  "AudioLibrary.tsx",
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const helpers = ast.statements
  .filter(
    (node) =>
      (ts.isFunctionDeclaration(node) &&
        ["buildAudioRows", "audioRowAt", "audioRenderWindow"].includes(
          node.name?.text,
        )) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((d) =>
          d.name.getText(ast).startsWith("AUDIO_"),
        )),
  )
  .map((node) => node.getText(ast))
  .join("\n");
const helperContext = vm.createContext({});
vm.runInContext(
  ts.transpileModule(helpers, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText,
  helperContext,
);
const { buildAudioRows, audioRowAt, audioRenderWindow } = helperContext;
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

// Lazy inventories prove the virtual model never walks/allocates all track rows.
function lazyTracks(length) {
  return new Proxy(
    { length },
    {
      get(target, key) {
        if (key === "length") return length;
        if (/^\d+$/.test(String(key)))
          return { path: `/track/${key}`, name: `Track ${key}.mp3` };
        throw new Error(`Unexpected full-inventory operation: ${String(key)}`);
      },
    },
  );
}

test("284,097 exploded tracks: bounded initial, middle, bottom and resized windows", () => {
  const model = buildAudioRows([["all", lazyTracks(284097)]], true, new Set());
  assert.equal(model.spans.length, 1);
  assert.equal(model.count, 284097);
  assert.equal(model.height, 284097 * 64);
  for (const height of [0, 48, 640, 1200, 3600, 100000]) {
    for (const top of [0, 1, 100, 500, 10000, 4000000, 8000000, 1e12]) {
      const window = audioRenderWindow(model, top, height);
      assert.ok(window.rows.length <= 100);
      assert.equal(window.physicalHeight, 8000000);
      const viewport = Math.min(3600, height);
      const physicalTop = Math.min(8000000 - viewport, top);
      const logicalTop =
        (physicalTop / (8000000 - viewport)) * (model.height - viewport);
      const first = window.rows[0];
      const last = window.rows[window.rows.length - 1];
      assert.ok(first.offset <= logicalTop, "window must cover viewport start");
      assert.ok(
        last.offset + last.height >= logicalTop + viewport,
        "window must cover viewport end",
      );
      assert.ok(
        Math.abs(window.top + logicalTop - physicalTop - first.offset) < 0.0001,
      );
    }
  }
  const bottom = audioRenderWindow(model, 8000000, 640);
  assert.equal(bottom.rows[bottom.rows.length - 1].file.path, "/track/284096");
});

test("millions of tracks use bounded scroll height and O(groups) row metadata", () => {
  const model = buildAudioRows([["all", lazyTracks(5000000)]], true, new Set());
  assert.equal(model.spans.length, 1);
  assert.equal(audioRowAt(model, 4999999).file.path, "/track/4999999");
  for (let top = 0; top <= 8000000; top += 80000)
    assert.ok(audioRenderWindow(model, top, 3600).rows.length <= 100);
  assert.equal(
    audioRenderWindow(model, 8000000, 3600).rows.at(-1).index,
    4999999,
  );
});

test("mixed year headers and tracks have exact offsets; collapse excludes only DOM rows", () => {
  const first = lazyTracks(50000);
  const second = lazyTracks(234097);
  const groups = [
    ["2026", first],
    ["2025", second],
    ["Unknown year", []],
  ];
  const collapsed = buildAudioRows(groups, false, new Set());
  assert.equal(collapsed.count, 3);
  assert.equal(collapsed.height, 144);
  assert.equal(audioRowAt(collapsed, 1).year, "2025");
  assert.equal(audioRowAt(collapsed, 1).offset, 48);
  const expanded = buildAudioRows(groups, false, new Set(["2026", "2025"]));
  assert.equal(expanded.count, 284100);
  assert.equal(audioRowAt(expanded, 1).offset, 48);
  assert.equal(audioRowAt(expanded, 50001).file, null);
  assert.equal(audioRowAt(expanded, 50001).offset, 48 + 50000 * 64);
  assert.equal(audioRowAt(expanded, 50002).offset, 96 + 50000 * 64);
  assert.equal(
    first.length + second.length,
    284097,
    "collapsed playback inventory is untouched",
  );
  for (const top of [0, 100000, 4000000, 8000000])
    assert.ok(audioRenderWindow(expanded, top, 3600).rows.length <= 100);
});

test("bound is global across 500 expanded groups, including header-only windows", () => {
  const groups = Array.from({ length: 500 }, (_, i) => [
    String(i),
    lazyTracks(1000),
  ]);
  const model = buildAudioRows(
    groups,
    false,
    new Set(groups.map(([year]) => year)),
  );
  assert.ok(audioRenderWindow(model, 0, 3600).rows.length <= 100);
  const collapsed = buildAudioRows(groups, false, new Set());
  assert.ok(audioRenderWindow(collapsed, 12000, 3600).rows.length <= 100);
  assert.equal(
    audioRenderWindow(collapsed, 24000, 3600).rows.at(-1).year,
    "499",
  );
});

test("empty model and stale scroll offsets are safe", () => {
  const empty = buildAudioRows([["all", []]], true, new Set());
  assert.equal(audioRenderWindow(empty, 100000, 640).rows.length, 0);
  const small = buildAudioRows([["all", lazyTracks(2)]], true, new Set());
  const window = audioRenderWindow(small, 100000, 640);
  assert.equal(window.rows.length, 2);
  assert.equal(window.top, 0);
  assert.equal(window.physicalHeight, 128);
});

test("CSS geometry matches production constants and prevents scroll anchoring", () => {
  assert.match(
    css,
    /\.audio-virtual-window > \.audio-year-toggle\s*\{[^}]*height: 48px;[^}]*margin: 0;/,
  );
  assert.match(
    css,
    /\.audio-virtual-window > \.audio-track\s*\{[^}]*height: 64px;[^}]*margin: 0;/,
  );
  assert.match(
    css,
    /\.audio-track-list\s*\{[^}]*max-height: 3600px;[^}]*overflow-anchor: none;/,
  );
  assert.match(text, /const orderedFiles = useMemo/);
  assert.match(text, /const activeFile = useMemo/);
  assert.match(text, /const activeIndex = useMemo/);
  assert.doesNotMatch(text, /setVisualBars|tracks\.map\(/);
});

async function mountedTests() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require("react-dom/client");
  const act = React.act || require("react-dom/test-utils").act;
  let viewportHeight = 640;
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    get: () => viewportHeight,
  });
  const observers = new Set();
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      observers.add(this);
    }
    observe() {}
    disconnect() {
      observers.delete(this);
    }
  }
  const frames = new Map();
  let frameId = 0;
  let spectrumReads = 0;
  let dateReads = 0;
  class CountingDate extends Date {
    constructor(...args) {
      super(...args);
      dateReads++;
    }
  }
  class AudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createMediaElementSource() {
      return { connect() {} };
    }
    createAnalyser() {
      return {
        frequencyBinCount: 128,
        connect() {},
        getByteFrequencyData(values) {
          spectrumReads++;
          values.fill(128);
        },
      };
    }
    createGain() {
      return { connect() {}, gain: { value: 1, setTargetAtTime() {} } };
    }
    close() {
      return Promise.resolve();
    }
  }
  dom.window.HTMLMediaElement.prototype.pause = function () {
    this.dispatchEvent(new dom.window.Event("pause"));
  };
  dom.window.HTMLMediaElement.prototype.play = function () {
    this.dispatchEvent(new dom.window.Event("play"));
    return Promise.resolve();
  };
  const inventory = Array.from({ length: 284097 }, (_, i) => ({
    path: `/music/${i}.mp3`,
    name: `Track ${i}.mp3`,
    extension: ".mp3",
    size: i + 100,
    modified: Date.UTC(i % 2 ? 2025 : 2026, 0, 1),
    type: "audio",
    isDirectory: false,
  }));
  const context = vm.createContext({
    exports: {},
    console,
    Date: CountingDate,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    document: dom.window.document,
    ResizeObserver,
    AudioContext,
    requestAnimationFrame(callback) {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    require(id) {
      if (id === "../utils/audioTypes")
        return { audioExtension: (name) => path.extname(name) };
      if (id === "../utils/audioSort")
        return {
          compareAudioFiles: (a, b, sort) =>
            (a.size - b.size) * (sort.ascending ? 1 : -1),
        };
      if (id === "../utils/readInventory")
        return {
          loadAudioInventory: async () => ({
            files: inventory,
            extensions: [".mp3"],
            sourceIds: ["music"],
            stale: false,
          }),
          readInventory: async (_api, files) => files,
        };
      return require(id);
    },
  });
  vm.runInContext(
    ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText,
    context,
  );
  const Component = context.exports.default;
  const previewPaths = [];
  const favoritePaths = [];
  const api = {
    onAudioLibraryScanProgress: () => () => {},
    onAudioLibraryCacheChanged: () => () => {},
    getFilePreview: async (filePath) => {
      previewPaths.push(filePath);
      return { mediaUrl: "http://localhost/audio" };
    },
  };
  let props = {
    electronAPI: api,
    visible: true,
    exploded: true,
    yearFilter: "all",
    sort: { field: "size", ascending: true },
    favoritePaths: new Set(),
    onAudioYearsChange() {},
    onToggleFavorite(filePath) {
      favoritePaths.push(filePath);
    },
  };
  const root = createRoot(document.getElementById("root"));
  const render = async (changes) => {
    props = { ...props, ...changes };
    await act(async () => {
      root.render(React.createElement(Component, props));
    });
  };
  const click = async (element) => {
    assert.ok(element, "expected mounted control");
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
  };
  const bound = () =>
    assert.ok(
      document.querySelectorAll(".audio-track, .audio-year-toggle").length <=
        100,
    );
  try {
    await render({});
    bound();
    assert.equal(document.querySelectorAll(".audio-track").length, 21);
    const mountedTracks = document.querySelectorAll(".audio-track");
    await click(
      mountedTracks[mountedTracks.length - 1].querySelector(
        ".audio-track-open",
      ),
    );
    assert.equal(previewPaths.at(-1), "/music/20.mp3");
    await click(document.querySelector('[aria-label="Next track"]'));
    assert.equal(
      previewPaths.at(-1),
      "/music/21.mp3",
      "next plays unmounted track",
    );
    await click(document.querySelector('[aria-label="Previous track"]'));
    assert.equal(previewPaths.at(-1), "/music/20.mp3");
    await click(document.querySelector(".audio-track-favorite"));
    assert.equal(favoritePaths.at(-1), "/music/0.mp3");
    await render({
      onToggleFavorite: (value) => favoritePaths.push(`latest:${value}`),
    });
    await click(document.querySelector(".audio-track-favorite"));
    assert.equal(favoritePaths.at(-1), "latest:/music/0.mp3");
    passed++;
    console.log(
      "PASS mounted 284,097 tracks: 21 initial rows, full next/previous and current favorite callbacks",
    );

    const dateReadsBefore = dateReads;
    const runFrame = (timestamp) => {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach((callback) => callback(timestamp));
    };
    for (const timestamp of [0, 16, 49, 50]) runFrame(timestamp);
    assert.equal(spectrumReads, 2);
    assert.equal(
      dateReads,
      dateReadsBefore,
      "visualizer must not rerender track metadata",
    );
    assert.match(
      document
        .querySelector(".audio-visualizer > i")
        .style.getPropertyValue("--bar-height"),
      /px$/,
    );
    await render({ visible: false });
    assert.equal(frames.size, 0);
    passed++;
    console.log(
      "PASS visualizer: 20fps imperative updates, zero library rerenders, stops when hidden",
    );

    await render({ visible: true });
    const list = document.querySelector(".audio-track-list");
    await act(async () => {
      list.scrollTop = 8000000;
      list.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    bound();
    assert.equal(
      document.querySelectorAll(".audio-track-copy strong")[
        document.querySelectorAll(".audio-track-copy strong").length - 1
      ].textContent,
      "Track 284096.mp3",
    );
    await act(async () => {
      viewportHeight = 3600;
      observers.forEach((observer) => observer.callback());
    });
    bound();
    await render({ exploded: false });
    assert.equal(list.scrollTop, 0);
    assert.equal(document.querySelectorAll(".audio-track").length, 0);
    assert.equal(document.querySelectorAll(".audio-year-toggle").length, 2);
    await click(document.querySelector(".audio-year-toggle"));
    bound();
    assert.ok(document.querySelectorAll(".audio-track").length > 0);
    await click(document.querySelector('[aria-label="Next track"]'));
    assert.equal(
      previewPaths.at(-1),
      "/music/22.mp3",
      "grouped playback includes tracks regardless of collapse",
    );
    await click(document.querySelector(".audio-year-toggle"));
    assert.equal(document.querySelectorAll(".audio-track").length, 0);
    await render({ yearFilter: "2025", exploded: true });
    bound();
    assert.equal(
      document.querySelector(".audio-track-copy strong").textContent,
      "Track 1.mp3",
    );
    await click(document.querySelector(".audio-format-trigger"));
    await click(document.querySelector(".all-formats input"));
    assert.equal(document.querySelectorAll(".audio-track").length, 0);
    assert.match(
      document.querySelector(".audio-empty").textContent,
      /No tracks match/,
    );
    passed++;
    console.log(
      "PASS mounted scroll bottom, ResizeObserver, group expand/collapse, year and format filters",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    assert.equal(observers.size, 0);
    assert.equal(frames.size, 0);
    dom.window.close();
  }
}

mountedTests()
  .then(() =>
    console.log(
      `\n${passed} audio rendering regressions passed; hard bound: 100 mounted track/header rows.`,
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
