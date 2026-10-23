"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  findSharedPeoplePair,
  parseArgs,
  replayPeopleJournal,
  validBox,
} = require("./silicon-recovery-readiness.cjs");

assert.deepEqual(parseArgs(["--people", "Alice Example", "Bob Example"]), {
  people: ["Alice Example", "Bob Example"],
});
assert.throws(() => parseArgs(["--people", "Alice Example"]), /requires a value/);
assert.throws(() => parseArgs(["--people", "Alice Example", "Alice Example"]), /two different/);
assert.equal(validBox({ x: 0, y: 0, width: 0.25, height: 0.25 }), true);
assert.equal(validBox({ x: 0.9, y: 0.9, width: 0.2, height: 0.2 }), false);

const people = [
  { id: "auto", name: "Person 1", confirmedPhotoPaths: ["/group.jpg"] },
  { id: "alice", name: "Alice Example", nameSource: "user", confirmedPhotoPaths: ["/group.jpg", "/solo.jpg"] },
  { id: "bob", name: "Bob Example", nameSource: "user", confirmedPhotoPaths: ["/group.jpg"] },
  { id: "banned", name: "Banned Example", nameSource: "user", status: "banned", confirmedPhotoPaths: ["/group.jpg"] },
];
const pair = findSharedPeoplePair(people);
assert.equal(pair.first.id, "alice");
assert.equal(pair.second.id, "bob");
assert.equal(pair.shared, 1);
assert.equal(findSharedPeoplePair(people, ["Alice Example", "Bob Example"]).shared, 1);
assert.equal(findSharedPeoplePair(people, ["Alice Example", "Banned Example"]), null);

const workspace = path.resolve(__dirname, "../..");
const tempRoot = fs.mkdtempSync(path.join(workspace, "tmp/silicon-gate-test-"));
try {
  const journalPath = path.join(tempRoot, "people-edits.jsonl");
  const state = {
    stateJournalVersion: 1,
    people: [{ id: "alice", name: "Alice", confirmedPhotoPaths: ["/old.jpg"] }],
    faceEdits: {},
  };
  fs.writeFileSync(journalPath, [
    JSON.stringify({
      version: 1,
      sequence: 2,
      people: { alice: { id: "alice", name: "Alice", confirmedPhotoPaths: ["/old.jpg", "/group.jpg"] } },
      faceEdits: { face1: { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } },
    }),
    JSON.stringify({ version: 1, sequence: 3, people: { bob: { id: "bob", name: "Bob", confirmedPhotoPaths: ["/group.jpg"] } } }),
    "{torn final append",
  ].join("\n"));
  const current = replayPeopleJournal(state, journalPath);
  assert.equal(current.replayedEntries, 2);
  assert.equal(current.stateJournalVersion, 3);
  assert.deepEqual(current.people.map((person) => person.id).sort(), ["alice", "bob"]);
  assert.equal(current.people[0].confirmedPhotoPaths.includes("/group.jpg"), true);
  assert.equal(current.faceEdits.face1.box.x, 0.1);
  assert.equal(state.people[0].confirmedPhotoPaths.includes("/group.jpg"), false,
    "read-only journal replay must not mutate the supplied snapshot");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Silicon recovery readiness unit checks passed (12 checks)");
