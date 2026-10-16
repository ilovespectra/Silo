const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");
const vm = require("vm");

const sourcePath = path.join(__dirname, "../src/lifetimePayment.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const paymentModule = new Module(sourcePath, module);
paymentModule.filename = sourcePath;
paymentModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
paymentModule._compile(compiled, sourcePath);

function loadTypeScriptModule(relativePath) {
  const modulePath = path.join(__dirname, "..", relativePath);
  const moduleSource = fs.readFileSync(modulePath, "utf8");
  const output = ts.transpileModule(moduleSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(modulePath, module);
  loaded.filename = modulePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(modulePath));
  loaded._compile(output, modulePath);
  return loaded.exports;
}

const betaLicenseModule = loadTypeScriptModule("src/betaLicense.ts");
const paidLicenseModule = loadTypeScriptModule("src/paidLicense.ts");
const ownerLicenseModule = loadTypeScriptModule("src/ownerLicense.ts");
const licensePolicyModule = loadTypeScriptModule("src/licensePolicy.ts");
const betaReleaseChecks = require("../scripts/check-beta-release.cjs");

const {
  LIFETIME_PAYMENT_ADDRESS,
  LIFETIME_PAYMENT_SUPPORT_GUIDANCE,
  LIFETIME_PAYMENT_MICRO_USDC,
  LIFETIME_USDC_MINT,
  createLifetimeSolanaPayUri,
  encodeSolanaPayReference,
  isSolanaPayReference,
  isSolanaTransactionSignature,
  verifyParsedLifetimePayment,
} = paymentModule.exports;

assert.match(LIFETIME_PAYMENT_SUPPORT_GUIDANCE, /Payment confirmed/i);
assert.match(LIFETIME_PAYMENT_SUPPORT_GUIDANCE, /Do not pay again/i);
assert.match(LIFETIME_PAYMENT_SUPPORT_GUIDANCE, /transaction signature/i);
assert.match(LIFETIME_PAYMENT_SUPPORT_GUIDANCE, /installation ID/i);

const signature = "5".repeat(88);
const makeRpcResponse = (options = {}) => {
  const receivedAmount = options.receivedAmount ?? "25000000";
  const transferAmount = options.transferAmount ?? "25000000";
  return {
    result: {
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [{ pubkey: "silo-usdc-token-account" }],
          instructions: [
            {
              program: "spl-token",
              parsed: {
                type: "transfer",
                info: {
                  destination: "silo-usdc-token-account",
                  amount: transferAmount,
                },
              },
            },
          ],
        },
      },
      meta: {
        err: options.failed ? { InstructionError: [0, "Custom"] } : null,
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: options.mint ?? LIFETIME_USDC_MINT,
            owner: options.owner ?? LIFETIME_PAYMENT_ADDRESS,
            uiTokenAmount: { amount: receivedAmount, decimals: 6 },
          },
        ],
      },
    },
  };
};

