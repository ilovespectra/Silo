import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FiFastForward,
  FiHeart,
  FiPause,
  FiPlay,
  FiRefreshCw,
  FiRewind,
  FiSkipBack,
  FiSkipForward,
  FiVolume2,
  FiVolumeX,
} from "react-icons/fi";
import { audioExtension } from "../utils/audioTypes";
import { AudioSort, compareAudioFiles } from "../utils/audioSort";
import { loadAudioInventory, readInventory } from "../utils/readInventory";

interface AudioFile {
  name: string;
  path: string;
  size: number;
  modified: number;
  isDirectory: boolean;
  type: string;
  extension: string;
  sourceLabel?: string;
}

interface AudioPreview {
  mediaUrl?: string;
  mimeType?: string | null;
}

interface AudioLibraryProps {
  electronAPI: NonNullable<Window["electron"]>;
  visible: boolean;
  exploded: boolean;
  yearFilter: string;
  sort: AudioSort;
  favoritePaths: Set<string>;
  onAudioYearsChange: (years: string[]) => void;
  onToggleFavorite: (filePath: string) => void;
}

interface AudioScanProgress {
  scanned: number;
  audioFound: number;
  source: string;
  sourceIndex: number;
  sourceCount: number;
}

interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

const PLAYER_VOLUME_KEY = "silo.audioPlayer.volume";
const EQ_BANDS = 24;
const AUDIO_TRACK_HEIGHT = 64;
const AUDIO_HEADER_HEIGHT = 48;
const AUDIO_OVERSCAN = 10;
const AUDIO_MAX_ROWS = 100;
const AUDIO_MAX_VIEWPORT = 3600;
// Stay below Chromium's layout-height limit even with millions of tracks.
const AUDIO_MAX_SCROLL_HEIGHT = 8_000_000;

function buildAudioRows(
  groups: [string, AudioFile[]][],
  exploded: boolean,
  expanded: Set<string>,
) {
  let count = 0;
  let height = 0;
  const spans = groups
    .map(([year, tracks]) => {
      const header = !exploded;
      const trackCount = exploded || expanded.has(year) ? tracks.length : 0;
      const span = {
        year,
        tracks,
        header,
        start: count,
        offset: height,
        count: trackCount + Number(header),
      };
      count += span.count;
      height +=
        Number(header) * AUDIO_HEADER_HEIGHT + trackCount * AUDIO_TRACK_HEIGHT;
      return span;
    })
    .filter((span) => span.count > 0);
  return { spans, count, height };
}

function audioRowAt(model: ReturnType<typeof buildAudioRows>, index: number) {
  let low = 0;
  let high = model.spans.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (model.spans[middle].start <= index) low = middle;
    else high = middle - 1;
  }
  const span = model.spans[low];
  const local = index - span.start;
  const header = span.header && local === 0;
  const offset =
    span.offset +
    (header
      ? 0
      : Number(span.header) * AUDIO_HEADER_HEIGHT +
        (local - Number(span.header)) * AUDIO_TRACK_HEIGHT);
  return {
    year: span.year,
    total: span.tracks.length,
    file: header ? null : span.tracks[local - Number(span.header)],
    offset,
    height: header ? AUDIO_HEADER_HEIGHT : AUDIO_TRACK_HEIGHT,
    index,
  };
}

