# Design 163 v4 — final serial adversarial review

Scope: `docs/design/163-state-plane-sqlite.md` v4 was checked directly against
`REVIEW-163-R3A.md`, `REVIEW-163-R3B.md`, `REVIEW-163-R3C.md`,
`SYNTHESIS-163-R3.md`, `FOLD-163-V4-NOTES.md`, and the current reset/oracle
implementation. The fold notes were treated as claims, not evidence.

## Findings

1. **BLOCKER — C4's journal-independent inventory rejects durable legacy reset
   artifacts that supported pre-163 workspaces are expected to retain.**

   V4 inventories the shared `reset-candidates/` and `lineages/` namespaces as
   SQLite artifacts only: `<lower-hex32>.db` and
   `<lower-hex32>/<lower-hex64>.db` plus their SQLite sidecars
   (`docs/design/163-state-plane-sqlite.md:310-318`). Every directory entry is
   counted, and any unknown reserved name is `RESET_NAMESPACE_INVALID` and a
   zero-write halt before journal decode (`:320-335`).

   The actual 1.7.x reset protocol uses those same directories for
   `<journal-id>.json` candidates and `<nonce>/<state-hash>.json` archives
   (`src/cli/reset-journal.ts:130-132`). Exact archives are intentionally
   retained after successful recovery; the current test pins that behavior
   (`src/cli/sync-git/reset-journal.test.ts:266-275`). In addition, terminal
   recovery unlinks and fsyncs the journal before candidate cleanup, so a crash
   at that supported boundary can leave a legacy `.json` candidate with no
   standing journal (`src/cli/reset-journal.ts:501-508`). The archive has no
   terminal deletion at all.

   Migration merely requires standing-reset recovery before M0
   (`docs/design/163-state-plane-sqlite.md:1862-1865`); no M0-M7 phase parks,
   migrates, or admits these durable legacy namespace entries. Consequently a
   workspace with an ordinary historical reset archive can migrate successfully
   through Q and then have the new no-journal inventory reject its still-valid
   legacy archive as an unknown name. A crash-left legacy candidate has the same
   result. This makes C4 incompatible with the actual pre-migration state set and
   turns a supported workspace into a permanent reset/startup halt.

   C4 needs an exact bounded/no-follow transition for legacy `.json` candidates
   and archives: either a crash-safe pre-Q park/preservation protocol or a closed
   legacy-name inventory/disposition that keeps them inert. The fix must retain
   W2-before-decode and must not broaden unknown-name handling beyond the exact
   legacy grammar.

2. **BLOCKER — C2b's prebuilt M6/M7 publication runway does not correlate every
   future-control crash image, and its halted retry branches contradict the
   immutable prebuilt M7 record.**

   The exact M6 witness binds the cleanup cursor, not either future control
   sibling (`docs/design/163-state-plane-sqlite.md:1692,1801-1806`). At the final
   cleanup intent, revision `r` then creates and fsyncs an M6 halt sibling at
   `r+1` and an M7 sibling at `r+2` before deleting the final resource
   (`:1816-1827`). If creation/render/fsync of either exclusive sibling fails or
   the process dies, the text says only that cleanup does not start
   (`:1848-1849`). It gives revision `r` no absent/building/exact disposition,
   identity, reuse, or durable retirement action for the partial/exact future
   siblings. A deterministic exclusive retry can collide; a unique-name retry
   leaks an uncorrelated prepared control. The generic publisher instead says a
   revision sibling never coordinates and a malformed/foreign observation halts
   (`:1695-1705`), which is not a recovery rule for these deliberately reusable
   future controls.

   The normal caught-failure path has a second gap. Promoting `r+1` to canonical
   halted M6 leaves the already-prepared `r+2` sibling behind, but `r+1` was
   rendered before `r+2` and cannot contain its exact created identity
   (`:1818-1823`). If the final resource is still present, v4 says doctor clears
   the halt and the controller “rebuilds a revision-correct pair” without first
   correlating or retiring the stale `r+2` (`:1845-1849`). That conflicts with
   the exact halted-row requirement (`:1969`) and either collides with revision
   `r+2` or leaves a sibling contradicting the claim that no prepared control
   survives terminal control unlink (`:1843-1844`). If the final resource is
   absent, the text permits direct promotion of the unbound prebuilt `r+2`, while
   the global doctor contract first requires CAS-clearing the halted revision
   and only then delegating to the controller (`:1711-1714,1845-1847,
   2027-2034`). Both transitions cannot consume revision `r+2`.

   Finally, the single already-fsynced M7 record is rendered with the exact
   `r+1` sibling identity (`:1821-1823`), yet the halted branch later says that
   same M7 “records it absent” because `r+1` became canonical control
   (`:1842-1843`). An immutable prepared record cannot acquire branch-dependent
   contents after the failure decision.

   C2b needs closed absent/building/exact dispositions for both future controls,
   restart rows for every preparation boundary, an explicit stale-pair
   retirement/reuse order, and one non-contradictory halted-M6-to-M7 transition.
   Until then the new cleanup correlation has precisely the unowned
   artifact-ahead states C2 was required to eliminate.

