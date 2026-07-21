# SPEC-174-IMPL — dispatch contract (core units U1+U2)

Authoritative design: docs/design/174-apply-side-perf-and-held-repo-livelock.md
(ALIGNED v4). Where this spec is silent, the design doc WINS. Review ledger:
REVIEW-174-R1-{CODEX,OPUS,OPUS-B}.md → FOLD-PLAN-174-R1.md → REVIEW-174-R2/R3.

## INVIOLABLES (violating any of these fails the dispatch)

I1. `P` (pending section) and ALL sidecars (partial, deferral, attempt) remain
    byte-for-byte intact through planning, capture, normalization, upload, and
    commit. They clear ONLY in the accepted-commit publisher-ACK state
    transition (push.ts:680-738 path), via ordered sidecar transitions
    (pending absent, partial=null, attempt=null, predecessor-bound deferral
    clear). Every pre-ACK failure (capture/upload/422/commit-error/409)
    carries P byte-for-byte.
I2. The supersession proof subject is the FINAL normalized candidate, never
    the live repo or the pre-probe. Every peel/walk/ancestor subprocess in the
    proof runs with GIT_NO_REPLACE_OBJECTS=1 (plus existing GIT_NO_LAZY_FETCH).
    Lanes: branches same-name FF-or-equal; tags exact; stash/HEAD/refScope/
    indexIdentityV2/opState-map/canonical-config EXACT equality. Any error or
    mismatch → carry P.
I3. Superseding normalization takes validated P.refTombstones +
    P.refTombstoneGeneration as an explicit retention source; high-water =
    max(advertised, P, candidate). Authoring-predecessor semantics stay
    advertised-based.
I4. A's skip eligibility uses the MERGED typed blocker union (classification
    + composer disposition + pre-follow protocol holds), requires
    `blockers.length > 0 && every(allowlisted)` where allowlist =
    {local-commits, local-stash}; A runs strictly AFTER journal recovery,
    protocol/P settlement, and partial revalidation. Attempt record binds all
    inputs listed in design §4.1 (incomingKey, stable fingerprint bracket,
    sorted reflog path/digest set, repo identity, state nonce, BASE/origins
    hash, partial disposition). Fail open on ANY instability or read error.
I5. No new BASE authority arm; no direct BASE writes; branch mutations only
    via the typed transition planner. The B journal gate switches exhaustively
    over JournalRecoveryResult.status with a compile-time never check;
    fresh-quarantined/defer/corruption/human-intervention carry P.

## U1 — typed blocker seam + held-skip (A)

- `FollowResult` gains `blockers: TypedBlocker[]` (closed provenance union);
  apply orchestration merges composer pending (apply.ts:1207-1222) and
  pre-follow protocol holds (apply.ts:948-956) into the recorded set.
- `attempt` sidecar on RepoRecord per design §4.1 (never wire-visible;
  discarded on stateNonce/identity/GIT_FINGERPRINT_VERSION change).
- Reflog digests: exact bytes of logs/refs/stash + every branch reflog the
  boundary proof consults (classification enumerates the list).
- Preflight structurally rejects info/grafts + shallow-adjacent graft files
  → `unsupported`.
- Skip path: refresh deferral episode lastSeen via ordered sidecar-only
  update; bump `skippedHeld` counter into the pull summary git-apply token;
  1h safety floor with fingerprint-miss WARNING canary; floor re-follow with
  same outcome refreshes attempt.at.
- Kill switch: RBOX_GIT_HELD_SKIP=0.

## U2 — pending supersession (B)

- plan.ts pending arm: cheap fingerprint-gated pre-probe (may-supersede) →
  admit to capture pool; P carried in parallel until ACK. git-busy probe →
  carry P + surface capture git-busy observation (arms +2s/+8s retries).
- Proof module (new file next to plan.ts): candidate-vs-P lane proofs per I2.
- Normalizer: P-as-retention-source per I3 (publisher-tombstones.ts).
- push.ts ACK transition: the four ordered clears per I1.
- Kill switch: RBOX_GIT_PENDING_SUPERSEDE=0.

## Out of scope for this dispatch
U3 (C sub-timers + C2 sync_phase telemetry), U4 (D conflict-ref retention),
U5 (F push-tail instrumentation) — separate follow-up dispatch after U1+U2
gates are green. Do NOT touch apps/api, telemetry contracts, scanner,
watcher, or migrations.

## MUST tests (from design §5, this dispatch)
Tests 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15 (numbers refer to design §5).
Test 1's fixture constructs pending via a REAL transition (second-writer
advance or documented crash-recovery path) — NOT the retracted seq-83
narrative.

## Acceptance (all must be green; run from the worktree root)
- bun run typecheck
- bun test src/cli src/engine   (zero failures except the registry-known
  flakes listed in AGENTS.md; rerun those in isolation to prove flake)
- bun run test:api              (may fail in your sandbox on localhost bind —
  if so, note it; the orchestrator reruns natively)

Write IMPL-174-REPORT.md when done: what was built per unit, test results,
deviations (should be NONE without written justification), files touched.
Last line exactly: IMPL-COMPLETE
