# 278 — Connectivity-deferred repos join the held-skip fast path

Status: ALIGNED r3 · 2026-08-18 · Addresses the connectivity class of #775
(#775 stays open for the unreadable-journal class + cas acquire).
r1 → r2: folded opus review B (REVISE) + 208-pull per-repo field evidence;
objectDbDigest DROPPED (liveness-only mechanism — see M2); typed defer
status replaces the /connectivity/ regex; scope and estimate made honest.
r2 → r3: folded opus coverage review — digest-drop UPHELD as safe (full
input-coverage table verified; every uncovered change is
verdict-conservative in both the connectivity proof AND the ref-plane
ownership proofs; `record.attempt` has zero readers outside sync-git/ and
resolve-evidence re-stages live, so no consumer can act on a stale
verdict); ONE BLOCKER folded: M1 is GATED ON THE TYPED CODE, never on
bare defer status — an unscoped store would memoize transient
boundary-race defers (chooseFailure mints allowlisted reasons like
local-commits from boundary provenance; reflogs are unfingerprinted, so
the bracket would hold) and stall a clean apply up to the 1h floor;
r1-residue digest validation items deleted; copy fix retargeted to the
`artifact` story (SYNC_DOWNLOAD_FAILED is false for this class — the
download succeeds, the local object graph is incomplete); the "over a
day" line stays (keys off deferredSince, remains true, doctor escalation
is the safety valve); store-success assertions added (the M1 bracket can
refuse silently on breadcrumb-waived repos — degrade documented).
Baseline: FM pulls median 44.3s post-277, git-apply median 28.3s dominated
by deferred repos re-fetching bundles (fetchDecryptMs 12.5–17.3s for one
repo, 1–5s for four more, EVERY zero-change pull; queueMs p95 22–28s from
chain serialization behind them).

## 0. Root cause (recon-verified, all anchors current main)

A repo that defers at the checkout transaction's connectivity proof
(`checkout-txn.ts:693` → reason "artifact", provenance "boundary") is a
**self-sustaining fixpoint**: every pull re-runs the full follow — bundle
fetch + decrypt + import as the follow's FIRST statement (`follow.ts:63`,
`git-state.ts:299-314`) — then fails the same proof and defers again.
Two independent causes, both required for the fix:

1. **No attempt is ever stored** for the `commitCheckout` defer: the exit
   at `follow.ts:199` bypasses both `afterHeldClassification` sites
   (`follow.ts:183`, `:250`), and `apply.ts:940-943` unconditionally
   clears any prior attempt once a full follow is required. Next pull:
   `earlyReason: "no-attempt"` → full path → fetch.
2. **The reason is not allowlisted**: `heldBlockersAllowSkip`
   (`held-blockers.ts:57-69`) has no boundary/connectivity disjunct.

The proof itself (`defaultConnectivityProof`, `checkout-txn.ts:286-309`:
`rev-list --quiet` + `fsck --connectivity-only` over
`plannedGraphRoots`, `GIT_NO_LAZY_FETCH=1`) reads the LOCAL object DB
against a root set that — review-B correction — derives partly from
DECRYPTED op-state blobs (follow.ts:163-166 → reachability.ts:91), so
the proof cannot run pre-fetch; but for the failing class the import
demonstrably does not make the graph connected, so the per-pull fetch
buys nothing. A Layer-A skip is unaffected by the op-state dependency:
`gitIncomingKey` binds the op-state shas (shared.ts:135), so an
unchanged incomingKey pins unchanged roots. No design ruling requires
the re-fetch. The current-link presence-skip exclusion
(`git-state.ts:275-281`, branch at `:327-330`) IS load-bearing and is
NOT a fix avenue (review-B finding 6): tip-commit presence witnesses
nothing about index blobs or op-state WIP objects that live only in the
current bundle, and post-defer `cleanupRefs` (follow-staging.ts:69-71)
makes imported objects gc-prunable — a current-link presence-skip would
convert an honest defer into a checkout with missing objects.

