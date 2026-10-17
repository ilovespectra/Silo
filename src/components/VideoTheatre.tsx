import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  FiExternalLink,
  FiHeart,
  FiList,
  FiPlay,
  FiPlus,
  FiTag,
  FiTrash2,
  FiUsers,
  FiMapPin,
} from "react-icons/fi";

type VideoMetadataField = "keywords" | "people" | "places";

interface VideoTheatreProps {
  electronAPI: NonNullable<Window["electron"]>;
  visible: boolean;
  files: FileInfo[];
  playlists: MediaPlaylist[];
  favoritePaths: Set<string>;
  fileMetadata: Record<string, FileMetadata>;
  onToggleFavorite: (filePath: string) => void;
  onCreatePlaylist: (name: string, kind: "video") => Promise<string | null>;
  onAddToPlaylist: (playlistId: string, filePath: string) => Promise<void>;
  onRemoveFromPlaylist: (playlistId: string, filePath: string) => Promise<void>;
  onDeletePlaylist: (playlistId: string) => Promise<void>;
  onEditMetadata: (filePath: string, field: VideoMetadataField) => void;
}

export default function VideoTheatre({
  electronAPI,
  visible,
  files,
  playlists,
  favoritePaths,
  fileMetadata,
  onToggleFavorite,
  onCreatePlaylist,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onDeletePlaylist,
  onEditMetadata,
}: VideoTheatreProps) {
  const [playlistId, setPlaylistId] = useState("all");
  const [targetPlaylistId, setTargetPlaylistId] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoPlaylists = playlists.filter((playlist) => playlist.kind === "video");
  const targetPlaylist = videoPlaylists.find((playlist) => playlist.id === targetPlaylistId);
  const queue = useMemo(() => {
    const permitted = new Set(files.map((file) => file.path));
    if (playlistId === "all") return files;
    const selected = videoPlaylists.find((playlist) => playlist.id === playlistId);
    return (selected?.filePaths ?? [])
      .filter((filePath) => permitted.has(filePath))
      .map((filePath) => files.find((file) => file.path === filePath)!)
      .filter(Boolean);
  }, [files, playlistId, videoPlaylists]);
  const activeFile = queue.find((file) => file.path === activePath) ?? queue[0] ?? null;
  const selectedPlaylist = videoPlaylists.find((playlist) => playlist.id === playlistId);

  useEffect(() => {
    if (activeFile?.path !== activePath) setActivePath(activeFile?.path ?? null);
  }, [activeFile?.path, activePath]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewPath(null);
    setError("");
    if (!visible) {
      videoRef.current?.pause();
      setBusy(false);
      return () => { cancelled = true; };
    }
    if (!activeFile) return;
    setBusy(true);
    void electronAPI.getFilePreview(activeFile.path)
      .then((result) => {
        if (cancelled) return;
        if (!result?.mediaUrl) {
          setError("This video has no playable media stream.");
          return;
        }
        setPreview(result);
        setPreviewPath(activeFile.path);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not open this video.");
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [activeFile?.path, electronAPI, visible]);

  const chooseFile = (file: FileInfo) => setActivePath(file.path);
  const nextFile = () => {
    if (!activeFile || queue.length < 2) return;
    const index = queue.findIndex((file) => file.path === activeFile.path);
    setActivePath(queue[(index + 1) % queue.length].path);
  };
  const createPlaylist = async () => {
    const name = playlistName.trim();
    if (!name || playlistBusy) return;
    setPlaylistBusy(true);
    try {
      const id = await onCreatePlaylist(name, "video");
      setPlaylistName("");
      if (id) setTargetPlaylistId(id);
    } finally {
      setPlaylistBusy(false);
    }
  };
  const popOut = async () => {
    if (!activeFile) return;
    const player = videoRef.current;
    try {
      const result = await electronAPI.openMediaPopout(activeFile.path, player?.currentTime ?? 0);
      if (result.ok) player?.pause();
      else setError(result.error ?? "Could not open the pop-out player.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the pop-out player.");
    }
  };
  const metadata = activeFile ? fileMetadata[activeFile.path] : undefined;

  return (
    <section className="video-theatre" aria-label="Movie Theatre">
      <header className="video-theatre-header">
        <div>
          <span className="video-theatre-kicker">SILO · MOVIE THEATRE</span>
          <h2>Movie Theatre</h2>
          <p>{queue.length.toLocaleString()} video{queue.length === 1 ? "" : "s"} in this view{selectedPlaylist ? ` · ${selectedPlaylist.name}` : ""}</p>
        </div>
        <div className="video-theatre-playlists">
          <label>
            <FiList />
            <select aria-label="Video playlist" value={playlistId} onChange={(event) => {
              const next = event.target.value;
              setPlaylistId(next);
              if (next !== "all") setTargetPlaylistId(next);
            }}>
              <option value="all">All filtered videos</option>
              {videoPlaylists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name} · {playlist.filePaths.length}</option>)}
            </select>
          </label>
          {selectedPlaylist && <button type="button" title="Delete this playlist" aria-label="Delete this playlist" onClick={() => { void onDeletePlaylist(selectedPlaylist.id); setPlaylistId("all"); }}><FiTrash2 /></button>}
          <label className="video-theatre-target-playlist">
            <span>Add to</span>
            <select aria-label="Add videos to playlist" value={targetPlaylistId} onChange={(event) => setTargetPlaylistId(event.target.value)}>
              <option value="">Choose playlist</option>
              {videoPlaylists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
            </select>
          </label>
          <input value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} placeholder="New video playlist" aria-label="New video playlist name" maxLength={100} />
          <button type="button" className="video-theatre-create" disabled={!playlistName.trim() || playlistBusy} onClick={() => void createPlaylist()}><FiPlus /> Create</button>
        </div>
      </header>
      <div className="video-theatre-layout">
        <main className="video-theatre-stage">
          {activeFile && previewPath === activeFile.path && preview?.mediaUrl ? (
            <video
              ref={videoRef}
              key={activeFile.path}
              src={preview.mediaUrl}
              controls
              autoPlay
              playsInline
              onEnded={nextFile}
              onError={() => setError("This video could not be played in the current format.")}
              aria-label={activeFile.name}
            />
          ) : (
            <div className="video-theatre-placeholder" role={busy ? "status" : undefined}>
              <FiPlay />
              <strong>{busy ? "Opening video…" : error || "Choose a video to begin"}</strong>
            </div>
          )}
          {activeFile && <div className="video-theatre-now-playing">
            <div><strong>{activeFile.name}</strong><small>{activeFile.sourceLabel || activeFile.relativePath}</small></div>
            <div className="video-theatre-actions">
              <button type="button" className={favoritePaths.has(activeFile.path) ? "active" : ""} title={favoritePaths.has(activeFile.path) ? "Remove from Favorites" : "Add to Favorites"} aria-label="Favorite video" onClick={() => onToggleFavorite(activeFile.path)}><FiHeart /></button>
              <button type="button" title={targetPlaylist ? `Add video to ${targetPlaylist.name}` : "Choose a playlist destination"} aria-label="Add video to selected playlist" disabled={!targetPlaylist || targetPlaylist.filePaths.includes(activeFile.path)} onClick={() => targetPlaylist && void onAddToPlaylist(targetPlaylist.id, activeFile.path)}><FiPlus /></button>
              {selectedPlaylist?.filePaths.includes(activeFile.path) && <button type="button" title={`Remove video from ${selectedPlaylist.name}`} aria-label="Remove video from selected playlist" onClick={() => void onRemoveFromPlaylist(selectedPlaylist.id, activeFile.path)}><FiTrash2 /></button>}
              <button type="button" title="Pop out video player" aria-label="Pop out video player" onClick={() => void popOut()}><FiExternalLink /></button>
            </div>
          </div>}
          {metadata && activeFile && <div className="video-theatre-metadata">
            <button type="button" onClick={() => onEditMetadata(activeFile.path, "keywords")}><FiTag /> Keywords <span>{metadata.keywords.join(", ") || "Add"}</span></button>
            <button type="button" onClick={() => onEditMetadata(activeFile.path, "people")}><FiUsers /> People <span>{metadata.people?.join(", ") || "Add"}</span></button>
            <button type="button" onClick={() => onEditMetadata(activeFile.path, "places")}><FiMapPin /> Places <span>{metadata.places?.join(", ") || "Add"}</span></button>
          </div>}
          {activeFile && !metadata && <div className="video-theatre-metadata">
            <button type="button" onClick={() => onEditMetadata(activeFile.path, "keywords")}><FiTag /> Add keywords</button>
            <button type="button" onClick={() => onEditMetadata(activeFile.path, "people")}><FiUsers /> Add people</button>
            <button type="button" onClick={() => onEditMetadata(activeFile.path, "places")}><FiMapPin /> Add places</button>
          </div>}
          {error && preview?.mediaUrl && <p className="video-theatre-error" role="alert">{error}</p>}
        </main>
        <aside className="video-theatre-queue" aria-label="Video queue">
          <div className="video-theatre-queue-heading"><strong>{selectedPlaylist ? "Playlist" : "Filtered videos"}</strong><span>{queue.length}</span></div>
          {queue.length === 0 ? <p className="video-theatre-empty">No videos match this view. Select another playlist or adjust the filters.</p> : queue.map((file) => (
            <div className={`video-theatre-item ${activeFile?.path === file.path ? "active" : ""}`} key={file.path}>
              <button type="button" className="video-theatre-item-play" onClick={() => chooseFile(file)}><FiPlay /><span>{file.name}<small>{new Date(file.modified).toLocaleDateString()}</small></span></button>
              <button type="button" className={`video-theatre-item-favorite ${favoritePaths.has(file.path) ? "active" : ""}`} aria-label="Favorite video" onClick={() => onToggleFavorite(file.path)}><FiHeart /></button>
              {selectedPlaylist?.filePaths.includes(file.path) && <button type="button" className="video-theatre-item-add" title={`Remove from ${selectedPlaylist.name}`} aria-label="Remove from playlist" onClick={() => void onRemoveFromPlaylist(selectedPlaylist.id, file.path)}><FiTrash2 /></button>}
              <button type="button" className="video-theatre-item-add" title={targetPlaylist ? `Add to ${targetPlaylist.name}` : "Choose a playlist destination"} aria-label="Add to selected playlist" disabled={!targetPlaylist || targetPlaylist.filePaths.includes(file.path)} onClick={() => targetPlaylist && void onAddToPlaylist(targetPlaylist.id, file.path)}><FiPlus /></button>
            </div>
          ))}
        </aside>
      </div>
    </section>
  );
}
