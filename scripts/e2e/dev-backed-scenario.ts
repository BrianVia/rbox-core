#!/usr/bin/env bun
/**
 * Nightly/on-demand onboarding validation against the deployed DEV stack.
 *
 * This deliberately reuses the UX Docker/tmux harness, but is not part of the
 * per-PR regression suite: it needs DEV secrets, Docker, and outbound network.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { grantProPlan, resolveSecretFileKey } from "../rig/lib/account.js";
import * as Container from "../rig/lib/container.js";
import { parsePairToken } from "../rig/scenarios/types.js";
import { configureUxRuntime } from "../ux/container.js";
import { productionHarness, type CommandResult, type RegressionHarness } from "../ux/regress.js";
import {
  assertDevClerkSecret, burn, DEV_API, mint, resolveTargetApi,
} from "./mint-account.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CLERK_SECRET_KEY = "CLERK_DEV_SECRET_KEY";
const PLATFORM_SECRET_KEY = "RBOX_DEV_PLATFORM_SECRET";
const SCREEN_TIMEOUT_SECONDS = 120;
const PROPAGATION_TIMEOUT_MS = 120_000;

const HELP = `Dev-backed onboarding and sync scenario (nightly/on-demand only)

Usage:
  RBOX_API=${DEV_API} bun scripts/e2e/dev-backed-scenario.ts [--dry-run]

The live run requires Docker and reads ${CLERK_SECRET_KEY} and
${PLATFORM_SECRET_KEY} only from dev-keys.local.secret. It never targets prod.`;

export interface ScenarioArgs { dryRun: boolean; help: boolean }

export function parseScenarioArgs(argv: string[]): ScenarioArgs {
  let dryRun = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`unknown option ${arg}; run with --help for usage`);
  }
  return { dryRun, help };
}

export const SCENARIO_PLAN = Object.freeze([
  `guard RBOX_API == ${DEV_API}`,
  "check Docker without mutating account state",
  "read DEV Clerk/platform keys from dev-keys.local.secret",
  "mint and grant a disposable DEV account",
  "machine A: rbox setup via web-approved device code; initialize encryption and a synced folder",
  "machine A: choose Set up another machine now and capture its pairing token",
  "machine B: rbox setup via that pairing token and join A's synced folder",
  "write a unique file on A; require byte-identical content on B and healthy daemons",
  "stop daemons; burn account and require account_inaccessible",
  "destroy the UX run and require no container/volume residue",
]);

export function renderPlan(lines: readonly string[] = SCENARIO_PLAN): string {
  return ["DEV-backed scenario plan (no actions performed):", ...lines.map((line, i) => `${i + 1}. ${line}`)].join("\n");
}

export function extractUserCode(screen: string): string {
  const match = /cli-login\?code=([A-Z0-9]+-[A-Z0-9]+)/.exec(screen);
  if (!match?.[1]) throw new Error("device approval screen did not contain a user code");
  return match[1];
}

export function extractPairingToken(screen: string): string {
  return parsePairToken(screen);
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The short-lived U1 web bearer may approve a pending DEV device code. */
export async function approveDeviceCode(api: string, sessionToken: string, userCode: string, fetchFn: FetchFn = fetch): Promise<void> {
  const target = resolveTargetApi({ RBOX_API: api });
  if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(userCode)) throw new Error("refusing malformed device approval code");
  const response = await fetchFn(`${target}/v1/auth/device/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  if (!response.ok) throw new Error(`DEV device approval failed (${response.status}); response body suppressed`);
}

export function assertBurnCleanup(result: { accountId: string; status: string; verified: string }, accountId: string): void {
  if (result.accountId !== accountId || result.status !== "pending" || result.verified !== "account_inaccessible") {
    throw new Error("burn did not prove the disposable account inaccessible");
  }
}

export function assertNoResidue(residue: readonly string[]): void {
  if (residue.length) throw new Error(`UX cleanup left scoped residue: ${residue.join(", ")}`);
}

async function ensureDockerAvailable(): Promise<void> {
  configureUxRuntime();
  try {
    await Container.ensureRuntimeReady();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker is unavailable; run with --dry-run to inspect the plan. The orchestrator runs the live scenario. (${detail})`);
  }
}

