# 163 — The state plane moves to SQLite

Status: v5 — pending final ratification. v5 is the strictly additive targeted
fold for the final C4 legacy-reset inventory and C2b future-control correlation
findings; every v4 closure and keystone remains normative.
It is not implementation authority until the
orchestrator ratifies it. Field-claim corrections from r1 are folded below;
the steady-state write churn was root-caused and fixed separately by #349
(undefined-vs-{} guard bug; Git-plan bookkeeping was not the culprit). Origin:
founder step-back question
2026-07-19 ("is that not a lot of memory to need? what's the step-back?")
after the third guard-layer around monolithic state reads.

## Problem — one primitive, four symptom families (all field-evidenced)

Local workspace state is ONE JSON document (`.rbox/state.json`, 59,220,693 B
at 112,259 files on the founder's Mac). Every consumer must parse all of it
or nothing; every save rewrites all of it; every integrity guard must treat
the whole blob as potentially adversarial. The guards we have stacked around
that contract:

1. **Reset safety** — 64 MB flat cap (pre-138, silently broke recovery on
   77 MB fleet states) → 52× worst-case parse multiplier + 4 GiB floor
   (138) → machine-scaled 4 GiB floor / 32 GiB ceiling with a lower cgroup
   hard limit winning (161, after the founder's daemon crash-looped on a
   59 MB state, 2026-07-19). A separate 512 MiB materialized-input hard cap
   remains. Three tourniquets on the same artery.
2. **Interactive latency** — `rbox status` during initial sync: 12.2 s at
   192% CPU (fallback path: 59 MB parse + full scan + full diff + Git
   divergence). SQLite removes the baseline-parse/materialization component;
   it does not remove the filesystem scan or Git work. Steady-state trusted
   path measures 0.84 s (162 r1 evidence). That 0.84 s is the current baseline;
   the `<200 ms` value below is a prospective measured U2 target, not claimed
   parity or an inference that all 0.84 s is JSON work (r3 C9; r3c-5).
3. **Daemon memory** — the field log recorded RSS 2.95 → 6.41 GB over 23
   cycles. Code independently proves repeated full-state parsing plus multiple
   full manifests/maps, but not that JSON alone caused the entire slope. This
   design therefore claims and measures component reductions, not the whole
   observed slope.
4. **Cycle I/O** — before #349, field telemetry showed nominal
   `files=0 blobs=0` cycles rewriting ~59 MB. A true unchanged push already
   had a no-save branch; the field behavior was the undefined-vs-{} guard bug,
   now fixed. SQLite still changes a real state transition from an O(total
   state) rewrite to O(dirty rows), but no longer claims to fix true no-op I/O.

Prior art solved adjacent planes, never this one: 84 fixed the WIRE plane
(server-read deltas/fold); 85 Layer A shaved scan readdir (shipped and now
default-on); the daemon already owns and incrementally patches an in-memory
manifest, while Layer B's unbuilt part is CLI-to-daemon delegation; 138 made
blob reads SAFE, not cheap; 161 made the safety budget saner. The playbook
rule applies (growing-complexity-means-wrong-layer): find the battle-tested
primitive. It ships inside our runtime: **`bun:sqlite`** (SQLite, WAL mode,
zero new dependencies).

## Mechanism

### Store
`.rbox/state/state.db`, SQLite via `bun:sqlite`, WAL journal mode between
protocol commit points. The field-complete v1 logical schema, invariants, and
store API are normative below; this summary is deliberately not a competing
schema sketch.

### Access model
- **One workspace writer.** Normally this is the daemon; a direct CLI may write
  only after it owns the existing workspace mutex/state lock and no daemon
  writer. All between-boundary mutations use transactions. Reset, recovery,
  adoption, and quarantine remain file-swap protocols exactly as the keystone
  specifies below.
- **CLI = concurrent readers** (WAL allows readers during writes),
  read-only connections, busy_timeout bounded, fall back to
  daemon-ambient/trusted paths exactly as today when the db is locked or
  absent.
- Trusted status projections become indexed counts and ordered reads. The
  untrusted fallback must still observe disk and Git; this design removes its
  baseline parse but does not promise that the whole fallback is sub-200 ms.

### 138 interplay (the sensitive part)
- The reset/recovery classifier never opens a journal-governed database. It
  uses bounded, no-follow streaming hashes of closed, checkpoint-truncated DB
  files. Full `integrity_check` is explicitly off the open/classification path.
  Standing-journal quarantine uses bounded byte-exact copies and never opens a
  governed DB. Staged `VACUUM INTO` is confined to general backup/operator
  compaction and the optional post-quarantine diagnostic described below;
  reset's byte-exact protocol artifacts retain their separately specified copy
  path (r3 C8; r3c-1).
- 138's parse-admission guard (161-fixed) REMAINS for the legacy-JSON read
  paths (migration import, old-state recovery) — it is not deleted, it is
  bypassed by not having giant JSON to parse in steady state.
- Consent machinery, journal authorization, destructive-primitive
  capabilities, phase ordering, marker ordering, and Git-ref ordering are
  unchanged. The full re-derived normative table is below.

### Migration

Migration is a one-way, fenced authority transaction, not a DB-presence test.
It builds a sibling DB, writes the completion witness in the same transaction
as the imported rows, verifies a full semantic round trip, publishes the DB,
then atomically replaces the legacy state path with a durable old-reader
barrier. JSON remains authoritative through every earlier failure. The full
state machine and the stable guard/ENOSPC halts are normative below.

### Rollout
U0 entry interning/immutable structural sharing (independently implementable
and testable within 2.0, not independently shippable);
U1 store/schema/digest/backup modules and read-only adapters; U2 ordered
scan/reconcile/apply/push ports plus generation-CAS writes; U3 migration and
the old-reader barrier; U4 138 DB-artifact reset/quarantine flows; U5 fleet
bake with component telemetry. Default-on is allowed only after U4 review and
the barrier-compatible bake release; rig scenarios run migration from real
pre-163 states and every injected boundary below.

All design-163 **implementation** lands on a long-lived `2.0` branch created
from `main` when implementation starts. `main` remains the stable 1.7.x line;
design documents and reviews continue to merge to `main`, and periodic merges
**from `main` into `2.0`** keep the implementation branch current. The shared,
long-lived `2.0` branch is never rebased; a developer-local topic branch may be
rebased before it is merged (r3 C9; r3c-3+r3c-6).
The state-plane rewrite ships only as the 2.0 major version. No U0–U5 slice,
barrier, migration artifact, or half-migrated state plane rides an ordinary
1.7.x release. The barrier-compatible bake is a 2.0 prerelease, not a backport
of design-163 implementation to `main`.

## Acceptance targets (measured, not promised)
- Trusted `rbox status` with live daemon: < 200 ms on the 112k corpus. The
  unsettled fallback is reported separately as baseline-load, scan, diff, and
  Git-divergence components; it has no <200 ms promise. U2 reports the current
  0.84 s and post-U2 state-load/projection, daemon/RPC, scan/diff, and Git
  components separately. Failure to reach `<200 ms` is a target miss, not
  permission to broaden the claim about what SQLite removes (r3 C9; r3c-5).
- Record peak live `FileEntry` objects, SQLite cache, wire buffers, every
  `ConstructionPeakV1` phase, and RSS on
  the same corpus. Pass/fail is the explicit budgets below, not an unsupported
  promise that the entire historical multi-GB slope vanishes (r3 C6; r3b-2).
- An authoritative BASE/LOCAL transition writes O(dirty rows); a true no-op
  commits nothing. Full scan/remote/wire **staging** may write O(N) rows to an
  ephemeral file-backed spool, which is measured separately and never bloats
  the main DB/WAL.
- Reset admission errors: structurally impossible on the db path.

## Non-goals
- Wire protocol / server anything (84 unchanged).
- Hash-cache/dircache **authority consolidation into `state.db`**. Their
  workspace-sized JS maps are nevertheless incompatible with U2's memory
  contract, so U2 gives HashCache, DirCache, and EncryptAddressCache one
  separate cursor-backed `.rbox/state/cache-v2.db`; it is rebuildable,
  non-authoritative, independently deletable, and is never consulted to elect
  BASE/LOCAL authority. This is a representation change inside design 163,
  not consolidation into the authority DB.
- Multi-process writers (daemon stays the single writer).
- Network filesystems: `.rbox` on NFS/SMB is unsupported for the db as for
  the blob today; doctor gains a detection warning at most.

## Risks for the review to attack
- 138 crash-window re-derivation completeness (the normative row table).
- SQLite corruption classes vs JSON corruption classes (integrity_check
  coverage, torn-WAL behavior on power loss, fsync discipline flags).
- bun:sqlite behavior under the crypto-pool worker threads (connections are
  NOT shared across threads — confirm the engine's access topology).
- Migration on the 512 MiB+ pathological states (guarded import must
  refuse exactly as today, leaving the workspace recoverable).
- Query-set completeness: any engine path that secretly wants the whole
  manifest in memory (apply? scan diffing?) — those keep an iterator/cursor
  contract, not a full materialization.

## Growth model & maintenance (added v2 — founder question 2026-07-19)

State is a keyed snapshot, not an event log: active plane row count tracks
workspace size, never change volume. Ephemeral stage DBs have identity-scoped
crash cleanup; superseded interned values are collected after no active plane
or reader references them. Append-shaped data
(tombstone chains, deferrals) ports design 130's existing hard caps (8/ref,
expiry, per-repo caps) as row-count bounds. Churn fragments pages onto
SQLite's freelist, which is REUSED — the file plateaus at its high-water
mark rather than growing; a workspace that shrinks massively is compacted
by explicit `incremental_vacuum` from doctor/idle time or staged
`VACUUM INTO` publication during an operator backup/compact action (the
JSON blob "vacuums" on every save today — that continuous implicit rewrite
is precisely the removed cost; we trade it for a rare explicit one). WAL
growth is **managed, not claimed to have a universal byte cap**: an external
read-only process can legally pin an old end mark. The pinned checkpoint and
write-backpressure policy below stops repeated growth and measures the one-
transaction overshoot; `-wal`/`-shm` lifecycle is part of the crash table.
Precedent: browser history/iMessage/Photos run
years-long constant-churn single-file SQLite at this exact shape.

## Keystone: file-swap at reset boundaries, transactions in between (r1 f1+f2)

RULING (2026-07-19, from the RESEARCH-138-BOUNDARIES extraction): design 163
does NOT replace 138's file-swap mechanics. It keeps them, byte-for-byte in
protocol terms, and changes only the payload format:

- **Steady state** (normal daemon operation, between 138 commit points):
  `state.db` is written via WAL transactions — the incremental, row-local
  writes that remove the per-cycle full serialize. `journal_mode=WAL`,
  `synchronous=FULL`, pinned and verified at open (r1 f8).
- **Every 138-relevant boundary** (reset, recovery, adoption, quarantine)
  uses the existing choreography unchanged: build a CANDIDATE database at a
  sibling path; close it; checkpoint(TRUNCATE) so no `-wal`/`-shm` remains;
  fsync file + parent; verify; atomically rename into place under the same
  journal phases, marker writes, and ref-group retirement order the current
  implementation performs. The candidate artifact is a .db instead of a
  .json — the P*/R*/I*/Z0 rows carry over with artifact substitution, plus
  new rows for the WAL sidecar states (below).
- **The byte-hash-exact witness SURVIVES**: an at-rest, closed,
  checkpoint-truncated SQLite file has stable bytes, so 138's exact-old /
  exact-new classification hashes the file exactly as it hashes JSON today.
  No logical digest is required on the reset path (r1 f2 resolved by
  construction; the digest idea is withdrawn).
- **Reset entry quiesces the WAL first**: quiesce/close readers, run
  `checkpoint(TRUNCATE)` on the owning writer, close that writer, then verify
  sidecar absence. A `state.db` accompanied by `-wal`/`-shm` at
  classification time is NOT at rest: it is a crash-window signature of its
  own. Two new normative rows (W1: wal-present + journal
  absent → normal daemon takeover, replay by SQLite on open; W2: wal-present
  + journal present → halt, zero writes, the journal governs) are specified in
  the complete table below.
- **Standing-journal quarantine never opens active, candidate, or archive**:
  it uses bounded byte-exact bundle copies and preserves the O/N witnesses.
  `VACUUM INTO` is permitted only for general backup/operator compaction and
  the optional diagnostic active snapshot after quarantine is committed and
  the reset journal is durably absent; that output is never a reset/quarantine
  witness and is never restored beneath an O/N witness (r3 C8; r3c-1).

**Keystone deviation ledger:** none. The exact next SQLite bytes are carried
as a bounded journal payload rather than regenerated, so no extra durable
pre-P0 artifact/boundary is introduced. Any future alternative must be marked
`DEVIATION:` at the point of proposal with its safety proof.

## Normative SQLite re-derivation of the 138 crash windows (r1 f1+f2)

This section replaces design 138's physical-state table only when the durable
state authority is SQLite. Its consent and durable-authorization gates,
correlated-classification rule, recovery-ref order, active-ref group order,
and recovery outcomes remain normative. Classification is read-only. An
observation matching no *complete* row below is ambiguous and **must halt with
zero writes**.

### Canonical artifacts and exact notation

- Active DB: `.rbox/state/state.db`.
- Candidate: `.rbox/state/reset-candidates/<journal-id>.db`.
- Old-lineage archive:
  `.rbox/state/lineages/<old-nonce>/<old-state-sha256>.db`.
- Reset journal and incarnation marker retain their paths:
  `.rbox/state/reset-v1.json` and `.rbox/state/state-incarnation.json`.
- The SQLite-authority sentinel at the legacy `.rbox/state.json` path is the
  migration section's `Q`. `Q` is an invariant/gate, not a replacement for the
  incarnation marker.
- The journal retains authorization record v2 but uses the frozen
  `stateFormat:"sqlite/v1"` union below. A pre-migration JSON-state journal is
  recovered before M0 under JSON authority; such a journal beside `Q` is a
  format mismatch and halts. `authorityId` must equal the 32-hex id in exact
  `Q`; `sqliteApplicationId`, `sqliteUserVersion`, and `storeSchemaVersion`
  must equal the compiled v1 constants before any artifact hash is actionable.
- For any `x.db`, the only recognized sidecars are `x.db-wal`, `x.db-shm`,
  and `x.db-journal`. Presence is established with no-follow `lstat`; a
  symlink, directory, device, unstable identity, unreadable entry, or sidecar
  beside an absent main file is `other`.
- `S0` means all three sidecars are absent. `SW` means `-journal` is absent
  and at least one of `-wal`/`-shm` is present as a regular file: WAL only,
  WAL+SHM, or SHM only. A zero-byte sidecar still counts as present. A rollback
  journal is always `other` because this store is pinned to WAL.
- Active `O`/`N` means the bounded streaming SHA-256 of the complete regular
  main DB file equals `journal.old.stateSha256` /
  `journal.next.stateSha256`. Candidate `N` and archive `O` have the same
  context-specific meanings. The hash never includes sidecars and is never a
  logical digest. Pre/post stat identity must match. The classifier never
  opens a DB, because an open could recover WAL or create sidecars.
- Candidate `N` is reproducible without relying on SQLite physical-layout
  determinism: reset's next state is the bounded empty-lineage DB. Preparation
  builds it privately, commits, checkpoints(TRUNCATE), closes, verifies,
  reads it under a 256 KiB `RESET_NEXT_DB_SEED_LIMIT`, hashes it, then removes
  the private temp before P0. Schema-v1's empty-lineage fixture must fit that
  cap, and base64 plus the remaining record must fit the shared 512 KiB
  `RESET_JOURNAL_BYTE_LIMIT`; exceeding either is a pre-P0 design/version refusal, not
  permission to raise a reset read bound implicitly. The authorized prepared
  journal carries both `next.stateSha256` and exact `next.dbBytesB64`.
  Recovery writes those
  authenticated bytes to create/re-create the canonical candidate. A private
  temp crash is inert, never an artifact-axis value, and is removable only by
  the existing positively identified temp-file discipline.
  The 256 KiB value is a provisional reviewed ceiling, not a measured
  schema-v1 size claim. Before U1 implementation authority, CI records and
  pins the generated empty-lineage fixture's exact byte length. If that
  measurement requires adjustment, U1 changes `RESET_NEXT_DB_SEED_LIMIT`, the
  base64 bound, and the complete-journal fit fixture together; no one cap rises
  implicitly or independently (r3 C9; r3c-4).
- Quarantine's bundle manifest records the exact reset-journal hash/length and,
  for the SQLite branch, decoded candidate length/hash; doctor never expands
  base64 until the complete journal has passed the bounds below and never emits
  decoded bytes over 256 KiB.
- `MO`, `MN`, `M∅`, and `Mpre={MO,M∅}` keep design 138's meanings. `MO`/`MN`
  are schema-exact semantic equality of `{stream,stateNonce,stateRevision}`;
  marker JSON whitespace is irrelevant. Before the reset's marker write only
  `Mpre` is admitted; afterward only `MN` is.
- Journal Z entries are `E1..En` in global `(activeRef,targetOid)` lexical
  order. `Rk` means exactly `E1..Ek` recovery refs exist at exact targets and
  all later refs are absent. It is one global prefix, not per-repository.
- Common-directory groups are `D1..Dm` in `commonDirReal` lexical order.
  `Ag` means every active ref in `D1..Dg` is absent and every later group is
  uniformly exact-present. A mixed group or non-prefix group vector is
  `other`. When `n=0`, `R0=Rn`; when `m=0`, `A0=Am`.
- In action cells, `old:` is the next roll-forward mutation when durable config
  names the old stream. `next:` “complete-retirement from X” still executes X
  and every later state/marker/ref/journal boundary; it is not cleanup-only and
  never skips an unfinished install.

### Journal-independent reset namespace inventory (r3 C4; r3a-2)

Before reading or decoding any reset-journal byte, J0/W1/W2 classification runs
one shared `ResetNamespaceInventory`. It never uses `journal.id`,
`old.stateNonce`, `old.stateSha256`, or any other journal field to discover a
path. It inventories exactly the fixed active DB and sidecars, one level under
`.rbox/state/reset-candidates/` for `<lower-hex32>.db` mains and their three
sidecars, and two levels under `.rbox/state/lineages/` for
`<lower-hex32>/<lower-hex64>.db` mains and their three sidecars. A protocol
directory may be absent. No symlink is followed at a root, directory, main, or
sidecar.

`RESET_NAMESPACE_ENTRY_LIMIT=16,384` counts every directory entry returned,
including lineage directories and names later rejected. Directory identities
are no-follow `lstat`-bracketed before and after each bounded `readdir`; a
change restarts the whole read-only inventory at most three times and then
returns `RESET_NAMESPACE_BUSY`. Excess depth, an invalid reserved name, an
unreadable directory/root, directory symlink, or overflow returns
`RESET_NAMESPACE_INVALID` with the exact path/type and **halts with zero writes
before journal decode**. At a recognized main/sidecar name, a symlink, device,
socket, directory, unreadable entry, or sidecar-without-main is instead recorded
as exact `other` without following/opening it, so standing-journal precedence
still selects W2 and no-journal classification selects its exact corruption/W3
halt. Recognized positively identified protocol temps are reported separately
as inert; they are never a main, sidecar, or actionable artifact and their
existing owner-specific cleanup rule is the only rule that may remove them.
Unknown names in either reserved protocol directory are invalid rather than
silently skipped.

After a successful inventory the precedence is closed:

1. With a standing journal, any inventoried DB sidecar vector other than `S0`
   is W2 before decode, whether or not the journal is malformed.
2. With a standing journal and every inventoried DB at `S0`, decode runs; a
   rejection is J0. A valid journal may then name only the already-inventoried
   canonical candidate/archive. Every other regular `S0` main remains inert
   and no P/R/I/Z action adopts or deletes it.
3. With no journal, active `SW` is W1 only when every inventoried candidate and
   archive is `S0`. With a valid active `S0`, regular `S0` orphan mains are
   inert ordinary-state debris. Any candidate/archive sidecar is W3 below.

Thus exact Q + valid active S0 + an orphan-candidate WAL is deterministically
W3, never ordinary state, W1, or a journal-derived guess. The inventory result
and error union are shared by live recovery, doctor, quarantine, and tests.

#### Retained legacy-JSON namespace branch (v5 C4)

The word `exactly` above closes the SQLite-artifact branch; the same shared
inventory has this one additional, disjoint legacy branch for files that the
supported 1.7.x reset protocol durably created. Directly under
`reset-candidates/`, `<lower-hex32>.json` is a legacy candidate. At the second
level under `lineages/`, `<lower-hex32>/<lower-hex64>.json` is a legacy archive.
The first component is respectively the legacy journal id or state nonce and
the second is the legacy state SHA-256. Case, lengths, suffixes, separators,
and depth are exact. A `.json` name has no recognized sidecars; for example,
`.json-wal` is an invalid reserved name, not a WAL. A legal `.db` and legal
`.json` entry with the same stem are two separately inventoried entries.
Nothing in this branch admits any other name.

Every legacy directory and file entry counts toward the same
`RESET_NAMESPACE_ENTRY_LIMIT`. The same no-follow directory brackets apply.
A legacy leaf is `legacy-exact` only when it is a no-follow regular,
identity-stable, readable directory entry; inventory does not open, parse, or
hash its possibly workspace-sized bytes. A recognized legacy leaf that is a
symlink, directory, device, socket, unreadable, or identity-changing is
`legacy-other`. Inventory records that disposition rather than following the
entry. With a standing SQLite reset journal, any inventoried DB sidecar still
selects W2 before evaluation of `legacy-other` and before journal decode. With
no such sidecar, `legacy-other` is a typed `RESET_LEGACY_ARTIFACT_INVALID`
zero-write halt before decode. Unknown names retain the existing
`RESET_NAMESPACE_INVALID` behavior; this legacy grammar does not make unknown
handling permissive.

The disposition of `legacy-exact` is closed and always inert to the SQLite
protocol. Before M0, a standing legacy JSON reset journal must be recovered by
the supported 1.7.x JSON protocol, which alone may correlate its exact
candidate/archive; migration cannot start while that journal stands. With no
standing legacy journal, a crash-left candidate and every retained historical
archive survive M0--M7 and the Q flip unchanged. Under exact Q, with or without
a standing SQLite reset journal, J0/W1/W2/W3 and P/R/I/Z inspect these entries
only for bounded namespace name/type/identity stability. They never use their
bytes or paths as O/N, never adopt, open, hash, copy, quarantine, rename, or
delete them, and never derive an SQLite journal field from them. Migration
retirement/cleanup vectors likewise cannot contain them. Thus exact retained
legacy files neither block migration nor become cleanup authority, while a
crash-left candidate remains as inert as a retained archive.

Every later use of “every DB in the journal-independent inventory” continues
to quantify only active and `.db` mains for `S0`/sidecar purposes; every use of
the complete inventory additionally includes the legacy branch for entry
count, no-follow identity, churn, and the exact disposition above. This
partition preserves W2-before-decode without pretending a legacy JSON file is
a SQLite main.

### One bounded exact reset-journal decoder (r3 C3; r3a-1+r3c-2)

`src/cli/reset-journal-codec.ts` is the sole raw-byte decoder for live
recovery, doctor (including inspection), quarantine bundle validation/restore,
and reset tests. It exports `RESET_JOURNAL_BYTE_LIMIT=524,288`,
`RESET_JOURNAL_READ_CHUNK=65,536`, the unions below, and this exact pull
interface:

```text
ResetJournalByteSource {
  readonly declaredLength: number | null
  readInto(destination: Uint8Array): Promise<{bytesRead:number,done:boolean}>
}

DecodeResetJournalResult =
  | {ok:true, journal:LegacyV1|LegacyV2|SQLiteV2,
     rawLength:number, rawSha256:lowerHex64}
  | {ok:false, error:{code:ResetJournalDecodeErrorCode,
     byteOffset:number|null, jsonPath:string|null, limit:number|null}}
```

The decoder owns the one fixed 64 KiB input buffer and every destination view;
the producer never returns or retains a producer-owned chunk. `bytesRead` is an
integer in `0..destination.byteLength`, only that prefix may be written, and
`done:true` means permanent EOF. Zero bytes with `done:false`, bytes after
`done`, retention/mutation of the destination, or any out-of-range result is
`SOURCE_PROTOCOL`. `declaredLength`, when present, must be a nonnegative safe
integer and is rejected before the first read when above 512 KiB. Early EOF or
even one byte after the declaration is `DECLARED_LENGTH_MISMATCH`; unless the
last declared byte arrived with `done:true`, the decoder performs one
single-byte sentinel read to authenticate EOF. A valid known declaration uses
exactly `declaredLength` as the unchanged design-161 52× admission input before
the first read. With no
declaration, the unchanged design-161 52× admission input is the full 512 KiB
cap before the first read—not zero or bytes observed so far. The machine reads
at most the cap plus one sentinel byte; sentinel presence is `RAW_OVERFLOW`.
No caller may first read a quarantine artifact with the 2 GiB streaming cap
and hand the resulting buffer to a local parser. `reset-journal.ts`,
`reset-journal-doctor.ts`, and `reset-quarantine.ts` import this module; they
own no duplicate parser or local journal-size constant.

After admission, a strict streaming JSON machine—not `JSON.parse`—uses at most
six simultaneously open containers, with the root object at depth one; 4,096
object members; 8,192 semantic tokens; 256 `old.z` elements; a 32-byte decoded
ASCII member name; and
`RESET_JOURNAL_NON_B64_STRING_UTF8_LIMIT=524,288` aggregate decoded UTF-8 bytes
for non-`dbBytesB64` **value strings** (member names and `dbBytesB64` excluded).
One token is charged for each container open, container close, decoded member
name, and scalar value. Colons, commas, whitespace, and EOF charge no token.
The maximum SQLite-v2 shape has 517 containers, 3,611 member names, and 3,351
scalars: `2*517 + 3,611 + 3,351 = 7,996`. Maximum legacy-v2 with telemetry is
`2*521 + 3,615 + 3,351 = 8,008`, so both fit 8,192. CI pins exact
255/256/257-Z fixtures and both maxima.

The aggregate cap deliberately equals the raw cap. A literal UTF-8 scalar
uses the same bytes in the raw input; every JSON escape uses at least as many
raw bytes as its decoded UTF-8 contribution. Therefore every raw-admitted
document also fits the aggregate bound; the former 128 KiB cap cannot reject a
256-Z document independently. Individual 4,096-byte string caps are a
conjunction with the 512 KiB raw cap, not a claim that the Cartesian product
of every per-field maximum is encodable. Journal-creation fixtures include 256
production-maximum-count Z descriptors and the measured empty DB seed, and
assert both raw and aggregate admission.

Each object frame is one fixed key-bitset. Member comparison occurs on the
decoded UTF-16 value after JSON escape processing, so `"id"` and
`"\u0069d"` address the same bit and the latter is a duplicate. An unknown
decoded member is rejected as soon as its key is scanned, and a set bit rejects
the duplicate before its value is scanned or an ordinary JS object exists.
Raw input must be strict UTF-8 and a leading UTF-8 BOM is `BOM_FORBIDDEN`;
U+FEFF inside a string is ordinary string data. Escaped unpaired surrogates are
preserved as exact ECMAScript UTF-16 code units for legacy compatibility; for
aggregate accounting each unpaired code unit contributes the three UTF-8 bytes
of U+FFFD, matching `TextEncoder`, while valid pairs contribute their scalar's
UTF-8 length. ASCII/path/hex/base64 validators still reject a surrogate where
their field contract does not allow one.

Numbers are JSON decimal integers matching `0|[1-9][0-9]{0,15}`, then must be
nonnegative safe integers. Arrays are legal only at `old.z` and the legacy
branch's exact empty `lastSyncedManifest.files`; every other value has the
scalar/object shape printed below. These structural caps, plus the raw
document cap, apply to arbitrary bytes before schema validation, preserving
design 138's fail-closed arbitrary-JSON contract without relying on the 52×
giant-state parse budget.

The accepted root key sets are closed and exhaustive:

```text
legacy v1: [v,id,phase,createdAt,old,next]
legacy v2: [v,id,phase,createdAt,authorization,old,next]
SQLite v2: [v,stateFormat,id,phase,createdAt,authorization,authorityId,
            sqliteApplicationId,sqliteUserVersion,storeSchemaVersion,old,next]
```

`v:1` selects only legacy v1. With `v:2`, presence of `stateFormat` selects the
SQLite set, whose discriminator must be exactly `"sqlite/v1"`; absence selects
legacy v2. No other selection is
permitted. Therefore a pre-163 exact-key decoder rejects the SQLite root's five
extra members, and the new decoder rejects a SQLite member on the legacy branch
or legacy `next.state` on the SQLite branch. `v` is numeric `2` in both. The
SQLite branch is this exact discriminated JSON/TypeScript shape; bracketed
lists are the exhaustive key order-insensitive sets for every object:

```text
root [v,stateFormat,id,phase,createdAt,authorization,authorityId,
      sqliteApplicationId,sqliteUserVersion,storeSchemaVersion,old,next]
  v: 2
  stateFormat: "sqlite/v1"
  id, authorityId: lowercase hex32
  phase: "prepared" | "ready" | "installed" | "z-retired"
  createdAt: canonical YYYY-MM-DDTHH:mm:ss.sssZ
  sqliteApplicationId: 1380077400           // PRAGMA application_id=0x52424f58
  sqliteUserVersion: 1                      // PRAGMA user_version
  storeSchemaVersion: 1                     // store_meta.schema_version
  authorization [version,authorizedNextStream,consentKind,mintedAtRevision]
    version: 2
    authorizedNextStream: string
    consentKind: "setup-rebind" | "setup-create"
    mintedAtRevision: nonnegative safe integer
  old [stream,stateNonce,stateRevision,stateSha256,archiveBaseline,z]
    stream: string
    stateNonce: lowercase hex32
    stateRevision: nonnegative safe integer
    stateSha256: lowercase hex64
    archiveBaseline: "absent" | "exact"
    z: array, length <= 256, in the existing global lexical order
      element [lineageHash,repositoryIdentityHash,repositoryIdentity,
               activeRef,targetOid,recoveryRef]
        lineageHash, repositoryIdentityHash: lowercase hex64
        targetOid: lowercase hex40
        activeRef, recoveryRef: exact strings derived by design 138
        repositoryIdentity [relPath,kind,worktreeId,gitDirReal,
                            commonDirReal,dev,ino,birthtime]
          kind: "dir" | "pointer"; the other seven fields are strings
  next [stream,stateNonce,stateRevision,stateSha256,dbBytesB64]
    stream: string
    stateNonce: lowercase hex32
    stateRevision: nonnegative safe integer
    stateSha256: lowercase hex64
    dbBytesB64: canonical padded RFC 4648 base64
```

For both v2 branches,
`authorization.authorizedNextStream===next.stream` is mandatory. The complete
legacy nested union is also frozen here: v1 `old` is exactly
`[stream,stateNonce,stateRevision,stateSha256,z]`; v2 `old` is exactly the
SQLite `old` key set above; every Z and repository-identity object uses the
same exact sets above. Legacy `next` is exactly
`[stream,stateNonce,stateRevision,stateSha256,state]`. Its `state` is exactly
`[stream,stateNonce,stateRevision,lastSyncedSequence,lastSyncedManifest,
repoRecords]` or that set plus `telemetryBindingId`; its three lineage values
equal `next`, sequence is numeric zero, telemetry when present is lowercase
hex16, `repoRecords` is an exact empty object, and `lastSyncedManifest` is
exactly `[generatedAt,files]` with `generatedAt:""` and an empty `files`
array. The legacy canonical state-line hash must equal `next.stateSha256`.

String byte caps are measured after strict UTF-8 decoding: `stream` and
`authorizedNextStream` are each <=4,096 bytes and contain no NUL; every
repository-identity string is <=4,096 bytes and retains the existing safe-path,
absolute-path, kind, and unsigned-decimal-u64 validation; derived refs are
<=192 ASCII bytes and must equal their derivation; the timestamp is 24 ASCII
bytes; enums and fixed hex fields have exactly the lengths shown.
`dbBytesB64` is ASCII, at most 349,528 bytes, has length divisible by four, and
matches
`^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`.
Before allocation, encoded length and padding must imply a decoded length
from 1 through 262,144 bytes. After one exactly-sized decode, re-encoding must equal the
**decoded JSON string** byte-for-byte and `sha256(decoded)` must equal
`next.stateSha256`; the raw JSON lexeme is never compared. Thus an escaped
lexeme such as `"\u0051Q=="` is evaluated as the decoded string `"QQ=="`
(r3 C3; r3a-1).

`ResetJournalDecodeErrorCode` is the stable closed union
`SOURCE_PROTOCOL | SOURCE_IO | DECLARED_LENGTH_INVALID |
DECLARED_LENGTH_OVER_LIMIT | DECLARED_LENGTH_MISMATCH | RAW_OVERFLOW |
MEMORY_ADMISSION | UTF8_INVALID | BOM_FORBIDDEN | JSON_SYNTAX | DEPTH_LIMIT |
TOKEN_LIMIT | MEMBER_LIMIT | MEMBER_NAME_LIMIT | STRING_LIMIT | Z_LIMIT |
UNKNOWN_MEMBER | DUPLICATE_MEMBER | MISSING_MEMBER | TYPE_MISMATCH |
NUMBER_NONCANONICAL | NUMBER_RANGE | STRING_INVALID | BASE64_FORMAT |
BASE64_LENGTH | BASE64_NONCANONICAL | EMBEDDED_HASH_MISMATCH |
SCHEMA_DISCRIMINATOR | AUTHORIZATION_MISMATCH | APPLICATION_ID_MISMATCH |
SCHEMA_ID_MISMATCH`. Expected hostile input and source I/O return the union;
only a programmer invariant may throw. All consumers propagate the exact code
and fields unchanged into J0 (r3 C3; r3a-1).

All branches pass through this same duplicate-safe token machine and caps. Any
limit, UTF-8, grammar, duplicate, missing/extra-key, scalar, base64, embedded
hash, application-id, or schema-id decoder failure with exact Q and every
inventoried DB at `S0` classifies only as
**J0 — standing-journal decoder rejection**:
halt with zero writes before O/N hashes, config eligibility, refs, marker, or
artifact paths become actionable. If any sidecar is present, W2 wins before
decode. A successfully decoded journal whose `authorityId` does not match Q or
whose authorization/config eligibility fails takes the existing unlisted
pre-hash zero-write halt, not J0. J0 is never coerced to P0, P0A, or a
no-journal row. Fuzz tests feed
arbitrary 512 KiB documents, duplicate keys at every object level, every cap
boundary, and noncanonical base64 through all three production consumers and
require the same typed halt and zero-write snapshot.

Journal creation has no privileged bypass. It calls
`encodeResetJournal(value)` from the shared module, then feeds the exact bytes
back through `decodeResetJournal` and all authorization/context checks before
P0 publication. A value that exceeds any raw, aggregate-string, Z, or base64
cap is a pre-P0 design/version refusal, never a journal that recovery cannot
decode.

Every P/R/I/Z row below requires `Q` exact and **`S0` for every DB in the
journal-independent inventory**, including active and the journal's canonical
candidate/archive when its main is absent. Other regular S0 mains are inert.
Thus the table enumerates every admitted actionable main-file/sidecar signature;
no journal-derived discovery or sidecar cross-product is implicit (r3 C4;
r3a-2).

### Gates before the row table

The recovery implementation preserves design 138's two-pass fence order:

1. **Pure preflight:** run the journal-independent namespace inventory, then
   bounded-read exact `Q`, freshly read durable config, and journal
   bytes/identity. Observe every inventoried sidecar before parse so a present
   journal+sidecar can halt W2 without opening a DB or trusting a journal field.
   With every inventoried DB at `S0`, parse the journal,
   require state format/authorization/config eligibility, verify the Z identity
   descriptors, and perform a complete read-only physical classification.
2. Derive the canonical repository recovery requests from that validated Z set;
   acquire the workspace mutex and repository fences in canonical order with
   the state/store lock last. For W1 (no journal), acquire only the ordinary
   single-writer/state ownership required for takeover.
3. **Held-fence authority pass:** close every DB handle owned by this isolate,
   then freshly rebuild the journal-independent inventory and reread `Q`,
   durable config, journal bytes+identity, repository identities, all main
   hashes, marker, recovery refs, and active-ref groups. Re-run the complete
   classifier. Journal identity/Z-set or inventory change means
   release and restart fence derivation; no action runs under a fence derived
   from different bytes.
4. Only the held-fence pass may return W1/P/R/I/Z as actionable. Malformed,
   legacy-v1, wrong state format, unauthorized witness, third stream, missing
   `Q`, or any unlisted correlation halts.

Both classifications are read-only. Directory and sidecar lstat identities are bracketed
before and after every main-file hash; appearance/disappearance/change restarts
classification (or W2 under a standing journal). No bounded query, `PRAGMA`,
logical digest, integrity check, checkpoint, or cleanup is allowed during
observation.

### Decoder/WAL rows J0, W1, W2, and W3 (r3 C4; r3a-2)

| Row | Reset journal | Complete admitted signature | Action |
|---|---|---|---|
| **J0 — standing-journal decoder rejection** | present; the shared decoder rejects | `Q` exact and every DB in the journal-independent inventory is `S0`. No main-file hash, marker, ref, config, or journal field is interpreted after rejection. | **Halt, zero writes.** Report the exact typed bounded-decoder result and journal identity only. Do not open/hash/copy/delete a DB, touch refs/marker/config, quarantine automatically, or enter P/R/I/Z. |
| **W1 — ordinary SQLite crash takeover** | absent | `Q` exact; active main is a regular file; active sidecars are exactly `SW`; there is no rollback journal. Every inventoried reset-candidate/archive has `S0` and its main is absent or a no-follow identity-stable regular file; regular main bytes are inert and neither adopted nor deleted by this row. Any `other` main takes the typed zero-write corruption halt instead of W1. | Only the owning writer may open active. Let SQLite perform ordinary WAL recovery; perform the cheap application/schema/authority/lineage checks below; verify WAL/FULL; require a non-busy `wal_checkpoint(TRUNCATE)`; close; require active `S0`; fsync the DB and its parent; recheck exact `Q`, journal absence, and the inventory before normal work. SQLite recovery failure is a typed corruption halt. Never delete a suspect WAL to force progress. |
| **W2 — sidecar under a standing reset journal** | present, valid or malformed | `Q` exact; any DB in the journal-independent inventory has a sidecar vector other than `S0`, including `SW` and `other`. Main hashes and journal fields are not interpreted while any sidecar exists. | **Halt, zero writes.** Do not open any DB, decode the journal, replay/checkpoint WAL, remove a sidecar, repair an artifact, touch refs, or enter a P/R/I/Z action. Report the complete bounded inventory. The journal governs, and P0 promised at-rest files. |
| **W3 — orphan sidecar without a journal** | absent | `Q` exact; active is a valid authoritative regular DB at `S0`; at least one inventoried candidate/archive has a sidecar. | **Halt, zero writes** with `ResetOrphanArtifactHalt`. Do not open the orphan, normalize/delete a sidecar, or infer a journal id. Exact Q + valid active S0 + orphan candidate WAL is this row. |

No-journal + exact `Q` + a valid authoritative regular active DB + active `S0`
is ordinary steady state and needs no W row; regular candidate/archive mains
at `S0` are inert and remain untouched. With no journal, invalid/missing
`Q`, active absent/nonregular/foreign, rollback journal, a sidecar beside an
absent main, or any other unrecognized signature is a typed authority/corruption
halt—not genesis and not permission to remove a sidecar.
SHM-only is deliberately included in W1/W2; SHM has no durable transaction
content, but its presence proves the file set is not the promised at-rest
signature and only SQLite may normalize it when no journal governs.

### Correlated P/R/I/Z allow table

| Window id and durable boundary | Journal phase | Active | Candidate | Archive | `archiveBaseline` | Marker | Recovery refs | Active refs per common-dir group | Recovery action for a match |
|---|---|---|---|---|---|---|---|---|---|
| **P0 — prepared journal published**, before candidate creation | `prepared` | `O` | absent | absent | `absent` | `Mpre` | `R0` | `A0` | old: durably write exact journal-carried next DB bytes as candidate `N`; next: complete-retirement from candidate-create |
| **P0A — prepared journal adopts a pre-existing exact archive** | `prepared` | `O` | absent | `O` | `exact` | `Mpre` | `R0` | `A0` | old: create candidate `N`, then skip the already-satisfied archive copy; next: complete-retirement from candidate-create |
| **P1 — candidate DB created** | `prepared` | `O` | `N` | absent | `absent` | `Mpre` | `R0` | `A0` | old: byte-exact bounded-copy active DB to archive; next: complete-retirement from archive-create |
| **P2 — archive created** | `prepared` | `O` | `N` | `O` | `{absent,exact}` | `Mpre` | `R0` | `A0` | old: create recovery ref `E1`, or publish `ready` when `n=0`; next: complete-retirement from that step |
| **P3.k — recovery ref `Ek` updated**, one row for every `1≤k≤n` | `prepared` | `O` | `N` | `O` | `{absent,exact}` | `Mpre` | `Rk` | `A0` | old: create `E(k+1)` when `k<n`, otherwise publish `ready`; next: complete-retirement from that step |
| **R0 — ready phase written** | `ready` | `O` | `N` | `O` | `{absent,exact}` | `Mpre` | `Rn` | `A0` | old: candidate→active rename; next: complete-retirement from that rename |
| **R1 — rename observed with candidate absent** | `ready` | `N` | absent | `O` | `{absent,exact}` | `Mpre` | `Rn` | `A0` | old or next: active is already exact-new; fsync active/destination parent, remove candidate with absent-success semantics, fsync candidate/source parent, then publish `installed`; never recreate or rename candidate |
| **R2 — candidate re-created/resurrected beside installed active** | `ready` | `N` | `N` | `O` | `{absent,exact}` | `Mpre` | `Rn` | `A0` | old or next: revalidate both exact-new files; fsync destination parent, durably unlink redundant candidate, fsync source parent, then publish `installed`; never rename it over active |
| **I0 — installed phase written** | `installed` | `N` | absent | `O` | `{absent,exact}` | `Mpre` | `Rn` | `A0` | old: state exactness check; next: complete-retirement from that check |
| **I1 — state check completed** | `installed` | `N` | absent | `O` | `{absent,exact}` | `Mpre` | `Rn` | `A0` | old: durable marker-write `MN`; next: complete-retirement from marker-write |
| **I2 — marker written** | `installed` | `N` | absent | `O` | `{absent,exact}` | `MN` | `Rn` | `A0` | old: retire `D1`, or publish `z-retired` when `m=0`; next: complete-retirement from that step |
| **I3.g — group `Dg` retired**, one row for every `1≤g≤m` | `installed` | `N` | absent | `O` | `{absent,exact}` | `MN` | `Rn` | `Ag` | old: retire `D(g+1)` when `g<m`, otherwise publish `z-retired`; next: complete-retirement from that step |
| **Z0 — z-retired phase written** | `z-retired` | `N` | absent | `O` | `{absent,exact}` | `MN` | `Rn` | `Am` | old or next: unlink journal + fsync parent, then idempotent journal-id-scoped candidate cleanup |

`I0` and `I1` are intentionally observationally identical. The state check is
a raw-file exact-hash no-op for every internally admitted signature. Active
absent/`O`/`other` under `installed` remains unlisted; the implementation must
not widen the allow set to make a repair branch reachable.

After journal unlink and parent fsync there is no standing-journal
classification. Terminal candidate cleanup is idempotent and cannot authorize
another write. Recovery outcomes remain exact: eligible config=old rolls
forward; eligible config=next completes retirement; everything else halts.

### Unlisted signatures halt

The deny remainder includes, without limitation: active absent/`other`; a main
artifact that is not regular/no-follow/identity-stable; a valid SQLite DB with
the wrong physical hash; candidate `O`/`other`; archive `N`/`other`; the
**prepared+active-O+candidate-absent+archive-O** initiation shape without exact
P0A baseline; any baseline value/correlation not printed in the table; any active/candidate/archive sidecar under a journal;
marker `other` or `MN` too early; a non-prefix recovery-ref vector; a mixed
active-ref group; a non-prefix retired-group vector; repository identity
mismatch; stale/same-stream wrong nonce or revision; wrong authority sentinel;
third-stream config; malformed/legacy/misauthorized journal; or any correlation
not printed as one complete row. Namespace overflow/busy, invalid depth/name,
special/unreadable inventory entries, and no-journal orphan sidecars take their
exact C4 typed zero-write halt rather than falling through this list. A
classifier test injects a deviation on every
axis of every phase and compares a byte-for-byte zero-write snapshot.

### Required publication order and backup boundary

Reset initiation first settles any older journal, handles W1, closes readers,
requires `wal_checkpoint(TRUNCATE)` with `busy=0`, closes the writer, requires
active `S0`, then fsyncs active and its parent. It normalizes/refuses the
incarnation marker, admits only an exact pre-existing archive, CAS-deletes
exact recovery refs back to `R0`, privately creates the bounded next-DB journal
payload, rehashes active `O`, and only then publishes P0/P0A.

If private-seed schema verification reopens SQLite, it closes again and
requires private-seed `S0` before hashing/encoding. No open handle or sidecar is
captured in `dbBytesB64`.

Candidate creation writes an exclusive sibling temp from journal bytes, fsyncs
it, renames to the candidate path, fsyncs the candidate parent, and rehashes
`N`. The lineage archive remains a bounded **byte-exact** active-file copy:
exclusive temp, streaming copy, file fsync, rename, archive-parent fsync,
rehash `O`. This is a reset protocol witness, not a general SQLite backup.
Candidate→active retains the destination-fsync, durable source-unlink, and
source-fsync ordering in the table. Journal/marker phase writes and Git ref
operations retain design 138's exact choreography.

While a reset journal stands, quarantine treats journal/candidate/archive as
opaque files and retains design 138's sequence: byte-exact bounded bundle
copies, manifest/hash verification, durable `COMMITTED` publication, and only
then journal unlink+parent fsync. It never opens a canonical active/candidate/
archive DB while that journal stands, and active remains the same hash/ref/
marker restore precondition rather than a newly bundled authority. Thus a
quarantine crash cannot manufacture W2. Journal-bound bytes copied into the
bundle remain exact because restore must preserve their O/N hashes.

Only after exact quarantine is committed and the standing journal is durably
absent may doctor create an **optional diagnostic** active snapshot with
`VACUUM INTO`; its failure cannot block quarantine completion. General backup
uses the same exclusive staging sibling (never `Database.serialize()`), then
closes the output, requires output `S0`, performs schema/meta and optional full
integrity verification, fsyncs, atomically publishes, and fsyncs the parent.
Partial vacuum output/sidecars are migration-id/backup-id scoped and cleaned
only after no published output exists. A vacuumed diagnostic copy is never
restored beneath an old O/N witness.

The crash rig injects both process kill (`SIGKILL` at every labeled syscall/
SQLite boundary) and filesystem power-cut snapshots (copy the durable device
image while discarding non-fsynced writes) before and after P0/P0A, candidate
create, archive create, every `Rk`, `ready`, rename/source unlink and both
parent fsyncs, `installed`, state check, marker write, every `Ag`, `z-retired`,
journal unlink, W1 checkpoint, quarantine `COMMITTED`, and backup publication.
For every case it restarts in a fresh process/isolate, expects exactly one row
above or a zero-write halt, and compares state DB, sidecars, marker, refs,
journal, candidate, archive, and quarantine bytes. Separate cases construct
WAL-only, WAL+SHM, SHM-only, rollback-journal, sidecar-without-main, and identity-
changing sidecars for each active/candidate/archive position. It also exercises
malformed journals with sidecars at non-journal-derived candidate/archive
names, exact-Q+active-S0+orphan-candidate-WAL, regular S0 orphan mains,
namespace entry 16,383/16,384/16,385, invalid names/depth/special entries, and
directory-identity churn; every consumer must choose the same inventory/J0/W2/
W3 row (r3 C4; r3a-2).

V5 additionally pins no-journal fixtures containing only an exact retained
legacy archive, only an exact crash-left legacy candidate, both legacy forms,
and coexisting same-stem `.json`/`.db` files before M0 and after Q; all exact
legacy bytes and identities remain unchanged through migration and SQLite
reset classification. Boundary fixtures cover upper-case/wrong-length hex,
extra suffix/depth, `.json-wal`, special/unreadable/identity-changing legacy
leaves, and entry-limit accounting. A standing malformed SQLite journal plus
an exact legacy file still reaches J0 when every DB is `S0`; adding any
inventoried DB sidecar selects W2 without reading either journal or legacy
bytes.

### Pinned SQLite runtime and integrity policy (r1 f8+f9+f12)

Creation pins `page_size=4096` before schema creation,
`application_id=0x52424f58` (`RBOX`), and `user_version=1`. Every owning writer
then sets and reads back `journal_mode=WAL`, `synchronous=FULL` (`2`),
`foreign_keys=ON`, `wal_autocheckpoint=1000` pages, `cache_size=-32768`
(32 MiB), `journal_size_limit=67108864`, and `busy_timeout=5000`. Failure to
obtain or read back any value is fatal before domain queries. `temp_store=FILE`
is required for O(N) scan/action staging. Read-only CLI connections use
`query_only=ON`, `cache_size=-8192` (8 MiB), `busy_timeout=250`, and verify
rather than attempt to change persistent settings. `cache_size` and
`busy_timeout` are intentionally per-connection; the different reader values
are not a pinning failure.

The daemon owns exactly one 32 MiB writer connection and at most one 8 MiB
maintenance reader; a stage DB has one connection and is closed before the
next stage is opened. One CLI process owns at most one 8 MiB authority reader.
The only exception is the explicit backup verifier, which opens its output
only after the source snapshot connection closes. A lintable connection
factory enforces these call sites; raw `new Database` outside `store/open.ts`,
stage creation, migration, and backup is forbidden. Consequently the daemon's
authority-DB page-cache allowance is 40 MiB, not “32 MiB times an unspecified
pool.”

Auto-checkpoint is therefore explicit at about 4 MiB with the pinned page
size. Internal read transactions have a five-second lease, do not cross an
`await`, and close between cursor batches. The owning writer attempts
`PASSIVE` after each pump and on idle. At 64 MiB it requests `RESTART` when no
internal snapshot is registered. A busy result is telemetry, not permission
to break a reader. At 256 MiB it finishes the transaction already in flight,
records that transaction's start/end WAL bytes, and rejects every subsequent
authority write with retryable `WalBackpressureError` until `RESTART` or
`TRUNCATE` succeeds. Reads/status and already file-backed plans remain
available. Thus a foreign CLI that pins an old snapshot can cause a controlled
write stall, not unbounded repeated WAL appends; the admitted transaction may
overshoot 256 MiB and that measured overshoot is explicitly not called a hard
byte cap. A cursor/connection leak beyond the lease is an invariant failure
with allocation-site telemetry.

Clean shutdown closes readers, attempts `TRUNCATE`, and closes the writer; an
unclean/busy shutdown may leave W1. Reset/migration/file-swap entry is stronger:
`TRUNCATE` must report non-busy completion, all handles close, and all sidecars
must be absent or the boundary does not begin. Test gates hold an external read
snapshot while producing writes through both thresholds and prove the writer
stalls, WAL bytes cease increasing after the admitted transaction, the reader
remains correct, and work resumes only after a successful checkpoint.

Fast open performs only bounded checks: sentinel/authority predicate,
`application_id`, `user_version`, required tables/DDL fingerprint, completion
record, lineage row, and the pinned pragmas. Neither `integrity_check` nor
`quick_check` runs on ordinary daemon/CLI open, status, or reset
classification. Full `integrity_check` plus `foreign_key_check` runs during
migration verification, explicit doctor/backup verification, after
`SQLITE_CORRUPT`/`SQLITE_NOTADB`, or on an opt-in idle maintenance cadence
with no foreground snapshot. Failure enters `StateIntegrityHaltError`; normal
work performs no repair/write after that transition.

Every `Database`, prepared statement, transaction callback, iterator, cursor,
and borrowed row is created, used, finalized, and closed in one Bun isolate.
No database object/handle crosses a `Worker` message or is shared with crypto
workers. Workers receive immutable DTOs; a helper isolate that needs state
opens its own read-only connection and returns a plain value. SQLite's compiled
thread mode is not treated as permission to share Bun objects.

## Engine ordered-merge and cursor architecture (r1 f3)

The store port is not `loadState(): SyncState`. That compatibility adapter is
migration/test-only and must not become U2's implementation. The operational
model is three ordered planes plus sealed action plans:

- **BASE** — the transactionally versioned authoritative plane last
  acknowledged with the server, paired with `lastSyncedSequence`. Its head
  generation identifies a coherent SQLite snapshot; accepted adoption applies
  SQL set-difference to current membership and bumps the head, so one changed
  file writes O(1) authority rows rather than N generation memberships.
- **LOCAL** — rebuildable filesystem truth with a monotonically increasing
  `localRevision`. Watcher batches update only touched paths. A full scan lands
  unsorted observations in a file-backed TEMP/ephemeral scan generation, then
  SQL set-difference updates the visible local head and increments the revision
  atomically. An incomplete scan is invisible.
- **REMOTE** — an authenticated, sealed generation in a positively identified
  file-backed stage DB for one pull. It is never main-DB authority. After apply,
  the final CAS set-diffs it into BASE and bumps BASE generation.
- **WIRE-CANDIDATE** — a file-backed staging generation produced by ordered
  BASE/LOCAL merge for push. Its membership is mutable only while building
  cipher/churn replacements; `finishGeneration` seals it, after which cursors
  are read-only. Server acceptance set-diffs it into BASE inside the final CAS.

Authoritative membership is keyed by `(lineage,plane,path)` under an exact
`plane_heads.generation`; every row records the generation in which its value
last changed. Ephemeral stage membership is keyed by `(stageId,plane,path)`.
Thus BASE, LOCAL, REMOTE, and WIRE-CANDIDATE are never conflated in a singleton
`files(path)` table, while steady authority adoption writes only dirty rows.
One operation obtains a coherent lineage
snapshot `{stream,stateNonce,stateRevision,lastSyncedSequence,baseGeneration,
localRevision}`. This is a **logical version token**, not a long SQLite read
transaction. Each cursor batch opens a fresh short read transaction, checks the
complete token before and after its ordered page, closes before returning the
page, and either continues from its exact last `path_order` key or reports
`snapshot-changed`; it never mixes rows from different tokens. Sync/apply/push
holds the workspace mutex while building its file-backed plan, so the token is
stable and watcher publication queues. An unfenced read-only status/Git caller
restarts its projection on `snapshot-changed` at most three times, then returns
bounded busy/untrusted rather than a torn result. No read transaction crosses
network, Git subprocess, filesystem apply, an `await`, or a cursor-batch
boundary. Final CAS still rechecks lineage/global/repository predecessors.

### Early U0 — immutable entry interning and structural sharing

This unit is implemented and tested first on the `2.0` branch, before SQLite,
and is useful as an independently testable 2.0 implementation unit; it is not
independently shippable and is not a 1.7.x release vehicle (r3 C9; r3c-3).
`FileEntry` values
and published manifest arrays become readonly. `EntryArena.internExact` keys
**every** field and every optional-field presence: `path`, `sha256`, `size`,
`mode`, `mtimeMs`, `type`, `symlinkTarget`, `encSha`, `comp`, `payloadSha`,
`cipherSize`, and preserved extension members. Sharing equality is exact;
`sameContent` remains a different comparison and still ignores `mtimeMs`.
Hash/fingerprint collisions require a full field comparison.

The U0 arena is workspace-scoped with explicit generation leases and no
immortal process-global map. `publishGeneration` retains each referenced arena
slot once for that generation; replacing/dropping a generation releases those
slots; zero-retain slots and their fingerprint-bucket links are removed in the
same synchronous operation. A collision bucket never owns an extra retain.
The arena is seeded only from the live old/new generations, not historical
manifests. Unchanged watcher patches, deferred carries, merge results, and
delta folds reuse object identity across those generations. Any changed field
creates and interns a new object. Builders are mutable but cannot escape;
published arrays/entries are frozen in tests/debug and never sorted/spliced/
pushed in place. In particular, `applyCipherDescriptor(file,...)` becomes a pure
`withCipherDescriptor(file,...): Readonly<FileEntry>` and replaces one
generation reference rather than mutating an alias. It preserves all extension
members and, when compression is absent, removes `comp`, `payloadSha`, and
`cipherSize` together from the returned copy.

The replacement seam is not an informal rebinding. A mutable, unpublished
candidate generation has exactly one `GenerationOwnerLease` and implements
this signature-level contract:

```text
replaceInternedEntry({
  owner: GenerationOwnerLease,
  token: GenerationMutationToken,
  path: string,
  expected: EntryVersionToken,
  next: Readonly<FileEntry>
}): { token: GenerationMutationToken; entry: OwnedEntryRef;
      disposition: "unchanged" | "replaced" }
```

`GenerationOwnerLease` is a runtime capability object authenticated by an
isolate-private `WeakMap`; a TypeScript brand alone is not authority. The
WeakMap authenticates capabilities only—it owns no lifetime guarantee and is
never enumerated. The workspace-writer operation creates every owner through a
bounded `GenerationOwnerScope`, whose strong, enumerable registry owns this
control block until an exact terminal action (r3 C7; r3b-5):

```text
OwnerControl {
  ownerId, candidate,
  currentToken: GenerationMutationToken,
  terminalState: "live" | "aborting" | "published" | "discarded",
  workerIntake: "open" | "closed",
  pendingResults: number,
  workerResults: bounded Map<WorkerResultId,WorkerResultState>,
  serializedQueue
}
```

`withGenerationOwnerScope(... finally scope.abortAll())` is the only owner
construction path. Scope teardown can enumerate control blocks and release a
candidate even when the capability object was lost; it does not rely on
WeakMap enumeration, `FinalizationRegistry`, or GC timing. `EntryVersionToken` is the immutable
DTO `{generationId,path,pathEpoch,slotId}`. Arena `slotId` values increase
monotonically and are never reused during the arena lifetime; every successful
path replacement increments `pathEpoch`. `OwnedEntryRef` contains that version
plus the immutable entry. It is not an extra retain and is valid for mutation
only while its owner/candidate/token remain live; code that keeps an old entry
across an await/replacement must acquire an explicit `EntryLease` and release
it in `finally`. These rules prevent recycled-slot/path ABA.

`path` must resolve in the owner's current candidate to exactly `expected`'s
generation/pathEpoch/slotId, and
`token` must be the last token returned by that owner. The owner validates that
`next.path===path`, interns `next` by exact value, and, when the slot changes,
retains the next slot for the candidate **before** atomically replacing the
candidate's path reference, increments its mutation epoch, returns the new
single-use token, and only then releases the candidate's retain on the old
slot. Exact-value replacement is `unchanged`, changes no retains, and returns
the same token. A stale token/path/expected handle throws
`GenerationReplacementConflict` with no retain or reference change; allocation
or validation failure releases the provisional next lease in `finally`.

The coordinator is the sole mutation-token custodian. Every successful
replacement and `OwnerControl.currentToken` update occur atomically on the
same serialized owner queue before the queued task completes; worker callbacks
never retain a token privately (r3 C7; r3b-5).

The token returned by a successful replacement invalidates every earlier
mutation token for that owner. Seeding a candidate takes its own one-per-slot
retains; it never borrows the source generation's retains.
`publishGeneration(owner,token)` consumes both and transfers the candidate's
one-per-slot retains to the new immutable generation without a second retain; it
returns a `PublishedGenerationToken`; `discardGeneration(owner,token)` consumes
them and releases every candidate retain when the caller intentionally proves
the exact current token. The unconditional terminal API
`abortGeneration(owner)` authenticates the owner but accepts no caller token;
on the serialized queue it closes intake, changes terminal state to `aborting`
(which makes publish and replace reject), consumes the internally current
token, marks every non-done worker `discard-on-return`, requests any available
cancellation hook, and then **yields the queue**. Worker return callbacks
reenter that queue and drive their registrations through
discard/resources-released/done. The callback that makes
`pendingResults===0` marks `discarded`, releases every candidate retain exactly
once, removes the strong control block, and resolves the external abort
promise. That promise awaits the terminal event without occupying the queue,
so abort cannot deadlock, fail stale, or strand a worker lease.
If abort initiation observes `pendingResults===0`, that same queue step performs
the finalization immediately before yielding; it never waits for a callback
that cannot occur.
`scope.abortOwner(ownerId)` and awaited `scope.abortAll()` perform that same
no-capability drain for owner loss; scope teardown does not return before every
control reaches terminal with zero pending results. A repeat abort returns
`already-terminal`; it never changes a published generation or double-releases.
Retry abandonment, cancellation, and thrown encryption/upload use the no-token
abort in `finally`, while successful publication still requires the caller's
exact current token (r3 C7; r3b-5). Reader leases on the source published
generation remain valid throughout and keep its slots retained. A published token can only seed a new
candidate owner and is never accepted by `replaceInternedEntry`.

Only the workspace writer holding the workspace mutex may create a candidate
owner. The owner lease is isolate-confined and its method queue is serialized;
crypto workers receive `{path,expected:EntryVersionToken,entry}` immutable DTOs and return a pure
descriptor/next value, never the owner or token. The coordinator applies worker
results through `replaceInternedEntry`; retry results with a stale expected
version are discarded or recomputed. A registered worker follows
`registered -> running -> result-returned -> applying|discarding ->
resources-released -> done`; it is **pending in every state before `done`**.
Promise/message settlement alone never decrements `pendingResults`. Worker
intake close, registration, result application/discard, lease release, pending
decrement, abort, and publish all execute on the same serialized queue.
Publication first closes intake and then requires zero pending results, so a
returned-but-queued result blocks publication until replacement/discard and
all resource release complete (r3 C7; r3b-5). Thus scan, watcher publication, recovery,
and encryption cannot be simultaneous mutation authorities, and the manifest
eventually committed is the generation returned by the owner rather than a
loop-variable alias. Tests race out-of-order worker completions, stale tokens,
publish/discard, cancellation after token advancement, a returned result queued
behind publish, rejection before lease release, dropped capability followed by
scope close, abort versus publish, duplicate abort, and every error edge; they
assert one writer, exact descriptor presence, source-generation immutability,
and balanced arena retains (r3 C7; r3b-5).

U0 is deliberately transitional: its fingerprint index is O(unique live
entries), and it is implemented before SQLite within 2.0 to remove duplicate object graphs and
make aliasing safe; U0 is measured but is not credited with U2's <64 MiB
non-wire budget. Once U2 removes N-sized manifest arrays, `EntryArena` becomes
an operation-local decode cache capped at the lesser of 8,192 entries or 8
MiB estimated retained metadata, with LRU eviction restricted to zero-lease
slots. SQLite `entry_id` is the durable structural-sharing identity across
BASE/LOCAL heads; simultaneous cursor windows that decode the same entry id
receive the same immutable object. A lease is released before cursor advance,
plan batch commit, retry, or error unwind (`finally` is mandatory). If all
slots are leased at the cap, the producer flushes its batch before decoding
more; it never grows the arena. Counters expose live slots/bytes, retained
slots, collision buckets, and oldest lease.

U0 tests require `Object.is` for unchanged cross-generation entries, inequality
for changed/encrypted entries, mutation failure under freeze, release of
unreachable arena members, optional-presence distinction, collision fallback,
and byte/semantic immutability of source manifests after encrypt/defer/fold.
U2 tests additionally force the 8,192/8 MiB cap through success, thrown sink,
CAS retry, and cancelled cursor paths and require every lease count to return
to zero.

### Rebuildable cache and plan memory (part of U2, not a hidden exception)

The current `HashCache`, `DirCache`, `EncryptAddressCache`, and tracked-path
cache each load a workspace-sized JSON object/array/`Map`; DirCache also
retains child arrays and EncryptAddressCache retains a reverse `pathOwner` map.
They do not survive U2 in that form. Their replacement is one independent
`.rbox/state/cache-v2.db`, opened through a non-authoritative cache port with
`journal_mode=TRUNCATE`, `synchronous=NORMAL`, an 8 MiB page cache, one writer,
and no connection to the state authority transaction. Corruption/context
mismatch closes and removes this cache through identity-scoped staging and
causes a cold rebuild; it can never cause BASE reset, adoption, or rollback.

Its field-complete logical tables are:

```text
hash_entries(path PRIMARY KEY,mtime_ms,size,ctime_ms,sha256)
dir_meta(singleton,last_scan_start_ms,last_unpruned_scan_at_ms)
dir_rule_files(rel_path PRIMARY KEY,absent,size,mtime_ms,ctime_ms)
dir_entries(path PRIMARY KEY,mtime_ms,ctime_ms)
dir_children(parent_path,name,type,PRIMARY KEY(parent_path,name))
encrypt_context(singleton,account_id,workspace_id,account_epoch,key_epoch)
encrypt_entries(plain_sha PRIMARY KEY,enc_sha,cipher_size,comp,payload_sha)
encrypt_paths(path PRIMARY KEY,plain_sha REFERENCES encrypt_entries)
tracked_repos(repo_rel PRIMARY KEY,
              state CHECK(state IN ('available','unavailable')),
              active_generation NULL,known_from_base)
tracked_refreshes(repo_rel,generation,index_real,dev,ino,index_size,
                  index_mtime_ns,index_ctime_ns,state CHECK(state='building'),
                  PRIMARY KEY(repo_rel,generation))
tracked_paths(repo_rel,generation,local_path,workspace_path,path_order,
              PRIMARY KEY(repo_rel,generation,local_path))
tracked_dir_prefixes(repo_rel,generation,prefix,path_order,
                     PRIMARY KEY(repo_rel,generation,prefix))
ignore_sets(generation PRIMARY KEY,state CHECK(state IN ('building','sealed')))
ignore_rules(generation,base_path,source,ordinal,pattern,negation_prefix NULL,
             PRIMARY KEY(generation,base_path,source,ordinal))
```

Hash lookup/record/invalidate are point statements; hash pruning merge-joins
an ordered LOCAL cursor with `hash_entries`. Directory reuse reads one header
and pages children for one directory only; record replaces that directory's
children transactionally, so no cross-directory child array exists. Rule-file
inventory is at most the configured rule set. Encrypt lookup is by plaintext
hash; ownership migration is one transaction over `encrypt_paths`, and pruning
merge-joins live candidate paths with that table. Encryption descriptors and
path owners are never bulk-loaded. Each port returns at most 512 rows/4 MiB,
uses the same isolate/lease discipline, and counts its 8 MiB SQLite cache
inside the daemon RSS ledger.

`TrackedPathIndexPort` replaces `TrackedRepoSet.paths`,
`TrackedRepoSet.dirPrefixes`, the 50 MiB `git ls-files` subprocess buffer, and
the JSON tracked-path cache. For each discovered or BASE-known repository it
identity-brackets the Git index by
`{realpath,dev,ino,size,mtimeNs,ctimeNs}`, creates a new `building` generation, and
streams `git ls-files -z --cached` stdout. Repository discovery and BASE-known
repo paths stream into `tracked_repos`; no complete repo array/set survives.
A token may be at most 4,096 UTF-8 bytes; ingestion holds one 64 KiB subprocess
chunk plus 512 paths/4 MiB, writes exact
path rows and all ancestor-prefix rows with SQL deduplication, then rechecks
the index identity and atomically changes `tracked_repos` to
`{state:'available',active_generation:generation}`. Old rows are collected only
after no cursor uses them. No query can observe `building`; cancellation,
output overflow, invalid paths, Git
failure, or index change discards it and publishes `unavailable` for that
identity. Point trackedness joins the active generation and uses
`SELECT ... LIMIT 1`; because every tracked path materializes every ancestor,
directory containment is exact equality on `(repo_rel,active_generation,
prefix)`, also `LIMIT 1`, with no collation/range-successor assumption. Repo lookup returns
one scalar status. Scan, daemon matching, read-only status, and purge all use
this same port.

Unavailable/changed evidence is fail-closed: a file intersecting the repo is
"possibly tracked," a directory is not pruned, and purge refuses destructive
action below the repo. It never means untracked. The next scan may rebuild, but
no caller may fall back to materializing stdout or cached paths. This port's
8 MiB SQLite cache is the existing cache-v2 allowance, not another cache, and
its admission failure returns `TrackedIndexUnavailable` while preserving the
conservative verdicts.

`IgnoreRuleIndexPort` separately owns built-in/`.rboxignore`/nested
`.gitignore` evaluation; tracked membership never pretends to own rule parsing.
Scan discovery writes rule lines and static negation prefixes to an operation's
file-backed `building` ignore generation, with exact source/base/ordinal
precedence, then seals it before any pull/purge plan is sealed. The streaming
walker retains only the current ancestor stack; point callers page the exact
ancestor rule rows in precedence order. One rule file is capped at 1 MiB and
all decoded rules applicable to one operation/path chain at 4 MiB; a 64 KiB
parser buffer is the only extra allocation. Ignore partitions needed before a
pull plan live in this sealed ignore generation, and the later action plan
binds its digest. Missing/unreadable/oversize/malformed rule evidence returns
`IgnoreRulesUnavailable`: abort the scan or pre-apply planning, preserve LOCAL,
do not prune, and refuse purge. No caller falls back to the current
workspace-sized `gitLayers`, rule-source arrays, or permissive matching.

The old three cache JSON files and every legacy tracked-path cache JSON are not parsed or migrated on U2 startup—that
would recreate the peak this design removes. They are rebuildable evidence, so
U2 atomically parks them under an id-scoped `.rbox/state/cache-v1-retired/`
name after creating the empty v2 cache, cold-populates rows through the normal
scan/encryption paths, then deletes the parked copies only after a successful
bounded scan. Failure leaves either old cache files or the parked copies for
doctor, but never affects sync authority. Rollback to U1 may discard v2 and
reuse an unparked v1 file if still present.

All other workspace-sized scratch collections are likewise named: pull apply
receipts, `required_dirs`, collision indexes, ignore partitions, mass-delete
counts, and action ordering live in the sealed plan DB; upload missing-address
and blob-reference membership live in file-backed stage tables; cache pruning
uses ordered joins. Every non-wire in-memory LRU is capped at the lesser of
8,192 entries or 8 MiB estimated retained bytes. A code/test inventory rejects an N-sized `Set`/`Map`/array in scan,
reconcile, apply, Git planning, status, or cache save unless it is one of the
wire adapters enumerated below.

### Scan-generation staging

`scanManifest` becomes a producer into `ScanGenerationSink`, not an array
factory. `fs.opendir` bounds directory iteration; at most 16 hashes are pending
and the sink batch is at most 512 entries or 4 MiB of metadata. Each discovery
is normalized, interned, and inserted unsorted into a connection-owned
`temp_store=FILE` spool. SQLite's stored path-order key supplies deterministic
ordering. Duplicate, case-collision, file/descendant, and coverage checks use
indexed staging rows rather than N-sized JS sets.

Finalize has an explicit caller policy:

- daemon full/deep scan carries prior LOCAL for paths whose observation was
  explicitly deferred;
- push scan carries BASE for deferred paths (today's `deferManifest` rule);
- pull scan does not authorize a delete from an unreadable local observation;
- purge carries no ignored path and refuses deletion under an unevaluated Git
  subtree.

If discovery/validation fails, the spool is discarded and visible LOCAL is
unchanged. On success, one transaction applies ordered inserts/updates/deletes
against the local head and increments `localRevision`; unchanged rows retain
their interned entry id. Watcher events use the same transaction for a path or
subtree and never rebuild a whole map. A standalone direct-sync CLI may create
its own writer/spool only while owning the workspace mutex. Read-only status
cannot publish daemon LOCAL authority; its untrusted fallback uses an isolated
ephemeral scan store and still pays the full scan/Git cost.

### Pull: authenticate, plan completely, then apply

1. Today's wire decoder necessarily materializes a complete authenticated
   REMOTE `Manifest`. Validate it, batch-insert/intern it into a REMOTE staging
   generation, then release the JS graph before three-way reconcile.
2. Merge one row at a time from ordered BASE, LOCAL, and REMOTE cursors using
   the existing `sameContent` truth table. Emit action rows referencing entry
   ids into a file-backed plan. Accumulate exact base/delete/byte counts,
   conflicts, ignore-rule actions, required ancestor directories, type flips,
   and receipt expectations in indexed rows—not arrays/sets.
3. Seal the plan before the first filesystem write. Only then enforce remote
   validation, full mass-delete policy against BASE, complete ignore-rule
   partitioning, ancestor/type-flip preflight, and conflict naming. Refusal
   discards the plan with zero filesystem writes. Streaming actions directly
   from reconcile to apply is forbidden.
4. Immediately before the first filesystem mutation, commit
   `invalidateLocalForApply(expectedLocalRevision,planId)`: require the planned
   lineage/revision, set LOCAL `complete=0`, increment its trust epoch and
   `localRevision`, and fsync through the normal FULL/WAL commit. This happens
   even when the first action later fails. A crash or partial apply therefore
   leaves a durable untrusted LOCAL head; queued watcher events may update rows
   but cannot set `complete=1`.
5. Stream eligible rule-file actions first, rebuild the matcher, then stream
   remaining nonignored writes/conflicts in bounded windows and deletes last.
   `required_dirs(path,depth)` replaces the N-sized `needDirs` set. For an
   obstructing ancestor, all dependent actions are first staged to on-disk
   temps before displacement, preserving apply's global ancestor safety.
6. Record receipts through `ApplyReceiptOraclePort` in the plan.
   `oracleFromPull` reads BASE/LOCAL/REMOTE plus its bounded receipt cursors.
   Partial apply never adopts REMOTE; the next scan/pull heals
   under current semantics. A complete apply atomically set-diffs the sealed
   REMOTE stage into BASE, bumps its head, and commits the multi-repo/global CAS.

LOCAL remains incomplete after either complete or partial apply. Before any
subsequent push, trusted status, or return of a successful direct pull, a
mandatory full post-apply scan (the current daemon/direct ordering) publishes
a new complete LOCAL head. It may use receipts as hash hints, but only complete
filesystem/Git coverage sets `complete=1`; watcher delivery is never that
proof. If this scan fails, BASE adoption remains valid when already committed,
the operation reports `local-untrusted`, and push/status trust stays blocked
until a later full scan. The BASE CAS expects the exact invalidated
`localRevision`, preventing an unrelated LOCAL publication from being hidden.

The two-phase ignore rule remains exact: rule actions are selected under the
pre-pull matcher; after those land, the matcher is rebuilt; other actions are
filtered under the post-pull matcher. Ignored remote entries remain in adopted
BASE so they are not echoed as deletion.

### Apply receipt/oracle sub-contract (r3 C5; r3b-1)

`ApplyReceiptOraclePort` is a required sub-contract of `ApplyPlanPort`, not a
label for in-memory proof scratch. The plan DB owns these closed logical
tables; its post-apply appendix is append-only and bound to the original sealed
action-plan digest, and no receipt write can change a sealed action row:

```text
receipt_source_rows(proof_id,role CHECK(role IN ('expected','oracle','pre')),
                    path,path_order,entry_cjson,source_binding,
                    PRIMARY KEY(proof_id,role,path))
receipt_touched(proof_id,path,equivalence_key,
                PRIMARY KEY(proof_id,path))
receipt_deferred(proof_id,path,equivalence_key,
                 PRIMARY KEY(proof_id,path))
receipt_projected(proof_id,role,path,path_order,equivalence_key,entry_cjson,
                  PRIMARY KEY(proof_id,role,path))
receipt_observed(proof_id,path,path_order,equivalence_key,entry_cjson,
                 PRIMARY KEY(proof_id,path))
receipt_fs_tokens(proof_id,class CHECK(class IN ('entry','directory')),path,
                  kind,dev,ino,size,mtime_ms,ctime_ms,executable,
                  PRIMARY KEY(proof_id,class,path))
receipt_attempts(proof_id,repo_rel,kind,equivalence_flags,state,verdict,why,
                 receipt_hash,action_plan_digest,source_bindings_cjson,
                 PRIMARY KEY(proof_id))
```

Expected/pre/oracle/touched/deferred evidence is staged through ordered source
cursors while the plan is sealed; no source path map, projected array, or
touched/deferred set survives in JS. After apply, scoped observation writes one
file-backed observed generation plus exact entry/directory filesystem tokens.
Every `equivalence_key` column has an index beginning with `proof_id`; touched
and deferred membership therefore participates in the same receiver projection
without a separate JS set. Receiver-equivalence keys and collision groups are
indexed rows. Matching and
collision detection are ordered/grouped SQL joins that decode at most one left
row, one right row, and a bounded 100-path/256 KiB diagnostic sample; receiver
alias identity checks run one path pair at a time. No grouping `Map`, `Set`, or
complete inventory is permitted.

Only one proof attempt per port runs at once, and its phases do not overlap:

| Proof phase | Simultaneous live windows |
|---|---|
| source projection | one 512-row/4 MiB input page + one 512-row/4 MiB sink page; one admitted >4 MiB FileEntry runs alone up to 16 MiB |
| scoped filesystem observation | one `opendir` page + at most 16 hash jobs + one 512-row/4 MiB sink page |
| receiver-equivalence join | one left row + one right row + the <=100-path/256 KiB diagnostic sample |
| canonical receipt | one ordered receipt row + one 64 KiB framing/hash buffer |

`canonical-receipt-v1` streams the exact existing canonical receipt JSON byte
grammar in ordered path order directly into SHA-256. It must reproduce the
current `canonicalReceipt` digest without sorting complete arrays or retaining
a complete JSON string/UTF-8 buffer. A successful attempt atomically commits
the verdict, hash, source bindings, and every filesystem token before returning
an immutable `ApplyReceiptProofToken {planId,proofId,actionPlanDigest,
sourceBindings,receiptHash}`.

Reproof may reuse that token only after every stored filesystem token and
source binding revalidates exactly. A changed token requires a fresh observed
generation and equivalence join. If Git has already consumed a proof, any
cursor/storage/scan/equivalence failure is `indeterminate`, never match or
mismatch: the Git result is ineligible for CAS. Exact revalidation permits
reuse; otherwise the prior Git result and transition stage are discarded and
Git is recomputed from the new proof. Before filesystem apply, admission or
cursor failure fails plan sealing with zero writes. After apply begins, it
preserves the plan and partial receipts, leaves LOCAL incomplete, and returns a
retryable/indeterminate outcome.

This port replaces the present peaks in `src/engine/apply-receipt.ts`: three
complete path maps plus the touched set (`:341-348,414-423`), three projected
arrays and another set (`:426-444`), receiver grouping maps (`:245-258`), the
complete subtree inventory and token maps (`:565-609`), fallback `FileEntry[]`
and token maps (`:624-707`), and sorted/stringified canonical receipt
(`:157-162`), including the JSON-backed entry points (`:715-763`).

### Push: ordered candidate, bounded work, explicit wire wall

An ordered BASE/LOCAL merge builds a mutable WIRE-CANDIDATE stage and a distinct
file-backed `PushDecisionPlan`. It seals only the decision plan/diff summary
before admission; WIRE-CANDIDATE remains `building`. With `purge=false`, BASE-
only locally ignored paths are carried; purge refuses unevaluated Git-subtree
deletion. Mass-delete, no-op, files-first, and churn decisions run on the sealed
decision plan before encryption/upload.

Git planning reads the coherent lineage snapshot and ordered repo cursor/direct
lookups. Local RepoRecords stay row/CAS based. A complete `gitRepos` wire map
is intentionally materialized only at Git/wire composition. `MAX_GIT_REPOS=256`
bounds its key count, **not its bytes**: nested refs, tombstones, pack chains,
config, and proofs count against the outgoing manifest byte admission described
below. A versioned `RepoRecord` codec first scans canonical bytes without
materializing JSON and enforces `MAX_REPO_RECORD_CANONICAL_BYTES=4 MiB`, bounded
member/string/container counts inherited from the Git validators, and a
conservative `estimatedRetainedBytes<=16 MiB` (decoded UTF-16 bytes plus fixed
per-node/member overhead). Only then may it decode one immutable record. A
limit failure is typed `RepoRecordOversizeError`: migration leaves JSON as
authority, inbound remote is refused before apply, and an already-authoritative
DB record can be streamed to doctor/export but not fed to sync until repaired
by a future format. This is a deliberate safety admission change, not a count-
cap claim.

Ordinary Git planning pages at most 16 records while the sum of their estimates
is <=4 MiB. One record estimated above 4 MiB but <=16 MiB is processed alone and
released before the next cursor step. Estimator constants are calibrated with
Bun/V8 adversarial tiny-member, escaped-string, tombstone, refs, config,
op-state, and proof fixtures; if measured retained heap exceeds the estimate or
the total non-wire budget, CI fails closed and the constants/cap must tighten.

Encryption/upload consumes a candidate cursor. Cipher descriptors are pure
copy-on-write entry replacements. Churn deferral swaps in the BASE entry id or
omits a never-synced path. Missing-address checks use bounded pages (the
existing 50k API cap and 5k pipeline window); cache pruning becomes an ordered
live-path merge, not `Set(local.files)`. These are the last permitted candidate
mutations. The engine then recomputes candidate counts/digest and asserts them
against the sealed decision invariants: no BASE deletion was added or removed,
every changed-existing path is final-or-BASE-carried, every omitted path was
never synced, and all final encrypted descriptors have satisfied blobs. Any
mismatch discards the building candidate; a sealed stage is never reopened or
rewritten. Only then does `finishGeneration` seal WIRE-CANDIDATE. The commit
adapter may materialize today's required wire `Manifest` only from that sealed
final candidate. Server acceptance set-diffs the sealed candidate into BASE and
applies the global+repo packet atomically; 409/422/epoch retry discards or reuses it under
the existing bounded retry state machine.

### Bounded pull/push outcomes and plan ownership

Pull no longer returns `Action[]`. The original pre-apply
`sealPullPlan(planId)` enforces every action/row cap before the first filesystem
write. After apply, `PullOutcomePort.fromSealedPlan(ref,metadata)` only transfers
ownership of that already-admitted ref and cannot reseal or fail admission:

```text
PullOutcome = {
  plan: SealedPullOutcomeRef,
  status: "applied" | "partial" | "local-untrusted",
  initialRemoteSequence: number,
  appliedSequence: number,
  finalSnapshot: LineageSnapshot,
  summary: {writes,deletes,conflicts,bytes,ruleFiles,lockfileNudges},
  actions(afterKey), conflicts(afterKey), changedPaths(afterKey),
  ruleFiles(afterKey), lockfileNudges(afterKey),
  retain(), release()
} | {
  plan: null,
  status: "refused",
  initialRemoteSequence: number,
  appliedSequence: number,
  finalSnapshot: LineageSnapshot,
  summary: {writes,deletes,conflicts,bytes,ruleFiles,lockfileNudges},
  release()
}
```

Summary fields are fixed nonnegative counters, not path arrays. Action pages
use the apply limit of 512 rows/8 MiB; an action above the window is processed
alone and may lease at most two admitted 16 MiB FileEntries (32 MiB hard row
peak). Anything larger is `ActionRowOversizeError` while sealing, before the
first filesystem write. Every path-only cursor is 512 rows/4 MiB. Conflict rendering, `postSyncNudge`, daemon telemetry,
lockfile nudges, and rule refresh consume the cursors and retain no page after
advance. Chain repair stores each suffix's outcome ref in a file-backed
`CompositePullOutcomeRef` and streams their ordered union; it never concatenates
actions. The sealed plan remains owned after apply until the last retained
outcome handle releases it, so post-apply consumers do not lose data. Refusal,
partial apply, cancellation, caller throw, and process-resume use id-scoped
plan cleanup; refusal preserves its fixed summary then discards the sealed plan
and exposes no cursor. The five-second lease applies to each cursor page's
transaction, not to the outcome handle or total rendering time. Leaked handles
trip the operation-end owner assertion/startup orphan-plan GC.

Push no longer returns a complete `Manifest`, `deferred[]`, or `retryLater[]`.
`PushOutcomePort.finish(candidate,decisionPlan)` returns:

```text
PushOutcome {
  candidate: SealedStageRef,
  status: "committed" | "not-committed" | "repair-conflict",
  baseSnapshot: LineageSnapshot,
  localSnapshot: LineageSnapshot,
  gitDeferred: boolean,
  summary: {sequence,files,plaintextBytes,deferred,retryLater,committed},
  deferredPaths(afterPath) -> {path,reason:"write-finish"|"retry-later"},
  retain(), release()
}
```

Path pages are 512 rows/4 MiB. The reason-tagged rows are computed in the
decision plan, so the daemon never rebuilds `deferred - retryLater` as a Set.
The daemon obtains file count and byte totals
from sealed metadata, pages retry/write-finish membership into its bounded
queue or file-backed scheduler, and never receives the candidate manifest.
Only the named snapshot/delta commit adapter may materialize a wire `Manifest`;
it releases that graph before `PushOutcome` returns. Retry evidence,
unsatisfied-address membership, deferred paths, and receipts remain in the
decision/candidate stage and are either reused by id under the bounded retry
machine or deleted after the last outcome handle. Cursor/window admission
is completed while sealing the pull plan or push decision/candidate, before
filesystem apply or remote commit respectively; constructing an outcome after
a mutation is allocation-free apart from its fixed handle.

### Normative materialization budget and unavoidable wire allocations

Outside named wire adapters, no production array/map/set may scale with total
manifest entries. Every current whole-manifest access is assigned to exactly
one port below; the compatibility `loadState(): SyncState` adapter is limited
to migration fixtures/tests and cannot satisfy a production engine import.

| Engine access path / owning port | Live admission budget | Admission failure |
|---|---|---|
| BASE/LOCAL/stage reads+writes — `FilePlaneCursor` / `StageFileCursor` / `GenerationSink` | 512 rows/4 MiB; one admitted FileEntry above 4 MiB runs alone up to 16 MiB; caller-selected larger pages reject | `FileEntryOversizeError` or bounded-page error before sink/CAS mutation |
| full/deep/push scan — `ScanGenerationSink` | one `opendir` page + 16 hash jobs + 512 entries/4 MiB; ignore-rule text <=1 MiB/file and <=4 MiB/scan | discard spool, preserve/invalidate LOCAL per the scan rules, `ScanAdmissionError` |
| watcher patch — `LocalPatchPort` | 512 events/4 MiB; a larger queue drains in pages and never coalesces to an N-sized map | mark LOCAL incomplete and require full scan |
| tracked/purge membership — `TrackedPathIndexPort` | one 64 KiB stdout chunk + 512 paths/4 MiB; point/exact-prefix results are one scalar; cache-v2 page cache is 8 MiB total | publish unavailable and use possibly-tracked/no-prune/no-purge verdicts |
| nested ignore rules — `IgnoreRuleIndexPort` | 64 KiB parser, 1 MiB per file, 4 MiB per active ancestor chain; rules/partitions are file-backed | abort scan/pre-apply, preserve LOCAL, no prune, refuse purge |
| BASE/LOCAL/REMOTE three-way merge — `ReconcilePlanPort` | three current rows + 512 output rows/4 MiB; FileEntry canonical bytes <=4 MiB and retained estimate <=16 MiB, with a >4 MiB row alone | `FileEntryOversizeError`/discard unsealed plan; no filesystem write |
| apply/preflight/receipt/oracle — `ApplyPlanPort` + `ApplyReceiptOraclePort` | 512 actions/8 MiB; one oversize action alone <=32 MiB (two admitted entries); bodies disk-streamed; receipt phases use the non-overlapping source/sink, observation, join, and 64 KiB hash windows above | fail while sealing before first write; after apply preserve plan/partial receipts and LOCAL-incomplete as retryable/indeterminate |
| trusted status/counters — `StatusProjectionPort` | SQL scalars + 512 paths/4 MiB; published samples <=100 paths/256 KiB | bounded busy/untrusted status, never a torn projection |
| daemon drift audit/diff — `DriftAuditPort` | ordered two/three-row merge + 512 findings/4 MiB into a stage; return counters + <=100-path sample | abort audit, preserve prior trust state, schedule full scan |
| ignore purge command — `PurgePlanPort` | file/ignore/tracked cursors + 512 plan rows/4 MiB; preview <=100 paths/256 KiB; top-level counts are SQL | discard plan and perform zero deletes |
| hydrate/project detection — `HydrateDetectionPort` | 512 file/project rows/4 MiB into a file-backed findings stage; preview <=100/256 KiB | discard findings and perform no hydration/install/write |
| versions/restore/path history — `HistoricalManifestLookupPort` | at most two concurrent authenticated decode ledger leases; each result is staged then released; point lookup scalar or 512 rows/4 MiB | `WireMemoryAdmissionError`/no restore or filesystem write |
| pull return/callers/chain repair — `PullOutcomePort` | 512 actions/8 MiB or 512 paths/4 MiB; fixed scalar summary; outcome construction transfers an admitted ref | sealing fails before apply; after apply cursor errors preserve the outcome/plan for retry |
| push candidate/encryption return — `PushCandidatePort` + `PushOutcomePort` | candidate pages 512/4 MiB; operation-local arena <=8,192 entries/8 MiB; outcome paths 512/4 MiB; ciphertext governed by its existing byte leases | discard building candidate or return retryable outcome; no remote commit/BASE mutation |
| RepoRecord/Git planning — `GitStateCursorPort` | 16 records/4 MiB, one oversize record alone, hard single-record estimate 16 MiB | typed record-oversize refusal; no packet seal |
| hash/directory/encryption caches — `CacheCursorPort` | 512 rows/4 MiB and one shared cache-v2 8 MiB page cache | cold miss/unavailable; never authority damage |
| sealed CAS/retry inputs — `GenerationCasPort` | 512 file rows/4 MiB; 16 repo rows/4 MiB; one transition row <=24 MiB retained estimate; file-backed TEMP | discard TEMP/return busy or typed oversize; transaction does not begin |
| manifest/stage/state digest — `ManifestDigestPort` | one admitted FileEntry or RepoRecord lease + 64 KiB framing/hash buffer; all rows stream | abort digest/seal/export before publication |
| legacy import/export — `LegacyStateMaterializationPort` | migration import retains design 161's 512 MiB + 52× admission; explicit legacy export streams with 64 KiB framing and a 512 MiB output cap | JSON stays authority on import; export produces no published file |

Authority SQLite caches total at most 40 MiB in the daemon; the rebuildable
cache DB adds exactly one 8 MiB cache only while its port is active. At 200k
entries, all non-wire manifest metadata together must add <64 MiB JS heap, not
64 MiB per row above. An operation-level ledger admits the sum of simultaneous
windows and arena/cache charges; it backpressures producers before that total,
and CI records peak live entry/action objects for every row.

U2 removes the daemon's retained `this.manifest: Manifest`; it retains only the
lineage/LOCAL head token and bounded status/watcher pages. Purge, hydrate
detection, drift audit, `fileCountOf`/`plaintextBytesOf`, and cache pruning use
the scalar/cursor ports above. A compile-time/import inventory fails any
production scan/sync/daemon/status/Git module that reaches `SyncState`,
`Manifest.files`, or a compatibility whole-state loader outside a named wire
adapter. Historical lookup replaces the current eight-way decode fan-out with
the two-lease scheduler above and releases each staged historical generation
before admitting the next.

The remaining whole-manifest allocations exist only inside these named wire
ports and are budgeted, not merely measured:

- `SnapshotDecodeAdapter` (inbound latest/snapshot) can retain ciphertext, decrypted/decompressed body,
  parsed `Manifest`, and `validateManifest`'s exact-path set, lowercase-path
  set, and lowercase-path array before REMOTE staging;
- `DeltaFoldAdapter` (inbound delta) can additionally retain BASE, parsed D operations, the fold's
  BASE file/repo maps and seen-operation set, the folded result, canonical-hash
  bytes/workspace, and the same validation collections. The history fold LRU
  is count-capped at two complete authenticated manifests and is cleared before
  an uncached fold;
- `SnapshotCommitAdapter` retains the target manifest, `gitRepos` object,
  `validateManifest` collections, the unique-`encSha` blob-ref map and array,
  optional serialized refset sidecar, canonical JSON/JCS string/UTF-8,
  envelope/compression buffers, encrypted manifest, and signed commit body;
- `DeltaCommitAdapter` retains BASE+target manifests, two N-sized file maps,
  repo maps, D operations and their sorted array, validation collections,
  blob refs/refset, and encoding/compression/encryption buffers. If delta loses
  its size comparison, U2 releases all delta-only graphs/buffers before it may
  admit the fallback snapshot encoder;
- `BlobRefCommitAdapter` owns upload/refset construction and commit retry's N-sized
  `blobRefs`, `uploaded`, `needsUpload`, audit-`seen`, and address-dedup
  collections. Before U2 leaves the wire adapter they move to the candidate
  stage tables; only the final signed-protocol `blobRefs` array/refset bytes
  remain an unavoidable full wire allocation.

All five use `WireAllocationLedger`. `H` is the lower positive value of the
cgroup hard limit and `RBOX_PROCESS_BUDGET_BYTES` (default 4 GiB when neither
supplies a lower value); `R` is RSS sampled immediately before each new
overlapping allocation. The operation allowance is
`A = min(2 GiB, floor(H/2), max(0,H-R-128 MiB))`. Before ordinary
materialization, a bounded token scan computes each manifest/delta's exact raw
bytes and `RetainedEstimateV1`, which is only the retained-graph component and
is never sufficient admission by itself (r3 C6; r3b-2):

```text
E = align4096(
      64 * containerCount
    + 32 * scalarCount
    + sumStrings(56 + 2 * utf16CodeUnitLength)
    + 16 * arraySlotCount
    + 96 * objectMemberCount
    + 80 * plannedMapOrSetEntryCount)
```

Counts include every nested node/slot/member once; a string referenced by an
index is counted once as a string and once as an index entry. Checked safe-
integer arithmetic overflow rejects. Exact Buffer/Uint8Array byte lengths are
reserved separately. The same versioned formula computes FileEntry,
RepoRecord, transition, and wire estimates.

`ConstructionPeakV1(phase)` is the admission value before **every** phase
transition:

```text
CP = sum(still-live input buffers and retained E reservations)
   + exact requested output/backing-buffer bytes
   + E for each graph/index being constructed
   + align4096(80 * growingMapOrSetEntries
               + 16 * growingArraySlots)       // old+new backing overlap
   + align4096(64 KiB + 32 * tokenCount + rawInputBytes) // parser transient
   + exact simultaneously-live canonical UTF-16 and UTF-8 bytes
   + codec.maxWorkspace(inputBytes,settings)
   + codec.maxOutput(inputBytes,settings)
   + F_runtime
```

The growth term is additional to E and charges a complete replacement backing
store during Map/Set/array rehash or growth. Canonical string and UTF-8 storage
remain simultaneously charged through conversion. Each pinned compressor and
encrypter exposes/test-pins its actual maximum workspace and output formula;
the generic ledger may not substitute a flat allowance. `F_runtime` is
`align4096(max(8 MiB,ceil(1.25 * M)))`, where `M` is the maximum unattributed
live-byte increase measured across the isolated supported-Bun boundary fixture
suite after subtracting every other term. It is generated and frozen per
supported Bun/V8 build before U2 can enable; a runtime with no calibrated value
is refused. This replaces the unexplained flat 32 MiB workspace number.

A reservation for a dropped JS reference remains live until the adapter ends
or allocator/GC instrumentation observes its reclamation; code never releases
ledger capacity merely because a reference was cleared. All checked arithmetic
is safe-integer and `CP <= A` is required before the allocation begins. The
five adapter phase/liveness contracts are:

| Adapter | Ordered construction phases and mandatory co-live reservations |
|---|---|
| `SnapshotDecodeAdapter` | authenticate/decrypt -> decompress -> token scan -> parse -> validation/index build -> REMOTE staging. Ciphertext remains charged through authentication; compressed/decompressed buffers overlap according to codec maxima; parse charges input+parser transient+graph E; validation additionally charges final and replacement index backings. All graphs release only after staging. |
| `DeltaFoldAdapter` | authenticate/decode BASE and D -> file-backed count-only fold -> map/seen construction -> folded-result construction -> validation/hash -> staging. BASE, D, maps/seen, and result are simultaneously charged where shown; the second pass cannot start until its full CP admits. |
| `SnapshotCommitAdapter` | target/Git projection -> validation indexes -> refset -> canonical UTF-16 -> UTF-8 -> compression -> encryption -> signed body. Target and required indexes remain live; both canonical representations are charged until conversion release is observed; each codec phase charges its reported workspace/output. |
| `DeltaCommitAdapter` | BASE+target -> two file maps/repo maps -> D operations/sort -> validation/refset -> canonical encode -> compression/encryption -> signed body. Every listed graph is co-live. Snapshot fallback is a new admission only after all delta-only reservations are observably reclaimed; otherwise their charges remain and fallback may refuse. |
| `BlobRefCommitAdapter` | stage-table membership scans -> final protocol blobRefs/refset -> canonical signed body. Stage-table rows never become JS sets; only the final wire array/refset, conversion buffers, and signed body are charged. |

`HistoryFoldCacheAdapter` is additionally capped at two entries **and**
`min(128 MiB,floor(A/4))` estimated retained bytes; an entry too large is not
cached and an uncached fold still uses CP. Any reservation failure is
`WireMemoryAdmissionError`: inbound refuses the pull before plan/apply;
outbound preserves the sealed candidate but sends no commit and performs no
BASE CAS.

Calibration CI samples the maximum live `heapUsed + external` throughout each
construction (ArrayBuffers are reported separately but counted once through
`external`) plus instrumented native-codec workspace. It covers parse,
container rehash, canonical UTF-16/UTF-8 overlap, compression, encryption, and
signed-body construction for adversarial tiny-member shapes, maximum token
count, the maximum legal 64 MiB manifest, 512 MiB envelope intermediates,
two-entry history cache, and delta-to-snapshot fallback. CI fails closed if
measured retained heap exceeds E, measured peak exceeds CP, or phases overlap
contrary to the table; constants/caps tighten before enable. It does not change
`A`, the 64 MiB logical limit, the 512 MiB envelope ceiling, or a lower adapter
cap to make calibration pass (r3 C6; r3b-2).

The existing envelope plaintext ceiling is 512 MiB. The declared 64 MiB
`MAX_MANIFEST_BYTES` was not previously an effective serialized admission at
every call site; U2 makes it an explicit outgoing pre-materialization cursor
count and a post-serialization assertion. Inbound, immediately after
authentication/decompression and **before** `JSON.parse` or ordinary object
materialization, the body-length/token scan enforces the same 64 MiB logical
manifest limit and computes E. This can refuse a
previously constructible >64 MiB manifest and is a deliberate safety policy,
not a keystone deviation. Git sections count in those bytes. Envelope/delta
intermediate bytes can still reach the 512 MiB protocol ceiling and are
reported separately. A later wire-streaming design can remove these peaks;
design 163 removes steady BASE/LOCAL/REMOTE/action-map co-residency, not the
named wire materializations. Acceptance records peak bytes for every bullet,
snapshot and delta, cold and two-entry-LRU, 64 MiB edge/refusal, and delta-to-
snapshot fallback; “wire excluded” never means “unmeasured.”

## Migration authority state machine (r1 f4+f5+f6)

### Authority predicate and old-reader barrier

Database presence is never authority. The legacy path itself becomes the
atomic format marker:

```text
RBOX-SQLITE-AUTHORITY-v1
<32-lowercase-hex authority id>
```

`Q` is ASCII/UTF-8 with one LF after the version line and one final LF after
the id, no BOM, CR, whitespace, or additional bytes (exact length 58 bytes).
These exact bounded **non-JSON** bytes at `.rbox/state.json` are `Q`. Before
`Q`, a normal JSON state at that path is authoritative. After `Q`, only
`.rbox/state/state.db` with matching `authority_id`, application/schema ids,
and a complete migration record is authoritative. The authority id is stable
across ordinary transactions and reset candidates; it does not bind mutable DB
bytes or lineage.

This location is intentional. Current old binaries' guarded JSON parser raises
on the sentinel instead of synthesizing an empty sequence-zero state. The bake
release additionally recognizes `Q` before **every read and write** and throws
typed `StateFormatTooNewError`; doctor must never advise deleting it. An
inventory test pins every production state reader/writer/reset entry point to
that barrier. A separate marker unknown to old code is insufficient. Arbitrary
versions whose corrupt-JSON behavior predates the hard refusal are outside the
supported downgrade floor and are called out by release notes.

The source bytes are retained exactly at the fixed convenience path
`.rbox/state.json.pre-163.bak` and in an immutable, hash-addressed history at
`.rbox/state/legacy-json/<source-sha256>.json`. The backup set is recovery
evidence, never authority and not a downgrade protocol. The fixed path always
matches the JSON used by the completed active migration; an earlier fixed
backup is first preserved under its verified hash before the fixed path is
replaced. Thus running the JSON kill switch and changing state after an aborted
M5 cannot make the next migration permanently collide with the prior backup.
There is no automatic downgrade/dual-write path. After `Q`,
`RBOX_STATE_SQLITE=0` hard-errors; a future fenced legacy export is a separate
design.

The M0 authority matrix is exhaustive after standing reset recovery. `L`
means an identity-stable admitted legacy JSON regular file; `C` means an active
DB with exact application/schema/authority/completion evidence for the control
record; `P/F` means incomplete/unreadable/foreign DB. `exact` below means an
unhalted exact high-water record from the correlated table; `halted` means the
same exact record with its phase-preserving durable halt. Neither a completion
row nor a backup elects authority by itself.

| Legacy path | Active DB | Control | Authority and M0 action |
|---|---|---|---|
| `L` | absent | absent | JSON authority; eligible to run read-only M0 and publish its first control. |
| `L` | absent | exact | JSON authority; 2.0 alone resumes the recorded M0–M4 correlation after source revalidation. A changed source retires only identified artifacts and restarts with a new id. |
| `L` | `C` | exact M4 rename-ahead or M5 | JSON authority; 2.0 alone completes M5 or resumes M6 after source/completion revalidation. Any other phase here is corruption. |
| `L` | correlation-defined present/absent old artifacts | exact `source-change-retirement` from M0–M5 | JSON authority; only the retirement cursor below may mutate its one exact current target. It never imports or deletes the current `L`; fresh M0 begins only after terminal control retirement (r3 C1; r3a-3+r3b-3). |
| `L` | same correlation-defined artifacts | halted `source-change-retirement` | JSON authority; automatic cleanup is suspended at the exact cursor. Doctor may CAS-clear only that halt and delegate the same current-target action; the halt excuses no mismatch. |
| `L` | absent | halted M0–M4 | JSON authority; automatic migration is suspended. Only explicit doctor retry may CAS-clear the halt and hand execution to the same 2.0 controller. |
| `L` | `C` | halted M4 rename-ahead or M5 | Same suspension under JSON authority; any other halted phase/artifact pairing is corruption. |
| `L` | `C` | absent/foreign | JSON authority but reserved-path halt; a complete orphan is not adopted or automatically deleted. |
| `L` | `P/F` | any | JSON authority plus reserved-path/corruption halt; delete only if an exact control identity proves an incomplete id-scoped staging artifact, never an unknown active path. |
| exact `Q` | matching `C` | absent | Terminal SQLite authority; run W1 if applicable. No migration cleanup is inferred. |
| exact `Q` | matching `C` | exact M5 with Q sibling absent | SQLite authority at the M6 artifact-ahead boundary; finish parent fsync and publish M6. |
| exact `Q` | matching `C` | exact M6 cleanup cursor | SQLite authority; run only the cursor's exact current target and publish M7 only from the complete prefix. |
| exact `Q` | matching `C` | exact M7 | SQLite authority; retire/fsync the control only. |
| exact `Q` | matching `C` | halted M5–M7 | SQLite authority; never restore JSON. Honor the phase-specific durability/write block or cleanup deferral until explicit doctor retry delegates to the controller. |
| exact `Q` | absent/`P/F`/wrong authority id | any | contradictory authority; hard `StateAuthorityCorruptError`, zero repair writes. |
| absent | absent | absent | No authority. Genesis is allowed only with fenced config/incarnation/reset evidence and uses staged DB + `Q`; otherwise halt. |
| absent | any DB | any | Ambiguous/manual damage; halt. DB presence never elects authority. |
| malformed JSON, non-exact sentinel, special/unreadable legacy path | any | any | Halt before DB open or cleanup. |

A normal `L` plus exact immutable/fixed backups does not change a row. Backup
absence/mismatch affects migration admission and doctor evidence, never which
live representation wins. A halt whose phase is inconsistent with the
JSON/`Q` authority row is corruption, not suppression.

### Migration artifacts and completion witness

- Durable control: `.rbox/state/migration-v1.json`, an exact-schema closed
  union containing `version:1`, monotone `controlRevision`, `migrationId`,
  identity-bracketed source path/hash/size/stat token, authority id, exact
  staging path, `phase:M0|...|M7`, the phase witness below, required
  `haltResources:{reserve,emergency}`, optional exact typed halt, and exactly
  one of ordinary `retirement:null` or the closed source-change retirement
  union below.
  Each resource is exactly `not-created`, `available` plus its fsynced identity,
  `consumed-for-halt`, `retirement-intent`, `retirement-absent`,
  `cleanup-intent`, `cleanup-absent`, or `retired`; `not-created` is legal only
  at M0, the intent/absent variants only in their exact subprotocol below, and
  `retired` only at M7 after absence+parent fsync. Unknown/extra/missing fields
  reject (r3 C1+C2; r3a-3+r3a-4+r3b-3+r3b-4). It is state-machine
  coordination, never state authority.
- Staging DB: `.rbox/state/state.db.migrate.<migrationId>` plus only its own
  temporary sidecars.
- Authority sibling: `.rbox/state.json.migrate.<migrationId>.q`, in the same
  `.rbox` directory as `L/Q`. The M5 witness prebinds this path, the exact
  58-byte Q derived from `authorityId`, its length, and SHA-256. Its closed
  disposition is `absent`, `building:{dev,ino}`, or
  `exact:{dev,ino,bytes:58,sha256}`; every other path/type/identity/byte image is
  foreign. `building` admits only the recorded regular inode at length 0..58
  with arbitrary crash-prefix bytes, which the owner rewrites/truncates from
  offset zero; length >58 is foreign (r3 C2a; r3a-4).
- Emergency halt candidate/reserve: prebuilt, fsynced, migration-id-bound
  siblings used to record ENOSPC without requiring new data blocks.
- Backup history: immutable regular files
  `.rbox/state/legacy-json/<sha256>.json`; content must hash to the filename.
  The fixed `.pre-163.bak` is replaceable only after its bytes exist in history.
- DB completion row, inserted last in the same transaction as all imported
  rows: `{migrationId,importerVersion,authorityId,sourceJsonSha256,
  sourceSemanticDigest,sourceBytes,entryCount,repoCount,perTableCounts,
  completedAt}`. A DB without this exact record is incomplete, regardless of
  tables or file presence.

`state-semantic-v1` is a streaming SHA-256 over a versioned, typed,
length-framed logical token stream. It encodes presence separately from null,
all lineage scalars, manifest header, every FileEntry/extension member in
current JS path order, every GlobalManifestMeta value/chain/wire Git section,
and every RepoRecord/nested proof in repository order. The legacy object is
normalized by a named v1 normalization; SQL is streamed back through the same
projection. Counts are diagnostic only. Migration requires source digest ==
SQL round-trip digest and, when manifest meta is present, independently checks
the canonical reconstructed manifest hash.

### Durable phase publication and sole actor

`control.phase` is the highest durably completed migration phase, never the
phase about to start. Its phase-specific `witness` closed union is:

| High-water | Durable witness recorded only after completion |
|---|---|
| `M0` | exact source path/stat identity/hash/bytes, migration and authority ids, exact staging path |
| `M1` | M0 plus successful 52×/512 MiB/RSS admission; an unhalted record has both exact fsynced `haltResources` identities `available` (a later halt may change only that top-level disposition) |
| `M2` | exact immutable-history path/hash and exact fixed-backup path/hash, both parent-fsynced, plus `stagingMain` equal to `"absent"` or `{dev,ino}` (the same-phase revision after M3's durable exclusive create) |
| `M3` | exact committed `migration_completion` tuple/digest and the recorded durable staging-main identity |
| `M4` | staging physical SHA-256/bytes, `S0`, semantic digest/counts, DDL/application/schema/FK/integrity proof version |
| `M5` | the same physical witness at active `state.db`, active `S0`, `stagingMain:"absent"`, post-convergence state-parent fsync, and the prebound Q-sibling path/bytes plus its `absent|building|exact` same-phase disposition |
| `M6` | exact `Q` authority id, Q sibling absent, matching active completion/physical witness, `.rbox` parent fsync, and the closed same-phase cleanup cursor below |
| `M7` | all migration-id cleanup items `retired`, all non-control artifacts absent/exact-terminal, and every affected parent fsynced |

All control writes call one helper,
`publishMigrationControl(expectedMigrationId|"absent",
expectedRevision|"absent",nextControl)`.
While holding the complete workspace/repository/state lock set it writes
canonical bytes (hard cap 64 KiB) to an exclusive revision-scoped sibling,
fsyncs the file, renames it over `migration-v1.json`, fsyncs `.rbox/state`, and
rereads the exact record. Only then does `phase` or `halt` exist. A crash during
publication therefore leaves the old exact control, the new exact control, or
a malformed/foreign observation that halts; the temp never coordinates or
suppresses anything. A new phase is published only after that phase's artifact
work and every named parent fsync. No phase is pre-published.

There is one protocol actor. Stable 1.7.x may read/write authoritative JSON
under the existing workspace/state mutex while `L` exists, but never mutates
control, reserve, backup, staging, active DB, sentinel, or cleanup artifacts.
An unhalted 2.0 process holding the complete lock set is the only migration
controller. A mutating doctor acts only for explicit
`--retry-state-migration`: it takes the identical locks, CASes the exact halted
`controlRevision`, and invokes this same controller rather than implementing a
second repair path. Once `Q` exists, 1.7.x structurally refuses state access and
only 2.0 owns state and migration cleanup. Before every M1–M6 mutation the
controller revalidates source and control; an old JSON writer between 2.0
processes changes the source hash and forces id-scoped retirement/restart, not
competing migration ownership.

### Durable source-change retirement subprotocol (r3 C1; r3a-3+r3b-3)

Source change never authorizes an informal delete/restart. While exact `L`
remains sole authority and Q is absent, the controller first closes any staging
handle, takes the complete lock set, identity-brackets the replacement `L`, and
CAS-publishes this closed union **before deleting anything**:

```text
retirement: {
  version: 1,
  reason: "source-changed",
  fromPhase: M0|M1|M2|M3|M4|M5,
  fromControlRevision: number,
  originalSourceWitness,
  triggeringSourceIdentityAndSha256,       // diagnostic, never authority
  items: [{role,path,parent,dev,ino,sha256OrNull}],
  durablePrefix: number,
  currentIntent: null | {index: durablePrefix + 1}
}
```

`phase` remains the old highest completed M phase; retirement is a separate
monotone cleanup high-water and never phase completion or rollback. `items` is
a bounded fixed-role vector with deduplicated paths in this order: recorded
building/exact Q sibling; recorded staging `-journal`, `-wal`, and `-shm`;
recorded staging main (incomplete or exact-complete as its ordinary row
permits); exact prepared active DB admitted by M4 rename-ahead/M5; exact
migration-id private artifacts; exact emergency resource; then the exact
claimed reserve. The vector is
derived only from the old exact control plus identity-bracketed artifacts that
its ordinary row already owns. It never contains the current source,
immutable history, fixed backup, a discovered/free-form path, or
anything foreign/special/unreadable. Sidecars precede their main. M4
staging-only, active-ahead, and both-exact forms record precisely the exact
ones present. Incomplete/committed M2/M3 staging records its exact main and
each exact owned sidecar before cleanup.

Entry publication requires every listed item to exactly match its
control-owned starting disposition and recorded identity/content, including
building/incomplete forms, and `durablePrefix=0` with no intent. A crash
during that publication therefore leaves either the old Mx control with every
artifact still in its admitted ordinary disposition or the armed retirement;
no deletion has started. Cleanup is one-item correlated:

| Durable retirement cursor | Complete admitted observation and only action |
|---|---|
| prefix `k`, intent null | Items `1..k` are absent with completed parent fsyncs; every later item matches its armed identity/content disposition. Publish intent for `k+1`; do not unlink yet. |
| prefix `k`, intent `k+1` | Earlier items are absent, later items match their armed dispositions, and only item `k+1` may be owned-present or absent. If present, identity-bracket and unlink it; if absent, never recreate it. Fsync its recorded parent, then publish prefix `k+1` with intent null. |
| prefix `N`, intent null | Every item is durably absent. Unlink control and fsync `.rbox/state`; only then may a fresh M0 choose a new id from a fresh read of current `L`. |

When a target is a halt resource, intent publication atomically changes its
top-level disposition from `available` to `retirement-intent`; prefix
publication changes it to `retirement-absent`. Thus no absent resource is
described as available. Foreign/special/identity-changed target, absence ahead
of the current intent, or any later-item change is a zero-write corruption
halt—not a broader artifact-behind allowance. Further JSON changes during
retirement do not change its cleanup authority: retirement never parses,
imports, restores, or deletes replacement `L`.

R3B's M5 counterexample is closed concretely: (1) begin with changed exact `L`,
exact M5, and exact prepared active `C`; (2) publish retirement with `C` exact;
(3) publish `C`'s current intent before touching it; (4) unlink `C` and fsync
`.rbox/state`, where a crash observes retirement-intent plus exact-or-absent
`C`, both printed above; (5) publish its absent prefix, finish later exact
items, and retire the control last. `L + active absent` is therefore never
interpreted under ordinary M5, and `L + C + absent control` is never produced.

ENOSPC or a power cut at intent publication, unlink, parent fsync, prefix
publication, or terminal control unlink leaves exactly an old/new row above.
A caught failure may publish a phase-preserving `source-changed`/
`filesystem-full` halt carrying the exact retirement cursor. Authorized
cleanup may already have left the current intent item absent, but halt
publication consumes **no** retirement-vector item as runway and never changes
that item to `consumed-for-halt`. If publication would require any vector
resource, the halt remains nondurable. If halt/prefix publication also fails,
the already-durable intent still
admits its target's exact-or-absent power-loss image, `durableHalt=false`, and
the process performs no further write.

### Correlated M6 cleanup to M7 (r3 C2b; r3b-4)

M6 carries `cleanup:{order,durablePrefix,currentIntent}`. `order` is the closed
role order for exact M6-present private/migration-id artifacts first, the
generic reserve next, and the emergency resource last; it records each exact
path/identity and parent.
Q sibling is already absent and active DB/control/source backups are never
cleanup items. M6 publication starts at prefix zero with no intent.

Before removing item `k+1`, the controller CAS-publishes the same M6 phase with
`currentIntent:k+1`; a resource changes from `available` to `cleanup-intent` in
that revision. Only that item may then be exact or absent. For every nonfinal
item, unlink+parent fsync is followed by the next M6 revision recording
`cleanup-absent` and advancing the prefix. Earlier items must be
cleanup-absent, later items exact/available, and absence without current intent
is corruption.

The final item has an allocation-free publication runway. After its intent is
durable at revision `r` but **before** unlink, the controller renders two
exclusive revision-scoped siblings in order: (a) M6 revision `r+1` with the
exact same final intent and generic `cleanup-deferred` halt
(`underlyingCode:null`), which it fsyncs, rereads, and identity-brackets; then
(b) M7 revision `r+2` with complete prefix, all resource dispositions
`retired`, no halt, and that exact r+1 sibling identity for terminal cleanup.
It fsyncs and rereads M7, then fsyncs `.rbox/state`. These prepared future controls are inert while revision `r`
stands; the intentional `r -> r+2` success transition is monotone and this is
the only permitted revision gap. Only then may the final item be unlinked and
its parent fsynced. On success the controller renames the already-durable M7
sibling over control, fsyncs `.rbox/state`, and rereads M7. On caught ENOSPC it
may rename the already-durable cleanup-deferred sibling and fsync/reread it
**only before the M7 rename begins**; failure of that halt rename/fsync leaves
revision `r` as the exact durable intent and reports `durableHalt=false`. Once
the M7 rename begins, no lower revision is published: rename/fsync failure is
an in-process `durability-indeterminate` block, and restart observes old M6 or
new M7.

M7 itself is the durable record of the final cleanup-absent prefix. A
crash/power cut at the last deletion or either publication yields exact M6
final-intent with the item present/absent, exact halted M6 final-intent with it
present/absent, or exact M7 with it absent—never M6 `available` plus absence.
On the direct `r -> r+2` success path, M7 records the unused exact r+1 halt
sibling as its sole `exact-terminal` non-control artifact; the ordinary M7 row
admits that sibling exact or delete-ahead absent, unlinks it if present, and
fsyncs `.rbox/state` before control retirement. On the halted path the r+1
sibling became control, so M7 records it absent. No prepared control sibling
survives terminal control unlink.
On retry, halted M6 with absent final item revalidates/fsyncs its parent and may
publish the already-prepared M7 `r+2`; with the item still present, doctor
clears the halt and the controller rebuilds a revision-correct pair before
retrying. If preparing either future sibling fails initially, the final item
remains exact and cleanup does not start (r3 C2b; r3b-4).

ENOSPC during unlink/fsync/control publication may publish
`cleanup-deferred` against the exact same M6 cursor: current item remains
`cleanup-intent` and may be exact or absent; it is never mislabeled
`consumed-for-halt`. If that halt write fails, the durable intent remains the
restart record, `durableHalt=false`, and no more cleanup runs. At the final
intent the prebuilt halted-M6/M7 pair supplies the exact
ENOSPC-during-M7-publication record and success runway. A crash during a nonfinal next revision yields old
intent or new cleanup-absent prefix. This exact
correlation replaces every former prose allowance for unspecified “partial”
M7 cleanup.

#### V5 future-control preparation and halted-retry closure

This is a strict refinement of the preceding final-item runway and is its
exhaustive durable interpretation. It adds no cleanup permission: the final
item still requires a durable M6 `currentIntent`, and it remains present until
the pair is fully prepared. In the preceding summary, `r` means the
**runway-ready** M6 revision defined below, `r+1` is the prepared halted-M6
revision, and `r+2` is the prepared M7 revision. Preparation itself is now
owned by earlier same-phase M6 revisions rather than existing ahead of an M6
witness.

The M6 publication that first records the final item intent atomically adds
this closed ledger at control revision `b`:

```text
futureControls: {
  version: 1,
  baseRevision: b,
  readyRevision: b + 4,
  haltRevision: b + 5,
  successRevision: b + 6,
  halt: {
    kind: "halted-m6",
    path: exactRevisionScopedPath(b + 5),
    disposition: absent | building:{dev,ino,expected:null|{bytes,sha256}} |
                 exact:{dev,ino,bytes,sha256}
  },
  success: {
    kind: "m7",
    path: exactRevisionScopedPath(b + 6),
    disposition: absent | building:{dev,ino,expected:null|{bytes,sha256}} |
                 exact:{dev,ino,bytes,sha256}
  }
}
```

`futureControls` is part of the exact M6 phase witness: it is `null` before
the final intent and is the preparation ledger above from `b` through `b+4`.
The prepared halted record consumes it into a closed `promotedHalt` origin
identity plus `preparedSuccess` inode/template witness, and M7 consumes it into
the terminal sibling descriptor below. It is not an optional top-level
extension and therefore does not relax the control's
unknown/extra/missing-field rejection.

All printed revision values must be safe integers and exactly spaced as
printed; the two paths are distinct, migration-id-bound, canonical-publisher
siblings in `.rbox/state`, and are prebound by `b` before either exists.
`absent` means no directory entry. `building` names one no-follow regular
mode-0600 inode, already file- and parent-fsynced. `expected:null` requires a
zero-byte inode because the other identity needed to render that member is not
durable yet. Once both identities exist, M6 records the halt member's expected
length/hash before writing it; once halt is exact, the next M6 revision records
the success member's expected length/hash before writing it. An expected
building inode may contain any power-loss byte image of length
`0..expected.bytes`, including the complete expected bytes; the controller
never interprets the partial image and only rewrites it from offset zero and
truncates. `exact` retains that identity and additionally requires the complete
canonical bytes for its fixed kind/revision, byte length, SHA-256, file fsync,
parent fsync, and identity-stable reread. Missing, special, unreadable,
identity-changed, over-limit, wrong-revision, or noncanonical exact bytes are
foreign. Neither descriptor can be reset from `building`/`exact` to `absent`.

The halted-M6 bytes carry the two created path/revision/inode identities, the
same final cleanup intent, and the deterministic semantic template of the M7
record. Its `promotedHalt` member deliberately omits its own SHA-256 and its
`preparedSuccess` member omits the M7 SHA-256; embedding either would create a
self/cross-digest cycle. Once the halt bytes are exact, hashing those canonical
bytes plus the already-recorded M7 inode determines the one canonical M7 byte
string. The M7 bytes in turn record the halt sibling's complete exact
identity/hash from the ready M6 ledger. When halt is canonical, its inode must
equal `promotedHalt` and its origin sibling path must be absent. It can then
recompute and byte-check the one M7 it owns; migration id, revision, inode, and
closed record contents all have to agree. A path match alone is never enough.

Preparation has only these durable rows. `zero-create-ahead` means the exact
prebound path contains one no-follow regular mode-0600 zero-byte inode before
the next ledger CAS records that inode; it makes no claim that a pre-crash file
or parent fsync completed. The next action identity-brackets it and requires
both fsyncs before publication. It is the sole artifact-ahead allowance in an
`absent` descriptor.

| Canonical control | Complete admitted future-control observation | Only next action |
|---|---|---|
| `b`: final intent; both descriptors `absent` | success absent; halt absent or halt `zero-create-ahead` | Exclusively create halt if absent; identity-bracket and fsync that inode and its parent, then publish M6 `b+1` with halt `building`; do not write its record bytes yet. |
| `b+1`: halt `building` with expected null, success `absent` | halt is the recorded zero-byte inode; success absent or success `zero-create-ahead` | Exclusively create success if absent; identity-bracket and fsync that inode and its parent, derive halt expected bytes, then publish M6 `b+2` with success `building`/expected null and halt expected length/hash. |
| `b+2`: both `building`; halt expected, success expected null | success is the recorded zero-byte inode; halt is its recorded inode at any bounded write image, including complete expected bytes | Rewrite/truncate halt, fsync/reread it, derive success expected bytes from its exact hash, then publish M6 `b+3` with halt `exact` and success expected length/hash. |
| `b+3`: halt `exact`, success `building` with expected bytes | halt matches exact bytes; success is its recorded inode at any bounded write image, including complete expected bytes | Rewrite/truncate the expected M7 bytes, fsync/reread them, then publish M6 `b+4` with success `exact`. |
| `b+4` (`r`): both `exact` | both exact; final intent item exact or absent, and every other cleanup item matches its prefix position | This is the first row allowed to unlink/fsync the final item, then take only the direct-M7 or prepared-halt transition below. |

A process/power failure at each exclusive create, file fsync, parent fsync,
render/write/truncate, exact reread, or ledger CAS leaves the old or next row
above. Before `b+4`, a caught allocation/fsync failure publishes no alternate
control and starts no cleanup: the durable preparation row remains resumable,
the in-process halt reports `durableHalt=false`, and subsequent writes stop.
Preparation always resumes the same ledger stage and inode; it never deletes a
partial, chooses a new revision, or creates a second pair. An extra generation,
the wrong member appearing first, a second inode, disappearance after
`building`, or any observation outside the table is a zero-write corruption
halt. Generic publisher temps retain their separately specified inert-temp
rule and are not a future-control disposition.

At ready revision `r=b+4`, direct success unlinks the final item if present,
fsyncs its recorded parent, then renames the exact success sibling over the
canonical control with expected revision `r`, fsyncs `.rbox/state`, and rereads
exact M7 revision `r+2`. The unused exact halt sibling remains at its recorded
path. A caught cleanup/fsync failure before the success rename may instead
rename the exact halt sibling over the canonical control with expected
revision `r`, fsync the parent, and reread exact halted M6 revision `r+1`.
Once either rename begins, the other control is not published. The old/new
power images are respectively ready M6 plus both exact siblings, halted M6
plus an absent halt path and exact success sibling, or M7 plus an absent
success path and exact halt sibling.

The halted record has one retry protocol for both final-item observations.
`rbox doctor --retry-state-migration` takes the complete lock set and
CAS-validates the exact halted revision, halt bytes/identity, absent halt
sibling path, exact success sibling, Q/active witness, and unchanged cleanup
cursor. Automatic cleanup remains suppressed. Doctor then delegates one
in-process attempt to the same controller: if the final item is present, the
controller identity-brackets/unlinks only it; if absent, it never recreates it;
in both cases it fsyncs the recorded parent and renames the already-prepared
exact M7 sibling over control with expected revision `r+1`, fsyncs
`.rbox/state`, and rereads M7 `r+2`. A failure before that rename leaves the
same halted row with the item exact or absent and permits no further automatic
write. A failure during publication has only the old halted or new M7 power
image.

For this one allocation-free runway, that expected-`r+1` to exact-`r+2`
promotion is the durable CAS-clear and controller delegation required by the
global doctor contract; no intermediate unhalted revision may consume `r+2`.
This sentence is the explicit narrow specialization of every earlier or later
generic doctor clause and `exact halted M0–M7` table cell: only for an exact
final-intent `promotedHalt`, doctor under the full locks may CAS-validate H and
mint a single-use in-process delegation bound to that exact control identity,
final target identity, and parent-fsync action. “Doctor alone” means doctor
alone may authorize this token; the same controller still performs the one
already-intended mutation. Automatic cleanup remains suppressed, a crash
forgets the token and leaves H halted, and the expected-H rename of exact S is
the sole durable halt clear/phase advance. No other halted row gains any
mutation-before-clear permission.

The earlier phrase “rebuilds a revision-correct pair” means revalidate and
reuse this exact pair in v5. Creating a replacement pair, clearing to a
different M6 revision, or retiring the prepared M7 before use is forbidden.
Thus there is no stale-pair collision or leak: an incomplete pair is resumed,
a ready pair is reused, and only M7 performs terminal sibling retirement.

The prebuilt M7 record is identical on both branches. Its halt-sibling field is
the closed terminal descriptor
`{path,dev,ino,bytes,sha256,disposition:"exact-or-absent-terminal"}`. On the
direct branch the path begins exact; on the halted branch the same inode was
promoted to canonical control so the sibling path begins absent. After M7 is
canonical, exact may become absent only through M7's identity-bracketed unlink
plus parent fsync, and absent is success. M7 then retires the canonical control
last. The record never claims branch-dependent bytes, no prepared sibling
survives terminal control unlink, and no lower revision can consume `r+2`.
Accordingly, the preceding branch-specific phrases “records ... exact” and
“records it absent” describe the admitted observed branch of this one terminal
descriptor; they do not select or mutate different M7 bytes.

### Ordered phases

Migration runs only after standing-reset recovery, under the non-degraded
workspace mutex, complete repository fence as needed, and state lock:

1. **M0 — classify and record intent.** Bounded-read the legacy path first;
   never create a DB merely because it is absent. Identity-bracket/hash `L`,
   choose random migration/authority ids and an exact staging path, then publish
   the `M0` control. Failure to publish leaves no durable phase and JSON
   authority; it may produce only an in-process halt.
2. **M1 — admit.** Revalidate M0/source; apply design 161's unchanged 52×
   admission, 512 MiB hard cap, and RSS/cgroup budget; perform advisory
   `statfs`. Validate/claim the bake release's fsynced 1 MiB generic reserve or
   create it, and create/fsync the id-bound emergency halt candidate. Publish
   M1 only after both identities and parents are durable.
3. **M2 — preserve source.** Ensure the current source exists at its immutable
   hash-addressed history path by verified hard link or bounded streaming copy.
   If fixed `.bak` is absent/exact, publish/reuse it. If different but valid,
   first preserve it under its own verified hash, fsync path+directory, then
   atomically replace fixed backup and fsync `.rbox`. No unique bytes are
   overwritten/deleted. Publish M2 only after both exact backup witnesses and
   their parents are durable.
4. **M3 — durably create and build.** Before SQLite opens staging, no-follow
   `O_EXCL` create its main file, fsync the empty file, fsync `.rbox/state`,
   revalidate its exact regular-file identity, and CAS-record that identity in
   the M2 control revision. Only that exact owned file may then be initialized.
   Re-run the unchanged 52×/RSS admission immediately before the sole guarded
   parse, compute its semantic stream, set/verify pinned
   pragmas/schema, and import all planes/records in one transaction. Insert the
   completion row last and commit. A rollback/`SQLITE_FULL` leaves no complete
   record. Publish M3 only after the committed completion tuple is reread and
   exact; WAL sidecars are allowed until M4. A sidecar without the durable main
   is impossible under this order and halts.
5. **M4 — close and prove.** As the sole migration owner, recover the exact
   M3 staging WAL if needed, run `wal_checkpoint(TRUNCATE)` non-busy, close,
   require `S0`, reopen read-only, recompute SQL semantic stream/counts,
   validate application/user/DDL ids, `foreign_key_check`, and full
   `integrity_check`; close, require `S0` a second time so the verifier left no
   sidecar, fsync DB+state directory, physical-hash with identity bracketing,
   then publish M4 with the complete proof.
6. **M5 — publish prepared DB.** Revalidate source/control and exact M4 hash,
   atomically rename staging to `state.db`, durably remove only a redundant
   exact staging name if a crash correlation produced both, require staging
   absent and active `S0`, fsync `.rbox/state` after convergence, and publish
   M5 with the deterministic Q-sibling path/58-byte hash prebound and its
   disposition `absent`. JSON remains authority throughout (r3 C2a; r3a-4).
7. **M6 — flip authority.** The M5 witness already binds
   `.rbox/state.json.migrate.<migrationId>.q` and exact Q bytes. With disposition
   `absent`, no-follow `O_EXCL` create mode 0600, fsync the empty file and
   `.rbox`, identity-bracket it, and CAS-publish M5 `building:{dev,ino}` before
   writing. The old absent revision admits only absent or that zero-byte
   create-ahead file. Under the recorded building identity, rewrite from offset
   zero, truncate to the exact 58 bytes, fsync, hash/identity-bracket, and
   CAS-publish M5 `exact`; a kill while building may leave zero/partial/exact
   bytes, but only that recorded inode may be rewritten. The old building
   revision plus exact bytes is the sole finish-ahead image. Any other
   path/type/identity/bytes is foreign and halts (r3 C2a; r3a-4).

   With exact sibling, rehash and identity-revalidate live JSON and `.bak` and
   the M5 active completion/hash. A source mismatch enters C1 retirement and
   includes the recorded building/exact sibling; it never renames. Otherwise
   atomically rename the exact sibling over `.rbox/state.json`, fsync `.rbox`,
   then publish M6 with sibling absent and the initial cleanup cursor. A process
   kill after rename observes Q+sibling-absent. A power cut before the parent
   fsync observes only the old durable pair `{L,exact sibling}` or new pair
   `{Q,sibling absent}`; retry the former rename or the latter parent fsync.
   `L+sibling absent` under exact-sibling M5, `Q+sibling exact`, or a foreign
   sibling is unlisted and halts. This rename has no absent-authority window
   and is the only authority flip; observing Q elects SQLite even if M6 control
   publication was interrupted (r3 C2a; r3a-4).
8. **M7 — finish and retire control.** With Q+matching DB authoritative,
   execute only the correlated M6 intent/prefix cleanup above. Publish M7 only
   after every nonfinal item is `cleanup-absent`, the final intent item is
   absent, and every parent fsync completed, using the prebuilt M7 runway and
   converting resources to `retired`. If M7 records the unused r+1 halt sibling
   exact-terminal, unlink it (absent succeeds) and fsync `.rbox/state`; only
   then unlink the control and fsync `.rbox/state`. Failure here never undoes
   SQLite authority. Terminal proof is
   Q+matching complete DB+absent control (r3 C2b; r3b-4).

### Crash, disk-full, and resume table

Every restart first reads the legacy path and exact control, then correlates all
named artifacts without mutation. An unhalted control admits only its required
artifact or the explicitly printed **one-next-phase artifact-ahead** state.
Artifact-behind, two-phases-ahead, foreign, special, sidecar-without-main, or
phase/witness mismatch halts with zero writes; it is never repaired forward.
The one printed C1 source-change precursor authorizes only arming retirement;
C1 retirement and C2 cleanup intent rows are then separate one-target cleanup
correlations, not permission to broaden any other ordinary M0–M7 row (r3
C1+C2).

| Control high-water | Complete admitted restart observation and action | State authority | Sole owner of next protocol mutation |
|---|---|---|---|
| absent | Exact `L`, no reserved active DB. An interrupted first control publication may leave an exact regular revision-scoped M0 temp; it is inert, never adopted as control, and fresh M0 chooses a new id without touching it. A special/unreadable/nonconforming temp halts; explicit doctor may quarantine inert temps later. Rerun read-only M0 and publish M0 only after fresh identity/hash. | JSON | 2.0 controller may begin; 1.7.x may perform only ordinary JSON data operations. Doctor is otherwise read-only. |
| `M0` | Exact source. Reserve/emergency may be absent or an exact id-scoped partial/complete M1 artifact; validate/create them, rerun admission, then publish M1. Ordinary crash does **not** imply disk-full. | JSON | 2.0 controller only; doctor only if an exact halt is later published. |
| `M1` | Source exact; history/fixed backup may be absent, exact temp, exact current, or valid prior fixed backup. Resume M2 idempotently, preserving prior bytes, then publish M2. Foreign/special backup halts. | JSON | 2.0 controller only. |
| `M2` | Source/backups exact. `stagingMain` witness is either `absent` or an exact recorded regular identity. With `absent`, no file or the sole create-ahead shape (exact path, no-follow regular zero-byte mode-0600 file, no sidecars) may begin/finish the M3 identity publication. With a recorded identity, an incomplete id-owned main and only its own sidecars may be recovered/removed and rebuilt; sidecar without main halts. An exact committed completion is the sole M3-artifact-ahead form: reread it and publish M3. | JSON | 2.0 controller only; it is the only actor allowed to open this non-authoritative DB. |
| `M3` | Exact source/backups plus exact committed id-bound staging; its own WAL/SHM may exist. Open only as migration owner, recover, and rerun all M4 checkpoint/semantic/FK/integrity work. Publish M4 only after close/`S0`/hash/fsync. | JSON | 2.0 controller only. |
| `M4` | Exact physical M4 witness is either staging-only, or the M5 rename ran ahead and active-only/both-exact is observed. Revalidate identical hashes/completion, fsync/converge without ever moving active backward, durably remove only a redundant exact staging name, then publish M5. Missing both, nonexact active, or any sidecar halts. | JSON | 2.0 controller only. |
| `M5` + exact `L` | Exact active prepared DB at the M5 hash; staging absent; source/backup still match. Q sibling is exactly one of: absent (plus the sole zero-byte create-ahead); recorded building inode with zero/partial/exact bytes; or recorded exact inode/bytes. Resume only the matching create/write/fsync/same-phase-CAS step, then rename exact sibling. Foreign/changed identity halts. If JSON changed, arm C1 retirement before any cleanup. | JSON | 2.0 controller only; 1.7.x can alter only JSON and thereby invalidate this migration. |
| `M5` + exact `Q` | Sole M6-artifact-ahead form: matching complete active DB and Q sibling absent. SQLite is already elected; never rename JSON back. Complete/retry `.rbox` fsync, publish M6 with its initial cleanup cursor, and keep writes blocked as `durability-indeterminate` until that fsync succeeds. | SQLite | 2.0 controller only; 1.7.x refuses Q. |
| ordinary M0–M5 + changed exact `L` | Every non-source artifact must still match the ordinary old phase row exactly; the sole mismatch is a freshly identity-bracketed, legacy-guard-admitted current `L` at the same authoritative path. Publish the initial C1 retirement revision before any artifact mutation. A malformed/special/unreadable replacement or any second mismatch halts. | JSON | 2.0 controller may only arm retirement. |
| `source-change-retirement` from M0–M5 | Exact L plus precisely the retirement prefix/intent correlation printed above. Only the current intent target may be owned-present or absent; every other target matches its armed disposition/vector position. Resume that target or, at complete prefix, retire control. | JSON | 2.0 controller only; doctor only through exact halted retry. |
| `M6` | Exact Q + matching complete/physical active DB and exact cleanup prefix/intent. Only the current cleanup-intent item may be exact or absent; earlier items are cleanup-absent and later items exact. Resume that item; publish M7 only from a complete nonfinal prefix plus the final absent intent and prebuilt runway. | SQLite | 2.0 controller only. |
| `M7` | Exact Q + matching DB, all resource cleanup complete, and the recorded unused r+1 halt sibling either exact-terminal or delete-ahead absent. Durably remove that sibling if needed, then unlink control and fsync state parent; no earlier phase may rerun. | SQLite | 2.0 controller only. |
| terminal absent control + exact Q | Matching complete active DB and no standing migration control. Ordinary SQLite startup/W1 applies; migration has no next mutation. | SQLite | Ordinary 2.0 state owner; doctor read-only unless separately authorized. |
| exact halted M0–M7 | The same phase/artifact correlation must match; halt never excuses mismatch. Automatic migration/cleanup is suppressed until explicit retry. | JSON before Q; SQLite after Q | Doctor alone may CAS-clear the halt under full locks, then authority transfers to the same 2.0 controller. |
| foreign/malformed/inconsistent control or artifacts | No phase inference, cleanup, DB open, sentinel write, or backup restoration. | Existing exact L/Q predicate only, otherwise contradictory | None; zero-write corruption halt. |

An orphan sibling is auto-deletable only when its path, migration id,
application id, authority id, and control record all agree. A foreign or
unreadable reserved path is never deleted. A complete active DB with matching
control/source is prepared-not-authoritative until M6.

### 512 MiB and typed non-looping halts

The legacy guard is unchanged: `>512 MiB` is refused; exactly 512 MiB still
needs 26 GiB of parse headroom before retained object, SQLite cache, staging DB,
WAL, and backup. `statfs` budgets worst-case streaming backup/history copy,
estimated staging DB and indexes, staging rollback/WAL/checkpoint space,
publication coexistence, reserve, and margin only as an early refusal. Sparse
files, quotas, concurrent consumers, and delayed allocation make this estimate
non-authoritative; every filesystem/SQLite write, truncate, rename, and fsync
in M0–M7 handles ENOSPC as its row above.

`StateMigrationHaltError` has stable reasons `source-oversize`,
`memory-admission`, `record-oversize`, `disk-preflight`, `filesystem-full`, `source-changed`,
`verification`, `reserved-path`, `durability-indeterminate`, and
`cleanup-deferred`, plus phase, underlying syscall/SQLite code, source,
required, available, `durableHalt:boolean`, cleanup-safe paths, and the exact
retirement or M6-cleanup cursor when one is active (r3 C1+C2).
`SQLITE_FULL` maps to `filesystem-full` while retaining its original code.
Guard refusal happens before staging and leaves JSON untouched. Before
disk-intensive work, M1 prefers the bake release's generic reserve, and
releases/unlinks it before publishing an exact typed halt. That creates a
strong recovery opportunity, not a false guarantee: the halt is durable only
after the shared control publisher commits the same `phase`, an incremented
`controlRevision`, and exact
`halt:{reason,phase,underlyingCode:string|null,required:number|null,
available:number|null}` and the updated top-level `haltResources`. A
`consumed-for-halt` resource records the exact previously available file
unlinked or renamed to make publication possible. A halt never advances
the phase, retirement prefix, or cleanup prefix. During retirement/cleanup it
consumes no vector item as halt runway; a current intent is preserved as
`retirement-intent`/`cleanup-intent`, never relabeled `consumed-for-halt`. If
reserve creation/release or halt publication itself fails,
`durableHalt=false`; the process keeps the typed halt in memory and performs no
more migration writes.

Only a caught admission refusal, ENOSPC, `SQLITE_FULL`, verification failure,
or other typed condition may attempt that publication. `SIGKILL`, power loss,
or an unobserved process crash never manufactures a halt: restart follows the
unhalted high-water/artifact row. A crash before/during halt publication leaves
the old resumable control or the exact halted control; an emergency candidate,
revision temp, log message, or un-fsynced rename never suppresses another
process. Before Q, a durable halt suspends migration but not JSON authority.
After Q, it can only express `durability-indeterminate` write blocking or
`cleanup-deferred`; it can never reelect/restore JSON.

The default-on daemon catches this error, remains alive in a
`migration-halted` health state, suppresses every subsequent pump migration
attempt for that process, and serves status/doctor. A successfully fsynced
halt also suppresses startup attempts across processes; a non-durable halt may
try once on a later explicit process start but never hot-loops or exits into a
supervisor retry cycle. Only explicit
`rbox doctor --retry-state-migration` after remediation CAS-clears the exact
halt under the complete lock set and delegates to the same controller. Before
clearing an ordinary M0–M5 halt whose top-level resources record
consumed/not-created, doctor recreates/fsyncs them and CAS-publishes the same
phase with both dispositions `available`; only then can disk-intensive work
resume. A retirement or M6-cleanup halt instead preserves its exact cursor and
resumes only its current target; it never resets an absent disposition to
available. Alternatively,
`RBOX_STATE_SQLITE=0` continues the JSON engine while JSON is still authority.
`cleanup-deferred` after `Q` is cleared only by cleanup/doctor, not by rerunning
M0. Source JSON and every unique exact backup are never deleted on failure.

Fault injection covers before/after every transaction/table/commit/checkpoint/
close/verify/rename/fsync, every M0–M7 control publication and its old/new
record, the M2 same-phase staging-identity CAS, staging file+parent fsync,
the Q-sibling absent/create-ahead/building/exact revisions, Q rename and
old/new power-loss images, every source-retirement entry/intent/unlink/parent-
fsync/prefix/terminal-control boundary, every M6 cleanup
intent/unlink/parent-fsync/prefix, final halted-M6/M7 sibling preparation and
old/new publication boundary, halt publish/recreate/clear, and
every one-phase artifact-ahead restart (r3 C1+C2); it
injects OS ENOSPC and `SQLITE_FULL` at every M0–M7 write
class (including reserve/halt publication and cleanup), hard-link fallback,
and instantiates retirement at M2 absent/incomplete/committed staging, M3 with
each owned sidecar subset, every M4 staging-only/active-ahead/both form, and M5
with absent/building/exact Q sibling. It also covers
valid-prior and foreign backup collisions, exact admitted/refused 512 MiB and
>512 MiB, source mutation before M6, stale/foreign DB/control, repeated kill-
switch JSON advances with immutable backup history, marker durability
ambiguity, minimum/maximum RepoRecord codec admission, non-durable in-process
suppression, and old-binary read/write refusal.

V5 fault injection separately enumerates `b` through `b+4`: before/after each
future-control exclusive create, file fsync, parent fsync, building-identity
CAS, every write/truncate prefix, exact reread, and exact-disposition CAS. It
restarts every printed absent/zero-create-ahead/building/finish-ahead/exact row
and rejects disappearance, replacement inode, special type, wrong order,
wrong revision/bytes, or an extra pair with a byte-for-byte zero-write
snapshot. Final-runway cases cover item present/absent at ready M6, direct M7,
caught failure to prepared halt, process kill and power cut at both renames and
parent fsyncs, explicit halted retry with item present/absent, repeated failure
before retry promotion, immutable M7 validation on both halt-sibling terminal
observations, sibling retirement, and terminal-control-last. Tests assert no
retry creates a new pair and no terminal control unlink leaves either prepared
sibling.

## Field-complete schema and store API (r1 f7+f11)

This is the normative logical schema. Exact DDL is generated/frozen in U1 and
must be isomorphic to this mapping; adding a TypeScript field without updating
the compile-time coverage map, codec, digest, migration round-trip fixture, and
schema is a build failure.

### Core and manifest tables

```sql
store_meta(
  singleton PRIMARY KEY CHECK(singleton=1), application_id, schema_version,
  ddl_fingerprint, authority_id, active_lineage_id UNIQUE NOT NULL, created_by,
  FOREIGN KEY(active_lineage_id) REFERENCES state_lineage(lineage_id)
)
state_lineage(
  lineage_id PRIMARY KEY, stream NOT NULL, state_nonce NULL,
  state_revision NULL, last_synced_sequence NOT NULL,
  active_base_generation NOT NULL, local_revision NOT NULL,
  telemetry_binding_id NULL,
  repo_records_authoritative NOT NULL CHECK(repo_records_authoritative=1),
  extras_cjson
)
migration_completion(
  singleton PRIMARY KEY, origin_kind, migration_id, importer_version,
  authority_id, source_json_sha256 NULL, source_semantic_digest NULL,
  source_bytes NULL, source_shape_flags_cjson,
  source_repo_records_present, entry_count, repo_count,
  per_table_counts_cjson, completed_at
)
entry_values(
  entry_id PRIMARY KEY, exact_fingerprint, path, path_order,
  sha256, size, mode, mtime_ms, kind, symlink_target NULL,
  enc_sha NULL, comp NULL, payload_sha NULL, cipher_size NULL,
  extras_cjson, canonical_bytes, retained_estimate,
  UNIQUE(entry_id,path,path_order)
)
plane_heads(
  lineage_id, plane CHECK(plane IN ('base','local')), generation,
  generated_at, manifest_schema NULL, source_sequence NULL,
  trust_epoch NULL, complete, extras_cjson,
  PRIMARY KEY(lineage_id,plane)
)
plane_entries(
  lineage_id, plane, path, path_order, entry_id, changed_generation,
  PRIMARY KEY(lineage_id,plane,path),
  FOREIGN KEY(lineage_id,plane) REFERENCES plane_heads(lineage_id,plane),
  FOREIGN KEY(entry_id,path,path_order)
    REFERENCES entry_values(entry_id,path,path_order)
)
```

The main DB has exactly `base` and `local` heads. A read transaction sees each
head generation and membership coherently. Adoption set-diffs a sealed stage
into `plane_entries`, stamps only changed rows, and bumps the head once; deleted
paths are physically deleted in that transaction. LOCAL is rebuildable; BASE is
authoritative. `state_lineage.active_base_generation` and `local_revision` must
equal their corresponding head values by trigger/commit assertion.
BASE `complete` is always 1. LOCAL `complete=1` means a full scan under its
recorded trust epoch; apply invalidation sets it to 0 before disk mutation, and
only full-scan finalization may restore 1. Every push/trusted-status predicate
requires 1 in the same logical snapshot token.

REMOTE/WIRE/SCAN stages use a separate connection-owned, file-backed schema:
`stage_meta(stage_id,plane,state,header_cjson,digest,counts_cjson)` and
`stage_entries(stage_id,path,path_order,entry_cjson)`, plus ordered stage Git
sections. State is `building|sealed`; only sealed stages with verified id/digest
may enter a CAS. They are never attached as writable authority, never use the
main WAL, and are deleted with id-scoped cleanup after adoption/refusal.

“Sealed” is a physical and semantic protocol, not merely the value of a
mutable column. `stage-semantic-v1` length-frames the stage id/plane, every
header known field and optional-presence/extras token, expected counts, every
ordered complete FileEntry, and every ordered `(role,relPath,complete
GitSection)` including empty-versus-absent roles. `finishGeneration` validates
all rows in one builder transaction, writes exact counts+logical digest and
`state='sealed'`, commits, checkpoints `TRUNCATE`, closes the sole builder,
requires `S0`, fsyncs, computes a physical SHA-256 with identity bracketing,
renames to a digest-bearing sealed path, and fsyncs its parent. It returns
`SealedStageRef {stageId,plane,logicalDigest,physicalSha256,bytes,counts}`.
No API opens a sealed path writable or changes it back to building; retry that
needs mutation creates a new stage id.

Every consumer acquires the id-scoped stage lock, no-follow lstats an exact
regular `S0` file, verifies physical hash/identity, opens it read-only immutable,
and streams rows through a fresh `stage-semantic-v1` recomputation. For final
CAS it copies those rows into connection-owned file-backed TEMP tables while
streaming, closes the stage, then repeats physical hash/stat/sidecar checks.
Only exact logical digest/count and before/after physical identity/hash matches
may reach `BEGIN IMMEDIATE`; later changes to the external path cannot affect
the TEMP input. Mismatch rolls back/discards the TEMP input and is a typed
`StageChangedError`. Reconcile/apply/wire consumption performs the same proof,
so a crash-resumed stage is never trusted from its `sealed` bit alone.

`path_order` is a BLOB of big-endian UTF-16 code units. Current manifest order
uses JavaScript string `<`, which is UTF-16 code-unit order; SQLite UTF-8
`BINARY` differs for some Unicode. Every file/repo merge orders by this key,
with exact path as the uniqueness key. Legacy `localeCompare` behavior used for
the 256-entry deferral/partial cap runs once in the import codec before insert;
it is not silently replaced by SQL collation.

`entry_values` is immutable and interned. Fingerprint collision requires exact
column+extension comparison. `plane_entries` supplies plane membership and
`changed_generation`; a head generation plus its rows is the logical
generation. Old entry values are collected only after no plane row/read
snapshot references them.

### Exact FileEntry and Manifest mapping

| TypeScript field | SQL representation and invariant |
|---|---|
| `FileEntry.path` | `path TEXT` + `path_order BLOB`; POSIX-relative, no absolute/`..`/NUL; exact text is authoritative |
| `sha256` | 32-byte BLOB, codec requires lowercase hex64 and reconstructs it exactly |
| `size` | lossless JS-number storage (INTEGER when exact SQLite integer, otherwise REAL); current admitted domain `Number.isInteger(size)&&size>=0`, including unsafe-but-representable doubles |
| `mode` | INTEGER permission bits in the current admitted range `0..0o7777` (setuid/setgid/sticky retained) |
| `mtimeMs` | **REAL**, not INTEGER; fractional milliseconds are retained exactly enough for JS-number round trip and remain excluded from content identity |
| `type` | `kind` enum file/symlink |
| `symlinkTarget?` | NULL means absent; required nonempty text for symlink; a currently tolerated value on `type:"file"` is retained in the known column rather than rejected/dropped |
| `encSha?` | nullable 32-byte ciphertext-address BLOB; may exist without compression |
| `comp?` | nullable enum, currently only `zstd` |
| `payloadSha?` | nullable 32-byte BLOB; present iff `comp` |
| `cipherSize?` | nullable lossless JS-number storage with current `Number.isInteger&&>=0` domain; present iff `comp` |
| tolerated extension members | complete authoritative `extras_cjson`; current validation/deep-diff can preserve unknown members, so migration must not drop them |

`extras_cjson` and every canonical blob distinguish absent, JSON null, `{}`,
and `[]`; typed known fields reject null where the interface does. Compression
joint-presence and manifest-schema rules are CHECK+codec invariants.

`canonical_bytes` and `retained_estimate` are recomputed by the complete
known+extras FileEntry codec, not trusted from callers, and CHECK-constrained
to 4 MiB canonical and 16 MiB retained. A cursor validates them before decode;
a mismatch is structural corruption and a value above either cap is
`FileEntryOversizeError`. This is `RetainedEstimateV1` from the materialization
section, also used by the adapter and wire ledgers.

`*_cjson` means `rbox-json-canonical-v1`, not the signed-object JCS helper. It
is total over JSON values admitted by `JSON.parse`: object keys sort by UTF-16
code unit, strings use JSON escapes with lone surrogates escaped as `\uXXXX`,
arrays retain order, and every finite integer/fractional/negative number uses
ECMAScript JSON number spelling (`-0` normalizes to `0`, as existing JSON
serialization already does). NaN/infinity/undefined are rejected. Presence is
an outer typed token, never inferred from blob contents.

`Manifest.generatedAt`, optional `manifestSchema`, and unknown top-level
members live on `plane_heads`/stage header; `Manifest.files` is `plane_entries`
or sealed `stage_entries`; optional `Manifest.gitRepos` is
stored by role below during exact migration verification and thereafter is the
projection of RepoRecords (`base` only when not removed/repoAbsent). Presence
versus empty is retained.

### GlobalManifestMeta mapping

```sql
global_manifest_meta(
  lineage_id PRIMARY KEY, base_generation, enc_manifest_sha, manifest_hash,
  account_epoch, key_epoch, chain_bytes, snapshot_bytes, extras_cjson
)
manifest_chain(lineage_id, base_generation, ordinal, enc_sha,
  PRIMARY KEY(lineage_id,base_generation,ordinal))
manifest_git_sections(
  lineage_id, base_generation, role, rel_path, path_order, section_cjson,
  PRIMARY KEY(lineage_id,base_generation,role,rel_path)
)
```

No `global_manifest_meta` row for the active singleton lineage/base generation
means `SyncState.manifestMeta` is absent. A row
maps every required field: `encManifestSha`, `manifestHash`, `accountEpoch`,
`keyEpoch`, `chainBytes`, and `snapshotBytes`; ordered `manifest_chain` maps
`chain`; role `meta-wire` maps required `gitRepos` (zero rows means `{}`). Both
hashes are lowercase hex64; epochs/chainBytes are nonnegative safe counters;
snapshotBytes is positive; chain is base-first, bounded, deduplicated,
self-excluding; `(chainBytes===0)===(chain.length===0)`.

`meta-wire` is the exact folded **wire** Git layer and is never derived from
local apply progress. `manifest-projection` preserves the imported
`lastSyncedManifest.gitRepos` shape for round-trip and diagnostic export.
`manifestFromMeta` reconstructs files/header plus `meta-wire` independently.
`manifestHash` covers that reconstructed manifest; it is not the state semantic
digest and covers no local RepoRecord sidecar.

### RepoRecord table and nested authority

```sql
repo_records(
  lineage_id, rel_path, path_order, repo_gen, source_seq,
  base_cjson NULL, advertised_cjson NULL,
  branch_base_origins_cjson NULL, pending_cjson NULL,
  repo_absent NULL CHECK(repo_absent=1),
  removed_key NULL, resolution_key NULL,
  cfg_synced NULL, cfg_applied NULL,
  cfg_token_cjson NULL, cfg_shape_cjson NULL,
  deferrals_cjson NULL, partial_cjson NULL, idx_proj NULL, extras_cjson,
  canonical_bytes, retained_estimate,
  PRIMARY KEY(lineage_id,rel_path)
)
legacy_state_maps(
  migration_id, field, rel_path, value_cjson,
  PRIMARY KEY(migration_id,field,rel_path)
)
```

There is exactly one `store_meta` row, exactly one `state_lineage` row, and its
id must equal `active_lineage_id`; a deferred FK plus open/commit assertions
enforce the creation-order cycle. Every meta/plane/repo row FK-chains to that
lineage. Multiple or zero lineage rows is structural corruption, not a stream
selection problem.

Frozen DDL supplies FK/UNIQUE/CHECK constraints for every enum, nonnegative
counter, true-or-absent boolean, role, plane, stage state, generation/head
relationship, optional joint-presence group, singleton completion/meta row, and
lineage ownership stated here. Fingerprint has a non-unique lookup index—never
a uniqueness assumption—because collisions are resolved by exact value/blob
comparison before reuse. Cheap-open validates the DDL fingerprint in addition
to SQLite's FK enforcement.

`source_shape_flags_cjson` is not a summary: its schema has an exact boolean
presence bit for source `stream`, every optional SyncState scalar/map,
`repoRecords`, `lastSyncedManifest.manifestSchema`,
`lastSyncedManifest.gitRepos`, and every optional known container whose empty
shape differs from absence. `legacy_state_maps` stores every raw member value,
including values ignored by current per-path RepoRecord precedence. Therefore
absent versus empty `{}` is reconstructible even when there are zero child
rows. The raw migration digest orders and covers both the flags and values.

Every `RepoRecord` field maps one-for-one: required `repoGen`/`sourceSeq` and
optional `base`, `advertised`, `branchBaseOrigins`, `pending`, `repoAbsent`
(true-or-absent), `removedKey`, `resolutionKey`, `cfgSynced`, `cfgApplied`,
`cfgToken`, `cfgShape`, `deferrals`, `partial`, and `idxProj`. A missing record
has logical `{repoGen:0,sourceSeq:0}`. NULL is field absence; an empty canonical
object is not NULL. Canonical blobs are authoritative rather than
`json_extract`-mutated because each admitted record is independently bounded
and its proofs must remain atomic (durable row count is not capped at 256).
`extras_cjson` on lineage/generation/meta/record preserves
currently tolerated unknown object members across migration and subsequent
spread-style updates; it never overrides a known typed field.

`canonical_bytes` and `retained_estimate` are recomputed from the complete
known+extras RepoRecord projection on every insert and CHECK-constrained to the
4 MiB and 16 MiB limits above; they are not caller claims. Migration verifies
every row, cheap open samples deterministic codec fixtures/fingerprint rather
than scanning all records, and a mismatch discovered on read is structural
corruption. The 256 wire-repository cap does not cap durable `repo_records` row
count.

The codecs preserve these nested fields completely:

- `GitSection`: `bundleSha`, `bundleEncSha`, `bundleCipherSize`, optional
  `bundleComp`/`bundlePayloadSha`/`packChain`; `head`; `refs`; optional
  `refTombstones`/`refTombstoneGeneration`; optional index sha/address/size/
  compression/payload/tree fields; optional `opState` and `config`; required
  `refScope` and `generatedAt`. Pack links/artifacts retain sha, encrypted sha,
  cipher size, compression/payload sha, and tips. Unknown members are retained
  because current whole-object spreads tolerate them.
- `BranchBaseOrigin`: all three v1 union shapes and their `oid`, `lineageHash`,
  kind, plus `episode` or `sourceSeq`+`incomingKey`. Positive origins remain
  branch-only and must match BASE OID.
- `ConfigStatToken`: `dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`; and
  `ConfigShapeIdentity`: `shape` plus common-dir `realpath`, `dev`, `ino`,
  `birthtime`.
- Each `GitDeferral`: `lane`, `deferredSince`, `reasonSince`, `lastSeen`,
  optional `subjectKey`, exact reason enum, optional checkout kind/label,
  optional `bytesChanged` and `reproof`, grouped by apply/capture/config lane.
- `GitPartialApply`: `incomingKey`, `checkoutPending`, every `appliedRefs`
  union/SafeRefWitness field, optional complete `pRepaired` receipts,
  `heldRefs`, `configApplied`, and optional `configBase`. A P-repair receipt
  retains version/kind/lineage/repository/ref/episode; P/K/Q/origin/skeep/
  reflog evidence; nested byte projections and observations; base disposition;
  and nullable eviction. Recovery proof is never summarized or dropped.

Compile-time `satisfies Record<keyof T,true>` maps cover `SyncState`, `Manifest`,
`FileEntry`, `GlobalManifestMeta`, `RepoRecord`, `GitSection`, and the nested
recovery types; fixtures exercise every union member and optional-presence bit.

### Complete SyncState mapping and legacy semantics

| `SyncState` field | Mapping/semantics |
|---|---|
| `stream` | completed lineage requires exact manifest stream; a pre-stamp source absence is recorded in `source_shape_flags_cjson` and adopted from fenced config exactly as current load semantics require |
| `lastSyncedSequence` | lineage scalar; nonnegative safe integer |
| `lastSyncedManifest` | active BASE generation header/files plus RepoRecord-derived Git projection; imported raw projection retained for round-trip |
| `manifestMeta?` | meta/chain/`meta-wire` rows above; wholly absent or wholly valid |
| `gitReposRemoved?` | imported to `legacy_state_maps`; runtime normalized to `repo_records.removed_key` |
| `gitNeedsResolution?` | legacy row; normalized to `resolution_key` |
| `gitPendingRemote?` | legacy row; normalized to `pending_cjson` |
| `gitDeferrals?` | legacy row; when `repoRecords` was absent, current locale-sorted/256-cap fold populates `deferrals_cjson` |
| `gitPartial?` | legacy row; same authoritative-absence and cap behavior into `partial_cjson` |
| `stateNonce?` | nullable lineage scalar; absence is legacy and CAS sentinel `legacy`; capable lineage is lowercase hex32 |
| `stateRevision?` | nullable lineage scalar; current invalid/missing-counter normalization to zero is versioned in import; accepted CAS increments once |
| `telemetryBindingId?` | nullable exact 16-hex local binding id |
| `repoRecords?` | source presence is retained as `source_repo_records_present` for exact migration round-trip; import folds absent legacy representation into rows, and all completed SQLite stores set `repo_records_authoritative=1`, so row field absence cannot fall back to ignored legacy maps |

Fresh state remains sequence 0 with generatedAt `""`, zero files, and absent
nonce/revision/records. If the old incarnation marker synthesized a fresh
nonce-bearing state, importer records that normalized semantic input explicitly.
Import computes the exact current key union of source `repoRecords`, manifest
`gitRepos`, pending, removed, resolution, and (only when the entire source
`repoRecords` property is absent) capped legacy deferral/partial maps. Precedence
is **per path**: if a saved RepoRecord exists at that path, it wins including
every field absence; a union key with no saved record is still synthesized from
manifest/pending/removed/resolution even when the source `repoRecords` map
exists. Legacy deferral/partial maps alone are globally ignored when that map
exists. Synthesized records get `repoGen=0` and
`sourceSeq=validCounter(lastSyncedSequence)`; saved invalid repo counters
normalize to zero exactly as today. The source-presence/value evidence
reconstructs admitted JSON for M4, but after completion there is one runtime
authority: all normalized `repo_records` rows with per-field absence final.

`origin_kind` is `migration` or `genesis`. Genesis uses the same staged DB +
sentinel authority publication, records absent source hash/digest/bytes and its
source-shape flags, and is still a complete store. Reset candidates preserve
the stable authority/completion identity but may omit bulky legacy import
evidence after its exact backup retention contract is met.

`legacy_state_maps` plus presence bits allow an independent SQL→source-shape
round-trip during M4, so no optional map can disappear undetected. They are
for migration evidence only and never a second steady-state authority. Runtime
projection derives manifest Git (excluding `repoAbsent`/removed), removed,
resolution, and pending from RepoRecords and clears deferral/partial legacy
maps exactly like `stateFromRepoRecords`.

### Narrow store operations and CAS semantics

- `openReadSnapshot()` captures and returns a logical `LineageSnapshot` token
  containing authority/lineage/base/local/header/meta scalars; it does **not**
  keep a read transaction open. Ordered `files(plane,afterPath,batchSize)`,
  `repos(afterRelPath,batchSize)`, coherent `repo(relPath)`,
  `metaGitRepoCursor()`, and `manifestGitRepoCursor()` each use one short transaction, assert the full token
  before and after the query, and close before returning. Every repo result
  carries `{lineageId,stream,nonce,stateRevision,baseGeneration,localRevision,
  repoGen}`; `snapshot-changed` invalidates every page already emitted and
  forces whole-projection retry/discard. `finishProjection()` performs one
  final fresh token assertion after the last page; no multi-page result may be
  published before it succeeds. No unscoped/racy generation read or cursor
  transaction survives a batch. A requested file count above 512 or repo/Git
  count above 16 throws typed `CursorWindowError` rather than clamping. Within
  an admitted count, paging stops before 4 MiB; one valid FileEntry estimated
  above 4 MiB (<=16 MiB) or RepoRecord above 4 MiB (<=16 MiB) is returned alone.
  The Git methods are cursors, never complete maps.
- `beginGeneration(plane,header)` creates an external stage DB; batched
  `putEntries`/`putGitSection`, `finishGeneration(expectedCounts)`, and
  `discardGeneration` manage it. A sealed stage owns ordered `files()` and
  `gitRepoCursor(role,afterRelPath)`/`gitRepo(role,relPath)` ports, including incoming plaintext
  `Manifest.gitRepos` when no GlobalManifestMeta exists. Only a sealed stage
  with the computed `SealedStageRef` proof above may enter a CAS; callers never
  supply the digest they ask the store to trust. Stage cursors use the same
  count/byte/single-row rules. `putEntries`/`putGitSection` automatically flush
  before the byte ceiling and process one valid oversize row alone; a caller
  batch above the count ceiling throws `CursorWindowError`. No larger window
  exists.
- `beginRepoTransitionStage(snapshotToken,sourceStageBindings)` creates another
  file-backed builder. `putTransition({relPath,expectedRepoGen,newRecord,
  baseProof?,evidenceBindings})` accepts bounded records in path order/unsorted
  batches; `finishRepoTransitionStage()` sorts, rejects duplicates, validates
  every proof/binding, and applies the same close/S0/logical+physical seal
  protocol. There is no transition-count cap: durable `repo_records` can exceed
  the 256-repo wire map. The transition digest covers snapshot token, ordered
  exact stage refs, every relPath/expected generation/complete new record,
  baseProof, and evidence binding. Its pre-materialization token scanner caps a
  complete transition row at 8 MiB canonical and 24 MiB estimated retained
  bytes (including `newRecord` + baseProof); rows over the 4 MiB batch estimate
  are processed alone. `TransitionRowOversizeError` occurs before sealing or
  authority writes.
- `ensureTelemetryBindingId(expectedStream)` is a separate singleton
  transaction: read or mint 16-hex id. It preserves `stateRevision`, matching
  current behavior.
- `snapshot.materializeManifest({plane,purpose,projectionToken})` is an
  intentionally loud coherent-snapshot API whose purpose is only
  `wire-snapshot` or `wire-delta`. Projection token binds the
  exact RepoRecord generation used to derive Git. Ordinary sync/status/Git code
  cannot call it. Legacy export instead uses `streamLegacyExport(sink,token)`,
  a 64 KiB framing buffer and ordered file/repo cursors; its 512 MiB output cap
  is enforced before atomic publication and it never builds a Manifest.

The mutation shape is exact rather than an untyped `global?`:

```text
applyCasPacket({
  expected: {lineageId,stream,nonce,stateRevision,baseGeneration,localRevision},
  sourceGlobalSeq,
  global?: {stage: SealedStageRef,fileHeader,manifestMeta?},
  repoTransitions: SealedRepoTransitionRef,
  ownerToken
})
```

The global ref names a file-only WIRE/REMOTE stage. Incoming stage Git has
already been consumed by the higher Git composer into concrete rows in the
transition stage and is never silently discarded. Its exact
`{stageId,logicalDigest,physicalSha256}` appears in the transition stage's
`sourceStageBindings` and in each derived record/baseProof evidence; a global
stage and Git transitions from different inputs cannot be paired. A repo-only
packet has an explicit empty source-stage list and is instead bound to its exact
snapshot token.

Before the authority transaction, the store verifies the transition ref and
**every** source-stage binding with the physical/logical protocol above; it
streams transition rows and, when global is present, its file rows into
connection-owned file-backed TEMP tables. Source stages used only as Git proof
are still fully reverified even though their rows need not be recopied. This is
the sole stable CAS input; no external stage is attached writable or reread
after `BEGIN`. `applyCasPacket` then uses
one `BEGIN IMMEDIATE` and preserves current packet semantics:

The higher engine/source composer performs sourceSeq/ordered-deferral/config-
authorship recomputation once and supplies a concrete complete `newRecord` per
transition. The store never repeats those merges. Inside the transaction:

1. Check all predicates before writes: exact active lineage, stream,
   stateRevision, baseGeneration, and localRevision; nonce (`legacy` matches absence only);
   if global is present reject only when
   `sourceGlobalSeq<lastSyncedSequence` (equality is allowed); every repo's
   exact expected generation from the transition TEMP table (missing row = 0);
   exact source-stage/snapshot/evidence bindings; and external lock ownership.
2. Recompose **only BASE** against its exact predecessor and required explicit
   `baseProof`; implicit migration proof is forbidden outside the tagged
   migration importer. If composition returns `pending`, the requested
   `newRecord.base` existed, and concrete `newRecord.pending` was absent, copy
   that requested BASE into `pending` exactly like today's safety hold.
3. Global present atomically SQL-set-diffs the sealed file-only stage into BASE,
   bumps its head, replaces header/manifestMeta/sequence, and writes only dirty
   authority rows. Global absent preserves all four. Git projection is rebuilt
   from resulting RepoRecords.
4. Stream the ordered transition TEMP table and replace each RepoRecord as one
   value, never collecting the packet in JS; set `repoGen=expected+1`.
   `sourceSeq`, ordered deferrals, and config authorship are the already-
   recomputed concrete values.
   Mint a 32-hex nonce iff absent. Increment `stateRevision` exactly once for
   every accepted packet, including an otherwise empty one.
5. Recheck lock ownership immediately before commit. Loss/mismatch rolls back
   all global and repo changes.

Results never return a complete `SyncState` or touched-record map. On rejection,
the store builds a token-coherent, sealed file-backed `CasRetryView` by ordered-
joining transition paths to current records; it exposes
`touchedRepos(afterPath)` with the same 16-record/4 MiB, single-record-16 MiB
window and includes fresh lineage/head scalars. If the token changes while
building it, return `busy` rather than a torn retry view. The existing at-most-
three recompute loop pages that view into a new transition stage. Accepted
returns only fresh bounded scalars/token. Result kinds remain `accepted`, whole-packet `rejected`
(`lineage|stream|nonce|state-revision|base-generation|local-revision|repo-generation|global-sequence|owner-lost`), `busy`, or
`unsupported`; no rejection rematerializes global files/maps.

This packet is the only multi-repo/global mutation seam. Git planning uses
individual lookups/cursors; only outgoing wire composition intentionally
materializes the complete <=256 `gitRepos` map.

### Digest scope

`digest/state-semantic-v1` owns migration/doctor/export semantic framing and
streams rows; it never supplies reset O/N. A full semantic digest is not
recomputed on every row-local transaction—that would recreate O(N) writes.
`GlobalManifestMeta.manifestHash`, migration semantic digest, DB physical reset
hash, and backup file hash are four deliberately distinct types and APIs.
The digest orders every path and repository by stored UTF-16BE `path_order` and
covers source presence flags, raw legacy-map values (including ignored ones),
typed optional presence, extras blobs, and normalized authority rows. It never
uses database rowid or ambient collation.

### Vertical/module ownership and antislop discipline

```text
src/cli/state-plane/
  index.ts                  public facade only
  ports.ts                  store/migration admin ports only; no engine DTO copy
  errors.ts                 typed authority/migration/integrity errors
  store/
    open.ts                 connection ownership + pinned pragmas
    read-snapshot.ts        lineage/file/repo cursors
    write-packet.ts         one atomic global+multi-repo CAS
    generations.ts          staging/promotion/GC
    transition-stages.ts    sealed CAS inputs + cursor retry views
    operation-plans.ts      sealed pull/push outcomes + receipt/oracle tables + lease/GC
    local-plane.ts          scan set-difference/watcher transactions
  schema/
    application.ts          ids/version/DDL fingerprint
    v1.ts                   DDL only
    validate-open.ts        cheap open invariants
  migration/
    authority.ts            M0-M7 classifier/state machine
    import-json.ts          guarded field-complete import
    finalize.ts             backup + sentinel authority flip
  digest/
    state-semantic-v1.ts    typed streaming state digest
    stage-semantic-v1.ts    sealed file/Git stage identity
    repo-transition-v1.ts  sealed transition/evidence identity
    manifest.ts             ordered manifest digest adapters
    codecs.ts               length framing/canonical blobs
  backup/
    vacuum-into.ts          staged bounded snapshot
    publish.ts              verify/fsync/rename/cleanup
  cache/
    open.ts                 rebuildable cache-v2 connection/retirement
    hash.ts                 point hash hints + ordered prune
    directories.ts          directory/child cursors + rule inventory
    encrypt-address.ts      context-bound address/path ownership rows
    tracked-paths.ts        streamed Git index membership/prefix generations
    ignore-rules.ts         file-backed nested-rule generations/evaluation
  codecs/
    file-entry.ts           exhaustive FileEntry codec/order key
    repo-record.ts          exhaustive bounded RepoRecord/Git proof codec
  adapters/
    projections.ts          status/drift/file/Git bounded cursors
    planning.ts             scan/reconcile/apply/push + receipt/oracle cursor bridges
    outcomes.ts             disposable pull/push outcome handles
    wire.ts                 five ledger-admitted wire materializers
  engine-adapter.ts         adapter facade only; no whole-state fallback
src/engine/state-port.ts    sole canonical SQLite-free engine DTO/cursor/receipt ports
src/cli/reset-journal-codec.ts  sole bounded exact reset-journal decoder
src/cli/reset-namespace-inventory.ts  journal-independent bounded reset DB inventory
```

The receipt/oracle ownership additions and inventory module split above are
the r3 C5/C4 fold sites; they add no engine SQLite import and no reset consent
ownership to the store.

Reset consent/journal/ref choreography stays in the existing reset modules and
receives a candidate-store builder; `store` must never absorb it. `schema` owns
no runtime policy, `migration` owns no general queries, `digest` owns no file
publication, `backup` owns no authority choice, and `engine` imports no
`bun:sqlite`.

`engine-adapter.ts` implements `src/engine/state-port.ts`; it does not redefine
those types. Production files target <=300 nonblank lines; 400 lines or 25 KiB
is a hard CI guard failure (301–399 requires an explicit review note). Generated DDL/field maps may receive a
documented size exception but remain behavior-free. Tests sit beside each
module. Every new/changed module under CODEMAP-governed trees adds/updates its
one-line ownership rule in `docs/CODEMAP.md` in the same change.

## R1 closure index (v4)

| R1 finding | Normative closure in v4 |
|---|---|
| f1 reset protocol | File-swap keystone, sole bounded exact codec/inventory, J0/W1/W2/W3 and complete P/R/I/Z correlated table; transactions are only between commit points. |
| f2 exact witness/backup | Closed `S0` physical O/N hashes, exact journal-carried candidate bytes, byte-exact reset archive, staged `VACUUM INTO` only outside standing-journal restore evidence. |
| f3 engine memory | Stable BASE/LOCAL rows; tracked-path index; sealed REMOTE/WIRE/plan/transition/outcome/receipt stages; complete adapter budget table; construction-peak-admitted wire wall. |
| f4 migration crash state | Monotone M0–M7 durable high-water witnesses, artifact-ahead plus retirement/cleanup intent correlations, phase-preserving halts, and one protocol actor. |
| f5 downgrade split brain | Exact non-JSON `Q` at the legacy path plus bake-release refusal before every old read/write; no automatic downgrade. |
| f6 512 MiB/ENOSPC | Unchanged 52x/512 MiB admission, advisory disk budget, every M1–M7 ENOSPC branch, immutable backups, and typed durable-or-in-process non-looping halt. |
| f7 field completeness | Exhaustive SyncState/Manifest/FileEntry/GlobalManifestMeta/RepoRecord/nested-proof schema, presence/extras codec, semantic round trip, plane/head keys. |
| f8 WAL durability | Verified WAL/FULL pragmas, connection/cache topology, checkpoint thresholds, write backpressure, S0 boundary rules, process-kill/power-cut gates. |
| f9 open cost | Cheap identifiers/DDL/completion/lineage only; full integrity and FK checks are migration/doctor/suspected-corruption/opt-in maintenance work. |
| f10 status claim | <200 ms applies only to trusted daemon status; unsettled parse/scan/diff/Git components are measured separately. |
| f11 store/CAS | Logical lineage token and ordered plane/repo cursors; physically+semantically sealed global/transition inputs; atomic global+multi-repo CAS; cursor retry view. |
| f12 isolate ownership | Database/statement/transaction/cursor lifetime is confined to one Bun isolate; workers receive immutable DTOs only. |
| f13 Layer B wording | Daemon-owned incremental manifest is acknowledged; only CLI-to-daemon delegation is described as unbuilt. |

`SYNTHESIS-163-R3.md` accepted the localized round-3 findings and ordered C1–C9.
V4 folds those rulings and remains pending final serial review; no orchestrator
ratification or implementation authority is claimed.

V5 adds only the final-review closures: exact retained 1.7.x candidate/archive
names are bounded, no-follow, inert members of the journal-independent reset
inventory, and the C2b pair now has durable absent/building/exact preparation
rows plus one immutable halted-M6-to-M7 retry. The file-swap boundary, closed
O/N witness, standing-journal no-open/W2-before-decode rule, Q authority flip,
terminal-control-last rule, and 2.0-only confinement are unchanged. V5 remains
pending final ratification and is not implementation authority.
