import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IconBaseProps } from "react-icons";
import { FiArrowRight as ArrowRight, FiCheck as Check, FiChevronRight as ChevronRight, FiDownload as Download, FiEdit3 as Edit3, FiFilm as Film, FiFolder as Folder, FiImage as Image, FiLock as Lock, FiMaximize as Maximize, FiMinimize as Minimize, FiMusic as Music, FiPause as Pause, FiPlay as Play, FiRefreshCw as RefreshCw, FiSearch as Search, FiTrash2 as Trash2, FiX as X } from "react-icons/fi";
import type { MemoriesAPI, MemoryAudioBrowseFile, MemoryAudioBrowseResult, MemoryAudioSort, MemoryExportOptions, MemoryExportProgress, MemoryGenerationStatus, MemoryMusicAvailability, MemoryPreviewStatus, MemoryState, MemorySuggestion, MemorySoundtrack, SavedMemoryMovie } from "../memoryTypes";
import {
  MEMORY_DEFAULT_SELECTION_COUNT,
  getMemorySelectionMinimum,
  MEMORY_DURATION_SECONDS,
  MEMORY_EXPORT_LIMITS,
} from "../memoryTypes";
import "../styles/Memories.css";

// react-icons uses the newer ReactNode component signature; this project uses TS 4.9.
export const MemoryIcons = {
  FiArrowRight: ArrowRight, FiCheck: Check, FiChevronRight: ChevronRight, FiDownload: Download, FiEdit3: Edit3, FiFilm: Film, FiLock: Lock, FiFolder: Folder,
  FiImage: Image, FiMaximize: Maximize, FiMinimize: Minimize, FiMusic: Music, FiPause: Pause, FiPlay: Play, FiSearch: Search, FiTrash2: Trash2, FiX: X,
} as unknown as Record<"FiArrowRight" | "FiCheck" | "FiChevronRight" | "FiDownload" | "FiEdit3" | "FiFilm" | "FiLock" | "FiFolder" | "FiImage" | "FiMaximize" | "FiMinimize" | "FiMusic" | "FiPause" | "FiPlay" | "FiSearch" | "FiTrash2" | "FiX", React.FC<IconBaseProps>>;
const { FiArrowRight, FiCheck, FiChevronRight, FiDownload, FiEdit3, FiFilm, FiLock, FiFolder, FiImage, FiMaximize, FiMinimize, FiMusic, FiPause, FiPlay, FiSearch, FiTrash2, FiX } = MemoryIcons;

export interface MemoriesPageProps {
  api: MemoriesAPI;
  ready?: boolean;
  thumbnailSize?: number;
  onThumbnailSizeChange?: (size: number) => void;
  onChooseMusicFolder?: () => Promise<boolean>;
}

const errorMessage = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : typeof cause === "string" && cause.trim() ? cause : fallback;
// Display-only placeholder matching the manager's `original:<suggestionId>` contract; exports always use API-listed tracks.
const soundtrackFallback = (suggestionId: string): MemorySoundtrack => ({ id: `original:${suggestionId}`, name: "Original audio", source: "original", rights: "Uses audio from the selected clips." });

function Thumbnail({ url, className = "" }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="memories-thumbnail-fallback"><FiImage aria-hidden="true" /></span> :
    <img className={className} src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function formatPlaybackTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(hours ? 2 : 1, "0");
  const remainder = (total % 60).toString().padStart(2, "0");
  return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
}

/** Playback time and scrubber are synchronized from the media element's actual playhead. */
function MemoryVideoPlayer({ src, label, autoPlay = false, onEnded }: {
  src: string; label: string; autoPlay?: boolean; onEnded?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const playerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      if (document.fullscreenElement === playerRef.current) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void playerRef.current?.requestFullscreen().catch(() => undefined);
  };
  const syncDuration = () => {
    const actual = videoRef.current?.duration ?? 0;
    setDuration(Number.isFinite(actual) && actual > 0 ? actual : 0);
  };
  const syncPlayhead = () => {
    const actual = videoRef.current?.currentTime ?? 0;
    if (Number.isFinite(actual)) setCurrentTime(actual);
  };
  const seek = (value: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) return;
    video.currentTime = Math.max(0, Math.min(value, duration));
    setCurrentTime(video.currentTime);
  };
  return <div ref={playerRef} className={`memories-video-player${fullscreen ? " is-fullscreen" : ""}`}>
    <video
      ref={videoRef}
      className="memories-export-video"
      src={src}
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
      aria-label={label}
      onLoadedMetadata={syncDuration}
      onDurationChange={syncDuration}
      onTimeUpdate={syncPlayhead}
      onSeeking={syncPlayhead}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => { setPlaying(false); onEnded?.(); }}
      onDoubleClick={toggleFullscreen}
    />
    <div className="memories-playback-controls">
      <button type="button" className="memories-playback-toggle" onClick={() => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play().catch(() => setPlaying(false));
        else video.pause();
      }}>{playing ? "Pause" : "Play"}</button>
      <output aria-live="off" className="memories-playback-time">{formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}</output>
      <button type="button" className="memories-fullscreen-toggle" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit full screen" : "Full screen"} title={fullscreen ? "Exit full screen" : "Full screen"}>
        {fullscreen ? <FiMinimize aria-hidden="true" /> : <FiMaximize aria-hidden="true" />}
      </button>
    </div>
    <input
      className="memories-playback-slider"
      type="range"
      min={0}
      max={duration || 1}
      step={0.05}
      value={duration ? Math.min(currentTime, duration) : 0}
      disabled={!duration}
      aria-label={`${label} playback position`}
      onChange={(event) => seek(Number(event.target.value))}
    />
  </div>;
}

/** Covers use supplied cached thumbnails only; never request original media. */
export function MemoryCover({ memory }: { memory: MemorySuggestion }) {
  const urls: string[] = [];
  for (const media of memory.media) {
    if (media.thumbnailUrl) urls.push(media.thumbnailUrl);
    if (urls.length === 5) break;
  }
  return <div className={`memories-cover memories-cover-${urls.length} memories-mood-${memory.mood}`} aria-hidden="true">
    {urls.length ? urls.map((url, index) => <Thumbnail key={`${index}:${url}`} url={url} />) :
      <div className="memories-cover-placeholder"><FiFilm /><span>A story waiting to unfold</span></div>}
    <span className="memories-cover-shade" />
    <span className="memories-cover-wordmark">silo / memories</span>
  </div>;
}

