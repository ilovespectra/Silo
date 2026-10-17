import React, { useEffect, useRef, useState } from "react";
import { FiArchive, FiCheckCircle, FiCopy, FiHardDrive, FiShield, FiX } from "react-icons/fi";

interface CloneSource {
  id: string;
  label: string;
  kind: string;
}

interface SourceClonePanelProps {
  electronAPI: NonNullable<Window["electron"]>;
  sources: CloneSource[];
  initialDestinations?: string[];
  mode?: "sources" | "shelter-replica";
  onClose: () => void;
}

interface SourceCloneDiagnosticReport {
  format: "silo-fallout-shelter-diagnostic";
  version: 1;
  operationId: string;
  mode: "sources" | "shelter-replica";
  startedAt: string;
  updatedAt: string;
  outcome: string;
  sources: CloneSource[];
  destinations: string[];
  omittedEvents: number;
  events: Array<{ at: string; type: string; details?: unknown }>;
}

function addDiagnosticEvent(report: SourceCloneDiagnosticReport, type: string, details?: unknown) {
  report.updatedAt = new Date().toISOString();
  report.events.push({ at: report.updatedAt, type, ...(details === undefined ? {} : { details }) });
  if (report.events.length > 2000) {
    const removeCount = report.events.length - 1500;
    report.events.splice(0, removeCount);
    report.omittedEvents += removeCount;
  }
}

function describeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(2)} ${units[unit]}`;
}

function countExcludedByKind(excludedPaths: SourceCloneExcludedPath[]) {
  const counts: Partial<Record<SourceCloneExcludedPath["kind"], number>> = {};
  for (const excluded of excludedPaths)
    counts[excluded.kind] = (counts[excluded.kind] ?? 0) + 1;
  return counts;
}

function excludedKindLabel(kind: SourceCloneExcludedPath["kind"]) {
  return ({
    "macos-trash": "macOS Trash",
    "symbolic-link": "symbolic links",
    socket: "sockets",
    fifo: "named pipes",
    device: "device nodes",
    "permission-denied": "permission-restricted paths or folders",
    unsupported: "other unsupported filesystem objects",
  } satisfies Record<SourceCloneExcludedPath["kind"], string>)[kind];
}

export default function SourceClonePanel({ electronAPI, sources, initialDestinations = [], mode = "sources", onClose }: SourceClonePanelProps) {
  const [preparing, setPreparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [plan, setPlan] = useState<SourceClonePreflight | null>(null);
  const [progress, setProgress] = useState<SourceCloneProgress | null>(null);
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [destinations, setDestinations] = useState<string[]>(initialDestinations);
  const [compress, setCompress] = useState(false);
  const [createAppleCompatibleBackup, setCreateAppleCompatibleBackup] = useState(false);
  const [timeMachineMode, setTimeMachineMode] = useState<"instead" | "as-well">("as-well");
  const [timeMachineMessage, setTimeMachineMessage] = useState("");
  const [timeMachineError, setTimeMachineError] = useState("");
  const [extracting, setExtracting] = useState(false);
  const operationIdRef = useRef("");
  const diagnosticRef = useRef<SourceCloneDiagnosticReport | null>(null);
  const [diagnosticsAvailable, setDiagnosticsAvailable] = useState(false);
  const [diagnosticStatus, setDiagnosticStatus] = useState("");
  const busy = preparing || running || extracting;
  const supportsTimeMachine = mode === "sources" && sources.length === 1 && sources[0].kind === "machine";
  const timeMachineOnly = supportsTimeMachine && createAppleCompatibleBackup && timeMachineMode === "instead";

  useEffect(() => {
    return electronAPI.onSourceCloneProgress((state) => {
      if (state.operationId === operationIdRef.current) {
        setProgress(state);
        const report = diagnosticRef.current;
        if (report?.operationId === state.operationId)
          addDiagnosticEvent(report, "progress", state);
      }
    });
  }, [electronAPI]);

  const beginDiagnostics = (operationId: string, selectedDestinations: string[]) => {
    const now = new Date().toISOString();
    const report: SourceCloneDiagnosticReport = {
      format: "silo-fallout-shelter-diagnostic",
      version: 1,
      operationId,
      mode,
      startedAt: now,
      updatedAt: now,
      outcome: "in-progress",
      sources: sources.map((source) => ({ ...source })),
      destinations: [...selectedDestinations],
      omittedEvents: 0,
      events: [],
    };
    addDiagnosticEvent(report, "operation-started", {
      sources: report.sources,
      destinations: report.destinations,
    });
    diagnosticRef.current = report;
    setDiagnosticsAvailable(true);
    setDiagnosticStatus("");
  };

  const downloadDiagnostics = async () => {
    const report = diagnosticRef.current;
    if (!report) return;
    addDiagnosticEvent(report, "diagnostic-export-requested");
    setDiagnosticStatus("");
    try {
      const result = await electronAPI.saveSourceCloneDiagnosticLog(JSON.stringify(report));
      if (result.ok) setDiagnosticStatus(`Saved ${result.fileName || "diagnostic log"}.`);
      else if (result.cancelled) addDiagnosticEvent(report, "diagnostic-export-cancelled");
      else {
        addDiagnosticEvent(report, "diagnostic-export-failed", { message: result.error || "Could not save the diagnostic log." });
        setDiagnosticStatus(result.error || "Could not save the diagnostic log.");
      }
    } catch (cause) {
      addDiagnosticEvent(report, "diagnostic-export-failed", describeError(cause));
      setDiagnosticStatus(cause instanceof Error ? cause.message : "Could not save the diagnostic log.");
    }
  };

  const addDestination = async () => {
    setError("");
    setPreparing(true);
    try {
      const selected = await electronAPI.selectSourceCloneDestination();
      const picked = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (picked.length)
        setDestinations((current) => Array.from(new Set([...current, ...picked])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not choose a destination.");
    } finally { setPreparing(false); }
  };

  const prepare = async () => {
    if (!destinations.length) { setError("Add at least one destination folder."); return; }
    setError(""); setPlan(null); setProgress(null); setAcknowledged(false); setPreparing(true);
    const operationId = `clone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    operationIdRef.current = operationId;
    beginDiagnostics(operationId, destinations);
    try {
      const result = mode === "shelter-replica"
        ? await electronAPI.prepareShelterReplica(destinations, operationId)
        : await electronAPI.prepareSourceClone(
            sources.map((source) => source.id),
            destinations,
            operationId,
          );
      if (!result.ok || !result.plan) {
        const message = result.error || "Could not prepare this clone.";
        const cancelled = message.toLowerCase().includes("cancel");
        const report = diagnosticRef.current;
        if (report?.operationId === operationId) {
          report.outcome = cancelled ? "cancelled" : "preflight-failed";
          addDiagnosticEvent(report, cancelled ? "preflight-cancelled" : "preflight-failed", {
            message,
            ...(result.errorDetails ? { error: result.errorDetails } : {}),
          });
        }
        throw new Error(message);
      }
      setPlan(result.plan);
      const report = diagnosticRef.current;
      if (report?.operationId === operationId) {
        report.outcome = "preflight-ready";
        const excludedPaths = result.plan.excludedPaths ?? [];
        addDiagnosticEvent(report, "preflight-ready", {
          totalSources: result.plan.totalSources,
          totalFiles: result.plan.totalFiles,
          totalBytes: result.plan.totalBytes,
          duplicateFiles: result.plan.duplicateFiles,
          sourceCoverage: excludedPaths.length ? "partial" : "complete",
          excludedItemCount: excludedPaths.length,
          excludedPathCount: excludedPaths.length,
          excludedByKind: countExcludedByKind(excludedPaths),
          excludedPaths: excludedPaths.slice(0, 100),
          excludedPathsOmittedFromLog: Math.max(0, excludedPaths.length - 100),
        });
      }
      setProgress({
        operationId,
        phase: "checking-space",
        destination: result.plan.destinations[0]?.cloneRoot ?? "",
        totalSources: result.plan.totalSources,
        totalFiles: result.plan.totalFiles,
        completedFiles: result.plan.totalFiles,
        totalBytes: result.plan.totalBytes,
        copiedBytes: 0,
        verifiedFiles: 0,
        failedFiles: 0,
        currentFile: "",
        message: "Preflight complete. Review the space estimate before copying.",
      });
    } catch (cause) {
      const report = diagnosticRef.current;
      if (report?.operationId === operationId && report.outcome === "in-progress") {
        report.outcome = "preflight-failed";
        addDiagnosticEvent(report, "preflight-failed", describeError(cause));
      }
      setError(cause instanceof Error ? cause.message : "Could not prepare this clone.");
    } finally {
      setPreparing(false);
    }
  };

  const startClone = async () => {
    if (!plan || plan.destinations.some((destination) => destination.shortfallBytes > 0) || !acknowledged) return;
    setRunning(true);
    setError("");
    const report = diagnosticRef.current;
    if (report) {
      report.outcome = "copy-in-progress";
      addDiagnosticEvent(report, "copy-started", { compress });
    }
    try {
      const result = await electronAPI.startSourceClone(plan.planId, {
        compress,
        createAppleCompatibleBackup: supportsTimeMachine && createAppleCompatibleBackup && timeMachineMode === "as-well",
      });
      if (!result.ok) {
        if (report) {
          report.outcome = "copy-failed";
          addDiagnosticEvent(report, "copy-failed", {
            message: result.error || "Clone did not complete.",
            ...(result.errorDetails ? { error: result.errorDetails } : {}),
          });
        }
        throw new Error(result.error || "Clone did not complete.");
      }
      if (report) {
        report.outcome = plan.excludedPaths?.length ? "complete-with-exclusions" : "complete";
        addDiagnosticEvent(report, "copy-complete", {
          sourceCoverage: plan.excludedPaths?.length ? "partial" : "complete",
          excludedItemCount: plan.excludedPaths?.length ?? 0,
          excludedPathCount: plan.excludedPaths?.length ?? 0,
        });
      }
      if (result.timeMachineStarted)
        setTimeMachineMessage("macOS accepted the Time Machine backup request. Check Time Machine for progress and completion.");
      if (result.timeMachineError) {
        if (report) report.outcome = "clone-complete-time-machine-failed";
        setTimeMachineError(`The Silo clone completed, but Time Machine could not be confirmed: ${result.timeMachineError}`);
        if (report) addDiagnosticEvent(report, "time-machine-request-failed", {
          message: result.timeMachineError,
          ...(result.timeMachineErrorDetails ? { error: result.timeMachineErrorDetails } : {}),
        });
      } else if (result.timeMachineStarted && report) {
        addDiagnosticEvent(report, "time-machine-request-accepted");
      }
    } catch (cause) {
      if (report && report.outcome === "copy-in-progress") {
        report.outcome = "copy-failed";
        addDiagnosticEvent(report, "copy-failed", describeError(cause));
      }
      setError(cause instanceof Error ? cause.message : "Clone did not complete.");
    } finally {
      setRunning(false);
    }
  };

  const startTimeMachineOnly = async () => {
    if (!supportsTimeMachine || !acknowledged || busy) return;
    setRunning(true);
    setError("");
    setTimeMachineMessage("");
    setTimeMachineError("");
    const operationId = `timemachine-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    operationIdRef.current = operationId;
    beginDiagnostics(operationId, destinations);
    const report = diagnosticRef.current;
    if (report) {
      report.outcome = "time-machine-in-progress";
      addDiagnosticEvent(report, "time-machine-request-started", { source: sources[0] });
    }
    try {
      const result = await electronAPI.startMachineTimeMachineBackup(sources[0].id);
      if (!result.ok) {
        if (report) {
          report.outcome = "time-machine-failed";
          addDiagnosticEvent(report, "time-machine-request-failed", {
            message: result.error || "Time Machine did not start.",
            ...(result.errorDetails ? { error: result.errorDetails } : {}),
          });
        }
        throw new Error(result.error || "Time Machine did not start.");
      }
      if (report) {
        report.outcome = "time-machine-requested";
        addDiagnosticEvent(report, "time-machine-request-accepted");
      }
      if (result.timeMachineStarted)
        setTimeMachineMessage("macOS accepted the Time Machine backup request. Check Time Machine for progress and completion.");
    } catch (cause) {
      if (report && report.outcome === "time-machine-in-progress") {
        report.outcome = "time-machine-failed";
        addDiagnosticEvent(report, "time-machine-request-failed", describeError(cause));
      }
      setTimeMachineError(cause instanceof Error ? cause.message : "Time Machine could not be started or confirmed.");
    } finally {
      setRunning(false);
    }
  };

  const cancel = async () => {
    const operationId = operationIdRef.current;
    const report = diagnosticRef.current;
    if (report?.operationId === operationId) {
      report.outcome = "cancel-requested";
      addDiagnosticEvent(report, "cancel-requested");
    }
    if (operationId) await electronAPI.cancelSourceClone(operationId);
    setPreparing(false);
    setRunning(false);
  };

  const extractArchive = async () => {
    setError(""); setProgress(null); setExtracting(true);
    const operationId = `extract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    operationIdRef.current = operationId;
    beginDiagnostics(operationId, destinations);
    addDiagnosticEvent(diagnosticRef.current!, "archive-extraction-started");
    try {
      const result = await electronAPI.extractSourceCloneArchive(operationId);
      if (!result.ok && !result.cancelled) {
        const report = diagnosticRef.current;
        if (report) {
          report.outcome = "extraction-failed";
          addDiagnosticEvent(report, "archive-extraction-failed", {
            message: result.error || "The archive could not be extracted.",
            ...(result.errorDetails ? { error: result.errorDetails } : {}),
          });
        }
        throw new Error(result.error || "The archive could not be extracted.");
      }
      if (diagnosticRef.current) {
        diagnosticRef.current.outcome = result.cancelled ? "extraction-cancelled" : "complete";
        addDiagnosticEvent(diagnosticRef.current, result.cancelled ? "archive-extraction-cancelled" : "archive-extraction-complete");
      }
    } catch (cause) {
      const report = diagnosticRef.current;
      if (report && report.outcome === "in-progress") {
        report.outcome = "extraction-failed";
        addDiagnosticEvent(report, "archive-extraction-failed", describeError(cause));
      }
      setError(cause instanceof Error ? cause.message : "The archive could not be extracted.");
    } finally {
      setExtracting(false);
    }
  };

  const hasShortfall = Boolean(plan?.destinations.some((destination) => destination.shortfallBytes > 0));
  const excludedPaths = plan?.excludedPaths ?? [];
  const excludedByKind = countExcludedByKind(excludedPaths);
  const exclusionSummary = Object.entries(excludedByKind)
    .map(([kind, count]) => `${count} ${excludedKindLabel(kind as SourceCloneExcludedPath["kind"])}`)
    .join(", ");
  const progressValue = progress?.phase === "copying"
    ? progress.copiedBytes
    : progress?.phase === "verifying"
      ? progress.verifiedFiles
      : progress?.phase === "complete"
        ? 1
        : 0;
  const progressMax = progress?.phase === "copying"
    ? Math.max(progress.totalBytes, 1)
    : progress?.phase === "verifying"
      ? Math.max(progress.totalFiles, 1)
      : 1;

  return (
    <div className="source-clone-backdrop" role="presentation" onMouseDown={(event) => {
      if (!busy && event.target === event.currentTarget) onClose();
    }}>
      <section className="source-clone-panel" role="dialog" aria-modal="true" aria-labelledby="source-clone-title">
        <header>
          <div className="source-clone-icon"><FiCopy /></div>
          <div>
            <span className="sidebar-kicker">{mode === "shelter-replica" ? "VERIFIED FALLOUT SHELTER REPLICA" : "FALLOUT SHELTER · SOURCE COPY"}</span>
            <h2 id="source-clone-title">{mode === "shelter-replica" ? "Clone Fallout Shelter" : "Create Fallout Shelter"}</h2>
          </div>
          {!busy && <button className="source-clone-close" onClick={onClose} aria-label="Close"><FiX /></button>}
        </header>

        <div className="source-clone-sources">
          <strong>{sources.length} selected source{sources.length === 1 ? "" : "s"}</strong>
          <span>{sources.map((source) => `${source.label} · ${source.kind}`).join("  /  ")}</span>
        </div>

        <div className="source-clone-safety">
          <FiShield />
          <p><strong>Verified backup copy only.</strong> {mode === "shelter-replica"
            ? "Silo copies the latest completed Fallout Shelter snapshot to a different physical volume and verifies each unique file by SHA-256."
            : "Fallout Shelter writes a separate destination copy, then verifies matching SHA-256 hashes. Original files are not modified or removed."}</p>
        </div>

        {supportsTimeMachine && !plan && (
          <div className="source-clone-time-machine-choice">
            <label className="source-clone-acknowledge">
              <input
                type="checkbox"
                checked={createAppleCompatibleBackup}
                disabled={busy}
                onChange={(event) => {
                  setCreateAppleCompatibleBackup(event.target.checked);
                  if (event.target.checked) setCompress(false);
                  setAcknowledged(false);
                  setTimeMachineMessage("");
                  setTimeMachineError("");
                }}
              />
              <span><strong>Create Apple Compatible Backup File for Device Restoration.</strong> Uses macOS’s currently configured Time Machine destination and inclusion settings. Silo does not choose a destination folder or change those settings. This is not a bootable system image or a guaranteed full-migration copy; macOS Recovery or Migration Assistant may be needed.</span>
            </label>
            {createAppleCompatibleBackup && (
              <div role="radiogroup" aria-label="Time Machine backup mode">
                <label className="source-clone-acknowledge">
                  <input type="radio" name="time-machine-mode" checked={timeMachineMode === "instead"} disabled={busy}
                    onChange={() => { setTimeMachineMode("instead"); setAcknowledged(false); setTimeMachineMessage(""); setTimeMachineError(""); }} />
                  <span><strong>Instead</strong> — run Time Machine only; do not make a Silo clone.</span>
                </label>
                <label className="source-clone-acknowledge">
                  <input type="radio" name="time-machine-mode" checked={timeMachineMode === "as-well"} disabled={busy}
                    onChange={() => { setTimeMachineMode("as-well"); setCompress(false); setAcknowledged(false); setTimeMachineMessage(""); setTimeMachineError(""); }} />
                  <span><strong>As Well</strong> — make and verify the human-readable Silo clone in the selected folder, then request Time Machine separately.</span>
                </label>
              </div>
            )}
          </div>
        )}

        {!plan && (
          <div className="source-clone-prepare">
            {!timeMachineOnly && destinations.map((destination) => <div className="source-clone-destination" key={destination}>
              <strong title={destination}>{destination}</strong>
              <button disabled={preparing} onClick={() => setDestinations((current) => current.filter((item) => item !== destination))} aria-label={`Remove destination ${destination}`}>Remove</button>
            </div>)}
            {(extracting || (progress && operationIdRef.current.startsWith("extract-"))) ? (
              <div className="source-clone-preparing">
                {progress && (
                  <div className={`source-clone-progress ${progress.phase}`}>
                    <div className="source-clone-progress-label">
                      <span>{progress.message}</span>
                      {progress.phase === "copying" && <strong>{`${progress.completedFiles.toLocaleString()} / ${progress.totalFiles.toLocaleString()} files`}</strong>}
                    </div>
                    {progress.phase === "copying" ? <progress value={progress.copiedBytes} max={Math.max(progress.totalBytes, 1)} />
                      : progress.phase === "scanning" ? <progress /> : null}
                  </div>
                )}
                {progress?.phase === "complete" && <div className="source-clone-success"><FiCheckCircle /> {progress.message}</div>}
                <div className="source-clone-actions">
                  {extracting
                    ? <button className="source-clone-cancel" onClick={() => void cancel()}>Cancel extraction</button>
                    : <button onClick={() => { operationIdRef.current = ""; setProgress(null); }}>Back</button>}
                </div>
              </div>
            ) : progress?.phase === "scanning" || progress?.phase === "checking-space" || preparing ? (
              <div className="source-clone-preparing">
                <div className="source-clone-progress">
                  <div><span>{progress?.message || "Choose a destination to begin…"}</span></div>
                  <progress />
                </div>
                {preparing && <button className="source-clone-cancel" onClick={() => void cancel()}>Cancel scan</button>}
              </div>
            ) : timeMachineOnly ? (
              <>
                <label className="source-clone-acknowledge">
                  <input type="checkbox" checked={acknowledged} disabled={busy}
                    onChange={(event) => setAcknowledged(event.target.checked)} />
                  <span>I understand this starts macOS Time Machine using its current destination and settings, without creating a Silo clone.</span>
                </label>
                {timeMachineMessage && <div className="source-clone-success"><FiCheckCircle /> {timeMachineMessage}</div>}
                {timeMachineError && <div className="source-clone-warning insufficient">{timeMachineError}</div>}
                <div className="source-clone-actions">
                  {timeMachineMessage
                    ? <button className="source-clone-primary" onClick={onClose}>Done</button>
                    : <button className="source-clone-primary" onClick={() => void startTimeMachineOnly()} disabled={!acknowledged || busy}>Start Time Machine backup</button>}
                </div>
              </>
            ) : (
              <div className="source-clone-actions">
                <button onClick={() => void addDestination()}><FiHardDrive /> Add destination</button>
                <button onClick={() => void extractArchive()} data-help="Restore a compressed Silo clone (.zip). Every file is checked against its SHA-256 before it is written into a new folder."><FiArchive /> Extract a .zip clone…</button>
                <button className="source-clone-primary" onClick={() => void prepare()} disabled={sources.length === 0 || destinations.length === 0} title="Scan sources and check destination space">{mode === "shelter-replica" ? "Scan Fallout Shelter & check space" : "Scan sources & check space"}</button>
              </div>
            )}
          </div>
        )}

        {plan && (
          <div className="source-clone-plan">
            {plan.destinations.map((destination) => <div className="source-clone-destination" key={destination.cloneRoot}>
              <span>{compress ? "Destination archive" : "Destination copy"}</span><strong title={compress ? `${destination.cloneRoot}.zip` : destination.cloneRoot}>{compress ? `${destination.cloneRoot}.zip` : destination.cloneRoot}</strong>
            </div>)}
            <div className="source-clone-estimates">
              <div><span>Unique files stored</span><strong>{plan.totalFiles.toLocaleString()}</strong></div>
              <div><span>Space per destination</span><strong>{formatBytes(plan.totalBytes)}</strong></div>
              <div><span>Destinations</span><strong>{plan.destinations.length}</strong></div>
            </div>
            <small className="source-clone-preflight-note">{plan.duplicateFiles.toLocaleString()} duplicate paths will reuse canonical content; no duplicate file bytes are copied.</small>
            {excludedPaths.length > 0 && (
              <div className="source-clone-warning">
                <strong>{excludedPaths.length.toLocaleString()} source {excludedPaths.length === 1 ? "path or subtree will" : "paths or subtrees will"} be omitted from this backup.</strong>
                <p>Fallout Shelter copies readable regular files and folders. It skips symbolic links, sockets, named pipes, device nodes, macOS Trash, and paths the operating system denies Silo permission to inspect or read. A denied folder may contain additional files that cannot be inventoried, so this is a partial copy.</p>
                <small>{exclusionSummary}</small>
                <details>
                  <summary>Review omitted paths (first 100)</summary>
                  {excludedPaths.slice(0, 100).map((excluded) => (
                    <div key={`${excluded.sourceLabel}-${excluded.kind}-${excluded.path}`}>
                      {excluded.reason}{excluded.errorCode ? ` (${excluded.errorCode})` : ""} Source: {excluded.sourceLabel} · <code>{excluded.path}</code>
                    </div>
                  ))}
                  {excludedPaths.length > 100 && <small>The downloadable diagnostic log includes the first 100 paths; the backup manifest records the complete omission list.</small>}
                </details>
              </div>
            )}
            {plan.destinations.map((destination) => <div className={`source-clone-warning ${destination.shortfallBytes > 0 ? "insufficient" : ""}`} key={`${destination.destination}-space`}>
              {destination.destination}: {destination.shortfallBytes > 0 ? <>short by <strong>{formatBytes(destination.shortfallBytes)}</strong></> : <>free space {formatBytes(destination.freeBytes)} is sufficient</>}
            </div>)}
            <label className="source-clone-acknowledge source-clone-compress">
              <input type="checkbox" checked={compress} disabled={busy || progress?.phase === "complete" || (createAppleCompatibleBackup && timeMachineMode === "as-well")}
                onChange={(event) => setCompress(event.target.checked)} />
              <span><strong>Compress</strong> into a single .zip archive for easier storage. Photos, video and other already-compressed media are stored as-is; documents and text are deflated. The archive is re-read and SHA-256 verified before it is kept, and can be restored with “Extract a .zip clone…”. Compression is disabled for “As Well” so the Silo copy remains directly browseable.</span>
            </label>
            {mode === "sources" && sources.length === 1 && sources[0].kind === "machine" && (
              createAppleCompatibleBackup && timeMachineMode === "as-well" && (
                <small className="source-clone-preflight-note">Time Machine starts only after this Silo clone finishes SHA-256 verification. macOS Recovery or Migration Assistant may be needed to set up a replacement Mac.</small>
              )
            )}
            <label className="source-clone-acknowledge">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>
                {createAppleCompatibleBackup && timeMachineMode === "as-well"
                  ? "I understand this makes a separate readable Silo copy in the selected folder and also requests a separate Time Machine backup at macOS’s configured destination; originals and settings are not changed."
                  : "I understand this makes a separate copy and does not alter the originals."}
                {excludedPaths.length
                  ? ` I understand ${excludedPaths.length.toLocaleString()} source ${excludedPaths.length === 1 ? "path or subtree" : "paths or subtrees"} identified by preflight will be omitted. The resulting clone contains a verified copy of supported items, not a complete source mirror.`
                  : ""}
              </span>
            </label>
            {running && progress && (
              <div className={`source-clone-progress ${progress.phase}`}>
                <div className="source-clone-progress-label">
                  <span>{progress.message}</span>
                  <strong>{progress.phase === "verifying"
                    ? `${progress.verifiedFiles.toLocaleString()} / ${progress.totalFiles.toLocaleString()} verified`
                    : `${formatBytes(progress.copiedBytes)} / ${formatBytes(progress.totalBytes)}`}</strong>
                </div>
                <progress value={progressValue} max={progressMax} />
                <small>{progress.completedFiles.toLocaleString()} copied · {progress.verifiedFiles.toLocaleString()} verified · {progress.failedFiles.toLocaleString()} errors{progress.currentFile ? ` · ${progress.currentFile}` : ""}</small>
              </div>
            )}
            {!running && progress?.phase === "complete" && (
              <div className={excludedPaths.length ? "source-clone-warning" : "source-clone-success"}>
                {!excludedPaths.length && <FiCheckCircle />} {progress.message}
              </div>
            )}
            {timeMachineMessage && <div className="source-clone-success">{timeMachineMessage}</div>}
            {timeMachineError && <div className="source-clone-warning insufficient">{timeMachineError}</div>}
            {!running && progress && ["error", "cancelled"].includes(progress.phase) && (
              <div className="source-clone-warning insufficient">{progress.message}</div>
            )}
            <div className="source-clone-actions">
              <button onClick={() => { setPlan(null); setDestinations([]); }} disabled={busy}>Change destinations</button>
              {running ? (
                <button className="source-clone-cancel" onClick={() => void cancel()}>Cancel copy</button>
              ) : progress?.phase === "complete" ? (
                <button className="source-clone-primary" onClick={onClose}>Done</button>
              ) : (
                <button className="source-clone-primary" onClick={() => void startClone()} disabled={!acknowledged || hasShortfall} title="Create and verify a separate copy; leave source unchanged">
                  {createAppleCompatibleBackup && timeMachineMode === "as-well"
                    ? <><FiCopy /> Clone, verify &amp; start Time Machine</>
                    : compress ? <><FiArchive /> Compress &amp; verify</> : <><FiCopy /> Clone &amp; verify</>}
                </button>
              )}
            </div>
          </div>
        )}

        {error && <div className="source-clone-error">{error}</div>}
        {preparing && !plan && progress && <small className="source-clone-preflight-note">{progress.message}</small>}
        {diagnosticsAvailable && (
          <div className="source-clone-diagnostics">
            <div>
              <strong>Diagnostic log</strong>
              <small>Includes source and destination paths, filenames, progress, and operating-system errors. Review it before sharing.</small>
            </div>
            <div className="source-clone-diagnostic-actions">
              <button onClick={() => void downloadDiagnostics()} disabled={busy}>Download diagnostic log</button>
              {diagnosticStatus && <small role="status">{diagnosticStatus}</small>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
