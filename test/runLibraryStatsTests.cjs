const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = require("node:fs").readFileSync(filename, "utf8");
  module._compile(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const { LibraryStatsManager } = require("../src/libraryStats.ts");

async function run() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "silo-library-stats-"));
  const userData = path.join(temporaryRoot, "user-data");
  const library = path.join(temporaryRoot, "library");
  const documents = path.join(library, "Documents");
  await fs.mkdir(documents, { recursive: true });
  const roots = {
    library: { id: library, label: "Library", kind: "local", rootPath: library, available: true },
    documents: { id: documents, label: "Documents", kind: "local", rootPath: documents, available: true },
    phone: { id: "/__phone__/ios/phone", label: "Phone snapshot", kind: "ios", rootPath: "/__phone__/ios/phone", available: true },
  };
  let phoneFileName = "camera.jpg";
  const scanned = [];
  const scanSource = async (rootPath, onFile) => {
    scanned.push(rootPath);
    const files = rootPath === library
      ? [
          { path: `${library}/photo.jpg`, relativePath: "photo.jpg", size: 100, modified: 10, type: "image", isDirectory: false },
          { path: `${library}/Documents/report.pdf`, relativePath: "Documents/report.pdf", size: 200, modified: 20, type: "document", isDirectory: false },
        ]
      : rootPath === documents
        ? [{ path: `${documents}/report.pdf`, relativePath: "report.pdf", size: 200, modified: 20, type: "document", isDirectory: false }]
        : [{ path: `${rootPath}/Media/${phoneFileName}`, relativePath: `Media/${phoneFileName}`, size: phoneFileName === "camera.jpg" ? 300 : undefined, modified: 30, type: "image", isDirectory: false }];
    onFile({ path: `${rootPath}/folder`, relativePath: "folder", size: 0, modified: 1, type: "folder", isDirectory: true });
    for (const file of files) onFile(file);
  };
  try {
    const manager = new LibraryStatsManager(userData, scanSource);
    await manager.initialize();
    manager.requestRefresh(Object.values(roots));
    await manager.waitForIdle();
    let snapshot = manager.getSnapshot();
    assert.equal(snapshot.totals.fileCount, 3, "overlapping local roots count once globally; remote source adds one unique file");
    assert.equal(snapshot.totals.totalBytes, 600);
    assert.equal(snapshot.totals.unknownSizeFiles, 0);
    assert.equal(snapshot.totals.categories.image.files, 2);
    assert.equal(snapshot.totals.categories.document.bytes, 200);
    assert.equal(snapshot.totals.uniqueSourceCount, 2);
    const documentStats = snapshot.sources.find((source) => source.id === documents);
    assert.ok(documentStats, `document root missing from source rows: ${JSON.stringify(snapshot.sources)}`);
    assert.equal(documentStats.fileCount, 1, "source rows keep their own inventory totals");
    assert.equal(documentStats.overlapsAnotherSource, true);
    assert.equal(snapshot.running, false);
    const restored = new LibraryStatsManager(userData, scanSource);
    await restored.initialize();
    const restoredSnapshot = restored.getSnapshot(Object.values(roots).map((source) => ({ ...source, available: false })));
    assert.equal(restoredSnapshot.totals.totalBytes, 600, "inventory summaries survive restart");
    assert.equal(restoredSnapshot.sources[0].status, "offline");

    const beforeOffline = snapshot.totals.totalBytes;
    manager.requestRefresh(Object.values(roots).map((source) => ({ ...source, available: false })));
    await manager.waitForIdle();
    snapshot = manager.getSnapshot();
    assert.equal(snapshot.totals.totalBytes, beforeOffline, "offline sources retain last-known inventory totals");
    assert.equal(snapshot.totals.staleSourceCount, 3);
    assert(snapshot.sources.every((source) => source.status === "offline"));

    const changedRoots = Object.values(roots).map((source) => ({ ...source, available: source.id === roots.phone.id }));
    phoneFileName = "new-camera.jpg";
    manager.requestRefresh(changedRoots);
    await manager.waitForIdle();
    snapshot = manager.getSnapshot();
    assert.equal(snapshot.sources.find((source) => source.id === roots.phone.id).fileCount, 1);
    assert.equal(snapshot.sources.find((source) => source.id === roots.phone.id).unknownSizeFiles, 1);
    assert.equal(snapshot.totals.unknownSizeFiles, 1);
    assert.equal(snapshot.sources.find((source) => source.id === roots.library.id).status, "offline");
    assert.equal(new Set(scanned).size, 3);
    console.log("Library stats tests passed: categories, logical sizes, overlapping-root deduplication, per-source counts, persistence, and offline last-known totals.");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
