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
      key.asymmetricKeyType?.toLowerCase() === "ed25519"
        ? null
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

  const {
    status,
    deviceId,
    appVersion,
    minimumRequiredVersion: serverMinimumRequiredVersion,
    issuedAt,
    expiresAt,
    nonce,
    signature,
  } = payload;

  if (status !== "allowed") return false;
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) return false;
  if (deviceId !== expectedDeviceId) return false;
  if (typeof signature !== "string" || signature.trim().length === 0) return false;
  if (typeof issuedAt !== "number" || typeof expiresAt !== "number") return false;
  if (expiresAt <= nowMs) return false;
  if (typeof appVersion !== "string" || appVersion.trim().length === 0) return false;
  if (
    typeof serverMinimumRequiredVersion !== "string" ||
    serverMinimumRequiredVersion.trim().length === 0
  )
    return false;
  if (typeof nonce !== "string" || nonce.trim().length === 0) return false;

  const signedPayload: Omit<SignedEntitlement, "signature"> = {
    status,
    deviceId,
    appVersion,
    minimumRequiredVersion: serverMinimumRequiredVersion,
    issuedAt,
    expiresAt,
    nonce,
  };
  if (!verifyRelaySignature(signedPayload, signature, publicKeyPem)) return false;
  if (appVersion !== currentVersion) {
    // The server can allow a newer app version; the client still must not accept a stale or mismatched entitlement.
    return false;
  }
  if (minimumRequiredVersion && serverMinimumRequiredVersion !== minimumRequiredVersion) {
    return false;
  }
  return true;
}
