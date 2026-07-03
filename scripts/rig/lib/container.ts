/**
 * The ONE module that shells out to Apple `container` (CLI v1.0.0). Every
 * invocation goes through {@link run}; nothing else in the rig spawns a process.
 * Typed helpers build argv, capture stdout/stderr, and throw rich errors (failing
 * argv + stderr tail) so a runtime failure names itself. Secret values passed via
 * `redact` are masked in any thrown/logged argv — the rig never prints a secret.
 *
 * Where `--format json` exists we parse it; we never scrape human tables. The one
 * exception is existence probing (`container ls`), whose JSON field names are not
 * stable pre-1.0 — there we match the namespaced (`rig-*`) name as a quoted token,
 * which cannot false-positive across the small, rig-owned name set.
 */
import { NAMES } from "./config.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOpts {
  /** Written to the child's stdin (then closed). */
  stdin?: string;
  /** Don't throw on a nonzero exit — the caller inspects `exitCode`. */
  allowFail?: boolean;
  /** Secret substrings to mask in any error/log rendering of the argv. */
  redact?: string[];
}

function redactArgv(argv: string[], secrets: string[] | undefined): string {
  let s = argv.join(" ");
  for (const sec of secrets ?? []) if (sec) s = s.split(sec).join("***");
  return s;
}

/** Low-level capture — the ONLY `Bun.spawn` in the rig. Both `container`
 *  invocations and doctor's host probes route through here so no spawn is scattered. */
async function spawnCapture(argv: string[], opts: RunOpts): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !opts.allowFail) {
    const tail = stderr.trim().split("\n").slice(-8).join("\n");
    throw new Error(`\`${redactArgv(argv, opts.redact)}\` exited ${exitCode}\n${tail}`);
  }
  return { stdout, stderr, exitCode };
}

/** Spawn `container <args...>`. The single choke point for the runtime. */
export async function run(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return spawnCapture(["container", ...args], opts);
}

/** Spawn a HOST tool (sw_vers/uname/bun/…) for doctor probes. Kept here so every
 *  `Bun.spawn` lives in one module; never used for `container` itself. */
export async function spawnHost(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  return spawnCapture(argv, opts);
}

// ── system ───────────────────────────────────────────────────────────────────

/** `container system status` — healthy iff it exits 0. */
export async function systemStatus(): Promise<{ healthy: boolean; raw: string }> {
  const r = await run(["system", "status"], { allowFail: true });
  return { healthy: r.exitCode === 0, raw: (r.stdout + r.stderr).trim() };
}

export async function systemStart(): Promise<void> {
  await run(["system", "start"]);
}

export async function version(): Promise<string> {
  const r = await run(["--version"], { allowFail: true });
  return (r.stdout || r.stderr).trim();
}

// ── images ───────────────────────────────────────────────────────────────────

/** True if an image tagged `tag` exists. Parses `image ls --format json`; falls
 *  back to a quoted-token match if the JSON shape is unexpected. */
export async function imageExists(tag: string): Promise<boolean> {
  const r = await run(["image", "ls", "--format", "json"], { allowFail: true });
  if (r.exitCode !== 0) return false;
  try {
    const rows = JSON.parse(r.stdout) as unknown[];
    return JSON.stringify(rows).includes(`"${tag}"`) || JSON.stringify(rows).includes(`${tag}:latest`);
  } catch {
    return r.stdout.includes(tag);
  }
}

export interface BuildSpec {
  tag: string;
  dockerfile: string;
  contextDir: string;
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
}

export async function buildImage(spec: BuildSpec): Promise<void> {
  const args = ["build", "-t", spec.tag, "-f", spec.dockerfile];
  for (const [k, v] of Object.entries(spec.buildArgs ?? {})) args.push("--build-arg", `${k}=${v}`);
  for (const [k, v] of Object.entries(spec.labels ?? {})) args.push("--label", `${k}=${v}`);
  args.push(spec.contextDir);
  await run(args);
}

