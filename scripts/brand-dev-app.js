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
const APP_BUNDLE_IDENTIFIER = "com.solosilo.app.dev";
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
    console.log("Re-signed the Silo development bundle.");
    return true;
  } catch (error) {
    console.error(
      "Could not re-sign the Silo development bundle. Refusing to launch it with an ambiguous app identity.",
    );
    if (error && typeof error === "object" && "stderr" in error && error.stderr)
      console.error(String(error.stderr));
    return false;
  }
}

if (restoring) {
  if (!fs.existsSync(backupPath)) {
    console.log("No backup found; the bundle is already unmodified.");
    process.exit(0);
  }
  fs.copyFileSync(backupPath, plistPath);
  fs.unlinkSync(backupPath);
  if (!resign()) process.exit(1);
  console.log('Restored the original Electron development bundle.');
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
if (!restoring && readPlistValue("CFBundleName") === APP_NAME
  && readPlistValue("CFBundleDisplayName") === APP_NAME
  && readPlistValue("CFBundleIdentifier") === APP_BUNDLE_IDENTIFIER
  && readPlistValue("CFBundleIconFile") === "silo.icns" && fs.existsSync(iconTarget)) {
  if (!quiet) console.log(`Development bundle is already named "${APP_NAME}".`);
  process.exit(0);
}

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(plistPath, backupPath);
}

setPlistValue("CFBundleName", APP_NAME);
setPlistValue("CFBundleDisplayName", APP_NAME);
setPlistValue("CFBundleIdentifier", APP_BUNDLE_IDENTIFIER);
if (fs.existsSync(iconSource)) {
  fs.copyFileSync(iconSource, iconTarget);
  setPlistValue("CFBundleIconFile", "silo.icns");
}
if (!resign()) process.exit(1);

console.log(`Development bundle is now named "${APP_NAME}" (${APP_BUNDLE_IDENTIFIER}).`);
console.log("\nNext steps:");
console.log("  1. Quit any running Silo development instance.");
console.log(
  "  2. Open System Settings > Privacy & Security > Full Disk Access.",
);
console.log(`  3. Select "${APP_NAME}" in Full Disk Access. Remove an obsolete dev entry if one remains.`);
console.log(`     Bundle: ${appPath}`);
console.log("  4. Start the app again with npm run dev.");
