/**
 * Plain-English triage for `rbox doctor`.
 *
 * Every stuck state rbox can already detect internally is translated here into
 * three things a non-expert needs: what is wrong, whether their data is safe,
 * and one copy-pasteable command. Read-only — this module diagnoses and
 * recommends; it never mutates workspace, daemon, or sync state.
 */
import path from "node:path";
import { loadActivity, type DaemonActivity } from "./activity.js";
import { inspectAdoptFence, type AdoptFenceInspection } from "./adopt-journal.js";
import { loadConfig, loadState, repoRecordsForState, syncStreamId } from "./config.js";
import { readDaemonPidRecord } from "./daemon-control.js";
import { isDaemonProcess } from "./daemon/process-control.js";
import { readAmbientDaemonStatusRecord, type AmbientDaemonStatusRecord } from "./daemon/ambient-status.js";
import { AMBIENT_STATUS_STALE_MS } from "./populate-marker.js";
import { shQuoteIfNeeded } from "./shell-quote.js";
import { ageBucket, projectGitDeferralRepos, type GitDeferralRepoProjection } from "./status-view.js";
import { style } from "./style.js";
import { RBOX_VERSION } from "./version.js";
import type { DoctorChecks } from "./doctor-cmd.js";

export type TriageSeverity = "blocked" | "attention" | "info";

export interface TriageFinding {
  /** Stable machine id for `--json` consumers (agents, CI, the rig). */
  id: string;
  severity: TriageSeverity;
  /** What is wrong, in the words a non-developer would use. */
  problem: string;
  /** Whether their data is safe. Always answered — never left implied. */
  safety: string;
  /** One copy-pasteable command. Omitted only when no single command exists. */
  command?: string;
}

export interface WorkspaceTriage {
  schemaVersion: 1;
  scope: "workspace";
  root: string;
  workspace: string;
  healthy: boolean;
  findings: TriageFinding[];
}

export interface TriageInputs {
  root: string;
  checks: DoctorChecks;
  deferrals: GitDeferralRepoProjection[];
  activity?: DaemonActivity;
  ambient: AmbientDaemonStatusRecord;
  daemonRunning: boolean;
  adopt: AdoptFenceInspection;
  now: number;
  cliVersion?: string;
}

const SAFE_LOCAL_FILES = "Your files on this machine are untouched.";
const SAFE_NOTHING_LOST = "Nothing is lost — changes are just waiting instead of syncing.";
const SEVERITY_RANK: Record<TriageSeverity, number> = { blocked: 0, attention: 1, info: 2 };

/** Read every triage input for `root`. Each read is best-effort: a diagnosis
 * surface must still render when one of the sidecars it reads is unavailable. */
