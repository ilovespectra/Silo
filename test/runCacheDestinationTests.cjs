/* Run with `node test/runCacheDestinationTests.cjs`. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/cacheDestinations.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: true,
  },
}).outputText;
const implementation = { exports: {} };
new Function("require", "module", "exports", compiled)(require, implementation, implementation.exports);
const cache = implementation.exports;
const temporaryRoot = process.env.SILO_TEST_TMPDIR || os.tmpdir();

async function fixture(t) {
  await fsp.mkdir(temporaryRoot, { recursive: true });
  const root = await fsp.mkdtemp(path.join(temporaryRoot, "silo-cache-destinations-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "user-data");
  const sourceRoot = path.join(root, "source");
  const destinationRoot = path.join(root, "destination");
  await Promise.all([
    fsp.mkdir(userData, { recursive: true }),
    fsp.mkdir(sourceRoot, { recursive: true }),
    fsp.mkdir(destinationRoot, { recursive: true }),
  ]);
  return { root, userData, sourceRoot, destinationRoot };
}

test("destination settings round-trip every cache root and reject malformed roots", async t => {
  const f = await fixture(t);
  const roots = Object.fromEntries(cache.CACHE_DESTINATIONS.map(item => [item.id, f.destinationRoot]));
  await cache.writeCacheDestinationRoots(f.userData, roots);
  assert.deepEqual(await cache.readCacheDestinationRoots(f.userData), roots);
  assert.deepEqual(cache.readCacheDestinationRootsSync(f.userData), roots);
  await assert.rejects(
    cache.writeCacheDestinationRoots(f.userData, { ...roots, "semantic-index": "relative-cache" }),
    /absolute folder/,
  );
});

test("existing default profiles retain their current cache location", async t => {
  const f = await fixture(t);
  assert.equal(await cache.hasExistingDefaultCacheProfile(f.userData), false,
    "a fresh profile still needs first-run cache setup");
  await fsp.mkdir(path.join(f.userData, "Cache"), { recursive: true });
  assert.equal(await cache.hasExistingDefaultCacheProfile(f.userData), false,
    "Chromium's fresh-profile cache alone is not an existing Silo profile");
  await fsp.writeFile(path.join(f.userData, "browser-state.json"), "{}", "utf8");
  assert.equal(await cache.hasExistingDefaultCacheProfile(f.userData), true,
    "a saved Silo profile skips the first-run setup prompt");
});

test("Windows path joining and removable-drive detection use Windows semantics", () => {
  const win = path.win32;
  const roots = { "semantic-index": "E:\\SiloCache" };
  assert.equal(
    cache.getCacheEntryPathForPlatform("semantic-index", roots, "C:\\Users\\Jacqueline\\Silo", ["records.jsonl"], win),
    "E:\\SiloCache\\semantic-index\\records.jsonl",
  );
  assert.equal(cache.isProbablyRemovablePath("E:\\SiloCache", "C:\\Users\\Jacqueline\\Silo", "win32", win), true);
  assert.equal(cache.isProbablyRemovablePath("C:\\Users\\Jacqueline\\SiloCache", "C:\\Users\\Jacqueline\\Silo", "win32", win), false);
  assert.equal(cache.isProbablyRemovablePath("/Volumes/Archive", "/Users/Jacqueline/Silo", "darwin"), true);
});

test("verified cache copies preserve originals and reject conflicting or unsafe entries", async t => {
  const f = await fixture(t);
  const entry = "semantic-index";
  const sourceEntry = path.join(f.sourceRoot, entry);
  await fsp.mkdir(path.join(sourceEntry, "nested"), { recursive: true });
  await fsp.writeFile(path.join(sourceEntry, "nested", "records.jsonl"), '{"path":"photo.jpg"}\n');
  await fsp.writeFile(path.join(sourceEntry, "vectors.bin"), Buffer.from([1, 3, 3, 7]));

  const copied = await cache.copyCacheEntryVerified(entry, f.sourceRoot, f.destinationRoot, f.userData);
  const targetEntry = path.join(f.destinationRoot, entry);
  assert.equal(copied.copied, true);
  assert.equal(await fsp.readFile(path.join(targetEntry, "nested", "records.jsonl"), "utf8"), '{"path":"photo.jpg"}\n');
  assert.deepEqual(await fsp.readFile(path.join(targetEntry, "vectors.bin")), Buffer.from([1, 3, 3, 7]));
  assert.equal(await fsp.readFile(path.join(sourceEntry, "vectors.bin")).then(data => data.length), 4,
    "the source cache remains in place after the verified copy");

  const repeated = await cache.copyCacheEntryVerified(entry, f.sourceRoot, f.destinationRoot, f.userData);
  assert.equal(repeated.copied, false, "an identical destination is kept without recopying");
  await fsp.writeFile(path.join(targetEntry, "vectors.bin"), "different");
  await assert.rejects(
    cache.copyCacheEntryVerified(entry, f.sourceRoot, f.destinationRoot, f.userData),
    /Both copies were preserved/,
  );
  assert.equal(await fsp.readFile(path.join(sourceEntry, "vectors.bin")).then(data => data.length), 4);
  await assert.rejects(cache.copyCacheEntryVerified("not-a-cache", f.sourceRoot, f.destinationRoot, f.userData), /Unknown/);

  const linkRoot = path.join(f.sourceRoot, "thumbnail-cache");
  await fsp.mkdir(linkRoot, { recursive: true });
  await fsp.symlink(path.join(sourceEntry, "vectors.bin"), path.join(linkRoot, "unsafe-link"));
  await assert.rejects(
    cache.copyCacheEntryVerified("thumbnail-cache", f.sourceRoot, f.destinationRoot, f.userData),
    /symbolic links/,
  );
});

test("cache destination validation excludes the app profile", async t => {
  const f = await fixture(t);
  await assert.rejects(cache.inspectCacheDestination(f.userData, f.userData), /outside Silo's app profile/);
  await assert.rejects(cache.inspectCacheDestination(path.join(f.userData, "nested"), f.userData), /outside Silo's app profile/);
  const accepted = await cache.inspectCacheDestination(f.destinationRoot, f.userData);
  assert.equal(accepted.path, f.destinationRoot);
});
