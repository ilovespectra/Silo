import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

/**
 * Local, incremental topic profile for Memories. Each sampled photo is assigned to the
 * closest prompt of a fixed, extensible vocabulary using its existing CLIP vector; no
 * embeddings are recomputed and nothing leaves the machine. Electron-free for tests.
 */

export interface ProfileRecord {
  path: string;
  sourcePath: string;
  modified: number;
  /** Index signature (size:mtime); a change means the photo must be reclassified. */
  signature: string;
}

export interface ProfileTopic {
  id: string;
  prompt: string;
}

export interface TopicProfileDependencies {
  statePath: string;
  topics: readonly ProfileTopic[];
  /** Prompts that compete for photos but are never reported (screenshots, generic shots). */
  distractorPrompts: readonly string[];
  /** Monotonic counter that changes whenever indexed records change. */
  revision(): number | string;
  /** Current personal-photo records with vectors; privacy filtering happens in the caller. */
  records(): ProfileRecord[] | Promise<ProfileRecord[]>;
  vectors(paths: string[]): Promise<Map<string, Float32Array>>;
  embedPrompts(prompts: string[]): Promise<Float32Array[]>;
  /** EXIF capture time in ms, or null when unknown. */
  captureTime(filePath: string): Promise<number | null>;
  now?(): number;
}

export interface TopicProfileOptions {
  /** Older photos are sampled deterministically down to about this many. */
  sampleTarget?: number;
  /** Photos modified within this window are always included at full resolution. */
  recentDays?: number;
  minimumSimilarity?: number;
  /** EXIF reads per refresh; the rest fall back to the indexed modification time. */
  captureReadsPerRefresh?: number;
  /** Recent photos a topic needs before it can count as emerging. */
  minEmerging?: number;
}

export interface TopicSummary {
  id: string;
  /** Estimated photos in the archive (inverse-probability weighted sample). */
  estimatedCount: number;
  /** Share of the whole archive. */
  archiveShare: number;
  /** Mean share across sources, so one huge source cannot hide another's interests. */
  sourceBalancedShare: number;
  /** Long-term interest relative to the top topic, 0..1. */
  interest: number;
  meanConfidence: number;
  recentCount: number;
  /** Recent share / long-term share (smoothed); 1 means nothing new. */
  lift: number;
  bySource: Record<string, number>;
  /** Highest-confidence matches. */
  paths: string[];
  /** Recently captured matches, newest first. */
  recentPaths: string[];
}

export interface TopicProfileSnapshot {
  revision: string;
  fingerprint: string;
  generatedAt: number;
  sampledPhotos: number;
  topics: TopicSummary[];
}

export interface RefreshResult {
  /** False when the index revision was unchanged and nothing was read. */
  recomputed: boolean;
  /** True when the ranked topic picture changed enough to refresh suggestions. */
  changed: boolean;
  classified: number;
  removed: number;
}

/** [signature, sourceIndex, topicIndex (-1 = none), confidence*1000, time, inclusion probability*1e6]
 * time > 0 is an EXIF capture time; time < 0 is the negated indexed modification time (fallback). */
type Entry = [string, number, number, number, number, number];

const DAY = 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;

/** Stable [0,1) value per path: membership in the sample never flickers between refreshes. */
export function sampleUnit(filePath: string): number {
  return createHash("sha1").update(filePath).digest().readUInt32BE(0) / 0x100000000;
}

function dot(first: Float32Array, second: Float32Array) {
  let sum = 0;
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index++) sum += first[index] * second[index];
  return sum;
}

export class MemoryTopicProfile {
  private entries = new Map<string, Entry>();
  private sources: string[] = [];
  private sourceIndex = new Map<string, number>();
  private sampleRate = 1;
  private lastRevision: string | null = null;
  private snapshot: TopicProfileSnapshot | null = null;
  private loaded?: Promise<void>;
  private refreshing?: Promise<RefreshResult>;
  private promptVectors?: Promise<Float32Array[]>;
  private readonly vocabularyKey: string;
  private readonly options: Required<TopicProfileOptions>;

  constructor(private readonly deps: TopicProfileDependencies, options: TopicProfileOptions = {}) {
    this.options = {
      sampleTarget: options.sampleTarget ?? 20000,
      recentDays: options.recentDays ?? 180,
      minimumSimilarity: options.minimumSimilarity ?? 0.2,
      captureReadsPerRefresh: options.captureReadsPerRefresh ?? 1500,
      minEmerging: options.minEmerging ?? 6,
    };
    this.vocabularyKey = createHash("sha1")
      .update(JSON.stringify([deps.topics, deps.distractorPrompts]))
      .digest("hex");
  }

  getSnapshot(): TopicProfileSnapshot | null {
    return this.snapshot;
  }

  /** Capture time recorded for a sampled photo, when EXIF provided one. */
  captureTimeOf(filePath: string): number | undefined {
    const entry = this.entries.get(filePath);
    return entry && entry[4] > 0 ? entry[4] : undefined;
  }

