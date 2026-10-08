import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Globe from "globe.gl";
import * as THREE from "three";
import {
  FiCheck,
  FiCircle,
  FiCompass,
  FiEdit3,
  FiFolderPlus,
  FiHeart,
  FiMapPin,
  FiMoon,
  FiPause,
  FiPlay,
  FiPlus,
  FiRefreshCw,
  FiSearch,
  FiSquare,
  FiSun,
  FiTag,
  FiUserPlus,
  FiX,
} from "react-icons/fi";
import LocationPicker from "./LocationPicker";
import { useThumbnail } from "../utils/useThumbnail";
import {
  hasThumbnailFailed,
  loadThumbnail,
  thumbnailCache,
  thumbnailCacheKey,
} from "../utils/thumbnailCache";
import { useDragSelect } from "../hooks/useDragSelect";
import {
  assignPhotosToRegions,
  buildRegions,
  regionAt,
  regionKey,
  RegionFeature,
  RegionIndex,
  withUsStates,
} from "../utils/geoRegions";
import {
  emptyMagicState,
  MagicState,
  useMagicPreferences,
  useMagicRanks,
} from "../utils/useMagicRanks";
import MagicTools from "./MagicTools";
import PersonPicker from "./PersonPicker";

function mapAssetUrl(fileName: string): string {
  return window.electron
    ? `silo-asset://local/${encodeURIComponent(fileName)}`
    : `${process.env.PUBLIC_URL}/${fileName}`;
}

interface MapPageProps {
  digitalFolders: DigitalFolder[];
  fileMetadata: Record<string, FileMetadata>;
  redundantPaths: Set<string>;
  hiddenPaths?: Set<string>;
  autoplay: boolean;
  onOpenFile: (file: FileInfo, clusterFiles: FileInfo[]) => void;
  onStateChanged: (state: PersistedAppState) => void;
  onOpenFolder?: (folderId: string) => void;
}

type SelectionShape = "rectangle" | "circle";
type SelectionScope = "places" | "regions";

interface DragShape {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  remove: boolean;
}

function applyMarkerSelection(
  button: HTMLElement,
  paths: string[],
  selected: Set<string>,
) {
  let count = 0;
  for (const filePath of paths) if (selected.has(filePath)) count += 1;
  button.classList.toggle("map-selected", count > 0 && count === paths.length);
  button.classList.toggle("map-partial", count > 0 && count < paths.length);
}

interface GeoCluster {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  photos: GeoPhoto[];
  representative: GeoPhoto;
  countryCode?: string | null;
}

function countryFlag(countryCode: string | null | undefined) {
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return "";
  return String.fromCodePoint(
    ...countryCode.split("").map((letter) => 127397 + letter.charCodeAt(0)),
  );
}

function clusterPhotos(photos: GeoPhoto[], cellSize: number): GeoCluster[] {
  const cells = new Map<string, GeoPhoto[]>();
  const uniquePhotos = Array.from(
    new Map(photos.map((photo) => [photo.path, photo])).values(),
  );
  for (const photo of uniquePhotos) {
    if (
      !Number.isFinite(photo.latitude) ||
      !Number.isFinite(photo.longitude) ||
      photo.latitude < -90 ||
      photo.latitude > 90 ||
      photo.longitude < -180 ||
      photo.longitude > 180
    )
      continue;
    const latitudeCell = Math.floor((photo.latitude + 90) / cellSize);
    // Narrow longitude cells toward the poles so clusters stay roughly square on screen.
    const longitudeCellSize =
      cellSize /
      Math.max(0.2, Math.cos(THREE.MathUtils.degToRad(photo.latitude)));
    const longitudeCell = Math.floor(
      (photo.longitude + 180) / longitudeCellSize,
    );
    const key = `${latitudeCell}:${longitudeCell}`;
    const existing = cells.get(key) ?? [];
    existing.push(photo);
    cells.set(key, existing);
  }
  return Array.from(cells.entries()).map(([id, cellPhotos]) => {
    const latitude =
      cellPhotos.reduce((sum, photo) => sum + photo.latitude, 0) /
      cellPhotos.length;
    const longitude =
      cellPhotos.reduce((sum, photo) => sum + photo.longitude, 0) /
      cellPhotos.length;
    const named = cellPhotos.find(
      (photo) => photo.city || photo.region || photo.country,
    );
    return {
      id,
      latitude,
      longitude,
      label: named?.locationLabel ?? cellPhotos[0].locationLabel,
      photos: cellPhotos,
      representative: cellPhotos.reduce((best, photo) =>
        photo.size > best.size ? photo : best,
      ),
    };
  });
}

function MapPhotoThumbnail({ photo }: { photo: GeoPhoto }) {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { thumbnail } = useThumbnail(photo.path, visible, true);

  return (
    <span
      ref={containerRef}
      className="map-photo-thumbnail"
      data-photo-path={photo.path}
    >
      {thumbnail ? (
        <img key={photo.path} src={thumbnail} alt="" />
      ) : (
        <FiMapPin />
      )}
    </span>
  );
}

// Lowest camera altitude in globe radii (~130 m above ground).
const MIN_ALTITUDE = 0.00002;

// Roughly one marker width in degrees, snapped to powers of two so zooming re-clusters in steps.
function cellSizeForAltitude(altitude: number) {
  const size = Math.pow(
    2,
    Math.round(Math.log2(Math.max(altitude, MIN_ALTITUDE) * 4)),
  );
  return Math.min(16, Math.max(1 / 65536, size));
}

const THUMBNAIL_EXTENSION_RANK: Record<string, number> = {
  ".jpg": 0,
  ".jpeg": 0,
  ".heic": 0,
  ".heif": 0,
  ".png": 1,
  ".webp": 1,
  ".gif": 2,
  ".tif": 2,
  ".tiff": 2,
};
const VIDEO_EXTENSIONS = new Set([
  ".mov",
  ".mp4",
  ".m4v",
  ".avi",
  ".mkv",
  ".3gp",
]);

function thumbnailRank(photo: GeoPhoto) {
  const extension = photo.path.slice(photo.path.lastIndexOf(".")).toLowerCase();
  return (
    THUMBNAIL_EXTENSION_RANK[extension] ??
    (VIDEO_EXTENSIONS.has(extension) ? 4 : 3)
  );
}

/** Photos most likely to produce a thumbnail first: common still formats, then larger files. */
function thumbnailCandidates(photos: GeoPhoto[], limit = 6) {
  return photos
    .filter((photo) => !hasThumbnailFailed(photo.path))
    .sort((a, b) => thumbnailRank(a) - thumbnailRank(b) || b.size - a.size)
    .slice(0, limit);
}

function cachedClusterThumbnail(cluster: { photos: GeoPhoto[] }) {
  const scanLimit = Math.min(cluster.photos.length, 400);
  for (let index = 0; index < scanLimit; index += 1) {
    const url = thumbnailCache.peek(
      thumbnailCacheKey(cluster.photos[index].path),
    );
    if (url) return url;
  }
  return null;
}

function utcHourNow() {
  const now = new Date();
  return (
    now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600
  );
}

function solarDeclination() {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      start) /
      86400000,
  );
  return (
    23.44 * Math.sin(THREE.MathUtils.degToRad((360 / 365) * (dayOfYear - 81)))
  );
}

function solarDirection(utcHour: number) {
  const longitude = (12 - utcHour) * 15;
  const phi = THREE.MathUtils.degToRad(90 - solarDeclination());
  const theta = THREE.MathUtils.degToRad(90 - longitude);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  ).normalize();
}

function normalizeHour(hour: number) {
  return ((hour % 24) + 24) % 24;
}

function viewedSolarHour(utcHour: number, longitude: number) {
  return normalizeHour(utcHour + longitude / 15);
}

function utcHourForView(desiredSolarHour: number, longitude: number) {
  return normalizeHour(desiredSolarHour - longitude / 15);
}