**Producer discrimination (review-B blocker, resolved by log evidence):**
three sites produce `reason:"artifact"`+`attempt:null` — the connectivity
defer (checkout-txn.ts:693), the stage fetch/decrypt failure
(follow.ts:64-67), and the follower-branch hold (apply.ts:849-851) — and
the persisted deferral carries no detail. The FM daemon log DOES
(`git-sync deferred <rel>: <detail>`, apply.ts:1114); 208 consecutive
pulls on 2026-08-18 name every repo:
- `planned graph connectivity proof failed` ×208 each:
  `Personal/AutoGPT`, `Open-Source/bird`, `Dfinitiv/savvy-demo`,
  `Dfinitiv/conductor-workspaces/savvy-core-v1`,
  `Dfinitiv/claude-containers` — **five repos, all the connectivity
  class. This design's target, confirmed per-repo.**
- `unreadable or corrupt journal` ×208 each: `Dfinitiv/pegasus`,
  `Dfinitiv/savvy-core` — a THIRD class this design does NOT cover
  (§2); they also pay full follows every pull.
- local-edits: `Personal`, `Personal/home-dashboard` (excluded, 241).
Fixture rows (src/cli/fixtures/field-states/2026-08-17-flat-meadow.jsonl):
all five connectivity repos carry `reason:"artifact"`, `attempt:null`,
deferred unchanged >32h.

## 1. Mechanism (two edits, both extending design 270's primitive)

### M1. The connectivity-defer exit records a bracketed classification

`follow.ts` gains a third `afterHeldClassification` invocation for the
checkout-defer exit (`:199`), **gated on the M0 typed code — invoked
ONLY when `checkout.code === "connectivity-unproven"`** (r3 blocker: an
unscoped store memoizes boundary-race defers whose reasons are already
reason-allowlisted). The `CheckoutDeferCode` rides
`CheckoutCommitReceipt` for this gate. Constraints honored:
- Runs inside the same stable-fingerprint bracket as the two existing
  sites (design 176 §4 v6): the observation is only stored when the
  fingerprint at classification start equals the fingerprint at store
  time — a mid-follow local mutation refuses the store, exactly like
  today's sites.
- Does NOT resurrect what `apply.ts:943` shreds: the clear stays; M1
  stores a NEW post-follow observation, so the "artifact/capability/
  boundary exits must not preserve a REJECTED attempt" rule is intact.
- The stored observation carries the full existing
  `HeldInputObservation` field set (no new fields — see M2).

### M0. `commitCheckout` returns a TYPED defer status (one owner)

Today the connectivity defer is identified downstream by
`/connectivity/.test(result.reason)` over a human string
(ref-plane-transaction.ts:361-362). M2's allowlist must never be fed by
a regex over prose (review-B finding 2). `commitCheckout`'s defer result
gains a typed `code: "connectivity-unproven"` field minted at the ONE
site that runs the proof (checkout-txn.ts:690-693);
`ref-plane-transaction.ts` maps code, not prose; the human string stays
for logs. `blockerForReason` (follow-types.ts:197-203) carries the code
onto the stored blocker. Additive shape change, v2-beta window.

### M2. `heldBlockersAllowSkip` gains the connectivity disjunct — NO new digest

- New disjunct keyed by `provenance:"boundary" && code:
  "connectivity-unproven"` (the M0 typed code) — mirroring
  `composerHoldAllowsSkip` (held-blockers.ts:50-55). `.every()`
  semantics preserved; no other class admitted: NOT `local-edits`
  (design 241 permanent exclusion), NOT `mismatched-*`, NOT the
  unreadable-journal class (§2), NOT the staging-failure or
  follower-hold producers of `reason:"artifact"` (they mint no code, so
  they refuse by construction — pinned by test).
- **r1's `objectDbDigest` is DROPPED** (review-B finding 3, endorsed): a
  memoized skip publishes nothing and re-stands the standing deferral,
  so the worst consequence of a stale verdict is that a REPAIRED repo
  (gc/repack/manual fetch fixed the graph) waits out
  `HELD_SKIP_SAFETY_FLOOR_MS` (1h) before the re-prove notices — for
  repos broken >32h, a ≤1h detection lag is trivially acceptable, and
  no correctness property depends on earlier detection. This deletes a
  durable schema field, a scan module, and a per-repo stat walk, and
  avoids double-owning `objects/info/alternates` (already fingerprinted,
  fingerprint.ts:271). If the parallel coverage review (r2 open point)
  finds a path where a stale skip is UNSAFE rather than merely slow,
  the digest returns as designed in r1 (recorded fallback).
