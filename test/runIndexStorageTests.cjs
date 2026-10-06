const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const ts = require("typescript");

const sourceRoot = path.join(__dirname, "..", "src");
const loadedTypeScript = new Map();

function loadTypeScript(relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath);
  if (loadedTypeScript.has(sourcePath)) return loadedTypeScript.get(sourcePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} };
  loadedTypeScript.set(sourcePath, loaded.exports);
  const localRequire = (request) => {
    if (!request.startsWith(".")) return require(request);
    const dependency = path.resolve(path.dirname(sourcePath), request);
    const dependencyPath = path.extname(dependency)
      ? dependency
      : `${dependency}.ts`;
    return loadTypeScript(path.relative(sourceRoot, dependencyPath));
  };
  new Function("require", "module", "exports", output)(
    localRequire,
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

async function run() {
  const tempBase = process.env.SILO_TEST_TMPDIR || os.tmpdir();
  const root = await fsp.mkdtemp(path.join(tempBase, "silo-index-storage-"));
  const {
    migrateIndexStorageEntries,
    readIndexStorageRoot,
    setActiveIndexStorageRoot,
    writeIndexStorageRoot,
  } = loadTypeScript("indexingStorage.ts");
  const indexingPathPolicy = loadTypeScript("indexingPathPolicy.ts");
  const configBundle = loadTypeScript("configBundle.ts");

  try {
    const local = path.join(root, "local");
    const external = path.join(root, "external");
    setActiveIndexStorageRoot(external);
    await fsp.mkdir(path.join(local, "semantic-index"), { recursive: true });
    await fsp.mkdir(path.join(local, "thumbnail-cache"), { recursive: true });
    await fsp.mkdir(path.join(local, "phone-cache", "snapshot"), { recursive: true });
    await fsp.writeFile(path.join(local, "semantic-index", "records.jsonl"), "record\n");
    await fsp.writeFile(path.join(local, "semantic-index", "vectors.bin"), Buffer.from([1, 2, 3]));
    await fsp.writeFile(path.join(local, "thumbnail-cache", "image.jpg"), Buffer.from([4, 5, 6]));
    await fsp.writeFile(path.join(local, "phone-cache", "snapshot", "photo.jpg"), "keep local");
    await fsp.mkdir(external, { recursive: true });

    const migration = await migrateIndexStorageEntries(
      local,
      external,
      ["semantic-index", "thumbnail-cache"],
    );
    assert.deepEqual(migration, { filesVerified: 3, bytesVerified: 13 });
    assert.equal(await fsp.access(path.join(external, "semantic-index", "records.jsonl")).then(() => true), true);
    await assert.rejects(fsp.access(path.join(local, "semantic-index")));
    assert.equal(await fsp.readFile(path.join(local, "phone-cache", "snapshot", "photo.jpg"), "utf8"), "keep local");

    const conflictLocal = path.join(root, "conflict-local");
    const conflictExternal = path.join(root, "conflict-external");
    await fsp.mkdir(path.join(conflictLocal, "semantic-index"), { recursive: true });
    await fsp.mkdir(path.join(conflictExternal, "semantic-index"), { recursive: true });
    await fsp.writeFile(path.join(conflictLocal, "semantic-index", "records.jsonl"), "local version");
    await fsp.writeFile(path.join(conflictExternal, "semantic-index", "records.jsonl"), "different external version");
    await assert.rejects(
      migrateIndexStorageEntries(conflictLocal, conflictExternal, ["semantic-index"]),
      /local original was preserved/,
    );
    assert.equal(await fsp.readFile(path.join(conflictLocal, "semantic-index", "records.jsonl"), "utf8"), "local version");

    assert.equal(
      indexingPathPolicy.isAppDataPath(
        path.join(external, "semantic-index", "records.jsonl"),
        "/source",
        "/source",
        "/app-data",
        "/app-data",
      ),
      true,
    );

    const defaultStoragePath = await readIndexStorageRoot(local);
    assert.equal(defaultStoragePath, local);
    await writeIndexStorageRoot(local, external);
    assert.equal(await readIndexStorageRoot(local), external);

    const configLocal = path.join(root, "config-local");
    const configExternal = path.join(root, "config-external");
    const restoredLocal = path.join(root, "restored-local");
    const restoredExternal = path.join(root, "restored-external");
    const archive = path.join(root, "silo-config.tar.gz");
    await fsp.mkdir(path.join(configExternal, "semantic-index"), { recursive: true });
    await fsp.mkdir(path.join(configLocal, "phone-cache"), { recursive: true });
    await fsp.writeFile(path.join(configExternal, "semantic-index", "records.jsonl"), "external index");
    await fsp.writeFile(path.join(configLocal, "browser-state.json"), "local preferences");
    await fsp.writeFile(path.join(configLocal, "phone-cache", "backup-state.json"), "local backup state");
    await configBundle.exportConfig(configLocal, archive, "test", {}, configExternal);
    await configBundle.stageConfigImport(restoredLocal, archive);
    await configBundle.commitStagedImport(restoredLocal);
    await configBundle.applyPendingImport(restoredLocal, restoredExternal);
    assert.equal(await fsp.readFile(path.join(restoredExternal, "semantic-index", "records.jsonl"), "utf8"), "external index");
    assert.equal(await fsp.readFile(path.join(restoredLocal, "browser-state.json"), "utf8"), "local preferences");
    assert.equal(await fsp.readFile(path.join(restoredLocal, "phone-cache", "backup-state.json"), "utf8"), "local backup state");

    console.log("External index storage migration and config tests passed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
