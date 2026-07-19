# 163 — The state plane moves to SQLite

Status: DRAFT v2 PROPOSAL — r1 verdict was CHANGES-REQUIRED (13 findings,
5 CRITICAL). This revision answers the complete five-point revision list and
the founder's v2 keystone ruling; it is not implementation authority until the
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
   path measures 0.84 s (162 r1 evidence).
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
  Quarantine and general backup snapshots use staged `VACUUM INTO`; reset's
  byte-exact protocol artifacts retain their separately specified copy path.
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
U0 entry interning/immutable structural sharing (independently shippable);
U1 store/schema/digest/backup modules and read-only adapters; U2 ordered
scan/reconcile/apply/push ports plus generation-CAS writes; U3 migration and
the old-reader barrier; U4 138 DB-artifact reset/quarantine flows; U5 fleet
bake with component telemetry. Default-on is allowed only after U4 review and
the barrier-compatible bake release; rig scenarios run migration from real
pre-163 states and every injected boundary below.

## Acceptance targets (measured, not promised)
- Trusted `rbox status` with live daemon: < 200 ms on the 112k corpus. The
  unsettled fallback is reported separately as baseline-load, scan, diff, and
  Git-divergence components; it has no <200 ms promise.
- Record peak live `FileEntry` objects, SQLite cache, wire buffers, and RSS on
  the same corpus. Pass/fail is the explicit budgets below, not an unsupported
  promise that the entire historical multi-GB slope vanishes.
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

## v2 keystone: file-swap at reset boundaries, transactions in between (r1 f1+f2)

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
- Quarantine/backup snapshots use `VACUUM INTO` (available, bounded, no
  O(size) buffer — replaces the withdrawn Database.serialize idea, r1 f2).

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
- The journal keeps authorization record v2 but gains required
  `stateFormat:"sqlite/v1"`, `authorityId`, and application/schema ids. Its
  `old` descriptor carries `{stream,stateNonce,stateRevision,stateSha256}`;
  `next` carries the same tuple plus exact `dbBytesB64`. Archive baseline and Z
  entries retain design 138's fields/order. A pre-migration JSON-state journal
  is recovered before M0 under JSON authority; such a journal beside `Q` is a
  format mismatch and halts. On the SQLite branch, `authorityId` must equal the
  32-hex id in exact `Q`, and the application/schema ids must equal the compiled
  v1 constants; mismatch halts before any artifact hash is actionable.
- This is an explicit exact-schema branch of reset journal v2, not a tolerant
  extension. The journal decoder first applies the existing 512 KiB bounded
  read and duplicate-key rejection, then selects exactly one closed key set:
  legacy JSON-payload v2 or `stateFormat:"sqlite/v1"`. Unknown discriminator,
  missing/extra key, a SQLite key on the legacy branch, or a legacy payload key
  on the SQLite branch halts. The bake/old binary consequently cannot
  misinterpret a SQLite reset journal; its exact-key parser rejects it before
  mutation. Doctor and quarantine use this same decoder and byte limits rather
  than a second permissive schema.
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
  cap, and base64 plus the remaining record must fit the existing 512 KiB
  `MAX_JOURNAL_BYTES`; exceeding either is a pre-P0 design/version refusal, not
  permission to raise a reset read bound implicitly. The authorized prepared journal carries both
  `next.stateSha256` and the exact `next.dbBytesB64`. The exact-key journal
  parser requires canonical padded base64, decoded length <=256 KiB, complete
  journal bytes <=512 KiB, and `sha256(decoded)===next.stateSha256` before any
  candidate write; unknown/missing SQLite-next keys halt. Recovery writes those
  authenticated bytes to create/re-create the canonical candidate. A private
  temp crash is inert, never an artifact-axis value, and is removable only by
  the existing positively identified temp-file discipline.
- Quarantine's bundle manifest records the exact reset-journal hash/length and,
  for the SQLite branch, decoded candidate length/hash; doctor never expands
  base64 until the complete journal has passed the 512 KiB bound and never
  emits decoded bytes over 256 KiB. Recovery, doctor, quarantine, and tests
  import one parser constant/schema so a cap or field change cannot skew them.
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

