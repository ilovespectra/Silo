const assert = require("assert");
const fs = require("fs");
const path = require("path");

const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const panel = fs.readFileSync(
  path.join(__dirname, "../src/components/PhoneManagerPanel.tsx"),
  "utf8",
);
assert.match(app, /restorePhoneFromArchive\(\s*targetDeviceId\s*,/);
assert.match(panel, /onRestoreFromArchive\(targetDeviceId,\s*archive,\s*password\)/);
assert.match(panel, /restoreFromArchive\(archive,\s*deviceKey,\s*device\.id\)/);
console.log("Replacement-device restore target regression test passed.");
