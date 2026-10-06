/* Pure story-mining tests for src/memoryDiscovery.ts. No Electron, models or files. */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const source = require("node:fs").readFileSync(path.join(__dirname, "../src/memoryDiscovery.ts"), "utf8");
const mod = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(require, mod, mod.exports);
const { discoverMemoryStories, meaningfulFolderName, MEMORY_CONCEPTS } = mod.exports;

const NOW = new Date(2025, 5, 15, 12).getTime(); // 15 June 2025
const day = 24 * 60 * 60 * 1000;
let counter = 0;
function shots(folder, count, start, spacing = 2 * 60 * 60 * 1000) {
  // Spaced apart so copy-burst filtering does not apply.
  return Array.from({ length: count }, (_, i) => ({ path: `/lib/${folder}/IMG_${counter++}.jpg`, modified: start + i * spacing }));
}
const seeded = () => { let x = 42; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

test("single small source still yields stories; titles cover time, places, people, subjects and folders", () => {
  const thisWeek2015 = shots("Croatia 2015", 6, new Date(2015, 5, 14, 9).getTime());
  const lastSummer = shots("DCIM", 12, new Date(2024, 6, 3, 9).getTime(), 9 * 60 * 60 * 1000);
  const georgia = shots("Road", 8, new Date(2019, 2, 1).getTime(), 3 * day);
  const sailing = shots("Misc", 10, new Date(2018, 7, 1).getTime(), 120 * day);
  const images = [...thisWeek2015, ...lastSummer, ...georgia, ...sailing];
  const ideas = discoverMemoryStories({
    images, now: NOW, random: seeded(),
    places: [
      ...thisWeek2015.map(({ path }) => ({ path, city: "Split", region: "Dalmatia", country: "Croatia" })),
      ...georgia.map(({ path }) => ({ path, city: null, region: "Georgia", country: "United States" })),
    ],
    people: [{ name: "Ana", paths: [...thisWeek2015, ...sailing].map((image) => image.path) },
      { name: "Person 4", paths: georgia.map((image) => image.path) }],
    concepts: [{ id: "sailing", paths: sailing.map((image) => image.path), count: 10 },
      { id: "seaside", paths: thisWeek2015.map((image) => image.path), count: 6 }],
  });
  const titles = ideas.map((idea) => idea.title);
  assert.ok(titles.includes("This Week, Ten Years Ago"), titles.join(" | "));
  assert.ok(titles.includes("Last Summer"));
  assert.ok(titles.includes("Croatian Seaside"));
  assert.ok(titles.some((title) => /Georgia/.test(title)), "region-level place story");
  assert.ok(titles.includes("Under Sail"));
  assert.ok(titles.includes("Sailing Over the Years"));
  assert.ok(titles.some((title) => /Ana/.test(title)));
  assert.ok(!titles.some((title) => /Person 4/.test(title)), "unnamed clusters are not stories");
  assert.ok(titles.includes("Croatia 2015"), "user-named folder");
  assert.ok(!titles.includes("Dcim") && !titles.includes("DCIM"));
  assert.ok(ideas.every((idea) => idea.paths.length >= 4 && idea.paths.length <= 160));
  assert.equal(new Set(ideas.map((idea) => idea.key)).size, ideas.length);
  // Variety: the first few ideas span several kinds.
  assert.ok(new Set(ideas.slice(0, 5).map((idea) => idea.kind)).size >= 4);
});

test("copy bursts do not create fake time stories; tiny libraries return nothing", () => {
  const burst = Array.from({ length: 300 }, (_, i) => ({ path: `/copy/x${i}.jpg`, modified: NOW - 365 * day + i }));
  const ideas = discoverMemoryStories({ images: burst, now: NOW, random: seeded() });
  assert.ok(!ideas.some((idea) => ["on-this-day", "season", "year", "event"].includes(idea.kind)));
  assert.deepEqual(discoverMemoryStories({ images: shots("Trip", 3, NOW - 400 * day), now: NOW }), []);
});

test("subjects that dominate the library (family members and sailing) lead the order", () => {
  const family = shots("DCIM", 300, new Date(2016, 0, 1).getTime(), 5 * day);
  const minor = shots("Other", 8, new Date(2020, 3, 1).getTime(), 30 * day);
  const images = [...family, ...minor];
  let leadingHits = 0;
  for (let run = 0; run < 20; run++) {
    let x = run + 7;
    const random = () => ((x = (x * 16807) % 2147483647) / 2147483647);
    const ideas = discoverMemoryStories({ images, now: NOW, random,
      people: [{ name: "Mila", paths: family.slice(0, 250).map((image) => image.path) },
        { name: "Robin", paths: family.slice(100).map((image) => image.path) },
        { name: "Ivo", paths: minor.map((image) => image.path) }],
      concepts: [{ id: "sailing", paths: family.slice(0, 120).map((image) => image.path), count: 900 },
        { id: "fossils", paths: minor.map((image) => image.path), count: 8 }] });
    const firstSix = ideas.slice(0, 6).map((idea) => idea.title).join(" | ");
    if (/Mila|Robin/.test(firstSix) && /Sail/.test(firstSix)) leadingHits += 1;
  }
  assert.ok(leadingHits >= 16, `prevalent people and subjects led in ${leadingHits}/20 runs`);
});

test("folder names and concept vocabulary", () => {
  for (const generic of ["DCIM", "100APPLE", "Camera Roll", "2019-07-01", "IMG_2041", "a1b2c3d4e5f6a7b8c9d0", "Phone Backups"])
    assert.equal(meaningfulFolderName(generic), null, generic);
  assert.equal(meaningfulFolderName("sailing_with_dad"), "Sailing With Dad");
  assert.equal(meaningfulFolderName("Trieste Weekend"), "Trieste Weekend");
  for (const id of ["sailing", "rockhounding", "paragliding"])
    assert.ok(MEMORY_CONCEPTS.some((concept) => concept.id === id));
});
