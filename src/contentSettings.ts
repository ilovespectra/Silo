import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface ContentPreferences {
  showNsfw: boolean;
  safeSearch: boolean;
  theme: "system" | "dark" | "light";
  autoplayGlobe: boolean;
  preloadMapTextures: boolean;
  showBannedPeople: boolean;
}

export interface PublicContentSettings extends ContentPreferences {
  parentalPasswordSet: boolean;
}

export interface SearchPerformanceSettings {
  searchThreads: number;
  indexThreads: number;
  backgroundWorkPercent: number;
}

export interface SearchPerformanceMachineInfo {
  processor: string;
  logicalProcessors: number;
  availableProcessors: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  platform: string;
  architecture: string;
}

export interface SearchPerformanceSnapshot {
  settings: SearchPerformanceSettings;
  machine: SearchPerformanceMachineInfo;
}

export function getSearchPerformanceMachineInfo(): SearchPerformanceMachineInfo {
  const processors = os.cpus();
  let availableProcessors = processors.length || 1;
  try {
    availableProcessors = Math.max(1, os.availableParallelism());
  } catch {
    // Older runtimes may not expose availableParallelism; fall back to logical CPUs.
  }
  return {
    processor: processors[0]?.model.trim() || "Processor information unavailable",
    logicalProcessors: Math.max(1, processors.length),
    availableProcessors,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    platform: os.platform(),
    architecture: os.arch(),
  };
}

export function defaultSearchPerformanceSettings(
  availableProcessors = getSearchPerformanceMachineInfo().availableProcessors,
): SearchPerformanceSettings {
  const cores = Math.max(1, Math.floor(availableProcessors));
  return {
    searchThreads: cores,
    // Reserve one logical processor for the OS/UI and keep ANN preparation bounded.
    indexThreads: Math.max(1, Math.min(4, cores - 1)),
    backgroundWorkPercent: 55,
  };
}

function normalizeSearchPerformanceSettings(
  value: Partial<SearchPerformanceSettings> | undefined,
  availableProcessors: number,
): SearchPerformanceSettings {
  const defaults = defaultSearchPerformanceSettings(availableProcessors);
  const normalizeThreads = (candidate: unknown, fallback: number) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(1, Math.min(availableProcessors, Math.round(candidate)))
      : fallback;
  const backgroundCandidate = value?.backgroundWorkPercent;
  return {
    searchThreads: normalizeThreads(value?.searchThreads, defaults.searchThreads),
    indexThreads: normalizeThreads(value?.indexThreads, defaults.indexThreads),
    backgroundWorkPercent:
      typeof backgroundCandidate === "number" && Number.isFinite(backgroundCandidate)
        ? Math.max(20, Math.min(100, Math.round(backgroundCandidate)))
        : defaults.backgroundWorkPercent,
  };
}

interface StoredContentSettings {
  preferences: ContentPreferences;
  performance: SearchPerformanceSettings;
  passwordSalt: string | null;
  passwordHash: string | null;
}

const defaults: StoredContentSettings = {
  preferences: {
    showNsfw: false,
    safeSearch: true,
    theme: "system",
    autoplayGlobe: false,
    preloadMapTextures: false,
    showBannedPeople: false,
  },
  performance: defaultSearchPerformanceSettings(),
  passwordSalt: null,
  passwordHash: null,
};

export class ContentSettingsStore {
  private readonly filePath: string;
  private settings: StoredContentSettings = structuredClone(defaults);
  private writeChain = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "content-settings.json");
  }

  async initialize() {
    try {
      const stored = JSON.parse(
        await fsPromises.readFile(this.filePath, "utf8"),
      ) as Partial<StoredContentSettings>;
      this.settings = {
        ...structuredClone(defaults),
        ...stored,
        preferences: { ...defaults.preferences, ...stored.preferences },
        performance: normalizeSearchPerformanceSettings(
          stored.performance,
          getSearchPerformanceMachineInfo().availableProcessors,
        ),
      };
    } catch {
      await this.persist();
    }
  }

  getPublicSettings(): PublicContentSettings {
    return {
      ...this.settings.preferences,
      parentalPasswordSet: Boolean(
        this.settings.passwordHash && this.settings.passwordSalt,
      ),
    };
  }

  getSearchPerformanceSnapshot(): SearchPerformanceSnapshot {
    const machine = getSearchPerformanceMachineInfo();
    this.settings.performance = normalizeSearchPerformanceSettings(
      this.settings.performance,
      machine.availableProcessors,
    );
    return { settings: { ...this.settings.performance }, machine };
  }

  async updateSearchPerformanceSettings(
    update: unknown,
  ): Promise<SearchPerformanceSnapshot> {
    if (!update || typeof update !== "object" || Array.isArray(update))
      throw new Error("Invalid performance settings.");
    const candidate = update as Record<string, unknown>;
    for (const key of ["searchThreads", "indexThreads", "backgroundWorkPercent"])
      if (
        typeof candidate[key] !== "number" ||
        !Number.isFinite(candidate[key]) ||
        !Number.isInteger(candidate[key])
      )
        throw new Error("Choose whole-number performance settings.");
    const machine = getSearchPerformanceMachineInfo();
    if (
      (candidate.searchThreads as number) < 1 ||
      (candidate.searchThreads as number) > machine.availableProcessors ||
      (candidate.indexThreads as number) < 1 ||
      (candidate.indexThreads as number) > machine.availableProcessors ||
      (candidate.backgroundWorkPercent as number) < 20 ||
      (candidate.backgroundWorkPercent as number) > 100
    )
      throw new Error("Performance settings are outside this computer’s supported range.");
    this.settings.performance = normalizeSearchPerformanceSettings(
      candidate as Partial<SearchPerformanceSettings>,
      machine.availableProcessors,
    );
    await this.persist();
    return this.getSearchPerformanceSnapshot();
  }

  async setParentalPassword(currentPassword: string, newPassword: string) {
    if (this.settings.passwordHash && !this.verify(currentPassword))
      throw new Error("The current parental password is incorrect.");
    if (newPassword.length < 6)
      throw new Error("Use at least 6 characters for the parental password.");
    const salt = randomBytes(16);
    this.settings.passwordSalt = salt.toString("hex");
    this.settings.passwordHash = scryptSync(newPassword, salt, 32).toString(
      "hex",
    );
    await this.persist();
    return this.getPublicSettings();
  }

  async updatePreferences(update: Partial<ContentPreferences>, password = "") {
    const changesProtection =
      update.showNsfw !== undefined || update.safeSearch !== undefined;
    const becomesPermissive =
      update.showNsfw === true || update.safeSearch === false;
    if (
      changesProtection &&
      this.settings.passwordHash &&
      !this.verify(password)
    )
      throw new Error(
        "Enter the parental password to change content protection.",
      );
    if (becomesPermissive && !this.settings.passwordHash)
      throw new Error(
        "Create a parental password before relaxing content protection.",
      );
    this.settings.preferences = { ...this.settings.preferences, ...update };
    await this.persist();
    return this.getPublicSettings();
  }

  private verify(password: string) {
    if (!this.settings.passwordHash || !this.settings.passwordSalt)
      return false;
    const expected = Buffer.from(this.settings.passwordHash, "hex");
    const actual = scryptSync(
      password,
      Buffer.from(this.settings.passwordSalt, "hex"),
      expected.length,
    );
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private persist() {
    this.writeChain = this.writeChain.then(async () => {
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fsPromises.writeFile(
        temporaryPath,
        JSON.stringify(this.settings, null, 2),
      );
      await fsPromises.rename(temporaryPath, this.filePath);
    });
    return this.writeChain;
  }
}
