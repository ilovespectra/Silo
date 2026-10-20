import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import * as exifr from "exifr";
import { IndexableFile } from "./semanticIndexer";
import type { GeoOverride } from "./stateStore";
import {
  inferBorrowedLocations,
  type BorrowedLocationConfidence,
} from "./borrowedLocationInference";

const execFileAsync = promisify(execFile);

export interface GeoPhoto extends IndexableFile {
  sourcePath: string;
  latitude: number;
  longitude: number;
  city: string | null;
  region: string | null;
  country: string | null;
  locationLabel: string;
  locationSource: "embedded" | "manual" | "inferred";
  captureTime?: number | null;
  inferenceConfidence?: BorrowedLocationConfidence;
  inferenceReferenceCount?: number;
  inferenceTimeOffsetMs?: number;
}

export interface GeoIndexState {
  status: "idle" | "scanning" | "paused" | "complete" | "error";
  scanned: number;
  total: number;
  geotagged: number;
  message: string;
  photos: GeoPhoto[];
  photosVersion: number;
  borrowedLocationsEnabled: boolean;
  inferenceWindowMinutes: number;
  inferenceSummary: { high: number; medium: number; low: number };
}

export type GeoIndexStatus = Omit<GeoIndexState, "photos">;

function pathIsUnderSource(filePath: string, sourcePath: string) {
  if (sourcePath.startsWith("/__"))
    return filePath === sourcePath || filePath.startsWith(`${sourcePath}/`);
  const relative = path.relative(path.resolve(sourcePath), path.resolve(filePath));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

interface GeoCacheEntry {
  path: string;
  signature: string;
  photo: GeoPhoto | null;
  captureTime?: number | null;
  cameraKey?: string | null;
  dismissedInference?: boolean;
}

interface CachedPhotoTime {
  captureTime: number | null;
  cameraKey: string | null;
  dismissedInference: boolean;
}

type ProgressListener = (state: GeoIndexStatus) => void;

export class GeoIndexer {
  private readonly cachePath: string;
  private readonly onProgress: ProgressListener;
  private readonly photos = new Map<string, GeoPhoto>();
  private readonly inferredPhotos = new Map<string, GeoPhoto>();
  private readonly photoTimes = new Map<string, CachedPhotoTime>();
  private readonly checkedSignatures = new Map<string, string>();
  private readonly invalidRetryPaths = new Set<string>();
  private overrides = new Map<string, GeoOverride>();
  private activeSources = new Set<string>();
  private runPromise: Promise<void> | null = null;
  private rerunRequested = false;
  private pauseRequested = false;
  private latestImages: IndexableFile[] = [];
  private latestImagesByPath = new Map<string, IndexableFile>();
  private borrowedLocationsEnabled = true;
  private inferenceWindowMinutes = 15;
  private photosVersion = 0;
  private cacheAppends = 0;
  private state: Omit<GeoIndexState, "photos" | "photosVersion"> = {
    status: "idle",
    scanned: 0,
    total: 0,
    geotagged: 0,
    message: "Waiting for CLIP-indexed photos.",
    borrowedLocationsEnabled: true,
    inferenceWindowMinutes: 15,
    inferenceSummary: { high: 0, medium: 0, low: 0 },
  };

  constructor(
    userDataPath: string,
    onProgress: ProgressListener,
    indexStoragePath: string = userDataPath,
    private readonly resolveImagePath: (filePath: string) => Promise<string> = async (filePath) => filePath,
  ) {
    this.cachePath = path.join(indexStoragePath, "geo-index.jsonl");
    this.onProgress = onProgress;
  }

  async initialize() {
    let lineCount = 0;
    try {
      await fsPromises.access(this.cachePath);
    } catch {
      await fsPromises.writeFile(this.cachePath, "");
      return;
    }
    // Streamed so the main process keeps servicing the UI while 40MB+ of cache loads.
    const lines = readline.createInterface({
      input: fs.createReadStream(this.cachePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      lineCount += 1;
      let parsed: GeoCacheEntry | GeoPhoto;
      try {
        parsed = JSON.parse(line) as GeoCacheEntry | GeoPhoto;
      } catch {
        continue;
      }
      if ("photo" in parsed) {
        const entry = parsed as GeoCacheEntry;
        const hasCachedTime = Object.prototype.hasOwnProperty.call(
          entry,
          "captureTime",
        );
        if (hasCachedTime) {
          this.photoTimes.set(entry.path, {
            captureTime: Number.isFinite(entry.captureTime)
              ? Number(entry.captureTime)
              : null,
            cameraKey: typeof entry.cameraKey === "string" ? entry.cameraKey : null,
            dismissedInference: entry.dismissedInference === true,
          });
        } else {
          // Older caches never kept capture times; re-read only those files once.
          this.invalidRetryPaths.add(entry.path);
        }
        if (
          !entry.photo ||
          this.validCoordinates(entry.photo.latitude, entry.photo.longitude)
        )
          this.checkedSignatures.set(entry.path, entry.signature);
        if (
          entry.photo &&
          this.validCoordinates(entry.photo.latitude, entry.photo.longitude)
        ) {
          this.photos.set(entry.path, entry.photo);
          if (hasCachedTime) this.invalidRetryPaths.delete(entry.path);
          else this.invalidRetryPaths.add(entry.path);
        } else if (entry.photo) this.invalidRetryPaths.add(entry.path);
        else this.photos.delete(entry.path);
      } else {
        const photo = parsed as GeoPhoto;
        if (this.validCoordinates(photo.latitude, photo.longitude)) {
          this.photos.set(photo.path, photo);
          this.checkedSignatures.set(photo.path, this.signature(photo));
          this.photoTimes.set(photo.path, {
            captureTime: Number.isFinite(photo.captureTime)
              ? Number(photo.captureTime)
              : null,
            cameraKey: null,
            dismissedInference: false,
          });
          if (!Number.isFinite(photo.captureTime))
            this.invalidRetryPaths.add(photo.path);
        } else this.invalidRetryPaths.add(photo.path);
      }
    }
    this.photosVersion += 1;
    this.state.geotagged = this.photos.size;
    this.state.status = "complete";
    this.state.scanned = this.checkedSignatures.size;
    this.state.total = this.checkedSignatures.size;
    this.state.message = `${this.photos.size.toLocaleString()} geotagged photos cached.`;
    const liveEntries =
      this.checkedSignatures.size + this.invalidRetryPaths.size;
    if (lineCount > liveEntries * 1.05 + 100) void this.compact();
  }

  // Rewrites the append-only cache to one line per file so the next launch reads less.
  private async compact() {
    const temporaryPath = `${this.cachePath}.compact`;
    const appendsAtStart = this.cacheAppends;
    const output = fs.createWriteStream(temporaryPath, { encoding: "utf8" });
    try {
      for (const [filePath, signature] of this.checkedSignatures) {
        const cachedTime = this.photoTimes.get(filePath);
        const entry: GeoCacheEntry = {
          path: filePath,
          signature,
          photo: this.photos.get(filePath) ?? null,
          captureTime: cachedTime?.captureTime ?? null,
          cameraKey: cachedTime?.cameraKey ?? null,
          dismissedInference: cachedTime?.dismissedInference ?? false,
        };
        if (!output.write(`${JSON.stringify(entry)}\n`))
          await new Promise<void>((resolve) =>
            output.once("drain", () => resolve()),
          );
      }
      await new Promise<void>((resolve, reject) =>
        output.end((error?: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
      if (this.cacheAppends !== appendsAtStart) {
        await fsPromises.rm(temporaryPath, { force: true });
        return;
      }
      await fsPromises.rename(temporaryPath, this.cachePath);
    } catch {
      output.destroy();
      await fsPromises.rm(temporaryPath, { force: true });
    }
  }

  getStatus(): GeoIndexStatus {
    let manualOnly = 0;
    for (const filePath of this.overrides.keys())
      if (!this.photos.has(filePath)) manualOnly += 1;
    return {
      ...this.state,
      geotagged:
        this.photos.size +
        (this.borrowedLocationsEnabled ? this.inferredPhotos.size : 0) +
        manualOnly,
      photosVersion: this.photosVersion,
    };
  }

  getRetryableCount() {
    return this.invalidRetryPaths.size;
  }

  hasLocation(filePath: string) {
    return (
      this.overrides.has(filePath) ||
      this.photos.has(filePath) ||
      (this.borrowedLocationsEnabled && this.inferredPhotos.has(filePath))
    );
  }

  locationLabel(filePath: string): string | null {
    const override = this.overrides.get(filePath);
    if (override)
      return (
        override.location.label ||
        [
          override.location.city,
          override.location.region,
          override.location.country,
        ]
          .filter(Boolean)
          .join(", ") ||
        null
      );
    const photo = this.photos.get(filePath) ?? this.inferredPhotos.get(filePath);
    if (!photo) return null;
    return (
      photo.locationLabel ||
      [photo.city, photo.region, photo.country].filter(Boolean).join(", ") ||
      `${photo.latitude.toFixed(4)}, ${photo.longitude.toFixed(4)}`
    );
  }

  /** Find tagged photos by saved place names without cloning the full geo index. */
  searchPhotosByLocationName(matchesName: (name: string) => boolean): GeoPhoto[] {
    const mergedPhotos = this.mergedPhotos();
    for (const override of this.overrides.values())
      mergedPhotos.set(override.file.path, {
        ...override.file,
        latitude: override.location.latitude,
        longitude: override.location.longitude,
        city: override.location.city,
        region: override.location.region,
        country: override.location.country,
        locationLabel: override.location.label,
        locationSource: "manual",
      });

    return Array.from(mergedPhotos.values()).filter((photo) => {
      if (this.activeSources.size > 0 && !this.activeSources.has(photo.sourcePath)) return false;
      const names = [photo.locationLabel, photo.city, photo.region, photo.country]
        .flatMap((value) => typeof value === "string" ? value.split(/[,;|\n]+/) : [])
        .map((value) => value.trim()).filter(Boolean);
      return names.some(matchesName);
    });
  }

  getState(): GeoIndexState {
    const mergedPhotos = this.mergedPhotos();
    for (const override of this.overrides.values()) {
      mergedPhotos.set(override.file.path, {
        ...override.file,
        latitude: override.location.latitude,
        longitude: override.location.longitude,
        city: override.location.city,
        region: override.location.region,
        country: override.location.country,
        locationLabel: override.location.label,
        locationSource: "manual",
      });
    }
    const photos = Array.from(mergedPhotos.values()).filter(
      (photo) =>
        this.activeSources.size === 0 ||
        this.activeSources.has(photo.sourcePath),
    );
    return {
      ...this.state,
      geotagged: photos.length,
      photosVersion: this.photosVersion,
      borrowedLocationsEnabled: this.borrowedLocationsEnabled,
      inferenceWindowMinutes: this.inferenceWindowMinutes,
      inferenceSummary: this.inferenceSummaryFor(photos),
      photos,
    };
  }

  setOverrides(overrides: Record<string, GeoOverride>) {
    this.overrides = new Map(Object.entries(overrides));
    this.rebuildInferredLocations();
    this.photosVersion += 1;
    this.emit();
  }

  setBorrowedLocationsEnabled(enabled: boolean) {
    this.borrowedLocationsEnabled = enabled;
    this.rebuildInferredLocations();
    this.photosVersion += 1;
    this.emit();
  }

  setInferenceWindowMinutes(windowMinutes: number) {
    this.inferenceWindowMinutes = [5, 15, 30, 60].includes(windowMinutes)
      ? windowMinutes
      : 15;
    this.rebuildInferredLocations();
    this.photosVersion += 1;
    this.emit();
  }

  async dismissBorrowedLocation(filePath: string) {
    if (!this.inferredPhotos.has(filePath)) return this.getState();
    const cachedTime = this.photoTimes.get(filePath);
    const signature = this.checkedSignatures.get(filePath);
    if (cachedTime && signature) {
      cachedTime.dismissedInference = true;
      const entry: GeoCacheEntry = {
        path: filePath,
        signature,
        photo: this.photos.get(filePath) ?? null,
        captureTime: cachedTime.captureTime,
        cameraKey: cachedTime.cameraKey,
        dismissedInference: true,
      };
      await fsPromises.appendFile(this.cachePath, `${JSON.stringify(entry)}\n`);
      this.cacheAppends += 1;
    }
    this.inferredPhotos.delete(filePath);
    this.photosVersion += 1;
    this.recountInferenceSummary();
    this.emit();
    return this.getState();
  }

  private mergedPhotos() {
    const mergedPhotos = new Map(this.photos);
    if (this.borrowedLocationsEnabled)
      for (const [filePath, photo] of this.inferredPhotos)
        if (!this.overrides.has(filePath)) mergedPhotos.set(filePath, photo);
    return mergedPhotos;
  }

  private inferenceSummaryFor(photos: GeoPhoto[]) {
    const summary = { high: 0, medium: 0, low: 0 };
    for (const photo of photos) {
      if (photo.locationSource === "inferred" && photo.inferenceConfidence)
        summary[photo.inferenceConfidence] += 1;
    }
    return summary;
  }

  private recountInferenceSummary() {
    this.state.inferenceSummary = this.inferenceSummaryFor(
      Array.from(this.inferredPhotos.values()),
    );
  }

  private rebuildInferredLocations() {
    this.inferredPhotos.clear();
    if (this.borrowedLocationsEnabled) {
      const activePaths = new Set(this.latestImages.map((image) => image.path));
      const references = Array.from(this.photos.values()).flatMap((photo) => {
        const captureTime = this.photoTimes.get(photo.path)?.captureTime;
        if (!Number.isFinite(captureTime) || !activePaths.has(photo.path))
          return [];
        return [{
          path: photo.path,
          captureTime: Number(captureTime),
          latitude: photo.latitude,
          longitude: photo.longitude,
        }];
      });
      const targets = this.latestImages.flatMap((image) => {
        const cachedTime = this.photoTimes.get(image.path);
        if (
          this.photos.has(image.path) ||
          this.overrides.has(image.path) ||
          !cachedTime ||
          cachedTime.dismissedInference ||
          !Number.isFinite(cachedTime.captureTime)
        )
          return [];
        return [{
          path: image.path,
          captureTime: Number(cachedTime.captureTime),
          cameraKey: cachedTime.cameraKey,
        }];
      });
      const suggestions = inferBorrowedLocations([...references, ...targets], {
        windowMinutes: this.inferenceWindowMinutes,
      });
      for (const suggestion of suggestions) {
        const image = this.latestImagesByPath.get(suggestion.path);
        if (!image) continue;
        this.inferredPhotos.set(suggestion.path, {
          ...image,
          isDirectory: false,
          type: "image",
          sourcePath: this.findSource(image.path),
          latitude: suggestion.latitude,
          longitude: suggestion.longitude,
          city: null,
          region: null,
          country: null,
          locationLabel: `${suggestion.latitude.toFixed(4)}°, ${suggestion.longitude.toFixed(4)}°`,
          locationSource: "inferred",
          captureTime: this.photoTimes.get(suggestion.path)?.captureTime ?? null,
          inferenceConfidence: suggestion.confidence,
          inferenceReferenceCount: suggestion.referenceCount,
          inferenceTimeOffsetMs: suggestion.timeOffsetMs,
        });
      }
    }
    this.recountInferenceSummary();
  }

  start(images: IndexableFile[], sourcePaths: string[]) {
    this.pauseRequested = false;
    const nextSources = [...new Set(sourcePaths)];
    if (
      nextSources.some((sourcePath) => !this.activeSources.has(sourcePath)) ||
      nextSources.length !== this.activeSources.size
    )
      this.photosVersion += 1;
    this.activeSources = new Set(nextSources);
    this.pauseRequested = false;
    this.latestImages = images
      .filter((image) => nextSources.some((root) => pathIsUnderSource(image.path, root)))
      .sort((first, second) => {
        const retryDifference =
          Number(this.invalidRetryPaths.has(second.path)) -
          Number(this.invalidRetryPaths.has(first.path));
        return retryDifference || first.modified - second.modified;
      });
    this.latestImagesByPath = new Map(
      this.latestImages.map((image) => [image.path, image]),
    );
    if (this.runPromise) {
      this.rerunRequested = true;
      return this.runPromise;
    }
    this.runPromise = this.run().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  async pause() {
    this.pauseRequested = true;
    const activeRun = this.runPromise;
    if (activeRun) {
      await activeRun;
      return;
    }
    this.update({ status: "paused", message: "Location indexing paused." });
  }

  private async run() {
    try {
      do {
        if (this.pauseRequested) break;
        this.rerunRequested = false;
        const pending = this.latestImages.filter(
          (image) =>
            this.checkedSignatures.get(image.path) !== this.signature(image) ||
            this.invalidRetryPaths.has(image.path),
        );
        if (pending.length === 0) {
          this.rebuildInferredLocations();
          this.photosVersion += 1;
          this.update({
            status: "complete",
            scanned: this.latestImages.length,
            total: this.latestImages.length,
            message: this.borrowedLocationsEnabled
              ? `${this.photos.size.toLocaleString()} GPS photos and ${this.inferredPhotos.size.toLocaleString()} inferred locations ready.`
              : `${this.photos.size.toLocaleString()} geotagged photos ready.`,
          });
          continue;
        }
        this.update({
          status: "scanning",
          scanned: 0,
          total: pending.length,
          message: `Reading embedded GPS data from ${pending.length.toLocaleString()} CLIP-indexed photos...`,
        });

        for (let index = 0; index < pending.length; index += 1) {
          if (this.pauseRequested) break;
          const image = pending[index];
          const result = await this.readPhoto(
            image,
            this.findSource(image.path),
          );
          const photo = result.photo;
          const entry: GeoCacheEntry = {
            path: image.path,
            signature: this.signature(image),
            photo,
            captureTime: result.captureTime,
            cameraKey: result.cameraKey,
            dismissedInference: false,
          };
          this.checkedSignatures.set(entry.path, entry.signature);
          this.photoTimes.set(entry.path, {
            captureTime: result.captureTime,
            cameraKey: result.cameraKey,
            dismissedInference: false,
          });
          this.invalidRetryPaths.delete(entry.path);
          if (photo) this.photos.set(photo.path, photo);
          else this.photos.delete(entry.path);
          if (photo) this.photosVersion += 1;
          await fsPromises.appendFile(
            this.cachePath,
            `${JSON.stringify(entry)}\n`,
          );
          this.cacheAppends += 1;
          this.state.scanned = index + 1;
          this.state.geotagged = this.photos.size;
          if (index % 10 === 9 || index === pending.length - 1) {
            this.state.message = `Mapped ${this.photos.size.toLocaleString()} photos · ${this.state.scanned.toLocaleString()} of ${pending.length.toLocaleString()} checked`;
            this.emit();
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
        }
      } while (this.rerunRequested && !this.pauseRequested);

      if (this.pauseRequested) {
        this.update({ status: "paused", message: "Location indexing paused." });
        return;
      }
      this.rebuildInferredLocations();
      this.photosVersion += 1;
      this.update({
        status: "complete",
        message: this.borrowedLocationsEnabled
          ? `${this.photos.size.toLocaleString()} GPS photos and ${this.inferredPhotos.size.toLocaleString()} inferred locations ready.`
          : `${this.photos.size.toLocaleString()} geotagged photos ready.`,
      });
    } catch (error) {
      this.update({
        status: "error",
        message:
          error instanceof Error ? error.message : "Location indexing failed.",
      });
    }
  }

  private async readPhoto(
    image: IndexableFile,
    sourcePath: string,
  ): Promise<{
    photo: GeoPhoto | null;
    captureTime: number | null;
    cameraKey: string | null;
  }> {
    const localPath = await this.resolveImagePath(image.path);
    let latitude: number | null = null;
    let longitude: number | null = null;
    let city: string | null = null;
    let region: string | null = null;
    let country: string | null = null;
    let captureTime: number | null = null;
    let cameraKey: string | null = null;

    try {
      const gps = await exifr.gps(localPath);
      if (
        gps &&
        Number.isFinite(gps.latitude) &&
        Number.isFinite(gps.longitude)
      ) {
        latitude = gps.latitude;
        longitude = gps.longitude;
      }
    } catch {
      // A missing or malformed GPS block must not prevent reading capture time.
    }

    try {
      const metadata = (await exifr.parse(localPath, {
        pick: [
          "GPSLatitude",
          "GPSLatitudeRef",
          "GPSLongitude",
          "GPSLongitudeRef",
          "City",
          "Sub-location",
          "Province-State",
          "State",
          "Country-PrimaryLocationName",
          "Country",
          "DateTimeOriginal",
          "CreateDate",
          "DateTimeDigitized",
          "Make",
          "Model",
        ],
        translateValues: false,
        reviveValues: false,
      })) as Record<string, unknown> | undefined;
      if (!this.validCoordinates(latitude ?? NaN, longitude ?? NaN)) {
        const repaired = this.repairMalformedGps(metadata);
        if (repaired) {
          latitude = repaired.latitude;
          longitude = repaired.longitude;
        }
      }
      city = this.firstString(metadata, ["City", "Sub-location"]);
      region = this.firstString(metadata, ["Province-State", "State"]);
      country = this.firstString(metadata, [
        "Country-PrimaryLocationName",
        "Country",
      ]);
      captureTime = this.captureTime(metadata);
      const make = this.firstString(metadata, ["Make"]);
      const model = this.firstString(metadata, ["Model"]);
      cameraKey = [make, model]
        .filter(Boolean)
        .join(" ")
        .trim()
        .toLowerCase() || null;
    } catch {
      // Keep any usable GPS data while allowing inference when metadata parsing fails.
    }

    if (
      (latitude === null || longitude === null) &&
      process.platform === "darwin"
    ) {
      try {
        const { stdout } = await execFileAsync("mdls", [
          "-name",
          "kMDItemLatitude",
          "-name",
          "kMDItemLongitude",
          "-name",
          "kMDItemCity",
          "-name",
          "kMDItemStateOrProvince",
          "-name",
          "kMDItemCountry",
          localPath,
        ]);
        latitude = this.numberField(stdout, "kMDItemLatitude");
        longitude = this.numberField(stdout, "kMDItemLongitude");
        city ||= this.stringField(stdout, "kMDItemCity");
        region ||= this.stringField(stdout, "kMDItemStateOrProvince");
        country ||= this.stringField(stdout, "kMDItemCountry");
      } catch {
        return { photo: null, captureTime, cameraKey };
      }
    }

    if (
      latitude === null ||
      longitude === null ||
      !this.validCoordinates(latitude, longitude)
    )
      return { photo: null, captureTime, cameraKey };
    const place = [city, region, country].filter(Boolean).join(", ");
    return {
      captureTime,
      cameraKey,
      photo: {
        ...image,
        isDirectory: false,
        type: "image",
        sourcePath,
        latitude,
        longitude,
        city,
        region,
        country,
        locationLabel:
          place || `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`,
        locationSource: "embedded",
        captureTime,
      },
    };
  }

  private captureTime(metadata: Record<string, unknown> | undefined) {
    if (!metadata) return null;
    for (const key of ["DateTimeOriginal", "CreateDate", "DateTimeDigitized"]) {
      const value = metadata[key];
      const timestamp =
        value instanceof Date
          ? value.getTime()
          : typeof value === "string"
            ? Date.parse(value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"))
            : NaN;
      if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
    }
    return null;
  }

  private findSource(filePath: string): string {
    return (
      Array.from(this.activeSources)
        .filter((sourcePath) => pathIsUnderSource(filePath, sourcePath))
        .sort((first, second) => second.length - first.length)[0] ??
      path.dirname(filePath)
    );
  }

  private firstString(
    metadata: Record<string, unknown> | undefined,
    keys: string[],
  ): string | null {
    if (!metadata) return null;
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  private numberField(output: string, key: string): number | null {
    const match = output.match(
      new RegExp(`^${key}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)$`, "m"),
    );
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  private stringField(output: string, key: string): string | null {
    const match = output.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
    if (!match || match[1] === "(null)") return null;
    return match[1].replace(/^"|"$/g, "").trim() || null;
  }

  private signature(image: Pick<IndexableFile, "size" | "modified">) {
    return `${image.size}:${image.modified}`;
  }

  private validCoordinates(latitude: number, longitude: number) {
    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180 &&
      !(Math.abs(latitude) < 0.000001 && Math.abs(longitude) < 0.000001)
    );
  }

  private repairMalformedGps(metadata: Record<string, unknown> | undefined) {
    if (!metadata) return null;
    const latitude = this.dmsCoordinate(
      metadata.GPSLatitude,
      metadata.GPSLatitudeRef,
    );
    const longitude = this.dmsCoordinate(
      metadata.GPSLongitude,
      metadata.GPSLongitudeRef,
    );
    if (
      latitude === null ||
      longitude === null ||
      !this.validCoordinates(latitude, longitude)
    )
      return null;
    return { latitude, longitude };
  }

  private dmsCoordinate(value: unknown, reference: unknown): number | null {
    if (
      !Array.isArray(value) &&
      !(value instanceof Uint16Array) &&
      !(value instanceof Uint32Array)
    )
      return null;
    const parts = Array.from(value as ArrayLike<number>, Number);
    if (parts.length < 2 || parts.some((part) => !Number.isFinite(part)))
      return null;
    const degrees = parts[0];
    let minutes = parts[1];
    let seconds = parts[2] ?? 0;
    if (minutes >= 60 && minutes < 6000) minutes /= 100;
    if (seconds >= 60 && seconds < 6000) seconds /= 100;
    if (minutes >= 60 || seconds >= 60) return null;
    let coordinate = degrees + minutes / 60 + seconds / 3600;
    const direction =
      typeof reference === "string" ? reference.toUpperCase() : "";
    if (direction === "S" || direction === "W") coordinate *= -1;
    return coordinate;
  }

  private update(
    update: Partial<Omit<GeoIndexState, "photos" | "photosVersion">>,
  ) {
    this.state = { ...this.state, ...update };
    this.emit();
  }

  getCountrySummary(): Array<{
    country: string | null;
    countryCode: string | null;
    photoCount: number;
  }> {
    const countries = new Map<string, number>();
    const mergedPhotos = this.mergedPhotos();
    for (const override of this.overrides.values()) {
      mergedPhotos.set(override.file.path, {
        ...override.file,
        latitude: override.location.latitude,
        longitude: override.location.longitude,
        city: override.location.city,
        region: override.location.region,
        country: override.location.country,
        locationLabel: override.location.label,
        locationSource: "manual",
      });
    }

    for (const photo of mergedPhotos.values()) {
      if (
        !this.activeSources.size ||
        this.activeSources.has(photo.sourcePath)
      ) {
        const key = photo.country || "Unknown";
        countries.set(key, (countries.get(key) ?? 0) + 1);
      }
    }

    return Array.from(countries.entries())
      .map(([country, photoCount]) => ({
        country,
        countryCode: null,
        photoCount,
      }))
      .sort((a, b) => b.photoCount - a.photoCount);
  }

  getStateSummary(
    targetCountry: string | null,
  ): Array<{ state: string | null; photoCount: number }> {
    const states = new Map<string, number>();
    const mergedPhotos = this.mergedPhotos();
    for (const override of this.overrides.values()) {
      mergedPhotos.set(override.file.path, {
        ...override.file,
        latitude: override.location.latitude,
        longitude: override.location.longitude,
        city: override.location.city,
        region: override.location.region,
        country: override.location.country,
        locationLabel: override.location.label,
        locationSource: "manual",
      });
    }

    for (const photo of mergedPhotos.values()) {
      if (
        (!this.activeSources.size ||
          this.activeSources.has(photo.sourcePath)) &&
        photo.country === targetCountry
      ) {
        const key = photo.region || "Unknown";
        states.set(key, (states.get(key) ?? 0) + 1);
      }
    }

    return Array.from(states.entries())
      .map(([state, photoCount]) => ({
        state,
        photoCount,
      }))
      .sort((a, b) => b.photoCount - a.photoCount);
  }

  getPhotosByRegion(country: string | null, state?: string | null): GeoPhoto[] {
    const mergedPhotos = this.mergedPhotos();
    for (const override of this.overrides.values()) {
      mergedPhotos.set(override.file.path, {
        ...override.file,
        latitude: override.location.latitude,
        longitude: override.location.longitude,
        city: override.location.city,
        region: override.location.region,
        country: override.location.country,
        locationLabel: override.location.label,
        locationSource: "manual",
      });
    }

    return Array.from(mergedPhotos.values()).filter((photo) => {
      if (!this.activeSources.size || !this.activeSources.has(photo.sourcePath))
        return false;
      if (photo.country !== country) return false;
      if (state && photo.region !== state) return false;
      return true;
    });
  }

  private emit() {
    this.onProgress(this.getStatus());
  }
}
