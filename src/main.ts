import {
  app,
  BrowserWindow,
  crashReporter,
  ipcMain,
  dialog,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
} from "electron";
import { createHash, randomBytes } from "crypto";
import { execFile } from "child_process";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import { pathToFileURL } from "url";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import isDev from "electron-is-dev";
import { autoUpdater } from "electron-updater";
import {
  confidenceSettingToMinimumThreshold,
  IndexableFile,
  SearchResult,
  SemanticIndexer,
} from "./semanticIndexer";
import { DuplicateState } from "./duplicateManager";
import {
  FAVORITES_FOLDER_ID,
  REFUSE_FOLDER_ID,
  FileMetadata,
  GeoFileSnapshot,
  StateStore,
} from "./stateStore";
import { FaceIndexer } from "./faceIndexer";
import { PetIndexer } from "./petIndexer";
import {
  PhoneBackupProgress,
  PhoneDevice,
  PhoneManager,
  PhonePlatform,
  PhoneRestoreArchive,
} from "./phoneManager";
import { GoogleManager, loadGoogleEnv } from "./googleManager";
import { MessageExportCoordinator } from "./messageExportCoordinator";
import { ContactManager } from "./contactManager";
import { GeoIndexer, type GeoPhoto } from "./geoIndexer";
import { ThumbnailPregenerator } from "./thumbnailPregenerator";
import { AudioLibraryCache, CachedAudioFile } from "./audioLibraryCache";
import { LibraryStatsManager } from "./libraryStats";
import { InventoryFingerprint } from "./inventoryFingerprint";
import { isAudioFile } from "./utils/audioTypes";
import {
  isSolanaPayReference,
  isSolanaTransactionSignature,
  type LifetimeLicenseState,
  type LifetimePaymentVerification,
  LIFETIME_PAYMENT_ADDRESS,
  LIFETIME_USDC_MINT,
  verifyParsedLifetimePayment,
} from "./lifetimePayment";
import {
  applyDemoSourceLimit,
  DEMO_LIMITS,
  DemoLimitFeature,
  getDemoDestinationKey,
  hasFullAccess,
  isDemoLimitReached,
  selectDemoDeletionBatch,
  selectDemoMapPhotos,
  selectDemoPeople,
} from "./demoLimits";
import {
  BETA_ACTIVATION_REQUEST_EMAIL,
  createBetaActivationRequestPayload,
  createBetaRequestCode,
  type BetaActivationInfo,
  type BetaActivationResult,
  verifyBetaActivationCode,
} from "./betaLicense";
import { BETA_LICENSE_PUBLIC_KEY } from "./betaLicensePublicKey";
import {
  getDocumentPreview,
  isDocumentPreviewFile,
  readPreviewBytes,
} from "./documentPreview";
import { IndexingRecovery } from "./indexingRecovery";
import { InventoryTransfers } from "./inventoryTransfer";
import { RendererRecovery } from "./rendererRecovery";
import { createProgressThrottle } from "./progressThrottle";
import { MemoryManager, MemoryStoryCandidate } from "./memoryManager";
import {
  DiscoveredConcept,
  MEMORY_CONCEPTS,
  MEMORY_JUNK_PROMPTS,
  MEMORY_PHOTO_PROMPTS,
  TopicSignal,
  discoverMemoryStories,
  isPersonalPhotoPath,
} from "./memoryDiscovery";
import { MemoryTopicProfile, RefreshScheduler } from "./memoryTopicProfile";
import * as exifr from "exifr";
import { MemoryExportCancelledError, MemoryExporter } from "./memoryExporter";
import {
  isMemoryDurationAllowed,
  MEMORY_DURATION_SECONDS,
  MEMORY_EXPORT_LIMITS,
  MEMORY_DEFAULT_SELECTION_COUNT,
  selectMemoryPhotoCandidates,
  MemoryExportOptions,
  MemoryMedia,
  MemoryPreviewStatus,
  MemorySettings,
  MemoryState,
  MemorySuggestion,
} from "./memoryTypes";
import { Geocoder, GeocodedLocation } from "./geocoder";
import { DuplicateManager } from "./duplicateManager";
import {
  createIndexStoragePathResolver,
  prepareConfiguredIndexStorage,
  stageIndexStorageRoot,
  validateIndexStorageDestination,
  getLocalIndexStorageFreeBytes,
  assertLocalIndexStorageCapacity,
  LOCAL_INDEX_STORAGE_RESERVE_BYTES,
  setLocalIndexStorageFallback,
  setActiveIndexStorageRoot,
} from "./indexingStorage";
import {
  CLONE_ARCHIVE_EXTENSION,
  extractCloneArchive,
  writeCloneArchive,
} from "./cloneArchive";
import {
  getShelterFreshness,
  readShelterCloneManifest,
  verifyShelterCloneSource,
  type ShelterSourceFile,
} from "./shelterVerification";
import { HeapGuard } from "./heapGuard";
import { startConfiguredTimeMachineBackup } from "./timeMachineBackup";
import {
  isAppDataPath,
  getMacDataVolumeDeviceId,
  invalidateSiloCloneDirectoryCache,
  isMacDataVolumePathExcluded,
  isMacDataVolumeSourceRoot,
  isNonLibraryPath,
  isPathWithin,
  isSiloCloneDirectory,
  MAC_DATA_VOLUME_ROOT,
} from "./indexingPathPolicy";
import { AestheticScorer, MagicItem, MagicPresetId, MagicRankResult } from "./aestheticScorer";
import {
  applyPendingImport,
  cancelStagedImport,
  commitStagedImport,
  exportConfig,
  stageConfigImport,
} from "./configBundle";
import { ContentPreferences, ContentSettingsStore } from "./contentSettings";
import { LibraryShareServer } from "./libraryShareServer";
import {
  containsExplicitTerms,
  fileTextLooksExplicit,
  NSFW_VISUAL_PROMPT,
  SAFE_VISUAL_PROMPT,
} from "./contentPolicy";
import {
  isTimeMachineDirectory,
  parseTimeMachineFile,
  shouldSkipTimeMachineEntry,
  sortTimeMachineEntriesAsync,
} from "./timeMachine";

const mime = require("mime") as { getType(filePath: string): string | null };
const ffmpegStaticPath = require("ffmpeg-static") as string | null;
const execFileAsync = promisify(execFile);
const directlyPlayableVideoExtensions = new Set([".mp4", ".webm", ".ogv"]);
const mediaConversionJobs = new Map<string, Promise<string>>();

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

app.setName("Silo");

function appIconPath(): string {
  return path.join(app.getAppPath(), app.isPackaged ? "build" : "public", "icon.png");
}

// setName would otherwise relocate userData and orphan existing state.
app.setPath(
  "userData",
  process.env.FILE_BROWSER_USER_DATA_DIR ||
    path.join(app.getPath("appData"), "file-browser-electron"),
);
interface MainIndexStorageStatus {
  message: string | null;
  usingLocalFallback: boolean;
  localFallbackEnabled: boolean;
  destinationAvailable: boolean;
  selectedDestination: string;
  localFreeBytes: number | null;
  reserveBytes: number;
  transfer: {
    state: "idle" | "moving" | "complete" | "error";
    message: string;
    filesVerified: number;
    bytesVerified: number;
  } | null;
}

let indexStorageRoot = app.getPath("userData");
setActiveIndexStorageRoot(indexStorageRoot);
const indexStoragePath = createIndexStoragePathResolver(() => indexStorageRoot);
const diagnosticsDirectory = path.join(app.getPath("userData"), "diagnostics");
const lifetimeLicensePath = path.join(
  app.getPath("userData"),
  "lifetime-license.json",
);
const betaLicensePath = path.join(app.getPath("userData"), "beta-license.json");
const betaInstallationIdPath = path.join(
  app.getPath("userData"),
  "beta-installation-id",
);
const lifetimeRpcEndpoint =
  "https://optimistic-daisy-fast-mainnet.helius-rpc.com";

