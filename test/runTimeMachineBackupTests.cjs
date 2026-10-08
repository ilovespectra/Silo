const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};

const { startConfiguredTimeMachineBackup } = require("../src/timeMachineBackup.ts");
const machineRoot = "/System/Volumes/Data";

async function run() {
  const calls = [];
  const runCommand = async (...args) => { calls.push(args); };

  await assert.rejects(
    startConfiguredTimeMachineBackup(machineRoot, true, { platform: "linux", runCommand }),
    /only available for This Mac/,
  );
  await assert.rejects(
    startConfiguredTimeMachineBackup("/Volumes/External", true, { platform: "darwin", runCommand }),
    /registered This Mac source/,
  );
  await assert.rejects(
    startConfiguredTimeMachineBackup(machineRoot, false, { platform: "darwin", runCommand }),
    /registered This Mac source/,
  );
  assert.equal(calls.length, 0);

  await startConfiguredTimeMachineBackup(machineRoot, true, { platform: "darwin", runCommand });
  assert.deepEqual(calls, [["/usr/bin/tmutil", ["startbackup", "--auto"]]]);

  console.log("Time Machine backup tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
