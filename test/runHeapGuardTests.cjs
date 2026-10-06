const assert = require("assert");
const { HeapGuard } = require("../electron-dist/heapGuard");

async function run() {
  const limit = 1000;
  let used = 100;
  let time = 0;
  let collections = 0;
  const events = [];
  const guard = new HeapGuard({
    highRatio: 0.7,
    lowRatio: 0.45,
    settleMs: 1000,
    sample: () => ({ used, limit }),
    now: () => time,
    collect: () => {
      collections += 1;
    },
    onPressure: () => events.push("pressure"),
    onRelief: () => events.push("relief"),
  });

  await guard.tick();
  assert.deepStrictEqual(events, [], "low usage does nothing");

  // Transient garbage that a collection clears must not pause indexing.
  used = 800;
  const transient = new HeapGuard({
    sample: () => ({ used: collections > 0 ? 300 : 800, limit }),
    collect: () => {
      collections += 1;
    },
    onPressure: () => events.push("transient-pressure"),
    onRelief: () => {},
  });
  await transient.tick();
  assert.ok(!events.includes("transient-pressure"));
  assert.strictEqual(collections, 1);

  await guard.tick();
  assert.deepStrictEqual(events, ["pressure"]);
  assert.ok(guard.isUnderPressure());

  // Between the thresholds: stays paused (hysteresis).
  used = 600;
  time += 5000;
  await guard.tick();
  assert.deepStrictEqual(events, ["pressure"]);

  // Below low threshold must settle before resuming.
  used = 300;
  await guard.tick();
  assert.deepStrictEqual(events, ["pressure"]);
  time += 500;
  await guard.tick();
  assert.deepStrictEqual(events, ["pressure"]);
  time += 600;
  await guard.tick();
  assert.deepStrictEqual(events, ["pressure", "relief"]);
  assert.ok(!guard.isUnderPressure());

  // A spike during settling resets the timer.
  used = 800;
  await guard.tick();
  used = 300;
  await guard.tick();
  time += 900;
  used = 500;
  await guard.tick();
  used = 300;
  time += 200;
  await guard.tick();
  assert.deepStrictEqual(events, ["pressure", "relief", "pressure"]);

  console.log("heap guard tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
