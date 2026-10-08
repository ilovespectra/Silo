const assert = require("assert");
const fs = require("fs");
const fsPromises = require("fs/promises");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(__dirname, "../../..");
const tempRoot = path.join(workspaceRoot, "tmp", `silo-config-restore-${process.pid}`);

function loadTypeScript(filePath) {
  const resolved = `${filePath}.ts`;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  const source = fs.readFileSync(resolved, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  loaded._compile(output, resolved);
  return loaded.exports;
}

function writeFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function seedReadyImport(userData, entries) {
  const importStage = path.join(userData, ".config-import-staging");
  for (const [relativePath, contents] of Object.entries(entries))
    writeFile(importStage, relativePath, contents);
  fs.writeFileSync(path.join(userData, ".config-import-ready"), "ready");
  return importStage;
}

async function main() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  const { applyPendingImport } = loadTypeScript(path.join(repoRoot, "src/configBundle"));
  const userData = path.join(tempRoot, "user-data");
  const indexRoot = path.join(tempRoot, "external-index");
  const importStage = seedReadyImport(userData, {
    "semantic-index/records.jsonl": "imported verified records\n",
  });
  const targetFile = writeFile(indexRoot, "semantic-index/records.jsonl", "existing records\n");

  const originalRename = fsPromises.rename;
  let attemptedCrossVolumeRename = false;
  fsPromises.rename = async (source, target) => {
    if (path.resolve(source).startsWith(`${path.resolve(importStage)}${path.sep}`) &&
        path.resolve(target).startsWith(`${path.resolve(indexRoot)}${path.sep}`)) {
      attemptedCrossVolumeRename = true;
      throw Object.assign(new Error("simulated cross-device rename"), { code: "EXDEV" });
    }
    return originalRename(source, target);
  };
  try {
    assert.equal(await applyPendingImport(userData, indexRoot), true);
  } finally {
    fsPromises.rename = originalRename;
  }
  assert.equal(attemptedCrossVolumeRename, false, "restore copies to destination-volume staging instead of renaming across volumes");
  assert.equal(fs.readFileSync(targetFile, "utf8"), "imported verified records\n");
  assert.equal(fs.existsSync(importStage), false, "successful import staging is cleaned up");

  const safetyTarget = writeFile(indexRoot, "content-safety-index.json", "previous safety data\n");
  const retryStage = seedReadyImport(userData, {
    "content-safety-index.json": "imported safety data\n",
    "semantic-index/records.jsonl": "second import\n",
  });
  const originalCopy = fsPromises.cp;
  fsPromises.cp = async (source, destination, options) => {
    if (path.basename(source) === "semantic-index")
      throw Object.assign(new Error("simulated copy failure"), { code: "EIO" });
    return originalCopy(source, destination, options);
  };
  try {
    await assert.rejects(applyPendingImport(userData, indexRoot), /simulated copy failure/);
  } finally {
    fsPromises.cp = originalCopy;
  }
  assert.equal(fs.readFileSync(targetFile, "utf8"), "imported verified records\n", "a later copy failure rolls back earlier target replacements");
  assert.equal(fs.readFileSync(safetyTarget, "utf8"), "previous safety data\n", "the failing target remains intact");
  assert.equal(fs.readFileSync(path.join(retryStage, "semantic-index/records.jsonl"), "utf8"), "second import\n", "failed restore retains its index import");
  assert.equal(fs.readFileSync(path.join(retryStage, "content-safety-index.json"), "utf8"), "imported safety data\n", "failed restore retains every staged entry");
  assert.equal(fs.existsSync(path.join(userData, ".config-import-ready")), true, "failed restore remains retryable");

  const originalCopyAgain = fsPromises.cp;
  const originalRenameAgain = fsPromises.rename;
  fsPromises.cp = originalCopyAgain;
  fsPromises.rename = async (source, target) => {
    if (path.basename(source).startsWith(".silo-restore-stage-") && path.resolve(target) === path.resolve(path.join(indexRoot, "semantic-index")))
      throw Object.assign(new Error("simulated destination commit failure"), { code: "EIO" });
    return originalRenameAgain(source, target);
  };
  try {
    await assert.rejects(applyPendingImport(userData, indexRoot), /simulated destination commit failure/);
  } finally {
    fsPromises.rename = originalRenameAgain;
    fsPromises.cp = originalCopyAgain;
  }
  assert.equal(fs.readFileSync(safetyTarget, "utf8"), "previous safety data\n", "a later commit failure restores earlier targets");
  assert.equal(fs.readFileSync(targetFile, "utf8"), "imported verified records\n", "the previous index remains usable after rollback");
  assert.equal(fs.readFileSync(path.join(retryStage, "semantic-index/records.jsonl"), "utf8"), "second import\n", "a commit failure keeps the import available for retry");
  assert.equal(fs.existsSync(path.join(userData, ".config-import-ready")), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log("Config bundle restore staging, verification, rollback, and retry tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
