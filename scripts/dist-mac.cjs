const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const packageJson = require("../package.json");

const projectRoot = path.resolve(__dirname, "..");
const architecture = process.argv[2];
const supportedArchitectures = new Set(["x64", "arm64"]);
const cpuTypes = { x64: 0x01000007, arm64: 0x0100000c };

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

function readMachOArchitectures(binary) {
  if (binary.length < 8) return [];
  const magic = binary.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const entrySize = magic === 0xcafebabf ? 32 : 20;
    const count = binary.readUInt32BE(4);
    if (count > 32 || binary.length < 8 + count * entrySize) return [];
    const architectures = [];
    for (let index = 0; index < count; index += 1)
      architectures.push(binary.readUInt32BE(8 + index * entrySize));
    return architectures;
  }
  return binary.readUInt32LE(0) === 0xfeedfacf
    ? [binary.readUInt32LE(4)]
    : [];
}

function assertMachOArchitecture(binary, expectedArchitecture, label = "Binary") {
  if (!Object.hasOwn(cpuTypes, expectedArchitecture)) {
    throw new Error(`Unsupported macOS architecture: ${expectedArchitecture}`);
  }
  const architectures = readMachOArchitectures(binary);
  if (!architectures.length) {
    throw new Error(`${label} is not a supported 64-bit macOS Mach-O executable.`);
  }
  if (!architectures.includes(cpuTypes[expectedArchitecture])) {
    throw new Error(`${label} does not contain the ${expectedArchitecture} architecture.`);
  }
}

function withTemporaryFfmpegBinary(originalPath, stagedPath, build) {
  const backupPath = path.join(path.dirname(originalPath), `.ffmpeg-silo-backup-${process.pid}`);
  const originalMode = fs.statSync(originalPath).mode & 0o777;
  fs.renameSync(originalPath, backupPath);
  try {
    fs.copyFileSync(stagedPath, originalPath);
    fs.chmodSync(originalPath, 0o755);
    return build();
  } finally {
    fs.rmSync(originalPath, { force: true });
    fs.renameSync(backupPath, originalPath);
    fs.chmodSync(originalPath, originalMode);
  }
}

function assertPackagedMacApp(appPath, expectedArchitecture) {
  const productName = packageJson.build.productName;
  const executablePath = path.join(appPath, "Contents", "MacOS", productName);
  assertMachOArchitecture(
    fs.readFileSync(executablePath),
    expectedArchitecture,
    `Packaged ${productName} executable`,
  );

  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const plist = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", infoPlistPath],
    { encoding: "utf8" },
  );
  if (plist.error) throw plist.error;
  if (plist.status !== 0) {
    throw new Error(`Could not inspect packaged Info.plist: ${plist.stderr.trim()}`);
  }
  const info = JSON.parse(plist.stdout);
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    if (info[key] !== productName) {
      throw new Error(`Packaged ${key} must be "${productName}", received "${info[key]}".`);
    }
  }
  const minimumVersion = packageJson.build.mac.minimumSystemVersion;
  if (info.LSMinimumSystemVersion !== minimumVersion) {
    throw new Error(
      `Packaged LSMinimumSystemVersion must be ${minimumVersion}, ` +
        `received ${info.LSMinimumSystemVersion}.`,
    );
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
    assertMachOArchitecture(
      fs.readFileSync(stagedBinary),
      architecture,
      "Staged FFmpeg",
    );

    const installedBinary = path.join(
      projectRoot,
      "node_modules",
      "ffmpeg-static",
      "ffmpeg",
    );
    withTemporaryFfmpegBinary(installedBinary, stagedBinary, () => {
      const buildArguments = [
        "electron-builder",
        "--config",
        "electron-builder.config.cjs",
        "--mac",
        `--${architecture}`,
      ];
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
      const architectureDirectory = architecture === "x64" ? "mac" : "mac-arm64";
      assertPackagedMacApp(
        path.join(
          outputDirectory,
          architectureDirectory,
          `${packageJson.build.productName}.app`,
        ),
        architecture,
      );
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
  assertPackagedMacApp,
  readMachOArchitectures,
  withTemporaryFfmpegBinary,
};
