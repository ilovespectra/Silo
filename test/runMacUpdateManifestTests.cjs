const assert = require("node:assert/strict");
const {
  mergeMacUpdateManifests,
} = require("../scripts/merge-mac-update-manifests.cjs");

function makeManifest(architecture, releaseDate = "2026-10-07T10:00:00.000Z") {
  return {
    version: "2.0.1",
    files: [
      {
        url: `Silo-2.0.1-${architecture}.zip`,
        sha512: `${architecture}-zip-checksum`,
        size: 500,
      },
      {
        url: `Silo-2.0.1-${architecture}.dmg`,
        sha512: `${architecture}-dmg-checksum`,
        size: 520,
      },
    ],
    path: `Silo-2.0.1-${architecture}.zip`,
    sha512: `${architecture}-zip-checksum`,
    releaseDate,
  };
}

const merged = mergeMacUpdateManifests(
  makeManifest("x64"),
  makeManifest("arm64", "2026-10-07T11:00:00.000Z"),
);
assert.equal(merged.version, "2.0.1");
assert.equal(merged.files.length, 4);
assert.equal(merged.path, "Silo-2.0.1-x64.zip");
assert.equal(merged.releaseDate, "2026-10-07T11:00:00.000Z");
assert.deepEqual(
  merged.files.map((file) => file.url),
  [
    "Silo-2.0.1-x64.zip",
    "Silo-2.0.1-x64.dmg",
    "Silo-2.0.1-arm64.zip",
    "Silo-2.0.1-arm64.dmg",
  ],
);

assert.throws(
  () =>
    mergeMacUpdateManifests(
      makeManifest("x64"),
      { ...makeManifest("arm64"), version: "2.0.2" },
    ),
  /same version/,
);
assert.throws(
  () =>
    mergeMacUpdateManifests(makeManifest("x64"), {
      ...makeManifest("arm64"),
      files: makeManifest("arm64").files.filter((file) => !file.url.endsWith(".zip")),
    }),
  /no arm64 ZIP update/,
);
console.log("macOS update manifest tests passed");
