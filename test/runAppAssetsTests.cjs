const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { resolveAppAssetRequest } = require("../src/appAssets.ts");
const root = path.resolve(__dirname, "..");
const packagedFiles = [
  ["countries-50m.geojson", "application/geo+json"],
  ["countries.geojson", "application/geo+json"],
  ["earth-blue-marble.jpg", "image/jpeg"],
  ["earth-night.jpg", "image/jpeg"],
  ["us-states.geojson", "application/geo+json"],
];

for (const [name, contentType] of packagedFiles) {
  const result = resolveAppAssetRequest(`silo-asset://local/${name}`, root, true);
  assert.deepEqual(result, {
    filePath: path.join(root, "build", name),
    contentType,
  });
  assert.ok(
    fs.statSync(result.filePath).size > 0,
    `${name} exists in the React build`,
  );
  assert.equal(
    resolveAppAssetRequest(`silo-asset://local/${name}`, root, false).filePath,
    path.join(root, "public", name),
  );
}

for (const url of [
  "silo-asset://local/../package.json",
  "silo-asset://local/%2e%2e%2fpackage.json",
  "silo-asset://attacker/countries.geojson",
  "silo-asset://local/countries.geojson?download=1",
  "file:///etc/passwd",
  "silo-asset://local/unknown.geojson",
]) {
  assert.equal(resolveAppAssetRequest(url, root, true), null, `reject ${url}`);
}

console.log("Bundled map asset routing and allowlist checks passed.");
