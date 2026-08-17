/**
 * A `Device` is a handle to one running guest (`rig-dev-a`/`-b`). Everything a
 * scenario does to a device — run the rbox CLI, read/write a file, seed a corpus —
 * goes through here, built entirely on container.ts (no direct spawns).
 *
 * The image's `rbox` executable is a source-mode shim by default. A rig binary
 * override bind-mounts the compiled candidate over that same fixed path, so all
 * scenario call sites exercise one exact surface without branching.
 */
import { exec, killContainer, startContainer, type RunResult } from "./container.js";
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
 * ≥20 all-lowercase words = a BIP39 phrase; a dot-joined pair of long base64url
 * halves anywhere in the line = a `<redeemToken>.<tokenSecret>` pairing token. Corpus
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
      const pairingToken = t.match(/(?:rbox-pair_)?[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}/)?.[0];
      if (pairingToken) {
        return line.replace(pairingToken, "*** [pairing token redacted] ***");
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
 * Classify the combined daemon streams into their watcher mode (design 56 §9: "if the guest
 * watcher degrades to polling, that's FINE — log the mode"). Native @parcel/watcher
 * announces plain `rbox daemon ready`; the fallback logs `live watch unavailable …
 * degrading to periodic scan` / `periodic-scan mode`. PURE.
 */
export function daemonWatcherMode(log: string): "native" | "polling" | "unknown" {
  if (/live watch unavailable|periodic-scan mode|periodic scan every/i.test(log)) return "polling";
  if (/rbox daemon ready/i.test(log)) return "native";
  return "unknown";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** One stable argv surface for both the source shim and a mounted candidate. */
export function rboxGuestArgv(args: readonly string[]): string[] {
  return [GUEST.cliExecutable, ...args];
}

export function detachedPushScript(logPath: string): string {
  return `nohup ${GUEST.cliExecutable} push >${shellQuote(logPath)} 2>&1 & echo "detached pid $!"`;
}

/** Launch an arbitrary `rbox <args>` DETACHED, redirecting stdout+stderr to
 *  `logPath`, and echo its pid. Used by the 189 web-pairing scenario to run the
 *  blocking device-code `rbox login` in the background while the rig approves it. */
export function detachedRboxScript(args: readonly string[], logPath: string): string {
  const cmd = args.map(shellQuote).join(" ");
  return `nohup ${GUEST.cliExecutable} ${cmd} >${shellQuote(logPath)} 2>&1 & echo "detached pid $!"`;
}

/**
 * Build the guest-side collector shared by watcher classification and run-artifact
 * capture. Each runtime contributes calendar-valid daily files in filename order,
 * followed by its concurrent crash sink; source markers keep the channels distinct.
 */
export function daemonLogHarvestScript(rboxHome: string): string {
  const daemons = shellQuote(`${rboxHome}/daemons`);
  return [
    `for dir in ${daemons}/*; do`,
    `  [ -d "$dir" ] || continue`,
    `  find "$dir" -maxdepth 1 -type f -name 'daemon-????-??-??.log' -print | LC_ALL=C sort | while IFS= read -r f; do`,
    `    base=${"$(basename \"$f\")"}`,
    `    day=${"${base#daemon-}"}; day=${"${day%.log}"}`,
    `    case "$base" in daemon-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log) ;; *) continue ;; esac`,
    `    [ "$(date -u -d "$day" +%F 2>/dev/null)" = "$day" ] || continue`,
    `    printf '\\342\\224\\200\\342\\224\\200 %s \\342\\224\\200\\342\\224\\200\\n' "$f"`,
    `    cat "$f"`,
    `  done`,
    `  crash="$dir/daemon.log"`,
    `  if [ -f "$crash" ]; then`,
    `    printf '\\342\\224\\200\\342\\224\\200 %s (crash sink) \\342\\224\\200\\342\\224\\200\\n' "$crash"`,
    `    cat "$crash"`,
    `  fi`,
    `done`,
  ].join("\n");
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

  /** `rbox <args>` with RBOX_API + RBOX_METRICS + RBOX_DIAGNOSTICS
   *  injected (diagnostics ships OFF for users; the bench keeps the real upload path
   *  continuously exercised — design 56 §10 V4). */
  async rbox(args: string[], opts: RboxOpts = {}): Promise<RunResult> {
    return this.runRecorded(`rbox ${args.join(" ")}`, rboxGuestArgv(args), opts);
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
    const env = { RBOX_API: this.apiUrl, RBOX_METRICS: "1", RBOX_DIAGNOSTICS: "1", ...opts.env };
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
   *  scenario failure). `args` passes start flags through (design 272 §7:
   *  `--pull-only` is the only way to exercise the FM shape in CI). */
  async daemonStart(workDir: string, env?: Record<string, string>, args: readonly string[] = []): Promise<RunResult> {
    return this.rbox(["start", ...args], { cwd: workDir, env });
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

  // ── chaos-restart (design 56 §9) ─────────────────────────────────────────────

  /**
   * Start `rbox push` DETACHED in the guest and return immediately — the push keeps
   * running after this exec session ends. `nohup … &` orphans the CLI (reparented to
   * the guest's init) with its stdout+stderr redirected to `logPath`, so nothing rides
   * the exec pipe and `container exec` returns as soon as the launcher shell exits.
   * RBOX_API + RBOX_METRICS are injected (as {@link rbox} does); `env` layers on
   * per-run knobs (e.g. a throttled RBOX_UPLOAD_CONCURRENCY to widen the push window).
   * The chaos-restart scenario polls `logPath` for upload progress, then hard-kills the
   * guest mid-push. Throws only if the LAUNCHER fails — the push's own exit is observed
   * via the log + a foreground resume, never here.
   */
  async pushDetached(workDir: string, logPath: string, env: Record<string, string> = {}): Promise<void> {
    const script = detachedPushScript(logPath);
    await this.exec(["sh", "-c", script], { cwd: workDir, env: { RBOX_API: this.apiUrl, RBOX_METRICS: "1", RBOX_DIAGNOSTICS: "1", ...env } });
  }

  /**
   * Start `rbox <args>` DETACHED in the guest (nohup, stdout+stderr → `logPath`) and
   * return its pid. The process keeps running after this exec returns — the caller
   * polls `logPath` for progress (e.g. the device-code approval URL, then the enroll
   * result) and stops it with {@link killPid}. RBOX_API + RBOX_METRICS are injected.
   */
  async spawnRboxDetached(args: string[], logPath: string, opts: RboxOpts = {}): Promise<number> {
    const script = detachedRboxScript(args, logPath);
    const res = await this.exec(["sh", "-c", script], {
      cwd: opts.cwd,
      env: { RBOX_API: this.apiUrl, RBOX_METRICS: "1", RBOX_DIAGNOSTICS: "1", ...opts.env },
      redact: opts.redact,
    });
    const pid = res.stdout.match(/detached pid (\d+)/)?.[1];
    if (!pid) throw new Error(`could not read detached rbox pid from ${JSON.stringify(res.stdout.slice(0, 120))}`);
    return Number(pid);
  }

  /** Best-effort `kill <pid>` in the guest (tolerates an already-exited process). */
  async killPid(pid: number): Promise<void> {
    await this.exec(["kill", String(pid)], { allowFail: true });
  }

  /**
   * SIGKILL this guest's container — a crash, no grace (see container.killContainer).
   * The container config + writable layer survive; {@link restart} brings the same guest
   * back. Returns false if it was already stopped/absent.
   */
  async hardKill(): Promise<boolean> {
    return killContainer(this.name);
  }

  /** `container start` this guest again after a {@link hardKill} (idempotent). */
  async restart(): Promise<void> {
    await startContainer(this.name);
  }

  /**
   * Poll a trivial `true` exec until the restarted guest accepts commands (or
   * `timeoutMs` elapses). After a kill+start the guest's procs are fresh and exec may
   * briefly refuse; this waits for exec-ability before the scenario resumes. Returns
   * true once an exec exits 0.
   */
  async waitExecReady(timeoutMs: number, intervalMs = 500): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      const r = await this.exec(["true"], { allowFail: true });
      if (r.exitCode === 0) return true;
      if (Date.now() - start >= timeoutMs) return false;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
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
   * Concatenate every valid daily stream plus the crash sink in each guest runtime.
   * The daily files are read in calendar order. The startup line records the watcher
   * mode — native (`rbox daemon
   * ready`) vs the polling fallback (`… periodic scan every 60s` / `periodic-scan
   * mode`); {@link daemonWatcherMode} classifies it. Best-effort → "" on any failure.
   */
  async readDaemonLogs(rboxHome: string): Promise<string> {
    const script = daemonLogHarvestScript(rboxHome);
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