function formatSolarTime(hour: number) {
  const totalMinutes = Math.round(hour * 60) % (24 * 60);
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (totalMinutes % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function createGeographicGuides(globe: any) {
  const guides = new THREE.Group();
  const createLine = (
    coordinates: Array<{ lat: number; lng: number }>,
    primary: boolean,
  ) => {
    const points = coordinates.map(({ lat, lng }) => {
      const point = globe.getCoords(lat, lng, 0.002);
      return new THREE.Vector3(point.x, point.y, point.z);
    });
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: primary ? 0xd9eadf : 0x9eb5aa,
      transparent: true,
      opacity: primary ? 0.52 : 0.18,
    });
    guides.add(new THREE.Line(geometry, material));
  };
  for (const latitude of [-60, -30, 0, 30, 60]) {
    createLine(
      Array.from({ length: 181 }, (_, index) => ({
        lat: latitude,
        lng: index * 2 - 180,
      })),
      latitude === 0,
    );
  }
  for (let longitude = -150; longitude <= 180; longitude += 30) {
    createLine(
      Array.from({ length: 181 }, (_, index) => ({
        lat: index - 90,
        lng: longitude,
      })),
      longitude === 0 || longitude === 180,
    );
  }
  return guides;
}

type RegionSort = "name" | "size" | "date" | "type" | "magic";
const NO_PHOTOS: GeoPhoto[] = [];
const FAVORITES_FOLDER_ID = "__favorites__";

