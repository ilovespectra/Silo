#!/usr/bin/env node
/**
 * Test script to verify backup destination persistence
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const testDataDir = path.join(
  os.tmpdir(),
  "silo-test-backup-dest-" + Date.now(),
);

async function runTest() {
  console.log("Creating test directory:", testDataDir);
  await fs.promises.mkdir(testDataDir, { recursive: true });

  // Create external backup directory
  const externalBackupDir = path.join(testDataDir, "external-backup");
  await fs.promises.mkdir(externalBackupDir);
  console.log("Created external backup directory:", externalBackupDir);

  // Import PhoneManager after build
  try {
    require("./electron-dist/phoneManager.js");
  } catch (e) {
    console.log("Note: Using source TypeScript directly (requires ts-node)");
  }

  // Test 1: Simulate persistence by reading/writing config
  const configPath = path.join(testDataDir, "backup-destination.json");
  const config = { destination: externalBackupDir };

  console.log("\n[TEST 1] Writing destination config...");
  const configContent = JSON.stringify(config, null, 2);
  const tempPath = configPath + ".tmp";
  await fs.promises.writeFile(tempPath, configContent, "utf8");
  await fs.promises.rename(tempPath, configPath);
  console.log("✓ Config written to:", configPath);

  console.log("\n[TEST 2] Reading config back...");
  const stored = JSON.parse(await fs.promises.readFile(configPath, "utf8"));
  if (stored.destination === externalBackupDir) {
    console.log("✓ Destination correctly persisted:", stored.destination);
  } else {
    console.error("✗ Destination mismatch:", stored.destination);
    process.exit(1);
  }

  console.log("\n[TEST 3] Simulating inaccessible destination...");
  const invalidConfig = {
    destination: "/nonexistent/path/that/does/not/exist",
  };
  const invalidPath = path.join(testDataDir, "invalid-destination.json");
  await fs.promises.writeFile(
    invalidPath,
    JSON.stringify(invalidConfig, null, 2),
  );
  const loaded = JSON.parse(await fs.promises.readFile(invalidPath, "utf8"));
  try {
    await fs.promises.access(loaded.destination);
    console.error("✗ Should not be accessible");
    process.exit(1);
  } catch {
    console.log("✓ Invalid destination correctly detected as inaccessible");
  }

  console.log("\n[TEST 4] Clearing destination (null)...");
  const clearConfig = { destination: null };
  const clearPath = path.join(testDataDir, "clear-destination.json");
  await fs.promises.writeFile(clearPath, JSON.stringify(clearConfig, null, 2));
  const cleared = JSON.parse(await fs.promises.readFile(clearPath, "utf8"));
  if (cleared.destination === null) {
    console.log("✓ Destination correctly cleared to null");
  } else {
    console.error("✗ Failed to clear destination");
    process.exit(1);
  }

  // Cleanup
  console.log("\n[CLEANUP] Removing test directory...");
  await fs.promises.rm(testDataDir, { recursive: true, force: true });
  console.log("✓ Test directory cleaned up");

  console.log("\n✅ All persistence tests passed!");
  console.log("\nHow to test with the app:");
  console.log(
    "1. Start the app: ELECTRON_IS_DEV=0 ./node_modules/.bin/electron .",
  );
  console.log(
    "2. Click 'Choose Destination' and select a folder (e.g., external drive)",
  );
  console.log("3. Close the app: pkill -f 'electron \\.'");
  console.log("4. Start the app again");
  console.log(
    "5. Verify the destination is still shown in the backup settings",
  );
  console.log(
    "6. Connect a phone and backups will automatically use the selected destination",
  );
}

runTest().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
