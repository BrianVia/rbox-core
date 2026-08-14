import type { RepoIdentityV1 } from "../cli/sync-git/repo-lineage.js";

export interface ResetZEntry {
  lineageHash: string;
  repositoryIdentityHash: string;
  repositoryIdentity: RepoIdentityV1;
  activeRef: string;
  targetOid: string;
  recoveryRef: string;
}

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
