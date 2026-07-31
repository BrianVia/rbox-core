import { type Action } from "../engine/index.js";
import { LocalRuntime } from "./local-runtime.js";
import { logDebugSummary } from "./metrics.js";
import { spinner, type Spinner } from "./spinner.js";
import { progressLabel } from "./status-view.js";
import { style, stderrStyle } from "./style.js";
import type { WorkspaceConfig } from "./workspace-config.js";

/** Quiet-by-default wiring for the pull-side git-apply forensics (per-repo
 *  apply/conflict/defer lines, design 43 §10): instead of one `console.error`
 *  line per repo — alarming once a workspace has dozens of them, and easy to
 *  misread as all-failures since every line looks the same on a terminal that
 *  colors stderr red — collapse them into a single updating "git sync ran for
 *  N/total" counter on the shared spinner. Real problems (CONFLICT/WARNING)
 *  still print immediately, styled to stand out from the counter line.
 *  `--verbose` restores the old one-line-per-repo dump. */
type ForegroundSyncObserver = NonNullable<Parameters<LocalRuntime["run"]>[1]>;

export function attachGitSyncProgress(observer: ForegroundSyncObserver, sp: Spinner, opts: { verbose?: boolean } = {}): void {
  if (opts.verbose) {
    observer.onGitLog = (line) => console.error(line);
    return;
  }
  observer.onGitLog = (line) => {
    if (line.startsWith("git-sync CONFLICT")) console.error(stderrStyle.red(line));
    else if (line.startsWith("git-sync WARNING")) console.error(stderrStyle.yellow(line));
  };
  observer.onGitProgress = (done, total) => sp.update(`git sync ran for ${done}/${total}`);
}

/** Post-sync drift nudge: if a pull/sync wrote a changed lockfile, print the
 *  one-line drift notice (design 29). Best-effort — never breaks a sync. */
export async function postSyncNudge(
  root: string,
  actions: Action[],
  cfg: Pick<WorkspaceConfig, "noDrift">,
): Promise<void> {
  if (cfg.noDrift === true || process.env.RBOX_NO_DRIFT === "1") return;
  const written = actions.filter((a): a is Extract<Action, { kind: "write" }> => a.kind === "write").map((a) => a.entry.path);
  if (written.length === 0) return;
  try {
    const { nudgeForWrittenPaths, renderNotices } = await import("./deps-drift.js");
    const notices = await nudgeForWrittenPaths(root, written);
    if (notices.length) process.stderr.write(`${renderNotices(notices)}\n`);
  } catch {
    /* nudge is advisory; a failure here must not fail the sync */
  }
}

export function summarize(label: string, actions: { kind: string; path?: string; keepLocalAs?: string }[], _root: string): void {
  const writes = actions.filter((a) => a.kind === "write").length;
  const deletes = actions.filter((a) => a.kind === "delete").length;
  const conflicts = actions.filter((a) => a.kind === "conflict");
  const conflictPart = conflicts.length ? style.red(`${conflicts.length} conflict(s)`) : style.dim("0 conflict(s)");
  console.log(`${style.bold(label)}: ${style.green(`${writes} written`)}, ${deletes} deleted, ${conflictPart}`);
  for (const c of conflicts) console.log(`  ${style.sym.warn} conflict: ${style.yellow(c.path ?? "?")} ${style.dim(`(local kept as ${c.keepLocalAs})`)}`);
}

export function summarizeCaseCollisions(groups: readonly { paths: readonly string[] }[]): void {
  if (groups.length === 0) return;
  console.log(style.yellow(`synced with ${groups.length} warning${groups.length === 1 ? "" : "s"}`));
  const shown = groups.slice(0, 5);
  for (const group of shown) {
    const paths = group.paths.slice(0, 4).map(safeWarningPath).join(", ");
    const omitted = Math.max(0, group.paths.length - 4);
    console.log(`  ${style.sym.warn} skipped case-conflicting paths: ${style.yellow(paths)}${omitted ? style.dim(` (+${omitted} more)`) : ""}`);
  }
  if (groups.length > shown.length) console.log(style.dim(`  …and ${groups.length - shown.length} more collision groups`));
  console.log(style.dim("  rename or remove one; background sync will pick it up automatically"));
}

function safeWarningPath(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}

const massDeleteConsent = (allow: boolean): "allow" | "guarded" => allow ? "allow" : "guarded";

