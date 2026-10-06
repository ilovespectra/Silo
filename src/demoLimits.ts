export const DEMO_LIMITS = {
  sources: 2,
  files: 1000,
  digitalFolders: 5,
  memoryPreviews: 5,
  people: 3,
  mapDestinations: 100,
  mapPhotos: 1000,
  duplicateDeletes: 100,
} as const;

export type DemoLimitFeature = keyof typeof DEMO_LIMITS;

export function hasFullAccess(
  lifetimeLicensed: boolean,
  demoModeOverride: boolean,
): boolean {
  return lifetimeLicensed && !demoModeOverride;
}

export interface DemoSource {
  rootPath: string;
  enabled: boolean;
  available: boolean;
  message: string;
  demoLocked?: boolean;
}

export function applyDemoSourceLimit<T extends DemoSource>(
  sources: readonly T[],
  isLicensed: boolean,
  limit: number,
): T[] {
  const result = sources.map((source) => ({ ...source }));
  if (isLicensed) return result;
  const includedRoots = new Set<string>();
  for (const source of result) {
    if (!source.enabled || !source.available || !source.rootPath.trim())
      continue;
    if (includedRoots.has(source.rootPath)) continue;
    if (includedRoots.size < limit) {
      includedRoots.add(source.rootPath);
      continue;
    }
    source.enabled = false;
    source.demoLocked = true;
    source.message = [
      source.message,
      `This source is not included because the demo allows ${limit} active sources.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return result;
}

export function isDemoLimitReached(
  isLicensed: boolean,
  used: number,
  limit: number,
): boolean {
  return !isLicensed && used >= limit;
}

export function selectDemoFilePaths<
  T extends { path: string; sourcePath: string; type?: string },
>(
  records: readonly T[],
  sourcePaths: readonly string[],
  limit: number | null,
  typeCounts?: Readonly<Record<string, number>>,
): Set<string> {
  const activeSources = new Set(sourcePaths);
  const eligible = records
    .filter((record) => activeSources.has(record.sourcePath))
    .sort((first, second) => first.path.localeCompare(second.path));
  if (limit === null) return new Set(eligible.map((record) => record.path));

  const byType = new Map<string, T[]>();
  for (const record of eligible) {
    const type = record.type?.trim() || "other";
    const group = byType.get(type) ?? [];
    group.push(record);
    byType.set(type, group);
  }

  const types = Array.from(byType.keys()).sort();
  const capacities = new Map(
    types.map((type) => [type, byType.get(type)?.length ?? 0]),
  );
  const populations = new Map(
    types.map((type) => [
      type,
      Math.max(
        capacities.get(type) ?? 0,
        Math.floor(typeCounts?.[type] ?? capacities.get(type) ?? 0),
      ),
    ]),
  );
  const target = Math.min(
    Math.max(0, Math.floor(limit)),
    Array.from(capacities.values()).reduce((sum, count) => sum + count, 0),
  );
  const quotas = new Map(types.map((type) => [type, 0]));
  const totalPopulation = Array.from(populations.values()).reduce(
    (sum, count) => sum + count,
    0,
  );
  const shares = types.map((type) => {
    const exact = totalPopulation
      ? (target * (populations.get(type) ?? 0)) / totalPopulation
      : 0;
    const quota = Math.min(capacities.get(type) ?? 0, Math.floor(exact));
    quotas.set(type, quota);
    return { type, exact, fraction: exact - Math.floor(exact) };
  });

  let allocated = Array.from(quotas.values()).reduce((sum, count) => sum + count, 0);
  if (target >= types.length) {
    for (const type of types) {
      if ((quotas.get(type) ?? 0) > 0) continue;
      quotas.set(type, 1);
      allocated += 1;
    }
    while (allocated > target) {
      const donor = shares
        .filter(({ type }) => (quotas.get(type) ?? 0) > 1)
        .sort(
          (first, second) =>
            (quotas.get(second.type) ?? 0) - second.exact -
              ((quotas.get(first.type) ?? 0) - first.exact) ||
            second.type.localeCompare(first.type),
        )[0];
      if (!donor) break;
      quotas.set(donor.type, (quotas.get(donor.type) ?? 0) - 1);
      allocated -= 1;
    }
  }

  let remaining = target - allocated;
  const byRemainder = [...shares].sort(
    (first, second) =>
      second.fraction - first.fraction ||
      (populations.get(second.type) ?? 0) -
        (populations.get(first.type) ?? 0) ||
      first.type.localeCompare(second.type),
  );
  while (remaining > 0) {
    let added = false;
    for (const share of byRemainder) {
      if (remaining === 0) break;
      if ((quotas.get(share.type) ?? 0) >= (capacities.get(share.type) ?? 0))
        continue;
      quotas.set(share.type, (quotas.get(share.type) ?? 0) + 1);
      remaining -= 1;
      added = true;
    }
    if (!added) break;
  }

  const selected: string[] = [];
  for (const type of types) {
    selected.push(
      ...(byType.get(type) ?? [])
        .slice(0, quotas.get(type) ?? 0)
        .map((record) => record.path),
    );
  }
  return new Set(selected);
}

export function formatDemoFileSample(
  selectedCounts: Readonly<Record<string, number>>,
  sourceCounts: Readonly<Record<string, number>>,
): string {
  const formatCounts = (counts: Readonly<Record<string, number>>) =>
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([type, count]) => {
        const label =
          type === "image"
            ? "photo"
            : type === "document"
              ? "document"
              : type;
        return `${count.toLocaleString()} ${label}${count === 1 ? "" : "s"}`;
      })
      .join(" · ");
  const selectedTotal = Object.values(selectedCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const sourceTotal = Object.values(sourceCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  return `Demo sample: ${selectedTotal.toLocaleString()} of ${sourceTotal.toLocaleString()} indexable files · sample mix ${formatCounts(selectedCounts) || "none"} · source mix ${formatCounts(sourceCounts) || "none"}.`;
}

export interface DemoMapPhoto {
  path: string;
  locationLabel?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  latitude: number;
  longitude: number;
}

export function getDemoDestinationKey(photo: DemoMapPhoto): string {
  const label = photo.locationLabel?.trim();
  if (label) return label.toLocaleLowerCase();
  const namedParts = [photo.city, photo.region, photo.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (namedParts.length > 0)
    return namedParts.join("|").toLocaleLowerCase();
  if (Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude))
    return `${photo.latitude.toFixed(3)}:${photo.longitude.toFixed(3)}`;
  return "unknown";
}

export function selectDemoMapPhotos<T extends DemoMapPhoto>(
  photos: readonly T[],
  isLicensed: boolean,
  photoLimit: number,
  destinationLimit: number,
): T[] {
  if (isLicensed) return [...photos];
  const uniquePhotos = Array.from(
    new Map(
      [...photos]
        .sort((first, second) => first.path.localeCompare(second.path))
        .map((photo) => [photo.path, photo]),
    ).values(),
  );
  const selected: T[] = [];
  const destinations = new Set<string>();
  for (const photo of uniquePhotos) {
    if (selected.length >= Math.max(0, photoLimit)) break;
    const destination = getDemoDestinationKey(photo);
    if (
      !destinations.has(destination) &&
      destinations.size >= Math.max(0, destinationLimit)
    )
      continue;
    destinations.add(destination);
    selected.push(photo);
  }
  return selected;
}

export function selectDemoPeople<T>(
  people: readonly T[],
  isLicensed: boolean,
  limit: number,
): T[] {
  return isLicensed ? [...people] : people.slice(0, Math.max(0, limit));
}

export function selectDemoDeletionBatch<T>(
  items: readonly T[],
  isLicensed: boolean,
  alreadyDeleted: number,
  limit: number,
): T[] {
  if (isLicensed) return [...items];
  const remaining = Math.max(0, limit - Math.max(0, alreadyDeleted));
  return items.slice(0, remaining);
}
