/**
 * Tests for automatic indexing of added sources.
 */

import assert = require("assert");
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import { SemanticIndexer, IndexProgress } from "../src/semanticIndexer";

let tempDir: string;
let testSourceDir: string;
let semanticIndexer: SemanticIndexer;
let progressUpdates: IndexProgress[] = [];
let imageReadDelayMs = 0;

async function setup(): Promise<void> {
  // Create temporary directory for tests
  tempDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "semantic-index-test-"),
  );
  testSourceDir = path.join(tempDir, "test-source");
  await fsPromises.mkdir(testSourceDir, { recursive: true });

  // Create a mock scanner function
  const mockScanSource = async (
    sourcePath: string,
    onFile: (file: any) => void,
    isCancelled: () => boolean,
  ): Promise<void> => {
    const entries = await fsPromises.readdir(sourcePath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (isCancelled()) return;
      const fullPath = path.join(sourcePath, entry.name);
      const stats = await fsPromises.stat(fullPath);
      onFile({
        name: entry.name,
        path: fullPath,
        relativePath: entry.name,
        size: stats.size,
        modified: stats.mtimeMs,
        isDirectory: entry.isDirectory(),
        type: entry.isDirectory() ? "folder" : "image", // Fake type for testing
        extension: path.extname(entry.name),
      });
    }
  };

  // Create indexer with mock scanner
  semanticIndexer = new SemanticIndexer(
    path.join(tempDir, "silo-user-data"),
    tempDir,
    mockScanSource,
    (progress) => {
      progressUpdates.push({ ...progress });
    },
  );
  semanticIndexer.setBackgroundIndexWorkListener((changedFiles) => {
    const changedRoots = Array.from(new Set(changedFiles.values()));
    void semanticIndexer.start(changedRoots, changedFiles);
  });

  await semanticIndexer.initialize();
  (semanticIndexer as any).loadClipRuntime = async () => ({
    RawImage: {
      read: async () => {
        if (imageReadDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, imageReadDelayMs));
        }
        return {};
      },
    },
    processor: async () => ({}),
    visionModel: async () => ({
      image_embeds: { data: new Float32Array(512).fill(1) },
    }),
    tokenizer: async () => ({}),
    textModel: async () => ({
      text_embeds: { data: new Float32Array(512).fill(1) },
    }),
  });
  imageReadDelayMs = 0;
  progressUpdates = [];
}

async function teardown(): Promise<void> {
  semanticIndexer.stopWatching();
  // Clean up temp directory
  await fsPromises.rm(tempDir, { recursive: true, force: true });
}

async function createTestFile(
  name: string,
  content: string = "test",
): Promise<string> {
  const filePath = path.join(testSourceDir, name);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, content);
  return filePath;
}

async function deleteTestFile(name: string): Promise<void> {
  const filePath = path.join(testSourceDir, name);
  await fsPromises.rm(filePath, { force: true });
}

async function modifyTestFile(name: string, content: string): Promise<void> {
  const filePath = path.join(testSourceDir, name);
  await fsPromises.writeFile(filePath, content);
}

