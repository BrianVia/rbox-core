/**
 * `rbox setup` (design 29) — the single, guided front door, and what bare `rbox`
 * runs in a TTY. A thin presentation layer over already-verified primitives
 * (`runInit`, `login`/`redeemPair`, `startDaemon`), arranged into the founder's
 * three-step arc: Account → Folder → Start syncing. It replaces `menu-cmd.ts`'s
 * `runMenu`; the menu's "just authorize this machine" option is dropped (served
 * directly by `rbox login`).
 *
 * Every interactive widget is an Ink component routed through `./prompt.js` —
 * so menus are arrow-key choices (no
 * invalid-input loops), Ctrl-C exits cleanly (130), and EVERYTHING renders on
 * STDERR (so `rbox setup > log` never pollutes stdout). The lone pure mapper that
 * remains, `workspaceFlags`, carries the Step-2 transition and is unit-tested.
 *
 * Enrollment gap: a device-code login authorizes but does NOT enroll this machine
 * for encryption (auth-cmd.ts:78), and `runInit` aborts pre-sync when unenrolled
 * (init-cmd.ts). So when a device is authorized-but-unenrolled — either freshly after
 * a device-code login inside Step 1, or on a later re-run of `rbox setup` — the flow
 * offers inline enrollment resolution (paste a pairing token, or recover with the
 * 24-word phrase), or lets the user defer and re-run later. It never restarts the
 * new/existing account picker for a machine that's already signed in, and never
 * promises Steps 2–3 it can't deliver.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { GITIGNORE_CHOICES, continueInitWithPrecreatedWorkspace, preflightInitRebind, runInit } from "./init-cmd.js";
import { mintWizardAdoptConsent, type AdoptConsentWitness } from "./adopt-consent.js";
import { rootHasAdoptableContent } from "./adopt-inventory.js";
import { collapseHome, interpretWorkspaceNameAnswer } from "./init-plan.js";
import { EXISTING_ACCOUNT_ENROLLMENT_MESSAGE, login, offerRecoveryKitAfterRecover, pairCreate, redeemPair, runGenesisEnrollment } from "./auth-cmd.js";
import { enrollViaPrevalidatedRecovery, PairingTokenShapeError, parsePairingToken } from "./e2ee-client.js";
import { genesisClassifierConsultationNeeded, pendingGenesisState } from "./genesis-enrollment.js";
import { phraseToRk, rkToPhrase } from "../engine/e2ee/index.js";
import { enableAutostart, startDaemonForUser } from "./autostart-cmd.js";
import { credentialsForStrictFlow, loadCredentials, type CredentialLoadResult } from "./credentials.js";
import { loadConfigIfPresent, loadRawState, syncStreamId } from "./config.js";
import { hasDevice } from "./e2ee-keystore.js";
import { createRemoteWorkspace, RboxApi } from "./remote.js";
import { promptWorkspacePick } from "./workspace-picker.js";
import { isInteractive, promptSelect, promptInput, promptConfirm, promptPassword, promptPath } from "./prompt.js";
import { stderrStyle as e } from "./style.js";
import { checkoutUrl, type BillingCadence, type SubscribePlan } from "./subscribe-cmd.js";
import { openAndShow } from "./browser-open.js";
import { hasKeyInput, runKeyedSetup } from "./setup-keyed.js";
import { getIdentity, identityText } from "./account-profile.js";
import { WORKSPACE_MINT_RERUN_HINT } from "./remote/errors.js";
import { fetchWithDeadline } from "./remote/resilient.js";
import { rboxBanner } from "./wordmark.js";
import {
  acquireWorkspaceSyncMutex,
  releaseWorkspaceSyncMutex,
  workspaceSyncMutexDegraded,
  type WorkspaceSyncMutex,
} from "./sync-mutex.js";
import {
  createWorkspaceWithConsent,
  mintSetupCreateConsent,
  mintSetupExistingConsent,
  type ResetConsentWitness,
} from "./reset-consent.js";
import { homeDir } from "./rbox-paths.js";

/** Map a workspace decision to the exact `runInit` flags (the populate-sync runs
 *  inside runInit: push for a new workspace, pull+push for a join). */
export function workspaceFlags(plan: { kind: "new" | "join"; root: string; workspace?: string; name?: string; respectGitignore?: boolean }): Record<string, string> {
  const flags: Record<string, string> = { root: plan.root, project: "root", "no-interactive": "true" };
  if (plan.kind === "new") flags.new = "true";
  else flags.workspace = plan.workspace ?? "";
  // On a CREATE the name is sent to the server (createRemoteWorkspace); on a JOIN it's
  // a purely-LOCAL display label from the picker — never re-sent (the row already
  // exists, first-writer-wins). Manual-id entry has no name, so the flag is simply
  // absent and status falls back to the id.
  if (plan.name) flags.name = plan.name;
  if (plan.kind === "new" && plan.respectGitignore === true) flags["respect-gitignore"] = "true";
  return flags;
}

/** Step 3 · Start syncing. One `select` replaced the old keep→resume double-confirm
 *  (the founder mistook a Y/N for a text field once); "both" is the recommended first
 *  option so a bare ENTER reproduces the old default:true+ENTER outcome. */
export type StartSyncChoice = "both" | "start" | "none";

/** The Step-3 choices, exported so the test pins the ORDERED labels+values against
 *  `startSyncActions` — a re-shuffle or value swap in the live select can't silently
 *  invert which option starts the daemon / enables autostart. */
export const START_SYNC_CHOICES = [
  { name: "Start background sync now and on machine boot (recommended)", value: "both" },
  { name: "Start background sync now only", value: "start" },
  { name: "Not now", value: "none" },
] as const satisfies ReadonlyArray<{ name: string; value: StartSyncChoice }>;

/** Map the Step-3 choice to its two side effects. Pure so the three-way branching is
 *  pinned by a unit test without driving the TUI widget (mirrors `workspaceFlags`
 *  and `authorizePath`). "both" starts the daemon AND enables autostart; "start" starts
 *  the daemon only; "none" does neither. */
