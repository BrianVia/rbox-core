/** Never: filesystem traversal or scan policy. */
import type { DircacheOutcome } from "./dircache.js";

export interface ScanStats extends ScanTimingStats {
  dirsWalked: number;
  filesStatted: number;
  filesSkippedCacheHit: number;
  filesHashed: number;
  dirsReusedFromCache: number;
  dircacheOutcome: DircacheOutcome;
  attemptCount: number;
  /** Every bounded walk attempt, including a discarded pruned attempt. */
  attempts: ScanAttemptStats[];
}

export interface ScanResidualBuckets {
  rulePrevalidationMs: number;
  rulePostvalidationMs: number;
  ruleRebuildMs: number;
  directoryMs: number;
  pathMs: number;
  gitDiscoveryMs: number;
  symlinkMs: number;
  observerMs: number;
  entryMs: number;
  controlMs: number;
  finalizationMs: number;
}

export interface ScanTimingStats {
  /** One monotonic wall interval, including finalization. */
  scanWallMs: number;
  readdirMs: number;
  statMs: number;
  matcherMs: number;
  hashMs: number;
  sortMs: number;
  /** The former residual, now closed over fixed path-free buckets. */
  residualMs: number;
  residualBuckets: ScanResidualBuckets;
}

export interface ScanAttemptStats extends ScanTimingStats {
  mode: "off" | "pruned" | "unpruned";
}

type PrimaryTimingBucket = "readdirMs" | "statMs" | "matcherMs" | "hashMs" | "sortMs";
type ResidualTimingBucket = keyof ScanResidualBuckets;
type ScanTimingBucket = PrimaryTimingBucket | ResidualTimingBucket;

const PRIMARY_TIMING_BUCKETS = ["readdirMs", "statMs", "matcherMs", "hashMs", "sortMs"] as const;
const RESIDUAL_TIMING_BUCKETS = [
  "rulePrevalidationMs",
  "rulePostvalidationMs",
  "ruleRebuildMs",
  "directoryMs",
  "pathMs",
  "gitDiscoveryMs",
  "symlinkMs",
  "observerMs",
  "entryMs",
  "controlMs",
  "finalizationMs",
] as const;

function createResidualBuckets(): ScanResidualBuckets {
  return {
    rulePrevalidationMs: 0,
    rulePostvalidationMs: 0,
    ruleRebuildMs: 0,
    directoryMs: 0,
    pathMs: 0,
    gitDiscoveryMs: 0,
    symlinkMs: 0,
    observerMs: 0,
    entryMs: 0,
    controlMs: 0,
    finalizationMs: 0,
  };
}

function createAttemptStats(mode: ScanAttemptStats["mode"]): ScanAttemptStats {
  return {
    mode,
    scanWallMs: 0,
    readdirMs: 0,
    statMs: 0,
    matcherMs: 0,
    hashMs: 0,
    sortMs: 0,
    residualMs: 0,
    residualBuckets: createResidualBuckets(),
  };
}

/**
 * Opt-in exclusive timing owner. Broad async operations (not their nested work)
 * are timed once, and the remaining loop/recursion time closes into controlMs.
 * Attempt boundaries reuse one timestamp, so attempt walls sum exactly to the
 * scan wall apart from floating-point arithmetic.
 */
export class ScanAccounting {
  private readonly attempts: ScanAttemptStats[] = [];
  private current: ScanAttemptStats;
  private attemptStartedAt: number;
  private nestedObserverMs = 0;

  constructor(private readonly target: ScanStats, private readonly scanStartedAt: number, mode: ScanAttemptStats["mode"]) {
    this.current = createAttemptStats(mode);
    this.attemptStartedAt = scanStartedAt;
  }

  setMode(mode: ScanAttemptStats["mode"]): void {
    this.current.mode = mode;
  }

  sync<T>(bucket: ScanTimingBucket, fn: () => T): T {
    const startedAt = performance.now();
    const observerAtStart = this.nestedObserverMs;
    try {
      return fn();
    } finally {
      this.add(bucket, Math.max(0, performance.now() - startedAt - (this.nestedObserverMs - observerAtStart)));
    }
  }

  async<T>(bucket: ScanTimingBucket, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    const observerAtStart = this.nestedObserverMs;
    return fn().finally(() => {
      this.add(bucket, Math.max(0, performance.now() - startedAt - (this.nestedObserverMs - observerAtStart)));
    });
  }

  /** Partition one concurrent async phase into exclusive wall-time buckets.
   *  `secondary` is measured as the union of its in-flight operations, so
   *  concurrent workers never make the buckets add up to more than phase wall. */
  async partitionedAsync<T>(
    primary: PrimaryTimingBucket,
    secondary: PrimaryTimingBucket,
    fn: (measureSecondary: <U>(work: () => Promise<U>) => Promise<U>) => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    const observerAtStart = this.nestedObserverMs;
    let lastBoundary = startedAt;
    let secondaryInFlight = 0;
    let primaryMs = 0;
    let secondaryMs = 0;
    const measureSecondary = async <U>(work: () => Promise<U>): Promise<U> => {
      if (secondaryInFlight++ === 0) {
        const boundary = performance.now();
        primaryMs += boundary - lastBoundary;
        lastBoundary = boundary;
      }
      try {
        return await work();
      } finally {
        if (--secondaryInFlight === 0) {
          const boundary = performance.now();
          secondaryMs += boundary - lastBoundary;
          lastBoundary = boundary;
        }
      }
    };
    try {
      return await fn(measureSecondary);
    } finally {
      const endedAt = performance.now();
      if (secondaryInFlight > 0) secondaryMs += endedAt - lastBoundary;
      else primaryMs += endedAt - lastBoundary;
      primaryMs = Math.max(0, primaryMs - (this.nestedObserverMs - observerAtStart));
      this.add(primary, primaryMs);
      this.add(secondary, secondaryMs);
    }
  }

