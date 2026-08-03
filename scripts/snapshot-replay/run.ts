/**
 * `bun scripts/snapshot-replay/run.ts` — snapshot every real rbox workspace on
 * this host into a sandbox and replay the 2.0 migration machine against the
 * COPY.
 *
 * The real workspaces are read-only to this harness. It never runs an rbox
 * command against one, never takes a lock on one, and never stops a daemon; the
 * only thing it does to a live workspace is read `.rbox` twice and compare.
 *
 * Both phases run as straced children so the safety claim is evidence rather
 * than assertion:
 *
 * - the SNAPSHOT child may read the real workspace and may write only the
 *   sandbox;
 * - the REPLAY child runs with `HOME`/`RBOX_HOME` inside the sandbox and may
 *   neither write outside it nor NAME the host's state plane.
 *
 * Usage:
 *   bun scripts/snapshot-replay/run.ts [--out-root DIR] [--workspace PATH]...
 *                                      [--budget-bytes N] [--no-strace]
 *
 * `--budget-bytes` sets `RBOX_RESET_PARSE_BUDGET_BYTES` for the replay child,
 * which is how a 60 GiB host can ask what a 16 GiB laptop's M1 admission would
 * have decided about the same document.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditStraceLog, type AuditProfile, type AuditResult } from "./isolation.js";
import { sandboxLayout, type SandboxLayout } from "./layout.js";

const SYSTEM_ROOTS = [
  "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/proc", "/sys", "/dev", "/run", "/opt", "/var",
];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const HOST_RBOX = path.join(os.homedir(), ".rbox");

/**
 * Where the replay child is expected to read code from: this checkout, the Bun
 * install it runs under, and any ancestor `node_modules` its resolver walks up
 * to — a git worktree has none of its own, so dependency reads legitimately
 * land in the primary checkout. Declaring them by name is what lets an
 * unexpected read stand out instead of being lost in a permitted prefix.
 */
function codeRoots(): string[] {
  const roots = [REPO, path.dirname(path.dirname(process.execPath))];
  for (let dir = REPO; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node_modules"))) roots.push(path.join(dir, "node_modules"));
  }
  return roots;
}
const CODE_ROOTS = codeRoots();

function flagValues(flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
  return values;
}
const flag = (name: string): string | undefined => flagValues(name)[0];
const has = (name: string): boolean => process.argv.includes(name);

/** Read-only discovery: the binding registry the host's own daemons maintain,
 * filtered to roots that still exist and still carry a legacy document. */
function discoverWorkspaces(): string[] {
  const explicit = flagValues("--workspace").map((value) => path.resolve(value));
  const registry = path.join(HOST_RBOX, "workspaces.json");
  const roots = explicit.length > 0 ? explicit : (() => {
    if (!fs.existsSync(registry)) return [];
    const parsed = JSON.parse(fs.readFileSync(registry, "utf8")) as { entries?: Array<{ root?: string }> };
    return (parsed.entries ?? []).map((entry) => entry.root).filter((root): root is string => typeof root === "string");
  })();
  return [...new Set(roots)].filter((root) => fs.existsSync(path.join(root, ".rbox", "state.json"))).sort();
}

interface ChildRun {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly audit: AuditResult | undefined;
  readonly wallMs: number;
}

