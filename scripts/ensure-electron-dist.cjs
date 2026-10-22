#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const electronPackageRoot = path.join(packageRoot, "node_modules", "electron");
const infoPlist = path.join(
  electronPackageRoot,
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist",
);

if (fs.existsSync(infoPlist)) {
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
  require(installScript);
  if (!fs.existsSync(infoPlist)) {
    throw new Error(`Electron bundle still missing at ${infoPlist}`);
  }
  console.log("[ensure-electron-dist] Electron bundle ready.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ensure-electron-dist] Failed to download Electron bundle: ${message}`);
  process.exit(1);
}
