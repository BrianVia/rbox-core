/**
 * rig — the design-56 test bench (P0). One command stands up two ephemeral Linux
 * devices, onboards+converges a throwaway account against the DEV worker, and tears
 * down. Prod is refused before any container is created (config.assertNotProd).
 *
 *   bun scripts/rig/rig.ts doctor              # host preflight (read-only)
 *   bun scripts/rig/rig.ts up                  # build image + start rig-dev-a/b
 *   bun scripts/rig/rig.ts run onboard-smoke   # the PR gate
 *   bun scripts/rig/rig.ts down [--all]        # tear down (--all also image+volumes)
 *
 * Hand-rolled arg parsing (no deps). Container work goes through lib/container.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./lib/container.js";
import { DEFAULT_DEV_API, GUEST, imageHash, NAMES, resolveConfig } from "./lib/config.js";
import { Device } from "./lib/device.js";
import { resolveBootstrapSecret } from "./lib/account.js";
import { RunCapture } from "./lib/capture.js";
import { renderReportMd } from "./lib/report.js";
import { waitForConvergence, waitForPath } from "./lib/waiters.js";
import { ensureWorkloadDir, resolveWorkloadTar } from "./lib/workload.js";
import { FAST_SUITE, getScenario, scenarioNames } from "./scenarios/index.js";
import { finalizeReport, renderReportTable, type RigCtx, type Scenario, type ScenarioReport } from "./scenarios/types.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../.."); // scripts/rig/rig.ts → repo root
const RIG_DIR = path.join(REPO_ROOT, "scripts", "rig");
const RUNS_DIR = path.join(RIG_DIR, "runs");
const HASH_FILE = path.join(RUNS_DIR, ".image-hash");
const DEV_CPUS = 2;
const DEV_MEMORY = "2G"; // container CLI documents uppercase K/M/G/T/P suffixes

// ── arg parsing ────────────────────────────────────────────────────────────────

interface Args {
  cmd?: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      flags[a.slice(2)] = next && !next.startsWith("--") ? argv[++i]! : "true";
    } else positional.push(a);
  }
  return { cmd: positional.shift(), positional, flags };
}

const USAGE = `rig — design-56 test bench

usage:
  rig doctor                          host preflight (read-only)
  rig up [--api-url <url>]            build image + start rig-dev-a/b
  rig run <scenario> [--keep-account] run one scenario
  rig run all                         run the FAST suite (fresh account each; exit 1 if any FAIL)
  rig run conductor-initial-sync [--workload-tar <path>]   real-workload scale (explicit-only)
  rig watch [--api-url <url>]          live interleaved tail: [A]/[B] guests + [srv] wrangler
  rig down [--all]                    tear down containers + network (--all: +image +volumes)

scenarios: ${scenarioNames().join(", ")}
suite:     ${FAST_SUITE.join(", ")}
api url:   --api-url > RBOX_API > ${DEFAULT_DEV_API} (prod is always refused)`;

// ── image build / staleness ─────────────────────────────────────────────────────

function currentImageHash(): string {
  return imageHash({
    packageJson: fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    lockfile: fs.readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8"),
    dockerfile: fs.readFileSync(path.join(RIG_DIR, "Dockerfile"), "utf8"),
  });
}

function storedImageHash(): string | undefined {
  try {
    return fs.readFileSync(HASH_FILE, "utf8").trim();
  } catch {
    return undefined;
  }
}

async function ensureImage(): Promise<void> {
  const want = currentImageHash();
  const present = await C.imageExists(NAMES.image);
  if (present && storedImageHash() === want) {
    console.log(`image ${NAMES.image} present + current (${want})`);
    return;
  }
  console.log(`building ${NAMES.image} (${present ? "stale" : "missing"} → ${want})…`);
  await C.buildImage({
    tag: NAMES.image,
    dockerfile: path.join(RIG_DIR, "Dockerfile"),
    contextDir: REPO_ROOT,
    labels: { "rig.hash": want },
  });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(HASH_FILE, want);
  console.log(`built ${NAMES.image}`);
}

// ── up ──────────────────────────────────────────────────────────────────────────

/** Idempotent: build if stale, create the network + both containers if absent,
 *  (re)start them. Re-running with everything present just reports state. */
