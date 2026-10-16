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
  verifyPackagedPhoneTools(context);
  await signPackagedMacApp(context);
};
