import React, { useEffect, useMemo, useRef, useState } from "react";
import { FaBug, FaGithub } from "react-icons/fa";
import {
  FiAlertCircle,
  FiArchive,
  FiBarChart2,
  FiBookOpen,
  FiCamera,
  FiCheck,
  FiCheckCircle,
  FiChevronRight,
  FiCpu,
  FiDownload,
  FiExternalLink,
  FiFilm,
  FiFolder,
  FiHardDrive,
  FiLock,
  FiSearch,
  FiShare2,
  FiShield,
  FiSliders,
  FiUpload,
  FiX,
} from "react-icons/fi";
import type { LifetimeLicenseState } from "../lifetimePayment";
import LifetimeUnlockPanel from "./LifetimeUnlockPanel";
import LibraryShareSettings from "./LibraryShareSettings";
import { FalloutShelterSettings } from "./StatsDashboard";

type SettingsPageId =
  | "update"
  | "bug"
  | "appearance"
  | "share"
  | "backup"
  | "privacy"
  | "performance"
  | "statistics"
  | "cache"
  | "memories"
  | "shelter"
  | "password"
  | "help";

interface SettingsPageDefinition {
  id: SettingsPageId;
  label: string;
  description: string;
  icon: React.ComponentType;
  tint: string;
  keywords: string;
  /** Pages sharing a section are grouped together in the sidebar. */
  section: number;
}

const SETTINGS_PAGES: SettingsPageDefinition[] = [
  { id: "update", label: "Software update", description: "Keep Silo current and manage your license.", icon: FiDownload, tint: "#986b47", keywords: "version upgrade install download release license lifetime demo purchase", section: 0 },
  { id: "bug", label: "Report a bug", description: "Tell us about a problem or a confusing feature.", icon: FaBug, tint: "#806b5b", keywords: "problem feedback issue crash screenshot diagnostics", section: 0 },
  { id: "appearance", label: "Appearance & behavior", description: "Theme and Map behavior.", icon: FiSliders, tint: "#82756a", keywords: "theme dark light system map globe rotation textures", section: 1 },
  { id: "share", label: "Share a library", description: "Let family browse and save originals on your local network.", icon: FiShare2, tint: "#8d6549", keywords: "wifi network family link qr phone browse download", section: 1 },
  { id: "backup", label: "Backup & restore", description: "Save Silo's whole setup to one file and restore it later.", icon: FiArchive, tint: "#746c65", keywords: "export import config configuration reinstall restore", section: 1 },
  { id: "privacy", label: "Privacy & safety", description: "Explicit content is hidden and blocked from search by default.", icon: FiShield, tint: "#696560", keywords: "nsfw safe search explicit banned people parental content protection", section: 1 },
  { id: "performance", label: "Performance", description: "How much CPU time search and indexing can use.", icon: FiCpu, tint: "#986b47", keywords: "cpu threads indexing speed pace", section: 1 },
  { id: "statistics", label: "Library statistics", description: "Inventory, source coverage and indexer progress.", icon: FiBarChart2, tint: "#78716c", keywords: "statistics dashboard totals inventory sources coverage indexing", section: 1 },
  { id: "cache", label: "Silo cache destination", description: "Where indexes, faces, places, thumbnails and previews are stored.", icon: FiHardDrive, tint: "#78716c", keywords: "cache index thumbnails previews external drive storage fallback", section: 2 },
  { id: "memories", label: "Memory destination", description: "Where Memory movies are saved so they play without the source drive.", icon: FiFilm, tint: "#8d6549", keywords: "memories movies videos folder storage", section: 2 },
  { id: "shelter", label: "Fallout Shelter", description: "Choose and verify your separate library backup destination.", icon: FiShield, tint: "#696560", keywords: "fallout shelter backup readiness verify destination", section: 2 },
  { id: "password", label: "Password", description: "The parental password that protects content settings.", icon: FiLock, tint: "#696560", keywords: "parental password change create", section: 2 },
  { id: "help", label: "Help & documentation", description: "Guides, walkthroughs and troubleshooting.", icon: FiBookOpen, tint: "#82756a", keywords: "docs documentation guide github source walkthrough", section: 3 },
];

/** Guided-tour targets and the Settings page that contains them. */
const SETTINGS_TOUR_PAGES: Record<string, SettingsPageId> = {
  '[data-tour="settings-license"]': "update",
  '[data-tour="settings-appearance"]': "appearance",
  '[data-tour="library-share"]': "share",
  '[data-tour="settings-backup"]': "backup",
  '[data-tour="content-protection"]': "privacy",
  '[data-tour="settings-performance"]': "performance",
  '[data-tour="library-statistics"]': "statistics",
  '[data-tour="settings-cache-destination"]': "cache",
  '[data-tour="settings-memories"]': "memories",
  '[data-tour="fallout-shelter"]': "shelter",
  '[data-tour="settings-password"]': "password",
};

const SETTINGS_PAGE_STORAGE_KEY = "silo.settings.page";

function initialSettingsPage(focusTarget: string | null | undefined): SettingsPageId {
  if (focusTarget && SETTINGS_TOUR_PAGES[focusTarget]) return SETTINGS_TOUR_PAGES[focusTarget];
  try {
    const stored = localStorage.getItem(SETTINGS_PAGE_STORAGE_KEY);
    if (SETTINGS_PAGES.some((page) => page.id === stored)) return stored as SettingsPageId;
  } catch {
    // Storage can be unavailable; fall back to the first page.
  }
  return "update";
}

function SettingsIconTile({ page, size = "small" }: { page: SettingsPageDefinition; size?: "small" | "large" }) {
  return (
    <span className={`settings-icon-tile ${size}`} style={{ background: page.tint }} aria-hidden="true">
      <page.icon />
    </span>
  );
}

interface SettingsPanelProps {
  settings: PublicContentSettings;
  onChange: (settings: PublicContentSettings) => void;
  onClose: () => void;
  onOpenStatistics: () => void;
  onOpenBugReport: () => void;
  hideSettingsForScreenshot?: boolean;
  lifetimePromptRequest?: number;
  onLifetimePromptHandled: () => void;
  /** Guided-tour target to reveal; opens the Settings page containing it. */
  focusTarget?: string | null;
}

function formatSystemMemory(bytes: number) {
  const gigabytes = bytes / 1024 ** 3;
  return `${gigabytes >= 10 ? gigabytes.toFixed(0) : gigabytes.toFixed(1)} GB`;
}