export function MemoriesDialog({ title, onClose, children, locked = false }: {
  title: string; onClose: () => void; children: React.ReactNode; locked?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const lockedRef = useRef(locked);
  closeRef.current = onClose;
  lockedRef.current = locked;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!lockedRef.current) closeRef.current();
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), video[controls], [tabindex="0"], a[href]',
      ) || []).filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); panel.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  const content = <div className="memories-modal-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget && !locked) onClose();
  }}>
    <div className="memories-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
      <header className="memories-modal-header"><h2 id={titleId}>{title}</h2>
        <button type="button" className="memories-icon-button" aria-label="Close dialog" onClick={onClose} disabled={locked}><FiX /></button>
      </header>
      {children}
    </div>
  </div>;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

/** Play the already-rendered, full-resolution memory movie. */
export function MemoryViewDialog({ api, memory, onClose }: {
  api: MemoriesAPI; memory: MemorySuggestion; onClose: () => void;
}) {
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [moviePath, setMoviePath] = useState("");
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => disposed ? null : api.viewMemory(memory.id)).then((result) => {
      if (!result) return;
      if (!result.ok || !result.path) throw new Error(result.error || "This memory could not be opened. Refresh memories and try again.");
      setMoviePath(result.path);
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause, "This memory could not be opened. Refresh memories and try again."));
    }).finally(() => {
      if (!disposed) setBusy(false);
    });
    return () => { disposed = true; };
  }, [api, memory.id]);
  return <MemoriesDialog title={`Memories · ${memory.title}`} onClose={onClose}>
    <div className="memories-modal-body">
      <p className="memories-hint">Full-resolution memory · ready to watch</p>
      {moviePath && <MemoryVideoPlayer src={`app-media://stream/${encodeURIComponent(moviePath)}`} autoPlay label={`Memory movie: ${memory.title}`} onEnded={onClose} />}
      {busy && <p className="memories-hint" role="status">Opening memory…</p>}
      {error && <p className="memories-error" role="alert">{error}</p>}
      <div className="memories-modal-actions">
        <button type="button" className="memories-button memories-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  </MemoriesDialog>;
}

function ExportDialog({ api, memory, options, onClose, onDownloaded }: {
  api: MemoriesAPI; memory: MemorySuggestion; options: MemoryExportOptions;
  onClose: () => void; onDownloaded: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<MemoryExportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [moviePath, setMoviePath] = useState("");
  const [saved, setSaved] = useState(false);
  const active = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = api.onMemoryExportProgress((next) => {
      if (!active.current || next.suggestionId !== memory.id) return;
      setProgress((previous) => previous && previous.phase === next.phase && previous.completed === next.completed &&
        previous.total === next.total && previous.message === next.message ? previous : next);
    });
    return () => { alive.current = false; unsubscribe(); };
  }, [api, memory.id]);
  const download = async () => {
    if (active.current) return;
    active.current = true;
    setRunning(true); setError(""); setNotice(""); setProgress(null);
    try {
      const result = await api.exportMemory(options);
      if (!alive.current) return;
      if (result.canceled) { setNotice("Export cancelled. Your memory is still here."); setProgress(null); return; }
      if (!result.ok) throw new Error(result.error || "The movie could not be exported. Try again or choose another soundtrack.");
      setSaved(true);
      setMoviePath(result.path || "");
      setNotice("Movie saved. This memory stays in your collection, and your original photos and clips are unchanged.");
      setProgress({ suggestionId: memory.id, phase: "complete", completed: 1, total: 1, message: "Movie saved" });
      try { await onDownloaded(); }
      catch (cause) { if (alive.current) setError(errorMessage(cause, "Movie saved, but the suggestions could not be refreshed.")); }
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause, "Export failed. Please try again."));
    } finally {
      active.current = false;
      if (alive.current) { setRunning(false); setCancelling(false); }
    }
  };
  const cancel = async () => {
    setCancelling(true); setError("");
    try { await api.cancelMemoryExport(); }
    catch (cause) { if (alive.current) { setError(errorMessage(cause, "Could not cancel the export.")); setCancelling(false); } }
  };
  const ratio = progress && progress.total > 0 ? Math.max(0, Math.min(1, progress.completed / progress.total)) : undefined;
  return <MemoriesDialog title={`Save memory · ${memory.title}`} onClose={onClose} locked={running}>
    <div className="memories-modal-body">
      <p className="memories-hint">{options.count} photos / clips · {options.duration} seconds ({(options.duration / options.count).toFixed(1)}s each) · Landscape 16:9</p>
      {!moviePath && <MemoryCover memory={memory} />}
      {moviePath && <MemoryVideoPlayer src={`app-media://stream/${encodeURIComponent(moviePath)}`} label={`Exported movie: ${memory.title}`} onEnded={onClose} />}
      {running && <div className="memories-export-progress" role="status" aria-live="polite">
        <span>{progress?.message || "Choose a save location, then your movie will be prepared…"}</span>
        <progress max={1} value={ratio} aria-label="Movie export progress" />
        <small>{progress?.phase || "preparing"}{ratio !== undefined ? ` · ${Math.round(ratio * 100)}% of this stage` : ""}</small>
      </div>}
      {notice && <p className="memories-success" role="status"><FiCheck aria-hidden="true" />{notice}</p>}
      {error && <p className="memories-error" role="alert">{error}</p>}
      <div className="memories-modal-actions">
        {running ? <button type="button" className="memories-button" disabled={cancelling} onClick={cancel}>{cancelling ? "Cancelling…" : "Cancel export"}</button> :
          <><button type="button" className="memories-button" onClick={onClose}>{notice ? "Done" : "Close"}</button>
            {!saved && <button type="button" className="memories-button memories-primary" onClick={download}><FiDownload />Choose location & save movie</button>}</>}
      </div>
    </div>
  </MemoriesDialog>;
}

const formatBytes = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const AUDIO_PAGE = 200;