export function startSyncActions(choice: StartSyncChoice): { startDaemon: boolean; enableAutostart: boolean } {
  return { startDaemon: choice !== "none", enableAutostart: choice === "both" };
}

export type SetupCompletionChoice = "pair" | "exit";

/** Keep the live labels and their effects coupled through a unit-tested mapper. */
export const SETUP_COMPLETION_CHOICES = [
  { name: "Set up another machine now", value: "pair" },
  { name: "Exit", value: "exit" },
] as const satisfies ReadonlyArray<{ name: string; value: SetupCompletionChoice }>;

export function setupCompletionActions(choice: SetupCompletionChoice): { createPairingToken: boolean } {
  return { createPairingToken: choice === "pair" };
}

/** Loop Step 2 only for explicit pre-init navigation; consume preselection once. */
export async function runWorkspaceStepLoop(
  opts: { cwd: string; defaultRemote: string },
  setupOpts: {
    noSync?: boolean;
    preselectedKind?: WorkspaceKind;
    header: string;
    credentialResult?: CredentialLoadResult;
    excludedRoot?: string;
    newFolderDefault?: string | null;
  },
  runStep: typeof stepWorkspace = stepWorkspace
): Promise<{ workspaceId: string; workspaceName?: string; deviceId: string; root: string } | undefined> {
  let preselectedKind = setupOpts.preselectedKind;
  for (;;) {
    const selectedForThisAttempt = preselectedKind;
    preselectedKind = undefined;
    const result = await runStep(opts, { ...setupOpts, preselectedKind: selectedForThisAttempt });
    if (result.kind === "menu") continue;
    return result.kind === "completed" ? result.outcome : undefined;
  }
}

const HR = "─".repeat(72);

// ── the guided flow ───────────────────────────────────────────────────────────

export type WorkspaceKind = "new" | "existing";
export type FolderSetupChoice = "default" | WorkspaceKind;

export const defaultSyncFolder = (home = homeDir()): string => path.join(home, "rbox");

const SYNCED_FOLDER_DEFINITION = "rbox keeps one folder in sync; it can contain one repository, many repositories, or ordinary files.";

/** Name rbox and distinguish a local folder from something already in the account.
 *  The original generic "new workspace" / "existing workspace" labels left first-time
 *  users unsure whether they were choosing an rbox concept or a directory on disk. */
export const WORKSPACE_KIND_CHOICES = [
  { name: "Sync ~/rbox (recommended)", value: "default", description: "create it if needed, then sync everything inside" },
  { name: "Sync another folder on this machine", value: "new" },
  { name: "Sync a folder from another machine", value: "existing", description: "choose one you've synced before" },
] as const satisfies ReadonlyArray<{ name: string; value: FolderSetupChoice; description?: string }>;

/** Steady-state step header. The subscribe-gated path intentionally still says
 *  "of 3": step 3 (start syncing) exists but is deferred until `rbox subscribe`
 *  (the yellow notice explains), so a fixed denominator stays honest. */
export const stepHeader = (step: number, total: 2 | 3, label: string): string => `Step ${step} of ${total} · ${label}`;

interface EnrolledSkipNoticeDeps {
  getIdentity?: typeof getIdentity;
  writeStderr?: (text: string) => void;
}

export async function writeEnrolledSkipNotice(accountId: string, deps: EnrolledSkipNoticeDeps = {}): Promise<void> {
  const identity = await (deps.getIdentity ?? getIdentity)(accountId);
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  writeStderr(
    identity
      ? `${e.dim(`Signed in as ${identityText(identity.email, identity.signInMethod)} — skipping account setup.`)}\n`
      : `${e.dim(`Signed in and enrolled (${e.cyan(accountId)}) — skipping account setup.`)}\n`
  );
}

