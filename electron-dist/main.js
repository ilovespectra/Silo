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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const crypto_1 = require("crypto");
const child_process_1 = require("child_process");
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
const util_1 = require("util");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const fsPromises = __importStar(require("fs/promises"));
const electron_is_dev_1 = __importDefault(require("electron-is-dev"));
const electron_updater_1 = require("electron-updater");
const semanticIndexer_1 = require("./semanticIndexer");
const stateStore_1 = require("./stateStore");
const faceIndexer_1 = require("./faceIndexer");
const petIndexer_1 = require("./petIndexer");
const phoneManager_1 = require("./phoneManager");
const googleManager_1 = require("./googleManager");
const messageExportCoordinator_1 = require("./messageExportCoordinator");
const contactManager_1 = require("./contactManager");
const geoIndexer_1 = require("./geoIndexer");
const thumbnailPregenerator_1 = require("./thumbnailPregenerator");
const audioLibraryCache_1 = require("./audioLibraryCache");
const libraryStats_1 = require("./libraryStats");
const inventoryFingerprint_1 = require("./inventoryFingerprint");
const audioTypes_1 = require("./utils/audioTypes");
const lifetimePayment_1 = require("./lifetimePayment");
const demoLimits_1 = require("./demoLimits");
const betaLicense_1 = require("./betaLicense");
const betaLicensePublicKey_1 = require("./betaLicensePublicKey");
const documentPreview_1 = require("./documentPreview");
const indexingRecovery_1 = require("./indexingRecovery");
const inventoryTransfer_1 = require("./inventoryTransfer");
const rendererRecovery_1 = require("./rendererRecovery");
const memoryManager_1 = require("./memoryManager");
const memoryDiscovery_1 = require("./memoryDiscovery");
const memoryTopicProfile_1 = require("./memoryTopicProfile");
const exifr = __importStar(require("exifr"));
const memoryExporter_1 = require("./memoryExporter");
const memoryTypes_1 = require("./memoryTypes");
const geocoder_1 = require("./geocoder");
const duplicateManager_1 = require("./duplicateManager");
const indexingStorage_1 = require("./indexingStorage");
const cloneArchive_1 = require("./cloneArchive");
const shelterVerification_1 = require("./shelterVerification");
const heapGuard_1 = require("./heapGuard");
const timeMachineBackup_1 = require("./timeMachineBackup");
const indexingPathPolicy_1 = require("./indexingPathPolicy");
const aestheticScorer_1 = require("./aestheticScorer");
const configBundle_1 = require("./configBundle");
const contentSettings_1 = require("./contentSettings");
const libraryShareServer_1 = require("./libraryShareServer");
const contentPolicy_1 = require("./contentPolicy");
const timeMachine_1 = require("./timeMachine");
const mime = require("mime");
const ffmpegStaticPath = require("ffmpeg-static");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const directlyPlayableVideoExtensions = new Set([".mp4", ".webm", ".ogv"]);
const mediaConversionJobs = new Map();
// Handle EPIPE errors on console streams (can occur during shutdown)
if (process.stdout) {
    process.stdout.on("error", () => {
        // Silently ignore EPIPE and other stream errors
    });
}
if (process.stderr) {
    process.stderr.on("error", () => {
        // Silently ignore EPIPE and other stream errors
    });
}
electron_1.app.setName("Silo");
function appIconPath() {
    return path.join(electron_1.app.getAppPath(), electron_1.app.isPackaged ? "build" : "public", "icon.png");
}
// setName would otherwise relocate userData and orphan existing state.
electron_1.app.setPath("userData", process.env.FILE_BROWSER_USER_DATA_DIR ||
    path.join(electron_1.app.getPath("appData"), "file-browser-electron"));
let indexStorageRoot = electron_1.app.getPath("userData");
(0, indexingStorage_1.setActiveIndexStorageRoot)(indexStorageRoot);
const indexStoragePath = (0, indexingStorage_1.createIndexStoragePathResolver)(() => indexStorageRoot);
const diagnosticsDirectory = path.join(electron_1.app.getPath("userData"), "diagnostics");
const lifetimeLicensePath = path.join(electron_1.app.getPath("userData"), "lifetime-license.json");
const betaLicensePath = path.join(electron_1.app.getPath("userData"), "beta-license.json");
const betaInstallationIdPath = path.join(electron_1.app.getPath("userData"), "beta-installation-id");
const lifetimeRpcEndpoint = "https://optimistic-daisy-fast-mainnet.helius-rpc.com";
async function requestLifetimeRpc(method, params) {
    const abortController = new AbortController();
    const requestTimeout = setTimeout(() => abortController.abort(), 15000);
    try {
        const response = await electron_1.net.fetch(lifetimeRpcEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: "silo-lifetime-license",
                method,
                params,
            }),
            signal: abortController.signal,
        });
        return {
            ok: response.ok,
            result: response.ok ? await response.json() : undefined,
        };
    }
    finally {
        clearTimeout(requestTimeout);
    }
}
const demoUsagePath = path.join(electron_1.app.getPath("userData"), "demo-usage.json");
const demoTestingModePath = path.join(electron_1.app.getPath("userData"), "demo-testing-mode.json");
let lifetimeLicensed = false;
let demoTestingModeEnabled = false;
let betaInstallationIdPromise = null;
let cachedDemoUsage = null;
let demoUsageWriteQueue = Promise.resolve();
let demoDuplicateDeleteQueue = Promise.resolve();
let pendingDemoLimitFeature = null;
function fullAccessEnabled() {
    return (0, demoLimits_1.hasFullAccess)(lifetimeLicensed, demoTestingModeEnabled);
}
async function readDemoTestingMode() {
    try {
        const value = JSON.parse(await fsPromises.readFile(demoTestingModePath, "utf8"));
        return value?.version === 1 && value?.enabled === true;
    }
    catch {
        return false;
    }
}
async function writeDemoTestingMode(enabled) {
    await fsPromises.mkdir(path.dirname(demoTestingModePath), {
        recursive: true,
    });
    const temporaryPath = `${demoTestingModePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify({ version: 1, enabled }, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsPromises.rename(temporaryPath, demoTestingModePath);
}
function notifyDemoLimitReached(feature) {
    if (!rendererReady) {
        pendingDemoLimitFeature = feature;
        return;
    }
    sendToRenderer("demo-limit-reached", feature);
}
async function readDemoUsage() {
    if (cachedDemoUsage)
        return cachedDemoUsage;
    try {
        const parsed = JSON.parse(await fsPromises.readFile(demoUsagePath, "utf8"));
        const savedIds = Array.isArray(parsed?.memoryPreviewIds)
            ? parsed.memoryPreviewIds
            : [];
        const savedDuplicateFilesDeleted = Number(parsed?.duplicateFilesDeleted);
        const memoryPreviewIds = savedIds.filter((id) => typeof id === "string" && id.length <= 200);
        const usage = {
            version: 1,
            memoryPreviewIds: [...new Set(memoryPreviewIds)],
            duplicateFilesDeleted: Number.isSafeInteger(savedDuplicateFilesDeleted) &&
                savedDuplicateFilesDeleted > 0
                ? savedDuplicateFilesDeleted
                : 0,
        };
        cachedDemoUsage = usage;
        return usage;
    }
    catch {
        const usage = {
            version: 1,
            memoryPreviewIds: [],
            duplicateFilesDeleted: 0,
        };
        cachedDemoUsage = usage;
        return usage;
    }
}
async function writeDemoUsage(usage) {
    await fsPromises.mkdir(path.dirname(demoUsagePath), { recursive: true });
    const temporaryPath = `${demoUsagePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify(usage, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
    await fsPromises.rename(temporaryPath, demoUsagePath);
    cachedDemoUsage = usage;
}
async function recordDemoDuplicateDeletes(count) {
    if (count <= 0)
        return;
    const write = demoUsageWriteQueue.then(async () => {
        const usage = await readDemoUsage();
        await writeDemoUsage({
            ...usage,
            duplicateFilesDeleted: usage.duplicateFilesDeleted + count,
        });
    });
    demoUsageWriteQueue = write.catch(() => undefined);
    await write;
}
async function consumeDemoMemoryPreview(memoryId) {
    if (fullAccessEnabled())
        return true;
    let allowed = false;
    const write = demoUsageWriteQueue.then(async () => {
        const usage = await readDemoUsage();
        if (usage.memoryPreviewIds.includes(memoryId)) {
            allowed = true;
            return;
        }
        if ((0, demoLimits_1.isDemoLimitReached)(fullAccessEnabled(), usage.memoryPreviewIds.length, demoLimits_1.DEMO_LIMITS.memoryPreviews))
            return;
        const next = {
            ...usage,
            memoryPreviewIds: [...usage.memoryPreviewIds, memoryId],
        };
        await writeDemoUsage(next);
        allowed = true;
    });
    demoUsageWriteQueue = write.catch(() => undefined);
    await write;
    return allowed;
}
function getDemoPeople() {
    const allPeople = faceIndexer?.getPeople() ?? [];
    return (0, demoLimits_1.selectDemoPeople)(allPeople, fullAccessEnabled(), demoLimits_1.DEMO_LIMITS.people);
}
function canAccessDemoPerson(personId) {
    if (fullAccessEnabled())
        return true;
    const allPeople = faceIndexer?.getPeople() ?? [];
    if (!allPeople.some((person) => person.id === personId))
        return false;
    const allowed = (0, demoLimits_1.selectDemoPeople)(allPeople, false, demoLimits_1.DEMO_LIMITS.people).some((person) => person.id === personId);
    if (!allowed)
        notifyDemoLimitReached("people");
    return allowed;
}
function requireDemoPersonAccess(personId) {
    if (canAccessDemoPerson(personId))
        return;
    throw new Error(`The demo includes up to ${demoLimits_1.DEMO_LIMITS.people} people. Unlock Silo to manage more.`);
}
function requireDemoPersonSlot() {
    if (fullAccessEnabled() ||
        (faceIndexer?.getPeople().length ?? 0) < demoLimits_1.DEMO_LIMITS.people)
        return;
    notifyDemoLimitReached("people");
    throw new Error(`The demo includes up to ${demoLimits_1.DEMO_LIMITS.people} people. Unlock Silo to add more.`);
}
function requireDemoPersonTarget(target) {
    if (typeof target?.personId === "string") {
        requireDemoPersonAccess(target.personId);
        return;
    }
    if (typeof target?.newName === "string" && target.newName.trim())
        requireDemoPersonSlot();
}
async function getBetaInstallationId() {
    if (betaInstallationIdPromise)
        return betaInstallationIdPromise;
    const pending = (async () => {
        const saved = await fsPromises
            .readFile(betaInstallationIdPath, "utf8")
            .catch(() => "");
        if (/^[a-f0-9]{32}$/.test(saved.trim()))
            return saved.trim();
        const installationId = (0, crypto_1.randomBytes)(16).toString("hex");
        await fsPromises.mkdir(path.dirname(betaInstallationIdPath), {
            recursive: true,
        });
        const temporaryPath = `${betaInstallationIdPath}.${process.pid}.tmp`;
        await fsPromises.writeFile(temporaryPath, installationId, {
            encoding: "utf8",
            mode: 0o600,
        });
        await fsPromises.rename(temporaryPath, betaInstallationIdPath);
        return installationId;
    })();
    betaInstallationIdPromise = pending.catch((error) => {
        betaInstallationIdPromise = null;
        throw error;
    });
    return betaInstallationIdPromise;
}
async function writeBetaLicense(activationCode) {
    await fsPromises.mkdir(path.dirname(betaLicensePath), { recursive: true });
    const temporaryPath = `${betaLicensePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify({ version: 1, activationCode }, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsPromises.rename(temporaryPath, betaLicensePath);
}
async function readLifetimeLicense() {
    try {
        const stored = JSON.parse(await fsPromises.readFile(lifetimeLicensePath, "utf8"));
        if (stored.version === 1 &&
            stored.network === "solana-mainnet" &&
            stored.paymentAddress === lifetimePayment_1.LIFETIME_PAYMENT_ADDRESS &&
            stored.usdcMint === lifetimePayment_1.LIFETIME_USDC_MINT &&
            typeof stored.signature === "string" &&
            (0, lifetimePayment_1.isSolanaTransactionSignature)(stored.signature) &&
            typeof stored.verifiedAt === "number" &&
            Number.isFinite(stored.verifiedAt))
            return {
                isLicensed: true,
                licenseType: "purchase",
                signature: stored.signature,
                verifiedAt: stored.verifiedAt,
            };
    }
    catch { }
    try {
        const stored = JSON.parse(await fsPromises.readFile(betaLicensePath, "utf8"));
        if (typeof stored?.activationCode !== "string")
            return { isLicensed: false };
        const installationId = await getBetaInstallationId();
        const payload = (0, betaLicense_1.verifyBetaActivationCode)(stored.activationCode, betaLicensePublicKey_1.BETA_LICENSE_PUBLIC_KEY, installationId);
        if (payload)
            return {
                isLicensed: true,
                licenseType: "beta",
                verifiedAt: payload.issuedAt,
            };
    }
    catch { }
    return { isLicensed: false };
}
async function writeLifetimeLicense(signature, verifiedAt) {
    const record = {
        version: 1,
        network: "solana-mainnet",
        paymentAddress: lifetimePayment_1.LIFETIME_PAYMENT_ADDRESS,
        usdcMint: lifetimePayment_1.LIFETIME_USDC_MINT,
        signature,
        verifiedAt,
    };
    await fsPromises.mkdir(path.dirname(lifetimeLicensePath), {
        recursive: true,
    });
    const temporaryPath = `${lifetimeLicensePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporaryPath, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsPromises.rename(temporaryPath, lifetimeLicensePath);
}
// Two instances on one userData interleave index writes; the newcomer hands off and exits.
if (!electron_1.app.requestSingleInstanceLock())
    electron_1.app.exit(0);
electron_1.app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed())
        return;
    if (mainWindow.isMinimized())
        mainWindow.restore();
    mainWindow.focus();
});
// The dev launcher stops Silo with SIGTERM; quit through the normal path so writes flush.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => electron_1.app.quit());
const diagnosticsPath = path.join(diagnosticsDirectory, "runtime.jsonl");
const maxBugReportScreenshotBytes = 3 * 1024 * 1024;
const defaultBugReportEndpoint = "https://silo-bug-report-relay.vercel.app/api/bug-report";
const defaultBetaRequestEndpoint = "https://silo-bug-report-relay.vercel.app/api/beta-request";
fs.mkdirSync(diagnosticsDirectory, { recursive: true });
electron_1.crashReporter.start({
    productName: "silo",
    companyName: "silo",
    submitURL: "",
    uploadToServer: false,
    compress: false,
});
function runtimeLog(event, details = {}) {
    try {
        fs.appendFileSync(diagnosticsPath, `${JSON.stringify({ time: new Date().toISOString(), event, pid: process.pid, ...details })}\n`);
    }
    catch {
        // Diagnostics must not interfere with application startup.
    }
}
process.on("uncaughtException", (error) => runtimeLog("uncaught-exception", {
    message: error.message,
    stack: error.stack,
}));
process.on("unhandledRejection", (reason) => runtimeLog("unhandled-rejection", {
    reason: reason instanceof Error ? reason.stack || reason.message : String(reason),
}));
electron_1.app.on("child-process-gone", (_event, details) => runtimeLog("child-process-gone", { ...details }));
electron_1.protocol.registerSchemesAsPrivileged([
    {
        scheme: "face-crop",
        privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
    {
        scheme: "app-media",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
            bypassCSP: true,
        },
    },
    {
        scheme: "thumb",
        privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
]);
const startupStartedAt = Date.now();
let startupState = {
    ready: false,
    step: 0,
    total: 7,
    label: "Starting…",
};
let resolveServicesReady;
const servicesReady = new Promise((resolve) => {
    resolveServicesReady = resolve;
});
let servicesAreReady = false;
void servicesReady.then(() => {
    servicesAreReady = true;
});
let indexingOverviewCache = null;
let indexingOverviewTask = null;
/**
 * Progress polling must always answer quickly: during startup it reports startup
 * stages, and afterwards one shared computation runs while callers get the last
 * snapshot if it takes longer than a moment.
 */
function respondIndexingOverview(compute) {
    if (!servicesAreReady)
        return [{
                id: "startup",
                label: "Starting Silo",
                status: "loading-model",
                processed: startupState.step,
                total: startupState.total,
                unit: "steps",
                errors: 0,
                message: startupState.label,
                detail: "Loading saved indexes. Progress for each stage appears as soon as they are open.",
            }];
    if (!indexingOverviewTask)
        indexingOverviewTask = Promise.resolve()
            .then(compute)
            .then((result) => {
            indexingOverviewCache = result;
            return result;
        })
            .finally(() => {
            indexingOverviewTask = null;
        });
    if (indexingOverviewCache === null)
        return indexingOverviewTask;
    return Promise.race([
        indexingOverviewTask.catch(() => indexingOverviewCache),
        new Promise((resolve) => setTimeout(() => resolve(indexingOverviewCache), 1500)),
    ]);
}
// These only touch stateStore/contentSettings, which exist before the window is created.
const EARLY_IPC_CHANNELS = new Set([
    "get-app-update-state",
    "check-app-updates",
    "get-startup-state",
    "get-content-settings",
    "get-lifetime-license",
    "is-demo-mode",
    "get-bug-report-status",
    "get-beta-activation-info",
    "activate-beta-license",
    "verify-lifetime-payment",
    "update-ui-state",
    "is-dev",
]);
const registerIpcHandler = electron_1.ipcMain.handle.bind(electron_1.ipcMain);
const inventoryTransfers = new inventoryTransfer_1.InventoryTransfers();
const inventoryExpiryTimer = setInterval(() => inventoryTransfers.expire(), 60000);
inventoryExpiryTimer.unref();
electron_1.ipcMain.handle = ((channel, listener) => registerIpcHandler(channel, async (event, ...args) => {
    if (channel === "get-indexing-overview")
        return respondIndexingOverview(() => listener(event, ...args));
    if (!EARLY_IPC_CHANNELS.has(channel))
        await servicesReady;
    const result = await listener(event, ...args);
    if (channel === "get-files" && Array.isArray(result)) {
        runtimeLog("inventory-transfer-paged", {
            channel,
            files: result.length,
            heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        });
        return inventoryTransfers.create(result, event.sender.id);
    }
    if (channel === "get-audio-library-cache" && result?.files) {
        runtimeLog("inventory-transfer-paged", {
            channel,
            files: result.files.length,
            heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        });
        return {
            ...result,
            files: inventoryTransfers.create(result.files, event.sender.id),
        };
    }
    if (channel === "refresh-audio-library-cache" && result?.snapshot?.files) {
        runtimeLog("inventory-transfer-paged", {
            channel,
            files: result.snapshot.files.length,
            heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        });
        return {
            ...result,
            snapshot: {
                ...result.snapshot,
                files: inventoryTransfers.create(result.snapshot.files, event.sender.id),
            },
        };
    }
    return result;
}));
function sendToRenderer(channel, payload) {
    const contents = mainWindow?.webContents;
    if (!rendererReady || !contents || contents.isDestroyed())
        return;
    try {
        contents.send(channel, payload);
    }
    catch {
        // Frame may be mid-navigation; the renderer re-fetches state on mount.
    }
}
function compareAppVersions(candidate, current) {
    const parse = (value) => {
        const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
        if (!match)
            return null;
        return {
            core: [Number(match[1]), Number(match[2]), Number(match[3])],
            prerelease: match[4]?.split(".") ?? [],
        };
    };
    const candidateVersion = parse(candidate);
    const currentVersion = parse(current);
    if (!candidateVersion || !currentVersion)
        return null;
    for (let index = 0; index < candidateVersion.core.length; index += 1) {
        if (candidateVersion.core[index] !== currentVersion.core[index])
            return candidateVersion.core[index] > currentVersion.core[index] ? 1 : -1;
    }
    if (!candidateVersion.prerelease.length && !currentVersion.prerelease.length)
        return 0;
    if (!candidateVersion.prerelease.length)
        return 1;
    if (!currentVersion.prerelease.length)
        return -1;
    const partCount = Math.max(candidateVersion.prerelease.length, currentVersion.prerelease.length);
    for (let index = 0; index < partCount; index += 1) {
        const candidatePart = candidateVersion.prerelease[index];
        const currentPart = currentVersion.prerelease[index];
        if (candidatePart === undefined)
            return -1;
        if (currentPart === undefined)
            return 1;
        if (candidatePart === currentPart)
            continue;
        const candidateNumeric = /^\d+$/.test(candidatePart);
        const currentNumeric = /^\d+$/.test(currentPart);
        if (candidateNumeric && currentNumeric)
            return Number(candidatePart) > Number(currentPart) ? 1 : -1;
        if (candidateNumeric !== currentNumeric)
            return candidateNumeric ? -1 : 1;
        return candidatePart > currentPart ? 1 : -1;
    }
    return 0;
}
function publishAppUpdateState(nextState) {
    appUpdateState = nextState;
    sendToRenderer("app-update-state", appUpdateState);
}
function isTrustedReleaseUrl(value, tag) {
    if (typeof value !== "string")
        return false;
    try {
        const url = new URL(value);
        return (url.protocol === "https:" &&
            url.hostname === "github.com" &&
            url.pathname.startsWith(`/ilovespectra/silo-downloads/releases/download/${encodeURIComponent(tag)}/`));
    }
    catch {
        return false;
    }
}
async function getLatestDmgRelease() {
    const currentVersion = electron_1.app.getVersion();
    const response = await electron_1.net.fetch("https://api.github.com/repos/ilovespectra/silo-downloads/releases?per_page=30", {
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Silo",
        },
    });
    if (!response.ok)
        throw new Error(`Release check returned HTTP ${response.status}`);
    const releases = (await response.json());
    const candidates = releases
        .filter((release) => release.draft !== true && typeof release.tag_name === "string")
        .map((release) => ({
        release,
        version: release.tag_name.replace(/^v/, ""),
        order: compareAppVersions(release.tag_name.replace(/^v/, ""), currentVersion),
    }))
        .filter((candidate) => candidate.order !== null && candidate.order > 0)
        .sort((left, right) => compareAppVersions(right.version, left.version) ?? 0);
    const latest = candidates[0];
    if (!latest)
        return { status: "not-available", currentVersion };
    const tag = latest.release.tag_name;
    const releaseUrl = typeof latest.release.html_url === "string" &&
        latest.release.html_url.startsWith("https://github.com/ilovespectra/silo-downloads/releases/tag/")
        ? latest.release.html_url
        : `https://github.com/ilovespectra/silo-downloads/releases/tag/${encodeURIComponent(tag)}`;
    const expectedArchitecture = process.arch === "arm64" ? "arm64" : "x64";
    const assets = Array.isArray(latest.release.assets)
        ? latest.release.assets
        : [];
    const matchingAsset = assets.find((asset) => asset.name === `Silo-${latest.version}-${expectedArchitecture}.dmg` &&
        isTrustedReleaseUrl(asset.browser_download_url, tag));
    const candidateDownloadUrl = matchingAsset?.browser_download_url;
    const downloadUrl = isTrustedReleaseUrl(candidateDownloadUrl, tag)
        ? candidateDownloadUrl
        : undefined;
    return {
        status: "available",
        currentVersion,
        version: latest.version,
        downloadUrl,
        releaseUrl,
        message: downloadUrl
            ? undefined
            : `Version ${latest.version} is available, but this release has no ${expectedArchitecture} DMG yet.`,
    };
}
async function checkForAppUpdates() {
    if (!electron_1.app.isPackaged || electron_is_dev_1.default) {
        const state = {
            status: "unsupported",
            currentVersion: electron_1.app.getVersion(),
            message: "Automatic update checks are available in installed builds.",
        };
        publishAppUpdateState(state);
        return state;
    }
    if (appUpdateCheck)
        return appUpdateCheck;
    appUpdateCheck = (async () => {
        publishAppUpdateState({
            status: "checking",
            currentVersion: electron_1.app.getVersion(),
        });
        try {
            try {
                await electron_updater_1.autoUpdater.checkForUpdates();
            }
            catch (error) {
                runtimeLog("updater-metadata-unavailable", {
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            const state = await getLatestDmgRelease();
            publishAppUpdateState(state);
            return state;
        }
        catch (error) {
            const state = {
                status: "error",
                currentVersion: electron_1.app.getVersion(),
                message: "Could not check for updates. Try again when you are online.",
            };
            runtimeLog("app-update-check-failed", {
                message: error instanceof Error ? error.message : String(error),
            });
            publishAppUpdateState(state);
            return state;
        }
        finally {
            appUpdateCheck = null;
        }
    })();
    return appUpdateCheck;
}
async function downloadAndInstallAppUpdate() {
    if (!electron_1.app.isPackaged || electron_is_dev_1.default) {
        const state = {
            status: "unsupported",
            currentVersion: electron_1.app.getVersion(),
            message: "Install an official Silo build to use automatic updates.",
        };
        publishAppUpdateState(state);
        return state;
    }
    if (appUpdateInstall)
        return appUpdateInstall;
    const announcedUpdate = appUpdateState;
    if (announcedUpdate.status !== "available" ||
        !announcedUpdate.version ||
        !announcedUpdate.downloadUrl) {
        const state = {
            status: "error",
            currentVersion: electron_1.app.getVersion(),
            message: "No compatible update is ready to install. Check again online.",
        };
        publishAppUpdateState(state);
        return state;
    }
    appUpdateInstall = (async () => {
        const currentVersion = electron_1.app.getVersion();
        const version = announcedUpdate.version;
        publishAppUpdateState({
            ...announcedUpdate,
            status: "checking",
            currentVersion,
            message: `Verifying Silo ${version} before download…`,
        });
        try {
            const updateCheck = await electron_updater_1.autoUpdater.checkForUpdates();
            if (!updateCheck?.isUpdateAvailable ||
                compareAppVersions(updateCheck.updateInfo.version, version) !== 0) {
                throw new Error("The release metadata does not match the announced update.");
            }
            publishAppUpdateState({
                ...announcedUpdate,
                status: "downloading",
                currentVersion,
                downloadPercent: 0,
                message: `Downloading Silo ${version}…`,
            });
            await electron_updater_1.autoUpdater.downloadUpdate();
            const state = {
                ...announcedUpdate,
                status: "installing",
                currentVersion,
                message: `Silo ${version} is installing. The app will restart automatically.`,
            };
            publishAppUpdateState(state);
            setTimeout(() => {
                try {
                    electron_updater_1.autoUpdater.quitAndInstall(false, true);
                }
                catch (error) {
                    runtimeLog("app-update-restart-failed", {
                        version,
                        message: error instanceof Error ? error.message : String(error),
                    });
                    publishAppUpdateState({
                        ...state,
                        status: "error",
                        downloadUrl: announcedUpdate.downloadUrl,
                        message: "The update downloaded, but Silo could not restart to install it.",
                    });
                }
            }, 500);
            return state;
        }
        catch (error) {
            runtimeLog("app-update-install-failed", {
                version,
                message: error instanceof Error ? error.message : String(error),
            });
            const state = {
                status: "error",
                currentVersion,
                version,
                downloadUrl: announcedUpdate.downloadUrl,
                releaseUrl: announcedUpdate.releaseUrl,
                message: "Automatic installation failed. Download the DMG instead or try again later.",
            };
            publishAppUpdateState(state);
            return state;
        }
    })();
    try {
        return await appUpdateInstall;
    }
    finally {
        appUpdateInstall = null;
    }
}
function configureAppUpdater() {
    electron_updater_1.autoUpdater.autoDownload = false;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = false;
    electron_updater_1.autoUpdater.allowPrerelease = true;
    electron_updater_1.autoUpdater.on("error", (error) => {
        runtimeLog("electron-updater-discovery-error", {
            message: error instanceof Error ? error.message : String(error),
        });
    });
    electron_updater_1.autoUpdater.on("download-progress", (progress) => {
        if (appUpdateState.status !== "downloading")
            return;
        publishAppUpdateState({
            ...appUpdateState,
            downloadPercent: Math.max(0, Math.min(100, Math.round(progress.percent))),
        });
    });
    if (electron_1.app.isPackaged && !electron_is_dev_1.default) {
        electron_updater_1.autoUpdater.setFeedURL({
            provider: "github",
            owner: "ilovespectra",
            repo: "silo-downloads",
        });
    }
}
function reportStartup(label, ready = false) {
    startupState = {
        ready,
        step: ready
            ? startupState.total
            : Math.min(startupState.step + 1, startupState.total),
        total: startupState.total,
        label,
    };
    runtimeLog("startup-stage", {
        ...startupState,
        elapsedMs: Date.now() - startupStartedAt,
    });
    console.log(`[STARTUP] ${startupState.step}/${startupState.total} ${label} (+${Date.now() - startupStartedAt}ms)`);
    sendToRenderer("startup-progress", startupState);
}
/** Updates what the current step is doing without advancing the step count. */
function reportStartupDetail(label) {
    if (startupState.ready)
        return;
    startupState = { ...startupState, label };
    sendToRenderer("startup-progress", startupState);
}
let mainWindow = null;
let indexStorageDeviceId = null;
let indexStorageAvailable = true;
let indexStorageInitializationDeferred = false;
let activeIndexStorageCacheWrites = 0;
let indexStorageUnavailableMessage = null;
let selectedIndexStorageRoot = indexStorageRoot;
let indexStorageUsingLocalFallback = false;
let indexStorageFallbackEnabled = true;
let indexStorageDestinationAvailable = true;
let indexStorageMessageText = null;
let indexStorageFreeBytes = null;
let indexStorageTransfer = null;
let indexStorageMonitorTimer = null;
let indexStorageMonitorRunning = false;
let indexStorageTransferRunning = false;
let indexStorageRelaunchPending = false;
let indexStorageTransferRetryAt = 0;
let heapPressureMessage = null;
let rendererReady = false;
let shuttingDown = false;
let appUpdateState = {
    status: "unsupported",
    currentVersion: electron_1.app.getVersion(),
    message: "Automatic update checks are available in installed builds.",
};
let appUpdateCheck = null;
let appUpdateInstall = null;
const rendererRecovery = new rendererRecovery_1.RendererRecovery();
let rendererRecoveryTimer = null;
let stateStore;
let hiddenFolderPathCache = new Set();
let semanticIndexer;
let libraryShareServer = null;
let libraryStatsManager = null;
let faceIndexer;
let aestheticScorer;
let petIndexer;
let phoneManager;
let googleManager;
let messageExportCoordinator;
let contactManager;
let geoIndexer;
let thumbnailPregenerator = null;
let audioLibraryCache = null;
let audioInventoryRetryTimer = null;
let audioInventoryRunning = false;
let audioInventoryProgress = null;
let magicLibraryProgress = { analyzed: 0, total: 0, running: false };
let memoryManager;
let memoryExporter;
let memoryExportRunning = false;
let memoryExportCancelRequested = false;
let memoryExportScratch = null;
let memoryPreviewQueue = Promise.resolve();
const memoryPreviewStatus = new Map();
let memoryRenderQueue = Promise.resolve();
const memoryFrameVectors = new Map();
// Session-only: clips whose first frame classified unsafe; rechecked for saved suggestions.
const memoryUnsafeVideoPaths = new Set();
let memoryMetadataSnapshot = null;
const MEMORY_VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm"]);
const MEMORY_PREVIEW_RENDER_VERSION = 7;
const MEMORY_DUPLICATE_SIMILARITY = 0.85;
function memoryFileMetadata(filePath) {
    // getState() deep-clones all state; share one snapshot across a burst of checks.
    const now = Date.now();
    if (!memoryMetadataSnapshot || now - memoryMetadataSnapshot.at > 2000)
        memoryMetadataSnapshot = {
            at: now,
            metadata: stateStore.getState().fileMetadata ?? {},
        };
    const metadata = memoryMetadataSnapshot.metadata;
    return Object.prototype.hasOwnProperty.call(metadata, filePath)
        ? metadata[filePath]
        : undefined;
}
/** Strict and toggle-independent: ignores showNsfw/showBannedPeople and folder reveal views. */
function memoryAllowed(filePath) {
    if (typeof filePath !== "string" || !filePath || filePath.includes("\0"))
        return false;
    if (!stateStore || !faceIndexer)
        return false;
    const hidden = getHiddenFolderPaths();
    // Hidden-folder entries may be directories; their descendants are hidden too.
    for (let current = filePath;;) {
        if (hidden.has(current))
            return false;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    if (faceIndexer.getBannedPhotoPaths().has(filePath) ||
        semanticUnsafePaths.has(filePath) ||
        memoryUnsafeVideoPaths.has(filePath))
        return false;
    return !(0, contentPolicy_1.fileTextLooksExplicit)({ name: path.basename(filePath), path: filePath }, memoryFileMetadata(filePath));
}
async function memoryLiveVideo(file) {
    if (file.type !== "image" || isRemotePath(file.path))
        return undefined;
    const parsed = path.parse(file.path);
    if (![".heic", ".heif", ".jpg", ".jpeg"].includes(parsed.ext.toLowerCase()))
        return undefined;
    const variants = [".mov", ".MOV", ".mp4", ".MP4"].map((ext) => path.join(parsed.dir, parsed.name + ext));
    // Case-insensitive volumes resolve every casing to one file, so all spellings must be allowed.
    if (!variants.every((candidate) => memoryAllowed(candidate)))
        return undefined;
    for (const candidate of variants) {
        if (await fsPromises.stat(candidate).then((s) => s.isFile(), () => false))
            return candidate;
    }
    return undefined;
}
function memoryThumbnailFile(thumbnailUrl) {
    if (!thumbnailUrl)
        return null;
    let parsed;
    try {
        parsed = new URL(thumbnailUrl);
    }
    catch {
        return null;
    }
    const fileName = parsed.pathname.slice(1);
    if (parsed.protocol !== "thumb:" || !/^[a-f0-9]{40}\.jpg$/.test(fileName))
        return null;
    return indexStoragePath("thumbnail-cache", fileName);
}
/** Streams directory entries; never materializes a full listing of a huge folder. */
async function memoryVideoCandidates(directories, limit = 12, entriesPerDirectory = 2000) {
    const found = [];
    for (const directory of directories.slice(0, 4)) {
        if (found.length >= limit)
            break;
        try {
            const dir = await fsPromises.opendir(directory);
            let seen = 0;
            for await (const entry of dir) {
                if (found.length >= limit || ++seen > entriesPerDirectory)
                    break;
                if (!entry.isFile() || !MEMORY_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
                    continue;
                const filePath = path.join(directory, entry.name);
                if (memoryAllowed(filePath))
                    found.push(filePath);
            }
        }
        catch {
            // Unreadable folders contribute no clips.
        }
    }
    return found;
}
function memoryDot(first, second) {
    let sum = 0;
    const length = Math.min(first.length, second.length);
    for (let index = 0; index < length; index++)
        sum += first[index] * second[index];
    return sum;
}
async function filterMemoryPhotos(paths) {
    if (!aestheticScorer || paths.length === 0)
        return [];
    return aestheticScorer.filterSimilar(paths, MEMORY_DUPLICATE_SIMILARITY);
}
async function searchMemoryMedia(query) {
    if (typeof query !== "string" || !query.trim())
        return [];
    if (!semanticIndexer || !faceIndexer)
        throw new Error("Memory search is not ready yet. Try again shortly.");
    const roots = await getAllIndexSources();
    if (roots.length === 0)
        return [];
    // Confidence is similarity * 100; MemoryManager reads only the first 50 hits.
    const matches = await semanticIndexer.search(query, 24, roots);
    const photoCandidates = [];
    const musicDirectories = memoryMusicDirectories();
    for (const file of matches) {
        if (photoCandidates.length >= 120)
            break;
        if (file.type !== "image" || !memoryAllowed(file.path) ||
            !(0, memoryDiscovery_1.isPersonalPhotoPath)(file.path, file.size, musicDirectories))
            continue;
        photoCandidates.push({ path: file.path, name: file.name, type: "image",
            modified: file.modified, size: file.size, score: file.confidence });
    }
    const magic = photoCandidates.length
        ? await aestheticScorer.rankDistinct(photoCandidates.map(({ path: filePath, name, size, modified }) => ({ path: filePath, name, size: size ?? 0, modified })), "variety", MEMORY_DUPLICATE_SIMILARITY)
        : { order: [], scores: {}, analyzed: 0, total: 0, running: false };
    const candidatesByPath = new Map(photoCandidates.map((file) => [file.path, file]));
    const rankedPhotos = magic.order.slice(0, 38).flatMap((filePath) => {
        const candidate = candidatesByPath.get(filePath);
        if (!candidate)
            return [];
        const magicScore = magic.scores[filePath];
        return [{ ...candidate, magicScore: Number.isFinite(magicScore) ? magicScore : -1,
                score: (Number.isFinite(magicScore) ? magicScore : 0) + candidate.score / 1000 }];
    });
    const qualityPhotos = await applyMemoryPhotoQuality(rankedPhotos);
    const photos = (0, memoryTypes_1.selectMemoryPhotoCandidates)(qualityPhotos).map(({ magicScore, ...photo }) => photo);
    // Clips beside matched photos; first frames are classified on demand, never a library rescan.
    const directories = Array.from(new Set(photos
        .filter((file) => !isRemotePath(file.path))
        .map((file) => path.dirname(file.path)))).slice(0, 4);
    const candidates = photos.length ? await memoryVideoCandidates(directories) : [];
    const videos = [];
    if (candidates.length) {
        const [prompt, unsafePrompt, safePrompt] = await semanticIndexer.embedPrompts([
            `a photo of ${query}`,
            `a photo of ${contentPolicy_1.NSFW_VISUAL_PROMPT}`,
            `a photo of ${contentPolicy_1.SAFE_VISUAL_PROMPT}`,
        ]);
        for (const filePath of candidates) {
            try {
                const stat = await fsPromises.stat(filePath);
                if (!stat.isFile())
                    continue;
                const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
                let vector = memoryFrameVectors.get(key);
                if (!vector) {
                    const framePath = memoryThumbnailFile(await getThumbnail(filePath, false, 480));
                    if (!framePath)
                        continue;
                    vector = await semanticIndexer.embedPreviewImage(framePath);
                    if (memoryFrameVectors.size >= 128)
                        memoryFrameVectors.delete(memoryFrameVectors.keys().next().value);
                    memoryFrameVectors.set(key, vector);
                }
                // Same thresholds as SemanticIndexer.classifyUnsafeImages.
                const unsafe = memoryDot(unsafePrompt, vector);
                if (unsafe >= 0.2 && unsafe - memoryDot(safePrompt, vector) >= 0.008) {
                    memoryUnsafeVideoPaths.add(filePath);
                    continue;
                }
                const similarity = memoryDot(prompt, vector);
                if (similarity >= 0.24 && memoryAllowed(filePath))
                    videos.push({ path: filePath, name: path.basename(filePath), type: "video",
                        modified: stat.mtimeMs, score: Math.min(100, similarity * 100) });
            }
            catch { /* A damaged clip must not discard the photo story. */ }
        }
    }
    return [...photos, ...videos].sort((first, second) => second.score - first.score);
}
let memoryTopicProfile = null;
let memoryProfileScheduler = null;
function personalMemoryPhotoFilter() {
    const musicDirectories = memoryMusicDirectories();
    return (file) => (0, memoryDiscovery_1.isPersonalPhotoPath)(file.path, file.size, musicDirectories);
}
/** Incremental, persisted profile of what the archive is about; only changed records are reread. */
function getMemoryTopicProfile() {
    if (!memoryTopicProfile)
        memoryTopicProfile = new memoryTopicProfile_1.MemoryTopicProfile({
            statePath: path.join(electron_1.app.getPath("userData"), "memories", "topic-profile.json"),
            topics: memoryDiscovery_1.MEMORY_CONCEPTS.map((concept) => ({ id: concept.id, prompt: `a photo of ${concept.prompt}` })),
            distractorPrompts: [...memoryDiscovery_1.MEMORY_JUNK_PROMPTS, ...memoryDiscovery_1.MEMORY_PHOTO_PROMPTS],
            revision: () => semanticIndexer.getRevision(),
            records: async () => {
                await semanticIndexer.whenLoaded();
                const personal = personalMemoryPhotoFilter();
                return semanticIndexer.getIndexedImageRecords(await getAllIndexSources()).filter(personal);
            },
            vectors: (paths) => semanticIndexer.getImageVectors(paths),
            embedPrompts: (prompts) => semanticIndexer.embedPrompts(prompts),
            captureTime: async (filePath) => isRemotePath(filePath) ? null : (await readMemoryExif(filePath))?.takenAt || null,
        });
    return memoryTopicProfile;
}
/** Indexing or startup reconciliation is still changing records; profile work waits. */
function memoryProfileBusy() {
    return !semanticIndexer?.isLoaded() ||
        PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status) ||
        semanticIndexer.getReconciliationProgress().running;
}
async function refreshMemoryTopicsAfterIndexing() {
    const result = await getMemoryTopicProfile().refresh();
    runtimeLog("memory-topic-profile", { ...result, sampled: memoryTopicProfile?.getSnapshot()?.sampledPhotos ?? 0 });
    if (!result.changed || !memoryManager)
        return;
    const state = await memoryManager.refreshForProfileChange();
    // Previews render only once indexing is quiet; the next notification retries otherwise.
    if (!memoryProfileBusy())
        await prepareAllMemoryPreviews(state.suggestions);
}
let memoryPhotoPromptVectors = null;
function memoryPromptVectors() {
    if (!memoryPhotoPromptVectors) {
        memoryPhotoPromptVectors = semanticIndexer
            .embedPrompts([...memoryDiscovery_1.MEMORY_JUNK_PROMPTS, ...memoryDiscovery_1.MEMORY_PHOTO_PROMPTS])
            .then((vectors) => ({
            junk: vectors.slice(0, memoryDiscovery_1.MEMORY_JUNK_PROMPTS.length),
            good: vectors.slice(memoryDiscovery_1.MEMORY_JUNK_PROMPTS.length),
        }));
        memoryPhotoPromptVectors.catch(() => { memoryPhotoPromptVectors = null; });
    }
    return memoryPhotoPromptVectors;
}
/** Story photos ranked by how much they look like real moments; screenshots and documents are dropped. */
async function loadMemoryIdeaMedia(paths, modified) {
    const [vectors, prompts] = await Promise.all([
        semanticIndexer.getImageVectors(paths),
        memoryPromptVectors(),
    ]);
    const media = [];
    for (const filePath of paths) {
        const vector = vectors.get(filePath);
        if (!vector)
            continue;
        const good = Math.max(...prompts.good.map((prompt) => memoryDot(prompt, vector)));
        const junk = Math.max(...prompts.junk.map((prompt) => memoryDot(prompt, vector)));
        if (junk > good + 0.01)
            continue;
        media.push({ path: filePath, name: path.basename(filePath), type: "image",
            modified: modified.get(filePath) ?? 0, score: good * 100 });
    }
    if (media.length === 0)
        return [];
    const magic = await aestheticScorer.rankDistinct(media.map((item) => ({
        path: item.path, name: item.name, size: item.size ?? 0, modified: item.modified,
    })), "variety", MEMORY_DUPLICATE_SIMILARITY);
    const candidatesByPath = new Map(media.map((item) => [item.path, item]));
    const rankedPhotos = magic.order.slice(0, 38).flatMap((filePath) => {
        const candidate = candidatesByPath.get(filePath);
        if (!candidate)
            return [];
        const magicScore = magic.scores[filePath];
        return [{ ...candidate, magicScore: Number.isFinite(magicScore) ? magicScore : -1,
                score: (Number.isFinite(magicScore) ? magicScore : 0) + candidate.score / 1000 }];
    });
    const qualityPhotos = await applyMemoryPhotoQuality(rankedPhotos);
    return (0, memoryTypes_1.selectMemoryPhotoCandidates)(qualityPhotos).map(({ magicScore, ...photo }) => photo);
}
const memoryExifCache = new Map();
/** Camera make/model, capture date and pixel size; null when unreadable. */
async function readMemoryExif(filePath) {
    if (memoryExifCache.has(filePath))
        return memoryExifCache.get(filePath);
    let result = null;
    try {
        const data = await exifr.parse(filePath, {
            pick: ["Make", "Model", "DateTimeOriginal", "ExifImageWidth", "ExifImageHeight",
                "ImageWidth", "ImageHeight", "PixelXDimension", "PixelYDimension"],
        });
        if (data) {
            const taken = data.DateTimeOriginal instanceof Date ? data.DateTimeOriginal.getTime() : 0;
            result = {
                camera: Boolean(data.Make || data.Model),
                width: Number(data.ExifImageWidth ?? data.PixelXDimension ?? data.ImageWidth) || 0,
                height: Number(data.ExifImageHeight ?? data.PixelYDimension ?? data.ImageHeight) || 0,
                takenAt: Number.isFinite(taken) ? taken : 0,
            };
        }
    }
    catch {
        result = null;
    }
    if (memoryExifCache.size >= 20000)
        memoryExifCache.delete(memoryExifCache.keys().next().value);
    memoryExifCache.set(filePath, result);
    return result;
}
/**
 * Drops low-resolution and artwork-like images (no camera data and square, like album
 * covers) and favours real camera shots; remote files are kept as-is.
 */
async function applyMemoryPhotoQuality(media) {
    const kept = [];
    for (let start = 0; start < media.length; start += 16) {
        const batch = media.slice(start, start + 16);
        const exif = await Promise.all(batch.map((item) => item.type === "image" && !isRemotePath(item.path) ? readMemoryExif(item.path) : Promise.resolve(null)));
        batch.forEach((item, index) => {
            const data = exif[index];
            if (!data)
                return kept.push(item);
            const long = Math.max(data.width, data.height);
            const short = Math.min(data.width, data.height);
            if (long && (long < 1280 || short < 720))
                return;
            const square = long > 0 && Math.abs(data.width - data.height) / long < 0.02;
            if (!data.camera && !data.takenAt && square)
                return;
            const factor = data.camera ? 1.15 : data.takenAt ? 1 : 0.7;
            kept.push({ ...item, score: item.score * factor,
                ...(data.takenAt ? { modified: data.takenAt } : {}) });
        });
    }
    return kept;
}
let memoryMusicDirectoryCache = null;
/** Folders holding several audio files are album folders; their images are cover art. */
function memoryMusicDirectories() {
    const snapshot = audioLibraryCache?.getSnapshot();
    if (!snapshot)
        return new Set();
    const key = `${snapshot.scannedAt}:${snapshot.files.length}`;
    if (memoryMusicDirectoryCache?.key === key)
        return memoryMusicDirectoryCache.directories;
    const counts = new Map();
    for (const file of snapshot.files) {
        const directory = path.dirname(file.path);
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
    const directories = new Set(Array.from(counts).filter(([, count]) => count >= 3).map(([directory]) => directory));
    memoryMusicDirectoryCache = { key, directories };
    return directories;
}
/**
 * Mines story ideas from every available indexed source: prevalent subjects (CLIP),
 * time (this week N years ago, seasons, years, trips), places, people, pets and
 * user-named folders. One source with a handful of photos is enough.
 */
async function discoverMemoryIdeas() {
    if (!semanticIndexer)
        throw new Error("Memory search is not ready yet.");
    const roots = await getAllIndexSources();
    if (!roots.length)
        return [];
    const personal = personalMemoryPhotoFilter();
    const profile = getMemoryTopicProfile();
    await profile.refresh();
    const images = semanticIndexer.getIndexedImages(roots)
        .filter(personal)
        .map(({ path: filePath, modified }) => ({ path: filePath, modified, captured: profile.captureTimeOf(filePath) }));
    if (images.length < 4)
        return [];
    const modified = new Map(images.map((image) => [image.path, image.captured ?? image.modified]));
    const topics = profile.getSnapshot()?.topics ?? [];
    const concepts = topics.filter((topic) => topic.estimatedCount >= 5).slice(0, 18)
        .map((topic) => ({ id: topic.id, paths: topic.paths.filter(memoryAllowed), count: topic.estimatedCount }));
    const signals = topics.map((topic) => ({ id: topic.id, interest: topic.interest, lift: topic.lift,
        recentCount: topic.recentCount, recentPaths: topic.recentPaths.filter(memoryAllowed) }));
    const places = geoIndexer
        ? getVisibleDemoMapPhotos(geoIndexer.getState().photos, roots).map(({ path: filePath, city, region, country }) => ({ path: filePath, city, region, country }))
        : [];
    const people = faceIndexer
        ? getDemoPeople()
            .filter((person) => person.status !== "banned" && person.photoCount >= 6 &&
            !/^(person|unknown)\s*\d*$/i.test(person.name.trim()))
            .map((person) => ({ name: person.name, paths: faceIndexer.getPerson(person.id)?.photoPaths ?? [] }))
        : [];
    const pets = petIndexer
        ? petIndexer.getClusters().map((cluster) => ({ name: cluster.name, paths: petIndexer.getClusterPhotos(cluster.id) }))
        : [];
    return (0, memoryDiscovery_1.discoverMemoryStories)({ images, places, people, pets, concepts, topics: signals })
        .map((idea) => ({
        key: idea.key, title: idea.title, description: idea.description, query: idea.query, mood: idea.mood,
        load: () => loadMemoryIdeaMedia(idea.paths, modified),
    }));
}
const MEMORY_DEFAULT_MOVIE_DIRECTORY = () => path.join(electron_1.app.getPath("userData"), "memories", "previews");
/** Saved memory movies live in the user's chosen folder when it is reachable. */
async function memoryMovieDirectory() {
    const chosen = (await memoryManager.getSettings()).movieDirectory;
    if (chosen) {
        const directory = path.join(chosen, "Silo Memories");
        if (await fsPromises.mkdir(directory, { recursive: true }).then(() => true, () => false))
            return directory;
    }
    return MEMORY_DEFAULT_MOVIE_DIRECTORY();
}
/** A rendered movie in the active folder, or one left in app storage before the folder changed. */
async function findMemoryMovie(suggestion) {
    const name = memoryPreviewFileName(suggestion);
    for (const directory of new Set([await memoryMovieDirectory(), MEMORY_DEFAULT_MOVIE_DIRECTORY()])) {
        const candidate = path.join(directory, name);
        if (await fsPromises.stat(candidate).then((result) => result.isFile(), () => false))
            return candidate;
    }
    return null;
}
/** Converted copies go to a per-export scratch directory; sources are never written. */
async function prepareMemoryExportImage(localPath) {
    const scratch = memoryExportScratch;
    if (!scratch)
        throw new Error("Memory export is not active.");
    let converted;
    try {
        converted = await getConvertedImageBuffer(localPath, 2048, 90, "memory-image-cache");
    }
    catch {
        // No sips (non-macOS) or undecodable by sips: FFmpeg reads the original read-only.
        return localPath;
    }
    const file = path.join(scratch, `${(0, crypto_1.createHash)("sha1").update(localPath).digest("hex")}.jpg`);
    await fsPromises.writeFile(file, converted, { flag: "wx", mode: 0o600 }).catch((error) => {
        if (error.code !== "EEXIST")
            throw error;
    });
    return file;
}
function memoryExportOptions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const options = value;
    const { minCount, maxCount } = memoryTypes_1.MEMORY_EXPORT_LIMITS;
    const { suggestionId, soundtrackId, count, duration, originalAudio, rightsAcknowledged, orientation } = options;
    if (typeof suggestionId !== "string" || !suggestionId || suggestionId.length > 200 ||
        typeof soundtrackId !== "string" || !soundtrackId || soundtrackId.length > 250 ||
        typeof count !== "number" || !Number.isInteger(count) || count < minCount || count > maxCount ||
        typeof duration !== "number" || !Number.isFinite(duration) || duration !== memoryTypes_1.MEMORY_DURATION_SECONDS ||
        typeof originalAudio !== "number" || !Number.isFinite(originalAudio) || originalAudio < 0 || originalAudio > 1 ||
        (orientation !== undefined && !["auto", "landscape", "portrait"].includes(String(orientation))) ||
        (rightsAcknowledged !== undefined && typeof rightsAcknowledged !== "boolean"))
        return null;
    if (!(0, memoryTypes_1.isMemoryDurationAllowed)(count, duration))
        return null;
    return { suggestionId, soundtrackId, count, duration, originalAudio,
        rightsAcknowledged: rightsAcknowledged === true };
}
/** Re-resolves the saved suggestion and soundtrack against current safety state. */
async function verifyMemoryExport(options) {
    const suggestion = await memoryManager.getSuggestion(options.suggestionId);
    if (!suggestion || suggestion.media.length === 0)
        throw new Error("This memory is no longer available. Refresh suggestions.");
    const minimumCount = Math.min(memoryTypes_1.MEMORY_DEFAULT_SELECTION_COUNT, suggestion.media.length);
    const maximumCount = Math.min(memoryTypes_1.MEMORY_EXPORT_LIMITS.maxCount, suggestion.media.length);
    if (options.count < minimumCount || options.count > maximumCount)
        throw new Error(`Choose ${minimumCount} to ${maximumCount} items to keep this memory moving briskly.`);
    if (!suggestion.media.every((file) => memoryAllowed(file.path) &&
        (!file.liveVideoPath || memoryAllowed(file.liveVideoPath))))
        throw new Error("This memory contains newly hidden photos. Regenerate suggestions before exporting.");
    const soundtrack = await memoryManager.resolveSoundtrack(options.soundtrackId, suggestion.id);
    if (!soundtrack)
        throw new Error("Soundtrack is no longer available.");
    if (soundtrack.source === "library" && (!soundtrack.path || !memoryAllowed(soundtrack.path)))
        throw new Error("Soundtrack is no longer available.");
    return { suggestion, soundtrack };
}
/** Every watchable movie is rendered at the same one-minute length as an export. */
function memoryPreviewOptions(suggestion) {
    const { maxCount } = memoryTypes_1.MEMORY_EXPORT_LIMITS;
    const count = Math.max(1, Math.min(memoryTypes_1.MEMORY_DEFAULT_SELECTION_COUNT, maxCount, suggestion.media.length));
    return {
        suggestionId: suggestion.id,
        count,
        duration: memoryTypes_1.MEMORY_DURATION_SECONDS,
        soundtrackId: suggestion.soundtrackId ?? `original:${suggestion.id}`,
        originalAudio: 0.18,
    };
}
function memoryPreviewFileName(suggestion) {
    const { count, duration } = memoryPreviewOptions(suggestion);
    const selected = suggestion.media.slice(0, count);
    const fingerprint = (0, crypto_1.createHash)("sha256").update(JSON.stringify({
        version: MEMORY_PREVIEW_RENDER_VERSION,
        id: suggestion.id,
        frame: "landscape-16:9",
        media: selected.map(({ path: mediaPath, modified, type, liveVideoPath }) => ({ path: mediaPath, modified, type, liveVideoPath })),
        duration,
        originalAudio: 0.18,
        soundtrack: suggestion.soundtrackId ?? null,
    })).digest("hex");
    return `${fingerprint}.mp4`;
}
/** Movies render in the background, one at a time; cards show live status meanwhile. */
function prepareMemoryPreviews(suggestions) {
    // A story already waiting or rendering is never queued twice.
    const fresh = suggestions.filter((suggestion) => {
        const status = memoryPreviewStatus.get(suggestion.id)?.status;
        return status !== "queued" && status !== "rendering";
    });
    if (!fresh.length)
        return memoryPreviewQueue;
    for (const suggestion of fresh)
        if (memoryPreviewStatus.get(suggestion.id)?.status !== "ready")
            setMemoryPreviewStatus(suggestion.id, { status: "queued" });
    const task = memoryPreviewQueue.catch(() => undefined)
        .then(() => prepareMemoryPreviewsNow(fresh));
    memoryPreviewQueue = task.then(() => undefined, () => undefined);
    return task;
}
/** Visible cards first, then the reserve stockpile, all on the single render queue. */
async function prepareAllMemoryPreviews(visible) {
    const reserve = await memoryManager.getReserve().catch(() => []);
    void prepareMemoryPreviews(visible).catch(() => runtimeLog("memory-preview-error"));
    if (reserve.length)
        void prepareMemoryPreviews(reserve).catch(() => runtimeLog("memory-reserve-preview-error"));
}
let memoryPreviewEmitTimer = null;
function setMemoryPreviewStatus(id, status) {
    memoryPreviewStatus.set(id, status);
    if (memoryPreviewStatus.size > 64)
        memoryPreviewStatus.delete(memoryPreviewStatus.keys().next().value);
    // Progress arrives per frame; the page needs a few updates a second at most.
    if (memoryPreviewEmitTimer)
        return;
    memoryPreviewEmitTimer = setTimeout(() => {
        memoryPreviewEmitTimer = null;
        sendToRenderer("memory-preview-progress", Object.fromEntries(memoryPreviewStatus));
    }, 250);
}
/** Ready/queued/rendering status for each card; a movie on disk is always ready. */
async function memoryPreviewStatuses(suggestions) {
    const result = {};
    for (const suggestion of suggestions) {
        const known = memoryPreviewStatus.get(suggestion.id);
        if (known && known.status !== "ready")
            result[suggestion.id] = known;
        else
            result[suggestion.id] = await findMemoryMovie(suggestion) ? { status: "ready" } : { status: "queued" };
    }
    return result;
}
async function memoryStateWithPreviews(state) {
    const current = state ?? await memoryManager.getState();
    return { ...current, previews: await memoryPreviewStatuses(current.suggestions) };
}
function runMemoryRender(render) {
    const task = memoryRenderQueue.then(render, render);
    memoryRenderQueue = task.then(() => undefined, () => undefined);
    return task;
}
async function prepareMemoryPreviewsNow(suggestions) {
    const cacheDirectory = await memoryMovieDirectory();
    try {
        for (const suggestion of suggestions) {
            const destination = path.join(cacheDirectory, memoryPreviewFileName(suggestion));
            if (await fsPromises.stat(destination).then((result) => result.isFile(), () => false)) {
                setMemoryPreviewStatus(suggestion.id, { status: "ready", progress: 1 });
                continue;
            }
            // Reuse a movie rendered before the folder changed instead of re-rendering it.
            const existing = await findMemoryMovie(suggestion);
            if (existing && existing !== destination) {
                if (await fsPromises.copyFile(existing, destination).then(() => true, () => false)) {
                    setMemoryPreviewStatus(suggestion.id, { status: "ready", progress: 1 });
                    continue;
                }
            }
            // One unavailable source must not block every other story's movie.
            try {
                let options = memoryPreviewOptions(suggestion);
                // An offline music source falls back to the story's own audio rather than no movie.
                const verified = await verifyMemoryExport(options).catch(async (error) => {
                    if (options.soundtrackId === `original:${suggestion.id}`)
                        throw error;
                    options = { ...options, soundtrackId: `original:${suggestion.id}` };
                    return verifyMemoryExport(options);
                });
                const { suggestion: current, soundtrack } = verified;
                await fsPromises.mkdir(cacheDirectory, { recursive: true });
                const scratch = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-memory-preview-"));
                try {
                    await runMemoryRender(async () => {
                        memoryExportScratch = scratch;
                        const startedAt = Date.now();
                        setMemoryPreviewStatus(suggestion.id, { status: "rendering", progress: 0 });
                        try {
                            await memoryExporter.render(current, options, soundtrack, destination, (progress) => {
                                const fraction = progress.total > 0 ? Math.min(0.99, progress.completed / progress.total) : 0;
                                const elapsed = (Date.now() - startedAt) / 1000;
                                setMemoryPreviewStatus(suggestion.id, { status: "rendering", progress: fraction,
                                    ...(fraction > 0.05 ? { etaSeconds: Math.max(1, Math.round(elapsed / fraction * (1 - fraction))) } : {}) });
                            });
                        }
                        finally {
                            memoryExportScratch = null;
                        }
                    });
                }
                finally {
                    await fsPromises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
                }
                setMemoryPreviewStatus(suggestion.id, { status: "ready", progress: 1 });
            }
            catch (error) {
                setMemoryPreviewStatus(suggestion.id, { status: "failed" });
                runtimeLog("memory-preview-skipped", { message: error instanceof Error ? error.message : String(error) });
            }
        }
        // Keep movies of every visible and reserve story; delete only Silo-named leftovers.
        const state = await memoryManager.getState();
        const retained = new Set([...state.suggestions, ...await memoryManager.getReserve(), ...suggestions]
            .map(memoryPreviewFileName));
        const cached = await fsPromises.readdir(cacheDirectory).catch(() => []);
        await Promise.all(cached.filter((name) => /^[a-f0-9]{64}\.mp4$/.test(name) && !retained.has(name))
            .map((name) => fsPromises.unlink(path.join(cacheDirectory, name)).catch(() => undefined)));
    }
    finally {
        memoryExportScratch = null;
    }
}
let thumbnailPregenTimer = null;
const phoneBackupHolds = new Map();
const phoneBackupLastStatus = new Map();
let phoneManagerBackupDestination = null;
let thumbnailPregenDirty = true;
let startupIndexReconciliationSettled = false;
let indexRecovery = null;
let indexRecoveryTimer = null;
let recoverySearchSourcePaths = [];
const queuedRecoveryStageIds = new Set();
const ALL_INDEX_RECOVERY_STAGES = [
    "search",
    "faces",
    "locations",
    "duplicates",
    "pets",
    "thumbnails",
    "audio",
    "quality",
];
let geocoder;
let duplicateManager;
let contentSettingsStore;
let semanticUnsafePaths = new Set();
let safetyScanPromise = null;
let scannedPhoneDevices = [];
let enabledSourcePathCache = new Set();
let enabledSourceCacheReady = false;
let diagnosticsTimer = null;
let heapGuardTimer = null;
let lastIndexDiagnostic = 0;
// localeCompare with options builds a collator per call, which dominates sorts of 100k+ files.
const naturalCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});
let semanticChangesPending = false;
let geoCheckedThisSession = false;
let geoCheckPromise = null;
function requestIndexRecoveryStages(stageIds) {
    stageIds.forEach((id) => queuedRecoveryStageIds.add(id));
    if (!indexRecovery)
        return;
    const requested = Array.from(queuedRecoveryStageIds);
    queuedRecoveryStageIds.clear();
    for (const id of requested)
        void indexRecovery.retry(id).catch((error) => runtimeLog("index-recovery-request-error", {
            stage: id,
            message: error instanceof Error ? error.message : String(error),
        }));
}
function queueIndexRecoveryStages(stageIds) {
    stageIds.forEach((id) => queuedRecoveryStageIds.add(id));
    if (!indexRecovery)
        return;
    const requested = Array.from(queuedRecoveryStageIds);
    queuedRecoveryStageIds.clear();
    for (const id of requested)
        indexRecovery.queue(id);
}
async function retryIndexRecoveryStage(id) {
    if (!indexRecovery) {
        queuedRecoveryStageIds.add(id);
        return;
    }
    await indexRecovery.retry(id);
}
function hasRetryableSearchWork(sourcePaths) {
    return (semanticIndexer.getRetryableErrorCount(sourcePaths) > 0 ||
        semanticIndexer.getSourceCoverageProgress(sourcePaths).errors > 0);
}
function requestSourceProcessingStages(sourcePaths) {
    const stageIds = [
        "faces",
        "locations",
        "duplicates",
        "pets",
        "thumbnails",
        "audio",
        "quality",
    ];
    if (semanticIndexer.getProgress().status === "error" ||
        hasRetryableSearchWork(sourcePaths))
        stageIds.unshift("search");
    requestIndexRecoveryStages(stageIds);
}
const GRID_THUMBNAIL_SIZE = 200;
const PIPELINE_BUSY_STATUSES = new Set([
    "scanning",
    "loading-model",
    "indexing",
]);
// Runs only once CLIP, face clustering, and location indexing have all settled.
function scheduleThumbnailPregeneration(markDirty = false) {
    if (markDirty)
        thumbnailPregenDirty = true;
    if (!thumbnailPregenerator)
        return;
    if (thumbnailPregenTimer)
        clearTimeout(thumbnailPregenTimer);
    thumbnailPregenTimer = setTimeout(() => {
        thumbnailPregenTimer = null;
        if (!thumbnailPregenerator || !thumbnailPregenDirty)
            return;
        const waitMessage = getThumbnailIndexingWaitMessage();
        if (waitMessage)
            return thumbnailPregenerator.setWaiting(waitMessage);
        thumbnailPregenDirty = false;
        void thumbnailPregenerator.start();
    }, 5000);
}
function getThumbnailIndexingWaitMessage() {
    if (indexStorageUnavailableMessage)
        return indexStorageUnavailableMessage;
    if (!semanticIndexer || !faceIndexer || !geoIndexer)
        return "Waiting for indexing services to start…";
    if (!startupIndexReconciliationSettled)
        return "Waiting for search indexing to finish…";
    if (PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status))
        return "Waiting for search indexing to finish…";
    if (PIPELINE_BUSY_STATUSES.has(faceIndexer.getProgress().status))
        return "Waiting for face clustering to finish…";
    if (["loading-model", "clustering"].includes(petIndexer?.getProgress().status))
        return "Waiting for pet clustering to finish…";
    if (magicLibraryProgress.running)
        return "Waiting for photo quality analysis to finish…";
    if (duplicateManager?.getState().status === "scanning")
        return "Waiting for duplicate hashing to finish…";
    if (audioInventoryRunning)
        return "Waiting for recursive audio discovery to finish…";
    if (geoCheckPromise || geoIndexer.getStatus().status === "scanning")
        return "Waiting for location indexing to finish…";
    return null;
}
function kickGeoCheck() {
    if (!geoIndexer || !semanticIndexer)
        return Promise.resolve();
    if (geoCheckPromise)
        return geoCheckPromise;
    geoCheckPromise = getAllIndexSources()
        .then((sources) => geoIndexer.start(semanticIndexer.getIndexedImages(sources), sources))
        .finally(() => {
        geoCheckPromise = null;
    });
    return geoCheckPromise;
}
function registerMediaProtocols() {
    electron_1.protocol.handle("face-crop", async (request) => {
        // Accept legacy absolute-path URLs too, but only ever serve from the active crops directory.
        const fileName = path.basename(decodeURIComponent(new URL(request.url).pathname.slice(1)));
        if (!/^[A-Za-z0-9_-]+\.jpg$/.test(fileName))
            return new Response("Not found", { status: 404 });
        try {
            const data = await fsPromises.readFile(indexStoragePath("face-index", "crops", fileName));
            return new Response(data, {
                headers: {
                    "content-type": "image/jpeg",
                    "cache-control": "no-cache",
                },
            });
        }
        catch {
            return new Response("Not found", { status: 404 });
        }
    });
    const thumbnailDirectory = path.join(indexStorageRoot, "thumbnail-cache");
    electron_1.protocol.handle("thumb", async (request) => {
        const fileName = new URL(request.url).pathname.slice(1);
        // Only content-hash names from getThumbnail are servable; blocks path traversal.
        if (!/^[a-f0-9]{40}\.jpg$/.test(fileName))
            return new Response("Not found", { status: 404 });
        try {
            const data = await fsPromises.readFile(path.join(thumbnailDirectory, fileName));
            return new Response(data, {
                headers: {
                    "content-type": "image/jpeg",
                    "cache-control": "public, max-age=31536000, immutable",
                },
            });
        }
        catch {
            return new Response("Not found", { status: 404 });
        }
    });
    electron_1.protocol.handle("app-media", async (request) => {
        const requested = decodeURIComponent(new URL(request.url).pathname.slice(1));
        try {
            let localPath = requested;
            if (phoneManager?.isPhonePath(requested))
                localPath = await phoneManager.materialize(requested);
            else if (googleManager?.isCloudPath(requested))
                localPath = await googleManager.materialize(requested);
            const { size } = await fsPromises.stat(localPath);
            const range = request.headers.get("range");
            let start = 0;
            let end = Math.max(0, size - 1);
            let statusCode = 200;
            if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
                if (!match || size === 0)
                    return new Response(null, {
                        status: 416,
                        headers: {
                            "content-range": `bytes */${size}`,
                            "accept-ranges": "bytes",
                        },
                    });
                if (match[1]) {
                    start = Number(match[1]);
                    if (match[2])
                        end = Math.min(Number(match[2]), size - 1);
                }
                else {
                    const suffixLength = Number(match[2]);
                    start = Math.max(0, size - suffixLength);
                }
                if (!Number.isSafeInteger(start) ||
                    !Number.isSafeInteger(end) ||
                    start > end ||
                    start >= size)
                    return new Response(null, {
                        status: 416,
                        headers: {
                            "content-range": `bytes */${size}`,
                            "accept-ranges": "bytes",
                        },
                    });
                statusCode = 206;
            }
            const headers = new Headers({
                "accept-ranges": "bytes",
                "access-control-allow-origin": "*",
                "content-type": mime.getType(localPath) || "application/octet-stream",
                "content-length": String(statusCode === 206 ? end - start + 1 : size),
            });
            if (statusCode === 206)
                headers.set("content-range", `bytes ${start}-${end}/${size}`);
            if (request.method === "HEAD")
                return new Response(null, { status: statusCode, headers });
            const stream = fs.createReadStream(localPath, { start, end });
            const body = stream_1.Readable.toWeb(stream);
            return new Response(body, { status: statusCode, headers });
        }
        catch (error) {
            console.error(`[app-media] Could not serve ${requested}:`, error);
            return new Response("Not found", { status: 404 });
        }
    });
}
let phoneDiscoveryTimer = null;
let phoneDiscoveryPromise = null;
const seenReadyPhoneKeys = new Set();
let derivedIndexTimer = null;
let derivedIndexPromise = null;
let derivedIndexRerunRequested = false;
const safetyCachePath = () => indexStoragePath("content-safety-index.json");
const thumbnailMemoryCache = new Map();
const MAX_THUMBNAIL_CACHE_SIZE = 2048; // Limit to 2K cached thumbnails in memory
const MAX_QUEUE_SIZE = 1024; // Limit queue to prevent memory explosion
const thumbnailJobs = [];
let activeThumbnailJobs = 0;
const visibleThumbnailPaths = new Set();
const pendingThumbnails = new Map();
// Content keys that could not be rendered; skips repeated expensive failures until the file changes.
const failedThumbnailKeys = new Set();
function thumbnailJobPriority(job) {
    return visibleThumbnailPaths.has(job.filePath) ? 0 : job.priority;
}
function sortThumbnailJobs() {
    thumbnailJobs.sort((a, b) => thumbnailJobPriority(a) - thumbnailJobPriority(b) ||
        a.queuedAt - b.queuedAt);
}
function shouldHideForContentSafety(file, fileMetadata = stateStore?.getState().fileMetadata, folderHiddenPaths = getHiddenFolderPaths()) {
    const settings = contentSettingsStore?.getPublicSettings();
    if (folderHiddenPaths.has(file.path))
        return true;
    if (!settings?.showBannedPeople &&
        faceIndexer?.getBannedPhotoPaths().has(file.path))
        return true;
    if (settings?.showNsfw)
        return false;
    return (semanticUnsafePaths.has(file.path) ||
        (0, contentPolicy_1.fileTextLooksExplicit)(file, fileMetadata?.[file.path]));
}
function getHiddenFolderPaths(exceptFolderId) {
    if (!exceptFolderId)
        return hiddenFolderPathCache;
    const folders = stateStore?.getState().digitalFolders ?? [];
    const paths = new Set();
    for (const folder of folders) {
        if (!folder.hidden || folder.id === exceptFolderId)
            continue;
        folder.filePaths.forEach((filePath) => paths.add(filePath));
    }
    return paths;
}
function refreshHiddenFolderPathCache() {
    const paths = new Set();
    for (const folder of stateStore?.getState().digitalFolders ?? [])
        if (folder.hidden)
            folder.filePaths.forEach((filePath) => paths.add(filePath));
    hiddenFolderPathCache = paths;
}
function filterForContentSafety(files, exceptFolderId) {
    const settings = contentSettingsStore?.getPublicSettings();
    const folderHiddenPaths = getHiddenFolderPaths(exceptFolderId);
    const banned = settings?.showBannedPeople
        ? null
        : faceIndexer?.getBannedPhotoPaths();
    const visible = files.filter((file) => !folderHiddenPaths.has(file.path) && (!banned || !banned.has(file.path)));
    if (settings?.showNsfw)
        return visible;
    // getState() deep-clones the whole app state, so read it once per batch rather than per file.
    const fileMetadata = stateStore?.getState().fileMetadata;
    return visible.filter((file) => !shouldHideForContentSafety(file, fileMetadata, folderHiddenPaths));
}
/** NSFW filtering only: a person's own page still lists their photos even when they are banned. */
function filterForNsfw(files) {
    const folderHiddenPaths = getHiddenFolderPaths();
    const visible = files.filter((file) => !folderHiddenPaths.has(file.path));
    if (contentSettingsStore?.getPublicSettings().showNsfw)
        return visible;
    const fileMetadata = stateStore?.getState().fileMetadata;
    return visible.filter((file) => !semanticUnsafePaths.has(file.path) &&
        !(0, contentPolicy_1.fileTextLooksExplicit)(file, fileMetadata?.[file.path]));
}
function notifyFolderVisibilityChange(before, after, folderId) {
    const hiddenPaths = Array.from(after).filter((filePath) => !before.has(filePath));
    const unhiddenPaths = Array.from(before).filter((filePath) => !after.has(filePath));
    if (hiddenPaths.length === 0 && unhiddenPaths.length === 0)
        return;
    mainWindow?.webContents.send("content-safety-changed", {
        flaggedCount: semanticUnsafePaths.size,
        folderHiddenPaths: hiddenPaths,
        folderUnhiddenPaths: unhiddenPaths,
        folderId,
    });
}
function filterDuplicateState(state) {
    const hidden = getHiddenFolderPaths();
    if (hidden.size === 0 && !enabledSourceCacheReady)
        return state;
    const groups = state.groups.flatMap((group) => {
        const files = group.files.filter((file) => !hidden.has(file.path) && fileIsInEnabledSource(file.path));
        if (files.length < 2)
            return [];
        const keepPath = files.some((file) => file.path === group.keepPath)
            ? group.keepPath
            : files[0].path;
        return [
            {
                ...group,
                files,
                keepPath,
                reclaimableBytes: files
                    .filter((file) => file.path !== keepPath)
                    .reduce((sum, file) => sum + file.size, 0),
            },
        ];
    });
    const duplicateFiles = groups.reduce((sum, group) => sum + Math.max(0, group.files.length - 1), 0);
    return {
        ...state,
        groups,
        duplicateFiles,
        reclaimableBytes: groups.reduce((sum, group) => sum + group.reclaimableBytes, 0),
    };
}
async function loadSafetyCache() {
    try {
        const stored = JSON.parse(await fsPromises.readFile(safetyCachePath(), "utf8"));
        semanticUnsafePaths = new Set(Array.isArray(stored.paths) ? stored.paths : []);
    }
    catch {
        semanticUnsafePaths = new Set();
    }
}
function refreshSemanticSafetyIndex() {
    if (safetyScanPromise)
        return safetyScanPromise;
    safetyScanPromise = (async () => {
        const sources = await getAllIndexSources();
        const unsafe = await semanticIndexer.classifyUnsafeImages(sources, contentPolicy_1.NSFW_VISUAL_PROMPT, contentPolicy_1.SAFE_VISUAL_PROMPT);
        semanticUnsafePaths = new Set(unsafe);
        const temporaryPath = `${safetyCachePath()}.tmp`;
        await fsPromises.writeFile(temporaryPath, JSON.stringify({ updatedAt: Date.now(), paths: unsafe }));
        await fsPromises.rename(temporaryPath, safetyCachePath());
        mainWindow?.webContents.send("content-safety-changed", {
            flaggedCount: semanticUnsafePaths.size,
        });
    })().finally(() => {
        safetyScanPromise = null;
    });
    return safetyScanPromise;
}
function scheduleDerivedIndexes(delay = 750) {
    if (!geoIndexer || !faceIndexer || !duplicateManager)
        return;
    if (derivedIndexTimer)
        clearTimeout(derivedIndexTimer);
    derivedIndexTimer = setTimeout(() => {
        derivedIndexTimer = null;
        void runDerivedIndexes();
    }, delay);
}
function runDerivedIndexes() {
    // DISABLED: Derived indexing (duplicates, faces, geo) causes memory exhaustion
    // with large collections. Will be re-enabled only on explicit user request.
    console.log("[DERIVED-INDEX] Derived indexing is currently disabled to prevent memory issues");
    return Promise.resolve();
    /*
    if (derivedIndexTimer) {
      clearTimeout(derivedIndexTimer);
      derivedIndexTimer = null;
    }
    if (derivedIndexPromise) {
      derivedIndexRerunRequested = true;
      return derivedIndexPromise;
    }
    derivedIndexPromise = (async () => {
      do {
        derivedIndexRerunRequested = false;
        const sources = await getAllIndexSources();
        if (sources.length === 0) return;
        const indexedImages = semanticIndexer.getIndexedImages(sources);
        const indexedFiles = semanticIndexer.getIndexedFiles(sources);
        runtimeLog("derived-index-start", {
          images: indexedImages.length,
          files: indexedFiles.length,
        });
        const [geoResult, faceResult, duplicateResult] = await Promise.allSettled([
          geoIndexer.start(indexedImages, sources),
          indexedImages.length > 0 ? faceIndexer.start() : Promise.resolve(),
          indexedFiles.length > 0 ? duplicateManager.scan(indexedFiles, sources) : Promise.resolve(),
        ]);
        if (geoResult.status === "rejected")
          runtimeLog("geo-index-error", { message: String(geoResult.reason) });
        if (faceResult.status === "rejected")
          runtimeLog("face-index-error", { message: String(faceResult.reason) });
        if (duplicateResult.status === "rejected")
          runtimeLog("duplicate-index-error", { message: String(duplicateResult.reason) });
        await refreshSemanticSafetyIndex().catch((error) =>
          runtimeLog("content-safety-index-error", {
            message: error instanceof Error ? error.message : String(error),
          }));
        runtimeLog("derived-index-complete", {
          images: indexedImages.length,
          files: indexedFiles.length,
        });
      } while (derivedIndexRerunRequested);
    })().finally(() => {
      derivedIndexPromise = null;
    });
    return derivedIndexPromise;
    */
}
function discoverAndBackupPhones() {
    if (phoneDiscoveryPromise)
        return phoneDiscoveryPromise;
    phoneDiscoveryPromise = (async () => {
        try {
            console.log("[PHONE-DISCOVERY] Starting discovery...");
            const devices = await phoneManager.listDevices();
            const devicesChanged = JSON.stringify(devices) !== JSON.stringify(scannedPhoneDevices);
            console.log(`[PHONE-DISCOVERY] Found ${devices.length} devices:`, devices.map((d) => `${d.platform}:${d.id}:${d.status}`));
            const previousReady = new Set(scannedPhoneDevices
                .filter((device) => device.status === "ready" && device.rootPath)
                .map((device) => device.rootPath));
            scannedPhoneDevices = devices;
            const newlyReadyPaths = devices
                .filter((device) => device.status === "ready" &&
                device.rootPath &&
                !previousReady.has(device.rootPath))
                .map((device) => device.rootPath);
            if (newlyReadyPaths.length > 0) {
                void indexNewSources(newlyReadyPaths, "phone-connected").catch((error) => runtimeLog("phone-source-index-error", { message: String(error) }));
                void refreshAudioInventory(-1).catch((error) => runtimeLog("phone-audio-refresh-error", { message: String(error) }));
                scheduleThumbnailPregeneration(true);
            }
            // Guard IPC send with rendererReady check
            if (devicesChanged &&
                rendererReady &&
                mainWindow?.webContents &&
                !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send("phone-devices-changed", devices);
            }
            const currentReadyKeys = new Set(devices
                .filter((device) => device.status === "ready" && device.rootPath)
                .map((device) => `${device.platform}:${device.id}`));
            console.log(`[PHONE-DISCOVERY] Ready keys:`, Array.from(currentReadyKeys));
            const backupStates = new Map(phoneManager
                .getBackupStates()
                .map((state) => [`${state.platform}:${state.deviceId}`, state]));
            for (const device of devices) {
                if (device.status !== "ready" || !device.rootPath)
                    continue;
                const key = `${device.platform}:${device.id}`;
                const previous = backupStates.get(key);
                // Only start backup if:
                // 1. No previous backup exists (!previous), OR
                // 2. Previous backup failed with error, OR
                // 3. Previous backup completed successfully AND it's been 10+ minutes
                // Do NOT auto-restart interrupted backups (idle/backing-up status)
                const isCompletedBackup = previous?.status === "complete";
                const refreshDue = isCompletedBackup &&
                    (!previous?.lastBackupAt ||
                        Date.now() - previous.lastBackupAt >= 10 * 60 * 1000);
                const shouldStart = !previous || previous.status === "error" || refreshDue;
                console.log(`[PHONE-DISCOVERY] Device ${key}: shouldStart=${shouldStart}, hasPrevious=${!!previous}, status=${previous?.status}, isCompletedBackup=${isCompletedBackup}, refreshDue=${refreshDue}`);
                if (!shouldStart)
                    continue;
                console.log(`[PHONE-DISCOVERY] Triggering backup for ${key}`);
                void phoneManager.backupDevice(device).then((progress) => {
                    console.log(`[PHONE-DISCOVERY] Backup finished for ${key}:`, progress.status);
                    runtimeLog("phone-backup-finished", {
                        deviceId: progress.deviceId,
                        platform: progress.platform,
                        status: progress.status,
                        completedFiles: progress.completedFiles,
                        totalFiles: progress.totalFiles,
                    });
                });
            }
            await getEnabledIndexSources();
            seenReadyPhoneKeys.clear();
            for (const key of currentReadyKeys)
                seenReadyPhoneKeys.add(key);
        }
        catch (error) {
            console.error("[PHONE-DISCOVERY] Caught error:", error);
            runtimeLog("phone-discovery-error", {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
        }
    })().finally(() => {
        phoneDiscoveryPromise = null;
    });
    return phoneDiscoveryPromise;
}
function queueThumbnail(filePath, job, urgent = false) {
    return new Promise((resolve, reject) => {
        // Reject immediately if queue is critically overloaded (drop non-visible items)
        if (thumbnailJobs.length >= MAX_QUEUE_SIZE) {
            const isVisible = urgent || visibleThumbnailPaths.has(filePath);
            if (!isVisible) {
                reject(new Error("Queue full, dropping non-visible thumbnail request"));
                return;
            }
            // For visible items, still queue but warn
            if (thumbnailJobs.length > MAX_QUEUE_SIZE * 1.5) {
                console.warn(`[MEMORY] Thumbnail queue critically large: ${thumbnailJobs.length} items`);
            }
        }
        // Periodically clean old entries from memory cache if it's growing too large
        if (thumbnailMemoryCache.size > MAX_THUMBNAIL_CACHE_SIZE) {
            const entriesToDelete = Array.from(thumbnailMemoryCache.keys()).slice(0, Math.floor(MAX_THUMBNAIL_CACHE_SIZE * 0.2)); // Delete oldest 20%
            for (const key of entriesToDelete) {
                thumbnailMemoryCache.delete(key);
            }
            console.log(`[MEMORY] Pruned thumbnail cache to ${thumbnailMemoryCache.size} items`);
        }
        const isVisible = visibleThumbnailPaths.has(filePath);
        const priority = urgent || isVisible ? 0 : 1000;
        thumbnailJobs.push({
            execute: () => {
                activeThumbnailJobs += 1;
                void job()
                    .then(resolve, reject)
                    .finally(() => {
                    activeThumbnailJobs -= 1;
                    runThumbnailJobs();
                });
            },
            filePath,
            priority,
            queuedAt: Date.now(),
        });
        sortThumbnailJobs();
        runThumbnailJobs();
    });
}
function runThumbnailJobs() {
    while (activeThumbnailJobs < 6 && thumbnailJobs.length > 0) {
        const job = thumbnailJobs.shift();
        job.execute();
    }
}
async function getConvertedImageBuffer(filePath, maxDimension, quality, cacheName) {
    const stats = await fsPromises.stat(filePath);
    const cacheDirectory = indexStoragePath(cacheName);
    const cacheKey = (0, crypto_1.createHash)("sha1")
        .update(`${filePath}:${stats.size}:${stats.mtimeMs}:${maxDimension}:${quality}`)
        .digest("hex");
    const cachePath = path.join(cacheDirectory, `${cacheKey}.jpg`);
    try {
        return await fsPromises.readFile(cachePath);
    }
    catch {
        // Cache miss.
    }
    if (process.platform !== "darwin")
        throw new Error("This image format is not supported on this platform.");
    await fsPromises.mkdir(cacheDirectory, { recursive: true });
    const temporaryPath = `${cachePath}.partial.jpg`;
    try {
        await execFileAsync("sips", [
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            String(quality),
            "-Z",
            String(maxDimension),
            filePath,
            "--out",
            temporaryPath,
        ]);
        const converted = await fsPromises.readFile(temporaryPath);
        await fsPromises.rename(temporaryPath, cachePath);
        return converted;
    }
    finally {
        await fsPromises.rm(temporaryPath, { force: true });
    }
}
async function quickLookThumbnail(filePath, size) {
    const outputDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-ql-"));
    try {
        await execFileAsync("qlmanage", ["-t", "-s", String(size), "-o", outputDirectory, filePath], { timeout: 15000 });
        const [output] = await fsPromises.readdir(outputDirectory);
        if (!output)
            throw new Error("QuickLook produced no thumbnail");
        const image = electron_1.nativeImage.createFromPath(path.join(outputDirectory, output));
        if (image.isEmpty())
            throw new Error("QuickLook thumbnail was empty");
        return image.toJPEG(65);
    }
    finally {
        await fsPromises.rm(outputDirectory, { recursive: true, force: true });
    }
}
async function sipsThumbnail(filePath, size) {
    const outputDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-sips-"));
    const outputPath = path.join(outputDirectory, "thumb.jpg");
    try {
        // sips decodes by content, so mislabeled extensions (e.g. JPEG saved as .PNG) still work.
        await execFileAsync("sips", [
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "70",
            "-Z",
            String(size),
            filePath,
            "--out",
            outputPath,
        ], { timeout: 20000 });
        const buffer = await fsPromises.readFile(outputPath);
        if (buffer.length === 0)
            throw new Error("sips produced an empty thumbnail");
        return buffer;
    }
    finally {
        await fsPromises.rm(outputDirectory, { recursive: true, force: true });
    }
}
async function renderThumbnail(filePath, mimeType, size = 480) {
    const isImage = mimeType.startsWith("image/");
    if (mimeType.startsWith("video/")) {
        const outputDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-video-thumb-"));
        const outputPath = path.join(outputDirectory, "frame.jpg");
        try {
            await execFileAsync(getFfmpegPath(), [
                "-y",
                "-loglevel",
                "error",
                "-ss",
                "0",
                "-i",
                filePath,
                "-frames:v",
                "1",
                "-vf",
                `scale='min(${size},iw)':-2`,
                "-q:v",
                "3",
                outputPath,
            ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
            const frame = await fsPromises.readFile(outputPath);
            if (frame.length > 0)
                return frame;
        }
        catch {
            // Fall back to the platform thumbnail provider below.
        }
        finally {
            await fsPromises.rm(outputDirectory, { recursive: true, force: true });
        }
    }
    // QuickLook returns a generic document icon (not an error) when it can't preview a file,
    // so for images a real decode must come first or the icon gets cached as the thumbnail.
    if (isImage && process.platform === "darwin") {
        try {
            return await sipsThumbnail(filePath, size);
        }
        catch {
            // Fall through to QuickLook.
        }
    }
    if (isImage) {
        const image = electron_1.nativeImage.createFromPath(filePath);
        if (!image.isEmpty()) {
            const { width, height } = image.getSize();
            const scale = Math.min(1, size / Math.max(width, height));
            return image
                .resize({
                width: Math.max(1, Math.round(width * scale)),
                quality: "good",
            })
                .toJPEG(70);
        }
    }
    try {
        const thumbnail = await electron_1.nativeImage.createThumbnailFromPath(filePath, {
            width: size,
            height: Math.round(size * 0.6875),
        });
        if (!thumbnail.isEmpty())
            return thumbnail.toJPEG(70);
    }
    catch {
        // Fall through to qlmanage.
    }
    if (process.platform === "darwin")
        return quickLookThumbnail(filePath, size);
    throw new Error("Thumbnail unavailable");
}
const THUMBNAIL_CACHE_VERSION = "3";
let thumbnailCacheReady = null;
/** Version 1 stored QuickLook placeholder icons as thumbnails; move that cache aside and delete it in the background. */
function ensureThumbnailCacheVersion() {
    thumbnailCacheReady ?? (thumbnailCacheReady = (async () => {
        const cacheDirectory = path.join(indexStorageRoot, "thumbnail-cache");
        const versionPath = path.join(cacheDirectory, ".version");
        const current = await fsPromises
            .readFile(versionPath, "utf8")
            .catch(() => null);
        if (current?.trim() === THUMBNAIL_CACHE_VERSION)
            return;
        const stale = `${cacheDirectory}-stale-${Date.now()}`;
        await fsPromises.rename(cacheDirectory, stale).catch(() => undefined);
        void fsPromises
            .rm(stale, { recursive: true, force: true })
            .catch(() => undefined);
        await fsPromises.mkdir(cacheDirectory, { recursive: true });
        await fsPromises.writeFile(versionPath, THUMBNAIL_CACHE_VERSION);
    })());
    return thumbnailCacheReady;
}
async function getThumbnail(filePath, force = false, size = 480) {
    await ensureThumbnailCacheVersion();
    const stats = await fsPromises.stat(filePath);
    const mimeType = mime.getType(filePath);
    // Support both images and videos
    if (!mimeType?.startsWith("image/") && !mimeType?.startsWith("video/"))
        return null;
    const cacheKey = (0, crypto_1.createHash)("sha1")
        .update(`${mimeType.startsWith("video/") ? "video-frame-v1" : `v${THUMBNAIL_CACHE_VERSION}`}:${size}:${filePath}:${stats.size}:${stats.mtimeMs}`)
        .digest("hex");
    if (force)
        failedThumbnailKeys.delete(cacheKey);
    const memoryHit = thumbnailMemoryCache.get(cacheKey);
    if (memoryHit)
        return memoryHit;
    if (failedThumbnailKeys.has(cacheKey))
        return null;
    const cacheDirectory = indexStoragePath("thumbnail-cache");
    const cachePath = path.join(cacheDirectory, `${cacheKey}.jpg`);
    try {
        await fsPromises.access(cachePath);
    }
    catch {
        let thumbnailBuffer;
        try {
            thumbnailBuffer = await renderThumbnail(filePath, mimeType, size);
        }
        catch {
            failedThumbnailKeys.add(cacheKey);
            return null;
        }
        await fsPromises.mkdir(cacheDirectory, { recursive: true });
        await fsPromises.writeFile(cachePath, thumbnailBuffer);
    }
    // A URL keeps image bytes out of both JS heaps and out of the IPC channel.
    const thumbnailUrl = `thumb://local/${cacheKey}.jpg`;
    if (thumbnailMemoryCache.size >= MAX_THUMBNAIL_CACHE_SIZE) {
        const oldestKey = thumbnailMemoryCache.keys().next().value;
        if (oldestKey)
            thumbnailMemoryCache.delete(oldestKey);
    }
    thumbnailMemoryCache.set(cacheKey, thumbnailUrl);
    return thumbnailUrl;
}
const sourceClonePlans = new Map();
const sourceCloneOperations = new Map();
const sourceCloneStatusPath = path.join(electron_1.app.getPath("userData"), "source-clone-status.json");
let sourceCloneStatusCache = null;
let sourceCloneStatusWrite = Promise.resolve();
const shelterDestinationPath = path.join(electron_1.app.getPath("userData"), "shelter-destination.json");
let shelterDestinationCache;
async function getShelterDestination() {
    if (shelterDestinationCache !== undefined)
        return shelterDestinationCache;
    try {
        const stored = JSON.parse(await fsPromises.readFile(shelterDestinationPath, "utf8"));
        shelterDestinationCache = typeof stored.destination === "string" ? stored.destination : null;
    }
    catch {
        shelterDestinationCache = null;
    }
    return shelterDestinationCache ?? null;
}
async function setShelterDestination(destination) {
    if (destination !== null && (typeof destination !== "string" || !path.isAbsolute(destination)))
        throw new Error("Choose a valid absolute shelter folder.");
    const resolved = typeof destination === "string"
        ? await fsPromises.realpath(destination)
        : null;
    if (resolved) {
        await fsPromises.access(resolved, fs.constants.R_OK | fs.constants.W_OK);
        const stats = await fsPromises.stat(resolved);
        if (!stats.isDirectory())
            throw new Error("The shelter destination must be a folder.");
    }
    const temporaryPath = `${shelterDestinationPath}.tmp`;
    await fsPromises.mkdir(path.dirname(shelterDestinationPath), { recursive: true });
    await fsPromises.writeFile(temporaryPath, JSON.stringify({ destination: resolved }), { mode: 0o600 });
    await fsPromises.rename(temporaryPath, shelterDestinationPath);
    shelterDestinationCache = resolved;
    return resolved;
}
async function getShelterDestinationState() {
    const destination = await getShelterDestination();
    if (!destination)
        return { destination: null, available: false };
    try {
        await fsPromises.access(destination, fs.constants.R_OK);
        const [resolved, stats] = await Promise.all([
            fsPromises.realpath(destination),
            fsPromises.stat(destination),
        ]);
        return {
            destination,
            available: stats.isDirectory() && resolved === destination,
        };
    }
    catch {
        return { destination, available: false };
    }
}
async function getSourceCloneStatus() {
    if (!sourceCloneStatusCache) {
        try {
            const stored = JSON.parse(await fsPromises.readFile(sourceCloneStatusPath, "utf8"));
            sourceCloneStatusCache = stored && typeof stored === "object" ? stored : {};
        }
        catch {
            sourceCloneStatusCache = {};
        }
    }
    return sourceCloneStatusCache;
}
async function persistSourceCloneStatus(update) {
    const status = (await getSourceCloneStatus());
    Object.assign(status, update);
    const snapshot = JSON.stringify(status);
    sourceCloneStatusWrite = sourceCloneStatusWrite.catch(() => undefined).then(async () => {
        await fsPromises.mkdir(path.dirname(sourceCloneStatusPath), { recursive: true });
        await fsPromises.writeFile(`${sourceCloneStatusPath}.tmp`, snapshot, { encoding: "utf8", mode: 0o600 });
        await fsPromises.rename(`${sourceCloneStatusPath}.tmp`, sourceCloneStatusPath);
    });
    await sourceCloneStatusWrite;
}
const documentExtensions = new Set([
    ".csv",
    ".doc",
    ".docx",
    ".epub",
    ".key",
    ".md",
    ".numbers",
    ".ods",
    ".odt",
    ".pages",
    ".pdf",
    ".ppt",
    ".pptx",
    ".rtf",
    ".tex",
    ".txt",
    ".xls",
    ".xlsx",
]);
const archiveExtensions = new Set([
    ".7z",
    ".bz2",
    ".cab",
    ".dmg",
    ".gz",
    ".iso",
    ".rar",
    ".tar",
    ".tgz",
    ".zip",
]);
const videoExtensions = new Set([
    ".3g2",
    ".3gp",
    ".avi",
    ".f4v",
    ".flv",
    ".m2t",
    ".m2ts",
    ".m2v",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp2v",
    ".mp4",
    ".mpe",
    ".mpeg",
    ".mpg",
    ".mts",
    ".mxf",
    ".ogv",
    ".qt",
    ".ts",
    ".vob",
    ".webm",
    ".wmv",
]);
const browserImageTypes = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
]);
function classifyFile(fileName, mimeType) {
    const extension = path.extname(fileName).toLowerCase();
    const mimeGroup = mimeType?.split("/")[0];
    // MIME databases call every .ts file a transport stream; prefer source-code
    // classification here. The preview handler checks packet signatures for playback.
    if (extension === ".ts")
        return "document";
    if (mimeGroup === "video" || videoExtensions.has(extension))
        return "video";
    if (mimeGroup === "image")
        return "image";
    if ((0, audioTypes_1.isAudioFile)(fileName, mimeType))
        return "audio";
    if (mimeGroup === "text" ||
        mimeType === "application/pdf" ||
        (0, documentPreview_1.isDocumentPreviewFile)(fileName) ||
        documentExtensions.has(extension)) {
        return "document";
    }
    if (archiveExtensions.has(extension))
        return "archive";
    return "other";
}
function isPermissionError(error) {
    const code = error?.code;
    return code === "EPERM" || code === "EACCES";
}
async function readFiles(rootPath, exploded, diagnostics, onProgress, sourceRootPath) {
    const results = [];
    const appDataPath = path.resolve(electron_1.app.getPath("userData"));
    const canonicalAppDataPath = await fsPromises
        .realpath(appDataPath)
        .catch(() => appDataPath);
    const canonicalRootPath = await fsPromises
        .realpath(rootPath)
        .catch(() => path.resolve(rootPath));
    const isSiloAppData = (candidatePath) => (0, indexingPathPolicy_1.isAppDataPath)(candidatePath, rootPath, canonicalRootPath, appDataPath, canonicalAppDataPath);
    const machineRoot = sourceRootPath && (0, indexingPathPolicy_1.isMacDataVolumeSourceRoot)(sourceRootPath);
    const machineDevice = machineRoot
        ? await (0, indexingPathPolicy_1.getMacDataVolumeDeviceId)(sourceRootPath)
        : null;
    if ((machineRoot && machineDevice === null) ||
        isSiloAppData(rootPath) || (0, indexingPathPolicy_1.isNonLibraryPath)(rootPath) ||
        (sourceRootPath && (0, indexingPathPolicy_1.isMacDataVolumePathExcluded)(rootPath, sourceRootPath))) {
        if (onProgress)
            onProgress(results);
        return results;
    }
    const pendingDirectories = [rootPath];
    const timeMachine = await (0, timeMachine_1.isTimeMachineDirectory)(rootPath);
    if (diagnostics)
        diagnostics.isTimeMachine = timeMachine;
    let lastProgressEmit = Date.now();
    let lastProgressCount = 0;
    const PROGRESS_BATCH_SIZE = 500;
    const PROGRESS_INTERVAL_MS = 250;
    while (pendingDirectories.length > 0) {
        const directoryPath = pendingDirectories.shift();
        if (isSiloAppData(directoryPath) || (0, indexingPathPolicy_1.isNonLibraryPath)(directoryPath) ||
            (sourceRootPath && (0, indexingPathPolicy_1.isMacDataVolumePathExcluded)(directoryPath, sourceRootPath)))
            continue;
        if (machineDevice !== null) {
            const directoryStats = await fsPromises.stat(directoryPath).catch(() => null);
            if (!directoryStats || directoryStats.dev !== machineDevice)
                continue;
        }
        let entries;
        try {
            entries = await fsPromises.readdir(directoryPath, {
                withFileTypes: true,
            });
        }
        catch (error) {
            if (diagnostics) {
                if (isPermissionError(error))
                    diagnostics.denied += 1;
                else
                    diagnostics.unreadable += 1;
            }
            continue;
        }
        const ENTRY_BATCH_SIZE = 128;
        for (let offset = 0; offset < entries.length; offset += ENTRY_BATCH_SIZE) {
            const entryBatch = entries.slice(offset, offset + ENTRY_BATCH_SIZE);
            const entryResults = await Promise.all(entryBatch.map(async (entry) => {
                if (timeMachine && (0, timeMachine_1.shouldSkipTimeMachineEntry)(entry.name))
                    return null;
                if (entry.isSymbolicLink())
                    return null;
                const fullPath = path.join(directoryPath, entry.name);
                if (isSiloAppData(fullPath) || (0, indexingPathPolicy_1.isNonLibraryPath)(fullPath) ||
                    (sourceRootPath && (0, indexingPathPolicy_1.isMacDataVolumePathExcluded)(fullPath, sourceRootPath)))
                    return null;
                try {
                    let stats;
                    try {
                        stats = await fsPromises.stat(fullPath);
                    }
                    catch (statError) {
                        if (!timeMachine)
                            throw statError;
                        stats = await fsPromises.lstat(fullPath);
                    }
                    if (machineDevice !== null && stats.dev !== machineDevice)
                        return null;
                    const isDirectory = entry.isDirectory() || stats.isDirectory();
                    const extension = isDirectory
                        ? ""
                        : path.extname(entry.name).toLowerCase();
                    const mimeType = isDirectory ? null : mime.getType(entry.name);
                    const type = isDirectory
                        ? "folder"
                        : classifyFile(entry.name, mimeType);
                    const info = {
                        name: entry.name,
                        path: fullPath,
                        relativePath: path.relative(rootPath, fullPath),
                        size: stats.size,
                        modified: stats.mtimeMs,
                        isDirectory,
                        type,
                        extension,
                    };
                    if (timeMachine) {
                        const metadata = (0, timeMachine_1.parseTimeMachineFile)(fullPath, stats.size, stats.mtimeMs, stats.birthtimeMs, stats.mode);
                        if (metadata)
                            info.backupTimestamp = metadata.backupTimestamp;
                    }
                    return {
                        info,
                        directoryPath: isDirectory ? fullPath : null,
                        isDirectChild: directoryPath === rootPath,
                    };
                }
                catch (error) {
                    if (diagnostics) {
                        if (isPermissionError(error))
                            diagnostics.denied += 1;
                        else
                            diagnostics.unreadable += 1;
                    }
                    return null;
                }
            }));
            for (const result of entryResults) {
                if (!result)
                    continue;
                if (exploded && result.directoryPath)
                    pendingDirectories.push(result.directoryPath);
                if (result.isDirectChild || (exploded && !result.info.isDirectory))
                    results.push(result.info);
            }
            const now = Date.now();
            if (onProgress &&
                (results.length - lastProgressCount >= PROGRESS_BATCH_SIZE ||
                    now - lastProgressEmit > PROGRESS_INTERVAL_MS)) {
                onProgress(results);
                lastProgressEmit = now;
                lastProgressCount = results.length;
            }
        }
    }
    // Final progress update with all results
    if (onProgress)
        onProgress(results);
    // Snapshot folders are far more useful newest-first.
    return timeMachine && !exploded
        ? (0, timeMachine_1.sortTimeMachineEntriesAsync)(results)
        : results;
}
async function readReferencedFiles(filePaths) {
    const files = await Promise.all(filePaths.map(async (filePath) => {
        try {
            if (phoneManager?.isPhonePath(filePath))
                return (await phoneManager.statPhoneFile(filePath));
            if (googleManager?.isCloudPath(filePath))
                return (await googleManager.statCloudFile(filePath));
            const stats = await fsPromises.stat(filePath);
            if (!stats.isFile())
                return null;
            const extension = path.extname(filePath).toLowerCase();
            const mimeType = mime.getType(filePath);
            return {
                name: path.basename(filePath),
                path: filePath,
                relativePath: filePath,
                size: stats.size,
                modified: stats.mtimeMs,
                isDirectory: false,
                type: classifyFile(filePath, mimeType),
                extension,
            };
        }
        catch {
            return null;
        }
    }));
    return files.filter((file) => file !== null);
}
const ALL_SOURCES_PATH = "/__sources__/all";
/** Local folders, connected phones and Google accounts presented as one list. */
let sourceListCache = null;
let sourceListCacheAt = 0;
let sourceListPromise = null;
function accessDisplayName() {
    return fullAccessEnabled() ? "Silo" : "Silo Demo";
}
let applicationMenuInstalled = false;
// Keeps the process name, window title, app menu labels and renderer in step with the license.
function applyAccessBranding() {
    const name = accessDisplayName();
    electron_1.app.setName(name);
    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.setTitle(name);
    if (applicationMenuInstalled)
        installApplicationMenu();
    sendToRenderer("lifetime-access-changed", { fullAccess: fullAccessEnabled(), name });
}
function enableLifetimeFeatures() {
    lifetimeLicensed = true;
    sourceListCache = null;
    sourceListCacheAt = 0;
    sourceListPromise = null;
    applyAccessBranding();
    if (!semanticIndexer)
        return;
    semanticIndexer.setDemoFileLimit(fullAccessEnabled() ? null : demoLimits_1.DEMO_LIMITS.files);
    requestIndexRecoveryStages(ALL_INDEX_RECOVERY_STAGES);
}
async function listSources() {
    if (sourceListCache && Date.now() - sourceListCacheAt < 1000)
        return sourceListCache.map((source) => ({ ...source }));
    if (sourceListPromise)
        return (await sourceListPromise).map((source) => ({ ...source }));
    const pending = buildSourceList().then((sources) => (0, demoLimits_1.applyDemoSourceLimit)(sources, fullAccessEnabled(), demoLimits_1.DEMO_LIMITS.sources));
    sourceListPromise = pending;
    try {
        sourceListCache = await pending;
        sourceListCacheAt = Date.now();
        return sourceListCache.map((source) => ({ ...source }));
    }
    finally {
        sourceListPromise = null;
    }
}
async function buildSourceList() {
    const appState = stateStore.getState();
    const disabled = new Set(appState.disabledSourceIds);
    const explicitPhoneChoiceByDevice = new Map();
    for (const sourceId of appState.enabledSourceIds ?? []) {
        const parsed = phoneManager.parsePhonePath(sourceId);
        if (parsed)
            explicitPhoneChoiceByDevice.set(`${parsed.platform}:${parsed.deviceId}`, sourceId);
    }
    const cloneStatus = (await getSourceCloneStatus());
    const sources = [];
    const localSources = await Promise.all(appState.indexSources.map(async (source) => {
        const available = await fsPromises.access(source.path, fs.constants.R_OK).then(() => true, () => false);
        const includesSiloData = await sourceIncludesSiloAppData(source.path);
        return { source, available, includesSiloData };
    }));
    for (const { source, available, includesSiloData } of localSources) {
        const cloned = cloneStatus[source.path];
        const machine = source.kind === "machine";
        sources.push({
            id: source.path,
            kind: machine ? "machine" : "local",
            label: machine ? "This Mac" : source.path.split(path.sep).filter(Boolean).pop() || source.path,
            detail: machine ? "Internal data volume; mounted external volumes are excluded." : source.path,
            rootPath: source.path,
            enabled: !disabled.has(source.path),
            available,
            message: includesSiloData
                ? "Silo's private app data is automatically excluded from indexing."
                : available
                    ? ""
                    : "Source is disconnected or unreadable.",
            ...(cloned ? { lastClonedAt: cloned.lastClonedAt, lastCloneDestination: cloned.destinations.at(-1) } : {}),
        });
    }
    const offlinePhoneBackups = await phoneManager.getOfflineBackups();
    const latestBackupByDevice = new Map();
    for (const backup of offlinePhoneBackups) {
        const key = `${backup.platform}:${backup.id}`;
        const current = latestBackupByDevice.get(key);
        if (!current || backup.snapshotAt > current.snapshotAt)
            latestBackupByDevice.set(key, backup);
    }
    for (const device of scannedPhoneDevices) {
        const id = device.rootPath || `${device.platform}:${device.id}`;
        const isReady = device.status === "ready" && Boolean(device.rootPath);
        const deviceKey = `${device.platform}:${device.id}`;
        const latestBackup = latestBackupByDevice.get(deviceKey);
        const explicitPhoneChoice = explicitPhoneChoiceByDevice.get(deviceKey);
        const cloned = cloneStatus[id];
        const backupState = phoneManager.getBackupStates().find((state) => state.deviceId === device.id && state.platform === device.platform);
        sources.push({
            id,
            kind: device.platform,
            label: device.name,
            detail: device.platform === "ios" ? "iPhone / iPad" : "Android device",
            rootPath: device.rootPath || "",
            enabled: !disabled.has(id) &&
                isReady &&
                (explicitPhoneChoice
                    ? explicitPhoneChoice === id
                    : !latestBackup || disabled.has(latestBackup.rootPath)),
            available: isReady,
            message: device.status === "ready" ? "" : device.message,
            ...(backupState?.lastBackupAt ? { snapshotAt: backupState.lastBackupAt } : {}),
            ...(cloned ? { lastClonedAt: cloned.lastClonedAt, lastCloneDestination: cloned.destinations.at(-1) } : {}),
        });
    }
    const existingPhoneRoots = new Set(sources.filter((source) => source.kind === "ios" || source.kind === "android").map((source) => source.rootPath));
    for (const backup of offlinePhoneBackups) {
        if (existingPhoneRoots.has(backup.rootPath))
            continue;
        const disabledByUser = disabled.has(backup.rootPath);
        const deviceKey = `${backup.platform}:${backup.id}`;
        const latestBackup = latestBackupByDevice.get(deviceKey);
        const explicitPhoneChoice = explicitPhoneChoiceByDevice.get(deviceKey);
        const cloned = cloneStatus[backup.rootPath];
        sources.push({
            id: backup.rootPath,
            kind: backup.platform,
            label: `${backup.name} · Copy from ${new Date(backup.snapshotAt).toLocaleString()}`,
            detail: `${backup.totalFiles.toLocaleString()} accessible files in this dated snapshot`,
            rootPath: backup.rootPath,
            enabled: !disabledByUser &&
                (explicitPhoneChoice
                    ? explicitPhoneChoice === backup.rootPath
                    : backup.snapshotId === latestBackup?.snapshotId),
            available: true,
            message: backup.failedFiles
                ? `${backup.failedFiles} accessible files could not be copied.`
                : "",
            offlineBackup: true,
            snapshotAt: backup.snapshotAt,
            ...(cloned ? { lastClonedAt: cloned.lastClonedAt, lastCloneDestination: cloned.destinations.at(-1) } : {}),
        });
    }
    for (const account of googleManager.getState().accounts) {
        const driveClone = cloneStatus[account.driveRootPath];
        sources.push({
            id: account.driveRootPath,
            kind: "gdrive",
            label: account.email,
            detail: "Google Drive",
            rootPath: account.driveRootPath,
            enabled: !disabled.has(account.driveRootPath),
            available: !account.needsReauth,
            message: account.needsReauth ? "Reconnect this account" : "",
            ...(driveClone ? { lastClonedAt: driveClone.lastClonedAt, lastCloneDestination: driveClone.destinations.at(-1) } : {}),
        });
        if (account.pickedCount > 0) {
            const photosClone = cloneStatus[account.photosRootPath];
            sources.push({
                id: account.photosRootPath,
                kind: "gphotos",
                label: account.email,
                detail: `Google Photos · ${account.pickedCount} picked`,
                rootPath: account.photosRootPath,
                enabled: !disabled.has(account.photosRootPath),
                available: !account.needsReauth,
                message: account.needsReauth ? "Reconnect this account" : "",
                ...(photosClone ? { lastClonedAt: photosClone.lastClonedAt, lastCloneDestination: photosClone.destinations.at(-1) } : {}),
            });
        }
    }
    return sources;
}
async function readSourceFiles(source, exploded, onProgress) {
    const reportedFiles = new Map();
    const annotate = (file) => ({
        ...file,
        sourceId: source.id,
        sourceLabel: source.label,
        ...(source.snapshotAt ? { sourceSnapshotAt: source.snapshotAt } : {}),
    });
    const reportNewFiles = (files, scanned) => {
        if (!onProgress)
            return;
        const delta = [];
        for (const file of files) {
            const previous = reportedFiles.get(file.path);
            if (previous?.file === file)
                continue;
            const annotated = annotate(file);
            const signature = JSON.stringify(annotated);
            if (previous?.signature === signature) {
                reportedFiles.set(file.path, { file, signature });
                continue;
            }
            reportedFiles.set(file.path, { file, signature });
            delta.push(annotated);
        }
        if (delta.length)
            onProgress(delta, scanned, files.filter((file) => file.type === "audio").length);
    };
    let files;
    if (phoneManager.isPhonePath(source.rootPath))
        files = (await (exploded
            ? phoneManager.listPhoneFilesRecursively(source.rootPath)
            : phoneManager.listPhoneFiles(source.rootPath, false)));
    else if (googleManager.isCloudPath(source.rootPath))
        files = (await googleManager.listFiles(source.rootPath, exploded));
    else
        files = await readFiles(source.rootPath, exploded, undefined, (progressFiles) => reportNewFiles(progressFiles, progressFiles.length), source.rootPath);
    reportNewFiles(files, files.length);
    return files.map(annotate);
}
/** The aggregate root lists enabled sources as folders, or discovers each recursive source in parallel. */
async function readAllSources(exploded, onProgress) {
    const enabled = (await listSources()).filter((source) => source.enabled && source.available);
    if (!exploded) {
        return enabled.map((source) => ({
            name: source.label,
            path: source.rootPath,
            relativePath: source.label,
            size: 0,
            modified: Date.now(),
            isDirectory: true,
            type: "folder",
            extension: "",
            sourceId: source.id,
            sourceLabel: source.label,
            ...(source.snapshotAt ? { sourceSnapshotAt: source.snapshotAt } : {}),
        }));
    }
    const results = new Array(enabled.length);
    const scannedBySource = new Array(enabled.length).fill(0);
    const audioBySource = new Array(enabled.length).fill(0);
    const reportedFiles = new Map();
    let nextSource = 0;
    let scanErrors = 0;
    const report = (delta = []) => {
        onProgress?.(delta, scannedBySource.reduce((sum, count) => sum + count, 0), 0, // A recursive scan cannot know the final total until each source completes.
        audioBySource.reduce((sum, count) => sum + count, 0), scanErrors);
    };
    const scanWorker = async () => {
        while (nextSource < enabled.length) {
            const sourceIndex = nextSource++;
            const source = enabled[sourceIndex];
            try {
                results[sourceIndex] = await readSourceFiles(source, true, (sourceDeltas, sourceScanned, sourceAudio) => {
                    scannedBySource[sourceIndex] = sourceScanned;
                    audioBySource[sourceIndex] = sourceAudio;
                    const fresh = sourceDeltas.filter((file) => {
                        const signature = JSON.stringify(file);
                        if (reportedFiles.get(file.path) === signature)
                            return false;
                        reportedFiles.set(file.path, signature);
                        return true;
                    });
                    report(fresh);
                });
                scannedBySource[sourceIndex] = results[sourceIndex].length;
                audioBySource[sourceIndex] = results[sourceIndex].filter((file) => file.type === "audio").length;
                const finalDeltas = results[sourceIndex].filter((file) => {
                    const signature = JSON.stringify(file);
                    if (reportedFiles.get(file.path) === signature)
                        return false;
                    reportedFiles.set(file.path, signature);
                    return true;
                });
                report(finalDeltas);
            }
            catch (error) {
                results[sourceIndex] = [];
                scanErrors += 1;
                runtimeLog("source-scan-error", {
                    sourceId: source.id,
                    message: String(error),
                });
                report();
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, enabled.length) }, () => scanWorker()));
    return results.flat();
}
function isRemotePath(candidate) {
    return ((phoneManager?.isPhonePath(candidate) ?? false) ||
        (googleManager?.isCloudPath(candidate) ?? false));
}
/** Resolves phone and cloud paths to a real local file; passes through local paths. */
async function resolveLocalPath(candidate) {
    if (phoneManager?.isPhonePath(candidate))
        return phoneManager.materialize(candidate);
    if (googleManager?.isCloudPath(candidate))
        return googleManager.materialize(candidate);
    return candidate;
}
function cloneSafeSegment(value) {
    const safe = value
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/\.+$/g, "")
        .trim();
    return safe.slice(0, 100) || "Source";
}
function cloneSafeRelativePath(value) {
    const segments = value.split(/[\\/]+/).filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === ".."))
        throw new Error(`Unsafe source-relative path: ${value}`);
    return path.join(...segments.map(cloneSafeSegment));
}
function sendSourceCloneProgress(progress) {
    sendToRenderer("source-clone-progress", progress);
}
function ensureCloneActive(operationId) {
    if (sourceCloneOperations.get(operationId)?.cancelled)
        throw new Error("Source clone cancelled.");
}
async function hashFile(filePath) {
    const hash = (0, crypto_1.createHash)("sha256");
    for await (const chunk of fs.createReadStream(filePath))
        hash.update(chunk);
    return hash.digest("hex");
}
async function listLocalCloneEntries(root, operationId, onEntry, options = {}) {
    const appDataPath = path.resolve(electron_1.app.getPath("userData"));
    const canonicalAppDataPath = await fsPromises
        .realpath(appDataPath)
        .catch(() => appDataPath);
    const canonicalRootPath = await fsPromises
        .realpath(root)
        .catch(() => path.resolve(root));
    const isSiloAppData = (candidatePath) => (0, indexingPathPolicy_1.isAppDataPath)(candidatePath, root, canonicalRootPath, appDataPath, canonicalAppDataPath);
    const machineRoot = (0, indexingPathPolicy_1.isMacDataVolumeSourceRoot)(root);
    const machineDevice = machineRoot ? await (0, indexingPathPolicy_1.getMacDataVolumeDeviceId)(root) : null;
    if (machineRoot && machineDevice === null)
        throw new Error("Could not verify the internal data-volume boundary; this machine source was not cloned.");
    if (isSiloAppData(root))
        return;
    if (!options.allowMarkedRoot && await (0, indexingPathPolicy_1.isSiloCloneDirectory)(root))
        return;
    const stack = [{ directory: root, relativePath: "" }];
    while (stack.length > 0) {
        ensureCloneActive(operationId);
        const current = stack.pop();
        if ((0, indexingPathPolicy_1.isMacDataVolumePathExcluded)(current.directory, root))
            continue;
        if (machineDevice !== null) {
            const directoryStats = await fsPromises.stat(current.directory).catch(() => null);
            if (!directoryStats || directoryStats.dev !== machineDevice)
                continue;
        }
        if (isSiloAppData(current.directory))
            continue;
        if (!(options.allowMarkedRoot && current.directory === root) &&
            await (0, indexingPathPolicy_1.isSiloCloneDirectory)(current.directory))
            continue;
        const dir = await fsPromises.opendir(current.directory);
        for await (const entry of dir) {
            ensureCloneActive(operationId);
            if (entry.isSymbolicLink())
                continue;
            const absolutePath = path.join(current.directory, entry.name);
            if (options.skipRootManifest && current.directory === root && entry.name === "silo-clone-manifest.json")
                continue;
            if ((0, indexingPathPolicy_1.isMacDataVolumePathExcluded)(absolutePath, root))
                continue;
            if (isSiloAppData(absolutePath))
                continue;
            if (entry.isDirectory() && await (0, indexingPathPolicy_1.isSiloCloneDirectory)(absolutePath))
                continue;
            const relativePath = path.join(current.relativePath, entry.name);
            const stats = await fsPromises.stat(absolutePath);
            if (machineDevice !== null && stats.dev !== machineDevice)
                continue;
            if (stats.isDirectory()) {
                onEntry({
                    sourcePath: absolutePath,
                    destinationRelativePath: relativePath,
                    size: 0,
                    modified: stats.mtimeMs,
                    isDirectory: true,
                });
                stack.push({ directory: absolutePath, relativePath });
            }
            else if (stats.isFile()) {
                onEntry({
                    sourcePath: absolutePath,
                    destinationRelativePath: relativePath,
                    localPath: absolutePath,
                    size: stats.size,
                    modified: stats.mtimeMs,
                    isDirectory: false,
                });
            }
        }
    }
}
async function prepareSourceClone(sourceIds, destinations, operationId, sourceOverrides, prepareOptions = {}) {
    if (!Array.isArray(sourceIds) || sourceIds.length === 0)
        throw new Error("Select at least one available source to clone.");
    if (!Array.isArray(destinations) || destinations.length === 0 || destinations.some((item) => typeof item !== "string" || !path.isAbsolute(item)))
        throw new Error("Choose at least one valid destination folder.");
    const uniqueDestinations = Array.from(new Set(destinations));
    const operation = { cancelled: false };
    sourceCloneOperations.set(operationId, operation);
    const available = sourceOverrides ?? await listSources();
    const selected = available.filter((source) => sourceIds.includes(source.id) && source.available);
    if (selected.length !== new Set(sourceIds).size)
        throw new Error("One or more selected sources are no longer available. Refresh sources and try again.");
    const resolvedDestinations = [];
    for (const destination of uniqueDestinations) {
        await fsPromises.access(destination, fs.constants.R_OK | fs.constants.W_OK);
        const resolved = await fsPromises.realpath(destination);
        for (const source of selected) {
            if (source.kind !== "local" && source.kind !== "machine")
                continue;
            const sourceResolved = await fsPromises.realpath(source.rootPath);
            const relative = path.relative(sourceResolved, resolved);
            if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
                throw new Error(`Destination cannot be inside selected source “${source.label}”. Choose a different folder.`);
        }
        resolvedDestinations.push(resolved);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destinationPlans = [];
    for (const destination of resolvedDestinations) {
        let cloneRoot = path.join(destination, `Silo Source Clone ${timestamp}`);
        let suffix = 2;
        const taken = async (candidate) => (await fsPromises.access(candidate).then(() => true, () => false)) ||
            (await fsPromises.access(`${candidate}${cloneArchive_1.CLONE_ARCHIVE_EXTENSION}`).then(() => true, () => false));
        while (await taken(cloneRoot))
            cloneRoot = path.join(destination, `Silo Source Clone ${timestamp} (${suffix++})`);
        destinationPlans.push({ destination, cloneRoot, freeBytes: 0, shortfallBytes: 0 });
    }
    const entries = [];
    const sourcePrefixes = new Map();
    let scannedEntries = 0;
    const initial = {
        operationId, phase: "scanning", destination: destinationPlans[0].cloneRoot,
        totalSources: selected.length, totalFiles: 0, completedFiles: 0,
        totalBytes: 0, copiedBytes: 0, verifiedFiles: 0, failedFiles: 0,
        currentFile: "", message: "Preparing a read-only source inventory…",
    };
    sendSourceCloneProgress(initial);
    for (const [sourceIndex, source] of selected.entries()) {
        ensureCloneActive(operationId);
        sendSourceCloneProgress({ ...initial, currentFile: source.label,
            message: `Scanning ${source.label} (${sourceIndex + 1} of ${selected.length})…` });
        const prefix = prepareOptions.prefixSources === false
            ? ""
            : `${String(sourceIndex + 1).padStart(2, "0")}-${cloneSafeSegment(source.label)}`;
        sourcePrefixes.set(source.id, prefix);
        if (prefix)
            entries.push({
                sourcePath: source.rootPath,
                destinationRelativePath: prefix,
                sourceId: source.id,
                sourceRelativePath: "",
                size: 0,
                modified: 0,
                isDirectory: true,
            });
        if (source.kind === "local" || source.kind === "machine") {
            await listLocalCloneEntries(source.rootPath, operationId, (entry) => {
                entry.sourceId = source.id;
                entry.sourceRelativePath = entry.destinationRelativePath;
                entry.sourceSize = entry.size;
                entry.sourceModified = entry.modified;
                entry.destinationRelativePath = path.join(prefix, cloneSafeRelativePath(entry.destinationRelativePath));
                entries.push(entry);
                scannedEntries += 1;
                if (scannedEntries % 250 === 0)
                    sendSourceCloneProgress({ ...initial, totalFiles: entries.filter((item) => !item.isDirectory).length,
                        currentFile: entry.destinationRelativePath,
                        message: `Found ${entries.filter((item) => !item.isDirectory).length.toLocaleString()} files so far…` });
            }, {
                allowMarkedRoot: prepareOptions.allowMarkedRoot,
                skipRootManifest: prepareOptions.skipRootManifest,
            });
            continue;
        }
        const remoteEntries = phoneManager.isPhonePath(source.rootPath)
            ? await phoneManager.listPhoneFilesRecursively(source.rootPath)
            : await googleManager.listFilesRecursively(source.rootPath);
        for (const remote of remoteEntries) {
            ensureCloneActive(operationId);
            const relativePath = cloneSafeRelativePath(remote.relativePath || remote.name);
            entries.push({ sourcePath: remote.path, destinationRelativePath: path.join(prefix, relativePath),
                sourceId: source.id, sourceRelativePath: remote.relativePath || remote.name,
                sourceSize: remote.size, sourceModified: remote.modified,
                size: remote.size, modified: remote.modified, isDirectory: remote.isDirectory });
            scannedEntries += 1;
        }
    }
    const configDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-clone-config-"));
    const configArchive = path.join(configDirectory, "silo-config.tar.gz");
    try {
        if (prepareOptions.includeConfig !== false) {
            await (0, configBundle_1.exportConfig)(electron_1.app.getPath("userData"), configArchive, electron_1.app.getVersion(), {}, indexStorageRoot);
            const configStats = await fsPromises.stat(configArchive);
            for (const source of selected) {
                const prefix = sourcePrefixes.get(source.id);
                entries.push({ sourcePath: configArchive, localPath: configArchive,
                    destinationRelativePath: path.join(prefix, "silo-config.tar.gz"),
                    size: configStats.size, modified: configStats.mtimeMs, isDirectory: false });
            }
        }
        if (prepareOptions.replicaSourceManifestPath) {
            const sourceManifestPath = prepareOptions.replicaSourceManifestPath;
            const manifestStats = await fsPromises.stat(sourceManifestPath);
            entries.push({
                sourcePath: sourceManifestPath,
                localPath: sourceManifestPath,
                destinationRelativePath: "silo-source-snapshot-manifest.json",
                size: manifestStats.size,
                modified: manifestStats.mtimeMs,
                isDirectory: false,
            });
        }
        if (prepareOptions.sourceManifest && Array.isArray(prepareOptions.sourceManifest.aliases)) {
            const presentPaths = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.destinationRelativePath));
            for (const alias of prepareOptions.sourceManifest.aliases) {
                if (alias.materialized !== false || typeof alias.path !== "string" ||
                    typeof alias.canonicalPath !== "string" || typeof alias.sha256 !== "string" ||
                    presentPaths.has(alias.path))
                    continue;
                const canonicalPath = path.resolve(selected[0].rootPath, alias.canonicalPath);
                const relative = path.relative(path.resolve(selected[0].rootPath), canonicalPath);
                if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
                    throw new Error("Shelter manifest contains an unsafe duplicate alias.");
                const stats = await fsPromises.stat(canonicalPath);
                entries.push({
                    sourcePath: canonicalPath,
                    localPath: canonicalPath,
                    destinationRelativePath: alias.path,
                    sourceId: selected[0].id,
                    sourceRelativePath: typeof alias.sourceRelativePath === "string" ? alias.sourceRelativePath : alias.path,
                    sourceSize: stats.size,
                    sourceModified: stats.mtimeMs,
                    size: stats.size,
                    modified: stats.mtimeMs,
                    sha256: alias.sha256,
                    duplicateOf: alias.canonicalPath,
                    isDirectory: false,
                });
                presentPaths.add(alias.path);
            }
        }
        const files = entries.filter((entry) => !entry.isDirectory);
        if (files.length === 0)
            throw new Error("The selected sources contain no files to clone.");
        const canonicalByDigest = new Map();
        let totalBytes = 0;
        for (let index = 0; index < files.length; index += 1) {
            ensureCloneActive(operationId);
            const entry = files[index];
            const localPath = entry.localPath ?? await resolveLocalPath(entry.sourcePath);
            const stats = await fsPromises.stat(localPath);
            entry.localPath = localPath;
            entry.size = stats.size;
            entry.modified = stats.mtimeMs;
            const digest = await hashFile(localPath);
            if (entry.sha256 && entry.sha256 !== digest)
                throw new Error(`Shelter alias no longer matches its verified source: ${entry.destinationRelativePath}`);
            entry.sha256 = digest;
            if (entry.duplicateOf) {
                const canonical = entries.find((candidate) => candidate.destinationRelativePath === entry.duplicateOf);
                if (!canonical || canonical.sha256 !== entry.sha256)
                    throw new Error(`Shelter alias target is missing or has changed: ${entry.destinationRelativePath}`);
                continue;
            }
            const canonical = canonicalByDigest.get(entry.sha256);
            if (canonical) {
                if (canonical.size !== entry.size)
                    throw new Error("SHA-256 collision with mismatched file sizes; aborting duplicate elimination.");
                entry.duplicateOf = canonical.destinationRelativePath;
            }
            else {
                canonicalByDigest.set(entry.sha256, entry);
                totalBytes += stats.size;
            }
            if ((index + 1) % 100 === 0 || index + 1 === files.length)
                sendSourceCloneProgress({ ...initial, phase: "checking-space", totalFiles: canonicalByDigest.size,
                    completedFiles: index + 1, totalBytes, currentFile: entry.destinationRelativePath,
                    message: `Hashed ${(index + 1).toLocaleString()} of ${files.length.toLocaleString()} paths · ${canonicalByDigest.size.toLocaleString()} unique files…` });
        }
        const uniqueFiles = files.filter((entry) => !entry.duplicateOf);
        const duplicateFiles = files.length - uniqueFiles.length;
        const destinationDevices = new Map();
        const destinationDeviceByPath = new Map();
        for (const destination of destinationPlans) {
            const [stats, disk] = await Promise.all([
                fsPromises.statfs(destination.destination),
                fsPromises.stat(destination.destination),
            ]);
            const device = String(disk.dev);
            destinationDeviceByPath.set(destination.destination, device);
            const current = destinationDevices.get(device) ?? {
                freeBytes: Number(stats.bavail) * Number(stats.bsize), count: 0,
            };
            current.count += 1;
            destinationDevices.set(device, current);
            destination.freeBytes = current.freeBytes;
        }
        for (const destination of destinationPlans) {
            const group = destinationDevices.get(destinationDeviceByPath.get(destination.destination));
            destination.shortfallBytes = Math.max(0, totalBytes * group.count - group.freeBytes);
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const plan = { id, operationId, destinations: destinationPlans,
            entries, totalFiles: uniqueFiles.length, totalBytes, duplicateFiles,
            sourceLabels: selected.map((source) => source.label), sourceIds: selected.map((source) => source.id), configDirectory,
            replicaOf: prepareOptions.replicaOf,
            sourceManifest: prepareOptions.sourceManifest };
        sourceClonePlans.set(id, plan);
        return { planId: id, destinations: destinationPlans, totalSources: selected.length,
            sourceLabels: plan.sourceLabels, totalFiles: uniqueFiles.length, totalBytes, duplicateFiles };
    }
    catch (error) {
        await fsPromises.rm(configDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
async function findLatestShelterSnapshot() {
    const destination = await getShelterDestination();
    if (!destination)
        return null;
    const root = await fsPromises.realpath(destination).catch(() => null);
    if (!root)
        return null;
    const entries = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => []);
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const snapshotPath = path.join(root, entry.name);
        const manifestPath = path.join(snapshotPath, "silo-clone-manifest.json");
        try {
            const manifest = JSON.parse(await fsPromises.readFile(manifestPath, "utf8"));
            if (manifest.format !== "silo-source-clone" || manifest.version !== 1 || manifest.complete !== true)
                continue;
            const stats = await fsPromises.stat(snapshotPath);
            const createdAt = typeof manifest.createdAt === "string" ? Date.parse(manifest.createdAt) : 0;
            candidates.push({ rootPath: snapshotPath, manifestPath, manifest,
                createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : stats.mtimeMs });
        }
        catch {
            // Ignore incomplete, unreadable, or non-Silo directories.
        }
    }
    candidates.sort((first, second) => second.createdAt - first.createdAt);
    const latest = candidates[0];
    return latest ? { rootPath: latest.rootPath, manifestPath: latest.manifestPath, manifest: latest.manifest } : null;
}
async function prepareShelterReplica(destinations, operationId) {
    const snapshot = await findLatestShelterSnapshot();
    if (!snapshot)
        throw new Error("No fully verified Fallout Shelter snapshot is available to replicate.");
    const sourceStats = await fsPromises.stat(snapshot.rootPath);
    for (const destination of destinations) {
        const resolved = await fsPromises.realpath(destination);
        const relative = path.relative(path.resolve(await getShelterDestination() ?? ""), resolved);
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
            throw new Error("The shelter replica must be outside the primary Fallout Shelter folder.");
        const destinationStats = await fsPromises.stat(resolved);
        if (destinationStats.dev === sourceStats.dev)
            throw new Error("Choose a replica destination on a different physical volume for 3-2-1 protection.");
    }
    const source = {
        id: `shelter-replica:${snapshot.rootPath}`,
        kind: "local",
        label: "Fallout Shelter snapshot",
        detail: "Latest fully verified shelter snapshot",
        rootPath: snapshot.rootPath,
        enabled: true,
        available: true,
        message: "",
    };
    return prepareSourceClone([source.id], destinations, operationId, [source], {
        includeConfig: false,
        allowMarkedRoot: true,
        skipRootManifest: true,
        prefixSources: false,
        replicaOf: snapshot.rootPath,
        replicaSourceManifestPath: snapshot.manifestPath,
        sourceManifest: snapshot.manifest,
    });
}
async function runSourceClone(planId, runOptions = {}) {
    const plan = sourceClonePlans.get(planId);
    if (!plan)
        throw new Error("Clone plan expired. Prepare the source clone again.");
    const { operationId } = plan;
    const operation = sourceCloneOperations.get(operationId);
    if (!operation)
        throw new Error("Clone operation expired.");
    if (plan.destinations.some((destination) => destination.shortfallBytes > 0))
        throw new Error("One or more selected destinations do not have enough free space.");
    const successfulDestinations = [];
    const fingerprints = new Map();
    const sourceFileCounts = new Map();
    for (const entry of plan.entries) {
        if (entry.isDirectory || !entry.sourceId)
            continue;
        sourceFileCounts.set(entry.sourceId, (sourceFileCounts.get(entry.sourceId) ?? 0) + 1);
        let fingerprint = fingerprints.get(entry.sourceId);
        if (!fingerprint) {
            fingerprint = new inventoryFingerprint_1.InventoryFingerprint();
            fingerprints.set(entry.sourceId, fingerprint);
        }
        fingerprint.add(entry.sourceRelativePath ?? entry.destinationRelativePath, Number.isFinite(entry.sourceSize) && (entry.sourceSize ?? -1) >= 0
            ? entry.sourceSize
            : 0, Number.isFinite(entry.sourceModified) ? entry.sourceModified : 0);
    }
    const persistVerifiedDestinations = async () => {
        if (successfulDestinations.length === 0)
            return;
        const lastClonedAt = Date.now();
        const history = (await getSourceCloneStatus());
        const update = {};
        for (const sourceId of plan.sourceIds) {
            const previousRecord = history[sourceId];
            const previous = previousRecord?.destinations ?? [];
            const sourceFingerprint = fingerprints.get(sourceId)?.finish() ?? new inventoryFingerprint_1.InventoryFingerprint().finish();
            const verifiedFiles = sourceFileCounts.get(sourceId) ?? 0;
            const shelterAudits = { ...(previousRecord?.shelterAudits ?? {}) };
            if (verifiedFiles > 0) {
                for (const clonePath of successfulDestinations) {
                    shelterAudits[path.resolve(path.dirname(clonePath))] = {
                        clonePath,
                        lastFullyVerifiedAt: lastClonedAt,
                        lastAttemptAt: lastClonedAt,
                        lastResult: "verified",
                        verifiedFiles,
                        totalFiles: verifiedFiles,
                        sourceFingerprint,
                    };
                }
            }
            update[sourceId] = {
                ...previousRecord,
                lastClonedAt,
                destinations: Array.from(new Set([...previous, ...successfulDestinations])).slice(-32),
                sourceFingerprint,
                sourceFingerprintVersion: 2,
                shelterAudits,
            };
        }
        await persistSourceCloneStatus(update);
    };
    try {
        for (const [destinationIndex, destinationPlan] of plan.destinations.entries()) {
            ensureCloneActive(operationId);
            let completedFiles = 0;
            let copiedBytes = 0;
            let verifiedFiles = 0;
            let failedFiles = 0;
            let lastProgressAt = 0;
            const manifestFiles = [];
            const manifestAliases = [];
            const emit = (phase, currentFile, message, force = false) => {
                const now = Date.now();
                if (!force && now - lastProgressAt < 350)
                    return;
                lastProgressAt = now;
                sendSourceCloneProgress({ operationId, phase, destination: destinationPlan.cloneRoot,
                    totalSources: plan.sourceLabels.length, totalFiles: plan.totalFiles, completedFiles,
                    totalBytes: plan.totalBytes, copiedBytes, verifiedFiles, failedFiles, currentFile,
                    message: `Destination ${destinationIndex + 1} of ${plan.destinations.length}: ${message}` });
            };
            if (runOptions.compress) {
                const archivePath = `${destinationPlan.cloneRoot}${cloneArchive_1.CLONE_ARCHIVE_EXTENSION}`;
                try {
                    const uniqueEntries = plan.entries.filter((item) => !item.isDirectory && !item.duplicateOf);
                    for (const entry of uniqueEntries) {
                        if (!entry.localPath || !entry.sha256)
                            throw new Error(`Missing staged file for ${entry.sourcePath}`);
                        manifestFiles.push({ path: entry.destinationRelativePath, size: entry.size, sha256: entry.sha256,
                            modified: entry.modified, sourceId: entry.sourceId, sourceRelativePath: entry.sourceRelativePath });
                    }
                    for (const entry of plan.entries.filter((item) => !item.isDirectory && item.duplicateOf))
                        manifestAliases.push({ path: entry.destinationRelativePath, canonicalPath: entry.duplicateOf,
                            size: entry.size, sha256: entry.sha256, sourceId: entry.sourceId,
                            sourceRelativePath: entry.sourceRelativePath, materialized: false });
                    const sourceManifest = plan.sourceManifest;
                    const result = await (0, cloneArchive_1.writeCloneArchive)({
                        archivePath,
                        files: uniqueEntries.map((entry) => ({ localPath: entry.localPath, archivePath: entry.destinationRelativePath,
                            size: entry.size, modified: entry.modified, sha256: entry.sha256 })),
                        directories: plan.entries.filter((item) => item.isDirectory)
                            .map((entry) => ({ archivePath: entry.destinationRelativePath, modified: entry.modified || undefined })),
                        isCancelled: () => operation.cancelled,
                        buildManifest: () => ({
                            format: "silo-source-clone", version: 1, container: "zip", createdAt: new Date().toISOString(), complete: true,
                            sourceIds: sourceManifest && Array.isArray(sourceManifest.sourceIds) ? sourceManifest.sourceIds : plan.sourceIds,
                            sourceLabels: sourceManifest && Array.isArray(sourceManifest.sourceLabels) ? sourceManifest.sourceLabels : plan.sourceLabels,
                            ...(plan.replicaOf ? { replicaOf: plan.replicaOf } : {}),
                            totalFiles: plan.totalFiles, totalBytes: plan.totalBytes, duplicatePaths: manifestAliases.length,
                            verifiedFiles: plan.totalFiles, failedFiles: 0, files: manifestFiles, aliases: manifestAliases,
                        }),
                        onProgress: (progress) => {
                            if (progress.phase === "compressing") {
                                copiedBytes = progress.processedBytes;
                                completedFiles = progress.processedFiles;
                                emit("copying", progress.currentFile, `Compressing ${progress.currentFile || "archive"}`);
                            }
                            else {
                                verifiedFiles = progress.processedFiles;
                                emit("verifying", progress.currentFile, `Verifying archive · ${verifiedFiles.toLocaleString()} of ${plan.totalFiles.toLocaleString()} files`);
                            }
                        },
                    });
                    completedFiles = result.storedFiles;
                    verifiedFiles = result.verifiedFiles;
                    copiedBytes = plan.totalBytes;
                    sendSourceCloneProgress({ operationId, phase: "complete", destination: archivePath,
                        totalSources: plan.sourceLabels.length, totalFiles: plan.totalFiles, completedFiles,
                        totalBytes: plan.totalBytes, copiedBytes, verifiedFiles, failedFiles, currentFile: "",
                        message: `Destination ${destinationIndex + 1} of ${plan.destinations.length}: Compressed clone complete. ` +
                            `${verifiedFiles.toLocaleString()} files verified inside ${path.basename(archivePath)} ` +
                            `(${(result.archiveBytes / 1024 ** 3).toFixed(2)} GB).` });
                    successfulDestinations.push(archivePath);
                }
                catch (error) {
                    const cancelled = operation.cancelled;
                    sendSourceCloneProgress({ operationId, phase: cancelled ? "cancelled" : "error", destination: archivePath,
                        totalSources: plan.sourceLabels.length, totalFiles: plan.totalFiles, completedFiles,
                        totalBytes: plan.totalBytes, copiedBytes, verifiedFiles, failedFiles, currentFile: "",
                        message: cancelled
                            ? "Compressed clone cancelled; the partial archive was removed. Originals were not changed."
                            : error instanceof Error ? error.message : String(error) });
                    throw error;
                }
                continue;
            }
            try {
                await fsPromises.mkdir(destinationPlan.cloneRoot, { recursive: false });
                const inProgressMarker = path.join(destinationPlan.cloneRoot, ".silo-clone-in-progress.json");
                await fsPromises.writeFile(inProgressMarker, JSON.stringify({ format: "silo-source-clone", version: 1, startedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
                (0, indexingPathPolicy_1.invalidateSiloCloneDirectoryCache)(destinationPlan.cloneRoot);
                for (const entry of plan.entries.filter((item) => item.isDirectory)) {
                    ensureCloneActive(operationId);
                    const directory = path.resolve(destinationPlan.cloneRoot, entry.destinationRelativePath);
                    if (!directory.startsWith(`${destinationPlan.cloneRoot}${path.sep}`))
                        throw new Error("Unsafe clone directory path.");
                    await fsPromises.mkdir(directory, { recursive: true });
                }
                for (const entry of plan.entries.filter((item) => !item.isDirectory && !item.duplicateOf)) {
                    ensureCloneActive(operationId);
                    const sourcePath = entry.localPath;
                    if (!sourcePath)
                        throw new Error(`Missing staged file for ${entry.sourcePath}`);
                    const destinationPath = path.resolve(destinationPlan.cloneRoot, entry.destinationRelativePath);
                    if (!destinationPath.startsWith(`${destinationPlan.cloneRoot}${path.sep}`))
                        throw new Error("Unsafe clone file path.");
                    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
                    const partialPath = `${destinationPath}.silo-partial`;
                    const sourceHash = (0, crypto_1.createHash)("sha256");
                    const inputStats = await fsPromises.stat(sourcePath);
                    if (inputStats.size !== entry.size || inputStats.mtimeMs !== entry.modified)
                        throw new Error(`Source changed after preflight: ${entry.destinationRelativePath}`);
                    const meter = new stream_1.Transform({
                        transform: (chunk, _encoding, callback) => {
                            try {
                                ensureCloneActive(operationId);
                                sourceHash.update(chunk);
                                copiedBytes += chunk.length;
                                emit("copying", entry.destinationRelativePath, `Copying ${entry.destinationRelativePath}`);
                                callback(null, chunk);
                            }
                            catch (error) {
                                callback(error);
                            }
                        },
                    });
                    try {
                        await (0, promises_1.pipeline)(fs.createReadStream(sourcePath), meter, fs.createWriteStream(partialPath, { flags: "wx" }));
                        const hash = sourceHash.digest("hex");
                        if (hash !== entry.sha256)
                            throw new Error(`Source content changed after hash preflight: ${entry.destinationRelativePath}`);
                        const sourceAfter = await fsPromises.stat(sourcePath);
                        if (sourceAfter.size !== entry.size || sourceAfter.mtimeMs !== entry.modified)
                            throw new Error(`Source changed during copy: ${entry.destinationRelativePath}`);
                        await fsPromises.chmod(partialPath, inputStats.mode & 0o777).catch(() => undefined);
                        await fsPromises.utimes(partialPath, inputStats.atime, inputStats.mtime).catch(() => undefined);
                        await fsPromises.rename(partialPath, destinationPath);
                        manifestFiles.push({ path: entry.destinationRelativePath, size: entry.size, sha256: hash,
                            sourceId: entry.sourceId, sourceRelativePath: entry.sourceRelativePath });
                        completedFiles += 1;
                    }
                    catch (error) {
                        await fsPromises.rm(partialPath, { force: true }).catch(() => undefined);
                        failedFiles += 1;
                        manifestFiles.push({ path: entry.destinationRelativePath, size: entry.size,
                            error: error instanceof Error ? error.message : String(error) });
                        if (operation.cancelled)
                            throw error;
                    }
                }
                for (const record of manifestFiles) {
                    ensureCloneActive(operationId);
                    if (!record.sha256)
                        continue;
                    const copiedHash = await hashFile(path.join(destinationPlan.cloneRoot, record.path));
                    if (copiedHash !== record.sha256) {
                        record.error = "SHA-256 mismatch during verification.";
                        record.sha256 = undefined;
                        failedFiles += 1;
                    }
                    else
                        verifiedFiles += 1;
                    emit("verifying", record.path, `Verified ${verifiedFiles.toLocaleString()} of ${plan.totalFiles.toLocaleString()} files`);
                }
                const hardLinkFallbackCodes = new Set(["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES", "EMLINK"]);
                for (const entry of plan.entries.filter((item) => !item.isDirectory && item.duplicateOf)) {
                    ensureCloneActive(operationId);
                    const sourceStats = await fsPromises.stat(entry.localPath);
                    if (sourceStats.size !== entry.size || sourceStats.mtimeMs !== entry.modified)
                        throw new Error(`Duplicate source changed after hash preflight: ${entry.destinationRelativePath}`);
                    const canonicalPath = path.resolve(destinationPlan.cloneRoot, entry.duplicateOf);
                    const aliasPath = path.resolve(destinationPlan.cloneRoot, entry.destinationRelativePath);
                    if (!canonicalPath.startsWith(`${destinationPlan.cloneRoot}${path.sep}`) ||
                        !aliasPath.startsWith(`${destinationPlan.cloneRoot}${path.sep}`))
                        throw new Error("Unsafe duplicate alias path.");
                    await fsPromises.mkdir(path.dirname(aliasPath), { recursive: true });
                    let materialized = false;
                    try {
                        await fsPromises.link(canonicalPath, aliasPath);
                        const [canonicalStats, aliasStats] = await Promise.all([
                            fsPromises.stat(canonicalPath), fsPromises.stat(aliasPath),
                        ]);
                        if (canonicalStats.dev !== aliasStats.dev || canonicalStats.ino !== aliasStats.ino)
                            throw new Error("Duplicate path is not a hard link to its canonical copy.");
                        materialized = true;
                    }
                    catch (error) {
                        const code = error.code;
                        if (!code || !hardLinkFallbackCodes.has(code))
                            throw error;
                    }
                    manifestAliases.push({
                        path: entry.destinationRelativePath,
                        canonicalPath: entry.duplicateOf,
                        size: entry.size,
                        sha256: entry.sha256,
                        sourceId: entry.sourceId,
                        sourceRelativePath: entry.sourceRelativePath,
                        materialized,
                    });
                }
                const complete = failedFiles === 0 && verifiedFiles === plan.totalFiles;
                const sourceManifest = plan.sourceManifest;
                await fsPromises.writeFile(path.join(destinationPlan.cloneRoot, "silo-clone-manifest.json"), JSON.stringify({
                    format: "silo-source-clone", version: 1, createdAt: new Date().toISOString(), complete,
                    sourceIds: sourceManifest && Array.isArray(sourceManifest.sourceIds) ? sourceManifest.sourceIds : plan.sourceIds,
                    sourceLabels: sourceManifest && Array.isArray(sourceManifest.sourceLabels) ? sourceManifest.sourceLabels : plan.sourceLabels,
                    ...(plan.replicaOf ? { replicaOf: plan.replicaOf } : {}),
                    totalFiles: plan.totalFiles, totalBytes: plan.totalBytes, duplicatePaths: manifestAliases.length,
                    verifiedFiles, failedFiles, files: manifestFiles, aliases: manifestAliases,
                }, null, 2));
                (0, indexingPathPolicy_1.invalidateSiloCloneDirectoryCache)(destinationPlan.cloneRoot);
                await fsPromises.rm(inProgressMarker, { force: true });
                emit(complete ? "complete" : "error", "", complete
                    ? `Clone complete. Verified ${verifiedFiles.toLocaleString()} files with SHA-256, including Silo config/indexes.`
                    : `Clone finished with ${failedFiles.toLocaleString()} file error(s). Originals were not changed.`, true);
                if (!complete)
                    throw new Error(`Verification failed for destination ${destinationPlan.destination}.`);
                successfulDestinations.push(destinationPlan.cloneRoot);
            }
            catch (error) {
                const cancelled = operation.cancelled;
                emit(cancelled ? "cancelled" : "error", "", cancelled
                    ? `Clone cancelled after ${completedFiles.toLocaleString()} files. Originals were not changed.`
                    : error instanceof Error ? error.message : String(error), true);
                throw error;
            }
        }
        await persistVerifiedDestinations();
    }
    catch (error) {
        try {
            await persistVerifiedDestinations();
        }
        catch (persistError) {
            runtimeLog("source-clone-status-persist-error", {
                message: persistError instanceof Error ? persistError.message : String(persistError),
            });
        }
        if (!operation.cancelled)
            throw error;
    }
    finally {
        sourceClonePlans.delete(planId);
        sourceCloneOperations.delete(operationId);
        await fsPromises.rm(plan.configDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
}
function getFfmpegPath() {
    if (!ffmpegStaticPath)
        throw new Error("Bundled FFmpeg is unavailable.");
    return electron_1.app.isPackaged
        ? ffmpegStaticPath.replace("app.asar", "app.asar.unpacked")
        : ffmpegStaticPath;
}
async function getPlayableVideoPath(originalPath, localPath, size, modified) {
    const extension = path.extname(originalPath).toLowerCase();
    if (directlyPlayableVideoExtensions.has(extension)) {
        return { path: localPath, transcoded: false };
    }
    const cacheDirectory = indexStoragePath("media-cache");
    const cacheKey = (0, crypto_1.createHash)("sha1")
        .update(`${originalPath}:${size}:${modified}`)
        .digest("hex");
    const outputPath = path.join(cacheDirectory, `${cacheKey}.mp4`);
    try {
        if ((await fsPromises.stat(outputPath)).size > 0)
            return { path: outputPath, transcoded: true };
    }
    catch {
        // Cache miss.
    }
    let conversion = mediaConversionJobs.get(outputPath);
    if (!conversion) {
        conversion = (async () => {
            await fsPromises.mkdir(cacheDirectory, { recursive: true });
            const temporaryPath = `${outputPath}.partial`;
            try {
                await execFileAsync(getFfmpegPath(), [
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    localPath,
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0?",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "mp4",
                    temporaryPath,
                ], { maxBuffer: 10 * 1024 * 1024 });
                await fsPromises.rename(temporaryPath, outputPath);
                return outputPath;
            }
            finally {
                await fsPromises.rm(temporaryPath, { force: true });
            }
        })().finally(() => mediaConversionJobs.delete(outputPath));
        mediaConversionJobs.set(outputPath, conversion);
    }
    return { path: await conversion, transcoded: true };
}
function getPreloadPath() {
    return path.join(electron_1.app.getAppPath(), "public", "preload.js");
}
async function createWindow() {
    const preloadPath = getPreloadPath();
    mainWindow = new electron_1.BrowserWindow({
        width: 1400,
        height: 900,
        title: accessDisplayName(),
        icon: appIconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: preloadPath,
            sandbox: true,
        },
    });
    const inventoryOwner = mainWindow.webContents.id;
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https://github.com/ilovespectra/silo-downloads/releases/download/") ||
            url.startsWith("https://github.com/ilovespectra/silo-downloads/releases/tag/"))
            void electron_1.shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("destroyed", () => inventoryTransfers.releaseOwner(inventoryOwner));
    mainWindow.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame)
            inventoryTransfers.releaseOwner(inventoryOwner);
    });
    const startUrl = electron_is_dev_1.default
        ? "http://localhost:8787"
        : `file://${path.join(__dirname, "../build/index.html")}`;
    // index.html's <title> would otherwise replace the license-aware title on every load.
    mainWindow.on("page-title-updated", (event) => {
        event.preventDefault();
        mainWindow?.setTitle(accessDisplayName());
    });
    mainWindow.loadURL(startUrl);
    console.log("[RENDERER-LOAD] Loading URL:", startUrl);
    mainWindow.webContents.on("did-finish-load", () => {
        console.log("[RENDERER-LOAD] did-finish-load event fired");
        rendererReady = true;
        if (pendingDemoLimitFeature) {
            const feature = pendingDemoLimitFeature;
            pendingDemoLimitFeature = null;
            sendToRenderer("demo-limit-reached", feature);
        }
        runtimeLog("renderer-loaded");
        // Show the window now that content has loaded
        mainWindow?.show();
        // NOTE: DO NOT schedule derived indexes here - it causes memory exhaustion
        // with 260k+ images. Indexes will be scheduled once initial UI is stable.
    });
    mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        runtimeLog("renderer-load-failed", {
            errorCode,
            errorDescription,
            validatedURL,
            isMainFrame,
        });
    });
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        if (level >= 2)
            runtimeLog("renderer-console-error", {
                message,
                line,
                source: sourceId,
            });
    });
    mainWindow.webContents.on("dom-ready", () => runtimeLog("renderer-dom-ready"));
    mainWindow.webContents.on("unresponsive", () => {
        console.log("[RENDERER-LOAD] unresponsive event fired");
        runtimeLog("renderer-unresponsive");
    });
    mainWindow.webContents.on("responsive", () => runtimeLog("renderer-responsive"));
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
        runtimeLog("render-process-gone", { ...details });
        const window = mainWindow;
        if (!window || window.isDestroyed())
            return;
        rendererReady = false;
        inventoryTransfers.releaseOwner(window.webContents.id);
        const plan = rendererRecovery.plan(details.reason, shuttingDown);
        if (plan.restart) {
            if (rendererRecoveryTimer)
                clearTimeout(rendererRecoveryTimer);
            runtimeLog("renderer-recovery-scheduled", {
                reason: details.reason,
                delayMs: plan.delay,
            });
            rendererRecoveryTimer = setTimeout(() => {
                rendererRecoveryTimer = null;
                if (!shuttingDown && !window.isDestroyed())
                    window.webContents.reload();
            }, plan.delay);
        }
        else if (plan.manual && !shuttingDown) {
            void electron_1.dialog
                .showMessageBox(window, {
                type: "warning",
                title: "Silo interface stopped",
                message: "The interface crashed repeatedly or ran out of memory.",
                detail: "Index data and original files have not been reset. Automatic reloads stopped to prevent a crash loop.",
                buttons: ["Reload interface", "Keep closed"],
                defaultId: 1,
                cancelId: 1,
            })
                .then(({ response }) => {
                if (response === 0 && !shuttingDown && !window.isDestroyed())
                    window.webContents.reload();
            });
        }
    });
    if (electron_is_dev_1.default) {
        mainWindow.webContents.openDevTools();
    }
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}
async function sourceIncludesSiloAppData(sourcePath) {
    if (isRemotePath(sourcePath))
        return false;
    const appDataPath = path.resolve(electron_1.app.getPath("userData"));
    const canonicalAppDataPath = await fsPromises
        .realpath(appDataPath)
        .catch(() => appDataPath);
    const canonicalSourcePath = await fsPromises
        .realpath(sourcePath)
        .catch(() => path.resolve(sourcePath));
    return ((0, indexingPathPolicy_1.isAppDataPath)(sourcePath, sourcePath, canonicalSourcePath, appDataPath, canonicalAppDataPath) ||
        (0, indexingPathPolicy_1.isPathWithin)(appDataPath, sourcePath) ||
        (0, indexingPathPolicy_1.isPathWithin)(canonicalAppDataPath, canonicalSourcePath));
}
async function isSiloAppDataRoot(sourcePath) {
    if (isRemotePath(sourcePath))
        return false;
    const appDataPath = path.resolve(electron_1.app.getPath("userData"));
    const canonicalAppDataPath = await fsPromises
        .realpath(appDataPath)
        .catch(() => appDataPath);
    const canonicalSourcePath = await fsPromises
        .realpath(sourcePath)
        .catch(() => path.resolve(sourcePath));
    return (0, indexingPathPolicy_1.isAppDataPath)(sourcePath, sourcePath, canonicalSourcePath, appDataPath, canonicalAppDataPath);
}
/** Background coverage ignores result-visibility checkboxes. Keep configured
 * local roots even when offline; scanners handle accessibility. Remote roots
 * require a ready device / authorized account. Never update the visibility cache.
 */
async function getAllIndexSources() {
    return getIndexableRootsFromSources(await listSources());
}
async function getIndexableRootsFromSources(sources) {
    const candidates = sources.filter((source) => source.available &&
        source.rootPath.trim() &&
        (fullAccessEnabled() || (source.enabled && !source.demoLocked)) &&
        (!source.offlineBackup || source.enabled));
    const enabledBackupDevices = new Set();
    for (const source of sources) {
        if (!source.offlineBackup || !source.enabled)
            continue;
        const parsed = phoneManager?.parsePhonePath(source.rootPath);
        if (parsed)
            enabledBackupDevices.add(`${parsed.platform}:${parsed.deviceId}`);
    }
    const safeRoots = [];
    for (const source of candidates) {
        if (!(await isSiloAppDataRoot(source.rootPath)))
            safeRoots.push(source.rootPath);
    }
    // Keep live phone roots out when their local copy is already under an indexed
    // folder. Saved copies retain separate virtual roots for source-level filtering.
    const localRoots = safeRoots.filter((root) => !root.startsWith("/__"));
    const covered = (root) => {
        const phonePath = phoneManager?.parsePhonePath(root);
        if (!phonePath || phonePath.offlineBackup)
            return false;
        const { platform, deviceId } = phonePath;
        if (enabledBackupDevices.has(`${platform}:${deviceId}`))
            return true;
        const backupRoot = phoneManager?.getBackupRoot?.(platform, deviceId);
        return Boolean(backupRoot && localRoots.some((local) => (0, indexingPathPolicy_1.isPathWithin)(backupRoot, local)));
    };
    return Array.from(new Set(safeRoots.filter((root) => !covered(root))));
}
async function getEnabledIndexSources() {
    // Selected roots are used only to filter browse/search/map/people results.
    const uniquePaths = Array.from(new Set((await listSources())
        .filter((source) => source.enabled && source.available && source.rootPath.trim())
        .map((source) => source.rootPath)));
    enabledSourcePathCache = new Set(uniquePaths);
    enabledSourceCacheReady = true;
    console.log("[getEnabledIndexSources] Found sources:", uniquePaths);
    return uniquePaths;
}
async function getDemoSourceCount() {
    const roots = new Set((await listSources())
        .filter((source) => source.enabled &&
        source.available &&
        source.rootPath.trim() &&
        !source.demoLocked)
        .map((source) => source.rootPath));
    return roots.size;
}
function fileIsInEnabledSource(filePath, sourcePaths = enabledSourcePathCache) {
    for (const sourcePath of sourcePaths) {
        const prefix = sourcePath.endsWith(path.sep)
            ? sourcePath
            : `${sourcePath}${path.sep}`;
        if (filePath === sourcePath || filePath.startsWith(prefix))
            return true;
    }
    return false;
}
function filterForEnabledSources(files, sourcePaths = enabledSourcePathCache) {
    return files.filter((file) => fileIsInEnabledSource(file.path, sourcePaths));
}
async function indexNewSources(sourcePaths, reason) {
    const activeSources = await getAllIndexSources();
    const added = sourcePaths.filter((sourcePath) => activeSources.includes(sourcePath));
    if (added.length === 0)
        return;
    await semanticIndexer.startWatching(activeSources);
    runtimeLog("auto-index-new-sources", { reason, sources: added });
    void semanticIndexer
        .startFullScan(activeSources)
        .then(() => requestSourceProcessingStages(activeSources))
        .catch((error) => {
        runtimeLog("auto-index-failed", { reason, message: String(error) });
        requestIndexRecoveryStages([
            "search",
            "faces",
            "locations",
            "duplicates",
            "pets",
            "thumbnails",
            "audio",
            "quality",
        ]);
    });
}
async function createUnifiedScanSource() {
    const appDataPath = path.resolve(electron_1.app.getPath("userData"));
    const canonicalAppDataPath = await fsPromises
        .realpath(appDataPath)
        .catch(() => appDataPath);
    return async (sourcePath, onFile, isCancelled) => {
        // Detect source type and delegate to appropriate scanner
        if (phoneManager.isPhonePath(sourcePath)) {
            await phoneManager.listPhoneFilesRecursively(sourcePath, onFile, isCancelled);
            return;
        }
        if (sourcePath.startsWith("/__cloud__/")) {
            // Cloud source: /__cloud__/gdrive/<accountId> or /__cloud__/gphotos/<accountId>
            const cloudType = sourcePath.slice("/__cloud__/".length).split("/")[0];
            const files = await googleManager.listFilesRecursively(sourcePath, onFile, isCancelled);
            for (const file of files) {
                if (isCancelled())
                    return;
                onFile(file);
            }
            return;
        }
        // Local filesystem source
        const canonicalSourcePath = await fsPromises
            .realpath(sourcePath)
            .catch(() => path.resolve(sourcePath));
        const machineRoot = (0, indexingPathPolicy_1.isMacDataVolumeSourceRoot)(sourcePath);
        const machineDevice = machineRoot
            ? await (0, indexingPathPolicy_1.getMacDataVolumeDeviceId)(sourcePath)
            : null;
        if (machineRoot && machineDevice === null)
            return;
        const isSiloAppData = (candidatePath) => (0, indexingPathPolicy_1.isAppDataPath)(candidatePath, sourcePath, canonicalSourcePath, appDataPath, canonicalAppDataPath);
        // A user may add a broad parent such as Home or an external volume. Never
        // treat Silo's private storage as source material; phone snapshots remain
        // indexable via the virtual /__phone__ scanner above.
        if (isSiloAppData(sourcePath) || (0, indexingPathPolicy_1.isNonLibraryPath)(sourcePath))
            return;
        if (await (0, indexingPathPolicy_1.isSiloCloneDirectory)(sourcePath))
            return;
        const results = [];
        const pendingDirectories = [sourcePath];
        const timeMachine = await (0, timeMachine_1.isTimeMachineDirectory)(sourcePath);
        while (pendingDirectories.length > 0 && !isCancelled()) {
            const directoryPath = pendingDirectories.shift();
            if ((0, indexingPathPolicy_1.isMacDataVolumePathExcluded)(directoryPath, sourcePath))
                continue;
            if (machineDevice !== null) {
                const directoryStats = await fsPromises.stat(directoryPath).catch(() => null);
                if (!directoryStats || directoryStats.dev !== machineDevice)
                    continue;
            }
            if (isSiloAppData(directoryPath))
                continue;
            if (await (0, indexingPathPolicy_1.isSiloCloneDirectory)(directoryPath))
                continue;
            let entries;
            try {
                entries = await fsPromises.readdir(directoryPath, {
                    withFileTypes: true,
                });
            }
            catch {
                continue;
            }
            const ENTRY_BATCH_SIZE = 128;
            let processedEntries = 0;
            for (let offset = 0; offset < entries.length; offset += ENTRY_BATCH_SIZE) {
                const entryResults = await Promise.all(entries.slice(offset, offset + ENTRY_BATCH_SIZE).map(async (entry) => {
                    if (timeMachine && (0, timeMachine_1.shouldSkipTimeMachineEntry)(entry.name))
                        return null;
                    if (entry.isSymbolicLink())
                        return null;
                    const fullPath = path.join(directoryPath, entry.name);
                    if ((0, indexingPathPolicy_1.isMacDataVolumePathExcluded)(fullPath, sourcePath))
                        return null;
                    if (isSiloAppData(fullPath))
                        return null;
                    try {
                        let stats;
                        try {
                            stats = await fsPromises.stat(fullPath);
                        }
                        catch {
                            if (!timeMachine)
                                throw new Error("stat failed");
                            stats = await fsPromises.lstat(fullPath);
                        }
                        if (machineDevice !== null && stats.dev !== machineDevice)
                            return null;
                        const isDirectory = entry.isDirectory() || stats.isDirectory();
                        if (isDirectory && await (0, indexingPathPolicy_1.isSiloCloneDirectory)(fullPath))
                            return null;
                        if (isDirectory && (0, indexingPathPolicy_1.isNonLibraryPath)(fullPath))
                            return null;
                        const extension = isDirectory
                            ? ""
                            : path.extname(entry.name).toLowerCase();
                        const mimeType = isDirectory ? null : mime.getType(entry.name);
                        const type = isDirectory
                            ? "folder"
                            : classifyFile(entry.name, mimeType);
                        return {
                            file: {
                                name: entry.name,
                                path: fullPath,
                                relativePath: path.relative(sourcePath, fullPath),
                                size: stats.size,
                                modified: stats.mtimeMs,
                                isDirectory,
                                type,
                                extension,
                            },
                            directoryPath: isDirectory ? fullPath : null,
                        };
                    }
                    catch {
                        return null;
                    }
                }));
                for (const result of entryResults) {
                    processedEntries += 1;
                    if (!result)
                        continue;
                    if (isCancelled())
                        return;
                    onFile(result.file);
                    if (result.directoryPath) {
                        pendingDirectories.push(result.directoryPath);
                    }
                    if (processedEntries % 256 === 0)
                        await new Promise((resolve) => setImmediate(resolve));
                }
            }
        }
    };
}
async function cleanupOldCaches() {
    console.log("[STARTUP] Cleaning up old caches and logs...");
    const userData = electron_1.app.getPath("userData");
    const maxCacheAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const maxLogSize = 500 * 1024 * 1024; // 500MB for all runtime logs
    const now = Date.now();
    // Clean up old runtime logs
    try {
        const diagnosticsDir = path.join(userData, "diagnostics");
        const stats = await fsPromises
            .stat(path.join(diagnosticsDir, "runtime.jsonl"))
            .catch(() => null);
        if (stats && stats.size > maxLogSize) {
            console.log(`[STARTUP] Runtime log is ${(stats.size / 1024 / 1024).toFixed(1)}MB, rotating...`);
            const archivePath = path.join(diagnosticsDir, `runtime-archive-${Date.now()}.jsonl`);
            await fsPromises
                .rename(path.join(diagnosticsDir, "runtime.jsonl"), archivePath)
                .catch(() => { });
        }
    }
    catch (error) {
        console.log("[STARTUP] Error cleaning runtime logs:", error instanceof Error ? error.message : error);
    }
    // Clean up old thumbnail caches (> 7 days)
    try {
        const thumbCache = path.join(userData, "thumbnails");
        const files = await fsPromises.readdir(thumbCache).catch(() => []);
        let removed = 0;
        for (const file of files) {
            try {
                const filePath = path.join(thumbCache, file);
                const stats = await fsPromises.stat(filePath);
                if (now - stats.mtimeMs > maxCacheAge) {
                    await fsPromises.rm(filePath, { force: true });
                    removed += 1;
                }
            }
            catch {
                // Skip on error
            }
        }
        if (removed > 0)
            console.log(`[STARTUP] Removed ${removed} old thumbnail cache files`);
    }
    catch (error) {
        console.log("[STARTUP] Error cleaning thumbnail cache:", error instanceof Error ? error.message : error);
    }
    // Clean up old media conversion cache (> 7 days)
    try {
        const mediaCache = path.join(userData, "media-conversions");
        const files = await fsPromises.readdir(mediaCache).catch(() => []);
        let removed = 0;
        for (const file of files) {
            try {
                const filePath = path.join(mediaCache, file);
                const stats = await fsPromises.stat(filePath);
                if (now - stats.mtimeMs > maxCacheAge) {
                    await fsPromises.rm(filePath, { force: true });
                    removed += 1;
                }
            }
            catch {
                // Skip on error
            }
        }
        if (removed > 0)
            console.log(`[STARTUP] Removed ${removed} old media cache files`);
    }
    catch (error) {
        console.log("[STARTUP] Error cleaning media cache:", error instanceof Error ? error.message : error);
    }
    // Clean up old archive logs (keep only 2 most recent)
    try {
        const diagnosticsDir = path.join(userData, "diagnostics");
        const archives = (await fsPromises.readdir(diagnosticsDir).catch(() => []))
            .filter((f) => f.startsWith("runtime-archive-"))
            .sort();
        if (archives.length > 2) {
            for (const archive of archives.slice(0, archives.length - 2)) {
                await fsPromises
                    .rm(path.join(diagnosticsDir, archive), { force: true })
                    .catch(() => { });
            }
            console.log(`[STARTUP] Cleaned up ${archives.length - 2} old archive logs`);
        }
    }
    catch (error) {
        console.log("[STARTUP] Error cleaning archives:", error instanceof Error ? error.message : error);
    }
    console.log("[STARTUP] Cache cleanup complete");
}
// Schedule periodic cache cleanup (every 6 hours while app is running)
function schedulePeriodicCleanup() {
    setInterval(async () => {
        try {
            await cleanupOldCaches();
        }
        catch (error) {
            console.error("[CLEANUP] Periodic cleanup failed:", error);
        }
    }, 6 * 60 * 60 * 1000); // 6 hours
}
/** Standard menus, except Undo/Redo go to the renderer so they can undo People edits outside text fields. */
function getIndexStorageDestinationLabel() {
    return path.basename(path.resolve(selectedIndexStorageRoot)) || "selected destination";
}
function currentIndexStorageStatus() {
    return {
        message: indexStorageMessageText,
        usingLocalFallback: indexStorageUsingLocalFallback,
        localFallbackEnabled: indexStorageFallbackEnabled,
        destinationAvailable: indexStorageDestinationAvailable,
        selectedDestination: selectedIndexStorageRoot,
        localFreeBytes: indexStorageFreeBytes,
        reserveBytes: indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES,
        transfer: indexStorageTransfer,
    };
}
function publishIndexStorageStatus(message) {
    if (message !== undefined)
        indexStorageMessageText = message;
    sendToRenderer("index-storage-status", currentIndexStorageStatus());
}
function unavailableIndexStorageMessage() {
    const destination = getIndexStorageDestinationLabel();
    if (indexStorageUsingLocalFallback)
        return `Looks like we can’t locate your selected destination, ${destination}. Silo is using the local cache and will move it back automatically when the destination reconnects.`;
    if (indexStorageFallbackEnabled)
        return `Looks like we can’t locate your selected destination, ${destination}. Silo is preparing a local cache fallback and will move it back automatically when the destination reconnects.`;
    return `Looks like we can’t locate your selected destination, ${destination}. Please reconnect it and indexing will resume automatically.`;
}
async function checkSelectedIndexStorageAvailable() {
    const userDataPath = path.resolve(electron_1.app.getPath("userData"));
    if (path.resolve(selectedIndexStorageRoot) === userDataPath)
        return true;
    try {
        const [selectedStats, userDataStats] = await Promise.all([
            fsPromises.stat(selectedIndexStorageRoot),
            fsPromises.stat(userDataPath),
        ]);
        if (selectedStats.dev === userDataStats.dev)
            return false;
        await fsPromises.access(selectedIndexStorageRoot, fs.constants.R_OK | fs.constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function withIndexStorageCacheWrite(operation) {
    if (!indexStorageAvailable)
        throw new Error(indexStorageUnavailableMessage ?? "Index storage is unavailable.");
    const activeRootIsAppData = path.resolve(indexStorageRoot) === path.resolve(electron_1.app.getPath("userData"));
    const activeRootAvailable = activeRootIsAppData
        ? true
        : await fsPromises
            .access(indexStorageRoot, fs.constants.R_OK | fs.constants.W_OK)
            .then(() => true)
            .catch(() => false);
    if (!activeRootAvailable) {
        void monitorIndexStorageAvailability();
        throw new Error(unavailableIndexStorageMessage());
    }
    if (indexStorageUsingLocalFallback) {
        indexStorageFreeBytes = await (0, indexingStorage_1.getLocalIndexStorageFreeBytes)(indexStorageRoot).catch(() => null);
        if (indexStorageFreeBytes === null ||
            indexStorageFreeBytes < indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES) {
            void monitorIndexStorageAvailability();
            throw new Error(`Local cache indexing is paused to preserve at least ${Math.round(indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB of free space.`);
        }
    }
    if (!indexStorageAvailable)
        throw new Error(indexStorageUnavailableMessage ?? "Index storage is unavailable.");
    activeIndexStorageCacheWrites += 1;
    try {
        return await operation();
    }
    finally {
        activeIndexStorageCacheWrites = Math.max(0, activeIndexStorageCacheWrites - 1);
    }
}
function isBusyIndexStatus(status) {
    return ["scanning", "indexing", "loading-model", "clustering", "generating"].includes(status);
}
function indexStorageWritersBusy() {
    return Boolean((semanticIndexer && isBusyIndexStatus(semanticIndexer.getProgress().status)) ||
        (faceIndexer && isBusyIndexStatus(faceIndexer.getProgress().status)) ||
        (geoIndexer && isBusyIndexStatus(geoIndexer.getStatus().status)) ||
        (duplicateManager && duplicateManager.getState().status === "scanning") ||
        (petIndexer && isBusyIndexStatus(petIndexer.getProgress().status)) ||
        audioInventoryRunning ||
        (thumbnailPregenerator && ["scanning", "generating"].includes(thumbnailPregenerator.getProgress().status)) ||
        magicLibraryProgress.running ||
        activeIndexStorageCacheWrites > 0 ||
        Boolean(libraryStatsManager?.getSnapshot().running));
}
async function waitForIndexStorageWritersToPause() {
    const deadline = Date.now() + 60000;
    while (indexStorageWritersBusy()) {
        if (Date.now() >= deadline)
            throw new Error("Indexing did not pause in time; the local cache was preserved.");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
async function pauseIndexingForStorage(message) {
    indexStorageAvailable = false;
    indexStorageUnavailableMessage = message;
    publishIndexStorageStatus(message);
    aestheticScorer?.setBackgroundPaused(true);
    if (indexStorageInitializationDeferred) {
        await indexRecovery?.setBlocked(message);
        return;
    }
    if (semanticIndexer)
        await semanticIndexer.setHold(message);
    await indexRecovery?.setBlocked(message);
    await Promise.allSettled([
        faceIndexer?.pause(),
        geoIndexer?.pause(),
        duplicateManager?.pause(),
        petIndexer?.pause(),
    ].filter(Boolean));
    audioLibraryCache?.cancelScan();
    await waitForIndexStorageWritersToPause();
}
async function resumeIndexingAfterStorage() {
    if (indexStorageInitializationDeferred) {
        indexStorageTransfer = {
            state: "complete",
            message: "The selected destination is back. Silo is restarting to reopen its indexes and resume automatically.",
            filesVerified: 0,
            bytesVerified: 0,
        };
        publishIndexStorageStatus(indexStorageTransfer.message);
        scheduleIndexStorageRelaunch();
        return;
    }
    indexStorageUnavailableMessage = null;
    indexStorageAvailable = true;
    aestheticScorer?.setBackgroundPaused(false);
    const resumeSources = semanticIndexer
        ? await semanticIndexer.setHold(heapPressureMessage)
        : [];
    await indexRecovery?.setBlocked(null);
    if (resumeSources.length && !heapPressureMessage && !shuttingDown)
        void semanticIndexer.start(resumeSources);
    publishIndexStorageStatus(indexStorageUsingLocalFallback
        ? `The selected destination is still unavailable. Silo is using the local cache and keeping at least ${Math.round(indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free.`
        : null);
}
function scheduleIndexStorageRelaunch() {
    if (indexStorageRelaunchPending)
        return;
    indexStorageRelaunchPending = true;
    setTimeout(() => {
        electron_1.app.relaunch();
        electron_1.app.quit();
    }, 3500);
}
async function prepareStorageTransition(reason) {
    if (indexStorageTransferRunning || indexStorageRelaunchPending)
        return;
    if (Date.now() < indexStorageTransferRetryAt)
        return;
    indexStorageTransferRunning = true;
    const destination = getIndexStorageDestinationLabel();
    indexStorageTransfer = {
        state: "moving",
        message: reason === "destination"
            ? "The destination reconnected. Indexing is paused while Silo verifies and moves the cache."
            : "Indexing is paused while Silo prepares the local fallback cache.",
        filesVerified: 0,
        bytesVerified: 0,
    };
    publishIndexStorageStatus(unavailableIndexStorageMessage());
    try {
        await pauseIndexingForStorage(indexStorageTransfer.message);
        const userDataPath = electron_1.app.getPath("userData");
        const storage = await (0, indexingStorage_1.prepareConfiguredIndexStorage)(userDataPath, (filesVerified, bytesVerified) => {
            indexStorageTransfer = {
                state: "moving",
                message: `Verifying cache transfer: ${filesVerified.toLocaleString()} files and ${(bytesVerified / 1024 / 1024 / 1024).toFixed(2)} GiB checked.`,
                filesVerified,
                bytesVerified,
            };
            publishIndexStorageStatus();
        });
        if (storage.migrationError || (!storage.destinationAvailable && !storage.usingLocalFallback))
            throw new Error(storage.migrationError || "The selected cache destination is still unavailable.");
        indexStorageRoot = storage.storageRoot;
        selectedIndexStorageRoot = storage.selectedStorageRoot;
        indexStorageUsingLocalFallback = storage.usingLocalFallback;
        indexStorageFallbackEnabled = storage.localFallbackEnabled;
        indexStorageDestinationAvailable = storage.destinationAvailable;
        (0, indexingStorage_1.setActiveIndexStorageRoot)(indexStorageRoot);
        if (storage.usingLocalFallback) {
            indexStorageFreeBytes = await (0, indexingStorage_1.getLocalIndexStorageFreeBytes)(indexStorageRoot);
            await (0, indexingStorage_1.assertLocalIndexStorageCapacity)(indexStorageRoot);
        }
        else {
            indexStorageFreeBytes = null;
        }
        if (storage.destinationAvailable) {
            const stats = await fsPromises.stat(indexStorageRoot);
            indexStorageDeviceId = stats.dev;
        }
        else {
            indexStorageDeviceId = null;
        }
        indexStorageTransfer = {
            state: "complete",
            message: storage.destinationAvailable
                ? `Cache verified and moved to ${destination}. Silo is restarting and indexing will resume automatically.`
                : `Local fallback cache is ready. Silo is restarting and indexing will continue locally.`,
            filesVerified: storage.filesVerified,
            bytesVerified: storage.bytesVerified,
        };
        indexStorageUnavailableMessage = null;
        indexStorageAvailable = false;
        publishIndexStorageStatus(indexStorageTransfer.message);
        scheduleIndexStorageRelaunch();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        indexStorageTransfer = {
            state: "error",
            message: `Cache transfer paused. Silo preserved the existing cache. ${message}`,
            filesVerified: indexStorageTransfer.filesVerified,
            bytesVerified: indexStorageTransfer.bytesVerified,
        };
        indexStorageTransferRetryAt = Date.now() + 15000;
        const fallbackCanResume = indexStorageUsingLocalFallback &&
            indexStorageFallbackEnabled &&
            indexStorageRoot;
        if (fallbackCanResume) {
            indexStorageFreeBytes = await (0, indexingStorage_1.getLocalIndexStorageFreeBytes)(indexStorageRoot).catch(() => null);
            if (indexStorageFreeBytes !== null && indexStorageFreeBytes >= indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES)
                await resumeIndexingAfterStorage();
        }
        publishIndexStorageStatus(indexStorageTransfer.message);
        runtimeLog("index-storage-transfer-failed", { message });
    }
    finally {
        indexStorageTransferRunning = false;
    }
}
async function monitorIndexStorageAvailability() {
    if (indexStorageMonitorRunning || indexStorageTransferRunning || indexStorageRelaunchPending)
        return;
    indexStorageMonitorRunning = true;
    try {
        const externalDestination = path.resolve(selectedIndexStorageRoot) !== path.resolve(electron_1.app.getPath("userData"));
        const destinationAvailable = await checkSelectedIndexStorageAvailable();
        indexStorageDestinationAvailable = destinationAvailable;
        if (!externalDestination) {
            indexStorageUsingLocalFallback = false;
            indexStorageFreeBytes = null;
            if (!indexStorageAvailable)
                await resumeIndexingAfterStorage();
            else
                publishIndexStorageStatus(null);
            return;
        }
        if (destinationAvailable && indexStorageUsingLocalFallback) {
            await prepareStorageTransition("destination");
            return;
        }
        if (!destinationAvailable && !indexStorageUsingLocalFallback) {
            const message = unavailableIndexStorageMessage();
            if (indexStorageFallbackEnabled) {
                await prepareStorageTransition("fallback");
                return;
            }
            if (indexStorageAvailable || indexStorageUnavailableMessage !== message)
                await pauseIndexingForStorage(message);
            indexStorageFreeBytes = null;
            publishIndexStorageStatus(message);
            return;
        }
        if (indexStorageUsingLocalFallback) {
            indexStorageFreeBytes = await (0, indexingStorage_1.getLocalIndexStorageFreeBytes)(indexStorageRoot).catch(() => null);
            if (!indexStorageFallbackEnabled) {
                const message = `The selected destination, ${getIndexStorageDestinationLabel()}, is unavailable. Local fallback is off, so indexing is paused until it reconnects.`;
                if (indexStorageAvailable || indexStorageUnavailableMessage !== message)
                    await pauseIndexingForStorage(message);
                publishIndexStorageStatus(message);
                return;
            }
            if (indexStorageFreeBytes === null || indexStorageFreeBytes < indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES) {
                const message = `Local cache indexing is paused to keep at least ${Math.round(indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free. Reconnect ${getIndexStorageDestinationLabel()} or free local disk space.`;
                if (indexStorageAvailable || indexStorageUnavailableMessage !== message)
                    await pauseIndexingForStorage(message);
                publishIndexStorageStatus(message);
                return;
            }
            if (!indexStorageAvailable)
                await resumeIndexingAfterStorage();
            else {
                const message = `Selected destination ${getIndexStorageDestinationLabel()} is unavailable. Silo is using a local cache and keeping at least ${Math.round(indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free.`;
                publishIndexStorageStatus(message);
            }
            return;
        }
        if (destinationAvailable && !indexStorageAvailable) {
            const stats = await fsPromises.stat(selectedIndexStorageRoot);
            indexStorageDeviceId = stats.dev;
            await resumeIndexingAfterStorage();
            return;
        }
        if (!destinationAvailable)
            publishIndexStorageStatus(unavailableIndexStorageMessage());
        else
            publishIndexStorageStatus(null);
    }
    catch (error) {
        runtimeLog("index-storage-monitor-error", {
            message: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        indexStorageMonitorRunning = false;
    }
}
function startIndexStorageAvailabilityMonitor() {
    if (indexStorageMonitorTimer)
        clearInterval(indexStorageMonitorTimer);
    indexStorageMonitorTimer = setInterval(() => void monitorIndexStorageAvailability(), 1200);
    void monitorIndexStorageAvailability();
}
function installApplicationMenu() {
    applicationMenuInstalled = true;
    const sendEdit = (command) => sendToRenderer("edit-menu-command", command);
    const template = [
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        { role: "fileMenu" },
        {
            label: "Edit",
            submenu: [
                {
                    label: "Undo",
                    accelerator: "CmdOrCtrl+Z",
                    click: () => sendEdit("undo"),
                },
                {
                    label: "Redo",
                    accelerator: "CmdOrCtrl+Y",
                    click: () => sendEdit("redo"),
                },
                {
                    label: "Redo",
                    accelerator: "Shift+CmdOrCtrl+Z",
                    click: () => sendEdit("redo"),
                    visible: false,
                    acceleratorWorksWhenHidden: true,
                },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { role: "pasteAndMatchStyle" },
                { role: "delete" },
                { role: "selectAll" },
            ],
        },
        { role: "viewMenu" },
        { role: "windowMenu" },
    ];
    electron_1.Menu.setApplicationMenu(electron_1.Menu.buildFromTemplate(template));
}
electron_1.app.whenReady().then(async () => {
    // Packaged builds carry the .icns in the bundle; development runs from Electron.app.
    if (!electron_1.app.isPackaged)
        electron_1.app.dock?.setIcon(appIconPath());
    installApplicationMenu();
    configureAppUpdater();
    const userDataPath = electron_1.app.getPath("userData");
    let storage;
    try {
        storage = await (0, indexingStorage_1.prepareConfiguredIndexStorage)(userDataPath, (filesVerified, bytesVerified) => runtimeLog("index-storage-migration-progress", {
            filesVerified,
            bytesVerified,
        }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtimeLog("index-storage-initialization-failed", { message });
        electron_1.dialog.showErrorBox("Silo could not safely prepare its index", "Silo stopped before opening the library. Existing index files were preserved. Resolve the storage issue and reopen Silo.");
        electron_1.app.quit();
        return;
    }
    indexStorageRoot = storage.storageRoot;
    selectedIndexStorageRoot = storage.selectedStorageRoot;
    indexStorageUsingLocalFallback = storage.usingLocalFallback;
    indexStorageFallbackEnabled = storage.localFallbackEnabled;
    indexStorageDestinationAvailable = storage.destinationAvailable;
    (0, indexingStorage_1.setActiveIndexStorageRoot)(indexStorageRoot);
    indexStorageAvailable =
        storage.destinationAvailable ||
            (storage.usingLocalFallback && storage.localFallbackEnabled && !storage.migrationError);
    if (storage.usingLocalFallback) {
        indexStorageFreeBytes = await (0, indexingStorage_1.getLocalIndexStorageFreeBytes)(indexStorageRoot).catch(() => null);
        if (indexStorageFreeBytes === null ||
            indexStorageFreeBytes < indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES) {
            indexStorageAvailable = false;
            storage.migrationError = `Local cache indexing is paused to keep at least ${Math.round(indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free. Reconnect ${path.basename(storage.selectedStorageRoot)} or free local disk space.`;
        }
    }
    indexStorageInitializationDeferred = !indexStorageAvailable;
    if (!storage.destinationAvailable) {
        const unavailableMessage = storage.usingLocalFallback
            ? storage.migrationError || unavailableIndexStorageMessage()
            : storage.localFallbackEnabled
                ? storage.migrationError || unavailableIndexStorageMessage()
                : unavailableIndexStorageMessage();
        indexStorageUnavailableMessage = indexStorageAvailable ? null : unavailableMessage;
        indexStorageMessageText = storage.migrationError || (storage.usingLocalFallback
            ? `Selected destination ${path.basename(storage.selectedStorageRoot)} is unavailable. Silo is using a local cache and keeping at least ${Math.round(indexingStorage_1.LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free.`
            : unavailableMessage);
    }
    else {
        indexStorageUnavailableMessage = storage.migrationError;
        indexStorageMessageText = storage.migrationError;
    }
    if (storage.destinationAvailable && path.resolve(selectedIndexStorageRoot) !== path.resolve(userDataPath)) {
        const selectedStat = await fsPromises.stat(selectedIndexStorageRoot);
        indexStorageDeviceId = selectedStat.dev;
    }
    else {
        indexStorageDeviceId = null;
    }
    publishIndexStorageStatus();
    if (path.resolve(indexStorageRoot) !== path.resolve(userDataPath)) {
        runtimeLog("external-index-storage-ready", {
            filesVerified: storage.filesVerified,
            bytesVerified: storage.bytesVerified,
            usingLocalFallback: storage.usingLocalFallback,
            destinationAvailable: storage.destinationAvailable,
        });
    }
    // A restored config is swapped in before any store opens its files.
    try {
        if (await (0, configBundle_1.applyPendingImport)(electron_1.app.getPath("userData"), indexStorageRoot))
            runtimeLog("config-import-applied", {});
    }
    catch (error) {
        runtimeLog("config-import-failed", { message: String(error) });
    }
    stateStore = new stateStore_1.StateStore(electron_1.app.getPath("userData"));
    await stateStore.initialize();
    lifetimeLicensed = (await readLifetimeLicense()).isLicensed;
    demoTestingModeEnabled = lifetimeLicensed && (await readDemoTestingMode());
    electron_1.app.setName(accessDisplayName());
    refreshHiddenFolderPathCache();
    contentSettingsStore = new contentSettings_1.ContentSettingsStore(electron_1.app.getPath("userData"));
    await contentSettingsStore.initialize();
    registerMediaProtocols();
    await createWindow();
    if (electron_1.app.isPackaged && !electron_is_dev_1.default)
        void checkForAppUpdates();
    reportStartup("Loading content filters…");
    await loadSafetyCache();
    const modelCachePath = electron_1.app.isPackaged
        ? path.join(process.resourcesPath, "clip-model-cache")
        : path.join(electron_1.app.getAppPath(), ".model-test-cache");
    const unifiedScanSource = await createUnifiedScanSource();
    libraryStatsManager = new libraryStats_1.LibraryStatsManager(indexStorageRoot, (sourcePath, onFile, isCancelled) => unifiedScanSource(sourcePath, (file) => onFile(file), isCancelled));
    const libraryStatsLoad = indexStorageInitializationDeferred
        ? Promise.resolve()
        : libraryStatsManager.initialize();
    semanticIndexer = new semanticIndexer_1.SemanticIndexer(electron_1.app.getPath("userData"), modelCachePath, unifiedScanSource, (progress) => {
        sendToRenderer("index-progress", progress);
        const now = Date.now();
        if (now - lastIndexDiagnostic >= 10000 || progress.status === "error") {
            lastIndexDiagnostic = now;
            runtimeLog("index-progress", {
                status: progress.status,
                total: progress.total,
                indexed: progress.indexed,
                remaining: progress.remaining,
                errors: progress.errors,
                currentFile: progress.currentFile,
            });
        }
        // Only new CLIP results can produce new geo work; an idle index must not re-trigger it.
        if (progress.status === "indexing")
            semanticChangesPending = true;
        if (geoIndexer &&
            progress.status === "complete" &&
            semanticChangesPending) {
            semanticChangesPending = false;
            void kickGeoCheck();
        }
        if (progress.status === "complete")
            kickMagicBackground(15000);
        // Record changes debounce into one topic-profile refresh after indexing settles.
        memoryProfileScheduler?.notify();
        scheduleThumbnailPregeneration(progress.status === "indexing");
    }, runtimeLog, indexStorageRoot);
    libraryShareServer = new libraryShareServer_1.LibraryShareServer({
        getSources: async () => (await listSources()).map(({ id, label, rootPath, kind, available }) => ({
            id,
            label,
            rootPath,
            kind,
            available,
        })),
        getIndexedFiles: (sourceRoots) => semanticIndexer.getIndexedFiles(sourceRoots),
        search: (query, sourceRoots) => semanticIndexer.search(query, 0, sourceRoots),
        getThumbnail: async (filePath) => {
            const thumbnailUrl = await getThumbnail(filePath, false, 320);
            if (!thumbnailUrl)
                return null;
            const fileName = path.basename(new URL(thumbnailUrl).pathname);
            if (!/^[a-f0-9]{40}\.jpg$/.test(fileName))
                return null;
            return fsPromises.readFile(indexStoragePath("thumbnail-cache", fileName));
        },
    });
    if (indexStorageUnavailableMessage && !indexStorageInitializationDeferred)
        await semanticIndexer.setHold(indexStorageUnavailableMessage);
    semanticIndexer.setDemoFileLimit(fullAccessEnabled() ? null : demoLimits_1.DEMO_LIMITS.files);
    const semanticLoad = indexStorageInitializationDeferred
        ? Promise.resolve()
        : semanticIndexer.initialize((fraction, records) => reportStartupDetail(`Opening search index… ${Math.round(fraction * 100)}% (${records.toLocaleString()} files)`));
    const faceModelPath = electron_1.app.isPackaged
        ? path.join(process.resourcesPath, "face-models")
        : path.join(electron_1.app.getAppPath(), "node_modules/@vladmandic/face-api/model");
    const faceWasmPath = electron_1.app.isPackaged
        ? path.join(process.resourcesPath, "face-wasm")
        : path.join(electron_1.app.getAppPath(), "node_modules/@tensorflow/tfjs-backend-wasm/dist");
    faceIndexer = new faceIndexer_1.FaceIndexer(electron_1.app.getPath("userData"), faceModelPath, faceWasmPath, async () => {
        return semanticIndexer.getIndexedImages(await getAllIndexSources());
    }, (progress) => {
        sendToRenderer("face-index-progress", progress);
        scheduleThumbnailPregeneration();
    }, indexStorageRoot);
    faceIndexer.setRecognitionListener(({ added, removed }) => {
        const showBanned = Boolean(contentSettingsStore?.getPublicSettings().showBannedPeople);
        sendToRenderer("content-safety-changed", {
            flaggedCount: semanticUnsafePaths.size,
            hiddenPaths: showBanned ? [] : added,
            unhiddenPaths: showBanned ? [] : removed,
            unhiddenCount: showBanned ? 0 : removed.length,
        });
    });
    faceIndexer.setPeopleChangeListener(() => sendToRenderer("photo-indicators-changed", null));
    faceIndexer.setHiddenPhotoPredicate((photoPath, ownerBanned) => {
        const settings = contentSettingsStore?.getPublicSettings();
        if (hiddenFolderPathCache.has(photoPath))
            return true;
        if (!ownerBanned &&
            !settings?.showBannedPeople &&
            faceIndexer.getBannedPhotoPaths().has(photoPath))
            return true;
        if (settings?.showNsfw)
            return false;
        return (semanticUnsafePaths.has(photoPath) ||
            (0, contentPolicy_1.fileTextLooksExplicit)({ name: path.basename(photoPath), path: photoPath }));
    });
    const faceLoad = indexStorageInitializationDeferred
        ? Promise.resolve()
        : faceIndexer.initialize();
    aestheticScorer = new aestheticScorer_1.AestheticScorer({
        cachePath: indexStoragePath("aesthetic-index.jsonl"),
        thumbnailFile: async (filePath) => {
            const url = await getThumbnail(await resolveLocalPath(filePath));
            return url
                ? path.join(indexStorageRoot, "thumbnail-cache", url.slice(url.lastIndexOf("/") + 1))
                : null;
        },
        faceBoxes: (filePath) => faceIndexer.getFaceBoxes(filePath),
        temporaryPreview: async (filePath) => {
            if (process.platform !== "darwin") {
                const url = await getThumbnail(filePath).catch(() => null);
                return url
                    ? {
                        file: path.join(indexStorageRoot, "thumbnail-cache", url.slice(url.lastIndexOf("/") + 1)),
                        dispose: async () => undefined,
                    }
                    : null;
            }
            const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-magic-"));
            const dispose = () => fsPromises.rm(directory, { recursive: true, force: true });
            const output = path.join(directory, "preview.jpg");
            try {
                await execFileAsync("sips", ["-s", "format", "jpeg", "-Z", "320", filePath, "--out", output], { timeout: 20000 });
                return { file: output, dispose };
            }
            catch {
                await dispose();
                return null;
            }
        },
        imageVectors: (paths) => semanticIndexer.getImageVectors(paths),
        embedPrompts: (prompts) => semanticIndexer.embedPrompts(prompts),
        onProgress: (progress) => {
            magicLibraryProgress = {
                analyzed: progress.libraryAnalyzed,
                total: progress.libraryTotal,
                running: progress.running,
            };
            sendToRenderer("magic-sort-progress", progress);
        },
    });
    petIndexer = new petIndexer_1.PetIndexer(indexStorageRoot, indexStoragePath("semantic-index"), semanticIndexer);
    const petLoad = indexStorageInitializationDeferred
        ? Promise.resolve()
        : petIndexer.initialize();
    phoneManager = new phoneManager_1.PhoneManager(electron_1.app.getPath("userData"), (progress) => {
        const key = `${progress.platform}:${progress.deviceId}`;
        const active = progress.status === "scanning" || progress.status === "backing-up";
        // Backups write thousands of files into a possibly indexed folder: hold watcher
        // rescans until the backup ends, then index the new files once.
        const heldRoot = phoneBackupHolds.get(key);
        if (active && !heldRoot) {
            const root = phoneManager?.getBackupRoot(progress.platform, progress.deviceId)
                ?? null;
            const destination = root ?? phoneManagerBackupDestination;
            if (destination && semanticIndexer) {
                semanticIndexer.holdWatchReconciliation(destination);
                phoneBackupHolds.set(key, destination);
            }
        }
        else if (!active && heldRoot) {
            phoneBackupHolds.delete(key);
            semanticIndexer?.releaseWatchReconciliation(heldRoot);
        }
        const statusChanged = phoneBackupLastStatus.get(key) !== progress.status;
        phoneBackupLastStatus.set(key, progress.status);
        if (!mainWindow || mainWindow.isDestroyed())
            return;
        mainWindow.webContents.send("phone-backup-progress", progress);
        // Per-file progress is frequent; log transitions only.
        if (!statusChanged)
            return;
        runtimeLog("phone-backup-progress", {
            deviceId: progress.deviceId,
            platform: progress.platform,
            status: progress.status,
            completedFiles: progress.completedFiles,
            totalFiles: progress.totalFiles,
            completedBytes: progress.completedBytes,
            totalBytes: progress.totalBytes,
        });
    });
    await phoneManager.initialize();
    phoneManagerBackupDestination = await phoneManager.getBackupDestination();
    console.log("[STARTUP] phoneManager initialized, creating Google/Message managers...");
    googleManager = new googleManager_1.GoogleManager(electron_1.app.getPath("userData"), indexStorageRoot);
    if (!indexStorageInitializationDeferred)
        await googleManager.initialize((await (0, googleManager_1.loadGoogleEnv)(path.join(electron_1.app.getPath("userData"), ".env"))) ??
            (await (0, googleManager_1.loadGoogleEnv)(path.join(electron_1.app.getAppPath(), ".env"))));
    console.log("[STARTUP] googleManager initialized, creating messageExportCoordinator...");
    messageExportCoordinator = new messageExportCoordinator_1.MessageExportCoordinator(electron_1.app.getPath("userData"));
    // Sync phone backup destination to message coordinator
    const phoneBackupDest = await phoneManager.getBackupDestination();
    if (phoneBackupDest) {
        messageExportCoordinator.setBackupDestination(phoneBackupDest);
    }
    console.log("[STARTUP] Creating ContactManager...");
    contactManager = new contactManager_1.ContactManager(electron_1.app.getPath("userData"));
    await contactManager.initialize();
    console.log("[STARTUP] Creating geoIndexer...");
    geoIndexer = new geoIndexer_1.GeoIndexer(electron_1.app.getPath("userData"), (state) => {
        // Progress events carry counts only; the renderer fetches photos when photosVersion changes.
        sendToRenderer("geo-index-progress", state);
        scheduleThumbnailPregeneration();
    }, indexStorageRoot);
    const geoLoad = indexStorageInitializationDeferred
        ? Promise.resolve()
        : geoIndexer.initialize();
    geocoder = new geocoder_1.Geocoder(electron_1.app.getPath("userData"), indexStorageRoot);
    if (!indexStorageInitializationDeferred)
        await geocoder.initialize();
    duplicateManager = new duplicateManager_1.DuplicateManager(electron_1.app.getPath("userData"), (state) => {
        sendToRenderer("duplicate-progress", filterDuplicateState(state));
    }, indexStorageRoot);
    const duplicateLoad = indexStorageInitializationDeferred
        ? Promise.resolve()
        : duplicateManager.initialize();
    const trackLoad = (load, label) => load.then(() => reportStartup(label));
    reportStartup("Loading face, location and inventory caches…");
    // The search index can take a minute to open on big libraries; the app is usable meanwhile.
    void semanticLoad.then(() => runtimeLog("search-index-loaded", { elapsedMs: Date.now() - startupStartedAt }), (error) => runtimeLog("startup-load-error", { message: String(error) }));
    const loadResults = await Promise.allSettled([
        trackLoad(libraryStatsLoad, "Inventory statistics ready"),
        trackLoad(faceLoad, "Faces ready"),
        trackLoad(petLoad, "Pets ready"),
        trackLoad(geoLoad, "Locations ready"),
        trackLoad(duplicateLoad, "Duplicates ready"),
    ]);
    for (const result of loadResults) {
        if (result.status === "rejected")
            runtimeLog("startup-load-error", { message: String(result.reason) });
    }
    audioLibraryCache = new audioLibraryCache_1.AudioLibraryCache(indexStorageRoot);
    if (!indexStorageInitializationDeferred)
        await audioLibraryCache.initialize();
    geoIndexer.setOverrides(stateStore.getState().geoOverrides);
    thumbnailPregenerator = new thumbnailPregenerator_1.ThumbnailPregenerator({
        getSourceRoots: getAllIndexSources,
        isMedia: (fileName) => {
            const type = mime.getType(fileName);
            return Boolean(type && (type.startsWith("image/") || type.startsWith("video/")));
        },
        isRemotePath,
        listRemoteMediaFiles: async (root) => {
            const source = (await listSources()).find((candidate) => candidate.rootPath === root && candidate.available);
            if (!source)
                return [];
            try {
                const files = await readSourceFiles(source, true);
                return files
                    .filter((file) => !file.isDirectory &&
                    mime.getType(file.name)?.match(/^(image|video)\//))
                    .map((file) => file.path);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (source.kind === "gdrive" &&
                    /403|forbidden|permission/i.test(message)) {
                    runtimeLog("thumbnail-pregen-source-skipped", {
                        sourceKind: source.kind,
                        sourceLabel: source.label,
                        message,
                    });
                    return [];
                }
                throw error;
            }
        },
        generate: async (filePath) => Boolean(await queueThumbnail(filePath, async () => await getThumbnail(await resolveLocalPath(filePath), false, GRID_THUMBNAIL_SIZE))),
        isInteractiveBusy: () => thumbnailJobs.length > 0,
        getIndexingWaitMessage: getThumbnailIndexingWaitMessage,
        onProgress: (progress) => sendToRenderer("thumbnail-pregen-progress", progress),
    });
    scheduleThumbnailPregeneration();
    memoryManager = new memoryManager_1.MemoryManager(electron_1.app.getPath("userData"), {
        search: searchMemoryMedia,
        filterImages: filterMemoryPhotos,
        thumb: async (filePath) => getThumbnail(await resolveLocalPath(filePath), false, 200),
        listAudio: () => audioLibraryCache?.getSnapshot().files ?? [],
        discover: discoverMemoryIdeas,
        isAllowed: memoryAllowed,
        findLiveVideo: memoryLiveVideo,
    });
    await memoryManager.initialize();
    memoryExporter = new memoryExporter_1.MemoryExporter({ ffmpegPath: getFfmpegPath, resolveLocalPath,
        prepareImage: prepareMemoryExportImage,
    });
    // Coverage and cooldowns are persisted per source. Recheck all available sources
    resolveServicesReady();
    // Warm saved memory movies in the background while indexing starts; popup/page
    // reads join the preview queue instead of racing or failing with a busy error.
    void memoryManager.getState()
        .then((state) => prepareAllMemoryPreviews(state.suggestions))
        .catch(() => runtimeLog("memory-preview-warmup-error"));
    // even when the audio screen is closed, and retry failures once due.
    audioInventoryRetryTimer = setInterval(() => void refreshAudioInventory(-1), 60000);
    void refreshAudioInventory(-1);
    reportStartup("Ready", true);
    kickMagicBackground(90000);
    console.log("[STARTUP] All managers initialized");
    phoneDiscoveryTimer = setInterval(() => void discoverAndBackupPhones(), 5000);
    void discoverAndBackupPhones();
    schedulePeriodicCleanup();
    setTimeout(() => void cleanupOldCaches().catch(() => undefined), 60000);
    await getEnabledIndexSources(); // Initialize visibility independently of coverage.
    await semanticLoad.catch(() => undefined);
    memoryProfileScheduler = new memoryTopicProfile_1.RefreshScheduler({
        delayMs: 60000,
        isBusy: memoryProfileBusy,
        run: refreshMemoryTopicsAfterIndexing,
    });
    memoryProfileScheduler.notify();
    const sources = await getAllIndexSources();
    if (sources.length > 0) {
        void semanticIndexer.startWatching(sources);
        // Reconcile only changed/new files after the initial UI load; never restart a full library scan at launch.
        setTimeout(() => {
            void (async () => {
                try {
                    const dispatched = new Set();
                    // Filesystem reconciliation skips virtual roots; enumerate ready remote
                    // roots explicitly, with cached signatures avoiding repeat embeddings.
                    const remoteSources = sources.filter(isRemotePath);
                    const progress = semanticIndexer.getProgress();
                    if (lifetimeLicensed &&
                        remoteSources.length &&
                        !(progress.status === "paused" &&
                            !/interrupted/i.test(progress.message)))
                        void semanticIndexer
                            .start(remoteSources)
                            .catch((error) => runtimeLog("remote-source-index-error", {
                            message: String(error),
                        }));
                    const onSourceReady = lifetimeLicensed
                        ? (changes) => {
                            const currentProgress = semanticIndexer.getProgress();
                            if (currentProgress.status === "paused" &&
                                !/interrupted/i.test(currentProgress.message))
                                return;
                            changes.forEach((_, filePath) => dispatched.add(filePath));
                            void semanticIndexer
                                .start(sources, changes)
                                .catch((error) => runtimeLog("source-incremental-index-error", {
                                message: String(error),
                            }));
                        }
                        : undefined;
                    const changedFiles = await semanticIndexer.reconcileIndex(sources, onSourceReady);
                    dispatched.forEach((filePath) => changedFiles.delete(filePath));
                    // Reconciliation is settled even while new embeddings are still
                    // processing, so cached-photo GPS work can proceed in parallel.
                    startupIndexReconciliationSettled = true;
                    if ((!lifetimeLicensed || hasRetryableSearchWork(sources)) &&
                        !(progress.status === "paused" &&
                            !/interrupted/i.test(progress.message))) {
                        semanticChangesPending = true;
                        await semanticIndexer.startFullScan(sources);
                        if (hasRetryableSearchWork(sources))
                            requestIndexRecoveryStages(["search"]);
                    }
                    else if (changedFiles.size > 0) {
                        semanticChangesPending = true;
                        await semanticIndexer.start(sources, changedFiles);
                        if (hasRetryableSearchWork(sources))
                            requestIndexRecoveryStages(["search"]);
                    }
                }
                finally {
                    startupIndexReconciliationSettled = true;
                    scheduleThumbnailPregeneration(true);
                }
            })().catch((error) => runtimeLog("startup-index-reconcile-error", { message: String(error) }));
        }, 5000);
    }
    else {
        startupIndexReconciliationSettled = true;
        scheduleThumbnailPregeneration(true);
    }
    const searchSettled = () => startupIndexReconciliationSettled &&
        semanticIndexer.getProgress().status === "complete" &&
        !indexRecovery?.details("search").recoveryRunning &&
        !indexRecovery?.details("search").resumeQueued;
    const analysisBlocker = () => {
        const discovery = semanticIndexer.getReconciliationProgress();
        if (!startupIndexReconciliationSettled)
            return discovery.running
                ? `${discovery.message} · ${discovery.scanned.toLocaleString()} entries inspected; ${discovery.changed.toLocaleString()} awaiting indexing.`
                : "Preparing startup source discovery.";
        if (PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status))
            return "Search embeddings are being processed.";
        if (PIPELINE_BUSY_STATUSES.has(faceIndexer.getProgress().status))
            return "Face analysis is running.";
        if (["loading-model", "clustering"].includes(petIndexer.getProgress().status))
            return "Pet clustering is running.";
        if (magicLibraryProgress.running)
            return "Photo quality analysis is running.";
        if (!searchSettled())
            return "Waiting for search indexing to resume and finish.";
        return "Waiting for processing resources.";
    };
    const analysisIdle = () => !PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status) &&
        !PIPELINE_BUSY_STATUSES.has(faceIndexer.getProgress().status) &&
        !["loading-model", "clustering"].includes(petIndexer.getProgress().status) &&
        !magicLibraryProgress.running;
    const diskIdle = () => !audioInventoryRunning &&
        duplicateManager.getState().status !== "scanning" &&
        !["scanning", "generating"].includes(thumbnailPregenerator?.getProgress().status ?? "idle");
    indexRecovery = new indexingRecovery_1.IndexingRecovery([
        {
            id: "search",
            lane: "analysis",
            blockedReason: analysisBlocker,
            progress: () => semanticIndexer.getProgress(),
            ready: () => indexStorageAvailable && startupIndexReconciliationSettled && analysisIdle(),
            unresolvedWork: () => {
                const count = semanticIndexer.getRetryableErrorCount(recoverySearchSourcePaths);
                const coverageErrors = semanticIndexer.getSourceCoverageProgress(recoverySearchSourcePaths).errors;
                return count || coverageErrors
                    ? `${count.toLocaleString()} files and ${coverageErrors.toLocaleString()} source scans still need a search-index retry.`
                    : null;
            },
            start: async () => {
                const sources = await getAllIndexSources();
                if (!sources.length)
                    throw new Error("No configured sources are available. Connect a source and retry.");
                recoverySearchSourcePaths = sources;
                await semanticIndexer.startWatching(sources);
                // Cached signatures skip successful embeddings; interrupted work is resumed.
                await semanticIndexer.startFullScan(sources);
            },
            pause: () => semanticIndexer.pause(),
        },
        {
            id: "faces",
            lane: "analysis",
            blockedReason: analysisBlocker,
            needsInitialCheck: true,
            progress: () => faceIndexer.getProgress(),
            ready: () => indexStorageAvailable && searchSettled() && analysisIdle(),
            unresolvedWork: () => {
                const errors = faceIndexer.getProgress().errors;
                return errors
                    ? `${errors.toLocaleString()} photos need another face-analysis attempt.`
                    : null;
            },
            start: () => faceIndexer.start(),
            pause: () => faceIndexer.pause(),
        },
        {
            id: "locations",
            lane: "light",
            blockedReason: analysisBlocker,
            progress: () => geoIndexer.getStatus(),
            needsInitialCheck: true,
            ready: () => indexStorageAvailable &&
                searchSettled() &&
                geoIndexer.getStatus().status !== "scanning",
            unresolvedWork: () => {
                const count = geoIndexer.getRetryableCount();
                return count
                    ? `${count.toLocaleString()} location records need another check.`
                    : null;
            },
            start: () => kickGeoCheck(),
            pause: () => geoIndexer.pause(),
        },
        {
            id: "duplicates",
            lane: "disk",
            blockedReason: () => audioInventoryRunning
                ? "Recursive audio discovery is using the source disks."
                : analysisBlocker(),
            needsInitialCheck: true,
            progress: () => duplicateManager.getState(),
            ready: () => indexStorageAvailable && searchSettled() && analysisIdle() && diskIdle(),
            unresolvedWork: () => {
                const count = duplicateManager.getRetryableFailureCount();
                return count
                    ? `${count.toLocaleString()} files could not be hashed and will be retried.`
                    : null;
            },
            start: async () => {
                const sources = await getAllIndexSources();
                await duplicateManager.scan(semanticIndexer.getIndexedFiles(sources), sources);
            },
            pause: () => duplicateManager.pause(),
        },
        {
            id: "pets",
            lane: "analysis",
            blockedReason: analysisBlocker,
            needsInitialCheck: true,
            progress: () => petIndexer.getProgress(),
            ready: () => indexStorageAvailable && searchSettled() && analysisIdle(),
            start: async () => petIndexer.start((progress) => sendToRenderer("pet-progress", progress), await getAllIndexSources()),
            pause: () => petIndexer.pause(),
        },
        {
            id: "thumbnails",
            lane: "disk",
            blockedReason: () => getThumbnailIndexingWaitMessage() ||
                "Thumbnail generation is already active.",
            needsInitialCheck: true,
            progress: () => thumbnailPregenerator?.getProgress() ?? {
                status: "idle",
                message: "Waiting for services",
            },
            ready: () => indexStorageAvailable &&
                Boolean(thumbnailPregenerator) &&
                !getThumbnailIndexingWaitMessage() &&
                duplicateManager.getState().status !== "scanning" &&
                !["scanning", "generating"].includes(thumbnailPregenerator?.getProgress().status ?? "idle"),
            unresolvedWork: () => {
                const failed = thumbnailPregenerator?.getProgress().failed ?? 0;
                return failed
                    ? `${failed.toLocaleString()} thumbnails could not be generated and will be retried.`
                    : null;
            },
            start: async () => {
                await thumbnailPregenerator?.start();
            },
        },
        {
            id: "audio",
            progress: () => ({
                status: audioInventoryRunning ? "scanning" : "idle",
                message: "Source-aware retry coverage",
            }),
            ready: () => indexStorageAvailable && !audioInventoryRunning,
            start: async () => {
                const result = await refreshAudioInventory(-1, true);
                if (!result.ok)
                    throw new Error(result.error);
            },
            pause: () => {
                if (audioLibraryCache !== null)
                    audioLibraryCache.cancelScan();
            },
        },
        {
            id: "quality",
            lane: "analysis",
            blockedReason: analysisBlocker,
            needsInitialCheck: true,
            progress: () => ({
                status: magicLibraryProgress.running ? "indexing" : "idle",
                message: "Quality scoring",
            }),
            ready: () => indexStorageAvailable && searchSettled() && analysisIdle(),
            start: async () => {
                const sources = await getAllIndexSources();
                await aestheticScorer.analyzeInBackground(semanticIndexer
                    .getIndexedImages(sources)
                    .filter((file) => !isRemotePath(file.path)));
            },
            pause: () => aestheticScorer.setBackgroundPaused(true),
        },
    ], Date.now, path.join(electron_1.app.getPath("userData"), "indexing-recovery.json"));
    await monitorIndexStorageAvailability();
    startIndexStorageAvailabilityMonitor();
    requestIndexRecoveryStages([]);
    indexRecoveryTimer = setInterval(() => void indexRecovery?.tick().catch((error) => runtimeLog("index-recovery-tick-error", { message: String(error) })), 5000);
    const heapGuard = new heapGuard_1.HeapGuard({
        onPressure: async (sample) => {
            heapPressureMessage =
                "Indexing paused briefly to free memory; progress so far is saved and it will resume automatically.";
            runtimeLog("heap-pressure", {
                usedMb: Math.round(sample.used / 1024 / 1024),
                limitMb: Math.round(sample.limit / 1024 / 1024),
            });
            await semanticIndexer.setHold(indexStorageUnavailableMessage ?? heapPressureMessage);
        },
        onRelief: async (sample) => {
            runtimeLog("heap-relief", { usedMb: Math.round(sample.used / 1024 / 1024) });
            heapPressureMessage = null;
            const resume = await semanticIndexer.setHold(indexStorageUnavailableMessage);
            if (!indexStorageUnavailableMessage && resume.length && !shuttingDown)
                void semanticIndexer.start(resume);
        },
    });
    heapGuardTimer = setInterval(() => void heapGuard.tick().catch((error) => runtimeLog("heap-guard-error", { message: String(error) })), 2000);
    diagnosticsTimer = setInterval(() => {
        const memory = process.memoryUsage();
        const progress = semanticIndexer.getProgress();
        const faceProgress = faceIndexer.getProgress();
        const geoState = geoIndexer.getStatus();
        const duplicateState = duplicateManager.getState();
        runtimeLog("heartbeat", {
            rendererProcesses: electron_1.app
                .getAppMetrics()
                .filter((process) => process.type === "Tab")
                .map((process) => ({
                pid: process.pid,
                cpu: process.cpu.percentCPUUsage,
                memoryKb: process.memory.workingSetSize,
            })),
            rssMb: Math.round(memory.rss / 1024 / 1024),
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            indexStatus: progress.status,
            indexTotal: progress.total,
            indexIndexed: progress.indexed,
            indexRemaining: progress.remaining,
            indexErrors: progress.errors,
            faceStatus: faceProgress.status,
            faceProcessed: faceProgress.processed,
            faceRemaining: faceProgress.remaining,
            geoStatus: geoState.status,
            geoScanned: geoState.scanned,
            geoTotal: geoState.total,
            duplicateStatus: duplicateState.status,
            duplicateScanned: duplicateState.scanned,
            duplicateTotal: duplicateState.total,
            derivedRunning: Boolean(derivedIndexPromise),
        });
    }, 10000);
    runtimeLog("app-ready");
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
let quitFlushed = false;
electron_1.app.on("before-quit", (event) => {
    memoryExporter?.cancel();
    void libraryShareServer?.stop();
    shuttingDown = true;
    if (rendererRecoveryTimer)
        clearTimeout(rendererRecoveryTimer);
    indexRecovery?.stop();
    if (indexRecoveryTimer)
        clearInterval(indexRecoveryTimer);
    if (audioInventoryRetryTimer)
        clearInterval(audioInventoryRetryTimer);
    audioLibraryCache?.cancelScan();
    if (diagnosticsTimer)
        clearInterval(diagnosticsTimer);
    if (heapGuardTimer)
        clearInterval(heapGuardTimer);
    if (phoneDiscoveryTimer)
        clearInterval(phoneDiscoveryTimer);
    if (quitFlushed)
        return;
    runtimeLog("before-quit");
    void semanticIndexer?.stopWatching();
    void phoneManager?.unmountAll();
    if (!semanticIndexer)
        return;
    // Finish in-flight index writes so a restart never finds a torn record line.
    event.preventDefault();
    quitFlushed = true;
    const flush = semanticIndexer.flushWrites();
    const deadline = new Promise((resolve) => setTimeout(resolve, 8000));
    void Promise.race([flush, deadline]).finally(() => electron_1.app.quit());
});
electron_1.app.on("activate", () => {
    if (mainWindow === null) {
        void createWindow();
    }
});
// IPC Handlers
electron_1.ipcMain.handle("get-memories", async (_event, prepareViews) => {
    // Returns immediately; movies render in the background and report progress per card.
    const state = await memoryManager.getState();
    if (prepareViews === true && state.suggestions.length)
        void prepareAllMemoryPreviews(state.suggestions).catch(() => runtimeLog("memory-preview-error"));
    return memoryStateWithPreviews(state);
});
electron_1.ipcMain.handle("generate-memories", async (_event, replace, customTopic) => {
    // Generation never throws to the page: failures keep the current cards and explain why.
    if (customTopic !== undefined && typeof customTopic !== "string") {
        const current = await memoryStateWithPreviews();
        return { ...current, message: "Enter a topic using plain text." };
    }
    let state;
    try {
        state = await memoryManager.generate(replace === true, customTopic);
    }
    catch {
        runtimeLog("memory-generate-error");
        const current = await memoryStateWithPreviews();
        return { ...current, message: "Memory generation hit a problem; your saved memories are unchanged." };
    }
    if (state.suggestions.length)
        void prepareAllMemoryPreviews(state.suggestions).catch(() => runtimeLog("memory-preview-error"));
    return { ...(await memoryStateWithPreviews()), message: state.message };
});
electron_1.ipcMain.handle("select-memory-directory", async () => {
    if (!mainWindow || mainWindow.isDestroyed())
        return memoryManager.getState();
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Save memory movies to…",
        properties: ["openDirectory", "createDirectory"],
    });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen)
        return memoryManager.getState();
    const directory = path.resolve(chosen);
    await fsPromises.access(directory, fs.constants.W_OK).catch(() => {
        throw new Error("That folder isn't writable. Choose another destination.");
    });
    const state = await memoryManager.updateSettings({ movieDirectory: directory });
    // Copy already-rendered movies over so saved stories stay viewable offline.
    void prepareAllMemoryPreviews(state.suggestions).catch(() => runtimeLog("memory-preview-error"));
    return state;
});
electron_1.ipcMain.handle("dismiss-memory", (_event, id) => {
    if (typeof id !== "string" || !id || id.length > 200)
        throw new Error("Invalid memory.");
    return memoryManager.dismiss(id);
});
electron_1.ipcMain.handle("update-memory-settings", (_event, settings) => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
        throw new Error("Invalid memory settings.");
    const update = {};
    for (const key of ["showOnLaunch", "removeAfterDownload"]) {
        const value = settings[key];
        if (value === undefined)
            continue;
        if (typeof value !== "boolean")
            throw new Error("Invalid memory settings.");
        update[key] = value;
    }
    // Only clearing is accepted here; a folder is set through the native picker.
    if (settings.movieDirectory === null)
        update.movieDirectory = null;
    return memoryManager.updateSettings(update);
});
electron_1.ipcMain.handle("get-memory-soundtracks", (_event, id) => {
    if (typeof id !== "string" || !id || id.length > 200)
        throw new Error("Invalid memory.");
    return memoryManager.getSoundtracks(id);
});
electron_1.ipcMain.handle("browse-memory-audio", (_event, raw) => {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const textField = (field, max) => typeof field === "string" && field.length <= max && !field.includes("\0") ? field : undefined;
    return memoryManager.browseAudio({
        sourceId: textField(value.sourceId, 4096) || undefined,
        folder: textField(value.folder, 4096),
        query: textField(value.query, 200),
        sort: value.sort === "modified" || value.sort === "size" ? value.sort : "name",
        direction: value.direction === "desc" ? "desc" : "asc",
        offset: Number.isSafeInteger(value.offset) ? Number(value.offset) : 0,
        limit: Number.isSafeInteger(value.limit) ? Number(value.limit) : 200,
    });
});
electron_1.ipcMain.handle("set-memory-soundtrack", async (_event, id, soundtrackId) => {
    if (typeof id !== "string" || !id || id.length > 200 || typeof soundtrackId !== "string" || soundtrackId.length > 250)
        throw new Error("Invalid memory soundtrack.");
    const card = await memoryManager.setSoundtrack(id, soundtrackId);
    if (!card)
        throw new Error("That song is no longer available. Choose another one.");
    // The watchable movie re-renders with the new song on the single background queue.
    memoryPreviewStatus.delete(id);
    void prepareMemoryPreviews([card]).catch(() => runtimeLog("memory-preview-error"));
    return memoryStateWithPreviews();
});
electron_1.ipcMain.handle("view-memory", async (_event, id) => {
    if (typeof id !== "string" || !id || id.length > 200)
        return { ok: false, error: "Invalid memory." };
    const suggestion = await memoryManager.getSuggestion(id);
    if (!suggestion || !suggestion.media.every((file) => memoryAllowed(file.path) &&
        (!file.liveVideoPath || memoryAllowed(file.liveVideoPath))))
        return { ok: false, error: "This memory is no longer available. Refresh suggestions." };
    const moviePath = await findMemoryMovie(suggestion);
    if (!moviePath) {
        const rendering = Array.from(memoryPreviewStatus.entries()).find(([, status]) => status.status === "rendering");
        return { ok: false, preparing: true, error: rendering && rendering[0] !== id
                ? "Please wait for the current memory to finish processing."
                : "This memory is still being prepared." };
    }
    if (!(await consumeDemoMemoryPreview(id))) {
        notifyDemoLimitReached("memoryPreviews");
        return {
            ok: false,
            error: `The demo includes ${demoLimits_1.DEMO_LIMITS.memoryPreviews} memory previews. Unlock Silo to watch more.`,
            upgradeRequired: true,
        };
    }
    return { ok: true, path: moviePath };
});
electron_1.ipcMain.handle("cancel-memory-export", () => {
    // Also covers the save dialog and pre-render checks, before the exporter has a controller.
    if (memoryExportRunning)
        memoryExportCancelRequested = true;
    memoryExporter.cancel();
});
electron_1.ipcMain.handle("export-memory", async (_event, rawOptions) => {
    if (memoryExportRunning)
        return { ok: false, error: "Another memory movie is already rendering." };
    const options = memoryExportOptions(rawOptions);
    if (!options)
        return { ok: false, error: "Invalid movie settings." };
    memoryExportRunning = true;
    memoryExportCancelRequested = false;
    let scratch = null;
    try {
        const initial = await verifyMemoryExport(options);
        if (!mainWindow || mainWindow.isDestroyed())
            throw new Error("The app window is not available.");
        const destination = await electron_1.dialog.showSaveDialog(mainWindow, {
            title: "Save memory movie",
            defaultPath: `${initial.suggestion.title.replace(/[^\p{L}\p{N} -]/gu, "").trim() || "Memory"}.mp4`,
            filters: [{ name: "Memory movie", extensions: ["mp4"] }],
        });
        if (destination.canceled || !destination.filePath || memoryExportCancelRequested)
            return { ok: false, canceled: true };
        // Hidden folders, bans, or the audio index may have changed while the dialog was open.
        const { suggestion, soundtrack } = await verifyMemoryExport(options);
        scratch = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-memory-export-"));
        if (memoryExportCancelRequested)
            return { ok: false, canceled: true };
        await runMemoryRender(async () => {
            memoryExportScratch = scratch;
            try {
                await memoryExporter.render(suggestion, options, soundtrack, destination.filePath, progress => sendToRenderer("memory-export-progress", progress));
            }
            finally {
                memoryExportScratch = null;
            }
        });
        // The movie is already saved; a bookkeeping failure must not report a failed export.
        await memoryManager.markDownloaded(suggestion.id).catch(() => undefined);
        return { ok: true, path: destination.filePath };
    }
    catch (cause) {
        if (memoryExportCancelRequested || cause instanceof memoryExporter_1.MemoryExportCancelledError ||
            (cause instanceof Error && cause.name === "AbortError"))
            return { ok: false, canceled: true };
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    finally {
        memoryExportScratch = null;
        if (scratch)
            await fsPromises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        memoryExportRunning = false;
        memoryExportCancelRequested = false;
    }
});
electron_1.ipcMain.handle("read-inventory-page", (event, token, offset) => {
    if (typeof token !== "string" || typeof offset !== "number")
        throw new Error("Invalid inventory request.");
    return inventoryTransfers.read(token, offset, event.sender.id);
});
electron_1.ipcMain.handle("release-inventory", (event, token) => inventoryTransfers.release(token, event.sender.id));
electron_1.ipcMain.handle("select-directory", async () => {
    if (mainWindow === null)
        return null;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});
electron_1.ipcMain.handle("select-source-clone-destination", async () => {
    if (!mainWindow)
        return [];
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Choose one or more source-clone destinations",
        buttonLabel: "Choose destinations",
        properties: ["openDirectory", "multiSelections"],
    });
    return !result.canceled ? result.filePaths : [];
});
electron_1.ipcMain.handle("prepare-source-clone", async (_event, sourceIds, destinations, operationId) => {
    const cleanIds = Array.isArray(sourceIds)
        ? sourceIds.filter((id) => typeof id === "string")
        : [];
    if (typeof operationId !== "string" || !operationId)
        return { ok: false, error: "Invalid clone operation." };
    try {
        const plan = await prepareSourceClone(cleanIds, Array.isArray(destinations) ? destinations.filter((item) => typeof item === "string") : [], operationId);
        return { ok: true, plan };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sourceCloneOperations.delete(operationId);
        sendSourceCloneProgress({
            operationId,
            phase: message.includes("cancel") ? "cancelled" : "error",
            destination: Array.isArray(destinations) ? destinations.filter((item) => typeof item === "string").join(" / ") : "",
            totalSources: cleanIds.length,
            totalFiles: 0,
            completedFiles: 0,
            totalBytes: 0,
            copiedBytes: 0,
            verifiedFiles: 0,
            failedFiles: 0,
            currentFile: "",
            message,
        });
        return { ok: false, error: message };
    }
});
electron_1.ipcMain.handle("prepare-shelter-replica", async (_event, destinations, operationId) => {
    const cleanDestinations = Array.isArray(destinations)
        ? destinations.filter((item) => typeof item === "string")
        : [];
    if (typeof operationId !== "string" || !operationId)
        return { ok: false, error: "Invalid shelter replica operation." };
    try {
        const plan = await prepareShelterReplica(cleanDestinations, operationId);
        return { ok: true, plan };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sourceCloneOperations.delete(operationId);
        sendSourceCloneProgress({
            operationId,
            phase: message.toLowerCase().includes("cancel") ? "cancelled" : "error",
            destination: cleanDestinations.join(" / "),
            totalSources: 1,
            totalFiles: 0,
            completedFiles: 0,
            totalBytes: 0,
            copiedBytes: 0,
            verifiedFiles: 0,
            failedFiles: 0,
            currentFile: "",
            message,
        });
        return { ok: false, error: message };
    }
});
electron_1.ipcMain.handle("start-source-clone", async (_event, planId, options) => {
    if (typeof planId !== "string")
        return { ok: false, error: "Invalid clone plan." };
    const compress = Boolean(options && typeof options === "object" &&
        options.compress === true);
    const createAppleCompatibleBackup = Boolean(options && typeof options === "object" &&
        options.createAppleCompatibleBackup === true);
    const plan = sourceClonePlans.get(planId);
    if (createAppleCompatibleBackup &&
        (!plan || plan.sourceIds.length !== 1 || plan.sourceIds[0] !== indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT ||
            !stateStore.getState().indexSources.some((source) => source.path === indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT && source.kind === "machine")))
        return { ok: false, error: "Time Machine can only be added to a clone of the registered This Mac source." };
    try {
        await runSourceClone(planId, { compress });
        if (!createAppleCompatibleBackup)
            return { ok: true };
        try {
            await (0, timeMachineBackup_1.startConfiguredTimeMachineBackup)(indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT, stateStore.getState().indexSources.some((source) => source.path === indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT && source.kind === "machine"));
            return { ok: true, timeMachineStarted: true };
        }
        catch (error) {
            return {
                ok: true,
                timeMachineError: error instanceof Error ? error.message : String(error),
            };
        }
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
});
electron_1.ipcMain.handle("start-machine-time-machine-backup", async (_event, sourceId) => {
    if (typeof sourceId !== "string" || sourceId !== indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT)
        return { ok: false, error: "Time Machine can only be requested for This Mac." };
    const sourceRegistered = process.platform === "darwin" &&
        stateStore.getState().indexSources.some((source) => source.path === indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT && source.kind === "machine");
    try {
        await (0, timeMachineBackup_1.startConfiguredTimeMachineBackup)(sourceId, sourceRegistered);
        return { ok: true, timeMachineStarted: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
});
electron_1.ipcMain.handle("extract-source-clone-archive", async (_event, operationId) => {
    if (typeof operationId !== "string" || !operationId)
        return { ok: false, error: "Invalid extraction operation." };
    if (!mainWindow)
        return { ok: false, error: "Silo's window is not available." };
    const archiveChoice = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Choose a compressed Silo clone (.zip) to extract",
        buttonLabel: "Choose archive",
        properties: ["openFile"],
        filters: [{ name: "Silo clone archive", extensions: ["zip"] }],
    });
    if (archiveChoice.canceled || !archiveChoice.filePaths[0])
        return { ok: false, cancelled: true };
    const archivePath = archiveChoice.filePaths[0];
    const destinationChoice = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Choose where to extract the clone",
        buttonLabel: "Extract here",
        defaultPath: path.dirname(archivePath),
        properties: ["openDirectory", "createDirectory"],
    });
    if (destinationChoice.canceled || !destinationChoice.filePaths[0])
        return { ok: false, cancelled: true };
    const destinationParent = destinationChoice.filePaths[0];
    const operation = { cancelled: false };
    sourceCloneOperations.set(operationId, operation);
    const base = { operationId, totalSources: 1, completedFiles: 0, totalBytes: 0, copiedBytes: 0,
        verifiedFiles: 0, failedFiles: 0, totalFiles: 0, currentFile: "" };
    sendSourceCloneProgress({ ...base, phase: "scanning", destination: destinationParent,
        message: `Reading ${path.basename(archivePath)}…` });
    let lastProgressAt = 0;
    try {
        const result = await (0, cloneArchive_1.extractCloneArchive)(archivePath, destinationParent, {
            isCancelled: () => operation.cancelled,
            onProgress: (progress) => {
                const now = Date.now();
                if (now - lastProgressAt < 350)
                    return;
                lastProgressAt = now;
                sendSourceCloneProgress({ ...base, phase: "copying", destination: destinationParent,
                    totalFiles: progress.totalFiles, completedFiles: progress.processedFiles,
                    verifiedFiles: progress.processedFiles, totalBytes: progress.totalBytes,
                    copiedBytes: progress.processedBytes, currentFile: progress.currentFile,
                    message: `Extracting and verifying ${progress.currentFile}` });
            },
        });
        sendSourceCloneProgress({ ...base, phase: "complete", destination: result.destinationRoot,
            totalFiles: result.extractedFiles, completedFiles: result.extractedFiles, verifiedFiles: result.extractedFiles,
            totalBytes: result.totalBytes, copiedBytes: result.totalBytes,
            message: `Extracted ${result.extractedFiles.toLocaleString()} files (SHA-256 verified) and ` +
                `${result.restoredAliases.toLocaleString()} duplicate paths to ${result.destinationRoot}.` });
        runtimeLog("source-clone-archive-extracted", { files: result.extractedFiles, aliases: result.restoredAliases });
        return { ok: true, destinationRoot: result.destinationRoot, extractedFiles: result.extractedFiles };
    }
    catch (error) {
        const message = operation.cancelled
            ? "Extraction cancelled; the partially extracted folder was removed."
            : error instanceof Error ? error.message : String(error);
        sendSourceCloneProgress({ ...base, phase: operation.cancelled ? "cancelled" : "error",
            destination: destinationParent, message });
        return { ok: false, error: message, cancelled: operation.cancelled };
    }
    finally {
        sourceCloneOperations.delete(operationId);
    }
});
electron_1.ipcMain.handle("cancel-source-clone", (_event, operationId) => {
    if (typeof operationId !== "string")
        return false;
    const operation = sourceCloneOperations.get(operationId);
    if (!operation)
        return false;
    operation.cancelled = true;
    return true;
});
electron_1.ipcMain.handle("get-files", async (_event, dirPath, exploded = false, requestId, scanOptions) => {
    if (typeof dirPath !== "string")
        return [];
    const emitIndexedPreview = async () => {
        if (!exploded || typeof requestId !== "number")
            return;
        const enabledPaths = await getEnabledIndexSources();
        const availableSources = await listSources();
        const indexed = filterForContentSafety(semanticIndexer
            .getIndexedFiles(enabledPaths)
            .filter((file) => dirPath === ALL_SOURCES_PATH ||
            file.path === dirPath ||
            file.path.startsWith(`${dirPath}${path.sep}`))
            .map((file) => {
            const source = availableSources
                .filter((candidate) => file.path === candidate.rootPath ||
                file.path.startsWith(`${candidate.rootPath}/`))
                .sort((first, second) => second.rootPath.length - first.rootPath.length)[0];
            return {
                ...file,
                sourceId: source?.id,
                sourceLabel: source?.label,
            };
        }));
        indexed.sort((first, second) => {
            const direction = scanOptions?.sortAscending === false ? -1 : 1;
            const field = scanOptions?.sortField ?? "name";
            if (field === "source") {
                const sourceOrder = naturalCollator.compare(first.sourceLabel || "", second.sourceLabel || "");
                return sourceOrder
                    ? sourceOrder * direction
                    : second.modified - first.modified;
            }
            let order = field === "size"
                ? first.size - second.size
                : field === "modified"
                    ? first.modified - second.modified
                    : field === "type"
                        ? first.type.localeCompare(second.type)
                        : naturalCollator.compare(first.name, second.name);
            if (!order)
                order = first.path.localeCompare(second.path);
            return order * direction;
        });
        mainWindow?.webContents.send("file-scan-progress", {
            requestId,
            directoryPath: dirPath,
            // Send the cached inventory once, not just its first 500 entries.
            // The renderer paginates the DOM; filtering stays client-side so changing
            // file types does not require waiting for this scan to finish.
            files: indexed.slice(0, 500),
            inventory: mainWindow
                ? inventoryTransfers.create(indexed, mainWindow.webContents.id)
                : undefined,
            scanned: indexed.length,
            total: indexed.length,
            done: false,
            isTimeMachine: false,
            errors: 0,
        });
    };
    await emitIndexedPreview();
    if (dirPath === ALL_SOURCES_PATH) {
        let browseScanErrors = 0;
        const progressCallback = typeof requestId === "number"
            ? (fileDeltas, scanned, total, audioFound, errors) => {
                browseScanErrors = errors;
                const visible = filterForContentSafety(fileDeltas);
                sendToRenderer("file-scan-progress", {
                    requestId,
                    directoryPath: dirPath,
                    fileDeltas: visible,
                    scanned,
                    total,
                    audioFound,
                    done: false,
                    isTimeMachine: false,
                    errors,
                });
            }
            : undefined;
        const files = filterForContentSafety(await readAllSources(Boolean(exploded), progressCallback));
        // The full list goes back once as the invoke result; the event only reports completion.
        if (typeof requestId === "number")
            sendToRenderer("file-scan-progress", {
                requestId,
                directoryPath: dirPath,
                scanned: files.length,
                total: files.length,
                audioFound: files.filter((file) => file.type === "audio").length,
                done: true,
                isTimeMachine: false,
                errors: browseScanErrors,
            });
        return files;
    }
    const owningSource = (await listSources())
        .filter((source) => dirPath === source.rootPath ||
        dirPath.startsWith(`${source.rootPath}/`))
        .sort((first, second) => second.rootPath.length - first.rootPath.length)[0];
    if (owningSource && (!owningSource.enabled || !owningSource.available))
        return [];
    if (phoneManager?.isPhonePath(dirPath)) {
        console.log(`[Phone] Listing files for path: ${dirPath}, exploded: ${exploded}`);
        try {
            const files = await (exploded
                ? phoneManager.listPhoneFilesRecursively(dirPath)
                : phoneManager.listPhoneFiles(dirPath, false));
            console.log(`[Phone] Found ${files.length} files for ${dirPath}`);
            // Log first few files for debugging
            if (files.length > 0) {
                console.log(`[Phone] Sample files:`, files.slice(0, 3).map((f) => f.name));
            }
            else {
                console.log(`[Phone] No files found for ${dirPath}`);
            }
            return filterForContentSafety(files.map((file) => ({
                ...file,
                sourceId: owningSource?.id,
                sourceLabel: owningSource?.label,
                ...(owningSource?.snapshotAt ? { sourceSnapshotAt: owningSource.snapshotAt } : {}),
            })));
        }
        catch (error) {
            console.error(`[Phone] Error listing files for ${dirPath}:`, error);
            return [];
        }
    }
    if (googleManager?.isCloudPath(dirPath)) {
        const files = await googleManager.listFiles(dirPath, Boolean(exploded));
        return filterForContentSafety(files.map((file) => ({
            ...file,
            sourceId: owningSource?.id,
            sourceLabel: owningSource?.label,
        })));
    }
    if (!path.isAbsolute(dirPath))
        return [];
    const diagnostics = {
        denied: 0,
        unreadable: 0,
        isTimeMachine: false,
    };
    const files = await readFiles(dirPath, Boolean(exploded), diagnostics, (progressFiles) => {
        // Send a bounded preview; resending the whole growing list each tick is quadratic.
        if (typeof requestId === "number") {
            const annotatedProgress = filterForContentSafety(progressFiles.slice(0, 500).map((file) => ({
                ...file,
                sourceId: owningSource?.id,
                sourceLabel: owningSource?.label,
            })));
            sendToRenderer("file-scan-progress", {
                requestId,
                directoryPath: dirPath,
                files: annotatedProgress,
                scanned: progressFiles.length,
                total: 0,
                audioFound: progressFiles.filter((file) => file.type === "audio")
                    .length,
                done: false,
                isTimeMachine: diagnostics.isTimeMachine,
                errors: diagnostics.denied + diagnostics.unreadable,
            });
        }
    }, owningSource?.kind === "machine" ? owningSource.rootPath : undefined);
    const annotatedFiles = filterForContentSafety(files.map((file) => ({
        ...file,
        sourceId: owningSource?.id,
        sourceLabel: owningSource?.label,
    })));
    mainWindow?.webContents.send("scan-issues", {
        directoryPath: dirPath,
        fileCount: files.length,
        ...diagnostics,
    });
    if (typeof requestId === "number")
        sendToRenderer("file-scan-progress", {
            requestId,
            directoryPath: dirPath,
            scanned: annotatedFiles.length,
            total: annotatedFiles.length,
            audioFound: annotatedFiles.filter((file) => file.type === "audio")
                .length,
            done: true,
            isTimeMachine: diagnostics.isTimeMachine,
            errors: diagnostics.denied + diagnostics.unreadable,
        });
    return annotatedFiles;
});
async function getVisibleAudioSnapshot(snapshot) {
    const availableSources = (await listSources()).filter((source) => source.available && source.rootPath.trim());
    const allSources = [];
    for (const source of availableSources) {
        if (!(await isSiloAppDataRoot(source.rootPath)))
            allSources.push(source);
    }
    const activeSources = allSources.filter((source) => source.enabled && source.available);
    const activeIds = new Set(activeSources.map((source) => source.id));
    const files = snapshot.files.filter((file) => file.sourceId && activeIds.has(file.sourceId));
    const cachedIds = [...snapshot.sourceIds].sort();
    const coverageIds = allSources.map((source) => source.id).sort();
    const sourceScannedAt = snapshot.sourceScannedAt ?? {};
    return {
        ...snapshot,
        files,
        extensions: Array.from(new Set(files.map((file) => file.extension || "(no extension)"))).sort(),
        stale: snapshot.scannedAt === 0 ||
            coverageIds.some((id) => {
                const scannedAt = sourceScannedAt[id] ?? 0;
                return !scannedAt || Date.now() - scannedAt > 24 * 60 * 60 * 1000;
            }) ||
            (snapshot.failedSources?.length ?? 0) > 0 ||
            cachedIds.length !== coverageIds.length ||
            cachedIds.some((id, index) => id !== coverageIds[index]),
    };
}
electron_1.ipcMain.handle("get-audio-library-cache", async () => {
    if (!audioLibraryCache)
        return { files: [], extensions: [], scannedAt: 0, sourceIds: [] };
    return getVisibleAudioSnapshot(audioLibraryCache.getSnapshot());
});
async function refreshAudioInventory(requestId, force = false) {
    if (!indexStorageAvailable)
        return { ok: false, error: indexStorageUnavailableMessage ?? "Index storage is unavailable." };
    if (!audioLibraryCache || typeof requestId !== "number")
        return { ok: false, error: "Audio library is unavailable." };
    const availableSources = (await listSources()).filter((source) => source.available && source.rootPath.trim());
    const sources = [];
    for (const source of availableSources) {
        if (!(await isSiloAppDataRoot(source.rootPath)))
            sources.push(source);
    }
    if (requestId === -1 && !force) {
        const cached = audioLibraryCache.getSnapshot();
        const now = Date.now();
        const pending = sources.some((source) => {
            const completedAt = cached.sourceScannedAt?.[source.id] ?? 0;
            const failed = cached.failedSources?.includes(source.id);
            const needsScan = !completedAt || now - completedAt >= 24 * 60 * 60 * 1000 || failed;
            return needsScan && (cached.sourceCooldownUntil?.[source.id] ?? 0) <= now;
        });
        if (!pending)
            return { ok: true, snapshot: await getVisibleAudioSnapshot(cached) };
    }
    audioInventoryRunning = true;
    try {
        const snapshot = await audioLibraryCache.scan(sources, isRemotePath, (fileName) => (0, audioTypes_1.isAudioFile)(fileName, mime.getType(fileName)), async (source) => {
            if (phoneManager.isPhonePath(source.rootPath)) {
                return (await phoneManager.listPhoneFilesRecursively(source.rootPath)).map((file) => ({
                    ...file,
                    sourceId: source.id,
                    sourceLabel: source.label,
                }));
            }
            if (googleManager.isCloudPath(source.rootPath)) {
                return (await googleManager.listFilesRecursively(source.rootPath)).map((file) => ({
                    ...file,
                    sourceId: source.id,
                    sourceLabel: source.label,
                }));
            }
            return [];
        }, (progress) => {
            audioInventoryProgress = progress;
            sendToRenderer("audio-library-scan-progress", {
                requestId,
                ...progress,
            });
        }, force);
        sendToRenderer("audio-library-cache-changed", snapshot.scannedAt);
        runtimeLog("audio-inventory-checkpoint", {
            files: snapshot.files.length,
            sources: snapshot.sourceIds.length,
            completedSources: Object.keys(snapshot.sourceScannedAt ?? {}).length,
            failedSources: snapshot.failedSources?.length ?? 0,
        });
        return { ok: true, snapshot: await getVisibleAudioSnapshot(snapshot) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
    }
    finally {
        audioInventoryRunning = false;
    }
}
electron_1.ipcMain.handle("refresh-audio-library-cache", (_event, requestId, force) => {
    if (typeof requestId !== "number")
        return { ok: false, error: "Invalid audio scan request." };
    return refreshAudioInventory(requestId, force === true);
});
electron_1.ipcMain.handle("get-file-preview", async (_event, filePath) => {
    try {
        const remote = isRemotePath(filePath);
        let mimeType = mime.getType(filePath);
        const extension = path.extname(filePath).toLowerCase();
        let sourcePath;
        if (extension === ".ts") {
            sourcePath = await resolveLocalPath(filePath);
            const { data } = await (0, documentPreview_1.readPreviewBytes)(sourcePath, 1024);
            const transportStream = (data[0] === 0x47 && data[188] === 0x47 && data[376] === 0x47) ||
                (data[4] === 0x47 && data[196] === 0x47 && data[388] === 0x47);
            if (!transportStream)
                mimeType = "text/plain";
        }
        const isMedia = mimeType?.startsWith("video/") || mimeType?.startsWith("audio/");
        // Remote media streams lazily through app-media; only images are pulled eagerly.
        const video = mimeType?.startsWith("video/") ?? false;
        const needsVideoConversion = video && !directlyPlayableVideoExtensions.has(extension);
        const deferDownload = remote && Boolean(isMedia) && !needsVideoConversion;
        const localPath = deferDownload
            ? filePath
            : (sourcePath ?? (await resolveLocalPath(filePath)));
        let size = 0;
        let modifiedMs = Date.now();
        if (deferDownload) {
            const remoteStat = phoneManager?.isPhonePath(filePath)
                ? await phoneManager.statPhoneFile(filePath)
                : await googleManager.statCloudFile(filePath);
            size = remoteStat?.size ?? 0;
            modifiedMs = remoteStat?.modified || Date.now();
        }
        else {
            const stats = await fsPromises.stat(localPath);
            size = stats.size;
            modifiedMs = stats.mtimeMs;
        }
        let previewDataUrl = null;
        if (mimeType?.startsWith("image/")) {
            if (browserImageTypes.has(mimeType)) {
                const sourceBuffer = await fsPromises.readFile(localPath);
                previewDataUrl = `data:${mimeType};base64,${sourceBuffer.toString("base64")}`;
            }
            else {
                const sourceImage = electron_1.nativeImage.createFromPath(localPath);
                if (!sourceImage.isEmpty()) {
                    previewDataUrl = sourceImage.toDataURL();
                }
                else {
                    const converted = await getConvertedImageBuffer(localPath, 2400, 88, "preview-cache");
                    previewDataUrl = `data:image/jpeg;base64,${converted.toString("base64")}`;
                }
            }
        }
        const playableVideo = video
            ? await getPlayableVideoPath(filePath, localPath, size, modifiedMs)
            : null;
        const documentPreview = !mimeType?.startsWith("image/") && !isMedia
            ? await (0, documentPreview_1.getDocumentPreview)(localPath, path.basename(filePath), mimeType)
            : undefined;
        return {
            name: path.basename(filePath),
            size,
            modified: new Date(modifiedMs).toLocaleString(),
            mimeType,
            extension,
            path: filePath,
            previewDataUrl,
            mediaUrl: `app-media://stream/${encodeURIComponent(playableVideo?.path ?? filePath)}`,
            playbackMimeType: playableVideo?.transcoded
                ? "video/mp4"
                : mime.getType(playableVideo?.path ?? filePath),
            transcoded: playableVideo?.transcoded ?? false,
            documentPreview,
        };
    }
    catch (err) {
        console.error("Error getting file preview:", err);
        return null;
    }
});
electron_1.ipcMain.handle("get-thumbnail", async (_event, filePath, urgent, force, requestedSize) => {
    if (typeof filePath !== "string")
        return null;
    const remote = isRemotePath(filePath);
    const thumbnailSize = Math.max(120, Math.min(480, Math.round(Number(requestedSize) || 480)));
    if (!remote && !path.isAbsolute(filePath))
        return null;
    const pendingKey = `${filePath}:${thumbnailSize}`;
    const pending = pendingThumbnails.get(pendingKey);
    if (pending && !force) {
        if (urgent) {
            for (const job of thumbnailJobs)
                if (job.filePath === filePath)
                    job.priority = 0;
            sortThumbnailJobs();
        }
        return pending;
    }
    const request = (async () => {
        const localPath = await resolveLocalPath(filePath);
        return await queueThumbnail(filePath, () => getThumbnail(localPath, force === true, thumbnailSize), urgent === true || force === true);
    })()
        .catch(() => null)
        .finally(() => pendingThumbnails.delete(pendingKey));
    pendingThumbnails.set(pendingKey, request);
    return request;
});
electron_1.ipcMain.handle("get-thumbnail-pregen-progress", () => thumbnailPregenerator?.getProgress() ?? null);
electron_1.ipcMain.on("update-visible-thumbnails", (_event, visiblePaths) => {
    visibleThumbnailPaths.clear();
    visiblePaths.forEach((p) => visibleThumbnailPaths.add(p));
    sortThumbnailJobs();
});
electron_1.ipcMain.handle("create-folder", async (_event, parentPath, folderName) => {
    if (!path.isAbsolute(parentPath) ||
        !folderName.trim() ||
        folderName !== path.basename(folderName)) {
        return { ok: false, error: "Enter a valid folder name." };
    }
    try {
        await fsPromises.mkdir(path.join(parentPath, folderName.trim()));
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not create folder.",
        };
    }
});
electron_1.ipcMain.handle("move-file", async (_event, sourcePath) => {
    if (!mainWindow || !path.isAbsolute(sourcePath))
        return { ok: false, error: "Invalid file." };
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Move file to folder",
        properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0])
        return { ok: false, canceled: true };
    const destinationPath = path.join(result.filePaths[0], path.basename(sourcePath));
    try {
        await fsPromises.access(destinationPath).then(() => Promise.reject(new Error("A file with this name already exists in that folder.")), () => undefined);
        try {
            await fsPromises.rename(sourcePath, destinationPath);
        }
        catch (error) {
            if (error.code !== "EXDEV")
                throw error;
            await fsPromises.copyFile(sourcePath, destinationPath);
            await fsPromises.unlink(sourcePath);
        }
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not move file.",
        };
    }
});
electron_1.ipcMain.handle("save-file-to-device", async (_event, sourcePath, suggestedFileName) => {
    const isPhoneFile = isRemotePath(sourcePath);
    if (!mainWindow || (!isPhoneFile && !path.isAbsolute(sourcePath)))
        return { ok: false, error: "Invalid file." };
    const result = await electron_1.dialog.showSaveDialog(mainWindow, {
        title: "Save file to",
        defaultPath: suggestedFileName,
    });
    if (result.canceled || !result.filePath)
        return { ok: false, canceled: true };
    try {
        const localPath = await resolveLocalPath(sourcePath);
        await fsPromises.copyFile(localPath, result.filePath);
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not save file.",
        };
    }
});
electron_1.ipcMain.handle("get-app-state", () => ({
    ...stateStore.getState(),
    indexProgress: semanticIndexer.getProgress(),
}));
electron_1.ipcMain.handle("get-content-settings", () => contentSettingsStore.getPublicSettings());
electron_1.ipcMain.handle("set-parental-password", (_event, currentPassword, newPassword) => contentSettingsStore.setParentalPassword(currentPassword, newPassword));
electron_1.ipcMain.handle("update-content-settings", async (_event, update, password) => {
    const settings = await contentSettingsStore.updatePreferences(update, password);
    mainWindow?.webContents.send("content-settings-changed", settings);
    return settings;
});
electron_1.ipcMain.handle("magic-rank", (_event, items, preset) => {
    const clean = Array.isArray(items)
        ? items.flatMap((item) => item && typeof item.path === "string" && path.isAbsolute(item.path)
            ? [
                {
                    path: item.path,
                    size: Number(item.size) || 0,
                    modified: Number(item.modified) || 0,
                    name: String(item.name ?? ""),
                },
            ]
            : [])
        : [];
    const presetId = preset === "people" || preset === "landscapes" || preset === "variety"
        ? preset
        : "balanced";
    kickMagicBackground(10000);
    return aestheticScorer.rank(clean, presetId);
});
let magicKickTimer = null;
/** Queues every indexed local photo for magic scoring at low priority (debounced). */
function kickMagicBackground(delay) {
    if (magicKickTimer)
        clearTimeout(magicKickTimer);
    magicKickTimer = setTimeout(async () => {
        magicKickTimer = null;
        if (!aestheticScorer || !semanticIndexer)
            return;
        if (!startupIndexReconciliationSettled ||
            semanticIndexer.getProgress().status !== "complete" ||
            PIPELINE_BUSY_STATUSES.has(faceIndexer.getProgress().status) ||
            ["loading-model", "clustering"].includes(petIndexer.getProgress().status)) {
            kickMagicBackground(30000);
            return;
        }
        try {
            const sources = await getAllIndexSources();
            const images = semanticIndexer
                .getIndexedImages(sources)
                .filter((file) => !isRemotePath(file.path))
                .map((file) => ({
                path: file.path,
                size: file.size,
                modified: file.modified,
                name: file.name,
            }));
            await aestheticScorer.analyzeInBackground(images);
        }
        catch (error) {
            runtimeLog("magic-background-error", { message: String(error) });
        }
    }, delay);
}
electron_1.ipcMain.handle("export-config", async (_event, rendererPrefs) => {
    if (!mainWindow)
        return { ok: false, error: "App window is unavailable." };
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await electron_1.dialog.showSaveDialog(mainWindow, {
        title: "Export Silo config",
        defaultPath: path.join(electron_1.app.getPath("documents"), `silo-config-${stamp}.siloconfig`),
        filters: [{ name: "Silo config", extensions: ["siloconfig"] }],
    });
    if (result.canceled || !result.filePath)
        return { ok: false, canceled: true };
    const prefs = rendererPrefs && typeof rendererPrefs === "object"
        ? Object.fromEntries(Object.entries(rendererPrefs).filter(([key, value]) => key.startsWith("silo.") && typeof value === "string"))
        : {};
    try {
        const { size } = await (0, configBundle_1.exportConfig)(electron_1.app.getPath("userData"), result.filePath, electron_1.app.getVersion(), prefs, indexStorageRoot);
        return { ok: true, path: result.filePath, size };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Export failed.",
        };
    }
});
electron_1.ipcMain.handle("import-config", async () => {
    if (!mainWindow)
        return { ok: false, error: "App window is unavailable." };
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Import Silo config",
        properties: ["openFile"],
        filters: [{ name: "Silo config", extensions: ["siloconfig"] }],
    });
    if (result.canceled || !result.filePaths[0])
        return { ok: false, canceled: true };
    try {
        const manifest = await (0, configBundle_1.stageConfigImport)(electron_1.app.getPath("userData"), result.filePaths[0]);
        return { ok: true, manifest };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Import failed.",
        };
    }
});
electron_1.ipcMain.handle("apply-config-import", async () => {
    await (0, configBundle_1.commitStagedImport)(electron_1.app.getPath("userData"));
    electron_1.app.relaunch();
    electron_1.app.exit(0);
});
electron_1.ipcMain.handle("cancel-config-import", () => (0, configBundle_1.cancelStagedImport)(electron_1.app.getPath("userData")));
electron_1.ipcMain.handle("get-duplicate-state", async () => {
    await duplicateManager
        .pruneMissing()
        .catch((error) => console.warn("[DUPLICATE] Prune failed:", error));
    await getEnabledIndexSources();
    return filterDuplicateState(duplicateManager.getState());
});
electron_1.ipcMain.handle("scan-duplicates", async () => {
    const sources = await getAllIndexSources();
    await getEnabledIndexSources();
    return filterDuplicateState(await duplicateManager.scan(semanticIndexer.getIndexedFiles(sources), sources));
});
electron_1.ipcMain.handle("quarantine-duplicates", (_event, groupIds) => duplicateManager.quarantine(groupIds));
electron_1.ipcMain.handle("quarantine-duplicate-files", (_event, filePaths) => duplicateManager.quarantineFiles(filePaths));
electron_1.ipcMain.handle("restore-duplicates", (_event, ids) => duplicateManager.restore(ids));
electron_1.ipcMain.handle("clear-duplicate-trash", async (_event, ids) => {
    if (fullAccessEnabled())
        return duplicateManager.clearTrash(ids);
    const deletion = demoDuplicateDeleteQueue.then(async () => {
        const trash = duplicateManager.getState().trash;
        const selectedIds = ids ? new Set(ids) : null;
        const requested = trash.filter((item) => !selectedIds || selectedIds.has(item.id));
        const usage = await readDemoUsage();
        const allowed = (0, demoLimits_1.selectDemoDeletionBatch)(requested, false, usage.duplicateFilesDeleted, demoLimits_1.DEMO_LIMITS.duplicateDeletes);
        const exceedsLimit = requested.length > allowed.length;
        if (allowed.length === 0) {
            if (exceedsLimit)
                notifyDemoLimitReached("duplicateDeletes");
            return duplicateManager.getState();
        }
        const result = await duplicateManager.clearTrash(allowed.map((item) => item.id));
        const remainingIds = new Set(result.trash.map((item) => item.id));
        const deletedCount = allowed.filter((item) => !remainingIds.has(item.id)).length;
        await recordDemoDuplicateDeletes(deletedCount);
        if (exceedsLimit)
            notifyDemoLimitReached("duplicateDeletes");
        return result;
    });
    demoDuplicateDeleteQueue = deletion.then(() => undefined, () => undefined);
    return deletion;
});
electron_1.ipcMain.handle("update-ui-state", async (_event, update) => stateStore.updateUi(update));
electron_1.ipcMain.handle("select-index-source", async () => {
    if (!mainWindow)
        return null;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Add source to semantic index",
        properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0])
        return null;
    const newSourcePath = result.filePaths[0];
    const alreadyRegistered = stateStore
        .getState()
        .indexSources.some((source) => source.path === newSourcePath);
    if (!fullAccessEnabled() &&
        !alreadyRegistered &&
        (await getDemoSourceCount()) >= demoLimits_1.DEMO_LIMITS.sources) {
        notifyDemoLimitReached("sources");
        return null;
    }
    await stateStore.addIndexSource(newSourcePath);
    sourceListCacheAt = 0;
    void indexNewSources([newSourcePath], "local-source-added");
    return stateStore.getState();
});
electron_1.ipcMain.handle("add-machine-source", async () => {
    if (process.platform !== "darwin")
        return null;
    if (!(await fsPromises.access(indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT, fs.constants.R_OK).then(() => true, () => false)))
        return null;
    const existing = stateStore.getState().indexSources.some((source) => source.path === indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT);
    if (!fullAccessEnabled() && !existing &&
        (await getDemoSourceCount()) >= demoLimits_1.DEMO_LIMITS.sources) {
        notifyDemoLimitReached("sources");
        return null;
    }
    await stateStore.addMachineSource(indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT);
    sourceListCacheAt = 0;
    void indexNewSources([indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT], "machine-source-added");
    return stateStore.getState();
});
electron_1.ipcMain.handle("remove-index-source", async (_event, sourcePath) => {
    await stateStore.removeIndexSource(sourcePath);
    sourceListCacheAt = 0;
    // Update watchers to remove this source (but keep index for potential future re-add)
    await getEnabledIndexSources();
    const sources = await getAllIndexSources();
    if (sources.length > 0) {
        await semanticIndexer.startWatching(sources);
    }
    else {
        semanticIndexer.stopWatching();
    }
    return stateStore.getState();
});
electron_1.ipcMain.handle("start-indexing", async () => {
    if (!indexStorageAvailable)
        return semanticIndexer.getProgress();
    const sources = await getAllIndexSources();
    console.log("[start-indexing] Starting indexing with sources:", sources);
    if (sources.length === 0) {
        console.log("[start-indexing] No configured sources found");
        return semanticIndexer.getProgress();
    }
    indexRecovery?.clearUserPause("search");
    // Ensure file watchers are set up
    await semanticIndexer.startWatching(sources);
    // Check for changes and index only what's new/modified
    const changedFiles = await semanticIndexer.reconcileIndex(sources);
    const remoteSources = sources.filter(isRemotePath);
    if (remoteSources.length)
        await semanticIndexer.start(remoteSources);
    console.log(`[start-indexing] Found ${changedFiles.size} changed files to re-index`);
    if (fullAccessEnabled())
        await semanticIndexer.start(sources, changedFiles);
    else
        await semanticIndexer.startFullScan(sources);
    requestSourceProcessingStages(sources);
    return semanticIndexer.getProgress();
});
electron_1.ipcMain.handle("pause-indexing", async () => {
    indexRecovery?.pause("search");
    await semanticIndexer.pause();
    return semanticIndexer.getProgress();
});
const semanticSearchGenerations = new WeakMap();
const supersedeSemanticSearch = (sender) => {
    const generation = (semanticSearchGenerations.get(sender) ?? 0) + 1;
    semanticSearchGenerations.set(sender, generation);
    return generation;
};
electron_1.ipcMain.handle("cancel-semantic-search", (event) => {
    supersedeSemanticSearch(event.sender);
});
electron_1.ipcMain.handle("semantic-search", async (event, query, confidence, requestId) => {
    const sender = event.sender;
    const generation = supersedeSemanticSearch(sender);
    const isCancelled = () => sender.isDestroyed() || semanticSearchGenerations.get(sender) !== generation;
    const progressRequestId = Number.isSafeInteger(requestId) ? requestId : generation;
    const minimumConfidence = (0, semanticIndexer_1.confidenceSettingToMinimumThreshold)(confidence);
    const contentSettings = contentSettingsStore.getPublicSettings();
    if (contentSettings.safeSearch && (0, contentPolicy_1.containsExplicitTerms)(query))
        throw new Error("This search is blocked by Safe Search. A parental password is required to change Safe Search in Settings.");
    const sources = await getEnabledIndexSources();
    if (isCancelled())
        return [];
    // Read only the search fields here. getState() structured-clones the entire
    // persisted library, which made every keystroke copy hundreds of thousands
    // of metadata records before a result could be shown.
    const state = stateStore.getSearchState();
    const normalizedQuery = query.trim().toLowerCase();
    const priorityMatches = new Map();
    const addPriorityMatch = (filePath, priority, source, name) => {
        const previous = priorityMatches.get(filePath);
        if (!previous || priority < previous.priority)
            priorityMatches.set(filePath, { priority, source, name });
    };
    if (normalizedQuery) {
        for (const folder of state.digitalFolders) {
            if (!folder.name.toLowerCase().includes(normalizedQuery))
                continue;
            for (const filePath of folder.filePaths)
                addPriorityMatch(filePath, 2, `In folder: ${folder.name}`);
        }
        // User-confirmed people photos outrank inferred visual similarity.
        for (const person of faceIndexer.getPeople()) {
            if (!person.name.toLowerCase().includes(normalizedQuery))
                continue;
            const detail = faceIndexer.getPerson(person.id);
            for (const filePath of detail?.confirmedPhotoPaths ?? [])
                addPriorityMatch(filePath, 1, `Named as: ${person.name}`);
        }
        // Pet names and other explicit name assignments remain searchable. Person
        // cluster suggestions are excluded here; only confirmed cluster photos win.
        const matchingPetPaths = new Set();
        for (const entry of state.nameIndex) {
            if (entry.sourceType === "person" ||
                !entry.name.toLowerCase().includes(normalizedQuery))
                continue;
            for (const fileEntry of entry.filePaths) {
                addPriorityMatch(fileEntry.path, 1, `Named as: ${entry.name}`);
                if (entry.sourceType === "pet")
                    matchingPetPaths.add(fileEntry.path);
            }
        }
        if (matchingPetPaths.size) {
            for (const folder of state.digitalFolders) {
                if (!folder.filePaths.some((filePath) => matchingPetPaths.has(filePath)))
                    continue;
                for (const filePath of folder.filePaths)
                    addPriorityMatch(filePath, 1, `In folder: ${folder.name}`);
            }
        }
        // User-authored aliases and keywords are the strongest exact matches.
        for (const [filePath, metadata] of Object.entries(state.fileMetadata)) {
            const aliasMatches = metadata.displayName
                ?.toLowerCase()
                .includes(normalizedQuery);
            const keywordMatches = metadata.keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery));
            if (aliasMatches || keywordMatches)
                addPriorityMatch(filePath, 0, aliasMatches
                    ? `Virtual name: ${metadata.displayName}`
                    : `Keywords: ${metadata.keywords.join(", ")}`, metadata.displayName);
        }
    }
    const rankResults = (semanticResults) => {
        const semanticResultsByPath = new Map(semanticResults.map((result) => [result.path, result]));
        const allResults = new Map();
        for (const result of semanticResults)
            allResults.set(result.path, {
                ...result,
                _priority: 3,
                _source: undefined,
            });
        for (const [filePath, match] of priorityMatches) {
            const semanticResult = semanticResultsByPath.get(filePath);
            allResults.set(filePath, {
                ...(semanticResult || {
                    name: path.basename(filePath),
                    path: filePath,
                    relativePath: filePath,
                    size: 0,
                    modified: Date.now(),
                    isDirectory: false,
                    type: "image",
                    extension: path.extname(filePath).slice(1),
                    confidence: 100,
                }),
                ...(match.name ? { name: match.name } : {}),
                confidence: 100,
                _priority: match.priority,
                _source: match.source,
            });
        }
        const activeResults = filterForEnabledSources(Array.from(allResults.values()), new Set(sources)).filter((result) => Number.isFinite(result.confidence) &&
            result.confidence >= minimumConfidence);
        if (isCancelled())
            return [];
        return filterForContentSafety(activeResults).sort((first, second) => {
            const priorityDifference = (first._priority ?? 3) - (second._priority ?? 3);
            return priorityDifference || second.confidence - first.confidence;
        });
    };
    const publishProgress = (status, semanticResults, scanned = 0, total = 0) => {
        if (isCancelled())
            return;
        sender.send("semantic-search-progress", {
            requestId: progressRequestId,
            status,
            results: rankResults(semanticResults),
            scanned,
            total,
        });
    };
    // Exact metadata and confirmed-name hits appear before CLIP loads/scans.
    publishProgress("searching", []);
    let scannedRecords = 0;
    let totalRecords = 0;
    const semanticResults = await semanticIndexer.search(query, minimumConfidence, sources, isCancelled, (partialResults, scanned, total) => {
        scannedRecords = scanned;
        totalRecords = total;
        publishProgress("searching", partialResults, scanned, total);
    });
    if (isCancelled())
        return [];
    const results = rankResults(semanticResults);
    sender.send("semantic-search-progress", {
        requestId: progressRequestId,
        status: "done",
        results,
        scanned: scannedRecords,
        total: totalRecords,
    });
    return results;
});
electron_1.ipcMain.handle("create-digital-folder", async (_event, name) => {
    const folderCount = stateStore
        .getState()
        .digitalFolders.filter((folder) => folder.id !== stateStore_1.FAVORITES_FOLDER_ID && folder.id !== stateStore_1.REFUSE_FOLDER_ID).length;
    if ((0, demoLimits_1.isDemoLimitReached)(fullAccessEnabled(), folderCount, demoLimits_1.DEMO_LIMITS.digitalFolders)) {
        notifyDemoLimitReached("digitalFolders");
        throw new Error(`The demo includes up to ${demoLimits_1.DEMO_LIMITS.digitalFolders} digital folders. Unlock Silo to create more.`);
    }
    return stateStore.createDigitalFolder(name);
});
electron_1.ipcMain.handle("rename-digital-folder", (_event, folderId, name) => {
    if (typeof folderId !== "string" || typeof name !== "string")
        throw new Error("Invalid folder rename request.");
    return stateStore.renameDigitalFolder(folderId, name);
});
electron_1.ipcMain.handle("move-digital-folder", (_event, sourceId, targetId, after) => {
    if (typeof sourceId !== "string" ||
        typeof targetId !== "string" ||
        typeof after !== "boolean")
        throw new Error("Invalid folder order request.");
    return stateStore.moveDigitalFolder(sourceId, targetId, after);
});
electron_1.ipcMain.handle("delete-digital-folder", async (_event, folderId) => {
    const before = getHiddenFolderPaths();
    const result = await stateStore.deleteDigitalFolder(folderId);
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
});
electron_1.ipcMain.handle("set-digital-folder-hidden", async (_event, folderId, hidden) => {
    const before = getHiddenFolderPaths();
    const result = await stateStore.setDigitalFolderHidden(folderId, hidden);
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
});
electron_1.ipcMain.handle("update-file-metadata", async (_event, filePaths, update) => stateStore.updateFileMetadata(filePaths, update));
electron_1.ipcMain.handle("add-digital-folder-reference", async (_event, folderId, filePath) => {
    const before = getHiddenFolderPaths();
    const result = await stateStore.addDigitalFolderReference(folderId, filePath);
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
});
electron_1.ipcMain.handle("add-digital-folder-references", async (_event, folderId, filePaths) => {
    if (typeof folderId !== "string" || !Array.isArray(filePaths))
        throw new Error("Invalid album request.");
    const before = getHiddenFolderPaths();
    const result = await stateStore.addDigitalFolderReferences(folderId, filePaths.filter((filePath) => typeof filePath === "string" && filePath.length > 0));
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
});
electron_1.ipcMain.handle("remove-digital-folder-reference", async (_event, folderId, filePath) => {
    const before = getHiddenFolderPaths();
    const result = await stateStore.removeDigitalFolderReference(folderId, filePath);
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
});
electron_1.ipcMain.handle("get-digital-folder-files", async (_event, folderId) => {
    const folder = stateStore
        .getState()
        .digitalFolders.find((item) => item.id === folderId);
    if (!folder)
        return [];
    const sources = new Set(await getEnabledIndexSources());
    const files = await readReferencedFiles(folder.filePaths);
    return filterForContentSafety(filterForEnabledSources(files, sources), folder.hidden ? folder.id : undefined);
});
electron_1.ipcMain.handle("download-digital-folder", async (_event, folderId) => {
    if (!mainWindow)
        return { ok: false, error: "App window is unavailable." };
    const folder = stateStore
        .getState()
        .digitalFolders.find((item) => item.id === folderId);
    if (!folder)
        return { ok: false, error: "Digital folder not found." };
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: `Save ${folder.name} to device`,
        properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0])
        return { ok: false, canceled: true };
    let copied = 0;
    let failed = 0;
    for (const sourcePath of folder.filePaths) {
        try {
            const parsedName = path.parse(sourcePath);
            let destinationPath = path.join(result.filePaths[0], parsedName.base);
            let suffix = 2;
            while (await fsPromises.access(destinationPath).then(() => true, () => false)) {
                destinationPath = path.join(result.filePaths[0], `${parsedName.name} (${suffix})${parsedName.ext}`);
                suffix += 1;
            }
            const localPath = await resolveLocalPath(sourcePath);
            await fsPromises.copyFile(localPath, destinationPath);
            copied += 1;
        }
        catch {
            failed += 1;
        }
    }
    return {
        ok: failed === 0,
        copied,
        failed,
        error: failed > 0
            ? `${failed} file${failed === 1 ? "" : "s"} could not be copied.`
            : undefined,
    };
});
electron_1.ipcMain.handle("get-face-state", async () => {
    const sources = new Set(await getEnabledIndexSources());
    const visiblePeople = getDemoPeople();
    const people = await Promise.all(visiblePeople.map(async (summary) => {
        const detail = faceIndexer.getPerson(summary.id);
        if (!detail)
            return null;
        const paths = detail.photoPaths.filter((photoPath) => fileIsInEnabledSource(photoPath, sources));
        if (paths.length === 0)
            return null;
        const pathSet = new Set(paths);
        const confirmedPhotoPaths = detail.confirmedPhotoPaths.filter((photoPath) => pathSet.has(photoPath));
        const faces = detail.faces.filter((face) => pathSet.has(face.imagePath));
        return {
            ...summary,
            photoCount: paths.length,
            faceCount: faces.length,
            confirmedCount: confirmedPhotoPaths.length,
            reviewableCount: Math.min(summary.reviewableCount, paths.length),
            hiddenCount: Math.max(0, paths.length - Math.min(summary.reviewableCount, paths.length)),
            fullyConfirmed: paths.length > 0 &&
                confirmedPhotoPaths.length >=
                    Math.min(summary.reviewableCount, paths.length),
        };
    }));
    return {
        progress: { ...faceIndexer.getProgress(), people: visiblePeople.length },
        people: people.filter((person) => person !== null),
    };
});
electron_1.ipcMain.handle("retry-indexing-stage", async (_event, id) => {
    if (typeof id !== "string" || !indexRecovery)
        throw new Error("Index recovery is not ready.");
    await indexRecovery.retry(id);
    return { ok: true };
});
async function collectShelterSourceFiles(source, operationId) {
    const files = [];
    const fingerprint = new inventoryFingerprint_1.InventoryFingerprint();
    const add = (relativePath, localPath, size, modified) => {
        files.push({ relativePath, localPath, size, modified });
        fingerprint.add(relativePath, size, modified);
    };
    if (source.kind === "local" || source.kind === "machine") {
        await listLocalCloneEntries(source.rootPath, operationId, (entry) => {
            if (!entry.isDirectory && entry.localPath)
                add(entry.destinationRelativePath, entry.localPath, entry.size, entry.modified);
        });
    }
    else {
        const remoteEntries = phoneManager.isPhonePath(source.rootPath)
            ? await phoneManager.listPhoneFilesRecursively(source.rootPath)
            : await googleManager.listFilesRecursively(source.rootPath);
        for (const remote of remoteEntries) {
            ensureCloneActive(operationId);
            if (remote.isDirectory)
                continue;
            const localPath = await resolveLocalPath(remote.path);
            const stats = await fsPromises.stat(localPath);
            const size = Number.isFinite(remote.size) && remote.size >= 0 ? remote.size : stats.size;
            const modified = Number.isFinite(remote.modified) ? remote.modified : stats.mtimeMs;
            add(remote.relativePath || remote.name, localPath, size, modified);
        }
    }
    return { files, fingerprint: fingerprint.finish() };
}
async function findLatestCompleteShelterClone(sourceId, destination, clonePaths) {
    const candidates = [];
    for (const clonePath of new Set(clonePaths)) {
        if (path.resolve(path.dirname(clonePath)) !== path.resolve(destination))
            continue;
        try {
            const [stats, linkStats, resolved] = await Promise.all([
                fsPromises.stat(clonePath),
                fsPromises.lstat(clonePath),
                fsPromises.realpath(clonePath),
            ]);
            const isArchive = path.extname(clonePath).toLowerCase() === cloneArchive_1.CLONE_ARCHIVE_EXTENSION;
            if (linkStats.isSymbolicLink() || (isArchive ? !stats.isFile() : !stats.isDirectory()) ||
                path.dirname(resolved) !== path.resolve(destination))
                continue;
            candidates.push({ path: clonePath, modified: stats.mtimeMs });
        }
        catch {
            continue;
        }
    }
    candidates.sort((left, right) => right.modified - left.modified);
    for (const candidate of candidates) {
        try {
            const manifest = await (0, shelterVerification_1.readShelterCloneManifest)(candidate.path);
            const containsSource = [...manifest.files,
                ...manifest.aliases]
                .some((entry) => entry.sourceId === sourceId);
            if (containsSource)
                return candidate.path;
        }
        catch {
            continue;
        }
    }
    return null;
}
async function verifyShelterSources(sourceIds) {
    const destinationState = await getShelterDestinationState();
    if (!destinationState.destination)
        throw new Error("Choose a Fallout Shelter destination before verifying backups.");
    if (!destinationState.available)
        throw new Error("The selected Fallout Shelter destination is not connected and readable.");
    const destination = destinationState.destination;
    const registeredSources = await listSources();
    const selected = registeredSources.filter((source) => sourceIds.includes(source.id));
    if (!sourceIds.length || selected.length !== new Set(sourceIds).size || selected.some((source) => !source.available))
        throw new Error("Select only connected, available sources before verifying backups.");
    const operationId = `shelter-audit-${Date.now()}-${(0, crypto_1.randomBytes)(4).toString("hex")}`;
    sourceCloneOperations.set(operationId, { cancelled: false });
    try {
        for (const source of selected) {
            ensureCloneActive(operationId);
            const previous = (await getSourceCloneStatus())?.[source.id];
            const previousAudit = previous?.shelterAudits?.[destination];
            let audit;
            try {
                const { files, fingerprint } = await collectShelterSourceFiles(source, operationId);
                const clonePath = await findLatestCompleteShelterClone(source.id, destination, previous?.destinations ?? []);
                if (!clonePath) {
                    audit = {
                        clonePath: null,
                        lastFullyVerifiedAt: previousAudit?.lastFullyVerifiedAt ?? null,
                        lastAttemptAt: Date.now(),
                        lastResult: "missing",
                        verifiedFiles: 0,
                        totalFiles: files.length,
                        sourceFingerprint: fingerprint,
                        message: "No complete source clone was found in the selected shelter destination.",
                    };
                }
                else {
                    const result = await (0, shelterVerification_1.verifyShelterCloneSource)(clonePath, source.id, files);
                    const verifiedAt = result.verified ? Date.now() : previousAudit?.lastFullyVerifiedAt ?? null;
                    audit = {
                        clonePath,
                        lastFullyVerifiedAt: verifiedAt,
                        lastAttemptAt: Date.now(),
                        lastResult: result.verified ? "verified" : "mismatch",
                        verifiedFiles: result.verifiedFiles,
                        totalFiles: result.totalFiles,
                        sourceFingerprint: result.verified ? fingerprint : previousAudit?.sourceFingerprint,
                        message: result.error ?? (result.verified
                            ? undefined
                            : `${result.missingFiles} missing · ${result.changedFiles} changed · ${result.extraFiles} extra`),
                    };
                }
            }
            catch (error) {
                audit = {
                    clonePath: previousAudit?.clonePath ?? null,
                    lastFullyVerifiedAt: previousAudit?.lastFullyVerifiedAt ?? null,
                    lastAttemptAt: Date.now(),
                    lastResult: "error",
                    verifiedFiles: 0,
                    totalFiles: previousAudit?.totalFiles ?? 0,
                    sourceFingerprint: previousAudit?.sourceFingerprint,
                    message: error instanceof Error ? error.message : "The shelter verification failed.",
                };
            }
            await persistSourceCloneStatus({
                [source.id]: {
                    ...previous,
                    lastClonedAt: previous?.lastClonedAt ?? 0,
                    destinations: previous?.destinations ?? [],
                    shelterAudits: {
                        ...(previous?.shelterAudits ?? {}),
                        [destination]: audit,
                    },
                },
            });
        }
    }
    finally {
        sourceCloneOperations.delete(operationId);
    }
    return getLibraryDashboardSnapshot();
}
async function getLibraryDashboardSnapshot() {
    const registeredSources = await listSources();
    const sourceInputs = registeredSources.map(({ id, label, kind, rootPath, available, offlineBackup, snapshotAt, message }) => ({
        id, label, kind, rootPath, available, offlineBackup, snapshotAt, message,
    }));
    const inventory = libraryStatsManager?.getSnapshot(sourceInputs);
    const cloneStatus = await getSourceCloneStatus();
    const destinationState = await getShelterDestinationState();
    const destination = destinationState.destination;
    const destinationKey = destination ? path.resolve(destination) : null;
    const sources = (inventory?.sources ?? []).map((source) => {
        const clone = cloneStatus?.[source.id];
        const sourceIndex = semanticIndexer?.getIndexSummary([source.rootPath]);
        const audit = destinationKey ? clone?.shelterAudits?.[destinationKey] : undefined;
        const hasCloneInDestination = Boolean(destinationKey && clone?.destinations?.some((clonePath) => path.resolve(path.dirname(clonePath)) === destinationKey));
        const hasVerifiedCopy = Number(audit?.lastFullyVerifiedAt) > 0;
        let shelterState;
        if (audit && audit.lastResult !== "verified")
            shelterState = audit.lastResult === "missing" && !hasVerifiedCopy ? "unprotected" : "changed";
        else if (destination && !destinationState.available)
            shelterState = hasVerifiedCopy || hasCloneInDestination ? "offline" : "unprotected";
        else if (!hasVerifiedCopy)
            shelterState = hasCloneInDestination ? "unknown" : "unprotected";
        else if (source.status === "offline")
            shelterState = "offline";
        else if (source.status === "scanning" || source.status === "pending" || source.status === "error")
            shelterState = "checking";
        else
            shelterState = audit?.sourceFingerprint === source.fingerprint ? "verified" : "changed";
        return {
            ...source,
            hasVerifiedCopy,
            lastVerifiedAt: audit?.lastFullyVerifiedAt ?? null,
            cloneDestination: audit?.clonePath ?? null,
            shelterFreshness: (0, shelterVerification_1.getShelterFreshness)(audit?.lastFullyVerifiedAt),
            shelterBackups: Object.entries(clone?.shelterAudits ?? {})
                .map(([backupDestination, backupAudit]) => ({
                destination: backupDestination,
                clonePath: backupAudit.clonePath,
                lastVerifiedAt: backupAudit.lastFullyVerifiedAt,
                lastResult: backupAudit.lastResult,
                verifiedFiles: backupAudit.verifiedFiles,
                totalFiles: backupAudit.totalFiles,
            }))
                .sort((left, right) => left.destination.localeCompare(right.destination)),
            shelterAuditResult: audit?.lastResult ?? null,
            shelterAuditMessage: audit?.message ?? "",
            shelterVerifiedFiles: audit?.verifiedFiles ?? 0,
            shelterTotalFiles: audit?.totalFiles ?? 0,
            shelterState,
            indexedFiles: sourceIndex?.indexed ?? 0,
            indexingErrors: sourceIndex?.errors ?? 0,
        };
    });
    const verifiedSources = sources.filter((source) => source.shelterState === "verified" ||
        (source.shelterState === "offline" && source.hasVerifiedCopy && source.shelterAuditResult === "verified")).length;
    const freshnessOrder = {
        unknown: 0,
        green: 1,
        yellow: 2,
        orange: 3,
        red: 4,
        "blinking-red": 5,
    };
    const freshness = sources
        .filter((source) => source.hasVerifiedCopy)
        .map((source) => source.shelterFreshness)
        .sort((left, right) => freshnessOrder[right] - freshnessOrder[left])[0] ?? "unknown";
    const latestShelterSnapshot = destination ? await findLatestShelterSnapshot() : null;
    const eligibleRoots = [];
    for (const source of registeredSources) {
        if (source.available && source.rootPath.trim() &&
            !(await isSiloAppDataRoot(source.rootPath)))
            eligibleRoots.push(source.rootPath);
    }
    const globalIndex = semanticIndexer?.getIndexSummary(eligibleRoots);
    return {
        ...(inventory ?? {
            running: false,
            progress: { currentSourceId: null, currentSource: "", sourceIndex: 0, sourceCount: 0, scannedEntries: 0, currentSourceFiles: 0, message: "Inventory statistics are loading." },
            totals: { fileCount: 0, totalBytes: 0, unknownSizeFiles: 0, categories: {}, sourceCount: registeredSources.length, uniqueSourceCount: 0, staleSourceCount: registeredSources.length, lastInventoryAt: 0 },
            sources: [],
        }),
        sources,
        indexedFiles: globalIndex?.indexed ?? 0,
        indexingErrors: globalIndex?.errors ?? 0,
        shelter: {
            destination,
            destinationAvailable: destinationState.available,
            snapshotAvailable: Boolean(latestShelterSnapshot),
            replicas: Object.entries(cloneStatus ?? {})
                .filter(([id]) => id.startsWith("shelter-replica:"))
                .flatMap(([id, record]) => (record.destinations ?? []).map((replicaPath) => ({
                path: replicaPath,
                verifiedAt: record.lastClonedAt,
                replicaOf: id.slice("shelter-replica:".length),
            }))),
            verifiedSources,
            totalSources: sources.length,
            percentage: sources.length ? Math.round((verifiedSources / sources.length) * 100) : 0,
            freshness,
        },
    };
}
electron_1.ipcMain.handle("get-library-dashboard", () => getLibraryDashboardSnapshot());
electron_1.ipcMain.handle("verify-shelter-sources", async (_event, sourceIds) => {
    const cleanIds = Array.isArray(sourceIds)
        ? Array.from(new Set(sourceIds.filter((id) => typeof id === "string")))
        : [];
    return verifyShelterSources(cleanIds);
});
electron_1.ipcMain.handle("refresh-library-stats", async () => {
    if (!libraryStatsManager)
        throw new Error("Library inventory is not ready.");
    const sources = (await listSources()).map(({ id, label, kind, rootPath, available, offlineBackup, snapshotAt, message }) => ({
        id, label, kind, rootPath, available, offlineBackup, snapshotAt, message,
    }));
    libraryStatsManager.requestRefresh(sources);
    return getLibraryDashboardSnapshot();
});
electron_1.ipcMain.handle("select-shelter-destination", async () => {
    if (!mainWindow)
        return null;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Choose Silo's primary shelter destination",
        buttonLabel: "Use as shelter",
        properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0])
        return getShelterDestination();
    return setShelterDestination(result.filePaths[0]);
});
async function readRuntimeDiagnostics(cursorValue) {
    const maxBytes = 96 * 1024;
    const maxEntries = 250;
    const stats = await fsPromises.stat(diagnosticsPath).catch(() => null);
    if (!stats || stats.size === 0)
        return { entries: [], cursor: 0, truncated: false };
    const requestedCursor = Number.isSafeInteger(cursorValue) && Number(cursorValue) >= 0
        ? Number(cursorValue)
        : 0;
    const reset = requestedCursor > stats.size;
    const truncated = reset ||
        (requestedCursor === 0 && stats.size > maxBytes) ||
        stats.size - requestedCursor > maxBytes;
    const start = truncated ? Math.max(0, stats.size - maxBytes) : requestedCursor;
    const length = Math.min(maxBytes, stats.size - start);
    const handle = await fsPromises.open(diagnosticsPath, "r");
    let content = "";
    let bytesRead = 0;
    try {
        const buffer = Buffer.alloc(length);
        ({ bytesRead } = await handle.read(buffer, 0, length, start));
        content = buffer.subarray(0, bytesRead).toString("utf8");
    }
    finally {
        await handle.close();
    }
    let contentStart = start;
    if (truncated && contentStart > 0) {
        const firstNewline = content.indexOf("\n");
        if (firstNewline < 0)
            return { entries: [], cursor: start + bytesRead, truncated: true };
        contentStart += Buffer.byteLength(content.slice(0, firstNewline + 1), "utf8");
        content = content.slice(firstNewline + 1);
    }
    const lastNewline = content.lastIndexOf("\n");
    const completeText = lastNewline >= 0 ? content.slice(0, lastNewline) : "";
    const entries = completeText.split("\n").filter(Boolean).flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    }).slice(-maxEntries);
    const consumedBytes = lastNewline >= 0
        ? Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8")
        : 0;
    return { entries, cursor: contentStart + consumedBytes, truncated };
}
electron_1.ipcMain.handle("get-runtime-diagnostics", (_event, cursor) => readRuntimeDiagnostics(cursor));
electron_1.ipcMain.handle("get-indexing-overview", async () => {
    const registeredSources = Array.from(new Map((await listSources())
        .filter((source) => source.rootPath.trim())
        .map((source) => [source.rootPath, source])).values());
    const eligibleRoots = await getIndexableRootsFromSources(registeredSources);
    const unavailableSources = registeredSources.filter((source) => source.kind !== "local" && source.kind !== "machine" && !source.available);
    const coverage = typeof semanticIndexer.getSourceCoverageProgress === "function"
        ? semanticIndexer.getSourceCoverageProgress(eligibleRoots)
        : {
            total: eligibleRoots.length,
            completed: 0,
            scanning: 0,
            errors: 0,
            unavailable: 0,
            pending: eligibleRoots.length,
        };
    const search = semanticIndexer.isLoaded?.() === false
        ? { ...semanticIndexer.getProgress(), status: "loading-model", message: "Opening the saved search index…" }
        : semanticIndexer.getProgress();
    const globalSearch = semanticIndexer.getIndexSummary();
    const retryableSearchErrors = semanticIndexer.getRetryableErrorCount(eligibleRoots);
    const discovery = semanticIndexer.getReconciliationProgress();
    const currentSource = registeredSources.find((source) => source.rootPath === discovery.sourcePath);
    const batchRoot = currentSource?.label ||
        discovery.sourcePath ||
        discovery.source ||
        "Source";
    const discoveryMessage = discovery.running
        ? `Reading ${batchRoot} · batch source ${discovery.sourceIndex} of ${discovery.sourceCount}`
        : coverage.errors
            ? `${coverage.errors} source discovery errors; retry required`
            : coverage.unavailable
                ? `${coverage.unavailable} eligible sources unavailable`
                : coverage.pending
                    ? `${coverage.pending} sources awaiting discovery`
                    : unavailableSources.length
                        ? `${unavailableSources.length} registered sources need connection / authorization`
                        : discovery.error ||
                            discovery.message ||
                            "Preparing source discovery";
    const face = faceIndexer.getProgress();
    const geo = geoIndexer.getStatus();
    const duplicates = duplicateManager.getState();
    const pets = petIndexer.getProgress();
    const thumbnails = thumbnailPregenerator?.getProgress();
    const audio = audioLibraryCache?.getSnapshot();
    const coveredAudioSources = audio?.sourceIds.filter((id) => Boolean(audio.sourceScannedAt?.[id]) &&
        !audio.failedSources?.includes(id)).length ?? 0;
    return [
        {
            id: "discovery",
            label: "Source discovery",
            status: discovery.running || coverage.scanning
                ? "scanning"
                : coverage.errors
                    ? "error"
                    : coverage.pending ||
                        coverage.unavailable ||
                        unavailableSources.length ||
                        !coverage.total
                        ? "waiting"
                        : "complete",
            processed: coverage.completed,
            total: coverage.total,
            unit: "sources",
            errors: coverage.errors,
            message: discoveryMessage,
            detail: `${registeredSources.length} registered roots · ${eligibleRoots.length} eligible · ${coverage.completed} index scans complete · ${coverage.scanning} index scans active · ${coverage.pending} awaiting discovery · ${coverage.errors} discovery errors · ${coverage.unavailable} unavailable · ${discovery.running ? "1 source discovery job active" : "0 source discovery jobs active"}${unavailableSources.length ? ` · ${unavailableSources.length} disconnected / unauthorized sources excluded from eligible total` : ""}. Current / last discovery batch: source ${discovery.sourceIndex} of ${discovery.sourceCount} · ${batchRoot} · ${discovery.scanned.toLocaleString()} entries inspected · ${discovery.changed.toLocaleString()} new / changed files${discovery.running ? ` · ${Math.floor((Date.now() - discovery.startedAt) / 1000)}s elapsed` : ""}`,
        },
        {
            id: "search",
            label: "Search index",
            status: search.status,
            processed: globalSearch.indexed,
            total: globalSearch.total,
            unit: "files",
            errors: globalSearch.errors,
            retryable: retryableSearchErrors,
            message: search.message,
            detail: `${globalSearch.indexed.toLocaleString()} indexed · ${globalSearch.remaining.toLocaleString()} awaiting embeddings · ${globalSearch.errors.toLocaleString()} failed records · ${retryableSearchErrors.toLocaleString()} retryable failures with persistent retry state · recursive totals across saved and current source indexes`,
        },
        {
            id: "faces",
            label: "People / faces",
            status: face.status,
            processed: face.processed,
            total: face.total,
            unit: "photos",
            errors: face.errors,
            message: face.message,
            detail: `${face.faces.toLocaleString()} faces · ${face.people.toLocaleString()} people`,
        },
        {
            id: "locations",
            label: "Locations",
            status: geo.status,
            processed: geo.scanned,
            total: geo.total,
            unit: "files",
            message: geo.message,
            detail: `${geo.geotagged.toLocaleString()} mapped photos`,
        },
        {
            id: "duplicates",
            label: "Duplicate hashes",
            status: duplicates.status,
            processed: duplicates.scanned,
            total: duplicates.total,
            unit: "candidates",
            message: duplicates.message,
            detail: `${duplicates.duplicateFiles.toLocaleString()} duplicate copies`,
        },
        {
            id: "pets",
            label: "Pets",
            status: pets.status,
            processed: pets.processed,
            total: pets.total,
            unit: "photos",
            errors: pets.errors,
            message: pets.message,
        },
        {
            id: "audio",
            label: "Audio inventory",
            status: audioInventoryRunning
                ? "scanning"
                : audio?.failedSources?.length
                    ? "waiting"
                    : audio?.sourceIds.length &&
                        coveredAudioSources === audio.sourceIds.length
                        ? "complete"
                        : "idle",
            processed: coveredAudioSources,
            total: audio?.sourceIds.length ?? 0,
            unit: "sources",
            errors: audio?.failedSources?.length ?? 0,
            message: audioInventoryRunning
                ? `Scanning source ${audioInventoryProgress?.sourceIndex ?? 0} of ${audioInventoryProgress?.sourceCount ?? 0}`
                : audio?.failedSources?.length
                    ? "Retry pending or authorization required"
                    : "Recursive source inventory",
            detail: `${(audio?.files.length ?? 0).toLocaleString()} audio files`,
        },
        {
            id: "quality",
            label: "Photo quality",
            status: magicLibraryProgress.running
                ? "indexing"
                : magicLibraryProgress.total > 0 &&
                    magicLibraryProgress.analyzed >= magicLibraryProgress.total
                    ? "complete"
                    : "idle",
            processed: magicLibraryProgress.analyzed,
            total: magicLibraryProgress.total,
            unit: "photos",
            message: "Local photographic quality analysis",
        },
        {
            id: "thumbnails",
            label: "Thumbnails",
            status: thumbnails?.status ?? "idle",
            processed: thumbnails?.processed ?? 0,
            total: thumbnails?.total ?? 0,
            unit: "files",
            errors: thumbnails?.failed ?? 0,
            message: thumbnails?.message ?? "Waiting to start",
        },
    ].map((stage) => ({
        ...stage,
        canRetry: stage.id !== "discovery",
        ...(indexRecovery?.details(stage.id) ?? {}),
    }));
});
electron_1.ipcMain.handle("get-startup-state", () => startupState);
function getVisibleDemoMapPhotos(photos, sourcePaths) {
    const visiblePhotos = filterForContentSafety(filterForEnabledSources(photos, new Set(sourcePaths)));
    const uniquePhotos = Array.from(new Map(visiblePhotos.map((photo) => [photo.path, photo])).values());
    return (0, demoLimits_1.selectDemoMapPhotos)(uniquePhotos, fullAccessEnabled(), demoLimits_1.DEMO_LIMITS.mapPhotos, demoLimits_1.DEMO_LIMITS.mapDestinations);
}
function getVisibleGeoState(state, sourcePaths) {
    const photos = getVisibleDemoMapPhotos(state.photos, sourcePaths);
    return { ...state, geotagged: photos.length, photos };
}
function requireDemoMapRelocation(files, location, sourcePaths) {
    if (fullAccessEnabled())
        return;
    const currentPhotos = getVisibleDemoMapPhotos(geoIndexer.getState().photos, sourcePaths);
    const availablePaths = new Set(currentPhotos.map((photo) => photo.path));
    const selectedPaths = new Set(files
        .filter((file) => (file.type === "image" || file.type === "video") &&
        !file.isDirectory)
        .map((file) => file.path));
    if (Array.from(selectedPaths).some((filePath) => !availablePaths.has(filePath))) {
        notifyDemoLimitReached("mapPhotos");
        throw new Error(`The demo maps up to ${demoLimits_1.DEMO_LIMITS.mapPhotos.toLocaleString()} photos. Unlock Silo to map more.`);
    }
    const destinations = new Set(currentPhotos
        .filter((photo) => !selectedPaths.has(photo.path))
        .map(demoLimits_1.getDemoDestinationKey));
    if (selectedPaths.size > 0) {
        destinations.add((0, demoLimits_1.getDemoDestinationKey)({
            path: "demo-destination",
            locationLabel: location.label,
            city: location.city,
            region: location.region,
            country: location.country,
            latitude: location.latitude,
            longitude: location.longitude,
        }));
    }
    if (destinations.size > demoLimits_1.DEMO_LIMITS.mapDestinations) {
        notifyDemoLimitReached("mapDestinations");
        throw new Error(`The demo maps up to ${demoLimits_1.DEMO_LIMITS.mapDestinations} destinations. Unlock Silo to map another.`);
    }
}
electron_1.ipcMain.handle("get-geo-state", async () => {
    const sources = await getEnabledIndexSources();
    if (!geoCheckedThisSession) {
        geoCheckedThisSession = true;
        void kickGeoCheck();
    }
    const state = geoIndexer.getState();
    return getVisibleGeoState(state, sources);
});
electron_1.ipcMain.handle("refresh-geo-state", async () => {
    await kickGeoCheck();
    const sources = new Set(await getEnabledIndexSources());
    const state = geoIndexer.getState();
    return getVisibleGeoState(state, Array.from(sources));
});
electron_1.ipcMain.handle("get-country-summary", async () => {
    const sources = new Set(await getEnabledIndexSources());
    const photos = getVisibleDemoMapPhotos(geoIndexer.getState().photos, Array.from(sources));
    const countries = new Map();
    for (const photo of photos) {
        const country = photo.country || "Unknown";
        countries.set(country, (countries.get(country) ?? 0) + 1);
    }
    return Array.from(countries, ([country, photoCount]) => ({
        country,
        countryCode: null,
        photoCount,
    })).sort((first, second) => second.photoCount - first.photoCount);
});
electron_1.ipcMain.handle("get-state-summary", async (_event, country) => {
    const sources = new Set(await getEnabledIndexSources());
    const photos = getVisibleDemoMapPhotos(geoIndexer.getState().photos, Array.from(sources));
    const states = new Map();
    for (const photo of photos) {
        if (photo.country !== country)
            continue;
        const state = photo.region || "Unknown";
        states.set(state, (states.get(state) ?? 0) + 1);
    }
    return Array.from(states, ([state, photoCount]) => ({
        state,
        photoCount,
    })).sort((first, second) => second.photoCount - first.photoCount);
});
electron_1.ipcMain.handle("get-photos-by-region", async (_event, country, state) => {
    const sources = await getEnabledIndexSources();
    const photos = geoIndexer.getPhotosByRegion(country, state);
    return getVisibleDemoMapPhotos(photos, sources);
});
electron_1.ipcMain.handle("reverse-geocode", (_event, latitude, longitude) => geocoder.reverse(latitude, longitude));
electron_1.ipcMain.handle("search-locations", (_event, query) => geocoder.search(query));
electron_1.ipcMain.handle("set-geo-location", async (_event, files, location) => {
    const sources = await getEnabledIndexSources();
    requireDemoMapRelocation(files, location, sources);
    const snapshots = files
        .filter((file) => (file.type === "image" || file.type === "video") && !file.isDirectory)
        .map((file) => ({
        name: file.name,
        path: file.path,
        relativePath: file.relativePath,
        size: file.size,
        modified: file.modified,
        isDirectory: false,
        type: file.type,
        extension: file.extension,
        sourcePath: sources
            .filter((sourcePath) => file.path === sourcePath ||
            file.path.startsWith(`${sourcePath}${path.sep}`))
            .sort((first, second) => second.length - first.length)[0] ??
            path.dirname(file.path),
    }));
    const appState = await stateStore.setGeoOverrides(snapshots, location);
    geoIndexer.setOverrides(appState.geoOverrides);
    sendToRenderer("photo-indicators-changed", null);
    const geoState = geoIndexer.getState();
    return {
        appState,
        geoState: getVisibleGeoState(geoState, sources),
    };
});
electron_1.ipcMain.handle("clear-geo-location", async (_event, filePaths) => {
    const appState = await stateStore.clearGeoOverrides(filePaths);
    geoIndexer.setOverrides(appState.geoOverrides);
    sendToRenderer("photo-indicators-changed", null);
    const sources = await getEnabledIndexSources();
    const geoState = geoIndexer.getState();
    return {
        appState,
        geoState: getVisibleGeoState(geoState, sources),
    };
});
electron_1.ipcMain.handle("start-face-indexing", async () => {
    await retryIndexRecoveryStage("faces");
    return faceIndexer.getProgress();
});
electron_1.ipcMain.handle("pause-face-indexing", async () => {
    indexRecovery?.pause("faces");
    await faceIndexer.pause();
    return faceIndexer.getProgress();
});
electron_1.ipcMain.handle("get-person", async (_event, personId) => {
    if (!canAccessDemoPerson(personId))
        return null;
    const detail = faceIndexer.getPerson(personId);
    if (!detail)
        return null;
    const sources = new Set(await getEnabledIndexSources());
    const photoPaths = detail.photoPaths.filter((photoPath) => fileIsInEnabledSource(photoPath, sources));
    const visible = new Set(photoPaths);
    const confirmedPhotoPaths = detail.confirmedPhotoPaths.filter((photoPath) => visible.has(photoPath));
    const suggestedPhotoPaths = detail.suggestedPhotoPaths.filter((photoPath) => fileIsInEnabledSource(photoPath, sources));
    const faces = detail.faces.filter((face) => visible.has(face.imagePath));
    const reviewableCount = Math.min(detail.reviewableCount, photoPaths.length);
    return {
        ...detail,
        photoPaths,
        confirmedPhotoPaths,
        suggestedPhotoPaths,
        faces,
        photoCount: photoPaths.length,
        faceCount: faces.length,
        confirmedCount: confirmedPhotoPaths.length,
        reviewableCount,
        hiddenCount: Math.max(0, photoPaths.length - reviewableCount),
        fullyConfirmed: photoPaths.length > 0 && confirmedPhotoPaths.length >= reviewableCount,
    };
});
/** Paths that are truly gone: their volume is mounted but the file is not there. */
async function confirmedMissingPaths(filePaths) {
    const mounted = new Map();
    const missing = [];
    for (const filePath of filePaths) {
        if (isRemotePath(filePath) || !path.isAbsolute(filePath))
            continue;
        const volume = /^\/Volumes\/[^/]+/.exec(filePath)?.[0];
        if (volume) {
            if (!mounted.has(volume))
                mounted.set(volume, await fsPromises.access(volume).then(() => true, () => false));
            if (!mounted.get(volume))
                continue;
        }
        if (!(await fsPromises.access(filePath).then(() => true, () => false)))
            missing.push(filePath);
    }
    return missing;
}
electron_1.ipcMain.handle("get-person-photo-files", async (_event, personId) => {
    if (!canAccessDemoPerson(personId))
        return [];
    const person = faceIndexer.getPerson(personId);
    if (!person)
        return [];
    const files = await readReferencedFiles(person.photoPaths);
    const sources = new Set(await getEnabledIndexSources());
    const activeFiles = filterForEnabledSources(files, sources);
    const found = new Set(files.map((file) => file.path));
    const unreadable = person.photoPaths.filter((photoPath) => !found.has(photoPath));
    if (unreadable.length > 0)
        await faceIndexer.markMissingPhotos(await confirmedMissingPaths(unreadable));
    // A banned person's own page is the only place their photos can be viewed.
    return person.status === "banned"
        ? filterForNsfw(activeFiles)
        : filterForContentSafety(activeFiles);
});
electron_1.ipcMain.handle("get-person-suggestion-files", async (_event, personId) => {
    if (!canAccessDemoPerson(personId))
        return [];
    const person = faceIndexer.getPerson(personId);
    if (!person)
        return [];
    const files = await readReferencedFiles(person.suggestedPhotoPaths);
    const sources = new Set(await getEnabledIndexSources());
    const activeFiles = filterForEnabledSources(files, sources);
    return person.status === "banned"
        ? filterForNsfw(activeFiles)
        : filterForContentSafety(activeFiles);
});
electron_1.ipcMain.handle("add-photos-to-person", (_event, imagePaths, target) => {
    requireDemoPersonTarget(target);
    const paths = Array.isArray(imagePaths)
        ? imagePaths.filter((item) => typeof item === "string" && path.isAbsolute(item))
        : [];
    if (paths.length === 0)
        throw new Error("Select at least one photo.");
    return faceIndexer.recordEdit(`Add ${paths.length} photo${paths.length === 1 ? "" : "s"} to person`, () => faceIndexer.addPhotosToPerson({
        personId: typeof target?.personId === "string"
            ? target.personId
            : undefined,
        newName: typeof target?.newName === "string" ? target.newName : undefined,
    }, paths));
});
electron_1.ipcMain.handle("move-person-photos", (_event, sourceId, imagePaths, target) => {
    requireDemoPersonAccess(sourceId);
    requireDemoPersonTarget(target);
    const paths = Array.isArray(imagePaths)
        ? imagePaths.filter((item) => typeof item === "string")
        : [];
    const cleanTarget = target
        ? {
            personId: typeof target.personId === "string" ? target.personId : undefined,
            newName: typeof target.newName === "string" ? target.newName : undefined,
        }
        : null;
    const count = `${paths.length} photo${paths.length === 1 ? "" : "s"}`;
    return faceIndexer.recordEdit(cleanTarget ? `Move ${count}` : `Remove ${count}`, () => faceIndexer.movePhotos(sourceId, paths, cleanTarget));
});
electron_1.ipcMain.handle("confirm-all-person-photos", (_event, personId) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Confirm all photos", () => faceIndexer.confirmAllPhotos(personId));
});
electron_1.ipcMain.handle("confirm-person-photos", (_event, personId, imagePaths) => {
    requireDemoPersonAccess(personId);
    const paths = Array.isArray(imagePaths)
        ? imagePaths.filter((item) => typeof item === "string")
        : [];
    return faceIndexer.recordEdit(`Confirm ${paths.length} photos`, () => faceIndexer.confirmPhotos(personId, paths));
});
electron_1.ipcMain.handle("train-person", async (_event, personId) => {
    requireDemoPersonAccess(personId);
    const detail = await faceIndexer.recordEdit("Train person", () => faceIndexer.trainPerson(personId));
    // Also pick up photos added to any source since the last face pass; suggestions refresh when it finishes.
    await retryIndexRecoveryStage("faces");
    return detail;
});
electron_1.ipcMain.handle("ban-person", (_event, personId) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Ban person", () => faceIndexer.banPerson(personId));
});
electron_1.ipcMain.handle("unban-person", (_event, personId) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Unban person", () => faceIndexer.unbanPerson(personId));
});
electron_1.ipcMain.handle("accept-person-suggestions", (_event, personId, imagePaths) => {
    requireDemoPersonAccess(personId);
    const paths = Array.isArray(imagePaths)
        ? imagePaths.filter((item) => typeof item === "string")
        : [];
    return faceIndexer.recordEdit(`Accept ${paths.length} suggestions`, () => faceIndexer.acceptSuggestions(personId, paths));
});
electron_1.ipcMain.handle("reject-person-suggestions", (_event, personId, imagePaths) => {
    requireDemoPersonAccess(personId);
    const paths = Array.isArray(imagePaths)
        ? imagePaths.filter((item) => typeof item === "string")
        : [];
    return faceIndexer.recordEdit(`Dismiss ${paths.length} suggestions`, () => faceIndexer.rejectSuggestions(personId, paths));
});
electron_1.ipcMain.handle("create-person", (_event, name) => {
    requireDemoPersonSlot();
    return faceIndexer.recordEdit("Create person", () => faceIndexer.createPerson(name));
});
electron_1.ipcMain.handle("rename-person", (_event, personId, name) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Rename person", () => faceIndexer.renamePerson(personId, name));
});
electron_1.ipcMain.handle("delete-person", (_event, personId) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Delete person", () => faceIndexer.deletePerson(personId));
});
electron_1.ipcMain.handle("assign-face-to-person", (_event, personId, faceId) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Add face", () => faceIndexer.assignFace(personId, faceId));
});
electron_1.ipcMain.handle("add-photo-to-person", (_event, personId, imagePath) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Add photo", () => faceIndexer.addPhoto(personId, imagePath));
});
electron_1.ipcMain.handle("confirm-person-photo", (_event, personId, imagePath) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Confirm photo", () => faceIndexer.confirmPhoto(personId, imagePath));
});
electron_1.ipcMain.handle("remove-person-photo", (_event, personId, imagePath) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Remove photo", () => faceIndexer.removePhoto(personId, imagePath));
});
electron_1.ipcMain.handle("set-person-cover-photo", (_event, personId, photoPath) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Change profile picture", () => faceIndexer.setSelectedCoverPhoto(personId, photoPath));
});
electron_1.ipcMain.handle("get-image-faces", (_event, imagePath) => faceIndexer.getFacesForImage(imagePath));
electron_1.ipcMain.handle("update-face-box", async (_event, faceId, imagePath, box) => faceIndexer.recordEdit("Move face box", async () => faceIndexer.updateFaceBox(faceId, box, await resolveLocalPath(imagePath))));
electron_1.ipcMain.handle("create-face-box", async (_event, imagePath, box) => faceIndexer.recordEdit("Create face box", async () => faceIndexer.createFaceBox(imagePath, await resolveLocalPath(imagePath), box)));
electron_1.ipcMain.handle("delete-face", (_event, faceId) => faceIndexer.recordEdit("Delete detected face", () => faceIndexer.deleteFace(faceId)));
electron_1.ipcMain.handle("get-photo-indicators", async (_event, filePaths) => {
    if (Array.isArray(filePaths) && filePaths.length > 1000)
        throw new Error("Photo metadata requests must be paged (maximum 1000 files).");
    const paths = Array.isArray(filePaths)
        ? filePaths.filter((item) => typeof item === "string")
        : [];
    const personNames = faceIndexer.getPeopleForImages(paths);
    const visibleNames = new Set(getDemoPeople().map((person) => person.name));
    const result = Object.fromEntries(paths.map((filePath) => [
        filePath,
        {
            hasLocation: geoIndexer.hasLocation(filePath),
            locationLabel: geoIndexer.locationLabel(filePath),
            people: (personNames[filePath] ?? []).filter((name) => visibleNames.has(name)),
        },
    ]));
    return result;
});
electron_1.ipcMain.handle("merge-person", (_event, sourcePersonId, targetPersonId) => {
    requireDemoPersonAccess(sourcePersonId);
    requireDemoPersonAccess(targetPersonId);
    return faceIndexer.recordEdit("Merge people", async () => (await faceIndexer.mergePeople(sourcePersonId, targetPersonId)).detail);
});
electron_1.ipcMain.handle("get-people-edit-history", () => faceIndexer.getEditHistory());
electron_1.ipcMain.handle("undo-people-edit", async () => ({
    label: await faceIndexer.undo(),
    ...faceIndexer.getEditHistory(),
}));
electron_1.ipcMain.handle("redo-people-edit", async () => ({
    label: await faceIndexer.redo(),
    ...faceIndexer.getEditHistory(),
}));
electron_1.ipcMain.handle("get-banned-faces", async () => {
    const visibleIds = new Set(getDemoPeople().map((person) => person.id));
    return (await faceIndexer.getBannedFaces()).filter((person) => visibleIds.has(person.personId));
});
electron_1.ipcMain.handle("add-banned-face", (_event, personId, reason, confidence) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.addBannedFace(personId, reason, confidence);
});
electron_1.ipcMain.handle("remove-banned-face", (_event, personId) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.removeBannedFace(personId);
});
electron_1.ipcMain.handle("set-banned-face-confidence", (_event, personId, confidence) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.setBannedFaceConfidence(personId, confidence);
});
electron_1.ipcMain.handle("get-pet-state", async () => {
    const sources = new Set(await getEnabledIndexSources());
    const clusters = await Promise.all(petIndexer.getClusters().map(async (cluster) => {
        const paths = petIndexer
            .getClusterPhotos(cluster.id)
            .filter((photoPath) => fileIsInEnabledSource(photoPath, sources));
        return paths.length > 0 ? { ...cluster, photoCount: paths.length } : null;
    }));
    return {
        progress: petIndexer.getProgress(),
        clusters: clusters.filter((cluster) => cluster !== null),
    };
});
electron_1.ipcMain.handle("start-pet-clustering", async () => {
    await retryIndexRecoveryStage("pets");
    return petIndexer.getProgress();
});
electron_1.ipcMain.handle("pause-pet-clustering", async () => {
    indexRecovery?.pause("pets");
    petIndexer.pause();
    return petIndexer.getProgress();
});
electron_1.ipcMain.handle("rename-pet-cluster", async (_event, clusterId, name) => {
    await petIndexer.renamePetGroup(clusterId, name);
    // Update name index with pet cluster photos
    const photos = petIndexer.getClusterPhotos(clusterId);
    if (photos.length > 0) {
        await stateStore.updateNameIndex(name, photos, "pet", clusterId);
    }
    return petIndexer.getClusters();
});
electron_1.ipcMain.handle("update-name-index", async (_event, name, filePaths, sourceType, sourceId) => {
    return stateStore.updateNameIndex(name, filePaths, sourceType, sourceId);
});
electron_1.ipcMain.handle("confirm-name-file", async (_event, name, filePath) => {
    return stateStore.confirmNameFile(name, filePath);
});
electron_1.ipcMain.handle("reject-name-file", async (_event, name, filePath) => {
    return stateStore.rejectNameFile(name, filePath);
});
// Handle isDev check for client
electron_1.ipcMain.handle("get-lifetime-license", () => readLifetimeLicense());
electron_1.ipcMain.handle("is-demo-mode", () => !fullAccessEnabled());
electron_1.ipcMain.handle("get-bug-report-status", () => {
    const configuredEndpoint = process.env.SILO_BUG_REPORT_ENDPOINT?.trim() || defaultBugReportEndpoint;
    try {
        const endpoint = new URL(configuredEndpoint);
        if (endpoint.protocol !== "https:")
            throw new Error("HTTPS is required for the report relay.");
        return { available: true, message: "Reports are sent securely by email." };
    }
    catch {
        return {
            available: false,
            message: "The report relay needs a valid HTTPS endpoint.",
        };
    }
});
electron_1.ipcMain.handle("capture-bug-report-screenshot", async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents)
        throw new Error("The Silo window is not available for capture.");
    const screenshot = await event.sender.capturePage();
    const size = screenshot.getSize();
    const resized = size.width > 1600
        ? screenshot.resize({ width: 1600 })
        : screenshot;
    return `data:image/jpeg;base64,${resized.toJPEG(72).toString("base64")}`;
});
electron_1.ipcMain.handle("submit-bug-report", async (event, input) => {
    if (!mainWindow || event.sender !== mainWindow.webContents)
        throw new Error("The Silo window is not available to send a report.");
    const configuredEndpoint = process.env.SILO_BUG_REPORT_ENDPOINT?.trim() || defaultBugReportEndpoint;
    let endpoint;
    try {
        endpoint = new URL(configuredEndpoint);
    }
    catch {
        return { ok: false, error: "The report relay endpoint is invalid." };
    }
    if (endpoint.protocol !== "https:")
        return { ok: false, error: "The report relay must use HTTPS." };
    if (!input || typeof input !== "object")
        return { ok: false, error: "Enter a short description before sending." };
    const report = input;
    const message = typeof report.message === "string" ? report.message.trim() : "";
    if (!message || message.length > 5000)
        return {
            ok: false,
            error: "Write a report between 1 and 5,000 characters.",
        };
    const feature = typeof report.feature === "string" ? report.feature.trim() : "";
    if (feature.length > 180)
        return { ok: false, error: "The selected feature label is too long." };
    let screenshotBase64 = null;
    if (report.screenshotDataUrl !== undefined && report.screenshotDataUrl !== null) {
        if (typeof report.screenshotDataUrl !== "string" ||
            report.screenshotDataUrl.length > maxBugReportScreenshotBytes * 1.4)
            return { ok: false, error: "The screenshot exceeds the attachment limit." };
        const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(report.screenshotDataUrl);
        if (!match || Buffer.from(match[1], "base64").length > maxBugReportScreenshotBytes)
            return { ok: false, error: "The screenshot attachment is invalid or too large." };
        screenshotBase64 = match[1];
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15000);
    try {
        const response = await electron_1.net.fetch(endpoint.href, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message,
                feature: feature || null,
                screenshotBase64,
                appVersion: electron_1.app.getVersion(),
                platform: process.platform,
                createdAt: new Date().toISOString(),
            }),
            signal: abortController.signal,
        });
        if (!response.ok)
            return {
                ok: false,
                error: `The report relay returned HTTP ${response.status}.`,
            };
        return { ok: true };
    }
    catch {
        return {
            ok: false,
            error: "Silo could not reach the report relay. Your report is still here.",
        };
    }
    finally {
        clearTimeout(timeout);
    }
});
electron_1.ipcMain.handle("get-demo-testing-mode", () => ({
    available: lifetimeLicensed,
    enabled: lifetimeLicensed && demoTestingModeEnabled,
}));
electron_1.ipcMain.handle("set-demo-testing-mode", async (_event, enabledValue) => {
    if (typeof enabledValue !== "boolean")
        throw new Error("Demo testing mode must be enabled or disabled explicitly.");
    if (!lifetimeLicensed)
        throw new Error("A saved lifetime license is required for demo testing mode.");
    if (enabledValue === demoTestingModeEnabled)
        return {
            available: true,
            enabled: demoTestingModeEnabled,
            restarting: false,
        };
    const enabling = enabledValue;
    const options = {
        type: "warning",
        buttons: ["Restart Silo", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        title: enabling ? "Restart in demo testing mode?" : "Return to full access?",
        message: enabling
            ? "Restart Silo with demo limits active?"
            : "Restart Silo with your full lifetime access?",
        detail: enabling
            ? "Your lifetime license remains saved. The 1,000-file demo cap and other demo limits will apply after restart; source media is not changed."
            : "Your lifetime license and demo usage history remain saved. Full access resumes after restart.",
    };
    const confirmation = mainWindow
        ? await electron_1.dialog.showMessageBox(mainWindow, options)
        : await electron_1.dialog.showMessageBox(options);
    if (confirmation.response !== 0)
        return {
            available: true,
            enabled: demoTestingModeEnabled,
            restarting: false,
        };
    if (!enabling)
        queueIndexRecoveryStages(ALL_INDEX_RECOVERY_STAGES);
    await writeDemoTestingMode(enabling);
    electron_1.app.relaunch();
    electron_1.app.quit();
    return { available: true, enabled: enabling, restarting: true };
});
electron_1.ipcMain.handle("get-beta-activation-info", async () => ({
    requestCode: (0, betaLicense_1.createBetaRequestCode)(await getBetaInstallationId()),
    requestEmail: betaLicense_1.BETA_ACTIVATION_REQUEST_EMAIL,
    available: Boolean(betaLicensePublicKey_1.BETA_LICENSE_PUBLIC_KEY.trim()),
}));
electron_1.ipcMain.handle("submit-beta-activation-request", async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents)
        return {
            ok: false,
            error: "The Silo window is not available to send the request.",
        };
    const configuredEndpoint = process.env.SILO_BETA_REQUEST_ENDPOINT?.trim() || defaultBetaRequestEndpoint;
    let endpoint;
    try {
        endpoint = new URL(configuredEndpoint);
    }
    catch {
        return { ok: false, error: "The beta request relay endpoint is invalid." };
    }
    if (endpoint.protocol !== "https:")
        return { ok: false, error: "The beta request relay must use HTTPS." };
    const payload = (0, betaLicense_1.createBetaActivationRequestPayload)(await getBetaInstallationId(), electron_1.app.getVersion(), process.platform);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15000);
    try {
        const response = await electron_1.net.fetch(endpoint.href, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: abortController.signal,
        });
        if (!response.ok)
            return {
                ok: false,
                error: `The beta request relay returned HTTP ${response.status}.`,
            };
        return { ok: true };
    }
    catch {
        return {
            ok: false,
            error: "Silo could not reach the beta request relay. Try again when online.",
        };
    }
    finally {
        clearTimeout(timeout);
    }
});
electron_1.ipcMain.handle("activate-beta-license", async (_event, activationCodeValue) => {
    if (typeof activationCodeValue !== "string")
        return {
            status: "invalid",
            message: "Paste the beta activation code you received from Silo's developer.",
        };
    if (!betaLicensePublicKey_1.BETA_LICENSE_PUBLIC_KEY.trim())
        return {
            status: "unavailable",
            message: "Beta activation is not configured in this Silo build.",
        };
    const currentLicense = await readLifetimeLicense();
    if (currentLicense.isLicensed)
        return {
            status: "already-licensed",
            message: "Silo already has full lifetime access on this installation.",
            license: currentLicense,
        };
    const installationId = await getBetaInstallationId();
    const activationCode = activationCodeValue.trim();
    const payload = (0, betaLicense_1.verifyBetaActivationCode)(activationCode, betaLicensePublicKey_1.BETA_LICENSE_PUBLIC_KEY, installationId);
    if (!payload)
        return {
            status: "invalid",
            message: "That code is invalid or belongs to a different Silo installation. Check that you copied the full code.",
        };
    try {
        await writeBetaLicense(activationCode);
        enableLifetimeFeatures();
        return {
            status: "activated",
            message: "Your lifetime beta license is active on this installation.",
            license: {
                isLicensed: true,
                licenseType: "beta",
                verifiedAt: payload.issuedAt,
            },
        };
    }
    catch {
        return {
            status: "error",
            message: "Silo could not save the beta license on this device.",
        };
    }
});
electron_1.ipcMain.handle("verify-lifetime-payment", async (_event, signatureValue) => {
    if (typeof signatureValue !== "string")
        return {
            status: "invalid",
            message: "Paste the transaction signature shown by your Solana wallet.",
        };
    if (!(0, lifetimePayment_1.isSolanaTransactionSignature)(signatureValue))
        return (0, lifetimePayment_1.verifyParsedLifetimePayment)(signatureValue, {});
    const existingLicense = await readLifetimeLicense();
    if (existingLicense.isLicensed)
        return {
            status: "already-licensed",
            message: "Silo already has a lifetime license saved on this Mac.",
            license: existingLicense,
        };
    try {
        const rpcResponse = await requestLifetimeRpc("getTransaction", [
            signatureValue,
            {
                commitment: "finalized",
                encoding: "jsonParsed",
                maxSupportedTransactionVersion: 1,
            },
        ]);
        if (!rpcResponse.ok)
            return {
                status: "error",
                message: "Helius could not be reached or is rate-limiting requests. Please try again shortly.",
            };
        const verification = (0, lifetimePayment_1.verifyParsedLifetimePayment)(signatureValue, rpcResponse.result);
        if (verification.status !== "verified")
            return verification;
        const verifiedAt = Date.now();
        await writeLifetimeLicense(signatureValue, verifiedAt);
        enableLifetimeFeatures();
        return {
            ...verification,
            license: {
                isLicensed: true,
                licenseType: "purchase",
                signature: signatureValue,
                verifiedAt,
            },
        };
    }
    catch {
        return {
            status: "error",
            message: "Could not verify with Solana right now. Check your connection and try again; no license status was changed.",
        };
    }
});
electron_1.ipcMain.handle("check-lifetime-payment-reference", async (_event, referenceValue) => {
    if (typeof referenceValue !== "string" ||
        !(0, lifetimePayment_1.isSolanaPayReference)(referenceValue))
        return {
            status: "invalid",
            message: "This Solana Pay request is invalid. Create a new payment request.",
        };
    const existingLicense = await readLifetimeLicense();
    if (existingLicense.isLicensed)
        return {
            status: "already-licensed",
            message: "Silo already has a lifetime license saved on this Mac.",
            license: existingLicense,
        };
    try {
        const signaturesResponse = await requestLifetimeRpc("getSignaturesForAddress", [referenceValue, { commitment: "finalized", limit: 5 }]);
        if (!signaturesResponse.ok)
            return {
                status: "error",
                message: "Helius could not be reached or is rate-limiting requests. Silo will keep checking.",
            };
        const rpcBody = signaturesResponse.result;
        if (typeof rpcBody !== "object" || rpcBody === null)
            return {
                status: "error",
                message: "Solana returned an unreadable payment status.",
            };
        if ("error" in rpcBody && rpcBody.error)
            return {
                status: "error",
                message: "Solana could not check this payment request. Silo will retry.",
            };
        const signatureItems = "result" in rpcBody ? rpcBody.result : undefined;
        if (!Array.isArray(signatureItems))
            return {
                status: "error",
                message: "Solana returned an incomplete payment status.",
            };
        for (const item of signatureItems) {
            if (typeof item !== "object" || item === null || !("signature" in item))
                continue;
            const signatureValue = item.signature;
            if (typeof signatureValue !== "string" ||
                !(0, lifetimePayment_1.isSolanaTransactionSignature)(signatureValue))
                continue;
            const transactionResponse = await requestLifetimeRpc("getTransaction", [
                signatureValue,
                {
                    commitment: "finalized",
                    encoding: "jsonParsed",
                    maxSupportedTransactionVersion: 1,
                },
            ]);
            if (!transactionResponse.ok)
                return {
                    status: "error",
                    message: "Helius could not finish verifying this payment. Silo will keep checking.",
                };
            const verification = (0, lifetimePayment_1.verifyParsedLifetimePayment)(signatureValue, transactionResponse.result);
            if (verification.status !== "verified")
                continue;
            const verifiedAt = Date.now();
            await writeLifetimeLicense(signatureValue, verifiedAt);
            enableLifetimeFeatures();
            return {
                ...verification,
                license: {
                    isLicensed: true,
                    licenseType: "purchase",
                    signature: signatureValue,
                    verifiedAt,
                },
            };
        }
        return {
            status: "pending",
            message: "Waiting for a finalized $25 USDC payment from this request. Keep this window open; Silo will activate it automatically.",
        };
    }
    catch {
        return {
            status: "error",
            message: "Could not check Solana right now. Silo will keep checking; no license status was changed.",
        };
    }
});
electron_1.ipcMain.handle("is-dev", () => electron_is_dev_1.default);
electron_1.ipcMain.handle("get-app-update-state", () => appUpdateState);
electron_1.ipcMain.handle("check-app-updates", () => checkForAppUpdates());
electron_1.ipcMain.handle("download-and-install-app-update", () => downloadAndInstallAppUpdate());
electron_1.ipcMain.handle("open-full-disk-access", async () => {
    await electron_1.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
});
/** Reveals the running bundle so it can be dragged into the Full Disk Access list. */
electron_1.ipcMain.handle("reveal-app-bundle", () => {
    const executablePath = electron_1.app.getPath("exe");
    const bundleMatch = /^(.*\.app)\//.exec(executablePath);
    electron_1.shell.showItemInFolder(bundleMatch ? bundleMatch[1] : executablePath);
});
electron_1.ipcMain.handle("get-access-identity", () => {
    const executablePath = electron_1.app.getPath("exe");
    const bundleMatch = /^(.*\.app)\//.exec(executablePath);
    const bundlePath = bundleMatch ? bundleMatch[1] : executablePath;
    return {
        displayName: electron_1.app.getName(),
        bundlePath,
        // The dev bundle still lists as "Electron" until npm run brand-dev is used.
        isDev: electron_is_dev_1.default,
    };
});
// Phone connectivity
electron_1.ipcMain.handle("get-phone-tooling", () => phoneManager.getTooling());
electron_1.ipcMain.handle("get-phone-backup-states", () => phoneManager.getBackupStates());
electron_1.ipcMain.handle("get-phone-restore-archives", () => phoneManager.getRestoreArchives());
electron_1.ipcMain.handle("create-phone-restore-archive", async (_event, deviceId, platform, password) => {
    if (typeof deviceId !== "string" ||
        !deviceId ||
        platform !== "ios" ||
        typeof password !== "string")
        throw new Error("Invalid iPhone restore-archive request.");
    const device = scannedPhoneDevices.find((candidate) => candidate.id === deviceId &&
        candidate.platform === "ios" &&
        candidate.status === "ready");
    if (!device)
        throw new Error("Connect and trust the iPhone or iPad first.");
    if (!mainWindow || mainWindow.isDestroyed())
        throw new Error("The app window is unavailable to confirm this device backup.");
    const confirmation = await electron_1.dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Enable encrypted device backups?",
        message: `Create an encrypted restore archive for ${device.name}?`,
        detail: "Silo will enable encrypted iPhone backups if needed. The password is never saved by Silo; if you forget it, this archive cannot be restored. Keep the device connected and powered during the backup.",
        buttons: ["Cancel", "Create encrypted archive"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    });
    if (confirmation.response !== 1)
        return null;
    const archive = await phoneManager.createRestoreArchive(device, password);
    return archive;
});
electron_1.ipcMain.handle("restore-phone-from-archive", async (_event, deviceId, platform, archiveId, password) => {
    if (typeof deviceId !== "string" ||
        !deviceId ||
        platform !== "ios" ||
        typeof archiveId !== "string" ||
        !archiveId ||
        typeof password !== "string")
        throw new Error("Invalid iPhone restore request.");
    const device = scannedPhoneDevices.find((candidate) => candidate.id === deviceId &&
        candidate.platform === "ios" &&
        candidate.status === "ready");
    if (!device)
        throw new Error("Connect and trust the iPhone or iPad first.");
    const archive = (await phoneManager.getRestoreArchives()).find((candidate) => candidate.id === archiveId);
    if (!archive)
        throw new Error("The selected restore archive is unavailable.");
    if (!device.model || archive.deviceModel !== device.model)
        throw new Error("The archive can only restore to the same iPhone or iPad model.");
    if (!mainWindow || mainWindow.isDestroyed())
        throw new Error("The app window is unavailable to confirm this device restore.");
    const confirmation = await electron_1.dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Restore iPhone or iPad?",
        message: `Restore ${device.name} from ${archive.deviceName}’s ${new Date(archive.createdAt).toLocaleString()} archive?`,
        detail: "Restoring writes the saved data and settings to the connected device and can replace current content. Keep it connected and powered, and do not interrupt the restore.",
        buttons: ["Cancel", "Restore device"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    });
    if (confirmation.response !== 1)
        return false;
    await phoneManager.restoreDeviceFromArchive(device, archiveId, password);
    return true;
});
electron_1.ipcMain.handle("set-phone-backup-destination", async (_event, destination) => {
    if (typeof destination !== "string" && destination !== null)
        return null;
    const result = await phoneManager.setBackupDestination(destination);
    phoneManagerBackupDestination = result;
    // Also update message backup destination to use the same location
    messageExportCoordinator.setBackupDestination(destination);
    console.log(`[MAIN] Phone backup destination updated to: ${destination || "default"}`);
    return result;
});
electron_1.ipcMain.handle("get-phone-backup-destination", async () => {
    const dest = await phoneManager.getBackupDestination();
    console.log(`[IPC] get-phone-backup-destination returning: ${dest}`);
    return dest;
});
electron_1.ipcMain.handle("rename-phone", async (_event, id, platform, name) => {
    if (typeof id !== "string" ||
        !id ||
        (platform !== "ios" && platform !== "android") ||
        typeof name !== "string")
        throw new Error("Invalid phone rename request.");
    const savedName = await phoneManager.renameDevice(id, platform, name);
    scannedPhoneDevices = scannedPhoneDevices.map((device) => device.id === id && device.platform === platform
        ? { ...device, name: savedName }
        : device);
    sendToRenderer("phone-devices-changed", scannedPhoneDevices);
    return scannedPhoneDevices;
});
electron_1.ipcMain.handle("list-phones", async () => {
    console.log("[IPC] list-phones handler called");
    try {
        // Set a timeout for device discovery to prevent UI from hanging
        const discoveryPromise = discoverAndBackupPhones();
        const timeoutPromise = new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("Phone discovery timed out after 30 seconds")), 30000);
        });
        await Promise.race([discoveryPromise, timeoutPromise]);
        console.log("[IPC] list-phones: returning", scannedPhoneDevices.length, "devices");
        return scannedPhoneDevices;
    }
    catch (error) {
        console.error("[IPC] list-phones error:", error);
        return [];
    }
});
electron_1.ipcMain.handle("connect-phone", async (_event, deviceId, platform) => {
    if (typeof deviceId !== "string" || !deviceId)
        return null;
    if (platform !== "ios" && platform !== "android")
        return null;
    const connected = await phoneManager.connect(deviceId, platform);
    scannedPhoneDevices = await phoneManager.listDevices();
    if (connected.status === "ready" && connected.rootPath) {
        void phoneManager.backupDevice(connected);
        void indexNewSources([connected.rootPath], "phone-connected");
    }
    return connected;
});
electron_1.ipcMain.handle("disconnect-phone", async (_event, deviceId, platform) => {
    if (typeof deviceId !== "string" || !deviceId)
        return;
    if (platform !== "ios" && platform !== "android")
        return;
    await phoneManager.disconnect();
    scannedPhoneDevices = scannedPhoneDevices.filter((device) => device.id !== deviceId || device.platform !== platform);
});
// Google Drive and Google Photos
electron_1.ipcMain.handle("get-google-state", () => googleManager.getState());
electron_1.ipcMain.handle("google-add-account", async () => {
    if ((0, demoLimits_1.isDemoLimitReached)(fullAccessEnabled(), await getDemoSourceCount(), demoLimits_1.DEMO_LIMITS.sources)) {
        notifyDemoLimitReached("sources");
        return googleManager.getState();
    }
    const before = new Set(googleManager.getState().accounts.map((account) => account.driveRootPath));
    const state = await googleManager.addAccount();
    await getEnabledIndexSources();
    const newPaths = state.accounts
        .map((account) => account.driveRootPath)
        .filter((sourcePath) => !before.has(sourcePath));
    void indexNewSources(newPaths, "google-account-added");
    return state;
});
electron_1.ipcMain.handle("google-remove-account", (_event, accountId) => googleManager.removeAccount(accountId));
electron_1.ipcMain.handle("google-start-photo-picker", async (_event, accountId) => {
    const account = googleManager
        .getState()
        .accounts.find((item) => item.id === accountId);
    if (account?.pickedCount === 0 &&
        (0, demoLimits_1.isDemoLimitReached)(fullAccessEnabled(), await getDemoSourceCount(), demoLimits_1.DEMO_LIMITS.sources)) {
        notifyDemoLimitReached("sources");
        return {
            error: `The demo includes up to ${demoLimits_1.DEMO_LIMITS.sources} active sources. Unlock Silo to add Google Photos.`,
        };
    }
    try {
        return await googleManager.startPhotoPicker(accountId);
    }
    catch (error) {
        return {
            error: error instanceof Error ? error.message : "Could not open picker.",
        };
    }
});
electron_1.ipcMain.handle("google-poll-photo-picker", async (_event, accountId, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId)
        return { ready: false, count: 0 };
    const accountBeforePoll = googleManager
        .getState()
        .accounts.find((item) => item.id === accountId);
    const addsPhotoSource = accountBeforePoll?.pickedCount === 0;
    const sourceCountBeforePoll = await getDemoSourceCount();
    try {
        const result = await googleManager.pollPhotoPicker(accountId, sessionId);
        if (result.ready) {
            sourceListCacheAt = 0;
            const account = googleManager
                .getState()
                .accounts.find((item) => item.id === accountId);
            if (account?.photosRootPath &&
                addsPhotoSource &&
                (0, demoLimits_1.isDemoLimitReached)(fullAccessEnabled(), sourceCountBeforePoll, demoLimits_1.DEMO_LIMITS.sources)) {
                googleManager.clearPickedPhotos(accountId);
                sourceListCacheAt = 0;
                notifyDemoLimitReached("sources");
                return {
                    ready: false,
                    count: 0,
                    error: `The demo includes up to ${demoLimits_1.DEMO_LIMITS.sources} active sources. Unlock Silo to add Google Photos.`,
                };
            }
            if (account?.photosRootPath)
                void indexNewSources([account.photosRootPath], "google-photos-added");
        }
        return result;
    }
    catch {
        return { ready: false, count: 0 };
    }
});
electron_1.ipcMain.handle("google-clear-picked-photos", (_event, accountId) => {
    googleManager.clearPickedPhotos(accountId);
    return googleManager.getState();
});
electron_1.ipcMain.handle("google-export-photos", async (_event, accountId) => {
    if (!mainWindow)
        return { ok: false, error: "App window is unavailable." };
    const state = googleManager.getState();
    const sourcePath = accountId
        ? state.accounts.find((account) => account.id === accountId)?.photosRootPath
        : state.allPhotosPath;
    if (!sourcePath)
        return { ok: false, error: "No picked photos." };
    const files = await googleManager.listFiles(sourcePath, false);
    if (files.length === 0)
        return { ok: false, error: "Pick some photos first." };
    const chosen = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Download picked photos to",
        properties: ["openDirectory", "createDirectory"],
    });
    if (chosen.canceled || !chosen.filePaths[0])
        return { ok: false, canceled: true };
    let copied = 0;
    let failed = 0;
    for (const file of files) {
        try {
            const parsedName = path.parse(file.name);
            let destinationPath = path.join(chosen.filePaths[0], parsedName.base);
            let suffix = 2;
            while (await fsPromises.access(destinationPath).then(() => true, () => false)) {
                destinationPath = path.join(chosen.filePaths[0], `${parsedName.name} (${suffix})${parsedName.ext}`);
                suffix += 1;
            }
            const localPath = await googleManager.materialize(file.path);
            await fsPromises.copyFile(localPath, destinationPath);
            copied += 1;
        }
        catch {
            failed += 1;
        }
    }
    return { ok: failed === 0, copied, failed };
});
// Unified sources
electron_1.ipcMain.handle("list-sources", () => listSources());
electron_1.ipcMain.handle("get-library-share-status", () => libraryShareServer?.getStatus() ?? { active: false, sources: [] });
electron_1.ipcMain.handle("start-library-share", async (_event, sourceIds) => {
    if (!libraryShareServer || !semanticIndexer?.isLoaded())
        throw new Error("Silo is still loading its search index.");
    if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== "string"))
        throw new Error("Choose one or more local libraries to share.");
    return libraryShareServer.start(sourceIds);
});
electron_1.ipcMain.handle("stop-library-share", async () => {
    await libraryShareServer?.stop();
    return libraryShareServer?.getStatus() ?? { active: false, sources: [] };
});
electron_1.ipcMain.handle("get-all-sources-path", () => ALL_SOURCES_PATH);
electron_1.ipcMain.handle("set-source-enabled", async (_event, sourceId, enabled) => {
    if (typeof sourceId !== "string" || !sourceId)
        return listSources();
    const shouldEnable = Boolean(enabled);
    const target = (await listSources()).find((source) => source.id === sourceId);
    const phoneTarget = target
        ? phoneManager.parsePhonePath(target.rootPath)
        : null;
    let phonePeers = [];
    if (shouldEnable && phoneTarget) {
        phonePeers = (await listSources()).filter((source) => {
            const parsed = phoneManager.parsePhonePath(source.rootPath);
            return (parsed &&
                parsed.platform === phoneTarget.platform &&
                parsed.deviceId === phoneTarget.deviceId &&
                source.id !== sourceId);
        });
    }
    if (!fullAccessEnabled() && shouldEnable && target && !target.enabled) {
        const replacedIds = new Set(phonePeers.map((source) => source.id));
        const activeRoots = new Set((await listSources())
            .filter((source) => source.enabled &&
            source.available &&
            source.rootPath.trim() &&
            !source.demoLocked &&
            !replacedIds.has(source.id))
            .map((source) => source.rootPath));
        if (!activeRoots.has(target.rootPath) &&
            activeRoots.size >= demoLimits_1.DEMO_LIMITS.sources) {
            notifyDemoLimitReached("sources");
            return listSources();
        }
    }
    for (const peer of phonePeers)
        await stateStore.setSourceEnabled(peer.id, false);
    await stateStore.setSourceEnabled(sourceId, shouldEnable);
    sourceListCacheAt = 0;
    await getEnabledIndexSources();
    if (shouldEnable && phoneTarget)
        void indexNewSources([target.rootPath], "phone-source-enabled");
    await semanticIndexer.startWatching(await getAllIndexSources());
    return listSources();
});
electron_1.ipcMain.handle("set-all-sources-enabled", async (_event, enabled) => {
    const sources = await listSources();
    const allIds = sources.map((source) => source.id);
    if (!enabled) {
        await stateStore.setAllSourcesEnabled(allIds, false);
    }
    else {
        const selectedPhoneSources = new Map();
        for (const source of sources) {
            const parsed = phoneManager.parsePhonePath(source.rootPath);
            if (!parsed || !source.available)
                continue;
            const key = `${parsed.platform}:${parsed.deviceId}`;
            const current = selectedPhoneSources.get(key);
            if (!current ||
                (source.offlineBackup &&
                    (!current.offlineBackup ||
                        (source.snapshotAt ?? 0) > (current.snapshotAt ?? 0))))
                selectedPhoneSources.set(key, source);
        }
        const chosenIds = new Set(sources
            .filter((source) => !source.demoLocked &&
            !phoneManager.parsePhonePath(source.rootPath))
            .map((source) => source.id));
        for (const source of selectedPhoneSources.values())
            if (!source.demoLocked)
                chosenIds.add(source.id);
        if (!fullAccessEnabled()) {
            const allowedRoots = new Set();
            const allowedIds = new Set();
            let overLimit = false;
            for (const source of sources) {
                if (!chosenIds.has(source.id) || !source.available || !source.rootPath)
                    continue;
                if (allowedRoots.has(source.rootPath) ||
                    allowedRoots.size < demoLimits_1.DEMO_LIMITS.sources) {
                    allowedRoots.add(source.rootPath);
                    allowedIds.add(source.id);
                }
                else {
                    overLimit = true;
                }
            }
            chosenIds.clear();
            for (const sourceId of allowedIds)
                chosenIds.add(sourceId);
            if (overLimit)
                notifyDemoLimitReached("sources");
        }
        await stateStore.setAllSourcesEnabled(allIds, false);
        for (const sourceId of chosenIds)
            await stateStore.setSourceEnabled(sourceId, true);
    }
    sourceListCacheAt = 0;
    await getEnabledIndexSources();
    await semanticIndexer.startWatching(await getAllIndexSources());
    return listSources();
});
electron_1.ipcMain.handle("google-create-folder", async (_event, parentPath, name) => {
    try {
        await googleManager.createDriveFolder(parentPath, name);
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not create folder.",
        };
    }
});
electron_1.ipcMain.handle("google-rename-file", async (_event, filePath, name) => {
    try {
        await googleManager.renameDriveFile(filePath, name);
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not rename file.",
        };
    }
});
electron_1.ipcMain.handle("google-trash-file", async (_event, filePath) => {
    try {
        await googleManager.trashDriveFile(filePath);
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not trash file.",
        };
    }
});
electron_1.ipcMain.handle("google-upload-file", async (_event, parentPath) => {
    if (!mainWindow)
        return { ok: false, error: "App window is unavailable." };
    const picked = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Upload to Google Drive",
        properties: ["openFile", "multiSelections"],
    });
    if (picked.canceled || picked.filePaths.length === 0)
        return { ok: false, canceled: true };
    let copied = 0;
    let failed = 0;
    for (const localPath of picked.filePaths) {
        try {
            await googleManager.uploadToDrive(parentPath, localPath);
            copied += 1;
        }
        catch {
            failed += 1;
        }
    }
    return { ok: failed === 0, copied, failed };
});
// Message Export IPC Handlers
electron_1.ipcMain.handle("export-messages", async (_event, accountId, deviceId, outputDir, format, platform = "android", threadIds) => {
    try {
        const result = await messageExportCoordinator.exportMessages({
            accountId,
            deviceId,
            outputDir,
            format,
            includeAttachments: true,
            platform,
            threadIds,
        });
        return result;
    }
    catch (error) {
        return {
            success: false,
            threadCount: 0,
            messageCount: 0,
            attachmentCount: 0,
            error: error.message,
        };
    }
});
electron_1.ipcMain.handle("get-message-threads", async (_event, deviceId, platform, refresh = false) => {
    try {
        const device = scannedPhoneDevices.find((item) => item.id === deviceId && item.platform === platform);
        if (refresh && (!device || device.status !== "ready"))
            throw new Error("Connect and trust this phone before updating its message backup.");
        // Ensure the latest backup destination is synced to messageManager
        const currentDest = await phoneManager.getBackupDestination();
        messageExportCoordinator.setBackupDestination(currentDest);
        const threads = await messageExportCoordinator.getDeviceThreads(deviceId, platform, refresh, device?.name ?? deviceId);
        return { ok: true, threads };
    }
    catch (error) {
        return {
            ok: false,
            threads: [],
            error: error instanceof Error ? error.message : "Could not load messages.",
        };
    }
});
electron_1.ipcMain.handle("get-message-attachment-data-url", async (_event, deviceId, messageId, partId) => {
    try {
        return await messageExportCoordinator.getMessageAttachmentDataUrl(deviceId, messageId, partId);
    }
    catch (error) {
        runtimeLog("message-attachment-read-failed", {
            messageId,
            partId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
});
electron_1.ipcMain.handle("list-message-history", () => messageExportCoordinator.listMessageHistory());
electron_1.ipcMain.handle("list-message-backups", async (_event, baseDir) => {
    try {
        const backups = await messageExportCoordinator.listAvailableBackups(baseDir);
        return backups;
    }
    catch (error) {
        return [];
    }
});
electron_1.ipcMain.handle("restore-messages", async (_event, backupPath, deviceId) => {
    try {
        const result = await messageExportCoordinator.restoreMessages(backupPath, deviceId);
        return result;
    }
    catch (error) {
        return { success: false, message: error.message };
    }
});
// Contact management
electron_1.ipcMain.handle("get-all-contacts", async () => {
    return contactManager.getAllContacts();
});
electron_1.ipcMain.handle("set-contact-name", async (_event, phoneNumber, savedName) => {
    try {
        await contactManager.setContactName(phoneNumber, savedName);
        return { ok: true };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "Could not save contact.",
        };
    }
});
electron_1.ipcMain.handle("get-contact-name", async (_event, phoneNumber) => {
    return contactManager.getContactName(phoneNumber) || null;
});
electron_1.ipcMain.handle("select-backup-destination", async () => {
    if (!mainWindow)
        return null;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Select Backup Destination",
        properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths[0]) {
        return result.filePaths[0];
    }
    return null;
});
electron_1.ipcMain.handle("get-index-storage-root", () => selectedIndexStorageRoot);
electron_1.ipcMain.handle("get-index-storage-status", () => currentIndexStorageStatus());
electron_1.ipcMain.handle("get-local-index-fallback-enabled", () => indexStorageFallbackEnabled);
electron_1.ipcMain.handle("set-local-index-fallback-enabled", async (_event, enabled) => {
    if (typeof enabled !== "boolean")
        throw new Error("Choose whether Silo may use a local cache fallback.");
    await (0, indexingStorage_1.setLocalIndexStorageFallback)(electron_1.app.getPath("userData"), enabled);
    indexStorageFallbackEnabled = enabled;
    await monitorIndexStorageAvailability();
    return { enabled, restarting: indexStorageRelaunchPending };
});
electron_1.ipcMain.handle("select-index-storage-root", async () => {
    if (!mainWindow)
        return { canceled: true };
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Choose Silo Cache Destination",
        properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0])
        return { canceled: true };
    const storageRoot = path.resolve(result.filePaths[0]);
    if (storageRoot === path.resolve(indexStorageRoot))
        return { canceled: false, path: indexStorageRoot };
    try {
        const { requiredBytes } = await (0, indexingStorage_1.validateIndexStorageDestination)(electron_1.app.getPath("userData"), storageRoot);
        const confirmation = await electron_1.dialog.showMessageBox(mainWindow, {
            type: "warning",
            title: "Move Silo Cache and Restart?",
            message: "Silo will move its indexes and generated caches to this folder.",
            detail: `About ${(requiredBytes / 1024 / 1024 / 1024).toFixed(1)} GiB may need to be copied and checksum-verified. The old copies are removed only after verification. If the destination disconnects later, Silo follows your local-fallback setting in Settings.`,
            buttons: ["Move and restart", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        });
        if (confirmation.response !== 0)
            return { canceled: true };
        await (0, indexingStorage_1.stageIndexStorageRoot)(electron_1.app.getPath("userData"), storageRoot);
        electron_1.app.relaunch();
        electron_1.app.quit();
        return { canceled: false, restarting: true, path: storageRoot };
    }
    catch (error) {
        return {
            canceled: false,
            error: error instanceof Error ? error.message : "Could not select this cache destination.",
        };
    }
});
electron_1.ipcMain.handle("start-face-indexing-for-source", async (_event, sourcePath) => {
    try {
        // Face coverage is independent of source selection; preserve UI checkboxes.
        await retryIndexRecoveryStage("faces");
        return {
            success: true,
            message: "Indexing started",
            progress: faceIndexer.getProgress(),
        };
    }
    catch (error) {
        return {
            success: false,
            message: error.message,
        };
    }
});
electron_1.ipcMain.handle("get-face-index-progress", async (_event, _deviceId) => {
    try {
        // Get current indexing progress
        const progress = faceIndexer.getProgress();
        if (progress.status === "idle" || progress.status === "paused") {
            return null;
        }
        return {
            status: progress.status,
            processed: progress.processed,
            remaining: progress.remaining,
            total: progress.total,
        };
    }
    catch (error) {
        return null;
    }
});