/** In-app, audio-only explorer: browse sources and folders, search, sort, preview and pick a song. */
export function AudioBrowserDialog({ api, title, onClose, onPick }: {
  api: MemoriesAPI; title: string; onClose: () => void; onPick: (file: MemoryAudioBrowseFile) => void;
}) {
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [sort, setSort] = useState<MemoryAudioSort>("name");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState(AUDIO_PAGE);
  const [result, setResult] = useState<MemoryAudioBrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<MemoryAudioBrowseFile | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearched(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => { setLimit(AUDIO_PAGE); }, [sourceId, folder, searched, sort, direction]);
  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    Promise.resolve().then(() => api.browseMemoryAudio!({ sourceId, folder, query: searched, sort, direction, limit }))
      .then((next) => { if (current) setResult(next); })
      .catch((cause) => { if (current) setError(errorMessage(cause, "Your audio library could not be listed.")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, sourceId, folder, searched, sort, direction, limit]);
  const source = result?.sources.find((item) => item.id === sourceId);
  const crumbs = folder ? folder.split("/") : [];
  const open = (nextSource: string | undefined, nextFolder = "") => { setSourceId(nextSource); setFolder(nextFolder); setQuery(""); setSearched(""); };
  const atRoot = !sourceId && !searched;
  return <MemoriesDialog title={title} onClose={onClose}>
    <div className="memories-modal-body memories-audio-browser">
      <div className="memories-audio-toolbar">
        <label className="memories-audio-search"><FiSearch aria-hidden="true" />
          <input type="search" value={query} placeholder={source ? `Search ${crumbs.length ? crumbs[crumbs.length - 1] : source.label}` : "Search all audio"}
            aria-label="Search audio" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <select aria-label="Sort audio" value={sort} onChange={(event) => setSort(event.target.value as MemoryAudioSort)}>
          <option value="name">Name</option><option value="modified">Date modified</option><option value="size">Size</option>
        </select>
        <button type="button" className="memories-button" aria-label={direction === "asc" ? "Ascending; switch to descending" : "Descending; switch to ascending"}
          onClick={() => setDirection(direction === "asc" ? "desc" : "asc")}>{direction === "asc" ? "\u2191" : "\u2193"}</button>
      </div>
      <nav className="memories-audio-crumbs" aria-label="Audio location">
        <button type="button" className="memories-text-button" onClick={() => open(undefined)}>Audio library</button>
        {source && <><FiChevronRight aria-hidden="true" /><button type="button" className="memories-text-button" onClick={() => open(sourceId)}>{source.label}</button></>}
        {crumbs.map((name, index) => <React.Fragment key={index}><FiChevronRight aria-hidden="true" />
          <button type="button" className="memories-text-button" onClick={() => open(sourceId, crumbs.slice(0, index + 1).join("/"))}>{name}</button></React.Fragment>)}
        {searched && <span className="memories-hint"> · results for “{searched}”</span>}
      </nav>
      {error && <p className="memories-error" role="alert">{error}</p>}
      <ul className="memories-audio-list" aria-busy={loading}>
        {atRoot && result?.sources.map((item) => <li key={item.id}><button type="button" className="memories-audio-row" onClick={() => open(item.id)}>
          <FiFolder aria-hidden="true" /><span className="memories-audio-name">{item.label}</span><span className="memories-audio-meta">{item.count.toLocaleString()} files</span></button></li>)}
        {!searched && result?.folders.map((item) => <li key={item.path}><button type="button" className="memories-audio-row" onClick={() => open(sourceId, item.path)}>
          <FiFolder aria-hidden="true" /><span className="memories-audio-name">{item.name}</span><span className="memories-audio-meta">{item.count.toLocaleString()} files</span></button></li>)}
        {result?.files.map((file) => <li key={file.id} className="memories-audio-file">
          <button type="button" className="memories-icon-button" aria-label={playing?.id === file.id ? `Stop preview of ${file.name}` : `Preview ${file.name}`}
            onClick={() => setPlaying(playing?.id === file.id ? null : file)}>{playing?.id === file.id ? <FiPause /> : <FiPlay />}</button>
          <span className="memories-audio-name" title={file.path}>{file.name}
            <small>{[file.sourceLabel, file.folder].filter(Boolean).join(" / ")}</small></span>
          <span className="memories-audio-meta">{formatBytes(file.size)}{file.modified ? ` · ${new Date(file.modified).toLocaleDateString()}` : ""}</span>
          <button type="button" className="memories-button memories-primary" onClick={() => onPick(file)}><FiMusic aria-hidden="true" />Use song</button>
        </li>)}
        {!loading && result && !result.files.length && !result.folders.length && !(atRoot && result.sources.length) &&
          <li className="memories-hint">{searched ? "No audio matches that search." : "No audio files here."}</li>}
      </ul>
      <footer className="memories-audio-footer">
        <span className="memories-hint" role="status">{loading ? "Loading\u2026" : result && result.total > 0 ? `Showing ${Math.min(result.files.length, result.total).toLocaleString()} of ${result.total.toLocaleString()} songs` : ""}</span>
        {result && result.total > limit && <button type="button" className="memories-button" onClick={() => setLimit(limit + AUDIO_PAGE)}>Show more</button>}
      </footer>
      {playing && <audio src={`app-media://stream/${encodeURIComponent(playing.path)}`} autoPlay onEnded={() => setPlaying(null)} />}
    </div>
  </MemoriesDialog>;
}

function formatEta(seconds: number) {
  const total = Math.max(1, Math.round(seconds));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Shown over a card's cover until its movie is ready to play. */
function PreparingOverlay({ preview }: { preview: MemoryPreviewStatus }) {
  const percent = Math.round((preview.progress ?? 0) * 100);
  return <span className={`memories-preparing ${preview.status}`} role="status" aria-live="polite">
    {preview.status !== "failed" && <span className="memories-spinner" aria-hidden="true" />}
    {preview.status === "failed" ? <>
      <strong>Preview unavailable</strong>
      <small>Some of its files are offline. Reconnect them to prepare it.</small>
    </> : preview.status === "rendering" ? <>
      <strong>Preparing memory… {percent}%</strong>
      <span className="memories-preparing-bar"><span style={{ width: `${percent}%` }} /></span>
      <small>{preview.etaSeconds ? `About ${formatEta(preview.etaSeconds)} left` : "Estimating time…"}</small>
    </> : <>
      <strong>Waiting to prepare</strong>
      <small>Memories are prepared one at a time.</small>
    </>}
  </span>;
}

function EditableMemoryTitle({ title, disabled, onSave }: {
  title: string; disabled?: boolean; onSave: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!editing) setDraft(title); }, [editing, title]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = draft.trim().replace(/\s+/g, " ");
    if (!normalized || normalized.length > 80) { setError("Use a title from 1 to 80 characters."); return; }
    setSaving(true); setError("");
    try { await onSave(normalized); setEditing(false); }
    catch (cause) { setError(errorMessage(cause, "The title could not be saved.")); }
    finally { setSaving(false); }
  };
  return <div className="memories-title-editor">
    {!editing ? <div className="memories-title-line"><h2>{title}</h2><button type="button" className="memories-icon-button memories-title-edit" disabled={disabled} aria-label={`Rename memory: ${title}`} title="Rename memory" onClick={() => { setDraft(title); setEditing(true); }}><FiEdit3 /></button></div> :
      <form className="memories-title-form" onSubmit={(event) => { void save(event); }}>
        <input autoFocus value={draft} maxLength={80} aria-label="Memory title" disabled={saving} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} />
        <button type="submit" className="memories-icon-button" aria-label="Save memory title" title="Save" disabled={saving}><FiCheck /></button>
        <button type="button" className="memories-icon-button" aria-label="Cancel title edit" title="Cancel" disabled={saving} onClick={() => setEditing(false)}><FiX /></button>
      </form>}
    {error && <small className="memories-title-error" role="alert">{error}</small>}
  </div>;
}

