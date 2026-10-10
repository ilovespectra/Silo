import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IconBaseProps } from "react-icons";
import { FiArrowRight as ArrowRight, FiCheck as Check, FiChevronRight as ChevronRight, FiDownload as Download, FiFilm as Film, FiFolder as Folder, FiImage as Image, FiMusic as Music, FiPause as Pause, FiPlay as Play, FiRefreshCw as RefreshCw, FiSearch as Search, FiTrash2 as Trash2, FiX as X } from "react-icons/fi";
import type { MemoriesAPI, MemoryAudioBrowseFile, MemoryAudioBrowseResult, MemoryAudioSort, MemoryExportOptions, MemoryExportProgress, MemoryPreviewStatus, MemoryState, MemorySuggestion, MemorySoundtrack } from "../memoryTypes";
import {
  MEMORY_DEFAULT_SELECTION_COUNT,
  MEMORY_DURATION_SECONDS,
  MEMORY_EXPORT_LIMITS,
} from "../memoryTypes";
import "../styles/Memories.css";

// react-icons uses the newer ReactNode component signature; this project uses TS 4.9.
export const MemoryIcons = {
  FiArrowRight: ArrowRight, FiCheck: Check, FiChevronRight: ChevronRight, FiDownload: Download, FiFilm: Film, FiFolder: Folder,
  FiImage: Image, FiMusic: Music, FiPause: Pause, FiPlay: Play, FiRefreshCw: RefreshCw, FiSearch: Search, FiTrash2: Trash2, FiX: X,
} as unknown as Record<"FiArrowRight" | "FiCheck" | "FiChevronRight" | "FiDownload" | "FiFilm" | "FiFolder" | "FiImage" | "FiMusic" | "FiPause" | "FiPlay" | "FiRefreshCw" | "FiSearch" | "FiTrash2" | "FiX", React.FC<IconBaseProps>>;
const { FiArrowRight, FiCheck, FiChevronRight, FiDownload, FiFilm, FiFolder, FiImage, FiMusic, FiPause, FiPlay, FiRefreshCw, FiSearch, FiTrash2, FiX } = MemoryIcons;

