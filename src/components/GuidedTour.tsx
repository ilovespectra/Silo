import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiArrowLeft, FiArrowRight, FiX } from "react-icons/fi";
import "./GuidedTour.css";

export type GuidedTourSection =
  | "files"
  | "people"
  | "map"
  | "duplicates"
  | "mobile"
  | "memories"
  | "settings"
  | "stats";

export interface GuidedTourStep {
  id: string;
  title: string;
  body: string;
  target: string;
  fallbackTarget?: string;
  section: GuidedTourSection;
}

export const GUIDED_TOUR_STEPS: GuidedTourStep[] = [
  {
    id: "sections",
    title: "Find your way around Silo",
    body: "These tabs open Memories for story videos, Files for sources and search, People for face clusters, Map for geotagged photos, Duplicates for review, and Mobile for device copies and messages. Settings covers membership access, trusted-network sharing, content protection, storage destinations, appearance, configuration backup, and Library Statistics. Help searches this built-in guide and lets you replay the tour.",
    target: '[data-tour="app-tabs"]',
    section: "files",
  },
  {
    id: "sources",
    title: "Add a source",
    body: "In Files, use the plus beside Sources to choose a folder. Silo adds it to the library and starts indexing automatically.",
    target: '[data-tour="sources-add"]',
    section: "files",
  },
  {
    id: "source-controls",
    title: "Manage source availability",
    body: "Use Select all or Select none to change the library scope, the check control on a source to include or exclude it, and its arrow to browse it. Refresh updates source availability.",
    target: '[data-tour="source-controls"]',
    fallbackTarget: '[data-tour="sources-add"]',
    section: "files",
  },
  {
    id: "source-clone",
    title: "Clone sources safely",
    body: "This copy control clones all enabled sources. Choose destination folders and scan first to review the unique-file count and required space; then acknowledge the separate copy and choose Clone & verify. Silo verifies each unique file by SHA-256 and leaves the originals unchanged.",
    target: '[data-tour="source-clone"]',
    fallbackTarget: '[data-tour="source-controls"]',
    section: "files",
  },
  {
    id: "google-sources",
    title: "Connect another source type",
    body: "The Files sidebar also has Google Accounts; use its account controls to connect or browse a Drive source.",
    target: '[data-tour="google-sources"]',
    fallbackTarget: '[data-tour="sources-add"]',
    section: "files",
  },
  {
    id: "indexing",
    title: "Watch indexing",
    body: "Progress appears here as Silo discovers and prepares files. It continues in the background, so you can browse while it works.",
    target: '[data-tour="indexing-progress"]',
    section: "files",
  },
  {
    id: "search",
    title: "Search by meaning",
    body: "Describe what you remember, such as “family sailing at sunset”, or “rainy day at the park.“ Semantic search uses the library’s local index; results improve as indexing completes.",
    target: '[data-tour="semantic-search"]',
    section: "files",
  },
  {
    id: "digital-folders",
    title: "Build digital folders",
    body: "Use this plus to create a virtual collection. Add files to organize references without moving or modifying their originals. Rename or reorder these collections independently of source folders.",
    target: '[data-tour="digital-folders"]',
    section: "files",
  },
  {
    id: "file-actions",
    title: "Manage files carefully",
    body: "Grid is the default thumbnail view; choose List for detailed rows. Sort & Filter opens file-type, year, people, and location filters plus sort order, and works in either view. Select a file to enable its actions. Move changes the file’s real location; New folder creates a real folder. Set virtual name changes Silo’s display/search label, not the filename on disk.",
    target: '[data-tour="file-actions"]',
    section: "files",
  },
  {
    id: "face-indexing",
    title: "Find people on this device",
    body: "Face detection is a separate offline index. Start or pause it here when you choose. Silo groups detected faces so you can review them in People.",
    target: '[data-tour="face-indexing"]',
    section: "people",
  },
  {
    id: "people-create-edit",
    title: "Add and edit people",
    body: "Create a named person here, then open a cluster to review it and use Rename. Confirming or correcting face matches helps keep the people view accurate.",
    target: '[data-tour="new-person"]',
    fallbackTarget: '[data-tour="people-index"]',
    section: "people",
  },
  {
    id: "people-move-merge",
    title: "Move or merge face clusters",
    body: "Open a person to see profile actions. On an individual photo, right-click or Shift-click to manage its detected faces and move an assignment. “Merge into…” combines the whole person; it asks for confirmation and can be undone with ⌘Z.",
    target: '[data-tour="person-actions"]',
    fallbackTarget: '[data-tour="people-index"]',
    section: "people",
  },
  {
    id: "people-review-tabs",
    title: "Review confirmed and banned people",
    body: "All people shows the working clusters; Confirmed faces collects reviewed profiles. Banned people are hidden across Silo unless Settings allows them, and Show faces only reveals their identities in this section. These display controls do not delete files.",
    target: '[data-tour="people-status-tabs"]',
    fallbackTarget: '[data-tour="people-page"]',
    section: "people",
  },
  {
    id: "map",
    title: "Explore the photo map",
    body: "The Map view groups geotagged photos by location. Open a region to browse its photos and select the ones you want to update. The map and its counts do not change your files.",
    target: '[data-tour="map-overview"]',
    section: "map",
  },
  {
    id: "map-selection-tools",
    title: "Select places on the globe",
    body: "Choose rectangle or circle, then select individual place bubbles or whole countries/regions. Shift-drag or Shift-click adds to a selection; Option subtracts. Selection alone changes no photo metadata.",
    target: '[data-tour="map-selection-tools"]',
    fallbackTarget: '[data-tour="map-overview"]',
    section: "map",
  },
  {
    id: "map-globe-tools",
    title: "Orient the globe",
    body: "Pause or resume automatic rotation, or use the compass to reset the view north-up. These controls affect the map presentation only; they do not edit photo locations.",
    target: '[data-tour="map-globe-controls"]',
    fallbackTarget: '[data-tour="map-overview"]',
    section: "map",
  },
  {
    id: "map-solar-tools",
    title: "Adjust globe lighting",
    body: "Drag the solar-time control to view daylight at another local time, or choose Day here/Night here to align the light with the current view. This changes the map display only.",
    target: '[data-tour="map-solar-controls"]',
    fallbackTarget: '[data-tour="map-overview"]',
    section: "map",
  },
  {
    id: "map-relocate",
    title: "Relocate selected photos",
    body: "After opening a map region and selecting photos, Relocate lets you search for a place or use the embedded location. Review your selection and the chosen place before applying.",
    target: '[data-tour="map-relocate"]',
    fallbackTarget: '[data-tour="map-overview"]',
    section: "map",
  },
  {
    id: "duplicates",
    title: "Review exact duplicates",
    body: "Scan compares file contents source-independently, protects the first retained copy, and lets you stage removable duplicates in Review removed. This allows duplicate files across different sources, while deduplicating identical files in a single source. Check the paths and Review removed before any permanent deletion.",
    target: '[data-tour="duplicates-overview"]',
    section: "duplicates",
  },
  {
    id: "duplicate-controls",
    title: "Select and review duplicates",
    body: "Switch between duplicate groups and Review removed. Select all, compare paths, and stage chosen copies in the recoverable review area; the retained first copy is protected. Grid/list and zoom controls only change presentation.",
    target: '[data-tour="duplicates-actions"]',
    fallbackTarget: '[data-tour="duplicates-tabs"]',
    section: "duplicates",
  },
  {
    id: "duplicate-groups",
    title: "Inspect duplicate groups",
    body: "Each group lists matching files and their paths. The protected first copy is retained; select only the extra copies you intend to stage in Review removed. Scanning and selection do not delete anything.",
    target: '[data-tour="duplicate-groups"]',
    fallbackTarget: '[data-tour="duplicates-actions"]',
    section: "duplicates",
  },
  {
    id: "duplicate-recovery",
    title: "Restore or delete reviewed copies",
    body: "Review removed contains copies held for recovery. Select items and Restore to return them. Delete selected permanently and Clear all permanently cannot be undone, so confirm the paths and selection before using either control.",
    target: '[data-tour="duplicate-trash-actions"]',
    fallbackTarget: '[data-tour="duplicates-review-tab"]',
    section: "duplicates",
  },
  {
    id: "mobile",
    title: "Manage phones and tablets",
    body: "The Mobile page puts device discovery, browsing, naming, and backup controls first. Check the selected device, backup destination, and status before starting an operation.",
    target: '[data-tour="mobile-devices"]',
    fallbackTarget: '[data-tour="mobile-overview"]',
    section: "mobile",
  },
  {
    id: "mobile-device-actions",
    title: "Connect and browse a device",
    body: "For a ready phone or tablet, Rename changes its label, Browse opens its accessible files, and Connect or unmount manages the live connection. Browsing a saved snapshot does not reconnect to or alter the device.",
    target: '[data-tour="mobile-device-actions"]',
    fallbackTarget: '[data-tour="mobile-devices"]',
    section: "mobile",
  },
  {
    id: "mobile-messages",
    title: "Browse and export messages",
    body: "Choose a connected phone or saved history, load it, then review the output destination and format before exporting. Updating history requires a connected, trusted phone.",
    target: '[data-tour="mobile-messages"]',
    fallbackTarget: '[data-tour="mobile-overview"]',
    section: "mobile",
  },
  {
    id: "mobile-backups",
    title: "Know what each phone backup contains",
    body: "Browseable snapshots keep dated copies of files exposed over USB. iPhone and iPad can also create encrypted, timestamped Apple restore archives; Android copies cover accessible shared files, not app data or device settings. Review the on-screen scope before creating or restoring a backup.",
    target: '[data-tour="mobile-backup-settings"]',
    fallbackTarget: '[data-tour="mobile-devices"]',
    section: "mobile",
  },
  {
    id: "memories",
    title: "Make a Memory",
    body: "Memories suggests stories from indexed photos and clips. Generate only when you choose; review the story, soundtrack, duration, and export location. Edit video settings or make your own using semantic keywords, fully offline. Removing a suggestion keeps the original files.",
    target: '[data-tour="memories-overview"]',
    section: "memories",
  },
  {
    id: "memory-topic",
    title: "Create a Memory from a topic",
    body: "Enter a phrase of at least three characters, such as “Rainy Sundays,” to search indexed photos on this device for a story on that topic. Silo creates one when matching material is available and selects a local soundtrack; it doesn’t modify your original media.",
    target: '[data-tour="memory-topic"]',
    section: "memories",
  },
  {
    id: "memory-controls",
    title: "Review a story before exporting",
    body: "Each card can preview a prepared movie, remove only its suggestion, or open story controls for photo count, duration, soundtrack, and original-audio level. Make a movie opens the export flow; check the destination before saving.",
    target: '[data-tour="memory-controls"]',
    fallbackTarget: '[data-tour="memories-overview"]',
    section: "memories",
  },
  {
    id: "settings-license",
    title: "Review the membership license",
    body: "Silo offers a $25 USDC one-time lifetime membership, not a recurring subscription. It removes source, file, digital-folder, Memory-preview, and mapped-location limits for 2 machines at a time, you can add/remove these in the settings menu.",
    target: '[data-tour="settings-license"]',
    section: "settings",
  },
  {
    id: "settings-library-share",
    title: "Share selected libraries on Wi-Fi",
    body: "Choose indexed local libraries and select Start sharing to create a private-network link. Anyone with that link on the same network can browse, search, preview, and download included photos and videos. The link uses unencrypted local HTTP, so use trusted Wi-Fi only; stop sharing or quit Silo to end access.",
    target: '[data-tour="library-share"]',
    section: "settings",
  },
  {
    id: "protection",
    title: "Review content protection",
    body: "Settings controls whether explicit images appear, how banned people are shown, and parental-password protection. Password creation is required for some settings modifications.",
    target: '[data-tour="content-protection"]',
    section: "settings",
  },
  {
    id: "settings-password",
    title: "Set a parental password",
    body: "This section creates or changes the parental password used to authorize protected content-setting changes.",
    target: '[data-tour="settings-password"]',
    section: "settings",
  },
  {
    id: "settings-appearance",
    title: "Set appearance and behavior",
    body: "Choose the theme here and decide whether the globe rotates automatically when Map opens. Changes take effect only when you use these controls.",
    target: '[data-tour="settings-appearance"]',
    section: "settings",
  },
  {
    id: "settings-memories",
    title: "Choose where Memories are saved",
    body: "Set a destination for generated Memory movies, or use Silo’s app storage. This does not move your source photos or clips.",
    target: '[data-tour="settings-memories"]',
    section: "settings",
  },
  {
    id: "settings-cache-destination",
    title: "Choose Silo’s cache destination",
    body: "This shows where Silo stores indexes, face and place data, thumbnails, previews, and other generated cache files. Choose cache destination opens a folder picker; Silo restarts, verifies the cache copy, then removes the old cache. It does not move your original source files or Mac settings. Keep the destination drive connected.",
    target: '[data-tour="settings-cache-destination"]',
    section: "settings",
  },
  {
    id: "settings-backup",
    title: "Back up or restore Silo settings",
    body: "Export saves Silo’s configuration and library knowledge to a file. Import first shows a review; applying it replaces the current setup and restarts Silo. Photos and other source files are not changed, and phone backups are not included.",
    target: '[data-tour="settings-backup"]',
    section: "settings",
  },
  {
    id: "statistics",
    title: "Check library statistics",
    body: "Open Settings and choose Open statistics dashboard to explore the full Library Statistics page. It summarizes inventory, source coverage, indexing, and backup health so you can confirm what Silo can currently see and which work is still in progress.",
    target: '[data-tour="library-statistics"]',
    section: "settings",
  },
  {
    id: "fallout-shelter",
    title: "Set up Fallout Shelter",
    body: "Fallout Shelter tracks verified copies of your sources. Set a primary destination, then select available sources in Source map and choose Back up selected. A copy counts as verified only after SHA-256 checks; Silo compares source path, size, and modification-time signatures to flag changes.",
    target: '[data-tour="fallout-shelter"]',
    section: "stats",
  },
  {
    id: "fallout-shelter-replica",
    title: "Replicate the verified shelter",
    body: "After a complete primary shelter exists, use Replicate shelter to another volume to prepare a verified copy on a different physical volume. Review the destination and space preflight before copying; Silo verifies the replica by SHA-256. Replication is optional.",
    target: '[data-tour="shelter-replica"]',
    fallbackTarget: '[data-tour="fallout-shelter"]',
    section: "stats",
  },
];

