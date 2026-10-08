declare module "electron-is-dev" {
  const isDev: boolean;
  export default isDev;
}

interface FileInfo {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: number;
  created?: number;
  isDirectory: boolean;
  type: string;
  extension: string;
  sourceId?: string;
  sourceLabel?: string;
  backupTimestamp?: number;
  duplicateFiles: number;
  sourceSnapshotAt?: number;
}

interface FilePreview {
  name: string;
  size: number;
  modified: string;
  mimeType: string | null;
  extension: string;
  path: string;
  previewDataUrl: string | null;
  mediaUrl?: string;
  playbackMimeType?: string | null;
  transcoded?: boolean;
  documentPreview?: import("./documentPreview").DocumentPreview;
}

interface GeoPhoto extends FileInfo {
  sourcePath: string;
  latitude: number;
  longitude: number;
  city: string | null;
  region: string | null;
  country: string | null;
  locationLabel: string;
  locationSource: "embedded" | "manual";
}

interface GeoLocationSuggestion {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
}

interface GeoOverride {
  file: FileInfo & { sourcePath: string };
  location: GeoLocationSuggestion;
  updatedAt: number;
}

interface GeoAssignmentResult {
  appState: PersistedAppState;
  geoState: GeoIndexState;
}

interface GeoIndexState {
  status: "idle" | "scanning" | "complete" | "error";
  scanned: number;
  total: number;
  geotagged: number;
  message: string;
  photos: GeoPhoto[];
  photosVersion: number;
}

type GeoIndexStatus = Omit<GeoIndexState, "photos">;

interface StartupState {
  ready: boolean;
  step: number;
  total: number;
  label: string;
}

type PhonePlatform = "ios" | "android";

type PhoneStatus =
  | "ready"
  | "untrusted"
  | "unauthorized"
  | "offline"
  | "connected"
  | "error";

interface PhoneDevice {
  id: string;
  platform: PhonePlatform;
  name: string;
  model: string | null;
  status: PhoneStatus;
  rootPath: string | null;
  message: string;
}

interface PhoneToolingEntry {
  available: boolean;
  missing: string[];
  installHint: string;
}

interface PhoneTooling {
  ios: PhoneToolingEntry;
  android: PhoneToolingEntry;
}

interface PhoneBackupProgress {
  deviceId: string;
  platform: PhonePlatform;
  deviceName: string;
  status: "idle" | "scanning" | "backing-up" | "complete" | "error";
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  completedBytes: number;
  copiedFiles: number;
  failedFiles: number;
  currentFile: string | null;
  message: string;
  lastBackupAt: number | null;
}

interface PhoneRestoreArchive {
  id: string;
  deviceId: string;
  platform: "ios";
  deviceName: string;
  deviceModel: string | null;
  backupRoot?: string;
  archivePath: string;
  createdAt: number;
  encrypted: true;
}

interface GoogleAccountSummary {
  id: string;
  email: string;
  driveRootPath: string;
  photosRootPath: string;
  pickedCount: number;
  needsReauth: boolean;
}

interface GoogleAccountsState {
  configured: boolean;
  accounts: GoogleAccountSummary[];
  allDrivesPath: string;
  allPhotosPath: string;
  totalPickedCount: number;
  message: string;
}

interface ScanIssues {
  directoryPath: string;
  fileCount: number;
  denied: number;
  unreadable: number;
  isTimeMachine: boolean;
}

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
  offlineBackup?: boolean;
  snapshotAt?: number;
  lastClonedAt?: number;
  lastCloneDestination?: string;
}

interface PhotoPickerSession {
  pickerUri?: string;
  sessionId?: string;
  accountId?: string;
  error?: string;
}

interface FileOperationResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  copied?: number;
  failed?: number;
}

interface PersistedUiState {
  currentPath: string | null;
  exploded: boolean;
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
  viewMode: "list" | "grid";
  showFilters: boolean;
  confidence: number;
}

interface IndexSource {
  path: string;
  addedAt: number;
  kind?: "machine";
}

interface DigitalFolder {
  id: string;
  name: string;
  filePaths: string[];
  createdAt: number;
  hidden?: boolean;
}

interface FileMetadata {
  displayName?: string;
  year?: number;
  keywords: string[];
  updatedAt: number;
}

interface ContentPreferences {
  showNsfw: boolean;
  safeSearch: boolean;
  theme: "system" | "dark" | "light";
  autoplayGlobe: boolean;
  showBannedPeople: boolean;
}

interface PublicContentSettings extends ContentPreferences {
  parentalPasswordSet: boolean;
}

