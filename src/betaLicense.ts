import { sign, verify } from "crypto";

const REQUEST_CODE_PREFIX = "SILO-BETA-REQUEST-1";
const ACTIVATION_CODE_PREFIX = "SILO-BETA-LIFETIME-1";
const INSTALLATION_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface BetaActivationPayload {
  version: 1;
  product: "silo";
  grant: "lifetime-beta";
  installationId: string;
  issuedAt: number;
}

export interface BetaActivationInfo {
  requestCode: string;
  requestEmail: string;
  available: boolean;
}

export interface BetaActivationResult {
  status:
    | "activated"
    | "invalid"
    | "unavailable"
    | "already-licensed"
    | "error";
  message: string;
  license?: {
    isLicensed: boolean;
    licenseType?: "beta" | "purchase";
    signature?: string;
    verifiedAt?: number;
  };
}

export function createBetaRequestCode(installationId: string): string {
  if (!INSTALLATION_ID_PATTERN.test(installationId))
    throw new Error("Invalid Silo installation ID.");
  return `${REQUEST_CODE_PREFIX}.${installationId}`;
}

export function parseBetaRequestCode(requestCode: string): string | null {
  const match = new RegExp(`^${REQUEST_CODE_PREFIX}\\.([a-f0-9]{32})$`).exec(
    requestCode.trim(),
  );
  return match?.[1] ?? null;
}

export const BETA_ACTIVATION_REQUEST_EMAIL = "info@balkanbiskits.si";

export function createBetaActivationRequestMailto(requestCode: string): string {
  if (!parseBetaRequestCode(requestCode))
    throw new Error("Invalid Silo beta request code.");
  const parameters = new URLSearchParams({
    subject: "Silo lifetime beta activation request",
    body: [
      "Hello,",
      "",
      "I would like to request a free lifetime beta activation for this Silo installation.",
      "",
      `Silo beta request code: ${requestCode}`,
      "",
      "Thank you.",
    ].join("\n"),
  });
  return `mailto:${BETA_ACTIVATION_REQUEST_EMAIL}?${parameters.toString()}`;
}

export function createBetaActivationCode(
  requestCode: string,
  privateKeyPem: string,
  issuedAt = Date.now(),
): string {
  const installationId = parseBetaRequestCode(requestCode);
  if (!installationId) throw new Error("Invalid Silo beta request code.");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1)
    throw new Error("Invalid beta grant timestamp.");

  const payload: BetaActivationPayload = {
    version: 1,
    product: "silo",
    grant: "lifetime-beta",
    installationId,
    issuedAt,
  };
  const payloadText = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(payloadText, "utf8"), privateKeyPem);
  return [
    ACTIVATION_CODE_PREFIX,
    Buffer.from(payloadText, "utf8").toString("base64url"),
    signature.toString("base64url"),
  ].join(".");
}

export function verifyBetaActivationCode(
  activationCode: string,
  publicKeyPem: string,
  expectedInstallationId: string,
): BetaActivationPayload | null {
  if (
    !publicKeyPem.trim() ||
    !INSTALLATION_ID_PATTERN.test(expectedInstallationId) ||
    activationCode.length > 4096
  )
    return null;

  const [prefix, encodedPayload, encodedSignature, ...extra] =
    activationCode.trim().split(".");
  if (
    prefix !== ACTIVATION_CODE_PREFIX ||
    !encodedPayload ||
    !encodedSignature ||
    extra.length > 0 ||
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
    !/^[A-Za-z0-9_-]+$/.test(encodedSignature)
  )
    return null;

  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    const signature = Buffer.from(encodedSignature, "base64url");
    if (
      payloadBytes.toString("base64url") !== encodedPayload ||
      signature.toString("base64url") !== encodedSignature
    )
      return null;
    const payloadText = payloadBytes.toString("utf8");
    const value: unknown = JSON.parse(payloadText);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    )
      return null;
    const payload = value as Partial<BetaActivationPayload>;
    if (
      Object.keys(value).length !== 5 ||
      payload.version !== 1 ||
      payload.product !== "silo" ||
      payload.grant !== "lifetime-beta" ||
      payload.installationId !== expectedInstallationId ||
      !Number.isSafeInteger(payload.issuedAt) ||
      (payload.issuedAt ?? 0) < 1 ||
      JSON.stringify(payload) !== payloadText ||
      !verify(null, payloadBytes, publicKeyPem, signature)
    )
      return null;
    return payload as BetaActivationPayload;
  } catch {
    return null;
  }
}
