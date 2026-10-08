import { execFile } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const FORMAT = "silo-config";
const FORMAT_VERSION = 1;
export const CONFIG_MANIFEST = "silo-config.json";
const STAGING = ".config-import-staging";
const READY_MARKER = ".config-import-ready";

// Durable configuration and indexes. Regenerable caches (thumbnails, previews, media) and phone backups are excluded.
const CONFIG_ENTRIES = [
  "browser-state.json",
  "content-settings.json",
  // Records before vectors: both grow during indexing, and records must never point past the archived vectors.
  "semantic-index/records.jsonl",
  "semantic-index/progress.json",
  "semantic-index/vectors.bin",
  "semantic-index/coverage.json",
  "semantic-index/discovered-totals.json",
  "semantic-index/worker-failures.json",
  "semantic-index/pending-work.json",
  "face-index",
  "pets",
  "geo-index.jsonl",
  "geocode-cache.json",
  "geocode-search-cache.json",
  "duplicate-index.json",
  "aesthetic-index.jsonl",
  "source-clone-status.json",
  "content-safety-index.json",
  "google-accounts.json",
  "contacts.json",
  "phone-cache/backup-destination.json",
  "phone-cache/backup-state.json",
  ".env",
];
const INDEX_CONFIG_ENTRIES = new Set([
  "semantic-index/records.jsonl",
  "semantic-index/progress.json",
  "semantic-index/vectors.bin",
  "semantic-index/coverage.json",
  "semantic-index/discovered-totals.json",
  "semantic-index/worker-failures.json",
  "semantic-index/pending-work.json",
  "face-index",
  "pets",
  "geo-index.jsonl",
  "geocode-cache.json",
  "geocode-search-cache.json",
  "duplicate-index.json",
  "aesthetic-index.jsonl",
  "content-safety-index.json",
]);
const INDEX_CONFIG_ROOTS = new Set([
  "semantic-index",
  "face-index",
  "pets",
  "geo-index.jsonl",
  "geocode-cache.json",
  "geocode-search-cache.json",
  "duplicate-index.json",
  "aesthetic-index.jsonl",
  "content-safety-index.json",
]);
const ALLOWED_ROOTS = new Set(
  CONFIG_ENTRIES.map((entry) => entry.split("/")[0]).concat(CONFIG_MANIFEST),
);
// These folders hold other data (e.g. phone backups); only the listed files inside them are replaced.
const MERGE_ROOTS = new Set(["phone-cache"]);

export interface ConfigManifest {
  format: string;
  version: number;
  exportedAt: number;
  appVersion: string;
  entries: string[];
  rendererPrefs: Record<string, string>;
}

const exists = (target: string) =>
  fsPromises.lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

