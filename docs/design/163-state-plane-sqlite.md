# 163 — The state plane moves to SQLite

Status: **v11 — amendment to the ratified v10 (founder requirement reductions
2026-07-28), changed sections pending codex re-confirmation.**
V11 **deletes** requirements and adds none, so v10 remains implementation
authority for B0 → U5 everywhere v11 does not touch. Only the changed sections
are re-opened: § "Founder requirement reductions ratified 2026-07-28 (v11)",
§ 1a closure part two and the residue passage, the M0 admission predicate
(bullet 5), the `F1`–`F6` framing, `B0`/`U3` exit criteria, and the open-inputs
list. **Exactly one founder input remains owed: the frozen machine profile**,
which blocks U5, not B0/U0/U1. `B0` is merged (#539) and its shipped code
requirements are unchanged by this amendment.

Prior status for the record: v10 was **RATIFIED 2026-07-28 as implementation
authority for B0 → U5**; codex ALIGNED at tip `1a42a4f0` after the R4 round
(two opus lanes + codex serial ×5). V10 is a *round-six single-item
fold*: the R4-v9 serial review verified both v9 closures and the reserve byte
math, then falsified v9's blast-radius bound on the named residue by executing
the merge consumer — `reconcile` classifies `local == stale base` as an
ordinary remote write, so the ABA case (a user's intentional revert silently
overwritten in the lost-save lineage) is reachable. V10 withdraws that bound,
names the stronger consequence, and adds fixture `F6` asserting it. The
ratification argument was already carried by the precondition and the hard U3
drain gate, not by the withdrawn bound; that structure is unchanged.

V9 provenance below is retained as the record of round five.

V9 was a *round-five targeted fold*:
it closes the two residuals from the codex serial review of the v8 tip.

Provenance, stated honestly: **v8 named one outcome of the pre-B0 writer race
and missed the other, and two of the bounds v8 offered for it are contradicted
by the source it cites.** V8's paired witness sample is not atomic with M6's
rename, so an unlocked pre-`1.11.0` writer can publish *between* them and have
its document silently overwritten by `Q` — a lost write, distinct from the
post-`Q` destruction `F3` already asserted, and unnamed in v8. V9 shrinks that
window to the `check → rename` instants with an M6 body-hash re-verification,
names **both** outcomes with fixtures (`F3` and the new `F5`), withdraws v8's
false necessity claims ("state read completes before M0", "window spans the
entire M0–M6 migration" — push and pull separate read from write by a whole
sync), and states plainly that the surviving pre-`Q` outcome is **unrecoverable
and silent**, ratifiable only on the `B0` adoption gate, which becomes a hard U3
exit criterion. V9 also re-encodes the reserve provenance header, which v8
specified at a width it cannot fit. The `M0–M7` machine, the `Q` barrier, and
every migration fence are unchanged or strictly tightened; nothing in this fold
weakens them.

Previous status (v8), retained for provenance: V8 is a *round-four targeted
fold*: it closes the seven residuals from the codex serial review of the v7 tip
and corrects the open-input count, which v7 understated. V8's own provenance
note: **v7's "no third case" argument for the `B0` write
barrier was wrong, and v7's claim that exactly one founder input remained was
wrong.** V8 names the third case with its exact preconditions instead of
arguing it away, binds the last-writer witness to content rather than to a
reusable inode, gives the inert control temp and the generic reserve
dispositions that their own consumers can actually honour, and lists both open
inputs. The `M0–M7` machine, the `Q` barrier, and every migration fence are
unchanged or strictly tightened; nothing in this fold weakens them.

Previous status (v7), retained for provenance:
**rounds one and two both recorded a schema closure in the review log that they
never performed.** The v6 log row for CODE B3 + CODEX 1 claims "three columns
added" and a `resolutionIntent` disposition; in fact `packedRefsIdentity`,
`attempt`, and `resolutionReceipt` appeared **only in that log row** — the
`repo_records` DDL and the one-for-one field list were never touched, and the
section the row cites ("Newly named members and strip-on-read semantics") did
not exist. V7 makes those edits in the normative sections and adds a
schema-rebase gate so a fourth drift is a red test rather than a sentence. The
standing rule this cost us is now explicit: **the review log records a closure;
it never constitutes one.** V7 additionally makes the `B0` write barrier
race-free (v6 specified a check-then-rename that a concurrent `Q` still beats),
reconciles three fold-introduced contradictions between the M6 cleanup
inventory, the M2 backup preamble, and the M0–M7 machine, consolidates two
divergent M0 admission predicates into one, and finishes the rollout residuals
(reserve path, dual-binary rig, corpus fixture, kill-criterion protocol). The
M0–M7 machine, the `Q` barrier, and every migration fence are unchanged or
strictly tightened; nothing in this fold weakens them.

Previous status (v6), retained for provenance: v6 folds the R4 ratification round
(two opus lenses — code-claims and rollout — plus one gpt-5.6-sol review; all
three are in `docs/design/notes/163/REVIEW-163-R4-*.md`). Provenance, stated
honestly: **v5's claim to be "strictly additive" with "every v4 closure
normative" was false**, and v6 does not repeat it. V5 overrode two v4
normatives (replacement-pair creation, and the `promotedHalt` delegation versus
the generic doctor clear-before-delegate contract); v6 names both as explicit
refinements and amends the superseded v4 paragraphs in place. V6 additionally
rebases the RepoRecord mapping on the current interface, corrects four field
claims that did not survive re-verification against `src/`, closes the C4
inventory over every `.rbox/state/**` reader rather than only the reset
protocol's own artifacts, and replaces the 20-line rollout sketch with a
gated delivery plan. The keystone (file-swap at reset boundaries, closed
byte-exact O/N witness, W2-before-decode, single Q authority flip,
terminal-control-last, 2.0-only confinement) is unchanged.
It is not implementation authority until the
orchestrator ratifies it.

## OPEN INPUTS OWED BY THE FOUNDER (v11 — there is exactly one)

V8 said "exactly two" and that was true at v8. **V11 resolves the first of
them**, so this list is now one item long; this list remains the authority on
how many there are.

**1. RESOLVED by founder decision 5 (2026-07-28) — do the four external users
take the one-way migration before the payoff lands?** The question asked
whether it was acceptable to *push* an irreversible flip at users on the
project's schedule while the wins they would notice arrive later. Decision 5
removes the push: migration is explicit-and-exclusive, so a user takes it
**inside an upgrade they chose to run** (`rbox upgrade`) or by typing
`rbox migrate`. **No part of the question survives as an open input.** What
survives is not a question but two already-ratified obligations that decision 5
does not touch: the U3 no-regression gate (the flip may not ship if trusted
status or daemon RSS is worse than the 1.x baseline) and the plain-English halt
copy for two non-technical users. The founder does not owe an answer here.

**2. Which host is the frozen machine profile for every U5 ship number?**
All ratified kill-criterion thresholds (trusted status p50/p95, daemon RSS) are
measured on one named, frozen host profile — exact machine, CPU, RAM,
filesystem, and whether it is a fleet host or the rig — and the same code will
pass on one fleet host and fail on another, so no threshold is falsifiable
until this is chosen. It is **OWED and blocking before U5 begins**; the full
statement of what must be recorded lives in § "Measurement protocol for those
numbers". Naming it here is not a duplicate requirement, it is the correction
of v7's count.

**Everything else in this document is either closed or ratified; the frozen
machine profile is the only input still owed.**

## Founder decisions ratified 2026-07-28

Recorded here as ratified, not provisional. Each is normative where it lives.

1. **Sequencing: backend-first hybrid — ADOPTED.** Order is
   `B0 → U0 → U1 → U2 reset → U3 flip/2.0 → U4a–U4f on main → U5`, with the
   fold's four normative conditions attached (no-regression gate at the flip;
   time-boxed and CI-inventoried whole-state adapter; per-slice differential;
   `B0` unchanged). The founder's leaning was explicitly conditioned on a
   verified analysis rather than issued as a decree, and the analysis — redone
   against `src/` — agreed for a reason neither review stated: it makes the one
   irreversible step coincide with the **smallest** possible diff instead of
   the largest. The M0–M7 authority machine, the `Q` barrier, and all migration
   fencing are unchanged; only their position in the schedule moved. Full
   argument: "Rejected and deferred alternatives", item 5.
2. **`B0` as a hard pre-U0 gate — ACCEPTED, including external-user adoption.**
   A running degraded-unlocked legacy writer can overwrite `Q` after M6, so the
   write-side barrier must ship **and bake** on the stable 1.x line and be
   adopted by all 4 external users and all 3 fleet hosts before any 2.0 binary
   migrates a workspace. An external-user upgrade is therefore a blocking
   dependency of design 163, accepted as such rather than traded against the
   split-brain risk.
3. **Downgrade floor: `1.11.0` — RATIFIED.** `B0` ships as `1.11.0`, and that
   exact version is the supported downgrade floor, the M0 barrier-capability
   threshold, and the pinned 1.x side of the differential rig.
4. **Kill-criterion numbers — RATIFIED.** On the 112k corpus: trusted
   `rbox status` p50 <= 200 ms and p95 <= 400 ms; daemon steady-state
   RSS <= 1.5 GB. V7 adds the measurement protocol these numbers need
   (warmup/sampling, "ordinary use", "unexplained halt", a four-week bake, one
   remediation cycle) in the U5 section. **One input is still owed there and is
   flagged as blocking before U5 begins: the frozen machine profile.**

## Founder requirement reductions ratified 2026-07-28 (v11)

Two decisions taken after v10 was ratified. Both **delete** requirements; the
amendment adds no new mechanism, no new artifact, and no new file. Where a
mechanism below is retained, it is retained *unchanged* — v11 changes what the
document claims the mechanism is load-bearing for, not what it does.

5. **Migration is explicit-and-exclusive — the "parked car" rule. ADOPTED.**
   The founder's framing: you do not rebuild the engine while the car is being
   driven; you migrate a parked car. Normative, and this rule supersedes every
   earlier sentence that let a migration begin opportunistically:
   **`MIGRATION-EXCLUSIVITY-v11` — a migration may begin only inside an
   exclusivity window in which no other rbox actor runs against the workspace,
   and there are exactly two admitted ways to be inside one:**
   - **(a) riding `rbox upgrade`.** The managed upgrade already stops daemons
     and waits for them: `restartDaemonsAfterUpgrade` calls `await stop(root)`
     (`src/cli/upgrade-cmd.ts:154`) and `stopDaemon`
     (`src/cli/daemon/process-control.ts:445`) sends `SIGTERM` and blocks on
     `waitForExit` until the named process is actually gone, removing the
     pidfile only then. **Exact semantics, not rounded off:** the loop is *per
     workspace* and restarts each one (`resumeDesiredDaemon`,
     `src/cli/upgrade-cmd.ts:160`) before advancing to the next entry, so the
     window is "this workspace has no daemon", not "the machine is quiet", and
     it is the interval between that workspace's `stop` returning and its
     `resumeDesiredDaemon`. A migration runs inside that interval or not at all.
   - **(b) an explicit foreground `rbox migrate`.** A command the user types,
     in a workspace whose daemon is not running, that does the whole M0–M7
     transaction in the foreground with progress on stdout and a
     non-interactive twin. Nothing else invokes it.

   **Deleted by this rule:** ambient migration. No daemon boot path, no
   `rbox status`, no incidental sync, and no first-2.0-launch hook may start a
   migration. "The first 2.0 boot migrates the workspace" is no longer a thing
   this design does.

   **What enforces the window, and what happens when it cannot be
   guaranteed.** Enforcement is a refusal, not a lock upgrade: M0 admits only
   when its caller is one of the two admitted entry points *and* M0
   independently confirms, under the complete lock set it already takes, that
   no daemon is live for this workspace (the existing daemon pid-record and
   ownership evidence — `isDaemonRunning`/`parseDaemonPid` — plus the bounded
   wait already in the M0 predicate). If either half is unproven, migration
   **refuses** with a typed `migration-not-exclusive` refusal: no control is
   published, no artifact is created, JSON stays authoritative, and the remedy
   printed is the one action `rbox migrate` in a quiet workspace. Fail-closed
   is the whole enforcement story; there is no degraded "migrate anyway" mode.

   **Consequence — the concurrent-legacy-writer threat model collapses.** The
   entire § 1a analysis was about a legacy writer racing a *live* migration;
   exclusivity excludes that scenario at the front door instead of fencing it
   at the back. **Deleted as a U3 requirement: the M0 paired-interval
   live-writer sampling.** Outcomes (i)/(ii)/ABA and the `check → rename`
   microwindow analysis become **defense-in-depth against an excluded
   scenario** rather than the load-bearing ratifiability argument.

   **What REMAINS, unweakened:** `Q` recognition and the `B0` write-side
   barrier (exclusivity binds what runs *during* a migration and says nothing
   about a binary started **later**, which must still refuse); the
   `last-writer.json` witness sidecar (cheap, shipped, and a statement about
   history rather than concurrency); the 1 MiB reserve (it is about ENOSPC, not
   writers); `F1`–`F6` as regression nets, reframed from "named residual" to
   "excluded by exclusivity, tested anyway"; and every M0–M7
   crash/resume/halt property — a parked car can still stall, and nothing in the
   durability machine depended on the writer race. **B0's shipped code (#539) is
   NOT retroactively deleted**; its witness and refusal machinery is now
   defense-in-depth, which is a fine thing for it to be.
6. **The U3 drain gate reads existing `rbox-admin` version telemetry — no new
   infrastructure. RATIFIED.** Founder: "I already have version telemetry in my
   rbox-admin repo." The `telemetry-verified drain` bar is **unchanged**; only
   its implementation cost changes, from "build a fleet version view" to zero.
   Issue #540 (build drain telemetry) was closed as **invalid** on that basis.
   Fleet picture recorded 2026-07-28, so the gate is read against a known
   population rather than an abstract one: **1 external user on 1.6** (a
   personal contact, to be nudged directly), **2 external users on 1.9.x who
   upgrade frequently**, and the **founder fleet on dev builds**. The drain is
   a handful of named humans, not a statistical exercise.

Field-claim corrections from r1 are folded below;
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
   the `<200 ms` value below is a prospective measured U4 target, not claimed
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

Migration is a one-way, fenced authority transaction, not a DB-presence test,
and since v11 it is **explicit and exclusive**: it runs only inside an
`rbox upgrade` stop window or an explicit foreground `rbox migrate`, never
ambiently and never on boot (`MIGRATION-EXCLUSIVITY-v11`).
It builds a sibling DB, writes the completion witness in the same transaction
as the imported rows, verifies a full semantic round trip, publishes the DB,
then atomically replaces the legacy state path with a durable old-reader
barrier. JSON remains authoritative through every earlier failure. The full
state machine and the stable guard/ENOSPC halts are normative below.

### Rollout
`B0` pre-U0 stable-line barrier release (below); U0 entry
interning/immutable structural sharing (independently implementable
and testable within 2.0, not independently shippable);
U1 store/schema/digest/backup modules and read-only adapters; **U2 138
DB-artifact reset/quarantine flows; U3 migration, the old-reader barrier, and
the `Q` authority flip behind a whole-state compatibility adapter (2.0 ships
here); U4a–U4f the ordered scan/reconcile/apply/push ports plus cursor-backed
caches, landing as ordinary 2.x releases**; U5 fleet bake with component
telemetry. V6 reordered these around the backend-first sequencing (v5 had the
engine rewrite at U2 and reset at U4, with the flip in the middle); the
authority machinery itself is unchanged. Default-on is allowed only after U2
review and the barrier-compatible bake release; rig scenarios run migration
from real pre-163 states and every injected boundary below. The gated plan, per-unit exit
criteria, ship/no-ship criterion, and branch-merge process are normative in
"Rollout, gates, and delivery plan" below — v5's version of this paragraph was
the only unreviewed part of the design and two of its assumptions were false
(v6 R4-ROLLOUT).

**Branch model, corrected in v7 to match the restructured plan.** The
long-lived `2.0` branch spans **`U0` through `U3` only** — entry interning,
store/schema, reset conversion, and the migration/`Q` flip. It is created from
`main` when U0 starts and it ends when 2.0 ships at U3. `U4a–U4f` are **not**
on it: each engine slice lands on `main` as an ordinary 2.x release, which is
most of the reason backend-first was adopted. `B0` is likewise not on it — it
is a 1.x release on `main`.
`main` remains the stable 1.x line through `B0`
(1.10.2 at the time of this fold; v5 still called it "1.7.x"), then the 2.x
line from U3 onward;
design documents and reviews continue to merge to `main`, and periodic merges
**from `main` into `2.0`** keep the implementation branch current while it
exists. The shared,
long-lived `2.0` branch is never rebased; a developer-local topic branch may be
rebased before it is merged (r3 C9; r3c-3+r3c-6).
The authority flip ships only as the 2.0 major version. No `U0`–`U3` slice,
migration artifact, or half-migrated state plane rides an ordinary
1.x release. The one deliberate exception is `B0`: the **write-side `Q`
barrier is a 1.x deliverable and must be**, because its entire purpose is to
make binaries that predate 2.0 fail closed. `B0` contains no design-163
implementation — no store, no schema, no migration — only the barrier check,
its pinning inventory test, the generic reserve, and the last-writer witness.

## Acceptance targets (measured, not promised)

**When each target is owed (v6).** Under the backend-first sequencing the
targets below are **U4's**, not the 2.0 flip release's. The flip (U3) owes only
the O(dirty-row) authority write, structurally impossible reset admission
errors, and the no-regression gate — it must not make status or RSS worse, and
it does not yet claim to make them better. Claiming a U4 target for the flip
release would be exactly the kind of broadened claim the last bullet forbids.

- Trusted `rbox status` with live daemon: < 200 ms on the 112k corpus. The
  unsettled fallback is reported separately as baseline-load, scan, diff, and
  Git-divergence components; it has no <200 ms promise. U4 reports the current
  0.84 s and post-U4 state-load/projection, daemon/RPC, scan/diff, and Git
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
  workspace-sized JS maps are nevertheless incompatible with U4's memory
  contract, so U4 gives HashCache, DirCache, and EncryptAddressCache one
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
halt. Unknown names in either reserved protocol directory are invalid rather
than silently skipped.

##### Frozen protocol-temp grammars and cleanup authority (v6 R4-CODEX 4)

V5 admitted unspecified "recognized positively identified protocol temps" under
"their existing owner-specific cleanup rule", which is not a closed inventory:
an implementation would have to either reject supported crash debris or invent
the forbidden broad wildcard. The grammars are frozen here.

Every temp is `.rbox-tmp-<pid>-<discriminator>-<basename>` with
`RBOX_TMP_PREFIX=".rbox-tmp-"` (`src/engine/fsutil.ts`). There are exactly four
producers today and they use two discriminator forms:

| Producer | Discriminator | Basename | Can land in a reserved reset directory |
|---|---|---|---|
| `writeFileAtomic` (`src/engine/fsutil.ts`) | module-global decimal counter | target basename | yes (journal/marker publication) |
| `boundedCopy` (`src/cli/reset-io.ts`) | 16 lowercase hex (8 random bytes) | destination basename | yes (archive/candidate copies) |
| `applyFile` temp (`src/engine/apply.ts`) | module-global decimal counter | target basename | no — workspace tree only |
| quarantine `publishCommitRecord` (`src/cli/reset-quarantine.ts`) | 16 lowercase hex | literal `COMMITTED` | inside a quarantine bundle directory |

Normative dispositions:

- The inventory recognizes a temp only by the complete grammar
  `\.rbox-tmp-(?:[0-9]{1,10})-(?:[0-9]{1,10}|[0-9a-f]{16})-.+` in a reserved
  reset directory. It reports it separately as **inert**: never a main, never a
  sidecar, never an actionable artifact, never an O/N witness, and never a
  reason to widen a row. It still counts toward
  `RESET_NAMESPACE_ENTRY_LIMIT`.
- No name outside that grammar is a temp. A near-miss is an unknown name and
  therefore `RESET_NAMESPACE_INVALID`, exactly as before.
