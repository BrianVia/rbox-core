/**
 * A `Device` is a handle to one running guest (`rig-dev-a`/`-b`). Everything a
 * scenario does to a device — run the rbox CLI, read/write a file, seed a corpus —
 * goes through here, built entirely on container.ts (no direct spawns).
 *
 * The rbox CLI inside a guest is `bun /app/src/cli/index.ts <args>` with
 * `RBOX_API` pointing at the resolved dev URL, so module resolution walks up to
 * the image's linux node_modules and the CLI can never reach prod (config.ts
 * already refused any prod URL before this device existed).
 */
import { exec, type RunResult } from "./container.js";
import { GUEST } from "./config.js";

export interface RboxOpts {
  env?: Record<string, string>;
  cwd?: string;
  /** Don't throw on a nonzero rbox exit — caller inspects the result. */
  allowFail?: boolean;
  /** Secret substrings to mask in any logged/thrown argv. */
  redact?: string[];
}

/**
 * Observability hooks (P1). When present, every rbox invocation's full
 * stdout+stderr is appended to `run.log` via {@link DeviceObs.transcript}, prefixed
 * `[A]`/`[B]` and indented — the firehose the compact console never shows.
 * `redact` masks the always-known secrets (bootstrap secret) in transcripts; a
 * per-call `redact` (pairing token) stacks on top.
 */
export interface DeviceObs {
  /** Short device label used as the transcript prefix, e.g. "A" / "B". */
  label: string;
  /** Append a block to run.log ONLY (never the console). */
  transcript: (text: string) => void;
  /** Always-redacted secret substrings (e.g. the bootstrap secret). */
  redact?: string[];
}

function redactAll(text: string, secrets: string[]): string {
  let s = text;
  for (const sec of secrets) if (sec) s = s.split(sec).join("***");
  return s;
}

/**
 * Mask secrets the CLI PRINTS ITSELF (unknowable to a redact list at call time):
 * the 24-word E2EE recovery phrase (`login --bootstrap`) and a freshly minted
 * pairing token (`rbox pair`). Both are line-shaped, so this scrubs whole lines:
 * ≥20 all-lowercase words = a BIP39 phrase; a single dot-joined pair of long
 * base64url halves = a `<redeemToken>.<tokenSecret>` pairing token. Corpus
 * filenames (`file0007.txt`) and pull summaries (`+b.txt`) can't match — their
 * post-dot half is too short. PURE (unit-tested). Transcript-only: the caller
 * still receives the real stdout (scenarios parse the token from it).
 */
export function scrubSelfPrinted(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      const words = t.split(/\s+/);
      if (words.length >= 20 && words.every((w) => /^[a-z]+$/.test(w))) {
        return line.replace(t, "*** [recovery phrase redacted] ***");
      }
      if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}$/.test(t)) {
        return line.replace(t, "*** [pairing token redacted] ***");
      }
      return line;
    })
    .join("\n");
}

/** Loosely-typed view of the daemon's `.rbox/state/activity.json` sidecar — the
 *  rig only reads the heartbeat + halt slot (design 45). */
export interface GuestActivity {
  at?: string;
  halt?: { at: string; reason: string; count: number; op: string };
  lastPush?: { at: string; files: number; sequence: number };
  lastPull?: { at: string; writes: number; deletes: number; conflicts: number };
  active?: { at: string; phase: string; done: number; total: number };
}

/**
 * Classify a daemon.log body into its watcher mode (design 56 §9: "if the guest
 * watcher degrades to polling, that's FINE — log the mode"). Native @parcel/watcher
 * announces plain `rbox daemon ready`; the fallback logs `live watch unavailable …
 * degrading to periodic scan` / `periodic-scan mode`. PURE.
 */
export function daemonWatcherMode(log: string): "native" | "polling" | "unknown" {
  if (/live watch unavailable|periodic-scan mode|periodic scan every/i.test(log)) return "polling";
  if (/rbox daemon ready/i.test(log)) return "native";
  return "unknown";
}

