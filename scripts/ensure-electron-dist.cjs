#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const electronPackageRoot = path.join(packageRoot, "node_modules", "electron");
const electronPackage = JSON.parse(
  fs.readFileSync(path.join(electronPackageRoot, "package.json"), "utf8"),
);
const requiredVersion = require(path.join(packageRoot, "package.json")).devDependencies.electron;
if (electronPackage.version !== requiredVersion) {
  throw new Error(
    `[ensure-electron-dist] Installed Electron ${electronPackage.version}; ` +
      `package.json requires ${requiredVersion}. Reinstall dependencies with npm ci.`,
  );
}

function electronExecutablePath() {
  const dist = path.join(electronPackageRoot, "dist");
  switch (process.platform) {
    case "darwin":
      return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
    case "win32":
      return path.join(dist, "electron.exe");
    default:
      return path.join(dist, "electron");
  }
}

function isUsableFile(filePath, executable = false) {
  const stat = fs.statSync(filePath);
  return stat.isFile() && stat.size > 0 &&
    (!executable || process.platform === "win32" || (stat.mode & 0o111) !== 0);
}

function electronBundleIsReady() {
  const dist = path.join(electronPackageRoot, "dist");
  const platformPath = path.relative(dist, electronExecutablePath()).split(path.sep).join("/");
  try {
    return (
      fs.readFileSync(path.join(dist, "version"), "utf8").replace(/^v/, "") === requiredVersion &&
      fs.readFileSync(path.join(electronPackageRoot, "path.txt"), "utf8") === platformPath &&
      isUsableFile(electronExecutablePath(), true) &&
      (process.platform !== "darwin" ||
        isUsableFile(path.join(dist, "Electron.app", "Contents", "Info.plist")))
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

if (electronBundleIsReady()) {
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
  fs.rmSync(path.join(electronPackageRoot, "dist"), { recursive: true, force: true });
  fs.rmSync(path.join(electronPackageRoot, "path.txt"), { force: true });
  const result = spawnSync(process.execPath, [installScript], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron install exited with code ${result.status}`);
  }
  if (!electronBundleIsReady()) {
    throw new Error("Electron bundle still incomplete after installation.");
  }
  console.log("[ensure-electron-dist] Electron bundle ready.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ensure-electron-dist] Failed to download Electron bundle: ${message}`);
  process.exit(1);
}
