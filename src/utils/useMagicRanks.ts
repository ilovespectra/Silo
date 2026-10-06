import { useEffect, useState } from "react";

export type MagicPresetId = "balanced" | "people" | "landscapes" | "variety";

export const MAGIC_PRESETS: Array<{
  id: MagicPresetId;
  label: string;
  description: string;
}> = [
  {
    id: "balanced",
    label: "Balanced",
    description: "All-round photographic quality",
  },
  {
    id: "people",
    label: "People",
    description: "Favors well-framed faces, candids, and group shots",
  },
  {
    id: "landscapes",
    label: "Landscapes",
    description: "Favors scenery, color, contrast, and composition",
  },
  {
    id: "variety",
    label: "Variety",
    description:
      "Strongest removal of similar shots, so every pick is a different moment",
  },
];

/** Magic preset and top-N count, remembered between sessions. */
export function useMagicPreferences() {
  const [preset, setPreset] = useState<MagicPresetId>(() => {
    const stored = localStorage.getItem("silo.magicPreset");
    return MAGIC_PRESETS.some((item) => item.id === stored)
      ? (stored as MagicPresetId)
      : "balanced";
  });
  const [topCount, setTopCount] = useState(
    () => Number(localStorage.getItem("silo.magicTopCount")) || 100,
  );
  useEffect(() => localStorage.setItem("silo.magicPreset", preset), [preset]);
  useEffect(
    () => localStorage.setItem("silo.magicTopCount", String(topCount)),
    [topCount],
  );
  return { preset, setPreset, topCount, setTopCount };
}

export interface MagicState {
  ranks: Map<string, number>;
  scores: Record<string, number>;
  analyzed: number;
  total: number;
  running: boolean;
}

export const emptyMagicState: MagicState = {
  ranks: new Map(),
  scores: {},
  analyzed: 0,
  total: 0,
  running: false,
};

// Re-sorting under the user's cursor is disruptive, so refresh the order at most this often while analyzing.
const REFRESH_INTERVAL_MS = 8000;

/** Keeps `setState` filled with the local aesthetic ranking for `items` while magic sort is enabled. */
export function useMagicRanks(
  enabled: boolean,
  items: FileInfo[],
  setState: (
    update: MagicState | ((current: MagicState) => MagicState),
  ) => void,
  preset: MagicPresetId = "balanced",
) {
  useEffect(() => {
    const electron = window.electron;
    if (!enabled || !electron) {
      setState(emptyMagicState);
      return;
    }
    let active = true;
    let timer: number | null = null;
    let lastFetch = 0;
    const payload = items
      .filter((item) => !item.isDirectory)
      .map((item) => ({
        path: item.path,
        size: item.size,
        modified: item.modified,
        name: item.name,
      }));

    const fetchRanks = async () => {
      lastFetch = Date.now();
      try {
        const result = await electron.magicRank(payload, preset);
        if (!active) return;
        setState({
          ranks: new Map(
            result.order.map((filePath, index) => [filePath, index]),
          ),
          scores: result.scores,
          analyzed: result.analyzed,
          total: result.total,
          running: result.running,
        });
      } catch {
        // Keep the previous order if ranking fails.
      }
    };
    const schedule = (delay: number) => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void fetchRanks();
      }, delay);
    };

    // Debounced: the file list can change rapidly while a folder is still scanning.
    schedule(300);
    const removeListener = electron.onMagicSortProgress((progress) => {
      if (!active) return;
      setState((current) => ({
        ...current,
        analyzed: progress.analyzed,
        total: progress.total,
        running: progress.running,
      }));
      schedule(
        progress.running
          ? Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - lastFetch))
          : 0,
      );
    });
    return () => {
      active = false;
      removeListener();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, items, preset, setState]);
}