interface DuplicateGroup {
  id: string;
  sourceId: string;
  hash: string;
  size: number;
  reclaimableBytes: number;
  keepPath: string;
  files: Array<FileInfo & { hash: string }>;
}

interface DuplicateTrashEntry {
  id: string;
  originalPath: string;
  trashPath: string;
  size: number;
  hash: string;
  deletedAt: number;
}

interface DuplicateState {
  status: "idle" | "scanning" | "complete" | "error";
  scanned: number;
  total: number;
  duplicateFiles: number;
  reclaimableBytes: number;
  trashBytes: number;
  permanentlyClearedBytes: number;
  message: string;
  groups: DuplicateGroup[];
  trash: DuplicateTrashEntry[];
}

interface DeviceMessage {
  id: string;
  address: string;
  body: string;
  date: number;
  type: 1 | 2;
  read: 0 | 1;
  threadId?: string;
  parts?: DeviceMessagePart[];
}

interface DeviceMessagePart {
  id: string;
  contentType: string;
  text?: string;
  fileName?: string;
  attachmentAvailable?: boolean;
  attachmentSize?: number;
}

interface DeviceMessageThread {
  threadId: string;
  address: string;
  displayName?: string;
  messageCount: number;
  lastMessageDate: number;
  messages: DeviceMessage[];
}

interface MessageHistoryEntry {
  deviceId: string;
  platform: PhonePlatform;
  deviceName: string;
  threadCount: number;
  lastMessageDate: number;
}

interface IndexingStageProgress {
  id: string;
  label: string;
  status: string;
  processed: number;
  total: number;
  unit: string;
  message: string;
  errors?: number;
  retryable?: number;
  detail?: string;
  canRetry?: boolean;
  attempts?: number;
  recoveryError?: string;
  retryAt?: number;
  retryExhausted?: boolean;
  resumeQueued?: boolean;
  recoveryRunning?: boolean;
  blockedReason?: string;
  persistenceError?: string;
}

type LibraryCategory = "image" | "video" | "audio" | "document" | "archive" | "other";

interface LibraryCategoryCounts {
  [category: string]: { files: number; bytes: number };
}

interface LibraryDashboardSource extends BrowseSource {
  status: "scanning" | "ready" | "offline" | "pending" | "error";
  scannedAt: number;
  fileCount: number | null;
  totalBytes: number | null;
  unknownSizeFiles: number | null;
  categories: LibraryCategoryCounts;
  error: string;
  overlapsAnotherSource: boolean;
  stale: boolean;
  hasVerifiedCopy: boolean;
  lastVerifiedAt: number | null;
  shelterFreshness: "unknown" | "green" | "yellow" | "orange" | "red" | "blinking-red";
  shelterBackups: Array<{
    destination: string;
    clonePath: string | null;
    lastVerifiedAt: number | null;
    lastResult: "verified" | "mismatch" | "missing" | "error";
    verifiedFiles: number;
    totalFiles: number;
  }>;
  shelterAuditResult: "verified" | "mismatch" | "missing" | "error" | null;
  shelterAuditMessage: string;
  shelterVerifiedFiles: number;
  shelterTotalFiles: number;
  cloneDestination: string | null;
  shelterState: "unprotected" | "verified" | "changed" | "checking" | "offline" | "unknown";
  indexedFiles: number;
  indexingErrors: number;
}

interface LibraryDashboardSnapshot {
  running: boolean;
  progress: {
    currentSourceId: string | null;
    currentSource: string;
    sourceIndex: number;
    sourceCount: number;
    scannedEntries: number;
    currentSourceFiles: number;
    message: string;
  };
  totals: {
    fileCount: number;
    totalBytes: number;
    unknownSizeFiles: number;
    categories: LibraryCategoryCounts;
    sourceCount: number;
    uniqueSourceCount: number;
    staleSourceCount: number;
    lastInventoryAt: number;
  };
  sources: LibraryDashboardSource[];
  indexedFiles: number;
  indexingErrors: number;
  shelter: {
    destination: string | null;
    destinationAvailable: boolean;
    snapshotAvailable: boolean;
    replicas: Array<{ path: string; verifiedAt: number; replicaOf: string }>;
    verifiedSources: number;
    totalSources: number;
    percentage: number;
    freshness: "unknown" | "green" | "yellow" | "orange" | "red" | "blinking-red";
  };
}

interface RuntimeDiagnosticRead {
  entries: Array<Record<string, unknown>>;
  cursor: number;
  truncated: boolean;
}

interface ThumbnailPregenProgress {
  status: "idle" | "waiting" | "scanning" | "generating" | "complete" | "error";
  total: number;
  processed: number;
  generated: number;
  failed: number;
  message: string;
}

