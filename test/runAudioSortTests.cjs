const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const source = fs.readFileSync(
  path.join(__dirname, "../src/utils/audioSort.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const m = { exports: {} };
new Function("module", "exports", compiled)(m, m.exports);
const files = [
  {
    name: "Track 10",
    path: "b",
    size: 30,
    modified: 300,
    extension: ".wav",
    sourceLabel: "Z",
  },
  {
    name: "Track 2",
    path: "a",
    size: 10,
    modified: 100,
    extension: ".aac",
    sourceLabel: "A",
  },
  {
    name: "Track 3",
    path: "c",
    size: 20,
    modified: 200,
    extension: ".mp3",
    sourceLabel: "M",
  },
];
for (const field of ["name", "modified", "size", "type", "source"]) {
  for (const ascending of [true, false]) {
    const sorted = [...files].sort((a, b) =>
      m.exports.compareAudioFiles(a, b, { field, ascending }),
    );
    assert.deepEqual(
      sorted.map((f) => f.path),
      ascending ? ["a", "c", "b"] : ["b", "c", "a"],
    );
  }
}
const ast = ts.createSourceFile(
  "AudioLibrary.tsx",
  fs.readFileSync(
    path.join(__dirname, "../src/components/AudioLibrary.tsx"),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let groupFn;
function walk(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "byYear")
    groupFn = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, walk);
}
walk(ast);
const groupCode = ts.transpileModule("module.exports=" + groupFn, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
for (const ascending of [true, false]) {
  const g = { exports: null };
  new Function("filteredFiles", "yearOf", "sort", "module", groupCode)(
    [{ year: "2024" }, { year: "2026" }, { year: "Unknown year" }],
    (f) => f.year,
    { field: "modified", ascending },
    g,
  );
  assert.deepEqual(
    g.exports().map(([year]) => year),
    ascending
      ? ["2024", "2026", "Unknown year"]
      : ["2026", "2024", "Unknown year"],
  );
}
console.log(
  "Audio sorting tests passed: natural alphabetic order, date, size, format, source, both directions, and chronological year groups.",
);