export class Device {
  constructor(
    readonly name: string,
    private readonly apiUrl: string,
    private readonly obs?: DeviceObs
  ) {}

  /** Raw command in the guest. */
  async exec(cmd: string[], opts: RboxOpts & { stdin?: string } = {}): Promise<RunResult> {
    return exec({ name: this.name, cmd, env: opts.env, cwd: opts.cwd, stdin: opts.stdin, allowFail: opts.allowFail, redact: opts.redact });
  }

  /** `bun /app/src/cli/index.ts <args>` with RBOX_API + RBOX_METRICS injected. */
  async rbox(args: string[], opts: RboxOpts = {}): Promise<RunResult> {
    return this.runRecorded(`rbox ${args.join(" ")}`, ["bun", GUEST.cliEntry, ...args], opts);
  }

  /**
   * Run the rbox CLI through a shell so a secret can be passed by ENV EXPANSION
   * rather than argv — the secret reaches the CLI as `--flag "$VAR"` without ever
   * being a literal argument the rig assembles or logs. `env` carries the secret;
   * `redact` masks it in the rig's own error rendering.
   */
  async rboxShell(script: string, opts: RboxOpts = {}): Promise<RunResult> {
    return this.runRecorded(`sh -c: ${script}`, ["sh", "-c", script], opts);
  }

  /**
   * Shared rbox execution: injects RBOX_API + RBOX_METRICS, runs, and — when an
   * observability sink is wired — appends the full transcript to run.log before
   * re-raising a rich error on failure (so an aborting step still records what the
   * CLI printed). Semantics are preserved: a nonzero exit still throws unless the
   * caller passed `allowFail`.
   */
  private async runRecorded(desc: string, cmd: string[], opts: RboxOpts): Promise<RunResult> {
    const env = { RBOX_API: this.apiUrl, RBOX_METRICS: "1", ...opts.env };
    if (!this.obs) {
      return exec({ name: this.name, cmd, env, cwd: opts.cwd, allowFail: opts.allowFail, redact: opts.redact });
    }
    const res = await exec({ name: this.name, cmd, env, cwd: opts.cwd, allowFail: true, redact: opts.redact });
    const secrets = [...(this.obs.redact ?? []), ...(opts.redact ?? [])];
    this.obs.transcript(this.formatTranscript(desc, res, secrets));
    if (res.exitCode !== 0 && !opts.allowFail) {
      const tail = redactAll(res.stderr, secrets).trim().split("\n").slice(-8).join("\n");
      throw new Error(`[${this.obs.label}] ${redactAll(desc, secrets)} exited ${res.exitCode}\n${tail}`);
    }
    return res;
  }

  /** One indented `[label] …` transcript block: the redacted command, then its
   *  stdout/stderr bodies indented under it. */
  private formatTranscript(desc: string, res: RunResult, secrets: string[]): string {
    const label = this.obs!.label;
    const indent = (body: string) =>
      scrubSelfPrinted(redactAll(body, secrets))
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")
        .replace(/\s+$/, "");
    const lines = [`[${label}] ${redactAll(desc, secrets)}  (exit ${res.exitCode})`];
    if (res.stdout.trim()) lines.push(`    ── stdout ──`, indent(res.stdout));
    if (res.stderr.trim()) lines.push(`    ── stderr ──`, indent(res.stderr));
    return lines.join("\n");
  }

  /** `cat path`, tolerating absence (nonzero exit → undefined). */
  async readFileIfExists(path: string): Promise<string | undefined> {
    const r = await this.exec(["cat", path], { allowFail: true });
    return r.exitCode === 0 ? r.stdout : undefined;
  }

  async mkdirp(dir: string): Promise<void> {
    await this.exec(["mkdir", "-p", dir]);
  }