- **There is no crash-time owner authentication and no restart sweeper today**,
  and 163 does not invent one. Verified: the only repo-wide handling of the
  prefix besides creation is the scan ignore rule `.rbox-tmp-*`
  (`src/engine/ignore.ts`), which prevents debris from entering a manifest but
  never removes it. `writeFileAtomic` and `boundedCopy` remove their temp on a
  caught error only; `SIGKILL` and power loss leave debris permanently.
  Consequently, an inert temp in a reserved directory is a **supported
  observation** that must not halt classification, and its removal is
  authorized only by explicit doctor quarantine of inert temps — the same
  authority the migration crash table already grants for an inert M0 control
  temp. Automatic reset/migration flows never delete one.
- One live defect is recorded rather than folded silently: quarantine's
  `publishCommitRecord` `finally` block closes its handle but does **not**
  remove its temp, so a thrown (not merely killed) publication leaks a
  permanent `.rbox-tmp-<pid>-<16hex>-COMMITTED` inside the bundle directory.
  U2 fixes that producer; the inventory rule above already tolerates the
  existing debris either way.

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

##### Committed quarantine retains deletion authority over legacy candidates (v6 R4-CODEX 3)

The paragraph above says a `legacy-exact` candidate is "permanently inert" and
"survives M0–M7 and the Q flip unchanged". That is true of the SQLite reset
protocol and **false of the workspace**, because a durably COMMITTED quarantine
bundle already owns the later deletion of that exact candidate, and that
authority outlives the journal:

- `finishCommittedQuarantine` (`src/cli/reset-quarantine.ts:199-211`) removes
  the journal first and then, for every manifest artifact whose `cleanup` is
  `remove-exact`, calls `removeExact`, which hashes the file and deletes it
  **only on exact SHA-256 match**.
- The doctor creates candidate artifacts with `cleanup:"remove-exact"`
  (`src/cli/reset-journal-doctor.ts:145-147`); archives are structurally forced
  to `preserve` (validator, plus the plan check).
- Resumption is gated on a fully self-validating `COMMITTED` bundle
  (`reset-quarantine.ts:229-244`) and is reachable from the doctor after the
  journal is already gone; `reset-quarantine.test.ts` pins the crash points
  `after-journal-remove` / `after-candidate-remove`.

Migration settles a standing journal. It does **not** settle a pending
quarantine bundle. Normative v6 resolution:

1. **M0 refuses to start while any resumable quarantine bundle exists.** This
   is one condition of the M0 quiescence predicate below, which is the **single
   normative admission predicate** — v7 moved the quarantine clause into that
   list rather than leaving a second, differently-worded copy here. A bundle in
   any state other than "absent" blocks migration with a typed
   `quarantine-pending` refusal (not a
   halt — it is an ordinary "finish this first" condition, and the doctor's
   existing resume path is the remedy). Malformed, partial, and
   unreadable-`COMMITTED` bundles are exactly the cases
   `resumeResetQuarantineUnderFence` already removes, so the remedy is the
   existing command in every case.
2. **Q does not revoke quarantine cleanup authority; it is fenced ahead of Q
   instead.** Revocation was considered and rejected: it would require the
   SQLite branch to reason about, and selectively disarm, a durable record
   written by a 1.x binary — precisely the cross-format authority coupling the
   keystone forbids. Refusing to migrate until the bundle is settled achieves
   the same safety with no new authority.
3. Should a COMMITTED bundle nevertheless be observed after Q (only reachable
   by manual restoration or a 1.x binary older than the barrier floor), its
   `remove-exact` action against a legacy candidate remains harmless — the
   target is a legacy `.json` file the SQLite protocol never reads — but the
   observation is reported by doctor as `post-q-quarantine-residue` rather
   than silently resumed.
4. Fixtures: `COMMITTED + journal absent + candidate present` before M0 (must
   refuse migration), the same after a forced Q (must report residue and take
   no action), and the existing crash-point matrix re-run with a `.db`-era
   active state present.

##### Reset namespace scope: quarantine bundles are the fourth durable tree (v6 R4-CODE item 11)

The reset namespace has four durable trees, not three: `reset-v1.json` +
`state-incarnation.json`, `reset-candidates/`, `lineages/`, and
`.rbox/state/quarantine/` bundles (`src/cli/reset-quarantine.ts`). Quarantine
bundles are deliberately **outside** the `ResetNamespaceInventory` scope — they
are not classification inputs, are never O/N witnesses, and are never
correlated by a P/R/I/Z row. They are inventoried only by the M0 quiescence
predicate above and by the doctor's own resume path. V5 excluded them without
saying so; v6 says so.

#### Lineage-archive provenance predicate (v6 R4-CODE B1)

V5 called exact legacy archives "always inert / permanently inert under
SQLite". That is true of the **reset protocol**, and false of the workspace as
a whole: their presence is a live semantic predicate on every state load, and
163 as written silently breaks it.

Today `hasResetLineageArchive(root)` (`src/cli/sync-state-store.ts:68-81`)
returns true when `.rbox/state/lineages/` contains a directory whose name
matches `/^[0-9a-f]{32}$/` containing a file whose name matches
`/^[0-9a-f]{64}\.json$/`. `loadState` (`:322-324`) evaluates it whenever
`lastSyncedSequence === 0` and, on true, records the state in
`streamMismatchFreshStates`, surfaced by `stateWasStreamMismatch`. That value
is an **authorization** input, not diagnostics: it becomes
`allowLegacyStreamReplacement` at `src/cli/sync/pull.ts:445` and
`src/cli/sync/push.ts:539,:579,:894`, and `sync-state.ts:364-368` uses it to
choose between throwing on a rejected `stream` CAS and performing a legacy
whole-state replacement write. A separate consumer, `push.ts:623`, feeds
`streamMismatch` into `publish-candidate.ts:261`'s `filesFirstDefer` capture
policy.

Under 163 a reset archive is `lineages/<nonce>/<sha>.db`. The `.json`-only
name test then returns false with no log, no throw, and no else-branch: a
post-reset seq-0 state stops being marked rebind-provenance, and a stream CAS
rejection that today rebinds instead throws. That is a silent behavior change
in a safety-relevant path and is a **regression**, not a simplification.

Normative v6 definition and owner:

- The predicate is renamed `hasResetLineageProvenance(root)` and **owned by
  `src/cli/reset-namespace-inventory.ts`**, which already performs the
  bounded, no-follow, entry-limited inventory of both namespace branches. It is
  not a second directory walk and never introduces a wildcard.
- It is true when the completed inventory reports at least one archive leaf in
  **either** branch: a `lineages/<lower-hex32>/<lower-hex64>.db` main
  (SQLite branch, any sidecar vector) or a
  `lineages/<lower-hex32>/<lower-hex64>.json` `legacy-exact` leaf. A
  `legacy-other` or otherwise non-exact leaf is not provenance evidence and,
  where the surrounding rule already halts, that halt still wins.
- It never opens, hashes, or parses an archive, and it never uses a journal
  field to discover a path. An inventory error union value
  (`RESET_NAMESPACE_INVALID`, `RESET_NAMESPACE_BUSY`) is propagated to the
  caller as an error, never coerced to `false`. Silently answering "no
  provenance" on an unreadable namespace is precisely the failure mode this
  section exists to prevent.
- `sync-state-store.ts` (pre-Q) and the state-plane engine adapter (post-Q)
  keep the call site and the `lastSyncedSequence === 0` trigger unchanged. U1
  pins a fixture asserting that a `.db` archive, a `.json` archive, and one of
  each produce the same predicate value as today's `.json` archive.
- The **write** that this authorization enables (`legacyState` plus
  `saveStateUnsafeLegacyOrTest`, `sync-state.ts:364-367`) is a whole-JSON
  state replacement and has no post-Q meaning. U4 replaces it with an explicit
  store operation that performs the same lineage replacement as a bounded CAS
  transaction under the same authorization predicate. Until that operation
  exists, migration must not be enabled — it is listed as a U4 exit item below.

#### Complete `.rbox/state/**` consumer sweep (v6 R4-CODE recommendation)

V5's C4 inventory scoped itself to the reset protocol's own artifacts. The R4
code lens showed that scope statement is where B1 hid. V6 therefore
dispositions **every** module under `src/` that reads or writes anything under
`.rbox/state/**` or `.rbox/state.json`, and this table is normative: U1 adds a
test that fails when a new such consumer appears without a row here.

Note the shape first, because it removes an imagined conflict: `.rbox/state.json`
is a **file** and `.rbox/state/` is a **directory**. `state.db` lands at
`.rbox/state/state.db`, so no rename collides with the sidecar directory.

| Consumer | Path(s) under the state namespace | Depends on a name/extension 163 changes? | Disposition |
|---|---|---|---|
| `sync-state-store.ts` | `state.json`, `state-incarnation.json`, `lineages/<hex32>/<hex64>.json` | **yes** — the hex64 `.json` archive regex | Owned by the lineage-provenance predicate above; `STATE_FILE`/marker paths are unchanged (`Q` occupies `state.json`). |
| `reset-journal.ts`, `reset-state.ts`, `reset-journal-doctor.ts` | `reset-v1.json`, `reset-candidates/<id>.json`, `lineages/**`, `state-incarnation.json` | **yes** — by design | The SQLite branch plus the retained legacy-JSON branch above. |
| `reset-quarantine.ts` | `quarantine/**`, and `safeRelative` requires archived originals to be under `.rbox/state/` | prefix, not extension | Fourth durable tree; fenced by the M0 quiescence predicate. |
| **`adopt-cache.ts`** | `cache-generation.json`; `invalidateAdoptionCaches` deletes a **hardcoded list**: `hashcache.json`, `dircache.json`, `scan-probe.json`, `git-divergence.json`, and `git-tracked/` | **yes — highest-risk item found in R4** | U4a replaces those caches with `cache-v2.db` and parks the v1 files under `cache-v1-retired/`. `fs.rm(..., {force:true})` on a now-absent path is a silent no-op, so adoption would advance its generation while leaving live stale caches. **U4a must update this list in the same change that introduces `cache-v2.db`**, adding the v2 tables' invalidation (a bounded transaction, not a file delete) and the parked-copy path. A U4a test asserts that adoption invalidates every cache the scan path can consult. |
| `path-warnings.ts` | `path-warnings.json`; `requirePlainWarningsParent` lstat-walks `.rbox` then `state` and **throws if either is not a plain directory** | no extension dependency, but a hard shape assertion | Unaffected: `.rbox/state` remains a plain directory in every 163 layout. Recorded because any future "state as a file" variant would hard-fail here. |
| `reset-health.ts` | `health-halt.json` | no | Unaffected. Self-validating, advisory. |
| `daemon/drift-audit.ts` (note: not `src/cli/drift-audit.ts`, which does not exist) | `drift-audit.json` | no | Unaffected. Self-versioned (`version:1`), fails soft to an empty state. Its in-memory diff is separately re-homed on `DriftAuditPort`. |
| `activity.ts`, `metrics.ts`, `scan-probe.ts`, `sync-mutex.ts`, `daemon/daemon-operation-scheduler.ts`, `sync-recovery.ts`, `sync-git/plan.ts`, `sync-git/state-cas-locks.ts`, `publish-pipeline/stale-temp.ts`, `engine/apply-receipt.ts` | `activity.json`, `shell.line`, `shell.deferrals`, `metrics.json`, `scan-probe.json`, `sync.lock`, `locking-health.json`, `lock-starvation.json`, `uploads/`, `git-lock-transactions/v1/`, `tmp/` | no | Out of scope; 163 renames none of these. Listed so the sweep is complete and the next reviewer does not have to re-derive it. |
| `engine/ignore.ts`, `engine/git/journal.ts` | `git-tracked/<key>.json`, `git-journal/<key>/journal.json` | `git-tracked/` **yes** (deleted by `adopt-cache.ts`, replaced by `TrackedPathIndexPort`) | Covered by the `adopt-cache.ts` row; `git-journal/` is unchanged and `reset-state.ts` still requires it empty. |
| `engine/hashcache.ts`, `engine/dircache.ts`, `engine/encrypt-address-cache.ts` | `hashcache.json`, `dircache.json`, `encrypt-cache.json` | **yes** — replaced by `cache-v2.db` | Already owned by the rebuildable-cache section; the parking/retirement protocol there is the only permitted transition. |
| `shell-init.ts` | writes literal `$1/.rbox/state/shell.line` and `.../shell.deferrals` **into users' shell rc files** | no | Out of scope, and must stay that way: those paths live out-of-process on machines we do not redeploy. 163 renames neither. |
| `doctor-cmd.ts` | user-facing copy naming `.rbox/state.json` literally | copy only | U3 updates the copy so that a post-Q workspace is not told to inspect a file that now holds the barrier sentinel; doctor must never advise deleting `Q`. |

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
and hand the resulting buffer to a local parser — which is exactly what
`reset-quarantine.ts:332` does today (`boundedRead(..., RESET_STREAM_BYTE_LIMIT)`
then delegate to `observeResetJournalBytes`), so that call site changes.

The complete list of modules that touch raw journal bytes today, verified for
v6 (R4-CODE item 6; v5 named two of five):

| Module | What it does today | After U2 |
|---|---|---|
| `reset-journal.ts` | the only module that **parses** (`readResetJournal`, `observeResetJournalBytes`, `inspectResetJournal`) | imports the shared codec; owns no parser |
| `reset-journal-doctor.ts` | raw `JSON.parse` of both bundled and live journal bytes to read `.v` | imports the shared codec; the bare `JSON.parse` is deleted |
| `reset-quarantine.ts` | `boundedRead`s raw bytes at the 2 GiB streaming cap, then delegates parsing | reads through the codec's byte source at the 512 KiB cap |
| `reset-state.ts` | calls `readResetJournal` (two sites) | unchanged; consumes the codec transitively |
| `sync-state-store.ts` | calls `readResetJournal` as a presence test | unchanged; consumes the codec transitively |

All five import this module; none owns a duplicate parser or a local
journal-size constant.

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
migration/test-only and must not become U4's implementation. The operational
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
make aliasing safe; U0 is measured but is not credited with U4's <64 MiB
non-wire budget. Once U4 removes N-sized manifest arrays, `EntryArena` becomes
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
U4 tests additionally force the 8,192/8 MiB cap through success, thrown sink,
CAS retry, and cancelled cursor paths and require every lease count to return
to zero.

### Rebuildable cache and plan memory (part of U4, not a hidden exception)

The current `HashCache`, `DirCache`, `EncryptAddressCache`, and tracked-path
cache each load a workspace-sized JSON object/array/`Map`; DirCache also
retains child arrays and EncryptAddressCache retains a reverse `pathOwner` map.
They do not survive U4 in that form. Their replacement is one independent
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

The old three cache JSON files and every legacy tracked-path cache JSON are not parsed or migrated on U4 startup—that
would recreate the peak this design removes. They are rebuildable evidence, so
U4 atomically parks them under an id-scoped `.rbox/state/cache-v1-retired/`
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
and token maps (`:624-707`), and the sorted/stringified canonical receipt.
Two v5 citations are corrected here (v6 R4-CODE item 10): the file is 756
lines, so the "JSON-backed entry points (`:715-763`)" citation ran past EOF and
is withdrawn; and the canonical receipt is `canonicalReceipt` at `:152`, while
`:157-161` is `normalizeRel`. The other four cited ranges re-verified exact.
Line numbers in this document are review evidence, not implementation
addresses — U4 re-derives every peak by symbol name.

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

U4 removes the daemon's retained manifest. Post-decomposition that field is
`this.local.manifest` (`src/cli/daemon/daemon.ts`, 16 read sites), owned by
`LocalAuthority` (`src/cli/daemon/local-observation-transition.ts`), not a
`this.manifest` on the daemon class — the port replacement therefore lands on
`LocalAuthority`, not on `daemon.ts` (v6 R4-CODE item 9). The daemon retains only the
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
  its size comparison, U4 releases all delta-only graphs/buffers before it may
  admit the fallback snapshot encoder;
- `BlobRefCommitAdapter` owns upload/refset construction and commit retry's N-sized
  `blobRefs`, `uploaded`, `needsUpload`, audit-`seen`, and address-dedup
  collections. Before U4 leaves the wire adapter they move to the candidate
  stage tables; only the final signed-protocol `blobRefs` array/refset bytes
  remain an unavoidable full wire allocation.

All five use `WireAllocationLedger`. `H` is the lower positive value of the
cgroup hard limit and a **new** env var `RBOX_PROCESS_BUDGET_BYTES` (default
4 GiB when neither supplies a lower value); `R` is RSS sampled immediately
before each new
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
the generic ledger may not substitute a flat allowance.

`RBOX_PROCESS_BUDGET_BYTES` does not exist today and is **not** design 161's
variable (v6 R4-CODE item 8). 161's is `RBOX_RESET_PARSE_BUDGET_BYTES`
(`src/cli/reset-io.ts`), whose default is machine-scaled rather than a flat
4 GiB: `min(totalmem, cgroup limit) / 4`, clamped to a 4 GiB floor and a
32 GiB ceiling, with a known cgroup limit below the floor winning outright.
That variable governs the reset/migration parse admission and is unchanged by
163. The wire ledger's `H` is a separate process-wide budget for wire
materialization; the two are never conflated, aliased, or defaulted from each
other, and U4 ships `RBOX_PROCESS_BUDGET_BYTES` as a genuinely new knob with
its own doctor line.

`F_runtime` is
`align4096(max(8 MiB,ceil(1.25 * M)))`, where `M` is the maximum unattributed
live-byte increase measured across the isolated supported-Bun boundary fixture
suite after subtracting every other term. It is generated and frozen per
supported Bun/V8 build before U4 can enable; a runtime with no calibrated value
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
`MAX_MANIFEST_BYTES` is enforced at **zero** call sites today — it is a
definition in `src/engine/manifest-validate.ts` plus a re-export in
`src/engine/index.ts`, with no comparison, no throw, and no test referencing it
(v6 R4-CODE item 12; v5's "not an effective admission at every call site"
understated this — the constant is dead). U4 makes it an explicit outgoing pre-materialization cursor
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

#### The read-time barrier is insufficient on its own: the degraded-unlocked writer (v6 R4-CODEX 2, CRITICAL)

V5 assumed every legacy writer operates under the workspace/state fence. It
does not. Verified against `main`:

- `degraded-unlocked` is a **supported** locking health state
  (`src/cli/sync-mutex.ts:85-88`), entered when `acquireLock` returns
  `unsupported` — i.e. the filesystem offers no safe identity/link primitive.
  The handle carries no lock and prints "workspace locking unavailable …
  continuing with legacy state saves".
- In that state pull and push pass `forceLegacy`
  (`src/cli/sync/pull.ts:446`, `src/cli/sync/push.ts:540,:580,:895`), and
  `sync-state.ts:346-352` short-circuits **before the entire CAS loop**:
  compose from the in-memory snapshot, `saveStateUnsafeLegacyOrTest`, return.
- The terminal write (`sync-state-store.ts` `writeWholeStateUnsafe`) performs
  only `mkdir`, `writeFileAtomic` (rename-over), and `fsyncDirectory`. No
  `lstat`, no re-read of `state.json`, no state lock, no owner recheck.

Therefore an operation that read the state **before** `Q` existed will happily
rename a whole JSON document over `Q` after M6, destroying the sole authority
marker; the invalid-JSON refusal only protects operations that *read* after Q.
Worse, the degraded composition deliberately drops the lineage fence
(`stateNonce`, `stateRevision`, and `repoRecords` are all set to `undefined`),
so the resulting file is a valid-looking, fence-free legacy state.

Two facts bound the severity without removing it: reset itself refuses to run
degraded (`reset-state.ts`, `sync-state-store.ts`, `sync-mutex.ts` all require
a non-degraded fence), and degradation is a filesystem-capability property, so
a degraded workspace is typically degraded for every process. The realistic
exposure is a long-running degraded sync (daemon or CLI) that straddles the
authority flip — and, independently, two concurrent degraded syncs already
clobber each other's `state.json` today.

**Normative v6 closure — a hard pre-U0 gate.**

