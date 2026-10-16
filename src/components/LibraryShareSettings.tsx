import React, { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { FiChevronDown, FiCopy, FiFolder, FiHardDrive, FiShare2, FiStopCircle, FiUser, FiX } from "react-icons/fi";
import type { LibraryShareSelection } from "../libraryShareServer";
import "../styles/LibraryShareSettings.css";

type ShareTargetType = LibraryShareSelection["type"];

type ShareTargetOption = {
  selection: LibraryShareSelection;
  label: string;
  detail: string;
  icon: React.ReactNode;
};

type ShareStatus = {
  active: boolean;
  url?: string;
  sources: Array<{ id: string; label: string }>;
};

export default function LibraryShareSettings() {
  const electronAPI = window.electron;
  const [sources, setSources] = useState<BrowseSource[]>([]);
  const [folders, setFolders] = useState<DigitalFolder[]>([]);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [selections, setSelections] = useState<LibraryShareSelection[]>([]);
  const [share, setShare] = useState<ShareStatus>({ active: false, sources: [] });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<ShareTargetType, boolean>>({
    person: true,
    folder: false,
    source: false,
  });

  useEffect(() => {
    let disposed = false;
    if (!electronAPI) {
      setBusy(false);
      return;
    }
    void Promise.all([
      electronAPI.listSources(),
      electronAPI.getAppState(),
      electronAPI.getLibraryShareStatus(),
      electronAPI.getFaceState(),
    ])
      .then(([availableSources, appState, currentShare, faceState]) => {
        if (disposed) return;
        setSources(availableSources);
        setFolders(appState.digitalFolders ?? []);
        setPeople(faceState.people ?? []);
        setShare(currentShare);
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Sharing settings could not be loaded.");
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [electronAPI]);

  const availableSources = sources.filter(
    (source) => source.kind === "local" && source.available,
  );
  const availableFolders = folders.filter((folder) => !folder.hidden && folder.filePaths.length > 0);
  const availablePeople = people
    .filter((person) => person.photoCount > 0 && person.nameSource === "user")
    .sort((first, second) => first.name.localeCompare(second.name));

  const selectionGroups: Array<{
    type: ShareTargetType;
    title: string;
    options: ShareTargetOption[];
  }> = [
    {
      type: "person",
      title: "People",
      options: availablePeople.map((person) => ({
        selection: { type: "person", id: person.id },
        label: person.name,
        detail: `Person · ${person.photoCount.toLocaleString()} photos`,
        icon: <FiUser aria-hidden="true" />,
      })),
    },
    {
      type: "folder",
      title: "Folders",
      options: availableFolders.map((folder) => ({
        selection: { type: "folder", id: folder.id },
        label: folder.name,
        detail: `Virtual folder · ${folder.filePaths.length.toLocaleString()} members`,
        icon: <FiFolder aria-hidden="true" />,
      })),
    },
    {
      type: "source",
      title: "Sources",
      options: availableSources.map((source) => ({
        selection: { type: "source", id: source.id },
        label: source.label,
        detail: source.detail,
        icon: <FiHardDrive aria-hidden="true" />,
      })),
    },
  ];

  const isSelected = (selection: LibraryShareSelection) =>
    selections.some((item) => item.type === selection.type && item.id === selection.id);

  const toggleSelection = (selection: LibraryShareSelection) => {
    setSelections((current) =>
      current.some((item) => item.type === selection.type && item.id === selection.id)
        ? current.filter((item) => item.type !== selection.type || item.id !== selection.id)
        : [...current, selection],
    );
  };

  const toggleAllInGroup = (type: ShareTargetType, options: ShareTargetOption[]) => {
    const allSelected = options.length > 0 && options.every((option) => isSelected(option.selection));
    setSelections((current) => {
      if (allSelected)
        return current.filter((selection) => selection.type !== type);
      const selectedKeys = new Set(
        current.filter((selection) => selection.type === type).map((selection) => selection.id),
      );
      return [
        ...current,
        ...options
          .filter((option) => !selectedKeys.has(option.selection.id))
          .map((option) => option.selection),
      ];
    });
  };

  const startSharing = async () => {
    if (!electronAPI || selections.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setShare(await electronAPI.startLibraryShare(selections));
      setNotice("Sharing is ready on your local network.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Silo could not start sharing.");
    } finally {
      setBusy(false);
    }
  };

  const stopSharing = async () => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setShare(await electronAPI.stopLibraryShare());
      setSelections([]);
      setNotice("The share link has been revoked.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Silo could not stop sharing.");
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!share.url) return;
    setError("");
    try {
      await navigator.clipboard.writeText(share.url);
      setNotice("Link copied. Send it to someone on your trusted Wi-Fi.");
    } catch {
      const field = document.querySelector<HTMLInputElement>(".library-share-url");
      field?.focus();
      field?.select();
      document.execCommand("copy");
      setNotice("Link selected. Copy it and send it to someone on your trusted Wi-Fi.");
    }
  };

  return (
    <section className="library-share-section settings-card settings-card-padded" data-tour="library-share">
      {share.active && share.url ? (
        <>
          <label className="library-share-link-label" htmlFor="library-share-url">Private share link</label>
          <div className="library-share-link-row">
            <input id="library-share-url" className="library-share-url" value={share.url} readOnly />
            <button type="button" className="settings-save library-share-copy" onClick={() => void copyUrl()}>
              <FiCopy /> Copy
            </button>
          </div>
          <div className="library-share-pairing">
            <div className="library-share-qr">
              <QRCodeSVG
                value={share.url}
                size={148}
                level="M"
                includeMargin
                bgColor="transparent"
                fgColor="var(--text, #f4f1ed)"
                title="QR code for the Silo share link"
              />
            </div>
            <div className="library-share-pairing-copy">
              <strong>Scan to open on a phone</strong>
              <span>Connect to the same trusted Wi-Fi, then scan with the phone camera.</span>
            </div>
          </div>
          <p className="library-share-copy-note">
            Shared: {share.sources.map((source) => source.label).join(", ")}
          </p>
          <ol className="library-share-instructions">
            <li>Connect the phone or tablet to the same trusted Wi-Fi as this Mac.</li>
            <li>Open the link in its browser to browse, search, preview, and save photos or videos.</li>
            <li>Keep Silo open while sharing. Choose Stop sharing to revoke the link.</li>
          </ol>
          <p className="library-share-warning">Anyone with this link on the local network can view and download these libraries. This local HTTP link is not encrypted, so use trusted private Wi-Fi only. It is not an internet link.</p>
          <button type="button" className="settings-secondary library-share-stop" disabled={busy} onClick={() => void stopSharing()}>
            <FiStopCircle /> Stop sharing
          </button>
        </>
      ) : (
        <>
          <p className="library-share-description">Choose a local library, virtual folder, or named person. Folder and People shares include only their current members. Only indexed photos and videos are included.</p>
          {busy ? <p className="library-share-muted">Loading libraries, virtual folders, and People…</p> : null}
          {!busy && selectionGroups.every((group) => group.options.length === 0) ? (
            <p className="library-share-muted">Add a local library, create a virtual folder, or identify a person with local photos or videos before sharing.</p>
          ) : (
            <div className="library-share-groups">
              {selectionGroups.map((group) => {
                const selectedOptions = group.options.filter((option) => isSelected(option.selection));
                const allSelected = group.options.length > 0 && selectedOptions.length === group.options.length;
                const expanded = expandedGroups[group.type];
                const listId = `library-share-${group.type}-options`;
                return <section className="library-share-group" key={group.type}>
                  <div className="library-share-group-heading">
                    <button
                      type="button"
                      className="library-share-group-toggle"
                      aria-expanded={expanded}
                      aria-controls={listId}
                      onClick={() => setExpandedGroups((current) => ({ ...current, [group.type]: !current[group.type] }))}
                    >
                      <FiChevronDown aria-hidden="true" className={expanded ? "is-expanded" : ""} />
                      <strong>{group.title}</strong>
                      <span>{selectedOptions.length} selected · {group.options.length} available</span>
                    </button>
                    <button
                      type="button"
                      className="library-share-select-all"
                      disabled={busy || group.options.length === 0}
                      onClick={() => toggleAllInGroup(group.type, group.options)}
                    >
                      {allSelected ? "Clear all" : "Select all"}
                    </button>
                  </div>
                  {selectedOptions.length > 0 && <div className="library-share-selected" aria-label={`Selected ${group.title.toLowerCase()}`}>
                    {selectedOptions.map((option) => <button
                      type="button"
                      className="library-share-selected-chip"
                      key={`${option.selection.type}:${option.selection.id}`}
                      title={`Remove ${option.label}`}
                      aria-label={`Remove ${option.label} from sharing`}
                      disabled={busy}
                      onClick={() => toggleSelection(option.selection)}
                    >
                      {option.icon}
                      <span>{option.label}</span><FiX aria-hidden="true" />
                    </button>)}
                  </div>}
                  <div id={listId} className="library-share-options" role="group" aria-label={`${group.title} available to share`} hidden={!expanded}>
                    {group.options.map((option) => <label className="library-share-source" key={`${option.selection.type}:${option.selection.id}`}>
                      <input type="checkbox" checked={isSelected(option.selection)} disabled={busy} onChange={() => toggleSelection(option.selection)} />
                      <span><strong className="library-share-target-name">{option.icon}{option.label}</strong><small>{option.detail}</small></span>
                    </label>)}
                  </div>
                </section>;
              })}
            </div>
          )}
          <button type="button" className="settings-save library-share-start" disabled={busy || selections.length === 0} onClick={() => void startSharing()}>
            <FiShare2 /> Start sharing
          </button>
          <p className="library-share-warning">Use trusted private Wi-Fi only: the local HTTP link is not encrypted. Anyone with the link on that network can browse and download until you stop sharing or quit Silo.</p>
        </>
      )}

      {error ? <p className="library-share-message error">{error}</p> : null}
      {notice ? <p className="library-share-message">{notice}</p> : null}
    </section>
  );
}
