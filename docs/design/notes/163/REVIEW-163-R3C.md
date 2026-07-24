# Design 163 v3 adversarial review — round 3, holistic-coherence lens (R3C)

Lens: internal consistency, keystone preservation, implementability, problem-fit,
rollout. The decoder/crash and budgets/migration specialists cover their depth;
this review attacks what falls between sections after the +690/−151 fold. Current-
behavior claims were checked against `src/cli` and `src/engine`. FOLD notes were
not trusted.

## Findings

### 1. MAJOR — The keystone summary says quarantine uses `VACUUM INTO`; the normative section forbids exactly that on the standing-journal path.
Section: "Keystone" bullet (`:206`) vs "Required publication order and backup
boundary" (`:536-550`).

`:206` states, as part of the elevated authoritative RULING: "Quarantine/backup
snapshots use `VACUUM INTO` (available, bounded, no O(size) buffer)." But the
normative publication-order text is the opposite for quarantine: while a reset
journal stands, quarantine "treats journal/candidate/archive as opaque files"
using "byte-exact bounded bundle copies," and "never opens a canonical active/
candidate/archive DB while that journal stands... Thus a quarantine crash cannot
manufacture W2" (`:536-543`). `VACUUM INTO` is a SQLite operation that opens the
source DB and can create `-wal`/`-shm` sidecars — precisely the W2 crash-window
signature the detailed section is engineered to avoid. `VACUUM INTO` is correctly
reserved for (a) the *post*-quarantine optional diagnostic snapshot and (b)
general backup (`:546-550`), never the in-journal quarantine bundle.

Why it matters for this lens: the keystone is described as the byte-for-byte
authoritative ruling the whole design defers to. An implementer building the
quarantine path from the keystone bullet alone would open the canonical DB and
break the W2 no-manufacture invariant that findings W1/W2 exist to protect.
Rewrite `:206` to scope `VACUUM INTO` to general backup and the post-quarantine
diagnostic, and to state that standing-journal quarantine uses byte-exact copies.

### 2. MAJOR — The decoder's 128 KiB aggregate-string cap may be too small for the 256-repo maximum the rest of the design supports, regressing reset on large-repo workspaces.
Section: "One bounded exact reset-journal decoder" (`:308-309`, `:388-391`) vs
`MAX_GIT_REPOS=256` (`:984`) and acceptance target (`:126`).

