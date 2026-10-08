import React, { useState } from "react";
import { FiEdit3, FiRefreshCw, FiSmartphone, FiX } from "react-icons/fi";

interface PhoneManagerPanelProps {
  devices: PhoneDevice[];
  tooling: PhoneTooling | null;
  scanning: boolean;
  busyDeviceId: string | null;
  activeDeviceKey: string | null;
  notice: string;
  backups: Record<string, PhoneBackupProgress>;
  restoreArchives: PhoneRestoreArchive[];
  backupDestination: string | null;
  formatFileSize: (bytes: number) => string;
  onScan: () => void;
  onBrowse: (device: PhoneDevice) => void;
  onConnect: (device: PhoneDevice) => void;
  onDisconnect: (device: PhoneDevice) => void;
  onRename: (device: PhoneDevice) => void;
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

function PhoneManagerPanel({
  devices,
  tooling,
  scanning,
  busyDeviceId,
  activeDeviceKey,
  notice,
  backups,
  restoreArchives,
  backupDestination,
  formatFileSize,
  onScan,
  onBrowse,
  onConnect,
  onDisconnect,
  onRename,
  onChooseBackupDestination,
  onResetBackupDestination,
  onCreateRestoreArchive,
  onRestoreFromArchive,
}: PhoneManagerPanelProps) {
  const [backupPasswords, setBackupPasswords] = useState<Record<string, string>>({});
  const [confirmPasswords, setConfirmPasswords] = useState<Record<string, string>>({});
  const [restorePasswords, setRestorePasswords] = useState<Record<string, string>>({});
  const [restoreBusyKey, setRestoreBusyKey] = useState<string | null>(null);
  const [restoreFormNotice, setRestoreFormNotice] = useState("");

  const createRestoreArchive = async (device: PhoneDevice, deviceKey: string) => {
    const password = backupPasswords[deviceKey] || "";
    if (password.length < 8 || password !== (confirmPasswords[deviceKey] || "")) {
      setRestoreFormNotice("Enter a matching password with at least 8 characters.");
      return;
    }
    setRestoreBusyKey(deviceKey);
    setRestoreFormNotice("");
    try {
      const created = await onCreateRestoreArchive(device, password);
      if (created) {
        setBackupPasswords((current) => ({ ...current, [deviceKey]: "" }));
        setConfirmPasswords((current) => ({ ...current, [deviceKey]: "" }));
      }
    } finally {
      setRestoreBusyKey(null);
    }
  };

  const restoreFromArchive = async (
    archive: PhoneRestoreArchive,
    deviceKey: string,
    targetDeviceId: string,
  ) => {
    const password = restorePasswords[deviceKey] || "";
    if (!password) {
      setRestoreFormNotice("Enter the archive password before restoring.");
      return;
    }
    setRestoreBusyKey(deviceKey);
    setRestoreFormNotice("");
    try {
      const restored = await onRestoreFromArchive(targetDeviceId, archive, password);
      if (restored)
        setRestorePasswords((current) => ({ ...current, [deviceKey]: "" }));
    } finally {
      setRestoreBusyKey(null);
    }
  };

  return (
    <section className="phone-manager-panel" aria-labelledby="phone-manager-title">
      <header className="mobile-section-heading" data-tour="mobile-devices">
        <div>
          <span className="sidebar-kicker">Phones and tablets</span>
          <h2 id="phone-manager-title">Phone manager</h2>
          <p>Connect devices and manage Silo’s browseable file copies.</p>
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

      <div className="phone-backup-settings" data-tour="mobile-backup-settings" data-help="Choose the destination for dated browseable copies and review the different restore scopes for iOS archives and Android shared-file snapshots.">
        <small className="phone-backup-scope">
          <strong>Dated browseable snapshots</strong> — Silo saves each distinct
          version of files exposed over USB (iOS media/file-sharing areas or
          Android shared storage). Snapshots do not include protected app data
          or device settings. Messages are managed separately below.
        </small>
        <div className="phone-restore-status" role="note">
          <strong>Restore scope</strong>
          <span>
            iPhone and iPad can use encrypted, timestamped Apple restore
            archives. These are not raw disk images and follow Apple’s backup
            exclusions. Android snapshots cover accessible shared files only;
            use the device maker or Android system restore for app data and
            settings.
          </span>
        </div>
        <label>Browseable-copy destination</label>
        <div className="backup-dest-display">
          <small title={backupDestination || "Default (local storage)"}>
            {backupDestination || "Default (local storage)"}
          </small>
          <button className="small-button" onClick={onChooseBackupDestination}
            data-help="Choose where dated, browseable copies of accessible device files are stored.">
            {backupDestination ? "Change" : "Choose"} destination
          </button>
          {backupDestination && (
            <button
              className="small-button"
              onClick={onResetBackupDestination}
              title="Reset to default"
              aria-label="Reset backup destination to default"
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

      {devices.length > 0 ? (
        <div className="phone-device-list">
          {devices.map((device) => {
            const deviceKey = `${device.platform}:${device.id}`;
            const backup = backups[deviceKey];
            const backupPercent = backup?.totalBytes
              ? Math.min(100, (backup.completedBytes / backup.totalBytes) * 100)
              : backup?.totalFiles
                ? Math.min(
                    100,
                    (backup.completedFiles / backup.totalFiles) * 100,
                  )
                : 0;

            return (
              <article
                className={`phone-device ${activeDeviceKey === deviceKey ? "active" : ""}`}
                key={deviceKey}
              >
                <div className="phone-device-info">
                  <span className={`phone-badge ${device.platform}`}>
                    {device.platform === "ios" ? "iOS" : "Android"}
                  </span>
                  <strong title={device.name}>{device.name}</strong>
                  <small className={`phone-status ${device.status}`}>
                    {device.message}
                  </small>
                </div>
                <div className="phone-device-actions" data-tour="mobile-device-actions" data-help="Rename a device, connect or browse it, or unmount an iPhone. Device actions affect the connection and saved source, not the contents of the phone by themselves.">
                  <button
                    onClick={() => onRename(device)}
                    title={`Rename ${device.name}`}
                    aria-label={`Rename ${device.name}`}
                  >
                    <FiEdit3 />
                  </button>
                  {device.status === "ready" && device.rootPath ? (
                    <>
                      <button
                        onClick={() => onBrowse(device)}
                        disabled={busyDeviceId === device.id}
                      >
                        Browse
                      </button>
                      {device.platform === "ios" && (
                        <button
                          onClick={() => onDisconnect(device)}
                          disabled={busyDeviceId === device.id}
                          title="Unmount device"
                          aria-label={`Disconnect ${device.name}`}
                        >
                          <FiX />
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => onConnect(device)}
                      disabled={busyDeviceId === device.id}
                    >
                      {busyDeviceId === device.id ? "Connecting…" : "Connect"}
                    </button>
                  )}
                </div>
                {backup && (
                  <div className={`phone-backup-progress ${backup.status}`}>
                    <div>
                          <span>
                            <strong>Browseable snapshot:</strong> {backup.message}
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
                )}
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
                      value={backupPasswords[deviceKey] || ""}
                      onChange={(event) =>
                        setBackupPasswords((current) => ({
                          ...current,
                          [deviceKey]: event.target.value,
                        }))
                      }
                      placeholder="At least 8 characters"
                    />
                    <label htmlFor={`phone-backup-password-confirm-${deviceKey}`}>
                      Confirm password to create
                    </label>
                    <input
                      id={`phone-backup-password-confirm-${deviceKey}`}
                      type="password"
                      autoComplete="new-password"
                      value={confirmPasswords[deviceKey] || ""}
                      onChange={(event) =>
                        setConfirmPasswords((current) => ({
                          ...current,
                          [deviceKey]: event.target.value,
                        }))
                      }
                      placeholder="Re-enter password"
                    />
                    <small>
                      Silo never saves this password. Keep it safe; a lost
                      encrypted-backup password cannot be recovered here.
                    </small>
                    <button
                      className="small-button"
                      disabled={
                        restoreBusyKey === deviceKey ||
                        !tooling ||
                        tooling.ios.missing.includes("idevicebackup2")
                      }
                      onClick={() => void createRestoreArchive(device, deviceKey)}
                    >
                      {restoreBusyKey === deviceKey
                        ? "Working…"
                        : "Create encrypted restore archive"}
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
                              restoreBusyKey === deviceKey ||
                              !device.model ||
                              archive.deviceModel !== device.model
                            }
                            onClick={() =>
                              void restoreFromArchive(archive, deviceKey, device.id)
                            }
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
                      value={restorePasswords[deviceKey] || ""}
                      onChange={(event) =>
                        setRestorePasswords((current) => ({
                          ...current,
                          [deviceKey]: event.target.value,
                        }))
                      }
                      placeholder="Enter the archive password"
                    />
                    {restoreFormNotice && (
                      <small role="status">{restoreFormNotice}</small>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="phone-device-empty">
          <FiSmartphone aria-hidden="true" />
          <span>Connect a phone or tablet to manage it here.</span>
        </div>
      )}

      {notice && <p className="phone-manager-notice" role="status">{notice}</p>}
    </section>
  );
}

export default PhoneManagerPanel;
