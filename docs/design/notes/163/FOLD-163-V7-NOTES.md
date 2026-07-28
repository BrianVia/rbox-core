# Design 163 v7 fold notes

Round-three **targeted** fold. Source: the codex final serial review of the
`design/163-v6` tip (commits `9599d59a` + `5ddf75c7`), verdict NOT-ALIGNED,
2026-07-28 ~02:00, plus the founder decisions ratified the same day. Unlike v5
and v6 this fold added no new review lens — it closed an enumerated residual
list and nothing else.

## The thing this fold exists to fix

**Two consecutive rounds recorded a schema closure in the review log without
performing it.** The v6 log row for `CODE B3 + CODEX 1` reads "Mapping rebased,
three columns added, `resolutionIntent` given an explicit strip-before-digest
disposition, and a schema rebase gate added so this cannot drift a third time",
and `FOLD-163-V6-NOTES.md` repeats the claim in its own "What changed" table.
Neither was true. Before this fold:

```
$ grep -n 'packed_refs_identity\|packedRefsIdentity' docs/design/163-state-plane-sqlite.md
3905:| CODE B3 + CODEX 1 — RepoRecord mapping omits `packedRefsIdentity`, ...
```

One hit: the log row asserting the change. The `repo_records` DDL was
unmodified, the one-for-one field list still predated three live members, and
the section the row cites ("Newly named members and strip-on-read semantics")
did not exist anywhere in the document.

Two lessons, both now written into the design rather than only into these
notes:

1. **The review log records a closure; it never constitutes one.** A log row is
   evidence of intent. It is trivially possible — apparently twice — to write
   the row, feel finished, and never touch the normative section. The v7 status
   line states this as a standing rule, and the false v6 row is annotated in
   place rather than quietly rewritten.
2. **A closure that can drift needs a test, not a sentence.** The compile-time
   `satisfies Record<keyof T,true>` maps prove every `RepoRecord` member is
   *handled*; nothing proved the *document* listed it. U1 now ships a test
   asserting a bijection between the frozen `repo_records` column list and
   `keyof RepoRecord` minus the single named strip-list member. The fourth
   drift is a red test.

## Verification discipline

Every claim folded here was re-checked against `src/` first. The load-bearing
ones:

| Claim | Checked against | Outcome |
|---|---|---|
| Three `RepoRecord` members are missing from the schema | `src/cli/sync-state-model.ts:288` | **Confirmed.** `packedRefsIdentity`, `attempt`, `resolutionReceipt` are all live and typed; the interface has nineteen members and the DDL had sixteen field-carrying columns |
| `resolutionIntent` is stripped on read | `sync-state-model.ts:363` + defensive `:404` | **Confirmed**, one production call site funnel (`loadRawState`), as v6 already corrected |
| The B0 barrier as specced is a check-then-rename race | `src/engine/fsutil.ts:35-89`, `src/cli/sync-state-store.ts:120-240,:369,:395-415` | **Confirmed.** `writeFileAtomic` publishes with a single `fs.rename` and offers exactly one abort seam (`beforeRename`, `:70-80`), which two of three state writers already use for lock-ownership assertions. `writeWholeStateUnsafe` (`:369`) takes no lock at all |
| Rig can run two different binaries | `scripts/rig/rig.ts:380`, `scripts/rig/lib/binary.ts` | **Refuted.** One global `--binary`, staged once, mounted into both devices — a candidate-vs-1.x differential is not expressible today |
| A 112k corpus fixture exists | `scripts/bench/corpus.ts:37-39` | **Refuted.** Largest shape is `repo: {files: 5000}` |

## How item 2 was closed without inventing a syscall

The residual demanded a race-free barrier argued from the real
`writeFileAtomic`, not from a hypothetical atomic compare-and-rename. `rename(2)`
replaces its target unconditionally, so no check placed before it is atomic
with it — that route is closed, and the fold says so instead of hiding it.

The closure is mutual exclusion: every production write of `.rbox/state.json`
must hold `stateLockPath` continuously across check→rename, which
`applyStateSavePacket` and `ensureTelemetryBindingId` already do and
`writeWholeStateUnsafe` does not; M6's authority rename holds the same lock, so
the two publication windows cannot interleave. The residue is the one
filesystem where that argument fails — `degraded-unlocked`, which is *defined*
as `acquireLock` returning `unsupported` — and there the honest answer is that
no atomic sequence exists, so the design refuses rather than races: M0 already
declines to migrate a degraded workspace, and degradation is a filesystem
property shared by every process on that workspace, so a `Q` never appears
under an unlocked writer. Locked workspaces are serialized; unlocked ones never
see a `Q`. No third case.

The "recorded last-writer version" witness codex asked for could not live in
`SyncState` (no version field, and the degraded composer already nulls
`stateNonce`/`stateRevision`/`repoRecords`, so any new member would be dropped
by exactly the writer the gate is about). It lives in a
`.rbox/state/last-writer.json` sidecar, written under the same lock after the
publication fsync and bound to the published file's `dev`/`ino` so it cannot
vouch for a state that is no longer there.

## What changed

| Area | Change |
|---|---|
| Status line | `v7 — pending final ratification`; provenance names the two rounds that falsely claimed the schema closure |
| Top of document | Four questions collapse to **one** open founder question (external users take the one-way migration before the payoff); a new "Founder decisions ratified 2026-07-28" section records sequencing, the `B0` gate, the `1.11.0` floor, and the kill-criterion numbers |
| Schema | Three columns added to `repo_records`; field list rebased on the current interface in declaration order; new "Newly named members and strip-on-read semantics" subsection; `resolutionIntent` strip-before-digest disposition; U1 schema-rebase gate |
| Migration barrier | `1a` race-freedom argument and `1b` witness sidecar added to the degraded-writer closure; M0 predicate consolidated to exactly four conditions including quarantine |
| M2 | Hard-linking forbidden; backups are preamble-prefixed copies; body hash vs physical hash defined and propagated to the witness row, artifact list, and fault injection |
| M6 cleanup | Inventory reconciled with M0–M7: roles 1–4 asserted absent (presence is corruption), role 5 doctor-only, role 6 M7-terminal, leaving reserve → emergency as the only two cleanup items |
| Rollout | Reserve fully specified; `B0` ships as `1.11.0`; dual-binary rig plumbing and pinned artifact provenance named as deliverables; `corpus-112k` fixture named as a U1 deliverable; kill-criterion measurement protocol written with the machine profile flagged as the one owed input; "clean by construction" weakened to the differential-gate framing |
| Terminology | v5's `U2 = engine` numbering swept out of the review log, the U5 ship criterion, and the churn paragraph; branch model corrected to `2.0 = U0 → U3`, `B0` on `main`, `U4a–U4f` on `main` as 2.x |

## What was not touched

The M0–M7 machine, the `Q` predicate and barrier, migration fencing, the
crash/resume table, the retirement subprotocol, and the keystone. Every change
above is a tightening or a specification of something previously unspecified;
none of them relaxes an admission, widens a classifier, or adds a repair-forward
path. The two places the fold looks like a relaxation — roles 1–6 leaving the
M6 cleanup vector — are the opposite: those artifacts move from "may be swept"
to "must already be absent, and presence is a zero-write corruption halt", or
to the doctor-only path that already owned them.
