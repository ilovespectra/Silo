import React, { useEffect, useRef, useState } from "react";
import { FiArchive, FiCheckCircle, FiClock, FiCopy, FiDownload, FiHardDrive, FiRefreshCw, FiShield, FiX } from "react-icons/fi";

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
  historyOnly?: boolean;
  activeOperationId?: string;
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

function sourceProgressPhaseLabel(phase: SourceCloneSourceProgress["phase"]) {
  return ({
    waiting: "Waiting",
    scanning: "Scanning",
    checking: "Checking files",
    copying: "Copying",
    verifying: "Verifying",
    complete: "Complete",
    cancelled: "Stopped",
    error: "Error",
  } satisfies Record<SourceCloneSourceProgress["phase"], string>)[phase];
}

function sourceProgressMeter(source: SourceCloneSourceProgress, operationPhase: SourceCloneProgress["phase"]) {
  if (source.phase === "complete") return { value: 1, max: 1 };
  if (source.phase === "scanning") return null;
  if (operationPhase === "checking-space" || source.phase === "checking") {
    const totalBytes = source.totalBytes ?? 0;
    if (totalBytes > 0)
      return { value: Math.min(source.checkedBytes ?? 0, totalBytes), max: totalBytes };
    const total = source.discoveredFiles ?? 0;
    return total > 0 ? { value: Math.min(source.checkedFiles ?? 0, total), max: total } : null;
  }
  if (source.phase === "verifying") {
    const total = source.totalFiles ?? 0;
    return total > 0 ? { value: Math.min(source.verifiedFiles, total), max: total } : null;
  }
  const total = source.totalFiles ?? 0;
  return total > 0 ? { value: Math.min(source.completedFiles, total), max: total } : null;
}

function SourceProgressRows({
  sources,
  operationPhase,
}: {
  sources: SourceCloneSourceProgress[];
  operationPhase: SourceCloneProgress["phase"];
}) {
  if (!sources.length) return null;
  return (
    <div className="source-clone-source-progress" aria-label="Progress by source">
      {sources.map((source, index) => {
        const meter = sourceProgressMeter(source, operationPhase);
        const processed = operationPhase === "checking-space" || source.phase === "checking"
          ? `${(source.checkedFiles ?? 0).toLocaleString()} / ${source.discoveredFiles.toLocaleString()} paths checked · ${formatBytes(source.checkedBytes ?? 0)} / ${formatBytes(source.totalBytes ?? 0)} hashed`
          : source.phase === "verifying"
            ? `${source.verifiedFiles.toLocaleString()} / ${(source.totalFiles ?? 0).toLocaleString()} verified`
            : `${source.completedFiles.toLocaleString()} / ${(source.totalFiles ?? 0).toLocaleString()} files copied`;
        const omitted = `${(source.omittedFiles ?? 0).toLocaleString()} files · ${(source.omittedSubtrees ?? 0).toLocaleString()} folders/subtrees omitted`;
        return (
          <div className={`source-clone-source-progress-row ${source.phase}`} key={`${source.sourceId}:${index}`}>
            <div className="source-clone-source-progress-heading">
              <strong title={source.label}>{source.label}</strong>
              <span>{sourceProgressPhaseLabel(source.phase)}</span>
            </div>
            {meter
              ? <progress value={meter.value} max={meter.max} aria-label={`${source.label}: ${sourceProgressPhaseLabel(source.phase)}`} />
              : <progress aria-label={`${source.label}: ${sourceProgressPhaseLabel(source.phase)}`} />}
            <small>{source.discoveredFiles.toLocaleString()} found · {processed} · {omitted} · {source.omittedPaths.toLocaleString()} omission entries</small>
          </div>
        );
      })}
    </div>
  );
}

function sourceCloneSessionOutcomeLabel(outcome: SourceCloneSessionOutcome) {
  return ({
    "in-progress": "In progress",
    "awaiting-confirmation": "Preflight ready",
    complete: "Complete",
    "complete-with-omissions": "Complete with omissions",
    "complete-with-errors": "Complete with errors",
    error: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    "time-machine-requesting": "Requesting Time Machine",
    "time-machine-requested": "Time Machine request accepted",
    "time-machine-failed": "Time Machine request failed",
  } satisfies Record<SourceCloneSessionOutcome, string>)[outcome];
}

