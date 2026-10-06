const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const text = fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8");
const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
let handler;
function walk(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "ipcMain.handle" &&
    node.arguments[0]?.getText(ast) === '"get-indexing-overview"'
  )
    handler = node.arguments[1].getText(ast);
  ts.forEachChild(node, walk);
}
walk(ast);
const code = ts.transpileModule("module.exports=" + handler, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const m = { exports: null };
const stats = (status, processed, total) => ({
  status,
  processed,
  total,
  errors: 0,
  message: status,
});
let discovery = {
  running: true,
  sourceIndex: 2,
  sourceCount: 6,
  scanned: 12500,
  changed: 900,
  startedAt: Date.now(),
  sourcePath: "/phone",
  message: "Checking source 2 of 6",
  error: "",
};
let coverage = {
  total: 2,
  completed: 1,
  scanning: 1,
  pending: 0,
  errors: 0,
  unavailable: 0,
};
let sources = [
  {
    kind: "local",
    rootPath: "/pictures",
    label: "Pictures",
    enabled: false,
    available: true,
  },
  {
    kind: "android",
    rootPath: "/phone",
    label: "Saga",
    enabled: false,
    available: true,
  },
  { kind: "gdrive", rootPath: "/drive", label: "Drive", available: false },
];
const eligibleRoots = async () => [
  ...new Set(
    sources
      .filter((s) => (s.kind === "local" || s.available) && s.rootPath.trim())
      .map((s) => s.rootPath),
  ),
];
const semantic = {
  getProgress: () => ({ ...stats("indexing", 0, 100), indexed: 40, errors: 2 }),
  getIndexSummary: () => ({ indexed: 12040, errors: 7, total: 284651, remaining: 272604 }),
  getReconciliationProgress: () => discovery,
  getSourceCoverageProgress: (roots) => {
    assert.deepEqual(roots, [
      ...new Set(
        sources
          .filter((s) => s.kind === "local" || s.available)
          .map((s) => s.rootPath),
      ),
    ]);
    return coverage;
  },
};
new Function(
  "semanticIndexer",
  "faceIndexer",
  "geoIndexer",
  "duplicateManager",
  "petIndexer",
  "thumbnailPregenerator",
  "audioLibraryCache",
  "audioInventoryRunning",
  "audioInventoryProgress",
  "magicLibraryProgress",
  "indexRecovery",
  "listSources",
  "getIndexableRootsFromSources",
  "getAllIndexSources",
  "module",
  code,
)(
  semantic,
  { getProgress: () => ({ ...stats("paused", 10, 80), faces: 3, people: 2 }) },
  {
    getStatus: () => ({
      ...stats("complete", 0, 20),
      scanned: 20,
      geotagged: 8,
    }),
  },
  {
    getState: () => ({ ...stats("idle", 0, 0), scanned: 0, duplicateFiles: 0 }),
  },
  { getProgress: () => stats("idle", 0, 0) },
  {
    getProgress: () => ({
      ...stats("waiting", 0, 0),
      failed: 0,
      message: "Waiting for search indexing to finish",
    }),
  },
  {
    getSnapshot: () => ({
      sourceIds: ["a", "b"],
      sourceScannedAt: { a: 1 },
      failedSources: ["b"],
      files: [{}, {}],
    }),
  },
  false,
  null,
  { analyzed: 5, total: 10, running: true },
  null,
  async () => sources,
  async (items) => items
    .filter((source) => source.available && source.rootPath.trim())
    .map((source) => source.rootPath),
  eligibleRoots,
  m,
);
async function run() {
  const overview = await m.exports();
  assert.equal(overview.length, 9);
  assert.equal(new Set(overview.map((s) => s.id)).size, 9);
  assert.equal(overview.find((s) => s.id === "discovery").status, "scanning");
  assert.equal(overview.find((s) => s.id === "discovery").processed, 1);
  assert.equal(overview.find((s) => s.id === "discovery").total, 2);
  assert(overview.find((s) => s.id === "discovery").detail.includes("12,500"));
  assert(
    overview
      .find((s) => s.id === "discovery")
      .detail.includes("3 registered sources"),
  );
  assert(
    overview
      .find((s) => s.id === "discovery")
      .detail.includes("2 eligible for indexing"),
  );
  assert(overview.find((s) => s.id === "discovery").message.includes("Saga"));
  const search = overview.find((s) => s.id === "search");
  assert.equal(search.processed, 12040, "Search progress counts all persisted indexed records");
  assert.equal(search.total, 284651, "Search denominator is the recursive all-source total, not the current batch");
  assert.equal(search.errors, 7, "Global indexed errors are included");
  assert.equal(search.unit, "files");
  assert(search.detail.includes("recursive totals across saved and current source indexes"));
  assert.equal(overview.find((s) => s.id === "faces").status, "paused");
  assert.equal(overview.find((s) => s.id === "locations").status, "complete");
  assert.equal(overview.find((s) => s.id === "audio").status, "waiting");
  assert.equal(overview.find((s) => s.id === "audio").processed, 1);
  assert.equal(overview.find((s) => s.id === "thumbnails").status, "waiting");
  for (const stage of overview) {
    assert(Number.isFinite(stage.processed));
    assert(Number.isFinite(stage.total));
    assert(
      !("files" in stage) && !("photos" in stage) && !("groups" in stage),
      "progress API must not transfer file inventories",
    );
  }
  sources = Array.from({ length: 15 }, (_, i) => ({
    kind: i < 11 ? "local" : "gdrive",
    rootPath: `/root-${i}`,
    label: `Root ${i}`,
    available: true,
    enabled: false,
  }));
  sources.push({ ...sources[0] }); // A duplicate registration is not a sixteenth root.
  discovery = {
    ...discovery,
    running: false,
    sourceIndex: 4,
    sourceCount: 4,
    sourcePath: "/root-14",
    message: "Latest Google batch complete",
  };
  coverage = {
    total: 15,
    completed: 15,
    scanning: 0,
    pending: 0,
    errors: 0,
    unavailable: 0,
  };
  let row = (await m.exports()).find((s) => s.id === "discovery");
  assert.equal(row.processed, 15);
  assert.equal(row.total, 15);
  assert.equal(row.status, "complete");
  assert(row.detail.includes("15 registered sources"));
  assert(row.detail.includes("batch: source 4 of 4 · Root 14"));
  coverage = {
    ...coverage,
    completed: 4,
    pending: 9,
    errors: 1,
    unavailable: 1,
  };
  row = (await m.exports()).find((s) => s.id === "discovery");
  assert.equal(row.processed, 4);
  assert.equal(row.total, 15);
  assert.equal(row.status, "error");
  assert.equal(row.errors, 1);
  assert(
    row.detail.includes("9 pending") && row.detail.includes("1 unavailable"),
  );
  coverage = { ...coverage, errors: 0, pending: 10 };
  assert.equal(
    (await m.exports()).find((s) => s.id === "discovery").status,
    "waiting",
  );
  sources[14].available = false;
  coverage = {
    total: 14,
    completed: 14,
    scanning: 0,
    pending: 0,
    errors: 0,
    unavailable: 0,
  };
  row = (await m.exports()).find((s) => s.id === "discovery");
  assert.equal(row.total, 14);
  assert.equal(row.status, "waiting");
  assert(row.detail.includes("15 registered sources"));
  assert(row.detail.includes("1 disconnected / unauthorized sources excluded"));
  delete semantic.getSourceCoverageProgress;
  row = (await m.exports()).find((s) => s.id === "discovery");
  assert.equal(
    row.processed,
    0,
    "fallback must not assume latest batch covered all sources",
  );
  assert.equal(row.total, 14);
  assert.equal(row.status, "waiting");
  console.log(
    "Indexing overview tests passed: global 15-root coverage, separate Google batch, pending/errors/unavailable, disconnected exclusions, fallback, and count-only payloads.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
