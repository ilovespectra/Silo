const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(require("node:fs").readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const { PhoneManager } = require("../src/phoneManager.ts");

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "silo-offline-phone-"));
  try {
    const backupRoot = path.join(root, "backup-drive");
    const cacheRoot = path.join(backupRoot, "ios", "device-1");
    await fs.mkdir(path.join(cacheRoot, "Media", "DCIM"), { recursive: true });
    await fs.mkdir(path.join(cacheRoot, "Documents"), { recursive: true });
    await fs.writeFile(path.join(cacheRoot, "Media", "DCIM", "photo.jpg"), "photo-bytes");
    await fs.writeFile(path.join(cacheRoot, "Documents", "notes.txt"), "notes");
    await fs.writeFile(path.join(cacheRoot, "Documents", "damaged.pdf"), "broken");

    const manager = new PhoneManager(path.join(root, "user-data"));
    manager.log = () => {};
    manager.backupDestinationPath = backupRoot;
    manager.backupManifests.set("ios:device-1", {
      cacheRoot: backupRoot,
      files: {
        "/__phone__/ios/device-1/Media/DCIM/photo.jpg": `${"photo-bytes".length}:1000`,
        "/__phone__/ios/device-1/Documents/notes.txt": `${"notes".length}:2000`,
        "/__phone__/ios/device-1/Documents/damaged.pdf": "100:3000",
        "/__phone__/ios/device-1/Documents/missing.docx": "50:4000",
      },
      progress: {
        deviceId: "device-1", platform: "ios", deviceName: "Tanny phone",
        status: "complete", totalFiles: 4, completedFiles: 4, totalBytes: 165,
        completedBytes: 165, copiedFiles: 4, failedFiles: 0, currentFile: null,
        message: "Complete", lastBackupAt: 123456,
      },
    });

    const backups = await manager.getOfflineBackups();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].snapshotAt, 123456);
    assert.equal(backups[0].rootPath, "/__phone_backup__/ios/device-1");
    const rootEntries = await manager.listPhoneFiles(backups[0].rootPath, false);
    assert.deepEqual(rootEntries.map((item) => item.name), ["Documents", "Media"]);
    const documents = await manager.listPhoneFiles(`${backups[0].rootPath}/Documents`, false);
    assert.deepEqual(documents.map((item) => item.name), ["notes.txt"]);
    const all = await manager.listPhoneFilesRecursively(backups[0].rootPath);
    assert.deepEqual(all.filter((item) => !item.isDirectory).map((item) => item.relativePath).sort(), [
      "Documents/notes.txt", "Media/DCIM/photo.jpg",
    ]);
    assert(all.every((item) => item.path.startsWith("/__phone_backup__/ios/device-1")));
    assert.equal(await manager.materialize(all.find((item) => item.name === "notes.txt").path), path.join(cacheRoot, "Documents", "notes.txt"));
    assert.equal((await manager.statPhoneFile(all.find((item) => item.name === "notes.txt").path)).size, 5);

    manager.connectedDeviceKeys.add("ios:device-1");
    assert.equal((await manager.getOfflineBackups()).length, 1, "saved copies remain separate and browseable while the phone is connected");
    const connectedSnapshotEntries = await manager.listPhoneFiles(backups[0].rootPath, false);
    assert.deepEqual(connectedSnapshotEntries.map((item) => item.name), ["Documents", "Media"], "the saved source continues reading from disk instead of switching to the connected phone");

    const versionedDestination = path.join(root, "versioned-drive");
    const userData = path.join(root, "versioned-user-data");
    await fs.mkdir(versionedDestination, { recursive: true });
    await fs.mkdir(path.join(userData, "phone-cache"), { recursive: true });
    const versionedManager = new PhoneManager(userData);
    versionedManager.log = () => {};
    await versionedManager.setBackupDestination(versionedDestination);
    let noteContents = "first snapshot";
    let noteModified = 1000;
    versionedManager.listPhoneFilesRecursively = async () => [{
      name: "notes.txt",
      path: "/__phone__/ios/device-2/Documents/notes.txt",
      relativePath: "Documents/notes.txt",
      size: Buffer.byteLength(noteContents),
      modified: noteModified,
      isDirectory: false,
      type: "document",
      extension: ".txt",
    }];
    const materializeSavedCopy = versionedManager.materialize.bind(versionedManager);
    versionedManager.materialize = async (candidate) => {
      if (versionedManager.parsePhonePath(candidate)?.offlineBackup) {
        return materializeSavedCopy(candidate);
      }
      const localPath = versionedManager.localCachePath(candidate);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.rm(localPath, { force: true });
      await fs.writeFile(localPath, noteContents);
      return localPath;
    };
    const device = {
      id: "device-2", platform: "ios", name: "Versioned phone", model: null,
      status: "ready", rootPath: "/__phone__/ios/device-2", message: "Ready",
    };

    await versionedManager.backupDevice(device);
    const firstVersion = (await versionedManager.getOfflineBackups())[0];
    assert(firstVersion.snapshotId);
    const firstVersionFile = `${firstVersion.rootPath}/Documents/notes.txt`;
    assert.equal(await fs.readFile(await versionedManager.materialize(firstVersionFile), "utf8"), "first snapshot");

    noteContents = "second snapshot";
    noteModified = 2000;
    await versionedManager.backupDevice(device);
    const versions = await versionedManager.getOfflineBackups();
    assert.equal(versions.length, 2, "a changed device copy creates a second retained snapshot");
    assert.notEqual(versions[0].snapshotId, versions[1].snapshotId);
    assert.equal(versions[0].snapshotAt, Number(versions[0].snapshotId));
    assert.equal(await fs.readFile(await versionedManager.materialize(firstVersionFile), "utf8"), "first snapshot", "later refreshes do not mutate earlier snapshots");
    const latestFile = `${versions[1].rootPath}/Documents/notes.txt`;
    assert.equal(await fs.readFile(await versionedManager.materialize(latestFile), "utf8"), "second snapshot");
    const latestSnapshotAt = versions[1].snapshotAt;
    await versionedManager.backupDevice(device);
    assert.equal((await versionedManager.getOfflineBackups()).length, 2, "unchanged rescans do not create duplicate retained snapshots");
    assert.equal((await versionedManager.getOfflineBackups())[1].snapshotAt, latestSnapshotAt);

    const restartedManager = new PhoneManager(userData);
    restartedManager.log = () => {};
    await restartedManager.initialize();
    const restartedVersions = await restartedManager.getOfflineBackups();
    assert.equal(restartedVersions.length, 2, "saved snapshots remain registered after an app restart");
    assert.equal(await fs.readFile(await restartedManager.materialize(`${restartedVersions[0].rootPath}/Documents/notes.txt`), "utf8"), "first snapshot");
    versionedManager.connectedDeviceKeys.add("ios:device-2");
    assert.equal((await versionedManager.listPhoneFiles(versions[0].rootPath, false))[0].name, "Documents", "dated snapshots remain browseable while the device is connected");

    const nativeDevice = {
      id: "device-3", platform: "ios", name: "Restore phone", model: "iPhone16,1",
      status: "ready", rootPath: "/__phone__/ios/device-3", message: "Ready",
    };
    const nativeManager = new PhoneManager(path.join(root, "native-user-data"));
    nativeManager.log = () => {};
    const nativeDestination = path.join(root, "native-backup-drive");
    await fs.mkdir(nativeDestination, { recursive: true });
    await fs.mkdir(path.join(root, "native-user-data", "phone-cache"), { recursive: true });
    await nativeManager.setBackupDestination(nativeDestination);
    const staleBrowseCache = path.join(root, "older-browse-cache");
    const nativeManifest = {
      cacheRoot: staleBrowseCache,
      files: {},
      progress: {
        deviceId: nativeDevice.id, platform: "ios", deviceName: nativeDevice.name,
        status: "idle", totalFiles: 0, completedFiles: 0, totalBytes: 0,
        completedBytes: 0, copiedFiles: 0, failedFiles: 0, currentFile: null,
        message: "Waiting", lastBackupAt: null,
      },
    };
    nativeManager.backupManifests.set("ios:device-3", nativeManifest);
    const utilityCalls = [];
    nativeManager.runLongOperation = async (binary, args, environment) => {
      utilityCalls.push({ binary, args, environment });
      if (args.includes("backup")) {
        const archivePath = args.at(-1);
        const devicePath = path.join(archivePath, nativeDevice.id);
        await fs.mkdir(devicePath, { recursive: true });
        await fs.writeFile(path.join(devicePath, "Manifest.plist"), "test manifest");
        await fs.writeFile(path.join(devicePath, "Info.plist"), "test info");
        await fs.writeFile(path.join(devicePath, "Status.plist"), "test status");
        await fs.writeFile(path.join(devicePath, "Payload.bin"), "immutable payload");
      }
    };
    nativeManager.verifyEncryptedRestoreArchive = async () => {};
    nativeManager.readRestoreArchivePlistString = async (_archiveRoot, _deviceId, key) =>
      key === "Product Type" ? "iPhone16,1" : key === "SnapshotState" ? "finished" : "17.5";
    const nativeArchive = await nativeManager.createRestoreArchive(nativeDevice, "safe-password-123");
    assert.equal(nativeArchive.encrypted, true);
    assert.match(nativeArchive.archivePath, /native-backup-drive[/\\]\.silo-phone-restores[/\\]ios[/\\]device-3[/\\].*[/\\]backup$/);
    assert.equal(nativeManifest.cacheRoot, staleBrowseCache, "restore archives do not repoint the separate browseable-copy cache");
    assert.equal(nativeArchive.deviceModel, "iPhone16,1");
    assert(utilityCalls.some((call) => call.args.includes("encryption") && call.args.includes("on")));
    assert(utilityCalls.some((call) => call.args.includes("backup") && call.args.includes("--full")));
    assert(utilityCalls.every((call) => !call.args.includes("safe-password-123")), "passwords never appear in process arguments");
    assert(utilityCalls.every((call) => call.environment.BACKUP_PASSWORD === "safe-password-123"));
    const nativeRestart = new PhoneManager(path.join(root, "native-user-data"));
    nativeRestart.log = () => {};
    await nativeRestart.initialize();
    assert.equal((await nativeRestart.getRestoreArchives()).length, 1, "encrypted restore archives survive app restarts");
    nativeRestart.verifyEncryptedRestoreArchive = async () => {};
    nativeRestart.readRestoreArchivePlistString = async (_archiveRoot, _deviceId, key) =>
      key === "SnapshotState"
        ? "finished"
        : key === "Product Type"
          ? "iPhone16,1"
          : key === "Product Version"
            ? "17.5"
            : key === "Target Identifier"
              ? "device-3"
              : "source-serial";
    nativeRestart.run = async (_binary, args) => ({
      stdout: args.includes("SerialNumber") ? "replacement-serial" : "18.0",
      stderr: "",
      ok: true,
    });
    const rewrittenPlists = [];
    nativeRestart.replaceRestoreArchivePlistString = async (_path, key, value) => {
      rewrittenPlists.push({ key, value });
    };
    const replacementDevice = {
      ...nativeDevice,
      id: "replacement-device",
      name: "Replacement phone",
      model: "iPhone16,1",
      rootPath: "/__phone__/ios/replacement-device",
    };
    let restoreCall = null;
    nativeRestart.runLongOperation = async (binary, args, environment) => {
      restoreCall = { binary, args, environment };
      if (args.includes("restore"))
        await fs.writeFile(
          path.join(args.at(-1), "device-3", "Payload.bin"),
          "restore-side mutation",
        );
    };
    await nativeRestart.restoreDeviceFromArchive(replacementDevice, nativeArchive.id, "safe-password-123");
    assert(restoreCall.args.includes("restore"));
    assert(restoreCall.args.includes("replacement-device"));
    assert.deepEqual(restoreCall.args.slice(0, 4), ["-u", "replacement-device", "-s", "device-3"]);
    assert.notEqual(restoreCall.args.at(-1), nativeArchive.archivePath, "replacement restores use a separate working copy");
    assert.deepEqual(rewrittenPlists.map(({ key }) => key), ["Target Identifier", "Serial Number", "Unique Identifier"]);
    assert.deepEqual(rewrittenPlists.map(({ value }) => value), ["replacement-device", "replacement-serial", "REPLACEMENT-DEVICE"]);
    assert(!restoreCall.args.includes("safe-password-123"));
    assert.equal(restoreCall.environment.BACKUP_PASSWORD, "safe-password-123");
    assert.equal(await fs.stat(nativeArchive.archivePath).then((stats) => stats.isDirectory()), true, "the retained archive stays intact after a replacement restore");
    assert.equal(await fs.readFile(path.join(nativeArchive.archivePath, "device-3", "Info.plist"), "utf8"), "test info", "the retained device identity metadata is not rewritten");
    assert.equal(await fs.readFile(path.join(nativeArchive.archivePath, "device-3", "Payload.bin"), "utf8"), "immutable payload", "restore-side writes cannot mutate the retained payload");

    await assert.rejects(
      nativeRestart.restoreDeviceFromArchive(
        { ...replacementDevice, model: "iPad16,3" },
        nativeArchive.id,
        "safe-password-123",
      ),
      /same iPhone or iPad model/,
      "replacement restores are rejected when the product type differs",
    );
    const alternateDestination = path.join(root, "alternate-drive");
    await fs.mkdir(alternateDestination, { recursive: true });
    await nativeRestart.setBackupDestination(alternateDestination);
    assert.equal((await nativeRestart.getRestoreArchives()).length, 0, "archives on the previous drive are hidden when another destination is selected");
    await nativeRestart.setBackupDestination(nativeDestination);
    assert.equal((await nativeRestart.getRestoreArchives()).length, 1, "archives reappear when their drive is selected again");
    console.log("Offline phone tests passed: dated immutable/searchable snapshots, restart persistence, connected-device independence, encrypted iOS restore-archive lifecycle, and sensitive password handling.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
