import { stopDaemonAndRecordDesired } from "./autostart-cmd.js";
import { findRoot } from "./config.js";
import { DEFAULT_LOG_LINES, logsDaemon } from "./daemon-control.js";
import { promptSelect } from "./prompt.js";
import { runSyncCommand } from "./sync-cmd.js";
import { statusCmd } from "./status-cmd.js";

export type FrontDoorAction = "nothing" | "sync" | "logs" | "stop";

type FrontDoorChoice<V> = { name: string; value: V; description?: string };
type SelectPrompt = <V>(cfg: { message: string; choices: ReadonlyArray<FrontDoorChoice<V>> }) => Promise<V>;

export const FRONT_DOOR_CHOICES = [
  { name: "Nothing, I'm good", value: "nothing" },
  { name: "Sync now", value: "sync", description: "rbox sync" },
  { name: "View logs", value: "logs", description: "rbox logs" },
  { name: "Pause syncing", value: "stop", description: "rbox stop" },
] as const satisfies ReadonlyArray<FrontDoorChoice<FrontDoorAction>>;

export type BareRboxTarget = { kind: "front-door"; root: string } | { kind: "setup" };

interface BareRboxTargetDeps {
  findRoot?: (cwd: string) => Promise<string | undefined>;
}

export async function resolveBareRboxTarget(cwd: string, deps: BareRboxTargetDeps = {}): Promise<BareRboxTarget> {
  const root = await (deps.findRoot ?? findRoot)(cwd);
  return root ? { kind: "front-door", root } : { kind: "setup" };
}

interface FrontDoorDeps {
  statusCmd?: (root: string) => Promise<void>;
  promptSelect?: SelectPrompt;
  syncNow?: (root: string) => Promise<void>;
  viewLogs?: (root: string) => Promise<void>;
  pauseSyncing?: (root: string) => Promise<void>;
}

function isExitPromptError(err: unknown): boolean {
  return err instanceof Error && err.name === "ExitPromptError";
}

export async function runFrontDoor(root: string, deps: FrontDoorDeps = {}): Promise<void> {
  await (deps.statusCmd ?? statusCmd)(root);

  let action: FrontDoorAction;
  try {
    action = await (deps.promptSelect ?? promptSelect)<FrontDoorAction>({
      message: "Anything else?",
      choices: FRONT_DOOR_CHOICES,
    });
  } catch (err) {
    if (isExitPromptError(err)) return;
    throw err;
  }

  if (action === "nothing") return;
  if (action === "sync") return (deps.syncNow ?? runSyncCommand)(root);
  if (action === "logs") return (deps.viewLogs ?? ((r) => logsDaemon(r, { follow: false, lines: DEFAULT_LOG_LINES })))(root);
  return (deps.pauseSyncing ?? stopDaemonAndRecordDesired)(root);
}
