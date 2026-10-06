const assert = require("assert");
const fs = require("fs");
const ts = require("typescript");
const path = require("path");

let now = 0;
let visible = false;
let dirty = false;
let dependencies;
let cleanup;
let clockId = 0;
const shownAt = { current: 0 };
const timers = new Map();
const transitions = [];
const react = {
  useState: () => [
    visible,
    (next) => {
      if (visible === next) return;
      visible = next;
      dirty = true;
      transitions.push({ time: now, visible });
    },
  ],
  useRef: () => shownAt,
  useEffect: (effect, next) => {
    if (
      dependencies &&
      next.every((value, index) => value === dependencies[index])
    )
      return;
    cleanup?.();
    dependencies = next;
    cleanup = effect();
  },
};
const fakeWindow = {
  setTimeout: (callback, delay) => {
    const id = ++clockId;
    timers.set(id, { callback, time: now + delay });
    return id;
  },
  clearTimeout: (id) => timers.delete(id),
};
const filename = path.join(__dirname, "../src/utils/useStableBusy.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const hookModule = { exports: {} };
new Function("require", "module", "exports", "window", "Date", compiled)(
  () => react,
  hookModule,
  hookModule.exports,
  fakeWindow,
  { now: () => now },
);
let busy = false;
function render(next = busy) {
  busy = next;
  do {
    dirty = false;
    hookModule.exports.useStableBusy(busy);
  } while (dirty);
}
function advance(milliseconds) {
  const end = now + milliseconds;
  while (true) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.time <= end)
      .sort((a, b) => a[1].time - b[1].time)[0];
    if (!due) break;
    now = due[1].time;
    timers.delete(due[0]);
    due[1].callback();
    if (dirty) render();
  }
  now = end;
}
render(true);
advance(100);
render(false);
advance(300);
assert.equal(visible, false, "quick loads never flash a notice");
render(true);
advance(350);
assert.equal(visible, true, "long loads show a notice after the delay");
render(false);
advance(100);
render(true);
advance(100);
render(false);
advance(999);
assert.equal(visible, true, "short gaps between scans keep the notice visible");
advance(1);
assert.equal(visible, false, "notice clears after its minimum display time");
assert.equal(
  transitions.length,
  2,
  "rapid activity produces only one show/hide cycle",
);
const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
assert(!app.includes("Keeping previews visible while sorting updates"));
assert(app.includes('className="metadata-status-slot"'));
assert(app.includes("previewedScanRef.current !== progress.requestId"));
assert(
  app.includes("current : next"),
  "identical metadata preserves the existing sort state",
);
cleanup?.();
assert.equal(timers.size, 0);
console.log(
  "Stable loading tests passed: fast jobs, rapid scan bursts, minimum display time, timer cleanup, fixed status slot, and stable scan preview.",
);