interface GuidedTourProps {
  open: boolean;
  showAtStartup: boolean;
  contextStep?: GuidedTourStep | null;
  onShowAtStartupChange: (show: boolean) => void;
  onNavigate: (section: GuidedTourSection, step: GuidedTourStep) => void;
  onClose: () => void;
}

interface SpotlightRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export default function GuidedTour({
  open,
  showAtStartup,
  contextStep = null,
  onShowAtStartupChange,
  onNavigate,
  onClose,
}: GuidedTourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null);
  const [targetRect, setTargetRect] = useState<SpotlightRect | null>(null);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const dialogRef = useRef<HTMLElement | null>(null);
  const steps = contextStep ? [contextStep] : GUIDED_TOUR_STEPS;
  const activeStepIndex = contextStep ? 0 : stepIndex;
  const step = steps[activeStepIndex];
  const bubblePosition = useMemo(() => {
    const bubbleWidth = Math.min(380, viewport.width - 32);
    const bubbleHeight = 330;
    if (!targetRect) {
      return {
        left: Math.max(16, (viewport.width - bubbleWidth) / 2),
        top: Math.max(16, (viewport.height - bubbleHeight) / 2),
      };
    }
    const gap = 18;
    const right = targetRect.right + gap;
    const left = targetRect.left - bubbleWidth - gap;
    const nextLeft =
      right + bubbleWidth <= viewport.width - 16
        ? right
        : left >= 16
          ? left
          : Math.max(16, (viewport.width - bubbleWidth) / 2);
    return {
      left: nextLeft,
      top: Math.min(
        Math.max(16, targetRect.top),
        Math.max(16, viewport.height - bubbleHeight - 16),
      ),
    };
  }, [targetRect, viewport]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (open && !contextStep) setStepIndex(0);
  }, [contextStep, open]);

  useEffect(() => {
    if (!open) return;
    onNavigate(step.section, step);
    setTargetElement(null);
    setTargetRect(null);
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const findTarget = () => {
      if (cancelled) return;
      const found =
        (document.querySelector(step.target) as HTMLElement | null) ??
        (step.fallbackTarget
          ? (document.querySelector(step.fallbackTarget) as HTMLElement | null)
          : null);
      if (found) {
        found.scrollIntoView({ block: "nearest", inline: "nearest" });
        timer = window.setTimeout(() => {
          if (!cancelled) setTargetElement(found);
        }, 160);
        return;
      }
      attempts += 1;
      if (attempts < 18) timer = window.setTimeout(findTarget, 100);
    };
    timer = window.setTimeout(findTarget, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onNavigate, open, step]);

  useEffect(() => {
    if (!open || !targetElement) return;
    const measure = () => {
      if (!targetElement.isConnected) {
        setTargetRect(null);
        return;
      }
      const rect = targetElement.getBoundingClientRect();
      const margin = 6;
      const left = Math.max(0, rect.left - margin);
      const top = Math.max(0, rect.top - margin);
      const right = Math.min(window.innerWidth, rect.right + margin);
      const bottom = Math.min(window.innerHeight, rect.bottom + margin);
      setTargetRect({
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      });
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const observer = new ResizeObserver(measure);
    observer.observe(targetElement);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer.disconnect();
    };
  }, [open, targetElement]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)",
    );
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const advance = () => {
    if (contextStep || activeStepIndex === steps.length - 1) onClose();
    else setStepIndex((current) => current + 1);
  };

  return createPortal(
    <div className="guided-tour-layer">
      <div className={`guided-tour-scrim ${targetRect ? "has-target" : ""}`} />
      {targetRect && (
        <div
          className="guided-tour-spotlight"
          aria-hidden="true"
          style={{
            top: targetRect.top,
            left: targetRect.left,
            width: targetRect.width,
            height: targetRect.height,
          }}
        >
          <span className="guided-tour-pointer" aria-hidden="true">
            ↓
          </span>
        </div>
      )}
      <section
        className="guided-tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-tour-title"
        aria-describedby="guided-tour-description"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
        style={{ left: bubblePosition.left, top: bubblePosition.top }}
      >
        <header className="guided-tour-header">
          <span>
            {contextStep
              ? "Control explained"
              : `Step ${activeStepIndex + 1} of ${steps.length}`}
          </span>
          <button
            type="button"
            className="guided-tour-close"
            onClick={onClose}
            aria-label="Close guided tour"
            title="Close tour"
          >
            <FiX />
          </button>
        </header>
        <h2 id="guided-tour-title">{step.title}</h2>
        <p id="guided-tour-description">{step.body}</p>
        {!targetElement && (
          <p className="guided-tour-context-note">
            This control may appear after you select an item. Continue the guide
            to learn where to find it.
          </p>
        )}
        <label className="guided-tour-startup-option">
          <input
            type="checkbox"
            checked={showAtStartup}
            onChange={(event) =>
              onShowAtStartupChange(event.currentTarget.checked)
            }
          />
          Show this tour at startup
        </label>
        <footer className="guided-tour-footer">
          <button type="button" className="guided-tour-skip" onClick={onClose}>
            Not now
          </button>
          <div>
            {!contextStep && (
              <button
                type="button"
                className="guided-tour-back"
                onClick={() =>
                  setStepIndex((current) => Math.max(0, current - 1))
                }
                disabled={activeStepIndex === 0}
              >
                <FiArrowLeft /> Back
              </button>
            )}
            <button
              type="button"
              className="guided-tour-next"
              onClick={advance}
            >
              {contextStep ? (
                "Done"
              ) : activeStepIndex === steps.length - 1 ? (
                "Finish"
              ) : (
                <>
                  Next <FiArrowRight />
                </>
              )}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
