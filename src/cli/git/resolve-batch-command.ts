/**
 * The state-reading edge of `rbox git resolve --under`.
 *
 * `resolve-batch.ts` decides everything and touches no disk, so its selection,
 * preview, confirmation and skip reporting are testable from plain rows. This
 * file exists only to hand it the one reading it needs: the same repo records
 * and the same projection every other Git-pause surface renders from.
 */
import { loadConfig, loadState, repoRecordsForState, syncStreamId } from "../config.js";
import { projectGitDeferralRepos } from "../status-view/git-projection.js";
import { gitResolveBatchCmd, type GitResolveBatchOptions } from "./resolve-batch.js";
import type { GitResolveDeps } from "./resolve-contract.js";

export async function runGitResolveBatch(
  root: string,
  options: GitResolveBatchOptions,
  deps: GitResolveDeps = {},
): Promise<number> {
  const cfg = await loadConfig(root);
  const state = await loadState(root, syncStreamId(cfg));
  const records = repoRecordsForState(state);
  const now = (deps.now ?? (() => new Date()))().getTime();
  const rows = projectGitDeferralRepos(
    Object.entries(records).flatMap(([repo, record]) =>
      Object.values(record.deferrals ?? {}).flatMap((deferral) => deferral ? [{ repo, deferral, record }] : [])),
    now,
  );
  return gitResolveBatchCmd(root, options, { rows, records }, deps);
}
