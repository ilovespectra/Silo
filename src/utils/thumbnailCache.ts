// Values are short thumb:// URLs, so a large cache costs little memory.
export class LRUCache {
  private cache = new Map<string, string>();

  constructor(private maxSize = 20000) {}

  get(key: string): string | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  peek(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }
}

export const thumbnailCache = new LRUCache();

export const GRID_THUMBNAIL_SIZE = 200;

export const thumbnailCacheKey = (filePath: string, size = GRID_THUMBNAIL_SIZE) =>
  `${filePath}\u0000${size}`;

const inFlight = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();
const failedAttempts = new Map<string, number>();
const FAILURE_RETRY_MS = 60 * 1000;
const THUMBNAIL_RETRY_BASE_MS = 1000;
const THUMBNAIL_RETRY_MAX_MS = 30 * 1000;
const listeners = new Map<string, Set<(url: string) => void>>();

function publish(filePath: string, url: string, size: number) {
  const key = thumbnailCacheKey(filePath, size);
  thumbnailCache.set(key, url);
  failedAt.delete(key);
  failedAttempts.delete(key);
  listeners.get(key)?.forEach((listener) => listener(url));
}

/** Notifies when a thumbnail for this path is loaded or regenerated anywhere in the app. */
export function subscribeThumbnail(
  filePath: string,
  listener: (url: string) => void,
  size = GRID_THUMBNAIL_SIZE,
) {
  const key = thumbnailCacheKey(filePath, size);
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function hasThumbnailFailed(filePath: string, size = GRID_THUMBNAIL_SIZE) {
  const at = failedAt.get(thumbnailCacheKey(filePath, size));
  return at !== undefined && Date.now() - at < FAILURE_RETRY_MS;
}

/** A visible grid tile retries indefinitely with capped backoff; hidden tiles stop retrying. */
export function getThumbnailRetryDelay(
  filePath: string,
  size = GRID_THUMBNAIL_SIZE,
) {
  const attempts = failedAttempts.get(thumbnailCacheKey(filePath, size)) ?? 0;
  return Math.min(
    THUMBNAIL_RETRY_MAX_MS,
    THUMBNAIL_RETRY_BASE_MS * 2 ** Math.min(attempts, 5),
  );
}

/** Regenerates a thumbnail, bypassing failure memory on both sides (used when a file is opened). */
export async function refreshThumbnail(filePath: string) {
  failedAt.delete(thumbnailCacheKey(filePath, 480));
  try {
    const url = await window.electron?.getThumbnail(filePath, true, true, 480);
    if (url) publish(filePath, url, 480);
    return url ?? null;
  } catch {
    return null;
  }
}

/** Shared loader: one IPC request per path, cached successes, and remembered failures. */
export function loadThumbnail(
  filePath: string,
  urgent = false,
  size = GRID_THUMBNAIL_SIZE,
  retryFailed = false,
): Promise<string | null> {
  const key = thumbnailCacheKey(filePath, size);
  const cached = thumbnailCache.get(key);
  if (cached) return Promise.resolve(cached);
  if (retryFailed) failedAt.delete(key);
  if (hasThumbnailFailed(filePath, size) || !window.electron)
    return Promise.resolve(null);
  const pending = inFlight.get(key);
  if (pending) {
    if (urgent) void window.electron.getThumbnail(filePath, true, false, size);
    return pending;
  }
  const request = (async () => {
    const delays = [500, 1500];
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const url = await window.electron?.getThumbnail(
          filePath,
          urgent || retryFailed,
          retryFailed,
          size,
        );
        if (url) {
          publish(filePath, url, size);
          return url;
        }
      } catch {
        // The main process may have dropped the job under load; retry below.
      }
      if (attempt < delays.length)
        await new Promise((resolve) =>
          window.setTimeout(resolve, delays[attempt]),
        );
    }
    failedAttempts.set(key, (failedAttempts.get(key) ?? 0) + 1);
    failedAt.set(key, Date.now());
    return null;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
