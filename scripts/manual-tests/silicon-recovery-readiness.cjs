#!/usr/bin/env node
"use strict";

// Read-only real-library gate for the Silo 2.3.7 recovery candidate.
// It reads bounded People/face metadata and guides the remaining checks in Silo.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const repoRoot = path.resolve(__dirname, "../..");
const packageInfo = require(path.join(repoRoot, "package.json"));
const MAX_PEOPLE_JSON_BYTES = 128 * 1024 * 1024;
const MAX_STATE_JOURNAL_BYTES = 128 * 1024 * 1024;
const FACE_SAMPLE_BYTES = 256 * 1024;
const FACE_SAMPLE_LINES = 32;
const STARTUP_TARGET_MS = 30_000;
const CLICK_TARGET_MS = 250;
const SEARCH_TARGET_MS = 2_000;

function parseArgs(argv) {
  const options = { people: [] };
  const valueFor = (name, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--user-data") options.userData = valueFor(value, index++);
    else if (value === "--index-root") options.indexRoot = valueFor(value, index++);
    else if (value === "--people") {
      const first = valueFor(value, index);
      const second = valueFor(value, index + 1);
      if (first.startsWith("-") || second.startsWith("-"))
        throw new Error("--people requires exactly two quoted person names.");
      options.people = [first, second];
      index += 2;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  if (options.people.length === 2 && normalizedName(options.people[0]) === normalizedName(options.people[1]))
    throw new Error("--people requires two different person names.");
  return options;
}

function printHelp() {
  console.log(`Silo 2.3.7 Silicon recovery readiness check

Run from the recovery checkout on the Apple Silicon Mac:
  npm run dev                         # terminal 1; use this checkout's Silo
  npm run test:silicon-readiness      # terminal 2

Optional: select two existing People by their exact names:
  npm run test:silicon-readiness -- --people "Name One" "Name Two"

Overrides for non-default locations:
  --user-data <path>   Silo user-data directory
  --index-root <path>  selected index-storage root

The check reads the cache already configured on this Mac. It does not copy,
move, migrate, or write to the cache. The guided UI steps do require normal Silo
writes for a face-box move and face assignment; restore the moved box before
finishing. Never use an external drive for the source-toggle click check.`);
}

function readBoundedFile(filePath, maxBytes) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    if (size > maxBytes)
      throw new Error(`${path.basename(filePath)} is ${size} bytes; read limit is ${maxBytes}.`);
    const chunks = [];
    const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, maxBytes)));
    let position = 0;
    while (position < maxBytes) {
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, maxBytes - position),
        position,
      );
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      position += bytesRead;
    }
    if (position === maxBytes) {
      const probe = Buffer.alloc(1);
      if (fs.readSync(descriptor, probe, 0, 1, position) > 0)
        throw new Error(`${path.basename(filePath)} grew beyond the ${maxBytes}-byte read limit.`);
    }
    return Buffer.concat(chunks, position);
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeJson(filePath, maxBytes = Infinity) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error(`${path.basename(filePath)} is not a file.`);
  const contents = Number.isFinite(maxBytes)
    ? readBoundedFile(filePath, maxBytes)
    : fs.readFileSync(filePath);
  return JSON.parse(contents.toString("utf8"));
}

function readFaceSample(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(FACE_SAMPLE_BYTES);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop();
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line));
      if (records.length >= FACE_SAMPLE_LINES) break;
    }
    return records;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validBox(box) {
  if (!box || typeof box !== "object") return false;
  const values = [box.x, box.y, box.width, box.height];
  if (!values.every((value) => Number.isFinite(value))) return false;
  return box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 &&
    box.x + box.width <= 1.001 && box.y + box.height <= 1.001;
}

