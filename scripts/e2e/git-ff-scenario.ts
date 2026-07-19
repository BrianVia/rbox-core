#!/usr/bin/env bun
/**
 * DEV-backed proof that a repository inside a freshly-created workspace is
 * materialized on a paired machine, follows a same-branch fast-forward, and
 * follows subsequent branch checkouts in both directions.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { grantProPlan, resolveSecretFileKey } from "../rig/lib/account.js";
import * as Container from "../rig/lib/container.js";
import { configureUxRuntime } from "../ux/container.js";
import { productionHarness, type CommandResult, type RegressionHarness } from "../ux/regress.js";
import {
  assertBurnCleanup, assertNoResidue, setupMachineA, setupMachineB,
} from "./dev-backed-scenario.js";
import {
  assertDevClerkSecret, burn, DEV_API, mint, resolveTargetApi,
} from "./mint-account.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const REPORT_PATH = path.join(REPO_ROOT, "GIT-FF-REPORT.md");
const CLERK_SECRET_KEY = "CLERK_DEV_SECRET_KEY";
const PLATFORM_SECRET_KEY = "RBOX_DEV_PLATFORM_SECRET";
const PROPAGATION_TIMEOUT_MS = 120_000;
const REPO = "repo";
const INITIAL_README = "git fast-forward fixture\n";
const UPDATED_README = "git fast-forward fixture\nupdated on machine A\n";
const NEW_FILE = "new file from the second commit\n";
const FEATURE_BRANCH = "feature/prop-test";
const FEATURE_FILE = "feature branch commit from machine A\n";

const HELP = `DEV-backed git fast-forward propagation scenario

Usage:
  RBOX_API=${DEV_API} bun scripts/e2e/git-ff-scenario.ts [--dry-run]

The live run requires Docker and DEV keys in dev-keys.local.secret. It targets
only the deployed DEV API, burns every disposable account in finally, retries
the entire scenario once after a wizard screen timeout, and writes
GIT-FF-REPORT.md once after all cleanup is complete.`;

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
  `guard RBOX_API == ${DEV_API} and check Docker before minting`,
  "mint and grant a disposable DEV account",
  "machine A: create repo/ with an initial main commit before running the fresh-user wizard",
  "machine B: pair through the real token flow and verify the exact initial repository state",
  "machine A: modify one tracked file, add one file, and commit on main",
  "machine B: prove exact-HEAD fast-forward, file equality, clean status, and old HEAD in its reflog",
  "machine A: create feature/prop-test, commit a new file, and remain on that branch; machine B follows the checkout and exact HEAD",
  "machine A: switch back to main; machine B follows back while feature/prop-test remains at its exact SHA on both machines",
  "stop daemons, burn the account, destroy both containers, and audit residue",
  "write GIT-FF-REPORT.md once with the final evidence and verdict",
]);

export function renderPlan(lines: readonly string[] = SCENARIO_PLAN): string {
  return ["DEV-backed git fast-forward scenario plan (no actions performed):", ...lines.map((line, i) => `${i + 1}. ${line}`)].join("\n");
}

type StepKey = "machine-a" | "machine-b" | "a-commit" | "b-fast-forward" | "clean-state" | "branch-follow" | "switch-back";
type StepOutcome = "PASS" | "FAIL" | "NOT RUN";

interface StepEvidence {
  label: string;
  outcome: StepOutcome;
  evidence: string;
}

interface AttemptEvidence {
  attempt: number;
  runId: string;
  steps: Partial<Record<StepKey, StepEvidence>>;
  initialHead?: string;
  updatedHead?: string;
  featureHead?: string;
  propagationMs?: number;
  initialLog?: string;
  reflog?: string;
  scenarioPassed: boolean;
  cleanupPassed: boolean;
  cleanupEvidence: string;
  error?: string;
  wizardTimeout: boolean;
}

export interface ScenarioResult {
  target: string;
  attempts: AttemptEvidence[];
  verdict: "PASS" | "FAIL";
  failure?: string;
}

function freshSteps(): Record<StepKey, StepEvidence> {
  return {
    "machine-a": { label: "1. Machine A bootstrap + bind", outcome: "NOT RUN", evidence: "not reached" },
    "machine-b": { label: "2. Machine B pair + initial sync", outcome: "NOT RUN", evidence: "not reached" },
    "a-commit": { label: "3. New commit on A/main", outcome: "NOT RUN", evidence: "not reached" },
    "b-fast-forward": { label: "4. B fast-forward + content", outcome: "NOT RUN", evidence: "not reached" },
    "clean-state": { label: "5. B uncommitted state", outcome: "NOT RUN", evidence: "not reached" },
    "branch-follow": { label: "6. Branch + checkout-follow propagation", outcome: "NOT RUN", evidence: "not reached" },
    "switch-back": { label: "7. Switch back to main", outcome: "NOT RUN", evidence: "not reached" },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWizardScreenTimeout(error: unknown): boolean {
  return /timed out waiting for \/.*\/ on machine [ab]/.test(message(error));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function cleanLine(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function setStep(attempt: AttemptEvidence, key: StepKey, outcome: StepOutcome, evidence: string): void {
  const step = attempt.steps[key];
  if (!step) throw new Error(`missing evidence definition for ${key}`);
  attempt.steps[key] = { ...step, outcome, evidence };
}

async function requireCommand(label: string, command: Promise<CommandResult>): Promise<CommandResult> {
  const result = await command;
  if (result.exitCode !== 0) throw new Error(`${label} failed (exit ${result.exitCode}); child output suppressed`);
  return result;
}

async function waitForRbox(
  h: RegressionHarness,
  runId: string,
  machine: string,
  argv: string[],
  accepts: (result: CommandResult) => boolean,
  label: string,
): Promise<CommandResult> {
  const deadline = h.now() + PROPAGATION_TIMEOUT_MS;
  let result: CommandResult = { stdout: "", stderr: "", exitCode: -1 };
  do {
    result = await h.execRbox(runId, machine, argv);
    if (accepts(result)) return result;
    if (h.now() < deadline) await h.sleep(500);
  } while (h.now() < deadline);
  throw new Error(`timed out waiting for ${label} on machine ${machine}`);
}

async function waitForGuest(
  h: RegressionHarness,
  runId: string,
  machine: string,
  command: string,
  accepts: (result: CommandResult) => boolean,
  label: string,
): Promise<CommandResult> {
  const deadline = h.now() + PROPAGATION_TIMEOUT_MS;
  let result: CommandResult = { stdout: "", stderr: "", exitCode: -1 };
  do {
    result = await h.guest(runId, machine, command);
    if (accepts(result)) return result;
    if (h.now() < deadline) await h.sleep(500);
  } while (h.now() < deadline);
  throw new Error(`timed out waiting for ${label} on machine ${machine}`);
}

async function healthyDaemon(h: RegressionHarness, runId: string, machine: string): Promise<void> {
  await waitForRbox(h, runId, machine, ["status"], (result) => result.exitCode === 0 && /syncing normally/.test(result.stdout), "a healthy daemon");
}

async function seedRepository(h: RegressionHarness, runId: string): Promise<string> {
  const command = [
    "set -eu",
    `mkdir -p ${REPO}/src ${REPO}/docs`,
    `git init -q -b main ${REPO}`,
    `printf %s ${shellQuote(INITIAL_README)} > ${REPO}/README.md`,
    `printf %s ${shellQuote("console.log('initial');\n")} > ${REPO}/src/app.js`,
    `printf %s ${shellQuote("initial notes\n")} > ${REPO}/docs/notes.md`,
    `git -C ${REPO} add -A`,
    `git -C ${REPO} -c user.name='Rbox E2E' -c user.email='e2e@rbox.to' commit -qm 'initial commit'`,
    `git -C ${REPO} rev-parse HEAD`,
  ].join("\n");
  return (await requireCommand("seed git repository on A", h.guest(runId, "a", command))).stdout.trim();
}

async function assertInitialRepository(h: RegressionHarness, runId: string, initialHead: string): Promise<string> {
  const settled = [
    `test -d ${REPO}/.git`,
    `test "$(git -C ${REPO} rev-parse HEAD)" = ${shellQuote(initialHead)}`,
    `test "$(git -C ${REPO} symbolic-ref --short HEAD)" = main`,
    `test -z "$(git -C ${REPO} status --porcelain)"`,
    `test "$(cat ${REPO}/README.md)" = ${shellQuote(INITIAL_README.trimEnd())}`,
  ].join(" && ");
  await waitForGuest(h, runId, "b", settled, (result) => result.exitCode === 0, "the initial git repository");
  const log = (await requireCommand("read initial B log", h.guest(runId, "b", `git -C ${REPO} log --oneline -1`))).stdout.trim();
  const loggedOid = log.split(/\s+/, 1)[0] ?? "";
  if (!loggedOid || !initialHead.startsWith(loggedOid)) throw new Error("B initial git log did not identify A's initial HEAD");
  return log;
}

async function commitUpdate(h: RegressionHarness, runId: string): Promise<{ head: string; committedAt: number }> {
  const command = [
    "set -eu",
    `printf %s ${shellQuote(UPDATED_README)} > ${REPO}/README.md`,
    `printf %s ${shellQuote(NEW_FILE)} > ${REPO}/src/feature.txt`,
    `git -C ${REPO} add -A`,
    `git -C ${REPO} -c user.name='Rbox E2E' -c user.email='e2e@rbox.to' commit -qm 'advance main'`,
    `test -z "$(git -C ${REPO} status --porcelain)"`,
    `git -C ${REPO} rev-parse HEAD`,
  ].join("\n");
  const result = await requireCommand("commit update on A", h.guest(runId, "a", command));
  return { head: result.stdout.trim(), committedAt: h.now() };
}

async function assertFastForward(
  h: RegressionHarness,
  runId: string,
  initialHead: string,
  updatedHead: string,
  committedAt: number,
): Promise<{ propagationMs: number; reflog: string }> {
  const observed = await waitForGuest(
    h,
    runId,
    "b",
    `git -C ${REPO} rev-parse HEAD 2>/dev/null`,
    (result) => result.exitCode === 0 && result.stdout.trim() === updatedHead,
    "B to reach A's updated HEAD",
  );
  if (observed.stdout.trim() !== updatedHead) throw new Error("B updated HEAD differed from A");
  const propagationMs = h.now() - committedAt;

  const settled = [
    `test "$(cat ${REPO}/README.md)" = ${shellQuote(UPDATED_README.trimEnd())}`,
    `test "$(cat ${REPO}/src/feature.txt)" = ${shellQuote(NEW_FILE.trimEnd())}`,
    `test "$(git -C ${REPO} symbolic-ref --short HEAD)" = main`,
    `test -z "$(git -C ${REPO} status --porcelain)"`,
  ].join(" && ");
  await waitForGuest(h, runId, "b", settled, (result) => result.exitCode === 0, "B's followed working tree");
  await requireCommand("prove old HEAD is ancestor of new HEAD on B", h.guest(runId, "b", `git -C ${REPO} merge-base --is-ancestor ${initialHead} ${updatedHead}`));
  const prior = (await requireCommand("read B branch reflog predecessor", h.guest(runId, "b", `git -C ${REPO} rev-parse 'refs/heads/main@{1}'`))).stdout.trim();
  if (prior !== initialHead) throw new Error(`B branch reflog predecessor did not equal the initial HEAD`);
  const reflog = (await requireCommand(
    "read B branch reflog",
    h.guest(runId, "b", `git -C ${REPO} reflog -n 5 --format='%H%x09%gD%x09%gs' refs/heads/main`),
  )).stdout.trim();
  const reflogOids = reflog.split("\n").map((line) => line.split("\t", 1)[0]);
  if (reflogOids[0] !== updatedHead || !reflogOids.includes(initialHead)) {
    throw new Error("B branch reflog did not retain the exact old-to-new history");
  }
  return { propagationMs, reflog };
}

async function commitFeatureBranch(h: RegressionHarness, runId: string, mainHead: string): Promise<string> {
  const command = [
    "set -eu",
    `git -C ${REPO} switch -c ${FEATURE_BRANCH}`,
    `printf %s ${shellQuote(FEATURE_FILE)} > ${REPO}/feature-branch.txt`,
    `git -C ${REPO} add -A`,
    `git -C ${REPO} -c user.name='Rbox E2E' -c user.email='e2e@rbox.to' commit -qm 'add propagation feature'`,
    `test "$(git -C ${REPO} symbolic-ref --short HEAD)" = ${FEATURE_BRANCH}`,
    `test "$(git -C ${REPO} rev-parse refs/heads/main)" = ${shellQuote(mainHead)}`,
    `test -z "$(git -C ${REPO} status --porcelain)"`,
    `git -C ${REPO} rev-parse HEAD`,
  ].join("\n");
  return (await requireCommand("create feature branch and commit on A", h.guest(runId, "a", command))).stdout.trim();
}

async function assertFeatureFollow(
  h: RegressionHarness,
  runId: string,
  mainHead: string,
  featureHead: string,
): Promise<void> {
  const settled = [
    `test "$(git -C ${REPO} symbolic-ref --short HEAD)" = ${FEATURE_BRANCH}`,
    `test "$(git -C ${REPO} rev-parse HEAD)" = ${shellQuote(featureHead)}`,
    `test "$(git -C ${REPO} rev-parse refs/heads/main)" = ${shellQuote(mainHead)}`,
    `test "$(cat ${REPO}/feature-branch.txt)" = ${shellQuote(FEATURE_FILE.trimEnd())}`,
    `test -z "$(git -C ${REPO} status --porcelain)"`,
  ].join(" && ");
  await waitForGuest(h, runId, "b", settled, (result) => result.exitCode === 0, "B to follow feature/prop-test");
}

async function switchBackAndAssert(
  h: RegressionHarness,
  runId: string,
  mainHead: string,
  featureHead: string,
): Promise<void> {
  const switchBack = [
    `git -C ${REPO} switch main`,
    `test "$(git -C ${REPO} rev-parse HEAD)" = ${shellQuote(mainHead)}`,
    `test "$(git -C ${REPO} rev-parse refs/heads/${FEATURE_BRANCH})" = ${shellQuote(featureHead)}`,
    `test -z "$(git -C ${REPO} status --porcelain)"`,
  ].join(" && ");
  await requireCommand("switch A back to main", h.guest(runId, "a", switchBack));

  const settled = [
    `test "$(git -C ${REPO} symbolic-ref --short HEAD)" = main`,
    `test "$(git -C ${REPO} rev-parse HEAD)" = ${shellQuote(mainHead)}`,
    `test "$(git -C ${REPO} rev-parse refs/heads/${FEATURE_BRANCH})" = ${shellQuote(featureHead)}`,
    `test ! -e ${REPO}/feature-branch.txt`,
    `test -z "$(git -C ${REPO} status --porcelain)"`,
  ].join(" && ");
  await waitForGuest(h, runId, "b", settled, (result) => result.exitCode === 0, "B to follow back to main");
}

async function runAttempt(
  attemptNumber: number,
  api: string,
  clerkSecret: string,
  platformSecret: string,
): Promise<AttemptEvidence> {
  const h = productionHarness();
  const runId = `e2e-git-ff-${randomBytes(5).toString("hex")}`;
  const runA = `${runId}-a`;
  const runB = `${runId}-b`;
  const sessionA = `${runId}-a`;
  const sessionB = `${runId}-b`;
  const evidence: AttemptEvidence = {
    attempt: attemptNumber,
    runId,
    steps: freshSteps(),
    scenarioPassed: false,
    cleanupPassed: false,
    cleanupEvidence: "not run",
    wizardTimeout: false,
  };
  const cleanupErrors: string[] = [];
  let account: Awaited<ReturnType<typeof mint>> | undefined;
  let primaryError: unknown;
  let currentStep: StepKey = "machine-a";
  let machineACreated = false;
  let machineBCreated = false;
  let setupADone = false;
  let setupBDone = false;
  let burnVerified = false;

  try {
    process.stdout.write(`[attempt ${attemptNumber}] mint disposable DEV account\n`);
    account = await mint(api, clerkSecret);
    const grant = await grantProPlan(api, account.accountId, platformSecret);
    if (!grant.ok) throw new Error(`DEV plan grant failed (${grant.status}); response body suppressed`);

    process.stdout.write(`[attempt ${attemptNumber}] machine A: seed repo, run wizard, bind, and start sync\n`);
    await h.createMachine(runA, { name: "a", enrolled: false });
    machineACreated = true;
    evidence.initialHead = await seedRepository(h, runA);
    const pairToken = await setupMachineA(h, runA, sessionA, account.sessionToken);
    setupADone = true;
    setStep(evidence, "machine-a", "PASS", `repo/ existed before setup; main initial HEAD ${evidence.initialHead}; wizard bound HOME and started the daemon`);

    currentStep = "machine-b";
    process.stdout.write(`[attempt ${attemptNumber}] machine B: pair and verify initial repository\n`);
    await h.createMachine(runB, { name: "b", enrolled: false });
    machineBCreated = true;
    await setupMachineB(h, runB, sessionB, pairToken);
    setupBDone = true;
    await Promise.all([healthyDaemon(h, runA, "a"), healthyDaemon(h, runB, "b")]);
    evidence.initialLog = await assertInitialRepository(h, runB, evidence.initialHead);
    setStep(evidence, "machine-b", "PASS", `.git present; branch main; HEAD ${evidence.initialHead}; log ${evidence.initialLog}; porcelain empty`);

    currentStep = "a-commit";
    process.stdout.write(`[attempt ${attemptNumber}] machine A: create the second commit on main\n`);
    const update = await commitUpdate(h, runA);
    evidence.updatedHead = update.head;
    if (evidence.updatedHead === evidence.initialHead) throw new Error("A's second commit did not advance HEAD");
    await requireCommand("prove A commit is a fast-forward", h.guest(runA, "a", `git -C ${REPO} merge-base --is-ancestor ${evidence.initialHead} ${evidence.updatedHead}`));
    setStep(evidence, "a-commit", "PASS", `modified README.md, added src/feature.txt, and advanced main to ${evidence.updatedHead}; A porcelain empty`);

    currentStep = "b-fast-forward";
    process.stdout.write(`[attempt ${attemptNumber}] machine B: wait for exact fast-forward and verify contents/reflog\n`);
    const followed = await assertFastForward(h, runB, evidence.initialHead, evidence.updatedHead, update.committedAt);
    evidence.propagationMs = followed.propagationMs;
    evidence.reflog = followed.reflog;
    setStep(evidence, "b-fast-forward", "PASS", `B main == A main at ${evidence.updatedHead}; contents exact; old HEAD is ancestor and refs/heads/main@{1} == ${evidence.initialHead}`);

    currentStep = "clean-state";
    const finalStatus = await requireCommand("read final B status", h.guest(runB, "b", `git -C ${REPO} status --porcelain`));
    if (finalStatus.stdout !== "") throw new Error("B had uncommitted repository state after fast-forward");
    setStep(evidence, "clean-state", "PASS", "git status --porcelain produced no output after all fast-forward checks");

    currentStep = "branch-follow";
    process.stdout.write(`[attempt ${attemptNumber}] machine A: create feature/prop-test and machine B: follow checkout\n`);
    evidence.featureHead = await commitFeatureBranch(h, runA, evidence.updatedHead);
    if (evidence.featureHead === evidence.updatedHead) throw new Error("A's feature commit did not advance HEAD");
    await assertFeatureFollow(h, runB, evidence.updatedHead, evidence.featureHead);
    setStep(evidence, "branch-follow", "PASS", `B checked out feature/prop-test at A's exact HEAD ${evidence.featureHead}; main remained ${evidence.updatedHead}; feature file present; porcelain empty`);

    currentStep = "switch-back";
    process.stdout.write(`[attempt ${attemptNumber}] machine A: switch back to main and machine B: follow back\n`);
    await switchBackAndAssert(h, runA, evidence.updatedHead, evidence.featureHead);
    setStep(evidence, "switch-back", "PASS", `A and B checked out main at ${evidence.updatedHead}; feature/prop-test remained at ${evidence.featureHead} on both machines; B porcelain empty`);
    await Promise.all([healthyDaemon(h, runA, "a"), healthyDaemon(h, runB, "b")]);
    evidence.scenarioPassed = true;
  } catch (error) {
    primaryError = error;
    evidence.error = message(error);
    evidence.wizardTimeout = isWizardScreenTimeout(error);
    setStep(evidence, currentStep, "FAIL", evidence.error);
  } finally {
    process.stdout.write(`[attempt ${attemptNumber}] cleanup: stop, burn, destroy, audit\n`);
    for (const [machineRun, machine, session, created, configured] of [
      [runA, "a", sessionA, machineACreated, setupADone],
      [runB, "b", sessionB, machineBCreated, setupBDone],
    ] as const) {
      if (created) await h.stopTui(machineRun, machine, session).catch(() => {});
      if (created) {
        try {
          const stopped = await h.execRbox(machineRun, machine, ["stop"]);
          if (configured && stopped.exitCode !== 0) cleanupErrors.push(`daemon cleanup (${machine}): exit ${stopped.exitCode}; child output suppressed`);
        } catch (error) {
          if (configured) cleanupErrors.push(`daemon cleanup (${machine}): ${message(error)}`);
        }
      }
    }
    if (account) {
      try {
        const result = await burn(api, clerkSecret, account.accountId);
        assertBurnCleanup(result, account.accountId);
        burnVerified = true;
      } catch (error) {
        cleanupErrors.push(`account cleanup: ${message(error)}`);
      }
    }
    for (const machineRun of [runA, runB]) {
      await h.destroyFlow(machineRun).catch((error) => cleanupErrors.push(`harness cleanup (${machineRun}): ${message(error)}`));
    }
    try { assertNoResidue(await h.auditResidue([runA, runB])); }
    catch (error) { cleanupErrors.push(message(error)); }
    evidence.cleanupPassed = cleanupErrors.length === 0 && (!account || burnVerified);
    evidence.cleanupEvidence = cleanupErrors.length
      ? cleanupErrors.join("; ")
      : `${account ? "account_inaccessible" : "no account minted"}; zero scoped container/volume residue`;
  }

  if (primaryError && !evidence.error) evidence.error = message(primaryError);
  return evidence;
}

async function ensureDockerAvailable(): Promise<void> {
  configureUxRuntime();
  try { await Container.ensureRuntimeReady(); }
  catch (error) { throw new Error(`Docker is unavailable (${message(error)})`); }
}

function reportAttempt(attempt: AttemptEvidence): string[] {
  const lines = [
    `## Attempt ${attempt.attempt}`,
    "",
    `- Run ID: \`${attempt.runId}\``,
    `- Scenario result: **${attempt.scenarioPassed ? "PASS" : "FAIL"}**`,
    `- Cleanup: **${attempt.cleanupPassed ? "PASS" : "FAIL"}** — ${cleanLine(attempt.cleanupEvidence)}`,
  ];
  if (attempt.error) lines.push(`- Error: ${cleanLine(attempt.error)}`);
  if (attempt.wizardTimeout) lines.push("- Retry classification: wizard screen-wait timeout");
  lines.push("", "| Spec step | Outcome | Evidence |", "|---|---:|---|");
  for (const step of Object.values(attempt.steps)) {
    lines.push(`| ${step.label} | **${step.outcome}** | ${cleanLine(step.evidence)} |`);
  }
  if (attempt.initialHead || attempt.updatedHead || attempt.featureHead || attempt.propagationMs !== undefined) {
    lines.push(
      "",
      "### Commit and timing evidence",
      "",
      `- Initial A/B HEAD: ${attempt.initialHead ? `\`${attempt.initialHead}\`` : "not captured"}`,
      `- Updated A/B HEAD: ${attempt.updatedHead ? `\`${attempt.updatedHead}\`` : "not captured"}`,
      `- Feature A/B HEAD: ${attempt.featureHead ? `\`${attempt.featureHead}\`` : "not captured"}`,
      `- A commit completion → B exact-HEAD observation: ${attempt.propagationMs === undefined ? "not captured" : `**${attempt.propagationMs} ms**`}`,
    );
  }
  if (attempt.reflog) {
    lines.push("", "### Machine B `refs/heads/main` reflog", "", "```text", attempt.reflog, "```");
  }
  return lines;
}

export function renderReport(result: ScenarioResult): string {
  const final = result.attempts.at(-1);
  const retryNote = result.attempts.length === 2
    ? `The first attempt hit a wizard screen-wait timeout, cleanup ${result.attempts[0]?.cleanupPassed ? "passed" : "failed"}, and the whole scenario was retried once.`
    : "No wizard screen-wait retry was needed.";
  const lines = [
    "# Git Fast-Forward Propagation E2E Report",
    "",
    `- Final verdict: **${result.verdict}**`,
    `- Target: \`${result.target}\` (DEV only)`,
    `- Completed: ${new Date().toISOString()}`,
    `- Attempts: ${result.attempts.length}`,
    `- Retry: ${retryNote}`,
    `- Initial HEAD: ${final?.initialHead ? `\`${final.initialHead}\`` : "not captured"}`,
    `- Updated HEAD: ${final?.updatedHead ? `\`${final.updatedHead}\`` : "not captured"}`,
    `- Feature HEAD: ${final?.featureHead ? `\`${final.featureHead}\`` : "not captured"}`,
    `- A-commit → B-fast-forward timing: ${final?.propagationMs === undefined ? "not captured" : `**${final.propagationMs} ms**`}`,
  ];
  if (result.failure) lines.push(`- Failure: ${cleanLine(result.failure)}`);
  for (const attempt of result.attempts) lines.push("", ...reportAttempt(attempt));
  lines.push(
    "",
    "## Final assessment",
    "",
    result.verdict === "PASS"
      ? "PASS — the paired repository retained its identity and initial history, then Machine B advanced `main` to the exact commit created on Machine A. The old SHA remained at `refs/heads/main@{1}`, ancestry was fast-forward, and both changed files matched. Machine B then followed A onto `feature/prop-test` at its exact commit and back to `main`, preserving both branch refs and a clean final working tree. The disposable account was burned and no scoped harness residue remained."
      : `FAIL — ${cleanLine(result.failure ?? final?.error ?? "the required proof did not complete")}.`,
    "",
  );
  return lines.join("\n");
}

export async function runScenario(env: NodeJS.ProcessEnv = process.env): Promise<ScenarioResult> {
  const api = resolveTargetApi(env);
  const attempts: AttemptEvidence[] = [];
  try {
    await ensureDockerAvailable();
    const clerkSecret = resolveSecretFileKey(REPO_ROOT, CLERK_SECRET_KEY);
    const platformSecret = resolveSecretFileKey(REPO_ROOT, PLATFORM_SECRET_KEY);
    assertDevClerkSecret(clerkSecret);

    const first = await runAttempt(1, api, clerkSecret, platformSecret);
    attempts.push(first);
    if (first.wizardTimeout) {
      process.stdout.write("[retry] wizard screen-wait timed out; retrying the whole scenario once\n");
      attempts.push(await runAttempt(2, api, clerkSecret, platformSecret));
    }

    const final = attempts.at(-1)!;
    const earlierCleanupPassed = attempts.slice(0, -1).every((attempt) => attempt.cleanupPassed);
    const verdict = final.scenarioPassed && final.cleanupPassed && earlierCleanupPassed ? "PASS" : "FAIL";
    const failure = verdict === "FAIL"
      ? final.error ?? attempts.find((attempt) => !attempt.cleanupPassed)?.cleanupEvidence ?? "scenario or cleanup failed"
      : undefined;
    return { target: api, attempts, verdict, ...(failure ? { failure } : {}) };
  } catch (error) {
    return { target: api, attempts, verdict: "FAIL", failure: message(error) };
  }
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = parseScenarioArgs(argv);
  if (args.help) { process.stdout.write(`${HELP}\n`); return; }
  resolveTargetApi(env);
  if (args.dryRun) { process.stdout.write(`${renderPlan()}\n`); return; }

  const result = await runScenario(env);
  // This is deliberately the sole report write and the final filesystem action
  // after every attempt's daemon, account, container, and volume cleanup.
  await fsp.writeFile(REPORT_PATH, renderReport(result), { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ outcome: result.verdict, report: REPORT_PATH, attempts: result.attempts.length })}\n`);
  if (result.verdict !== "PASS") throw new Error(result.failure ?? "git fast-forward scenario failed");
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`git-ff-scenario: ${message(error)}\n`);
    process.exitCode = 1;
  });
}
