const packageJson = require('./package.json');

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
  mac: {
    ...packageJson.build.mac,
    identity: hasCompleteSigningSetup ? undefined : '-',
    hardenedRuntime: true,
    entitlements: 'signing/entitlements.mac.plist',
    entitlementsInherit: 'signing/entitlements.mac.inherit.plist',
    notarize: hasCompleteSigningSetup
      ? { teamId: process.env.APPLE_TEAM_ID }
      : false,
  },
};
