import React, { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { FiCopy, FiShare2, FiStopCircle } from "react-icons/fi";
import type { LibraryShareSelection } from "../libraryShareServer";
import "../styles/LibraryShareSettings.css";

type ShareStatus = {
  active: boolean;
  url?: string;
  sources: Array<{ id: string; label: string }>;
};

export default function LibraryShareSettings() {
  const electronAPI = window.electron;
  const [sources, setSources] = useState<BrowseSource[]>([]);
  const [folders, setFolders] = useState<DigitalFolder[]>([]);
  const [selections, setSelections] = useState<LibraryShareSelection[]>([]);
  const [share, setShare] = useState<ShareStatus>({ active: false, sources: [] });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let disposed = false;
    if (!electronAPI) {
      setBusy(false);
      return;
    }
    void Promise.all([electronAPI.listSources(), electronAPI.getAppState(), electronAPI.getLibraryShareStatus()])
      .then(([availableSources, appState, currentShare]) => {
        if (disposed) return;
        setSources(availableSources);
        setFolders(appState.digitalFolders ?? []);
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

  const isSelected = (selection: LibraryShareSelection) =>
    selections.some((item) => item.type === selection.type && item.id === selection.id);

  const toggleSelection = (selection: LibraryShareSelection) => {
    setSelections((current) =>
      current.some((item) => item.type === selection.type && item.id === selection.id)
        ? current.filter((item) => item.type !== selection.type || item.id !== selection.id)
        : [...current, selection],
    );
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
          <p className="library-share-description">Choose a local library or a virtual folder. Folder shares include only that folder’s current members. Only indexed photos and videos are included.</p>
          {busy ? <p className="library-share-muted">Loading libraries and virtual folders…</p> : null}
          {!busy && availableSources.length === 0 && availableFolders.length === 0 ? (
            <p className="library-share-muted">Add a local library or create a virtual folder with local photos or videos before sharing.</p>
          ) : (
            <div className="library-share-sources">
              {availableSources.map((source) => {
                const selection = { type: "source", id: source.id } as const;
                return <label className="library-share-source" key={`source:${source.id}`}>
                  <input type="checkbox" checked={isSelected(selection)} disabled={busy} onChange={() => toggleSelection(selection)} />
                  <span><strong>{source.label}</strong><small>{source.detail}</small></span>
                </label>;
              })}
              {availableFolders.map((folder) => {
                const selection = { type: "folder", id: folder.id } as const;
                return <label className="library-share-source" key={`folder:${folder.id}`}>
                  <input type="checkbox" checked={isSelected(selection)} disabled={busy} onChange={() => toggleSelection(selection)} />
                  <span><strong>{folder.name}</strong><small>Virtual folder · {folder.filePaths.length.toLocaleString()} members</small></span>
                </label>;
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
