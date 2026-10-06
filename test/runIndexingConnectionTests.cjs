const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const compile = (s) =>
  ts.transpileModule(s, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
const describeModule = { exports: {} };
new Function(
  "module",
  "exports",
  compile(
    fs.readFileSync(
      path.join(__dirname, "../src/utils/indexingConnection.ts"),
      "utf8",
    ),
  ),
)(describeModule, describeModule.exports);
const describe = describeModule.exports.describeIndexingConnectionError;
assert(
  describe(
    new Error(
      "Error invoking remote method 'get-indexing-overview': Error: No handler registered",
    ),
  ).action.includes("Quit Silo completely"),
);
assert(
  describe(new Error("IPC channel disconnected")).action.includes(
    "interrupted",
  ),
);
assert(
  describe(new Error("Unexpected backend failure")).message.includes(
    "Unexpected",
  ),
);
const source = fs.readFileSync(
  path.join(__dirname, "../src/components/IndexingPanel.tsx"),
  "utf8",
);
const ast = ts.createSourceFile(
  "IndexingPanel.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let effect;
function walk(n) {
  if (ts.isCallExpression(n) && n.expression.getText(ast) === "useEffect")
    effect = n.arguments[0].getText(ast);
  ts.forEachChild(n, walk);
}
walk(ast);
async function run() {
  const timers = new Map();
  let id = 0,
    calls = 0,
    error,
    stages = [{ id: "existing" }],
    attempts = 0;
  const retry = { current: () => {} };
  const window = {
    electron: {
      getIndexingOverview: async () => {
        calls++;
        if (calls <= 12) throw new Error("Temporary backend failure");
        return [{ id: "recovered" }];
      },
    },
    setTimeout: (fn, delay) => {
      timers.set(++id, { fn, delay });
      return id;
    },
    clearTimeout: (key) => timers.delete(key),
  };
  const m = { exports: null };
  new Function(
    "window",
    "setError",
    "setStages",
    "setAttempts",
    "setLastUpdated",
    "setRetrySeconds",
    "retryNow",
    "describeIndexingConnectionError",
    "module",
    compile("module.exports=" + effect),
  )(
    window,
    (v) => {
      error = v;
    },
    (update) => {
      stages = update(stages);
    },
    (v) => {
      attempts = v;
    },
    () => {},
    () => {},
    retry,
    describe,
    m,
  );
  const cleanup = m.exports();
  await new Promise(setImmediate);
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(
      stages,
      [{ id: "existing" }],
      "retain last known progress through failures",
    );
    assert(error.message.includes("Temporary backend failure"));
    const [key, timer] = [...timers.entries()][0];
    assert(timer.delay <= 30000);
    timers.delete(key);
    await timer.fn();
    await new Promise(setImmediate);
  }
  assert.equal(calls, 13, "no retry-attempt limit");
  assert.equal(error, null);
  assert.equal(attempts, 0);
  assert.deepEqual(stages, [{ id: "recovered" }]);
  cleanup();
  assert.equal(timers.size, 0);
  console.log(
    "Indexing connection tests passed: actionable errors, persistent retries beyond 12 failures, bounded backoff, stale progress retention, automatic recovery, and cleanup.",
  );
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