Every P/R/I/Z row below requires `Q` exact and **`S0` for active, candidate,
and archive paths**, including when the corresponding main file is absent.
Thus the table enumerates every admitted main-file/sidecar signature; no
sidecar cross-product is implicit.

### Gates before the row table

The recovery implementation preserves design 138's two-pass fence order:

1. **Pure preflight:** bounded-read exact `Q`, freshly read durable config, and
   journal bytes/identity. Observe sidecars before parse so a present journal+
   sidecar can halt W2 without opening a DB. With `S0`, parse the journal,
   require state format/authorization/config eligibility, verify the Z identity
   descriptors, and perform a complete read-only physical classification.
2. Derive the canonical repository recovery requests from that validated Z set;
   acquire the workspace mutex and repository fences in canonical order with
   the state/store lock last. For W1 (no journal), acquire only the ordinary
   single-writer/state ownership required for takeover.
3. **Held-fence authority pass:** close every DB handle owned by this isolate,
   then freshly reread `Q`, durable config, journal bytes+identity, repository
   identities, sidecars, all main hashes, marker, recovery refs, and active-ref
   groups. Re-run the complete classifier. Journal identity/Z-set change means
   release and restart fence derivation; no action runs under a fence derived
   from different bytes.
4. Only the held-fence pass may return W1/P/R/I/Z as actionable. Malformed,
   legacy-v1, wrong state format, unauthorized witness, third stream, missing
   `Q`, or any unlisted correlation halts.

Both classifications are read-only. Sidecar lstat identities are bracketed
before and after every main-file hash; appearance/disappearance/change restarts
classification (or W2 under a standing journal). No bounded query, `PRAGMA`,
logical digest, integrity check, checkpoint, or cleanup is allowed during
observation.

### WAL/sidecar rows W1 and W2

| Row | Reset journal | Complete admitted signature | Action |
|---|---|---|---|
| **W1 — ordinary SQLite crash takeover** | absent | `Q` exact; active main is a regular file; active sidecars are exactly `SW`; there is no rollback journal. Every discovered reset-candidate/archive DB is `S0`; its main bytes are inert and neither adopted nor deleted by this row. | Only the owning writer may open active. Let SQLite perform ordinary WAL recovery; perform the cheap application/schema/authority/lineage checks below; verify WAL/FULL; require a non-busy `wal_checkpoint(TRUNCATE)`; close; require active `S0`; fsync the DB and its parent; recheck exact `Q` and journal absence before normal work. SQLite recovery failure is a typed corruption halt. Never delete a suspect WAL to force progress. |
| **W2 — sidecar under a standing reset journal** | present, valid or malformed | `Q` exact; active/candidate/archive sidecar vector is any value other than `(S0,S0,S0)`, including `SW` and `other`. Main hashes are not interpreted while any sidecar exists. | **Halt, zero writes.** Do not open any DB, replay/checkpoint WAL, remove a sidecar, repair an artifact, touch refs, or enter a P/R/I/Z action. Report every observed path/type. The journal governs, and P0 promised at-rest files. |

No-journal + exact `Q` + a valid authoritative regular active DB + active `S0`
is ordinary steady state and needs no W row. With no journal, invalid/missing
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
not printed as one complete row. A classifier test injects a deviation on every
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
changing sidecars for each active/candidate/archive position.

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

This unit ships before SQLite and is useful independently. `FileEntry` values
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
generation reference rather than mutating an alias.

U0 is deliberately transitional: its fingerprint index is O(unique live
entries), and it ships before SQLite to remove duplicate object graphs and
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

The current `HashCache`, `DirCache`, and `EncryptAddressCache` each load a
workspace-sized JSON object/`Map`; DirCache also retains child arrays and
EncryptAddressCache retains a reverse `pathOwner` map. They do not survive U2
in that form. Their replacement is one independent
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

The old three cache JSON files are not parsed or migrated on U2 startup—that
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
uses ordered joins. In-memory LRU caches have explicit fixed entry and byte
caps. A code/test inventory rejects an N-sized `Set`/`Map`/array in scan,
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
6. Record receipts in the plan. `oracleFromPull` reads BASE/LOCAL/REMOTE plus
   receipt cursors. Partial apply never adopts REMOTE; the next scan/pull heals
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

### Normative materialization budget and unavoidable wire allocations

