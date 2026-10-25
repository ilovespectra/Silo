import * as os from "os";

export type IndexerLane =
  | "audio"
  | "face"
  | "search"
  | "thumbnail"
  | "source-discovery";
export type ThermalState = "nominal" | "fair" | "serious" | "critical" | "unknown";

export interface IndexerMachineProfile {
  platform: string;
  architecture: string;
  availableProcessors: number;
  totalMemoryBytes: number;
}

export interface IndexerGovernorSignals {
  /** Aggregate busy fraction across all logical processors. */
  cpuUtilization?: number;
  /** Highest busy fraction among logical processors; catches a saturated main thread. */
  busiestCoreUtilization?: number;
  /** Approximate physically reclaimable memory divided by total memory. */
  availableMemoryRatio?: number;
  idleSeconds?: number;
  onBattery?: boolean;
  thermalState?: ThermalState;
}

export interface SystemMemorySnapshot {
  total: number;
  free?: number;
  available?: number;
  fileBacked?: number;
  purgeable?: number;
}

/** Converts Electron's platform-specific memory counters into an availability ratio. */
export function getAvailableMemoryRatio(
  memory: SystemMemorySnapshot,
  platform: string,
): number | undefined {
  if (!Number.isFinite(memory.total) || memory.total <= 0) return undefined;

  const validAmount = (value: number | undefined): value is number =>
    Number.isFinite(value) && (value as number) >= 0;
  let available: number;
  if (platform === "darwin") {
    // macOS can reclaim file-backed and purgeable pages under memory pressure.
    available = [memory.free, memory.fileBacked, memory.purgeable]
      .filter(validAmount)
      .reduce((sum, amount) => sum + amount, 0);
  } else if (platform === "linux" && validAmount(memory.available)) {
    available = memory.available;
  } else if (validAmount(memory.free)) {
    available = memory.free;
  } else {
    return undefined;
  }

  return Math.max(0, Math.min(1, available / memory.total));
}

export interface IndexerGovernorProfile {
  name: string;
  startingDutyPercent: number;
  maximumDutyPercent: number;
  minimumDutyPercent: number;
}

export function getIndexerGovernorProfile(
  machine: IndexerMachineProfile = {
    platform: os.platform(),
    architecture: os.arch(),
    availableProcessors: Math.max(1, os.cpus().length),
    totalMemoryBytes: os.totalmem(),
  },
): IndexerGovernorProfile {
  if (machine.platform === "darwin" && machine.architecture === "arm64") {
    return {
      name: "Apple Silicon",
      startingDutyPercent: 16,
      maximumDutyPercent: machine.totalMemoryBytes <= 12 * 1024 ** 3 ? 32 : 42,
      minimumDutyPercent: 3,
    };
  }
  if (machine.platform === "darwin" && machine.architecture === "x64") {
    return {
      name: "Intel Mac",
      startingDutyPercent: 7,
      maximumDutyPercent: machine.totalMemoryBytes <= 8 * 1024 ** 3 ? 20 : 25,
      minimumDutyPercent: 3,
    };
  }
  if (machine.platform === "win32") {
    return {
      name: "Windows",
      startingDutyPercent: 10,
      maximumDutyPercent: machine.totalMemoryBytes <= 8 * 1024 ** 3 ? 22 : 30,
      minimumDutyPercent: 3,
    };
  }
  return {
    name: "Other",
    startingDutyPercent: 8,
    maximumDutyPercent: machine.totalMemoryBytes <= 8 * 1024 ** 3 ? 20 : 25,
    minimumDutyPercent: 3,
  };
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

/** One process-wide budget shared by background indexing and external scans. */
export class IndexerGovernor {
  private userPaceLimitPercent: number;
  private readonly activeLanes = new Map<IndexerLane, number>();

  constructor(
    readonly profile: IndexerGovernorProfile = getIndexerGovernorProfile(),
    private readonly readSignals: () => IndexerGovernorSignals = () => ({
      idleSeconds: 0,
      thermalState: "unknown",
    }),
  ) {
    this.userPaceLimitPercent = profile.maximumDutyPercent;
  }

  setPaceLimitPercent(percent: number) {
    if (!Number.isFinite(percent)) return;
    this.userPaceLimitPercent = clamp(Math.round(percent), 5, 100);
  }

  enterLane(lane: IndexerLane) {
    this.activeLanes.set(lane, (this.activeLanes.get(lane) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.activeLanes.get(lane) ?? 0;
      if (count <= 1) this.activeLanes.delete(lane);
      else this.activeLanes.set(lane, count - 1);
    };
  }

  getTargetDutyPercent(signals = this.readSignals()): number {
    if (signals.thermalState === "critical") return 0;

    const idleSeconds = Math.max(0, signals.idleSeconds ?? 0);
    const idleFraction = clamp(idleSeconds / 180, 0, 1);
    let duty =
      this.profile.startingDutyPercent +
      (this.profile.maximumDutyPercent - this.profile.startingDutyPercent) * idleFraction;

    // Aggregate CPU can hide one saturated core on high-core-count Macs.
    // Use both readings directly so background work backs off before the
    // main thread or an interactive worker stays pinned.
    const cpuPressure = Math.max(
      signals.cpuUtilization ?? 0,
      signals.busiestCoreUtilization ?? 0,
    );
    if (cpuPressure >= 0.92) duty *= 0.2;
    else if (cpuPressure >= 0.82) duty *= 0.35;
    else if (cpuPressure >= 0.7) duty *= 0.55;
    else if (cpuPressure >= 0.55) duty *= 0.75;

    const memoryAvailable = signals.availableMemoryRatio ?? 1;
    if (memoryAvailable < 0.04) duty *= 0.2;
    else if (memoryAvailable < 0.08) duty *= 0.45;
    else if (memoryAvailable < 0.15) duty *= 0.7;

    if (signals.onBattery) duty *= 0.7;
    if (signals.thermalState === "fair") duty *= 0.8;
    else if (signals.thermalState === "serious") duty *= 0.35;
    const simultaneousLanes = Math.max(1, this.activeLanes.size);
    const totalMaximum = Math.min(
      this.profile.maximumDutyPercent,
      this.userPaceLimitPercent,
    );
    // The saved background-work preference is a process-wide ceiling. Split
    // it across active lanes, and lower the usual per-lane minimum when needed
    // so several concurrent indexers cannot exceed that ceiling together.
    const laneMaximum = totalMaximum / simultaneousLanes;
    return clamp(duty / simultaneousLanes, 0, laneMaximum);
  }

  async paceAfterWork(
    workMs: number,
    shouldYield: () => boolean,
    shouldStop: () => boolean = () => false,
    maximumDutyPercent?: number,
  ) {
    let waitedMs = 0;
    while (!shouldStop()) {
      if (shouldYield()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        continue;
      }
      const signals = this.readSignals();
      if (signals.thermalState === "critical") {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }
      const dutyCeiling = Number.isFinite(maximumDutyPercent)
        ? clamp(maximumDutyPercent as number, 0, 100)
        : 100;
      const dutyPercent = Math.min(
        this.getTargetDutyPercent(signals),
        dutyCeiling,
      );
      if (dutyPercent <= 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const targetCooldownMs = Math.ceil(
        Math.max(1, workMs) * ((100 - dutyPercent) / dutyPercent),
      );
      if (waitedMs >= targetCooldownMs) return;
      const slice = Math.min(100, targetCooldownMs - waitedMs);
      await new Promise<void>((resolve) => setTimeout(resolve, slice));
      waitedMs += slice;
    }
  }
}