export async function imageDelete(tag: string): Promise<boolean> {
  const r = await run(["image", "delete", tag], { allowFail: true });
  return r.exitCode === 0;
}

// ── network ──────────────────────────────────────────────────────────────────

export async function networkExists(name: string): Promise<boolean> {
  const r = await run(["network", "list", "--format", "json"], { allowFail: true });
  if (r.exitCode !== 0) return false;
  return r.stdout.includes(`"${name}"`);
}

export async function networkCreate(name: string): Promise<void> {
  await run(["network", "create", name]);
}

export async function networkDelete(name: string): Promise<boolean> {
  const r = await run(["network", "delete", name], { allowFail: true });
  return r.exitCode === 0;
}

// ── containers ───────────────────────────────────────────────────────────────

/** Existence probe across running+stopped. `ls` JSON field names aren't stable
 *  pre-1.0, so we match the rig's own quoted name — safe for the `rig-*` set. */
export async function containerExists(name: string): Promise<boolean> {
  const r = await run(["ls", "--all", "--format", "json"], { allowFail: true });
  if (r.exitCode !== 0) return false;
  return r.stdout.includes(`"${name}"`);
}

export interface CreateSpec {
  name: string;
  image: string;
  network: string;
  cpus: number;
  memory: string;
  /** Read-only bind mounts (host → guest). */
  mounts: Array<{ source: string; target: string; readonly?: boolean }>;
  env?: Record<string, string>;
  /** Overrides the image CMD when set; default keeps the image's `sleep infinity`. */
  cmd?: string[];
}

/** `container create` a long-lived (sleep-infinity) guest — started separately so
 *  all real work runs via `exec`. */
export async function createContainer(spec: CreateSpec): Promise<void> {
  const args = ["create", "--name", spec.name, "--network", spec.network, "--cpus", String(spec.cpus), "--memory", spec.memory];
  for (const m of spec.mounts) {
    const parts = [`source=${m.source}`, `target=${m.target}`];
    if (m.readonly) parts.push("readonly");
    args.push("--mount", parts.join(","));
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(spec.image);
  if (spec.cmd) args.push(...spec.cmd);
  await run(args);
}

/** Start an existing container. Already-running is not an error (idempotent up). */
export async function startContainer(name: string): Promise<void> {
  await run(["start", name], { allowFail: true });
}

export async function stopContainer(name: string): Promise<void> {
  await run(["stop", name], { allowFail: true });
}

export async function deleteContainer(name: string): Promise<boolean> {
  const r = await run(["delete", "--force", name], { allowFail: true });
  return r.exitCode === 0;
}

export interface ExecSpec {
  name: string;
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  allowFail?: boolean;
  redact?: string[];
}

/** `container exec [-e ...] [-w cwd] <name> <cmd...>`. */
export async function exec(spec: ExecSpec): Promise<RunResult> {
  const args = ["exec"];
  if (spec.stdin !== undefined) args.push("-i");
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  if (spec.cwd) args.push("-w", spec.cwd);
  args.push(spec.name, ...spec.cmd);
  return run(args, { stdin: spec.stdin, allowFail: spec.allowFail, redact: spec.redact });
}

// ── volumes (down --all) ──────────────────────────────────────────────────────

/** Names of `rig-*` volumes, best-effort (empty on any failure — never over-reaches). */
export async function rigVolumes(): Promise<string[]> {
  const r = await run(["volume", "list", "--format", "json"], { allowFail: true });
  if (r.exitCode !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    const names = new Set<string>();
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (typeof v === "string" && v.startsWith("rig-")) names.add(v);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

export async function volumeDelete(name: string): Promise<boolean> {
  // Guardrail: only ever remove rig-namespaced volumes.
  if (!name.startsWith("rig-")) throw new Error(`rig: refusing to delete non-rig volume ${name}`);
  const r = await run(["volume", "rm", name], { allowFail: true });
  return r.exitCode === 0;
}

/** Re-exported so callers reference the namespaced set from one place. */
export { NAMES };
