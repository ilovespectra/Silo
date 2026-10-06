const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function readPublicKeyFromSource(sourceText) {
  const match = /export const BETA_LICENSE_PUBLIC_KEY = ("(?:\\.|[^"\\])*");/.exec(
    sourceText,
  );
  if (!match) throw new Error("Could not read src/betaLicensePublicKey.ts.");
  return JSON.parse(match[1]);
}

function normalizeBetaPublicKey(publicKeyPem) {
  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim())
    throw new Error(
      "Beta licensing is not configured. Run npm run beta:keys, commit src/betaLicensePublicKey.ts, then rebuild the release.",
    );
  if (containsPrivateKeyMaterial(publicKeyPem))
    throw new Error("The beta public-key module must not contain a private key.");
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch {
    throw new Error("The beta public key is not a valid public-key PEM.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("The beta public key must be an Ed25519 key.");
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function containsPrivateKeyMaterial(text) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
}

function isPrivateKeyFileName(filePath) {
  return /(?:beta-license-private|private[-_].*key|signing[-_].*key).*\.pem$/i.test(
    filePath,
  );
}

function packagedTextFiles(rootPath, result = []) {
  if (!fs.existsSync(rootPath)) return result;
  const stats = fs.lstatSync(rootPath);
  if (stats.isSymbolicLink()) return result;
  if (stats.isFile()) {
    if (/\.(?:cjs|css|html|js|json|map|mjs|pem|ts|txt)$/i.test(rootPath))
      result.push(rootPath);
    return result;
  }
  if (!stats.isDirectory()) return result;
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) packagedTextFiles(entryPath, result);
    else if (
      entry.isFile() &&
      /\.(?:cjs|css|html|js|json|map|mjs|pem|ts|txt)$/i.test(entry.name)
    )
      result.push(entryPath);
  }
  return result;
}

function assertNoPrivateKeyMaterial(filePaths) {
  const leakingFiles = filePaths.filter((filePath) => {
    if (isPrivateKeyFileName(filePath)) return true;
    return containsPrivateKeyMaterial(fs.readFileSync(filePath, "utf8"));
  });
  if (leakingFiles.length)
    throw new Error(
      `Private signing-key material is present in a packaged input: ${path.basename(leakingFiles[0])}`,
    );
}

function checkRelease(projectRoot) {
  const sourcePublicKey = normalizeBetaPublicKey(
    readPublicKeyFromSource(
      fs.readFileSync(
        path.join(projectRoot, "src", "betaLicensePublicKey.ts"),
        "utf8",
      ),
    ),
  );
  const compiledPublicKeyModule = path.join(
    projectRoot,
    "electron-dist",
    "betaLicensePublicKey.js",
  );
  if (!fs.existsSync(compiledPublicKeyModule))
    throw new Error("Electron output is missing; run tsc before the release check.");
  const compiledPublicKey = normalizeBetaPublicKey(
    require(compiledPublicKeyModule).BETA_LICENSE_PUBLIC_KEY,
  );
  if (compiledPublicKey !== sourcePublicKey)
    throw new Error(
      "The compiled beta public key does not match the source key. Re-run tsc before packaging.",
    );

  const electronMainPath = path.join(projectRoot, "electron-dist", "main.js");
  if (!fs.existsSync(electronMainPath))
    throw new Error("The compiled Electron main process is missing.");
  const electronMain = fs.readFileSync(electronMainPath, "utf8");
  if (
    !electronMain.includes("get-beta-activation-info") ||
    !electronMain.includes("activate-beta-license") ||
    !electronMain.includes("check-lifetime-payment-reference")
  )
    throw new Error("The compiled main process is missing beta or payment handlers.");

  const rendererDirectory = path.join(projectRoot, "build", "static", "js");
  const rendererFiles = packagedTextFiles(rendererDirectory).filter((filePath) =>
    filePath.endsWith(".js"),
  );
  if (!fs.existsSync(path.join(projectRoot, "build", "index.html")))
    throw new Error("The built renderer is missing index.html.");
  const rendererText = rendererFiles
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  if (!rendererText.includes("Beta tester access"))
    throw new Error("The built renderer is missing the beta activation panel.");
  if (!rendererText.includes("Scan to pay with your Solana wallet"))
    throw new Error("The built renderer is missing the Solana Pay QR panel.");

  const packagedInputs = [
    ...packagedTextFiles(path.join(projectRoot, "electron-dist")),
    ...packagedTextFiles(path.join(projectRoot, "build")),
    ...packagedTextFiles(path.join(projectRoot, ".model-test-cache")),
    path.join(projectRoot, "public", "preload.js"),
  ].filter((filePath) => fs.existsSync(filePath));
  assertNoPrivateKeyMaterial(packagedInputs);
  return { rendererFiles: rendererFiles.length, scannedFiles: packagedInputs.length };
}

if (require.main === module) {
  try {
    const result = checkRelease(path.resolve(__dirname, ".."));
    console.log(
      `Beta release checks passed (${result.rendererFiles} renderer bundles; ${result.scannedFiles} packaged text files scanned).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  assertNoPrivateKeyMaterial,
  containsPrivateKeyMaterial,
  isPrivateKeyFileName,
  normalizeBetaPublicKey,
  readPublicKeyFromSource,
};