function PerformanceSettingsSection() {
  const electronAPI = window.electron;
  const [snapshot, setSnapshot] = useState<SearchPerformanceSnapshot | null>(null);
  const [draft, setDraft] = useState<SearchPerformanceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void electronAPI?.getSearchPerformanceSettings()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setDraft(next.settings);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Computer performance details could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [electronAPI]);

  const save = async () => {
    if (!electronAPI || !draft) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await electronAPI.updateSearchPerformanceSettings(draft);
      setSnapshot(next);
      setDraft(next.settings);
      setMessage("Performance settings saved.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Performance settings could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    if (!snapshot) return;
    const available = snapshot.machine.availableProcessors;
    setDraft({
      searchThreads: Math.max(1, Math.min(2, available - 1)),
      indexThreads: 1,
      backgroundWorkPercent: 5,
    });
    setMessage("");
    setError("");
  };

  const machine = snapshot?.machine;
  const platform =
    machine?.platform === "darwin"
      ? "macOS"
      : machine?.platform === "win32"
        ? "Windows"
        : machine?.platform === "linux"
          ? "Linux"
          : machine?.platform ?? "This computer";
  const dirty = Boolean(
    snapshot && draft &&
      (snapshot.settings.searchThreads !== draft.searchThreads ||
        snapshot.settings.indexThreads !== draft.indexThreads ||
        snapshot.settings.backgroundWorkPercent !== draft.backgroundWorkPercent),
  );

  return (
    <section
      className="settings-card settings-card-padded settings-performance-section"
      data-tour="settings-performance"
      data-help="Tune the CPU threads used for semantic search and background indexing. Silo reports the hardware available to it and applies an honest work-time budget instead of promising a whole-computer CPU cap."
    >
      {machine ? (
        <div className="settings-performance-machine" aria-label="Detected computer">
          <strong>{machine.processor}</strong>
          <span>
            {machine.availableProcessors} of {machine.logicalProcessors} logical
            processor threads available to Silo
          </span>
          <span>
            {formatSystemMemory(machine.totalMemoryBytes)} memory ·{" "}
            {formatSystemMemory(machine.freeMemoryBytes)} currently free
          </span>
          <span>{platform} · {machine.architecture}</span>
        </div>
      ) : (
        <p className="settings-footnote">Reading this computer’s available CPU and memory…</p>
      )}

      {draft && machine && (
        <>
          <label className="settings-performance-control">
            <span>
              <strong>Interactive semantic search</strong>
              <b>{draft.searchThreads} {draft.searchThreads === 1 ? "thread" : "threads"}</b>
            </span>
            <input
              type="range"
              min={1}
              max={machine.availableProcessors}
              step={1}
              value={draft.searchThreads}
              disabled={busy}
              aria-label="Maximum CPU threads for interactive semantic search"
              onChange={(event) => {
                setDraft({ ...draft, searchThreads: Number(event.target.value) });
                setMessage("");
              }}
            />
            <small>Uses up to the selected number of threads to rank a search.</small>
          </label>

          <label className="settings-performance-control">
            <span>
              <strong>Background index preparation</strong>
              <b>{draft.indexThreads} {draft.indexThreads === 1 ? "thread" : "threads"}</b>
            </span>
            <input
              type="range"
              min={1}
              max={machine.availableProcessors}
              step={1}
              value={draft.indexThreads}
              disabled={busy}
              aria-label="Maximum CPU threads for background index preparation"
              onChange={(event) => {
                setDraft({ ...draft, indexThreads: Number(event.target.value) });
                setMessage("");
              }}
            />
            <small>Limits the threads used to build and update the saved vector index.</small>
          </label>

          <label className="settings-performance-control">
            <span>
              <strong>Background indexing pace</strong>
              <b>{draft.backgroundWorkPercent}%</b>
            </span>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={draft.backgroundWorkPercent}
              disabled={busy}
              aria-label="Background indexing work-time budget"
              onChange={(event) => {
                setDraft({ ...draft, backgroundWorkPercent: Number(event.target.value) });
                setMessage("");
              }}
            />
            <small>
              Sets the CPU work-time budget for source scans and background index
              preparation. The operating system still schedules CPU use, so this
              is not a whole-computer CPU percentage cap.
            </small>
          </label>
        </>
      )}

      <p className="settings-footnote">
        Search gets priority over source scans and background index preparation.
        Thread limits apply to vector-search operations; other app work and the
        operating system can affect total CPU use.
      </p>
      {error && <p className="settings-message error" role="alert">{error}</p>}
      {message && <p className="settings-message" role="status">{message}</p>}
      <div className="settings-performance-actions">
        <button
          className="settings-save"
          type="button"
          disabled={!dirty || busy || !draft}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Apply performance settings"}
        </button>
        <button
          className="settings-secondary"
          type="button"
          disabled={!machine || busy}
          onClick={reset}
        >
          Recommended defaults
        </button>
      </div>
    </section>
  );
}

function ScreenshotBeetle() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="m18 13-5-6m17 6 5-6M13 23l-7-3m29 3 7-3M13 31l-7 3m29-3 7 3" />
      <path className="beetle-shell" d="M24 13c-8 0-13 6-13 15 0 8 5 14 13 14s13-6 13-14c0-9-5-15-13-15Z" />
      <path className="beetle-seam" d="M24 15v25" />
      <circle className="beetle-spot" cx="18" cy="23" r="2.1" />
      <circle className="beetle-spot" cx="30" cy="23" r="2.1" />
      <circle className="beetle-spot" cx="18" cy="32" r="2.1" />
      <circle className="beetle-spot" cx="30" cy="32" r="2.1" />
      <path className="beetle-head" d="M18 13c0-4 2.4-7 6-7s6 3 6 7" />
      <circle className="beetle-eye" cx="21.5" cy="10" r="1" />
      <circle className="beetle-eye" cx="26.5" cy="10" r="1" />
    </svg>
  );
}