  /** Single-flight: concurrent callers share one refresh. */
  refresh(): Promise<RefreshResult> {
    if (!this.refreshing)
      this.refreshing = this.refreshOnce().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.deps.statePath, "utf8"));
      if (raw?.version !== STATE_VERSION || raw.vocabularyKey !== this.vocabularyKey) return;
      this.sampleRate = Number.isFinite(raw.sampleRate) ? raw.sampleRate : 1;
      this.sources = Array.isArray(raw.sources) ? raw.sources.filter((value: unknown) => typeof value === "string") : [];
      this.sources.forEach((source, index) => this.sourceIndex.set(source, index));
      for (const row of Array.isArray(raw.entries) ? raw.entries : []) {
        if (Array.isArray(row) && row.length === 7 && typeof row[0] === "string")
          this.entries.set(row[0], row.slice(1) as Entry);
      }
      this.snapshot = this.summarize(raw.revision ?? "");
    } catch {
      // Missing or corrupt profile state is rebuilt from the index on the next refresh.
    }
  }

  private source(sourcePath: string): number {
    let index = this.sourceIndex.get(sourcePath);
    if (index === undefined) {
      index = this.sources.length;
      this.sources.push(sourcePath);
      this.sourceIndex.set(sourcePath, index);
    }
    return index;
  }

  private async refreshOnce(): Promise<RefreshResult> {
    if (!this.loaded) this.loaded = this.load();
    await this.loaded;
    const revision = String(this.deps.revision());
    if (revision === this.lastRevision)
      return { recomputed: false, changed: false, classified: 0, removed: 0 };
    const previousFingerprint = this.snapshot?.fingerprint ?? "";
    const now = this.deps.now?.() ?? Date.now();
    const recentCutoff = now - this.options.recentDays * DAY;
    const records = await this.deps.records();

    const rate = Math.min(1, this.options.sampleTarget / Math.max(1, records.length));
    // A large shift in archive size changes who is sampled; rebuild rather than mix rates.
    if (rate > this.sampleRate * 2 || rate < this.sampleRate / 2) this.entries.clear();
    this.sampleRate = rate;

    const wanted = new Map<string, { record: ProfileRecord; probability: number }>();
    for (const record of records) {
      const recent = record.modified >= recentCutoff;
      if (recent || sampleUnit(record.path) < rate)
        wanted.set(record.path, { record, probability: recent ? 1 : rate });
    }
    let removed = 0;
    for (const [filePath, entry] of this.entries) {
      const want = wanted.get(filePath);
      if (!want || want.record.signature !== entry[0]) {
        this.entries.delete(filePath);
        removed += 1;
      }
    }
    const pending = Array.from(wanted.values()).filter(({ record }) => !this.entries.has(record.path));
    let classified = 0;
    if (pending.length) {
      if (!this.promptVectors)
        this.promptVectors = this.deps.embedPrompts([
          ...this.deps.topics.map((topic) => topic.prompt), ...this.deps.distractorPrompts,
        ]);
      const prompts = await this.promptVectors;
      // Recent files first so emerging interests get their EXIF dates within the budget.
      pending.sort((a, b) => b.record.modified - a.record.modified);
      let captureBudget = this.options.captureReadsPerRefresh;
      for (let start = 0; start < pending.length; start += 256) {
        const batch = pending.slice(start, start + 256);
        const vectors = await this.deps.vectors(batch.map(({ record }) => record.path));
        for (const { record, probability } of batch) {
          const vector = vectors.get(record.path);
          if (!vector) continue;
          let best = -1;
          let bestSimilarity = -Infinity;
          prompts.forEach((prompt, index) => {
            const similarity = dot(prompt, vector);
            if (similarity > bestSimilarity) { bestSimilarity = similarity; best = index; }
          });
          const topic = best < this.deps.topics.length && bestSimilarity >= this.options.minimumSimilarity ? best : -1;
          let captured = 0;
          if (captureBudget > 0) {
            captureBudget -= 1;
            captured = (await this.deps.captureTime(record.path).catch(() => null)) ?? 0;
          }
          this.entries.set(record.path, [record.signature, this.source(record.sourcePath), topic,
            Math.round(Math.max(0, bestSimilarity) * 1000), captured > 0 ? captured : -record.modified,
            Math.round(probability * 1e6)]);
          classified += 1;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.lastRevision = revision;
    this.snapshot = this.summarize(revision, now);
    await this.persist(revision);
    return { recomputed: true, changed: this.snapshot.fingerprint !== previousFingerprint, classified, removed };
  }

  private summarize(revision: string, now = this.deps.now?.() ?? Date.now()): TopicProfileSnapshot {
    const recentCutoff = now - this.options.recentDays * DAY;
    const topicCount = this.deps.topics.length;
    const weighted = new Array<number>(topicCount).fill(0);
    const confidence = new Array<number>(topicCount).fill(0);
    const members = new Array<number>(topicCount).fill(0);
    const recent = new Array<number>(topicCount).fill(0);
    const perSource = new Map<number, { total: number; topics: number[] }>();
    const best: [string, number][][] = Array.from({ length: topicCount }, () => []);
    const newest: [string, number][][] = Array.from({ length: topicCount }, () => []);
    let archiveTotal = 0;
    let recentTotal = 0;
    for (const [filePath, [, source, topic, conf, time, probability]] of this.entries) {
      const weight = 1e6 / Math.max(1, probability);
      archiveTotal += weight;
      const bucket = perSource.get(source) ?? { total: 0, topics: new Array<number>(topicCount).fill(0) };
      bucket.total += weight;
      perSource.set(source, bucket);
      const when = Math.abs(time);
      const isRecent = when >= recentCutoff;
      if (isRecent) recentTotal += 1;
      if (topic < 0) continue;
      weighted[topic] += weight;
      confidence[topic] += conf / 1000;
      members[topic] += 1;
      bucket.topics[topic] += weight;
      best[topic].push([filePath, conf]);
      if (isRecent) {
        recent[topic] += 1;
        newest[topic].push([filePath, when]);
      }
    }
    // Sources with very few photos would swing balanced shares; require a minimum.
    const balancedSources = Array.from(perSource.values()).filter((bucket) => bucket.total >= 20);
    const topics: TopicSummary[] = this.deps.topics.map((topic, index) => {
      const archiveShare = archiveTotal ? weighted[index] / archiveTotal : 0;
      const sourceBalancedShare = balancedSources.length
        ? balancedSources.reduce((sum, bucket) => sum + bucket.topics[index] / bucket.total, 0) / balancedSources.length
        : archiveShare;
      const meanConfidence = members[index] ? confidence[index] / members[index] : 0;
      const expectedRecent = recentTotal * archiveShare;
      const lift = recent[index] >= this.options.minEmerging
        ? (recent[index] + 2) / (expectedRecent + 2)
        : 1;
      const bySource: Record<string, number> = {};
      for (const [source, bucket] of perSource)
        if (bucket.topics[index] > 0) bySource[this.sources[source]] = bucket.topics[index] / bucket.total;
      return {
        id: topic.id,
        estimatedCount: Math.round(weighted[index]),
        archiveShare,
        sourceBalancedShare,
        interest: 0,
        meanConfidence,
        recentCount: recent[index],
        lift,
        bySource,
        paths: best[index].sort((a, b) => b[1] - a[1]).slice(0, 240).map(([filePath]) => filePath),
        recentPaths: newest[index].sort((a, b) => b[1] - a[1]).slice(0, 160).map(([filePath]) => filePath),
      };
    });
    const raw = topics.map((topic) =>
      (0.5 * topic.archiveShare + 0.5 * topic.sourceBalancedShare) *
      (0.75 + 0.5 * Math.min(1, Math.max(0, (topic.meanConfidence - 0.2) / 0.1))));
    const top = Math.max(...raw, 1e-9);
    topics.forEach((topic, index) => { topic.interest = raw[index] / top; });
    return {
      revision,
      fingerprint: this.fingerprint(topics),
      generatedAt: now,
      sampledPhotos: this.entries.size,
      topics: topics.slice().sort((a, b) => b.interest - a.interest),
    };
  }

  /** Coarse view of the ranking: small count drift does not count as a change. */
  private fingerprint(topics: TopicSummary[]): string {
    const leading = topics.filter((topic) => Math.round(topic.interest * 10) > 0)
      .sort((a, b) => b.interest - a.interest).slice(0, 12)
      .map((topic) => `${topic.id}:${Math.round(topic.interest * 10)}`);
    const emerging = topics.filter((topic) => topic.lift >= 1.5).map((topic) => topic.id).sort();
    return createHash("sha1").update(JSON.stringify([leading, emerging])).digest("hex");
  }

  private async persist(revision: string) {
    const data = JSON.stringify({
      version: STATE_VERSION,
      vocabularyKey: this.vocabularyKey,
      revision,
      sampleRate: this.sampleRate,
      sources: this.sources,
      entries: Array.from(this.entries, ([filePath, entry]) => [filePath, ...entry]),
    });
    await fs.mkdir(path.dirname(this.deps.statePath), { recursive: true });
    const temporary = `${this.deps.statePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.deps.statePath);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

/**
 * Debounced, single-flight trigger: waits for a quiet period, defers while indexing is
 * busy, never overlaps runs, and collapses notifications during a run into one rerun.
 */
export class RefreshScheduler {
  private timer: unknown = null;
  private running = false;
  private dirty = false;

  constructor(private readonly options: {
    delayMs: number;
    isBusy(): boolean;
    run(): Promise<void>;
    setTimer?(callback: () => void, delay: number): unknown;
    clearTimer?(handle: unknown): void;
  }) {}

  notify(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.timer !== null) (this.options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(this.timer);
    const schedule = this.options.setTimer ?? ((callback, delay) => {
      const handle = setTimeout(callback, delay);
      handle.unref?.();
      return handle;
    });
    this.timer = schedule(() => {
      this.timer = null;
      void this.fire();
    }, this.options.delayMs);
  }

  private async fire() {
    if (this.options.isBusy()) {
      this.notify();
      return;
    }
    this.running = true;
    this.dirty = false;
    try {
      await this.options.run();
    } catch {
      // A failed refresh is retried by the next index change.
    } finally {
      this.running = false;
      if (this.dirty) this.notify();
    }
  }
}
