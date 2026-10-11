import { createHash, verify } from "crypto";

const DEVICE_ID_PATTERN = /^[a-f0-9]{32}$/;
const UUID_PATTERN = /^[a-f0-9]{32}$/;
const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export interface PaidLicensePayload {
  version: 1;
  product: "silo";
  grant: "lifetime-purchase";
  deviceId: string;
  paymentSignature: string;
  verifiedAt: number;
}

export function createDeviceBindingId(
  platform: string,
  machineUuid: string,
): string {
  if (platform !== "darwin" && platform !== "win32")
    throw new Error("Silo lifetime licensing is not supported on this platform.");
  const normalizedUuid = machineUuid.toLowerCase().replace(/[^a-f0-9]/g, "");
  if (!UUID_PATTERN.test(normalizedUuid) || /^0+$/.test(normalizedUuid))
    throw new Error("Silo could not read this computer's stable system identifier.");
  return createHash("sha256")
    .update(`silo-paid-license-device-v1\0${platform}\0${normalizedUuid}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function isDeviceBindingId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

export function verifyPaidLicenseToken(
  token: unknown,
  expectedDeviceId: string,
  publicKeyPem: string,
): PaidLicensePayload | null {
  if (
    typeof token !== "string" ||
    token.length > 8192 ||
    !isDeviceBindingId(expectedDeviceId) ||
    !publicKeyPem.trim()
  )
    return null;

  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length) return null;
  const signature = decodeBase64Url(encodedSignature);
  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!signature || !payloadBytes) return null;

  try {
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(encodedPayload, "ascii"),
        publicKeyPem,
        signature,
      )
    )
      return null;
    const payload = JSON.parse(payloadBytes.toString("utf8")) as Partial<PaidLicensePayload>;
    if (
      payload.version !== 1 ||
      payload.product !== "silo" ||
      payload.grant !== "lifetime-purchase" ||
      payload.deviceId !== expectedDeviceId ||
      !isDeviceBindingId(payload.deviceId) ||
      typeof payload.paymentSignature !== "string" ||
      !SOLANA_SIGNATURE_PATTERN.test(payload.paymentSignature) ||
      typeof payload.verifiedAt !== "number" ||
      !Number.isFinite(payload.verifiedAt) ||
      payload.verifiedAt <= 0
    )
      return null;
    return payload as PaidLicensePayload;
  } catch {
    return null;
  }
}