  async readFile(path: string): Promise<string> {
    return (await this.exec(["cat", path])).stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Write via stdin so arbitrary content never rides the argv.
    await this.exec(["sh", "-c", `cat > "${path}"`], { stdin: content });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.exec(["ln", "-s", target, linkPath]);
  }

  // ── daemon control (P2 — design 45/49 scenarios) ─────────────────────────────

  /** `rbox start` in `workDir` — spawns the detached background-sync daemon
   *  (design 45). Throws on nonzero exit (a daemon that won't start is a hard
   *  scenario failure). */
  async daemonStart(workDir: string): Promise<RunResult> {
    return this.rbox(["start"], { cwd: workDir });
  }

  /** `rbox stop` in `workDir` — SIGTERMs the daemon (graceful; never SIGKILL).
   *  Tolerant of "not running" (teardown calls it unconditionally). */
  async daemonStop(workDir: string): Promise<RunResult> {
    return this.rbox(["stop"], { cwd: workDir, allowFail: true });
  }

  /** `rbox status` in `workDir` — the folded-in daemon/health view. Best-effort. */
  async daemonStatus(workDir: string): Promise<RunResult> {
    return this.rbox(["status"], { cwd: workDir, allowFail: true });
  }

  /**
   * The daemon PROCESS's peak RSS in MB — `VmHWM` from `/proc/<pid>/status`
   * (high-water mark since spawn, kB). This is the number the idle memory budget
   * asserts on: guest-wide `memoryUsageBytes` includes page cache from any earlier
   * workload in the same VM and never deflates (Apple container ballooning), so it
   * can read ~800MB while the daemon sits at ~150MB. Undefined when no daemon runs.
   */
  async daemonPeakRssMb(): Promise<number | undefined> {
    const r = await this.exec(
      ["sh", "-c", 'pid=$(pgrep -f __daemon-run | head -1); if [ -n "$pid" ]; then awk \'/VmHWM/{print $2}\' "/proc/$pid/status"; fi'],
      { allowFail: true }
    );
    const kb = Number(r.stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : undefined;
  }

  /**
   * Read + parse `<workDir>/.rbox/state/activity.json` (design 45 — the daemon's
   * heartbeat/halt sidecar, mirrored to disk). Absent/corrupt → undefined. The
   * `halt` slot is the guard/health signal a scenario asserts on. Shape is read
   * loosely (the rig only inspects `at`/`halt`), never re-validating the CLI's schema.
   */
  async readActivity(workDir: string): Promise<GuestActivity | undefined> {
    const raw = await this.readFileIfExists(`${workDir}/.rbox/state/activity.json`);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as GuestActivity;
      return typeof parsed?.at === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Concatenate every `<rboxHome>/daemons/*​/daemon.log` in the guest (design 45
   * runtime dir). The startup line records the watcher mode — native (`rbox daemon
   * ready`) vs the polling fallback (`… periodic scan every 60s` / `periodic-scan
   * mode`); {@link daemonWatcherMode} classifies it. Best-effort → "" on any failure.
   */
  async readDaemonLogs(rboxHome: string): Promise<string> {
    const script = `for f in ${rboxHome}/daemons/*/daemon.log; do [ -f "$f" ] && cat "$f"; done`;
    const r = await this.exec(["sh", "-c", script], { allowFail: true });
    return r.exitCode === 0 ? r.stdout : "";
  }

  /**
   * Seed a deterministic corpus into `dir` using the in-repo generator
   * (`scripts/bench/corpus.ts`, stdlib-only → runs unchanged in the guest). Same
   * (shape, seed) → byte-identical tree; the shape deliberately includes empty and
   * duplicate-content files (design 56 §9 regression shapes).
   */
  async seedCorpus(dir: string, shape: string, seed: number): Promise<void> {
    await this.mkdirp(dir);
    await this.exec(["bun", GUEST.corpusEntry, dir, shape, String(seed)]);
  }
}
