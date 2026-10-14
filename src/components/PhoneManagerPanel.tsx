import React, { useEffect, useState } from "react";
import { FiEdit3, FiFolder, FiLink, FiLock, FiRefreshCw, FiSmartphone, FiX } from "react-icons/fi";

interface PhoneManagerPanelProps {
  devices: PhoneDevice[];
  tooling: PhoneTooling | null;
  scanning: boolean;
  notice: string;
  backups: Record<string, PhoneBackupProgress>;
  backupDestination: string | null;
  formatFileSize: (bytes: number) => string;
  onScan: () => void;
  onChooseBackupDestination: () => void;
  onResetBackupDestination: () => void;
}

interface PhoneManagementPanelProps {
  devices: PhoneDevice[];
  tooling: PhoneTooling | null;
  busyDeviceId: string | null;
  activeDeviceKey: string | null;
  backups: Record<string, PhoneBackupProgress>;
  backupDestination: string | null;
  formatFileSize: (bytes: number) => string;
  restoreArchives: PhoneRestoreArchive[];
  onBrowse: (device: PhoneDevice) => void;
  onConnect: (device: PhoneDevice) => void;
  onDisconnect: (device: PhoneDevice) => void;
  onRename: (device: PhoneDevice) => void;
  onRenewBackup: (device: PhoneDevice, includeTypes?: PhoneBackupFileType[]) => void;
  onPreviewBackup: (device: PhoneDevice) => Promise<PhoneBackupPreview>;
  onChooseBackupDestination: () => void;
  onResetBackupDestination: () => void;
  onCreateRestoreArchive: (
    device: PhoneDevice,
    password: string,
  ) => Promise<boolean>;
  onRestoreFromArchive: (
    targetDeviceId: string,
    archive: PhoneRestoreArchive,
    password: string,
  ) => Promise<boolean>;
}

interface PhoneDeviceCardProps {
  device: PhoneDevice;
  active: boolean;
  busyDeviceId: string | null;
  restoreArchives: PhoneRestoreArchive[];
  tooling: PhoneTooling | null;
  onBrowse: (device: PhoneDevice) => void;
  onConnect: (device: PhoneDevice) => void;
  onDisconnect: (device: PhoneDevice) => void;
  onRename: (device: PhoneDevice) => void;
  onRenewBackup: (device: PhoneDevice) => void;
  onCreateRestoreArchive: (
    device: PhoneDevice,
    password: string,
  ) => Promise<boolean>;
  onRestoreFromArchive: (
    targetDeviceId: string,
    archive: PhoneRestoreArchive,
    password: string,
  ) => Promise<boolean>;
}

