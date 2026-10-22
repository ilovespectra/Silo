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

// npm only installs the native optional package for the build machine's CPU, so
// an Apple silicon build host has no Intel NumKong addon unless it is staged here.
const nativeOptionalPackages = (arch) => [
  { name: `@numkong/darwin-${arch}`, binary: "numkong.node" },
  { name: `@img/sharp-darwin-${arch}`, binary: `lib/sharp-darwin-${arch}.node`, pattern: `sharp-darwin-${arch}` },
  { name: `@img/sharp-libvips-darwin-${arch}`, binaryExport: "./binary" },
];

function resolveNativeBinaryPath(packageDirectory, binary, pattern = null) {
  const directPath = path.join(packageDirectory, binary);
  if (fs.existsSync(directPath)) return directPath;

  const filePattern = pattern || binary.replace(/\.[^/.]+$/, "");
  const baseDir = path.dirname(directPath);
  if (!fs.existsSync(baseDir)) return directPath;

  const matches = fs.readdirSync(baseDir)
    .filter((entry) => entry.endsWith(".node") && entry.startsWith(filePattern))
    .sort((left, right) => left.length - right.length);

  if (matches.length) {
    return path.join(baseDir, matches[0]);
  }

  return directPath;
}

function lockedPackage(name) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version || !entry.resolved) {
    throw new Error(`${name} is missing from package-lock.json.`);
  }
  return entry;
}

function resolveNativePackageBinaryPath(packageDirectory, nativePackage) {
  let binary = nativePackage.binary;
  if (nativePackage.binaryExport) {
    const packageJsonPath = path.join(packageDirectory, "package.json");
    if (!fs.existsSync(packageJsonPath)) return null;
    const packageManifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    binary = packageManifest.exports?.[nativePackage.binaryExport];
  }
  if (typeof binary !== "string") return null;
  const packageRelativeBinary = binary.startsWith("./") ? binary.slice(2) : binary;
  const packageRoot = path.resolve(packageDirectory);
  const binaryPath = path.resolve(packageRoot, packageRelativeBinary);
  const relativePath = path.relative(packageRoot, binaryPath);
  if (relativePath.startsWith(`..${path.sep}`) || relativePath === ".." || path.isAbsolute(relativePath)) {
    throw new Error(`${nativePackage.name} exports a binary outside its package.`);
  }
  if (fs.existsSync(binaryPath) || !nativePackage.pattern) return binaryPath;
  return resolveNativeBinaryPath(
    packageRoot,
    packageRelativeBinary,
    nativePackage.pattern,
  );
}

function ensureNativeOptionalPackages(arch) {
  for (const nativePackage of nativeOptionalPackages(arch)) {
    const { name } = nativePackage;
    const packageDirectory = path.join(projectRoot, "node_modules", ...name.split("/"));
    const binaryPath = resolveNativePackageBinaryPath(packageDirectory, nativePackage);
    const locked = lockedPackage(name);
    const installedVersion = fs.existsSync(path.join(packageDirectory, "package.json"))
      ? JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")).version
      : null;
    if (installedVersion === locked.version && binaryPath && fs.existsSync(binaryPath)) {
      assertMachOArchitecture(fs.readFileSync(binaryPath), arch, name);
      continue;
    }
    const downloadDirectory = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".silo-native-"));
    try {
      run("npm", ["pack", `${name}@${locked.version}`, "--pack-destination", downloadDirectory]);
      const tarball = fs.readdirSync(downloadDirectory).find((file) => file.endsWith(".tgz"));
      if (!tarball) throw new Error(`npm pack did not produce ${name}.`);
      if (locked.integrity) {
        const digest = require("crypto").createHash(locked.integrity.split("-")[0])
          .update(fs.readFileSync(path.join(downloadDirectory, tarball))).digest("base64");
        if (`${locked.integrity.split("-")[0]}-${digest}` !== locked.integrity) {
          throw new Error(`${name} does not match package-lock.json integrity.`);
        }
      }
      fs.rmSync(packageDirectory, { recursive: true, force: true });
      fs.mkdirSync(packageDirectory, { recursive: true });
      run("tar", ["-xzf", path.join(downloadDirectory, tarball), "-C", packageDirectory, "--strip-components=1"]);
    } finally {
      fs.rmSync(downloadDirectory, { recursive: true, force: true });
    }
    const extractedBinaryPath = resolveNativePackageBinaryPath(packageDirectory, nativePackage);
    if (!extractedBinaryPath || !fs.existsSync(extractedBinaryPath)) {
      throw new Error(`Staged ${name} is missing its exported native binary.`);
    }
    assertMachOArchitecture(fs.readFileSync(extractedBinaryPath), arch, name);
  }
}