- The skip matches on `incomingKey` (bundle-address-independent via
  `heldClassifierInputKey`) — a NEW published sequence re-proves by
  construction — plus the full existing `HeldInputObservation` field
  set (localFingerprint, reflog digests, stateNonce, ...).
- Kill switch `RBOX_GIT_CONNECTIVITY_SKIP=0` (default-ON — review-B
  finding 8 concurs: no wire break, fail-closed, worst failure mode is
  "stays deferred ≤1h longer"; owner: this design; deletion condition:
  two clean fleet weeks).
- `HELD_SKIP_SAFETY_FLOOR_MS` (1h) unchanged — the hourly re-prove is
  now the SOLE liveness bound and is named as such.
- Design 273 P2 retention: the skip re-stands the existing deferral
  (`restandApply` only), never clears, never re-stamps `lastSeen`.
- Copy fix in the same PR (r3-retargeted): the "over a day" line STAYS
  (it keys off deferredSince age — still true — and its doctor
  escalation is the safety valve for a stale verdict). The genuinely
  wrong copy is the `artifact` story (git-stories.ts:151-155,
  SYNC_DOWNLOAD_FAILED: "rbox couldn't finish downloading…") — false
  for this class, where the download SUCCEEDS and the local object
  graph is incomplete; reworded to be honest for both subclasses under
  the 273 copy bar. Named trade: the per-pull `git-sync deferred <rel>`
  log line goes quiet between floors; `skippedHeld` counts cover the
  operator view.

### Effect (honest, review-B-corrected)

