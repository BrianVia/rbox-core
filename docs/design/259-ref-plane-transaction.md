# 259 — RefPlaneTransaction owns follow's prepared mutation

Status: implemented after founder tie-break approved round-3 Option 1 (architecture loop task #40)

Round 3 found one scoped lifecycle/aliasing defect rather than structural
divergence. The approved correction burns publication authority synchronously
before observation or mutation can await, retains a private structured clone of
the publication proof, and returns a detached readonly copy. Concurrent reuse,
retry after a thrown publication, and caller mutation of boundary-proof inputs
are therefore fail-closed without changing the transaction shape below.

## 0. Yardstick

`follow.ts` becomes a short receive/check-out orchestration over one
operation-scoped `RefPlaneTransaction`. The transaction owns the receiver ref
snapshot used as every expected-old value, the prepared checkout branch
transition and its exact inverse, ref reservations, the checkout journal value,
  and the committed/published proof receipt. Checkout classification remains in
`follow-classify.ts`; ref-plane observation is a private read-only leaf and the
transaction must not become a second policy authority.

Baseline at `3aacab56a`: `follow.ts` is 1,210 nonblank lines / 63,679 bytes;
`publishRefPlane` spans 496 nonblank lines and `followDivergedRepo` 598. The
checked-in ratchet is stale at 1,183 / 61,997. The result is re-measured and the
pin moves downward with headroom; no ceiling may move upward.

## 1. Protected-functionality ledger

| Contract | Owner after the change | Proof |
|---|---|---|
| Strict live-ref and worktree-ownership reads fail closed before mutation | follow orchestration + transaction preparation | protected unreadable/race tests |
| Independent non-checkout safe refs publish before `after-safe-refs`; retries preserve design-LWW and displaced values remain pinned | transaction publication operation, same per-ref order | move audit + crash matrix |
| Branch A/P/K/Z planning, prepared locked second proof, tombstone re-proof, reflog fingerprint, and expected-old Git CAS stay byte/order equivalent | existing branch-transition module invoked by the transaction | branch/follow suites |
| Checkout HEAD/index/op-state mutation occurs only after initial classification and an intent journal containing old bytes, expected new state, reservations, and typed branch inverse | `RefPlaneTransaction.prepareCheckout` and `commit` | protected crash/recovery matrix |
| A failed prepared checkout clears the journal only under the existing `status !== defer || !journalIntact` rule; an intact prepared child remains recovery-owned | transaction commit result handling | crash/recovery tests |
| `after-journal-write`, all engine checkout crash seams, `after-published-flip`, and `before-journal-clear` retain exact relative ordering and propagation | transaction methods delegate the existing callbacks without translation | all `FollowCrashPoint` table cases |
| #696 blocker provenance/reason/detail precedence and raw-message `refPublicationFailureReason` classification survive exactly | classification/projection helpers; raw error classified before bounded rendering | protected blocker tests + direct diff review |
| Manual-resolution authored changes, protected OIDs, snapshot second proof, and stash reflog repair remain exact | follow orchestration + transaction receipt | protected manual-resolution cases |
| Final held reclassification remains observational, including its current best-effort cache write | follow orchestration | protected held-skip tests; no incidental fix |
| Config application, ORIG_HEAD preservation/prune/log, timing buckets, cleanup order, and callbacks retain their present semantics | existing owners called at the same sequence points | full suites + move audit |

No command, output, protocol, persisted/wire shape, migration/readiness path,
safety property, compatibility path, or performance fast path is approved for
deletion. The two protected test files may change only for a necessary Interface
rename; otherwise their byte checksums remain unchanged.

## 2. Module and Interface

### `RefPlaneTransaction`

- **Owns:** one follow attempt's prepared old ref values; independent ref
  publication receipts; checkout ref update lists and exact reservations;
  checkout branch plan, locked proof, reflog fingerprint, and operation-scoped
  custody of its inverse; journal identity/value; intent publication, committed
  update, and published flip. `branch-transition.ts` remains the sole constructor
  authority for `inverseLines`; the transaction persists those exact lines and
  never re-derives them.
- **Must never own:** checkout/ref safety classification, deferral precedence,
  BASE composition, held-attempt policy, state persistence, artifact staging,
  config policy, or journal recovery.
- **Interface:** construct one attempt from `liveBefore` plus immutable attempt
  inputs; `publishIndependentRefs() -> RefPlaneProgress`; and
  `commitCheckout(firstClassification, checkoutInputs) -> FollowResult`. The
  latter is one complete operation: it internally prepares the branch plan and
  reservations, writes the journal, installs both boundary-proof callbacks,
  commits or maps the refusal, updates the intended receipt, flips the journal
  to published, and returns a closed result. There is no caller-supplied second
  proof, public journal/plan getter, or caller assembly of success from mutable
  fields. Private prepared state is consumed immediately by `commitCheckout`.
- **Depth:** replaces the dozen cross-function locals (`refUpdates`,
  `postHeadRefUpdates`, transaction-line arrays, reservations, expected refs,
  branch plan/placement/fingerprint/locked proof, journal and boundary failure)
  with one operation-scoped owner. The inverse is stored once on the prepared
  branch plan and copied by that owner into the journal.

`follow.ts` remains the adapter: validate/stage/read, construct the transaction,
ask it to publish, ask the existing checkout classifier once, ask the
transaction to commit the complete checkout, run the final observation, and
cleanup. Private leaf modules keep files below the hard gate:

| unit | responsibility | projected budget |
|---|---|---:|
| `ref-plane-observation.ts` | immutable ambiguity/hold/tombstone/no-drop policy result | 263 nonblank / 12,954 bytes |
| `ref-plane-publication.ts` | one classified candidate's plan/locked re-proof/effect and closed receipt; no cross-call state | 317 / 16,388 |
| `ref-plane-boundary.ts` | initial checkout-boundary and post-HEAD proof algorithms returning typed proof receipts | 218 / 10,766 |
| `ref-plane-transaction.ts` | operation object, retained progress, checkout preparation, journal custody, commit/refusal/published settlement | 388 / 20,569 |
| `follow.ts` | public exports plus orchestration | 247 / 12,564 |

These leaf functions are private implementation, accept an immutable policy
result, and return closed decisions/receipts; they own no cross-call state and
are not exported by `sync-git.ts`. `follow-classify.ts` remains the sole
checkout classifier. The final held-classification pass has no journal or
checkout capability, but MOVE-FIDELITY preserves its pre-existing converged
equality-witness path through the publication leaf (including a possible A/Z
effect) and its best-effort content-equivalence cache save. Calling it pure or
read-only would be false; changing that compatibility effect is a separate fix.

The transaction is deliberately operation-scoped rather than a reusable global
service. Its receiver snapshot and journal cannot leak across repositories or
attempts.

## 3. Move fidelity and deliberate deltas

1. Freeze protected-test checksums and establish a green baseline.
2. Move ref-plane input gathering into the read-only observation leaf. It emits
   candidates, holds, blockers, tombstone authorization, protected OIDs,
   witness-ready equality dispositions, checkout-reason state, and cache-save
   completion. The transaction passes each mutation candidate with its captured
   old/new value to the publication leaf and alone accumulates receipts.
3. Move checkout preparation locals into transaction fields. Keep every
   expected-old value sourced from the original `liveBefore` snapshot; do not
   re-read merely to populate state.
4. Move journal construction/write and checkout commit result handling into the
   complete transaction method. Persist the branch-transition owner's exact
   `checkoutBranchPlan.inverseLines` in the same journal field before the same
   crash seam. The method itself installs both second-proof closures and owns
   their boundary-failure and locked-proof receipts; `follow.ts` cannot see or
   supply either callback.
5. Leave classification and final held observation as caller orchestration.
6. Delete only the superseded local carrier arrays/closures and the stale giant
   comment. Update CODEMAP ownership. Re-measure and lower the follow.ts pin;
   remove its allowlist entry only if both hard limits pass naturally.

Deliberate implementation deltas are limited to:

- mutable locals become private transaction fields;
- contradictory reservation detection becomes a transaction invariant with
  the same error text;
- return-value assembly reads the transaction's closed receipt rather than
  reconstructing it from loose locals;
- explanatory comments made redundant by the owner are removed or reduced to
  non-expressible ordering constraints.

Each delta is structural: it changes neither branch conditions nor externally
observable success/refusal/recovery behavior. Any additional behavior delta is
out of scope and must be reported rather than folded into this refactor.

## 4. Requirement challenges

| Requirement | Complexity cost | Evidence | Decision |
|---|---|---|---|
| Preserve the pre-journal independent-safe-ref publication window | Requires two mutation phases and crash-idempotent progress | explicit R2-3 adjudication and protected `after-safe-refs` cases | preserve; changing it needs a normative design |
| Preserve final classify-only cache save | An observational pass writes cache state | decomposition note records it as a pre-existing possible defect | preserve; separate fix only |
| Preserve every crash seam name/order | Constrains method boundaries | recovery protocol and protected crash matrix | preserve exactly |
| Keep follow.ts allowlisted if still over either band | Retains debt/ceremony | hard gate is 400 nonblank or 25 KiB | lower pin; delete only if naturally compliant |
| Retain explanatory giant-function comments after ownership is explicit | Hides structure in prose | architecture-loop termination condition | delete redundant prose; keep only safety/order constraints |

No requirement is silently removed.

## 5. Validation

- **Move audit:** map every moved statement range to its new method/leaf and
  enumerate every non-verbatim edit with a preservation argument.
- **Protected tests:** baseline and final SHA-256 plus line counts for
  `follow.test.ts` and `follow-matrix.test.ts`; no deletion or weakening.
- **Crash proof:** run the protected table covering every `FollowCrashPoint`,
  plus engine journal/checkout recovery tests in the required full suites.
- **Differential/compatibility:** existing protected matrices pin result shapes,
  Git refs, HEAD/index/op-state bytes, journal phases, inverse rollback, typed
  blockers, and manual-resolution receipts. No persisted or wire format changes.
- **Performance:** no additional live-ref, worktree-ownership, reachability,
  reflog, config, journal, cache, or state reads; timing wrappers remain around
  the same effects.
- **Required gates (exit code recorded):** `bun test src/cli/sync-git
  src/engine/git`; `bun run typecheck`; module-size tests and no upward re-pin;
  direct full-file oxlint for `follow.ts` and every new module with zero
  warnings; `bun run lint:affected`; `bun scripts/rig/rig.ts run
  git-entanglement` (direct fallback if sg Docker fails).
- **Review:** exactly three adversarial rounds, at least one executing code and
  tests. If round 3 has a structural disagreement, stop and present 2–4
  tie-break options; do not self-certify.

## 6. Safe deletion and ceremony kill

Safe after equivalence proof: loose local transaction carriers and orchestration
that merely rebuilds their relationships; the stale comment claiming no real
refactor exists; the old follow.ts ratchet measurement. The follow.ts allowlist
reason is deleted only if the file clears both hard limits, otherwise rewritten
and re-pinned downward to the measured cohesive residual.

`docs/CODEMAP.md` gains the transaction owner and narrows follow.ts in the same
change. Nothing else is approved for feature retirement or dead-code deletion.
### Statement-range move audit

Line ranges are baseline `3aacab56a` and are rechecked immediately before the
move. `F` means verbatim apart from imports/indentation; `M` means mechanical
local-to-field/input access; `D` is an approved deliberate structural delta.

| Old range/block | Destination | Kind | Fidelity constraint |
|---|---|---|---|
| `118–367` effective refs through fixed-point no-drop/cache save | observation leaf | M | same read/callback/timing/evaluation order; same classify-only cache save |
| `369–459` equality, reconstructed absence, manual-absent proof | observation + transaction publication dispatch | M | manual-absent catch remains local and reason/detail pair stays atomic |
| `460–578` per-ref publication | publication leaf invoked by transaction | M | same sorted order, prepare/re-proof/commit sequence and per-ref catch scope |
| `580–612` config/blocker/progress projection | transaction receipt assembly | M | `runConfig` stays after ref loop; blocker order unchanged |
| `615–758` validation/stage/live/publish/classify | `follow.ts` orchestration | F/M | `after-safe-refs` position and kill-switch/capability ordering exact |
| `759–943` ORIG_HEAD + checkout plan/reservations/journal intent | transaction private preparation/write | M/D | loose carriers become fields; branch inverse copied verbatim from prepared plan |
| `945–1104` boundary failure + main second proof | boundary leaf called inside transaction closure | M | closure not exposed; callback/read/classify/order exact |
| `1105–1135` post-HEAD second proof | boundary leaf called inside transaction closure | M | same strict/owned/HEAD parallel read and false-vs-failure behavior |
| `1139–1167` commit refusal/intended update/published flip | transaction complete commit | M | cleanup predicate and reason mapping byte-equivalent |
| `1168–1232` ORIG_HEAD settle/final observation/cleanup | `follow.ts` orchestration | F/M | same prune/log/final callback and outer `finally` |

No catch boundary may widen or narrow. Specifically, the manual-absent catch,
per-ref publication catch, ORIG_HEAD preservation catch, staging catch, strict
ownership wrapper, and ordinary commit refusal mapping remain distinct. Every
timing wrapper continues to wrap exactly the same effect; optional callbacks
retain their relative order. Any additional call/evaluation/catch delta stops
implementation for review.

### Crash-seam table

| Seam | Exact required position/propagation |
|---|---|
| `after-safe-refs` | after every independent ref effect, `runConfig`, and progress projection; before kill switch and capability probe |
| `after-journal-write` | immediately after durable intent write returns; before entering engine `commitCheckout` |
| engine seams `after-connectivity-proof` through `mid-op-state` | same callback passed directly to engine commit; the new owner neither catches nor translates injected crashes |
| `after-published-flip` | after published marker and manual-resolution stash reflog repair; before ORIG_HEAD prune/log, final held observation, and return |
| `before-journal-clear` | remains exclusively in published-journal recovery in `follow-journal.ts`; the transaction neither duplicates nor relocates it |

`FollowCrashInjectedError` escapes unchanged at every seam. Ordinary non-commit
cleanup remains exactly `result.status !== "defer" || !result.journalIntact`.

### #696 executable invariants

- A logical-BASE mismatch becomes `local-commits` before publication in normal
  and read-only final-observation paths.
- Ownership, ambiguity, forced, and indeterminate holds keep current precedence.
- A publication catch passes the raw unbounded message once through the sole
  `refPublicationFailureReason`; `boundedRefFailure` affects rendered detail
  only.
- Reason and detail are assigned together only when no earlier reason won.
- `checkoutRefReasonFromIndeterminate` continues suppressing the duplicate
  checkout blocker; blocker provenance/order/detail and held-skip eligibility
  remain shape compatible.
- Protected cases at `follow.test.ts` cover receiver-only BASE mismatch,
  post-512-character `lock` classification, prior-reason precedence, and
  indeterminate proof. If any gap is found, add characterization only outside
  the protected files; do not edit or weaken them.