interface IndexProgress {
  status:
    | "idle"
    | "scanning"
    | "loading-model"
    | "indexing"
    | "paused"
    | "complete"
    | "error";
  total: number;
  indexed: number;
  remaining: number;
  errors: number;
  currentFile: string | null;
  message: string;
}

interface FileScanProgress {
  inventory?: { inventoryToken: string; total: number };
  requestId: number;
  directoryPath: string;
  files?: FileInfo[];
  fileDeltas?: FileInfo[];
  scanned: number;
  total: number;
  audioFound?: number;
  done: boolean;
  isTimeMachine: boolean;
  errors: number;
}

interface CachedAudioFile extends FileInfo {}

interface AudioLibraryCacheSnapshot {
  version: 1;
  sourceIds: string[];
  scannedAt: number;
  files: CachedAudioFile[];
  extensions: string[];
  stale?: boolean;
  failedSources?: string[];
  sourceScannedAt?: Record<string, number>;
  sourceCooldownUntil?: Record<string, number>;
  sourceErrors?: Record<string, { message: string; lastAttemptAt: number }>;
}

interface AudioLibraryScanProgress {
  requestId: number;
  source: string;
  scanned: number;
  audioFound: number;
  sourceIndex: number;
  sourceCount: number;
  phase: "scanning" | "retrying" | "cooldown" | "source-complete";
  message: string;
  files?: FileInfo[];
}