async function waitForIndexedFile(
  filePath: string,
  timeoutMs: number = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      semanticIndexer
        .getIndexedImages([testSourceDir])
        .some((file) => file.path === filePath)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for automatic indexing: ${filePath}`);
}

function waitForProgress(
  statusOrFn: string | ((p: IndexProgress) => boolean),
  timeoutMs: number = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkProgress = () => {
      const lastProgress = progressUpdates[progressUpdates.length - 1];
      if (!lastProgress) return false;

      if (typeof statusOrFn === "string") {
        return lastProgress.status === statusOrFn;
      } else {
        return statusOrFn(lastProgress);
      }
    };

    if (checkProgress()) {
      resolve();
      return;
    }

    const interval = setInterval(() => {
      if (checkProgress()) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      const lastProgress = progressUpdates[progressUpdates.length - 1];
      reject(
        new Error(
          `Timeout waiting for progress update. Last status: ${lastProgress?.status || "none"}`,
        ),
      );
    }, timeoutMs);
  });
}

// Tests

async function testInitialIndexing(): Promise<void> {
  console.log("\n✓ Test: Initial indexing of new source");

  // Create some test files
  await createTestFile("image1.jpg");
  await createTestFile("image2.jpg");

  // Start indexing
  await semanticIndexer.start([testSourceDir]);

  // Wait for indexing to complete
  await waitForProgress("complete");

  const lastProgress = progressUpdates[progressUpdates.length - 1];
  assert.ok(lastProgress.total >= 2, "Should have indexed at least 2 files");
  assert.ok(lastProgress.status === "complete", "Should reach complete status");

  console.log(
    `  - Indexed ${lastProgress.indexed} files, ${lastProgress.errors} errors`,
  );
}

async function testChronologicalIndexing(): Promise<void> {
  console.log("\n✓ Test: Indexes oldest files first");
  progressUpdates = [];

  const oldest = await createTestFile("chronology-oldest.jpg");
  const newest = await createTestFile("chronology-newest.jpg");
  const middle = await createTestFile("chronology-middle.jpg");
  await fsPromises.utimes(oldest, 1_700_000_000, 1_700_000_000);
  await fsPromises.utimes(middle, 1_700_000_100, 1_700_000_100);
  await fsPromises.utimes(newest, 1_700_000_200, 1_700_000_200);

  await semanticIndexer.start([testSourceDir]);
  const processingOrder = progressUpdates
    .filter((progress) => progress.currentFile?.startsWith("chronology-"))
    .map((progress) => progress.currentFile)
    .filter((fileName, index, all) => index === 0 || all[index - 1] !== fileName);
  assert.deepEqual(
    processingOrder,
    ["chronology-oldest.jpg", "chronology-middle.jpg", "chronology-newest.jpg"],
    "full scans must embed files in modification-time order",
  );
}

async function testBoundedDemoDiscovery(): Promise<void> {
  console.log("\n✓ Test: Demo discovery stops at its sample limit");
  progressUpdates = [];
  (semanticIndexer as any).setDemoFileLimit(10);
  for (let index = 0; index < 100; index += 1)
    await createTestFile(`demo-sample-${index.toString().padStart(3, "0")}.jpg`);

  await semanticIndexer.start([testSourceDir]);
  const indexed = semanticIndexer.getIndexedImages([testSourceDir]);
  assert.ok(indexed.length > 0, "demo mode should still create usable search results");
  assert.ok(indexed.length <= 10, "demo mode must respect its file cap");
  assert.ok(
    (semanticIndexer as any).searchDiscovery.scanned < 100,
    "demo discovery should stop after collecting a bounded sample",
  );
}

async function testPausedFullScanRestoresSourceRoot(): Promise<void> {
  console.log("\n✓ Test: Paused full scans resume from a saved source root");
  progressUpdates = [];
  for (let index = 0; index < 5; index += 1)
    await createTestFile(`resume-${index}.jpg`);
  imageReadDelayMs = 60;

  const activeRun = semanticIndexer.start([testSourceDir]);
  await waitForProgress("indexing", 10000);
  await semanticIndexer.pause();
  await activeRun;
  imageReadDelayMs = 0;

  const userDataPath = path.join(tempDir, "silo-user-data");
  const checkpointPath = path.join(
    userDataPath,
    "semantic-index",
    "pending-work.json",
  );
  const checkpoint = JSON.parse(await fsPromises.readFile(checkpointPath, "utf8"));
  assert.ok(checkpoint.sources.includes(testSourceDir));
  assert.equal(
    checkpoint.entries.length,
    0,
    "unbounded full scans should persist roots instead of every candidate path",
  );

  semanticIndexer.stopWatching();
  progressUpdates = [];
  semanticIndexer = new SemanticIndexer(
    userDataPath,
    tempDir,
    async (sourcePath, onFile, isCancelled) => {
      for (const name of await fsPromises.readdir(sourcePath)) {
        if (isCancelled()) return;
        const fullPath = path.join(sourcePath, name);
        const stats = await fsPromises.stat(fullPath);
        onFile({
          name,
          path: fullPath,
          relativePath: name,
          size: stats.size,
          modified: stats.mtimeMs,
          isDirectory: false,
          type: "image",
          extension: path.extname(name),
        });
      }
    },
    (progress) => progressUpdates.push({ ...progress }),
  );
  await semanticIndexer.initialize();
  (semanticIndexer as any).loadClipRuntime = async () => ({
    RawImage: { read: async () => ({}) },
    processor: async () => ({}),
    visionModel: async () => ({
      image_embeds: { data: new Float32Array(512).fill(1) },
    }),
  });

  await semanticIndexer.start([testSourceDir]);
  assert.equal(
    semanticIndexer.getIndexedImages([testSourceDir]).length,
    5,
    "a restarted indexer should finish the saved source scan",
  );
}

async function testNewFilesDetection(): Promise<void> {
  console.log("\n✓ Test: Detecting new files added to source");

  progressUpdates = [];

  // Create initial file
  await createTestFile("initial.jpg");

  // Start indexing and watching
  await semanticIndexer.startWatching([testSourceDir]);
  await semanticIndexer.start([testSourceDir]);
  await waitForProgress("complete", 10000);

  progressUpdates = [];

  const newFilePath = await createTestFile("new-file.jpg");
  await waitForIndexedFile(newFilePath);
  assert.ok(
    semanticIndexer
      .getIndexedImages([testSourceDir])
      .some((file) => file.path === newFilePath),
    "Should automatically index a new file",
  );

  // Clean up
  semanticIndexer.stopWatching();
}

async function testNewFilesDuringActiveScan(): Promise<void> {
  console.log("\n✓ Test: Indexing new files added during an active scan");

  imageReadDelayMs = 1600;
  await createTestFile("initial.jpg");
  await semanticIndexer.startWatching([testSourceDir]);
  const initialRun = semanticIndexer.start([testSourceDir]);
  await waitForProgress("indexing", 10000);

  const newFilePath = await createTestFile("added-during-scan.jpg");
  await waitForIndexedFile(newFilePath, 15000);
  await initialRun;
  assert.ok(
    semanticIndexer
      .getIndexedImages([testSourceDir])
      .some((file) => file.path === newFilePath),
    "Should queue another scan for files added during indexing",
  );
}

async function testModifiedFilesDetection(): Promise<void> {
  console.log("\n✓ Test: Detecting modified files");

  progressUpdates = [];

  // Create a test file
  const filePath = await createTestFile("modifiable.jpg", "original");

  // Index it
  await semanticIndexer.start([testSourceDir]);
  await waitForProgress("complete", 10000);

  progressUpdates = [];

  // Modify the file (change timestamp)
  console.log("  - Modifying file...");
  await modifyTestFile("modifiable.jpg", "modified content");

  // Wait for file system events
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Reconciliation should detect the modification
  const changesFound = await semanticIndexer.reconcileIndex([testSourceDir]);
  assert.ok(changesFound.size > 0, "Should detect modified file");

  console.log("  - File modification detected successfully");
}

async function testDeletedFilesDetection(): Promise<void> {
  console.log("\n✓ Test: Detecting deleted files");

  progressUpdates = [];

  // Create and index a file
  await createTestFile("deletable.jpg");

  await semanticIndexer.start([testSourceDir]);
  await waitForProgress("complete", 10000);

  progressUpdates = [];

  // Delete the file
  console.log("  - Deleting file...");
  await deleteTestFile("deletable.jpg");

  // Wait for file system events
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Reconciliation should detect the deletion
  const changesFound = await semanticIndexer.reconcileIndex([testSourceDir]);
  assert.equal(
    changesFound.size,
    0,
    "Deleted files should not create indexing jobs",
  );
  assert.equal(
    semanticIndexer
      .getIndexedImages([testSourceDir])
      .some((file) => file.path.endsWith("deletable.jpg")),
    false,
    "Deleted files should be removed from the active index",
  );

  console.log("  - File deletion detected successfully");
}

async function testAppRestartReconciliation(): Promise<void> {
  console.log("\n✓ Test: Index reconciliation on app restart");

  progressUpdates = [];

  // Create and index files
  await createTestFile("restart-test-1.jpg");
  await createTestFile("restart-test-2.jpg");

  await semanticIndexer.start([testSourceDir]);
  await waitForProgress("complete", 10000);

  const firstRunIndexed = progressUpdates[progressUpdates.length - 1].indexed;

  // Simulate app shutdown - stop watching
  semanticIndexer.stopWatching();

  // Simulate app running in background - files are added
  console.log('  - Files added after app "shutdown"...');
  await createTestFile("added-after-shutdown.jpg");
  await modifyTestFile("restart-test-1.jpg", "modified after shutdown");

  // Restart (simulate new app instance)
  progressUpdates = [];

  // Reconcile should detect changes
  const changesFound = await semanticIndexer.reconcileIndex([testSourceDir]);
  assert.equal(
    changesFound.size,
    2,
    "Should detect added and modified files after app restart",
  );

  console.log("  - Changes detected after simulated app restart");

  // Re-index to bring up to date
  await semanticIndexer.start([testSourceDir], changesFound);
  await waitForProgress("complete", 10000);

  const secondRunIndexed = progressUpdates[progressUpdates.length - 1].indexed;
  assert.ok(
    secondRunIndexed >= firstRunIndexed,
    "Second run should index same or more files",
  );

  console.log(
    `  - Re-indexed ${secondRunIndexed} files (was ${firstRunIndexed})`,
  );
}

async function testUnavailableSource(): Promise<void> {
  console.log("\n✓ Test: Handling unavailable source folder");

  progressUpdates = [];

  // Create a source directory
  const sourceDir = path.join(tempDir, "unavailable-source");
  await fsPromises.mkdir(sourceDir);
  const testFilePath = path.join(sourceDir, "test.jpg");
  await fsPromises.writeFile(testFilePath, "test");

  // Index it
  await semanticIndexer.start([sourceDir]);
  await waitForProgress("complete", 10000);

  assert.ok(
    semanticIndexer
      .getIndexedImages([sourceDir])
      .some((file) => file.path === testFilePath),
    "Should index the source before it becomes unavailable",
  );

  // Delete the source directory (simulate USB unmount)
  console.log("  - Simulating source folder deletion...");
  await fsPromises.rm(sourceDir, { recursive: true });

  // Index should still work but skip the unavailable source
  progressUpdates = [];

  // Attempt to reconcile - should handle gracefully
  const changesFound = await semanticIndexer.reconcileIndex([sourceDir]);

  // Should not crash and should continue working
  console.log("  - Handled unavailable source gracefully");

  // Index should still have old records (not deleted)
  const images = semanticIndexer.getIndexedImages([sourceDir]);
  assert.ok(
    images.some((file) => file.path === testFilePath),
    "Should preserve indexed files when a source becomes unavailable",
  );

  console.log("  - Index preserved for potential future recovery");
}

async function testWatchDebouncing(): Promise<void> {
  console.log("\n✓ Test: File watch event debouncing");

  progressUpdates = [];

  // Create initial file
  await createTestFile("debounce-test.jpg");

  // Start watching
  await semanticIndexer.startWatching([testSourceDir]);
  await semanticIndexer.start([testSourceDir]);
  await waitForProgress("complete", 10000);

  progressUpdates = [];

  // Rapidly modify file multiple times
  console.log("  - Rapidly modifying file...");
  for (let i = 0; i < 10; i++) {
    await modifyTestFile("debounce-test.jpg", `version ${i}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Wait for debounce period
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Should not have triggered many re-scans due to debouncing
  const indexingAttempts = progressUpdates.filter(
    (p) => p.status === "scanning",
  ).length;
  console.log(
    `  - Multiple modifications resulted in ${indexingAttempts} scan attempt(s) due to debouncing`,
  );

  semanticIndexer.stopWatching();
}

