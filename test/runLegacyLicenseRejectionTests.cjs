const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function loadTypeScript(filePath) {
  const loaded = new Module(filePath, module);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  const source = fs.readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  loaded._compile(output, filePath);
  return loaded.exports;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "silo-legacy-license-test-"));
  try {
    const statePath = path.join(root, "lifetime-license-rejection.json");
    const { isLegacyLicenseRejected, persistLegacyLicenseRejection } =
      loadTypeScript(path.resolve(__dirname, "../src/legacyLicenseRejection.ts"));
    const originalSignature = "5".repeat(88);
    const otherSignature = "4".repeat(88);

    assert.equal(await isLegacyLicenseRejected(statePath, originalSignature), false);
    await persistLegacyLicenseRejection(statePath, originalSignature, 1234);
    assert.equal(await isLegacyLicenseRejected(statePath, originalSignature), true);
    assert.equal(await isLegacyLicenseRejected(statePath, otherSignature), false);
    assert.equal(
      fs.readFileSync(statePath, "utf8").includes(originalSignature),
      false,
      "the rejection marker stores a digest rather than a transaction signature",
    );
    await fs.promises.writeFile(statePath, "not-json");
    await assert.rejects(
      isLegacyLicenseRejected(statePath, originalSignature),
      /Unexpected token|JSON/,
      "corrupt rejection state cannot silently restore the legacy offline license",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Legacy lifetime license rejection persistence tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
