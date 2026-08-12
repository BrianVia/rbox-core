/**
 * Per-run client phase metrics (design §35) — the client analogue of the server's
 * `OpSpan` (`apps/api/src/metrics.ts`). A fixed-shape accumulator that times each sync
 * phase and the bytes it moved, then emits ONE structured object + one greppable
 * summary line per run.
 *
 * It carries NO PII by construction: there is no field for a path, a plaintext byte, a
 * blob/commit hash, or an account/device/workspace id — only phase names, durations,
 * byte totals, and counts (mirrors §25's dimension rule, `metrics.ts:11-29`).
 *
 * Distinct from the cumulative `SyncMetrics` counters (`src/cli/metrics.ts`): this is
 * per-RUN timing, so it lives in its own module and (when enabled) its own per-run JSON
 * sidecar. It is PURE — it does no I/O; the caller owns where the object + line go (the
 * daemon writes the line to its log; a bench harness writes the JSON). A DISABLED report
 * (the default on the daemon hot path) runs the wrapped work and accumulates nothing, so
 * a no-op tick allocates no phase state.
 *
 * A byte "basis" (§35 §3.1) is attributed to exactly ONE phase per run so the run totals
 * are a plain sum across phases — the same E2EE run moves four different byte totals and
 * which one is the denominator decides which optimization matters:
 *  - plaintextBytes  — sum of scanned file sizes (felt throughput)
 *  - ciphertextBytes — plaintext + 16-byte GCM tag per blob (what crypto/R2 handle)
 *  - wireBytes       — bytes actually sent/received this run (diverges on incremental/resume)
 *  - changedBytes    — ciphertext of only the blobs this run had to (re)encrypt/upload
 *                      (the denominator that decides §40 chunk sync)
 */

export type PhaseName =
  | "latest"
  | "state-load"
  | "validate"
  | "reconcile"
  | "scan"
  | "git-plan"
  | "address"
  | "encrypt"
  | "missing"
  | "upload"
  | "commit"
  | "download"
  | "decrypt"
  | "apply"
  | "git-apply"
  | "cache-save"
  | "state-save";

/** Stable display order for the summary line (and any tabular diff). */
export const PHASE_ORDER: readonly PhaseName[] = [
  "latest",
  "state-load",
  "validate",
  "reconcile",
  "scan",
  "git-plan",
  "address",
  "encrypt",
  "missing",
  "upload",
  "commit",
  "download",
  "decrypt",
  "apply",
  "git-apply",
  "cache-save",
  "state-save",
];

export interface PhaseTotals {
  ms: number;
  count: number; // items processed in this phase (blobs/files) — for per-item rates
  plaintextBytes: number;
  ciphertextBytes: number;
  wireBytes: number;
  changedBytes: number;
  details?: PhaseDetails;
}

/** JSON-safe, path-free telemetry dimensions attached to one phase. */
export type PhaseDetailValue = null | boolean | number | string | PhaseDetailValue[] | PhaseDetails;
export interface PhaseDetails { [name: string]: PhaseDetailValue; }
type PhaseDetailInput<T> = T extends null | boolean | number | string | undefined
  ? T
  : T extends readonly (infer U)[]
    ? PhaseDetailInput<U>[]
    : T extends object
      ? { [K in keyof T]: PhaseDetailInput<T[K]> }
      : never;

/** Bytes/counts to attribute to a phase. All optional; a phase sets only what it moves. */
export interface PhaseBytes {
  count?: number;
  plaintextBytes?: number;
  ciphertextBytes?: number;
  wireBytes?: number;
  changedBytes?: number;
}

export interface PhaseReportJson {
  op: "push" | "pull" | "sync";
  wallMs: number;
  files: number;
  blobs: number;
  peakRssBytes: number;
  phases: Partial<Record<PhaseName, PhaseTotals>>;
  /** Wall time between phases, keyed `<prev>→<next>` (`start` before the first phase).
   *  `tailMs` is the still-open gap since the last phase ended, measured at toJSON time.
   *  Gaps are how unwrapped work stays visible without guessing where to put wrappers. */
  gaps: Record<string, number>;
  tailMs: number;
}

