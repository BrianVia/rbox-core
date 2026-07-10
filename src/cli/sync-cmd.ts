import { type Action } from "../engine/index.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { beginReport } from "./metrics.js";
import { spinner, type Spinner } from "./spinner.js";
import { progressLabel } from "./status-view.js";
import { pull, sync, type SyncDeps } from "./sync.js";
import { style, stderrStyle } from "./style.js";
import { type WorkspaceConfig } from "./config.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";

/** Quiet-by-default wiring for the pull-side git-apply forensics (per-repo
 *  apply/conflict/defer lines, design 43 §10): instead of one `console.error`
 *  line per repo — alarming once a workspace has dozens of them, and easy to
 *  misread as all-failures since every line looks the same on a terminal that
 *  colors stderr red — collapse them into a single updating "git sync ran for
 *  N/total" counter on the shared spinner. Real problems (CONFLICT/WARNING)
 *  still print immediately, styled to stand out from the counter line.
 *  `--verbose` restores the old one-line-per-repo dump. */
export function attachGitSyncProgress(deps: SyncDeps, sp: Spinner, opts: { verbose?: boolean } = {}): void {
  if (opts.verbose) {
    deps.onGitLog = (line) => console.error(line);
    return;
  }
  deps.onGitLog = (line) => {
    if (line.startsWith("git-sync CONFLICT")) console.error(stderrStyle.red(line));
    else if (line.startsWith("git-sync WARNING")) console.error(stderrStyle.yellow(line));
  };
  deps.onGitProgress = (done, total) => sp.update(`git sync ran for ${done}/${total}`);
}

/** Post-sync drift nudge: if a pull/sync wrote a changed lockfile, print the
 *  one-line drift notice (design 29). Best-effort — never breaks a sync. */
export async function postSyncNudge(root: string, actions: Action[], cfg: WorkspaceConfig): Promise<void> {
  if (cfg.noDrift || process.env.RBOX_NO_DRIFT === "1") return;
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

export async function runSyncCommand(root: string, opts: { allowMassDelete?: boolean; pullOnly?: boolean; verbose?: boolean } = {}): Promise<void> {
  const sp = spinner("syncing");
  try {
    await withWorkspaceSyncMutex(root, async (syncMutex) => {
    const { cfg, deps } = await buildAuthedRemote(root);
    deps.syncMutex = syncMutex;
    deps.onProgress = (done, total, phase, detail, bytes) => sp.update(progressLabel(phase, done, total, detail, bytes));
    attachGitSyncProgress(deps, sp, { verbose: opts.verbose });
    deps.allowMassDelete = opts.allowMassDelete === true;
    const report = beginReport(opts.pullOnly ? "pull" : "sync");
    deps.report = report;
    if (opts.pullOnly) {
      const pulled = await pull(root, cfg, deps);
      sp.stop();
      summarize("pulled", pulled, root);
      report?.logSummaryTo((l) => console.log(style.dim(l)));
      await postSyncNudge(root, pulled, cfg);
      return;
    }
    const { pulled, pushedSequence, pushCommitted } = await sync(root, cfg, deps);
    sp.stop();
    summarize("pulled", pulled, root);
    console.log(
      pushCommitted
        ? `${style.bold("pushed")} ${style.sym.arrow} sequence ${style.cyan(String(pushedSequence))}`
        : `${style.bold("push")}: already in sync ${style.dim(`(sequence ${pushedSequence})`)}`
    );
    report?.logSummaryTo((l) => console.log(style.dim(l)));
    await postSyncNudge(root, pulled, cfg);
    });
  } catch (e) {
    sp.fail("sync failed");
    throw e;
  }
}
