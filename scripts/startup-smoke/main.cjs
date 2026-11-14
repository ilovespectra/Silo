const fs = require("fs");
const path = require("path");
const { app, ipcMain } = require("electron");
const debug = (...values) => {
  if (process.env.SILO_STARTUP_SMOKE_DEBUG === "1")
    console.error("[startup-smoke]", ...values);
};

const projectRoot = path.resolve(__dirname, "../..");
const allowedTempRoot = path.resolve(
  process.env.SILO_STARTUP_SMOKE_ROOT || path.resolve(projectRoot, "../../tmp"),
);
const appPath = path.resolve(process.env.SILO_STARTUP_SMOKE_APP_PATH || projectRoot);
const mainPath = path.resolve(
  process.env.SILO_STARTUP_SMOKE_MAIN_PATH || path.join(projectRoot, "electron-dist/main.js"),
);
const userDataPath = process.env.SILO_STARTUP_SMOKE_USER_DATA;
const markerPath = process.env.SILO_STARTUP_SMOKE_MARKER;
const noticeMarkerPath = process.env.SILO_STARTUP_SMOKE_NOTICE_MARKER;
const readinessMarkerPath = process.env.SILO_STARTUP_SMOKE_READINESS_MARKER;
const startupReadyMarkerPath = process.env.SILO_STARTUP_SMOKE_READY_MARKER;
const scenario = process.env.SILO_STARTUP_SMOKE_SCENARIO;
const isWithin = (candidate, root) => candidate.startsWith(`${root}${path.sep}`);
if (!userDataPath || !markerPath || !noticeMarkerPath || !readinessMarkerPath || !startupReadyMarkerPath || !scenario) {
  console.error("Startup smoke test environment is incomplete.");
  process.exit(20);
}
if (
  process.env.SILO_STARTUP_SMOKE_APP_PATH && !isWithin(appPath, allowedTempRoot)
) {
  console.error(`Refusing to use non-cache app path: ${appPath}`);
  process.exit(21);
}
if (
  process.env.SILO_STARTUP_SMOKE_MAIN_PATH && !isWithin(mainPath, allowedTempRoot)
) {
  console.error(`Refusing to use non-cache main path: ${mainPath}`);
  process.exit(22);
}
const resolvedUserData = path.resolve(userDataPath);
if (!isWithin(resolvedUserData, allowedTempRoot)) {
  console.error(`Refusing to use non-test userData path: ${resolvedUserData}`);
  process.exit(23);
}
app.setAppPath(appPath);
fs.mkdirSync(resolvedUserData, { recursive: true });
process.env.FILE_BROWSER_USER_DATA_DIR = resolvedUserData;
app.setPath("userData", resolvedUserData);
app.disableHardwareAcceleration();
const fixtureStartedAt = Date.now();
debug("fixture loaded", { ready: app.isReady(), userData: resolvedUserData, appPath, mainPath });
app.once("ready", () => debug("Electron ready"));

const handlers = new Map();
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener);
  return registerHandler(channel, listener);
};

let mainWindowReady = false;
let storageCheckDone = false;
let searchReady = false;
let startupReady = false;
const maybeQuit = () => {
  if (mainWindowReady && storageCheckDone && searchReady && startupReady)
    app.quit();
};
const writeMarker = (filename, payload) => {
  fs.writeFileSync(filename, JSON.stringify({ scenario, ...payload }));
};

app.on("browser-window-created", (_event, window) => {
  const originalSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    const payload = args[0];
    if (channel === "search-index-readiness" &&
        (payload?.status === "ready" || payload?.status === "unavailable")) {
      writeMarker(readinessMarkerPath, {
        status: payload.status,
        message: payload.message,
        completedAt: Date.now(),
        fixtureElapsedMs: Date.now() - fixtureStartedAt,
      });
      searchReady = true;
      maybeQuit();
    }
    if (channel === "startup-progress" && payload?.ready === true) {
      writeMarker(startupReadyMarkerPath, {
        label: payload.label,
        completedAt: Date.now(),
        fixtureElapsedMs: Date.now() - fixtureStartedAt,
      });
      startupReady = true;
      maybeQuit();
    }
    return originalSend(channel, ...args);
  };

  if (window.getTitle() === "Silo is starting") return;
  window.once("ready-to-show", () => {
    writeMarker(markerPath, {
      windowReady: true,
      title: window.getTitle(),
      completedAt: Date.now(),
      fixtureElapsedMs: Date.now() - fixtureStartedAt,
    });
    mainWindowReady = true;
    maybeQuit();
  });

  void (async () => {
    const getStorageStatus = handlers.get("get-index-storage-status");
    if (!getStorageStatus) throw new Error("Storage status handler was not registered.");
    const status = await getStorageStatus({ sender: window.webContents });
    writeMarker(noticeMarkerPath, status);
    storageCheckDone = true;
    maybeQuit();
  })().catch((error) => {
    writeMarker(noticeMarkerPath, { error: String(error) });
    app.exit(24);
  });
});
setTimeout(() => {
  console.error("Timed out before startup and search readiness completed.");
  app.exit(25);
}, 85000).unref();

require(mainPath);
debug("main module loaded");
