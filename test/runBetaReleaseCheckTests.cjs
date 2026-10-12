const assert = require("assert");
const crypto = require("crypto");
const {
  assertNoPrivateKeyMaterial,
  assertRequiredLicenseHandlers,
  containsPrivateKeyMaterial,
  isPrivateKeyFileName,
  normalizeBetaPublicKey,
  readPublicKeyFromSource,
} = require("../scripts/check-beta-release.cjs");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const publicKeySource = `export const BETA_LICENSE_PUBLIC_KEY = ${JSON.stringify(publicKey)};\n`;

assert.strictEqual(readPublicKeyFromSource(publicKeySource), publicKey);
assert.strictEqual(normalizeBetaPublicKey(publicKey), publicKey);
assert.throws(() => normalizeBetaPublicKey(""), /npm run beta:keys/);
assert.throws(() => normalizeBetaPublicKey(privateKey), /must not contain a private key/);
assert.strictEqual(
  containsPrivateKeyMaterial("-----BEGIN PRIVATE KEY-----"),
  true,
);
assert.strictEqual(
  containsPrivateKeyMaterial("-----BEGIN PUBLIC KEY-----"),
  false,
);
assert.strictEqual(
  isPrivateKeyFileName("/release/beta-license-private.pem"),
  true,
);
assert.strictEqual(isPrivateKeyFileName("/release/betaLicensePublicKey.js"), false);
assert.doesNotThrow(() =>
  assertNoPrivateKeyMaterial([require.resolve("../src/betaLicensePublicKey.ts")]),
);
assert.doesNotThrow(() =>
  assertRequiredLicenseHandlers(
    '"get-beta-activation-info" "silo://beta-activate" "verify-lifetime-payment"',
  ),
);
assert.throws(
  () => assertRequiredLicenseHandlers('"get-beta-activation-info" "verify-lifetime-payment"'),
  /missing beta activation or payment handling/,
);

console.log("Beta release-check tests passed.");
