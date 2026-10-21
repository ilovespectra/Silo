import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { DEFAULT_SEMANTIC_SEARCH_CONFIDENCE } from "./searchSettings";
import {
  FiArrowUp,
  FiBarChart2,
  FiCheck,
  FiCheckCircle,
  FiChevronDown,
  FiChevronLeft,
  FiChevronRight,
  FiClock,
  FiCloud,
  FiColumns,
  FiCopy,
  FiDownload,
  FiEdit3,
  FiEye,
  FiEyeOff,
  FiFastForward,
  FiFile,
  FiFolder,
  FiFolderPlus,
  FiGrid,
  FiHardDrive,
  FiHelpCircle,
  FiHeart,
  FiImage,
  FiList,
  FiLogOut,
  FiMap,
  FiMapPin,
  FiMove,
  FiPause,
  FiPlay,
  FiPlus,
  FiRefreshCw,
  FiRewind,
  FiRepeat,
  FiRotateCcw,
  FiSearch,
  FiSkipBack,
  FiSkipForward,
  FiSettings,
  FiSlash,
  FiSliders,
  FiSmartphone,
  FiStar,
  FiTag,
  FiTrash2,
  FiUser,
  FiUserCheck,
  FiUserPlus,
  FiUsers,
  FiVolume2,
  FiVolumeX,
  FiX,
  FiZap,
  FiZoomIn,
  FiZoomOut,
} from "react-icons/fi";
import { FaBug } from "react-icons/fa";
import "./App.css";
import { useDragSelect } from "./hooks/useDragSelect";
import { useStableBusy } from "./utils/useStableBusy";
import { AudioSort } from "./utils/audioSort";
import { readInventory } from "./utils/readInventory";
import { selectedMedia } from "./utils/selectedMedia";
import {
  matchesMetadataFilters,
  MetadataFilter,
} from "./utils/metadataFilters";
import {
  GRID_THUMBNAIL_SIZE,
  LRUCache,
  loadThumbnail,
  thumbnailCache,
  thumbnailCacheKey,
} from "./utils/thumbnailCache";
import { useThumbnail } from "./utils/useThumbnail";
import {
  publishPhotoIndicators,
  refreshPhotoIndicators,
  usePhotoIndicator,
} from "./utils/photoIndicators";
import {
  emptyMagicState,
  MagicState,
  useMagicPreferences,
  useMagicRanks,
} from "./utils/useMagicRanks";
import MessageExportPanel from "./components/MessageExportPanel";
import { PhoneManagementPanel } from "./components/PhoneManagerPanel";
import GoogleReclaimDialog from "./components/GoogleReclaimDialog";
import { GOOGLE_FEATURES_ENABLED } from "./featureFlags";
import AudioLibrary from "./components/AudioLibrary";
import VideoTheatre from "./components/VideoTheatre";
import IndexingPanel from "./components/IndexingPanel";
import LocationPicker from "./components/LocationPicker";
import DuplicatesPage from "./components/DuplicatesPage";
import SettingsPanel, {
  BugReportDialog,
} from "./components/SettingsPanel";
import StatsDashboard from "./components/StatsDashboard";
import MagicTools from "./components/MagicTools";
import PersonPicker from "./components/PersonPicker";
import GuidedTour, {
  type GuidedTourSection,
  type GuidedTourStep,
} from "./components/GuidedTour";
import LocalHelpPanel from "./components/LocalHelpPanel";
import InteractiveTooltip from "./components/InteractiveTooltip";

function FirstRunMapServiceConsent({
  onConsentChange,
}: {
  onConsentChange: (allowed: boolean) => Promise<void>;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const api = window.electron;
    if (!api) return;
    let active = true;
    void api.getMapServiceConsent().then((allowed) => {
      if (active && allowed === null) setVisible(true);
    }).catch(() => {
      if (!active) return;
      setError("Silo could not read the saved choice. Online map services remain off until you choose.");
      setVisible(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const choose = async (allowed: boolean) => {
    const api = window.electron;
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      await onConsentChange(allowed);
      setVisible(false);
    } catch {
      setError("Silo could not save this privacy choice. Online map services remain off.");
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;
  return createPortal(
    <div className="map-privacy-backdrop">
      <section className="map-privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="first-run-map-privacy-title">
        <h2 id="first-run-map-privacy-title">Choose whether to use online map services</h2>
        <p>Photo locations stay on this device unless you allow online map services. If enabled, selecting an unlabeled location can send its exact coordinates to Nominatim; place searches send your query to Photon; and close-up imagery requests send tile coordinates to Esri. These services can also see your public IP address and request timing. Their log retention is not known.</p>
        <p>With services off, local location groups and the offline globe remain available. You can change this choice later in Settings → Appearance &amp; behavior.</p>
        {error && <p className="map-privacy-error" role="alert">{error}</p>}
        <div className="map-privacy-actions">
          <button type="button" onClick={() => void choose(false)} disabled={busy}>Keep services off</button>
          <button type="button" className="primary" onClick={() => void choose(true)} disabled={busy}>Allow online map services</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

const MapPage = React.lazy(() => import("./components/MapPage"));
const MemoriesPage = React.lazy(() => import("./components/MemoriesPage"));
const MemoriesLauncher = React.lazy(() => import("./components/MemoriesLauncher"));
const LazyDocumentViewer = React.lazy(
  () => import("./components/DocumentViewer"),
);
class DocumentViewerErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("Document viewer failed to load", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="viewer-status document-viewer-load-error" role="alert">
          <div>
            <p>Document preview failed to load.</p>
            <button
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload Silo
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
function DocumentViewer(
  props: React.ComponentProps<typeof LazyDocumentViewer>,
) {
  return (
    <DocumentViewerErrorBoundary>
      <React.Suspense
        fallback={
          <div className="viewer-status">Loading document renderer…</div>
        }
      >
        <LazyDocumentViewer {...props} />
      </React.Suspense>
    </DocumentViewerErrorBoundary>
  );
}
// TEMP: reload once when removing diagnostic hooks from a hot-updated module.
if (
  (module as NodeModule & { hot?: { status(): string } }).hot?.status() ===
  "apply"
) {
  window.location.reload();
}
const FAVORITES_FOLDER_ID = "__favorites__";
const REFUSE_FOLDER_ID = "__refuse__";
const PERSON_MEDIA_TYPES = new Set(["image", "video"]);
const defaultContentSettings: PublicContentSettings = {
  showNsfw: false,
  safeSearch: true,
  theme: "system",
  showBannedPeople: false,
  parentalPasswordSet: false,
};
const emptyDuplicateState: DuplicateState = {
  status: "idle",
  scanned: 0,
  total: 0,
  duplicateFiles: 0,
  reclaimableBytes: 0,
  trashBytes: 0,
  permanentlyClearedBytes: 0,
  message: "Ready to scan for exact duplicates.",
  groups: [],
  trash: [],
};

interface FileInfo {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: number;
  isDirectory: boolean;
  type: string;
  extension: string;
  sourceId?: string;
  sourceLabel?: string;
  year?: number;
}

interface FilePreview {
  name: string;
  size: number;
  modified: string;
  mimeType: string | null;
  extension: string;
  path: string;
  previewDataUrl: string | null;
  mediaUrl?: string; // URL for streaming audio/video files
  playbackMimeType?: string | null;
  transcoded?: boolean;
  documentPreview?: import("./documentPreview").DocumentPreview;
}

interface PreparedViewerImage {
  preview: FilePreview;
  width: number;
  height: number;
}

const livePhotoStillExtensions = new Set([".heic", ".heif", ".jpg", ".jpeg"]);
const livePhotoVideoExtensions = new Set([".mov", ".mp4", ".m4v"]);

function splitMediaPath(filePath: string) {
  const separatorIndex = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const directory =
    separatorIndex >= 0 ? filePath.slice(0, separatorIndex) : "";
  const fileName =
    separatorIndex >= 0 ? filePath.slice(separatorIndex + 1) : filePath;
  const extensionIndex = fileName.lastIndexOf(".");
  return {
    directory: directory.toLowerCase(),
    stem: (extensionIndex >= 0
      ? fileName.slice(0, extensionIndex)
      : fileName
    ).toLowerCase(),
  };
}

function findLivePhotoVideo(still: FileInfo, candidates: FileInfo[]) {
  if (!livePhotoStillExtensions.has(still.extension.toLowerCase())) return null;
  const stillPath = splitMediaPath(still.path);
  return (
    candidates.find((candidate) => {
      if (candidate.type !== "video") return false;
      if (!livePhotoVideoExtensions.has(candidate.extension.toLowerCase()))
        return false;
      const candidatePath = splitMediaPath(candidate.path);
      return (
        candidatePath.directory === stillPath.directory &&
        candidatePath.stem === stillPath.stem
      );
    }) ?? null
  );
}

function formatMediaTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  return `${Math.floor(value / 60)}:${seconds}`;
}

interface FilterState {
  includedType: string;
  sizeMin: number;
  sizeMax: number;
}

interface SortState {
  field:
    | "name"
    | "size"
    | "modified"
    | "type"
    | "source"
    | "magic"
    | "people"
    | "mapped";
  ascending: boolean;
}

interface DialogRequest {
  mode: "text" | "confirm";
  title: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (value: string) => Promise<void> | void;
}

const fileTypeLabels: Record<string, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  archive: "Archives",
  other: "Other",
};
const fileTypeOrder = Object.keys(fileTypeLabels);
const fileSortCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function compareFilesBySort(
  first: FileInfo,
  second: FileInfo,
  sort: SortState,
  magicRanks?: Map<string, number>,
  indicators: Record<string, { people: boolean; mapped: boolean }> = {},
) {
  if (sort.field === "people" || sort.field === "mapped") {
    const isPeople = sort.field === "people";
    const firstMatch = isPeople
      ? Boolean(indicators[first.path]?.people)
      : Boolean(indicators[first.path]?.mapped);
    const secondMatch = isPeople
      ? Boolean(indicators[second.path]?.people)
      : Boolean(indicators[second.path]?.mapped);
    if (firstMatch !== secondMatch)
      return sort.ascending ? (firstMatch ? -1 : 1) : firstMatch ? 1 : -1;
    return (
      (second.modified || 0) - (first.modified || 0) ||
      first.path.localeCompare(second.path)
    );
  }
  if (sort.field === "magic") {
    // Best to worst; anything not analyzed yet falls to the end, newest first.
    const firstRank = magicRanks?.get(first.path) ?? Number.POSITIVE_INFINITY;
    const secondRank = magicRanks?.get(second.path) ?? Number.POSITIVE_INFINITY;
    if (firstRank !== secondRank) return firstRank < secondRank ? -1 : 1;
    return (
      (second.modified || 0) - (first.modified || 0) ||
      first.path.localeCompare(second.path)
    );
  }
  if (sort.field === "source") {
    const sourceComparison = fileSortCollator.compare(
      first.sourceLabel || "Unknown source",
      second.sourceLabel || "Unknown source",
    );
    if (sourceComparison !== 0)
      return sort.ascending ? sourceComparison : -sourceComparison;
    const dateComparison = (second.modified || 0) - (first.modified || 0);
    if (dateComparison !== 0) return dateComparison;
    return first.path.localeCompare(second.path);
  }
  let comparison = 0;
  if (sort.field === "name")
    comparison = fileSortCollator.compare(first.name, second.name);
  if (sort.field === "size")
    comparison = (first.size || 0) - (second.size || 0);
  if (sort.field === "modified")
    comparison = (first.modified || 0) - (second.modified || 0);
  if (sort.field === "type")
    comparison = (fileTypeLabels[first.type] || first.type).localeCompare(
      fileTypeLabels[second.type] || second.type,
    );
  if (comparison === 0)
    comparison = fileSortCollator.compare(first.name, second.name);
  if (comparison === 0) comparison = first.path.localeCompare(second.path);
  return sort.ascending ? comparison : -comparison;
}

function modifiedYear(file: FileInfo): string {
  if (file.year !== undefined) return String(file.year);
  const timestamp = Number(file.modified);
  return Number.isFinite(timestamp) && timestamp > 0
    ? String(new Date(timestamp).getFullYear())
    : "Unknown year";
}

function selectedTypes(value: string): string[] {
  return value === "all" ? fileTypeOrder : value.split(",").filter(Boolean);
}

const sourceKindLabels: Record<string, string> = {
  local: "Disk",
  machine: "This Mac",
  ios: "iOS",
  android: "Android",
  gdrive: "Drive",
  gphotos: "Photos",
};

const emptyIndexProgress: IndexProgress = {
  status: "idle",
  total: 0,
  indexed: 0,
  remaining: 0,
  errors: 0,
  currentFile: null,
  message: "Add a source to begin indexing.",
};

function FileThumbnail({
  file,
  onOpen,
  onThumbnailLoaded,
  onAddPeople,
  thumbnailSize = GRID_THUMBNAIL_SIZE,
}: {
  file: FileInfo;
  onOpen: () => void;
  onThumbnailLoaded?: (filePath: string, file: FileInfo) => void;
  onAddPeople?: () => void;
  thumbnailSize?: number;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [thumbnailVisible, setThumbnailVisible] = useState(false);
  const isPreviewable = file.type === "image" || file.type === "video";
  const indicators = usePhotoIndicator(file.path, isPreviewable);
  const { thumbnail } = useThumbnail(
    file.path,
    thumbnailVisible && isPreviewable,
    false,
    thumbnailSize,
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !isPreviewable) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setThumbnailVisible(Boolean(entries[0]?.isIntersecting));
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isPreviewable]);

  useEffect(() => {
    if (thumbnail) onThumbnailLoaded?.(file.path, file);
  }, [file.path, onThumbnailLoaded, thumbnail]);

  return (
    <div
      className={`thumbnail-frame ${isPreviewable ? "previewable" : ""} ${file.type === "video" ? "video-thumbnail" : ""}`}
      ref={containerRef}
      role={isPreviewable ? "button" : undefined}
      tabIndex={isPreviewable ? 0 : undefined}
      onClick={(event) => {
        if (!isPreviewable) return;
        // Modifier clicks are selection gestures for the card, not "open".
        if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (!isPreviewable || (event.key !== "Enter" && event.key !== " "))
          return;
        event.preventDefault();
        onOpen();
      }}
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" />
      ) : (
        <div className="thumbnail-placeholder">
          {file.isDirectory ? (
            <FiFolder size={32} />
          ) : file.type === "video" ? (
            <span>📹</span>
          ) : (
            <FiFile size={32} />
          )}
        </div>
      )}
      {file.type === "video" && (
        <div className="video-play-icon" aria-hidden="true">
          ▶
        </div>
      )}
      {(indicators?.hasLocation || (indicators?.people.length ?? 0) > 0) && (
        <div className="thumbnail-indicators">
          {indicators?.hasLocation && (
            <span
              className="thumbnail-indicator place"
              title={indicators.locationLabel || "Has a location"}
            >
              <FiMapPin />
            </span>
          )}
          {(indicators?.people.length ?? 0) > 0 && (
            <span
              className="thumbnail-indicator people"
              title={indicators!.people.join(", ")}
            >
              <FiUsers />
            </span>
          )}
        </div>
      )}
      {onAddPeople && file.type === "image" && (
        <button
          className="thumbnail-add-people"
          onClick={(event) => {
            event.stopPropagation();
            onAddPeople();
          }}
          title="Assign detected faces to people"
        >
          <FiUserPlus />
        </button>
      )}
    </div>
  );
}

function SearchTiming({
  startedAt,
  firstResultAt,
  completedAt,
}: {
  startedAt: number;
  firstResultAt: number | null;
  completedAt: number | null;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (completedAt !== null) return;
    const timer = window.setInterval(() => setNow(performance.now()), 50);
    return () => window.clearInterval(timer);
  }, [completedAt]);

  const end = completedAt ?? now;
  const total = Math.max(1, Math.round(end - startedAt));
  const first =
    firstResultAt === null
      ? null
      : Math.max(1, Math.round(firstResultAt - startedAt));
  return (
    <span className="search-timing-counter" title="Elapsed time for this query">
      {first === null
        ? completedAt === null
          ? "Searching"
          : "No result"
        : `First ${first} ms`} · {total} ms
    </span>
  );
}

const VIEWER_PREFETCH_THUMBNAIL_SIZE = 480;
const MAX_VIEWER_PREVIEW_CACHE_ENTRIES = 3;
const MAX_VIEWER_PREVIEW_CACHE_CHARS = 48 * 1024 * 1024;

function viewerPreviewCacheKey(file: FileInfo) {
  return `${file.path}\0${file.size}\0${file.modified}`;
}

function cachedImagePreview(
  file: FileInfo,
  size = GRID_THUMBNAIL_SIZE,
): FilePreview | null {
  if (file.type !== "image") return null;
  const previewDataUrl = thumbnailCache.peek(
    thumbnailCacheKey(file.path, size),
  );
  if (!previewDataUrl) return null;
  const modified = Number(file.modified);
  return {
    name: file.name,
    size: Number(file.size) || 0,
    modified:
      Number.isFinite(modified) && modified > 0
        ? new Date(modified).toLocaleString()
        : "",
    mimeType: null,
    extension: file.extension,
    path: file.path,
    previewDataUrl,
  };
}

const GOOGLE_SOURCES_IN_SIDEBAR = GOOGLE_FEATURES_ENABLED;
const FAST_FILE_SEARCH_RESULT_LIMIT = 5000;
// Scan a few thousand cached entries per task, then yield without adding a
// fixed delay. The previous 24 ms pause per 512 files made a two-million-file
// inventory take about 94 seconds to reach its last matching paths.
const FAST_FILE_SEARCH_CHUNK_SIZE = 4096;
const FAST_FILE_SEARCH_CHUNK_DELAY_MS = 0;
const SEARCH_INDEX_PREPARING_HINT =
  "Search works now. Results may be slower while Silo prepares the saved library index; they should be much faster once it is ready.";

function getFileTextMatchPriority(
  file: FileInfo,
  query: string,
): 0 | 1 | 2 | null {
  const name = file.name.toLocaleLowerCase();
  if (name === query) return 0;
  if (name.includes(query)) return 1;
  if (
    file.relativePath.toLocaleLowerCase().includes(query) ||
    file.path.toLocaleLowerCase().includes(query)
  )
    return 2;
  return null;
}

function asFastFileSearchResult(
  file: FileInfo,
  priority: NonNullable<SemanticSearchResult["_priority"]>,
): SemanticSearchResult {
  return {
    ...file,
    _priority: priority,
    _source: priority === 2 ? "Path match" : "Name match",
  };
}

function pathIsWithinSourceRoot(filePath: string, root: string) {
  if (root === "/" || root === "\\") return filePath.startsWith(root);
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return (
    filePath === normalizedRoot ||
    filePath.startsWith(`${normalizedRoot}/`) ||
    filePath.startsWith(`${normalizedRoot}\\`)
  );
}

function phoneSourceDeviceKey(source: BrowseSource) {
  if (source.kind !== "ios" && source.kind !== "android") return null;
  const match = source.rootPath.match(
    /^\/__(?:phone|phone_backup)__\/(ios|android)\/([^/]+)/,
  );
  return match && match[1] === source.kind
    ? `${match[1]}:${match[2]}`
    : null;
}

const normalizedSourceRootCache = new WeakMap<object, Set<string>>();

function normalizedSourceRoots(roots: ReadonlySet<string>) {
  const cached = normalizedSourceRootCache.get(roots as object);
  if (cached) return cached;
  const normalized = new Set(
    Array.from(roots, (root) =>
      root.length > 1 ? root.replace(/[\\/]+$/, "") : root,
    ),
  );
  normalizedSourceRootCache.set(roots as object, normalized);
  return normalized;
}

function pathIsWithinAnySource(filePath: string, roots: ReadonlySet<string>) {
  const normalized = normalizedSourceRoots(roots);
  if (
    (normalized.has("/") && filePath.startsWith("/")) ||
    (normalized.has("\\") && filePath.startsWith("\\"))
  )
    return true;
  if (normalized.has(filePath)) return true;
  let cursor = filePath.length;
  while (cursor > 0) {
    const slash = filePath.lastIndexOf("/", cursor - 1);
    const backslash = filePath.lastIndexOf("\\", cursor - 1);
    const separator = Math.max(slash, backslash);
    if (separator <= 0) break;
    if (normalized.has(filePath.slice(0, separator))) return true;
    cursor = separator;
  }
  return false;
}

function pathIsVisibleForSelectedSources(
  filePath: string,
  enabledRoots: ReadonlySet<string>,
  allRoots: ReadonlySet<string>,
) {
  return (
    pathIsWithinAnySource(filePath, enabledRoots) ||
    !pathIsWithinAnySource(filePath, allRoots)
  );
}

// Fallout Shelter Silo-only aliases share a physical path with their canonical file.
const fileListKey = (file: { path: string; relativePath?: string; siloAlias?: boolean }) =>
  file.siloAlias ? `${file.path}\u0000${file.relativePath ?? ""}` : file.path;
const MAX_THUMBNAIL_SIZE = 500;
const LEGACY_THUMBNAIL_SIZE_KEY = "silo.thumbnailSize";
type AppSection =
  | "files"
  | "people"
  | "map"
  | "duplicates"
  | "pets"
  | "mobile"
  | "memories"
  | "stats";

function readThumbnailSizePreference(key: string, fallback = 240) {
  try {
    const saved = localStorage.getItem(key);
    const legacy =
      saved === null ? localStorage.getItem(LEGACY_THUMBNAIL_SIZE_KEY) : null;
    const parsed = Number(saved ?? legacy);
    const size =
      Number.isFinite(parsed) && (saved !== null || legacy !== null)
        ? parsed
        : fallback;
    return Math.min(MAX_THUMBNAIL_SIZE, Math.max(120, size));
  } catch {
    return fallback;
  }
}

function App() {
  // Electron exposes a contextBridge proxy whose identity can change between reads.
  // Keep one bridge reference so effects that subscribe to IPC do not tear down and
  // re-register on every render (which can replay events and create update loops).
  const electronAPIRef = useRef(window.electron);
  const electronAPI = electronAPIRef.current;
  const searchFeedbackApiReady =
    typeof electronAPI?.updateSearchFeedback === "function";
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const [appVersion, setAppVersion] = useState("…");
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [fileScanProgress, setFileScanProgress] =
    useState<FileScanProgress | null>(null);
  const [loadedThumbnailPaths, setLoadedThumbnailPaths] = useState<Set<string>>(
    new Set(),
  );
  const loadedThumbnailFilesRef = useRef(new Map<string, FileInfo>());
  const pendingLoadedThumbnails = useRef(new Set<string>());
  const thumbnailCountTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (thumbnailCountTimer.current !== null)
        window.clearTimeout(thumbnailCountTimer.current);
    },
    [],
  );
  const [exploded, setExploded] = useState(false);
  const [navigationHistory, setNavigationHistory] = useState<
    Array<{ type: "path" | "folder"; value: string }>
  >([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [viewMode, setViewMode] = useState<"list" | "grid">("grid");
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [typeFilterOpen, setTypeFilterOpen] = useState(false);
  const typeFilterRef = useRef<HTMLDivElement>(null);
  const [yearFilter, setYearFilter] = useState<string[]>([]);
  const [audioYearOptions, setAudioYearOptions] = useState<string[]>([]);
  const [expandedYears, setExpandedYears] = useState<Set<string>>(
    () => new Set(),
  );
  const [yearDisplayLimits, setYearDisplayLimits] = useState<
    Record<string, number>
  >({});
  const yearExpansionContextRef = useRef("");
  const knownYearsRef = useRef<Set<string>>(new Set());
  const [displayLimit, setDisplayLimit] = useState(500);
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem("silo.sidebarWidth")) || 260,
  );
  const [primaryNavCollapsed, setPrimaryNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem("silo.primaryNavCollapsed") === "true";
    } catch {
      return false;
    }
  });
  const [librarySidebarCollapsed, setLibrarySidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("silo.librarySidebarCollapsed") === "true";
    } catch {
      return false;
    }
  });
  const [filesThumbnailSize, setFilesThumbnailSize] = useState(() =>
    readThumbnailSizePreference("silo.thumbnailSize.files"),
  );
  const [peopleThumbnailSize, setPeopleThumbnailSize] = useState(() =>
    readThumbnailSizePreference("silo.thumbnailSize.people"),
  );
  const [memoryBookThumbnailSize, setMemoryBookThumbnailSize] = useState(() =>
    readThumbnailSizePreference("silo.thumbnailSize.memoryBook"),
  );
  const [duplicatesThumbnailSize, setDuplicatesThumbnailSize] = useState(() =>
    readThumbnailSizePreference("silo.thumbnailSize.duplicates"),
  );
  const retainedScrollPositionsRef = useRef<Record<string, number>>({});
  const [viewerOpen, setViewerOpen] = useState(false);
  const viewerOpenRef = useRef(viewerOpen);
  viewerOpenRef.current = viewerOpen;
  const [viewerImageLoading, setViewerImageLoading] = useState(false);
  const [viewerMediaFile, setViewerMediaFile] = useState<FileInfo | null>(null);
  const [viewerScopeFiles, setViewerScopeFiles] = useState<FileInfo[] | null>(
    null,
  );
  const [viewerZoom, setViewerZoom] = useState(1);
  const [viewerFit, setViewerFit] = useState(true);
  const [viewerDimensions, setViewerDimensions] = useState({
    width: 0,
    height: 0,
  });
  const viewerStageRef = useRef<HTMLDivElement | null>(null);
  const [viewerStageSize, setViewerStageSize] = useState({
    width: 0,
    height: 0,
  });
  useEffect(() => {
    if (!viewerOpen || !viewerStageRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewerStageSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    });
    observer.observe(viewerStageRef.current);
    return () => observer.disconnect();
  }, [viewerOpen]);
  const fittedImageScale =
    viewerDimensions.width > 0 &&
    viewerDimensions.height > 0 &&
    viewerStageSize.width > 0 &&
    viewerStageSize.height > 0
      ? Math.min(
          viewerStageSize.width / viewerDimensions.width,
          viewerStageSize.height / viewerDimensions.height,
        )
      : 1;
  const mediaElementRef = useRef<HTMLMediaElement | null>(null);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [mediaCurrentTime, setMediaCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [mediaVolume, setMediaVolume] = useState(1);
  const [mediaMuted, setMediaMuted] = useState(false);
  const [mediaLoop, setMediaLoop] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [startupState, setStartupState] = useState<StartupState>({
    ready: false,
    step: 0,
    total: 1,
    label: "Starting…",
  });
  const startupPresentationSignaledRef = useRef(false);
  useEffect(() => {
    if (!electronAPI?.getAppVersion) return;
    void electronAPI
      .getAppVersion()
      .then((version) => setAppVersion(version))
      .catch(() => setAppVersion(""));
  }, [electronAPI]);
  const [indexStorageStatus, setIndexStorageStatus] =
    useState<IndexStorageStatus>({
      message: null,
      usingLocalFallback: false,
      localFallbackEnabled: true,
      destinationAvailable: true,
      selectedDestination: "",
      localFreeBytes: null,
      reserveBytes: 10 * 1024 * 1024 * 1024,
      missingRoots: [],
      transfer: null,
    });
  const [indexStorageNoticeCollapsed, setIndexStorageNoticeCollapsed] = useState(false);
  const [checkingIndexStorage, setCheckingIndexStorage] = useState(false);
  const indexStorageNoticeMessage = (indexStorageStatus.message ?? "").replace(/[’‘]/g, "'");
  const isIndexStorageFallbackNotice = indexStorageStatus.usingLocalFallback && (
    /selected destination.*unavailable/i.test(indexStorageNoticeMessage) ||
    /can't locate your selected destination/i.test(indexStorageNoticeMessage)
  );
  const hasIndexStorageProblem = indexStorageStatus.missingRoots.length > 0 || isIndexStorageFallbackNotice;
  const hasVisibleIndexStorageTransfer = indexStorageStatus.transfer?.state === "moving" ||
    indexStorageStatus.transfer?.state === "complete" || indexStorageStatus.transfer?.state === "error";
  const showIndexStorageFallbackDetails = indexStorageStatus.usingLocalFallback &&
    Boolean(indexStorageStatus.message || hasVisibleIndexStorageTransfer);
  const showIndexStorageBanner =
    Boolean(indexStorageStatus.message) ||
    showIndexStorageFallbackDetails ||
    hasVisibleIndexStorageTransfer ||
    indexStorageStatus.missingRoots.length > 0;
  const [indexProgress, setIndexProgress] =
    useState<IndexProgress>(emptyIndexProgress);
  const [thumbnailPregen, setThumbnailPregen] =
    useState<ThumbnailPregenProgress | null>(null);
  const [thumbnailPregenDismissed, setThumbnailPregenDismissed] =
    useState(false);
  const lastThumbnailPregenStatusRef =
    useRef<ThumbnailPregenProgress["status"]>("idle");
  const [digitalFolders, setDigitalFolders] = useState<DigitalFolder[]>([]);
  const [mediaPlaylists, setMediaPlaylists] = useState<MediaPlaylist[]>([]);
  const [mediaHostBounds, setMediaHostBounds] = useState<{
    top: number; left: number; width: number; height: number;
  } | null>(null);
  const draggedFolder = useRef<string | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<{
    id: string;
    after: boolean;
  } | null>(null);
  const [folderOrderBusy, setFolderOrderBusy] = useState(false);
  const [folderOrderError, setFolderOrderError] = useState("");
  const [profilePicturePicker, setProfilePicturePicker] = useState<{
    x: number;
    y: number;
    photoPath: string;
  } | null>(null);
  const [profilePictureBusy, setProfilePictureBusy] = useState(false);
  const [profilePictureNotice, setProfilePictureNotice] = useState("");
  const [fileMetadata, setFileMetadata] = useState<
    Record<string, FileMetadata>
  >({});
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [contentSettings, setContentSettings] = useState(
    defaultContentSettings,
  );
  const [mapServicesAllowed, setMapServicesAllowed] = useState(false);
  const mapServiceConsentVersionRef = useRef(0);
  useEffect(() => {
    let active = true;
    const readVersion = mapServiceConsentVersionRef.current;
    void electronAPI?.getMapServiceConsent()
      .then((allowed) => {
        if (active && readVersion === mapServiceConsentVersionRef.current)
          setMapServicesAllowed(allowed === true);
      })
      .catch(() => {
        if (active && readVersion === mapServiceConsentVersionRef.current)
          setMapServicesAllowed(false);
      });
    return () => {
      active = false;
    };
  }, [electronAPI]);
  const saveMapServiceConsent = useCallback(async (allowed: boolean) => {
    if (!electronAPI) throw new Error("Map privacy settings are unavailable.");
    mapServiceConsentVersionRef.current += 1;
    await electronAPI.setMapServiceConsent(allowed);
    setMapServicesAllowed(allowed);
  }, [electronAPI]);
  const [showHiddenMessages, setShowHiddenMessages] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTourTarget, setSettingsTourTarget] = useState<string | null>(null);
  const [showBugReport, setShowBugReport] = useState(false);
  const [indexingDiagnosticReport, setIndexingDiagnosticReport] =
    useState<DiagnosticReport | null>(null);
  const [showBugThanks, setShowBugThanks] = useState(false);
  const [showBugReportToast, setShowBugReportToast] = useState(false);
  const [bugReportToastFading, setBugReportToastFading] = useState(false);
  const [hideBugThanksNextTime, setHideBugThanksNextTime] = useState(false);
  const [selectingBugReportScreenshot, setSelectingBugReportScreenshot] =
    useState(false);
  const [lifetimePromptRequest, setLifetimePromptRequest] = useState(0);
  const acknowledgeLifetimePrompt = useCallback(() => {
    setLifetimePromptRequest(0);
  }, []);
  const [demoModeActive, setDemoModeActive] = useState<boolean | null>(null);
  const [showGuidedTour, setShowGuidedTour] = useState(false);
  const [showTourExitConfirm, setShowTourExitConfirm] = useState(false);
  const [headerToolsCollapsed, setHeaderToolsCollapsed] = useState(false);
  const [showConstructionBanner, setShowConstructionBanner] = useState(() => {
    try {
      return localStorage.getItem("silo.hideConstructionBanner") !== "true";
    } catch {
      return true;
    }
  });
  const dismissConstructionBanner = (permanently: boolean) => {
    setShowConstructionBanner(false);
    if (permanently) {
      try {
        localStorage.setItem("silo.hideConstructionBanner", "true");
      } catch {
        // Keep the banner hidden when storage is unavailable for this session.
      }
    }
  };
  const [constructionDontShowAgain, setConstructionDontShowAgain] = useState(false);
  const [performanceDontShowAgain, setPerformanceDontShowAgain] = useState(false);
  const [performanceNoticeHidden, setPerformanceNoticeHidden] = useState(false);
  const [hidePerformanceNoticePermanently, setHidePerformanceNoticePermanently] = useState(() => {
    try {
      return localStorage.getItem("silo.hidePerformanceNotice") === "true";
    } catch {
      return false;
    }
  });
  const [showLocalHelp, setShowLocalHelp] = useState(false);
  const [tourContextStep, setTourContextStep] = useState<GuidedTourStep | null>(
    null,
  );
  const [tourDuplicateView, setTourDuplicateView] = useState<
    "duplicates" | "trash" | null
  >(null);
  const [mobileMessagesHelpRequest, setMobileMessagesHelpRequest] = useState(0);
  const [showTourAtStartup, setShowTourAtStartup] = useState(() => {
    try {
      return localStorage.getItem("silo.guidedTour.showAtStartup") !== "false";
    } catch {
      return true;
    }
  });
  const startupTourChecked = useRef(false);
  const [searchError, setSearchError] = useState("");
  const [browseError, setBrowseError] = useState("");
  const [contentSafetyRevision, setContentSafetyRevision] = useState(0);
  const [bannedHiddenPaths, setBannedHiddenPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const bannedHiddenPathsRef = useRef(bannedHiddenPaths);
  bannedHiddenPathsRef.current = bannedHiddenPaths;
  const [folderHiddenPaths, setFolderHiddenPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const folderHiddenPathsRef = useRef(folderHiddenPaths);
  folderHiddenPathsRef.current = folderHiddenPaths;
  const [duplicateState, setDuplicateState] =
    useState<DuplicateState>(emptyDuplicateState);
  const [activeDigitalFolderId, setActiveDigitalFolderId] = useState<
    string | null
  >(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const searchQueryStartedAtRef = useRef<{
    query: string;
    startedAt: number;
  } | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("silo.searchHistory") || "[]",
      );
      return Array.isArray(stored)
        ? stored.filter((item) => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [searchFocused, setSearchFocused] = useState(false);
  const [historyLevel, setHistoryLevel] = useState<0 | 1 | 2>(0);
  const [searchResults, setSearchResults] = useState<SemanticSearchResult[]>(
    [],
  );
  const [searchFeedback, setSearchFeedback] = useState<
    Record<string, "confirmed" | "removed">
  >({});
  const [searchFeedbackBusy, setSearchFeedbackBusy] = useState(false);
  const [searchIndexReadiness, setSearchIndexReadiness] =
    useState<SearchIndexReadiness>({
      status: "preparing",
      percentage: 0,
      records: 0,
      message: "Preparing the saved search index…",
    });
  const searchIndexPreviousStatusRef = useRef(searchIndexReadiness.status);
  const [searchTiming, setSearchTiming] = useState<{
    query: string;
    requestId: number;
    startedAt: number;
    firstResultAt: number | null;
    completedAt: number | null;
  } | null>(null);
  const [searchResultOrder, setSearchResultOrder] = useState<string[]>([]);
  const searchResultOrderRef = useRef<{ query: string; paths: string[] }>({
    query: "",
    paths: [],
  });
  const [freezeSearchResultOrder, setFreezeSearchResultOrder] =
    useState(true);
  const [fastFileSearchResults, setFastFileSearchResults] = useState<
    SemanticSearchResult[]
  >([]);
  const [fastFileSearchCapped, setFastFileSearchCapped] = useState(false);
  const fastFileSearchResultsRef = useRef(
    new Map<string, SemanticSearchResult>(),
  );
  const fastFileSearchResultsQueryRef = useRef("");
  const fastFileSearchGenerationRef = useRef(0);
  const scheduleFastFileMatchesRef = useRef<
    (candidates: FileInfo[], query: string, generation: number) => void
  >(() => {});
  scheduleFastFileMatchesRef.current = (candidates, query, generation) => {
    let offset = 0;
    const scanChunk = () => {
      if (
        generation !== fastFileSearchGenerationRef.current ||
        query !== searchQueryRef.current.trim().toLocaleLowerCase()
      )
        return;
      const matches = fastFileSearchResultsRef.current;
      const end = Math.min(
        offset + FAST_FILE_SEARCH_CHUNK_SIZE,
        candidates.length,
      );
      let changed = false;
      let capped = false;
      for (; offset < end; offset += 1) {
        const file = candidates[offset];
        if (
          bannedHiddenPathsRef.current.has(file.path) ||
          !pathIsWithinAnySource(file.path, enabledSourcePathsRef.current)
        ) continue;
        const priority = getFileTextMatchPriority(file, query);
        if (priority === null || matches.has(file.path)) continue;
        if (matches.size >= FAST_FILE_SEARCH_RESULT_LIMIT) {
          capped = true;
          offset = candidates.length;
          break;
        }
        matches.set(file.path, asFastFileSearchResult(file, priority));
        changed = true;
      }
      if (changed) {
        fastFileSearchResultsQueryRef.current = query;
        setFastFileSearchResults(Array.from(matches.values()));
      }
      if (capped) setFastFileSearchCapped(true);
      if (offset < candidates.length)
        window.setTimeout(scanChunk, FAST_FILE_SEARCH_CHUNK_DELAY_MS);
    };
    scanChunk();
  };
  const [searchProgress, setSearchProgress] = useState<{
    scanned: number;
    total: number;
    mode?: "ann" | "exact";
  }>({ scanned: 0, total: 0 });
  const searchDebounceTimerRef = useRef<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [confidence, setConfidence] = useState(DEFAULT_SEMANTIC_SEARCH_CONFIDENCE);
  const [appSection, setAppSection] = useState<AppSection>("files");
  const [visitedSections, setVisitedSections] = useState<Set<AppSection>>(
    () => new Set<AppSection>(["files"]),
  );
  useEffect(() => {
    setVisitedSections((current) =>
      current.has(appSection) ? current : new Set(current).add(appSection),
    );
  }, [appSection]);
  const [faceProgress, setFaceProgress] = useState<FaceIndexProgress>({
    status: "idle",
    total: 0,
    processed: 0,
    remaining: 0,
    faces: 0,
    people: 0,
    errors: 0,
    currentFile: null,
    message: "Waiting for indexed photos.",
  });
  const [faceActionPending, setFaceActionPending] = useState<"pause" | "resume" | null>(null);
  const [faceActionNotice, setFaceActionNotice] = useState<{
    kind: "pause" | "resume";
    message: string;
  } | null>(null);
  const [faceActionError, setFaceActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!faceActionNotice) return;
    const active = ["loading-model", "indexing"].includes(faceProgress.status);
    if (
      (faceActionNotice.kind === "resume" && active) ||
      (faceActionNotice.kind === "pause" && faceProgress.status === "paused")
    )
      setFaceActionNotice(null);
  }, [faceActionNotice, faceProgress.status]);
  const toggleFaceIndexing = async () => {
    if (!electronAPI || faceActionPending) return;
    const pausing = ["loading-model", "indexing"].includes(faceProgress.status);
    const kind = pausing ? "pause" : "resume";
    setFaceActionPending(kind);
    setFaceActionError(null);
    setFaceActionNotice({
      kind,
      message: pausing
        ? "Pause requested · finishing the current photo and saving progress…"
        : "Resume requested · queued behind available processing work…",
    });
    try {
      const progress = pausing
        ? await electronAPI.pauseFaceIndexing()
        : await electronAPI.startFaceIndexing();
      setFaceProgress(progress);
      if (pausing && progress.status === "paused")
        setFaceActionNotice(null);
      if (!pausing && ["loading-model", "indexing"].includes(progress.status))
        setFaceActionNotice(null);
    } catch (cause) {
      setFaceActionNotice(null);
      setFaceActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFaceActionPending(null);
    }
  };
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [personDetail, setPersonDetail] = useState<PersonDetail | null>(null);
  const personDetailRef = useRef<PersonDetail | null>(null);
  personDetailRef.current = personDetail;
  const [personSuggestions, setPersonSuggestions] = useState<FileInfo[]>([]);
  const [peopleTab, setPeopleTab] = useState<"all" | "confirmed">("all");
  const [revealBannedFaces, setRevealBannedFaces] = useState(false);
  const [personBusy, setPersonBusy] = useState(false);
  const [photoMenu, setPhotoMenu] = useState<{
    x: number;
    y: number;
    paths: string[];
  } | null>(null);
  const [personPicker, setPersonPicker] = useState<{
    x: number;
    y: number;
    paths: string[];
  } | null>(null);
  const [mergePicker, setMergePicker] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [bulkNotice, setBulkNotice] = useState("");
  const [historyToast, setHistoryToast] = useState("");
  const [photoMenuQuery, setPhotoMenuQuery] = useState("");
  const [personPhotos, setPersonPhotos] = useState<FileInfo[]>([]);
  const [selectedPersonPhoto, setSelectedPersonPhoto] =
    useState<FileInfo | null>(null);
  const [selectedPhotoFaces, setSelectedPhotoFaces] = useState<ImageFace[]>([]);
  const [faceAssignmentOpen, setFaceAssignmentOpen] = useState(false);
  const [faceAssignmentPhotoPath, setFaceAssignmentPhotoPath] = useState<string | null>(null);
  const faceAssignmentPhotoPathRef = useRef<string | null>(null);
  const faceAssignmentActive = faceAssignmentOpen &&
    Boolean(selectedFile?.path && selectedFile.path === faceAssignmentPhotoPath);
  const [faceAssignmentFaces, setFaceAssignmentFaces] = useState<ImageFace[]>(
    [],
  );
  const [faceAssignmentSelectedId, setFaceAssignmentSelectedId] = useState<
    string | null
  >(null);
  const [faceAssignmentTargets, setFaceAssignmentTargets] = useState<
    Record<string, { personId: string; newName: string }>
  >({});
  const [faceAssignmentBusy, setFaceAssignmentBusy] = useState(false);
  const [faceAssignmentError, setFaceAssignmentError] = useState("");
  const [faceCreationBox, setFaceCreationBox] = useState<
    ImageFace["box"] | null
  >(null);
  const faceBoxDragRef = useRef<{
    faceId: string;
    photoPath: string;
    startX: number;
    startY: number;
    startBox: ImageFace["box"];
    currentBox: ImageFace["box"];
    moved: boolean;
  } | null>(null);
  const faceCreateDragRef = useRef<{
    photoPath: string;
    startX: number;
    startY: number;
    currentBox: ImageFace["box"];
  } | null>(null);
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(
    new Set(),
  );
  const [folderSelectionFile, setFolderSelectionFile] = useState<string | null>(
    null,
  );
  const [folderSelectionPaths, setFolderSelectionPaths] = useState<string[] | null>(
    null,
  );
  const [showFolderSelector, setShowFolderSelector] = useState(false);
  const [petClusters, setPetClusters] = useState<PetCluster[]>([]);
  const [petsProgress, setPetsProgress] = useState<{
    status: string;
    message: string;
  }>({
    status: "idle",
    message: "Pet clustering not yet started.",
  });
  const [dialogRequest, setDialogRequest] = useState<DialogRequest | null>(
    null,
  );
  const [dialogValue, setDialogValue] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [phoneDevices, setPhoneDevices] = useState<PhoneDevice[]>([]);
  const [phoneTooling, setPhoneTooling] = useState<PhoneTooling | null>(null);
  const [phoneScanning, setPhoneScanning] = useState(false);
  const [phoneBusyId, setPhoneBusyId] = useState<string | null>(null);
  const [phoneNotice, setPhoneNotice] = useState("");
  const [phoneBackups, setPhoneBackups] = useState<
    Record<string, PhoneBackupProgress>
  >({});
  const [phoneRestoreArchives, setPhoneRestoreArchives] = useState<
    PhoneRestoreArchive[]
  >([]);
  const [phoneBackupDestination, setPhoneBackupDestination] = useState<
    string | null
  >(null);
  const [connectedPhone, setConnectedPhone] = useState<PhoneDevice | null>(
    null,
  );
  const [googleState, setGoogleState] = useState<GoogleAccountsState | null>(
    null,
  );
  const [googleSourcesHidden, setGoogleSourcesHidden] = useState(() => {
    try {
      return localStorage.getItem("silo.googleSourcesHidden") === "true";
    } catch {
      return false;
    }
  });
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleNotice, setGoogleNotice] = useState("");
  const [googleReclaimAccountId, setGoogleReclaimAccountId] = useState<string | null>(null);
  const [pickerSession, setPickerSession] = useState<{
    accountId: string;
    sessionId: string;
  } | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<{ sources: boolean; folders: boolean; indexing: boolean }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("silo.sidebarCollapsed") || "{}");
      return { sources: saved.sources === true, folders: saved.folders === true, indexing: saved.indexing === true };
    } catch {
      return { sources: false, folders: false, indexing: false };
    }
  });
  const toggleSidebarSection = (section: "sources" | "folders" | "indexing") => {
    setSidebarCollapsed((current) => {
      const next = { ...current, [section]: !current[section] };
      try {
        localStorage.setItem("silo.sidebarCollapsed", JSON.stringify(next));
      } catch {
        // Keep the current-session preference if storage is unavailable.
      }
      return next;
    });
  };

  const togglePrimaryNavCollapsed = () => {
    setPrimaryNavCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("silo.primaryNavCollapsed", String(next));
      } catch {
        // Keep the current-session preference if storage is unavailable.
      }
      return next;
    });
  };

  const toggleLibrarySidebarCollapsed = () => {
    setLibrarySidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("silo.librarySidebarCollapsed", String(next));
      } catch {
        // Keep the current-session preference if storage is unavailable.
      }
      return next;
    });
  };

  const changeGoogleSourcesVisibility = (hidden: boolean) => {
    setGoogleSourcesHidden(hidden);
    try {
      localStorage.setItem("silo.googleSourcesHidden", String(hidden));
    } catch {
      // Keep the current-session preference if storage is unavailable.
    }
  };
  const [sources, setSources] = useState<BrowseSource[]>([]);
  const [sourceSelectionRevision, setSourceSelectionRevision] = useState(0);
  const [ejectingDeviceIds, setEjectingDeviceIds] = useState<Set<string>>(() => new Set());
  const enabledSourcePathsKey = useMemo(
    () => sources
      .filter((source) => source.enabled && source.available && source.rootPath.trim())
      .map((source) => source.rootPath)
      .sort()
      .join("\u0000"),
    [sources],
  );
  const enabledSourcePaths = useMemo(
    () => new Set(enabledSourcePathsKey.split("\u0000").filter(Boolean)),
    [enabledSourcePathsKey],
  );
  const allSourcePathsKey = useMemo(
    () => sources
      .map((source) => source.rootPath.trim())
      .filter(Boolean)
      .sort()
      .join("\u0000"),
    [sources],
  );
  const allSourcePaths = useMemo(
    () => new Set(allSourcePathsKey.split("\u0000").filter(Boolean)),
    [allSourcePathsKey],
  );
  const enabledSourcePathsRef = useRef(enabledSourcePaths);
  enabledSourcePathsRef.current = enabledSourcePaths;
  const searchSourceScopeKeyRef = useRef(enabledSourcePathsKey);
  const [showPhoneBackups, setShowPhoneBackups] = useState(false);
  const hasCachedPhoneBackups = sources.some((source) => source.offlineBackup);
  const [sourceSort, setSourceSort] = useState<"name" | "kind" | "backup">(
    "name",
  );
  const sortedSources = useMemo(() => {
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return [...sources]
      .filter((source) => showPhoneBackups || !source.offlineBackup)
      .sort((first, second) => {
      if (sourceSort === "kind") {
        const kindOrder = collator.compare(
          sourceKindLabels[first.kind],
          sourceKindLabels[second.kind],
        );
        if (kindOrder !== 0) return kindOrder;
      }
      if (sourceSort === "backup") {
        const backupOrder = (second.snapshotAt ?? 0) - (first.snapshotAt ?? 0);
        if (backupOrder !== 0) return backupOrder;
      }
      return (
        collator.compare(first.label, second.label) ||
        first.id.localeCompare(second.id)
      );
      });
  }, [showPhoneBackups, sourceSort, sources]);
  const sourcesRef = useRef<BrowseSource[]>([]);
  const sourcesRefreshRequestRef = useRef(0);
  const pendingSourceSelectionsRef = useRef(
    new Map<string, { enabled: boolean; request: number }>(),
  );
  const sourceToggleRequestRef = useRef(0);
  const applyPendingSourceSelections = useCallback((items: BrowseSource[]) =>
    items.map((source) => {
      const pending = pendingSourceSelectionsRef.current.get(source.id);
      return pending ? { ...source, enabled: pending.enabled } : source;
    }),
  []);
  const refreshSources = useCallback(async () => {
    if (!electronAPI) return;
    const request = ++sourcesRefreshRequestRef.current;
    const latest = applyPendingSourceSelections(await electronAPI.listSources());
    if (request !== sourcesRefreshRequestRef.current) return;
    sourcesRef.current = latest;
    setSources(latest);
  }, [applyPendingSourceSelections, electronAPI]);
  sourcesRef.current = sources;
  const [allSourcesPath, setAllSourcesPath] =
    useState<string>("/__sources__/all");
  const allSourcesPathRef = useRef(allSourcesPath);
  allSourcesPathRef.current = allSourcesPath;
  const [scanIssues, setScanIssues] = useState<ScanIssues | null>(null);
  const [accessIdentity, setAccessIdentity] = useState<{
    displayName: string;
    bundlePath: string;
    isDev: boolean;
  } | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    includedType: "all",
    sizeMin: 0,
    sizeMax: Infinity,
  });
  const audioOnlySelected = filters.includedType === "audio";
  const videoOnlySelected = filters.includedType === "video";
  const [magicState, setMagicState] = useState<MagicState>(emptyMagicState);
  const magicPrefs = useMagicPreferences();
  const [sort, setSort] = useState<SortState>({
    field: "name",
    ascending: true,
  });
  const sortIndicatorsRef = useRef<
    Record<string, { people: boolean; mapped: boolean }>
  >({});
  const [sortIndicatorDataRevision, setSortIndicatorDataRevision] = useState(0);
  const [sortIndicatorRevision, setSortIndicatorRevision] = useState(0);
  const metadataRevisionRef = useRef(sortIndicatorRevision);
  metadataRevisionRef.current = sortIndicatorRevision;
  const [sortIndicatorError, setSortIndicatorError] = useState("");
  const [metadataIndicatorProgress, setMetadataIndicatorProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);
  const photoIndicatorWorkRef = useRef({
    pending: new Map<string, FileInfo>(),
    active: new Set<string>(),
    completed: new Set<string>(),
    failed: new Set<string>(),
    currentFiles: new Map<string, FileInfo>(),
    currentPaths: new Set<string>(),
    currentTotal: 0,
    currentProcessed: 0,
    running: false,
    enabled: false,
    revision: sortIndicatorRevision,
    generation: 0,
  });
  const browseScanModeRef = useRef<{
    path: string;
    recursive: boolean;
  } | null>(null);
  const [peopleFilter, setPeopleFilter] = useState<MetadataFilter>("all");
  const [locationFilter, setLocationFilter] = useState<MetadataFilter>("all");
  const needsPhotoMetadata =
    !audioOnlySelected &&
    (sort.field === "people" ||
      sort.field === "mapped" ||
      peopleFilter !== "all" ||
      locationFilter !== "all");
  const needsRecursiveBrowse =
    appSection === "files" &&
    !audioOnlySelected &&
    !searchQuery.trim() &&
    !activeDigitalFolderId &&
    (showFilters || yearFilter.length > 0 || needsPhotoMetadata);
  const needsRecursiveBrowseRef = useRef(needsRecursiveBrowse);
  needsRecursiveBrowseRef.current = needsRecursiveBrowse;
  const explodedRef = useRef(exploded);
  const contentVisibilityRef = useRef(`${contentSettings.showNsfw}:0`);
  const sortRef = useRef(sort);
  const filtersRef = useRef(filters);
  const scanRequestRef = useRef(0);
  const filePreviewRequestRef = useRef(0);
  const preparedViewerImagesRef = useRef(
    new Map<string, PreparedViewerImage>(),
  );
  const viewerImageRequestsRef = useRef(
    new Map<string, Promise<PreparedViewerImage | null>>(),
  );
  const settledScanRef = useRef(0);
  const previewedScanRef = useRef<number | null>(null);
  const allSourcesLoadedRef = useRef(new Set<string>());
  const sourceScanJobsRef = useRef(new Map<string, Promise<FileInfo[]>>());
  const sourceRefreshTimerRef = useRef<number | null>(null);
  const preserveScanRequestRef = useRef<number | null>(null);
  const preserveSelectionRequestRef = useRef<number | null>(null);
  const searchRequestRef = useRef(0);
  const semanticSearchedSourcesRef = useRef<{ query: string; roots: Set<string> }>({
    query: "",
    roots: new Set(),
  });
  const fileGridRef = useRef<HTMLDivElement | null>(null);
  const fileBrowserRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (appSection !== "files" || (!audioOnlySelected && !videoOnlySelected)) return;
    const browser = fileBrowserRef.current;
    if (!browser) return;
    const measure = () => {
      const rect = browser.getBoundingClientRect();
      setMediaHostBounds((current) => {
        const next = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        return current && current.top === next.top && current.left === next.left &&
          current.width === next.width && current.height === next.height ? current : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(browser);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [appSection, audioOnlySelected, videoOnlySelected, sidebarWidth]);
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const startSidebarResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      sidebarDragRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [sidebarWidth],
  );

  const resizeSidebar = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!sidebarDragRef.current) return;
      setSidebarWidth(
        Math.max(
          200,
          Math.min(
            520,
            sidebarDragRef.current.startWidth +
              event.clientX -
              sidebarDragRef.current.startX,
          ),
        ),
      );
    },
    [],
  );

  const finishSidebarResize = useCallback(() => {
    if (!sidebarDragRef.current) return;
    sidebarDragRef.current = null;
    localStorage.setItem("silo.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(
      "silo.thumbnailSize.files",
      String(filesThumbnailSize),
    );
  }, [filesThumbnailSize]);

  useEffect(() => {
    localStorage.setItem(
      "silo.thumbnailSize.people",
      String(peopleThumbnailSize),
    );
  }, [peopleThumbnailSize]);

  useEffect(() => {
    localStorage.setItem(
      "silo.thumbnailSize.memoryBook",
      String(memoryBookThumbnailSize),
    );
  }, [memoryBookThumbnailSize]);

  useEffect(() => {
    localStorage.setItem(
      "silo.thumbnailSize.duplicates",
      String(duplicatesThumbnailSize),
    );
  }, [duplicatesThumbnailSize]);

  useEffect(() => {
    const rememberScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const scroller = target.closest<HTMLElement>("[data-retained-scroll]");
      const key = scroller?.dataset.retainedScroll;
      if (scroller && key) retainedScrollPositionsRef.current[key] = scroller.scrollTop;
    };
    document.addEventListener("scroll", rememberScroll, true);
    return () => document.removeEventListener("scroll", rememberScroll, true);
  }, []);

  useEffect(() => {
    const key = appSection;
    const scrollTop = retainedScrollPositionsRef.current[key];
    if (scrollTop === undefined || scrollTop <= 0) return;
    let frames = 0;
    let frame = 0;
    const restore = () => {
      const scroller = document.querySelector<HTMLElement>(`[data-retained-scroll="${key}"]`);
      if (scroller) {
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (maxScrollTop >= scrollTop || frames >= 180) {
          scroller.scrollTop = Math.min(scrollTop, maxScrollTop);
          return;
        }
      }
      frames += 1;
      if (frames < 181) frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [appSection]);

  useEffect(() => {
    if (!typeFilterOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!typeFilterRef.current?.contains(event.target as Node))
        setTypeFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTypeFilterOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [typeFilterOpen]);

  useEffect(() => {
    localStorage.setItem("silo.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);
  const activeDigitalFolderIdRef = useRef(activeDigitalFolderId);
  activeDigitalFolderIdRef.current = activeDigitalFolderId;

  useEffect(() => {
    explodedRef.current = exploded;
  }, [exploded]);

  useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    void electronAPI
      .getContentSettings()
      .then((settings) => active && setContentSettings(settings));
    const removeListener = electronAPI.onContentSettingsChanged((settings) => {
      if (active) setContentSettings(settings);
    });
    return () => {
      active = false;
      removeListener();
    };
  }, [electronAPI]);

  useEffect(() => {
    if (
      !electronAPI?.completeStartupPresentation ||
      startupPresentationSignaledRef.current ||
      !startupState.ready ||
      !hydrated
    )
      return;
    startupPresentationSignaledRef.current = true;
    void electronAPI.completeStartupPresentation().then((finished) => {
      if (!finished) startupPresentationSignaledRef.current = false;
    }).catch(() => {
      startupPresentationSignaledRef.current = false;
    });
  }, [electronAPI, hydrated, startupState.ready]);

  useEffect(() => {
    if (!electronAPI?.onDemoLimitReached) return;
    return electronAPI.onDemoLimitReached(() => {
      setSettingsTourTarget('[data-tour="settings-license"]');
      setShowSettings(true);
      setLifetimePromptRequest((request) => request + 1);
    });
  }, [electronAPI]);

  useEffect(() => {
    if (!electronAPI?.isDemoMode) return;
    let active = true;
    const refreshDemoMode = () =>
      void electronAPI
        .isDemoMode()
        .then((enabled) => {
          if (active) setDemoModeActive(enabled);
        })
        .catch(() => {
          if (active) setDemoModeActive(null);
        });
    refreshDemoMode();
    const removeAccessListener = electronAPI.onLifetimeAccessChanged?.(
      refreshDemoMode,
    );
    return () => {
      active = false;
      removeAccessListener?.();
    };
  }, [electronAPI]);

  useEffect(() => {
    if (!electronAPI) return;
    return electronAPI.onContentSafetyChanged((change) => {
      const bannedAdded = change.hiddenPaths ?? [];
      const bannedRemoved = change.unhiddenPaths ?? [];
      const folderAdded = change.folderHiddenPaths ?? [];
      const folderRemoved = change.folderUnhiddenPaths ?? [];
      const hasPathDelta =
        change.hiddenPaths !== undefined ||
        change.unhiddenPaths !== undefined ||
        change.folderHiddenPaths !== undefined ||
        change.folderUnhiddenPaths !== undefined;
      if (!hasPathDelta) {
        setContentSafetyRevision((revision) => revision + 1);
        return;
      }
      if (bannedRemoved.length > 0 || change.unhiddenCount) {
        const removed = new Set(bannedRemoved);
        const next =
          change.unhiddenCount && bannedRemoved.length === 0
            ? new Set<string>()
            : new Set(
                Array.from(bannedHiddenPathsRef.current).filter(
                  (filePath) => !removed.has(filePath),
                ),
              );
        bannedHiddenPathsRef.current = next;
        setBannedHiddenPaths(next);
        setContentSafetyRevision((revision) => revision + 1);
      }
      if (folderRemoved.length > 0) {
        const removed = new Set(folderRemoved);
        const next = new Set(
          Array.from(folderHiddenPathsRef.current).filter(
            (filePath) => !removed.has(filePath),
          ),
        );
        folderHiddenPathsRef.current = next;
        setFolderHiddenPaths(next);
        setContentSafetyRevision((revision) => revision + 1);
      }
      const hiddenSet = new Set([...bannedAdded, ...folderAdded]);
      if (hiddenSet.size === 0) return;
      const folderHiddenSet = new Set(folderAdded);
      const keepCurrentFolderContents = Boolean(
        change.folderId && activeDigitalFolderIdRef.current === change.folderId,
      );
      const removeFromCurrentFiles = keepCurrentFolderContents
        ? new Set(bannedAdded)
        : hiddenSet;
      const browser = fileBrowserRef.current;
      const originalScrollTop = browser?.scrollTop ?? 0;
      const browserTop = browser?.getBoundingClientRect().top ?? 0;
      const anchor = browser
        ? Array.from(
            browser.querySelectorAll<HTMLElement>("[data-file-path]"),
          ).find((element) => {
            const path = element.dataset.filePath;
            return Boolean(
              path &&
              !removeFromCurrentFiles.has(path) &&
              element.getBoundingClientRect().bottom > browserTop,
            );
          })
        : undefined;
      const anchorPath = anchor?.dataset.filePath;
      const anchorTop = anchor?.getBoundingClientRect().top;
      // Hide paths in place so the current view and scroll position remain stable.
      const keep = <T extends { path: string }>(items: T[]) =>
        items.some((item) => hiddenSet.has(item.path))
          ? items.filter((item) => !hiddenSet.has(item.path))
          : items;
      const nextBanned = new Set(bannedHiddenPathsRef.current);
      bannedAdded.forEach((filePath) => nextBanned.add(filePath));
      const removedBanned = new Set(bannedRemoved);
      removedBanned.forEach((filePath) => nextBanned.delete(filePath));
      bannedHiddenPathsRef.current = nextBanned;
      setBannedHiddenPaths(nextBanned);
      const nextFolderHidden = new Set(folderHiddenPathsRef.current);
      folderAdded.forEach((filePath) => nextFolderHidden.add(filePath));
      const removedFolder = new Set(folderRemoved);
      removedFolder.forEach((filePath) => nextFolderHidden.delete(filePath));
      folderHiddenPathsRef.current = nextFolderHidden;
      setFolderHiddenPaths(nextFolderHidden);
      setFiles((items) =>
        items.some((item) => removeFromCurrentFiles.has(item.path))
          ? items.filter((item) => !removeFromCurrentFiles.has(item.path))
          : items,
      );
      setSearchResults(keep);
      setPersonSuggestions(keep);
      const hiddenFromPerson =
        personDetailRef.current?.status === "banned"
          ? folderHiddenSet
          : hiddenSet;
      setPersonPhotos((items) =>
        items.some((item) => hiddenFromPerson.has(item.path))
          ? items.filter((item) => !hiddenFromPerson.has(item.path))
          : items,
      );
      setViewerScopeFiles((current) => current && keep(current));
      setDuplicateState((current) => ({
        ...current,
        groups: current.groups.flatMap((group) => {
          const remaining = group.files.filter(
            (file) => !hiddenSet.has(file.path),
          );
          if (remaining.length < 2) return [];
          return [
            {
              ...group,
              files: remaining,
              keepPath: remaining.some((file) => file.path === group.keepPath)
                ? group.keepPath
                : remaining[0].path,
              reclaimableBytes: remaining
                .filter((file) => file.path !== group.keepPath)
                .reduce((total, file) => total + file.size, 0),
            },
          ];
        }),
      }));
      setSelectedFilePaths((current) =>
        Array.from(current).some((filePath) => hiddenSet.has(filePath))
          ? new Set(
              Array.from(current).filter(
                (filePath) => !hiddenSet.has(filePath),
              ),
            )
          : current,
      );
      setSelectedFile((current) => {
        if (!current || !hiddenSet.has(current.path)) return current;
        setFilePreview(null);
        setViewerOpen(false);
        return null;
      });
      window.requestAnimationFrame(() => {
        const currentBrowser = fileBrowserRef.current;
        if (!currentBrowser) return;
        const currentAnchor = anchorPath
          ? Array.from(
              currentBrowser.querySelectorAll<HTMLElement>("[data-file-path]"),
            ).find((element) => element.dataset.filePath === anchorPath)
          : undefined;
        if (currentAnchor && anchorTop !== undefined) {
          currentBrowser.scrollTop +=
            currentAnchor.getBoundingClientRect().top - anchorTop;
        } else {
          currentBrowser.scrollTop = originalScrollTop;
        }
      });
    });
  }, [electronAPI]);

  useEffect(() => {
    if (contentSettings.showBannedPeople) {
      bannedHiddenPathsRef.current = new Set();
      setBannedHiddenPaths(new Set());
    }
  }, [contentSettings.showBannedPeople]);

  useEffect(() => {
    document.documentElement.dataset.theme = contentSettings.theme;
  }, [contentSettings.theme]);

  useEffect(() => {
    if (!hydrated || startupTourChecked.current) return;
    startupTourChecked.current = true;
    if (showTourAtStartup) setShowGuidedTour(true);
  }, [hydrated, showTourAtStartup]);

  useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    const showDiagnosticReport = (report: DiagnosticReport | null) => {
      if (!active || !report) return;
      setIndexingDiagnosticReport(report);
      setShowBugReport(true);
    };
    const removeListener = electronAPI.onDiagnosticReport((report) =>
      showDiagnosticReport(report),
    );
    void electronAPI
      .getPendingDiagnosticReport()
      .then(showDiagnosticReport)
      .catch(() => undefined);
    return () => {
      active = false;
      removeListener();
    };
  }, [electronAPI]);

  useEffect(() => {
    if (!showBugReportToast) return;
    setBugReportToastFading(false);
    const fadeTimer = window.setTimeout(() => setBugReportToastFading(true), 3000);
    const closeTimer = window.setTimeout(() => setShowBugReportToast(false), 4000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(closeTimer);
    };
  }, [showBugReportToast]);

  const updateShowTourAtStartup = useCallback((show: boolean) => {
    setShowTourAtStartup(show);
    try {
      localStorage.setItem("silo.guidedTour.showAtStartup", String(show));
    } catch {
      return;
    }
  }, []);

  const navigateGuidedTour = useCallback((section: GuidedTourSection, step: GuidedTourStep) => {
    if (section === "mobile" && step.target === '[data-tour="mobile-message-workflow"]')
      setMobileMessagesHelpRequest((request) => request + 1);
    setTourDuplicateView(section === "duplicates"
      ? step.target === '[data-tour="duplicate-trash-actions"]' ? "trash" : "duplicates"
      : null);
    if (section === "settings") {
      setSettingsTourTarget(step.target);
      setShowSettings(true);
      return;
    }
    setSettingsTourTarget(null);
    setShowSettings(false);
    setAppSection(section);
  }, []);

  const startGuidedTour = useCallback(() => {
    setTourContextStep(null);
    setShowLocalHelp(false);
    setShowTourExitConfirm(false);
    setShowGuidedTour(true);
  }, []);

  const closeGuidedTour = useCallback(() => {
    setShowGuidedTour(false);
    if (!startupState.ready) setShowTourExitConfirm(true);
  }, [startupState.ready]);

  const handleBugReportSubmitted = useCallback(() => {
    if (indexingDiagnosticReport)
      void electronAPI?.dismissDiagnosticReport(indexingDiagnosticReport.id);
    setIndexingDiagnosticReport(null);
    setShowBugReport(false);
    setSelectingBugReportScreenshot(false);
    let hideThanks = false;
    try {
      hideThanks = localStorage.getItem("silo.hideBugReportThanks") === "true";
    } catch {
      hideThanks = false;
    }
    if (hideThanks) setShowBugReportToast(true);
    else setShowBugThanks(true);
  }, [electronAPI, indexingDiagnosticReport]);

  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const markThumbnailLoaded = useCallback((filePath: string, file: FileInfo) => {
    loadedThumbnailFilesRef.current.set(filePath, file);
    pendingLoadedThumbnails.current.add(filePath);
    if (thumbnailCountTimer.current !== null) return;
    thumbnailCountTimer.current = window.setTimeout(() => {
      thumbnailCountTimer.current = null;
      const paths = pendingLoadedThumbnails.current;
      pendingLoadedThumbnails.current = new Set();
      setLoadedThumbnailPaths((current) => {
        if (Array.from(paths).every((path) => current.has(path)))
          return current;
        const next = new Set(current);
        paths.forEach((path) => next.add(path));
        return next;
      });
    }, 750);
  }, []);

  const clearFileSelection = useCallback(() => {
    setSelectedFilePaths(new Set());
    setSelectedFile(null);
    setFilePreview(null);
    setViewerOpen(false);
  }, []);

  const openDialog = useCallback((request: DialogRequest) => {
    setDialogRequest(request);
    setDialogValue(request.initialValue || "");
    setDialogError("");
    setDialogBusy(false);
  }, []);

  const closeDialog = useCallback(() => {
    if (dialogBusy) return;
    setDialogRequest(null);
    setDialogError("");
  }, [dialogBusy]);

  const submitDialog = useCallback(async () => {
    if (!dialogRequest || dialogBusy) return;
    const value = dialogValue.trim();
    if (dialogRequest.mode === "text" && !value) {
      setDialogError("Enter a name.");
      return;
    }
    setDialogBusy(true);
    setDialogError("");
    try {
      await dialogRequest.onConfirm(value);
      setDialogRequest(null);
    } catch (error) {
      setDialogError(
        error instanceof Error
          ? error.message
          : "The operation could not be completed.",
      );
    } finally {
      setDialogBusy(false);
    }
  }, [dialogBusy, dialogRequest, dialogValue]);

  const applyPersistedState = useCallback((state: PersistedAppState) => {
    setShowHiddenMessages(state.ui.showHiddenMessages ?? false);
    setDigitalFolders(state.digitalFolders);
    setMediaPlaylists(state.mediaPlaylists ?? []);
    const hiddenPaths = new Set<string>();
    state.digitalFolders
      .filter((folder) => folder.hidden)
      .forEach((folder) =>
        folder.filePaths.forEach((filePath) => hiddenPaths.add(filePath)),
      );
    const currentHidden = folderHiddenPathsRef.current;
    if (
      currentHidden.size !== hiddenPaths.size ||
      Array.from(hiddenPaths).some((filePath) => !currentHidden.has(filePath))
    ) {
      folderHiddenPathsRef.current = hiddenPaths;
      setFolderHiddenPaths(hiddenPaths);
    }
    const nextMetadata = state.fileMetadata || {};
    setFileMetadata((current) =>
      JSON.stringify(current) === JSON.stringify(nextMetadata)
        ? current
        : nextMetadata,
    );
    const nextSearchFeedback = state.searchFeedback ?? {};
    setSearchFeedback((current) =>
      JSON.stringify(current) === JSON.stringify(nextSearchFeedback)
        ? current
        : nextSearchFeedback,
    );
    if (state.indexProgress) setIndexProgress(state.indexProgress);
  }, []);

  const createMediaPlaylist = useCallback(async (name: string, kind: "audio" | "video") => {
    if (!electronAPI) return null;
    try {
      const state = await electronAPI.createMediaPlaylist(name, kind);
      applyPersistedState(state);
      return state.mediaPlaylists.at(-1)?.id ?? null;
    } catch (cause) {
      setSearchError(cause instanceof Error ? cause.message : "Could not create playlist.");
      return null;
    }
  }, [applyPersistedState, electronAPI]);
  const addToMediaPlaylist = useCallback(async (playlistId: string, filePath: string) => {
    if (!electronAPI) return;
    try { applyPersistedState(await electronAPI.addMediaPlaylistFiles(playlistId, [filePath])); }
    catch (cause) { setSearchError(cause instanceof Error ? cause.message : "Could not update playlist."); }
  }, [applyPersistedState, electronAPI]);
  const removeFromMediaPlaylist = useCallback(async (playlistId: string, filePath: string) => {
    if (!electronAPI) return;
    try { applyPersistedState(await electronAPI.removeMediaPlaylistFile(playlistId, filePath)); }
    catch (cause) { setSearchError(cause instanceof Error ? cause.message : "Could not update playlist."); }
  }, [applyPersistedState, electronAPI]);
  const deleteMediaPlaylist = useCallback(async (playlistId: string) => {
    if (!electronAPI) return;
    try { applyPersistedState(await electronAPI.deleteMediaPlaylist(playlistId)); }
    catch (cause) { setSearchError(cause instanceof Error ? cause.message : "Could not delete playlist."); }
  }, [applyPersistedState, electronAPI]);

  const updateHiddenMessageVisibility = useCallback(
    async (show: boolean) => {
      if (!electronAPI) return;
      try {
        applyPersistedState(
          await electronAPI.updateUiState({ showHiddenMessages: show }),
        );
      } catch (error) {
        console.error("Could not save message display preference:", error);
      }
    },
    [applyPersistedState, electronAPI],
  );

  const rememberSearchResultOrder = useCallback(
    (results: readonly { path: string }[], query: string) => {
      const cleanQuery = query.trim();
      if (!cleanQuery) return;
      const current = searchResultOrderRef.current;
      const paths = current.query === cleanQuery ? current.paths : [];
      const seen = new Set(paths);
      let changed = current.query !== cleanQuery;
      for (const result of results) {
        if (seen.has(result.path)) continue;
        seen.add(result.path);
        paths.push(result.path);
        changed = true;
      }
      if (!changed) return;
      searchResultOrderRef.current = { query: cleanQuery, paths };
      setSearchResultOrder(paths.slice());
    },
    [],
  );

  const favoritePaths = useMemo(
    () =>
      new Set(
        digitalFolders.find((folder) => folder.id === FAVORITES_FOLDER_ID)
          ?.filePaths ?? [],
      ),
    [digitalFolders],
  );

  const toggleFavorite = useCallback(
    async (filePath: string) => {
      if (!electronAPI) return;
      const wasFavorite = favoritePaths.has(filePath);
      applyPersistedState(
        wasFavorite
          ? await electronAPI.removeDigitalFolderReference(
              FAVORITES_FOLDER_ID,
              filePath,
            )
          : await electronAPI.addDigitalFolderReference(
              FAVORITES_FOLDER_ID,
              filePath,
            ),
      );
      clearFileSelection();
      if (wasFavorite && activeDigitalFolderId === FAVORITES_FOLDER_ID)
        setFiles((current) => current.filter((file) => file.path !== filePath));
    },
    [
      activeDigitalFolderId,
      applyPersistedState,
      clearFileSelection,
      electronAPI,
      favoritePaths,
    ],
  );

  const loadDirectory = useCallback(
    async (
      directoryPath: string,
      explodedMode = explodedRef.current,
      preserveView = false,
      streamWhilePreserving = false,
    ) => {
      if (!electronAPI) return;
      const requestId = ++scanRequestRef.current;
      const scanRecursively =
        explodedMode || needsRecursiveBrowseRef.current;
      browseScanModeRef.current = {
        path: directoryPath,
        recursive: scanRecursively,
      };
      preserveScanRequestRef.current =
        preserveView && !streamWhilePreserving ? requestId : null;
      preserveSelectionRequestRef.current = preserveView ? requestId : null;
      const scannedSourceIds =
        directoryPath === allSourcesPathRef.current && scanRecursively
          ? sourcesRef.current
              .filter((source) => source.enabled && source.available)
              .map((source) => source.id)
          : [];
      setLoading(true);
      setBrowseError("");
      if (thumbnailCountTimer.current !== null)
        window.clearTimeout(thumbnailCountTimer.current);
      thumbnailCountTimer.current = null;
      pendingLoadedThumbnails.current.clear();
      if (!preserveView) setFiles([]);
      if (!preserveView) setLoadedThumbnailPaths(new Set());
      setFileScanProgress(null);
      try {
        const inventory = await electronAPI.getFiles(
          directoryPath,
          scanRecursively,
          requestId,
          {
            sortField: sortRef.current.field,
            sortAscending: sortRef.current.ascending,
            includedType: filtersRef.current.includedType,
            sizeMin: filtersRef.current.sizeMin,
            sizeMax: filtersRef.current.sizeMax,
          },
        );
        const nextFiles = await readInventory<FileInfo>(
          electronAPI,
          inventory,
          () => requestId !== scanRequestRef.current,
        );
        if (requestId !== scanRequestRef.current) return;
        settledScanRef.current = requestId;
        if (directoryPath === allSourcesPathRef.current && scanRecursively) {
          scannedSourceIds.forEach((sourceId) =>
            allSourcesLoadedRef.current.add(sourceId),
          );
        }
        const browser = preserveView ? fileBrowserRef.current : null;
        const browserTop = browser?.getBoundingClientRect().top ?? 0;
        const anchor = browser
          ? Array.from(
              browser.querySelectorAll<HTMLElement>("[data-file-path]"),
            ).find(
              (element) => element.getBoundingClientRect().bottom > browserTop,
            )
          : undefined;
        const anchorPath = anchor?.dataset.filePath;
        const anchorTop = anchor?.getBoundingClientRect().top;
        const scrollTop = browser?.scrollTop ?? 0;
        setFiles(nextFiles);
        if (preserveView) {
          const validPaths = new Set(nextFiles.map((file) => file.path));
          setLoadedThumbnailPaths((current) => {
            const next = new Set(
              Array.from(current).filter((filePath) =>
                validPaths.has(filePath),
              ),
            );
            return next.size === current.size ? current : next;
          });
        }
        if (preserveScanRequestRef.current === requestId)
          preserveScanRequestRef.current = null;
        if (browser)
          window.requestAnimationFrame(() => {
            const currentBrowser = fileBrowserRef.current;
            if (!currentBrowser) return;
            const currentAnchor = anchorPath
              ? Array.from(
                  currentBrowser.querySelectorAll<HTMLElement>(
                    "[data-file-path]",
                  ),
                ).find((element) => element.dataset.filePath === anchorPath)
              : undefined;
            if (currentAnchor && anchorTop !== undefined)
              currentBrowser.scrollTop +=
                currentAnchor.getBoundingClientRect().top - anchorTop;
            else currentBrowser.scrollTop = scrollTop;
          });
        setActiveDigitalFolderId(null);
        if (!preserveView) {
          setSelectedFile(null);
          setFilePreview(null);
          setViewerOpen(false);
        }
      } catch (error) {
        if (requestId === scanRequestRef.current)
          setBrowseError(
            `Could not load ${directoryPath}. Check that the source is connected and accessible, then retry. ${error instanceof Error ? error.message : String(error)}`,
          );
      } finally {
        if (preserveScanRequestRef.current === requestId)
          preserveScanRequestRef.current = null;
        if (preserveSelectionRequestRef.current === requestId)
          preserveSelectionRequestRef.current = null;
        if (requestId === scanRequestRef.current) setLoading(false);
      }
    },
    [electronAPI],
  );

  useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    const removeListener = electronAPI.onStartupProgress((state) => {
      if (active) setStartupState(state);
    });
    void electronAPI.getStartupState().then((state) => {
      if (active)
        setStartupState((current) =>
          current.step > state.step ? current : state,
        );
    });
    return () => {
      active = false;
      removeListener();
    };
  }, [electronAPI]);

  useEffect(() => {
    if (
      !hydrated ||
      !electronAPI ||
      appSection !== "files" ||
      !currentPath ||
      activeDigitalFolderId
    )
      return;
    const expectedRecursive = exploded || needsRecursiveBrowse;
    const currentScan = browseScanModeRef.current;
    if (
      currentScan?.path === currentPath &&
      currentScan.recursive === expectedRecursive
    )
      return;
    void loadDirectory(currentPath, exploded, true, true);
  }, [
    activeDigitalFolderId,
    appSection,
    currentPath,
    electronAPI,
    exploded,
    hydrated,
    loadDirectory,
    needsRecursiveBrowse,
  ]);

  useEffect(() => {
    if (!electronAPI?.onThumbnailPregenProgress) return;
    const applyProgress = (progress: ThumbnailPregenProgress | null) => {
      if (!progress) return;
      const previous = lastThumbnailPregenStatusRef.current;
      if (progress.status === "scanning" && previous !== "scanning")
        setThumbnailPregenDismissed(false);
      lastThumbnailPregenStatusRef.current = progress.status;
      setThumbnailPregen(progress);
    };
    void electronAPI
      .getThumbnailPregenProgress()
      .then(applyProgress)
      .catch(() => undefined);
    return electronAPI.onThumbnailPregenProgress(applyProgress);
  }, [electronAPI]);

  useEffect(() => {
    if (!electronAPI?.getIndexStorageStatus || !electronAPI.onIndexStorageStatus)
      return;
    let disposed = false;
    const applyStatus = (status: IndexStorageStatus) => {
      if (!disposed) setIndexStorageStatus(status);
    };
    const removeListener = electronAPI.onIndexStorageStatus(applyStatus);
    void electronAPI.getIndexStorageStatus().then(applyStatus).catch(() => undefined);
    return () => {
      disposed = true;
      removeListener();
    };
  }, [electronAPI]);

  useEffect(() => {
    if (
      !electronAPI?.getSearchIndexReadiness ||
      !electronAPI.onSearchIndexReadiness
    )
      return;
    let disposed = false;
    const applyReadiness = (status: SearchIndexReadiness) => {
      if (!disposed) setSearchIndexReadiness(status);
    };
    const removeListener = electronAPI.onSearchIndexReadiness(applyReadiness);
    void electronAPI
      .getSearchIndexReadiness()
      .then(applyReadiness)
      .catch(() => undefined);
    return () => {
      disposed = true;
      removeListener();
    };
  }, [electronAPI]);

  useEffect(() => {
    const previousStatus = searchIndexPreviousStatusRef.current;
    searchIndexPreviousStatusRef.current = searchIndexReadiness.status;
    const query = searchQuery.trim();
    if (previousStatus !== "ready" && searchIndexReadiness.status === "ready" && query)
      searchQueryStartedAtRef.current = {
        query,
        startedAt: performance.now(),
      };
  }, [searchIndexReadiness.status, searchQuery]);

  useEffect(() => {
    if (!electronAPI) return;
    let cancelled = false;
    const sourceRequest = ++sourcesRefreshRequestRef.current;
    const removeProgressListener =
      electronAPI.onIndexProgress(setIndexProgress);
    void Promise.all([
      electronAPI.getAppState(),
      electronAPI.listSources(),
      electronAPI.getAllSourcesPath(),
    ])
      .then(async ([state, availableSources, aggregatePath]) => {
        if (cancelled) return;
        const activeSources =
          sourceRequest === sourcesRefreshRequestRef.current
            ? applyPendingSourceSelections(availableSources)
            : sourcesRef.current;
        if (sourceRequest === sourcesRefreshRequestRef.current) {
          sourcesRef.current = activeSources;
          setSources(activeSources);
        }
        applyPersistedState(state);
        setAllSourcesPath(aggregatePath);
        setSort({
          field: state.ui.sortField,
          ascending: state.ui.sortAscending,
        });
        setFilters((current) => ({
          ...current,
          includedType: state.ui.includedType,
        }));
        setViewMode(state.ui.viewMode);
        setShowFilters(state.ui.showFilters);
        const confidenceMigrationKey = "silo.search-confidence-default.v1";
        let restoredConfidence = state.ui.confidence;
        try {
          if (localStorage.getItem(confidenceMigrationKey) !== "25") {
            restoredConfidence = DEFAULT_SEMANTIC_SEARCH_CONFIDENCE;
            localStorage.setItem(confidenceMigrationKey, "25");
          }
        } catch {
          restoredConfidence = DEFAULT_SEMANTIC_SEARCH_CONFIDENCE;
        }
        setConfidence(restoredConfidence);
        const persistedPath = state.ui.currentPath;
        const pathIsAvailable = activeSources.some(
          (source) =>
            source.enabled &&
            source.available &&
            (persistedPath === source.rootPath ||
              persistedPath?.startsWith(`${source.rootPath}/`)),
        );
        const pathToLoad =
          persistedPath && (persistedPath === aggregatePath || pathIsAvailable)
            ? persistedPath
            : aggregatePath;
        const nextExploded =
          state.ui.exploded && pathToLoad !== aggregatePath;
        // Restoring an exploded All Sources view triggers a full recursive walk
        // of every library during startup. Open the source roots first so search
        // hydration and normal app use do not compete with that walk.
        setExploded(nextExploded);
        setCurrentPath(pathToLoad);
        setNavigationHistory([{ type: "path", value: pathToLoad }]);
        setHistoryIndex(0);
        // Show the app shell once the saved state and source list are restored.
        // A slow or unavailable directory scan must not keep the startup window
        // in front of cache recovery and source controls.
        if (!cancelled) setHydrated(true);
        await loadDirectory(pathToLoad, nextExploded);
      })
      .catch((error) => {
        if (cancelled) return;
        setBrowseError(
          `Could not restore the library. Select a source to continue browsing. ${error instanceof Error ? error.message : String(error)}`,
        );
        setHydrated(true);
      });
    return () => {
      cancelled = true;
      removeProgressListener();
    };
  }, [applyPendingSourceSelections, applyPersistedState, electronAPI, loadDirectory]);

  useEffect(() => {
    if (!electronAPI) return;
    let pendingRequestId: number | null = null;
    let pendingDeltas = new Map<string, FileInfo>();
    let flushTimer: number | null = null;
    let lastProgressUiUpdateAt = 0;
    const flushDeltas = () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = null;
      const requestId = pendingRequestId;
      if (requestId === null) return;
      const deltas = Array.from(pendingDeltas.values());
      pendingRequestId = null;
      pendingDeltas = new Map();
      if (
        deltas.length === 0 ||
        requestId !== scanRequestRef.current ||
        settledScanRef.current === requestId ||
        preserveScanRequestRef.current === requestId
      )
        return;
      setFiles((current) => {
        const merged = new Map(current.map((file) => [fileListKey(file), file]));
        for (const file of deltas) merged.set(fileListKey(file), file);
        return Array.from(merged.values());
      });
    };
    const removeProgressListener = electronAPI.onFileScanProgress((progress) => {
      if (progress.requestId !== scanRequestRef.current) return;
      const now = performance.now();
      if (progress.done || now - lastProgressUiUpdateAt >= 2500) {
        lastProgressUiUpdateAt = now;
        setFileScanProgress(progress);
      }
      const query = searchQueryRef.current.trim().toLocaleLowerCase();
      if (query && progress.fileDeltas?.length)
        scheduleFastFileMatchesRef.current(
          progress.fileDeltas,
          query,
          fastFileSearchGenerationRef.current,
        );
      // The initial library scan can continue for a long time. Let the Files
      // view become usable as soon as it has its first results instead of
      // keeping the startup overlay up until the complete inventory arrives.
      if (
        progress.done ||
        Boolean(progress.files?.length) ||
        Boolean(progress.fileDeltas?.length)
      )
        setHydrated(true);
      if (
        progress.files &&
        progress.files.length > 0 &&
        previewedScanRef.current !== progress.requestId &&
        settledScanRef.current !== progress.requestId &&
        preserveScanRequestRef.current !== progress.requestId
      ) {
        previewedScanRef.current = progress.requestId;
        setFiles(progress.files);
        if (progress.inventory) {
          const requestId = progress.requestId;
          void readInventory<FileInfo>(
            electronAPI,
            progress.inventory,
            () =>
              requestId !== scanRequestRef.current ||
              settledScanRef.current === requestId,
            )
            .then((cached) => {
              if (
                requestId === scanRequestRef.current &&
                settledScanRef.current !== requestId &&
                cached.length
              )
                setFiles((current) => {
                  const merged = new Map(cached.map((file) => [fileListKey(file), file]));
                  for (const file of current) merged.set(fileListKey(file), file);
                  return Array.from(merged.values());
                });
              if (requestId === scanRequestRef.current && cached.length) {
                const query = searchQueryRef.current
                  .trim()
                  .toLocaleLowerCase();
                if (query)
                  scheduleFastFileMatchesRef.current(
                    cached,
                    query,
                    fastFileSearchGenerationRef.current,
                  );
              }
            })
            .catch((cause) =>
              console.error("Cached inventory transfer failed", cause),
            );
        }
      }
      if (
        progress.fileDeltas?.length &&
        settledScanRef.current !== progress.requestId &&
        preserveScanRequestRef.current !== progress.requestId
      ) {
        if (pendingRequestId !== progress.requestId) {
          if (flushTimer !== null) window.clearTimeout(flushTimer);
          flushTimer = null;
          pendingRequestId = progress.requestId;
          pendingDeltas.clear();
        }
        for (const file of progress.fileDeltas)
          pendingDeltas.set(file.path, file);
        if (pendingDeltas.size >= 2000) flushDeltas();
        else if (flushTimer === null)
          flushTimer = window.setTimeout(flushDeltas, 500);
      }
      if (progress.done) flushDeltas();
    });
    return () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      removeProgressListener();
    };
  }, [electronAPI]);

  useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    void electronAPI
      .getDuplicateState()
      .then((state) => active && setDuplicateState(state));
    const removeListener = electronAPI.onDuplicateProgress((state) => {
      if (active) setDuplicateState(state);
    });
    return () => {
      active = false;
      removeListener();
    };
  }, [electronAPI]);

  const redundantDuplicatePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const group of duplicateState.groups) {
      for (const file of group.files)
        if (file.path !== group.keepPath) paths.add(file.path);
    }
    return paths;
  }, [duplicateState.groups]);
  const allHiddenPaths = useMemo(
    () =>
      new Set(
        Array.from(bannedHiddenPaths).concat(Array.from(folderHiddenPaths)),
      ),
    [bannedHiddenPaths, folderHiddenPaths],
  );

  const uniquePersonPhotos = useMemo(() => {
    const confirmed = new Set(personDetail?.confirmedPhotoPaths ?? []);
    return personPhotos
      .filter((photo) => !redundantDuplicatePaths.has(photo.path))
      .sort(
        (first, second) =>
          Number(confirmed.has(second.path)) -
            Number(confirmed.has(first.path)) ||
          compareFilesBySort(
            first,
            second,
            sort,
            magicState.ranks,
            sortIndicatorsRef.current,
          ),
      );
  }, [
    magicState.ranks,
    personDetail?.confirmedPhotoPaths,
    personPhotos,
    redundantDuplicatePaths,
    sort,
    sortIndicatorDataRevision,
  ]);

  const refreshPeople = useCallback(async () => {
    if (!electronAPI) return;
    const state = await electronAPI.getFaceState();
    setFaceProgress(state.progress);
    setPeople(state.people);
  }, [electronAPI]);

  useEffect(() => {
    if (!electronAPI) return;
    void refreshPeople();
    const removeListener = electronAPI.onFaceIndexProgress((progress) => {
      setFaceProgress(progress);
      if (progress.status === "error") setFaceActionNotice(null);
      if (progress.processed % 25 === 0 || progress.status === "complete")
        void refreshPeople();
    });
    return removeListener;
  }, [electronAPI, refreshPeople]);

  const refreshPets = useCallback(async () => {
    if (!electronAPI) return;
    const state = await electronAPI.getPetState();
    setPetsProgress(state.progress);
    setPetClusters(state.clusters);
  }, [electronAPI]);

  useEffect(() => {
    if (!electronAPI) return;
    void refreshPets();
    const removeListener = electronAPI.onPetProgress((progress) => {
      setPetsProgress(progress);
      if (progress.processed % 25 === 0 || progress.status === "complete")
        void refreshPets();
    });
    return removeListener;
  }, [electronAPI, refreshPets]);

  useEffect(() => {
    if (!hydrated || !electronAPI) return;
    const timer = window.setTimeout(() => {
      void electronAPI.updateUiState({
        currentPath,
        exploded,
        sortField: sort.field,
        sortAscending: sort.ascending,
        includedType: filters.includedType,
        viewMode,
        showFilters,
        confidence,
      }, {
        section: appSection,
        searchActive: searching,
        viewerOpen,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    appSection,
    confidence,
    currentPath,
    electronAPI,
    exploded,
    filters.includedType,
    hydrated,
    showFilters,
    searching,
    sort,
    viewerOpen,
    viewMode,
  ]);

  const selectDirectory = useCallback(async () => {
    if (!electronAPI) return;
    const directoryPath = await electronAPI.selectDirectory({
      title: "Open folder",
      defaultPath: currentPath || null,
    });
    if (!directoryPath) return;
    setCurrentPath(directoryPath);
    setNavigationHistory([{ type: "path", value: directoryPath }]);
    setHistoryIndex(0);
    setActiveDigitalFolderId(null);
    await loadDirectory(directoryPath);
  }, [currentPath, electronAPI, loadDirectory]);

  const scanForPhones = useCallback(async () => {
    if (!electronAPI) return;
    setPhoneScanning(true);
    setPhoneNotice("");
    try {
      const [tooling, devices] = await Promise.all([
        electronAPI.getPhoneTooling(),
        electronAPI.scanPhones(),
      ]);
      setPhoneTooling(tooling);
      setPhoneDevices(devices);
      await refreshSources();
      if (devices.length === 0) {
        const missingTools = [
          ...tooling.ios.missing,
          ...tooling.android.missing,
        ];
        setPhoneNotice(
          !tooling.ios.available && !tooling.android.available
            ? `Phone scanning is unavailable. Missing device tools: ${missingTools.join(", ")}.`
            : "No phone detected. Connect one over USB and unlock it.",
        );
      } else {
        const needsTrust = devices.find(
          (device) => device.status === "untrusted" || device.status === "unauthorized",
        );
        setPhoneNotice(
          needsTrust?.message ||
            `Found ${devices.length} connected ${devices.length === 1 ? "device" : "devices"}. Scanning did not start a backup.`,
        );
      }
    } catch (error) {
      setPhoneNotice(
        error instanceof Error ? error.message : "Could not scan for phones.",
      );
    } finally {
      setPhoneScanning(false);
    }
  }, [electronAPI, refreshSources]);

  const browsePhone = useCallback(
    async (device: PhoneDevice) => {
      if (!device.rootPath) return;
      setConnectedPhone(device);
      setCurrentPath(device.rootPath);
      setNavigationHistory([{ type: "path", value: device.rootPath }]);
      setHistoryIndex(0);
      setActiveDigitalFolderId(null);
      setAppSection("files");
      await loadDirectory(device.rootPath);
    },
    [loadDirectory],
  );

  const connectPhone = useCallback(
    async (device: PhoneDevice) => {
      if (!electronAPI) return;
      setPhoneBusyId(device.id);
      setPhoneNotice(
        device.platform === "ios"
          ? "Unlock the iPhone and tap Trust This Computer if prompted."
          : "Unlock the phone and tap Allow on the USB debugging prompt if shown.",
      );
      try {
        const connected = await electronAPI.connectPhone(
          device.id,
          device.platform,
        );
        if (!connected) {
          setPhoneNotice("Could not connect to the device.");
          return;
        }
        setPhoneDevices((current) =>
          current.map((item) => (item.id === connected.id ? connected : item)),
        );
        setPhoneNotice(connected.message);
        if (connected.status === "ready" && connected.rootPath) {
          setPhoneNotice(`Backing up ${connected.name}…`);
          const progress = await electronAPI.renewPhoneBackup(
            connected.id,
            connected.platform,
          );
          setPhoneNotice(
            progress.status === "error"
              ? progress.message
              : `${connected.name}’s browseable backup is up to date.`,
          );
          await browsePhone(connected);
        }
      } finally {
        setPhoneBusyId(null);
      }
    },
    [browsePhone, electronAPI],
  );

  const previewPhoneBackup = useCallback(
    async (device: PhoneDevice): Promise<PhoneBackupPreview> => {
      if (!electronAPI) throw new Error("Phone backup is unavailable.");
      return electronAPI.previewPhoneBackup(device.id, device.platform);
    },
    [electronAPI],
  );

  const renewPhoneBackup = useCallback(
    async (device: PhoneDevice, includeTypes?: PhoneBackupFileType[]) => {
      if (!electronAPI) return;
      setPhoneBusyId(device.id);
      setPhoneNotice(`Backing up ${device.name}…`);
      try {
        const progress = await electronAPI.renewPhoneBackup(
          device.id,
          device.platform,
          includeTypes,
        );
        setPhoneNotice(
          progress.status === "error"
            ? progress.message
            : `${device.name}’s browseable backup is up to date.`,
        );
      } catch (error) {
        setPhoneNotice(
          error instanceof Error
            ? error.message
            : `Could not renew ${device.name}’s browseable backup.`,
        );
      } finally {
        setPhoneBusyId(null);
      }
    },
    [electronAPI],
  );

  const disconnectPhone = useCallback(
    async (device: PhoneDevice) => {
      if (!electronAPI) return;
      setPhoneBusyId(device.id);
      try {
        await electronAPI.disconnectPhone(device.id, device.platform);
        if (connectedPhone?.id === device.id) {
          setConnectedPhone(null);
          setCurrentPath(null);
          setFiles([]);
        }
        setPhoneNotice(`${device.name} disconnected.`);
        await scanForPhones();
      } finally {
        setPhoneBusyId(null);
      }
    },
    [connectedPhone, electronAPI, scanForPhones],
  );

  const renamePhone = useCallback(
    (device: PhoneDevice) => {
      if (!electronAPI) return;
      openDialog({
        mode: "text",
        title: "Rename phone",
        initialValue: device.name,
        placeholder: "Phone name",
        message:
          "This name is saved in Silo. The phone's system name and backup paths will not change.",
        confirmLabel: "Rename",
        onConfirm: async (name) => {
          const updated = await electronAPI.renamePhone(
            device.id,
            device.platform,
            name,
          );
          setPhoneDevices(updated);
          setConnectedPhone((current) =>
            current?.id === device.id && current.platform === device.platform
              ? { ...current, name: name.trim() }
              : current,
          );
          await refreshSources();
        },
      });
    },
    [electronAPI, openDialog, refreshSources],
  );

  const choosePhoneBackupDestination = useCallback(async () => {
    if (!electronAPI) return;
    const path = await electronAPI.selectDirectory({
      title: "Back up phones to…",
      defaultPath: phoneBackupDestination,
    });
    if (!path) return;
    await electronAPI.setPhoneBackupDestination(path);
    setPhoneBackupDestination(path);
  }, [electronAPI, phoneBackupDestination]);

  const resetPhoneBackupDestination = useCallback(async () => {
    if (!electronAPI) return;
    await electronAPI.setPhoneBackupDestination(null);
    setPhoneBackupDestination(null);
  }, [electronAPI]);

  const createPhoneRestoreArchive = useCallback(
    async (device: PhoneDevice, password: string): Promise<boolean> => {
      if (!electronAPI || device.platform !== "ios") return false;
      setPhoneNotice(`Creating encrypted restore archive for ${device.name}…`);
      try {
        const archive = await electronAPI.createPhoneRestoreArchive(
          device.id,
          "ios",
          password,
        );
        if (!archive) {
          setPhoneNotice("Restore-archive creation was cancelled.");
          return false;
        }
        setPhoneRestoreArchives(await electronAPI.getPhoneRestoreArchives());
        setPhoneNotice(
          `Encrypted restore archive saved for ${device.name} · ${new Date(archive.createdAt).toLocaleString()}.`,
        );
        return true;
      } catch (error) {
        setPhoneNotice(
          error instanceof Error ? error.message : "Could not create the restore archive.",
        );
        return false;
      }
    },
    [electronAPI],
  );

  const restorePhoneFromArchive = useCallback(
    async (
      targetDeviceId: string,
      archive: PhoneRestoreArchive,
      password: string,
    ): Promise<boolean> => {
      if (!electronAPI) return false;
      setPhoneNotice(`Preparing to restore ${archive.deviceName}…`);
      try {
        const restored = await electronAPI.restorePhoneFromArchive(
          targetDeviceId,
          "ios",
          archive.id,
          password,
        );
        setPhoneNotice(
          restored
            ? `Restore completed for ${archive.deviceName}. Reconnect and scan the device before browsing its updated contents.`
            : "Device restore was cancelled.",
        );
        return restored;
      } catch (error) {
        setPhoneNotice(
          error instanceof Error ? error.message : "Could not restore the device.",
        );
        return false;
      }
    },
    [electronAPI],
  );

  useEffect(() => {
    if (!electronAPI) return;
    void electronAPI.getPhoneTooling().then(setPhoneTooling);
    void electronAPI.getPhoneRestoreArchives().then(setPhoneRestoreArchives);
    void electronAPI.getPhoneBackupDestination().then((dest) => {
      console.log(`[REACT] getPhoneBackupDestination returned: ${dest}`);
      setPhoneBackupDestination(dest);
    });
    void electronAPI.getPhoneBackupStates().then((states) => {
      setPhoneBackups(
        Object.fromEntries(
          states.map((state) => [`${state.platform}:${state.deviceId}`, state]),
        ),
      );
    });
    const removeProgress = electronAPI.onPhoneBackupProgress((progress) => {
      console.log(
        `[REACT] Received backup progress: ${progress.platform}:${progress.deviceId}, status: ${progress.status}, completed: ${progress.completedFiles}/${progress.totalFiles}`,
      );
      setPhoneBackups((current) => ({
        ...current,
        [`${progress.platform}:${progress.deviceId}`]: progress,
      }));
    });
    const removeDevices = electronAPI.onPhoneDevicesChanged((devices) => {
      setPhoneDevices(devices);
      void refreshSources();
    });
    return () => {
      removeProgress();
      removeDevices();
    };
  }, [electronAPI, refreshSources]);

  const openCloudRoot = useCallback(
    async (rootPath: string) => {
      setConnectedPhone(null);
      setCurrentPath(rootPath);
      setNavigationHistory([{ type: "path", value: rootPath }]);
      setHistoryIndex(0);
      setActiveDigitalFolderId(null);
      setAppSection("files");
      await loadDirectory(rootPath);
    },
    [loadDirectory],
  );

  const googleAddAccount = useCallback(async () => {
    if (!electronAPI) return;
    setGoogleBusy(true);
    setGoogleNotice(
      "A browser window opened. Choose an account and approve access.",
    );
    try {
      const state = await electronAPI.googleAddAccount();
      setGoogleState(state);
      setGoogleNotice(state.message);
    } finally {
      setGoogleBusy(false);
    }
  }, [electronAPI]);

  const exportPickedPhotos = useCallback(
    async (accountId?: string) => {
      if (!electronAPI) return;
      setGoogleBusy(true);
      setGoogleNotice("Downloading picked photos…");
      try {
        const result = await electronAPI.googleExportPhotos(accountId);
        if (result.canceled) {
          setGoogleNotice("");
          return;
        }
        setGoogleNotice(
          result.error
            ? result.error
            : `Downloaded ${(result.copied ?? 0).toLocaleString()} photos${result.failed ? `, ${result.failed} failed` : ""}.`,
        );
      } finally {
        setGoogleBusy(false);
      }
    },
    [electronAPI],
  );

  const googleRemoveAccount = useCallback(
    async (accountId: string) => {
      if (!electronAPI) return;
      setGoogleBusy(true);
      try {
        const state = await electronAPI.googleRemoveAccount(accountId);
        setGoogleState(state);
        setGoogleNotice("Account removed.");
      } finally {
        setGoogleBusy(false);
      }
    },
    [electronAPI],
  );

  const startPhotoPicker = useCallback(
    async (accountId: string) => {
      if (!electronAPI) return;
      setGoogleBusy(true);
      try {
        const session = await electronAPI.googleStartPhotoPicker(accountId);
        if (session.error || !session.sessionId) {
          setGoogleNotice(session.error || "Could not open the Photos picker.");
          return;
        }
        setPickerSession({ accountId, sessionId: session.sessionId });
        setGoogleNotice(
          "Choose photos in the Google Photos tab, then return here.",
        );
      } finally {
        setGoogleBusy(false);
      }
    },
    [electronAPI],
  );

  // Google only exposes picked items once the user finishes selecting.
  useEffect(() => {
    if (!electronAPI || !pickerSession) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      const result = await electronAPI.googlePollPhotoPicker(
        pickerSession.accountId,
        pickerSession.sessionId,
      );
      if (cancelled || !result.ready) return;
      window.clearInterval(timer);
      setPickerSession(null);
      const state = await electronAPI.getGoogleState();
      setGoogleState(state);
      setGoogleNotice(`${result.count.toLocaleString()} photos available.`);
      await openCloudRoot(state.allPhotosPath);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [electronAPI, openCloudRoot, pickerSession]);

  useEffect(() => {
    if (!electronAPI) return;
    void electronAPI.getGoogleState().then(setGoogleState);
    return electronAPI.onAudioLibraryCacheChanged?.(() => {
      void electronAPI.getGoogleState().then(setGoogleState);
      void refreshSources();
    });
  }, [electronAPI, refreshSources]);

  useEffect(() => {
    if (!electronAPI) return;
    const timer = window.setInterval(() => void refreshSources(), 5000);
    return () => window.clearInterval(timer);
  }, [electronAPI, refreshSources]);
  useEffect(() => {
    if (!electronAPI?.onLifetimeAccessChanged) return;
    return electronAPI.onLifetimeAccessChanged((access) => {
      document.title = access.name;
      // Sources beyond the demo limit become visible as soon as the license is saved.
      void refreshSources();
    });
  }, [electronAPI, refreshSources]);
  useEffect(() => {
    if (!electronAPI) return;
    void electronAPI.getAllSourcesPath().then(setAllSourcesPath);
    void refreshSources();
  }, [electronAPI, refreshSources]);

  useEffect(() => {
    if (!electronAPI?.onScanIssues) return;
    return electronAPI.onScanIssues((issues) =>
      setScanIssues(issues.denied > 0 ? issues : null),
    );
  }, [electronAPI]);

  useEffect(() => {
    if (!electronAPI?.getAccessIdentity) return;
    void electronAPI.getAccessIdentity().then(setAccessIdentity);
  }, [electronAPI]);

  // Explicit phone scans and account changes update the source list.
  useEffect(() => {
    void refreshSources();
  }, [googleState, phoneDevices, refreshSources]);

  const loadAggregateSource = useCallback(
    async (source: BrowseSource) => {
      if (!electronAPI || allSourcesLoadedRef.current.has(source.id)) return;
      let job = sourceScanJobsRef.current.get(source.id);
      if (!job) {
        const requestId = -Date.now();
        setLoading(true);
        setBrowseError("");
        job = electronAPI
          .getFiles(source.rootPath, true, requestId, {
            sortField: sortRef.current.field,
            sortAscending: sortRef.current.ascending,
            includedType: filtersRef.current.includedType,
            sizeMin: filtersRef.current.sizeMin,
            sizeMax: filtersRef.current.sizeMax,
          })
          .then((inventory) => readInventory<FileInfo>(electronAPI, inventory))
          .then((sourceFiles) => {
            allSourcesLoadedRef.current.add(source.id);
            setFiles((current) => {
              const byPath = new Map(current.map((file) => [fileListKey(file), file]));
              sourceFiles.forEach((file) =>
                byPath.set(fileListKey(file), {
                  ...file,
                  sourceId: source.id,
                  sourceLabel: source.label,
                }),
              );
              return Array.from(byPath.values());
            });
            return sourceFiles;
          })
          .catch((error) => {
            setBrowseError(
              `Could not load source "${source.label}". Check that it is connected and accessible, then retry. ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
          })
          .finally(() => {
            sourceScanJobsRef.current.delete(source.id);
            if (currentPath === allSourcesPath) setLoading(false);
          });
        sourceScanJobsRef.current.set(source.id, job);
      }
      await job;
    },
    [allSourcesPath, currentPath, electronAPI],
  );

  const toggleSource = useCallback(
    async (sourceId: string, enabled: boolean) => {
      if (!electronAPI) return;
      const request = ++sourceToggleRequestRef.current;
      pendingSourceSelectionsRef.current.set(sourceId, { enabled, request });
      const currentSources = sourcesRef.current;
      const target = currentSources.find((source) => source.id === sourceId);
      const deviceKey = target && enabled ? phoneSourceDeviceKey(target) : null;
      const peerIds = new Set(
        deviceKey
          ? currentSources
              .filter(
                (source) =>
                  source.id !== sourceId &&
                  phoneSourceDeviceKey(source) === deviceKey,
              )
              .map((source) => source.id)
          : [],
      );
      for (const peerId of peerIds)
        pendingSourceSelectionsRef.current.set(peerId, {
          enabled: false,
          request,
        });
      sourcesRefreshRequestRef.current += 1;
      setBrowseError("");
      const optimistic = currentSources.map((source) =>
        source.id === sourceId
          ? { ...source, enabled }
          : peerIds.has(source.id)
            ? { ...source, enabled: false }
            : source,
      );
      sourcesRef.current = optimistic;
      setSources(optimistic);
      try {
        const response = await electronAPI.setSourceEnabled(sourceId, enabled);
        for (const [pendingId, pending] of pendingSourceSelectionsRef.current)
          if (pending.request === request)
            pendingSourceSelectionsRef.current.delete(pendingId);
        const updated = applyPendingSourceSelections(response);
        sourcesRefreshRequestRef.current += 1;
        sourcesRef.current = updated;
        setSources(updated);
        setSourceSelectionRevision((revision) => revision + 1);
        if (request !== sourceToggleRequestRef.current) return;
        const inAggregateBrowse =
          currentPath === allSourcesPath ||
          (activeDigitalFolderId === null && currentPath === null);
        if (!inAggregateBrowse) return;
        setCurrentPath(allSourcesPath);
        if (!explodedRef.current) {
          if (sourceRefreshTimerRef.current !== null)
            window.clearTimeout(sourceRefreshTimerRef.current);
          sourceRefreshTimerRef.current = window.setTimeout(() => {
            sourceRefreshTimerRef.current = null;
            void loadDirectory(allSourcesPath, false, true, true);
          }, 180);
          return;
        }
        if (!enabled) return;
        const source = updated.find((item) => item.id === sourceId);
        if (!source?.available || allSourcesLoadedRef.current.has(source.id))
          return;
        void loadAggregateSource(source);
      } catch (error) {
        for (const [pendingId, pending] of pendingSourceSelectionsRef.current)
          if (pending.request === request)
            pendingSourceSelectionsRef.current.delete(pendingId);
        if (request === sourceToggleRequestRef.current)
          setBrowseError(error instanceof Error ? error.message : "The source selection could not be changed.");
        void refreshSources().catch(() => undefined);
      }
    },
    [
      activeDigitalFolderId,
      allSourcesPath,
      applyPendingSourceSelections,
      currentPath,
      electronAPI,
      loadAggregateSource,
      loadDirectory,
      refreshSources,
    ],
  );

  const ejectSourceVolume = useCallback(async (source: BrowseSource) => {
    const volume = source.ejectableVolume;
    if (!electronAPI || !volume?.volumeUUID || volume.ejecting) return;
    const deviceId = volume.wholeDeviceIdentifier;
    if (ejectingDeviceIds.has(deviceId)) return;
    setEjectingDeviceIds((current) => new Set(current).add(deviceId));
    setBrowseError("");
    try {
      const updated = await electronAPI.ejectSourceVolume(source.id);
      sourcesRefreshRequestRef.current += 1;
      sourcesRef.current = updated;
      setSources(updated);
    } catch (error) {
      setBrowseError(
        error instanceof Error
          ? error.message
          : `Could not safely eject ${volume.label}. The drive was left mounted.`,
      );
    } finally {
      setEjectingDeviceIds((current) => {
        const next = new Set(current);
        next.delete(deviceId);
        return next;
      });
      await refreshSources().catch(() => undefined);
    }
  }, [electronAPI, ejectingDeviceIds, refreshSources]);

  const removeSource = useCallback(async (source: BrowseSource) => {
    if (!electronAPI || (source.kind !== "local" && source.kind !== "machine")) return;
    try {
      await electronAPI.removeIndexSource(source.rootPath);
      await refreshSources();
      allSourcesLoadedRef.current.delete(source.id);
      if (currentPath && pathIsWithinSourceRoot(currentPath, source.rootPath)) {
        setActiveDigitalFolderId(null);
        setCurrentPath(allSourcesPath);
        await loadDirectory(allSourcesPath, explodedRef.current, true, true);
      } else if (currentPath === allSourcesPath || (currentPath === null && activeDigitalFolderId === null)) {
        await loadDirectory(allSourcesPath, explodedRef.current, true, true);
      }
    } catch (cause) {
      setBrowseError(`Could not remove “${source.label}”. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [activeDigitalFolderId, allSourcesPath, currentPath, electronAPI, loadDirectory, refreshSources]);

  const setEverySource = useCallback(
    async (enabled: boolean) => {
      if (!electronAPI) return;
      const request = ++sourceToggleRequestRef.current;
      const currentSources = sourcesRef.current;
      for (const source of currentSources)
        pendingSourceSelectionsRef.current.set(source.id, { enabled, request });
      sourcesRefreshRequestRef.current += 1;
      const optimistic = currentSources.map((source) => ({ ...source, enabled }));
      sourcesRef.current = optimistic;
      setSources(optimistic);
      setBrowseError("");
      try {
        const response = await electronAPI.setAllSourcesEnabled(enabled);
        for (const [pendingId, pending] of pendingSourceSelectionsRef.current)
          if (pending.request === request)
            pendingSourceSelectionsRef.current.delete(pendingId);
        const updated = applyPendingSourceSelections(response);
        sourcesRefreshRequestRef.current += 1;
        sourcesRef.current = updated;
        setSources(updated);
        setSourceSelectionRevision((revision) => revision + 1);
        if (request !== sourceToggleRequestRef.current) return;
        const inAggregateBrowse =
          currentPath === allSourcesPath ||
          (activeDigitalFolderId === null && currentPath === null);
        if (!inAggregateBrowse) return;
        setCurrentPath(allSourcesPath);
        if (!explodedRef.current) {
          if (sourceRefreshTimerRef.current !== null)
            window.clearTimeout(sourceRefreshTimerRef.current);
          sourceRefreshTimerRef.current = window.setTimeout(() => {
            sourceRefreshTimerRef.current = null;
            void loadDirectory(allSourcesPath, false, true, true);
          }, 180);
        } else if (enabled) {
          const toLoad = updated.filter(
            (source) =>
              source.enabled &&
              source.available &&
              !allSourcesLoadedRef.current.has(source.id),
          );
          void Promise.all(toLoad.map(loadAggregateSource));
        }
      } catch (error) {
        for (const [pendingId, pending] of pendingSourceSelectionsRef.current)
          if (pending.request === request)
            pendingSourceSelectionsRef.current.delete(pendingId);
        if (request === sourceToggleRequestRef.current)
          setBrowseError(error instanceof Error ? error.message : "Source selections could not be changed.");
        void refreshSources().catch(() => undefined);
      }
    },
    [
      activeDigitalFolderId,
      allSourcesPath,
      applyPendingSourceSelections,
      currentPath,
      electronAPI,
      loadAggregateSource,
      loadDirectory,
      refreshSources,
    ],
  );

  useEffect(() => {
    if (
      appSection !== "files" ||
      !currentPath ||
      currentPath === allSourcesPath ||
      activeDigitalFolderId
    ) return;
    const belongsToRegisteredSource = sources.some(
      (source) => source.rootPath && pathIsWithinSourceRoot(currentPath, source.rootPath),
    );
    const belongsToEnabledSource = sources.some(
      (source) => source.enabled && source.available && source.rootPath &&
        pathIsWithinSourceRoot(currentPath, source.rootPath),
    );
    if (!belongsToRegisteredSource || belongsToEnabledSource) return;

    setConnectedPhone(null);
    setCurrentPath(allSourcesPath);
    setNavigationHistory([{ type: "path", value: allSourcesPath }]);
    setHistoryIndex(0);
    setActiveDigitalFolderId(null);
    setExploded(false);
    void loadDirectory(allSourcesPath, false);
  }, [
    activeDigitalFolderId,
    allSourcesPath,
    appSection,
    currentPath,
    loadDirectory,
    sources,
  ]);

  useEffect(() => {
    if (
      activeDigitalFolderId ||
      !selectedFile ||
      pathIsVisibleForSelectedSources(
        selectedFile.path,
        enabledSourcePaths,
        allSourcePaths,
      )
    ) return;
    setSelectedFile(null);
    setFilePreview(null);
    setViewerOpen(false);
  }, [
    activeDigitalFolderId,
    allSourcePaths,
    enabledSourcePaths,
    selectedFile,
  ]);

  const browseAllSources = useCallback(async () => {
    setConnectedPhone(null);
    setExploded(false);
    setCurrentPath(allSourcesPath);
    setNavigationHistory([{ type: "path", value: allSourcesPath }]);
    setHistoryIndex(0);
    setActiveDigitalFolderId(null);
    clearFileSelection();
    setSelectedFilePaths(new Set());
    setAppSection("files");
    await loadDirectory(allSourcesPath, false);
  }, [allSourcesPath, clearFileSelection, loadDirectory]);

  const navigateToPath = useCallback(
    async (targetPath: string, addToHistory = true) => {
      clearFileSelection();
      setSelectedFilePaths(new Set());
      setCurrentPath(targetPath);
      setActiveDigitalFolderId(null);
      if (addToHistory) {
        const nextHistory = navigationHistory
          .slice(0, historyIndex + 1)
          .concat({ type: "path", value: targetPath });
        setNavigationHistory(nextHistory);
        setHistoryIndex(nextHistory.length - 1);
      }
      await loadDirectory(targetPath);
    },
    [clearFileSelection, historyIndex, loadDirectory, navigationHistory],
  );

  const navigateUp = useCallback(async () => {
    if (!currentPath || currentPath === allSourcesPath) return;
    const source = sources.find(
      (candidate) =>
        currentPath === candidate.rootPath ||
        currentPath.startsWith(`${candidate.rootPath}/`),
    );
    if (!source || currentPath === source.rootPath) {
      await browseAllSources();
      return;
    }
    const parentPath = currentPath.replace(/[/\\][^/\\]+$/, "");
    await navigateToPath(
      parentPath.length >= source.rootPath.length
        ? parentPath
        : source.rootPath,
    );
  }, [allSourcesPath, browseAllSources, currentPath, navigateToPath, sources]);

  const navigateToDigitalFolder = useCallback(
    async (folderId: string, addToHistory = true) => {
      clearFileSelection();
      setSelectedFilePaths(new Set());
      setLoading(true);
      try {
        setFiles(await electronAPI.getDigitalFolderFiles(folderId));
        setCurrentPath(null);
        setActiveDigitalFolderId(folderId);
        setSelectedFile(null);
        setFilePreview(null);
        setSearchQuery("");
        if (addToHistory) {
          const nextHistory = navigationHistory
            .slice(0, historyIndex + 1)
            .concat({ type: "folder", value: folderId });
          setNavigationHistory(nextHistory);
          setHistoryIndex(nextHistory.length - 1);
        }
      } finally {
        setLoading(false);
      }
    },
    [clearFileSelection, electronAPI, historyIndex, navigationHistory],
  );

  const navigateHistory = useCallback(
    async (nextIndex: number) => {
      const entry = navigationHistory[nextIndex];
      if (!entry) return;
      setHistoryIndex(nextIndex);
      if (entry.type === "path") {
        clearFileSelection();
        setSelectedFilePaths(new Set());
        setCurrentPath(entry.value);
        setActiveDigitalFolderId(null);
        await loadDirectory(entry.value);
      } else {
        await navigateToDigitalFolder(entry.value, false);
      }
    },
    [clearFileSelection, loadDirectory, navigationHistory, navigateToDigitalFolder],
  );

  useEffect(() => {
    const revisionKey = `${contentSettings.showNsfw}:${contentSettings.showBannedPeople}:${contentSafetyRevision}`;
    if (!electronAPI || contentVisibilityRef.current === revisionKey) return;
    contentVisibilityRef.current = revisionKey;
    if (currentPath) void loadDirectory(currentPath, explodedRef.current, true);
    else if (activeDigitalFolderId)
      void navigateToDigitalFolder(activeDigitalFolderId, false);
    if (selectedPersonId)
      void electronAPI
        .getPersonPhotoFiles(selectedPersonId)
        .then(setPersonPhotos);
  }, [
    activeDigitalFolderId,
    contentSettings.showNsfw,
    contentSettings.showBannedPeople,
    contentSafetyRevision,
    currentPath,
    electronAPI,
    loadDirectory,
    navigateToDigitalFolder,
    selectedPersonId,
  ]);

  // Track visible thumbnails for prioritization
  useEffect(() => {
    if (!fileGridRef.current || !electronAPI) return;

    const visiblePaths = new Set<string>();
    let updateTimer: NodeJS.Timeout | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const filePath = (entry.target as HTMLElement).getAttribute(
            "data-file-path",
          );
          if (!filePath) return;

          if (entry.isIntersecting) {
            visiblePaths.add(filePath);
          } else {
            visiblePaths.delete(filePath);
          }
        });

        // Debounce updates to main process to avoid excessive IPC calls
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = setTimeout(() => {
          electronAPI.updateVisibleThumbnails?.(Array.from(visiblePaths));
        }, 100);
      },
      { rootMargin: "200px" },
    );

    const observeCards = (root: ParentNode) => {
      if (root instanceof HTMLElement && root.matches("[data-file-path]"))
        observer.observe(root);
      root
        .querySelectorAll?.("[data-file-path]")
        .forEach((card) => observer.observe(card));
    };
    observeCards(fileGridRef.current);
    const mutations = new MutationObserver((records) => {
      records.forEach((record) =>
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) observeCards(node);
        }),
      );
    });
    mutations.observe(fileGridRef.current, { childList: true, subtree: true });

    return () => {
      if (updateTimer) clearTimeout(updateTimer);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [electronAPI, viewMode]);

  const selectFile = useCallback(
    async (file: FileInfo) => {
      if (!electronAPI || file.isDirectory) return;
      const request = ++filePreviewRequestRef.current;
      setSelectedFile(file);
      setFilePreview(cachedImagePreview(file));
      try {
        const preview = await electronAPI.getFilePreview(file.path);
        if (request === filePreviewRequestRef.current && preview)
          setFilePreview(preview);
      } catch (error) {
        if (request === filePreviewRequestRef.current)
          setBrowseError(
            `Could not preview "${file.name}". Check that the file is accessible, then select it again. ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    },
    [electronAPI],
  );

  const prepareViewerImage = useCallback(
    (file: FileInfo): Promise<PreparedViewerImage | null> => {
      if (!electronAPI || file.type !== "image") return Promise.resolve(null);
      const key = viewerPreviewCacheKey(file);
      const cached = preparedViewerImagesRef.current.get(key);
      if (cached) {
        preparedViewerImagesRef.current.delete(key);
        preparedViewerImagesRef.current.set(key, cached);
        return Promise.resolve(cached);
      }
      const pending = viewerImageRequestsRef.current.get(key);
      if (pending) return pending;

      const request = (async () => {
        const preview = await electronAPI.getFilePreview(file.path);
        if (!preview?.previewDataUrl) return null;
        const image = new Image();
        image.src = preview.previewDataUrl;
        await image.decode().catch(() => undefined);
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;

        const prepared = {
          preview,
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
        const cache = preparedViewerImagesRef.current;
        if (preview.previewDataUrl.length <= MAX_VIEWER_PREVIEW_CACHE_CHARS) {
          cache.set(key, prepared);
          let cachedChars = Array.from(cache.values()).reduce(
            (total, entry) => total + (entry.preview.previewDataUrl?.length ?? 0),
            0,
          );
          while (
            cache.size > MAX_VIEWER_PREVIEW_CACHE_ENTRIES ||
            cachedChars > MAX_VIEWER_PREVIEW_CACHE_CHARS
          ) {
            const oldestKey = cache.keys().next().value as string | undefined;
            if (!oldestKey) break;
            const oldest = cache.get(oldestKey);
            cache.delete(oldestKey);
            cachedChars -= oldest?.preview.previewDataUrl?.length ?? 0;
          }
        }
        return prepared;
      })()
        .catch(() => null)
        .finally(() => viewerImageRequestsRef.current.delete(key));

      viewerImageRequestsRef.current.set(key, request);
      return request;
    },
    [electronAPI],
  );

  const openMediaViewer = useCallback(
    async (file: FileInfo, scopeFiles?: FileInfo[]) => {
      if (!electronAPI || file.isDirectory) return;
      setSelectedFile(file);
      setViewerScopeFiles(scopeFiles ?? null);
      const request = ++filePreviewRequestRef.current;
      const livePhotoVideo =
        file.type === "image"
          ? findLivePhotoVideo(file, scopeFiles ?? files)
          : null;
      const playbackFile = livePhotoVideo ?? file;
      setViewerMediaFile(playbackFile);
      // Keep the current image until a warmed adjacent thumbnail is ready;
      // then show it while the full-size preview finishes loading.
      const navigatingBetweenImages =
        viewerOpenRef.current &&
        viewerMediaFile?.type === "image" &&
        playbackFile.type === "image";
      setViewerImageLoading(playbackFile.type === "image");
      if (!navigatingBetweenImages) {
        setFilePreview(
          cachedImagePreview(playbackFile, VIEWER_PREFETCH_THUMBNAIL_SIZE) ??
            cachedImagePreview(playbackFile),
        );
        setViewerDimensions({ width: 0, height: 0 });
      } else {
        const preparedImage = preparedViewerImagesRef.current.get(
          viewerPreviewCacheKey(playbackFile),
        );
        if (preparedImage) {
          setFilePreview(preparedImage.preview);
          setViewerDimensions({ width: 0, height: 0 });
        }
      }
      setViewerZoom(1);
      setViewerFit(true);
      setMediaPlaying(false);
      setMediaCurrentTime(0);
      setMediaDuration(0);
      setMediaLoop(Boolean(livePhotoVideo));
      setMediaMuted(Boolean(livePhotoVideo));
      setMediaError("");
      setViewerOpen(true);
      try {
        const preparedImage =
          playbackFile.type === "image"
            ? await prepareViewerImage(playbackFile)
            : null;
        const preview =
          playbackFile.type === "image"
            ? preparedImage?.preview ?? null
            : await electronAPI.getFilePreview(playbackFile.path);
        if (request !== filePreviewRequestRef.current) return;
        if (!preview) {
          setViewerImageLoading(false);
          setMediaError(`Could not open "${playbackFile.name}".`);
          return;
        }
        if (playbackFile.type === "image" && preparedImage) {
          setViewerDimensions({
            width: preparedImage.width,
            height: preparedImage.height,
          });
        }
        setFilePreview(preview);
        setViewerImageLoading(false);
      } catch (error) {
        if (request === filePreviewRequestRef.current) {
          setViewerImageLoading(false);
          setMediaError(
            `Could not open "${playbackFile.name}". Check that the file is accessible, then reopen it. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
    [electronAPI, files, prepareViewerImage, viewerMediaFile],
  );

  const openFaceAssignment = useCallback(
    async (file: FileInfo) => {
      if (!electronAPI || file.type !== "image") return;
      faceAssignmentPhotoPathRef.current = file.path;
      setFaceAssignmentPhotoPath(file.path);
      setFaceAssignmentOpen(true);
      setFaceAssignmentFaces([]);
      setFaceAssignmentSelectedId(null);
      setFaceAssignmentTargets({});
      setFaceAssignmentError("");
      faceBoxDragRef.current = null;
      faceCreateDragRef.current = null;
      setFaceCreationBox(null);
      const [, faces] = await Promise.all([
        openMediaViewer(file),
        electronAPI.getImageFaces(file.path),
        refreshPeople(),
      ]);
      if (faceAssignmentPhotoPathRef.current !== file.path) return;
      setFaceAssignmentFaces(faces);
      setFaceAssignmentTargets(
        Object.fromEntries(
          faces.map((face) => [
            face.id,
            { personId: face.personIds[0] ?? "", newName: "" },
          ]),
        ),
      );
    },
    [electronAPI, openMediaViewer, refreshPeople],
  );

  const closeFaceAssignment = useCallback(() => {
    faceAssignmentPhotoPathRef.current = null;
    setFaceAssignmentPhotoPath(null);
    setFaceAssignmentOpen(false);
    setFaceAssignmentFaces([]);
    setFaceAssignmentSelectedId(null);
    setFaceAssignmentTargets({});
    setFaceAssignmentError("");
    setFaceCreationBox(null);
    faceBoxDragRef.current = null;
    faceCreateDragRef.current = null;
  }, []);

  useEffect(() => {
    if (!faceAssignmentOpen) return;
    if (!viewerOpen || selectedFile?.path !== faceAssignmentPhotoPath) {
      closeFaceAssignment();
    }
  }, [closeFaceAssignment, faceAssignmentOpen, faceAssignmentPhotoPath, selectedFile?.path, viewerOpen]);

  const saveFaceAssignments = useCallback(async () => {
    const photoPath = faceAssignmentPhotoPathRef.current;
    if (!electronAPI || !photoPath || faceAssignmentFaces.length === 0) return;
    setFaceAssignmentBusy(true);
    setFaceAssignmentError("");
    try {
      const assignments = faceAssignmentFaces.map((face) => {
        const target = faceAssignmentTargets[face.id];
        if (target?.personId)
          return { faceId: face.id, personId: target.personId };
        if (target?.newName.trim())
          return { faceId: face.id, newName: target.newName.trim() };
        return null;
      });
      if (assignments.some((item) => !item))
        throw new Error("Choose a person or enter a name for every face box.");
      await electronAPI.assignFacesToPeople(
        assignments.filter((item): item is NonNullable<typeof item> => item !== null),
      );
      if (faceAssignmentPhotoPathRef.current === photoPath) closeFaceAssignment();
      refreshPhotoIndicators([photoPath]);
      await refreshPeople();
    } catch (cause) {
      if (faceAssignmentPhotoPathRef.current === photoPath)
        setFaceAssignmentError(
          cause instanceof Error ? cause.message : "Could not assign these faces.",
        );
    } finally {
      setFaceAssignmentBusy(false);
    }
  }, [
    electronAPI,
    closeFaceAssignment,
    faceAssignmentFaces,
    faceAssignmentTargets,
    refreshPeople,
    refreshPhotoIndicators,
  ]);

  const deleteDetectedFace = useCallback(
    async (faceId: string) => {
      const photoPath = faceAssignmentPhotoPathRef.current;
      if (!electronAPI || !photoPath) return;
      setFaceAssignmentBusy(true);
      setFaceAssignmentError("");
      try {
        const faces = await electronAPI.deleteFace(faceId);
        if (faceAssignmentPhotoPathRef.current === photoPath) {
          setFaceAssignmentFaces(faces);
          setFaceAssignmentTargets((current) => {
            const next = { ...current };
            delete next[faceId];
            return next;
          });
          if (selectedPersonPhoto?.path === photoPath)
            setSelectedPhotoFaces(await electronAPI.getImageFaces(photoPath));
          setFaceAssignmentSelectedId((current) => current === faceId ? null : current);
        }
        await refreshPeople();
      } catch (cause) {
        if (faceAssignmentPhotoPathRef.current === photoPath)
          setFaceAssignmentError(
            cause instanceof Error ? cause.message : "Could not delete this face.",
          );
      } finally {
        setFaceAssignmentBusy(false);
      }
    },
    [electronAPI, refreshPeople, selectedPersonPhoto],
  );

  const beginFaceCreation = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.shiftKey || event.button !== 0) return;
      const image = event.currentTarget.querySelector("img");
      const bounds = image?.getBoundingClientRect();
      if (!bounds || !bounds.width || !bounds.height) return;
      event.preventDefault();
      event.stopPropagation();
      const x = Math.max(
        0,
        Math.min(1, (event.clientX - bounds.left) / bounds.width),
      );
      const y = Math.max(
        0,
        Math.min(1, (event.clientY - bounds.top) / bounds.height),
      );
      faceCreateDragRef.current = {
        photoPath: faceAssignmentPhotoPathRef.current ?? "",
        startX: x,
        startY: y,
        currentBox: { x, y, width: 0, height: 0 },
      };
      setFaceCreationBox(faceCreateDragRef.current.currentBox);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const updateFaceCreation = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = faceCreateDragRef.current;
      if (!drag) return;
      if (drag.photoPath !== faceAssignmentPhotoPathRef.current) return;
      const image = event.currentTarget.querySelector("img");
      const bounds = image?.getBoundingClientRect();
      if (!bounds || !bounds.width || !bounds.height) return;
      const x = Math.max(
        0,
        Math.min(1, (event.clientX - bounds.left) / bounds.width),
      );
      const y = Math.max(
        0,
        Math.min(1, (event.clientY - bounds.top) / bounds.height),
      );
      drag.currentBox = {
        x: Math.min(x, drag.startX),
        y: Math.min(y, drag.startY),
        width: Math.abs(x - drag.startX),
        height: Math.abs(y - drag.startY),
      };
      setFaceCreationBox({ ...drag.currentBox });
    },
    [],
  );

  const finishFaceCreation = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = faceCreateDragRef.current;
      if (!drag) return;
      faceCreateDragRef.current = null;
      setFaceCreationBox(null);
      event.stopPropagation();
      if (
        !electronAPI ||
        !drag.photoPath ||
        drag.photoPath !== faceAssignmentPhotoPathRef.current ||
        selectedFile?.path !== drag.photoPath ||
        drag.currentBox.width < 0.01 ||
        drag.currentBox.height < 0.01
      )
        return;
      setFaceAssignmentBusy(true);
      setFaceAssignmentError("");
      try {
        const faces = await electronAPI.createFaceBox(
          drag.photoPath,
          drag.currentBox,
        );
        if (faceAssignmentPhotoPathRef.current !== drag.photoPath) return;
        setFaceAssignmentFaces(faces);
        const createdFace = faces[faces.length - 1];
        setFaceAssignmentSelectedId(createdFace?.id ?? null);
        if (createdFace) {
          setFaceAssignmentTargets((current) => ({
            ...current,
            [createdFace.id]: { personId: "", newName: "" },
          }));
          setFaceAssignmentError(
            createdFace.hasDescriptor
              ? "Face box saved. Choose a person for each box, then save all assignments."
              : "Face box saved, but Silo could not read a recognition descriptor. You can assign it, but it will not train matching.",
          );
        }
        if (selectedPersonPhoto?.path === drag.photoPath)
          setSelectedPhotoFaces(faces);
        await refreshPeople();
      } catch (cause) {
        if (faceAssignmentPhotoPathRef.current === drag.photoPath)
          setFaceAssignmentError(
            cause instanceof Error ? cause.message : "Could not create the face box.",
          );
      } finally {
        setFaceAssignmentBusy(false);
      }
    },
    [electronAPI, refreshPeople, selectedFile?.path, selectedPersonPhoto],
  );

  const beginFaceBoxDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, face: ImageFace) => {
      if (
        event.button !== 0 ||
        event.shiftKey ||
        (event.target as HTMLElement).closest("button")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      faceBoxDragRef.current = {
        faceId: face.id,
        photoPath: faceAssignmentPhotoPathRef.current ?? "",
        startX: event.clientX,
        startY: event.clientY,
        startBox: { ...face.box },
        currentBox: { ...face.box },
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const moveFaceBox = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = faceBoxDragRef.current;
      if (!drag) return;
      if (drag.photoPath !== faceAssignmentPhotoPathRef.current) return;
      const image = event.currentTarget.parentElement?.querySelector("img");
      const bounds = image?.getBoundingClientRect();
      if (!bounds || !bounds.width || !bounds.height) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (Math.hypot(deltaX, deltaY) > 2) drag.moved = true;
      if (!drag.moved) return;
      const width = drag.startBox.width;
      const height = drag.startBox.height;
      const box = {
        ...drag.startBox,
        x: Math.max(
          0,
          Math.min(1 - width, drag.startBox.x + deltaX / bounds.width),
        ),
        y: Math.max(
          0,
          Math.min(1 - height, drag.startBox.y + deltaY / bounds.height),
        ),
      };
      drag.currentBox = box;
      setFaceAssignmentFaces((faces) =>
        faces.map((face) =>
          face.id === drag.faceId ? { ...face, box } : face,
        ),
      );
    },
    [],
  );

  const finishFaceBoxDrag = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = faceBoxDragRef.current;
      if (!drag) return;
      faceBoxDragRef.current = null;
      if (
        !drag.moved || !electronAPI || !drag.photoPath ||
        drag.photoPath !== faceAssignmentPhotoPathRef.current ||
        selectedFile?.path !== drag.photoPath
      ) return;
      setFaceAssignmentBusy(true);
      setFaceAssignmentError("");
      try {
        const faces = await electronAPI.updateFaceBox(
          drag.faceId,
          drag.photoPath,
          drag.currentBox,
        );
        if (faceAssignmentPhotoPathRef.current !== drag.photoPath) return;
        setFaceAssignmentFaces(faces);
        if (selectedPersonPhoto?.path === drag.photoPath)
          setSelectedPhotoFaces(faces);
        await refreshPeople();
      } catch (cause) {
        if (faceAssignmentPhotoPathRef.current === drag.photoPath) {
          setFaceAssignmentFaces((faces) =>
            faces.map((item) =>
              item.id === drag.faceId ? { ...item, box: drag.startBox } : item,
            ),
          );
          setFaceAssignmentError(
            cause instanceof Error ? cause.message : "Could not move this face box.",
          );
        }
      } finally {
        setFaceAssignmentBusy(false);
      }
      event.stopPropagation();
    },
    [electronAPI, refreshPeople, selectedFile?.path, selectedPersonPhoto],
  );

  const saveSelectedFileToDevice = useCallback(async () => {
    if (!electronAPI) return;

    const filesToSave =
      selectedFilePaths.size > 0
        ? Array.from(selectedFilePaths)
        : selectedFile?.path
          ? [selectedFile.path]
          : [];

    if (filesToSave.length === 0) return;

    for (const filePath of filesToSave) {
      const fileName = filePath.split("/").pop() || "file";
      const result = await electronAPI.saveFileToDevice(filePath, fileName);
      if (!result.ok && !result.canceled) {
        openDialog({
          mode: "confirm",
          title: "Save Failed",
          message: `Could not save file: ${result.error || "Unknown error"}`,
          confirmLabel: "OK",
          onConfirm: () => undefined,
        });
        return;
      }
    }
    clearFileSelection();
  }, [
    electronAPI,
    selectedFile,
    selectedFilePaths,
    openDialog,
    clearFileSelection,
  ]);

  const changeExploded = useCallback(
    async (nextExploded: boolean) => {
      setExploded(nextExploded);
      if (!audioOnlySelected && currentPath)
        await loadDirectory(currentPath, nextExploded);
    },
    [audioOnlySelected, currentPath, loadDirectory],
  );

  const isGoogleCloudContext = Boolean(
    currentPath?.startsWith("/__cloud__/") ||
      selectedFile?.path.startsWith("/__cloud__/"),
  );
  const canCreateSourceFolder = Boolean(
    currentPath && currentPath !== allSourcesPath && !isGoogleCloudContext,
  );
  const canMoveSelectedSourceFile = Boolean(
    currentPath &&
      selectedFile &&
      !selectedFile.isDirectory &&
      !selectedFile.path.startsWith("/__cloud__/"),
  );

  const createFolder = useCallback(async () => {
    if (
      !currentPath ||
      currentPath === allSourcesPath ||
      currentPath.startsWith("/__cloud__/") ||
      !electronAPI
    ) return;
    openDialog({
      mode: "text",
      title: "New folder",
      message: `Create a physical folder inside ${currentPath}.`,
      placeholder: "Folder name",
      confirmLabel: "Create folder",
      onConfirm: async (folderName) => {
        const result = await electronAPI.createFolder(currentPath, folderName);
        if (!result.ok)
          throw new Error(result.error || "Could not create folder.");
        await loadDirectory(currentPath);
      },
    });
  }, [allSourcesPath, currentPath, electronAPI, loadDirectory, openDialog]);

  const moveSelectedFile = useCallback(async () => {
    if (
      !selectedFile ||
      selectedFile.isDirectory ||
      selectedFile.path.startsWith("/__cloud__/") ||
      !electronAPI ||
      !currentPath
    )
      return;
    const result = await electronAPI.moveFile(selectedFile.path);
    if (!result.ok && !result.canceled)
      openDialog({
        mode: "confirm",
        title: "Could not move file",
        message: result.error || "Could not move file.",
        confirmLabel: "OK",
        onConfirm: () => undefined,
      });
    if (result.ok) await loadDirectory(currentPath);
  }, [currentPath, electronAPI, loadDirectory, openDialog, selectedFile]);

  const addIndexSource = useCallback(async () => {
    if (!electronAPI) return false;
    const state = await electronAPI.selectIndexSource();
    if (state) {
      applyPersistedState(state);
      await refreshSources();
      if (currentPath === allSourcesPath)
        void loadDirectory(allSourcesPath, explodedRef.current, true, true);
      return true;
    }
    return false;
  }, [
    allSourcesPath,
    applyPersistedState,
    currentPath,
    electronAPI,
    loadDirectory,
    refreshSources,
  ]);

  const addMachineSource = useCallback(async () => {
    if (!electronAPI) return;
    const state = await electronAPI.addMachineSource();
    if (state) {
      applyPersistedState(state);
      await refreshSources();
      if (currentPath === allSourcesPath)
        void loadDirectory(allSourcesPath, explodedRef.current, true, true);
    }
  }, [
    allSourcesPath,
    applyPersistedState,
    currentPath,
    electronAPI,
    loadDirectory,
    refreshSources,
  ]);

  const createDigitalFolder = useCallback(async () => {
    if (!electronAPI) return;
    openDialog({
      mode: "text",
      title: "New digital folder",
      message:
        "Digital folders contain references only. Source files are never moved or changed.",
      placeholder: "Digital folder name",
      confirmLabel: "Create digital folder",
      onConfirm: async (name) =>
        applyPersistedState(await electronAPI.createDigitalFolder(name)),
    });
  }, [applyPersistedState, electronAPI, openDialog]);

  const openDigitalFolder = useCallback(
    async (folderId: string) => {
      if (!electronAPI) return;
      await navigateToDigitalFolder(folderId, true);
    },
    [electronAPI, navigateToDigitalFolder],
  );

  const renameDigitalFolder = useCallback(
    (folder: DigitalFolder) => {
      if (!electronAPI) return;
      openDialog({
        mode: "text",
        title: "Rename virtual folder",
        initialValue: folder.name,
        placeholder: "Folder name",
        message:
          "Only the library folder name changes. Original files remain unchanged.",
        confirmLabel: "Rename",
        onConfirm: async (name) => {
          const state = await electronAPI.renameDigitalFolder(folder.id, name);
          setDigitalFolders(state.digitalFolders);
        },
      });
    },
    [electronAPI, openDialog],
  );

  const deleteDigitalFolder = useCallback(
    async (folderId: string) => {
      if (!electronAPI) return;
      openDialog({
        mode: "confirm",
        title: "Delete digital folder?",
        message:
          "Only this browser reference collection will be deleted. Source files will not be changed.",
        confirmLabel: "Delete folder",
        destructive: true,
        onConfirm: async () => {
          applyPersistedState(await electronAPI.deleteDigitalFolder(folderId));
          if (activeDigitalFolderId === folderId) {
            setActiveDigitalFolderId(null);
            if (currentPath) await loadDirectory(currentPath);
          }
        },
      });
    },
    [
      activeDigitalFolderId,
      applyPersistedState,
      currentPath,
      electronAPI,
      loadDirectory,
      openDialog,
    ],
  );

  const toggleDigitalFolderHidden = useCallback(
    async (folder: DigitalFolder) => {
      if (!electronAPI || folder.id === REFUSE_FOLDER_ID) return;
      applyPersistedState(
        await electronAPI.setDigitalFolderHidden(folder.id, !folder.hidden),
      );
    },
    [applyPersistedState, electronAPI],
  );

  const addSelectedToDigitalFolder = useCallback(
    async (folderId: string) => {
      if (!electronAPI) return;
      const paths =
        selectedFilePaths.size > 0
          ? Array.from(selectedFilePaths)
          : selectedFile && !selectedFile.isDirectory
            ? [selectedFile.path]
            : [];
      if (paths.length === 0) return;
      applyPersistedState(
        await electronAPI.addDigitalFolderReferences(folderId, paths),
      );
      clearFileSelection();
      if (activeDigitalFolderId === folderId) {
        await openDigitalFolder(folderId);
      }
    },
    [
      activeDigitalFolderId,
      applyPersistedState,
      electronAPI,
      clearFileSelection,
      openDigitalFolder,
      selectedFile,
      selectedFilePaths,
    ],
  );

  const metadataTargets = useMemo(() => {
    if (selectedFilePaths.size > 0) return Array.from(selectedFilePaths);
    return selectedFile && !selectedFile.isDirectory ? [selectedFile.path] : [];
  }, [selectedFile, selectedFilePaths]);
  const locationTargetFiles = useMemo(
    () =>
      selectedMedia<FileInfo>(
        metadataTargets,
        files,
        searchResults.filter(
          (result) =>
            result._priority !== 3 ||
            (result.confidence ?? -Infinity) >= confidence,
        ),
      ),
    [confidence, files, metadataTargets, searchResults],
  );
  const personMediaPaths = useMemo(
    () => new Set(locationTargetFiles.map((file) => file.path)),
    [locationTargetFiles],
  );

  const editVirtualName = useCallback(() => {
    if (!electronAPI || metadataTargets.length !== 1) return;
    const filePath = metadataTargets[0];
    openDialog({
      mode: "text",
      title: "Set virtual name",
      message: "This changes only how the file appears and searches in Silo.",
      initialValue: fileMetadata[filePath]?.displayName || "",
      placeholder: "Virtual name",
      confirmLabel: "Save name",
      onConfirm: async (displayName) => {
        applyPersistedState(
          await electronAPI.updateFileMetadata([filePath], { displayName }),
        );
        clearFileSelection();
      },
    });
  }, [
    applyPersistedState,
    clearFileSelection,
    electronAPI,
    fileMetadata,
    metadataTargets,
    openDialog,
  ]);

  const editKeywords = useCallback(() => {
    if (!electronAPI || metadataTargets.length === 0) return;
    const singleMetadata =
      metadataTargets.length === 1
        ? fileMetadata[metadataTargets[0]]
        : undefined;
    openDialog({
      mode: "text",
      title: metadataTargets.length === 1 ? "Edit keywords" : "Add keywords",
      message:
        metadataTargets.length === 1
          ? "Separate keywords with commas. These terms receive priority in search."
          : `Keywords will be added to ${metadataTargets.length} selected files.`,
      initialValue: singleMetadata?.keywords.join(", ") || "",
      placeholder: "travel, family, favorite",
      confirmLabel: "Save keywords",
      onConfirm: async (value) => {
        const keywords = value
          .split(",")
          .map((keyword) => keyword.trim())
          .filter(Boolean);
        applyPersistedState(
          await electronAPI.updateFileMetadata(metadataTargets, {
            keywords,
            mergeKeywords: metadataTargets.length > 1,
          }),
        );
        clearFileSelection();
      },
    });
  }, [
    applyPersistedState,
    clearFileSelection,
    electronAPI,
    fileMetadata,
    metadataTargets,
    openDialog,
  ]);

  const editVideoMetadata = useCallback((filePath: string, field: "keywords" | "people" | "places") => {
    const metadata = fileMetadata[filePath];
    const labels = { keywords: "keywords", people: "people", places: "places" };
    const current = metadata?.[field] ?? [];
    openDialog({
      mode: "text",
      title: `Edit video ${labels[field]}`,
      message: `Separate ${labels[field]} with commas. These labels are stored in Silo and do not change the source file.`,
      initialValue: current.join(", "),
      confirmLabel: "Save labels",
      onConfirm: async (value) => {
        if (!electronAPI) return;
        try {
          applyPersistedState(await electronAPI.updateFileMetadata([filePath], {
            [field]: value.split(",").map((item) => item.trim()).filter(Boolean),
          }));
          setSortIndicatorRevision((revision) => revision + 1);
        } catch (cause) {
          throw cause instanceof Error ? cause : new Error("Could not save video labels.");
        }
      },
    });
  }, [applyPersistedState, electronAPI, fileMetadata, openDialog]);

  const editYear = useCallback(
    (paths: string[] = metadataTargets) => {
      if (!electronAPI || paths.length === 0) return;
      openDialog({
        mode: "text",
        title:
          paths.length === 1
            ? "Edit year"
            : `Edit year for ${paths.length} files`,
        message:
          "Set the library year (for example, 2003). Enter ‘reset’ to use the original date again. Original files and timestamps will not change.",
        initialValue:
          paths.length === 1 && fileMetadata[paths[0]]?.year !== undefined
            ? String(fileMetadata[paths[0]].year)
            : "",
        placeholder: "2003 or reset",
        confirmLabel: "Save year",
        onConfirm: async (value) => {
          const reset = value.toLowerCase() === "reset";
          if (!reset && !/^\d{1,4}$/.test(value))
            throw new Error("Enter a year between 1 and 9999, or ‘reset’.");
          const year = reset ? null : Number(value);
          if (year !== null && year < 1)
            throw new Error("Enter a year between 1 and 9999.");
          applyPersistedState(
            await electronAPI.updateFileMetadata(paths, { year }),
          );
          clearFileSelection();
        },
      });
    },
    [
      applyPersistedState,
      clearFileSelection,
      electronAPI,
      fileMetadata,
      metadataTargets,
      openDialog,
    ],
  );

  const applyGeoAssignment = useCallback(
    (result: GeoAssignmentResult) => {
      applyPersistedState(result.appState);
      setShowLocationPicker(false);
      clearFileSelection();
    },
    [applyPersistedState, clearFileSelection],
  );

  const downloadDigitalFolder = useCallback(
    async (folderId: string) => {
      if (!electronAPI) return;
      const result = await electronAPI.downloadDigitalFolder(folderId);
      if (!result.ok && !result.canceled) {
        openDialog({
          mode: "confirm",
          title: result.copied
            ? "Download Partially Complete"
            : "Download Failed",
          message: result.copied
            ? `${result.copied} copied. ${result.error || ""}`
            : result.error || "No files could be copied.",
          confirmLabel: "OK",
          onConfirm: () => undefined,
        });
      }
    },
    [electronAPI, openDialog],
  );

  const removeSelectedFromDigitalFolder = useCallback(async () => {
    if (!electronAPI || !selectedFile || !activeDigitalFolderId) return;
    applyPersistedState(
      await electronAPI.removeDigitalFolderReference(
        activeDigitalFolderId,
        selectedFile.path,
      ),
    );
    clearFileSelection();
    await openDigitalFolder(activeDigitalFolderId);
  }, [
    activeDigitalFolderId,
    applyPersistedState,
    clearFileSelection,
    electronAPI,
    openDigitalFolder,
    selectedFile,
  ]);

  const toggleFileSelection = useCallback((filePath: string) => {
    setSelectedFilePaths((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const handleDragSelectChange = useCallback(
    (paths: Set<string>, additive: boolean) => {
      setSelectedFilePaths((prev) => {
        if (!additive) return paths;
        const next = new Set(prev);
        paths.forEach((path) => next.add(path));
        return next;
      });
    },
    [],
  );

  const { dragCompletedRef } = useDragSelect({
    scopeSelector: ".file-grid, .file-list, .person-photos",
    onSelectionChange: handleDragSelectChange,
    onToggle: toggleFileSelection,
  });

  const openFolderSelector = useCallback(
    (filePath?: string, filePaths?: string[]) => {
      setFolderSelectionFile(filePath ?? null);
      setFolderSelectionPaths(filePaths ? Array.from(new Set(filePaths)) : null);
      setShowFolderSelector(true);
    },
    [],
  );

  const closeFolderSelector = useCallback(() => {
    setFolderSelectionFile(null);
    setFolderSelectionPaths(null);
    setShowFolderSelector(false);
  }, []);

  const folderSelectorFilePaths =
    folderSelectionPaths ??
    (selectedFilePaths.size > 0
      ? Array.from(selectedFilePaths)
      : folderSelectionFile
        ? [folderSelectionFile]
        : []);

  const addFilesToFolder = useCallback(
    async (folderId: string, filePaths: string[]) => {
      if (!electronAPI || filePaths.length === 0) return;
      applyPersistedState(
        await electronAPI.addDigitalFolderReferences(folderId, filePaths),
      );
      if (activeDigitalFolderId === folderId) {
        await openDigitalFolder(folderId);
      }
      if (!folderSelectionPaths) clearFileSelection();
      setFolderSelectionFile(null);
      setFolderSelectionPaths(null);
      setShowFolderSelector(false);
    },
    [
      activeDigitalFolderId,
      applyPersistedState,
      clearFileSelection,
      electronAPI,
      folderSelectionPaths,
      openDigitalFolder,
    ],
  );

  const openPerson = useCallback(
    async (personId: string) => {
      if (!electronAPI) return;
      clearFileSelection();
      // Photos first: loading them records deleted files, which the detail's counts then exclude.
      const photos = await electronAPI.getPersonPhotoFiles(personId);
      const [detail, suggestions] = await Promise.all([
        electronAPI.getPerson(personId),
        electronAPI.getPersonSuggestionFiles(personId),
      ]);
      setSelectedPersonId(personId);
      setPersonDetail(detail);
      setPersonPhotos(photos);
      setPersonSuggestions(suggestions);
      setSelectedPersonPhoto(null);
      setSelectedPhotoFaces([]);
    },
    [clearFileSelection, electronAPI],
  );

  const createPerson = useCallback(async () => {
    if (!electronAPI) return;
    openDialog({
      mode: "text",
      title: "New person",
      placeholder: "Person name",
      confirmLabel: "Create person",
      onConfirm: async (name) =>
        setPeople(await electronAPI.createPerson(name)),
    });
  }, [electronAPI, openDialog]);

  const renamePerson = useCallback(async () => {
    if (!electronAPI || !personDetail) return;
    openDialog({
      mode: "text",
      title: "Rename person",
      initialValue: personDetail.name,
      placeholder: "Person name",
      confirmLabel: "Rename",
      onConfirm: async (name) => {
        setPeople(await electronAPI.renamePerson(personDetail.id, name));
        // Update name index with confirmed photos
        const confirmedPhotoPaths = personDetail.confirmedPhotoPaths || [];
        if (confirmedPhotoPaths.length > 0) {
          await electronAPI?.updateNameIndex(
            name,
            confirmedPhotoPaths,
            "person",
            personDetail.id,
          );
        }
        await openPerson(personDetail.id);
      },
    });
  }, [electronAPI, openDialog, openPerson, personDetail]);

  const deletePerson = useCallback(async () => {
    if (!electronAPI || !personDetail) return;
    openDialog({
      mode: "confirm",
      title: `Delete ${personDetail.name}?`,
      message:
        "The person cluster and its references will be removed. Source photos will not be changed.",
      confirmLabel: "Delete person",
      destructive: true,
      onConfirm: async () => {
        setPeople(await electronAPI.deletePerson(personDetail.id));
        setSelectedPersonId(null);
        setPersonDetail(null);
        setPersonPhotos([]);
      },
    });
  }, [electronAPI, openDialog, personDetail]);

  const mergePerson = useCallback(
    (target: PersonSummary) => {
      if (!electronAPI || !personDetail) return;
      const source = personDetail;
      openDialog({
        mode: "confirm",
        title: `Merge ${source.name} into ${target.name}?`,
        message: `All ${source.photoCount.toLocaleString()} photos (${source.confirmedCount.toLocaleString()} confirmed) move into ${target.name}, keeping their confirmed or unconfirmed state. ${source.name} is then removed. You can undo this with ⌘Z.`,
        confirmLabel: "Merge",
        onConfirm: async () => {
          await electronAPI.mergePerson(source.id, target.id);
          await refreshPeople();
          await openPerson(target.id);
        },
      });
    },
    [electronAPI, openDialog, openPerson, personDetail, refreshPeople],
  );

  const selectPersonPhoto = useCallback(
    async (photo: FileInfo) => {
      if (!electronAPI) return;
      setSelectedPersonPhoto(photo);
      setSelectedPhotoFaces(await electronAPI.getImageFaces(photo.path));
    },
    [electronAPI],
  );

  /** Selected photos of the open person that a bulk action applies to when `photoPath` is among them. */
  const personSelectionFor = useCallback(
    (photoPath: string) => {
      if (!selectedFilePaths.has(photoPath)) return [photoPath];
      const selected = uniquePersonPhotos
        .map((photo) => photo.path)
        .filter((path) => selectedFilePaths.has(path));
      return selected.length > 0 ? selected : [photoPath];
    },
    [selectedFilePaths, uniquePersonPhotos],
  );

  const confirmPersonPhoto = useCallback(
    async (photoPath: string) => {
      if (!electronAPI || !personDetail) return;
      const paths = personSelectionFor(photoPath);
      setPersonDetail(
        paths.length > 1
          ? await electronAPI.confirmPersonPhotos(personDetail.id, paths)
          : await electronAPI.confirmPersonPhoto(personDetail.id, photoPath),
      );
    },
    [electronAPI, personDetail, personSelectionFor],
  );

  const removePersonPhoto = useCallback(
    async (photoPath: string) => {
      if (!electronAPI || !personDetail) return;
      const paths = personSelectionFor(photoPath);
      if (paths.length > 1) {
        await electronAPI.movePersonPhotos(personDetail.id, paths, null);
        setPersonDetail(await electronAPI.getPerson(personDetail.id));
        setSelectedFilePaths((current) => {
          const next = new Set(current);
          paths.forEach((path) => next.delete(path));
          return next;
        });
      } else {
        setPersonDetail(
          await electronAPI.removePersonPhoto(personDetail.id, photoPath),
        );
      }
      setPersonPhotos(await electronAPI.getPersonPhotoFiles(personDetail.id));
      if (selectedPersonPhoto && paths.includes(selectedPersonPhoto.path)) {
        setSelectedPersonPhoto(null);
        setSelectedPhotoFaces([]);
      }
    },
    [electronAPI, personDetail, personSelectionFor, selectedPersonPhoto],
  );

  const selectedPersonIdRef = useRef<string | null>(null);
  selectedPersonIdRef.current = selectedPersonId;

  useEffect(() => {
    if (!electronAPI) return;
    let toastTimer: number | null = null;
    const showToast = (message: string) => {
      setHistoryToast(message);
      if (toastTimer !== null) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => setHistoryToast(""), 3500);
    };
    const remove = electronAPI.onEditMenuCommand(async (command) => {
      const active = document.activeElement as HTMLElement | null;
      // Text fields keep normal text undo/redo.
      if (
        active &&
        (active.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
      ) {
        document.execCommand(command);
        return;
      }
      try {
        const result =
          command === "undo"
            ? await electronAPI.undoPeopleEdit()
            : await electronAPI.redoPeopleEdit();
        if (!result.label) {
          showToast(command === "undo" ? "Nothing to undo" : "Nothing to redo");
          return;
        }
        showToast(`${command === "undo" ? "Undid" : "Redid"}: ${result.label}`);
        await refreshPeople();
        const personId = selectedPersonIdRef.current;
        if (personId) await openPerson(personId);
        const facePhotoPath = faceAssignmentPhotoPathRef.current;
        if (facePhotoPath && selectedFile?.path === facePhotoPath && selectedFile.type === "image") {
          const faces = await electronAPI.getImageFaces(facePhotoPath);
          if (faceAssignmentPhotoPathRef.current !== facePhotoPath) return;
          setFaceAssignmentFaces(faces);
          if (selectedPersonPhoto?.path === facePhotoPath)
            setSelectedPhotoFaces(faces);
        }
      } catch (cause) {
        showToast(cause instanceof Error ? cause.message : "Could not undo.");
      }
    });
    return () => {
      remove();
      if (toastTimer !== null) window.clearTimeout(toastTimer);
    };
  }, [
    electronAPI,
    faceAssignmentOpen,
    faceAssignmentPhotoPath,
    openPerson,
    refreshPeople,
    selectedFile,
    selectedPersonPhoto,
  ]);

  /** Runs a person action, then refreshes the detail, photos, suggestions, and people list. */
  const runPersonAction = useCallback(
    async (action: (personId: string) => Promise<unknown>) => {
      if (!electronAPI || !personDetail) return;
      const personId = personDetail.id;
      setPersonBusy(true);
      try {
        await action(personId);
        await openPerson(personId);
        await refreshPeople();
      } catch (cause) {
        openDialog({
          mode: "confirm",
          title: "Could not update person",
          message:
            cause instanceof Error
              ? cause.message.replace(
                  /^Error invoking remote method '[^']+': (Error: )?/,
                  "",
                )
              : "Something went wrong.",
          confirmLabel: "OK",
          onConfirm: () => undefined,
        });
      } finally {
        setPersonBusy(false);
      }
    },
    [electronAPI, openDialog, openPerson, personDetail, refreshPeople],
  );

  const trainPerson = useCallback(
    () => runPersonAction((personId) => electronAPI!.trainPerson(personId)),
    [electronAPI, runPersonAction],
  );

  const banPerson = useCallback(() => {
    if (!personDetail) return;
    openDialog({
      mode: "confirm",
      title: `Ban ${personDetail.name}?`,
      message:
        "This cluster's photos, plus photos where face matching finds their confirmed face, will be hidden from the file browser, search, map, albums, and other people. They stay viewable only under People → Confirmed faces → Banned people with Show on. Files on disk are not changed.",
      confirmLabel: "Ban person",
      destructive: true,
      onConfirm: () =>
        runPersonAction((personId) => electronAPI!.banPerson(personId)),
    });
  }, [electronAPI, openDialog, personDetail, runPersonAction]);

  const bannedPersonHidden =
    personDetail?.status === "banned" && !revealBannedFaces;

  /** Right-click (or Shift-click) a photo: act on the current selection if it includes this photo. */
  const openPhotoMenu = useCallback(
    (event: React.MouseEvent, photo: FileInfo, extendSelection: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      const personPaths = new Set(uniquePersonPhotos.map((item) => item.path));
      let paths = Array.from(selectedFilePaths).filter((filePath) =>
        personPaths.has(filePath),
      );
      if (!paths.includes(photo.path)) {
        paths = extendSelection ? [...paths, photo.path] : [photo.path];
        setSelectedFilePaths(new Set(paths));
      }
      setPhotoMenuQuery("");
      setPhotoMenu({ x: event.clientX, y: event.clientY, paths });
    },
    [selectedFilePaths, uniquePersonPhotos],
  );

  const movePersonPhotosTo = useCallback(
    async (
      paths: string[],
      target: { personId?: string; newName?: string } | null,
    ) => {
      await runPersonAction((personId) =>
        electronAPI!.movePersonPhotos(personId, paths, target),
      );
      setSelectedFilePaths((current) => {
        const next = new Set(current);
        paths.forEach((filePath) => next.delete(filePath));
        return next;
      });
      if (selectedPersonPhoto && paths.includes(selectedPersonPhoto.path)) {
        setSelectedPersonPhoto(null);
        setSelectedPhotoFaces([]);
      }
    },
    [electronAPI, runPersonAction, selectedPersonPhoto],
  );

  const respondToSuggestions = useCallback(
    (paths: string[], accept: boolean) =>
      runPersonAction((personId) =>
        accept
          ? electronAPI!.acceptPersonSuggestions(personId, paths)
          : electronAPI!.rejectPersonSuggestions(personId, paths),
      ),
    [electronAPI, runPersonAction],
  );

  const setPersonCoverPhoto = useCallback(
    async (photoPath: string | null) => {
      if (!electronAPI || !personDetail) return;
      setPersonDetail(
        await electronAPI.setPersonCoverPhoto(personDetail.id, photoPath),
      );
    },
    [electronAPI, personDetail],
  );

  const setPreviewProfilePicture = useCallback(
    async (personId: string, photoPath: string) => {
      if (!electronAPI) return;
      setProfilePictureBusy(true);
      setProfilePictureNotice("");
      try {
        const person = await electronAPI.getPerson(personId);
        if (!person) throw new Error("This person no longer exists.");
        if (!person.photoPaths.includes(photoPath))
          await electronAPI.addPhotosToPerson([photoPath], { personId });
        const detail = await electronAPI.setPersonCoverPhoto(
          personId,
          photoPath,
        );
        if (personDetail?.id === personId) setPersonDetail(detail);
        await refreshPeople();
        refreshPhotoIndicators([photoPath]);
        setProfilePictureNotice(`Profile picture set for ${person.name}.`);
      } catch (cause) {
        setProfilePictureNotice(
          cause instanceof Error
            ? cause.message
            : "Could not set profile picture.",
        );
      } finally {
        setProfilePictureBusy(false);
      }
    },
    [electronAPI, personDetail?.id, refreshPeople],
  );

  useEffect(() => {
    setProfilePicturePicker(null);
    setProfilePictureNotice("");
  }, [selectedFile?.path, viewerOpen]);

  const addSelectedPhotoToPerson = useCallback(async () => {
    if (
      !electronAPI ||
      !personDetail ||
      !selectedFile ||
      !PERSON_MEDIA_TYPES.has(selectedFile.type)
    )
      return;
    setPersonDetail(
      await electronAPI.addPhotoToPerson(personDetail.id, selectedFile.path),
    );
    setPersonPhotos(await electronAPI.getPersonPhotoFiles(personDetail.id));
  }, [electronAPI, personDetail, selectedFile]);

  const assignFaceToPerson = useCallback(
    async (faceId: string) => {
      if (!electronAPI || !personDetail) return;
      setPersonDetail(
        await electronAPI.assignFaceToPerson(personDetail.id, faceId),
      );
      setPersonPhotos(await electronAPI.getPersonPhotoFiles(personDetail.id));
      if (selectedPersonPhoto)
        setSelectedPhotoFaces(
          await electronAPI.getImageFaces(selectedPersonPhoto.path),
        );
    },
    [electronAPI, personDetail, selectedPersonPhoto],
  );

  const rememberSearch = useCallback((query: string) => {
    const clean = query.trim();
    if (clean.length < 2) return;
    setSearchHistory((current) => {
      const next = [
        clean,
        ...current.filter((item) => item.toLowerCase() !== clean.toLowerCase()),
      ].slice(0, 100);
      localStorage.setItem("silo.searchHistory", JSON.stringify(next));
      return next;
    });
  }, []);

  const forgetSearch = useCallback((query: string) => {
    setSearchHistory((current) => {
      const next = current.filter((item) => item !== query);
      localStorage.setItem("silo.searchHistory", JSON.stringify(next));
      return next;
    });
  }, []);

  // A search counts once the user pauses on it, so half-typed words don't fill the history.
  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) return;
    const timer = window.setTimeout(() => rememberSearch(query), 2500);
    return () => window.clearTimeout(timer);
  }, [rememberSearch, searchQuery]);

  const runSemanticSearch = useCallback(
    async (_showLoading: boolean) => {
      if (
        !electronAPI ||
        !searchQuery.trim() ||
        searchIndexReadiness.status === "unavailable" ||
        searchIndexReadiness.status === "error"
      )
        return;
      const requestId = ++searchRequestRef.current;
      const query = searchQuery.trim();
      const startedAt = performance.now();
      const requestRoots = new Set(enabledSourcePathsRef.current);
      setSearchTiming({
        query,
        requestId,
        startedAt,
        firstResultAt: null,
        completedAt: null,
      });
      setSearchProgress({ scanned: 0, total: 0 });
      setSearching(true);
      setSearchError("");
      try {
        const results = await electronAPI.semanticSearch(
          searchQuery,
          0,
          requestId,
        );
        if (requestId === searchRequestRef.current) {
          const hidden = bannedHiddenPathsRef.current;
          const visible = results.filter((result) =>
            !hidden.has(result.path) &&
            pathIsWithinAnySource(result.path, enabledSourcePathsRef.current),
          );
          rememberSearchResultOrder(visible, searchQuery);
          setSearchResults(visible);
          semanticSearchedSourcesRef.current = { query, roots: requestRoots };
        }
      } catch (cause) {
        if (requestId === searchRequestRef.current) {
          setSearchResults([]);
          setSearchError(
            cause instanceof Error
              ? cause.message
              : "This search request is not allowed.",
          );
        }
      } finally {
        if (requestId === searchRequestRef.current) {
          const completedAt = performance.now();
          setSearchTiming((current) =>
            current?.requestId === requestId
              ? { ...current, completedAt: current.completedAt ?? completedAt }
              : current,
          );
          setSearching(false);
        }
      }
    },
    [
      electronAPI,
      rememberSearchResultOrder,
      searchIndexReadiness.status,
      searchQuery,
    ],
  );

  useEffect(() => {
    if (!electronAPI) return;
    return electronAPI.onSemanticSearchProgress((progress) => {
      if (progress.requestId !== searchRequestRef.current) return;
      const hidden = bannedHiddenPathsRef.current;
      const visible = progress.results.filter((result) =>
        !hidden.has(result.path) &&
        pathIsWithinAnySource(result.path, enabledSourcePathsRef.current),
      );
      rememberSearchResultOrder(visible, searchQueryRef.current);
      const receivedAt = performance.now();
      const done = progress.status === "done";
      setSearchTiming((current) =>
        current?.requestId === progress.requestId
          ? {
              ...current,
              firstResultAt:
                current.firstResultAt ??
                (visible.length > 0 ? receivedAt : null),
              completedAt:
                done ? (current.completedAt ?? receivedAt) : current.completedAt,
            }
          : current,
      );
      setSearchResults(visible);
      if (progress.textCapped) setFastFileSearchCapped(true);
      setSearchProgress({
        scanned: progress.scanned,
        total: progress.total,
        mode: progress.mode,
      });
      setSearching(!done);
    });
  }, [electronAPI, rememberSearchResultOrder]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (searchQueryStartedAtRef.current?.query !== query)
      searchQueryStartedAtRef.current = {
        query,
        startedAt: performance.now(),
      };
    semanticSearchedSourcesRef.current = { query, roots: new Set() };
    searchResultOrderRef.current = { query, paths: [] };
    setSearchResultOrder([]);
    setFreezeSearchResultOrder(true);
    setSearchResults([]);
    fastFileSearchResultsRef.current.clear();
    fastFileSearchResultsQueryRef.current = "";
    setFastFileSearchResults([]);
    setFastFileSearchCapped(false);
    setSearchProgress({ scanned: 0, total: 0 });
    setSearchTiming(null);
  }, [searchQuery]);

  useEffect(() => {
    const generation = ++fastFileSearchGenerationRef.current;
    const matches = fastFileSearchResultsRef.current;
    matches.clear();
    setFastFileSearchResults([]);
    setFastFileSearchCapped(false);
    const query = searchQuery.trim().toLocaleLowerCase();
    if (
      !query ||
      searchIndexReadiness.status === "unavailable" ||
      searchIndexReadiness.status === "error"
    )
      return;

    scheduleFastFileMatchesRef.current(filesRef.current, query, generation);
    return () => {
      fastFileSearchGenerationRef.current += 1;
    };
  }, [
    bannedHiddenPaths,
    enabledSourcePathsKey,
    searchIndexReadiness.status,
    searchQuery,
  ]);

  useEffect(() => {
    if (
      !searchQuery.trim() ||
      searchIndexReadiness.status === "unavailable" ||
      searchIndexReadiness.status === "error" ||
      fastFileSearchResultsQueryRef.current !==
        searchQuery.trim().toLocaleLowerCase()
    )
      return;
    rememberSearchResultOrder(fastFileSearchResults, searchQuery);
  }, [
    fastFileSearchResults,
    rememberSearchResultOrder,
    searchIndexReadiness.status,
    searchQuery,
  ]);

  useEffect(() => {
    if (searchSourceScopeKeyRef.current === enabledSourcePathsKey) return;
    searchSourceScopeKeyRef.current = enabledSourcePathsKey;
    const query = searchQueryRef.current.trim();
    searchRequestRef.current += 1;
    semanticSearchedSourcesRef.current = { query, roots: new Set() };
    setSearchResults((current) =>
      current.filter((result) =>
        pathIsWithinAnySource(result.path, enabledSourcePaths),
      ),
    );
    setSearchProgress({ scanned: 0, total: 0 });
    setSearching(false);
    if (electronAPI)
      void electronAPI.cancelSemanticSearch().catch(() => undefined);
  }, [electronAPI, enabledSourcePaths, enabledSourcePathsKey]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      searchRequestRef.current += 1;
      setSearchResults([]);
      setSearchProgress({ scanned: 0, total: 0 });
      setSearching(false);
      setSearchError("");
      return;
    }
    if (
      searchIndexReadiness.status === "unavailable" ||
      searchIndexReadiness.status === "error"
    ) {
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => {
      searchDebounceTimerRef.current = null;
      void runSemanticSearch(true);
    }, 120);
    searchDebounceTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (searchDebounceTimerRef.current === timer)
        searchDebounceTimerRef.current = null;
      if (electronAPI)
        void electronAPI.cancelSemanticSearch().catch(() => undefined);
    };
  }, [
    electronAPI,
    runSemanticSearch,
    searchIndexReadiness.status,
    searchQuery,
  ]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (
      !electronAPI ||
      !query ||
      pendingSourceSelectionsRef.current.size > 0 ||
      searchIndexReadiness.status === "unavailable" ||
      searchIndexReadiness.status === "error" ||
      searchDebounceTimerRef.current !== null
    )
      return;
    const coverage = semanticSearchedSourcesRef.current;
    if (coverage.query !== query) return;
    const addedUnsearchedSource = Array.from(enabledSourcePathsRef.current).some(
      (root) => !coverage.roots.has(root),
    );
    if (!addedUnsearchedSource) return;
    const timer = window.setTimeout(() => {
      void runSemanticSearch(true);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    electronAPI,
    enabledSourcePathsKey,
    runSemanticSearch,
    searchIndexReadiness.status,
    searchQuery,
    sourceSelectionRevision,
  ]);

  useEffect(() => {
    if (contentSafetyRevision > 0) void runSemanticSearch(false);
  }, [contentSafetyRevision, runSemanticSearch]);

  const rawContentFiles: FileInfo[] = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const resultsByPath = new Map<string, SemanticSearchResult>();
    for (const result of fastFileSearchResults)
      if (
        pathIsWithinAnySource(result.path, enabledSourcePaths) &&
        searchFeedback[result.path] !== "removed" &&
        !bannedHiddenPaths.has(result.path)
      )
        resultsByPath.set(result.path, result);
    for (const result of searchResults) {
      if (
        !pathIsWithinAnySource(result.path, enabledSourcePaths) ||
        searchFeedback[result.path] === "removed" ||
        bannedHiddenPaths.has(result.path)
      ) continue;
      if (
        result._priority === 3 &&
        (result.confidence ?? -Infinity) < confidence
      )
        continue;
      const textMatch = resultsByPath.get(result.path);
      const textPriority = textMatch?._priority ?? 3;
      const resultPriority = result._priority ?? 3;
      resultsByPath.set(
        result.path,
        textMatch
          ? {
              ...textMatch,
              ...result,
              _priority: Math.min(textPriority, resultPriority) as 0 | 1 | 2 | 3,
              _source:
                textPriority <= resultPriority
                  ? textMatch._source
                  : result._source,
            }
          : result,
      );
    }
    if (!activeDigitalFolderId) return Array.from(resultsByPath.values());
    return files
      .filter((file) => resultsByPath.has(file.path))
      .map((file) => ({ ...file, ...resultsByPath.get(file.path) }));
  }, [
    activeDigitalFolderId,
    bannedHiddenPaths,
    enabledSourcePaths,
    fastFileSearchResults,
    files,
    confidence,
    searchQuery,
    searchResults,
    searchFeedback,
  ]);
  const contentFiles = useMemo(
    () => {
      if (Object.keys(fileMetadata).length === 0) return rawContentFiles;
      return rawContentFiles.map((file) => {
        const metadata = fileMetadata[file.path];
        if (!metadata?.displayName && metadata?.year === undefined) return file;
        return {
          ...file,
          name: metadata.displayName || file.name,
          year: metadata.year,
        };
      });
    },
    [fileMetadata, rawContentFiles],
  );

  useEffect(() => {
    if (!electronAPI?.onPhotoIndicatorsChanged) return;
    const changed = () => setSortIndicatorRevision((revision) => revision + 1);
    let refreshTimer: number | null = null;
    const scheduleGeoRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        changed();
      }, 8000);
    };
    const removePeople =
      electronAPI.onPhotoIndicatorsChanged(scheduleGeoRefresh);
    let geoVersion = -1;
    const removeGeo = electronAPI.onGeoIndexProgress((progress) => {
      if (progress.photosVersion === geoVersion) return;
      geoVersion = progress.photosVersion;
      scheduleGeoRefresh();
    });
    return () => {
      removePeople();
      removeGeo();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [electronAPI]);

  const metadataFiles = contentFiles;

  useEffect(() => {
    const work = photoIndicatorWorkRef.current;
    if (!electronAPI || appSection !== "files" || !needsPhotoMetadata) {
      work.enabled = false;
      setMetadataIndicatorProgress(null);
      return;
    }

    work.enabled = true;
    const mediaFiles = metadataFiles.filter(
      (file) =>
        !file.isDirectory && (file.type === "image" || file.type === "video"),
    );
    work.currentFiles = new Map(mediaFiles.map((file) => [file.path, file]));
    work.currentPaths = new Set(work.currentFiles.keys());
    work.currentTotal = work.currentPaths.size;
    for (const filePath of work.pending.keys())
      if (!work.currentPaths.has(filePath)) work.pending.delete(filePath);

    if (work.revision !== sortIndicatorRevision) {
      work.revision = sortIndicatorRevision;
      work.generation += 1;
      work.completed.clear();
      work.failed.clear();
      work.pending.clear();
      work.currentProcessed = 0;
      setSortIndicatorError("");
    } else {
      work.currentProcessed = 0;
      for (const filePath of work.currentPaths)
        if (work.completed.has(filePath) || work.failed.has(filePath))
          work.currentProcessed += 1;
    }

    for (const file of mediaFiles) {
      if (
        !work.completed.has(file.path) &&
        !work.failed.has(file.path) &&
        !work.active.has(file.path) &&
        !work.pending.has(file.path)
      )
        work.pending.set(file.path, file);
    }

    const updateProgress = () => {
      const pendingCurrent = Array.from(work.pending.keys()).some((filePath) =>
        work.currentPaths.has(filePath),
      );
      const activeCurrent = Array.from(work.active).some((filePath) =>
        work.currentPaths.has(filePath),
      );
      if (pendingCurrent || activeCurrent || work.currentProcessed < work.currentTotal)
        setMetadataIndicatorProgress({
          processed: work.currentProcessed,
          total: work.currentTotal,
        });
      else setMetadataIndicatorProgress(null);
    };

    const processQueue = async () => {
      if (work.running || !work.enabled) return;
      work.running = true;
      try {
        while (work.enabled && work.pending.size) {
          const batch = Array.from(work.pending.entries()).slice(0, 1000);
          const generation = work.generation;
          for (const [filePath] of batch) {
            work.pending.delete(filePath);
            work.active.add(filePath);
          }
          try {
            const paths = batch.map(([filePath]) => filePath);
            const values = await electronAPI.getPhotoIndicators(paths);
            if (generation !== work.generation) {
              for (const [filePath] of batch) {
                work.active.delete(filePath);
                const currentFile = work.currentFiles.get(filePath);
                if (currentFile) work.pending.set(filePath, currentFile);
              }
              updateProgress();
              continue;
            }

            const snapshot: Record<
              string,
              { hasLocation: boolean; people: string[] }
            > = {};
            const next: Record<string, { people: boolean; mapped: boolean }> = {};
            let missing = 0;
            for (const [filePath] of batch) {
              const indicators = values[filePath];
              work.active.delete(filePath);
              if (!indicators || !Array.isArray(indicators.people)) {
                work.failed.add(filePath);
                if (work.currentPaths.has(filePath)) work.currentProcessed += 1;
                missing += 1;
                continue;
              }
              snapshot[filePath] = indicators;
              next[filePath] = {
                people: indicators.people.length > 0,
                mapped: Boolean(indicators.hasLocation),
              };
              work.completed.add(filePath);
              if (work.currentPaths.has(filePath)) work.currentProcessed += 1;
            }
            if (Object.keys(snapshot).length) {
              publishPhotoIndicators(snapshot);
              let changedFlags = false;
              for (const [filePath, flags] of Object.entries(next)) {
                const current = sortIndicatorsRef.current[filePath];
                if (
                  current?.people === flags.people &&
                  current?.mapped === flags.mapped
                )
                  continue;
                sortIndicatorsRef.current[filePath] = flags;
                changedFlags = true;
              }
              if (changedFlags)
                setSortIndicatorDataRevision((revision) => revision + 1);
            }
            if (missing)
              setSortIndicatorError(
                `Could not load people and location data for ${missing} photos. Other results will continue loading.`,
              );
            updateProgress();
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          } catch (cause) {
            for (const [filePath] of batch) {
              work.active.delete(filePath);
              work.failed.add(filePath);
              if (work.currentPaths.has(filePath)) work.currentProcessed += 1;
            }
            setSortIndicatorError(
              cause instanceof Error
                ? cause.message
                : "Could not load sorting metadata.",
            );
            updateProgress();
          }
        }
      } finally {
        work.running = false;
        updateProgress();
        if (work.enabled && work.pending.size) void processQueue();
      }
    };

    updateProgress();
    void processQueue();
  }, [
    appSection,
    electronAPI,
    metadataFiles,
    needsPhotoMetadata,
    sortIndicatorRevision,
  ]);

  const waitingForSortIndicators =
    needsPhotoMetadata &&
    (metadataIndicatorProgress !== null || (needsRecursiveBrowse && loading));
  const showMetadataBusy = useStableBusy(waitingForSortIndicators);

  useMagicRanks(
    !audioOnlySelected && sort.field === "magic",
    appSection === "people" && selectedPersonId ? personPhotos : contentFiles,
    setMagicState,
    magicPrefs.preset,
  );

  const searchResultPositions = useMemo(
    () =>
      new Map(
        searchResultOrder.map(
          (filePath, position) => [filePath, position] as const,
        ),
      ),
    [searchResultOrder],
  );

  const deferBrowseSort =
    loading &&
    currentPath === allSourcesPath &&
    exploded &&
    !searchQuery.trim();
  const browseViewInputs = useMemo(
    () => ({
      contentFiles,
      deferBrowseSort,
      exploded,
      filters,
      magicRanks: magicState.ranks,
      searchQuery,
      searchFeedback,
      freezeSearchResultOrder,
      searchResultPositions,
      peopleFilter,
      locationFilter,
      sort,
      yearFilter,
      sortIndicatorRevision:
        sort.field === "people" ||
        sort.field === "mapped" ||
        peopleFilter !== "all" ||
        locationFilter !== "all"
          ? sortIndicatorDataRevision
          : 0,
    }),
    [
      contentFiles,
      deferBrowseSort,
      exploded,
      filters,
      freezeSearchResultOrder,
      locationFilter,
      magicState.ranks,
      peopleFilter,
      searchFeedback,
      searchQuery,
      searchResultPositions,
      sort,
      sortIndicatorDataRevision,
      yearFilter,
    ],
  );
  const deferredBrowseViewInputs = useDeferredValue(browseViewInputs);
  const sourceVisibilityInputs = useMemo(
    () => ({ enabledSourcePaths, allSourcePaths }),
    [allSourcePaths, enabledSourcePaths],
  );
  const deferredSourceVisibilityInputs = useDeferredValue(sourceVisibilityInputs);
  const browseViewUpdating =
    browseViewInputs !== deferredBrowseViewInputs ||
    sourceVisibilityInputs !== deferredSourceVisibilityInputs;

  const baseFilteredAndSortedFiles = useMemo(() => {
    const {
      contentFiles: viewContentFiles,
      deferBrowseSort: viewDeferBrowseSort,
      exploded: viewExploded,
      filters: viewFilters,
      magicRanks,
      searchQuery: viewSearchQuery,
      searchFeedback: viewSearchFeedback,
      freezeSearchResultOrder: viewFreezeSearchResultOrder,
      searchResultPositions: viewSearchResultPositions,
      peopleFilter: viewPeopleFilter,
      locationFilter: viewLocationFilter,
      sort: viewSort,
      yearFilter: viewYearFilter,
    } = deferredBrowseViewInputs;
    const filtered = viewContentFiles.filter((file) => {
      if (file.isDirectory)
        return (
          !viewSearchQuery.trim() &&
          !viewExploded &&
          viewPeopleFilter === "all" &&
          viewLocationFilter === "all"
        );
      if (
        !matchesMetadataFilters(
          sortIndicatorsRef.current[file.path],
          viewPeopleFilter,
          viewLocationFilter,
        )
      )
        return false;
      if (
        viewYearFilter.length > 0 &&
        !viewYearFilter.includes(modifiedYear(file))
      )
        return false;
      if (
        viewFilters.includedType !== "all" &&
        !selectedTypes(viewFilters.includedType).includes(file.type)
      )
        return false;
      return file.size >= viewFilters.sizeMin && file.size <= viewFilters.sizeMax;
    });

    if (!viewDeferBrowseSort) filtered.sort((first, second) => {
      if (viewSearchQuery.trim()) {
        const firstConfirmed = viewSearchFeedback[first.path] === "confirmed";
        const secondConfirmed = viewSearchFeedback[second.path] === "confirmed";
        if (firstConfirmed !== secondConfirmed)
          return firstConfirmed ? -1 : 1;
      }
      if (viewSearchQuery.trim()) {
        const firstEntityMatches = (first as SemanticSearchResult)._entityMatches ?? 0;
        const secondEntityMatches = (second as SemanticSearchResult)._entityMatches ?? 0;
        if (firstEntityMatches !== secondEntityMatches)
          return secondEntityMatches - firstEntityMatches;
      }
      if (
        viewSearchQuery.trim() &&
        viewFreezeSearchResultOrder &&
        searchResultOrderRef.current.query === viewSearchQuery.trim()
      ) {
        const firstPosition = viewSearchResultPositions.get(first.path);
        const secondPosition = viewSearchResultPositions.get(second.path);
        if (firstPosition !== undefined || secondPosition !== undefined) {
          if (firstPosition === undefined) return 1;
          if (secondPosition === undefined) return -1;
          if (firstPosition !== secondPosition)
            return firstPosition - secondPosition;
        }
      }
      if (viewSearchQuery.trim()) {
        const firstPriority = (first as SemanticSearchResult)._priority ?? 3;
        const secondPriority = (second as SemanticSearchResult)._priority ?? 3;
        if (firstPriority !== secondPriority)
          return firstPriority - secondPriority;
      }
      return compareFilesBySort(
        first,
        second,
        viewSort,
        magicRanks,
        sortIndicatorsRef.current,
      );
    });

    if (viewExploded || (viewSearchQuery.trim() && viewFreezeSearchResultOrder))
      return filtered;
    const folders: FileInfo[] = [];
    const files: FileInfo[] = [];
    for (const file of filtered)
      (file.isDirectory ? folders : files).push(file);
    return folders.concat(files);
  }, [deferredBrowseViewInputs]);

  const filteredAndSortedFiles = useMemo(
    () =>
      activeDigitalFolderId
        ? baseFilteredAndSortedFiles
        : baseFilteredAndSortedFiles.filter((file) =>
            pathIsVisibleForSelectedSources(
              file.path,
              deferredSourceVisibilityInputs.enabledSourcePaths,
              deferredSourceVisibilityInputs.allSourcePaths,
            ),
          ),
    [activeDigitalFolderId, baseFilteredAndSortedFiles, deferredSourceVisibilityInputs],
  );

  const hasSelectableFiles = useMemo(
    () => filteredAndSortedFiles.some((file) => !file.isDirectory),
    [filteredAndSortedFiles],
  );
  const selectedSearchResultCount = useMemo(
    () =>
      filteredAndSortedFiles.reduce(
        (count, file) =>
          count +
          Number(
            !file.isDirectory && selectedFilePaths.has(file.path),
          ),
        0,
      ),
    [filteredAndSortedFiles, selectedFilePaths],
  );

  const yearOptions = useMemo(
    () => {
      if (!showFilters) return [];
      const viewSort = deferredBrowseViewInputs.sort;
      return Array.from(
        new Set([
          ...deferredBrowseViewInputs.contentFiles
            .filter((file) => !file.isDirectory)
            .map(modifiedYear),
          ...(deferredBrowseViewInputs.filters.includedType === "audio"
            ? audioYearOptions
            : []),
        ]),
      ).sort((first, second) => {
        if (first === "Unknown year") return 1;
        if (second === "Unknown year") return -1;
        const direction = viewSort.field === "modified" && viewSort.ascending ? 1 : -1;
        return (Number(first) - Number(second)) * direction;
      });
    },
    [
      audioYearOptions,
      deferredBrowseViewInputs,
      showFilters,
    ],
  );

  const viewerImages = useMemo(
    () =>
      viewerOpen
        ? (viewerScopeFiles ?? filteredAndSortedFiles).filter(
            (file) => file.type === "image" || file.type === "video",
          )
        : [],
    [filteredAndSortedFiles, viewerOpen, viewerScopeFiles],
  );

  useEffect(() => {
    if (!viewerOpen || !electronAPI || !selectedFile) return;
    const currentIndex = viewerImages.findIndex(
      (file) => file.path === selectedFile.path,
    );
    if (currentIndex < 0) return;

    const adjacentImages = [
      viewerImages[currentIndex - 1],
      viewerImages[currentIndex + 1],
    ].filter((file): file is FileInfo => file?.type === "image");
    if (adjacentImages.length === 0) return;

    const timer = window.setTimeout(() => {
      void Promise.all(adjacentImages.map((file) => prepareViewerImage(file)));
    }, 120);

    return () => window.clearTimeout(timer);
  }, [prepareViewerImage, selectedFile?.path, viewerImages, viewerOpen]);

  const selectAllFiles = useCallback(() => {
    const selectableFiles = filteredAndSortedFiles.filter(
      (file) => !file.isDirectory,
    );
    setSelectedFilePaths(new Set(selectableFiles.map((file) => file.path)));
  }, [filteredAndSortedFiles]);

  const clearAllFiles = useCallback(() => {
    setSelectedFilePaths(new Set());
  }, []);

  const updateSelectedSearchFeedback = useCallback(
    async (disposition: "confirmed" | "removed") => {
      if (
        !searchFeedbackApiReady ||
        !electronAPI ||
        searchFeedbackBusy ||
        selectedFilePaths.size === 0
      )
        return;
      const visibleSearchPaths = new Set(
        filteredAndSortedFiles
          .filter((file) => !file.isDirectory)
          .map((file) => file.path),
      );
      const filePaths = Array.from(selectedFilePaths).filter((filePath) =>
        visibleSearchPaths.has(filePath),
      );
      if (filePaths.length === 0) return;

      setSearchFeedbackBusy(true);
      setSearchError("");
      try {
        const state = await electronAPI.updateSearchFeedback(
          filePaths,
          disposition,
        );
        applyPersistedState(state);
        const updatedPaths = new Set(filePaths);
        setSelectedFilePaths((current) =>
          new Set(Array.from(current).filter((filePath) => !updatedPaths.has(filePath))),
        );
      } catch (cause) {
        setSearchError(
          cause instanceof Error
            ? cause.message
            : "Could not save search feedback.",
        );
      } finally {
        setSearchFeedbackBusy(false);
      }
    },
    [
      applyPersistedState,
      electronAPI,
      filteredAndSortedFiles,
      searchFeedbackApiReady,
      searchFeedbackBusy,
      selectedFilePaths,
    ],
  );

  const navigateViewer = useCallback(
    async (offset: number) => {
      if (!selectedFile) return;
      const currentIndex = viewerImages.findIndex(
        (file) => file.path === selectedFile.path,
      );
      const nextFile = viewerImages[currentIndex + offset];
      if (nextFile) await openMediaViewer(nextFile, viewerImages);
    },
    [openMediaViewer, selectedFile, viewerImages],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Select All - Cmd+A (Mac) or Ctrl+A (Windows/Linux)
      if ((event.metaKey || event.ctrlKey) && event.key === "a") {
        event.preventDefault();
        if (appSection === "files" && (currentPath || activeDigitalFolderId)) {
          selectAllFiles();
        }
        return;
      }

      if (viewerOpen) {
        if (event.key === "Escape") setViewerOpen(false);
        if (event.key === "ArrowLeft") void navigateViewer(-1);
        if (event.key === "ArrowRight") void navigateViewer(1);
        if (event.key === "+" || event.key === "=") {
          setViewerFit(false);
          setViewerZoom((zoom) => Math.min(zoom + 0.25, 4));
        }
        if (event.key === "-") {
          setViewerFit(false);
          setViewerZoom((zoom) => Math.max(zoom - 0.25, 0.05));
        }
        return;
      }
      if (!selectedFile || !["ArrowLeft", "ArrowRight"].includes(event.key))
        return;
      const navigableFiles = filteredAndSortedFiles.filter(
        (file) => !file.isDirectory,
      );
      const currentIndex = navigableFiles.findIndex(
        (file) => file.path === selectedFile.path,
      );
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const nextFile = navigableFiles[currentIndex + offset];
      if (nextFile) {
        event.preventDefault();
        void selectFile(nextFile);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    appSection,
    activeDigitalFolderId,
    currentPath,
    filteredAndSortedFiles,
    navigateViewer,
    selectAllFiles,
    selectFile,
    selectedFile,
    viewerOpen,
  ]);

  useEffect(() => {
    setDisplayLimit(500);
    setYearDisplayLimits({});
  }, [
    activeDigitalFolderId,
    currentPath,
    filters,
    searchQuery,
    sort,
    yearFilter,
  ]);

  const breadcrumbItems = useMemo(() => {
    if (!currentPath) return [];
    if (currentPath === allSourcesPath)
      return [{ label: "All Sources", path: allSourcesPath }];
    const source = sources.find(
      (candidate) =>
        currentPath === candidate.rootPath ||
        currentPath.startsWith(`${candidate.rootPath}/`),
    );
    if (!source) return [{ label: "All Sources", path: allSourcesPath }];
    const relativePath = currentPath.slice(source.rootPath.length);
    const segments = relativePath.split("/").filter(Boolean);
    return [
      { label: "All Sources", path: allSourcesPath },
      { label: source.label, path: source.rootPath },
      ...segments.map((label, index) => ({
        label,
        path: `${source.rootPath}/${segments.slice(0, index + 1).join("/")}`,
      })),
    ];
  }, [allSourcesPath, currentPath, sources]);

  const yearSections = useMemo(() => {
    const allFolders: FileInfo[] = [];
    const byYear = new Map<string, FileInfo[]>();
    const sectionOrder = new Map<string, { year: string; priority: number }>();
    const viewSort = deferredBrowseViewInputs.sort;
    const indicatorSort = viewSort.field === "people" || viewSort.field === "mapped";
    for (const file of filteredAndSortedFiles) {
      if (file.isDirectory) {
        allFolders.push(file);
        continue;
      }
      const year = modifiedYear(file);
      const metadata = sortIndicatorsRef.current[file.path];
      const metadataKnown = Boolean(metadata);
      const matches =
        viewSort.field === "people"
          ? Boolean(metadata?.people)
          : Boolean(metadata?.mapped);
      const label =
        viewSort.field === "people"
          ? matches
            ? "Has person"
            : "No person"
          : matches
            ? "Mapped"
            : "Unmapped";
      const key = indicatorSort
        ? `${year} · ${metadataKnown ? label : "Checking metadata"}`
        : year;
      const section = byYear.get(key) ?? [];
      section.push(file);
      byYear.set(key, section);
      sectionOrder.set(key, {
        year,
        priority:
          indicatorSort && !metadataKnown
            ? 2
            : indicatorSort && matches !== viewSort.ascending
              ? 1
              : 0,
      });
    }
    const folders = allFolders.slice(0, displayLimit);
    const years = Array.from(byYear.keys()).sort((first, second) => {
      const firstSection = sectionOrder.get(first)!;
      const secondSection = sectionOrder.get(second)!;
      if (firstSection.priority !== secondSection.priority)
        return firstSection.priority - secondSection.priority;
      if (firstSection.year === secondSection.year) return 0;
      if (firstSection.year === "Unknown year") return 1;
      if (secondSection.year === "Unknown year") return -1;
      const direction =
        viewSort.field === "modified" && viewSort.ascending ? 1 : -1;
      return (
        (Number(firstSection.year) - Number(secondSection.year)) * direction
      );
    });
    return { allFolders, folders, years, byYear };
  }, [displayLimit, filteredAndSortedFiles, deferredBrowseViewInputs]);
  useEffect(() => {
    const context = JSON.stringify([
      currentPath,
      activeDigitalFolderId,
      searchQuery.trim(),
      filters.includedType,
      yearFilter,
      sort.field,
      sort.ascending,
    ]);
    const nextYears = new Set(yearSections.years);
    if (yearExpansionContextRef.current !== context) {
      yearExpansionContextRef.current = context;
      knownYearsRef.current = nextYears;
      setExpandedYears(nextYears);
      return;
    }
    const addedYears = Array.from(nextYears).filter(
      (year) => !knownYearsRef.current.has(year),
    );
    if (addedYears.length > 0) {
      addedYears.forEach((year) => knownYearsRef.current.add(year));
      setExpandedYears((current) => new Set([...current, ...addedYears]));
    }
  }, [
    activeDigitalFolderId,
    currentPath,
    filters.includedType,
    searchQuery,
    sort.ascending,
    sort.field,
    yearFilter,
    yearSections.years,
  ]);
  // The initial DOM budget is shared by all years, not 500 per year.
  const yearPageSize = Math.max(
    1,
    Math.floor(500 / Math.max(1, yearSections.years.length)),
  );
  const displayItems = useMemo(
    () => {
      // Search results arrive in stable first-seen order. Keep them in one
      // continuous list so newly found files append at the end instead of
      // changing each year's share of the grid and shifting loaded thumbnails.
      if (searchQuery.trim())
        return filteredAndSortedFiles
          .slice(0, displayLimit)
          .map((file) => ({ kind: "file" as const, file }));
      return [
        ...yearSections.folders.map((file) => ({ kind: "file" as const, file })),
        ...yearSections.years.flatMap((year) => [
          {
            kind: "year" as const,
            year,
            count: yearSections.byYear.get(year)?.length ?? 0,
          },
          ...(expandedYears.has(year)
            ? (yearSections.byYear.get(year) ?? [])
                .slice(0, yearDisplayLimits[year] ?? yearPageSize)
                .map((file) => ({ kind: "file" as const, file }))
            : []),
          ...(expandedYears.has(year) &&
          (yearSections.byYear.get(year)?.length ?? 0) >
            (yearDisplayLimits[year] ?? yearPageSize)
            ? [
                {
                  kind: "more" as const,
                  year,
                  count:
                    yearSections.byYear.get(year)!.length -
                    (yearDisplayLimits[year] ?? yearPageSize),
                },
              ]
            : []),
        ]),
      ];
    },
    [
      displayLimit,
      expandedYears,
      filteredAndSortedFiles,
      searchQuery,
      yearDisplayLimits,
      yearSections,
      yearPageSize,
    ],
  );
  const displayedFiles = useMemo(
    () =>
      displayItems.flatMap((item) => (item.kind === "file" ? [item.file] : [])),
    [displayItems],
  );
  useEffect(() => {
    if (appSection !== "files" || preserveSelectionRequestRef.current !== null)
      return;
    setSelectedFilePaths((current) => {
      if (current.size === 0) return current;
      const availablePaths = new Set(
        filteredAndSortedFiles
          .filter((file) => !file.isDirectory)
          .map((file) => file.path),
      );
      const next = new Set(
        Array.from(current).filter((filePath) => availablePaths.has(filePath)),
      );
      return next.size === current.size ? current : next;
    });
  }, [appSection, displayedFiles, filteredAndSortedFiles]);
  const viewerPlaybackFile = viewerMediaFile ?? selectedFile;
  const viewerIsLivePhoto = Boolean(
    selectedFile?.type === "image" && viewerMediaFile?.type === "video",
  );
  const sortValue = `${sort.field}-${sort.ascending ? "asc" : "desc"}`;
  const audioSort: AudioSort = {
    field:
      sort.field === "magic" ||
      sort.field === "people" ||
      sort.field === "mapped"
        ? "name"
        : sort.field,
    ascending:
      sort.field === "magic" ||
      sort.field === "people" ||
      sort.field === "mapped"
        ? true
        : sort.ascending,
  };
  const intensiveJobs = [
    ["scanning", "loading-model", "indexing"].includes(indexProgress.status)
      ? "search indexing"
      : "",
    ["loading-model", "indexing"].includes(faceProgress.status)
      ? "face indexing"
      : "",
    ["scanning", "generating"].includes(thumbnailPregen?.status ?? "")
      ? "thumbnail generation"
      : "",
    duplicateState.status === "scanning" ? "duplicate scanning" : "",
    waitingForSortIndicators ? "photo metadata lookup" : "",
    magicState.running ? "photo quality analysis" : "",
  ].filter(Boolean);
  const startupBlocked = !(startupState.ready && hydrated);
  const startupProgressPercent = startupState.ready
    ? 96
    : Math.min(
        90,
        Math.max(
          4,
          Math.round(
            (startupState.step / Math.max(startupState.total, 1)) * 90,
          ),
        ),
      );
  const startupReadout = [
    !startupState.ready ? startupState.label : "Opening your saved library…",
    !hydrated ? "Restoring the initial library view…" : "",
    ["scanning", "loading-model", "indexing"].includes(indexProgress.status)
      ? indexProgress.message
      : "",
    searchIndexReadiness.status === "preparing"
      ? searchIndexReadiness.message
      : "",
  ].filter((message, index, messages) => Boolean(message) && messages.indexOf(message) === index);

  useEffect(() => {
    const appRoot = appRootRef.current;
    if (!appRoot) return;
    if (startupBlocked) appRoot.setAttribute("inert", "");
    else appRoot.removeAttribute("inert");
    return () => appRoot.removeAttribute("inert");
  }, [startupBlocked]);

  useEffect(() => {
    if (intensiveJobs.length === 0) setPerformanceNoticeHidden(false);
  }, [intensiveJobs.length]);

  useEffect(() => {
    if (!hasIndexStorageProblem) setIndexStorageNoticeCollapsed(false);
  }, [hasIndexStorageProblem]);

  const checkIndexStorageConnection = async () => {
    if (!electronAPI?.refreshIndexStorageStatus || checkingIndexStorage) return;
    setCheckingIndexStorage(true);
    try {
      setIndexStorageStatus(await electronAPI.refreshIndexStorageStatus());
    } catch {
      // The periodic storage monitor will publish its next status update.
    } finally {
      setCheckingIndexStorage(false);
    }
  };

  const openCacheDestinationSettings = () => {
    setSettingsTourTarget('[data-tour="settings-cache-destination"]');
    setShowSettings(true);
  };

  const dismissPerformanceNotice = (permanently: boolean) => {
    setPerformanceNoticeHidden(true);
    if (!permanently) return;
    setHidePerformanceNoticePermanently(true);
    try {
      localStorage.setItem("silo.hidePerformanceNotice", "true");
    } catch {
      // The dismissal still applies for this session when storage is unavailable.
    }
  };
  const selectTopMagic = (count: number) => {
    const pool =
      appSection === "people" && personDetail
        ? uniquePersonPhotos
        : filteredAndSortedFiles.filter((file) => !file.isDirectory);
    const best = pool
      .filter((file) => magicState.scores[file.path] !== undefined)
      .sort(
        (first, second) =>
          (magicState.ranks.get(first.path) ?? 0) -
          (magicState.ranks.get(second.path) ?? 0),
      )
      .slice(0, count)
      .map((file) => file.path);
    setSelectedFilePaths(new Set(best));
  };
  const magicTools = (compact: boolean) =>
    sort.field === "magic" ? (
      <MagicTools
        state={magicState}
        preset={magicPrefs.preset}
        onPresetChange={magicPrefs.setPreset}
        topCount={magicPrefs.topCount}
        onTopCountChange={magicPrefs.setTopCount}
        onSelectTop={selectTopMagic}
        compact={compact}
      />
    ) : null;
  const magicBadge = (filePath: string) => {
    const score =
      sort.field === "magic" ? magicState.scores[filePath] : undefined;
    return score === undefined ? null : (
      <span
        className="magic-score"
        title="Magic score: local analysis of composition, light, color, sharpness, and subject"
      >
        ✦ {Math.round(score)}
      </span>
    );
  };
  const selectedViewerIndex = selectedFile
    ? viewerImages.findIndex((file) => file.path === selectedFile.path)
    : -1;

  const changeSort = (value: string) => {
    setFreezeSearchResultOrder(false);
    const [field, direction] = value.split("-") as [
      SortState["field"],
      "asc" | "desc",
    ];
    setSort({ field, ascending: direction === "asc" });
  };

  const handleHeaderSort = (field: SortState["field"]) => {
    setFreezeSearchResultOrder(false);
    // If clicking the same field, toggle ascending/descending
    // Otherwise, start with ascending order
    if (sort.field === field) {
      setSort({ field, ascending: !sort.ascending });
    } else {
      setSort({ field, ascending: true });
    }
  };

  const renderSortIndicator = (field: SortState["field"]) => {
    if (sort.field !== field) return null;
    return sort.ascending ? (
      <FiArrowUp size={14} className="sort-indicator" />
    ) : (
      <FiChevronRight
        size={14}
        className="sort-indicator"
        style={{ transform: "rotate(-90deg)" }}
      />
    );
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${Math.round((bytes / Math.pow(1024, unitIndex)) * 100) / 100} ${units[unitIndex]}`;
  };

  const formatDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleString();

  const activeSectionTitle = {
    files: "Files",
    people: "People",
    map: "Map",
    duplicates: "Duplicates",
    pets: "Pets",
    mobile: "Mobile",
    memories: "Memories",
    stats: "Library Statistics",
  }[appSection];
  const activeSectionDetail =
    appSection === "files"
      ? currentPath && currentPath !== allSourcesPath
        ? currentPath.split(/[\\/]/).filter(Boolean).slice(-2).join(" / ")
        : "Your library"
      : ({
          memories: "Your moments, ready to explore",
          people: "People in your photo library",
          map: "Photos, organized by place",
          duplicates: "Review matching files safely",
          mobile: "Devices, backups, and messages",
          pets: "Pets in your photo library",
          stats: "A detailed view of your library",
      } as Record<string, string>)[appSection] ?? "Silo Explorer";
  const isBrowsingFilesLocation = Boolean(
    activeDigitalFolderId ||
      (currentPath && currentPath !== allSourcesPath),
  );

  if (!electronAPI) {
    return (
      <div className="empty-state standalone-error">
        <h2>Open the desktop application</h2>
        <p>
          File access is available in the Electron window, not a web browser
          tab.
        </p>
      </div>
    );
  }

  return (
    <div
      className="app"
      ref={appRootRef}
      aria-busy={startupBlocked}
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (
          target.closest(
            '[data-file-type="image"], .viewer-image-wrap, .preview-image-button, [role="dialog"], [role="alertdialog"], .library-sidebar',
          )
        )
          return;
        // A capture-phase rerender can commit controlled inputs before their
        // bubble-phase onChange runs. Do not rerender for empty file selections.
        setSelectedFilePaths((current) => (current.size ? new Set() : current));
      }}
    >
      <FirstRunMapServiceConsent onConsentChange={saveMapServiceConsent} />
      {showConstructionBanner && (
        <div className="preview-construction-banner" role="note">
          <div>
            <strong>Silo is under construction!</strong>
            <span>
              Downloads are welcome: these are early pre-release builds for testing.
              Some features may be unavailable or unfinished. This is not the full
              demo mode; we’ll announce when the official demo is live. Thanks for
              trying Silo. If something isn’t working, please report it.
            </span>
          </div>
          <div className="preview-construction-banner-actions">
            <label className="preview-construction-dismiss-choice">
              <input
                type="checkbox"
                checked={constructionDontShowAgain}
                onChange={(event) => setConstructionDontShowAgain(event.target.checked)}
              />
              Don’t show again
            </label>
            <button
              className="preview-construction-dismiss"
              type="button"
              aria-label="Dismiss under construction notice"
              title="Dismiss notice"
              onClick={() => dismissConstructionBanner(constructionDontShowAgain)}
            >
              <FiX aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setShowBugReport(true)}>
              Report a Bug
            </button>
          </div>
        </div>
      )}
      {(showIndexStorageBanner ||
        intensiveJobs.length > 0 ||
        searchError) && (
        <div className="app-notice-stack" aria-live="polite">
          {showIndexStorageBanner && hasIndexStorageProblem && indexStorageNoticeCollapsed ? (
            <button
              className="index-storage-collapsed"
              type="button"
              aria-label="Show cache destination warning"
              title="Cache destination needs attention"
              onClick={() => setIndexStorageNoticeCollapsed(false)}
            >
              !
            </button>
          ) : showIndexStorageBanner && (
            <div className="index-storage-banner" role="status">
              <div className="index-storage-banner-content">
                {indexStorageStatus.missingRoots.length > 0 ? (
                  <strong>Silo needs you to reconnect or locate a cache destination.</strong>
                ) : indexStorageStatus.message && (
                  <strong>{indexStorageStatus.message}</strong>
                )}
              </div>
              {hasIndexStorageProblem && (
                <div className="index-storage-banner-actions">
                  <button
                    className="settings-secondary"
                    type="button"
                    disabled={!electronAPI || checkingIndexStorage}
                    onClick={() => void checkIndexStorageConnection()}
                    title="After reconnecting the drive, check its cache destinations again"
                  >
                    <FiRefreshCw aria-hidden="true" />
                    {checkingIndexStorage ? "Checking…" : "Reconnect"}
                  </button>
                  <button
                    className="settings-secondary"
                    type="button"
                    onClick={openCacheDestinationSettings}
                    title="Open cache destination settings to locate existing cache folders"
                  >
                    <FiFolder aria-hidden="true" /> Locate…
                  </button>
                  <button
                    className="index-storage-dismiss"
                    type="button"
                    aria-label="Minimize cache destination warning"
                    title="Minimize warning; it will stay available as !"
                    onClick={() => setIndexStorageNoticeCollapsed(true)}
                  >
                    <FiX aria-hidden="true" />
                  </button>
                </div>
              )}
              <div className="index-storage-banner-content">
                {indexStorageStatus.missingRoots.length > 0 && (
                  <span>{indexStorageStatus.missingRoots.join(" · ")}</span>
                )}
                {showIndexStorageFallbackDetails && (
                  <span>
                    {indexStorageStatus.localFallbackEnabled
                      ? `Local cache fallback is enabled with a ${Math.round(indexStorageStatus.reserveBytes / 1024 / 1024 / 1024)} GB free-space reserve. Silo will verify and move the cache back when the destination reconnects.`
                      : "Local cache fallback is off. Indexing is paused until the selected destination reconnects."}
                  </span>
                )}
                {indexStorageStatus.transfer && (
                  <span>{indexStorageStatus.transfer.message}</span>
                )}
              </div>
            </div>
          )}
          {intensiveJobs.length > 0 && !performanceNoticeHidden && !hidePerformanceNoticePermanently && (
            <div className="indexing-performance-banner" role="status">
              <FiZap aria-hidden="true" />
              <span>
                <strong>Background processing may reduce responsiveness.</strong>{" "}
                Active: {intensiveJobs.join(", ")}. You can keep browsing; previews
                load progressively.
              </span>
              <label className="indexing-performance-dismiss-choice">
                <input
                  type="checkbox"
                  checked={performanceDontShowAgain}
                  onChange={(event) => setPerformanceDontShowAgain(event.target.checked)}
                />
                Don’t show again
              </label>
              <button
                className="indexing-performance-dismiss"
                type="button"
                aria-label="Dismiss background processing notice"
                title={performanceDontShowAgain ? "Dismiss and don’t show again" : "Dismiss until background processing is idle"}
                onClick={() => dismissPerformanceNotice(performanceDontShowAgain)}
              >
                <FiX aria-hidden="true" />
              </button>
            </div>
          )}
          {searchError && (
            <div className="search-policy-error" role="alert">
              {searchError}
            </div>
          )}
        </div>
      )}
      <div className="app-workspace-row">
        <aside
          className={`primary-nav-rail${primaryNavCollapsed ? " is-collapsed" : ""}`}
          aria-label="Silo navigation"
        >
          <div className="primary-nav-brand" aria-label="Silo home">
            <span>silo</span>
            <i aria-hidden="true" />
            <button
              className="primary-nav-collapse-toggle"
              type="button"
              aria-label={primaryNavCollapsed ? "Expand section navigation" : "Collapse section navigation"}
              aria-expanded={!primaryNavCollapsed}
              title={primaryNavCollapsed ? "Expand section navigation" : "Collapse section navigation"}
              onClick={togglePrimaryNavCollapsed}
            >
              {primaryNavCollapsed ? <FiChevronRight aria-hidden="true" /> : <FiChevronLeft aria-hidden="true" />}
            </button>
          </div>
          {/* Keep legacy tour selectors stable during the shell redesign. Rebuild the guided tour after the workflows settle: navigation → source choice → indexing → Files browse/search/folders → Memories → People → Map → Duplicates → Mobile workflows → Settings. */}
          <nav className="primary-nav-main" aria-label="Main sections" data-tour="app-tabs">
            <button
              type="button"
              className={appSection === "memories" ? "active" : ""}
              aria-current={appSection === "memories" ? "page" : undefined}
              onClick={() => setAppSection("memories")}
              data-tour="memories-tab"
              title="Memories"
              aria-label="Memories"
              data-help="Browse story suggestions, then create or export a memory when you choose."
            >
              <FiPlay aria-hidden="true" />
              <span>Memories</span>
            </button>
            <button
              type="button"
              className={appSection === "files" ? "active" : ""}
              aria-current={appSection === "files" ? "page" : undefined}
              onClick={() => setAppSection("files")}
              data-tour="files-tab"
              title="Files"
              aria-label="Files"
              data-help="Browse and organize local folders, connected accounts, and saved device sources."
            >
              <FiGrid aria-hidden="true" />
              <span>Files</span>
            </button>
            <button
              type="button"
              className={appSection === "people" ? "active" : ""}
              aria-current={appSection === "people" ? "page" : undefined}
              onClick={() => setAppSection("people")}
              title="People"
              aria-label="People"
              data-help="Review offline face groups, name people, and correct or merge assignments."
            >
              <FiUsers aria-hidden="true" />
              <span>People</span>
            </button>
            <button
              type="button"
              className={appSection === "map" ? "active" : ""}
              aria-current={appSection === "map" ? "page" : undefined}
              onClick={() => setAppSection("map")}
              title="Map"
              aria-label="Map"
              data-help="Explore geotagged photos by place and update selected photo locations."
            >
              <FiMap aria-hidden="true" />
              <span>Map</span>
            </button>
            <button
              type="button"
              className={appSection === "duplicates" ? "active" : ""}
              aria-current={appSection === "duplicates" ? "page" : undefined}
              onClick={() => setAppSection("duplicates")}
              title="Duplicates"
              aria-label="Duplicates"
              data-help="Compare exact duplicates, review recoverable removals, and confirm before permanent deletion."
            >
              <FiCopy aria-hidden="true" />
              <span>Duplicates</span>
            </button>
            <button
              type="button"
              className={appSection === "mobile" ? "active" : ""}
              aria-current={appSection === "mobile" ? "page" : undefined}
              onClick={() => setAppSection("mobile")}
              title="Mobile"
              aria-label="Mobile"
              data-help="Connect phones and tablets, browse saved copies, and review or export message histories."
            >
              <FiSmartphone aria-hidden="true" />
              <span>Mobile</span>
            </button>
            <button
              type="button"
              className={appSection === "stats" ? "active" : ""}
              aria-current={appSection === "stats" ? "page" : undefined}
              onClick={() => setAppSection("stats")}
              title="Stats"
              aria-label="Stats"
              data-tour="library-statistics"
              data-help="Review library inventory, source coverage, indexing, and backup health."
            >
              <FiBarChart2 aria-hidden="true" />
              <span>Stats</span>
            </button>
          </nav>
          <nav className="primary-nav-utilities" aria-label="Support and settings">
            <button
              type="button"
              className={showSettings ? "active" : ""}
              onClick={() => setShowSettings(true)}
              title="Settings"
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={showSettings}
              data-tour="settings-button"
              data-help="Open appearance, content protection, memory storage, configuration backup, and bug reporting."
            >
              <FiSettings aria-hidden="true" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              onClick={() => setShowLocalHelp(true)}
              title="Local help and replay the guided tour"
              aria-label="Open Silo Help"
              data-tour="help-button"
              data-help="Search local help or replay the guided tour."
            >
              <FiHelpCircle aria-hidden="true" />
              <span>Help</span>
            </button>
          </nav>
        </aside>
        <div className="app-main-column">
      <header className={`header${headerToolsCollapsed ? " header-tools-collapsed" : ""}`}>
        <div className="header-primary">
          <div className="header-left">
            <div className="header-section-context">
              <span className="header-section-kicker">SILO EXPLORER</span>
              <h1>{activeSectionTitle}</h1>
              <span
                className="header-section-detail"
                title={appSection === "files" ? currentPath || "Your library" : activeSectionDetail}
              >
                {activeSectionDetail}
              </span>
            </div>
          </div>
          {appSection === "files" ? (
            <div className="header-search-group">
              <div
                className={`semantic-search ${
                  searchIndexReadiness.status === "preparing"
                    ? "is-preparing"
                    : searchIndexReadiness.status === "ready"
                      ? "is-ready"
                      : ""
                }`}
                style={
                  {
                    "--search-index-progress": `${
                      searchIndexReadiness.status === "ready"
                        ? 100
                        : searchIndexReadiness.status === "preparing"
                          ? Math.max(
                              0,
                              Math.min(100, searchIndexReadiness.percentage),
                            )
                          : 0
                    }%`,
                  } as React.CSSProperties
                }
                data-tour="semantic-search"
              >
                <FiSearch />
                <input
                  value={searchQuery}
                  onChange={(event) => {
                    const value = event.target.value;
                    searchQueryStartedAtRef.current = {
                      query: value.trim(),
                      startedAt: performance.now(),
                    };
                    setSearchQuery(value);
                  }}
                  onFocus={() => {
                    setSearchFocused(true);
                    setHistoryLevel(0);
                  }}
                  onBlur={() => setSearchFocused(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      rememberSearch(searchQuery);
                      searchQueryStartedAtRef.current = {
                        query: searchQuery.trim(),
                        startedAt: performance.now(),
                      };
                      if (searchDebounceTimerRef.current !== null) {
                        window.clearTimeout(searchDebounceTimerRef.current);
                        searchDebounceTimerRef.current = null;
                      }
                      void runSemanticSearch(true);
                    }
                    if (event.key === "Escape")
                      (event.target as HTMLInputElement).blur();
                  }}
                  placeholder={
                    searchIndexReadiness.status === "ready"
                      ? "Search"
                      : searchIndexReadiness.status === "preparing"
                        ? "Search"
                        : "Search"
                  }
                  title={
                    searchIndexReadiness.status === "preparing"
                      ? SEARCH_INDEX_PREPARING_HINT
                      : undefined
                  }
                  aria-describedby={
                    searchIndexReadiness.status === "preparing"
                      ? "search-index-preparing-help"
                      : undefined
                  }
                  aria-label="Semantic search"
                  data-help="Describe what you remember in ordinary language to find matching indexed photos and documents locally."
                />
                {searchIndexReadiness.status === "preparing" && (
                  <span
                    id="search-index-preparing-help"
                    className="search-readiness-description"
                  >
                    {SEARCH_INDEX_PREPARING_HINT}
                  </span>
                )}
                <span className="semantic-search-status" role="status" aria-live="polite">
                  {searchIndexReadiness.status === "preparing" ? (
                    <span
                      className="search-index-meter"
                      role="progressbar"
                      aria-label="Search readiness preparation"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.max(
                        0,
                        Math.min(100, searchIndexReadiness.percentage),
                      )}
                      title={searchIndexReadiness.message}
                    >
                      <span>Preparing {searchIndexReadiness.percentage}%</span>
                    </span>
                  ) : searchIndexReadiness.status === "ready" ? (
                    searchQuery.trim() && searchTiming ? (
                      <SearchTiming
                        startedAt={searchTiming.startedAt}
                        firstResultAt={searchTiming.firstResultAt}
                        completedAt={searchTiming.completedAt}
                      />
                    ) : searchQuery.trim() && searching ? (
                      "Searching…"
                    ) : (
                      ""
                    )
                  ) : (
                    ""
                  )}
                </span>
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} title="Clear search" aria-label="Clear search"
                    data-help="Remove the current semantic-search query and return to the unfiltered view.">
                    <FiX />
                  </button>
                )}
                {searchFocused &&
                  (() => {
                    const query = searchQuery.trim().toLowerCase();
                    const matches = searchHistory.filter(
                      (item) =>
                        !query ||
                        (item.toLowerCase().includes(query) &&
                          item.toLowerCase() !== query),
                    );
                    if (matches.length === 0) return null;
                    const limit =
                      historyLevel === 0
                        ? 3
                        : historyLevel === 1
                          ? 10
                          : matches.length;
                    return (
                      // preventDefault keeps focus in the input while choosing an entry.
                      <div
                        className={`search-history ${historyLevel === 2 ? "expanded" : ""}`}
                        onMouseDown={(event) => event.preventDefault()}
                      >
                        <span className="search-history-label">
                          Recent searches
                        </span>
                        <div className="search-history-list">
                          {matches.slice(0, limit).map((item) => (
                            <div className="search-history-item" key={item}>
                              <button
                                onClick={() => {
                                  setSearchQuery(item);
                                  rememberSearch(item);
                                  setSearchFocused(false);
                                }}
                              >
                                <span>{item}</span>
                              </button>
                              <button
                                className="search-history-remove"
                                onClick={() => forgetSearch(item)}
                                title="Remove from history"
                              >
                                <FiX />
                              </button>
                            </div>
                          ))}
                        </div>
                        {matches.length > limit && (
                          <button
                            className="search-history-more"
                            onClick={() =>
                              setHistoryLevel((level) => (level === 0 ? 1 : 2))
                            }
                            title={
                              historyLevel === 0
                                ? "Show 10 recent searches"
                                : "Show all recent searches"
                            }
                          >
                            …
                          </button>
                        )}
                      </div>
                    );
                  })()}
              </div>
            </div>
          ) : appSection === "people" ? (
            <div className="face-header-progress">
              <span>
                {faceProgress.processed.toLocaleString()} photos scanned
              </span>
              <strong>
                {faceProgress.faces.toLocaleString()} faces ·{" "}
                {faceProgress.people.toLocaleString()} people
              </strong>
            </div>
          ) : (
            <div className="header-primary-spacer" />
          )}
          {appSection === "files" && (
            <button
              className="header-tools-toggle"
              type="button"
              aria-expanded={!headerToolsCollapsed}
              onClick={() => {
                if (!headerToolsCollapsed) setShowFilters(false);
                setHeaderToolsCollapsed(!headerToolsCollapsed);
              }}
              title={headerToolsCollapsed ? "Show search and toolbar controls" : "Collapse search and toolbar controls"}
            >
              <FiChevronDown aria-hidden="true" />
              {headerToolsCollapsed ? "Show tools" : "Hide tools"}
            </button>
          )}
        </div>
        <div className="header-tools-row">
          <div className="header-directory" data-help="Use Back, Forward, and Parent to navigate folder history; Refresh reloads the current source view. These controls do not alter the underlying files.">
            {appSection === "files" && (
              <>
                <button className="btn btn-primary"
                  title={isBrowsingFilesLocation ? "Browse another folder in this session" : "Add a folder to your library"}
                  data-help={isBrowsingFilesLocation
                    ? "Open another folder for this session. To keep it in your library and index it, add it as a source."
                    : "Add a folder as a library source and index it in place. Silo leaves the originals where they are."}
                  onClick={isBrowsingFilesLocation ? selectDirectory : addIndexSource}
                  data-tour="files-primary-source-action">
                  {isBrowsingFilesLocation ? <FiFolder /> : <FiFolderPlus />}
                  {isBrowsingFilesLocation ? "Browse another folder" : "Add a folder"}
                </button>
                {(currentPath || activeDigitalFolderId) && (
                  <div className="header-navigation-buttons">
                    <button
                      className="btn btn-icon"
                      onClick={() => navigateHistory(historyIndex - 1)}
                      disabled={historyIndex <= 0}
                      title="Back"
                      aria-label="Back"
                      data-help="Return to the previous folder or library view in your navigation history."
                    >
                      <FiChevronLeft />
                    </button>
                    <button
                      className="btn btn-icon"
                      onClick={() => navigateHistory(historyIndex + 1)}
                      disabled={historyIndex >= navigationHistory.length - 1}
                      title="Forward"
                      aria-label="Forward"
                      data-help="Move forward to the next folder or library view in your navigation history."
                    >
                      <FiChevronRight />
                    </button>
                    <button
                      className="btn btn-icon"
                      onClick={navigateUp}
                      disabled={currentPath === allSourcesPath}
                      title="Parent folder"
                      aria-label="Parent folder"
                      data-help="Go up one folder level in the current source."
                    >
                      <FiArrowUp />
                    </button>
                    <button
                      className="btn btn-icon"
                      onClick={() =>
                        currentPath
                          ? loadDirectory(currentPath)
                          : activeDigitalFolderId &&
                            navigateToDigitalFolder(activeDigitalFolderId, false)
                      }
                      title="Refresh current source"
                      aria-label="Refresh current folder"
                      data-help="Reload the current directory or digital-folder contents from its source."
                    >
                      <FiRefreshCw />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className={`btn explode-button header-tool-explode ${exploded ? "active" : ""}`}
                  onClick={() => changeExploded(!exploded)}
                  title={
                    audioOnlySelected
                      ? "Flatten audio into a single list"
                      : "Flatten every nested file into one view"
                  }
                  data-help="Temporarily flatten nested folders into one list view; it does not move files."
                >
                  <FiZap /> {exploded ? "Exploded" : "Explode"}
                </button>
              </>
            )}
          </div>
          <div
            className="header-right"
            data-tour={appSection === "files" ? "file-actions" : undefined}
          >
            {appSection === "files" ? (
              <>
                <button
                  className="btn btn-icon header-tool-item"
                  onClick={createFolder}
                  disabled={!canCreateSourceFolder}
                  title={isGoogleCloudContext ? "Google source" : canCreateSourceFolder ? "New folder" : "Choose a local source folder first"}
                  aria-label={isGoogleCloudContext ? "Google source is read only" : "New folder (writes to source)"}
                  data-help={isGoogleCloudContext
                    ? "Google Drive and Google Photos items cannot be changed here. This control only creates folders on local disk paths."
                    : "Create a real folder inside the currently open local source directory."}
                >
                  <FiFolderPlus />
                </button>
                <button
                  className="btn btn-icon header-tool-item"
                  onClick={moveSelectedFile}
                  disabled={!canMoveSelectedSourceFile}
                  title={isGoogleCloudContext ? "Google source" : "Move selected file"}
                  aria-label={isGoogleCloudContext ? "Google Drive item is read only" : "Move selected file (writes to source)"}
                  data-help={isGoogleCloudContext
                    ? "Google Drive and Google Photos items cannot be moved by this Files control."
                    : "Choose a destination to move this local file on disk. Review the destination before confirming."}
                >
                  <FiMove />
                </button>
                <button
                  className="btn btn-icon header-tool-item"
                  onClick={editVirtualName}
                  disabled={metadataTargets.length !== 1}
                  title="Set virtual name"
                  aria-label="Set virtual name (writes Silo metadata only)"
                  data-help="Change Silo's display and search label. The source filename and file contents stay unchanged."
                >
                  <FiEdit3 />
                </button>
                <button
                  className="btn btn-icon header-tool-item"
                  onClick={editKeywords}
                  disabled={metadataTargets.length === 0}
                  title="Edit search keywords"
                  aria-label="Edit search keywords (writes Silo metadata only)"
                  data-help="Save local keywords for search. The source files stay unchanged."
                >
                  <FiTag />
                </button>
                <button
                  className={`btn btn-icon header-tool-view ${viewMode === "list" ? "active" : ""}`}
                  onClick={() => setViewMode("list")}
                  title="List view"
                  aria-label="List view"
                  data-help="Show files as rows with additional columns and details."
                >
                  <FiList />
                </button>
                <button
                  className={`btn btn-icon header-tool-view ${viewMode === "grid" ? "active" : ""}`}
                  onClick={() => setViewMode("grid")}
                  title="Grid view"
                  aria-label="Grid view"
                  data-help="Show files as a visual thumbnail grid."
                >
                  <FiGrid />
                </button>
                <button
                  className={`btn btn-icon header-tool-filter ${showFilters ? "active" : ""}`}
                  onClick={() => setShowFilters(!showFilters)}
                  title="Sort and filter files"
                  aria-label="Sort and filter files"
                  data-help="Choose a sort order and filter by type, year, people, or location. These controls work in both List and Grid views."
                >
                  <FiSliders /> Sort &amp; Filter
                </button>
                {!searchQuery.trim() && (currentPath || activeDigitalFolderId) && (
                  <>
                    <button
                      className="btn btn-icon header-tool-selection"
                      onClick={selectAllFiles}
                      disabled={!hasSelectableFiles}
                      title="Select all files (Cmd+A)"
                      aria-label="Select all files"
                      data-help="Select every currently visible file in this view."
                    >
                      <FiCheck />
                    </button>
                    <button
                      className="btn btn-icon header-tool-selection"
                      onClick={clearAllFiles}
                      disabled={selectedFilePaths.size === 0}
                      title="Clear selection"
                      aria-label="Clear selection"
                      data-help="Clear the current file selection without changing any files."
                    >
                      <FiX />
                    </button>
                  </>
                )}
                {searchQuery.trim() && (
                  <div className="search-result-tools" role="toolbar" aria-label="Search tools">
                    <button
                      className="btn btn-icon header-tool-selection"
                      onClick={selectAllFiles}
                      disabled={!hasSelectableFiles}
                      title="Select all search results"
                      aria-label="Select all search results"
                    >
                      <FiCheck />
                    </button>
                    <label
                      className="search-confidence-tool"
                      title={`Search confidence: ${confidence}%`}
                    >
                      <span aria-hidden="true">{confidence}%</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={confidence}
                        aria-label="Search confidence"
                        aria-valuetext={`${confidence}%`}
                        onChange={(event) =>
                          setConfidence(Number(event.target.value))
                        }
                      />
                    </label>
                    <button
                      className="btn btn-icon header-tool-selection"
                      onClick={() => void updateSelectedSearchFeedback("confirmed")}
                      disabled={!searchFeedbackApiReady || selectedSearchResultCount === 0 || searchFeedbackBusy}
                      title={searchFeedbackApiReady
                        ? "Confirm selected results and prioritize them in future searches"
                        : "Restart Silo to load search feedback tools"}
                      aria-label="Confirm selected search results"
                    >
                      <FiCheckCircle />
                    </button>
                    <button
                      className="btn btn-icon header-tool-selection"
                      onClick={() => void updateSelectedSearchFeedback("removed")}
                      disabled={!searchFeedbackApiReady || selectedSearchResultCount === 0 || searchFeedbackBusy}
                      title={searchFeedbackApiReady
                        ? "Remove selected results from future searches; source files stay unchanged"
                        : "Restart Silo to load search feedback tools"}
                      aria-label="Remove selected search results"
                    >
                      <FiEyeOff />
                    </button>
                  </div>
                )}
              </>
            ) : null}
            </div>
          </div>
        </header>


      {appSection === "files" && scanIssues && (
        <div className="permission-banner">
          <div>
            <strong>
              {scanIssues.isTimeMachine
                ? "macOS is blocking access to this Time Machine backup"
                : "macOS is blocking access to some folders here"}
            </strong>
            <span>
              {scanIssues.denied.toLocaleString()} folder
              {scanIssues.denied === 1 ? "" : "s"} returned “Operation not
              permitted”. Turn on Full Disk Access for{" "}
              <code className="grant-target">
                {accessIdentity?.displayName || "silo"}
              </code>
              , then quit and reopen the app.
            </span>
            {accessIdentity?.isDev && (
              <span className="permission-hint">
                In development, grant access to the Silo app shown by “Reveal App”, then restart Silo.
              </span>
            )}
          </div>
          <div className="permission-banner-actions">
            <button
              className="primary"
              onClick={() => electronAPI?.openFullDiskAccess()}
            >
              Open Settings
            </button>
            <button onClick={() => electronAPI?.revealAppBundle()}>
              Reveal App
            </button>
            <button
              className="dismiss"
              onClick={() => setScanIssues(null)}
              title="Dismiss permission guidance"
              aria-label="Dismiss permission guidance"
            >
              <FiX />
            </button>
          </div>
        </div>
      )}

      {appSection === "files" && selectedFilePaths.size > 0 && (
        <div className="bulk-actions-bar">
          <span>
            {selectedFilePaths.size} file
            {selectedFilePaths.size === 1 ? "" : "s"} selected
            {bulkNotice && (
              <strong className="bulk-notice"> · {bulkNotice}</strong>
            )}
          </span>
          <div className="bulk-actions">
            <button
              onClick={() => editYear()}
              className="bulk-action-btn"
              title="Edit the library year for selected files"
            >
              <FiEdit3 /> Year
            </button>
            <button
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setPersonPicker({
                  x: rect.left,
                  y: rect.top - 440,
                  paths: Array.from(selectedFilePaths).filter((filePath) =>
                    personMediaPaths.has(filePath),
                  ),
                });
              }}
              className="bulk-action-btn"
              disabled={
                !Array.from(selectedFilePaths).some((filePath) =>
                  personMediaPaths.has(filePath),
                )
              }
              title="Add selected media to a People profile"
            >
              <FiUserPlus /> Add to Person
            </button>
            <button
              onClick={() => setShowFolderSelector(true)}
              className="bulk-action-btn add-to-folder"
              title="Add references to a Digital Folder"
            >
              <FiPlus /> Add to Folder
            </button>
            <button
              onClick={() => saveSelectedFileToDevice()}
              className="bulk-action-btn save-to-device"
              title="Save separate copies to this device"
            >
              <FiDownload /> Save to Device
            </button>
            <button
              onClick={() => setShowLocationPicker((current) => !current)}
              className="bulk-action-btn"
              disabled={locationTargetFiles.length === 0}
              title="Assign a location in Silo metadata"
            >
              <FiMap /> Location
            </button>
            <button
              onClick={() => setSelectedFilePaths(new Set())}
              className="bulk-action-btn clear"
              title="Clear the current selection"
            >
              Clear Selection
            </button>
          </div>
        </div>
      )}

      {historyToast && (
        <div className="history-toast" role="status">
          {historyToast}
        </div>
      )}

      {mergePicker && personDetail && (
        <PersonPicker
          photoPaths={[]}
          anchor={mergePicker}
          title={`Merge ${personDetail.name} (${personDetail.photoCount.toLocaleString()} photos) into…`}
          excludeIds={[personDetail.id]}
          onPick={mergePerson}
          onClose={() => setMergePicker(null)}
        />
      )}

      {personPicker && personPicker.paths.length > 0 && (
        <PersonPicker
          photoPaths={personPicker.paths}
          anchor={personPicker}
          onClose={() => setPersonPicker(null)}
          onAdded={(result) => {
            clearFileSelection();
            setPeople(result.people);
            setBulkNotice(
              `Added ${result.count.toLocaleString()} to ${result.personName}`,
            );
            window.setTimeout(() => setBulkNotice(""), 4000);
            if (selectedPersonId === result.personId)
              void openPerson(result.personId);
          }}
        />
      )}

      {appSection === "files" &&
        showLocationPicker &&
        locationTargetFiles.length > 0 && (
          <div className="file-location-picker">
            <LocationPicker
              files={locationTargetFiles}
              onAssigned={applyGeoAssignment}
              onClose={() => setShowLocationPicker(false)}
            />
          </div>
        )}

      {appSection === "files" && currentPath && (
        <div className="path-info">
          <div className="breadcrumbs">
            {breadcrumbItems.map((item, index) => (
              <React.Fragment key={item.path}>
                {index > 0 && <FiChevronRight />}
                <button
                  onClick={() =>
                    item.path === allSourcesPath
                      ? browseAllSources()
                      : navigateToPath(item.path)
                  }
                >
                  {item.label}
                </button>
              </React.Fragment>
            ))}
          </div>
          <span className="file-count">
            {searchQuery.trim()
              ? searchIndexReadiness.status === "preparing"
                ? searchProgress.mode === "ann"
                  ? `${filteredAndSortedFiles.length.toLocaleString()} matches · fast search active, index building ${searchIndexReadiness.percentage}%`
                  : `${filteredAndSortedFiles.length.toLocaleString()} matches · preparing saved search index ${searchIndexReadiness.percentage}%`
                : searching && searchProgress.total === 0
                ? `${filteredAndSortedFiles.length.toLocaleString()} matches · finding first results`
                : searching && searchProgress.mode === "ann"
                  ? `${filteredAndSortedFiles.length.toLocaleString()} matches · ranking semantic candidates`
                  : searching
                    ? `${filteredAndSortedFiles.length.toLocaleString()} matches · searching ${searchProgress.scanned.toLocaleString()} of ${searchProgress.total.toLocaleString()} indexed files`
                    : `${filteredAndSortedFiles.length.toLocaleString()} matches from ${searchProgress.total.toLocaleString()} indexed files`
              : `${filteredAndSortedFiles.length.toLocaleString()} items`}
            {browseViewUpdating ? " · Updating results…" : ""}
            {searchQuery.trim() && fastFileSearchCapped
              ? " · showing first 5,000 text matches"
              : ""}
          </span>
          {(() => {
            const snapshot = sources
              .filter((source) => source.snapshotAt && (currentPath === source.rootPath || currentPath.startsWith(`${source.rootPath}/`)))
              .sort((first, second) => second.rootPath.length - first.rootPath.length)[0];
            return snapshot?.snapshotAt ? <span className="source-snapshot-banner" title={snapshot.message}>
              {snapshot.offlineBackup ? "Saved phone copy" : "Live phone source"} · {new Date(snapshot.snapshotAt).toLocaleString()}
            </span> : null;
          })()}
        </div>
      )}

      {appSection === "files" && showFilters && !headerToolsCollapsed && (
        <div className="filters-panel">
          <div className="filter-section">
            <h3>Show</h3>
            <div className="file-type-filter" ref={typeFilterRef}>
              <button
                className="type-select type-filter-trigger"
                aria-expanded={typeFilterOpen}
                onClick={() => setTypeFilterOpen((open) => !open)}
              >
                <span>
                  {filters.includedType === "all"
                    ? "All files"
                    : selectedTypes(filters.includedType).length === 1
                      ? fileTypeLabels[selectedTypes(filters.includedType)[0]]
                      : `${selectedTypes(filters.includedType).length} types`}
                </span>
                <FiChevronDown />
              </button>
              {typeFilterOpen && (
                <div
                  className="file-type-checklist"
                  role="group"
                  aria-label="File types to show"
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={filters.includedType === "all"}
                      onChange={() =>
                        setFilters({
                          ...filters,
                          includedType:
                            filters.includedType === "all" ? "" : "all",
                        })
                      }
                    />
                    <span>All files</span>
                  </label>
                  {fileTypeOrder.map((type) => (
                    <label key={type}>
                      <input
                        type="checkbox"
                        checked={
                          filters.includedType === "all" ||
                          selectedTypes(filters.includedType).includes(type)
                        }
                        onChange={() => {
                          const current =
                            filters.includedType === "all"
                              ? []
                              : selectedTypes(filters.includedType);
                          const next = current.includes(type)
                            ? current.filter((item) => item !== type)
                            : [...current, type];
                          setFilters({
                            ...filters,
                            includedType:
                              next.length === fileTypeOrder.length
                                ? "all"
                                : next.join(","),
                          });
                        }}
                      />
                      <span>{fileTypeLabels[type]}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="filter-section">
            <h3>Year</h3>
            <div className="year-filter-checklist" aria-label="Filter by year">
              <label>
                <input
                  type="checkbox"
                  checked={yearFilter.length === 0}
                  onChange={() => setYearFilter([])}
                />
                <span>All years</span>
              </label>
              {yearOptions.map((year) => (
                <label key={year}>
                  <input
                    type="checkbox"
                    checked={yearFilter.includes(year)}
                    onChange={() =>
                      setYearFilter((current) =>
                        current.includes(year)
                          ? current.filter((selected) => selected !== year)
                          : [...current, year],
                      )
                    }
                  />
                  <span>{year}</span>
                </label>
              ))}
            </div>
          </div>
          {!audioOnlySelected && <div className="filter-section">
            <h3>People</h3>
            <select
              className="type-select"
              aria-label="People metadata filter"
              value={peopleFilter}
              onChange={(event) =>
                setPeopleFilter(event.target.value as MetadataFilter)
              }
            >
              <option value="all">Both</option>
              <option value="yes">Photos with People</option>
              <option value="no">Photos without People</option>
            </select>
          </div>}
          {!audioOnlySelected && <div className="filter-section">
            <h3>Location</h3>
            <select
              className="type-select"
              aria-label="Location metadata filter"
              value={locationFilter}
              onChange={(event) =>
                setLocationFilter(event.target.value as MetadataFilter)
              }
            >
              <option value="all">Both</option>
              <option value="yes">Mapped</option>
              <option value="no">Unmapped</option>
            </select>
          </div>}
          <div className="filter-section">
            <h3>Sort By</h3>
            <select
              className="type-select"
              value={
                audioOnlySelected
                  ? `${audioSort.field}-${audioSort.ascending ? "asc" : "desc"}`
                  : sortValue
              }
              onChange={(event) => changeSort(event.target.value)}
            >
              {!audioOnlySelected && (
                <option value="magic-desc">✦ Magic · best photos first</option>
              )}
              <option value="modified-desc">Newest first</option>
              <option value="modified-asc">Oldest first</option>
              <option value="size-desc">Largest first</option>
              <option value="size-asc">Smallest first</option>
              <option value="name-asc">Name A-Z</option>
              <option value="name-desc">Name Z-A</option>
              {audioOnlySelected ? (
                <>
                  <option value="type-asc">Format A-Z</option>
                  <option value="type-desc">Format Z-A</option>
                  <option value="source-asc">Source A-Z</option>
                  <option value="source-desc">Source Z-A</option>
                </>
              ) : (
                <>
                  <option value="people-asc">People first</option>
                  <option value="people-desc">No people first</option>
                  <option value="mapped-asc">Mapped first</option>
                  <option value="mapped-desc">Unmapped first</option>
                </>
              )}
            </select>
            {!audioOnlySelected && magicTools(false)}
          </div>
        </div>
      )}

      <div className={`section-workspace section-workspace-${appSection}`}>
      <React.Suspense fallback={null}>
        <MemoriesLauncher api={electronAPI} ready={startupState.ready && hydrated}
          onExplore={() => setAppSection("memories")} />
      </React.Suspense>
      {(visitedSections.has("memories") || appSection === "memories") && (
        <div className="section-view" data-active={appSection === "memories"} aria-hidden={appSection !== "memories"}>
        <React.Suspense fallback={<main className="viewer-status">Loading Memories…</main>}>
          <MemoriesPage api={electronAPI} visible={appSection === "memories"} ready={startupState.ready} thumbnailSize={memoryBookThumbnailSize} onThumbnailSizeChange={setMemoryBookThumbnailSize} onChooseMusicFolder={addIndexSource} />
        </React.Suspense>
        </div>
      )}
      {(visitedSections.has("stats") || appSection === "stats") && (
        <div className="section-view" data-active={appSection === "stats"} aria-hidden={appSection !== "stats"}>
          {electronAPI ? <StatsDashboard api={electronAPI} active={appSection === "stats"} /> : <main className="viewer-status">Stats services are unavailable.</main>}
        </div>
      )}
      {(visitedSections.has("people") || appSection === "people") && (
        <div className="section-view" data-active={appSection === "people"} aria-hidden={appSection !== "people"}>
        <main className="people-page" data-retained-scroll="people" data-tour="people-page" data-help="Review photos and face groups. Naming people, correcting assignments, merging profiles and changing visibility save People records only; source photos are unchanged."
        >
          <section className="face-index-status" data-tour="people-index" data-help="This independent offline index detects and groups faces. It does not move or rename source files.">
            <div>
              <span className="sidebar-kicker">Secondary offline index</span>
              <h2>Face detection & clustering</h2>
              <p>{faceActionNotice?.message ?? faceProgress.message}</p>
              {faceActionError && <p className="indexing-stage-errors" role="alert">{faceActionError}</p>}
            </div>
            <div className="face-progress-numbers">
              <span>
                <strong>{faceProgress.processed.toLocaleString()}</strong>{" "}
                processed
              </span>
              <span>
                <strong>{faceProgress.remaining.toLocaleString()}</strong>{" "}
                remaining
              </span>
              <span>
                <strong>{faceProgress.faces.toLocaleString()}</strong> faces
              </span>
            </div>
            <progress
              value={faceProgress.processed}
              max={Math.max(faceProgress.total, 1)}
            />
            <button
              className="index-action"
              data-tour="face-indexing"
              data-help="Start, pause, or resume the separate face-detection index. It changes People’s index, not source files."
              disabled={faceActionPending !== null}
              onClick={() => void toggleFaceIndexing()}
            >
              {faceActionPending === "pause" ? (
                <FiPause />
              ) : faceActionPending === "resume" ? (
                <FiRefreshCw />
              ) : ["loading-model", "indexing"].includes(faceProgress.status) ? (
                <FiPause />
              ) : (
                <FiPlay />
              )}
              {faceActionPending === "pause"
                ? "Pausing…"
                : faceActionPending === "resume"
                  ? "Queueing…"
                  : faceProgress.status === "paused"
                    ? "Resume face indexing"
                    : faceProgress.status === "complete"
                      ? "Check new photos"
                      : "Start face indexing"}
            </button>
          </section>

          {personDetail ? (
            <section
              className="person-detail"
              style={
                {
                  "--people-photo-thumbnail-size": `${peopleThumbnailSize}px`,
                } as React.CSSProperties
              }
            >
              <div className="person-detail-header">
                <button
                  className="back-to-people"
                  onClick={() => {
                    setSelectedPersonId(null);
                    setPersonDetail(null);
                    setSelectedPersonPhoto(null);
                    setSelectedPhotoFaces([]);
                    clearFileSelection();
                  }}
                >
                  <FiChevronLeft /> All people
                </button>
                <div>
                  <h2>
                    {personDetail.name}
                    {personDetail.status !== "unconfirmed" && (
                      <span
                        className={`person-status-badge ${personDetail.status}`}
                      >
                        {personDetail.status === "banned" ? (
                          <>
                            <FiSlash /> Banned
                          </>
                        ) : (
                          <>
                            <FiUserCheck /> Confirmed
                          </>
                        )}
                      </span>
                    )}
                  </h2>
                  <p>
                    {uniquePersonPhotos.length} unique photos ·{" "}
                    {personDetail.faceCount} detected faces
                  </p>
                  <label
                    className="thumbnail-size-control person-detail-thumbnail-size-control"
                    title="Adjust photo thumbnails in this cluster"
                  >
                    <FiColumns aria-hidden="true" />
                    <input
                      type="range"
                      min="120"
                      max={MAX_THUMBNAIL_SIZE}
                      step="10"
                      value={peopleThumbnailSize}
                      onChange={(event) =>
                        setPeopleThumbnailSize(Number(event.target.value))
                      }
                      aria-label="Cluster photo thumbnail size"
                    />
                    <output>{peopleThumbnailSize}px</output>
                  </label>
                </div>
                <div className="person-actions" data-tour="person-actions" data-help="These actions change person/profile records and assignments only. Rename changes the profile label; Merge combines profiles after confirmation and can be undone. Source photos are unchanged.">
                  <select
                    className="merge-dropdown person-sort-select"
                    value={sortValue}
                    onChange={(event) => changeSort(event.target.value)}
                    title="Sort photos (confirmed photos always come first)"
                  >
                    <option value="magic-desc">
                      ✦ Magic · best photos first
                    </option>
                    <option value="modified-desc">Newest first</option>
                    <option value="modified-asc">Oldest first</option>
                    <option value="size-desc">Largest first</option>
                    <option value="size-asc">Smallest first</option>
                    <option value="name-asc">Name A-Z</option>
                    <option value="name-desc">Name Z-A</option>
                  </select>
                  {magicTools(true)}
                  <label
                    className={`ban-switch ${personDetail.status === "banned" ? "on" : ""}`}
                    title={
                      personDetail.status === "banned"
                        ? "Unban: show this person's photos again"
                        : "Ban: hide this person's photos everywhere"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={personDetail.status === "banned"}
                      disabled={personBusy}
                      onChange={(event) => {
                        if (event.target.checked) banPerson();
                        else
                          void runPersonAction((personId) =>
                            electronAPI!.unbanPerson(personId),
                          );
                      }}
                    />
                    <span className="ban-switch-track">
                      <span />
                    </span>
                    <FiSlash /> Ban
                  </label>
                  <button
                    onClick={() =>
                      setSelectedFilePaths(
                        uniquePersonPhotos.every((photo) =>
                          selectedFilePaths.has(photo.path),
                        )
                          ? new Set()
                          : new Set(
                              uniquePersonPhotos.map((photo) => photo.path),
                            ),
                      )
                    }
                    disabled={uniquePersonPhotos.length === 0}
                  >
                    <FiCheck />{" "}
                    {uniquePersonPhotos.every((photo) =>
                      selectedFilePaths.has(photo.path),
                    )
                      ? "Clear all"
                      : "Select all"}
                  </button>
                  <button
                    onClick={addSelectedPhotoToPerson}
                    disabled={
                      !selectedFile ||
                      !PERSON_MEDIA_TYPES.has(selectedFile.type)
                    }
                  >
                    <FiPlus /> Copy selected media
                  </button>
                  <button onClick={renamePerson}>Rename</button>
                  {people.length > 1 && (
                    <button
                      onClick={(event) => {
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setMergePicker({ x: rect.left, y: rect.bottom + 6 });
                      }}
                      title="Merge this whole person into another person"
                    >
                      Merge into…
                    </button>
                  )}
                  <button onClick={deletePerson} title="Delete person profile and Silo references only">
                    <FiTrash2 />
                  </button>
                </div>
              </div>

              <div
                className={`person-confirmation ${personDetail.fullyConfirmed ? "complete" : ""}`}
              >
                <div className="person-confirmation-progress">
                  <strong>
                    {personDetail.confirmedCount.toLocaleString()} of{" "}
                    {personDetail.reviewableCount.toLocaleString()} photos
                    confirmed
                  </strong>
                  <span>
                    {personDetail.fullyConfirmed
                      ? personDetail.status === "banned"
                        ? "Photos with this face are hidden across Silo."
                        : personDetail.trainedAt
                          ? `Recognition trained ${new Date(personDetail.trainedAt).toLocaleDateString()}. Retrain after confirming new suggestions.`
                          : "Every photo is confirmed. Train recognition to find more photos of this person."
                      : "Confirm or remove every photo to unlock recognition training. Right-click or Shift-click photos to move them to another person."}
                    {personDetail.hiddenCount > 0 &&
                      ` ${personDetail.hiddenCount.toLocaleString()} photo${personDetail.hiddenCount === 1 ? " is" : "s are"} hidden by content protection and not counted.`}
                  </span>
                  <progress
                    value={personDetail.confirmedCount}
                    max={Math.max(personDetail.reviewableCount, 1)}
                  />
                </div>
                <div className="person-confirmation-actions">
                  {!personDetail.fullyConfirmed && (
                    <button
                      disabled={
                        personBusy || personDetail.reviewableCount === 0
                      }
                      onClick={() =>
                        void runPersonAction((personId) =>
                          electronAPI!.confirmAllPersonPhotos(personId),
                        )
                      }
                      title="Mark every photo currently in this cluster as confirmed"
                    >
                      <FiCheck /> Confirm all
                    </button>
                  )}
                  {personDetail.status !== "banned" && (
                    <button
                      className="primary"
                      disabled={personBusy || !personDetail.fullyConfirmed}
                      onClick={() => void trainPerson()}
                    >
                      <FiRefreshCw />{" "}
                      {personDetail.trainedAt
                        ? "Retrain & rescan"
                        : "Train & find more"}
                    </button>
                  )}
                </div>
              </div>

              {!bannedPersonHidden && personSuggestions.length > 0 && (
                <section className="person-suggestions">
                  <header>
                    <div>
                      <h3>
                        {personSuggestions.length.toLocaleString()} suggested
                        photo{personSuggestions.length === 1 ? "" : "s"} of{" "}
                        {personDetail.name}
                      </h3>
                      <p>
                        Found by matching confirmed faces across all sources.
                        Accepting confirms them.
                      </p>
                    </div>
                    <button
                      disabled={personBusy}
                      onClick={() =>
                        void respondToSuggestions(
                          personSuggestions.map((photo) => photo.path),
                          true,
                        )
                      }
                    >
                      <FiCheck /> Accept all
                    </button>
                    <button
                      disabled={personBusy}
                      onClick={() =>
                        void respondToSuggestions(
                          personSuggestions.map((photo) => photo.path),
                          false,
                        )
                      }
                    >
                      <FiX /> Dismiss all
                    </button>
                  </header>
                  <div className="person-suggestion-grid">
                    {personSuggestions.map((photo) => (
                      <article
                        className="person-suggestion-card"
                        key={photo.path}
                      >
                        <FileThumbnail
                          file={photo}
                          thumbnailSize={peopleThumbnailSize}
                          onOpen={() =>
                            openMediaViewer(photo, personSuggestions)
                          }
                        />
                        <div className="person-photo-meta">
                          <span title={photo.name}>{photo.name}</span>
                          <div>
                            <button
                              disabled={personBusy}
                              onClick={() =>
                                void respondToSuggestions([photo.path], true)
                              }
                              title="Yes, this is them"
                            >
                              <FiCheck />
                            </button>
                            <button
                              disabled={personBusy}
                              onClick={() =>
                                void respondToSuggestions([photo.path], false)
                              }
                              title="Not them"
                            >
                              <FiX />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {bannedPersonHidden ? (
                <div className="banned-hidden-notice">
                  <FiEyeOff />
                  <p>This person is banned, so their photos are hidden.</p>
                  <button onClick={() => setRevealBannedFaces(true)}>
                    <FiEye /> Show photos
                  </button>
                </div>
              ) : (
                <div className="person-workspace">
                  <div className="person-photos">
                    {uniquePersonPhotos.length === 0 ? (
                      <div className="people-empty">
                        No photos yet. Select an image in Files, then use Copy
                        selected photo.
                      </div>
                    ) : (
                      uniquePersonPhotos.map((photo) => (
                        <article
                          className={`person-photo-card ${selectedPersonPhoto?.path === photo.path ? "selected" : ""} ${selectedFilePaths.has(photo.path) ? "bulk-selected" : ""}`}
                          key={photo.path}
                          data-file-path={photo.path}
                          data-file-type="image"
                          data-directory="false"
                          onClick={(e) => {
                            if (dragCompletedRef.current) {
                              dragCompletedRef.current = false;
                              return;
                            }
                            if (e.shiftKey) {
                              openPhotoMenu(e, photo, true);
                            } else if (e.ctrlKey || e.metaKey) {
                              toggleFileSelection(photo.path);
                            } else {
                              clearFileSelection();
                              selectPersonPhoto(photo);
                            }
                          }}
                          onContextMenu={(e) => {
                            // macOS Ctrl+click arrives as a context menu; the drag-select hook treats it as toggle.
                            if (e.ctrlKey) return;
                            openPhotoMenu(e, photo, false);
                          }}
                        >
                          <input
                            type="checkbox"
                            className="person-photo-checkbox"
                            checked={selectedFilePaths.has(photo.path)}
                            onChange={() => toggleFileSelection(photo.path)}
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`Select ${photo.name}`}
                          />
                          <FileThumbnail
                            file={photo}
                            thumbnailSize={peopleThumbnailSize}
                            onOpen={() =>
                              openMediaViewer(photo, uniquePersonPhotos)
                            }
                          />
                          <button
                            className="person-photo-view-faces"
                            type="button"
                            aria-label={`View faces in ${photo.name}`}
                            title="View faces in this photo"
                            onClick={(event) => {
                              event.stopPropagation();
                              clearFileSelection();
                              void selectPersonPhoto(photo);
                            }}
                          >
                            <FiEye aria-hidden="true" />
                          </button>
                          {magicBadge(photo.path)}
                          <div className="person-photo-meta">
                            <span title={photo.name}>{photo.name}</span>
                            <div>
                              <button
                                className={`favorite ${favoritePaths.has(photo.path) ? "active" : ""}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void toggleFavorite(photo.path);
                                }}
                                title={
                                  favoritePaths.has(photo.path)
                                    ? "Remove from Favorites"
                                    : "Add to Favorites"
                                }
                              >
                                <FiHeart />
                              </button>
                              <button
                                className={
                                  personDetail.confirmedPhotoPaths.includes(
                                    photo.path,
                                  )
                                    ? "confirmed"
                                    : ""
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void confirmPersonPhoto(photo.path);
                                }}
                                title={
                                  selectedFilePaths.has(photo.path) &&
                                  personSelectionFor(photo.path).length > 1
                                    ? `Confirm all ${personSelectionFor(photo.path).length} selected photos`
                                    : "Confirm this person appears"
                                }
                              >
                                <FiCheck />
                              </button>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void removePersonPhoto(photo.path);
                                }}
                                title={
                                  selectedFilePaths.has(photo.path) &&
                                  personSelectionFor(photo.path).length > 1
                                    ? `Remove all ${personSelectionFor(photo.path).length} selected photos from this person`
                                    : "Remove from this person"
                                }
                              >
                                <FiX />
                              </button>
                              <button
                                className={`set-pfp ${personDetail?.selectedCoverPhotoPath === photo.path ? "active" : ""}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const isCurrentPfp =
                                    personDetail?.selectedCoverPhotoPath ===
                                    photo.path;
                                  void setPersonCoverPhoto(
                                    isCurrentPfp ? null : photo.path,
                                  );
                                }}
                                title={
                                  personDetail?.selectedCoverPhotoPath ===
                                  photo.path
                                    ? "Clear as profile picture"
                                    : "Set as profile picture"
                                }
                              >
                                <FiStar />
                              </button>
                            </div>
                          </div>
                        </article>
                      ))
                    )}
                  </div>

                  <aside className="detected-faces-panel">
                    <h3>Faces in selected photo</h3>
                    {!selectedPersonPhoto ? (
                      <p>Select a photo to review its detected faces.</p>
                    ) : selectedPhotoFaces.length === 0 ? (
                      <p>No indexed faces found in this photo yet.</p>
                    ) : (
                      selectedPhotoFaces.map((face) => (
                        <div className="assign-face-card" key={face.id}>
                          <img src={face.cropUrl} alt="Detected face" />
                          <button
                            onClick={() => assignFaceToPerson(face.id)}
                            disabled={face.personIds.includes(personDetail.id)}
                          >
                            {face.personIds.includes(personDetail.id) ? (
                              <>
                                <FiCheck /> Added
                              </>
                            ) : (
                              <>
                                <FiUserPlus /> Add face
                              </>
                            )}
                          </button>
                        </div>
                      ))
                    )}
                  </aside>
                </div>
              )}

              {photoMenu &&
                createPortal(
                  <div
                    className="photo-context-backdrop"
                    onMouseDown={() => setPhotoMenu(null)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setPhotoMenu(null);
                    }}
                  >
                    <div
                      className="photo-context-menu"
                      role="menu"
                      style={{
                        left: Math.max(
                          8,
                          Math.min(photoMenu.x, window.innerWidth - 290),
                        ),
                        top: Math.max(
                          8,
                          Math.min(photoMenu.y, window.innerHeight - 440),
                        ),
                      }}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <header>
                        {photoMenu.paths.length.toLocaleString()} photo
                        {photoMenu.paths.length === 1 ? "" : "s"} selected
                      </header>
                      <button
                        className="photo-context-confirm"
                        role="menuitem"
                        onClick={() => {
                          const paths = photoMenu.paths;
                          setPhotoMenu(null);
                          void runPersonAction((personId) =>
                            electronAPI!.confirmPersonPhotos(personId, paths),
                          );
                        }}
                      >
                        <FiCheck /> Confirm{" "}
                        {photoMenu.paths.length === 1
                          ? "photo"
                          : `${photoMenu.paths.length.toLocaleString()} photos`}{" "}
                        as {personDetail.name}
                      </button>
                      <button
                        className="photo-context-folder"
                        role="menuitem"
                        onClick={() => {
                          const paths = photoMenu.paths;
                          setPhotoMenu(null);
                          openFolderSelector(undefined, paths);
                        }}
                      >
                        <FiFolder /> Add to Digital Folder
                      </button>
                      <span className="photo-context-label">Move to</span>
                      <input
                        autoFocus
                        value={photoMenuQuery}
                        onChange={(event) =>
                          setPhotoMenuQuery(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setPhotoMenu(null);
                        }}
                        placeholder="Search people"
                      />
                      <button
                        className="photo-context-new"
                        role="menuitem"
                        onClick={() => {
                          const paths = photoMenu.paths;
                          setPhotoMenu(null);
                          openDialog({
                            mode: "text",
                            title: `New person from ${paths.length.toLocaleString()} photo${paths.length === 1 ? "" : "s"}`,
                            initialValue: photoMenuQuery.trim(),
                            placeholder: "Person name",
                            confirmLabel: "Create & move",
                            onConfirm: (name) =>
                              movePersonPhotosTo(paths, { newName: name }),
                          });
                        }}
                      >
                        <FiUserPlus /> New person…
                      </button>
                      <div className="photo-context-list">
                        {people
                          .filter((person) => person.id !== personDetail.id)
                          .filter((person) => {
                            const query = photoMenuQuery.trim().toLowerCase();
                            return (
                              !query ||
                              person.name.toLowerCase().includes(query)
                            );
                          })
                          .sort(
                            (first, second) =>
                              Number(second.status === "confirmed") -
                                Number(first.status === "confirmed") ||
                              Number(first.status === "banned") -
                                Number(second.status === "banned") ||
                              second.photoCount - first.photoCount,
                          )
                          .slice(0, 300)
                          .map((person) => {
                            const hideIdentity =
                              person.status === "banned" && !revealBannedFaces;
                            return (
                              <button
                                key={person.id}
                                role="menuitem"
                                className={
                                  person.status === "banned"
                                    ? "banned"
                                    : undefined
                                }
                                onClick={() => {
                                  const paths = photoMenu.paths;
                                  setPhotoMenu(null);
                                  void movePersonPhotosTo(paths, {
                                    personId: person.id,
                                  });
                                }}
                              >
                                <span className="photo-context-avatar">
                                  {person.coverCropUrl && !hideIdentity ? (
                                    <img src={person.coverCropUrl} alt="" />
                                  ) : (
                                    <FiUser />
                                  )}
                                </span>
                                <span className="photo-context-name">
                                  {hideIdentity ? "Banned person" : person.name}
                                </span>
                                {person.status === "confirmed" && (
                                  <FiUserCheck />
                                )}
                                {person.status === "banned" && <FiSlash />}
                                <small>
                                  {person.photoCount.toLocaleString()}
                                </small>
                              </button>
                            );
                          })}
                      </div>
                      <button
                        className="photo-context-remove"
                        role="menuitem"
                        onClick={() => {
                          const paths = photoMenu.paths;
                          setPhotoMenu(null);
                          void movePersonPhotosTo(paths, null);
                        }}
                      >
                        <FiX /> Remove from {personDetail.name}
                      </button>
                    </div>
                  </div>,
                  document.body,
                )}
            </section>
          ) : (
            <>
              <nav className="people-tabs" data-tour="people-status-tabs" data-help="Switch between working person clusters and confirmed profiles. The confirmed view also lists banned people and their visibility controls.">
                <button
                  className={peopleTab === "all" ? "active" : ""}
                  onClick={() => setPeopleTab("all")}
                >
                  <FiUsers /> All people
                </button>
                <button
                  className={peopleTab === "confirmed" ? "active" : ""}
                  onClick={() => setPeopleTab("confirmed")}
                >
                  <FiUserCheck /> Confirmed faces
                  <span>
                    {
                      people.filter((person) => person.status !== "unconfirmed")
                        .length
                    }
                  </span>
                </button>
                <button
                  className="people-new-person-button"
                  onClick={createPerson}
                  data-tour="new-person"
                  title="Create a People profile in Silo"
                  data-help="Create a People profile in Silo. This does not change source photos."
                >
                  <FiUserPlus aria-hidden="true" /> New Person +
                </button>
              </nav>
              {peopleTab === "confirmed" ? (
                <section className="confirmed-faces">
                  <div className="confirmed-face-grid">
                    {people
                      .filter((person) => person.status === "confirmed")
                      .map((person) => (
                        <button
                          className="confirmed-face"
                          key={person.id}
                          onClick={() => openPerson(person.id)}
                        >
                          <span className="confirmed-face-avatar">
                            {person.coverCropUrl ? (
                              <img
                                src={person.coverCropUrl}
                                alt={person.name}
                              />
                            ) : (
                              <FiUser />
                            )}
                          </span>
                          <strong>{person.name}</strong>
                          <small>
                            {person.photoCount.toLocaleString()} photos
                            {person.suggestedCount > 0
                              ? ` · ${person.suggestedCount.toLocaleString()} suggested`
                              : ""}
                          </small>
                        </button>
                      ))}
                    {!people.some(
                      (person) => person.status === "confirmed",
                    ) && (
                      <div className="people-empty">
                        <FiUserCheck />
                        <p>
                          Open a person, confirm every photo, then choose Train
                          & find more.
                        </p>
                      </div>
                    )}
                  </div>
                  <section className="banned-faces">
                    <header>
                      <h3>
                        <FiSlash /> Banned people
                      </h3>
                      <span>
                        {contentSettings.showBannedPeople
                          ? "Their photos are visible (Settings → Show banned people)."
                          : "Their photos are hidden throughout Silo."}
                      </span>
                      <button
                        onClick={() =>
                          setRevealBannedFaces((current) => !current)
                        }
                      >
                        {revealBannedFaces ? (
                          <>
                            <FiEyeOff /> Hide faces
                          </>
                        ) : (
                          <>
                            <FiEye /> Show faces
                          </>
                        )}
                      </button>
                    </header>
                    <div className="confirmed-face-grid">
                      {people
                        .filter((person) => person.status === "banned")
                        .map((person) => (
                          <button
                            className="confirmed-face banned"
                            key={person.id}
                            onClick={() => openPerson(person.id)}
                          >
                            <span className="confirmed-face-avatar">
                              {revealBannedFaces && person.coverCropUrl ? (
                                <img
                                  src={person.coverCropUrl}
                                  alt={person.name}
                                />
                              ) : (
                                <FiUser />
                              )}
                            </span>
                            <strong>
                              {revealBannedFaces
                                ? person.name
                                : "Banned person"}
                            </strong>
                            <small>
                              {person.photoCount.toLocaleString()} photos
                            </small>
                          </button>
                        ))}
                      {!people.some((person) => person.status === "banned") && (
                        <p className="banned-empty">
                          No banned people. Confirm every photo of someone, then
                          choose Ban.
                        </p>
                      )}
                    </div>
                  </section>
                </section>
              ) : (
                <section className="people-grid">
                  {people.length === 0 ? (
                    <div className="people-empty">
                      <FiUsers />
                      <h2>{faceProgress.status === "indexing" || faceProgress.status === "loading-model"
                        ? "Finding people in your photos"
                        : "Start with face indexing"}</h2>
                      <p>
                        {faceProgress.status === "indexing" || faceProgress.status === "loading-model"
                          ? "People appear here as Silo finds face groups. This separate index leaves your original photos unchanged."
                          : "Silo checks indexed photos for faces, then groups them here for you to review and name. Your original photos stay unchanged."}
                      </p>
                      {faceProgress.status !== "indexing" && faceProgress.status !== "loading-model" && (
                        <button
                          type="button"
                          className="index-action people-empty-action"
                          onClick={() => void toggleFaceIndexing()}
                          disabled={faceActionPending !== null}
                          data-tour="people-empty-start"
                        >
                          {faceActionPending === "resume" || faceProgress.status === "paused"
                            ? <FiRefreshCw />
                            : <FiPlay />}
                          {faceActionPending === "resume"
                            ? "Queueing…"
                            : faceProgress.status === "paused"
                              ? "Resume face indexing"
                              : faceProgress.status === "complete"
                              ? "Check for new photos"
                                : faceProgress.status === "error"
                                  ? "Retry face indexing"
                                  : "Start face indexing"}
                        </button>
                      )}
                    </div>
                  ) : (
                    people
                      .filter((person) => person.status !== "banned")
                      .map((person) => (
                        <button
                          className="person-card"
                          key={person.id}
                          onClick={() => openPerson(person.id)}
                        >
                          <div className="person-cover">
                            {person.coverCropUrl ? (
                              <img
                                src={person.coverCropUrl}
                                alt={person.name}
                              />
                            ) : (
                              <FiUsers />
                            )}
                          </div>
                          <div>
                            <h3>
                              {person.name}
                              {person.status === "confirmed" && (
                                <FiUserCheck
                                  className="person-card-confirmed"
                                  title="Confirmed"
                                />
                              )}
                            </h3>
                            <p>
                              {person.photoCount} photos · {person.faceCount}{" "}
                              faces
                            </p>
                          </div>
                        </button>
                      ))
                  )}
                </section>
              )}
            </>
          )}
        </main>
        </div>
      )}
      {(visitedSections.has("map") || appSection === "map") && (
        <div className="section-view" data-active={appSection === "map"} aria-hidden={appSection !== "map"}>
        <React.Suspense
          fallback={
            <main className="map-page">
              <div className="viewer-status">Loading globe...</div>
            </main>
          }
        >
          <MapPage
            digitalFolders={digitalFolders}
            fileMetadata={fileMetadata}
            redundantPaths={redundantDuplicatePaths}
            hiddenPaths={allHiddenPaths}
            mapServicesAllowed={mapServicesAllowed}
            active={appSection === "map"}
            onOpenFile={(file, clusterFiles) =>
              void openMediaViewer(file, clusterFiles)
            }
            onStateChanged={applyPersistedState}
            onOpenFiles={() => setAppSection("files")}
            onOpenFolder={(folderId) => {
              setAppSection("files");
              void openDigitalFolder(folderId);
            }}
          />
        </React.Suspense>
        </div>
      )}
      {(visitedSections.has("duplicates") || appSection === "duplicates") && (
        <div className="section-view" data-active={appSection === "duplicates"} aria-hidden={appSection !== "duplicates"}>
        <DuplicatesPage
          state={duplicateState}
          onStateChange={setDuplicateState}
          tourView={tourDuplicateView}
          thumbnailSize={duplicatesThumbnailSize}
          onThumbnailSizeChange={setDuplicatesThumbnailSize}
          active={appSection === "duplicates"}
        />
        </div>
      )}
      {(visitedSections.has("mobile") || appSection === "mobile") && (
        <div className="section-view" data-active={appSection === "mobile"} aria-hidden={appSection !== "mobile"}>
        <main className="mobile-page" data-retained-scroll="mobile" data-tour="mobile-overview" data-help="Mobile manages device discovery, connections, dated browseable copies, iOS restore archives, and message history exports. Check platform and backup scope before starting an operation.">
          <section className="mobile-messages-section" aria-label="Mobile manager">
        <MessageExportPanel
            phoneDevices={phoneDevices}
            connectedPhone={connectedPhone}
            showHiddenMessages={showHiddenMessages}
            messagesWorkflowRequest={mobileMessagesHelpRequest}
            onScanPhones={scanForPhones}
            scanningPhones={phoneScanning}
            devicePanel={
                <PhoneManagementPanel
                  devices={phoneDevices}
                  tooling={phoneTooling}
                  notice={phoneNotice}
                  busyDeviceId={phoneBusyId}
                  activeDeviceKey={
                    connectedPhone
                      ? `${connectedPhone.platform}:${connectedPhone.id}`
                      : null
                  }
                  backups={phoneBackups}
                  backupDestination={phoneBackupDestination}
                  formatFileSize={formatFileSize}
                  restoreArchives={phoneRestoreArchives}
                  onBrowse={browsePhone}
                  onConnect={connectPhone}
                  onDisconnect={disconnectPhone}
                  onRename={renamePhone}
                  onRenewBackup={renewPhoneBackup}
                  onPreviewBackup={previewPhoneBackup}
                  onChooseBackupDestination={() =>
                    void choosePhoneBackupDestination()
                  }
                  onResetBackupDestination={() =>
                    void resetPhoneBackupDestination()
                  }
                  onCreateRestoreArchive={createPhoneRestoreArchive}
                  onRestoreFromArchive={restorePhoneFromArchive}
                />
              }
            />
          </section>
        </main>
        </div>
      )}
      {(visitedSections.has("files") || appSection === "files" || appSection === "pets") && (
        <div className="section-view" data-active={appSection === "files" || appSection === "pets"} aria-hidden={appSection !== "files" && appSection !== "pets"}>
        <div
          className="main-container"
          data-help="Files combines your enabled sources with local indexing, semantic search, filters, virtual folders, and careful file actions. Source status and indexing progress appear in the sidebar."
          style={
            {
              "--sidebar-width": `${sidebarWidth}px`,
              "--thumbnail-size": `${filesThumbnailSize}px`,
            } as React.CSSProperties
          }
        >
          <aside
            className={`library-sidebar${librarySidebarCollapsed ? " is-collapsed" : ""}`}
            aria-label="Files sources and folders"
          >
            <div className="library-sidebar-controls">
              <button
                className="library-sidebar-collapse-button"
                type="button"
                aria-label={librarySidebarCollapsed ? "Expand source and folder sidebar" : "Collapse source and folder sidebar"}
                aria-expanded={!librarySidebarCollapsed}
                title={librarySidebarCollapsed ? "Expand source and folder sidebar" : "Collapse source and folder sidebar"}
                onClick={toggleLibrarySidebarCollapsed}
              >
                {librarySidebarCollapsed ? <FiChevronRight aria-hidden="true" /> : <FiChevronLeft aria-hidden="true" />}
                <span>{librarySidebarCollapsed ? "Expand" : "Collapse sidebar"}</span>
              </button>
            </div>
            {!librarySidebarCollapsed && <>
            <section className="sidebar-section volumes" data-tour="source-controls" data-help="Choose which local, cloud, or saved-device sources are included in Files. Available sources can be browsed; adding a folder starts indexing.">
              <div className="sidebar-heading">
                <button
                  type="button"
                  className="sidebar-collapse-toggle"
                  aria-expanded={!sidebarCollapsed.sources}
                  onClick={() => toggleSidebarSection("sources")}
                  title={sidebarCollapsed.sources ? "Show sources" : "Hide sources"}
                >
                  <span className="sidebar-kicker">Volumes</span>
                  <h2>
                    Sources
                    <FiChevronDown className="sidebar-collapse-chevron" aria-hidden="true" />
                  </h2>
                </button>
                <button
                  onClick={addIndexSource}
                  data-tour="sources-add"
                  title="Add a folder source; it will be indexed automatically"
                  aria-label="Add a folder source"
                  data-help="Choose a folder on this Mac to register as a source and start indexing it."
                >
                  <FiPlus />
                </button>
                <button
                  onClick={addMachineSource}
                  title="Add this Mac’s internal drive as a source"
                  aria-label="Add This Mac as a source"
                  data-help="Browse, organize, index, search, and map files on this Mac’s internal data volume. Mounted external volumes are excluded."
                >
                  <FiHardDrive />
                </button>
                <button onClick={refreshSources} title="Refresh sources" aria-label="Refresh sources"
                  data-help="Refresh source availability and registered-source details.">
                  <FiRefreshCw />
                </button>
                {hasCachedPhoneBackups && (
                  <button
                    type="button"
                    onClick={() => setShowPhoneBackups((visible) => !visible)}
                    title={showPhoneBackups ? "Hide cached phone backups" : "Show cached phone backups"}
                    aria-label={showPhoneBackups ? "Hide cached phone backups" : "Show cached phone backups"}
                    aria-pressed={showPhoneBackups}
                    className={showPhoneBackups ? "source-backups-toggle active" : "source-backups-toggle"}
                  >
                    <FiClock aria-hidden="true" />
                  </button>
                )}
              </div>

              {!sidebarCollapsed.sources && (sources.length === 0 ? (
                <p className="sidebar-empty">
                  Add a folder, phone, or Google account to get started.
                </p>
              ) : (
                <>
                  <div className="source-toggle-row">
                    <button
                      type="button"
                      onClick={() => setEverySource(true)}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setEverySource(false)}
                    >
                      Select none
                    </button>
                  </div>

                  <label className="source-sort-row">
                    <span>Sort sources</span>
                    <select
                      className="type-select"
                      value={sourceSort}
                      onChange={(event) =>
                        setSourceSort(
                          event.target.value as "name" | "kind" | "backup",
                        )
                      }
                    >
                      <option value="name">Name (A–Z)</option>
                      <option value="kind">Source type</option>
                      <option value="backup">Latest backup</option>
                    </select>
                  </label>

                  {sortedSources.map((source) => (
                    <div
                      className={`volume-item ${source.enabled && source.available ? "enabled" : ""} ${source.available ? "" : "blocked"}`}
                      key={source.id}
                      title={source.message || source.detail}
                    >
                      <button
                        type="button"
                        className={`source-enable-toggle ${source.enabled ? "active" : ""}`}
                        disabled={Boolean(
                          source.ejectableVolume?.ejecting ||
                          (source.ejectableVolume && ejectingDeviceIds.has(source.ejectableVolume.wholeDeviceIdentifier))
                        )}
                        aria-pressed={source.enabled}
                        onClick={() => toggleSource(source.id, !source.enabled)}
                        title={
                          source.enabled
                            ? `Exclude ${source.label}`
                            : `Include ${source.label}`
                        }
                        aria-label={source.enabled
                          ? `Exclude ${source.label}`
                          : `Include ${source.label}`}
                      >
                        <span className="source-enable-mark" aria-hidden="true">
                          <FiCheck />
                        </span>
                        <span className={`volume-badge ${source.kind}`}>
                          {sourceKindLabels[source.kind]}
                        </span>
                        <span className="volume-name">
                          {source.label}
                          {source.lastClonedAt && (
                            <small
                              className="volume-clone-status"
                              title={`Last verified clone: ${new Date(source.lastClonedAt).toLocaleString()}${source.lastCloneDestination ? ` · ${source.lastCloneDestination}` : ""}`}
                            >
                              <FiCopy aria-hidden="true" /> Cloned {new Date(source.lastClonedAt).toLocaleString()}
                            </small>
                          )}
                        </span>
                      </button>
                      {source.ejectableVolume?.volumeUUID && (
                        <button
                          className="source-eject-button"
                          type="button"
                          disabled={sources.some((item) => item.ejectableVolume?.ejecting) ||
                            source.ejectableVolume.ejecting ||
                            ejectingDeviceIds.has(source.ejectableVolume.wholeDeviceIdentifier)}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void ejectSourceVolume(source);
                          }}
                          title={source.ejectableVolume.ejecting || ejectingDeviceIds.has(source.ejectableVolume.wholeDeviceIdentifier)
                            ? `Safely preparing ${source.ejectableVolume.label} for ejection`
                            : `Safely eject ${source.ejectableVolume.label} from macOS`}
                          aria-label={`Safely eject ${source.ejectableVolume.label} from the computer`}
                          data-help="Deselect every Silo source on this physical drive, pause Silo's background work, and ask macOS to eject it safely. Silo will resume its saved source selection when the same drive returns."
                        >
                          <FiLogOut aria-hidden="true" />
                        </button>
                      )}
                      {(source.kind === "local" || source.kind === "machine") && (
                        <button
                          className="source-unplug-button"
                          type="button"
                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); void removeSource(source); }}
                          title="Remove Source"
                          aria-label={`Remove ${source.label} from Silo. Its files stay on disk.`}
                          data-help="Remove this source and its saved indexes from Silo. Files and folders remain on disk."
                        >
                          <FiRotateCcw aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
                </>
              ))}
            </section>

            {GOOGLE_SOURCES_IN_SIDEBAR && !googleSourcesHidden && <details
              className="sidebar-section cloud-accounts"
              data-tour="google-sources"
              data-help="Optional online sources. Connecting a Google account uses Google's sign-in and consent flow; it does not affect local folders or offline features."
            >
              <summary className="sidebar-heading">
                <div>
                  <span className="sidebar-kicker">Optional · Cloud</span>
                  <h2>Google Accounts</h2>
                </div>
                <span className="cloud-accounts-chevron" aria-hidden="true">
                  <FiChevronDown />
                </span>
              </summary>
              <div className="cloud-accounts-content">
              {googleState?.configured && (
                <p className="google-scope-disclosure">
                  Before connecting: Google will be asked for full Drive access, access to items you choose in Photos Picker, and permission to modify Gmail messages for reclaim. Silo saves a verified local copy before moving selected items to Trash. “Delete forever” empties everything in this account’s Drive trash after a separate confirmation.
                </p>
              )}
              {googleState?.storageWarning && (
                <p className="google-storage-warning" role="alert">
                  {googleState.storageWarning}
                </p>
              )}
              {!googleState?.configured ? (
                <p className="sidebar-empty tooling-hint">
                  Google sources are not configured in this build. Local folders,
                  phone sources, and offline features work without a Google account.
                </p>
              ) : (
                <>
                  <button
                    className="connect-phone-button"
                    onClick={googleAddAccount}
                    disabled={googleBusy}
                    title="Add another Google account"
                  >
                    <FiPlus /> Add Google account
                  </button>
                  {googleState.accounts.length === 0 ? (
                    <button
                      className="connect-phone-button"
                      onClick={googleAddAccount}
                      disabled={googleBusy}
                    >
                      <FiCloud />{" "}
                      {googleBusy
                        ? "Waiting for browser…"
                        : "Connect Google account"}
                    </button>
                  ) : (
                    <>
                      <button
                        className="connect-phone-button"
                        onClick={() => openCloudRoot(googleState.allDrivesPath)}
                      >
                        <FiHardDrive /> All Drives{" "}
                        <small>{googleState.accounts.length}</small>
                      </button>
                      {googleState.totalPickedCount > 0 && (
                        <>
                          <button
                            className="connect-phone-button"
                            onClick={() =>
                              openCloudRoot(googleState.allPhotosPath)
                            }
                          >
                            <FiImage /> All Photos{" "}
                            <small>{googleState.totalPickedCount}</small>
                          </button>
                          <button
                            className="connect-phone-button"
                            onClick={() => exportPickedPhotos()}
                            disabled={googleBusy}
                          >
                            <FiDownload /> Download picked photos
                          </button>
                        </>
                      )}
                    </>
                  )}

                  {googleState.accounts.map((account) => (
                    <div
                      className={`google-account ${account.needsReauth ? "stale" : ""}`}
                      key={account.id}
                    >
                      <div className="google-account-info">
                        <strong title={account.email}>{account.email}</strong>
                        {account.needsReauth && (
                          <small className="phone-status untrusted">
                            Reconnect to load this account
                          </small>
                        )}
                      </div>
                      <div className="google-account-actions">
                        {account.needsReauth ? (
                          <button
                            onClick={googleAddAccount}
                            disabled={googleBusy}
                            title="Reconnect this account"
                          >
                            <FiCloud />
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() =>
                                openCloudRoot(account.driveRootPath)
                              }
                              title={`Browse ${account.email} Drive`}
                            >
                              <FiHardDrive />
                            </button>
                            <button
                              onClick={() => startPhotoPicker(account.id)}
                              disabled={
                                googleBusy ||
                                pickerSession?.accountId === account.id
                              }
                              title={`Pick photos from ${account.email}`}
                            >
                              <FiImage />
                            </button>
                            {account.pickedCount > 0 && (
                              <button
                                onClick={() =>
                                  openCloudRoot(account.photosRootPath)
                                }
                                title={`${account.pickedCount} picked photos`}
                              >
                                <FiFolder />
                              </button>
                            )}
                          </>
                        )}
                        {!account.needsReauth && (
                          <button
                            onClick={() => setGoogleReclaimAccountId(account.id)}
                            title={`Free up space in ${account.email}`}
                            aria-label={`Free up space in ${account.email}`}
                          >
                            <FiTrash2 />
                          </button>
                        )}
                        <button
                          onClick={() => googleRemoveAccount(account.id)}
                          disabled={googleBusy}
                          title={`Sign out ${account.email}`}
                        >
                          <FiX />
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {googleNotice && <p className="sidebar-empty">{googleNotice}</p>}
              </div>
            </details>}

            <section
              className="sidebar-section digital-folders"
              data-tour="digital-folders"
              data-help="Create or change local collections of file references. Adding, removing, renaming, reordering or deleting a Digital Folder does not move, rename or delete the original files."
            >
              <div className="sidebar-heading">
                <button
                  type="button"
                  className="sidebar-collapse-toggle"
                  aria-expanded={!sidebarCollapsed.folders}
                  onClick={() => toggleSidebarSection("folders")}
                  title={sidebarCollapsed.folders ? "Show virtual folders" : "Hide virtual folders"}
                >
                  <span className="sidebar-kicker">Virtual</span>
                  <h2>
                    Digital Folders
                    <FiChevronDown className="sidebar-collapse-chevron" aria-hidden="true" />
                  </h2>
                </button>
                <button
                  onClick={createDigitalFolder}
                  title="New Digital Folder"
                >
                  <FiPlus />
                </button>
              </div>
              {!sidebarCollapsed.folders && <>
              {folderOrderError && (
                <p className="sidebar-empty" role="alert">
                  {folderOrderError}
                </p>
              )}
              {digitalFolders.length === 0 ? (
                <p className="sidebar-empty">
                  Create folders without moving source files.
                </p>
              ) : (
                digitalFolders.map((folder) => (
                  <div
                    className={`digital-folder ${activeDigitalFolderId === folder.id ? "active" : ""} ${folderDropTarget?.id === folder.id ? (folderDropTarget.after ? "folder-drop-after" : "folder-drop-before") : ""}`}
                    key={folder.id}
                    onDragOver={(event) => {
                      if (
                        !draggedFolder.current ||
                        draggedFolder.current === folder.id ||
                        folderOrderBusy
                      )
                        return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      const after =
                        event.clientY > bounds.top + bounds.height / 2;
                      setFolderDropTarget((current) =>
                        current?.id === folder.id && current.after === after
                          ? current
                          : { id: folder.id, after },
                      );
                    }}
                    onDrop={async (event) => {
                      const sourceId = draggedFolder.current;
                      if (
                        !sourceId ||
                        sourceId === folder.id ||
                        folderOrderBusy
                      )
                        return;
                      event.preventDefault();
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      const after =
                        event.clientY > bounds.top + bounds.height / 2;
                      draggedFolder.current = null;
                      setFolderDropTarget(null);
                      setFolderOrderBusy(true);
                      setFolderOrderError("");
                      try {
                        const state = await electronAPI.moveDigitalFolder(
                          sourceId,
                          folder.id,
                          after,
                        );
                        setDigitalFolders(state.digitalFolders);
                      } catch (cause) {
                        setFolderOrderError(
                          cause instanceof Error
                            ? cause.message
                            : "Could not save folder order.",
                        );
                      } finally {
                        setFolderOrderBusy(false);
                      }
                    }}
                  >
                    <button
                      className="folder-drag-handle"
                      draggable={!folderOrderBusy}
                      disabled={folderOrderBusy}
                      aria-label={`Reorder ${folder.name}`}
                      title="Reorder Digital Folder"
                      onDragStart={(event) => {
                        draggedFolder.current = folder.id;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(
                          "application/x-silo-folder",
                          folder.id,
                        );
                      }}
                      onDragEnd={() => {
                        draggedFolder.current = null;
                        setFolderDropTarget(null);
                      }}
                    >
                      ⠿
                    </button>
                    <button
                      className="digital-folder-name"
                      onClick={() => openDigitalFolder(folder.id)}
                      title={`Open ${folder.name}`}
                    >
                      {folder.id === FAVORITES_FOLDER_ID ? (
                        <FiHeart />
                      ) : folder.id === REFUSE_FOLDER_ID ? (
                        <FiEyeOff />
                      ) : (
                        <FiFolder />
                      )}{" "}
                      <span>{folder.name}</span>
                      <small>{folder.filePaths.length}</small>
                    </button>
                    <button
                      onClick={() => renameDigitalFolder(folder)}
                      title={`Rename ${folder.name}`}
                      aria-label={`Rename ${folder.name}`}
                    >
                      <FiEdit3 />
                    </button>
                    <button
                      onClick={() => void toggleDigitalFolderHidden(folder)}
                      disabled={folder.id === REFUSE_FOLDER_ID}
                      title={
                        folder.id === REFUSE_FOLDER_ID
                          ? "Refuse always hides its contents"
                          : folder.hidden
                            ? "Show folder contents across Silo"
                            : "Hide folder contents across Silo"
                      }
                      aria-label={
                        folder.id === REFUSE_FOLDER_ID
                          ? "Refuse always hides its contents in Silo"
                          : folder.hidden
                            ? `Show ${folder.name} contents across Silo`
                            : `Hide ${folder.name} contents across Silo`
                      }
                    >
                      {folder.hidden ? <FiEyeOff /> : <FiEye />}
                    </button>
                    <button
                      onClick={() => addSelectedToDigitalFolder(folder.id)}
                      disabled={
                        selectedFilePaths.size === 0 &&
                        (!selectedFile || selectedFile.isDirectory)
                      }
                      title={`Add selected file${selectedFilePaths.size === 1 ? "" : "s"} to ${folder.name} (reference only)`}
                      aria-label={`Add selected items to ${folder.name} as references only`}
                    >
                      <FiPlus />
                    </button>
                    <button
                      onClick={() => downloadDigitalFolder(folder.id)}
                      disabled={folder.filePaths.length === 0}
                      title="Save copies to this device"
                      aria-label="Save copies in this Digital Folder to this device"
                    >
                      <FiDownload />
                    </button>
                    {folder.id !== FAVORITES_FOLDER_ID &&
                      folder.id !== REFUSE_FOLDER_ID && (
                        <button
                          onClick={() => deleteDigitalFolder(folder.id)}
                          title="Delete Digital Folder only"
                          aria-label={`Delete ${folder.name} from Silo only`}
                        >
                          <FiTrash2 />
                        </button>
                      )}
                  </div>
                ))
              )}
              {activeDigitalFolderId && selectedFile && (
                <button
                  className="remove-reference"
                  onClick={removeSelectedFromDigitalFolder}
                  title="Remove this reference only"
                >
                  Remove selected reference
                </button>
              )}
              </>}
            </section>

            <section
              className="sidebar-section library-indexing"
              data-tour="indexing-progress"
              data-help="Review indexing stages and progress. File indexing prepares local search; face indexing is a separate optional task in People."
            >
              <IndexingPanel
                active={appSection === "files" || appSection === "pets"}
                collapsed={sidebarCollapsed.indexing}
                onToggleCollapsed={() => toggleSidebarSection("indexing")}
              />
            </section>
            </>}
          </aside>
          {!librarySidebarCollapsed && <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize library sidebar"
            aria-valuemin={200}
            aria-valuemax={520}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={startSidebarResize}
            onPointerMove={resizeSidebar}
            onPointerUp={finishSidebarResize}
            onPointerCancel={finishSidebarResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft")
                setSidebarWidth((width) => Math.max(200, width - 16));
              if (event.key === "ArrowRight")
                setSidebarWidth((width) => Math.min(520, width + 16));
            }}
          />}
          <div
            className={`file-browser ${audioOnlySelected ? "audio-only" : ""} ${videoOnlySelected ? "video-only" : ""}`}
            data-retained-scroll="files"
            ref={fileBrowserRef}
          >
            {browseError && (
              <div className="file-scan-banner" role="alert">
                <span>{browseError}</span>
                <button
                  disabled={loading || !currentPath}
                  onClick={() => {
                    if (currentPath)
                      void loadDirectory(
                        currentPath,
                        explodedRef.current,
                        true,
                      );
                  }}
                >
                  <FiRefreshCw /> Retry
                </button>
              </div>
            )}
            <div className="browser-view-options">
              <span>
                {searchQuery.trim()
                  ? "Search result thumbnail size"
                  : "Thumbnail size"}
              </span>
              <FiColumns aria-hidden="true" />
              <input
                type="range"
                min="120"
                max={MAX_THUMBNAIL_SIZE}
                step="10"
                value={filesThumbnailSize}
                onChange={(event) =>
                  setFilesThumbnailSize(Number(event.target.value))
                }
                aria-label="Thumbnail size"
              />
              <output>{filesThumbnailSize}px</output>
            </div>
            {loading && !searchQuery.trim() && files.length > 0 && (
              <div className="file-scan-banner">
                <span>
                  Scanning this folder tree
                  {fileScanProgress
                    ? ` · ${(fileScanProgress.scanned ?? 0).toLocaleString()} found`
                    : "…"}
                </span>
                <strong>
                  {files.length.toLocaleString()} available ·{" "}
                  {loadedThumbnailPaths.size.toLocaleString()} previews loaded
                </strong>
              </div>
            )}
            {needsPhotoMetadata && (
              <div className="metadata-status-slot">
                <div
                  className="metadata-status"
                  role="status"
                  style={{
                    visibility:
                      showMetadataBusy || sortIndicatorError
                        ? "visible"
                        : "hidden",
                  }}
                >
                  {sortIndicatorError ||
                    (metadataIndicatorProgress
                      ? `Checking people and locations · ${metadataIndicatorProgress.processed.toLocaleString()} of ${metadataIndicatorProgress.total.toLocaleString()} photos`
                      : "Updating people and location sort…")}
                </div>
              </div>
            )}
            {!currentPath && !searchQuery.trim() && !activeDigitalFolderId ? (
              <div className="files-welcome" data-tour="files-welcome">
                <div className="files-welcome-mark" aria-hidden="true">
                  <FiImage />
                </div>
                <span className="files-welcome-kicker">YOUR LIBRARY STARTS HERE</span>
                <h2>Bring your folders into Silo</h2>
                <p>
                  Choose the folders you want to browse. Silo indexes them in
                  place, so your originals stay where they are.
                </p>
                <div className="files-welcome-actions">
                  <button className="primary files-welcome-primary" type="button" onClick={addIndexSource} data-tour="source-add-folder" title="Register a folder as a Silo source and start indexing it" data-help="Choose a folder to add to your library. Silo indexes it without moving or changing its files.">
                    <FiFolderPlus aria-hidden="true" /> Add a folder
                  </button>
                  <button className="files-welcome-secondary" type="button" onClick={addMachineSource} data-tour="source-add-machine" title="Add this Mac’s internal data volume; mounted external drives are excluded" data-help="Browse and index this Mac’s internal data volume. Mounted external drives remain separate sources.">
                    <FiHardDrive aria-hidden="true" /> Add This Mac
                  </button>
                </div>
                <div className="files-welcome-next-steps" aria-label="What you can do in Files">
                  <span><FiSearch aria-hidden="true" /> Search across your library</span>
                  <span><FiFolder aria-hidden="true" /> Keep sources organized</span>
                  <span><FiHeart aria-hidden="true" /> Make folders for collections</span>
                </div>
              </div>
            ) : searchQuery.trim() &&
              (searchIndexReadiness.status === "unavailable" ||
                searchIndexReadiness.status === "error") ? (
              <div className="empty-state" role="status">
                <h2>Search index unavailable</h2>
                <p>{searchIndexReadiness.message}</p>
              </div>
            ) : (!searchQuery.trim() && loading && filteredAndSortedFiles.length === 0) ||
              (searchQuery.trim() &&
                searchIndexReadiness.status === "preparing" &&
                filteredAndSortedFiles.length === 0) ||
              (searching && filteredAndSortedFiles.length === 0) ? (
              <div className="loading">
                <div>
                  {searchQuery.trim()
                    ? searchIndexReadiness.status === "preparing"
                      ? `Preparing saved search index · ${searchIndexReadiness.percentage}%`
                      : "Finding first results…"
                    : "Scanning files..."}
                </div>
                {searchQuery.trim() && searchIndexReadiness.status === "preparing" && (
                  <p className="search-index-preparing-copy">
                    Search works now. Results may take longer while Silo prepares
                    the saved library index. {searchIndexReadiness.records.toLocaleString()} records
                    prepared so far.
                  </p>
                )}
                {!searchQuery.trim() && loading && filteredAndSortedFiles.length === 0 && (
                  <div className="loading-progress">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{
                          width: `${Math.min(100, (indexProgress.indexed / Math.max(indexProgress.total, 1)) * 100)}%`,
                        }}
                      ></div>
                    </div>
                    <p>
                      {(fileScanProgress?.scanned ?? 0).toLocaleString()} files
                      scanned · {loadedThumbnailPaths.size.toLocaleString()}{" "}
                      previews loaded
                    </p>
                  </div>
                )}
              </div>
            ) : filteredAndSortedFiles.length === 0 ? (
              <div className="empty-state">
                <h2>No files found</h2>
                <p>
                  This directory is empty or the current filter has no matches
                </p>
              </div>
            ) : viewMode === "list" ? (
              <table className="file-list">
                <thead>
                  <tr>
                    <th
                      className={`sortable ${sort.field === "name" ? "sorted" : ""}`}
                      onClick={() => handleHeaderSort("name")}
                      title="Click to sort by name"
                    >
                      <div className="header-content">
                        Name
                        {renderSortIndicator("name")}
                      </div>
                    </th>
                    <th className="location-header">Location</th>
                    <th>Source</th>
                    <th
                      className={`sortable ${sort.field === "size" ? "sorted" : ""}`}
                      onClick={() => handleHeaderSort("size")}
                      title="Click to sort by size"
                    >
                      <div className="header-content">
                        Size
                        {renderSortIndicator("size")}
                      </div>
                    </th>
                    <th>Category</th>
                    <th
                      className={`sortable ${sort.field === "modified" ? "sorted" : ""}`}
                      onClick={() => handleHeaderSort("modified")}
                      title="Click to sort by date modified"
                    >
                      <div className="header-content">
                        Modified
                        {renderSortIndicator("modified")}
                      </div>
                    </th>
                    {searchQuery.trim() && (
                      <>
                        <th>Source</th>
                        <th>Match</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {displayItems.map((item) =>
                    item.kind === "year" ? (
                      <tr key={`year-${item.year}`} className="file-year-row">
                        <td colSpan={searchQuery.trim() ? 8 : 6}>
                          <button
                            className="file-year-toggle"
                            aria-expanded={expandedYears.has(item.year)}
                            onClick={() =>
                              setExpandedYears((current) => {
                                const next = new Set(current);
                                if (next.has(item.year)) next.delete(item.year);
                                else next.add(item.year);
                                return next;
                              })
                            }
                          >
                            {expandedYears.has(item.year) ? (
                              <FiChevronDown />
                            ) : (
                              <FiChevronRight />
                            )}
                            <strong>{item.year}</strong>
                            <span>
                              {item.count.toLocaleString()} files
                              {expandedYears.has(item.year) &&
                              item.count >
                                (yearDisplayLimits[item.year] ?? yearPageSize)
                                ? ` · ${Math.min(item.count, yearDisplayLimits[item.year] ?? yearPageSize).toLocaleString()} displayed`
                                : ""}
                            </span>
                          </button>
                        </td>
                      </tr>
                    ) : item.kind === "more" ? (
                      <tr
                        key={`more-${item.year}`}
                        className="file-year-more-row"
                      >
                        <td colSpan={searchQuery.trim() ? 8 : 6}>
                          <button
                            onClick={() =>
                              setYearDisplayLimits((current) => ({
                                ...current,
                                [item.year]:
                                  (current[item.year] ?? yearPageSize) +
                                  Math.min(500, item.count),
                              }))
                            }
                          >
                            Load {Math.min(500, item.count).toLocaleString()} more from {item.year}
                          </button>
                        </td>
                      </tr>
                    ) : (
                      (() => {
                        const file = item.file;
                        return (
                          <tr
                            key={fileListKey(file)}
                            data-file-path={file.path}
                            data-file-type={file.type}
                            data-directory={file.isDirectory ? "true" : "false"}
                            className={`file-row ${file.isDirectory ? "directory" : ""} ${selectedFile?.path === file.path ? "selected" : ""} ${selectedFilePaths.has(file.path) ? "bulk-selected" : ""}`}
                            onClick={(e) => {
                              if (dragCompletedRef.current) {
                                dragCompletedRef.current = false;
                                return;
                              }
                              if (file.isDirectory) {
                                clearFileSelection();
                                return;
                              }
                              if (e.ctrlKey || e.metaKey) {
                                toggleFileSelection(file.path);
                              } else {
                                setSelectedFilePaths(new Set([file.path]));
                                void selectFile(file);
                              }
                            }}
                            onDoubleClick={() =>
                              file.isDirectory
                                ? navigateToPath(file.path)
                                : openMediaViewer(file)
                            }
                          >
                            <td className="name-cell">
                              {file.isDirectory ? <FiFolder /> : <FiFile />}
                              {file.name}
                              {!file.isDirectory && (
                                <button
                                  className={`favorite-toggle inline ${favoritePaths.has(file.path) ? "active" : ""}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void toggleFavorite(file.path);
                                  }}
                                  title={
                                    favoritePaths.has(file.path)
                                      ? "Remove from Favorites"
                                      : "Add to Favorites"
                                  }
                                >
                                  <FiHeart />
                                </button>
                              )}
                            </td>
                            <td title={file.path}>{file.relativePath}</td>
                            <td>{file.sourceLabel || "Local"}</td>
                            <td>
                              {file.isDirectory
                                ? "-"
                                : formatFileSize(file.size)}
                            </td>
                            <td>
                              {file.isDirectory
                                ? "Folder"
                                : fileTypeLabels[file.type] || "Other"}
                            </td>
                            <td>{formatDate(file.modified)}</td>
                            {searchQuery.trim() && (
                              <>
                                <td>
                                  {(file as SemanticSearchResult)._source ||
                                    "Semantic match"}
                                </td>
                                <td>
                                  {Number.isFinite(
                                    (file as SemanticSearchResult).confidence,
                                  )
                                    ? `${Math.round((file as SemanticSearchResult).confidence!)}%`
                                    : "Text match"}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })()
                    ),
                  )}
                </tbody>
              </table>
            ) : (
              <div className="file-grid" ref={fileGridRef}>
                {displayItems.map((item) =>
                  item.kind === "year" ? (
                    <div
                      key={`year-${item.year}`}
                      className="file-year-grid-row"
                    >
                      <button
                        className="file-year-toggle"
                        aria-expanded={expandedYears.has(item.year)}
                        onClick={() =>
                          setExpandedYears((current) => {
                            const next = new Set(current);
                            if (next.has(item.year)) next.delete(item.year);
                            else next.add(item.year);
                            return next;
                          })
                        }
                      >
                        {expandedYears.has(item.year) ? (
                          <FiChevronDown />
                        ) : (
                          <FiChevronRight />
                        )}
                        <strong>{item.year}</strong>
                        <span>
                          {item.count.toLocaleString()} files
                          {expandedYears.has(item.year) &&
                          item.count >
                            (yearDisplayLimits[item.year] ?? yearPageSize)
                            ? ` · ${Math.min(item.count, yearDisplayLimits[item.year] ?? yearPageSize).toLocaleString()} displayed`
                            : ""}
                        </span>
                      </button>
                    </div>
                  ) : item.kind === "more" ? (
                    <div
                      key={`more-${item.year}`}
                      className="file-year-more-grid-row"
                    >
                      <button
                        onClick={() =>
                          setYearDisplayLimits((current) => ({
                            ...current,
                            [item.year]:
                              (current[item.year] ?? yearPageSize) +
                              Math.min(500, item.count),
                          }))
                        }
                      >
                        Load {Math.min(500, item.count).toLocaleString()} more from {item.year}
                      </button>
                    </div>
                  ) : (
                    (() => {
                      const file = item.file;
                      return (
                        <div
                          key={fileListKey(file)}
                          data-file-path={file.path}
                          data-file-type={file.type}
                          data-directory={file.isDirectory ? "true" : "false"}
                          className={`file-card ${file.isDirectory ? "directory" : ""} ${selectedFile?.path === file.path ? "selected" : ""} ${selectedFilePaths.has(file.path) ? "bulk-selected" : ""}`}
                          onClick={(e) => {
                            if (dragCompletedRef.current) {
                              dragCompletedRef.current = false;
                              return;
                            }
                            if (file.isDirectory) {
                              clearFileSelection();
                              return;
                            }
                            if (e.ctrlKey || e.metaKey) {
                              toggleFileSelection(file.path);
                            } else {
                              setSelectedFilePaths(new Set([file.path]));
                              void selectFile(file);
                            }
                          }}
                          onDoubleClick={() =>
                            file.isDirectory
                              ? navigateToPath(file.path)
                              : openMediaViewer(file)
                          }
                        >
                          {!file.isDirectory && (
                            <button
                              className={`favorite-toggle ${favoritePaths.has(file.path) ? "active" : ""}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void toggleFavorite(file.path);
                              }}
                              title={
                                favoritePaths.has(file.path)
                                  ? "Remove from Favorites"
                                  : "Add to Favorites"
                              }
                            >
                              <FiHeart />
                            </button>
                          )}
                          {!file.isDirectory && (
                            <input
                              type="checkbox"
                              className="file-card-checkbox"
                              checked={selectedFilePaths.has(file.path)}
                              onChange={() => toggleFileSelection(file.path)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          )}
                          <FileThumbnail
                            file={file}
                            onOpen={() => {
                              setSelectedFilePaths(new Set([file.path]));
                              void openMediaViewer(file);
                            }}
                            onThumbnailLoaded={markThumbnailLoaded}
                            onAddPeople={
                              file.type === "image"
                                ? () => void openFaceAssignment(file)
                                : undefined
                            }
                            thumbnailSize={GRID_THUMBNAIL_SIZE}
                          />
                          {magicBadge(file.path)}
                          <div className="info">
                            <h4 title={file.name}>{file.name}</h4>
                            <p className="size">
                              {file.isDirectory
                                ? "Folder"
                                : formatFileSize(file.size)}
                            </p>
                            <p className="type">
                              {file.isDirectory
                                ? "Folder"
                                : fileTypeLabels[file.type] || "Other"}
                            </p>
                            {file.sourceLabel && (
                              <p
                                className="file-source"
                                title={file.sourceLabel}
                              >
                                {file.sourceLabel}
                              </p>
                            )}
                            {searchQuery.trim() && (
                              <p className="confidence">
                                {Number.isFinite(
                                  (file as SemanticSearchResult).confidence,
                                )
                                  ? `${Math.round((file as SemanticSearchResult).confidence!)}% match`
                                  : "Text match"}
                                {(file as SemanticSearchResult)._source &&
                                  ` • ${(file as SemanticSearchResult)._source}`}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })()
                  ),
                )}
              </div>
            )}
            {searchQuery.trim() &&
            filteredAndSortedFiles.length > displayLimit ? (
              <div className="load-more-container">
                <p className="results-info">
                  {displayLimit.toLocaleString()} of{" "}
                  {filteredAndSortedFiles.length.toLocaleString()} search results shown
                </p>
                <button
                  className="load-more"
                  onClick={() =>
                    setDisplayLimit((limit) =>
                      limit +
                      Math.min(500, filteredAndSortedFiles.length - limit),
                    )
                  }
                >
                  Load {Math.min(
                    500,
                    filteredAndSortedFiles.length - displayLimit,
                  ).toLocaleString()} more results
                </button>
              </div>
            ) : !searchQuery.trim() &&
              yearSections.folders.length < yearSections.allFolders.length && (
              <div className="load-more-container">
                <p className="results-info">
                  {yearSections.folders.length.toLocaleString()} of{" "}
                  {yearSections.allFolders.length.toLocaleString()} folders
                  shown
                </p>
                <button
                  className="load-more"
                  onClick={() =>
                    setDisplayLimit((limit) =>
                      limit +
                      Math.min(500, yearSections.allFolders.length - limit),
                    )
                  }
                >
                  Load {Math.min(
                    500,
                    yearSections.allFolders.length - displayLimit,
                  ).toLocaleString()} more folders
                </button>
              </div>
            )}
          </div>

          {!audioOnlySelected && filePreview && (
            <aside className="preview-panel">
              <h3>File Details</h3>
              <div className="preview-content">
                {filePreview.documentPreview && selectedFile && (
                  <>
                    <DocumentViewer
                      key={filePreview.path}
                      document={filePreview.documentPreview}
                      name={filePreview.name}
                      compact
                    />
                    <button
                      className="preview-action-button"
                      onClick={() => void openMediaViewer(selectedFile)}
                    >
                      Open document preview
                    </button>
                  </>
                )}
                {filePreview.previewDataUrl && selectedFile && (
                  <button
                    className="preview-image-button"
                    onClick={() => openMediaViewer(selectedFile)}
                    title="Open large preview"
                  >
                    <img
                      className="image-preview"
                      src={filePreview.previewDataUrl}
                      alt={filePreview.name}
                    />
                  </button>
                )}
                <div className="preview-item">
                  <strong>Name</strong>
                  <span>{filePreview.name}</span>
                </div>
                <div className="preview-item">
                  <strong>Size</strong>
                  <span>{formatFileSize(filePreview.size)}</span>
                </div>
                <div className="preview-item">
                  <strong>Type</strong>
                  <span>{filePreview.extension || "Unknown"}</span>
                </div>
                <div className="preview-item">
                  <strong>Modified</strong>
                  <span>{filePreview.modified}</span>
                </div>
                {selectedFile && (
                  <div className="preview-item">
                    <strong>Library year</strong>
                    <span>
                      {modifiedYear({
                        ...selectedFile,
                        year: fileMetadata[selectedFile.path]?.year,
                      })}
                    </span>
                    <button
                      onClick={() => editYear([selectedFile.path])}
                      title="Edit library year"
                    >
                      Edit year
                    </button>
                  </div>
                )}
                <div className="preview-item">
                  <strong>Path</strong>
                  <span className="path-text">{filePreview.path}</span>
                </div>
                {selectedFile && (
                  <>
                    <button
                      className="preview-action-button save-to-device"
                      onClick={() => saveSelectedFileToDevice()}
                      title="Save this file to a location on your device"
                    >
                      <FiDownload /> Save to Device
                    </button>
                    {selectedFile.type === "image" && (
                      <button
                        className="preview-action-button ban-content"
                        onClick={() => {
                          openDialog({
                            mode: "text",
                            title: "Ban this content",
                            message: "Enter banned-people, explicit, or other.",
                            initialValue: "banned-people",
                            placeholder: "Reason",
                            confirmLabel: "Continue",
                            onConfirm: async (reason) => {
                              setHistoryToast(
                                reason === "banned-people"
                                  ? "Use Settings → Hidden Faces to manage banned people."
                                  : `“${reason}” content filtering is not yet connected.`,
                              );
                              window.setTimeout(
                                () => setHistoryToast(""),
                                5000,
                              );
                            },
                          });
                        }}
                        title="Ban this content from appearing"
                      >
                        <FiEyeOff /> Ban Content
                      </button>
                    )}
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
        </div>
      )}
      </div>

      <footer className="app-footer">
        <div className="app-footer-branding">
          <span className="app-footer-product">solo: <strong>Silo</strong></span>
          <span className="app-footer-copyright">© 2026 Silo</span>
        </div>
        <nav aria-label="Silo links">
          <a href="https://trysilo.kolektivkrog.si/" target="_blank" rel="noreferrer">
            TrySilo <span aria-hidden="true">↗</span>
          </a>
          <a href="https://silohelp.kolektivkrog.si/" target="_blank" rel="noreferrer">
            Docs <span aria-hidden="true">↗</span>
          </a>
          <a href="https://github.com/ilovespectra/Silo" target="_blank" rel="noreferrer">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </footer>
        </div>
      </div>

      {showFolderSelector && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFolderSelector();
          }}
        >
          <div className="folder-selector-modal">
            <div className="folder-selector-header">
              <h3>
                {folderSelectorFilePaths.length > 0
                  ? `Add ${folderSelectorFilePaths.length} photo${folderSelectorFilePaths.length === 1 ? "" : "s"} to:`
                  : "Add to digital folder"}
              </h3>
              <button
                className="close-btn"
                onClick={closeFolderSelector}
                title="Close folder picker"
                aria-label="Close folder picker"
              >
                <FiX />
              </button>
            </div>
            <div className="folder-list">
              {digitalFolders.map((folder) => (
                <button
                  key={folder.id}
                  className="folder-option"
                  onClick={() => {
                    void addFilesToFolder(folder.id, folderSelectorFilePaths);
                  }}
                >
                  <FiFolder /> {folder.name}{" "}
                  <small>({folder.filePaths.length})</small>
                </button>
              ))}
              <button
                className="folder-option new-folder"
                onClick={() => {
                  const filePaths = folderSelectorFilePaths;
                  closeFolderSelector();
                  openDialog({
                    mode: "text",
                    title: "New digital folder",
                    message: "Create a new digital folder to add files to.",
                    placeholder: "Folder name",
                    confirmLabel: "Create folder",
                    onConfirm: async (name) => {
                      const result =
                        await electronAPI?.createDigitalFolder(name);
                      if (result) {
                        applyPersistedState(result);
                        const newFolder =
                          result.digitalFolders[
                            result.digitalFolders.length - 1
                          ];
                        if (newFolder) {
                          void addFilesToFolder(newFolder.id, filePaths);
                        }
                      }
                    },
                  });
                }}
              >
                <FiPlus /> Create new folder
              </button>
            </div>
          </div>
        </div>
      )}

      {dialogRequest && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <form
            className="app-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeDialog();
              }
            }}
          >
            <h2 id="app-dialog-title">{dialogRequest.title}</h2>
            {dialogRequest.message && <p>{dialogRequest.message}</p>}
            {dialogRequest.mode === "text" && (
              <input
                autoFocus
                value={dialogValue}
                onChange={(event) => setDialogValue(event.target.value)}
                placeholder={dialogRequest.placeholder}
                disabled={dialogBusy}
              />
            )}
            {dialogError && <div className="dialog-error">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" onClick={closeDialog} disabled={dialogBusy}>
                Cancel
              </button>
              <button
                type="submit"
                className={
                  dialogRequest.destructive ? "destructive" : "primary"
                }
                disabled={dialogBusy}
              >
                {dialogBusy ? "Working..." : dialogRequest.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          settings={contentSettings}
          mapServicesAllowed={mapServicesAllowed}
          onMapServicesAllowedChange={saveMapServiceConsent}
          showHiddenMessages={showHiddenMessages}
          onShowHiddenMessagesChange={(show) =>
            void updateHiddenMessageVisibility(show)
          }
          onChange={setContentSettings}
          focusTarget={settingsTourTarget}
          onClose={() => {
            setShowSettings(false);
            setSettingsTourTarget(null);
          }}
          onOpenBugReport={() => setShowBugReport(true)}
          hideSettingsForScreenshot={selectingBugReportScreenshot}
          lifetimePromptRequest={lifetimePromptRequest}
          onLifetimePromptHandled={acknowledgeLifetimePrompt}
        />
      )}

      {!showBugReport && !selectingBugReportScreenshot && (
        <button
          className="bug-report-launcher"
          type="button"
          aria-label="Report a Bug"
          title="Report a Bug"
          onClick={() => setShowBugReport(true)}
        >
          <FaBug aria-hidden="true" />
        </button>
      )}
      {showBugReport && (
        <BugReportDialog
          diagnosticReport={indexingDiagnosticReport}
          onClose={() => {
            if (indexingDiagnosticReport)
              void electronAPI.dismissDiagnosticReport(indexingDiagnosticReport.id);
            setIndexingDiagnosticReport(null);
            setShowBugReport(false);
            setSelectingBugReportScreenshot(false);
          }}
          onScreenshotSelectionChange={(selecting) => {
            setSelectingBugReportScreenshot(selecting);
            if (selecting) setShowSettings(false);
          }}
          onSubmitted={handleBugReportSubmitted}
        />
      )}

      {showLocalHelp && (
        <LocalHelpPanel
          onClose={() => setShowLocalHelp(false)}
          onStartTour={startGuidedTour}
          onShowInApp={(step) => {
            const contextStep: GuidedTourStep = {
              id: `help-${step.id}`,
              title: step.title,
              body: step.answer,
              target: step.target,
              fallbackTarget: step.fallbackTarget,
              section: step.section,
            };
            setTourContextStep(contextStep);
            setShowLocalHelp(false);
            setShowGuidedTour(true);
          }}
        />
      )}

      {GOOGLE_FEATURES_ENABLED && electronAPI && googleReclaimAccountId && (() => {
        const account = googleState?.accounts.find((item) => item.id === googleReclaimAccountId);
        return account ? (
          <GoogleReclaimDialog
            api={electronAPI}
            account={account}
            onReconnect={() => {
              setGoogleReclaimAccountId(null);
              void googleAddAccount();
            }}
            onClose={() => setGoogleReclaimAccountId(null)}
          />
        ) : null;
      })()}

      <GuidedTour
        open={showGuidedTour}
        showAtStartup={showTourAtStartup}
        contextStep={tourContextStep}
        onShowAtStartupChange={updateShowTourAtStartup}
        onNavigate={navigateGuidedTour}
        onClose={closeGuidedTour}
      />
      {showTourExitConfirm && (
        <div className="tour-exit-backdrop" role="presentation">
          <section
            className="tour-exit-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="tour-exit-title"
            aria-describedby="tour-exit-description"
          >
            <h2 id="tour-exit-title">Skip the tour while Silo starts?</h2>
            <p id="tour-exit-description">
              Silo can take a while to start, especially when you have many
              sources. The tour can keep you busy while your library loads.
            </p>
            <div>
              <button
                className="settings-save"
                onClick={() => {
                  setShowTourExitConfirm(false);
                  setShowGuidedTour(true);
                }}
              >
                Take the tour
              </button>
              <button
                className="settings-secondary"
                onClick={() => setShowTourExitConfirm(false)}
              >
                No way, I’ll wait
              </button>
            </div>
          </section>
        </div>
      )}
      {showBugThanks && (
        <div className="bug-report-thanks-backdrop" role="presentation">
          <section
            className="bug-report-thanks"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-report-thanks-title"
          >
            <button
              type="button"
              className="bug-report-thanks-close"
              aria-label="Close thank-you message"
              onClick={() => {
                if (hideBugThanksNextTime)
                  localStorage.setItem("silo.hideBugReportThanks", "true");
                setShowBugThanks(false);
              }}
            >
              <FiX />
            </button>
            <FiCheck className="bug-report-thanks-check" aria-hidden="true" />
            <h2 id="bug-report-thanks-title">Thanks for reporting a bug</h2>
            <p>Keep taking a look around and enjoy Silo.</p>
            <label>
              <input
                type="checkbox"
                checked={hideBugThanksNextTime}
                onChange={(event) =>
                  setHideBugThanksNextTime(event.target.checked)
                }
              />
              Don’t show this thank-you again
            </label>
            <button
              className="settings-save"
              onClick={() => {
                if (hideBugThanksNextTime)
                  localStorage.setItem("silo.hideBugReportThanks", "true");
                setShowBugThanks(false);
              }}
            >
              Keep exploring
            </button>
          </section>
        </div>
      )}
      {showBugReportToast && (
        <div
          className={`bug-report-sent-toast${bugReportToastFading ? " fading" : ""}`}
          role="status"
          aria-live="polite"
        >
          <FiCheck aria-hidden="true" /> Report sent!
          <button
            type="button"
            aria-label="Dismiss report sent message"
            onClick={() => setShowBugReportToast(false)}
          >
            <FiX />
          </button>
        </div>
      )}
      <InteractiveTooltip />

      {profilePicturePicker && viewerOpen && (
        <PersonPicker
          photoPaths={[]}
          anchor={profilePicturePicker}
          title="Set profile picture · adds this photo if needed"
          pickLabel="Choose a person"
          onClose={() => setProfilePicturePicker(null)}
          onPick={(person) =>
            void setPreviewProfilePicture(
              person.id,
              profilePicturePicker.photoPath,
            )
          }
        />
      )}

      <div
        className="media-library-host"
        aria-hidden={appSection !== "files" || (!audioOnlySelected && !videoOnlySelected)}
        style={{
          top: mediaHostBounds?.top ?? 0,
          left: mediaHostBounds?.left ?? 0,
          width: mediaHostBounds?.width ?? 0,
          height: mediaHostBounds?.height ?? 0,
          visibility: appSection === "files" && (audioOnlySelected || videoOnlySelected) && mediaHostBounds ? "visible" : "hidden",
        }}
      >
        {electronAPI && <div
          className="media-player-slot"
          hidden={!(appSection === "files" && audioOnlySelected)}
        >
          <AudioLibrary
            electronAPI={electronAPI}
            visible={appSection === "files" && audioOnlySelected}
            exploded={exploded}
            yearFilter={yearFilter}
            sort={audioSort}
            favoritePaths={favoritePaths}
            playlists={mediaPlaylists}
            onAudioYearsChange={setAudioYearOptions}
            onToggleFavorite={(filePath) => void toggleFavorite(filePath)}
            onCreatePlaylist={createMediaPlaylist}
            onAddToPlaylist={addToMediaPlaylist}
            onRemoveFromPlaylist={removeFromMediaPlaylist}
            onDeletePlaylist={deleteMediaPlaylist}
          />
        </div>}
        {electronAPI && <div
          className="media-player-slot"
          hidden={!(appSection === "files" && videoOnlySelected)}
        >
          <VideoTheatre
            electronAPI={electronAPI}
            visible={appSection === "files" && videoOnlySelected}
            files={filteredAndSortedFiles.filter((file) => !file.isDirectory && file.type === "video")}
            playlists={mediaPlaylists}
            favoritePaths={favoritePaths}
            fileMetadata={fileMetadata}
            onToggleFavorite={(filePath) => void toggleFavorite(filePath)}
            onCreatePlaylist={createMediaPlaylist}
            onAddToPlaylist={addToMediaPlaylist}
            onRemoveFromPlaylist={removeFromMediaPlaylist}
            onDeletePlaylist={deleteMediaPlaylist}
            onEditMetadata={editVideoMetadata}
          />
        </div>}
      </div>

      {viewerOpen && selectedFile && (
        <div
          className="image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={selectedFile.name}
        >
          <div className="viewer-toolbar">
            <span className="viewer-title" title={selectedFile.name}>
              {selectedFile.name}
              {viewerIsLivePhoto && (
                <span className="live-photo-badge">Live Photo</span>
              )}
            </span>
            <div className="viewer-actions">
              <button
                onClick={() => editYear([selectedFile.path])}
                title="Edit library year"
                aria-label="Edit library year"
              >
                <FiEdit3 />
              </button>
              {selectedFile.type === "image" && (
                <button
                  className={
                    personDetail?.selectedCoverPhotoPath === selectedFile.path
                      ? "active"
                      : ""
                  }
                  disabled={profilePictureBusy}
                  onClick={(event) => {
                    if (appSection === "people" && personDetail) {
                      void setPreviewProfilePicture(
                        personDetail.id,
                        selectedFile.path,
                      );
                    } else {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setProfilePicturePicker({
                        x: rect.left,
                        y: rect.bottom + 6,
                        photoPath: selectedFile.path,
                      });
                    }
                  }}
                  title={profilePictureBusy ? "Saving…" : "Set pfp"}
                  aria-label="Set profile picture"
                >
                  <FiStar />
                </button>
              )}
              <button
                className={`viewer-favorite ${favoritePaths.has(selectedFile.path) ? "active" : ""}`}
                onClick={() => void toggleFavorite(selectedFile.path)}
                title={
                  favoritePaths.has(selectedFile.path)
                    ? "Remove from Favorites"
                    : "Add to Favorites"
                }
              >
                <FiHeart />
              </button>
              {selectedFile.type === "image" && !viewerIsLivePhoto && (
                <>
                  <button
                    className={faceAssignmentActive ? "active" : ""}
                    onClick={() =>
                      faceAssignmentActive
                        ? closeFaceAssignment()
                        : void openFaceAssignment(selectedFile)
                    }
                    title="Add people to this photo"
                    aria-label="Add people to this photo"
                  >
                    <FiUsers />
                  </button>
                  <button
                    onClick={() => {
                      setViewerFit(false);
                      setViewerZoom((zoom) => Math.max(zoom - 0.25, 0.05));
                    }}
                    title="Zoom out"
                  >
                    <FiZoomOut />
                  </button>
                  <button
                    className="zoom-value"
                    onClick={() => {
                      if (viewerFit) {
                        setViewerFit(false);
                        setViewerZoom(1);
                      } else {
                        setViewerFit(true);
                      }
                    }}
                    title={
                      viewerFit ? "View at actual size" : "Fit image to window"
                    }
                  >
                    {viewerFit ? "Fit" : `${Math.round(viewerZoom * 100)}%`}
                  </button>
                  <button
                    onClick={() => {
                      setViewerFit(false);
                      setViewerZoom((zoom) => Math.min(zoom + 0.25, 4));
                    }}
                    title="Zoom in"
                  >
                    <FiZoomIn />
                  </button>
                </>
              )}
              <button
                onClick={() => openFolderSelector(selectedFile.path)}
                title="Add to a digital folder"
              >
                <FiPlus />
              </button>
              {selectedFile.type !== "image" && (
                <button
                  onClick={() => saveSelectedFileToDevice()}
                  title="Save to device"
                >
                  <FiDownload />
                </button>
              )}
            </div>
            <button
              className="viewer-close"
              onClick={() => setViewerOpen(false)}
              title="Close preview"
              aria-label="Close preview"
            >
              <FiX aria-hidden="true" />
            </button>
          </div>
          {profilePictureNotice && (
            <div className="viewer-profile-notice" role="status">
              {profilePictureNotice}
            </div>
          )}
          <button
            className="viewer-nav viewer-previous"
            onClick={() => navigateViewer(-1)}
            disabled={selectedViewerIndex <= 0}
            title="Previous"
          >
            <FiChevronLeft />
          </button>
          <div
            className="viewer-stage"
            ref={viewerStageRef}
            onWheel={(event) => {
              const isImagePreview = Boolean(
                filePreview?.previewDataUrl &&
                  !filePreview.documentPreview &&
                  viewerPlaybackFile?.type !== "audio" &&
                  viewerPlaybackFile?.type !== "video",
              );
              if (!event.ctrlKey || !isImagePreview || faceAssignmentActive) return;
              event.preventDefault();
              const currentScale = viewerFit ? fittedImageScale : viewerZoom;
              const scaleFactor = Math.exp(-event.deltaY * 0.002);
              setViewerFit(false);
              setViewerZoom(
                Math.max(0.05, Math.min(4, currentScale * scaleFactor)),
              );
            }}
            onDoubleClick={() => {
              setViewerFit((fit) => !fit);
              setViewerZoom(1);
            }}
          >
            {viewerImageLoading && filePreview?.previewDataUrl && (
              <div
                className="viewer-image-loading"
                role="status"
                aria-live="polite"
              >
                <span className="viewer-image-loading-spinner" />
                Preparing photo…
              </div>
            )}
            {!filePreview ? (
              <div className="viewer-status preview-loading">Loading preview...</div>
            ) : filePreview.documentPreview ? (
              <DocumentViewer
                key={filePreview.path}
                document={filePreview.documentPreview}
                name={filePreview.name}
              />
            ) : viewerPlaybackFile?.type === "audio" ||
              viewerPlaybackFile?.type === "video" ? (
              <div className={`media-player ${viewerPlaybackFile.type}`}>
                {viewerPlaybackFile.type === "audio" ? (
                  <audio
                    key={filePreview.path}
                    ref={(element) => {
                      mediaElementRef.current = element;
                    }}
                    autoPlay
                    loop={mediaLoop}
                    muted={mediaMuted}
                    onLoadedMetadata={(event) => {
                      event.currentTarget.volume = mediaVolume;
                      setMediaDuration(event.currentTarget.duration || 0);
                    }}
                    onTimeUpdate={(event) =>
                      setMediaCurrentTime(event.currentTarget.currentTime)
                    }
                    onPlay={() => setMediaPlaying(true)}
                    onPause={() => setMediaPlaying(false)}
                    onError={() =>
                      setMediaError("This media could not be played.")
                    }
                  >
                    <source
                      src={
                        filePreview.mediaUrl || filePreview.previewDataUrl || ""
                      }
                      type={filePreview.playbackMimeType || undefined}
                    />
                  </audio>
                ) : (
                  <video
                    key={filePreview.path}
                    ref={(element) => {
                      mediaElementRef.current = element;
                    }}
                    autoPlay
                    loop={mediaLoop}
                    muted={mediaMuted}
                    playsInline
                    style={{
                      width: viewerFit
                        ? "auto"
                        : `${viewerDimensions.width * viewerZoom}px`,
                      height: viewerFit
                        ? "auto"
                        : `${viewerDimensions.height * viewerZoom}px`,
                      maxWidth: viewerFit ? "100%" : "none",
                      maxHeight: viewerFit ? "calc(100vh - 168px)" : "none",
                    }}
                    onLoadedMetadata={(event) => {
                      const videoElement = event.currentTarget;
                      videoElement.volume = mediaVolume;
                      setMediaDuration(videoElement.duration || 0);
                      setViewerDimensions({
                        width: videoElement.videoWidth,
                        height: videoElement.videoHeight,
                      });
                    }}
                    onTimeUpdate={(event) =>
                      setMediaCurrentTime(event.currentTarget.currentTime)
                    }
                    onPlay={() => setMediaPlaying(true)}
                    onPause={() => setMediaPlaying(false)}
                    onError={() =>
                      setMediaError("This video could not be played.")
                    }
                  >
                    <source
                      src={
                        filePreview.mediaUrl || filePreview.previewDataUrl || ""
                      }
                      type={filePreview.playbackMimeType || undefined}
                    />
                  </video>
                )}
                <div className="media-controls">
                  <button
                    onClick={() => {
                      const media = mediaElementRef.current;
                      if (!media) return;
                      if (media.paused) {
                        void media.play().catch((error) => {
                          setMediaError(
                            error instanceof Error
                              ? error.message
                              : "This media could not be played.",
                          );
                        });
                      } else media.pause();
                    }}
                    title={mediaPlaying ? "Pause" : "Play"}
                  >
                    {mediaPlaying ? <FiPause /> : <FiPlay />}
                  </button>
                  <span className="media-time">
                    {formatMediaTime(mediaCurrentTime)}
                  </span>
                  <input
                    className="media-seek"
                    type="range"
                    min="0"
                    max={Math.max(mediaDuration, 0)}
                    step="0.1"
                    value={Math.min(mediaCurrentTime, mediaDuration || 0)}
                    onChange={(event) => {
                      const nextTime = Number(event.target.value);
                      if (mediaElementRef.current)
                        mediaElementRef.current.currentTime = nextTime;
                      setMediaCurrentTime(nextTime);
                    }}
                    aria-label="Playback position"
                  />
                  <span className="media-time">
                    {formatMediaTime(mediaDuration)}
                  </span>
                  <button
                    className={mediaLoop ? "active" : ""}
                    onClick={() => setMediaLoop((loop) => !loop)}
                    title={mediaLoop ? "Disable looping" : "Enable looping"}
                  >
                    <FiRepeat />
                  </button>
                  <button
                    onClick={() => setMediaMuted((muted) => !muted)}
                    title={mediaMuted ? "Unmute" : "Mute"}
                  >
                    {mediaMuted ? <FiVolumeX /> : <FiVolume2 />}
                  </button>
                  <input
                    className="media-volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={mediaMuted ? 0 : mediaVolume}
                    onChange={(event) => {
                      const nextVolume = Number(event.target.value);
                      setMediaVolume(nextVolume);
                      setMediaMuted(nextVolume === 0);
                      if (mediaElementRef.current) {
                        mediaElementRef.current.volume = nextVolume;
                        mediaElementRef.current.muted = nextVolume === 0;
                      }
                    }}
                    aria-label="Volume"
                  />
                </div>
                {mediaError && <div className="media-error">{mediaError}</div>}
              </div>
            ) : filePreview.previewDataUrl ? (
              <div
                key={filePreview.path}
                className={`viewer-image-wrap ${faceAssignmentActive ? "face-box-editing" : ""}`}
                style={{
                  width:
                    viewerDimensions.width > 0
                      ? `${viewerDimensions.width * (viewerFit ? fittedImageScale : viewerZoom)}px`
                      : undefined,
                  maxWidth: viewerFit ? "100%" : "none",
                }}
                onPointerDown={
                  faceAssignmentActive ? beginFaceCreation : undefined
                }
                onPointerMove={
                  faceAssignmentActive ? updateFaceCreation : undefined
                }
                onPointerUp={
                  faceAssignmentActive
                    ? (event) => void finishFaceCreation(event)
                    : undefined
                }
                onPointerCancel={
                  faceAssignmentActive
                    ? (event) => void finishFaceCreation(event)
                    : undefined
                }
              >
                <img
                  src={filePreview.previewDataUrl}
                  alt={filePreview.name}
                  onLoad={(event) =>
                    setViewerDimensions({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    })
                  }
                  style={{
                    width: viewerDimensions.width > 0 ? "100%" : "auto",
                    height: "auto",
                    maxWidth: "100%",
                  }}
                />
                {faceCreationBox && (
                  <div
                    className="face-assignment-create-box"
                    style={{
                      left: `${faceCreationBox.x * 100}%`,
                      top: `${faceCreationBox.y * 100}%`,
                      width: `${faceCreationBox.width * 100}%`,
                      height: `${faceCreationBox.height * 100}%`,
                    }}
                  />
                )}
                {faceAssignmentActive &&
                  faceAssignmentFaces.map((face, index) => {
                    const target = faceAssignmentTargets[face.id];
                    const selectedName = target?.personId
                      ? people.find((person) => person.id === target.personId)?.name
                      : target?.newName.trim();
                    const assignedNames = face.personIds
                      .map((id) => people.find((person) => person.id === id)?.name)
                      .filter((name): name is string => Boolean(name));
                    const visibleName = selectedName || assignedNames.join(", ") || "Choose person";
                    return (
                      <div
                        key={face.id}
                        className={`face-assignment-box ${faceAssignmentSelectedId === face.id ? "selected" : ""} ${face.personIds.length ? "assigned" : ""}`}
                        style={{
                          left: `${face.box.x * 100}%`,
                          top: `${face.box.y * 100}%`,
                          width: `${face.box.width * 100}%`,
                          height: `${face.box.height * 100}%`,
                        }}
                        role="button"
                        tabIndex={0}
                        onPointerDown={(event) => beginFaceBoxDrag(event, face)}
                        onPointerMove={moveFaceBox}
                        onPointerUp={(event) => void finishFaceBoxDrag(event)}
                        onPointerCancel={(event) => void finishFaceBoxDrag(event)}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setFaceAssignmentSelectedId(face.id);
                          setFaceAssignmentError("");
                        }}
                        title={`Face ${index + 1}: ${visibleName}`}
                      >
                        <span className="face-assignment-label">
                          <span className="face-assignment-label-number">{index + 1}</span>
                          <span className="face-assignment-label-names">{visibleName}</span>
                        </span>
                        <button
                          className="face-assignment-delete"
                          type="button"
                          disabled={faceAssignmentBusy}
                          aria-label="Delete detected face record only"
                          title="Delete detected face record only"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            void deleteDetectedFace(face.id);
                          }}
                        >
                          <FiX />
                        </button>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="viewer-status">
                Preview unavailable for this item.
              </div>
            )}
          </div>
          {faceAssignmentActive && selectedFile.type === "image" && (
            <section
              className="face-assignment-panel"
              aria-label="Add people to photo"
            >
              <header>
                <strong>Add people to photo</strong>
                <button
                  onClick={closeFaceAssignment}
                  title="Close face assignment"
                >
                  <FiX />
                </button>
              </header>
              <p>
                {faceAssignmentFaces.length
                  ? "Drag a box to adjust it. Shift-drag on the photo to add every missed face. Choose a person or enter a name for each box, then save them together."
                  : "No face boxes yet. Shift-drag around each face to add it. Then choose a person or enter a name for every box."}
              </p>
              {faceAssignmentFaces.length > 0 && (
                <div className="face-assignment-targets">
                  {faceAssignmentFaces.map((face, index) => {
                    const target = faceAssignmentTargets[face.id] ?? {
                      personId: "",
                      newName: "",
                    };
                    return (
                      <div className="face-assignment-target" key={face.id}>
                        <label htmlFor={`face-person-${face.id}`}>
                          Face {index + 1}
                          <span>
                            {face.hasDescriptor
                              ? "Recognition ready"
                              : "Box only · not usable for training"}
                          </span>
                        </label>
                        <select
                          id={`face-person-${face.id}`}
                          value={target.personId}
                          disabled={faceAssignmentBusy}
                          onChange={(event) =>
                            setFaceAssignmentTargets((current) => ({
                              ...current,
                              [face.id]: {
                                personId: event.target.value,
                                newName: "",
                              },
                            }))
                          }
                        >
                          <option value="">Create a new person…</option>
                          {people.map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.name}
                              {person.status === "banned" ? " · banned" : ""}
                            </option>
                          ))}
                        </select>
                        {!target.personId && (
                          <input
                            value={target.newName}
                            disabled={faceAssignmentBusy}
                            onChange={(event) =>
                              setFaceAssignmentTargets((current) => ({
                                ...current,
                                [face.id]: {
                                  personId: "",
                                  newName: event.target.value,
                                },
                              }))
                            }
                            placeholder={`Name for face ${index + 1}`}
                            aria-label={`Name for face ${index + 1}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {faceAssignmentError && (
                <small className="face-assignment-error">
                  {faceAssignmentError}
                </small>
              )}
              {faceAssignmentFaces.length > 0 && (
                <button
                  className="primary"
                  disabled={
                    faceAssignmentBusy ||
                    faceAssignmentFaces.some((face) => {
                      const target = faceAssignmentTargets[face.id];
                      return !target?.personId && !target?.newName.trim();
                    })
                  }
                  onClick={() => void saveFaceAssignments()}
                >
                  {faceAssignmentBusy
                    ? "Saving…"
                    : `Save all ${faceAssignmentFaces.length} face assignments`}
                </button>
              )}
            </section>
          )}
          <button
            className="viewer-nav viewer-next"
            onClick={() => navigateViewer(1)}
            disabled={selectedViewerIndex >= viewerImages.length - 1}
            title="Next"
          >
            <FiChevronRight />
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
