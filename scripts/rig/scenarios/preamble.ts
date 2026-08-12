/**
 * `provisionPair` — the zero→onboarded handshake every scenario shares (design 56
 * §9). Extracted verbatim from onboard-smoke's preamble so all six scenarios reach
 * "two paired devices, one workspace, converged baseline" through ONE code path
 * (onboard-smoke keeps its own convergence/teardown assertions — this only owns the
 * provisioning steps + their step names, which stay byte-for-byte what P0 shipped).
 *
 * The long-lived bootstrap secret rides ENV expansion. Design 184 intentionally
 * exercises the short-lived pairing token through the canonical argv command;
 * the device transcript redacts it.
 */
import { GUEST } from "../lib/config.js";
import { deleteAccount, grantProPlan, readCredentials } from "../lib/account.js";
import { daemonWatcherMode, type Device } from "../lib/device.js";
import type { RunResult } from "../lib/container.js";
import { waitForPath } from "../lib/waiters.js";
import type { Recorder } from "./harness.js";
import type { RigCtx } from "./types.js";
import { parsePairToken } from "./types.js";

/** design-34 WAF rail — stay below the 64-wide fan-out on push/pull. */
export const CONCURRENCY = "16";

export interface ProvisionOpts {
  /** Seed a deterministic corpus on A before init (shape name, e.g. "tiny"). */
  seedShape?: string;
  /** Corpus seed (content varies, shape fixed). Default 1. */
  seedNum?: number;
  /** Extra per-device seeding on A after the corpus, before init (e.g. a symlink). */
  afterSeedA?: (a: Device) => Promise<void>;
  /** Push from A after init. Default true. */
  push?: boolean;
  /** Pull on B after join. Default true. */
  pull?: boolean;
  /** Extra flags appended to BOTH `init --new` (A) and `init --workspace` (B) — e.g.
   *  `["--git", "false"]` to disable git-sync for a pure plain-file workload. */
  initFlags?: string[];
  /** Flags appended only to B's existing-workspace join. Adoption scenarios use
   * this for explicit headless consent without changing A's create path. */
  joinInitFlags?: string[];
  /** Seed B AFTER pairing but BEFORE `init --workspace` — the non-empty-join
   *  case (a directory with pre-existing content adopting an existing
   *  workspace). The closure captures ctx for cross-device copies. */
  beforeJoinB?: () => Promise<void>;
}

export interface ProvisionResult {
  /** The remote workspace id A created (B joined it). */
  readonly workspaceId: string;
  /** Immutable first-sync surfaces: init --new publishes/attaches implicitly. */
  readonly initA: Readonly<RunResult>;
  /** init --workspace pulls/applies implicitly, even when opts.pull is false. */
  readonly initB: Readonly<RunResult>;
}

export function rigLoginArgv(side: "a" | "b", scenarioName: string, bootstrap = false): string[] {
  return [GUEST.cliExecutable, "login", ...(bootstrap ? ["--bootstrap", "$RIG_BOOT"] : []), "--label", `rig-${side}-${scenarioName}`, "--remote", "$RBOX_API"];
}

export function rigLoginShell(side: "a" | "b", scenarioName: string, bootstrap = false): string {
  const argv = rigLoginArgv(side, scenarioName, bootstrap);
  return argv.map((arg) => arg.startsWith("$") ? `"${arg}"` : arg).join(" ");
}

/** Exact CLI surfaces of a dropped/erroring live-API round trip during setup. */
const PROVISION_TRANSIENT = /HTTP 5\d\d\)|rbox: The operation timed out\./;

/**
 * Run an `init` provisioning call with a single recorded retry when the live
 * API drops the request (HTTP 5xx / CLI timeout). Provisioning is fixture
 * setup, not the contract under test; the retry unbinds the half-initialized
 * directory and re-runs the identical command against the same fresh account.
 * Any other failure — or a failed retry — still throws and aborts the step.
 */
