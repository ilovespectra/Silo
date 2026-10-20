export type BorrowedLocationConfidence = "high" | "medium" | "low";

export interface BorrowedLocationSample {
  path: string;
  captureTime: number;
  cameraKey?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface BorrowedLocationSuggestion {
  path: string;
  latitude: number;
  longitude: number;
  confidence: BorrowedLocationConfidence;
  referenceCount: number;
  timeOffsetMs: number;
  method: "stationary" | "interpolated" | "nearest";
}

export interface BorrowedLocationInferenceOptions {
  windowMinutes?: number;
  calibrationRangeHours?: number;
}

const DEFAULT_WINDOW_MINUTES = 15;
const MAX_CALIBRATION_RANGE_HOURS = 14;
const METERS_PER_SECOND_TO_KMH = 3.6;

function validCoordinate(latitude: number, longitude: number) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function distanceMeters(
  first: Pick<BorrowedLocationSample, "latitude" | "longitude">,
  second: Pick<BorrowedLocationSample, "latitude" | "longitude">,
) {
  const radians = Math.PI / 180;
  const latitude1 = Number(first.latitude) * radians;
  const latitude2 = Number(second.latitude) * radians;
  const latitudeDelta = (Number(second.latitude) - Number(first.latitude)) * radians;
  const longitudeDelta = (Number(second.longitude) - Number(first.longitude)) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function hasValidCoordinates(sample: BorrowedLocationSample) {
  return (
    sample.latitude !== null &&
    sample.latitude !== undefined &&
    sample.longitude !== null &&
    sample.longitude !== undefined &&
    validCoordinate(Number(sample.latitude), Number(sample.longitude))
  );
}

function interpolateCoordinates(
  first: BorrowedLocationSample,
  second: BorrowedLocationSample,
  fraction: number,
) {
  const radians = Math.PI / 180;
  const toVector = (sample: BorrowedLocationSample) => {
    const latitude = Number(sample.latitude) * radians;
    const longitude = Number(sample.longitude) * radians;
    return [
      Math.cos(latitude) * Math.cos(longitude),
      Math.cos(latitude) * Math.sin(longitude),
      Math.sin(latitude),
    ];
  };
  const a = toVector(first);
  const b = toVector(second);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  if (angle < 1e-8) {
    return {
      latitude: Number(first.latitude),
      longitude: Number(first.longitude),
    };
  }
  const sinAngle = Math.sin(angle);
  const weightA = Math.sin((1 - fraction) * angle) / sinAngle;
  const weightB = Math.sin(fraction * angle) / sinAngle;
  const x = weightA * a[0] + weightB * b[0];
  const y = weightA * a[1] + weightB * b[1];
  const z = weightA * a[2] + weightB * b[2];
  return {
    latitude: Math.atan2(z, Math.hypot(x, y)) / radians,
    longitude: Math.atan2(y, x) / radians,
  };
}

function nearestReference(
  references: BorrowedLocationSample[],
  targetTime: number,
  maximumDeltaMs: number,
) {
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (references[middle].captureTime < targetTime) low = middle + 1;
    else high = middle;
  }
  let best: BorrowedLocationSample | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let index = Math.max(0, low - 1); index < Math.min(references.length, low + 1); index += 1) {
    const candidate = references[index];
    const delta = Math.abs(candidate.captureTime - targetTime);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best && bestDelta <= maximumDeltaMs
    ? { sample: best, deltaMs: bestDelta }
    : null;
}

function referencesInWindow(
  references: BorrowedLocationSample[],
  targetTime: number,
  windowMs: number,
) {
  let low = 0;
  let high = references.length;
  const earliest = targetTime - windowMs;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (references[middle].captureTime < earliest) low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = references.length;
  const latest = targetTime + windowMs;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (references[middle].captureTime <= latest) low = middle + 1;
    else high = middle;
  }
  return references.slice(start, low);
}

