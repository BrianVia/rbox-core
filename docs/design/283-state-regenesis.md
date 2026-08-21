# 283 — state.db re-genesis at open (schema v2 + the four deferred renames)

Status: DESIGN ONLY. No implementation in this PR.

Founder ruling 2026-08-21: 2.0 mints schema v2, v2's DDL carries the four
renames deferred from PR #804, and a store whose DDL fingerprint does not match
**rebuilds fresh at open** — a one-time sync re-baseline per device — instead of
today's hard refusal in `src/cli/state-plane/schema/validate-open.ts`.

This is option (ii) in `docs/wire-rename-candidates.md` ("DEFERRED cluster").
Option (i) — a real in-place migration engine — is rejected by that ruling and
is not revisited here.

---

## 0. Problem

`state.db` has no migration mechanism. `applySchemaV1` is a bare
`db.exec(SCHEMA_V1_DDL)`; there is no `ALTER TABLE` anywhere in
`src/cli/state-plane/`. `STATE_STORE_DDL_FINGERPRINT`
(`schema/application.ts:11`) is a hardcoded `sha256(SCHEMA_V1_DDL)`, written
into `store_meta` at genesis, and `validateOpen` throws
`StateStoreOpenError("ddl-fingerprint", …)` on any mismatch
(`validate-open.ts:68-70`). There is no rebuild, re-import, or quarantine path
for that reason.

Consequence: renaming one column is a fleet-bricking change. Four fields are
stuck behind it:

| field | v2 spelling |
|---|---|
| `repo_records.cfg_shape_cjson` (+ `RepoRecordInput.cfgShape`) | `cfg_store_cjson` / `cfgStore` |
| `ConfigStoreIdentity.shape` (nested inside that column's CJSON) | `repoKind` |
| `migration_completion.source_shape_flags_cjson` | `source_presence_flags_cjson` |
| digest token `"source-shape-flags"` | `"source-presence-flags"` |

The nested one additionally breaks `canonical_bytes` for every existing
`repo_records` row: `decodeRepoRecord` re-encodes on read and throws
`structural corruption in RepoRecord <relPath>` on a length mismatch. So even a
schema tolerating the column rename could not tolerate the nested rename.

---

## 1. The shape of the answer

### 1.1 Round 1: a store-opaque rebuild, and why it failed

The first draft treated re-genesis as a **store-opaque rebuild** bolted onto
genesis admission: refuse to read the superseded store, settle git artifacts
from disk alone, quarantine the file, mint fresh. Codex round 1 returned four
CRITICALs and eleven further findings, and six of the fifteen were the same
fact from six angles:

> Everything this design wants to discard is **bound to the old lineage**, and
> nothing can be retired without knowing what that lineage was. Git artifacts
> are namespaced by `lineageHash(workspaceRootReal, stream, stateNonce,
> repoIdentity)` (`repo-lineage.ts:103-140`), not invertible from disk. The
> authority marker at `.rbox/state.json` names the old store, so removing the
> DB alone strands the authority rather than making it `absent`
> (`authority-bootstrap.ts:37,94`). `settleExactPresentArtifact` and the
> p-repair state port reload and CAS `state.db` outright
> (`p-settlement.ts:111`, `p-repair-state.ts:65`). Repository fences must come
> from persisted `RepoRecord`s, not ignore-pruned disk discovery, and
> repository locks precede the state lock (`locks.ts:78,116`).

Per the long-review-loop rule that was the moment to step out a layer instead
of applying fifteen patches.

### 1.2 The reframe

**The codebase already has exactly one mechanism that retires a lineage and
re-baselines a device: `resetSyncState`** (`src/cli/reset-state.ts`), the rebind
reset. Its own doc comment describes the product event precisely:

> "Discard the local sync baseline … Files on disk are untouched; the next pull
> writes without deleting and the next push publishes the full tree."

It already settles A/Z/P artifacts under the old lineage, recovers the checkout
journal, retires Z refs, chooses the unpruned repository fence from persisted
records in the established repository→state lock order, publishes a reset
journal (`beginSelectedReset`), and performs the physical marker+store cutover
under `settleStandingReset` with crash-resume.

> **Re-genesis is not a new birth protocol. It is a `resetSyncState` whose
> trigger is schema supersession, whose `nextStream` equals the current
> stream, and whose authorization is a schema tuple rather than user consent.**

Codex round 2 confirmed the frame: same-stream reset works, and eight round-1
findings — marker/store cutover, repository fence, lock order, quarantine-is-
not-rollback, downgrade refusal, standing v1 journals, darwin WAL, upload
costs, pull-only conflict/trash — are resolved by it.

### 1.3 Round 2: what the reframe cost, honestly

Round 2 returned five CRITICALs, all local to the seam between the reset owner
and a store it cannot open. The most important corrected a claim this design
made and had wrong:

> **The reset preflight is not read-only.** `settleExactPresentArtifact`
> reloads and CAS-writes the live store (`p-settlement.ts:111-164`), the
> p-repair port repeatedly reloads and CAS-writes it
> (`p-repair-state.ts:75-173`), and reset mints a nonce for a nonce-less store
> by **writing** it (`reset-state.ts:432-449`). Its field usage is also far
> wider than a narrow projection: `lastSyncedManifest`, `repoGen`, `sourceSeq`,
> the complete `base` including `refScope`, every `RepoRecord` field preserved
> through `...withoutGeneration`, and `telemetryBindingId`.

So "one small read-only projection function" was wrong, and §3 now says what is
actually required. The design is still not option (i) — no `ALTER TABLE`, no
in-place re-encode, no lineage preservation, no N×N version matrix — but it is
bigger than the previous draft claimed, and §12's ledger reflects that.

---

## 2. Non-goals

- No in-place migration, `ALTER TABLE`, or schema conversion of any store.
  `SCHEMA_V2_DDL` is the only DDL the binary ever *creates*.
- No new birth protocol, no second store-mutation owner, no second CAS driver
  (design 264's structural gate), no new lock, no new lock ordering, no new
  durable "blocked" record.
- No change to the wire, D1, or the server.
- No change to `rbox config regenerate` or folder-config authority (231).
- Full darwin validation and the implementation itself are out of scope for the
  PR carrying this document.

---

## 3. The new component: the v1 retirement port

### 3.1 What it actually is

A **retained v1 access port** — the v1 codec's read path plus the narrow CAS
write path the retirement protocol requires — living beside v2 and used only to
retire a superseded lineage. Corrected from the previous draft's "read-only
projection", per R2 #2 and R2 #3.

It must supply:

- the full `SyncState` the reset preflight consumes, not a subset:
  `stream`, `stateNonce`, `stateRevision`, `lastSyncedSequence`,
  `lastSyncedManifest`, `telemetryBindingId`, and per repo the complete
  `RepoRecord` including `repoGen`, `sourceSeq`, and `base.refScope`;
- the **v1 canonical encoding**, because `canonical_bytes` and
  `retained_estimate` must verify against v1 rows and will not verify under
  v2's spelling;
- the CAS writes the settlement protocol performs against the retiring store:
  P settlement, p-repair receipts, and nonce minting for a nonce-less store
  (R2 #3).

Bounds — what keeps this from being option (i):

1. **It never converts.** No `ALTER TABLE`, no v1→v2 row rewrite, no lineage
   preservation. Its writes are protocol-completion writes to a store that is
   about to be quarantined, not durable-value writes.
2. **It is the only opener *component* of a superseded store.** No other code
   path may open one. It opens twice — once for pre-fence discovery and once
   under the full fence (§6.1) — and only the fenced open seals. R3 #1
   corrected the earlier "exactly one open" phrasing, which was circular.
3. **It is version-exact.** It understands exactly the released v1 fingerprint
   and nothing else (§4).
4. **One frozen header.** `store_meta` and `state_lineage`'s
   `application_id`, `schema_version`, `ddl_fingerprint`, `authority_id`,
   `active_lineage_id`, `stream`, `state_nonce`, `state_revision`,
   `last_synced_sequence` may never be renamed or retyped in any future schema:
   every future re-genesis reads them from a store it cannot otherwise
   classify. None of the four renames touches them, so v2 pays nothing. A
   structural test asserts the frozen set.

### 3.2 The recurring cost, stated plainly

Every future schema generation must retain its predecessor's access port past
that predecessor's deletion. That is a real recurring tax — roughly one codec's
read path plus a narrow write path per generation — and it is larger than the
previous draft admitted. It buys: no migration engine, no N×N matrix, no
re-encode of live rows, and a device that re-baselines instead of bricking.
Founder question 3 in §13 asks whether to accept it as standing policy.

### 3.3 Lineage reconstruction is conditional — R2 #7

`lineageHash` inputs are `workspaceRootReal`, `stream`, `stateNonce`, and the
complete `RepoIdentityV1` — worktree realpath, per-worktree gitdir, shared
common-dir realpath, and common-dir dev/ino/birthtime
(`repo-lineage.ts:14-23,85-140`). None of the identity part is in the frozen
header or in v1 `repo_records`; reset reconstructs it from **current disk**
(`reset-state.ts:66-78,95-107`). `stateRevision` and `lastSyncedSequence` are
not lineage-hash inputs; the previous draft implied otherwise.

Therefore retirement is **conditional, with safe refusal as the failure mode**:

- unchanged ordinary repos and linked worktrees sharing an unchanged common
  dir — the old hash reconstructs, artifacts retire correctly;
- after a workspace move, worktree repoint/removal, or common-dir
  move/replacement — the old hash cannot be reconstructed, and the artifacts
  are refused as foreign (`reset-state.ts:109-118`), which is today's behavior
  and is safe.

Stated as conditional safe refusal, not universal retirement.

### 3.4 The keys that mattered — R1 #1

R1 #1 was the review's most serious finding and the first draft was simply
wrong: `gitReposRemoved` (`removed_key`, `sync-state-model.ts:30`) is the only
durable memory distinguishing "an untouched local leftover whose remote repo
was deleted" from "a new repository to publish". Losing it **resurrects
remotely-deleted repositories on the next push**. `resolution_key` similarly
suppresses publication of conflicted local refs. Neither is reconstructible
from disk plus remote state.

### 3.5 Why the data carry was cut — the step-out

Three consecutive review rounds landed on the *same auxiliary mechanism*, each
time proposing a new home for these keys:

| round | proposal | why it failed |
|---|---|---|
| R2 #4 | seed rows into the candidate DB after genesis | crash before the save loses them silently |
| R2 #4 fix | seed rows into the candidate DB **before** its hash enters the journal | R3 #2: candidate bytes cap at 262,144 with 126,976 already used; carried rows are not aggregate-bounded to the ~135 KiB headroom |
| R3 #2 fix | a bounded carry record inside the reset journal | R4 #1: applying it changes the DB hash, which recovery classifies as `other`, so it is not actually resumable; R4 #2: the 512 KiB journal still cannot represent the supported v1 domain |

Per the long-review-loop rule, rounds clustering on one auxiliary mechanism
means that mechanism is instrumenting a state the core design should eliminate.
So it is eliminated: **re-genesis carries no per-repo data at all.**

The question underneath was never "where do we put the map". It was "how do we
stop the first post-re-genesis push from doing something irreversible". A map is
one answer; a **posture** is a smaller one:

> **Post-re-genesis publication quiesce.** The freshly minted v2 store records a
> `regenesis_pending` flag at genesis. While it is set, the git lane adds no
> repository to the manifest that the server's BASE does not already contain,
> and publishes no conflicted refs.

R5 #1 then showed that a timed quiesce is not enough on its own, and the proof
is worth keeping because it determines the final shape. A pull considers only
`remote ∪ BASE ∪ pending` (`sync-git/apply.ts:227`), so a remotely-deleted
repository surviving only on disk is invisible to it and `removedKey` cannot be
reconstructed (`apply.ts:481`). Once the flag clears, push discovers the disk
repository (`plan.ts:1069`) and, with neither BASE nor `removedKey`, admits it
as a new capture (`repo-capture-attempt.ts:135`) — a state **identical** to the
genuinely new local repository the design requires to publish. Releasing one
necessarily releases both. A quiesce that ends on a timer or a "clean cycle"
therefore only *delays* resurrection.

So the quiesce does not end on a timer. It ends when the ambiguity is gone:

An intermediate draft tried to derive an **ambiguous set** — local repositories
on disk but absent from the freshly-pulled BASE — quiesce only its members, and
clear the flag when the set emptied. Round 6 returned three CRITICALs and they
share one root cause worth stating, because it is the finding that determines
the final shape:

> **The client cannot enumerate this set completely.** `discoverGitRepos`
> deliberately prunes ignored subtrees and converts `readdir` failures to an
> empty result (`engine/git-discover.ts:14`). A remotely-deleted leftover inside
> an ignored subtree is invisible at re-genesis, so the set computes empty, the
> flag clears, and un-ignoring the subtree later resurrects the repository — the
> exact ignored-leftover case the existing contract retains `removedKey` for
> (`sync-git/git-sync.test.ts:3031`). Scope-excluded repositories, unreadable
> subtrees, and `syncGit:false` devices (where Git apply returns before
> examining any repository, `sync-git/apply.ts:226`) evade it the same way.

No client-side inventory of this is complete and fail-closed, so the design
stops requiring one. That is the second step-out in this review, and the
repeated failures are evidence about the problem rather than about the drafts:
five of six rounds attacked some version of "decide, on the device, the fate of
repositories the device cannot fully see."

> **The quiesce is sticky and is never cleared.** While `regenesis_pending` is
> set, the outgoing git layer:
>
> 1. **omits every repository the server's BASE does not already contain**,
>    unless that exact repository is covered by a live operation-scoped grant;
>    and
> 2. **makes no publication change to a BASE-known repository until a
>    git-capable, in-scope pull has actually examined it** and established local
>    BASE / pending / resolution evidence for it. Absent that evidence, the
>    repository is republished unchanged, not re-planned.
>
> No enumeration, no per-repo durable record, no completeness requirement. The
> explicit command does not clear the flag: it grants a **preview-bound,
> operation-scoped bypass** for exactly the repositories it showed and the user
> confirmed. Those become server-known and need no further grant. Anything not
> shown stays blocked.

Clause 2 is R9 #1, and without it the design has a live hole. `resolution_key`
re-derives on pull only if the pull *looks at repositories*: a `syncGit:false`
pull returns before examining any (`sync-git/apply.ts:226`), and a
scope-excluded pull has the same gap. The failure is concrete — re-genesis
discards a live conflict guard; a git-disabled pull advances the device to the
current server sequence without re-deriving it; git is then enabled; a direct
push captures the divergent repository, which clause 1 permits because it *is*
server-known, and which no commit conflict forces a pull first because the
sequence is already current. Conflicted refs publish silently.

Clause 2 closes it fail-closed and needs no new durable primitive: "has a
git-capable pull examined this repository" is answered by whether the new store
holds re-derived evidence for it. No evidence means no change — the safe
direction, and automatically true for exactly the repositories a limited pull
skipped.

R8 #2 is important for the implementer and worth being exact about: `plan.gitRepos`
is the **complete outgoing git layer, not an additions delta**
(`sync-git/plan-accumulator.ts:301`, `sync/publish-candidate.ts:317`). "Adds no
repository" therefore describes the *filter's effect on BASE-absent entries*, and
must not be implemented as "emit an empty git layer" — that would drop
server-known sections and de-publish existing repositories. The invariant is:
**filter BASE-absent additions unless covered by an exact grant; and for
BASE-known repositories, copy the exact previous wire section unchanged until
repository evidence exists, handling them normally only afterward.**

R7 established why the flag must not clear globally. An intermediate draft had
the command clear it, and that recreated the very hole §3.5 exists to close: a
hidden leftover — ignored, unreadable, out-of-scope, or invisible because
`syncGit:false` — escapes the preview, the flag clears on the strength of some
*other* repository the user confirmed, and the leftover is then silently
captured the moment it becomes visible. Discovery still prunes and swallows read
errors (`engine/git-discover.ts:46`), so "confirmed once" can never be evidence
about repositories that were never shown.

Scoping the grant to the previewed set removes that inference. Consent covers
what was displayed and nothing else.

Why this is the right shape and not merely a smaller one:

- **Nothing needs to be enumerated to be safe.** Safety no longer depends on
  discovery seeing everything, which R6 #1 proved it cannot. An ignored,
  unreadable, or out-of-scope leftover is not published because *nothing* is
  published — the fail-closed direction, by construction rather than by
  inventory.
- **Nothing crosses the transition.** No per-repo data carry, no size bound, no
  new crash-atomicity problem. The step-out of §3.5 holds.
- **It cannot wedge.** A device that never runs the command keeps syncing files
  and following existing repositories indefinitely — a benign steady state, not
  a halt. There is no predicate to compute and nothing to get stuck on, which
  answers R5 #2 and R6 #2 by deleting the question.
- **It has one enforcement point.** R7 verified this against the code:
  `GitPlanAccumulator.plan()` owns outgoing-versus-previous wire sections
  (`sync-git/plan-accumulator.ts:301`) and the publisher attaches that plan
  exactly once (`sync/publish-candidate.ts:317`). The config lane, republish
  requests, keep-mine resolution, `adopt`, and `track` do not bypass it. The
  quiesce is one check in one place, not a scattered predicate.
- **There is no `forget` path to make safe.** R6 #3's hardest requirement —
  that forgetting a member must atomically install an identity-bound
  `removedKey` or physically delete the repository — disappears, because
  membership does not exist. Not publishing is the default and needs no
  transition.

**The residual, named honestly:** if the user is shown a remotely-deleted
leftover in the preview and confirms it, that repository is republished. This
design does not prevent that — it converts a *silent data reversal* into a
*shown, confirmed action*. The command must therefore list what it will publish
before doing it, which is also the founder's acknowledge-a-match posture rather
than a typed confirmation. Because the grant is preview-bound, this is the only
remaining resurrection path.

**The standing cost, named:** the flag never clears, so a re-genesised device
asks before introducing *any* repository, permanently — including repositories
created long afterwards, which have nothing to do with the rebuild. That is a
durable behavioral difference between re-genesised and fresh devices, and it is
the price of not inferring consent about things the device cannot see. Founder
question 4 in §13 asks whether to accept it or to define a convergence back to
the default.

`resolution_key` needs **no carry, but does require clause 2 until it is
conditionally re-derived.** R5 confirmed it reconstructs for remote-present
repositories: with no BASE, any existing local identity is divergent
(`sync-git/shared.ts:110`), pull persists the conflict guard (`apply.ts:798`),
and later pushes suppress publication while the identity matches. R9 #1 then
established the qualification that makes this safe rather than merely usually
true: that reconstruction happens only on a **git-capable, in-scope** pull, so
until such a pull has examined the repository, clause 2 is what holds the line.

**The cost, named:** on a device that has unpublished local repositories or
remotely-deleted leftovers, the user answers one question per such repository,
once. As against silently resurrecting a repository they deleted on another
device.

### 3.6 What is still carried: nothing new

`telemetryBindingId` continues to cross the transition because **reset already
carries it** through its own genesis (`reset/lifecycle.ts:62-77,150-175`). It
rides existing behavior; re-genesis matches reset rather than diverging (R2
#11). This is not a new mechanism and is not part of any carried set.

**Also not carried, and not needing to be, per R2 #6:**

- `cfg_synced` / `cfg_applied` — carrying them without `cfg_shape` causes the
  lane to be discarded when store identity is established, and without
  `cfg_token` application is due anyway
  (`received-git-config.ts:131-154,258-276`). Accepted cost: one redundant
  config publish and one redundant config apply per repo, contingent on §7.
- `repo_absent` — it only hides a protected BASE
  (`sync-state-model.ts:325-329`); re-genesis discards that BASE and ordinary
  capture clears `repoAbsent` (`plan-accumulator.ts:153-161`). An otherwise
  empty `repo_absent` row is not a durable "never republish" tombstone.
  Building one is a separate design; the quiesce in §3.5 covers the window it
  would have covered.

**Rejected alternative:** refuse re-genesis while any `removed_key` is live.
Deadlock — the only way to clear one is to run rbox, and rbox cannot open the
store.

---

## 4. Trigger boundary

`validateOpen` gains one new classification, `"schema-superseded"`, and **no new
behavior**: it does not rebuild.

Return `schema-superseded` if and only if **all** hold:

- the file opens as SQLite (no `SQLITE_NOTADB`, no `SQLITE_CORRUPT`),
- `store_meta` yields its singleton row,
- `store_meta.application_id === STATE_STORE_APPLICATION_ID`,
- `PRAGMA application_id === STATE_STORE_SQLITE_APPLICATION_ID`,
- `store_meta.schema_version` names a version with a retirement port — for 2.0,
  exactly `1` — **and `ddl_fingerprint` equals that version's exact released
  fingerprint**, **and `PRAGMA user_version` equals that port's exact expected
  value** (`1`), **and** the v1 required-object and singleton/head invariant
  checks pass under v1's own expectations.

The `user_version` clause is R3 #3. `validateOpen` deliberately binds both
SQLite identifiers today (`validate-open.ts:71`); once §4.1 widens the raw header
gate to admit older `user_version`s, omitting it would let a **mixed** store —
`user_version = 2` with v1 metadata — be retired as superseded rather than
refused as damaged. Both SQLite identifiers must be bound exactly, per port.

The fingerprint-equality and v1-invariant requirements are R2 #9: without them a
damaged or foreign layout that merely *claims* `schema_version = 1` would be
retired, contradicting this design's central promise that corruption handling is
untouched. A store claiming a known version with an unknown fingerprint is
corruption, not supersession.

Everything else is unchanged and still fails closed: `not-a-database`,
`corrupt`, `foreign-by-absence`, `wrong-application`, `structural-invariant`,
and missing required objects. A store whose `schema_version` is **greater** than
the binary's refuses — "this workspace was last used by a newer rbox; upgrade" —
per design 266's one-way version posture. **A newer store is never rebuilt
downward.** An older version with no port refuses rather than being discarded
blind.

### 4.1 Reachability — R1 #8

Not reachable today; this is implementation scope, not a footnote:

- `store/open.ts:326`'s file-header gate reads `user_version` **before** SQLite
  opens and rejects v1 outright. It must admit versions in the known-port set,
  deferring the decision to `validateOpen`.
- `authority-open.ts:29` translates open errors into hard authority corruption;
  `schema-superseded` must survive that translation.
- `admitGenesisAuthority` (`authority-bootstrap.ts:94`) fast-returns any
  selected `sqlite-store`; it needs the superseded variant.
- The daemon parks only on `GenesisAdmissionRefusedError` (`daemon.ts:1627`);
  `init`/`track` read raw before admission (`init-cmd.ts:470`).

`observeStateAuthority` gains a `superseded` variant, and the **single owner of
the transition** is the reset path invoked from admission. Every other caller
keeps failing closed and re-drives once after the transition completes. 266's
"one birth protocol" and 263's "one observer" are preserved: re-genesis is a new
*reason to retire a lineage*, not a second way to mint one.

### 4.2 Flip-flop — R1 #11

A unit test cannot prove "the version literal changed in the same commit." Two
guards, neither pretending to be the other:

1. **Release-time, VCS-aware:** CI compares `STATE_STORE_SCHEMA_VERSION`,
   `STATE_STORE_SQLITE_USER_VERSION`, and `STATE_STORE_DDL_FINGERPRINT` against
   the previous release tag and fails if the fingerprint moved without both
   versions moving. This is the real guard.
2. **Runtime damage bound:** a `regenesis.ledger` line (fingerprint, timestamp,
   binary version) per rebuild; a fourth rebuild in 24h refuses. This *bounds* a
   flip-flop. The earlier claim that it made flip-flop impossible is withdrawn.

Between released versions §4's exactness does the work: v2 has no port for v3,
so it refuses upward rather than rebuilding downward.

---

## 5. What is lost, kept, and re-derived

**D** re-derivable from disk · **F** re-fetchable from the server · **M** minted
· **C** crosses via reset's existing behavior (§3.6) · **L** lost.

### 5.1 Identity and lineage

`store_meta.*` and `state_lineage.{lineage_id, active_base_generation,
local_revision, repo_records_authoritative}` — **M**.
`telemetry_binding_id` — **C** (R2 #11; reset carries it).
`stream` — **D** (`syncStreamId(config)`), and read from the old store to
compute the retiring `lineageHash`.

Per R3 #6, the old draft's **F** label on the lineage counters was wrong:
`state_nonce` is **M** — newly minted by the reset, not fetched — and
`state_revision` is **M**, derived and advanced by the reset. Only
`last_synced_sequence` is **F**, re-established by the first pull. All three are
*read* from the superseded store for retirement (nonce and stream to compute the
retiring `lineageHash`; see §3.3), which is a separate purpose from how the new
store's values are obtained.

### 5.2 The BASE plane — **F**

`plane_heads(plane='base')`, `plane_entries`, BASE-referenced `entry_values`,
`global_manifest_meta`, `manifest_chain`, `manifest_git_sections`: a local
projection of the encrypted manifest the server holds, trigger-gated to an
owning BASE generation (`v1.ts:187-204`). `entry_values` holds metadata only —
`sha256`, `size`, `mode`, `mtime_ms`, `kind`, `symlink_target`, plus encryption
bookkeeping. It never holds bytes.

### 5.3 The LOCAL plane — **D**

`local-plane.ts` states it: LOCAL is rebuildable, which is why it needs no CAS
packet, and `invalidateLocalPlane` already clears `complete` on any
watcher-observed mutation. Cost of losing it is one full workspace walk — a cost
the product already pays after any invalidation.

### 5.4 `repo_records`

| column | class | note |
|---|---|---|
| `base_cjson`, `advertised_cjson` | F | last confirmed BASE / last acknowledged wire checkpoint. Read in full (incl. `refScope`) by the retirement preflight. |
| `pending_cjson` | F | **incoming** server section held because local refs conflict — server state, not local work. The conflicting local commits live in the repo's object store, untouched. |
| `branch_base_origins_cjson` | D | re-proven on next pull |
| `packed_refs_identity` | D | restore-detector fingerprint |
| `removed_key` | L, covered | R1 #1 — resurrection guard. Not carried. Covered **permanently** by §3.5's sticky BASE-absent-addition gate plus its preview-bound operation-scoped grant. The flag never clears. |
| `resolution_key` | D, conditionally | R5 #1 — re-derived by a **git-capable, in-scope** pull: with no BASE any existing local identity is divergent (`sync-git/shared.ts:110`), pull persists the conflict guard (`sync-git/apply.ts:798`), and later pushes suppress publication while the identity matches. R9 #1 — a `syncGit:false` or scope-excluded pull re-derives nothing, so §3.5 clause 2 withholds publication changes until such a pull has examined the repository. |
| `repo_absent` | L | R2 #6 — not a tombstone; withdrawn from the carry |
| `cfg_synced`, `cfg_applied` | L | R2 #6 — withdrawn; costs one redundant publish + apply |
| `cfg_token_cjson`, `cfg_shape_cjson` | D | re-read git config |
| `deferrals_cjson` | D | classifier recomputes each boundary |
| `partial_cjson` | D + read and CAS-written by the retirement preflight |
| `attempt_cjson` | D | local-only held-follow observation, never wire-visible |
| `resolution_receipt_cjson` | §5.6 | |
| `idx_proj` | D | projected-index cache |
| `repo_gen`, `source_seq` | read by the port for CAS; **M** in the new store |
| `canonical_bytes`, `retained_estimate` | M | v1-canonical on read, v2-canonical on write |

### 5.5 Accepted losses

- `migration_completion.*`, `legacy_state_maps.*` — **L**. Historical audit of a
  one-time JSON→SQLite import whose source tree design 262 already deleted.
  After re-genesis the row is `origin_kind='genesis'`, which is what every fresh
  2.0 device already looks like. Requires a compatibility test for the
  absent-versus-empty legacy `gitRepos` behavior `source_shape_flags_cjson`
  controls (R1 #13), not a carry.
- `extras_cjson` — **L**, and not vacuous: it deliberately round-trips fields
  written by a *newer* binary. Because §4 refuses newer stores outright, a
  superseded store's extras can only have been written by an older or equal
  binary, so nothing newer is dropped. An argument, not an assumption, and
  testable.

### 5.6 In-flight publication receipts

`resolution_receipt_cjson` records that a keep-mine publication **may have**
reached the server. Its only consumer, `reconcileResolutionReceipt`
(`sync/pull.ts`), exists precisely because the receipt is not the source of
truth — it reconciles against `api.latest()`, authenticated remote truth.
Dropping it costs at most one repeated `rbox git resolve`, never content. Not
carried; named in the user-facing message.

---

## 6. Mechanism

### 6.1 Sequence

`resetSyncState`'s existing sequence, reordered per R2 #8, with the insertions
marked **bold** and consent removed:

1. Acquire the live-owned, **non-degraded** workspace sync mutex.
2. **Drain any standing reset first**, then reclassify and re-observe — existing
   reset already recurses after settling a journal precisely to observe the
   resulting lineage (`reset-state.ts:346-352`). The previous draft projected
   before draining, which observes a stale lineage.
3. **Pre-fence discovery projection.** Open the superseded store through the
   port and read only what enumerates the repository fence: the record key set,
   `base.refs`, and `branchBaseOrigins`. **Capture the lineage/fence snapshot
   tuple** that step 5 will compare against. No settlement, no checkpoint, no
   write — and **return the DB to S0** (no live `-wal`/`-shm`) on close, so this
   discovery open cannot itself manufacture the sidecar state §6.6 forbids.
4. Choose the repository fence from those records (unpruned, persisted) and take
   repository locks, then the state lock, in the established order
   (`locks.ts:78,116`).
5. **Fenced projection and revalidation.** Under the canonical state lock,
   re-open through the port, re-project in full, and **refuse if the lineage or
   any repository identity differs from the step 3 snapshot** — the same
   discipline reset already applies when it re-resolves every checkout under its
   common-dir locks and refuses on an identity change (`reset-state.ts:327`, and
   the identity-recheck loop that follows). **This handle stays open** through
   step 6.
6. Settle A/Z/P artifacts and p-repair under the **old** `lineageHash` on that
   open handle; recover the checkout journal; refuse on foreign or malformed
   artifacts. Must cover the terminal-Q state (§6.5). Mint a nonce first if the
   store is nonce-less (§6.3).
7. **Checkpoint and close** — `wal_checkpoint(TRUNCATE)`, which rejects a
   readonly handle (`store/open.ts:183-203`) — immediately before publication,
   producing the sealed witness (§6.2). Then recheck the lineage under the state
   lock, as reset does today (`reset-state.ts:363-407`).
8. Publish the reset journal via `beginSelectedReset` with
   `nextStream === currentStream` and authorization
   `{ kind: "schema-superseded", fromSchemaVersion, fromFingerprint,
   toSchemaVersion, toFingerprint }`.
9. `settleStandingReset` performs the physical marker+store cutover with its
   existing crash-resume. The v2 store is installed from the journal-embedded
   bytes, with `regenesis_pending` set (§3.5).

R4 #3 corrected the ordering: the previous draft checkpointed at step 5, before
the settlement writes of step 6, contradicting §6.2's own
`open → settle → checkpoint → close`. Sealing is now the last thing that happens
to the superseded store, and nothing writes to it afterwards.

The step 3 / step 5 split is R3 #1. The previous draft required projected
records before repository locks *and* permitted the only open after those locks
— circular, because disk discovery cannot substitute for persisted records. The
two-phase discover-then-revalidate arrangement above is exactly what reset does
for its own common-dir locks, so it introduces a sequencing rule rather than a
new authority.

### 6.2 The sealed-witness rule — R2 #1

R2 #1 is a genuine blocker in the previous draft: after the port closes the
store, `beginSelectedReset` dispatches to `beginSqliteReset`
(`reset-journal.ts:344-360`), which calls `quiesceActiveDbForReset`
(`reset/recovery.ts:400-410`), which independently calls ordinary
`openStateStore` (`reset/lifecycle.ts:53-83`) — whose header gate and
current-schema validation reject v1 (`store/open.ts:334-375`,
`validate-open.ts:65-74`). The superseded DB can never reach journal
publication.

Fix: **reset quiescence consumes a sealed witness instead of re-opening.** The
retirement port is the only component permitted to open a superseded store; it
performs the open → settle → checkpoint → close under the held state lock and
hands `beginSqliteReset` the sealed witness (stable hash plus sealed state) that
quiescence would otherwise have produced itself. `quiesceActiveDbForReset` gains
one parameter and no new authority.

This also satisfies the darwin constraint in §6.6: exactly one opener, which
leaves no live `-wal`/`-shm` behind.

### 6.3 Nonce-less v1 stores — R2 #3

Fresh genesis deliberately installs neither `state_nonce` nor `state_revision`
(`genesis.ts:159-170`); both are nullable by contract (`v1.ts:15-24`). Reset
handles this by **writing** the old store to mint a nonce
(`reset-state.ts:432-449`), and artifact preparation refuses without one
(`reset-state.ts:92-99`).

This is why §3.1 abandons the read-only rule: the v1 port must support nonce
minting against the retiring store. A device that installed 2.0 and never
completed a first sync is an ordinary case, not an edge case, and must not be
excluded.

### 6.4 The quiesce flag, and why there is no carry to make atomic

§3.5 cut the data carry, so the crash-atomicity problem that consumed rounds 2
through 4 no longer exists. What replaces it needs no new atomicity of its own:

`regenesis_pending` is a column in v2's `state_lineage`, set **by genesis, in
the candidate DB, as part of the bytes the journal already embeds and
authenticates** (`reset/recovery.ts:405-468`). It changes the seed the journal
hashes — deterministically, before publication — rather than mutating the
installed DB afterwards. Recovery's existing three-way classification (old, the
exact `next.stateSha256`, or other — `reset/recovery.ts:209`) therefore keeps
working unmodified, which is precisely what R4 #1 showed the journal carry
record broke.

Because we are minting v2's DDL in this design anyway (§11), the column costs
nothing beyond a line of schema.

**It is never cleared** (§3.5, per R7 #1). It is durable for the life of the
lineage, and the explicit command grants a preview-bound, operation-scoped
bypass rather than clearing anything. This removes the clearing predicate
entirely — which is the right outcome, because R5 #2 showed no such predicate is
sound: pull can complete with per-repo conflicts or deferrals and returns only
file actions and sequence metadata (`sync/pull.ts:83`), so "no exception thrown"
would release too early while "zero suppressed repositories" would wedge.

A crash at any point leaves the flag set, which is the safe direction and
idempotent by construction. There is no window in which the flag is
half-applied, and no window in which a bypass outlives the operation that
granted it.

**Interaction with a rebind (R6 #3).** A consented rebind mints a new lineage
against a different stream, so the old lineage's quiesce is meaningless under it
and the flag is not carried: the rebind's own baseline discard governs, exactly
as today. A rebind is a deliberate, consented act with its own semantics, and
this design does not modify them.

§9(4)'s crash matrix therefore asserts the flag's presence at every boundary,
which is a single bit rather than an unbounded row set.

### 6.5 Terminal Q — R1 #5 / R2 #2

`scanBaseArtifacts` enumerates only A/P/K (`base-artifact-scan.ts:68-71`), and
reset consults an accepted repair receipt only while a valid P still exists
(`reset-state.ts:163-208`). Once P is gone and Q remains, nothing runs — so a
p-repair episode can be retired mid-window.

The retirement preflight must therefore enumerate the Q recovery namespace
explicitly and settle terminal-Q episodes, using `partial.pRepaired` from the
port as the discriminator. This is a required implementation component with a
named owner, not, as the previous draft left it, only an acceptance test.

`parsePRepairQ` must stay identity-preserving throughout: normalizing a legacy
value on read changes the Q blob OID and wedges `resumeAcceptedPRepair`.

### 6.6 Darwin — R1 #10

`openStateStore` invokes `validateOpen` **before** either configuration path
clears `SQLITE_FCNTL_PERSIST_WAL` (`store/open.ts:108,364`), so a schema
mismatch throws after the first SQLite read has already created `-wal`/`-shm` —
and reset's classifier treats stranded sidecars as W1
(`reset/classifier.ts:81`).

Required: the classification path must not strand sidecars, and §6.2's
single-opener rule plus the fenced open → checkpoint → close under the state
lock is what guarantees it, matching the seal `genesis.ts:250` already performs.

Bound by the two standing darwin rules established by probe: persist-WAL is on
under darwin's system SQLite, and there are no read-only WAL opens and no reads
of an unlinked file.

### 6.7 Concurrency — R1 #4

The first draft's `liveStores`-empty assertion was a TOCTOU hole: `loadRawState`
takes neither the mutex nor the state lock, `openStateStore` validates before
registering its handle (`store/open.ts:128,160`), and the registry is
process-local.

The reframe removes the need for it. Concurrency is the workspace sync mutex
plus the state lock held across the transition — `resetSyncState`'s existing
guarantee, the same one that makes an ordinary rebind reset safe against a
running daemon. The daemon acquires the same mutex; cross-process safety comes
from the file lock, not an in-process registry.

Residual, to be tested rather than argued: a reader that opened the store
*before* the mutex was taken still holds a descriptor. Reset faces this
identically today, which is why the cutover is journal-backed and
crash-resumable rather than a bare rename. §9(4) tests it.

### 6.8 Authorization and the same-stream invariant — R2 #5

Consent is removed for this trigger: schema supersession is not a user decision,
there is no alternative to offer, refusing is the status quo that bricks the
device, and the stream does not change. The authorization becomes the
machine-checkable schema tuple in §6.1(8), recorded durably in the journal.

R2 #5 is right that this is dangerous as stated. Current authorization binds
only the requested destination (`reset/recovery.ts:379-385`,
`reset-journal-schema.ts:150-161,303-318`), so a consentless
`schema-superseded` authorization that did not *prove* stream equality would be
a **consentless rebind capability** — the ability to silently repoint a device
at another workspace.

Required: **the deep reset owner and the journal decoder must both assert
`next.stream === old.stream` whenever `authorization.kind ===
"schema-superseded"`**, and reject otherwise. Negative tests must prove a
schema authorization cannot change streams. This is a security-shaped invariant,
not a nicety.

Weakening 265's "consent precedes every reset mutation" is nonetheless a real
change to a deliberately strict gate, and is founder question 1 in §13.

### 6.9 Sidecar cleanup — R2 #10

`resetSyncState` unconditionally removes `encrypt-cache.json`,
`git-republish.json`, the activity record, and the design-46 shell sidecars
(`reset-state.ts:470-485`). This falsifies §7's earlier claim that the
encryption cache survives, and it would additionally discard pending republish
intent.

Cleanup must become **authorization-aware**, but selectively — R3 #4 is right
that the previous draft's blanket "the stream is unchanged, so preserve
everything" was too broad. Split by what each sidecar is bound to:

**Preserved under `schema-superseded`:**

- `git-republish.json` — explicitly stream-bound
  (`republish-requests.ts:9-35,123-140`); the stream is unchanged, so pending
  republish intent stays valid.
- `encrypt-cache.json` — bound to account/workspace/epoch, none of which
  change. This is what keeps the re-baseline cheap (§7).

**Still cleared under `schema-superseded`:**

- `activity.json`, `shell.line`, `shell.deferrals`, `path-warnings.json` —
  these project the **retired BASE** and its discarded deferrals. Worse than
  stale: the daemon reloads persisted halts and schedules recovery from them
  (`daemon.ts:887`), so preserving them would drive recovery against a lineage
  that no longer exists.

Under a rebind, everything is still removed exactly as today.

### 6.10 Retention — R2 #11

The superseded store is **retained indefinitely** in its archive. The previous
draft's "pruned after one clean sync" invented a lifecycle with no owner, no
durable trigger, and no crash/idempotence semantics; SQLite recovery already
retains the canonical lineage archive while unlinking only journal and candidate
(`reset/recovery.ts:328-334`), and quarantine manifests require archive cleanup
to be `preserve` (`reset-quarantine.ts:181-190`).

Retaining indefinitely costs one workspace-sized archive per schema generation
and adds no owner. `restoreResetQuarantineUnderFence` refuses to restore over an
active DB whose hash advanced (`reset-quarantine.ts:418,437`), so the archive is
**forensic evidence, not a rollback**; the earlier draft called it a rollback and
that is withdrawn.

---

## 7. What the first sync costs

- **Pull, files.** `reconcile()` short-circuits on `sameContent(local, remote)`
  **before** consulting BASE (`reconcile.ts:59`). Paths whose bytes already
  match emit no action regardless of the empty BASE. This is what keeps
  re-baseline cheap and it holds.
- **Push, files.** Every file needs an encryption descriptor. §6.9 preserves
  `encrypt-cache.json` under `schema-superseded`, so the cost is small; if that
  preservation proves infeasible, the device re-encrypts its whole workspace
  once. Even with the cache present, a corrupt or mismatched cache silently
  degrades to empty (`encrypt-address-cache.ts:208`) and a compression-policy
  change alters the payload hash and ciphertext address.
- **Wire.** Where the cache holds and policy is unchanged, convergent encryption
  reproduces the same `encSha`, the missing-blobs probe reports present, and no
  file bytes upload.
- **Manifest.** *If* a commit occurs, its manifest bytes necessarily change —
  each commit encrypts with a fresh random nonce (`e2ee/manifest-crypto.ts`), so
  a manifest blob is never deduped. Whether a commit occurs at all is contingent;
  see the server-side effects below (R5 #3).
- **Direct push without pull.** `push()` performs planning, encryption, and
  missing-checks *before* the commit conflict triggers pull-first recovery
  (`push.ts:637,895`). `sync()` pulls first, so this is not the normal path, but
  it is not free when it happens.
- **Git bundles.** Whether an unchanged repo's re-captured bundle reproduces the
  same `bundleEncSha` — and therefore dedupes — is **unverified**; git packing
  is not guaranteed byte-identical across invocations. §9(1) measures it. If it
  re-uploads, that is a bounded one-time per-device cost, not a correctness
  problem.
- **Config lane.** One redundant publish and one redundant apply per repo, per
  §3.6 — contingent, like every other publication below.

**Server-side effects, corrected per R3 #5 and R4 #4.** Two earlier drafts got
this wrong in opposite directions — first claiming no sequence effect at all,
then claiming a manifest upload was unavoidable. Both are wrong; the effects are
**contingent**:

- **No device-identity effect, unconditionally.** Config, credentials,
  `deviceId`, and the remote workspace binding are untouched, so the server does
  not see a new device and no registration or grant event occurs.
- **Publication is contingent, not guaranteed.** `sync()` pulls first, and that
  pull can adopt the remote BASE, after which the push is a zero-commit no-op —
  behavior explicitly protected by the echo-storm no-op test
  (`sync/sync.test.ts:369`). Where the device's tree already matches the server,
  re-genesis can complete with **no** commit at all.
- **Where a publication does occur**, it advances the server sequence and stores
  one freshly-nonced manifest blob (a new address; unchanged file blobs dedupe).
  The redundant config publications from §3.4 are contingent in the same way,
  and `regenesis_pending` (§3.5) continues to enforce both quiesce clauses on
  this and every later publication for the life of the lineage.

In all cases the effect is a small, bounded number of commits, never
proportional to workspace size.

A fresh store starts at `last_synced_sequence = 0` and `sync()` re-establishes
it by pulling first.

---

## 8. Pull-only mode — R1 #15

With BASE empty, a local file that has diverged from the server is planned as a
`conflict` action, whose `keepLocalAs` path moves local content aside
**unconditionally** (`apply.ts:211,328`). The first draft credited
`expectedLocal` for this; wrong — `expectedLocal` (`apply.ts:292`) protects only
scan-to-apply races on ordinary writes. Directory/file type flips may route the
local directory to **trash** rather than a visible `.conflict.*` sibling.

A pull-only device can therefore produce a burst of conflict copies (and
possibly trashed directories) at its first post-re-genesis pull, proportional to
the divergence it was silently carrying. Bytes are preserved on both paths, but
acceptance must assert **byte preservation across both the conflict-copy and the
trash path**, not merely count `.conflict.*` files.

Considered and rejected: blocking re-genesis in pull-only mode — it strands the
pull-only host on schema v1 permanently. Accepted: it proceeds, and because the
founder's pull-only host is a known named machine, its re-genesis is done
attended.

---

## 9. Acceptance evidence

Design-only PR; this is the contract the implementation PR must satisfy. Per
R2's closing note, **v1 schema metadata and codec deletion must not be approved
until exact-v1 admission, nonce-less genesis, P/Q retirement, standing-journal
compatibility, and quiesce-flag crash tests all pass.**

**Rig (`scripts/rig/scenarios/`):**

1. New `state-regenesis.ts`: two converged devices; B's store replaced with a
   v1-schema store; B restarts and must (a) retire and rebuild, (b) converge to
   identical tree fingerprints with A, (c) produce zero conflict copies for
   unchanged content, (d) upload zero *file* blob bytes for unchanged files.
   Record the git-bundle re-upload measurement from §7.
2. **Quiesce controls (R1 #1, R5 #1, R6 #1), each red first:**
   - delete a repo remotely, re-genesis, sync repeatedly — it must **not**
     resurrect, and must still not resurrect after arbitrarily many sync cycles.
     This is the case R5 #1 showed a timed quiesce misses.
   - **the ignored-leftover case (R6 #1):** the same, with the leftover inside an
     ignored subtree that is un-ignored *after* re-genesis. It must still not
     resurrect. Repeat for an unreadable subtree, an out-of-scope repository, and
     a `syncGit:false` device that later enables git.
   - **the decisive ordering (R7 #1):** run the publish command and confirm some
     *other*, visible repository **first**, and only *then* unignore / restore
     readability / restore scope / enable git for the hidden leftover. It must
     still not resurrect — the grant covers only what the preview showed.
   - a repo created locally and never published must publish once the user runs
     the explicit command, and must be **listed before** it is published; a repo
     absent from that preview must remain blocked afterwards.
   - a device that never runs the command must keep syncing files and following
     existing repositories indefinitely — no wedge, no halt, no growing backlog.
   - conflicted refs must not publish — and `resolution_key` must be shown to
     *re-derive* on a git-capable, in-scope pull (R5 #1).
   - **the limited-pull variants (R9 #1), both red first:** re-genesis with a
     live conflict guard, then a `syncGit:false` pull that advances to the
     current server sequence, then enable git, then a **direct push** — the
     divergent repository must not publish. Repeat with a scope-excluded
     repository that is later brought into scope.
   - a crash before the command runs must leave the flag set.
   `telemetryBindingId` still crosses, via reset's existing behavior.
3. **Retirement control (the design-killer):** crash a push mid-capture in both
   the pre-Q **and terminal-Q** windows, then re-genesis. Artifacts must settle
   under the **old** lineage hash, local commits intact, nothing left foreign.
4. **Crash matrix:** kill at each boundary of §6.1 — including a reader holding
   a descriptor across the cutover (§6.7) — asserting the store is serviceable
   **and** `regenesis_pending` is set at every boundary after installation
   (§6.4). A crash must never yield an installed v2 store with the flag clear.
5. **Nonce-less store (R2 #3):** a v1 store that never completed a first sync
   must retire and rebuild, not refuse.
6. **Negative controls, each must still refuse and must not rebuild:** truncated
   file, `SQLITE_CORRUPT`, foreign application id, missing `store_meta`,
   violated singleton/head invariant, a *newer* `schema_version`, an unknown
   older version with no port, **a store claiming `schema_version = 1` with a
   non-released fingerprint** (R2 #9), and **a mixed store with
   `PRAGMA user_version = 2` but v1 metadata** (R3 #3).
7. **Same-stream invariant (R2 #5):** negative tests proving a
   `schema-superseded` authorization cannot change streams, at both the deep
   reset owner and the journal decoder.
8. **Standing v1 reset journal (R1 #6):** begin a reset on v1, upgrade to v2
   mid-flight, settle — must not J0-halt.
9. **Sidecar split (R2 #10 / R3 #4):** `encrypt-cache.json` and
   `git-republish.json` survive a `schema-superseded` reset and are still
   removed by a rebind reset; `activity.json`, `shell.line`,
   `shell.deferrals`, and `path-warnings.json` are cleared by **both**, and the
   daemon does not schedule recovery from a retired halt afterwards.
10. **Seed size (R3 #2 / R4 #2):** the v2 candidate seed with
    `regenesis_pending` set stays within `MAX_DB_BYTES = 262_144` for every
    supported workspace — the bound that defeated all three carry proposals must
    be shown to be a non-issue for the mechanism that replaced them.
11. **Fence revalidation (R3 #1):** a repository identity that changes between
    the discovery projection and the fenced projection must refuse, not proceed.
12. Extend `pull-only-conflict-copies.ts` with a post-re-genesis pull, asserting
    byte preservation across conflict-copy **and** trash paths (§8).
13. Extend `dual-binary-state.ts`: an older binary meeting a v2 store refuses and
    does not rebuild downward.

**Fleet:** dev build on all three hosts, attended, archive retained; first-sync
wall time and bytes uploaded measured against the steady-state baseline in
`docs/design/data/`.

**Darwin:** §6.6's open → checkpoint → close → archive lifecycle probed on the
MacBook before the tag. There is no darwin CI lane; a green Linux suite is not
evidence for this mechanism.

---

## 10. Kill switch

Ships **ON**, per the founder default-on rule. `RBOX_STATE_REGENESIS=0` restores
today's hard refusal exactly. **Deletion condition:** remove 30 days after the
first 2.0 release shows zero pre-v2 stores in rbox-admin version telemetry.

Challenged: design 266 ruled "no kill switch — a flag would create two
fresh-state defaults." That ruling governs how *absent* state is born, and this
switch does not touch it: both positions leave one birth protocol and one
fresh-state default. What the switch selects is whether a superseded lineage is
retired or refused. If the founder reads 266 as governing this too, drop the
switch; the design is otherwise unchanged.

---

## 11. Schema v2 definition

- `SCHEMA_V2_DDL` is the only DDL the binary creates (`schema/v1.ts` →
  `schema/v2.ts`). v1's DDL text and codec are **retained as the retirement
  port** (§3.1), not deleted, and their deletion condition is §9's gate.
- Column order is preserved except for the renames; the schema-rebase test
  treats the `RepoRecord` column list as a contract.
- `STATE_STORE_SCHEMA_VERSION = 2`, `STATE_STORE_SQLITE_USER_VERSION = 2`.
  `STATE_STORE_APPLICATION_ID` and `STATE_STORE_SQLITE_APPLICATION_ID` are
  **unchanged** — §4's boundary depends on the store still identifying as rbox.
- `STATE_STORE_DDL_FINGERPRINT` stays **hardcoded**, with a test asserting it
  equals `sha256(SCHEMA_V2_DDL)`. Deriving it at module load would delete the
  tripwire that makes an accidental DDL edit fail loudly. The exact released v1
  fingerprint is retained as a named constant for §4's equality check.
- `state_lineage` gains `regenesis_pending` (§3.5, §6.4), nullable, set by
  re-genesis and **never cleared** — the explicit command grants a
  preview-bound, operation-scoped bypass instead. It is part of v2's DDL from
  the start, so it costs no additional fingerprint change. There is **no**
  per-repository blocking record: R6 #4 correctly objected to an earlier draft
  that added one while claiming it had not, and the mechanism no longer has one.
- The frozen header (§3.1 rule 4) is asserted structurally, and
  `regenesis_pending` is **not** in it: a future schema may rename or drop it.
- The four renames land in the DDL, `RepoRecordInput`, `ConfigStoreIdentity`, and
  the digest token; `docs/wire-rename-candidates.md`'s deferred cluster closes.
- `REQUIRED_SCHEMA_OBJECTS` is unchanged: no table added or removed.

---

## 12. Concept ledger

**Added:** one observation variant (`schema-superseded`); one
`ResetJournalAuthorization` variant with an owner-enforced same-stream
invariant; one retained v1 retirement port (read path + narrow protocol-write
path + v1 canonical encoding), opened twice per transition — discovery and
fenced; one sealed-witness parameter on reset quiescence; one frozen-header
invariant; one `regenesis_pending` column, the two-clause sticky quiesce it
gates (no BASE-absent additions; no publication change to a BASE-known
repository without re-derived evidence), and one command granting preview-bound
operation-scoped bypasses;
one terminal-Q settlement owner; selectively authorization-aware sidecar
cleanup; one env switch with a deletion condition; one release-time version
check; one runtime rate guard.

The largest single line item is the retained v1 access port: the reset
preflight's write behavior and field breadth (R2 #2) turned what round 2 called
"one small read-only projection" into a real retained port, and §3.2 prices
that honestly.

**Removed during review, and worth recording:** the per-repo data carry, in all
three homes it was proposed (candidate DB after genesis, candidate DB before
hashing, bounded journal record). §3.5 explains the step-out. Its replacement is
one boolean, so the design ends this review round with *fewer* concepts than it
had at round 2 despite absorbing four rounds of findings.

**Removed:** v1 as a *creatable* schema; the four deferred rename blockers; and
the standing product hazard that any `state.db` schema change is fleet-bricking.
After this, schema evolution costs a version bump plus one retained port.

**Not added:** no migration engine, no `ALTER TABLE`, no v1→v2 row conversion,
no second birth protocol, no second store-mutation owner, no new lock, no new
lock ordering, no new physical-mutation primitive, no new durable "blocked"
record.

---

## 13. Open questions for the founder

1. **Consent (§6.8).** Re-genesis removes the reset consent witness for this
   trigger, which design 265 requires before every reset mutation. Confirm that
   schema supersession — no alternative to offer, stream unchanged, and an
   owner-enforced same-stream invariant in its place — is exempt.
2. **Kill switch vs. design 266 (§10).** Ship the switch, or ship
   unconditionally per 266's "no flag" ruling?
3. **The recurring port tax (§3.2).** Every schema generation must retain its
   predecessor's access port past that predecessor's deletion. Accept as
   standing policy for schema evolution, or revisit at v3 with a different
   strategy (e.g. freezing far more of the schema so the port shrinks toward the
   header alone)?
4. **The sticky quiesce (§3.5).** Seven review rounds established that no
   automatic release is safe, because the device cannot enumerate what it would
   be releasing. The consequence is that `regenesis_pending` **never clears**: a
   re-genesised device asks before introducing any repository, permanently,
   including repositories created long after the rebuild. Two decisions:
   - Accept that permanent posture, or define a convergence back to the default
     (for example, releasing once the server can attest no deletions predate the
     rebuild — which would need a wire change this design otherwise avoids)?
   - Confirm the surface: a flag on an existing command versus a new one, and
     its `rbox status` copy. This is the only user-visible artifact of the whole
     design, and it lands on a non-developer copy bar.
