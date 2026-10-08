import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { DEFAULT_SEMANTIC_SEARCH_CONFIDENCE } from "./searchSettings";
import {
  FiArrowUp,
  FiCheck,
  FiChevronDown,
  FiChevronLeft,
  FiChevronRight,
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
  FiMap,
  FiMapPin,
  FiMove,
  FiPause,
  FiPlay,
  FiPlus,
  FiRefreshCw,
  FiRewind,
  FiRepeat,
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
  refreshThumbnail,
  subscribeThumbnail,
  thumbnailCache,
  thumbnailCacheKey,
} from "./utils/thumbnailCache";
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
import PhoneManagerPanel from "./components/PhoneManagerPanel";
import AudioLibrary from "./components/AudioLibrary";
import IndexingPanel from "./components/IndexingPanel";
import SourceClonePanel from "./components/SourceClonePanel";
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
  autoplayGlobe: false,
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
  onThumbnailLoaded?: (filePath: string) => void;
  onAddPeople?: () => void;
  thumbnailSize?: number;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [thumbnail, setThumbnail] = useState(
    () =>
      thumbnailCache.peek(thumbnailCacheKey(file.path, thumbnailSize)) || null,
  );
  const isPreviewable = file.type === "image" || file.type === "video";
  const indicators = usePhotoIndicator(file.path, isPreviewable);

  useEffect(
    () => subscribeThumbnail(file.path, setThumbnail, thumbnailSize),
    [file.path, thumbnailSize],
  );

  useEffect(() => {
    const cached = thumbnailCache.get(
      thumbnailCacheKey(file.path, thumbnailSize),
    );
    setThumbnail(cached || null);
    if (cached) onThumbnailLoaded?.(file.path);
    if (!isPreviewable || cached || !window.electron) return;

    const element = containerRef.current;
    if (!element) return;
    let cancelled = false;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        observer.disconnect();
        void loadThumbnail(file.path, true, thumbnailSize).then((url) => {
          if (cancelled || !url) return;
          setThumbnail(url);
          onThumbnailLoaded?.(file.path);
        });
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [file.path, isPreviewable, onThumbnailLoaded, thumbnailSize]);

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

function App() {
  const electronAPI = window.electron;
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [fileScanProgress, setFileScanProgress] =
    useState<FileScanProgress | null>(null);
  const [loadedThumbnailPaths, setLoadedThumbnailPaths] = useState<Set<string>>(
    new Set(),
  );
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
  const [yearFilter, setYearFilter] = useState("all");
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
  const [thumbnailSize, setThumbnailSize] = useState(() =>
    Math.min(
      200,
      Math.max(120, Number(localStorage.getItem("silo.thumbnailSize")) || 200),
    ),
  );
  const [viewerOpen, setViewerOpen] = useState(false);
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
  const [indexProgress, setIndexProgress] =
    useState<IndexProgress>(emptyIndexProgress);
  const [thumbnailPregen, setThumbnailPregen] =
    useState<ThumbnailPregenProgress | null>(null);
  const [thumbnailPregenDismissed, setThumbnailPregenDismissed] =
    useState(false);
  const lastThumbnailPregenStatusRef =
    useRef<ThumbnailPregenProgress["status"]>("idle");
  const [digitalFolders, setDigitalFolders] = useState<DigitalFolder[]>([]);
  const draggedFolder = useRef<string | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<{
    id: string;
    after: boolean;
  } | null>(null);
  const [folderOrderBusy, setFolderOrderBusy] = useState(false);
  const [folderOrderError, setFolderOrderError] = useState("");
  const [showSourceClone, setShowSourceClone] = useState(false);
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
  const [showSettings, setShowSettings] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [selectingBugReportScreenshot, setSelectingBugReportScreenshot] =
    useState(false);
  const [lifetimePromptRequest, setLifetimePromptRequest] = useState(0);
  const [demoModeActive, setDemoModeActive] = useState<boolean | null>(null);
  const [showGuidedTour, setShowGuidedTour] = useState(false);
  const [showLocalHelp, setShowLocalHelp] = useState(false);
  const [tourContextStep, setTourContextStep] = useState<GuidedTourStep | null>(
    null,
  );
  const [tourDuplicateView, setTourDuplicateView] = useState<
    "duplicates" | "trash" | null
  >(null);
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
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [confidence, setConfidence] = useState(DEFAULT_SEMANTIC_SEARCH_CONFIDENCE);
  const [appSection, setAppSection] = useState<
    "files" | "people" | "map" | "duplicates" | "pets" | "mobile" | "memories" | "stats"
  >("files");
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
  const [faceAssignmentFaces, setFaceAssignmentFaces] = useState<ImageFace[]>(
    [],
  );
  const [faceAssignmentSelectedId, setFaceAssignmentSelectedId] = useState<
    string | null
  >(null);
  const [faceAssignmentPersonId, setFaceAssignmentPersonId] = useState("");
  const [faceAssignmentNewName, setFaceAssignmentNewName] = useState("");
  const [faceAssignmentBusy, setFaceAssignmentBusy] = useState(false);
  const [faceAssignmentError, setFaceAssignmentError] = useState("");
  const [faceCreationBox, setFaceCreationBox] = useState<
    ImageFace["box"] | null
  >(null);
  const faceBoxDragRef = useRef<{
    faceId: string;
    startX: number;
    startY: number;
    startBox: ImageFace["box"];
    currentBox: ImageFace["box"];
    moved: boolean;
  } | null>(null);
  const faceCreateDragRef = useRef<{
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
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleNotice, setGoogleNotice] = useState("");
  const [pickerSession, setPickerSession] = useState<{
    accountId: string;
    sessionId: string;
  } | null>(null);
  const [sources, setSources] = useState<BrowseSource[]>([]);
  const [sourceSort, setSourceSort] = useState<"name" | "kind" | "backup">(
    "name",
  );
  const sortedSources = useMemo(() => {
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return [...sources].sort((first, second) => {
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
  }, [sourceSort, sources]);
  const cloneableSources = useMemo(
    () => sources.filter((source) => source.enabled && source.available),
    [sources],
  );
  const sourcesRef = useRef<BrowseSource[]>([]);
  const sourcesRefreshRequestRef = useRef(0);
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
  const [magicState, setMagicState] = useState<MagicState>(emptyMagicState);
  const magicPrefs = useMagicPreferences();
  const [sort, setSort] = useState<SortState>({
    field: "name",
    ascending: true,
  });
  const [sortIndicators, setSortIndicators] = useState<
    Record<string, { people: boolean; mapped: boolean }>
  >({});
  const [sortIndicatorRevision, setSortIndicatorRevision] = useState(0);
  const metadataRevisionRef = useRef(sortIndicatorRevision);
  metadataRevisionRef.current = sortIndicatorRevision;
  const [sortIndicatorSnapshot, setSortIndicatorSnapshot] = useState<{
    files: FileInfo[];
    revision: number;
  } | null>(null);
  const [sortIndicatorError, setSortIndicatorError] = useState("");
  const [peopleFilter, setPeopleFilter] = useState<MetadataFilter>("all");
  const [locationFilter, setLocationFilter] = useState<MetadataFilter>("all");
  const needsPhotoMetadata =
    !audioOnlySelected &&
    (sort.field === "people" ||
      sort.field === "mapped" ||
      peopleFilter !== "all" ||
      locationFilter !== "all");
  const explodedRef = useRef(exploded);
  const contentVisibilityRef = useRef(`${contentSettings.showNsfw}:0`);
  const sortRef = useRef(sort);
  const filtersRef = useRef(filters);
  const scanRequestRef = useRef(0);
  const filePreviewRequestRef = useRef(0);
  const settledScanRef = useRef(0);
  const previewedScanRef = useRef<number | null>(null);
  const allSourcesLoadedRef = useRef(new Set<string>());
  const sourceScanJobsRef = useRef(new Map<string, Promise<FileInfo[]>>());
  const sourceRefreshTimerRef = useRef<number | null>(null);
  const preserveScanRequestRef = useRef<number | null>(null);
  const preserveSelectionRequestRef = useRef<number | null>(null);
  const searchRequestRef = useRef(0);
  const fileGridRef = useRef<HTMLDivElement | null>(null);
  const fileBrowserRef = useRef<HTMLDivElement | null>(null);
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
    localStorage.setItem("silo.thumbnailSize", String(thumbnailSize));
  }, [thumbnailSize]);

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
    if (!electronAPI?.onDemoLimitReached) return;
    return electronAPI.onDemoLimitReached(() => {
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
    if (!startupState.ready || !hydrated || startupTourChecked.current) return;
    startupTourChecked.current = true;
    if (showTourAtStartup) setShowGuidedTour(true);
  }, [hydrated, showTourAtStartup, startupState.ready]);

  const updateShowTourAtStartup = useCallback((show: boolean) => {
    setShowTourAtStartup(show);
    try {
      localStorage.setItem("silo.guidedTour.showAtStartup", String(show));
    } catch {
      return;
    }
  }, []);

  const navigateGuidedTour = useCallback((section: GuidedTourSection, step: GuidedTourStep) => {
    setTourDuplicateView(section === "duplicates"
      ? step.target === '[data-tour="duplicate-trash-actions"]' ? "trash" : "duplicates"
      : null);
    if (section === "settings") {
      setShowSettings(true);
      return;
    }
    setShowSettings(false);
    setAppSection(section);
  }, []);

  const startGuidedTour = useCallback(() => {
    setTourContextStep(null);
    setShowLocalHelp(false);
    setShowGuidedTour(true);
  }, []);

  useEffect(() => {
    sortRef.current = sort;
  }, [sort]);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const markThumbnailLoaded = useCallback((filePath: string) => {
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
    setDigitalFolders(state.digitalFolders);
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
    if (state.indexProgress) setIndexProgress(state.indexProgress);
  }, []);

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
      preserveScanRequestRef.current =
        preserveView && !streamWhilePreserving ? requestId : null;
      preserveSelectionRequestRef.current = preserveView ? requestId : null;
      const scannedSourceIds =
        directoryPath === allSourcesPathRef.current && explodedMode
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
          explodedMode,
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
        if (directoryPath === allSourcesPathRef.current && explodedMode) {
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
    if (!electronAPI) return;
    let cancelled = false;
    const removeProgressListener =
      electronAPI.onIndexProgress(setIndexProgress);
    void Promise.all([
      electronAPI.getAppState(),
      electronAPI.listSources(),
      electronAPI.getAllSourcesPath(),
    ])
      .then(async ([state, availableSources, aggregatePath]) => {
        if (cancelled) return;
        applyPersistedState(state);
        setSources(availableSources);
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
        setConfidence(state.ui.confidence);
        const persistedPath = state.ui.currentPath;
        const pathIsAvailable = availableSources.some(
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
        const nextExploded = state.ui.exploded;
        setExploded(nextExploded);
        setCurrentPath(pathToLoad);
        setNavigationHistory([{ type: "path", value: pathToLoad }]);
        setHistoryIndex(0);
        await loadDirectory(pathToLoad, nextExploded);
        if (!cancelled) setHydrated(true);
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
  }, [applyPersistedState, electronAPI, loadDirectory]);

  useEffect(() => {
    if (!electronAPI) return;
    return electronAPI.onFileScanProgress((progress) => {
      if (progress.requestId !== scanRequestRef.current) return;
      setFileScanProgress(progress);
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
                  const merged = new Map(cached.map((file) => [file.path, file]));
                  for (const file of current) merged.set(file.path, file);
                  return Array.from(merged.values());
                });
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
        setFiles((current) => {
          const merged = new Map(current.map((file) => [file.path, file]));
          for (const file of progress.fileDeltas!) merged.set(file.path, file);
          return Array.from(merged.values());
        });
      }
    });
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
            sortIndicators,
          ),
      );
  }, [
    magicState.ranks,
    personDetail?.confirmedPhotoPaths,
    personPhotos,
    redundantDuplicatePaths,
    sort,
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
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    confidence,
    currentPath,
    electronAPI,
    exploded,
    filters.includedType,
    hydrated,
    showFilters,
    sort,
    viewMode,
  ]);

  const selectDirectory = useCallback(async () => {
    if (!electronAPI) return;
    const directoryPath = await electronAPI.selectDirectory();
    if (!directoryPath) return;
    setCurrentPath(directoryPath);
    setNavigationHistory([{ type: "path", value: directoryPath }]);
    setHistoryIndex(0);
    setActiveDigitalFolderId(null);
    await loadDirectory(directoryPath);
  }, [electronAPI, loadDirectory]);

  const scanForPhones = useCallback(async () => {
    if (!electronAPI) return;
    setPhoneScanning(true);
    setPhoneNotice("");
    try {
      const [tooling, devices] = await Promise.all([
        electronAPI.getPhoneTooling(),
        electronAPI.listPhones(),
      ]);
      setPhoneTooling(tooling);
      setPhoneDevices(devices);
      setSources(await electronAPI.listSources());
      if (devices.length === 0) {
        setPhoneNotice(
          !tooling.ios.available && !tooling.android.available
            ? "No device tooling installed yet."
            : "No phone detected. Connect one over USB and unlock it.",
        );
      }
    } finally {
      setPhoneScanning(false);
    }
  }, [electronAPI]);

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
          await browsePhone(connected);
        }
      } finally {
        setPhoneBusyId(null);
      }
    },
    [browsePhone, electronAPI],
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
          setSources(await electronAPI.listSources());
        },
      });
    },
    [electronAPI, openDialog],
  );

  const choosePhoneBackupDestination = useCallback(async () => {
    if (!electronAPI) return;
    const path = await electronAPI.selectDirectory();
    if (!path) return;
    await electronAPI.setPhoneBackupDestination(path);
    setPhoneBackupDestination(path);
  }, [electronAPI]);

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
      void electronAPI.listSources().then(setSources);
    });
    return () => {
      removeProgress();
      removeDevices();
    };
  }, [electronAPI]);

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
      void electronAPI.listSources().then(setSources);
    });
  }, [electronAPI]);

  const refreshSources = useCallback(async () => {
    if (!electronAPI) return;
    const request = ++sourcesRefreshRequestRef.current;
    const latest = await electronAPI.listSources();
    if (request !== sourcesRefreshRequestRef.current) return;
    sourcesRef.current = latest;
    setSources(latest);
  }, [electronAPI]);
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
              const byPath = new Map(current.map((file) => [file.path, file]));
              sourceFiles.forEach((file) =>
                byPath.set(file.path, {
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
      const updated = await electronAPI.setSourceEnabled(sourceId, enabled);
      sourcesRefreshRequestRef.current += 1;
      sourcesRef.current = updated;
      setSources(updated);
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
      await loadAggregateSource(source);
    },
    [
      activeDigitalFolderId,
      allSourcesPath,
      currentPath,
      electronAPI,
      loadAggregateSource,
      loadDirectory,
    ],
  );

  const setEverySource = useCallback(
    async (enabled: boolean) => {
      if (!electronAPI) return;
      const updated = await electronAPI.setAllSourcesEnabled(enabled);
      sourcesRefreshRequestRef.current += 1;
      sourcesRef.current = updated;
      setSources(updated);
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
        await Promise.all(toLoad.map(loadAggregateSource));
      }
    },
    [
      activeDigitalFolderId,
      allSourcesPath,
      currentPath,
      electronAPI,
      loadAggregateSource,
      loadDirectory,
    ],
  );

  const browseAllSources = useCallback(async () => {
    setConnectedPhone(null);
    setExploded(false);
    setCurrentPath(allSourcesPath);
    setNavigationHistory([{ type: "path", value: allSourcesPath }]);
    setHistoryIndex(0);
    setActiveDigitalFolderId(null);
    setAppSection("files");
    await loadDirectory(allSourcesPath, false);
  }, [allSourcesPath, loadDirectory]);

  const navigateToPath = useCallback(
    async (targetPath: string, addToHistory = true) => {
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
    [historyIndex, loadDirectory, navigationHistory],
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
    [electronAPI, historyIndex, navigationHistory],
  );

  const navigateHistory = useCallback(
    async (nextIndex: number) => {
      const entry = navigationHistory[nextIndex];
      if (!entry) return;
      setHistoryIndex(nextIndex);
      if (entry.type === "path") {
        setCurrentPath(entry.value);
        setActiveDigitalFolderId(null);
        await loadDirectory(entry.value);
      } else {
        await navigateToDigitalFolder(entry.value, false);
      }
    },
    [loadDirectory, navigationHistory, navigateToDigitalFolder],
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
      setFilePreview(null);
      if (file.type === "image" || file.type === "video")
        void refreshThumbnail(file.path);
      try {
        const preview = await electronAPI.getFilePreview(file.path);
        if (request === filePreviewRequestRef.current) setFilePreview(preview);
      } catch (error) {
        if (request === filePreviewRequestRef.current)
          setBrowseError(
            `Could not preview "${file.name}". Check that the file is accessible, then select it again. ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    },
    [electronAPI],
  );

  const openMediaViewer = useCallback(
    async (file: FileInfo, scopeFiles?: FileInfo[]) => {
      if (!electronAPI || file.isDirectory) return;
      setSelectedFile(file);
      setViewerScopeFiles(scopeFiles ?? null);
      const request = ++filePreviewRequestRef.current;
      if (file.type === "image" || file.type === "video")
        void refreshThumbnail(file.path);
      const livePhotoVideo =
        file.type === "image"
          ? findLivePhotoVideo(file, scopeFiles ?? files)
          : null;
      const playbackFile = livePhotoVideo ?? file;
      setViewerMediaFile(playbackFile);
      setFilePreview(null);
      setViewerZoom(1);
      setViewerFit(true);
      setViewerDimensions({ width: 0, height: 0 });
      setMediaPlaying(false);
      setMediaCurrentTime(0);
      setMediaDuration(0);
      setMediaLoop(Boolean(livePhotoVideo));
      setMediaMuted(Boolean(livePhotoVideo));
      setMediaError("");
      setViewerOpen(true);
      try {
        const preview = await electronAPI.getFilePreview(playbackFile.path);
        if (request === filePreviewRequestRef.current) setFilePreview(preview);
      } catch (error) {
        if (request === filePreviewRequestRef.current)
          setMediaError(
            `Could not open "${playbackFile.name}". Check that the file is accessible, then reopen it. ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    },
    [electronAPI, files],
  );

  const openFaceAssignment = useCallback(
    async (file: FileInfo) => {
      if (!electronAPI || file.type !== "image") return;
      await openMediaViewer(file);
      setFaceAssignmentOpen(true);
      setFaceAssignmentFaces([]);
      setFaceAssignmentSelectedId(null);
      setFaceAssignmentPersonId("");
      setFaceAssignmentNewName("");
      setFaceAssignmentError("");
      const [faces] = await Promise.all([
        electronAPI.getImageFaces(file.path),
        refreshPeople(),
      ]);
      setFaceAssignmentFaces(faces);
      if (faces.length === 0)
        setFaceAssignmentError(
          "No detected faces for this photo yet. Run face indexing first.",
        );
    },
    [electronAPI, openMediaViewer, refreshPeople],
  );

  const assignSelectedFace = useCallback(async () => {
    if (!electronAPI || !selectedFile || !faceAssignmentSelectedId) return;
    setFaceAssignmentBusy(true);
    setFaceAssignmentError("");
    try {
      let targetPersonId = faceAssignmentPersonId;
      if (!targetPersonId) {
        const name = faceAssignmentNewName.trim();
        if (!name)
          throw new Error("Choose a person or enter a new person name.");
        const before = new Set(
          (await electronAPI.getFaceState()).people.map((person) => person.id),
        );
        await electronAPI.createPerson(name);
        const created = (await electronAPI.getFaceState()).people.find(
          (person) => !before.has(person.id),
        );
        if (!created) throw new Error("Could not create the new person.");
        targetPersonId = created.id;
      }
      await electronAPI.assignFaceToPerson(
        targetPersonId,
        faceAssignmentSelectedId,
      );
      setFaceAssignmentFaces(
        await electronAPI.getImageFaces(selectedFile.path),
      );
      refreshPhotoIndicators([selectedFile.path]);
      await refreshPeople();
      setFaceAssignmentSelectedId(null);
      setFaceAssignmentPersonId("");
      setFaceAssignmentNewName("");
    } catch (cause) {
      setFaceAssignmentError(
        cause instanceof Error ? cause.message : "Could not assign this face.",
      );
    } finally {
      setFaceAssignmentBusy(false);
    }
  }, [
    electronAPI,
    faceAssignmentNewName,
    faceAssignmentPersonId,
    faceAssignmentSelectedId,
    refreshPeople,
    selectedFile,
  ]);

  const deleteDetectedFace = useCallback(
    async (faceId: string) => {
      if (!electronAPI || !selectedFile) return;
      setFaceAssignmentBusy(true);
      setFaceAssignmentError("");
      try {
        setFaceAssignmentFaces(await electronAPI.deleteFace(faceId));
        if (selectedPersonPhoto?.path === selectedFile.path)
          setSelectedPhotoFaces(
            await electronAPI.getImageFaces(selectedFile.path),
          );
        setFaceAssignmentSelectedId((current) =>
          current === faceId ? null : current,
        );
        await refreshPeople();
      } catch (cause) {
        setFaceAssignmentError(
          cause instanceof Error
            ? cause.message
            : "Could not delete this face.",
        );
      } finally {
        setFaceAssignmentBusy(false);
      }
    },
    [electronAPI, refreshPeople, selectedFile, selectedPersonPhoto],
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
        !selectedFile ||
        drag.currentBox.width < 0.01 ||
        drag.currentBox.height < 0.01
      )
        return;
      setFaceAssignmentBusy(true);
      setFaceAssignmentError("");
      try {
        const faces = await electronAPI.createFaceBox(
          selectedFile.path,
          drag.currentBox,
        );
        setFaceAssignmentFaces(faces);
        setFaceAssignmentSelectedId(faces[faces.length - 1]?.id ?? null);
        if (selectedPersonPhoto?.path === selectedFile.path)
          setSelectedPhotoFaces(faces);
        await refreshPeople();
      } catch (cause) {
        setFaceAssignmentError(
          cause instanceof Error
            ? cause.message
            : "Could not create the face box.",
        );
      } finally {
        setFaceAssignmentBusy(false);
      }
    },
    [electronAPI, refreshPeople, selectedFile, selectedPersonPhoto],
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
      if (!drag.moved || !electronAPI || !selectedFile) return;
      setFaceAssignmentBusy(true);
      setFaceAssignmentError("");
      try {
        const faces = await electronAPI.updateFaceBox(
          drag.faceId,
          selectedFile.path,
          drag.currentBox,
        );
        setFaceAssignmentFaces(faces);
        if (selectedPersonPhoto?.path === selectedFile.path)
          setSelectedPhotoFaces(faces);
        await refreshPeople();
      } catch (cause) {
        setFaceAssignmentFaces((faces) =>
          faces.map((item) =>
            item.id === drag.faceId ? { ...item, box: drag.startBox } : item,
          ),
        );
        setFaceAssignmentError(
          cause instanceof Error
            ? cause.message
            : "Could not move this face box.",
        );
      } finally {
        setFaceAssignmentBusy(false);
      }
      event.stopPropagation();
    },
    [electronAPI, refreshPeople, selectedFile, selectedPersonPhoto],
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

  const createFolder = useCallback(async () => {
    if (!currentPath || !electronAPI) return;
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
  }, [currentPath, electronAPI, loadDirectory, openDialog]);

  const moveSelectedFile = useCallback(async () => {
    if (
      !selectedFile ||
      selectedFile.isDirectory ||
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
    if (!electronAPI) return;
    const state = await electronAPI.selectIndexSource();
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
    () => selectedMedia<FileInfo>(metadataTargets, files, searchResults),
    [files, metadataTargets, searchResults],
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

  const openFolderSelector = useCallback((filePath?: string) => {
    if (filePath) setFolderSelectionFile(filePath);
    setShowFolderSelector(true);
  }, []);

  const closeFolderSelector = useCallback(() => {
    setFolderSelectionFile(null);
    setShowFolderSelector(false);
  }, []);

  const addFilesToFolder = useCallback(
    async (folderId: string, filePaths: string[]) => {
      if (!electronAPI || filePaths.length === 0) return;
      applyPersistedState(
        await electronAPI.addDigitalFolderReferences(folderId, filePaths),
      );
      if (activeDigitalFolderId === folderId) {
        await openDigitalFolder(folderId);
      }
      clearFileSelection();
      setFolderSelectionFile(null);
      setShowFolderSelector(false);
    },
    [
      activeDigitalFolderId,
      applyPersistedState,
      clearFileSelection,
      electronAPI,
      openDigitalFolder,
    ],
  );

  const openPerson = useCallback(
    async (personId: string) => {
      if (!electronAPI) return;
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
    [electronAPI],
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
        if (faceAssignmentOpen && selectedFile?.type === "image") {
          const faces = await electronAPI.getImageFaces(selectedFile.path);
          setFaceAssignmentFaces(faces);
          if (selectedPersonPhoto?.path === selectedFile.path)
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
      if (!electronAPI || !searchQuery.trim()) return;
      const requestId = ++searchRequestRef.current;
      setSearching(true);
      setSearchDone(false);
      setSearchError("");
      let succeeded = false;
      try {
        const results = await electronAPI.semanticSearch(
          searchQuery,
          confidence,
          requestId,
        );
        if (requestId === searchRequestRef.current) {
          const hidden = bannedHiddenPathsRef.current;
          setSearchResults(
            hidden.size > 0
              ? results.filter((result) => !hidden.has(result.path))
              : results,
          );
          succeeded = true;
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
          setSearching(false);
          setSearchDone(succeeded);
        }
      }
    },
    [confidence, electronAPI, searchQuery],
  );

  useEffect(() => {
    if (!electronAPI) return;
    return electronAPI.onSemanticSearchProgress((progress) => {
      if (progress.requestId !== searchRequestRef.current) return;
      const hidden = bannedHiddenPathsRef.current;
      setSearchResults(
        hidden.size > 0
          ? progress.results.filter((result) => !hidden.has(result.path))
          : progress.results,
      );
      const done = progress.status === "done";
      setSearching(!done);
      setSearchDone(done);
    });
  }, [electronAPI]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      searchRequestRef.current += 1;
      setSearchResults([]);
      setSearching(false);
      setSearchDone(false);
      setSearchError("");
      return;
    }
    const timer = window.setTimeout(() => void runSemanticSearch(true), 120);
    return () => {
      window.clearTimeout(timer);
      if (electronAPI)
        void electronAPI.cancelSemanticSearch().catch(() => undefined);
    };
  }, [electronAPI, runSemanticSearch, searchQuery]);

  useEffect(() => {
    if (contentSafetyRevision > 0) void runSemanticSearch(false);
  }, [contentSafetyRevision, runSemanticSearch]);

  const rawContentFiles: FileInfo[] = useMemo(() => {
    if (!searchQuery.trim()) return files;
    if (!activeDigitalFolderId) return searchResults;
    const resultsByPath = new Map(
      searchResults.map((result) => [result.path, result]),
    );
    return files
      .filter((file) => resultsByPath.has(file.path))
      .map((file) => ({ ...file, ...resultsByPath.get(file.path) }));
  }, [activeDigitalFolderId, files, searchQuery, searchResults]);
  const contentFiles = useMemo(
    () =>
      rawContentFiles.map((file) => {
        const metadata = fileMetadata[file.path];
        if (!metadata?.displayName && metadata?.year === undefined) return file;
        return {
          ...file,
          name: metadata.displayName || file.name,
          year: metadata.year,
        };
      }),
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

  useEffect(() => {
    if (!electronAPI || !needsPhotoMetadata) {
      return;
    }
    let cancelled = false;
    let running = false;
    let loadedRevision = -1;
    setSortIndicatorError("");
    const mediaPaths = contentFiles
      .filter(
        (file) =>
          !file.isDirectory && (file.type === "image" || file.type === "video"),
      )
      .map((file) => file.path);
    const refresh = async () => {
      if (
        cancelled ||
        running ||
        loadedRevision === metadataRevisionRef.current
      )
        return;
      running = true;
      const revision = metadataRevisionRef.current;
      try {
        const next: Record<string, { people: boolean; mapped: boolean }> = {};
        const snapshot: Record<
          string,
          { hasLocation: boolean; people: string[] }
        > = {};
        // One snapshot: batching used to rescan every person cluster dozens of
        // times and a progress event could cancel the run before it committed.
        for (let offset = 0; offset < mediaPaths.length; offset += 1000) {
          const batch = mediaPaths.slice(offset, offset + 1000);
          const values = await electronAPI.getPhotoIndicators(batch);
          if (cancelled) return;
          for (const filePath of batch) {
            const indicators = values[filePath];
            if (!indicators)
              throw new Error(
                "Incomplete photo metadata. Please retry the sort.",
              );
            snapshot[filePath] = indicators;
            next[filePath] = {
              people: (indicators?.people.length ?? 0) > 0,
              mapped: Boolean(indicators?.hasLocation),
            };
          }
          publishPhotoIndicators(snapshot);
          for (const filePath of batch) delete snapshot[filePath];
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        if (cancelled) return;
        setSortIndicators((current) => {
          const paths = Object.keys(next);
          return paths.length === Object.keys(current).length &&
            paths.every(
              (filePath) =>
                current[filePath]?.people === next[filePath].people &&
                current[filePath]?.mapped === next[filePath].mapped,
            )
            ? current
            : next;
        });
        loadedRevision = revision;
        setSortIndicatorError("");
        setSortIndicatorSnapshot({ files: contentFiles, revision });
      } catch (cause) {
        loadedRevision = revision;
        if (!cancelled)
          setSortIndicatorError(
            cause instanceof Error
              ? cause.message
              : "Could not load sorting metadata.",
          );
      } finally {
        running = false;
      }
    };
    const timer = window.setTimeout(() => void refresh(), 300);
    const refreshTimer = window.setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(refreshTimer);
    };
  }, [contentFiles, electronAPI, needsPhotoMetadata]);

  const waitingForSortIndicators =
    needsPhotoMetadata &&
    (sortIndicatorSnapshot?.files !== contentFiles ||
      sortIndicatorSnapshot?.revision !== sortIndicatorRevision);
  const showMetadataBusy = useStableBusy(waitingForSortIndicators);

  useMagicRanks(
    !audioOnlySelected && sort.field === "magic",
    appSection === "people" && selectedPersonId ? personPhotos : contentFiles,
    setMagicState,
    magicPrefs.preset,
  );

  const filteredAndSortedFiles = useMemo(() => {
    const filtered = contentFiles.filter((file) => {
      if (file.isDirectory)
        return !exploded && peopleFilter === "all" && locationFilter === "all";
      if (
        !matchesMetadataFilters(
          sortIndicators[file.path],
          peopleFilter,
          locationFilter,
        )
      )
        return false;
      if (
        exploded &&
        currentPath === allSourcesPath &&
        !searchQuery.trim() &&
        file.sourceId &&
        !sources.some(
          (source) =>
            source.id === file.sourceId && source.enabled && source.available,
        )
      )
        return false;
      if (yearFilter !== "all" && modifiedYear(file) !== yearFilter)
        return false;
      if (
        filters.includedType !== "all" &&
        !selectedTypes(filters.includedType).includes(file.type)
      )
        return false;
      return file.size >= filters.sizeMin && file.size <= filters.sizeMax;
    });

    filtered.sort((first, second) => {
      if (searchQuery.trim()) {
        const firstPriority = (first as SemanticSearchResult)._priority ?? 3;
        const secondPriority = (second as SemanticSearchResult)._priority ?? 3;
        if (firstPriority !== secondPriority)
          return firstPriority - secondPriority;
      }
      return compareFilesBySort(
        first,
        second,
        sort,
        magicState.ranks,
        sortIndicators,
      );
    });

    return exploded
      ? filtered
      : [
          ...filtered.filter((file) => file.isDirectory),
          ...filtered.filter((file) => !file.isDirectory),
        ];
  }, [
    allSourcesPath,
    contentFiles,
    currentPath,
    exploded,
    filters,
    magicState.ranks,
    searchQuery,
    sortIndicators,
    peopleFilter,
    locationFilter,
    sort,
    sources,
    yearFilter,
  ]);

  const yearOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...contentFiles.filter((file) => !file.isDirectory).map(modifiedYear),
          ...(audioOnlySelected ? audioYearOptions : []),
        ]),
      ).sort((first, second) => {
        if (first === "Unknown year") return 1;
        if (second === "Unknown year") return -1;
        const direction = sort.field === "modified" && sort.ascending ? 1 : -1;
        return (Number(first) - Number(second)) * direction;
      }),
    [
      audioOnlySelected,
      audioYearOptions,
      contentFiles,
      sort.ascending,
      sort.field,
    ],
  );

  const viewerImages = useMemo(
    () =>
      (viewerScopeFiles ?? filteredAndSortedFiles).filter(
        (file) => file.type === "image" || file.type === "video",
      ),
    [filteredAndSortedFiles, viewerScopeFiles],
  );

  const selectAllFiles = useCallback(() => {
    const selectableFiles = filteredAndSortedFiles.filter(
      (file) => !file.isDirectory,
    );
    setSelectedFilePaths(new Set(selectableFiles.map((file) => file.path)));
  }, [filteredAndSortedFiles]);

  const clearAllFiles = useCallback(() => {
    setSelectedFilePaths(new Set());
  }, []);

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
          setViewerZoom((zoom) => Math.max(zoom - 0.25, 0.25));
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
    const allFolders = filteredAndSortedFiles.filter(
      (file) => file.isDirectory,
    );
    const folders = allFolders.slice(0, displayLimit);
    const byYear = new Map<string, FileInfo[]>();
    const sectionOrder = new Map<string, { year: string; priority: number }>();
    const indicatorSort = sort.field === "people" || sort.field === "mapped";
    filteredAndSortedFiles
      .filter((file) => !file.isDirectory)
      .forEach((file) => {
        const year = modifiedYear(file);
        const metadataKnown = Boolean(sortIndicators[file.path]);
        const matches =
          sort.field === "people"
            ? Boolean(sortIndicators[file.path]?.people)
            : Boolean(sortIndicators[file.path]?.mapped);
        const label =
          sort.field === "people"
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
              : indicatorSort && matches !== sort.ascending
                ? 1
                : 0,
        });
      });
    const years = Array.from(byYear.keys()).sort((first, second) => {
      const firstSection = sectionOrder.get(first)!;
      const secondSection = sectionOrder.get(second)!;
      if (firstSection.priority !== secondSection.priority)
        return firstSection.priority - secondSection.priority;
      if (firstSection.year === secondSection.year) return 0;
      if (firstSection.year === "Unknown year") return 1;
      if (secondSection.year === "Unknown year") return -1;
      const direction = sort.field === "modified" && sort.ascending ? 1 : -1;
      return (
        (Number(firstSection.year) - Number(secondSection.year)) * direction
      );
    });
    return { allFolders, folders, years, byYear };
  }, [displayLimit, filteredAndSortedFiles, sort, sortIndicators]);
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
    () => [
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
    ],
    [expandedYears, yearDisplayLimits, yearSections, yearPageSize],
  );
  const displayedFiles = useMemo(
    () =>
      displayItems.flatMap((item) => (item.kind === "file" ? [item.file] : [])),
    [displayItems],
  );
  useEffect(() => {
    if (appSection !== "files" || preserveSelectionRequestRef.current !== null)
      return;
    const availablePaths = new Set(
      filteredAndSortedFiles
        .filter((file) => !file.isDirectory)
        .map((file) => file.path),
    );
    setSelectedFilePaths((current) => {
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
    const [field, direction] = value.split("-") as [
      SortState["field"],
      "asc" | "desc",
    ];
    setSort({ field, ascending: direction === "asc" });
  };

  const handleHeaderSort = (field: SortState["field"]) => {
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
    <div className="app">
      {!(startupState.ready && hydrated) && (
        <div className="startup-progress" role="status" aria-live="polite">
          <div className="startup-progress-track">
            <div
              className="startup-progress-fill"
              style={{
                width: `${Math.max(6, ((startupState.ready ? startupState.total : startupState.step) / Math.max(startupState.total, 1)) * 100)}%`,
              }}
            />
          </div>
          <span>
            {startupState.ready ? "Opening library…" : startupState.label}
          </span>
        </div>
      )}
      <header className="header">
        <div className="header-left" data-help="Use Back, Forward, and Parent to navigate folder history; Refresh reloads the current source view. These controls do not alter the underlying files.">
          <h1>silo</h1>
          <nav className="app-tabs" data-tour="app-tabs">
            <button className={appSection === "memories" ? "active" : ""}
                          onClick={() => setAppSection("memories")}
                          data-tour="memories-tab"
                          data-help="Open the story-video area. Browse suggestions and create or export a memory only when you choose."><FiPlay /> Memories</button>
            <button
              className={appSection === "files" ? "active" : ""}
              onClick={() => setAppSection("files")}
              data-help="Browse local folders, connected cloud accounts, and saved device sources; search and organize their files."
            >
              <FiGrid /> Files
            </button>
            <button
              className={appSection === "people" ? "active" : ""}
              onClick={() => setAppSection("people")}
              data-help="Review offline face clusters, name people, and correct or merge their photo assignments."
            >
              <FiUsers /> People
            </button>
            <button
              className={appSection === "map" ? "active" : ""}
              onClick={() => setAppSection("map")}
              data-help="Explore geotagged photos by place and update selected photos’ location metadata."
            >
              <FiMap /> Map
            </button>
            <button
              className={appSection === "duplicates" ? "active" : ""}
              onClick={() => setAppSection("duplicates")}
              data-help="Compare exact duplicate files, review recoverable removals, and verify before permanent deletion."
            >
              <FiCopy /> Duplicates
            </button>
            <button
              className={appSection === "mobile" ? "active" : ""}
              onClick={() => setAppSection("mobile")}
              data-help="Connect phones and tablets, browse saved copies, and review or export message histories."
            >
              <FiSmartphone /> Mobile
            </button>
            <button
              onClick={() => setShowSettings(true)}
              title="Settings"
              aria-label="Settings"
              data-help="Open appearance, content protection, memory storage, configuration backup, bug reporting, and full Library Statistics."
            >
              <FiSettings />
            </button>
            <button
              onClick={() => setShowLocalHelp(true)}
              title="Local help and replay the guided tour"
              aria-label="Open Silo Help"
              data-tour="help-button"
              data-help="Search the built-in local help and replay the guided tour; no live AI or network call is used."
            >
              <FiHelpCircle /> Help
            </button>
          </nav>
          {appSection === "files" && (
            <button className="btn btn-primary" onClick={selectDirectory}
              data-help="Choose a folder on this Mac and add it to Files as a source for browsing and indexing.">
              <FiDownload /> Open Directory
            </button>
          )}
          {appSection === "files" && (currentPath || activeDigitalFolderId) && (
            <>
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
              {(currentPath || activeDigitalFolderId) && (
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
              )}
              <button
                className="btn btn-icon"
                onClick={() =>
                  currentPath
                    ? loadDirectory(currentPath)
                    : activeDigitalFolderId &&
                      navigateToDigitalFolder(activeDigitalFolderId, false)
                }
                title="Refresh"
                aria-label="Refresh current folder"
                data-help="Reload the current directory or digital-folder contents from its source."
              >
                <FiRefreshCw />
              </button>
            </>
          )}
        </div>
        {appSection === "files" ? (
          <div className="semantic-search" data-tour="semantic-search">
            <FiSearch />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onFocus={() => {
                setSearchFocused(true);
                setHistoryLevel(0);
              }}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") rememberSearch(searchQuery);
                if (event.key === "Escape")
                  (event.target as HTMLInputElement).blur();
              }}
              placeholder="Search images and documents by meaning"
              aria-label="Semantic search"
              data-help="Describe what you remember in ordinary language to find matching indexed photos and documents locally."
            />
            <span className="semantic-search-status" role="status" aria-live="polite">
              {searching ? "Searching…" : searchDone ? "Done!" : ""}
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
          <div />
        )}
        <div
          className="header-right"
          data-tour={appSection === "files" ? "file-actions" : undefined}
          data-help={appSection === "files" ? "These actions change the current file view or apply to selected files. Move and New folder affect real files; Set virtual name only changes Silo’s label." : undefined}
        >
          {appSection === "files" ? (
            <>
              <button
                className={`btn explode-button ${exploded ? "active" : ""}`}
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
              <button
                className="btn btn-icon"
                onClick={createFolder}
                disabled={!currentPath}
                title="New folder"
                aria-label="New folder"
                data-help="Create a real folder inside the currently open source directory."
              >
                <FiFolderPlus />
              </button>
              <button
                className="btn btn-icon"
                onClick={moveSelectedFile}
                disabled={!selectedFile || selectedFile.isDirectory}
                title="Move selected file"
                aria-label="Move selected file"
                data-help="Choose a destination and move the selected file on disk. Review the destination before confirming."
              >
                <FiMove />
              </button>
              <button
                className="btn btn-icon"
                onClick={editVirtualName}
                disabled={metadataTargets.length !== 1}
                title="Set virtual name"
                aria-label="Set virtual name"
                data-help="Change the name Silo displays and searches for this file without renaming the file on disk."
              >
                <FiEdit3 />
              </button>
              <button
                className="btn btn-icon"
                onClick={editKeywords}
                disabled={metadataTargets.length === 0}
                title="Edit search keywords"
                aria-label="Edit search keywords"
                data-help="Add or edit local keywords that help Silo find the selected files."
              >
                <FiTag />
              </button>
              <button
                className={`btn btn-icon ${viewMode === "list" ? "active" : ""}`}
                onClick={() => setViewMode("list")}
                title="List view"
                aria-label="List view"
                data-help="Show files as rows with additional columns and details."
              >
                <FiList />
              </button>
              <button
                className={`btn btn-icon ${viewMode === "grid" ? "active" : ""}`}
                onClick={() => setViewMode("grid")}
                title="Grid view"
                aria-label="Grid view"
                data-help="Show files as a visual thumbnail grid."
              >
                <FiGrid />
              </button>
              <button
                className={`btn btn-icon ${showFilters ? "active" : ""}`}
                onClick={() => setShowFilters(!showFilters)}
                title="Sort and filter files"
                aria-label="Sort and filter files"
                data-help="Choose a sort order and filter by type, year, people, or location. These controls work in both List and Grid views."
              >
                <FiSliders /> Sort &amp; Filter
              </button>
              {(currentPath || activeDigitalFolderId) && (
                <>
                  <button
                    className="btn btn-icon"
                    onClick={selectAllFiles}
                    disabled={
                      filteredAndSortedFiles.filter((f) => !f.isDirectory)
                      .length === 0
                    }
                    title="Select all files (Cmd+A)"
                    aria-label="Select all files"
                    data-help="Select every currently visible file in this view."
                  >
                    <FiCheck />
                  </button>
                  <button
                    className="btn btn-icon"
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
            </>
          ) : appSection === "people" ? (
            <button
              className="btn btn-primary"
              onClick={createPerson}
              data-tour="new-person"
            >
              <FiUserPlus /> New Person
            </button>
          ) : null}
        </div>
      </header>

      {intensiveJobs.length > 0 && (
        <div className="indexing-performance-banner" role="status">
          <FiZap aria-hidden="true" />
          <span>
            <strong>Background processing may reduce responsiveness.</strong>{" "}
            Active: {intensiveJobs.join(", ")}. You can keep browsing; previews
            load progressively.
          </span>
        </div>
      )}
      {searchError && <div className="search-policy-error">{searchError}</div>}

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
                In development the entry may still be listed as “Electron”. Run{" "}
                <code>npm run brand-dev</code> to rename it.
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
              title="Add the selected photos or videos to a person in People"
            >
              <FiUserPlus /> Add to Person
            </button>
            <button
              onClick={() => setShowFolderSelector(true)}
              className="bulk-action-btn add-to-folder"
              title="Add selected files to a digital folder"
            >
              <FiPlus /> Add to Folder
            </button>
            <button
              onClick={() => saveSelectedFileToDevice()}
              className="bulk-action-btn save-to-device"
              title="Save selected files to device"
            >
              <FiDownload /> Save to Device
            </button>
            <button
              onClick={() => setShowLocationPicker((current) => !current)}
              className="bulk-action-btn"
              disabled={locationTargetFiles.length === 0}
              title="Assign a verified map location"
            >
              <FiMap /> Location
            </button>
            <button
              onClick={() => setSelectedFilePaths(new Set())}
              className="bulk-action-btn clear"
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
              ? `${filteredAndSortedFiles.length.toLocaleString()} matches from ${indexProgress.indexed.toLocaleString()} indexed files`
              : `${filteredAndSortedFiles.length.toLocaleString()} items`}
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

      {appSection === "files" && showFilters && (
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
            <select
              className="type-select"
              value={yearFilter}
              onChange={(event) => setYearFilter(event.target.value)}
            >
              <option value="all">All years</option>
              {yearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-section">
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
              <option value="yes">With people</option>
              <option value="no">Without people</option>
            </select>
          </div>
          <div className="filter-section">
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
          </div>
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
          {searchQuery.trim() && (
            <div className="filter-section confidence-filter">
              <h3>
                Confidence <span>{confidence}%</span>
              </h3>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={confidence}
                onChange={(event) => setConfidence(Number(event.target.value))}
              />
            </div>
          )}
        </div>
      )}

      <React.Suspense fallback={null}>
        <MemoriesLauncher api={electronAPI} ready={startupState.ready && hydrated}
          onExplore={() => setAppSection("memories")} />
      </React.Suspense>
      {appSection === "memories" ? (
        <React.Suspense fallback={<main className="viewer-status">Loading Memories…</main>}>
          <MemoriesPage api={electronAPI} ready={startupState.ready} />
        </React.Suspense>
      ) : appSection === "stats" ? (
        electronAPI ? <StatsDashboard api={electronAPI} /> : <main className="viewer-status">Stats services are unavailable.</main>
      ) : appSection === "people" ? (
        <main className="people-page" data-tour="people-page" data-help="Use People to start or pause optional offline face indexing, review clusters, name profiles, correct individual assignments, confirm matches, and merge or ban a person.">
          <section className="face-index-status" data-tour="people-index" data-help="This independent offline index detects and groups faces. It does not move or rename source files.">
            <div>
              <span className="sidebar-kicker">Secondary offline index</span>
              <h2>Face detection & clustering</h2>
              <p>{faceProgress.message}</p>
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
              onClick={
                ["loading-model", "indexing"].includes(faceProgress.status)
                  ? () => electronAPI?.pauseFaceIndexing().then(setFaceProgress)
                  : () => electronAPI?.startFaceIndexing().then(setFaceProgress)
              }
            >
              {["loading-model", "indexing"].includes(faceProgress.status) ? (
                <FiPause />
              ) : (
                <FiPlay />
              )}
              {faceProgress.status === "paused"
                ? "Resume face indexing"
                : faceProgress.status === "complete"
                  ? "Check new photos"
                  : "Start face indexing"}
            </button>
          </section>

          {personDetail ? (
            <section className="person-detail">
              <div className="person-detail-header">
                <button
                  className="back-to-people"
                  onClick={() => {
                    setSelectedPersonId(null);
                    setPersonDetail(null);
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
                </div>
                <div className="person-actions" data-tour="person-actions" data-help="These actions apply to the selected person or face cluster. Rename changes the profile label; Merge combines profiles after confirmation and can be undone.">
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
                  <button onClick={deletePerson} title="Delete person">
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
                            onOpen={() =>
                              openMediaViewer(photo, uniquePersonPhotos)
                            }
                          />
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
                      <h2>No people clustered yet</h2>
                      <p>
                        Face cards will appear automatically as indexed photos
                        are scanned.
                      </p>
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
      ) : appSection === "map" ? (
        <React.Suspense
          fallback={
            <main className="map-page">
              <div className="viewer-status">Loading globe...</div>
            </main>
          }
        >
          <MapPage
            key={`map-${contentSettings.showNsfw}-${contentSettings.showBannedPeople}-${contentSettings.autoplayGlobe}`}
            digitalFolders={digitalFolders}
            fileMetadata={fileMetadata}
            redundantPaths={redundantDuplicatePaths}
            hiddenPaths={allHiddenPaths}
            autoplay={contentSettings.autoplayGlobe}
            onOpenFile={(file, clusterFiles) =>
              void openMediaViewer(file, clusterFiles)
            }
            onStateChanged={applyPersistedState}
            onOpenFolder={(folderId) => {
              setAppSection("files");
              void openDigitalFolder(folderId);
            }}
          />
        </React.Suspense>
      ) : appSection === "duplicates" ? (
        <DuplicatesPage
          state={duplicateState}
          onStateChange={setDuplicateState}
          tourView={tourDuplicateView}
        />
      ) : appSection === "mobile" ? (
        <main className="mobile-page" data-tour="mobile-overview" data-help="Mobile manages device discovery, connections, dated browseable copies, iOS restore archives, and message history exports. Check platform and backup scope before starting an operation.">
          <PhoneManagerPanel
            devices={phoneDevices}
            tooling={phoneTooling}
            scanning={phoneScanning}
            busyDeviceId={phoneBusyId}
            activeDeviceKey={
              connectedPhone
                ? `${connectedPhone.platform}:${connectedPhone.id}`
                : null
            }
            notice={phoneNotice}
            backups={phoneBackups}
            restoreArchives={phoneRestoreArchives}
            backupDestination={phoneBackupDestination}
            onCreateRestoreArchive={createPhoneRestoreArchive}
            onRestoreFromArchive={restorePhoneFromArchive}
            formatFileSize={formatFileSize}
            onScan={() => void scanForPhones()}
            onBrowse={browsePhone}
            onConnect={connectPhone}
            onDisconnect={disconnectPhone}
            onRename={renamePhone}
            onChooseBackupDestination={() =>
              void choosePhoneBackupDestination()
            }
            onResetBackupDestination={() =>
              void resetPhoneBackupDestination()
            }
          />
          <section
            className="mobile-messages-section"
            aria-labelledby="mobile-messages-title"
          >
            <header
              className="mobile-messages-heading"
            >
              <div>
                <span className="sidebar-kicker">Conversation archive</span>
                <h2 id="mobile-messages-title">Messages</h2>
                <p>Browse, search, and export messages from supported devices.</p>
              </div>
            </header>
            <MessageExportPanel />
          </section>
        </main>
      ) : (
        <div
          className="main-container"
          data-help="Files combines your enabled sources with local indexing, semantic search, filters, virtual folders, and careful file actions. Source status and indexing progress appear in the sidebar."
          style={
            {
              "--sidebar-width": `${sidebarWidth}px`,
              "--thumbnail-size": `${thumbnailSize}px`,
            } as React.CSSProperties
          }
        >
          <aside className="library-sidebar">
            <section className="sidebar-section volumes" data-tour="source-controls" data-help="Choose which local, cloud, or saved-device sources are included in Files. Available sources can be browsed; adding a folder starts indexing.">
              <div className="sidebar-heading">
                <div>
                  <span className="sidebar-kicker">Volumes</span>
                  <h2>Sources</h2>
                </div>
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
                  onClick={() => setShowSourceClone(true)}
                  disabled={cloneableSources.length === 0}
                  title="Clone all enabled sources without modifying originals"
                  aria-label="Create a verified shelter copy"
                  data-tour="source-clone"
                  data-help="Create and verify a shelter copy of enabled sources without changing the originals."
                >
                  <FiCopy />
                </button>
                <button onClick={refreshSources} title="Refresh sources" aria-label="Refresh sources"
                  data-help="Refresh source availability and registered-source details.">
                  <FiRefreshCw />
                </button>
              </div>

              {sources.length === 0 ? (
                <p className="sidebar-empty">
                  Add a folder, phone, or Google account to get started.
                </p>
              ) : (
                <>
                  <div className="source-toggle-row">
                    <button onClick={() => setEverySource(true)}>
                      Select all
                    </button>
                    <button onClick={() => setEverySource(false)}>
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
                        className={`source-enable-toggle ${source.enabled && source.available ? "active" : ""}`}
                        disabled={!source.available}
                        onClick={() => toggleSource(source.id, !source.enabled)}
                        title={
                          source.enabled ? "Exclude source" : "Include source"
                        }
                        aria-label={source.enabled ? "Exclude source" : "Include source"}
                      >
                        <FiCheck />
                      </button>
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
                        {source.message && (
                          <small className="volume-message">
                            {source.message}
                          </small>
                        )}
                      </span>
                      {source.available && (
                        <button
                          className="volume-open"
                          onClick={(event) => {
                            event.preventDefault();
                            void navigateToPath(source.rootPath);
                          }}
                          title={`Browse ${source.label}`}
                          aria-label={`Browse ${source.label}`}
                        >
                          <FiChevronRight />
                        </button>
                      )}
                    </div>
                  ))}
                </>
              )}
              <div data-tour="indexing-progress" data-help="Review indexing stages and progress. File indexing prepares local search; face indexing is a separate optional task in People.">
                <IndexingPanel />
              </div>
            </section>

            <section
              className="sidebar-section cloud-accounts"
              data-tour="google-sources"
              data-help="Connect or reconnect Google accounts, browse Drive files, select Photos, and review or remove account access. These are separate from local folder sources."
            >
              <div className="sidebar-heading">
                <div>
                  <span className="sidebar-kicker">Cloud</span>
                  <h2>Google Accounts</h2>
                </div>
                {googleState?.configured && (
                  <button
                    onClick={googleAddAccount}
                    disabled={googleBusy}
                    title="Add another Google account"
                  >
                    <FiPlus />
                  </button>
                )}
              </div>

              {!googleState?.configured ? (
                <p className="sidebar-empty tooling-hint">
                  Add <code>GOOGLE_CLIENT_ID</code> and{" "}
                  <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code>, then
                  restart. See the README.
                </p>
              ) : (
                <>
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
            </section>

            <section
              className="sidebar-section digital-folders"
              data-tour="digital-folders"
              data-help="Create virtual collections of file references. Adding or removing a reference does not move or delete its original file."
            >
              <div className="sidebar-heading">
                <div>
                  <span className="sidebar-kicker">Virtual</span>
                  <h2>Digital Folders</h2>
                </div>
                <button
                  onClick={createDigitalFolder}
                  title="New digital folder"
                >
                  <FiPlus />
                </button>
              </div>
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
                      title="Drag to reorder folder"
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
                      title={folder.name}
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
                          ? "Refuse always hides its contents"
                          : folder.hidden
                            ? `Show ${folder.name} contents`
                            : `Hide ${folder.name} contents`
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
                      title={`Add selected file${selectedFilePaths.size === 1 ? "" : "s"} to ${folder.name}`}
                    >
                      <FiPlus />
                    </button>
                    <button
                      onClick={() => downloadDigitalFolder(folder.id)}
                      disabled={folder.filePaths.length === 0}
                      title="Save folder files to device"
                    >
                      <FiDownload />
                    </button>
                    {folder.id !== FAVORITES_FOLDER_ID &&
                      folder.id !== REFUSE_FOLDER_ID && (
                        <button
                          onClick={() => deleteDigitalFolder(folder.id)}
                          title="Delete digital folder"
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
                >
                  Remove selected reference
                </button>
              )}
            </section>
          </aside>
          <div
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
          />
          <div
            className={`file-browser ${audioOnlySelected ? "audio-only" : ""}`}
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
            {audioOnlySelected && (
              <AudioLibrary
                electronAPI={electronAPI}
                visible={appSection === "files" && audioOnlySelected}
                exploded={exploded}
                yearFilter={yearFilter}
                sort={audioSort}
                favoritePaths={favoritePaths}
                onAudioYearsChange={setAudioYearOptions}
                onToggleFavorite={(filePath) => void toggleFavorite(filePath)}
              />
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
                max="200"
                step="10"
                value={thumbnailSize}
                onChange={(event) =>
                  setThumbnailSize(Number(event.target.value))
                }
                aria-label="Thumbnail size"
              />
              <output>{thumbnailSize}px</output>
            </div>
            {loading && files.length > 0 && (
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
                  {sortIndicatorError || "Updating people and location sort…"}
                </div>
              </div>
            )}
            {!currentPath && !searchQuery.trim() && !activeDigitalFolderId ? (
              <div className="empty-state">
                <h2>No directory selected</h2>
                <p>Open a directory to get started</p>
              </div>
            ) : (loading && filteredAndSortedFiles.length === 0) ||
              (searching && searchResults.length === 0) ? (
              <div className="loading">
                <div>Scanning files...</div>
                {loading && filteredAndSortedFiles.length === 0 && (
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
                                  (current[item.year] ?? yearPageSize) + 500,
                              }))
                            }
                          >
                            Load 500 more from {item.year} (
                            {item.count.toLocaleString()} remaining)
                          </button>
                        </td>
                      </tr>
                    ) : (
                      (() => {
                        const file = item.file;
                        return (
                          <tr
                            key={file.path}
                            data-file-path={file.path}
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
                                  {Math.round(
                                    (file as SemanticSearchResult).confidence,
                                  )}
                                  %
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
                              (current[item.year] ?? yearPageSize) + 500,
                          }))
                        }
                      >
                        Load 500 more from {item.year} (
                        {item.count.toLocaleString()} remaining)
                      </button>
                    </div>
                  ) : (
                    (() => {
                      const file = item.file;
                      return (
                        <div
                          key={file.path}
                          data-file-path={file.path}
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
                                {Math.round(
                                  (file as SemanticSearchResult).confidence,
                                )}
                                % match
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
            {yearSections.folders.length < yearSections.allFolders.length && (
              <div className="load-more-container">
                <p className="results-info">
                  {yearSections.folders.length.toLocaleString()} of{" "}
                  {yearSections.allFolders.length.toLocaleString()} folders
                  shown
                </p>
                <button
                  className="load-more"
                  onClick={() => setDisplayLimit((limit) => limit + 500)}
                >
                  Load 500 more folders
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
      )}

      {showSourceClone && electronAPI && (
        <SourceClonePanel
          electronAPI={electronAPI}
          sources={cloneableSources}
          onClose={() => {
            setShowSourceClone(false);
            void refreshSources();
          }}
        />
      )}

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
                {selectedFilePaths.size > 0
                  ? `Add ${selectedFilePaths.size} files to:`
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
                    const filePaths =
                      selectedFilePaths.size > 0
                        ? Array.from(selectedFilePaths)
                        : folderSelectionFile
                          ? [folderSelectionFile]
                          : [];
                    void addFilesToFolder(folder.id, filePaths);
                  }}
                >
                  <FiFolder /> {folder.name}{" "}
                  <small>({folder.filePaths.length})</small>
                </button>
              ))}
              <button
                className="folder-option new-folder"
                onClick={() => {
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
                          const filePaths =
                            selectedFilePaths.size > 0
                              ? Array.from(selectedFilePaths)
                              : folderSelectionFile
                                ? [folderSelectionFile]
                                : [];
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
          onChange={setContentSettings}
          onClose={() => setShowSettings(false)}
          onOpenBugReport={() => setShowBugReport(true)}
          onOpenStatistics={() => {
            setAppSection("stats");
            setShowSettings(false);
          }}
          lifetimePromptRequest={lifetimePromptRequest}
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
          onClose={() => {
            setShowBugReport(false);
            setSelectingBugReportScreenshot(false);
          }}
          onScreenshotSelectionChange={(selecting) => {
            setSelectingBugReportScreenshot(selecting);
            if (selecting) setShowSettings(false);
          }}
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

      <GuidedTour
        open={showGuidedTour}
        showAtStartup={showTourAtStartup}
        contextStep={tourContextStep}
        onShowAtStartupChange={updateShowTourAtStartup}
        onNavigate={navigateGuidedTour}
        onClose={() => setShowGuidedTour(false)}
      />
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

      {viewerOpen && selectedFile && (
        <div
          className="image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label={selectedFile.name}
        >
          <div className="viewer-toolbar">
            <span className="viewer-title">
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
                    className={faceAssignmentOpen ? "active" : ""}
                    onClick={() =>
                      faceAssignmentOpen
                        ? setFaceAssignmentOpen(false)
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
                      setViewerZoom((zoom) => Math.max(zoom - 0.25, 0.25));
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
              <button onClick={() => setViewerOpen(false)} title="Close viewer">
                <FiX />
              </button>
            </div>
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
            onDoubleClick={() => {
              setViewerFit((fit) => !fit);
              setViewerZoom(1);
            }}
          >
            {!filePreview ? (
              <div className="viewer-status">Loading preview...</div>
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
                className={`viewer-image-wrap ${faceAssignmentOpen ? "face-box-editing" : ""}`}
                style={{
                  width:
                    viewerDimensions.width > 0
                      ? `${viewerDimensions.width * (viewerFit ? fittedImageScale : viewerZoom)}px`
                      : undefined,
                  maxWidth: viewerFit ? "100%" : "none",
                }}
                onPointerDown={
                  faceAssignmentOpen ? beginFaceCreation : undefined
                }
                onPointerMove={
                  faceAssignmentOpen ? updateFaceCreation : undefined
                }
                onPointerUp={
                  faceAssignmentOpen
                    ? (event) => void finishFaceCreation(event)
                    : undefined
                }
                onPointerCancel={
                  faceAssignmentOpen
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
                {faceAssignmentOpen &&
                  faceAssignmentFaces.map((face, index) => (
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
                      title={
                        face.personIds.length
                          ? `Assigned: ${face.personIds.map((id) => people.find((person) => person.id === id)?.name ?? "Person").join(", ")}`
                          : `Detected face ${index + 1}`
                      }
                    >
                      <span>
                        {face.personIds.length
                          ? face.personIds
                              .map(
                                (id) =>
                                  people.find((person) => person.id === id)
                                    ?.name,
                              )
                              .filter(Boolean)
                              .join(", ")
                          : index + 1}
                      </span>
                      <button
                        className="face-assignment-delete"
                        type="button"
                        disabled={faceAssignmentBusy}
                        aria-label="Delete detected face"
                        title="Delete this detected face"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteDetectedFace(face.id);
                        }}
                      >
                        <FiX />
                      </button>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="viewer-status">
                Preview unavailable for this item.
              </div>
            )}
          </div>
          {faceAssignmentOpen && selectedFile.type === "image" && (
            <section
              className="face-assignment-panel"
              aria-label="Add people to photo"
            >
              <header>
                <strong>Add people to photo</strong>
                <button
                  onClick={() => setFaceAssignmentOpen(false)}
                  title="Close face assignment"
                >
                  <FiX />
                </button>
              </header>
              <p>
                Select a face, then choose or create its person. Drag boxes to
                move them; Shift-click and drag over a missed face to draw an
                orange box. Use × to remove a bad detection.
              </p>
              {faceAssignmentError && (
                <small className="face-assignment-error">
                  {faceAssignmentError}
                </small>
              )}
              {faceAssignmentFaces.length > 0 && (
                <>
                  <select
                    value={faceAssignmentPersonId}
                    onChange={(event) => {
                      setFaceAssignmentPersonId(event.target.value);
                      setFaceAssignmentNewName("");
                    }}
                  >
                    <option value="">Create a new person…</option>
                    {people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                        {person.status === "banned" ? " · banned" : ""}
                      </option>
                    ))}
                  </select>
                  {!faceAssignmentPersonId && (
                    <input
                      value={faceAssignmentNewName}
                      onChange={(event) =>
                        setFaceAssignmentNewName(event.target.value)
                      }
                      placeholder="New person's name"
                    />
                  )}
                  <button
                    className="primary"
                    disabled={
                      faceAssignmentBusy ||
                      !faceAssignmentSelectedId ||
                      (!faceAssignmentPersonId && !faceAssignmentNewName.trim())
                    }
                    onClick={() => void assignSelectedFace()}
                  >
                    {faceAssignmentBusy ? "Adding…" : "Assign selected face"}
                  </button>
                </>
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
