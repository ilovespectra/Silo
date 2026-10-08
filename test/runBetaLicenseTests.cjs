const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/betaLicense.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const betaModule = new Module(sourcePath, module);
betaModule.filename = sourcePath;
betaModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
betaModule._compile(compiled, sourcePath);

const {
  BETA_ACTIVATION_REQUEST_EMAIL,
  createBetaActivationCode,
  createBetaActivationRequestPayload,
  createBetaRequestCode,
  parseBetaRequestCode,
  verifyBetaActivationCode,
} = betaModule.exports;
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const installationId = "a1".repeat(16);
const otherInstallationId = "b2".repeat(16);
const requestCode = createBetaRequestCode(installationId);
const requestPayload = createBetaActivationRequestPayload(
  installationId,
  "2.0.0",
  "darwin",
  "2026-10-07T08:00:00.000Z",
);
const activationCode = createBetaActivationCode(requestCode, privateKey, 123456);
const tamperedActivationCode = activationCode.replace(/.$/, (lastCharacter) =>
  lastCharacter === "A" ? "B" : "A",
);

assert.strictEqual(parseBetaRequestCode(requestCode), installationId);
assert.strictEqual(BETA_ACTIVATION_REQUEST_EMAIL, "tani@kolektivkrog.si");
assert.deepStrictEqual(requestPayload, {
  requestCode,
  appVersion: "2.0.0",
  platform: "darwin",
  createdAt: "2026-10-07T08:00:00.000Z",
});
assert.strictEqual(parseBetaRequestCode(`${requestCode}x`), null);
assert.throws(() => createBetaRequestCode("not-an-installation-id"));
assert.throws(() => createBetaActivationRequestPayload("invalid-id", "2.0.0", "darwin"));
assert.throws(() =>
  createBetaActivationRequestPayload(installationId, "2.0.0", "darwin", "invalid-date"),
);
assert.deepStrictEqual(
  verifyBetaActivationCode(activationCode, publicKey, installationId),
  {
    version: 1,
    product: "silo",
    grant: "lifetime-beta",
    installationId,
    issuedAt: 123456,
  },
);
assert.strictEqual(
  verifyBetaActivationCode(activationCode, publicKey, otherInstallationId),
  null,
);
assert.strictEqual(
  verifyBetaActivationCode(activationCode, "", installationId),
  null,
);
assert.strictEqual(
  verifyBetaActivationCode(tamperedActivationCode, publicKey, installationId),
  null,
);
assert.throws(() => createBetaActivationCode("bad-request", privateKey));

console.log("Beta lifetime license tests passed.");
