const fs = require('fs');
const path = require('path');
const projectRoot = path.resolve(__dirname, '../..');
const packageJson = require(path.join(projectRoot, 'package.json'));
const testOutput = process.env.SILO_TEST_OUTPUT_DIR;
const externalRendererBuild = process.env.BUILD_PATH;
const files = externalRendererBuild
  ? [
      { from: path.resolve(externalRendererBuild), to: 'build', filter: ['**/*'] },
      ...packageJson.build.files.filter(
        (entry) => typeof entry !== 'string' || !entry.startsWith('build/'),
      ),
    ]
  : packageJson.build.files;
// Google OAuth (desktop client, PKCE) ships as a Google-only file built from .env or CI env vars.
function writeGoogleOAuthResource() {
  const values = {};
  try {
    for (const line of fs.readFileSync(path.join(projectRoot, '.env'), 'utf8').split('\n')) {
      const match = /^\s*(GOOGLE_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // No local .env; fall back to the environment.
  }
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])
    if (process.env[key]) values[key] = process.env[key];
  if (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_CLIENT_SECRET) return null;
  const target = path.join(projectRoot, '.google-oauth', 'google.env');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  return { from: '.google-oauth/google.env', to: 'google.env' };
}
const googleOAuthResource = writeGoogleOAuthResource();
const extraResources = [
  ...(testOutput
    ? packageJson.build.extraResources.filter(({ from }) => from !== '.model-test-cache')
    : packageJson.build.extraResources),
  ...(googleOAuthResource ? [googleOAuthResource] : []),
];

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

module.exports = {
  ...packageJson.build,
  files: [
    ...files,
    // dist-mac temporarily parks the previous binary here during architecture staging.
    // These copies are build-only and must not ship inside the installed app.
    '!node_modules/ffmpeg-static/.ffmpeg-silo-backup-*',
  ],
  directories: {
    ...packageJson.build.directories,
    ...(testOutput ? { output: testOutput } : {}),
  },
  extraResources,
  afterPack: require(path.join(projectRoot, 'scripts', 'after-pack.cjs')),
  mac: {
    ...packageJson.build.mac,
    identity: hasCompleteSigningSetup ? undefined : null,
    forceCodeSigning: hasCompleteSigningSetup,
    hardenedRuntime: true,
    entitlements: 'signing/entitlements.mac.plist',
    entitlementsInherit: 'signing/entitlements.mac.inherit.plist',
    notarize: hasCompleteSigningSetup
      ? { teamId: process.env.APPLE_TEAM_ID }
      : false,
  },
  dmg: {
    title: packageJson.build.productName,
    background: 'public/dmg-background.png',
    window: { width: 720, height: 500 },
    contents: [
      { x: 150, y: 175, type: 'file' },
      { x: 570, y: 175, type: 'link', path: '/Applications' },
    ],
  },
};