async function ensureUp(apiUrl: string): Promise<void> {
  const status = await C.systemStatus();
  if (!status.healthy) {
    console.log("container system not running → `container system start`…");
    await C.systemStart();
    const recheck = await C.systemStatus();
    if (!recheck.healthy) throw new Error(`container system unhealthy after start:\n${recheck.raw}`);
  }

  await ensureImage();

  if (!(await C.networkExists(NAMES.network))) {
    console.log(`creating network ${NAMES.network}`);
    await C.networkCreate(NAMES.network);
  }

  const mounts = [
    { source: path.join(REPO_ROOT, "src"), target: GUEST.srcMount, readonly: true },
    { source: path.join(REPO_ROOT, "scripts"), target: GUEST.scriptsMount, readonly: true },
  ];
  for (const name of [NAMES.a, NAMES.b]) {
    if (!(await C.containerExists(name))) {
      console.log(`creating ${name}`);
      await C.createContainer({ name, image: NAMES.image, network: NAMES.network, cpus: DEV_CPUS, memory: DEV_MEMORY, mounts, env: { RBOX_API: apiUrl } });
    }
    await C.startContainer(name);
    console.log(`${name} up`);
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Reset both guests to a pristine state between scenarios (`run all` reuses the SAME
 * containers): kill any leftover daemon, then wipe the workspace dir + rbox home so the
 * next scenario's fresh-account bootstrap starts from zero. Best-effort — a reset
 * failure is logged but never aborts the run. Never touches the workload mount.
 */
async function resetGuests(devices: { a: Device; b: Device }, log: (l: string) => void): Promise<void> {
  for (const d of [devices.a, devices.b]) {
    try {
      // Kill any detached daemon (guest-local pattern kill — cannot reach the host).
      await d.exec(["sh", "-c", "pkill -f __daemon-run 2>/dev/null || true"], { allowFail: true });
      await d.exec(["sh", "-c", `rm -rf '${GUEST.workDir}' '${GUEST.rboxHome}' 2>/dev/null || true`], { allowFail: true });
    } catch (e) {
      log(`  (reset ${d.name} best-effort error: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

/**
 * Execute ONE scenario end-to-end: fresh run dir, a fresh {@link RigCtx} (device
 * handles + waiters), a guest reset, the P1 capture lifecycle, and the report
 * artifacts. Returns the report. Shared by the single-scenario path and the suite.
 */
async function executeScenario(scenario: Scenario, apiUrl: string, flags: Record<string, string>, bootstrapSecret: string): Promise<ScenarioReport> {
  const runDir = path.join(RUNS_DIR, `${timestamp()}-${scenario.name}`);
  fs.mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, "run.log");
  const log = (line: string): void => {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    console.log(line);
  };
  // Transcript firehose → run.log ONLY (console stays compact). Wired into the devices.
  const transcript = (text: string): void => {
    fs.appendFileSync(logPath, text.endsWith("\n") ? text : text + "\n");
  };
  log(`rig run ${scenario.name} — api ${apiUrl} — runDir ${runDir}`);

  const a = new Device(NAMES.a, apiUrl, { label: "A", transcript, redact: [bootstrapSecret] });
  const b = new Device(NAMES.b, apiUrl, { label: "B", transcript, redact: [bootstrapSecret] });
  const ctx: RigCtx = {
    a,
    b,
    apiUrl,
    bootstrapSecret,
    runDir,
    keepAccount: flags["keep-account"] === "true",
    flags,
    log,
    transcript,
    waitForPath: (device, p, predicate, timeoutMs) => waitForPath(device, p, predicate, timeoutMs),
    waitForConvergence: (da, db, dir, timeoutMs) => waitForConvergence(da, db, dir, timeoutMs),
  };

  // Clean slate before every scenario (containers are reused across the suite).
  await resetGuests({ a, b }, log);

  // conductor-initial-sync needs the workload volume mounted into A (rig-managed,
  // scenario-specific). Absent tarball → the scenario SKIPs; a stage failure aborts.
  if (scenario.name === "conductor-initial-sync") {
    await prepareConductorWorkload(apiUrl, flags, log);
  }

  // Capture is created BEFORE the scenario and finalized in `finally` so artifacts
  // exist even when the scenario aborts. Every channel is independently best-effort;
  // capture failures never change the verdict.
  const capture = new RunCapture({
    runDir,
    repoRoot: REPO_ROOT,
    names: { a: NAMES.a, b: NAMES.b },
    devices: { a, b },
    workDir: GUEST.workDir,
    rboxHome: GUEST.rboxHome,
    env: process.env,
    log,
  });
  capture.start();

  let report: ScenarioReport;
  try {
    report = await scenario.run(ctx);
  } catch (e) {
    // A scenario should catch its own step errors, but never let an escape crash the
    // harness without a report.
    log(`✗ scenario threw: ${e instanceof Error ? e.message : String(e)}`);
    const now = new Date().toISOString();
    report = finalizeReport({ scenario: scenario.name, startedAt: now, finishedAt: now, steps: [{ name: "run", ok: false, ms: 0, detail: String(e) }], assertions: [] });
  }

  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));

  let captureSummary;
  try {
    captureSummary = await capture.finish();
  } catch (e) {
    // finish() is already best-effort internally; this only guards a truly unexpected
    // escape so report rendering still happens.
    log(`capture.finish() error (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    captureSummary = { statsA: { skipped: "capture aborted" }, statsB: { skipped: "capture aborted" }, tail: { skipped: "capture aborted" }, ae: { skipped: "capture aborted" }, artifacts: [] as string[] };
  }

  fs.writeFileSync(path.join(runDir, "report.md"), renderReportMd(report, captureSummary));

  const table = renderReportTable(report);
  fs.appendFileSync(logPath, table + "\n");
  console.log("\n" + table);
  console.log(`\nreport: ${path.join(runDir, "report.md")}`);
  return report;
}

/** Exit code for a report: PASS/SKIP → 0, FAIL → 1. */
function reportExit(report: ScenarioReport): number {
  return report.verdict === "FAIL" ? 1 : 0;
}

async function runScenario(name: string, apiUrl: string, flags: Record<string, string>): Promise<number> {
  const scenario = getScenario(name);
  if (!scenario) {
    console.error(`rig: unknown scenario ${JSON.stringify(name)} (have: ${scenarioNames().join(", ")})`);
    return 2;
  }
  // Resolve the secret up front (never printed) so a misconfig fails before any work.
  const bootstrapSecret = resolveBootstrapSecret(REPO_ROOT);
  await ensureUp(apiUrl);
  const report = await executeScenario(scenario, apiUrl, flags, bootstrapSecret);
  return reportExit(report);
}

/**
 * `rig run all` — the FAST suite (design 56 §9): every gate scenario sequentially in
 * ONE session with a fresh account each, then a single summary table. Exit 1 if any
 * FAILs; SKIP never fails the suite. conductor-initial-sync stays explicit-only.
 */
async function runSuite(apiUrl: string, flags: Record<string, string>): Promise<number> {
  const bootstrapSecret = resolveBootstrapSecret(REPO_ROOT);
  await ensureUp(apiUrl);

  const results: ScenarioReport[] = [];
  for (const name of FAST_SUITE) {
    const scenario = getScenario(name)!;
    console.log(`\n═══ suite: ${name} (${results.length + 1}/${FAST_SUITE.length}) ═══`);
    results.push(await executeScenario(scenario, apiUrl, flags, bootstrapSecret));
  }

  const pad = Math.max(...results.map((r) => r.scenario.length));
  const rows = results.map((r) => {
    const mark = r.verdict === "PASS" ? "✅ PASS" : r.verdict === "SKIP" ? "○ SKIP" : "❌ FAIL";
    const nFail = r.assertions.filter((a) => !a.ok).length + r.steps.filter((s) => !s.ok).length;
    return `  ${r.scenario.padEnd(pad)}  ${mark}  ${(r.durationMs / 1000).toFixed(1)}s${nFail ? `  (${nFail} failed)` : ""}`;
  });
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  const skipped = results.filter((r) => r.verdict === "SKIP").length;
  console.log(`\n═══ suite summary ═══\n${rows.join("\n")}\n  → ${results.length - failed - skipped} passed · ${failed} failed · ${skipped} skipped`);
  return failed > 0 ? 1 : 0;
}

/**
 * Stage the conductor tarball into a content-addressed HOST cache dir and (re)create
 * device A with it bind-mounted RO at {@link GUEST.workloadMount}. No tarball → leave
 * A as-is (the scenario detects the missing mount and SKIPs). Rig-managed because
 * scenarios have no container access by design. Host-side staging is deliberate —
 * see the workload.ts header for the container-1.0.0 wedge this replaced.
 */
async function prepareConductorWorkload(apiUrl: string, flags: Record<string, string>, log: (l: string) => void): Promise<void> {
  const tarPath = resolveWorkloadTar(flags);
  if (!fs.existsSync(tarPath)) {
    log(`conductor workload tarball absent (${tarPath}) — scenario will SKIP`);
    return;
  }
  // Cache lives OUTSIDE the repo: `bun test`/tsc would otherwise recurse into the
  // staged workload (a real tree full of its own .test.ts files), and a host-global
  // cache is shared across worktrees.
  const staged = await ensureWorkloadDir(tarPath, path.join(os.homedir(), ".cache", "rbox-rig", "workloads"), log);
  // Recreate A with the workload dir mounted RO (alongside the standard src/scripts
  // mounts). B is untouched. A's prior state is disposable (fresh account).
  log(`recreating ${NAMES.a} with workload ${staged.dir} → ${GUEST.workloadMount}`);
  await C.stopContainer(NAMES.a);
  await C.deleteContainer(NAMES.a);
  await C.createContainer({
    name: NAMES.a,
    image: NAMES.image,
    network: NAMES.network,
    cpus: DEV_CPUS,
    memory: DEV_MEMORY,
    mounts: [
      { source: path.join(REPO_ROOT, "src"), target: GUEST.srcMount, readonly: true },
      { source: path.join(REPO_ROOT, "scripts"), target: GUEST.scriptsMount, readonly: true },
      { source: staged.dir, target: GUEST.workloadMount, readonly: true },
    ],
    env: { RBOX_API: apiUrl },
  });
  await C.startContainer(NAMES.a);
}

// ── down ──────────────────────────────────────────────────────────────────────

async function down(all: boolean): Promise<void> {
  const removed: string[] = [];
  for (const name of [NAMES.a, NAMES.b]) {
    await C.stopContainer(name);
    if (await C.deleteContainer(name)) removed.push(`container ${name}`);
  }
  if (await C.networkDelete(NAMES.network)) removed.push(`network ${NAMES.network}`);
  if (all) {
    if (await C.imageDelete(NAMES.image)) removed.push(`image ${NAMES.image}`);
    for (const v of await C.rigVolumes()) if (await C.volumeDelete(v)) removed.push(`volume ${v}`);
    try {
      fs.rmSync(HASH_FILE, { force: true });
    } catch {
      /* best-effort */
    }
  }
  console.log(removed.length ? `removed:\n  ${removed.join("\n  ")}` : "nothing to remove (already clean)");
}

// ── watch ─────────────────────────────────────────────────────────────────────

/** Interleaved live tail of both guests + the dev worker until Ctrl-C. The [srv]
 *  stream uses `--format pretty` — wrangler v4's `--format json` is multi-line
 *  pretty-printed (useless to compact line-by-line); pretty is already human-readable. */
async function watch(apiUrl: string): Promise<number> {
  console.log(`rig watch — [A]/[B] container logs + [srv] wrangler tail (${apiUrl}). Ctrl-C to stop.`);
  const handles: C.StreamHandle[] = [];
  const emit = (prefix: string) => (line: string) => console.log(`${prefix} ${line}`);

  handles.push(C.spawnStream(["container", "logs", "--follow", NAMES.a], { onStdout: emit("[A]"), onStderr: emit("[A]") }));
  handles.push(C.spawnStream(["container", "logs", "--follow", NAMES.b], { onStdout: emit("[B]"), onStderr: emit("[B]") }));
  handles.push(
    C.spawnStream(["bunx", "wrangler", "tail", "rbox-dev-api", "--format", "pretty"], {
      cwd: path.join(REPO_ROOT, "apps", "api"),
      onStdout: emit("[srv]"),
      onStderr: emit("[srv]"),
    })
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      for (const h of handles) {
        try {
          h.kill("SIGTERM");
        } catch {
          /* best-effort */
        }
      }
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

// ── doctor ──────────────────────────────────────────────────────────────────────

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** Advisory checks are informational only — they never affect the exit code. */
  advisory?: boolean;
}

async function doctor(apiUrl: string): Promise<number> {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, detail: string, fix?: string) => checks.push({ label, ok, detail, fix });
  const advise = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail, advisory: true });

  // macOS >= 26
  try {
    const ver = (await C.spawnHost(["sw_vers", "-productVersion"], { allowFail: true })).stdout.trim();
    const major = Number(ver.split(".")[0]);
    add("macOS >= 26", Number.isFinite(major) && major >= 26, ver || "unknown", "upgrade macOS (container needs macOS 26+ for container-to-container networking)");
  } catch {
    add("macOS >= 26", false, "sw_vers failed");
  }

  // arm64
  const arch = (await C.spawnHost(["uname", "-m"], { allowFail: true })).stdout.trim();
  add("arch arm64", arch === "arm64", arch || "unknown", "the rig targets arm64 (Apple silicon) guests");

  // container binary + version
  const ver = await C.version();
  add("container CLI present", ver.length > 0, ver || "not found", "brew install container   # Apple container runtime");

  // container system healthy
  const sys = await C.systemStatus();
  add("container system running", sys.healthy, sys.healthy ? "healthy" : sys.raw || "not running", "container system start");

  // bun on host
  const bun = (await C.spawnHost(["bun", "--version"], { allowFail: true })).stdout.trim();
  add("bun present", bun.length > 0, bun || "not found", "curl -fsSL https://bun.sh/install | bash");

  // bootstrap secret resolvable (never printed)
  try {
    resolveBootstrapSecret(REPO_ROOT);
    add("bootstrap secret resolvable", true, "found (redacted)");
  } catch (e) {
    add("bootstrap secret resolvable", false, e instanceof Error ? e.message : String(e), "set RBOX_DEV_BOOTSTRAP or add RBOX_DEV_BOOTSTRAP_SECRET= to dev-keys.local.secret");
  }

  // dev API reachable (GET /health, 5s budget)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${apiUrl}/health`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    add("dev API reachable", res.ok, `${apiUrl}/health → ${res.status}`, "check the dev worker is deployed / your network");
  } catch (e) {
    add("dev API reachable", false, `${apiUrl}/health → ${e instanceof Error ? e.message : String(e)}`);
  }

  // Advisory: the AE query pair (optional — absence only skips the server-metrics
  // capture channel, never fails the run or doctor).
  advise("CLOUDFLARE_ACCOUNT_ID (optional, AE query)", Boolean(process.env.CLOUDFLARE_ACCOUNT_ID), process.env.CLOUDFLARE_ACCOUNT_ID ? "present" : "absent");
  advise("CLOUDFLARE_API_TOKEN (optional, AE query)", Boolean(process.env.CLOUDFLARE_API_TOKEN), process.env.CLOUDFLARE_API_TOKEN ? "present" : "absent");

  let anyFail = false;
  for (const c of checks) {
    const mark = c.advisory ? (c.ok ? "○" : "·") : c.ok ? "✓" : "✗";
    console.log(`${mark} ${c.label}: ${c.detail}`);
    if (!c.ok && !c.advisory) {
      anyFail = true;
      if (c.fix) console.log(`    fix: ${c.fix}`);
    }
  }
  return anyFail ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

  if (cmd === "--help" || cmd === "-h" || cmd === "help" || cmd === undefined) {
    console.log(USAGE);
    return cmd === undefined ? 2 : 0;
  }

  // Prod-URL refusal happens inside resolveConfig, before any container is created.
  switch (cmd) {
    case "doctor":
      return doctor(resolveConfig(process.env, flags, REPO_ROOT).apiUrl);
    case "up":
      await ensureUp(resolveConfig(process.env, flags, REPO_ROOT).apiUrl);
      console.log("up complete.");
      return 0;
    case "run": {
      const scenario = positional[0];
      if (!scenario) {
        console.error(`rig: \`run\` needs a scenario or \`all\` (have: ${scenarioNames().join(", ")})`);
        return 2;
      }
      const apiUrl = resolveConfig(process.env, flags, REPO_ROOT).apiUrl;
      return scenario === "all" ? runSuite(apiUrl, flags) : runScenario(scenario, apiUrl, flags);
    }
    case "watch":
      return watch(resolveConfig(process.env, flags, REPO_ROOT).apiUrl);
    case "down":
      await down(flags.all === "true");
      return 0;
    default:
      console.error(`rig: unknown command ${JSON.stringify(cmd)}\n`);
      console.error(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`rig: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  });
