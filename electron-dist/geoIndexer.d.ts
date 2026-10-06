import { IndexableFile } from "./semanticIndexer";
import type { GeoOverride } from "./stateStore";
export interface GeoPhoto extends IndexableFile {
    sourcePath: string;
    latitude: number;
    longitude: number;
    city: string | null;
    region: string | null;
    country: string | null;
    locationLabel: string;
    locationSource: "embedded" | "manual";
}
export interface GeoIndexState {
    status: "idle" | "scanning" | "complete" | "error";
    scanned: number;
    total: number;
    geotagged: number;
    message: string;
    photos: GeoPhoto[];
    photosVersion: number;
}
export type GeoIndexStatus = Omit<GeoIndexState, "photos">;
type ProgressListener = (state: GeoIndexStatus) => void;
export declare class GeoIndexer {
    private readonly cachePath;
    private readonly onProgress;
    private readonly photos;
    private readonly checkedSignatures;
    private readonly invalidRetryPaths;
    private overrides;
    private activeSources;
    private runPromise;
    private rerunRequested;
    private latestImages;
    private photosVersion;
    private cacheAppends;
    private state;
    constructor(userDataPath: string, onProgress: ProgressListener, indexStoragePath?: string);
    initialize(): Promise<void>;
    private compact;
    getStatus(): GeoIndexStatus;
    getRetryableCount(): number;
    hasLocation(filePath: string): boolean;
    locationLabel(filePath: string): string | null;
    getState(): GeoIndexState;
    setOverrides(overrides: Record<string, GeoOverride>): void;
    start(images: IndexableFile[], sourcePaths: string[]): Promise<void>;
    private run;
    private readPhoto;
    private findSource;
    private firstString;
    private numberField;
    private stringField;
    private signature;
    private validCoordinates;
    private repairMalformedGps;
    private dmsCoordinate;
    private update;
    getCountrySummary(): Array<{
        country: string | null;
        countryCode: string | null;
        photoCount: number;
    }>;
    getStateSummary(targetCountry: string | null): Array<{
        state: string | null;
        photoCount: number;
    }>;
    getPhotosByRegion(country: string | null, state?: string | null): GeoPhoto[];
    private emit;
}
export {};
