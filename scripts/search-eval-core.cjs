"use strict";

const DEFAULT_K = 10;

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasPhrase(text, phrase) {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedPhrase = normalizeText(phrase);
  return Boolean(normalizedPhrase) && normalizedText.includes(` ${normalizedPhrase} `);
}

function matchesGroundTruth(query, image) {
  const categories = image.categoryNames ?? new Set();
  const counts = image.categoryCounts ?? new Map();
  const captions = image.captions ?? [];

  if (query.categories_all.some((category) => !categories.has(category))) return false;
  if (
    query.categories_any.length > 0 &&
    !query.categories_any.some((category) => categories.has(category))
  )
    return false;
  if (
    Object.entries(query.category_min_counts).some(
      ([category, count]) => (counts.get(category) ?? 0) < count,
    )
  )
    return false;

  const captionText = captions.join(" ");
  return query.caption_groups.every((group) =>
    group.some((phrase) => hasPhrase(captionText, phrase)),
  );
}

function measureQuery(results, relevantPaths, threshold, k = DEFAULT_K) {
  const filtered = results.filter(
    (result) => Number.isFinite(result.confidence) && result.confidence >= threshold,
  );
  const topK = filtered.slice(0, k);
  const relevant = new Set(relevantPaths);
  const hitsAtK = topK.reduce((count, result) => count + Number(relevant.has(result.path)), 0);
  const totalRelevant = relevant.size;
  const returnedRelevant = filtered.reduce(
    (count, result) => count + Number(relevant.has(result.path)),
    0,
  );

  return {
    precisionAtK: hitsAtK / k,
    recall: totalRelevant === 0 ? 0 : returnedRelevant / totalRelevant,
    hitsAtK,
    returnedRelevant,
    totalRelevant,
    resultCount: filtered.length,
    zeroResults: filtered.length === 0,
  };
}

function evaluateSliderPositions(queryRuns, settingToThreshold, k = DEFAULT_K) {
  return Array.from({ length: 101 }, (_, setting) => {
    const threshold = settingToThreshold(setting);
    const perQuery = queryRuns.map((run) => ({
      query: run.query,
      ...measureQuery(run.results, run.relevantPaths, threshold, k),
    }));
    const count = perQuery.length || 1;
    const sum = (key) => perQuery.reduce((total, metric) => total + metric[key], 0);

    return {
      setting,
      threshold,
      precisionAtK: sum("precisionAtK") / count,
      recall: sum("recall") / count,
      zeroResultRate: sum("zeroResults") / count,
      meanResultCount: sum("resultCount") / count,
      minimumResultCount: perQuery.reduce(
        (minimum, metric) => Math.min(minimum, metric.resultCount),
        Number.POSITIVE_INFINITY,
      ),
      perQuery,
    };
  });
}

function chooseFullPageDefault(sliderMetrics, k = DEFAULT_K) {
  const candidates = sliderMetrics.filter(
    (metrics) => metrics.zeroResultRate === 0 && metrics.minimumResultCount >= k,
  );
  if (candidates.length === 0) return sliderMetrics[0];
  return candidates.reduce((best, current) =>
    current.threshold > best.threshold ? current : best,
  );
}

module.exports = {
  DEFAULT_K,
  chooseFullPageDefault,
  evaluateSliderPositions,
  hasPhrase,
  matchesGroundTruth,
  measureQuery,
  normalizeText,
};
