const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(__dirname, "../../..");
const tempRoot = path.join(workspaceRoot, "tmp", `canonical-portable-storage-${process.pid}`);
const moduleCache = new Map();

function loadTypeScript(filePath) {
  const resolved = filePath.endsWith(".ts") ? filePath : `${filePath}.ts`;
  if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  moduleCache.set(resolved, loaded);
  const source = fs.readFileSync(resolved, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = (request) => {
    if (request.startsWith(".") && !path.extname(request)) {
      const candidate = path.resolve(path.dirname(resolved), `${request}.ts`);
      if (fs.existsSync(candidate)) return loadTypeScript(candidate);
    }
    return nativeRequire(request);
  };
  loaded._compile(output, resolved);
  return loaded.exports;
}

function makeFile(root, relative, bytes) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

async function main() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  try {
    const storage = loadTypeScript(path.join(repoRoot, "src/indexingStorage.ts"));
    const policy = loadTypeScript(path.join(repoRoot, "src/indexingPathPolicy.ts"));

    const localRoot = path.join(tempRoot, "local-user-data");
    fs.mkdirSync(localRoot, { recursive: true });
    assert.strictEqual(await storage.readIndexStorageRoot(localRoot), localRoot);

    const externalRoot = path.join(tempRoot, "configured-volume", "SiloCache");
    const fallbackRoot = path.join(tempRoot, "local-fallback-index");
    fs.mkdirSync(fallbackRoot, { recursive: true });
    storage.setActiveIndexStorageRoot(fallbackRoot);
    storage.setIndexStorageExclusionRoots([externalRoot, fallbackRoot]);
    assert.strictEqual(
      policy.isAppDataPath(
        path.join(externalRoot, "semantic-index", "records.jsonl"),
        "/source", "/source", "/app-data", "/app-data",
      ),
      true,
      "the configured external root remains excluded during a local fallback session",
    );

    const symlinkTarget = path.join(tempRoot, "canonical-index-root");
    const symlinkAlias = path.join(tempRoot, "index-root-alias");
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, symlinkAlias, "dir");
    storage.setActiveIndexStorageRoot(symlinkAlias);
    assert.strictEqual(
      policy.isAppDataPath(
        path.join(symlinkTarget, "semantic-index", "records.jsonl"),
        "/source", "/source", "/app-data", "/app-data",
      ),
      true,
      "the canonical target of a symlinked storage root remains excluded",
    );

    let activeSafetyRoot = path.join(tempRoot, "safety-cache-before-move");
    const safetyCachePath = storage.createIndexStoragePathResolver(() => activeSafetyRoot);
    assert.strictEqual(
      safetyCachePath("content-safety-index.json"),
      path.join(activeSafetyRoot, "content-safety-index.json"),
    );
    activeSafetyRoot = path.join(tempRoot, "safety-cache-after-move");
    assert.strictEqual(
      safetyCachePath("content-safety-index.json"),
      path.join(activeSafetyRoot, "content-safety-index.json"),
      "saved safety flags resolve against the current storage root after migration",
    );

    const migrationA = path.join(tempRoot, "migration-source-a");
    const migrationB = path.join(tempRoot, "migration-source-b");
    const destination = path.join(tempRoot, "migration-volume");
    const originals = [
      makeFile(migrationA, "semantic-index/one.bin", crypto.randomBytes(113)),
      makeFile(migrationA, "semantic-index/two.bin", crypto.randomBytes(257)),
      makeFile(migrationB, "face-index/three.bin", crypto.randomBytes(509)),
    ];
    const originalCopyFile = fsPromises.copyFile;
    let copyCount = 0;
    fsPromises.copyFile = async (...args) => {
      copyCount += 1;
      if (copyCount === 2)
        throw Object.assign(new Error("injected copy failure"), { code: "EIO" });
      return originalCopyFile(...args);
    };
    try {
      await assert.rejects(
        storage.migrateIndexStorageRoots(
          [migrationA, migrationB], destination, ["semantic-index", "face-index"],
        ),
        /injected copy failure/,
      );
    } finally {
      fsPromises.copyFile = originalCopyFile;
    }
    for (const original of originals) assert.strictEqual(fs.existsSync(original), true);
    assert.deepStrictEqual(
      fs.readdirSync(destination),
      [],
      "a failed pre-commit copy leaves no partial destination tree",
    );

    const sourceConflict = path.join(tempRoot, "conflict-source");
    const destinationConflict = path.join(tempRoot, "conflict-destination");
    const originalData = makeFile(sourceConflict, "semantic-index/records.jsonl", "source version");
    makeFile(destinationConflict, "semantic-index/records.jsonl", "different existing version");
    await assert.rejects(
      storage.migrateIndexStorageRoots(
        [sourceConflict], destinationConflict, ["semantic-index"],
      ),
      /local original was preserved/,
    );
    assert.strictEqual(fs.readFileSync(originalData, "utf8"), "source version");
    assert.strictEqual(
      fs.readFileSync(path.join(destinationConflict, "semantic-index/records.jsonl"), "utf8"),
      "different existing version",
    );

    console.log("Canonical portable storage migration and exclusion tests passed.");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
