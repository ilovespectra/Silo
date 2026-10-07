const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(__dirname, "../../..");
const runRoot = path.join(workspaceRoot, "tmp", `silo-startup-smoke-${process.pid}`);
const fixture = path.join(repoRoot, "startupSmokeMain.cjs");
const electronBinary = require("electron");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(scenario, configureMissingExternal) {
  const scenarioRoot = path.join(runRoot, scenario);
  const userData = path.join(scenarioRoot, "userData");
  const marker = path.join(scenarioRoot, "window-created.json");
  const noticeMarker = path.join(scenarioRoot, "storage-notice.json");
  fs.mkdirSync(userData, { recursive: true });
  if (configureMissingExternal) {
    const missingRoot = `/Volumes/BootGuardMissing-${process.pid}-${crypto.randomBytes(5).toString("hex")}/SiloCache`;
    fs.writeFileSync(
      path.join(userData, "index-storage.json"),
      JSON.stringify({ format: "silo-index-storage", version: 1, path: missingRoot }, null, 2),
    );
  }

  const child = spawn(
    electronBinary,
    ["--headless=new", "--disable-gpu", "--no-sandbox", fixture],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        FILE_BROWSER_USER_DATA_DIR: userData,
        SILO_STARTUP_SMOKE_USER_DATA: userData,
        SILO_STARTUP_SMOKE_MARKER: marker,
        SILO_STARTUP_SMOKE_NOTICE_MARKER: noticeMarker,
        SILO_STARTUP_SMOKE_SCENARIO: scenario,
        SILO_STARTUP_SMOKE_DEBUG: "1",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  let exitResult;
  let spawnError;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve();
    });
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      resolve();
    });
  });

  const deadline = Date.now() + 50000;
  while (
    (!fs.existsSync(marker) || (configureMissingExternal && !fs.existsSync(noticeMarker))) &&
    Date.now() < deadline &&
    !exitResult
  )
    await wait(100);
  if (!fs.existsSync(marker) || (configureMissingExternal && !fs.existsSync(noticeMarker))) {
    child.kill("SIGTERM");
    await Promise.race([exited, wait(3000)]);
    const diagnosticsPath = path.join(userData, "diagnostics", "runtime.jsonl");
    const diagnostics = fs.existsSync(diagnosticsPath)
      ? fs.readFileSync(diagnosticsPath, "utf8").slice(-8000)
      : "(no Silo startup diagnostics were written)";
    throw new Error(
      `${scenario}: Electron did not create a window (${spawnError || JSON.stringify(exitResult)}).\n${output.slice(-8000)}\nSilo diagnostics:\n${diagnostics}`,
    );
  }
  const evidence = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.deepStrictEqual(evidence, { scenario, windowCreated: true });
  if (configureMissingExternal) {
    const notice = JSON.parse(fs.readFileSync(noticeMarker, "utf8"));
    assert.equal(notice.type, "warning");
    assert.equal(notice.title, "Using Local Index Storage");
    assert.match(notice.message, /could not open the selected external storage drive/i);
  } else {
    assert.equal(fs.existsSync(noticeMarker), false, "no warning is shown when no external drive was selected");
  }
  await Promise.race([exited, wait(5000)]);
  if (!exitResult) child.kill("SIGTERM");
}

async function main() {
  fs.rmSync(runRoot, { recursive: true, force: true });
  fs.mkdirSync(runRoot, { recursive: true });
  try {
    await runScenario("no-external-setting", false);
    await runScenario("configured-drive-absent", true);
    console.log("Electron startup smoke tests passed: both storage settings created a window.");
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