function foregroundObserver(sp: Spinner): ForegroundSyncObserver {
  return {
    warningSink: (line) => process.stderr.write(`${line}\n`),
    onProgress: (done, total, phase, detail, bytes) => sp.update(progressLabel(phase, done, total, detail, bytes)),
  };
}

export async function runPushCommand(root: string, opts: { allowMassDelete?: boolean } = {}): Promise<void> {
  // Keep command admission before spinner creation and remote construction: a
  // scoped binding's refusal is policy, not a failed push attempt.
  await (await import("./scope/binding-scope.js")).assertCommandAllowedOnScopedBinding(root, "push");
  const sp = spinner("pushing");
  try {
    await new LocalRuntime(root).run({
      kind: "push",
      massDelete: massDeleteConsent(opts.allowMassDelete === true || process.env.RBOX_ALLOW_MASS_DELETE === "1"),
    }, foregroundObserver(sp), (outcome) => {
      if (outcome.kind !== "push") throw new Error("LocalRuntime returned a non-push outcome");
      sp.succeed(
        outcome.committed
          ? `pushed ${style.dim(root)} ${style.sym.arrow} sequence ${style.cyan(String(outcome.sequence))}`
          : `already in sync — nothing to upload ${style.dim(`(sequence ${outcome.sequence})`)}`
      );
      summarizeCaseCollisions(outcome.caseCollisions);
      logDebugSummary(outcome.report, (line) => console.log(style.dim(line)));
    });
  } catch (error) {
    sp.fail("push failed");
    throw error;
  }
}

export async function runPullCommand(root: string, opts: { allowMassDelete?: boolean; verbose?: boolean } = {}): Promise<void> {
  const sp = spinner("pulling");
  try {
    const observer = foregroundObserver(sp);
    attachGitSyncProgress(observer, sp, { verbose: opts.verbose });
    await new LocalRuntime(root).run({
      kind: "pull",
      massDelete: massDeleteConsent(opts.allowMassDelete === true),
    }, observer, async (outcome, cfg) => {
      if (outcome.kind !== "pull") throw new Error("LocalRuntime returned a non-pull outcome");
      sp.stop();
      summarize("pulled", outcome.actions, root);
      logDebugSummary(outcome.report, (line) => console.log(style.dim(line)));
      await postSyncNudge(root, outcome.actions, cfg);
    });
  } catch (error) {
    sp.fail("pull failed");
    throw error;
  }
}

export async function runSyncCommand(root: string, opts: { allowMassDelete?: boolean; pullOnly?: boolean; verbose?: boolean } = {}): Promise<void> {
  // Design 212 §3.1b layer 2: on a scoped binding `sync` MEANS a scoped pull. It
  // must never run a half-sync whose push half would publish a partial tree, and it
  // must not fail either — receiving changes is exactly what this binding is for.
  const { resolveBindingScope, assertBindingUsable } = await import("./scope/binding-scope.js");
  const seal = await resolveBindingScope(root);
  assertBindingUsable(seal);
  const pullOnly = opts.pullOnly === true || seal.kind === "scoped";
  const sp = spinner("syncing");
  try {
    const observer = foregroundObserver(sp);
    attachGitSyncProgress(observer, sp, { verbose: opts.verbose });
    await new LocalRuntime(root).run({
      kind: "sync",
      mode: pullOnly ? "pull-only" : "pull-push",
      massDelete: opts.allowMassDelete === true
        ? "allow-both"
        : process.env.RBOX_ALLOW_MASS_DELETE === "1" ? "allow-push" : "guard-both",
    }, { ...observer, massDeleteHint: "rbox sync --allow-mass-delete" }, async (outcome, cfg) => {
      if (outcome.kind !== "sync") throw new Error("LocalRuntime returned a non-sync outcome");
      sp.stop();
      summarize("pulled", outcome.pulled, root);
      if (outcome.mode === "pull-push") {
        console.log(
          outcome.pushCommitted
            ? `${style.bold("pushed")} ${style.sym.arrow} sequence ${style.cyan(String(outcome.pushedSequence))}`
            : `${style.bold("push")}: already in sync ${style.dim(`(sequence ${outcome.pushedSequence})`)}`
        );
        summarizeCaseCollisions(outcome.caseCollisions);
      }
      logDebugSummary(outcome.report, (line) => console.log(style.dim(line)));
      await postSyncNudge(root, outcome.pulled, cfg);
    });
  } catch (e) {
    sp.fail("sync failed");
    throw e;
  }
}
