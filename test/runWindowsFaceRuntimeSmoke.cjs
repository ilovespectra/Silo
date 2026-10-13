const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const resourcesArgument = process.argv[2];
assert.ok(resourcesArgument, "Pass the win-unpacked resources directory");
const resources = path.resolve(resourcesArgument);
assert.ok(fs.statSync(resources).isDirectory(), "The win-unpacked resources directory exists");
const root = path.resolve(__dirname, "..");
const modelPath = path.join(resources, "face-models");
const wasmPath = path.join(resources, "face-wasm");
const workPath = path.join(root, "tmp", "windows-face-runtime-smoke");
fs.mkdirSync(workPath, { recursive: true });

async function main() {
  const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
  const wasm = require("@tensorflow/tfjs-backend-wasm");
  const sharp = require("sharp");
  wasm.setThreadsCount(2);
  wasm.setWasmPaths(`${wasmPath}${path.sep}`);
  await faceapi.tf.setBackend("wasm");
  await faceapi.tf.ready();
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(modelPath),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath),
  ]);

  const imagePath = path.join(workPath, "runtime-smoke.png");
  await sharp({
    create: {
      width: 128,
      height: 128,
      channels: 3,
      background: { r: 90, g: 120, b: 145 },
    },
  }).png().toFile(imagePath);
  const decoded = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tensor = faceapi.tf.tensor3d(
    new Uint8Array(decoded.data),
    [decoded.info.height, decoded.info.width, decoded.info.channels],
    "int32",
  );
  let detections;
  try {
    detections = await faceapi
      .detectAllFaces(
        tensor,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();
  } finally {
    tensor.dispose();
  }
  assert.ok(Array.isArray(detections), "Face detector returns results on the Windows WASM backend");
  console.log(`Windows face runtime loaded bundled models and completed inference (${detections.length} detections on the smoke image).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(workPath, { recursive: true, force: true });
  });
