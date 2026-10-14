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

const file = (relativePath, size, type) => ({
  name: path.posix.basename(relativePath),
  path: `/__phone__/android/serial-1/${relativePath}`,
  relativePath,
  size,
  modified: 1000,
  isDirectory: false,
  type,
  extension: path.posix.extname(relativePath),
});

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "silo-phone-filter-"));
  try {
    const userData = path.join(root, "user-data");
    const destination = path.join(root, "drive");
    await fs.mkdir(path.join(userData, "phone-cache"), { recursive: true });
    await fs.mkdir(destination, { recursive: true });
    const manager = new PhoneManager(userData);
    manager.log = () => {};
    manager.logError = () => {};
    await manager.setBackupDestination(destination);
    const files = [
      file("DCIM/a.jpg", 10, "image"),
      file("DCIM/b.mp4", 20, "video"),
      file("Download/c.pdf", 5, "document"),
    ];
    let scans = 0;
    manager.listPhoneFilesRecursively = async (_root, onFile) => {
      scans += 1;
      for (const entry of files) onFile?.(entry);
      return files;
    };
    const copied = [];
    manager.materialize = async (candidate) => {
      const localPath = manager.localCachePath(candidate);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, "x");
      copied.push(candidate);
      return localPath;
    };
    const progress = [];
    manager.onScanProgress = (event) => progress.push(event);
    const device = {
      id: "serial-1", platform: "android", name: "Pixel", model: null,
      status: "ready", rootPath: "/__phone__/android/serial-1", message: "Ready",
    };

    const preview = await manager.previewBackup(device);
    assert.equal(preview.totalFiles, 3, "files are not double counted when both the callback and return value report them");
    assert.equal(preview.totalBytes, 35);
    assert.deepEqual(preview.types.image, { count: 1, bytes: 10 });
    assert.deepEqual(preview.types.video, { count: 1, bytes: 20 });
    assert.deepEqual(preview.types.document, { count: 1, bytes: 5 });
    assert.equal(preview.selectedTypes.length, 5, "all types are selected by default");
    assert(progress.at(-1).done && progress.at(-1).filesFound === 3, "scan progress reports the final count");

    await assert.rejects(manager.setBackupFileTypes("android", "serial-1", []), /at least one/);
    assert.deepEqual(await manager.setBackupFileTypes("android", "serial-1", ["image", "document"], "Pixel"), ["image", "document"]);
    await manager.backupDevice(device);
    assert.equal(scans, 1, "a backup right after preview reuses the preview scan");
    assert.deepEqual(copied.sort(), [files[0].path, files[2].path].sort(), "only the chosen file types are copied");

    console.log("Phone backup filter tests passed: per-type preview sizes, scan progress, persisted type choices, and filtered copies.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
