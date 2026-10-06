const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const vm = require("node:vm");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const { InventoryFingerprint } = require("../src/inventoryFingerprint.ts");
const { isAppDataPath, isSiloCloneDirectory, invalidateSiloCloneDirectoryCache } = require("../src/indexingPathPolicy.ts");
const { CLONE_ARCHIVE_EXTENSION, writeCloneArchive, extractCloneArchive } = require("../src/cloneArchive.ts");

const sourcePath = path.join(__dirname, "../src/main.ts");
const sourceText = fs.readFileSync(sourcePath, "utf8");
const ast = ts.createSourceFile("main.ts", sourceText, ts.ScriptTarget.Latest, true);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(ast);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "silo-source-clone-test-"));
const sourceRoot = path.join(root, "source");
const userData = path.join(sourceRoot, ".silo-user-data");
const secondSourceRoot = path.join(root, "camera");
const destinations = [path.join(root, "backup-a"), path.join(root, "backup-b")];
const partialDestinations = [path.join(root, "backup-c"), path.join(root, "backup-later-disconnects")];
const replicaDestination = path.join(root, "replica-volume");
fs.mkdirSync(path.join(sourceRoot, "nested"), { recursive: true });
fs.mkdirSync(secondSourceRoot, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
const previousCloneRoot = path.join(sourceRoot, "Silo Source Clone previous");
fs.mkdirSync(previousCloneRoot, { recursive: true });
fs.writeFileSync(path.join(previousCloneRoot, "silo-clone-manifest.json"), JSON.stringify({ format: "silo-source-clone", version: 1, complete: true }));
fs.writeFileSync(path.join(previousCloneRoot, "old-copy.jpg"), "previous backup payload");
for (const destination of [...destinations, ...partialDestinations, replicaDestination]) fs.mkdirSync(destination);
fs.writeFileSync(path.join(sourceRoot, "first.txt"), "first payload");
fs.writeFileSync(path.join(sourceRoot, "nested", "second.txt"), "second payload");
fs.writeFileSync(path.join(secondSourceRoot, "same-first.txt"), "first payload");
fs.writeFileSync(path.join(secondSourceRoot, "third.txt"), "third payload");

const progress = [];
let failHardLinks = false;
let sameVolumeDestinationPath = "";
const fsPromises = new Proxy(fsp, {
  get(target, property) {
    if (property === "link") return async (...args) => {
      if (failHardLinks) {
        const error = new Error("Hard links unsupported by target filesystem");
        error.code = "ENOTSUP";
        throw error;
      }
      return target.link(...args);
    };
    if (property === "stat") return async (filePath, ...args) => {
      const stats = await target.stat(filePath, ...args);
      const canonicalFilePath = fs.realpathSync(path.resolve(String(filePath)));
      const canonicalReplicaRoot = fs.realpathSync(replicaDestination);
      const canonicalPrimaryRoot = fs.realpathSync(destinations[0]);
      if (canonicalFilePath === canonicalReplicaRoot) {
        return new Proxy(stats, { get(value, key) { return key === "dev" ? Number(value.dev) + 2 : Reflect.get(value, key, value); } });
      }
      if (sameVolumeDestinationPath && canonicalFilePath === fs.realpathSync(sameVolumeDestinationPath))
        return new Proxy(stats, { get(value, key) { return key === "dev" ? Number(value.dev) + 1 : Reflect.get(value, key, value); } });
      if (canonicalFilePath.startsWith(`${canonicalPrimaryRoot}${path.sep}`)) {
        return new Proxy(stats, { get(value, key) { return key === "dev" ? Number(value.dev) + 1 : Reflect.get(value, key, value); } });
      }
      return stats;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const context = vm.createContext({
  console, path, os, fs, fsPromises, Buffer, Date, Math, Number, String, Array, Set, Map, Object, Error, Promise,
  Transform, pipeline, createHash: crypto.createHash,
  InventoryFingerprint,
  CLONE_ARCHIVE_EXTENSION,
  writeCloneArchive,
  isAppDataPath,
  isSiloCloneDirectory,
  invalidateSiloCloneDirectoryCache,
  app: { getPath: (name) => { assert.equal(name, "userData"); return userData; }, getVersion: () => "test-version" },
  exportConfig: async (_userData, target) => { await fsp.writeFile(target, "test silo config and indexes"); return { size: 28 }; },
  listSources: async () => [
    { id: sourceRoot, rootPath: sourceRoot, label: "Photos", kind: "local", enabled: true, available: true },
    { id: secondSourceRoot, rootPath: secondSourceRoot, label: "Camera", kind: "local", enabled: true, available: true },
    { id: "/disconnected", rootPath: "/disconnected", label: "Offline", kind: "local", enabled: true, available: false },
  ],
  indexStorageRoot: userData,
  sourceCloneStatusPath: path.join(userData, "source-clone-status.json"),
  sourceCloneStatusCache: null,
  sourceCloneStatusWrite: Promise.resolve(),
  getShelterDestination: async () => destinations[0],
  sourceCloneOperations: new Map(),
  sourceClonePlans: new Map(),
  sendToRenderer: (channel, value) => { if (channel === "source-clone-progress") progress.push(value); },
});
for (const name of ["cloneSafeSegment", "cloneSafeRelativePath", "sendSourceCloneProgress", "ensureCloneActive", "hashFile", "listLocalCloneEntries", "getSourceCloneStatus", "persistSourceCloneStatus", "prepareSourceClone", "findLatestShelterSnapshot", "prepareShelterReplica", "runSourceClone"]) {
  assert(functions.has(name), `Missing source clone function ${name}`);
  const compiled = ts.transpileModule(functions.get(name).getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  try {
    vm.runInContext(compiled, context);
  } catch (error) {
    console.error("Could not load clone helper", name, compiled);
    throw error;
  }
}

async function run() {
  try {
    await assert.rejects(
      context.prepareSourceClone(["/disconnected"], destinations, "clone-offline"),
      /no longer available/,
    );
    context.sourceCloneOperations.delete("clone-offline");
    const operationId = "clone-test-operation";
    const preflight = await context.prepareSourceClone([sourceRoot, secondSourceRoot], destinations, operationId);
    assert.equal(preflight.totalSources, 2);
    assert.equal(preflight.destinations.length, 2, "One selection targets both destinations");
    assert.equal(preflight.totalFiles, 4, "Three unique source files plus one unique config bundle");
    assert.equal(preflight.duplicateFiles, 2, "Repeated photo and per-source config are aliases, not extra data copies");
    assert(preflight.destinations.every((destination) => destination.shortfallBytes === 0));
    assert.equal(context.sourceClonePlans.get(preflight.planId).entries.filter((entry) => entry.destinationRelativePath.endsWith("silo-config.tar.gz")).length, 2);
    await context.runSourceClone(preflight.planId);

    for (const destination of preflight.destinations) {
      const cloneRoot = destination.cloneRoot;
      assert.equal(await fsp.readFile(path.join(cloneRoot, "01-Photos", "first.txt"), "utf8"), "first payload");
      assert.equal(await fsp.readFile(path.join(cloneRoot, "01-Photos", "nested", "second.txt"), "utf8"), "second payload");
      assert.equal(await fsp.readFile(path.join(cloneRoot, "02-Camera", "third.txt"), "utf8"), "third payload");
      assert.equal(await fsp.readFile(path.join(cloneRoot, "01-Photos", "silo-config.tar.gz"), "utf8"), "test silo config and indexes");
      assert.equal(await fsp.access(path.join(cloneRoot, "01-Photos", ".silo-user-data")).then(() => true, () => false), false, "private app data is excluded from local source copies");
      assert.equal(await fsp.access(path.join(cloneRoot, "01-Photos", "Silo Source Clone previous")).then(() => true, () => false), false, "nested shelter clones are excluded from clone preflight");
      const canonicalPhoto = await fsp.stat(path.join(cloneRoot, "01-Photos", "first.txt"));
      const duplicatePhoto = await fsp.stat(path.join(cloneRoot, "02-Camera", "same-first.txt"));
      assert.equal(duplicatePhoto.ino, canonicalPhoto.ino, "duplicate source path is materialized as a hard link when supported");
      const firstConfig = await fsp.stat(path.join(cloneRoot, "01-Photos", "silo-config.tar.gz"));
      const secondConfig = await fsp.stat(path.join(cloneRoot, "02-Camera", "silo-config.tar.gz"));
      assert.equal(secondConfig.ino, firstConfig.ino, "per-source config paths share one physical archive");
      const manifest = JSON.parse(await fsp.readFile(path.join(cloneRoot, "silo-clone-manifest.json"), "utf8"));
      assert.equal(manifest.complete, true);
      assert.equal(manifest.verifiedFiles, 4);
      assert.equal(manifest.aliases.length, 2);
      assert(manifest.aliases.every((alias) => alias.materialized));
      assert.equal(manifest.files.find((file) => file.path.endsWith("first.txt")).sha256,
        crypto.createHash("sha256").update("first payload").digest("hex"));
    }
    const status = JSON.parse(await fsp.readFile(context.sourceCloneStatusPath, "utf8"));
    assert(status[sourceRoot].lastClonedAt > 0);
    assert.equal(status[sourceRoot].destinations.length, 2);
    assert(status[secondSourceRoot].lastClonedAt > 0);
    assert.match(status[sourceRoot].sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(status[sourceRoot].sourceFingerprintVersion, 2);
    const expectedFingerprint = new InventoryFingerprint();
    for (const relativePath of ["first.txt", path.join("nested", "second.txt")]) {
      const stats = await fsp.stat(path.join(sourceRoot, relativePath));
      expectedFingerprint.add(relativePath, stats.size, stats.mtimeMs);
    }
    assert.equal(status[sourceRoot].sourceFingerprint, expectedFingerprint.finish(), "clone freshness matches the measured source inventory signature");
    assert.equal(progress.at(-1).phase, "complete");
    assert.equal(progress.at(-1).verifiedFiles, 4);

    const latest = await context.findLatestShelterSnapshot();
    assert.ok(latest && latest.rootPath === preflight.destinations[0].cloneRoot);
    const sameVolumeDestination = path.join(root, "same-volume-replica");
    sameVolumeDestinationPath = sameVolumeDestination;
    await fsp.mkdir(sameVolumeDestination);
    await assert.rejects(
      context.prepareShelterReplica([sameVolumeDestination], "same-volume-replica-test"),
      /different physical volume/,
      "shelter replication enforces a physically separate destination",
    );
    context.sourceCloneOperations.delete("same-volume-replica-test");
    const replicaOperation = "shelter-replica-test";
    const replicaPlan = await context.prepareShelterReplica([replicaDestination], replicaOperation);
    assert(replicaPlan.totalFiles >= 5, "replica includes unique shelter content and a retained source-manifest copy");
    assert.equal(replicaPlan.destinations[0].shortfallBytes, 0);
    failHardLinks = true;
    await context.runSourceClone(replicaPlan.planId);
    failHardLinks = false;
    const replicaRoot = replicaPlan.destinations[0].cloneRoot;
    const replicaManifest = JSON.parse(await fsp.readFile(path.join(replicaRoot, "silo-clone-manifest.json"), "utf8"));
    assert.equal(replicaManifest.complete, true);
    assert.equal(replicaManifest.replicaOf, latest.rootPath);
    assert.equal(replicaManifest.sourceIds.length, 2, "original source provenance remains attached to the replica");
    assert(replicaManifest.aliases.length > 0 && replicaManifest.aliases.every((alias) => !alias.materialized), "unsupported hard links leave explicit manifest aliases");
    for (const alias of replicaManifest.aliases)
      assert.equal(await fsp.access(path.join(replicaRoot, alias.path)).then(() => true, () => false), false, "manifest-only alias has no duplicate physical file");
    assert.equal(JSON.parse(await fsp.readFile(path.join(replicaRoot, "silo-source-snapshot-manifest.json"), "utf8")).complete, true);
    assert.equal(await fsp.readFile(path.join(replicaRoot, "01-Photos", "nested", "second.txt"), "utf8"), "second payload");
    const statusAfterReplica = JSON.parse(await fsp.readFile(context.sourceCloneStatusPath, "utf8"));
    const replicaStatus = statusAfterReplica[`shelter-replica:${latest.rootPath}`];
    assert(replicaStatus.lastClonedAt > 0 && replicaStatus.destinations.includes(replicaRoot), "verified replica location and time persist for Stats");

    const previousVerificationTime = status[sourceRoot].lastClonedAt;
    const partialOperation = "clone-partial-destination-test";
    const partialPlan = await context.prepareSourceClone([sourceRoot, secondSourceRoot], partialDestinations, partialOperation);
    await fsp.rm(partialDestinations[1], { recursive: true, force: true });
    await assert.rejects(context.runSourceClone(partialPlan.planId), /ENOENT|no such file/i);
    const partialStatus = JSON.parse(await fsp.readFile(context.sourceCloneStatusPath, "utf8"));
    assert(partialStatus[sourceRoot].lastClonedAt > previousVerificationTime);
    assert(partialStatus[sourceRoot].destinations.includes(partialPlan.destinations[0].cloneRoot), "the earlier verified target remains recorded when a later target fails");
    const compressedDestination = path.join(root, "backup-zip");
    await fsp.mkdir(compressedDestination);
    const compressedPlan = await context.prepareSourceClone([sourceRoot, secondSourceRoot], [compressedDestination], "clone-compressed-test");
    const compressedRoot = compressedPlan.destinations[0].cloneRoot;
    await context.runSourceClone(compressedPlan.planId, { compress: true });
    assert.equal(progress.at(-1).phase, "complete", "compressed clone reports completion");
    assert.equal(await fsp.access(compressedRoot).then(() => true, () => false), false, "compressed mode writes no uncompressed folder");
    assert.deepEqual((await fsp.readdir(compressedDestination)).filter((name) => name.endsWith(".silo-partial")), [], "no partial archive left behind");
    const extractParent = path.join(root, "restored");
    await fsp.mkdir(extractParent);
    const restored = await extractCloneArchive(`${compressedRoot}${CLONE_ARCHIVE_EXTENSION}`, extractParent);
    assert.equal(restored.extractedFiles, 4);
    assert.equal(restored.restoredAliases, 2);
    assert.equal(await fsp.readFile(path.join(restored.destinationRoot, "01-Photos", "nested", "second.txt"), "utf8"), "second payload");
    assert.equal(await fsp.readFile(path.join(restored.destinationRoot, "02-Camera", "same-first.txt"), "utf8"), "first payload");
    assert.equal((await fsp.stat(path.join(restored.destinationRoot, "01-Photos", "first.txt"))).mtimeMs,
      (await fsp.stat(path.join(sourceRoot, "first.txt"))).mtimeMs, "extraction restores exact source modification times");
    const restoredManifest = JSON.parse(await fsp.readFile(path.join(restored.destinationRoot, "silo-clone-manifest.json"), "utf8"));
    assert.equal(restoredManifest.complete, true);
    const compressedStatus = JSON.parse(await fsp.readFile(context.sourceCloneStatusPath, "utf8"));
    assert(compressedStatus[sourceRoot].destinations.includes(`${compressedRoot}${CLONE_ARCHIVE_EXTENSION}`), "compressed archive location is recorded for Stats");
    const nextPlan = await context.prepareSourceClone([sourceRoot], [compressedDestination], "clone-compressed-name-test");
    assert.notEqual(nextPlan.destinations[0].cloneRoot, compressedRoot, "a new plan never targets an existing archive name");
    context.sourceClonePlans.delete(nextPlan.planId);
    console.log("Source clone tests passed: selected-source preflight, config/index bundle, multiple destinations, SHA-256 verification, per-source timestamps, and compressed .zip clones with verified extraction.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
