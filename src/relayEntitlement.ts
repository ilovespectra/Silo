import { createPublicKey, verify } from "crypto";

export interface SignedEntitlement {
  status: "allowed" | "denied";
  deviceId: string;
  appVersion: string;
  minimumRequiredVersion: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
}

export function canonicalizeEntitlementPayload(payload: Omit<SignedEntitlement, "signature">): string {
  return JSON.stringify({
    status: payload.status,
    deviceId: payload.deviceId,
    appVersion: payload.appVersion,
    minimumRequiredVersion: payload.minimumRequiredVersion,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  });
}

export function verifyRelaySignature(
  payload: Omit<SignedEntitlement, "signature">,
  signatureB64Url: string,
  publicKeyPem: string,
): boolean {
  if (!publicKeyPem.trim()) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    const buffer = Buffer.from(canonicalizeEntitlementPayload(payload), "utf8");
    const signature = Buffer.from(signatureB64Url, "base64url");
    const algorithm =
      (key as { asymmetricKey?: { type?: string } }).asymmetricKey?.type?.toLowerCase() === "ed25519"
        ? "ed25519"
        : "RSA-SHA256";
    return verify(algorithm, buffer, key, signature);
  } catch {
    return false;
  }
}

export function isSignedEntitlementAllowed(
  payload: Partial<SignedEntitlement> | null | undefined,
  publicKeyPem: string,
  expectedDeviceId: string,
  currentVersion: string,
  minimumRequiredVersion: string,
  nowMs = Date.now(),
): boolean {
  if (!payload) return false;
  const required = [
    "status",
    "deviceId",
    "appVersion",
    "minimumRequiredVersion",
    "issuedAt",
    "expiresAt",
    "nonce",
    "signature",
  ] as const;
  for (const key of required) {
    if (typeof payload[key] === "undefined") return false;
  }
  if (payload.status !== "allowed") return false;
  if (typeof payload.deviceId !== "string" || payload.deviceId.trim().length === 0) return false;
  if (payload.deviceId !== expectedDeviceId) return false;
  if (typeof payload.signature !== "string" || payload.signature.trim().length === 0) return false;
  if (typeof payload.issuedAt !== "number" || typeof payload.expiresAt !== "number") return false;
  if (payload.expiresAt <= nowMs) return false;
  if (typeof payload.appVersion !== "string" || payload.appVersion.trim().length === 0) return false;
  if (typeof payload.minimumRequiredVersion !== "string" || payload.minimumRequiredVersion.trim().length === 0) return false;
  if (typeof payload.nonce !== "string" || payload.nonce.trim().length === 0) return false;
  const signedPayload: Omit<SignedEntitlement, "signature"> = {
    status: payload.status,
    deviceId: payload.deviceId,
    appVersion: payload.appVersion,
    minimumRequiredVersion: payload.minimumRequiredVersion,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
  if (!verifyRelaySignature(signedPayload, payload.signature, publicKeyPem)) return false;
  if (payload.appVersion !== currentVersion) {
    // The server can allow a newer app version; the client still must not accept a stale or mismatched entitlement.
    return false;
  }
  if (minimumRequiredVersion && payload.minimumRequiredVersion !== minimumRequiredVersion) {
    return false;
  }
  return true;
}
