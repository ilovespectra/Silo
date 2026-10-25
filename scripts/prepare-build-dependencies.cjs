#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
  }
}

function requireFile(relativePath, label) {
  const filePath = path.join(projectRoot, relativePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`);
  }
  return filePath;
}

function requirePackage(name) {
  const expected = packageLock.packages?.[`node_modules/${name}`]?.version;
  if (!expected) throw new Error(`${name} is missing from package-lock.json.`);
  const packagePath = path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`${name} is not installed. Run npm ci.`);
  const installed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (installed.version !== expected) {
    throw new Error(`${name} ${installed.version} is installed; package-lock.json requires ${expected}. Run npm ci.`);
  }
  return path.dirname(packagePath);
}

function ensureFfmpeg() {
  requirePackage('ffmpeg-static');
  const ffmpegPath = require('ffmpeg-static');
  if (typeof ffmpegPath !== 'string') throw new Error('ffmpeg-static did not resolve an executable path.');
  const valid = () => {
    try {
      const stat = fs.statSync(ffmpegPath);
      if (!stat.isFile() || stat.size === 0) return false;
      const header = Buffer.alloc(8);
      const fd = fs.openSync(ffmpegPath, 'r');
      try {
        fs.readSync(fd, header, 0, header.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (process.platform === 'win32') return header[0] === 0x4d && header[1] === 0x5a;
      if (process.platform === 'darwin') {
        const expectedCpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007;
        return header.readUInt32LE(0) === 0xfeedfacf &&
          header.readUInt32LE(4) === expectedCpu;
      }
      return header[0] === 0x7f && header.toString('ascii', 1, 4) === 'ELF';
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };

  if (!valid()) {
    fs.rmSync(ffmpegPath, { force: true });
    console.log('Installing the locked FFmpeg runtime binary.');
    run(process.execPath, [path.join(requirePackage('ffmpeg-static'), 'install.js')]);
  }
  if (!valid()) throw new Error(`FFmpeg is still missing or invalid: ${ffmpegPath}`);
  if (process.platform !== 'win32' && (fs.statSync(ffmpegPath).mode & 0o111) === 0) {
    throw new Error(`FFmpeg is not executable: ${ffmpegPath}`);
  }
}

function ensureNumkongProbes() {
  const directory = requirePackage('numkong');
  const header = path.join(directory, 'nk_probes.h');
  console.log('Refreshing NumKong compiler probes for this build machine.');
  run(process.execPath, [path.join(directory, 'probes', 'probe.js')]);
  requireFile(path.relative(projectRoot, header), 'NumKong compiler probe header');
}

function verifyRuntimeAssets() {
  const assets = [
    ['.model-test-cache/Xenova/clip-vit-base-patch32/tokenizer.json', 'Offline CLIP tokenizer'],
    ['.model-test-cache/Xenova/clip-vit-base-patch32/onnx/text_model_quantized.onnx', 'Offline CLIP text model'],
    ['.model-test-cache/Xenova/clip-vit-base-patch32/onnx/vision_model_quantized.onnx', 'Offline CLIP vision model'],
    ['node_modules/@vladmandic/face-api/model/tiny_face_detector_model-weights_manifest.json', 'Face detector manifest'],
    ['node_modules/@vladmandic/face-api/model/tiny_face_detector_model.bin', 'Face detector weights'],
    ['node_modules/@vladmandic/face-api/model/face_landmark_68_model-weights_manifest.json', 'Face landmark manifest'],
    ['node_modules/@vladmandic/face-api/model/face_landmark_68_model.bin', 'Face landmark weights'],
    ['node_modules/@vladmandic/face-api/model/face_recognition_model-weights_manifest.json', 'Face recognition manifest'],
    ['node_modules/@vladmandic/face-api/model/face_recognition_model.bin', 'Face recognition weights'],
    ['node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm', 'Face WASM runtime'],
    ['node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm', 'Face SIMD WASM runtime'],
    ['node_modules/@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm', 'Face threaded SIMD WASM runtime'],
    ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'Offline semantic WASM runtime'],
    ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'Offline semantic WASM loader'],
  ];
  for (const [relativePath, label] of assets) requireFile(relativePath, label);

  for (const name of ['electron', 'onnxruntime-web', 'sharp', 'usearch', 'numkong']) {
    requirePackage(name);
  }
}

function prepare() {
  if (!['darwin', 'win32'].includes(process.platform)) {
    throw new Error(`Binary packaging dependencies are unsupported on ${process.platform}.`);
  }
  console.log(`Preparing locked runtime dependencies for ${process.platform}-${process.arch}.`);
  run(process.execPath, [path.join(__dirname, 'ensure-electron-dist.cjs')]);
  ensureNumkongProbes();
  ensureFfmpeg();
  verifyRuntimeAssets();
  console.log('All required application runtime assets and build dependencies are ready.');
}

if (require.main === module) {
  try {
    prepare();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { prepare };