function MemoryCard({ api, memory, disabled, preview, onBlockedView, onDismiss, onExport, onState, onToast }: {
  api: MemoriesAPI; memory: MemorySuggestion; disabled: boolean; preview?: MemoryPreviewStatus;
  onBlockedView: () => void; onDismiss: () => void;
  onExport: (memory: MemorySuggestion, options: MemoryExportOptions) => void;
  onState?: (state: MemoryState) => void;
  onToast?: (message: string) => void;
}) {
  const playable = !preview || preview.status === "ready";
  const maximum = Math.min(MEMORY_EXPORT_LIMITS.maxCount, memory.media.length);
  const minimum = getMemorySelectionMinimum(maximum);
  const initialCount = Math.min(MEMORY_DEFAULT_SELECTION_COUNT, maximum);
  const [count, setCount] = useState(initialCount);
  const [originalAudio, setOriginalAudio] = useState(0.18);
  const [tracks, setTracks] = useState<MemorySoundtrack[]>([]);
  const [trackId, setTrackId] = useState(memory.soundtrackId ?? `original:${memory.id}`);
  const [trackStatus, setTrackStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [trackError, setTrackError] = useState("");
  const [viewing, setViewing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const mounted = useRef(true);
  const trackRequest = useRef<Promise<MemorySoundtrack[] | null> | null>(null);
  const fieldId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const photos = memory.media.filter((media) => media.type === "image").length;
  const clips = memory.media.length - photos;
  const availableTracks = tracks.length ? tracks : [soundtrackFallback(memory.id)];
  const selectedTrack = availableTracks.find((track) => track.id === trackId) || availableTracks[0];
  const selectedCount = Math.min(maximum, Math.max(minimum, count));
  const changeCount = (nextCount: number) => {
    const next = Math.max(minimum, Math.min(maximum, Math.round(nextCount)));
    setCount(next);
  };
  const loadTracks = (refresh = false): Promise<MemorySoundtrack[] | null> => {
    if (trackStatus === "loaded" && !refresh) return Promise.resolve(tracks);
    // Focus, browse and export share one in-flight request.
    if (trackRequest.current) return trackRequest.current;
    setTrackStatus("loading"); setTrackError("");
    const request = (async () => {
      try {
        // Defer so a synchronous API throw cannot clear the ref before it is assigned.
        const result = await Promise.resolve().then(() => api.getMemorySoundtracks(memory.id));
        if (!mounted.current) return null;
        const original = result.find((track) => track.source === "original");
        if (!original) throw new Error("No original soundtrack is available for this suggestion. Refresh memories and try again.");
        const next = [original, ...result.filter((track) => track.source !== "original")].slice(0, 13);
        const preferred = next.find((track) => track.id === memory.soundtrackId) ?? original;
        setTracks(next); setTrackId(preferred.id); setTrackStatus("loaded");
        return next;
      } catch (cause) {
        if (mounted.current) { setTrackStatus("error"); setTrackError(errorMessage(cause, "Soundtracks could not be loaded. Try again before exporting.")); }
        return null;
      } finally { trackRequest.current = null; }
    })();
    trackRequest.current = request;
    return request;
  };
  const chooseTrack = async (track: MemorySoundtrack) => {
    setTrackId(track.id);
    if (track.source !== "library" || !api.setMemorySoundtrack || track.id === memory.soundtrackId) return;
    try {
      // The watchable movie follows the chosen song and re-renders in the background.
      const next = await api.setMemorySoundtrack(memory.id, track.id);
      if (mounted.current) onState?.(next);
    } catch (cause) {
      if (mounted.current) setTrackError(errorMessage(cause, "That song could not be used. Choose another one."));
    }
  };
  const revealSavedMovie = async () => {
    try {
      const result = await api.revealMemory(memory.id);
      if (!mounted.current) return;
      if (!result.ok || !result.path) throw new Error(result.error || "This movie could not be opened.");
      onToast?.("Shown in Finder");
    } catch (cause) {
      if (mounted.current) onToast?.(errorMessage(cause, "This movie could not be opened."));
    }
  };
  const pickBrowsed = async (file: MemoryAudioBrowseFile) => {
    setBrowsing(false);
    const track: MemorySoundtrack = { id: file.id, name: file.name, path: file.path, source: "library",
      rights: "Song from your music library. For personal viewing only." };
    const loaded = (trackStatus === "loaded" ? tracks : await loadTracks()) ?? [];
    if (!mounted.current) return;
    if (!loaded.some((item) => item.id === track.id)) setTracks([...loaded, track]);
    await chooseTrack(track);
  };
  const prepareExport = async () => {
    // Never export the display placeholder: original-only exports use the API-listed original ID.
    const loaded = trackStatus === "loaded" ? tracks : await loadTracks();
    const selection = loaded?.find((track) => track.id === trackId) ?? loaded?.[0];
    if (!mounted.current || !selection) return;
    onExport(memory, { suggestionId: memory.id, count: selectedCount, duration: MEMORY_DURATION_SECONDS,
      soundtrackId: selection.id, originalAudio });
  };
  return <article className="memories-card">
    <button type="button" className="memories-cover-button" aria-label={playable ? `Watch memory: ${memory.title}` : `Preparing memory: ${memory.title}`} aria-disabled={!playable} disabled={disabled || maximum === 0} onClick={() => { if (playable) setViewing(true); else onBlockedView(); }}><MemoryCover memory={memory} />{playable ? <span className="memories-view-badge"><FiPlay />Watch memory</span> : <PreparingOverlay preview={preview!} />}</button>
    <div className="memories-card-body">
      <div className="memories-card-heading"><div className="memories-card-badges"><span className={`memories-mood-label memories-mood-${memory.mood}`}>{memory.mood}</span>{memory.downloadedAt && <span className="memories-saved-label" title={`Movie saved ${new Date(memory.downloadedAt).toLocaleString()}`}><FiCheck aria-hidden="true" />Saved</span>}</div>
        <button type="button" className="memories-icon-button" aria-label={`Remove suggestion: ${memory.title}`} title="Remove suggestion only; original files are kept" disabled={disabled} onClick={onDismiss}><FiTrash2 /></button>
      </div>
      <EditableMemoryTitle title={memory.title} disabled={disabled} onSave={async (title) => {
        const next = await api.renameMemory(memory.id, title);
        onState?.(next);
      }} />
      <p className="memories-description">{memory.description}</p>
      <div className="memories-meta"><span><FiImage />{photos} photos</span><span><FiFilm />{clips} clips</span><span>Landscape · 16:9</span></div>
      <details className="memories-settings-dropdown">
        <summary>Edit movie settings <span>{selectedCount} files · 1 min</span></summary>
      <div className="memories-card-controls">
        <label htmlFor={`${fieldId}-count`}>Photos & clips <output>{selectedCount} / {memory.media.length} · {(MEMORY_DURATION_SECONDS / Math.max(1, selectedCount)).toFixed(1)}s each</output></label>
        <input id={`${fieldId}-count`} type="range" min={minimum} max={maximum} step={1} value={selectedCount} disabled={disabled || maximum <= 2 || maximum <= minimum} onChange={(event) => changeCount(Number(event.target.value))} />
        <small className="memories-hint">{maximum < MEMORY_DEFAULT_SELECTION_COUNT ? `Up to ${maximum} available items; shots never repeat.` : "More shots means quicker cuts."}</small>
        <div className="memories-fixed-length"><span>Movie length</span><output>1 minute · {MEMORY_DURATION_SECONDS} seconds</output></div>
        <label htmlFor={`${fieldId}-soundtrack`}><span><FiMusic aria-hidden="true" />Soundtrack · {memory.mood}</span></label>
        <select id={`${fieldId}-soundtrack`} value={selectedTrack.id} disabled={disabled || trackStatus === "loading"} onFocus={() => { void loadTracks(); }} onChange={(event) => { const next = availableTracks.find((track) => track.id === event.target.value); if (next) void chooseTrack(next); }}>
          {availableTracks.map((track) => <option key={track.id} value={track.id}>{track.name}{track.source === "original" ? " · original" : " · library"}</option>)}
        </select>
        <button type="button" className="memories-text-button" disabled={disabled || trackStatus === "loading"} onClick={() => { void loadTracks(trackStatus === "loaded"); }}>
          {trackStatus === "loading" ? "Finding soundtracks…" : trackStatus === "error" ? "Retry mood soundtracks" : trackStatus === "loaded" ? "Refresh mood soundtracks" : "Browse mood soundtracks"}
        </button>
        {trackStatus === "loaded" && !tracks.some((track) => track.source === "library") && <p className="memories-hint" role="status">No library songs are indexed yet. Browse your audio library or wait for the music scan to reach its source.</p>}
        {api.browseMemoryAudio && <button type="button" className="memories-text-button" disabled={disabled} onClick={() => setBrowsing(true)}><FiFolder aria-hidden="true" />Browse your audio library…</button>}
        {trackError && <p className="memories-error" role="alert">{trackError}</p>}
        {selectedTrack.source === "library" && <p className="memories-hint memories-rights">
          Song from your library. For personal viewing only — don’t share or upload this movie; the music is copyrighted.
        </p>}
        <label htmlFor={`${fieldId}-audio`}>Original clip audio <output>{Math.round(originalAudio * 100)}%</output></label>
        <input id={`${fieldId}-audio`} type="range" min={0} max={0.6} step={0.01} value={originalAudio} disabled={disabled} onChange={(event) => setOriginalAudio(Number(event.target.value))} />
      </div>
      </details>
      <div className="memories-card-actions">
        <button type="button" className="memories-button memories-primary" disabled={disabled || trackStatus === "loading" || maximum === 0} onClick={() => { void prepareExport(); }}>Save memory</button>
        <button type="button" className="memories-icon-button memories-reveal-button" disabled={disabled || trackStatus === "loading" || maximum === 0} onClick={() => { void revealSavedMovie(); }} aria-label={`Show saved movie for ${memory.title}`} title={memory.downloadedAt ? `Open saved movie in Finder` : "Movie is already saved in your chosen memory folder"}><FiFolder aria-hidden="true" /></button>
      </div>
    </div>
    {viewing && <MemoryViewDialog api={api} memory={memory} onClose={() => setViewing(false)} />}
    {browsing && <AudioBrowserDialog api={api} title={`Choose a song · ${memory.title}`} onClose={() => setBrowsing(false)} onPick={(file) => { void pickBrowsed(file); }} />}
  </article>;
}

function SavedMovieDialog({ movie, onClose }: { movie: SavedMemoryMovie; onClose: () => void }) {
  return <MemoriesDialog title={`Memories · ${movie.title}`} onClose={onClose}>
    <div className="memories-modal-body">
      <MemoryVideoPlayer src={`app-media://stream/${encodeURIComponent(movie.path)}`} autoPlay label={`Memory movie: ${movie.title}`} onEnded={onClose} />
      <div className="memories-modal-actions">
        <button type="button" className="memories-button memories-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  </MemoriesDialog>;
}

/** A story moving into the Memory Book: its thumbnails stay visible while its movie is prepared. */
function PendingBookCard({ api, memory, preview, onState, onRefresh }: {
  api: MemoriesAPI; memory: MemorySuggestion; preview?: MemoryPreviewStatus;
  onState: (state: MemoryState) => void; onRefresh: () => Promise<void>;
}) {
  return <article className="memories-card memories-saved-movie memories-book-pending" aria-busy={preview?.status !== "failed"}>
    <div className="memories-cover-button" role="group" aria-label={`Preparing memory: ${memory.title}`}>
      <MemoryCover memory={memory} />
      <PreparingOverlay preview={preview ?? { status: "queued" }} />
    </div>
    <div className="memories-card-body">
      <div className="memories-card-heading"><div className="memories-card-badges"><span className="memories-saved-label"><FiFilm aria-hidden="true" />Moving to Memory Book</span></div></div>
      <EditableMemoryTitle title={memory.title} onSave={async (title) => {
        onState(await api.renameMemory(memory.id, title));
        await onRefresh();
      }} />
      <div className="memories-meta"><span><FiImage />{memory.media.length} {memory.media.length === 1 ? "item" : "items"}</span></div>
    </div>
  </article>;
}

/** A finished movie from the memories folder whose story card is no longer kept. */
function SavedMovieCard({ api, movie, onToast, onRefresh }: {
  api: MemoriesAPI; movie: SavedMemoryMovie; onToast: (message: string) => void; onRefresh: () => Promise<void>;
}) {
  const [viewing, setViewing] = useState(false);
  const reveal = async () => {
    const result = await api.revealSavedMemoryMovie?.(movie.path).catch(() => null);
    if (!result?.ok) onToast(result?.error || "The movie could not be shown in Finder.");
  };
  return <article className="memories-card memories-saved-movie">
    <button type="button" className="memories-cover-button" aria-label={`Watch memory: ${movie.title}`} onClick={() => setViewing(true)}>
      <span className="memories-cover memories-cover-1">
        <video src={`app-media://stream/${encodeURIComponent(movie.path)}#t=2`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" />
      </span>
      <span className="memories-view-badge"><FiPlay />Watch memory</span>
    </button>
    <div className="memories-card-body">
      <div className="memories-card-heading"><div className="memories-card-badges"><span className="memories-saved-label"><FiCheck aria-hidden="true" />Saved movie</span></div>
        <button type="button" className="memories-icon-button" aria-label={`Show ${movie.title} in Finder`} title="Show in Finder" onClick={() => { void reveal(); }}><FiFolder /></button>
      </div>
      <EditableMemoryTitle title={movie.title} onSave={async (title) => {
        if (!api.renameSavedMemoryMovie) throw new Error("Renaming saved movies is unavailable in this Silo version.");
        const result = await api.renameSavedMemoryMovie(movie.path, title);
        if (!result.ok) throw new Error(result.error || "The saved movie title could not be updated.");
        await onRefresh();
      }} />
      <div className="memories-meta"><span><FiFilm />{new Date(movie.modified).toLocaleDateString()}</span><span>{formatBytes(movie.size)}</span></div>
    </div>
    {viewing && <SavedMovieDialog movie={movie} onClose={() => setViewing(false)} />}
  </article>;
}

export default function MemoriesPage({ api, ready = true, thumbnailSize = 240, onThumbnailSizeChange, onChooseMusicFolder }: MemoriesPageProps) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [savedMovies, setSavedMovies] = useState<SavedMemoryMovie[]>([]);
  // Cards the user just retired with Generate; shown in the Memory Book until the backend lists them.
  const [retiring, setRetiring] = useState<MemorySuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState<{ memory: MemorySuggestion; options: MemoryExportOptions } | null>(null);
  const [previews, setPreviews] = useState<Record<string, MemoryPreviewStatus>>({});
  const [toast, setToast] = useState("");
  const [prompt, setPrompt] = useState("");
  const [musicAvailability, setMusicAvailability] = useState<MemoryMusicAvailability | null>(null);
  const [musicGenerationRequest, setMusicGenerationRequest] = useState<{ replace: boolean; customTopic?: string } | null>(null);
  const [checkingMusic, setCheckingMusic] = useState(false);
  const [choosingMusicFolder, setChoosingMusicFolder] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const revision = useRef(0);
  useEffect(() => { if (state?.previews) setPreviews((current) => ({ ...current, ...state.previews })); }, [state]);
  useEffect(() => api.onMemoryPreviewProgress?.((next) => setPreviews((current) => ({ ...current, ...next }))), [api]);
  useEffect(() => api.onMemoriesChanged?.((next) => { if (mounted.current && !pending.current) setState(next); }), [api]);
  const [generation, setGeneration] = useState<MemoryGenerationStatus | null>(null);
  useEffect(() => api.onMemoryGenerationProgress?.((status) => { if (mounted.current) setGeneration(status.generating ? status : null); }), [api]);
  const waiting = Boolean(state?.suggestions.some((memory) => previews[memory.id] && previews[memory.id].status !== "ready" && previews[memory.id].status !== "failed"));
  useEffect(() => {
    // Bridges without progress events still update by polling the cached state.
    if (!waiting || api.onMemoryPreviewProgress) return;
    const timer = window.setInterval(() => { void api.getMemories(false).then((next) => { if (mounted.current && next.previews) setPreviews((current) => ({ ...current, ...next.previews })); }).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [api, waiting]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const cardIds = state?.suggestions.map((memory) => memory.id).join("|") ?? "";
  const readyCount = Object.values(previews).filter((preview) => preview.status === "ready").length;
  useEffect(() => {
    if (!ready || !api.listSavedMemoryMovies) { if (action !== "Finding memories") setRetiring((current) => current.length ? [] : current); return; }
    let disposed = false;
    const settled = action !== "Finding memories";
    void api.listSavedMemoryMovies().then((movies) => {
      if (disposed || !Array.isArray(movies)) return;
      setSavedMovies(movies);
      if (settled) setRetiring([]);
    }).catch(() => { if (!disposed && settled) setRetiring([]); });
    return () => { disposed = true; };
  }, [api, ready, cardIds, readyCount, action]);
  const renderingTitle = state?.suggestions.find((memory) => previews[memory.id]?.status === "rendering")?.title;
  const blockedView = (memory: MemorySuggestion) => setToast(previews[memory.id]?.status === "failed"
    ? `“${memory.title}” could not be prepared because some of its files are offline. Reconnect them and it will be prepared next time.`
    : renderingTitle && renderingTitle !== memory.title
    ? `Please wait for “${renderingTitle}” to finish processing; “${memory.title}” is next in line.`
    : `“${memory.title}” is still being prepared. It will play as soon as it’s ready.`);
  useEffect(() => {
    mounted.current = true;
    if (!ready) { setLoading(true); return () => { mounted.current = false; }; }
    const request = ++revision.current;
    setLoading(true); setError("");
    api.getMemories(true).then((next) => { if (mounted.current && revision.current === request) setState(next); })
      .catch((cause) => { if (mounted.current && revision.current === request) setError(errorMessage(cause, "Cached memories could not be loaded.")); })
      .finally(() => { if (mounted.current && revision.current === request) setLoading(false); });
    return () => { mounted.current = false; revision.current += 1; };
  }, [api, ready]);
  useEffect(() => {
    const bridge = (window as unknown as { electron?: {
      isDemoMode?: () => Promise<boolean>;
      onLifetimeAccessChanged?: (callback: (access: { fullAccess: boolean }) => void) => () => void;
    } }).electron;
    void bridge?.isDemoMode?.().then((isDemoMode) => {
      if (mounted.current) setDemoMode(Boolean(isDemoMode));
    }).catch(() => setDemoMode(false));
    return bridge?.onLifetimeAccessChanged?.((access) => {
      if (mounted.current) setDemoMode(!access.fullAccess);
    });
  }, []);
  const run = async (label: string, operation: () => Promise<MemoryState>) => {
    if (pending.current || !ready) return;
    pending.current = true; setAction(label); setError("");
    const request = ++revision.current;
    try {
      const next = await operation();
      if (mounted.current && revision.current === request) setState(next);
    } catch (cause) {
      if (mounted.current && revision.current === request) setError(errorMessage(cause, "Memories could not be updated. Please try again."));
    } finally {
      pending.current = false;
      if (mounted.current && revision.current === request) { setAction(""); setLoading(false); }
    }
  };
  const refreshAfterDownload = async () => {
    const next = await api.getMemories(true);
    if (mounted.current) setState(next);
  };
  const refreshSavedMovies = async () => {
    if (!api.listSavedMemoryMovies) return;
    const movies = await api.listSavedMemoryMovies();
    if (mounted.current && Array.isArray(movies)) setSavedMovies(movies);
  };
  const busy = !ready || loading || Boolean(action) || Boolean(exporting);
  const finding = action === "Finding memories";
  const generating = finding || Boolean(generation?.generating || state?.generating);
  const progress = generation?.progress ?? state?.generationProgress;
  // Generate replaces the editable set, so its cards give way to placeholders; top-ups only fill open slots.
  const pendingCards = !generating ? 0 : finding ? 5 : Math.max(1, Math.min(5, generation?.expected ?? 5));
  const visibleSuggestions = finding ? [] : state?.suggestions ?? [];
  const memoryGenerationDisabled = busy || demoMode || generating || checkingMusic;
  const trimmedPrompt = prompt.trim().replace(/\s+/g, " ");
  const promptValid = trimmedPrompt.length >= 3 && trimmedPrompt.length <= 80;
  const startMemoryGeneration = async (request: { replace: boolean; customTopic?: string }) => {
    setMusicGenerationRequest(null);
    setRetiring(request.replace ? state?.suggestions ?? [] : []);
    const label = request.customTopic ? "Creating memory" : "Finding memories";
    await run(label, () => api.generateMemories(request.replace, request.customTopic));
    if (request.customTopic && mounted.current) setPrompt("");
  };
  const requestMemoryGeneration = async (request: { replace: boolean; customTopic?: string }) => {
    if (memoryGenerationDisabled || pending.current) return;
    setCheckingMusic(true);
    let availability: MemoryMusicAvailability;
    try {
      availability = await api.getMemoryMusicAvailability();
    } catch {
      availability = { available: false, scanning: false, sourceCount: 0, indexedTrackCount: 0, cacheAvailable: false };
    }
    if (!mounted.current) return;
    setCheckingMusic(false);
    if (!availability.available) {
      setMusicAvailability(availability);
      setMusicGenerationRequest(request);
      return;
    }
    await startMemoryGeneration(request);
  };
  const recheckMusicAvailability = async () => {
    if (!musicGenerationRequest || checkingMusic) return;
    setCheckingMusic(true);
    let availability: MemoryMusicAvailability;
    try {
      availability = await api.getMemoryMusicAvailability();
    } catch {
      availability = { available: false, scanning: false, sourceCount: 0, indexedTrackCount: 0, cacheAvailable: false };
    }
    if (!mounted.current) return;
    setCheckingMusic(false);
    setMusicAvailability(availability);
    if (availability.available) await startMemoryGeneration(musicGenerationRequest);
  };
  const chooseMusicFolder = async () => {
    if (!onChooseMusicFolder || choosingMusicFolder) return;
    setChoosingMusicFolder(true);
    try {
      const added = await onChooseMusicFolder();
      if (added) await recheckMusicAvailability();
    } catch (cause) {
      setError(errorMessage(cause, "The music folder could not be added."));
    } finally {
      setChoosingMusicFolder(false);
    }
  };
  const createMemory = () => {
    if (memoryGenerationDisabled || !promptValid) return;
    void requestMemoryGeneration({ replace: false, customTopic: trimmedPrompt });
  };
  const generateMemoriesTitle = demoMode ? "Demo includes 5 automatic memories from your indexed photos. Unlock Silo to generate more on demand." : memoryGenerationDisabled ? "Memory generation is unavailable while this request is in progress." : "Create 5 new editable memories. Finished ones move to your Memory Book below.";
  return <section className="memories-page" aria-label="Memories" data-retained-scroll="memories" data-help="Review local suggestions and previews. Removing suggestions changes the Silo list only. Export creates a separate movie file; original media remains unchanged.">
    <header className="memories-page-header" data-tour="memories-overview">
      <div><span className="memories-eyebrow">silo / little time capsules</span><h2>Your life, in motion<span>.</span></h2>
        <p>Small stories from your library. Made by you, kept by you.</p></div>
      <div className="memories-header-actions">
        <span className="memories-button-wrap" title={generateMemoriesTitle}>
          <button type="button" className="memories-button memories-primary" disabled={memoryGenerationDisabled} onClick={() => void requestMemoryGeneration({ replace: true })} data-help="Create 5 new editable memories. Finished ones move to your Memory Book below."><FiFilm />{checkingMusic ? "Checking music…" : action === "Finding memories" ? "Generating Memories…" : "Generate Memories"}</button>
        </span>
      </div>
    </header>
    {musicGenerationRequest && musicAvailability && <div className="memories-music-prompt-backdrop" role="presentation">
      <section className="memories-music-prompt" role="alertdialog" aria-modal="true" aria-labelledby="memories-music-prompt-title" aria-describedby="memories-music-prompt-description">
        <h2 id="memories-music-prompt-title"><FiMusic aria-hidden="true" /> Music isn’t available</h2>
        <p id="memories-music-prompt-description">
          {!musicAvailability.cacheAvailable
            ? "Silo’s music index is unavailable. Reconnect or locate the cache destination before generating a soundtrack."
            : musicAvailability.scanning
              ? "Silo is still scanning connected sources for music. Wait for the scan to finish, then check again."
              : musicAvailability.sourceCount === 0
                ? "No connected music source is available. Connect a drive or choose a folder that contains your music."
                : "No music is indexed from connected sources yet. Choose a music folder, or continue without a soundtrack."}
        </p>
        {musicAvailability.indexedTrackCount > 0 && <small>{musicAvailability.indexedTrackCount.toLocaleString()} indexed tracks are on sources Silo can currently see.</small>}
        <div className="memories-music-prompt-actions">
          <button type="button" className="memories-button memories-secondary" onClick={() => void recheckMusicAvailability()} disabled={checkingMusic || choosingMusicFolder}>
            <FiRefreshCw aria-hidden="true" /> {checkingMusic ? "Checking…" : "Check again"}
          </button>
          <button type="button" className="memories-button memories-secondary" onClick={() => void chooseMusicFolder()} disabled={!onChooseMusicFolder || choosingMusicFolder}>
            <FiFolder aria-hidden="true" /> {choosingMusicFolder ? "Choosing…" : "Choose music folder"}
          </button>
          <button type="button" className="memories-button memories-primary" onClick={() => void startMemoryGeneration(musicGenerationRequest)} disabled={checkingMusic || choosingMusicFolder}>
            Continue without music
          </button>
          <button type="button" className="memories-button memories-secondary" onClick={() => setMusicGenerationRequest(null)} disabled={checkingMusic || choosingMusicFolder}>
            Cancel
          </button>
        </div>
      </section>
    </div>}
    <form className={`memories-create${demoMode ? " is-locked" : ""}`} aria-label="Create a memory" data-help="Describe a moment and Silo makes one memory movie from your indexed photos and clips. Available with Silo Lifetime."
      onSubmit={(event) => { event.preventDefault(); createMemory(); }}>
      <div className="memories-create-copy"><h2><FiEdit3 />Create a memory</h2><span>{demoMode ? "Unlock Silo Lifetime to make a memory from your own words." : "Describe a moment. Silo makes one movie from your library."}</span></div>
      <div className="memories-create-field">
        <input type="text" value={prompt} maxLength={80} placeholder={demoMode ? "Available with Silo Lifetime" : "e.g. summer at the lake with the dog"} aria-label="Memory prompt"
          disabled={demoMode || busy || generating} onChange={(event) => setPrompt(event.target.value)} />
        <button type="submit" className="memories-button memories-primary" disabled={memoryGenerationDisabled || !promptValid}
          title={demoMode ? "Available with Silo Lifetime." : !promptValid ? "Enter 3 to 80 characters." : "Create one memory from this prompt."}>
          {demoMode ? <FiLock /> : <FiFilm />}{action === "Creating memory" ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
    <div className="memories-settings">
      <label><input type="checkbox" checked={state?.settings.showOnLaunch ?? false} disabled={busy || !state} data-help="Show the Memories page when Silo opens; it does not generate videos automatically." onChange={(event) => { const showOnLaunch = event.target.checked; void run("Saving settings", () => api.updateMemorySettings({ showOnLaunch })); }} />Show on launch</label>
      <span>Original files are always kept.</span>
    </div>
    {error && <p className="memories-error memories-page-notice" role="alert">{error}</p>}
    {!generating && (!ready || loading || action || state?.message) && <p className="memories-page-notice" role="status" aria-live="polite">
      {!ready ? "Waiting for silo to finish starting. New memories are created automatically once indexing settles." : loading ? "Preparing full-resolution memories for instant viewing…" : action === "Finding memories" ? "Finding memories and preparing them for instant viewing…" : action === "Creating memory" ? "Creating your memory…" : action || state?.message || "Memory search uses what is indexed now. Generate whenever you like."}
    </p>}
    {generating && <div className="memories-generation-progress" role="status" aria-live="polite">
      <div className="memories-generation-progress-header"><span>{progress?.label ?? "Looking for memories…"}</span><strong>{Math.round((progress?.progress ?? 0) * 100)}%</strong></div>
      <div className="memories-preparing-bar"><span style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }} /></div>
      <small>{progress?.etaSeconds !== undefined ? `About ${formatEta(progress.etaSeconds)} left` : "Estimating time…"}</small>
    </div>}
    {Boolean(visibleSuggestions.length) && <p className="memories-collection-label">{visibleSuggestions.length} {visibleSuggestions.length === 1 ? "memory" : "memories"} to edit <span>Generating again moves finished ones to your Memory Book below.</span></p>}
    <div className="memories-grid" data-tour="memory-controls" data-help="Each story card lets you preview and save its movie, remove only the suggestion, tune photos, duration and soundtrack, and choose where the saved copy goes.">
      {visibleSuggestions.map((memory) => <MemoryCard key={memory.id} api={api} memory={memory} disabled={busy || generating}
        preview={previews[memory.id]} onBlockedView={() => blockedView(memory)} onState={(next) => { if (mounted.current) setState(next); }}
        onDismiss={() => { void run("Removing suggestion", () => api.dismissMemory(memory.id)); }}
        onExport={(selected, options) => setExporting((current) => current || { memory: selected, options })}
        onToast={setToast} />)}
      {Array.from({ length: pendingCards }, (_, index) => <article key={`pending-${index}`} className="memories-card memories-card-pending" aria-busy="true" aria-label="Memory being created">
        <div className="memories-cover-placeholder"><span className="memories-spinner" aria-hidden="true" /><span>{index === 0 ? "Finding a story…" : "Waiting for a story…"}</span></div>
        <div className="memories-card-pending-body"><span /><span /></div>
      </article>)}
    </div>
    {(savedMovies.length > 0 || retiring.length > 0) && (() => {
      const listedPending = new Set(savedMovies.flatMap((movie) => movie.pending ? [movie.pending.id] : []));
      const editable = new Set(finding ? [] : (state?.suggestions ?? []).map((memory) => memory.id));
      const moving = retiring.filter((memory) => !listedPending.has(memory.id) && !editable.has(memory.id));
      const total = moving.length + savedMovies.length;
      return <section className="memories-book" aria-label="Memory Book">
        <header className="memories-book-header"><div><h2>Memory Book</h2><span>{total} {total === 1 ? "memory" : "memories"} · saved in your memories folder</span></div>
          <label className="memories-book-size"><span>Thumbnail size</span><input type="range" min={120} max={500} step={10} value={thumbnailSize} disabled={!onThumbnailSizeChange} aria-label="Memory Book thumbnail size" onChange={(event) => onThumbnailSizeChange?.(Number(event.target.value))} /><output>{thumbnailSize}px</output></label>
        </header>
        <div className="memories-grid memories-book-grid" style={{ "--memory-book-thumbnail-size": `${thumbnailSize}px` } as React.CSSProperties}>
          {moving.map((memory) => <PendingBookCard key={`moving:${memory.id}`} api={api} memory={memory} preview={previews[memory.id]} onState={setState} onRefresh={refreshSavedMovies} />)}
          {savedMovies.map((movie) => movie.pending
            ? <PendingBookCard key={`pending:${movie.pending.id}`} api={api} memory={movie.pending} preview={previews[movie.pending.id]} onState={setState} onRefresh={refreshSavedMovies} />
            : <SavedMovieCard key={movie.path} api={api} movie={movie} onToast={setToast} onRefresh={refreshSavedMovies} />)}
        </div>
      </section>;
    })()}
    {toast && <p className="memories-toast" role="status" aria-live="assertive">{toast}</p>}
    {ready && !loading && !generating && !state?.suggestions.length && !savedMovies.length && <div className="memories-empty"><div className="memories-empty-orbit"><FiFilm /></div>
      <h2>A little nostalgia goes a long way.</h2>
    </div>}
    {exporting && <ExportDialog api={api} memory={exporting.memory} options={exporting.options} onClose={() => setExporting(null)} onDownloaded={refreshAfterDownload} />}
  </section>;
}
