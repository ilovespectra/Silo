#!/usr/bin/env node
// Verifies a published Silo release before users' apps try to update to it.
// Every platform's in-app updater looks for its own exact filename, so a missing
// or stale asset (for example Silo-2.0.8-arm64.dmg attached to v2.0.10) silently
// leaves that platform unable to update.
//
// Usage: node scripts/check-release-assets.cjs v2.1.0
'use strict';

const tag = process.argv[2];
if (!tag) {
  console.error('Usage: node scripts/check-release-assets.cjs <tag>');
  process.exit(2);
}
const version = /^v?(\d+\.\d+\.\d+)/.exec(tag)?.[1];
if (!version) {
  console.error(`Tag ${tag} does not start with a version like v2.1.0.`);
  process.exit(2);
}

const required = [
  `Silo-${version}-arm64.dmg`,
  `Silo-${version}-x64.dmg`,
  `Silo-${version}-x64-Setup.exe`,
];

(async () => {
  const response = await fetch(
    `https://api.github.com/repos/ilovespectra/silo-downloads/releases/tags/${encodeURIComponent(tag)}`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Silo release check' } },
  );
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${tag}.`);
  const release = await response.json();
  const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  const problems = [];
  if (release.draft) problems.push('The release is still a draft; apps cannot see it.');
  for (const name of required) {
    const asset = assets.get(name);
    if (!asset) problems.push(`Missing ${name}.`);
    else if (!(asset.size > 0)) problems.push(`${name} is empty.`);
    else if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) problems.push(`${name} has no SHA-256 digest yet.`);
  }
  for (const name of assets.keys()) {
    const assetVersion = /^Silo-(\d+\.\d+\.\d+)-/.exec(name)?.[1];
    if (assetVersion && assetVersion !== version)
      problems.push(`${name} belongs to ${assetVersion}, not ${version}; remove it.`);
  }
  if (problems.length) {
    console.error(`Release ${tag} is not safe to ship:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Release ${tag} has every platform's update file:\n- ${required.join('\n- ')}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
