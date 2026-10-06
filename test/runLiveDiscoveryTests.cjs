const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { SemanticIndexer } = require("../electron-dist/semanticIndexer");
async function run() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "silo-live-discovery-"),
  );
  let indexer;
  try {
    const snapshots = [];
    let scanningObserved = false;
    indexer = new SemanticIndexer(
      directory,
      directory,
      async (source, onFile) => {
        for (let i = 0; i < 1200; i++) {
          onFile({
            name: `file${i}.mp3`,
            path: `${source}/file${i}.mp3`,
            relativePath: `file${i}.mp3`,
            size: 1,
            modified: 1,
            type: "audio",
            extension: ".mp3",
            isDirectory: false,
          });
        }
        const live = indexer.getReconciliationProgress();
        assert(
          live.running,
          "search enumeration appears as active discovery before scan completion",
        );
        assert(live.scanned >= 1200);
        assert(live.sourceIndex >= 1);
        scanningObserved = true;
        await new Promise(setImmediate);
      },
      (progress) => snapshots.push({ ...progress }),
    );
    await indexer.initialize();
    await indexer.start(["/source-a", "/source-b"]);
    assert(scanningObserved);
    const finished = indexer.getReconciliationProgress();
    assert.equal(finished.running, false);
    assert.equal(finished.scanned, 2400);
    assert.equal(finished.sourceCount, 2);
    assert.equal(finished.sourceIndex, 2);
    assert(
      snapshots.some(
        (p) =>
          p.status === "scanning" && p.message.includes("entries inspected"),
      ),
      "non-indexable entries also generate live scan updates",
    );
    assert.equal(indexer.getProgress().status, "complete");
    console.log(
      "Live discovery tests passed: full search scans are visible, per-source and entry counters update before completion, and non-indexable entries remain observable.",
    );
  } finally {
    indexer?.stopWatching();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
