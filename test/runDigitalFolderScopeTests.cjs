"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "src", "utils", "digitalFolderScope.ts");
const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const loaded = { exports: {} };
new Function("exports", "module", output)(loaded.exports, loaded);
const { filterToDigitalFolderScope } = loaded.exports;

const files = [
  { path: "/photos/travel/inside.jpg" },
  { path: "/archive/inside.jpg" },
  { path: "/archive/outside-folder.jpg" },
  { path: "/unregistered/inside.jpg" },
];
const folderPaths = new Set([
  "/photos/travel/inside.jpg",
  "/archive/inside.jpg",
  "/archive/outside-folder.jpg",
]);
const enabledRoots = new Set(["/photos"]);
const allRoots = new Set(["/photos", "/archive"]);
const visibleForSelectedSources = (filePath) => {
  const within = (root) => filePath === root || filePath.startsWith(`${root}/`);
  return [...enabledRoots].some(within) || ![...allRoots].some(within);
};

const folderView = filterToDigitalFolderScope(
  files,
  folderPaths,
  visibleForSelectedSources,
);
assert.deepEqual(
  folderView.map((file) => file.path),
  ["/photos/travel/inside.jpg"],
  "folder membership and enabled-source filters both constrain folder results",
);

const ordinaryView = filterToDigitalFolderScope(
  files,
  null,
  visibleForSelectedSources,
);
assert.deepEqual(
  ordinaryView.map((file) => file.path),
  ["/photos/travel/inside.jpg", "/unregistered/inside.jpg"],
  "without a folder scope, selected-source filtering remains in effect",
);

assert.deepEqual(
  filterToDigitalFolderScope(files, new Set(), visibleForSelectedSources),
  [],
  "an active folder with no known references fails closed instead of leaking files",
);

console.log("Digital Folder scope tests passed: membership and source filters fail closed.");