## C1-C9 fold audit

| Work item | Result | Direct verification |
|---|---|---|
| **C1 — durable retirement** | **Complete** | The armed, monotone one-item retirement cursor, identity-bound vector, terminal-control-last rule, M2-M5 crash/ENOSPC coverage, and explicit R3B M5 walk are present at `:1720-1797`, with authority/resume rows at `:1608-1614,1964-1965`. No current `L` deletion or authority broadening was found. |
| **C2 — M6/M7 cleanup correlation** | **Incomplete** | C2a's Q sibling path, bytes, identity states, create/build/exact rows, rename, parent fsync, and old/new power images are present at `:1650-1657,1688-1692,1902-1931,1962-1963`. C2b adds per-resource intent/absence at `:1799-1860`, but Finding 2 shows the final future-control runway is not a closed correlation. |
| **C3 — decoder contract** | **Complete** | Decoder-owned `readInto`, fixed buffer, known/unknown length admission, semantic-token arithmetic, decoded duplicate-key comparison, BOM/surrogate/base64 domains, result union, and closed typed errors are frozen at `:353-558`. The 256-Z maxima fit the stated 8,192 semantic-token bound, and the former independent 128 KiB rejection is removed. |
| **C4 — journal-independent inventory** | **Incomplete** | The new bounded no-follow inventory and J0/W1/W2/W3 precedence are explicit at `:308-351,560-616`, including malformed-journal precedence and the orphan-WAL case. Finding 1 shows that its closed namespace omits legal durable legacy entries already produced by the current code. |
| **C5 — receipt/oracle port** | **Complete** | Plan-backed source/projected/observed/token/attempt tables, bounded equivalence joins, streaming receipt hash, simultaneous cursor windows, proof token, and post-Git indeterminate/retry behavior are specified at `:1137-1258`. The cited peaks match the current maps, arrays, inventories, token maps, and `JSON.stringify` path in `src/engine/apply-receipt.ts`. |
| **C6 — construction peaks** | **Complete** | `ConstructionPeakV1`, backing-store overlap, parser/canonical/codec/runtime terms, five adapter phase-liveness rows, pre-allocation `CP <= A`, reclamation rules, and peak-live CI calibration replace the retained-only/flat-workspace model at `:1455-1538`. |
| **C7 — U0 terminal semantics** | **Complete** | A strong enumerable owner scope, serialized current-token cell, no-token abort, owner-loss drain, pending-through-application/discard/resource-release worker states, and publication barrier are present at `:872-973`. The prior WeakMap enumeration and settled-but-unapplied holes are closed. |
| **C8 — quarantine contradiction** | **Complete** | Both summaries now require standing-journal byte-exact/no-open quarantine and limit `VACUUM INTO` to general backup/operator compaction or a post-journal diagnostic (`:76-86,186-223`), matching the unchanged normative boundary at `:663-702`. |
| **C9 — coherence minors** | **Complete** | V4 status, target-vs-0.84 s baseline language, 2.0-only/non-shippable U0, merge-only shared branch, and coupled implementation-time seed measurement are present at `:1-6,27-34,100-129,273-287,828-832`. |

## Keystone audit

No keystone constraint was weakened by v4. The file-swap reset boundary and
transaction-only-between-boundaries rule remain; O/N remains a byte-exact closed
S0 witness; standing-journal quarantine remains byte-exact and no-open; W2 still
wins before journal decode; Q remains the single atomic authority flip with JSON
authoritative beforehand and SQLite afterward; and all U0-U5 implementation
remains confined to 2.0. The two findings above are failures to close newly
introduced artifact sets, not relaxations of those authority rules.

## Verdict

**CHANGES-REQUIRED**

C1, C2a, C3, C5-C9, and all keystone-preservation checks align. Ratification is
blocked until the legal legacy reset namespace is represented in C4 and C2b's
future-control preparation/halted-retry protocol has an exhaustive durable
correlation.