function zeroTotals(): PhaseTotals {
  return { ms: 0, count: 0, plaintextBytes: 0, ciphertextBytes: 0, wireBytes: 0, changedBytes: 0 };
}

export class PhaseReport {
  readonly enabled: boolean;
  files = 0;
  blobs = 0;
  private readonly op: "push" | "pull" | "sync";
  private readonly startedAt: number;
  private readonly phases = new Map<PhaseName, PhaseTotals>();
  private readonly phaseSummaries = new Map<PhaseName, string>();
  private readonly gaps = new Map<string, number>();
  private lastBoundaryAt: number;
  private lastPhase = "start";
  private peakRss = 0;

  private constructor(op: "push" | "pull" | "sync", enabled: boolean) {
    this.op = op;
    this.enabled = enabled;
    this.startedAt = Date.now();
    this.lastBoundaryAt = this.startedAt;
    this.sampleRss();
  }

  static push(): PhaseReport {
    return new PhaseReport("push", true);
  }
  static pull(): PhaseReport {
    return new PhaseReport("pull", true);
  }
  /** A full pull-then-push cycle (`rbox sync`): both legs accumulate into one report. */
  static sync(): PhaseReport {
    return new PhaseReport("sync", true);
  }
  /** The no-op report used on the daemon hot path: runs wrapped work, records nothing.
   *  A shared per-op singleton, so `deps.report ?? PhaseReport.disabled(...)` costs no
   *  allocation on a no-op tick (§35) — safe to share because a disabled report
   *  accumulates nothing: phase()/record()/recordDetails() early-return, and the
   *  files/blobs field scribbles callers make are only ever read from enabled reports. */
  static disabled(op: "push" | "pull" | "sync" = "push"): PhaseReport {
    return PhaseReport.DISABLED[op];
  }

  private static readonly DISABLED = {
    push: new PhaseReport("push", false),
    pull: new PhaseReport("pull", false),
    sync: new PhaseReport("sync", false),
  } as const;

  /** Emit the one-line summary to `sink`, but ONLY if at least one phase was recorded —
   *  so a run that did no work (e.g. a no-op push tick) logs nothing. */
  logSummaryTo(sink: (line: string) => void): void {
    if (this.phases.size > 0) sink(this.summaryLine());
  }

  /** Time an async phase, attributing its wall time to `name`. ALWAYS runs `fn` (so a
   *  disabled report is transparent); only accumulates when enabled. Bytes/counts for the
   *  phase are attributed separately via {@link record} (they aren't known until `fn` runs). */
  async phase<T>(name: PhaseName, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    const t0 = Date.now();
    const gap = t0 - this.lastBoundaryAt;
    if (gap > 0) {
      const key = `${this.lastPhase}→${name}`;
      this.gaps.set(key, (this.gaps.get(key) ?? 0) + gap);
    }
    try {
      return await fn();
    } finally {
      this.lastBoundaryAt = Date.now();
      this.lastPhase = name;
      this.bump(name, this.lastBoundaryAt - t0);
      this.sampleRss();
    }
  }

  /** Accumulate bytes/counts to a phase without timing (e.g. a byte total learned after
   *  the fact, or a phase timed elsewhere). No-op when disabled. */
  record(name: PhaseName, bytes: PhaseBytes): void {
    if (!this.enabled) return;
    this.bump(name, 0, bytes);
  }

  /** Attach path-free, hash-free details to a phase. `summary` is appended to the
   * greppable one-line report; callers own keeping it privacy-preserving. */
  recordDetails<T extends object>(name: PhaseName, details: T & PhaseDetailInput<T>, summary?: string): void {
    if (!this.enabled) return;
    const t = this.ensure(name);
    t.details = { ...(t.details ?? {}), ...details } as PhaseDetails;
    if (summary) this.phaseSummaries.set(name, summary);
  }