function normalizedName(name) {
  return String(name ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function userNamedPeople(people) {
  return people.filter((person) =>
    person && typeof person.id === "string" && typeof person.name === "string" &&
    person.status !== "banned" &&
    (person.nameSource === "user" ||
      (!person.nameSource && !/^Person \d+$/i.test(person.name))) &&
    Array.isArray(person.confirmedPhotoPaths) && person.confirmedPhotoPaths.length > 0,
  );
}

function findSharedPeoplePair(people, requestedNames = []) {
  const named = userNamedPeople(people);
  if (requestedNames.length === 2) {
    const findUnique = (name) => {
      const matches = named.filter((person) => normalizedName(person.name) === normalizedName(name));
      return matches.length === 1 ? matches[0] : null;
    };
    const first = findUnique(requestedNames[0]);
    const second = findUnique(requestedNames[1]);
    if (!first || !second || first.id === second.id) return null;
    const paths = new Set(first.confirmedPhotoPaths.filter((item) => typeof item === "string" && item));
    let shared = 0;
    for (const photoPath of new Set(second.confirmedPhotoPaths))
      if (paths.has(photoPath)) shared += 1;
    return { first, second, shared };
  }

  // One pass over confirmed memberships avoids comparing every pair of People.
  const firstOwnerByPath = new Map();
  for (const person of named) {
    for (const photoPath of new Set(person.confirmedPhotoPaths)) {
      if (typeof photoPath !== "string" || !photoPath) continue;
      const first = firstOwnerByPath.get(photoPath);
      if (first && first.id !== person.id) return { first, second: person, shared: 1 };
      if (!first) firstOwnerByPath.set(photoPath, person);
    }
  }
  return null;
}

function replayPeopleJournal(peopleState, journalPath) {
  const peopleById = new Map(
    (Array.isArray(peopleState.people) ? peopleState.people : []).map((person) => [person.id, { ...person }]),
  );
  const faceEdits = { ...(peopleState.faceEdits ?? {}) };
  const savedVersion = Number.isSafeInteger(peopleState.stateJournalVersion)
    ? peopleState.stateJournalVersion
    : 0;
  let latestSequence = savedVersion;
  let replayedEntries = 0;
  let bytes = 0;
  try {
    bytes = fs.statSync(journalPath).size;
  } catch (error) {
    if (error.code === "ENOENT")
      return { ...peopleState, people: Array.from(peopleById.values()), faceEdits, replayedEntries, journalBytes: 0 };
    throw error;
  }
  const text = readBoundedFile(journalPath, MAX_STATE_JOURNAL_BYTES).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Match the app's recovery behavior: ignore a torn append and continue.
      continue;
    }
    if (entry?.version !== 1 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1)
      continue;
    latestSequence = Math.max(latestSequence, entry.sequence);
    if (entry.sequence <= savedVersion) continue;
    for (const [personId, person] of Object.entries(entry.people ?? {})) {
      if (person === null) peopleById.delete(personId);
      else if (person && person.id === personId) peopleById.set(personId, person);
    }
    for (const [personId, patch] of Object.entries(entry.personPatches ?? {})) {
      const person = peopleById.get(personId);
      if (!person || !patch || typeof patch !== "object") continue;
      if (Array.isArray(patch.centroid)) person.centroid = patch.centroid;
      if (Array.isArray(patch.suggestedFaceIds)) person.suggestedFaceIds = patch.suggestedFaceIds;
      if (typeof patch.recognitionPending === "boolean") person.recognitionPending = patch.recognitionPending;
      if (typeof patch.recognitionFailed === "boolean") person.recognitionFailed = patch.recognitionFailed;
    }
    for (const [faceId, edit] of Object.entries(entry.faceEdits ?? {})) {
      if (edit === null) delete faceEdits[faceId];
      else if (edit && typeof edit === "object") faceEdits[faceId] = edit;
    }
    for (const [personId, flags] of Object.entries(entry.personFlags ?? {})) {
      const person = peopleById.get(personId);
      if (!person || !flags || typeof flags !== "object") continue;
      if (typeof flags.recognitionPending === "boolean") person.recognitionPending = flags.recognitionPending;
      if (typeof flags.recognitionFailed === "boolean") person.recognitionFailed = flags.recognitionFailed;
    }
    replayedEntries += 1;
  }
  return {
    ...peopleState,
    people: Array.from(peopleById.values()),
    faceEdits,
    stateJournalVersion: latestSequence,
    replayedEntries,
    journalBytes: bytes,
  };
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function askYesNo(rl, prompt) {
  while (true) {
    const answer = (await rl.question(`${prompt} [y/n]: `)).trim().toLowerCase();
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    console.log("Please enter y or n.");
  }
}

async function askMilliseconds(rl, label, targetMs) {
  while (true) {
    const answer = (await rl.question(`${label} (ms, target ≤ ${targetMs.toLocaleString()}): `)).trim();
    if (!answer) return false;
    const milliseconds = Number(answer);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      const passed = milliseconds <= targetMs;
      console.log(`${passed ? "PASS" : "FAIL"}: ${milliseconds.toLocaleString()} ms.`);
      return passed;
    }
    console.log("Enter a non-negative number of milliseconds; blank records a failure.");
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.error(`HOLD: run under native Apple Silicon Node on macOS (found ${process.platform}/${process.arch}).`);
    return 2;
  }

  const userData = path.resolve(
    options.userData || process.env.FILE_BROWSER_USER_DATA_DIR ||
      path.join(os.homedir(), "Library", "Application Support", "file-browser-electron"),
  );
  let settings = { path: userData };
  const settingsPath = path.join(userData, "index-storage.json");
  if (fs.existsSync(settingsPath)) {
    try {
      settings = safeJson(settingsPath, 1024 * 1024);
      if (settings.format !== "silo-index-storage" || settings.version !== 1 ||
          typeof settings.path !== "string" || !path.isAbsolute(settings.path))
        throw new Error("The saved index storage setting is invalid.");
    } catch (error) {
      console.error(`HOLD: could not read the saved cache location: ${error.message}`);
      return 2;
    }
  }
  if (settings.pendingPath) {
    console.error("HOLD: a cache destination change is still pending. Let Silo finish or recover it, then rerun this check.");
    return 2;
  }

  const indexRoot = path.resolve(
    options.indexRoot || process.env.SILO_INDEX_STORAGE_ROOT || settings.path,
  );
  const faceRoot = path.join(indexRoot, "face-index");
  const peoplePath = path.join(faceRoot, "people.json");
  const journalPath = path.join(faceRoot, "people-edits.jsonl");
  const faceRecordsPath = path.join(faceRoot, "faces.jsonl");
  const faceProgressPath = path.join(faceRoot, "progress.json");
  const semanticRecordsPath = path.join(indexRoot, "semantic-index", "records.jsonl");
  const semanticVectorsPath = path.join(indexRoot, "semantic-index", "vectors.bin");
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    console.log(`${passed ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  };

  console.log("\nSilo 2.3.7 Silicon recovery readiness");
  console.log(`Checkout: ${gitValue(["branch", "--show-current"])} @ ${gitValue(["rev-parse", "--short", "HEAD"])}`);
  console.log(`Checkout package version: ${packageInfo.version} (target 2.3.7)`);
  check("Native Apple Silicon runtime", true, `macOS arm64 / Node ${process.version}`);

  try {
    const rootStats = fs.statSync(indexRoot);
    check("Selected cache root", rootStats.isDirectory(), "configured cache root is present");
  } catch (error) {
    check("Selected cache root", false, `${error.code || "unavailable"}; reconnect it or pass --index-root`);
    console.error("\nHOLD: the Silicon Mac's selected cache is not accessible. No cache copy is needed.");
    return 2;
  }

  let peopleState;
  try {
    peopleState = safeJson(peoplePath, MAX_PEOPLE_JSON_BYTES);
    if (!Array.isArray(peopleState.people)) throw new Error("People index has no people array.");
    peopleState = replayPeopleJournal(peopleState, journalPath);
    check("People index", true,
      `${peopleState.people.length.toLocaleString()} clusters loaded read-only${peopleState.replayedEntries ? `; replayed ${peopleState.replayedEntries} recent edits` : ""}`);
  } catch (error) {
    check("People index", false, error.code || error.message);
    console.error("\nHOLD: could not inspect the current People index and its edit journal.");
    return 2;
  }

  try {
    const progress = safeJson(faceProgressPath, 1024 * 1024);
    const finished = progress.status === "complete" ||
      (progress.status === "idle" && Number(progress.total) === 0);
    check("Face scan finished", finished,
      `${progress.status || "unknown"}; ${Number(progress.processed || 0).toLocaleString()} processed, ${Number(progress.remaining || 0).toLocaleString()} remaining`);
  } catch (error) {
    check("Face scan state", false, error.code || error.message);
  }

  try {
    const stats = fs.statSync(faceRecordsPath);
    const faceSample = readFaceSample(faceRecordsPath);
    const boxesValid = faceSample.length > 0 && faceSample.every((face) =>
      typeof face.imagePath === "string" && validBox(face.box));
    check("Face records", stats.size > 0 && boxesValid,
      `${faceSample.length} bounded sample records checked; ${Math.round(stats.size / 1024 / 1024)} MiB file, no full scan`);
  } catch (error) {
    check("Face records", false, error.code || error.message);
  }

  let semanticBytes = 0;
  for (const filePath of [semanticRecordsPath, semanticVectorsPath]) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile()) semanticBytes += stats.size;
    } catch {
      // One Search component can be absent while another still contains usable records.
    }
  }
  check("Search index", semanticBytes > 0,
    semanticBytes ? `${(semanticBytes / 1024 / 1024).toFixed(1)} MiB of persisted Search data` : "no persisted Search records or vectors found");

  const named = userNamedPeople(peopleState.people);
  const targetPair = findSharedPeoplePair(peopleState.people, options.people);
  check("Confirmed named People", named.length >= 2,
    `${named.length.toLocaleString()} eligible named clusters`);
  check("Existing shared group photos", Boolean(targetPair && targetPair.shared > 0),
    targetPair && targetPair.shared > 0
      ? `${targetPair.shared.toLocaleString()} confirmed photo paths shared by ${targetPair.first.name} + ${targetPair.second.name}`
      : options.people.length
        ? "the supplied pair has no shared confirmed photo path"
        : "no pair has a shared confirmed photo; confirm a real group photo, then rerun");

  const edits = Object.values(peopleState.faceEdits ?? {}).filter((edit) => edit && !edit.deleted && edit.box);
  const validEdits = edits.filter((edit) => validBox(edit.box)).length;
  check("Persisted face-box edits", validEdits === edits.length,
    `${validEdits.toLocaleString()} current overrides with valid normalized boxes; the live reopen check still applies`);

  const pendingRecognition = peopleState.people.filter((person) =>
    person.status === "confirmed" && person.trainedAt && person.recognitionPending).length;
  const failedRecognition = peopleState.people.filter((person) =>
    person.status === "confirmed" && person.trainedAt && person.recognitionFailed).length;
  check("Recognition producer drained", pendingRecognition === 0,
    `${pendingRecognition.toLocaleString()} confirmed People still pending`);
  check("Recognition errors", failedRecognition === 0,
    `${failedRecognition.toLocaleString()} confirmed People report a failed refresh`);

  try {
    const stats = fs.statfsSync(indexRoot);
    const freeGiB = (stats.bavail * stats.bsize) / 1024 ** 3;
    console.log(`INFO  Cache volume free space: ${freeGiB.toFixed(1)} GiB`);
  } catch {
    console.log("INFO  Cache volume free space: unavailable from this filesystem");
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    console.log("\nHOLD: real-data UI checks need an interactive Terminal session.");
    return 2;
  }
  if (targetPair?.shared) {
    console.log(`\nUse this real-data pair in Silo: ${targetPair.first.name} + ${targetPair.second.name} (${targetPair.shared} shared confirmed photo paths).`);
  } else {
    console.log("\nNo named group pair is ready. Confirm a real group photo for two named People, then rerun this gate.");
  }
  console.log(`Launch the recovery checkout before answering. Measure app launch to usable controls, then open a visible photo grid. With the face editor open, navigate to the next photo and back; each image must show only its own correctly numbered boxes. For the face-box persistence check, move a box slightly, close and reopen the photo, verify the move persisted, then move it back and verify the restored position also persisted. Use an internal source for the toggle check and return it to its original state. The cache stays on this Mac; the script itself does not write to it.\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const liveChecks = [];
    liveChecks.push(await askMilliseconds(rl,
      "Recovery Silo launch to first usable controls", STARTUP_TARGET_MS));
    liveChecks.push(await askYesNo(rl,
      "A visible photo grid produced a real thumbnail, and opening the photo showed its full preview."));
    liveChecks.push(await askYesNo(rl,
      "Navigating between photos with the face editor open showed each image's own numbered face boxes, without stale boxes from the previous image."));
    liveChecks.push(await askYesNo(rl,
      `A Memories search for ${targetPair?.first.name ?? "the first named person"} and ${targetPair?.second.name ?? "the second named person"} showed a real shared group photo.`));
    liveChecks.push(await askYesNo(rl,
      "Numbered face boxes matched the corresponding face rows and person selectors."));
    liveChecks.push(await askYesNo(rl,
      "A face-box move survived close/reopen, and the restored original position also survived close/reopen."));
    liveChecks.push(await askYesNo(rl,
      "Assigning both correct people on a real group photo added membership to each cluster without removing prior membership."));
    liveChecks.push(await askMilliseconds(rl,
      "Slowest of three source/filter clicks to visible response", CLICK_TARGET_MS));
    liveChecks.push(await askYesNo(rl,
      "A safe internal source toggle and file-type filter responded, the final choice survived refresh, and the original source state was restored."));
    liveChecks.push(await askMilliseconds(rl,
      "Warm-cache multi-person Search submit to first visible matching result", SEARCH_TARGET_MS));

    const structuralPass = checks.every((item) => item.passed);
    const livePass = liveChecks.every(Boolean);
    console.log(`\n${structuralPass && livePass ? "READY TO CONSIDER PACKAGING" : "KEEP WORKING"} — ${checks.filter((item) => item.passed).length}/${checks.length} cache checks and ${liveChecks.filter(Boolean).length}/${liveChecks.length} live checks passed.`);
    if (!structuralPass) console.log(`Cache checks to resolve: ${checks.filter((item) => !item.passed).map((item) => item.name).join(", ")}`);
    return structuralPass && livePass ? 0 : 2;
  } finally {
    rl.close();
  }
}

module.exports = {
  findSharedPeoplePair,
  normalizedName,
  parseArgs,
  replayPeopleJournal,
  userNamedPeople,
  validBox,
};

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`\nHOLD: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
