import { createHash } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import {
  readCloneArchiveManifest,
  verifyCloneArchive,
} from "./cloneArchive";
export { getShelterFreshness } from "./shelterFreshness";
export type { ShelterFreshness } from "./shelterFreshness";

export interface ShelterSourceFile {
  relativePath: string;
  localPath: string;
}

export interface ShelterVerificationResult {
  verified: boolean;
  verifiedFiles: number;
  totalFiles: number;
  missingFiles: number;
  changedFiles: number;
  extraFiles: number;
  error?: string;
}

interface ManifestFile {
  path?: unknown;
  sha256?: unknown;
  sourceId?: unknown;
  sourceRelativePath?: unknown;
  error?: unknown;
}

interface ManifestAlias {
  path?: unknown;
  canonicalPath?: unknown;
  sha256?: unknown;
  sourceId?: unknown;
  sourceRelativePath?: unknown;
  materialized?: unknown;
}

interface CloneManifest {
  format?: unknown;
  version?: unknown;
  complete?: unknown;
  files?: unknown;
  aliases?: unknown;
}

function normalizedRelativePath(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value))
    throw new Error("The Fallout Shelter manifest contains an unsafe file path.");
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".."))
    throw new Error("The Fallout Shelter manifest contains an unsafe file path.");
  return segments.join("/");
}

function hasSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function hashStableFile(filePath: string) {
  const before = await fsPromises.stat(filePath);
  if (!before.isFile()) return null;
  const digest = await hashFile(filePath);
  const after = await fsPromises.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.dev !== after.dev || before.ino !== after.ino) return null;
  return digest;
}

async function readCloneManifest(clonePath: string): Promise<CloneManifest> {
  const manifest = path.extname(clonePath).toLowerCase() === ".zip"
    ? await readCloneArchiveManifest(clonePath)
    : JSON.parse(await fsPromises.readFile(path.join(clonePath, "silo-clone-manifest.json"), "utf8"));
  if (manifest.format !== "silo-source-clone" || manifest.version !== 1 || manifest.complete !== true)
    throw new Error("The latest Fallout Shelter clone is incomplete or has no supported manifest.");
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.aliases))
    throw new Error("The Fallout Shelter clone manifest is missing its file inventory.");
  return manifest as CloneManifest;
}

export async function readShelterCloneManifest(clonePath: string) {
  return readCloneManifest(clonePath);
}

async function listCloneFiles(root: string): Promise<Map<string, string>> {
  const actual = new Map<string, string>();
  const stack = [{ absolute: root, relative: "" }];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of await fsPromises.readdir(current.absolute, { withFileTypes: true })) {
      if (!current.relative && entry.name === "silo-clone-manifest.json") continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isSymbolicLink()) {
        actual.set(normalizedRelativePath(relative), "");
      } else if (entry.isDirectory()) {
        stack.push({ absolute, relative });
      } else if (entry.isFile()) {
        actual.set(normalizedRelativePath(relative), absolute);
      }
    }
  }
  return actual;
}

