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
import { deleteAccount, readCredentials, resolveBootstrapSecret, resolvePlatformSecret } from "./lib/account.js";
import { RunCapture } from "./lib/capture.js";
import { assignMainExit, reportExit } from "./lib/exit-code.js";
import { renderReportMd } from "./lib/report.js";
import { imageHashRecordPath, readImageHashRecord, writeImageHashRecord } from "./lib/image-hash-records.js";
import { formatBytes, trimRunDirectories } from "./lib/gc.js";
import { doctor } from "./lib/doctor-command.js";
import { down, gc, watch } from "./lib/runtime-commands.js";
import { binaryGuardReport, binaryVersionGuardError } from "./lib/binary-run.js";
import { waitForConvergence, waitForPath } from "./lib/waiters.js";
import { ensureWorkloadDir, resolveWorkloadTar } from "./lib/workload.js";
import { FAST_SUITE, getScenario, scenarioNames } from "./scenarios/index.js";
import { finalizeReport, renderReportTable, skipReport, type RigCtx, type Scenario, type ScenarioReport } from "./scenarios/types.js";
import {
  assertDualBinaryAllowed,
  makeRigBinaryIdentity,
  prepareRigBinarySelection,
  resolveRigBinaryPaths,
  rigGuestMounts,
  type RigBinaryIdentity,
  type RigBinarySelection,
} from "./lib/binary.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../.."); // scripts/rig/rig.ts → repo root
const RIG_DIR = path.join(REPO_ROOT, "scripts", "rig");
const RUNS_DIR = path.join(RIG_DIR, "runs");
const HASH_FILE = imageHashRecordPath();
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
  rig doctor [--runner container|docker]  host/runtime preflight
  rig up [--api-url <url>] [--binary <path>] [--binary-a <path>] [--binary-b <path>]
  rig run <scenario> [--keep-account] [--binary <path>] [--binary-a <path>] [--binary-b <path>]
  rig run all                         run the FAST suite (fresh account each; exit 1 if any FAIL)
  rig run conductor-initial-sync [--workload-tar <path>]   real-workload scale (explicit-only)
  rig watch [--api-url <url>]          live interleaved tail: [A]/[B] guests + [srv] wrangler
  rig down [--all]                    tear down containers + network (--all: +image +volumes)
  rig gc                              scoped rig artifact + cache reclamation