function scoreOffset(
  targets: BorrowedLocationSample[],
  references: BorrowedLocationSample[],
  offsetMs: number,
  matchWindowMs: number,
) {
  const matched: Array<{ targetTime: number; deltaMs: number }> = [];
  for (const target of targets) {
    const nearest = nearestReference(
      references,
      target.captureTime + offsetMs,
      matchWindowMs,
    );
    if (nearest)
      matched.push({ targetTime: target.captureTime, deltaMs: nearest.deltaMs });
  }
  matched.sort((first, second) => first.targetTime - second.targetTime);
  const independentMatches: typeof matched = [];
  for (const match of matched) {
    const previous = independentMatches[independentMatches.length - 1];
    if (!previous || match.targetTime - previous.targetTime >= 3 * 60_000)
      independentMatches.push(match);
    else if (match.deltaMs < previous.deltaMs)
      independentMatches[independentMatches.length - 1] = match;
  }
  const matches = independentMatches.length;
  const residualTotal = independentMatches.reduce(
    (sum, match) => sum + match.deltaMs,
    0,
  );
  return {
    offsetMs,
    matches,
    averageResidualMs: matches ? residualTotal / matches : Number.POSITIVE_INFINITY,
  };
}

function estimateCameraOffsets(
  targets: BorrowedLocationSample[],
  references: BorrowedLocationSample[],
  rangeHours: number,
) {
  const offsets = new Map<string, number>();
  const groups = new Map<string, BorrowedLocationSample[]>();
  for (const target of targets) {
    const key = target.cameraKey?.trim().toLowerCase();
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(target);
    groups.set(key, group);
  }
  const rangeMs = Math.min(rangeHours, MAX_CALIBRATION_RANGE_HOURS) * 60 * 60_000;
  const coarseStepMs = 5 * 60_000;
  const matchWindowMs = 2 * 60_000;
  for (const [cameraKey, cameraTargets] of groups) {
    if (cameraTargets.length < 3) continue;
    const orderedTargets = cameraTargets
      .slice()
      .sort((first, second) => first.captureTime - second.captureTime);
    const calibrationTargets =
      orderedTargets.length <= 3_000
        ? orderedTargets
        : Array.from({ length: 3_000 }, (_, index) =>
            orderedTargets[
              Math.floor((index * (orderedTargets.length - 1)) / 2_999)
            ],
          );
    const scores = [];
    for (let offset = -rangeMs; offset <= rangeMs; offset += coarseStepMs) {
      scores.push(scoreOffset(calibrationTargets, references, offset, matchWindowMs));
    }
    scores.sort((first, second) =>
      second.matches - first.matches || first.averageResidualMs - second.averageResidualMs,
    );
    const coarseBest = scores[0];
    if (!coarseBest || coarseBest.matches < 3) continue;
    const refined = [];
    const refineStepMs = 30_000;
    for (
      let offset = coarseBest.offsetMs - coarseStepMs;
      offset <= coarseBest.offsetMs + coarseStepMs;
      offset += refineStepMs
    ) {
      if (Math.abs(offset) > rangeMs) continue;
      refined.push(scoreOffset(calibrationTargets, references, offset, 90_000));
    }
    refined.sort((first, second) =>
      second.matches - first.matches || first.averageResidualMs - second.averageResidualMs,
    );
    const best = refined[0];
    const baseline = scoreOffset(calibrationTargets, references, 0, 90_000);
    const runnerUp = refined.find(
      (score) => Math.abs(score.offsetMs - best.offsetMs) > 2 * 60_000,
    );
    const clearlySupported =
      best.matches >= 3 &&
      best.matches >= baseline.matches + 2 &&
      best.matches >= Math.ceil(Math.max(1, baseline.matches) * 1.5) &&
      (!runnerUp || best.matches >= runnerUp.matches + 2);
    if (clearlySupported && Math.abs(best.offsetMs) > 90_000)
      offsets.set(cameraKey, best.offsetMs);
  }
  return offsets;
}

