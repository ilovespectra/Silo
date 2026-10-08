"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  COCO_ANNOTATION_LICENSE_SOURCE_URL,
  COCO_ANNOTATION_LICENSE_URL,
  chooseFullPageDefault,
  createSearchEvalIndexKey,
  evaluateSliderPositions,
  matchesGroundTruth,
  measureQuery,
} = require("../scripts/search-eval-core.cjs");
const { confidenceSettingToMinimumThreshold } = require("../electron-dist/semanticIndexer.js");
const { DEFAULT_SEMANTIC_SEARCH_CONFIDENCE } = require("../electron-dist/searchSettings.js");

test("measured default and slider mapping use the score floor directly", () => {
  assert.equal(DEFAULT_SEMANTIC_SEARCH_CONFIDENCE, 23);
  assert.equal(confidenceSettingToMinimumThreshold(0), 0);
  assert.equal(confidenceSettingToMinimumThreshold(25), 25);
  assert.equal(confidenceSettingToMinimumThreshold(100), 100);
  assert.equal(
    confidenceSettingToMinimumThreshold(Number.NaN),
    DEFAULT_SEMANTIC_SEARCH_CONFIDENCE,
  );
});

test("search-eval index identity changes with image, model, or embedding code fingerprints", () => {
  const base = {
    imageFiles: ["0001.jpg", "0002.jpg"],
    imageFingerprint: "image-hash-a",
    modelFingerprint: "model-hash-a",
    pipelineFingerprint: "pipeline-hash-a",
  };
  const original = createSearchEvalIndexKey(base);

  assert.equal(createSearchEvalIndexKey(base), original);
  assert.notEqual(
    createSearchEvalIndexKey({ ...base, imageFingerprint: "image-hash-b" }),
    original,
  );
  assert.notEqual(
    createSearchEvalIndexKey({ ...base, modelFingerprint: "model-hash-b" }),
    original,
  );
  assert.notEqual(
    createSearchEvalIndexKey({ ...base, pipelineFingerprint: "pipeline-hash-b" }),
    original,
  );
  assert.notEqual(
    createSearchEvalIndexKey({ ...base, imageFiles: ["0001.jpg", "0003.jpg"] }),
    original,
  );
});

test("COCO annotation attribution uses its terms-of-use license, separate from photo licenses", () => {
  assert.equal(COCO_ANNOTATION_LICENSE_URL, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(COCO_ANNOTATION_LICENSE_SOURCE_URL, "https://cocodataset.org/#termsofuse");
});

test("COCO ground truth requires every category and caption group", () => {
  const query = {
    categories_all: ["dog"],
    categories_any: ["beach", "shore"],
    category_min_counts: { dog: 1 },
    caption_groups: [["beach", "sand"], ["water", "ocean"]],
  };
  const image = {
    categoryNames: new Set(["dog", "shore"]),
    categoryCounts: new Map([["dog", 1]]),
    captions: ["A dog runs on wet sand near the ocean."],
  };
  assert.equal(matchesGroundTruth(query, image), true);
  assert.equal(
    matchesGroundTruth(query, { ...image, captions: ["A dog sits indoors."] }),
    false,
  );
  assert.equal(
    matchesGroundTruth(query, { ...image, categoryNames: new Set(["cat", "shore"]) }),
    false,
  );
});

test("precision@10, recall, and empty results use the same thresholded ranking", () => {
  const results = [
    { path: "a", confidence: 80 },
    { path: "b", confidence: 70 },
    { path: "c", confidence: 40 },
  ];
  const relevant = ["a", "c"];
  const open = measureQuery(results, relevant, 0);
  assert.equal(open.precisionAtK, 0.2);
  assert.equal(open.recall, 1);
  assert.equal(open.zeroResults, false);

  const strict = measureQuery(results, relevant, 50);
  assert.equal(strict.precisionAtK, 0.1);
  assert.equal(strict.recall, 0.5);
  assert.equal(strict.zeroResults, false);

  const empty = measureQuery(results, relevant, 90);
  assert.equal(empty.precisionAtK, 0);
  assert.equal(empty.recall, 0);
  assert.equal(empty.zeroResults, true);
});

test("default selection picks the strictest score floor with a full page", () => {
  const metrics = evaluateSliderPositions(
    [
      {
        query: "one",
        relevantPaths: ["p0"],
        results: Array.from({ length: 12 }, (_, i) => ({
          path: `p${i}`,
          confidence: 100 - i * 5,
        })),
      },
    ],
    (setting) => setting,
  );
  const picked = chooseFullPageDefault(metrics, 10);
  assert.equal(picked.threshold, 55);
  assert.equal(picked.minimumResultCount, 10);
  assert.equal(picked.zeroResultRate, 0);
});