Outside named wire adapters, no production array/map/set may scale with total
manifest entries. Scanner budget is one `opendir` page, 16 hash jobs, and a
512-entry/4 MiB insert batch. Reconcile is three current rows plus one such
batch. Apply is the configured concurrency window capped at 512 actions or
8 MiB of metadata, whichever comes first; blob bodies remain disk-streamed.
Non-wire Git state uses the 16-record/4 MiB window with a single-record 16 MiB
maximum; 256 is only the wire repository-count cap. Authority SQLite caches total at most 40 MiB in the
daemon and the rebuildable cache DB adds 8 MiB only while a cache operation is
active.
At 200k entries, non-wire manifest metadata must add <64 MiB JS heap and the
test records peak live entry/action objects.

These current wire peaks are explicit exclusions, measured rather than
credited to SQLite:

- inbound latest/snapshot can retain ciphertext, decrypted/decompressed body,
  parsed `Manifest`, and `validateManifest`'s exact-path set, lowercase-path
  set, and lowercase-path array before REMOTE staging;
- inbound delta can additionally retain BASE, parsed D operations, the fold's
  BASE file/repo maps and seen-operation set, the folded result, canonical-hash
  bytes/workspace, and the same validation collections. The history fold LRU
  is count-capped at two complete authenticated manifests and is cleared before
  an uncached fold, but count does not bound bytes;
- snapshot commit retains the target manifest, `gitRepos` object,
  `validateManifest` collections, the unique-`encSha` blob-ref map and array,
  optional serialized refset sidecar, canonical JSON/JCS string/UTF-8,
  envelope/compression buffers, encrypted manifest, and signed commit body;
- delta commit currently retains BASE+target manifests, two N-sized file maps,
  repo maps, D operations and their sorted array, validation collections,
  blob refs/refset, and encoding/compression/encryption buffers. If delta loses
  its size comparison, the rejected delta buffers may coexist transiently with
  the fallback snapshot encoder until the local is nulled/released; U2 makes
  that lifetime explicit and measures it;
- upload/refset construction and commit retry currently return N-sized
  `blobRefs`, `uploaded`, `needsUpload`, audit-`seen`, and address-dedup
  collections. Before U2 leaves the wire adapter they move to the candidate
  stage tables; only the final signed-protocol `blobRefs` array/refset bytes
  remain an unavoidable full wire allocation.

The existing envelope plaintext ceiling is 512 MiB. The declared 64 MiB
`MAX_MANIFEST_BYTES` was not previously an effective serialized admission at
every call site; U2 makes it an explicit outgoing pre-materialization cursor
count and a post-serialization assertion, and applies the same 64 MiB logical
manifest limit after authenticated inbound decode. This can refuse a
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
record; `P/F` means incomplete/unreadable/foreign DB. Neither a completion row
nor a backup elects authority by itself.

| Legacy path | Active DB | Control | Authority and M0 action |
|---|---|---|---|
| `L` | absent | absent | JSON authority; eligible to begin M1. |
| `L` | absent | exact | JSON authority; after source revalidation, resume recorded M1–M4 or M5 with an exact complete id-bound staging DB; a changed source retires only identified artifacts and restarts with a new id. |
| `L` | `C` | exact | JSON authority; resume M5/M6 after source-hash and completion revalidation. |
| `L` | `C` | absent/foreign | JSON authority but reserved-path halt; a complete orphan is not adopted or automatically deleted. |
| `L` | `P/F` | any | JSON authority plus reserved-path/corruption halt; delete only if an exact control identity proves an incomplete id-scoped staging artifact, never an unknown active path. |
| exact `Q` | matching `C` | absent/exact | SQLite authority; run W1 if applicable, then M7 cleanup only. |
| exact `Q` | absent/`P/F`/wrong authority id | any | contradictory authority; hard `StateAuthorityCorruptError`, zero repair writes. |
| absent | absent | absent | No authority. Genesis is allowed only with fenced config/incarnation/reset evidence and uses staged DB + `Q`; otherwise halt. |
| absent | any DB | any | Ambiguous/manual damage; halt. DB presence never elects authority. |
| malformed JSON, non-exact sentinel, special/unreadable legacy path | any | any | Halt before DB open or cleanup. |

