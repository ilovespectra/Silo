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