export async function runSetup(opts: {
  cwd: string;
  defaultRemote: string;
  flags?: Record<string, string>;
  preselectedWorkspaceKind?: WorkspaceKind;
  /** Test seam: callers normally inherit the real stdin TTY state. */
  interactive?: () => boolean;
  /** The untracked menu is only reachable after `resolveBareRboxTarget` verifies
   * enrollment, so this path skips the welcome banner and account step. */
  viaUntrackedMenu?: boolean;
  /** Used by the tracked-folder front door so “another” cannot select the
   * already-bound root and enter the rebind flow. */
  excludedRoot?: string;
  /** `null` deliberately omits a default; `undefined` preserves cwd. */
  newFolderDefault?: string | null;
}): Promise<void> {
  const flags = opts.flags ?? {};
  if (flags.key && flags.key !== "true" && flags.key !== "-") {
    throw new Error("refusing --key=<value>: argv leaks secrets via shell history and process listings. Use RBOX_KEY, --key-file <path>, or --key -.");
  }
  if (flags.workspace) {
    if (!hasKeyInput(flags)) throw new Error("--workspace requires a key: set RBOX_KEY or pass --key-file/--key -");
    await runKeyedSetup(opts.cwd, opts.defaultRemote, flags);
    return;
  }
  if (["dir", "daemon", "pull-only", "force"].some((flag) => flags[flag] !== undefined)) {
    process.stderr.write("note: --dir/--daemon/--pull-only/--force only apply to keyed setup (--workspace <name|id> with a key) — ignored in the guided flow.\n");
  }
  if (!(opts.interactive ?? (() => process.stdin.isTTY === true))()) {
    process.stderr.write(
      "rbox setup is interactive. For scripts/CI use `rbox init` " +
        "(e.g. `rbox init --new --root <path> --bootstrap <secret>`). Run `rbox help init` for details.\n"
    );
    process.exitCode = 1;
    return;
  }

  // Step 1 · Account — unless this machine is already enrolled. When credentials
  // already exist but enrollment doesn't (authorized-but-unenrolled from a prior
  // device-code login), resolve enrollment inline instead of restarting the full
  // new/existing picker as if the user had never signed in.
  let syncDisabledUntilSubscribe = false;
  const viaUntrackedMenu = opts.viaUntrackedMenu === true;
  const initialCredentials = viaUntrackedMenu ? undefined : await loadCredentials();
  const initialCreds = initialCredentials ? credentialsForStrictFlow(initialCredentials) : undefined;
  let workspaceCredentialResult = initialCredentials;
  const accountId = viaUntrackedMenu ? undefined : await enrolledAccountId(initialCredentials);
  const accountSkipped = viaUntrackedMenu || accountId !== undefined;
  // Via the untracked menu, enrollment was verified by resolveBareRboxTarget and
  // the menu printed its own banner — skip both.
  if (!viaUntrackedMenu) {
    process.stderr.write(rboxBanner());
    if (accountId) {
      await writeEnrolledSkipNotice(accountId);
    } else {
      process.stderr.write(`\n${e.bold(stepHeader(1, 3, "Account"))}\n`);
      const hasCreds = Boolean(initialCreds?.accountId);
      const result = hasCreds
        ? {
            ok: await resolveEnrollment(opts.defaultRemote, { loadCredentials: async () => initialCredentials! }),
            created: false,
          }
        : await stepAccount(opts.defaultRemote);
      if (!result.ok) return;
      if (result.created) {
        const enrolledCredentials = await loadCredentials();
        credentialsForStrictFlow(enrolledCredentials);
        workspaceCredentialResult = enrolledCredentials;
        syncDisabledUntilSubscribe = !(await startTrialAfterAccountCreation(enrolledCredentials));
      } else {
        // Account authorization/enrollment may have completed a login or pairing
        // save. Observe that transition once, then carry the result through every
        // following workspace mutation.
        workspaceCredentialResult = await loadCredentials();
        credentialsForStrictFlow(workspaceCredentialResult);
      }
    }
  }

  if (!workspaceCredentialResult) {
    workspaceCredentialResult = await loadCredentials();
    credentialsForStrictFlow(workspaceCredentialResult);
  }

  // Step 2 · Folder — bind a directory + run the initial populate-sync.
  const shortFlow = accountSkipped;
  const outcome = await runWorkspaceStepLoop(opts, {
    noSync: syncDisabledUntilSubscribe,
    preselectedKind: opts.preselectedWorkspaceKind,
    header: shortFlow ? stepHeader(1, 2, "Folder") : stepHeader(2, 3, "Folder"),
    credentialResult: workspaceCredentialResult,
    excludedRoot: opts.excludedRoot,
    newFolderDefault: opts.newFolderDefault,
  });
  if (!outcome) return;

  if (syncDisabledUntilSubscribe) {
    process.stderr.write(`${e.yellow("!")}  Sync is disabled until you run \`rbox subscribe\` and choose a plan.\n`);
    await finishSetup(outcome.root);
    return;
  }

  // Step 3 · Start syncing in the background.
  process.stderr.write(`\n${e.bold(shortFlow ? stepHeader(2, 2, "Start syncing") : stepHeader(3, 3, "Start syncing"))}\n`);
  const startChoice = await promptSelect<StartSyncChoice>({
    message: "Keep this folder syncing in the background?",
    choices: START_SYNC_CHOICES,
  });
  const actions = startSyncActions(startChoice);
  if (actions.startDaemon) {
    await startDaemonForUser(outcome.root, { mode: "read-write" });
    process.stderr.write(`${e.green("✓")} Background sync started. Stop anytime with \`rbox stop\`.\n`);
    if (actions.enableAutostart) {
      await enableAutostart();
      process.stderr.write(`${e.green("✓")} autostart enabled\n`);
    } else {
      process.stderr.write(`${e.dim("Enable start-on-boot later with `rbox autostart enable`.")}\n`);
    }
  } else {
    process.stderr.write(`${e.dim("Run `rbox start` whenever you're ready.")}\n`);
  }

  // Opt-in dependency-change notifications (drift surface 1) — commented out
  // (design 51): the shell hook this installs runs `rbox deps drift --quiet`,
  // and the whole `deps` CLI group is currently disabled (index.ts). Prompting
  // for and silently installing a hook that always fails is worse than not
  // asking. Re-enable together with `deps` itself.
  //
  // const notify = await promptConfirm({ message: "Be notified when dependencies change?", default: true });
  // if (notify) {
  //   const { installNotify } = await import("./deps-notify.js");
  //   try {
  //     await installNotify();
  //   } catch (err) {
  //     process.stderr.write(`${e.yellow("!")} ${err instanceof Error ? err.message : String(err)}\n`);
  //   }
  // }

  await finishSetup(outcome.root);
}

/** The enrolled account id, or undefined when signed out / not enrolled. */
export async function enrolledAccountId(loaded?: CredentialLoadResult): Promise<string | undefined> {
  const creds = credentialsForStrictFlow(loaded ?? await loadCredentials());
  if(!creds?.accountId)return undefined;
  if(await genesisClassifierConsultationNeeded(creds.accountId)){
    if(!creds.deviceId)return undefined;
    const result=await runGenesisEnrollment(new RboxApi(creds.remoteUrl,creds.token,"",""),{accountId:creds.accountId,deviceId:creds.deviceId});
    if(result==="enrolled")return creds.accountId;
  }
  return await hasDevice(creds.accountId)?creds.accountId:undefined;
}

/** True when this machine already holds the account's key material (skip Step 1). */
export async function alreadyEnrolled(): Promise<boolean> {
  return (await enrolledAccountId()) !== undefined;
}

/** Step 1 · Account. Returns true if this machine is now enrolled (flow continues),
 *  false if it hard-stopped on the device-code (authorize-only) path. */
interface StepAccountResult {
  ok: boolean;
  created: boolean;
}

export const GENESIS_BROWSER_PROMPT = "Press Enter to sign up in your browser.";
export const GENESIS_BOOTSTRAP_HINT = "(have a bootstrap secret? type it now — input hidden)";
export const AUTHORIZATION_RECOVERY_FOOTER =
  "lost access to your other machines? Sign in via browser, then choose 'Recover with my 24-word phrase'";