function PhoneDeviceCard({
  device,
  active,
  busyDeviceId,
  restoreArchives,
  tooling,
  onBrowse,
  onConnect,
  onDisconnect,
  onRename,
  onRenewBackup,
  onCreateRestoreArchive,
  onRestoreFromArchive,
}: PhoneDeviceCardProps) {
  const deviceKey = `${device.platform}:${device.id}`;
  const [backupPassword, setBackupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState("");
  const [showArchives, setShowArchives] = useState(false);
  const busy = busyDeviceId === device.id;
  const createRestoreArchive = async () => {
    if (backupPassword.length < 8 || backupPassword !== confirmPassword) {
      setRestoreNotice("Enter a matching password with at least 8 characters.");
      return;
    }
    setRestoreBusy(true);
    setRestoreNotice("");
    try {
      if (await onCreateRestoreArchive(device, backupPassword)) {
        setBackupPassword("");
        setConfirmPassword("");
      }
    } finally {
      setRestoreBusy(false);
    }
  };

  const restoreArchive = async (archive: PhoneRestoreArchive) => {
    if (!restorePassword) {
      setRestoreNotice("Enter the archive password before restoring.");
      return;
    }
    setRestoreBusy(true);
    setRestoreNotice("");
    try {
      if (
        await onRestoreFromArchive(device.id, archive, restorePassword)
      )
        setRestorePassword("");
    } finally {
      setRestoreBusy(false);
    }
  };

  return (
    <article className={`phone-device ${active ? "active" : ""}`}>
      <div className="phone-device-info">
        <span className={`phone-badge ${device.platform}`}>
          {device.platform === "ios" ? "iOS" : "Android"}
        </span>
        <strong title={device.name}>{device.name}</strong>
        <small className={`phone-status ${device.status}`}>
          {device.message}
        </small>
      </div>
      <div className="phone-device-actions" role="toolbar" aria-label={`${device.name} actions`} data-tour="mobile-device-actions" data-help="Rename, browse, connect, unmount, or back up a phone. Backing up updates Silo’s saved copy without changing files on the phone.">
        {device.status === "ready" && device.rootPath ? (
          <>
            <button
              className="phone-renew-backup-button"
              onClick={() => onRenewBackup(device)}
              disabled={busy}
              title="Back up this phone into Silo; the phone’s files are unchanged"
              data-help="Copy this connected phone’s photos, messages, and readable files into a dated browseable snapshot in Silo. This does not change files on the phone."
            >
              <FiRefreshCw /> {busy ? "Backing up…" : "Back up"}
            </button>
            <button
              className="phone-icon-button"
              onClick={() => onBrowse(device)}
              disabled={busy}
              title="Browse files exposed by this device"
              aria-label={`Browse ${device.name}`}
            >
              <FiFolder />
            </button>
          </>
        ) : (
          <button
            className="phone-renew-backup-button"
            onClick={() => onConnect(device)}
            disabled={busy}
            title="Connect and save a dated snapshot in Silo"
            data-help="Connecting starts or updates a dated local snapshot of accessible files. It does not change files on the device."
          >
            <FiLink /> {busy ? "Connecting…" : "Connect"}
          </button>
        )}
        <button
          className="phone-icon-button"
          onClick={() => onRename(device)}
          title={`Rename ${device.name} in Silo only`}
          aria-label={`Rename ${device.name} in Silo only`}
        >
          <FiEdit3 />
        </button>
        {device.platform === "ios" && device.status === "ready" && (
          <button
            className={`phone-icon-button ${showArchives ? "active" : ""}`}
            onClick={() => setShowArchives((value) => !value)}
            aria-pressed={showArchives}
            title="Encrypted restore archives"
            aria-label="Encrypted restore archives"
          >
            <FiLock />
          </button>
        )}
        {device.platform === "ios" && device.status === "ready" && device.rootPath && (
          <button
            className="phone-icon-button"
            onClick={() => onDisconnect(device)}
            disabled={busy}
            title="Unmount device without changing its contents"
            aria-label={`Disconnect ${device.name}`}
          >
            <FiX />
          </button>
        )}
      </div>
      {showArchives && device.platform === "ios" && device.status === "ready" && (
        <div className="phone-restore-controls">
          <strong>Encrypted restore archives</strong>
          <label htmlFor={`phone-backup-password-${deviceKey}`}>
            Backup password
          </label>
          <input
            id={`phone-backup-password-${deviceKey}`}
            type="password"
            autoComplete="new-password"
            value={backupPassword}
            onChange={(event) => setBackupPassword(event.target.value)}
            placeholder="At least 8 characters"
          />
          <label htmlFor={`phone-backup-password-confirm-${deviceKey}`}>
            Confirm password to create
          </label>
          <input
            id={`phone-backup-password-confirm-${deviceKey}`}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Re-enter password"
          />
          <small>
            Silo never saves this password. Keep it safe; a lost
            encrypted-backup password cannot be recovered here.
          </small>
          <button
            className="small-button"
            disabled={
              restoreBusy ||
              !tooling ||
              tooling.ios.missing.includes("idevicebackup2")
            }
            onClick={() => void createRestoreArchive()}
            title="Save an encrypted restore archive in Silo"
            data-help="Save an encrypted iPhone or iPad restore archive in Silo storage; this does not restore or change the device."
          >
            {restoreBusy ? "Working…" : "Create encrypted restore archive"}
          </button>
          {restoreArchives
            .filter((archive) => archive.platform === "ios")
            .map((archive) => (
              <div className="phone-restore-archive" key={archive.id}>
                <small>
                  {new Date(archive.createdAt).toLocaleString()} · {archive.deviceName} · {archive.deviceModel || "unknown model"}
                  {archive.deviceId === device.id
                    ? " · this device"
                    : archive.deviceModel === device.model
                      ? " · same model"
                      : " · incompatible model"}
                </small>
                <button
                  className="small-button"
                  disabled={
                    restoreBusy ||
                    !device.model ||
                    archive.deviceModel !== device.model
                  }
                  onClick={() => void restoreArchive(archive)}
                  title="DEVICE WRITE — Restore this archive to the connected iPhone or iPad; current contents may be replaced"
                  data-help="DEVICE WRITE: Writes the archive to the connected device and can replace current content. Confirm the device and archive before continuing."
                >
                  Restore this archive
                </button>
              </div>
            ))}
          <label htmlFor={`phone-restore-password-${deviceKey}`}>
            Password for restore
          </label>
          <input
            id={`phone-restore-password-${deviceKey}`}
            type="password"
            autoComplete="current-password"
            value={restorePassword}
            onChange={(event) => setRestorePassword(event.target.value)}
            placeholder="Enter the archive password"
          />
          {restoreNotice && <small role="status">{restoreNotice}</small>}
        </div>
      )}
    </article>
  );
}

function PhoneBackupStatus({
  device,
  backup,
  formatFileSize,
}: {
  device: PhoneDevice;
  backup: PhoneBackupProgress;
  formatFileSize: (bytes: number) => string;
}) {
  const backupPercent = backup.totalBytes
    ? Math.min(100, (backup.completedBytes / backup.totalBytes) * 100)
    : backup.totalFiles
      ? Math.min(100, (backup.completedFiles / backup.totalFiles) * 100)
      : 0;

  return (
    <div className={`phone-backup-progress ${backup.status}`} role="group" aria-label={`${device.name} backup status`}>
      <div>
        <span>
          <strong>{device.name}:</strong> {backup.message}
        </span>
        <strong>
          {backup.status === "complete"
            ? "100%"
            : `${Math.round(backupPercent)}%`}
        </strong>
      </div>
      <progress
        value={backup.status === "complete" ? 100 : backupPercent}
        max={100}
      />
      <small>
        {backup.completedFiles.toLocaleString()} / {backup.totalFiles.toLocaleString()} files
        {backup.totalBytes > 0 &&
          ` · ${formatFileSize(backup.completedBytes)} / ${formatFileSize(backup.totalBytes)}`}
        {backup.failedFiles > 0 &&
          ` · ${backup.failedFiles.toLocaleString()} skipped`}
        {backup.lastBackupAt &&
          ` · ${new Date(backup.lastBackupAt).toLocaleString()}`}
      </small>
      {backup.currentFile && (
        <small title={backup.currentFile}>{backup.currentFile}</small>
      )}
    </div>
  );
}

function PhoneManagerPanel({
  devices,
  tooling,
  scanning,
  notice,
  backups,
  backupDestination,
  formatFileSize,
  onScan,
  onChooseBackupDestination,
  onResetBackupDestination,
}: PhoneManagerPanelProps) {
  return (
    <section className="phone-manager-panel" aria-labelledby="phone-manager-title">
      <header className="mobile-section-heading" data-tour="mobile-devices">
        <div>
          <span className="sidebar-kicker">Phones and tablets</span>
          <h2 id="phone-manager-title">Phone manager</h2>
          <p>Check backup status and choose where Silo saves browseable copies.</p>
        </div>
        <button
          className="mobile-scan-button"
          onClick={onScan}
          disabled={scanning}
          title="Scan for connected phones and tablets"
          data-help="Refresh the device list to discover phones and tablets connected to this Mac."
        >
          <FiRefreshCw /> {scanning ? "Scanning…" : "Scan devices"}
        </button>
      </header>

      <div className="phone-backup-settings" data-tour="mobile-backup-settings" data-help="Connecting creates or updates dated browseable copies in local storage; source files on the phone are unchanged. DEVICE WRITE: Restoring an iOS archive writes to the connected device and may replace current content.">
        <small className="phone-backup-scope">
          <strong>Dated browseable snapshots</strong> — Silo saves each distinct
          version of files exposed over USB (iOS media/file-sharing areas or
          Android shared storage). Snapshots do not include protected app data
          or device settings. Messages are managed separately below.
        </small>
        <label>Browseable-copy destination</label>
        <div className="backup-dest-display">
          <small title={backupDestination || "Default (local storage)"}>
            {backupDestination || "Default (local storage)"}
          </small>
          <button className="small-button" onClick={onChooseBackupDestination}
            title="Set the destination for future phone snapshots"
            data-help="Save the destination preference in Silo. This only chooses where future phone snapshots are stored."
          >
            {backupDestination ? "Change" : "Choose"} destination
          </button>
          {backupDestination && (
            <button
              className="small-button"
              onClick={onResetBackupDestination}
              title="Reset phone snapshot destination to default"
              aria-label="Reset phone snapshot destination to default"
              data-help="Use Silo’s default local-storage folder for future browseable copies."
            >
              <FiX />
            </button>
          )}
        </div>
      </div>

      <p className="phone-source-help">
        Browse a saved copy in <strong>Files → Sources</strong>. Select that
        phone or tablet, then filter the file type to Images or Documents. The
        saved copy remains a separate source while its destination is available.
      </p>

      {tooling && (!tooling.ios.available || !tooling.android.available) && (
        <div className="phone-tooling-notices">
          {!tooling.ios.available && (
            <p className="sidebar-empty tooling-hint">
              iPhone support needs <code>{tooling.ios.missing.join(", ")}</code>.{" "}
              {tooling.ios.installHint}
            </p>
          )}
          {!tooling.android.available && (
            <p className="sidebar-empty tooling-hint">
              Android support needs <code>{tooling.android.missing.join(", ")}</code>.{" "}
              {tooling.android.installHint}
            </p>
          )}
        </div>
      )}

      {devices.some((device) => backups[`${device.platform}:${device.id}`]) && (
        <div className="phone-backup-status-list" aria-label="Phone backup status">
          {devices.map((device) => {
            const backup = backups[`${device.platform}:${device.id}`];
            return backup ? (
              <PhoneBackupStatus
                key={`${device.platform}:${device.id}`}
                device={device}
                backup={backup}
                formatFileSize={formatFileSize}
              />
            ) : null;
          })}
        </div>
      )}

      {notice && <p className="phone-manager-notice" role="status">{notice}</p>}
    </section>
  );
}

const BACKUP_TYPE_LABELS: Array<{ type: PhoneBackupFileType; label: string }> = [
  { type: "image", label: "Photos" },
  { type: "video", label: "Videos" },
  { type: "audio", label: "Audio" },
  { type: "document", label: "Documents" },
  { type: "other", label: "Other files" },
];

function PhoneBackupTypePicker({
  device,
  formatFileSize,
  onPreviewBackup,
  selected,
  onSelectedChange,
  onReady,
}: {
  device: PhoneDevice;
  formatFileSize: (bytes: number) => string;
  onPreviewBackup: (device: PhoneDevice) => Promise<PhoneBackupPreview>;
  selected: PhoneBackupFileType[] | null;
  onSelectedChange: (types: PhoneBackupFileType[]) => void;
  onReady: (ready: boolean) => void;
}) {
  const [preview, setPreview] = useState<PhoneBackupPreview | null>(null);
  const [error, setError] = useState("");
  const [found, setFound] = useState<{ files: number; bytes: number }>({ files: 0, bytes: 0 });

  useEffect(() => {
    let active = true;
    onReady(false);
    const unsubscribe = window.electron?.onPhoneScanProgress?.((progress) => {
      if (!active || progress.deviceId !== device.id || progress.platform !== device.platform) return;
      setFound({ files: progress.filesFound, bytes: progress.bytesFound });
    });
    onPreviewBackup(device)
      .then((result) => {
        if (!active) return;
        setPreview(result);
        if (!selected) onSelectedChange(result.selectedTypes);
      })
      .catch((reason) => {
        if (!active) return;
        console.error("[PhoneBackup] Preview scan failed:", reason);
        setError(reason instanceof Error ? reason.message : "Silo could not scan this device.");
      })
      .finally(() => {
        if (active) onReady(true);
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
    // Scan once per opened dialog.
  }, [device.id, device.platform]);

  if (error) {
    return (
      <p className="phone-backup-types-error" role="alert">
        {error} You can still back up with the previous file-type choices.
      </p>
    );
  }
  if (!preview) {
    return (
      <div className="phone-backup-types-loading" role="status" aria-live="polite">
        <span className="phone-backup-spinner" aria-hidden="true" />
        <span>
          Scanning {device.name}…{" "}
          {found.files > 0 &&
            `${found.files.toLocaleString()} files · ${formatFileSize(found.bytes)}`}
        </span>
      </div>
    );
  }
  const chosen = new Set(selected ?? preview.selectedTypes);
  const selectedFiles = BACKUP_TYPE_LABELS.reduce(
    (sum, { type }) => sum + (chosen.has(type) ? preview.types[type].count : 0),
    0,
  );
  const selectedBytes = BACKUP_TYPE_LABELS.reduce(
    (sum, { type }) => sum + (chosen.has(type) ? preview.types[type].bytes : 0),
    0,
  );
  return (
    <fieldset className="phone-backup-types">
      <legend className="phone-backup-dialog-label">What to back up</legend>
      {BACKUP_TYPE_LABELS.map(({ type, label }) => {
        const bucket = preview.types[type];
        return (
          <label key={type} className={bucket.count === 0 ? "empty" : ""}>
            <input
              type="checkbox"
              checked={chosen.has(type)}
              onChange={(event) => {
                const next = new Set(chosen);
                if (event.target.checked) next.add(type);
                else next.delete(type);
                onSelectedChange(BACKUP_TYPE_LABELS.map((entry) => entry.type).filter((entry) => next.has(entry)));
              }}
            />
            <span>{label}</span>
            <small>{bucket.count.toLocaleString()} files</small>
            <strong>{formatFileSize(bucket.bytes)}</strong>
          </label>
        );
      })}
      <p className="phone-backup-types-total">
        {selectedFiles.toLocaleString()} of {preview.totalFiles.toLocaleString()} files ·{" "}
        {formatFileSize(selectedBytes)}
      </p>
    </fieldset>
  );
}

export function PhoneManagementPanel({
  devices,
  tooling,
  busyDeviceId,
  activeDeviceKey,
  backups,
  backupDestination,
  formatFileSize,
  restoreArchives,
  onBrowse,
  onConnect,
  onDisconnect,
  onRename,
  onRenewBackup,
  onPreviewBackup,
  onChooseBackupDestination,
  onResetBackupDestination,
  onCreateRestoreArchive,
  onRestoreFromArchive,
}: PhoneManagementPanelProps) {
  const [backupRequest, setBackupRequest] = useState<
    { device: PhoneDevice; mode: "connect" | "renew" } | null
  >(null);
  const [backupTypes, setBackupTypes] = useState<PhoneBackupFileType[] | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const openBackupRequest = (device: PhoneDevice, mode: "connect" | "renew") => {
    setBackupTypes(null);
    setPreviewReady(false);
    setBackupRequest({ device, mode });
  };
  const startBackup = () => {
    if (!backupRequest) return;
    const { device, mode } = backupRequest;
    if (mode === "renew" && backupTypes && backupTypes.length === 0) return;
    setBackupRequest(null);
    if (mode === "connect") onConnect(device);
    else onRenewBackup(device, backupTypes ?? undefined);
  };
  return (
    <section className="phone-management-panel" aria-label="Mobile manager" data-tour="mobile-devices">
      {devices.length > 0 ? (
        <>
          <div className="phone-device-list">
            {devices.map((device) => (
              <PhoneDeviceCard
                key={`${device.platform}:${device.id}`}
                device={device}
                active={activeDeviceKey === `${device.platform}:${device.id}`}
                busyDeviceId={busyDeviceId}
                restoreArchives={restoreArchives}
                tooling={tooling}
                onBrowse={onBrowse}
                onConnect={(target) => openBackupRequest(target, "connect")}
                onDisconnect={onDisconnect}
                onRename={onRename}
                onRenewBackup={(target) => openBackupRequest(target, "renew")}
                onCreateRestoreArchive={onCreateRestoreArchive}
                onRestoreFromArchive={onRestoreFromArchive}
              />
            ))}
          </div>
          {devices.some((device) => backups[`${device.platform}:${device.id}`]) && (
            <div className="phone-backup-status-list" aria-label="Phone backup status">
              {devices.map((device) => {
                const backup = backups[`${device.platform}:${device.id}`];
                return backup ? (
                  <PhoneBackupStatus
                    key={`${device.platform}:${device.id}`}
                    device={device}
                    backup={backup}
                    formatFileSize={formatFileSize}
                  />
                ) : null;
              })}
            </div>
          )}
        </>
      ) : (
        <div className="phone-device-empty">
          <FiSmartphone aria-hidden="true" />
          <span>Scan for a connected phone or tablet to manage it here.</span>
        </div>
      )}
      {backupRequest && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setBackupRequest(null);
          }}
        >
          <form
            className="app-dialog phone-backup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-backup-dialog-title"
            data-tour="mobile-backup-settings"
            onSubmit={(event) => {
              event.preventDefault();
              startBackup();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setBackupRequest(null);
              }
            }}
          >
            <h2 id="phone-backup-dialog-title">Back up {backupRequest.device.name}</h2>
            <p>
              Silo saves a dated snapshot of the photos, messages, and other files it can read from this device. Files on the phone are not changed.
            </p>
            <label className="phone-backup-dialog-label">Save to</label>
            <div className="backup-dest-display">
              <small title={backupDestination || "Default (local storage)"}>
                {backupDestination || "Default (local storage)"}
              </small>
              <button type="button" className="small-button" onClick={onChooseBackupDestination}>
                {backupDestination ? "Change" : "Choose"}
              </button>
              {backupDestination && (
                <button
                  type="button"
                  className="small-button"
                  onClick={onResetBackupDestination}
                  title="Reset phone snapshot destination to default"
                  aria-label="Reset phone snapshot destination to default"
                >
                  <FiX />
                </button>
              )}
            </div>
            {backupRequest.mode === "renew" && (
              <PhoneBackupTypePicker
                device={backupRequest.device}
                formatFileSize={formatFileSize}
                onPreviewBackup={onPreviewBackup}
                selected={backupTypes}
                onSelectedChange={setBackupTypes}
                onReady={setPreviewReady}
              />
            )}
            <p className="phone-source-help">
              The saved copy appears in <strong>Files → Sources</strong> and stays there while this destination is connected.
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setBackupRequest(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                autoFocus
                disabled={
                  backupRequest.mode === "renew" &&
                  (!previewReady || (backupTypes !== null && backupTypes.length === 0))
                }
              >
                Back up now
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

export default PhoneManagerPanel;
