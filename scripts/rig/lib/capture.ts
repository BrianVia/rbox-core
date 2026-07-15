/**
 * P1 observability capture (design 56 §10). A {@link RunCapture} is created by
 * `runScenario` BEFORE the scenario runs and finalized in a `finally` — so its
 * artifacts exist even when a scenario aborts. Every channel is INDEPENDENTLY
 * best-effort: stats sampler, `wrangler tail`, the Analytics Engine query, and the
 * device-file harvest each land as data OR a `skipped: <reason>` marker; none can
 * fail the run. The scenario verdict comes only from the scenario's own steps.
 *
 * The summarizers (`summarizeStats`, `summarizeTail`, `summarizeServerMetrics`) and
 * the AE SQL builder are PURE and unit-tested; the class body owns the I/O.
 */
import fs from "node:fs";
import path from "node:path";
import * as C from "./container.js";
import { daemonLogHarvestScript, type Device } from "./device.js";

// ── pure summarizers ─────────────────────────────────────────────────────────

/** A channel result is either its summary payload or a skip marker. */
export type Skippable<T> = T | { skipped: string };
export function isSkipped<T>(v: Skippable<T>): v is { skipped: string } {
  return typeof v === "object" && v !== null && "skipped" in v;
}

type Raw = Record<string, unknown>;

/** First finite numeric value among the given keys (accepts numeric strings). */
function num(o: Raw, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export interface StatSummary {
  peakMemMB: number;
  cpuCoreSecondsTotal: number;
  peakCpuPct: number;
  samples: number;
}

/**
 * Reduce a device's 2s stats series. `cpuUsageUsec` is CUMULATIVE, so per-interval
 * CPU% is (ΔcpuUsageUsec / ΔwallUsec) × 100 — core-% that can exceed 100 on a
 * multi-cpu guest (reported as-is). A negative Δ (counter reset) skips that interval
 * but re-baselines; a single-sample series yields zero CPU (no interval to measure).
 * PURE.
 */
export function summarizeStats(samples: Array<Raw & { ts?: unknown }>): StatSummary {
  let peakMem = 0;
  let coreSeconds = 0;
  let peakPct = 0;
  let prevCpu: number | undefined;
  let prevWallUsec: number | undefined;
  for (const s of samples) {
    const mem = num(s, "memoryUsageBytes", "memory_usage_bytes", "memoryUsage");
    if (mem !== undefined) peakMem = Math.max(peakMem, mem);
    const cpu = num(s, "cpuUsageUsec", "cpu_usage_usec", "cpuUsage");
    const tsMs = Date.parse(String(s.ts));
    const wallUsec = Number.isFinite(tsMs) ? tsMs * 1000 : undefined;
    if (cpu !== undefined && wallUsec !== undefined) {
      if (prevCpu !== undefined && prevWallUsec !== undefined) {
        const dCpu = cpu - prevCpu;
        const dWall = wallUsec - prevWallUsec;
        if (dCpu >= 0 && dWall > 0) {
          coreSeconds += dCpu / 1e6;
          peakPct = Math.max(peakPct, (dCpu / dWall) * 100);
        }
        // dCpu < 0 → counter reset → skip this interval (but re-baseline below)
      }
      prevCpu = cpu;
      prevWallUsec = wallUsec;
    }
  }
  return { peakMemMB: peakMem / (1024 * 1024), cpuCoreSecondsTotal: coreSeconds, peakCpuPct: peakPct, samples: samples.length };
}

export interface TailSummary {
  total: number;
  errors: number;
  waf403s: number;
}

/** HTTP status of a wrangler-tail event, probing the known shapes defensively. */
function tailStatus(ev: Raw): number | undefined {
  const event = ev.event as Raw | undefined;
  const response = (event?.response ?? ev.response) as Raw | undefined;
  const s = num((response ?? {}) as Raw, "status") ?? num(ev, "status");
  return s;
}

/**
 * Classify one tail event as an error: a non-"ok" outcome, a non-empty exceptions
 * array, or a logged 5xx response. PURE helper for {@link summarizeTail}.
 */
function isTailError(ev: Raw): boolean {
  const outcome = ev.outcome;
  if (typeof outcome === "string" && outcome !== "ok") return true;
  const exceptions = ev.exceptions;
  if (Array.isArray(exceptions) && exceptions.length > 0) return true;
  const status = tailStatus(ev);
  if (status !== undefined && status >= 500) return true;
  return false;
}

/**
 * Extract every top-level JSON object from a blob, tolerant of BOTH newline-
 * delimited AND pretty-printed-and-concatenated output. `wrangler tail --format
 * json` (v4) pretty-prints each event across many lines, so a per-line JSON.parse
 * would fail — this brace-depth scanner (string/escape aware) recovers the objects
 * either way. PURE.
 */
export function splitJsonObjects(text: string): Raw[] {
  const objs: Raw[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(text.slice(start, i + 1)) as Raw);
        } catch {
          /* not a complete/valid object — skip */
        }
        start = -1;
      }
    }
  }
  return objs;
}

