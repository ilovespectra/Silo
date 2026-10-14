'use strict';

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^v/i, '').replace(/[-_ ].*$/, '');
  const match = /^([0-9]+)\.([0-9]+)(?:\.([0-9]+))?(?:\.(?:[0-9]+))*$/.exec(cleaned);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] === b[index]) continue;
    return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function bumpPatchVersion(value) {
  const parsed = parseSemver(value);
  if (!parsed) throw new Error(`Invalid release version: ${value}`);
  const [major, minor, patch] = parsed;
  return patch >= 9 ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

module.exports = { parseSemver, compareVersions, bumpPatchVersion };
