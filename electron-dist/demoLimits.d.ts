export declare const DEMO_LIMITS: {
    readonly sources: 2;
    readonly files: 1000;
    readonly digitalFolders: 5;
    readonly memoryPreviews: 5;
    readonly people: 3;
    readonly mapDestinations: 100;
    readonly mapPhotos: 1000;
    readonly duplicateDeletes: 100;
};
export type DemoLimitFeature = keyof typeof DEMO_LIMITS;
export declare function hasFullAccess(lifetimeLicensed: boolean, demoModeOverride: boolean): boolean;
export interface DemoSource {
    rootPath: string;
    enabled: boolean;
    available: boolean;
    message: string;
    demoLocked?: boolean;
}
export declare function applyDemoSourceLimit<T extends DemoSource>(sources: readonly T[], isLicensed: boolean, limit: number): T[];
export declare function isDemoLimitReached(isLicensed: boolean, used: number, limit: number): boolean;
export declare function selectDemoFilePaths<T extends {
    path: string;
    sourcePath: string;
    type?: string;
}>(records: readonly T[], sourcePaths: readonly string[], limit: number | null, typeCounts?: Readonly<Record<string, number>>): Set<string>;
export declare function formatDemoFileSample(selectedCounts: Readonly<Record<string, number>>, sourceCounts: Readonly<Record<string, number>>): string;
export interface DemoMapPhoto {
    path: string;
    locationLabel?: string | null;
    city?: string | null;
    region?: string | null;
    country?: string | null;
    latitude: number;
    longitude: number;
}
export declare function getDemoDestinationKey(photo: DemoMapPhoto): string;
export declare function selectDemoMapPhotos<T extends DemoMapPhoto>(photos: readonly T[], isLicensed: boolean, photoLimit: number, destinationLimit: number): T[];
export declare function selectDemoPeople<T>(people: readonly T[], isLicensed: boolean, limit: number): T[];
export declare function selectDemoDeletionBatch<T>(items: readonly T[], isLicensed: boolean, alreadyDeleted: number, limit: number): T[];
