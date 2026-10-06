#!/usr/bin/env node
// macOS shows the running bundle's name in Full Disk Access. In development that
// bundle is node_modules/electron/dist/Electron.app, so it lists as "Electron".
// This renames it to "silo" and re-signs so macOS still launches it.
//
//   npm run brand-dev      apply
//   npm run unbrand-dev    revert
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP_NAME = "Silo";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

const appPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);
const plistPath = path.join(appPath, "Contents", "Info.plist");
const backupPath = path.join(appPath, "Contents", "Info.plist.solosilo-backup");

if (process.platform !== "darwin") {
  console.log("Not macOS; nothing to do.");
  process.exit(0);
}

if (!fs.existsSync(plistPath)) {
  console.error(`Could not find ${plistPath}\nRun npm install first.`);
  process.exit(1);
}

const restoring = process.argv.includes("--restore");

function setPlistValue(key, value) {
  try {
    execFileSync(PLIST_BUDDY, ["-c", `Set :${key} ${value}`, plistPath]);
  } catch {
    execFileSync(PLIST_BUDDY, ["-c", `Add :${key} string ${value}`, plistPath]);
  }
}

function resign() {
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "pipe",
    });
    console.log("Re-signed the bundle.");
  } catch (error) {
    console.warn(
      "Could not re-sign the bundle. If Electron refuses to launch, run:\n" +
        `  codesign --force --deep --sign - "${appPath}"`,
    );
  }
}

if (restoring) {
  if (!fs.existsSync(backupPath)) {
    console.log("No backup found; the bundle is already unmodified.");
    process.exit(0);
  }
  fs.copyFileSync(backupPath, plistPath);
  fs.unlinkSync(backupPath);
  resign();
  console.log('Restored the development bundle to "Electron".');
  console.log("Remove the old entry from Full Disk Access and re-add it.");
  process.exit(0);
}

const iconSource = path.join(__dirname, "..", "public", "icon.icns");
const iconTarget = path.join(appPath, "Contents", "Resources", "silo.icns");
const quiet = process.argv.includes("--quiet");

function readPlistValue(key) {
  try {
    return execFileSync(PLIST_BUDDY, ["-c", `Print :${key}`, plistPath], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// The launcher calls this on every start; nothing changes (or re-signs) when already branded.
if (!restoring && readPlistValue("CFBundleName") === APP_NAME && readPlistValue("CFBundleIconFile") === "silo.icns"
  && fs.existsSync(iconTarget)) {
  if (!quiet) console.log(`Development bundle is already named "${APP_NAME}".`);
  process.exit(0);
}

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(plistPath, backupPath);
}

setPlistValue("CFBundleName", APP_NAME);
setPlistValue("CFBundleDisplayName", APP_NAME);
if (fs.existsSync(iconSource)) {
  fs.copyFileSync(iconSource, iconTarget);
  setPlistValue("CFBundleIconFile", "silo.icns");
}
resign();

console.log(`Development bundle is now named "${APP_NAME}".`);
console.log("\nNext steps:");
console.log("  1. Quit any running Electron instance.");
console.log(
  "  2. Open System Settings > Privacy & Security > Full Disk Access.",
);
console.log(`  3. Remove any stale "Electron" entry, then add "${APP_NAME}".`);
console.log(`     Bundle: ${appPath}`);
console.log("  4. Start the app again with npm run dev.");
