# Design 163 v6 fold notes

Source rulings: `REVIEW-163-R4-CODE.md`, `REVIEW-163-R4-ROLLOUT.md`, and
`REVIEW-163-R4-CODEX.md`, all read in full before the design was inspected or
edited. Unlike the v5 fold, this one is **not** additive: v5's own status line
was false, four reviewer claims did not survive re-verification, and the
rollout section was replaced rather than extended.

## Verification discipline

Every finding was re-checked against `src/` before folding, per the standing
rule that this corpus punishes folding unverified reviewer claims (design 200
round 11 falsified six claims by running code). Three parallel opus
verification passes covered the code-claims lens, the codex critical/reset
inventory claims, and the rollout claims. Results that changed the fold:

| Claim | Outcome |
|---|---|
| CODE B4 "expiry 90d checks out" in `manifest-validate.ts` | **refuted as located** — that file carries count bounds only; three separate client-side 90-day constants carry age |
| CODE 6 "`reset-quarantine.ts` parses no journal bytes today" | **premise inverted** — it imports `reset-journal` and `boundedRead`s raw bytes at the 2 GiB cap before delegating; the underlying "consumer list is incomplete" point stands (five modules, not two) |
| CODEX 4 "`reset-journal.ts:435` places creation inside the inventoried directories" | **refuted as stated** — those lines only compute paths; no inventory mechanism exists there. Also four temp producers, not two |
| ROLLOUT H3 churn figures for `daemon.ts` / `sync.ts` | **refuted as framed** — both are now 10- and 16-line re-export barrels; that churn is the decomposition. Re-measured: 1,019 commits/60 days is correct, and the genuinely hot rewritten file is `sync-git/apply.ts` |
| CODE B1 citation `push.ts:623` | **corrected** — different consumer (capture policy); the fourth authorization site `push.ts:894` was missed by the review |
| CODE B3 "every state reader deliberately strips" | **corrected** — one production call site (`loadRawState`), which suffices because every disk read funnels through it |

Verification also surfaced two findings no reviewer made: the latent
`localeCompare` vs code-unit comparator mismatch between `reset-state.ts:304`
and `reset-journal.ts:170`, and a real temp leak in quarantine's
`publishCommitRecord` (`finally` closes the handle but never removes the temp).
Both are recorded in the design and assigned to U4.

## What changed

| Area | Change |
|---|---|
| Status line + new top-of-doc questions | v6, honest provenance; v5's "strictly additive / every v4 closure normative" claim retracted; four open questions raised, including the backend-first sequencing decision |
| C4 inventory | lineage-archive provenance predicate given a SQLite-era definition and an owner; complete `.rbox/state/**` consumer sweep table (`adopt-cache.ts` is the highest-risk row); frozen temp grammars; committed-quarantine cleanup authority reconciled with "permanently inert"; quarantine bundles named as the fourth durable tree |
| Schema | `RepoRecord` mapping rebased on the current interface (`packedRefsIdentity`, `attempt`, `resolutionReceipt` added as typed columns); `resolutionIntent` given a strip-before-digest disposition that satisfies M4 without resurrecting it; a schema rebase gate added so it cannot drift again |
| Migration | write-side `Q` barrier made a hard pre-U0 gate with an M0 quiescence/capability predicate and a degraded-writer fixture; supported abort procedure specified; the fixed backup moved and made structurally non-restorable; downgrade floor named; supported migratable envelope defined; M6 cleanup set enumerated literally |
| v4 amendments in place | the "rebuilds a revision-correct pair" paragraph, the `exact halted M0–M7` crash-table cell, the halt-clearing paragraph, and the "intent durable at revision `r`" phrase |
| Rollout | replaced: `B0` barrier unit, U2a–U2f with per-unit exits, wire-visible differential as U2's exit, genesis-path checkpoint, prerelease-channel dependency, named ship/no-ship criterion, disk and duration budgets, `bun:sqlite` contract suite and Bun 1.3.14 floor, halt copy requirement, branch merge process with a port-forward ledger |
| New sections | "Rejected and deferred alternatives" (five codex alternatives argued, two adopted, one pre-authorized, one rejected with its cost priced, one escalated); "R4 ratification round review log" |

## Keystone

Unchanged: the reset file-swap boundary, the closed byte-exact O/N witness, the
standing-journal no-open and W2-before-decode rule, the single Q authority
flip, terminal-control-last ordering, and 2.0-only implementation confinement.
V6 adds no authority source, repair allowance, unknown-name wildcard, or
mutation permission for any halted row. The one new normative *restriction* is
that migration cannot begin on a degraded fence, with a pending quarantine
bundle, or on a workspace whose last writer predates the barrier floor.

## Validation

Doc-only change. `bun run typecheck` passes in the worktree (exit 0);
`git diff --check` clean. No implementation tests were run because no code
changed.
