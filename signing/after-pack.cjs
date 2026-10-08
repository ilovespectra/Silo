'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const packageJson = require('../package.json');

const signingSecrets = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
const hasCompleteSigningSetup = signingSecrets.every((name) => {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
});

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || hasCompleteSigningSetup) {
    return;
  }

  const productName = context.packager.appInfo.productFilename || packageJson.build.productName;
  const appPath = path.join(context.appOutDir, `${productName}.app`);

  execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--entitlements',
    path.join(__dirname, 'entitlements.mac.plist'),
    appPath,
  ], { stdio: 'inherit' });
};
