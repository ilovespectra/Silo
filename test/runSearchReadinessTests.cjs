"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/searchReadiness.ts");
const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const loaded = { exports: {} };
new Function("exports", "module", output)(loaded.exports, loaded);
const { prepareSearchReadiness } = loaded.exports;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const records = deferred();
  const model = deferred();
  const fastIndex = deferred();
  const events = [];
  let ready = false;
  let buildStarted = false;

  const preparation = prepareSearchReadiness({
    savedRecordsReady: records.promise,
    modelReady: model.promise,
    storageAvailable: true,
    onWaitingForModel: () => events.push("records-ready"),
    onPreparingVectorSearch: () => events.push("model-ready"),
    prepareVectorSearch: () => {
      events.push("building-fast-index");
      buildStarted = true;
      return fastIndex.promise;
    },
  }).then(() => { ready = true; });

  await flushMicrotasks();
  assert.deepEqual(events, [], "readiness waits for saved records");
  records.resolve();
  await flushMicrotasks();
  assert.deepEqual(events, ["records-ready"], "model warm-up follows saved records");
  assert.equal(buildStarted, false, "fast search index is not built before the model is ready");

  model.resolve();
  await flushMicrotasks();
  assert.deepEqual(events, ["records-ready", "model-ready", "building-fast-index"]);
  assert.equal(ready, false, "search is not ready while the fast index is building");
  fastIndex.resolve();
  await preparation;
  assert.equal(ready, true, "search readiness resolves only after index preparation");

  let unavailableModelWaited = false;
  await prepareSearchReadiness({
    savedRecordsReady: Promise.resolve(),
    modelReady: new Promise((resolve) => setTimeout(() => {
      unavailableModelWaited = true;
      resolve();
    }, 100)),
    storageAvailable: false,
    onWaitingForModel: () => assert.fail("unavailable storage must not warm the model"),
    onPreparingVectorSearch: () => assert.fail("unavailable storage must not prepare search"),
    prepareVectorSearch: async () => assert.fail("unavailable storage must not build the index"),
  });
  assert.equal(unavailableModelWaited, false, "unavailable storage does not block startup on search work");

  console.log("Search readiness tests passed: saved records, model, and fast index gate ready state.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
