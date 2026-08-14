/** One lossy read of everything the classifier compares against: HEAD, refs,
 * the index projection, and operation state. Moved verbatim out of follow.ts. */
import fs from "node:fs/promises";
import path from "node:path";
import { indexIdentityV2 } from "../../engine/index.js";
import { addTimedMs, type GitChainTimings } from "../../engine/git/chain-timings.js";
import { hashFile } from "../../engine/hash.js";
import { readAllRefs, readOpStateSnapshot } from "../../engine/git/refs.js";
import { git, type RepoCtx } from "../../engine/git/shared.js";
import type { LiveMetadata } from "./follow-types.js";

export async function readLive(
  ctx: RepoCtx,
  chainTimings?: GitChainTimings,
  /** Evidence-grade refs already read by the caller's strict pass. When given,
   * the map consumed IS the map the strict read proved — no second lossy read. */
  strictRefs?: Record<string, string>,
): Promise<LiveMetadata | undefined> {
  try {
    const { headContent, currentRef, refs, currentTip } = await addTimedMs(chainTimings, "ownershipMs", async () => {
      const headContent = await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8");
      const currentRef = /^ref:\s*(refs\/\S+)\s*$/.exec(headContent)?.[1];
      const refs = strictRefs ?? await readAllRefs(ctx.repoDir);
      const currentTip = currentRef
        ? refs[currentRef] ?? await git(ctx.repoDir, ["rev-parse", "--verify", currentRef]).catch(() => undefined)
        : await git(ctx.repoDir, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
      return { headContent, currentRef, refs, currentTip };
    });
    const { indexPresent, indexProjection, opState, opStateRootsPresent } = await addTimedMs(chainTimings, "indexOpStateMs", async () => {
      const indexPath = path.join(ctx.gitDir, "index");
      const indexPresent = await fs.lstat(indexPath).then((stat) => stat.isFile(), (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      const indexProjection = indexPresent ? await indexIdentityV2(ctx.repoDir, indexPath) : undefined;
      const snapshot = await readOpStateSnapshot(ctx.gitDir, hashFile);
      const opState = snapshot.files;
      const opStateRootsPresent = snapshot.rootsPresent;
      return { indexPresent, indexProjection, opState, opStateRootsPresent };
    });
    return { headContent, currentRef, currentTip, refs, indexPresent, indexProjection, opState, opStateRootsPresent };
  } catch {
    return undefined;
  }
}
