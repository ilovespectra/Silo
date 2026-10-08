"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const {
  COCO_ANNOTATION_LICENSE_SOURCE_URL,
  COCO_ANNOTATION_LICENSE_URL,
  chooseFullPageDefault,
  createSearchEvalIndexKey,
  evaluateSliderPositions,
  matchesGroundTruth,
} = require("./search-eval-core.cjs");
const {
  SemanticIndexer,
  confidenceSettingToMinimumThreshold,
} = require("../electron-dist/semanticIndexer.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = path.resolve(
  process.env.SEARCH_EVAL_DATA_DIR || path.join(REPO_ROOT, "work/search-eval"),
);
const IMAGE_ROOT = path.join(DATA_ROOT, "images");
const ANNOTATION_ROOT = path.join(DATA_ROOT, "annotations");
const QUERY_PATH = path.join(REPO_ROOT, "test/fixtures/search-eval-queries.json");
const IMAGE_COUNT = 500;
const MIN_LABELS_PER_QUERY = 8;
const IMAGE_DOWNLOAD_CONCURRENCY = 8;
const MIRROR_ROOT = "https://huggingface.co/datasets/merve/coco/resolve/main";
const LICENSED_IMAGE_LICENSE_ID = 4;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    let value = (state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

async function readJSON(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function fingerprintDirectory(rootPath) {
  const hash = crypto.createHash("sha256");
  async function visit(directory, relative = "") {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      const childRelative = path.join(relative, entry.name).split(path.sep).join("/");
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${childRelative}\n`);
        await visit(childPath, childRelative);
      } else if (entry.isFile()) {
        const stats = await fs.stat(childPath);
        hash.update(`file\0${childRelative}\0${stats.size}\0${await hashFile(childPath)}\n`);
      } else {
        throw new Error(`Unsupported model-cache entry: ${childPath}`);
      }
    }
  }
  await visit(rootPath);
  return hash.digest("hex");
}

async function fingerprintFiles(filePaths, relativeRoot) {
  const records = [];
  for (const filePath of [...filePaths].sort()) {
    const stats = await fs.stat(filePath);
    records.push({
      path: path.relative(relativeRoot, filePath).split(path.sep).join("/"),
      size: stats.size,
      sha256: await hashFile(filePath),
    });
  }
  return crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function downloadFile(url, filePath, validate, label) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const existing = await fs.readFile(filePath);
    if (validate(existing)) return false;
  } catch {
    // A missing or incomplete fixture is downloaded below.
  }

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const contents = Buffer.from(await response.arrayBuffer());
      if (!validate(contents)) throw new Error(`${label} failed validation`);
      const temporaryPath = `${filePath}.partial`;
      await fs.writeFile(temporaryPath, contents);
      await fs.rename(temporaryPath, filePath);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`Could not download ${label}: ${lastError?.message ?? "unknown error"}`);
}

async function loadAnnotation(fileName) {
  const filePath = path.join(ANNOTATION_ROOT, fileName);
  const url = `${MIRROR_ROOT}/annotations/${fileName}`;
  await downloadFile(
    url,
    filePath,
    (contents) => contents.length > 1000 && contents[0] === 123,
    fileName,
  );
  return readJSON(filePath);
}

function buildImageLabels(instances, captions) {
  const imageById = new Map(instances.images.map((image) => [image.id, image]));
  const categoryNameById = new Map(
    instances.categories.map((category) => [category.id, category.name]),
  );
  const labelsByImage = new Map(
    instances.images.map((image) => [
      image.id,
      { categoryNames: new Set(), categoryCounts: new Map(), captions: [] },
    ]),
  );

  for (const annotation of instances.annotations) {
    if (!labelsByImage.has(annotation.image_id)) continue;
    const categoryName = categoryNameById.get(annotation.category_id);
    if (!categoryName) continue;
    const labels = labelsByImage.get(annotation.image_id);
    labels.categoryNames.add(categoryName);
    labels.categoryCounts.set(
      categoryName,
      (labels.categoryCounts.get(categoryName) ?? 0) + 1,
    );
  }
  for (const annotation of captions.annotations) {
    labelsByImage.get(annotation.image_id)?.captions.push(annotation.caption);
  }

  return { imageById, labelsByImage };
}

function selectFixture(images, queries, labelsByImage) {
  const random = seededRandom(20261007);
  const candidates = shuffle(
    images
      .filter((image) => image.license === LICENSED_IMAGE_LICENSE_ID)
      .slice()
      .sort((first, second) => first.id - second.id),
    random,
  );
  if (candidates.length < IMAGE_COUNT)
    throw new Error(
      `Only ${candidates.length} COCO validation photos use image license ${LICENSED_IMAGE_LICENSE_ID}; need ${IMAGE_COUNT}.`,
    );

  const positives = queries.map((query) => {
    const ids = new Set();
    for (const image of candidates) {
      const labels = labelsByImage.get(image.id);
      if (labels?.captions.length && matchesGroundTruth(query, labels)) ids.add(image.id);
    }
    return ids;
  });
  const targets = positives.map((ids) => Math.min(MIN_LABELS_PER_QUERY, ids.size));
  const selected = new Set();
  const covered = queries.map(() => 0);
  const candidateById = new Map(candidates.map((image) => [image.id, image]));

  while (covered.some((count, index) => count < targets[index])) {
    let bestImage = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      if (selected.has(candidate.id)) continue;
      let score = 0;
      for (let queryIndex = 0; queryIndex < positives.length; queryIndex += 1) {
        if (
          covered[queryIndex] < targets[queryIndex] &&
          positives[queryIndex].has(candidate.id)
        )
          score += 1;
      }
      if (score > bestScore) {
        bestImage = candidate;
        bestScore = score;
      }
    }
    if (!bestImage) break;
    selected.add(bestImage.id);
    for (let queryIndex = 0; queryIndex < positives.length; queryIndex += 1) {
      if (
        covered[queryIndex] < targets[queryIndex] &&
        positives[queryIndex].has(bestImage.id)
      )
        covered[queryIndex] += 1;
    }
  }

  for (const candidate of candidates) {
    if (selected.size >= IMAGE_COUNT) break;
    selected.add(candidate.id);
  }

  const selectedImages = [...selected]
    .map((id) => candidateById.get(id))
    .filter(Boolean)
    .sort((first, second) => first.id - second.id);
  if (selectedImages.length !== IMAGE_COUNT)
    throw new Error(`Fixture selector produced ${selectedImages.length} images, expected ${IMAGE_COUNT}.`);
  return { selectedImages, positives, targets };
}

function isJPEG(contents) {
  return contents.length >= 10_000 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff;
}

async function downloadImages(images) {
  await fs.mkdir(IMAGE_ROOT, { recursive: true });
  const expectedNames = new Set(images.map((image) => image.file_name));
  for (const name of await fs.readdir(IMAGE_ROOT)) {
    if (/^\d{12}\.jpg$/i.test(name) && !expectedNames.has(name))
      await fs.unlink(path.join(IMAGE_ROOT, name));
  }

  let cursor = 0;
  let downloaded = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= images.length) return;
      const image = images[index];
      const filePath = path.join(IMAGE_ROOT, image.file_name);
      const url = `${MIRROR_ROOT}/val2017/${image.file_name}`;
      if (
        await downloadFile(url, filePath, isJPEG, `COCO image ${image.file_name}`)
      ) {
        downloaded += 1;
        if (downloaded % 50 === 0 || downloaded === images.length)
          console.log(`Downloaded ${downloaded} of ${images.length} COCO images.`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: IMAGE_DOWNLOAD_CONCURRENCY }, () => worker()),
  );
}

async function scanImages(sourcePath, onFile, isCancelled) {
  for (const entry of await fs.readdir(sourcePath, { withFileTypes: true })) {
    if (isCancelled()) return;
    if (!entry.isFile() || !/\.jpe?g$/i.test(entry.name)) continue;
    const filePath = path.join(sourcePath, entry.name);
    const stat = await fs.stat(filePath);
    onFile({
      name: entry.name,
      path: filePath,
      relativePath: entry.name,
      size: stat.size,
      modified: stat.mtimeMs,
      isDirectory: false,
      type: "image",
      extension: path.extname(entry.name).toLowerCase(),
    });
  }
}

function findLine(filePath, pattern) {
  const source = require("node:fs").readFileSync(filePath, "utf8").split(/\r?\n/);
  const index = source.findIndex((line) => pattern.test(line));
  return index < 0 ? "line not found" : String(index + 1);
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function score(value) {
  return Number(value).toFixed(2);
}

function describeResult(result, imageByFileName, labelsByImage) {
  const fileName = path.basename(result.path);
  const image = imageByFileName.get(fileName);
  const labels = image ? labelsByImage.get(image.id) : null;
  const caption = labels?.captions[0]?.replace(/\s+/g, " ").trim() ?? "No COCO caption";
  const shortCaption = caption.length > 150 ? `${caption.slice(0, 147)}...` : caption;
  const categoryList = [...(labels?.categoryNames ?? [])].slice(0, 6).join(", ");
  return `\`${fileName}\` (${score(result.confidence)}; ${categoryList || "no category labels"}) — “${shortCaption}”`;
}

function buildReport({
  indexSummary,
  selectedImages,
  eligibleCount,
  photoLicenseUrl,
  annotationLicenseUrl,
  annotationLicenseSourceUrl,
  indexDigest,
  currentMetrics,
  fixedMetrics,
  recommended,
  queryRuns,
  imagesByFileName,
  labelsByImage,
  indexMilliseconds,
  searchMilliseconds,
}) {
  const currentDefault = currentMetrics[25];
  const fixedDefault = fixedMetrics[recommended.setting];
  const worst = recommended.perQuery
    .slice()
    .sort(
      (first, second) =>
        first.precisionAtK - second.precisionAtK ||
        first.recall - second.recall ||
        first.query.localeCompare(second.query),
    )
    .slice(0, 5);
  const runByQuery = new Map(queryRuns.map((run) => [run.query, run]));
  const lines = [
    "# Silo Search Evaluation",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Corpus and method",
    "",
    `- Indexed **${indexSummary.indexed}** of ${IMAGE_COUNT} downloaded COCO 2017 validation photos; indexing errors: **${indexSummary.errors}**.`,
    `- ${eligibleCount} of 5,000 validation photos carry image license id 4; this fixture uses a deterministic query-balanced sample of ${selectedImages.length}.`,
    `- Selected-photo license from COCO image metadata: [${photoLicenseUrl}](${photoLicenseUrl}). COCO annotation/caption license: [CC BY 4.0](${annotationLicenseUrl}), as stated in the [COCO terms of use](${annotationLicenseSourceUrl}).`,
    `- Dataset mirror used for the public COCO files: [merve/coco on Hugging Face](https://huggingface.co/datasets/merve/coco). Images and annotations stay under \`work/search-eval/\` and are not committed.`,
    `- Search runtime: Silo's \`SemanticIndexer\` with the offline \`Xenova/clip-vit-base-patch32\` model; temporary index: \`work/search-eval/index-${indexDigest.slice(0, 12)}\`, keyed by selected-image content, model-cache contents, and embedding-pipeline code.`,
    `- Indexing time: ${(indexMilliseconds / 1000).toFixed(1)} s; 50 text searches: ${(searchMilliseconds / 1000).toFixed(1)} s.`,
    "- Ground truth is derived from COCO instance categories and caption text using the query rules in `test/fixtures/search-eval-queries.json`; it is annotation based, not a manual visual relabeling.",
    "- Precision@10 uses a fixed denominator of 10; recall is relevant retrieved images divided by all labeled matches in the 500-photo fixture. Zero-result rate is the fraction of the 50 queries returning no image.",
    "",
    "## Slider direction and default",
    "",
    `- Before the fix, \`confidenceSettingToMinimumThreshold\` mapped slider value \`s\` to \`100 − s\`; the app then kept results with score ≥ that threshold. The search score is normalized embedding dot product × 100. Thus a lower slider value imposed the stricter cutoff, and the UI default 25 imposed a 75-point cutoff.`,
    `- Current code before this change at default 25: cutoff **${currentDefault.threshold}**, P@10 **${percent(currentDefault.precisionAtK)}**, recall **${percent(currentDefault.recall)}**, zero-result rate **${percent(currentDefault.zeroResultRate)}**.`,
    `- Fixed direction: slider value now maps directly to the minimum score; higher means stricter. Recommended default: **${recommended.setting}** (score cutoff ${recommended.threshold}). This is the strictest tested setting that still returns at least 10 images for every query.`,
    `- At that default: P@10 **${percent(fixedDefault.precisionAtK)}**, recall **${percent(fixedDefault.recall)}**, zero-result rate **${percent(fixedDefault.zeroResultRate)}**, mean results **${fixedDefault.meanResultCount.toFixed(1)}**.`,
    "- Diagnosis: at score floor 0, all 50 searches returned all 500 indexed photos; no embedding or normalization mismatch surfaced. The old default floor 75 returned nothing for all 50 queries. With the corrected scale, floor 26 already empties one query and floor 30 empties 68%, so the empty pages are threshold-driven on this corpus.",
    "- Full slider sweep evaluates integer positions 0–100. The `old-*` columns show the previous reversed mapping; the `fixed-*` columns show the corrected direct mapping.",
    "",
    "## Every slider position",
    "",
    "| Setting | Old cutoff | Old P@10 | Old recall | Old zero | Fixed cutoff | Fixed P@10 | Fixed recall | Fixed zero | Fixed min results |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (let setting = 0; setting <= 100; setting += 1) {
    const oldMetrics = currentMetrics[setting];
    const fixed = fixedMetrics[setting];
    lines.push(
      `| ${setting} | ${oldMetrics.threshold} | ${percent(oldMetrics.precisionAtK)} | ${percent(oldMetrics.recall)} | ${percent(oldMetrics.zeroResultRate)} | ${fixed.threshold} | ${percent(fixed.precisionAtK)} | ${percent(fixed.recall)} | ${percent(fixed.zeroResultRate)} | ${fixed.minimumResultCount} |`,
    );
  }

  lines.push(
    "",
    "## Five weakest queries at the recommended setting",
    "",
  );
  for (const metric of worst) {
    const run = runByQuery.get(metric.query);
    const correctPaths = new Set(run.relevantPaths);
    const firstCorrectRank = run.results.findIndex((result) => correctPaths.has(result.path)) + 1;
    const falsePositives = run.results
      .filter((result) => !correctPaths.has(result.path))
      .slice(0, 3)
      .map((result) => describeResult(result, imagesByFileName, labelsByImage));
    const explanation =
      firstCorrectRank === 0
        ? `No annotation-positive image appears in the unfiltered ranking. The query's label set has ${metric.totalRelevant} photos, so this is a retrieval or annotation coverage miss rather than a threshold-created empty page.`
        : `The first annotation-positive image ranks ${firstCorrectRank}; only ${metric.hitsAtK}/10 labeled matches reach the top ten. Lower-ranked candidates include visually/textually nearby but differently labeled images.`;
    lines.push(
      `### ${metric.query}`,
      "",
      `- Labeled matches: ${metric.totalRelevant}; top-ten hits: ${metric.hitsAtK}/10; recall at the default: ${percent(metric.recall)}; first correct rank: ${firstCorrectRank || "none"}.`,
      `- Why it underperforms: ${explanation}`,
      "- Leading non-matches:",
      ...(falsePositives.length ? falsePositives.map((result) => `  - ${result}`) : ["  - None in the returned ranking."]),
      "",
    );
  }

  lines.push(
    "## Code locations",
    "",
    `- Slider mapping and default: \`src/semanticIndexer.ts:${findLine(path.join(REPO_ROOT, "src/semanticIndexer.ts"), /export function confidenceSettingToMinimumThreshold/)}\`; \`src/searchSettings.ts:2\`.`,
    `- Search handler passes the mapped minimum: \`src/main.ts:${findLine(path.join(REPO_ROOT, "src/main.ts"), /confidenceSettingToMinimumThreshold\(confidence\)/)}\`.`,
    `- Text and image embeddings are normalized in \`src/semanticIndexer.ts:${findLine(path.join(REPO_ROOT, "src/semanticIndexer.ts"), /private normalize\(/)}\`; dot-product scoring is at \`src/semanticIndexer.ts:${findLine(path.join(REPO_ROOT, "src/semanticIndexer.ts"), /similarity \+= queryVector/)}\`, then score scaling and filtering at \`src/semanticIndexer.ts:${findLine(path.join(REPO_ROOT, "src/semanticIndexer.ts"), /similarity \* 100/)}\` and \`src/semanticIndexer.ts:${findLine(path.join(REPO_ROOT, "src/semanticIndexer.ts"), /confidence < minimumConfidence/)}\`.`,
    "",
    "## Reproduce",
    "",
    "Run `npm run search-eval`. The harness downloads the attribution licensed subset, indexes it under `work/search-eval/`, and writes this report. It requires the local offline CLIP cache at `.model-test-cache/Xenova/clip-vit-base-patch32`; it will not fetch a model from the network.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.mkdir(ANNOTATION_ROOT, { recursive: true });
  const modelCachePath = path.join(REPO_ROOT, ".model-test-cache");
  const requiredModelFiles = [
    "Xenova/clip-vit-base-patch32/config.json",
    "Xenova/clip-vit-base-patch32/tokenizer.json",
    "Xenova/clip-vit-base-patch32/tokenizer_config.json",
    "Xenova/clip-vit-base-patch32/preprocessor_config.json",
    "Xenova/clip-vit-base-patch32/onnx/text_model_quantized.onnx",
    "Xenova/clip-vit-base-patch32/onnx/vision_model_quantized.onnx",
  ];
  for (const file of requiredModelFiles) {
    try {
      await fs.access(path.join(modelCachePath, file));
    } catch {
      throw new Error(`Offline CLIP model is missing ${path.join(modelCachePath, file)}.`);
    }
  }

  const [instances, captions, queries] = await Promise.all([
    loadAnnotation("instances_val2017.json"),
    loadAnnotation("captions_val2017.json"),
    readJSON(QUERY_PATH),
  ]);
  if (queries.length !== 50) throw new Error(`Expected 50 queries, found ${queries.length}.`);
  const photoLicense = instances.licenses.find((license) => license.id === LICENSED_IMAGE_LICENSE_ID);
  if (!photoLicense || !/creativecommons\.org\/licenses\/by\/2\.0/i.test(photoLicense.url))
    throw new Error(`COCO image license id ${LICENSED_IMAGE_LICENSE_ID} is not the expected CC BY 2.0 license.`);

  const { imageById, labelsByImage } = buildImageLabels(instances, captions);
  const { selectedImages, positives, targets } = selectFixture(
    instances.images,
    queries,
    labelsByImage,
  );
  if (selectedImages.some((image) => (labelsByImage.get(image.id)?.captions.length ?? 0) === 0))
    throw new Error("Selected COCO photo is missing its human captions.");
  const manifestPath = path.join(DATA_ROOT, "manifest.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        dataset: "COCO 2017 validation",
        seed: 20261007,
        imageLicenseId: LICENSED_IMAGE_LICENSE_ID,
        imageLicenseUrl: photoLicense.url,
        annotationLicenseUrl: COCO_ANNOTATION_LICENSE_URL,
        annotationLicenseSourceUrl: COCO_ANNOTATION_LICENSE_SOURCE_URL,
        selectedImages: selectedImages.map((image) => image.file_name),
        positiveCounts: queries.map((query, index) => ({
          query: query.query,
          available: positives[index].size,
          target: targets[index],
        })),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Selected ${selectedImages.length} photos from ${instances.images.length} COCO validation images (license id ${LICENSED_IMAGE_LICENSE_ID}).`);
  console.log(`Downloading photo fixture into ${IMAGE_ROOT}.`);
  await downloadImages(selectedImages);

  const selectedIds = new Set(selectedImages.map((image) => image.id));
  const queryRuns = [];
  const imageByFileName = new Map(selectedImages.map((image) => [image.file_name, image]));
  for (const query of queries) {
    const relevantPaths = selectedImages
      .filter((image) => selectedIds.has(image.id) && matchesGroundTruth(query, labelsByImage.get(image.id)))
      .map((image) => path.join(IMAGE_ROOT, image.file_name));
    if (relevantPaths.length === 0)
      throw new Error(`Query has no labeled answers in the selected corpus: ${query.query}`);
    queryRuns.push({ query: query.query, relevantPaths });
  }

  const imageFingerprint = await fingerprintFiles(
    selectedImages.map((image) => path.join(IMAGE_ROOT, image.file_name)),
    IMAGE_ROOT,
  );
  const modelFingerprint = await fingerprintDirectory(modelCachePath);
  const pipelineFingerprint = await fingerprintFiles(
    [
      "src/semanticIndexer.ts",
      "src/semanticWorker.ts",
      "electron-dist/semanticIndexer.js",
      "electron-dist/semanticWorker.js",
      "package-lock.json",
    ].map((filePath) => path.join(REPO_ROOT, filePath)),
    REPO_ROOT,
  );
  const indexDigest = createSearchEvalIndexKey({
    imageFiles: selectedImages.map((image) => image.file_name),
    imageFingerprint,
    modelFingerprint,
    pipelineFingerprint,
  });
  const indexRoot = path.join(DATA_ROOT, `index-${indexDigest.slice(0, 12)}`);
  const completedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  Object.assign(completedManifest, {
    imageFingerprint,
    modelFingerprint,
    pipelineFingerprint,
    indexFingerprint: indexDigest,
  });
  await fs.writeFile(manifestPath, `${JSON.stringify(completedManifest, null, 2)}\n`);
  const indexer = new SemanticIndexer(
    path.join(DATA_ROOT, "temporary-user-data"),
    modelCachePath,
    scanImages,
    (progress) => {
      if (
        progress.status === "indexing" &&
        progress.indexed > 0 &&
        progress.indexed % 50 === 0
      )
        console.log(`Indexed ${progress.indexed} of ${progress.total} images.`);
      if (progress.status === "error") console.error(`Index status: ${progress.message}`);
    },
    (event, details) => {
      if (event.includes("error") || event.includes("failed"))
        console.error(`Index diagnostic ${event}: ${JSON.stringify(details ?? {})}`);
    },
    indexRoot,
  );

  const startedIndexing = performance.now();
  try {
    await indexer.initialize();
    await indexer.startFullScan([IMAGE_ROOT]);
    const indexMilliseconds = performance.now() - startedIndexing;
    const indexSummary = indexer.getIndexSummary([IMAGE_ROOT]);
    if (indexSummary.indexed !== IMAGE_COUNT || indexSummary.errors !== 0)
      throw new Error(
        `Indexing completed with ${indexSummary.indexed}/${IMAGE_COUNT} indexed and ${indexSummary.errors} errors.`,
      );

    console.log("Running 50 CLIP text searches through Silo's SemanticIndexer.");
    const startedSearch = performance.now();
    for (const run of queryRuns) {
      run.results = await indexer.search(run.query, 0, [IMAGE_ROOT]);
      if (run.results.length !== IMAGE_COUNT)
        throw new Error(
          `Search “${run.query}” returned ${run.results.length}/${IMAGE_COUNT} images at threshold 0.`,
        );
      console.log(`Searched: ${run.query}`);
    }
    const searchMilliseconds = performance.now() - startedSearch;

    const oldMetrics = evaluateSliderPositions(queryRuns, (setting) => 100 - setting);
    const fixedMetrics = evaluateSliderPositions(
      queryRuns,
      confidenceSettingToMinimumThreshold,
    );
    const recommended = chooseFullPageDefault(fixedMetrics);
    const payload = {
      generatedAt: new Date().toISOString(),
      modelId: "Xenova/clip-vit-base-patch32",
      imageCount: IMAGE_COUNT,
      indexSummary,
      indexMilliseconds,
      searchMilliseconds,
      queries: queryRuns.map((run) => ({
        query: run.query,
        relevantPaths: run.relevantPaths,
        results: run.results,
      })),
      oldSliderMetrics: oldMetrics.map(({ perQuery, ...summary }) => summary),
      fixedSliderMetrics: fixedMetrics.map(({ perQuery, ...summary }) => summary),
      recommendedSetting: recommended.setting,
      recommendedThreshold: recommended.threshold,
    };
    await fs.writeFile(
      path.join(DATA_ROOT, "benchmark-results.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
    );

    const reportPath = path.resolve(
      process.env.SEARCH_EVAL_REPORT || path.join(DATA_ROOT, "report.md"),
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const report = buildReport({
      indexSummary,
      selectedImages,
      eligibleCount: instances.images.filter((image) => image.license === LICENSED_IMAGE_LICENSE_ID).length,
      photoLicenseUrl: photoLicense.url,
      annotationLicenseUrl: COCO_ANNOTATION_LICENSE_URL,
      annotationLicenseSourceUrl: COCO_ANNOTATION_LICENSE_SOURCE_URL,
      indexDigest,
      currentMetrics: oldMetrics,
      fixedMetrics,
      recommended,
      queryRuns,
      imagesByFileName: imageByFileName,
      labelsByImage,
      indexMilliseconds,
      searchMilliseconds,
    });
    await fs.writeFile(reportPath, report, "utf8");
    console.log(`Recommended slider default: ${recommended.setting} (minimum score ${recommended.threshold}).`);
    console.log(`Report written to ${reportPath}.`);
  } finally {
    indexer.stopWatching();
    const worker = indexer["embeddingWorker"];
    if (worker?.connected) worker.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
