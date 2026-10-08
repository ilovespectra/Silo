const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { GeoIndexer } = require("../src/geoIndexer.ts");
const root = path.resolve(__dirname, "..");
const workPath = path.join(root, "tmp", "windows-geo-runtime-smoke");

function writeIfdEntry(buffer, offset, tag, type, count, value) {
  buffer.writeUInt16LE(tag, offset);
  buffer.writeUInt16LE(type, offset + 2);
  buffer.writeUInt32LE(count, offset + 4);
  if (Buffer.isBuffer(value)) value.copy(buffer, offset + 8);
  else buffer.writeUInt32LE(value, offset + 8);
}

function gpsExifSegment() {
  const tiff = Buffer.alloc(140);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  writeIfdEntry(tiff, 10, 0x8825, 4, 1, 26);
  tiff.writeUInt32LE(0, 22);

  tiff.writeUInt16LE(5, 26);
  writeIfdEntry(tiff, 28, 0x0000, 1, 4, Buffer.from([2, 3, 0, 0]));
  writeIfdEntry(tiff, 40, 0x0001, 2, 2, Buffer.from([78, 0, 0, 0]));
  writeIfdEntry(tiff, 52, 0x0002, 5, 3, 92);
  writeIfdEntry(tiff, 64, 0x0003, 2, 2, Buffer.from([69, 0, 0, 0]));
  writeIfdEntry(tiff, 76, 0x0004, 5, 3, 116);
  tiff.writeUInt32LE(0, 88);

  const rationals = [46, 3, 0, 14, 30, 0];
  rationals.forEach((value, index) => {
    const offset = 92 + index * 8;
    tiff.writeUInt32LE(value, offset);
    tiff.writeUInt32LE(1, offset + 4);
  });
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

async function main() {
  fs.mkdirSync(workPath, { recursive: true });
  const imagePath = path.join(workPath, "gps-photo.jpg");
  const jpeg = await sharp({
    create: {
      width: 48,
      height: 48,
      channels: 3,
      background: { r: 110, g: 130, b: 150 },
    },
  }).jpeg().toBuffer();
  const withGps = Buffer.concat([jpeg.subarray(0, 2), gpsExifSegment(), jpeg.subarray(2)]);
  await fs.promises.writeFile(imagePath, withGps);

  const stat = await fs.promises.stat(imagePath);
  const image = {
    path: imagePath,
    name: path.basename(imagePath),
    extension: ".jpg",
    type: "image",
    size: stat.size,
    modified: stat.mtimeMs,
  };
  const indexer = new GeoIndexer(workPath, () => {});
  await indexer.initialize();
  await indexer.start([image], [workPath]);
  const state = indexer.getState();
  assert.equal(indexer.getStatus().status, "complete");
  assert.equal(state.photos.length, 1, "The Windows geo indexer reads the embedded GPS photo");
  assert.ok(Math.abs(state.photos[0].latitude - 46.05) < 0.0001);
  assert.ok(Math.abs(state.photos[0].longitude - 14.5) < 0.0001);
  assert.equal(state.photos[0].locationSource, "embedded");
  console.log("Windows geo indexing read and indexed embedded GPS coordinates.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(workPath, { recursive: true, force: true });
  });
