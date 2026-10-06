import { useEffect, useRef, useState } from "react";

/** Skip brief background jobs and keep longer loading notices from blinking. */
export function useStableBusy(busy: boolean) {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (busy && visible) return;
    const delay = busy
      ? 350
      : Math.max(0, 1200 - (Date.now() - shownAt.current));
    const timer = window.setTimeout(() => {
      if (busy) shownAt.current = Date.now();
      setVisible(busy);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [busy, visible]);
  return visible;
}
