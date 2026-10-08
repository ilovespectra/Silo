const fs = require("fs");
const path = require("path");
const { app, dialog } = require("electron");
const debug = (...values) => {
  if (process.env.SILO_STARTUP_SMOKE_DEBUG === "1")
    console.error("[startup-smoke]", ...values);
};

const userDataPath = process.env.SILO_STARTUP_SMOKE_USER_DATA;
const markerPath = process.env.SILO_STARTUP_SMOKE_MARKER;
const noticeMarkerPath = process.env.SILO_STARTUP_SMOKE_NOTICE_MARKER;
const scenario = process.env.SILO_STARTUP_SMOKE_SCENARIO;
const allowedTempRoot = path.resolve(__dirname, "../../tmp");
if (!userDataPath || !markerPath || !scenario) {
  console.error("Startup smoke test environment is incomplete.");
  process.exit(20);
}
const resolvedUserData = path.resolve(userDataPath);
if (!resolvedUserData.startsWith(`${allowedTempRoot}${path.sep}`)) {
  console.error(`Refusing to use non-test userData path: ${resolvedUserData}`);
  process.exit(21);
}
fs.mkdirSync(resolvedUserData, { recursive: true });
process.env.FILE_BROWSER_USER_DATA_DIR = resolvedUserData;
app.setPath("userData", resolvedUserData);
app.disableHardwareAcceleration();
debug("fixture loaded", { ready: app.isReady(), userData: resolvedUserData });
app.once("ready", () => debug("Electron ready"));

const showMessageBox = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = async (...args) => {
  const options = args[args.length - 1];
  if (options?.title === "Using Local Index Storage") {
    fs.writeFileSync(
      noticeMarkerPath,
      JSON.stringify({ type: options.type, title: options.title, message: options.message }),
    );
    return { response: 0, checkboxChecked: false };
  }
  return showMessageBox(...args);
};

app.once("browser-window-created", () => {
  fs.writeFileSync(markerPath, JSON.stringify({ scenario, windowCreated: true }));
  setTimeout(() => app.quit(), 100);
});
setTimeout(() => {
  console.error("Timed out before the main process created a window.");
  app.exit(22);
}, 45000).unref();

require("./electron-dist/main.js");
debug("main module loaded");
