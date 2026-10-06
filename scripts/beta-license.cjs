const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const publicKeySourcePath = path.join(
  projectRoot,
  "src",
  "betaLicensePublicKey.ts",
);
const privateKeyPath = process.env.SILO_BETA_LICENSE_KEY_PATH || path.join(
  os.homedir(),
  ".config",
  "silo",
  "beta-license-private.pem",
);

function loadBetaLicenseModule() {
  const sourcePath = path.join(projectRoot, "src", "betaLicense.ts");
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

function readConfiguredPublicKey() {
  const source = fs.readFileSync(publicKeySourcePath, "utf8");
  const match = /export const BETA_LICENSE_PUBLIC_KEY = ("(?:\\.|[^"\\])*");/.exec(
    source,
  );
  if (!match) throw new Error("Could not read the beta public-key module.");
  return JSON.parse(match[1]);
}

function writePublicKey(publicKey) {
  fs.writeFileSync(
    publicKeySourcePath,
    `export const BETA_LICENSE_PUBLIC_KEY = ${JSON.stringify(publicKey)};\n`,
    { encoding: "utf8", mode: 0o644 },
  );
}

function init() {
  fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(privateKeyPath), 0o700);
  } catch {}

  const configuredPublicKey = readConfiguredPublicKey();
  if (fs.existsSync(privateKeyPath)) {
    const privateKey = fs.readFileSync(privateKeyPath, "utf8");
    const derivedPublicKey = crypto
      .createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" });
    if (configuredPublicKey && configuredPublicKey !== derivedPublicKey)
      throw new Error(
        "The saved signing key does not match the public key in this checkout. Restore the matching public key; do not rotate it for an existing release.",
      );
    if (!configuredPublicKey) writePublicKey(derivedPublicKey);
    fs.chmodSync(privateKeyPath, 0o600);
    console.log(`Beta signing key is ready: ${privateKeyPath}`);
    console.log("Keep this private key out of GitHub and all app packages.");
    console.log("Commit src/betaLicensePublicKey.ts before building releases.");
    return;
  }

  if (configuredPublicKey)
    throw new Error(
      "This checkout already has a beta public key, but its matching private key is missing. Restore the original private key securely; do not generate a replacement.",
    );

  const pair = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(privateKeyPath, pair.privateKey, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  writePublicKey(pair.publicKey);
  console.log(`Created the beta signing key: ${privateKeyPath}`);
  console.log("Keep this private key out of GitHub and all app packages.");
  console.log("Commit src/betaLicensePublicKey.ts before building releases.");
}

function grant(requestCode) {
  if (!requestCode) throw new Error("Usage: npm run beta:grant -- <request-code>");
  if (!fs.existsSync(privateKeyPath))
    throw new Error("No beta signing key found. Run npm run beta:keys first.");
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");
  const derivedPublicKey = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" });
  if (readConfiguredPublicKey() !== derivedPublicKey)
    throw new Error(
      "The app's public key does not match the signing key. Restore the matching public key before issuing grants.",
    );
  fs.chmodSync(privateKeyPath, 0o600);
  const { createBetaActivationCode } = loadBetaLicenseModule();
  console.log(createBetaActivationCode(requestCode, privateKey));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "init") init();
  else if (command === "grant") grant(args[0]);
  else {
    console.log("Commands:");
    console.log("  npm run beta:keys");
    console.log("  npm run beta:grant -- <request-code>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
