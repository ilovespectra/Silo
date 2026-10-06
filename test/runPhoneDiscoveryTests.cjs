const assert = require("assert");
const { PhoneManager } = require("../electron-dist/phoneManager");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
async function run() {
  const manager = new PhoneManager("/tmp/silo-discovery-test");
  manager.log = () => {};
  const order = [];
  let release;
  const active = manager.queueRun(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const transfer = manager.queueRun(async () => {
    order.push("transfer");
  });
  const discovery = manager.queueRun(async () => {
    order.push("discovery");
  }, true);
  release();
  await Promise.all([active, transfer, discovery]);
  assert.deepEqual(order, ["discovery", "transfer"]);
  const source = fs.readFileSync(
    path.join(__dirname, "../src/main.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "main.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let fn;
  ts.forEachChild(ast, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "discoverAndBackupPhones"
    )
      fn = node.getText(ast);
  });
  const code = ts.transpileModule(
    `let phoneDiscoveryPromise=null;let scannedPhoneDevices=[];${fn}\nmodule.exports=discoverAndBackupPhones`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText;
  let listed = [
    {
      id: "test",
      platform: "android",
      name: "Saga",
      status: "unauthorized",
      rootPath: null,
    },
  ];
  const events = [],
    indexed = [],
    backups = [];
  const m = { exports: null };
  new Function(
    "phoneManager",
    "indexNewSources",
    "refreshAudioInventory",
    "scheduleThumbnailPregeneration",
    "runtimeLog",
    "rendererReady",
    "mainWindow",
    "seenReadyPhoneKeys",
    "getEnabledIndexSources",
    "console",
    "module",
    code,
  )(
    {
      listDevices: async () => listed,
      getBackupStates: () => [],
      backupDevice: async (device) => {
        backups.push(device.id);
        return {
          deviceId: device.id,
          platform: device.platform,
          status: "complete",
          completedFiles: 0,
          totalFiles: 0,
        };
      },
    },
    async (paths) => indexed.push(...paths),
    async () => {},
    () => {},
    () => {},
    true,
    {
      webContents: {
        isDestroyed: () => false,
        send: (channel, devices) => events.push(devices),
      },
    },
    new Set(),
    async () => [],
    { log: () => {}, error: () => {} },
    m,
  );
  await m.exports();
  assert.equal(
    indexed.length,
    0,
    "untrusted phones do not start source indexing",
  );
  listed = [
    {
      ...listed[0],
      status: "ready",
      rootPath: "/__phone__/android/test/sdcard",
    },
  ];
  await m.exports();
  assert.equal(
    indexed.length,
    1,
    "authorization automatically starts indexing without Messages",
  );
  const notificationCount = events.length;
  await m.exports();
  assert.equal(
    indexed.length,
    1,
    "unchanged ready device does not restart indexing",
  );
  assert.equal(
    events.length,
    notificationCount,
    "unchanged scans do not churn renderer",
  );
  listed = [];
  await m.exports();
  assert.deepEqual(events.at(-1), [], "disconnect updates the source list");
  console.log(
    "Phone discovery tests passed: priority queue, automatic authorization/source indexing, unchanged-event suppression, and disconnect notifications.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
