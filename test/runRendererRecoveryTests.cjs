const assert = require("assert");
const { RendererRecovery } = require("../electron-dist/rendererRecovery");
let time = 0;
const recovery = new RendererRecovery(() => time);
assert.deepEqual(recovery.plan("clean-exit", false), {
  restart: false,
  delay: 0,
  manual: false,
});
assert.deepEqual(recovery.plan("crashed", true), {
  restart: false,
  delay: 0,
  manual: false,
});
assert.deepEqual(recovery.plan("crashed", false), {
  restart: true,
  delay: 1000,
  manual: false,
});
assert.deepEqual(recovery.plan("abnormal-exit", false), {
  restart: true,
  delay: 5000,
  manual: false,
});
assert.deepEqual(recovery.plan("crashed", false), {
  restart: false,
  delay: 0,
  manual: true,
});
time = 300001;
assert.equal(recovery.plan("crashed", false).restart, true);
assert.equal(new RendererRecovery().plan("oom", false).manual, true);
console.log(
  "Renderer recovery tests passed: delayed recovery, bounded crash loops, manual OOM recovery, shutdown and intentional-exit protection.",
);