assert.strictEqual(isSolanaTransactionSignature(signature), true);
assert.strictEqual(isSolanaTransactionSignature("not-a-signature"), false);
const solanaPayReference = encodeSolanaPayReference(
  Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
);
assert.strictEqual(isSolanaPayReference(solanaPayReference), true);
assert.strictEqual(isSolanaPayReference("not-a-public-key"), false);
const solanaPayParameters = new URLSearchParams(
  createLifetimeSolanaPayUri(solanaPayReference).split("?")[1],
);
assert.strictEqual(
  createLifetimeSolanaPayUri(solanaPayReference).split("?")[0],
  `solana:${LIFETIME_PAYMENT_ADDRESS}`,
);
assert.strictEqual(solanaPayParameters.get("amount"), "25");
assert.strictEqual(solanaPayParameters.get("spl-token"), LIFETIME_USDC_MINT);
assert.strictEqual(solanaPayParameters.get("reference"), solanaPayReference);
assert.throws(() => createLifetimeSolanaPayUri("bad-reference"), /reference is invalid/);
assert.strictEqual(verifyParsedLifetimePayment(signature, makeRpcResponse()).status, "verified");
assert.strictEqual(LIFETIME_PAYMENT_MICRO_USDC, 25_000_000n);
assert.strictEqual(
  verifyParsedLifetimePayment(
    signature,
    makeRpcResponse({ receivedAmount: "25000000", transferAmount: "25000000" }),
    LIFETIME_PAYMENT_MICRO_USDC,
  ).status,
  "verified",
);
assert.strictEqual(
  verifyParsedLifetimePayment(
    signature,
    makeRpcResponse({ receivedAmount: "24999999", transferAmount: "24999999" }),
    LIFETIME_PAYMENT_MICRO_USDC,
  ).status,
  "invalid",
);
assert.strictEqual(
  verifyParsedLifetimePayment(
    signature,
    makeRpcResponse({ receivedAmount: "25000000", transferAmount: "25000000" }),
  ).status,
  "verified",
  "the direct wallet transfer path requires the full 25 USDC",
);
assert.strictEqual(
  verifyParsedLifetimePayment(signature, makeRpcResponse({ receivedAmount: "24999999" })).status,
  "invalid",
);
assert.strictEqual(
  verifyParsedLifetimePayment(signature, makeRpcResponse({ transferAmount: "24999999" })).status,
  "invalid",
);
assert.strictEqual(
  verifyParsedLifetimePayment(signature, makeRpcResponse({ owner: "someone-else" })).status,
  "invalid",
);
assert.strictEqual(
  verifyParsedLifetimePayment(signature, makeRpcResponse({ mint: "bridged-token" })).status,
  "invalid",
);
assert.strictEqual(
  verifyParsedLifetimePayment(signature, makeRpcResponse({ failed: true })).status,
  "invalid",
);
assert.strictEqual(verifyParsedLifetimePayment(signature, { result: null }).status, "pending");

console.log("Lifetime payment verification tests passed.");

{
  const { extractSolanaTransactionSignature } = paymentModule.exports;
  const reference = encodeSolanaPayReference(new Uint8Array(32).fill(7));
  const uri = createLifetimeSolanaPayUri(reference);
  assert.ok(!uri.includes("+"), "Solana Pay URI must percent-encode spaces");
  assert.ok(uri.includes("label=Silo%20Lifetime%20Access"));
  assert.ok(uri.startsWith("solana:89Y6dpvpfTCBZjw2Xcb3KVVFTebdbGpzWTNEPMWEuMyu?amount=25&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference="));
  const sig = "5".repeat(88);
  assert.strictEqual(extractSolanaTransactionSignature(`  ${sig} `), sig);
  assert.strictEqual(extractSolanaTransactionSignature(`https://solscan.io/tx/${sig}`), sig);
  assert.strictEqual(extractSolanaTransactionSignature(`https://explorer.solana.com/tx/${sig}?cluster=mainnet-beta`), sig);
  assert.strictEqual(extractSolanaTransactionSignature(`https://solana.fm/tx/${sig}/`), sig);
  assert.strictEqual(extractSolanaTransactionSignature("solana:abc"), null);
  assert.strictEqual(extractSolanaTransactionSignature("not a signature"), null);
}


// Exercise the license gate from src/main.ts itself with isolated license files
// and mocked relay responses. This guards against locally fabricated v1/v2 receipts.
const mainPath = path.join(__dirname, "../src/main.ts");
const mainText = fs.readFileSync(mainPath, "utf8");
const mainAst = ts.createSourceFile("main.ts", mainText, ts.ScriptTarget.Latest, true);
const extractedFunctions = new Map();
(function findLicenseFunctions(node) {
  if (
    ts.isFunctionDeclaration(node) &&
    (node.name?.text === "readLifetimeLicense" ||
      node.name?.text === "migrateLegacyLifetimeLicense" ||
      node.name?.text === "shouldRejectLicenseForCurrentBuild")
  )
    extractedFunctions.set(node.name.text, node.getText(mainAst));
  ts.forEachChild(node, findLicenseFunctions);
})(mainAst);
assert.ok(extractedFunctions.has("readLifetimeLicense"));
assert.ok(extractedFunctions.has("migrateLegacyLifetimeLicense"));

