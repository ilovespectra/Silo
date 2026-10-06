const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const source = fs.readFileSync(
  path.join(__dirname, "../src/utils/selectedMedia.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const m = { exports: {} };
new Function("module", "exports", compiled)(m, m.exports);
const { selectedMedia } = m.exports;
const noTraversal = new Proxy([], {
  get() {
    throw new Error("Empty selection must not inspect inventory");
  },
});
assert.deepEqual(selectedMedia([], noTraversal, noTraversal), []);
const photo = {
  path: "photo",
  type: "image",
  isDirectory: false,
  name: "original",
};
const video = { path: "video", type: "video", isDirectory: false };
const audio = { path: "audio", type: "audio", isDirectory: false };
const directory = { path: "directory", type: "image", isDirectory: true };
const override = { ...photo, name: "search result" };
assert.deepEqual(
  selectedMedia(
    ["photo", "video", "audio", "directory", "missing", "photo"],
    [photo, video, audio, directory],
    [override],
  ),
  [override, video],
);
const inventory = Array.from({ length: 1000000 }, (_, i) => ({
  path: String(i),
  type: "image",
  isDirectory: false,
}));
const NativeMap = global.Map;
let peakEntries = 0;
global.Map = class extends NativeMap {
  set(key, value) {
    const result = super.set(key, value);
    peakEntries = Math.max(peakEntries, this.size);
    return result;
  }
};
try {
  const result = selectedMedia(["1", "999999"], inventory, []);
  assert.equal(result.length, 2);
  assert.equal(
    peakEntries,
    2,
    "temporary Map retains selection only, not one million records",
  );
} finally {
  global.Map = NativeMap;
}
assert.deepEqual(
  selectedMedia(["photo"], [photo], [{ ...photo, type: "document" }]),
  [],
);
console.log(
  "Selected-media tests passed: no work for empty selection, one-million-file bounded allocation, selected-only retention, search precedence, and media validation.",
);
