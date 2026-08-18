SP-4 executed 2026-08-18: the completed JSON→SQLite migration tree and operator surfaces were retired after founder support-window sign-off.

# 262 — Retire the JSON→SQLite migration tree; SQLite becomes the only state plane

Status: RESCOPED v2 — parent plan for the "finish the state plane" loop
(founder decision 2026-08-15: FINISH SQLITE, then delete). Round-1 reviews
(CODEX-262-A/B, both CHANGES-REQUIRED, 4 blockers) established the deeper
fact: the SQLite plane is UNFINISHED — JSON still owns live behaviors and
genesis has no viable entry from the normal selector. Deletion is therefore
the FINALE of this loop, not a standalone PR. Slices, in order:

- **SP-1 Genesis admission** (fixes A#1, A#2): one explicit genesis-admission
  operation callable from the selector seam — reuses an already-held
  workspace mutex, acquires remaining fences without selector recursion
  (locks.ts:169 loadRawState loop), runs whenever a genesis intent exists
  (absent OR marker+intent, so post-Q crashes recover), re-selects authority
  after. Crash gate exercises the REAL foreground + daemon entries.
- **SP-2 Port the JSON-owned live behaviors** (fixes A#3): telemetry binding
  → the existing SQLite impl (store/write-packet.ts:302); the degraded-mutex
  forceLegacy writes (pull.ts:477, push.ts:566) get a SQLite-side owner;
  reset/rebind (reset-state.ts:288) reads through the store, not raw JSON.
- **SP-2.5 Rig + e2e SQLite dimension** (founder-ordered 2026-08-15,
  prerequisite for SP-3): the docker rig and e2e suites gain a
  SQLite-authority dimension — every FAST scenario runs against a
  genesis-created workspace, plus a fresh-install e2e (track → genesis →
  first sync → pair a second device → converge) and an upgrade-path e2e
  (existing JSON workspace keeps working on the same build). The default
  flip does NOT ship until this dimension is green; SP-1's fixtures
  (state-view across both authorities) are the substrate.
- **SP-3 Default flip + fleet cutover** (fixes A#4): genesis becomes the
  default for absent state; the automatic upgrade-window migration is
  removed in the same PR; 1.x/candidate co-use prohibition stated; founder
  fleet cuts over (desktop/Mac re-genesis or migrate; FM rejoins here).
- **SP-4 Deletion + refusal** (the original PR-B, fixes A#5/A#6 + all of B):
  one low-level legacy refusal shared by every remaining accessor (not just
  whole-state-compat — reset-journal-doctor, sync-state-store exports,
  saveStateSource legacy arms), closure-complete delete/prune/rehome ledger
  (22 import declarations / 11 files + errors.ts:2 + package.json bench
  entry + help-registry + genesis.ts:88 control dependency + 7 mutation-gate
  guards), dispositions for the 12 external migration-importing tests,
  executable retirement gate, user-visible ledger incl. doctor flags.

**Standing mandate (founder, 2026-08-15): every slice applies
`simplify-codebase-primitives` to the SQLite modules it touches** — the v1
SQLite plane (U1-U3) predates this session's type doctrine and the
simplification bar. Concretely, per slice: (a) reduce concepts, not files —
collapse ports/plans/receipts that merely relay one in-process call (skill
rule 4); (b) true types throughout — the four anti-slop type rules land at
ZERO in every touched store/codec module, JSON boundaries flow JsonValue,
durable records are JSON-comparable aliases (the merged #711-#732 doctrine);
(c) each slice's review verifies a concept-count delta, not just
correctness — a slice that only relocates complexity is rejected per skill
rule 5. The state plane should come out of this loop SMALLER and better
typed than v1, not just reachable.

Each slice is its own dev-cycle with its own review round. Original v1
text below retained as the SP-4 specification baseline.
Depends on: 163 (state-plane SQLite law), 222 (U3 implementation), 215/216/
221/223 (store slices).

## Field evidence (2026-08-15, all verified live)

1. **The migration was never executed in the field.** All three founder
   hosts carried plain JSON at `.rbox/state.json` (no 58-byte
   `RBOX-SQLITE-AUTHORITY-v1` marker) despite running 2.0-dev builds.
   Nothing on the sync path triggers migration: the only entries are
   `rbox migrate` (state-plane-cmd.ts:96) and the `rbox upgrade` stop
   window (upgrade-state-window.ts:82) — neither ever ran.
2. **Fresh joins still create JSON.** The desktop start-fresh op
   (2026-08-15: `.rbox` moved aside → `rbox track --workspace` → first
   sync) produced a NEW legacy-JSON `state.json`. The SQLite genesis
   exists (authority-bootstrap.ts:98-114) but is reachable only through
   the same two explicit entries. The SQLite plane is fully dormant.
3. **Prod telemetry** (D1 `devices`, 14-day window): 8 active devices — 3
   founder (2.0-dev), 4 hosts on 1.11.4 (two accounts), 1 on 1.6.6. No
   external 2.0 client exists; external users start fresh on 2.0 by
   founder decision.
4. **Start-fresh cost observed:** rebuilding desktop state from scratch
   triggered ~103 per-repo git deferrals ("checkout unavailable" class)
   requiring `rbox git resolve keep-mine` each, plus one transient "P
   settlement BASE disappeared" and one conflict-surrender race against
   the two live publishers. The workspace files were never at risk; the
   cost is bookkeeping churn. This cost shapes the refusal copy and the
   fleet-cutover recipe below.

## Problem

29 modules / 6,056 nonblank lines (plus 15 tests / 7,640 lines) implement
a one-way state conversion that has never run in production, will never
run for external users (they start fresh), and — because fresh joins also
bypass it — cannot even be reached by accident. It costs 29 CODEMAP
entries, 151 anti-slop warnings, a duplicate-declaration allowlist entry,
6 mutation-gate mutants, and permanent audit surface. Meanwhile the thing
design 163 actually wanted — SQLite as THE state plane — is stalled
behind this bridge nobody crosses.

## Decision (founder, pinned)

- (2026-08-15, SP-2 scope) "All legacy stuff can be removed with a healthy
  v2/SQLite setup" — standing approval that legacy-only MODES and fallbacks
  (forceLegacy degraded writes, legacy-only sidecars/branches) are
  ELIMINATED once the SQLite equivalent is proven healthy, not ported
  one-for-one. Each slice still proves parity before its removal ships;
  the approval removes the preserve-behind-an-interface obligation for
  legacy-only mechanisms whose SQLite replacement passes the slice's
  differential matrix.

- No in-place 1.x→2.0 state upgrade is supported. A 2.0 client finding
  legacy JSON state refuses with start-fresh instructions ("removing and
  starting fresh seems cleaner" — 2026-08-15). No rename-aside
  automation, no flags: one detection + one message.
- Wire/API: no change (verified: nothing in apps/ touches the state
  plane).

## Design

### 1. SQLite genesis becomes the default (the flip 163 was waiting for)

`whole-state-compat.ts:58-66` (`selectSqliteAuthority`) currently sends
`absent` → JSON store. It becomes: `absent` → SQLite genesis via
`establishStateAuthority`'s genesis leg (the migration leg is deleted, so
the bootstrap collapses to genesis-only and loses its fork —
authority-bootstrap.ts:98-114 simplifies to one path). Every fresh
`rbox track`/`init` workspace gets the authority marker + SQLite store
from day one.

### 2. Legacy JSON state → refusal (the gate)

`classifyStateFormat` (authority-marker.ts:68-104) already returns
`"json"`. That verdict changes from "select legacy-json-store" to
throwing the existing-taxonomy refusal, modeled on
`STATE_UNREADABLE`/`AUTHORITY_CORRUPT` copy (state-plane-copy.ts:300-350)
and its doctor twin (doctor-triage.ts:233-254):

- machine id `state-format/legacy-json`, severity `blocked`.
- Copy (non-developer bar; follows the pinned copy rules — spell out the
  remedy, never "re-adopt", and per the rule at state-plane-copy.ts:300
  the message must be explicit that FILES ARE SAFE): problem "this
  folder's sync bookkeeping is from an older rbox", safety "your files
  are untouched and stay on this computer; synced copies remain on the
  server", command "rbox stop, move this workspace's `.rbox` folder
  aside, then run `rbox track --workspace <id>` here to re-attach" +
  a sentence that git repos will each ask for one
  `rbox git resolve <repo> keep-mine` afterward (observed cost, honest
  copy).
- Doctor gets the matching `state-format-legacy-json` triage row.

### 3. Deletions

- `src/cli/state-plane/migration/` — all 44 files (13,696 nonblank).
- Entry points: `rbox migrate`/`retry`/`abort` (state-plane-cmd.ts:96-130
  — command retirement, CHANGELOG breaking note),
  `upgrade-state-window.ts` + its call in upgrade-cmd.ts:188 (+ test).
- `legacy-json-store.ts` (442) + its allowlist/ratchet/structure-gate
  rows — deletable ONLY once the fleet carries markers (§5 order).
- `legacy-json-publication.ts` adapter, `digest/legacy-state-plan.ts`
  (migration-only per recon; keep the type-only `state-semantic-v1.ts`
  use by inlining the type), migration rows in inventory.test/
  duplicate-declarations/base-composer-structure, the 6 mutation-gate
  mutants, `scripts/bench/migration-baseline.ts`,
  `scripts/probe/u3-5c-trace.ts`, snapshot-replay's migration imports.
- Type/utility survivors get REHOMED, not deleted (they serve live
  behavior): `last-writer-witness`, `reserve` (re-exported via
  state-plane/index.ts:4-5 and used by live publication),
  `base-proof.ts`'s `adoptLegacyManifestRepoBase` (sync-state-model.ts:21)
  — each moves to its real consumer's plane with move-fidelity audit.
  Anything whose only consumer was migration dies with it.
- CODEMAP: the 29 migration entries deleted; rehomed modules re-owned.
- CONTEXT.md + design 163/222 get a completion/retirement note.

### 4. What is NOT deleted

- `authority-marker.ts` (detection primitive — now load-bearing for the
  gate), the SQLite store itself, genesis, doctor state-plane checks,
  `compat-matrix.test.ts` (rewritten: `json` now expects the refusal),
  `StateFormatTooNewError` (forward direction unchanged).

## Fleet cutover (§5, ORDER MATTERS — before the legacy-store deletion merges)

Per host: settle sync → `rbox stop` → move `.rbox` aside (kept as
backup) → `rbox track --workspace <id>` → first sync (expect one
conflict-surrender race if other publishers are live; the daemon's
long-horizon retry converges it — start the daemon rather than looping
one-shot syncs) → bulk `rbox git resolve <repo> keep-mine` over the
deferral list → verify marker… **except the fresh join writes JSON until
§1 merges.** So the real order is:

1. PR-A: genesis default flip (§1) + refusal gate (§2) + migration-tree
   deletion (§3 minus legacy-json-store). Fleet still on JSON keeps
   working? NO — the gate refuses JSON. Therefore PR-A ships gate OFF
   for the founder fleet? Rejected: no flags (founder rule). Instead:
2. Actual order: PR-A ships §1 (genesis default) ONLY, small. Fleet
   does the start-fresh cutover on that build (fresh joins now genesis
   into SQLite; desktop redoes its join or runs `rbox migrate` while it
   still exists). Verify markers on all three hosts + a rig FAST pass.
3. PR-B (after fleet verified on SQLite): §2 refusal + §3 full deletion
   incl. legacy-json-store. The refusal can never hit a founder host.

## Validation

- Full state-plane + sync-git + daemon suites; compat-matrix rewritten;
  file-size/duplicate-declaration/inventory gates updated in the same PR
  as their rows change.
- Rig FAST suite after PR-A (fleet on SQLite state) and after PR-B.
- Differential: fresh `rbox track` on a scratch dir → marker present,
  sync round-trips; legacy JSON fixture → exact refusal copy.
- Crash: genesis interrupted mid-install leaves a resumable/refusable
  state (whatever design 222's genesis already guarantees — no new
  crash surface may be added by the flip).

## Ceremony killed

29 CODEMAP entries; 151 anti-slop warnings; the migration
duplicate-declaration allowlist row; 6 mutation-gate mutants; two CLI
commands (`rbox migrate` retry/abort family) that never ran in prod;
the upgrade stop-window machinery; ~14,000 lines.

## Non-goals

- No wire/API change; no D1 change; no 1.x client behavior change.
- No automated legacy import of any kind post-PR-B.
- rbox-admin unaffected.
