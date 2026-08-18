/** Never: Git I/O, prefix observation, or retirement mutation. */
import type { RepoIdentityV1 } from "../cli/sync-git/repo-lineage.js";

/** A durable reset-journal `old.z` member. `type`, not `interface`, so it keeps
 * its implicit index signature and stays comparable with `JsonValue`. */
export type ResetZEntry = {
  lineageHash: string;
  repositoryIdentityHash: string;
  repositoryIdentity: RepoIdentityV1;
  activeRef: string;
  targetOid: string;
  recoveryRef: string;
};

/** The one ordering used by journal construction, validation, and recovery. */
export function compareResetZEntries(
  left: Pick<ResetZEntry, "activeRef" | "targetOid">,
  right: Pick<ResetZEntry, "activeRef" | "targetOid">,
): number {
  return left.activeRef < right.activeRef ? -1
    : left.activeRef > right.activeRef ? 1
      : left.targetOid < right.targetOid ? -1
        : left.targetOid > right.targetOid ? 1
          : 0;
}
