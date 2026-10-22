'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function normalizeArchitecture(arch) {
  if (arch === 'x64' || arch === 'arm64') return arch;
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function assertPathExists(relativePath, label) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`${label} is missing: ${absolutePath}. The packaged app would be incomplete.`);
  }
  return absolutePath;
}

module.exports = async function beforePack(context) {
  const platform = context.electronPlatformName || process.platform;
  const arch = normalizeArchitecture(context.arch || process.arch);
  const platformArch = platform === 'darwin' ? `darwin-${arch}` : platform === 'win32' ? `win32-${arch}` : `${platform}-${arch}`;

  const requiredDirectories = [
    { label: 'Face model directory', path: 'node_modules/@vladmandic/face-api/model' },
    { label: 'TensorFlow WASM directory', path: 'node_modules/@tensorflow/tfjs-backend-wasm/dist' },
    { label: `Phone tools (${platformArch})`, path: `vendor/phone-tools/${platformArch}` },
  ];

  for (const entry of requiredDirectories) {
    const resolved = assertPathExists(entry.path, entry.label);
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`${entry.label} is not a directory: ${resolved}`);
    }
  }

  const extraResources = Array.isArray(context.packager?.config?.extraResources)
    ? context.packager.config.extraResources
    : [];

  for (const resource of extraResources) {
    if (!resource || typeof resource !== 'object' || !resource.from) continue;
    const source = resource.from.includes('${platform}') || resource.from.includes('${arch}')
      ? resource.from
          .replace(/\$\{platform\}/g, platform)
          .replace(/\$\{arch\}/g, arch)
      : resource.from;
    assertPathExists(source, `packaging resource ${resource.to || source}`);
  }

  const requiredPhoneTools = platform === 'win32'
    ? ['adb.exe', 'idevicepair.exe', 'idevice_id.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']
    : ['adb', 'idevice_id', 'ideviceinfo', 'idevicepair', 'afcclient', 'idevicebackup2'];

  const phoneToolsDirectory = path.resolve(projectRoot, 'vendor', 'phone-tools', platformArch);
  for (const tool of requiredPhoneTools) {
    const toolPath = path.join(phoneToolsDirectory, tool);
    if (!fs.existsSync(toolPath) || !fs.statSync(toolPath).isFile()) {
      throw new Error(`Required phone tool is missing before packaging: ${toolPath}`);
    }
  }

  console.log(`  • Silo: validated all build-time packaging resources for ${platform}-${arch}.`);
};
