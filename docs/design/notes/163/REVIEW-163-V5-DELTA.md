# Design 163 v5 — delta verification review

Scope: `docs/design/163-state-plane-sqlite.md` v5 was checked directly against
the two residual blockers in `REVIEW-163-FINAL.md`, the claims in
`FOLD-163-V5-NOTES.md`, the v4 closure record, and the current 1.7.6 reset and
filesystem implementation. The fold notes were treated as claims, not evidence.
This is a design review: design-163 migration code does not yet exist in `src/`,
as expected from the document's pre-ratification status.

## Delta findings

No blocking or non-blocking correctness finding remains in either v5 closure.

### C4 — legal legacy reset namespace: complete

The admitted legacy grammar now matches the real durable 1.7.x state set
exactly. Current code derives candidates as
`reset-candidates/<id>.json` and archives as
`lineages/<nonce>/<state-sha256>.json`
(`src/cli/reset-journal.ts:130-132`), requires the id/nonce to be lowercase
32-hex and the hash to be lowercase 64-hex (`:147-154`), and creates ids/nonces
from 16 random bytes rendered as lowercase hex (`:545-559`). Independent current
archive discovery uses the same 32/64-hex grammar (`src/cli/config.ts:367-380`).

Both states called out by the v4 verdict are genuinely durable. Successful
recovery removes the journal and candidate but never the archive
(`src/cli/reset-journal.ts:501-508`), and the retained-archive test pins that
behavior (`src/cli/sync-git/reset-journal.test.ts:266-275`). The same terminal
sequence unlinks and parent-fsyncs the journal before candidate cleanup, so a
power loss can leave a legal no-journal candidate (`reset-journal.ts:501-508`).

V5 admits only those two exact `.json` forms, with exact case, length, suffix,
separator, and depth; `.json-wal` and every other unknown name remain invalid.
It explicitly accounts for `.db`/`.json` coexistence, counts all entries under
the existing bound, preserves no-follow identity checks, classifies recognized
nonregular legacy leaves without following them, and retains DB-sidecar W2
precedence before legacy evaluation or journal decode
(`docs/design/163-state-plane-sqlite.md:353-379`). Exact legacy files are then
permanently inert: they survive M0-M7 and Q unchanged, cannot become O/N, and
cannot enter migration retirement or cleanup vectors (`:381-400`). The fixture
matrix covers retained archives, crash-left candidates, coexistence, malformed
names/types, the entry limit, J0, and W2 (`:770-779`). This closes the v4 gap
without adding an unknown-name wildcard, a new authority source, or a mutation
permission.

### C2b — future-control preparation and halted retry: complete

The final cleanup intent now durably prebinds both future control paths in the
mandatory M6 `futureControls` ledger at revision `b`; the pair is not discovered
or invented after a crash (`:1933-1968`). Revisions `b` through `b+4` enumerate
the complete absent, sole zero-create-ahead, identity-bound building, partial or
finish-ahead write, and exact observations for both inodes. Each row has one
next action, descriptors cannot regress to absent, and the final cleanup item
cannot be removed until both controls are exact (`:1969-2021`). Thus every
preparation boundary has an identity, deterministic reuse rule, and restart
row; retries neither collide with nor leak a replacement pair.

The byte dependency is also closed. Both inodes exist before H is rendered; H
binds the S inode and deterministic M7 template while omitting only the self- or
cross-digest fields that would form a cycle. Exact H bytes then determine H's
hash and the one canonical S/M7 byte string, which in turn records H's complete
identity and hash (`:1984-1994`). No branch mutates an already-fsynced M7 record.

At ready M6 `r=b+4`, direct success promotes S and a caught pre-publication
failure may promote H, with only the printed old/new rename images
(`:2023-2033`). Exact `promotedHalt` is the sole specialization of the generic
doctor contract: doctor validates H, the absent H origin path, exact S, the
unchanged cleanup cursor, Q/active, and the final target; it then grants one
in-process attempt to the same controller. Whether the target is still present
or already absent, retry reuses S, and the expected-H-to-S rename is the sole
durable halt clear and phase advance (`:2035-2067`). No intermediate revision
can consume S, no stale pair is rebuilt, and no other halted row gains
mutation-before-clear authority.

