#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const electronPackageRoot = path.join(packageRoot, "node_modules", "electron");

function electronBundlePath() {
  const dist = path.join(electronPackageRoot, "dist");
  switch (process.platform) {
    case "darwin":
      return path.join(dist, "Electron.app", "Contents", "Info.plist");
    case "win32":
      return path.join(dist, "electron.exe");
    default:
      return path.join(dist, "electron");
  }
}

const bundlePath = electronBundlePath();
if (fs.existsSync(bundlePath)) {
  console.log("[ensure-electron-dist] Electron bundle present.");
  process.exit(0);
}

const installScript = path.join(electronPackageRoot, "install.js");
if (!fs.existsSync(installScript)) {
  console.error(
    "[ensure-electron-dist] Electron install script was not found. Reinstall dependencies.",
  );
  process.exit(1);
}

console.log("[ensure-electron-dist] Electron bundle missing; downloading it now…");
try {
  const result = spawnSync(process.execPath, [installScript], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron install exited with code ${result.status}`);
  }
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Electron bundle still missing at ${bundlePath}`);
  }
  console.log("[ensure-electron-dist] Electron bundle ready.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ensure-electron-dist] Failed to download Electron bundle: ${message}`);
  process.exit(1);
}
