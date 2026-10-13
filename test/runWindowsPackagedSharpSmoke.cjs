const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const resourcesArgument = process.argv[2];
assert.ok(resourcesArgument, "Pass the win-unpacked resources directory");
const resources = path.resolve(resourcesArgument);
assert.ok(fs.statSync(resources).isDirectory(), "The packaged resources directory exists");

const unpackedModules = path.join(resources, "app.asar.unpacked", "node_modules");
const sharpPackage = path.join(unpackedModules, "sharp");
const sharpRuntime = path.join(
  unpackedModules,
  "@img",
  "sharp-win32-x64",
  "lib",
);
for (const file of [
  path.join(sharpRuntime, "sharp-win32-x64.node"),
  path.join(sharpRuntime, "libvips-42.dll"),
  path.join(sharpRuntime, "libvips-cpp-8.17.3.dll"),
]) {
  assert.ok(fs.statSync(file).size > 0, `Packaged Sharp runtime file exists: ${path.basename(file)}`);
}

async function main() {
  const sharp = require(sharpPackage);
  const input = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 90, g: 120, b: 145 },
    },
  }).png().toBuffer();
  const result = await sharp(input).metadata();
  assert.equal(result.format, "png", "Packaged Sharp can encode and decode PNG images");
  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  console.log("Packaged Windows Sharp native runtime loaded and processed a PNG.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