function audioRenderWindow(
  model: ReturnType<typeof buildAudioRows>,
  scrollTop: number,
  viewportHeight: number,
) {
  const viewport = Math.max(0, Math.min(AUDIO_MAX_VIEWPORT, viewportHeight));
  const physicalHeight = Math.min(model.height, AUDIO_MAX_SCROLL_HEIGHT);
  const physicalMax = Math.max(0, physicalHeight - viewport);
  const physicalTop = Math.max(0, Math.min(physicalMax, scrollTop));
  const logicalTop = physicalMax
    ? (physicalTop / physicalMax) * Math.max(0, model.height - viewport)
    : 0;
  if (!model.count) return { rows: [], top: 0, bottom: 0, physicalHeight };
  const indexAt = (offset: number) => {
    let low = 0;
    let high = model.count - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (audioRowAt(model, middle).offset <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const start = Math.max(0, indexAt(logicalTop) - AUDIO_OVERSCAN);
  const end = Math.min(
    model.count,
    indexAt(logicalTop + viewport) + 1 + AUDIO_OVERSCAN,
    start + AUDIO_MAX_ROWS,
  );
  const rows = Array.from({ length: end - start }, (_, index) =>
    audioRowAt(model, start + index),
  );
  const top = physicalTop + rows[0].offset - logicalTop;
  const renderedHeight = rows.reduce((total, row) => total + row.height, 0);
  return {
    rows,
    top,
    bottom: Math.max(0, physicalHeight - top - renderedHeight),
    physicalHeight,
  };
}

const AudioTrackRow = React.memo(function AudioTrackRow({
  file,
  active,
  playing,
  favorite,
  onPlay,
  onFavorite,
}: {
  file: AudioFile;
  active: boolean;
  playing: boolean;
  favorite: boolean;
  onPlay: (file: AudioFile) => void;
  onFavorite: (path: string) => void;
}) {
  return (
    <div className={`audio-track ${active ? "active" : ""}`}>
      <button className="audio-track-open" onClick={() => onPlay(file)}>
        <span className="audio-track-glyph">♫</span>
        <span className="audio-track-copy">
          <strong>{file.name}</strong>
          <small>
            {new Date(file.modified).toLocaleDateString()} · {sizeOf(file.size)}
          </small>
        </span>
        {active && playing ? <FiPause /> : <FiPlay />}
      </button>
      <button
        className={`audio-track-favorite ${favorite ? "active" : ""}`}
        title={favorite ? "Remove from Favorites" : "Add to Favorites"}
        aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"}
        onClick={() => onFavorite(file.path)}
      >
        <FiHeart />
      </button>
    </div>
  );
});

function audioRecoveryMessage(snapshot: AudioLibraryCacheSnapshot) {
  if (
    Object.values(snapshot.sourceErrors ?? {}).some((error) =>
      error.message.startsWith("DRIVE_PERMISSION_REQUIRED:"),
    )
  )
    return "A Google account needs Drive permission. Reconnect it under Google Accounts and approve Drive access to finish scanning.";
  return snapshot.failedSources?.length
    ? `${snapshot.failedSources.length} source(s) awaiting automatic recovery. Discovered tracks remain available.`
    : "";
}

function yearOf(file: AudioFile) {
  return Number.isFinite(file.modified) && file.modified > 0
    ? String(new Date(file.modified).getFullYear())
    : "Unknown year";
}

function timeOf(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60);
  return `${minutes}:${Math.floor(value % 60)
    .toString()
    .padStart(2, "0")}`;
}

function sizeOf(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(1)} ${units[index]}`;
}

export default function AudioLibrary({
  electronAPI,
  visible,
  exploded,
  yearFilter,
  sort,
  favoritePaths,
  onAudioYearsChange,
  onToggleFavorite,
}: AudioLibraryProps) {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<AudioScanProgress>({
    scanned: 0,
    audioFound: 0,
    source: "",
    sourceIndex: 0,
    sourceCount: 0,
  });
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [error, setError] = useState("");
  const [expandedYears, setExpandedYears] = useState<Set<string>>(
    () => new Set(),
  );
  const [formatFilterOpen, setFormatFilterOpen] = useState(false);
  const formatFilterRef = useRef<HTMLDivElement>(null);
  const [selectedExtensions, setSelectedExtensions] =
    useState<Set<string> | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<AudioPreview | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekDraft, setSeekDraft] = useState(0);
  const visualBarsRef = useRef<(HTMLElement | null)[]>([]);
  const trackListRef = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [volume, setVolume] = useState(() => {
    const saved = Number(localStorage.getItem(PLAYER_VOLUME_KEY));
    return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0.8;
  });
  const [audioOutputs, setAudioOutputs] = useState<AudioOutputDevice[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState(
    () => localStorage.getItem("silo.audioPlayer.outputDevice") || "",
  );
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const seekDraftRef = useRef(0);
  const seekingRef = useRef(false);
  const visualFrameRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!visible || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refreshOutputs = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const outputs = devices
          .filter(
            (device) =>
              device.kind === "audiooutput" &&
              device.deviceId &&
              device.deviceId !== "default",
          )
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Audio output ${index + 1}`,
          }));
        setAudioOutputs(outputs);
        if (
          outputDeviceId &&
          !outputs.some((device) => device.deviceId === outputDeviceId)
        ) {
          setOutputDeviceId("");
          localStorage.removeItem("silo.audioPlayer.outputDevice");
        }
      } catch {
        if (!cancelled) setAudioOutputs([]);
      }
    };
    void refreshOutputs();
    navigator.mediaDevices.addEventListener?.("devicechange", refreshOutputs);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.(
        "devicechange",
        refreshOutputs,
      );
    };
  }, [outputDeviceId, visible]);
  const audioFormats = useMemo(
    () =>
      Array.from(
        new Set(
          files.map((file) => audioExtension(file.name) || "(no extension)"),
        ),
      ).sort((first, second) => first.localeCompare(second)),
    [files],
  );
  const audioYearOptions = useMemo(
    () =>
      Array.from(new Set(files.map(yearOf))).sort((first, second) =>
        first === "Unknown year"
          ? 1
          : second === "Unknown year"
            ? -1
            : Number(second) - Number(first),
      ),
    [files],
  );
  const filteredFiles = useMemo(
    () =>
      files
        .filter(
          (file) =>
            (yearFilter === "all" || yearOf(file) === yearFilter) &&
            (selectedExtensions === null ||
              selectedExtensions.has(
                audioExtension(file.name) || "(no extension)",
              )),
        )
        .sort((first, second) => compareAudioFiles(first, second, sort)),
    [files, selectedExtensions, yearFilter, sort.field, sort.ascending],
  );
  const byYear = useMemo(() => {
    const grouped = new Map<string, AudioFile[]>();
    filteredFiles.forEach((file) => {
      const year = yearOf(file);
      const group = grouped.get(year) ?? [];
      group.push(file);
      grouped.set(year, group);
    });
    return Array.from(grouped.entries()).sort(([first], [second]) =>
      first === "Unknown year"
        ? 1
        : second === "Unknown year"
          ? -1
          : (Number(first) - Number(second)) *
            (sort.field === "modified" && sort.ascending ? 1 : -1),
    );
  }, [filteredFiles, sort.field, sort.ascending]);
  const rowModel = useMemo(
    () =>
      buildAudioRows(
        exploded ? [["all", filteredFiles]] : byYear,
        exploded,
        expandedYears,
      ),
    [exploded, filteredFiles, byYear, expandedYears],
  );
  const renderWindow = useMemo(
    () => audioRenderWindow(rowModel, viewport.top, viewport.height),
    [rowModel, viewport.top, viewport.height],
  );
  const orderedFiles = useMemo(
    () => (exploded ? filteredFiles : byYear.flatMap(([, entries]) => entries)),
    [exploded, filteredFiles, byYear],
  );
  const activeFile = useMemo(
    () => files.find((file) => file.path === activePath) ?? null,
    [files, activePath],
  );
  const activeIndex = useMemo(
    () => orderedFiles.findIndex((file) => file.path === activePath),
    [orderedFiles, activePath],
  );

  useLayoutEffect(() => {
    const list = trackListRef.current;
    if (!list) return;
    const measure = () =>
      setViewport((current) => {
        const next = {
          top: list.scrollTop,
          height: Math.min(AUDIO_MAX_VIEWPORT, list.clientHeight),
        };
        return current.top === next.top && current.height === next.height
          ? current
          : next;
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // Filters/order changes reset the viewport; collapsing groups clamps a stale scroll position.
  useLayoutEffect(() => {
    const list = trackListRef.current;
    if (!list) return;
    list.scrollTop = 0;
    setViewport((current) =>
      current.top === 0 ? current : { ...current, top: 0 },
    );
  }, [exploded, yearFilter, selectedExtensions, sort.field, sort.ascending]);
  useLayoutEffect(() => {
    const list = trackListRef.current;
    if (!list) return;
    const top = Math.min(
      list.scrollTop,
      Math.max(
        0,
        Math.min(rowModel.height, AUDIO_MAX_SCROLL_HEIGHT) - list.clientHeight,
      ),
    );
    list.scrollTop = top;
    setViewport((current) =>
      current.top === top ? current : { ...current, top },
    );
  }, [rowModel]);

  const toggleYear = useCallback(
    (year: string) =>
      setExpandedYears((current) => {
        const next = new Set(current);
        if (next.has(year)) next.delete(year);
        else next.add(year);
        return next;
      }),
    [],
  );

  useEffect(() => {
    onAudioYearsChange(audioYearOptions);
  }, [audioYearOptions, onAudioYearsChange]);

  useEffect(() => {
    if (!formatFilterOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!formatFilterRef.current?.contains(event.target as Node))
        setFormatFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFormatFilterOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [formatFilterOpen]);
  const toggleAudioFormat = (format: string, checked: boolean) => {
    setSelectedExtensions((current) => {
      const next = new Set(current ?? audioFormats);
      if (checked) next.add(format);
      else next.delete(format);
      return next.size === audioFormats.length ? null : next;
    });
  };

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const reloadInventory = () => {
      void loadAudioInventory(electronAPI)
        .then((snapshot) => {
          if (!active) return;
          setFiles(
            snapshot.files.filter(
              (file) => !file.isDirectory && file.type === "audio",
            ),
          );
          setLoading(false);
          setError(audioRecoveryMessage(snapshot));
        })
        .catch(() => undefined);
    };
    const remove = electronAPI.onAudioLibraryCacheChanged?.(reloadInventory);
    return () => {
      active = false;
      remove?.();
    };
  }, [electronAPI, visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const requestId = ++requestRef.current;
    const removeProgressListener = electronAPI.onAudioLibraryScanProgress(
      (progress) => {
        if (
          cancelled ||
          (progress.requestId !== requestId && progress.requestId !== -1)
        )
          return;
        setLoading(
          progress.phase === "scanning" || progress.phase === "retrying",
        );
        setScanProgress({
          scanned: progress.scanned,
          audioFound: progress.audioFound,
          source: progress.message,
          sourceIndex: progress.sourceIndex,
          sourceCount: progress.sourceCount,
        });
      },
    );
    setError("");
    setScanProgress({
      scanned: 0,
      audioFound: 0,
      source: "",
      sourceIndex: 0,
      sourceCount: 0,
    });
    void loadAudioInventory(electronAPI)
      .then((snapshot) => {
        if (cancelled) return;
        const cachedFiles = snapshot.files.filter(
          (file) => !file.isDirectory && file.type === "audio",
        );
        setFiles(cachedFiles);
        setSelectedExtensions((current) =>
          current === null
            ? null
            : new Set(
                Array.from(current).filter((extension) =>
                  snapshot.extensions.includes(extension),
                ),
              ),
        );
        if (!snapshot.stale && refreshRequest === 0) {
          setLoading(false);
          setScanProgress({
            scanned: cachedFiles.length,
            audioFound: cachedFiles.length,
            source: "",
            sourceIndex: snapshot.sourceIds.length,
            sourceCount: snapshot.sourceIds.length,
          });
          return false;
        }
        return true;
      })
      .catch(() => true)
      .then(async (shouldRefresh) => {
        if (cancelled) return;
        if (!shouldRefresh) return;
        setLoading(true);
        try {
          const result = await electronAPI.refreshAudioLibraryCache(
            requestId,
            refreshRequest > 0,
          );
          if (cancelled) return;
          if (!result.ok || !result.snapshot)
            throw new Error(
              result.error || "Could not refresh the audio library.",
            );
          const audioFiles = (
            await readInventory<AudioFile>(
              electronAPI,
              result.snapshot.files,
              () => cancelled,
            )
          ).filter((file) => !file.isDirectory && file.type === "audio");
          setFiles(audioFiles);
          setSelectedExtensions((current) => {
            if (current === null) return null;
            return new Set(
              Array.from(current).filter((extension) =>
                result.snapshot!.extensions.includes(extension),
              ),
            );
          });
          setError(audioRecoveryMessage({ ...result.snapshot, files: [] }));
          setScanProgress((current) => ({
            ...current,
            audioFound: audioFiles.length,
            scanned: current.scanned,
            source: "",
            sourceIndex: current.sourceCount,
          }));
        } catch (cause) {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not refresh the audio library.",
            );
        } finally {
          if (!cancelled) setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      removeProgressListener();
    };
  }, [electronAPI, refreshRequest, visible]);

  useEffect(() => {
    if (activePath)
      localStorage.setItem("silo.audioPlayer.lastPath", activePath);
  }, [activePath]);

  const applyOutputDevice = async (deviceId: string) => {
    const context = audioContextRef.current as
      | (AudioContext & { setSinkId?: (id: string) => Promise<void> })
      | null;
    const audio = audioRef.current as
      | (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
      | null;
    if (context?.setSinkId) await context.setSinkId(deviceId);
    else if (audio?.setSinkId) await audio.setSinkId(deviceId);
    else if (deviceId)
      throw new Error(
        "Selecting output devices is not supported by this runtime.",
      );
  };

  const ensureAudioGraph = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      let context = audioContextRef.current;
      if (!context) {
        context = new AudioContext();
        const source = context.createMediaElementSource(audio);
        const analyser = context.createAnalyser();
        const gain = context.createGain();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0.78;
        gain.gain.value = volume;
        source.connect(analyser);
        analyser.connect(gain);
        gain.connect(context.destination);
        audioContextRef.current = context;
        sourceRef.current = source;
        analyserRef.current = analyser;
        gainRef.current = gain;
        audio.volume = 1;
      }
      if (context.state === "suspended") await context.resume();
      await applyOutputDevice(outputDeviceId);
    } catch (cause) {
      // If Web Audio is blocked, keep native audio playback available.
      if (audioContextRef.current?.state === "closed")
        audioContextRef.current = null;
      audio.volume = volume;
      if (cause instanceof Error)
        setError(`Audio output setup failed: ${cause.message}`);
      else setError("Audio output setup failed.");
    }
  };

  const playFile = async (file: AudioFile) => {
    audioRef.current?.pause();
    setPreview(null);
    setActivePath(file.path);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setError("");
    // Resume audio in the click's user-activation window before awaiting IPC.
    void ensureAudioGraph();
    const filePreview = await electronAPI.getFilePreview(file.path);
    if (!filePreview?.mediaUrl) {
      setError(
        "Could not open this audio stream. Check the source connection and file format.",
      );
      return;
    }
    setPreview(filePreview);
  };

  // Stable row callbacks, with current player/output settings rather than stale closures.
  const rowActionsRef = useRef({ playFile, onToggleFavorite });
  rowActionsRef.current = { playFile, onToggleFavorite };
  const playRow = useCallback((file: AudioFile) => {
    void rowActionsRef.current.playFile(file);
  }, []);
  const favoriteRow = useCallback(
    (path: string) => rowActionsRef.current.onToggleFavorite(path),
    [],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !preview?.mediaUrl) return;
    // The graph was primed by the track click; start the media immediately rather than
    // waiting on output-device promises that can consume the browser's user activation.
    void ensureAudioGraph();
    void audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
  }, [preview]);

  useEffect(() => {
    if (gainRef.current)
      gainRef.current.gain.setTargetAtTime(
        volume,
        audioContextRef.current?.currentTime ?? 0,
        0.025,
      );
    else if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const analyser = analyserRef.current;
    if (!playing || !visible || !analyser) {
      if (visualFrameRef.current !== null)
        cancelAnimationFrame(visualFrameRef.current);
      visualFrameRef.current = null;
      return;
    }
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    let lastFrame = -Infinity;
    const renderSpectrum = (timestamp: number) => {
      if (timestamp - lastFrame >= 50) {
        lastFrame = timestamp;
        analyser.getByteFrequencyData(spectrum);
        for (let band = 0; band < EQ_BANDS; band += 1) {
          const start = Math.floor(Math.pow(spectrum.length, band / EQ_BANDS));
          const end = Math.max(
            start + 1,
            Math.floor(Math.pow(spectrum.length, (band + 1) / EQ_BANDS)),
          );
          let total = 0;
          for (let bin = start; bin < end && bin < spectrum.length; bin += 1)
            total += spectrum[bin];
          const average =
            total / Math.max(1, Math.min(end, spectrum.length) - start);
          const height = Math.max(4, Math.round((average / 255) * 112));
          visualBarsRef.current[band]?.style.setProperty(
            "--bar-height",
            `${height}px`,
          );
        }
      }
      visualFrameRef.current = requestAnimationFrame(renderSpectrum);
    };
    visualFrameRef.current = requestAnimationFrame(renderSpectrum);
    return () => {
      if (visualFrameRef.current !== null)
        cancelAnimationFrame(visualFrameRef.current);
      visualFrameRef.current = null;
    };
  }, [playing, visible]);

  useEffect(
    () => () => {
      if (visualFrameRef.current !== null)
        cancelAnimationFrame(visualFrameRef.current);
      void audioContextRef.current?.close();
    },
    [],
  );

  const stepTrack = (direction: number) => {
    if (!activeFile) return;
    const next = orderedFiles[activeIndex + direction];
    if (next) void playFile(next);
  };
  const skipTracks = (direction: number) => {
    if (!activeFile) return;
    const next = orderedFiles[activeIndex + direction];
    if (next) void playFile(next);
  };
  const seekBy = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(duration)) return;
    const next = Math.max(0, Math.min(duration, audio.currentTime + seconds));
    commitSeek(next);
  };
  const commitSeek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(value)) return;
    const target = Math.max(0, Math.min(duration || value, value));
    audio.currentTime = target;
    setCurrentTime(target);
    seekDraftRef.current = target;
    setSeekDraft(target);
    seekingRef.current = false;
    setIsSeeking(false);
  };
  const updateSeekFromPointer = (
    event: React.PointerEvent<HTMLInputElement>,
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !duration) return;
    const fraction = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left) / bounds.width),
    );
    const next = fraction * duration;
    seekDraftRef.current = next;
    setSeekDraft(next);
  };
  const handleSeekWheel = (event: React.WheelEvent<HTMLInputElement>) => {
    event.preventDefault();
    seekBy(event.deltaY < 0 ? 5 : -5);
  };
  const selectOutputDevice = async (deviceId: string) => {
    setOutputDeviceId(deviceId);
    localStorage.setItem("silo.audioPlayer.outputDevice", deviceId);
    try {
      await applyOutputDevice(deviceId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `Could not select audio output: ${cause.message}`
          : "Could not select audio output.",
      );
    }
  };
  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      const graphPromise = ensureAudioGraph();
      const playPromise = audio.play();
      await Promise.all([graphPromise, playPromise]);
    } else {
      audio.pause();
    }
  };

  return (
    <section className="audio-library" aria-label="Audio library">
      <header className="audio-library-header">
        <div>
          <span className="audio-eyebrow">MEDIA LIBRARY</span>
          <h2>Audio Player</h2>
          <p>
            {loading
              ? "Scanning enabled sources…"
              : `${filteredFiles.length.toLocaleString()} of ${files.length.toLocaleString()} audio files`}
          </p>
        </div>
        <div className="audio-format-filter" ref={formatFilterRef}>
          <button
            className="audio-format-trigger"
            aria-expanded={formatFilterOpen}
            onClick={() => setFormatFilterOpen((open) => !open)}
          >
            Formats ·{" "}
            {selectedExtensions === null
              ? "All"
              : `${selectedExtensions.size}/${audioFormats.length}`}
          </button>
          {formatFilterOpen && (
            <div
              className="audio-format-menu"
              role="group"
              aria-label="Audio file formats"
            >
              <strong className="audio-format-menu-title">
                FILTER BY FORMAT
              </strong>
              <label className="audio-format-option all-formats">
                <input
                  type="checkbox"
                  checked={selectedExtensions === null}
                  onChange={(event) =>
                    setSelectedExtensions(
                      event.target.checked ? null : new Set(),
                    )
                  }
                />
                <span>All formats</span>
              </label>
              <div className="audio-format-options">
                {audioFormats.map((format) => (
                  <label key={format} className="audio-format-option">
                    <input
                      type="checkbox"
                      checked={
                        selectedExtensions === null ||
                        selectedExtensions.has(format)
                      }
                      onChange={(event) =>
                        toggleAudioFormat(format, event.target.checked)
                      }
                    />
                    <span>
                      {format === "(no extension)"
                        ? format
                        : format.slice(1).toUpperCase()}
                    </span>
                  </label>
                ))}
                {audioFormats.length === 0 && (
                  <small className="audio-format-empty">
                    No formats discovered yet
                  </small>
                )}
              </div>
            </div>
          )}
        </div>
        <button
          className="audio-refresh-button"
          onClick={() => setRefreshRequest((value) => value + 1)}
          disabled={loading}
          title="Refresh the cached audio inventory"
        >
          <FiRefreshCw className={loading ? "spinning" : ""} />
          {loading ? "Scanning…" : "Refresh"}
        </button>
        {loading && (
          <strong className="audio-scan-count">
            {scanProgress.audioFound.toLocaleString()} audio found
          </strong>
        )}
      </header>
      {loading && (
        <div className="audio-scan-progress" role="status" aria-live="polite">
          <div className="audio-scan-progress-label">
            <span>Scanning audio library</span>
            <strong>
              {scanProgress.source ? `${scanProgress.source} · ` : ""}
              Source {scanProgress.sourceIndex.toLocaleString()} of{" "}
              {scanProgress.sourceCount.toLocaleString()} ·{" "}
              {scanProgress.scanned.toLocaleString()} files scanned ·{" "}
              {scanProgress.audioFound.toLocaleString()} audio found
            </strong>
          </div>
          <div className="audio-scan-track">
            <div className="audio-scan-fill" />
          </div>
        </div>
      )}
      {error && <div className="audio-error">{error}</div>}
      <div className="audio-library-body">
        <aside
          className="audio-track-list"
          ref={trackListRef}
          onScroll={(event) => {
            const top = event.currentTarget.scrollTop;
            setViewport((current) =>
              current.top === top ? current : { ...current, top },
            );
          }}
        >
          <div
            className="audio-virtual-spacer"
            style={{ height: renderWindow.physicalHeight }}
          >
            <div
              className="audio-virtual-window"
              style={{ top: renderWindow.top }}
            >
              {renderWindow.rows.map((row) =>
                row.file ? (
                  <AudioTrackRow
                    key={`track:${row.index}:${row.file.path}`}
                    file={row.file}
                    active={row.file.path === activePath}
                    playing={row.file.path === activePath && playing}
                    favorite={favoritePaths.has(row.file.path)}
                    onPlay={playRow}
                    onFavorite={favoriteRow}
                  />
                ) : (
                  <button
                    key={`year:${row.year}`}
                    className="audio-year-toggle"
                    aria-expanded={expandedYears.has(row.year)}
                    onClick={() => toggleYear(row.year)}
                  >
                    <span>
                      {expandedYears.has(row.year) ? "▾" : "▸"} {row.year}
                    </span>
                    <span>{row.total}</span>
                  </button>
                ),
              )}
            </div>
          </div>
          {loading && (
            <div className="audio-scan-empty" aria-hidden="true">
              <div className="audio-orbit-loader">
                {Array.from({ length: 12 }, (_, index) => (
                  <i
                    key={index}
                    style={
                      {
                        "--loader-index": index,
                        opacity: 0.22 + index * 0.065,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </div>
              <span>Finding audio tracks…</span>
            </div>
          )}
          {!loading && files.length === 0 && !error && (
            <p className="audio-empty">
              No audio files found in enabled sources.
            </p>
          )}
          {!loading && files.length > 0 && filteredFiles.length === 0 && (
            <p className="audio-empty">
              No tracks match the selected formats and year.
            </p>
          )}
        </aside>
        <main className="audio-deck">
          <div className="audio-deck-title">
            <span>SILO · MEDIA PLAYER</span>
            <span className="audio-deck-lights">
              <i />
              <i />
              <i />
            </span>
          </div>
          <div
            className={`audio-visualizer ${playing ? "playing" : ""} ${loading ? "scanning" : ""}`}
            aria-label={
              loading
                ? "Scanning audio library"
                : playing
                  ? "Audio visualizer active"
                  : "Audio visualizer idle"
            }
          >
            {Array.from({ length: EQ_BANDS }, (_, index) => (
              <i
                key={index}
                ref={(element) => {
                  visualBarsRef.current[index] = element;
                }}
              />
            ))}
            {loading && (
              <div className="audio-orbit-loader">
                {Array.from({ length: 12 }, (_, index) => (
                  <i
                    key={index}
                    style={
                      {
                        "--loader-index": index,
                        opacity: 0.22 + index * 0.065,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </div>
            )}
          </div>
          <div className="audio-track-metadata">
            <span className="audio-disc">♫</span>
            <div>
              <strong>{activeFile?.name ?? "Nothing playing"}</strong>
              <small>
                {activeFile
                  ? `${activeFile.extension.replace(/^\./, "").toUpperCase() || "AUDIO"} · ${sizeOf(activeFile.size)} · ${new Date(activeFile.modified).toLocaleString()}`
                  : "Choose a track from your library"}
              </small>
            </div>
          </div>
          <audio
            ref={audioRef}
            src={preview?.mediaUrl}
            crossOrigin="anonymous"
            onTimeUpdate={(event) => {
              if (!isSeeking) setCurrentTime(event.currentTarget.currentTime);
            }}
            onLoadedMetadata={(event) =>
              setDuration(event.currentTarget.duration)
            }
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => stepTrack(1)}
            onError={(event) =>
              setError(
                `Audio playback failed (media error ${event.currentTarget.error?.code ?? "unknown"}).`,
              )
            }
          />
          <div className="audio-seek-row">
            <span>{timeOf(isSeeking ? seekDraft : currentTime)}</span>
            <input
              type="range"
              min="0"
              max={duration || 0}
              step="0.1"
              value={Math.min(
                isSeeking ? seekDraft : currentTime,
                duration || 0,
              )}
              onPointerDown={(event) => {
                seekingRef.current = true;
                setIsSeeking(true);
                event.currentTarget.setPointerCapture(event.pointerId);
                updateSeekFromPointer(event);
              }}
              onPointerMove={(event) => {
                if (seekingRef.current) updateSeekFromPointer(event);
              }}
              onPointerUp={(event) => {
                if (!seekingRef.current) return;
                updateSeekFromPointer(event);
                commitSeek(seekDraftRef.current);
              }}
              onPointerCancel={() => {
                if (seekingRef.current) commitSeek(seekDraftRef.current);
              }}
              onWheel={handleSeekWheel}
              onChange={(event) => {
                if (!seekingRef.current)
                  commitSeek(Number(event.currentTarget.value));
              }}
              aria-label="Playback position"
            />
            <span>{timeOf(duration)}</span>
          </div>
          <div className="audio-controls">
            <button
              onClick={() => skipTracks(-1)}
              disabled={!activeFile}
              aria-label="Previous track"
              title="Previous track"
            >
              <FiSkipBack />
            </button>
            <button
              onClick={() => seekBy(-10)}
              disabled={!activeFile}
              aria-label="Rewind 10 seconds"
              title="Rewind 10 seconds"
            >
              <FiRewind />
            </button>
            <button
              className="audio-play"
              onClick={() =>
                void togglePlayback().catch(() =>
                  setError("Audio playback could not start."),
                )
              }
              disabled={!preview?.mediaUrl}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <FiPause /> : <FiPlay />}
            </button>
            <button
              onClick={() => seekBy(10)}
              disabled={!activeFile}
              aria-label="Fast forward 10 seconds"
              title="Fast forward 10 seconds"
            >
              <FiFastForward />
            </button>
            <button
              onClick={() => skipTracks(1)}
              disabled={!activeFile}
              aria-label="Next track"
              title="Next track"
            >
              <FiSkipForward />
            </button>
            <label className="audio-volume">
              {volume === 0 ? <FiVolumeX /> : <FiVolume2 />}
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVolume(next);
                  localStorage.setItem(PLAYER_VOLUME_KEY, String(next));
                }}
                aria-label="Volume"
              />
            </label>
            <label className="audio-output-picker">
              <span>Output</span>
              <select
                value={outputDeviceId}
                onChange={(event) =>
                  void selectOutputDevice(event.target.value)
                }
                aria-label="Audio output device"
                title="Choose the audio output device"
              >
                <option value="">System</option>
                {audioOutputs.map((output) => (
                  <option key={output.deviceId} value={output.deviceId}>
                    {output.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="audio-eq-label">
            PARAMETRIC EQ{" "}
            <span>
              {exploded ? "EXPLODED LIST" : "YEAR GROUPS · COLLAPSIBLE"}
            </span>
          </div>
        </main>
      </div>
    </section>
  );
}
