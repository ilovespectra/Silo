const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(__dirname, "../../..");
const testTempRoot = process.env.SILO_STARTUP_SMOKE_ROOT
  ? path.resolve(process.env.SILO_STARTUP_SMOKE_ROOT)
  : path.join(workspaceRoot, "tmp");
const runRoot = path.join(testTempRoot, `silo-startup-smoke-${process.pid}`);
const fixture = path.join(repoRoot, "scripts", "startup-smoke", "main.cjs");
const electronBinary = require("electron");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(scenario, configureMissingExternal) {
  const scenarioRoot = path.join(runRoot, scenario);
  const userData = path.join(scenarioRoot, "userData");
  const marker = path.join(scenarioRoot, "main-window-ready.json");
  const noticeMarker = path.join(scenarioRoot, "storage-status.json");
  const readinessMarker = path.join(scenarioRoot, "search-readiness.json");
  const startupReadyMarker = path.join(scenarioRoot, "startup-ready.json");
  fs.mkdirSync(userData, { recursive: true });
  if (!configureMissingExternal) {
    const cacheRoot = path.join(scenarioRoot, "cache");
    fs.mkdirSync(cacheRoot, { recursive: true });
    const cacheSource = fs.readFileSync(
      path.join(repoRoot, "src", "cacheDestinations.ts"),
      "utf8",
    );
    const destinationBlock = cacheSource.match(
      /export const CACHE_DESTINATIONS = \[([\s\S]*?)\] as const;/,
    )?.[1];
    assert.ok(destinationBlock, "cache destination definitions were found");
    const roots = Object.fromEntries(
      [...destinationBlock.matchAll(/id: "([^"]+)"/g)].map(([, id]) => [id, cacheRoot]),
    );
    fs.writeFileSync(
      path.join(userData, "cache-destinations.json"),
      JSON.stringify({ format: "silo-cache-destinations", version: 1, roots }, null, 2),
    );
  }
  if (configureMissingExternal) {
    const missingRoot = `/Volumes/BootGuardMissing-${process.pid}-${crypto.randomBytes(5).toString("hex")}/SiloCache`;
    fs.writeFileSync(
      path.join(userData, "index-storage.json"),
      JSON.stringify({ format: "silo-index-storage", version: 1, path: missingRoot }, null, 2),
    );
  }

  const launchStartedAt = Date.now();
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
        SILO_STARTUP_SMOKE_READINESS_MARKER: readinessMarker,
        SILO_STARTUP_SMOKE_READY_MARKER: startupReadyMarker,
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

  const deadline = Date.now() + 85000;
  const complete = () => [marker, noticeMarker, readinessMarker, startupReadyMarker]
    .every((file) => fs.existsSync(file));
  while (!complete() && Date.now() < deadline && !exitResult)
    await wait(100);
  if (!complete()) {
    child.kill("SIGTERM");
    await Promise.race([exited, wait(3000)]);
    const diagnosticsPath = path.join(userData, "diagnostics", "runtime.jsonl");
    const diagnostics = fs.existsSync(diagnosticsPath)
      ? fs.readFileSync(diagnosticsPath, "utf8").slice(-10000)
      : "(no Silo startup diagnostics were written)";
    throw new Error(
      `${scenario}: startup/search readiness did not complete (${spawnError || JSON.stringify(exitResult)}).\n${output.slice(-10000)}\nSilo diagnostics:\n${diagnostics}`,
    );
  }

  const window = JSON.parse(fs.readFileSync(marker, "utf8"));
  const storage = JSON.parse(fs.readFileSync(noticeMarker, "utf8"));
  const readiness = JSON.parse(fs.readFileSync(readinessMarker, "utf8"));
  const startup = JSON.parse(fs.readFileSync(startupReadyMarker, "utf8"));
  assert.deepStrictEqual(
    { scenario: window.scenario, windowReady: window.windowReady },
    { scenario, windowReady: true },
  );
  assert.equal(startup.scenario, scenario);
  assert.equal(startup.label, "Ready");
  assert.ok(
    ["ready", "unavailable"].includes(readiness.status),
    `unexpected search readiness: ${JSON.stringify(readiness)}`,
  );
  if (configureMissingExternal) {
    assert.equal(storage.destinationAvailable, false);
    assert.equal(storage.localFallbackEnabled, true);
    assert.match(storage.message, /selected destination/i);
  } else {
    assert.equal(storage.destinationAvailable, true);
  }

  const metrics = {
    mainWindowMs: window.completedAt - launchStartedAt,
    startupReadyMs: startup.completedAt - launchStartedAt,
    searchReadyMs: readiness.completedAt - launchStartedAt,
    searchStatus: readiness.status,
  };
  assert.ok(metrics.mainWindowMs < 30000, `main window took ${metrics.mainWindowMs}ms`);
  assert.ok(metrics.startupReadyMs < 85000, `startup took ${metrics.startupReadyMs}ms`);
  assert.ok(metrics.searchReadyMs < 85000, `search readiness took ${metrics.searchReadyMs}ms`);

  await Promise.race([exited, wait(5000)]);
  if (!exitResult) child.kill("SIGTERM");
  return metrics;
}

async function main() {
  fs.rmSync(runRoot, { recursive: true, force: true });
  fs.mkdirSync(runRoot, { recursive: true });
  try {
    const normal = await runScenario("no-external-setting", false);
    assert.equal(normal.searchStatus, "ready", "search must become ready with available storage");
    const missingDrive = await runScenario("configured-drive-absent", true);
    console.log(
      "Electron startup/search smoke tests passed. " +
      JSON.stringify({ normal, missingDrive }),
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
