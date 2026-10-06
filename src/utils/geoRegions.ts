// Country / US-state membership for geotagged photos, using Natural Earth polygons.

type Ring = number[][];
type PolygonCoords = Ring[];

export interface RegionFeature {
  key: string;
  name: string;
  kind: "country" | "state";
  code: string | null;
  polygons: PolygonCoords[];
  bbox: [number, number, number, number];
  centroid: { lat: number; lng: number };
}

export interface RegionIndex {
  byRegion: Map<string, GeoPhoto[]>;
  byPath: Map<string, string>;
}

export function regionKey(feature: any): string {
  const properties = feature?.properties ?? {};
  if (properties.KIND === "state") return `state:${properties.POSTAL}`;
  return `country:${properties.ADM0_A3 || properties.ISO_A3 || properties.ISO_A2_EH || properties.NAME}`;
}

function isUnitedStatesCountry(feature: any) {
  const properties = feature?.properties ?? {};
  return (
    properties.KIND !== "state" &&
    (properties.ADM0_A3 === "USA" ||
      properties.ISO_A2 === "US" ||
      properties.ISO_A2_EH === "US")
  );
}

/** Replaces the single United States outline with its individual states. */
export function withUsStates(countries: any[], states: any[]) {
  return states.length > 0
    ? [
        ...countries.filter((feature) => !isUnitedStatesCountry(feature)),
        ...states,
      ]
    : countries;
}

function polygonsOf(geometry: any): PolygonCoords[] {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

export function buildRegions(features: any[]): RegionFeature[] {
  return features.flatMap((feature) => {
    const polygons = polygonsOf(feature.geometry);
    if (polygons.length === 0) return [];
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;
    let largest = polygons[0];
    for (const polygon of polygons) {
      if (polygon[0].length > largest[0].length) largest = polygon;
      for (const [lng, lat] of polygon[0]) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    let cLng = 0,
      cLat = 0;
    for (const [lng, lat] of largest[0]) {
      cLng += lng;
      cLat += lat;
    }
    const properties = feature.properties ?? {};
    const isState = properties.KIND === "state";
    return [
      {
        key: regionKey(feature),
        name: properties.NAME || properties.ADMIN || "Unknown region",
        kind: isState ? ("state" as const) : ("country" as const),
        code:
          properties.ISO_A2_EH && properties.ISO_A2_EH !== "-99"
            ? properties.ISO_A2_EH
            : (properties.ISO_A2 ?? null),
        polygons,
        bbox: [minLng, minLat, maxLng, maxLat] as [
          number,
          number,
          number,
          number,
        ],
        centroid: {
          lat: cLat / largest[0].length,
          lng: cLng / largest[0].length,
        },
      },
    ];
  });
}

function inRing(lng: number, lat: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function containsPoint(region: RegionFeature, lat: number, lng: number) {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat)
    return false;
  return region.polygons.some(
    (polygon) =>
      inRing(lng, lat, polygon[0]) &&
      !polygon.slice(1).some((hole) => inRing(lng, lat, hole)),
  );
}

export function regionAt(regions: RegionFeature[], lat: number, lng: number) {
  // States first so a US point resolves to its state, not a stray country outline.
  return (
    regions.find(
      (region) => region.kind === "state" && containsPoint(region, lat, lng),
    ) ??
    regions.find(
      (region) => region.kind === "country" && containsPoint(region, lat, lng),
    ) ??
    null
  );
}

const normalize = (value: string | null | undefined) =>
  (value ?? "").toLowerCase().replace(/[^a-z]/g, "");

/** Coastal photos can fall just outside simplified borders; snap them to the closest region nearby. */
function nearestRegion(
  regions: RegionFeature[],
  lat: number,
  lng: number,
  maxDegrees = 0.6,
) {
  let best: RegionFeature | null = null;
  let bestDistance = maxDegrees * maxDegrees;
  for (const region of regions) {
    const [minLng, minLat, maxLng, maxLat] = region.bbox;
    if (
      lng < minLng - maxDegrees ||
      lng > maxLng + maxDegrees ||
      lat < minLat - maxDegrees ||
      lat > maxLat + maxDegrees
    )
      continue;
    for (const polygon of region.polygons) {
      for (const [x, y] of polygon[0]) {
        const distance = (x - lng) ** 2 + (y - lat) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = region;
        }
      }
    }
  }
  return best;
}

export function assignPhotosToRegions(
  regions: RegionFeature[],
  photos: GeoPhoto[],
): RegionIndex {
  const byRegion = new Map<string, GeoPhoto[]>();
  const byPath = new Map<string, string>();
  const byCoordinate = new Map<string, RegionFeature | null>();
  const byName = new Map<string, RegionFeature>();
  for (const region of regions)
    byName.set(`${region.kind}:${normalize(region.name)}`, region);

  for (const photo of photos) {
    const coordinateKey = `${photo.latitude.toFixed(4)},${photo.longitude.toFixed(4)}`;
    let region = byCoordinate.get(coordinateKey);
    if (region === undefined) {
      region = regionAt(regions, photo.latitude, photo.longitude);
      if (!region) {
        const inUs = /unitedstates/.test(normalize(photo.country));
        region =
          (inUs
            ? byName.get(`state:${normalize(photo.region)}`)
            : byName.get(`country:${normalize(photo.country)}`)) ??
          nearestRegion(regions, photo.latitude, photo.longitude);
      }
      byCoordinate.set(coordinateKey, region ?? null);
    }
    if (!region) continue;
    const list = byRegion.get(region.key) ?? [];
    list.push(photo);
    byRegion.set(region.key, list);
    byPath.set(photo.path, region.key);
  }
  return { byRegion, byPath };
}
