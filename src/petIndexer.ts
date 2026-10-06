import * as fsPromises from "fs/promises";
import * as path from "path";
import { SemanticIndexer } from "./semanticIndexer";

export interface PetCluster {
  id: string;
  name: string;
  centroid: number[];
  photoCount: number;
  coverPhotoPath: string | null;
}

export interface PetIndexProgress {
  status:
    | "idle"
    | "loading-model"
    | "clustering"
    | "paused"
    | "complete"
    | "error";
  total: number;
  processed: number;
  remaining: number;
  clusters: number;
  errors: number;
  currentFile: string | null;
  message: string;
}

interface PetRecord {
  imagePath: string;
  vectorOffset: number;
  clusterId: string;
}

export class PetIndexer {
  private indexPath: string;
  private dataPath: string;
  private progress: PetIndexProgress = {
    status: "idle",
    total: 0,
    processed: 0,
    remaining: 0,
    clusters: 0,
    errors: 0,
    currentFile: null,
    message: "Ready to cluster animals.",
  };

  private records: PetRecord[] = [];
  private clusters: Map<string, PetCluster> = new Map();
  private isRunning = false;
  private isPaused = false;
  private semanticIndexer: SemanticIndexer;
  private vectorsBuffer: Float32Array | null = null;
  private onProgress?: (progress: PetIndexProgress) => void;
  private semanticIndexPath: string;
  private lastProgressEmit = 0;
  private lastProgressStatus = "";

  constructor(
    userDataPath: string,
    semanticIndexPath: string,
    semanticIndexer: SemanticIndexer,
  ) {
    this.semanticIndexPath = semanticIndexPath;
    this.indexPath = userDataPath;
    this.dataPath = path.join(this.indexPath, "pets");
    this.semanticIndexer = semanticIndexer;
  }

  getProgress(): PetIndexProgress {
    return this.progress;
  }

  getClusters(): PetCluster[] {
    return Array.from(this.clusters.values());
  }

  getClusterPhotos(clusterId: string): string[] {
    return this.records
      .filter((record) => record.clusterId === clusterId)
      .map((record) => record.imagePath);
  }

