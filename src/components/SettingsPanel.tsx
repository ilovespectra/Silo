import React, { useEffect, useState } from "react";
import { FaBug } from "react-icons/fa";
import {
  FiAlertCircle,
  FiBarChart2,
  FiCamera,
  FiCheck,
  FiDownload,
  FiFolder,
  FiHardDrive,
  FiLock,
  FiSettings,
  FiShield,
  FiUpload,
  FiX,
} from "react-icons/fi";
import type { LifetimeLicenseState } from "../lifetimePayment";
import LifetimeUnlockPanel from "./LifetimeUnlockPanel";
import LibraryShareSettings from "./LibraryShareSettings";

interface SettingsPanelProps {
  settings: PublicContentSettings;
  onChange: (settings: PublicContentSettings) => void;
  onClose: () => void;
  onOpenStatistics: () => void;
  onOpenBugReport: () => void;
  lifetimePromptRequest?: number;
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
  onScreenshotSelectionChange,
}: {
  onClose: () => void;
  onScreenshotSelectionChange: (selecting: boolean) => void;
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
      setNotice("Your bug report was emailed to tani@kolektivkrog.si.");
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
        <label className="bug-report-field">
          <span>What happened?</span>
          <textarea
            autoFocus
            maxLength={5000}
            rows={5}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe what you expected and what went wrong…"
            disabled={busy || sent}
          />
          <small>{message.length.toLocaleString()} / 5,000</small>
        </label>
        <label className="bug-report-field">
          <span>Visible feature (optional)</span>
          <select
            value={feature}
            onChange={(event) => setFeature(event.target.value)}
            disabled={busy || sent}
          >
            <option value="">Choose a visible feature…</option>
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
            disabled={busy || sent}
          >
            {busy ? "Sending…" : sent ? "Report sent" : "Send report"}
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
  lifetimePromptRequest = 0,
}: SettingsPanelProps) {
  const electronAPI = window.electron;
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState<SiloConfigManifest | null>(
    null,
  );
  const [memoryDirectory, setMemoryDirectory] = useState<string | null>(null);
  const [cacheDestination, setCacheDestination] = useState("");
  const [showLifetimeUnlock, setShowLifetimeUnlock] = useState(false);
  const [lifetimeLicense, setLifetimeLicense] =
    useState<LifetimeLicenseState>({ isLicensed: false });
  const [demoMode, setDemoMode] = useState({
    available: false,
    enabled: false,
  });
  const [demoModeBusy, setDemoModeBusy] = useState(false);

  useEffect(() => {
    if (lifetimePromptRequest > 0) setShowLifetimeUnlock(true);
  }, [lifetimePromptRequest]);

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
    void electronAPI?.getIndexStorageRoot()
      .then((root) => {
        if (!disposed) setCacheDestination(root);
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
          if (!disposed) setLifetimeLicense(license);
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

  const exportConfig = async () => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("Exporting config. Large libraries can take a minute…");
    try {
      const prefs: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith("silo."))
          prefs[key] = localStorage.getItem(key) ?? "";
      }
      const result = await electronAPI.exportConfig(prefs);
      if (result.canceled) setNotice("");
      else if (!result.ok) throw new Error(result.error || "Export failed.");
      else
        setNotice(
          `Config saved (${((result.size ?? 0) / 1024 / 1024).toFixed(1)} MB) to ${result.path}.`,
        );
    } catch (cause) {
      setNotice("");
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  const importConfig = async () => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("Reading config…");
    try {
      const result = await electronAPI.importConfig();
      setNotice("");
      if (result.canceled) return;
      if (!result.ok || !result.manifest)
        throw new Error(result.error || "Import failed.");
      setPendingImport(result.manifest);
    } catch (cause) {
      setNotice("");
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
      setError(
        cause instanceof Error ? cause.message : "Settings could not be saved.",
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
      <aside
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <header>
          <div>
            <FiSettings />
            <h2>Settings</h2>
          </div>
          <button onClick={onClose} title="Close settings">
            <FiX />
          </button>
        </header>

        <section
          className="settings-license-section"
          data-tour="settings-license"
          data-help={
            demoMode.enabled
              ? "Demo testing limits are active while your paid or beta lifetime license remains saved."
              : lifetimeLicense.isLicensed
              ? "Review your paid or beta lifetime license."
              : "Demo limits stay unobtrusive until you choose a feature that is not included."
          }
        >
          <div className="settings-section-title">
            <FiLock />
            <div>
              <h3>
                {demoMode.enabled
                  ? "Demo testing mode enabled"
                  : lifetimeLicense.isLicensed
                  ? lifetimeLicense.licenseType === "beta"
                    ? "Lifetime beta access active"
                    : "Lifetime license verified"
                  : "Demo mode"}
              </h3>
              <p>
                {demoMode.enabled
                  ? "Demo limits are active for testing; your lifetime license is still saved on this installation."
                  : lifetimeLicense.isLicensed
                  ? lifetimeLicense.licenseType === "beta"
                    ? "Your lifetime beta license is active on this installation."
                    : "Your lifetime license is active on this Mac."
                  : "The demo indexes up to 1,000 representative files with real search, face scanning, place mapping and deduplication; demo deletion is limited to 100 files. Full-access options appear only when you click an unavailable feature."}
              </p>
            </div>
          </div>
          {lifetimeLicense.isLicensed && (
            <div className="settings-license-actions">
              <button
                className="settings-save settings-license-button"
                onClick={() => setShowLifetimeUnlock(true)}
                data-help="Review your active lifetime-license details."
              >
                {lifetimeLicense.licenseType === "beta"
                  ? "View beta lifetime access"
                  : "View lifetime license"}
              </button>
              {demoMode.available && (
                <button
                  className="settings-secondary settings-license-button"
                  disabled={demoModeBusy}
                  onClick={() => void toggleDemoTestingMode()}
                  data-help="Restart Silo with demo limits for testing or return to full lifetime access. Your license and demo usage history are preserved."
                >
                  {demoMode.enabled
                    ? "Return to full access"
                    : "Enable demo mode for testing"}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="settings-bug-report">
          <div className="settings-section-title">
            <FaBug />
            <div>
              <h3>Report a Bug</h3>
              <p>Send a note about a problem or confusing feature.</p>
            </div>
          </div>
          <button
            className="settings-secondary"
            onClick={onOpenBugReport}
            data-help="Describe a problem, identify a visible feature, and optionally attach a screenshot of the Silo window."
          >
            <FaBug /> Report a Bug
          </button>
        </section>

        <LibraryShareSettings />

        <section data-tour="content-protection" data-help="Control visibility of explicit images and banned people, Safe Search, and authorization for protected-setting changes.">
          <div className="settings-section-title">
            <FiShield />
            <div>
              <h3>Content protection</h3>
              <p>
                Explicit content is hidden and blocked from search by default.
              </p>
            </div>
          </div>
          <label className="settings-toggle">
            <div>
              <strong>Show NSFW images</strong>
              <span>
                Display files flagged by explicit terms or visual safety
                classification.
              </span>
            </div>
            <input
              type="checkbox"
              checked={settings.showNsfw}
              disabled={busy}
              data-help="Allow images flagged by explicit terms or visual safety classification to appear."
              onChange={(event) =>
                void update({ showNsfw: event.target.checked }, true)
              }
            />
          </label>
          <label className="settings-toggle">
            <div>
              <strong>Safe Search</strong>
              <span>Reject explicit queries and remove flagged results.</span>
            </div>
            <input
              type="checkbox"
              checked={settings.safeSearch}
              disabled={busy}
              data-help="Keep explicit queries and flagged results out of search."
              onChange={(event) =>
                void update({ safeSearch: event.target.checked }, true)
              }
            />
          </label>
          <label className="settings-toggle">
            <div>
              <strong>Show banned people</strong>
              <span>
                Photos containing people you banned in People → Confirmed faces
                stay hidden unless this is on.
              </span>
            </div>
            <input
              type="checkbox"
              checked={settings.showBannedPeople}
              disabled={busy}
              data-help="Allow photos containing people you banned to appear in the library."
              onChange={(event) =>
                void update({ showBannedPeople: event.target.checked })
              }
            />
          </label>
          <label className="settings-password">
            <span>Parental password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={
                settings.parentalPasswordSet
                  ? "Required to change protection"
                  : "Create a password below first"
              }
              autoComplete="current-password"
              data-help="Enter the parental password to authorize protected-content setting changes."
            />
          </label>
        </section>

        <section data-tour="settings-password" data-help="Create or change the parental password used to authorize protected-content setting changes. The password itself is not stored.">
          <div className="settings-section-title">
            <FiLock />
            <div>
              <h3>
                {settings.parentalPasswordSet
                  ? "Change parental password"
                  : "Create parental password"}
              </h3>
              <p>At least 6 characters. The password itself is never stored.</p>
            </div>
          </div>
          {settings.parentalPasswordSet && (
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
              data-help="Confirm the current parental password before replacing it."
            />
          )}
          <div className="settings-password-row">
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="New password"
              autoComplete="new-password"
              data-help="Enter a new parental password of at least six characters. Silo stores only a verifier, not the password itself."
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Confirm password"
              autoComplete="new-password"
              data-help="Re-enter the new password so Silo can check both entries match."
            />
          </div>
          <button
            className="settings-save"
            disabled={busy || !newPassword || !confirmPassword}
            onClick={() => void savePassword()}
            data-help="Save or replace the parental password used to authorize protected-setting changes."
          >
            {settings.parentalPasswordSet
              ? "Change password"
              : "Create password"}
          </button>
        </section>

        <section data-tour="settings-appearance" data-help="Choose the app theme and whether the Map globe rotates automatically when the Map page opens.">
          <div className="settings-section-title">
            <FiSettings />
            <div>
              <h3>Appearance & behavior</h3>
            </div>
          </div>
          <label className="settings-select">
            <span>Theme</span>
            <select
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
          <label className="settings-toggle">
            <div>
              <strong>Automatic globe rotation</strong>
              <span>Resume slow globe movement when Map opens.</span>
            </div>
            <input
              type="checkbox"
              checked={settings.autoplayGlobe}
              data-help="Resume slow globe rotation automatically when you open Map."
              onChange={(event) =>
                void update({ autoplayGlobe: event.target.checked })
              }
            />
          </label>
        </section>

        <section data-tour="settings-memories" data-help="Choose where generated Memory movies and spare story files are saved; this does not move source media.">
          <div className="settings-section-title">
            <FiFolder />
            <div>
              <h3>Memories</h3>
              <p>
                Memory movies and a few spare stories are saved here, so they
                stay watchable when the source drive or phone is disconnected.
              </p>
            </div>
          </div>
          <p className="settings-footnote">
            {memoryDirectory
              ? `Saving to ${memoryDirectory}/Silo Memories`
              : "Saving inside Silo's app storage on this Mac."}
          </p>
          <div className="settings-password-row">
            <button
              className="settings-save"
              disabled={busy}
              onClick={() => void changeMemoryDirectory(false)}
              data-help="Choose where Silo saves generated Memory movies and spare story files."
            >
              <FiFolder /> Choose destination…
            </button>
            {memoryDirectory && (
              <button
                className="settings-secondary"
                disabled={busy}
                onClick={() => void changeMemoryDirectory(true)}
                data-help="Return Memory movie storage to Silo’s app folder on this Mac."
              >
                Use app storage
              </button>
            )}
          </div>
        </section>

        <section
          data-tour="settings-cache-destination"
          data-help="Choose the external drive folder for Silo's indexes, thumbnails, previews, and other large generated caches."
        >
          <div className="settings-section-title">
            <FiHardDrive />
            <div>
              <h3>Silo Cache Destination</h3>
              <p>
                Search indexes, faces, places, thumbnails, previews, and other
                generated caches live here. Settings remain on this Mac.
              </p>
            </div>
          </div>
          <p className="settings-footnote">
            {cacheDestination || "Loading current destination…"}
          </p>
          <div className="settings-password-row settings-cache-destination-actions">
            <button
              className="settings-save"
              disabled={busy}
              onClick={() => void changeCacheDestination()}
              data-help="Choose an external-drive folder. Silo restarts, verifies the cache copies, and then removes the old copies."
            >
              <FiFolder /> Choose cache destination…
            </button>
          </div>
        </section>

        <section data-tour="settings-backup" data-help="Export or review a Silo configuration restore. Restore replaces app setup and restarts Silo, but does not modify source media; protect exported credentials.">
          <div className="settings-section-title">
            <FiDownload />
            <div>
              <h3>Backup & restore</h3>
              <p>
                Save Silo's whole setup to one file: search index, people and
                bans, keywords and names, albums, map locations, magic scores,
                sources, Google connections, sorting, theme, and search history.
                Restore it after reinstalling to skip re-indexing and
                re-confirming.
              </p>
            </div>
          </div>
          {pendingImport ? (
            <div className="settings-import-review">
              <strong>
                Restore config from{" "}
                {new Date(pendingImport.exportedAt).toLocaleString()}?
              </strong>
              <span>
                Made with Silo {pendingImport.appVersion}. Includes{" "}
                {pendingImport.entries.length} data sets. Your current Silo
                setup will be replaced and Silo will restart. Photos and other
                files on disk are not touched.
              </span>
              <div className="settings-password-row">
                <button
                  className="settings-save"
                  disabled={busy}
                  onClick={() => void applyImport()}
                  data-help="Replace the current Silo setup with the reviewed config and restart the app; source files are not changed."
                >
                  Restore & restart
                </button>
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
              </div>
            </div>
          ) : (
            <div className="settings-password-row">
              <button
                className="settings-save"
                disabled={busy}
                onClick={() => void exportConfig()}
                data-help="Export Silo configuration and library knowledge to a private backup file."
              >
                <FiDownload /> Export config
              </button>
              <button
                className="settings-secondary"
                disabled={busy}
                onClick={() => void importConfig()}
                data-help="Choose a previously exported Silo config file and review its contents before restoring."
              >
                <FiUpload /> Import config
              </button>
            </div>
          )}
          <p className="settings-footnote">
            The file contains your Google account sign-in tokens and parental
            password hash. Keep it somewhere private. Thumbnails and previews
            aren't included; they rebuild automatically. Phone backups aren't
            included either.
          </p>
        </section>

        <section
          className="settings-statistics-section"
          data-tour="library-statistics"
          data-help="Open the full dashboard to review source inventory, indexing progress, and verified shelter-copy status. Refresh measurements or start a backup only after checking source selections and destinations."
        >
          <div className="settings-section-title">
            <FiBarChart2 />
            <div>
              <h3>Library statistics</h3>
              <p>Inventory, source coverage, indexing, and backup health.</p>
            </div>
          </div>
          <button
            className="settings-save settings-statistics-button"
            onClick={onOpenStatistics}
            data-help="Open the complete, full-page library statistics dashboard."
          >
            Open statistics dashboard
          </button>
        </section>

        {error && <div className="settings-message error">{error}</div>}
        {notice && <div className="settings-message">{notice}</div>}
      </aside>
    </div>
      {showLifetimeUnlock && (
        <LifetimeUnlockPanel
          license={lifetimeLicense}
          demoTestingModeActive={demoMode.enabled}
          onClose={() => setShowLifetimeUnlock(false)}
          onOpenBugReport={onOpenBugReport}
          onVerified={setLifetimeLicense}
        />
      )}
    </>
  );
}
