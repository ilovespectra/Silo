const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const { zipSync, strToU8 } = require("fflate");
const {
  writeCloneArchive,
  extractCloneArchive,
  readCloneArchiveManifest,
  CLONE_ARCHIVE_MANIFEST_NAME,
} = require("../electron-dist/cloneArchive.js");

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const hashFile = async (filePath) => sha256(await fsPromises.readFile(filePath));

async function buildSource(root, count) {
  const files = [];
  const directories = new Set();
  for (let index = 0; index < count; index += 1) {
    const folder = `bucket-${String(index % 97).padStart(2, "0")}/sub-${index % 7}`;
    directories.add(folder.split("/")[0]);
    directories.add(folder);
    const name = index % 5 === 0 ? `photo-${index}.jpg` : `note-${index}.txt`;
    const content = Buffer.from(`silo bulk file ${index}\n`.repeat(1 + (index % 3)));
    const archivePath = `${folder}/${name}`;
    const localPath = path.join(root, archivePath);
    await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
    await fsPromises.writeFile(localPath, content);
    const stats = await fsPromises.stat(localPath);
    files.push({ localPath, archivePath, size: stats.size, modified: stats.mtimeMs, mode: stats.mode, sha256: sha256(content) });
  }
  const big = Buffer.alloc(6 * 1024 * 1024);
  crypto.randomFillSync(big);
  const bigPath = path.join(root, "bucket-00", "movie.mov");
  await fsPromises.writeFile(bigPath, big);
  const bigStats = await fsPromises.stat(bigPath);
  files.push({ localPath: bigPath, archivePath: "bucket-00/movie.mov", size: bigStats.size, modified: bigStats.mtimeMs, sha256: sha256(big) });
  return { files, directories: Array.from(directories).sort().map((archivePath) => ({ archivePath })) };
}

function manifestFor(files, aliases) {
  return () => ({
    format: "silo-source-clone", version: 1, container: "zip", complete: true,
    createdAt: new Date().toISOString(), sourceIds: ["test"], sourceLabels: ["Test"],
    totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    verifiedFiles: files.length, failedFiles: 0,
    files: files.map((file) => ({ path: file.archivePath, size: file.size, sha256: file.sha256, modified: file.modified })),
    aliases,
  });
}

async function exists(target) {
  return fsPromises.access(target).then(() => true, () => false);
}