async function initWithTransientRetry(device: Device, log: (line: string) => void, argv: string[]): Promise<RunResult> {
  const run = () => device.rbox(argv, { cwd: GUEST.workDir });
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!PROVISION_TRANSIENT.test(message)) throw error;
    const hasAdoption = (await device.exec(["test", "-f", `${GUEST.workDir}/.rbox/adopt/journal.json`], { allowFail: true })).exitCode === 0;
    if (hasAdoption) {
      log(`  transient provisioning failure — resuming retained adoption once`);
      const status = await device.rbox(["adopt", "status", GUEST.workDir, "--json"], { cwd: GUEST.workDir });
      const phase = (JSON.parse(status.stdout) as { phase?: string }).phase;
      return phase === "complete"
        ? device.rbox(["sync"], { cwd: GUEST.workDir })
        : device.rbox(["adopt", "resume", GUEST.workDir], { cwd: GUEST.workDir });
    }
    log(`  transient provisioning failure — retrying once after unbind`);
    await device.exec(["rm", "-rf", `${GUEST.workDir}/.rbox`], { allowFail: true });
    return await run();
  }
}

/**
 * Run bootstrap→seed→init→push→pair→join→pull across A and B, recording each phase
 * into `rec`. Returns the workspace id. Throws (via `rec.step`) on any hard failure so
 * the caller's try/catch aborts the scenario — exactly as the inline version did.
 */
export async function provisionPair(ctx: RigCtx, rec: Recorder, opts: ProvisionOpts = {}): Promise<ProvisionResult> {
  const doPush = opts.push !== false;
  const doPull = opts.pull !== false;

  // 1. A: bootstrap login (secret via env expansion, never argv).
  await rec.step("[A] login --bootstrap", async () => {
    await ctx.a.rboxShell(
      rigLoginShell("a", ctx.scenarioName, true),
      { env: { RIG_BOOT: ctx.bootstrapSecret }, redact: [ctx.bootstrapSecret] }
    );
  });

  // Bootstrap creates the account in the locked `none` tier (design 86). Read the
  // account id the CLI persisted, then unlock this throwaway account before its
  // first workspace/push. `grantProPlan` independently refuses production.
  await rec.step("[A] grant pro plan", async () => {
    const creds = readCredentials(await ctx.a.readFile(`${GUEST.rboxHome}/credentials.json`));
    if (!creds.accountId) throw new Error("A credentials.json missing accountId after bootstrap");
    const grant = await grantProPlan(ctx.apiUrl, creds.accountId, ctx.platformSecret);
    if (!grant.ok) throw new Error(`account plan grant ${grant.status}: ${grant.body.slice(0, 200)}`);
  });

  // 2. A: seed corpus (optional) + any scenario-specific extra (symlink, …). The
  //    workspace dir must exist before init even when nothing is seeded.
  if (opts.seedShape) {
    await rec.step("[A] seed corpus", async () => {
      await ctx.a.seedCorpus(GUEST.workDir, opts.seedShape!, opts.seedNum ?? 1);
      if (opts.afterSeedA) await opts.afterSeedA(ctx.a);
    });
  } else {
    await rec.step("[A] mkdir workspace", async () => {
      await ctx.a.mkdirp(GUEST.workDir);
      if (opts.afterSeedA) await opts.afterSeedA(ctx.a);
    });
  }

  // 3. A: create the workspace, read its id from the on-disk binding.
  const initialized = await rec.step("[A] init --new", async () => {
    const result = await initWithTransientRetry(ctx.a, ctx.log, ["init", "--new", "--no-interactive", "--remote", ctx.apiUrl, ...(opts.initFlags ?? [])]);
    const cfg = JSON.parse(await ctx.a.readFile(`${GUEST.workDir}/.rbox/workspace.json`)) as { remoteWorkspaceId?: string };
    if (!cfg.remoteWorkspaceId) throw new Error("workspace.json missing remoteWorkspaceId");
    ctx.log(`  workspace ${cfg.remoteWorkspaceId}`);
    return { workspaceId: cfg.remoteWorkspaceId, result };
  });
  const { workspaceId } = initialized;

  // 4. A: push (throttled).
  if (doPush) {
    await rec.step("[A] push", async () => {
      await ctx.a.rbox(["push"], { cwd: GUEST.workDir, env: { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY } });
    });
  }

  // 5. A: mint a pairing token.
  const pairToken = await rec.step("[A] pair", async () => {
    const res = await ctx.a.rbox(["pair"]);
    return parsePairToken(res.stdout);
  });

  // 6. B: execute the canonical one-shot command printed by A. This is the
  // design-184 contract under test: auth + E2EE enrollment through argv.
  await rec.step("[B] connect (redeem pair)", async () => {
    await ctx.b.rbox(["connect", pairToken, "--remote", ctx.apiUrl], {
      redact: [pairToken],
    });
  });

  // 7. B: join the workspace + pull (throttled).
  if (opts.beforeJoinB) {
    await rec.step("[B] pre-join seed (non-empty adopt)", async () => opts.beforeJoinB!());
  }
  const initB = await rec.step(doPull ? "[B] init --workspace + pull" : "[B] init --workspace", async () => {
    await ctx.b.mkdirp(GUEST.workDir);
    const result = await initWithTransientRetry(ctx.b, ctx.log, ["init", "--workspace", workspaceId, "--no-interactive", "--remote", ctx.apiUrl, ...(opts.initFlags ?? []), ...(opts.joinInitFlags ?? [])]);
    if (doPull) await ctx.b.rbox(["pull"], { cwd: GUEST.workDir, env: { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY } });
    return result;
  });

  return { workspaceId, initA: initialized.result, initB };
}