function inferOne(
  target: BorrowedLocationSample,
  references: BorrowedLocationSample[],
  timeOffsetMs: number,
  windowMs: number,
): BorrowedLocationSuggestion | null {
  const correctedTime = target.captureTime + timeOffsetMs;
  const nearest = nearestReference(references, correctedTime, windowMs);
  if (!nearest) return null;
  const nearby = referencesInWindow(references, correctedTime, windowMs);
  if (!nearby.length) return null;
  const medoid = nearby.reduce((best, candidate) => {
    const candidateTotal = nearby.reduce(
      (sum, other) => sum + distanceMeters(candidate, other),
      0,
    );
    const bestTotal = nearby.reduce(
      (sum, other) => sum + distanceMeters(best, other),
      0,
    );
    return candidateTotal < bestTotal ? candidate : best;
  });
  const spread = Math.max(...nearby.map((reference) => distanceMeters(medoid, reference)));
  if (spread <= 500) {
    const confidence: BorrowedLocationConfidence =
      nearby.length >= 3 && spread <= 100 && nearest.deltaMs <= 2 * 60_000
        ? "high"
        : nearby.length >= 2 && spread <= 250 && nearest.deltaMs <= 5 * 60_000
          ? "medium"
          : "low";
    return {
      path: target.path,
      latitude: Number(medoid.latitude),
      longitude: Number(medoid.longitude),
      confidence,
      referenceCount: nearby.length,
      timeOffsetMs,
      method: "stationary",
    };
  }

  let before: BorrowedLocationSample | null = null;
  let after: BorrowedLocationSample | null = null;
  for (const reference of nearby) {
    if (reference.captureTime <= correctedTime) before = reference;
    if (reference.captureTime >= correctedTime && !after) after = reference;
  }
  if (before && after && before.path !== after.path && after.captureTime > before.captureTime) {
    const gapMs = after.captureTime - before.captureTime;
    const speedKmh =
      (distanceMeters(before, after) / (gapMs / 1000)) * METERS_PER_SECOND_TO_KMH;
    if (gapMs <= 20 * 60_000 && speedKmh <= 180) {
      const fraction = (correctedTime - before.captureTime) / gapMs;
      const position = interpolateCoordinates(before, after, fraction);
      return {
        path: target.path,
        ...position,
        confidence:
          gapMs <= 10 * 60_000 && speedKmh <= 130 ? "medium" : "low",
        referenceCount: nearby.length,
        timeOffsetMs,
        method: "interpolated",
      };
    }
  }
  if (nearest.deltaMs <= 2 * 60_000) {
    return {
      path: target.path,
      latitude: Number(nearest.sample.latitude),
      longitude: Number(nearest.sample.longitude),
      confidence: "low",
      referenceCount: nearby.length,
      timeOffsetMs,
      method: "nearest",
    };
  }
  return null;
}

export function inferBorrowedLocations(
  samples: BorrowedLocationSample[],
  options: BorrowedLocationInferenceOptions = {},
): BorrowedLocationSuggestion[] {
  const windowMinutes =
    Number.isFinite(options.windowMinutes) && Number(options.windowMinutes) > 0
      ? Number(options.windowMinutes)
      : DEFAULT_WINDOW_MINUTES;
  const references = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.captureTime) &&
        hasValidCoordinates(sample),
    )
    .sort((first, second) => first.captureTime - second.captureTime);
  const targets = samples.filter(
    (sample) =>
      Number.isFinite(sample.captureTime) &&
      !hasValidCoordinates(sample),
  );
  if (!references.length || !targets.length) return [];
  const offsets = estimateCameraOffsets(
    targets,
    references,
    options.calibrationRangeHours ?? MAX_CALIBRATION_RANGE_HOURS,
  );
  const windowMs = windowMinutes * 60_000;
  return targets.flatMap((target) => {
    const key = target.cameraKey?.trim().toLowerCase() ?? "";
    const suggestion = inferOne(
      target,
      references,
      offsets.get(key) ?? 0,
      windowMs,
    );
    return suggestion ? [suggestion] : [];
  });
}
