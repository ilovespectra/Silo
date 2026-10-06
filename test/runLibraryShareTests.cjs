const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText, filename);
};

const { openIndexedShareFile } = require("../src/indexedShareResolver.ts");
const { LibraryShareServer, isValidShareSubnet } = require("../src/libraryShareServer.ts");

async function recordFor(root, relativePath, type = "image") {
  const filePath = path.join(root, relativePath);
  const stats = await fsp.stat(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    relativePath,
    size: stats.size,
    modified: stats.mtimeMs,
    type,
    extension: path.extname(filePath),
  };
}

async function expectReject(promise, message) {
  await assert.rejects(promise, message);
}

async function run() {
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "silo-library-share-"));
  const libraryRoot = path.join(temporaryRoot, "Library");
  const outsideRoot = path.join(temporaryRoot, "Outside");
  await fsp.mkdir(path.join(libraryRoot, "Trips"), { recursive: true });
  await fsp.mkdir(outsideRoot, { recursive: true });
  await fsp.writeFile(path.join(libraryRoot, "photo.jpg"), "photo-bytes");
  await fsp.writeFile(path.join(libraryRoot, "Trips", "walk.jpg"), "trip-bytes");
  await fsp.writeFile(path.join(libraryRoot, "clip.mp4"), "video-bytes");
  await fsp.writeFile(path.join(outsideRoot, "private.jpg"), "private-bytes");

  try {
    const canonicalRoot = await fsp.realpath(libraryRoot);
    const rootStats = await fsp.stat(canonicalRoot);
    const rootIdentity = { device: rootStats.dev, inode: rootStats.ino };
    const photo = await recordFor(libraryRoot, "photo.jpg");
    const opened = await openIndexedShareFile(libraryRoot, canonicalRoot, photo, rootIdentity);
    assert.equal((await opened.handle.readFile()).toString(), "photo-bytes");
    await opened.handle.close();

    await expectReject(openIndexedShareFile(libraryRoot, canonicalRoot, {
      ...photo,
      path: path.join(temporaryRoot, "private.jpg"),
      relativePath: "../private.jpg",
    }, rootIdentity), /safe relative file/);

    const linkPath = path.join(libraryRoot, "escape.jpg");
    await fsp.symlink(path.join(outsideRoot, "private.jpg"), linkPath);
    const escaped = await recordFor(libraryRoot, "escape.jpg");
    await expectReject(openIndexedShareFile(libraryRoot, canonicalRoot, escaped, rootIdentity), /outside the selected source/);

    await fsp.writeFile(path.join(libraryRoot, "photo.jpg"), "changed-size");
    await expectReject(openIndexedShareFile(libraryRoot, canonicalRoot, photo, rootIdentity), /changed since/);

    const records = [
      await recordFor(libraryRoot, "photo.jpg"),
      await recordFor(libraryRoot, "Trips/walk.jpg"),
      await recordFor(libraryRoot, "clip.mp4", "video"),
    ];
    const sources = [{ id: libraryRoot, label: "Library", rootPath: libraryRoot, kind: "local", available: true }];
    const server = new LibraryShareServer({
      getSources: async () => sources,
      getIndexedFiles: (roots) => roots.includes(libraryRoot) ? records : [],
      search: async (query) => records.filter((record) => record.name.toLowerCase().includes(query.toLowerCase())),
      getThumbnail: async () => Buffer.from("thumbnail"),
      networkInterface: { address: "127.0.0.1", netmask: "255.0.0.0" },
    });
    const status = await server.start([libraryRoot]);
    assert.equal(status.active, true);
    assert.equal(isValidShareSubnet("127.0.0.1", { address: "127.0.0.1", netmask: "255.0.0.0" }), true);
    assert.equal(isValidShareSubnet("192.168.1.5", { address: "127.0.0.1", netmask: "255.0.0.0" }), false);

    const pageResponse = await fetch(status.url);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /viewport/);
    assert.match(page, /Save all/);
    assert.equal(page.includes(temporaryRoot), false, "the share page does not expose local paths");
    const pageScript = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(pageScript, "mobile page includes its browser app script");
    new vm.Script(pageScript);

    const token = new URL(status.url).pathname.split("/").at(-1);
    const apiRoot = new URL(`/api/${token}`, status.url);
    const sourceResponse = await fetch(new URL(`${apiRoot.pathname}/sources`, status.url));
    const sourcePayload = await sourceResponse.json();
    const publicSource = sourcePayload.sources[0];
    const itemResponse = await fetch(new URL(`${apiRoot.pathname}/items?source=${publicSource.id}`, status.url));
    const itemPayload = await itemResponse.json();
    const topPhoto = itemPayload.items.find((item) => item.kind === "file" && item.name === "photo.jpg");
    assert.ok(topPhoto);
    assert.ok(itemPayload.items.some((item) => item.kind === "folder" && item.name === "Trips"));
    assert.equal(JSON.stringify(itemPayload).includes(libraryRoot), false);

    const searchResponse = await fetch(new URL(`${apiRoot.pathname}/items?source=${publicSource.id}&q=walk`, status.url));
    const searchPayload = await searchResponse.json();
    assert.ok(searchPayload.items.some((item) => item.name === "walk.jpg"));

    const rangeResponse = await fetch(new URL(`${apiRoot.pathname}/media/${topPhoto.id}`, status.url), {
      headers: { range: "bytes=1-3" },
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(await rangeResponse.text(), "han");

    const thumbnailResponse = await fetch(new URL(`${apiRoot.pathname}/thumb/${topPhoto.id}`, status.url));
    assert.equal(await thumbnailResponse.text(), "thumbnail");

    const archiveResponse = await fetch(new URL(`${apiRoot.pathname}/download`, status.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ items: JSON.stringify([topPhoto.id]), all: "0" }),
    });
    assert.equal(archiveResponse.status, 200);
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    assert.equal(archive.subarray(0, 2).toString(), "PK");
    assert.equal(archive.subarray(-22, -18).toString(), "PK\x05\x06");

    const allArchiveResponse = await fetch(new URL(`${apiRoot.pathname}/download`, status.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ items: "[]", all: "1" }),
    });
    assert.equal(allArchiveResponse.status, 200);
    const allArchive = Buffer.from(await allArchiveResponse.arrayBuffer());
    assert.ok(allArchive.length > archive.length, "save all streams all selected-source media into an archive");

    await server.stop();
    assert.equal(server.getStatus().active, false);
    await assert.rejects(fetch(status.url));

    const remountedRoot = `${libraryRoot}-remounted`;
    await fsp.rename(libraryRoot, remountedRoot);
    await fsp.mkdir(libraryRoot, { recursive: true });
    await fsp.writeFile(path.join(libraryRoot, "photo.jpg"), "changed-size");
    const oldRecord = await recordFor(libraryRoot, "photo.jpg");
    await expectReject(openIndexedShareFile(libraryRoot, canonicalRoot, oldRecord, rootIdentity), /different volume is mounted/);

    console.log("Library share tests passed.");
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
