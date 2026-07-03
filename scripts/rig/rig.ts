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
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./lib/container.js";
import { DEFAULT_DEV_API, GUEST, imageHash, NAMES, resolveConfig } from "./lib/config.js";
import { Device } from "./lib/device.js";
import { resolveBootstrapSecret } from "./lib/account.js";
import { getScenario, scenarioNames } from "./scenarios/index.js";
import { finalizeReport, renderReportTable, type RigCtx } from "./scenarios/types.js";

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

const USAGE = `rig — design-56 test bench (P0)

usage:
  rig doctor                          host preflight (read-only)
  rig up [--api-url <url>]            build image + start rig-dev-a/b
  rig run <scenario> [--api-url <url>] [--keep-account]
  rig down [--all]                    tear down containers + network (--all: +image +volumes)

scenarios: ${scenarioNames().join(", ")}
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

async function runScenario(name: string, apiUrl: string, flags: Record<string, string>): Promise<number> {
  const scenario = getScenario(name);
  if (!scenario) {
    console.error(`rig: unknown scenario ${JSON.stringify(name)} (have: ${scenarioNames().join(", ")})`);
    return 2;
  }
  // Resolve the secret up front (never printed) so a misconfig fails before any work.
  const bootstrapSecret = resolveBootstrapSecret(REPO_ROOT);

  await ensureUp(apiUrl);

  const runDir = path.join(RUNS_DIR, `${timestamp()}-${name}`);
  fs.mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, "run.log");
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    fs.appendFileSync(logPath, stamped + "\n");
    console.log(line);
  };
  log(`rig run ${name} — api ${apiUrl} — runDir ${runDir}`);

  const ctx: RigCtx = {
    a: new Device(NAMES.a, apiUrl),
    b: new Device(NAMES.b, apiUrl),
    apiUrl,
    bootstrapSecret,
    runDir,
    keepAccount: flags["keep-account"] === "true",
    log,
  };

  let report;
  try {
    report = await scenario.run(ctx);
  } catch (e) {
    // A scenario should catch its own step errors, but never let an escape crash the
    // harness without a report.
    log(`✗ scenario threw: ${e instanceof Error ? e.message : String(e)}`);
    const now = new Date().toISOString();
    report = finalizeReport({ scenario: name, startedAt: now, finishedAt: now, steps: [{ name: "run", ok: false, ms: 0, detail: String(e) }], assertions: [] });
  }

  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  const table = renderReportTable(report);
  fs.appendFileSync(logPath, table + "\n");
  console.log("\n" + table);
  console.log(`\nreport: ${path.join(runDir, "report.json")}`);
  return report.verdict === "PASS" ? 0 : 1;
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

// ── doctor ──────────────────────────────────────────────────────────────────────

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function doctor(apiUrl: string): Promise<number> {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, detail: string, fix?: string) => checks.push({ label, ok, detail, fix });

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

  let anyFail = false;
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);
    if (!c.ok) {
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
        console.error(`rig: \`run\` needs a scenario (have: ${scenarioNames().join(", ")})`);
        return 2;
      }
      return runScenario(scenario, resolveConfig(process.env, flags, REPO_ROOT).apiUrl, flags);
    }
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
