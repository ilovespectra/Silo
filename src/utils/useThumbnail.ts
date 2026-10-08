import { useEffect, useState } from "react";
import {
  getThumbnailRetryDelay,
  GRID_THUMBNAIL_SIZE,
  hasThumbnailFailed,
  loadThumbnail,
  subscribeThumbnail,
  thumbnailCache,
  thumbnailCacheKey,
} from "./thumbnailCache";

export function useThumbnail(
  filePath: string,
  isVisible: boolean = true,
  urgent = false,
  size = GRID_THUMBNAIL_SIZE,
) {
  const cacheKey = thumbnailCacheKey(filePath, size);
  const [thumbnail, setThumbnail] = useState<string | null>(
    () => thumbnailCache.peek(cacheKey) || null,
  );
  const [loading, setLoading] = useState(
    () => !thumbnailCache.has(cacheKey) && isVisible,
  );

  useEffect(
    () =>
      subscribeThumbnail(
        filePath,
        (url) => {
          setThumbnail(url);
          setLoading(false);
        },
        size,
      ),
    [filePath, size],
  );

  useEffect(() => {
    const cached = thumbnailCache.get(thumbnailCacheKey(filePath, size));
    setThumbnail(cached || null);
    if (cached || !isVisible) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let retryTimer = 0;
    const load = async (retryFailed = false) => {
      if (cancelled) return;
      setLoading(true);
      const url = await loadThumbnail(filePath, urgent, size, retryFailed);
      if (cancelled) return;
      setThumbnail(url);
      setLoading(false);
      if (!url) {
        const delay = hasThumbnailFailed(filePath, size)
          ? getThumbnailRetryDelay(filePath, size)
          : 1500;
        retryTimer = window.setTimeout(() => void load(true), delay);
      }
    };

    void load(hasThumbnailFailed(filePath, size));
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [filePath, isVisible, size, urgent]);

  return { thumbnail, loading };
}
