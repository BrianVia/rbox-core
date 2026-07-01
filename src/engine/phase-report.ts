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

export type PhaseName = "scan" | "encrypt" | "upload" | "download" | "decrypt" | "apply" | "commit";

/** Stable display order for the summary line (and any tabular diff). */
const PHASE_ORDER: readonly PhaseName[] = ["scan", "encrypt", "upload", "commit", "download", "decrypt", "apply"];

export interface PhaseTotals {
  ms: number;
  count: number; // items processed in this phase (blobs/files) — for per-item rates
  plaintextBytes: number;
  ciphertextBytes: number;
  wireBytes: number;
  changedBytes: number;
}

/** Bytes/counts to attribute to a phase. All optional; a phase sets only what it moves. */
export interface PhaseBytes {
  count?: number;
  plaintextBytes?: number;
  ciphertextBytes?: number;
  wireBytes?: number;
  changedBytes?: number;
}

export interface PhaseReportJson {
  op: "push" | "pull";
  wallMs: number;
  files: number;
  blobs: number;
  peakRssBytes: number;
  phases: Partial<Record<PhaseName, PhaseTotals>>;
}

function zeroTotals(): PhaseTotals {
  return { ms: 0, count: 0, plaintextBytes: 0, ciphertextBytes: 0, wireBytes: 0, changedBytes: 0 };
}

export class PhaseReport {
  readonly enabled: boolean;
  files = 0;
  blobs = 0;
  private readonly op: "push" | "pull";
  private readonly startedAt: number;
  private readonly phases = new Map<PhaseName, PhaseTotals>();
  private peakRss = 0;

  private constructor(op: "push" | "pull", enabled: boolean) {
    this.op = op;
    this.enabled = enabled;
    this.startedAt = Date.now();
    this.sampleRss();
  }

  static push(): PhaseReport {
    return new PhaseReport("push", true);
  }
  static pull(): PhaseReport {
    return new PhaseReport("pull", true);
  }
  /** The no-op report used on the daemon hot path: runs wrapped work, records nothing. */
  static disabled(op: "push" | "pull" = "push"): PhaseReport {
    return new PhaseReport(op, false);
  }

  /** Time an async phase, attributing its wall time + bytes to `name`. ALWAYS runs `fn`
   *  (so a disabled report is transparent); only accumulates when enabled. */
  async phase<T>(name: PhaseName, fn: () => Promise<T>, bytes?: PhaseBytes): Promise<T> {
    if (!this.enabled) return fn();
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.bump(name, Date.now() - t0, bytes);
      this.sampleRss();
    }
  }

  /** Accumulate bytes/counts to a phase without timing (e.g. a byte total learned after
   *  the fact, or a phase timed elsewhere). No-op when disabled. */
  record(name: PhaseName, bytes: PhaseBytes): void {
    if (!this.enabled) return;
    this.bump(name, 0, bytes);
  }

  private bump(name: PhaseName, ms: number, bytes?: PhaseBytes): void {
    let t = this.phases.get(name);
    if (!t) {
      t = zeroTotals();
      this.phases.set(name, t);
    }
    t.ms += ms;
    t.count += bytes?.count ?? 0;
    t.plaintextBytes += bytes?.plaintextBytes ?? 0;
    t.ciphertextBytes += bytes?.ciphertextBytes ?? 0;
    t.wireBytes += bytes?.wireBytes ?? 0;
    t.changedBytes += bytes?.changedBytes ?? 0;
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
      parts.push(`${name} ${fmtMs(t.ms)}`);
    }
    const wallMs = Date.now() - this.startedAt;
    const head = `rbox ${this.op} files=${this.files} blobs=${this.blobs} ct=${fmtBytes(ct)} wire=${fmtBytes(wire)} changed=${fmtBytes(changed)} ${fmtMs(wallMs)}`;
    return `${head} | ${parts.join(" ")} | rss ${fmtBytes(this.peakRss)}`;
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
