const assert = require("assert");
const fs = require("fs");
const path = require("path");

const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const panel = fs.readFileSync(
  path.join(__dirname, "../src/components/PhoneManagerPanel.tsx"),
  "utf8",
);
assert.match(app, /restorePhoneFromArchive\(\s*targetDeviceId\s*,/);
assert.match(
  panel,
  /onRestoreFromArchive\(\s*device\.id,\s*archive,\s*restorePassword\s*\)/,
);
console.log("Replacement-device restore target regression test passed.");