interface WizardPairDeps {
  promptPassword?: typeof promptPassword;
  redeemPair?: typeof redeemPair;
  writeStderr?: (text: string) => void;
}

/** Local-only three-attempt token gate followed by one possibly-consuming redeem. */
export async function redeemPairInWizard(remote: string, deps: WizardPairDeps = {}): Promise<"enrolled" | "parent"> {
  const ask = deps.promptPassword ?? promptPassword;
  const redeem = deps.redeemPair ?? redeemPair;
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = (await ask({ message: "Paste pairing token" })).trim();
    try {
      parsePairingToken(token);
    } catch (error) {
      if (!(error instanceof PairingTokenShapeError)) throw error;
      writeStderr(`${e.yellow(error.message)}\n`);
      continue;
    }
    try {
      await redeem(remote, token, undefined, "wizard");
      return "enrolled";
    } catch (error) {
      writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
      writeStderr("if this token was minted recently, it may now be used up — mint a fresh one with `rbox pair` on the other machine\n");
      return "parent";
    }
  }
  return "parent";
}

interface WizardRecoveryDeps {
  promptInput?: typeof promptInput;
  parsePhrase?: typeof phraseToRk;
  enroll?: typeof enrollViaPrevalidatedRecovery;
  writeStderr?: (text: string) => void;
  now?: () => number;
  loadedCredentials?: CredentialLoadResult;
  offerRecoveryKit?: typeof offerRecoveryKitAfterRecover;
}

/** Validate the phrase locally up to three times, then make one continuation attempt. */
export async function recoverInWizard(deps: WizardRecoveryDeps = {}): Promise<"enrolled" | "parent"> {
  const ask = deps.promptInput ?? promptInput;
  const parse = deps.parsePhrase ?? phraseToRk;
  const enroll = deps.enroll ?? enrollViaPrevalidatedRecovery;
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  for (let attempt = 0; attempt < 3; attempt++) {
    const phrase = (await ask({ message: "Enter your 24-word recovery phrase" })).trim();
    let recoveryKey: Uint8Array;
    try {
      recoveryKey = await parse(phrase);
    } catch (error) {
      writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
      continue;
    }
    let enrolled: { accountId: string; deviceId: string };
    try {
      enrolled = await enroll(recoveryKey, (deps.now ?? Date.now)(), deps.loadedCredentials);
    } catch (error) {
      writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
      recoveryKey.fill(0);
      return "parent";
    }
    try {
      const canonicalPhrase = await rkToPhrase(recoveryKey);
      await (deps.offerRecoveryKit ?? offerRecoveryKitAfterRecover)(canonicalPhrase, enrolled, { kit: false }, "wizard-recover");
    } catch (error) {
      writeStderr(`${e.yellow(`recovery succeeded, but the optional recovery-kit offer failed: ${error instanceof Error ? error.message : String(error)}`)}\n`);
    } finally { recoveryKey.fill(0) }
    return "enrolled";
  }
  return "parent";
}

async function stepAccount(remote: string): Promise<StepAccountResult> {
  const choice = await promptSelect<"create" | "existing">({
    message: "Are you new here, or do you already have an rbox account?",
    choices: [
      { name: "Create a new account", value: "create" },
      { name: "Log into an existing account", value: "existing" },
    ],
  });

  if (choice === "create") {
    process.stderr.write(`${e.dim(GENESIS_BOOTSTRAP_HINT)}\n`);
    const secret = await promptPassword({ message: GENESIS_BROWSER_PROMPT });
    // A secret bootstraps the genesis device (shows the recovery phrase); blank falls
    // back to device-code, which authorizes but can't enroll → resolve inline.
    await login(remote, secret || undefined, undefined, undefined, undefined, "wizard");
    return { ok: await resolveEnrollment(remote), created: Boolean(secret) };
  }

  return authorizeExistingAccount(remote);
}

interface AuthorizeExistingDeps {
  promptSelect?: typeof promptSelect;
  redeemPairInWizard?: typeof redeemPairInWizard;
  login?: typeof login;
  resolveEnrollment?: typeof resolveEnrollment;
  writeStderr?: (text: string) => void;
}

/** Existing-account authorization menu; pairing navigation returns to this parent. */
export async function authorizeExistingAccount(remote: string, deps: AuthorizeExistingDeps = {}): Promise<StepAccountResult> {
  const select = deps.promptSelect ?? promptSelect;
  const runPair = deps.redeemPairInWizard ?? redeemPairInWizard;
  const runLogin = deps.login ?? login;
  const resolve = deps.resolveEnrollment ?? resolveEnrollment;
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  for (;;) {
    writeStderr(`${e.dim(AUTHORIZATION_RECOVERY_FOOTER)}\n`);
    const method = await select<"pair" | "browser">({
      message: "How do you want to authorize this machine?",
      choices: AUTHORIZATION_CHOICES,
    });

    if (authorizePath(method) === "pair-token") {
      if (await runPair(remote) === "parent") continue;
      return { ok: await resolve(remote), created: false };
    }

    // Browser sign-in uses the device-code grant (authorize-only).
    await runLogin(remote, undefined, undefined, undefined, undefined, "wizard");
    return { ok: await resolve(remote), created: false };
  }
}

async function startTrialAfterAccountCreation(credentialResult: CredentialLoadResult): Promise<boolean> {
  process.stderr.write(`\n${e.bold("Start your 14-day free trial")}\n`);
  const choice = await promptSelect<`${SubscribePlan}:${BillingCadence}`>({
    message: "Choose a plan for this new account:",
    choices: [
      { name: "Solo annual — $80/year (recommended)", value: "solo:annual" },
      { name: "Pro annual — $200/year", value: "pro:annual" },
      { name: "Solo monthly — $8/month", value: "solo:monthly" },
      { name: "Pro monthly — $20/month", value: "pro:monthly" },
    ],
  });
  const [plan, cadence] = choice.split(":") as [SubscribePlan, BillingCadence];
  process.stderr.write(`${e.dim("Card required; cancel anytime before the trial ends.")}\n`);
  const url = await checkoutUrl(plan, cadence, credentialResult);
  if (url === "already_subscribed") return true;
  openAndShow(url, "Opening your browser to complete checkout...", "Open this URL in your browser to complete checkout:");
  process.stderr.write(`${e.dim("Waiting for checkout to complete...")}\n`);
  return pollUntilPlanActive(credentialResult);
}

