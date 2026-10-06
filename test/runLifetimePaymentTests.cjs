const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

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

const {
  LIFETIME_PAYMENT_ADDRESS,
  LIFETIME_USDC_MINT,
  createLifetimeSolanaPayUri,
  encodeSolanaPayReference,
  isSolanaPayReference,
  isSolanaTransactionSignature,
  verifyParsedLifetimePayment,
} = paymentModule.exports;

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
