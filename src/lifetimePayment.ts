export const LIFETIME_PAYMENT_ADDRESS =
  "89Y6dpvpfTCBZjw2Xcb3KVVFTebdbGpzWTNEPMWEuMyu";
export const LIFETIME_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const LIFETIME_PAYMENT_MICRO_USDC = 25_000_000n;

const SOLANA_BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeSolanaPayReference(bytes: Uint8Array): string {
  if (bytes.length !== 32)
    throw new Error("A Solana Pay reference must contain 32 random bytes.");

  let value = BigInt(
    `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = SOLANA_BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0)
    leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + encoded;
}

export function isSolanaPayReference(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;

  let decoded = 0n;
  for (const character of value) {
    const digit = SOLANA_BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  const leadingZeroes = value.match(/^1*/)?.[0].length ?? 0;
  const decodedBytes = decoded === 0n ? 0 : Math.ceil(decoded.toString(16).length / 2);
  return leadingZeroes + decodedBytes === 32;
}

export function createLifetimeSolanaPayUri(reference: string): string {
  if (!isSolanaPayReference(reference))
    throw new Error("The Solana Pay reference is invalid.");

  const query = new URLSearchParams({
    amount: "25",
    "spl-token": LIFETIME_USDC_MINT,
    reference,
    label: "Silo Lifetime Access",
    message: "One-time lifetime license",
  });
  return `solana:${LIFETIME_PAYMENT_ADDRESS}?${query.toString()}`;
}

export type LifetimePaymentStatus =
  | "verified"
  | "pending"
  | "invalid"
  | "error"
  | "already-licensed";

export interface LifetimeLicenseState {
  isLicensed: boolean;
  licenseType?: "purchase" | "beta";
  signature?: string;
  verifiedAt?: number;
}

export interface LifetimePaymentVerification {
  status: LifetimePaymentStatus;
  message: string;
  license?: LifetimeLicenseState;
}

type JsonRecord = Record<string, unknown>;

interface TokenBalanceRecord {
  accountIndex: number;
  mint: string;
  owner?: string;
  amount: bigint;
  decimals: number;
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as JsonRecord;
}

function tokenBalances(value: unknown): TokenBalanceRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const balance = asRecord(item);
    const uiAmount = asRecord(balance?.uiTokenAmount);
    if (
      typeof balance?.accountIndex !== "number" ||
      typeof balance.mint !== "string" ||
      typeof uiAmount?.amount !== "string" ||
      typeof uiAmount.decimals !== "number"
    )
      return [];
    try {
      return [
        {
          accountIndex: balance.accountIndex,
          mint: balance.mint,
          owner: typeof balance.owner === "string" ? balance.owner : undefined,
          amount: BigInt(uiAmount.amount),
          decimals: uiAmount.decimals,
        },
      ];
    } catch {
      return [];
    }
  });
}

function parsedInstructions(message: JsonRecord, meta: JsonRecord): JsonRecord[] {
  const instructions = Array.isArray(message.instructions)
    ? [...message.instructions]
    : [];
  if (Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      const inner = asRecord(group)?.instructions;
      if (Array.isArray(inner)) instructions.push(...inner);
    }
  }
  return instructions.flatMap((instruction) => {
    const record = asRecord(instruction);
    return record ? [record] : [];
  });
}

function transactionAccountKeys(message: JsonRecord): string[] {
  if (!Array.isArray(message.accountKeys)) return [];
  return message.accountKeys.map((account) => {
    if (typeof account === "string") return account;
    const record = asRecord(account);
    return typeof record?.pubkey === "string" ? record.pubkey : "";
  });
}

export function isSolanaTransactionSignature(value: string): boolean {
  return value.length >= 80 &&
    value.length <= 90 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

export function verifyParsedLifetimePayment(
  signature: string,
  rpcResponse: unknown,
): LifetimePaymentVerification {
  if (!isSolanaTransactionSignature(signature))
    return {
      status: "invalid",
      message: "Paste the transaction signature shown by your Solana wallet.",
    };

  const response = asRecord(rpcResponse);
  if (!response)
    return {
      status: "error",
      message: "Solana returned an unreadable verification response.",
    };
  if (response.error)
    return {
      status: "error",
      message: "Solana could not verify this signature. Please try again.",
    };
  if (!("result" in response))
    return {
      status: "error",
      message: "Solana returned an incomplete verification response.",
    };
  if (response.result === null)
    return {
      status: "pending",
      message:
        "That transaction is not finalized yet. Wait a little, then verify again.",
    };

  const transactionResult = asRecord(response.result);
  const transaction = asRecord(transactionResult?.transaction);
  const message = asRecord(transaction?.message);
  const meta = asRecord(transactionResult?.meta);
  if (!transactionResult || !transaction || !message || !meta)
    return {
      status: "error",
      message: "Solana returned incomplete transaction details.",
    };
  if (meta.err !== null)
    return {
      status: "invalid",
      message: "This transaction failed on Solana, so no payment was received.",
    };

  const signatures = transaction.signatures;
  if (!Array.isArray(signatures) || !signatures.includes(signature))
    return {
      status: "invalid",
      message: "The transaction signature did not match the on-chain record.",
    };

  const preBalances = tokenBalances(meta.preTokenBalances);
  const postBalances = tokenBalances(meta.postTokenBalances);
  const preByIndex = new Map(
    preBalances.map((balance) => [balance.accountIndex, balance]),
  );
  const postByIndex = new Map(
    postBalances.map((balance) => [balance.accountIndex, balance]),
  );
  const accountKeys = transactionAccountKeys(message);
  const paymentAccounts = new Map<string, TokenBalanceRecord>();
  let netReceived = 0n;

  for (const postBalance of postBalances) {
    if (
      postBalance.owner !== LIFETIME_PAYMENT_ADDRESS ||
      postBalance.mint !== LIFETIME_USDC_MINT ||
      postBalance.decimals !== 6
    )
      continue;
    const preBalance = preByIndex.get(postBalance.accountIndex);
    const priorAmount =
      preBalance?.mint === LIFETIME_USDC_MINT ? preBalance.amount : 0n;
    const credit = postBalance.amount - priorAmount;
    if (credit > 0n) netReceived += credit;
    const accountAddress = accountKeys[postBalance.accountIndex];
    if (accountAddress) paymentAccounts.set(accountAddress, postBalance);
  }

  let transferAmount = 0n;
  for (const instruction of parsedInstructions(message, meta)) {
    const parsed = asRecord(instruction.parsed);
    const info = asRecord(parsed?.info);
    const instructionType =
      typeof parsed?.type === "string" ? parsed.type.toLowerCase() : "";
    if (
      !info ||
      (instructionType !== "transfer" &&
        instructionType !== "transferchecked") ||
      typeof info.destination !== "string"
    )
      continue;
    if (typeof info.mint === "string" && info.mint !== LIFETIME_USDC_MINT)
      continue;

    const paymentAccount = paymentAccounts.get(info.destination);
    if (!paymentAccount || paymentAccount.mint !== LIFETIME_USDC_MINT) continue;
    const tokenAmount = asRecord(info.tokenAmount);
    const rawAmount = tokenAmount?.amount ?? info.amount;
    const decimals = tokenAmount?.decimals ?? paymentAccount.decimals;
    if (typeof rawAmount !== "string" || decimals !== 6) continue;
    try {
      transferAmount += BigInt(rawAmount);
    } catch {
      continue;
    }
  }

  if (
    netReceived < LIFETIME_PAYMENT_MICRO_USDC ||
    transferAmount < LIFETIME_PAYMENT_MICRO_USDC
  )
    return {
      status: "invalid",
      message:
        "No finalized payment of at least 25 USDC on Solana to Silo was found in that transaction.",
    };

  return {
    status: "verified",
    message: "Payment verified on Solana. Your lifetime license is saved on this Mac.",
  };
}