function assertPackagedNativeAddons(appPath, arch) {
  const unpacked = path.join(appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules");
  for (const nativePackage of nativeOptionalPackages(arch)) {
    const { name } = nativePackage;
    const packageDirectory = path.join(unpacked, ...name.split("/"));
    const binaryPath = resolveNativePackageBinaryPath(packageDirectory, nativePackage);
    if (!binaryPath || !fs.existsSync(binaryPath)) {
      throw new Error(`Packaged app is missing ${name}; ${arch} search indexing would fail.`);
    }
    assertMachOArchitecture(fs.readFileSync(binaryPath), arch, `Packaged ${name}`);
  }
}

const phoneTools = ["idevice_id", "ideviceinfo", "idevicepair", "afcclient", "idevicebackup2", "adb"];

function assertRequiredSourceArtifacts(arch) {
  const requiredLocations = [
    {
      label: "Face model directory",
      path: path.join(projectRoot, "node_modules", "@vladmandic", "face-api", "model"),
    },
    {
      label: "TensorFlow WASM runtime",
      path: path.join(projectRoot, "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist"),
    },
    {
      label: `Phone tools (${arch})`,
      path: path.join(projectRoot, "vendor", "phone-tools", `darwin-${arch}`),
    },
  ];

  for (const location of requiredLocations) {
    if (!fs.existsSync(location.path) || !fs.statSync(location.path).isDirectory()) {
      throw new Error(`${location.label} is missing: ${location.path}. Build cannot continue.`);
    }
  }

  const missingPhoneTools = phoneTools.filter((tool) => {
    const toolPath = path.join(projectRoot, "vendor", "phone-tools", `darwin-${arch}`, tool);
    return !fs.existsSync(toolPath) || !fs.statSync(toolPath).isFile();
  });
  if (missingPhoneTools.length) {
    throw new Error(
      `Phone tools are missing from vendor/phone-tools/darwin-${arch}: ${missingPhoneTools.join(", ")}. ` +
        "The packaged app will be incomplete without them.",
    );
  }

  for (const nativePackage of nativeOptionalPackages(arch)) {
    const packageDirectory = path.join(projectRoot, "node_modules", ...nativePackage.name.split("/"));
    const binaryPath = resolveNativePackageBinaryPath(packageDirectory, nativePackage);
    if (!binaryPath || !fs.existsSync(binaryPath)) {
      throw new Error(`Native dependency ${nativePackage.name} is missing its built binary before packaging.`);
    }
    assertMachOArchitecture(fs.readFileSync(binaryPath), arch, nativePackage.name);
  }
}

function ensurePhoneTools(arch) {
  run("bash", [path.join(projectRoot, "scripts", "build-phone-tools.sh"), arch]);
}

function assertPackagedPhoneTools(appPath, arch) {
  const directory = path.join(appPath, "Contents", "Resources", "phone-tools");
  for (const tool of phoneTools) {
    const toolPath = path.join(directory, tool);
    if (!fs.existsSync(toolPath)) {
      throw new Error(`Packaged app is missing ${tool}; ${arch} phones could not connect.`);
    }
    if ((fs.statSync(toolPath).mode & 0o111) === 0) {
      throw new Error(`Packaged ${tool} is not executable.`);
    }
    assertMachOArchitecture(fs.readFileSync(toolPath), arch, `Packaged ${tool}`);
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
  assertPackagedNativeAddons(appPath, expectedArchitecture);
  assertPackagedPhoneTools(appPath, expectedArchitecture);
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

  ensureNativeOptionalPackages(architecture);
  ensurePhoneTools(architecture);
  assertRequiredSourceArtifacts(architecture);
  run("npm", ["run", "build"]);
  run("npm", ["run", "release:check"]);

  const cacheRoot = process.env.SILO_TEMP_DIR
    ? path.resolve(process.env.SILO_TEMP_DIR)
    : path.join(projectRoot, "node_modules", ".cache");
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
        "config/packaging/electron-builder.config.cjs",
        "--mac",
        "dmg",
        "zip",
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
      // Release builds must keep one signing identity so updates keep macOS permissions.
      const requireStableSigning =
        process.env.SILO_TEST_DIR_ONLY !== "1" && process.env.SILO_ALLOW_ADHOC_SIGNING !== "1";
      run("npx", buildArguments, {
        env: { ...process.env, SILO_REQUIRE_STABLE_MAC_SIGNING: requireStableSigning ? "1" : "0" },
      });
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
  resolveNativeBinaryPath,
  resolveNativePackageBinaryPath,
  assertMachOArchitecture,
  assertPackagedMacApp,
  readMachOArchitectures,
  withTemporaryFfmpegBinary,
};