function sourceCloneSessionModeLabel(mode: SourceCloneSessionMode) {
  return ({
    sources: "Source copy",
    "shelter-replica": "Fallout Shelter replica",
    "archive-extraction": "Archive extraction",
    "time-machine-only": "Time Machine only",
    verification: "Verify selected backups",
  } satisfies Record<SourceCloneSessionMode, string>)[mode];
}

function sourceCloneSessionEventLabel(event: string) {
  return ({
    "operation-started": "Session started",
    "preflight-ready": "Preflight completed; awaiting confirmation",
    "progress-checkpoint": "Progress saved",
    "operation-complete": "Copy and verification completed",
    "operation-error": "Operation failed",
    "operation-cancelled": "Operation cancelled",
    "clone-complete": "Clone completed",
    "clone-failed": "Clone failed",
    "time-machine-request-started": "Time Machine request started",
    "time-machine-request-accepted": "macOS accepted the Time Machine request",
    "time-machine-request-failed": "Time Machine request failed",
    "previous-session-interrupted": "Silo restarted before this session finished",
    "verification-source-verified": "Selected source matched its shelter copy",
    "verification-source-mismatch": "Selected source did not match its shelter copy",
    "verification-source-missing": "No complete shelter copy was found",
    "verification-source-error": "Selected source could not be verified",
    "verification-complete": "Selected backups verified",
    "verification-completed-with-errors": "Verification finished with issues",
    "verification-failed": "Verification operation failed",
    "preflight-dismissed": "Preflight closed before cloning",
    "preflight-closed-with-app": "Silo closed before cloning began",
  } as Record<string, string>)[event] ?? event.replace(/-/g, " ");
}

function sourceCloneSessionProgressLine(progress: SourceCloneSessionProgressSnapshot) {
  const parts = [progress.phase.replace(/-/g, " ")];
  if (progress.totalFiles > 0)
    parts.push(`${progress.completedFiles.toLocaleString()} / ${progress.totalFiles.toLocaleString()} files`);
  if (progress.totalBytes > 0)
    parts.push(`${formatBytes(progress.copiedBytes)} / ${formatBytes(progress.totalBytes)}`);
  if (progress.verifiedFiles > 0)
    parts.push(`${progress.verifiedFiles.toLocaleString()} verified`);
  if (progress.omittedPaths)
    parts.push(`${progress.omittedPaths.toLocaleString()} omitted`);
  if (progress.failedFiles > 0)
    parts.push(`${progress.failedFiles.toLocaleString()} errors`);
  return parts.join(" · ");
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
    "node-modules": "reproducible node_modules folders",
    "missing-virtual-folder-file": "unavailable virtual-folder files",
    "silo-data-managed": "Silo data managed in its own backup area",
    "nested-shelter": "nested Fallout Shelter copies",
  } satisfies Record<SourceCloneExcludedPath["kind"], string>)[kind];
}

