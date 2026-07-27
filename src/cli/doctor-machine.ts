/**
 * The all-workspaces view (#498): what `rbox doctor` / `rbox status` show when
 * you are NOT standing inside a workspace. The machine's synced folders are
 * enumerated from the per-workspace daemon records under `~/.rbox/daemons`
 * (the same desired-state rows `rbox upgrade` and boot-resume already read),
 * so running from anywhere gives one line per folder plus the command that
 * takes you into its full report. Read-only.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { readDesiredDaemonRows } from "./autostart-cmd.js";
import { currentWorkspaceId, readDaemonPidRecord } from "./daemon-control.js";
import { isDaemonProcess } from "./daemon/process-control.js";
import { readAmbientDaemonStatusRecord, type AmbientDaemonStatusV1 } from "./daemon/ambient-status.js";
import { AMBIENT_STATUS_STALE_MS } from "./populate-marker.js";
import { shQuoteIfNeeded } from "./shell-quote.js";
import { style } from "./style.js";

export type MachineWorkspaceState =
  | "syncing"
  | "synced"
  | "attention"
  | "paused"
  | "stopped"
  | "unreachable"
  | "unknown";

export interface MachineWorkspaceSummary {
  root: string;
  name: string;
  state: MachineWorkspaceState;
  /** One plain-English line: what this folder is doing right now. */
  summary: string;
  /** Copy-pasteable: go there and get the full plain-English report. */
  command: string;
  deferredRepos?: number;
}

export interface MachineTriage {
  schemaVersion: 1;
  scope: "machine";
  workspaces: MachineWorkspaceSummary[];
}

export interface MachineTriageDeps {
  readDesiredDaemonRows?: typeof readDesiredDaemonRows;
  readAmbientDaemonStatusRecord?: typeof readAmbientDaemonStatusRecord;
  readDaemonPidRecord?: typeof readDaemonPidRecord;
  currentWorkspaceId?: typeof currentWorkspaceId;
  isDaemonProcess?: typeof isDaemonProcess;
  exists?: (target: string) => Promise<boolean>;
  now?: () => number;
}

const pathExists = (target: string): Promise<boolean> => fsp.stat(target).then(() => true, () => false);

const ATTENTION_SUMMARY: Record<string, string> = {
  halt: "syncing stopped and needs your decision",
  "out-of-storage": "out of storage — new changes cannot upload",
  "watcher-degraded": "not noticing file changes instantly; syncing is slow",
  "ownership-lost": "another rbox process took over syncing this folder",
};

function deferralSuffix(status: AmbientDaemonStatusV1 | undefined): string {
  const count = status?.deferredRepos ?? 0;
  if (count < 1) return "";
  return count === 1 ? " · 1 code folder is waiting on you" : ` · ${count} code folders are waiting on you`;
}

function summarize(status: AmbientDaemonStatusV1): { state: MachineWorkspaceState; summary: string } {
  switch (status.state) {
    case "attention":
      return {
        state: "attention",
        summary: `needs attention — ${ATTENTION_SUMMARY[status.attentionReason ?? ""] ?? "syncing hit a problem"}`,
      };
    case "syncing":
      return { state: "syncing", summary: "syncing right now" };
    case "paused":
      return { state: "paused", summary: "background sync is paused" };
    case "synced":
      return { state: "synced", summary: status.mode === "pull-only" ? "up to date (download-only)" : "up to date" };
  }
}

export async function collectMachineTriage(deps: MachineTriageDeps = {}): Promise<MachineTriage> {
  const rows = await (deps.readDesiredDaemonRows ?? readDesiredDaemonRows)().catch(() => []);
  const readAmbient = deps.readAmbientDaemonStatusRecord ?? readAmbientDaemonStatusRecord;
  const readPid = deps.readDaemonPidRecord ?? readDaemonPidRecord;
  const alive = deps.isDaemonProcess ?? isDaemonProcess;
  const workspaceId = deps.currentWorkspaceId ?? currentWorkspaceId;
  const exists = deps.exists ?? pathExists;
  const now = (deps.now ?? Date.now)();

  const seen = new Set<string>();
  const workspaces: MachineWorkspaceSummary[] = [];
  for (const row of rows) {
    const root = path.resolve(row.desired.rootPath);
    if (seen.has(root)) continue;
    seen.add(root);
    const name = path.basename(root);
    const command = `cd ${shQuoteIfNeeded(root)} && rbox doctor`;
    if (!await exists(path.join(root, ".rbox", "workspace.json"))) {
      workspaces.push({
        root,
        name,
        state: "unreachable",
        summary: "this folder is gone or is no longer set up for rbox",
        command: `rbox untrack ${shQuoteIfNeeded(root)}`,
      });
      continue;
    }
    if (row.desired.workspaceId !== workspaceId(root)) {
      workspaces.push({
        root,
        name,
        state: "unreachable",
        summary: "this folder is now connected to a different rbox workspace than the one that was set up here",
        command,
      });
      continue;
    }
    const record = readAmbient(root);
    const status = record.kind === "ok" ? record.status : undefined;
    const fresh = status !== undefined && now - Date.parse(status.heartbeatAt) <= AMBIENT_STATUS_STALE_MS;
    const pid = readPid(root);
    const running = pid.pid !== undefined && alive(pid.pid);
    const suffix = deferralSuffix(status);
    if (fresh && status) {
      const { state, summary } = summarize(status);
      workspaces.push({
        root,
        name,
        state,
        summary: `${summary}${suffix}`,
        command,
        ...(status.deferredRepos === undefined ? {} : { deferredRepos: status.deferredRepos }),
      });
      continue;
    }
    workspaces.push({
      root,
      name,
      state: running ? "unknown" : "stopped",
      summary: running
        ? `background sync is running but has not reported in — it may be stuck${suffix}`
        : `background sync is not running here${suffix}`,
      command: running ? command : `cd ${shQuoteIfNeeded(root)} && rbox start`,
      ...(status?.deferredRepos === undefined ? {} : { deferredRepos: status.deferredRepos }),
    });
  }
  workspaces.sort((a, b) => a.root.localeCompare(b.root));
  return { schemaVersion: 1, scope: "machine", workspaces };
}

const MARK: Record<MachineWorkspaceState, string> = {
  syncing: style.sym.ok,
  synced: style.sym.ok,
  attention: style.sym.err,
  paused: style.sym.warn,
  stopped: style.sym.warn,
  unreachable: style.sym.err,
  unknown: style.sym.warn,
};

export function renderMachineTriage(triage: MachineTriage): string[] {
  if (triage.workspaces.length === 0) {
    return [
      `${style.bold("rbox doctor")} — no synced folders on this machine`,
      "",
      "rbox is not syncing anything here yet.",
      `${style.dim("run:")} rbox setup`,
    ];
  }
  const count = triage.workspaces.length;
  const lines = [
    `${style.bold("rbox doctor")} — ${count} synced folder${count === 1 ? "" : "s"} on this machine`,
    "",
    style.dim("You are not inside a synced folder, so this is the summary for all of them."),
    "",
  ];
  for (const workspace of triage.workspaces) {
    lines.push(`${MARK[workspace.state]} ${style.bold(workspace.name)} ${style.dim(workspace.root)}`);
    lines.push(`    ${workspace.summary}`);
    lines.push(`    ${style.dim("run:")} ${workspace.command}`);
  }
  lines.push("");
  lines.push(style.dim("machine-readable: rbox doctor --json"));
  return lines;
}