A normal `L` plus exact immutable/fixed backups does not change a row. Backup
absence/mismatch affects migration admission and doctor evidence, never which
live representation wins.

### Migration artifacts and completion witness

- Durable control: `.rbox/state/migration-v1.json`, containing version,
  `migrationId`, source path/hash/size, authority id, staging path, phase, and
  optional typed halt. It is state-machine coordination, never authority.
- Staging DB: `.rbox/state/state.db.migrate.<migrationId>` plus only its own
  temporary sidecars.
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

### Ordered phases

Migration runs only after standing-reset recovery, under the non-degraded
workspace mutex, complete repository fence as needed, and state lock:

1. **M0 — classify.** Bounded-read legacy path first. Apply the authority
   matrix below; never create a DB merely because the path is absent.
2. **M1 — admit and intend.** Hash/identity-bracket source JSON; apply design
   161's unchanged 52x admission, 512 MiB hard cap, RSS/cgroup budget; perform
   advisory `statfs`. First validate/claim the bake release's fsynced 1 MiB
   generic reserve when present, or attempt to create it before any other
   migration artifact. Then write/fsync control and an id-bound emergency halt
   candidate. Failure here leaves JSON authority and enters the in-process
   non-looping halt rules below; durable halt is promised only if control or
   the reserve can actually be published.
3. **M2 — preserve source.** Ensure the current source exists at its immutable
   hash-addressed history path, by verified hard link when supported or bounded
   streaming copy to an exclusive temp. If the fixed `.bak` is absent or exact,
   publish/reuse it. If it is a different valid regular backup, first link/copy
   it into its own verified history path, fsync that path and directory, then
   atomically replace the fixed path with the current exact source and fsync
   `.rbox`. No unique backup bytes are overwritten or deleted. A special,
   unreadable, or unverifiable fixed/history path is a reserved-path halt.
4. **M3 — build.** Guarded-parse source once, compute its semantic stream, open
   the exclusive staging sibling, set/verify pinned pragmas/schema, and import
   all planes/records in one transaction. Insert the completion row last and
   commit. Any rollback/`SQLITE_FULL` leaves no complete record.
5. **M4 — close and prove.** `wal_checkpoint(TRUNCATE)`, require non-busy,
   close, require all staging sidecars absent, reopen read-only, recompute the
   SQL semantic stream/counts, validate application/user/DDL ids,
   `foreign_key_check`, and full `integrity_check`, close, fsync DB and state
   directory.
6. **M5 — publish prepared DB.** Revalidate source and control, atomically
   rename the complete staging DB to `state.db`, and fsync `.rbox/state`.
   JSON is still authority.
7. **M6 — flip authority.** Build/fsync an exact `Q` sibling. Rehash and
   identity-revalidate live JSON and `.bak`, revalidate the active completion
   record, atomically rename `Q` over `.rbox/state.json`, then fsync `.rbox`.
   This one rename has no absent-state window and is the only authority flip.
8. **M7 — finish.** Remove control/emergency/private staging artifacts with
   identity-scoped cleanup and parent fsync. Failure here does not undo DB
   authority.

### Crash, disk-full, and resume table

