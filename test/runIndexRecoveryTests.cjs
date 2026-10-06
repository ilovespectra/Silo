const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { IndexingRecovery } = require("../electron-dist/indexingRecovery");
const settle = () => new Promise(setImmediate);
async function run() {
  let time = 0,
    calls = 0;
  let progress = {
    status: "paused",
    message: "Indexing was interrupted and is ready to resume.",
  };
  const recovery = new IndexingRecovery(
    [
      {
        id: "search",
        lane: "analysis",
        progress: () => progress,
        ready: () => true,
        start: async () => {
          calls++;
          progress = { status: "error", message: "Model unavailable" };
        },
      },
    ],
    () => time,
  );
  await recovery.tick();
  await settle();
  assert.equal(calls, 1);
  await recovery.tick();
  await settle();
  assert.equal(calls, 1);
  time = 10000;
  await recovery.tick();
  await settle();
  assert.equal(calls, 2);
  time = 30000;
  await recovery.tick();
  await settle();
  assert.equal(calls, 3);
  assert(recovery.details("search").retryExhausted);
  time = 30001;
  await recovery.tick();
  await settle();
  assert.equal(calls, 3);
  time = 330000;
  await recovery.tick();
  await settle();
  assert.equal(calls, 4, "automatic recovery resumes after cooldown");
  await recovery.retry("search");
  assert.equal(calls, 5, "manual retry bypasses cooldown");
  progress = { status: "paused", message: "Indexing paused." };
  recovery.pause("search");
  time += 1000000;
  await recovery.tick();
  await settle();
  assert.equal(calls, 5, "user pause preserved");
  let endAnalysis,
    endLight,
    heavy = 0,
    light = 0,
    secondHeavy = 0;
  const scheduler = new IndexingRecovery([
    {
      id: "a",
      lane: "analysis",
      needsInitialCheck: true,
      progress: () => ({ status: "idle", message: "" }),
      ready: () => true,
      start: () => {
        heavy++;
        return new Promise((r) => {
          endAnalysis = r;
        });
      },
    },
    {
      id: "b",
      lane: "analysis",
      needsInitialCheck: true,
      progress: () => ({ status: "idle", message: "" }),
      ready: () => true,
      start: async () => {
        secondHeavy++;
      },
    },
    {
      id: "c",
      lane: "light",
      needsInitialCheck: true,
      progress: () => ({ status: "idle", message: "" }),
      ready: () => true,
      start: () => {
        light++;
        return new Promise((r) => {
          endLight = r;
        });
      },
    },
  ]);
  await scheduler.tick();
  await settle();
  assert.equal(heavy, 1);
  assert.equal(light, 1);
  assert.equal(secondHeavy, 0);
  await scheduler.tick();
  assert.equal(heavy, 1);
  assert.equal(light, 1);
  await scheduler.retry("b");
  assert.equal(
    scheduler.details("b").resumeQueued,
    true,
    "busy lane accepts queued manual resume",
  );
  assert.equal(secondHeavy, 0);
  endAnalysis();
  endLight();
  await settle();
  await scheduler.tick();
  await settle();
  assert.equal(secondHeavy, 1);
  assert.equal(scheduler.details("b").resumeQueued, false);
  scheduler.stop();
  await scheduler.tick();
  assert.equal(secondHeavy, 1);
  await assert.rejects(scheduler.retry("unknown"), /does not support/);
  let ready = false,
    resumed = 0;
  const startup = new IndexingRecovery([
    {
      id: "faces",
      lane: "analysis",
      progress: () => ({ status: "paused", message: "Indexing paused." }),
      ready: () => ready,
      start: async () => {
        resumed++;
      },
    },
  ]);
  await startup.retry("faces");
  await startup.retry("faces");
  assert.equal(startup.details("faces").resumeQueued, true);
  assert.equal(resumed, 0);
  ready = true;
  await startup.tick();
  await settle();
  assert.equal(
    resumed,
    1,
    "queued user resume starts once after startup is ready",
  );
  assert.equal(startup.details("faces").resumeQueued, false);

  let clipComplete = true;
  let clipProgress = "complete";
  let finishClip;
  const demoQueueOrder = [];
  const demoPipeline = new IndexingRecovery([
    {
      id: "clip",
      lane: "analysis",
      needsInitialCheck: true,
      progress: () => ({ status: clipProgress, message: "" }),
      ready: () => true,
      start: () => {
        demoQueueOrder.push("clip");
        clipComplete = false;
        clipProgress = "indexing";
        return new Promise((resolve) => {
          finishClip = () => {
            clipProgress = "complete";
            clipComplete = true;
            resolve();
          };
        });
      },
    },
    {
      id: "people",
      lane: "analysis",
      needsInitialCheck: true,
      progress: () => ({ status: "idle", message: "" }),
      ready: () => clipComplete,
      start: async () => {
        demoQueueOrder.push("people");
      },
    },
    {
      id: "places",
      lane: "light",
      needsInitialCheck: true,
      progress: () => ({ status: "idle", message: "" }),
      ready: () => clipComplete,
      start: async () => {
        demoQueueOrder.push("places");
      },
    },
    {
      id: "duplicates",
      lane: "disk",
      needsInitialCheck: true,
      progress: () => ({ status: "idle", message: "" }),
      ready: () => clipComplete,
      start: async () => {
        demoQueueOrder.push("duplicates");
      },
    },
  ]);
  await demoPipeline.tick();
  await settle();
  assert.deepEqual(demoQueueOrder, ["clip"]);
  finishClip();
  await settle();
  await demoPipeline.tick();
  await settle();
  assert.equal(demoQueueOrder[0], "clip");
  assert(demoQueueOrder.includes("people"));
  assert(demoQueueOrder.includes("places"));
  assert(demoQueueOrder.includes("duplicates"));
  demoPipeline.stop();

  let systemPausedCalls = 0;
  let systemPausedProgress = {
    status: "paused",
    message: "Worker paused while waiting for resources.",
  };
  const systemPausedRecovery = new IndexingRecovery([
    {
      id: "locations",
      needsInitialCheck: true,
      progress: () => systemPausedProgress,
      ready: () => true,
      start: async () => {
        systemPausedCalls += 1;
        systemPausedProgress = { status: "complete", message: "Indexed." };
      },
    },
  ]);
  await systemPausedRecovery.tick();
  await settle();
  assert.equal(systemPausedCalls, 1, "system pauses resume without a manual retry");

  const pausedPath = path.join(os.tmpdir(), `silo-user-pause-${process.pid}.json`);
  const userPausedProgress = {
    status: "paused",
    message: "Indexing paused.",
  };
  let userPausedCalls = 0;
  const userPausedStage = {
    id: "faces",
    needsInitialCheck: true,
    progress: () => userPausedProgress,
    ready: () => true,
    start: async () => {
      userPausedCalls += 1;
      userPausedProgress.status = "complete";
    },
  };
  const savedPause = new IndexingRecovery(
    [userPausedStage],
    () => time,
    pausedPath,
  );
  savedPause.pause("faces");
  const restoredPause = new IndexingRecovery(
    [userPausedStage],
    () => time,
    pausedPath,
  );
  await restoredPause.tick();
  await settle();
  assert.equal(userPausedCalls, 0, "explicit pauses survive a restart");
  const staleRequestedState = JSON.parse(fs.readFileSync(pausedPath, "utf8"));
  staleRequestedState.requested = ["faces"];
  fs.writeFileSync(pausedPath, JSON.stringify(staleRequestedState));
  const restoredStalePause = new IndexingRecovery(
    [userPausedStage],
    () => time,
    pausedPath,
  );
  await restoredStalePause.tick();
  await settle();
  assert.equal(userPausedCalls, 0, "stale queued work cannot override a saved pause");
  assert.equal(restoredStalePause.details("faces").resumeQueued, false);
  restoredStalePause.queue("faces");
  assert.equal(restoredStalePause.details("faces").userPaused, false);
  const resumedAfterTransition = new IndexingRecovery(
    [userPausedStage],
    () => time,
    pausedPath,
  );
  await resumedAfterTransition.tick();
  await settle();
  assert.equal(
    userPausedCalls,
    1,
    "an explicitly queued transition resumes paused work after restart",
  );
  fs.rmSync(pausedPath, { force: true });

  const recoveryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "silo-index-recovery-"),
  );
  const recoveryPath = path.join(recoveryDirectory, "recovery.json");
  let persistentTime = 0;
  let persistentCalls = 0;
  let persistentProgress = { status: "error", message: "Worker unavailable" };
  const persistentStage = {
    id: "search",
    progress: () => persistentProgress,
    ready: () => true,
    start: async () => {
      persistentCalls += 1;
      if (persistentCalls > 1)
        persistentProgress = { status: "complete", message: "Ready" };
      else throw new Error("Worker unavailable");
    },
  };
  const firstProcess = new IndexingRecovery(
    [persistentStage],
    () => persistentTime,
    recoveryPath,
  );
  await firstProcess.retry("search");
  await settle();
  assert.equal(firstProcess.details("search").attempts, 1);
  assert.equal(fs.existsSync(recoveryPath), true);

  const restartedProcess = new IndexingRecovery(
    [persistentStage],
    () => persistentTime,
    recoveryPath,
  );
  assert.equal(
    restartedProcess.details("search").recoveryError,
    "Worker unavailable",
    "failure and cooldown survive a restart",
  );
  await restartedProcess.tick();
  await settle();
  assert.equal(persistentCalls, 1, "saved cooldown prevents a restart retry storm");
  persistentTime = 10000;
  await restartedProcess.tick();
  await settle();
  assert.equal(persistentCalls, 2, "retry resumes after saved cooldown");
  assert.equal(restartedProcess.details("search").recoveryError, "");

  const queuedPath = path.join(recoveryDirectory, "queued.json");
  let sourceReady = false;
  let queuedRuns = 0;
  const queuedStage = {
    id: "faces",
    progress: () => ({ status: "idle", message: "Waiting" }),
    ready: () => sourceReady,
    start: async () => {
      queuedRuns += 1;
    },
  };
  const beforeRestart = new IndexingRecovery(
    [queuedStage],
    () => persistentTime,
    queuedPath,
  );
  await beforeRestart.retry("faces");
  assert.equal(beforeRestart.details("faces").resumeQueued, true);
  sourceReady = true;
  const afterRestart = new IndexingRecovery(
    [queuedStage],
    () => persistentTime,
    queuedPath,
  );
  await afterRestart.tick();
  await settle();
  assert.equal(queuedRuns, 1, "queued source work survives a restart");

  let partialCalls = 0;
  let unresolved = true;
  const partialRecovery = new IndexingRecovery(
    [
      {
        id: "thumbnails",
        progress: () => ({ status: "complete", message: "Finished" }),
        ready: () => true,
        unresolvedWork: () =>
          unresolved ? "One thumbnail still needs a retry." : null,
        start: async () => {
          partialCalls += 1;
        },
      },
    ],
    () => persistentTime,
  );
  await partialRecovery.retry("thumbnails");
  await settle();
  assert.match(
    partialRecovery.details("thumbnails").recoveryError,
    /thumbnail still needs a retry/,
  );
  persistentTime += 10000;
  unresolved = false;
  await partialRecovery.tick();
  await settle();
  assert.equal(partialCalls, 2, "partial failures retry after backoff");
  assert.equal(partialRecovery.details("thumbnails").recoveryError, "");
  fs.rmSync(recoveryDirectory, { recursive: true, force: true });
  console.log(
    "Recovery scheduling tests passed: restart-safe cooldowns, partial-failure retries, interrupted resume, manual bypass, intentional pauses, parallel lanes, single-flight, and shutdown.",
  );
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