1. **The barrier ships and bakes in the stable 1.x line before any migration
   is enabled.** The barrier is not merely a read-time check: every production
   state **write** path — including `writeWholeStateUnsafe` and every
   `forceLegacy` caller — must re-check for `Q` immediately before its rename
   and throw `StateFormatTooNewError` instead of publishing. A write-side
   barrier is the only thing that stops an already-running pre-Q operation.

   **1a. The barrier must be race-free, and a bare check-then-rename is not
   (v7).** V6 specified the check without specifying what makes it atomic with
   the publication, which is a real defect: a `Q` written between the check and
   the rename is still destroyed. The closure is argued from the actual
   publication primitive rather than from an invented syscall.

   *The primitive.* Every state write publishes through
   `writeFileAtomic` (`src/engine/fsutil.ts:35-89`): it writes and fsyncs a
   sibling temp, then calls the optional `beforeRename` hook, and **on a `false`
   return it removes the temp and returns without renaming** (`:70-80`);
   otherwise it publishes with a single `fs.rename(tmp, absPath)` (`:83`).
   `beforeRename` is therefore the only publication-abort seam that exists, and
   `sync-state-store.ts` already uses it for exactly this shape of assertion
   (`:216`, `:411`: `beforeRename: async () => (owner = await lock.isOwner())`).
   B0's barrier check is added to that same hook. `rename(2)` replaces its
   target unconditionally, so no property of the hook alone can make the check
   atomic with the rename.

   *Race-freedom therefore comes from mutual exclusion, not from the check.*
   Normative: **every production write of `.rbox/state.json` must hold
   `stateLockPath(root)` continuously from before the barrier read until after
   the rename returns.** Two of the three writers already do
   (`applyStateSavePacket` acquires or asserts the held lock at
   `sync-state-store.ts:120-135`; `ensureTelemetryBindingId` at `:395`), and
   both re-assert ownership inside `beforeRename`, so a stolen or expired lock
   aborts the publication instead of racing it. The one writer that holds
   nothing is `writeWholeStateUnsafe` (`:369`) — the degraded/`forceLegacy`
   terminal write, and precisely the writer this whole closure is about. B0
   changes it to acquire the same lock, read the barrier, publish, and release.
   M6's authority rename runs under the complete lock set, which includes that
   state lock (§ "Durable phase publication and sole actor"), so a `Q`
   publication and a legacy publication cannot interleave: each actor's own
   check-then-rename window lies inside a lock the other must acquire. This adds
   no new primitive and no new file — it extends an existing lock discipline to
   the one path that skipped it.

   *The unlocked residue is refused, not raced — except in one case, which v8
   names rather than argues away.* `degraded-unlocked` exists exactly when
   `acquireLock` returns `unsupported` (`src/cli/sync-mutex.ts:85-88`), i.e. the
   filesystem offers no safe identity/link primitive — so on that filesystem
   **no** check-then-rename sequence can be made atomic, and the design does not
   pretend otherwise. B0 makes the degraded path fail closed instead: under
   `degraded-unlocked`, `writeWholeStateUnsafe` performs the barrier read in
   `beforeRename` and refuses to publish over `Q` or over any non-JSON legacy
   path. M0 then refuses to migrate a `degraded-unlocked` workspace at all
   (bullet 3 below) and re-checks that predicate immediately before the M6
   rename.

   **V7 concluded from that pairing that "there is no third case". That was
   false.** V7 rested on "degradation is a filesystem-capability property", but
   `writeWholeStateUnsafe` is reached by **two** disjunctive conditions,
   `unsupported` locking *and* `forceLegacy`, and nothing made the second a
   property of the filesystem. A writer can therefore be inside an unlocked
   check-then-rename window **on a perfectly lockable filesystem** — exactly the
   workspace M0 admits. That is the third case.

   *Closure, part one — collapse every closable instance of it into case 1.*
   Normative for `B0`: the unlocked publication path may be entered **only**
   when `acquireLock` returns `unsupported` for this workspace on this
   filesystem. `forceLegacy` alone does not authorize it, a transient
   acquisition failure does not authorize it, and an expired or stolen lease
   does not authorize it — each of those becomes a typed refusal to publish,
   not a permission to publish unlocked. With that, `degraded-unlocked` finally
   *is* the filesystem-capability property v7 asserted it was, every B0-era
   writer on a lockable filesystem holds `stateLockPath` continuously from the
   barrier read through the rename, and M6's rename holds the same lock. The
   third case has no B0-era instance.

   *Closure, part two — SUPERSEDED BY EXCLUSIVITY (v11). The paired-interval
   live-writer sampling is DELETED as a U3 requirement.* V8 extended M0's
   quiescence predicate with a **writer-liveness observation**: sample the live
   `state.json` five-field content witness and the `last-writer.json` sidecar
   together, wait a bounded interval, re-sample, and refuse with
   `legacy-writer-live` on any state change the sidecar does not account for.
   That mechanism existed to detect a legacy writer running *concurrently with
   a live migration*. Founder decision 5 (`MIGRATION-EXCLUSIVITY-v11`) excludes
   that scenario at the front door — with "exclusivity" defined operationally,
   not as machine quiescence (v11-r2): **the window is exclusive ownership of
   this workspace's mutation locks** (the workspace sync mutex and
   `stateLockPath`), which every `>= 1.11.0` actor acquires before any state
   write. A migration begins only from an admitted entry point — an
   `rbox upgrade` stop window or an explicit foreground `rbox migrate` — and M0
   verifies lock ownership plus the existing pid/ownership evidence, refusing
   with `migration-not-exclusive` otherwise. A daemon or foreground command
   that *starts after* M0's check does not defeat the window: being B0-era, it
   blocks on the locks the migration holds until M7 releases them. What pid
   evidence cannot exclude — a lock-ignoring pre-`1.11.0` actor — is exactly
   the drained population of the `B0` gate, with the retained defense-in-depth
   mechanisms (closure part three, `F2`–`F6`) as the backstop. **The U3
   implementation need not implement the paired-interval sampling.** Lock
   ownership replaces it; a timing probe is not a substitute for holding the
   locks, and running both would have been two gates where one is decisive.

   *Closure, part three — RETAINED AS DEFENSE-IN-DEPTH, no longer load-bearing
   (v11).* V9 made the body-hash re-verification of `.rbox/state.json` against
   the M3-imported source digest the **immediately preceding operation** to
   M6's `fs.rename`, under the `stateLockPath` M6 already holds; a mismatch is
   a typed `legacy-write-detected` disposition that does **not** rename, enters
   C1 source-change retirement, and leaves JSON authoritative. That check costs
   one hash of a file M6 has already read and it stays exactly as specified —
   but it now guards a scenario exclusivity has excluded, so it is a
   belt-and-braces assertion rather than the thing that makes the flip safe.
   V9's supporting argument (that sampling and renaming are two syscall
   sequences and no property of `writeFileAtomic`'s single `beforeRename` seam
   can fuse them) remains true and is not restated at length here; the
   `check → rename` microwindow it bounds is no longer a live threat.

   *The residual outcomes — EXCLUDED BY EXCLUSIVITY, documented and tested
   anyway (v11).* V8/v9/v10 named two outcomes of an unlocked pre-`1.11.0`
   writer whose `fs.rename` lands near M6's — **(i)** post-`Q` destruction,
   detectable as `legacy-overwrite-after-Q` (`F3`); **(ii)** the pre-`Q` lost
   write in the `check → rename` microwindow, unrecoverable and silent (`F5`) —
   plus v10's **ABA** consequence of (ii), where `reconcile`
   (`src/engine/reconcile.ts:60`) classifies `local == stale base` as an
   ordinary remote write and `apply` (`src/engine/apply.ts:287`) silently
   overwrites a user's intentional revert (`F6`). Each is stated in full at its
   fixture below and is **not** restated here. All three are **reclassified
   from "named residual accepted at ratification" to "excluded scenario,
   asserted by fixture"**. All three require, together, a **pre-`1.11.0`
   binary**, the `forceLegacy`-or-`unsupported` unlocked publication path
   (`writeWholeStateUnsafe`, `sync-state-store.ts:338-370`, which takes no lock;
   the ordinary CAS path holds the state lock even pre-B0 at `:120-135`), and a
   rename landing in one of the two windows. Under
   `MIGRATION-EXCLUSIVITY-v11` no such binary is running against the workspace,
   because nothing is: the workspace is parked.

   *Ratification, restated (v11).* V10 ratified this residue as "accepted and
   named", carried by the `B0` adoption gate and the hard U3 drain gate. That
   argument is unchanged and still stands on its own; v11 puts a simpler one in
   front of it — the scenario does not occur because the migration does not run
   while anything else does. Both gates remain, and B0's barrier plus the
   witness floor remain the layers that cover a binary started *later* or a
   workspace whose last writer predates the barrier. The U3 drain criterion is
   not relaxed here; only its data source is named (founder decision 6).

   **1b. The durable last-writer witness.** `SyncState` has no version field
   and B0 must not add one — a new state member would be silently dropped by
   pre-B0 binaries and by the degraded composer, which already nulls
   `stateNonce`, `stateRevision`, and `repoRecords`, so it could not prove
   anything about the writer that wrote last. The witness therefore lives
   **outside** the state document, in a sidecar at
   `.rbox/state/last-writer.json`, whose closed schema is
   `{version:1, writerVersion:"<semver>", writtenAtMs:<integer>,
   stateBodySha256:"<hex64>", stateSizeBytes:<integer>,
   stateMtimeMs:<integer>, stateDev:<integer>, stateIno:<integer>}`.

   **The witness is bound to content, not to an inode (v8).** V7 recorded only
   `dev`/`ino`, which is defeated by the very publication protocol this design
   mandates everywhere: `writeFileAtomic` renames a *new* file over the target,
   the old inode is released, and an inode number is free to be reused by the
   next file the filesystem allocates — including the next `state.json`. A
   dev/ino-only witness can therefore match a document the recorded writer never
   wrote. The witness records the published body's `stateBodySha256` and
   `stateSizeBytes` alongside the identity triple. `.rbox/state.json` carries no
   preamble, so its body hash and its physical hash coincide (the body-vs-
   physical distinction of § M2 applies to preamble-prefixed backups, not to the
   live state), and the hash is taken over the exact bytes just published.

   *Authority on verify, stated so an implementer cannot pick differently.*
   **`stateBodySha256` and `stateSizeBytes` are the authoritative fields**: they
   carry the whole property the witness exists to prove, and a mismatch in
   either is decisive. `stateDev`, `stateIno`, and `stateMtimeMs` are
   **corroborating** — cheap change detection that catches a replacement before
   the hash is computed, and diagnostic detail in the refusal. Verification
   requires **all five to match** and fails closed on any mismatch; the
   distinction is which field is trusted when they disagree, and the answer is
   the content hash: a dev/ino match with a body mismatch is always a refusal,
   and a body match with a dev/ino mismatch is *also* a refusal, reported as
   `barrier-witness-identity-drift` because it means something republished
   identical bytes without maintaining the witness. Nothing anywhere admits a
   witness on identity alone.

   Update protocol: the actor that just published `state.json` writes it
   **after** the publication rename and its `fsyncDirectory`, still holding the
   same state lock, via `writeFileAtomic` plus `fsyncDirectory`, recording the
   body hash and size of the bytes it published and the `dev`/`ino`/`mtime` it
   observes on the just-published `state.json`. It is never authority and never
   read by the sync engine; a failed witness write does not fail the state write
   (the state is already published) and merely leaves the witness stale. Its
   sole consumer is migration admission: M0 admits a workspace only when the
   witness exists, parses exactly, all five state fields match the live
   `.rbox/state.json` — proving the recorded writer wrote *the state that is
   there now*, byte for byte, not some earlier one and not a coincidentally
   identical inode — and `writerVersion >= 1.11.0`, the ratified downgrade
   floor. Anything else (absent, stale, foreign, content-mismatched,
   identity-drifted, lower version) is a typed `barrier-witness-missing`
   refusal, not a halt; the remedy is one ordinary sync with a barrier-capable
   binary, which is exactly the condition the gate is trying to establish. The
   witness is **retained in v11** — it is cheap, it is already shipped in B0
   (#539), and it proves a fact about the workspace's history that exclusivity
   does not address. B0's pinning inventory test (contents
   item 2) is extended to require both obligations of every enumerated write
   entry point: it checks the barrier, and it updates the witness.