export interface MemoriesPageProps {
  api: MemoriesAPI;
  ready?: boolean;
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
function MemoryVideoPlayer({ src, label, autoPlay = false }: {
  src: string; label: string; autoPlay?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
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
  return <div className="memories-video-player">
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
      onEnded={() => setPlaying(false)}
    />
    <div className="memories-playback-controls">
      <button type="button" className="memories-playback-toggle" onClick={() => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play().catch(() => setPlaying(false));
        else video.pause();
      }}>{playing ? "Pause" : "Play"}</button>
      <output aria-live="off" className="memories-playback-time">{formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}</output>
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
      {moviePath && <MemoryVideoPlayer src={`app-media://stream/${encodeURIComponent(moviePath)}`} autoPlay label={`Memory movie: ${memory.title}`} />}
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
      {moviePath && <MemoryVideoPlayer src={`app-media://stream/${encodeURIComponent(moviePath)}`} label={`Exported movie: ${memory.title}`} />}
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
    <span className="memories-spinner" aria-hidden="true" />
    {preview.status === "rendering" ? <>
      <strong>Preparing memory… {percent}%</strong>
      <span className="memories-preparing-bar"><span style={{ width: `${percent}%` }} /></span>
      <small>{preview.etaSeconds ? `About ${formatEta(preview.etaSeconds)} left` : "Estimating time…"}</small>
    </> : <>
      <strong>Waiting to prepare</strong>
      <small>Memories are prepared one at a time.</small>
    </>}
  </span>;
}

function MemoryCard({ api, memory, disabled, preview, onBlockedView, onDismiss, onExport, onState }: {
  api: MemoriesAPI; memory: MemorySuggestion; disabled: boolean; preview?: MemoryPreviewStatus;
  onBlockedView: () => void; onDismiss: () => void;
  onExport: (memory: MemorySuggestion, options: MemoryExportOptions) => void;
  onState?: (state: MemoryState) => void;
}) {
  const playable = !preview || preview.status === "ready";
  const maximum = Math.min(MEMORY_EXPORT_LIMITS.maxCount, memory.media.length);
  const minimum = Math.min(MEMORY_DEFAULT_SELECTION_COUNT, maximum);
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
  const loadTracks = (): Promise<MemorySoundtrack[] | null> => {
    if (trackStatus === "loaded") return Promise.resolve(tracks);
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
      <h2>{memory.title}</h2><p className="memories-description">{memory.description}</p>
      <div className="memories-meta"><span><FiImage />{photos} photos</span><span><FiFilm />{clips} clips</span><span>Landscape · 16:9</span></div>
      <details className="memories-settings-dropdown">
        <summary>Edit movie settings <span>{selectedCount} files · 1 min</span></summary>
      <div className="memories-card-controls">
        <label htmlFor={`${fieldId}-count`}>Photos & clips <output>{selectedCount} / {memory.media.length} · {(MEMORY_DURATION_SECONDS / Math.max(1, selectedCount)).toFixed(1)}s each</output></label>
        <input id={`${fieldId}-count`} type="range" min={minimum} max={maximum} step={1} value={selectedCount} disabled={disabled || maximum <= minimum} onChange={(event) => changeCount(Number(event.target.value))} />
        {maximum < MEMORY_DEFAULT_SELECTION_COUNT && <small className="memories-hint">Uses all {maximum} available items rather than repeating shots.</small>}
        <div className="memories-fixed-length"><span>Movie length</span><output>1 minute · {MEMORY_DURATION_SECONDS} seconds</output></div>
        <label htmlFor={`${fieldId}-soundtrack`}><span><FiMusic aria-hidden="true" />Soundtrack · {memory.mood}</span></label>
        <select id={`${fieldId}-soundtrack`} value={selectedTrack.id} disabled={disabled || trackStatus === "loading"} onFocus={() => { void loadTracks(); }} onChange={(event) => { const next = availableTracks.find((track) => track.id === event.target.value); if (next) void chooseTrack(next); }}>
          {availableTracks.map((track) => <option key={track.id} value={track.id}>{track.name}{track.source === "original" ? " · original" : " · library"}</option>)}
        </select>
        {trackStatus !== "loaded" && <button type="button" className="memories-text-button" disabled={disabled || trackStatus === "loading"} onClick={() => { void loadTracks(); }}>{trackStatus === "loading" ? "Finding soundtracks…" : trackStatus === "error" ? "Retry soundtracks" : "Browse mood soundtracks"}</button>}
        {api.browseMemoryAudio && <button type="button" className="memories-text-button" disabled={disabled} onClick={() => setBrowsing(true)}><FiFolder aria-hidden="true" />Browse your audio library…</button>}
        {trackError && <p className="memories-error" role="alert">{trackError}</p>}
        {selectedTrack.source === "library" && <p className="memories-hint memories-rights">
          Song from your library. For personal viewing only — don’t share or upload this movie; the music is copyrighted.
        </p>}
        <label htmlFor={`${fieldId}-audio`}>Original clip audio <output>{Math.round(originalAudio * 100)}%</output></label>
        <input id={`${fieldId}-audio`} type="range" min={0} max={0.6} step={0.01} value={originalAudio} disabled={disabled} onChange={(event) => setOriginalAudio(Number(event.target.value))} />
      </div>
      </details>
      <button type="button" className="memories-button memories-primary memories-export-button" disabled={disabled || trackStatus === "loading" || maximum === 0} onClick={() => { void prepareExport(); }}><FiDownload aria-hidden="true" />Save memory<FiArrowRight aria-hidden="true" /></button>
    </div>
    {viewing && <MemoryViewDialog api={api} memory={memory} onClose={() => setViewing(false)} />}
    {browsing && <AudioBrowserDialog api={api} title={`Choose a song · ${memory.title}`} onClose={() => setBrowsing(false)} onPick={(file) => { void pickBrowsed(file); }} />}
  </article>;
}

export default function MemoriesPage({ api, ready = true }: MemoriesPageProps) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [customTopic, setCustomTopic] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [clearConfirm, setClearConfirm] = useState(false);
  const [exporting, setExporting] = useState<{ memory: MemorySuggestion; options: MemoryExportOptions } | null>(null);
  const [previews, setPreviews] = useState<Record<string, MemoryPreviewStatus>>({});
  const [toast, setToast] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const revision = useRef(0);
  useEffect(() => { if (state?.previews) setPreviews((current) => ({ ...current, ...state.previews })); }, [state]);
  useEffect(() => api.onMemoryPreviewProgress?.((next) => setPreviews((current) => ({ ...current, ...next }))), [api]);
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
  const renderingTitle = state?.suggestions.find((memory) => previews[memory.id]?.status === "rendering")?.title;
  const blockedView = (memory: MemorySuggestion) => setToast(renderingTitle && renderingTitle !== memory.title
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
  const clear = async () => {
    setClearConfirm(false);
    await run("Clearing suggestions", async () => {
      try {
        for (const memory of state?.suggestions || []) await api.dismissMemory(memory.id);
        return await api.getMemories();
      } catch (cause) {
        // Reconcile partial removals without hiding the original error.
        try { const next = await api.getMemories(); if (mounted.current) setState(next); } catch { /* Keep the last known cache. */ }
        throw cause;
      }
    });
  };
  const busy = !ready || loading || Boolean(action) || Boolean(exporting);
  return <section className="memories-page" aria-label="Memories" data-help="READ ONLY: Review local suggestions and previews. SILO DATA WRITE: Removing suggestions changes the Silo list only. DESTINATION WRITE: Export creates a separate movie file; original media remains unchanged.">
    <header className="memories-page-header" data-tour="memories-overview">
      <div><span className="memories-eyebrow">silo / little time capsules</span><h1>Your life, in motion<span>.</span></h1>
        <p>Small stories from your library. Made by you, kept by you.</p></div>
      <div className="memories-header-actions">
        <button type="button" className="memories-button" disabled={busy} onClick={() => { void run("Refreshing memories", () => api.getMemories(true)); }} data-help="Reload the available memory suggestions and their preview status."><FiRefreshCw />Refresh</button>
        <button type="button" className="memories-button memories-primary" disabled={busy || state?.generating} onClick={() => { void run("Finding memories", () => api.generateMemories(true)); }} data-help="Search indexed local photos and clips for new memory stories. This runs only when you choose it."><FiFilm />{action === "Finding memories" ? "Finding memories…" : state?.suggestions.length ? "Find new memories" : "Generate memories"}</button>
      </div>
    </header>
    <aside className="memories-local-discovery" aria-label="Local semantic discovery">
      <FiSearch aria-hidden="true" />
      <div><strong>Local semantic discovery</strong>
        <p>Automatic themes use Silo’s local concepts; a phrase you enter below searches indexed photos directly on this device. No subscription or online AI is used.</p>
      </div>
    </aside>
    <form className="memories-topic-form" aria-label="Suggest a topic" data-tour="memory-topic" onSubmit={(event) => {
      event.preventDefault();
      const query = customTopic.replace(/\s+/g, " ").trim();
      if (query.length < 3) return;
      void run("Finding your topic", async () => {
        const next = await api.generateMemories(false, query);
        if (mounted.current && next.message.startsWith("Created a memory for")) setCustomTopic("");
        return next;
      });
    }}>
      <div className="memories-topic-copy">
        <strong>Suggest a topic</strong>
        <p>Describe a place, a kind of day, or a mood—like “Rainy Sundays.”</p>
      </div>
      <div className="memories-topic-controls">
        <label className="memories-topic-input">
          <FiSearch aria-hidden="true" />
          <input aria-label="Describe a memory topic" type="text" value={customTopic} maxLength={120} minLength={3} required
            placeholder="Sunny days at the beach…" disabled={busy}
            onChange={(event) => setCustomTopic(event.target.value)} />
        </label>
        <button type="submit" className="memories-button memories-primary" disabled={busy || customTopic.trim().length < 3}
          data-help="Search your indexed photos for a phrase you choose, then create a memory with a locally selected soundtrack.">
          <FiFilm aria-hidden="true" />{action === "Finding your topic" ? "Finding…" : "Create memory"}
        </button>
      </div>
    </form>
    <div className="memories-settings">
      <label><input type="checkbox" checked={state?.settings.showOnLaunch ?? false} disabled={busy || !state} data-help="Show the Memories page when Silo opens; it does not generate videos automatically." onChange={(event) => { const showOnLaunch = event.target.checked; void run("Saving settings", () => api.updateMemorySettings({ showOnLaunch })); }} />Show on launch</label>
      <span>Original files are always kept.</span>
      <button type="button" className="memories-text-button" disabled={busy || state?.generating || !state?.suggestions.length} onClick={() => setClearConfirm(true)} data-help="SILO DATA WRITE: Remove all suggestion cards after confirmation. Original photos, clips, and already-saved movies are kept."><FiTrash2 />Clear suggestions</button>
    </div>
    {error && <p className="memories-error memories-page-notice" role="alert">{error}</p>}
    {(!ready || loading || action || state?.generating || state?.message) && <p className="memories-page-notice" role="status" aria-live="polite">
      {!ready ? "Waiting for silo to finish starting. No memories are generated at startup." : loading ? "Preparing full-resolution memories for instant viewing…" : action === "Finding memories" ? "Finding memories and preparing them for instant viewing…" : action || state?.message || "Memory search uses what is indexed now. Generate whenever you like."}
    </p>}
    {state?.generating && <p className="memories-hint">This uses photos and clips already indexed. Anything indexed later will be available the next time you generate.</p>}
    {Boolean(state?.suggestions.length) && <p className="memories-collection-label">{state?.suggestions.length} stories to rediscover <span>New suggestions replace this collection.</span></p>}
    <div className="memories-grid" data-tour="memory-controls" data-help="Each story card lets you preview and save its movie, remove only the suggestion, tune photos, duration and soundtrack, and choose where the saved copy goes.">
      {state?.suggestions.filter((memory) => previews[memory.id]?.status !== "failed").map((memory) => <MemoryCard key={memory.id} api={api} memory={memory} disabled={busy || state.generating}
        preview={previews[memory.id]} onBlockedView={() => blockedView(memory)} onState={(next) => { if (mounted.current) setState(next); }}
        onDismiss={() => { void run("Removing suggestion", () => api.dismissMemory(memory.id)); }}
        onExport={(selected, options) => setExporting((current) => current || { memory: selected, options })} />)}
    </div>
    {toast && <p className="memories-toast" role="status" aria-live="assertive">{toast}</p>}
    {ready && !loading && !state?.suggestions.length && <div className="memories-empty"><div className="memories-empty-orbit"><FiFilm /></div>
      <h2>A little nostalgia goes a long way.</h2><p>Find themed stories in your indexed photos and clips, then choose the mood, frame and length of your movie.</p>
      <p className="memories-hint">Nothing runs until you choose Generate memories. It uses what is indexed now, even while indexing continues. Each movie is then prepared in the background, one at a time, with progress shown on its card.</p>
    </div>}
    {clearConfirm && <MemoriesDialog title="Clear these suggestions?" onClose={() => setClearConfirm(false)}><div className="memories-modal-body">
      <p>This removes the memory cards, not your original files or saved movies.</p><div className="memories-modal-actions"><button type="button" className="memories-button" onClick={() => setClearConfirm(false)}>Keep memories</button><button type="button" className="memories-button memories-primary" onClick={() => { void clear(); }}>Clear suggestions</button></div>
    </div></MemoriesDialog>}
    {exporting && <ExportDialog api={api} memory={exporting.memory} options={exporting.options} onClose={() => setExporting(null)} onDownloaded={refreshAfterDownload} />}
  </section>;
}