async function requestLifetimeRpc(
  method: string,
  params: unknown[],
): Promise<{ ok: boolean; result?: unknown }> {
  const abortController = new AbortController();
  const requestTimeout = setTimeout(() => abortController.abort(), 15000);
  try {
    const response = await net.fetch(lifetimeRpcEndpoint, {
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
  } finally {
    clearTimeout(requestTimeout);
  }
}

const demoUsagePath = path.join(app.getPath("userData"), "demo-usage.json");
const demoTestingModePath = path.join(
  app.getPath("userData"),
  "demo-testing-mode.json",
);

interface PersistedDemoUsage {
  version: 1;
  memoryPreviewIds: string[];
  duplicateFilesDeleted: number;
}

let lifetimeLicensed = false;
let demoTestingModeEnabled = false;
let betaInstallationIdPromise: Promise<string> | null = null;
let cachedDemoUsage: PersistedDemoUsage | null = null;
let demoUsageWriteQueue: Promise<void> = Promise.resolve();
let demoDuplicateDeleteQueue: Promise<void> = Promise.resolve();
let pendingDemoLimitFeature: DemoLimitFeature | null = null;

function fullAccessEnabled(): boolean {
  return hasFullAccess(lifetimeLicensed, demoTestingModeEnabled);
}

async function readDemoTestingMode(): Promise<boolean> {
  try {
    const value = JSON.parse(
      await fsPromises.readFile(demoTestingModePath, "utf8"),
    );
    return value?.version === 1 && value?.enabled === true;
  } catch {
    return false;
  }
}

async function writeDemoTestingMode(enabled: boolean): Promise<void> {
  await fsPromises.mkdir(path.dirname(demoTestingModePath), {
    recursive: true,
  });
  const temporaryPath = `${demoTestingModePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(
    temporaryPath,
    JSON.stringify({ version: 1, enabled }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await fsPromises.rename(temporaryPath, demoTestingModePath);
}

function notifyDemoLimitReached(feature: DemoLimitFeature): void {
  if (!rendererReady) {
    pendingDemoLimitFeature = feature;
    return;
  }
  sendToRenderer("demo-limit-reached", feature);
}

async function readDemoUsage(): Promise<PersistedDemoUsage> {
  if (cachedDemoUsage) return cachedDemoUsage;
  try {
    const parsed = JSON.parse(await fsPromises.readFile(demoUsagePath, "utf8"));
    const savedIds: unknown[] = Array.isArray(parsed?.memoryPreviewIds)
      ? parsed.memoryPreviewIds
      : [];
    const savedDuplicateFilesDeleted = Number(parsed?.duplicateFilesDeleted);
    const memoryPreviewIds = savedIds.filter(
      (id): id is string => typeof id === "string" && id.length <= 200,
    );
    const usage: PersistedDemoUsage = {
      version: 1,
      memoryPreviewIds: [...new Set<string>(memoryPreviewIds)],
      duplicateFilesDeleted:
        Number.isSafeInteger(savedDuplicateFilesDeleted) &&
        savedDuplicateFilesDeleted > 0
          ? savedDuplicateFilesDeleted
          : 0,
    };
    cachedDemoUsage = usage;
    return usage;
  } catch {
    const usage: PersistedDemoUsage = {
      version: 1,
      memoryPreviewIds: [],
      duplicateFilesDeleted: 0,
    };
    cachedDemoUsage = usage;
    return usage;
  }
}

async function writeDemoUsage(usage: PersistedDemoUsage): Promise<void> {
  await fsPromises.mkdir(path.dirname(demoUsagePath), { recursive: true });
  const temporaryPath = `${demoUsagePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(temporaryPath, JSON.stringify(usage, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fsPromises.rename(temporaryPath, demoUsagePath);
  cachedDemoUsage = usage;
}

async function recordDemoDuplicateDeletes(count: number): Promise<void> {
  if (count <= 0) return;
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

async function consumeDemoMemoryPreview(memoryId: string): Promise<boolean> {
  if (fullAccessEnabled()) return true;
  let allowed = false;
  const write = demoUsageWriteQueue.then(async () => {
    const usage = await readDemoUsage();
    if (usage.memoryPreviewIds.includes(memoryId)) {
      allowed = true;
      return;
    }
    if (
      isDemoLimitReached(
        fullAccessEnabled(),
        usage.memoryPreviewIds.length,
        DEMO_LIMITS.memoryPreviews,
      )
    )
      return;
    const next: PersistedDemoUsage = {
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
  return selectDemoPeople(
    allPeople,
    fullAccessEnabled(),
    DEMO_LIMITS.people,
  );
}

function canAccessDemoPerson(personId: string): boolean {
  if (fullAccessEnabled()) return true;
  const allPeople = faceIndexer?.getPeople() ?? [];
  if (!allPeople.some((person) => person.id === personId)) return false;
  const allowed = selectDemoPeople(
    allPeople,
    false,
    DEMO_LIMITS.people,
  ).some((person) => person.id === personId);
  if (!allowed) notifyDemoLimitReached("people");
  return allowed;
}

function requireDemoPersonAccess(personId: string): void {
  if (canAccessDemoPerson(personId)) return;
  throw new Error(
    `The demo includes up to ${DEMO_LIMITS.people} people. Unlock Silo to manage more.`,
  );
}

function requireDemoPersonSlot(): void {
  if (
    fullAccessEnabled() ||
    (faceIndexer?.getPeople().length ?? 0) < DEMO_LIMITS.people
  )
    return;
  notifyDemoLimitReached("people");
  throw new Error(
    `The demo includes up to ${DEMO_LIMITS.people} people. Unlock Silo to add more.`,
  );
}

function requireDemoPersonTarget(
  target: { personId?: unknown; newName?: unknown } | null | undefined,
): void {
  if (typeof target?.personId === "string") {
    requireDemoPersonAccess(target.personId);
    return;
  }
  if (typeof target?.newName === "string" && target.newName.trim())
    requireDemoPersonSlot();
}

interface StoredLifetimeLicense {
  version: 1;
  network: "solana-mainnet";
  paymentAddress: string;
  usdcMint: string;
  signature: string;
  verifiedAt: number;
}

async function getBetaInstallationId(): Promise<string> {
  if (betaInstallationIdPromise) return betaInstallationIdPromise;
  const pending = (async () => {
    const saved = await fsPromises
      .readFile(betaInstallationIdPath, "utf8")
      .catch(() => "");
    if (/^[a-f0-9]{32}$/.test(saved.trim())) return saved.trim();

    const installationId = randomBytes(16).toString("hex");
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

async function writeBetaLicense(activationCode: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(betaLicensePath), { recursive: true });
  const temporaryPath = `${betaLicensePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(
    temporaryPath,
    JSON.stringify({ version: 1, activationCode }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await fsPromises.rename(temporaryPath, betaLicensePath);
}

async function readLifetimeLicense(): Promise<LifetimeLicenseState> {
  try {
    const stored = JSON.parse(
      await fsPromises.readFile(lifetimeLicensePath, "utf8"),
    ) as Partial<StoredLifetimeLicense>;
    if (
      stored.version === 1 &&
      stored.network === "solana-mainnet" &&
      stored.paymentAddress === LIFETIME_PAYMENT_ADDRESS &&
      stored.usdcMint === LIFETIME_USDC_MINT &&
      typeof stored.signature === "string" &&
      isSolanaTransactionSignature(stored.signature) &&
      typeof stored.verifiedAt === "number" &&
      Number.isFinite(stored.verifiedAt)
    )
      return {
        isLicensed: true,
        licenseType: "purchase",
        signature: stored.signature,
        verifiedAt: stored.verifiedAt,
      };
  } catch {}

  try {
    const stored = JSON.parse(await fsPromises.readFile(betaLicensePath, "utf8"));
    if (typeof stored?.activationCode !== "string")
      return { isLicensed: false };
    const installationId = await getBetaInstallationId();
    const payload = verifyBetaActivationCode(
      stored.activationCode,
      BETA_LICENSE_PUBLIC_KEY,
      installationId,
    );
    if (payload)
      return {
        isLicensed: true,
        licenseType: "beta",
        verifiedAt: payload.issuedAt,
      };
  } catch {}
  return { isLicensed: false };
}

async function writeLifetimeLicense(signature: string, verifiedAt: number) {
  const record: StoredLifetimeLicense = {
    version: 1,
    network: "solana-mainnet",
    paymentAddress: LIFETIME_PAYMENT_ADDRESS,
    usdcMint: LIFETIME_USDC_MINT,
    signature,
    verifiedAt,
  };
  await fsPromises.mkdir(path.dirname(lifetimeLicensePath), {
    recursive: true,
  });
  const temporaryPath = `${lifetimeLicensePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(
    temporaryPath,
    JSON.stringify(record, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await fsPromises.rename(temporaryPath, lifetimeLicensePath);
}
// Two instances on one userData interleave index writes; the newcomer hands off and exits.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
// The dev launcher stops Silo with SIGTERM; quit through the normal path so writes flush.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => app.quit());
const diagnosticsPath = path.join(diagnosticsDirectory, "runtime.jsonl");
const maxBugReportScreenshotBytes = 3 * 1024 * 1024;
const defaultBugReportEndpoint =
  "https://silo-bug-report-relay.vercel.app/api/bug-report";
const defaultBetaRequestEndpoint =
  "https://silo-bug-report-relay.vercel.app/api/beta-request";
fs.mkdirSync(diagnosticsDirectory, { recursive: true });
crashReporter.start({
  productName: "silo",
  companyName: "silo",
  submitURL: "",
  uploadToServer: false,
  compress: false,
});

function runtimeLog(event: string, details: Record<string, unknown> = {}) {
  try {
    fs.appendFileSync(
      diagnosticsPath,
      `${JSON.stringify({ time: new Date().toISOString(), event, pid: process.pid, ...details })}\n`,
    );
  } catch {
    // Diagnostics must not interfere with application startup.
  }
}

process.on("uncaughtException", (error) =>
  runtimeLog("uncaught-exception", {
    message: error.message,
    stack: error.stack,
  }),
);
process.on("unhandledRejection", (reason) =>
  runtimeLog("unhandled-rejection", {
    reason:
      reason instanceof Error ? reason.stack || reason.message : String(reason),
  }),
);
app.on("child-process-gone", (_event, details) =>
  runtimeLog("child-process-gone", { ...details }),
);
protocol.registerSchemesAsPrivileged([
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

interface StartupState {
  ready: boolean;
  step: number;
  total: number;
  label: string;
}

const startupStartedAt = Date.now();
let startupState: StartupState = {
  ready: false,
  step: 0,
  total: 7,
  label: "Starting…",
};
let resolveServicesReady!: () => void;
const servicesReady = new Promise<void>((resolve) => {
  resolveServicesReady = resolve;
});
let servicesAreReady = false;
void servicesReady.then(() => {
  servicesAreReady = true;
});
let indexingOverviewCache: unknown = null;
let indexingOverviewTask: Promise<unknown> | null = null;

/**
 * Progress polling must always answer quickly: during startup it reports startup
 * stages, and afterwards one shared computation runs while callers get the last
 * snapshot if it takes longer than a moment.
 */
function respondIndexingOverview(compute: () => Promise<unknown> | unknown): Promise<unknown> | unknown {
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
  if (indexingOverviewCache === null) return indexingOverviewTask;
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
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
const inventoryTransfers = new InventoryTransfers();
const inventoryExpiryTimer = setInterval(
  () => inventoryTransfers.expire(),
  60000,
);
inventoryExpiryTimer.unref();
ipcMain.handle = ((
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
) =>
  registerIpcHandler(channel, async (event, ...args) => {
    if (channel === "get-indexing-overview")
      return respondIndexingOverview(() => listener(event, ...args));
    if (!EARLY_IPC_CHANNELS.has(channel)) await servicesReady;
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
          files: inventoryTransfers.create(
            result.snapshot.files,
            event.sender.id,
          ),
        },
      };
    }
    return result;
  })) as typeof ipcMain.handle;

function sendToRenderer(channel: string, payload: unknown) {
  const contents = mainWindow?.webContents;
  if (!rendererReady || !contents || contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch {
    // Frame may be mid-navigation; the renderer re-fetches state on mount.
  }
}

function compareAppVersions(candidate: string, current: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? [],
    };
  };
  const candidateVersion = parse(candidate);
  const currentVersion = parse(current);
  if (!candidateVersion || !currentVersion) return null;
  for (let index = 0; index < candidateVersion.core.length; index += 1) {
    if (candidateVersion.core[index] !== currentVersion.core[index])
      return candidateVersion.core[index] > currentVersion.core[index] ? 1 : -1;
  }
  if (!candidateVersion.prerelease.length && !currentVersion.prerelease.length)
    return 0;
  if (!candidateVersion.prerelease.length) return 1;
  if (!currentVersion.prerelease.length) return -1;
  const partCount = Math.max(
    candidateVersion.prerelease.length,
    currentVersion.prerelease.length,
  );
  for (let index = 0; index < partCount; index += 1) {
    const candidatePart = candidateVersion.prerelease[index];
    const currentPart = currentVersion.prerelease[index];
    if (candidatePart === undefined) return -1;
    if (currentPart === undefined) return 1;
    if (candidatePart === currentPart) continue;
    const candidateNumeric = /^\d+$/.test(candidatePart);
    const currentNumeric = /^\d+$/.test(currentPart);
    if (candidateNumeric && currentNumeric)
      return Number(candidatePart) > Number(currentPart) ? 1 : -1;
    if (candidateNumeric !== currentNumeric) return candidateNumeric ? -1 : 1;
    return candidatePart > currentPart ? 1 : -1;
  }
  return 0;
}

function publishAppUpdateState(nextState: AppUpdateState) {
  appUpdateState = nextState;
  sendToRenderer("app-update-state", appUpdateState);
}

function isTrustedReleaseUrl(value: unknown, tag: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(
        `/ilovespectra/silo-downloads/releases/download/${encodeURIComponent(tag)}/`,
      )
    );
  } catch {
    return false;
  }
}

async function getLatestDmgRelease(): Promise<AppUpdateState> {
  const currentVersion = app.getVersion();
  const response = await net.fetch(
    "https://api.github.com/repos/ilovespectra/silo-downloads/releases?per_page=30",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Silo",
      },
    },
  );
  if (!response.ok)
    throw new Error(`Release check returned HTTP ${response.status}`);
  const releases = (await response.json()) as GitHubRelease[];
  const candidates = releases
    .filter(
      (release) =>
        release.draft !== true && typeof release.tag_name === "string",
    )
    .map((release) => ({
      release,
      version: (release.tag_name as string).replace(/^v/, ""),
      order: compareAppVersions(
        (release.tag_name as string).replace(/^v/, ""),
        currentVersion,
      ),
    }))
    .filter((candidate) => candidate.order !== null && candidate.order > 0)
    .sort(
      (left, right) => compareAppVersions(right.version, left.version) ?? 0,
    );
  const latest = candidates[0];
  if (!latest) return { status: "not-available", currentVersion };

  const tag = latest.release.tag_name as string;
  const releaseUrl =
    typeof latest.release.html_url === "string" &&
    latest.release.html_url.startsWith(
      "https://github.com/ilovespectra/silo-downloads/releases/tag/",
    )
      ? latest.release.html_url
      : `https://github.com/ilovespectra/silo-downloads/releases/tag/${encodeURIComponent(tag)}`;
  const expectedArchitecture = process.arch === "arm64" ? "arm64" : "x64";
  const assets = Array.isArray(latest.release.assets)
    ? (latest.release.assets as GitHubReleaseAsset[])
    : [];
  const matchingAsset = assets.find(
    (asset) =>
      asset.name === `Silo-${latest.version}-${expectedArchitecture}.dmg` &&
      isTrustedReleaseUrl(asset.browser_download_url, tag),
  );
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

async function checkForAppUpdates(): Promise<AppUpdateState> {
  if (!app.isPackaged || isDev) {
    const state: AppUpdateState = {
      status: "unsupported",
      currentVersion: app.getVersion(),
      message: "Automatic update checks are available in installed builds.",
    };
    publishAppUpdateState(state);
    return state;
  }
  if (appUpdateCheck) return appUpdateCheck;

  appUpdateCheck = (async () => {
    publishAppUpdateState({
      status: "checking",
      currentVersion: app.getVersion(),
    });
    try {
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        runtimeLog("updater-metadata-unavailable", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const state = await getLatestDmgRelease();
      publishAppUpdateState(state);
      return state;
    } catch (error) {
      const state: AppUpdateState = {
        status: "error",
        currentVersion: app.getVersion(),
        message: "Could not check for updates. Try again when you are online.",
      };
      runtimeLog("app-update-check-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      publishAppUpdateState(state);
      return state;
    } finally {
      appUpdateCheck = null;
    }
  })();
  return appUpdateCheck;
}

async function downloadAndInstallAppUpdate(): Promise<AppUpdateState> {
  if (!app.isPackaged || isDev) {
    const state: AppUpdateState = {
      status: "unsupported",
      currentVersion: app.getVersion(),
      message: "Install an official Silo build to use automatic updates.",
    };
    publishAppUpdateState(state);
    return state;
  }

  if (appUpdateInstall) return appUpdateInstall;

  const announcedUpdate = appUpdateState;
  if (
    announcedUpdate.status !== "available" ||
    !announcedUpdate.version ||
    !announcedUpdate.downloadUrl
  ) {
    const state: AppUpdateState = {
      status: "error",
      currentVersion: app.getVersion(),
      message: "No compatible update is ready to install. Check again online.",
    };
    publishAppUpdateState(state);
    return state;
  }

  appUpdateInstall = (async () => {
    const currentVersion = app.getVersion();
    const version = announcedUpdate.version as string;
    publishAppUpdateState({
      ...announcedUpdate,
      status: "checking",
      currentVersion,
      message: `Verifying Silo ${version} before download…`,
    });

    try {
      const updateCheck = await autoUpdater.checkForUpdates();
      if (
        !updateCheck?.isUpdateAvailable ||
        compareAppVersions(updateCheck.updateInfo.version, version) !== 0
      ) {
        throw new Error("The release metadata does not match the announced update.");
      }

      publishAppUpdateState({
        ...announcedUpdate,
        status: "downloading",
        currentVersion,
        downloadPercent: 0,
        message: `Downloading Silo ${version}…`,
      });
      await autoUpdater.downloadUpdate();

      const state: AppUpdateState = {
        ...announcedUpdate,
        status: "installing",
        currentVersion,
        message: `Silo ${version} is installing. The app will restart automatically.`,
      };
      publishAppUpdateState(state);
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (error) {
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
    } catch (error) {
      runtimeLog("app-update-install-failed", {
        version,
        message: error instanceof Error ? error.message : String(error),
      });
      const state: AppUpdateState = {
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
  } finally {
    appUpdateInstall = null;
  }
}

function configureAppUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.on("error", (error) => {
    runtimeLog("electron-updater-discovery-error", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    if (appUpdateState.status !== "downloading") return;
    publishAppUpdateState({
      ...appUpdateState,
      downloadPercent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    });
  });
  if (app.isPackaged && !isDev) {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "ilovespectra",
      repo: "silo-downloads",
    });
  }
}

const sendIndexProgress = createProgressThrottle((progress) =>
  sendToRenderer("index-progress", progress),
);
const sendFaceIndexProgress = createProgressThrottle((progress) =>
  sendToRenderer("face-index-progress", progress),
);

function reportStartup(label: string, ready = false) {
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
  console.log(
    `[STARTUP] ${startupState.step}/${startupState.total} ${label} (+${Date.now() - startupStartedAt}ms)`,
  );
  sendToRenderer("startup-progress", startupState);
}

/** Updates what the current step is doing without advancing the step count. */
function reportStartupDetail(label: string) {
  if (startupState.ready) return;
  startupState = { ...startupState, label };
  sendToRenderer("startup-progress", startupState);
}

let mainWindow: BrowserWindow | null = null;
let indexStorageDeviceId: number | null = null;
let indexStorageAvailable = true;
let indexStorageInitializationDeferred = false;
let activeIndexStorageCacheWrites = 0;
let indexStorageUnavailableMessage: string | null = null;
let selectedIndexStorageRoot = indexStorageRoot;
let indexStorageUsingLocalFallback = false;
let indexStorageFallbackEnabled = true;
let indexStorageDestinationAvailable = true;
let indexStorageMessageText: string | null = null;
let indexStorageFreeBytes: number | null = null;
let indexStorageTransfer: MainIndexStorageStatus["transfer"] = null;
let indexStorageMonitorTimer: NodeJS.Timeout | null = null;
let indexStorageMonitorRunning = false;
let indexStorageTransferRunning = false;
let indexStorageRelaunchPending = false;
let indexStorageTransferRetryAt = 0;
let heapPressureMessage: string | null = null;
let rendererReady = false;
let shuttingDown = false;
type AppUpdateState = {
  status:
    | "checking"
    | "available"
    | "downloading"
    | "installing"
    | "not-available"
    | "error"
    | "unsupported";
  currentVersion: string;
  version?: string;
  downloadUrl?: string;
  releaseUrl?: string;
  downloadPercent?: number;
  message?: string;
};
type GitHubReleaseAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};
type GitHubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  html_url?: unknown;
  assets?: unknown;
};
let appUpdateState: AppUpdateState = {
  status: "unsupported",
  currentVersion: app.getVersion(),
  message: "Automatic update checks are available in installed builds.",
};
let appUpdateCheck: Promise<AppUpdateState> | null = null;
let appUpdateInstall: Promise<AppUpdateState> | null = null;
const rendererRecovery = new RendererRecovery();
let rendererRecoveryTimer: NodeJS.Timeout | null = null;
let stateStore: StateStore;
let hiddenFolderPathCache = new Set<string>();
let semanticIndexer: SemanticIndexer;
let libraryShareServer: LibraryShareServer | null = null;
let libraryStatsManager: LibraryStatsManager | null = null;
let faceIndexer: FaceIndexer;
let aestheticScorer: AestheticScorer;
let petIndexer: PetIndexer;
let phoneManager: PhoneManager;
let googleManager: GoogleManager;
let messageExportCoordinator: MessageExportCoordinator;
let contactManager: ContactManager;
let geoIndexer: GeoIndexer;
let thumbnailPregenerator: ThumbnailPregenerator | null = null;
let audioLibraryCache: AudioLibraryCache | null = null;
let audioInventoryRetryTimer: NodeJS.Timeout | null = null;
let audioInventoryRunning = false;
let pendingAudioRefreshRequestId = -1;
let pendingAudioRefreshForce = false;
let audioInventoryProgress: {
  scanned: number;
  sourceIndex: number;
  sourceCount: number;
} | null = null;
let magicLibraryProgress = { analyzed: 0, total: 0, running: false };
let memoryManager: MemoryManager;
let memoryExporter: MemoryExporter;
let memoryExportRunning = false;
let memoryExportCancelRequested = false;
let memoryExportScratch: string | null = null;
let memoryPreviewQueue: Promise<void> = Promise.resolve();
const memoryPreviewStatus = new Map<string, MemoryPreviewStatus>();
let memoryRenderQueue: Promise<void> = Promise.resolve();
const memoryFrameVectors = new Map<string, Float32Array>();
// Session-only: clips whose first frame classified unsafe; rechecked for saved suggestions.
const memoryUnsafeVideoPaths = new Set<string>();
let memoryMetadataSnapshot: {
  at: number;
  metadata: Record<string, FileMetadata>;
} | null = null;
type ScoredMemoryMedia = MemoryMedia & { score: number; size?: number; magicScore?: number };
const MEMORY_VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".webm"]);
const MEMORY_PREVIEW_RENDER_VERSION = 7;
const MEMORY_DUPLICATE_SIMILARITY = 0.85;

function memoryFileMetadata(filePath: string): FileMetadata | undefined {
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
function memoryAllowed(filePath: unknown): boolean {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0"))
    return false;
  if (!stateStore || !faceIndexer) return false;
  const hidden = getHiddenFolderPaths();
  // Hidden-folder entries may be directories; their descendants are hidden too.
  for (let current = filePath; ; ) {
    if (hidden.has(current)) return false;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (
    faceIndexer.getBannedPhotoPaths().has(filePath) ||
    semanticUnsafePaths.has(filePath) ||
    memoryUnsafeVideoPaths.has(filePath)
  )
    return false;
  return !fileTextLooksExplicit(
    { name: path.basename(filePath), path: filePath },
    memoryFileMetadata(filePath),
  );
}

async function memoryLiveVideo(file: MemoryMedia) {
  if (file.type !== "image" || isRemotePath(file.path)) return undefined;
  const parsed = path.parse(file.path);
  if (![".heic", ".heif", ".jpg", ".jpeg"].includes(parsed.ext.toLowerCase())) return undefined;
  const variants = [".mov", ".MOV", ".mp4", ".MP4"].map((ext) =>
    path.join(parsed.dir, parsed.name + ext),
  );
  // Case-insensitive volumes resolve every casing to one file, so all spellings must be allowed.
  if (!variants.every((candidate) => memoryAllowed(candidate))) return undefined;
  for (const candidate of variants) {
    if (await fsPromises.stat(candidate).then((s) => s.isFile(), () => false))
      return candidate;
  }
  return undefined;
}

function memoryThumbnailFile(thumbnailUrl: string | null): string | null {
  if (!thumbnailUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(thumbnailUrl);
  } catch {
    return null;
  }
  const fileName = parsed.pathname.slice(1);
  if (parsed.protocol !== "thumb:" || !/^[a-f0-9]{40}\.jpg$/.test(fileName))
    return null;
  return indexStoragePath("thumbnail-cache", fileName);
}

/** Streams directory entries; never materializes a full listing of a huge folder. */
async function memoryVideoCandidates(
  directories: string[],
  limit = 12,
  entriesPerDirectory = 2000,
): Promise<string[]> {
  const found: string[] = [];
  for (const directory of directories.slice(0, 4)) {
    if (found.length >= limit) break;
    try {
      const dir = await fsPromises.opendir(directory);
      let seen = 0;
      for await (const entry of dir) {
        if (found.length >= limit || ++seen > entriesPerDirectory) break;
        if (!entry.isFile() || !MEMORY_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
          continue;
        const filePath = path.join(directory, entry.name);
        if (memoryAllowed(filePath)) found.push(filePath);
      }
    } catch {
      // Unreadable folders contribute no clips.
    }
  }
  return found;
}

function memoryDot(first: Float32Array, second: Float32Array) {
  let sum = 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index++) sum += first[index] * second[index];
  return sum;
}

async function filterMemoryPhotos(paths: string[]): Promise<string[]> {
  if (!aestheticScorer || paths.length === 0) return [];
  return aestheticScorer.filterSimilar(paths, MEMORY_DUPLICATE_SIMILARITY);
}

async function searchMemoryMedia(query: string): Promise<ScoredMemoryMedia[]> {
  if (typeof query !== "string" || !query.trim()) return [];
  if (!semanticIndexer || !faceIndexer)
    throw new Error("Memory search is not ready yet. Try again shortly.");
  const roots = await getAllIndexSources();
  if (roots.length === 0) return [];
  // Confidence is similarity * 100; MemoryManager reads only the first 50 hits.
  const matches = await semanticIndexer.search(query, 24, roots);
  const photoCandidates: ScoredMemoryMedia[] = [];
  const musicDirectories = memoryMusicDirectories();
  for (const file of matches) {
    if (photoCandidates.length >= 120) break;
    if (file.type !== "image" || !memoryAllowed(file.path) ||
      !isPersonalPhotoPath(file.path, file.size, musicDirectories)) continue;
    photoCandidates.push({ path: file.path, name: file.name, type: "image",
      modified: file.modified, size: file.size, score: file.confidence });
  }
  const magic: MagicRankResult = photoCandidates.length
    ? await aestheticScorer.rankDistinct(photoCandidates.map(({ path: filePath, name, size, modified }) =>
      ({ path: filePath, name, size: size ?? 0, modified })), "variety", MEMORY_DUPLICATE_SIMILARITY)
    : { order: [], scores: {}, analyzed: 0, total: 0, running: false };
  const candidatesByPath = new Map(photoCandidates.map((file) => [file.path, file]));
  const rankedPhotos: ScoredMemoryMedia[] = magic.order.slice(0, 38).flatMap((filePath) => {
    const candidate = candidatesByPath.get(filePath);
    if (!candidate) return [];
    const magicScore = magic.scores[filePath];
    return [{ ...candidate, magicScore: Number.isFinite(magicScore) ? magicScore : -1,
      score: (Number.isFinite(magicScore) ? magicScore : 0) + candidate.score / 1000 }];
  });
  const qualityPhotos = await applyMemoryPhotoQuality(rankedPhotos);
  const photos = selectMemoryPhotoCandidates(qualityPhotos).map(({ magicScore, ...photo }) => photo);
  // Clips beside matched photos; first frames are classified on demand, never a library rescan.
  const directories = Array.from(new Set(photos
    .filter((file) => !isRemotePath(file.path))
    .map((file) => path.dirname(file.path)))).slice(0, 4);
  const candidates = photos.length ? await memoryVideoCandidates(directories) : [];
  const videos: ScoredMemoryMedia[] = [];
  if (candidates.length) {
    const [prompt, unsafePrompt, safePrompt] = await semanticIndexer.embedPrompts([
      `a photo of ${query}`,
      `a photo of ${NSFW_VISUAL_PROMPT}`,
      `a photo of ${SAFE_VISUAL_PROMPT}`,
    ]);
    for (const filePath of candidates) {
      try {
        const stat = await fsPromises.stat(filePath);
        if (!stat.isFile()) continue;
        const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
        let vector = memoryFrameVectors.get(key);
        if (!vector) {
          const framePath = memoryThumbnailFile(await getThumbnail(filePath, false, 480));
          if (!framePath) continue;
          vector = await semanticIndexer.embedPreviewImage(framePath);
          if (memoryFrameVectors.size >= 128) memoryFrameVectors.delete(memoryFrameVectors.keys().next().value!);
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
      } catch { /* A damaged clip must not discard the photo story. */ }
    }
  }
  return [...photos, ...videos].sort((first, second) => second.score - first.score);
}

let memoryTopicProfile: MemoryTopicProfile | null = null;
let memoryProfileScheduler: RefreshScheduler | null = null;

function personalMemoryPhotoFilter() {
  const musicDirectories = memoryMusicDirectories();
  return (file: { path: string; size: number }) => isPersonalPhotoPath(file.path, file.size, musicDirectories);
}

/** Incremental, persisted profile of what the archive is about; only changed records are reread. */
function getMemoryTopicProfile(): MemoryTopicProfile {
  if (!memoryTopicProfile)
    memoryTopicProfile = new MemoryTopicProfile({
      statePath: path.join(app.getPath("userData"), "memories", "topic-profile.json"),
      topics: MEMORY_CONCEPTS.map((concept) => ({ id: concept.id, prompt: `a photo of ${concept.prompt}` })),
      distractorPrompts: [...MEMORY_JUNK_PROMPTS, ...MEMORY_PHOTO_PROMPTS],
      revision: () => semanticIndexer.getRevision(),
      records: async () => {
        await semanticIndexer.whenLoaded();
        const personal = personalMemoryPhotoFilter();
        return semanticIndexer.getIndexedImageRecords(await getAllIndexSources()).filter(personal);
      },
      vectors: (paths) => semanticIndexer.getImageVectors(paths),
      embedPrompts: (prompts) => semanticIndexer.embedPrompts(prompts),
      captureTime: async (filePath) =>
        isRemotePath(filePath) ? null : (await readMemoryExif(filePath))?.takenAt || null,
    });
  return memoryTopicProfile;
}

/** Indexing or startup reconciliation is still changing records; profile work waits. */
function memoryProfileBusy(): boolean {
  return !semanticIndexer?.isLoaded() ||
    PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status) ||
    semanticIndexer.getReconciliationProgress().running;
}

async function refreshMemoryTopicsAfterIndexing(): Promise<void> {
  const result = await getMemoryTopicProfile().refresh();
  runtimeLog("memory-topic-profile", { ...result, sampled: memoryTopicProfile?.getSnapshot()?.sampledPhotos ?? 0 });
  if (!result.changed || !memoryManager) return;
  const state = await memoryManager.refreshForProfileChange();
  // Previews render only once indexing is quiet; the next notification retries otherwise.
  if (!memoryProfileBusy()) await prepareAllMemoryPreviews(state.suggestions);
}
let memoryPhotoPromptVectors: Promise<{ junk: Float32Array[]; good: Float32Array[] }> | null = null;

function memoryPromptVectors() {
  if (!memoryPhotoPromptVectors) {
    memoryPhotoPromptVectors = semanticIndexer
      .embedPrompts([...MEMORY_JUNK_PROMPTS, ...MEMORY_PHOTO_PROMPTS])
      .then((vectors) => ({
        junk: vectors.slice(0, MEMORY_JUNK_PROMPTS.length),
        good: vectors.slice(MEMORY_JUNK_PROMPTS.length),
      }));
    memoryPhotoPromptVectors.catch(() => { memoryPhotoPromptVectors = null; });
  }
  return memoryPhotoPromptVectors;
}

/** Story photos ranked by how much they look like real moments; screenshots and documents are dropped. */
async function loadMemoryIdeaMedia(paths: string[], modified: Map<string, number>) {
  const [vectors, prompts] = await Promise.all([
    semanticIndexer.getImageVectors(paths),
    memoryPromptVectors(),
  ]);
  const media: ScoredMemoryMedia[] = [];
  for (const filePath of paths) {
    const vector = vectors.get(filePath);
    if (!vector) continue;
    const good = Math.max(...prompts.good.map((prompt) => memoryDot(prompt, vector)));
    const junk = Math.max(...prompts.junk.map((prompt) => memoryDot(prompt, vector)));
    if (junk > good + 0.01) continue;
    media.push({ path: filePath, name: path.basename(filePath), type: "image",
      modified: modified.get(filePath) ?? 0, score: good * 100 });
  }
  if (media.length === 0) return [];
  const magic = await aestheticScorer.rankDistinct(media.map((item) => ({
    path: item.path, name: item.name, size: item.size ?? 0, modified: item.modified,
  })), "variety", MEMORY_DUPLICATE_SIMILARITY);
  const candidatesByPath = new Map(media.map((item) => [item.path, item]));
  const rankedPhotos: ScoredMemoryMedia[] = magic.order.slice(0, 38).flatMap((filePath) => {
    const candidate = candidatesByPath.get(filePath);
    if (!candidate) return [];
    const magicScore = magic.scores[filePath];
    return [{ ...candidate, magicScore: Number.isFinite(magicScore) ? magicScore : -1,
      score: (Number.isFinite(magicScore) ? magicScore : 0) + candidate.score / 1000 }];
  });
  const qualityPhotos = await applyMemoryPhotoQuality(rankedPhotos);
  return selectMemoryPhotoCandidates(qualityPhotos).map(({ magicScore, ...photo }) => photo);
}

type MemoryExif = { camera: boolean; width: number; height: number; takenAt: number };
const memoryExifCache = new Map<string, MemoryExif | null>();

/** Camera make/model, capture date and pixel size; null when unreadable. */
async function readMemoryExif(filePath: string): Promise<MemoryExif | null> {
  if (memoryExifCache.has(filePath)) return memoryExifCache.get(filePath)!;
  let result: MemoryExif | null = null;
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
  } catch {
    result = null;
  }
  if (memoryExifCache.size >= 20000) memoryExifCache.delete(memoryExifCache.keys().next().value!);
  memoryExifCache.set(filePath, result);
  return result;
}

/**
 * Drops low-resolution and artwork-like images (no camera data and square, like album
 * covers) and favours real camera shots; remote files are kept as-is.
 */
async function applyMemoryPhotoQuality(media: ScoredMemoryMedia[]): Promise<ScoredMemoryMedia[]> {
  const kept: ScoredMemoryMedia[] = [];
  for (let start = 0; start < media.length; start += 16) {
    const batch = media.slice(start, start + 16);
    const exif = await Promise.all(batch.map((item) =>
      item.type === "image" && !isRemotePath(item.path) ? readMemoryExif(item.path) : Promise.resolve(null)));
    batch.forEach((item, index) => {
      const data = exif[index];
      if (!data) return kept.push(item);
      const long = Math.max(data.width, data.height);
      const short = Math.min(data.width, data.height);
      if (long && (long < 1280 || short < 720)) return;
      const square = long > 0 && Math.abs(data.width - data.height) / long < 0.02;
      if (!data.camera && !data.takenAt && square) return;
      const factor = data.camera ? 1.15 : data.takenAt ? 1 : 0.7;
      kept.push({ ...item, score: item.score * factor,
        ...(data.takenAt ? { modified: data.takenAt } : {}) });
    });
  }
  return kept;
}

let memoryMusicDirectoryCache: { key: string; directories: Set<string> } | null = null;

/** Folders holding several audio files are album folders; their images are cover art. */
function memoryMusicDirectories(): Set<string> {
  const snapshot = audioLibraryCache?.getSnapshot();
  if (!snapshot) return new Set();
  const key = `${snapshot.scannedAt}:${snapshot.files.length}`;
  if (memoryMusicDirectoryCache?.key === key) return memoryMusicDirectoryCache.directories;
  const counts = new Map<string, number>();
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
async function discoverMemoryIdeas(): Promise<MemoryStoryCandidate[]> {
  if (!semanticIndexer) throw new Error("Memory search is not ready yet.");
  const roots = await getAllIndexSources();
  if (!roots.length) return [];
  const personal = personalMemoryPhotoFilter();
  const profile = getMemoryTopicProfile();
  await profile.refresh();
  const images = semanticIndexer.getIndexedImages(roots)
    .filter(personal)
    .map(({ path: filePath, modified }) => ({ path: filePath, modified, captured: profile.captureTimeOf(filePath) }));
  if (images.length < 4) return [];
  const modified = new Map(images.map((image) => [image.path, image.captured ?? image.modified]));
  const topics = profile.getSnapshot()?.topics ?? [];
  const concepts: DiscoveredConcept[] = topics.filter((topic) => topic.estimatedCount >= 5).slice(0, 18)
    .map((topic) => ({ id: topic.id, paths: topic.paths.filter(memoryAllowed), count: topic.estimatedCount }));
  const signals: TopicSignal[] = topics.map((topic) => ({ id: topic.id, interest: topic.interest, lift: topic.lift,
    recentCount: topic.recentCount, recentPaths: topic.recentPaths.filter(memoryAllowed) }));
  const places = geoIndexer
    ? getVisibleDemoMapPhotos(
        geoIndexer.getState().photos,
        roots,
      ).map(({ path: filePath, city, region, country }) =>
      ({ path: filePath, city, region, country }))
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
  return discoverMemoryStories({ images, places, people, pets, concepts, topics: signals })
    .map((idea) => ({
      key: idea.key, title: idea.title, description: idea.description, query: idea.query, mood: idea.mood,
      load: () => loadMemoryIdeaMedia(idea.paths, modified),
    }));
}

const MEMORY_DEFAULT_MOVIE_DIRECTORY = () => path.join(app.getPath("userData"), "memories", "previews");

/** Saved memory movies live in the user's chosen folder when it is reachable. */
async function memoryMovieDirectory(): Promise<string> {
  const chosen = (await memoryManager.getSettings()).movieDirectory;
  if (chosen) {
    const directory = path.join(chosen, "Silo Memories");
    if (await fsPromises.mkdir(directory, { recursive: true }).then(() => true, () => false))
      return directory;
  }
  return MEMORY_DEFAULT_MOVIE_DIRECTORY();
}

/** A rendered movie in the active folder, or one left in app storage before the folder changed. */
async function findMemoryMovie(suggestion: MemorySuggestion): Promise<string | null> {
  const name = memoryPreviewFileName(suggestion);
  for (const directory of new Set([await memoryMovieDirectory(), MEMORY_DEFAULT_MOVIE_DIRECTORY()])) {
    const candidate = path.join(directory, name);
    if (await fsPromises.stat(candidate).then((result) => result.isFile(), () => false)) return candidate;
  }
  return null;
}

/** Converted copies go to a per-export scratch directory; sources are never written. */
async function prepareMemoryExportImage(localPath: string): Promise<string> {
  const scratch = memoryExportScratch;
  if (!scratch) throw new Error("Memory export is not active.");
  let converted: Buffer;
  try {
    converted = await getConvertedImageBuffer(localPath, 2048, 90, "memory-image-cache");
  } catch {
    // No sips (non-macOS) or undecodable by sips: FFmpeg reads the original read-only.
    return localPath;
  }
  const file = path.join(scratch, `${createHash("sha1").update(localPath).digest("hex")}.jpg`);
  await fsPromises.writeFile(file, converted, { flag: "wx", mode: 0o600 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return file;
}

function memoryExportOptions(value: unknown): MemoryExportOptions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const options = value as Record<string, unknown>;
  const { minCount, maxCount } = MEMORY_EXPORT_LIMITS;
  const { suggestionId, soundtrackId, count, duration, originalAudio, rightsAcknowledged, orientation } = options;
  if (
    typeof suggestionId !== "string" || !suggestionId || suggestionId.length > 200 ||
    typeof soundtrackId !== "string" || !soundtrackId || soundtrackId.length > 250 ||
    typeof count !== "number" || !Number.isInteger(count) || count < minCount || count > maxCount ||
    typeof duration !== "number" || !Number.isFinite(duration) || duration !== MEMORY_DURATION_SECONDS ||
    typeof originalAudio !== "number" || !Number.isFinite(originalAudio) || originalAudio < 0 || originalAudio > 1 ||
    (orientation !== undefined && !["auto", "landscape", "portrait"].includes(String(orientation))) ||
    (rightsAcknowledged !== undefined && typeof rightsAcknowledged !== "boolean")
  )
    return null;
  if (!isMemoryDurationAllowed(count, duration)) return null;
  return { suggestionId, soundtrackId, count, duration, originalAudio,
    rightsAcknowledged: rightsAcknowledged === true };
}

/** Re-resolves the saved suggestion and soundtrack against current safety state. */
async function verifyMemoryExport(options: MemoryExportOptions) {
  const suggestion = await memoryManager.getSuggestion(options.suggestionId);
  if (!suggestion || suggestion.media.length === 0)
    throw new Error("This memory is no longer available. Refresh suggestions.");
  const minimumCount = Math.min(MEMORY_DEFAULT_SELECTION_COUNT, suggestion.media.length);
  const maximumCount = Math.min(MEMORY_EXPORT_LIMITS.maxCount, suggestion.media.length);
  if (options.count < minimumCount || options.count > maximumCount)
    throw new Error(`Choose ${minimumCount} to ${maximumCount} items to keep this memory moving briskly.`);
  if (!suggestion.media.every((file) => memoryAllowed(file.path) &&
    (!file.liveVideoPath || memoryAllowed(file.liveVideoPath))))
    throw new Error("This memory contains newly hidden photos. Regenerate suggestions before exporting.");
  const soundtrack = await memoryManager.resolveSoundtrack(options.soundtrackId, suggestion.id);
  if (!soundtrack) throw new Error("Soundtrack is no longer available.");
  if (soundtrack.source === "library" && (!soundtrack.path || !memoryAllowed(soundtrack.path)))
    throw new Error("Soundtrack is no longer available.");
  return { suggestion, soundtrack };
}

/** Every watchable movie is rendered at the same one-minute length as an export. */
function memoryPreviewOptions(suggestion: MemorySuggestion): MemoryExportOptions {
  const { maxCount } = MEMORY_EXPORT_LIMITS;
  const count = Math.max(1, Math.min(MEMORY_DEFAULT_SELECTION_COUNT, maxCount, suggestion.media.length));
  return {
    suggestionId: suggestion.id,
    count,
    duration: MEMORY_DURATION_SECONDS,
    soundtrackId: suggestion.soundtrackId ?? `original:${suggestion.id}`,
    originalAudio: 0.18,
  };
}

function memoryPreviewFileName(suggestion: MemorySuggestion): string {
  const { count, duration } = memoryPreviewOptions(suggestion);
  const selected = suggestion.media.slice(0, count);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: MEMORY_PREVIEW_RENDER_VERSION,
    id: suggestion.id,
    frame: "landscape-16:9",
    media: selected.map(({ path: mediaPath, modified, type, liveVideoPath }) =>
      ({ path: mediaPath, modified, type, liveVideoPath })),
    duration,
    originalAudio: 0.18,
    soundtrack: suggestion.soundtrackId ?? null,
  })).digest("hex");
  return `${fingerprint}.mp4`;
}

/** Movies render in the background, one at a time; cards show live status meanwhile. */
function prepareMemoryPreviews(suggestions: MemorySuggestion[]): Promise<void> {
  // A story already waiting or rendering is never queued twice.
  const fresh = suggestions.filter((suggestion) => {
    const status = memoryPreviewStatus.get(suggestion.id)?.status;
    return status !== "queued" && status !== "rendering";
  });
  if (!fresh.length) return memoryPreviewQueue;
  for (const suggestion of fresh)
    if (memoryPreviewStatus.get(suggestion.id)?.status !== "ready") setMemoryPreviewStatus(suggestion.id, { status: "queued" });
  const task = memoryPreviewQueue.catch(() => undefined)
    .then(() => prepareMemoryPreviewsNow(fresh));
  memoryPreviewQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Visible cards first, then the reserve stockpile, all on the single render queue. */
async function prepareAllMemoryPreviews(visible: MemorySuggestion[]): Promise<void> {
  const reserve = await memoryManager.getReserve().catch(() => [] as MemorySuggestion[]);
  void prepareMemoryPreviews(visible).catch(() => runtimeLog("memory-preview-error"));
  if (reserve.length) void prepareMemoryPreviews(reserve).catch(() => runtimeLog("memory-reserve-preview-error"));
}

let memoryPreviewEmitTimer: NodeJS.Timeout | null = null;

function setMemoryPreviewStatus(id: string, status: MemoryPreviewStatus) {
  memoryPreviewStatus.set(id, status);
  if (memoryPreviewStatus.size > 64) memoryPreviewStatus.delete(memoryPreviewStatus.keys().next().value!);
  // Progress arrives per frame; the page needs a few updates a second at most.
  if (memoryPreviewEmitTimer) return;
  memoryPreviewEmitTimer = setTimeout(() => {
    memoryPreviewEmitTimer = null;
    sendToRenderer("memory-preview-progress", Object.fromEntries(memoryPreviewStatus));
  }, 250);
}

/** Ready/queued/rendering status for each card; a movie on disk is always ready. */
async function memoryPreviewStatuses(suggestions: MemorySuggestion[]): Promise<Record<string, MemoryPreviewStatus>> {
  const result: Record<string, MemoryPreviewStatus> = {};
  for (const suggestion of suggestions) {
    const known = memoryPreviewStatus.get(suggestion.id);
    if (known && known.status !== "ready") result[suggestion.id] = known;
    else result[suggestion.id] = await findMemoryMovie(suggestion) ? { status: "ready" } : { status: "queued" };
  }
  return result;
}

async function memoryStateWithPreviews(state?: MemoryState): Promise<MemoryState> {
  const current = state ?? await memoryManager.getState();
  return { ...current, previews: await memoryPreviewStatuses(current.suggestions) };
}

function runMemoryRender<T>(render: () => Promise<T>): Promise<T> {
  const task = memoryRenderQueue.then(render, render);
  memoryRenderQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function prepareMemoryPreviewsNow(suggestions: MemorySuggestion[]): Promise<void> {
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
          if (options.soundtrackId === `original:${suggestion.id}`) throw error;
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
            } finally {
              memoryExportScratch = null;
            }
          });
        } finally {
          await fsPromises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        }
        setMemoryPreviewStatus(suggestion.id, { status: "ready", progress: 1 });
      } catch (error) {
        setMemoryPreviewStatus(suggestion.id, { status: "failed" });
        runtimeLog("memory-preview-skipped", { message: error instanceof Error ? error.message : String(error) });
      }
    }
    // Keep movies of every visible and reserve story; delete only Silo-named leftovers.
    const state = await memoryManager.getState();
    const retained = new Set([...state.suggestions, ...await memoryManager.getReserve(), ...suggestions]
      .map(memoryPreviewFileName));
    const cached = await fsPromises.readdir(cacheDirectory).catch(() => [] as string[]);
    await Promise.all(cached.filter((name) => /^[a-f0-9]{64}\.mp4$/.test(name) && !retained.has(name))
      .map((name) => fsPromises.unlink(path.join(cacheDirectory, name)).catch(() => undefined)));
  } finally {
    memoryExportScratch = null;
  }
}
let thumbnailPregenTimer: NodeJS.Timeout | null = null;
const phoneBackupHolds = new Map<string, string>();
const phoneBackupLastStatus = new Map<string, string>();
let phoneManagerBackupDestination: string | null = null;
let thumbnailPregenDirty = true;
let startupIndexReconciliationSettled = false;
let indexRecovery: IndexingRecovery | null = null;
let indexRecoveryTimer: NodeJS.Timeout | null = null;
let recoverySearchSourcePaths: string[] = [];
const queuedRecoveryStageIds = new Set<string>();
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
let geocoder: Geocoder;
let duplicateManager: DuplicateManager;
let contentSettingsStore: ContentSettingsStore;
let semanticUnsafePaths = new Set<string>();
let safetyScanPromise: Promise<void> | null = null;
let scannedPhoneDevices: PhoneDevice[] = [];
let enabledSourcePathCache = new Set<string>();
let enabledSourceCacheReady = false;
let diagnosticsTimer: NodeJS.Timeout | null = null;
let heapGuardTimer: NodeJS.Timeout | null = null;
let lastIndexDiagnostic = 0;
let lastSemanticProgressStatus: string | null = null;
let lastFaceProgressStatus: string | null = null;
// localeCompare with options builds a collator per call, which dominates sorts of 100k+ files.
const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
let semanticChangesPending = false;
let geoCheckedThisSession = false;
let geoCheckPromise: Promise<void> | null = null;
let pendingSemanticFullScanAll = false;
let lifetimeFullScanPending = false;
const pendingSemanticFullScanRoots = new Set<string>();
const pendingSemanticResumeRoots = new Set<string>();
const pendingSemanticChangedFiles = new Map<string, string>();

function requestIndexRecoveryStages(stageIds: string[]) {
  stageIds.forEach((id) => queuedRecoveryStageIds.add(id));
  if (!indexRecovery) return;
  const requested = Array.from(queuedRecoveryStageIds);
  queuedRecoveryStageIds.clear();
  for (const id of requested)
    try {
      indexRecovery.request(id);
    } catch (error) {
      runtimeLog("index-recovery-request-error", {
        stage: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
}

function queueSemanticIndexWork(
  work: {
    fullScanAll?: boolean;
    fullScanRoots?: string[];
    resumeRoots?: string[];
    changedFiles?: Map<string, string>;
    force?: boolean;
  },
  relatedStages: string[] = [],
) {
  if (work.fullScanAll) pendingSemanticFullScanAll = true;
  work.fullScanRoots?.forEach((root) => pendingSemanticFullScanRoots.add(root));
  work.resumeRoots?.forEach((root) => pendingSemanticResumeRoots.add(root));
  work.changedFiles?.forEach((root, filePath) =>
    pendingSemanticChangedFiles.set(filePath, root),
  );

  const hasSearchWork =
    pendingSemanticFullScanAll ||
    pendingSemanticFullScanRoots.size > 0 ||
    pendingSemanticResumeRoots.size > 0 ||
    pendingSemanticChangedFiles.size > 0;
  if (!hasSearchWork) {
    if (relatedStages.length) requestIndexRecoveryStages(relatedStages);
    return;
  }

  if (typeof semanticIndexer !== "undefined" && semanticIndexer) {
    const progress = semanticIndexer.getProgress();
    if (
      !work.force &&
      progress.status === "paused" &&
      !/interrupted/i.test(progress.message)
    )
      return;
  }
  semanticChangesPending = true;
  requestIndexRecoveryStages(["search", ...relatedStages]);
}

function queueIndexRecoveryStages(stageIds: string[]) {
  stageIds.forEach((id) => queuedRecoveryStageIds.add(id));
  if (!indexRecovery) return;
  const requested = Array.from(queuedRecoveryStageIds);
  queuedRecoveryStageIds.clear();
  for (const id of requested) indexRecovery.request(id);
}

async function retryIndexRecoveryStage(id: string) {
  if (!indexRecovery) {
    queuedRecoveryStageIds.add(id);
    return;
  }
  await indexRecovery.retry(id);
}

function hasRetryableSearchWork(sourcePaths: string[]) {
  return (
    semanticIndexer.getRetryableErrorCount(sourcePaths) > 0 ||
    semanticIndexer.getSourceCoverageProgress(sourcePaths).errors > 0
  );
}

function requestSourceProcessingStages(sourcePaths: string[]) {
  const stageIds = [
    "faces",
    "locations",
    "duplicates",
    "pets",
    "thumbnails",
    "audio",
    "quality",
  ];
  if (
    semanticIndexer.getProgress().status === "error" ||
    hasRetryableSearchWork(sourcePaths)
  )
    queueSemanticIndexWork({
      fullScanRoots: semanticIndexer.getSourceCoverageErrors(sourcePaths),
      changedFiles: semanticIndexer.getRetryableFiles(sourcePaths),
    });
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
  if (markDirty) thumbnailPregenDirty = true;
  if (!thumbnailPregenerator) return;
  if (thumbnailPregenTimer) clearTimeout(thumbnailPregenTimer);
  thumbnailPregenTimer = setTimeout(() => {
    thumbnailPregenTimer = null;
    if (!thumbnailPregenerator || !thumbnailPregenDirty) return;
    const waitMessage = getThumbnailIndexingWaitMessage();
    if (waitMessage) return thumbnailPregenerator.setWaiting(waitMessage);
    thumbnailPregenDirty = false;
    requestIndexRecoveryStages(["thumbnails"]);
  }, 5000);
}

function getThumbnailIndexingWaitMessage(): string | null {
  if (indexStorageUnavailableMessage) return indexStorageUnavailableMessage;
  if (!semanticIndexer || !faceIndexer || !geoIndexer)
    return "Waiting for indexing services to start…";
  if (!startupIndexReconciliationSettled)
    return "Waiting for search indexing to finish…";
  if (PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status))
    return "Waiting for search indexing to finish…";
  if (PIPELINE_BUSY_STATUSES.has(faceIndexer.getProgress().status))
    return "Waiting for face clustering to finish…";
  if (
    ["loading-model", "clustering"].includes(petIndexer?.getProgress().status)
  )
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

function runGeoCheck(): Promise<void> {
  if (!geoIndexer || !semanticIndexer) return Promise.resolve();
  if (geoCheckPromise) return geoCheckPromise;
  geoCheckPromise = getAllIndexSources()
    .then((sources) =>
      geoIndexer.start(semanticIndexer.getIndexedImages(sources), sources),
    )
    .finally(() => {
      geoCheckPromise = null;
    });
  return geoCheckPromise;
}

function kickGeoCheck(explicit = false): Promise<void> {
  if (!geoIndexer || !semanticIndexer || !indexStorageAvailable)
    return Promise.resolve();
  if (geoCheckPromise) return geoCheckPromise;
  if (!indexRecovery) return runGeoCheck();
  if (explicit) void indexRecovery.retry("locations");
  else requestIndexRecoveryStages(["locations"]);
  // Recovery owns the work; callers must not wait on a stage that may be queued
  // behind search indexing or an intentional user pause.
  return Promise.resolve();
}

function registerMediaProtocols() {
  protocol.handle("face-crop", async (request) => {
    // Accept legacy absolute-path URLs too, but only ever serve from the active crops directory.
    const fileName = path.basename(
      decodeURIComponent(new URL(request.url).pathname.slice(1)),
    );
    if (!/^[A-Za-z0-9_-]+\.jpg$/.test(fileName))
      return new Response("Not found", { status: 404 });
    try {
      const data = await fsPromises.readFile(
        indexStoragePath("face-index", "crops", fileName),
      );
      return new Response(data, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  const thumbnailDirectory = path.join(
    indexStorageRoot,
    "thumbnail-cache",
  );
  protocol.handle("thumb", async (request) => {
    const fileName = new URL(request.url).pathname.slice(1);
    // Only content-hash names from getThumbnail are servable; blocks path traversal.
    if (!/^[a-f0-9]{40}\.jpg$/.test(fileName))
      return new Response("Not found", { status: 404 });
    try {
      const data = await fsPromises.readFile(
        path.join(thumbnailDirectory, fileName),
      );
      return new Response(data, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  protocol.handle("app-media", async (request) => {
    const requested = decodeURIComponent(
      new URL(request.url).pathname.slice(1),
    );
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
      let statusCode: 200 | 206 = 200;
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
          if (match[2]) end = Math.min(Number(match[2]), size - 1);
        } else {
          const suffixLength = Number(match[2]);
          start = Math.max(0, size - suffixLength);
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= size
        )
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
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      return new Response(body, { status: statusCode, headers });
    } catch (error) {
      console.error(`[app-media] Could not serve ${requested}:`, error);
      return new Response("Not found", { status: 404 });
    }
  });
}
let phoneDiscoveryTimer: NodeJS.Timeout | null = null;
let phoneDiscoveryPromise: Promise<void> | null = null;
const seenReadyPhoneKeys = new Set<string>();
let derivedIndexTimer: NodeJS.Timeout | null = null;
let derivedIndexPromise: Promise<void> | null = null;
let derivedIndexRerunRequested = false;
const safetyCachePath = () =>
  indexStoragePath("content-safety-index.json");
const thumbnailMemoryCache = new Map<string, string>();
const MAX_THUMBNAIL_CACHE_SIZE = 2048; // Limit to 2K cached thumbnails in memory
const MAX_QUEUE_SIZE = 1024; // Limit queue to prevent memory explosion

interface ThumbnailJob {
  execute: () => void;
  filePath: string;
  priority: number;
  queuedAt: number;
}
const thumbnailJobs: ThumbnailJob[] = [];
let activeThumbnailJobs = 0;
const visibleThumbnailPaths = new Set<string>();
const pendingThumbnails = new Map<string, Promise<string | null>>();
// Content keys that could not be rendered; skips repeated expensive failures until the file changes.
const failedThumbnailKeys = new Set<string>();

function thumbnailJobPriority(job: ThumbnailJob) {
  return visibleThumbnailPaths.has(job.filePath) ? 0 : job.priority;
}

function sortThumbnailJobs() {
  thumbnailJobs.sort(
    (a, b) =>
      thumbnailJobPriority(a) - thumbnailJobPriority(b) ||
      a.queuedAt - b.queuedAt,
  );
}

function shouldHideForContentSafety(
  file: { name: string; path: string },
  fileMetadata:
    | Record<string, FileMetadata>
    | undefined = stateStore?.getState().fileMetadata,
  folderHiddenPaths: ReadonlySet<string> = getHiddenFolderPaths(),
) {
  const settings = contentSettingsStore?.getPublicSettings();
  if (folderHiddenPaths.has(file.path)) return true;
  if (
    !settings?.showBannedPeople &&
    faceIndexer?.getBannedPhotoPaths().has(file.path)
  )
    return true;
  if (settings?.showNsfw) return false;
  return (
    semanticUnsafePaths.has(file.path) ||
    fileTextLooksExplicit(file, fileMetadata?.[file.path])
  );
}

function getHiddenFolderPaths(exceptFolderId?: string) {
  if (!exceptFolderId) return hiddenFolderPathCache;
  const folders = stateStore?.getState().digitalFolders ?? [];
  const paths = new Set<string>();
  for (const folder of folders) {
    if (!folder.hidden || folder.id === exceptFolderId) continue;
    folder.filePaths.forEach((filePath) => paths.add(filePath));
  }
  return paths;
}

function refreshHiddenFolderPathCache() {
  const paths = new Set<string>();
  for (const folder of stateStore?.getState().digitalFolders ?? [])
    if (folder.hidden)
      folder.filePaths.forEach((filePath) => paths.add(filePath));
  hiddenFolderPathCache = paths;
}

function filterForContentSafety<T extends { name: string; path: string }>(
  files: T[],
  exceptFolderId?: string,
) {
  const settings = contentSettingsStore?.getPublicSettings();
  const folderHiddenPaths = getHiddenFolderPaths(exceptFolderId);
  const banned = settings?.showBannedPeople
    ? null
    : faceIndexer?.getBannedPhotoPaths();
  const visible = files.filter(
    (file) =>
      !folderHiddenPaths.has(file.path) && (!banned || !banned.has(file.path)),
  );
  if (settings?.showNsfw) return visible;
  // getState() deep-clones the whole app state, so read it once per batch rather than per file.
  const fileMetadata = stateStore?.getState().fileMetadata;
  return visible.filter(
    (file) =>
      !shouldHideForContentSafety(file, fileMetadata, folderHiddenPaths),
  );
}

/** NSFW filtering only: a person's own page still lists their photos even when they are banned. */
function filterForNsfw<T extends { name: string; path: string }>(files: T[]) {
  const folderHiddenPaths = getHiddenFolderPaths();
  const visible = files.filter((file) => !folderHiddenPaths.has(file.path));
  if (contentSettingsStore?.getPublicSettings().showNsfw) return visible;
  const fileMetadata = stateStore?.getState().fileMetadata;
  return visible.filter(
    (file) =>
      !semanticUnsafePaths.has(file.path) &&
      !fileTextLooksExplicit(file, fileMetadata?.[file.path]),
  );
}

function notifyFolderVisibilityChange(
  before: Set<string>,
  after: Set<string>,
  folderId: string,
) {
  const hiddenPaths = Array.from(after).filter(
    (filePath) => !before.has(filePath),
  );
  const unhiddenPaths = Array.from(before).filter(
    (filePath) => !after.has(filePath),
  );
  if (hiddenPaths.length === 0 && unhiddenPaths.length === 0) return;
  mainWindow?.webContents.send("content-safety-changed", {
    flaggedCount: semanticUnsafePaths.size,
    folderHiddenPaths: hiddenPaths,
    folderUnhiddenPaths: unhiddenPaths,
    folderId,
  });
}

function filterDuplicateState(state: DuplicateState): DuplicateState {
  const hidden = getHiddenFolderPaths();
  if (hidden.size === 0 && !enabledSourceCacheReady) return state;
  const groups = state.groups.flatMap((group) => {
    const files = group.files.filter(
      (file) => !hidden.has(file.path) && fileIsInEnabledSource(file.path),
    );
    if (files.length < 2) return [];
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
  const duplicateFiles = groups.reduce(
    (sum, group) => sum + Math.max(0, group.files.length - 1),
    0,
  );
  return {
    ...state,
    groups,
    duplicateFiles,
    reclaimableBytes: groups.reduce(
      (sum, group) => sum + group.reclaimableBytes,
      0,
    ),
  };
}

async function loadSafetyCache() {
  try {
    const stored = JSON.parse(
      await fsPromises.readFile(safetyCachePath(), "utf8"),
    ) as { paths?: string[] };
    semanticUnsafePaths = new Set(
      Array.isArray(stored.paths) ? stored.paths : [],
    );
  } catch {
    semanticUnsafePaths = new Set();
  }
}

function refreshSemanticSafetyIndex() {
  if (safetyScanPromise) return safetyScanPromise;
  safetyScanPromise = (async () => {
    const sources = await getAllIndexSources();
    const unsafe = await semanticIndexer.classifyUnsafeImages(
      sources,
      NSFW_VISUAL_PROMPT,
      SAFE_VISUAL_PROMPT,
    );
    semanticUnsafePaths = new Set(unsafe);
    const temporaryPath = `${safetyCachePath()}.tmp`;
    await fsPromises.writeFile(
      temporaryPath,
      JSON.stringify({ updatedAt: Date.now(), paths: unsafe }),
    );
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
  if (!geoIndexer || !faceIndexer || !duplicateManager) return;
  if (derivedIndexTimer) clearTimeout(derivedIndexTimer);
  derivedIndexTimer = setTimeout(() => {
    derivedIndexTimer = null;
    void runDerivedIndexes();
  }, delay);
}

function runDerivedIndexes(): Promise<void> {
  // DISABLED: Derived indexing (duplicates, faces, geo) causes memory exhaustion
  // with large collections. Will be re-enabled only on explicit user request.
  console.log(
    "[DERIVED-INDEX] Derived indexing is currently disabled to prevent memory issues",
  );
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

function discoverAndBackupPhones(): Promise<void> {
  if (phoneDiscoveryPromise) return phoneDiscoveryPromise;
  phoneDiscoveryPromise = (async () => {
    try {
      console.log("[PHONE-DISCOVERY] Starting discovery...");
      const devices = await phoneManager.listDevices();
      const devicesChanged =
        JSON.stringify(devices) !== JSON.stringify(scannedPhoneDevices);
      console.log(
        `[PHONE-DISCOVERY] Found ${devices.length} devices:`,
        devices.map((d) => `${d.platform}:${d.id}:${d.status}`),
      );
      const previousReady = new Set(
        scannedPhoneDevices
          .filter((device) => device.status === "ready" && device.rootPath)
          .map((device) => device.rootPath!),
      );
      scannedPhoneDevices = devices;
      const newlyReadyPaths = devices
        .filter(
          (device) =>
            device.status === "ready" &&
            device.rootPath &&
            !previousReady.has(device.rootPath),
        )
        .map((device) => device.rootPath!);
      if (newlyReadyPaths.length > 0) {
        void indexNewSources(newlyReadyPaths, "phone-connected").catch(
          (error) =>
            runtimeLog("phone-source-index-error", { message: String(error) }),
        );
        requestIndexRecoveryStages(["audio"]);
        scheduleThumbnailPregeneration(true);
      }

      // Guard IPC send with rendererReady check
      if (
        devicesChanged &&
        rendererReady &&
        mainWindow?.webContents &&
        !mainWindow.webContents.isDestroyed()
      ) {
        mainWindow.webContents.send("phone-devices-changed", devices);
      }

      const currentReadyKeys = new Set(
        devices
          .filter((device) => device.status === "ready" && device.rootPath)
          .map((device) => `${device.platform}:${device.id}`),
      );
      console.log(
        `[PHONE-DISCOVERY] Ready keys:`,
        Array.from(currentReadyKeys),
      );
      const backupStates = new Map(
        phoneManager
          .getBackupStates()
          .map((state) => [`${state.platform}:${state.deviceId}`, state]),
      );
      for (const device of devices) {
        if (device.status !== "ready" || !device.rootPath) continue;
        const key = `${device.platform}:${device.id}`;
        const previous = backupStates.get(key);
        // Only start backup if:
        // 1. No previous backup exists (!previous), OR
        // 2. Previous backup failed with error, OR
        // 3. Previous backup completed successfully AND it's been 10+ minutes
        // Do NOT auto-restart interrupted backups (idle/backing-up status)
        const isCompletedBackup = previous?.status === "complete";
        const refreshDue =
          isCompletedBackup &&
          (!previous?.lastBackupAt ||
            Date.now() - previous.lastBackupAt >= 10 * 60 * 1000);
        const shouldStart =
          !previous || previous.status === "error" || refreshDue;
        console.log(
          `[PHONE-DISCOVERY] Device ${key}: shouldStart=${shouldStart}, hasPrevious=${!!previous}, status=${previous?.status}, isCompletedBackup=${isCompletedBackup}, refreshDue=${refreshDue}`,
        );
        if (!shouldStart) continue;
        console.log(`[PHONE-DISCOVERY] Triggering backup for ${key}`);
        void phoneManager.backupDevice(device).then((progress) => {
          console.log(
            `[PHONE-DISCOVERY] Backup finished for ${key}:`,
            progress.status,
          );
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
      for (const key of currentReadyKeys) seenReadyPhoneKeys.add(key);
    } catch (error) {
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

function queueThumbnail<T>(
  filePath: string,
  job: () => Promise<T>,
  urgent = false,
): Promise<T> {
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
        console.warn(
          `[MEMORY] Thumbnail queue critically large: ${thumbnailJobs.length} items`,
        );
      }
    }

    // Periodically clean old entries from memory cache if it's growing too large
    if (thumbnailMemoryCache.size > MAX_THUMBNAIL_CACHE_SIZE) {
      const entriesToDelete = Array.from(thumbnailMemoryCache.keys()).slice(
        0,
        Math.floor(MAX_THUMBNAIL_CACHE_SIZE * 0.2),
      ); // Delete oldest 20%
      for (const key of entriesToDelete) {
        thumbnailMemoryCache.delete(key);
      }
      console.log(
        `[MEMORY] Pruned thumbnail cache to ${thumbnailMemoryCache.size} items`,
      );
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
    const job = thumbnailJobs.shift()!;
    job.execute();
  }
}

async function getConvertedImageBuffer(
  filePath: string,
  maxDimension: number,
  quality: number,
  cacheName: string,
): Promise<Buffer> {
  const stats = await fsPromises.stat(filePath);
  const cacheDirectory = indexStoragePath(cacheName);
  const cacheKey = createHash("sha1")
    .update(
      `${filePath}:${stats.size}:${stats.mtimeMs}:${maxDimension}:${quality}`,
    )
    .digest("hex");
  const cachePath = path.join(cacheDirectory, `${cacheKey}.jpg`);
  try {
    return await fsPromises.readFile(cachePath);
  } catch {
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
  } finally {
    await fsPromises.rm(temporaryPath, { force: true });
  }
}

async function quickLookThumbnail(
  filePath: string,
  size: number,
): Promise<Buffer> {
  const outputDirectory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "silo-ql-"),
  );
  try {
    await execFileAsync(
      "qlmanage",
      ["-t", "-s", String(size), "-o", outputDirectory, filePath],
      { timeout: 15000 },
    );
    const [output] = await fsPromises.readdir(outputDirectory);
    if (!output) throw new Error("QuickLook produced no thumbnail");
    const image = nativeImage.createFromPath(
      path.join(outputDirectory, output),
    );
    if (image.isEmpty()) throw new Error("QuickLook thumbnail was empty");
    return image.toJPEG(65);
  } finally {
    await fsPromises.rm(outputDirectory, { recursive: true, force: true });
  }
}

async function sipsThumbnail(filePath: string, size: number): Promise<Buffer> {
  const outputDirectory = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "silo-sips-"),
  );
  const outputPath = path.join(outputDirectory, "thumb.jpg");
  try {
    // sips decodes by content, so mislabeled extensions (e.g. JPEG saved as .PNG) still work.
    await execFileAsync(
      "sips",
      [
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
      ],
      { timeout: 20000 },
    );
    const buffer = await fsPromises.readFile(outputPath);
    if (buffer.length === 0)
      throw new Error("sips produced an empty thumbnail");
    return buffer;
  } finally {
    await fsPromises.rm(outputDirectory, { recursive: true, force: true });
  }
}

async function renderThumbnail(
  filePath: string,
  mimeType: string,
  size = 480,
): Promise<Buffer> {
  const isImage = mimeType.startsWith("image/");
  if (mimeType.startsWith("video/")) {
    const outputDirectory = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "silo-video-thumb-"),
    );
    const outputPath = path.join(outputDirectory, "frame.jpg");
    try {
      await execFileAsync(
        getFfmpegPath(),
        [
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
        ],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      );
      const frame = await fsPromises.readFile(outputPath);
      if (frame.length > 0) return frame;
    } catch {
      // Fall back to the platform thumbnail provider below.
    } finally {
      await fsPromises.rm(outputDirectory, { recursive: true, force: true });
    }
  }
  // QuickLook returns a generic document icon (not an error) when it can't preview a file,
  // so for images a real decode must come first or the icon gets cached as the thumbnail.
  if (isImage && process.platform === "darwin") {
    try {
      return await sipsThumbnail(filePath, size);
    } catch {
      // Fall through to QuickLook.
    }
  }
  if (isImage) {
    const image = nativeImage.createFromPath(filePath);
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
    const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
      width: size,
      height: Math.round(size * 0.6875),
    });
    if (!thumbnail.isEmpty()) return thumbnail.toJPEG(70);
  } catch {
    // Fall through to qlmanage.
  }
  if (process.platform === "darwin") return quickLookThumbnail(filePath, size);
  throw new Error("Thumbnail unavailable");
}

const THUMBNAIL_CACHE_VERSION = "3";
let thumbnailCacheReady: Promise<void> | null = null;

/** Version 1 stored QuickLook placeholder icons as thumbnails; move that cache aside and delete it in the background. */
function ensureThumbnailCacheVersion() {
  thumbnailCacheReady ??= (async () => {
    const cacheDirectory = path.join(
      indexStorageRoot,
      "thumbnail-cache",
    );
    const versionPath = path.join(cacheDirectory, ".version");
    const current = await fsPromises
      .readFile(versionPath, "utf8")
      .catch(() => null);
    if (current?.trim() === THUMBNAIL_CACHE_VERSION) return;
    const stale = `${cacheDirectory}-stale-${Date.now()}`;
    await fsPromises.rename(cacheDirectory, stale).catch(() => undefined);
    void fsPromises
      .rm(stale, { recursive: true, force: true })
      .catch(() => undefined);
    await fsPromises.mkdir(cacheDirectory, { recursive: true });
    await fsPromises.writeFile(versionPath, THUMBNAIL_CACHE_VERSION);
  })();
  return thumbnailCacheReady;
}

async function getThumbnail(
  filePath: string,
  force = false,
  size = 480,
): Promise<string | null> {
  await ensureThumbnailCacheVersion();
  const stats = await fsPromises.stat(filePath);
  const mimeType = mime.getType(filePath);
  // Support both images and videos
  if (!mimeType?.startsWith("image/") && !mimeType?.startsWith("video/"))
    return null;

  const cacheKey = createHash("sha1")
    .update(
      `${mimeType.startsWith("video/") ? "video-frame-v1" : `v${THUMBNAIL_CACHE_VERSION}`}:${size}:${filePath}:${stats.size}:${stats.mtimeMs}`,
    )
    .digest("hex");
  if (force) failedThumbnailKeys.delete(cacheKey);
  const memoryHit = thumbnailMemoryCache.get(cacheKey);
  if (memoryHit) return memoryHit;
  if (failedThumbnailKeys.has(cacheKey)) return null;

  const cacheDirectory = indexStoragePath("thumbnail-cache");
  const cachePath = path.join(cacheDirectory, `${cacheKey}.jpg`);

  try {
    await fsPromises.access(cachePath);
  } catch {
    let thumbnailBuffer: Buffer;
    try {
      thumbnailBuffer = await renderThumbnail(filePath, mimeType, size);
    } catch {
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
    if (oldestKey) thumbnailMemoryCache.delete(oldestKey);
  }
  thumbnailMemoryCache.set(cacheKey, thumbnailUrl);
  return thumbnailUrl;
}

interface FileInfo {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: number;
  isDirectory: boolean;
  type: string;
  extension: string;
  sourceId?: string;
  sourceLabel?: string;
  backupTimestamp?: number;
  sourceSnapshotAt?: number;
}

type SourceClonePhase =
  | "scanning"
  | "checking-space"
  | "copying"
  | "verifying"
  | "complete"
  | "error"
  | "cancelled";

interface SourceCloneProgress {
  operationId: string;
  phase: SourceClonePhase;
  destination: string;
  totalSources: number;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  copiedBytes: number;
  verifiedFiles: number;
  failedFiles: number;
  currentFile: string;
  message: string;
}

interface SourceClonePlanEntry {
  sourcePath: string;
  destinationRelativePath: string;
  sha256?: string;
  duplicateOf?: string;
  sourceId?: string;
  sourceRelativePath?: string;
  sourceSize?: number;
  sourceModified?: number;
  localPath?: string;
  size: number;
  modified: number;
  isDirectory: boolean;
}

interface SourceClonePlan {
  id: string;
  operationId: string;
  destinations: Array<{ destination: string; cloneRoot: string; freeBytes: number; shortfallBytes: number }>;
  entries: SourceClonePlanEntry[];
  totalFiles: number;
  totalBytes: number;
  duplicateFiles: number;
  sourceLabels: string[];
  sourceIds: string[];
  configDirectory: string;
  replicaOf?: string;
  sourceManifest?: Record<string, unknown>;
}

const sourceClonePlans = new Map<string, SourceClonePlan>();
const sourceCloneOperations = new Map<string, { cancelled: boolean }>();
const sourceCloneStatusPath = path.join(app.getPath("userData"), "source-clone-status.json");
type SourceCloneStatusRecord = {
  lastClonedAt: number;
  destinations: string[];
  sourceFingerprint?: string;
  sourceFingerprintVersion?: number;
  shelterAudits?: Record<string, {
    clonePath: string | null;
    lastFullyVerifiedAt: number | null;
    lastAttemptAt: number;
    lastResult: "verified" | "mismatch" | "missing" | "error";
    verifiedFiles: number;
    totalFiles: number;
    sourceFingerprint?: string;
    message?: string;
  }>;
};
let sourceCloneStatusCache: Record<string, SourceCloneStatusRecord> | null = null;
let sourceCloneStatusWrite: Promise<void> = Promise.resolve();
const shelterDestinationPath = path.join(app.getPath("userData"), "shelter-destination.json");
let shelterDestinationCache: string | null | undefined;

async function getShelterDestination(): Promise<string | null> {
  if (shelterDestinationCache !== undefined) return shelterDestinationCache;
  try {
    const stored = JSON.parse(await fsPromises.readFile(shelterDestinationPath, "utf8"));
    shelterDestinationCache = typeof stored.destination === "string" ? stored.destination : null;
  } catch {
    shelterDestinationCache = null;
  }
  return shelterDestinationCache ?? null;
}

async function setShelterDestination(destination: unknown): Promise<string | null> {
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
  if (!destination) return { destination: null, available: false };
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
  } catch {
    return { destination, available: false };
  }
}

async function getSourceCloneStatus() {
  if (!sourceCloneStatusCache) {
    try {
      const stored = JSON.parse(await fsPromises.readFile(sourceCloneStatusPath, "utf8"));
      sourceCloneStatusCache = stored && typeof stored === "object" ? stored : {};
    } catch {
      sourceCloneStatusCache = {};
    }
  }
  return sourceCloneStatusCache;
}

async function persistSourceCloneStatus(update: Record<string, SourceCloneStatusRecord>) {
  const status = (await getSourceCloneStatus())!;
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

function classifyFile(fileName: string, mimeType: string | null): string {
  const extension = path.extname(fileName).toLowerCase();
  const mimeGroup = mimeType?.split("/")[0];
  // MIME databases call every .ts file a transport stream; prefer source-code
  // classification here. The preview handler checks packet signatures for playback.
  if (extension === ".ts") return "document";
  if (mimeGroup === "video" || videoExtensions.has(extension)) return "video";
  if (mimeGroup === "image") return "image";
  if (isAudioFile(fileName, mimeType)) return "audio";
  if (
    mimeGroup === "text" ||
    mimeType === "application/pdf" ||
    isDocumentPreviewFile(fileName) ||
    documentExtensions.has(extension)
  ) {
    return "document";
  }
  if (archiveExtensions.has(extension)) return "archive";
  return "other";
}

interface ScanDiagnostics {
  denied: number;
  unreadable: number;
  isTimeMachine: boolean;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES";
}

async function readFiles(
  rootPath: string,
  exploded: boolean,
  diagnostics?: ScanDiagnostics,
  onProgress?: (files: FileInfo[]) => void,
  sourceRootPath?: string,
): Promise<FileInfo[]> {
  const results: FileInfo[] = [];
  const appDataPath = path.resolve(app.getPath("userData"));
  const canonicalAppDataPath = await fsPromises
    .realpath(appDataPath)
    .catch(() => appDataPath);
  const canonicalRootPath = await fsPromises
    .realpath(rootPath)
    .catch(() => path.resolve(rootPath));
  const isSiloAppData = (candidatePath: string) =>
    isAppDataPath(
      candidatePath,
      rootPath,
      canonicalRootPath,
      appDataPath,
      canonicalAppDataPath,
    );
  const machineRoot = sourceRootPath && isMacDataVolumeSourceRoot(sourceRootPath);
  const machineDevice = machineRoot
    ? await getMacDataVolumeDeviceId(sourceRootPath)
    : null;
  if ((machineRoot && machineDevice === null) ||
      isSiloAppData(rootPath) || isNonLibraryPath(rootPath) ||
      (sourceRootPath && isMacDataVolumePathExcluded(rootPath, sourceRootPath))) {
    if (onProgress) onProgress(results);
    return results;
  }
  const pendingDirectories = [rootPath];
  const timeMachine = await isTimeMachineDirectory(rootPath);
  if (diagnostics) diagnostics.isTimeMachine = timeMachine;

  let lastProgressEmit = Date.now();
  let lastProgressCount = 0;
  const PROGRESS_BATCH_SIZE = 500;
  const PROGRESS_INTERVAL_MS = 250;

  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.shift()!;
    if (isSiloAppData(directoryPath) || isNonLibraryPath(directoryPath) ||
        (sourceRootPath && isMacDataVolumePathExcluded(directoryPath, sourceRootPath))) continue;
    if (machineDevice !== null) {
      const directoryStats = await fsPromises.stat(directoryPath).catch(() => null);
      if (!directoryStats || directoryStats.dev !== machineDevice) continue;
    }
    let entries;

    try {
      entries = await fsPromises.readdir(directoryPath, {
        withFileTypes: true,
      });
    } catch (error) {
      if (diagnostics) {
        if (isPermissionError(error)) diagnostics.denied += 1;
        else diagnostics.unreadable += 1;
      }
      continue;
    }

    const ENTRY_BATCH_SIZE = 128;
    for (let offset = 0; offset < entries.length; offset += ENTRY_BATCH_SIZE) {
      const entryBatch = entries.slice(offset, offset + ENTRY_BATCH_SIZE);
      const entryResults = await Promise.all(
        entryBatch.map(async (entry) => {
          if (timeMachine && shouldSkipTimeMachineEntry(entry.name))
            return null;
          if (entry.isSymbolicLink()) return null;

          const fullPath = path.join(directoryPath, entry.name);
          if (isSiloAppData(fullPath) || isNonLibraryPath(fullPath) ||
              (sourceRootPath && isMacDataVolumePathExcluded(fullPath, sourceRootPath))) return null;
          try {
            let stats;
            try {
              stats = await fsPromises.stat(fullPath);
            } catch (statError) {
              if (!timeMachine) throw statError;
              stats = await fsPromises.lstat(fullPath);
            }
            if (machineDevice !== null && stats.dev !== machineDevice) return null;

            const isDirectory = entry.isDirectory() || stats.isDirectory();
            const extension = isDirectory
              ? ""
              : path.extname(entry.name).toLowerCase();
            const mimeType = isDirectory ? null : mime.getType(entry.name);
            const type = isDirectory
              ? "folder"
              : classifyFile(entry.name, mimeType);
            const info: FileInfo = {
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
              const metadata = parseTimeMachineFile(
                fullPath,
                stats.size,
                stats.mtimeMs,
                stats.birthtimeMs,
                stats.mode,
              );
              if (metadata) info.backupTimestamp = metadata.backupTimestamp;
            }

            return {
              info,
              directoryPath: isDirectory ? fullPath : null,
              isDirectChild: directoryPath === rootPath,
            };
          } catch (error) {
            if (diagnostics) {
              if (isPermissionError(error)) diagnostics.denied += 1;
              else diagnostics.unreadable += 1;
            }
            return null;
          }
        }),
      );

      for (const result of entryResults) {
        if (!result) continue;
        if (exploded && result.directoryPath)
          pendingDirectories.push(result.directoryPath);
        if (result.isDirectChild || (exploded && !result.info.isDirectory))
          results.push(result.info);
      }

      const now = Date.now();
      if (
        onProgress &&
        (results.length - lastProgressCount >= PROGRESS_BATCH_SIZE ||
          now - lastProgressEmit > PROGRESS_INTERVAL_MS)
      ) {
        onProgress(results);
        lastProgressEmit = now;
        lastProgressCount = results.length;
      }
    }
  }

  // Final progress update with all results
  if (onProgress) onProgress(results);

  // Snapshot folders are far more useful newest-first.
  return timeMachine && !exploded
    ? sortTimeMachineEntriesAsync(results)
    : results;
}

async function readReferencedFiles(filePaths: string[]): Promise<FileInfo[]> {
  const files = await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        if (phoneManager?.isPhonePath(filePath))
          return (await phoneManager.statPhoneFile(
            filePath,
          )) as FileInfo | null;
        if (googleManager?.isCloudPath(filePath))
          return (await googleManager.statCloudFile(
            filePath,
          )) as FileInfo | null;
        const stats = await fsPromises.stat(filePath);
        if (!stats.isFile()) return null;
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
      } catch {
        return null;
      }
    }),
  );
  return files.filter((file): file is FileInfo => file !== null);
}

const ALL_SOURCES_PATH = "/__sources__/all";

type SourceKind = "local" | "machine" | "ios" | "android" | "gdrive" | "gphotos";

interface BrowseSource {
  id: string;
  kind: SourceKind;
  label: string;
  detail: string;
  rootPath: string;
  enabled: boolean;
  available: boolean;
  message: string;
  demoLocked?: boolean;
  lastClonedAt?: number;
  lastCloneDestination?: string;
  offlineBackup?: boolean;
  snapshotAt?: number;
}

/** Local folders, connected phones and Google accounts presented as one list. */
let sourceListCache: BrowseSource[] | null = null;
let sourceListCacheAt = 0;
let sourceListPromise: Promise<BrowseSource[]> | null = null;

function accessDisplayName(): string {
  return fullAccessEnabled() ? "Silo" : "Silo Demo";
}

let applicationMenuInstalled = false;

// Keeps the process name, window title, app menu labels and renderer in step with the license.
function applyAccessBranding(): void {
  const name = accessDisplayName();
  app.setName(name);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(name);
  if (applicationMenuInstalled) installApplicationMenu();
  sendToRenderer("lifetime-access-changed", { fullAccess: fullAccessEnabled(), name });
}

function enableLifetimeFeatures(): void {
  lifetimeLicensed = true;
  lifetimeFullScanPending = true;
  sourceListCache = null;
  sourceListCacheAt = 0;
  sourceListPromise = null;
  applyAccessBranding();
  if (!semanticIndexer) return;
  semanticIndexer.setDemoFileLimit(
    fullAccessEnabled() ? null : DEMO_LIMITS.files,
  );
  if (fullAccessEnabled()) {
    lifetimeFullScanPending = true;
    queueSemanticIndexWork(
      { fullScanAll: true, force: true },
      ALL_INDEX_RECOVERY_STAGES.filter((stage) => stage !== "search"),
    );
    lifetimeFullScanPending = false;
  } else {
    requestIndexRecoveryStages(ALL_INDEX_RECOVERY_STAGES);
  }
}

async function listSources(): Promise<BrowseSource[]> {
  if (sourceListCache && Date.now() - sourceListCacheAt < 1000)
    return sourceListCache.map((source) => ({ ...source }));
  if (sourceListPromise)
    return (await sourceListPromise).map((source) => ({ ...source }));
  const pending = buildSourceList().then((sources) =>
    applyDemoSourceLimit(sources, fullAccessEnabled(), DEMO_LIMITS.sources),
  );
  sourceListPromise = pending;
  try {
    sourceListCache = await pending;
    sourceListCacheAt = Date.now();
    return sourceListCache.map((source) => ({ ...source }));
  } finally {
    sourceListPromise = null;
  }
}

async function buildSourceList(): Promise<BrowseSource[]> {
  const appState = stateStore.getState();
  const disabled = new Set(appState.disabledSourceIds);
  const explicitPhoneChoiceByDevice = new Map<string, string>();
  for (const sourceId of appState.enabledSourceIds ?? []) {
    const parsed = phoneManager.parsePhonePath(sourceId);
    if (parsed)
      explicitPhoneChoiceByDevice.set(
        `${parsed.platform}:${parsed.deviceId}`,
        sourceId,
      );
  }
  const cloneStatus = (await getSourceCloneStatus())!;
  const sources: BrowseSource[] = [];

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
  const latestBackupByDevice = new Map<string, (typeof offlinePhoneBackups)[number]>();
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
      enabled:
        !disabled.has(id) &&
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
    if (existingPhoneRoots.has(backup.rootPath)) continue;
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
      enabled:
        !disabledByUser &&
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

async function readSourceFiles(
  source: BrowseSource,
  exploded: boolean,
  onProgress?: (fileDeltas: FileInfo[], scanned: number, audioFound: number) => void,
): Promise<FileInfo[]> {
  const reportedFiles = new Map<string, { file: FileInfo; signature: string }>();
  const annotate = (file: FileInfo): FileInfo => ({
    ...file,
    sourceId: source.id,
    sourceLabel: source.label,
    ...(source.snapshotAt ? { sourceSnapshotAt: source.snapshotAt } : {}),
  });
  const reportNewFiles = (files: FileInfo[], scanned: number) => {
    if (!onProgress) return;
    const delta: FileInfo[] = [];
    for (const file of files) {
      const previous = reportedFiles.get(file.path);
      if (previous?.file === file) continue;
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
      onProgress(
        delta,
        scanned,
        files.filter((file) => file.type === "audio").length,
      );
  };

  let files: FileInfo[];
  if (phoneManager.isPhonePath(source.rootPath))
    files = (await (exploded
      ? phoneManager.listPhoneFilesRecursively(source.rootPath)
      : phoneManager.listPhoneFiles(source.rootPath, false))) as FileInfo[];
  else if (googleManager.isCloudPath(source.rootPath))
    files = (await googleManager.listFiles(
      source.rootPath,
      exploded,
    )) as FileInfo[];
  else
    files = await readFiles(
      source.rootPath,
      exploded,
      undefined,
      (progressFiles) => reportNewFiles(progressFiles, progressFiles.length),
      source.rootPath,
    );

  reportNewFiles(files, files.length);
  return files.map(annotate);
}

/** The aggregate root lists enabled sources as folders, or discovers each recursive source in parallel. */
async function readAllSources(
  exploded: boolean,
  onProgress?: (
    fileDeltas: FileInfo[],
    scanned: number,
    total: number,
    audioFound: number,
    errors: number,
  ) => void,
): Promise<FileInfo[]> {
  const enabled = (await listSources()).filter(
    (source) => source.enabled && source.available,
  );

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

  const results = new Array<FileInfo[]>(enabled.length);
  const scannedBySource = new Array<number>(enabled.length).fill(0);
  const audioBySource = new Array<number>(enabled.length).fill(0);
  const reportedFiles = new Map<string, string>();
  let nextSource = 0;
  let scanErrors = 0;
  const report = (delta: FileInfo[] = []) => {
    onProgress?.(
      delta,
      scannedBySource.reduce((sum, count) => sum + count, 0),
      0, // A recursive scan cannot know the final total until each source completes.
      audioBySource.reduce((sum, count) => sum + count, 0),
      scanErrors,
    );
  };

  const scanWorker = async () => {
    while (nextSource < enabled.length) {
      const sourceIndex = nextSource++;
      const source = enabled[sourceIndex];
      try {
        results[sourceIndex] = await readSourceFiles(
          source,
          true,
          (sourceDeltas, sourceScanned, sourceAudio) => {
            scannedBySource[sourceIndex] = sourceScanned;
            audioBySource[sourceIndex] = sourceAudio;
            const fresh = sourceDeltas.filter((file) => {
              const signature = JSON.stringify(file);
              if (reportedFiles.get(file.path) === signature) return false;
              reportedFiles.set(file.path, signature);
              return true;
            });
            report(fresh);
          },
        );
        scannedBySource[sourceIndex] = results[sourceIndex].length;
        audioBySource[sourceIndex] = results[sourceIndex].filter(
          (file) => file.type === "audio",
        ).length;
        const finalDeltas = results[sourceIndex].filter((file) => {
          const signature = JSON.stringify(file);
          if (reportedFiles.get(file.path) === signature) return false;
          reportedFiles.set(file.path, signature);
          return true;
        });
        report(finalDeltas);
      } catch (error) {
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

  await Promise.all(
    Array.from(
      { length: Math.min(3, enabled.length) },
      () => scanWorker(),
    ),
  );
  return results.flat();
}

function isRemotePath(candidate: string): boolean {
  return (
    (phoneManager?.isPhonePath(candidate) ?? false) ||
    (googleManager?.isCloudPath(candidate) ?? false)
  );
}

/** Resolves phone and cloud paths to a real local file; passes through local paths. */
async function resolveLocalPath(candidate: string): Promise<string> {
  if (phoneManager?.isPhonePath(candidate))
    return phoneManager.materialize(candidate);
  if (googleManager?.isCloudPath(candidate))
    return googleManager.materialize(candidate);
  return candidate;
}

function cloneSafeSegment(value: string) {
  const safe = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  return safe.slice(0, 100) || "Source";
}

function cloneSafeRelativePath(value: string) {
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`Unsafe source-relative path: ${value}`);
  return path.join(...segments.map(cloneSafeSegment));
}

function sendSourceCloneProgress(progress: SourceCloneProgress) {
  sendToRenderer("source-clone-progress", progress);
}

function ensureCloneActive(operationId: string) {
  if (sourceCloneOperations.get(operationId)?.cancelled)
    throw new Error("Source clone cancelled.");
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function listLocalCloneEntries(
  root: string,
  operationId: string,
  onEntry: (entry: SourceClonePlanEntry) => void,
  options: { allowMarkedRoot?: boolean; skipRootManifest?: boolean } = {},
) {
  const appDataPath = path.resolve(app.getPath("userData"));
  const canonicalAppDataPath = await fsPromises
    .realpath(appDataPath)
    .catch(() => appDataPath);
  const canonicalRootPath = await fsPromises
    .realpath(root)
    .catch(() => path.resolve(root));
  const isSiloAppData = (candidatePath: string) =>
    isAppDataPath(
      candidatePath,
      root,
      canonicalRootPath,
      appDataPath,
      canonicalAppDataPath,
    );
  const machineRoot = isMacDataVolumeSourceRoot(root);
  const machineDevice = machineRoot ? await getMacDataVolumeDeviceId(root) : null;
  if (machineRoot && machineDevice === null)
    throw new Error("Could not verify the internal data-volume boundary; this machine source was not cloned.");
  if (isSiloAppData(root)) return;
  if (!options.allowMarkedRoot && await isSiloCloneDirectory(root)) return;
  const stack = [{ directory: root, relativePath: "" }];
  while (stack.length > 0) {
    ensureCloneActive(operationId);
    const current = stack.pop()!;
    if (isMacDataVolumePathExcluded(current.directory, root)) continue;
    if (machineDevice !== null) {
      const directoryStats = await fsPromises.stat(current.directory).catch(() => null);
      if (!directoryStats || directoryStats.dev !== machineDevice) continue;
    }
    if (isSiloAppData(current.directory)) continue;
    if (!(options.allowMarkedRoot && current.directory === root) &&
      await isSiloCloneDirectory(current.directory)) continue;
    const dir = await fsPromises.opendir(current.directory);
    for await (const entry of dir) {
      ensureCloneActive(operationId);
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current.directory, entry.name);
      if (options.skipRootManifest && current.directory === root && entry.name === "silo-clone-manifest.json") continue;
      if (isMacDataVolumePathExcluded(absolutePath, root)) continue;
      if (isSiloAppData(absolutePath)) continue;
      if (entry.isDirectory() && await isSiloCloneDirectory(absolutePath)) continue;
      const relativePath = path.join(current.relativePath, entry.name);
      const stats = await fsPromises.stat(absolutePath);
      if (machineDevice !== null && stats.dev !== machineDevice) continue;
      if (stats.isDirectory()) {
        onEntry({
          sourcePath: absolutePath,
          destinationRelativePath: relativePath,
          size: 0,
          modified: stats.mtimeMs,
          isDirectory: true,
        });
        stack.push({ directory: absolutePath, relativePath });
      } else if (stats.isFile()) {
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

async function prepareSourceClone(
  sourceIds: string[],
  destinations: string[],
  operationId: string,
  sourceOverrides?: BrowseSource[],
  prepareOptions: {
    includeConfig?: boolean;
    allowMarkedRoot?: boolean;
    skipRootManifest?: boolean;
    prefixSources?: boolean;
    replicaOf?: string;
    replicaSourceManifestPath?: string;
    sourceManifest?: Record<string, unknown>;
  } = {},
) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0)
    throw new Error("Select at least one available source to clone.");
  if (!Array.isArray(destinations) || destinations.length === 0 || destinations.some((item) => typeof item !== "string" || !path.isAbsolute(item)))
    throw new Error("Choose at least one valid destination folder.");
  const uniqueDestinations = Array.from(new Set(destinations));
  const operation = { cancelled: false };
  sourceCloneOperations.set(operationId, operation);
  const available = sourceOverrides ?? await listSources();
  const selected = available.filter((source) =>
    sourceIds.includes(source.id) && source.available,
  );
  if (selected.length !== new Set(sourceIds).size)
    throw new Error("One or more selected sources are no longer available. Refresh sources and try again.");

  const resolvedDestinations: string[] = [];
  for (const destination of uniqueDestinations) {
    await fsPromises.access(destination, fs.constants.R_OK | fs.constants.W_OK);
    const resolved = await fsPromises.realpath(destination);
    for (const source of selected) {
      if (source.kind !== "local" && source.kind !== "machine") continue;
      const sourceResolved = await fsPromises.realpath(source.rootPath);
      const relative = path.relative(sourceResolved, resolved);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
        throw new Error(`Destination cannot be inside selected source “${source.label}”. Choose a different folder.`);
    }
    resolvedDestinations.push(resolved);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destinationPlans: SourceClonePlan["destinations"] = [];
  for (const destination of resolvedDestinations) {
    let cloneRoot = path.join(destination, `Silo Source Clone ${timestamp}`);
    let suffix = 2;
    const taken = async (candidate: string) =>
      (await fsPromises.access(candidate).then(() => true, () => false)) ||
      (await fsPromises.access(`${candidate}${CLONE_ARCHIVE_EXTENSION}`).then(() => true, () => false));
    while (await taken(cloneRoot))
      cloneRoot = path.join(destination, `Silo Source Clone ${timestamp} (${suffix++})`);
    destinationPlans.push({ destination, cloneRoot, freeBytes: 0, shortfallBytes: 0 });
  }

  const entries: SourceClonePlanEntry[] = [];
  const sourcePrefixes = new Map<string, string>();
  let scannedEntries = 0;
  const initial: SourceCloneProgress = {
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
      await exportConfig(
        app.getPath("userData"),
        configArchive,
        app.getVersion(),
        {},
        indexStorageRoot,
      );
      const configStats = await fsPromises.stat(configArchive);
      for (const source of selected) {
        const prefix = sourcePrefixes.get(source.id)!;
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
      for (const alias of prepareOptions.sourceManifest.aliases as Array<Record<string, unknown>>) {
        if (alias.materialized !== false || typeof alias.path !== "string" ||
            typeof alias.canonicalPath !== "string" || typeof alias.sha256 !== "string" ||
            presentPaths.has(alias.path)) continue;
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
    if (files.length === 0) throw new Error("The selected sources contain no files to clone.");
    const canonicalByDigest = new Map<string, SourceClonePlanEntry>();
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
      } else {
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

    const destinationDevices = new Map<string, { freeBytes: number; count: number }>();
    const destinationDeviceByPath = new Map<string, string>();
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
      const group = destinationDevices.get(destinationDeviceByPath.get(destination.destination)!)!;
      destination.shortfallBytes = Math.max(0, totalBytes * group.count - group.freeBytes);
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const plan: SourceClonePlan = { id, operationId, destinations: destinationPlans,
      entries, totalFiles: uniqueFiles.length, totalBytes, duplicateFiles,
      sourceLabels: selected.map((source) => source.label), sourceIds: selected.map((source) => source.id), configDirectory,
      replicaOf: prepareOptions.replicaOf,
      sourceManifest: prepareOptions.sourceManifest };
    sourceClonePlans.set(id, plan);
    return { planId: id, destinations: destinationPlans, totalSources: selected.length,
      sourceLabels: plan.sourceLabels, totalFiles: uniqueFiles.length, totalBytes, duplicateFiles };
  } catch (error) {
    await fsPromises.rm(configDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function findLatestShelterSnapshot(): Promise<{
  rootPath: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
} | null> {
  const destination = await getShelterDestination();
  if (!destination) return null;
  const root = await fsPromises.realpath(destination).catch(() => null);
  if (!root) return null;
  const entries = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{
    rootPath: string;
    manifestPath: string;
    manifest: Record<string, unknown>;
    createdAt: number;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const snapshotPath = path.join(root, entry.name);
    const manifestPath = path.join(snapshotPath, "silo-clone-manifest.json");
    try {
      const manifest = JSON.parse(await fsPromises.readFile(manifestPath, "utf8")) as Record<string, unknown>;
      if (manifest.format !== "silo-source-clone" || manifest.version !== 1 || manifest.complete !== true)
        continue;
      const stats = await fsPromises.stat(snapshotPath);
      const createdAt = typeof manifest.createdAt === "string" ? Date.parse(manifest.createdAt) : 0;
      candidates.push({ rootPath: snapshotPath, manifestPath, manifest,
        createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : stats.mtimeMs });
    } catch {
      // Ignore incomplete, unreadable, or non-Silo directories.
    }
  }
  candidates.sort((first, second) => second.createdAt - first.createdAt);
  const latest = candidates[0];
  return latest ? { rootPath: latest.rootPath, manifestPath: latest.manifestPath, manifest: latest.manifest } : null;
}

async function prepareShelterReplica(destinations: string[], operationId: string) {
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
  const source: BrowseSource = {
    id: `shelter-replica:${snapshot.rootPath}`,
    kind: "local",
    label: "Fallout Shelter snapshot",
    detail: "Latest fully verified shelter snapshot",
    rootPath: snapshot.rootPath,
    enabled: true,
    available: true,
    message: "",
  };
  return prepareSourceClone(
    [source.id],
    destinations,
    operationId,
    [source],
    {
      includeConfig: false,
      allowMarkedRoot: true,
      skipRootManifest: true,
      prefixSources: false,
      replicaOf: snapshot.rootPath,
      replicaSourceManifestPath: snapshot.manifestPath,
      sourceManifest: snapshot.manifest,
    },
  );
}

async function runSourceClone(
  planId: string,
  runOptions: { compress?: boolean } = {},
): Promise<void> {
  const plan = sourceClonePlans.get(planId);
  if (!plan)
    throw new Error("Clone plan expired. Prepare the source clone again.");
  const { operationId } = plan;
  const operation = sourceCloneOperations.get(operationId);
  if (!operation) throw new Error("Clone operation expired.");
  if (plan.destinations.some((destination) => destination.shortfallBytes > 0))
    throw new Error(
      "One or more selected destinations do not have enough free space.",
    );

  const successfulDestinations: string[] = [];
  const fingerprints = new Map<string, InventoryFingerprint>();
  const sourceFileCounts = new Map<string, number>();
  for (const entry of plan.entries) {
    if (entry.isDirectory || !entry.sourceId) continue;
    sourceFileCounts.set(entry.sourceId, (sourceFileCounts.get(entry.sourceId) ?? 0) + 1);
    let fingerprint = fingerprints.get(entry.sourceId);
    if (!fingerprint) {
      fingerprint = new InventoryFingerprint();
      fingerprints.set(entry.sourceId, fingerprint);
    }
    fingerprint.add(
      entry.sourceRelativePath ?? entry.destinationRelativePath,
      Number.isFinite(entry.sourceSize) && (entry.sourceSize ?? -1) >= 0
        ? entry.sourceSize!
        : 0,
      Number.isFinite(entry.sourceModified) ? entry.sourceModified! : 0,
    );
  }
  const persistVerifiedDestinations = async () => {
    if (successfulDestinations.length === 0) return;
    const lastClonedAt = Date.now();
    const history = (await getSourceCloneStatus())!;
    const update: Record<string, SourceCloneStatusRecord> = {};
    for (const sourceId of plan.sourceIds) {
      const previousRecord = history[sourceId];
      const previous = previousRecord?.destinations ?? [];
      const sourceFingerprint = fingerprints.get(sourceId)?.finish() ?? new InventoryFingerprint().finish();
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
      const manifestFiles: Array<{ path: string; size: number; sha256?: string; modified?: number; sourceId?: string; sourceRelativePath?: string; error?: string }> = [];
      const manifestAliases: Array<{ path: string; canonicalPath: string; size: number; sha256: string; sourceId?: string; sourceRelativePath?: string; materialized: boolean }> = [];
      const emit = (phase: SourceClonePhase, currentFile: string, message: string, force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < 350) return;
        lastProgressAt = now;
        sendSourceCloneProgress({ operationId, phase, destination: destinationPlan.cloneRoot,
          totalSources: plan.sourceLabels.length, totalFiles: plan.totalFiles, completedFiles,
          totalBytes: plan.totalBytes, copiedBytes, verifiedFiles, failedFiles, currentFile,
          message: `Destination ${destinationIndex + 1} of ${plan.destinations.length}: ${message}` });
      };
      if (runOptions.compress) {
        const archivePath = `${destinationPlan.cloneRoot}${CLONE_ARCHIVE_EXTENSION}`;
        try {
          const uniqueEntries = plan.entries.filter((item) => !item.isDirectory && !item.duplicateOf);
          for (const entry of uniqueEntries) {
            if (!entry.localPath || !entry.sha256) throw new Error(`Missing staged file for ${entry.sourcePath}`);
            manifestFiles.push({ path: entry.destinationRelativePath, size: entry.size, sha256: entry.sha256,
              modified: entry.modified, sourceId: entry.sourceId, sourceRelativePath: entry.sourceRelativePath });
          }
          for (const entry of plan.entries.filter((item) => !item.isDirectory && item.duplicateOf))
            manifestAliases.push({ path: entry.destinationRelativePath, canonicalPath: entry.duplicateOf!,
              size: entry.size, sha256: entry.sha256!, sourceId: entry.sourceId,
              sourceRelativePath: entry.sourceRelativePath, materialized: false });
          const sourceManifest = plan.sourceManifest;
          const result = await writeCloneArchive({
            archivePath,
            files: uniqueEntries.map((entry) => ({ localPath: entry.localPath!, archivePath: entry.destinationRelativePath,
              size: entry.size, modified: entry.modified, sha256: entry.sha256! })),
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
              } else {
                verifiedFiles = progress.processedFiles;
                emit("verifying", progress.currentFile,
                  `Verifying archive · ${verifiedFiles.toLocaleString()} of ${plan.totalFiles.toLocaleString()} files`);
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
        } catch (error) {
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
        const inProgressMarker = path.join(
          destinationPlan.cloneRoot,
          ".silo-clone-in-progress.json",
        );
        await fsPromises.writeFile(
          inProgressMarker,
          JSON.stringify({ format: "silo-source-clone", version: 1, startedAt: new Date().toISOString() }),
          { mode: 0o600, flag: "wx" },
        );
        invalidateSiloCloneDirectoryCache(destinationPlan.cloneRoot);
        for (const entry of plan.entries.filter((item) => item.isDirectory)) {
          ensureCloneActive(operationId);
          const directory = path.resolve(destinationPlan.cloneRoot, entry.destinationRelativePath);
          if (!directory.startsWith(`${destinationPlan.cloneRoot}${path.sep}`)) throw new Error("Unsafe clone directory path.");
          await fsPromises.mkdir(directory, { recursive: true });
        }
        for (const entry of plan.entries.filter((item) => !item.isDirectory && !item.duplicateOf)) {
          ensureCloneActive(operationId);
          const sourcePath = entry.localPath;
          if (!sourcePath) throw new Error(`Missing staged file for ${entry.sourcePath}`);
          const destinationPath = path.resolve(destinationPlan.cloneRoot, entry.destinationRelativePath);
          if (!destinationPath.startsWith(`${destinationPlan.cloneRoot}${path.sep}`)) throw new Error("Unsafe clone file path.");
          await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
          const partialPath = `${destinationPath}.silo-partial`;
          const sourceHash = createHash("sha256");
          const inputStats = await fsPromises.stat(sourcePath);
          if (inputStats.size !== entry.size || inputStats.mtimeMs !== entry.modified)
            throw new Error(`Source changed after preflight: ${entry.destinationRelativePath}`);
          const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
              try {
                ensureCloneActive(operationId);
                sourceHash.update(chunk);
                copiedBytes += chunk.length;
                emit("copying", entry.destinationRelativePath, `Copying ${entry.destinationRelativePath}`);
                callback(null, chunk);
              } catch (error) { callback(error as Error); }
            },
          });
          try {
            await pipeline(fs.createReadStream(sourcePath), meter, fs.createWriteStream(partialPath, { flags: "wx" }));
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
          } catch (error) {
            await fsPromises.rm(partialPath, { force: true }).catch(() => undefined);
            failedFiles += 1;
            manifestFiles.push({ path: entry.destinationRelativePath, size: entry.size,
              error: error instanceof Error ? error.message : String(error) });
            if (operation.cancelled) throw error;
          }
        }
        for (const record of manifestFiles) {
          ensureCloneActive(operationId);
          if (!record.sha256) continue;
          const copiedHash = await hashFile(path.join(destinationPlan.cloneRoot, record.path));
          if (copiedHash !== record.sha256) {
            record.error = "SHA-256 mismatch during verification.";
            record.sha256 = undefined;
            failedFiles += 1;
          } else verifiedFiles += 1;
          emit("verifying", record.path, `Verified ${verifiedFiles.toLocaleString()} of ${plan.totalFiles.toLocaleString()} files`);
        }
        const hardLinkFallbackCodes = new Set(["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES", "EMLINK"]);
        for (const entry of plan.entries.filter((item) => !item.isDirectory && item.duplicateOf)) {
          ensureCloneActive(operationId);
          const sourceStats = await fsPromises.stat(entry.localPath!);
          if (sourceStats.size !== entry.size || sourceStats.mtimeMs !== entry.modified)
            throw new Error(`Duplicate source changed after hash preflight: ${entry.destinationRelativePath}`);
          const canonicalPath = path.resolve(destinationPlan.cloneRoot, entry.duplicateOf!);
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
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !hardLinkFallbackCodes.has(code)) throw error;
          }
          manifestAliases.push({
            path: entry.destinationRelativePath,
            canonicalPath: entry.duplicateOf!,
            size: entry.size,
            sha256: entry.sha256!,
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
        invalidateSiloCloneDirectoryCache(destinationPlan.cloneRoot);
        await fsPromises.rm(inProgressMarker, { force: true });
        emit(complete ? "complete" : "error", "", complete
          ? `Clone complete. Verified ${verifiedFiles.toLocaleString()} files with SHA-256, including Silo config/indexes.`
          : `Clone finished with ${failedFiles.toLocaleString()} file error(s). Originals were not changed.`, true);
        if (!complete) throw new Error(`Verification failed for destination ${destinationPlan.destination}.`);
        successfulDestinations.push(destinationPlan.cloneRoot);
      } catch (error) {
        const cancelled = operation.cancelled;
        emit(cancelled ? "cancelled" : "error", "", cancelled
          ? `Clone cancelled after ${completedFiles.toLocaleString()} files. Originals were not changed.`
          : error instanceof Error ? error.message : String(error), true);
        throw error;
      }
    }
    await persistVerifiedDestinations();
  } catch (error) {
    try {
      await persistVerifiedDestinations();
    } catch (persistError) {
      runtimeLog("source-clone-status-persist-error", {
        message: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
    if (!operation.cancelled) throw error;
  } finally {
    sourceClonePlans.delete(planId);
    sourceCloneOperations.delete(operationId);
    await fsPromises.rm(plan.configDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function getFfmpegPath(): string {
  if (!ffmpegStaticPath) throw new Error("Bundled FFmpeg is unavailable.");
  return app.isPackaged
    ? ffmpegStaticPath.replace("app.asar", "app.asar.unpacked")
    : ffmpegStaticPath;
}

async function getPlayableVideoPath(
  originalPath: string,
  localPath: string,
  size: number,
  modified: number,
): Promise<{ path: string; transcoded: boolean }> {
  const extension = path.extname(originalPath).toLowerCase();
  if (directlyPlayableVideoExtensions.has(extension)) {
    return { path: localPath, transcoded: false };
  }

  const cacheDirectory = indexStoragePath("media-cache");
  const cacheKey = createHash("sha1")
    .update(`${originalPath}:${size}:${modified}`)
    .digest("hex");
  const outputPath = path.join(cacheDirectory, `${cacheKey}.mp4`);
  try {
    if ((await fsPromises.stat(outputPath)).size > 0)
      return { path: outputPath, transcoded: true };
  } catch {
    // Cache miss.
  }

  let conversion = mediaConversionJobs.get(outputPath);
  if (!conversion) {
    conversion = (async () => {
      await fsPromises.mkdir(cacheDirectory, { recursive: true });
      const temporaryPath = `${outputPath}.partial`;
      try {
        await execFileAsync(
          getFfmpegPath(),
          [
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
          ],
          { maxBuffer: 10 * 1024 * 1024 },
        );
        await fsPromises.rename(temporaryPath, outputPath);
        return outputPath;
      } finally {
        await fsPromises.rm(temporaryPath, { force: true });
      }
    })().finally(() => mediaConversionJobs.delete(outputPath));
    mediaConversionJobs.set(outputPath, conversion);
  }
  return { path: await conversion, transcoded: true };
}

function getPreloadPath(): string {
  return path.join(app.getAppPath(), "public", "preload.js");
}

async function createWindow() {
  const preloadPath = getPreloadPath();

  mainWindow = new BrowserWindow({
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
    if (
      url.startsWith(
        "https://github.com/ilovespectra/silo-downloads/releases/download/",
      ) ||
      url.startsWith(
        "https://github.com/ilovespectra/silo-downloads/releases/tag/",
      )
    )
      void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("destroyed", () =>
    inventoryTransfers.releaseOwner(inventoryOwner),
  );
  mainWindow.webContents.on(
    "did-start-navigation",
    (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) inventoryTransfers.releaseOwner(inventoryOwner);
    },
  );

  const startUrl = isDev
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
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      runtimeLog("renderer-load-failed", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    },
  );
  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      if (level >= 2)
        runtimeLog("renderer-console-error", {
          message,
          line,
          source: sourceId,
        });
    },
  );
  mainWindow.webContents.on("dom-ready", () =>
    runtimeLog("renderer-dom-ready"),
  );
  mainWindow.webContents.on("unresponsive", () => {
    console.log("[RENDERER-LOAD] unresponsive event fired");
    runtimeLog("renderer-unresponsive");
  });
  mainWindow.webContents.on("responsive", () =>
    runtimeLog("renderer-responsive"),
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    runtimeLog("render-process-gone", { ...details });
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    rendererReady = false;
    inventoryTransfers.releaseOwner(window.webContents.id);
    const plan = rendererRecovery.plan(details.reason, shuttingDown);
    if (plan.restart) {
      if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
      runtimeLog("renderer-recovery-scheduled", {
        reason: details.reason,
        delayMs: plan.delay,
      });
      rendererRecoveryTimer = setTimeout(() => {
        rendererRecoveryTimer = null;
        if (!shuttingDown && !window.isDestroyed()) window.webContents.reload();
      }, plan.delay);
    } else if (plan.manual && !shuttingDown) {
      void dialog
        .showMessageBox(window, {
          type: "warning",
          title: "Silo interface stopped",
          message: "The interface crashed repeatedly or ran out of memory.",
          detail:
            "Index data and original files have not been reset. Automatic reloads stopped to prevent a crash loop.",
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

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function sourceIncludesSiloAppData(sourcePath: string): Promise<boolean> {
  if (isRemotePath(sourcePath)) return false;
  const appDataPath = path.resolve(app.getPath("userData"));
  const canonicalAppDataPath = await fsPromises
    .realpath(appDataPath)
    .catch(() => appDataPath);
  const canonicalSourcePath = await fsPromises
    .realpath(sourcePath)
    .catch(() => path.resolve(sourcePath));
  return (
    isAppDataPath(
      sourcePath,
      sourcePath,
      canonicalSourcePath,
      appDataPath,
      canonicalAppDataPath,
    ) ||
    isPathWithin(appDataPath, sourcePath) ||
    isPathWithin(canonicalAppDataPath, canonicalSourcePath)
  );
}

async function isSiloAppDataRoot(sourcePath: string): Promise<boolean> {
  if (isRemotePath(sourcePath)) return false;
  const appDataPath = path.resolve(app.getPath("userData"));
  const canonicalAppDataPath = await fsPromises
    .realpath(appDataPath)
    .catch(() => appDataPath);
  const canonicalSourcePath = await fsPromises
    .realpath(sourcePath)
    .catch(() => path.resolve(sourcePath));
  return isAppDataPath(
    sourcePath,
    sourcePath,
    canonicalSourcePath,
    appDataPath,
    canonicalAppDataPath,
  );
}

/** Background coverage ignores result-visibility checkboxes. Keep configured
 * local roots even when offline; scanners handle accessibility. Remote roots
 * require a ready device / authorized account. Never update the visibility cache.
 */
async function getAllIndexSources(): Promise<string[]> {
  return getIndexableRootsFromSources(await listSources());
}

async function getIndexableRootsFromSources(
  sources: BrowseSource[],
): Promise<string[]> {
  const candidates = sources.filter(
    (source) =>
      source.available &&
      source.rootPath.trim() &&
      (fullAccessEnabled() || (source.enabled && !source.demoLocked)) &&
      (!source.offlineBackup || source.enabled),
  );
  const enabledBackupDevices = new Set<string>();
  for (const source of sources) {
    if (!source.offlineBackup || !source.enabled) continue;
    const parsed = phoneManager?.parsePhonePath(source.rootPath);
    if (parsed)
      enabledBackupDevices.add(`${parsed.platform}:${parsed.deviceId}`);
  }
  const safeRoots: string[] = [];
  for (const source of candidates) {
    if (!(await isSiloAppDataRoot(source.rootPath)))
      safeRoots.push(source.rootPath);
  }
  // Keep live phone roots out when their local copy is already under an indexed
  // folder. Saved copies retain separate virtual roots for source-level filtering.
  const localRoots = safeRoots.filter((root) => !root.startsWith("/__"));
  const covered = (root: string) => {
    const phonePath = phoneManager?.parsePhonePath(root);
    if (!phonePath || phonePath.offlineBackup) return false;
    const { platform, deviceId } = phonePath;
    if (enabledBackupDevices.has(`${platform}:${deviceId}`)) return true;
    const backupRoot = phoneManager?.getBackupRoot?.(platform, deviceId);
    return Boolean(backupRoot && localRoots.some((local) => isPathWithin(backupRoot, local)));
  };
  return Array.from(
    new Set(safeRoots.filter((root) => !covered(root))),
  );
}

async function getEnabledIndexSources(): Promise<string[]> {
  // Selected roots are used only to filter browse/search/map/people results.
  const uniquePaths = Array.from(new Set((await listSources())
    .filter((source) => source.enabled && source.available && source.rootPath.trim())
    .map((source) => source.rootPath)));
  enabledSourcePathCache = new Set(uniquePaths);
  enabledSourceCacheReady = true;
  console.log("[getEnabledIndexSources] Found sources:", uniquePaths);
  return uniquePaths;
}

async function getDemoSourceCount(): Promise<number> {
  const roots = new Set(
    (await listSources())
      .filter(
        (source) =>
          source.enabled &&
          source.available &&
          source.rootPath.trim() &&
          !source.demoLocked,
      )
      .map((source) => source.rootPath),
  );
  return roots.size;
}

function fileIsInEnabledSource(
  filePath: string,
  sourcePaths: ReadonlySet<string> = enabledSourcePathCache,
) {
  for (const sourcePath of sourcePaths) {
    const prefix = sourcePath.endsWith(path.sep)
      ? sourcePath
      : `${sourcePath}${path.sep}`;
    if (filePath === sourcePath || filePath.startsWith(prefix)) return true;
  }
  return false;
}

function filterForEnabledSources<T extends { path: string }>(
  files: T[],
  sourcePaths: ReadonlySet<string> = enabledSourcePathCache,
) {
  return files.filter((file) => fileIsInEnabledSource(file.path, sourcePaths));
}

async function indexNewSources(sourcePaths: string[], reason: string) {
  const activeSources = await getAllIndexSources();
  const added = sourcePaths.filter((sourcePath) =>
    activeSources.includes(sourcePath),
  );
  if (added.length === 0) return;
  await semanticIndexer.startWatching(activeSources);
  runtimeLog("auto-index-new-sources", { reason, sources: added });
  queueSemanticIndexWork(
    { fullScanRoots: added },
    ["faces", "locations", "duplicates", "pets", "thumbnails", "audio", "quality"],
  );
}

async function createUnifiedScanSource() {
  const appDataPath = path.resolve(app.getPath("userData"));
  const canonicalAppDataPath = await fsPromises
    .realpath(appDataPath)
    .catch(() => appDataPath);
  return async (
    sourcePath: string,
    onFile: (file: any) => void,
    isCancelled: () => boolean,
  ): Promise<void> => {
    // Detect source type and delegate to appropriate scanner
    if (phoneManager.isPhonePath(sourcePath)) {
      await phoneManager.listPhoneFilesRecursively(
        sourcePath,
        onFile,
        isCancelled,
      );
      return;
    }

    if (sourcePath.startsWith("/__cloud__/")) {
      // Cloud source: /__cloud__/gdrive/<accountId> or /__cloud__/gphotos/<accountId>
      const cloudType = sourcePath.slice("/__cloud__/".length).split("/")[0];
      const files = await googleManager.listFilesRecursively(
        sourcePath,
        onFile,
        isCancelled,
      );
      for (const file of files) {
        if (isCancelled()) return;
        onFile(file);
      }
      return;
    }

    // Local filesystem source
    const canonicalSourcePath = await fsPromises
      .realpath(sourcePath)
      .catch(() => path.resolve(sourcePath));
    const machineRoot = isMacDataVolumeSourceRoot(sourcePath);
    const machineDevice = machineRoot
      ? await getMacDataVolumeDeviceId(sourcePath)
      : null;
    if (machineRoot && machineDevice === null) return;
    const isSiloAppData = (candidatePath: string) =>
      isAppDataPath(
        candidatePath,
        sourcePath,
        canonicalSourcePath,
        appDataPath,
        canonicalAppDataPath,
      );
    // A user may add a broad parent such as Home or an external volume. Never
    // treat Silo's private storage as source material; phone snapshots remain
    // indexable via the virtual /__phone__ scanner above.
    if (isSiloAppData(sourcePath) || isNonLibraryPath(sourcePath)) return;
    if (await isSiloCloneDirectory(sourcePath)) return;
    const results: any[] = [];
    const pendingDirectories = [sourcePath];
    const timeMachine = await isTimeMachineDirectory(sourcePath);

    while (pendingDirectories.length > 0 && !isCancelled()) {
      const directoryPath = pendingDirectories.shift()!;
      if (isMacDataVolumePathExcluded(directoryPath, sourcePath)) continue;
      if (machineDevice !== null) {
        const directoryStats = await fsPromises.stat(directoryPath).catch(() => null);
        if (!directoryStats || directoryStats.dev !== machineDevice) continue;
      }
      if (isSiloAppData(directoryPath)) continue;
      if (await isSiloCloneDirectory(directoryPath)) continue;
      let entries;

      try {
        entries = await fsPromises.readdir(directoryPath, {
          withFileTypes: true,
        });
      } catch {
        continue;
      }

      const ENTRY_BATCH_SIZE = 128;
      let processedEntries = 0;
      for (let offset = 0; offset < entries.length; offset += ENTRY_BATCH_SIZE) {
        const entryResults = await Promise.all(
          entries.slice(offset, offset + ENTRY_BATCH_SIZE).map(async (entry) => {
          if (timeMachine && shouldSkipTimeMachineEntry(entry.name))
            return null;
          if (entry.isSymbolicLink()) return null;

          const fullPath = path.join(directoryPath, entry.name);
          if (isMacDataVolumePathExcluded(fullPath, sourcePath)) return null;
          if (isSiloAppData(fullPath)) return null;
          try {
            let stats;
            try {
              stats = await fsPromises.stat(fullPath);
            } catch {
              if (!timeMachine) throw new Error("stat failed");
              stats = await fsPromises.lstat(fullPath);
            }
            if (machineDevice !== null && stats.dev !== machineDevice) return null;

            const isDirectory = entry.isDirectory() || stats.isDirectory();
            if (isDirectory && await isSiloCloneDirectory(fullPath)) return null;
            if (isDirectory && isNonLibraryPath(fullPath)) return null;
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
          } catch {
            return null;
          }
          }),
        );

        for (const result of entryResults) {
          processedEntries += 1;
          if (!result) continue;
          if (isCancelled()) return;
          onFile(result.file);
          if (result.directoryPath) {
            pendingDirectories.push(result.directoryPath);
          }
          if (processedEntries % 256 === 0)
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
  };
}

async function cleanupOldCaches() {
  console.log("[STARTUP] Cleaning up old caches and logs...");
  const userData = app.getPath("userData");
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
      console.log(
        `[STARTUP] Runtime log is ${(stats.size / 1024 / 1024).toFixed(1)}MB, rotating...`,
      );
      const archivePath = path.join(
        diagnosticsDir,
        `runtime-archive-${Date.now()}.jsonl`,
      );
      await fsPromises
        .rename(path.join(diagnosticsDir, "runtime.jsonl"), archivePath)
        .catch(() => {});
    }
  } catch (error) {
    console.log(
      "[STARTUP] Error cleaning runtime logs:",
      error instanceof Error ? error.message : error,
    );
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
      } catch {
        // Skip on error
      }
    }
    if (removed > 0)
      console.log(`[STARTUP] Removed ${removed} old thumbnail cache files`);
  } catch (error) {
    console.log(
      "[STARTUP] Error cleaning thumbnail cache:",
      error instanceof Error ? error.message : error,
    );
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
      } catch {
        // Skip on error
      }
    }
    if (removed > 0)
      console.log(`[STARTUP] Removed ${removed} old media cache files`);
  } catch (error) {
    console.log(
      "[STARTUP] Error cleaning media cache:",
      error instanceof Error ? error.message : error,
    );
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
          .catch(() => {});
      }
      console.log(
        `[STARTUP] Cleaned up ${archives.length - 2} old archive logs`,
      );
    }
  } catch (error) {
    console.log(
      "[STARTUP] Error cleaning archives:",
      error instanceof Error ? error.message : error,
    );
  }

  console.log("[STARTUP] Cache cleanup complete");
}

// Schedule periodic cache cleanup (every 6 hours while app is running)
function schedulePeriodicCleanup() {
  setInterval(
    async () => {
      try {
        await cleanupOldCaches();
      } catch (error) {
        console.error("[CLEANUP] Periodic cleanup failed:", error);
      }
    },
    6 * 60 * 60 * 1000,
  ); // 6 hours
}

/** Standard menus, except Undo/Redo go to the renderer so they can undo People edits outside text fields. */
function getIndexStorageDestinationLabel() {
  return path.basename(path.resolve(selectedIndexStorageRoot)) || "selected destination";
}

function currentIndexStorageStatus(): MainIndexStorageStatus {
  return {
    message: indexStorageMessageText,
    usingLocalFallback: indexStorageUsingLocalFallback,
    localFallbackEnabled: indexStorageFallbackEnabled,
    destinationAvailable: indexStorageDestinationAvailable,
    selectedDestination: selectedIndexStorageRoot,
    localFreeBytes: indexStorageFreeBytes,
    reserveBytes: LOCAL_INDEX_STORAGE_RESERVE_BYTES,
    transfer: indexStorageTransfer,
  };
}

function publishIndexStorageStatus(message?: string | null) {
  if (message !== undefined) indexStorageMessageText = message;
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
  const userDataPath = path.resolve(app.getPath("userData"));
  if (path.resolve(selectedIndexStorageRoot) === userDataPath) return true;
  try {
    const [selectedStats, userDataStats] = await Promise.all([
      fsPromises.stat(selectedIndexStorageRoot),
      fsPromises.stat(userDataPath),
    ]);
    if (selectedStats.dev === userDataStats.dev) return false;
    await fsPromises.access(
      selectedIndexStorageRoot,
      fs.constants.R_OK | fs.constants.W_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function withIndexStorageCacheWrite<T>(operation: () => Promise<T>): Promise<T> {
  if (!indexStorageAvailable)
    throw new Error(indexStorageUnavailableMessage ?? "Index storage is unavailable.");
  const activeRootIsAppData =
    path.resolve(indexStorageRoot) === path.resolve(app.getPath("userData"));
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
    indexStorageFreeBytes = await getLocalIndexStorageFreeBytes(indexStorageRoot).catch(() => null);
    if (
      indexStorageFreeBytes === null ||
      indexStorageFreeBytes < LOCAL_INDEX_STORAGE_RESERVE_BYTES
    ) {
      void monitorIndexStorageAvailability();
      throw new Error(
        `Local cache indexing is paused to preserve at least ${Math.round(LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB of free space.`,
      );
    }
  }
  if (!indexStorageAvailable)
    throw new Error(indexStorageUnavailableMessage ?? "Index storage is unavailable.");
  activeIndexStorageCacheWrites += 1;
  try {
    return await operation();
  } finally {
    activeIndexStorageCacheWrites = Math.max(0, activeIndexStorageCacheWrites - 1);
  }
}

function isBusyIndexStatus(status: string) {
  return ["scanning", "indexing", "loading-model", "clustering", "generating"].includes(status);
}

function indexStorageWritersBusy() {
  return Boolean(
    (semanticIndexer && isBusyIndexStatus(semanticIndexer.getProgress().status)) ||
    (faceIndexer && isBusyIndexStatus(faceIndexer.getProgress().status)) ||
    (geoIndexer && isBusyIndexStatus(geoIndexer.getStatus().status)) ||
    (duplicateManager && duplicateManager.getState().status === "scanning") ||
    (petIndexer && isBusyIndexStatus(petIndexer.getProgress().status)) ||
    audioInventoryRunning ||
    (thumbnailPregenerator && ["scanning", "generating"].includes(thumbnailPregenerator.getProgress().status)) ||
    magicLibraryProgress.running ||
    activeIndexStorageCacheWrites > 0 ||
    Boolean(libraryStatsManager?.getSnapshot().running)
  );
}

async function waitForIndexStorageWritersToPause() {
  const deadline = Date.now() + 60_000;
  while (indexStorageWritersBusy()) {
    if (Date.now() >= deadline)
      throw new Error("Indexing did not pause in time; the local cache was preserved.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function pauseIndexingForStorage(message: string) {
  indexStorageAvailable = false;
  indexStorageUnavailableMessage = message;
  publishIndexStorageStatus(message);
  aestheticScorer?.setBackgroundPaused(true);
  if (indexStorageInitializationDeferred) {
    await indexRecovery?.setBlocked(message);
    return;
  }
  if (semanticIndexer) await semanticIndexer.setHold(message);
  await indexRecovery?.setBlocked(message);
  await Promise.allSettled([
    faceIndexer?.pause(),
    geoIndexer?.pause(),
    duplicateManager?.pause(),
    petIndexer?.pause(),
  ].filter(Boolean) as Promise<unknown>[]);
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
    queueSemanticIndexWork({ resumeRoots: resumeSources, force: true });
  publishIndexStorageStatus(indexStorageUsingLocalFallback
    ? `The selected destination is still unavailable. Silo is using the local cache and keeping at least ${Math.round(LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free.`
    : null);
}

function scheduleIndexStorageRelaunch() {
  if (indexStorageRelaunchPending) return;
  indexStorageRelaunchPending = true;
  setTimeout(() => {
    app.relaunch();
    app.quit();
  }, 3500);
}

async function prepareStorageTransition(reason: "fallback" | "destination") {
  if (indexStorageTransferRunning || indexStorageRelaunchPending) return;
  if (Date.now() < indexStorageTransferRetryAt) return;
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
    const userDataPath = app.getPath("userData");
    const storage = await prepareConfiguredIndexStorage(
      userDataPath,
      (filesVerified, bytesVerified) => {
        indexStorageTransfer = {
          state: "moving",
          message: `Verifying cache transfer: ${filesVerified.toLocaleString()} files and ${(bytesVerified / 1024 / 1024 / 1024).toFixed(2)} GiB checked.`,
          filesVerified,
          bytesVerified,
        };
        publishIndexStorageStatus();
      },
    );
    if (storage.migrationError || (!storage.destinationAvailable && !storage.usingLocalFallback))
      throw new Error(storage.migrationError || "The selected cache destination is still unavailable.");

    indexStorageRoot = storage.storageRoot;
    selectedIndexStorageRoot = storage.selectedStorageRoot;
    indexStorageUsingLocalFallback = storage.usingLocalFallback;
    indexStorageFallbackEnabled = storage.localFallbackEnabled;
    indexStorageDestinationAvailable = storage.destinationAvailable;
    setActiveIndexStorageRoot(indexStorageRoot);
    if (storage.usingLocalFallback) {
      indexStorageFreeBytes = await getLocalIndexStorageFreeBytes(indexStorageRoot);
      await assertLocalIndexStorageCapacity(indexStorageRoot);
    } else {
      indexStorageFreeBytes = null;
    }
    if (storage.destinationAvailable) {
      const stats = await fsPromises.stat(indexStorageRoot);
      indexStorageDeviceId = stats.dev;
    } else {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    indexStorageTransfer = {
      state: "error",
      message: `Cache transfer paused. Silo preserved the existing cache. ${message}`,
      filesVerified: indexStorageTransfer.filesVerified,
      bytesVerified: indexStorageTransfer.bytesVerified,
    };
    indexStorageTransferRetryAt = Date.now() + 15_000;
    const fallbackCanResume =
      indexStorageUsingLocalFallback &&
      indexStorageFallbackEnabled &&
      indexStorageRoot;
    if (fallbackCanResume) {
      indexStorageFreeBytes = await getLocalIndexStorageFreeBytes(indexStorageRoot).catch(() => null);
      if (indexStorageFreeBytes !== null && indexStorageFreeBytes >= LOCAL_INDEX_STORAGE_RESERVE_BYTES)
        await resumeIndexingAfterStorage();
    }
    publishIndexStorageStatus(indexStorageTransfer.message);
    runtimeLog("index-storage-transfer-failed", { message });
  } finally {
    indexStorageTransferRunning = false;
  }
}

async function monitorIndexStorageAvailability() {
  if (indexStorageMonitorRunning || indexStorageTransferRunning || indexStorageRelaunchPending)
    return;
  indexStorageMonitorRunning = true;
  try {
    const externalDestination =
      path.resolve(selectedIndexStorageRoot) !== path.resolve(app.getPath("userData"));
    const destinationAvailable = await checkSelectedIndexStorageAvailable();
    indexStorageDestinationAvailable = destinationAvailable;

    if (!externalDestination) {
      indexStorageUsingLocalFallback = false;
      indexStorageFreeBytes = null;
      if (!indexStorageAvailable) await resumeIndexingAfterStorage();
      else publishIndexStorageStatus(null);
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
      indexStorageFreeBytes = await getLocalIndexStorageFreeBytes(indexStorageRoot).catch(() => null);
      if (!indexStorageFallbackEnabled) {
        const message = `The selected destination, ${getIndexStorageDestinationLabel()}, is unavailable. Local fallback is off, so indexing is paused until it reconnects.`;
        if (indexStorageAvailable || indexStorageUnavailableMessage !== message)
          await pauseIndexingForStorage(message);
        publishIndexStorageStatus(message);
        return;
      }
      if (indexStorageFreeBytes === null || indexStorageFreeBytes < LOCAL_INDEX_STORAGE_RESERVE_BYTES) {
        const message = `Local cache indexing is paused to keep at least ${Math.round(LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free. Reconnect ${getIndexStorageDestinationLabel()} or free local disk space.`;
        if (indexStorageAvailable || indexStorageUnavailableMessage !== message)
          await pauseIndexingForStorage(message);
        publishIndexStorageStatus(message);
        return;
      }
      if (!indexStorageAvailable) await resumeIndexingAfterStorage();
      else {
        const message = `Selected destination ${getIndexStorageDestinationLabel()} is unavailable. Silo is using a local cache and keeping at least ${Math.round(LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free.`;
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
    if (!destinationAvailable) publishIndexStorageStatus(unavailableIndexStorageMessage());
    else publishIndexStorageStatus(null);
  } catch (error) {
    runtimeLog("index-storage-monitor-error", {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    indexStorageMonitorRunning = false;
  }
}

function startIndexStorageAvailabilityMonitor() {
  if (indexStorageMonitorTimer) clearInterval(indexStorageMonitorTimer);
  indexStorageMonitorTimer = setInterval(
    () => void monitorIndexStorageAvailability(),
    1200,
  );
  void monitorIndexStorageAvailability();
}

function installApplicationMenu() {
  applicationMenuInstalled = true;
  const sendEdit = (command: "undo" | "redo") =>
    sendToRenderer("edit-menu-command", command);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Packaged builds carry the .icns in the bundle; development runs from Electron.app.
  if (!app.isPackaged) app.dock?.setIcon(appIconPath());
  installApplicationMenu();
  configureAppUpdater();
  const userDataPath = app.getPath("userData");
  let storage: Awaited<ReturnType<typeof prepareConfiguredIndexStorage>>;
  try {
    storage = await prepareConfiguredIndexStorage(
      userDataPath,
      (filesVerified, bytesVerified) =>
        runtimeLog("index-storage-migration-progress", {
          filesVerified,
          bytesVerified,
        }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtimeLog("index-storage-initialization-failed", { message });
    dialog.showErrorBox(
      "Silo could not safely prepare its index",
      "Silo stopped before opening the library. Existing index files were preserved. Resolve the storage issue and reopen Silo.",
    );
    app.quit();
    return;
  }
  indexStorageRoot = storage.storageRoot;
  selectedIndexStorageRoot = storage.selectedStorageRoot;
  indexStorageUsingLocalFallback = storage.usingLocalFallback;
  indexStorageFallbackEnabled = storage.localFallbackEnabled;
  indexStorageDestinationAvailable = storage.destinationAvailable;
  setActiveIndexStorageRoot(indexStorageRoot);
  indexStorageAvailable =
    storage.destinationAvailable ||
    (storage.usingLocalFallback && storage.localFallbackEnabled && !storage.migrationError);
  if (storage.usingLocalFallback) {
    indexStorageFreeBytes = await getLocalIndexStorageFreeBytes(indexStorageRoot).catch(() => null);
    if (
      indexStorageFreeBytes === null ||
      indexStorageFreeBytes < LOCAL_INDEX_STORAGE_RESERVE_BYTES
    ) {
      indexStorageAvailable = false;
      storage.migrationError = `Local cache indexing is paused to keep at least ${Math.round(LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free. Reconnect ${path.basename(storage.selectedStorageRoot)} or free local disk space.`;
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
      ? `Selected destination ${path.basename(storage.selectedStorageRoot)} is unavailable. Silo is using a local cache and keeping at least ${Math.round(LOCAL_INDEX_STORAGE_RESERVE_BYTES / 1024 / 1024 / 1024)} GB free.`
      : unavailableMessage);
  } else {
    indexStorageUnavailableMessage = storage.migrationError;
    indexStorageMessageText = storage.migrationError;
  }
  if (storage.destinationAvailable && path.resolve(selectedIndexStorageRoot) !== path.resolve(userDataPath)) {
    const selectedStat = await fsPromises.stat(selectedIndexStorageRoot);
    indexStorageDeviceId = selectedStat.dev;
  } else {
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
    if (
      await applyPendingImport(
        app.getPath("userData"),
        indexStorageRoot,
      )
    )
      runtimeLog("config-import-applied", {});
  } catch (error) {
    runtimeLog("config-import-failed", { message: String(error) });
  }
  stateStore = new StateStore(app.getPath("userData"));
  await stateStore.initialize();
  lifetimeLicensed = (await readLifetimeLicense()).isLicensed;
  demoTestingModeEnabled = lifetimeLicensed && (await readDemoTestingMode());
  app.setName(accessDisplayName());
  refreshHiddenFolderPathCache();
  contentSettingsStore = new ContentSettingsStore(app.getPath("userData"));
  await contentSettingsStore.initialize();
  registerMediaProtocols();
  await createWindow();

  if (app.isPackaged && !isDev) void checkForAppUpdates();
  reportStartup("Loading content filters…");
  await loadSafetyCache();
  const modelCachePath = app.isPackaged
    ? path.join(process.resourcesPath, "clip-model-cache")
    : path.join(app.getAppPath(), ".model-test-cache");
  const unifiedScanSource = await createUnifiedScanSource();
  libraryStatsManager = new LibraryStatsManager(
    indexStorageRoot,
    (sourcePath, onFile, isCancelled) =>
      unifiedScanSource(sourcePath, (file) => onFile(file), isCancelled),
  );
  const libraryStatsLoad = indexStorageInitializationDeferred
    ? Promise.resolve()
    : libraryStatsManager.initialize();
  semanticIndexer = new SemanticIndexer(
    app.getPath("userData"),
    modelCachePath,
    unifiedScanSource,
    (progress) => {
      sendIndexProgress(progress);
      const statusChanged = progress.status !== lastSemanticProgressStatus;
      lastSemanticProgressStatus = progress.status;
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
      if (progress.status === "indexing") semanticChangesPending = true;
      if (
        geoIndexer &&
        progress.status === "complete" &&
        semanticChangesPending
      ) {
        semanticChangesPending = false;
        void kickGeoCheck();
      }
      if (progress.status === "complete") kickMagicBackground(15000);
      // Progress is emitted for every indexed item. The topic profile only needs
      // the stage edges; per-item notifications just keep resetting its timer.
      if (statusChanged) memoryProfileScheduler?.notify();
      if (statusChanged)
        scheduleThumbnailPregeneration(progress.status === "indexing");
    },
    runtimeLog,
    indexStorageRoot,
  );
  semanticIndexer.setBackgroundIndexWorkListener((changedFiles) =>
    queueSemanticIndexWork({ changedFiles }),
  );
  libraryShareServer = new LibraryShareServer({
    getSources: async () =>
      (await listSources()).map(({ id, label, rootPath, kind, available }) => ({
        id,
        label,
        rootPath,
        kind,
        available,
      })),
    getIndexedFiles: (sourceRoots) => semanticIndexer.getIndexedFiles(sourceRoots),
    search: (query, sourceRoots) =>
      semanticIndexer.search(query, 0, sourceRoots),
    getThumbnail: async (filePath) => {
      const thumbnailUrl = await getThumbnail(filePath, false, 320);
      if (!thumbnailUrl) return null;
      const fileName = path.basename(new URL(thumbnailUrl).pathname);
      if (!/^[a-f0-9]{40}\.jpg$/.test(fileName)) return null;
      return fsPromises.readFile(indexStoragePath("thumbnail-cache", fileName));
    },
  });
  if (indexStorageUnavailableMessage && !indexStorageInitializationDeferred)
    await semanticIndexer.setHold(indexStorageUnavailableMessage);
  semanticIndexer.setDemoFileLimit(
    fullAccessEnabled() ? null : DEMO_LIMITS.files,
  );
  const semanticLoad = indexStorageInitializationDeferred
    ? Promise.resolve()
    : semanticIndexer.initialize((fraction, records) =>
        reportStartupDetail(
          `Opening search index… ${Math.round(fraction * 100)}% (${records.toLocaleString()} files)`,
        ),
      );
  const faceModelPath = app.isPackaged
    ? path.join(process.resourcesPath, "face-models")
    : path.join(app.getAppPath(), "node_modules/@vladmandic/face-api/model");
  const faceWasmPath = app.isPackaged
    ? path.join(process.resourcesPath, "face-wasm")
    : path.join(
        app.getAppPath(),
        "node_modules/@tensorflow/tfjs-backend-wasm/dist",
      );
  faceIndexer = new FaceIndexer(
    app.getPath("userData"),
    faceModelPath,
    faceWasmPath,
    async () => {
      return semanticIndexer.getIndexedImages(await getAllIndexSources());
    },
    (progress) => {
      sendFaceIndexProgress(progress);
      const statusChanged = progress.status !== lastFaceProgressStatus;
      lastFaceProgressStatus = progress.status;
      if (statusChanged)
        scheduleThumbnailPregeneration(progress.status === "indexing");
    },
    indexStorageRoot,
  );
  faceIndexer.setRecognitionListener(({ added, removed }) => {
    const showBanned = Boolean(
      contentSettingsStore?.getPublicSettings().showBannedPeople,
    );
    sendToRenderer("content-safety-changed", {
      flaggedCount: semanticUnsafePaths.size,
      hiddenPaths: showBanned ? [] : added,
      unhiddenPaths: showBanned ? [] : removed,
      unhiddenCount: showBanned ? 0 : removed.length,
    });
  });
  faceIndexer.setPeopleChangeListener(() =>
    sendToRenderer("photo-indicators-changed", null),
  );
  faceIndexer.setHiddenPhotoPredicate((photoPath, ownerBanned) => {
    const settings = contentSettingsStore?.getPublicSettings();
    if (hiddenFolderPathCache.has(photoPath)) return true;
    if (
      !ownerBanned &&
      !settings?.showBannedPeople &&
      faceIndexer.getBannedPhotoPaths().has(photoPath)
    )
      return true;
    if (settings?.showNsfw) return false;
    return (
      semanticUnsafePaths.has(photoPath) ||
      fileTextLooksExplicit({ name: path.basename(photoPath), path: photoPath })
    );
  });
  const faceLoad = indexStorageInitializationDeferred
    ? Promise.resolve()
    : faceIndexer.initialize();
  aestheticScorer = new AestheticScorer({
    cachePath: indexStoragePath("aesthetic-index.jsonl"),
    thumbnailFile: async (filePath) => {
      const url = await getThumbnail(await resolveLocalPath(filePath));
      return url
        ? path.join(
            indexStorageRoot,
            "thumbnail-cache",
            url.slice(url.lastIndexOf("/") + 1),
          )
        : null;
    },
    faceBoxes: (filePath) => faceIndexer.getFaceBoxes(filePath),
    temporaryPreview: async (filePath) => {
      if (process.platform !== "darwin") {
        const url = await getThumbnail(filePath).catch(() => null);
        return url
          ? {
              file: path.join(
                indexStorageRoot,
                "thumbnail-cache",
                url.slice(url.lastIndexOf("/") + 1),
              ),
              dispose: async () => undefined,
            }
          : null;
      }
      const directory = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), "silo-magic-"),
      );
      const dispose = () =>
        fsPromises.rm(directory, { recursive: true, force: true });
      const output = path.join(directory, "preview.jpg");
      try {
        await execFileAsync(
          "sips",
          ["-s", "format", "jpeg", "-Z", "320", filePath, "--out", output],
          { timeout: 20000 },
        );
        return { file: output, dispose };
      } catch {
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
  petIndexer = new PetIndexer(
    indexStorageRoot,
    indexStoragePath("semantic-index"),
    semanticIndexer,
  );
  const petLoad = indexStorageInitializationDeferred
    ? Promise.resolve()
    : petIndexer.initialize();
  phoneManager = new PhoneManager(
    app.getPath("userData"),
    (progress: PhoneBackupProgress) => {
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
      } else if (!active && heldRoot) {
        phoneBackupHolds.delete(key);
        semanticIndexer?.releaseWatchReconciliation(heldRoot);
      }
      const statusChanged = phoneBackupLastStatus.get(key) !== progress.status;
      phoneBackupLastStatus.set(key, progress.status);
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("phone-backup-progress", progress);
      // Per-file progress is frequent; log transitions only.
      if (!statusChanged) return;
      runtimeLog("phone-backup-progress", {
        deviceId: progress.deviceId,
        platform: progress.platform,
        status: progress.status,
        completedFiles: progress.completedFiles,
        totalFiles: progress.totalFiles,
        completedBytes: progress.completedBytes,
        totalBytes: progress.totalBytes,
      });
    },
  );
  await phoneManager.initialize();
  phoneManagerBackupDestination = await phoneManager.getBackupDestination();
  console.log(
    "[STARTUP] phoneManager initialized, creating Google/Message managers...",
  );
  googleManager = new GoogleManager(
    app.getPath("userData"),
    indexStorageRoot,
  );
  if (!indexStorageInitializationDeferred)
    await googleManager.initialize(
      (await loadGoogleEnv(path.join(app.getPath("userData"), ".env"))) ??
        (await loadGoogleEnv(path.join(app.getAppPath(), ".env"))),
    );
  console.log(
    "[STARTUP] googleManager initialized, creating messageExportCoordinator...",
  );
  messageExportCoordinator = new MessageExportCoordinator(
    app.getPath("userData"),
  );

  // Sync phone backup destination to message coordinator
  const phoneBackupDest = await phoneManager.getBackupDestination();
  if (phoneBackupDest) {
    messageExportCoordinator.setBackupDestination(phoneBackupDest);
  }

  console.log("[STARTUP] Creating ContactManager...");
  contactManager = new ContactManager(app.getPath("userData"));
  await contactManager.initialize();

  console.log("[STARTUP] Creating geoIndexer...");
  geoIndexer = new GeoIndexer(app.getPath("userData"), (state) => {
    // Progress events carry counts only; the renderer fetches photos when photosVersion changes.
    sendToRenderer("geo-index-progress", state);
    scheduleThumbnailPregeneration();
  }, indexStorageRoot);
  const geoLoad = indexStorageInitializationDeferred
    ? Promise.resolve()
    : geoIndexer.initialize();
  geocoder = new Geocoder(app.getPath("userData"), indexStorageRoot);
  if (!indexStorageInitializationDeferred) await geocoder.initialize();
  duplicateManager = new DuplicateManager(app.getPath("userData"), (state) => {
    sendToRenderer("duplicate-progress", filterDuplicateState(state));
  }, indexStorageRoot);
  const duplicateLoad = indexStorageInitializationDeferred
    ? Promise.resolve()
    : duplicateManager.initialize();

  const trackLoad = (load: Promise<unknown>, label: string) =>
    load.then(() => reportStartup(label));
  reportStartup("Loading face, location and inventory caches…");
  // The search index can take a minute to open on big libraries; the app is usable meanwhile.
  void semanticLoad.then(
    () => runtimeLog("search-index-loaded", { elapsedMs: Date.now() - startupStartedAt }),
    (error) => runtimeLog("startup-load-error", { message: String(error) }),
  );
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
  audioLibraryCache = new AudioLibraryCache(indexStorageRoot);
  if (!indexStorageInitializationDeferred) await audioLibraryCache.initialize();
  geoIndexer.setOverrides(stateStore.getState().geoOverrides);
  thumbnailPregenerator = new ThumbnailPregenerator({
    getSourceRoots: getAllIndexSources,
    isMedia: (fileName) => {
      const type = mime.getType(fileName);
      return Boolean(
        type && (type.startsWith("image/") || type.startsWith("video/")),
      );
    },
    isRemotePath,
    listRemoteMediaFiles: async (root) => {
      const source = (await listSources()).find(
        (candidate) => candidate.rootPath === root && candidate.available,
      );
      if (!source) return [];
      try {
        const files = await readSourceFiles(source, true);
        return files
          .filter(
            (file) =>
              !file.isDirectory &&
              mime.getType(file.name)?.match(/^(image|video)\//),
          )
          .map((file) => file.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          source.kind === "gdrive" &&
          /403|forbidden|permission/i.test(message)
        ) {
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
    generate: async (filePath) =>
      Boolean(
        await queueThumbnail(
          filePath,
          async () =>
            await getThumbnail(
              await resolveLocalPath(filePath),
              false,
              GRID_THUMBNAIL_SIZE,
            ),
        ),
      ),
    isInteractiveBusy: () => thumbnailJobs.length > 0,
    getIndexingWaitMessage: getThumbnailIndexingWaitMessage,
    onProgress: (progress) =>
      sendToRenderer("thumbnail-pregen-progress", progress),
  });
  scheduleThumbnailPregeneration();
  memoryManager = new MemoryManager(app.getPath("userData"), {
    search: searchMemoryMedia,
    filterImages: filterMemoryPhotos,
    thumb: async (filePath) => getThumbnail(await resolveLocalPath(filePath), false, 200),
    listAudio: () => audioLibraryCache?.getSnapshot().files ?? [],
    discover: discoverMemoryIdeas,
    isAllowed: memoryAllowed,
    findLiveVideo: memoryLiveVideo,
  });
  await memoryManager.initialize();
  memoryExporter = new MemoryExporter({ ffmpegPath: getFfmpegPath, resolveLocalPath,
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
  audioInventoryRetryTimer = setInterval(
    () => requestIndexRecoveryStages(["audio"]),
    60000,
  );
  requestIndexRecoveryStages(["audio"]);
  reportStartup("Ready", true);
  kickMagicBackground(90000);
  console.log("[STARTUP] All managers initialized");
  phoneDiscoveryTimer = setInterval(() => void discoverAndBackupPhones(), 5000);
  void discoverAndBackupPhones();
  schedulePeriodicCleanup();
  setTimeout(() => void cleanupOldCaches().catch(() => undefined), 60000);

  await getEnabledIndexSources(); // Initialize visibility independently of coverage.
  await semanticLoad.catch(() => undefined);
  memoryProfileScheduler = new RefreshScheduler({
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
          // Filesystem reconciliation skips virtual roots; enumerate ready remote
          // roots explicitly, with cached signatures avoiding repeat embeddings.
          const remoteSources = sources.filter(isRemotePath);
          const progress = semanticIndexer.getProgress();
          const changedFiles = await semanticIndexer.reconcileIndex(sources);
          startupIndexReconciliationSettled = true;
          const pausedByUser =
            progress.status === "paused" && !/interrupted/i.test(progress.message);
          if (!pausedByUser && lifetimeFullScanPending) {
            lifetimeFullScanPending = false;
            queueSemanticIndexWork(
              { fullScanAll: true, force: true },
              ["faces", "locations", "duplicates", "pets", "thumbnails", "audio", "quality"],
            );
          } else if (!pausedByUser && !lifetimeLicensed) {
            queueSemanticIndexWork({ fullScanAll: true }, [
              "faces", "locations", "duplicates", "pets", "thumbnails", "audio", "quality",
            ]);
          } else if (!pausedByUser) {
            queueSemanticIndexWork(
              {
                fullScanRoots: [
                  ...remoteSources,
                  ...semanticIndexer.getSourceCoverageErrors(sources),
                ],
                changedFiles: new Map([
                  ...changedFiles,
                  ...semanticIndexer.getRetryableFiles(sources),
                ]),
              },
              ["faces", "locations", "duplicates", "pets", "thumbnails", "audio", "quality"],
            );
          }
        } finally {
          startupIndexReconciliationSettled = true;
          scheduleThumbnailPregeneration(true);
        }
      })().catch((error) =>
        runtimeLog("startup-index-reconcile-error", { message: String(error) }),
      );
    }, 5000);
  } else {
    startupIndexReconciliationSettled = true;
    scheduleThumbnailPregeneration(true);
  }
  const searchSettled = () =>
    startupIndexReconciliationSettled &&
    !PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status) &&
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
    if (
      ["loading-model", "clustering"].includes(petIndexer.getProgress().status)
    )
      return "Pet clustering is running.";
    if (magicLibraryProgress.running)
      return "Photo quality analysis is running.";
    if (!searchSettled())
      return "Waiting for search indexing to resume and finish.";
    return "Waiting for processing resources.";
  };
  const analysisIdle = () =>
    !PIPELINE_BUSY_STATUSES.has(semanticIndexer.getProgress().status) &&
    !PIPELINE_BUSY_STATUSES.has(faceIndexer.getProgress().status) &&
    !["loading-model", "clustering"].includes(
      petIndexer.getProgress().status,
    ) &&
    !magicLibraryProgress.running;
  const diskIdle = () =>
    !audioInventoryRunning &&
    duplicateManager.getState().status !== "scanning" &&
    !["scanning", "generating"].includes(
      thumbnailPregenerator?.getProgress().status ?? "idle",
    );
  indexRecovery = new IndexingRecovery([
    {
      id: "search",
      lane: "background",
      blockedReason: analysisBlocker,
      progress: () => semanticIndexer.getProgress(),
      ready: () => indexStorageAvailable && startupIndexReconciliationSettled && analysisIdle(),
      unresolvedWork: () => {
        const count = semanticIndexer.getRetryableErrorCount(recoverySearchSourcePaths);
        const coverageErrors = semanticIndexer.getSourceCoverageProgress(
          recoverySearchSourcePaths,
        ).errors;
        return count || coverageErrors
          ? `${count.toLocaleString()} files and ${coverageErrors.toLocaleString()} source scans still need a search-index retry.`
          : null;
      },
      start: async () => {
        const sources = await getAllIndexSources();
        if (!sources.length)
          throw new Error(
            "No configured sources are available. Connect a source and retry.",
          );
        recoverySearchSourcePaths = sources;
        await semanticIndexer.startWatching(sources);
        const fullScanAll = pendingSemanticFullScanAll;
        pendingSemanticFullScanAll = false;
        const fullScanRoots = Array.from(pendingSemanticFullScanRoots);
        pendingSemanticFullScanRoots.clear();
        const resumeRoots = Array.from(pendingSemanticResumeRoots);
        pendingSemanticResumeRoots.clear();
        const changedFiles = new Map(pendingSemanticChangedFiles);
        pendingSemanticChangedFiles.clear();
        const retryableFiles = semanticIndexer.getRetryableFiles(sources);
        retryableFiles.forEach((root, filePath) => {
          if (!changedFiles.has(filePath)) changedFiles.set(filePath, root);
        });
        const coverageRetryRoots =
          semanticIndexer.getSourceCoverageErrors(sources);

        if (fullScanAll) {
          await semanticIndexer.startFullScan(sources);
        } else {
          // Keep source discovery scoped to newly added or failed roots. Saved
          // records remain searchable while these roots are scanned in order.
          for (const root of new Set([...fullScanRoots, ...coverageRetryRoots]))
            await semanticIndexer.start([root]);
          if (resumeRoots.length) await semanticIndexer.start(resumeRoots);
          if (changedFiles.size) {
            const changedRoots = Array.from(new Set(changedFiles.values()));
            await semanticIndexer.start(changedRoots, changedFiles);
          } else if (semanticIndexer.hasPendingIndexWork()) {
            // Resume only checkpointed work; an empty retry must never trigger a
            // fresh walk of every configured source.
            await semanticIndexer.start(sources);
          }
        }
      },
      pause: () => semanticIndexer.pause(),
    },
    {
      id: "faces",
      lane: "background",
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
      lane: "background",
      blockedReason: analysisBlocker,
      progress: () => geoIndexer.getStatus(),
      needsInitialCheck: true,
      ready: () =>
        indexStorageAvailable &&
        searchSettled() &&
        geoIndexer.getStatus().status !== "scanning",
      unresolvedWork: () => {
        const count = geoIndexer.getRetryableCount();
        return count
          ? `${count.toLocaleString()} location records need another check.`
          : null;
      },
      start: () => runGeoCheck(),
      pause: () => geoIndexer.pause(),
    },
    {
      id: "duplicates",
      lane: "background",
      blockedReason: () =>
        audioInventoryRunning
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
        await duplicateManager.scan(
          semanticIndexer.getIndexedFiles(sources),
          sources,
        );
      },
      pause: () => duplicateManager.pause(),
    },
    {
      id: "pets",
      lane: "background",
      blockedReason: analysisBlocker,
      needsInitialCheck: true,
      progress: () => petIndexer.getProgress(),
      ready: () => indexStorageAvailable && searchSettled() && analysisIdle(),
      start: async () =>
        petIndexer.start(
          (progress) => sendToRenderer("pet-progress", progress),
          await getAllIndexSources(),
        ),
      pause: () => petIndexer.pause(),
    },
    {
      id: "thumbnails",
      lane: "background",
      blockedReason: () =>
        getThumbnailIndexingWaitMessage() ||
        "Thumbnail generation is already active.",
      needsInitialCheck: true,
      progress: () =>
        thumbnailPregenerator?.getProgress() ?? {
          status: "idle",
          message: "Waiting for services",
        },
      ready: () =>
        indexStorageAvailable &&
        Boolean(thumbnailPregenerator) &&
        !getThumbnailIndexingWaitMessage() &&
        duplicateManager.getState().status !== "scanning" &&
        !["scanning", "generating"].includes(
          thumbnailPregenerator?.getProgress().status ?? "idle",
        ),
      unresolvedWork: () => {
        const failed = thumbnailPregenerator?.getProgress().failed ?? 0;
        return failed
          ? `${failed.toLocaleString()} thumbnails could not be generated and will be retried.`
          : null;
      },
      start: async () => {
        thumbnailPregenDirty = false;
        await thumbnailPregenerator?.start();
      },
    },
    {
      id: "audio",
      lane: "background",
      progress: () => ({
        status: audioInventoryRunning ? "scanning" : "idle",
        message: "Source-aware retry coverage",
      }),
      ready: () =>
        indexStorageAvailable &&
        startupIndexReconciliationSettled &&
        searchSettled() &&
        analysisIdle() &&
        !audioInventoryRunning,
      start: async () => {
        const requestId = pendingAudioRefreshRequestId;
        const force = pendingAudioRefreshForce;
        pendingAudioRefreshRequestId = -1;
        pendingAudioRefreshForce = false;
        const result = await refreshAudioInventory(requestId, force);
        if (!result.ok) throw new Error(result.error);
      },
      pause: () => {
        if (audioLibraryCache !== null) audioLibraryCache.cancelScan();
      },
    },
    {
      id: "quality",
      lane: "background",
      blockedReason: analysisBlocker,
      progress: () => ({
        status: magicLibraryProgress.running ? "indexing" : "idle",
        message: "Quality scoring",
      }),
      ready: () => indexStorageAvailable && searchSettled() && analysisIdle(),
      start: async () => {
        const sources = await getAllIndexSources();
        await aestheticScorer.analyzeInBackground(
          semanticIndexer
            .getIndexedImages(sources)
            .filter((file) => !isRemotePath(file.path)),
        );
      },
      pause: () => aestheticScorer.setBackgroundPaused(true),
    },
  ], Date.now, path.join(app.getPath("userData"), "indexing-recovery.json"));
  await monitorIndexStorageAvailability();
  startIndexStorageAvailabilityMonitor();
  requestIndexRecoveryStages([]);
  indexRecoveryTimer = setInterval(
    () =>
      void indexRecovery?.tick().catch((error) =>
        runtimeLog("index-recovery-tick-error", { message: String(error) }),
      ),
    5000,
  );
  const heapGuard = new HeapGuard({
    onPressure: async (sample) => {
      heapPressureMessage =
        "Indexing paused briefly to free memory; progress so far is saved and it will resume automatically.";
      runtimeLog("heap-pressure", {
        usedMb: Math.round(sample.used / 1024 / 1024),
        limitMb: Math.round(sample.limit / 1024 / 1024),
      });
      await semanticIndexer.setHold(
        indexStorageUnavailableMessage ?? heapPressureMessage,
      );
    },
    onRelief: async (sample) => {
      runtimeLog("heap-relief", { usedMb: Math.round(sample.used / 1024 / 1024) });
      heapPressureMessage = null;
      const resume = await semanticIndexer.setHold(indexStorageUnavailableMessage);
      if (!indexStorageUnavailableMessage && resume.length && !shuttingDown)
        queueSemanticIndexWork({ resumeRoots: resume, force: true });
    },
  });
  heapGuardTimer = setInterval(
    () =>
      void heapGuard.tick().catch((error) =>
        runtimeLog("heap-guard-error", { message: String(error) }),
      ),
    2000,
  );
  diagnosticsTimer = setInterval(() => {
    const memory = process.memoryUsage();
    const progress = semanticIndexer.getProgress();
    const faceProgress = faceIndexer.getProgress();
    const geoState = geoIndexer.getStatus();
    const duplicateState = duplicateManager.getState();
    runtimeLog("heartbeat", {
      rendererProcesses: app
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let quitFlushed = false;
app.on("before-quit", (event) => {
  memoryExporter?.cancel();
  void libraryShareServer?.stop();
  shuttingDown = true;
  if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
  indexRecovery?.stop();
  if (indexRecoveryTimer) clearInterval(indexRecoveryTimer);
  if (audioInventoryRetryTimer) clearInterval(audioInventoryRetryTimer);
  audioLibraryCache?.cancelScan();
  if (diagnosticsTimer) clearInterval(diagnosticsTimer);
  if (heapGuardTimer) clearInterval(heapGuardTimer);
  if (phoneDiscoveryTimer) clearInterval(phoneDiscoveryTimer);
  if (quitFlushed) return;
  runtimeLog("before-quit");
  void semanticIndexer?.stopWatching();
  void phoneManager?.unmountAll();
  if (!semanticIndexer) return;
  // Finish in-flight index writes so a restart never finds a torn record line.
  event.preventDefault();
  quitFlushed = true;
  const flush = semanticIndexer.flushWrites();
  const deadline = new Promise((resolve) => setTimeout(resolve, 8000));
  void Promise.race([flush, deadline]).finally(() => app.quit());
});

app.on("activate", () => {
  if (mainWindow === null) {
    void createWindow();
  }
});

// IPC Handlers
ipcMain.handle("get-memories", async (_event, prepareViews: unknown) => {
  // Returns immediately; movies render in the background and report progress per card.
  const state = await memoryManager.getState();
  if (prepareViews === true && state.suggestions.length)
    void prepareAllMemoryPreviews(state.suggestions).catch(() => runtimeLog("memory-preview-error"));
  return memoryStateWithPreviews(state);
});
ipcMain.handle("generate-memories", async (_event, replace: unknown, customTopic: unknown) => {
  // Generation never throws to the page: failures keep the current cards and explain why.
  if (customTopic !== undefined && typeof customTopic !== "string") {
    const current = await memoryStateWithPreviews();
    return { ...current, message: "Enter a topic using plain text." };
  }
  let state;
  try {
    state = await memoryManager.generate(replace === true, customTopic);
  } catch {
    runtimeLog("memory-generate-error");
    const current = await memoryStateWithPreviews();
    return { ...current, message: "Memory generation hit a problem; your saved memories are unchanged." };
  }
  if (state.suggestions.length)
    void prepareAllMemoryPreviews(state.suggestions).catch(() => runtimeLog("memory-preview-error"));
  return { ...(await memoryStateWithPreviews()), message: state.message };
});
ipcMain.handle("select-memory-directory", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return memoryManager.getState();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Save memory movies to…",
    properties: ["openDirectory", "createDirectory"],
  });
  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return memoryManager.getState();
  const directory = path.resolve(chosen);
  await fsPromises.access(directory, fs.constants.W_OK).catch(() => {
    throw new Error("That folder isn't writable. Choose another destination.");
  });
  const state = await memoryManager.updateSettings({ movieDirectory: directory });
  // Copy already-rendered movies over so saved stories stay viewable offline.
  void prepareAllMemoryPreviews(state.suggestions).catch(() => runtimeLog("memory-preview-error"));
  return state;
});
ipcMain.handle("dismiss-memory", (_event, id: unknown) => {
  if (typeof id !== "string" || !id || id.length > 200) throw new Error("Invalid memory.");
  return memoryManager.dismiss(id);
});
ipcMain.handle("update-memory-settings", (_event, settings: unknown) => {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Invalid memory settings.");
  const update: Partial<MemorySettings> = {};
  for (const key of ["showOnLaunch", "removeAfterDownload"] as const) {
    const value = (settings as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error("Invalid memory settings.");
    update[key] = value;
  }
  // Only clearing is accepted here; a folder is set through the native picker.
  if ((settings as Record<string, unknown>).movieDirectory === null) update.movieDirectory = null;
  return memoryManager.updateSettings(update);
});
ipcMain.handle("get-memory-soundtracks", (_event, id: unknown) => {
  if (typeof id !== "string" || !id || id.length > 200) throw new Error("Invalid memory.");
  return memoryManager.getSoundtracks(id);
});
ipcMain.handle("browse-memory-audio", (_event, raw: unknown) => {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const textField = (field: unknown, max: number) =>
    typeof field === "string" && field.length <= max && !field.includes("\0") ? field : undefined;
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
ipcMain.handle("set-memory-soundtrack", async (_event, id: unknown, soundtrackId: unknown) => {
  if (typeof id !== "string" || !id || id.length > 200 || typeof soundtrackId !== "string" || soundtrackId.length > 250)
    throw new Error("Invalid memory soundtrack.");
  const card = await memoryManager.setSoundtrack(id, soundtrackId);
  if (!card) throw new Error("That song is no longer available. Choose another one.");
  // The watchable movie re-renders with the new song on the single background queue.
  memoryPreviewStatus.delete(id);
  void prepareMemoryPreviews([card]).catch(() => runtimeLog("memory-preview-error"));
  return memoryStateWithPreviews();
});
ipcMain.handle("view-memory", async (_event, id: unknown) => {
  if (typeof id !== "string" || !id || id.length > 200) return { ok: false, error: "Invalid memory." };
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
      error: `The demo includes ${DEMO_LIMITS.memoryPreviews} memory previews. Unlock Silo to watch more.`,
      upgradeRequired: true,
    };
  }
  return { ok: true, path: moviePath };
});
ipcMain.handle("cancel-memory-export", () => {
  // Also covers the save dialog and pre-render checks, before the exporter has a controller.
  if (memoryExportRunning) memoryExportCancelRequested = true;
  memoryExporter.cancel();
});
ipcMain.handle("export-memory", async (_event, rawOptions: unknown) => {
  if (memoryExportRunning) return { ok: false, error: "Another memory movie is already rendering." };
  const options = memoryExportOptions(rawOptions);
  if (!options) return { ok: false, error: "Invalid movie settings." };
  memoryExportRunning = true;
  memoryExportCancelRequested = false;
  let scratch: string | null = null;
  try {
    const initial = await verifyMemoryExport(options);
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("The app window is not available.");
    const destination = await dialog.showSaveDialog(mainWindow, {
      title: "Save memory movie",
      defaultPath: `${initial.suggestion.title.replace(/[^\p{L}\p{N} -]/gu, "").trim() || "Memory"}.mp4`,
      filters: [{ name: "Memory movie", extensions: ["mp4"] }],
    });
    if (destination.canceled || !destination.filePath || memoryExportCancelRequested)
      return { ok: false, canceled: true };
    // Hidden folders, bans, or the audio index may have changed while the dialog was open.
    const { suggestion, soundtrack } = await verifyMemoryExport(options);
    scratch = await fsPromises.mkdtemp(path.join(os.tmpdir(), "silo-memory-export-"));
    if (memoryExportCancelRequested) return { ok: false, canceled: true };
    await runMemoryRender(async () => {
      memoryExportScratch = scratch;
      try {
        await memoryExporter.render(suggestion, options, soundtrack, destination.filePath,
          progress => sendToRenderer("memory-export-progress", progress));
      } finally {
        memoryExportScratch = null;
      }
    });
    // The movie is already saved; a bookkeeping failure must not report a failed export.
    await memoryManager.markDownloaded(suggestion.id).catch(() => undefined);
    return { ok: true, path: destination.filePath };
  } catch (cause) {
    if (memoryExportCancelRequested || cause instanceof MemoryExportCancelledError ||
      (cause instanceof Error && cause.name === "AbortError"))
      return { ok: false, canceled: true };
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    memoryExportScratch = null;
    if (scratch) await fsPromises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    memoryExportRunning = false;
    memoryExportCancelRequested = false;
  }
});
ipcMain.handle(
  "read-inventory-page",
  (event, token: unknown, offset: unknown) => {
    if (typeof token !== "string" || typeof offset !== "number")
      throw new Error("Invalid inventory request.");
    return inventoryTransfers.read(token, offset, event.sender.id);
  },
);
ipcMain.handle("release-inventory", (event, token: string) =>
  inventoryTransfers.release(token, event.sender.id),
);

ipcMain.handle("select-directory", async () => {
  if (mainWindow === null) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle("select-source-clone-destination", async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose one or more source-clone destinations",
    buttonLabel: "Choose destinations",
    properties: ["openDirectory", "multiSelections"],
  });
  return !result.canceled ? result.filePaths : [];
});

ipcMain.handle(
  "prepare-source-clone",
  async (
    _event,
    sourceIds: unknown,
    destinations: unknown,
    operationId: unknown,
  ) => {
    const cleanIds = Array.isArray(sourceIds)
      ? sourceIds.filter((id): id is string => typeof id === "string")
      : [];
    if (typeof operationId !== "string" || !operationId)
      return { ok: false, error: "Invalid clone operation." };
    try {
      const plan = await prepareSourceClone(
        cleanIds,
        Array.isArray(destinations) ? destinations.filter((item): item is string => typeof item === "string") : [],
        operationId,
      );
      return { ok: true, plan };
    } catch (error) {
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
  },
);

ipcMain.handle("prepare-shelter-replica", async (_event, destinations: unknown, operationId: unknown) => {
  const cleanDestinations = Array.isArray(destinations)
    ? destinations.filter((item): item is string => typeof item === "string")
    : [];
  if (typeof operationId !== "string" || !operationId)
    return { ok: false, error: "Invalid shelter replica operation." };
  try {
    const plan = await prepareShelterReplica(cleanDestinations, operationId);
    return { ok: true, plan };
  } catch (error) {
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

ipcMain.handle("start-source-clone", async (_event, planId: unknown, options: unknown) => {
  if (typeof planId !== "string")
    return { ok: false, error: "Invalid clone plan." };
  const compress = Boolean(options && typeof options === "object" &&
    (options as { compress?: unknown }).compress === true);
  const createAppleCompatibleBackup = Boolean(options && typeof options === "object" &&
    (options as { createAppleCompatibleBackup?: unknown }).createAppleCompatibleBackup === true);
  const plan = sourceClonePlans.get(planId);
  if (createAppleCompatibleBackup &&
      (!plan || plan.sourceIds.length !== 1 || plan.sourceIds[0] !== MAC_DATA_VOLUME_ROOT ||
        !stateStore.getState().indexSources.some((source) => source.path === MAC_DATA_VOLUME_ROOT && source.kind === "machine")))
    return { ok: false, error: "Time Machine can only be added to a clone of the registered This Mac source." };
  try {
    await runSourceClone(planId, { compress });
    if (!createAppleCompatibleBackup) return { ok: true };
    try {
      await startConfiguredTimeMachineBackup(
        MAC_DATA_VOLUME_ROOT,
        stateStore.getState().indexSources.some((source) => source.path === MAC_DATA_VOLUME_ROOT && source.kind === "machine"),
      );
      return { ok: true, timeMachineStarted: true };
    } catch (error) {
      return {
        ok: true,
        timeMachineError: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle("start-machine-time-machine-backup", async (_event, sourceId: unknown) => {
  if (typeof sourceId !== "string" || sourceId !== MAC_DATA_VOLUME_ROOT)
    return { ok: false, error: "Time Machine can only be requested for This Mac." };
  const sourceRegistered = process.platform === "darwin" &&
    stateStore.getState().indexSources.some((source) => source.path === MAC_DATA_VOLUME_ROOT && source.kind === "machine");
  try {
    await startConfiguredTimeMachineBackup(sourceId, sourceRegistered);
    return { ok: true, timeMachineStarted: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("extract-source-clone-archive", async (_event, operationId: unknown) => {
  if (typeof operationId !== "string" || !operationId)
    return { ok: false, error: "Invalid extraction operation." };
  if (!mainWindow) return { ok: false, error: "Silo's window is not available." };
  const archiveChoice = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a compressed Silo clone (.zip) to extract",
    buttonLabel: "Choose archive",
    properties: ["openFile"],
    filters: [{ name: "Silo clone archive", extensions: ["zip"] }],
  });
  if (archiveChoice.canceled || !archiveChoice.filePaths[0]) return { ok: false, cancelled: true };
  const archivePath = archiveChoice.filePaths[0];
  const destinationChoice = await dialog.showOpenDialog(mainWindow, {
    title: "Choose where to extract the clone",
    buttonLabel: "Extract here",
    defaultPath: path.dirname(archivePath),
    properties: ["openDirectory", "createDirectory"],
  });
  if (destinationChoice.canceled || !destinationChoice.filePaths[0]) return { ok: false, cancelled: true };
  const destinationParent = destinationChoice.filePaths[0];
  const operation = { cancelled: false };
  sourceCloneOperations.set(operationId, operation);
  const base = { operationId, totalSources: 1, completedFiles: 0, totalBytes: 0, copiedBytes: 0,
    verifiedFiles: 0, failedFiles: 0, totalFiles: 0, currentFile: "" };
  sendSourceCloneProgress({ ...base, phase: "scanning", destination: destinationParent,
    message: `Reading ${path.basename(archivePath)}…` });
  let lastProgressAt = 0;
  try {
    const result = await extractCloneArchive(archivePath, destinationParent, {
      isCancelled: () => operation.cancelled,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastProgressAt < 350) return;
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
  } catch (error) {
    const message = operation.cancelled
      ? "Extraction cancelled; the partially extracted folder was removed."
      : error instanceof Error ? error.message : String(error);
    sendSourceCloneProgress({ ...base, phase: operation.cancelled ? "cancelled" : "error",
      destination: destinationParent, message });
    return { ok: false, error: message, cancelled: operation.cancelled };
  } finally {
    sourceCloneOperations.delete(operationId);
  }
});

ipcMain.handle("cancel-source-clone", (_event, operationId: unknown) => {
  if (typeof operationId !== "string") return false;
  const operation = sourceCloneOperations.get(operationId);
  if (!operation) return false;
  operation.cancelled = true;
  return true;
});

ipcMain.handle(
  "get-files",
  async (
    _event,
    dirPath: string,
    exploded = false,
    requestId?: number,
    scanOptions?: {
      sortField:
        | "name"
        | "size"
        | "modified"
        | "type"
        | "source"
        | "magic"
        | "people"
        | "mapped";
      sortAscending: boolean;
      includedType: string;
      sizeMin: number;
      sizeMax: number;
    },
  ) => {
    if (typeof dirPath !== "string") return [];
    const emitIndexedPreview = async () => {
      if (!exploded || typeof requestId !== "number") return;
      const enabledPaths = await getEnabledIndexSources();
      const availableSources = await listSources();
      const indexed = filterForContentSafety(
        semanticIndexer
          .getIndexedFiles(enabledPaths)
          .filter(
            (file) =>
              dirPath === ALL_SOURCES_PATH ||
              file.path === dirPath ||
              file.path.startsWith(`${dirPath}${path.sep}`),
          )
          .map((file) => {
            const source = availableSources
              .filter(
                (candidate) =>
                  file.path === candidate.rootPath ||
                  file.path.startsWith(`${candidate.rootPath}/`),
              )
              .sort(
                (first, second) =>
                  second.rootPath.length - first.rootPath.length,
              )[0];
            return {
              ...file,
              sourceId: source?.id,
              sourceLabel: source?.label,
            };
          }),
      );
      indexed.sort((first, second) => {
        const direction = scanOptions?.sortAscending === false ? -1 : 1;
        const field = scanOptions?.sortField ?? "name";
        if (field === "source") {
          const sourceOrder = naturalCollator.compare(
            first.sourceLabel || "",
            second.sourceLabel || "",
          );
          return sourceOrder
            ? sourceOrder * direction
            : second.modified - first.modified;
        }
        let order =
          field === "size"
            ? first.size - second.size
            : field === "modified"
              ? first.modified - second.modified
              : field === "type"
                ? first.type.localeCompare(second.type)
                : naturalCollator.compare(first.name, second.name);
        if (!order) order = first.path.localeCompare(second.path);
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
      const progressCallback =
        typeof requestId === "number"
          ? (
              fileDeltas: FileInfo[],
              scanned: number,
              total: number,
              audioFound: number,
              errors: number,
            ) => {
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
      const files = filterForContentSafety(
        await readAllSources(Boolean(exploded), progressCallback),
      );
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
      .filter(
        (source) =>
          dirPath === source.rootPath ||
          dirPath.startsWith(`${source.rootPath}/`),
      )
      .sort(
        (first, second) => second.rootPath.length - first.rootPath.length,
      )[0];
    if (owningSource && (!owningSource.enabled || !owningSource.available))
      return [];

    if (phoneManager?.isPhonePath(dirPath)) {
      console.log(
        `[Phone] Listing files for path: ${dirPath}, exploded: ${exploded}`,
      );
      try {
        const files = await (exploded
          ? phoneManager.listPhoneFilesRecursively(dirPath)
          : phoneManager.listPhoneFiles(dirPath, false));
        console.log(`[Phone] Found ${files.length} files for ${dirPath}`);
        // Log first few files for debugging
        if (files.length > 0) {
          console.log(
            `[Phone] Sample files:`,
            files.slice(0, 3).map((f) => f.name),
          );
        } else {
          console.log(`[Phone] No files found for ${dirPath}`);
        }
        return filterForContentSafety(
          files.map((file) => ({
            ...file,
            sourceId: owningSource?.id,
            sourceLabel: owningSource?.label,
            ...(owningSource?.snapshotAt ? { sourceSnapshotAt: owningSource.snapshotAt } : {}),
          })),
        );
      } catch (error) {
        console.error(`[Phone] Error listing files for ${dirPath}:`, error);
        return [];
      }
    }

    if (googleManager?.isCloudPath(dirPath)) {
      const files = await googleManager.listFiles(dirPath, Boolean(exploded));
      return filterForContentSafety(
        files.map((file) => ({
          ...file,
          sourceId: owningSource?.id,
          sourceLabel: owningSource?.label,
        })),
      );
    }

    if (!path.isAbsolute(dirPath)) return [];

    const diagnostics: ScanDiagnostics = {
      denied: 0,
      unreadable: 0,
      isTimeMachine: false,
    };

    const files = await readFiles(
      dirPath,
      Boolean(exploded),
      diagnostics,
      (progressFiles: FileInfo[]) => {
        // Send a bounded preview; resending the whole growing list each tick is quadratic.
        if (typeof requestId === "number") {
          const annotatedProgress = filterForContentSafety(
            progressFiles.slice(0, 500).map((file) => ({
              ...file,
              sourceId: owningSource?.id,
              sourceLabel: owningSource?.label,
            })),
          );
          sendToRenderer("file-scan-progress", {
            requestId,
            directoryPath: dirPath,
            files: annotatedProgress,
            scanned: progressFiles.length,
            total: 0, // The directory does not have a known total until scanning completes.
            audioFound: progressFiles.filter((file) => file.type === "audio")
              .length,
            done: false,
            isTimeMachine: diagnostics.isTimeMachine,
            errors: diagnostics.denied + diagnostics.unreadable,
          });
        }
      },
      owningSource?.kind === "machine" ? owningSource.rootPath : undefined,
    );
    const annotatedFiles = filterForContentSafety(
      files.map((file) => ({
        ...file,
        sourceId: owningSource?.id,
        sourceLabel: owningSource?.label,
      })),
    );
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
  },
);

async function getVisibleAudioSnapshot(
  snapshot: ReturnType<AudioLibraryCache["getSnapshot"]>,
) {
  const availableSources = (await listSources()).filter(
    (source) => source.available && source.rootPath.trim(),
  );
  const allSources = [] as typeof availableSources;
  for (const source of availableSources) {
    if (!(await isSiloAppDataRoot(source.rootPath))) allSources.push(source);
  }
  const activeSources = allSources.filter(
    (source) => source.enabled && source.available,
  );
  const activeIds = new Set(activeSources.map((source) => source.id));
  const files = snapshot.files.filter(
    (file) => file.sourceId && activeIds.has(file.sourceId),
  );
  const cachedIds = [...snapshot.sourceIds].sort();
  const coverageIds = allSources.map((source) => source.id).sort();
  const sourceScannedAt = snapshot.sourceScannedAt ?? {};
  return {
    ...snapshot,
    files,
    extensions: Array.from(
      new Set(files.map((file) => file.extension || "(no extension)")),
    ).sort(),
    stale:
      snapshot.scannedAt === 0 ||
      coverageIds.some((id) => {
        const scannedAt = sourceScannedAt[id] ?? 0;
        return !scannedAt || Date.now() - scannedAt > 24 * 60 * 60 * 1000;
      }) ||
      (snapshot.failedSources?.length ?? 0) > 0 ||
      cachedIds.length !== coverageIds.length ||
      cachedIds.some((id, index) => id !== coverageIds[index]),
  };
}

ipcMain.handle("get-audio-library-cache", async () => {
  if (!audioLibraryCache)
    return { files: [], extensions: [], scannedAt: 0, sourceIds: [] };
  return getVisibleAudioSnapshot(audioLibraryCache.getSnapshot());
});

async function refreshAudioInventory(requestId: number, force = false) {
  if (!indexStorageAvailable)
    return { ok: false, error: indexStorageUnavailableMessage ?? "Index storage is unavailable." };
  if (!audioLibraryCache || typeof requestId !== "number")
    return { ok: false, error: "Audio library is unavailable." };
  const availableSources = (await listSources()).filter(
    (source) => source.available && source.rootPath.trim(),
  );
  const sources = [] as typeof availableSources;
  for (const source of availableSources) {
    if (!(await isSiloAppDataRoot(source.rootPath))) sources.push(source);
  }
  if (requestId === -1 && !force) {
    const cached = audioLibraryCache.getSnapshot();
    const now = Date.now();
    const pending = sources.some((source) => {
      const completedAt = cached.sourceScannedAt?.[source.id] ?? 0;
      const failed = cached.failedSources?.includes(source.id);
      const needsScan =
        !completedAt || now - completedAt >= 24 * 60 * 60 * 1000 || failed;
      return needsScan && (cached.sourceCooldownUntil?.[source.id] ?? 0) <= now;
    });
    if (!pending)
      return { ok: true, snapshot: await getVisibleAudioSnapshot(cached) };
  }
  audioInventoryRunning = true;
  try {
    const snapshot = await audioLibraryCache.scan(
      sources,
      isRemotePath,
      (fileName) => isAudioFile(fileName, mime.getType(fileName)),
      async (source) => {
        if (phoneManager.isPhonePath(source.rootPath)) {
          return (
            await phoneManager.listPhoneFilesRecursively(source.rootPath)
          ).map((file) => ({
            ...file,
            sourceId: source.id,
            sourceLabel: source.label,
          }));
        }
        if (googleManager.isCloudPath(source.rootPath)) {
          return (
            await googleManager.listFilesRecursively(source.rootPath)
          ).map((file) => ({
            ...file,
            sourceId: source.id,
            sourceLabel: source.label,
          }));
        }
        return [];
      },
      (progress) => {
        audioInventoryProgress = progress;
        sendToRenderer("audio-library-scan-progress", {
          requestId,
          ...progress,
        });
      },
      force,
    );
    sendToRenderer("audio-library-cache-changed", snapshot.scannedAt);
    runtimeLog("audio-inventory-checkpoint", {
      files: snapshot.files.length,
      sources: snapshot.sourceIds.length,
      completedSources: Object.keys(snapshot.sourceScannedAt ?? {}).length,
      failedSources: snapshot.failedSources?.length ?? 0,
    });
    return { ok: true, snapshot: await getVisibleAudioSnapshot(snapshot) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    audioInventoryRunning = false;
  }
}

ipcMain.handle(
  "refresh-audio-library-cache",
  async (_event, requestId: unknown, force: unknown) => {
    if (typeof requestId !== "number")
      return { ok: false, error: "Invalid audio scan request." };
    if (!audioLibraryCache)
      return { ok: false, error: "Audio inventory is not ready." };
    pendingAudioRefreshRequestId = requestId;
    pendingAudioRefreshForce ||= force === true;
    if (indexRecovery) await indexRecovery.retry("audio");
    else return refreshAudioInventory(requestId, force === true);
    return {
      ok: true,
      snapshot: await getVisibleAudioSnapshot(audioLibraryCache.getSnapshot()),
    };
  },
);

ipcMain.handle("get-file-preview", async (_event, filePath: string) => {
  try {
    const remote = isRemotePath(filePath);
    let mimeType = mime.getType(filePath);
    const extension = path.extname(filePath).toLowerCase();
    let sourcePath: string | undefined;
    if (extension === ".ts") {
      sourcePath = await resolveLocalPath(filePath);
      const { data } = await readPreviewBytes(sourcePath, 1024);
      const transportStream =
        (data[0] === 0x47 && data[188] === 0x47 && data[376] === 0x47) ||
        (data[4] === 0x47 && data[196] === 0x47 && data[388] === 0x47);
      if (!transportStream) mimeType = "text/plain";
    }
    const isMedia =
      mimeType?.startsWith("video/") || mimeType?.startsWith("audio/");

    // Remote media streams lazily through app-media; only images are pulled eagerly.
    const video = mimeType?.startsWith("video/") ?? false;
    const needsVideoConversion =
      video && !directlyPlayableVideoExtensions.has(extension);
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
    } else {
      const stats = await fsPromises.stat(localPath);
      size = stats.size;
      modifiedMs = stats.mtimeMs;
    }

    let previewDataUrl: string | null = null;
    if (mimeType?.startsWith("image/")) {
      if (browserImageTypes.has(mimeType)) {
        const sourceBuffer = await fsPromises.readFile(localPath);
        previewDataUrl = `data:${mimeType};base64,${sourceBuffer.toString("base64")}`;
      } else {
        const sourceImage = nativeImage.createFromPath(localPath);
        if (!sourceImage.isEmpty()) {
          previewDataUrl = sourceImage.toDataURL();
        } else {
          const converted = await getConvertedImageBuffer(
            localPath,
            2400,
            88,
            "preview-cache",
          );
          previewDataUrl = `data:image/jpeg;base64,${converted.toString("base64")}`;
        }
      }
    }

    const playableVideo = video
      ? await getPlayableVideoPath(filePath, localPath, size, modifiedMs)
      : null;
    const documentPreview =
      !mimeType?.startsWith("image/") && !isMedia
        ? await getDocumentPreview(localPath, path.basename(filePath), mimeType)
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
  } catch (err) {
    console.error("Error getting file preview:", err);
    return null;
  }
});

ipcMain.handle(
  "get-thumbnail",
  async (
    _event,
    filePath: string,
    urgent?: boolean,
    force?: boolean,
    requestedSize?: number,
  ) => {
    if (typeof filePath !== "string") return null;
    const remote = isRemotePath(filePath);
    const thumbnailSize = Math.max(
      120,
      Math.min(480, Math.round(Number(requestedSize) || 480)),
    );
    if (!remote && !path.isAbsolute(filePath)) return null;
    const pendingKey = `${filePath}:${thumbnailSize}`;
    const pending = pendingThumbnails.get(pendingKey);
    if (pending && !force) {
      if (urgent) {
        for (const job of thumbnailJobs)
          if (job.filePath === filePath) job.priority = 0;
        sortThumbnailJobs();
      }
      return pending;
    }
    const request = (async () => {
      const localPath = await resolveLocalPath(filePath);
      return await queueThumbnail(
        filePath,
        () => getThumbnail(localPath, force === true, thumbnailSize),
        urgent === true || force === true,
      );
    })()
      .catch(() => null)
      .finally(() => pendingThumbnails.delete(pendingKey));
    pendingThumbnails.set(pendingKey, request);
    return request;
  },
);

ipcMain.handle(
  "get-thumbnail-pregen-progress",
  () => thumbnailPregenerator?.getProgress() ?? null,
);

ipcMain.on("update-visible-thumbnails", (_event, visiblePaths: string[]) => {
  visibleThumbnailPaths.clear();
  visiblePaths.forEach((p) => visibleThumbnailPaths.add(p));
  sortThumbnailJobs();
});

ipcMain.handle(
  "create-folder",
  async (_event, parentPath: string, folderName: string) => {
    if (
      !path.isAbsolute(parentPath) ||
      !folderName.trim() ||
      folderName !== path.basename(folderName)
    ) {
      return { ok: false, error: "Enter a valid folder name." };
    }

    try {
      await fsPromises.mkdir(path.join(parentPath, folderName.trim()));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not create folder.",
      };
    }
  },
);

ipcMain.handle("move-file", async (_event, sourcePath: string) => {
  if (!mainWindow || !path.isAbsolute(sourcePath))
    return { ok: false, error: "Invalid file." };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Move file to folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0])
    return { ok: false, canceled: true };

  const destinationPath = path.join(
    result.filePaths[0],
    path.basename(sourcePath),
  );
  try {
    await fsPromises.access(destinationPath).then(
      () =>
        Promise.reject(
          new Error("A file with this name already exists in that folder."),
        ),
      () => undefined,
    );
    try {
      await fsPromises.rename(sourcePath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fsPromises.copyFile(sourcePath, destinationPath);
      await fsPromises.unlink(sourcePath);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not move file.",
    };
  }
});

ipcMain.handle(
  "save-file-to-device",
  async (_event, sourcePath: string, suggestedFileName: string) => {
    const isPhoneFile = isRemotePath(sourcePath);
    if (!mainWindow || (!isPhoneFile && !path.isAbsolute(sourcePath)))
      return { ok: false, error: "Invalid file." };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save file to",
      defaultPath: suggestedFileName,
    });
    if (result.canceled || !result.filePath)
      return { ok: false, canceled: true };

    try {
      const localPath = await resolveLocalPath(sourcePath);
      await fsPromises.copyFile(localPath, result.filePath);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not save file.",
      };
    }
  },
);

ipcMain.handle("get-app-state", () => ({
  ...stateStore.getState(),
  indexProgress: semanticIndexer.getProgress(),
}));

ipcMain.handle("get-content-settings", () =>
  contentSettingsStore.getPublicSettings(),
);
ipcMain.handle(
  "set-parental-password",
  (_event, currentPassword: string, newPassword: string) =>
    contentSettingsStore.setParentalPassword(currentPassword, newPassword),
);
ipcMain.handle(
  "update-content-settings",
  async (_event, update: Partial<ContentPreferences>, password?: string) => {
    const settings = await contentSettingsStore.updatePreferences(
      update,
      password,
    );
    mainWindow?.webContents.send("content-settings-changed", settings);
    return settings;
  },
);

ipcMain.handle("magic-rank", (_event, items: unknown, preset: unknown) => {
  const clean: MagicItem[] = Array.isArray(items)
    ? items.flatMap((item) =>
        item && typeof item.path === "string" && path.isAbsolute(item.path)
          ? [
              {
                path: item.path,
                size: Number(item.size) || 0,
                modified: Number(item.modified) || 0,
                name: String(item.name ?? ""),
              },
            ]
          : [],
      )
    : [];
  const presetId: MagicPresetId =
    preset === "people" || preset === "landscapes" || preset === "variety"
      ? preset
      : "balanced";
  kickMagicBackground(10000);
  return aestheticScorer.rank(clean, presetId);
});

let magicKickTimer: NodeJS.Timeout | null = null;

/** Queues every indexed local photo for magic scoring at low priority (debounced). */
function kickMagicBackground(delay: number) {
  if (magicKickTimer) clearTimeout(magicKickTimer);
  magicKickTimer = setTimeout(() => {
    magicKickTimer = null;
    requestIndexRecoveryStages(["quality"]);
  }, delay);
}

ipcMain.handle("export-config", async (_event, rendererPrefs: unknown) => {
  if (!mainWindow) return { ok: false, error: "App window is unavailable." };
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Silo config",
    defaultPath: path.join(
      app.getPath("documents"),
      `silo-config-${stamp}.siloconfig`,
    ),
    filters: [{ name: "Silo config", extensions: ["siloconfig"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const prefs =
    rendererPrefs && typeof rendererPrefs === "object"
      ? (Object.fromEntries(
          Object.entries(rendererPrefs as Record<string, unknown>).filter(
            ([key, value]) =>
              key.startsWith("silo.") && typeof value === "string",
          ),
        ) as Record<string, string>)
      : {};
  try {
    const { size } = await exportConfig(
      app.getPath("userData"),
      result.filePath,
      app.getVersion(),
      prefs,
      indexStorageRoot,
    );
    return { ok: true, path: result.filePath, size };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Export failed.",
    };
  }
});

ipcMain.handle("import-config", async () => {
  if (!mainWindow) return { ok: false, error: "App window is unavailable." };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import Silo config",
    properties: ["openFile"],
    filters: [{ name: "Silo config", extensions: ["siloconfig"] }],
  });
  if (result.canceled || !result.filePaths[0])
    return { ok: false, canceled: true };
  try {
    const manifest = await stageConfigImport(
      app.getPath("userData"),
      result.filePaths[0],
    );
    return { ok: true, manifest };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Import failed.",
    };
  }
});

ipcMain.handle("apply-config-import", async () => {
  await commitStagedImport(app.getPath("userData"));
  app.relaunch();
  app.exit(0);
});

ipcMain.handle("cancel-config-import", () =>
  cancelStagedImport(app.getPath("userData")),
);

ipcMain.handle("get-duplicate-state", async () => {
  await duplicateManager
    .pruneMissing()
    .catch((error) => console.warn("[DUPLICATE] Prune failed:", error));
  await getEnabledIndexSources();
  return filterDuplicateState(duplicateManager.getState());
});
ipcMain.handle("scan-duplicates", async () => {
  await getEnabledIndexSources();
  if (indexRecovery) await indexRecovery.retry("duplicates");
  return filterDuplicateState(duplicateManager.getState());
});
ipcMain.handle("quarantine-duplicates", (_event, groupIds: string[]) =>
  duplicateManager.quarantine(groupIds),
);
ipcMain.handle("quarantine-duplicate-files", (_event, filePaths: string[]) =>
  duplicateManager.quarantineFiles(filePaths),
);
ipcMain.handle("restore-duplicates", (_event, ids: string[]) =>
  duplicateManager.restore(ids),
);
ipcMain.handle("clear-duplicate-trash", async (_event, ids?: string[]) => {
  if (fullAccessEnabled()) return duplicateManager.clearTrash(ids);
  const deletion = demoDuplicateDeleteQueue.then(async () => {
    const trash = duplicateManager.getState().trash;
    const selectedIds = ids ? new Set(ids) : null;
    const requested = trash.filter(
      (item) => !selectedIds || selectedIds.has(item.id),
    );
    const usage = await readDemoUsage();
    const allowed = selectDemoDeletionBatch(
      requested,
      false,
      usage.duplicateFilesDeleted,
      DEMO_LIMITS.duplicateDeletes,
    );
    const exceedsLimit = requested.length > allowed.length;
    if (allowed.length === 0) {
      if (exceedsLimit) notifyDemoLimitReached("duplicateDeletes");
      return duplicateManager.getState();
    }
    const result = await duplicateManager.clearTrash(
      allowed.map((item) => item.id),
    );
    const remainingIds = new Set(result.trash.map((item) => item.id));
    const deletedCount = allowed.filter(
      (item) => !remainingIds.has(item.id),
    ).length;
    await recordDemoDuplicateDeletes(deletedCount);
    if (exceedsLimit)
      notifyDemoLimitReached("duplicateDeletes");
    return result;
  });
  demoDuplicateDeleteQueue = deletion.then(
    () => undefined,
    () => undefined,
  );
  return deletion;
});

ipcMain.handle("update-ui-state", async (_event, update) =>
  stateStore.updateUi(update),
);

ipcMain.handle("select-index-source", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Add source to semantic index",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const newSourcePath = result.filePaths[0];
  const alreadyRegistered = stateStore
    .getState()
    .indexSources.some((source) => source.path === newSourcePath);
  if (
    !fullAccessEnabled() &&
    !alreadyRegistered &&
    (await getDemoSourceCount()) >= DEMO_LIMITS.sources
  ) {
    notifyDemoLimitReached("sources");
    return null;
  }
  await stateStore.addIndexSource(newSourcePath);
  sourceListCacheAt = 0;
  void indexNewSources([newSourcePath], "local-source-added");

  return stateStore.getState();
});

ipcMain.handle("add-machine-source", async () => {
  if (process.platform !== "darwin") return null;
  if (!(await fsPromises.access(MAC_DATA_VOLUME_ROOT, fs.constants.R_OK).then(() => true, () => false)))
    return null;
  const existing = stateStore.getState().indexSources.some(
    (source) => source.path === MAC_DATA_VOLUME_ROOT,
  );
  if (!fullAccessEnabled() && !existing &&
      (await getDemoSourceCount()) >= DEMO_LIMITS.sources) {
    notifyDemoLimitReached("sources");
    return null;
  }
  await stateStore.addMachineSource(MAC_DATA_VOLUME_ROOT);
  sourceListCacheAt = 0;
  void indexNewSources([MAC_DATA_VOLUME_ROOT], "machine-source-added");
  return stateStore.getState();
});

ipcMain.handle("remove-index-source", async (_event, sourcePath: string) => {
  await stateStore.removeIndexSource(sourcePath);
  sourceListCacheAt = 0;
  // Update watchers to remove this source (but keep index for potential future re-add)
  await getEnabledIndexSources();
  const sources = await getAllIndexSources();
  if (sources.length > 0) {
    await semanticIndexer.startWatching(sources);
  } else {
    semanticIndexer.stopWatching();
  }
  return stateStore.getState();
});

ipcMain.handle("start-indexing", async () => {
  if (!indexStorageAvailable) return semanticIndexer.getProgress();
  const sources = await getAllIndexSources();
  if (sources.length === 0) return semanticIndexer.getProgress();
  indexRecovery?.clearUserPause("search");
  await semanticIndexer.startWatching(sources);
  queueSemanticIndexWork(
    fullAccessEnabled()
      ? { fullScanRoots: sources, force: true }
      : { fullScanAll: true, force: true },
    ["faces", "locations", "duplicates", "pets", "thumbnails", "audio", "quality"],
  );
  return semanticIndexer.getProgress();
});

ipcMain.handle("pause-indexing", async () => {
  indexRecovery?.pause("search");
  await semanticIndexer.pause();
  return semanticIndexer.getProgress();
});

const semanticSearchGenerations = new WeakMap<object, number>();
const supersedeSemanticSearch = (sender: object) => {
  const generation = (semanticSearchGenerations.get(sender) ?? 0) + 1;
  semanticSearchGenerations.set(sender, generation);
  return generation;
};

ipcMain.handle("cancel-semantic-search", (event) => {
  supersedeSemanticSearch(event.sender);
});

ipcMain.handle(
  "semantic-search",
  async (event, query: string, confidence: number, requestId: number) => {
    const sender = event.sender;
    const generation = supersedeSemanticSearch(sender);
    const isCancelled = () =>
      sender.isDestroyed() || semanticSearchGenerations.get(sender) !== generation;
    const progressRequestId = Number.isSafeInteger(requestId) ? requestId : generation;
    const minimumConfidence = confidenceSettingToMinimumThreshold(confidence);
    const contentSettings = contentSettingsStore.getPublicSettings();
    if (contentSettings.safeSearch && containsExplicitTerms(query))
      throw new Error(
        "This search is blocked by Safe Search. A parental password is required to change Safe Search in Settings.",
      );
    const sources = await getEnabledIndexSources();
    if (isCancelled()) return [];

    // Read only the search fields here. getState() structured-clones the entire
    // persisted library, which made every keystroke copy hundreds of thousands
    // of metadata records before a result could be shown.
    const state = stateStore.getSearchState();
    const normalizedQuery = query.trim().toLowerCase();
    const priorityMatches = new Map<
      string,
      { priority: number; source: string; name?: string }
    >();
    const addPriorityMatch = (
      filePath: string,
      priority: number,
      source: string,
      name?: string,
    ) => {
      const previous = priorityMatches.get(filePath);
      if (!previous || priority < previous.priority)
        priorityMatches.set(filePath, { priority, source, name });
    };

    const rankResults = (semanticResults: SearchResult[]) => {
      const semanticResultsByPath = new Map(
        semanticResults.map((result) => [result.path, result]),
      );
      const allResults = new Map<string, any>();
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

      const activeResults = filterForEnabledSources(
        Array.from(allResults.values()),
        new Set(sources),
      ).filter(
        (result) =>
          Number.isFinite(result.confidence) &&
          result.confidence >= minimumConfidence,
      );
      if (isCancelled()) return [];
      return filterForContentSafety(activeResults).sort((first, second) => {
        const priorityDifference = (first._priority ?? 3) - (second._priority ?? 3);
        return priorityDifference || second.confidence - first.confidence;
      });
    };

    const publishProgress = (
      status: "searching" | "done",
      semanticResults: SearchResult[],
      scanned = 0,
      total = 0,
    ) => {
      if (isCancelled()) return;
      sender.send("semantic-search-progress", {
        requestId: progressRequestId,
        status,
        results: rankResults(semanticResults),
        scanned,
        total,
      });
    };

    // Kick off CLIP against the saved index before walking user-authored names.
    // The callback streams verified semantic matches as soon as each vector batch
    // is scored; previews remain separately labeled as unconfirmed in the UI.
    publishProgress("searching", []);
    let scannedRecords = 0;
    let totalRecords = 0;
    const semanticResultsPromise = semanticIndexer.search(
      query,
      minimumConfidence,
      sources,
      isCancelled,
      (partialResults, scanned, total) => {
        scannedRecords = scanned;
        totalRecords = total;
        publishProgress("searching", partialResults, scanned, total);
      },
    );

    if (normalizedQuery) {
      for (const folder of state.digitalFolders) {
        if (!folder.name.toLowerCase().includes(normalizedQuery)) continue;
        for (const filePath of folder.filePaths)
          addPriorityMatch(filePath, 2, `In folder: ${folder.name}`);
      }

      // User-confirmed people photos outrank inferred visual similarity.
      for (const person of faceIndexer.getPeople()) {
        if (!person.name.toLowerCase().includes(normalizedQuery)) continue;
        const detail = faceIndexer.getPerson(person.id);
        for (const filePath of detail?.confirmedPhotoPaths ?? [])
          addPriorityMatch(filePath, 1, `Named as: ${person.name}`);
      }

      // Pet names and other explicit name assignments remain searchable. Person
      // cluster suggestions are excluded here; only confirmed cluster photos win.
      const matchingPetPaths = new Set<string>();
      for (const entry of state.nameIndex) {
        if (
          entry.sourceType === "person" ||
          !entry.name.toLowerCase().includes(normalizedQuery)
        ) continue;
        for (const fileEntry of entry.filePaths) {
          addPriorityMatch(fileEntry.path, 1, `Named as: ${entry.name}`);
          if (entry.sourceType === "pet") matchingPetPaths.add(fileEntry.path);
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
        const keywordMatches = metadata.keywords.some((keyword) =>
          keyword.toLowerCase().includes(normalizedQuery),
        );
        if (aliasMatches || keywordMatches)
          addPriorityMatch(
            filePath,
            0,
            aliasMatches
              ? `Virtual name: ${metadata.displayName}`
              : `Keywords: ${metadata.keywords.join(", ")}`,
            metadata.displayName,
          );
      }
    }

    publishProgress("searching", []);
    const semanticResults = await semanticResultsPromise;
    if (isCancelled()) return [];
    const results = rankResults(semanticResults);
    sender.send("semantic-search-progress", {
      requestId: progressRequestId,
      status: "done",
      results,
      scanned: scannedRecords,
      total: totalRecords,
    });
    return results;
  },
);

ipcMain.handle("create-digital-folder", async (_event, name: string) => {
  const folderCount = stateStore
    .getState()
    .digitalFolders.filter(
      (folder) =>
        folder.id !== FAVORITES_FOLDER_ID && folder.id !== REFUSE_FOLDER_ID,
    ).length;
  if (
    isDemoLimitReached(
      fullAccessEnabled(),
      folderCount,
      DEMO_LIMITS.digitalFolders,
    )
  ) {
    notifyDemoLimitReached("digitalFolders");
    throw new Error(
      `The demo includes up to ${DEMO_LIMITS.digitalFolders} digital folders. Unlock Silo to create more.`,
    );
  }
  return stateStore.createDigitalFolder(name);
});
ipcMain.handle(
  "rename-digital-folder",
  (_event, folderId: unknown, name: unknown) => {
    if (typeof folderId !== "string" || typeof name !== "string")
      throw new Error("Invalid folder rename request.");
    return stateStore.renameDigitalFolder(folderId, name);
  },
);
ipcMain.handle(
  "move-digital-folder",
  (_event, sourceId: unknown, targetId: unknown, after: unknown) => {
    if (
      typeof sourceId !== "string" ||
      typeof targetId !== "string" ||
      typeof after !== "boolean"
    )
      throw new Error("Invalid folder order request.");
    return stateStore.moveDigitalFolder(sourceId, targetId, after);
  },
);
ipcMain.handle("delete-digital-folder", async (_event, folderId: string) => {
  const before = getHiddenFolderPaths();
  const result = await stateStore.deleteDigitalFolder(folderId);
  refreshHiddenFolderPathCache();
  notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
  return result;
});
ipcMain.handle(
  "set-digital-folder-hidden",
  async (_event, folderId: string, hidden: boolean) => {
    const before = getHiddenFolderPaths();
    const result = await stateStore.setDigitalFolderHidden(folderId, hidden);
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
  },
);
ipcMain.handle(
  "update-file-metadata",
  async (
    _event,
    filePaths: string[],
    update: {
      displayName?: string | null;
      keywords?: string[];
      mergeKeywords?: boolean;
      year?: number | null;
    },
  ) => stateStore.updateFileMetadata(filePaths, update),
);
ipcMain.handle(
  "add-digital-folder-reference",
  async (_event, folderId: string, filePath: string) => {
    const before = getHiddenFolderPaths();
    const result = await stateStore.addDigitalFolderReference(
      folderId,
      filePath,
    );
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
  },
);
ipcMain.handle(
  "add-digital-folder-references",
  async (_event, folderId: string, filePaths: unknown) => {
    if (typeof folderId !== "string" || !Array.isArray(filePaths))
      throw new Error("Invalid album request.");
    const before = getHiddenFolderPaths();
    const result = await stateStore.addDigitalFolderReferences(
      folderId,
      filePaths.filter(
        (filePath): filePath is string =>
          typeof filePath === "string" && filePath.length > 0,
      ),
    );
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
  },
);
ipcMain.handle(
  "remove-digital-folder-reference",
  async (_event, folderId: string, filePath: string) => {
    const before = getHiddenFolderPaths();
    const result = await stateStore.removeDigitalFolderReference(
      folderId,
      filePath,
    );
    refreshHiddenFolderPathCache();
    notifyFolderVisibilityChange(before, getHiddenFolderPaths(), folderId);
    return result;
  },
);
ipcMain.handle("get-digital-folder-files", async (_event, folderId: string) => {
  const folder = stateStore
    .getState()
    .digitalFolders.find((item) => item.id === folderId);
  if (!folder) return [];
  const sources = new Set(await getEnabledIndexSources());
  const files = await readReferencedFiles(folder.filePaths);
  return filterForContentSafety(
    filterForEnabledSources(files, sources),
    folder.hidden ? folder.id : undefined,
  );
});

ipcMain.handle("download-digital-folder", async (_event, folderId: string) => {
  if (!mainWindow) return { ok: false, error: "App window is unavailable." };
  const folder = stateStore
    .getState()
    .digitalFolders.find((item) => item.id === folderId);
  if (!folder) return { ok: false, error: "Digital folder not found." };

  const result = await dialog.showOpenDialog(mainWindow, {
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
      while (
        await fsPromises.access(destinationPath).then(
          () => true,
          () => false,
        )
      ) {
        destinationPath = path.join(
          result.filePaths[0],
          `${parsedName.name} (${suffix})${parsedName.ext}`,
        );
        suffix += 1;
      }
      const localPath = await resolveLocalPath(sourcePath);
      await fsPromises.copyFile(localPath, destinationPath);
      copied += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    ok: failed === 0,
    copied,
    failed,
    error:
      failed > 0
        ? `${failed} file${failed === 1 ? "" : "s"} could not be copied.`
        : undefined,
  };
});

ipcMain.handle("get-face-state", async () => {
  const sources = new Set(await getEnabledIndexSources());
  const visiblePeople = getDemoPeople();
  const people = await Promise.all(
    visiblePeople.map(async (summary) => {
      const detail = faceIndexer.getPerson(summary.id);
      if (!detail) return null;
      const paths = detail.photoPaths.filter((photoPath) =>
        fileIsInEnabledSource(photoPath, sources),
      );
      if (paths.length === 0) return null;
      const pathSet = new Set(paths);
      const confirmedPhotoPaths = detail.confirmedPhotoPaths.filter(
        (photoPath) => pathSet.has(photoPath),
      );
      const faces = detail.faces.filter((face) => pathSet.has(face.imagePath));
      return {
        ...summary,
        photoCount: paths.length,
        faceCount: faces.length,
        confirmedCount: confirmedPhotoPaths.length,
        reviewableCount: Math.min(summary.reviewableCount, paths.length),
        hiddenCount: Math.max(
          0,
          paths.length - Math.min(summary.reviewableCount, paths.length),
        ),
        fullyConfirmed:
          paths.length > 0 &&
          confirmedPhotoPaths.length >=
            Math.min(summary.reviewableCount, paths.length),
      };
    }),
  );
  return {
    progress: { ...faceIndexer.getProgress(), people: visiblePeople.length },
    people: people.filter(
      (person): person is NonNullable<typeof person> => person !== null,
    ),
  };
});

ipcMain.handle("retry-indexing-stage", async (_event, id: unknown) => {
  if (typeof id !== "string" || !indexRecovery)
    throw new Error("Index recovery is not ready.");
  await indexRecovery.retry(id);
  return { ok: true };
});
async function collectShelterSourceFiles(source: BrowseSource, operationId: string) {
  const files: Array<ShelterSourceFile & { size: number; modified: number }> = [];
  const fingerprint = new InventoryFingerprint();
  const add = (relativePath: string, localPath: string, size: number, modified: number) => {
    files.push({ relativePath, localPath, size, modified });
    fingerprint.add(relativePath, size, modified);
  };
  if (source.kind === "local" || source.kind === "machine") {
    await listLocalCloneEntries(source.rootPath, operationId, (entry) => {
      if (!entry.isDirectory && entry.localPath)
        add(entry.destinationRelativePath, entry.localPath, entry.size, entry.modified);
    });
  } else {
    const remoteEntries = phoneManager.isPhonePath(source.rootPath)
      ? await phoneManager.listPhoneFilesRecursively(source.rootPath)
      : await googleManager.listFilesRecursively(source.rootPath);
    for (const remote of remoteEntries) {
      ensureCloneActive(operationId);
      if (remote.isDirectory) continue;
      const localPath = await resolveLocalPath(remote.path);
      const stats = await fsPromises.stat(localPath);
      const size = Number.isFinite(remote.size) && remote.size >= 0 ? remote.size : stats.size;
      const modified = Number.isFinite(remote.modified) ? remote.modified : stats.mtimeMs;
      add(remote.relativePath || remote.name, localPath, size, modified);
    }
  }
  return { files, fingerprint: fingerprint.finish() };
}

async function findLatestCompleteShelterClone(
  sourceId: string,
  destination: string,
  clonePaths: string[],
) {
  const candidates: Array<{ path: string; modified: number }> = [];
  for (const clonePath of new Set(clonePaths)) {
    if (path.resolve(path.dirname(clonePath)) !== path.resolve(destination)) continue;
    try {
      const [stats, linkStats, resolved] = await Promise.all([
        fsPromises.stat(clonePath),
        fsPromises.lstat(clonePath),
        fsPromises.realpath(clonePath),
      ]);
      const isArchive = path.extname(clonePath).toLowerCase() === CLONE_ARCHIVE_EXTENSION;
      if (linkStats.isSymbolicLink() || (isArchive ? !stats.isFile() : !stats.isDirectory()) ||
          path.dirname(resolved) !== path.resolve(destination)) continue;
      candidates.push({ path: clonePath, modified: stats.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => right.modified - left.modified);
  for (const candidate of candidates) {
    try {
      const manifest = await readShelterCloneManifest(candidate.path);
      const containsSource = [...(manifest.files as Array<Record<string, unknown>>),
        ...(manifest.aliases as Array<Record<string, unknown>>)]
        .some((entry) => entry.sourceId === sourceId);
      if (containsSource) return candidate.path;
    } catch {
      continue;
    }
  }
  return null;
}

async function verifyShelterSources(sourceIds: string[]) {
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

  const operationId = `shelter-audit-${Date.now()}-${randomBytes(4).toString("hex")}`;
  sourceCloneOperations.set(operationId, { cancelled: false });
  try {
    for (const source of selected) {
      ensureCloneActive(operationId);
      const previous = (await getSourceCloneStatus())?.[source.id];
      const previousAudit = previous?.shelterAudits?.[destination];
      let audit: NonNullable<SourceCloneStatusRecord["shelterAudits"]>[string];
      try {
        const { files, fingerprint } = await collectShelterSourceFiles(source, operationId);
        const clonePath = await findLatestCompleteShelterClone(
          source.id,
          destination,
          previous?.destinations ?? [],
        );
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
        } else {
          const result = await verifyShelterCloneSource(clonePath, source.id, files);
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
      } catch (error) {
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
  } finally {
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
    const hasCloneInDestination = Boolean(destinationKey && clone?.destinations?.some(
      (clonePath) => path.resolve(path.dirname(clonePath)) === destinationKey,
    ));
    const hasVerifiedCopy = Number(audit?.lastFullyVerifiedAt) > 0;
    let shelterState: "unprotected" | "verified" | "changed" | "checking" | "offline" | "unknown";
    if (audit && audit.lastResult !== "verified") shelterState = audit.lastResult === "missing" && !hasVerifiedCopy ? "unprotected" : "changed";
    else if (destination && !destinationState.available) shelterState = hasVerifiedCopy || hasCloneInDestination ? "offline" : "unprotected";
    else if (!hasVerifiedCopy) shelterState = hasCloneInDestination ? "unknown" : "unprotected";
    else if (source.status === "offline") shelterState = "offline";
    else if (source.status === "scanning" || source.status === "pending" || source.status === "error") shelterState = "checking";
    else shelterState = audit?.sourceFingerprint === source.fingerprint ? "verified" : "changed";
    return {
      ...source,
      hasVerifiedCopy,
      lastVerifiedAt: audit?.lastFullyVerifiedAt ?? null,
      cloneDestination: audit?.clonePath ?? null,
      shelterFreshness: getShelterFreshness(audit?.lastFullyVerifiedAt),
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
  const verifiedSources = sources.filter((source) =>
    source.shelterState === "verified" ||
    (source.shelterState === "offline" && source.hasVerifiedCopy && source.shelterAuditResult === "verified"),
  ).length;
  const freshnessOrder: Record<string, number> = {
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
  const eligibleRoots: string[] = [];
  for (const source of registeredSources) {
    if (
      source.available && source.rootPath.trim() &&
      !(await isSiloAppDataRoot(source.rootPath))
    ) eligibleRoots.push(source.rootPath);
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

ipcMain.handle("get-library-dashboard", () => getLibraryDashboardSnapshot());
ipcMain.handle("verify-shelter-sources", async (_event, sourceIds: unknown) => {
  const cleanIds = Array.isArray(sourceIds)
    ? Array.from(new Set(sourceIds.filter((id): id is string => typeof id === "string")))
    : [];
  return verifyShelterSources(cleanIds);
});
ipcMain.handle("refresh-library-stats", async () => {
  if (!libraryStatsManager) throw new Error("Library inventory is not ready.");
  const sources = (await listSources()).map(({ id, label, kind, rootPath, available, offlineBackup, snapshotAt, message }) => ({
    id, label, kind, rootPath, available, offlineBackup, snapshotAt, message,
  }));
  libraryStatsManager.requestRefresh(sources);
  return getLibraryDashboardSnapshot();
});
ipcMain.handle("select-shelter-destination", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Silo's primary shelter destination",
    buttonLabel: "Use as shelter",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return getShelterDestination();
  return setShelterDestination(result.filePaths[0]);
});

async function readRuntimeDiagnostics(cursorValue: unknown) {
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
  } finally {
    await handle.close();
  }
  let contentStart = start;
  if (truncated && contentStart > 0) {
    const firstNewline = content.indexOf("\n");
    if (firstNewline < 0) return { entries: [], cursor: start + bytesRead, truncated: true };
    contentStart += Buffer.byteLength(content.slice(0, firstNewline + 1), "utf8");
    content = content.slice(firstNewline + 1);
  }
  const lastNewline = content.lastIndexOf("\n");
  const completeText = lastNewline >= 0 ? content.slice(0, lastNewline) : "";
  const entries = completeText.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  }).slice(-maxEntries);
  const consumedBytes = lastNewline >= 0
    ? Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8")
    : 0;
  return { entries, cursor: contentStart + consumedBytes, truncated };
}

ipcMain.handle("get-runtime-diagnostics", (_event, cursor: unknown) => readRuntimeDiagnostics(cursor));

ipcMain.handle("get-indexing-overview", async () => {
  const registeredSources = Array.from(
    new Map(
      (await listSources())
        .filter((source) => source.rootPath.trim())
        .map((source) => [source.rootPath, source]),
    ).values(),
  );
  const eligibleRoots = await getIndexableRootsFromSources(registeredSources);
  const unavailableSources = registeredSources.filter(
    (source) => source.kind !== "local" && source.kind !== "machine" && !source.available,
  );
  const coverage =
    typeof semanticIndexer.getSourceCoverageProgress === "function"
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
  const currentSource = registeredSources.find(
    (source) => source.rootPath === discovery.sourcePath,
  );
  const batchRoot =
    currentSource?.label ||
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
  const coveredAudioSources =
    audio?.sourceIds.filter(
      (id) =>
        Boolean(audio.sourceScannedAt?.[id]) &&
        !audio.failedSources?.includes(id),
    ).length ?? 0;
  return [
    {
      id: "discovery",
      label: "Source discovery",
      status:
        discovery.running || coverage.scanning
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

ipcMain.handle("get-startup-state", () => startupState);

function getVisibleDemoMapPhotos(
  photos: GeoPhoto[],
  sourcePaths: readonly string[],
): GeoPhoto[] {
  const visiblePhotos = filterForContentSafety(
    filterForEnabledSources(photos, new Set(sourcePaths)),
  );
  const uniquePhotos = Array.from(
    new Map(visiblePhotos.map((photo) => [photo.path, photo])).values(),
  );
  return selectDemoMapPhotos(
    uniquePhotos,
    fullAccessEnabled(),
    DEMO_LIMITS.mapPhotos,
    DEMO_LIMITS.mapDestinations,
  );
}

function getVisibleGeoState<T extends { photos: GeoPhoto[]; geotagged: number }>(
  state: T,
  sourcePaths: readonly string[],
): T {
  const photos = getVisibleDemoMapPhotos(
    state.photos,
    sourcePaths,
  );
  return { ...state, geotagged: photos.length, photos };
}

function requireDemoMapRelocation(
  files: IndexableFile[],
  location: GeocodedLocation,
  sourcePaths: readonly string[],
): void {
  if (fullAccessEnabled()) return;
  const currentPhotos = getVisibleDemoMapPhotos(
    geoIndexer.getState().photos,
    sourcePaths,
  );
  const availablePaths = new Set(currentPhotos.map((photo) => photo.path));
  const selectedPaths = new Set(
    files
      .filter(
        (file) =>
          (file.type === "image" || file.type === "video") &&
          !file.isDirectory,
      )
      .map((file) => file.path),
  );
  if (Array.from(selectedPaths).some((filePath) => !availablePaths.has(filePath))) {
    notifyDemoLimitReached("mapPhotos");
    throw new Error(
      `The demo maps up to ${DEMO_LIMITS.mapPhotos.toLocaleString()} photos. Unlock Silo to map more.`,
    );
  }
  const destinations = new Set(
    currentPhotos
      .filter((photo) => !selectedPaths.has(photo.path))
      .map(getDemoDestinationKey),
  );
  if (selectedPaths.size > 0) {
    destinations.add(
      getDemoDestinationKey({
        path: "demo-destination",
        locationLabel: location.label,
        city: location.city,
        region: location.region,
        country: location.country,
        latitude: location.latitude,
        longitude: location.longitude,
      }),
    );
  }
  if (destinations.size > DEMO_LIMITS.mapDestinations) {
    notifyDemoLimitReached("mapDestinations");
    throw new Error(
      `The demo maps up to ${DEMO_LIMITS.mapDestinations} destinations. Unlock Silo to map another.`,
    );
  }
}

ipcMain.handle("get-geo-state", async () => {
  const sources = await getEnabledIndexSources();
  if (!geoCheckedThisSession) {
    geoCheckedThisSession = true;
    void kickGeoCheck();
  }
  const state = geoIndexer.getState();
  return getVisibleGeoState(state, sources);
});

ipcMain.handle("refresh-geo-state", async () => {
  await kickGeoCheck(true);
  const sources = new Set(await getEnabledIndexSources());
  const state = geoIndexer.getState();
  return getVisibleGeoState(state, Array.from(sources));
});

ipcMain.handle("get-country-summary", async () => {
  const sources = new Set(await getEnabledIndexSources());
  const photos = getVisibleDemoMapPhotos(
    geoIndexer.getState().photos,
    Array.from(sources),
  );
  const countries = new Map<string, number>();
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

ipcMain.handle("get-state-summary", async (_event, country: string | null) => {
  const sources = new Set(await getEnabledIndexSources());
  const photos = getVisibleDemoMapPhotos(
    geoIndexer.getState().photos,
    Array.from(sources),
  );
  const states = new Map<string, number>();
  for (const photo of photos) {
    if (photo.country !== country) continue;
    const state = photo.region || "Unknown";
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return Array.from(states, ([state, photoCount]) => ({
    state,
    photoCount,
  })).sort((first, second) => second.photoCount - first.photoCount);
});

ipcMain.handle(
  "get-photos-by-region",
  async (_event, country: string | null, state?: string | null) => {
    const sources = await getEnabledIndexSources();
    const photos = geoIndexer.getPhotosByRegion(country, state);
    return getVisibleDemoMapPhotos(photos, sources);
  },
);

ipcMain.handle(
  "reverse-geocode",
  (_event, latitude: number, longitude: number) =>
    geocoder.reverse(latitude, longitude),
);
ipcMain.handle("search-locations", (_event, query: string) =>
  geocoder.search(query),
);
ipcMain.handle(
  "set-geo-location",
  async (_event, files: IndexableFile[], location: GeocodedLocation) => {
    const sources = await getEnabledIndexSources();
    requireDemoMapRelocation(files, location, sources);
    const snapshots: GeoFileSnapshot[] = files
      .filter(
        (file) =>
          (file.type === "image" || file.type === "video") && !file.isDirectory,
      )
      .map((file) => ({
        name: file.name,
        path: file.path,
        relativePath: file.relativePath,
        size: file.size,
        modified: file.modified,
        isDirectory: false,
        type: file.type,
        extension: file.extension,
        sourcePath:
          sources
            .filter(
              (sourcePath) =>
                file.path === sourcePath ||
                file.path.startsWith(`${sourcePath}${path.sep}`),
            )
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
  },
);
ipcMain.handle("clear-geo-location", async (_event, filePaths: string[]) => {
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
ipcMain.handle("start-face-indexing", async () => {
  await retryIndexRecoveryStage("faces");
  return faceIndexer.getProgress();
});
ipcMain.handle("pause-face-indexing", async () => {
  indexRecovery?.pause("faces");
  await faceIndexer.pause();
  return faceIndexer.getProgress();
});
ipcMain.handle("get-person", async (_event, personId: string) => {
  if (!canAccessDemoPerson(personId)) return null;
  const detail = faceIndexer.getPerson(personId);
  if (!detail) return null;
  const sources = new Set(await getEnabledIndexSources());
  const photoPaths = detail.photoPaths.filter((photoPath) =>
    fileIsInEnabledSource(photoPath, sources),
  );
  const visible = new Set(photoPaths);
  const confirmedPhotoPaths = detail.confirmedPhotoPaths.filter((photoPath) =>
    visible.has(photoPath),
  );
  const suggestedPhotoPaths = detail.suggestedPhotoPaths.filter((photoPath) =>
    fileIsInEnabledSource(photoPath, sources),
  );
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
    fullyConfirmed:
      photoPaths.length > 0 && confirmedPhotoPaths.length >= reviewableCount,
  };
});
/** Paths that are truly gone: their volume is mounted but the file is not there. */
async function confirmedMissingPaths(filePaths: string[]) {
  const mounted = new Map<string, boolean>();
  const missing: string[] = [];
  for (const filePath of filePaths) {
    if (isRemotePath(filePath) || !path.isAbsolute(filePath)) continue;
    const volume = /^\/Volumes\/[^/]+/.exec(filePath)?.[0];
    if (volume) {
      if (!mounted.has(volume))
        mounted.set(
          volume,
          await fsPromises.access(volume).then(
            () => true,
            () => false,
          ),
        );
      if (!mounted.get(volume)) continue;
    }
    if (
      !(await fsPromises.access(filePath).then(
        () => true,
        () => false,
      ))
    )
      missing.push(filePath);
  }
  return missing;
}

ipcMain.handle("get-person-photo-files", async (_event, personId: string) => {
  if (!canAccessDemoPerson(personId)) return [];
  const person = faceIndexer.getPerson(personId);
  if (!person) return [];
  const files = await readReferencedFiles(person.photoPaths);
  const sources = new Set(await getEnabledIndexSources());
  const activeFiles = filterForEnabledSources(files, sources);
  const found = new Set(files.map((file) => file.path));
  const unreadable = person.photoPaths.filter(
    (photoPath) => !found.has(photoPath),
  );
  if (unreadable.length > 0)
    await faceIndexer.markMissingPhotos(
      await confirmedMissingPaths(unreadable),
    );
  // A banned person's own page is the only place their photos can be viewed.
  return person.status === "banned"
    ? filterForNsfw(activeFiles)
    : filterForContentSafety(activeFiles);
});
ipcMain.handle(
  "get-person-suggestion-files",
  async (_event, personId: string) => {
    if (!canAccessDemoPerson(personId)) return [];
    const person = faceIndexer.getPerson(personId);
    if (!person) return [];
    const files = await readReferencedFiles(person.suggestedPhotoPaths);
    const sources = new Set(await getEnabledIndexSources());
    const activeFiles = filterForEnabledSources(files, sources);
    return person.status === "banned"
      ? filterForNsfw(activeFiles)
      : filterForContentSafety(activeFiles);
  },
);
ipcMain.handle(
  "add-photos-to-person",
  (
    _event,
    imagePaths: unknown,
    target: { personId?: unknown; newName?: unknown },
  ) => {
    requireDemoPersonTarget(target);
    const paths = Array.isArray(imagePaths)
      ? imagePaths.filter(
          (item): item is string =>
            typeof item === "string" && path.isAbsolute(item),
        )
      : [];
    if (paths.length === 0) throw new Error("Select at least one photo.");
    return faceIndexer.recordEdit(
      `Add ${paths.length} photo${paths.length === 1 ? "" : "s"} to person`,
      () =>
        faceIndexer.addPhotosToPerson(
          {
            personId:
              typeof target?.personId === "string"
                ? target.personId
                : undefined,
            newName:
              typeof target?.newName === "string" ? target.newName : undefined,
          },
          paths,
        ),
    );
  },
);
ipcMain.handle(
  "move-person-photos",
  (
    _event,
    sourceId: string,
    imagePaths: unknown,
    target: { personId?: unknown; newName?: unknown } | null,
  ) => {
    requireDemoPersonAccess(sourceId);
    requireDemoPersonTarget(target);
    const paths = Array.isArray(imagePaths)
      ? imagePaths.filter((item): item is string => typeof item === "string")
      : [];
    const cleanTarget = target
      ? {
          personId:
            typeof target.personId === "string" ? target.personId : undefined,
          newName:
            typeof target.newName === "string" ? target.newName : undefined,
        }
      : null;
    const count = `${paths.length} photo${paths.length === 1 ? "" : "s"}`;
    return faceIndexer.recordEdit(
      cleanTarget ? `Move ${count}` : `Remove ${count}`,
      () => faceIndexer.movePhotos(sourceId, paths, cleanTarget),
    );
  },
);
ipcMain.handle("confirm-all-person-photos", (_event, personId: string) => {
  requireDemoPersonAccess(personId);
  return faceIndexer.recordEdit("Confirm all photos", () =>
    faceIndexer.confirmAllPhotos(personId),
  );
}
);
ipcMain.handle(
  "confirm-person-photos",
  (_event, personId: string, imagePaths: unknown) => {
    requireDemoPersonAccess(personId);
    const paths = Array.isArray(imagePaths)
      ? imagePaths.filter((item): item is string => typeof item === "string")
      : [];
    return faceIndexer.recordEdit(`Confirm ${paths.length} photos`, () =>
      faceIndexer.confirmPhotos(personId, paths),
    );
  },
);
ipcMain.handle("train-person", async (_event, personId: string) => {
  requireDemoPersonAccess(personId);
  const detail = await faceIndexer.recordEdit("Train person", () =>
    faceIndexer.trainPerson(personId),
  );
  // Also pick up photos added to any source since the last face pass; suggestions refresh when it finishes.
  await retryIndexRecoveryStage("faces");
  return detail;
});
ipcMain.handle("ban-person", (_event, personId: string) => {
  requireDemoPersonAccess(personId);
  return faceIndexer.recordEdit("Ban person", () =>
    faceIndexer.banPerson(personId),
  );
}
);
ipcMain.handle("unban-person", (_event, personId: string) => {
  requireDemoPersonAccess(personId);
  return faceIndexer.recordEdit("Unban person", () =>
    faceIndexer.unbanPerson(personId),
  );
}
);
ipcMain.handle(
  "accept-person-suggestions",
  (_event, personId: string, imagePaths: unknown) => {
    requireDemoPersonAccess(personId);
    const paths = Array.isArray(imagePaths)
      ? imagePaths.filter((item): item is string => typeof item === "string")
      : [];
    return faceIndexer.recordEdit(`Accept ${paths.length} suggestions`, () =>
      faceIndexer.acceptSuggestions(personId, paths),
    );
  },
);
ipcMain.handle(
  "reject-person-suggestions",
  (_event, personId: string, imagePaths: unknown) => {
    requireDemoPersonAccess(personId);
    const paths = Array.isArray(imagePaths)
      ? imagePaths.filter((item): item is string => typeof item === "string")
      : [];
    return faceIndexer.recordEdit(`Dismiss ${paths.length} suggestions`, () =>
      faceIndexer.rejectSuggestions(personId, paths),
    );
  },
);
ipcMain.handle("create-person", (_event, name: string) => {
  requireDemoPersonSlot();
  return faceIndexer.recordEdit("Create person", () =>
    faceIndexer.createPerson(name),
  );
}
);
ipcMain.handle("rename-person", (_event, personId: string, name: string) => {
  requireDemoPersonAccess(personId);
  return faceIndexer.recordEdit("Rename person", () =>
    faceIndexer.renamePerson(personId, name),
  );
}
);
ipcMain.handle("delete-person", (_event, personId: string) => {
  requireDemoPersonAccess(personId);
  return faceIndexer.recordEdit("Delete person", () =>
    faceIndexer.deletePerson(personId),
  );
}
);
ipcMain.handle(
  "assign-face-to-person",
  (_event, personId: string, faceId: string) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Add face", () =>
      faceIndexer.assignFace(personId, faceId),
    );
  },
);
ipcMain.handle(
  "add-photo-to-person",
  (_event, personId: string, imagePath: string) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Add photo", () =>
      faceIndexer.addPhoto(personId, imagePath),
    );
  },
);
ipcMain.handle(
  "confirm-person-photo",
  (_event, personId: string, imagePath: string) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Confirm photo", () =>
      faceIndexer.confirmPhoto(personId, imagePath),
    );
  },
);
ipcMain.handle(
  "remove-person-photo",
  (_event, personId: string, imagePath: string) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Remove photo", () =>
      faceIndexer.removePhoto(personId, imagePath),
    );
  },
);
ipcMain.handle(
  "set-person-cover-photo",
  (_event, personId: string, photoPath: string | null) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.recordEdit("Change profile picture", () =>
      faceIndexer.setSelectedCoverPhoto(personId, photoPath),
    );
  },
);
ipcMain.handle("get-image-faces", (_event, imagePath: string) =>
  faceIndexer.getFacesForImage(imagePath),
);
ipcMain.handle(
  "update-face-box",
  async (
    _event,
    faceId: string,
    imagePath: string,
    box: { x: number; y: number; width: number; height: number },
  ) =>
    faceIndexer.recordEdit("Move face box", async () =>
      faceIndexer.updateFaceBox(faceId, box, await resolveLocalPath(imagePath)),
    ),
);
ipcMain.handle(
  "create-face-box",
  async (
    _event,
    imagePath: string,
    box: { x: number; y: number; width: number; height: number },
  ) =>
    faceIndexer.recordEdit("Create face box", async () =>
      faceIndexer.createFaceBox(
        imagePath,
        await resolveLocalPath(imagePath),
        box,
      ),
    ),
);
ipcMain.handle("delete-face", (_event, faceId: string) =>
  faceIndexer.recordEdit("Delete detected face", () =>
    faceIndexer.deleteFace(faceId),
  ),
);
ipcMain.handle("get-photo-indicators", async (_event, filePaths: unknown) => {
  if (Array.isArray(filePaths) && filePaths.length > 1000)
    throw new Error(
      "Photo metadata requests must be paged (maximum 1000 files).",
    );
  const paths = Array.isArray(filePaths)
    ? filePaths.filter((item): item is string => typeof item === "string")
    : [];
  const personNames = faceIndexer.getPeopleForImages(paths);
  const visibleNames = new Set(getDemoPeople().map((person) => person.name));
  const result = Object.fromEntries(
    paths.map((filePath) => [
      filePath,
      {
        hasLocation: geoIndexer.hasLocation(filePath),
        locationLabel: geoIndexer.locationLabel(filePath),
        people: (personNames[filePath] ?? []).filter((name) =>
          visibleNames.has(name),
        ),
      },
    ]),
  );
  return result;
});
ipcMain.handle(
  "merge-person",
  (_event, sourcePersonId: string, targetPersonId: string) => {
    requireDemoPersonAccess(sourcePersonId);
    requireDemoPersonAccess(targetPersonId);
    return faceIndexer.recordEdit(
      "Merge people",
      async () =>
        (await faceIndexer.mergePeople(sourcePersonId, targetPersonId)).detail,
    );
  },
);
ipcMain.handle("get-people-edit-history", () => faceIndexer.getEditHistory());
ipcMain.handle("undo-people-edit", async () => ({
  label: await faceIndexer.undo(),
  ...faceIndexer.getEditHistory(),
}));
ipcMain.handle("redo-people-edit", async () => ({
  label: await faceIndexer.redo(),
  ...faceIndexer.getEditHistory(),
}));

ipcMain.handle("get-banned-faces", async () => {
  const visibleIds = new Set(getDemoPeople().map((person) => person.id));
  return (await faceIndexer.getBannedFaces()).filter((person) =>
    visibleIds.has(person.personId),
  );
});
ipcMain.handle(
  "add-banned-face",
  (_event, personId: string, reason: any, confidence: number) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.addBannedFace(personId, reason, confidence);
  },
);
ipcMain.handle("remove-banned-face", (_event, personId: string) => {
  requireDemoPersonAccess(personId);
  return faceIndexer.removeBannedFace(personId);
}
);
ipcMain.handle(
  "set-banned-face-confidence",
  (_event, personId: string, confidence: number) => {
    requireDemoPersonAccess(personId);
    return faceIndexer.setBannedFaceConfidence(personId, confidence);
  },
);

ipcMain.handle("get-pet-state", async () => {
  const sources = new Set(await getEnabledIndexSources());
  const clusters = await Promise.all(
    petIndexer.getClusters().map(async (cluster) => {
      const paths = petIndexer
        .getClusterPhotos(cluster.id)
        .filter((photoPath) => fileIsInEnabledSource(photoPath, sources));
      return paths.length > 0 ? { ...cluster, photoCount: paths.length } : null;
    }),
  );
  return {
    progress: petIndexer.getProgress(),
    clusters: clusters.filter(
      (cluster): cluster is NonNullable<typeof cluster> => cluster !== null,
    ),
  };
});
ipcMain.handle("start-pet-clustering", async () => {
  await retryIndexRecoveryStage("pets");
  return petIndexer.getProgress();
});
ipcMain.handle("pause-pet-clustering", async () => {
  indexRecovery?.pause("pets");
  petIndexer.pause();
  return petIndexer.getProgress();
});
ipcMain.handle(
  "rename-pet-cluster",
  async (_event, clusterId: string, name: string) => {
    await petIndexer.renamePetGroup(clusterId, name);
    // Update name index with pet cluster photos
    const photos = petIndexer.getClusterPhotos(clusterId);
    if (photos.length > 0) {
      await stateStore.updateNameIndex(name, photos, "pet", clusterId);
    }
    return petIndexer.getClusters();
  },
);

ipcMain.handle(
  "update-name-index",
  async (
    _event,
    name: string,
    filePaths: string[],
    sourceType: "person" | "pet" | "manual",
    sourceId?: string,
  ) => {
    return stateStore.updateNameIndex(name, filePaths, sourceType, sourceId);
  },
);

ipcMain.handle(
  "confirm-name-file",
  async (_event, name: string, filePath: string) => {
    return stateStore.confirmNameFile(name, filePath);
  },
);

ipcMain.handle(
  "reject-name-file",
  async (_event, name: string, filePath: string) => {
    return stateStore.rejectNameFile(name, filePath);
  },
);

// Handle isDev check for client
ipcMain.handle("get-lifetime-license", () => readLifetimeLicense());
ipcMain.handle("is-demo-mode", () => !fullAccessEnabled());
ipcMain.handle("get-bug-report-status", () => {
  const configuredEndpoint =
    process.env.SILO_BUG_REPORT_ENDPOINT?.trim() || defaultBugReportEndpoint;
  try {
    const endpoint = new URL(configuredEndpoint);
    if (endpoint.protocol !== "https:")
      throw new Error("HTTPS is required for the report relay.");
    return { available: true, message: "Reports are sent securely by email." };
  } catch {
    return {
      available: false,
      message: "The report relay needs a valid HTTPS endpoint.",
    };
  }
});
ipcMain.handle("capture-bug-report-screenshot", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents)
    throw new Error("The Silo window is not available for capture.");
  const screenshot = await event.sender.capturePage();
  const size = screenshot.getSize();
  const resized =
    size.width > 1600
      ? screenshot.resize({ width: 1600 })
      : screenshot;
  return `data:image/jpeg;base64,${resized.toJPEG(72).toString("base64")}`;
});
ipcMain.handle("submit-bug-report", async (event, input: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents)
    throw new Error("The Silo window is not available to send a report.");
  const configuredEndpoint =
    process.env.SILO_BUG_REPORT_ENDPOINT?.trim() || defaultBugReportEndpoint;

  let endpoint: URL;
  try {
    endpoint = new URL(configuredEndpoint);
  } catch {
    return { ok: false, error: "The report relay endpoint is invalid." };
  }
  if (endpoint.protocol !== "https:")
    return { ok: false, error: "The report relay must use HTTPS." };

  if (!input || typeof input !== "object")
    return { ok: false, error: "Enter a short description before sending." };
  const report = input as {
    message?: unknown;
    feature?: unknown;
    screenshotDataUrl?: unknown;
  };
  const message =
    typeof report.message === "string" ? report.message.trim() : "";
  if (!message || message.length > 5000)
    return {
      ok: false,
      error: "Write a report between 1 and 5,000 characters.",
    };
  const feature =
    typeof report.feature === "string" ? report.feature.trim() : "";
  if (feature.length > 180)
    return { ok: false, error: "The selected feature label is too long." };

  let screenshotBase64: string | null = null;
  if (report.screenshotDataUrl !== undefined && report.screenshotDataUrl !== null) {
    if (
      typeof report.screenshotDataUrl !== "string" ||
      report.screenshotDataUrl.length > maxBugReportScreenshotBytes * 1.4
    )
      return { ok: false, error: "The screenshot exceeds the attachment limit." };
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(
      report.screenshotDataUrl,
    );
    if (!match || Buffer.from(match[1], "base64").length > maxBugReportScreenshotBytes)
      return { ok: false, error: "The screenshot attachment is invalid or too large." };
    screenshotBase64 = match[1];
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15000);
  try {
    const response = await net.fetch(endpoint.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        feature: feature || null,
        screenshotBase64,
        appVersion: app.getVersion(),
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
  } catch {
    return {
      ok: false,
      error: "Silo could not reach the report relay. Your report is still here.",
    };
  } finally {
    clearTimeout(timeout);
  }
});
ipcMain.handle("get-demo-testing-mode", () => ({
  available: lifetimeLicensed,
  enabled: lifetimeLicensed && demoTestingModeEnabled,
}));
ipcMain.handle("set-demo-testing-mode", async (_event, enabledValue: unknown) => {
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
    type: "warning" as const,
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
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (confirmation.response !== 0)
    return {
      available: true,
      enabled: demoTestingModeEnabled,
      restarting: false,
    };

  if (!enabling) queueIndexRecoveryStages(ALL_INDEX_RECOVERY_STAGES);
  await writeDemoTestingMode(enabling);
  app.relaunch();
  app.quit();
  return { available: true, enabled: enabling, restarting: true };
});
ipcMain.handle(
  "get-beta-activation-info",
  async (): Promise<BetaActivationInfo> => ({
    requestCode: createBetaRequestCode(await getBetaInstallationId()),
    requestEmail: BETA_ACTIVATION_REQUEST_EMAIL,
    available: Boolean(BETA_LICENSE_PUBLIC_KEY.trim()),
  }),
);
ipcMain.handle(
  "submit-beta-activation-request",
  async (event): Promise<{ ok: boolean; error?: string }> => {
    if (!mainWindow || event.sender !== mainWindow.webContents)
      return {
        ok: false,
        error: "The Silo window is not available to send the request.",
      };

    const configuredEndpoint =
      process.env.SILO_BETA_REQUEST_ENDPOINT?.trim() || defaultBetaRequestEndpoint;
    let endpoint: URL;
    try {
      endpoint = new URL(configuredEndpoint);
    } catch {
      return { ok: false, error: "The beta request relay endpoint is invalid." };
    }
    if (endpoint.protocol !== "https:")
      return { ok: false, error: "The beta request relay must use HTTPS." };

    const payload = createBetaActivationRequestPayload(
      await getBetaInstallationId(),
      app.getVersion(),
      process.platform,
    );
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15000);
    try {
      const response = await net.fetch(endpoint.href, {
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
    } catch {
      return {
        ok: false,
        error: "Silo could not reach the beta request relay. Try again when online.",
      };
    } finally {
      clearTimeout(timeout);
    }
  },
);
ipcMain.handle(
  "activate-beta-license",
  async (_event, activationCodeValue: unknown): Promise<BetaActivationResult> => {
    if (typeof activationCodeValue !== "string")
      return {
        status: "invalid",
        message:
          "Paste the beta activation code you received from Silo's developer.",
      };
    if (!BETA_LICENSE_PUBLIC_KEY.trim())
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
    const payload = verifyBetaActivationCode(
      activationCode,
      BETA_LICENSE_PUBLIC_KEY,
      installationId,
    );
    if (!payload)
      return {
        status: "invalid",
        message:
          "That code is invalid or belongs to a different Silo installation. Check that you copied the full code.",
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
    } catch {
      return {
        status: "error",
        message: "Silo could not save the beta license on this device.",
      };
    }
  },
);
ipcMain.handle(
  "verify-lifetime-payment",
  async (_event, signatureValue: unknown): Promise<LifetimePaymentVerification> => {
    if (typeof signatureValue !== "string")
      return {
        status: "invalid",
        message: "Paste the transaction signature shown by your Solana wallet.",
      };
    if (!isSolanaTransactionSignature(signatureValue))
      return verifyParsedLifetimePayment(signatureValue, {});

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
          message:
            "Helius could not be reached or is rate-limiting requests. Please try again shortly.",
        };
      const verification = verifyParsedLifetimePayment(
        signatureValue,
        rpcResponse.result,
      );
      if (verification.status !== "verified") return verification;

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
    } catch {
      return {
        status: "error",
        message:
          "Could not verify with Solana right now. Check your connection and try again; no license status was changed.",
      };
    }
  },
);
ipcMain.handle(
  "check-lifetime-payment-reference",
  async (_event, referenceValue: unknown): Promise<LifetimePaymentVerification> => {
    if (
      typeof referenceValue !== "string" ||
      !isSolanaPayReference(referenceValue)
    )
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
      const signaturesResponse = await requestLifetimeRpc(
        "getSignaturesForAddress",
        [referenceValue, { commitment: "finalized", limit: 5 }],
      );
      if (!signaturesResponse.ok)
        return {
          status: "error",
          message:
            "Helius could not be reached or is rate-limiting requests. Silo will keep checking.",
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
        if (
          typeof signatureValue !== "string" ||
          !isSolanaTransactionSignature(signatureValue)
        )
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
            message:
              "Helius could not finish verifying this payment. Silo will keep checking.",
          };
        const verification = verifyParsedLifetimePayment(
          signatureValue,
          transactionResponse.result,
        );
        if (verification.status !== "verified") continue;

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
        message:
          "Waiting for a finalized $25 USDC payment from this request. Keep this window open; Silo will activate it automatically.",
      };
    } catch {
      return {
        status: "error",
        message:
          "Could not check Solana right now. Silo will keep checking; no license status was changed.",
      };
    }
  },
);
ipcMain.handle("is-dev", () => isDev);
ipcMain.handle("get-app-update-state", () => appUpdateState);
ipcMain.handle("check-app-updates", () => checkForAppUpdates());
ipcMain.handle("download-and-install-app-update", () =>
  downloadAndInstallAppUpdate(),
);

ipcMain.handle("open-full-disk-access", async () => {
  await shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  );
});

/** Reveals the running bundle so it can be dragged into the Full Disk Access list. */
ipcMain.handle("reveal-app-bundle", () => {
  const executablePath = app.getPath("exe");
  const bundleMatch = /^(.*\.app)\//.exec(executablePath);
  shell.showItemInFolder(bundleMatch ? bundleMatch[1] : executablePath);
});

ipcMain.handle("get-access-identity", () => {
  const executablePath = app.getPath("exe");
  const bundleMatch = /^(.*\.app)\//.exec(executablePath);
  const bundlePath = bundleMatch ? bundleMatch[1] : executablePath;
  return {
    displayName: app.getName(),
    bundlePath,
    // The dev bundle still lists as "Electron" until npm run brand-dev is used.
    isDev,
  };
});

// Phone connectivity

ipcMain.handle("get-phone-tooling", () => phoneManager.getTooling());
ipcMain.handle("get-phone-backup-states", () => phoneManager.getBackupStates());

ipcMain.handle("get-phone-restore-archives", () =>
  phoneManager.getRestoreArchives(),
);

ipcMain.handle(
  "create-phone-restore-archive",
  async (_event, deviceId: unknown, platform: unknown, password: unknown) => {
    if (
      typeof deviceId !== "string" ||
      !deviceId ||
      platform !== "ios" ||
      typeof password !== "string"
    )
      throw new Error("Invalid iPhone restore-archive request.");
    const device = scannedPhoneDevices.find(
      (candidate) =>
        candidate.id === deviceId &&
        candidate.platform === "ios" &&
        candidate.status === "ready",
    );
    if (!device) throw new Error("Connect and trust the iPhone or iPad first.");
    if (!mainWindow || mainWindow.isDestroyed())
      throw new Error("The app window is unavailable to confirm this device backup.");
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Enable encrypted device backups?",
      message: `Create an encrypted restore archive for ${device.name}?`,
      detail:
        "Silo will enable encrypted iPhone backups if needed. The password is never saved by Silo; if you forget it, this archive cannot be restored. Keep the device connected and powered during the backup.",
      buttons: ["Cancel", "Create encrypted archive"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return null;
    const archive: PhoneRestoreArchive = await phoneManager.createRestoreArchive(
      device,
      password,
    );
    return archive;
  },
);

ipcMain.handle(
  "restore-phone-from-archive",
  async (_event, deviceId: unknown, platform: unknown, archiveId: unknown, password: unknown) => {
    if (
      typeof deviceId !== "string" ||
      !deviceId ||
      platform !== "ios" ||
      typeof archiveId !== "string" ||
      !archiveId ||
      typeof password !== "string"
    )
      throw new Error("Invalid iPhone restore request.");
    const device = scannedPhoneDevices.find(
      (candidate) =>
        candidate.id === deviceId &&
        candidate.platform === "ios" &&
        candidate.status === "ready",
    );
    if (!device) throw new Error("Connect and trust the iPhone or iPad first.");
    const archive = (await phoneManager.getRestoreArchives()).find(
      (candidate) => candidate.id === archiveId,
    );
    if (!archive) throw new Error("The selected restore archive is unavailable.");
    if (!device.model || archive.deviceModel !== device.model)
      throw new Error("The archive can only restore to the same iPhone or iPad model.");
    if (!mainWindow || mainWindow.isDestroyed())
      throw new Error("The app window is unavailable to confirm this device restore.");
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Restore iPhone or iPad?",
      message: `Restore ${device.name} from ${archive.deviceName}’s ${new Date(archive.createdAt).toLocaleString()} archive?`,
      detail:
        "Restoring writes the saved data and settings to the connected device and can replace current content. Keep it connected and powered, and do not interrupt the restore.",
      buttons: ["Cancel", "Restore device"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return false;
    await phoneManager.restoreDeviceFromArchive(device, archiveId, password);
    return true;
  },
);

ipcMain.handle(
  "set-phone-backup-destination",
  async (_event, destination: string | null) => {
    if (typeof destination !== "string" && destination !== null) return null;
    const result = await phoneManager.setBackupDestination(destination);
    phoneManagerBackupDestination = result;
    // Also update message backup destination to use the same location
    messageExportCoordinator.setBackupDestination(destination);
    console.log(
      `[MAIN] Phone backup destination updated to: ${destination || "default"}`,
    );
    return result;
  },
);

ipcMain.handle("get-phone-backup-destination", async () => {
  const dest = await phoneManager.getBackupDestination();
  console.log(`[IPC] get-phone-backup-destination returning: ${dest}`);
  return dest;
});

ipcMain.handle(
  "rename-phone",
  async (_event, id: unknown, platform: unknown, name: unknown) => {
    if (
      typeof id !== "string" ||
      !id ||
      (platform !== "ios" && platform !== "android") ||
      typeof name !== "string"
    )
      throw new Error("Invalid phone rename request.");
    const savedName = await phoneManager.renameDevice(id, platform, name);
    scannedPhoneDevices = scannedPhoneDevices.map((device) =>
      device.id === id && device.platform === platform
        ? { ...device, name: savedName }
        : device,
    );
    sendToRenderer("phone-devices-changed", scannedPhoneDevices);
    return scannedPhoneDevices;
  },
);

ipcMain.handle("list-phones", async () => {
  console.log("[IPC] list-phones handler called");
  try {
    // Set a timeout for device discovery to prevent UI from hanging
    const discoveryPromise = discoverAndBackupPhones();
    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("Phone discovery timed out after 30 seconds")),
        30000,
      );
    });
    await Promise.race([discoveryPromise, timeoutPromise]);
    console.log(
      "[IPC] list-phones: returning",
      scannedPhoneDevices.length,
      "devices",
    );
    return scannedPhoneDevices;
  } catch (error) {
    console.error("[IPC] list-phones error:", error);
    return [];
  }
});

ipcMain.handle(
  "connect-phone",
  async (_event, deviceId: string, platform: PhonePlatform) => {
    if (typeof deviceId !== "string" || !deviceId) return null;
    if (platform !== "ios" && platform !== "android") return null;
    const connected = await phoneManager.connect(deviceId, platform);
    scannedPhoneDevices = await phoneManager.listDevices();
    if (connected.status === "ready" && connected.rootPath) {
      void phoneManager.backupDevice(connected);
      void indexNewSources([connected.rootPath], "phone-connected");
    }
    return connected;
  },
);

ipcMain.handle(
  "disconnect-phone",
  async (_event, deviceId: string, platform: PhonePlatform) => {
    if (typeof deviceId !== "string" || !deviceId) return;
    if (platform !== "ios" && platform !== "android") return;
    await phoneManager.disconnect();
    scannedPhoneDevices = scannedPhoneDevices.filter(
      (device) => device.id !== deviceId || device.platform !== platform,
    );
  },
);

// Google Drive and Google Photos

ipcMain.handle("get-google-state", () => googleManager.getState());

ipcMain.handle("google-add-account", async () => {
  if (
    isDemoLimitReached(
      fullAccessEnabled(),
      await getDemoSourceCount(),
      DEMO_LIMITS.sources,
    )
  ) {
    notifyDemoLimitReached("sources");
    return googleManager.getState();
  }
  const before = new Set(
    googleManager.getState().accounts.map((account) => account.driveRootPath),
  );
  const state = await googleManager.addAccount();
  await getEnabledIndexSources();
  const newPaths = state.accounts
    .map((account) => account.driveRootPath)
    .filter((sourcePath) => !before.has(sourcePath));
  void indexNewSources(newPaths, "google-account-added");
  return state;
});

ipcMain.handle("google-remove-account", (_event, accountId: string) =>
  googleManager.removeAccount(accountId),
);

ipcMain.handle(
  "google-start-photo-picker",
  async (_event, accountId: string) => {
    const account = googleManager
      .getState()
      .accounts.find((item) => item.id === accountId);
    if (
      account?.pickedCount === 0 &&
      isDemoLimitReached(
        fullAccessEnabled(),
        await getDemoSourceCount(),
        DEMO_LIMITS.sources,
      )
    ) {
      notifyDemoLimitReached("sources");
      return {
        error: `The demo includes up to ${DEMO_LIMITS.sources} active sources. Unlock Silo to add Google Photos.`,
      };
    }
    try {
      return await googleManager.startPhotoPicker(accountId);
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Could not open picker.",
      };
    }
  },
);

ipcMain.handle(
  "google-poll-photo-picker",
  async (_event, accountId: string, sessionId: string) => {
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
        if (
          account?.photosRootPath &&
          addsPhotoSource &&
          isDemoLimitReached(
            fullAccessEnabled(),
            sourceCountBeforePoll,
            DEMO_LIMITS.sources,
          )
        ) {
          googleManager.clearPickedPhotos(accountId);
          sourceListCacheAt = 0;
          notifyDemoLimitReached("sources");
          return {
            ready: false,
            count: 0,
            error: `The demo includes up to ${DEMO_LIMITS.sources} active sources. Unlock Silo to add Google Photos.`,
          };
        }
        if (account?.photosRootPath)
          void indexNewSources([account.photosRootPath], "google-photos-added");
      }
      return result;
    } catch {
      return { ready: false, count: 0 };
    }
  },
);

ipcMain.handle("google-clear-picked-photos", (_event, accountId?: string) => {
  googleManager.clearPickedPhotos(accountId);
  return googleManager.getState();
});

ipcMain.handle("google-export-photos", async (_event, accountId?: string) => {
  if (!mainWindow) return { ok: false, error: "App window is unavailable." };

  const state = googleManager.getState();
  const sourcePath = accountId
    ? state.accounts.find((account) => account.id === accountId)?.photosRootPath
    : state.allPhotosPath;
  if (!sourcePath) return { ok: false, error: "No picked photos." };

  const files = await googleManager.listFiles(sourcePath, false);
  if (files.length === 0)
    return { ok: false, error: "Pick some photos first." };

  const chosen = await dialog.showOpenDialog(mainWindow, {
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
      while (
        await fsPromises.access(destinationPath).then(
          () => true,
          () => false,
        )
      ) {
        destinationPath = path.join(
          chosen.filePaths[0],
          `${parsedName.name} (${suffix})${parsedName.ext}`,
        );
        suffix += 1;
      }
      const localPath = await googleManager.materialize(file.path);
      await fsPromises.copyFile(localPath, destinationPath);
      copied += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok: failed === 0, copied, failed };
});

// Unified sources

ipcMain.handle("list-sources", () => listSources());

ipcMain.handle("get-library-share-status", () =>
  libraryShareServer?.getStatus() ?? { active: false, sources: [] },
);

ipcMain.handle("start-library-share", async (_event, sourceIds: unknown) => {
  if (!libraryShareServer || !semanticIndexer?.isLoaded())
    throw new Error("Silo is still loading its search index.");
  if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== "string"))
    throw new Error("Choose one or more local libraries to share.");
  return libraryShareServer.start(sourceIds as string[]);
});

ipcMain.handle("stop-library-share", async () => {
  await libraryShareServer?.stop();
  return libraryShareServer?.getStatus() ?? { active: false, sources: [] };
});

ipcMain.handle("get-all-sources-path", () => ALL_SOURCES_PATH);

ipcMain.handle(
  "set-source-enabled",
  async (_event, sourceId: string, enabled: boolean) => {
    if (typeof sourceId !== "string" || !sourceId) return listSources();
    const shouldEnable = Boolean(enabled);
    const target = (await listSources()).find((source) => source.id === sourceId);
    const phoneTarget = target
      ? phoneManager.parsePhonePath(target.rootPath)
      : null;
    let phonePeers: BrowseSource[] = [];
    if (shouldEnable && phoneTarget) {
      phonePeers = (await listSources()).filter((source) => {
        const parsed = phoneManager.parsePhonePath(source.rootPath);
        return (
          parsed &&
          parsed.platform === phoneTarget.platform &&
          parsed.deviceId === phoneTarget.deviceId &&
          source.id !== sourceId
        );
      });
    }
    if (!fullAccessEnabled() && shouldEnable && target && !target.enabled) {
      const replacedIds = new Set(phonePeers.map((source) => source.id));
      const activeRoots = new Set(
        (await listSources())
          .filter(
            (source) =>
              source.enabled &&
              source.available &&
              source.rootPath.trim() &&
              !source.demoLocked &&
              !replacedIds.has(source.id),
          )
          .map((source) => source.rootPath),
      );
      if (
        !activeRoots.has(target.rootPath) &&
        activeRoots.size >= DEMO_LIMITS.sources
      ) {
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
      void indexNewSources([target!.rootPath], "phone-source-enabled");
    await semanticIndexer.startWatching(await getAllIndexSources());
    return listSources();
  },
);

ipcMain.handle("set-all-sources-enabled", async (_event, enabled: boolean) => {
  const sources = await listSources();
  const allIds = sources.map((source) => source.id);
  if (!enabled) {
    await stateStore.setAllSourcesEnabled(allIds, false);
  } else {
    const selectedPhoneSources = new Map<string, BrowseSource>();
    for (const source of sources) {
      const parsed = phoneManager.parsePhonePath(source.rootPath);
      if (!parsed || !source.available) continue;
      const key = `${parsed.platform}:${parsed.deviceId}`;
      const current = selectedPhoneSources.get(key);
      if (
        !current ||
        (source.offlineBackup &&
          (!current.offlineBackup ||
            (source.snapshotAt ?? 0) > (current.snapshotAt ?? 0)))
      )
        selectedPhoneSources.set(key, source);
    }
    const chosenIds = new Set(
      sources
        .filter(
          (source) =>
            !source.demoLocked &&
            !phoneManager.parsePhonePath(source.rootPath),
        )
        .map((source) => source.id),
    );
    for (const source of selectedPhoneSources.values())
      if (!source.demoLocked) chosenIds.add(source.id);
    if (!fullAccessEnabled()) {
      const allowedRoots = new Set<string>();
      const allowedIds = new Set<string>();
      let overLimit = false;
      for (const source of sources) {
        if (!chosenIds.has(source.id) || !source.available || !source.rootPath)
          continue;
        if (
          allowedRoots.has(source.rootPath) ||
          allowedRoots.size < DEMO_LIMITS.sources
        ) {
          allowedRoots.add(source.rootPath);
          allowedIds.add(source.id);
        } else {
          overLimit = true;
        }
      }
      chosenIds.clear();
      for (const sourceId of allowedIds) chosenIds.add(sourceId);
      if (overLimit) notifyDemoLimitReached("sources");
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

ipcMain.handle(
  "google-create-folder",
  async (_event, parentPath: string, name: string) => {
    try {
      await googleManager.createDriveFolder(parentPath, name);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not create folder.",
      };
    }
  },
);

ipcMain.handle(
  "google-rename-file",
  async (_event, filePath: string, name: string) => {
    try {
      await googleManager.renameDriveFile(filePath, name);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not rename file.",
      };
    }
  },
);

ipcMain.handle("google-trash-file", async (_event, filePath: string) => {
  try {
    await googleManager.trashDriveFile(filePath);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not trash file.",
    };
  }
});

ipcMain.handle("google-upload-file", async (_event, parentPath: string) => {
  if (!mainWindow) return { ok: false, error: "App window is unavailable." };
  const picked = await dialog.showOpenDialog(mainWindow, {
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
    } catch {
      failed += 1;
    }
  }
  return { ok: failed === 0, copied, failed };
});

// Message Export IPC Handlers
ipcMain.handle(
  "export-messages",
  async (
    _event,
    accountId: string,
    deviceId: string,
    outputDir: string,
    format: "xml" | "pdf" | "both",
    platform: "ios" | "android" = "android",
    threadIds?: string[],
  ) => {
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
    } catch (error) {
      return {
        success: false,
        threadCount: 0,
        messageCount: 0,
        attachmentCount: 0,
        error: (error as Error).message,
      };
    }
  },
);

ipcMain.handle(
  "get-message-threads",
  async (
    _event,
    deviceId: string,
    platform: "ios" | "android",
    refresh = false,
  ) => {
    try {
      const device = scannedPhoneDevices.find(
        (item) => item.id === deviceId && item.platform === platform,
      );
      if (refresh && (!device || device.status !== "ready"))
        throw new Error(
          "Connect and trust this phone before updating its message backup.",
        );
      // Ensure the latest backup destination is synced to messageManager
      const currentDest = await phoneManager.getBackupDestination();
      messageExportCoordinator.setBackupDestination(currentDest);
      const threads = await messageExportCoordinator.getDeviceThreads(
        deviceId,
        platform,
        refresh,
        device?.name ?? deviceId,
      );
      return { ok: true, threads };
    } catch (error) {
      return {
        ok: false,
        threads: [],
        error:
          error instanceof Error ? error.message : "Could not load messages.",
      };
    }
  },
);

ipcMain.handle(
  "get-message-attachment-data-url",
  async (_event, deviceId: string, messageId: string, partId: string) => {
    try {
      return await messageExportCoordinator.getMessageAttachmentDataUrl(
        deviceId,
        messageId,
        partId,
      );
    } catch (error) {
      runtimeLog("message-attachment-read-failed", {
        messageId,
        partId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
);

ipcMain.handle("list-message-history", () =>
  messageExportCoordinator.listMessageHistory(),
);

ipcMain.handle("list-message-backups", async (_event, baseDir: string) => {
  try {
    const backups =
      await messageExportCoordinator.listAvailableBackups(baseDir);
    return backups;
  } catch (error) {
    return [];
  }
});

ipcMain.handle(
  "restore-messages",
  async (_event, backupPath: string, deviceId: string) => {
    try {
      const result = await messageExportCoordinator.restoreMessages(
        backupPath,
        deviceId,
      );
      return result;
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  },
);

// Contact management
ipcMain.handle("get-all-contacts", async () => {
  return contactManager.getAllContacts();
});

ipcMain.handle(
  "set-contact-name",
  async (_event, phoneNumber: string, savedName: string | null) => {
    try {
      await contactManager.setContactName(phoneNumber, savedName);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not save contact.",
      };
    }
  },
);

ipcMain.handle("get-contact-name", async (_event, phoneNumber: string) => {
  return contactManager.getContactName(phoneNumber) || null;
});

ipcMain.handle("select-backup-destination", async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Backup Destination",
    properties: ["openDirectory"],
  });

  if (!result.canceled && result.filePaths[0]) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle("get-index-storage-root", () => selectedIndexStorageRoot);
ipcMain.handle("get-index-storage-status", () => currentIndexStorageStatus());
ipcMain.handle("get-local-index-fallback-enabled", () => indexStorageFallbackEnabled);
ipcMain.handle("set-local-index-fallback-enabled", async (_event, enabled: boolean) => {
  if (typeof enabled !== "boolean")
    throw new Error("Choose whether Silo may use a local cache fallback.");
  await setLocalIndexStorageFallback(app.getPath("userData"), enabled);
  indexStorageFallbackEnabled = enabled;
  await monitorIndexStorageAvailability();
  return { enabled, restarting: indexStorageRelaunchPending };
});

ipcMain.handle("select-index-storage-root", async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Silo Cache Destination",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };

  const storageRoot = path.resolve(result.filePaths[0]);
  if (storageRoot === path.resolve(indexStorageRoot))
    return { canceled: false, path: indexStorageRoot };

  try {
    const { requiredBytes } = await validateIndexStorageDestination(
      app.getPath("userData"),
      storageRoot,
    );
    const confirmation = await dialog.showMessageBox(mainWindow, {
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

    await stageIndexStorageRoot(app.getPath("userData"), storageRoot);
    app.relaunch();
    app.quit();
    return { canceled: false, restarting: true, path: storageRoot };
  } catch (error) {
    return {
      canceled: false,
      error: error instanceof Error ? error.message : "Could not select this cache destination.",
    };
  }
});

ipcMain.handle(
  "start-face-indexing-for-source",
  async (_event, sourcePath: string) => {
    try {
      // Face coverage is independent of source selection; preserve UI checkboxes.
      await retryIndexRecoveryStage("faces");

      return {
        success: true,
        message: "Indexing started",
        progress: faceIndexer.getProgress(),
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
      };
    }
  },
);

ipcMain.handle("get-face-index-progress", async (_event, _deviceId: string) => {
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
  } catch (error) {
    return null;
  }
});
