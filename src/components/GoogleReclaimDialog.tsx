import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiFolder, FiHardDrive, FiMail, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import "../styles/GoogleReclaimDialog.css";

type ReclaimApi = Pick<
  NonNullable<Window["electron"]>,
  | "googleReclaimOverview"
  | "googleReclaimChooseDestination"
  | "googleReclaimRun"
  | "googleReclaimCancel"
  | "googleEmptyDriveTrash"
  | "googleOpenGmailTrash"
  | "onGoogleReclaimProgress"
>;

interface GoogleReclaimDialogProps {
  api: ReclaimApi;
  account: { id: string; email: string; gmailAccess: boolean };
  onReconnect: () => void;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

const itemKey = (item: GoogleReclaimItem) => `${item.kind}:${item.id}`;

export default function GoogleReclaimDialog({ api, account, onReconnect, onClose }: GoogleReclaimDialogProps) {
  const [overview, setOverview] = useState<GoogleReclaimOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<GoogleReclaimKind>("drive");
  const tabChosen = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [destination, setDestination] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GoogleReclaimProgress | null>(null);
  const [result, setResult] = useState<GoogleReclaimResult | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.googleReclaimOverview(account.id);
      if (!response.ok || !response.overview) {
        setError(response.error || "Google storage could not be loaded.");
        return;
      }
      setOverview(response.overview);
      if (!tabChosen.current) {
        tabChosen.current = true;
        if (response.overview.driveFiles.length === 0) setTab("gmail");
      }
      setDestination(response.overview.destination);
      const available = new Set([...response.overview.driveFiles, ...response.overview.emails].map(itemKey));
      setSelected((current) => new Set([...current].filter((key) => available.has(key))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api, account.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => api.onGoogleReclaimProgress((next) => {
    if (next.accountId === account.id) setProgress(next);
  }), [api, account.id]);

  const items = useMemo(() => (tab === "drive" ? overview?.driveFiles : overview?.emails) ?? [], [overview, tab]);
  const allItems = useMemo(() => [...(overview?.driveFiles ?? []), ...(overview?.emails ?? [])], [overview]);
  const selectedItems = allItems.filter((item) => selected.has(itemKey(item)));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.size, 0);
  const tabAllSelected = items.length > 0 && items.every((item) => selected.has(itemKey(item)));

  const toggle = (item: GoogleReclaimItem) => setSelected((current) => {
    const next = new Set(current);
    const key = itemKey(item);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleTab = () => setSelected((current) => {
    const next = new Set(current);
    for (const item of items) {
      if (tabAllSelected) next.delete(itemKey(item)); else next.add(itemKey(item));
    }
    return next;
  });

  const chooseDestination = async () => {
    const response = await api.googleReclaimChooseDestination();
    if (response.destination !== undefined) setDestination(response.destination ?? null);
    if (response.error) setError(response.error);
  };

  const run = async () => {
    if (!selectedItems.length || running) return;
    if (!destination) { await chooseDestination(); return; }
    setRunning(true);
    setResult(null);
    setError("");
    setProgress({ accountId: account.id, done: 0, total: selectedItems.length, bytes: 0, current: "Starting…" });
    try {
      const next = await api.googleReclaimRun(account.id, selectedItems.map(({ id, kind }) => ({ id, kind })));
      setResult(next);
      if (next.error) setError(next.error);
      const failedKeys = new Set(next.failed.map((item) => item.id));
      setSelected((current) => new Set([...current].filter((key) => failedKeys.has(key.slice(key.indexOf(":") + 1)))));
    } finally {
      setRunning(false);
      setProgress(null);
      void load();
    }
  };

  const emptyDriveTrash = async () => {
    setEmptying(true);
    setError("");
    try {
      const response = await api.googleEmptyDriveTrash(account.id);
      if (!response.ok) setError(response.error || "Drive trash could not be emptied.");
      setConfirmEmpty(false);
      await load();
    } finally {
      setEmptying(false);
    }
  };

  const storage = overview?.storage;
  const otherUsage = storage ? Math.max(0, storage.usage - storage.usageInDrive) : 0;
  const driveActive = storage ? Math.max(0, storage.usageInDrive - storage.usageInDriveTrash) : 0;
  const scale = storage ? Math.max(storage.limit ?? storage.usage, storage.usage, 1) : 1;
  const percent = (value: number) => `${Math.min(100, (value / scale) * 100)}%`;
  const gmailBlocked = tab === "gmail" && !(overview?.gmailAccess ?? account.gmailAccess);
  const close = () => { if (!running) onClose(); };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section
        className="app-dialog google-reclaim-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="google-reclaim-title"
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}
      >
        <header className="google-reclaim-header">
          <div>
            <h2 id="google-reclaim-title">Free up Google space</h2>
            <span>{account.email}</span>
          </div>
          <button type="button" className="google-reclaim-icon" onClick={() => { void load(); }} disabled={loading || running} title="Refresh" aria-label="Refresh">
            <FiRefreshCw className={loading ? "spinning" : ""} />
          </button>
        </header>

        {storage && (
          <div className="google-reclaim-storage" aria-label="Google storage">
            <div className="google-reclaim-bar">
              <span className="drive" style={{ width: percent(driveActive) }} />
              <span className="trash" style={{ width: percent(storage.usageInDriveTrash) }} />
              <span className="other" style={{ width: percent(otherUsage) }} />
            </div>
            <div className="google-reclaim-legend">
              <span><i className="drive" />Drive {formatBytes(driveActive)}</span>
              <span><i className="trash" />Drive trash {formatBytes(storage.usageInDriveTrash)}</span>
              <span><i className="other" />Gmail &amp; Photos {formatBytes(otherUsage)}</span>
              <strong>{formatBytes(storage.usage)}{storage.limit ? ` of ${formatBytes(storage.limit)}` : ""}</strong>
            </div>
          </div>
        )}

        <div className="google-reclaim-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "drive"} className={tab === "drive" ? "active" : ""} onClick={() => setTab("drive")}>
            <FiHardDrive /> Drive files <small>{overview?.driveFiles.length ?? 0}</small>
          </button>
          <button type="button" role="tab" aria-selected={tab === "gmail"} className={tab === "gmail" ? "active" : ""} onClick={() => setTab("gmail")}>
            <FiMail /> Large emails <small>{overview?.emails.length ?? 0}</small>
          </button>
        </div>

        <div className="google-reclaim-list" role="tabpanel">
          {loading && !overview ? (
            <p className="google-reclaim-empty">Reading your Google storage…</p>
          ) : gmailBlocked ? (
            <div className="google-reclaim-empty">
              <p>Silo needs permission to move emails to Gmail Trash. Reconnect and tick Gmail on Google's consent screen.</p>
              <button type="button" className="google-reclaim-secondary" onClick={onReconnect}>Reconnect account</button>
            </div>
          ) : (tab === "drive" ? overview?.driveError : overview?.gmailError) ? (
            <p className="google-reclaim-empty">{tab === "drive" ? overview?.driveError : overview?.gmailError}</p>
          ) : items.length === 0 ? (
            <p className="google-reclaim-empty">
              {tab === "gmail"
                ? "No emails over 5 MB were found."
                : storage && storage.usageInDrive < 1024 * 1024
                  ? `This account's Drive isn't using any storage. Files shared with you count against their owner. The ${formatBytes(otherUsage)} used here is Gmail and Google Photos.`
                  : "No files you own were found in Drive."}
            </p>
          ) : (
            <>
              <label className="google-reclaim-row google-reclaim-all">
                <input type="checkbox" checked={tabAllSelected} onChange={toggleTab} disabled={running} />
                <span>Select all</span>
              </label>
              {items.map((item) => (
                <label key={itemKey(item)} className="google-reclaim-row">
                  <input type="checkbox" checked={selected.has(itemKey(item))} onChange={() => toggle(item)} disabled={running} />
                  <span className="google-reclaim-name">
                    <strong title={item.name}>{item.name}</strong>
                    <small title={item.detail}>{item.detail}{item.modified ? ` · ${new Date(item.modified).toLocaleDateString()}` : ""}</small>
                  </span>
                  <span className="google-reclaim-size">{formatBytes(item.size)}</span>
                </label>
              ))}
            </>
          )}
        </div>

        <div className="google-reclaim-destination">
          <FiFolder />
          <span title={destination ?? undefined}>{destination ?? "Choose where verified copies are saved"}</span>
          <button type="button" className="google-reclaim-secondary" onClick={() => { void chooseDestination(); }} disabled={running}>
            {destination ? "Change" : "Choose"}
          </button>
        </div>

        {progress && (
          <div className="google-reclaim-progress" role="status" aria-live="polite">
            <div className="google-reclaim-progress-bar"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
            <small>{progress.done} of {progress.total} · {formatBytes(progress.bytes)} saved · {progress.current}</small>
          </div>
        )}
        {result && !running && (
          <div className="google-reclaim-result" role="status">
            {result.trashed > 0 && <p>Saved and moved {result.trashed} {result.trashed === 1 ? "item" : "items"} ({formatBytes(result.bytes)}) to Google's trash.</p>}
            {result.failed.length > 0 && (
              <details>
                <summary>{result.failed.length} not trashed</summary>
                <ul>{result.failed.slice(0, 20).map((item) => <li key={item.id}><strong>{item.name}</strong>: {item.error}</li>)}</ul>
              </details>
            )}
          </div>
        )}
        {error && <p className="dialog-error" role="alert">{error}</p>}

        <p className="google-reclaim-note">
          Silo saves a checksum-verified copy first and only then moves the original to Google's trash. Space returns once the trash is emptied.
        </p>

        <div className="google-reclaim-trash">
          {confirmEmpty ? (
            <>
              <span>Permanently delete everything in Drive trash ({formatBytes(storage?.usageInDriveTrash ?? 0)})?</span>
              <button type="button" className="google-reclaim-secondary" onClick={() => setConfirmEmpty(false)} disabled={emptying}>Keep</button>
              <button type="button" className="google-reclaim-danger" onClick={() => { void emptyDriveTrash(); }} disabled={emptying}>{emptying ? "Emptying…" : "Delete forever"}</button>
            </>
          ) : (
            <>
              <button type="button" className="google-reclaim-secondary" onClick={() => setConfirmEmpty(true)} disabled={running || !storage?.usageInDriveTrash}>
                <FiTrash2 /> Empty Drive trash{storage?.usageInDriveTrash ? ` · ${formatBytes(storage.usageInDriveTrash)}` : ""}
              </button>
              <button type="button" className="google-reclaim-secondary" onClick={() => { void api.googleOpenGmailTrash(account.id); }} disabled={running}>
                <FiMail /> Open Gmail trash
              </button>
            </>
          )}
        </div>

        <div className="dialog-actions">
          {running ? (
            <button type="button" onClick={() => { void api.googleReclaimCancel(); }}>Stop after current item</button>
          ) : (
            <button type="button" onClick={close}>Close</button>
          )}
          <button type="button" className="primary" onClick={() => { void run(); }} disabled={running || selectedItems.length === 0}>
            {running ? "Backing up…" : selectedItems.length ? `Back up & trash ${selectedItems.length} · ${formatBytes(selectedBytes)}` : "Back up & trash"}
          </button>
        </div>
      </section>
    </div>
  );
}