async function testMacImageConversionFallback(): Promise<void> {
  console.log("\n✓ Test: macOS image conversion fallback");
  if (process.platform !== "darwin") {
    console.log("  - Skipped outside macOS");
    return;
  }

  const originalPath = path.join(testSourceDir, "fallback.png");
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await fsPromises.writeFile(originalPath, onePixelPng);

  let convertedPath = "";
  const runtime = {
    RawImage: {
      read: async (filePath: string) => {
        if (filePath === originalPath)
          throw new Error("Unsupported image format");
        convertedPath = filePath;
        assert.equal(path.extname(filePath), ".jpg");
        assert.ok((await fsPromises.stat(filePath)).size > 0);
        return {};
      },
    },
    processor: async () => ({}),
    visionModel: async () => ({
      image_embeds: { data: new Float32Array(512).fill(1) },
    }),
  };

  const vector = await (semanticIndexer as any).embedImage(
    originalPath,
    runtime,
  );
  assert.equal(vector.length, 512);
  assert.ok(convertedPath, "Fallback should decode the converted JPEG");
  await assert.rejects(fsPromises.access(path.dirname(convertedPath)));
}

async function runAllTests(): Promise<void> {
  console.log("Running Automatic Indexing Tests");
  console.log("================================\n");

  const tests = [
    testInitialIndexing,
    testChronologicalIndexing,
    testBoundedDemoDiscovery,
    testPausedFullScanRestoresSourceRoot,
    testNewFilesDetection,
    testNewFilesDuringActiveScan,
    testModifiedFilesDetection,
    testDeletedFilesDetection,
    testAppRestartReconciliation,
    testUnavailableSource,
    testWatchDebouncing,
    testMacImageConversionFallback,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await setup();
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(
        `  ✗ FAILED:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      try {
        await teardown();
      } catch (e) {
        console.error("Teardown error:", e);
      }
    }
  }

  console.log("\n================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runAllTests().catch((error) => {
  console.error("Test suite error:", error);
  process.exit(1);
});
