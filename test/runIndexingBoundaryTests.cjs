const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText, filename);
};

const { isAppDataPath, isPathWithin, isNonLibraryPath } = require("../src/indexingPathPolicy.ts");
const { isSiloCloneDirectory, invalidateSiloCloneDirectoryCache } = require("../src/indexingPathPolicy.ts");
const { AudioLibraryCache } = require("../src/audioLibraryCache.ts");

async function makeMainScanner(userDataPath) {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  let declaration;
  let readFilesDeclaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "createUnifiedScanSource")
      declaration = node.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "readFiles")
      readFilesDeclaration = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, "production unified scanner was found");
  const compiled = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const phoneCalls = [];
  let scannerYields = 0;
  const context = vm.createContext({
    app: { getPath: () => userDataPath },
    fsPromises: fsp,
    path,
    isAppDataPath,
    isNonLibraryPath,
    isSiloCloneDirectory,
    setImmediate: (callback) => {
      scannerYields += 1;
      return setImmediate(callback);
    },
    isTimeMachineDirectory: async () => false,
    shouldSkipTimeMachineEntry: () => false,
    isPermissionError: () => false,
    parseTimeMachineFile: () => null,
    mime: { getType: () => null },
    classifyFile: (name) => name.toLowerCase().endsWith(".jpg") ? "image" : "document",
    phoneManager: {
      isPhonePath: (candidate) =>
        candidate.startsWith("/__phone__/") ||
        candidate.startsWith("/__phone_backup__/"),
      listPhoneFilesRecursively: async (root, onFile) => {
        phoneCalls.push(root);
        onFile({ path: `${root}/Documents/photo.jpg`, name: "photo.jpg", isDirectory: false });
      },
    },
    googleManager: {},
  });
  const create = vm.runInContext(`(${compiled})`, context);
  const readFilesCompiled = ts.transpileModule(readFilesDeclaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const readFiles = vm.runInContext(`(${readFilesCompiled})`, context);
  return { scan: await create(), phoneCalls, readFiles, getScannerYields: () => scannerYields };
}