export default function SourceClonePanel({ electronAPI, sources, initialDestinations = [], mode = "sources", historyOnly = false, activeOperationId, onClose }: SourceClonePanelProps) {
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
  const operationIdRef = useRef(activeOperationId ?? "");
  const diagnosticRef = useRef<SourceCloneDiagnosticReport | null>(null);
  const [diagnosticsAvailable, setDiagnosticsAvailable] = useState(false);
  const [diagnosticStatus, setDiagnosticStatus] = useState("");
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(historyOnly);
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  const [sessionLogs, setSessionLogs] = useState<SourceCloneSessionLog[]>([]);
  const [sessionLogWarning, setSessionLogWarning] = useState("");
  const [selectedSessionLogId, setSelectedSessionLogId] = useState("");
  const [sessionLogStatus, setSessionLogStatus] = useState("");
  const [downloadingSessionLog, setDownloadingSessionLog] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const busy = preparing || running || extracting;
  const supportsTimeMachine = mode === "sources" && sources.length === 1 && sources[0].kind === "machine";
  const timeMachineOnly = supportsTimeMachine && createAppleCompatibleBackup && timeMachineMode === "instead";
  const sourceIdentity = sources.map((source) => source.id).sort().join("\0");

  useEffect(() => {
    if (historyOnly) return;
    if (activeOperationId) operationIdRef.current = activeOperationId;
    let mounted = true;
    const liveProgressIds = new Set<string>();
    const attach = (state: SourceCloneProgress) => {
      if (!mounted) return;
      operationIdRef.current = state.operationId;
      setProgress(state);
      const activePhase = state.phase === "scanning" || state.phase === "checking-space" ||
        state.phase === "copying" || state.phase === "verifying";
      setPreparing(activePhase && (state.phase === "scanning" || state.phase === "checking-space"));
      setRunning(activePhase && (state.phase === "copying" || state.phase === "verifying"));
      setExtracting(activePhase && state.mode === "archive-extraction");
      setCancelPending(state.cancelRequested === true);
    };
    const unsubscribe = electronAPI.onSourceCloneProgress((state) => {
      if (state.operationId === operationIdRef.current) {
        liveProgressIds.add(state.operationId);
        attach(state);
        const report = diagnosticRef.current;
        if (report?.operationId === state.operationId)
          addDiagnosticEvent(report, "progress", state);
      }
    });
    const expectedMode = mode === "shelter-replica" ? "shelter-replica" : "sources";
    const expectedSourceIds = sourceIdentity ? sourceIdentity.split("\0") : [];
    void electronAPI.getActiveSourceCloneProgress().then((active) => {
      if (!mounted || !Array.isArray(active)) return;
      const matching = active.filter((state) => {
        if (activeOperationId) return state.operationId === activeOperationId;
        if (state.mode === "archive-extraction") return mode === "sources";
        if (state.mode !== expectedMode) return false;
        return mode === "shelter-replica" || expectedSourceIds.every((sourceId) =>
          state.sourceProgress?.some((candidate) => candidate.sourceId === sourceId),
        );
      });
      // Never guess when more than one active job could match this panel.
      if (matching.length === 1 &&
          (!operationIdRef.current || matching[0].operationId === operationIdRef.current) &&
          !liveProgressIds.has(matching[0].operationId)) attach(matching[0]);
    }).catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [activeOperationId, electronAPI, historyOnly, mode, sourceIdentity]);

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

  const loadPreviousSessionLogs = async () => {
    setSessionHistoryLoading(true);
    setSessionLogStatus("");
    try {
      const result = await electronAPI.getSourceCloneSessionLogs();
      const sessions = Array.isArray(result.sessions) ? result.sessions : [];
      setSessionLogs(sessions);
      setSessionLogWarning(result.warning || "");
      setSelectedSessionLogId((current) => sessions.some((session) => session.id === current)
        ? current : sessions[0]?.id ?? "");
    } catch (cause) {
      setSessionLogWarning(cause instanceof Error ? cause.message : "Saved session logs could not be loaded.");
    } finally {
      setSessionHistoryLoading(false);
    }
  };

  const toggleSessionHistory = () => {
    const open = !sessionHistoryOpen;
    setSessionHistoryOpen(open);
    if (open) void loadPreviousSessionLogs();
  };

  const downloadSavedSessionLog = async (id: string) => {
    setDownloadingSessionLog(true);
    setSessionLogStatus("");
    try {
      const result = await electronAPI.downloadSourceCloneSessionLog(id);
      if (result.ok) setSessionLogStatus(`Saved ${result.fileName || "session log"}.`);
      else if (!result.cancelled) setSessionLogStatus(result.error || "Could not save the session log.");
    } catch (cause) {
      setSessionLogStatus(cause instanceof Error ? cause.message : "Could not save the session log.");
    } finally {
      setDownloadingSessionLog(false);
    }
  };

  const closePanel = () => {
    if (operationIdRef.current)
      void electronAPI.dismissSourceCloneSession(operationIdRef.current);
    onClose();
  };

  useEffect(() => {
    if (historyOnly) void loadPreviousSessionLogs();
  }, [historyOnly, electronAPI]);

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
    setError(""); setPlan(null); setProgress(null); setAcknowledged(false); setCancelPending(false); setPreparing(true);
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
        sourceProgress: result.plan.sourceProgress,
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
      const message = cause instanceof Error ? cause.message : "Could not prepare this clone.";
      if (!message.toLowerCase().includes("cancel")) setError(message);
    } finally {
      setPreparing(false);
    }
  };

  const startClone = async () => {
    if (!plan || plan.destinations.some((destination) => destination.shortfallBytes > 0) || !acknowledged) return;
    setCancelPending(false);
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
      if (result.cancelled) {
        if (report) {
          report.outcome = "copy-cancelled";
          addDiagnosticEvent(report, "copy-cancelled");
        }
        return;
      }
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
    if (!operationId) return;
    setCancelPending(true);
    try {
      const accepted = await electronAPI.cancelSourceClone(operationId);
      if (!accepted) {
        setCancelPending(false);
        setError("Silo no longer has an active operation to stop. Check the latest progress state.");
      }
    } catch (cause) {
      setCancelPending(false);
      setError(cause instanceof Error ? cause.message : "Silo could not request cancellation.");
    }
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
      if (!busy && event.target === event.currentTarget) closePanel();
    }}>
      <section className={`source-clone-panel${historyOnly ? " history-only" : ""}`} role="dialog" aria-modal="true" aria-labelledby="source-clone-title">
        <header>
          <div className="source-clone-icon">{historyOnly ? <FiClock /> : <FiCopy />}</div>
          <div>
            <span className="sidebar-kicker">{historyOnly ? "FALLOUT SHELTER · SESSION HISTORY" : mode === "shelter-replica" ? "VERIFIED FALLOUT SHELTER REPLICA" : "FALLOUT SHELTER · SOURCE COPY"}</span>
            <h2 id="source-clone-title">{historyOnly ? "Previous session logs" : mode === "shelter-replica" ? "Clone Fallout Shelter" : "Create Fallout Shelter"}</h2>
          </div>
          {!busy && <button className="source-clone-close" onClick={closePanel} aria-label="Close"><FiX /></button>}
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

        <section className="source-clone-session-history">
          <button className="source-clone-session-toggle" onClick={toggleSessionHistory} aria-expanded={sessionHistoryOpen}>
            <FiClock /> {sessionHistoryOpen ? "Hide previous session logs" : "View previous session logs"}
          </button>
          {sessionHistoryOpen && (
            <div className="source-clone-session-content">
              <p className="source-clone-session-privacy">Saved automatically in Silo’s local app data. Progress is checkpointed about once a second, and unfinished sessions are marked interrupted after a restart. Open or refresh this panel to see any storage warning. Logs contain session times, system/app version, phases, counts and error codes. They exclude source names, file and folder paths, file contents and screenshots. Silo keeps up to 30 sessions.</p>
              <button className="source-clone-session-refresh" onClick={() => void loadPreviousSessionLogs()} disabled={sessionHistoryLoading}>
                <FiRefreshCw className={sessionHistoryLoading ? "stats-spin" : ""} /> Refresh logs
              </button>
              {sessionLogWarning && <div className="source-clone-warning insufficient">{sessionLogWarning}</div>}
              {sessionHistoryLoading && <small>Loading saved sessions…</small>}
              {!sessionHistoryLoading && !sessionLogs.length && !sessionLogWarning && <small>No saved Fallout Shelter sessions yet.</small>}
              {sessionLogs.length > 0 && (
                <div className="source-clone-session-list" aria-label="Saved Fallout Shelter sessions">
                  {sessionLogs.map((session) => (
                    <button className={`source-clone-session-item ${selectedSessionLogId === session.id ? "selected" : ""}`} key={session.id}
                      onClick={() => { setSelectedSessionLogId(session.id); setSessionLogStatus(""); }}>
                      <strong>{sourceCloneSessionOutcomeLabel(session.outcome)}</strong>
                      <span>{new Date(session.startedAt).toLocaleString()} · {sourceCloneSessionModeLabel(session.mode)}</span>
                      {session.latestProgress && <small>{sourceCloneSessionProgressLine(session.latestProgress)}</small>}
                    </button>
                  ))}
                </div>
              )}
              {sessionLogs.find((session) => session.id === selectedSessionLogId) && (() => {
                const session = sessionLogs.find((item) => item.id === selectedSessionLogId)!;
                return (
                  <div className="source-clone-session-detail">
                    <div className="source-clone-session-meta">Silo {session.appVersion} · {session.platform} {session.architecture} · OS {session.osRelease}<br />{session.sourceCount} source{session.sourceCount === 1 ? "" : "s"} · {session.destinationCount} destination{session.destinationCount === 1 ? "" : "s"}{session.options.compress ? " · compressed" : ""}{session.options.timeMachineRequested ? " · Time Machine selected" : ""}</div>
                    <div className="source-clone-session-events">
                      {session.events.map((event, index) => (
                        <div className="source-clone-session-event" key={`${session.id}-${event.at}-${index}`}>
                          <time>{new Date(event.at).toLocaleTimeString()}</time>
                          <span><strong>{sourceCloneSessionEventLabel(event.event)}</strong>
                            {(event.phase || event.totalFiles !== undefined || event.omittedPaths !== undefined) && <small>{event.phase ? event.phase.replace(/-/g, " ") : ""}{event.totalFiles !== undefined ? ` · ${event.completedFiles ?? 0} / ${event.totalFiles} files` : ""}{event.omittedPaths ? ` · ${event.omittedPaths} omitted` : ""}{event.failedFiles ? ` · ${event.failedFiles} errors` : ""}{event.code ? ` · ${event.code}` : ""}</small>}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="source-clone-diagnostic-actions">
                      <button onClick={() => void downloadSavedSessionLog(session.id)} disabled={downloadingSessionLog}><FiDownload /> {downloadingSessionLog ? "Saving…" : "Download this log"}</button>
                      {sessionLogStatus && <small role="status">{sessionLogStatus}</small>}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </section>

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
                    ? <button className="source-clone-cancel" onClick={() => void cancel()} disabled={cancelPending}>{cancelPending ? "Stopping…" : "Cancel extraction"}</button>
                    : <button onClick={() => { operationIdRef.current = ""; setProgress(null); }}>Back</button>}
              </div>
            </div>
            ) : running && progress ? (
              <div className="source-clone-preparing">
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
                <SourceProgressRows sources={progress.sourceProgress ?? []} operationPhase={progress.phase} />
                <button className="source-clone-cancel" onClick={() => void cancel()} disabled={cancelPending}>{cancelPending ? "Stopping…" : "Cancel copy"}</button>
              </div>
            ) : progress?.phase === "scanning" || progress?.phase === "checking-space" || preparing ? (
              <div className="source-clone-preparing">
                <div className="source-clone-progress">
                  <div><span>{progress?.message || "Choose a destination to begin…"}</span></div>
                  <progress />
                  {progress && (progress.discoveredFiles !== undefined || progress.omittedPaths !== undefined) && (
                    <div className="source-clone-scan-counts" aria-live="polite">
                      <div><span>Files found</span><strong>{(progress.discoveredFiles ?? 0).toLocaleString()}</strong></div>
                      <div><span>Paths omitted</span><strong>{(progress.omittedPaths ?? 0).toLocaleString()}</strong></div>
                    </div>
                  )}
                  <small className="source-clone-scan-note">Omitted paths include unsupported items and files or folders Silo cannot read; they are left out of the clone.</small>
                  {progress?.currentFile && <small className="source-clone-scan-current">Current path: {progress.currentFile}</small>}
                </div>
                <SourceProgressRows sources={progress?.sourceProgress ?? []} operationPhase={progress?.phase ?? "scanning"} />
                {preparing && <button className="source-clone-cancel" onClick={() => void cancel()} disabled={cancelPending}>{cancelPending ? "Stopping…" : "Cancel scan"}</button>}
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
                    ? <button className="source-clone-primary" onClick={closePanel}>Done</button>
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
                  {excludedPaths.slice(0, 100).map((excluded, index) => (
                    <div key={`${excluded.sourceId ?? excluded.sourceLabel}\0${excluded.kind}\0${excluded.path}\0${index}`}>
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
                <SourceProgressRows sources={progress.sourceProgress ?? []} operationPhase={progress.phase} />
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
              <button onClick={() => { if (operationIdRef.current) void electronAPI.dismissSourceCloneSession(operationIdRef.current); setPlan(null); setDestinations([]); }} disabled={busy}>Change destinations</button>
              {running ? (
                <button className="source-clone-cancel" onClick={() => void cancel()} disabled={cancelPending}>{cancelPending ? "Stopping…" : "Cancel copy"}</button>
              ) : progress?.phase === "complete" ? (
              <button className="source-clone-primary" onClick={closePanel}>Done</button>
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