export async function exportConfig(
  userData: string,
  target: string,
  appVersion: string,
  rendererPrefs: Record<string, string>,
  indexStoragePath: string = userData,
) {
  const entries: string[] = [];
  for (const entry of CONFIG_ENTRIES) {
    const root = INDEX_CONFIG_ENTRIES.has(entry) ? indexStoragePath : userData;
    if (await exists(path.join(root, entry))) entries.push(entry);
  }
  const manifest: ConfigManifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: Date.now(),
    appVersion,
    entries,
    rendererPrefs,
  };
  const temporary = await fsPromises.mkdtemp(
    path.join(indexStoragePath, ".silo-config-export-"),
  );
  const listPath = path.join(temporary, "files.txt");
  try {
    for (const entry of entries) {
      const root = INDEX_CONFIG_ENTRIES.has(entry) ? indexStoragePath : userData;
      const stagedPath = path.join(temporary, entry);
      await fsPromises.mkdir(path.dirname(stagedPath), { recursive: true });
      await fsPromises.cp(path.join(root, entry), stagedPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    await fsPromises.writeFile(
      path.join(temporary, CONFIG_MANIFEST),
      JSON.stringify(manifest, null, 2),
    );
    await fsPromises.writeFile(
      listPath,
      [CONFIG_MANIFEST, ...entries].join("\n"),
    );
    await execFileAsync(
      "tar",
      ["-czf", target, "-C", temporary, "-T", listPath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await fsPromises.rm(temporary, { recursive: true, force: true });
  }
  const { size } = await fsPromises.stat(target);
  return { size, entries };
}

async function assertSafeTree(root: string, relative = ""): Promise<void> {
  for (const name of await fsPromises.readdir(path.join(root, relative))) {
    const child = path.join(relative, name);
    if (!relative && !ALLOWED_ROOTS.has(name))
      throw new Error(`Unexpected item in config: ${name}`);
    const stats = await fsPromises.lstat(path.join(root, child));
    if (stats.isSymbolicLink())
      throw new Error(`Config contains a link, which is not allowed: ${child}`);
    if (stats.isDirectory()) await assertSafeTree(root, child);
    else if (!stats.isFile())
      throw new Error(`Config contains an unsupported item: ${child}`);
  }
}

/** Unpacks and validates a config into a staging folder; nothing in use is touched until restart. */
export async function stageConfigImport(
  userData: string,
  archive: string,
): Promise<ConfigManifest> {
  const staging = path.join(userData, STAGING);
  await fsPromises.rm(staging, { recursive: true, force: true });
  await fsPromises.rm(path.join(userData, READY_MARKER), { force: true });
  await fsPromises.mkdir(staging, { recursive: true });
  try {
    // bsdtar refuses absolute paths and ".." entries by default; the tree is still checked below.
    await execFileAsync("tar", ["-xzf", archive, "-C", staging], {
      maxBuffer: 16 * 1024 * 1024,
    });
    await assertSafeTree(staging);
    const manifest = JSON.parse(
      await fsPromises.readFile(path.join(staging, CONFIG_MANIFEST), "utf8"),
    ) as ConfigManifest;
    if (manifest.format !== FORMAT || typeof manifest.version !== "number")
      throw new Error("This file is not a Silo config.");
    if (manifest.version > FORMAT_VERSION)
      throw new Error(
        "This config was made by a newer version of Silo. Update Silo and try again.",
      );
    return {
      ...manifest,
      rendererPrefs: Object.fromEntries(
        Object.entries(manifest.rendererPrefs ?? {}).filter(
          ([key, value]) =>
            key.startsWith("silo.") && typeof value === "string",
        ),
      ),
    };
  } catch (error) {
    await fsPromises.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function commitStagedImport(userData: string) {
  if (!(await exists(path.join(userData, STAGING, CONFIG_MANIFEST))))
    throw new Error("No config is waiting to be restored.");
  await fsPromises.writeFile(
    path.join(userData, READY_MARKER),
    String(Date.now()),
  );
}

export async function cancelStagedImport(userData: string) {
  await fsPromises.rm(path.join(userData, STAGING), {
    recursive: true,
    force: true,
  });
  await fsPromises.rm(path.join(userData, READY_MARKER), { force: true });
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

async function treeManifest(root: string, relative = ""): Promise<string[]> {
  const current = path.join(root, relative);
  const stats = await fsPromises.lstat(current);
  if (stats.isSymbolicLink())
    throw new Error(`Config restore refuses symbolic links: ${current}`);
  if (stats.isFile())
    return [`file:${relative}:${stats.size}:${await hashFile(current)}`];
  if (!stats.isDirectory())
    throw new Error(`Config restore found an unsupported item: ${current}`);
  const children = (await fsPromises.readdir(current)).sort();
  const manifest = [`directory:${relative}`];
  for (const child of children)
    manifest.push(...await treeManifest(root, path.join(relative, child)));
  return manifest;
}

async function copyTreeVerified(source: string, destination: string) {
  const sourceManifest = await treeManifest(source);
  await fsPromises.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  const destinationManifest = await treeManifest(destination);
  if (JSON.stringify(sourceManifest) !== JSON.stringify(destinationManifest))
    throw new Error(`Config restore checksum verification failed for ${source}.`);
}

interface RestoreReplacement {
  target: string;
  backup: string | null;
}

async function replaceFromVerifiedCopy(
  source: string,
  target: string,
): Promise<RestoreReplacement> {
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = path.join(path.dirname(target), `.silo-restore-stage-${token}`);
  const backup = path.join(path.dirname(target), `.silo-restore-backup-${token}`);
  try {
    // Copy to a sibling of the target so the final rename stays on the destination volume.
    await copyTreeVerified(source, staged);
    const hadTarget = await exists(target);
    if (hadTarget) await fsPromises.rename(target, backup);
    try {
      await fsPromises.rename(staged, target);
    } catch (error) {
      if (hadTarget) await fsPromises.rename(backup, target);
      throw error;
    }
    return { target, backup: hadTarget ? backup : null };
  } catch (error) {
    await fsPromises.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function rollbackRestore(replacements: RestoreReplacement[]) {
  const failures: string[] = [];
  for (const replacement of replacements.reverse()) {
    try {
      await fsPromises.rm(replacement.target, { recursive: true, force: true });
      if (replacement.backup)
        await fsPromises.rename(replacement.backup, replacement.target);
    } catch (error) {
      failures.push(`${replacement.target}: ${String(error)}`);
    }
  }
  return failures;
}

export async function applyPendingImport(
  userData: string,
  indexStoragePath: string = userData,
) {
  const staging = path.join(userData, STAGING);
  if (!(await exists(path.join(userData, READY_MARKER)))) return false;
  const replacements: RestoreReplacement[] = [];
  try {
    for (const name of (await fsPromises.readdir(staging)).sort()) {
      if (name === CONFIG_MANIFEST) continue;
      const source = path.join(staging, name);
      if (MERGE_ROOTS.has(name)) {
        for (const child of (await fsPromises.readdir(source)).sort())
          replacements.push(await replaceFromVerifiedCopy(
            path.join(source, child),
            path.join(userData, name, child),
          ));
      } else {
        const targetRoot = INDEX_CONFIG_ROOTS.has(name)
          ? indexStoragePath
          : userData;
        replacements.push(await replaceFromVerifiedCopy(
          source,
          path.join(targetRoot, name),
        ));
      }
    }
  } catch (error) {
    const rollbackFailures = await rollbackRestore(replacements);
    if (rollbackFailures.length)
      throw new Error(
        `Config restore failed and rollback could not finish. The import and rollback copies were retained: ${rollbackFailures.join("; ")}. Original error: ${String(error)}`,
      );
    throw error;
  }

  // Keep the import available until every destination has been replaced successfully.
  for (const replacement of replacements)
    if (replacement.backup)
      await fsPromises.rm(replacement.backup, { recursive: true, force: true }).catch(() => {});
  await cancelStagedImport(userData).catch(() => {});
  return true;
}
