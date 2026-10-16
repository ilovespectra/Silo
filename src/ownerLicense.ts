import { createPublicKey, createPrivateKey, sign, verify } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const OWNER_AUTHORIZATION_GRANT = "owner-authorization" as const;

export interface OwnerAuthorizationPayload {
  version: 1;
  product: "silo";
  grant: typeof OWNER_AUTHORIZATION_GRANT;
  deviceId: string;
  ownerId?: string;
  issuedAt: number;
  purpose: "local-owner-unlock";
}

const DEVICE_ID_PATTERN = /^[a-f0-9]{32}$/;

export function isOwnerDeviceBindingId(value: unknown): value is string {
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

function toSignatureAlgorithm(keyPem: string): string {
  try {
    const key = createPublicKey(keyPem);
    const keyType = (key as { asymmetricKey?: { type?: string } }).asymmetricKey?.type;
    if (typeof keyType === "string" && keyType.toLowerCase() === "ed25519")
      return "ed25519";
  } catch {
    // RSA and unsupported PEMs fall back to RSA-SHA256 below.
  }
  return "RSA-SHA256";
}

export function normalizeOwnerVerificationKeyPem(keyPem: string): string | null {
  const trimmed = keyPem.trim();
  if (!trimmed) return null;
  try {
    return createPublicKey(trimmed).export({ type: "spki", format: "pem" }).toString("utf8");
  } catch {
    return null;
  }
}

export function listOwnerAuthorizationKeyPaths(): string[] {
  const home = os.homedir();
  const candidates = new Set<string>();
  const explicitPaths = [
    process.env.SILO_OWNER_SIGNING_KEY_PATH,
    process.env.SILO_OWNER_LICENSE_KEY_PATH,
    process.env.SILO_LICENSE_KEY_PATH,
    process.env.SILO_OWNER_KEY_PATH,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  for (const entry of explicitPaths) candidates.add(path.resolve(entry));
  for (const entry of [
    path.join(home, ".config", "signingkey.pem"),
    path.join(home, ".config", "silo", "signingkey.pem"),
    path.join(home, ".config", "silo", "owner-license-private.pem"),
    path.join(home, ".config", "silo", "owner-signing-key.pem"),
    path.join(home, ".config", "silo", "paid-license-private.pem"),
  ]) candidates.add(path.resolve(entry));
  return [...candidates];
}

export function readOwnerAuthorizationKeyPem(): string | null {
  for (const candidate of listOwnerAuthorizationKeyPaths()) {
    try {
      const pem = fs.readFileSync(candidate, "utf8");
      const normalized = normalizeOwnerVerificationKeyPem(pem);
      if (normalized) return normalized;
    } catch {
      // Try the remaining key locations.
    }
  }
  return null;
}

export function createOwnerAuthorizationToken(
  deviceId: string,
  privateKeyPem: string,
  ownerId = "local-owner",
): string {
  if (!isOwnerDeviceBindingId(deviceId))
    throw new Error("A valid device binding is required to issue an owner authorization.");
  if (!privateKeyPem.trim())
    throw new Error("A private key is required to sign an owner authorization.");

  const payload: OwnerAuthorizationPayload = {
    version: 1,
    product: "silo",
    grant: OWNER_AUTHORIZATION_GRANT,
    deviceId,
    ownerId,
    issuedAt: Date.now(),
    purpose: "local-owner-unlock",
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(
    toSignatureAlgorithm(privateKeyPem),
    Buffer.from(encodedPayload, "ascii"),
    createPrivateKey(privateKeyPem),
  ).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyOwnerAuthorizationToken(
  token: unknown,
  expectedDeviceId: string,
  publicKeyPem: string,
): OwnerAuthorizationPayload | null {
  if (
    typeof token !== "string" ||
    token.length > 8192 ||
    !isOwnerDeviceBindingId(expectedDeviceId) ||
    !publicKeyPem.trim()
  )
    return null;

  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length) return null;

  const payloadBytes = decodeBase64Url(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (!payloadBytes || !signature) return null;

  try {
    const normalizedVerificationKey = normalizeOwnerVerificationKeyPem(publicKeyPem) ?? publicKeyPem;
    const algorithm = toSignatureAlgorithm(normalizedVerificationKey);
    if (
      !verify(
        algorithm,
        Buffer.from(encodedPayload, "ascii"),
        normalizedVerificationKey,
        signature,
      )
    )
      return null;

    const payload = JSON.parse(payloadBytes.toString("utf8")) as Partial<OwnerAuthorizationPayload>;
    if (
      payload.version !== 1 ||
      payload.product !== "silo" ||
      payload.grant !== OWNER_AUTHORIZATION_GRANT ||
      payload.deviceId !== expectedDeviceId ||
      !isOwnerDeviceBindingId(payload.deviceId) ||
      typeof payload.issuedAt !== "number" ||
      !Number.isFinite(payload.issuedAt) ||
      payload.issuedAt <= 0 ||
      payload.purpose !== "local-owner-unlock"
    )
      return null;

    return payload as OwnerAuthorizationPayload;
  } catch {
    return null;
  }
}

export function readOwnerAuthorizationToken(
  _expectedDeviceId: string,
  _publicKeyPem?: string,
): OwnerAuthorizationPayload | null {
  // Cloned or locally-run builds must not be able to grant themselves full access by
  // providing a local owner token via environment variables or config files.
  // Full access remains gated to a valid paid/device-bound license only.
  return null;
}
