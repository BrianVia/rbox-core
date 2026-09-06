# 312 — A CREATE-P receipt from another lineage of this same repository settles like an owning one

Status: implemented; founder: "Yes go" (2026-09-06).

## Why 310 did not free the desktop

The 206 receipts on `Personal/rbox-core` carry lineageHash `67cf0a50…` while the workspace's
current lineage is `1e122d11…`; the repository identity hash is identical (`8a68bacf…`). The
artifact scan classifies them as **foreign** (valid, not owning), which is the design-273/286
guard for two workspaces syncing one repository directory, and 310 settles only owning
receipts. No prior lineage is retained anywhere (one `state_lineage` row, no reset archives,
`state.json` is the authority marker), so "this was our earlier lineage" cannot be proven.

## Rule

Under design 309's self-authored evidence (no origin entry, BASE section stamped by this
device), the witness now also considers valid foreign present receipts whose
`repositoryIdentityHash` equals the current binding's. All receipts for the branch (owning and
same-repository foreign) must be CREATE (`priorOid === null`) at exactly the BASE OID; then
`present` (`valid-owning`/`active-foreign`) and `keeps` (`exact`/`mismatched`) stop counting as
standing and every receipt's P/K refs (keep names derived from the receipt's own binding)
retire inside the deletion's atomic verification transaction. A receipt for a different
repository identity, for a different commit, or an UPDATE receipt still refuses.

## Why this is safe without lineage history

- Same physical repository is proven by the identity hash; the receipt's target is exactly
  what this device observed and captured into its own BASE.
- Retiring cannot damage the minting workspace, if one still exists: its later settlement of
  an absent P is a defined no-op (`p-settlement.ts` returns `absent`), and its BASE,
  tombstones and pending state are untouched. Only the receipt bookkeeping is removed, and it
  described a landing that this device's BASE already states.
- Foreign artifacts of other kinds (absence, keep orphans, other branches) keep their vetoes.

Scan and protocol changes are additive: `ForeignBaseArtifactScanEntry.artifact` (valid P
only) and `FollowerBranchProtocol.foreignPresentArtifacts`. No wire, ledger or state change.

## Validation

`git-sync.test.ts`: foreign-lineage CREATE-P at the BASE OID (same repository identity) →
proof minted, both P/K refs retired; foreign receipt with a different repository identity →
`(artifacts-standing)`, refs intact; 310's tests (owning create, other commit, UPDATE-P)
unchanged and green. Rollback: revert; retired receipts were redundant with BASE.

## Review round 1 (GPT, `notes/312/review1-gpt.md`) and the guards it added

NOT ALIGNED on two findings, both accepted:

1. A foreign workspace's P-repair can be mid-flight (its state CAS accepted, its P/K→Q
   transaction not yet committed); deleting that P/K would leave its recovery in
   `corruption-hold`. Guard: a foreign receipt with a P-repair recovery ref (`Q`, from
   `pRepairQRef(lineage, ref, episode)`) never settles here.
2. Identity plus target is not a temporal proof that the foreign workspace's transition was
   incorporated. Guard: foreign receipts settle only when NO other workspace registered on
   this host (`readDesiredDaemonRows()` roots) contains the repository. A workspace syncing
   this folder must be on this machine (repository identity is a local realpath), and the
   registry is the host's only authority on that. An unreadable registry or Q listing keeps
   receipts standing.

With both guards the remaining case is exactly the measured one: receipts whose minting
lineage no longer exists on this host, describing a landing this device's BASE already
states. Tests: another workspace claims the folder → standing; a Q for the receipt exists →
standing; neither → settled.

## Review round 2 (GPT, `notes/312/review2-gpt.md`) and the strict host inventory

NOT ALIGNED on two findings, both accepted:

1. The tolerant registry reader turned unreadable rows into "no claim". Now the guard reads
   every host source STRICTLY (`readFolderSourceEvidence`: daemon desired rows and the
   binding registry; `inspectFolderCatalog`: the authoritative folder catalog) and any
   `unavailable` source or a `damaged` catalog keeps foreign receipts standing.
2. A workspace that never registered a daemon row was invisible. The claim check now unions
   all three host sources (desired roots, binding-registry roots, catalog folders), i.e.
   every way a folder is known to rbox on this machine, including foreground-only use.

Remaining, explicitly out of scope: a workspace that syncs this folder from a different
HOME on the same machine is not in any of this HOME's sources. That is the same boundary
every host-local rbox authority already has.