function fileSecret(key: string): string {
  return resolveSecretFileKey(REPO_ROOT, key);
}

function exactMatch(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export async function waitForScreen(
  harness: Pick<RegressionHarness, "screen" | "sleep" | "now">,
  runId: string,
  machine: string,
  session: string,
  pattern: RegExp,
  timeoutSeconds = SCREEN_TIMEOUT_SECONDS,
): Promise<string> {
  const deadline = harness.now() + timeoutSeconds * 1000;
  let screen = await harness.screen(runId, machine, session);
  while (!exactMatch(pattern, screen) && harness.now() < deadline) {
    await harness.sleep(250);
    screen = await harness.screen(runId, machine, session);
  }
  if (!exactMatch(pattern, screen)) {
    // Screens can contain secrets (pairing tokens); errors must stay
    // secret-free (pinned by test). Debuggability via a local artifact file.
    const artifact = `/tmp/rbox-e2e-${process.pid}-${machine}-timeout.screen`;
    try { require("node:fs").writeFileSync(artifact, screen, { mode: 0o600 }); } catch {}
    throw new Error(`timed out waiting for /${pattern.source}/ on machine ${machine} (screen: ${artifact})`);
  }
  return screen;
}

async function requireCommand(label: string, command: Promise<CommandResult>): Promise<CommandResult> {
  const result = await command;
  if (result.exitCode !== 0) throw new Error(`${label} failed (exit ${result.exitCode}); child output suppressed`);
  return result;
}

async function waitForCommand(
  harness: RegressionHarness,
  runId: string,
  machine: string,
  argv: string[],
  accepts: (result: CommandResult) => boolean,
  timeoutMs: number,
): Promise<CommandResult> {
  const deadline = harness.now() + timeoutMs;
  let result: CommandResult;
  do {
    result = await harness.execRbox(runId, machine, argv);
    if (accepts(result)) return result;
    if (harness.now() < deadline) await harness.sleep(500);
  } while (harness.now() < deadline);
  throw new Error(`timed out waiting for rbox ${argv[0] ?? "command"} on machine ${machine}`);
}

export async function setupMachineA(
  h: RegressionHarness,
  runId: string,
  session: string,
  sessionToken: string,
  approve: typeof approveDeviceCode = approveDeviceCode,
): Promise<string> {
  await h.startTui(runId, "a", session, "setup");
  await waitForScreen(h, runId, "a", session, /Are you new here,[\s\S]*or do you already have an rbox account\?/);
  await h.keys(runId, "a", session, ["Enter"]); // Create a new account
  await waitForScreen(h, runId, "a", session, /Press Enter to sign up in your browser/);
  await h.keys(runId, "a", session, ["Enter"]); // blank secret -> device-code path
  const approval = await waitForScreen(h, runId, "a", session, /cli-login\?code=[A-Z0-9-]+/);
  await approve(DEV_API, sessionToken, extractUserCode(approval));

  await waitForScreen(h, runId, "a", session, /Set up encryption on this first machine now\?/);
  await h.keys(runId, "a", session, ["Enter"]); // default Yes / genesis
  await waitForScreen(h, runId, "a", session, /Save a recovery kit \(writes the phrase in PLAINTEXT to ~\)\?/);
  await h.keys(runId, "a", session, ["n", "Enter"]); // never write plaintext kits in test containers
  await waitForScreen(h, runId, "a", session, /Have you saved this recovery phrase somewhere safe\?/);
  await h.keys(runId, "a", session, ["y", "Enter"]); // confirmation defaults No
  await waitForScreen(h, runId, "a", session, /Which folder do you want to sync\?/);
  await h.keys(runId, "a", session, ["Down", "Enter"]); // custom local folder
  await waitForScreen(h, runId, "a", session, /Which folder should rbox sync\?/);
  await h.keys(runId, "a", session, ["Enter"]); // machine A HOME
  await waitForScreen(h, runId, "a", session, /Display name \(Enter accepts,[\s\S]*for none\)/);
  await h.keys(runId, "a", session, ["dev-e2e", "Enter"]);
  await waitForScreen(h, runId, "a", session, /How should rbox handle gitignored files\?/);
  await h.keys(runId, "a", session, ["Enter"]);
  await waitForScreen(h, runId, "a", session, /Keep this folder syncing in the background\?/, 180);
  await h.keys(runId, "a", session, ["Down", "Enter"]); // daemon now, no autostart
  await waitForScreen(h, runId, "a", session, /Set up another machine now/, 180);
  await h.keys(runId, "a", session, ["Enter"]); // validation #19 inline pair action
  const paired = await waitForScreen(h, runId, "a", session, /rbox-pair_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, 180);
  return extractPairingToken(paired);
}

export async function setupMachineB(h: RegressionHarness, runId: string, session: string, pairToken: string): Promise<void> {
  await h.startTui(runId, "b", session, "setup");
  await waitForScreen(h, runId, "b", session, /Are you new here,[\s\S]*or do you already have an rbox account\?/);
  await h.keys(runId, "b", session, ["Down", "Enter"]); // existing account
  await waitForScreen(h, runId, "b", session, /How do you want to authorize this machine\?/);
  await h.keys(runId, "b", session, ["Down", "Enter"]); // pairing token
  await waitForScreen(h, runId, "b", session, /Paste pairing token/);
  await h.pasteBuffer(runId, "b", session, pairToken);
  await h.keys(runId, "b", session, ["Enter"]);
  await waitForScreen(h, runId, "b", session, /Which folder do you want to sync\?/, 180);
  await h.keys(runId, "b", session, ["Down", "Down", "Enter"]); // folder from another machine
  await waitForScreen(h, runId, "b", session, /Pick a folder to sync from another machine/);
  await h.keys(runId, "b", session, ["Enter"]); // sole disposable workspace
  await waitForScreen(h, runId, "b", session, /Which folder should rbox sync\?/);
  await h.keys(runId, "b", session, ["Enter"]); // machine B HOME
  await waitForScreen(h, runId, "b", session, /Keep this folder syncing in the background\?/, 180);
  await h.keys(runId, "b", session, ["Down", "Enter"]); // daemon now, no autostart
  await waitForScreen(h, runId, "b", session, /Set up another machine now/, 180);
  await h.keys(runId, "b", session, ["Down", "Enter"]); // exit
  await waitForScreen(h, runId, "b", session, /To pair more devices later/, 60);
}

function cleanupMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLiveScenario(env: NodeJS.ProcessEnv = process.env): Promise<{ runId: string; accountId: string; verified: string }> {
  const api = resolveTargetApi(env);
  await ensureDockerAvailable(); // fail before minting anything
  const clerkSecret = fileSecret(CLERK_SECRET_KEY);
  const platformSecret = fileSecret(PLATFORM_SECRET_KEY);
  assertDevClerkSecret(clerkSecret);

  const h = productionHarness();
  const runId = `e2e-dev-${randomBytes(5).toString("hex")}`;
  // The UX harness keys a container by run id. Give each logical machine its
  // own run id so this scenario exercises a genuine two-container boundary,
  // while retaining the established isolated-HOME/tmux driver unchanged.
  const runA = `${runId}-a`;
  const runB = `${runId}-b`;
  const sessionA = `${runId}-a`;
  const sessionB = `${runId}-b`;
  const cleanupErrors: string[] = [];
  let account: Awaited<ReturnType<typeof mint>> | undefined;
  let primaryError: unknown;
  let verified = "not_burned";
  let setupADone = false;
  let setupBDone = false;

  try {
    process.stdout.write("[1/7] mint disposable DEV account\n");
    account = await mint(resolveTargetApi({ RBOX_API: api }), clerkSecret);
    const grant = await grantProPlan(resolveTargetApi({ RBOX_API: api }), account.accountId, platformSecret);
    if (!grant.ok) throw new Error(`DEV plan grant failed (${grant.status}); response body suppressed`);

    process.stdout.write("[2/7] set up machine A through the real device-code wizard\n");
    await h.createMachine(runA, { name: "a", enrolled: false });
    const pairToken = await setupMachineA(h, runA, sessionA, account.sessionToken);
    setupADone = true;

    process.stdout.write("[3/7] pair and set up machine B\n");
    await h.createMachine(runB, { name: "b", enrolled: false });
    await setupMachineB(h, runB, sessionB, pairToken);
    setupBDone = true;

    process.stdout.write("[4/7] verify A to B propagation and daemon state\n");
    const body = `dev-e2e-${randomBytes(24).toString("base64url")}`;
    await requireCommand("write fixture on A", h.guest(runA, "a", `printf '%s' '${body}' > dev-e2e-probe.txt`));
    await waitForCommand(h, runB, "b", ["status"], (r) => r.exitCode === 0 && /syncing normally/.test(r.stdout), PROPAGATION_TIMEOUT_MS);
    await waitForCommand(h, runA, "a", ["status"], (r) => r.exitCode === 0 && /syncing normally/.test(r.stdout), PROPAGATION_TIMEOUT_MS);
    const deadline = h.now() + PROPAGATION_TIMEOUT_MS;
    let received = "";
    do {
      const result = await h.guest(runB, "b", "cat dev-e2e-probe.txt 2>/dev/null");
      if (result.exitCode === 0) received = result.stdout;
      if (received === body) break;
      if (h.now() < deadline) await h.sleep(500);
    } while (h.now() < deadline);
    if (received !== body) throw new Error("A to B content equality timed out");
    await waitForCommand(h, runA, "a", ["status"], (r) => r.exitCode === 0 && /syncing normally/.test(r.stdout), PROPAGATION_TIMEOUT_MS);
    await waitForCommand(h, runB, "b", ["status"], (r) => r.exitCode === 0 && /syncing normally/.test(r.stdout), PROPAGATION_TIMEOUT_MS);
  } catch (error) {
    primaryError = error;
  } finally {
    process.stdout.write("[5/7] stop sessions and daemons\n");
    for (const [machineRun, machine, session, configured] of [[runA, "a", sessionA, setupADone], [runB, "b", sessionB, setupBDone]] as const) {
      await h.stopTui(machineRun, machine, session).catch(() => {});
      if (configured) {
        try {
          const stopped = await h.execRbox(machineRun, machine, ["stop"]);
          if (stopped.exitCode !== 0) cleanupErrors.push(`daemon cleanup (${machine}): exit ${stopped.exitCode}; child output suppressed`);
        } catch (error) {
          cleanupErrors.push(`daemon cleanup (${machine}): ${cleanupMessage(error)}`);
        }
      }
    }
    if (account) {
      process.stdout.write("[6/7] burn disposable DEV account and verify inaccessibility\n");
      try {
        const result = await burn(resolveTargetApi({ RBOX_API: api }), clerkSecret, account.accountId);
        assertBurnCleanup(result, account.accountId);
        verified = result.verified;
      } catch (error) {
        cleanupErrors.push(`account cleanup: ${cleanupMessage(error)}`);
      }
    }
    process.stdout.write("[7/7] destroy harness resources and audit residue\n");
    for (const machineRun of [runA, runB]) {
      await h.destroyFlow(machineRun).catch((error) => cleanupErrors.push(`harness cleanup (${machineRun}): ${cleanupMessage(error)}`));
    }
    try { assertNoResidue(await h.auditResidue([runA, runB])); }
    catch (error) { cleanupErrors.push(cleanupMessage(error)); }
  }

  const failures = [primaryError ? cleanupMessage(primaryError) : "", ...cleanupErrors].filter(Boolean);
  if (failures.length) throw new Error(failures.join("; "));
  return { runId, accountId: account!.accountId, verified };
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = parseScenarioArgs(argv);
  if (args.help) { process.stdout.write(`${HELP}\n`); return; }
  resolveTargetApi(env); // dry-run is guarded too; it never reads secrets or touches Docker
  if (args.dryRun) { process.stdout.write(`${renderPlan()}\n`); return; }
  const result = await runLiveScenario(env);
  process.stdout.write(`${JSON.stringify({ ...result, outcome: "PASS" })}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`dev-backed-scenario: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
