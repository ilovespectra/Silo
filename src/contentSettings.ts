import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import * as fsPromises from "fs/promises";
import * as path from "path";

export interface ContentPreferences {
  showNsfw: boolean;
  safeSearch: boolean;
  theme: "system" | "dark" | "light";
  autoplayGlobe: boolean;
  showBannedPeople: boolean;
}

export interface PublicContentSettings extends ContentPreferences {
  parentalPasswordSet: boolean;
}

interface StoredContentSettings {
  preferences: ContentPreferences;
  passwordSalt: string | null;
  passwordHash: string | null;
}

const defaults: StoredContentSettings = {
  preferences: {
    showNsfw: false,
    safeSearch: true,
    theme: "system",
    autoplayGlobe: false,
    showBannedPeople: false,
  },
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
