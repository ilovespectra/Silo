import React, { useState } from "react";
import { FiEdit3, FiRefreshCw, FiSmartphone, FiX } from "react-icons/fi";

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
  restoreArchives: PhoneRestoreArchive[];
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
      <div className="phone-device-actions" data-tour="mobile-device-actions" data-help="Rename, browse, connect, unmount, or renew a phone’s browseable backup. Renewing updates Silo’s saved copy without changing files on the phone.">
        <button
          onClick={() => onRename(device)}
          title={`SILO DATA WRITE — Rename ${device.name} in Silo only`}
          aria-label={`SILO DATA WRITE — Rename ${device.name} in Silo only`}
        >
          <FiEdit3 /> Rename
        </button>
        {device.status === "ready" && device.rootPath ? (
          <>
            <button
              onClick={() => onBrowse(device)}
              disabled={busyDeviceId === device.id}
              title="READ ONLY — Browse files exposed by this device"
              data-help="READ ONLY: Browse accessible files without changing the connected device."
            >
              Browse
            </button>
            <button
              className="phone-renew-backup-button"
              onClick={() => onRenewBackup(device)}
              disabled={busyDeviceId === device.id}
              title="DESTINATION WRITE — Renew this phone’s browseable snapshot in Silo; the phone’s files are unchanged"
              data-help="DESTINATION WRITE: Scan this connected phone and update its browseable snapshot in Silo. This does not change files on the phone."
            >
              <FiRefreshCw /> {busyDeviceId === device.id ? "Renewing…" : "Renew backup"}
            </button>
            {device.platform === "ios" && (
              <button
                onClick={() => onDisconnect(device)}
                disabled={busyDeviceId === device.id}
                title="READ ONLY — Unmount device without changing its contents"
                aria-label={`READ ONLY — Disconnect ${device.name}`}
              >
                <FiX /> Disconnect
              </button>
            )}
          </>
        ) : (
          <button
            onClick={() => onConnect(device)}
            disabled={busyDeviceId === device.id}
            title="DESTINATION WRITE — Connect and save a dated snapshot in Silo"
            data-help="DESTINATION WRITE: Connecting starts or updates a dated local snapshot of accessible files. It does not change files on the device."
          >
            {busyDeviceId === device.id ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
      {device.platform === "ios" && device.status === "ready" && (
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
            title="DESTINATION WRITE — Save an encrypted restore archive in Silo"
            data-help="DESTINATION WRITE: Save an encrypted iPhone or iPad restore archive in Silo storage; this does not restore or change the device."
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

      <div className="phone-backup-settings" data-tour="mobile-backup-settings" data-help="DESTINATION WRITE: Connecting creates or updates dated browseable copies in local storage; source files on the phone are unchanged. DEVICE WRITE: Restoring an iOS archive writes to the connected device and may replace current content.">
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
            title="SILO DATA WRITE — Set the destination for future phone snapshots"
            data-help="SILO DATA WRITE: Save the destination preference in Silo. This only chooses where future phone snapshots are stored."
          >
            {backupDestination ? "Change" : "Choose"} destination
          </button>
          {backupDestination && (
            <button
              className="small-button"
              onClick={onResetBackupDestination}
              title="SILO DATA WRITE — Reset phone snapshot destination to default"
              aria-label="SILO DATA WRITE — Reset phone snapshot destination to default"
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
              iPhone support needs <code>{tooling.ios.missing.join(", ")}</code>.
              Install with <code>{tooling.ios.installHint}</code>
            </p>
          )}
          {!tooling.android.available && (
            <p className="sidebar-empty tooling-hint">
              Android support needs <code>{tooling.android.missing.join(", ")}</code>.
              Install with <code>{tooling.android.installHint}</code>
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

export function PhoneManagementPanel({
  devices,
  tooling,
  busyDeviceId,
  activeDeviceKey,
  restoreArchives,
  onBrowse,
  onConnect,
  onDisconnect,
  onRename,
  onRenewBackup,
  onCreateRestoreArchive,
  onRestoreFromArchive,
}: PhoneManagementPanelProps) {
  return (
    <section className="phone-management-panel" aria-labelledby="phone-management-title">
      <header className="mobile-section-heading" data-tour="mobile-phone-management">
        <div>
          <span className="sidebar-kicker">Device controls</span>
          <h2 id="phone-management-title">Manage phones</h2>
          <p>Browse, renew backups, and manage connected devices.</p>
        </div>
      </header>

      {devices.length > 0 ? (
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
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onRename={onRename}
              onRenewBackup={onRenewBackup}
              onCreateRestoreArchive={onCreateRestoreArchive}
              onRestoreFromArchive={onRestoreFromArchive}
            />
          ))}
        </div>
      ) : (
        <div className="phone-device-empty">
          <FiSmartphone aria-hidden="true" />
          <span>Scan for a connected phone or tablet to manage it here.</span>
        </div>
      )}
    </section>
  );
}

export default PhoneManagerPanel;
