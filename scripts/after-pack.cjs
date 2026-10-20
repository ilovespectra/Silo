'use strict';

const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');
const signPackagedMacApp = require('../signing/after-pack.cjs');

const IOS_TOOLS = [
  'idevice_id',
  'ideviceinfo',
  'idevicepair',
  'afcclient',
  'idevicebackup2',
];

function ensureWindowsSharpRuntime(context) {
  if (context.electronPlatformName !== 'win32') return;

  const sourceDirectory = path.join(__dirname, '..', 'node_modules', '@img', 'sharp-win32-x64');
  const targetDirectory = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@img',
    'sharp-win32-x64',
  );
  const requiredFiles = [
    'lib/sharp-win32-x64.node',
    'lib/libvips-42.dll',
    'lib/libvips-cpp-8.17.3.dll',
  ];

  for (const relativePath of requiredFiles) {
    const source = path.join(sourceDirectory, relativePath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Installed Windows Sharp runtime is missing ${relativePath}.`);
    }
  }

  fs.mkdirSync(path.dirname(targetDirectory), { recursive: true });
  fs.cpSync(sourceDirectory, targetDirectory, { recursive: true, force: true });

  for (const relativePath of requiredFiles) {
    const target = path.join(targetDirectory, relativePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`Packaged Windows Sharp runtime is missing ${relativePath}.`);
    }
  }

  console.log('  • Silo: verified the packaged Windows Sharp runtime.');
}

function verifyPackagedPhoneTools(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'darwin' && platform !== 'win32') return;

  const productFilename = context.packager.appInfo.productFilename
    || packageJson.build.productName;
  const resourcesDirectory = platform === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const phoneToolsDirectory = path.join(resourcesDirectory, 'phone-tools');
  const executableNames = platform === 'win32'
    ? [...IOS_TOOLS.map((name) => `${name}.exe`), 'adb.exe']
    : [...IOS_TOOLS, 'adb'];

  for (const name of executableNames) {
    const executable = path.join(phoneToolsDirectory, name);
    let stats;
    try {
      stats = fs.statSync(executable);
    } catch {
      throw new Error(
        `Packaged ${platform} app is missing ${name} in resources/phone-tools. `
        + 'Rebuild the bundled phone tools before packaging.',
      );
    }
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`Packaged phone tool is empty or invalid: ${executable}`);
    }
    if (platform === 'darwin' && (stats.mode & 0o111) === 0) {
      throw new Error(`Packaged phone tool is not executable: ${executable}`);
    }
  }

  if (platform === 'win32') {
    for (const name of ['AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const supportLibrary = path.join(phoneToolsDirectory, name);
      if (!fs.existsSync(supportLibrary)) {
        throw new Error(`Packaged Windows phone tools are missing ${name}.`);
      }
    }
  }

  console.log(`  • Silo: verified ${executableNames.length} packaged ${platform} phone tools.`);
}

module.exports = async function afterPack(context) {
  ensureWindowsSharpRuntime(context);
  verifyPackagedPhoneTools(context);
  await signPackagedMacApp(context);
};