/** Tally wrangler-tail events: total events, error events, and 403s (the design-34
 *  WAF signal). Accepts raw text or pre-split lines; only complete JSON objects
 *  count. PURE. */
export function summarizeTail(input: string | string[]): TailSummary {
  const text = Array.isArray(input) ? input.join("\n") : input;
  let total = 0;
  let errors = 0;
  let waf403s = 0;
  for (const ev of splitJsonObjects(text)) {
    total++;
    if (isTailError(ev)) errors++;
    if (tailStatus(ev) === 403) waf403s++;
  }
  return { total, errors, waf403s };
}

/** UTC `YYYY-MM-DD HH:MM:SS` — the Analytics Engine `toDateTime` literal format. PURE. */
export function fmtAeTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Build the AE aggregate over the run window (start − 30s … end + 60s). PURE. */
export function buildAeSql(runStart: Date, runEnd: Date): string {
  const start = fmtAeTime(new Date(runStart.getTime() - 30_000));
  const end = fmtAeTime(new Date(runEnd.getTime() + 60_000));
  return [
    "SELECT blob1 AS op, blob3 AS outcome, count() AS n,",
    "       avg(double1) AS avg_ms, max(double1) AS max_ms,",
    "       sum(double5) AS bytes, sum(double8) AS db_calls",
    "FROM rbox_dev_metrics",
    `WHERE timestamp >= toDateTime('${start}') AND timestamp <= toDateTime('${end}')`,
    "GROUP BY op, outcome ORDER BY n DESC",
  ].join("\n");
}

export interface AeRow {
  op?: unknown;
  outcome?: unknown;
  n?: unknown;
  avg_ms?: unknown;
  max_ms?: unknown;
}

export interface ServerMetricsSummary {
  totalOps: number;
  errorOps: number;
  topOps: Array<{ op: string; outcome: string; n: number; avgMs: number }>;
}

/**
 * An outcome is an error unless it's "ok" or a 2xx/3xx HTTP status. The `request`
 * op stores the HTTP status as its outcome (e.g. "200"), so a naive `!== "ok"` would
 * miscount every success — hence the numeric-status carve-out. Named non-ok outcomes
 * (conflict, exception, sha_mismatch, …) count as errors. PURE.
 */
export function isErrorOutcome(outcome: string): boolean {
  if (outcome === "" || outcome === "ok") return false;
  const n = Number(outcome);
  if (Number.isFinite(n)) return n >= 400; // HTTP status: 2xx/3xx success, 4xx/5xx error
  return true;
}

/** Summarize AE rows: total ops (Σn), error-outcome ops, and the top 3 by n. PURE. */
export function summarizeServerMetrics(rows: AeRow[]): ServerMetricsSummary {
  let totalOps = 0;
  let errorOps = 0;
  const shaped = rows.map((r) => ({
    op: String(r.op ?? ""),
    outcome: String(r.outcome ?? ""),
    n: Number(r.n ?? 0) || 0,
    avgMs: Number(r.avg_ms ?? 0) || 0,
  }));
  for (const r of shaped) {
    totalOps += r.n;
    if (isErrorOutcome(r.outcome)) errorOps += r.n;
  }
  const topOps = [...shaped].sort((a, b) => b.n - a.n).slice(0, 3);
  return { totalOps, errorOps, topOps };
}

// ── capture summary (consumed by report rendering) ───────────────────────────

export interface CaptureSummary {
  statsA: Skippable<StatSummary>;
  statsB: Skippable<StatSummary>;
  tail: Skippable<TailSummary>;
  ae: Skippable<ServerMetricsSummary>;
  /** Relative filenames present in the run dir (the artifact index). */
  artifacts: string[];
}

// ── the impure lifecycle ─────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 2000;
const WRANGLER_WORKER = "rbox-dev-api";
const AE_DATASET = "rbox_dev_metrics";
/** Analytics Engine has an ingestion delay — a query issued seconds after the
 *  events lands 0 rows. Poll on this schedule (ms since finish) until rows appear,
 *  giving up after the last delay so a genuinely-empty window still returns. */
const AE_POLL_DELAYS_MS = [2000, 13000, 15000, 15000, 15000];

