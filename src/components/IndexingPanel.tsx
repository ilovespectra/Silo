import React, { useEffect, useRef, useState } from "react";
import { FiAlertCircle, FiChevronDown, FiPause, FiPlay, FiRefreshCw } from "react-icons/fi";
import { describeIndexingConnectionError } from "../utils/indexingConnection";

const activeStatuses = new Set([
  "scanning",
  "loading-model",
  "indexing",
  "generating",
  "clustering",
]);

const stageErrorStyle: React.CSSProperties = {
  overflowWrap: "anywhere",
  whiteSpace: "normal",
  lineHeight: 1.4,
};

const stageDescriptions: Record<string, string> = {
  startup: "Opening saved indexes",
  "semantic-runtime": "Preparing the offline search model",
  discovery: "Finding files in connected sources",
  search: "Adding files to search",
  faces: "Grouping people in photos",
  locations: "Reading photo location data",
  duplicates: "Checking for duplicate files",
  audio: "Finding audio files",
  quality: "Scoring photo quality",
  thumbnails: "Preparing file previews",
};

interface IndexingPanelProps {
  onStagesChange?: (stages: IndexingStageProgress[]) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/** Count-only polling is isolated here so progress never rerenders the file grid. */
export default function IndexingPanel({ onStagesChange, collapsed = false, onToggleCollapsed }: IndexingPanelProps) {
  const [stages, setStages] = useState<IndexingStageProgress[]>([]);
  const [error, setError] = useState<
    (ReturnType<typeof describeIndexingConnectionError> & { waiting?: boolean }) | null
  >(null);
  const [attempts, setAttempts] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(2);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const retryNow = useRef<() => void>(() => undefined);
  const [retryingStage, setRetryingStage] = useState<string | null>(null);
  const [actingStage, setActingStage] = useState<string | null>(null);
  const [stageActionNotice, setStageActionNotice] = useState<{
    id: string;
    kind: "pause" | "retry";
    message: string;
  } | null>(null);
  const [stageActionError, setStageActionError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  // When several stages wait on the same thing, say it once above the list.
  const waitCounts = new Map<string, number>();
  for (const stage of stages) {
    if (stage.resumeQueued && stage.blockedReason && stage.status !== "complete")
      waitCounts.set(stage.blockedReason, (waitCounts.get(stage.blockedReason) ?? 0) + 1);
  }
  let sharedWaitReason = "";
  for (const [reason, count] of waitCounts) {
    if (count >= 2 && count > (waitCounts.get(sharedWaitReason) ?? 0)) sharedWaitReason = reason;
  }
  useEffect(() => {
    onStagesChange?.(stages);
  }, [onStagesChange, stages]);
  useEffect(() => {
    if (!stageActionNotice) return;
    const stage = stages.find((item) => item.id === stageActionNotice.id);
    if (!stage) return;
    const actionAccepted = stageActionNotice.kind === "pause"
      ? stage.userPaused && stage.status === "paused"
      : stage.recoveryRunning || stage.resumeQueued;
    if (actionAccepted) setStageActionNotice(null);
  }, [stageActionNotice, stages]);
  const retryStage = async (id: string) => {
    const label = stages.find((stage) => stage.id === id)?.label ?? "this indexer";
    if (!window.confirm(
      `Restart ${label}? Silo will save progress at the current checkpoint, stop the indexer cleanly, then start it again. This may take some time and temporarily reduce performance while it restarts.`,
    )) return;
    setRetryingStage(id);
    setStageActionError(null);
    setStageActionNotice({ id, kind: "retry", message: "Queueing retry…" });
    try {
      if (!window.electron?.retryIndexingStage)
        throw new Error("Restart Silo to enable manual index retries.");
      await window.electron.retryIndexingStage(id);
      setStageActionNotice({
        id,
        kind: "retry",
        message: "Retry accepted · waiting for its processing slot…",
      });
      retryNow.current();
    } catch (cause) {
      setStageActionNotice(null);
      setStageActionError({
        id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRetryingStage(null);
    }
  };
  const pauseStage = async (id: string) => {
    setActingStage(id);
    setStageActionError(null);
    setStageActionNotice({
      id,
      kind: "pause",
      message: "Pause requested · finishing the current checkpoint and saving progress…",
    });
    try {
      if (!window.electron?.pauseIndexingStage)
        throw new Error("Restart Silo to enable stage controls.");
      await window.electron.pauseIndexingStage(id);
      retryNow.current();
    } catch (cause) {
      setStageActionNotice(null);
      setStageActionError({
        id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setActingStage(null);
    }
  };
  useEffect(() => {
    let disposed = false;
    let running = false;
    let failures = 0;
    let timer: number | undefined;
    const refresh = async () => {
      if (disposed || running) return;
      window.clearTimeout(timer);
      running = true;
      const slowTimer = window.setTimeout(() => {
        if (!disposed)
          setError({
            message: "Silo's background services are busy; progress will update when they answer.",
            action: "",
            waiting: true,
          });
      }, 15000);
      try {
        const api = window.electron;
        if (!api?.getIndexingOverview)
          throw new Error(
            "Indexing progress API unavailable in the desktop bridge.",
          );
        const next = await api.getIndexingOverview();
        if (!Array.isArray(next))
          throw new Error(
            "Invalid indexing progress response from the backend.",
          );
        if (disposed) return;
        setStages((current) =>
          JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
        failures = 0;
        setAttempts(0);
        setLastUpdated(Date.now());
        setError(null);
      } catch (cause) {
        failures += 1;
        if (!disposed) {
          setAttempts(failures);
          setError(describeIndexingConnectionError(cause));
        }
      } finally {
        window.clearTimeout(slowTimer);
        running = false;
        const delay = failures
          ? Math.min(30000, 3000 * 2 ** Math.min(failures - 1, 4))
          : 3000;
        if (!disposed) {
          setRetrySeconds(Math.ceil(delay / 1000));
          timer = window.setTimeout(() => void refresh(), delay);
        }
      }
    };
    retryNow.current = () => void refresh();
    void refresh();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      retryNow.current = () => undefined;
    };
  }, []);
  return (
    <section className="indexing-panel" aria-label="Indexing progress">
      {onToggleCollapsed ? (
        <div className="sidebar-heading">
          <button
            type="button"
            className="sidebar-collapse-toggle"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            title={collapsed ? "Show library indexing" : "Hide library indexing"}
          >
            <h3>
              Library indexing
              <FiChevronDown className="sidebar-collapse-chevron" aria-hidden="true" />
            </h3>
          </button>
        </div>
      ) : (
        <h3>Library indexing</h3>
      )}
      {!collapsed && <>
      {/* Retries are automatic; brief hiccups stay quiet and only persistent failures explain themselves. */}
      {error && (error.waiting || attempts < 3) && (
        <p className="indexing-panel-status" role="status">
          <FiRefreshCw aria-hidden="true" />{" "}
          {error.waiting
            ? error.message
            : "Reconnecting to indexing services…"}
          {lastUpdated &&
            ` Showing progress from ${new Date(lastUpdated).toLocaleTimeString()}.`}
        </p>
      )}
      {error && !error.waiting && attempts >= 3 && (
        <div className="indexing-panel-error" role="status">
          <strong>
            <FiAlertCircle aria-hidden="true" /> Reconnecting to indexing services
          </strong>
          <p>{error.message}</p>
          {error.action && <p>{error.action}</p>}
          <small>
            Silo keeps trying automatically (next attempt in about{" "}
            {retrySeconds}s).
            {lastUpdated &&
              ` Showing progress from ${new Date(lastUpdated).toLocaleTimeString()}.`}
          </small>
        </div>
      )}
      {sharedWaitReason && (
        <p className="indexing-panel-status" role="status">
          Waiting: {sharedWaitReason}
        </p>
      )}
      {stages.find((stage) => stage.persistenceError)?.persistenceError && (
        <p className="indexing-panel-error" role="alert">
          Indexing recovery state is unavailable: {stages.find((stage) => stage.persistenceError)?.persistenceError}
          {" "}Your latest pause or retry choice may not survive an app restart.
        </p>
      )}
      {stages.map((stage) => {
        const processed = Math.max(0, Number(stage.processed) || 0);
        const total = Math.max(0, Number(stage.total) || 0);
        const complete = stage.status === "complete";
        const running = activeStatuses.has(stage.status);
        const percent =
          complete
            ? 100
            : total > 0
              ? Math.min(100, Math.round((processed / total) * 100))
              : 0;
        const isPhoneBackup = stage.id.startsWith("phone-backup:");
        const processDescription = isPhoneBackup
          ? stage.status === "error"
            ? "Phone backup needs attention"
            : stage.message
          : stage.id === "semantic-runtime"
            ? stage.message
            : stageDescriptions[stage.id] ?? "Indexing files";
        const showStageReason =
          (stage.status === "error" ||
            (stage.status === "paused" && !stage.userPaused)) &&
          Boolean(stage.message?.trim());
        const resuming = !complete && (stage.recoveryRunning || stage.resumeQueued);
        // A paused note is redundant once a resume is already lined up.
        const stageReason =
          showStageReason && !(resuming && stage.status === "paused")
            ? (stage.message ?? "").trim()
            : "";
        const ownBlockedReason =
          stage.blockedReason && stage.blockedReason !== sharedWaitReason
            ? stage.blockedReason
            : "";
        let statusText = "";
        let statusAlert = stage.status === "error" && Boolean(stageReason);
        if (complete) {
          statusText = "";
        } else if (stageActionNotice?.id === stage.id) {
          statusText = stageActionNotice.message;
        } else if (stage.userPaused) {
          statusText = "Paused · progress saved at the latest checkpoint";
        } else if (stage.recoveryRunning) {
          statusText = "Retrying or resuming…";
        } else if (stage.resumeQueued) {
          statusText = ownBlockedReason ? `Queued · ${ownBlockedReason}` : "Queued";
        } else if (stage.recoveryError && stage.recoveryError !== stage.message) {
          statusAlert = true;
          statusText = `Retry failed: ${stage.recoveryError}${
            stage.retryAt && stage.retryAt > Date.now()
              ? ` · next try in ${Math.ceil((stage.retryAt - Date.now()) / 1000)}s`
              : ""
          }`;
        } else if (stage.status === "error" && stage.blockedReason) {
          statusText = `Blocked: ${stage.blockedReason}`;
        }
        const statusParts = [stageReason, statusText].filter(Boolean);
        const statusLine = statusParts.length
          ? { text: statusParts.join(" · "), alert: statusAlert }
          : null;
        return (
          <div
            key={stage.id}
            className={`indexing-stage ${complete ? "complete" : ""} ${running ? "running" : ""}`}
          >
            <header>
              <strong>{stage.label}</strong>
              <span>
                {isPhoneBackup && stage.status === "scanning"
                  ? "Scanning…"
                  : running && total === 0
                    ? "Working…"
                    : `${percent}%`}
              </span>
            </header>
            <progress
              aria-label={`${stage.label} progress`}
              value={
                (isPhoneBackup && stage.status === "scanning") || (running && total === 0)
                  ? undefined
                  : complete
                    ? Math.max(total, 1)
                    : Math.min(processed, total)
              }
              max={Math.max(total, 1)}
            />
            <small className="indexing-stage-message" title={stage.message}>
              {processDescription}
            </small>
            {stage.detail && (
              <small className="indexing-stage-detail">{stage.detail}</small>
            )}
            {statusLine && (
              <small
                role={statusLine.alert
                  ? "alert"
                  : stageActionNotice?.id === stage.id || stage.userPaused
                    ? "status"
                    : undefined}
                className="indexing-stage-errors"
                style={stageErrorStyle}
                title={statusLine.text}
              >
                {statusLine.text}
              </small>
            )}
            {stageActionError?.id === stage.id && (
              <small
                role="alert"
                className="indexing-stage-errors"
                style={stageErrorStyle}
              >
                {stageActionError.message}
              </small>
            )}
            {stage.canPause &&
              !complete &&
              !stage.userPaused &&
              (running || stage.resumeQueued || stage.recoveryRunning) && (
                <button
                  className="indexing-retry-button"
                  disabled={actingStage !== null || retryingStage !== null}
                  title="Pause after the current checkpoint and save progress"
                  aria-label={`Pause ${stage.label} after the current checkpoint`}
                  onClick={() => void pauseStage(stage.id)}
                >
                  <FiPause aria-hidden="true" />
                </button>
              )}
            {stage.canRetry &&
              !stage.resumeQueued &&
              !stage.recoveryRunning &&
              (stage.id === "quality" ||
                stage.status === "paused" ||
                stage.status === "error" ||
                stage.status === "waiting" ||
                stage.status === "idle" ||
                stage.userPaused ||
                stage.retryExhausted) && (
                <button
                  className="indexing-retry-button"
                  disabled={
                    retryingStage !== null ||
                    actingStage !== null ||
                    stage.resumeQueued ||
                    stage.recoveryRunning
                  }
                  title={
                    stage.id === "semantic-runtime"
                      ? "Retry the offline search model now"
                      : stage.id === "quality"
                      ? "Refresh photo quality index"
                      : stage.resumeQueued
                      ? "Resume queued"
                      : stage.recoveryRunning
                        ? "Resuming…"
                        : stage.userPaused || stage.status === "paused"
                          ? "Resume indexing from saved progress"
                          : "Retry indexing"
                  }
                  aria-label={
                    stage.id === "semantic-runtime"
                      ? "Retry offline search model now"
                      : stage.id === "quality"
                      ? "Refresh photo quality index"
                      : `Retry or resume ${stage.label}`
                  }
                  onClick={() => void retryStage(stage.id)}
                >
                  <FiRefreshCw aria-hidden="true" />
                </button>
              )}
          </div>
        );
      })}
      </>}
    </section>
  );
}