2. That barrier release is a scheduled **pre-U0 deliverable** with an adoption
   gate (see the rollout plan's `B0` unit), not a footnote inside a U-slice.
   No 2.0 binary may migrate a workspace until the barrier version is adopted
   by all 4 external users and all 3 fleet hosts.
3. **M0 quiescence and capability predicate — the single normative predicate
   (consolidated in v7).** Before publishing its first control, M0 requires,
   under the complete lock set, **exactly these five conditions and no others**;
   every other section that mentions an M0 admission condition refers here
   rather than restating a partial list (v6 had two divergent versions of this
   predicate — one including quarantine enumeration, one omitting it — which is
   how a fail-closed gate quietly becomes two gates):
   - workspace locking health is **not** `degraded-unlocked` (a degraded
     workspace is refused with a typed `degraded-fence` refusal, matching what
     reset already does);
   - no other live rbox process holds or recently held a workspace operation —
     established by the existing daemon/lock ownership evidence plus a bounded
     wait, not by a heuristic;
   - **no resumable quarantine bundle exists.** `.rbox/state/quarantine/` is
     enumerated with the same bounded, no-follow discipline; a bundle in any
     state other than absent refuses migration with a typed
     `quarantine-pending` refusal, whose remedy is the doctor's existing resume
     path (§ "Committed quarantine retains deletion authority", which owns the
     reasoning and delegates the predicate to this list);
   - the barrier-capability witness is present and current: the
     `.rbox/state/last-writer.json` sidecar specified in 1b parses exactly, all
     five of its recorded state fields (`stateBodySha256`, `stateSizeBytes`,
     `stateMtimeMs`, `stateDev`, `stateIno`) match the live `state.json` under
     the authority rule stated there, and its `writerVersion` is >= the ratified
     `1.11.0` downgrade floor. A workspace whose most recent writer predates the
     barrier is refused until it has been written once by a barrier-capable
     binary;
   - **the exclusivity window is proven (v11 — replaces v8's live-writer
     sampling).** `MIGRATION-EXCLUSIVITY-v11`: M0 admits only when its caller is
     one of the two admitted entry points (inside `rbox upgrade`'s per-workspace
     stop window, or an explicit foreground `rbox migrate`) **and** M0
     independently confirms no daemon is live for this workspace from the
     existing pid-record/ownership evidence. Otherwise it refuses with a typed
     `migration-not-exclusive` refusal, publishing no control and creating no
     artifact. **The bounded-interval paired sampling and its
     `legacy-writer-live` refusal are deleted** — see § 1a closure part two.
   All five are re-checked immediately before the M6 rename, not only at M0.
   M6 additionally re-verifies `.rbox/state.json`'s `stateBodySha256` against
   the M3-imported source digest as the **immediately preceding operation** to
   `fs.rename`, under the `stateLockPath` it already holds; a mismatch is a
   typed `legacy-write-detected` disposition that does not rename and enters C1
   retirement with JSON still authoritative. Retained as defense-in-depth
   against a scenario exclusivity excludes (§ 1a, closure part three).
4. **Fixtures (required before U3 may be enabled) — corrected in v8.** V7
   specified one fixture that **cannot be constructed**: it started a
   *degraded-unlocked* legacy writer and then required "a full M0–M7 migration
   to completion", while bullet 3's first condition refuses to migrate a
   degraded-unlocked workspace at all. The fixture asserted an outcome the
   design forbids reaching, so it could only ever have been deleted or
   quietly weakened by whoever tried to write it. The matrix is now six
   fixtures (v9 adds `F5`; v10 adds `F6`), each testing what the machine
   actually does. **Framing changed in v11, contents not.** `F1`–`F6` are
   retained in full as regression nets, but they now test **excluded
   scenarios**: under `MIGRATION-EXCLUSIVITY-v11` no lock-respecting actor can
   mutate this workspace's state while the migration holds its locks, so
   `F2`–`F6` construct a concurrency only a lock-ignoring pre-`1.11.0` actor
   (the drained population) could produce. They stay because they are cheap, because they pin B0's shipped
   refusal machinery (#539), and because a fixture is the only thing that stops
   a documented outcome from silently drifting. Read every "named residue"
   below as "excluded by exclusivity, tested anyway":
   - **F1 — the degraded fence does what M0 says.** A degraded-unlocked
     workspace with a live legacy writer: M0 must refuse with a typed
     `degraded-fence` refusal, publishing no control and creating no migration
     artifact. Negative control: with the fence predicate removed, M0 proceeds —
     proving F1 exercises the fence rather than some unrelated refusal.
   - **F2 — the real third case, on a lockable filesystem.** A `forceLegacy`
     writer on a lockable filesystem, suspended after its state read, then a
     full M0–M7 migration to completion, then the writer resumes. With `B0` the
     writer must fail closed with `StateFormatTooNewError` and leave `Q`
     byte-identical — because part one of the closure forces it to hold the
     state lock, so it cannot even reach its rename while M6 holds that lock,
     and its post-lock barrier re-read sees `Q`. Negative control: with the
     barrier and the lock-entry restriction removed, the same fixture must
     demonstrably destroy `Q`.
   - **F3 — named residue, outcome (i): post-`Q` destruction.** F2's shape, but
     the legacy writer is the published, signed `1.10.x` artifact rather than a
     `B0` build, and it is released strictly *after* M6's rename. The assertion
     is the *documented* result, not a pass: `Q` is destroyed, and the doctor
     reports `legacy-overwrite-after-Q` naming the immutable hash-addressed
     backup. A residue that has a red-to-green fixture cannot silently change
     into a different residue.
   - **F4 — concurrency, unchanged from v7.** Two concurrent degraded writers:
     assert the refusal, not merely last-writer-wins.
   - **F5 — named residue, outcome (ii): the pre-`Q` lost write (v9).** F3's
     binary (the signed `1.10.x` artifact, `forceLegacy`, lockable filesystem),
     but released so its `fs.rename` lands inside M6's `check → rename`
     microwindow — driven deterministically by the `onStep` seam
     (`fsutil.ts:46`, `"before-rename"`) on the migration side rather than by
     sleeping, so the fixture is not itself a race. The assertions are the
     documented outcome: after M7, `.rbox/state.json` is `Q`; the migrated DB
     and both M2 backups carry the *older* source digest; the legacy writer's
     document is **absent from every artifact on disk**; and the doctor emits
     **no** anomaly — `F5` asserts the silence explicitly, so a future change
     that starts detecting this turns the fixture red and forces the doc to be
     updated rather than letting the claim drift. Companion assertion, one
     window earlier: with the writer released *before* M6's body-hash re-verify
     instead of after it, M6 must refuse with `legacy-write-detected`, not
     rename, and leave JSON authoritative — proving the part-three check is what
     bounds the microwindow rather than something else.
   - **F6 — the ABA consequence of outcome (ii) (v10).** Extends F5 past the
     migration: with the lost save being the BASE advancement for a path (the
     legacy writer had applied remote `B1`), the fixture then reverts the file
     on disk to its `B0` contents and runs the post-flip pull against remote
     `B1`. The asserted *documented* outcome is the silent overwrite: `reconcile`
     returns an ordinary `write` (`local == stale base`), `apply` replaces the
     file with no conflict copy, and no anomaly is emitted. Like F5, the fixture
     asserts the silence — a future mechanism that turns this case into a
     conflict (e.g., BASE-generation stamping) turns F6 red and upgrades the
     residue's documentation rather than letting it drift.

The source bytes are retained exactly at the fixed convenience path
`.rbox/state/legacy-json/pre-163-latest.json.bak` (v6 moved it off
`.rbox/state.json.pre-163.bak`; see the abort section below) and in an
immutable, hash-addressed history at
`.rbox/state/legacy-json/<source-sha256>.json`. Both carry the v6
`RBOX-LEGACY-STATE-BACKUP-v1` preamble, so neither parses as a state file.
The backup set is recovery
evidence, never authority and not a downgrade protocol. The fixed path always
matches the JSON used by the completed active migration; an earlier fixed
backup is first preserved under its verified hash before the fixed path is
replaced. Thus running the JSON kill switch and changing state after an aborted
M5 cannot make the next migration permanently collide with the prior backup.
There is no automatic downgrade/dual-write path. After `Q`,
`RBOX_STATE_SQLITE=0` hard-errors; a future fenced legacy export is a separate
design.

#### Supported abort procedure and the `.pre-163.bak` footgun (v6 R4-CODEX 6 + R4-ROLLOUT B3)

Declining an automatic downgrade is defensible. Leaving the operator with
nothing while shipping a permanent, fixed-path, full copy of the pre-migration
state is not — `.rbox/state.json.pre-163.bak` sits at exactly the path a person
restores when a host wedges, and restoring it destroys `Q` and silently
re-elects a stale JSON BASE. Verified: `SyncState` has **no** version or schema
field; `loadRawState` is `JSON.parse(...) as SyncState` behind a size/RSS bound
with no structural validation; and the load path checks only `stream` equality
(a same-workspace backup passes) with no freshness comparison. The write-path
CAS compares an in-flight packet against whatever is on disk, so a restored
copy supplies its own matching `stateNonce`, and the sequence guard
(`sourceGlobalSeq < current.lastSyncedSequence`) becomes *more* permissive as
`lastSyncedSequence` goes backwards. A restored `.bak` is therefore accepted
silently, with a stale sequence against an advanced server — the mass-delete
shape. "Recovery evidence, never authority" is a property the filesystem does
not enforce, so v6 enforces it structurally.

**1. The fixed convenience path is renamed and made non-restorable in place.**
The fixed backup moves from `.rbox/state.json.pre-163.bak` to
`.rbox/state/legacy-json/pre-163-latest.json.bak` — inside the state
directory, out of the `.rbox/state.json` naming neighbourhood, and away from
tab-completion next to the live path. Its content is unchanged and the
immutable hash-addressed history is unchanged.

**2. Restoration by copy is structurally refused, not merely discouraged.**
Every backup file (fixed and immutable-history) is written with a mandatory
one-line ASCII preamble before the JSON document:

```text
RBOX-LEGACY-STATE-BACKUP-v1 <source-sha256>
```

A file carrying that preamble is not valid JSON, so a barrier-capable 1.x
binary and every 2.0 reader refuse it exactly as they refuse `Q` — with a
typed error naming the supported procedure rather than a parse failure. The
recorded `source-sha256` still lets the operator and doctor prove which JSON a
backup is. Migration verification hashes the JSON body after the preamble, so
M2's witness semantics are unchanged.

**3. There is one supported abort procedure, and it is whole-workspace.**

- **Before `Q`** (any halt in M0–M5): abort is
  `rbox doctor --abort-state-migration`. Under the complete lock set it runs
  the existing C1 source-change retirement vector to completion against its own
  migration id, unlinks the control last, and leaves exact `L` untouched and
  authoritative. JSON was authoritative the whole time; nothing is restored
  because nothing was replaced. This is the abort path for essentially every
  case, because migration is fenced so that JSON stays authoritative until one
  atomic rename.
- **After `Q`**: there is no in-place downgrade, and 163 does not add one. The
  supported recovery is **re-adoption**: stop the daemon, move the workspace's
  `.rbox` aside, and re-adopt the workspace with a binary of the operator's
  chosen version, which re-derives BASE from the server. This is the same
  procedure the fleet already uses for an unrecoverable local state, it costs a
  full re-scan and no user data, and it does not depend on any backup being
  authoritative. Doctor prints exactly this procedure on any post-Q authority
  halt.
- A fenced legacy export (`streamLegacyExport`) remains future work and is the
  only mechanism that could ever make a post-Q downgrade in place supported.
  Until it exists and is separately reviewed, doctor must never suggest
  restoring a backup, and the backup preamble above makes an unadvised attempt
  fail loudly.

**4. Exact downgrade floor — RATIFIED `1.11.0` (founder, 2026-07-28).** The
supported downgrade floor is **`1.11.0`**, the first stable release that ships
the write-side `Q` barrier (§ the degraded-writer closure above). This is no
longer provisional: the founder ratified the number on 2026-07-28, so `B0`
ships *as* `1.11.0` rather than "whatever `B0` turns out to be", and both the
M0 barrier-capability witness (1b) and the 2.0 release notes cite that exact
version. Below the floor, a binary's behavior against `Q` is whatever its
guarded JSON parser happened to do and is explicitly unsupported. `main` is at
`1.10.2` today, so the floor is a release that does not yet exist; that is the
point of the pre-U0 `B0` unit.

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
  `.rbox/state/legacy-json/<sha256>.json`, always preamble-prefixed streaming
  copies and never hard links (v7); the JSON body after the v6
  `RBOX-LEGACY-STATE-BACKUP-v1` preamble must hash to the filename, while the
  whole-file physical hash carries artifact identity.
  The fixed `pre-163-latest.json.bak` is replaceable only after its bytes exist
  in history.
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
| `M2` | exact immutable-history path plus its body and physical hashes, exact fixed-backup path plus its body and physical hashes (both preamble-prefixed copies, never hard links — v7), both parent-fsynced, plus `stagingMain` equal to `"absent"` or `{dev,ino}` (the same-phase revision after M3's durable exclusive create) |
| `M3` | exact committed `migration_completion` tuple/digest and the recorded durable staging-main identity |
| `M4` | staging physical SHA-256/bytes, `S0`, semantic digest/counts, DDL/application/schema/FK/integrity proof version |
| `M5` | the same physical witness at active `state.db`, active `S0`, `stagingMain:"absent"`, post-convergence state-parent fsync, and the prebound Q-sibling path/bytes plus its `absent|building|exact` same-phase disposition |
| `M6` | exact `Q` authority id, Q sibling absent, matching active completion/physical witness, `.rbox` parent fsync, and the closed same-phase cleanup cursor below |
| `M7` | all migration-id cleanup items `retired`, all non-control artifacts absent/exact-terminal (with the role-5 inert control temp exact-terminal by definition — see below), and every affected parent fsynced |

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
role order: the generic reserve first and the emergency resource last (v7 —
the inventory below shows that no other role can contribute an M6 cleanup item,
so the "private/migration-id artifacts first" clause described a set that is
always empty at M6); it records each exact path/identity and parent.
Q sibling is already absent and active DB/control/source backups are never
cleanup items. M6 publication starts at prefix zero with no intent.

**Literal cleanup inventory (v6 R4-CODEX 5).** V5 called this set closed but
never enumerated it, and the C1 vector repeated the same undefined
"private/migration-id artifacts" category. The set is exactly the rows below,
in this order; a role with no M6-present artifact contributes no item, and no
other path may ever enter the vector.

**Reconciled with M0–M7 in v7.** V6's first version of this table contradicted
the machine in three places, each of which is corrected below rather than left
for an implementer to arbitrate: it admitted live staging artifacts at M6
though M5 cannot complete without them being gone; it placed the prepared
halted-M6 sibling *before* the resources whose cleanup creates it; and it
auto-removed an inert control-publisher temp, which the doctor-only inert-temp
rule forbids. The table now distinguishes **asserted absences** (roles that can
never contribute a cleanup item, and whose presence at M6 is corruption) from
the **two actual cleanup items**.

| # | Role | Canonical path | Admitted starting disposition at M6 | Cleanup item? | Terminal disposition |
|---|---|---|---|---|---|
| 1 | staging rollback journal | `.rbox/state/state.db.migrate.<migrationId>-journal` | absent only | no — asserted | absent (already) |
| 2 | staging WAL | `.rbox/state/state.db.migrate.<migrationId>-wal` | absent only | no — asserted | absent (already) |
| 3 | staging SHM | `.rbox/state/state.db.migrate.<migrationId>-shm` | absent only | no — asserted | absent (already) |
| 4 | staging main (redundant name after the M5 rename) | `.rbox/state/state.db.migrate.<migrationId>` | absent only | no — asserted | absent (already) |
| 5 | control publisher temp | `.rbox/state/migration-v1.json.<controlRevision>.tmp` for any revision of this migration id | absent, or exact inert regular temp | no — doctor-only | **exact-terminal by definition** (v8): unchanged by M6/M7, and M7's "absent or exact-terminal" predicate is satisfied by that unchanged inert temp; doctor's inert-temp quarantine still owns removal |
| 6 | prepared halted-M6 sibling | `exactRevisionScopedPath(b+5)` | not yet created at the M6 cleanup start; created by the final-item runway below | no — M7-terminal | the `exact-or-absent-terminal` descriptor already specified; retired by M7 |
| 7 | generic reserve | the M1-recorded 1 MiB reserve path | `available`, `cleanup-intent`, or `cleanup-absent` | **yes — first** | `retired` |
| 8 | emergency halt candidate | the M1-recorded id-bound emergency path | `available`, `cleanup-intent`, or `cleanup-absent` | **yes — final** | `retired` |

Item 8 is the final item and therefore owns the allocation-free runway below;
item 7 is the only nonfinal cleanup item, so the ordered cursor
(`durablePrefix`, `currentIntent`) ranges over exactly two positions. Why each
non-item is a non-item:

- **Roles 1–4 are absent by the time M6 exists, as a consequence of the machine
  rather than of cleanup.** M4 requires `S0` — all three sidecars absent —
  twice, before and after verification, and M5 renames the staging main over
  `state.db` and then "require[s] staging absent" before publishing, with the M5
  witness recording `stagingMain:"absent"`. A present staging artifact at M6 is
  therefore not debris to be swept but a contradiction of the witness that
  admitted M6: it is a `reserved-path` corruption halt with zero writes, on the
  same footing as every other artifact-behind observation. They are listed
  because the inventory is closed and must name what it asserts, not because
  anything deletes them. Their pre-M5 forms remain live in the C1 retirement
  vector, which is where a staging artifact can legitimately still exist.
- **Role 5 is an inert temp, and inert-temp removal is doctor-only.** The
  crash-table `absent` row already states the rule ("explicit doctor may
  quarantine inert temps later"), and enumerating "any revision of this
  migration id" would require directory discovery, which the cleanup vector
  explicitly forbids ("no other path may ever enter the vector"). V6's row did
  both. A stranded control temp is inert by construction — it never coordinates
  or suppresses anything — so leaving it is safe, and the doctor's existing
  inert-temp path is the one remover.

  **Role 5's terminal disposition, reconciled with M7 (v8).** V7 left role 5
  doctor-only and stopped there, which contradicted M7's witness requirement
  that all non-control artifacts be "absent or exact-terminal": an inert
  publisher temp can survive M6 and M7 unchanged, so a migration could satisfy
  every phase and still fail its own M7 witness. The resolution is definitional,
  and it deliberately **widens no classifier**: for a role-5 path, *exact
  inert temp* **is** the exact-terminal disposition. M7 asserts it by `lstat` of
  a closed, named set of paths — one per revision in this migration's own
  published revision range, which the control already records as a bounded
  monotone integer interval — and requires each to be absent or a regular
  non-symlink file. No directory discovery is introduced (the cleanup vector's
  prohibition is untouched), no new artifact role is admitted, and the reset
  namespace inventory, the C1 retirement vector, and the crash-table `absent`
  row are all unchanged. The doctor's later inert-temp quarantine remains the
  only remover, and running it after M7 changes an already-terminal disposition
  to `absent`, which is the other admitted value — so doctor cleanup can never
  invalidate a completed M7 witness.
- **Role 6 does not exist yet when M6 cleanup starts.** It is rendered at
  revision `b+5` by the final item's own runway, i.e. strictly after item 7 has
  been retired and while item 8's intent is durable, and it is retired by M7's
  terminal descriptor. Placing it at position 6 described an artifact being
  cleaned before the step that creates it.

Explicitly **not** cleanup items, in any branch: the
active DB, the control record itself (retired last, separately), `Q`, the Q
sibling (already absent at M6), the fixed and immutable legacy-JSON backups,
`cache-v1-retired/` parked caches (owned by U4's cache retirement, not by
migration), every legacy reset artifact in the retained-JSON branch, and roles
1–6 above for the reasons just given.

The C1 source-change retirement vector uses the same eight roles plus the
recorded Q sibling and any exact prepared active DB, exactly as its own table
already prints — but it runs *before* M5, so roles 1–4 are live members there
rather than asserted absences (which is precisely why they are roles at all).
"Private/migration-id artifacts" in that table means role 5 here and nothing
else, and only those revision-scoped siblings whose exact path and identity the
retiring control record itself names: C1 arms an enumerated vector, so it never
discovers a temp, and it therefore does not reach the discovered inert temps
that remain doctor-only. Role 6 cannot exist before M6 and is never in the C1
vector.

Before removing item `k+1`, the controller CAS-publishes the same M6 phase with
`currentIntent:k+1`; a resource changes from `available` to `cleanup-intent` in
that revision. Only that item may then be exact or absent. For every nonfinal
item, unlink+parent fsync is followed by the next M6 revision recording
`cleanup-absent` and advancing the prefix. Earlier items must be
cleanup-absent, later items exact/available, and absence without current intent
is corruption.

The final item has an allocation-free publication runway. **Amended in place by
v5, restated by v6 (R4-CODE item 14):** the phrase below said "after its intent
is durable at revision `r`", which was written before the V5 preparation ledger
existed. Under v5/v6 the final intent becomes durable at `b`, the pair is
rendered across `b+1..b+4`, and `r` is defined as the runway-ready revision
`b+4`. Read "after its intent is durable at revision `r`" as "at the
runway-ready revision `r=b+4`, whose intent has been durable since `b`". After that, but **before** unlink, the controller renders two
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
clears the halt and the controller ~~rebuilds a revision-correct pair~~
**revalidates and reuses the exact existing pair** before retrying.
**Superseded in place by v5, flagged by v6 (R4-CODE B5 / R4-CODEX 7):** v4's
"rebuilds" wording authorized creating a replacement pair. V5 forbids that —
creating a replacement pair, clearing to a different M6 revision, or retiring
the prepared M7 before use are all forbidden — and this paragraph is amended
rather than left to be read literally by an implementer. If preparing either
future sibling fails initially, the final item
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

**Named scoped exception to f6 (v6 R4-CODE item 13).** Design 163 otherwise
promises that every write handles ENOSPC with a durable typed halt. The
`b..b+4` preparation runway deliberately does not: a caught ENOSPC anywhere in
it publishes no alternate control, so the operator sees `durableHalt=false`
and an in-memory halt only. This is a bounded, intentional forfeiture, not an
oversight — publishing a durable halt during preparation would require the
allocation the runway exists to avoid, and would reintroduce the ENOSPC cycle
the pair was built to break. Its blast radius is exactly five revisions of one
M6 cleanup cursor, after Q, with SQLite already authoritative and the final
cleanup item still exactly present; restart resumes the same ledger stage. The
scope of the exception is: no durable halt record, no suppression across
processes, and therefore one retry attempt per explicit process start until
space exists. It is recorded here so f6's closure line is honest.
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

Migration runs only inside a proven `MIGRATION-EXCLUSIVITY-v11` window (v11),
after standing-reset recovery, under the non-degraded
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
   hash-addressed history path as a **bounded streaming copy carrying the
   mandatory `RBOX-LEGACY-STATE-BACKUP-v1 <source-sha256>` preamble.
   Hard-linking is forbidden (v7)** — v6 folded the preamble and left this
   sentence's "verified hard link" alternative standing, and the two cannot both
   be true: a hard link is the source's own bytes, so it cannot carry a
   preamble, it would make the "immutable" history mutate whenever a 1.x writer
   wrote through the same inode, and the restoration refusal the preamble exists
   to guarantee would not apply to it. Every backup file, fixed and historical,
   is a preamble-prefixed copy. Two distinct hashes follow, and the design uses
   them consistently: the **body hash** is SHA-256 of the JSON document after
   the preamble line, equals the source file's own hash, and is what names the
   history file and appears in the preamble; the **physical hash** is SHA-256 of
   the whole backup file including its preamble, and is what identity-brackets
   the artifact and is recorded in the M2 witness. Wherever a digest references
   a backup, it is the body hash for provenance and the physical hash for
   artifact identity; they are never interchanged.
   If fixed `.bak` is absent/exact, publish/reuse it. If different but valid,
   first preserve it under its own verified body hash, fsync path+directory,
   then atomically replace fixed backup and fsync `.rbox`. No unique bytes are
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
   includes the recorded building/exact sibling; it never renames. **Then, as
   the last operation before the rename and with no other work between them
   (v9), re-verify the live `.rbox/state.json` `stateBodySha256` against the
   M3-imported source digest under the held `stateLockPath`.** A mismatch here is
   a typed `legacy-write-detected` disposition on the same C1-retirement footing:
   zero writes, no rename, JSON stays authoritative. This does not make the pair
   atomic — `writeFileAtomic` exposes only `beforeRename` and cannot fuse a read
   of a different file into the rename syscall — it reduces the exposure to the
   `check → rename` instants. Under `MIGRATION-EXCLUSIVITY-v11` that residue is
   an excluded scenario (only a lock-ignoring pre-`1.11.0` actor reaches it);
   it remains documented as defense-in-depth in § 1a's retained closure
   passages and asserted by fixture `F5`. Otherwise
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
| exact halted M0–M7 | The same phase/artifact correlation must match; halt never excuses mismatch. Automatic migration/cleanup is suppressed until explicit retry. | JSON before Q; SQLite after Q | Doctor alone may CAS-clear the halt under full locks, then authority transfers to the same 2.0 controller. **One refinement overrides this cell (v5, flagged v6 R4-CODE B5 / R4-CODEX 7):** for an exact final-intent `promotedHalt` on the allocation-free runway, there is no separate durable clear — doctor CAS-validates H and mints a single-use in-process delegation, and the expected-`r+1` rename of the exact M7 sibling **is** the durable clear and phase advance. No other halted row gains that permission. |
| foreign/malformed/inconsistent control or artifacts | No phase inference, cleanup, DB open, sentinel write, or backup restoration. | Existing exact L/Q predicate only, otherwise contradictory | None; zero-write corruption halt. |

An orphan sibling is auto-deletable only when its path, migration id,
application id, authority id, and control record all agree. A foreign or
unreadable reserved path is never deleted. A complete active DB with matching
control/source is prepared-not-authoritative until M6.

### 512 MiB and typed non-looping halts

The legacy guard is unchanged: `>512 MiB` is refused; exactly 512 MiB still
needs 26 GiB of parse headroom before retained object, SQLite cache, staging DB,
WAL, and backup.

#### Supported migratable envelope (v6 R4-CODEX 8)

Retaining the monolithic materialization means migration can safely refuse
precisely the large states that motivated design 163, indefinitely. Safe
refusal is not migration completeness, so v6 states the envelope rather than
leaving it implied:

- **Supported envelope.** A state whose file size `S` satisfies `S <= 512 MiB`
  **and** `52 * S <= min(RBOX_RESET_PARSE_BUDGET_BYTES default, cgroup limit)
  - RSS`. On the founder's 59 MB Mac state that is ~3.1 GiB of headroom
  against a 4 GiB floor — inside the envelope, but not by much, which is why
  the number is written down. Under the default machine-scaled budget, the
  practical ceiling is roughly `budget/52`: about 78 MiB at the 4 GiB floor and
  about 630 MiB (i.e. capped by the 512 MiB hard limit) at the 32 GiB ceiling.
- **Outside the envelope, migration refuses and the workspace stays on JSON**,
  which is exactly today's behavior and is not a regression — but a fleet host
  in that condition can never reach 2.0, so it must be visible rather than
  silent. The refusal is the existing typed `source-oversize` /
  `memory-admission` halt with `durableHalt=true`, and U3 additionally requires
  a plain-English doctor entry that says: the workspace is too large for
  in-place migration on this machine, name the measured size and required
  headroom, and give the two supported remedies — run the migration once on a
  machine with more memory, or re-adopt the workspace.
- **`RBOX_RESET_PARSE_BUDGET_BYTES` is the sanctioned escape hatch** for a
  one-off migration on a machine whose real memory exceeds its default budget.
  Raising it is an operator action with a doctor-printed exact value; 163 adds
  no automatic raise.
- **Streaming import is recorded as future work, not folded.** A streaming
  JSON importer would remove the 52× multiplier from the migration path
  entirely and lift the envelope to the 512 MiB file cap on any machine. It is
  deliberately out of 163's scope because it would require a second
  hostile-input JSON machine on the authority path, and the bounded reset
  decoder above (512 KiB documents) is not reusable at 512 MiB. The refusal UX
  above is the contract until that design exists. `statfs` budgets worst-case streaming backup/history copy,
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
halt under the complete lock set and delegates to the same controller —
**except** for the exact final-intent `promotedHalt` on the allocation-free
runway, where the prepared-M7 rename is itself the durable clear (the narrow
v5 specialization; see the amended crash-table cell above). Before
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
class (including reserve/halt publication and cleanup) and the M2
preamble-prefixed backup streaming-copy path (v7: there is no hard-link
fallback to inject any more),
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
  branch_base_origins_cjson NULL,
  packed_refs_identity NULL, pending_cjson NULL,
  repo_absent NULL CHECK(repo_absent=1),
  removed_key NULL, resolution_key NULL,
  cfg_synced NULL, cfg_applied NULL,
  cfg_token_cjson NULL, cfg_shape_cjson NULL,
  deferrals_cjson NULL, partial_cjson NULL,
  attempt_cjson NULL, resolution_receipt_cjson NULL,
  idx_proj NULL, extras_cjson,
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

Every `RepoRecord` field maps one-for-one. **The list below is rebased on the
current interface (`src/cli/sync-state-model.ts:288`), member by member, in
declaration order** — v5 and v6 both carried a list that predated three live
members, and v6's review log claimed a closure its normative text never made:
required `repoGen`/`sourceSeq`, then optional `base`, `advertised`,
`branchBaseOrigins`, `packedRefsIdentity`, `pending`, `repoAbsent`
(true-or-absent), `removedKey`, `resolutionKey`, `cfgSynced`, `cfgApplied`,
`cfgToken`, `cfgShape`, `deferrals`, `partial`, `attempt`, `resolutionReceipt`,
and `idxProj` — nineteen members, matching the nineteen field-carrying
`repo_records` columns above one-for-one (the remaining columns are the
lineage/path key, `extras_cjson`, and the two recomputed size columns).
A missing record has logical `{repoGen:0,sourceSeq:0}`. NULL is field absence; an empty canonical
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

#### Newly named members and strip-on-read semantics (v7, R4-CODE B3 + R4-CODEX 1)

The three members v5/v6 omitted are live today and are normative columns above,
not extras:

- **`packedRefsIdentity?: {mtimeMs:number}`** -> `packed_refs_identity`. A
  refuse-only restore detector for the common store's `packed-refs`. Stored as
  the canonical one-key object (not a bare number), so a future second member
  cannot be mistaken for a schema change; NULL is absence, and absence is
  semantically distinct from a recorded identity because absence means "no
  refusal evidence", never "unchanged".
- **`attempt?: GitHeldAttempt`** -> `attempt_cjson`. The design-174/200
  local-only held-follow observation: `incomingKey`, both
  `effective*IndexProjection` nullable projections,
  `incomingIndexArtifactDescriptor`, `localFingerprint`, `fingerprintVersion`,
  optional `worktreeRegistryDigest` (whose absence is itself load-bearing — a
  missing digest is never eligible for held-skip, so absent-versus-empty must
  survive the round trip), ordered `reflogs` entries, and the complete ordered
  `blockers` union. Never wire-visible; the wire composer excludes it exactly
  as it excludes `idxProj`.
- **`resolutionReceipt?: GitResolutionPublicationReceipt`** ->
  `resolution_receipt_cjson`: `repo`, `attemptedGitIncomingKey`,
  `attemptedSequence`, `confirmedReportHash`, all four required. It is durable
  proof that a synchronous keep-mine publication may have reached the server, so
  dropping it is a correctness loss, not a cosmetic one; the migration
  round-trip fixture asserts it explicitly.

**`resolutionIntent` is stripped before the digest, and is never `extras_cjson`.**
It is a `<=1.7.18` obsolete member that `stripObsoleteResolutionIntents`
(`src/cli/sync-state-model.ts:363`, with the defensive projection at `:404`)
removes on every disk read, because every read funnels through `loadRawState`.
Its normative disposition here: the named `state-semantic-v1` v1 normalization
applies that same strip to the **source** JSON *before* the source semantic
digest is computed, and the importer discards it rather than routing it into
`extras_cjson`. Consequences, all deliberate: source digest and SQL round-trip
digest agree without a special case; `source_shape_flags_cjson` records no
presence bit for it, so a source that carried it is not reported as a shape
difference; and it can never be resurrected by an `extras_cjson` spread. It is
the one known member that is intentionally *not* preserved, and this is the
only place that exception is granted.

**Schema-rebase gate (so this cannot drift a fourth time).** The compile-time
coverage maps above prove that every `keyof RepoRecord` is *handled*; they do
not prove that this document lists it. U1 therefore ships a test that reads the
`repo_records` column list from the frozen DDL and asserts a total bijection
with `keyof RepoRecord` minus the single named strip-list member
(`resolutionIntent`), failing with the missing names. Adding a `RepoRecord`
field without adding its column — the exact failure that produced this
paragraph — becomes a red test rather than a stale sentence.

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
                            + the legacy-JSON branch, the frozen temp grammar,
                            and hasResetLineageProvenance
src/cli/reset-journal-classifier.ts  owns the closed physical-signature ->
                            row-id table; today P/R/I/Z + Z0, and must gain
                            J0/W1/W2/W3 in U4
src/cli/reset-halt-inspection.ts  8-line re-export adapter over
                            inspectResetJournal; it is retained as the doctor's
                            entry point and gains no logic
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

## Rejected and deferred alternatives (v6, from R4-CODEX)

The R4 codex review listed five simpler alternatives and observed that v5
neither adopted nor rejected them. Silence is not a decision, so each is argued
here.

**1. Make `Q` plus durable M6 terminal authority, leaving a small
identity-bound control artifact for later doctor GC — removing most of the
future-control runway. REJECTED, with the cost acknowledged.** This is
genuinely simpler: it deletes the `b..b+4` ledger, the prepared pair, the
promoted-halt delegation, and the terminal sibling descriptor — the single
most intricate machinery in the document. It fails on one point: it converts
"cleanup is complete" from a durable, correlated, restart-provable fact into a
janitorial promise. A crash mid-cleanup then leaves artifacts that no row
admits, and the classifier must either widen (the thing the keystone forbids)
or halt on debris nobody will ever clean. The runway exists because the final
deletion cannot allocate. Retained, and its cost is priced honestly: five extra
control revisions and one named f6 exception, for one item.

**2. Permanently retain the bounded reserve instead of deleting the last
allocation resource under ENOSPC. PARTIALLY ADOPTED.** Deleting the emergency
resource as the final cleanup item is what forces the allocation-free runway to
exist. Permanently retaining it (1 MiB per workspace, forever) would let M7
publish normally and would delete roles 7–8 — under v7's reconciled inventory,
*both* remaining cleanup items — from the inventory. This is
attractive and v6 does not take it, for one reason: a permanently retained
migration-era resource becomes an artifact of unknown provenance to every
future reader, and the reserve is claimed by M1 from `B0`, which means it is
also 1.x's artifact. **Flagged as a live simplification candidate for U3**: if
implementation finds the runway's complexity is not carrying its weight, the
trade is a documented permanent 1 MiB resident against roughly 200 lines of
this document. That trade is legitimate and pre-authorized here.

**3. Backport `Q`-before-read/write refusal to stable 1.x and bake telemetry
before enabling any migration. ADOPTED IN FULL** — this is `B0`, now a
blocking pre-U0 deliverable with an adoption gate rather than a footnote. The
codex review and the rollout review independently reached this; it is the
single highest-value change in v6.

**4. Make all U3 migration entry unreachable until U2 reset/quarantine support
is complete, rather than merely default-off. ADOPTED.** (Heading corrected in
v8: it said `U4`, while the body below and the gate structure both say `U2` —
reset is `U2` under the v6 resequencing, and `U4a–U4f` is the engine port.) Default-off is a flag;
unreachable is a property. U3's migration entry point is compiled behind the
U2 capability predicate: a build without complete DB-artifact reset/quarantine
support does not merely decline to migrate, it has no code path that can. This
also removes a whole class of "the flag was flipped on the wrong host"
incident.

**5. Backend-first: ship a SQLite authority phase through the already-
centralized state/CAS seam, temporarily retaining a production whole-state
adapter, then replace materialization with cursor ports — rather than coupling
authority migration, engine rewrite, reset conversion, and rollout into one
big-bang 2.0 branch. ADOPTED, with conditions. The U-slice plan below is
restructured around it.**

Provenance, stated plainly: the founder's leaning was "backend-first if the
fold agrees", explicitly conditioned on verified analysis rather than issued as
a decree. V6's first draft had reached a *qualified* yes ("superior for U1–U2,
unavailable for U3–U4") and flagged it as an open question. Re-examining it
against `src/` — rather than against the reviews' description of `src/` —
changed the answer to an unqualified yes and exposed an error in that draft's
own reasoning. Both are recorded below.

The argument for it is strong and v6 does not pretend otherwise:

- The state/CAS seam really is centralized already (`applyStateSavePacket`,
  `loadState`, `repoRecordsForState`), which is precisely what makes a
  backend swap behind it feasible.
- It would produce fleet-observable signal months earlier than the current
  plan, whose first checkpoint is a genesis-path throwaway workspace after
  v5's U2c (the slice now numbered U4c).
- It would let the 1,019-commits-per-60-days `main` keep flowing through one
  codebase instead of a long-lived branch with a port-forward ledger.
- The measured wins (BASE/LOCAL row-local writes, indexed status projections)
  do not actually require the memory rewrite; the cursor discipline of the
  engine slices (v5's U2, now U4a–U4f) is a second, separable win.

**The decisive argument, which neither review made:** backend-first makes the
irreversible step coincide with the *smallest* diff. `Q` is the only one-way,
whole-workspace, cross-binary act in this design. Under v5's ordering it lands
in the same release as a complete engine rewrite, so the release that can never
be undone in place is also the release with the largest possible semantic
differential — precisely the risk R4-ROLLOUT B4 identified and could only
propose to test, not to reduce. Under backend-first the flip lands with the
engine **byte-identical**: same scan, same reconcile, same apply, same push,
same wire output, with only the bytes under the seam changed. The wire-visible
differential at the flip is therefore the run where a difference is *least
expected* — which is what makes it the most informative run of the gate, not an
exemption from it; it is held to the same differential gate as every other
slice (§ U3, "Differential control"), and the engine's semantic changes then
arrive in six small,
independently shippable, independently revertible slices — each of which can be
reverted, because none of them touches authority.

That inverts the natural objection ("you take the irreversible risk before the
payoff"). The irreversible risk is *smaller* when taken early, because it is
taken alone.

Three objections from v6's first draft, re-examined against `src/`:

- **"It contradicts the memory contract."** Half true, and the half that is
  true is bounded. Verified: `StateSavePacket` is already
  `{expectedStream, expectedNonce, sourceGlobalSeq, global?, repos[]}` and
  `StateSaveResult` is already `accepted | rejected(reason) | busy |
  unsupported` (`src/cli/sync-state-model.ts:332-344`) — that is
  structurally the design's `applyCasPacket` and its result union, already in
  production. The **write** path is therefore already a delta, so a SQLite
  store implements it natively as a set-difference into rows: the
  **O(dirty-rows) authority write lands at the flip, not at the end**. Only the
  *read* keeps whole-state materialization, and only until the U4 slices
  replace it. So the adapter phase carries the memory symptom, not the I/O
  symptom, and it carries it for a bounded, gated interval.
- **"The authority flip cannot be phased."** Correct, and irrelevant to the
  ordering. Nobody proposed phasing the flip; backend-first moves it, intact.
- **"Reset conversion is coupled to the artifact format, so U4 cannot lag
  U3."** Correct, and this is the draft's actual error: the right conclusion is
  not "therefore they must ship together at the end" but **"therefore reset
  conversion moves in front of the flip."** Reset/quarantine on `.db` artifacts
  depends only on the store existing — not on any engine port. Sequenced
  first, it also structurally satisfies codex alternative 4: migration entry
  cannot exist before reset support, because reset support ships first.

Feasibility, verified rather than assumed:

- `src/cli/sync-state-store.ts` (460 lines) is the sole disk funnel for the
  engine. `loadRawState` is the single structured reader; exactly four
  functions physically write the state file (`applyStateSavePacket`,
  `writeWholeStateUnsafe` behind `saveState`/`saveStateUnsafeLegacyOrTest`,
  `ensureTelemetryBindingId`, `installGenesisResetStateUnderHeldLock`).
- That funnel is **CI-enforced, not incidental**:
  `src/cli/sync-git/base-composer-structure.test.ts:78,95` pins whole-state
  persistence to a closed per-module allowlist with exact counts, so a new
  write site fails the build today. The swap inherits an existing structural
  guarantee rather than needing a new one.
- `loadState` has 26 production call sites across 9 modules (plus two sites
  that pass it as a value); `applyStateSavePacket` has 7 across 6 modules
  (plus three injected defaults); every one of them resolves through the
  `src/cli/config.ts` barrel, whose surface is itself pinned by
  `config-surface.typecheck.ts`. **None need to change**, because a backend
  swap preserves their signatures. That is the definition of a behind-the-seam
  swap.
- Whole-state coupling is broad by module count but shallow by depth:
  `state.lastSyncedManifest` appears in 22 production modules, but the N-sized
  `.files` array is touched in only four (`ignore-cmd.ts`, `sync/pull.ts`,
  `sync-state-model.ts`, `sync-state-store.ts`). Leaf modules receive an
  already-materialized state as a parameter; they do not load it. U4's cursor
  slices therefore have a small true surface.
- **The one genuine blocker is reset-v1, and it is exactly what U2 exists to
  remove.** `reset-journal.ts`, `reset-state.ts`, `reset-quarantine.ts`, and
  `reset-journal-doctor.ts` (~1,500 lines) do not go through the seam at all:
  they treat `.rbox/state.json` as an opaque byte object with
  sha256-of-file-bytes preconditions, `boundedCopy` archives named by content
  hash, and `fs.rename` as the commit primitive, plus raw `boundedRead`s that
  bypass `loadRawState` (`reset-state.ts:297,463`) and a protocol-lock identity
  derived from the state path. This is precisely the keystone's subject matter
  and precisely why v6 sequences reset conversion **before** the flip: without
  U2, a SQLite backend behind the seam would leave reset operating on a file
  that is no longer authority. Independent verification reached this
  conclusion from the opposite direction, which is why v6 treats the ordering
  as structural rather than preferential.
- The only production code that reads `.rbox/state.json` outside the store and
  outside reset is `doctor-cmd.ts:401`, a diagnostic that parses it directly
  for a health check and substring-matches its own error strings. It is
  already assigned a row in the C4 consumer sweep and must move behind the
  store or become authority-aware.

Conditions attached to the adoption — the plan below is not backend-first
without them:

1. **No-regression gate at the flip.** The adapter keeps whole-state
   materialization *and* adds a SQLite page cache, so the flip could plausibly
   be a memory regression. It may not ship unless trusted `rbox status`
   latency and daemon steady-state RSS on the 112k corpus are **no worse than
   the 1.x baseline**. "No worse" is the bar at the flip; the improvements are
   U4's to earn.
2. **The whole-state adapter is time-boxed and inventoried.** It is the single
   permitted production use of `loadState(): SyncState`. A CI inventory counts
   its call sites, that count may only decrease, and it must reach zero by
   U4f. The compile-time ban on whole-state access elsewhere applies from U1.
3. **The differential rig runs per slice, not once.** The flip's differential
   is the run where a difference is least expected, and it is run as the
   control under the same gate rather than assumed clean; every U4 slice
   then re-runs the same-corpus manifest diff and the two-host rig. This is
   strictly more testing than v5's single differential, spread across smaller
   diffs.
4. **`B0` is unchanged and still blocks everything.** Moving the flip earlier
   moves it *closer* to the barrier dependency, so the barrier's adoption gate
   becomes more load-bearing, not less.

What this costs, stated honestly: the four external users take the one-way
migration in the 2.0 release and receive the latency/memory wins across
subsequent 2.x releases. V6 judges that acceptable because the flip release is
small, gated on no-regression, and recoverable by re-adoption — but it is a
judgment about real users, and it is the residual question at the top of this
document.

What this buys, beyond the risk argument: the `2.0` branch shrinks from "the
whole project" to `U0 → U3` (`B0` ships from `main`), the port-forward ledger
becomes nearly empty, the
U4 slices land on `main` as ordinary 2.x releases, and the first fleet-visible
signal arrives months earlier.

## Rollout, gates, and delivery plan (v6 R4-ROLLOUT)

The correctness core survived five rounds; the rollout was 20 lines and had
been reviewed by nobody. This section replaces it, and v6 reorders it around
the backend-first sequencing adopted above.

**Order: `B0` → `U0` → `U1` → `U2` (reset on DB artifacts) → `U3` (migration +
`Q` flip + whole-state adapter; this is where 2.0 ships) → `U4a–U4f` (engine
slices, ordinary 2.x releases) → `U5` (bake + kill criterion).**

What moved, and what did not. The authority machinery is untouched: M0–M7,
the `Q` predicate and barrier, the migration fencing, the crash/resume table,
the retirement and cleanup subprotocols, and every halt are exactly as
specified above. Only the *schedule* changed — reset conversion moved in front
of the flip (it depends on the store, not the engine), and the engine rewrite
moved behind it (it depends on the flip, not the reverse). V5's numbering
`U2 = engine`, `U3 = migration`, `U4 = reset` is superseded; the mapping is
`v5 U4 → v6 U2`, `v5 U3 → v6 U3`, `v5 U2a–U2f → v6 U4a–U4f`.

Gate structure: **`U0` and `U1` may start immediately** (internal, unshippable,
zero fleet exposure). **`B0` must complete and be adopted before `U3` may be
enabled.** **`U2` must complete before `U3` may begin** — migration entry is
compiled behind the reset-capability predicate, so a build without complete
DB-artifact reset support has no code path that can migrate. **Each `U4` slice
must pass the differential rig before the next begins.**

### B0 — pre-U0 stable-line barrier release (blocking dependency)

Owner: named before U0 starts. Ships on `main` as an ordinary 1.x release,
**`1.11.0` — the ratified downgrade floor (founder, 2026-07-28)**, not a
placeholder to be pinned later.

Contents:
1. Recognize exact `Q` before **every** state read **and every state write**,
   throwing typed `StateFormatTooNewError`. The write side is the load-bearing
   half (see the degraded-writer closure above); a read-only barrier does not
   stop an operation that read before the flip.
2. A pinning inventory test that enumerates every production state
   reader/writer/reset entry point and fails when a new one appears without a
   barrier check.
3. The fsynced 1 MiB generic reserve that M1 later claims — fully specified
   here in v7, because "the reserve" was named in five places and defined in
   none:
   - **Exact path:** `.rbox/state/reserve-1mib.bin`. Fixed, not id-scoped: it
     is generic runway, claimed by whichever migration runs, and `B0` creates
     it long before any migration id exists.
   - **Provenance header (v8; encoding corrected in v9) — the reserve says who
     made it.** V8 specified a 64-byte header carrying the workspace `stream`
     identity verbatim. **That does not fit, so v8's header was unimplementable.**
     The arithmetic, in the same form the rest of this document uses:

     | field | bytes |
     |---|---:|
     | magic `RBOX-STATE-RESERVE-v1` | 21 |
     | separator space | 1 |
     | creating binary's semver, variable | *v* |
     | separator space | 1 |
     | stream field | *s* |
     | terminating `\n` | 1 |
     | **fixed overhead (all but *v* and *s*)** | **24** |

     With a verbatim stream (*s* = 71 for a real workspace) and the shortest
     realistic semver (*v* = 6, `1.11.0`), the header needs `24 + 6 + 71 = 101`
     bytes — 37 over the 64-byte frame. Substituting a full SHA-256 hex digest
     (*s* = 64) still needs `24 + 6 + 64 = 94`, 30 over. Truncating the hex to
     fit 64 leaves `64 − 24 − v` hex characters: 34 (136 bits) for `1.11.0`, but
     only 18 (72 bits) for a release-candidate string such as
     `1.11.0-rc.3+2026072701` (*v* = 22) — a digest whose width depends on the
     version string is not a fixed-width header, and 72 bits is not a
     collision-resistant workspace binding. All three 64-byte forms are rejected.

     **The header is therefore 128 bytes, not 64.** The first 128 bytes are the
     fixed-width ASCII provenance header and the remaining **1,048,448** bytes
     are zero fill; `128 + 1,048,448 = 1,048,576`, so the file is still exactly
     1,048,576 bytes and the allocation guarantee is unchanged. The header is
     the magic string `RBOX-STATE-RESERVE-v1`, one space, the creating binary's
     semver, one space, the **lowercase SHA-256 hex digest (64 characters) of
     the UTF-8 bytes of the workspace `stream` identity**, a newline, NUL-padded
     to 128 bytes. Fixed overhead is `21 + 1 + 1 + 64 + 1 = 88`, so the semver
     field may be **at most `128 − 88 = 40` bytes**; a creating binary whose
     semver exceeds 40 bytes must not create a reserve (it is a
     `reserve-foreign`-adjacent refusal to create, never a truncated header).
     The digest, not the identity, is what the header carries — the reserve
     needs to prove *which workspace*, and a fixed-width binding does that
     without an unbounded field.
     Without provenance the protocol was unsound: `B0` adopted *any* same-size regular
     file, M1 claimed it, and M6 role 7 deleted it — while the same section
     promises never to delete a path `B0` did not create. A same-size file
     written by an unrelated tool satisfied every check, so the promise was
     enforced by nothing.
   - **Creation:** no-follow `O_CREAT|O_EXCL` at mode 0600, write the 128-byte
     provenance header followed by exactly 1,048,448 zero bytes, `fsync` the
     file, `fsync` `.rbox/state`, then lstat and record
     `{dev,ino,size,creatingVersion,streamSha256}`. Creation is attempted once per
     `B0` startup path and its failure is never fatal to the 1.x binary — a
     workspace without the reserve is simply a workspace M1 must create it in.
   - **Collision:** a path is **adoptable** only if it is a regular non-symlink
     file of exactly 1,048,576 bytes **and** its first 128 bytes parse as the
     provenance header — magic exact, semver field well-formed and `<= 40`
     bytes, digest field exactly 64 lowercase hex characters, `\n` present, and
     every byte after the `\n` through offset 127 a NUL — **and** its digest
     field equals the SHA-256 of this workspace's `stream`. Such a file is
     adopted (identity and header fields
     recorded; the zero fill is allocation, not data). **Anything else at that
     path is `reserve-foreign`** — directory, symlink, device, wrong size,
     unreadable, header absent, header malformed, or header naming a different
     workspace. A `reserve-foreign` path is **never adopted, never claimed,
     never truncated, and never deleted, by `B0`, by M1, or by M6.** `B0` halts
     its reserve creation/adoption with the distinct typed `reserve-foreign`
     condition and reports it (halting the reserve protocol only — as above,
     never fatal to the 1.x binary), and M1 refuses migration with the same
     typed condition. The one thing a fixed-path allocation artifact must not do
     is delete something it did not create, and after v8 that is a property of
     the bytes rather than a sentence in this document.
   - **Deletion is header-gated.** M6 role 7 re-reads the 128-byte header
     immediately before unlinking and requires **byte-for-byte equality of all
     128 bytes** with the header M1 CAS-recorded into the control — the same
     equality rule M1 applied on adoption, stated once so the two cannot drift
     into "matching fields" versus "matching bytes". A mismatch is a
     `reserve-foreign` corruption
     halt with zero writes, on the same footing as every other artifact-behind
     observation — so the one deleting step in the reserve's life cannot delete
     a file that replaced the one M1 claimed.
   - **Pre-M0 inventory disposition:** the reserve exists on every barrier-era
     1.x workspace, including ones that never migrate. It is a named, known
     member of `.rbox/state/` — enumerated by the journal-independent reset
     namespace inventory as an **inert non-reset artifact**: never an O/N
     witness, never a classification input, never correlated by a P/R/I/Z row,
     and never deleted by reset. Being a named member is what keeps it from
     tripping the "unknown name in a reserved directory" halt. M1 claims it by
     CAS-recording its identity into the control; M6 role 7 retires it; on a
     workspace that never migrates it stays resident forever at 1 MiB, which is
     the price `B0` pays for M1's guaranteed runway.
4. Doctor copy that never advises deleting `Q`.
5. The `.rbox/state/last-writer.json` witness sidecar and its update protocol
   (§ the degraded-writer closure, 1b), plus the extension of the item-2
   inventory test to cover it.

Exit criteria (all required before U3 may be enabled, not merely before it may
be written):
- released on the stable channel;
- adopted by **all 4 external users and all 3 fleet hosts**, read from the
  **existing `rbox-admin` version view** (founder decision 6, v11) — no new
  telemetry infrastructure is built for this gate, and issue #540 was closed as
  invalid on that basis;
- baked for at least two weeks of ordinary fleet use with zero
  barrier-related incidents;
- the degraded/legacy-writer fixture matrix `F1`–`F6` from the closure above
  passes, including both negative controls and `F5`'s companion assertion;
- the pre-`1.11.0` population is **demonstrably drained** in that same
  `rbox-admin` version view. The bar is unchanged by v11; what changed is that
  it is no longer the *only* thing carrying § 1a's outcome (ii) —
  `MIGRATION-EXCLUSIVITY-v11` excludes that scenario outright and the drain gate
  is now the second layer. It still gates U3: if the version view cannot show
  the drain, U3 does not open. Known population as of 2026-07-28: 1 external
  user on 1.6 (nudge directly), 2 on 1.9.x upgrading frequently, founder fleet
  on dev builds.

### U0 — entry interning (no gate)

As specified. Not shippable, not fleet-visible; its only exit is its own test
suite plus the arena lease/abort matrix.

### U1 — store, schema, digests, backup, read-only adapters

Additional v6 exits:
- **`bun:sqlite` contract suite (R4-ROLLOUT M3).** The repo has **zero**
  production `bun:sqlite` usage today (verified: only `scripts/storage-truth*.ts`).
  Every behavior this design leans on is therefore an untested assumption. U1
  ships a CI suite asserting, by observation rather than documentation:
  WAL and `synchronous` pragma set-and-readback; `busy_timeout` honoring;
  `wal_checkpoint(TRUNCATE)` busy-result shape; SQLite error-code surfacing
  (including `SQLITE_FULL`, `SQLITE_CORRUPT`, `SQLITE_NOTADB`); statement
  finalization and handle-close semantics; transaction-callback semantics
  including throw-inside-transaction; and `temp_store=FILE` actually producing
  file-backed temps. This suite is the contract that survives Bun's Zig→Rust
  rewrite by construction — it tests behavior, not implementation.
- **Bun floor, pinned to what actually ships.** `package.json` declares
  `engines.bun ^1.3.14`; release builds pin Bun `1.3.14` (canary publishes no
  cross-target blobs) while CI test lanes run canary. The 163 floor is
  therefore **Bun 1.3.14**, and the contract suite runs on both the pinned
  floor and canary; a canary-only failure blocks a Bun bump, not the design.
- **`PRAGMA fullfsync` decision (R4-ROLLOUT M4).** On Darwin plain `fsync()`
  does not guarantee platter durability, yet the crash rig models discarding
  non-fsynced writes. U1 pins `fullfsync=ON` and `checkpoint_fullfsync=ON` on
  Darwin, verifies the readback like every other pinned pragma, and records the
  measured write-throughput cost. If that cost is unacceptable, the accepted
  risk is recorded explicitly in this document — it is not left unstated.
- **`.rbox/` sidecar churn is a non-issue, and the design says so once.**
  Verified: `.rbox/` is excluded by three non-overridable layers —
  `isHardExcluded` (checked before any rule evaluation, and no `.rboxignore`
  or `.gitignore` negation can re-include it), `BUILTIN_IGNORE`, and native
  watcher prune via `ALWAYS_NATIVE_PRUNE`, whose `has(d) ||` short-circuit
  makes user negations unable to drop `.rbox` from the prune set. WAL/SHM
  sidecars generate zero watcher events.

### U2 — reset/quarantine on DB artifacts (moved ahead of the flip)

This is v5's U4, resequenced. It must precede the authority flip, because the
moment `state.db` is authority the 138 file-swap protocol is operating on
`.db` artifacts — and because reset-v1 is the one subsystem that does **not**
go through the state seam. Verified: `reset-journal.ts`, `reset-state.ts`,
`reset-quarantine.ts`, and `reset-journal-doctor.ts` treat the state file as an
opaque byte object (sha256-of-bytes preconditions, content-hash-named archive
copies, `fs.rename` as the commit primitive, raw `boundedRead`s that bypass
`loadRawState`). A backend swap that left this untouched would leave reset
transacting over a file that is no longer authority.

Scope: the entire normative reset re-derivation above — the shared bounded
decoder, the journal-independent namespace inventory with both branches, the
J0/W1/W2/W3 rows, the correlated P/R/I/Z table on `.db` artifacts, and the
quarantine protocol.

Exits: the full crash rig (process kill and power-cut snapshots at every
labeled boundary); the frozen temp-grammar handling; the
`compareResetZEntries` unification; the quarantine `publishCommitRecord` temp
leak fix; the `COMMITTED + journal absent + candidate present` fixtures; and
the legacy-JSON-branch fixtures. Migration entry is compiled behind this
unit's capability predicate, so U3 is not merely gated on U2 by policy — it is
unreachable without it.

### U3 — migration, the `Q` flip, and the whole-state adapter (2.0 ships here)

Blocked on `B0` exits and on U2. This is the release that carries the one-way
authority change, and under the backend-first sequencing it carries **nothing
else**: the engine is byte-identical across the flip, reading and writing
through a whole-state compatibility adapter over the store.

The adapter's shape is not arbitrary. Verified: `StateSavePacket` is already
`{expectedStream, expectedNonce, sourceGlobalSeq, global?, repos[]}` with the
result union `accepted | rejected(reason) | busy | unsupported`, i.e. the
write path is already a delta and already CAS-shaped. So the adapter is
asymmetric, and deliberately so:

- **Writes go native.** `applyStateSavePacket` maps onto the store's packet
  semantics and set-diffs into rows, so authority writes become O(dirty rows)
  **at the flip**. The per-cycle full-serialize disappears here, not in U4.
- **Reads stay whole.** `loadState`/`loadRawState` materialize a complete
  `SyncState` from rows. This preserves every caller signature and therefore
  every caller, at the cost of keeping the materialization peak until U4
  replaces it cursor by cursor.

Additional v6 exits:
- **No-regression gate (backend-first condition 1).** The flip may not ship
  unless trusted `rbox status` latency and daemon steady-state RSS on the 112k
  corpus are no worse than the 1.x baseline. The adapter keeps whole-state
  materialization and adds a SQLite page cache, so this is a real risk, not a
  formality.
- **Differential control.** The same-corpus manifest diff and the two-host rig
  (below) run at the flip. V6 said they "must be clean *by construction* — the
  engine did not change"; **v7 weakens that to the differential gate's own
  framing**, because the claim overstated what the flip leaves untouched. The
  scan/reconcile/apply engine is byte-identical, but the backend, the codecs,
  the CAS admission path, and the whole reset/quarantine conversion all change
  underneath it, and each can move a wire-visible verdict without any engine
  edit. So the flip is not exempt from the gate; it is the run where a
  difference is *least expected* and therefore most informative. The rule is
  the same as every other slice's: any difference is either fixed or explicitly
  ratified as intended, and an unexplained one blocks the flip.
- **Adapter inventory.** The whole-state adapter is the single permitted
  production use of `loadState(): SyncState`. CI counts its call sites from
  this release forward; the count may only decrease and must reach zero by
  U4f.
- **Explicit-and-exclusive entry (v11, founder decision 5).** U3 ships the two
  admitted entry points and nothing else: the `rbox upgrade` per-workspace stop
  window and a foreground `rbox migrate`. U3 does **not** implement ambient or
  on-boot migration, and it does **not** implement the paired-interval
  live-writer sampling v8 specified — `migration-not-exclusive` refusal
  replaces both.
- **Migration duration budget and progress UX (R4-ROLLOUT M1).** M3 imports
  112k files in one transaction; M4 runs full `integrity_check` plus a second
  semantic digest; all under the workspace mutex with `synchronous=FULL`. The
  migration the user just asked for must not look like a hang. Budget:
  **complete M0–M7 in <= 60 s on the 112k corpus**, and if any phase exceeds
  5 s the foreground command prints the phase and its progress, which
  `rbox status` also renders in plain English from a `migrating` health state
  and the non-interactive twin reports as structured output. A migration that
  exceeds the budget is a reportable finding, not a silent success.
- **Halt copy (R4-ROLLOUT M5).** Design 163 introduces roughly fifteen new
  fail-closed halt classes, each of which stops sync, and two of the four
  external users are non-technical. Every new halt reason ships with a
  plain-English doctor entry naming what happened, what is safe, and the one
  next action — plus its non-interactive twin. This is a U2/U3 deliverable and
  a merge gate, not documentation debt.

**First fleet checkpoint (R4-ROLLOUT H2).** U0/U1 produce nothing
fleet-observable. Under this sequencing the first falsifiable signal arrives
earlier than it would have: a 2.0 dev build running a **throwaway workspace
through the genesis path** (M0 absent/absent/absent), which is reachable as
soon as U1's store and U2's reset support exist — before migration is enabled
on any real workspace. Genesis-path validation is an explicit U3 deliverable
and is the first go/no-go the founder can personally observe.

### U4a–U4f — the engine port (decomposed; R4-ROLLOUT H1)

V5's U2. It was not a slice; it was most of the project with no falsifiable
checkpoint inside it. Under backend-first each unit is an ordinary 2.x
release on `main`: independently shippable, independently measurable, and
independently **revertible**, because none of them touches authority.

| Unit | Scope | Exit criterion |
|---|---|---|
| **U4a** | `cache-v2.db`: hash, directory, encrypt-address ports + the `cache-v1-retired/` parking protocol + the `adopt-cache.ts` invalidation-list update | cold-rebuild parity on the 112k corpus; adoption invalidates every cache the scan path can consult (the C4 sweep's highest-risk row) |
| **U4b** | `TrackedPathIndexPort` + `IgnoreRuleIndexPort`, including the `TrackedIndexUnavailable` / `IgnoreRulesUnavailable` fail-closed verdicts | differential: identical tracked/ignored verdicts vs 1.x on the corpus, plus injected-unavailability tests proving no permissive fallback |
| **U4c** | LOCAL plane: `ScanGenerationSink`, watcher `LocalPatchPort`, generation-CAS local head | full scan produces a byte-identical ordered LOCAL membership vs the adapter path; incomplete scan invisible |
| **U4d** | BASE/REMOTE: reconcile cursors, sealed plan, `ApplyPlanPort` + `ApplyReceiptOraclePort` | `canonicalReceipt` digest reproduced byte-for-byte from cursors; pull apply parity on the corpus |
| **U4e** | Push: WIRE-CANDIDATE stage, `GitStateCursorPort`, both outcome ports | wire-visible differential (below) |
| **U4f** | Materialization budget: `WireAllocationLedger`, `ConstructionPeakV1`, `F_runtime` calibration, the CI peak ledger; **the whole-state adapter is deleted** | every budget row in the table above measured and inside its cap; adapter call-site count is zero |

**Per-slice exit criterion — wire-visible semantics differential
(R4-ROLLOUT B4).** The `Q` barrier is per-host and local; two hosts sharing a
workspace never see each other's state file. The real skew risk is that these
slices rewrite ignore-rule evaluation, tracked-path membership, deferral/carry,
and mass-delete decisioning — all wire-visible through the manifest they
produce. "84 unchanged" covers the protocol, not the semantics fed into it.
Under backend-first this differential runs **once per slice** rather than once
for the whole rewrite, against the flip's clean control:
1. **Same-corpus manifest diff**: the same workspace corpus, pushed by the
   previous release and by the candidate, produces identical manifests (files,
   ordering, Git sections, deferral/carry decisions) modulo timestamps; any
   difference is either fixed or explicitly ratified as an intended change.
2. **Two-host differential rig**: one workspace, one candidate host and one
   1.x host, both syncing — pull/push interleaved, including an ignore-rule
   change, a tracked-repo change, and a mass-delete-shaped change. Neither host
   may observe a spurious delete, a lost deferral, or a divergent manifest.

**Two named rig deliverables this gate does not yet have (v7).** The
differential above is written as if the rig could already run two different
binaries. It cannot, and neither can it build the corpus it is measured on;
both are prerequisites of the U3 flip gate, not conveniences:

- **Dual-binary rig plumbing.** Verified: `--binary` is a *single global*
  override. `scripts/rig/rig.ts` resolves one path
  (`resolveRigBinaryOverride`), stages it once (`stageRigBinaryOverride`), and
  mounts the result into `rigGuestMounts` for the whole rig, so `rig-dev-a` and
  `rig-dev-b` necessarily run the same executable — exactly what a
  candidate-versus-1.x differential must not do. Deliverable: per-device
  overrides (`--binary-a` / `--binary-b`, or a per-device mount map) with the
  same exact-absolute-path, regular-non-symlink, canonical, executable
  validation `scripts/rig/lib/binary.ts` already enforces, plus a scenario
  assertion that the two devices report different `rbox --version` strings so a
  silent single-binary run cannot masquerade as a differential.
- **Pinned 1.x artifact provenance.** The 1.x side of the rig must run the
  **published, signed release artifact** for the ratified floor `1.11.0` —
  fetched from `rbox-releases` and verified against its recorded digest and
  detached signature — never a locally built binary from the working tree. A
  differential whose control is a local build proves nothing about what the
  four external users are running. The digest is recorded in the rig scenario
  so a re-run years later is reproducible.

**Reproducible 112k corpus fixture (v7).** Every gate in this document — the
migration duration budget, the no-regression gate, the U5 kill criterion, the
disk budget — is stated "on the 112k corpus", and no such corpus is
reproducible today. Verified: `scripts/bench/corpus.ts` generates seeded shapes
topping out at `repo: {files: 5000}`, twenty-two times too small. Deliverable
(U1, because U1 is the first slice whose exits are measured): a
`corpus-112k` shape in that same generator — deterministic from its seed,
including the empty-file and duplicate-content shapes it already seeds
deliberately, plus the Git-repository and nested-ignore-rule shapes 163's gates
actually exercise — with its generated manifest hash pinned in the repository
so two hosts can prove they measured the same corpus. Numbers measured on an
unpinned corpus are not comparable and do not satisfy any gate here.

A slice that fails its differential is reverted, not patched forward; that
option exists only because authority is already settled.

### U5 — fleet bake, and the named kill criterion

**Prerelease channel (R4-ROLLOUT B1) — a named pre-U5 deliverable.**
Verified: `scripts/release.ts` is single-channel. Any `v*` tag rewrites
`releases/version.json`, every latest binary alias, `install.sh`, and the
changelog; the only guard is `semverGt(before, version)`, an anti-rollback
check. `src/cli/semver.ts` ranks `2.0.0-rc.1` **above** `1.10.1` (major wins
before prerelease is consulted), so tagging a 2.0 prerelease publishes it to
`install.sh` and to every `rbox upgrade`, including the paying user's — and the
anti-rollback guard then *pins* the mistake, refusing a subsequent `1.10.3`
hotfix publish. `.github/workflows/release.yml` has no channel handling.
Therefore: a prerelease-vs-latest channel split is a **normative dependency**
of U5 and must land before the first 2.0 tag is pushed. The release-pipeline
work itself is out of design 163's scope (it is its own small design), but
163 may not proceed to a tagged 2.0 prerelease without it. The `rbox-dev`
symlink covers the three founder hosts and does not cover `B0`, which must
reach external users through the normal channel.

**Named ship/no-ship criterion (R4-ROLLOUT H4) — numbers RATIFIED by the
founder 2026-07-28.** `<200 ms` is explicitly a
target whose miss is "not permission to broaden the claim", which as written
lets 2.0 ship delivering no user-visible improvement while carrying migration
risk, permanently higher disk use, and ~15 new halt classes. The U5 gate is
therefore stated now, before the measurements exist. The thresholds below are
no longer proposals:

- **Ship** requires, on the pinned 112k corpus fixture: trusted `rbox status`
  **p50 <= 200 ms and p95 <= 400 ms** (baseline today: 0.84 s); daemon
  steady-state **RSS <= 1.5 GB** across 24 h of ordinary use (field baseline:
  2.95 → 6.41 GB over 23 cycles); zero unexplained halts during the bake; and
  the per-slice differential clean.

**Measurement protocol for those numbers (v7).** A ratified threshold with an
unspecified method is still unfalsifiable, so the protocol is normative here.
One input is genuinely still owed and is named as such rather than invented.

- **Frozen machine profile — OWED, and blocking before U5 begins.** All ship
  numbers are measured on one named, frozen host profile (exact machine, CPU,
  RAM, filesystem, and whether it is a fleet host or the rig), chosen by the
  founder and recorded in this section before the first U5 measurement. Nothing
  else in this list is meaningful without it: the same code will pass on one
  fleet host and fail on another. This is the one open input of the kill
  criterion, and it is **open input 2 of 2** in the document's list at the top
  (§ "OPEN INPUTS OWED BY THE FOUNDER") — v7 omitted it there while marking it
  owed and blocking here, which made the top-of-document count wrong.
- **Warmup and sampling.** Each latency figure is 100 consecutive trusted
  `rbox status` invocations against a settled daemon, after 10 discarded warmup
  invocations, on an unmodified workspace with the LOCAL plane complete;
  p50/p95 are computed over the 100 recorded samples, and the raw samples are
  retained with the verdict. A run in which any sample is untrusted is void,
  not clamped — the target has only ever applied to trusted status.
- **"Ordinary use"** means the bake workspace under its normal daily
  edit/sync/Git activity with no synthetic load and no deliberate idling:
  at least one push, one pull, and one Git-bearing sync per day, and the daemon
  never restarted except by an upgrade. RSS is the daemon's steady-state
  resident size sampled at 5-minute intervals across the window; the criterion
  is the **maximum** sample, not the mean, because the failure mode being
  gated is unbounded growth.
- **"Unexplained halt"** means any halt (of the ~15 new fail-closed classes or
  any pre-existing one) whose root cause is not identified and attributed to a
  specific defect or a deliberate refusal by the end of the bake. A halt that
  is understood, reproduced, and either fixed or ratified as correct behavior
  is explained; "it did not recur" is not an explanation.
- **Bake duration.** U5 bakes for **four weeks** across all three fleet hosts
  and any external user who has opted in — twice `B0`'s two-week barrier bake,
  because U5 is gating the whole engine port rather than one refusal check. The
  24 h RSS window is measured inside that bake, not instead of it.
- **Remediation cycle.** Exactly **one**. A missed threshold gets one
  remediation cycle — diagnosis, fix, and a full re-measurement under this same
  protocol — and if the second measurement misses, the no-ship alternatives
  below are taken. There is no third attempt, because the point of a named
  criterion is that it can be lost.
- **No-ship** is not "try harder". If the criterion is missed after one
  remediation cycle, the named alternatives are **stop after the last passing
  slice** (the flip and the slices that met their gates stay; the remainder is
  abandoned, leaving a working system rather than a half-finished one) or
  **revert the failing slice**. Both are first-class outcomes, consistent with
  the standing revert-is-an-option rule.
- Backend-first changes the shape of this gate for the better. Under v5's
  ordering, "no-ship" meant reverting a branch containing the authority
  migration *and* the entire engine rewrite — in practice unrevertible once
  any workspace had flipped. Under this ordering the kill criterion is
  evaluated per slice against settled authority, so a miss costs one slice
  rather than the project. The one thing that still cannot be reverted in
  place is the flip itself, which is why it carries its own no-regression gate
  at U3 and why recovery is re-adoption.

**Steady-state disk budget (R4-ROLLOUT M2).** New permanent residents:
`state.db`, its WAL (backpressure only at 256 MiB), `cache-v2.db`, the fixed
legacy backup (~59 MB on the Mac), and `legacy-json/<sha>.json` history
(~59 MB per distinct source, immutable). Budget: total `.rbox` steady-state
size <= 3× the pre-163 measurement on the same corpus, measured at U5.
Retention policy for `legacy-json/`: the fixed latest backup plus the immutable
history are retained until the workspace has completed **two** clean fleet
bakes on 2.0, after which `rbox doctor --prune-legacy-state-backups` (explicit,
never automatic) may delete history entries other than the migration's own
source. Deleting them is safe precisely because they were never authority.

### 2.0 branch merge process (R4-ROLLOUT H3)

**The backend-first restructure mostly dissolves this problem, which is one of
its larger benefits.** The `2.0` branch now spans `U0 → U3` (entry interning,
store, schema, reset conversion, migration) instead of the whole project —
`B0` is a 1.x release on `main` and is not on the branch at all — and the U4
engine
slices land on `main` as ordinary 2.x releases. The branch's lifetime falls
from the full project to roughly its first third, and the port-forward ledger
— the expensive part — becomes nearly empty, because the files U4 rewrites are
still being maintained on `main` while U4 rewrites them there.

The process below therefore applies to a shorter branch, but it is not
optional: even `U0 → U3` spans months of a fast-moving `main`. Measured on
`main`: **1,019 commits in the last 60 days.**

One reviewer figure is corrected here: `src/cli/daemon.ts` and `src/cli/sync.ts`
show ~2,400 and ~2,600 lines of churn in that window, but they are now **10-
and 16-line re-export barrels** — that churn is the decomposition itself, not
ongoing change. The genuinely hot file the engine slices rewrite is
`src/cli/sync-git/apply.ts`: 25 commits, net +1,502 lines, and 1,502 lines
today (above the 500-line target). Live churn otherwise moved into
`src/cli/daemon/**` and `src/cli/sync/**`, which U4a–U4f also rewrite. (V7
terminology sweep: these three sentences carried v5's numbering, in which the
engine rewrite was U2; under the restructured plan the engine slices are
U4a–U4f and `U2` is the reset conversion.)

Required process:
- a **named owner** for the 2.0 branch, accountable for its currency;
- a **CI-driven `main` → `2.0` merge at at-worst-weekly cadence**, producing a
  conflict report even when the merge is clean, so drift is visible before it
  compounds;
- a **port-forward ledger**: `main` fixes that land in files 2.0 deletes cannot
  be merged, only re-implemented. Each such fix gets a ledger row (fix, `main`
  commit, 2.0 re-implementation or an explicit "not applicable" with a reason).
  An unported row blocks U5.
- the branch is never rebased; developer-local topic branches may be.

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
terminal-control-last rule, and 2.0-only confinement are unchanged.

## R4 ratification round review log (v6)

Three independent reviews of v5: `REVIEW-163-R4-CODE.md` (opus, code-claims
lens, NOT-READY), `REVIEW-163-R4-ROLLOUT.md` (opus, rollout/operational lens,
RATIFY-WITH-EDITS staged), `REVIEW-163-R4-CODEX.md` (gpt-5.6-sol, NOT-READY,
two CRITICAL). All three are in `docs/design/notes/163/`.

**Every finding below was independently re-verified against `src/` before
folding.** Four reviewer claims did not survive that check and are recorded as
refuted or corrected rather than folded as stated.

| Finding | Disposition | Where in v6 |
|---|---|---|
| CODE B1 — `hasResetLineageArchive` `.json` regex; provenance predicate is an authorization input 163 silently breaks | **Folded.** Verified exactly, including the silent-false failure mode. | "Lineage-archive provenance predicate"; `reset-namespace-inventory.ts` owns it; the enabled legacy write is a U2 exit item |
| CODE B1 (citation) — `push.ts:623` listed as an `allowLegacyStreamReplacement` site | **Corrected.** `:623` is a different consumer (`streamMismatch` → `filesFirstDefer` capture policy). The authorization sites are `pull.ts:445` and `push.ts:539,:579,:894` — the reviewer missed `:894`. | Same section, cited correctly |
| CODE B2 — Z order is `localeCompare`, not "lexical" | **Folded**, with the exact function named per axis. Independent survey found a latent cross-module mismatch (`reset-state.ts:304` builds the same axis with code-unit `<`/`>` while `reset-journal.ts:170` validates with `localeCompare`) — recorded and assigned to U4. | Reset notation section; the journal grammar; `path_order` paragraph unchanged (already correct) |
| CODE B3 + CODEX 1 — RepoRecord mapping omits `packedRefsIdentity`, `attempt`, `resolutionReceipt`; `resolutionIntent` collides with `extras_cjson` and the M4 digest | **Folded.** Verified against the current interface; all three exist and are live. **This row was false when written, twice.** Rounds one and two recorded it as folded while the normative sections were never edited: until v7, `packedRefsIdentity`/`attempt`/`resolutionReceipt` appeared nowhere but in this cell. Actually closed in v7 — columns added to the DDL, mapping rebased on the current interface in declaration order, `resolutionIntent` given a strip-before-digest disposition, and a schema-rebase gate added. | `repo_records` DDL; "Newly named members and strip-on-read semantics" (created in v7); v7 residual row 1 |
| CODE B3 (wording) — "every state reader deliberately strips" | **Corrected.** There is exactly one production call site (`loadRawState`); it works because every disk read funnels through it. The second strip is explicitly defensive. | Same section |
| CODE B4 — tombstone caps are 16/512, not 8 | **Folded.** Constants verified exact. | Growth model section |
| CODE B4 (sub-claim) — "expiry 90d checks out" in `manifest-validate.ts` | **Refuted as located.** That file has no retention constant; the wire validator bounds count only. Three separate 90-day client-side constants carry age. | Same paragraph, all three named |
| CODE B5 + CODEX 7 — v5 is not strictly additive | **Folded.** Status line rewritten; both v4 overrides named as refinements and the superseded paragraphs amended in place. | Status line; the "rebuilds a revision-correct pair" paragraph; the `exact halted M0–M7` crash-table cell; the halt-clearing paragraph |
| CODE 6 — `reset-quarantine.ts` "parses no journal bytes today" | **Premise refuted; substance folded.** It *does* import `reset-journal` and *does* `boundedRead` raw journal bytes at the 2 GiB streaming cap before delegating — which is itself a violation of the decoder rule, now called out. The reviewer's real point (the consumer list was incomplete) stands: five modules, not two. | Decoder consumer table |
| CODE 7 — ownership tree omits `reset-journal-classifier.ts`, `reset-halt-inspection.ts` | **Folded.** Both verified; the latter is an 8-line re-export adapter, recorded as such. | Module ownership tree |
| CODE 8 — `RBOX_PROCESS_BUDGET_BYTES` is not 161's variable | **Folded.** Verified: no such env var exists; 161's is `RBOX_RESET_PARSE_BUDGET_BYTES` with a machine-scaled, cgroup-aware default. Named as a genuinely new knob and explicitly separated. | Wire ledger section |
| CODE 9 — `this.manifest` is `this.local.manifest` | **Folded**, with the owner corrected: `LocalAuthority` lives in `daemon/local-observation-transition.ts`, not `daemon.ts`. | Materialization budget section |
| CODE 10 — `apply-receipt.ts:715-763` is past EOF | **Folded.** File is 756 lines; citation withdrawn; `canonicalReceipt`/`normalizeRel` corrected. | Receipt/oracle section |
| CODE 11 — quarantine bundles are a fourth durable reset tree | **Folded.** Exclusion from inventory scope retained and now stated. | "Reset namespace scope" |
| CODE 12 — `MAX_MANIFEST_BYTES` enforced at zero call sites | **Folded.** Verified dead: definition + re-export, no comparison, no test. | Envelope/manifest-limit paragraph |
| CODE 13 — `b..b+4` forfeits f6's every-write-handles-ENOSPC promise | **Folded** as a named, scoped exception with its blast radius stated. | Future-control preparation section |
| CODE 14 — v4's "intent durable at revision `r`" never retracted | **Folded**; v4 paragraph amended in place. | Final-item runway paragraph |
| CODEX 2 (CRITICAL) — degraded-unlocked legacy writer can overwrite `Q` post-M6 | **Folded as a hard pre-U0 gate.** Verified in full: `forceLegacy` short-circuits before the CAS loop; the terminal write takes no lock and re-reads nothing. Two amplifications added — the degraded save also strips `stateNonce`/`stateRevision`/`repoRecords`, and reset already refuses degraded, so the live exposure is a straddling or concurrent degraded sync. Barrier must be **write-side**, must ship and bake on 1.x, plus an M0 quiescence/capability predicate and a degraded-writer fixture with a negative control. | "The read-time barrier is insufficient on its own"; `B0` in the rollout plan |
| CODEX 3 — committed quarantine cleanup authority vs "permanently inert" | **Folded** as a C4 completion. Verified: `remove-exact` authority is durable, doctor-created, and survives journal removal. Resolution is an M0 refusal, not a revocation (revocation rejected, with reasons). | "Committed quarantine retains deletion authority" |
| CODEX 4 — reset temp grammars are not a closed inventory | **Folded**; grammars frozen. Two sub-claims corrected: there are **four** temp producers, not two, and `reset-journal.ts:435` merely computes paths (no inventory mechanism there). Found an additional real leak: quarantine's `publishCommitRecord` `finally` never removes its temp. | "Frozen protocol-temp grammars" |
| CODEX 5 — M6 cleanup set called closed but never enumerated | **Folded** as an eight-row literal inventory with roles, paths, starting and terminal dispositions, plus an explicit not-a-cleanup-item list. | "Literal cleanup inventory" |
| CODEX 6 + ROLLOUT B3 — no abort story; `.pre-163.bak` footgun | **Folded.** Verified: no version field, unchecked cast, and the sequence guard gets *more* permissive as the sequence goes backwards. Backup path moved out of the `state.json` neighbourhood, given a non-JSON preamble so restoration fails closed, pre-Q and post-Q abort procedures specified, downgrade floor named. | "Supported abort procedure and the `.pre-163.bak` footgun" |
| CODEX 8 — migration can refuse the states that motivated it | **Folded.** Supported envelope defined with real numbers; refusal UX specified; streaming import recorded as future work with its reason. | "Supported migratable envelope" |
| CODEX simpler alternatives (items 1–4) | **Argued explicitly, not silently taken or dropped.** One adopted in full (`B0`), one adopted (unreachable-not-default-off, now structurally satisfied by the resequencing), one partially adopted and pre-authorized as a U3 simplification (permanent reserve), one rejected with its cost priced (terminal-authority-at-M6). | "Rejected and deferred alternatives" |
| CODEX alternative 5 — backend-first sequencing vs big-bang 2.0 | **ADOPTED; the U-slice plan is restructured.** V6's first draft reached a qualified yes and flagged it as a question. The orchestrator relayed a founder leaning — "backend-first if the fold agrees", explicitly conditioned on verified analysis, not issued as a decree — and the analysis was redone against `src/` rather than against the reviews' description of it. That changed the answer to an unqualified yes, produced an argument neither review made (the flip coincides with the *smallest* diff, so the irreversible step is safer taken early and alone), and **falsified the first draft's own third objection**: "reset conversion is coupled to the artifact format, so it cannot lag the flip" does not imply "they ship together at the end", it implies **reset moves in front of the flip**. Order is now `B0 → U0 → U1 → U2 reset → U3 flip → U4a–U4f engine → U5`. The M0–M7 machine, `Q` predicate and barrier, and all migration fencing are unchanged — only the schedule moved. Four conditions attached (no-regression gate at the flip; time-boxed and CI-inventoried whole-state adapter; per-slice differential; `B0` unchanged). | Question 1; "Rejected and deferred alternatives" item 5; the whole rollout section; Mechanism summary; acceptance-targets preamble |
| Seam feasibility (v6 verification, no reviewer claim) | **Verified before restructuring, not assumed.** `sync-state-store.ts` is the sole engine disk funnel and is CI-enforced by an existing allowlist test with exact per-module counts; `loadState` has 26 production call sites across 9 modules and `applyStateSavePacket` 7 across 6, all resolving through one pinned barrel, so a behind-the-seam swap changes none of them; the N-sized `.files` array is touched in only four modules. `StateSavePacket`/`StateSaveResult` are already packet- and CAS-shaped, so O(dirty-row) writes land at the flip. The one genuine blocker — reset-v1's ~1,500 lines of byte-level transaction over the state file — is exactly what the resequencing puts first. | "Rejected and deferred alternatives" item 5, feasibility bullets |
| ROLLOUT B1 — no prerelease channel in `scripts/release.ts` | **Folded** as a normative pre-U5 dependency. Verified in full, plus one addition: after an rc publish the anti-rollback guard would *refuse* a subsequent stable hotfix. Pipeline work stays out of 163's scope. | U5 section |
| ROLLOUT B2 — barrier release is a hard prerequisite, not a slice | **Folded** as `B0` with an adoption gate; merged with CODEX 2. | `B0` |
| ROLLOUT B4 — no wire-visible semantics differential | **Folded** as the per-slice engine exit criterion: same-corpus manifest diff plus a two-host (2.0 + 1.x, one workspace) rig. (Row renumbered in v7: it said "U2's exit criterion" in v5's numbering.) | U4a–U4f per-slice differential; run first as the U3 flip's control |
| ROLLOUT H1 — the engine rewrite is ~70% of the project | **Folded**: decomposed into six units with per-unit exits. (Renumbered in v7: v5 called them U2a–U2f.) | U4a–U4f table |
| ROLLOUT H2 — first falsifiable fleet checkpoint unnamed | **Folded**: genesis-path throwaway workspace, reachable as soon as U1's store and U2's reset support exist and therefore an explicit U3 deliverable — earlier than v5's "after U2c". | U3 section, "First fleet checkpoint" |
| ROLLOUT H3 — merge process has no owner/cadence/conflict policy | **Folded**: named owner, at-worst-weekly CI merge with a conflict report, port-forward ledger. | Branch merge process |
| ROLLOUT H3 (evidence) — `daemon.ts` churned 6,222 lines, `sync.ts` 5,178 | **Refuted as framed.** Re-measured: 1,019 commits in 60 days is right, but `daemon.ts` and `sync.ts` are now 10- and 16-line re-export barrels and their churn is the decomposition itself. The genuinely hot rewritten file is `sync-git/apply.ts` (25 commits, +1,502 net, 1,502 lines today). The conclusion survives on corrected evidence. | Branch merge process |
| ROLLOUT H4 — no named kill criterion | **Folded** with proposed thresholds and re-scope/revert as named alternatives; the numbers are Question 4 for the orchestrator. | U5 section |
| ROLLOUT M1 — no migration duration budget or progress UX | **Folded**: <= 60 s on the 112k corpus, `migrating` health state past 5 s, with a non-interactive twin. | U3 section |
| ROLLOUT M2 — no steady-state disk budget | **Folded**: <= 3× pre-163 `.rbox`, plus a `legacy-json/` retention policy and an explicit prune command. | U5 section |
| ROLLOUT M3 — no `bun:sqlite` contract suite, no Bun floor | **Folded.** Verified zero production usage. Floor pinned at Bun **1.3.14** (what release builds actually use; `engines.bun` is `^1.3.14`, CI test lanes run canary), suite runs on both. | U1 section |
| ROLLOUT M4 — `PRAGMA fullfsync` never pinned | **Folded**: pinned on Darwin with readback, cost measured, or the risk recorded explicitly. | U1 section |
| ROLLOUT M5 — new halt surface has no user-facing copy | **Folded**: every new halt reason ships a plain-English doctor entry plus a non-interactive twin, as a merge gate. | U3 section |
| ROLLOUT "verified clear" — `.rbox/` WAL churn is a non-issue | **Confirmed independently** and stated once in the design, as the reviewer suggested. | U1 section |

V6 remained pending final ratification and was not implementation authority.

## R4-final residual fold (v7)

One review: the codex final serial review of the v6 tip (commits `9599d59a` +
`5ddf75c7`), verdict NOT-ALIGNED, 2026-07-28. Its residual list is closed
below. **Two of these residuals are re-openings of closures the v6 log already
claimed** — that is why the first row of this table is about the log itself.

| Residual | Disposition in v7 |
|---|---|
| **The v6 log claimed closures the normative sections never received** (schema columns; `resolutionIntent`) | **Cause admitted, not just the symptom.** The log row is evidence of intent, never of an edit; both rounds wrote the row and skipped the section. Standing rule recorded in the status line: the review log records a closure, it never constitutes one. The concrete drift is closed below, with a test so the next drift is red rather than silent. |
| 1 — schema DDL omits `packedRefsIdentity`, `attempt`, `resolutionReceipt`; `resolutionIntent` has no normative disposition | **Closed in the normative sections.** `repo_records` gains `packed_refs_identity`, `attempt_cjson`, `resolution_receipt_cjson`; the one-for-one field list is rebased on `sync-state-model.ts:288` in declaration order (nineteen members, nineteen field-carrying columns); a new "Newly named members and strip-on-read semantics" subsection specifies all three shapes and gives `resolutionIntent` its strip-before-digest disposition (stripped in the v1 normalization *before* the source digest, never routed to `extras_cjson`, no shape-presence bit); a U1 schema-rebase gate asserts DDL-column vs `keyof RepoRecord` bijection minus the one named strip member. |
| 2 — B0 write barrier is a check-then-rename race, and the last-writer witness has nowhere to live | **Closed, argued from the real primitive.** `writeFileAtomic` (`fsutil.ts:35-89`) publishes with one `fs.rename` and exposes exactly one abort seam, `beforeRename`, which `sync-state-store.ts:216,:411` already uses for lock-ownership assertions — so the check cannot be made atomic with the rename by any property of the hook. Race-freedom comes from mutual exclusion instead: every state write must hold `stateLockPath` across check-then-rename (two of three writers already do; `writeWholeStateUnsafe` is changed to), and M6's rename holds the same lock. The one filesystem where that is impossible is exactly `degraded-unlocked` (`acquireLock` returned `unsupported`), and there M0 refuses to migrate at all, so no `Q` can appear under an unlocked writer. Witness: a `.rbox/state/last-writer.json` sidecar (not a `SyncState` member, which pre-B0 binaries and the degraded composer would drop), written under the same lock after the publication fsync, bound to the published `state.json` `dev`/`ino`, read only by M0 admission. |
| 3 — M2 says "hard link or copy" while every backup must carry a preamble | **Contradiction resolved toward the preamble.** Backups are always preamble-prefixed streaming copies; hard-linking is forbidden and the reason is stated (a link cannot carry a preamble, would let 1.x writers mutate "immutable" history through the same inode, and would escape the restoration refusal). Body hash versus physical hash defined and used consistently in the M2 phase text, the M2 witness row, the artifact list, and fault injection. |
| 4 — M6 literal cleanup inventory contradicts M0–M7 in three places | **Table reconciled, machine unchanged.** Roles 1–4 (staging main + sidecars) become asserted absences — M4 requires `S0` twice and M5 requires staging absent with `stagingMain:"absent"`, so presence at M6 is a `reserved-path` corruption halt, not debris; role 5 (control publisher temp) is removed from auto-cleanup as an inert temp under the existing doctor-only rule, which also removes the directory discovery the vector forbids; role 6 (prepared halted-M6 sibling) is removed from the cleanup order because the final-item runway creates it and M7 retires it. Two real cleanup items remain: reserve then emergency, the latter still owning the allocation-free runway. |
| 5 — two divergent M0 admission predicates | **Consolidated into one.** The quiescence/capability predicate is now the single normative list of exactly four conditions (non-degraded fence, no live operation, no resumable quarantine bundle, barrier-capability witness), re-checked before the M6 rename; the quarantine section keeps the reasoning and delegates the predicate. |
| 6 — downgrade floor written provisional | **RATIFIED `1.11.0`** (founder, 2026-07-28) in the abort section, the `B0` unit, the M0 witness threshold, and the rig's pinned control. |
| 7 — reserve lacks path, creation/collision protocol, pre-M0 disposition | **Specified in `B0` contents item 3:** `.rbox/state/reserve-1mib.bin`, `O_EXCL` 0600 create of exactly 1,048,576 zero bytes with file+parent fsync, adopt-an-exact-match / never-delete-a-foreign-path collision rule with a typed `reserve-foreign` M1 refusal, and a named inert non-reset member of the `.rbox/state/` inventory that survives on workspaces that never migrate. |
| 8 — mixed-version differential rig has no dual-binary plumbing | **Named as a deliverable, with the limitation verified:** `rig.ts` resolves and stages one global `--binary` into `rigGuestMounts`, so both devices necessarily run the same executable. Per-device overrides plus a version-difference assertion are required, and the 1.x side must be the published, signed, digest-verified `1.11.0` artifact rather than a local build. |
| 9 — the 112k corpus is not a reproducible fixture | **Named as a U1 deliverable.** Verified: `scripts/bench/corpus.ts` tops out at `repo: {files: 5000}`. A seeded `corpus-112k` shape with a pinned manifest hash is required before any gate stated "on the 112k corpus" can be evaluated. |
| 10 — kill thresholds unratified and unprotocolled | **Numbers RATIFIED** (p50 <= 200 ms, p95 <= 400 ms, RSS <= 1.5 GB). Protocol added: 100 samples after 10 warmups with void-on-untrusted, "ordinary use" and "unexplained halt" defined, 5-minute RSS sampling judged on the maximum, four-week bake, exactly one remediation cycle. **Still owed and flagged blocking: the frozen machine profile.** |
| 11 — "clean by construction" overstates the flip | **Weakened to the document's own differential-gate framing.** The engine is byte-identical but the backend, codecs, CAS admission, and reset conversion all change underneath it; the flip is the run where a difference is least expected, not one that is exempt. |
| 12 — superseded U2 numbering, U5 ship criterion, branch language | **Swept.** Review-log rows renumbered with their v5 origin noted, the U5 criterion now says per-slice differential, the `apply.ts` churn paragraph attributes the rewrite to U4a–U4f, and the branch model is corrected to `2.0 = U0 → U3` with `B0` on `main` and `U4a–U4f` landing on `main` as 2.x. |

V7 remained pending final ratification and was not implementation authority. Its
closing claim that the migration-timing question was "the only input still owed"
is corrected by v8 row 7 below: the frozen machine profile was a second owed
input the whole time.

## R4-v8 residual fold (v8)

One review: the codex serial review of the v7 tip, 2026-07-28. Seven residuals,
closed below. Two of them (rows 1 and 7) are places where v7 *asserted* a
closure — "there is no third case", "exactly one input remains" — that its own
normative text does not support; consistent with the standing rule, v8 fixes the
sections rather than the claims.

| Residual | Disposition in v8 |
|---|---|
| 1 — the `B0` third case is real: a writer whose unlocked window opened before degradation was recorded or before `Q` landed stays unlocked across its own check→rename on a lockable filesystem; and the required degraded-writer fixture is unreachable | **Named, not argued away, and closed as far as it can be.** V7's premise ("degradation is a filesystem-capability property") was false: `writeWholeStateUnsafe` is reached by `unsupported` locking **or** `forceLegacy`, and only the first is a filesystem property. Part one makes it true — `B0` may enter the unlocked path **only** on `acquireLock` returning `unsupported`; `forceLegacy`, transient acquisition failure, and expired/stolen leases each become a typed refusal to publish — which collapses every B0-era instance into the serialized case. Part two extends M0's predicate to a fifth condition, **no live legacy writer at all**, established by a paired bounded-interval sample of the five-field state content witness and the sidecar, refusing `legacy-writer-live`, re-taken before the M6 rename. The irreducible residual (a pre-`1.11.0` writer meeting four simultaneous preconditions) is **accepted and named** with its bound-by-bound discussion and an after-the-fact `legacy-overwrite-after-Q` detection. Fixtures rebuilt as `F1`–`F4`: v7's fixture required a full M0–M7 on a degraded-unlocked workspace that M0 refuses, so `F1` now tests the refusal, `F2` tests the real third case on a lockable filesystem with a negative control, `F3` asserts the named residual as a known outcome, `F4` is v7's concurrency fixture. |
| 2 — the last-writer witness binds to `dev`/`ino`, which atomic replacement plus inode reuse defeats | **Bound to content.** The sidecar schema gains `stateBodySha256`, `stateSizeBytes`, and `stateMtimeMs`. Authority is stated so it cannot be chosen differently: the body hash and size are **authoritative**; `dev`/`ino`/`mtime` are corroborating and diagnostic. All five must match, failing closed either way — a body match with an identity mismatch is `barrier-witness-identity-drift`, and no path anywhere admits a witness on identity alone. `.rbox/state.json` carries no preamble, so its body and physical hashes coincide; the M2 body-vs-physical distinction stays scoped to preamble-prefixed backups. |
| 3 — M7's "all non-control artifacts absent or exact-terminal" contradicts role 5, whose inert temp can survive M6/M7 unchanged | **Resolved definitionally, widening no classifier.** For a role-5 path, *exact inert temp* **is** the exact-terminal disposition. M7 asserts it by `lstat` over a closed named set — one path per revision in this migration's own recorded revision interval — so no directory discovery enters (the cleanup vector's prohibition is untouched) and no new role is admitted. Doctor inert-temp quarantine remains the only remover, and it moves the path to `absent`, the other admitted value, so post-M7 cleanup can never invalidate a completed witness. |
| 4 — the reserve has no provenance: `B0` adopts any same-size file, M1 claims it, M6 deletes it, against a promise never to delete what `B0` did not create | **Provenance added to the bytes.** The first 64 bytes are a fixed-width ASCII header (`RBOX-STATE-RESERVE-v1 <creatingVersion> <stream>`, NUL-padded) with 1,048,512 zero bytes after it — same total size, same allocation guarantee. Adoption requires the header to parse and its `stream` to equal this workspace's; header absent, malformed, or foreign-workspace is `reserve-foreign`, which is **never adopted, claimed, truncated, or deleted** by `B0`, M1, or M6. `B0` halts its reserve protocol with that distinct typed condition; M6 role 7 re-reads and re-matches the header immediately before unlinking, and a mismatch is a corruption halt with zero writes. |
| 5 — the flip is still called "trivially clean by construction" | **Swept to the differential-gate framing.** Both surviving sites — the backend-first decisive-argument paragraph and rollout condition 3 — now say the flip is the run where a difference is *least expected*, held to the same gate as every other slice, rather than exempt from it. The remaining "by construction" occurrences are unrelated (an inert temp, a behavior-not-implementation test). |
| 6 — a heading gates U3 on "U4 reset/quarantine support" while its body says U2 | **Heading corrected to `U2`,** with the correction noted inline: reset is `U2` under the v6 resequencing and `U4a–U4f` is the engine port. |
| 7 — the doc claims exactly one open founder input; the frozen machine profile is a second | **Count corrected at the top.** The section is now "OPEN INPUTS OWED BY THE FOUNDER (v8 — there are exactly two)", naming the migration-timing question and the frozen machine profile, and declaring itself the authority on the count. The kill-criterion protocol's own paragraph now cross-references it as open input 2 of 2, so the frozen/owed status reads the same from both directions. |

V8 remains pending final ratification and is not implementation authority. Two
founder inputs are owed, both enumerated at the top of this document.

## R4-v9 residual fold (v9)

One review: the codex serial review of the v8 tip, 2026-07-29. **Two** residuals,
closed below. Row 1 also carries a correction to the v8 log row above it: the
"bound-by-bound discussion" that row 1 of the v8 table credits contained two
claims that do not survive contact with the source, and v9 removes them rather
than leaving a log row asserting a bound the code contradicts. Consistent with
the standing rule — *the review log records a closure, it never constitutes
one* — the v8 rows are left as the record of what v8 did; the corrections live
in the normative sections and in this table.

| Residual | Disposition in v9 |
|---|---|
| 1 — the paired witness sample is not atomic with M6's rename, so a pre-`1.11.0` unsafe writer can publish *after* the final sample and *before* the rename; M6 then overwrites that fresh JSON with `Q` while the migrated DB and M2 backups descend from the older source. A silent lost write, distinct from the post-`Q` destruction `F3` asserts, and unnamed in v8 | **Window shrunk, residue split into two named outcomes, and the falsified bounds withdrawn.** (a) M6 re-verifies `.rbox/state.json`'s `stateBodySha256` against the M3-imported source digest as the **immediately preceding operation** to `fs.rename`, under the `stateLockPath` it already holds — a mismatch is a typed `legacy-write-detected` disposition that does not rename and enters C1 retirement with JSON authoritative. V8 already rehashed the live JSON but did so at the *start* of the M6 exact-sibling step, with fsync/hash/identity-bracket work between check and rename; v9 makes it the last instant. It is explicitly **not** atomic (`writeFileAtomic` exposes only `beforeRename`, `fsutil.ts:40`), it only reduces exposure to the `check → rename` instants. (b) The residue is restated as **two** outcomes: **(i)** post-`Q` destruction, detectable as `legacy-overwrite-after-Q` (`F3`); **(ii)** the pre-`Q` lost write in the microwindow (`F5`). (c) Recovery and detection for (ii) are stated without overclaim: **unrecoverable and silent.** `fs.rename` (`fsutil.ts:83`) releases the displaced inode, M6 never opened it — so "preserve the displaced content" is not implementable, and M6 can only preserve what it read, which is the already-backed-up older source. No `.bak` diverges, no witness records it, and there is no `legacy-overwrite-after-Q` analogue; `F5` asserts the *absence* of a doctor anomaly so the silence cannot drift. What limits damage is convergence, not detection: `state.json` is a manifest cache plus derived git records, so the failure mode is a **stale BASE** whose consumer is already fail-closed (redundant deferral, never silent overwrite). *[SUPERSEDED — this bound was false when written: the R4-v10 review executed the merge consumer and proved the ABA silent overwrite; see the R4-v10 row and the v10 residue passage, which are authoritative.]* (d) **Falsified-necessity correction.** V8's row 1 claimed the residual "requires the writer's read→rename window to span the entire M0–M6 migration" and that the writer must "complete its state read before M0 begins". Both are false: `saveStateSource` reaches the unsafe writer at `sync-state.ts:348-350`, and its callers separate read from write by a whole sync — push loads at `push.ts:476` and saves at `push.ts:532-540`; pull loads at `pull.ts:233` and saves at `pull.ts:414-446`. The preconditions are now stated as exactly what is required: a pre-`1.11.0` binary, the `forceLegacy`-or-`unsupported` path (`pull.ts:446`, `push.ts:540`/`:580`/`:895`, or fresh-init `saveState`; `writeWholeStateUnsafe` at `sync-state-store.ts:338-370` takes no lock), and a rename landing in one of the two windows. Ratifiability is pinned to the `B0` adoption gate and made a hard U3 exit criterion — if telemetry cannot show the pre-`1.11.0` population drained, U3 does not open. |
| 2 — the specified `RBOX-STATE-RESERVE-v1 <semver> <stream>\n` header cannot fit 64 bytes; real streams are 71 bytes on their own | **Re-encoded to a 128-byte header, with the arithmetic shown.** Fixed overhead is `21` (magic) `+ 1 + 1` (separators) `+ 1` (`\n`) `= 24` plus the two variable fields. A verbatim stream needs `24 + 6 + 71 = 101` bytes and a full SHA-256 hex digest needs `24 + 6 + 64 = 94` — both over 64 — and truncating hex to fit 64 makes the digest width a function of the semver (34 hex for `1.11.0`, 18 for `1.11.0-rc.3+2026072701`), which is neither fixed-width nor collision-resistant. All three 64-byte forms are rejected in the doc. The header is now **128 bytes**: magic, space, semver (`<= 40` bytes; a longer semver refuses to create rather than truncating), space, the lowercase SHA-256 hex of the workspace `stream`'s UTF-8 bytes (64 chars), `\n`, NUL-padded — fixed overhead `21 + 1 + 1 + 64 + 1 = 88`, leaving exactly 40. Zero fill becomes **1,048,448** bytes and `128 + 1,048,448 = 1,048,576`, so total reserve size and the allocation guarantee are unchanged. M1 adoption and M6 role-7 deletion are stated as one rule — **byte-for-byte equality of all 128 bytes** with the CAS-recorded header — and `reserve-foreign` now covers a malformed 128-byte frame (bad magic, oversized/ill-formed semver, non-hex or wrong-length digest, missing `\n`, non-NUL padding) or a digest naming a different workspace. |

V9 remains pending final ratification and is not implementation authority. The
same two founder inputs are owed, both enumerated at the top of this document.

## R4-v10 residual fold (v10)

One review: the codex serial review of the v9 tip. Both v9 closures and the
128-byte reserve arithmetic were **verified as real**; one blocker.

| Residual | Disposition in v10 |
|---|---|
| The F5 blast-radius bound is false: "a lost save leaves a stale BASE … redundant conflict detection, never a silent content overwrite" does not survive the merge consumer. Executed counterexample: lost save was the BASE advancement to `B1`; user intentionally reverts the file to `B0` contents; next pull sees stale BASE `B0`, local `B0`, remote `B1`; `reconcile` (`src/engine/reconcile.ts:60`) classifies `local == base` as an ordinary remote write and `apply` (`src/engine/apply.ts:287`) replaces the file with no conflict copy — the intentional revert is silently overwritten | **Bound withdrawn, stronger consequence named, fixture added.** The residue paragraph now states the reachable worst case plainly — a silent overwrite of a user edit that recreates a superseded state, in the lineage where the lost save was that path's BASE advancement — and confines the surviving fail-closed claim to the cases where local differs from base. New fixture `F6` extends `F5` through the post-flip pull and asserts the silent `write` outcome (and the absence of any anomaly), so a future BASE-generation mechanism that converts this case into a conflict turns `F6` red and upgrades the documentation. The ratification argument is unchanged **because it never rested on the withdrawn bound**: it rests on the preconditions (pre-`1.11.0` binary actively racing a migration in a two-instant microwindow) and the hard U3 exit criterion — telemetry-verified drain of the pre-`1.11.0` population, or U3 does not open. |

*(Written before ratification; v10 was ratified later the same day. Its
statement that two founder inputs are owed is superseded by v11 — see the
R4-v11 section below and the open-inputs list at the top.)*

## R4-v11 founder requirement reduction (v11)

Not a review round. **An amendment to a ratified document, taken from two
founder decisions of 2026-07-28**, both of which *remove* requirements. No
codex round produced these; the changed sections are therefore marked pending
codex re-confirmation while the rest of v10 stands as ratified.

| Founder decision | What v11 deletes | What v11 keeps |
|---|---|---|
| **5 — migration is explicit-and-exclusive ("parked car")** | Ambient/on-boot migration, in every form. M0's **paired-interval live-writer sampling** and its `legacy-writer-live` refusal (§ 1a closure part two) — the U3 implementation must not build them. The framing of outcomes (i)/(ii)/ABA and the `check → rename` microwindow as *load-bearing named residuals* | The two admitted entry points, the `migration-not-exclusive` refusal, and the full "What REMAINS" list in § "Founder requirement reductions" — `Q`/barrier, witness, reserve, M6's last-instant re-verify, `F1`–`F6`, every crash/resume/halt property |
| **6 — the drain gate reads existing `rbox-admin` version telemetry** | The implied obligation to build fleet drain telemetry. Issue #540 closed as **invalid** | The `telemetry-verified drain` bar itself, at full strength, in both the `B0` exit criteria and the U3 gate — sourced from the `rbox-admin` version view at zero implementation cost |

**Founder question status after v11.** Open input 1 (do the four external users
take the one-way migration before the payoff lands?) is **RESOLVED, with no
surviving fragment**: decision 5 converts the migration from something pushed
at a user into something a user runs — `rbox upgrade` or `rbox migrate`. The
obligations that outlive it (U3 no-regression gate, plain-English halt copy)
were already ratified and are not questions. **Exactly one input remains owed:
the frozen machine profile, blocking U5.**

**Not deleted retroactively.** B0 shipped in #539 with the witness sidecar, the
write-side barrier, the reserve, and the pinning inventory test. None of that is
withdrawn. It is now defense-in-depth against a scenario exclusivity excludes,
which is a fine thing for shipped code to be.
