const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { AudioLibraryCache } = require("../electron-dist/audioLibraryCache");
const { isAudioFile } = require("../electron-dist/utils/audioTypes");

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "silo-audio-test-"));
  try {
    const cacheDir = path.join(root, "cache");
    await fs.mkdir(cacheDir);
    const a = path.join(root, "a"),
      b = path.join(root, "b");
    await fs.mkdir(a);
    await fs.mkdir(path.join(b, ".hidden", "deep"), { recursive: true });
    await fs.writeFile(path.join(a, "one.mp3"), "audio");
    await fs.writeFile(path.join(b, ".hidden", "deep", "TWO.FLAC"), "audio");
    await fs.symlink(b, path.join(b, "cycle"));
    const sources = [a, b].map((p, i) => ({
      id: p,
      rootPath: p,
      kind: "local",
      label: `Source ${i}`,
    }));
    const cachePath = path.join(cacheDir, "audio-library-index.json");
    // Reproduce a globally fresh cache without per-source coverage.
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        sourceIds: [a, b],
        scannedAt: Date.now(),
        files: [],
        extensions: [],
        sourceScannedAt: {},
      }),
    );
    const cache = new AudioLibraryCache(cacheDir);
    await cache.initialize();
    let snapshot = await cache.scan(
      sources,
      () => false,
      isAudioFile,
      async () => [],
      () => {},
    );
    assert.equal(
      snapshot.files.length,
      2,
      "all sources, nested hidden files, and uppercase extensions are scanned",
    );
    assert.equal(Object.keys(snapshot.sourceScannedAt).length, 2);
    assert(snapshot.scannedAt > 0);
    const remote = {
      id: "remote",
      rootPath: "/remote",
      kind: "gdrive",
      label: "Remote",
    };
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error("Source disconnected");
    };
    snapshot = await cache.scan(
      [...sources, remote],
      (p) => p === "/remote",
      isAudioFile,
      fail,
      () => {},
    );
    assert.equal(calls, 3, "failed source retries three times");
    assert(snapshot.failedSources.includes("remote"));
    assert.equal(
      snapshot.scannedAt,
      0,
      "incomplete inventory must not be fresh",
    );
    assert.equal(
      snapshot.files.length,
      2,
      "completed local results remain available",
    );
    const restarted = new AudioLibraryCache(cacheDir);
    await restarted.initialize();
    assert(
      restarted.getSnapshot().failedSources.includes("remote"),
      "failure survives restart",
    );
    await restarted.scan(
      [...sources, remote],
      (p) => p === "/remote",
      isAudioFile,
      fail,
      () => {},
    );
    assert.equal(
      calls,
      3,
      "persisted cooldown prevents immediate retry storms",
    );
    // Simulate cooldown expiry and a reconnect without forcing refresh.
    const stored = JSON.parse(await fs.readFile(cachePath, "utf8"));
    stored.sourceCooldownUntil.remote = Date.now() - 1;
    await fs.writeFile(cachePath, JSON.stringify(stored));
    const reconnected = new AudioLibraryCache(cacheDir);
    await reconnected.initialize();
    snapshot = await reconnected.scan(
      [...sources, remote],
      (p) => p === "/remote",
      isAudioFile,
      async () => [
        {
          name: "track.WAV",
          path: "/remote/track.WAV",
          type: "other",
          isDirectory: false,
          size: 5,
          modified: 1,
        },
      ],
      () => {},
    );
    assert.equal(snapshot.files.length, 3);
    assert.equal(
      snapshot.files.find((f) => f.path === "/remote/track.WAV").type,
      "audio",
    );
    assert.equal(
      snapshot.files.find((f) => f.path === "/remote/track.WAV").sourceId,
      "remote",
    );
    assert.equal(snapshot.failedSources.length, 0);
    assert(snapshot.sourceScannedAt.remote > 0);
    const originalOpen = fs.opendir;
    fs.opendir = async (p, ...args) => {
      if (p === path.join(b, ".hidden")) throw new Error("Permission denied");
      return originalOpen(p, ...args);
    };
    try {
      snapshot = await reconnected.scan(
        sources,
        () => false,
        isAudioFile,
        async () => [],
        () => {},
        true,
      );
      assert(
        snapshot.failedSources.includes(b),
        "unreadable subtree stays retryable",
      );
      assert(
        snapshot.files.some((f) => f.name === "TWO.FLAC"),
        "unresolved cached audio is retained",
      );
    } finally {
      fs.opendir = originalOpen;
    }
    console.log(
      "Audio inventory tests passed: per-source coverage, checkpoint freshness, recursive hidden folders, symlink cycles, retries, restart, cooldown expiry, remote categorization, and partial failure retention.",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
