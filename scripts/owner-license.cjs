const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const privateKeyPath = process.env.SILO_OWNER_SIGNING_KEY_PATH || path.join(
  os.homedir(),
  ".config",
  "silo",
  "owner-license-private.pem",
);
const publicKeyPath = process.env.SILO_OWNER_PUBLIC_KEY_PATH || path.join(
  os.homedir(),
  ".config",
  "silo",
  "owner-license-public.pem",
);

function readDeviceBindingId() {
  const raw = process.env.SILO_OWNER_DEVICE_ID || process.env.SILO_DEVICE_ID || "";
  if (!/^[a-f0-9]{32}$/.test(raw.trim())) {
    throw new Error("Set SILO_OWNER_DEVICE_ID (or SILO_DEVICE_ID) to the device binding ID to activate.");
  }
  return raw.trim();
}

function loadOwnerModule() {
  const sourcePath = path.join(projectRoot, "src", "ownerLicense.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const ts = require("typescript");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(compiled, sourcePath);
  return loaded.exports;
}

function init() {
  fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(privateKeyPath), 0o700); } catch {}

  if (fs.existsSync(privateKeyPath)) {
    const privateKey = fs.readFileSync(privateKeyPath, "utf8");
    const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
    fs.writeFileSync(publicKeyPath, publicKey, { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(privateKeyPath, 0o600);
    console.log(`Owner signing key is ready: ${privateKeyPath}`);
    console.log(`Public verification key: ${publicKeyPath}`);
    return;
  }

  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(privateKeyPath, pair.privateKey, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(publicKeyPath, pair.publicKey, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  console.log(`Created the owner signing key: ${privateKeyPath}`);
  console.log(`Saved the verification key: ${publicKeyPath}`);
}

function grant(deviceId) {
  if (!deviceId) throw new Error("Usage: npm run owner:grant -- <device-id>");
  if (!fs.existsSync(privateKeyPath))
    throw new Error("No owner signing key found. Run npm run owner:keys first.");
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");
  const { createOwnerAuthorizationToken } = loadOwnerModule();
  const token = createOwnerAuthorizationToken(deviceId.trim(), privateKey, "local-owner");
  console.log(token);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "init") init();
  else if (command === "grant") grant(args[0] || process.env.SILO_OWNER_DEVICE_ID);
  else {
    console.log("Commands:");
    console.log("  npm run owner:keys");
    console.log("  npm run owner:grant -- <device-id>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
