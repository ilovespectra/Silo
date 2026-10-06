const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { PhoneManager } = require("../electron-dist/phoneManager");
async function run() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "silo-phone-name-"),
  );
  try {
    const manager = new PhoneManager(directory);
    await manager.initialize();
    await manager.renameDevice("test-device", "android", "  My Saga  ");
    await manager.renameDevice("test-device", "ios", "My iPhone");
    await assert.rejects(
      manager.renameDevice("test-device", "android", " "),
      /phone name/,
    );
    await assert.rejects(
      manager.renameDevice("test-device", "android", "x".repeat(101)),
      /phone name/,
    );
    const restarted = new PhoneManager(directory);
    await restarted.initialize();
    restarted.listIosDevices = async () => [
      {
        id: "test-device",
        platform: "ios",
        name: "Original iPhone",
        rootPath: "/ios-original",
      },
    ];
    restarted.listAndroidDevices = async () => [
      {
        id: "test-device",
        platform: "android",
        name: "Saga",
        rootPath: "/android-original",
      },
    ];
    const devices = await restarted.listDevices();
    assert.equal(devices.find((d) => d.platform === "android").name, "My Saga");
    assert.equal(devices.find((d) => d.platform === "ios").name, "My iPhone");
    assert.equal(
      devices.find((d) => d.platform === "android").rootPath,
      "/android-original",
    );
    restarted.connectAndroid = async () => ({
      id: "test-device",
      platform: "android",
      name: "Saga",
      rootPath: "/android-original",
    });
    assert.equal(
      (await restarted.connect("test-device", "android")).name,
      "My Saga",
    );
    console.log(
      "Phone naming tests passed: rename, validation, restart/reconnect persistence, platform isolation, and unchanged source paths.",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