function runTraced(
  label: string, layout: SandboxLayout, script: string, args: readonly string[],
  env: NodeJS.ProcessEnv, profile: AuditProfile,
): ChildRun {
  const log = path.join(layout.probe, `${label}.strace`);
  const command = has("--no-strace")
    ? [process.execPath, script, ...args]
    : ["strace", "-f", "-qq", "-y", "-s", "1024", "-e", "trace=%file", "-o", log,
      "--", process.execPath, script, ...args];
  const startedAt = Date.now();
  const result = spawnSync(command[0]!, command.slice(1), {
    env, cwd: profile.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").slice(-4000),
    audit: fs.existsSync(log) ? auditStraceLog(log, profile) : undefined,
    wallMs: Date.now() - startedAt,
  };
}

/**
 * Disk, not RAM, by default. A replay of an 81 MiB legacy document writes the
 * copy plus two backups plus a staging database plus its WAL — comfortably a
 * gigabyte — and `os.tmpdir()` is a tmpfs on at least one fleet host, where the
 * default would spend that gigabyte of memory and then fail mid-import.
 */
const defaultOutRoot = (): string => {
  const disk = "/var/tmp";
  return path.join(fs.existsSync(disk) ? disk : os.tmpdir(), "rbox-snapshot-replay");
};
const outRoot = path.resolve(flag("--out-root") ?? defaultOutRoot());
const workspaces = discoverWorkspaces();
for (const workspace of workspaces) {
  if (outRoot === workspace || outRoot.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`refusing to run: the sandbox root ${outRoot} is inside the real workspace ${workspace}`);
  }
}
if (workspaces.length === 0) throw new Error("no legacy rbox workspaces found on this host");
fs.mkdirSync(outRoot, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const results: Array<Record<string, unknown>> = [];

for (const workspace of workspaces) {
  const slug = workspace.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const layout = sandboxLayout(path.join(outRoot, `${slug}-${stamp}`));
  fs.mkdirSync(layout.probe, { recursive: true });
  const tmp = path.join(layout.root, "tmp");
  fs.mkdirSync(tmp, { recursive: true });

  const snapshotProfile: AuditProfile = {
    cwd: layout.root,
    writableRoots: [layout.root, "/dev/null", "/dev/tty", "/proc"],
    forbidden: [],
    readableRoots: [...CODE_ROOTS, workspace, HOST_RBOX, os.homedir(), ...SYSTEM_ROOTS],
  };
  const snapshot = runTraced("snapshot", layout, path.join(HERE, "snapshot.ts"),
    ["--source", workspace, "--sandbox", layout.root], { ...process.env, TMPDIR: tmp }, snapshotProfile);

  const replayProfile: AuditProfile = {
    cwd: layout.ws,
    writableRoots: [layout.root, "/dev/null", "/dev/tty", "/proc"],
    // The two things a replay must never name: the host's global state and the
    // real workspace's state plane.
    forbidden: [HOST_RBOX, ...workspaces.map((root) => path.join(root, ".rbox"))],
    readableRoots: [...CODE_ROOTS, ...SYSTEM_ROOTS],
  };
  const replay = snapshot.ok
    ? runTraced("replay", layout, path.join(HERE, "replay.ts"), ["--sandbox", layout.root], {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: layout.home,
      RBOX_HOME: layout.home,
      TMPDIR: tmp,
      ...(flag("--budget-bytes") ? { RBOX_RESET_PARSE_BUDGET_BYTES: flag("--budget-bytes")! } : {}),
    }, replayProfile)
    : undefined;

  const parse = (run: ChildRun | undefined): unknown => {
    const line = run?.stdout.trim().split("\n").at(-1);
    try {
      return line ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  };
  results.push({
    workspace,
    sandbox: layout.root,
    snapshot: { ok: snapshot.ok, wallMs: snapshot.wallMs, report: parse(snapshot), stderr: snapshot.ok ? "" : snapshot.stderr },
    replay: replay && { ok: replay.ok, wallMs: replay.wallMs, report: parse(replay), stderr: replay.ok ? "" : replay.stderr },
    isolation: { snapshot: snapshot.audit, replay: replay?.audit },
  });
}

const reportFile = path.join(outRoot, `report-${stamp}.json`);
fs.writeFileSync(reportFile, `${JSON.stringify(results, null, 2)}\n`);

for (const result of results) {
  const replay = result.replay as {
    ok?: boolean;
    report?: {
      exitCode?: number; secondExitCode?: number; migrateLines?: string[];
      fidelity?: string; entryPointVerdict?: string;
    };
  } | undefined;
  const audit = (result.isolation as { replay?: AuditResult }).replay;
  console.log([
    `workspace ${String(result.workspace)}`,
    `  sandbox   ${String(result.sandbox)}`,
    // The command's own verdict, in its own words — the harness drives
    // `rbox migrate`, so the line a user would have read IS the outcome.
    `  outcome   ${replay?.report?.migrateLines?.at(-2) ?? (replay?.ok === false ? "child-failed" : "not-run")}`,
    `  exit      ${replay?.report?.exitCode ?? "n/a"} (re-run on the result: ${replay?.report?.secondExitCode ?? "n/a"})`,
    `  fidelity  ${replay?.report?.fidelity ?? "n/a"}`,
    `  entry     ${replay?.report?.entryPointVerdict ?? "n/a"}`,
    `  isolation ${audit ? (audit.clean ? "clean" : "VIOLATIONS") : "unaudited"}`,
  ].join("\n"));
}
console.log(`\nfull report: ${reportFile}`);
