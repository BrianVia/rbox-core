import { graphEnv } from "../../engine/git/reachability.js";
import { git } from "../../engine/git/shared.js";

type GitCommitAncestry = "equal" | "ancestor" | "not-ancestor";

/** Read-only commit-graph probe. Only Git's documented exit 1 is negative;
 * every indeterminate failure remains an exception for the caller to map. */
export async function gitCommitAncestry(
  repoDir: string,
  ancestorOid: string,
  descendantOid: string,
): Promise<GitCommitAncestry> {
  const [ancestorCommit, descendantCommit] = await Promise.all([
    git(repoDir, ["rev-parse", "--verify", `${ancestorOid}^{commit}`], { env: graphEnv }),
    git(repoDir, ["rev-parse", "--verify", `${descendantOid}^{commit}`], { env: graphEnv }),
  ]);
  if (ancestorCommit === descendantCommit) return "equal";
  try {
    await git(repoDir, ["merge-base", "--is-ancestor", ancestorCommit, descendantCommit], { env: graphEnv });
    return "ancestor";
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return "not-ancestor";
    throw error;
  }
}
