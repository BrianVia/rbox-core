/**
 * Plain-English triage for `rbox doctor` — what is SAID about a workspace.
 *
 * Every stuck state rbox can already detect internally is translated here into
 * three things a non-expert needs: what is wrong, whether their data is safe,
 * and one copy-pasteable command scoped to the workspace being diagnosed.
 *
 * What may be believed in the first place lives in `doctor-evidence.ts`; this
 * module never reaches past it. Two rules follow from that split and are load-
 * bearing for every sentence below: nothing a check could not prove is stated
 * as fact, and no remedy is offered that cannot run against the very state that
 * produced the finding.
 */
import path from "node:path";
import type { DaemonActivity } from "./activity.js";
import type { AdoptFenceInspection } from "./adopt-journal.js";
import { daemonOwnsActivity, liveAmbient, provenFailure, unverifiedChecks, type TriageInputs } from "./doctor-evidence.js";
import { shQuoteIfNeeded } from "./shell-quote.js";
import { ageBucket, type GitDeferralRepoProjection } from "./status-view.js";
import { style } from "./style.js";
import { RBOX_VERSION } from "./version.js";
import type { DoctorChecks } from "./doctor-cmd.js";

export { observeDaemon, readTriageInputs, unverifiedChecks, type DaemonObservation, type TriageInputs, type TriageReadDeps } from "./doctor-evidence.js";

export type TriageSeverity = "blocked" | "attention" | "info";

