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

const file = (relativePath, size, modified = 1000) => ({
  name: path.posix.basename(relativePath),
  path: `/__phone__/ios/udid-1/${relativePath}`,
  relativePath,
  size,
  modified,
  isDirectory: false,
  type: "image",
  extension: path.posix.extname(relativePath),
});

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "silo-phone-incremental-"));
  try {
    const userData = path.join(root, "user-data");
    const destination = path.join(root, "drive");
    await fs.mkdir(path.join(userData, "phone-cache"), { recursive: true });
    await fs.mkdir(destination, { recursive: true });
    const manager = new PhoneManager(userData);
    manager.log = () => {};
    manager.logError = () => {};
    await manager.setBackupDestination(destination);
    let files = [file("DCIM/a.jpg", 10), file("DCIM/b.jpg", 20), file("DCIM/unknown.jpg", 0, 0)];
    manager.listPhoneFilesRecursively = async (_root, onFile) => {
      for (const entry of files) onFile?.(entry);
      return files;
    };
    const copied = [];
    manager.materialize = async (candidate) => {
      const entry = files.find((item) => item.path === candidate);
      const localPath = manager.localCachePath(candidate);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, Buffer.alloc(entry.size || 7, 1));
      copied.push(path.posix.basename(candidate));
      return localPath;
    };
    const device = {
      id: "udid-1", platform: "ios", name: "iPhone", model: null,
      status: "ready", rootPath: "/__phone__/ios/udid-1", message: "Ready",
    };

    await manager.backupDevice(device);
    assert.deepEqual(copied.sort(), ["a.jpg", "b.jpg", "unknown.jpg"]);

    copied.length = 0;
    manager.scanCache.clear();
    await manager.backupDevice(device);
    assert.deepEqual(copied, [], "an unchanged phone copies nothing, including files with unknown details");

    copied.length = 0;
    manager.scanCache.clear();
    files = [file("DCIM/a.jpg", 10, 5000), file("DCIM/c.jpg", 30)];
    const result = await manager.backupDevice(device);
    assert.deepEqual(copied, ["c.jpg"], "only new files are copied; a new timestamp alone does not force a recopy");
    assert.equal(result.status, "complete");

    const snapshots = manager.backupManifests.get("ios:udid-1").snapshots;
    const latest = snapshots.at(-1);
    assert.deepEqual(Object.keys(latest.files).sort(), ["/DCIM/a.jpg", "/DCIM/b.jpg", "/DCIM/c.jpg", "/DCIM/unknown.jpg"],
      "files deleted from the phone stay in the newest browseable copy");
    const latestRoot = path.join(destination, ".silo-phone-snapshots", "ios", "udid-1", "snapshots", latest.id);
    for (const name of ["a.jpg", "b.jpg", "c.jpg", "unknown.jpg"])
      assert((await fs.stat(path.join(latestRoot, "DCIM", name))).isFile(), `${name} is browseable`);
    assert((await fs.stat(manager.localCachePath(file("DCIM/b.jpg", 20).path))).isFile(), "old backed-up files are never removed");

    console.log("Phone incremental backup tests passed: unchanged phones copy nothing, unknown details never force recopies, new files are added, deleted phone files are kept.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
