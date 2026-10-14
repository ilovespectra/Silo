'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

const IDENTITY_NAME = 'Silo Code Signing';

// A stable self-signed identity keeps the app's designated requirement identical
// across releases, so macOS keeps privacy grants after an update. Ad hoc
// signatures are tied to one build's cdhash and lose them on every update.
function stableSigningIdentity() {
  const directory = process.env.SILO_MAC_SIGNING_DIR || path.join(os.homedir(), '.silo-signing');
  const keychain = process.env.SILO_MAC_SIGNING_KEYCHAIN || path.join(directory, 'silo-signing.keychain-db');
  const passwordFile = path.join(directory, 'keychain-password');
  const password = process.env.SILO_MAC_SIGNING_KEYCHAIN_PASSWORD
    || (fs.existsSync(passwordFile) ? fs.readFileSync(passwordFile, 'utf8').trim() : '');
  if (!fs.existsSync(keychain) || !password) return null;
  execFileSync('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-p', 'codesigning', keychain], { encoding: 'utf8' });
  const match = identities.split('\n')
    .map((line) => /\b([0-9A-F]{40})\s+"([^"]+)"/.exec(line))
    .find((result) => result && result[2] === IDENTITY_NAME);
  return match ? { hash: match[1], keychain } : null;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || hasCompleteSigningSetup) {
    return;
  }

  const productName = context.packager.appInfo.productFilename || packageJson.build.productName;
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  const identity = stableSigningIdentity();
  if (!identity) {
    if (process.env.SILO_REQUIRE_STABLE_MAC_SIGNING === '1') {
      throw new Error(
        'No stable Silo signing identity found. Run scripts/create-mac-signing-identity.sh once, '
        + 'or set SILO_ALLOW_ADHOC_SIGNING=1 for a build whose updates may reset macOS permissions.',
      );
    }
    console.warn('  • Silo: no stable signing identity; signing ad hoc (updates will reset macOS permissions).');
  }

  execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    identity ? identity.hash : '-',
    ...(identity ? ['--keychain', identity.keychain, '--timestamp=none'] : []),
    '--options',
    'runtime',
    '--entitlements',
    path.join(__dirname, 'entitlements.mac.plist'),
    appPath,
  ], { stdio: 'inherit' });
  if (identity) console.log(`  • Silo: signed with stable identity "${IDENTITY_NAME}" (${identity.hash.slice(0, 8)}…).`);
};