export interface CaptureDeps {
  runDir: string;
  repoRoot: string;
  names: { a: string; b: string };
  devices: { a: Device; b: Device };
  /** Guest workspace dir (holds `.rbox/state/metrics.json`). */
  workDir: string;
  /** Guest rbox home (holds per-workspace daily streams and crash sinks). */
  rboxHome: string;
  env: NodeJS.ProcessEnv;
  /** Status line → run.log + console (the ctx logger). */
  log: (line: string) => void;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class RunCapture {
  private runStart = new Date();
  private runEnd = new Date();
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private statsInFlight: Promise<void> = Promise.resolve();
  private statsSkipped: string | undefined;

  private tailHandle: C.StreamHandle | undefined;
  private tailSink: Bun.FileSink | undefined;
  private tailLines = 0;
  private tailStderr: string[] = [];
  private tailExitedEarly = false;
  private tailSkipped: string | undefined;

  constructor(private readonly deps: CaptureDeps) {}

  private p(name: string): string {
    return path.join(this.deps.runDir, name);
  }

  /** Begin the stats sampler + server tail. Never throws. */
  start(): void {
    this.runStart = new Date();
    this.startStatsSampler();
    this.startServerTail();
  }

  // ── stats sampler ──────────────────────────────────────────────────────────

  private startStatsSampler(): void {
    const tick = () => {
      this.statsInFlight = this.sampleStatsOnce();
    };
    tick(); // one immediate sample so short runs still capture a series
    this.statsTimer = setInterval(tick, SAMPLE_INTERVAL_MS);
  }

  private async sampleStatsOnce(): Promise<void> {
    const ts = new Date().toISOString();
    try {
      const raw = await C.containerStats([this.deps.names.a, this.deps.names.b]);
      const list = (Array.isArray(raw) ? raw : [raw]).filter((o): o is Raw => typeof o === "object" && o !== null);
      this.appendStatSample("a", this.deps.names.a, list, ts, 0);
      this.appendStatSample("b", this.deps.names.b, list, ts, 1);
    } catch (e) {
      if (!this.statsSkipped) this.statsSkipped = msg(e);
    }
  }

  /** Append the object matching `name` (or positional fallback) to stats-<x>.jsonl. */
  private appendStatSample(label: "a" | "b", name: string, list: Raw[], ts: string, positional: number): void {
    let match = list.find((o) => JSON.stringify(o).includes(name));
    if (!match && list.length === 2) match = list[positional];
    if (!match) return;
    fs.appendFileSync(this.p(`stats-${label}.jsonl`), JSON.stringify({ ts, ...match }) + "\n");
  }

  private async stopStatsSampler(): Promise<void> {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    await this.statsInFlight.catch(() => {});
  }

  // ── server tail ─────────────────────────────────────────────────────────────

  private startServerTail(): void {
    try {
      this.tailSink = Bun.file(this.p("server-tail.jsonl")).writer();
      this.tailHandle = C.spawnStream(["bunx", "wrangler", "tail", WRANGLER_WORKER, "--format", "json"], {
        cwd: path.join(this.deps.repoRoot, "apps", "api"),
        onStdout: (line) => {
          if (!this.tailSink) return;
          this.tailSink.write(line + "\n");
          void this.tailSink.flush();
          this.tailLines++;
        },
        onStderr: (line) => {
          if (this.tailStderr.length < 20) this.tailStderr.push(line);
        },
      });
      // If wrangler exits on its own (auth prompt, bad config, immediate error) it
      // never gets to tail the run window → mark the channel skipped.
      void this.tailHandle.exited.then((code) => {
        if (!this.tailStopped) {
          this.tailExitedEarly = true;
          this.tailSkipped = `wrangler tail exited early (code ${code})${this.tailStderr.length ? `: ${this.tailStderr.slice(-3).join(" / ").slice(0, 200)}` : ""}`;
        }
      });
    } catch (e) {
      this.tailSkipped = `wrangler tail failed to spawn: ${msg(e)}`;
    }
  }

  private tailStopped = false;
  private async stopServerTail(): Promise<void> {
    this.tailStopped = true;
    if (this.tailHandle && !this.tailExitedEarly) {
      try {
        this.tailHandle.kill("SIGTERM");
        await Promise.race([this.tailHandle.exited, new Promise((r) => setTimeout(r, 3000))]);
      } catch {
        /* best-effort */
      }
    }
    try {
      await this.tailSink?.end();
    } catch {
      /* best-effort */
    }
  }

  // ── finish ───────────────────────────────────────────────────────────────────

  /** Stop capture, harvest device files, run the AE query, and return the summary
   *  report rendering consumes. Never throws — every failure becomes a skip marker. */
  async finish(): Promise<CaptureSummary> {
    this.runEnd = new Date();
    await this.stopStatsSampler();
    await this.stopServerTail();

    await this.harvestDevice("a", this.deps.devices.a);
    await this.harvestDevice("b", this.deps.devices.b);

    const ae = await this.runAeQuery();
    const statsA = this.summarizeStatsFile("a");
    const statsB = this.summarizeStatsFile("b");
    const tail = this.summarizeTailChannel();
    const artifacts = this.listArtifacts();
    return { statsA, statsB, tail, ae, artifacts };
  }

  private summarizeStatsFile(label: "a" | "b"): Skippable<StatSummary> {
    if (this.statsSkipped) return { skipped: this.statsSkipped };
    const file = this.p(`stats-${label}.jsonl`);
    if (!fs.existsSync(file)) return { skipped: "no stats samples captured" };
    const samples: Array<Raw & { ts?: unknown }> = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        samples.push(JSON.parse(t) as Raw);
      } catch {
        /* skip malformed */
      }
    }
    if (samples.length === 0) return { skipped: "no stats samples captured" };
    return summarizeStats(samples);
  }

  private summarizeTailChannel(): Skippable<TailSummary> {
    if (this.tailSkipped) return { skipped: this.tailSkipped };
    const file = this.p("server-tail.jsonl");
    if (!fs.existsSync(file)) return { skipped: "no server-tail.jsonl" };
    return summarizeTail(fs.readFileSync(file, "utf8"));
  }

  // ── device harvest ───────────────────────────────────────────────────────────

  private async harvestDevice(label: "a" | "b", device: Device): Promise<void> {
    // metrics.json — always write a file so the run-dir layout is complete even
    // when the one-shot scenario never spun up the daemon that writes it.
    try {
      const metrics = await device.readFileIfExists(`${this.deps.workDir}/.rbox/state/metrics.json`);
      fs.writeFileSync(this.p(`metrics-${label}.json`), metrics ?? JSON.stringify({ present: false, reason: "no .rbox/state/metrics.json in guest (no daemon ran)" }, null, 2) + "\n");
    } catch (e) {
      fs.writeFileSync(this.p(`metrics-${label}.json`), JSON.stringify({ present: false, reason: msg(e) }, null, 2) + "\n");
    }
    // Daemon logs — ordered daily streams plus the concurrent crash sink, with
    // separators retained in the artifact so rollover and runtime failures coexist.
    try {
      const script = daemonLogHarvestScript(this.deps.rboxHome);
      const out = await device.exec(["sh", "-c", script], { allowFail: true });
      const body = out.stdout.trim();
      fs.writeFileSync(this.p(`daemon-${label}.log`), body ? out.stdout : "(no daemon logs found — P2 daemon scenarios will populate this)\n");
    } catch (e) {
      fs.writeFileSync(this.p(`daemon-${label}.log`), `(daemon-log harvest failed: ${msg(e)})\n`);
    }
  }

  // ── AE query ─────────────────────────────────────────────────────────────────

  private async runAeQuery(): Promise<Skippable<ServerMetricsSummary>> {
    const account = this.deps.env.CLOUDFLARE_ACCOUNT_ID;
    const token = this.deps.env.CLOUDFLARE_API_TOKEN;
    if (!account || !token) {
      return { skipped: `CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN absent (dataset ${AE_DATASET})` };
    }
    const sql = buildAeSql(this.runStart, this.runEnd);
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;
    try {
      // Poll through the ingestion delay: stop as soon as rows land, else keep the
      // last (possibly empty) response so a genuinely-empty window still reports.
      let parsed: { data?: AeRow[] } = { data: [] };
      for (let i = 0; i < AE_POLL_DELAYS_MS.length; i++) {
        await new Promise((r) => setTimeout(r, AE_POLL_DELAYS_MS[i]));
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
          body: sql,
        });
        const text = await res.text();
        if (!res.ok) {
          if (i === 0) return { skipped: `AE query ${res.status}: ${text.slice(0, 200)}` };
          break; // transient failure after a good first response — keep what we have
        }
        parsed = JSON.parse(text) as { data?: AeRow[] };
        if ((parsed.data ?? []).length > 0) break;
        if (i === 0) this.deps.log("  waiting for Analytics Engine ingestion…");
      }
      const rows = parsed.data ?? [];
      fs.writeFileSync(this.p("server-metrics.json"), JSON.stringify(parsed, null, 2));
      return summarizeServerMetrics(rows);
    } catch (e) {
      return { skipped: `AE query failed: ${msg(e)}` };
    }
  }

  // ── artifact index ────────────────────────────────────────────────────────────

  private listArtifacts(): string[] {
    try {
      return fs.readdirSync(this.deps.runDir).sort();
    } catch {
      return [];
    }
  }
}
