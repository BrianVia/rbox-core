# 174 quality fix plan (scrutiny + /simplify×4 + antislop, deduped)

All fixes are behavior-preserving unless marked. Design contracts (docs/design/
174-*.md §4) and the 5 INVIOLABLES in SPEC-174-IMPL.md are untouchable — if any
fix below would conflict with them, SKIP it and note why in the report.

## Correctness/wording (from scrutiny)
S1. follow.ts:691-696, 751-759 — indeterminate ownership proofs must emit ONLY
    the `indeterminate` blocker, not co-emit `local-commits`/`local-stash`
    (design §4.1 "never"). Skip-veto behavior is unchanged (indeterminate is
    non-allowlisted either way); update any test asserting the co-emission.

## Reuse (4× confirmed)
R1. Delete BOTH local `canonical()` helpers (held-skip.ts:17-24,
    pending-supersession.ts:75-80); import `canonicalString` from
    `../../engine/e2ee/index.js` (RFC 8785; all fed values are
    string/object/array/bool/null — verify no float reaches it, else keep
    local and say so).
R2. Export `graphEnv` from src/engine/git/reachability.ts (rename
    `literalGraphEnv` usage in pending-supersession.ts:125-128 to import it).
    ONE definition of the proof env.
R3. Export follow.ts's `indexArtifact` with a strict/throwing option; delete
    the copy in pending-supersession.ts:89-102.

## Redundancy (3× confirmed)
D1. Delete `metrics.skippedHeld` (apply.ts:122,244,349,1581) — the format
    token reads `results.skipped` directly (sole producer is the held-skip
    path). Update apply-stats-format.test.ts accordingly. NOTE: keep the
    summary token NAME `skippedHeld=` in the log line (design §4.1 names it);
    only the duplicated state field dies.
D2. Add `const clearAttempt = (rel) => { attempt[rel] = null; }` next to
    setDeferral/clearDeferral (apply.ts:382-396) and use it at all 14 bare
    `attempt[rel] = null` sites. NO semantic change — do NOT fold into
    setDeferral/clearDeferral (the skip path must not clear its own attempt).
D3. Factor `currentPartial(rel)` helper for the duplicated ternary
    (apply.ts:1089,1111), beside currentDeferral (:376).
D4. Destructure `attempt` out instead of the IIFE-delete (apply.ts:1775-1778).
D5. follow.ts:1009,1016 — use `progressWithBlocker` like every sibling site.
D6. `deferResult(progress, reason, detail, provenance?)` helper collapsing the
    9 double-stated detail strings (follow.ts:1025-1196 sites).
D7. Test helper `sidecarSnapshot(record)` for the repeated 4-field
    JSON.stringify in git-sync.test.ts (459-475, 1400-1445, 1606-1622).
D8. Un-export HELD_SKIP_SAFETY_FLOOR_MS (module-private).

## Efficiency (held/pending paths must stay O(fingerprint + digest))
E1. DELETE the discarded `await readAllRefs(ctx.repoDir)` at held-skip.ts:70 —
    fingerprint already content-hashes refs; this is the one subprocess that
    crept onto the promised-cheap path.
E2. apply.ts:1090-1102 — short-circuit on `pend` BEFORE calling
    observeHeldInputs (a stale attempt with no pending section must cost
    nothing).
E3. plan.ts:669-678 — thread the preProbe's already-computed
    fingerprint/preflight/identity into processRepoSlowPath as the existing
    `fastLookup` parameter (FingerprintHitProbeResult-shaped), eliminating the
    duplicated ~5-subprocess round. Follow the existing threading pattern at
    plan.ts:723,751,772.
E4. apply.ts:1760-1792 — batch the attempt-sidecar rebind: accumulate entries
    across the loop, ONE applyStateSavePacket (repos already accepts an
    array) + ONE loadRawState after. Preserve per-entry expectedRepoGen CAS
    semantics exactly; P-settlement CAS chaining above stays per-repo
    (correctness-required). Combine with A1 below.
E5. pending-supersession.ts:160-169 — Promise.all the per-ref
    equalOrFastForward proofs.

## Altitude
A1. Extract the attempt-rebind CAS block (apply.ts:1754-1792 region) into a
    named exported function in held-skip.ts (e.g.
    rebindHeldAttemptsAfterSettlement), matching p-settlement.ts's
    one-function-per-CAS pattern. (Absorbs E4's batching.)
A2. plan.ts:872-894 — replace the hand-mirrored rollback with a
    revertCapture(rel) companion defined NEXT TO the tables it unwinds, so
    commit/revert are two branches of one mechanism (any future capture-path
    bookkeeping field fails loudly, not silently).
A3. Two-line comment at the finalizedOutgoing declaration stating the
    "normalize exactly once, then prove-and-publish that exact object"
    invariant.

## Docs
C1. docs/CODEMAP.md — extend apply.ts and plan.ts entries to name the new
    collaborators (held-skip orchestration + attempt CAS rebind;
    pending-supersession candidate flow).

## Explicitly SKIPPED (do not do)
- Shared fetch-and-project-index helper (3 call sites, differing context;
  soft finding).
- Removing IMPL-174-REPORT.md (committed review artifacts are repo precedent
  from design 175).
- Folding attempt-clear into setDeferral/clearDeferral (would clear the skip
  path's own attempt — behavior change).

## Acceptance
bun run typecheck; bun test src/cli src/engine (0 fail); bun run test:api (or
the vitest configLoader workaround from IMPL-174-REPORT.md). Update
IMPL-174-REPORT.md with a "Quality pass" section listing each fix ID applied/
skipped. Last line of that section exactly: QUALITY-COMPLETE
