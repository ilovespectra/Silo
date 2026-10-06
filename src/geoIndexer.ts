import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import * as exifr from "exifr";
import { IndexableFile } from "./semanticIndexer";
import type { GeoOverride } from "./stateStore";

const execFileAsync = promisify(execFile);

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

interface GeoCacheEntry {
  path: string;
  signature: string;
  photo: GeoPhoto | null;
}

type ProgressListener = (state: GeoIndexStatus) => void;

export class GeoIndexer {
  private readonly cachePath: string;
  private readonly onProgress: ProgressListener;
  private readonly photos = new Map<string, GeoPhoto>();
  private readonly checkedSignatures = new Map<string, string>();
  private readonly invalidRetryPaths = new Set<string>();
  private overrides = new Map<string, GeoOverride>();
  private activeSources = new Set<string>();
  private runPromise: Promise<void> | null = null;
  private rerunRequested = false;
  private latestImages: IndexableFile[] = [];
  private photosVersion = 0;
  private cacheAppends = 0;
  private state: Omit<GeoIndexState, "photos" | "photosVersion"> = {
    status: "idle",
    scanned: 0,
    total: 0,
    geotagged: 0,
    message: "Waiting for CLIP-indexed photos.",
  };

  constructor(
    userDataPath: string,
    onProgress: ProgressListener,
    indexStoragePath: string = userDataPath,
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
        if (
          !parsed.photo ||
          this.validCoordinates(parsed.photo.latitude, parsed.photo.longitude)
        )
          this.checkedSignatures.set(parsed.path, parsed.signature);
        if (
          parsed.photo &&
          this.validCoordinates(parsed.photo.latitude, parsed.photo.longitude)
        ) {
          this.photos.set(parsed.path, parsed.photo);
          this.invalidRetryPaths.delete(parsed.path);
        } else if (parsed.photo) this.invalidRetryPaths.add(parsed.path);
        else this.photos.delete(parsed.path);
      } else {
        const photo = parsed as GeoPhoto;
        if (this.validCoordinates(photo.latitude, photo.longitude)) {
          this.photos.set(photo.path, photo);
          this.checkedSignatures.set(photo.path, this.signature(photo));
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
        const entry: GeoCacheEntry = {
          path: filePath,
          signature,
          photo: this.photos.get(filePath) ?? null,
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
      geotagged: this.photos.size + manualOnly,
      photosVersion: this.photosVersion,
    };
  }

  getRetryableCount() {
    return this.invalidRetryPaths.size;
  }

  hasLocation(filePath: string) {
    return this.overrides.has(filePath) || this.photos.has(filePath);
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
    const photo = this.photos.get(filePath);
    if (!photo) return null;
    return (
      photo.locationLabel ||
      [photo.city, photo.region, photo.country].filter(Boolean).join(", ") ||
      `${photo.latitude.toFixed(4)}, ${photo.longitude.toFixed(4)}`
    );
  }

  getState(): GeoIndexState {
    const mergedPhotos = new Map(this.photos);
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
    return {
      ...this.state,
      geotagged: mergedPhotos.size,
      photosVersion: this.photosVersion,
      photos: Array.from(mergedPhotos.values()).filter(
        (photo) =>
          this.activeSources.size === 0 ||
          this.activeSources.has(photo.sourcePath),
      ),
    };
  }

  setOverrides(overrides: Record<string, GeoOverride>) {
    this.overrides = new Map(Object.entries(overrides));
    this.photosVersion += 1;
    this.emit();
  }

  start(images: IndexableFile[], sourcePaths: string[]) {
    const nextSources = sourcePaths.filter(
      (sourcePath) => !sourcePath.startsWith("/__"),
    );
    const connectedSources = new Set(nextSources.map((sourcePath) => path.resolve(sourcePath)));
    if (
      nextSources.some((sourcePath) => !this.activeSources.has(sourcePath)) ||
      nextSources.length !== this.activeSources.size
    )
      this.photosVersion += 1;
    this.activeSources = new Set(nextSources);
    this.latestImages = images
      .filter((image) => !image.path.startsWith("/__") && Array.from(connectedSources).some((root) => {
        const relative = path.relative(root, path.resolve(image.path));
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      }))
      .sort((first, second) => {
        const retryDifference =
          Number(this.invalidRetryPaths.has(second.path)) -
          Number(this.invalidRetryPaths.has(first.path));
        return retryDifference || first.modified - second.modified;
      });
    if (this.runPromise) {
      this.rerunRequested = true;
      return this.runPromise;
    }
    this.runPromise = this.run().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  private async run() {
    try {
      do {
        this.rerunRequested = false;
        const pending = this.latestImages.filter(
          (image) =>
            this.checkedSignatures.get(image.path) !== this.signature(image),
        );
        if (pending.length === 0) {
          if (this.state.status !== "complete")
            this.update({
              status: "complete",
              scanned: this.latestImages.length,
              total: this.latestImages.length,
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
          const image = pending[index];
          const photo = await this.readPhoto(
            image,
            this.findSource(image.path),
          );
          const entry: GeoCacheEntry = {
            path: image.path,
            signature: this.signature(image),
            photo,
          };
          this.checkedSignatures.set(entry.path, entry.signature);
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
      } while (this.rerunRequested);

      this.update({
        status: "complete",
        message: `${this.photos.size.toLocaleString()} geotagged photos ready.`,
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
  ): Promise<GeoPhoto | null> {
    let latitude: number | null = null;
    let longitude: number | null = null;
    let city: string | null = null;
    let region: string | null = null;
    let country: string | null = null;

    try {
      const gps = await exifr.gps(image.path);
      if (
        gps &&
        Number.isFinite(gps.latitude) &&
        Number.isFinite(gps.longitude)
      ) {
        latitude = gps.latitude;
        longitude = gps.longitude;
      }
      const metadata = (await exifr.parse(image.path, {
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
    } catch {
      // Spotlight is a fallback for unusual containers.
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
          image.path,
        ]);
        latitude = this.numberField(stdout, "kMDItemLatitude");
        longitude = this.numberField(stdout, "kMDItemLongitude");
        city ||= this.stringField(stdout, "kMDItemCity");
        region ||= this.stringField(stdout, "kMDItemStateOrProvince");
        country ||= this.stringField(stdout, "kMDItemCountry");
      } catch {
        return null;
      }
    }

    if (
      latitude === null ||
      longitude === null ||
      !this.validCoordinates(latitude, longitude)
    )
      return null;
    const place = [city, region, country].filter(Boolean).join(", ");
    return {
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
    };
  }

  private findSource(filePath: string): string {
    return (
      Array.from(this.activeSources)
        .filter(
          (sourcePath) =>
            filePath === sourcePath ||
            filePath.startsWith(`${sourcePath}${path.sep}`),
        )
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
    const mergedPhotos = new Map(this.photos);
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
    const mergedPhotos = new Map(this.photos);
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
    const mergedPhotos = new Map(this.photos);
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