scenarios: ${scenarioNames().join(", ")}
suite:     ${FAST_SUITE.join(", ")}
api url:   --api-url > RBOX_API > ${DEFAULT_DEV_API} (prod is always refused)`;

function currentImageHash(): string {
  return imageHash({
    packageJson: fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    lockfile: fs.readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8"),
    dockerfile: fs.readFileSync(path.join(RIG_DIR, "Dockerfile"), "utf8"),
  });
}

async function ensureImage(): Promise<string> {
  const want = currentImageHash();
  const present = await C.imageExists(NAMES.image);
  if (present && readImageHashRecord(HASH_FILE, C.runnerName()) === want) {
    console.log(`image ${NAMES.image} present + current (${want})`);
    return want;
  }
  console.log(`building ${NAMES.image} (${present ? "stale" : "missing"} → ${want})…`);
  await C.buildImage({
    tag: NAMES.image,
    dockerfile: path.join(RIG_DIR, "Dockerfile"),
    contextDir: REPO_ROOT,
    labels: { "rig.hash": want },
  });
  writeImageHashRecord(HASH_FILE, C.runnerName(), want);
  console.log(`built ${NAMES.image}`);
  return want;
}

/** Idempotent: build if stale, create the network + both containers if absent,
 *  (re)start them. Re-running with everything present just reports state. */
async function ensureUp(apiUrl: string, binaries: RigBinarySelection): Promise<void> {
  await C.ensureRuntimeReady();
  const trimmed = trimRunDirectories(RUNS_DIR);
  if (trimmed.entries) console.log(`trimmed ${trimmed.entries} old rig runs (${formatBytes(trimmed.bytes)})`);
  const currentHash = await ensureImage();
  await C.assessRuntimeResourcePolicy(NAMES.image);

  if (!(await C.networkExists(NAMES.network))) {
    console.log(`creating network ${NAMES.network}`);
    await C.networkCreate(NAMES.network);
  }

  for (const [name, binary] of [[NAMES.a, binaries.a], [NAMES.b, binaries.b]] as const) {
    const mounts = rigGuestMounts(REPO_ROOT, binary.stagedDirectory);
    const spec: C.CreateSpec = { name, image: NAMES.image, imageHash: currentHash, network: NAMES.network, cpus: DEV_CPUS, memory: DEV_MEMORY, mounts, env: { RBOX_API: apiUrl } };
    let exists = await C.containerExists(name);
    if (exists && !(await C.containerHasMounts(name, mounts))) {
      console.log(`${name} belongs to another checkout (stale bind mounts) → recreating`);
      await C.deleteContainer(name);
      exists = false;
    }
    if (exists && !(await C.containerHasSpec(name, spec))) {
      console.log(`${name} create specification changed → recreating`);
      await C.deleteContainer(name);
      exists = false;
    }
    if (!exists) {
      console.log(`creating ${name}`);
      await C.createContainer(spec);
    }
    await C.startContainer(name);
    console.log(`${name} up`);
  }
  // Rebuild retags the old image, but Docker cannot remove that now-dangling ID
  // until every container referencing it has been recreated by the spec guard.
  // Sweep on every up, not only the rebuilding invocation, so a transient failed
  // deletion remains discoverable and is retried next time.
  for (const dangling of await C.removeDanglingRigImages()) {
    console.log(`removed dangling rig image ${dangling.id} (${dangling.size})`);
  }
}

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

async function cleanupScenarioAccount(ctx: RigCtx, report: ScenarioReport | undefined): Promise<void> {
  if (ctx.keepAccount || report?.steps.some((step) => step.name === "teardown DELETE /v1/account" && step.ok)) return;
  try {
    const raw = await ctx.a.readFileIfExists(`${GUEST.rboxHome}/credentials.json`);
    if (!raw) {
      ctx.log("  account cleanup skipped: no A credentials");
      return;
    }
    const creds = readCredentials(raw);
    if (!creds.accountId) {
      ctx.log("  account cleanup skipped: A credentials missing accountId");
      return;
    }
    const result = await deleteAccount(ctx.apiUrl, creds.token, creds.accountId);
    ctx.log(`  account cleanup ${result.ok ? "ok" : "failed"}: DELETE /v1/account → ${result.status}`);
  } catch (e) {
    ctx.log(`  account cleanup best-effort error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Execute ONE scenario end-to-end: fresh run dir, a fresh {@link RigCtx} (device
 * handles + waiters), a guest reset, the P1 capture lifecycle, and the report
 * artifacts. Returns the report. Shared by the single-scenario path and the suite.
 */