export default function MapPage({
  digitalFolders,
  fileMetadata,
  redundantPaths,
  hiddenPaths,
  autoplay,
  onOpenFile,
  onStateChanged,
  onOpenFolder,
}: MapPageProps) {
  const electronAPI = window.electron;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<any>(null);
  const sunDirectionRef = useRef<THREE.Vector3 | null>(null);
  const markerClickTimerRef = useRef<number | null>(null);
  const [geoState, setGeoState] = useState<GeoIndexState>({
    status: "idle",
    scanned: 0,
    total: 0,
    geotagged: 0,
    message: "Loading photo locations…",
    photos: [],
    photosVersion: -1,
  });
  const [photosLoaded, setPhotosLoaded] = useState(false);
  const [altitude, setAltitude] = useState(3.2);
  const [selectedCluster, setSelectedCluster] = useState<GeoCluster | null>(
    null,
  );
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [targetFolder, setTargetFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [regionSort, setRegionSort] = useState<RegionSort>("date");
  const [regionSortAscending, setRegionSortAscending] = useState(false);
  const [heading, setHeading] = useState(0);
  const [autoRotate, setAutoRotate] = useState(autoplay);
  const [utcHour, setUtcHour] = useState(utcHourNow);
  const [solarHour, setSolarHour] = useState(() =>
    viewedSolarHour(utcHourNow(), -20),
  );
  const utcHourRef = useRef(utcHour);
  const manualSolarTimeRef = useRef(false);
  const [detailSurfaceActive, setDetailSurfaceActive] = useState(false);
  const [metadataName, setMetadataName] = useState("");
  const [metadataKeywords, setMetadataKeywords] = useState("");
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [clusterSearch, setClusterSearch] = useState("");
  const [clusterSearchPaths, setClusterSearchPaths] =
    useState<Set<string> | null>(null);
  const [clusterSearching, setClusterSearching] = useState(false);
  const markerImagesRef = useRef(new Map<string, HTMLElement>());
  const markerButtonsRef = useRef(
    new Map<string, { button: HTMLElement; paths: string[] }>(),
  );
  const [regionFeatures, setRegionFeatures] = useState<RegionFeature[]>([]);
  const [selectionRegions, setSelectionRegions] = useState<Set<string>>(
    new Set(),
  );
  const [selectionPlaces, setSelectionPlaces] = useState<Set<string>>(
    new Set(),
  );
  const [selectionExcluded, setSelectionExcluded] = useState<Set<string>>(
    new Set(),
  );
  const [selectShape, setSelectShape] = useState<SelectionShape>("rectangle");
  const [selectScope, setSelectScope] = useState<SelectionScope>("places");
  const [dragShape, setDragShape] = useState<DragShape | null>(null);
  const [selectionArmed, setSelectionArmed] = useState(false);
  const [albumMenuOpen, setAlbumMenuOpen] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [mapNotice, setMapNotice] = useState("");
  const clearSelection = useCallback(() => {
    setSelectionRegions(new Set());
    setSelectionPlaces(new Set());
    setSelectionExcluded(new Set());
  }, []);
  // Globe callbacks are registered once; these refs give them the latest React state.
  const selectionRef = useRef<{ regions: Set<string>; paths: Set<string> }>({
    regions: new Set(),
    paths: new Set(),
  });
  const regionActionsRef = useRef({
    count: (_key: string) => 0,
    open: (_key: string) => undefined as void,
    togglePlace: (_paths: string[]) => undefined as void,
  });
  const refreshPolygonStylesRef = useRef<() => void>(() => undefined);
  const dragContextRef = useRef<{
    clusters: GeoCluster[];
    regionIndex: RegionIndex | null;
    regionFeatures: RegionFeature[];
    selectShape: SelectionShape;
    selectScope: SelectionScope;
    updateSelection: (
      paths: string[],
      regionKeys: string[],
      remove: boolean,
    ) => void;
  } | null>(null);
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const altitudeRef = useRef(altitude);
  altitudeRef.current = altitude;

  // Clustering only depends on the altitude band, so zooming within a band costs nothing.
  const cellSize = cellSizeForAltitude(altitude);
  const mappedPhotos = useMemo(
    () =>
      geoState.photos.filter(
        (photo) =>
          !redundantPaths.has(photo.path) && !hiddenPaths?.has(photo.path),
      ),
    [geoState.photos, hiddenPaths, redundantPaths],
  );
  const clusters = useMemo(
    () => clusterPhotos(mappedPhotos, cellSize),
    [cellSize, mappedPhotos],
  );
  const regionIndex = useMemo(
    () =>
      regionFeatures.length > 0
        ? assignPhotosToRegions(regionFeatures, mappedPhotos)
        : null,
    [mappedPhotos, regionFeatures],
  );
  const regionsByKey = useMemo(
    () => new Map(regionFeatures.map((region) => [region.key, region])),
    [regionFeatures],
  );
  const selectedPathSet = useMemo(() => {
    const paths = new Set(selectionPlaces);
    selectionRegions.forEach((key) =>
      regionIndex?.byRegion.get(key)?.forEach((photo) => paths.add(photo.path)),
    );
    selectionExcluded.forEach((filePath) => paths.delete(filePath));
    return paths;
  }, [regionIndex, selectionExcluded, selectionPlaces, selectionRegions]);
  selectionRef.current = { regions: selectionRegions, paths: selectedPathSet };
  const [magicState, setMagicState] = useState<MagicState>(emptyMagicState);
  const [personPicker, setPersonPicker] = useState<{
    x: number;
    y: number;
    paths: string[];
  } | null>(null);
  const [regionNotice, setRegionNotice] = useState("");
  const magicPrefs = useMagicPreferences();
  useMagicRanks(
    regionSort === "magic" && Boolean(selectedCluster),
    selectedCluster?.photos ?? NO_PHOTOS,
    setMagicState,
    magicPrefs.preset,
  );
  const sortedRegionPhotos = useMemo(() => {
    if (!selectedCluster) return [];
    const direction = regionSortAscending ? 1 : -1;
    return selectedCluster.photos
      .filter((photo) => !hiddenPaths?.has(photo.path))
      .sort((left, right) => {
        if (regionSort === "magic") {
          // Always best first; unanalyzed photos fall to the end, newest first.
          const leftRank =
            magicState.ranks.get(left.path) ?? Number.POSITIVE_INFINITY;
          const rightRank =
            magicState.ranks.get(right.path) ?? Number.POSITIVE_INFINITY;
          if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
          return (
            right.modified - left.modified ||
            left.path.localeCompare(right.path)
          );
        }
        let comparison = 0;
        if (regionSort === "name")
          comparison = (
            fileMetadata[left.path]?.displayName || left.name
          ).localeCompare(
            fileMetadata[right.path]?.displayName || right.name,
            undefined,
            { numeric: true },
          );
        else if (regionSort === "size") comparison = left.size - right.size;
        else if (regionSort === "date")
          comparison = left.modified - right.modified;
        else comparison = left.extension.localeCompare(right.extension);
        return comparison === 0
          ? left.path.localeCompare(right.path)
          : comparison * direction;
      });
  }, [
    fileMetadata,
    hiddenPaths,
    magicState.ranks,
    regionSort,
    regionSortAscending,
    selectedCluster,
  ]);

  useEffect(() => {
    if (!hiddenPaths?.size) return;
    setSelectedPaths((current) =>
      Array.from(current).some((filePath) => hiddenPaths.has(filePath))
        ? new Set(
            Array.from(current).filter(
              (filePath) => !hiddenPaths.has(filePath),
            ),
          )
        : current,
    );
  }, [hiddenPaths]);
  const visibleRegionPhotos = useMemo(
    () =>
      clusterSearch.trim() && clusterSearchPaths
        ? sortedRegionPhotos.filter((photo) =>
            clusterSearchPaths.has(photo.path),
          )
        : sortedRegionPhotos,
    [clusterSearch, clusterSearchPaths, sortedRegionPhotos],
  );

  useEffect(() => {
    const query = clusterSearch.trim().toLowerCase();
    if (!selectedCluster || !query) {
      setClusterSearchPaths(null);
      setClusterSearching(false);
      return;
    }
    const allowedPaths = new Set(
      selectedCluster.photos.map((photo) => photo.path),
    );
    const localMatches = new Set(
      selectedCluster.photos
        .filter((photo) => {
          const metadata = fileMetadata[photo.path];
          return (
            photo.name.toLowerCase().includes(query) ||
            metadata?.displayName?.toLowerCase().includes(query) ||
            metadata?.keywords.some((keyword) =>
              keyword.toLowerCase().includes(query),
            )
          );
        })
        .map((photo) => photo.path),
    );
    let cancelled = false;
    setClusterSearching(true);
    const timer = window.setTimeout(() => {
      void electronAPI
        ?.semanticSearch(clusterSearch.trim(), 0)
        .then((results) => {
          if (cancelled) return;
          for (const result of results)
            if (allowedPaths.has(result.path)) localMatches.add(result.path);
          setClusterSearchPaths(localMatches);
        })
        .finally(() => {
          if (!cancelled) setClusterSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clusterSearch, electronAPI, fileMetadata, selectedCluster]);

  useEffect(() => {
    if (selectedPaths.size !== 1) {
      setMetadataName("");
      setMetadataKeywords("");
      return;
    }
    const filePath = Array.from(selectedPaths)[0];
    const metadata = fileMetadata[filePath];
    setMetadataName(metadata?.displayName || "");
    setMetadataKeywords(metadata?.keywords.join(", ") || "");
  }, [fileMetadata, selectedPaths]);

  useDragSelect({
    scopeSelector: ".map-region-grid",
    onSelectionChange: (paths, additive) =>
      setSelectedPaths((prev) => {
        if (!additive) return paths;
        const next = new Set(prev);
        paths.forEach((path) => next.add(path));
        return next;
      }),
    onToggle: (path) =>
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
  });

  useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    let loadedVersion = -1;
    let fetching = false;
    let lastFetchAt = 0;
    let pendingTimer: number | null = null;

    const fetchPhotos = () => {
      if (fetching) return;
      fetching = true;
      lastFetchAt = Date.now();
      void electronAPI
        .getGeoState()
        .then((state) => {
          if (!active) return;
          loadedVersion = state.photosVersion;
          setGeoState(state);
          setPhotosLoaded(true);
        })
        .finally(() => {
          fetching = false;
        });
    };
    fetchPhotos();

    const removeListener = electronAPI.onGeoIndexProgress((status) => {
      if (!active) return;
      setGeoState((current) => ({
        ...status,
        photos: current.photos,
        photosVersion: current.photosVersion,
      }));
      if (status.photosVersion === loadedVersion) return;
      // While scanning, pull the full photo list at most every 8s; always pull once on completion.
      const wait =
        status.status === "complete"
          ? 0
          : Math.max(0, 8000 - (Date.now() - lastFetchAt));
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        fetchPhotos();
      }, wait);
    });
    return () => {
      active = false;
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
      removeListener();
    };
  }, [electronAPI]);

  useEffect(() => {
    if (!containerRef.current || globeRef.current) return;
    let disposed = false;
    const textureLoader = new THREE.TextureLoader();
    const dayTexture = textureLoader.load(
      mapAssetUrl("earth-blue-marble.jpg"),
    );
    const nightTexture = textureLoader.load(
      mapAssetUrl("earth-night.jpg"),
    );
    let detailedBorders: any[] | null = null;
    let detailedBordersLoading = false;
    let baseBorders: any[] = [];
    let usingDetailedBorders = false;
    let bordersHidden = false;
    let tileEngineActive = false;
    dayTexture.colorSpace = THREE.SRGBColorSpace;
    nightTexture.colorSpace = THREE.SRGBColorSpace;
    const sunDirection = solarDirection(utcHourRef.current);
    sunDirectionRef.current = sunDirection;
    const globeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        dayTexture: { value: dayTexture },
        nightTexture: { value: nightTexture },
        sunDirection: { value: sunDirection },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D dayTexture;
        uniform sampler2D nightTexture;
        uniform vec3 sunDirection;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        void main() {
          float daylight = smoothstep(-0.16, 0.24, dot(normalize(vWorldNormal), sunDirection));
          vec3 day = texture2D(dayTexture, vUv).rgb;
          vec3 cityLights = texture2D(nightTexture, vUv).rgb;
          vec3 nightSurface = day * vec3(0.38, 0.43, 0.52) + vec3(0.008, 0.012, 0.02);
          vec3 cityGlow = pow(cityLights, vec3(0.72)) * 3.6;
          vec3 visibleNight = max(nightSurface, cityGlow);
          vec3 visibleDay = min(pow(day, vec3(0.62)) * 1.32, vec3(1.0));
          vec3 color = mix(visibleNight, visibleDay, daylight);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    const globe = new (Globe as any)(containerRef.current)
      .globeMaterial(globeMaterial)
      .backgroundColor("#050709")
      .showAtmosphere(true)
      .atmosphereColor("#8fc5d8")
      .atmosphereAltitude(0.15)
      .htmlTransitionDuration(250);
    const starPositions = new Float32Array(2600 * 3);
    for (let index = 0; index < 2600; index += 1) {
      const azimuth = Math.random() * Math.PI * 2;
      const vertical = Math.random() * 2 - 1;
      const horizontal = Math.sqrt(1 - vertical * vertical);
      const radius = 1600 + Math.random() * 1000;
      starPositions[index * 3] = Math.cos(azimuth) * horizontal * radius;
      starPositions[index * 3 + 1] = vertical * radius;
      starPositions[index * 3 + 2] = Math.sin(azimuth) * horizontal * radius;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(starPositions, 3),
    );
    const starMaterial = new THREE.PointsMaterial({
      color: "#dce9ff",
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    globe.scene().add(stars);
    const nightOverlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        nightTexture: { value: nightTexture },
        sunDirection: { value: sunDirection },
      },
      vertexShader: `
        varying vec3 vLocal;
        varying vec3 vWorldNormal;
        void main() {
          vLocal = normalize(position);
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D nightTexture;
        uniform vec3 sunDirection;
        varying vec3 vLocal;
        varying vec3 vWorldNormal;
        const float PI = 3.141592653589793;
        void main() {
          // Same lat/lng convention as globe.getCoords, so lights match tiles and markers.
          vec3 p = normalize(vLocal);
          float lat = asin(clamp(p.y, -1.0, 1.0));
          float lng = atan(p.x, p.z);
          float u = lng / (2.0 * PI) + 0.5;
          // Pick the seam-free parameterisation per pixel to avoid a mip seam at the antimeridian.
          float u1 = fract(u);
          float u2 = fract(u + 0.5) - 0.5;
          float uSafe = fwidth(u1) <= fwidth(u2) + 1e-6 ? u1 : u2;
          vec2 uv = vec2(uSafe, lat / PI + 0.5);
          float daylight = smoothstep(-0.16, 0.24, dot(normalize(vWorldNormal), sunDirection));
          float night = 1.0 - daylight;
          vec3 lights = pow(texture2D(nightTexture, uv).rgb, vec3(0.72)) * 2.8;
          vec3 nightColor = max(vec3(0.012, 0.02, 0.034), lights);
          gl_FragColor = vec4(nightColor, night * 0.78);
        }
      `,
      transparent: true,
      depthWrite: false,
      // Tiles are faceted spheres that intersect any nearby shell; draw as a pure screen overlay instead.
      depthTest: false,
    });
    nightTexture.wrapS = THREE.RepeatWrapping;
    const nightOverlay = new THREE.Mesh(
      new THREE.SphereGeometry(globe.getGlobeRadius() * 1.0005, 192, 96),
      nightOverlayMaterial,
    );
    nightOverlay.visible = false;
    nightOverlay.renderOrder = 10;
    globe.scene().add(nightOverlay);
    const maximumAnisotropy = globe.renderer().capabilities.getMaxAnisotropy();
    dayTexture.anisotropy = maximumAnisotropy;
    nightTexture.anisotropy = maximumAnisotropy;
    globe.pointOfView({ lat: 22, lng: -20, altitude: 3.2 }, 0);
    globe.controls().enableDamping = true;
    globe.controls().dampingFactor = 0.16;
    globe.controls().rotateSpeed = 0.72;
    globe.controls().minDistance = globe.getGlobeRadius() * (1 + MIN_ALTITUDE);
    globe.controls().autoRotate = autoplay;
    globe.controls().autoRotateSpeed = 0.08;
    const tuneCameraForAltitude = () => {
      const camera = globe.camera();
      const surfaceDistance = camera.position.length() - globe.getGlobeRadius();
      const near = Math.min(0.05, Math.max(0.00001, surfaceDistance * 0.25));
      if (Math.abs(camera.near - near) > near * 0.1) {
        camera.near = near;
        camera.updateProjectionMatrix();
      }
      // Runs after globe.gl's own handler: each wheel step moves a fixed share of the current altitude.
      const altitude = surfaceDistance / globe.getGlobeRadius();
      globe.controls().zoomSpeed = Math.min(
        1.5,
        Math.max(0.0005, (2.9 * altitude) / (1 + altitude)),
      );
    };
    globe.controls().addEventListener("change", tuneCameraForAltitude);
    const geographicGuides = createGeographicGuides(globe);
    globe.scene().add(geographicGuides);
    let hoveredCountry: any = null;
    let usStates: any[] = [];
    let lastPolygonClick: { key: string; at: number } | null = null;
    const isSelectedRegion = (item: any) =>
      selectionRef.current.regions.has(regionKey(item));
    const capColor = (item: any) =>
      isSelectedRegion(item) ? "rgba(255, 122, 26, 0.3)" : "rgba(0, 0, 0, 0)";
    const strokeColor = (item: any) =>
      item === hoveredCountry
        ? "rgba(255, 205, 106, 1)"
        : isSelectedRegion(item)
          ? "rgba(255, 140, 50, 1)"
          : "rgba(233, 242, 237, 0.72)";
    refreshPolygonStylesRef.current = () => {
      if (!bordersHidden)
        globe.polygonCapColor(capColor).polygonStrokeColor(strokeColor);
    };
    const configureCountryLayer = (features: any[]) => {
      if (bordersHidden) return;
      globe
        .polygonsData(withUsStates(features, usStates))
        .polygonCapColor(capColor)
        .polygonSideColor(() => "rgba(0, 0, 0, 0)")
        .polygonStrokeColor(strokeColor)
        .polygonAltitude((country: any) =>
          country === hoveredCountry ? 0.009 : 0.0018,
        )
        .polygonCapCurvatureResolution(1)
        .polygonsTransitionDuration(140)
        .polygonLabel((country: any) => {
          const properties = country.properties || {};
          const name = properties.NAME || properties.ADMIN || "Unknown region";
          const code =
            properties.KIND === "state"
              ? "US"
              : properties.ISO_A2_EH || properties.ISO_A2;
          const count = regionActionsRef.current.count(regionKey(country));
          const photos =
            count > 0
              ? `<small>${count.toLocaleString()} photo${count === 1 ? "" : "s"}</small>`
              : "";
          return `<div class="map-country-label"><span>${countryFlag(code)}</span><strong>${name}</strong>${photos}</div>`;
        })
        .onPolygonClick((country: any) => {
          const key = regionKey(country);
          const now = Date.now();
          if (
            lastPolygonClick?.key === key &&
            now - lastPolygonClick.at < 450
          ) {
            lastPolygonClick = null;
            regionActionsRef.current.open(key);
          } else {
            lastPolygonClick = { key, at: now };
          }
        })
        .onPolygonHover((country: any) => {
          hoveredCountry = country;
          globe
            .polygonAltitude((item: any) =>
              item === hoveredCountry ? 0.009 : 0.0018,
            )
            .polygonStrokeColor(strokeColor);
        });
    };
    void fetch(mapAssetUrl("us-states.geojson"))
      .then((response) => response.json())
      .then((geoJson) => {
        if (disposed) return;
        usStates = geoJson.features;
        if (baseBorders.length > 0)
          configureCountryLayer(
            usingDetailedBorders && detailedBorders
              ? detailedBorders
              : baseBorders,
          );
      })
      .catch(() => undefined);
    let borderIdleHandle: number | null = null;
    void fetch(mapAssetUrl("countries.geojson"))
      .then((response) => response.json())
      .then((geoJson) => {
        if (disposed) return;
        baseBorders = geoJson.features;
        // Building ~250 polygon meshes is a long task; let the intro animation render first.
        borderIdleHandle = window.requestIdleCallback(
          () => {
            borderIdleHandle = null;
            if (!disposed && !usingDetailedBorders)
              configureCountryLayer(baseBorders);
          },
          { timeout: 2000 },
        );
      })
      .catch(() => undefined);

    const updateSurfaceResolution = (nextAltitude: number) => {
      geographicGuides.visible = nextAltitude > 0.3;
      // Borders float a few km up; hide them near the ground so they don't cut across streets.
      const hideBorders = nextAltitude < 0.04;
      if (hideBorders !== bordersHidden) {
        bordersHidden = hideBorders;
        if (hideBorders) globe.polygonsData([]);
        else
          configureCountryLayer(
            usingDetailedBorders && detailedBorders
              ? detailedBorders
              : baseBorders,
          );
      }
      if (nextAltitude < 0.95) {
        if (!tileEngineActive) {
          globe
            .globeTileEngineMaxLevel(19)
            .globeTileEngineUrl(
              (x: number, y: number, level: number) =>
                `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${level}/${y}/${x}`,
            );
          tileEngineActive = true;
          nightOverlay.visible = true;
          setDetailSurfaceActive(true);
        }
        if (!usingDetailedBorders && detailedBorders) {
          configureCountryLayer(detailedBorders);
          usingDetailedBorders = true;
        } else if (!usingDetailedBorders && !detailedBordersLoading) {
          detailedBordersLoading = true;
          void fetch(mapAssetUrl("countries-50m.geojson"))
            .then((response) => response.json())
            .then((geoJson) => {
              detailedBordersLoading = false;
              if (disposed) return;
              detailedBorders = geoJson.features;
              if (globe.pointOfView().altitude < 1.2) {
                configureCountryLayer(detailedBorders!);
                usingDetailedBorders = true;
              }
            })
            .catch(() => {
              detailedBordersLoading = false;
            });
        }
      } else if (nextAltitude > 1.25) {
        if (tileEngineActive) {
          globe.globeTileEngineUrl(null);
          globe.globeTileEngineClearCache();
          tileEngineActive = false;
          nightOverlay.visible = false;
          setDetailSurfaceActive(false);
        }
        if (usingDetailedBorders && baseBorders.length > 0) {
          configureCountryLayer(baseBorders);
          usingDetailedBorders = false;
        }
      }
      nightOverlay.visible = tileEngineActive && nextAltitude > 0.01;
    };
    const onControlsChange = () => {
      const pointOfView = globe.pointOfView();
      const nextAltitude = pointOfView.altitude;
      // Rounded values let React bail out of re-renders for sub-degree/sub-minute changes.
      setAltitude((current) =>
        Math.abs(Math.log(nextAltitude / current)) > 0.15
          ? nextAltitude
          : current,
      );
      setHeading(Math.round(((pointOfView.lng % 360) + 360) % 360));
      setSolarHour(
        Math.round(viewedSolarHour(utcHourRef.current, pointOfView.lng) * 60) /
          60,
      );
      updateSurfaceResolution(nextAltitude);
    };
    // OrbitControls fires "change" many times per frame while dragging; coalesce to one per frame.
    let controlsFrame: number | null = null;
    const scheduleControlsChange = () => {
      if (controlsFrame !== null) return;
      controlsFrame = requestAnimationFrame(() => {
        controlsFrame = null;
        onControlsChange();
      });
    };
    globe.controls().addEventListener("change", scheduleControlsChange);
    const observer = new ResizeObserver(() => {
      if (!containerRef.current) return;
      globe
        .width(containerRef.current.clientWidth)
        .height(containerRef.current.clientHeight);
    });
    observer.observe(containerRef.current);
    globeRef.current = globe;
    return () => {
      disposed = true;
      if (controlsFrame !== null) cancelAnimationFrame(controlsFrame);
      if (borderIdleHandle !== null)
        window.cancelIdleCallback(borderIdleHandle);
      observer.disconnect();
      globe.controls().removeEventListener("change", scheduleControlsChange);
      globe.controls().removeEventListener("change", tuneCameraForAltitude);
      globe.scene().remove(geographicGuides);
      globe.scene().remove(nightOverlay);
      globe.scene().remove(stars);
      starGeometry.dispose();
      starMaterial.dispose();
      geographicGuides.traverse((object) => {
        if (object instanceof THREE.Line) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
      dayTexture.dispose();
      nightTexture.dispose();
      nightOverlay.geometry.dispose();
      nightOverlayMaterial.dispose();
      globeMaterial.dispose();
      sunDirectionRef.current = null;
      globe._destructor?.();
      globeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (globeRef.current) globeRef.current.controls().autoRotate = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    utcHourRef.current = utcHour;
    sunDirectionRef.current?.copy(solarDirection(utcHour));
    const longitude = globeRef.current?.pointOfView().lng ?? -20;
    setSolarHour(viewedSolarHour(utcHour, longitude));
  }, [utcHour]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!manualSolarTimeRef.current) setUtcHour(utcHourNow());
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);

  const setLightingForView = useCallback((mode: "day" | "night") => {
    const longitude = globeRef.current?.pointOfView().lng ?? 0;
    manualSolarTimeRef.current = true;
    setUtcHour(utcHourForView(mode === "day" ? 12 : 0, longitude));
  }, []);

  const resetOrientation = useCallback(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const current = globe.pointOfView();
    globe.pointOfView(
      { lat: 8, lng: current.lng, altitude: Math.max(current.altitude, 1.4) },
      900,
    );
  }, []);

  const openCluster = useCallback(
    (cluster: GeoCluster) => {
      if (markerClickTimerRef.current !== null) {
        window.clearTimeout(markerClickTimerRef.current);
        markerClickTimerRef.current = null;
      }
      setSelectedCluster(cluster);
      setSelectedPaths(new Set());
      setClusterSearch("");
      setClusterSearchPaths(null);
      globeRef.current?.pointOfView(
        {
          lat: cluster.latitude,
          lng: cluster.longitude,
          altitude: Math.min(0.38, altitudeRef.current),
        },
        900,
      );
      if (
        !cluster.photos.some(
          (photo) => photo.city || photo.region || photo.country,
        )
      ) {
        void electronAPI
          ?.reverseGeocode(cluster.latitude, cluster.longitude)
          .then((place) => {
            if (!place) return;
            setSelectedCluster((current) =>
              current?.id === cluster.id
                ? {
                    ...current,
                    label: place.label,
                    countryCode: place.countryCode,
                  }
                : current,
            );
          });
      }
    },
    [electronAPI],
  );

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    markerImagesRef.current.clear();
    markerButtonsRef.current.clear();
    globe
      .htmlElementsData(clusters)
      .htmlLat((cluster: GeoCluster) => cluster.latitude)
      .htmlLng((cluster: GeoCluster) => cluster.longitude)
      .htmlAltitude(0)
      .htmlElement((cluster: GeoCluster) => {
        const button = document.createElement("button");
        button.className = "geo-marker";
        button.type = "button";
        button.style.pointerEvents = "auto";
        button.style.touchAction = "manipulation";
        button.draggable = false;
        button.title = `${cluster.label} · ${cluster.photos.length} photos`;
        const image = document.createElement("span");
        image.className = "geo-marker-image";
        const thumbnail = cachedClusterThumbnail(cluster);
        if (thumbnail) image.style.backgroundImage = `url("${thumbnail}")`;
        else {
          image.classList.add("loading");
          markerImagesRef.current.set(cluster.id, image);
        }
        const count = document.createElement("span");
        count.className = "geo-marker-count";
        count.textContent = cluster.photos.length.toLocaleString();
        button.append(image, count);
        const paths = cluster.photos.map((photo) => photo.path);
        markerButtonsRef.current.set(cluster.id, { button, paths });
        applyMarkerSelection(button, paths, selectionRef.current.paths);
        button.addEventListener("pointerenter", () => {
          if (globeRef.current) globeRef.current.controls().autoRotate = false;
        });
        button.addEventListener("pointerleave", () => {
          if (globeRef.current)
            globeRef.current.controls().autoRotate = autoRotateRef.current;
        });
        button.addEventListener("pointerdown", (event) => {
          event.stopPropagation();
          if (globeRef.current) globeRef.current.controls().autoRotate = false;
        });
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          if (event.shiftKey) {
            regionActionsRef.current.togglePlace(paths);
            return;
          }
          if (markerClickTimerRef.current !== null)
            window.clearTimeout(markerClickTimerRef.current);
          markerClickTimerRef.current = window.setTimeout(() => {
            markerClickTimerRef.current = null;
            globeRef.current?.pointOfView(
              {
                lat: cluster.latitude,
                lng: cluster.longitude,
                altitude: Math.max(MIN_ALTITUDE * 4, altitudeRef.current * 0.3),
              },
              650,
            );
          }, 240);
        });
        button.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) return;
          openCluster(cluster);
        });
        return button;
      });
  }, [clusters, openCluster]);

  useEffect(() => {
    if (!electronAPI) return;
    const view = globeRef.current?.pointOfView() ?? { lat: 0, lng: 0 };
    const viewCos = Math.cos(THREE.MathUtils.degToRad(view.lat));
    const distanceFromView = (cluster: GeoCluster) => {
      const dLng = ((cluster.longitude - view.lng + 540) % 360) - 180;
      return (cluster.latitude - view.lat) ** 2 + (dLng * viewCos) ** 2;
    };
    // Markers nearest the camera load first; each tries several photos until one renders.
    // Elements may be created after this runs; they read the shared cache on creation.
    const pending = clusters
      .filter((cluster) => !cachedClusterThumbnail(cluster))
      .sort((a, b) => distanceFromView(a) - distanceFromView(b))
      .slice(0, 500);
    if (pending.length === 0) return;
    let cancelled = false;
    let next = 0;

    const worker = async () => {
      while (!cancelled && next < pending.length) {
        const cluster = pending[next++];
        for (const photo of thumbnailCandidates(cluster.photos)) {
          if (cancelled) return;
          const url = await loadThumbnail(photo.path, true);
          if (!url) continue;
          const image = markerImagesRef.current.get(cluster.id);
          if (image && !cancelled) {
            image.classList.remove("loading");
            image.style.backgroundImage = `url("${url}")`;
            markerImagesRef.current.delete(cluster.id);
          }
          break;
        }
      }
    };
    for (let index = 0; index < 6; index += 1) void worker();
    return () => {
      cancelled = true;
    };
  }, [clusters, electronAPI]);

  const addSelectedToFolder = useCallback(async () => {
    if (!electronAPI || !targetFolder || selectedPaths.size === 0) return;
    setBusy(true);
    try {
      onStateChanged(
        await electronAPI.addDigitalFolderReferences(
          targetFolder,
          Array.from(selectedPaths),
        ),
      );
      setSelectedPaths(new Set());
      clearSelection();
    } finally {
      setBusy(false);
    }
  }, [
    clearSelection,
    electronAPI,
    onStateChanged,
    selectedPaths,
    targetFolder,
  ]);

  const saveMetadata = useCallback(async () => {
    if (!electronAPI || selectedPaths.size === 0) return;
    setBusy(true);
    try {
      const keywords = metadataKeywords
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean);
      const update =
        selectedPaths.size === 1
          ? { displayName: metadataName || null, keywords }
          : { keywords, mergeKeywords: true };
      onStateChanged(
        await electronAPI.updateFileMetadata(Array.from(selectedPaths), update),
      );
      setSelectedPaths(new Set());
      clearSelection();
    } finally {
      setBusy(false);
    }
  }, [
    clearSelection,
    electronAPI,
    metadataKeywords,
    metadataName,
    onStateChanged,
    selectedPaths,
  ]);

  const selectedPhotos = useMemo(
    () =>
      selectedCluster?.photos.filter((photo) =>
        selectedPaths.has(photo.path),
      ) ?? [],
    [selectedCluster, selectedPaths],
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
      onStateChanged(
        favoritePaths.has(filePath)
          ? await electronAPI.removeDigitalFolderReference(
              FAVORITES_FOLDER_ID,
              filePath,
            )
          : await electronAPI.addDigitalFolderReference(
              FAVORITES_FOLDER_ID,
              filePath,
            ),
      );
      setSelectedPaths(new Set());
      clearSelection();
    },
    [clearSelection, electronAPI, favoritePaths, onStateChanged],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch(mapAssetUrl("countries-50m.geojson")).then(
        (response) => response.json(),
      ),
      fetch(mapAssetUrl("us-states.geojson")).then((response) =>
        response.json(),
      ),
    ])
      .then(([countries, states]) => {
        if (!cancelled)
          setRegionFeatures(
            buildRegions(withUsStates(countries.features, states.features)),
          );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mapNotice) return;
    const timer = window.setTimeout(() => setMapNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [mapNotice]);

  const updateSelection = useCallback(
    (paths: string[], regionKeys: string[], remove: boolean) => {
      const regionPaths = regionKeys.flatMap((key) =>
        (regionIndex?.byRegion.get(key) ?? []).map((photo) => photo.path),
      );
      const edit = (
        setter: React.Dispatch<React.SetStateAction<Set<string>>>,
        values: string[],
        add: boolean,
      ) => {
        if (values.length === 0) return;
        setter((current) => {
          const next = new Set(current);
          for (const value of values) {
            if (add) next.add(value);
            else next.delete(value);
          }
          return next;
        });
      };
      if (remove) {
        edit(setSelectionRegions, regionKeys, false);
        edit(setSelectionPlaces, [...paths, ...regionPaths], false);
        // Excluding places that are only selected through a whole country/state.
        edit(setSelectionExcluded, paths, true);
      } else {
        edit(setSelectionRegions, regionKeys, true);
        edit(setSelectionPlaces, paths, true);
        edit(setSelectionExcluded, [...paths, ...regionPaths], false);
      }
    },
    [regionIndex],
  );

  regionActionsRef.current = {
    count: (key) => regionIndex?.byRegion.get(key)?.length ?? 0,
    open: (key) => {
      const region = regionsByKey.get(key);
      if (!region || !regionIndex) {
        setMapNotice("Borders are still loading…");
        return;
      }
      const photos = regionIndex.byRegion.get(key) ?? [];
      if (photos.length === 0) {
        setMapNotice(`No mapped photos in ${region.name}.`);
        return;
      }
      setSelectedCluster({
        id: key,
        latitude: region.centroid.lat,
        longitude: region.centroid.lng,
        label: region.name,
        photos,
        representative: photos[0],
        countryCode: region.kind === "state" ? "US" : region.code,
      });
      setSelectedPaths(new Set());
      setClusterSearch("");
      setClusterSearchPaths(null);
    },
    togglePlace: (paths) =>
      updateSelection(
        paths,
        [],
        paths.length > 0 &&
          paths.every((filePath) => selectedPathSet.has(filePath)),
      ),
  };
  dragContextRef.current = {
    clusters,
    regionIndex,
    regionFeatures,
    selectShape,
    selectScope,
    updateSelection,
  };

  useEffect(() => {
    refreshPolygonStylesRef.current();
    markerButtonsRef.current.forEach(({ button, paths }) =>
      applyMarkerSelection(button, paths, selectedPathSet),
    );
  }, [selectedPathSet, selectionRegions]);

  // Shift+drag draws a selection shape on the globe; Shift+click toggles the country/state under the cursor.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let start: { x: number; y: number } | null = null;
    let remove = false;
    const onKey = (event: KeyboardEvent) => setSelectionArmed(event.shiftKey);
    const onBlur = () => setSelectionArmed(false);
    const onMove = (event: PointerEvent) => {
      if (start)
        setDragShape({
          x0: start.x,
          y0: start.y,
          x1: event.clientX,
          y1: event.clientY,
          remove,
        });
    };
    const onUp = (event: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const globe = globeRef.current;
      if (globe) globe.controls().enabled = true;
      setDragShape(null);
      const from = start;
      start = null;
      const context = dragContextRef.current;
      if (!from || !globe || !context) return;
      const rect = container.getBoundingClientRect();
      const distance = Math.hypot(
        event.clientX - from.x,
        event.clientY - from.y,
      );
      if (distance < 4) {
        const coords = globe.toGlobeCoords(
          from.x - rect.left,
          from.y - rect.top,
        );
        const region = coords
          ? regionAt(context.regionFeatures, coords.lat, coords.lng)
          : null;
        if (region)
          context.updateSelection(
            [],
            [region.key],
            remove || selectionRef.current.regions.has(region.key),
          );
        return;
      }
      const camera = globe.camera().position;
      const radiusSquared = globe.getGlobeRadius() ** 2;
      const minX = Math.min(from.x, event.clientX);
      const maxX = Math.max(from.x, event.clientX);
      const minY = Math.min(from.y, event.clientY);
      const maxY = Math.max(from.y, event.clientY);
      const paths: string[] = [];
      const regionKeys = new Set<string>();
      for (const cluster of context.clusters) {
        const point = globe.getCoords(cluster.latitude, cluster.longitude, 0);
        // Skip bubbles on the far side of the globe.
        if (
          point.x * camera.x + point.y * camera.y + point.z * camera.z <=
          radiusSquared
        )
          continue;
        const screen = globe.getScreenCoords(
          cluster.latitude,
          cluster.longitude,
          0,
        );
        const x = screen.x + rect.left;
        const y = screen.y + rect.top;
        const inside =
          context.selectShape === "circle"
            ? Math.hypot(x - from.x, y - from.y) <= distance
            : x >= minX && x <= maxX && y >= minY && y <= maxY;
        if (!inside) continue;
        for (const photo of cluster.photos) {
          if (context.selectScope === "places") paths.push(photo.path);
          else {
            const key = context.regionIndex?.byPath.get(photo.path);
            if (key) regionKeys.add(key);
          }
        }
      }
      context.updateSelection(paths, Array.from(regionKeys), remove);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.shiftKey || event.button !== 0) return;
      if ((event.target as HTMLElement).closest(".geo-marker")) return;
      // Capture phase: stop OrbitControls from rotating while selecting.
      event.stopPropagation();
      event.preventDefault();
      start = { x: event.clientX, y: event.clientY };
      remove = event.altKey;
      if (globeRef.current) globeRef.current.controls().enabled = false;
      setDragShape({
        x0: start.x,
        y0: start.y,
        x1: start.x,
        y1: start.y,
        remove,
      });
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    container.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      container.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const addSelectionToAlbum = useCallback(
    async (folderId: string | null) => {
      if (!electronAPI || selectedPathSet.size === 0) return;
      const name = newAlbumName.trim();
      if (!folderId && !name) return;
      setBusy(true);
      try {
        let targetId = folderId;
        if (!targetId) {
          const knownIds = new Set(digitalFolders.map((folder) => folder.id));
          const created = await electronAPI.createDigitalFolder(name);
          targetId =
            created.digitalFolders.find((folder) => !knownIds.has(folder.id))
              ?.id ?? null;
          if (!targetId) throw new Error("The album could not be created.");
        }
        onStateChanged(
          await electronAPI.addDigitalFolderReferences(
            targetId,
            Array.from(selectedPathSet),
          ),
        );
        clearSelection();
        setAlbumMenuOpen(false);
        setNewAlbumName("");
        onOpenFolder?.(targetId);
      } catch (cause) {
        setMapNotice(
          cause instanceof Error
            ? cause.message
            : "Could not add photos to the album.",
        );
      } finally {
        setBusy(false);
      }
    },
    [
      clearSelection,
      digitalFolders,
      electronAPI,
      newAlbumName,
      onOpenFolder,
      onStateChanged,
      selectedPathSet,
    ],
  );

  const applyGeoAssignment = useCallback(
    (result: GeoAssignmentResult) => {
      onStateChanged(result.appState);
      setGeoState(result.geoState);
      setSelectedCluster(null);
      setSelectedPaths(new Set());
      clearSelection();
      setShowLocationPicker(false);
    },
    [clearSelection, onStateChanged],
  );

  return (
    <main
      className={`map-page ${selectedCluster ? "region-open" : ""} ${selectionArmed ? "selection-armed" : ""}`}
      data-help="Map groups geotagged photos by place. Selection tools only select photos; Relocate and metadata edits change location or labels only after you review and apply them."
    >
      <div className="map-globe" ref={containerRef} />
      <div className="map-status" data-tour="map-overview">
        <FiMapPin />
        <div>
          <strong>
            {photosLoaded
              ? `${geoState.geotagged.toLocaleString()} mapped photos`
              : "Loading cached locations…"}
          </strong>
          <span>
            {geoState.status === "scanning"
              ? `Checking new photos · ${geoState.scanned.toLocaleString()} of ${geoState.total.toLocaleString()} (${Math.round((geoState.scanned / Math.max(geoState.total, 1)) * 100)}%)`
              : photosLoaded
                ? geoState.message
                : "Reading location cache from disk"}
          </span>
        </div>
        {!photosLoaded ? (
          <div
            className="map-status-indeterminate"
            role="progressbar"
            aria-label="Loading locations"
          />
        ) : (
          geoState.status === "scanning" && (
            <progress
              value={geoState.scanned}
              max={Math.max(geoState.total, 1)}
            />
          )
        )}
        <button
          onClick={() =>
            void electronAPI?.refreshGeoState().then((state) => {
              setGeoState(state);
              setPhotosLoaded(true);
            })
          }
          title="Check for new photo locations"
          data-help="Rescan indexed media for updated geotagged photo locations."
        >
          <FiRefreshCw />
        </button>
      </div>
      <section className="map-selection-toolbar" aria-label="Map selection" data-tour="map-selection-tools" data-help="Choose rectangle or circle selection and whether to select individual place bubbles or whole regions. Use Shift-drag or Shift-click to add and Option to subtract.">
        <div className="map-selection-modes">
          <div
            className="map-segmented"
            role="group"
            aria-label="Selection shape"
          >
            <button
              className={selectShape === "rectangle" ? "active" : ""}
              onClick={() => setSelectShape("rectangle")}
              title="Rectangle selection"
              aria-label="Rectangle selection"
              data-help="Drag across the globe to select places or regions inside a rectangle."
            >
              <FiSquare />
            </button>
            <button
              className={selectShape === "circle" ? "active" : ""}
              onClick={() => setSelectShape("circle")}
              title="Circle selection"
              aria-label="Circle selection"
              data-help="Drag on the globe to select places or regions inside a circle."
            >
              <FiCircle />
            </button>
          </div>
          <div
            className="map-segmented"
            role="group"
            aria-label="Selection scope"
          >
            <button
              className={selectScope === "places" ? "active" : ""}
              onClick={() => setSelectScope("places")}
              title="Select individual location bubbles"
            >
              Places
            </button>
            <button
              className={selectScope === "regions" ? "active" : ""}
              onClick={() => setSelectScope("regions")}
              title="Select whole countries (states in the US)"
            >
              Countries
            </button>
          </div>
        </div>
        <p className="map-selection-hint">
          <kbd>Shift</kbd>-drag to select · <kbd>Shift</kbd>-click a bubble or
          country to add/remove · add <kbd>⌥</kbd> to subtract · double-click a
          country to open it
        </p>
        {selectedPathSet.size > 0 && (
          <div className="map-selection-summary">
            <div>
              <strong>
                {selectedPathSet.size.toLocaleString()} photo
                {selectedPathSet.size === 1 ? "" : "s"} selected
              </strong>
              {selectionRegions.size > 0 && (
                <span>
                  {Array.from(selectionRegions)
                    .slice(0, 4)
                    .map((key) => regionsByKey.get(key)?.name ?? key)
                    .join(", ")}
                  {selectionRegions.size > 4
                    ? ` +${selectionRegions.size - 4} more`
                    : ""}
                </span>
              )}
            </div>
            <div className="map-album-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => setAlbumMenuOpen((open) => !open)}
              >
                <FiFolderPlus /> Add to album
              </button>
              <button
                onClick={clearSelection}
                title="Clear selection"
                aria-label="Clear selection"
              >
                <FiX />
              </button>
            </div>
            {albumMenuOpen && (
              <div className="map-album-menu">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addSelectionToAlbum(null);
                  }}
                >
                  <input
                    value={newAlbumName}
                    onChange={(event) => setNewAlbumName(event.target.value)}
                    placeholder="New album name"
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || !newAlbumName.trim()}
                  >
                    <FiPlus /> Create
                  </button>
                </form>
                {digitalFolders.length > 0 && (
                  <div className="map-album-list">
                    <span>Or add to an existing album</span>
                    {digitalFolders.map((folder) => (
                      <button
                        key={folder.id}
                        disabled={busy}
                        onClick={() => void addSelectionToAlbum(folder.id)}
                      >
                        <span>{folder.name}</span>
                        <small>
                          {folder.filePaths.length.toLocaleString()}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {mapNotice && <p className="map-selection-notice">{mapNotice}</p>}
      </section>
      {dragShape &&
        (() => {
          const radius = Math.hypot(
            dragShape.x1 - dragShape.x0,
            dragShape.y1 - dragShape.y0,
          );
          const style =
            selectShape === "circle"
              ? {
                  left: dragShape.x0 - radius,
                  top: dragShape.y0 - radius,
                  width: radius * 2,
                  height: radius * 2,
                }
              : {
                  left: Math.min(dragShape.x0, dragShape.x1),
                  top: Math.min(dragShape.y0, dragShape.y1),
                  width: Math.abs(dragShape.x1 - dragShape.x0),
                  height: Math.abs(dragShape.y1 - dragShape.y0),
                };
          return (
            <div
              className={`map-drag-shape ${selectShape} ${dragShape.remove ? "remove" : ""}`}
              style={style}
            />
          );
        })()}
      <div className="map-compass-controls" data-tour="map-globe-controls" data-help="Pause or resume globe rotation and use the compass to reset the view north-up.">
        <button
          className="map-rotation-toggle"
          onClick={() => setAutoRotate((current) => !current)}
          title={autoRotate ? "Pause globe rotation" : "Resume globe rotation"}
        >
          {autoRotate ? <FiPause /> : <FiPlay />}
        </button>
        <button
          className="map-compass"
          onClick={resetOrientation}
          title="Orient north up"
          aria-label={`Compass, heading ${Math.round(heading)} degrees`}
        >
          <FiCompass style={{ transform: `rotate(${-heading}deg)` }} />
          <span>N</span>
        </button>
      </div>
      <section className="map-solar-controls" aria-label="Globe lighting" data-tour="map-solar-controls" data-help="Adjust the globe’s displayed local solar time or move the daylight/night boundary into the current view.">
        <header>
          <span>
            <FiSun /> View solar time
          </span>
          <strong>
            {formatSolarTime(solarHour)} local · {formatSolarTime(utcHour)} UTC
          </strong>
        </header>
        <input
          type="range"
          min="0"
          max="24"
          step="0.25"
          value={solarHour}
          onChange={(event) => {
            const longitude = globeRef.current?.pointOfView().lng ?? 0;
            manualSolarTimeRef.current = true;
            setUtcHour(utcHourForView(Number(event.target.value), longitude));
          }}
          aria-label="Viewed solar time"
        />
        <div>
          <button
            onClick={() => setLightingForView("day")}
            title="Move daylight to the current view"
          >
            <FiSun /> Day here
          </button>
          <button
            onClick={() => setLightingForView("night")}
            title="Move nighttime to the current view"
          >
            <FiMoon /> Night here
          </button>
        </div>
      </section>
      {detailSurfaceActive && (
        <div className="map-detail-attribution">
          High-resolution imagery © Esri
        </div>
      )}

      {selectedCluster && (
        <div
          className="map-region-backdrop"
          role="presentation"
          onMouseDown={() => setSelectedCluster(null)}
        >
          <aside
            className="map-region-panel"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedCluster.label}, ${selectedCluster.photos.length} photos`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>
                  {countryFlag(selectedCluster.countryCode)}{" "}
                  {selectedCluster.label}
                </h2>
                <p>
                  {selectedCluster.photos.length.toLocaleString()} photos in
                  this region
                </p>
              </div>
              <button onClick={() => setSelectedCluster(null)}>×</button>
            </header>
            <div className="map-region-actions">
              <button
                onClick={() =>
                  setSelectedPaths(
                    visibleRegionPhotos.length > 0 &&
                      visibleRegionPhotos.every((photo) =>
                        selectedPaths.has(photo.path),
                      )
                      ? new Set()
                      : new Set(visibleRegionPhotos.map((photo) => photo.path)),
                  )
                }
              >
                <FiCheck />{" "}
                {visibleRegionPhotos.length > 0 &&
                visibleRegionPhotos.every((photo) =>
                  selectedPaths.has(photo.path),
                )
                  ? "Clear visible"
                  : "Select visible"}
              </button>
              <select
                value={targetFolder}
                onChange={(event) => setTargetFolder(event.target.value)}
              >
                <option value="">Choose folder...</option>
                {digitalFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
              <button
                disabled={busy || !targetFolder || selectedPaths.size === 0}
                onClick={addSelectedToFolder}
              >
                <FiFolderPlus /> Add {selectedPaths.size || "selected"}
              </button>
              <button
                disabled={busy || selectedPaths.size === 0}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setPersonPicker({
                    x: rect.left,
                    y: rect.bottom + 6,
                    paths: Array.from(selectedPaths),
                  });
                }}
                title="Add the selected photos to a person in People"
              >
                <FiUserPlus /> Add to person
              </button>
              {regionNotice && (
                <span className="map-region-notice">{regionNotice}</span>
              )}
              <select
                value={regionSort}
                onChange={(event) =>
                  setRegionSort(event.target.value as RegionSort)
                }
              >
                <option value="date">Date</option>
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="type">Type</option>
                <option value="magic">{"✦"} Magic</option>
              </select>
              {regionSort === "magic" && (
                <MagicTools
                  state={magicState}
                  preset={magicPrefs.preset}
                  onPresetChange={magicPrefs.setPreset}
                  topCount={magicPrefs.topCount}
                  onTopCountChange={magicPrefs.setTopCount}
                  onSelectTop={(count) =>
                    setSelectedPaths(
                      new Set(
                        sortedRegionPhotos
                          .filter(
                            (photo) =>
                              magicState.scores[photo.path] !== undefined,
                          )
                          .slice(0, count)
                          .map((photo) => photo.path),
                      ),
                    )
                  }
                  compact
                />
              )}
              <button
                disabled={regionSort === "magic"}
                onClick={() => setRegionSortAscending((current) => !current)}
              >
                {regionSortAscending ? "Ascending" : "Descending"}
              </button>
              <button
                className="map-relocate-button"
                data-tour="map-relocate"
                disabled={selectedPhotos.length === 0}
                onClick={() => setShowLocationPicker((current) => !current)}
              >
                <FiMapPin /> Relocate {selectedPhotos.length || "selected"}
              </button>
            </div>
            <label className="map-region-search">
              <FiSearch />
              <input
                value={clusterSearch}
                onChange={(event) => setClusterSearch(event.target.value)}
                placeholder="Search within this location"
              />
              {clusterSearching && <span>Searching...</span>}
              {clusterSearch && (
                <button
                  onClick={() => setClusterSearch("")}
                  title="Clear location search"
                >
                  <FiX />
                </button>
              )}
            </label>
            {showLocationPicker && selectedPhotos.length > 0 && (
              <LocationPicker
                files={selectedPhotos}
                onAssigned={applyGeoAssignment}
                onClose={() => setShowLocationPicker(false)}
              />
            )}
            <div className="map-metadata-editor">
              <label>
                <FiEdit3 />
                <input
                  value={metadataName}
                  onChange={(event) => setMetadataName(event.target.value)}
                  placeholder={
                    selectedPaths.size === 1
                      ? "Virtual name"
                      : "Select one photo to rename"
                  }
                  disabled={selectedPaths.size !== 1}
                />
              </label>
              <label>
                <FiTag />
                <input
                  value={metadataKeywords}
                  onChange={(event) => setMetadataKeywords(event.target.value)}
                  placeholder={
                    selectedPaths.size > 1
                      ? "Add keywords to selection"
                      : "Keywords, separated by commas"
                  }
                  disabled={selectedPaths.size === 0}
                />
              </label>
              <button
                disabled={busy || selectedPaths.size === 0}
                onClick={saveMetadata}
              >
                Save metadata
              </button>
            </div>
            <div className="map-region-grid">
              {visibleRegionPhotos.map((photo) => (
                <div
                  key={photo.path}
                  data-file-path={photo.path}
                  className={`map-region-photo ${selectedPaths.has(photo.path) ? "selected" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(photo.path)}
                    onChange={() =>
                      setSelectedPaths((current) => {
                        const next = new Set(current);
                        if (next.has(photo.path)) next.delete(photo.path);
                        else next.add(photo.path);
                        return next;
                      })
                    }
                    aria-label={`Select ${fileMetadata[photo.path]?.displayName || photo.name}`}
                  />
                  <button
                    className={`map-photo-favorite ${favoritePaths.has(photo.path) ? "active" : ""}`}
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
                    className="map-photo-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        (e.ctrlKey || e.metaKey) &&
                        selectedPaths.has(photo.path)
                      ) {
                        setSelectedPaths((current) => {
                          const next = new Set(current);
                          next.delete(photo.path);
                          return next;
                        });
                      } else if (e.ctrlKey || e.metaKey) {
                        setSelectedPaths((current) => {
                          const next = new Set(current);
                          next.add(photo.path);
                          return next;
                        });
                      } else {
                        setSelectedPaths(new Set([photo.path]));
                      }
                    }}
                    onDoubleClick={() => onOpenFile(photo, visibleRegionPhotos)}
                    title={fileMetadata[photo.path]?.displayName || photo.name}
                  >
                    <MapPhotoThumbnail photo={photo} />
                  </button>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
      {personPicker && (
        <PersonPicker
          photoPaths={personPicker.paths}
          anchor={personPicker}
          onClose={() => setPersonPicker(null)}
          onAdded={(result) => {
            setSelectedPaths(new Set());
            clearSelection();
            setRegionNotice(
              `Added ${result.count.toLocaleString()} to ${result.personName}`,
            );
            window.setTimeout(() => setRegionNotice(""), 4000);
          }}
        />
      )}
    </main>
  );
}