| Failure/crash point | Durable interpretation on restart | Required action |
|---|---|---|
| Before/during M0 | Normal JSON; no complete prepared DB | JSON authority; no DB adoption and no write. Read failure is reported, not migration. |
| M1 reserve/control/emergency creation, write, rename, or fsync, including ENOSPC | Normal JSON; zero or exact id-bound control artifacts | JSON authority; delete only identifiable temp if possible. Publish durable `filesystem-full` halt from reserve if possible; otherwise keep the daemon alive in an in-process halt. Never claim durable suppression when its fsync failed. |
| M2 history/fixed-backup link, copy, rename, or fsync, including ENOSPC | JSON exact; immutable history absent/temp/exact; fixed backup absent/exact/valid-prior/foreign | JSON authority. Delete only migration-id temp. Resume exact artifacts. Preserve a valid prior fixed backup under its hash before replacing it; foreign/special/unverifiable path halts. |
| M3 before completion commit, including `SQLITE_FULL`/ENOSPC in any table/index | JSON exact; staging incomplete or transaction rolled back | JSON authority. Close and remove only intent-recorded staging+sidecars when identity is proven; enter typed `filesystem-full` halt. A completion row cannot survive without its data transaction. |
| M3 after commit, or M4 checkpoint/verify/fsync, including ENOSPC | JSON exact; complete staging | Preserve the complete staging artifact; reopen without authority and rerun all M4 proofs after remediation. Any mismatch halts; never “repair complete.” |
| M5 rename or parent fsync, including ENOSPC | JSON exact; complete DB is at staging or active path; parent durability may be indeterminate | JSON remains authority. Reclassify both paths/control without moving the DB backward. Matching complete artifact resumes; incomplete/foreign active DB is a reserved-path collision and halts without overwriting JSON. |
| After M5 while JSON engine ran under kill switch | JSON hash differs from completion source hash | JSON wins. Retire only the matching intent-owned prepared DB and rebuild under a new migration id; never publish its stale `Q`. |
| M6 sentinel-temp creation/write/fsync or final source/backup recheck, including ENOSPC | JSON exact; complete active DB prepared | JSON authority; clean exact temp if possible or resume after remediation. No partial sentinel is authority. |
| Crash/ENOSPC at M6 sentinel rename or parent fsync | Legacy path is atomically either original JSON or exact `Q`; directory durability may be indeterminate | Re-read without inference: JSON ⇒ JSON authority/resume M6; exact `Q` + matching complete DB ⇒ DB authority but remain in `durability-indeterminate` health until a parent fsync succeeds; anything else ⇒ typed authority-corruption halt, zero writes. Never rename JSON back over `Q`. |
| After `Q`, before/during M7, including unlink/fsync ENOSPC | `Q` + matching complete DB; optional stale control/reserve | DB authority; cleanup is idempotent and deferred. Record `cleanup-deferred` health if possible, but do not rerun migration or fall back to JSON. Missing backup is a doctor warning, never fallback. |
| `Q` + absent/incomplete/foreign/corrupt DB | Contradictory authority | Hard `StateAuthorityCorruptError`; never restore/use JSON backup automatically. |
| Neither JSON nor `Q`, with a DB present | Ambiguous/manual damage | Halt. DB presence never elects authority. Genesis requires config/incarnation/reset-artifact proof and uses the same staged+sentinel publication. |

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
in M1–M7 handles ENOSPC as its row above.

`StateMigrationHaltError` has stable reasons `source-oversize`,
`memory-admission`, `record-oversize`, `disk-preflight`, `filesystem-full`, `source-changed`,
`verification`, `reserved-path`, `durability-indeterminate`, and
`cleanup-deferred`, plus phase, underlying syscall/SQLite code, source,
required, available, `durableHalt:boolean`, and cleanup-safe paths.
`SQLITE_FULL` maps to `filesystem-full` while retaining its original code.
Guard refusal happens before staging and leaves JSON untouched. Before
disk-intensive work, M1 prefers the bake release's generic reserve, and
releases/unlinks it before publishing an exact typed halt. That creates a
strong recovery opportunity, not a false guarantee: the halt is durable only
after its file and parent fsync succeed. If reserve creation/release or halt
publication itself fails, `durableHalt=false`; the process keeps the typed halt
in memory and performs no more migration writes.

The default-on daemon catches this error, remains alive in a
`migration-halted` health state, suppresses every subsequent pump migration
attempt for that process, and serves status/doctor. A successfully fsynced
halt also suppresses startup attempts across processes; a non-durable halt may
try once on a later explicit process start but never hot-loops or exits into a
supervisor retry cycle. Only explicit
`rbox doctor --retry-state-migration` after remediation clears the halt, or
`RBOX_STATE_SQLITE=0` continues the JSON engine while JSON is still authority.
`cleanup-deferred` after `Q` is cleared only by cleanup/doctor, not by rerunning
M0. Source JSON and every unique exact backup are never deleted on failure.