function makeLicenseHarness({ files = {}, env = {}, relayResponse, minimumVersion = "2.1.0" } = {}) {
  const licenseFiles = new Map(Object.entries(files));
  const calls = [];
  const logs = [];
  const writes = [];
  const deviceId = "a".repeat(32);
  const licensePath = "/sandbox/lifetime-license.json";
  const betaPath = "/sandbox/beta-license.json";
  const rejectionPath = "/sandbox/license-rejection.json";
  const FixedDate = class extends Date {
    static now() { return 0; }
  };
  const context = vm.createContext({
    URL,
    Date: FixedDate,
    JSON,
    Number,
    String,
    Error,
    Promise,
    process: { env, platform: "darwin", arch: "x64" },
    app: { getVersion: () => "2.1.7" },
    fsPromises: {
      readFile: async (filePath) => {
        if (!licenseFiles.has(filePath)) throw new Error("ENOENT");
        return licenseFiles.get(filePath);
      },
    },
    lifetimeLicensePath: licensePath,
    betaLicensePath: betaPath,
    lifetimeLicenseRejectionPath: rejectionPath,
    lifetimePaymentRelayBaseUrl: "https://license.example",
    resolveMinimumLicenseBuildVersion: () => minimumVersion,
    isBuildBlockedByReleaseCutoff: licensePolicyModule.isBuildBlockedByReleaseCutoff,
    isVersionAtLeast: licensePolicyModule.isVersionAtLeast,
    isDeviceBindingId: (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value),
    getDeviceBindingId: async () => deviceId,
    getBetaInstallationId: async () => "b".repeat(32),
    verifyPaidLicenseToken: (token, expectedDeviceId) =>
      token === "valid-v3" && expectedDeviceId === deviceId
        ? { paymentSignature: "signed-payment", verifiedAt: 1234 }
        : null,
    verifyBetaActivationCode: (code) =>
      code === "valid-beta" ? { issuedAt: 2345 } : null,
    BETA_LICENSE_PUBLIC_KEY: "test-beta-key",
    PAID_LICENSE_PUBLIC_KEY: "test-paid-key",
    LIFETIME_PAYMENT_ADDRESS: "payment-address",
    LIFETIME_USDC_MINT: "usdc-mint",
    isSolanaTransactionSignature: (value) =>
      typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value),
    isLegacyLicenseRejected: async () => false,
    persistLegacyLicenseRejection: async () => {},
    disableLifetimeFeatures: () => {},
    writeLifetimeLicense: async (token, id) => writes.push({ token, id }),
    runtimeLog: (...entry) => logs.push(entry),
    requestRelayJson: async (url, options) => {
      calls.push({ url: String(url), options });
      if (relayResponse instanceof Error) throw relayResponse;
      return relayResponse ?? { ok: false, statusCode: 503, payload: {} };
    },
    isSignedEntitlementAllowed: (payload) => payload?.valid === true,
  });
  for (const [name, functionText] of extractedFunctions) {
    const compiledFunction = ts.transpileModule(
      `${functionText}\nglobalThis.__${name} = ${name};`,
      {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText;
    vm.runInContext(compiledFunction, context, { timeout: 1000 });
  }
  return {
    read: () => context.__readLifetimeLicense(),
    migrate: () => context.__migrateLegacyLifetimeLicense(),
    calls,
    logs,
    writes,
    licenseFiles,
    licensePath,
    deviceId,
  };
}

const plainLicenseValue = (value) => JSON.parse(JSON.stringify(value));

(async () => {
  const signature = "5".repeat(88);
  assert.strictEqual(licensePolicyModule.isVersionAtLeast("2.1.7", "2.1.0"), true);
  assert.strictEqual(licensePolicyModule.isVersionAtLeast("2.1.7", "2.1.8"), false);
  assert.strictEqual(
    licensePolicyModule.isBuildBlockedByReleaseCutoff("2.1.7", "2.1.8"),
    true,
    "a build below its configured minimum must be blocked",
  );

  const blockedBuild = makeLicenseHarness({ minimumVersion: "2.1.8" });
  assert.deepStrictEqual(plainLicenseValue(await blockedBuild.read()), { isLicensed: false });
  assert.ok(blockedBuild.logs.some(([event]) => event === "app-version-below-license-cutoff"));

  for (const version of [1, 2]) {
    const legacy = {
      version,
      network: "solana-mainnet",
      paymentAddress: "payment-address",
      usdcMint: "usdc-mint",
      signature,
      verifiedAt: 1234,
      ...(version === 2 ? { installationId: "b".repeat(32) } : {}),
    };
    const harness = makeLicenseHarness({
      files: { ["/sandbox/lifetime-license.json"]: JSON.stringify(legacy) },
    });
    assert.deepStrictEqual(plainLicenseValue(await harness.read()), { isLicensed: false },
      `legacy v${version} receipt must not unlock offline`);
    assert.strictEqual(harness.calls.length, 0,
      `legacy v${version} receipt must be verified by startup migration, not accepted by local read`);
  }

  const localPurchase = makeLicenseHarness({
    env: {
      SILO_ENTITLEMENT_URL: "https://entitlement.example",
      SILO_RELAY_PUBLIC_KEY_PEM: "relay-key",
    },
    files: {
      ["/sandbox/lifetime-license.json"]: JSON.stringify({
        version: 3,
        deviceId: "a".repeat(32),
        licenseToken: "valid-v3",
      }),
    },
    relayResponse: new Error("offline"),
  });
  assert.deepStrictEqual(plainLicenseValue(await localPurchase.read()), {
    isLicensed: true,
    licenseType: "purchase",
    signature: "signed-payment",
    verifiedAt: 1234,
  }, "a valid signed v3 purchase must remain available offline");
  assert.strictEqual(localPurchase.calls.length, 0,
    "a signed local purchase must be checked before the optional relay");

  for (const staleMetadata of [
    { appVersion: "2.0.0" },
    { minimumRequiredVersion: "2.1.8" },
  ]) {
    const stalePurchase = makeLicenseHarness({
      files: {
        ["/sandbox/lifetime-license.json"]: JSON.stringify({
          version: 3,
          deviceId: "a".repeat(32),
          licenseToken: "valid-v3",
          ...staleMetadata,
        }),
      },
    });
    assert.deepStrictEqual(plainLicenseValue(await stalePurchase.read()), { isLicensed: false },
      "signed licenses outside the current build policy must not unlock full access");
  }

  const localBeta = makeLicenseHarness({
    env: {
      SILO_ENTITLEMENT_URL: "https://entitlement.example",
      SILO_RELAY_PUBLIC_KEY_PEM: "relay-key",
    },
    files: {
      ["/sandbox/beta-license.json"]: JSON.stringify({ activationCode: "valid-beta" }),
    },
    relayResponse: new Error("offline"),
  });
  assert.deepStrictEqual(plainLicenseValue(await localBeta.read()), {
    isLicensed: true,
    licenseType: "beta",
    verifiedAt: 2345,
  }, "a valid signed beta activation must remain available offline");
  assert.strictEqual(localBeta.calls.length, 0,
    "a signed beta activation must be checked before the optional relay");

  const relayPurchase = makeLicenseHarness({
    env: {
      SILO_ENTITLEMENT_URL: "https://entitlement.example",
      SILO_RELAY_PUBLIC_KEY_PEM: "relay-key",
    },
    relayResponse: {
      ok: true,
      statusCode: 200,
      payload: { valid: true, nonce: "relay-proof" },
    },
  });
  assert.deepStrictEqual(plainLicenseValue(await relayPurchase.read()), {
    isLicensed: true,
    licenseType: "purchase",
    signature: "relay-proof",
    verifiedAt: 0,
  }, "a valid relay entitlement can grant access when no local license is present");
  assert.strictEqual(relayPurchase.calls.length, 1);

  const migration = makeLicenseHarness({
    files: {
      ["/sandbox/lifetime-license.json"]: JSON.stringify({
        version: 1,
        network: "solana-mainnet",
        paymentAddress: "payment-address",
        usdcMint: "usdc-mint",
        signature,
        verifiedAt: 1234,
      }),
    },
    relayResponse: {
      ok: true,
      statusCode: 200,
      payload: {
        status: "verified",
        installationId: "a".repeat(32),
        licenseToken: "signed-v3-from-relay",
      },
    },
  });
  await migration.migrate();
  assert.strictEqual(migration.calls.length, 1,
    "a legacy receipt must be submitted to the relay for one-time verification");
  assert.match(migration.calls[0].url, /\/api\/license\/claim-legacy$/);
  assert.deepStrictEqual(plainLicenseValue(migration.calls[0].options.body), {
    installationId: "a".repeat(32),
    signature,
  });
  assert.deepStrictEqual(plainLicenseValue(migration.writes), [
    { token: "signed-v3-from-relay", id: "a".repeat(32) },
  ], "the relay-verified legacy purchase must be saved as a signed local license");


  // The former separate paid-license, beta-license, owner-license, beta-release,
  // and legacy-rejection runners were removed while package scripts still named
  // them. Keep their core coverage together here so release checks stay runnable.
  const {
    createDeviceBindingId,
    verifyPaidLicenseToken,
  } = paidLicenseModule;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const rawUuid = "7C4A1E20-3F89-4D1B-9CA8-810C21E88A10";
  const deviceA = createDeviceBindingId("darwin", rawUuid);
  const deviceB = createDeviceBindingId(
    "darwin",
    "CD80298A-9B42-4D5A-A3B8-02CDB10400F4",
  );
  const windowsDevice = createDeviceBindingId("win32", rawUuid);
  assert.match(deviceA, /^[a-f0-9]{32}$/);
  assert.strictEqual(
    createDeviceBindingId("darwin", rawUuid.toLowerCase().replaceAll("-", "")),
    deviceA,
    "UUID formatting changes must preserve the paid device binding",
  );
  assert.notStrictEqual(deviceA, deviceB);
  assert.notStrictEqual(deviceA, windowsDevice);
  assert.throws(() => createDeviceBindingId("linux", rawUuid), /not supported/);
  assert.throws(
    () => createDeviceBindingId("darwin", "0".repeat(32)),
    /stable system identifier/,
  );

  const paidPayload = {
    version: 1,
    product: "silo",
    grant: "lifetime-purchase",
    deviceId: deviceA,
    paymentSignature: "5".repeat(88),
    verifiedAt: 1791710000000,
  };
  const encodedPaidPayload = Buffer.from(JSON.stringify(paidPayload), "utf8").toString("base64url");
  const paidSignature = crypto
    .sign("RSA-SHA256", Buffer.from(encodedPaidPayload, "ascii"), privateKey)
    .toString("base64url");
  const paidToken = `${encodedPaidPayload}.${paidSignature}`;
  assert.deepStrictEqual(
    verifyPaidLicenseToken(paidToken, deviceA, publicKey),
    paidPayload,
    "a server-signed purchase token should verify on its bound device",
  );
  assert.strictEqual(
    verifyPaidLicenseToken(paidToken, deviceB, publicKey),
    null,
    "a paid token copied to another device must be rejected",
  );
  const alteredPaidPayload = Buffer.from(
    JSON.stringify({ ...paidPayload, grant: "lifetime-beta" }),
  ).toString("base64url");
  assert.strictEqual(
    verifyPaidLicenseToken(`${alteredPaidPayload}.${paidSignature}`, deviceA, publicKey),
    null,
    "editing local license fields must invalidate the signature",
  );
  assert.strictEqual(
    verifyPaidLicenseToken(`${encodedPaidPayload}.${paidSignature}.extra`, deviceA, publicKey),
    null,
  );

  const {
    createBetaActivationCode,
    createBetaActivationRequestPayload,
    createBetaActivationUrl,
    createBetaRequestCode,
    parseBetaActivationUrl,
    parseBetaRequestCode,
    verifyBetaActivationCode,
  } = betaLicenseModule;
  const betaKeys = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const installationId = "a1".repeat(16);
  const otherInstallationId = "b2".repeat(16);
  const requestCode = createBetaRequestCode(installationId);
  const requestPayload = createBetaActivationRequestPayload(
    installationId,
    "2.1.7",
    "darwin",
    "2026-10-07T08:00:00.000Z",
  );
  const activationCode = createBetaActivationCode(
    requestCode,
    betaKeys.privateKey,
    123456,
  );
  const activationParts = activationCode.split(".");
  activationParts[2] = `${activationParts[2].slice(0, -1)}${activationParts[2].endsWith("A") ? "B" : "A"}`;
  const tamperedActivationCode = activationParts.join(".");
  assert.strictEqual(parseBetaRequestCode(requestCode), installationId);
  assert.strictEqual(parseBetaRequestCode(`${requestCode}x`), null);
  assert.deepStrictEqual(requestPayload, {
    requestCode,
    installationId,
    appVersion: "2.1.7",
    platform: "darwin",
    createdAt: "2026-10-07T08:00:00.000Z",
  });
  assert.throws(() => createBetaRequestCode("invalid-id"));
  assert.throws(() => createBetaActivationRequestPayload("invalid-id", "2.1.7", "darwin"));
  assert.deepStrictEqual(
    verifyBetaActivationCode(activationCode, betaKeys.publicKey, installationId),
    {
      version: 1,
      product: "silo",
      grant: "lifetime-beta",
      installationId,
      issuedAt: 123456,
    },
  );
  assert.strictEqual(
    verifyBetaActivationCode(requestCode, betaKeys.publicKey, installationId),
    null,
    "a beta request code must not itself activate a license",
  );
  assert.strictEqual(
    verifyBetaActivationCode(activationCode, betaKeys.publicKey, otherInstallationId),
    null,
  );
  assert.strictEqual(verifyBetaActivationCode(activationCode, "", installationId), null);
  assert.strictEqual(
    verifyBetaActivationCode(tamperedActivationCode, betaKeys.publicKey, installationId),
    null,
  );
  const activationUrl = createBetaActivationUrl(activationCode);
  assert.strictEqual(parseBetaActivationUrl(activationUrl), activationCode);
  assert.strictEqual(parseBetaActivationUrl(`${activationUrl}&code=duplicate`), null);
  assert.strictEqual(parseBetaActivationUrl("https://example.com/?code=ignored"), null);
  assert.throws(() => createBetaActivationCode("bad-request", betaKeys.privateKey));

  const {
    createOwnerAuthorizationToken,
    readOwnerAuthorizationToken,
    verifyOwnerAuthorizationToken,
  } = ownerLicenseModule;
  const ownerToken = createOwnerAuthorizationToken(deviceA, privateKey, "test-owner");
  const ownerPayload = verifyOwnerAuthorizationToken(ownerToken, deviceA, publicKey);
  assert.strictEqual(ownerPayload?.deviceId, deviceA);
  assert.strictEqual(ownerPayload?.ownerId, "test-owner");
  assert.strictEqual(verifyOwnerAuthorizationToken(ownerToken, deviceB, publicKey), null);
  assert.strictEqual(verifyOwnerAuthorizationToken(`${ownerToken}.extra`, deviceA, publicKey), null);
  assert.strictEqual(
    readOwnerAuthorizationToken(deviceA, publicKey),
    null,
    "local owner tokens must never grant full access in a cloned build",
  );

  const releasePublicSource = `export const BETA_LICENSE_PUBLIC_KEY = ${JSON.stringify(betaKeys.publicKey)};\n`;
  assert.strictEqual(
    betaReleaseChecks.readPublicKeyFromSource(releasePublicSource),
    betaKeys.publicKey,
  );
  assert.ok(betaReleaseChecks.normalizeBetaPublicKey(betaKeys.publicKey));
  assert.throws(() => betaReleaseChecks.normalizeBetaPublicKey(""), /npm run beta:keys/);
  assert.throws(
    () => betaReleaseChecks.normalizeBetaPublicKey(betaKeys.privateKey),
    /private key/,
  );
  assert.strictEqual(betaReleaseChecks.containsPrivateKeyMaterial(betaKeys.privateKey), true);
  assert.strictEqual(betaReleaseChecks.containsPrivateKeyMaterial(betaKeys.publicKey), false);
  assert.strictEqual(betaReleaseChecks.isPrivateKeyFileName("/release/beta-license-private.pem"), true);
  assert.strictEqual(betaReleaseChecks.isPrivateKeyFileName("/release/betaLicensePublicKey.js"), false);
  assert.doesNotThrow(() =>
    betaReleaseChecks.assertNoPrivateKeyMaterial([
      path.join(__dirname, "../src/betaLicensePublicKey.ts"),
    ]),
  );
  assert.throws(
    () => betaReleaseChecks.assertNoPrivateKeyMaterial(["/release/beta-license-private.pem"]),
    /Private signing-key material/,
  );
  assert.doesNotThrow(() =>
    betaReleaseChecks.assertRequiredLicenseHandlers(
      '"get-beta-activation-info" "silo://beta-activate" "verify-lifetime-payment"',
    ),
  );
  assert.throws(
    () => betaReleaseChecks.assertRequiredLicenseHandlers('"verify-lifetime-payment"'),
    /missing beta activation or payment handling/,
  );
  assert.doesNotThrow(() =>
    betaReleaseChecks.assertSolanaPayPanel(
      "Pay with Solana Pay lifetime-solana-qr openLifetimePaymentLink",
    ),
  );
  assert.throws(
    () => betaReleaseChecks.assertSolanaPayPanel("missing panel"),
    /missing the Solana Pay QR panel/,
  );

  const legacySourcePath = path.join(__dirname, "../src/legacyLicenseRejection.ts");
  const legacySource = fs.readFileSync(legacySourcePath, "utf8");
  const legacyAst = ts.createSourceFile("legacyLicenseRejection.ts", legacySource, ts.ScriptTarget.Latest, true);
  const legacyFunctions = new Map();
  (function findLegacyFunctions(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      (node.name?.text === "signatureHash" ||
        node.name?.text === "isLegacyLicenseRejected" ||
        node.name?.text === "persistLegacyLicenseRejection")
    )
      legacyFunctions.set(
        node.name.text,
        node.getText(legacyAst).replace(/^export\s+/, ""),
      );
    ts.forEachChild(node, findLegacyFunctions);
  })(legacyAst);
  const rejectionFiles = new Map();
  const legacyContext = vm.createContext({
    createHash: crypto.createHash,
    fsPromises: {
      readFile: async (filePath) => {
        if (!rejectionFiles.has(filePath)) {
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        }
        return rejectionFiles.get(filePath);
      },
      mkdir: async () => {},
      writeFile: async (filePath, data) => rejectionFiles.set(filePath, String(data)),
      rename: async (fromPath, toPath) => {
        rejectionFiles.set(toPath, rejectionFiles.get(fromPath));
        rejectionFiles.delete(fromPath);
      },
    },
    path: { dirname: () => "/sandbox" },
    process: { pid: 123 },
    Date,
    JSON,
    Number,
    String,
    Error,
    Promise,
    RegExp,
  });
  for (const [name, functionText] of legacyFunctions) {
    const output = ts.transpileModule(
      `${functionText}\nglobalThis.__${name} = ${name};`,
      {
        compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 },
      },
    ).outputText;
    vm.runInContext(output, legacyContext, { timeout: 1000 });
  }
  const rejectionPath = "/sandbox/license-rejection.json";
  const legacyPaidSignature = "5".repeat(88);
  assert.strictEqual(await legacyContext.__isLegacyLicenseRejected(rejectionPath, legacyPaidSignature), false);
  await legacyContext.__persistLegacyLicenseRejection(rejectionPath, legacyPaidSignature, 1234);
  assert.strictEqual(await legacyContext.__isLegacyLicenseRejected(rejectionPath, legacyPaidSignature), true);
  assert.strictEqual(await legacyContext.__isLegacyLicenseRejected(rejectionPath, "4".repeat(88)), false);
  assert.ok(!rejectionFiles.get(rejectionPath).includes(legacyPaidSignature),
    "the rejection marker stores a digest instead of the transaction signature");
  rejectionFiles.set(rejectionPath, "not-json");
  await assert.rejects(
    legacyContext.__isLegacyLicenseRejected(rejectionPath, legacyPaidSignature),
    /JSON|Unexpected token/,
    "corrupt rejection state must not restore legacy offline access",
  );

  console.log("Payment, paid/beta/owner license, release-gate, and legacy-rejection tests passed.");
  console.log("License gate regression tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
