const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function validateManifest(manifest, architecture, sourcePath) {
  if (!manifest || typeof manifest.version !== "string") {
    throw new Error(`${sourcePath} has no version.`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${sourcePath} has no update files.`);
  }
  for (const file of manifest.files) {
    if (
      typeof file.url !== "string" ||
      !file.url.includes(`-${architecture}.`) ||
      typeof file.sha512 !== "string" ||
      !Number.isFinite(file.size)
    ) {
      throw new Error(
        `${sourcePath} contains an invalid ${architecture} update file.`,
      );
    }
  }
  if (!manifest.files.some((file) => file.url.endsWith(`-${architecture}.zip`))) {
    throw new Error(`${sourcePath} has no ${architecture} ZIP update.`);
  }
}

function mergeMacUpdateManifests(x64Manifest, arm64Manifest) {
  validateManifest(x64Manifest, "x64", "x64 manifest");
  validateManifest(arm64Manifest, "arm64", "arm64 manifest");
  if (x64Manifest.version !== arm64Manifest.version) {
    throw new Error("The architecture manifests must use the same version.");
  }

  const files = [...x64Manifest.files, ...arm64Manifest.files];
  const urls = files.map((file) => file.url);
  if (new Set(urls).size !== urls.length) {
    throw new Error("The architecture manifests contain duplicate asset names.");
  }

  const x64Zip = x64Manifest.files.find((file) => file.url.endsWith("-x64.zip"));
  const dates = [x64Manifest.releaseDate, arm64Manifest.releaseDate]
    .filter((value) => typeof value === "string")
    .sort();

  return {
    version: x64Manifest.version,
    files,
    path: x64Zip.url,
    sha512: x64Zip.sha512,
    ...(dates.length > 0 ? { releaseDate: dates[dates.length - 1] } : {}),
  };
}

function mergeMacUpdateManifestFiles(
  x64Path = path.join("release", "x64", "latest-mac.yml"),
  arm64Path = path.join("release", "arm64", "latest-mac.yml"),
  outputPath = path.join("release", "latest-mac.yml"),
) {
  const x64Manifest = yaml.load(fs.readFileSync(x64Path, "utf8"));
  const arm64Manifest = yaml.load(fs.readFileSync(arm64Path, "utf8"));
  const merged = mergeMacUpdateManifests(x64Manifest, arm64Manifest);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.dump(merged, { lineWidth: -1 }));
  return merged;
}

if (require.main === module) {
  try {
    const [x64Path, arm64Path, outputPath] = process.argv.slice(2);
    mergeMacUpdateManifestFiles(x64Path, arm64Path, outputPath);
    console.log(`Wrote combined macOS update manifest to ${outputPath || "release/latest-mac.yml"}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  mergeMacUpdateManifests,
  mergeMacUpdateManifestFiles,
};