Fault injection covers before/after every transaction/table/commit/checkpoint/
close/verify/rename/fsync, OS ENOSPC and `SQLITE_FULL` at every M1–M7 write
class (including reserve/halt publication and cleanup), hard-link fallback,
valid-prior and foreign backup collisions, exact admitted/refused 512 MiB and
>512 MiB, source mutation before M6, stale/foreign DB/control, repeated kill-
switch JSON advances with immutable backup history, marker durability
ambiguity, minimum/maximum RepoRecord codec admission, non-durable in-process
suppression, and old-binary read/write refusal.

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
  extras_cjson, UNIQUE(entry_id,path,path_order)
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
  `repos(afterRelPath,batchSize)`, coherent `repo(relPath)`, `metaGitRepos()`,
  and `manifestGitRepos()` each use one short transaction, assert the full token
  before and after the query, and close before returning. Every repo result
  carries `{lineageId,stream,nonce,stateRevision,baseGeneration,localRevision,
  repoGen}`; `snapshot-changed` invalidates every page already emitted and
  forces whole-projection retry/discard. `finishProjection()` performs one
  final fresh token assertion after the last page; no multi-page result may be
  published before it succeeds. No unscoped/racy generation read or cursor
  transaction survives a batch.
- `beginGeneration(plane,header)` creates an external stage DB; batched
  `putEntries`/`putGitSection`, `finishGeneration(expectedCounts)`, and
  `discardGeneration` manage it. A sealed stage owns ordered `files()` and
  `gitRepos(role)`/`gitRepo(role,relPath)` ports, including incoming plaintext
  `Manifest.gitRepos` when no GlobalManifestMeta exists. Only a sealed stage
  with the computed `SealedStageRef` proof above may enter a CAS; callers never
  supply the digest they ask the store to trust.
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
  `wire-snapshot`, `wire-delta`, or `legacy-export`. Projection token binds the
  exact RepoRecord generation used to derive Git. Ordinary sync/status/Git code
  cannot call it.

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
  codecs/
    file-entry.ts           exhaustive FileEntry codec/order key
    repo-record.ts          exhaustive bounded RepoRecord/Git proof codec
  engine-adapter.ts         narrow ports only
src/engine/state-port.ts    sole canonical SQLite-free engine DTO/cursor ports
```

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

## R1 closure index

| R1 finding | Normative closure in v2 |
|---|---|
| f1 reset protocol | File-swap keystone plus complete W/P/R/I/Z correlated table; transactions are only between commit points. |
| f2 exact witness/backup | Closed `S0` physical O/N hashes, exact journal-carried candidate bytes, byte-exact reset archive, staged `VACUUM INTO` only outside standing-journal restore evidence. |
| f3 engine memory | Stable BASE/LOCAL rows, sealed external REMOTE/WIRE/plan/transition stages, ordered cursors, pre-apply barrier, ancillary cache DB, bounded arena/records, and enumerated wire wall. |
| f4 migration crash state | M0–M7 sibling-build/completion/prove/publish/Q state machine and exhaustive authority/resume tables. |
| f5 downgrade split brain | Exact non-JSON `Q` at the legacy path plus bake-release refusal before every old read/write; no automatic downgrade. |
| f6 512 MiB/ENOSPC | Unchanged 52x/512 MiB admission, advisory disk budget, every M1–M7 ENOSPC branch, immutable backups, and typed durable-or-in-process non-looping halt. |
| f7 field completeness | Exhaustive SyncState/Manifest/FileEntry/GlobalManifestMeta/RepoRecord/nested-proof schema, presence/extras codec, semantic round trip, plane/head keys. |
| f8 WAL durability | Verified WAL/FULL pragmas, connection/cache topology, checkpoint thresholds, write backpressure, S0 boundary rules, process-kill/power-cut gates. |
| f9 open cost | Cheap identifiers/DDL/completion/lineage only; full integrity and FK checks are migration/doctor/suspected-corruption/opt-in maintenance work. |
| f10 status claim | <200 ms applies only to trusted daemon status; unsettled parse/scan/diff/Git components are measured separately. |
| f11 store/CAS | Logical lineage token and ordered plane/repo cursors; physically+semantically sealed global/transition inputs; atomic global+multi-repo CAS; cursor retry view. |
| f12 isolate ownership | Database/statement/transaction/cursor lifetime is confined to one Bun isolate; workers receive immutable DTOs only. |
| f13 Layer B wording | Daemon-owned incremental manifest is acknowledged; only CLI-to-daemon delegation is described as unbuilt. |

The adversarial v2 pass recorded in `REVIEW-163-R2.md` reached alignment in
the crash/reset, schema/CAS, and engine/migration slices. Orchestrator
ratification remains the proposal gate.
