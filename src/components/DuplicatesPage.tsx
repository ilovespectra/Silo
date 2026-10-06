import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  FiCheck,
  FiCopy,
  FiLock,
  FiRefreshCw,
  FiRotateCcw,
  FiTrash2,
  FiX,
  FiGrid,
  FiList,
} from "react-icons/fi";
import { useThumbnail } from "../utils/useThumbnail";

interface PreviewImageProps {
  filePath: string;
}

const PreviewImage = React.memo(function PreviewImage({
  filePath,
}: PreviewImageProps) {
  const { thumbnail, loading } = useThumbnail(filePath, true);

  if (loading) {
    return (
      <div
        style={{ width: "100%", height: "400px", background: "var(--surface)" }}
      />
    );
  }

  return (
    <img
      src={thumbnail || ""}
      alt="Preview"
      style={{ maxWidth: "100%", maxHeight: "75vh", objectFit: "contain" }}
    />
  );
});

interface DuplicatesPageProps {
  state: DuplicateState;
  onStateChange: (state: DuplicateState) => void;
  tourView?: "duplicates" | "trash" | null;
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

interface DuplicateThumbnailProps {
  filePath: string;
  thumbnailSize: number;
}

const DuplicateThumbnail = React.memo(function DuplicateThumbnail({
  filePath,
  thumbnailSize,
}: DuplicateThumbnailProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { thumbnail, loading } = useThumbnail(filePath, visible);
  return (
    <span
      ref={ref}
      className="duplicate-thumb-inner"
      style={{ width: thumbnailSize, height: thumbnailSize }}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <FiCopy
          className={loading || !visible ? "duplicate-thumb-pending" : ""}
        />
      )}
    </span>
  );
});

const GROUP_PAGE_SIZE = 60;

