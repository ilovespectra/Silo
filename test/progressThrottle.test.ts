import assert = require("assert");
import { createProgressThrottle } from "../src/progressThrottle";

type Progress = { status: string; completed: number };

function createFakeScheduler() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler = {
    now: () => now,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer as unknown as number);
    },
  };
  return {
    scheduler,
    advanceTo(target: number) {
      now = target;
      const due = Array.from(timers.entries())
        .filter(([, timer]) => timer.at <= now)
        .sort((first, second) => first[1].at - second[1].at);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    },
    pendingTimers: () => timers.size,
  };
}

const fake = createFakeScheduler();
const sent: Progress[] = [];
const publish = createProgressThrottle<Progress>(
  (progress) => sent.push(progress),
  250,
  fake.scheduler,
);

publish({ status: "indexing", completed: 0 });
assert.deepStrictEqual(sent.map((item) => item.completed), [0]);
publish({ status: "indexing", completed: 1 });
publish({ status: "indexing", completed: 2 });
assert.deepStrictEqual(sent.map((item) => item.completed), [0]);
assert.equal(fake.pendingTimers(), 1);
fake.advanceTo(250);
assert.deepStrictEqual(sent.map((item) => item.completed), [0, 2]);

publish({ status: "paused", completed: 2 });
assert.deepStrictEqual(sent.map((item) => item.status), ["indexing", "indexing", "paused"]);
assert.equal(fake.pendingTimers(), 0);

publish({ status: "paused", completed: 3 });
assert.equal(fake.pendingTimers(), 1);
publish({ status: "complete", completed: 3 });
assert.deepStrictEqual(sent[sent.length - 1], { status: "complete", completed: 3 });
assert.equal(fake.pendingTimers(), 0);

console.log("Progress throttle tests passed: updates coalesce; stage changes send immediately.");