/** How long to wait for a freshly-started daemon to write its first activity.json
 *  heartbeat (design 45: the daemon writes it after the initial convergence pump —
 *  seconds, network-dependent; we poll rather than assume). */
export const DAEMON_READY_TIMEOUT_MS = 30_000;

export interface DaemonModes {
  a: "native" | "polling" | "unknown";
  b: "native" | "polling" | "unknown";
}

/** True once activity.json parses with a string `at` heartbeat. */
function hasHeartbeat(contents: string | undefined): boolean {
  if (contents === undefined) return false;
  try {
    return typeof (JSON.parse(contents) as { at?: unknown }).at === "string";
  } catch {
    return false;
  }
}

/**
 * Start the background-sync daemon on BOTH devices and wait until each has written
 * its first activity.json heartbeat (design 45), then read + record the watcher mode
 * from each daemon's combined dated streams (native @parcel/watcher vs the polling fallback — both are
 * acceptable; design 56 §9 wants the mode logged, not the mechanism asserted).
 * Records a `[X] daemon heartbeat` step per device that FAILS if no heartbeat lands
 * within {@link DAEMON_READY_TIMEOUT_MS}.
 */
export async function startDaemons(ctx: RigCtx, rec: Recorder, env?: Record<string, string>): Promise<DaemonModes> {
  await rec.step("[A] rbox start (daemon)", async () => {
    await ctx.a.daemonStart(GUEST.workDir, env);
  });
  await rec.step("[B] rbox start (daemon)", async () => {
    await ctx.b.daemonStart(GUEST.workDir, env);
  });

  const waitHeartbeat = async (label: "A" | "B", device: Device): Promise<void> => {
    await rec.step(`[${label}] daemon heartbeat`, async () => {
      const out = await waitForPath(device, `${GUEST.workDir}/.rbox/state/activity.json`, hasHeartbeat, DAEMON_READY_TIMEOUT_MS);
      if (!out.ok) throw new Error(`no activity.json heartbeat within ${DAEMON_READY_TIMEOUT_MS}ms`);
    });
  };
  await waitHeartbeat("A", ctx.a);
  await waitHeartbeat("B", ctx.b);

  const [logA, logB] = await Promise.all([ctx.a.readDaemonLogs(GUEST.rboxHome), ctx.b.readDaemonLogs(GUEST.rboxHome)]);
  const modes: DaemonModes = { a: daemonWatcherMode(logA), b: daemonWatcherMode(logB) };
  ctx.log(`  daemon watcher mode — A: ${modes.a}, B: ${modes.b}`);
  return modes;
}

/**
 * Host-side per-run teardown: `DELETE /v1/account` with A's own credentials (design
 * 37 — doubles as a live exercise of the deletion cascade). No-op under
 * `--keep-account`. Records the step + a `account delete 2xx` assertion; throws on a
 * non-2xx so the scenario surfaces a broken teardown. Shared by every scenario so the
 * cleanup path is identical everywhere.
 */
export async function teardownAccount(ctx: RigCtx, rec: Recorder): Promise<void> {
  if (ctx.keepAccount) {
    ctx.log("  (--keep-account) skipping teardown");
    return;
  }
  await rec.step("teardown DELETE /v1/account", async () => {
    const creds = readCredentials(await ctx.a.readFile(`${GUEST.rboxHome}/credentials.json`));
    if (!creds.accountId) throw new Error("A credentials.json missing accountId");
    const del = await deleteAccount(ctx.apiUrl, creds.token, creds.accountId);
    rec.assert("account delete 2xx", del.ok, `${del.status}`);
    if (!del.ok) throw new Error(`account delete ${del.status}: ${del.body.slice(0, 200)}`);
  });
}
