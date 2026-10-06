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
  createBetaActivationCode,
  createBetaActivationRequestMailto,
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
const requestMailto = new URL(createBetaActivationRequestMailto(requestCode));
const activationCode = createBetaActivationCode(requestCode, privateKey, 123456);
const tamperedActivationCode = activationCode.replace(/.$/, (lastCharacter) =>
  lastCharacter === "A" ? "B" : "A",
);

assert.strictEqual(parseBetaRequestCode(requestCode), installationId);
assert.strictEqual(requestMailto.protocol, "mailto:");
assert.strictEqual(requestMailto.pathname, "info@balkanbiskits.si");
assert.match(requestMailto.searchParams.get("subject"), /beta activation request/i);
assert.ok(requestMailto.searchParams.get("body").includes(requestCode));
assert.strictEqual(parseBetaRequestCode(`${requestCode}x`), null);
assert.throws(() => createBetaRequestCode("not-an-installation-id"));
assert.throws(() => createBetaActivationRequestMailto("invalid-request-code"));
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
