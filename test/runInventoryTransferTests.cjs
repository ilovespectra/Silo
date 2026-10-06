const assert = require("assert");
const { InventoryTransfers } = require("../electron-dist/inventoryTransfer");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
async function run() {
  const files = Array.from({ length: 30000 }, (_, i) => ({
    path: `/${i}`,
    name: "x".repeat(800),
    size: i,
  }));
  const transfers = new InventoryTransfers();
  const reference = transfers.create(files, 1);
  assert(
    Buffer.byteLength(JSON.stringify(reference)) < 200,
    "large inventories return a tiny reference",
  );
  let offset = 0,
    pages = 0;
  while (offset < files.length) {
    const page = transfers.read(reference.inventoryToken, offset, 1);
    assert(page.items.length <= 1000);
    assert(Buffer.byteLength(JSON.stringify(page)) < 530000);
    assert(page.nextOffset > offset);
    offset = page.nextOffset;
    pages++;
  }
  assert(pages > 30);
  assert.throws(
    () => transfers.read(reference.inventoryToken, 0, 2),
    /unavailable/,
  );
  assert.throws(
    () => transfers.read(reference.inventoryToken, -1, 1),
    /Invalid/,
  );
  const text = fs.readFileSync(
    path.join(__dirname, "../src/utils/readInventory.ts"),
    "utf8",
  );
  const code = ts.transpileModule(text, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const m = { exports: {} };
  new Function("module", "exports", "window", code)(m, m.exports, {
    setTimeout: (fn) => {
      fn();
      return 0;
    },
  });
  const api = {
    readInventoryPage: async (token, start) => transfers.read(token, start, 1),
    releaseInventory: async (token) => transfers.release(token, 1),
  };
  const result = await m.exports.readInventory(api, reference);
  assert.deepEqual(result, files, "paged transfer retains all files");
  assert.throws(
    () => transfers.read(reference.inventoryToken, 0, 1),
    /expired/,
  );
  const cancelled = transfers.create(files, 1);
  assert.deepEqual(
    await m.exports.readInventory(api, cancelled, () => true),
    [],
  );
  assert.throws(
    () => transfers.read(cancelled.inventoryToken, 0, 1),
    /expired/,
  );
  const owned = transfers.create(files, 1);
  transfers.releaseOwner(1);
  assert.throws(() => transfers.read(owned.inventoryToken, 0, 1), /expired/);
  const abandoned = transfers.create(files, 1);
  for (let i = 0; i < 4; i++) transfers.create(files, 1);
  assert.throws(
    () => transfers.read(abandoned.inventoryToken, 0, 1),
    /expired/,
    "replaced requests cannot accumulate unbounded inventories",
  );
  let now = 0;
  const timed = new InventoryTransfers(() => now);
  const expired = timed.create(files, 1);
  now = 600001;
  timed.expire();
  assert.throws(() => timed.read(expired.inventoryToken, 0, 1), /expired/);
  let loads = 0,
    releaseLoad;
  const audioApi = {
    ...api,
    getAudioLibraryCache: () => {
      loads++;
      return new Promise((resolve) => {
        releaseLoad = () =>
          resolve({ files: [], sourceIds: [], extensions: [] });
      });
    },
  };
  const firstLoad = m.exports.loadAudioInventory(audioApi);
  const secondLoad = m.exports.loadAudioInventory(audioApi);
  assert.strictEqual(
    firstLoad,
    secondLoad,
    "simultaneous audio reads join one load",
  );
  assert.equal(loads, 1);
  releaseLoad();
  await firstLoad;
  console.log(
    "Inventory transfer tests passed: 30,000 files, bounded bytes/items, complete hydration, ownership protection, cancellation cleanup, and renderer shutdown cleanup.",
  );
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
