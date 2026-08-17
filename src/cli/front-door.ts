import os from "node:os";
import path from "node:path";
import { rboxBanner } from "./wordmark.js";
import { startDaemonForUser, stopDaemonAndRecordDesired } from "./autostart-cmd.js";
import { fetchAccountSummary } from "./account-cmd.js";
import { getIdentity, identityText, readAccountProfile } from "./account-profile.js";
import { DEFAULT_REMOTE } from "./api-base.js";
import { findRoot } from "./config.js";
import { loadCredentials } from "./credentials.js";
import { genesisClassifierConsultationNeeded } from "./genesis-enrollment.js";
import { RboxApi } from "./remote.js";
import { DEFAULT_LOG_LINES, logsDaemon } from "./daemon-control.js";
import { collapseHome } from "./init-plan.js";
import { promptSelect } from "./prompt.js";
import type { WorkspaceKind } from "./setup-cmd.js";
import { runSyncCommand } from "./sync-cmd.js";
import { statusCmd, statusCmdWithBriefIdentity } from "./status-cmd.js";
import type { BriefIdentitySource } from "./status-view/brief.js";
import { stderrStyle as e } from "./style.js";

export type FrontDoorAction = "login" | "sync" | "start" | "stop" | "setup" | "pair" | "usage" | "logs" | "exit";
export type UntrackedMenuAction = WorkspaceKind | "nothing";

type FrontDoorChoice<V> = { name: string; value: V; description?: string };
type SelectPrompt = <V>(cfg: { message: string; choices: ReadonlyArray<FrontDoorChoice<V>> }) => Promise<V>;

export function additionalFolderSetupPaths(currentRoot: string, recommendedRoot: string): {
  excludedRoot: string;
  newFolderDefault: string | null;
} {
  return {
    excludedRoot: currentRoot,
    newFolderDefault: path.resolve(recommendedRoot) === path.resolve(currentRoot) ? null : recommendedRoot,
  };
}

const FRONT_DOOR_TRAILING_CHOICES = [
  { name: "Add another synced folder", value: "setup", description: "rbox setup" },
  { name: "Pair another device", value: "pair", description: "rbox pair" },
  { name: "View usage", value: "usage", description: "rbox usage" },
  { name: "View logs", value: "logs", description: "rbox logs" },
  { name: "Exit", value: "exit" },
] as const;

export function frontDoorChoices(daemonRunning: boolean, signedIn = true): ReadonlyArray<FrontDoorChoice<FrontDoorAction>> {
  return [
    // Signed out, nothing else in the menu works — lead with the fix.
    ...(signedIn ? [] : [{ name: "Log in", value: "login" as const, description: "rbox login" }]),
    ...(daemonRunning
      ? [{ name: "Pause syncing", value: "stop" as const, description: "rbox stop" }]
      : [
          { name: "Sync now", value: "sync" as const, description: "rbox sync" },
          { name: "Start background syncing", value: "start" as const, description: "rbox start" },
        ]),
    ...FRONT_DOOR_TRAILING_CHOICES,
  ];
}

export type BareRboxTarget = { kind: "front-door"; root: string } | { kind: "untracked-menu"; accountId: string } | { kind: "setup" };

interface BareRboxTargetDeps {
  findRoot?: (cwd: string) => Promise<string | undefined>;
  enrolledAccountId?: () => Promise<string | undefined>;
}

export async function resolveBareRboxTarget(cwd: string, deps: BareRboxTargetDeps = {}): Promise<BareRboxTarget> {
  const root = await (deps.findRoot ?? findRoot)(cwd);
  if (root) return { kind: "front-door", root };
  const getEnrolledAccountId = deps.enrolledAccountId ?? (await import("./setup-cmd.js")).enrolledAccountId;
  const accountId = await getEnrolledAccountId();
  return accountId ? { kind: "untracked-menu", accountId } : { kind: "setup" };
}

interface FrontDoorDeps {
  loadCredentials?: typeof loadCredentials;
  readAccountProfile?: typeof readAccountProfile;
  fetchAccountSummary?: typeof fetchAccountSummary;
  statusCmd?: (root: string, identity?: BriefIdentitySource) => Promise<{ daemonRunning: boolean }>;
  promptSelect?: SelectPrompt;
  syncNow?: (root: string) => Promise<void>;
  viewLogs?: (root: string) => Promise<void>;
  pauseSyncing?: (root: string) => Promise<void>;
  setUpWorkspace?: (root: string) => Promise<void>;
  startSyncing?: (root: string) => Promise<void>;
  pairAnotherDevice?: () => Promise<void>;
  viewUsage?: () => Promise<void>;
  logIn?: () => Promise<void>;
}

const FRONT_DOOR_IDENTITY_TIMEOUT_MS = 2_000;

async function fetchColdFrontDoorIdentity(deps: FrontDoorDeps): Promise<BriefIdentitySource | undefined> {
  try {
    const loaded = await (deps.loadCredentials ?? loadCredentials)();
    if (loaded.state !== "valid" || !loaded.credentials.accountId) return undefined;
    const profile = await (deps.readAccountProfile ?? readAccountProfile)(loaded.credentials.accountId);
    if (profile && profile.plan !== null) return undefined;
    const summary = await (deps.fetchAccountSummary ?? fetchAccountSummary)(FRONT_DOOR_IDENTITY_TIMEOUT_MS, loaded);
    return summary.state === "ok"
      ? { email: summary.status.email ?? null, plan: summary.status.plan ?? null }
      : undefined;
  } catch {
    return undefined;
  }
}

