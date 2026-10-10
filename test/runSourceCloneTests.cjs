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
const {
  MAC_DATA_VOLUME_ROOT,
  getMacDataVolumeDeviceId,
  isAppDataPath,
  isMacDataVolumePathExcluded,
  isMacDataVolumeSourceRoot,
  isNonLibraryPath,
  isSiloCloneDirectory,
  invalidateSiloCloneDirectoryCache,
} = require("../src/indexingPathPolicy.ts");
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
const workspaceTmp = process.env.SILO_TEST_TMPDIR || path.resolve(__dirname, "../../..", "tmp");
fs.mkdirSync(workspaceTmp, { recursive: true });
const root = fs.mkdtempSync(path.join(workspaceTmp, "silo-source-clone-test-"));
const sourceRoot = path.join(root, "source");
const userData = path.join(sourceRoot, ".silo-user-data");
const secondSourceRoot = path.join(root, "camera");
const machineFixtureRoot = path.join(root, "machine-source");
const machineMountRoot = path.join(machineFixtureRoot, "Users", "test-user", "mounted-volume");
const destinations = [path.join(root, "backup-a"), path.join(root, "backup-b")];
const partialDestinations = [path.join(root, "backup-c"), path.join(root, "backup-later-disconnects")];
const replicaDestination = path.join(root, "replica-volume");
fs.mkdirSync(path.join(sourceRoot, "nested"), { recursive: true });
fs.mkdirSync(secondSourceRoot, { recursive: true });
fs.mkdirSync(path.join(machineFixtureRoot, "Users", "test-user", "visible"), { recursive: true });
fs.mkdirSync(path.join(machineFixtureRoot, "Users", "test-user", "Library", "Caches"), { recursive: true });
fs.mkdirSync(path.join(machineFixtureRoot, "Users", "test-user", "Library", "Cache"), { recursive: true });
fs.mkdirSync(path.join(machineFixtureRoot, "System"), { recursive: true });
fs.mkdirSync(path.join(machineFixtureRoot, "Systematic"), { recursive: true });
fs.mkdirSync(path.join(machineFixtureRoot, "private", "tmp"), { recursive: true });
fs.mkdirSync(machineMountRoot, { recursive: true });
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
fs.writeFileSync(path.join(machineFixtureRoot, "Users", "test-user", "visible", "keep.txt"), "internal volume");
fs.writeFileSync(path.join(machineFixtureRoot, "Users", "test-user", "Library", "Caches", "skip.txt"), "cache");
fs.writeFileSync(path.join(machineFixtureRoot, "Users", "test-user", "Library", "Cache", "keep.txt"), "not the Caches directory");
fs.writeFileSync(path.join(machineFixtureRoot, "System", "skip.txt"), "excluded system tree");
fs.writeFileSync(path.join(machineFixtureRoot, "Systematic", "keep.txt"), "boundary lookalike");
fs.writeFileSync(path.join(machineFixtureRoot, "private", "tmp", "skip.txt"), "excluded temporary tree");
fs.writeFileSync(path.join(machineMountRoot, "skip.txt"), "different device");
const machineSymlinkTarget = path.join(root, "machine-symlink-target.txt");
fs.writeFileSync(machineSymlinkTarget, "outside source");
fs.symlinkSync(machineSymlinkTarget, path.join(machineFixtureRoot, "Users", "test-user", "visible", "outside-link.txt"));