The immutable M7 bytes use one identity-bound
`exact-or-absent-terminal` descriptor for H on both branches. Direct success
starts with H exact; halted success starts with H's origin path absent. Only M7
may advance exact to durably absent, after which it retires canonical control
last (`:2069-2080`, `:2152-2160`). The earlier v4 summary is expressly refined:
its `r/r+1/r+2` terms are remapped to the runway-ready revisions (`:1922-1931`),
"rebuilds" is narrowed to revalidate/reuse (`:2063-2067`), and the apparent
branch-specific M7 descriptions are observations of the same terminal
descriptor rather than different bytes (`:2078-2080`). The v5 fault matrix
then requires every create, fsync, ledger CAS, partial write, rename, retry, and
terminal-retirement boundary (`:2280-2292`).

There is no current migration implementation to falsely validate against: a
repository-wide `src/` search finds no `migration-v1`, `futureControls`,
`promotedHalt`, or `retry-state-migration` code. The real filesystem layer does,
however, support the specified mechanism: it fsyncs staged file bytes before a
same-directory atomic rename and exposes explicit directory fsync
(`src/engine/fsutil.ts:10-14,34-43,60-78`). C2b is therefore complete as a
closed implementation specification, not claimed as already implemented.

## V4 regression spot-check

No unrelated closure regressed:

| V4 item | Delta result | Spot-check |
|---|---|---|
| **C1 — durable retirement** | Preserved | Changed-source authority rows, pre-delete arming, the bounded identity-derived vector, intent/prefix rows, the explicit M5 walk, ENOSPC images, and terminal-control-last remain at `:1658-1685,1780-1857`. |
| **C2a — Q sibling correlation** | Preserved | The prebound absent/building/exact Q sibling and M5/M6 old/new authority images remain at `:1710-1717,1751-1753,2128-2151,2182-2183`. |
| **C3 — decoder contract** | Preserved | Decoder-owned `readInto`, declared/unknown length admission, semantic-token arithmetic, decoded duplicate handling, Unicode/BOM/base64 domains, and the closed result/error union remain at `:402-600`. |
| **C4 base inventory** | Preserved | The bounded no-follow journal-independent inventory, unknown-name failure, and J0/W1/W2/W3 precedence remain at `:308-351,618-665`; v5 adds only the disjoint legacy branch. |
| **C5 — receipt/oracle port** | Preserved | Plan-backed tables, bounded joins/windows, streaming receipt hash, proof token, and post-Git indeterminate/retry behavior remain at `:1245-1318`, matching the whole-map/array/token/string peaks in `src/engine/apply-receipt.ts:157-163,245-258,341-348,414-444,565-609,624-707`. |
| **C6 — construction peaks** | Preserved | Adapter budgets, `ConstructionPeakV1`, backing-store and codec overlap, pre-allocation `CP <= A`, phase liveness, and peak-live calibration remain at `:1443-1598`. |
| **C7 — U0 terminal semantics** | Preserved | Strong enumerable owner scope, serialized current-token custody, unconditional abort/owner-loss drain, and pending-through-apply/discard/release worker states remain at `:888-1033`. |
| **C8 — quarantine coherence** | Preserved | The summaries and normative path still require byte-exact/no-open standing-journal quarantine and limit `VACUUM INTO` to post-journal diagnostics/general backup (`:77-85,217-222,734-751`). Current quarantine uses bounded byte copies and publishes `COMMITTED` before source cleanup (`src/cli/reset-quarantine.ts:248-300`). |
| **C9 — coherence minors** | Preserved | v5 status, baseline-versus-target wording, 2.0-only/non-shippable U0, merge-only shared branch, and coupled seed measurement remain at `:3-6,29-34,102-133,271-287,888-892`. |

The architectural keystones also remain unchanged: reset retains file-swap
boundaries with transactions only between them; O/N remains a closed-file
byte-exact witness; standing-journal quarantine remains no-open; W2 still wins
before decode; Q is still the sole atomic authority flip; M7 retires prepared
siblings before canonical control; and every U0-U5 implementation remains
confined to 2.0. V5 introduces no competing authority, repair inference,
unknown-name admission, or broader doctor permission.

## Validation

- `git diff --check` passed.
- The targeted current reset baseline passed: 82 tests passed, 2 skipped, 0
  failed across `reset-journal-classifier`, `reset-io`, `reset-quarantine`,
  `reset-journal-doctor`, and `sync-git/reset-journal`.
- Those tests validate the live 1.7.6 behavior and keystone assumptions. The
  v5 design correctly requires new C4/C2b fixtures at implementation time; no
  unimplemented design-163 behavior is claimed as tested.

## Verdict

**ALIGNED**

C4 now represents every legal durable legacy reset artifact produced by the
supported code while keeping it bounded, inert, and fail-closed. C2b now gives
every future-control preparation, promotion, halted retry, power image, and
terminal retirement a durable identity-bound correlation with one immutable
M7 record. The v4-closed work and all keystones survived the fold.
