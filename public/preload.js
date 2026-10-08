const { contextBridge, ipcRenderer } = require("electron");

// Queue for buffering phone backup progress events that arrive before the listener is attached
const phoneBackupProgressQueue = [];
let phoneBackupProgressListener = null;

// Attach global listener immediately to catch all events
ipcRenderer.on("phone-backup-progress", (_event, progress) => {
  if (phoneBackupProgressListener) {
    phoneBackupProgressListener(progress);
  } else {
    // Buffer the event if no listener is registered yet
    phoneBackupProgressQueue.push(progress);
    // Keep only the last 100 events to prevent memory leak
    if (phoneBackupProgressQueue.length > 100) {
      phoneBackupProgressQueue.shift();
    }
  }
});

contextBridge.exposeInMainWorld("electron", {
    isDemoMode: () => ipcRenderer.invoke("is-demo-mode"),
    getBugReportStatus: () => ipcRenderer.invoke("get-bug-report-status"),
    captureBugReportScreenshot: () => ipcRenderer.invoke("capture-bug-report-screenshot"),
    submitBugReport: (report) => ipcRenderer.invoke("submit-bug-report", report),
    getMemories: (prepareViews) => ipcRenderer.invoke("get-memories", Boolean(prepareViews)),
    generateMemories: (replace, customTopic) => ipcRenderer.invoke("generate-memories", Boolean(replace), customTopic),
    dismissMemory: (id) => ipcRenderer.invoke("dismiss-memory", id),
    updateMemorySettings: (settings) => ipcRenderer.invoke("update-memory-settings", settings),
    selectMemoryDirectory: () => ipcRenderer.invoke("select-memory-directory"),
    getMemorySoundtracks: (id) => ipcRenderer.invoke("get-memory-soundtracks", id),
    browseMemoryAudio: (request) => ipcRenderer.invoke("browse-memory-audio", request),
    setMemorySoundtrack: (id, soundtrackId) => ipcRenderer.invoke("set-memory-soundtrack", id, soundtrackId),
    viewMemory: (id) => ipcRenderer.invoke("view-memory", id),
    exportMemory: (options) => ipcRenderer.invoke("export-memory", options),
    cancelMemoryExport: () => ipcRenderer.invoke("cancel-memory-export"),
    onMemoryExportProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on("memory-export-progress", listener);
      return () => ipcRenderer.removeListener("memory-export-progress", listener);
    },
    onMemoryPreviewProgress: (callback) => {
      const listener = (_event, previews) => callback(previews);
      ipcRenderer.on("memory-preview-progress", listener);
      return () => ipcRenderer.removeListener("memory-preview-progress", listener);
    },
    onLifetimeAccessChanged: (callback) => {
      const listener = (_event, access) => callback(access);
      ipcRenderer.on("lifetime-access-changed", listener);
      return () => ipcRenderer.removeListener("lifetime-access-changed", listener);
    },
    onDemoLimitReached: (callback) => {
      const listener = (_event, feature) => callback(feature);
      ipcRenderer.on("demo-limit-reached", listener);
      return () => ipcRenderer.removeListener("demo-limit-reached", listener);
    },
  onAudioLibraryCacheChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("audio-library-cache-changed", listener);
    return () =>
      ipcRenderer.removeListener("audio-library-cache-changed", listener);
  },
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  readInventoryPage: (token, offset) =>
    ipcRenderer.invoke("read-inventory-page", token, offset),
  releaseInventory: (token) => ipcRenderer.invoke("release-inventory", token),
  getFiles: (dirPath, exploded, requestId, scanOptions) =>
    ipcRenderer.invoke("get-files", dirPath, exploded, requestId, scanOptions),
  getAudioLibraryCache: () => ipcRenderer.invoke("get-audio-library-cache"),
  refreshAudioLibraryCache: (requestId, force) =>
    ipcRenderer.invoke(
      "refresh-audio-library-cache",
      requestId,
      Boolean(force),
    ),
  onAudioLibraryScanProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("audio-library-scan-progress", listener);
    return () =>
      ipcRenderer.removeListener("audio-library-scan-progress", listener);
  },
  selectSourceCloneDestination: () =>
    ipcRenderer.invoke("select-source-clone-destination"),
  prepareSourceClone: (sourceIds, destinations, operationId) =>
    ipcRenderer.invoke(
      "prepare-source-clone",
      sourceIds,
      destinations,
      operationId,
    ),
  prepareShelterReplica: (destinations, operationId) =>
    ipcRenderer.invoke("prepare-shelter-replica", destinations, operationId),
  startSourceClone: (planId, options) =>
    ipcRenderer.invoke("start-source-clone", planId, options),
  extractSourceCloneArchive: (operationId) =>
    ipcRenderer.invoke("extract-source-clone-archive", operationId),
  cancelSourceClone: (operationId) =>
    ipcRenderer.invoke("cancel-source-clone", operationId),
  onSourceCloneProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("source-clone-progress", listener);
    return () => ipcRenderer.removeListener("source-clone-progress", listener);
  },
  getFilePreview: (filePath) =>
    ipcRenderer.invoke("get-file-preview", filePath),
  getThumbnail: (filePath, urgent, force, size) =>
    ipcRenderer.invoke(
      "get-thumbnail",
      filePath,
      Boolean(urgent),
      Boolean(force),
      size,
    ),
  getPhotoIndicators: (filePaths) =>
    ipcRenderer.invoke("get-photo-indicators", filePaths),
  getThumbnailPregenProgress: () =>
    ipcRenderer.invoke("get-thumbnail-pregen-progress"),
  getIndexingOverview: () => ipcRenderer.invoke("get-indexing-overview"),
  getLibraryDashboard: () => ipcRenderer.invoke("get-library-dashboard"),
  refreshLibraryStats: () => ipcRenderer.invoke("refresh-library-stats"),
  selectShelterDestination: () =>
    ipcRenderer.invoke("select-shelter-destination"),
  getRuntimeDiagnostics: (cursor) =>
    ipcRenderer.invoke("get-runtime-diagnostics", cursor),
  retryIndexingStage: (id) => ipcRenderer.invoke("retry-indexing-stage", id),
  onThumbnailPregenProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("thumbnail-pregen-progress", listener);
    return () =>
      ipcRenderer.removeListener("thumbnail-pregen-progress", listener);
  },
  onPhotoIndicatorsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("photo-indicators-changed", listener);
    return () =>
      ipcRenderer.removeListener("photo-indicators-changed", listener);
  },
  updateVisibleThumbnails: (visiblePaths) =>
    ipcRenderer.send("update-visible-thumbnails", visiblePaths),
  createFolder: (parentPath, folderName) =>
    ipcRenderer.invoke("create-folder", parentPath, folderName),
  moveFile: (sourcePath) => ipcRenderer.invoke("move-file", sourcePath),
  saveFileToDevice: (sourcePath, suggestedFileName) =>
    ipcRenderer.invoke("save-file-to-device", sourcePath, suggestedFileName),
  getAppState: () => ipcRenderer.invoke("get-app-state"),
  getLifetimeLicense: () => ipcRenderer.invoke("get-lifetime-license"),
  getDemoTestingMode: () => ipcRenderer.invoke("get-demo-testing-mode"),
  setDemoTestingMode: (enabled) =>
    ipcRenderer.invoke("set-demo-testing-mode", enabled),
  getBetaActivationInfo: () => ipcRenderer.invoke("get-beta-activation-info"),
  openBetaActivationRequestEmail: () =>
    ipcRenderer.invoke("open-beta-activation-request-email"),
  activateBetaLicense: (activationCode) =>
    ipcRenderer.invoke("activate-beta-license", activationCode),
  verifyLifetimePayment: (signature) =>
    ipcRenderer.invoke("verify-lifetime-payment", signature),
  checkLifetimePaymentReference: (reference) =>
    ipcRenderer.invoke("check-lifetime-payment-reference", reference),
  getContentSettings: () => ipcRenderer.invoke("get-content-settings"),
  setParentalPassword: (currentPassword, newPassword) =>
    ipcRenderer.invoke("set-parental-password", currentPassword, newPassword),
  updateContentSettings: (update, password) =>
    ipcRenderer.invoke("update-content-settings", update, password),
  onContentSettingsChanged: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on("content-settings-changed", listener);
    return () =>
      ipcRenderer.removeListener("content-settings-changed", listener);
  },
  onContentSafetyChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("content-safety-changed", listener);
    return () => ipcRenderer.removeListener("content-safety-changed", listener);
  },
  updateUiState: (update) => ipcRenderer.invoke("update-ui-state", update),
  selectIndexSource: () => ipcRenderer.invoke("select-index-source"),
  removeIndexSource: (sourcePath) =>
    ipcRenderer.invoke("remove-index-source", sourcePath),
  startIndexing: () => ipcRenderer.invoke("start-indexing"),
  pauseIndexing: () => ipcRenderer.invoke("pause-indexing"),
  getDuplicateState: () => ipcRenderer.invoke("get-duplicate-state"),
  scanDuplicates: () => ipcRenderer.invoke("scan-duplicates"),
  quarantineDuplicates: (groupIds) =>
    ipcRenderer.invoke("quarantine-duplicates", groupIds),
  quarantineDuplicateFiles: (filePaths) =>
    ipcRenderer.invoke("quarantine-duplicate-files", filePaths),
  restoreDuplicates: (ids) => ipcRenderer.invoke("restore-duplicates", ids),
  clearDuplicateTrash: (ids) =>
    ipcRenderer.invoke("clear-duplicate-trash", ids),
  onDuplicateProgress: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("duplicate-progress", listener);
    return () => ipcRenderer.removeListener("duplicate-progress", listener);
  },
  semanticSearch: (query, confidence, requestId) =>
    ipcRenderer.invoke("semantic-search", query, confidence, requestId),
  cancelSemanticSearch: () => ipcRenderer.invoke("cancel-semantic-search"),
  onSemanticSearchProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("semantic-search-progress", listener);
    return () => ipcRenderer.removeListener("semantic-search-progress", listener);
  },
  onIndexProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("index-progress", listener);
    return () => ipcRenderer.removeListener("index-progress", listener);
  },
  getGeoState: () => ipcRenderer.invoke("get-geo-state"),
  refreshGeoState: () => ipcRenderer.invoke("refresh-geo-state"),
  getStartupState: () => ipcRenderer.invoke("get-startup-state"),
  onStartupProgress: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("startup-progress", listener);
    return () => ipcRenderer.removeListener("startup-progress", listener);
  },
  getCountrySummary: () => ipcRenderer.invoke("get-country-summary"),
  getStateSummary: (country) =>
    ipcRenderer.invoke("get-state-summary", country),
  getPhotosByRegion: (country, state) =>
    ipcRenderer.invoke("get-photos-by-region", country, state),
  reverseGeocode: (latitude, longitude) =>
    ipcRenderer.invoke("reverse-geocode", latitude, longitude),
  searchLocations: (query) => ipcRenderer.invoke("search-locations", query),
  setGeoLocation: (files, location) =>
    ipcRenderer.invoke("set-geo-location", files, location),
  clearGeoLocation: (filePaths) =>
    ipcRenderer.invoke("clear-geo-location", filePaths),
  onGeoIndexProgress: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("geo-index-progress", listener);
    return () => ipcRenderer.removeListener("geo-index-progress", listener);
  },
  onFileScanProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("file-scan-progress", listener);
    return () => ipcRenderer.removeListener("file-scan-progress", listener);
  },
  onScanIssues: (callback) => {
    const listener = (_event, issues) => callback(issues);
    ipcRenderer.on("scan-issues", listener);
    return () => ipcRenderer.removeListener("scan-issues", listener);
  },
  openFullDiskAccess: () => ipcRenderer.invoke("open-full-disk-access"),
  revealAppBundle: () => ipcRenderer.invoke("reveal-app-bundle"),
  getAccessIdentity: () => ipcRenderer.invoke("get-access-identity"),
  createDigitalFolder: (name) =>
    ipcRenderer.invoke("create-digital-folder", name),
  deleteDigitalFolder: (folderId) =>
    ipcRenderer.invoke("delete-digital-folder", folderId),
  renameDigitalFolder: (folderId, name) =>
    ipcRenderer.invoke("rename-digital-folder", folderId, name),
  moveDigitalFolder: (sourceId, targetId, after) =>
    ipcRenderer.invoke("move-digital-folder", sourceId, targetId, after),
  setDigitalFolderHidden: (folderId, hidden) =>
    ipcRenderer.invoke("set-digital-folder-hidden", folderId, hidden),
  addDigitalFolderReference: (folderId, filePath) =>
    ipcRenderer.invoke("add-digital-folder-reference", folderId, filePath),
  addDigitalFolderReferences: (folderId, filePaths) =>
    ipcRenderer.invoke("add-digital-folder-references", folderId, filePaths),
  removeDigitalFolderReference: (folderId, filePath) =>
    ipcRenderer.invoke("remove-digital-folder-reference", folderId, filePath),
  updateFileMetadata: (filePaths, update) =>
    ipcRenderer.invoke("update-file-metadata", filePaths, update),
  getDigitalFolderFiles: (folderId) =>
    ipcRenderer.invoke("get-digital-folder-files", folderId),
  downloadDigitalFolder: (folderId) =>
    ipcRenderer.invoke("download-digital-folder", folderId),
  getFaceState: () => ipcRenderer.invoke("get-face-state"),
  startFaceIndexing: () => ipcRenderer.invoke("start-face-indexing"),
  pauseFaceIndexing: () => ipcRenderer.invoke("pause-face-indexing"),
  onFaceIndexProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("face-index-progress", listener);
    return () => ipcRenderer.removeListener("face-index-progress", listener);
  },
  getPerson: (personId) => ipcRenderer.invoke("get-person", personId),
  getPersonPhotoFiles: (personId) =>
    ipcRenderer.invoke("get-person-photo-files", personId),
  magicRank: (items, preset) => ipcRenderer.invoke("magic-rank", items, preset),
  exportConfig: (rendererPrefs) =>
    ipcRenderer.invoke("export-config", rendererPrefs),
  importConfig: () => ipcRenderer.invoke("import-config"),
  applyConfigImport: () => ipcRenderer.invoke("apply-config-import"),
  cancelConfigImport: () => ipcRenderer.invoke("cancel-config-import"),
  onMagicSortProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("magic-sort-progress", listener);
    return () => ipcRenderer.removeListener("magic-sort-progress", listener);
  },
  getPersonSuggestionFiles: (personId) =>
    ipcRenderer.invoke("get-person-suggestion-files", personId),
  confirmAllPersonPhotos: (personId) =>
    ipcRenderer.invoke("confirm-all-person-photos", personId),
  confirmPersonPhotos: (personId, imagePaths) =>
    ipcRenderer.invoke("confirm-person-photos", personId, imagePaths),
  trainPerson: (personId) => ipcRenderer.invoke("train-person", personId),
  banPerson: (personId) => ipcRenderer.invoke("ban-person", personId),
  unbanPerson: (personId) => ipcRenderer.invoke("unban-person", personId),
  acceptPersonSuggestions: (personId, imagePaths) =>
    ipcRenderer.invoke("accept-person-suggestions", personId, imagePaths),
  rejectPersonSuggestions: (personId, imagePaths) =>
    ipcRenderer.invoke("reject-person-suggestions", personId, imagePaths),
  movePersonPhotos: (sourceId, imagePaths, target) =>
    ipcRenderer.invoke("move-person-photos", sourceId, imagePaths, target),
  addPhotosToPerson: (imagePaths, target) =>
    ipcRenderer.invoke("add-photos-to-person", imagePaths, target),
  getPeopleEditHistory: () => ipcRenderer.invoke("get-people-edit-history"),
  undoPeopleEdit: () => ipcRenderer.invoke("undo-people-edit"),
  redoPeopleEdit: () => ipcRenderer.invoke("redo-people-edit"),
  onEditMenuCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("edit-menu-command", listener);
    return () => ipcRenderer.removeListener("edit-menu-command", listener);
  },
  createPerson: (name) => ipcRenderer.invoke("create-person", name),
  renamePerson: (personId, name) =>
    ipcRenderer.invoke("rename-person", personId, name),
  deletePerson: (personId) => ipcRenderer.invoke("delete-person", personId),
  assignFaceToPerson: (personId, faceId) =>
    ipcRenderer.invoke("assign-face-to-person", personId, faceId),
  addPhotoToPerson: (personId, imagePath) =>
    ipcRenderer.invoke("add-photo-to-person", personId, imagePath),
  confirmPersonPhoto: (personId, imagePath) =>
    ipcRenderer.invoke("confirm-person-photo", personId, imagePath),
  removePersonPhoto: (personId, imagePath) =>
    ipcRenderer.invoke("remove-person-photo", personId, imagePath),
  setPersonCoverPhoto: (personId, photoPath) =>
    ipcRenderer.invoke("set-person-cover-photo", personId, photoPath),
  getImageFaces: (imagePath) =>
    ipcRenderer.invoke("get-image-faces", imagePath),
  updateFaceBox: (faceId, imagePath, box) =>
    ipcRenderer.invoke("update-face-box", faceId, imagePath, box),
  createFaceBox: (imagePath, box) =>
    ipcRenderer.invoke("create-face-box", imagePath, box),
  deleteFace: (faceId) => ipcRenderer.invoke("delete-face", faceId),
  mergePerson: (sourcePersonId, targetPersonId) =>
    ipcRenderer.invoke("merge-person", sourcePersonId, targetPersonId),
  getBannedFaces: () => ipcRenderer.invoke("get-banned-faces"),
  addBannedFace: (personId, reason, confidence) =>
    ipcRenderer.invoke("add-banned-face", personId, reason, confidence),
  removeBannedFace: (personId) =>
    ipcRenderer.invoke("remove-banned-face", personId),
  setBannedFaceConfidence: (personId, confidence) =>
    ipcRenderer.invoke("set-banned-face-confidence", personId, confidence),
  getPetState: () => ipcRenderer.invoke("get-pet-state"),
  startPetClustering: () => ipcRenderer.invoke("start-pet-clustering"),
  pausePetClustering: () => ipcRenderer.invoke("pause-pet-clustering"),
  onPetProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("pet-progress", listener);
    return () => ipcRenderer.removeListener("pet-progress", listener);
  },
  renamePetCluster: (clusterId, name) =>
    ipcRenderer.invoke("rename-pet-cluster", clusterId, name),
  updateNameIndex: (name, filePaths, sourceType, sourceId) =>
    ipcRenderer.invoke(
      "update-name-index",
      name,
      filePaths,
      sourceType,
      sourceId,
    ),
  confirmNameFile: (name, filePath) =>
    ipcRenderer.invoke("confirm-name-file", name, filePath),
  rejectNameFile: (name, filePath) =>
    ipcRenderer.invoke("reject-name-file", name, filePath),
  getPhoneTooling: () => ipcRenderer.invoke("get-phone-tooling"),
  getPhoneBackupStates: () => ipcRenderer.invoke("get-phone-backup-states"),
  getPhoneRestoreArchives: () =>
    ipcRenderer.invoke("get-phone-restore-archives"),
  createPhoneRestoreArchive: (deviceId, platform, password) =>
    ipcRenderer.invoke("create-phone-restore-archive", deviceId, platform, password),
  restorePhoneFromArchive: (deviceId, platform, archiveId, password) =>
    ipcRenderer.invoke(
      "restore-phone-from-archive",
      deviceId,
      platform,
      archiveId,
      password,
    ),
  setPhoneBackupDestination: (destination) =>
    ipcRenderer.invoke("set-phone-backup-destination", destination),
  getPhoneBackupDestination: () =>
    ipcRenderer.invoke("get-phone-backup-destination"),
  onPhoneBackupProgress: (callback) => {
    console.log(
      `[PRELOAD] Registering phone-backup-progress listener, replaying ${phoneBackupProgressQueue.length} buffered events`,
    );
    phoneBackupProgressListener = callback;

    // Replay buffered events
    const bufferedEvents = [...phoneBackupProgressQueue];
    phoneBackupProgressQueue.length = 0; // Clear the queue
    for (const event of bufferedEvents) {
      console.log(
        `[PRELOAD] Replaying buffered progress: ${event.platform}:${event.deviceId}, status: ${event.status}`,
      );
      callback(event);
    }

    return () => {
      console.log(`[PRELOAD] Removing phone-backup-progress listener`);
      phoneBackupProgressListener = null;
    };
  },
  onPhoneDevicesChanged: (callback) => {
    const listener = (_event, devices) => callback(devices);
    ipcRenderer.on("phone-devices-changed", listener);
    return () => ipcRenderer.removeListener("phone-devices-changed", listener);
  },
  listPhones: () => ipcRenderer.invoke("list-phones"),
  renamePhone: (deviceId, platform, name) =>
    ipcRenderer.invoke("rename-phone", deviceId, platform, name),
  connectPhone: (deviceId, platform) =>
    ipcRenderer.invoke("connect-phone", deviceId, platform),
  disconnectPhone: (deviceId, platform) =>
    ipcRenderer.invoke("disconnect-phone", deviceId, platform),
  getGoogleState: () => ipcRenderer.invoke("get-google-state"),
  googleAddAccount: () => ipcRenderer.invoke("google-add-account"),
  googleRemoveAccount: (accountId) =>
    ipcRenderer.invoke("google-remove-account", accountId),
  googleStartPhotoPicker: (accountId) =>
    ipcRenderer.invoke("google-start-photo-picker", accountId),
  googlePollPhotoPicker: (accountId, sessionId) =>
    ipcRenderer.invoke("google-poll-photo-picker", accountId, sessionId),
  googleClearPickedPhotos: (accountId) =>
    ipcRenderer.invoke("google-clear-picked-photos", accountId),
  googleExportPhotos: (accountId) =>
    ipcRenderer.invoke("google-export-photos", accountId),
  listSources: () => ipcRenderer.invoke("list-sources"),
  getLibraryShareStatus: () => ipcRenderer.invoke("get-library-share-status"),
  startLibraryShare: (sourceIds) =>
    ipcRenderer.invoke("start-library-share", sourceIds),
  stopLibraryShare: () => ipcRenderer.invoke("stop-library-share"),
  getAllSourcesPath: () => ipcRenderer.invoke("get-all-sources-path"),
  setSourceEnabled: (sourceId, enabled) =>
    ipcRenderer.invoke("set-source-enabled", sourceId, enabled),
  setAllSourcesEnabled: (enabled) =>
    ipcRenderer.invoke("set-all-sources-enabled", enabled),
  googleCreateFolder: (parentPath, name) =>
    ipcRenderer.invoke("google-create-folder", parentPath, name),
  googleRenameFile: (filePath, name) =>
    ipcRenderer.invoke("google-rename-file", filePath, name),
  googleTrashFile: (filePath) =>
    ipcRenderer.invoke("google-trash-file", filePath),
  googleUploadFile: (parentPath) =>
    ipcRenderer.invoke("google-upload-file", parentPath),
  exportMessages: (
    accountId,
    deviceId,
    outputDir,
    format,
    platform,
    threadIds,
  ) =>
    ipcRenderer.invoke(
      "export-messages",
      accountId,
      deviceId,
      outputDir,
      format,
      platform,
      threadIds,
    ),
  getMessageThreads: (deviceId, platform, refresh) =>
    ipcRenderer.invoke("get-message-threads", deviceId, platform, refresh),
  getMessageAttachmentDataUrl: (deviceId, messageId, partId) =>
    ipcRenderer.invoke(
      "get-message-attachment-data-url",
      deviceId,
      messageId,
      partId,
    ),
  listMessageHistory: () => ipcRenderer.invoke("list-message-history"),
  listMessageBackups: (baseDir) =>
    ipcRenderer.invoke("list-message-backups", baseDir),
  restoreMessages: (backupPath, deviceId) =>
    ipcRenderer.invoke("restore-messages", backupPath, deviceId),
  getAllContacts: () => ipcRenderer.invoke("get-all-contacts"),
  setContactName: (phoneNumber, savedName) =>
    ipcRenderer.invoke("set-contact-name", phoneNumber, savedName),
  getContactName: (phoneNumber) =>
    ipcRenderer.invoke("get-contact-name", phoneNumber),
  selectBackupDestination: () =>
    ipcRenderer.invoke("select-backup-destination"),
  getIndexStorageRoot: () => ipcRenderer.invoke("get-index-storage-root"),
  selectIndexStorageRoot: () =>
    ipcRenderer.invoke("select-index-storage-root"),
  startFaceIndexingForSource: (sourcePath) =>
    ipcRenderer.invoke("start-face-indexing-for-source", sourcePath),
  getFaceIndexProgress: (deviceId) =>
    ipcRenderer.invoke("get-face-index-progress", deviceId),
});
