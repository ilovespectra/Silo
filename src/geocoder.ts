import * as fsPromises from "fs/promises";
import * as path from "path";

export interface GeocodedPlace {
  label: string;
  countryCode: string | null;
}

export interface GeocodedLocation extends GeocodedPlace {
  id: string;
  latitude: number;
  longitude: number;
  city: string | null;
  region: string | null;
  country: string | null;
}

export class Geocoder {
  private readonly cachePath: string;
  private readonly searchCachePath: string;
  private readonly cache = new Map<string, GeocodedPlace>();
  private readonly searchCache = new Map<string, GeocodedLocation[]>();
  private requestChain = Promise.resolve();
  private lastRequestTime = 0;

  constructor(userDataPath: string, indexStoragePath: string = userDataPath) {
    this.cachePath = path.join(indexStoragePath, "geocode-cache.json");
    this.searchCachePath = path.join(indexStoragePath, "geocode-search-cache.json");
  }

  async initialize() {
    try {
      const entries = JSON.parse(
        await fsPromises.readFile(this.cachePath, "utf8"),
      ) as Record<string, GeocodedPlace>;
      for (const [key, value] of Object.entries(entries))
        this.cache.set(key, value);
    } catch {
      await this.persist();
    }
    try {
      const entries = JSON.parse(
        await fsPromises.readFile(this.searchCachePath, "utf8"),
      ) as Record<string, GeocodedLocation[]>;
      for (const [key, value] of Object.entries(entries)) {
        if (Array.isArray(value)) this.searchCache.set(key, value);
      }
    } catch {
      await this.persistSearchCache();
    }
  }

  search(query: string): Promise<GeocodedLocation[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return Promise.resolve([]);
    const cacheKey = `photon2:${normalized}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    const request = this.requestChain.then(async () => {
      await this.waitForRateLimit();
      const url = new URL("https://photon.komoot.io/api/");
      url.searchParams.set("q", query.trim());
      url.searchParams.set("limit", "7");
      url.searchParams.set("lang", "en");
      const response = await fetch(url, { headers: this.requestHeaders() });
      if (!response.ok) return [];
      const payload = (await response.json()) as { features?: any[] };
      const placeRank: Record<string, number> = {
        city: 0,
        municipality: 1,
        town: 2,
        village: 3,
        suburb: 4,
      };
      const features = [...(payload.features ?? [])].sort(
        (first, second) =>
          (placeRank[first.properties?.osm_value] ?? 10) -
          (placeRank[second.properties?.osm_value] ?? 10),
      );
      const results = features.flatMap((result): GeocodedLocation[] => {
        const longitude = Number(result.geometry?.coordinates?.[0]);
        const latitude = Number(result.geometry?.coordinates?.[1]);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
          return [];
        const properties = result.properties || {};
        const name =
          typeof properties.name === "string" ? properties.name : null;
        const city =
          properties.city || properties.locality || properties.district || name;
        const region = properties.state || properties.county || null;
        const country = properties.country || null;
        const conciseLabel = Array.from(
          new Set([name, region, country].filter(Boolean)),
        ).join(", ");
        return [
          {
            id: `${properties.osm_type || "place"}:${properties.osm_id || `${latitude},${longitude}`}`,
            label: conciseLabel || query.trim(),
            latitude,
            longitude,
            city,
            region,
            country,
            countryCode:
              typeof properties.countrycode === "string"
                ? properties.countrycode.toUpperCase()
                : null,
          },
        ];
      });
      this.searchCache.set(cacheKey, results);
      await this.persistSearchCache();
      return results;
    });
    this.requestChain = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  reverse(latitude: number, longitude: number): Promise<GeocodedPlace | null> {
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    )
      return Promise.resolve(null);
    const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);

    const request = this.requestChain.then(async () => {
      await this.waitForRateLimit();
      const url = new URL("https://nominatim.openstreetmap.org/reverse");
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("lat", String(latitude));
      url.searchParams.set("lon", String(longitude));
      url.searchParams.set("zoom", "10");
      url.searchParams.set("addressdetails", "1");
      const response = await fetch(url, { headers: this.requestHeaders() });
      if (!response.ok) return null;
      const result = (await response.json()) as any;
      const address = result.address || {};
      const locality =
        address.city ||
        address.town ||
        address.village ||
        address.suburb ||
        address.county;
      const region = address.state || address.region;
      const country = address.country;
      const label =
        [locality, region, country].filter(Boolean).join(", ") ||
        result.display_name;
      if (!label) return null;
      const place = {
        label,
        countryCode:
          typeof address.country_code === "string"
            ? address.country_code.toUpperCase()
            : null,
      };
      this.cache.set(key, place);
      await this.persist();
      return place;
    });
    this.requestChain = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  private async waitForRateLimit() {
    const delay = Math.max(0, 1100 - (Date.now() - this.lastRequestTime));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    this.lastRequestTime = Date.now();
  }

  private requestHeaders() {
    return {
      "User-Agent":
        "solo-silo-file-browser/1.0 (local desktop photo organizer)",
      "Accept-Language": "en",
    };
  }

  private async persist() {
    const temporaryPath = `${this.cachePath}.tmp`;
    await fsPromises.writeFile(
      temporaryPath,
      JSON.stringify(Object.fromEntries(this.cache), null, 2),
    );
    await fsPromises.rename(temporaryPath, this.cachePath);
  }

  private async persistSearchCache() {
    const temporaryPath = `${this.searchCachePath}.tmp`;
    await fsPromises.writeFile(
      temporaryPath,
      JSON.stringify(Object.fromEntries(this.searchCache), null, 2),
    );
    await fsPromises.rename(temporaryPath, this.searchCachePath);
  }
}