interface SourceCloneProgress {
  operationId: string;
  phase:
    | "scanning"
    | "checking-space"
    | "copying"
    | "verifying"
    | "complete"
    | "error"
    | "cancelled";
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

interface SourceClonePreflight {
  planId: string;
  destinations: Array<{
    destination: string;
    cloneRoot: string;
    freeBytes: number;
    shortfallBytes: number;
  }>;
  totalSources: number;
  sourceLabels: string[];
  totalFiles: number;
  totalBytes: number;
  duplicateFiles: number;
}

interface PersistedAppState {
  version: 1;
  ui: PersistedUiState;
  indexSources: IndexSource[];
  digitalFolders: DigitalFolder[];
  fileMetadata: Record<string, FileMetadata>;
  geoOverrides: Record<string, GeoOverride>;
  indexProgress?: IndexProgress;
}

interface SemanticSearchResult extends FileInfo {
  confidence: number;
  _priority?: 0 | 1 | 2 | 3; // 0=user metadata, 1=name, 2=folder, 3=semantic
  _source?: string; // Human-readable source: "Named as: John", "In folder: yoshimi"
}

interface SemanticSearchProgress {
  requestId: number;
  status: "searching" | "done";
  results: SemanticSearchResult[];
  scanned: number;
  total: number;
}

interface FaceIndexProgress {
  status:
    | "idle"
    | "loading-model"
    | "indexing"
    | "paused"
    | "complete"
    | "error";
  total: number;
  processed: number;
  remaining: number;
  faces: number;
  people: number;
  errors: number;
  currentFile: string | null;
  message: string;
}

interface PersonSummary {
  id: string;
  name: string;
  faceCount: number;
  photoCount: number;
  coverCropUrl: string | null;
  manual: boolean;
  selectedCoverPhotoPath?: string | null;
  confirmedCount: number;
  reviewableCount: number;
  hiddenCount: number;
  fullyConfirmed: boolean;
  status: "unconfirmed" | "confirmed" | "banned";
  suggestedCount: number;
  trainedAt: number | null;
}

interface PersonDetail extends PersonSummary {
  photoPaths: string[];
  confirmedPhotoPaths: string[];
  suggestedPhotoPaths: string[];
  faces: Array<{
    id: string;
    imagePath: string;
    cropUrl: string;
    score: number;
  }>;
}

interface ImageFace {
  id: string;
  imagePath: string;
  box: { x: number; y: number; width: number; height: number };
  cropUrl: string;
  score: number;
  personIds: string[];
}

interface PetIndexProgress {
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

interface PetCluster {
  id: string;
  name: string;
  photoCount: number;
  coverPhotoPath: string | null;
  selectedCoverPhotoPath?: string | null; // User-selected PFP, prioritized first
}

interface SiloConfigManifest {
  format: string;
  version: number;
  exportedAt: number;
  appVersion: string;
  entries: string[];
  rendererPrefs: Record<string, string>;
}

interface MagicRankResult {
  order: string[];
  scores: Record<string, number>;
  analyzed: number;
  total: number;
  running: boolean;
}

interface BannedFaceReason {
  type: "banned-people" | "explicit" | "other";
  description?: string;
}

interface BannedFace {
  personId: string;
  personName: string;
  confidence: number; // 0-100, higher = stricter matching
  reason: BannedFaceReason;
  addedAt: number;
}

interface AppUpdateState {
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
}

interface Window {
  electron?: {
    getAppUpdateState(): Promise<AppUpdateState>;
    checkForAppUpdates(): Promise<AppUpdateState>;
    downloadAndInstallAppUpdate(): Promise<AppUpdateState>;
    onAppUpdateState(callback: (state: AppUpdateState) => void): () => void;
    isDemoMode(): Promise<boolean>;
    getBugReportStatus(): Promise<{ available: boolean; message: string }>;
    captureBugReportScreenshot(): Promise<string>;
    submitBugReport(report: {
      message: string;
      feature: string | null;
      screenshotDataUrl: string | null;
    }): Promise<{ ok: boolean; error?: string }>;
    getLifetimeLicense(): Promise<import("./lifetimePayment").LifetimeLicenseState>;
    getDemoTestingMode(): Promise<{ available: boolean; enabled: boolean }>;
    setDemoTestingMode(enabled: boolean): Promise<{
      available: boolean;
      enabled: boolean;
      restarting: boolean;
    }>;
    getBetaActivationInfo(): Promise<import("./betaLicense").BetaActivationInfo>;
    submitBetaActivationRequest(): Promise<{ ok: boolean; error?: string }>;
    activateBetaLicense(
      activationCode: string,
    ): Promise<import("./betaLicense").BetaActivationResult>;
    onDemoLimitReached(
      callback: (feature: import("./demoLimits").DemoLimitFeature) => void,
    ): () => void;
    onLifetimeAccessChanged?(
      callback: (access: { fullAccess: boolean; name: string }) => void,
    ): () => void;
    verifyLifetimePayment(
      signature: string,
    ): Promise<import("./lifetimePayment").LifetimePaymentVerification>;
    checkLifetimePaymentReference(
      reference: string,
    ): Promise<import("./lifetimePayment").LifetimePaymentVerification>;
    getMemories: import("./memoryTypes").MemoriesAPI["getMemories"];
    generateMemories: import("./memoryTypes").MemoriesAPI["generateMemories"];
    dismissMemory: import("./memoryTypes").MemoriesAPI["dismissMemory"];
    updateMemorySettings: import("./memoryTypes").MemoriesAPI["updateMemorySettings"];
    selectMemoryDirectory: import("./memoryTypes").MemoriesAPI["selectMemoryDirectory"];
    getMemorySoundtracks: import("./memoryTypes").MemoriesAPI["getMemorySoundtracks"];
    browseMemoryAudio?: import("./memoryTypes").MemoriesAPI["browseMemoryAudio"];
    setMemorySoundtrack?: import("./memoryTypes").MemoriesAPI["setMemorySoundtrack"];
    viewMemory: import("./memoryTypes").MemoriesAPI["viewMemory"];
    exportMemory: import("./memoryTypes").MemoriesAPI["exportMemory"];
    cancelMemoryExport: import("./memoryTypes").MemoriesAPI["cancelMemoryExport"];
    onMemoryExportProgress: import("./memoryTypes").MemoriesAPI["onMemoryExportProgress"];
    onMemoryPreviewProgress?: import("./memoryTypes").MemoriesAPI["onMemoryPreviewProgress"];
    readInventoryPage(
      token: string,
      offset: number,
    ): Promise<{ items: FileInfo[]; nextOffset: number; done: boolean }>;
    releaseInventory(token: string): Promise<void>;
    selectDirectory(): Promise<{ path: string; isTimeMachine: boolean } | null>;
    getFiles(
      dirPath: string,
      exploded: boolean,
      requestId: number,
      scanOptions?: {
        sortField: PersistedUiState["sortField"];
        sortAscending: boolean;
        includedType: string;
        sizeMin: number;
        sizeMax: number;
      },
    ): Promise<FileInfo[] | { inventoryToken: string; total: number }>;
    getAudioLibraryCache(): Promise<
      Omit<AudioLibraryCacheSnapshot, "files"> & {
        files: FileInfo[] | { inventoryToken: string; total: number };
      }
    >;
    onAudioLibraryCacheChanged(callback: () => void): () => void;
    refreshAudioLibraryCache(
      requestId: number,
      force?: boolean,
    ): Promise<{
      ok: boolean;
      snapshot?: Omit<AudioLibraryCacheSnapshot, "files"> & {
        files: FileInfo[] | { inventoryToken: string; total: number };
      };
      error?: string;
    }>;
    onAudioLibraryScanProgress(
      callback: (progress: AudioLibraryScanProgress) => void,
    ): () => void;
    selectSourceCloneDestination(): Promise<string[]>;
    prepareSourceClone(
      sourceIds: string[],
      destinations: string[],
      operationId: string,
    ): Promise<{ ok: boolean; plan?: SourceClonePreflight; error?: string }>;
    prepareShelterReplica(
      destinations: string[],
      operationId: string,
    ): Promise<{ ok: boolean; plan?: SourceClonePreflight; error?: string }>;
    startSourceClone(
      planId: string,
      options?: { compress?: boolean; createAppleCompatibleBackup?: boolean },
    ): Promise<{ ok: boolean; timeMachineStarted?: boolean; timeMachineError?: string; error?: string }>;
    startMachineTimeMachineBackup(sourceId: string): Promise<{
      ok: boolean;
      timeMachineStarted?: boolean;
      error?: string;
    }>;
    extractSourceCloneArchive(operationId: string): Promise<{
      ok: boolean;
      cancelled?: boolean;
      destinationRoot?: string;
      extractedFiles?: number;
      error?: string;
    }>;
    cancelSourceClone(operationId: string): Promise<boolean>;
    onSourceCloneProgress(
      callback: (progress: SourceCloneProgress) => void,
    ): () => void;
    selectSourceCloneDestination(): Promise<string[]>;
    prepareSourceClone(
      sourceIds: string[],
      destinations: string[],
      operationId: string,
    ): Promise<{ ok: boolean; plan?: SourceClonePreflight; error?: string }>;
    startSourceClone(
      planId: string,
      options?: { compress?: boolean; createAppleCompatibleBackup?: boolean },
    ): Promise<{ ok: boolean; timeMachineStarted?: boolean; timeMachineError?: string; error?: string }>;
    startMachineTimeMachineBackup(sourceId: string): Promise<{
      ok: boolean;
      timeMachineStarted?: boolean;
      error?: string;
    }>;
    extractSourceCloneArchive(operationId: string): Promise<{
      ok: boolean;
      cancelled?: boolean;
      destinationRoot?: string;
      extractedFiles?: number;
      error?: string;
    }>;
    cancelSourceClone(operationId: string): Promise<boolean>;
    onSourceCloneProgress(
      callback: (progress: SourceCloneProgress) => void,
    ): () => void;
    getFilePreview(filePath: string): Promise<FilePreview | null>;
    getThumbnail(
      filePath: string,
      urgent?: boolean,
      force?: boolean,
      size?: number,
    ): Promise<string | null>;
    getPhotoIndicators(
      filePaths: string[],
    ): Promise<
      Record<
        string,
        {
          hasLocation: boolean;
          locationLabel?: string | null;
          people: string[];
        }
      >
    >;
    onPhotoIndicatorsChanged(callback: () => void): () => void;
    getThumbnailPregenProgress(): Promise<ThumbnailPregenProgress | null>;
    getIndexingOverview(): Promise<IndexingStageProgress[]>;
    getLibraryDashboard(): Promise<LibraryDashboardSnapshot>;
    refreshLibraryStats(): Promise<LibraryDashboardSnapshot>;
    verifyShelterSources(sourceIds: string[]): Promise<LibraryDashboardSnapshot>;
    selectShelterDestination(): Promise<string | null>;
    getRuntimeDiagnostics(cursor: number): Promise<RuntimeDiagnosticRead>;
    retryIndexingStage(id: string): Promise<{ ok: boolean }>;
    onThumbnailPregenProgress(
      callback: (progress: ThumbnailPregenProgress) => void,
    ): () => void;
    createFolder(
      parentPath: string,
      folderName: string,
    ): Promise<FileOperationResult>;
    moveFile(sourcePath: string): Promise<FileOperationResult>;
    saveFileToDevice(
      sourcePath: string,
      suggestedFileName: string,
    ): Promise<FileOperationResult>;
    getAppState(): Promise<PersistedAppState>;
    getContentSettings(): Promise<PublicContentSettings>;
    setParentalPassword(
      currentPassword: string,
      newPassword: string,
    ): Promise<PublicContentSettings>;
    updateContentSettings(
      update: Partial<ContentPreferences>,
      password?: string,
    ): Promise<PublicContentSettings>;
    onContentSettingsChanged(
      callback: (settings: PublicContentSettings) => void,
    ): () => void;
    onContentSafetyChanged(
      callback: (state: {
        flaggedCount: number;
        hiddenPaths?: string[];
        unhiddenPaths?: string[];
        folderHiddenPaths?: string[];
        folderUnhiddenPaths?: string[];
        unhiddenCount?: number;
        folderId?: string;
      }) => void,
    ): () => void;
    updateUiState(
      update: Partial<PersistedUiState>,
    ): Promise<PersistedAppState>;
    selectIndexSource(): Promise<PersistedAppState | null>;
    addMachineSource(): Promise<PersistedAppState | null>;
    addMachineSource(): Promise<PersistedAppState | null>;
    removeIndexSource(sourcePath: string): Promise<PersistedAppState>;
    startIndexing(): Promise<IndexProgress>;
    pauseIndexing(): Promise<IndexProgress>;
    getDuplicateState(): Promise<DuplicateState>;
    scanDuplicates(): Promise<DuplicateState>;
    quarantineDuplicates(groupIds: string[]): Promise<DuplicateState>;
    quarantineDuplicateFiles(filePaths: string[]): Promise<DuplicateState>;
    restoreDuplicates(ids: string[]): Promise<DuplicateState>;
    clearDuplicateTrash(ids?: string[]): Promise<DuplicateState>;
    onDuplicateProgress(callback: (state: DuplicateState) => void): () => void;
    semanticSearch(
      query: string,
      confidence: number,
      requestId: number,
    ): Promise<SemanticSearchResult[]>;
    cancelSemanticSearch(): Promise<void>;
    onSemanticSearchProgress(
      callback: (progress: SemanticSearchProgress) => void,
    ): () => void;
    onIndexProgress(callback: (progress: IndexProgress) => void): () => void;
    getGeoState(): Promise<GeoIndexState>;
    refreshGeoState(): Promise<GeoIndexState>;
    getStartupState(): Promise<StartupState>;
    onStartupProgress(callback: (state: StartupState) => void): () => void;
    getCountrySummary(): Promise<
      Array<{
        country: string | null;
        countryCode: string | null;
        photoCount: number;
      }>
    >;
    getStateSummary(
      country: string | null,
    ): Promise<Array<{ state: string | null; photoCount: number }>>;
    getPhotosByRegion(
      country: string | null,
      state?: string | null,
    ): Promise<GeoPhoto[]>;
    reverseGeocode(
      latitude: number,
      longitude: number,
    ): Promise<{ label: string; countryCode: string | null } | null>;
    searchLocations(query: string): Promise<GeoLocationSuggestion[]>;
    setGeoLocation(
      files: FileInfo[],
      location: GeoLocationSuggestion,
    ): Promise<GeoAssignmentResult>;
    clearGeoLocation(filePaths: string[]): Promise<GeoAssignmentResult>;
    onGeoIndexProgress(callback: (state: GeoIndexStatus) => void): () => void;
    onFileScanProgress(
      callback: (progress: FileScanProgress) => void,
    ): () => void;
    onScanIssues(callback: (issues: ScanIssues) => void): () => void;
    openFullDiskAccess(): Promise<void>;
    revealAppBundle(): Promise<void>;
    getAccessIdentity(): Promise<{
      displayName: string;
      bundlePath: string;
      isDev: boolean;
    }>;
    createDigitalFolder(name: string): Promise<PersistedAppState>;
    deleteDigitalFolder(folderId: string): Promise<PersistedAppState>;
    renameDigitalFolder(
      folderId: string,
      name: string,
    ): Promise<PersistedAppState>;
    moveDigitalFolder(
      sourceId: string,
      targetId: string,
      after: boolean,
    ): Promise<PersistedAppState>;
    setDigitalFolderHidden(
      folderId: string,
      hidden: boolean,
    ): Promise<PersistedAppState>;
    addDigitalFolderReference(
      folderId: string,
      filePath: string,
    ): Promise<PersistedAppState>;
    addDigitalFolderReferences(
      folderId: string,
      filePaths: string[],
    ): Promise<PersistedAppState>;
    removeDigitalFolderReference(
      folderId: string,
      filePath: string,
    ): Promise<PersistedAppState>;
    updateFileMetadata(
      filePaths: string[],
      update: {
        displayName?: string | null;
        keywords?: string[];
        mergeKeywords?: boolean;
        year?: number | null;
      },
    ): Promise<PersistedAppState>;
    getDigitalFolderFiles(folderId: string): Promise<FileInfo[]>;
    downloadDigitalFolder(folderId: string): Promise<FileOperationResult>;
    getFaceState(): Promise<{
      progress: FaceIndexProgress;
      people: PersonSummary[];
    }>;
    startFaceIndexing(): Promise<FaceIndexProgress>;
    pauseFaceIndexing(): Promise<FaceIndexProgress>;
    onFaceIndexProgress(
      callback: (progress: FaceIndexProgress) => void,
    ): () => void;
    getPerson(personId: string): Promise<PersonDetail | null>;
    getPersonPhotoFiles(personId: string): Promise<FileInfo[]>;
    magicRank(
      items: Array<{
        path: string;
        size: number;
        modified: number;
        name: string;
      }>,
      preset?: "balanced" | "people" | "landscapes" | "variety",
    ): Promise<MagicRankResult>;
    onMagicSortProgress(
      callback: (progress: {
        analyzed: number;
        total: number;
        running: boolean;
      }) => void,
    ): () => void;
    exportConfig(rendererPrefs: Record<string, string>): Promise<{
      ok: boolean;
      canceled?: boolean;
      path?: string;
      size?: number;
      error?: string;
    }>;
    importConfig(): Promise<{
      ok: boolean;
      canceled?: boolean;
      error?: string;
      manifest?: SiloConfigManifest;
    }>;
    applyConfigImport(): Promise<void>;
    cancelConfigImport(): Promise<void>;
    getPersonSuggestionFiles(personId: string): Promise<FileInfo[]>;
    confirmAllPersonPhotos(personId: string): Promise<PersonDetail | null>;
    confirmPersonPhotos(
      personId: string,
      imagePaths: string[],
    ): Promise<PersonDetail | null>;
    trainPerson(personId: string): Promise<PersonDetail | null>;
    banPerson(personId: string): Promise<PersonDetail | null>;
    unbanPerson(personId: string): Promise<PersonDetail | null>;
    acceptPersonSuggestions(
      personId: string,
      imagePaths: string[],
    ): Promise<PersonDetail | null>;
    rejectPersonSuggestions(
      personId: string,
      imagePaths: string[],
    ): Promise<PersonDetail | null>;
    movePersonPhotos(
      sourceId: string,
      imagePaths: string[],
      target: { personId?: string; newName?: string } | null,
    ): Promise<{ people: PersonSummary[]; destinationId: string | null }>;
    addPhotosToPerson(
      imagePaths: string[],
      target: { personId?: string; newName?: string },
    ): Promise<{
      people: PersonSummary[];
      personId: string;
      personName: string;
    }>;
    getPeopleEditHistory(): Promise<{
      undoLabel: string | null;
      redoLabel: string | null;
    }>;
    undoPeopleEdit(): Promise<{
      label: string | null;
      undoLabel: string | null;
      redoLabel: string | null;
    }>;
    redoPeopleEdit(): Promise<{
      label: string | null;
      undoLabel: string | null;
      redoLabel: string | null;
    }>;
    onEditMenuCommand(callback: (command: "undo" | "redo") => void): () => void;
    createPerson(name: string): Promise<PersonSummary[]>;
    renamePerson(personId: string, name: string): Promise<PersonSummary[]>;
    deletePerson(personId: string): Promise<PersonSummary[]>;
    assignFaceToPerson(
      personId: string,
      faceId: string,
    ): Promise<PersonDetail | null>;
    addPhotoToPerson(
      personId: string,
      imagePath: string,
    ): Promise<PersonDetail | null>;
    confirmPersonPhoto(
      personId: string,
      imagePath: string,
    ): Promise<PersonDetail | null>;
    removePersonPhoto(
      personId: string,
      imagePath: string,
    ): Promise<PersonDetail | null>;
    setPersonCoverPhoto(
      personId: string,
      photoPath: string | null,
    ): Promise<PersonDetail | null>;
    getImageFaces(imagePath: string): Promise<ImageFace[]>;
    updateFaceBox(
      faceId: string,
      imagePath: string,
      box: ImageFace["box"],
    ): Promise<ImageFace[]>;
    createFaceBox(
      imagePath: string,
      box: ImageFace["box"],
    ): Promise<ImageFace[]>;
    deleteFace(faceId: string): Promise<ImageFace[]>;
    mergePerson(
      sourcePersonId: string,
      targetPersonId: string,
    ): Promise<PersonDetail | null>;
    getBannedFaces(): Promise<BannedFace[]>;
    addBannedFace(
      personId: string,
      reason: BannedFaceReason,
      confidence: number,
    ): Promise<BannedFace[]>;
    removeBannedFace(personId: string): Promise<BannedFace[]>;
    setBannedFaceConfidence(
      personId: string,
      confidence: number,
    ): Promise<BannedFace[]>;
    setPetCoverPhoto(
      clusterId: string,
      photoPath: string | null,
    ): Promise<PetCluster[]>;
    getPetState(): Promise<{
      progress: PetIndexProgress;
      clusters: PetCluster[];
    }>;
    startPetClustering(): Promise<PetIndexProgress>;
    pausePetClustering(): Promise<PetIndexProgress>;
    onPetProgress(callback: (progress: PetIndexProgress) => void): () => void;
    renamePetCluster(clusterId: string, name: string): Promise<PetCluster[]>;
    updateNameIndex(
      name: string,
      filePaths: string[],
      sourceType: "person" | "pet" | "manual",
      sourceId?: string,
    ): Promise<PersistedAppState>;
    confirmNameFile(name: string, filePath: string): Promise<PersistedAppState>;
    rejectNameFile(name: string, filePath: string): Promise<PersistedAppState>;
    getPhoneTooling(): Promise<PhoneTooling>;
    getPhoneBackupStates(): Promise<PhoneBackupProgress[]>;
    getPhoneRestoreArchives(): Promise<PhoneRestoreArchive[]>;
    createPhoneRestoreArchive(
      deviceId: string,
      platform: "ios",
      password: string,
    ): Promise<PhoneRestoreArchive | null>;
    restorePhoneFromArchive(
      deviceId: string,
      platform: "ios",
      archiveId: string,
      password: string,
    ): Promise<boolean>;
    setPhoneBackupDestination(
      destination: string | null,
    ): Promise<string | null>;
    getPhoneBackupDestination(): Promise<string | null>;
    getIndexStorageRoot(): Promise<string>;
    selectIndexStorageRoot(): Promise<{
      canceled: boolean;
      restarting?: boolean;
      path?: string;
      error?: string;
    }>;
    onPhoneBackupProgress(
      callback: (progress: PhoneBackupProgress) => void,
    ): () => void;
    onPhoneDevicesChanged(
      callback: (devices: PhoneDevice[]) => void,
    ): () => void;
    listPhones(): Promise<PhoneDevice[]>;
    renamePhone(
      deviceId: string,
      platform: PhonePlatform,
      name: string,
    ): Promise<PhoneDevice[]>;
    connectPhone(
      deviceId: string,
      platform: PhonePlatform,
    ): Promise<PhoneDevice | null>;
    disconnectPhone(deviceId: string, platform: PhonePlatform): Promise<void>;
    getMessageThreads(
      deviceId: string,
      platform: PhonePlatform,
      refresh?: boolean,
    ): Promise<{ ok: boolean; threads: DeviceMessageThread[]; error?: string }>;
    getMessageAttachmentDataUrl(
      deviceId: string,
      messageId: string,
      partId: string,
    ): Promise<string | null>;
    listMessageHistory(): Promise<MessageHistoryEntry[]>;
    exportMessages(
      accountId: string,
      deviceId: string,
      outputDir: string,
      format: "xml" | "pdf" | "both",
      platform?: PhonePlatform,
      threadIds?: string[],
    ): Promise<{
      success: boolean;
      threadCount: number;
      messageCount: number;
      attachmentCount: number;
      backupPath?: string;
      error?: string;
    }>;
    listMessageBackups(baseDir: string): Promise<unknown[]>;
    getAllContacts(): Promise<
      Array<{ phoneNumber: string; savedName: string }>
    >;
    setContactName(
      phoneNumber: string,
      savedName: string | null,
    ): Promise<{ ok: boolean; error?: string }>;
    getContactName(phoneNumber: string): Promise<string | null>;
    selectBackupDestination(): Promise<string | null>;
    getGoogleState(): Promise<GoogleAccountsState>;
    googleAddAccount(): Promise<GoogleAccountsState>;
    googleRemoveAccount(accountId: string): Promise<GoogleAccountsState>;
    googleStartPhotoPicker(accountId: string): Promise<PhotoPickerSession>;
    googlePollPhotoPicker(
      accountId: string,
      sessionId: string,
    ): Promise<{ ready: boolean; count: number }>;
    googleClearPickedPhotos(accountId?: string): Promise<GoogleAccountsState>;
    googleExportPhotos(accountId?: string): Promise<FileOperationResult>;
    listSources(): Promise<BrowseSource[]>;
    getLibraryShareStatus(): Promise<{
      active: boolean;
      url?: string;
      sources: Array<{ id: string; label: string }>;
    }>;
    startLibraryShare(sourceIds: string[]): Promise<{
      active: boolean;
      url?: string;
      sources: Array<{ id: string; label: string }>;
    }>;
    stopLibraryShare(): Promise<{
      active: boolean;
      url?: string;
      sources: Array<{ id: string; label: string }>;
    }>;
    getAllSourcesPath(): Promise<string>;
    setSourceEnabled(
      sourceId: string,
      enabled: boolean,
    ): Promise<BrowseSource[]>;
    setAllSourcesEnabled(enabled: boolean): Promise<BrowseSource[]>;
    googleCreateFolder(
      parentPath: string,
      name: string,
    ): Promise<FileOperationResult>;
    googleRenameFile(
      filePath: string,
      name: string,
    ): Promise<FileOperationResult>;
    googleTrashFile(filePath: string): Promise<FileOperationResult>;
    googleUploadFile(parentPath: string): Promise<FileOperationResult>;
  };
}
