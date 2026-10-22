#!/usr/bin/env node
/*
 * Reproducible, synthetic benchmark for Silo's real filename/path posting index.
 * Run from the repository root with:
 *   node --cpu-prof --cpu-prof-dir=<Clicky workspace>/tmp/search-sprint/profiles \
 *     scripts/search-sprint-benchmark.cjs
 * The fixture and JSON results are written under the Clicky workspace tmp/.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { performance } = require("node:perf_hooks");
const inspector = require("node:inspector");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "..");
const clickyRoot = path.resolve(__dirname, "../../..");
const workRoot = path.join(clickyRoot, "tmp", "search-sprint");
const virtualRoot = path.join(workRoot, "virtual-sources");
const recordCount = Number(process.env.SILO_SEARCH_BENCH_COUNT || 500_000);
const warmRepeats = Number(process.env.SILO_SEARCH_BENCH_REPEATS || 7);
const searchResultLimit = 5000; // Keep aligned with SEARCH_TEXT_RESULT_LIMIT.
const sourceNames = ["camera-roll", "travel-archive", "family-photos", "external-drive"];
const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const regions = ["Ljubljana", "Dolomites", "Yosemite", "Iceland", "Amalfi", "Kyoto", "Patagonia", "Paris"];
const events = ["Golden-Hour", "Morning-Walk", "Family-Dinner", "Snow-Day", "Beach-Trip", "City-Lights", "Garden", "Birthday"];
const cameras = ["iPhone-15-Pro", "Sony-A7-III", "Canon-EOS-R5", "Nikon-D850", "Pixel-9-Pro", "Fuji-X-T5"];
const sourceRoots = sourceNames.map((name) => path.join(virtualRoot, name));
const fixturePath = path.join(workRoot, "library.tsv");
const resultsPath = path.join(workRoot, "node-results.json");
const metadata = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, recordCount, warmRepeats };

function loadSource(name, cache = new Map()) {
  const filename = path.join(repoRoot, "src", name);
  if (cache.has(filename)) return cache.get(filename).exports;
  const sourceRequire = createRequire(filename);
  const moduleObject = { exports: {} };
  cache.set(filename, moduleObject);
  const mockedRequire = (moduleName) => {
    if (moduleName.startsWith("./")) {
      const nested = path.join(repoRoot, "src", `${moduleName.slice(2)}.ts`);
      if (fs.existsSync(nested)) return loadSource(path.basename(nested), cache);
    }
    return sourceRequire(moduleName);
  };
  mockedRequire.resolve = sourceRequire.resolve.bind(sourceRequire);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const context = vm.createContext({
    exports: moduleObject.exports,
    module: moduleObject,
    __dirname: path.join(repoRoot, "electron-dist"),
    require: mockedRequire,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
  });
  vm.runInContext(output, context, { filename });
  return moduleObject.exports;
}

function tokenSet(value) {
  return new Set(value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

function tokens(value) {
  return Array.from(tokenSet(value));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function writeFixtureAndBuildIndexer() {
  fs.mkdirSync(workRoot, { recursive: true });
  for (const sourceRoot of sourceRoots) fs.mkdirSync(sourceRoot, { recursive: true });
  const { SemanticIndexer } = loadSource("semanticIndexer.ts");
  const indexer = new SemanticIndexer(
    path.join(workRoot, "user-data"),
    path.join(workRoot, "model-cache-unused"),
    async () => undefined,
    () => undefined,
  );
  indexer.loadComplete = true;
  indexer.demoFilePaths = () => null;

  const stream = fs.createWriteStream(fixturePath, { encoding: "utf8" });
  let pending = "source\tpath\tname\trelativePath\tsize\tmodified\tcamera\tcapturedAt\tlatitude\tlongitude\twidth\theight\n";
  let built = 0;
  const started = performance.now();
  for (let id = 0; id < recordCount; id += 1) {
    const sourceIndex = Math.floor(id / Math.ceil(recordCount / sourceNames.length));
    const source = Math.min(sourceNames.length - 1, sourceIndex);
    const local = id - Math.floor(recordCount / sourceNames.length) * source;
    const anchor = local % 997 === 0;
    const year = anchor ? 2024 : years[(id * 13 + source * 3) % years.length];
    const month = ((id * 7 + source * 5) % 12) + 1;
    const region = anchor ? "Dolomites" : regions[(id * 17 + source) % regions.length];
    const event = anchor ? "Golden-Hour" : events[(id * 19 + source * 2) % events.length];
    const camera = anchor ? "Nikon-D850" : cameras[(id * 23 + source * 5) % cameras.length];
    const day = ((id * 11 + source) % 28) + 1;
    const cameraSlug = camera.toLowerCase();
    const name = `IMG_${String(local).padStart(6, "0")}_${region}_${event}_${camera}.jpg`;
    const relativePath = path.join(
      String(year),
      String(month).padStart(2, "0"),
      region,
      event,
      cameraSlug,
      name,
    );
    const filePath = path.join(sourceRoots[source], relativePath);
    const capturedAt = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(id % 24).padStart(2, "0")}:${String((id * 7) % 60).padStart(2, "0")}:00Z`;
    const latitude = (35 + ((id * 37) % 1_800_000) / 100_000).toFixed(5);
    const longitude = (-125 + ((id * 53) % 5_000_000) / 100_000).toFixed(5);
    const width = [4032, 6000, 6240, 8064][id % 4];
    const height = [3024, 4000, 4160, 6048][id % 4];
    const size = 900_000 + ((id * 7919) % 18_000_000);
    const modified = Date.parse(capturedAt);

    const record = {
      path: filePath,
      name,
      sourcePath: sourceRoots[source],
      relativePath,
      size,
      modified,
      type: "image",
      extension: ".jpg",
      signature: `synthetic-${id}`,
      vectorOffset: -1,
    };
    indexer.setLatestRecord(record);
    pending += `${source}\t${filePath}\t${name}\t${relativePath}\t${size}\t${modified}\t${camera}\t${capturedAt}\t${latitude}\t${longitude}\t${width}\t${height}\n`;
    built += 1;
    if (built % 1000 === 0) {
      if (!stream.write(pending)) await new Promise((resolve) => stream.once("drain", resolve));
      pending = "";
    }
    if (built % 50_000 === 0) console.error(`Indexed ${built.toLocaleString()} synthetic path records`);
  }
  if (pending) stream.write(pending);
  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });
  // These fixtures have complete text records but intentionally omit 512-D CLIP vectors.
  indexer.recordCountsBySource = new Map(sourceRoots.map((root) => [root, {
    total: Math.ceil(recordCount / sourceNames.length),
    indexed: Math.ceil(recordCount / sourceNames.length),
    errors: 0,
  }]));
  metadata.indexBuildMs = performance.now() - started;
  metadata.fixtureBytes = fs.statSync(fixturePath).size;
  metadata.sourceRoots = sourceRoots;
  return indexer;
}

async function searchOnce(indexer, query, selectedRoots) {
  const sourceReads = new Set();
  const originalGet = indexer.textPostingsBySource.get;
  indexer.textPostingsBySource.get = function (sourceRoot) {
    sourceReads.add(sourceRoot);
    return originalGet.call(this, sourceRoot);
  };
  let progress = { scanned: 0, total: 0, capped: false };
  const started = performance.now();
  let matches;
  try {
    matches = await indexer.searchTextMatches(query, selectedRoots, () => false,
      (_batch, scanned, total, capped) => { progress = { scanned, total, capped }; });
  } finally {
    indexer.textPostingsBySource.get = originalGet;
  }
  return {
    ms: performance.now() - started,
    matchCount: matches.length,
    scannedCandidates: progress.scanned,
    capped: progress.capped,
    postingSourcesRead: Array.from(sourceReads).sort(),
  };
}

function scanSearch(records, query, selectedRoots, sourceBuckets = null) {
  const queryTerms = tokens(query);
  const roots = new Set(selectedRoots);
  const list = sourceBuckets
    ? selectedRoots.flatMap((sourceRoot) => sourceBuckets.get(sourceRoot) || [])
    : records;
  const started = performance.now();
  let visited = 0;
  let matches = 0;
  for (const record of list) {
    visited += 1;
    if (!sourceBuckets && !roots.has(record.sourcePath)) continue;
    const recordTerms = tokenSet(`${record.name} ${record.relativePath}`);
    let all = true;
    for (const term of queryTerms) if (!recordTerms.has(term)) { all = false; break; }
    if (!all) continue;
    matches += 1;
    if (matches > searchResultLimit) { matches = searchResultLimit; break; }
  }
  return { ms: performance.now() - started, matchCount: matches, recordsVisited: visited };
}

async function run() {
  if (recordCount !== 500_000 && process.env.SILO_SEARCH_BENCH_COUNT === undefined)
    throw new Error("The default fixture must contain 500,000 paths.");
  const indexer = await writeFixtureAndBuildIndexer();
  const records = indexer.latestRecords;
  const recordsBySource = new Map(sourceRoots.map((root) => [root, []]));
  for (const record of records.values()) recordsBySource.get(record.sourcePath).push(record);
  const queries = [
    { name: "short", value: "IMG" },
    { name: "long", value: "Dolomites Golden Hour 2024 Nikon" },
  ];
  const scenarios = [];
  let profilingSession = null;
  if (process.env.SILO_SEARCH_BENCH_PROFILE_SEARCH === "1") {
    profilingSession = new inspector.Session();
    profilingSession.connect();
    await new Promise((resolve, reject) => profilingSession.post("Profiler.enable", (error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => profilingSession.post("Profiler.start", (error) => error ? reject(error) : resolve()));
  }
  for (const selectedRoots of [[sourceRoots[0]], sourceRoots]) {
    for (const query of queries) {
      const cold = await searchOnce(indexer, query.value, selectedRoots);
      const warm = [];
      for (let sample = 0; sample < warmRepeats; sample += 1)
        warm.push(await searchOnce(indexer, query.value, selectedRoots));
      scenarios.push({
        selectedSourceCount: selectedRoots.length,
        selectedSources: selectedRoots,
        queryName: query.name,
        query: query.value,
        cold,
        warmMedianMs: median(warm.map((entry) => entry.ms)),
        warmP95Ms: percentile(warm.map((entry) => entry.ms), 0.95),
        warmMatchCount: warm.at(-1)?.matchCount ?? 0,
        warmSourceReads: warm.at(-1)?.postingSourcesRead ?? [],
      });
    }
  }
  if (profilingSession) {
    const profile = await new Promise((resolve, reject) => profilingSession.post("Profiler.stop", (error, result) => error ? reject(error) : resolve(result.profile)));
    fs.writeFileSync(path.join(workRoot, "search-only.cpuprofile"), `${JSON.stringify(profile)}\n`);
    profilingSession.disconnect();
  }
  for (const scenario of scenarios) {
    scenario.wholeLibraryScan = scanSearch(records.values(), scenario.query, scenario.selectedSources);
    scenario.selectedSourceScan = scanSearch(records.values(), scenario.query, scenario.selectedSources, recordsBySource);
  }
  metadata.searches = scenarios;
  metadata.heapUsedBytes = process.memoryUsage().heapUsed;
  metadata.rssBytes = process.memoryUsage().rss;
  metadata.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultsPath, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
