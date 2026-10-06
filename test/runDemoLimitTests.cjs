const assert = require("assert");
const demoLimitsModule =
  process.env.DEMO_LIMITS_MODULE || "../electron-dist/demoLimits.js";
const {
  DEMO_LIMITS,
  applyDemoSourceLimit,
  formatDemoFileSample,
  getDemoDestinationKey,
  hasFullAccess,
  isDemoLimitReached,
  selectDemoDeletionBatch,
  selectDemoFilePaths,
  selectDemoMapPhotos,
  selectDemoPeople,
} = require(demoLimitsModule);

assert.deepStrictEqual(DEMO_LIMITS, {
  sources: 2,
  files: 1000,
  digitalFolders: 5,
  memoryPreviews: 5,
  people: 3,
  mapDestinations: 100,
  mapPhotos: 1000,
  duplicateDeletes: 100,
});
assert.strictEqual("searches" in DEMO_LIMITS, false);
assert.strictEqual(isDemoLimitReached(false, 4, 5), false);
assert.strictEqual(isDemoLimitReached(false, 5, 5), true);
assert.strictEqual(isDemoLimitReached(true, 50, 5), false);
assert.strictEqual(hasFullAccess(false, false), false);
assert.strictEqual(hasFullAccess(true, false), true);
assert.strictEqual(hasFullAccess(true, true), false);

const sourceRecords = [
  { id: "one", rootPath: "/one", enabled: true, available: true, message: "" },
  { id: "two", rootPath: "/two", enabled: true, available: true, message: "" },
  { id: "three", rootPath: "/three", enabled: true, available: true, message: "" },
];
const limitedSources = applyDemoSourceLimit(
  sourceRecords,
  false,
  DEMO_LIMITS.sources,
);
assert.deepStrictEqual(
  limitedSources.map((source) => source.enabled),
  [true, true, false],
);
assert.strictEqual(limitedSources[2].demoLocked, true);
assert.match(limitedSources[2].message, /not included/);
assert.strictEqual(
  applyDemoSourceLimit(sourceRecords, true, DEMO_LIMITS.sources)[2].enabled,
  true,
);

const records = [
  { path: "/b/2.jpg", sourcePath: "/b", type: "image" },
  { path: "/a/3.jpg", sourcePath: "/a", type: "image" },
  { path: "/a/1.jpg", sourcePath: "/a", type: "image" },
  { path: "/excluded/1.jpg", sourcePath: "/excluded", type: "image" },
];
assert.deepStrictEqual(
  [...selectDemoFilePaths(records, ["/a", "/b"], 2)].sort(),
  ["/a/1.jpg", "/a/3.jpg"],
);
assert.deepStrictEqual(
  [...selectDemoFilePaths(records, ["/a", "/b"], null)].sort(),
  ["/a/1.jpg", "/a/3.jpg", "/b/2.jpg"],
);

const weightedRecords = [
  ...Array.from({ length: 10000 }, (_, index) => ({
    path: `/photos/${String(index).padStart(5, "0")}.jpg`,
    sourcePath: "/mixed",
    type: "image",
  })),
  ...Array.from({ length: 200 }, (_, index) => ({
    path: `/docs/${String(index).padStart(4, "0")}.pdf`,
    sourcePath: "/mixed",
    type: "document",
  })),
];
const weightedSelection = selectDemoFilePaths(
  weightedRecords,
  ["/mixed"],
  DEMO_LIMITS.files,
  { image: 10000, document: 200 },
);
assert.strictEqual(weightedSelection.size, DEMO_LIMITS.files);
assert.strictEqual(
  [...weightedSelection].filter((filePath) => filePath.startsWith("/photos/")).length,
  980,
);
assert.strictEqual(
  [...weightedSelection].filter((filePath) => filePath.startsWith("/docs/")).length,
  20,
);
assert.strictEqual(
  formatDemoFileSample(
    { image: 980, document: 20 },
    { image: 10000, document: 200 },
  ),
  "Demo sample: 1,000 of 10,200 indexable files · sample mix 20 documents · 980 photos · source mix 200 documents · 10,000 photos.",
);

const sparseTypeRecords = [
  ...Array.from({ length: 10000 }, (_, index) => ({
    path: `/photos/${String(index).padStart(5, "0")}.jpg`,
    sourcePath: "/mixed",
    type: "image",
  })),
  { path: "/docs/only.pdf", sourcePath: "/mixed", type: "document" },
];
const sparseTypeSelection = selectDemoFilePaths(
  sparseTypeRecords,
  ["/mixed"],
  DEMO_LIMITS.files,
  { image: 10000, document: 1 },
);
assert.strictEqual(sparseTypeSelection.size, DEMO_LIMITS.files);
assert(sparseTypeSelection.has("/docs/only.pdf"));

const mapPhotos = [
  { path: "/map/b.jpg", locationLabel: "Piran", latitude: 45.5, longitude: 13.6 },
  { path: "/map/a.jpg", locationLabel: "Piran", latitude: 45.5, longitude: 13.6 },
  { path: "/map/c.jpg", locationLabel: "Sistiana", latitude: 45.7, longitude: 13.6 },
];
assert.strictEqual(getDemoDestinationKey(mapPhotos[0]), "piran");
assert.deepStrictEqual(
  selectDemoMapPhotos(mapPhotos, false, 2, 1).map((photo) => photo.path),
  ["/map/a.jpg", "/map/b.jpg"],
);
assert.strictEqual(selectDemoMapPhotos(mapPhotos, true, 2, 1).length, 3);
const manyMapDestinations = Array.from({ length: 101 }, (_, index) => ({
  path: `/destinations/${String(index).padStart(3, "0")}.jpg`,
  locationLabel: `Destination ${index}`,
  latitude: 45 + index / 100,
  longitude: 13 + index / 100,
}));
assert.strictEqual(
  selectDemoMapPhotos(manyMapDestinations, false, 1000, 100).length,
  100,
);
const manyMapPhotos = Array.from({ length: 1005 }, (_, index) => ({
  path: `/photos/${String(index).padStart(4, "0")}.jpg`,
  locationLabel: "One destination",
  latitude: 45,
  longitude: 13,
}));
assert.strictEqual(
  selectDemoMapPhotos(manyMapPhotos, false, 1000, 100).length,
  1000,
);
assert.deepStrictEqual(
  selectDemoPeople(["one", "two", "three", "four"], false, DEMO_LIMITS.people),
  ["one", "two", "three"],
);
assert.deepStrictEqual(
  selectDemoDeletionBatch([1, 2, 3], false, 99, DEMO_LIMITS.duplicateDeletes),
  [1],
);
assert.deepStrictEqual(
  selectDemoDeletionBatch([1, 2, 3], false, 100, DEMO_LIMITS.duplicateDeletes),
  [],
);
assert.deepStrictEqual(
  selectDemoDeletionBatch([1, 2, 3], true, 100, DEMO_LIMITS.duplicateDeletes),
  [1, 2, 3],
);

console.log("Demo limit tests passed.");
