export interface StatusProgress {
  status: string;
}

interface Scheduler {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Coalesces frequent progress updates while forwarding every stage transition immediately. */
export function createProgressThrottle<T extends StatusProgress>(
  send: (progress: T) => void,
  intervalMs = 250,
  scheduler: Scheduler = defaultScheduler,
): (progress: T) => void {
  let lastSentAt = 0;
  let lastStatus: string | null = null;
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deliver = () => {
    timer = null;
    const progress = pending;
    pending = null;
    if (!progress) return;
    lastSentAt = scheduler.now();
    lastStatus = progress.status;
    send(progress);
  };

  return (progress) => {
    pending = progress;
    const waitMs = intervalMs - (scheduler.now() - lastSentAt);
    if (progress.status !== lastStatus || waitMs <= 0) {
      if (timer !== null) scheduler.clearTimeout(timer);
      deliver();
      return;
    }
    if (timer === null) timer = scheduler.setTimeout(deliver, waitMs);
  };
}
