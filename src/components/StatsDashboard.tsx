import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FiActivity,
  FiAlertCircle,
  FiCheckCircle,
  FiCloudOff,
  FiCopy,
  FiDatabase,
  FiHardDrive,
  FiRefreshCw,
  FiShield,
  FiTerminal,
} from "react-icons/fi";
import IndexingPanel from "./IndexingPanel";
import SourceClonePanel from "./SourceClonePanel";

interface StatsDashboardProps {
  api: NonNullable<Window["electron"]>;
}

const categoryLabels: Record<LibraryCategory, string> = {
  image: "Photos & images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
  archive: "Archives",
  other: "Other files",
};
const categoryOrder: LibraryCategory[] = ["image", "video", "audio", "document", "archive", "other"];
const activeIndexerStatuses = new Set(["scanning", "loading-model", "indexing", "generating", "clustering"]);

function isLibraryDashboardSnapshot(value: unknown): value is LibraryDashboardSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<LibraryDashboardSnapshot>;
  return Boolean(
    snapshot.totals && typeof snapshot.totals.totalBytes === "number" &&
    snapshot.totals.categories && snapshot.shelter &&
    Array.isArray(snapshot.sources),
  );
}

function formatBytes(value: number | null | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) < 0) return "—";
  if ((value ?? 0) < 1024) return `${value ?? 0} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = (value ?? 0) / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function sourceKindLabel(kind: string) {
  if (kind === "local") return "Folder / drive";
  if (kind === "ios" || kind === "android") return kind === "ios" ? "iPhone / iPad" : "Android";
  if (kind === "gdrive") return "Google Drive";
  if (kind === "gphotos") return "Google Photos";
  return kind;
}

function shelterLabel(source: LibraryDashboardSource) {
  switch (source.shelterState) {
    case "verified": return "Verified · current inventory";
    case "changed": return "Source changed since verification";
    case "checking": return "Checking source currency…";
    case "offline": return "Verified previously · source offline";
    case "unknown": return "Verified copy · freshness unknown";
    default: return "No verified shelter copy";
  }
}

function RuntimeConsole({ api }: { api: NonNullable<Window["electron"]> }) {
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const cursor = useRef(0);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let inFlight = false;
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const result = await api.getRuntimeDiagnostics(cursor.current);
        if (disposed) return;
        cursor.current = result.cursor;
        setTruncated((current) => current || result.truncated);
        if (result.entries.length) {
          setEntries((current) => [...current, ...result.entries].slice(-500));
          setError("");
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
        if (!disposed) timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api]);

  useEffect(() => {
    if (followBottom.current && feedRef.current)
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [entries]);

  return (
    <section className="stats-console-card">
      <header className="stats-card-heading">
        <div className="stats-heading-icon"><FiTerminal /></div>
        <div><span className="stats-kicker">OPERATIONS TRACE</span><h2>Developer console</h2></div>
        <span className="stats-live-dot">LIVE</span>
      </header>
      <p className="stats-console-caption">Structured Silo runtime diagnostics · bounded to the newest 500 lines · filesystem paths may appear in diagnostic details.</p>
      {truncated && <small className="stats-console-note">Showing the recent log tail; older entries are not loaded.</small>}
      {error && <div className="stats-inline-error"><FiAlertCircle /> {error}</div>}
      <div
        className="stats-console-feed"
        ref={feedRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const following = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
          followBottom.current = following;
          setIsFollowing(following);
        }}
        role="log"
        aria-label="Structured runtime diagnostics"
        aria-live="off"
      >
        {entries.length === 0 ? <div className="stats-console-empty">Waiting for runtime events…</div> : entries.map((entry, index) => (
          <div className="stats-log-line" key={`${String(entry.time)}-${String(entry.event)}-${index}`}>
            <time>{entry.time ? new Date(String(entry.time)).toLocaleTimeString() : "—"}</time>
            <strong>{String(entry.event ?? "event")}</strong>
            <span>{JSON.stringify(entry, null, 0).slice(0, 2200)}</span>
          </div>
        ))}
      </div>
      <footer className="stats-console-footer">
        <span>{entries.length.toLocaleString()} recent events</span>
        <span>{isFollowing ? "Following newest" : "Scroll to bottom to resume follow"}</span>
      </footer>
    </section>
  );
}

export default function StatsDashboard({ api }: StatsDashboardProps) {
  const [snapshot, setSnapshot] = useState<LibraryDashboardSnapshot | null>(null);
  const [stages, setStages] = useState<IndexingStageProgress[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [showConsole, setShowConsole] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [showShelterReplica, setShowShelterReplica] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const lastAutoRefresh = useRef(0);

  const loadSnapshot = useCallback(async () => {
    const next = await api.getLibraryDashboard();
    if (!isLibraryDashboardSnapshot(next))
      throw new Error("Live Stats data is unavailable in this window. Open Stats in the Silo desktop app; if it is already open, restart Silo to update its desktop bridge.");
    if (!mounted.current) return next;
    setSnapshot(next);
    return next;
  }, [api]);

  const startInventory = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api.refreshLibraryStats();
      if (!isLibraryDashboardSnapshot(next))
        throw new Error("Live Stats data is unavailable in this window. Open Stats in the Silo desktop app; if it is already open, restart Silo to update its desktop bridge.");
      if (mounted.current) setSnapshot(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await loadSnapshot();
        const needsRefresh = !next.running && next.sources.some(
          (source) => source.available &&
            (!source.scannedAt || Date.now() - source.scannedAt > 15 * 60 * 1000),
        );
        if (needsRefresh && Date.now() - lastAutoRefresh.current > 60 * 1000) {
          lastAutoRefresh.current = Date.now();
          const refreshing = await api.refreshLibraryStats();
          if (isLibraryDashboardSnapshot(refreshing) && mounted.current)
            setSnapshot(refreshing);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), 8000);
    };
    void poll();
    return () => {
      disposed = true;
      mounted.current = false;
      window.clearTimeout(timer);
    };
  }, [api, loadSnapshot]);

  const availableSources = useMemo(
    () => (snapshot?.sources ?? []).filter((source) => source.available && source.rootPath),
    [snapshot?.sources],
  );
  const selectedSources = useMemo(
    () => availableSources.filter((source) => selectedIds.has(source.id)),
    [availableSources, selectedIds],
  );
  const currentStage = stages.find((stage) => activeIndexerStatuses.has(stage.status));
  const queuedStages = stages.filter((stage) => stage.resumeQueued);
  const currentPercent = currentStage && currentStage.total > 0
    ? Math.min(100, Math.round((currentStage.processed / currentStage.total) * 100))
    : 0;
  const categories = snapshot?.totals.categories ?? {};
  const maxCategoryFiles = Math.max(1, ...categoryOrder.map((category) => categories[category]?.files ?? 0));

  const toggleSource = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds((current) =>
    current.size === availableSources.length
      ? new Set()
      : new Set(availableSources.map((source) => source.id)),
  );

  return (
    <main className="stats-page">
      <header className="stats-page-heading">
        <div>
          <span className="stats-kicker">SILO · INVENTORY &amp; RESILIENCE</span>
          <h1>Library telemetry</h1>
          <p>One live view of what is connected, indexed, and protected.</p>
        </div>
        <div className="stats-heading-actions">
          <button className="stats-button quiet" onClick={() => void startInventory()} disabled={busy || Boolean(snapshot?.running)}>
            <FiRefreshCw className={snapshot?.running ? "stats-spin" : ""} />
            {snapshot?.running ? "Measuring…" : "Refresh inventory"}
          </button>
          <button className="stats-button" onClick={async () => {
            try {
              const destination = await api.selectShelterDestination();
              if (destination) await loadSnapshot();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}>
            <FiHardDrive /> {snapshot?.shelter.destination ? "Change shelter" : "Set shelter"}
          </button>
        </div>
      </header>

      {error && <div className="stats-inline-error"><FiAlertCircle /> {error}</div>}

      <section className="stats-metric-grid" aria-label="Library totals">
        <article className="stats-metric-card stats-metric-primary">
          <div className="stats-metric-label"><FiDatabase /> UNIQUE LIBRARY SIZE</div>
          <strong>{formatBytes(snapshot?.totals.totalBytes)}</strong>
          <span>{snapshot?.totals.unknownSizeFiles ? `${snapshot.totals.unknownSizeFiles.toLocaleString()} file sizes unavailable · ` : "Known logical bytes · "}deduplicated across nested local roots</span>
        </article>
        <article className="stats-metric-card">
          <div className="stats-metric-label"><FiActivity /> INVENTORIED FILES</div>
          <strong>{snapshot ? snapshot.totals.fileCount.toLocaleString() : "—"}</strong>
          <span>{snapshot ? `${snapshot.totals.uniqueSourceCount} unique roots · ${snapshot.totals.staleSourceCount} stale or unavailable` : "Waiting for source inventory"}</span>
        </article>
        <article className="stats-metric-card">
          <div className="stats-metric-label"><FiActivity /> SEARCH-INDEXED</div>
          <strong>{snapshot ? snapshot.indexedFiles.toLocaleString() : "—"}</strong>
          <span>{snapshot ? `${snapshot.indexingErrors.toLocaleString()} unresolved index errors · semantic search records` : "Waiting for desktop indexing data"}</span>
        </article>
        <article className="stats-metric-card stats-shelter-metric">
          <div className="stats-metric-label"><FiShield /> SHELTER COVERAGE</div>
          <strong>{snapshot ? <>{snapshot.shelter.percentage}<small>%</small></> : "—"}</strong>
          <span>{snapshot ? `${snapshot.shelter.verifiedSources} of ${snapshot.shelter.totalSources} sources have a latest-known inventory match` : "Waiting for shelter verification data"}</span>
        </article>
      </section>

      <section className="stats-live-indexer-card">
        <div className="stats-live-indexer-head">
          <div>
            <span className="stats-kicker">LIVE PIPELINE</span>
            <h2>{currentStage ? currentStage.label : "Indexers standing by"}</h2>
            <p>{currentStage?.message ?? "No indexing stage is currently running."}</p>
          </div>
          <div className="stats-queue-count">{queuedStages.length}<span>queued</span></div>
        </div>
        {currentStage ? <>
          <div className="stats-current-progress-label">
            <span>{currentStage.processed.toLocaleString()} / {currentStage.total > 0 ? currentStage.total.toLocaleString() : "discovering"} {currentStage.unit}</span>
            <strong>{currentStage.total > 0 ? `${currentPercent}%` : "LIVE"}</strong>
          </div>
          <div className="stats-progress-track"><div style={{ width: `${currentStage.total > 0 ? currentPercent : 12}%` }} /></div>
        </> : <div className="stats-progress-track idle"><div /></div>}
        {queuedStages.length > 0 && <div className="stats-queued-list">Queued: {queuedStages.map((stage) => stage.label).join(" · ")}</div>}
      </section>

      <div className="stats-dashboard-grid">
        <section className="stats-card stats-category-card">
          <header className="stats-card-heading">
            <div className="stats-heading-icon"><FiDatabase /></div>
            <div><span className="stats-kicker">INVENTORY MIX</span><h2>Files by category</h2></div>
          </header>
          <div className="stats-category-list">
            {categoryOrder.map((category) => {
              const value = categories[category] ?? { files: 0, bytes: 0 };
              const percent = Math.round((value.files / maxCategoryFiles) * 100);
              return <div className="stats-category-row" key={category}>
                <div className="stats-category-title"><strong>{categoryLabels[category]}</strong><span>{snapshot ? `${value.files.toLocaleString()} files · ${formatBytes(value.bytes)}` : "Awaiting live inventory"}</span></div>
                <div className="stats-category-track"><div style={{ width: `${percent}%` }} /></div>
              </div>;
            })}
          </div>
          <small className="stats-footnote">Sizes are logical file lengths, not allocated disk blocks. Overlapping local roots are counted once in headline totals.</small>
        </section>

        <section className="stats-card stats-shelter-card" data-tour="fallout-shelter">
          <header className="stats-card-heading">
            <div className="stats-heading-icon vault"><FiShield /></div>
            <div><span className="stats-kicker">FALLOUT SHELTER</span><h2>Backup readiness</h2></div>
          </header>
          <p className="stats-shelter-copy">A shelter copy is recorded only after the full clone passes SHA-256 verification. Currency is checked against source path, size, and modification-time inventory signatures.</p>
          <div className="stats-destination-box">
            <FiHardDrive />
            <div><span>PRIMARY DESTINATION</span><strong title={snapshot?.shelter.destination ?? "Not configured"}>{snapshot?.shelter.destination ?? "No shelter folder configured"}</strong></div>
            {!snapshot?.shelter.destination && <button onClick={async () => {
              try {
                const destination = await api.selectShelterDestination();
                if (destination) await loadSnapshot();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            }}>Choose</button>}
          </div>
          <div className="stats-shelter-meter"><div><span>Latest-known verified matches</span><strong>{snapshot ? `${snapshot.shelter.verifiedSources} / ${snapshot.shelter.totalSources}` : "—"}</strong></div><div className="stats-progress-track"><div style={{ width: `${snapshot?.shelter.percentage ?? 0}%` }} /></div></div>
          <button
            className="stats-button small"
            disabled={!snapshot?.shelter.snapshotAvailable}
            title={snapshot?.shelter.snapshotAvailable ? "Verify the latest complete shelter on another physical volume" : "Create and verify the primary shelter first"}
            onClick={() => setShowShelterReplica(true)}
            data-tour="shelter-replica"
          ><FiCopy /> Replicate shelter to another volume</button>
          {(snapshot?.shelter.replicas ?? []).map((replica) => (
            <div className="stats-shelter-replica" key={`${replica.path}:${replica.verifiedAt}`}>
              <FiCheckCircle />
              <span><strong>Verified replica</strong><small title={replica.path}>{replica.path}</small></span>
              <time>{formatDate(replica.verifiedAt)}</time>
            </div>
          ))}
          <small className="stats-footnote">Verification time is shown per source. A changed inventory is flagged; the existing verified copy is never silently treated as a sync.</small>
        </section>
      </div>

      <section className="stats-card stats-sources-card">
        <header className="stats-card-heading stats-source-heading">
          <div className="stats-heading-icon"><FiHardDrive /></div>
          <div><span className="stats-kicker">CONNECTED &amp; ADDED</span><h2>Source map</h2></div>
          <div className="stats-source-actions">
            <button className="stats-text-button" onClick={toggleAll} disabled={availableSources.length === 0}>{selectedIds.size === availableSources.length && availableSources.length ? "Clear selection" : "Select available"}</button>
            <button className="stats-button small" onClick={() => setShowClone(true)} disabled={!selectedSources.length || !snapshot?.shelter.destination} title={!snapshot?.shelter.destination ? "Set a primary shelter folder first" : "Preflight space, then copy and verify"}><FiShield /> Back up selected</button>
          </div>
        </header>
        <div className="stats-source-table-wrap">
          <table className="stats-source-table">
            <thead><tr><th>Source</th><th>Inventory</th><th>Indexed</th><th>Shelter state</th></tr></thead>
            <tbody>
              {(snapshot?.sources ?? []).map((source) => {
                const shelterIcon = source.shelterState === "verified" ? <FiCheckCircle /> : source.shelterState === "offline" ? <FiCloudOff /> : source.shelterState === "changed" ? <FiAlertCircle /> : <FiShield />;
                return <tr key={source.id}>
                  <td className="stats-source-name-cell">
                    <label className="stats-source-select">
                      <input type="checkbox" checked={selectedIds.has(source.id)} disabled={!source.available || !source.rootPath} onChange={() => toggleSource(source.id)} />
                      <span className="stats-source-name"><strong>{source.label}</strong><small>{sourceKindLabel(source.kind)} · {source.rootPath || "No active device path"}</small></span>
                    </label>
                    {source.message && <small className="stats-source-overlap">{source.message}</small>}
                    <span className={`stats-source-connection ${source.available ? "online" : "offline"}`}><i />{source.offlineBackup ? "Offline snapshot available" : source.available ? "Connected / available" : "Unavailable"}</span>
                    {source.offlineBackup && source.snapshotAt && <small className="stats-source-overlap">Phone snapshot from {formatDate(source.snapshotAt)}</small>}
                  </td>
                  <td><strong>{source.fileCount === null ? "—" : source.fileCount.toLocaleString()}</strong><small>{formatBytes(source.totalBytes)} known logical size</small>{Boolean(source.unknownSizeFiles) && <small className="stats-source-overlap">{source.unknownSizeFiles} file sizes unavailable</small>}{source.status === "scanning" && <small className="stats-source-scan">Measuring…</small>}{source.stale && source.status !== "scanning" && <small className="stats-source-overlap">Last measured {source.scannedAt ? formatDate(source.scannedAt) : "not yet"}</small>}{source.error && <small className="stats-source-error">{source.error}</small>}{source.overlapsAnotherSource && <small className="stats-source-overlap">Overlapping root · deduplicated overall</small>}</td>
                  <td><strong>{source.indexedFiles.toLocaleString()}</strong><small>search-indexed files{source.indexingErrors ? ` · ${source.indexingErrors} errors` : ""}</small></td>
                  <td><div className={`stats-shelter-state ${source.shelterState}`}>{shelterIcon}<strong>{shelterLabel(source)}</strong></div>{source.lastVerifiedAt && <small>Verified {formatDate(source.lastVerifiedAt)}</small>}{source.cloneDestination && <small className="stats-destination-path" title={source.cloneDestination}>At {source.cloneDestination}</small>}{source.shelterState === "changed" && <small className="stats-source-error">Back up again to refresh this copy.</small>}</td>
                </tr>;
              })}
              {(snapshot?.sources.length ?? 0) === 0 && <tr><td colSpan={4} className="stats-empty-row">{snapshot ? "No sources have been added yet." : "Waiting for the desktop source registry…"}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="stats-source-foot"><span>{snapshot?.sources.length ?? 0} registered sources</span><span>Inventory as of {formatDate(snapshot?.totals.lastInventoryAt)}</span><button className="stats-text-button" onClick={() => void startInventory()} disabled={busy || Boolean(snapshot?.running)}>Refresh source measurements</button></div>
      </section>

      <section className="stats-indexing-section">
        <div className="stats-section-intro"><span className="stats-kicker">INDEX HEALTH</span><h2>Running &amp; queued work</h2><p>Each stage reports its own units; no misleading blended percentage.</p></div>
        <IndexingPanel onStagesChange={setStages} />
      </section>

      <section className="stats-console-toggle-card">
        <div><div className="stats-heading-icon"><FiTerminal /></div><div><span className="stats-kicker">DIAGNOSTICS</span><h2>Developer console</h2><p>Structured, bounded runtime events with follow-bottom scrolling.</p></div></div>
        <button className="stats-button quiet" onClick={() => setShowConsole((value) => !value)}><FiTerminal /> {showConsole ? "Hide console" : "Open console"}</button>
      </section>
      {showConsole && <RuntimeConsole api={api} />}

      <footer className="stats-page-footnote"><FiActivity /> Inventory is measured on first use, when older than 15 minutes on dashboard open, and on demand. Offline sources retain last-known totals and verification matches but are marked stale; overlapping source rows remain separate while headline totals deduplicate nested local roots.</footer>

      {showClone && snapshot?.shelter.destination && (
        <SourceClonePanel
          electronAPI={api}
          sources={selectedSources.map(({ id, label, kind }) => ({ id, label, kind }))}
          initialDestinations={[snapshot.shelter.destination]}
          onClose={() => {
            setShowClone(false);
            setSelectedIds(new Set());
            void startInventory();
          }}
        />
      )}
      {showShelterReplica && snapshot?.shelter.snapshotAvailable && (
        <SourceClonePanel
          electronAPI={api}
          mode="shelter-replica"
          sources={[{ id: "fallout-shelter", label: "Fallout Shelter", kind: "verified snapshot" }]}
          onClose={() => {
            setShowShelterReplica(false);
            void loadSnapshot();
          }}
        />
      )}
    </main>
  );
}