async function run() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-index-boundary-"));
  const root = path.join(temporaryRoot, "drive");
  const userData = path.join(root, "silo-data");
  try {
    await fsp.mkdir(path.join(root, "Photos"), { recursive: true });
    await fsp.mkdir(path.join(root, "silo-data", "semantic-index"), { recursive: true });
    await fsp.mkdir(path.join(root, "silo-data", "phone-cache", "ios"), { recursive: true });
    await fsp.mkdir(path.join(root, "silo-data-sibling"), { recursive: true });
    const cloneRoot = path.join(root, "Silo Source Clone test");
    await fsp.mkdir(cloneRoot, { recursive: true });
    await fsp.writeFile(path.join(cloneRoot, ".silo-clone-in-progress.json"), JSON.stringify({ format: "silo-source-clone", version: 1 }));
    await fsp.writeFile(path.join(cloneRoot, "backup-photo.jpg"), "backup copy");
    const newlyCreatedClone = path.join(root, "Silo Source Clone starting now");
    await fsp.mkdir(newlyCreatedClone, { recursive: true });
    assert.equal(await isSiloCloneDirectory(newlyCreatedClone), false);
    await fsp.writeFile(path.join(newlyCreatedClone, ".silo-clone-in-progress.json"), JSON.stringify({ format: "silo-source-clone", version: 1 }));
    invalidateSiloCloneDirectoryCache(newlyCreatedClone);
    assert.equal(await isSiloCloneDirectory(newlyCreatedClone), true, "active clone markers invalidate a stale negative check");
    await fsp.writeFile(path.join(root, "Photos", "original.jpg"), "original");
    await fsp.writeFile(path.join(userData, "semantic-index", "records.jsonl"), "derived");
    await fsp.writeFile(path.join(userData, "phone-cache", "ios", "backup.jpg"), "cached source copy");
    const restoreTree = path.join(root, ".silo-phone-restores", "ios", "device", "archive", "backup");
    await fsp.mkdir(restoreTree, { recursive: true });
    await fsp.writeFile(path.join(restoreTree, "large-backup-file"), "restore payload");
    await fsp.writeFile(path.join(root, "silo-data-sibling", "keep.jpg"), "user file");

    assert.equal(isPathWithin(path.join(userData, "semantic-index"), userData), true);
    assert.equal(isPathWithin(`${userData}-sibling`, userData), false, "prefix siblings are not descendants");
    const canonicalRoot = await fsp.realpath(root);
    assert.equal(isAppDataPath(userData, root, canonicalRoot, userData, await fsp.realpath(userData)), true);

    const { scan, phoneCalls, readFiles, getScannerYields } = await makeMainScanner(userData);
    const bulkDirectory = path.join(root, "Bulk");
    await fsp.mkdir(bulkDirectory, { recursive: true });
    await Promise.all(Array.from({ length: 270 }, (_, index) =>
      fsp.writeFile(path.join(bulkDirectory, `file-${index}.txt`), "data"),
    ));
    const discovered = [];
    await fsp.mkdir(path.join(root, "Downloads", "Tool.app", "Contents"), { recursive: true });
    await fsp.writeFile(path.join(root, "Downloads", "Tool.app", "Contents", "icon.jpg"), "bundle art");
    await fsp.mkdir(path.join(root, "Code", "node_modules", "pkg"), { recursive: true });
    await fsp.writeFile(path.join(root, "Code", "node_modules", "pkg", "index.js"), "code");
    await scan(root, (file) => discovered.push(file), () => false);
    assert(!discovered.some((file) => /node_modules|Tool\.app/.test(file.path)), "software trees are never scanned for indexing");
    assert(!discovered.some((file) => file.path.includes(".silo-phone-restores")), "encrypted restore archives are pruned from source scans");
    assert(getScannerYields() >= 1, "large directories yield so Electron IPC can continue responding");
    const discoveredPaths = discovered.map((file) => file.path);
    assert(discoveredPaths.includes(path.join(root, "Photos", "original.jpg")));
    assert(discoveredPaths.includes(path.join(root, "silo-data-sibling", "keep.jpg")));
    assert(!discoveredPaths.some((candidate) => candidate.startsWith(`${userData}${path.sep}`)), "unified scans prune all app-owned data");
    assert(!discoveredPaths.some((candidate) => candidate.startsWith(`${cloneRoot}${path.sep}`)), "in-progress shelter copy content is not indexed");
    assert(!discoveredPaths.includes(userData), "the protected app-data root itself is not emitted");
    const browsedFiles = await readFiles(root, true);
    assert(!browsedFiles.some((file) => file.path.startsWith(`${userData}${path.sep}`)), "all recursive inventory consumers skip app data");
    const appDataRootEntries = [];
    await scan(userData, (file) => appDataRootEntries.push(file.path), () => false);
    assert.deepEqual(appDataRootEntries, [], "a source rooted inside app data is completely excluded");

    const aliasedRoot = path.join(temporaryRoot, "drive-alias");
    try {
      await fsp.symlink(root, aliasedRoot, "dir");
      const aliasEntries = [];
      await scan(aliasedRoot, (file) => aliasEntries.push(file.path), () => false);
      assert(!aliasEntries.some((candidate) => candidate.includes(`${path.sep}silo-data${path.sep}`)), "a symlinked broad root cannot expose internal data");
    } catch (error) {
      if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
    }

    const virtualPaths = [];
    await scan("/__phone__/ios/offline", (file) => virtualPaths.push(file.path), () => false);
    await scan("/__phone_backup__/ios/offline", (file) => virtualPaths.push(file.path), () => false);
    assert.deepEqual(phoneCalls, ["/__phone__/ios/offline", "/__phone_backup__/ios/offline"]);
    assert.deepEqual(virtualPaths, [
      "/__phone__/ios/offline/Documents/photo.jpg",
      "/__phone_backup__/ios/offline/Documents/photo.jpg",
    ], "live phone and saved-copy media remain separately indexable");

    const audioCache = new AudioLibraryCache(userData);
    await audioCache.initialize();
    await fsp.mkdir(path.join(root, "Music"), { recursive: true });
    await fsp.writeFile(path.join(root, "Music", "song.mp3"), "audio");
    await fsp.writeFile(path.join(cloneRoot, "backup-track.mp3"), "clone audio");
    await fsp.writeFile(path.join(userData, "phone-cache", "internal.mp3"), "cache audio");
    const audioSnapshot = await audioCache.scan(
      [{ id: "drive", rootPath: root, kind: "local", label: "Drive" }],
      () => false,
      (name) => name.endsWith(".mp3"),
      async () => [],
      () => undefined,
      true,
    );
    assert.deepEqual(audioSnapshot.files.map((file) => file.path), [path.join(root, "Music", "song.mp3")], "audio inventory prunes the same internal subtree");

    const originalWatch = fs.watch;
    const watchCallbacks = [];
    fs.watch = (_root, _options, callback) => {
      watchCallbacks.push(callback);
      return { on() { return this; }, close() {} };
    };
    try {
      delete require.cache[require.resolve("../src/semanticIndexer.ts")];
      const { SemanticIndexer } = require("../src/semanticIndexer.ts");
      const indexer = new SemanticIndexer(userData, "", async () => {}, () => {});
      let reconciliations = 0;
      indexer.scheduleReconciliation = () => { reconciliations += 1; };
      await indexer.startWatching([root, userData]);
      assert.equal(watchCallbacks.length, 1, "the app-data source root itself is never watched");
      watchCallbacks[0]("change", path.join("silo-data", "phone-cache", "internal.mp3"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(reconciliations, 0, "writes inside app data do not trigger reconciliation");
      watchCallbacks[0]("change", path.join("Silo Source Clone test", "backup-photo.jpg"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(reconciliations, 0, "writes inside an in-progress shelter copy do not trigger reconciliation");
      watchCallbacks[0]("change", path.join(".silo-phone-restores", "ios", "device", "archive", "backup", "large-backup-file"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(reconciliations, 0, "restore archive writes do not trigger indexing reconciliation");
      watchCallbacks[0]("change", path.join("Music", "song.mp3"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(reconciliations, 1, "ordinary source changes still trigger reconciliation");
      indexer.stopWatching();
    } finally {
      fs.watch = originalWatch;
    }

    console.log("Indexing boundary tests passed: protected app data, broad roots, sibling paths, virtual phone snapshots, audio scans, and watch events.");
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