function isExitPromptError(err: unknown): boolean {
  return err instanceof Error && err.name === "ExitPromptError";
}

async function promptCancelable<V>(select: SelectPrompt, cfg: { message: string; choices: ReadonlyArray<FrontDoorChoice<V>> }): Promise<V | undefined> {
  try {
    return await select<V>(cfg);
  } catch (err) {
    if (isExitPromptError(err)) return undefined;
    throw err;
  }
}

export async function runFrontDoor(root: string, deps: FrontDoorDeps = {}): Promise<void> {
  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  if(loaded.state==="valid"&&loaded.credentials.accountId&&await genesisClassifierConsultationNeeded(loaded.credentials.accountId)){
    const creds=loaded.credentials;if(!creds.accountId||!creds.deviceId||!creds.token)throw new Error("pending encryption setup has no bound device credential — run `rbox setup`");
    const {runGenesisEnrollment}=await import("./auth-cmd.js");
    await runGenesisEnrollment(new RboxApi(creds.remoteUrl??DEFAULT_REMOTE,creds.token,"",""),{accountId:creds.accountId,deviceId:creds.deviceId});
  }
  const signedIn = loaded.state === "valid" && Boolean(loaded.credentials.accountId);
  const freshIdentity = await fetchColdFrontDoorIdentity(deps);
  const renderStatus = deps.statusCmd ?? ((r: string, identity?: BriefIdentitySource) =>
    identity ? statusCmdWithBriefIdentity(r, identity) : statusCmd(r));
  process.stderr.write(rboxBanner());
  const { daemonRunning } = await renderStatus(root, freshIdentity);
  console.log();
  const action = await promptCancelable<FrontDoorAction>(deps.promptSelect ?? promptSelect, {
    message: "What would you like to do?",
    choices: frontDoorChoices(daemonRunning, signedIn),
  });

  if (action === undefined || action === "exit") return;
  if (action === "login") return (deps.logIn ?? (async () => {
    const { login } = await import("./auth-cmd.js");
    await login(DEFAULT_REMOTE);
  }))();
  if (action === "sync") return (deps.syncNow ?? runSyncCommand)(root);
  if (action === "logs") return (deps.viewLogs ?? ((r) => logsDaemon(r, { follow: false, lines: DEFAULT_LOG_LINES })))(root);
  if (action === "stop") return (deps.pauseSyncing ?? stopDaemonAndRecordDesired)(root);
  if (action === "start") return (deps.startSyncing ?? startDaemonForUser)(root);
  if (action === "setup") return (deps.setUpWorkspace ?? (async (cwd) => {
    const { defaultSyncFolder, runSetup } = await import("./setup-cmd.js");
    const recommended = defaultSyncFolder();
    await runSetup({
      cwd,
      defaultRemote: DEFAULT_REMOTE,
      flags: {},
      preselectedWorkspaceKind: "new",
      ...additionalFolderSetupPaths(cwd, recommended),
    });
  }))(root);
  if (action === "pair") return (deps.pairAnotherDevice ?? (async () => {
    const { pairCreate } = await import("./auth-cmd.js");
    await pairCreate();
  }))();
  return (deps.viewUsage ?? (async () => {
    const { usageCmd } = await import("./usage-cmd.js");
    await usageCmd();
  }))();
}

export const UNTRACKED_MENU_CHOICES = (cwd: string) =>
  [
    { name: "Sync this folder", value: "new", description: collapseHome(cwd, os.homedir()) },
    { name: "Sync a folder from another machine", value: "existing", description: "pick one you've already synced" },
    { name: "Nothing, I'm good", value: "nothing" },
  ] as const satisfies ReadonlyArray<FrontDoorChoice<UntrackedMenuAction>>;

interface UntrackedMenuDeps {
  promptSelect?: SelectPrompt;
  writeStderr?: (text: string) => void;
  getIdentity?: typeof getIdentity;
}

export async function runUntrackedMenu(cwd: string, accountId: string, deps: UntrackedMenuDeps = {}): Promise<WorkspaceKind | undefined> {
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const identity = await (deps.getIdentity ?? getIdentity)(accountId);
  writeStderr(rboxBanner());
  writeStderr(
    identity
      ? `\n${e.green("✓")}  Signed in as ${e.cyan(identityText(identity.email, identity.signInMethod)!)}. This folder isn't syncing yet.\n\n`
      : `\n${e.green("✓")}  Signed in and enrolled (${e.cyan(accountId)}). This folder isn't syncing yet.\n\n`
  );
  const action = await promptCancelable<UntrackedMenuAction>(deps.promptSelect ?? promptSelect, {
    message: "What would you like to do?",
    choices: UNTRACKED_MENU_CHOICES(cwd),
  });

  return action === "nothing" ? undefined : action;
}
