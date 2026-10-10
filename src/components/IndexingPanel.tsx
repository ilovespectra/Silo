import React, { useEffect, useRef, useState } from "react";
import { FiAlertCircle, FiRefreshCw } from "react-icons/fi";
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
}

/** Count-only polling is isolated here so progress never rerenders the file grid. */
export default function IndexingPanel({ onStagesChange }: IndexingPanelProps) {
  const [stages, setStages] = useState<IndexingStageProgress[]>([]);
  const [error, setError] = useState<
    (ReturnType<typeof describeIndexingConnectionError> & { waiting?: boolean }) | null
  >(null);
  const [attempts, setAttempts] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(2);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const retryNow = useRef<() => void>(() => undefined);
  const [retryingStage, setRetryingStage] = useState<string | null>(null);
  const [stageRetryError, setStageRetryError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    onStagesChange?.(stages);
  }, [onStagesChange, stages]);
  const retryStage = async (id: string) => {
    setRetryingStage(id);
    setStageRetryError(null);
    try {
      if (!window.electron?.retryIndexingStage)
        throw new Error("Restart Silo to enable manual index retries.");
      await window.electron.retryIndexingStage(id);
      retryNow.current();
    } catch (cause) {
      setStageRetryError({
        id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRetryingStage(null);
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
      <h3>Library indexing</h3>
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
        const processDescription = stageDescriptions[stage.id] ?? "Indexing files";
        const showStageReason =
          (stage.status === "error" || stage.status === "paused") &&
          Boolean(stage.message?.trim());
        return (
          <div
            key={stage.id}
            className={`indexing-stage ${complete ? "complete" : ""} ${running ? "running" : ""}`}
          >
            <header>
              <strong>{stage.label}</strong>
              <span>{percent}%</span>
            </header>
            <progress
              aria-label={`${stage.label} progress`}
              value={
                running && total === 0
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
            {showStageReason && (
              <small
                role={stage.status === "error" ? "alert" : undefined}
                className="indexing-stage-errors"
                style={stageErrorStyle}
              >
                {stage.message}
              </small>
            )}
            {stage.recoveryError && stage.recoveryError !== stage.message && (
              <small
                role="alert"
                className="indexing-stage-errors"
                style={stageErrorStyle}
              >
                Retry error: {stage.recoveryError}
              </small>
            )}
            {stage.recoveryRunning && (
              <small className="indexing-stage-errors" style={stageErrorStyle}>
                Retry is running.
              </small>
            )}
            {stage.resumeQueued && (
              <small className="indexing-stage-errors" style={stageErrorStyle}>
                Retry queued{stage.blockedReason ? ` · Waiting: ${stage.blockedReason}` : "."}
              </small>
            )}
            {!stage.resumeQueued &&
              !stage.recoveryRunning &&
              stage.status === "error" &&
              stage.blockedReason && (
                <small className="indexing-stage-errors" style={stageErrorStyle}>
                  Retry blocked: {stage.blockedReason}
                </small>
              )}
            {stageRetryError?.id === stage.id && (
              <small
                role="alert"
                className="indexing-stage-errors"
                style={stageErrorStyle}
              >
                {stageRetryError.message}
              </small>
            )}
            {stage.canRetry &&
              (stage.id === "quality" ||
                stage.status === "paused" ||
                stage.status === "error" ||
                stage.status === "waiting" ||
                stage.status === "idle" ||
                stage.retryExhausted) && (
                <button
                  className="indexing-retry-button"
                  disabled={
                    retryingStage !== null ||
                    stage.resumeQueued ||
                    stage.recoveryRunning
                  }
                  title={
                    stage.id === "quality"
                      ? "Refresh photo quality index"
                      : stage.resumeQueued
                      ? "Resume queued"
                      : stage.recoveryRunning
                        ? "Resuming…"
                        : stage.status === "paused"
                          ? "Resume indexing"
                          : "Retry indexing"
                  }
                  aria-label={
                    stage.id === "quality"
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
    </section>
  );
}
