# Review 144 — storage-truth timestamp gaps

Review rounds are recorded here. The implementation is accepted only when the
reviewer finds no remaining correctness issue in the route → adapter → runner
nullable-timestamp contract.

## Round 1

The reviewer found that `(workspace, sha, head)` deduplication discarded a null
timestamp when the same retained SHA also had a known timestamp. That could
falsely classify the SHA as window-expired. The runner now persists a monotonic
`timestamp_gap` bit alongside the best known timestamp, and fixtures cover both
known-then-null and null-then-known insertion orders. Re-dispatched for review.

## Round 2

ALIGN. The reviewer confirmed the gap bit survives deduplication, persisted
pages/resume, and global SHA aggregation across workspaces. No remaining
correctness blockers were found.
