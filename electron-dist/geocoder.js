"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Geocoder = void 0;
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
class Geocoder {
    constructor(userDataPath, indexStoragePath = userDataPath) {
        this.cache = new Map();
        this.searchCache = new Map();
        this.requestChain = Promise.resolve();
        this.lastRequestTime = 0;
        this.cachePath = path.join(indexStoragePath, "geocode-cache.json");
        this.searchCachePath = path.join(indexStoragePath, "geocode-search-cache.json");
    }
    async initialize() {
        try {
            const entries = JSON.parse(await fsPromises.readFile(this.cachePath, "utf8"));
            for (const [key, value] of Object.entries(entries))
                this.cache.set(key, value);
        }
        catch {
            await this.persist();
        }
        try {
            const entries = JSON.parse(await fsPromises.readFile(this.searchCachePath, "utf8"));
            for (const [key, value] of Object.entries(entries)) {
                if (Array.isArray(value))
                    this.searchCache.set(key, value);
            }
        }
        catch {
            await this.persistSearchCache();
        }
    }
    search(query) {
        const normalized = query.trim().toLowerCase();
        if (normalized.length < 2)
            return Promise.resolve([]);
        const cacheKey = `photon2:${normalized}`;
        const cached = this.searchCache.get(cacheKey);
        if (cached)
            return Promise.resolve(cached);
        const request = this.requestChain.then(async () => {
            await this.waitForRateLimit();
            const url = new URL("https://photon.komoot.io/api/");
            url.searchParams.set("q", query.trim());
            url.searchParams.set("limit", "7");
            url.searchParams.set("lang", "en");
            const response = await fetch(url, { headers: this.requestHeaders() });
            if (!response.ok)
                return [];
            const payload = (await response.json());
            const placeRank = {
                city: 0,
                municipality: 1,
                town: 2,
                village: 3,
                suburb: 4,
            };
            const features = [...(payload.features ?? [])].sort((first, second) => (placeRank[first.properties?.osm_value] ?? 10) -
                (placeRank[second.properties?.osm_value] ?? 10));
            const results = features.flatMap((result) => {
                const longitude = Number(result.geometry?.coordinates?.[0]);
                const latitude = Number(result.geometry?.coordinates?.[1]);
                if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
                    return [];
                const properties = result.properties || {};
                const name = typeof properties.name === "string" ? properties.name : null;
                const city = properties.city || properties.locality || properties.district || name;
                const region = properties.state || properties.county || null;
                const country = properties.country || null;
                const conciseLabel = Array.from(new Set([name, region, country].filter(Boolean))).join(", ");
                return [
                    {
                        id: `${properties.osm_type || "place"}:${properties.osm_id || `${latitude},${longitude}`}`,
                        label: conciseLabel || query.trim(),
                        latitude,
                        longitude,
                        city,
                        region,
                        country,
                        countryCode: typeof properties.countrycode === "string"
                            ? properties.countrycode.toUpperCase()
                            : null,
                    },
                ];
            });
            this.searchCache.set(cacheKey, results);
            await this.persistSearchCache();
            return results;
        });
        this.requestChain = request.then(() => undefined, () => undefined);
        return request;
    }
    reverse(latitude, longitude) {
        if (!Number.isFinite(latitude) ||
            latitude < -90 ||
            latitude > 90 ||
            !Number.isFinite(longitude) ||
            longitude < -180 ||
            longitude > 180)
            return Promise.resolve(null);
        const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
        const cached = this.cache.get(key);
        if (cached)
            return Promise.resolve(cached);
        const request = this.requestChain.then(async () => {
            await this.waitForRateLimit();
            const url = new URL("https://nominatim.openstreetmap.org/reverse");
            url.searchParams.set("format", "jsonv2");
            url.searchParams.set("lat", String(latitude));
            url.searchParams.set("lon", String(longitude));
            url.searchParams.set("zoom", "10");
            url.searchParams.set("addressdetails", "1");
            const response = await fetch(url, { headers: this.requestHeaders() });
            if (!response.ok)
                return null;
            const result = (await response.json());
            const address = result.address || {};
            const locality = address.city ||
                address.town ||
                address.village ||
                address.suburb ||
                address.county;
            const region = address.state || address.region;
            const country = address.country;
            const label = [locality, region, country].filter(Boolean).join(", ") ||
                result.display_name;
            if (!label)
                return null;
            const place = {
                label,
                countryCode: typeof address.country_code === "string"
                    ? address.country_code.toUpperCase()
                    : null,
            };
            this.cache.set(key, place);
            await this.persist();
            return place;
        });
        this.requestChain = request.then(() => undefined, () => undefined);
        return request;
    }
    async waitForRateLimit() {
        const delay = Math.max(0, 1100 - (Date.now() - this.lastRequestTime));
        if (delay > 0)
            await new Promise((resolve) => setTimeout(resolve, delay));
        this.lastRequestTime = Date.now();
    }
    requestHeaders() {
        return {
            "User-Agent": "solo-silo-file-browser/1.0 (local desktop photo organizer)",
            "Accept-Language": "en",
        };
    }
    async persist() {
        const temporaryPath = `${this.cachePath}.tmp`;
        await fsPromises.writeFile(temporaryPath, JSON.stringify(Object.fromEntries(this.cache), null, 2));
        await fsPromises.rename(temporaryPath, this.cachePath);
    }
    async persistSearchCache() {
        const temporaryPath = `${this.searchCachePath}.tmp`;
        await fsPromises.writeFile(temporaryPath, JSON.stringify(Object.fromEntries(this.searchCache), null, 2));
        await fsPromises.rename(temporaryPath, this.searchCachePath);
    }
}
exports.Geocoder = Geocoder;
