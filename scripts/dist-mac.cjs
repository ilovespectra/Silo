const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const architecture = process.argv[2];
const supportedArchitectures = new Set(["x64", "arm64"]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
  }
}

function assertMachOArchitecture(binary, expectedArchitecture) {
  const cpuTypes = { x64: 0x01000007, arm64: 0x0100000c };
  if (!Object.hasOwn(cpuTypes, expectedArchitecture)) {
    throw new Error(`Unsupported macOS FFmpeg architecture: ${expectedArchitecture}`);
  }
  if (binary.length < 8 || binary.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error("The staged FFmpeg is not a 64-bit macOS Mach-O executable.");
  }
  if (binary.readUInt32LE(4) !== cpuTypes[expectedArchitecture]) {
    throw new Error(`The staged FFmpeg is not a ${expectedArchitecture} executable.`);
  }
}

function withTemporaryFfmpegBinary(originalPath, stagedPath, backupDirectory, build) {
  const backupPath = path.join(backupDirectory, "ffmpeg-original");
  const originalMode = fs.statSync(originalPath).mode & 0o777;
  fs.copyFileSync(originalPath, backupPath);
  try {
    fs.copyFileSync(stagedPath, originalPath);
    fs.chmodSync(originalPath, 0o755);
    return build();
  } finally {
    fs.copyFileSync(backupPath, originalPath);
    fs.chmodSync(originalPath, originalMode);
  }
}

function buildMac() {
  if (process.platform !== "darwin") {
    throw new Error("Architecture-specific Silo DMGs must be built on macOS.");
  }
  if (!supportedArchitectures.has(architecture)) {
    throw new Error("Choose an architecture explicitly: x64 or arm64.");
  }

  run("npm", ["run", "build"]);
  run("npm", ["run", "release:check"]);

  const cacheRoot = path.join(projectRoot, "node_modules", ".cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(cacheRoot, "silo-ffmpeg-"));
  const stagedBinary = path.join(stagingDirectory, "ffmpeg");
  const installer = path.join(projectRoot, "node_modules", "ffmpeg-static", "install.js");
  const environment = {
    ...process.env,
    FFMPEG_BIN: stagedBinary,
    npm_config_arch: architecture,
    npm_config_platform: "darwin",
  };

  try {
    run(process.execPath, [installer], { env: environment });
    assertMachOArchitecture(fs.readFileSync(stagedBinary), architecture);

    const installedBinary = path.join(
      projectRoot,
      "node_modules",
      "ffmpeg-static",
      "ffmpeg",
    );
    withTemporaryFfmpegBinary(installedBinary, stagedBinary, stagingDirectory, () => {
      const buildArguments = ["electron-builder", "--mac", `--${architecture}`];
      if (process.env.SILO_TEST_DIR_ONLY === "1") {
        buildArguments.push("--dir");
      }
      const configuredOutputDirectory =
        process.env.SILO_RELEASE_OUTPUT_DIR || process.env.SILO_TEST_OUTPUT_DIR;
      const outputDirectory = configuredOutputDirectory
        ? path.resolve(configuredOutputDirectory)
        : path.join(projectRoot, "release", architecture);
      buildArguments.push(
        `--config.directories.output=${outputDirectory}`,
      );
      run("npx", buildArguments);
    });
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    buildMac();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  assertMachOArchitecture,
  withTemporaryFfmpegBinary,
};
