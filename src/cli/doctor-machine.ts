/**
 * The all-workspaces view (#498, extended by design 211): what `rbox status
 * --all` / `rbox doctor --all` show, and what plain `rbox status` / `rbox
 * doctor` fall back to when you are NOT standing inside a workspace.
 *
 * Enumeration comes from the DURABLE LOCAL BINDING REGISTRY
 * (`binding-registry.ts`), which unions the persisted per-bind records with the
 * daemon desired-state rows. That is what retired the old "a folder bound with
 * `rbox track` that never started background sync is not listed here" footer:
 * the registry covers those bindings, so the list is no longer knowingly
 * incomplete.
 *
 * Per-workspace facts still come from the daemon's own ambient status record,
 * behind the SAME liveness + boot-binding trust gates the in-workspace report
 * applies. Read-only: no network, no scans, no mutation.
 */
import path from "node:path";
import { readBindingRegistry, type BindingHealth, type BindingRegistryRow } from "./binding-registry.js";
import { listFolderInventory } from "./folder-inventory.js";
import { type AmbientDaemonStatusV1, type DaemonMode } from "./daemon/ambient-status.js";
import { observeDaemon, type DaemonObservation } from "./daemon/observation.js";
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
  /** Registry health of the local binding: bound / missing / rebound. */
  binding: BindingHealth;
  state: MachineWorkspaceState;
  /** Is a background-sync process for this root alive right now? */
  daemonRunning: boolean;
  /** Authoritative only when the record passed the liveness/boot gates. */
  mode?: DaemonMode;
  /** ISO timestamp of the last completed sync, when the daemon reported one. */
  lastSyncedAt?: string;
  /** One plain-English line: what this folder is doing right now. */
  summary: string;
  /** The single highest-priority problem, or absent when nothing is wrong. */
  problem?: string;
  /** Copy-pasteable next step. Absent when no command can honestly act on this
   * folder from here (a folder that is gone cannot be `cd`-ed into). */
  command?: string;
  deferredRepos?: number;
}

export interface MachineTriage {
  schemaVersion: 1;
  scope: "machine";
  workspaces: MachineWorkspaceSummary[];
}

export interface MachineTriageDeps {
  readBindingRegistry?: typeof readBindingRegistry;
  listFolderInventory?: typeof listFolderInventory;
  observeDaemon?: typeof observeDaemon;
  now?: () => number;
}

const ATTENTION_SUMMARY: Record<string, string> = {
  halt: "syncing stopped and needs your decision",
  "out-of-storage": "out of storage — new changes cannot upload",
  "watcher-degraded": "not noticing file changes instantly; syncing is slow",
  "ownership-lost": "another rbox process took over syncing this folder",
};

const MISSING_SUMMARY =
  "this folder is gone or is no longer set up for rbox, so rbox is not syncing it. If you moved it back, run `rbox start` inside it.";
const REBOUND_SUMMARY =
  "this folder is now connected to a different rbox workspace than the one that was set up here";

function deferralSuffix(status: AmbientDaemonStatusV1 | undefined): string {
  const count = status?.deferredRepos ?? 0;
  if (count < 1) return "";
  return count === 1 ? " · 1 code folder is waiting on you" : ` · ${count} code folders are waiting on you`;
}

/** Only ever called with a record already proven to belong to the live daemon
 * incarnation, so every field — including `mode` (design 178) — is authoritative. */
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

/** The one problem to lead with. Ordered worst-first; `undefined` means healthy. */
function highestPriorityProblem(state: MachineWorkspaceState, summary: string, deferred: number): string | undefined {
  if (state === "unreachable" || state === "attention") return summary;
  if (state === "unknown") return "background sync is running but has not reported in";
  if (state === "stopped") return "background sync is not running";
  if (deferred > 0) return deferred === 1 ? "1 code folder is waiting on you" : `${deferred} code folders are waiting on you`;
  return undefined;
}

function unreachable(row: BindingRegistryRow, summary: string, command?: string): MachineWorkspaceSummary {
  return {
    root: row.root,
    name: row.name ?? path.basename(row.root),
    binding: row.health,
    state: "unreachable",
    daemonRunning: false,
    summary,
    problem: summary,
    ...(command === undefined ? {} : { command }),
  };
}

