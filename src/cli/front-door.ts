import os from "node:os";
import { startDaemonAndRecordDesired, stopDaemonAndRecordDesired } from "./autostart-cmd.js";
import { findRoot } from "./config.js";
import { DEFAULT_LOG_LINES, logsDaemon } from "./daemon-control.js";
import { collapseHome } from "./init-plan.js";
import { promptSelect } from "./prompt.js";
import type { WorkspaceKind } from "./setup-cmd.js";
import { runSyncCommand } from "./sync-cmd.js";
import { statusCmd } from "./status-cmd.js";
import { stderrStyle as e } from "./style.js";

export type FrontDoorAction = "nothing" | "sync" | "logs" | "start" | "stop";
export type UntrackedMenuAction = WorkspaceKind | "nothing";

type FrontDoorChoice<V> = { name: string; value: V; description?: string };
type SelectPrompt = <V>(cfg: { message: string; choices: ReadonlyArray<FrontDoorChoice<V>> }) => Promise<V>;

const FRONT_DOOR_BASE_CHOICES = [
  { name: "Nothing, I'm good", value: "nothing" },
  { name: "Sync now", value: "sync", description: "rbox sync" },
  { name: "View logs", value: "logs", description: "rbox logs" },
] as const;

export function frontDoorChoices(daemonRunning: boolean): ReadonlyArray<FrontDoorChoice<FrontDoorAction>> {
  return [
    ...FRONT_DOOR_BASE_CHOICES,
    daemonRunning
      ? { name: "Pause syncing", value: "stop", description: "rbox stop" }
      : { name: "Start syncing", value: "start", description: "rbox start" },
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
  statusCmd?: (root: string) => Promise<{ daemonRunning: boolean }>;
  promptSelect?: SelectPrompt;
  syncNow?: (root: string) => Promise<void>;
  viewLogs?: (root: string) => Promise<void>;
  startSyncing?: (root: string) => Promise<void>;
  pauseSyncing?: (root: string) => Promise<void>;
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
  const { daemonRunning } = await (deps.statusCmd ?? statusCmd)(root);
  const action = await promptCancelable<FrontDoorAction>(deps.promptSelect ?? promptSelect, {
    message: "Anything else?",
    choices: frontDoorChoices(daemonRunning),
  });

  if (action === undefined || action === "nothing") return;
  if (action === "sync") return (deps.syncNow ?? runSyncCommand)(root);
  if (action === "logs") return (deps.viewLogs ?? ((r) => logsDaemon(r, { follow: false, lines: DEFAULT_LOG_LINES })))(root);
  if (action === "start") return (deps.startSyncing ?? startDaemonAndRecordDesired)(root);
  return (deps.pauseSyncing ?? stopDaemonAndRecordDesired)(root);
}

export const UNTRACKED_MENU_CHOICES = (cwd: string) =>
  [
    { name: "Track this directory", value: "new", description: `create a new workspace from ${collapseHome(cwd, os.homedir())}` },
    { name: "Sync an existing workspace", value: "existing", description: "pick one you've already synced here" },
    { name: "Nothing, I'm good", value: "nothing" },
  ] as const satisfies ReadonlyArray<FrontDoorChoice<UntrackedMenuAction>>;

interface UntrackedMenuDeps {
  promptSelect?: SelectPrompt;
  writeStderr?: (text: string) => void;
}

export async function runUntrackedMenu(cwd: string, accountId: string, deps: UntrackedMenuDeps = {}): Promise<WorkspaceKind | undefined> {
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  writeStderr(`\n${e.green("✓")}  Signed in and enrolled (${e.cyan(accountId)}). This directory isn't tracked yet.\n\n`);
  const action = await promptCancelable<UntrackedMenuAction>(deps.promptSelect ?? promptSelect, {
    message: "What would you like to do?",
    choices: UNTRACKED_MENU_CHOICES(cwd),
  });

  return action === "nothing" ? undefined : action;
}
