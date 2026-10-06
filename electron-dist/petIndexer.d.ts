import { SemanticIndexer } from "./semanticIndexer";
export interface PetCluster {
    id: string;
    name: string;
    centroid: number[];
    photoCount: number;
    coverPhotoPath: string | null;
}
export interface PetIndexProgress {
    status: "idle" | "loading-model" | "clustering" | "paused" | "complete" | "error";
    total: number;
    processed: number;
    remaining: number;
    clusters: number;
    errors: number;
    currentFile: string | null;
    message: string;
}
export declare class PetIndexer {
    private indexPath;
    private dataPath;
    private progress;
    private records;
    private clusters;
    private isRunning;
    private isPaused;
    private semanticIndexer;
    private vectorsBuffer;
    private onProgress?;
    private semanticIndexPath;
    private lastProgressEmit;
    private lastProgressStatus;
    constructor(userDataPath: string, semanticIndexPath: string, semanticIndexer: SemanticIndexer);
    getProgress(): PetIndexProgress;
    getClusters(): PetCluster[];
    getClusterPhotos(clusterId: string): string[];
    initialize(): Promise<void>;
    start(onProgress?: (progress: PetIndexProgress) => void, sourcePaths?: string[]): Promise<void>;
    private clusterImages;
    private calculateCentroid;
    private cosineSimilarity;
    pause(): void;
    renamePetGroup(clusterId: string, name: string): Promise<void>;
    private save;
    private notifyProgress;
}
