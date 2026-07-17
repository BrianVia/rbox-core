# 149 — Storage economics: O(change) commits and fair-use enforcement

## Problem, with field evidence

The founder account reached its 250GiB cap on 2026-07-16 with only 4.3GiB of
active data. The design-142 storage-truth measurement (run 2026-07-17,
partition exact at 940,446/940,446 rows) decomposed the 254GiB:

| Class | Bytes | Cause |
|---|---:|---|
| active-head | 4.3 GiB | real files |
| retained-history | 193.3 GiB | see below |
| stranded (fresh/aged/marked/purge-eligible) | 56.6 GiB | over-cap partials, head-409 orphans, Jul-7 file-plane re-address |

The retained-history mass is NOT file history and NOT git bundles:

- **~181 GiB = encrypted manifests.** 4,344 blobs in the 10–100MB band
  against 4,780 retained sequences (`commits` D1 count). Every commit
  serializes the complete manifest as raw JSON (39–41MB measured for this
  workspace at ~112k refs, `CHANGELOG.md:446`) and encrypts it with a fresh
  random nonce (`src/engine/e2ee/manifest-crypto.ts:34`) — deliberately
  non-convergent, so byte-identical manifests never dedupe.
- **~10 GiB = refset sidecars.** 5,320 blobs in the 1–10MB band. Above
  `SIDECAR_THRESHOLD` (4,000 refs) every commit uploads the complete
  canonical `(encSha,size)` set — `18 + 40×count` bytes
  (`src/engine/refset.ts:45`), ~4.5–6MB at 112–150k refs. High-entropy sha
  bytes: compression cannot help.
- Git bundles are a MINOR term: incremental bundles are default-on
  (chains ≤8 links, `src/engine/git/capture.ts:242`), and convergent file
  encryption (`src/engine/crypto.ts:141`) plus linked-worktree dedup were
  already working.

At agentic velocity (~500 commits/day) the arithmetic is: 40MB manifest +
~5MB sidecar per commit ≈ 20GB/day, retained 365 days on pro. Design 84
built the manifest fix (compressed snapshots measured **24× smaller**, plus
O(change) deltas) and merged it 2026-07-12 — but write-side remains gated
behind `RBOX_MDE_SNAPSHOT=1` / `RBOX_MDE_DELTA=1` (`src/cli/e2ee-remote.ts:73`)
and no delta encoding exists for refset sidecars at all.

**Target end-state (the invariant this design ships): steady-state storage
growth is proportional to bytes actually changed, bounded by a fair-use
multiple of active data.**

## Scope — three units, one seam review

1. **Unit A — manifest envelope default-on.** Version-gated promotion of
   design-84 snapshot (and then delta) writing from env-flag to default.
2. **Unit B — refset sidecar delta encoding.** Parent-relative add/remove
   deltas with periodic full snapshots, mirroring design 84's chain shape.
3. **Unit C — fair-use history enforcement.** `historyBytes ≤ 5 × activeBytes`
   per account with oldest-first sequence pruning, applied to ALL accounts
   including the founder (founder ruling 2026-07-17).

Non-goals: git-plane bundle retention semantics (recon complete —
`scratchpad/codex-explore-bundle-retention.log` candidates 1/2/3 — deferred:
now the smallest term); commit debouncing (rider note in §8; separate cycle
if pursued); R2 physical GC / pack-gc execute-mode (separate operational
track); pricing or tier changes (explicitly ruled out by founder).

## Unit A — manifest envelope default-on

Design 84 phased B (fleet read capability) before any write change; Phase B
readers shipped in the 2026-07-12 merge and every release since. What remains
is turning writers on safely for accounts whose DEVICES may lag.

Mechanism:

- **A1 — snapshot default.** Writer emits envelope-v1 compressed snapshots
  by default when the workspace's minimum observed client version supports
  Phase B reads. The server already records each device's `cliVersion` at
  auth; the commit route response includes a workspace-level
  `minReaderVersion` derived from devices seen in the last 30 days. Writer
  rule: `minReaderVersion ≥ 1.6.5` (first release carrying Phase B) →
  envelope allowed; otherwise raw-v0 with a one-line daemon log so the
  operator can see why. Env flags remain as overrides in BOTH directions
  (`RBOX_MDE_SNAPSHOT=0` force-off for rollback, `=1` force-on for fleets
  that know better — today's founder fleet).
- **A2 — delta default.** After A1 soaks (one release), the same gate
  enables `RBOX_MDE_DELTA` semantics by default: O(change) delta bodies with
  design 84's existing chain bounds (≤16 predecessors, snapshot re-anchor).
  No new mechanism — this is a default flip behind the SAME version gate,
  sequenced only to keep one variable per release.
- The 30-day device-recency window is the compat window design 84 §Q2 left
  open: a device idle >30 days may find its workspace has moved to
  envelope-v1 and must upgrade (fail-closed with the §3 "upgrade rbox"
  message — already shipped reader behavior).

## Unit B — refset sidecar deltas

Today (`src/cli/e2ee-remote.ts:57,692`): at ≥4,000 unique refs the client
uploads the full canonical refset before every commit; the server stores it
as an opaque blob referenced by the sequence root.

Mechanism — mirror design 84's shape so reviewers/readers learn one pattern:

- **Envelope**: `rbox-rsd1\n` magic + strict-JSON header line + binary body.
  Kinds: `full` (today's canonical bytes) and `delta` (parent sidecar
  encSha + sorted added `(encSha,size)` entries + sorted removed encShas).
- **Chain bounds**: ≤16 delta links, then a mandatory full re-anchor; a
  writer that cannot read its parent sidecar (evicted, unreadable) falls
  back to full. Byte bound: emit full when
  `deltaBytes ≥ fullBytes × 0.5` (worst-case churn degenerates gracefully).
- **Verification**: the reconstructed set's canonical serialization must
  hash to the sidecar identity the signed commit pins — same
  fail-closed-on-mismatch rule as today's full sidecar validation; a delta
  chain is exactly as trustworthy as its anchor because the identity check
  runs over the RECONSTRUCTED FULL SET, not per-link.
- **Server**: opaque as today — no route or schema change; old readers gate
  on the `rbox-rsd` magic exactly like design 84's envelope rule (unknown
  version → "upgrade rbox"). Read capability ships one release before
  write-side default, gated by the SAME `minReaderVersion` mechanism as
  Unit A (bumped floor).
