import { createHash } from "crypto";
import * as fsPromises from "fs/promises";
import * as path from "path";

interface LegacyLicenseRejection {
  version: 1;
  signatureSha256: string;
  rejectedAt: number;
}

function signatureHash(signature: string) {
  return createHash("sha256").update(signature, "utf8").digest("hex");
}

export async function isLegacyLicenseRejected(
  statePath: string,
  signature: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const saved = JSON.parse(raw) as Partial<LegacyLicenseRejection>;
  if (
    saved.version !== 1 ||
    typeof saved.signatureSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved.signatureSha256) ||
    typeof saved.rejectedAt !== "number" ||
    !Number.isFinite(saved.rejectedAt)
  )
    throw new Error("The saved lifetime-license rejection state is invalid.");

  return saved.signatureSha256 === signatureHash(signature);
}

export async function persistLegacyLicenseRejection(
  statePath: string,
  signature: string,
  rejectedAt = Date.now(),
): Promise<void> {
  await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  const rejection: LegacyLicenseRejection = {
    version: 1,
    signatureSha256: signatureHash(signature),
    rejectedAt,
  };
  await fsPromises.writeFile(temporaryPath, JSON.stringify(rejection, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fsPromises.rename(temporaryPath, statePath);
}
