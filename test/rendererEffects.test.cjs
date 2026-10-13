const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.MutationObserver = dom.window.MutationObserver;
global.HTMLElement.prototype.scrollIntoView = function () {};
global.IS_REACT_ACT_ENVIRONMENT = true;
global.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = window.clearTimeout.bind(window);

// Transpile renderer sources in memory; do not build or load the Electron main.
for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(compiled, filename);
  };
}
require.extensions[".css"] = () => {};

const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = require("react-dom/test-utils");
const calls = new Map();
const listeners = new Map();
const cleanups = new Map();
const progress = {
  status: "idle",
  total: 0,
  processed: 0,
  indexed: 0,
  remaining: 0,
  errors: 0,
};
const files = [
  {
    name: "person.jpg",
    path: "/photos/person.jpg",
    modified: new Date("2024-06-01").getTime(),
  },
  {
    name: "empty.jpg",
    path: "/photos/empty.jpg",
    modified: new Date("2025-06-01").getTime(),
  },
  {
    name: "older.jpg",
    path: "/photos/older.jpg",
    modified: new Date("2023-06-01").getTime(),
  },
].map((file) => ({
  ...file,
  relativePath: file.name,
  size: 100,
  type: "image",
  extension: ".jpg",
  isDirectory: false,
}));
const sources = [
  {
    id: "/photos",
    rootPath: "/photos",
    kind: "local",
    label: "Photos",
    enabled: true,
    available: true,
  },
];
const state = {
  version: 1,
  digitalFolders: [],
  fileMetadata: {},
  indexSources: [],
  geoOverrides: {},
  indexProgress: progress,
  ui: {
    currentPath: "/photos",
    exploded: true,
    sortField: "people",
    sortAscending: false,
    includedType: "all",
    viewMode: "grid",
    showFilters: false,
    confidence: 25,
  },
};
const values = {
  getAppState: state,
  getAppVersion: require("../package.json").version,
  listSources: sources,
  getAllSourcesPath: "/__sources__/all",
  getFiles: files,
  getContentSettings: {
    showNsfw: false,
    safeSearch: true,
    theme: "system",
    autoplayGlobe: false,
    showBannedPeople: false,
  },
  getLifetimeLicense: { isLicensed: false },
  getDemoTestingMode: { available: false, enabled: false },
  getAppUpdateState: { status: "not-available", currentVersion: "2.0.5" },
  checkForAppUpdates: { status: "not-available", currentVersion: "2.0.5" },
  getStartupState: { ready: false, step: 1, total: 7, label: "Loading saved library indexes…" },
  getIndexStorageStatus: {
    message: null,
    usingLocalFallback: false,
    localFallbackEnabled: true,
    destinationAvailable: true,
    selectedDestination: "/backup",
    localFreeBytes: null,
    reserveBytes: 10 * 1024 * 1024 * 1024,
    transfer: null,
  },
  getSearchIndexReadiness: {
    status: "ready",
    percentage: 100,
    records: 0,
    message: "Search index is ready.",
  },
  getThumbnailPregenProgress: null,
  getDuplicateState: {
    ...progress,
    groups: [],
    trash: [],
    duplicateFiles: 0,
    reclaimableBytes: 0,
  },
  getFaceState: { progress, people: [] },
  getPetState: { progress, clusters: [] },
  getPhoneTooling: {
    ios: { available: true, missing: [] },
    android: { available: true, missing: [] },
  },
  getPhoneBackupDestination: "/backup",
  getPhoneBackupStates: [],
  getPhoneRestoreArchives: [],
  getGoogleState: { configured: false, accounts: [] },
  getLibraryShareStatus: { active: false, sources: [] },
  getAccessIdentity: { displayName: "test", bundlePath: "", isDev: true },
};
const bridge = new Proxy(
  {},
  {
    get(target, method) {
      if (!(method in target)) {
        target[method] = (...args) => {
          calls.set(method, (calls.get(method) || 0) + 1);
          if (method.startsWith("on")) {
            listeners.set(method, args[0]);
            return () => {
              cleanups.set(method, (cleanups.get(method) || 0) + 1);
              if (listeners.get(method) === args[0]) listeners.delete(method);
            };
          }
          if (method === "getPhotoIndicators") {
            return Promise.resolve(
              Object.fromEntries(
                args[0].map((filePath) => [
                  filePath,
                  {
                    hasLocation: false,
                    people: filePath.endsWith("/person.jpg") ? ["Person"] : [],
                  },
                ]),
              ),
            );
          }
          return Promise.resolve(values[method]);
        };
      }
      return target[method];
    },
  },
);
window.electron = bridge;
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.map(String).join(" "));
const App = require(path.join(__dirname, "../src/App.tsx")).default;
const GuidedTour = require(path.join(__dirname, "../src/components/GuidedTour.tsx")).default;
const root = createRoot(document.getElementById("root"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
  try {
    await act(async () => {
      root.render(
        React.createElement(React.StrictMode, null, React.createElement(App)),
      );
      await flush();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const appRoot = document.querySelector(".app");
    assert(document.querySelector(".startup-splash"), "startup splash stays visible until services are ready");
    assert(appRoot.hasAttribute("inert"), "the app cannot receive commands during startup");
    assert.match(
      document.querySelector(".startup-splash-version").textContent,
      new RegExp(require("../package.json").version),
      "startup splash displays the packaged app version",
    );
    await act(async () => {
      listeners.get("onStartupProgress")({
        ready: true,
        step: 7,
        total: 7,
        label: "Ready",
      });
      await flush();
    });
    assert.equal(document.querySelector(".startup-splash"), null);
    assert.equal(appRoot.hasAttribute("inert"), false, "the app becomes interactive after startup hydration");
    assert.equal(
      calls.get("getAppState"),
      2,
      "StrictMode hydration runs twice, not on every render",
    );
    assert.equal(
      calls.get("getPhoneBackupDestination"),
      2,
      "backup destination only loads on mounting",
    );
    assert.equal(calls.get("onPhoneBackupProgress"), 2);
    assert.equal(
      cleanups.get("onPhoneBackupProgress"),
      1,
      "only StrictMode replay cleans up before unmount",
    );
    assert.deepEqual(
      [...document.querySelectorAll(".file-year-grid-row strong")].map(
        (item) => item.textContent,
      ),
      ["2025 · No person", "2023 · No person", "2024 · Has person"],
    );
    assert(document.querySelector(".cloud-accounts"));
    await act(async () => {
      document.querySelector('button[aria-label="Settings"]').click();
      await flush();
    });
    const hideGoogleButton = [...document.querySelectorAll(".settings-panel button")].find(
      (button) => button.textContent.trim() === "Hide Google Accounts from Files",
    );
    assert(hideGoogleButton, "Settings can hide optional Google sources");
    await act(async () => {
      hideGoogleButton.click();
      await flush();
    });
    assert.equal(localStorage.getItem("silo.googleSourcesHidden"), "true");
    assert.equal(document.querySelector(".cloud-accounts"), null);
    const showGoogleButton = [...document.querySelectorAll(".settings-panel button")].find(
      (button) => button.textContent.trim() === "Show Google Accounts in Files",
    );
    assert(showGoogleButton, "Settings can restore the hidden Google section");
    await act(async () => {
      showGoogleButton.click();
      await flush();
    });
    assert.equal(localStorage.getItem("silo.googleSourcesHidden"), "false");
    assert(document.querySelector(".cloud-accounts"));
    for (let count = 0; count < 6; count += 1) {
      await act(async () => {
        listeners.get("onPhoneBackupProgress")({
          platform: "ios",
          deviceId: "test",
          status: "complete",
          completedFiles: count,
          totalFiles: 6,
        });
        await flush();
      });
    }
    assert.equal(
      calls.get("getAppState"),
      2,
      "phone progress must not rehydrate the browser",
    );
    assert.equal(calls.get("getPhoneBackupDestination"), 2);
    assert.equal(
      calls.get("onPhoneBackupProgress"),
      2,
      "state updates must not resubscribe",
    );
    assert(
      !errors.some((message) =>
        /Maximum update depth|Maximum call stack/.test(message),
      ),
      errors.join("\n"),
    );

    const tourHost = document.createElement("div");
    document.body.appendChild(tourHost);
    const tourRoot = createRoot(tourHost);
    await act(async () => {
      tourRoot.render(
        React.createElement(GuidedTour, {
          open: true,
          showAtStartup: false,
          contextStep: {
            id: "late-tour-anchor",
            title: "A late-loading control",
            body: "The guide waits for its target before showing this bubble.",
            target: '[data-tour="late-tour-anchor"]',
            section: "files",
          },
          onShowAtStartupChange: () => {},
          onNavigate: () => {},
          onClose: () => {},
        }),
      );
      await flush();
    });
    const tourCard = [...document.querySelectorAll(".guided-tour-card")].at(-1);
    assert.equal(
      tourCard.style.visibility,
      "hidden",
      "the tour bubble stays hidden while navigation renders its target",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    assert.equal(
      tourCard.style.visibility,
      "hidden",
      "a slow target never causes a centered bubble flash",
    );
    const lateTourAnchor = document.createElement("div");
    lateTourAnchor.setAttribute("data-tour", "late-tour-anchor");
    lateTourAnchor.getBoundingClientRect = () => ({
      x: 40,
      y: 100,
      left: 40,
      right: 60,
      top: 100,
      bottom: 130,
      width: 20,
      height: 30,
      toJSON: () => ({}),
    });
    document.body.appendChild(lateTourAnchor);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assert.equal(tourCard.style.visibility, "visible");
    assert.equal(tourCard.style.left, "84px", "the bubble first appears at the late target's measured position");
    await act(async () => tourRoot.unmount());
    tourHost.remove();
    lateTourAnchor.remove();
    console.log(
      "Renderer effects passed: stable hydration, persisted Google section visibility, tour bubble positioning, and no-person grouping.",
    );
  } finally {
    await act(async () => root.unmount());
    console.error = originalError;
    dom.window.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
