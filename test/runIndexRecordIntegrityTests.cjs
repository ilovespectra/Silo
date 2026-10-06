/* The record log survives torn writes: later records still load, vectors are never truncated away. */
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
const VECTOR_BYTES = 512 * 4;

async function run() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-record-integrity-"));
  const userData = path.join(temp, "silo-data");
  const library = path.join(temp, "library");
  const indexDirectory = path.join(userData, "semantic-index");
  try {
    await fsp.mkdir(indexDirectory, { recursive: true });
    await fsp.mkdir(library, { recursive: true });
    const record = (name, vectorOffset) => JSON.stringify({
      path: path.join(library, name), name, sourcePath: library, relativePath: name,
      size: 1, modified: 1, type: "image", extension: ".jpg", signature: "1:1", vectorOffset,
    });
    const lines = [
      record("a.jpg", 0),
      // Torn write from a killed process with the next record glued on.
      `{"path":"${library}/torn${record("b.jpg", VECTOR_BYTES)}`,
      record("c.jpg", 2 * VECTOR_BYTES),
      // A later writer reused c's offset after a bad truncation: the later claim wins.
      record("d.jpg", 2 * VECTOR_BYTES),
      // Vector lost to truncation: dropped so it re-embeds once.
      record("e.jpg", 10 * VECTOR_BYTES),
    ];
    await fsp.writeFile(path.join(indexDirectory, "records.jsonl"), `${lines.join("\n")}\n{"path":"partial`);
    // Three whole vectors plus a torn trailing fragment.
    await fsp.writeFile(path.join(indexDirectory, "vectors.bin"), Buffer.alloc(3 * VECTOR_BYTES + 100));
    const diagnostics = [];
    const indexer = new SemanticIndexer(userData, "", async () => {}, () => {}, (event, data) => diagnostics.push([event, data]));
    await indexer.initialize();
    const names = indexer.getIndexedImages([library]).map((file) => file.name).sort();
    assert.deepEqual(names, ["a.jpg", "b.jpg", "d.jpg"]);
    assert.equal((await fsp.stat(path.join(indexDirectory, "vectors.bin"))).size, 3 * VECTOR_BYTES,
      "only the torn trailing vector is trimmed");
    assert.ok(diagnostics.some(([event]) => event === "semantic-records-corrupt-lines-skipped"));
    assert.ok(diagnostics.some(([event, data]) => event === "semantic-records-missing-vectors" && data.records === 1));
    // The next append starts on its own line instead of extending the partial one.
    await indexer.appendFailure({ path: path.join(library, "f.jpg"), name: "f.jpg", relativePath: "f.jpg",
      size: 1, modified: 1, isDirectory: false, type: "image", extension: ".jpg" }, library, "test");
    const tail = (await fsp.readFile(path.join(indexDirectory, "records.jsonl"), "utf8")).trim().split("\n").pop();
    assert.equal(JSON.parse(tail).name, "f.jpg");
    console.log("Index record integrity tests passed: torn lines skipped, glued records salvaged, offset collisions resolved, vectors preserved.");
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