const progress = [];
let failHardLinks = false;
let sameVolumeDestinationPath = "";
const simulatedDeviceRoots = new Map([[machineFixtureRoot, 7100], [machineMountRoot, 7200]]);
const injectedMachineScanFailures = new Map();
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
    if (property === "readdir") return async (directoryPath, ...args) => {
      const failure = injectedMachineScanFailures.get(path.resolve(String(directoryPath)));
      if (failure?.operation === "readdir") {
        const error = new Error("Injected machine-source directory read failure");
        error.code = failure.code;
        throw error;
      }
      return target.readdir(directoryPath, ...args);
    };
    if (property === "stat") return async (filePath, ...args) => {
      const failure = injectedMachineScanFailures.get(path.resolve(String(filePath)));
      if (failure?.operation === "stat") {
        const error = new Error("Injected machine-source file stat failure");
        error.code = failure.code;
        throw error;
      }
      const stats = await target.stat(filePath, ...args);
      const canonicalFilePath = fs.realpathSync(path.resolve(String(filePath)));
      const canonicalReplicaRoot = fs.realpathSync(replicaDestination);
      const canonicalPrimaryRoot = fs.realpathSync(destinations[0]);
      const simulatedDevice = [...simulatedDeviceRoots]
        .map(([deviceRoot, deviceId]) => ({ root: fs.realpathSync(deviceRoot), deviceId }))
        .filter(({ root }) => canonicalFilePath === root || canonicalFilePath.startsWith(`${root}${path.sep}`))
        .sort((left, right) => right.root.length - left.root.length)[0];
      if (simulatedDevice)
        return new Proxy(stats, { get(value, key) { return key === "dev" ? simulatedDevice.deviceId : Reflect.get(value, key, value); } });
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
  getMacDataVolumeDeviceId,
  isAppDataPath,
  isMacDataVolumePathExcluded,
  isMacDataVolumeSourceRoot,
  isNonLibraryPath,
  isSiloCloneDirectory,
  invalidateSiloCloneDirectoryCache,
  isPermissionError: (error) => ["EPERM", "EACCES"].includes(error?.code),
  isTimeMachineDirectory: async () => false,
  shouldSkipTimeMachineEntry: () => false,
  mime: { getType: () => null },
  classifyFile: () => "other",
  app: { getPath: (name) => { assert.equal(name, "userData"); return userData; }, getVersion: () => "test-version" },
  indexStorageRoot: userData,
  exportConfig: async (_userData, target) => { await fsp.writeFile(target, "test silo config and indexes"); return { size: 28 }; },
  listSources: async () => [
    { id: sourceRoot, rootPath: sourceRoot, label: "Photos", kind: "local", enabled: true, available: true },
    { id: secondSourceRoot, rootPath: secondSourceRoot, label: "Camera", kind: "local", enabled: true, available: true },
    { id: "/disconnected", rootPath: "/disconnected", label: "Offline", kind: "local", enabled: true, available: false },
  ],
  sourceCloneStatusPath: path.join(userData, "source-clone-status.json"),
  sourceCloneStatusCache: null,
  sourceCloneStatusWrite: Promise.resolve(),
  getShelterDestination: async () => destinations[0],
  sourceCloneOperations: new Map(),
  sourceClonePlans: new Map(),
  sendToRenderer: (channel, value) => { if (channel === "source-clone-progress") progress.push(value); },
});
for (const name of ["cloneSafeSegment", "cloneSafeRelativePath", "sendSourceCloneProgress", "ensureCloneActive", "hashFile", "readFiles", "listLocalCloneEntries", "getSourceCloneStatus", "persistSourceCloneStatus", "prepareSourceClone", "findLatestShelterSnapshot", "prepareShelterReplica", "runSourceClone"]) {
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
    assert.equal(isMacDataVolumeSourceRoot(MAC_DATA_VOLUME_ROOT), true, "only the exact internal data-volume root is a machine source");
    assert.equal(isMacDataVolumeSourceRoot(`${MAC_DATA_VOLUME_ROOT}/`), true, "a trailing separator does not change machine-root identity");
    assert.equal(isMacDataVolumeSourceRoot(`${MAC_DATA_VOLUME_ROOT}-archive`), false, "a sibling path sharing the machine-root prefix is not a machine source");
    assert.equal(isMacDataVolumeSourceRoot(path.join(MAC_DATA_VOLUME_ROOT, "Users")), false, "a nested path is not the machine source root");
    assert.equal(await getMacDataVolumeDeviceId(`${MAC_DATA_VOLUME_ROOT}-archive`), null, "device lookup does not stat a path that only resembles the machine root");

    for (const relativePath of [
      "System/Library",
      "Volumes/External",
      "home/shared",
      "dev",
      "cores",
      ".Spotlight-V100",
      ".fseventsd",
      ".Trashes",
      ".TemporaryItems",
      ".DocumentRevisions-V100",
      "private/var/folders",
      "private/tmp/item",
      "Users/test-user/Library/Caches/item",
      "Users/test-user/Library/Logs/item",
    ]) {
      assert.equal(
        isMacDataVolumePathExcluded(path.join(MAC_DATA_VOLUME_ROOT, relativePath), MAC_DATA_VOLUME_ROOT),
        true,
        `${relativePath} is excluded from machine-source traversal`,
      );
    }
    for (const candidatePath of [
      `${MAC_DATA_VOLUME_ROOT}-archive/System/Library`,
      path.join(MAC_DATA_VOLUME_ROOT, "Users", "test-user", "Library", "Cache", "item"),
      path.join(MAC_DATA_VOLUME_ROOT, "Users", "test-user", "Library", "NotCaches", "item"),
    ]) {
      assert.equal(
        isMacDataVolumePathExcluded(candidatePath, MAC_DATA_VOLUME_ROOT),
        false,
        `${candidatePath} is a path-boundary lookalike, not an excluded path`,
      );
    }

    const originalIsMachineRoot = context.isMacDataVolumeSourceRoot;
    const originalGetMachineDevice = context.getMacDataVolumeDeviceId;
    const originalIsMachinePathExcluded = context.isMacDataVolumePathExcluded;
    context.isMacDataVolumeSourceRoot = (candidate) =>
      path.resolve(candidate) === machineFixtureRoot || originalIsMachineRoot(candidate);
    context.getMacDataVolumeDeviceId = async (candidate) =>
      path.resolve(candidate) === machineFixtureRoot ? 7100 : originalGetMachineDevice(candidate);
    context.isMacDataVolumePathExcluded = (candidate, source) => {
      if (path.resolve(source) !== machineFixtureRoot) return originalIsMachinePathExcluded(candidate, source);
      const relativePath = path.relative(machineFixtureRoot, path.resolve(candidate));
      if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return false;
      return originalIsMachinePathExcluded(path.join(MAC_DATA_VOLUME_ROOT, relativePath), MAC_DATA_VOLUME_ROOT);
    };

    const scanErrorRoot = path.join(machineFixtureRoot, "Users", "test-user", "scan-errors");
    const permissionDirectory = path.join(scanErrorRoot, "permission-denied");
    const unreadableDirectory = path.join(scanErrorRoot, "unreadable");
    const deniedStatFile = path.join(scanErrorRoot, "denied-stat.txt");
    const unreadableStatFile = path.join(scanErrorRoot, "unreadable-stat.txt");
    await fsp.mkdir(permissionDirectory, { recursive: true });
    await fsp.mkdir(unreadableDirectory, { recursive: true });
    await fsp.writeFile(path.join(permissionDirectory, "hidden.txt"), "permission protected");
    await fsp.writeFile(path.join(unreadableDirectory, "hidden.txt"), "unreadable directory");
    await fsp.writeFile(deniedStatFile, "permission protected stat");
    await fsp.writeFile(unreadableStatFile, "unreadable stat");
    injectedMachineScanFailures.set(permissionDirectory, { operation: "readdir", code: "EACCES" });
    injectedMachineScanFailures.set(unreadableDirectory, { operation: "readdir", code: "EIO" });
    injectedMachineScanFailures.set(deniedStatFile, { operation: "stat", code: "EPERM" });
    injectedMachineScanFailures.set(unreadableStatFile, { operation: "stat", code: "EIO" });
    try {
      const scanErrorDiagnostics = { denied: 0, unreadable: 0, isTimeMachine: false };
      const scanErrorResults = await context.readFiles(machineFixtureRoot, true, scanErrorDiagnostics, undefined, machineFixtureRoot);
      assert.deepEqual(scanErrorDiagnostics, { denied: 2, unreadable: 2, isTimeMachine: false }, "readFiles counts permission and I/O failures from machine-source readdir and stat operations");
      assert.equal(scanErrorResults.some((entry) => entry.path.startsWith(scanErrorRoot) && !entry.isDirectory), false, "failed machine-source entries do not leak into scan results");
    } finally {
      injectedMachineScanFailures.clear();
      await fsp.rm(scanErrorRoot, { recursive: true, force: true });
    }

    const machineReadDiagnostics = { denied: 0, unreadable: 0, isTimeMachine: false };
    const machineReadFiles = await context.readFiles(machineFixtureRoot, true, machineReadDiagnostics, undefined, machineFixtureRoot);
    const machineReadFilePaths = Array.from(machineReadFiles).filter((entry) => !entry.isDirectory).map((entry) => entry.relativePath).sort();
    const expectedMachineReadFilePaths = [
      path.join("Users", "test-user", "Library", "Cache", "keep.txt"),
      path.join("Systematic", "keep.txt"),
      path.join("Users", "test-user", "visible", "keep.txt"),
    ].sort();
    assert.deepEqual(machineReadFilePaths, expectedMachineReadFilePaths, `readFiles applies machine exclusions, device checks, and symlink skipping to the index scan: ${JSON.stringify(machineReadFilePaths)}`);
    assert.deepEqual(machineReadDiagnostics, { denied: 0, unreadable: 0, isTimeMachine: false });

    const excludedRootProgress = [];
    const excludedRootFiles = await context.readFiles(
      path.join(machineFixtureRoot, "System"),
      true,
      undefined,
      (files) => excludedRootProgress.push(files.length),
      machineFixtureRoot,
    );
    assert.deepEqual(Array.from(excludedRootFiles), [], "readFiles does not scan an explicitly excluded subtree as its starting root");
    assert.deepEqual(excludedRootProgress, [0], "an excluded-root early return still reports empty progress");

    const machineEntries = [];
    context.sourceCloneOperations.set("machine-walker-edge-cases", { cancelled: false });
    await context.listLocalCloneEntries(machineFixtureRoot, "machine-walker-edge-cases", (entry) => machineEntries.push(entry));
    const machineFiles = machineEntries.filter((entry) => !entry.isDirectory).map((entry) => entry.destinationRelativePath).sort();
    assert.deepEqual(machineFiles, [
      path.join("Users", "test-user", "Library", "Cache", "keep.txt"),
      path.join("Systematic", "keep.txt"),
      path.join("Users", "test-user", "visible", "keep.txt"),
    ].sort(), "machine traversal skips excluded roots, cross-device mounts, and symlinks while retaining boundary lookalikes");
    context.sourceCloneOperations.delete("machine-walker-edge-cases");

    const machineSource = { id: machineFixtureRoot, rootPath: machineFixtureRoot, label: "This Mac", kind: "machine", enabled: true, available: true };
    const insideMachineDestination = path.join(machineFixtureRoot, "Users", "test-user", "visible");
    context.sourceCloneOperations.delete("machine-destination-inside-test");
    await assert.rejects(
      context.prepareSourceClone([machineSource.id], [insideMachineDestination], "machine-destination-inside-test", [machineSource], { includeConfig: false }),
      /Destination cannot be inside selected source/,
      "a machine clone cannot target a directory inside its own source",
    );
    context.sourceCloneOperations.delete("machine-destination-inside-test");

    const outsideMachineDestination = path.join(root, "machine-backup-outside-source");
    await fsp.mkdir(outsideMachineDestination);
    const outsideMachinePlan = await context.prepareSourceClone(
      [machineSource.id],
      [outsideMachineDestination],
      "machine-destination-outside-test",
      [machineSource],
      { includeConfig: false },
    );
    assert.equal(outsideMachinePlan.totalFiles, 3, "an external destination accepts the safely enumerated machine-source files");
    const outsidePlan = context.sourceClonePlans.get(outsideMachinePlan.planId);
    await fsp.rm(outsidePlan.configDirectory, { recursive: true, force: true });
    context.sourceClonePlans.delete(outsideMachinePlan.planId);
    context.sourceCloneOperations.delete("machine-destination-outside-test");

    context.getMacDataVolumeDeviceId = async (candidate) =>
      path.resolve(candidate) === machineFixtureRoot ? null : originalGetMachineDevice(candidate);
    const unknownDeviceProgress = [];
    const unknownDeviceRead = await context.readFiles(
      machineFixtureRoot,
      true,
      undefined,
      (files) => unknownDeviceProgress.push(files.length),
      machineFixtureRoot,
    );
    assert.deepEqual(Array.from(unknownDeviceRead), [], "readFiles fails closed when it cannot identify the internal volume device");
    assert.deepEqual(unknownDeviceProgress, [0], "unknown-device scans report empty progress without traversal");
    context.sourceCloneOperations.set("machine-device-unknown-test", { cancelled: false });
    await assert.rejects(
      context.listLocalCloneEntries(machineFixtureRoot, "machine-device-unknown-test", () => {}),
      /Could not verify the internal data-volume boundary/,
      "machine traversal fails closed when the internal device cannot be verified",
    );
    context.sourceCloneOperations.delete("machine-device-unknown-test");
    context.isMacDataVolumeSourceRoot = originalIsMachineRoot;
    context.getMacDataVolumeDeviceId = originalGetMachineDevice;
    context.isMacDataVolumePathExcluded = originalIsMachinePathExcluded;

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
    const restoredMtimeMs = (await fsp.stat(path.join(restored.destinationRoot, "01-Photos", "first.txt"))).mtimeMs;
    const sourceMtimeMs = (await fsp.stat(path.join(sourceRoot, "first.txt"))).mtimeMs;
    assert.ok(
      Math.abs(restoredMtimeMs - sourceMtimeMs) < 1,
      "extraction preserves source modification time within filesystem precision",
    );
    const restoredManifest = JSON.parse(await fsp.readFile(path.join(restored.destinationRoot, "silo-clone-manifest.json"), "utf8"));
    assert.equal(restoredManifest.complete, true);
    const compressedStatus = JSON.parse(await fsp.readFile(context.sourceCloneStatusPath, "utf8"));
    assert(compressedStatus[sourceRoot].destinations.includes(`${compressedRoot}${CLONE_ARCHIVE_EXTENSION}`), "compressed archive location is recorded for Stats");
    const nextPlan = await context.prepareSourceClone([sourceRoot], [compressedDestination], "clone-compressed-name-test");
    assert.notEqual(nextPlan.destinations[0].cloneRoot, compressedRoot, "a new plan never targets an existing archive name");
    context.sourceClonePlans.delete(nextPlan.planId);
    console.log("Source clone tests passed: machine-source indexing/error boundaries, selected-source preflight, SHA-256 verification, and compressed .zip clone extraction.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