  async initialize(): Promise<void> {
    try {
      await fsPromises.mkdir(this.dataPath, { recursive: true });

      // Try to load existing clusters
      try {
        const recordsPath = path.join(this.dataPath, "clusters.jsonl");
        const content = await fsPromises.readFile(recordsPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        this.records = lines.map((line) => JSON.parse(line));

        const clustersPath = path.join(this.dataPath, "summary.json");
        const clusterData = await fsPromises.readFile(clustersPath, "utf-8");
        const clusters: PetCluster[] = JSON.parse(clusterData);
        this.clusters = new Map(clusters.map((c) => [c.id, c]));

        this.progress.status = "complete";
        this.progress.clusters = this.clusters.size;
        this.progress.message = `Found ${this.clusters.size} animal clusters.`;
      } catch {
        this.progress.status = "idle";
        this.progress.message = "Ready to cluster animals.";
      }
    } catch (error) {
      this.progress.status = "error";
      this.progress.message =
        error instanceof Error ? error.message : "Initialization failed.";
    }
  }

  async start(
    onProgress?: (progress: PetIndexProgress) => void,
    sourcePaths?: string[],
  ): Promise<void> {
    if (this.isRunning) return;
    this.onProgress = onProgress;
    this.isRunning = true;
    this.isPaused = false;
    this.records = [];
    this.progress.processed = 0;
    this.progress.errors = 0;

    try {
      this.progress.status = "clustering";
      this.progress.message = "Clustering animal images...";
      this.notifyProgress();

      // Load semantic records (which have vectorOffset)
      const recordsPath = path.join(this.semanticIndexPath, "records.jsonl");
      let semanticRecords: Array<{ path: string; vectorOffset: number }> = [];
      try {
        const content = await fsPromises.readFile(recordsPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        semanticRecords = lines
          .map((line) => {
            const record: any = JSON.parse(line);
            return { path: record.path, vectorOffset: record.vectorOffset };
          })
          .filter((record) => record.vectorOffset >= 0 && (!sourcePaths || sourcePaths.some((root) => {
            const relative = path.relative(root, record.path);
            return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
          })));
      } catch (error) {
        throw new Error(
          "Could not load semantic index records for clustering.",
        );
      }

      this.progress.total = semanticRecords.length;
      this.progress.remaining = semanticRecords.length;

      // Load vector data
      const vectorsPath = path.join(this.semanticIndexPath, "vectors.bin");
      try {
        const buffer = await fsPromises.readFile(vectorsPath);
        this.vectorsBuffer = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength / 4,
        );
      } catch {
        throw new Error("Could not load semantic vectors for clustering.");
      }

      // Cluster using simple k-means approach on existing semantic embeddings
      await this.clusterImages(semanticRecords);

      this.progress.status = this.isPaused ? "paused" : "complete";
      this.progress.message = this.isPaused
        ? "Pet clustering paused."
        : `Clustering complete. Found ${this.clusters.size} animal groups.`;
    } catch (error) {
      this.progress.status = "error";
      this.progress.message =
        error instanceof Error ? error.message : "Clustering failed.";
    } finally {
      this.isRunning = false;
      this.notifyProgress();
    }
  }

  private async clusterImages(
    semanticRecords: Array<{ path: string; vectorOffset: number }>,
  ): Promise<void> {
    const threshold = 0.6; // Cosine similarity threshold for clustering
    const clusters: Map<string, PetRecord[]> = new Map();

    for (const image of semanticRecords) {
      if (this.isPaused) break;

      this.progress.processed += 1;
      this.progress.remaining = Math.max(
        0,
        this.progress.total - this.progress.processed,
      );
      this.progress.currentFile = image.path;
      this.notifyProgress();

      if (!this.vectorsBuffer || image.vectorOffset < 0) {
        this.progress.errors += 1;
        continue;
      }

      // Get vector for this image
      const vectorStart = image.vectorOffset / Float32Array.BYTES_PER_ELEMENT;
      const vectorEnd = vectorStart + 512; // CLIP embeddings are 512-dim
      const vector = this.vectorsBuffer.subarray(vectorStart, vectorEnd);

      // Find best matching cluster or create new one
      let bestClusterId: string | null = null;
      let bestSimilarity = threshold;

      for (const [clusterId, clusterRecords] of clusters) {
        if (clusterRecords.length === 0) continue;

        // Calculate centroid similarity
        const clusterVector = this.calculateCentroid(clusterRecords);
        const similarity = this.cosineSimilarity(vector, clusterVector);

        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestClusterId = clusterId;
        }
      }

      // Add to best cluster or create new one
      if (!bestClusterId) {
        bestClusterId = `cluster-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        clusters.set(bestClusterId, []);
      }

      const record: PetRecord = {
        imagePath: image.path,
        vectorOffset: image.vectorOffset,
        clusterId: bestClusterId,
      };
      clusters.get(bestClusterId)!.push(record);
      this.records.push(record);
      if (this.progress.processed % 25 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Convert to persistent clusters and save
    this.clusters.clear();
    for (const [clusterId, records] of clusters) {
      if (records.length === 0) continue;

      const centroid = this.calculateCentroid(records);
      const cluster: PetCluster = {
        id: clusterId,
        name: `Animal Group ${this.clusters.size + 1}`,
        centroid,
        photoCount: records.length,
        coverPhotoPath: records[0].imagePath,
      };
      this.clusters.set(clusterId, cluster);
    }

    this.progress.clusters = this.clusters.size;
    await this.save();
  }

  private calculateCentroid(records: PetRecord[]): number[] {
    if (records.length === 0 || !this.vectorsBuffer)
      return new Array(512).fill(0);

    const sum = new Array(512).fill(0);
    for (const record of records) {
      const offset = record.vectorOffset / Float32Array.BYTES_PER_ELEMENT;
      const vector = this.vectorsBuffer.subarray(offset, offset + 512);
      for (let i = 0; i < 512; i++) {
        sum[i] += vector[i];
      }
    }

    // Normalize
    for (let i = 0; i < 512; i++) {
      sum[i] /= records.length;
    }

    return sum;
  }

  private cosineSimilarity(a: Float32Array | number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (normA * normB);
  }

  pause(): void {
    this.isPaused = true;
    this.progress.status = "paused";
    this.notifyProgress();
  }

  async renamePetGroup(clusterId: string, name: string): Promise<void> {
    const cluster = this.clusters.get(clusterId);
    if (cluster) {
      cluster.name = name;
      await this.save();
    }
  }

  private async save(): Promise<void> {
    try {
      // Save records as JSONL
      const recordsPath = path.join(this.dataPath, "clusters.jsonl");
      const recordsContent = this.records
        .map((r) => JSON.stringify(r))
        .join("\n");
      await fsPromises.writeFile(recordsPath, recordsContent, "utf-8");

      // Save cluster summary
      const clustersPath = path.join(this.dataPath, "summary.json");
      await fsPromises.writeFile(
        clustersPath,
        JSON.stringify(Array.from(this.clusters.values()), null, 2),
        "utf-8",
      );
    } catch (error) {
      console.error("Failed to save pet index:", error);
      throw error;
    }
  }

  private notifyProgress(): void {
    const now = Date.now();
    if (
      this.progress.status === this.lastProgressStatus &&
      now - this.lastProgressEmit < 500
    )
      return;
    this.lastProgressEmit = now;
    this.lastProgressStatus = this.progress.status;
    if (this.onProgress) {
      this.onProgress(this.progress);
    }
  }
}
