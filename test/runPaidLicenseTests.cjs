const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

function loadTypeScript(relativePath) {
  const sourcePath = path.join(__dirname, "..", "src", relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
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

const { createDeviceBindingId, verifyPaidLicenseToken } =
  loadTypeScript("paidLicense.ts");
const { PAID_LICENSE_PUBLIC_KEY } = loadTypeScript("paidLicensePublicKey.ts");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
crypto.createPublicKey(PAID_LICENSE_PUBLIC_KEY);
const rawUuidA = "7C4A1E20-3F89-4D1B-9CA8-810C21E88A10";
const rawUuidB = "CD80298A-9B42-4D5A-A3B8-02CDB10400F4";
const deviceA = createDeviceBindingId("darwin", rawUuidA);
const deviceB = createDeviceBindingId("darwin", rawUuidB);
const deviceWindows = createDeviceBindingId("win32", rawUuidA);
assert.match(deviceA, /^[a-f0-9]{32}$/);
assert.strictEqual(
  createDeviceBindingId("darwin", rawUuidA.toLowerCase().replaceAll("-", "")),
  deviceA,
  "stable UUID spelling changes must preserve the same device binding",
);
assert.notStrictEqual(deviceA, deviceB);
assert.notStrictEqual(deviceA, deviceWindows);
assert.throws(() => createDeviceBindingId("linux", rawUuidA), /not supported/);
assert.throws(() => createDeviceBindingId("darwin", "0".repeat(32)), /stable system identifier/);

const payload = {
  version: 1,
  product: "silo",
  grant: "lifetime-purchase",
  deviceId: deviceA,
  paymentSignature: "5".repeat(88),
  verifiedAt: 1791710000000,
};
const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
const signature = crypto
  .sign("RSA-SHA256", Buffer.from(encodedPayload, "ascii"), privateKey)
  .toString("base64url");
const token = `${encodedPayload}.${signature}`;

assert.deepStrictEqual(
  verifyPaidLicenseToken(token, deviceA, publicKey),
  payload,
  "a valid server-signed token must activate on its bound computer",
);
assert.strictEqual(
  verifyPaidLicenseToken(token, deviceB, publicKey),
  null,
  "copying a valid license token to another computer must not activate it",
);
assert.deepStrictEqual(
  verifyPaidLicenseToken(token, deviceA, publicKey),
  verifyPaidLicenseToken(token, deviceA, publicKey),
  "the licensed computer can revalidate the same token offline repeatedly",
);

const tamperedPayload = { ...payload, grant: "lifetime-beta" };
const tamperedEncodedPayload = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url");
assert.strictEqual(
  verifyPaidLicenseToken(`${tamperedEncodedPayload}.${signature}`, deviceA, PAID_LICENSE_PUBLIC_KEY),
  null,
  "editing the local license record must invalidate its signature",
);
const tamperedSignature = `${signature.slice(0, -2)}AA`;
assert.strictEqual(
  verifyPaidLicenseToken(`${encodedPayload}.${tamperedSignature}`, deviceA, PAID_LICENSE_PUBLIC_KEY),
  null,
);
assert.strictEqual(
  verifyPaidLicenseToken(`${encodedPayload}.${signature}.extra`, deviceA, publicKey),
  null,
);

console.log("Paid-license device binding and signature tests passed.");
