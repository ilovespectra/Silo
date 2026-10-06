import * as path from "path";
import * as fsPromises from "fs/promises";

export interface ContactEntry {
  phoneNumber: string;
  savedName: string;
}

export interface ContactBook {
  contacts: Record<string, string>; // phoneNumber -> savedName
}

export class ContactManager {
  private readonly userDataPath: string;
  private readonly contactsPath: string;
  private contacts: Map<string, string> = new Map();

  constructor(userDataPath: string) {
    this.userDataPath = userDataPath;
    this.contactsPath = path.join(userDataPath, "contacts.json");
    this.log(`ContactManager initialized with path: ${this.contactsPath}`);
  }

  private log(...args: any[]): void {
    try {
      console.log("[ContactManager]", ...args);
    } catch {
      // Silently ignore errors during shutdown
    }
  }

  async initialize(): Promise<void> {
    this.log("Initializing...");
    try {
      await fsPromises.mkdir(this.userDataPath, { recursive: true });
      try {
        const data = JSON.parse(
          await fsPromises.readFile(this.contactsPath, "utf8"),
        ) as ContactBook;
        this.contacts = new Map(Object.entries(data.contacts || {}));
        this.log(`Loaded ${this.contacts.size} saved contacts`);
      } catch {
        // File doesn't exist yet, that's fine
        this.log("No existing contacts file, starting fresh");
      }
    } catch (error) {
      this.log("Error initializing contacts:", error);
      throw error;
    }
  }

  async setContactName(
    phoneNumber: string,
    savedName: string | null,
  ): Promise<void> {
    if (savedName === null || savedName === "") {
      this.contacts.delete(phoneNumber);
      this.log(`Deleted contact for ${phoneNumber}`);
    } else {
      this.contacts.set(phoneNumber, savedName);
      this.log(`Set contact: ${phoneNumber} -> ${savedName}`);
    }
    await this.persistContacts();
  }

  getContactName(phoneNumber: string): string | undefined {
    return this.contacts.get(phoneNumber);
  }

  getAllContacts(): ContactEntry[] {
    return Array.from(this.contacts.entries()).map(
      ([phoneNumber, savedName]) => ({
        phoneNumber,
        savedName,
      }),
    );
  }

  private async persistContacts(): Promise<void> {
    try {
      const data: ContactBook = {
        contacts: Object.fromEntries(this.contacts),
      };
      const tempPath = `${this.contactsPath}.tmp`;
      await fsPromises.writeFile(
        tempPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
      await fsPromises.rename(tempPath, this.contactsPath);
      this.log(`Persisted ${this.contacts.size} contacts`);
    } catch (error) {
      this.log("Error persisting contacts:", error);
      throw error;
    }
  }
}
