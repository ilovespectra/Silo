const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

function compile(text) {
  return ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
}
async function run() {
  const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  const ast = ts.createSourceFile(
    "App.tsx",
    app,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let effect, effectDependencies, grouping;
  function walk(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "useEffect" &&
      node.arguments[0].getText(ast).includes("const mediaPaths = contentFiles")
    ) {
      effect = node.arguments[0].getText(ast);
      effectDependencies = node.arguments[1].getText(ast);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === "yearSections"
    )
      grouping = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, walk);
  }
  walk(ast);
  assert(
    !effectDependencies.includes("sortIndicatorRevision"),
    "progress must not cancel an active lookup",
  );
  const files = Array.from({ length: 12001 }, (_, i) => ({
    path: String(i),
    type: "image",
    isDirectory: false,
    year: i % 2 ? "2025" : "2026",
  }));
  const metadata = Object.fromEntries(
    files.map((file, i) => [
      file.path,
      {
        people: i % 3 === 0 ? ["Person"] : [],
        hasLocation: i % 4 === 0,
      },
    ]),
  );
  let calls = 0,
    resolveRequest,
    indicators = {},
    committed,
    error;
  const revision = { current: 0 };
  const timers = new Map();
  let id = 0;
  const window = {
    setTimeout: (fn, delay) => {
      if (delay === 0) {
        fn();
        return 0;
      }
      timers.set(++id, fn);
      return id;
    },
    setInterval: (fn) => {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout: (key) => timers.delete(key),
    clearInterval: (key) => timers.delete(key),
  };
  const api = {
    getPhotoIndicators: (paths) => {
      calls++;
      assert(paths.length <= 1000, "IPC metadata payload is bounded");
      if (calls === 1 || calls === 14)
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      return Promise.resolve(
        Object.fromEntries(paths.map((p) => [p, metadata[p]])),
      );
    },
  };
  const m = { exports: {} };
  new Function(
    "electronAPI",
    "needsPhotoMetadata",
    "contentFiles",
    "metadataRevisionRef",
    "setSortIndicatorError",
    "publishPhotoIndicators",
    "setSortIndicators",
    "setSortIndicatorSnapshot",
    "window",
    "module",
    compile("module.exports=" + effect),
  )(
    api,
    true,
    files,
    revision,
    (e) => {
      error = e;
    },
    () => {},
    (update) => {
      indicators = typeof update === "function" ? update(indicators) : update;
    },
    (v) => {
      committed = v;
    },
    window,
    m,
  );
  const cleanup = m.exports();
  const [initial, poll] = [...timers.values()];
  initial();
  revision.current = 20;
  for (let i = 0; i < 20; i++) poll();
  assert.equal(
    calls,
    1,
    "only one IPC request in flight despite revision storms",
  );
  resolveRequest(
    Object.fromEntries(
      files.slice(0, 1000).map((f) => [f.path, metadata[f.path]]),
    ),
  );
  await new Promise(setImmediate);
  assert.equal(
    Object.keys(indicators).length,
    files.length,
    "in-flight snapshot commits rather than disappearing",
  );
  assert.equal(committed.revision, 0);
  const original = indicators;
  poll();
  assert.equal(calls, 14, "latest revision queues a second paged lookup");
  resolveRequest(
    Object.fromEntries(
      files.slice(0, 1000).map((f) => [f.path, metadata[f.path]]),
    ),
  );
  await new Promise(setImmediate);
  assert.equal(committed.revision, 20);
  assert.strictEqual(
    indicators,
    original,
    "unchanged data does not reorder the grid",
  );
  assert.equal(error, "");
  for (const field of ["people", "mapped"])
    for (const ascending of [true, false]) {
      const g = { exports: {} };
      new Function(
        "filteredAndSortedFiles",
        "displayLimit",
        "sort",
        "sortIndicators",
        "modifiedYear",
        "module",
        compile("module.exports=" + grouping),
      )(files, 500, { field, ascending }, indicators, (file) => file.year, g);
      const sections = g.exports();
      let otherGroupStarted = false;
      for (const key of sections.years)
        for (const file of sections.byYear.get(key)) {
          if (indicators[file.path][field] !== ascending)
            otherGroupStarted = true;
          else
            assert(
              !otherGroupStarted,
              "metadata groups must remain contiguous",
            );
        }
    }
  const f = { exports: {} };
  new Function(
    "module",
    "exports",
    compile(
      fs.readFileSync(
        path.join(__dirname, "../src/utils/metadataFilters.ts"),
        "utf8",
      ),
    ),
  )(f, f.exports);
  const match = f.exports.matchesMetadataFilters;
  assert(!match(undefined, "no", "all"), "unknown metadata is not no-people");
  assert(!match(undefined, "all", "no"), "unknown metadata is not unmapped");
  assert(match({ people: false, mapped: false }, "no", "no"));
  assert(!match({ people: true, mapped: false }, "no", "no"));
  assert(!match({ people: false, mapped: true }, "no", "no"));
  assert(match({ people: true, mapped: true }, "yes", "yes"));
  cleanup();
  assert.equal(timers.size, 0);
  console.log(
    "Metadata sorting tests passed: 12,001 photos, all four directions, one full lookup, queued invalidations, no cancellation starvation, unchanged-state retention, and combined unfinished-photo filters.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
