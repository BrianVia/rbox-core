# 267 — Delta-scoped state save (design 235 Phase B)

Status: DRAFT r4. Parent: design 235 (Phase A ratified + shipped #643/#644).
Evidence: GH #748 (P1). Review ledger: r1 codex + opus (both
CHANGES-REQUIRED, folded); r2 codex (3 residuals: snapshot binding, hash
operand, provenance — folded); r3 codex (core predicate CONFIRMED sound,
telemetry-mint interaction cleared; 3 wiring residuals: rejection mapping,
backend parity, absent-identity semantics — folded here). r1's M3 (third-hash removal)
is WITHDRAWN — both reviewers proved the deletion-path hash is the only
content binding on a destructive operation (`stage-artifacts.ts:286-302`:
the inode compare is self-referential against the just-created pin; the
sha256 at :291 is what binds the bytes to `ref.physicalSha256`). The #747
identity contract stands untouched.

Founder yardstick: ≤10s end-to-end; save cost scales with the delta, never
the workspace.

## 1. Problem — the measured bucket

Desktop (120,481 files, 263 MB `state.db`, build da28ddc, 2026-08-16):
zero-change pull 11.5s wall, **state-save 8.4s**, state-load 2.0s; repeated
every ~50s by the daemon. FM: 12.3s save on first pull, with a 50s
mutex-acquire stall inside it (#749). Per 232 §7 the top measured bucket —
and only that bucket — earns a mechanism.

## 2. Cost anatomy of one save (recon 2026-08-16, post-SP-3 anchors)

`pull.ts:447` → `saveStateSource` (`sync-state.ts:364`) →
`composeStateSavePacket` (`:293`) → `applyStateSavePacket`
(`whole-state-compat.ts:233`) → `saveThroughStore` (`:249`) →
`applySavePacketToStore` (`sqlite-state-save.ts:81`) → `applyCasPacket`
(`write-packet.ts:108`).

| Step | Anchor | Cost |
|---|---|---|
| Packet composition carries whole manifest | `sync-state.ts:293-311` | O(N) JS |
| Stage build: batched INSERTs, fresh private DB | `generations.ts:97-138` | O(N) rows |
| Insert-time semantic digest (#644) | `generations.ts:140-148` | O(N) hash |
| Seal: checkpoint, DELETE-mode, fsync, sha256 #1 | `stage-artifacts.ts:138-182` | O(bytes) |
| CAS consume: copy-while-hash (sha256 #2) + TEMP copy | `write-packet.ts:212-227`, `generations.ts:288-330` | O(bytes)+O(N) |
| Intern + promote (dirty-only — already differential) | `generations.ts:334-355` | O(N) scan |
| COMMIT `synchronous=FULL` | `write-packet.ts:265` | fsync |
| Delete stage: sha256 #3 (identity proof — protected) | `stage-artifacts.ts:281-311` | O(bytes) |
| Full whole-state read-back after accept | `whole-state-compat.ts:398-411` → `read-only.ts:79` | O(N) |

Near-miss: `sync-state.ts:306-308` already omits `packet.global` on strict
`sourceGlobalSeq < lastSyncedSequence`; equality (the zero-change case)
builds the full stage.

Stale-anchor note (opus m-3): 235 §2's daemon anchors moved — `daemon.ts`
is a re-export barrel; live sites are `daemon/daemon.ts:2100` (standalone
doPull adoption) and `:1859` (push-recovery adoption). Re-verified before
dispatch per the verify-anchors rule.

## 3. Mechanism M1 — minimal-packet no-op save

**One sentence:** when a pull can PROVE a section would not change durable
state, `composeStateSavePacket` omits that section; the save call itself
always still runs, and the proof is re-validated under the state lock via a
CAS revision predicate (§3.2b).

### 3.0 The elision receipt (r2-MAJ provenance; one new concept, one owner)

Elision inputs travel as an explicit, optional, pull-owned value —
`ElisionReceipt` — constructed ONLY by the standalone `doPull` path and
passed into `saveStateSource`. It carries:

- the UNFILTERED action list emptiness (`all`),
- scoped-base identity (`storedBaseIsRemote` + the incoming `manifestMeta`),
- the snapshot binding: the loaded state's `nonce` and `stateRevision`
  (from the load-time token).

Identity precondition (r3-MAJ): a receipt is constructed ONLY from a
post-`ensureCapableStateLineage` snapshot with a minted (non-legacy) nonce
and a defined `stateRevision`. Absent either — first save, legacy
nonce-less JSON state (`whole-state-compat.ts:165`) — no receipt, full
save. No normalized-sentinel comparison semantics are introduced.

No receipt → full packet, unconditionally. Degraded pulls, push-conflict
recovery, chain repair, resolution settlement, and every direct packet caller
never construct one, so their ineligibility is structural — not a negative
control we hope holds. r1-IMPL correction: "recovery" is NOT only the daemon's
adoption path. Push's 409/pull-first and `pullAndLoadAccepted` arms
(`sync/push.ts`) call the ordinary `pull()`, which would otherwise inherit the
standalone lane's eligibility. The lane is therefore an explicit argument —
`PullProvenance` = `standalone` | `recovery`, defaulting to `standalone` at the
public entry and to `recovery` wherever `applyPulledManifest` is reached
directly — so a new nested-pull caller is receipt-less until someone names it. The
receipt is the 235 §5.2 first-class evidence interface: `StateSource` gains
one optional field; no other signature changes.

### 3.1 Placement and what is never skipped (codex MAJ-2, opus C1/M-2)

The decision lives in `saveStateSource`/`composeStateSavePacket`
(`sync-state.ts`), carrying pull provenance — never inferred from packet
shape. `applyStateSavePacket`'s existing contracts are untouched and get
pinning tests:

- an all-empty packet still initializes capable lineage
  (`whole-state-compat.ts:180-186`, nonce mint via COALESCE at
  `write-packet.ts:261`) and still serves reset migration
  (`reset-state.ts:434-445`);
- **the save is never skipped entirely.** A fully-elided pull still sends
  its (minimal) packet through `saveThroughStore`: state lock, ownership
  validation, write fence, authority reselection, CAS predicates, final
  ownership recheck (SP-2 / design 264 §fail-closed) all execute exactly as
  today; every accepted CAS still bumps `stateRevision`
  (`write-packet.ts:257`) — the invariant `write-differential.test.ts:239`
  pins survives; the legacy-JSON arm still performs its packet-independent
  housekeeping (incarnation-marker retirement `legacy-json-store.ts:196-201`,
  P/BASE sanitation `:161-174`, first-save nonce `:177`).

Honest #749 claim: the state lock is still ACQUIRED per cycle; M1 shrinks
the hold time from seconds to milliseconds. It does not remove acquisition.

### 3.2 Global-section elision predicate (codex CRIT, opus M-3/m-1)

r1's "fold evidence" named an interface that does not exist and trusted a
warmed LRU that never re-hashes the supplied base (`e2ee-remote.ts:227-247`,
pinned by `e2ee-sync.test.ts:1187`); zero reconcile actions ignore
`encSha`/compression/size/mtime by design (`engine/diff.ts:15`). Dropped.
The r2 predicate is a direct content binding, all conditions required:

1. `sourceGlobalSeq === snapshot.lastSyncedSequence`;
2. `scoped.storedBaseIsRemote === true` AND incoming `manifestMeta` is
   present AND deep-equals the persisted `state.manifestMeta` over the
   WHOLE stored meta (the `LineageSnapshot.manifestMeta` shape; `chain` and
   meta-wire git rows are stored separately and compared via their own
   persisted forms). The meta-presence rule doubles as the scoped-straddling
   guard: `composeScopedBase` output under a changed straddling projection
   never carries persisted meta (`pull.ts:451` persists meta only when
   `storedBaseIsRemote`) — this fail-closed is hereby CLAIMED as deliberate,
   not inherited by accident (opus M-3);
3. **content self-check:** `canonicalManifestHashStreaming(
   manifestFromMeta(state.lastSyncedManifest, persistedMeta))`
   (`engine/manifest-delta.ts:112`, `sync-state-model.ts:126` — both
   existing grammar/primitives, no new digest version) `===
   manifestMeta.manifestHash`. The `manifestFromMeta` reconstruction is
   required (r2-MAJ): the persisted manifest's `gitRepos` is the LOCAL
   projection (pending/removal/suppression can legitimately differ from
   meta-wire truth, `sync-state-model.ts:484`); hashing the raw persisted
   manifest would make the predicate permanently false on any workspace
   with pending git. The push integrity check at `push.ts:754` is the
   shipped precedent for hashing exactly this reconstruction. The check is
   computed against the state actually loaded from the durable store this
   operation — not an LRU, not shape-valid meta — an honest O(N) CPU pass
   (§5.9): ~hundreds of ms of JS hashing replacing ~8s of staging, copying,
   and fsync. Codex's r1 counterexample (durable `encSha` drift under zero
   actions) fails this check — codex field-mutation probes confirmed the
   canonicalizer binds `encSha`, `comp`, `payloadSha`, `cipherSize`,
   `size`, `mtimeMs` — so today's self-healing full save still fires
   exactly when healing is needed;
4. the UNFILTERED action list `all` is empty (opus m-1: `actions` drops
   ignored paths; rule-authority amendments are already folded into `all`
   via `pull.ts:304-311,337,364-366`, so no separate rule-authority
   condition exists — one predicate input, not two).

Any condition unavailable or false → compose the full packet exactly as
today. No new mode; the full save is the standing backstop.

### 3.2b Snapshot binding under the lock (r2-CRITICAL)

The predicate is evaluated against the state loaded BEFORE the state lock;
the CAS expectation is sampled from a fresh token AFTER acquiring it
(`sqlite-state-save.ts:99,158`). Without a binding, a writer landing in
that interval is silently absorbed: an elided global disables the
sequence predicate (`cas-steps.ts:89`) and an elided repo row leaves no
`repo_gen` to check (`cas-steps.ts:91`).

Fix — one scalar CAS predicate: every accepted CAS increments
`stateRevision` (`write-packet.ts:257`), so revision equality proves no
save of ANY kind interleaved since the caller's load. A packet carrying
elisions MUST carry the receipt's `{nonce, stateRevision}` as a common
optional `elisionExpectation` field on `StateSavePacket`, checked by BOTH
backends (r3-MAJ parity: `legacy-json-store.ts:101` checks stream, nonce,
sequence, and touched repo gens but never `stateRevision` — an intervening
JSON save preserves nonce, so without the packet-level check the race
stays open on the legacy arm). Mismatch → REJECTED with a NEW public
retryable reason `"elision-drift"` (r3-CRITICAL: the raw
`"state-revision"` reason is translated to terminal `"nonce"` at
`whole-state-compat.ts:392`, which `saveStateSource` treats as an
incarnation change and throws, `sync-state.ts:392-395` — receipt drift
must not ride that mapping). **Receipts are single-attempt, structurally.** r1-IMPL correction: making the
rejection handler discard the receipt covers only `"elision-drift"`, so an
ordinary `repo-generation`/`global-sequence` rejection would recompose against
the fresh reload while re-attaching the stale proof — a deterministic
`elision-drift` on the next attempt, turning a pull that survives two
interleaves today into a three-attempt throw. The coupling belongs in
composition instead: `composeStateSavePacket` uses a receipt ONLY when
`receipt.nonce === expectedStateNonce(snapshot)` and
`receipt.stateRevision === snapshot.stateRevision`. Every retry recomposes
against the adapter's under-lock reload (`whole-state-compat.ts:398`), so a
reload that moved the revision — for ANY rejection reason — leaves the receipt
unbound and therefore spent. No rebinding, no proof re-establishment —
the deterministic-rejection loop codex constructed (an interleaved no-op
save advances revision without changing any elision predicate, so an
unbound retry re-sends the stale receipt forever) is impossible by
construction. This is the same re-read-and-compare-under-lock shape the
reset precedent already uses (`whole-state-compat.ts:346`). The §3.3
repo-guard trade is thereby superseded: the revision predicate covers
global and repos with one scalar.

Kill switch
`RBOX_SAVE_NOOP_ELIDE` (default on), registered in
`defaults-ledger.test.ts` (opus m-2); deletion condition: one clean fleet
soak.

### 3.3 Repo-transition elision (opus M-1)

`packet.repos` is never empty once a workspace has one git repo
(`observedRepoKeys` unions all known repo records, `sync-state.ts:348-366`),
and every transition is an unconditional upsert with `repo_gen+1`
(`cas-steps.ts:205-210`). Without this half, M1 never fires on desktop/FM.

Elide a repo transition when its composed `newRecord` deep-equals the
current record in the loaded state AND the global was itself proven unchanged
this cycle. r1-IMPL ruling: repo elision is gated on `elideGlobal`. Ungated, it
fires on ordinary content-carrying pulls, where it buys ~nothing (the measured
8.4s is entirely global-stage work) while attaching an `elisionExpectation` —
and therefore a cross-process drift rejection — to every such save; the
daemon's load→lock window is minutes long on a large workspace, and a CLI
writer landing inside it would spend a retry attempt for no gain. Gating keeps
100% of the measured no-op win and gives `elisionExpectation` exactly one
meaning: the global was proven unchanged. Safe against 235 §5.4: delete-absent
applies to the file plane only (`generations.ts:344-355`); `applyTransitions`
is pure upsert with no absence semantics. The r2 trade ("elided repo loses
its `repo_gen` guard") is superseded by §3.2b: the receipt's
`stateRevision` predicate detects ANY interleaved accepted save, covering
elided repos and the elided global with one scalar. Zero elided repos on
any cycle where any repo record changed.

### 3.4 What M1 does NOT retire (requirement ledger, decided by founder or preserved)

| Behavior | r2 disposition |
|---|---|
| SP-2 lock/fence refusal semantics | preserved (save always runs) |
| `stateRevision` bump per accepted save | preserved |
| Legacy-JSON housekeeping (marker, sanitation, nonce) | preserved |
| Empty-packet lineage-init/reset contract | preserved + newly pinned |
| Fresh `plane_heads`/BASE generation on same-head full save | changed: an elided cycle keeps the prior coherent generation — observable. ACCEPTED by founder 2026-08-16, conditional on the reader-audit pin below |
| Third hash in `deleteSealedArtifact` | preserved (r1-M3 withdrawn) |

### 3.4.1 Reader audit for the retained BASE generation (founder condition)

The trade is admissible only because no reader treats the generation stamp as a
freshness or change-detection signal. Every reader of `active_base_generation` /
`plane_heads.generation` falls into one of three classes:

1. **Address lookup keyed by generation** — the stamp selects which rows belong
   to the live BASE, nothing more: the head/meta join and its invariant
   (`store/read-snapshot.ts:50-62`), the manifest-chain cursor (`:190`), and the
   manifest-git-section cursor (`:205`). A retained generation addresses the same
   rows, which is exactly the intent: the content did not move.
2. **CAS equality guards** — `write-packet.ts:101` (the transition stage's bound
   snapshot) and `cas-steps.ts:87` (`base-generation`). Both compare for
   equality against the caller's observed value; neither infers recency from a
   larger number. An elided cycle leaves both operands equal, which is a match,
   not a stale read.
3. **The migration writer** — `migration/import-install.ts:65,92,100,111,148`
   stamps `plan.baseHead.generation` on rows it installs. It writes the stamp;
   it never reads one to decide whether anything changed.

No reader derives "the base is current" or "something changed" from the
generation. `write-differential.test.ts` pins the advancement on content-carrying
saves, and the §7 fixture below pins non-advancement across elided ones.

## 4. Mechanism M2 (rescoped) — accepted projection for the elided path only

r1's "return the composed state" was wrong for direct packet callers
(push receipt arming `push.ts:802-816`, reset, lineage init, held-skip,
p-settlement) — they have no projection, and the read-back contributes
canonicalization, `stripObsoleteResolutionIntents`, `lineageExtras`, and a
possibly interleaved `telemetryBindingId` mint (`write-packet.ts:309-333`
deliberately preserves `stateRevision` so the mint is not CAS-observable).
All of that stands. **Full read-back remains the default for every save.**

The one shape where a complete projection already exists: the fully-elided
no-op save. The state the caller LOADED this cycle is read-back-normalized
by construction (it came from `loadRawStateFromStore`), and durable content
is proven unchanged by §3.2. Follow the existing precedent
(`acceptedProjection`, `whole-state-compat.ts:357`,
`whole-state-compat.test.ts:867`): `saveStateSource` supplies the loaded
state as the projection; the adapter overlays ONLY the CAS token fields
(`stream`, `lastSyncedSequence`, `nonce`, `stateRevision`,
`telemetryBindingId`, `lineageExtras` — the `LineageSnapshot`/token
surface, `ports.ts:23-38`; note `projectAcceptedSavePacket` today overlays
only five of the six — `lineageExtras` must be added, r2 disposition).
The precondition is re-derived by the ADAPTER, not trusted from the caller
(r1-IMPL): `translateCasResult` honours `acceptedProjection` only for a packet
that carries an `elisionExpectation`, no global, and no repo transitions. A
packet that wrote anything is read back regardless of what the caller offered,
so a future caller cannot make a stale projection durable by mistake.
This projection reuse is sound ONLY because of §3.2b: an accepted elided
CAS proves via the revision predicate that durable content equals the
loaded state plus exactly the token-field changes. Gate: strict-equality
test `returnedState === durableReload` for the elided shape, per the
precedent test — including under the §3.2b interleaving fixture. The rejected
path keeps its read-back (load-bearing for recompute).

Downstream consumers audited (opus M-4): `savedState` →
`settleCommittedBranchArtifacts` (`pull.ts:483`) → `observeDurableGitState`
→ `daemon/daemon.ts:2163 this.syncBase` → next push's `appliedBase`
(`:1844`) and matcher rebuild (`:656`). The strict-equality gate is what
protects that chain.

## 5. Deferred (M4) — needs post-M1 evidence

Small-delta pulls (Mac 18.3s / 1 blob) and the 2.0s per-cycle state load
(no cross-cycle cache, connection closed per call,
`whole-state-compat.ts:158`) are re-measured after M1 ships. If still over
budget, a delta-stage mechanism (partial stage bound base→head, CAS apply
without delete-absent, digest grammar v2) gets its own design answering 235
§5 constraints 1, 4, 5, 6, 7 individually. Not designed here (232 knife).

Remaining O(N) per no-op cycle after M1+M2, named per §5.9: state load
(2.0s, deferred), packet-composition JS copies, the §3.2.3 hash
(~hundreds of ms), `observedRepoKeys`/record deep-equals (O(repos)).

## 6. Protected contract

- `stage-semantic-v1` digest + goldens — untouched (elided saves build no
  stage; built stages are complete, byte-identical grammar).
- CAS refusal semantics, delete-absent promotion, sealed-header commit.
- Darwin trilogy #745/#746/#747 — no connection or artifact-lifecycle
  changes; the deletion-path hash explicitly preserved.
- Crash semantics: `BEGIN IMMEDIATE` + `synchronous=FULL`; an elided
  section writes nothing, so no new crash window; the minimal save commits
  atomically as today.
- SP-2 fail-closed degraded saves, fence acquisition, lineage init, reset
  migration, legacy-JSON arm behaviors — all preserved per §3.4.
- Repo-only packet shape (`pull.ts:170`, push sites) — unchanged.

## 7. Validation

- Differential gate through the REAL `saveStateSource` orchestration (not
  packet-level): JSON vs SQLite, scoped/unscoped, pending git, elided and
  non-elided, comparing result state, durable state, errors, revisions, and
  lock/fence outcomes (codex fold: packet-level `write-differential.test.ts`
  cannot see a minimal packet's provenance).
- Red-first: fixture proving today's path builds a full stage on the no-op
  case, flipped by M1.
- Corruption fixture (codex CRIT): warmed fold LRU + durable `encSha`-only
  drift + zero actions → M1 MUST compose the full packet (the §3.2.3 hash
  mismatch) and the save must heal the drift, byte-compared post-save.
- Scoped-straddling fixture: straddling flip at equal sequence → meta
  absent → full packet (the claimed fail-closed of §3.2.2).
- Empty-packet contract pins: lineage init and reset migration behave
  byte-identically with M1 in the tree.
- Negative controls: 1 action; ignored-path-only change (all non-empty,
  filtered empty); repo record change (that repo not elided); missing meta;
  degraded/recovery pull (no provenance → full packet).
- Interleaving fixture (r2-CRITICAL): a writer lands a repo change AND a
  global change after the pull's load but before its lock acquisition; the
  elided save MUST come back REJECTED on the revision predicate, the
  caller's recomputation must produce a full packet, and the final
  `returnedState === durableReload` must hold.
- Provenance fixtures: a degraded pull and a recovery-adoption pull
  construct no receipt and compose full packets (structural, asserted).
- Stale-receipt fixture (r3-CRITICAL): interleaved ACCEPTED no-op/minimal
  save (revision advances, elision predicates all still true) →
  `"elision-drift"` rejection → receipt discarded → full-save retry
  succeeds on attempt 2. Distinct from the content-change interleaving
  fixture above, which could mask stale-receipt reuse by forcing a full
  packet anyway.
- Backend-parity fixture: the same receipt-bearing minimal packet against
  the legacy-JSON arm rejects/accepts identically on revision drift.
- First-save / legacy nonce-less fixtures: no receipt constructed, full
  save composed.
- Telemetry fixture (r3 cleared, pinned): absent binding → interleaved
  mint between load and elided save → accepted (revision preserved by the
  mint), `returnedState === durableReload` including the fresh
  `telemetryBindingId`.
- Strict-equality projection test for the elided shape (returnedState vs
  durable reload), per `whole-state-compat.test.ts:867` precedent.
- Provenance fixtures run through the REAL `pull()` lanes (r1-IMPL): a
  standalone pull of an unchanged head elides (no BASE generation is built), the
  same head pulled on the `recovery` lane composes a full packet, and a remote
  change on an IGNORED path composes a full packet — the last pins `noActions`
  against the unfiltered `all`, which nothing else observes.
- `encSha`-ONLY drift fixture: every other field of the durable entry matches
  the meta's manifest. A predicate that stopped binding `encSha` passes a
  fixture that also moves `sha256`/`size`/`mtimeMs`, so the drift is isolated.
- `manifestFromMeta` operand fixture: meta-wire git present, local projection
  empty, the two hashes asserted DIFFERENT, and elision still fires.
- Projection-guard fixture: a content-carrying packet offering an
  `acceptedProjection` is read back from the store, not projected.
- Reset-migration pin: the nonce-less legacy migration's empty packet
  (`reset-state.ts:434-445`) still mints the nonce, advances the revision once,
  and leaves every other member byte-identical.
- Retained-generation fixture (§3.4.1, founder condition): two consecutive
  accepted elided saves leave `active_base_generation` unchanged and a full load
  still returns state deep-equal to the pre-elision durable state; the next
  CONTENT-carrying save advances the generation and reads back correctly.
  Receivers act on content change, never on a freshness stamp.
- Bench honesty (opus m-5): `scripts/bench/state-plane.ts` times
  `applySavePacketToStore` directly, so it can measure the minimal-packet
  cost but NOT the elision decision; the field trace is the authority for
  the end-to-end number. Bench gains the minimal-packet case; field re-run
  covers desktop zero-change pull + push AND Mac 1-blob (both lanes,
  before/after, per the perf close-out rule); numbers appended here.
- Lint: all touched files anti-slop clean, with one recorded exception — the
  three `no-shape-in-symbol-names` hits in `sync-state-model.ts` (:135, :283,
  :321) are durable persisted field names already queued in
  `docs/wire-rename-candidates.md`; a code-symbol rename cannot retire them.
  oxlint anti-slop-types rules pass on new code; no suppressions.
- Mutation evidence for §3.2.3 (the one predicate condition no shipped fixture
  discriminated on its own): with the content self-check replaced by `true`,
  the isolated `encSha` fixture and the warmed-fold regression both fail, and
  both pass with it restored. Recorded because git history places this design's
  implementation before its tests — the mutation is the honest substitute for a
  red-first commit, not a claim of one.

## 8. Not built (standing, inherited from 235 §4)

No server changed-path endpoint; no second on-disk manifest representation;
no scheduler changes; no new digest grammar; no mechanism for any stage the
numbers say is cheap.

## 8. Field close-out (2026-08-16, desktop, live daemon, build 431167a)

Perf-differential close-out, both lanes, same host/workspace (120,485
files, 263 MB store), captured from the production daemon log:

| Zero-change cycle | before (da28ddc, 16:26-16:30Z) | after (431167a, 16:41-16:43Z) |
|---|---|---|
| pull wall | 13.3s | **3.6s** |
| pull state-save | 9.8s | **0.8s** |
| push wall | 6.9-7.5s | 6.5-7.0s (no regression; push save was already 0.0) |

The residual 0.8s save is the preserved minimal-CAS path (lock, fence,
revision, projection overlay). Remaining pull cost is dominated by
state-load (~1.7s) — the §5 deferred M4 evidence item. Mac 1-blob leg
runs post-merge via the normal fleet rebuild (worktree branches do not
sync to the Mac by design).
