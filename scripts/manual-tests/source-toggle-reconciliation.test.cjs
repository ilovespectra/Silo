const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { reconcilePendingSourceToggles } = require("../../src/sourceToggleReconciliation.ts");
const original = [
  { id: "photos", enabled: true },
  { id: "archive", enabled: false },
];
const optimistic = [
  { id: "photos", enabled: false },
  { id: "archive", enabled: true },
];
const pending = new Map([["photos", 1], ["archive", 1]]);

assert.deepEqual(
  reconcilePendingSourceToggles(original, optimistic, pending),
  optimistic,
  "a periodic stale refresh must preserve pending optimistic choices",
);
assert.deepEqual(
  reconcilePendingSourceToggles(original, optimistic, pending, new Set(["photos"])),
  [original[0], optimistic[1]],
  "a failed source toggle must roll back that source while preserving other pending toggles",
);
assert.deepEqual(
  reconcilePendingSourceToggles(
    [
      { id: "photos", enabled: false },
      { id: "archive", enabled: false },
    ],
    optimistic,
    pending,
    new Set(["photos"]),
  ),
  [{ id: "photos", enabled: false }, optimistic[1]],
  "a completed toggle must accept its authoritative result and retain unrelated pending choices",
);

console.log("Source toggle reconciliation tests passed (3 checks)");