export interface TriageFinding {
  /** Stable machine id for `--json` consumers (agents, CI, the rig). */
  id: string;
  severity: TriageSeverity;
  /** What is wrong, in the words a non-developer would use. */
  problem: string;
  /** Whether their data is safe. Always answered — never left implied. */
  safety: string;
  /** One copy-pasteable command, carrying its own workspace when the command is
   * workspace-scoped. Omitted only when no command can honestly fix the state. */
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

const SAFE_LOCAL_FILES = "Your files on this machine are untouched.";
const SAFE_NOTHING_LOST = "Nothing is lost — changes are just waiting instead of syncing.";
const SEVERITY_RANK: Record<TriageSeverity, number> = { blocked: 0, attention: 1, info: 2 };

/** Deferral reasons where rbox has PROVEN the repository itself is fine and only
 * its own bookkeeping is paused. Anything outside this set failed to read or
 * reconcile the repository, so the reassurance would be a false promise. */
const REPOSITORY_PROVEN_HEALTHY = new Set([
  "local-edits",
  "local-index",
  "local-operation",
  "local-commits",
  "local-stash",
  "deletion-pending",
  "git-busy",
  "ignored-target",
  "config",
]);

/** A remedy is pasted from wherever the reader is standing — `rbox doctor --path`
 * runs from anywhere, and the machine view hands out workspaces by path. Every
 * workspace-scoped command therefore carries its own workspace. */
function scoped(root: string, command: string): string {
  return `cd ${shQuoteIfNeeded(path.resolve(root))} && ${command}`;
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

function repoArg(repo: string): string {
  return repo.startsWith("-") ? `./${repo}` : repo;
}

function deferralFinding(root: string, repo: GitDeferralRepoProjection, now: number): TriageFinding {
  const age = ageBucket(repo.oldestDeferredSince, now);
  const command = repo.canKeepMine
    ? scoped(root, `rbox git resolve ${shQuoteIfNeeded(repoArg(repo.repo))} keep-mine`)
    : repo.canResolve
      ? scoped(root, `rbox git resolve ${shQuoteIfNeeded(repoArg(repo.repo))}`)
      : scoped(root, "rbox git deferrals --brief");
  const waiting = repo.canResolve
    ? "rbox has paused publishing its history until you say which side wins"
    : `rbox has paused publishing its history (${repo.reasonLabel})`;
  const safety = REPOSITORY_PROVEN_HEALTHY.has(repo.displayReason)
    ? `Your repository is healthy; only rbox's bookkeeping is paused. ${SAFE_LOCAL_FILES}`
    : `rbox could not read or reconcile part of this repository (${repo.reasonLabel}). It has changed nothing there — look at the repository itself before changing anything.`;
  return {
    id: `git-paused:${repo.repo}`,
    severity: age === "unknown" || age.endsWith("m") ? "attention" : "blocked",
    problem: `The code folder "${repo.repo}" has been waiting ${plainAge(age)} to publish: ${waiting}.`.replace("  ", " "),
    safety,
    command,
  };
}

function massDeleteCounts(reason: string): { deletes: number; tracked: number } | undefined {
  const match = /(\d+) of (\d+) tracked files/.exec(reason);
  return match ? { deletes: Number(match[1]), tracked: Number(match[2]) } : undefined;
}

/** The remedy is consent to a SPECIFIC deletion, so the copy names what is being
 * consented to and the scale of it. `rbox sync --allow-mass-delete` is never
 * offered: that waives the guard in both directions, including an unrelated one. */
function massDeleteFinding(root: string, halt: NonNullable<DaemonActivity["halt"]>, op: "pull" | "push"): TriageFinding {
  const counts = massDeleteCounts(halt.reason);
  const scale = counts ? `${counts.deletes} of your ${counts.tracked} synced files` : "an unusually large number of files";
  const target = op === "pull" ? `delete ${scale} from this machine` : `delete ${scale} everywhere else you sync`;
  const consent = op === "pull" ? "that local deletion" : "that deletion for your other machines";
  return {
    id: "halt:mass-delete",
    severity: "blocked",
    problem: `Syncing stopped because finishing it would ${target}, and rbox will not do that without your say-so.`,
    safety: `Nothing has been deleted — rbox stopped before touching anything. The command below CONFIRMS ${consent}; check what is missing first.`,
    command: scoped(root, `rbox ${op} --allow-mass-delete`),
  };
}

function haltFinding(root: string, halt: NonNullable<DaemonActivity["halt"]>): TriageFinding | undefined {
  switch (halt.typedReason?.kind) {
    case "mass-delete":
      return massDeleteFinding(root, halt, halt.typedReason.op);
    case "chain-repair":
      return {
        id: "halt:chain-repair",
        severity: "blocked",
        problem: "Syncing stopped because part of this workspace's sync history could not be read.",
        safety: `${SAFE_LOCAL_FILES} Your uploaded versions are still on the server.`,
        command: scoped(root, "rbox recover --repair-chain"),
      };
    case "too-many-refs":
    case "body-too-large":
      return {
        id: `halt:${halt.typedReason.kind}`,
        severity: "blocked",
        problem: "Syncing stopped because one upload was larger than the service accepts.",
        safety: SAFE_LOCAL_FILES,
        command: scoped(root, "rbox doctor --report"),
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
        command: scoped(root, "rbox logs"),
      };
  }
}

function plainList(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The "couldn't check" finding and the definitive ones are INDEPENDENT. A
 * lookup that never got an answer withholds only its own claim; it never
 * cancels a rejection or a corruption another check actually proved. */
function accountFindings(input: TriageInputs): TriageFinding[] {
  const { checks, root } = input;
  const out: TriageFinding[] = [];
  const unverified = unverifiedChecks(checks);
  if (unverified.length > 0) {
    out.push({
      id: "service-unreachable",
      severity: "attention",
      problem: `rbox couldn't reach the sync service to check ${plainList(unverified)} — your connection may be down, or the service may be busy.`,
      safety: `${SAFE_NOTHING_LOST} rbox resumes on its own once it can connect. Anything it could not check is simply left unreported here — it is not being called broken.`,
      command: scoped(root, "rbox doctor"),
    });
  }
  if (provenFailure(checks.credentials)) {
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
      command: `rbox track ${shQuoteIfNeeded(path.resolve(root))}`,
    });
  }
  return out;
}

/** `rbox recover` is deliberately NOT offered here: it runs a normal pull/push,
 * whose state loader refuses exactly these files, so it would do network work and
 * then fail without repairing anything. */
function stateFinding(root: string, check: DoctorChecks["state"]): TriageFinding | undefined {
  if (check.ok) return undefined;
  const mismatch = check.status === "stream-mismatch";
  return {
    id: mismatch ? "state-belongs-elsewhere" : "state-unreadable",
    severity: "blocked",
    problem: mismatch
      ? "This folder's local sync records belong to a different workspace than the one it is connected to now, so syncing is blocked. rbox cannot repair this by itself."
      : `This folder's local sync records cannot be read (${check.message}), so syncing is blocked. rbox cannot repair this by itself.`,
    // The prose remedy is scoped exactly like the structured ones: `doctor
    // --path` is read from anywhere, so a bare `rbox setup` would target
    // whatever directory the reader happens to be standing in.
    safety: `${SAFE_LOCAL_FILES} Your uploaded files are still on the server; joining this folder to the workspace again with \`${scoped(root, "rbox setup")}\` re-checks every file rather than deleting anything. Send the report below if you would like help first.`,
    command: scoped(root, "rbox doctor --report"),
  };
}

function lockingFinding(root: string, check: DoctorChecks["locking"]): TriageFinding | undefined {
  if (check.ok) return undefined;
  if (check.status === "starved") {
    return {
      id: "sync-lock-contention",
      severity: "attention",
      problem: "Another rbox process is holding this folder's sync lock, so syncing cannot start.",
      safety: SAFE_NOTHING_LOST,
      command: scoped(root, "rbox stop && rbox start"),
    };
  }
  // degraded-unlocked: syncing CONTINUES without the modern lock because this
  // machine's identity is unavailable. Restarting the daemon does not fix that.
  return {
    id: "locking-degraded",
    severity: "attention",
    problem: "rbox could not identify this machine, so it is syncing without its usual safety lock. Your files still sync; shared Git settings are not synced while this lasts.",
    safety: `${SAFE_LOCAL_FILES} rbox falls back to its older, more cautious way of saving progress.`,
    command: scoped(root, "rbox doctor --report"),
  };
}

function environmentFindings(input: TriageInputs): TriageFinding[] {
  const { checks, root } = input;
  const out: TriageFinding[] = [];
  if (!checks.git.ok) {
    out.push({
      id: "git-unusable",
      severity: "blocked",
      problem: `rbox needs Git 2.46 or newer to sync code folders safely (${checks.git.message}).`,
      safety: "Your code is untouched; rbox simply will not sync repositories until Git is usable.",
      command: process.platform === "darwin" ? "brew install git" : undefined,
    });
  }
  const state = stateFinding(root, checks.state);
  if (state) out.push(state);
  // Only a VERIFIED chain error may be reported as unreadable history, and only
  // when nothing upstream explains it: a PROVEN sign-in or key failure makes
  // every server-side read fail, so the chain error would be its symptom. An
  // inconclusive sign-in lookup explains nothing and must not suppress it.
  if (provenFailure(checks.chain) && !provenFailure(checks.credentials) && !provenFailure(checks.enrollment)) {
    out.push({
      id: "history-unreadable",
      severity: "blocked",
      problem: "Part of this workspace's uploaded sync history cannot be read, so new uploads are blocked.",
      safety: SAFE_LOCAL_FILES,
      command: scoped(root, "rbox recover --repair-chain"),
    });
  }
  const locking = lockingFinding(root, checks.locking);
  if (locking) out.push(locking);
  return out;
}

/** Every daemon claim below reads from the ONE observation in `input.daemon`,
 * never from `checks.daemon` — that verdict was captured earlier in collection,
 * and mixing the two lets a daemon that rebound mid-collection keep its old
 * answer while its current sidecars are read. */
function daemonFindings(input: TriageInputs): TriageFinding[] {
  const { root, daemon } = input;
  const out: TriageFinding[] = [];
  if (daemon.stale) {
    out.push({
      id: "daemon-stale-binding",
      severity: "attention",
      problem: "Background sync is running, but it is still attached to a different workspace than this folder, so this folder is not syncing.",
      safety: SAFE_NOTHING_LOST,
      command: scoped(root, "rbox start"),
    });
  } else if (!daemon.running) {
    out.push({
      id: "daemon-stopped",
      severity: "attention",
      problem: "Background sync is not running for this folder, so changes are not syncing.",
      safety: SAFE_NOTHING_LOST,
      command: scoped(root, "rbox start"),
    });
  }

  // `liveAmbient` already required live + bound-to-this-root + fresh + boot-
  // bound, so every claim below is about the incarnation running right now.
  const live = liveAmbient(input);
  if (live?.attentionReason === "watcher-degraded") {
    out.push({
      id: "watcher-degraded",
      severity: "attention",
      problem: "rbox stopped receiving instant notifications when files change here, so edits can take minutes to sync instead of seconds.",
      safety: `${SAFE_NOTHING_LOST} rbox still catches changes with periodic scans.`,
      command: scoped(root, "rbox stop && rbox start"),
    });
  }
  if (live?.attentionReason === "ownership-lost") {
    out.push({
      id: "ownership-lost",
      severity: "attention",
      problem: "Another rbox process took over syncing this folder, so this background sync stepped aside.",
      safety: SAFE_NOTHING_LOST,
      command: scoped(root, "rbox stop && rbox start"),
    });
  }
  if (live?.mode === "pull-only") {
    out.push({
      id: "pull-only",
      severity: "info",
      problem: "Background sync is in download-only mode: changes you make here are not being uploaded.",
      safety: "Your edits here are safe and still on this machine — they are just not leaving it. Changes from your other machines DO keep downloading and applying here.",
      command: scoped(root, "rbox start --read-write"),
    });
  }
  const cliVersion = input.cliVersion ?? RBOX_VERSION;
  if (live?.daemonVersion !== undefined && live.daemonVersion !== cliVersion) {
    out.push({
      id: "daemon-version-skew",
      severity: "attention",
      problem: `Background sync is still running rbox ${live.daemonVersion} while this machine has ${cliVersion} installed.`,
      safety: SAFE_NOTHING_LOST,
      command: "rbox upgrade",
    });
  }
  if (provenFailure(input.checks.version) && input.checks.version.latest) {
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

function adoptFinding(root: string, adopt: AdoptFenceInspection): TriageFinding | undefined {
  if (adopt.status !== "active" && adopt.status !== "corrupt") return undefined;
  return {
    id: adopt.status === "active" ? "adopt-incomplete" : "adopt-corrupt",
    severity: "blocked",
    problem: adopt.status === "active"
      ? "Moving this folder into rbox did not finish, so syncing is held until it is completed or undone."
      : "The record of moving this folder into rbox is damaged, so syncing is held.",
    safety: "Your original files are preserved inside the folder while the move-in is unfinished.",
    command: scoped(root, "rbox adopt status"),
  };
}

function quotaFinding(activity: DaemonActivity | undefined): TriageFinding | undefined {
  const quota = activity?.outOfStorage;
  if (!quota) return undefined;
  if (quota.reason === "no_plan") {
    return {
      id: "quota-no-plan",
      severity: "blocked",
      problem: "This account is not on a plan yet, so new changes cannot be uploaded.",
      safety: `${SAFE_LOCAL_FILES} Downloads keep working.`,
      command: "rbox subscribe solo",
    };
  }
  const workspaces = quota.kind === "workspaces";
  return {
    id: workspaces ? "quota-workspaces" : "quota-storage",
    severity: "blocked",
    problem: workspaces
      ? "Your plan has no room for another synced folder, so this one cannot upload. If you are already on the largest plan, stop syncing a folder you no longer need instead."
      : "Your account is out of storage, so new changes cannot be uploaded. If you are already on the largest plan, remove files you no longer need instead — `rbox usage` shows what is using space.",
    safety: `${SAFE_LOCAL_FILES} Downloads keep working.`,
    command: "rbox subscribe pro",
  };
}

/** Order the findings the way a stuck user should work through them: things that
 * stop sync entirely, then things that slow it down, then advisories. */
export function triageWorkspace(input: TriageInputs): WorkspaceTriage {
  const findings: TriageFinding[] = [];
  const adopt = adoptFinding(input.root, input.adopt);
  if (adopt) findings.push(adopt);
  findings.push(...accountFindings(input));
  const owned = daemonOwnsActivity(input);
  const quota = owned ? quotaFinding(input.activity) : undefined;
  if (quota) findings.push(quota);
  const halt = owned && input.activity?.halt ? haltFinding(input.root, input.activity.halt) : undefined;
  if (halt) findings.push(halt);
  findings.push(...environmentFindings(input));
  for (const repo of input.deferrals) findings.push(deferralFinding(input.root, repo, input.now));
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