export function BugReportDialog({
  onClose,
  onSubmitted,
  onScreenshotSelectionChange,
  diagnosticReport = null,
}: {
  onClose: () => void;
  onSubmitted: () => void;
  onScreenshotSelectionChange: (selecting: boolean) => void;
  diagnosticReport?: IndexingDiagnosticReport | null;
}) {
  const electronAPI = window.electron;
  const [relayStatus, setRelayStatus] = useState<{
    available: boolean;
    message: string;
  }>({
    available: false,
    message: "Checking secure email delivery…",
  });
  const [features, setFeatures] = useState<string[]>([]);
  const [feature, setFeature] = useState("");
  const [message, setMessage] = useState("");
  const [diagnosticConsent, setDiagnosticConsent] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(
    null,
  );
  const [selectingScreenshot, setSelectingScreenshot] = useState(false);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [sent, setSent] = useState(false);
  const [beetleCue, setBeetleCue] = useState<{
    left: number;
    top: number;
    phase: "rising" | "pointing" | "jiggling" | "returning" | "resting";
  } | null>(null);
  const [captureCueFlashing, setCaptureCueFlashing] = useState(false);
  const captureButtonRef = React.useRef<HTMLButtonElement>(null);
  const captureControlsRef = React.useRef<HTMLDivElement>(null);
  const screenshotActionRef = React.useRef<HTMLButtonElement>(null);
  const selectionWasActive = React.useRef(false);
  const pointerPositionRef = React.useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!diagnosticReport) return;
    setMessage(diagnosticReport.message);
    setFeature(
      diagnosticReport.reason === "indexing-error" ||
        diagnosticReport.reason === "indexing-stalled" ||
        diagnosticReport.reason === "semantic-preload-failed"
        ? "Indexing"
        : "App crash",
    );
    setDiagnosticConsent(false);
    setScreenshotDataUrl(null);
    setNotice("");
  }, [diagnosticReport?.id]);

  useEffect(() => {
    let active = true;
    void electronAPI?.getBugReportStatus()
      .then((status) => {
        if (active) setRelayStatus(status);
      })
      .catch(() => {
        if (active)
          setRelayStatus({
            available: false,
            message: "Secure email delivery could not be checked.",
          });
      });

    const labels = new Set<string>();
    document.querySelectorAll<HTMLElement>("[data-help]").forEach((element) => {
      const bounds = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        bounds.bottom <= 0 ||
        bounds.top >= window.innerHeight ||
        style.visibility === "hidden" ||
        style.display === "none"
      )
        return;
      const label = (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.dataset.tour?.replace(/[-_]/g, " ") ||
        element.dataset.help
      )
        ?.replace(/\s+/g, " ")
        .trim();
      if (label) labels.add(label.slice(0, 180));
    });
    setFeatures(Array.from(labels).slice(0, 100));
    return () => {
      active = false;
    };
  }, [electronAPI]);

  useEffect(() => {
    if (selectingScreenshot) {
      selectionWasActive.current = true;
      captureButtonRef.current?.focus();
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && !capturingScreenshot) {
          event.preventDefault();
          setSelectingScreenshot(false);
          onScreenshotSelectionChange(false);
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
    if (selectionWasActive.current && !capturingScreenshot) {
      selectionWasActive.current = false;
      screenshotActionRef.current?.focus();
    }
  }, [selectingScreenshot, capturingScreenshot, onScreenshotSelectionChange]);

  useEffect(() => {
    if (!selectingScreenshot) {
      setBeetleCue(null);
      setCaptureCueFlashing(false);
      return;
    }

    let pointerHasMoved = false;
    let pointTimer: number | undefined;
    let returnTimer: number | undefined;
    let restTimer: number | undefined;
    let flashTimer: number | undefined;
    setBeetleCue({
      left: window.innerWidth / 2,
      top: window.innerHeight + 36,
      phase: "rising",
    });
    const launchFrame = window.requestAnimationFrame(() => {
      pointTimer = window.setTimeout(() => {
        if (pointerHasMoved) {
          setBeetleCue({
            left: pointerPositionRef.current.x + 16,
            top: pointerPositionRef.current.y - 30,
            phase: "pointing",
          });
        }
      }, 280);
    });
    const handlePointerMove = (event: PointerEvent) => {
      pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      pointerHasMoved = true;
    };
    window.addEventListener("pointermove", handlePointerMove);

    const jiggleTimer = window.setTimeout(() => {
      setBeetleCue((current) =>
        current ? { ...current, phase: "jiggling" } : current,
      );
      returnTimer = window.setTimeout(() => {
        const bounds = captureControlsRef.current?.getBoundingClientRect();
        if (!bounds) return;
        setBeetleCue({
          left: bounds.left + 18,
          top: bounds.top - 10,
          phase: "returning",
        });
        restTimer = window.setTimeout(() => {
          setBeetleCue((current) =>
            current ? { ...current, phase: "resting" } : current,
          );
          setCaptureCueFlashing(true);
          flashTimer = window.setTimeout(() => setCaptureCueFlashing(false), 1900);
        }, 650);
      }, 750);
    }, 1100);

    return () => {
      window.cancelAnimationFrame(launchFrame);
      if (pointTimer !== undefined) window.clearTimeout(pointTimer);
      window.clearTimeout(jiggleTimer);
      if (returnTimer !== undefined) window.clearTimeout(returnTimer);
      if (restTimer !== undefined) window.clearTimeout(restTimer);
      if (flashTimer !== undefined) window.clearTimeout(flashTimer);
      window.removeEventListener("pointermove", handlePointerMove);
    };
  }, [selectingScreenshot]);

  const beginScreenshotSelection = (event: React.MouseEvent<HTMLButtonElement>) => {
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    setNotice("");
    setSelectingScreenshot(true);
    onScreenshotSelectionChange(true);
  };

  const cancelScreenshotSelection = () => {
    setSelectingScreenshot(false);
    onScreenshotSelectionChange(false);
  };

  const captureScreenshot = async () => {
    if (!electronAPI) return;
    setBusy(true);
    setNotice("");
    setCapturingScreenshot(true);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      setScreenshotDataUrl(await electronAPI.captureBugReportScreenshot());
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : "Silo could not capture a screenshot.",
      );
    } finally {
      setCapturingScreenshot(false);
      setSelectingScreenshot(false);
      onScreenshotSelectionChange(false);
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!electronAPI) {
      setNotice("Secure report delivery is unavailable in this session.");
      return;
    }
    if (!message.trim()) {
      setNotice("Add a short description before sending your report.");
      return;
    }
    if (diagnosticReport && !diagnosticConsent) {
      setNotice("Confirm email consent before sending this diagnostic report.");
      return;
    }
    if (!relayStatus.available) {
      setNotice(relayStatus.message);
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const result = await electronAPI.submitBugReport({
        message: message.trim(),
        feature: feature || null,
        screenshotDataUrl,
      });
      if (!result.ok) {
        setNotice(result.error || "Silo could not send the report.");
        return;
      }
      setSent(true);
      onSubmitted();
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : "Silo could not send the report. Your text is still here.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={`bug-report-backdrop${selectingScreenshot ? " capture-hidden" : ""}`}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) onClose();
        }}
      >
        <form
        className="bug-report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-report-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <div>
            <FaBug />
            <h2 id="bug-report-title">Report a Bug</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close bug report"
            aria-label="Close bug report"
            disabled={busy}
          >
            <FiX />
          </button>
        </header>
        <p className="bug-report-intro">
          Silo includes your note, selected feature, app version and platform.
          A screenshot is attached only if you choose one; source paths are not
          added automatically.
        </p>
        {diagnosticReport && (
          <div className="bug-report-diagnostic-consent">
            <p>
              Silo generated this diagnostic report locally. Review or edit it
              below. No filenames, folder paths, file contents, or screenshot
              are included automatically; you can add a screenshot yourself.
              Nothing is sent unless you consent and press Send report.
            </p>
            <label>
              <input
                type="checkbox"
                checked={diagnosticConsent}
                onChange={(event) => setDiagnosticConsent(event.target.checked)}
                disabled={busy || sent}
              />
              I agree to email this report to tani@kolektivkrog.si.
            </label>
          </div>
        )}
        <label className="bug-report-field">
          <span>What happened?</span>
          <textarea
            autoFocus
            maxLength={100000}
            rows={5}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe what you expected and what went wrong…"
            disabled={busy || sent}
          />
          <small>{message.length.toLocaleString()} / 100,000</small>
        </label>
        <label className="bug-report-field">
          <span>Visible feature (optional)</span>
          <select
            value={feature}
            onChange={(event) => setFeature(event.target.value)}
            disabled={busy || sent}
          >
            <option value="">Choose a visible feature…</option>
            <option value="Indexing">Indexing</option>
            {features.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="bug-report-screenshot">
          <div>
            <strong>Screenshot (optional)</strong>
            <small>
              Hide this form and Settings, navigate to the area you want to
              capture, then use the floating camera control. Review the image
              for private information before sending.
            </small>
          </div>
          <div className="bug-report-screenshot-actions">
            <button
              className="settings-secondary"
              type="button"
              ref={screenshotActionRef}
              onClick={beginScreenshotSelection}
              disabled={busy || sent || !electronAPI}
            >
              <FiCamera /> {screenshotDataUrl ? "Retake screenshot" : "Choose screenshot area"}
            </button>
            {screenshotDataUrl && (
              <button
                className="settings-secondary"
                type="button"
                onClick={() => setScreenshotDataUrl(null)}
                disabled={busy || sent}
              >
                Remove
              </button>
            )}
          </div>
          {screenshotDataUrl && (
            <img
              className="bug-report-screenshot-preview"
              src={screenshotDataUrl}
              alt="Preview of the screenshot that will be attached"
            />
          )}
        </div>
        <p
          className={`bug-report-relay ${relayStatus.available ? "ready" : ""}`}
          role="status"
        >
          {relayStatus.message} Destination mailbox: tani@kolektivkrog.si.
        </p>
        {notice && (
          <p
            className={`bug-report-notice ${sent ? "success" : ""}`}
            role={sent ? "status" : "alert"}
          >
            {sent ? <FiCheck /> : <FiAlertCircle />} {notice}
          </p>
        )}
        <footer>
          <button
            className="settings-secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
          <button
            className="settings-save"
            type="submit"
            disabled={busy || sent || Boolean(diagnosticReport && !diagnosticConsent)}
          >
            {busy
              ? "Sending…"
              : sent
                ? "Report sent"
                : diagnosticReport
                  ? "Send diagnostic report"
                  : "Send report"}
          </button>
        </footer>
        </form>
      </div>
      {selectingScreenshot && (
        <>
          <div
            ref={captureControlsRef}
            className={`bug-report-capture-controls${capturingScreenshot ? " capturing" : ""}${captureCueFlashing ? " cue-flash" : ""}`}
            role="region"
            aria-label="Screenshot capture controls"
          >
            <p>
              {capturingScreenshot
                ? "Capturing the current Silo view…"
                : "Navigate to the area you want to capture."}
            </p>
            <button
              ref={captureButtonRef}
              className="bug-report-capture-button"
              type="button"
              onClick={() => void captureScreenshot()}
              disabled={capturingScreenshot || !electronAPI}
              aria-label="Capture screenshot"
              title="Capture screenshot"
            >
              <FiCamera /> <span>Capture screenshot</span>
            </button>
            <button
              className="bug-report-capture-cancel"
              type="button"
              onClick={cancelScreenshotSelection}
              disabled={capturingScreenshot}
            >
              Cancel
            </button>
          </div>
          {beetleCue && (
            <div
              className={`bug-report-beetle-cue ${beetleCue.phase}`}
              style={{ left: beetleCue.left, top: beetleCue.top }}
              aria-hidden="true"
            >
              <ScreenshotBeetle />
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function SettingsPanel({
  settings,
  onChange,
  onClose,
  onOpenStatistics,
  onOpenBugReport,
  hideSettingsForScreenshot = false,
  lifetimePromptRequest = 0,
  onLifetimePromptHandled,
  focusTarget = null,
}: SettingsPanelProps) {
  const electronAPI = window.electron;
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [configTransferProgress, setConfigTransferProgress] =
    useState<ConfigTransferProgress | null>(null);
  const [pendingImport, setPendingImport] = useState<SiloConfigManifest | null>(
    null,
  );
  const [memoryDirectory, setMemoryDirectory] = useState<string | null>(null);
  const [cacheDestination, setCacheDestination] = useState("");
  const [localFallbackEnabled, setLocalFallbackEnabled] = useState(true);
  const [showLifetimeUnlock, setShowLifetimeUnlock] = useState(false);
  const [directLifetimePurchase, setDirectLifetimePurchase] = useState(false);
  const [lifetimeLicense, setLifetimeLicense] =
    useState<LifetimeLicenseState>({ isLicensed: false });
  const [lifetimeLicenseLoaded, setLifetimeLicenseLoaded] = useState(false);
  const [demoMode, setDemoMode] = useState({
    available: false,
    enabled: false,
  });
  const [demoModeBusy, setDemoModeBusy] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    status: "checking",
    currentVersion: "",
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const [activePage, setActivePage] = useState<SettingsPageId>(() =>
    initialSettingsPage(focusTarget),
  );
  const [pageQuery, setPageQuery] = useState("");
  const openedForTour = useRef(Boolean(focusTarget));
  const openPage = (id: SettingsPageId) => {
    setActivePage(id);
    setError("");
    setNotice("");
  };
  useEffect(() => {
    const page = focusTarget ? SETTINGS_TOUR_PAGES[focusTarget] : undefined;
    if (page) setActivePage(page);
  }, [focusTarget]);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    try {
      localStorage.setItem(SETTINGS_PAGE_STORAGE_KEY, activePage);
    } catch {
      // Remembering the last page is optional.
    }
  }, [activePage]);
  const visiblePages = useMemo(() => {
    const terms = pageQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return SETTINGS_PAGES;
    return SETTINGS_PAGES.filter((page) => {
      const haystack = `${page.label} ${page.description} ${page.keywords}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [pageQuery]);
  const currentPage = SETTINGS_PAGES.find((page) => page.id === activePage) ?? SETTINGS_PAGES[0];
  const cacheDestinationIsRequired =
    !cacheDestination || /file-browser-electron/i.test(cacheDestination);

  useEffect(() => {
    return electronAPI?.onConfigTransferProgress?.(setConfigTransferProgress);
  }, [electronAPI]);

  useEffect(() => {
    if (lifetimePromptRequest <= 0) return;
    setShowLifetimeUnlock(true);
    onLifetimePromptHandled();
  }, [lifetimePromptRequest, onLifetimePromptHandled]);

  useEffect(() => {
    let disposed = false;
    void electronAPI?.getMemories?.(false)
      .then((state) => {
        if (!disposed) setMemoryDirectory(state.settings.movieDirectory ?? null);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [electronAPI]);

  useEffect(() => {
    let disposed = false;
    void electronAPI?.getLocalIndexFallbackEnabled()
      .then((enabled) => {
        if (!disposed) setLocalFallbackEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [electronAPI]);

  useEffect(() => {
    let disposed = false;
    void electronAPI?.getIndexStorageRoot()
      .then((root) => {
        if (disposed) return;
        setCacheDestination(root);
        // A missing cache destination blocks indexing, so open straight to it.
        if ((!root || /file-browser-electron/i.test(root)) && !openedForTour.current) setActivePage("cache");
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [electronAPI]);

  useEffect(() => {
    let disposed = false;
    const load = () =>
      void electronAPI?.getLifetimeLicense()
        .then((license) => {
          if (!disposed) {
            setLifetimeLicense(license);
            setLifetimeLicenseLoaded(true);
          }
        })
        .catch(() => undefined);
    load();
    const removeListener = electronAPI?.onLifetimeAccessChanged?.(load);
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [electronAPI]);

  useEffect(() => {
    let disposed = false;
    if (!electronAPI?.getDemoTestingMode) return;
    void electronAPI
      .getDemoTestingMode()
      .then((state) => {
        if (!disposed) setDemoMode(state);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [electronAPI, lifetimeLicense.isLicensed]);

  useEffect(() => {
    if (!electronAPI?.getAppUpdateState || !electronAPI.checkForAppUpdates)
      return;
    let disposed = false;
    const receiveUpdateState = (state: AppUpdateState) => {
      if (!disposed) setAppUpdate(state);
    };
    const removeListener = electronAPI.onAppUpdateState(receiveUpdateState);
    void electronAPI
      .getAppUpdateState()
      .then(receiveUpdateState)
      .catch(() => undefined);
    void electronAPI
      .checkForAppUpdates()
      .then(receiveUpdateState)
      .catch(() => undefined);
    return () => {
      disposed = true;
      removeListener();
    };
  }, [electronAPI]);

  const toggleDemoTestingMode = async () => {
    if (!electronAPI?.setDemoTestingMode) return;
    setDemoModeBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await electronAPI.setDemoTestingMode(!demoMode.enabled);
      if (result.restarting) {
        setDemoMode(result);
        setNotice(
          result.enabled
            ? "Silo is restarting with demo testing limits. Your lifetime license remains saved."
            : "Silo is restarting with full lifetime access.",
        );
      } else {
        setNotice("No access-mode change was made.");
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Demo testing mode could not be changed.",
      );
    } finally {
      setDemoModeBusy(false);
    }
  };

  const changeMemoryDirectory = async (clear: boolean) => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const state = clear
        ? await electronAPI.updateMemorySettings({ movieDirectory: null })
        : await electronAPI.selectMemoryDirectory();
      setMemoryDirectory(state.settings.movieDirectory ?? null);
      setNotice("Memory destination saved.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Destination could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const changeCacheDestination = async () => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await electronAPI.selectIndexStorageRoot();
      if (result.error) throw new Error(result.error);
      if (result.path) setCacheDestination(result.path);
      if (result.restarting)
        setNotice("Silo is restarting to verify and move its index caches.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Silo cache destination could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const changeLocalFallback = async () => {
    if (!electronAPI?.setLocalIndexFallbackEnabled) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await electronAPI.setLocalIndexFallbackEnabled(
        !localFallbackEnabled,
      );
      setLocalFallbackEnabled(result.enabled);
      setNotice(
        result.restarting
          ? "Silo is restarting to apply the local cache choice."
          : result.enabled
            ? "Local cache fallback is enabled."
            : "Indexing will pause when the selected destination is unavailable.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The local cache preference could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const exportConfig = async () => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("");
    setConfigTransferProgress(null);
    try {
      const prefs: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith("silo."))
          prefs[key] = localStorage.getItem(key) ?? "";
      }
      const result = await electronAPI.exportConfig(prefs);
      if (result.canceled) {
        setConfigTransferProgress(null);
      } else if (!result.ok) {
        throw new Error(result.error || "Export failed.");
      } else {
        setConfigTransferProgress(null);
        setNotice(
          `Config saved (${((result.size ?? 0) / 1024 / 1024).toFixed(1)} MB) to ${result.path}.`,
        );
      }
    } catch (cause) {
      setConfigTransferProgress(null);
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  const importConfig = async () => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("");
    setConfigTransferProgress(null);
    try {
      const result = await electronAPI.importConfig();
      if (result.canceled) {
        setConfigTransferProgress(null);
        return;
      }
      if (!result.ok || !result.manifest)
        throw new Error(result.error || "Import failed.");
      setConfigTransferProgress(null);
      setPendingImport(result.manifest);
    } catch (cause) {
      setConfigTransferProgress(null);
      setError(cause instanceof Error ? cause.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const applyImport = async () => {
    if (!electronAPI || !pendingImport) return;
    for (const [key, value] of Object.entries(pendingImport.rendererPrefs))
      localStorage.setItem(key, value);
    setBusy(true);
    setNotice("Restoring config and restarting…");
    await electronAPI.applyConfigImport();
  };

  const update = async (
    changes: Partial<ContentPreferences>,
    protectedChange = false,
  ) => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await electronAPI.updateContentSettings(
        changes,
        protectedChange ? password : undefined,
      );
      onChange(next);
      if (protectedChange) setPassword("");
      setNotice("Settings saved.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      const readableMessage = message
        .replace(/^Error invoking remote method ['"‘’“”]?update-content-settings['"‘’“”]?:\s*/i, "")
        .replace(/^Error:\s*/i, "")
        .trim();
      setError(
        readableMessage && readableMessage.toLowerCase() !== "error"
          ? readableMessage
          : "Privacy & Safety settings could not be saved. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (!electronAPI) return;
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await electronAPI.setParentalPassword(
        currentPassword,
        newPassword,
      );
      onChange(next);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(
        settings.parentalPasswordSet
          ? "Parental password changed."
          : "Parental password created.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Password could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const updateBadge = appUpdate.status === "available";
  const updateTitle =
    appUpdate.status === "available"
      ? `Silo ${appUpdate.version ?? ""} is available`.replace("  ", " ")
      : appUpdate.status === "not-available"
      ? "Silo is up to date"
      : appUpdate.status === "checking"
      ? "Checking for updates…"
      : appUpdate.status === "downloading"
      ? "Downloading update"
      : appUpdate.status === "installing"
      ? "Installing update"
      : "Software updates";
  const updateDetail =
    appUpdate.status === "checking"
      ? appUpdate.message ?? "Checking for a newer Silo version…"
      : appUpdate.status === "available"
      ? appUpdate.message ?? `Silo ${appUpdate.version} is ready to download and install.`
      : appUpdate.status === "downloading"
      ? `Downloading Silo ${appUpdate.version ?? "update"}… ${appUpdate.downloadPercent ?? 0}%`
      : appUpdate.status === "installing"
      ? appUpdate.message ?? "Silo is installing the update and will restart automatically."
      : appUpdate.status === "not-available"
      ? `You're running Silo ${appUpdate.currentVersion}.`
      : appUpdate.status === "unsupported"
      ? appUpdate.message
      : appUpdate.message ?? "Could not check for updates.";

  const renderPage = () => {
    switch (activePage) {
      case "update":
        return (
          <>
            <section className="settings-card settings-update-section" aria-live="polite">
              <div className="settings-row settings-update-row">
                <span className={`settings-update-icon${updateBadge ? " available" : ""}`} aria-hidden="true">
                  {appUpdate.status === "not-available" ? <FiCheckCircle /> : <FiDownload />}
                </span>
                <div className="settings-row-text">
                  <strong>{updateTitle}</strong>
                  <span>{updateDetail}</span>
                  {appUpdate.status === "downloading" && (
                    <progress
                      className="settings-update-progress"
                      max={100}
                      value={appUpdate.downloadPercent ?? 0}
                      aria-label="Update download progress"
                    />
                  )}
                </div>
                {appUpdate.status === "available" && appUpdate.downloadUrl && (
                  <button
                    type="button"
                    className="settings-save"
                    onClick={() => void electronAPI?.downloadAndInstallAppUpdate()}
                  >
                    Update now
                  </button>
                )}
                {appUpdate.status === "installing" && (
                  <button type="button" className="settings-save" disabled>
                    Restarting…
                  </button>
                )}
                {appUpdate.status === "error" && appUpdate.downloadUrl && (
                  <a
                    className="settings-secondary"
                    href={appUpdate.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {`Download ${appUpdate.installerLabel ?? "installer"}`}
                  </a>
                )}
                {appUpdate.status === "available" &&
                  !appUpdate.downloadUrl &&
                  appUpdate.releaseUrl && (
                    <a
                      className="settings-secondary"
                      href={appUpdate.releaseUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View release
                    </a>
                  )}
              </div>
            </section>
            {lifetimeLicenseLoaded && !lifetimeLicense.isLicensed && (
              <>
                <h4 className="settings-group-label">License</h4>
                <section
                  className="settings-card settings-license-section"
                  data-tour="settings-license"
                  data-help={
                    demoMode.enabled
                      ? "Demo testing limits are active while your paid or beta lifetime license remains saved."
                      : "Demo limits stay unobtrusive until you choose a feature that is not included."
                  }
                >
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <strong>
                        {demoMode.enabled ? "Demo testing mode enabled" : "Demo mode"}
                      </strong>
                      <span>
                        {demoMode.enabled
                          ? "Demo limits are active for testing; your lifetime license is still saved on this installation."
                          : "Indexes up to 1,000 representative files with real search, face scanning, place mapping and deduplication. Demo deletion is limited to 100 files."}
                      </span>
                    </div>
                    <button
                      className="settings-save"
                      onClick={() => {
                        setDirectLifetimePurchase(true);
                        setShowLifetimeUnlock(true);
                      }}
                      data-help="Open the one-time lifetime purchase choices directly from Settings."
                    >
                      Lifetime options
                    </button>
                  </div>
                </section>
              </>
            )}
            {demoMode.available && (
              <>
                <h4 className="settings-group-label">Developer testing</h4>
                <section className="settings-card" data-help="This control is available only in the local npm run dev build and restarts Silo with demo limits for tour testing. Your saved lifetime license is retained.">
                  <label className="settings-row settings-toggle">
                    <div className="settings-row-text">
                      <strong>Activate demo mode</strong>
                      <span>Apply demo limits after restarting Silo. Your lifetime license remains saved.</span>
                    </div>
                    <input
                      type="checkbox"
                      className="settings-switch"
                      role="switch"
                      aria-label="Activate demo mode"
                      checked={demoMode.enabled}
                      disabled={demoModeBusy}
                      onChange={() => void toggleDemoTestingMode()}
                    />
                  </label>
                </section>
              </>
            )}
          </>
        );
      case "bug":
        return (
          <section className="settings-card settings-bug-report">
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>Send a bug report</strong>
                <span>
                  Describe what happened and, if you like, attach a screenshot of the
                  Silo window. Reports never include your files.
                </span>
              </div>
              <button
                className="settings-save"
                onClick={onOpenBugReport}
                data-help="Describe a problem, identify a visible feature, and optionally attach a screenshot of the Silo window."
              >
                <FaBug /> Report a bug
              </button>
            </div>
          </section>
        );
      case "appearance":
        return (
          <section
            className="settings-card"
            data-tour="settings-appearance"
            data-help="Choose the app theme and whether the Map globe rotates automatically when the Map page opens."
          >
            <label className="settings-row">
              <div className="settings-row-text">
                <strong>Theme</strong>
                <span>Follow your system appearance, or always use Dark or Light.</span>
              </div>
              <select
                className="settings-compact-select"
                value={settings.theme}
                data-help="Choose whether Silo follows macOS appearance or always uses Dark or Light mode."
                onChange={(event) =>
                  void update({
                    theme: event.target.value as ContentPreferences["theme"],
                  })
                }
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label className="settings-row settings-toggle">
              <div className="settings-row-text">
                <strong>Automatic globe rotation</strong>
                <span>Resume slow globe movement when Map opens.</span>
              </div>
              <input
                type="checkbox"
                className="settings-switch"
                checked={settings.autoplayGlobe}
                data-help="Resume slow globe rotation automatically when you open Map."
                onChange={(event) => void update({ autoplayGlobe: event.target.checked })}
              />
            </label>
            <label className="settings-row settings-toggle">
              <div className="settings-row-text">
                <strong>Preload Map textures</strong>
                <span>Load the globe images after Silo opens so Map appears faster.</span>
              </div>
              <input
                type="checkbox"
                className="settings-switch"
                checked={settings.preloadMapTextures}
                data-help="Load the local day and night globe images in the background after Silo opens so Map can appear sooner on its first visit."
                onChange={(event) => void update({ preloadMapTextures: event.target.checked })}
              />
            </label>
          </section>
        );
      case "share":
        return <LibraryShareSettings />;
      case "backup":
        return (
          <>
            <section
              className="settings-card"
              data-tour="settings-backup"
              data-help="Export or review a Silo configuration restore. Restore replaces app setup and restarts Silo, but does not modify source media; protect exported credentials."
            >
              {pendingImport ? (
                <div className="settings-row settings-import-review">
                  <div className="settings-row-text">
                    <strong>
                      Restore the config from{" "}
                      {new Date(pendingImport.exportedAt).toLocaleString()}?
                    </strong>
                    <span>
                      Made with Silo {pendingImport.appVersion} · {pendingImport.entries.length} data
                      sets. Your current setup is replaced and Silo restarts. Photos and other
                      files on disk are not touched.
                    </span>
                  </div>
                  <div className="settings-row-actions">
                    <button
                      className="settings-secondary"
                      disabled={busy}
                      onClick={() => {
                        setPendingImport(null);
                        void electronAPI?.cancelConfigImport();
                      }}
                      data-help="Cancel this restore review and keep the current Silo setup."
                    >
                      Cancel
                    </button>
                    <button
                      className="settings-save"
                      disabled={busy}
                      onClick={() => void applyImport()}
                      data-help="Replace the current Silo setup with the reviewed config and restart the app; source files are not changed."
                    >
                      Restore & restart
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <strong>Export configuration</strong>
                      <span>
                        Search index, people and bans, keywords, albums, map locations,
                        magic scores, sources, sorting, theme and search history.
                      </span>
                    </div>
                    <button
                      className="settings-save"
                      disabled={busy}
                      onClick={() => void exportConfig()}
                      data-help="Export Silo configuration and library knowledge to a private backup file."
                    >
                      <FiDownload /> Export…
                    </button>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <strong>Import configuration</strong>
                      <span>Restore after reinstalling to skip re-indexing and re-confirming.</span>
                    </div>
                    <button
                      className="settings-secondary"
                      disabled={busy}
                      onClick={() => void importConfig()}
                      data-help="Choose a previously exported Silo config file and review its contents before restoring."
                    >
                      <FiUpload /> Import…
                    </button>
                  </div>
                </>
              )}
            </section>
            <p className="settings-group-note">
              The file contains connected-account sign-in tokens and your parental
              password hash, so keep it somewhere private. Thumbnails, previews and
              phone backups aren't included; thumbnails and previews rebuild automatically.
            </p>
          </>
        );
      case "privacy":
        return (
          <>
            <section
              className="settings-card"
              data-tour="content-protection"
              data-help="Control visibility of explicit images, explicit search, and banned people. Protected changes require the parental password."
            >
              <label className="settings-row settings-toggle">
                <div className="settings-row-text">
                  <strong>Show NSFW images</strong>
                  <span>Display files flagged by explicit terms or visual safety classification.</span>
                </div>
                <input
                  type="checkbox"
                  className="settings-switch"
                  checked={settings.showNsfw}
                  disabled={busy || !settings.parentalPasswordSet}
                  data-help="Allow images flagged by explicit terms or visual safety classification to appear."
                  onChange={(event) => void update({ showNsfw: event.target.checked }, true)}
                />
              </label>
              <label className="settings-row settings-toggle">
                <div className="settings-row-text">
                  <strong>Safe Search</strong>
                  <span>Reject explicit queries and remove flagged results.</span>
                </div>
                <input
                  type="checkbox"
                  className="settings-switch"
                  checked={settings.safeSearch}
                  disabled={busy || !settings.parentalPasswordSet}
                  data-help="Keep explicit queries and flagged results out of search."
                  onChange={(event) => void update({ safeSearch: event.target.checked }, true)}
                />
              </label>
              <label className="settings-row settings-toggle">
                <div className="settings-row-text">
                  <strong>Show banned people</strong>
                  <span>Photos of people you banned in People → Confirmed faces stay hidden unless this is on.</span>
                </div>
                <input
                  type="checkbox"
                  className="settings-switch"
                  checked={settings.showBannedPeople}
                  disabled={busy}
                  data-help="Allow photos containing people you banned to appear in the library."
                  onChange={(event) => void update({ showBannedPeople: event.target.checked })}
                />
              </label>
            </section>
            <h4 className="settings-group-label">Authorize changes</h4>
            <section className="settings-card">
              {settings.parentalPasswordSet ? (
                <label className="settings-row">
                  <div className="settings-row-text">
                    <strong>Parental password</strong>
                    <span>Required before NSFW or Safe Search can change.</span>
                  </div>
                  <input
                    type="password"
                    className="settings-compact-input"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Password"
                    autoComplete="current-password"
                    data-help="Enter the parental password to authorize protected-content setting changes."
                  />
                </label>
              ) : (
                <button type="button" className="settings-row settings-link-row" onClick={() => openPage("password")}>
                  <div className="settings-row-text">
                    <strong>Create a parental password</strong>
                    <span>NSFW and Safe Search stay locked until a password exists.</span>
                  </div>
                  <FiChevronRight aria-hidden="true" />
                </button>
              )}
            </section>
          </>
        );
      case "performance":
        return <PerformanceSettingsSection />;
      case "statistics":
        return (
          <>
            <section
              className="settings-card settings-statistics-section"
              data-tour="library-statistics"
              data-help="Open the full dashboard to review source inventory and indexing progress. Refresh measurements when you need current totals."
            >
              <button type="button" className="settings-row settings-link-row" onClick={onOpenStatistics}>
                <span className="settings-row-icon" aria-hidden="true"><FiBarChart2 /></span>
                <div className="settings-row-text">
                  <strong>Library statistics</strong>
                  <span>Inventory, source coverage and indexer progress.</span>
                </div>
                <FiChevronRight aria-hidden="true" />
              </button>
            </section>
          </>
        );
      case "cache":
        return (
          <section
            className="settings-card"
            data-tour="settings-cache-destination"
            data-help="Choose the external drive folder for Silo's indexes, thumbnails, previews, and other large generated caches."
          >
            <div className="settings-row">
              <div className="settings-row-text">
                <strong className="settings-status-title">
                  <span className={cacheDestinationIsRequired ? "settings-required-dot" : "settings-ready-dot"} />
                  {cacheDestinationIsRequired ? "Destination required" : "Destination ready"}
                </strong>
                <span className="settings-path" title={cacheDestination || undefined}>
                  {cacheDestinationIsRequired
                    ? "Choose a folder outside Silo's app profile, ideally on an external drive."
                    : cacheDestination}
                </span>
              </div>
              <button
                className="settings-save"
                disabled={busy}
                onClick={() => void changeCacheDestination()}
                data-help="Choose an external-drive folder. Silo restarts, verifies the cache copies, and then removes the old copies."
              >
                <FiFolder /> {cacheDestinationIsRequired ? "Choose…" : "Change…"}
              </button>
            </div>
            <label className="settings-row settings-toggle">
              <div className="settings-row-text">
                <strong>Use a local cache if the destination disconnects</strong>
                <span>
                  Keeps at least 10 GB free and moves the cache back automatically when the
                  destination reconnects. Turn off to pause indexing instead.
                </span>
              </div>
              <input
                type="checkbox"
                className="settings-switch"
                checked={localFallbackEnabled}
                disabled={busy || !electronAPI || !cacheDestination}
                onChange={() => void changeLocalFallback()}
              />
            </label>
          </section>
        );
      case "memories":
        return (
          <section
            className="settings-card"
            data-tour="settings-memories"
            data-help="Choose where generated Memory movies and spare story files are saved; this does not move source media."
          >
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>Save Memory movies to</strong>
                <span
                  className="settings-path"
                  title={memoryDirectory ? `${memoryDirectory}/Silo Memories` : undefined}
                >
                  {memoryDirectory
                    ? `${memoryDirectory}/Silo Memories`
                    : "Silo's app storage on this computer"}
                </span>
              </div>
              <div className="settings-row-actions">
                {memoryDirectory && (
                  <button
                    className="settings-secondary"
                    disabled={busy}
                    onClick={() => void changeMemoryDirectory(true)}
                    data-help="Return Memory movie storage to Silo’s app folder on this Mac."
                  >
                    Reset
                  </button>
                )}
                <button
                  className="settings-save"
                  disabled={busy}
                  onClick={() => void changeMemoryDirectory(false)}
                  data-help="Choose where Silo saves generated Memory movies and spare story files."
                >
                  <FiFolder /> Change…
                </button>
              </div>
            </div>
          </section>
        );
      case "shelter":
        return electronAPI
          ? <FalloutShelterSettings api={electronAPI} />
          : <section className="settings-card" role="status">Fallout Shelter controls are available in the Silo desktop app.</section>;
      case "password":
        return (
          <>
            <section
              className="settings-card"
              data-tour="settings-password"
              data-help="Create or change the parental password used to authorize protected-content setting changes. The password itself is not stored."
            >
              {settings.parentalPasswordSet && (
                <label className="settings-row">
                  <div className="settings-row-text"><strong>Current password</strong></div>
                  <input
                    type="password"
                    className="settings-compact-input"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    placeholder="Required"
                    autoComplete="current-password"
                    data-help="Confirm the current parental password before replacing it."
                  />
                </label>
              )}
              <label className="settings-row">
                <div className="settings-row-text"><strong>New password</strong></div>
                <input
                  type="password"
                  className="settings-compact-input"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="6+ characters"
                  autoComplete="new-password"
                  data-help="Enter a new parental password of at least six characters. Silo stores only a verifier, not the password itself."
                />
              </label>
              <label className="settings-row">
                <div className="settings-row-text"><strong>Confirm</strong></div>
                <input
                  type="password"
                  className="settings-compact-input"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                  data-help="Re-enter the new password so Silo can check both entries match."
                />
              </label>
            </section>
            <div className="settings-page-actions">
              <p className="settings-group-note">The password itself is never stored.</p>
              <button
                className="settings-save"
                disabled={busy || !newPassword || !confirmPassword}
                onClick={() => void savePassword()}
                data-help="Save or replace the parental password used to authorize protected-setting changes."
              >
                {settings.parentalPasswordSet ? "Change password" : "Create password"}
              </button>
            </div>
          </>
        );
      case "help":
        return (
          <section
            className="settings-card"
            data-help="Open the Silo user guide for walkthroughs, feature explanations, limitations, and troubleshooting."
          >
            <a
              className="settings-row settings-link-row"
              href="https://silohelp.kolektivkrog.si/"
              target="_blank"
              rel="noreferrer"
            >
              <span className="settings-row-icon" aria-hidden="true"><FiBookOpen /></span>
              <div className="settings-row-text">
                <strong>Silo Docs</strong>
                <span>Walkthrough, feature guides and troubleshooting tips.</span>
              </div>
              <FiExternalLink aria-hidden="true" />
            </a>
            <a
              className="settings-row settings-link-row"
              href="https://github.com/ilovespectra/Silo"
              target="_blank"
              rel="noreferrer"
            >
              <span className="settings-row-icon" aria-hidden="true"><FaGithub /></span>
              <div className="settings-row-text">
                <strong>Source code</strong>
                <span>Silo on GitHub.</span>
              </div>
              <FiExternalLink aria-hidden="true" />
            </a>
          </section>
        );
    }
  };

  return (
    <>
    <div
      className={`settings-backdrop${hideSettingsForScreenshot ? " capture-hidden" : ""}`}
      role="presentation"
      aria-hidden={hideSettingsForScreenshot}
      onMouseDown={(event) => {
        if (!hideSettingsForScreenshot && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <aside className="settings-sidebar">
          <h2>Settings</h2>
          <label className="settings-search">
            <FiSearch aria-hidden="true" />
            <input
              type="search"
              value={pageQuery}
              onChange={(event) => setPageQuery(event.target.value)}
              placeholder="Search"
              aria-label="Search settings"
            />
          </label>
          <nav className="settings-nav" aria-label="Settings pages">
            {visiblePages.map((page, index) => (
              <React.Fragment key={page.id}>
                {index > 0 && visiblePages[index - 1].section !== page.section && (
                  <span className="settings-nav-divider" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={activePage === page.id ? "active" : ""}
                  aria-current={activePage === page.id ? "page" : undefined}
                  onClick={() => openPage(page.id)}
                >
                  <SettingsIconTile page={page} />
                  <span>{page.label}</span>
                  {page.id === "update" && updateBadge && (
                    <span className="settings-nav-badge" aria-label="Update available">1</span>
                  )}
                  {page.id === "cache" && cacheDestinationIsRequired && (
                    <span className="settings-nav-dot" aria-label="Destination required" />
                  )}
                </button>
              </React.Fragment>
            ))}
            {!visiblePages.length && <p className="settings-nav-empty">No matching settings</p>}
          </nav>
        </aside>

        <div className="settings-main">
          <header className="settings-page-header">
            <SettingsIconTile page={currentPage} size="large" />
            <div>
              <h3>{currentPage.label}</h3>
              <p>{currentPage.description}</p>
            </div>
            <button className="settings-close" onClick={onClose} title="Close settings" aria-label="Close settings">
              <FiX />
            </button>
          </header>
          <div className="settings-content" ref={contentRef}>
            <div className="settings-page" key={activePage}>
              {renderPage()}
            </div>
            <div className="settings-feedback">
              {configTransferProgress && (
                <div
                  className="settings-config-progress"
                  role="status"
                  aria-live="polite"
                >
                  <span>{configTransferProgress.message}</span>
                  <div className="settings-config-progress-row">
                    <progress
                      max={100}
                      value={configTransferProgress.percent ?? undefined}
                      aria-label={configTransferProgress.message}
                    />
                    {configTransferProgress.percent !== null && (
                      <span>{configTransferProgress.percent}%</span>
                    )}
                  </div>
                </div>
              )}
              {error && <div className="settings-message error">{error}</div>}
              {notice && <div className="settings-message">{notice}</div>}
            </div>
          </div>
        </div>
      </section>
    </div>
      {showLifetimeUnlock && (
        <LifetimeUnlockPanel
          license={lifetimeLicense}
          directPurchase={directLifetimePurchase}
          demoTestingModeActive={demoMode.enabled}
          onClose={() => {
            setShowLifetimeUnlock(false);
            setDirectLifetimePurchase(false);
          }}
          onOpenBugReport={onOpenBugReport}
          onVerified={setLifetimeLicense}
        />
      )}
    </>
  );
}
