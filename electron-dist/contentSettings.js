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
exports.ContentSettingsStore = exports.defaultSearchPerformanceSettings = exports.getSearchPerformanceMachineInfo = void 0;
const crypto_1 = require("crypto");
const fsPromises = __importStar(require("fs/promises"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
function getSearchPerformanceMachineInfo() {
    const processors = os.cpus();
    let availableProcessors = processors.length || 1;
    try {
        availableProcessors = Math.max(1, os.availableParallelism());
    }
    catch {
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
exports.getSearchPerformanceMachineInfo = getSearchPerformanceMachineInfo;
function defaultSearchPerformanceSettings(availableProcessors = getSearchPerformanceMachineInfo().availableProcessors) {
    const cores = Math.max(1, Math.floor(availableProcessors));
    return {
        // Keep interactive work responsive on small machines and cap large hosts.
        searchThreads: Math.max(1, Math.min(2, cores - 1)),
        indexThreads: 1,
        backgroundWorkPercent: 5,
    };
}
exports.defaultSearchPerformanceSettings = defaultSearchPerformanceSettings;
function normalizeSearchPerformanceSettings(value, availableProcessors) {
    const defaults = defaultSearchPerformanceSettings(availableProcessors);
    const normalizeThreads = (candidate, fallback) => typeof candidate === "number" && Number.isFinite(candidate)
        ? Math.max(1, Math.min(availableProcessors, Math.round(candidate)))
        : fallback;
    const backgroundCandidate = value?.backgroundWorkPercent;
    return {
        searchThreads: normalizeThreads(value?.searchThreads, defaults.searchThreads),
        indexThreads: normalizeThreads(value?.indexThreads, defaults.indexThreads),
        backgroundWorkPercent: typeof backgroundCandidate === "number" && Number.isFinite(backgroundCandidate)
            ? Math.max(5, Math.min(100, Math.round(backgroundCandidate)))
            : defaults.backgroundWorkPercent,
    };
}
const defaults = {
    preferences: {
        showNsfw: false,
        safeSearch: true,
        theme: "system",
        autoplayGlobe: false,
        preloadMapTextures: false,
        showBannedPeople: false,
    },
    performance: defaultSearchPerformanceSettings(),
    performanceSettingsVersion: 2,
    passwordSalt: null,
    passwordHash: null,
};
class ContentSettingsStore {
    constructor(userDataPath) {
        this.settings = structuredClone(defaults);
        this.writeChain = Promise.resolve();
        this.filePath = path.join(userDataPath, "content-settings.json");
    }
    async initialize() {
        try {
            const stored = JSON.parse(await fsPromises.readFile(this.filePath, "utf8"));
            const previousPerformance = stored.performance;
            const migrateLowBackgroundDefault = stored.performanceSettingsVersion !== 2 &&
                previousPerformance?.backgroundWorkPercent === 10;
            this.settings = {
                ...structuredClone(defaults),
                ...stored,
                preferences: { ...defaults.preferences, ...stored.preferences },
                performance: normalizeSearchPerformanceSettings(migrateLowBackgroundDefault
                    ? { ...previousPerformance, backgroundWorkPercent: 5 }
                    : previousPerformance, getSearchPerformanceMachineInfo().availableProcessors),
                performanceSettingsVersion: 2,
            };
            if (migrateLowBackgroundDefault)
                await this.persist();
        }
        catch {
            await this.persist();
        }
    }
    getPublicSettings() {
        return {
            ...this.settings.preferences,
            parentalPasswordSet: Boolean(this.settings.passwordHash && this.settings.passwordSalt),
        };
    }
    getSearchPerformanceSnapshot() {
        const machine = getSearchPerformanceMachineInfo();
        this.settings.performance = normalizeSearchPerformanceSettings(this.settings.performance, machine.availableProcessors);
        return { settings: { ...this.settings.performance }, machine };
    }
    async updateSearchPerformanceSettings(update) {
        if (!update || typeof update !== "object" || Array.isArray(update))
            throw new Error("Invalid performance settings.");
        const candidate = update;
        for (const key of ["searchThreads", "indexThreads", "backgroundWorkPercent"])
            if (typeof candidate[key] !== "number" ||
                !Number.isFinite(candidate[key]) ||
                !Number.isInteger(candidate[key]))
                throw new Error("Choose whole-number performance settings.");
        const machine = getSearchPerformanceMachineInfo();
        if (candidate.searchThreads < 1 ||
            candidate.searchThreads > machine.availableProcessors ||
            candidate.indexThreads < 1 ||
            candidate.indexThreads > machine.availableProcessors ||
            candidate.backgroundWorkPercent < 5 ||
            candidate.backgroundWorkPercent > 100)
            throw new Error("Performance settings are outside this computer’s supported range.");
        this.settings.performance = normalizeSearchPerformanceSettings(candidate, machine.availableProcessors);
        await this.persist();
        return this.getSearchPerformanceSnapshot();
    }
    async setParentalPassword(currentPassword, newPassword) {
        if (this.settings.passwordHash && !this.verify(currentPassword))
            throw new Error("The current parental password is incorrect.");
        if (newPassword.length < 6)
            throw new Error("Use at least 6 characters for the parental password.");
        const salt = (0, crypto_1.randomBytes)(16);
        this.settings.passwordSalt = salt.toString("hex");
        this.settings.passwordHash = (0, crypto_1.scryptSync)(newPassword, salt, 32).toString("hex");
        await this.persist();
        return this.getPublicSettings();
    }
    async updatePreferences(update, password = "") {
        const changesProtection = update.showNsfw !== undefined || update.safeSearch !== undefined;
        const becomesPermissive = update.showNsfw === true || update.safeSearch === false;
        if (changesProtection &&
            this.settings.passwordHash &&
            !this.verify(password))
            throw new Error("Enter the parental password to change content protection.");
        if (becomesPermissive && !this.settings.passwordHash)
            throw new Error("Create a parental password before relaxing content protection.");
        this.settings.preferences = { ...this.settings.preferences, ...update };
        await this.persist();
        return this.getPublicSettings();
    }
    verify(password) {
        if (!this.settings.passwordHash || !this.settings.passwordSalt)
            return false;
        const expected = Buffer.from(this.settings.passwordHash, "hex");
        const actual = (0, crypto_1.scryptSync)(password, Buffer.from(this.settings.passwordSalt, "hex"), expected.length);
        return (actual.length === expected.length && (0, crypto_1.timingSafeEqual)(actual, expected));
    }
    persist() {
        this.writeChain = this.writeChain.then(async () => {
            await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
            const temporaryPath = `${this.filePath}.tmp`;
            await fsPromises.writeFile(temporaryPath, JSON.stringify(this.settings, null, 2));
            await fsPromises.rename(temporaryPath, this.filePath);
        });
        return this.writeChain;
    }
}
exports.ContentSettingsStore = ContentSettingsStore;
