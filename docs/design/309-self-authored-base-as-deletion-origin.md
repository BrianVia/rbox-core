# 309 — A BASE section this device captured is origin evidence for deleting its branches

Status: implemented; product decision by the founder (2026-09-05: "let this device's capture
count as delete").

## Problem

The branch-deletion witness (designs 43 W/L/D, 273, 308) publishes a local branch deletion
only when the BASE branch has a per-branch **origin** entry (`branchBaseOrigins`: publisher-ack,
pull-p or manual) whose OID matches BASE. Origins were introduced after many BASE sections
were already published, so a legacy branch has none and its deletion is refused
(`origin-mismatch`) forever. `rbox git resolve` only handles incoming state, so the user has
no way to finish it. Measured on via-desktop: 285 branches deleted locally, 277 of them
origin-less, refused on every push (456 times in one day; the retry cost is design 308).

## Rule

Origin evidence for a missing branch is satisfied by EITHER:

1. the existing per-branch ledger entry matching the BASE OID (unchanged), OR
2. no ledger entry for that branch AND the BASE section that lists it carries
   `deviceId === this device` (design 274 D1 author stamp).

Why (2) is sound: the author stamp says this device captured that section from its own
working copy, so every branch in it existed locally at that capture. A later local deletion
of such a branch is this device's own decision, which is exactly what the publisher-ack
origin kind proves for post-273 branches. Sections captured by another device, or by an old
writer that stamped no author, still refuse: their branches may never have existed here.

The `lineage-changed` check still applies only to ledger origins (they carry a lineage
hash); for a self-authored section the publisher binding check earlier in the witness has
already proved this repository's lineage is unchanged. Every other witness check
(packed-refs regression, HEAD reflog, protocol artifacts standing, busy/preflight,
worktree-owned, name collision, HEAD symref, the verification transaction) is unchanged.

No wire, ledger, or state format change: the stamp already exists and is read, not written.
The design-274 note that `deviceId` is "never an identity input" still holds — it is
evidence for a decision, not part of any key or fingerprint.

## Validation

`git-sync.test.ts`: self-captured section, origin-less branch deleted locally → proof
minted, tombstone authored, branch gone from the published section; same with the section
stamped by another device → refused `deletion-pending`; same with no stamp → refused. The
design-308 test now pins its cheap refusal with a foreign stamp. Plan suites green.
Rollback: revert; already-published tombstones are ordinary tombstones.