export async function readTriageInputs(root: string, checks: DoctorChecks, now = Date.now()): Promise<TriageInputs> {
  const [deferrals, activity, adopt] = await Promise.all([
    readDeferrals(root, now),
    loadActivity(root).catch(() => undefined),
    inspectAdoptFence(root).catch((error: unknown) => ({
      status: "corrupt" as const,
      reason: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const pid = readDaemonPidRecord(root);
  return {
    root,
    checks,
    deferrals,
    activity,
    adopt,
    ambient: readAmbientDaemonStatusRecord(root),
    daemonRunning: pid.pid !== undefined && isDaemonProcess(pid.pid),
    now,
  };
}

async function readDeferrals(root: string, now: number): Promise<GitDeferralRepoProjection[]> {
  try {
    const cfg = await loadConfig(root);
    const records = repoRecordsForState(await loadState(root, syncStreamId(cfg)));
    return projectGitDeferralRepos(
      Object.entries(records).flatMap(([repo, record]) =>
        Object.values(record.deferrals ?? {}).flatMap((deferral) => (deferral ? [{ repo, deferral, record }] : []))),
      now,
    );
  } catch {
    return [];
  }
}

function repoArg(repo: string): string {
  return repo.startsWith("-") ? `./${repo}` : repo;
}

/** The shared age buckets read as clipped exact times ("1h" for a 20-hour wait).
 * Say the bucket's real meaning instead: it is a floor, not a measurement. */
const PLAIN_AGE: Record<string, string> = {
  "1h": "for over an hour",
  "1d": "for over a day",
  "7d": "for over a week",
  "14d": "for over two weeks",
  "30d": "for over a month",
  unknown: "",
};

function plainAge(bucket: string): string {
  const known = PLAIN_AGE[bucket];
  if (known !== undefined) return known;
  const minutes = Number(bucket.replace("m", ""));
  return minutes <= 1 ? "for a minute" : `for ${minutes} minutes`;
}

function deferralFinding(repo: GitDeferralRepoProjection, now: number): TriageFinding {
  const age = ageBucket(repo.oldestDeferredSince, now);
  const command = repo.canKeepMine
    ? `rbox git resolve ${shQuoteIfNeeded(repoArg(repo.repo))} keep-mine`
    : repo.canResolve
      ? `rbox git resolve ${shQuoteIfNeeded(repoArg(repo.repo))}`
      : "rbox git deferrals --brief";
  const waiting = repo.canResolve
    ? "rbox has paused publishing its history until you say which side wins"
    : `rbox has paused publishing its history (${repo.reasonLabel})`;
  return {
    id: `git-paused:${repo.repo}`,
    severity: age === "unknown" || age.endsWith("m") ? "attention" : "blocked",
    problem: `The code folder "${repo.repo}" has been waiting ${plainAge(age)} to publish: ${waiting}.`.replace("  ", " "),
    safety: `Your repository is healthy; only rbox's bookkeeping is paused. ${SAFE_LOCAL_FILES}`,
    command,
  };
}

function haltFinding(halt: NonNullable<DaemonActivity["halt"]>): TriageFinding | undefined {
  switch (halt.typedReason?.kind) {
    case "mass-delete":
      return {
        id: "halt:mass-delete",
        severity: "blocked",
        problem: "Syncing stopped because this change would delete an unusually large number of files, and rbox will not do that without you saying so.",
        safety: "Nothing was deleted. rbox stopped before touching anything.",
        command: "rbox sync --allow-mass-delete",
      };
    case "chain-repair":
      return {
        id: "halt:chain-repair",
        severity: "blocked",
        problem: "Syncing stopped because part of this workspace's sync history could not be read.",
        safety: `${SAFE_LOCAL_FILES} Your uploaded versions are still on the server.`,
        command: "rbox recover --repair-chain",
      };
    case "too-many-refs":
    case "body-too-large":
      return {
        id: `halt:${halt.typedReason.kind}`,
        severity: "blocked",
        problem: "Syncing stopped because one upload was larger than the service accepts.",
        safety: SAFE_LOCAL_FILES,
        command: "rbox doctor --report",
      };
    case "push-conflict":
      return undefined;
    default:
      if (!halt.terminal) return undefined;
      return {
        id: "halt:unknown",
        severity: "blocked",
        problem: "Syncing stopped and will not retry on its own.",
        safety: SAFE_LOCAL_FILES,
        command: "rbox logs",
      };
  }
}

function credentialFindings(checks: DoctorChecks, root: string): TriageFinding[] {
  const out: TriageFinding[] = [];
  if (!checks.credentials.ok) {
    out.push({
      id: "signed-out",
      severity: "blocked",
      problem: `rbox cannot sign in to your account (${checks.credentials.message}), so nothing can sync.`,
      safety: SAFE_LOCAL_FILES,
      command: "rbox login",
    });
  }
  if (!checks.enrollment.ok) {
    out.push({
      id: "encryption-key",
      severity: "blocked",
      problem: `This machine cannot unlock your encrypted files (${checks.enrollment.message}).`,
      safety: `${SAFE_LOCAL_FILES} Your uploaded files stay encrypted and intact.`,
      command: checks.enrollment.message.includes("genesis") ? "rbox key genesis --yes" : "rbox key recover",
    });
  }
  if (!checks.device.ok) {
    out.push({
      id: "device-mismatch",
      severity: "attention",
      problem: "This folder is registered to a different machine than the one you are on, so background sync may refuse to run.",
      safety: SAFE_LOCAL_FILES,
      command: `rbox track ${shQuoteIfNeeded(root)}`,
    });
  }
  return out;
}

function environmentFindings(checks: DoctorChecks): TriageFinding[] {
  const out: TriageFinding[] = [];
  if (!checks.remote.ok) {
    out.push({
      id: "offline",
      severity: "attention",
      problem: "rbox cannot reach the sync service right now, so nothing is uploading or downloading.",
      safety: `${SAFE_NOTHING_LOST} rbox resumes on its own once the connection is back.`,
      command: "rbox doctor",
    });
  }
  if (!checks.git.ok) {
    out.push({
      id: "git-unusable",
      severity: "blocked",
      problem: `rbox needs Git 2.46 or newer to sync code folders safely (${checks.git.message}).`,
      safety: "Your code is untouched; rbox simply will not sync repositories until Git is usable.",
      command: process.platform === "darwin" ? "brew install git" : undefined,
    });
  }
  if (!checks.state.ok) {
    out.push({
      id: "local-bookkeeping",
      severity: "blocked",
      problem: `This folder's local sync bookkeeping is unreadable (${checks.state.message}).`,
      safety: `${SAFE_LOCAL_FILES} Your uploaded versions are still on the server.`,
      command: "rbox recover",
    });
  }
  // A sign-in or key failure makes every server-side read fail too; reporting
  // the downstream symptom as its own problem sends the user down a false path.
  if (checks.chain && !checks.chain.ok && checks.credentials.ok && checks.enrollment.ok) {
    out.push({
      id: "history-unreadable",
      severity: "blocked",
      problem: "Part of this workspace's uploaded sync history cannot be read, so new uploads are blocked.",
      safety: SAFE_LOCAL_FILES,
      command: "rbox recover --repair-chain",
    });
  }
  if (!checks.locking.ok) {
    out.push({
      id: "sync-lock",
      severity: "attention",
      problem: "Another rbox process is holding this folder's sync lock, so syncing cannot start.",
      safety: SAFE_NOTHING_LOST,
      command: "rbox stop && rbox start",
    });
  }
  return out;
}

function daemonFindings(input: TriageInputs): TriageFinding[] {
  const out: TriageFinding[] = [];
  const daemon = input.checks.daemon;
  if (daemon.status === "stale") {
    out.push({
      id: "daemon-stale-binding",
      severity: "attention",
      problem: "Background sync is running, but it is still attached to a different workspace than this folder, so this folder is not syncing.",
      safety: SAFE_NOTHING_LOST,
      command: "rbox start",
    });
  } else if (!daemon.ok) {
    out.push({
      id: "daemon-stopped",
      severity: "attention",
      problem: "Background sync is not running for this folder, so changes are not syncing.",
      safety: SAFE_NOTHING_LOST,
      command: "rbox start",
    });
  }

  const ambient = input.ambient.kind === "ok" ? input.ambient.status : undefined;
  // A status record only describes a LIVE daemon. A stopped daemon's leftovers
  // would otherwise contradict the "background sync is not running" finding.
  const fresh = ambient !== undefined
    && input.daemonRunning
    && input.now - Date.parse(ambient.heartbeatAt) <= AMBIENT_STATUS_STALE_MS;
  if (fresh && ambient?.attentionReason === "watcher-degraded") {
    out.push({
      id: "watcher-degraded",
      severity: "attention",
      problem: "rbox stopped receiving instant notifications when files change here, so edits can take minutes to sync instead of seconds.",
      safety: `${SAFE_NOTHING_LOST} rbox still catches changes with periodic scans.`,
      command: "rbox stop && rbox start",
    });
  }
  if (fresh && ambient?.attentionReason === "ownership-lost") {
    out.push({
      id: "ownership-lost",
      severity: "attention",
      problem: "Another rbox process took over syncing this folder, so this background sync stepped aside.",
      safety: SAFE_NOTHING_LOST,
      command: "rbox stop && rbox start",
    });
  }
  if (fresh && ambient?.mode === "pull-only") {
    out.push({
      id: "pull-only",
      severity: "info",
      problem: "Background sync is in download-only mode: changes you make here are not being uploaded.",
      safety: `${SAFE_LOCAL_FILES} Nothing here has been overwritten by this mode.`,
      command: "rbox start --read-write",
    });
  }
  const cliVersion = input.cliVersion ?? RBOX_VERSION;
  if (input.daemonRunning && ambient?.daemonVersion !== undefined && ambient.daemonVersion !== cliVersion) {
    out.push({
      id: "daemon-version-skew",
      severity: "attention",
      problem: `Background sync is still running rbox ${ambient.daemonVersion} while this machine has ${cliVersion} installed.`,
      safety: SAFE_NOTHING_LOST,
      command: "rbox upgrade",
    });
  }
  if (!input.checks.version.ok && input.checks.version.latest) {
    out.push({
      id: "update-available",
      severity: "info",
      problem: `A newer rbox (${input.checks.version.latest}) is available.`,
      safety: "Nothing is wrong — updating just keeps this machine in step with the rest.",
      command: "rbox upgrade",
    });
  }
  return out;
}

function adoptFinding(adopt: AdoptFenceInspection): TriageFinding | undefined {
  if (adopt.status === "active") {
    return {
      id: "adopt-incomplete",
      severity: "blocked",
      problem: "Moving this folder into rbox did not finish, so syncing is held until it is completed or undone.",
      safety: "Your original files are preserved inside the folder while the move-in is unfinished.",
      command: "rbox adopt status",
    };
  }
  if (adopt.status === "corrupt") {
    return {
      id: "adopt-corrupt",
      severity: "blocked",
      problem: "The record of moving this folder into rbox is damaged, so syncing is held.",
      safety: "Your original files are preserved inside the folder.",
      command: "rbox adopt status",
    };
  }
  return undefined;
}

function quotaFinding(activity: DaemonActivity | undefined): TriageFinding | undefined {
  if (!activity?.outOfStorage) return undefined;
  const workspaces = activity.outOfStorage.kind === "workspaces";
  return {
    id: workspaces ? "quota-workspaces" : "quota-storage",
    severity: "blocked",
    problem: workspaces
      ? "Your plan has no room for another synced folder, so this one cannot upload."
      : "Your account is out of storage, so new changes cannot be uploaded.",
    safety: `${SAFE_LOCAL_FILES} Downloads keep working.`,
    command: "rbox subscribe",
  };
}

/** Order the findings the way a stuck user should work through them: things that
 * stop sync entirely, then things that slow it down, then advisories. */
export function triageWorkspace(input: TriageInputs): WorkspaceTriage {
  const findings: TriageFinding[] = [];
  const adopt = adoptFinding(input.adopt);
  if (adopt) findings.push(adopt);
  findings.push(...credentialFindings(input.checks, input.root));
  const quota = quotaFinding(input.activity);
  if (quota) findings.push(quota);
  const halt = input.activity?.halt ? haltFinding(input.activity.halt) : undefined;
  if (halt) findings.push(halt);
  findings.push(...environmentFindings(input.checks));
  for (const repo of input.deferrals) findings.push(deferralFinding(repo, input.now));
  findings.push(...daemonFindings(input));

  const ordered = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index)
    .map(({ finding }) => finding);
  return {
    schemaVersion: 1,
    scope: "workspace",
    root: path.resolve(input.root),
    workspace: path.basename(path.resolve(input.root)),
    healthy: ordered.every((finding) => finding.severity === "info"),
    findings: ordered,
  };
}

function headline(triage: WorkspaceTriage): string {
  const actionable = triage.findings.filter((finding) => finding.severity !== "info").length;
  if (actionable === 0) return "Everything is syncing normally.";
  return actionable === 1 ? "1 thing needs your attention." : `${actionable} things need your attention.`;
}

export function renderWorkspaceTriage(triage: WorkspaceTriage): string[] {
  const lines = [`${style.bold("rbox doctor")} — ${triage.workspace} ${style.dim(`(${triage.root})`)}`, ""];
  lines.push(headline(triage));
  triage.findings.forEach((finding, index) => {
    lines.push("");
    const marker = finding.severity === "info" ? style.dim("note") : `${index + 1}.`;
    lines.push(`${marker} ${finding.problem}`);
    lines.push(`   ${style.dim(finding.safety)}`);
    if (finding.command) lines.push(`   ${style.dim("run:")} ${finding.command}`);
  });
  lines.push("");
  lines.push(style.dim("machine-readable: rbox doctor --json  ·  support report: rbox doctor --report"));
  return lines;
}
