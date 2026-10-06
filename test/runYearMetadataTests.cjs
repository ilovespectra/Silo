const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { StateStore } = require("../electron-dist/stateStore");

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "silo-year-test-"));
  try {
    const store = new StateStore(directory);
    await store.initialize();
    let state = await store.updateFileMetadata(["a.jpg", "b.jpg"], {
      year: 2003,
    });
    assert.equal(state.fileMetadata["a.jpg"].year, 2003);
    assert.equal(state.fileMetadata["b.jpg"].year, 2003);
    await store.updateFileMetadata(["a.jpg"], { keywords: ["family"] });
    const restarted = new StateStore(directory);
    await restarted.initialize();
    assert.equal(restarted.getState().fileMetadata["a.jpg"].year, 2003);
    for (const year of [0, 10000, 2003.5, NaN, "2003"])
      await assert.rejects(
        restarted.updateFileMetadata(["a.jpg"], { year }),
        /year between/,
      );
    assert.equal(restarted.getState().fileMetadata["a.jpg"].year, 2003);
    state = await restarted.updateFileMetadata(["a.jpg", "b.jpg"], {
      year: null,
    });
    assert.deepEqual(state.fileMetadata["a.jpg"].keywords, ["family"]);
    assert.equal(state.fileMetadata["a.jpg"].year, undefined);
    assert.equal(state.fileMetadata["b.jpg"], undefined);
    const ts = require("typescript");
    const text = await fs.readFile(
      path.join(__dirname, "../src/App.tsx"),
      "utf8",
    );
    const ast = ts.createSourceFile(
      "App.tsx",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let fn;
    ts.forEachChild(ast, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "modifiedYear")
        fn = node.getText(ast);
    });
    const code = ts.transpileModule(fn + "\nmodule.exports=modifiedYear;", {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
    const module = { exports: {} };
    new Function("module", code)(module);
    assert.equal(module.exports({ modified: 0, year: 2003 }), "2003");
    assert.equal(module.exports({ modified: 0 }), "Unknown year");
    assert.equal(
      module.exports({ modified: new Date(1970, 5, 1).getTime(), year: 2001 }),
      "2001",
    );
    console.log(
      "Year metadata tests passed: bulk edit, restart persistence, validation, reset, preserved keywords, and epoch-date override.",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
