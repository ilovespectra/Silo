const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const resourcesArgument = process.argv[2];
assert.ok(resourcesArgument, "Pass the win-unpacked resources directory");
const resources = path.resolve(resourcesArgument);
assert.ok(fs.statSync(resources).isDirectory(), "The win-unpacked resources directory exists");
const asarPath = path.join(resources, "app.asar");
const { listPackage } = require("@electron/asar");
assert.ok(fs.statSync(asarPath).isFile(), "Packaged Electron archive exists");
const archiveFiles = new Set(
  listPackage(asarPath).map((item) => item.replaceAll("\\", "/").replace(/^\//, "")),
);
for (const asset of [
  "build/countries-50m.geojson",
  "build/countries.geojson",
  "build/earth-blue-marble.jpg",
  "build/earth-night.jpg",
  "build/us-states.geojson",
]) {
  assert.ok(archiveFiles.has(asset), `Missing packaged renderer asset ${asset}`);
}

const unpacked = path.join(resources, "app.asar.unpacked", "node_modules");
for (const name of [
  "tiny_face_detector_model-weights_manifest.json",
  "tiny_face_detector_model.bin",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model.bin",
  "face_recognition_model-weights_manifest.json",
  "face_recognition_model.bin",
]) {
  const asset = path.join(resources, "face-models", name);
  assert.ok(fs.statSync(asset).size > 0, `Missing bundled face model ${name}`);
}
for (const name of [
  "tfjs-backend-wasm.wasm",
  "tfjs-backend-wasm-simd.wasm",
  "tfjs-backend-wasm-threaded-simd.wasm",
]) {
  const asset = path.join(resources, "face-wasm", name);
  assert.ok(fs.statSync(asset).size > 0, `Missing bundled face WASM runtime ${name}`);
}

const ffmpeg = path.join(unpacked, "ffmpeg-static", "ffmpeg.exe");
assert.ok(fs.statSync(ffmpeg).size > 0, "Missing unpacked Windows FFmpeg executable");
const result = spawnSync(ffmpeg, ["-version"], { encoding: "utf8", timeout: 15000 });
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr || "Packaged FFmpeg did not start successfully");
assert.match(result.stdout, /^ffmpeg version/m);
console.log("Packaged map, face, WASM, and Windows FFmpeg assets verified.");