  /** Merge detail and append a summary fragment without replacing existing phase text. */
  appendDetails<T extends object>(name: PhaseName, details: T & PhaseDetailInput<T>, summary?: string): void {
    if (!this.enabled) return;
    const t = this.ensure(name);
    t.details = { ...(t.details ?? {}), ...details } as PhaseDetails;
    if (summary) {
      const existing = this.phaseSummaries.get(name);
      this.phaseSummaries.set(name, existing ? `${existing} ${summary}` : summary);
    }
  }

  private bump(name: PhaseName, ms: number, bytes?: PhaseBytes): void {
    const t = this.ensure(name);
    t.ms += ms;
    t.count += bytes?.count ?? 0;
    t.plaintextBytes += bytes?.plaintextBytes ?? 0;
    t.ciphertextBytes += bytes?.ciphertextBytes ?? 0;
    t.wireBytes += bytes?.wireBytes ?? 0;
    t.changedBytes += bytes?.changedBytes ?? 0;
  }

  private ensure(name: PhaseName): PhaseTotals {
    let t = this.phases.get(name);
    if (!t) {
      t = zeroTotals();
      this.phases.set(name, t);
    }
    return t;
  }

  private sampleRss(): void {
    if (!this.enabled) return;
    const { rss } = process.memoryUsage();
    if (rss > this.peakRss) this.peakRss = rss;
  }

  toJSON(): PhaseReportJson {
    const phases: Partial<Record<PhaseName, PhaseTotals>> = {};
    for (const name of PHASE_ORDER) {
      const t = this.phases.get(name);
      if (t) phases[name] = t;
    }
    return {
      op: this.op,
      wallMs: Date.now() - this.startedAt,
      files: this.files,
      blobs: this.blobs,
      peakRssBytes: this.peakRss,
      phases,
      gaps: Object.fromEntries(this.gaps),
      tailMs: this.phases.size > 0 ? Date.now() - this.lastBoundaryAt : 0,
    };
  }

  /** One greppable line, e.g.:
   *  `rbox push files=65421 blobs=11925 ct=2.68GB wire=2.68GB changed=2.68GB 192.4s | scan 3.1s encrypt 41.2s upload 144.0s commit 0.9s | rss 812MB`
   *  Run byte totals are a plain sum across phases (each basis is attributed to one phase). */
  summaryLine(): string {
    let ct = 0;
    let wire = 0;
    let changed = 0;
    const parts: string[] = [];
    for (const name of PHASE_ORDER) {
      const t = this.phases.get(name);
      if (!t) continue;
      ct += t.ciphertextBytes;
      wire += t.wireBytes;
      changed += t.changedBytes;
      const detail = this.phaseSummaries.get(name);
      parts.push(`${name} ${fmtMs(t.ms)}${detail ? ` ${detail}` : ""}`);
    }
    const wallMs = Date.now() - this.startedAt;
    // Gaps ≥100ms keep unwrapped work visible on the greppable line without noise.
    const gapParts = [...this.gaps.entries()]
      .filter(([, ms]) => ms >= 100)
      .map(([key, ms]) => `${key} ${fmtMs(ms)}`);
    const tailMs = this.phases.size > 0 ? Date.now() - this.lastBoundaryAt : 0;
    if (tailMs >= 100) gapParts.push(`${this.lastPhase}→end ${fmtMs(tailMs)}`);
    const gapSection = gapParts.length > 0 ? ` | gaps ${gapParts.join(" ")}` : "";
    const head = `rbox ${this.op} files=${this.files} blobs=${this.blobs} ct=${fmtBytes(ct)} wire=${fmtBytes(wire)} changed=${fmtBytes(changed)} ${fmtMs(wallMs)}`;
    return `${head} | ${parts.join(" ")}${gapSection} | rss ${fmtBytes(this.peakRss)}`;
  }
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
  return `${n}B`;
}
