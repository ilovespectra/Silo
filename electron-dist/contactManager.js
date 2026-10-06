"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContactManager = void 0;
const path = __importStar(require("path"));
const fsPromises = __importStar(require("fs/promises"));
class ContactManager {
    constructor(userDataPath) {
        this.contacts = new Map();
        this.userDataPath = userDataPath;
        this.contactsPath = path.join(userDataPath, "contacts.json");
        this.log(`ContactManager initialized with path: ${this.contactsPath}`);
    }
    log(...args) {
        try {
            console.log("[ContactManager]", ...args);
        }
        catch {
            // Silently ignore errors during shutdown
        }
    }
    async initialize() {
        this.log("Initializing...");
        try {
            await fsPromises.mkdir(this.userDataPath, { recursive: true });
            try {
                const data = JSON.parse(await fsPromises.readFile(this.contactsPath, "utf8"));
                this.contacts = new Map(Object.entries(data.contacts || {}));
                this.log(`Loaded ${this.contacts.size} saved contacts`);
            }
            catch {
                // File doesn't exist yet, that's fine
                this.log("No existing contacts file, starting fresh");
            }
        }
        catch (error) {
            this.log("Error initializing contacts:", error);
            throw error;
        }
    }
    async setContactName(phoneNumber, savedName) {
        if (savedName === null || savedName === "") {
            this.contacts.delete(phoneNumber);
            this.log(`Deleted contact for ${phoneNumber}`);
        }
        else {
            this.contacts.set(phoneNumber, savedName);
            this.log(`Set contact: ${phoneNumber} -> ${savedName}`);
        }
        await this.persistContacts();
    }
    getContactName(phoneNumber) {
        return this.contacts.get(phoneNumber);
    }
    getAllContacts() {
        return Array.from(this.contacts.entries()).map(([phoneNumber, savedName]) => ({
            phoneNumber,
            savedName,
        }));
    }
    async persistContacts() {
        try {
            const data = {
                contacts: Object.fromEntries(this.contacts),
            };
            const tempPath = `${this.contactsPath}.tmp`;
            await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
            await fsPromises.rename(tempPath, this.contactsPath);
            this.log(`Persisted ${this.contacts.size} contacts`);
        }
        catch (error) {
            this.log("Error persisting contacts:", error);
            throw error;
        }
    }
}
exports.ContactManager = ContactManager;
