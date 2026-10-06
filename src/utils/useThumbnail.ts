import { useEffect, useState } from "react";
import {
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
    () =>
      !thumbnailCache.has(cacheKey) &&
      !hasThumbnailFailed(filePath, size) &&
      isVisible,
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
    if (cached || !isVisible || hasThumbnailFailed(filePath, size)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadThumbnail(filePath, urgent, size).then((url) => {
      if (cancelled) return;
      setThumbnail(url);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, isVisible, size, urgent]);

  return { thumbnail, loading };
}
