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
  const busy = preparing || running || extracting;
  const supportsTimeMachine = mode === "sources" && sources.length === 1 && sources[0].kind === "machine";
  const timeMachineOnly = supportsTimeMachine && createAppleCompatibleBackup && timeMachineMode === "instead";

  useEffect(() => {
    return electronAPI.onSourceCloneProgress((state) => {
      if (state.operationId === operationIdRef.current) setProgress(state);
    });
  }, [electronAPI]);

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
    try {
      const result = mode === "shelter-replica"
        ? await electronAPI.prepareShelterReplica(destinations, operationId)
        : await electronAPI.prepareSourceClone(
            sources.map((source) => source.id),
            destinations,
            operationId,
          );
      if (!result.ok || !result.plan)
        throw new Error(result.error || "Could not prepare this clone.");
      setPlan(result.plan);
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
      setError(cause instanceof Error ? cause.message : "Could not prepare this clone.");
    } finally {
      setPreparing(false);
    }
  };

  const startClone = async () => {
    if (!plan || plan.destinations.some((destination) => destination.shortfallBytes > 0) || !acknowledged) return;
    setRunning(true);
    setError("");
    try {
      const result = await electronAPI.startSourceClone(plan.planId, {
        compress,
        createAppleCompatibleBackup: supportsTimeMachine && createAppleCompatibleBackup && timeMachineMode === "as-well",
      });
      if (!result.ok) throw new Error(result.error || "Clone did not complete.");
      if (result.timeMachineStarted)
        setTimeMachineMessage("macOS accepted the Time Machine backup request. Check Time Machine for progress and completion.");
      if (result.timeMachineError)
        setTimeMachineError(`The Silo clone completed, but Time Machine could not be confirmed: ${result.timeMachineError}`);
    } catch (cause) {
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
    try {
      const result = await electronAPI.startMachineTimeMachineBackup(sources[0].id);
      if (!result.ok) throw new Error(result.error || "Time Machine did not start.");
      if (result.timeMachineStarted)
        setTimeMachineMessage("macOS accepted the Time Machine backup request. Check Time Machine for progress and completion.");
    } catch (cause) {
      setTimeMachineError(cause instanceof Error ? cause.message : "Time Machine could not be started or confirmed.");
    } finally {
      setRunning(false);
    }
  };

  const cancel = async () => {
    const operationId = operationIdRef.current;
    if (operationId) await electronAPI.cancelSourceClone(operationId);
    setPreparing(false);
    setRunning(false);
  };

  const extractArchive = async () => {
    setError(""); setProgress(null); setExtracting(true);
    const operationId = `extract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    operationIdRef.current = operationId;
    try {
      const result = await electronAPI.extractSourceCloneArchive(operationId);
      if (!result.ok && !result.cancelled) throw new Error(result.error || "The archive could not be extracted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The archive could not be extracted.");
    } finally {
      setExtracting(false);
    }
  };

  const hasShortfall = Boolean(plan?.destinations.some((destination) => destination.shortfallBytes > 0));
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
            <span className="sidebar-kicker">{mode === "shelter-replica" ? "VERIFIED SHELTER REPLICA" : "READ-ONLY SOURCE COPY"}</span>
            <h2 id="source-clone-title">{mode === "shelter-replica" ? "Clone Fallout Shelter" : "Clone selected sources"}</h2>
          </div>
          {!busy && <button className="source-clone-close" onClick={onClose} aria-label="Close"><FiX /></button>}
        </header>

        <div className="source-clone-sources">
          <strong>{sources.length} selected source{sources.length === 1 ? "" : "s"}</strong>
          <span>{sources.map((source) => `${source.label} · ${source.kind}`).join("  /  ")}</span>
        </div>

        <div className="source-clone-safety">
          <FiShield />
          <p><strong>Originals are read-only.</strong> {mode === "shelter-replica"
            ? "Silo copies the latest completed shelter snapshot to a different physical volume and verifies each unique file by SHA-256."
            : "Silo reads selected sources and writes one physical copy per unique SHA-256; duplicate source paths become hard links where supported, or manifest aliases. Originals are not changed."}</p>
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
                <button className="source-clone-primary" onClick={() => void prepare()} disabled={sources.length === 0 || destinations.length === 0}>{mode === "shelter-replica" ? "Scan shelter & check space" : "Scan sources & check space"}</button>
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
              <span>{createAppleCompatibleBackup && timeMachineMode === "as-well"
                ? "I understand this makes a separate readable Silo copy in the selected folder and also requests a separate Time Machine backup at macOS’s configured destination; originals and settings are not changed."
                : "I understand this makes a separate copy and does not alter the originals."}</span>
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
              <div className="source-clone-success"><FiCheckCircle /> {progress.message}</div>
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
                <button className="source-clone-primary" onClick={() => void startClone()} disabled={!acknowledged || hasShortfall}>
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
      </section>
    </div>
  );
}