The decoder admits "256 `old.z` elements" and "128 KiB total decoded UTF-8 for
all non-`dbBytesB64` string values" (`:308-309`). Each `old.z` element carries
`lineageHash`(64) + `repositoryIdentityHash`(64) + `targetOid`(40) fixed hex,
plus `activeRef`/`recoveryRef` (<=192 ASCII each, `:390`) and a
`repositoryIdentity` with `relPath`/`worktreeId`/`gitDirReal`/`commonDirReal`
strings. Realistic per-element string weight is ~530-600 bytes; at the design's
own 256-element ceiling that is ~135-155 KiB — over the 128 KiB aggregate cap.
Journal creation feeds bytes back through `decodeResetJournal` and treats any
aggregate-string overflow as "a pre-P0 design/version refusal" (`:414-419`), so a
reset of a workspace approaching `MAX_GIT_REPOS=256` (`:984`) could become
un-encodable — i.e. structurally un-resettable. That contradicts the spirit of
acceptance target `:126` ("Reset admission errors: structurally impossible on the
db path"): the design removes design-138's parse-admission reset error only to
introduce a new decoder-admission reset error at the high-repo-count boundary.
Note the journal scales with repo count, not the 112k file count, so the founder's
own workspace is unaffected; the gap is at the 256-repo boundary the design
otherwise honors.

Hand the exact arithmetic to the decoder specialist, but from a coherence
standpoint the 256-z-element admission and the 128 KiB aggregate cap must be
proven mutually satisfiable at the 256-repo maximum, or one bound must move.

### 3. MINOR — "independently shippable" U0 wording is stale against the 2.0-only rollout ruling.
Section: Rollout list (`:98`) vs Early-U0 (`:675`, `:765`).

The rollout list calls U0 "entry interning/immutable structural sharing
(independently shippable)" (`:98`). Under the 2.0-branch ruling nothing — U0
included — ships on the stable 1.7.x line; the Early-U0 section itself says U0 "is
not a 1.7.x release vehicle" (`:675`) and is "implemented before SQLite within
2.0" (`:765`). "Independently shippable" is only true in the sense of
"independent of the SQLite units, within 2.0." As written the parenthetical reads
as "shippable to users independently," which is exactly what the founder's
2.0-branch directive forbids. Requalify it ("independently *implementable/testable*
within 2.0") so the two statements cannot be read as conflicting.

### 4. MINOR — The empty-lineage next-DB is asserted to fit the 256 KiB seed cap without a measured size, and the whole reset path depends on it.
Section: `:256-261`.

`RESET_NEXT_DB_SEED_LIMIT` is 256 KiB and "Schema-v1's empty-lineage fixture must
fit that cap ... exceeding either is a pre-P0 design/version refusal" (`:259`).
The v1 main schema has ~11 tables (`store_meta`, `state_lineage`,
`migration_completion`, `entry_values`, `plane_heads`, `plane_entries`,
`global_manifest_meta`, `manifest_chain`, `manifest_git_sections`, `repo_records`,
`legacy_state_maps`) plus their UNIQUE/FK/fingerprint indexes — roughly 20+ B-tree
root pages at `page_size=4096`, ~84-128 KiB for a freshly created empty DB. That
is under 256 KiB but the margin is undocumented and the entire reset protocol is
void if it is ever exceeded (e.g. if U1 adds tables/indexes). State the measured
empty-DB byte size as a pinned fixture assertion, not a "must fit" claim.

### 5. MINOR — The `<200 ms` trusted-status acceptance target is not reconciled with the stated `0.84 s` current trusted baseline.
Section: acceptance `:116` vs problem statement `:31-32`.

Symptom 2 records "Steady-state trusted path measures 0.84 s (162 r1 evidence)"
and says SQLite "removes the baseline-parse/materialization component; it does not
remove the filesystem scan or Git work" (`:31-32`). The acceptance target is
trusted `rbox status` `< 200 ms` (`:116`). The doc never decomposes what in the
0.84 s trusted path is the baseline-parse component that SQLite removes to reach
<200 ms — a live-daemon trusted projection presumably already avoids the 59 MB
parse. Add a one-line component breakdown of the 0.84 s so the 4x claim is
grounded, or mark <200 ms as a target contingent on measured parse-share.

### 6. EDITORIAL — "merges or rebases from `main` into `2.0`" invites history rewrites on a long-lived shared branch.
Section: Rollout `:108-109`.

`2.0` is described as long-lived with U0-U5 landing on it over time. Offering
"rebases ... from `main` into `2.0`" (`:109`) would rewrite the shared branch's
history and break every in-flight slice built on it. Restrict to merge-only for a
long-lived integration branch.

## Coherence checks that PASSED (adversarially attempted, held)

- **Budget numbers are internally consistent.** writer cache 32 MiB + reader
  8 MiB = 40 MiB daemon authority cache (`:581`, `:588`, `:1125`); cache-v2 8 MiB
  everywhere (`:795/831/861/1120/1126`); non-wire heap <64 MiB (`:766`, `:1128`);
  U0 arena 8,192/8 MiB (`:770/894/1118`); `wal_autocheckpoint=1000`→~4 MiB
  (`:572`, `:591`), 64 MiB RESTART, 256 MiB backpressure with measured overshoot
  (`:596-603`, `:170`); oversize-row peaks (4/16/24/32 MiB) agree across the
  adapter table, FileEntry CHECK, and transition caps (`:1105-1121`, `:1666`,
  `:1896`). `dbBytesB64` <=349,528 B == base64(262,144 B) == 256 KiB seed. No
  number contradicts another.
- **Decoder reject vs crash table is coherent.** Sidecar present ⇒ W2 before
  decode; all-`S0` + decode failure ⇒ J0 halt zero-writes; both require exact `Q`
  (`:408-412`, `:459-461`). No overlap, no gap between J0/W1/W2.
- **Keystone P/R/I/Z boundaries preserved.** The full correlated table (`:474-498`)
  and W1/W2/J0 rows retain every design-138 boundary; WAL transactions are
  confined to between commit points (`:183-185`); byte-hash-exact witness survives
  on closed checkpoint-truncated files (`:190-196`); no deviation ledger entry.
- **Old-binary structural reject holds by construction.** The existing
  `exact()` envelope validator (`src/cli/reset-journal.ts:190,196`) sorts and
  compares `Object.keys` against literal key arrays and throws on any extra
  member, so a `sqlite/v1` journal's five extra top-level keys are rejected by an
  unmodified old binary — the downgrade-barrier claim (`:328-329`) is true, not
  aspirational.
- **Current-behavior citations are accurate.** Verified in code:
  `parseResetJsonBytes` is `JSON.parse` with last-wins duplicates
  (`reset-io.ts:292-297`); `RESET_STREAM_BYTE_LIMIT=2 GiB` (`:8`);
  `applyCipherDescriptor(file,…):void` mutates (`publish-pipeline/shared.ts:34`);
  `TrackedRepoSet` retains `paths`/`dirPrefixes` `Set`s (`engine/ignore.ts:258-259`);
  `RESET_MATERIALIZED_BYTE_LIMIT=512 MiB` and the 52x expansion multiplier exist;
  `sameContent` is size/mtime-insensitive (`engine/diff.ts:20`). The `sqlite/v1`
  codec module (`reset-journal-codec.ts`) does not yet exist — correctly a U1
  deliverable, not a false "already present" claim.
- **Problem statement is credibly solved and honestly scoped.** The cursor
  planes + U0 interning remove the steady-state baseline parse and co-resident
  N-sized manifests/maps; U2 drops the daemon's retained `this.manifest`
  (`:1132`). The doc explicitly does NOT claim to erase the whole historical
  multi-GB slope, only measured component reductions (`:33-37`, `:120-121`), and
  wire peaks remain bounded (not removed) by the ledger. This is defensible, not
  overclaimed.
- **Rollout is stated unambiguously.** `:106-113` is explicit: all U0-U5
  implementation on a long-lived `2.0` cut from `main`; `main` stays 1.7.x and
  carries design/reviews; sync from `main` into `2.0`; ships only as the 2.0
  major; no slice/barrier/migration artifact rides a 1.7.x release. FOLD closure
  claim 5 holds. (Only the wording nits in findings 3 and 6 remain.)

## Most under-specified remaining contract (implementability answer)
The `state-semantic-v1` / `stage-semantic-v1` / `repo-transition-v1` token
framings (`:1330-1338`, `:1606-1615`, `:1890-1898`). Migration correctness rests
entirely on `source digest == SQL round-trip digest`, yet the exact byte framing,
type tags, and the "named v1 normalization" are specified by reference to
themselves — the doc says *what* they cover, not the *exact* stream an
implementer must emit identically from the JSON import path and the SQL
projection path. It is legitimately deferred to U1, but it is the load-bearing
migration-safety contract and should be flagged as the first thing U1 must freeze
before either projection is written. Everything else (DDL, `RetainedEstimateV1`
constants) is a "generate and CI-pin" contract with a stated formula, which is
acceptable.

## Verdict
CHANGES-REQUIRED — findings are localized (a safety-summary contradiction and a
cap/workload coherence gap plus wording), not structural; the document is
otherwise remarkably self-consistent.