export default function DuplicatesPage({
  state,
  onStateChange,
  tourView = null,
}: DuplicatesPageProps) {
  const electronAPI = window.electron;
  const [selectedTrash, setSelectedTrash] = useState<Set<string>>(new Set());
  const [selectedDuplicates, setSelectedDuplicates] = useState<
    Map<string, Set<string>>
  >(new Map());
  const [view, setView] = useState<"duplicates" | "trash">("duplicates");
  const [busy, setBusy] = useState(false);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [processingProgress, setProcessingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [renderLimit, setRenderLimit] = useState(GROUP_PAGE_SIZE);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [allDuplicateFiles, setAllDuplicateFiles] = useState<string[]>([]);
  const groupsContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tourView) setView(tourView);
  }, [tourView]);

  // Thumbnail zoom and view mode
  const [thumbnailSize, setThumbnailSize] = useState(120);
  const [gridViewMode, setGridViewMode] = useState<"grid" | "list">("grid");
  const [listSortBy, setListSortBy] = useState<
    "name" | "size" | "date" | "count"
  >("count");
  const [listSortAscending, setListSortAscending] = useState(false);

  const scan = async () => {
    if (!electronAPI) return;
    setBusy(true);
    try {
      onStateChange(await electronAPI.scanDuplicates());
    } finally {
      setBusy(false);
    }
  };

  const removeCopy = async (filePath: string) => {
    if (!electronAPI) return;
    setRemovingPath(filePath);
    setError("");
    try {
      onStateChange(await electronAPI.quarantineDuplicateFiles([filePath]));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The copy could not be moved to review.",
      );
    } finally {
      setRemovingPath(null);
    }
  };

  const removeSelectedDuplicates = async () => {
    if (!electronAPI || selectedDuplicates.size === 0) return;
    const filesToRemove: string[] = [];
    selectedDuplicates.forEach((paths) => {
      filesToRemove.push(...paths);
    });

    if (filesToRemove.length === 0) return;

    const msg = `Move ${filesToRemove.length} duplicate file${filesToRemove.length === 1 ? "" : "s"} to review?\n\nThe unique original file in each group will be protected and retained.`;
    if (!window.confirm(msg)) return;

    setBusy(true);
    setProcessingProgress({ current: 0, total: filesToRemove.length });
    setError("");

    try {
      const result = await electronAPI.quarantineDuplicateFiles(filesToRemove);
      onStateChange(result);
      setSelectedDuplicates(new Map());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not move duplicates to review.",
      );
    } finally {
      setBusy(false);
      setProcessingProgress(null);
    }
  };

  const toggleDuplicateSelection = (groupId: string, filePath: string) => {
    const newSelected = new Map(selectedDuplicates);
    const groupSet = newSelected.get(groupId) || new Set<string>();
    if (groupSet.has(filePath)) {
      groupSet.delete(filePath);
    } else {
      groupSet.add(filePath);
    }
    if (groupSet.size === 0) {
      newSelected.delete(groupId);
    } else {
      newSelected.set(groupId, groupSet);
    }
    setSelectedDuplicates(newSelected);
  };

  const selectAllInGroup = (groupId: string, group: DuplicateGroup) => {
    const newSelected = new Map(selectedDuplicates);
    const groupSet = new Set<string>();
    for (const file of group.files) {
      // Don't select the kept file
      if (file.path !== group.keepPath) {
        groupSet.add(file.path);
      }
    }
    if (groupSet.size === 0) {
      newSelected.delete(groupId);
    } else {
      newSelected.set(groupId, groupSet);
    }
    setSelectedDuplicates(newSelected);
  };

  const isGroupFullySelected = (
    groupId: string,
    group: DuplicateGroup,
  ): boolean => {
    const groupSet = selectedDuplicates.get(groupId);
    if (!groupSet || groupSet.size === 0) return false;
    const selectableCount = group.files.filter(
      (f) => f.path !== group.keepPath,
    ).length;
    return groupSet.size === selectableCount;
  };

  const totalSelectedCount = Array.from(selectedDuplicates.values()).reduce(
    (sum, set) => sum + set.size,
    0,
  );

  const restore = async () => {
    if (!electronAPI || selectedTrash.size === 0) return;
    setBusy(true);
    try {
      onStateChange(
        await electronAPI.restoreDuplicates(Array.from(selectedTrash)),
      );
      setSelectedTrash(new Set());
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!electronAPI || state.trash.length === 0) return;
    const count = selectedTrash.size || state.trash.length;
    if (
      !window.confirm(
        `Permanently delete ${count} quarantined file${count === 1 ? "" : "s"}? This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      onStateChange(
        await electronAPI.clearDuplicateTrash(
          selectedTrash.size > 0 ? Array.from(selectedTrash) : undefined,
        ),
      );
      setSelectedTrash(new Set());
    } finally {
      setBusy(false);
    }
  };

  // Refresh on open: the main process prunes entries whose files are gone.
  useEffect(() => {
    if (!electronAPI) return;
    void electronAPI
      .getDuplicateState()
      .then(onStateChange)
      .catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not refresh duplicates.",
        );
      });
  }, []);

  const sortedGroups = useMemo(
    () =>
      state.groups
        .slice()
        .sort(
          (a, b) =>
            b.files.length - a.files.length ||
            b.reclaimableBytes - a.reclaimableBytes,
        ),
    [state.groups],
  );

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting)
          setRenderLimit((limit) => limit + GROUP_PAGE_SIZE);
      },
      { rootMargin: "800px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [view, gridViewMode, renderLimit, sortedGroups.length]);

  // Build flat list of all duplicate files for preview navigation
  useEffect(() => {
    const allFiles: string[] = [];
    for (const group of state.groups) {
      for (const file of group.files) {
        allFiles.push(file.path);
      }
    }
    setAllDuplicateFiles(allFiles);
  }, [state.groups]);

  // Handle keyboard navigation in preview mode
  useEffect(() => {
    if (!previewFile) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreviewFile(null);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = allDuplicateFiles.indexOf(previewFile);
        if (idx >= 0 && idx < allDuplicateFiles.length - 1) {
          setPreviewFile(allDuplicateFiles[idx + 1]);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = allDuplicateFiles.indexOf(previewFile);
        if (idx > 0) {
          setPreviewFile(allDuplicateFiles[idx - 1]);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewFile, allDuplicateFiles]);

  // Update progress indicator based on state
  useEffect(() => {
    if (busy && state.total > 0) {
      setProcessingProgress({ current: state.scanned, total: state.total });
    }
  }, [busy, state.scanned, state.total]);

  return (
    <main className="duplicates-page" data-help="Scan compares exact file contents. Keep the protected original, review selected copies in the recoverable removal area, and verify before permanent deletion.">
      <header className="duplicates-header" data-tour="duplicates-overview">
        <div>
          <span className="sidebar-kicker">Exact-byte comparison</span>
          <h2>Duplicates</h2>
          <p>{state.message}</p>
        </div>
        <div className="duplicates-summary">
          <div>
            <strong>{state.groups.length.toLocaleString()}</strong>
            <span>groups</span>
          </div>
          <div>
            <strong>{state.duplicateFiles.toLocaleString()}</strong>
            <span>removable copies</span>
          </div>
          <div>
            <strong>{formatBytes(state.reclaimableBytes)}</strong>
            <span>recoverable</span>
          </div>
          <div>
            <strong>{formatBytes(state.trashBytes)}</strong>
            <span>awaiting deletion</span>
          </div>
          <div>
            <strong>{formatBytes(state.permanentlyClearedBytes)}</strong>
            <span>saved permanently</span>
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => void scan()}
          disabled={busy || state.status === "scanning"}
          data-tour="duplicates-scan"
          data-help="Compare indexed file contents to find exact duplicate copies; review paths and keep the protected first copy before cleanup."
        >
          <FiRefreshCw />{" "}
          {state.status === "scanning" ? "Scanning..." : "Scan library"}
        </button>
      </header>

      {state.status === "scanning" && (
        <div className="duplicate-progress">
          <progress value={state.scanned} max={Math.max(state.total, 1)} />
          <span>
            {state.scanned.toLocaleString()} / {state.total.toLocaleString()}
          </span>
        </div>
      )}

      <nav className="duplicate-tabs" data-tour="duplicates-tabs" data-help="Switch between duplicate groups and items already moved to the recoverable review area.">
        <button
          className={view === "duplicates" ? "active" : ""}
          onClick={() => setView("duplicates")}
        >
          Duplicate groups
        </button>
        <button
          className={view === "trash" ? "active" : ""}
          onClick={() => setView("trash")}
          data-tour="duplicates-review-tab"
        >
          Review removed ({state.trash.length})
        </button>
      </nav>

      {view === "duplicates" ? (
        <>
          <div className="duplicate-toolbar" data-tour="duplicates-actions" data-help="Select duplicate copies, change how groups are displayed, and move reviewed selections to the recoverable Review removed area.">
            <div className="duplicate-toolbar-left">
              <span>
                The first retained file is protected. Selectable duplicates can
                be moved to review.
              </span>
              {state.groups.length > 0 && (
                <button
                  className="duplicate-select-all-global"
                  onClick={() => {
                    if (selectedDuplicates.size === state.groups.length) {
                      setSelectedDuplicates(new Map());
                    } else {
                      const newSelected = new Map<string, Set<string>>();
                      for (const group of state.groups) {
                        const selectableFiles = group.files.filter(
                          (f) => f.path !== group.keepPath,
                        );
                        if (selectableFiles.length > 0) {
                          newSelected.set(
                            group.id,
                            new Set(selectableFiles.map((f) => f.path)),
                          );
                        }
                      }
                      setSelectedDuplicates(newSelected);
                    }
                  }}
                >
                  {selectedDuplicates.size === state.groups.length
                    ? "Deselect all"
                    : "Select all"}
                </button>
              )}
            </div>

            {/* View mode and zoom controls */}
            <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <button
                  className={gridViewMode === "grid" ? "active" : ""}
                  onClick={() => setGridViewMode("grid")}
                  title="Grid view"
                  style={{ padding: "6px 10px" }}
                >
                  <FiGrid />
                </button>
                <button
                  className={gridViewMode === "list" ? "active" : ""}
                  onClick={() => setGridViewMode("list")}
                  title="List view"
                  style={{ padding: "6px 10px" }}
                >
                  <FiList />
                </button>
              </div>

              {gridViewMode === "grid" && (
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    marginLeft: "8px",
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      gap: "6px",
                      alignItems: "center",
                      fontSize: "12px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Size:
                    <input
                      type="range"
                      min="60"
                      max="240"
                      step="10"
                      value={thumbnailSize}
                      onChange={(e) =>
                        setThumbnailSize(parseInt(e.target.value, 10))
                      }
                      style={{ width: "100px" }}
                    />
                    {thumbnailSize}px
                  </label>
                </div>
              )}

              {gridViewMode === "list" && (
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    marginLeft: "8px",
                  }}
                >
                  <select
                    value={listSortBy}
                    onChange={(e) => setListSortBy(e.target.value as any)}
                    style={{ padding: "4px 8px", fontSize: "12px" }}
                  >
                    <option value="count">Sort by: Count</option>
                    <option value="size">Sort by: Size</option>
                    <option value="date">Sort by: Date</option>
                    <option value="name">Sort by: Name</option>
                  </select>
                  <button
                    onClick={() => setListSortAscending(!listSortAscending)}
                    title={listSortAscending ? "Ascending" : "Descending"}
                    style={{ padding: "4px 8px", fontSize: "12px" }}
                  >
                    {listSortAscending ? "↑" : "↓"}
                  </button>
                </div>
              )}
            </div>

            {processingProgress && (
              <div className="duplicate-processing-progress">
                <span>
                  Moving {processingProgress.current.toLocaleString()} /{" "}
                  {processingProgress.total.toLocaleString()}...
                </span>
                <progress
                  value={processingProgress.current}
                  max={processingProgress.total}
                />
              </div>
            )}
            {totalSelectedCount > 0 && !processingProgress && (
              <>
                <strong>
                  {totalSelectedCount} duplicate
                  {totalSelectedCount === 1 ? "" : "s"} selected
                </strong>
                <button
                  disabled={busy}
                  onClick={() => void removeSelectedDuplicates()}
                  className="danger"
                >
                  <FiTrash2 /> Move to review
                </button>
              </>
            )}
            {error && <strong className="duplicate-error">{error}</strong>}
          </div>
          {/* Grid view */}
          {gridViewMode === "grid" && (
            <section className="duplicate-groups" data-tour="duplicate-groups" ref={groupsContainerRef}>
              {sortedGroups.slice(0, renderLimit).map((group) => {
                const groupSelected = selectedDuplicates.get(group.id);
                const isFullySelected = isGroupFullySelected(group.id, group);
                const selectableFiles = group.files.filter(
                  (f) => f.path !== group.keepPath,
                );

                return (
                  <article key={group.id}>
                    <div className="duplicate-group-heading">
                      <div className="duplicate-group-title">
                        <span>{group.files.length} identical files</span>
                        <strong>
                          {formatBytes(group.reclaimableBytes)} recoverable
                        </strong>
                      </div>
                      {selectableFiles.length > 0 && (
                        <button
                          className="duplicate-select-all"
                          onClick={() => selectAllInGroup(group.id, group)}
                          title={
                            isFullySelected
                              ? "Deselect all"
                              : "Select all duplicates in this group"
                          }
                        >
                          {isFullySelected ? "Deselect all" : "Select all"}
                        </button>
                      )}
                    </div>
                    <div
                      className="duplicate-files"
                      style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize + 20}px, 1fr))`,
                        gap: "12px",
                      }}
                    >
                      {group.files.map((file) => (
                        <div
                          key={file.path}
                          className={
                            file.path === group.keepPath ? "kept" : "copy"
                          }
                          title={file.path}
                        >
                          <div
                            className="duplicate-thumb"
                            onDoubleClick={() => setPreviewFile(file.path)}
                          >
                            <DuplicateThumbnail
                              filePath={file.path}
                              thumbnailSize={thumbnailSize}
                            />
                          </div>
                          {file.path === group.keepPath ? (
                            <span
                              className="duplicate-protected"
                              title="Protected original"
                            >
                              <FiLock />
                            </span>
                          ) : (
                            <label className="duplicate-checkbox">
                              <input
                                type="checkbox"
                                checked={groupSelected?.has(file.path) || false}
                                onChange={() =>
                                  toggleDuplicateSelection(group.id, file.path)
                                }
                              />
                              <span className="checkbox-visual" />
                            </label>
                          )}
                          <span className="duplicate-file-name">
                            {file.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  </article>
                );
              })}
              {renderLimit < sortedGroups.length && (
                <div ref={loadMoreRef} className="duplicates-load-more">
                  Loading more groups...
                </div>
              )}
              {state.groups.length === 0 && (
                <div className="duplicates-empty">
                  No exact duplicate groups are currently indexed.
                </div>
              )}
            </section>
          )}

          {/* List view */}
          {gridViewMode === "list" && (
            <section
              className="duplicate-list-view"
              ref={groupsContainerRef}
              style={{ padding: "16px" }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--line)",
                      fontSize: "12px",
                      fontWeight: "600",
                    }}
                  >
                    <th
                      style={{
                        padding: "8px",
                        textAlign: "left",
                        width: "40px",
                      }}
                    >
                      Keep
                    </th>
                    <th
                      style={{
                        padding: "8px",
                        textAlign: "left",
                        width: "60px",
                      }}
                    >
                      Preview
                    </th>
                    <th style={{ padding: "8px", textAlign: "left", flex: 1 }}>
                      File Name
                    </th>
                    <th
                      style={{
                        padding: "8px",
                        textAlign: "right",
                        width: "100px",
                      }}
                    >
                      <button
                        onClick={() =>
                          listSortBy === "size"
                            ? setListSortAscending(!listSortAscending)
                            : setListSortBy("size")
                        }
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "inherit",
                        }}
                      >
                        Size{" "}
                        {listSortBy === "size"
                          ? listSortAscending
                            ? "↑"
                            : "↓"
                          : ""}
                      </button>
                    </th>
                    <th
                      style={{
                        padding: "8px",
                        textAlign: "right",
                        width: "120px",
                      }}
                    >
                      <button
                        onClick={() =>
                          listSortBy === "date"
                            ? setListSortAscending(!listSortAscending)
                            : setListSortBy("date")
                        }
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "inherit",
                        }}
                      >
                        Date Modified{" "}
                        {listSortBy === "date"
                          ? listSortAscending
                            ? "↑"
                            : "↓"
                          : ""}
                      </button>
                    </th>
                    <th
                      style={{
                        padding: "8px",
                        textAlign: "right",
                        width: "80px",
                      }}
                    >
                      Select
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.groups
                    .slice()
                    .sort((a, b) => {
                      let cmp = 0;
                      if (listSortBy === "count")
                        cmp = a.files.length - b.files.length;
                      else if (listSortBy === "size") cmp = a.size - b.size;
                      else if (listSortBy === "date")
                        cmp =
                          Math.max(...a.files.map((f) => f.modified || 0)) -
                          Math.max(...b.files.map((f) => f.modified || 0));
                      else if (listSortBy === "name")
                        cmp = (a.files[0]?.name || "").localeCompare(
                          b.files[0]?.name || "",
                        );
                      return listSortAscending ? cmp : -cmp;
                    })
                    .flatMap((group) =>
                      group.files.map((file, fileIndex) => ({
                        group,
                        file,
                        fileIndex,
                      })),
                    )
                    .slice(0, renderLimit * 3)
                    .map(({ group, file, fileIndex }) => {
                      const groupSelected = selectedDuplicates.get(group.id);
                      const isKept = file.path === group.keepPath;
                      return (
                        <tr
                          key={file.path}
                          style={{
                            borderBottom: "1px solid var(--line)",
                            backgroundColor: isKept
                              ? "rgba(100, 200, 100, 0.05)"
                              : undefined,
                            opacity: isKept ? 0.7 : 1,
                          }}
                        >
                          <td style={{ padding: "8px", textAlign: "center" }}>
                            {isKept ? (
                              <FiLock title="Protected original" size={16} />
                            ) : (
                              ""
                            )}
                          </td>
                          <td style={{ padding: "8px" }}>
                            <div
                              style={{
                                width: "50px",
                                height: "50px",
                                overflow: "hidden",
                                borderRadius: "4px",
                                cursor: "pointer",
                                border: "1px solid var(--line)",
                              }}
                              onDoubleClick={() => setPreviewFile(file.path)}
                            >
                              <DuplicateThumbnail
                                filePath={file.path}
                                thumbnailSize={50}
                              />
                            </div>
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontSize: "12px",
                            }}
                          >
                            {file.name}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              fontSize: "12px",
                            }}
                          >
                            {formatBytes(file.size)}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              fontSize: "12px",
                            }}
                          >
                            {new Date(file.modified || 0).toLocaleDateString()}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {isKept ? (
                              <span
                                style={{
                                  fontSize: "10px",
                                  color: "var(--line)",
                                }}
                              >
                                Original
                              </span>
                            ) : (
                              <label className="duplicate-checkbox">
                                <input
                                  type="checkbox"
                                  checked={
                                    groupSelected?.has(file.path) || false
                                  }
                                  onChange={() =>
                                    toggleDuplicateSelection(
                                      group.id,
                                      file.path,
                                    )
                                  }
                                />
                                <span className="checkbox-visual" />
                              </label>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              {renderLimit * 3 < state.duplicateFiles + state.groups.length && (
                <div ref={loadMoreRef} className="duplicates-load-more">
                  Loading more files...
                </div>
              )}
              {state.groups.length === 0 && (
                <div className="duplicates-empty">
                  No exact duplicate groups are currently indexed.
                </div>
              )}
            </section>
          )}
        </>
      ) : (
        <>
          <div className="duplicate-toolbar" data-tour="duplicate-trash-actions" data-help="Restore selected items from review, or permanently delete selected/all reviewed items. Permanent deletion cannot be undone.">
            <button
              onClick={() =>
                setSelectedTrash(
                  selectedTrash.size === state.trash.length
                    ? new Set()
                    : new Set(state.trash.map((item) => item.id)),
                )
              }
            >
              <FiCheck />{" "}
              {selectedTrash.size === state.trash.length
                ? "Clear all"
                : "Select all"}
            </button>
            <span>
              {selectedTrash.size} selected · {formatBytes(state.trashBytes)}{" "}
              retained safely
            </span>
            <button
              disabled={busy || selectedTrash.size === 0}
              onClick={() => void restore()}
            >
              <FiRotateCcw /> Restore
            </button>
            <button
              className="danger"
              disabled={busy || state.trash.length === 0}
              onClick={() => void clear()}
            >
              <FiTrash2 />{" "}
              {selectedTrash.size
                ? "Delete selected permanently"
                : "Clear all permanently"}
            </button>
          </div>
          <section className="duplicate-trash-list">
            {state.trash.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={selectedTrash.has(item.id)}
                  onChange={() =>
                    setSelectedTrash((current) => {
                      const next = new Set(current);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })
                  }
                />
                <DuplicateThumbnail
                  filePath={item.trashPath}
                  thumbnailSize={100}
                />
                <div>
                  <strong>{item.originalPath.split("/").pop()}</strong>
                  <span>{item.originalPath}</span>
                </div>
                <span>{formatBytes(item.size)}</span>
              </label>
            ))}
            {state.trash.length === 0 && (
              <div className="duplicates-empty">
                No files are awaiting permanent deletion.
              </div>
            )}
          </section>
        </>
      )}

      {previewFile && (
        <div
          className="duplicate-preview-modal"
          onClick={() => setPreviewFile(null)}
        >
          <div
            className="duplicate-preview-content"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="duplicate-preview-close"
              onClick={() => setPreviewFile(null)}
            >
              ×
            </button>
            <PreviewImage filePath={previewFile} />
            <div className="duplicate-preview-nav">
              <button
                onClick={() => {
                  const idx = allDuplicateFiles.indexOf(previewFile);
                  if (idx > 0) setPreviewFile(allDuplicateFiles[idx - 1]);
                }}
              >
                ← Previous
              </button>
              <span>
                {allDuplicateFiles.indexOf(previewFile) + 1} /{" "}
                {allDuplicateFiles.length}
              </span>
              <button
                onClick={() => {
                  const idx = allDuplicateFiles.indexOf(previewFile);
                  if (idx < allDuplicateFiles.length - 1)
                    setPreviewFile(allDuplicateFiles[idx + 1]);
                }}
              >
                Next →
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