The five connectivity repos skip at Layer A (apply.ts:1286) — before
every probe and before `stageIncoming` — on all steady pulls between
hourly floors. What does NOT change: `Dfinitiv/pegasus` +
`Dfinitiv/savvy-core` (unreadable-journal, full follow + fetch every
pull) and the local-edits pair. Post-fix git-apply floor =
max(Personal chain: `Personal` follow → 43 cheap skips →
`home-dashboard` follow; Dfinitiv chain: pegasus + savvy-core full
follows serially). Expected FM pull: 44.3s median → **~25–30s** (NOT
r1's 18–22 — that figure ignored the unreadable pair and the serial
chain roots). Remaining after this design: the unreadable-journal class
(#775 stays open), cas acquire 11–12s (#749 residual), state-save
~2.5s. The per-relPath cost of the unreadable pair comes out of the
field differential and decides whether the bundle-cache follow-up
triggers (§2).

## 2. Explicitly NOT in this design

- **No bundle/blob cache** (recon shape 4) — but with the honest
  head-to-head review B demanded, not a dismissal: the cache's key
  (`encSha`, the exact content address, git-state.ts:577) and both
  re-verify layers already exist; its new concepts are a cache dir, a
  size cap, and an eviction owner (~3), no durable state. r2's M0+M1+M2
  count ≈ 4 (typed code, third store site, allowlist disjunct, flag).
  The skip wins because it removes the WORK (probes, import, proof, git
  spawns), not just the transfer, and it breaks the livelock; the cache
  would still run a full follow per pull. Named trigger for the cache
  follow-up: if the field differential shows the unreadable-journal +
  local-edits repos' fetch legs ≥5s combined median after this ships,
  file the cache as its own design with the disk-budget rules from
  design 100 §"Prefetched artifact temps".
- **No pre-fetch connectivity precheck** (shape 3): review B found the
  decisive refutation — the proof's roots derive from DECRYPTED
  op-state blobs (follow.ts:163-166 → reachability.ts:91), so a
  pre-fetch precheck cannot even compute its roots without fetching.
  (r1's "reads only local state" claim in §0 was wrong on this point;
  corrected. The Layer-A skip is unaffected: `gitIncomingKey` binds the
  op-state shas, shared.ts:135.)
- **`local-edits` stays excluded** (design 241 / 176 §4 v5 rulings) —
  `Personal/home-dashboard` keeps its per-pull follow until the user
  resolves; that convergence loop is user-bounded, unlike the
  artifact-class livelock.
- **The unreadable-journal class** (`Dfinitiv/pegasus`,
  `Dfinitiv/savvy-core`, 208/208 pulls): NOT allowlisted here — its
  verdict depends on journal bytes whose fingerprint coverage is
  unaudited, and mixing two classes into one widening is how allowlists
  rot. #775 stays open for it; the same M0 typed-code pattern is the
  likely shape.
- **Structural escalation** (a >N-hours connectivity-failed repo telling
  the user its object DB is damaged — recon shape 5): real product gap,
  filed as its own issue (see PR body for the number), not smuggled
  into a perf fix. The hourly re-prove keeps the repo's deferral honest
  meanwhile.

## 3. Protected functionality

- The pre-commit fail-closed proof is untouched: `commitCheckout` still
  runs `defaultConnectivityProof` before publishing refs
  (`checkout-txn.ts:690`, "r2 F4" comment) on every non-skipped follow.
  A memoized SKIP never publishes anything — it is the same "leave the
  standing deferral standing" posture as every held skip.
- `heldBlockersAllowSkip` allowlist pin (`held-skip.test.ts:82`) updated
  by the same PR that widens it; `.every()` semantics; hourly floor;
  fingerprint-bracket store rules (176 §4 v6); 273 P2 retention; the
  `clearAttempt` rule at `apply.ts:940-943`; design 241's local-edits
  exclusion; chain-timing leaf-sum invariant (`chain-timings.ts:78-82`);
  apply-stats golden strings updated deliberately. r3 additions: the
  Layer-A gate does not compare reflog digests (pre-existing, shared
  with every fast-path class, conservative here — reflogs can change
  the blocker CLASSIFICATION, so this is named rather than rediscovered);
  the ref-plane ownership proofs (`tipOwnedByIncoming`) also read the
  object DB — both flip directions under a skip are conservative
  (suppressed publish = delay; suppressed hold = no-op, a skip publishes
  nothing).

## 4. Validation

- **Red-first fixpoint test** (held-composer-skip.test.ts shape, real
  on-disk repo): construct a repo whose import cannot satisfy the proof
  (a root OID absent from the bundle), run two pull cycles, assert cycle
  2 performs ZERO blob fetches (counting BlobStore) and zero
  fetch/import git spawns (`setGitSpawnObserver`) — RED against current
  main (today cycle 2 re-fetches).
- **Producer-isolation negative test** (review-B finding 10): the
  staging-failure artifact exit (follow.ts:64-67) and the
  follower-branch hold (apply.ts:849-851) still store NO attempt and
  can never ride the new disjunct (no code minted).
- **First-ever connectivity-defer test** in checkout-txn.test.ts (today
  every site injects `proof = async () => true`): the real proof path
  produces `status:"defer", reason:"planned graph connectivity proof
  failed"` and the journal-intact semantics hold.
- Digest sensitivity: `git gc`/repack between cycles ⇒ digest moves ⇒
  skip refused ⇒ full re-prove (and a repaired repo actually follows);
  manual `git fetch` adding the missing objects ⇒ same. Negative
  control: touching a worktree file does NOT move the digest.
- New-sequence re-prove: publish a new incoming sequence ⇒ skip refused
  by `incomingKey` mismatch.
- Hourly floor; kill-switch reverts to today's behavior; allowlist pin
  (a non-allowlisted boundary code still refuses); local-edits still
  never skips (241 pin re-asserted).
- Digest-drop liveness test: repair the broken repo (add the missing
  objects via git fetch) mid-soak ⇒ the repo follows successfully at
  the next hourly floor, not sooner — pinning the accepted ≤1h lag.
  (r3: the r2 "digest sensitivity" gc/repack/fetch-refusal tests are
  DELETED as r1 residue — no digest exists and those mutations move
  nothing observable by design.)
- Store-success assertions: the fixpoint test asserts the attempt is
  durably stored after cycle 1; negative: a breadcrumb-waived repo
  (preserveOrigHead writes ORIG_HEAD inside the bracket) refuses the
  store and full-follows both cycles — the silent-degrade mode is
  documented, not discovered in the field.
- Boundary-race negative (r3 blocker pin): a non-connectivity
  commitCheckout defer (boundary provenance, reason local-commits)
  stores NO attempt and is re-attempted next pull.
- Field acceptance: FM overnight — deferral ages keep growing (273 P2),
  `skippedHeld` rises by exactly the five connectivity repos,
  fetchDecryptMs for AutoGPT appears at most once per hour, pull median
  measured against the 44.3s baseline with the ~25–30s expectation.
  Both-lanes differential per the perf close-out rule (push lane must
  not move).
