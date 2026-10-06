import { useEffect, useState } from "react";

export interface PhotoIndicator {
  hasLocation: boolean;
  locationLabel?: string | null;
  people: string[];
}

const cache = new Map<string, PhotoIndicator>();
const listeners = new Map<string, Set<(value: PhotoIndicator) => void>>();
let pending = new Set<string>();
let flushTimer: number | null = null;
let changeSubscribed = false;

function publish(filePath: string, value: PhotoIndicator) {
  const previous = cache.get(filePath);
  if (
    previous &&
    previous.hasLocation === value.hasLocation &&
    previous.locationLabel === value.locationLabel &&
    previous.people.length === value.people.length &&
    previous.people.every((person, index) => person === value.people[index])
  )
    return;
  cache.set(filePath, value);
  listeners.get(filePath)?.forEach((listener) => listener(value));
}

/** Sorting and thumbnail badges must use the same metadata snapshot. */
export function publishPhotoIndicators(values: Record<string, PhotoIndicator>) {
  Object.entries(values).forEach(([filePath, value]) =>
    publish(filePath, value),
  );
}

// Batches every visible thumbnail's request into one IPC call per frame.
function flush() {
  flushTimer = null;
  const paths = Array.from(pending);
  pending = new Set();
  if (paths.length === 0 || !window.electron?.getPhotoIndicators) return;
  void (async () => {
    for (let offset = 0; offset < paths.length; offset += 1000) {
      const batch = paths.slice(offset, offset + 1000);
      const result = await window.electron!.getPhotoIndicators(batch);
      for (const filePath of batch) {
        publish(
          filePath,
          result[filePath] ?? { hasLocation: false, people: [] },
        );
      }
    }
  })().catch(() => undefined);
}

function request(filePath: string) {
  pending.add(filePath);
  flushTimer ??= window.setTimeout(flush, 30);
}

function ensureChangeSubscription() {
  if (changeSubscribed || !window.electron?.onPhotoIndicatorsChanged) return;
  changeSubscribed = true;
  window.electron.onPhotoIndicatorsChanged(() => {
    // Keep the last badge visible until fresh metadata replaces it.
    listeners.forEach((_set, filePath) => request(filePath));
  });
}

export function refreshPhotoIndicators(paths: string[]) {
  paths.forEach((filePath) => {
    if (listeners.has(filePath)) request(filePath);
  });
}

export function usePhotoIndicator(filePath: string, enabled: boolean) {
  const [value, setValue] = useState<PhotoIndicator | undefined>(() =>
    cache.get(filePath),
  );
  useEffect(() => {
    if (!enabled) return;
    ensureChangeSubscription();
    const set = listeners.get(filePath) ?? new Set();
    set.add(setValue);
    listeners.set(filePath, set);
    const cached = cache.get(filePath);
    setValue(cached);
    if (!cached) request(filePath);
    return () => {
      set.delete(setValue);
      if (set.size === 0) listeners.delete(filePath);
    };
  }, [enabled, filePath]);
  return value;
}
