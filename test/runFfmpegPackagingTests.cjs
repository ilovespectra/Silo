const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const packageJson = require("../package.json");
const { assertMachOArchitecture, withTemporaryFfmpegBinary } = require("../scripts/dist-mac.cjs");

function makeMachO(cpuType) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  return header;
}

function testArchitectureValidation() {
  assert.doesNotThrow(() => assertMachOArchitecture(makeMachO(0x01000007), "x64"));
  assert.doesNotThrow(() => assertMachOArchitecture(makeMachO(0x0100000c), "arm64"));
  assert.throws(() => assertMachOArchitecture(makeMachO(0x01000007), "arm64"), /not a arm64 executable/);
  assert.throws(() => assertMachOArchitecture(Buffer.from("not Mach-O"), "x64"), /not a 64-bit macOS Mach-O/);
  assert.throws(() => assertMachOArchitecture(makeMachO(0), "ia32"), /Unsupported macOS FFmpeg architecture/);
}

function testMacBuildConfiguration() {
  assert.strictEqual(
    packageJson.build.mac.artifactName,
    "${productName}-${version}-${arch}.${ext}",
  );
  assert.match(packageJson.scripts["dist:mac:x64"], /dist-mac\.cjs x64$/);
  assert.match(packageJson.scripts["dist:mac:arm64"], /dist-mac\.cjs arm64$/);
}

function testTemporaryBinaryRestoration() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "silo-ffmpeg-packaging-"));
  const installedPath = path.join(directory, "installed-ffmpeg");
  const stagedPath = path.join(directory, "staged-ffmpeg");
  try {
    fs.writeFileSync(installedPath, "existing dependency binary", { mode: 0o755 });
    fs.writeFileSync(stagedPath, "target architecture binary", { mode: 0o755 });

    const result = withTemporaryFfmpegBinary(installedPath, stagedPath, directory, () => {
      assert.strictEqual(fs.readFileSync(installedPath, "utf8"), "target architecture binary");
      return "packaged";
    });
    assert.strictEqual(result, "packaged");
    assert.strictEqual(fs.readFileSync(installedPath, "utf8"), "existing dependency binary");

    assert.throws(() => withTemporaryFfmpegBinary(installedPath, stagedPath, directory, () => {
      throw new Error("packager failed");
    }), /packager failed/);
    assert.strictEqual(fs.readFileSync(installedPath, "utf8"), "existing dependency binary");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  testArchitectureValidation();
  testMacBuildConfiguration();
  testTemporaryBinaryRestoration();
  console.log("FFmpeg architecture packaging tests passed.");
}

main();