export async function verifyShelterCloneSource(
  clonePath: string,
  sourceId: string,
  sourceFiles: ShelterSourceFile[],
): Promise<ShelterVerificationResult> {
  const result: ShelterVerificationResult = {
    verified: false,
    verifiedFiles: 0,
    totalFiles: sourceFiles.length,
    missingFiles: 0,
    changedFiles: 0,
    extraFiles: 0,
  };
  if (!sourceFiles.length) {
    result.error = "The selected source currently contains no files to verify.";
    return result;
  }

  const manifest = await readCloneManifest(clonePath);
  const physicalFiles = new Map<string, string>();
  const actualStoredDigests = new Map<string, string>();
  const sourceManifestFiles = new Map<string, { digest: string; storedPath: string }>();
  const records = new Map<string, string>();
  const changedSourcePaths = new Set<string>();
  let destinationIntegrity = true;

  for (const raw of manifest.files as ManifestFile[]) {
    if (raw.error || !hasSha256(raw.sha256))
      throw new Error("The Fallout Shelter clone manifest contains an unverified file.");
    const relative = normalizedRelativePath(raw.path);
    if (records.has(relative)) throw new Error("The Fallout Shelter clone manifest contains duplicate file paths.");
    records.set(relative, raw.sha256.toLowerCase());
    physicalFiles.set(relative, raw.sha256.toLowerCase());
    if (raw.sourceId === sourceId) {
      const sourceRelative = normalizedRelativePath(raw.sourceRelativePath ?? raw.path);
      if (sourceManifestFiles.has(sourceRelative))
        throw new Error("The Fallout Shelter manifest maps a source file more than once.");
      sourceManifestFiles.set(sourceRelative, { digest: raw.sha256.toLowerCase(), storedPath: relative });
    }
  }

  const aliasRecords = new Map<string, { digest: string; canonicalPath: string }>();
  for (const raw of manifest.aliases as ManifestAlias[]) {
    if (!hasSha256(raw.sha256)) throw new Error("The Fallout Shelter clone manifest contains an invalid duplicate hash.");
    const relative = normalizedRelativePath(raw.path);
    const canonicalPath = normalizedRelativePath(raw.canonicalPath);
    const canonicalDigest = records.get(canonicalPath);
    if (!canonicalDigest || canonicalDigest !== raw.sha256.toLowerCase())
      throw new Error("A Fallout Shelter duplicate does not point to its verified canonical file.");
    if (records.has(relative) || aliasRecords.has(relative))
      throw new Error("The Fallout Shelter clone manifest contains duplicate file paths.");
    aliasRecords.set(relative, { digest: raw.sha256.toLowerCase(), canonicalPath });
    if (raw.materialized === true) physicalFiles.set(relative, raw.sha256.toLowerCase());
    if (raw.sourceId === sourceId) {
      const sourceRelative = normalizedRelativePath(raw.sourceRelativePath ?? raw.path);
      if (sourceManifestFiles.has(sourceRelative))
        throw new Error("The Fallout Shelter manifest maps a source file more than once.");
      sourceManifestFiles.set(sourceRelative, { digest: raw.sha256.toLowerCase(), storedPath: canonicalPath });
    }
  }

  const zip = path.extname(clonePath).toLowerCase() === ".zip";
  const actualFiles = zip ? null : await listCloneFiles(clonePath);
  if (zip) {
    try {
      await verifyCloneArchive(clonePath, records);
      for (const [relative, expectedDigest] of records)
        actualStoredDigests.set(relative, expectedDigest);
    } catch (error) {
      destinationIntegrity = false;
      result.error = error instanceof Error ? error.message : "The Fallout Shelter archive failed integrity verification.";
    }
  } else {
    for (const [relative, expectedDigest] of physicalFiles) {
      const actualPath = actualFiles!.get(relative);
      if (!actualPath) {
        destinationIntegrity = false;
        continue;
      }
      const actualDigest = await hashStableFile(actualPath).catch(() => null);
      if (actualDigest !== expectedDigest) {
        destinationIntegrity = false;
      } else {
        actualStoredDigests.set(relative, actualDigest);
      }
    }
    for (const relative of actualFiles!.keys()) {
      if (!physicalFiles.has(relative)) result.extraFiles += 1;
    }
    for (const relative of physicalFiles.keys()) {
      if (!actualFiles!.has(relative)) destinationIntegrity = false;
    }
    if (!destinationIntegrity && !result.error)
      result.error = "One or more stored Fallout Shelter files failed SHA-256 or presence checks.";
  }

  const currentSourceFiles = new Map<string, string>();
  for (const file of sourceFiles) {
    const relative = normalizedRelativePath(file.relativePath);
    if (currentSourceFiles.has(relative)) throw new Error("The live source contains duplicate relative file paths.");
    currentSourceFiles.set(relative, file.localPath);
  }

  for (const [relative, localPath] of currentSourceFiles) {
    const stored = sourceManifestFiles.get(relative);
    if (!stored) {
      result.missingFiles += 1;
      continue;
    }
    const sourceDigest = await hashStableFile(localPath).catch(() => null);
    const storedDigest = actualStoredDigests.get(stored.storedPath);
    const materializedAliasDigest = aliasRecords.get(relative)?.digest;
    if (!sourceDigest || sourceDigest !== stored.digest || storedDigest !== stored.digest ||
        (materializedAliasDigest && materializedAliasDigest !== stored.digest)) {
      changedSourcePaths.add(relative);
      continue;
    }
    result.verifiedFiles += 1;
  }
  for (const relative of sourceManifestFiles.keys()) {
    if (!currentSourceFiles.has(relative)) result.extraFiles += 1;
  }

  result.changedFiles = changedSourcePaths.size;
  result.verified = result.verifiedFiles === result.totalFiles &&
    result.missingFiles === 0 && result.changedFiles === 0 && result.extraFiles === 0 &&
    destinationIntegrity && !result.error;
  return result;
}