async function main() {
  const work = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-clone-archive-"));
  try {
    const source = path.join(work, "source");
    const output = path.join(work, "output");
    await fsPromises.mkdir(output, { recursive: true });
    const count = Number(process.env.SILO_ARCHIVE_TEST_FILES || 70000);
    const started = Date.now();
    const { files, directories } = await buildSource(source, count);
    const aliases = [
      { path: "duplicates/copy-of-note-1.txt", canonicalPath: files[1].archivePath, size: files[1].size, sha256: files[1].sha256, materialized: false },
      { path: "duplicates/deep/copy-of-movie.mov", canonicalPath: "bucket-00/movie.mov", size: files.at(-1).size, sha256: files.at(-1).sha256, materialized: false },
    ];

    // 1. Bulk compression beyond the classic 65,535-entry zip limit (requires zip64).
    const archivePath = path.join(output, "Silo Source Clone test.zip");
    let compressingEvents = 0;
    let verifyingEvents = 0;
    const result = await writeCloneArchive({
      archivePath, files, directories, buildManifest: manifestFor(files, aliases),
      onProgress: (progress) => {
        if (progress.phase === "compressing") compressingEvents += 1;
        if (progress.phase === "verifying") verifyingEvents += 1;
      },
    });
    assert.strictEqual(result.storedFiles, files.length);
    assert.strictEqual(result.verifiedFiles, files.length);
    assert.ok(!(await exists(`${archivePath}.silo-partial`)), "partial archive must be renamed away");
    assert.ok(compressingEvents > 0 && verifyingEvents > 0, "progress is reported for both phases");
    const sourceBytes = files.reduce((sum, file) => sum + file.size, 0);
    console.log(`  compressed ${files.length.toLocaleString()} files (${(sourceBytes / 1048576).toFixed(1)} MB) -> ${(result.archiveBytes / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    const manifest = await readCloneArchiveManifest(archivePath);
    assert.strictEqual(manifest.container, "zip");
    assert.strictEqual(manifest.files.length, files.length);

    // 2. Bulk extraction restores every byte, every directory, and duplicate aliases.
    const restoreParent = path.join(work, "restore");
    await fsPromises.mkdir(restoreParent);
    const extractStarted = Date.now();
    const extracted = await extractCloneArchive(archivePath, restoreParent);
    assert.strictEqual(extracted.extractedFiles, files.length);
    assert.strictEqual(extracted.restoredAliases, aliases.length);
    for (const file of files) {
      const restored = path.join(extracted.destinationRoot, file.archivePath);
      assert.strictEqual(await hashFile(restored), file.sha256, `restored ${file.archivePath}`);
    }
    for (const directory of directories) assert.ok(await exists(path.join(extracted.destinationRoot, directory.archivePath)));
    const canonicalStats = await fsPromises.stat(path.join(extracted.destinationRoot, "bucket-00/movie.mov"));
    const aliasStats = await fsPromises.stat(path.join(extracted.destinationRoot, "duplicates/deep/copy-of-movie.mov"));
    assert.strictEqual(aliasStats.ino, canonicalStats.ino, "duplicate restored as a hard link");
    const restoredMtime = (await fsPromises.stat(path.join(extracted.destinationRoot, files[3].archivePath))).mtimeMs;
    assert.ok(Math.abs(restoredMtime - files[3].modified) < 1, "modification time preserved");
    const restoredManifest = JSON.parse(await fsPromises.readFile(path.join(extracted.destinationRoot, CLONE_ARCHIVE_MANIFEST_NAME), "utf8"));
    assert.ok(restoredManifest.aliases.every((alias) => alias.materialized), "extracted manifest marks aliases materialized");
    assert.ok(!(await exists(path.join(extracted.destinationRoot, ".silo-clone-in-progress.json"))));
    console.log(`  extracted and SHA-256 verified ${extracted.extractedFiles.toLocaleString()} files in ${((Date.now() - extractStarted) / 1000).toFixed(1)}s`);

    // 3. Extracting again never overwrites the earlier restore.
    const second = await extractCloneArchive(archivePath, restoreParent);
    assert.notStrictEqual(second.destinationRoot, extracted.destinationRoot);
    await fsPromises.rm(second.destinationRoot, { recursive: true, force: true });

    // 4. Corrupted archive bytes are detected and leave nothing behind.
    const small = files.slice(0, 50).concat(files.at(-1));
    const tamperedPath = path.join(output, "tampered.zip");
    await writeCloneArchive({ archivePath: tamperedPath, files: small, buildManifest: manifestFor(small, []) });
    const handle = await fsPromises.open(tamperedPath, "r+");
    const middle = Math.floor((await handle.stat()).size / 2);
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, middle);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, middle);
    await handle.close();
    const tamperParent = path.join(work, "tamper-restore");
    await fsPromises.mkdir(tamperParent);
    await assert.rejects(extractCloneArchive(tamperedPath, tamperParent), /SHA-256 mismatch|crc|invalid|corrupt/i);
    assert.deepStrictEqual(await fsPromises.readdir(tamperParent), [], "failed extraction removes its own folder");

    // 5. Zip-slip entries are rejected and nothing is written outside the destination.
    const evilManifest = { format: "silo-source-clone", version: 1, complete: true,
      files: [{ path: "../escaped.txt", size: 4, sha256: sha256(Buffer.from("evil")) }], aliases: [] };
    const evilPath = path.join(output, "evil.zip");
    await fsPromises.writeFile(evilPath, zipSync({ "../escaped.txt": strToU8("evil"),
      [CLONE_ARCHIVE_MANIFEST_NAME]: strToU8(JSON.stringify(evilManifest)) }));
    const evilParent = path.join(work, "evil-restore");
    await fsPromises.mkdir(evilParent);
    await assert.rejects(extractCloneArchive(evilPath, evilParent), /unsafe|escapes|invalid relative path/i);
    assert.ok(!(await exists(path.join(work, "escaped.txt"))));
    assert.deepStrictEqual(await fsPromises.readdir(evilParent), []);

    // 6. A non-Silo zip is refused.
    const foreignPath = path.join(output, "foreign.zip");
    await fsPromises.writeFile(foreignPath, zipSync({ "hello.txt": strToU8("hi") }));
    await assert.rejects(extractCloneArchive(foreignPath, evilParent), /not a Silo clone archive/);

    // 7. Cancellation stops compression and removes the partial archive.
    let seen = 0;
    const cancelledPath = path.join(output, "cancelled.zip");
    await assert.rejects(writeCloneArchive({
      archivePath: cancelledPath, files, buildManifest: manifestFor(files, []),
      isCancelled: () => (seen += 1) > 2000,
    }), /cancelled/);
    assert.ok(!(await exists(cancelledPath)) && !(await exists(`${cancelledPath}.silo-partial`)));

    // 8. A source edited after preflight is refused instead of archived silently.
    const changed = [{ ...files[2] }];
    await fsPromises.appendFile(changed[0].localPath, "edited");
    const changedPath = path.join(output, "changed.zip");
    await assert.rejects(writeCloneArchive({ archivePath: changedPath, files: changed, buildManifest: manifestFor(changed, []) }),
      /changed/);
    assert.ok(!(await exists(changedPath)) && !(await exists(`${changedPath}.silo-partial`)));

    // 9. Existing archives are never overwritten.
    await assert.rejects(writeCloneArchive({ archivePath, files: small, buildManifest: manifestFor(small, []) }), /already exists/);

    // 10. Optional: a >4 GiB stored entry exercises zip64 sizes and offsets.
    if (process.env.SILO_ARCHIVE_LARGE_TEST === "1") {
      const largePath = path.join(source, "large.mp4");
      const block = crypto.randomBytes(8 * 1024 * 1024);
      const hash = crypto.createHash("sha256");
      const largeHandle = await fsPromises.open(largePath, "w");
      for (let written = 0; written < 4.3 * 1024 ** 3; written += block.length) {
        await largeHandle.write(block);
        hash.update(block);
      }
      await largeHandle.close();
      const largeStats = await fsPromises.stat(largePath);
      const large = [{ localPath: largePath, archivePath: "large.mp4", size: largeStats.size, modified: largeStats.mtimeMs, sha256: hash.digest("hex") },
        files[0]];
      const largeArchive = path.join(output, "large.zip");
      await writeCloneArchive({ archivePath: largeArchive, files: large, buildManifest: manifestFor(large, []) });
      const largeRestore = path.join(work, "large-restore");
      await fsPromises.mkdir(largeRestore);
      const largeResult = await extractCloneArchive(largeArchive, largeRestore);
      assert.strictEqual(largeResult.extractedFiles, 2);
      console.log(`  zip64 large entry: ${(largeStats.size / 1024 ** 3).toFixed(2)} GiB archived, verified and extracted`);
    }

    console.log("Clone archive tests passed: zip64 bulk compression/extraction, SHA-256 verification, aliases, tamper detection, zip-slip protection, cancellation and change detection.");
  } finally {
    await fsPromises.rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
