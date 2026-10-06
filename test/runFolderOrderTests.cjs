const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  StateStore,
  FAVORITES_FOLDER_ID,
  REFUSE_FOLDER_ID,
} = require("../electron-dist/stateStore");

async function run() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "silo-folder-order-"),
  );
  try {
    const store = new StateStore(directory);
    await store.initialize();
    await store.createDigitalFolder("First");
    await store.createDigitalFolder("Second");
    const original = store.getState().digitalFolders;
    const first = original.find((f) => f.name === "First").id;
    const second = original.find((f) => f.name === "Second").id;
    await store.addDigitalFolderReference(first, "/original/photo.jpg");
    await store.setDigitalFolderHidden(first, true);
    let state = await store.moveDigitalFolder(second, first, false);
    assert.deepEqual(
      state.digitalFolders.map((f) => f.id),
      [FAVORITES_FOLDER_ID, REFUSE_FOLDER_ID, second, first],
    );
    state = await store.moveDigitalFolder(FAVORITES_FOLDER_ID, first, true);
    const expected = [REFUSE_FOLDER_ID, second, first, FAVORITES_FOLDER_ID];
    assert.deepEqual(
      state.digitalFolders.map((f) => f.id),
      expected,
    );
    await store.moveDigitalFolder(first, first, false);
    await assert.rejects(
      store.moveDigitalFolder("missing", first, false),
      /not found/,
    );
    await assert.rejects(
      store.moveDigitalFolder(first, "missing", false),
      /not found/,
    );
    const restarted = new StateStore(directory);
    await restarted.initialize();
    const folders = restarted.getState().digitalFolders;
    assert.deepEqual(
      folders.map((f) => f.id),
      expected,
    );
    assert.deepEqual(folders.find((f) => f.id === first).filePaths, [
      "/original/photo.jpg",
    ]);
    assert.equal(folders.find((f) => f.id === first).hidden, true);
    assert.equal(folders.find((f) => f.id === REFUSE_FOLDER_ID).hidden, true);
    assert.equal(folders.length, original.length);
    const renamed = await restarted.renameDigitalFolder(
      first,
      "  Family albums  ",
    );
    assert.equal(
      renamed.digitalFolders.find((f) => f.id === first).name,
      "Family albums",
    );
    assert.deepEqual(
      renamed.digitalFolders.map((f) => f.id),
      expected,
    );
    assert.deepEqual(
      renamed.digitalFolders.find((f) => f.id === first).filePaths,
      ["/original/photo.jpg"],
    );
    assert.equal(
      renamed.digitalFolders.find((f) => f.id === first).hidden,
      true,
    );
    await assert.rejects(
      restarted.renameDigitalFolder(first, "   "),
      /folder name/,
    );
    await assert.rejects(
      restarted.renameDigitalFolder("missing", "Name"),
      /not found/,
    );
    await restarted.renameDigitalFolder(FAVORITES_FOLDER_ID, "My favorites");
    const renamedRestart = new StateStore(directory);
    await renamedRestart.initialize();
    assert.equal(
      renamedRestart.getState().digitalFolders.find((f) => f.id === first).name,
      "Family albums",
    );
    assert.equal(
      renamedRestart
        .getState()
        .digitalFolders.find((f) => f.id === FAVORITES_FOLDER_ID).name,
      "My favorites",
    );
    console.log(
      "Folder ordering tests passed: before/after moves, built-in folder reorder, no-op, invalid IDs, restart persistence, unchanged references and visibility.",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
