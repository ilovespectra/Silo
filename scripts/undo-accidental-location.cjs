const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// Narrowly scoped recovery for the explicitly requested accidental assignment.
const statePath = path.join(
  os.homedir(),
  "Library/Application Support/file-browser-electron/browser-state.json",
);
const processes = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
if (processes.includes("Electron.app/Contents/MacOS/Electron"))
  throw new Error(
    "Quit Silo before recovering state to prevent concurrent writes.",
  );
const original = fs.readFileSync(statePath);
const state = JSON.parse(original);
const start = Date.parse("2026-10-03T10:49:26.497Z");
const end = Date.parse("2026-10-03T10:49:26.654Z");
const affected = Object.entries(state.geoOverrides ?? {}).filter(
  ([, value]) =>
    value.updatedAt >= start &&
    value.updatedAt <= end &&
    value.location?.id === "W:9298329" &&
    value.location.latitude === 34.042339 &&
    value.location.longitude === -84.0652925,
);
if (affected.length !== 473891)
  throw new Error(
    `Unexpected affected count: ${affected.length}; recovery aborted without changes.`,
  );
const backupDir = path.join(
  os.homedir(),
  "Documents",
  `silo-location-recovery-${Date.now()}`,
);
fs.mkdirSync(backupDir, { recursive: false });
const backupPath = path.join(backupDir, "browser-state-before-undo.json");
fs.copyFileSync(statePath, backupPath, fs.constants.COPYFILE_EXCL);
if (!fs.readFileSync(backupPath).equals(original))
  throw new Error("Safety backup verification failed.");
const preserved = { ...state.geoOverrides };
for (const [filePath] of affected) {
  delete state.geoOverrides[filePath];
  delete preserved[filePath];
}
const replacement = JSON.stringify(state);
const temporary = `${statePath}.location-undo.tmp`;
fs.writeFileSync(temporary, replacement, {
  flag: "wx",
  mode: fs.statSync(statePath).mode,
});
const verified = JSON.parse(fs.readFileSync(temporary, "utf8"));
if (JSON.stringify(verified.geoOverrides) !== JSON.stringify(preserved))
  throw new Error("Preserved locations do not match.");
const beforeOther = JSON.parse(original);
delete beforeOther.geoOverrides;
const afterOther = { ...verified };
delete afterOther.geoOverrides;
if (JSON.stringify(beforeOther) !== JSON.stringify(afterOther))
  throw new Error("Unrelated state changed.");
if (!fs.readFileSync(statePath).equals(original))
  throw new Error("State changed during recovery; refusing replacement.");
fs.renameSync(temporary, statePath);
fs.writeFileSync(
  path.join(backupDir, "recovery-summary.json"),
  JSON.stringify(
    {
      removed: affected.length,
      preserved: Object.keys(preserved).length,
      assignmentStart: new Date(start).toISOString(),
      assignmentEnd: new Date(end).toISOString(),
      backupSha256: crypto.createHash("sha256").update(original).digest("hex"),
      originalFilesModified: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    removed: affected.length,
    preserved: Object.keys(preserved).length,
    backupDirectory: backupDir,
    repairedStateBytes: fs.statSync(statePath).size,
    unrelatedStateVerified: true,
  }),
);
