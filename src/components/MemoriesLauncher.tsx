import React, { useEffect, useRef, useState } from "react";
import type { MemoriesAPI, MemorySuggestion } from "../memoryTypes";
import { MemoryCover, MemoryIcons, MemoryViewDialog, MemoriesDialog } from "./MemoriesPage";
import "../styles/Memories.css";

const { FiArrowRight, FiFilm, FiImage } = MemoryIcons;

export interface MemoriesLauncherProps {
  api: MemoriesAPI;
  ready: boolean;
  onExplore: () => void;
}

/** Optional startup invitation. Reads the cache once after readiness; never generates. */
export default function MemoriesLauncher({ api, ready, onExplore }: MemoriesLauncherProps) {
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [viewingMemory, setViewingMemory] = useState<MemorySuggestion | null>(null);
  const [open, setOpen] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fetched = useRef(false);
  const cached = useRef<Promise<Awaited<ReturnType<MemoriesAPI["getMemories"]>>> | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!ready || fetched.current) return;
    let cancelled = false;
    // Retain the same promise through StrictMode effect replay and prop churn.
    if (!cached.current) cached.current = api.getMemories(true);
    cached.current.then((state) => {
      if (cancelled) return;
      fetched.current = true;
      // Only offer stories that play instantly; the rest are still rendering in the background.
      const playable = state.suggestions.filter((memory) => !state.previews || state.previews[memory.id]?.status === "ready");
      if (state.settings.showOnLaunch && playable.length) {
        setSuggestions(playable.slice(0, 3)); setOpen(true);
      }
    }).catch(() => {
      // A failed startup cache read must never interrupt startup with a popup.
      if (!cancelled) fetched.current = true;
    });
    return () => { cancelled = true; };
  }, [api, ready]);
  const close = async (explore: boolean) => {
    if (pending.current) return;
    pending.current = true; setError("");
    try {
      if (dontShow) { setSaving(true); await api.updateMemorySettings({ showOnLaunch: false }); }
      if (!alive.current) return;
      setOpen(false);
      if (explore) onExplore();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Could not save the launch preference. Uncheck the option to close without changing it.");
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return <>
    {open && ready && suggestions.length > 0 && <MemoriesDialog title="Explore memories" onClose={() => { void close(false); }} locked={saving}>
      <div className="memories-modal-body memories-launcher">
        <span className="memories-eyebrow">A few moments worth revisiting</span>
        <p className="memories-launcher-intro">Your library has stories to tell. Choose a memory to watch now, or explore the collection.</p>
        <div className="memories-launcher-grid">
          {suggestions.map((memory) => <button type="button" key={memory.id} className="memories-launcher-card" disabled={saving} aria-label={`Watch memory: ${memory.title}`} onClick={() => {
            setViewingMemory(memory);
            void close(false);
          }}>
            <MemoryCover memory={memory} /><div className="memories-launcher-card-body"><span className="memories-mood-label">{memory.mood} · Landscape 16:9</span>
              <h3>{memory.title}</h3><p>{memory.description}</p>
              <span className="memories-meta"><span><FiImage />{memory.media.filter((item) => item.type === "image").length} photos</span><span><FiFilm />{memory.media.filter((item) => item.type === "video").length} clips</span></span>
            </div>
          </button>)}
        </div>
        {error && <p className="memories-error" role="alert">{error}</p>}
        <footer className="memories-launcher-footer">
          <label><input type="checkbox" checked={dontShow} disabled={saving} onChange={(event) => setDontShow(event.target.checked)} />Don’t show on launch</label>
          <button type="button" className="memories-button memories-primary" disabled={saving} onClick={() => { void close(true); }}>{saving ? "Saving…" : "Explore memories"}<FiArrowRight /></button>
        </footer>
      </div>
    </MemoriesDialog>}
    {viewingMemory && <MemoryViewDialog api={api} memory={viewingMemory} onClose={() => setViewingMemory(null)} />}
  </>;
}