const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};

const { writeCloneArchive } = require("../src/cloneArchive.ts");
const { getShelterFreshness, verifyShelterCloneSource } = require("../src/shelterVerification.ts");
const { formatShelterAge, getWorstShelterFreshness } = require("../src/shelterFreshness.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "silo-shelter-verification-"));
const sourceId = "source-photos";
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function writeFolderClone(cloneRoot, files, aliases = []) {
  await fsp.mkdir(cloneRoot, { recursive: true });
  for (const file of files) {
    const target = path.join(cloneRoot, file.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, file.contents);
  }
  await fsp.writeFile(path.join(cloneRoot, "silo-clone-manifest.json"), JSON.stringify({
    format: "silo-source-clone",
    version: 1,
    complete: true,
    files: files.map(({ path: relative, contents, sourceId: fileSourceId = sourceId, sourceRelativePath = relative }) => ({
      path: relative, size: Buffer.byteLength(contents), sha256: digest(contents), sourceId: fileSourceId, sourceRelativePath,
    })),
    aliases,
  }));
}

async function run() {
  try {
    const sourceOne = path.join(root, "source-one.txt");
    const sourceTwo = path.join(root, "source-two.txt");
    await fsp.writeFile(sourceOne, "same payload");
    await fsp.writeFile(sourceTwo, "same payload");
    const sourceFiles = [
      { relativePath: "one.txt", localPath: sourceOne },
      { relativePath: "two.txt", localPath: sourceTwo },
    ];
    const alias = {
      path: "two.txt", canonicalPath: "one.txt", size: 12, sha256: digest("same payload"),
      sourceId, sourceRelativePath: "two.txt", materialized: false,
    };
    const cloneRoot = path.join(root, "folder-clone");
    await writeFolderClone(cloneRoot, [{ path: "one.txt", contents: "same payload" }], [alias]);
    const valid = await verifyShelterCloneSource(cloneRoot, sourceId, sourceFiles);
    assert.equal(valid.verified, true, "a verified canonical payload correctly covers a non-materialized duplicate alias");
    assert.equal(valid.verifiedFiles, 2);

    const originalSourceTwoStats = await fsp.stat(sourceTwo);
    await fsp.writeFile(sourceTwo, "diff payload");
    await fsp.utimes(sourceTwo, originalSourceTwoStats.atime, originalSourceTwoStats.mtime);
    const changedSource = await verifyShelterCloneSource(cloneRoot, sourceId, sourceFiles);
    assert.equal(changedSource.verified, false);
    assert.equal(changedSource.changedFiles, 1, "source content changes are caught even when size and modification time remain stable");
    await fsp.writeFile(sourceTwo, "same payload");

    const missingClone = await verifyShelterCloneSource(cloneRoot, sourceId, [
      ...sourceFiles,
      { relativePath: "new.txt", localPath: sourceTwo },
    ]);
    assert.equal(missingClone.missingFiles, 1, "new source paths absent from the clone are reported");

    await fsp.writeFile(path.join(cloneRoot, "unexpected.txt"), "extra");
    const extraDestination = await verifyShelterCloneSource(cloneRoot, sourceId, sourceFiles);
    assert.equal(extraDestination.extraFiles, 1, "unexpected destination files are reported");
    await fsp.rm(path.join(cloneRoot, "unexpected.txt"));
    await fsp.writeFile(path.join(cloneRoot, "one.txt"), "tampered payload");
    const tamperedDestination = await verifyShelterCloneSource(cloneRoot, sourceId, sourceFiles);
    assert.equal(tamperedDestination.verified, false);
    assert.equal(tamperedDestination.verifiedFiles, 0, "tampered backup bytes never count as verified source files");
    assert.equal(tamperedDestination.changedFiles, 2, "a tampered canonical payload invalidates every source path mapped to it");
    await fsp.rm(path.join(cloneRoot, "one.txt"));
    const missingDestination = await verifyShelterCloneSource(cloneRoot, sourceId, sourceFiles);
    assert.equal(missingDestination.verified, false);
    assert.equal(missingDestination.verifiedFiles, 0, "missing destination bytes never count as verified");

    const archiveSource = path.join(root, "archive-source.txt");
    const archivePath = path.join(root, "shelter-clone.zip");
    await fsp.writeFile(archiveSource, "archive payload");
    const archiveDigest = digest("archive payload");
    const archiveStats = await fsp.stat(archiveSource);
    await writeCloneArchive({
      archivePath,
      files: [{ localPath: archiveSource, archivePath: "photos/archive.txt", size: archiveStats.size, modified: archiveStats.mtimeMs, sha256: archiveDigest }],
      buildManifest: () => ({
        format: "silo-source-clone", version: 1, complete: true,
        files: [{ path: "photos/archive.txt", size: archiveStats.size, sha256: archiveDigest, sourceId, sourceRelativePath: "archive.txt" }],
        aliases: [],
      }),
    });
    const validArchive = await verifyShelterCloneSource(archivePath, sourceId, [
      { relativePath: "archive.txt", localPath: archiveSource },
    ]);
    assert.equal(validArchive.verified, true, "compressed shelter copies receive a full archive and source hash audit");

    const now = Date.UTC(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    assert.equal(getShelterFreshness(now, now), "green");
    assert.equal(getShelterFreshness(now - 7 * day, now), "green");
    assert.equal(getShelterFreshness(now - 8 * day, now), "yellow");
    assert.equal(getShelterFreshness(now - 31 * day, now), "orange");
    assert.equal(getShelterFreshness(now - 184 * day, now), "red");
    assert.equal(getShelterFreshness(now - 366 * day, now), "blinking-red");
    assert.equal(getShelterFreshness(null, now), "unknown");
    assert.equal(getWorstShelterFreshness([now - day, now - 31 * day], now), "orange", "aggregate freshness follows the oldest independently verified backup");
    assert.equal(formatShelterAge(now - 2 * day, now), "Verified 2 days ago");
    const sourceOneBackupTimes = { "Drive A": now - day, "Drive B": now - 7 * day };
    const sourceTwoBackupTimes = { "Drive C": now - 31 * day };
    assert.equal(getShelterFreshness(sourceOneBackupTimes["Drive A"], now), "green");
    assert.equal(getShelterFreshness(sourceOneBackupTimes["Drive B"], now), "green");
    assert.equal(getShelterFreshness(sourceTwoBackupTimes["Drive C"], now), "orange");
    const nextDay = now + day;
    assert.equal(getShelterFreshness(sourceOneBackupTimes["Drive A"], nextDay), "green", "a fresh drive remains green independently");
    assert.equal(getShelterFreshness(sourceOneBackupTimes["Drive B"], nextDay), "yellow", "an older drive crosses into yellow independently");
    assert.equal(getShelterFreshness(sourceTwoBackupTimes["Drive C"], nextDay), "orange", "a separate source backup keeps its own age grade");
    assert.equal(getWorstShelterFreshness([
      ...Object.values(sourceOneBackupTimes),
      ...Object.values(sourceTwoBackupTimes),
    ], nextDay), "orange");
    assert.equal(formatShelterAge(sourceOneBackupTimes["Drive B"], nextDay), "Verified 8 days ago");
    assert.equal(formatShelterAge(null, now), "Never verified");
    console.log("Shelter verification tests passed: folder/ZIP SHA-256 comparisons, aliases, missing/changed/extra detection, and freshness grades.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