- Steady-state cost at founder velocity: one changed file ≈ 80 bytes of
  sidecar delta vs 4.5–6MB today.

## Unit C — fair-use history enforcement (5× active)

Founder rulings: pricing/tiers unchanged; history fair-use ≈5× active with
oldest-first pruning; applies to the founder account too; accelerated-prune
UX deferred until it is ever needed by a real user.

Mechanism (server-side, extends design 66's floor machinery — no client
change):

- **Definition**: `activeBytes` = Σ sizes of blob_refs reachable from HEAD
  roots only; `historyBytes` = Σ over refs reachable ONLY from non-head
  retained roots. Both are already computed classes in the design-142
  runner; the enforcement pass recomputes them per account from the same
  DO-roots + blob_refs join, incrementally (paged, cursor-persisted,
  PHASE1-style caps).
- **Enforcement**: hourly, after retentionPrune and before phase 1: while
  `historyBytes > 5 × max(activeBytes, PLAN_FLOOR_BYTES)`, advance the
  workspace prune floor one sequence at a time (oldest first, never head;
  same DO `/prune` call retention uses), recomputing after each batch of
  floors. `PLAN_FLOOR_BYTES = 1 GiB` so near-empty workspaces keep useful
  history rather than being pruned to nothing.
- **Ordering with retention window**: the window (365d pro) remains the
  outer bound; fair-use is an ADDITIONAL floor mover. Whichever prunes
  more, wins — both express "history the account is no longer entitled
  to retain."
- **Comms surface**: `rbox status` gains one line when fair-use pruning is
  active for the account ("history trimmed to fair-use (5× active)") via
  the existing usage endpoint — no new route.
- **Grace bug fix (found in the field this session)**: `retentionPrune`
  skips ANY account with a live `grace_until`, contradicting its own
  comment ("only consulted when locked") — a paid account that ever
  transited through `none` is permanently retention-exempt until the stamp
  expires. Fix: consult grace only when the resolved plan is `none`
  (`apps/api/src/retention.ts:55`), and make `adminSetPlan` clear
  `grace_until` on upgrade to a paid plan (`apps/api/src/billing.ts:160`).
  Regression test for both.

## Tests the implementation MUST write

- A1/A2: version-gate matrix (all-new fleet → envelope; one stale device →
  raw-v0 + log line; stale device returns after window → fail-closed
  upgrade message on pull). Flag override in both directions.
- B: round-trip property test full↔delta chains (random add/remove churn,
  chain re-anchor at 16, byte-bound fallback, corrupted-parent fallback to
  full, reconstructed-identity mismatch fails closed); cross-version test
  (pre-B reader sees magic → upgrade error, not a crash).
- C: fair-use pass on a synthetic account (history 45× active) converges to
  ≤5× within bounded iterations; head never pruned; PLAN_FLOOR respected;
  grace-bug regression pair (paid plan with stale grace_until IS pruned;
  locked account within grace is NOT).
- Storage-truth runner (design 142) re-run post-C as the acceptance
  measurement: partition holds, retained-history ≤ 5× active-head.

## Rollout order

1. Unit C grace-bug fix + fair-use pass (server-only, no client coupling) —
   ships first; it also protects against every FUTURE amplifier.
2. Unit A1 (snapshot default) next release; A2 (delta default) the one
   after.
3. Unit B readers next release; B writers the one after (same cadence A
   used).

## §8 Riders recorded, not designed

- Commit debouncing: ~500 commits/day is sync-loop behavior; batching
  rapid successive changes would multiply through every per-commit cost.
  Needs its own latency-vs-cost design; do not fold in here.
- Bundle retention (candidates in recon log) — revisit only if bundle
  bytes ever dominate a measurement again.
- Refset `SIDECAR_THRESHOLD` (4,000) revisit after B lands: with deltas,
  the threshold's purpose (avoid sidecars for small workspaces) may invert.