async function pollUntilPlanActive(credentialResult: CredentialLoadResult): Promise<boolean> {
  const creds = credentialsForStrictFlow(credentialResult);
  if (!creds?.token || !creds.remoteUrl) return false;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithDeadline(`${creds.remoteUrl}/v1/account/usage`, { headers: { authorization: `Bearer ${creds.token}` } });
      if (res.ok) {
        const body = (await res.json()) as { plan?: string };
        if (body.plan && body.plan !== "none") return true;
      }
    } catch {
      // Keep polling until the deadline; browser checkout and webhook delivery race.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Which authorize path an existing-account method takes. "pair" redeems a pairing
 *  token (enrolls encryption inline); "browser" uses the device-code grant.
 *  Pure so the two-way routing is pinned by a unit test
 *  without driving the TUI widget (mirrors `workspaceFlags`). */
export function authorizePath(method: "pair" | "browser"): "pair-token" | "device-code" {
  return method === "pair" ? "pair-token" : "device-code";
}

export const PAIRING_TOKEN_SOURCE_DESCRIPTION =
  "run `rbox pair` in a terminal on an already-set-up machine — never shown in the dashboard because it carries your encryption key";
// "Browser" and the removed "Approve a code" option invoked the same device-code
// grant; keeping both entry points confused users without adding capability.
export const AUTHORIZATION_CHOICES = [
  { name: "Sign in via browser", value: "browser", description: "opens app.rbox.to to approve — no second terminal needed" },
  { name: "Paste a pairing token", value: "pair", description: PAIRING_TOKEN_SOURCE_DESCRIPTION },
] as const;

/** Resolve enrollment for an authorized-but-unenrolled machine (device-code login
 *  authorizes but can't carry the key). Returns true once enrolled (flow continues),
 *  false if the user defers or provides no input. Offered both freshly after a
 *  device-code login inside Step 1 and on a later re-run of `rbox setup`. */
type ExistingEnrollmentMethod = "pair" | "recover" | "later";
type EnrollmentMethod = "genesis" | ExistingEnrollmentMethod;

export const EXISTING_ENROLLMENT_CHOICES = [
  { name: "Paste a pairing token", value: "pair", description: PAIRING_TOKEN_SOURCE_DESCRIPTION },
  { name: "Recover with my 24-word phrase", value: "recover" },
  { name: "I'll do this later", value: "later", description: "re-run `rbox setup` once you've paired or recovered" },
] as const;

interface ResolveEnrollmentDeps {
  alreadyEnrolled?: () => Promise<boolean>;
  loadCredentials?: typeof loadCredentials;
  makeApi?: (remoteUrl: string, token: string) => Pick<RboxApi, "getAccountKeys" | "getGenesisObservation" | "bootstrapKeys">;
  promptSelect?: typeof promptSelect;
  runGenesisEnrollment?: typeof runGenesisEnrollment;
  writeStderr?: (text: string) => void;
  promptPassword?: typeof promptPassword;
  promptInput?: typeof promptInput;
  redeemPair?: typeof redeemPair;
  parsePhrase?: typeof phraseToRk;
  enrollRecovery?: typeof enrollViaPrevalidatedRecovery;
  now?: () => number;
}

export async function resolveEnrollment(remote: string, deps: ResolveEnrollmentDeps = {}): Promise<boolean> {
  if (deps.alreadyEnrolled && await deps.alreadyEnrolled()) return true;

  // There must be credentials here — this is only reached once we know we're authorized.
  const loadedCredentials = await (deps.loadCredentials ?? loadCredentials)();
  const creds = credentialsForStrictFlow(loadedCredentials);
  if(creds?.accountId&&creds.deviceId&&await genesisClassifierConsultationNeeded(creds.accountId)){
    const resumeApi=(deps.makeApi??((remoteUrl,token)=>new RboxApi(remoteUrl,token,"","")))(creds.remoteUrl??remote,creds.token);
    const resumed=await(deps.runGenesisEnrollment??runGenesisEnrollment)(resumeApi,{accountId:creds.accountId,deviceId:creds.deviceId});
    if(resumed==="enrolled")return true;
  }
  const checkEnrolled = deps.alreadyEnrolled ?? (async () => Boolean(creds?.accountId && await hasDevice(creds.accountId)));
  if (!deps.alreadyEnrolled && await checkEnrolled()) return true;
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const select = deps.promptSelect ?? promptSelect;
  const api = creds?.token ? (deps.makeApi ?? ((remoteUrl, token) => new RboxApi(remoteUrl, token, "", "")))(creds.remoteUrl ?? remote, creds.token) : undefined;
  const accountKeys = api ? await api.getAccountKeys() : null;

  for (;;) {
    let method: EnrollmentMethod;
    if (accountKeys === null) {
      writeStderr(`\n${e.yellow("⚠")}  This machine is authorized (${e.cyan(creds?.accountId ?? "?")}) and this account has not set up encryption yet.\n`);
      method = await select<EnrollmentMethod>({
        message: "How do you want to enroll this machine for encryption?",
        choices: [
          { name: "This is my first machine — set up encryption now", value: "genesis", description: "create the recovery phrase and make this device the genesis device" },
          ...EXISTING_ENROLLMENT_CHOICES,
        ],
      });
    } else {
      writeStderr(
        `\n${e.yellow("⚠")}  This machine is authorized (${e.cyan(creds?.accountId ?? "?")}) but NOT yet enrolled for encryption. Enroll it now:\n`
      );
      method = await select<ExistingEnrollmentMethod>({
        message: "How do you want to enroll this machine for encryption?",
        choices: EXISTING_ENROLLMENT_CHOICES,
      });
    }

    if (method === "genesis") {
      if (!api || !creds?.accountId || !creds.deviceId) throw new Error("missing device credentials — run `rbox login` again");
      const result = await (deps.runGenesisEnrollment ?? runGenesisEnrollment)(api, { accountId: creds.accountId, deviceId: creds.deviceId });
      if (result === "enrolled") return checkEnrolled();
      writeStderr(`${e.yellow("!")}  ${EXISTING_ACCOUNT_ENROLLMENT_MESSAGE}\n`);
      return false;
    }

    if (method === "later") {
      writeStderr(
        `${e.dim("run `rbox pair`/`rbox connect` on a signed-in machine, or `rbox key recover` with your phrase — then re-run `rbox setup`.")}\n`
      );
      return false;
    }

    if (method === "pair") {
      const result = await redeemPairInWizard(remote, {
        promptPassword: deps.promptPassword,
        redeemPair: deps.redeemPair,
        writeStderr,
      });
      if (result === "parent") continue;
      return checkEnrolled();
    }

    const result = await recoverInWizard({
      promptInput: deps.promptInput,
      parsePhrase: deps.parsePhrase,
      enroll: deps.enrollRecovery,
      writeStderr,
      now: deps.now,
      loadedCredentials,
    });
    if (result === "parent") continue;
    return checkEnrolled();
  }
}

export type StepWorkspaceResult =
  | { kind: "menu" }
  | { kind: "completed"; outcome: { workspaceId: string; workspaceName?: string; deviceId: string; root: string } }
  | { kind: "terminal" };

interface StepWorkspaceDeps {
  promptSelect?: typeof promptSelect;
  promptInput?: typeof promptInput;
  promptConfirm?: typeof promptConfirm;
  promptPath?: typeof promptPath;
  promptWorkspacePick?: typeof promptWorkspacePick;
  loadCredentials?: typeof loadCredentials;
  loadConfigIfPresent?: typeof loadConfigIfPresent;
  loadRawState?: typeof loadRawState;
  stat?: typeof fs.stat;
  mkdir?: typeof fs.mkdir;
  realpath?: typeof fs.realpath;
  acquireMutex?: typeof acquireWorkspaceSyncMutex;
  releaseMutex?: typeof releaseWorkspaceSyncMutex;
  isDegraded?: typeof workspaceSyncMutexDegraded;
  createWorkspace?: typeof createRemoteWorkspace;
  runInit?: typeof runInit;
  continueInit?: typeof continueInitWithPrecreatedWorkspace;
  writeStderr?: (text: string) => void;
  defaultFolder?: () => string;
}

/** Step 2 · Folder. Only explicit pre-init navigation returns `menu`. */
export async function stepWorkspace(
  opts: { cwd: string; defaultRemote: string },
  setupOpts: {
    noSync?: boolean;
    preselectedKind?: WorkspaceKind;
    header: string;
    credentialResult?: CredentialLoadResult;
    excludedRoot?: string;
    newFolderDefault?: string | null;
  },
  deps: StepWorkspaceDeps = {}
): Promise<StepWorkspaceResult> {
  const select = deps.promptSelect ?? promptSelect;
  const input = deps.promptInput ?? promptInput;
  const confirm = deps.promptConfirm ?? promptConfirm;
  const askPath = deps.promptPath ?? promptPath;
  const pickWorkspace = deps.promptWorkspacePick ?? promptWorkspacePick;
  const readCredentials = deps.loadCredentials ?? loadCredentials;
  const probeConfig = deps.loadConfigIfPresent ?? loadConfigIfPresent;
  const readRawState = deps.loadRawState ?? loadRawState;
  const stat = deps.stat ?? fs.stat;
  const mkdir = deps.mkdir ?? fs.mkdir;
  const realpath = deps.realpath ?? fs.realpath;
  const acquireMutex = deps.acquireMutex ?? acquireWorkspaceSyncMutex;
  const releaseMutex = deps.releaseMutex ?? releaseWorkspaceSyncMutex;
  const isDegraded = deps.isDegraded ?? workspaceSyncMutexDegraded;
  const createWorkspace = deps.createWorkspace ?? createRemoteWorkspace;
  const executeInit = deps.runInit ?? runInit;
  const continueInit = deps.continueInit ?? continueInitWithPrecreatedWorkspace;
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const recommendedFolder = deps.defaultFolder ?? defaultSyncFolder;

  // One typed observation governs this workspace step; degradation must stop
  // before directory creation, mutex publication, or a remote mutation.
  const loadedCredentials = setupOpts.credentialResult ?? await readCredentials();
  const creds = credentialsForStrictFlow(loadedCredentials);

  writeStderr(`\n${e.bold(setupOpts.header)}\n`);
  writeStderr(`${e.dim(SYNCED_FOLDER_DEFINITION)}\n`);
  const choice =
    setupOpts.preselectedKind ??
    (await select<FolderSetupChoice>({
      message: "Which folder do you want to sync?",
      choices: WORKSPACE_KIND_CHOICES,
    }));

  let workspace: string | undefined;
  let name: string | undefined;
  if (choice === "existing") {
    // Pick-by-name from the account's synced workspaces (degrades to a manual id
    // prompt when offline / no creds / empty account). The picked name is cached
    // locally so `rbox status` shows it with no round-trip.
    const picked = await pickWorkspace({ baseUrl: creds?.remoteUrl ?? opts.defaultRemote, token: creds?.token, mode: "setup" });
    if (picked.kind !== "picked") return { kind: "menu" };
    workspace = picked.pick.workspaceId;
    name = picked.pick.name;

    const dir = await askPath({ message: "Which directory should rbox sync?", default: opts.cwd, cwd: opts.cwd });
    writeStderr(`${e.dim(`will sync: ${dir}`)}\n`);
    let resetConsent: ResetConsentWitness | undefined;
    let adoptConsent: AdoptConsentWitness | undefined;
    const flags = workspaceFlags({ kind: "join", root: dir, workspace, name });
    if (setupOpts.noSync) flags["no-sync"] = "true";
    try {
      const bound = await probeConfig(dir);
      const raw = await readRawState(dir);
      const remoteUrl = creds?.remoteUrl ?? opts.defaultRemote;
      const nextStream = syncStreamId({ remoteUrl, remoteWorkspaceId: workspace, projectId: "root" });
      const oldStream = raw?.stream ?? (bound ? syncStreamId(bound) : undefined);
      if (oldStream && oldStream !== nextStream) {
        const label = bound
          ? (bound.name ? `${bound.name} (${bound.remoteWorkspaceId})` : bound.remoteWorkspaceId)
          : oldStream;
        writeStderr(`${e.yellow("⚠")}  This folder is already connected to ${e.cyan(label)}.\n`);
        const rebind = await confirm({
          message: `Connect it to ${workspace} instead? (files on disk are untouched; sync history starts fresh)`,
          default: false,
        });
        if (!rebind) {
          writeStderr(`${e.dim("keeping the existing connection; no local sync state was changed.")}\n`);
          return { kind: "menu" };
        }
        resetConsent = mintSetupExistingConsent({
          root: dir,
          observedOldStream: oldStream,
          observedOldNonce: raw?.stateNonce,
          mintedAtRevision: Number.isSafeInteger(raw?.stateRevision) ? raw!.stateRevision! : 0,
          remoteUrl,
          workspaceId: workspace,
          projectId: "root",
        });
      }
      if (!setupOpts.noSync && !oldStream && await rootHasAdoptableContent(dir) && process.env.RBOX_ADOPT_OVERLAY !== "0") {
        writeStderr(`${e.dim("rbox will establish the remote baseline first, fetch-union eligible Git branches, overlay local files, and retain every collision under .rbox/adopt.")}\n`);
        const adopt = await confirm({ message: "Adopt the existing contents of this directory?", default: true });
        if (adopt) adoptConsent = mintWizardAdoptConsent({ root: dir, stream: nextStream, workspaceId: workspace });
      }
      const outcome = await executeInit(flags, {
        cwd: opts.cwd,
        defaultRemote: opts.defaultRemote,
        summary: false,
        guidedSetup: true,
        resetConsent,
        credentialResult: loadedCredentials,
        adoptConsent,
      });
      return outcome ? { kind: "completed", outcome } : { kind: "terminal" };
    } catch (error) {
      writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
      return { kind: "terminal" };
    }
  }

  // Create-new is a local retry loop until a usable, acknowledged, fenced root is
  // ready. Once createWorkspace runs, every branch is single-shot.
  let useRecommendedRoot = choice === "default";
  for (;;) {
    const customDefault = setupOpts.newFolderDefault === undefined ? opts.cwd : setupOpts.newFolderDefault;
    const dir = useRecommendedRoot
      ? recommendedFolder()
      : await askPath({
          message: "Which folder should rbox sync?",
          ...(customDefault === null ? {} : { default: customDefault }),
          cwd: opts.cwd,
        });
    writeStderr(`${e.dim(`will sync: ${dir}`)}\n`);

    try {
      const info = await stat(dir);
      if (!info.isDirectory()) {
        writeStderr(`${e.yellow(`${dir} exists but is not a directory`)}\n`);
        useRecommendedRoot = false;
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
        useRecommendedRoot = false;
        continue;
      }
      if (!useRecommendedRoot) {
        const create = await confirm({ message: `${dir} doesn't exist — create it?`, default: false });
        if (!create) continue;
      }
      try {
        await mkdir(dir, { recursive: true });
      } catch (mkdirError) {
        writeStderr(`${e.yellow(mkdirError instanceof Error ? mkdirError.message : String(mkdirError))}\n`);
        useRecommendedRoot = false;
        continue;
      }
    }
    // The recommended root is a one-shot setup choice. Any later local retry
    // returns to the editable custom-folder prompt, matching the existing loop.
    useRecommendedRoot = false;

    if (setupOpts.excludedRoot) {
      try {
        const sameSpelling = path.resolve(dir) === path.resolve(setupOpts.excludedRoot);
        const samePhysicalFolder = sameSpelling || path.resolve(await realpath(dir)) === path.resolve(await realpath(setupOpts.excludedRoot));
        if (samePhysicalFolder) {
          writeStderr(`${e.yellow("That folder is already syncing. Choose another folder.")}\n`);
          continue;
        }
      } catch (error) {
        writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
        continue;
      }
    }

    let bound: Awaited<ReturnType<typeof loadConfigIfPresent>>;
    let raw: Awaited<ReturnType<typeof loadRawState>>;
    try {
      bound = await probeConfig(dir);
      raw = await readRawState(dir);
    } catch (error) {
      writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
      continue;
    }
    let resetConsent: ResetConsentWitness | undefined;
    const oldStream = raw?.stream ?? (bound ? syncStreamId(bound) : undefined);
    if (oldStream) {
      const label = bound
        ? (bound.name ? `${bound.name} (${bound.remoteWorkspaceId})` : bound.remoteWorkspaceId)
        : oldStream;
      writeStderr(`${e.yellow("⚠")}  This folder is already connected to ${e.cyan(label)}.\n`);
      const remoteUrl = creds?.remoteUrl ?? opts.defaultRemote;
      const rebind = await confirm({
        message: "Start it as a brand-new synced folder anyway? (files on disk are untouched; sync history starts fresh)",
        default: false,
      });
      if (!rebind) {
        writeStderr(
          `${e.dim(`keeping the existing connection. To sync it in the background run \`rbox start\`; to connect this folder to one from another machine, re-run setup and choose "Sync a folder from another machine".`)}\n`
        );
        return { kind: "menu" };
      }
      resetConsent = mintSetupCreateConsent({
        root: dir,
        observedOldStream: oldStream,
        observedOldNonce: raw?.stateNonce,
        mintedAtRevision: Number.isSafeInteger(raw?.stateRevision) ? raw!.stateRevision! : 0,
        remoteUrl,
        projectId: "root",
      });
    }

    let syncMutex: WorkspaceSyncMutex;
    try {
      syncMutex = await acquireMutex(dir, "cli");
    } catch (error) {
      writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
      continue;
    }

    let handedOff = false;
    try {
      if (isDegraded(syncMutex)) {
        // Locking couldn't be established (identity resolution, ledger I/O, or a
        // filesystem without the link primitive). Rather than refuse setup, warn
        // and continue in the same legacy-unlocked mode every other flow uses —
        // the only thing lost is coordination against *concurrent* rbox processes
        // on this workspace, which is negligible for a single user. Surface the
        // real reason so a genuine filesystem problem is still diagnosable.
        const detail = syncMutex.degraded?.detail;
        writeStderr(`${e.yellow(`⚠  workspace locking is unavailable on this machine${detail ? ` (${detail})` : ""} — continuing without it. Concurrent rbox processes on this workspace won't be coordinated, and git config sync is disabled.`)}\n`);
      }

      // Opt-in, server-visible workspace name — offered ONLY when creating (the row
      // is INSERTed once, first-writer-wins). Setup drives init via non-interactive
      // flags, so it owns this prompt. "-" keeps the label private.
      writeStderr(`${e.dim("a display name is OPTIONAL and shown in the web dashboard (visible to rbox, server-side — NOT end-to-end encrypted).")}\n`);
      const ans = interpretWorkspaceNameAnswer(
        await input({ message: `Display name (Enter accepts, "-" for none)`, default: collapseHome(dir, homeDir()) })
      );
      if (ans) name = ans;

      const respectGitignore =
        (await select<"false" | "true">({
          message: "How should rbox handle gitignored files?",
          choices: SETUP_GITIGNORE_CHOICES,
        })) === "true";

      if (!creds) throw new Error("login did not produce a credential — aborting setup");
      let workspaceId: string;
      try {
        await preflightInitRebind({
          root: dir,
          remoteUrl: creds.remoteUrl ?? opts.defaultRemote,
          workspace: { kind: "new", project: "root", name },
        }, resetConsent);
        const create = async (): Promise<string> => {
          const id = await createWorkspace(creds.remoteUrl ?? opts.defaultRemote, creds.token, "root", name);
          if (typeof id !== "string" || id.trim() === "") {
            throw new Error(`workspace create returned no usable id — ${WORKSPACE_MINT_RERUN_HINT}`);
          }
          return id;
        };
        if (resetConsent) {
          const created = await createWorkspaceWithConsent(
            resetConsent,
            { remoteUrl: creds.remoteUrl ?? opts.defaultRemote, projectId: "root", name },
            create,
          );
          workspaceId = created.workspaceId;
          resetConsent = created.witness;
        } else {
          workspaceId = await create();
        }
      } catch (error) {
        // NetworkError already carries the required unknown-outcome wording. Every
        // create failure is terminal and never re-enters this loop.
        writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
        process.exitCode = 1;
        return { kind: "terminal" };
      }

      const flags = workspaceFlags({ kind: "new", root: dir, name, respectGitignore });
      if (setupOpts.noSync) flags["no-sync"] = "true";
      handedOff = true;
      try {
        const outcome = await continueInit(
          flags,
          { cwd: opts.cwd, defaultRemote: opts.defaultRemote, summary: false, guidedSetup: true },
          { workspaceId, syncMutex, resetConsent },
          { loadCredentials: async () => loadedCredentials },
        );
        if (outcome) return { kind: "completed", outcome };
        throw new Error("initial setup returned without completing");
      } catch (error) {
        writeStderr(
          `${e.yellow(`workspace ${workspaceId} was created but local setup didn't finish: ${error instanceof Error ? error.message : String(error)}. ` +
            `Re-run rbox setup and choose 'Sync a folder from another machine' → ${workspaceId}.`)}\n`
        );
        process.exitCode = 1;
        return { kind: "terminal" };
      }
    } finally {
      if (!handedOff) await releaseMutex(syncMutex);
    }
  }
}

interface FinishSetupDeps {
  interactive?: () => boolean;
  select?: typeof promptSelect;
  createPairingToken?: typeof pairCreate;
  writeStderr?: (text: string) => void;
}

const PAIR_LATER_NOTE = "To pair more devices later, run `rbox pair` on an already-paired machine.";

/** Print the successful summary and offer exactly one post-setup action. */
export async function finishSetup(root: string, deps: FinishSetupDeps = {}): Promise<void> {
  const interactive = (deps.interactive ?? isInteractive)();
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  writeStderr(`\n${HR}\n`);
  writeStderr(`${e.green("✓")}  ${e.bold("rbox is set up.")}\n`);
  writeStderr(`     folder: ${e.cyan(collapseHome(root, homeDir()))}     device: ${os.hostname()}\n`);
  writeStderr(`     ${e.dim("This folder is end-to-end encrypted — the server never sees your files.")}\n`);
  writeStderr(`     ${e.dim("Tune what syncs with `rbox ignore` or .rboxignore.")}\n`);

  if (!interactive) {
    writeStderr(`\n   ${e.bold("Bring another machine online:")}\n`);
    writeStderr(`     rbox pair      ${e.dim("(here — prints the command; press c to copy)")}\n`);
    writeStderr(`     rbox connect … ${e.dim("(there — paste the displayed command)")}\n`);
    return;
  }

  const choice = await (deps.select ?? promptSelect)<SetupCompletionChoice>({
    message: "What would you like to do next?",
    choices: SETUP_COMPLETION_CHOICES,
  });
  if (setupCompletionActions(choice).createPairingToken) {
    try {
      await (deps.createPairingToken ?? pairCreate)();
    } catch (error) {
      writeStderr(`${e.yellow(error instanceof Error ? error.message : String(error))}\n`);
    }
  }
  writeStderr(`${e.dim(PAIR_LATER_NOTE)}\n`);
}

export const SETUP_GITIGNORE_CHOICES = GITIGNORE_CHOICES;
