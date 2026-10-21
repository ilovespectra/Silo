import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiAlertCircle, FiChevronRight, FiFile, FiFolder, FiLink2, FiRefreshCw, FiX } from "react-icons/fi";

interface FalloutShelterBrowserProps {
  api: NonNullable<Window["electron"]>;
  onClose: () => void;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

export default function FalloutShelterBrowser({ api, onClose }: FalloutShelterBrowserProps) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.getShelterBackupCatalog>> | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [directoryLocation, setDirectoryLocation] = useState({ backupId: "", path: "" });
  const directory = directoryLocation.backupId === selectedId ? directoryLocation.path : "";
  const setDirectory = (nextPath: string) => setDirectoryLocation({ backupId: selectedId, path: nextPath });
  const [entries, setEntries] = useState<ShelterBackupBrowserEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const selectedBackup = useMemo(
    () => catalog?.backups.find((backup) => backup.id === selectedId) ?? null,
    [catalog, selectedId],
  );

  const refreshCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setError("");
    try {
      const next = await api.getShelterBackupCatalog();
      setCatalog(next);
      setSelectedId((current) => next.backups.some((backup) => backup.id === current)
        ? current
        : next.backups[0]?.id ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the Fallout Shelter catalog.");
    } finally {
      setLoadingCatalog(false);
    }
  }, [api]);

  const loadDirectory = useCallback(async (
    backupId: string,
    relativeDirectory: string,
    afterName: string | null,
    append: boolean,
  ) => {
    const request = ++requestId.current;
    if (append) setLoadingMore(true);
    else {
      setLoadingDirectory(true);
      setEntries([]);
      setCursor(null);
    }
    setError("");
    try {
      const page = await api.listShelterBackupDirectory(backupId, relativeDirectory, afterName, 100);
      if (request !== requestId.current) return;
      if (page.error) throw new Error(page.error);
      setEntries((current) => append ? [...current, ...page.entries] : page.entries);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (request === requestId.current)
        setError(cause instanceof Error ? cause.message : "Could not list this backup folder.");
    } finally {
      if (request === requestId.current) {
        setLoadingDirectory(false);
        setLoadingMore(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void refreshCatalog();
    return () => { requestId.current += 1; };
  }, [refreshCatalog]);

  useEffect(() => {
    if (!selectedId) {
      setEntries([]);
      setCursor(null);
      return;
    }
    void loadDirectory(selectedId, directory, null, false);
  }, [catalog, directory, loadDirectory, selectedId]);

  const openDirectory = (relativePath: string) => setDirectory(relativePath);
  const parentDirectory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
  const breadcrumbs = directory ? directory.split("/") : [];

  return (
    <section className="stats-card fallout-shelter-browser" aria-label="Browse Fallout Shelter backups">
      <header className="stats-card-heading">
        <div className="stats-heading-icon vault"><FiFolder /></div>
        <div><span className="stats-kicker">BACKUP BROWSER</span><h2>Browse Fallout Shelters</h2></div>
        <div className="fallout-shelter-browser-actions">
          <button className="stats-text-button" onClick={() => void refreshCatalog()} disabled={loadingCatalog} aria-label="Refresh backup list">
            <FiRefreshCw className={loadingCatalog ? "stats-spin" : ""} /> Refresh
          </button>
          <button className="stats-text-button" onClick={onClose} aria-label="Close backup browser"><FiX /> Close</button>
        </div>
      </header>
      <p className="stats-shelter-copy">Browse complete Fallout Shelter snapshots on the configured primary destination. Folder listings are paged so large libraries do not load every entry into the renderer at once.</p>

      {catalog?.destination && <div className="fallout-shelter-browser-destination"><strong>Primary destination</strong><span title={catalog.destination}>{catalog.destination}</span></div>}
      {catalog?.available && catalog.backups.length > 0 && (
        <label className="fallout-shelter-browser-select">
          <span>Backup snapshot</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
            {catalog.backups.map((backup) => (
              <option key={backup.id} value={backup.id}>
                {new Date(backup.createdAt).toLocaleString()} · {backup.container === "zip" ? "ZIP" : "Folder"} · {backup.fileCount.toLocaleString()} file paths · {backup.omittedPathCount.toLocaleString()} omissions
              </option>
            ))}
          </select>
        </label>
      )}

      {loadingCatalog && <p className="fallout-shelter-browser-status" role="status">Reading complete backup list…</p>}
      {!loadingCatalog && !catalog?.available && (
        <div className="fallout-shelter-browser-empty"><FiAlertCircle /><span>{catalog?.error || "The configured Fallout Shelter destination is unavailable. Connect it to browse its backups."}</span></div>
      )}
      {!loadingCatalog && catalog?.available && catalog.backups.length === 0 && (
        <p className="fallout-shelter-browser-empty">No complete Fallout Shelter snapshots were found in this destination.</p>
      )}

      {selectedBackup && (
        <>
          <div className="fallout-shelter-browser-summary">
            <span><strong>{selectedBackup.fileCount.toLocaleString()}</strong> file paths</span>
            <span><strong>{selectedBackup.omittedPathCount.toLocaleString()}</strong> audited omissions</span>
            <span>{selectedBackup.container === "zip" ? "Compressed archive" : "Browseable folder copy"}</span>
          </div>
          <nav className="fallout-shelter-breadcrumbs" aria-label="Backup folder path">
            <button onClick={() => setDirectory("")}>{selectedBackup.name}</button>
            {breadcrumbs.map((segment, index) => {
              const pathToSegment = breadcrumbs.slice(0, index + 1).join("/");
              return <React.Fragment key={pathToSegment}>
                <FiChevronRight aria-hidden="true" />
                <button onClick={() => setDirectory(pathToSegment)}>{segment}</button>
              </React.Fragment>;
            })}
          </nav>
          {directory && <button className="stats-text-button fallout-shelter-parent" onClick={() => setDirectory(parentDirectory)}><FiChevronRight className="fallout-shelter-parent-icon" /> Up one folder</button>}

          {loadingDirectory ? <p className="fallout-shelter-browser-status" role="status">Reading this folder…</p> : (
            <div className="fallout-shelter-browser-list" aria-live="polite">
              {!entries.length && !error && <p className="fallout-shelter-browser-empty">This folder is empty.</p>}
              {entries.map((entry) => (
                <div className="fallout-shelter-browser-entry" key={entry.relativePath}>
                  {entry.isDirectory ? <FiFolder aria-hidden="true" /> : entry.isAlias ? <FiLink2 aria-hidden="true" /> : <FiFile aria-hidden="true" />}
                  {entry.isDirectory
                    ? <button className="fallout-shelter-browser-entry-name" onClick={() => openDirectory(entry.relativePath)} title={entry.relativePath}>{entry.name}</button>
                    : <span className="fallout-shelter-browser-entry-name" title={entry.relativePath}>{entry.name}</span>}
                  {entry.isAlias && <small title={entry.canonicalPath ? `Stored once at ${entry.canonicalPath}` : "Content is stored once elsewhere in this backup"}>Shared content</small>}
                  <span className="fallout-shelter-browser-entry-size">{entry.isDirectory ? "Folder" : formatBytes(entry.size)}</span>
                </div>
              ))}
            </div>
          )}
          {cursor && !loadingDirectory && <button className="stats-button small fallout-shelter-browser-more" onClick={() => void loadDirectory(selectedId, directory, cursor, true)} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load next 100 entries"}</button>}
        </>
      )}
      {error && <div className="stats-inline-error"><FiAlertCircle /> {error}</div>}
    </section>
  );
}
