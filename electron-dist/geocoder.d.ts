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
export declare class Geocoder {
    private readonly cachePath;
    private readonly searchCachePath;
    private readonly cache;
    private readonly searchCache;
    private requestChain;
    private lastRequestTime;
    constructor(userDataPath: string, indexStoragePath?: string);
    initialize(): Promise<void>;
    search(query: string): Promise<GeocodedLocation[]>;
    reverse(latitude: number, longitude: number): Promise<GeocodedPlace | null>;
    private waitForRateLimit;
    private requestHeaders;
    private persist;
    private persistSearchCache;
}
