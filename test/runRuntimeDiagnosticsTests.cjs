const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-runtime-log-"));
  const diagnosticsPath = path.join(root, "runtime.jsonl");
  try {
    const source = fs.readFileSync(path.join(__dirname, "../src/main.ts"), "utf8");
    const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
    let functionSource = "";
    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "readRuntimeDiagnostics")
        functionSource = node.getText(ast);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(functionSource);
    const compiled = ts.transpileModule(functionSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const context = vm.createContext({ fsPromises: fsp, diagnosticsPath, Buffer, Number, Math, JSON, String });
    const read = vm.runInContext(`(${compiled})`, context);

    const oldLines = Array.from({ length: 700 }, (_, index) => JSON.stringify({ time: new Date(index).toISOString(), event: `event-${index}`, detail: "x".repeat(180) })).join("\n") + "\n";
    await fsp.writeFile(diagnosticsPath, oldLines);
    const first = await read(0);
    assert.equal(first.entries.length, 250);
    assert.equal(first.entries[0].event, "event-450");
    assert.equal(first.entries.at(-1).event, "event-699");
    assert.equal(first.truncated, true);

    await fsp.appendFile(diagnosticsPath, `${JSON.stringify({ time: new Date().toISOString(), event: "new-event" })}\n`);
    const incremental = await read(first.cursor);
    assert.deepEqual(Array.from(incremental.entries, (entry) => entry.event), ["new-event"]);
    assert.equal(incremental.truncated, false);

    await fsp.writeFile(diagnosticsPath, `${JSON.stringify({ event: "rotated-log" })}\n`);
    const rotated = await read(incremental.cursor);
    assert.equal(rotated.entries[0].event, "rotated-log");
    assert.equal(rotated.truncated, true);
    console.log("Runtime diagnostics tests passed: bounded tail, complete-line cursoring, incremental reads, and log rotation recovery.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
