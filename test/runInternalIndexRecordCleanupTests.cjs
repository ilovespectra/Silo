const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};
const { SemanticIndexer } = require("../src/semanticIndexer.ts");

async function run() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-index-cleanup-"));
  const userData = path.join(temp, "silo-data");
  const internalFile = path.join(userData, "phone-cache", "photo.jpg");
  const cloneRoot = path.join(temp, "Silo Source Clone old");
  const cloneFile = path.join(cloneRoot, "image.jpg");
  const indexDirectory = path.join(userData, "semantic-index");
  try {
    await fsp.mkdir(path.dirname(internalFile), { recursive: true });
    await fsp.mkdir(indexDirectory, { recursive: true });
    await fsp.writeFile(internalFile, "private cache photo");
    await fsp.mkdir(cloneRoot, { recursive: true });
    await fsp.writeFile(path.join(cloneRoot, "silo-clone-manifest.json"), JSON.stringify({ format: "silo-source-clone", version: 1 }));
    await fsp.writeFile(cloneFile, "previous clone image");
    const legacyRecords = [internalFile, cloneFile].map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      sourcePath: temp,
      relativePath: path.relative(temp, filePath),
      size: 18,
      modified: 100,
      type: "image",
      extension: ".jpg",
      signature: "18:100",
      vectorOffset: -1,
      error: "legacy derived record",
    }));
    await fsp.writeFile(path.join(indexDirectory, "records.jsonl"), `${legacyRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const indexer = new SemanticIndexer(userData, "", async () => {}, () => {});
    await indexer.initialize();
    assert.deepEqual(indexer.getIndexedFiles([temp]), []);
    assert.deepEqual(indexer.getIndexedImages([temp]), []);
    assert.equal(indexer.getIndexSummary([temp]).total, 0);
    const lines = (await fsp.readFile(path.join(indexDirectory, "records.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.filter((line) => JSON.parse(line).deleted).length, 2, "legacy app-data and shelter-clone records are tombstoned durably");
    console.log("Internal index cleanup tests passed: app-data cache records are excluded from semantic totals/results and durably pruned.");
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