async function executeScenario(
  scenario: Scenario,
  apiUrl: string,
  flags: Record<string, string>,
  bootstrapSecret: string,
  platformSecret: string,
  binaries: [RigBinaryIdentity, RigBinaryIdentity],
  selection: RigBinarySelection,
  binaryGuardError?: string,
): Promise<ScenarioReport> {
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
    platformSecret,
    runDir,
    scenarioName: scenario.name,
    keepAccount: flags["keep-account"] === "true",
    flags,
    log,
    transcript,
    waitForPath: (device, p, predicate, timeoutMs) => waitForPath(device, p, predicate, timeoutMs),
    waitForConvergence: (da, db, dir, timeoutMs) => waitForConvergence(da, db, dir, timeoutMs),
  };

  if (binaryGuardError) log(`✗ ${binaryGuardError}`);

  // conductor-initial-sync needs the workload volume mounted into A (rig-managed,
  // scenario-specific). Absent tarball → the scenario SKIPs; a stage failure aborts.
  if (!binaryGuardError) {
    // Clean slate before every scenario (containers are reused across the suite).
    await resetGuests({ a, b }, log);
    if (scenario.name === "conductor-initial-sync") {
      await prepareConductorWorkload(apiUrl, flags, selection, log);
    }
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

  let report: ScenarioReport | undefined;
  try {
    if (binaryGuardError) {
      report = binaryGuardReport(scenario.name, binaries, binaryGuardError);
    } else if (C.runtimeMarkers().includes("rootless-unvalidated") && scenario.name === "daemon-idle-cpu") {
      report = skipReport(scenario.name, "resource-budget scenario skipped: rootless-unvalidated");
    } else try {
      report = await scenario.run(ctx);
    } catch (e) {
      // A scenario should catch its own step errors, but never let an escape crash the
      // harness without a report.
      log(`✗ scenario threw: ${e instanceof Error ? e.message : String(e)}`);
      const now = new Date().toISOString();
      report = finalizeReport({ scenario: scenario.name, startedAt: now, finishedAt: now, steps: [{ name: "run", ok: false, ms: 0, detail: String(e) }], assertions: [] });
    }
  } finally {
    if (!binaryGuardError) await cleanupScenarioAccount(ctx, report);
  }

  if (!report) throw new Error(`scenario ${scenario.name} produced no report`);

  report = { ...report, binaries };
  const persistedReport = { ...report, runner: C.runnerName(), ...(C.runtimeMarkers().length ? { markers: [...C.runtimeMarkers()] } : {}) };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(persistedReport, null, 2));

  let captureSummary;
  try {
    captureSummary = await capture.finish();
  } catch (e) {
    // finish() is already best-effort internally; this only guards a truly unexpected
    // escape so report rendering still happens.
    log(`capture.finish() error (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    captureSummary = { runner: C.runnerName(), markers: [...C.runtimeMarkers()], statsA: { skipped: "capture aborted" }, statsB: { skipped: "capture aborted" }, tail: { skipped: "capture aborted" }, ae: { skipped: "capture aborted" }, artifacts: [] as string[] };
  }

  captureSummary.markers = [...C.runtimeMarkers()];

  fs.writeFileSync(path.join(runDir, "report.md"), renderReportMd(report, captureSummary));

  const table = renderReportTable(report);
  fs.appendFileSync(logPath, table + "\n");
  console.log("\n" + table);
  console.log(`\nreport: ${path.join(runDir, "report.md")}`);
  return report;
}

async function probeBinaryIdentities(
  apiUrl: string,
  selection: RigBinarySelection,
): Promise<[RigBinaryIdentity, RigBinaryIdentity]> {
  const a = new Device(NAMES.a, apiUrl);
  const b = new Device(NAMES.b, apiUrl);
  const [versionA, versionB] = await Promise.all([
    a.rbox(["--version"], { allowFail: true }),
    b.rbox(["--version"], { allowFail: true }),
  ]);
  const version = (result: C.RunResult): string => (result.stdout.trim() || result.stderr.trim() || "(no version output)");
  return [
    makeRigBinaryIdentity("A", selection.a, version(versionA), versionA.exitCode),
    makeRigBinaryIdentity("B", selection.b, version(versionB), versionB.exitCode),
  ];
}

async function runScenario(name: string, apiUrl: string, flags: Record<string, string>): Promise<number> {
  const scenario = getScenario(name);
  if (!scenario) {
    console.error(`rig: unknown scenario ${JSON.stringify(name)} (have: ${scenarioNames().join(", ")})`);
    return 2;
  }
  const selection = prepareRigBinarySelection(resolveRigBinaryPaths(flags), REPO_ROOT);
  assertDualBinaryAllowed(selection, scenario.name, scenario.supportsDualBinary === true);
  await ensureUp(apiUrl, selection);
  const binaries = await probeBinaryIdentities(apiUrl, selection);
  const guardError = binaryVersionGuardError(selection, binaries);
  // A binary-identity refusal needs neither account secrets nor guest cleanup.
  const bootstrapSecret = guardError ? "" : resolveBootstrapSecret(REPO_ROOT);
  const platformSecret = guardError ? "" : resolvePlatformSecret(REPO_ROOT);
  const report = await executeScenario(scenario, apiUrl, flags, bootstrapSecret, platformSecret, binaries, selection, guardError);
  return reportExit(report);
}

/**
 * `rig run all` — the FAST suite (design 56 §9): every gate scenario sequentially in
 * ONE session with a fresh account each, then a single summary table. Exit 1 if any
 * FAILs; SKIP never fails the suite. conductor-initial-sync stays explicit-only.
 */
async function runSuite(apiUrl: string, flags: Record<string, string>): Promise<number> {
  const selection = prepareRigBinarySelection(resolveRigBinaryPaths(flags), REPO_ROOT);
  for (const name of FAST_SUITE) {
    const scenario = getScenario(name)!;
    assertDualBinaryAllowed(selection, scenario.name, scenario.supportsDualBinary === true);
  }
  await ensureUp(apiUrl, selection);
  const binaries = await probeBinaryIdentities(apiUrl, selection);
  const guardError = binaryVersionGuardError(selection, binaries);
  const bootstrapSecret = guardError ? "" : resolveBootstrapSecret(REPO_ROOT);
  const platformSecret = guardError ? "" : resolvePlatformSecret(REPO_ROOT);

  const results: ScenarioReport[] = [];
  for (const name of FAST_SUITE) {
    const scenario = getScenario(name)!;
    console.log(`\n═══ suite: ${name} (${results.length + 1}/${FAST_SUITE.length}) ═══`);
    results.push(await executeScenario(scenario, apiUrl, flags, bootstrapSecret, platformSecret, binaries, selection, guardError));
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
async function prepareConductorWorkload(
  apiUrl: string,
  flags: Record<string, string>,
  binaries: RigBinarySelection,
  log: (l: string) => void,
): Promise<void> {
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
    imageHash: currentImageHash(),
    network: NAMES.network,
    cpus: DEV_CPUS,
    memory: DEV_MEMORY,
    mounts: rigGuestMounts(REPO_ROOT, binaries.a.stagedDirectory, [
      { source: staged.dir, target: GUEST.workloadMount, readonly: true },
    ]),
    env: { RBOX_API: apiUrl },
  });
  await C.startContainer(NAMES.a);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

  if (cmd === "--help" || cmd === "-h" || cmd === "help" || cmd === undefined) {
    console.log(USAGE);
    return cmd === undefined ? 2 : 0;
  }

  C.configureRunner(flags.runner);

  // Prod-URL refusal happens inside resolveConfig, before any container is created.
  switch (cmd) {
    case "doctor":
      return doctor({
        apiUrl: resolveConfig(process.env, flags, REPO_ROOT).apiUrl,
        repoRoot: REPO_ROOT,
        rigDir: RIG_DIR,
        runsDir: RUNS_DIR,
        hashFile: HASH_FILE,
        currentImageHash,
      });
    case "up":
      await ensureUp(
        resolveConfig(process.env, flags, REPO_ROOT).apiUrl,
        prepareRigBinarySelection(resolveRigBinaryPaths(flags), REPO_ROOT),
      );
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
      return watch(resolveConfig(process.env, flags, REPO_ROOT).apiUrl, REPO_ROOT);
    case "down":
      await down(flags.all === "true", HASH_FILE);
      return 0;
    case "gc":
      await gc(RUNS_DIR);
      return 0;
    default:
      console.error(`rig: unknown command ${JSON.stringify(cmd)}\n`);
      console.error(USAGE);
      return 2;
  }
}

await assignMainExit(main, (error) => {
  console.error(`rig: ${error instanceof Error ? error.message : error}`);
});