export async function collectMachineTriage(deps: MachineTriageDeps = {}): Promise<MachineTriage> {
  const inventory = await (deps.listFolderInventory ?? listFolderInventory)(undefined, {
    ...(deps.readBindingRegistry === undefined ? {} : { readBindingRegistry: deps.readBindingRegistry }),
  }).catch(() => ({ rows: [] }));
  const rows = inventory.rows;
  const now = (deps.now ?? Date.now)();
  const observe = deps.observeDaemon ?? observeDaemon;

  const workspaces: MachineWorkspaceSummary[] = [];
  for (const row of rows) {
    const name = row.name ?? path.basename(row.root);
    const command = `cd ${shQuoteIfNeeded(row.root)} && rbox doctor`;
    if (row.health === "missing") {
      // No `cd` command: `rbox untrack <root>` is the honest remedy, and it now
      // clears a registry entry whose binding is already gone.
      workspaces.push(unreachable(row, MISSING_SUMMARY, `rbox untrack ${shQuoteIfNeeded(row.root)}`));
      continue;
    }
    if (row.health === "rebound") {
      workspaces.push(unreachable(row, REBOUND_SUMMARY, command));
      continue;
    }
    const daemon = observe(row.root, row.currentWorkspaceId ?? row.workspaceId, now);
    const running = daemon.running;
    const status = daemon.trustedAmbient;
    const usable = status !== undefined;
    // Deferral counts are evidence like any other field: a record the gates
    // rejected describes a daemon that no longer exists, and quoting its count
    // would put invented pending work in the `status --all` table.
    const trusted = usable ? status : undefined;
    const suffix = deferralSuffix(trusted);
    const deferred = trusted?.deferredRepos ?? 0;
    if (usable && status) {
      const { state, summary } = summarize(status);
      const line = `${summary}${suffix}`;
      const problem = highestPriorityProblem(state, line, deferred);
      workspaces.push({
        root: row.root,
        name,
        binding: row.health,
        state,
        daemonRunning: true,
        // Mode and lastSyncedAt are quoted ONLY from a record that cleared the
        // gates above; a stale record's mode is not evidence of anything.
        ...(status.mode === undefined ? {} : { mode: status.mode }),
        ...(status.lastSyncedAt === null || status.lastSyncedAt === undefined ? {} : { lastSyncedAt: status.lastSyncedAt }),
        summary: line,
        ...(problem === undefined ? {} : { problem }),
        command,
        ...(status.deferredRepos === undefined ? {} : { deferredRepos: status.deferredRepos }),
      });
      continue;
    }
    const state: MachineWorkspaceState = running ? "unknown" : "stopped";
    const summary = running
      ? `background sync is running but has not reported in — it may be stuck${suffix}`
      : `background sync is not running here${suffix}`;
    const problem = highestPriorityProblem(state, summary, deferred);
    workspaces.push({
      root: row.root,
      name,
      binding: row.health,
      state,
      daemonRunning: running,
      summary,
      ...(problem === undefined ? {} : { problem }),
      command: running ? command : `cd ${shQuoteIfNeeded(row.root)} && rbox start`,
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

/** A problem worth interrupting the user for. A folder whose background sync is
 * simply stopped is reported in its own row, but is not an alarm — plenty of
 * workspaces are deliberately synced by hand. */
const needsAttention = (workspace: MachineWorkspaceSummary): boolean =>
  workspace.state === "attention" || workspace.state === "unreachable" || workspace.state === "unknown"
  || (workspace.deferredRepos ?? 0) > 0;

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
  ];
  for (const workspace of triage.workspaces) {
    lines.push(`${MARK[workspace.state]} ${style.bold(workspace.name)} ${style.dim(workspace.root)}`);
    lines.push(`    ${workspace.summary}`);
    if (workspace.command) lines.push(`    ${style.dim("run:")} ${workspace.command}`);
  }
  lines.push("");
  lines.push(style.dim("machine-readable: rbox doctor --all --json"));
  return lines;
}

const BINDING_LABEL: Record<BindingHealth, string> = {
  bound: "ok",
  missing: "root gone",
  rebound: "rebound",
};

const DAEMON_LABEL: Record<MachineWorkspaceState, string> = {
  syncing: "running",
  synced: "running",
  attention: "running",
  paused: "running",
  stopped: "stopped",
  unreachable: "—",
  unknown: "no report",
};

/** `dd mmm HH:MM`, or `—` when the daemon has never reported a completed sync. */
function relativeSync(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function pendingCell(workspace: MachineWorkspaceSummary): string {
  if (workspace.state === "unreachable") return "—";
  const deferred = workspace.deferredRepos ?? 0;
  if (deferred > 0) return `${deferred} git`;
  if (workspace.state === "syncing") return "syncing";
  if (workspace.daemonRunning) return "none";
  return "unknown";
}

function padCells(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join("  ").trimEnd());
}

/**
 * `rbox status --all` — the concise aggregate table the CLI-surface memo asks
 * for: name, root, binding health, daemon state + mode, last successful sync,
 * pending work, and the highest-priority problem. Same projection as
 * `doctor --all`; only the presentation differs.
 */
export function renderMachineStatusTable(triage: MachineTriage, now = Date.now()): string[] {
  if (triage.workspaces.length === 0) {
    return [
      `${style.bold("rbox status")} — no synced folders on this machine`,
      "",
      "rbox is not syncing anything here yet.",
      `${style.dim("run:")} rbox`,
    ];
  }
  const count = triage.workspaces.length;
  const header = ["NAME", "FOLDER", "BINDING", "SYNC", "LAST SYNC", "PENDING", "PROBLEM"];
  const body = triage.workspaces.map((workspace) => [
    workspace.name,
    workspace.root,
    BINDING_LABEL[workspace.binding],
    workspace.mode === "pull-only" ? `${DAEMON_LABEL[workspace.state]} (pull-only)` : DAEMON_LABEL[workspace.state],
    relativeSync(workspace.lastSyncedAt, now),
    pendingCell(workspace),
    workspace.problem ?? "—",
  ]);
  const [head, ...rest] = padCells([header, ...body]);
  const problems = triage.workspaces.filter(needsAttention).length;
  return [
    `${style.bold("rbox status --all")} — ${count} synced folder${count === 1 ? "" : "s"} on this machine`,
    "",
    // Every mark is exactly one visible character, so two spaces keep the
    // header aligned with the marked body rows in both colored and plain output.
    style.dim(`  ${head ?? ""}`),
    ...rest.map((line, index) => `${MARK[triage.workspaces[index]!.state]} ${line}`),
    "",
    style.dim(problems === 0 ? "nothing needs your attention." : `${problems} need${problems === 1 ? "s" : ""} attention — run: rbox doctor --all`),
    style.dim("machine-readable: rbox status --all --json"),
  ];
}
