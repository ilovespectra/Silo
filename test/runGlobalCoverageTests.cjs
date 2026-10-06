const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: filename,
  }).outputText, filename);
};

// Load current source in memory; no compiled artifacts, model, or worker required.
const filename = path.join(__dirname, "../src/semanticIndexer.ts");
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText,
  filename,
);
const { SemanticIndexer } = loaded.exports;

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "silo-global-coverage-"));
  try {
    const locals = Array.from({ length: 11 }, (_, i) =>
      path.join(temp, `local-${i}`),
    );
    locals.forEach((root) => fs.mkdirSync(root));
    const remotes = Array.from(
      { length: 4 },
      (_, i) => `/__cloud__/google-${i}`,
    );
    const all = [...locals, ...remotes];
    const failures = new Set();
    let pauseRoot = "";
    let heldRoot = "";
    let entered;
    let release;
    let indexer;
    const scan = async (root, onFile) => {
      if (root === heldRoot) {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      if (failures.has(root)) throw new Error(`Scan failed: ${root}`);
      // A discovered directory counts as inspected, but never needs inference.
      onFile({
        path: `${root}/folder`,
        name: "folder",
        relativePath: "folder",
        size: 0,
        modified: 0,
        isDirectory: true,
        type: "directory",
        extension: "",
      });
      if (root === pauseRoot) indexer.pauseRequested = true;
    };
    const makeIndexer = () => {
      const instance = new SemanticIndexer(temp, temp, scan, () => {});
      instance.loadClipRuntime = async () => {
        throw new Error("Inference must not run");
      };
      return instance;
    };
    indexer = makeIndexer();
    await indexer.initialize();
    const counts = (roots) => {
      const { sources, ...values } = indexer.getSourceCoverageProgress(roots);
      assert.equal(sources.length, values.total);
      assert.equal(
        values.completed +
          values.scanning +
          values.pending +
          values.errors +
          values.unavailable,
        values.total,
      );
      return values;
    };
    assert.deepEqual(counts([...all, all[0]]), {
      total: 15,
      completed: 0,
      scanning: 0,
      errors: 0,
      unavailable: 0,
      pending: 15,
    });
    await indexer.reconcileIndex(all);
    assert.deepEqual(counts(all), {
      total: 15,
      completed: 11,
      scanning: 0,
      errors: 0,
      unavailable: 0,
      pending: 4,
    });
    assert(
      indexer
        .getSourceCoverageProgress(all)
        .sources.slice(11)
        .every((s) => s.status === "pending"),
    );
    await indexer.run(remotes);
    assert.deepEqual(counts(all), {
      total: 15,
      completed: 15,
      scanning: 0,
      errors: 0,
      unavailable: 0,
      pending: 0,
    });
    assert.equal(indexer.getReconciliationProgress().sourceCount, 4);
    assert.equal(indexer.getReconciliationProgress().sourceIndex, 4);
    assert.equal(indexer.getReconciliationProgress().sourcePath, remotes[3]);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(temp, "semantic-index/coverage.json"), "utf8"),
    );
    assert.equal(persisted.sources.length, 15);
    assert(
      persisted.sources.every(
        ([, value]) => value.status === "completed" && value.completedAt > 0,
      ),
    );
    indexer = makeIndexer();
    await indexer.initialize();
    const added = "/__phone__/new-device";
    assert.equal(counts([...all, added]).completed, 15);
    assert.equal(
      counts([...all, added]).pending,
      1,
      "persisted coverage must not complete a new root",
    );

    failures.add(locals[0]);
    await indexer.reconcileIndex([locals[0], locals[1]]);
    assert.equal(counts(all).errors, 1);
    assert.equal(counts(all).completed, 14);
    failures.add(remotes[0]);
    await indexer.run([remotes[0], remotes[1]]);
    assert.equal(counts(all).errors, 2);
    assert.equal(
      indexer
        .getSourceCoverageProgress(all)
        .sources.find((s) => s.sourcePath === remotes[0]).status,
      "error",
    );
    failures.clear();
    await indexer.reconcileIndex([locals[0]]);
    await indexer.run([remotes[0]]);
    assert.equal(counts(all).completed, 15);
    const missing = path.join(temp, "offline");
    await indexer.reconcileIndex([missing]);
    assert.equal(counts([...all, missing]).unavailable, 1);
    await indexer.run([missing]);
    assert.equal(counts([...all, missing]).unavailable, 1);
    assert.equal(
      counts(all).total,
      15,
      "requested snapshot excludes other retained roots",
    );

    pauseRoot = added;
    await indexer.run([added]);
    assert.equal(
      counts([added]).pending,
      1,
      "cancelled discovery is not successful coverage",
    );
    pauseRoot = "";
    indexer.pauseRequested = false;
    heldRoot = locals[2];
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const reconcile = indexer.reconcileIndex([heldRoot]);
    await reached;
    assert.equal(counts(all).scanning, 1);
    assert.equal(indexer.getReconciliationProgress().sourcePath, heldRoot);
    await indexer.run([remotes[2]]);
    assert.equal(
      indexer.getReconciliationProgress().sourcePath,
      heldRoot,
      "finished search must not overwrite an active reconciliation sourcePath",
    );
    const restarted = makeIndexer();
    await restarted.initialize();
    assert.equal(
      restarted.getSourceCoverageProgress([heldRoot]).pending,
      1,
      "persisted interrupted scan cannot be restored as completed",
    );
    release();
    await reconcile;
    assert.equal(counts(all).completed, 15);
    assert.equal(indexer.getSourceCoverageProgress([added]).pending, 1);
    console.log(
      "Global coverage tests passed: cumulative 11 local + 4 Google roots, persistence/new roots, deduplication, errors, unavailable, cancellation, and independent discovery paths.",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  await runGlobalIndexSummary();
}

async function runGlobalIndexSummary() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "silo-global-index-summary-"));
  try {
    const roots = [path.join(temp, "photos"), path.join(temp, "documents")];
    roots.forEach((root) => fs.mkdirSync(root));
    const files = roots.map((root, sourceIndex) =>
      Array.from({ length: sourceIndex === 0 ? 3 : 2 }, (_, index) => ({
        path: path.join(root, `${index}.jpg`),
        name: `${index}.jpg`,
        relativePath: `${index}.jpg`,
        size: 100 + index,
        modified: 1000 + index,
        isDirectory: false,
        type: "image",
        extension: ".jpg",
      })),
    );
    const scan = async (root, onFile) => {
      const index = roots.indexOf(root);
      for (const file of files[index]) onFile(file);
    };
    const makeIndexer = () => new SemanticIndexer(temp, temp, scan, () => {});
    let indexer = makeIndexer();
    await indexer.initialize();
    await indexer.appendRecord(files[0][0], roots[0], new Float32Array(512));
    await indexer.reconcileIndex(roots);
    assert.deepEqual(indexer.getIndexSummary(), {
      indexed: 1,
      errors: 0,
      total: 5,
      discoveredTotal: 5,
      remaining: 4,
    });

    indexer = makeIndexer();
    await indexer.initialize();
    assert.deepEqual(indexer.getIndexSummary(), {
      indexed: 1,
      errors: 0,
      total: 5,
      discoveredTotal: 5,
      remaining: 4,
    }, "restart includes persisted recursive totals and all indexed records");
    console.log("Global index summary tests passed: recursive roots, persisted records, and restart totals.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
