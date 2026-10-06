const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { DuplicateManager } = require("../electron-dist/duplicateManager");

async function run() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "silo-duplicate-source-"),
  );
  try {
    const a = path.join(root, "drive-a"),
      b = path.join(root, "drive-b");
    const cache = path.join(root, "cache");
    const files = [];
    async function add(p, text = "same content") {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, text);
      const stats = await fs.stat(p);
      const file = {
        name: path.basename(p),
        path: p,
        relativePath: p,
        size: stats.size,
        modified: stats.mtimeMs,
        type: "document",
        extension: ".txt",
        isDirectory: false,
      };
      files.push(file);
      return file;
    }
    const a1 = await add(path.join(a, "one", "original.txt"));
    const a2 = await add(path.join(a, "deep", "nested", "copy.txt"));
    const b1 = await add(path.join(b, "backup.txt"));
    await fs.mkdir(cache);
    const manager = new DuplicateManager(cache);
    await manager.initialize();
    let state = await manager.scan([...files, a1, a2], [a, b]);
    assert.equal(state.groups.length, 1);
    assert.equal(state.groups[0].sourceId, a);
    assert.equal(state.groups[0].files.length, 2);
    assert.equal(state.duplicateFiles, 1, "repeated references are not copies");
    assert(!state.groups[0].files.some((f) => f.path === b1.path));
    const b2 = await add(path.join(b, "sub", "copy.txt"));
    state = await manager.scan(files, [a, b]);
    assert.equal(state.groups.length, 2);
    assert.notEqual(state.groups[0].id, state.groups[1].id);
    const aGroup = state.groups.find((g) => g.sourceId === a);
    const keep = aGroup.keepPath;
    const removing = aGroup.files.find((f) => f.path !== keep).path;
    await manager.quarantineFiles([removing, b1.path]);
    await fs.access(keep);
    await fs.access(b1.path);
    await fs.access(b2.path);
    await assert.rejects(fs.access(removing));
    const remaining = manager.getState().groups.find((g) => g.sourceId === b);
    await manager.quarantine([remaining.id]);
    await fs.access(remaining.keepPath);
    const restored = await manager.restore(
      manager.getState().trash.map((t) => t.id),
    );
    assert.equal(restored.trash.length, 0);
    for (const file of files) await fs.access(file.path);
    const hardlink = path.join(a, "alias.txt");
    await fs.link(a1.path, hardlink);
    state = await manager.scan([a1, { ...a1, path: hardlink }], [a]);
    assert.equal(state.groups.length, 0, "same inode is not a duplicate copy");
    state = await manager.scan([a1, b1], [a, b]);
    assert.equal(
      state.groups.length,
      0,
      "cross-drive-only matches are excluded",
    );
    const externalLink = path.join(a, "outside-link.txt");
    await fs.symlink(b1.path, externalLink);
    state = await manager.scan([a1, { ...b1, path: externalLink }], [a, b]);
    assert.equal(
      state.groups.length,
      0,
      "symlinks cannot move cross-source copies into a duplicate group",
    );
    state = await manager.scan([a1, a2], [a, path.dirname(a2.path)]);
    assert.equal(
      state.groups.length,
      0,
      "nested registered source has its own boundary",
    );
    await fs.writeFile(
      path.join(cache, "duplicate-index.json"),
      JSON.stringify({
        hashes: {},
        groups: [
          {
            id: "old",
            hash: "old",
            files: [a1, b1],
            keepPath: a1.path,
            size: a1.size,
          },
        ],
      }),
    );
    const legacy = new DuplicateManager(cache);
    await legacy.initialize();
    assert.equal(
      legacy.getState().groups.length,
      0,
      "unsafe legacy groups discarded",
    );
    await legacy.quarantine(["old"]);
    await fs.access(a1.path);
    await fs.access(b1.path);
    console.log(
      "Source-scoped duplicate tests passed: recursive subfolders, cross-drive protection, repeated paths, same inode, nested sources, scoped IDs, both quarantine APIs, restore, and legacy safety.",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
