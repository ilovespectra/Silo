/* Images the decoder rejects are parked until they change instead of being re-decoded every pass. */
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
const { SemanticIndexer, isPermanentImageFailure } = require("../src/semanticIndexer.ts");

async function run() {
  assert.ok(isPermanentImageFailure("Input file contains unsupported image format"));
  assert.ok(isPermanentImageFailure(
    "Input file contains unsupported image format (macOS fallback: This file could not be read as an image; it may be damaged or have the wrong extension.)",
  ));
  assert.ok(isPermanentImageFailure("VipsJpeg: Premature end of input file"));
  assert.ok(!isPermanentImageFailure("ENOENT: no such file or directory"));
  assert.ok(!isPermanentImageFailure("Semantic worker request timed out."));
  assert.ok(!isPermanentImageFailure(undefined));

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-undecodable-"));
  const userData = path.join(temp, "silo-data");
  const library = path.join(temp, "library");
  try {
    await fsp.mkdir(path.join(userData, "semantic-index"), { recursive: true });
    await fsp.mkdir(library, { recursive: true });
    const indexer = new SemanticIndexer(userData, "", async () => {}, () => {}, () => {});
    await indexer.initialize();
    const file = (name) => ({ path: path.join(library, name), name, relativePath: name,
      size: 1, modified: 1, isDirectory: false, type: "image", extension: ".jpg" });
    await indexer.appendFailure(file("bad.jpg"), library, "Input file contains unsupported image format");
    await indexer.appendFailure(file("offline.jpg"), library, "EIO: i/o error, read");
    const retryable = Array.from(indexer.getRetryableFiles([library]).keys()).map((p) => path.basename(p));
    assert.deepEqual(retryable, ["offline.jpg"], "only transient failures are retried automatically");
    console.log("Undecodable image tests passed: decoder rejections parked, transient failures still retried.");
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