  observe<T>(fn: () => T): T {
    const startedAt = performance.now();
    try {
      return fn();
    } finally {
      const elapsedMs = performance.now() - startedAt;
      this.add("observerMs", elapsedMs);
      this.nestedObserverMs += elapsedMs;
    }
  }

  retry(mode: ScanAttemptStats["mode"]): void {
    const boundary = performance.now();
    this.closeAttempt(boundary);
    this.current = createAttemptStats(mode);
    this.attemptStartedAt = boundary;
  }

  finish(): void {
    const workEndedAt = performance.now();
    this.closeAttempt(workEndedAt);
    this.publish(workEndedAt - this.scanStartedAt);
    // Include accounting publication itself in scan finalization. The final
    // scalar adjustments happen after the closing stamp (as every timer must),
    // but the allocation/copy work that makes the record observable is covered.
    const endedAt = performance.now();
    const publicationMs = Math.max(0, endedAt - workEndedAt);
    const lastIndex = this.attempts.length - 1;
    const attempt = this.attempts[lastIndex]!;
    const publishedAttempt = this.target.attempts[lastIndex]!;
    attempt.scanWallMs += publicationMs;
    attempt.residualMs += publicationMs;
    attempt.residualBuckets.finalizationMs += publicationMs;
    publishedAttempt.scanWallMs += publicationMs;
    publishedAttempt.residualMs += publicationMs;
    publishedAttempt.residualBuckets.finalizationMs += publicationMs;
    this.target.scanWallMs += publicationMs;
    this.target.residualMs += publicationMs;
    this.target.residualBuckets.finalizationMs += publicationMs;
  }

  private closeAttempt(endedAt: number): void {
    const attempt = this.current;
    attempt.scanWallMs = Math.max(0, endedAt - this.attemptStartedAt);
    const explicitlyTimed = PRIMARY_TIMING_BUCKETS.reduce((sum, bucket) => sum + attempt[bucket], 0)
      + RESIDUAL_TIMING_BUCKETS.filter((bucket) => bucket !== "controlMs")
        .reduce((sum, bucket) => sum + attempt.residualBuckets[bucket], 0);
    attempt.residualBuckets.controlMs = Math.max(0, attempt.scanWallMs - explicitlyTimed);
    attempt.residualMs = RESIDUAL_TIMING_BUCKETS.reduce((sum, bucket) => sum + attempt.residualBuckets[bucket], 0);
    this.attempts.push(attempt);
  }

  private add(bucket: ScanTimingBucket, elapsedMs: number): void {
    if (bucket in this.current.residualBuckets) {
      const residualBucket = bucket as ResidualTimingBucket;
      this.current.residualBuckets[residualBucket] += elapsedMs;
      return;
    }
    const primaryBucket = bucket as PrimaryTimingBucket;
    this.current[primaryBucket] += elapsedMs;
  }

  private publish(scanWallMs: number): void {
    this.target.scanWallMs = Math.max(0, scanWallMs);
    this.target.attemptCount = this.attempts.length;
    this.target.attempts = this.attempts.map((attempt) => ({
      ...attempt,
      residualBuckets: { ...attempt.residualBuckets },
    }));
    for (const bucket of PRIMARY_TIMING_BUCKETS) {
      this.target[bucket] = this.attempts.reduce((sum, attempt) => sum + attempt[bucket], 0);
    }
    const residual = createResidualBuckets();
    for (const bucket of RESIDUAL_TIMING_BUCKETS) {
      residual[bucket] = this.attempts.reduce((sum, attempt) => sum + attempt.residualBuckets[bucket], 0);
    }
    this.target.residualBuckets = residual;
    this.target.residualMs = RESIDUAL_TIMING_BUCKETS.reduce((sum, bucket) => sum + residual[bucket], 0);
  }
}

export interface DirProbeSample {
  key: string;
  mtimeMs: number;
  ctimeMs: number;
  readdirMs: number;
  childCount: number;
  projectedBytes: number;
}

export interface DirProbeSink {
  probeOverheadMs: number;
  record(sample: DirProbeSample): void;
}

export function createScanStats(): ScanStats {
  return {
    dirsWalked: 0,
    filesStatted: 0,
    filesSkippedCacheHit: 0,
    filesHashed: 0,
    readdirMs: 0,
    statMs: 0,
    matcherMs: 0,
    hashMs: 0,
    sortMs: 0,
    dirsReusedFromCache: 0,
    dircacheOutcome: "off",
    scanWallMs: 0,
    attemptCount: 0,
    residualMs: 0,
    residualBuckets: createResidualBuckets(),
    attempts: [],
  };
}
