# 176 — Wedge UX: `keep-mine`, legible deferrals, and the held-skip eligibility defect

Status: v5 — §4 allowlist amendment (rig-forced: local-index is structural to the wedge) UNDER FOCUSED REVIEW; v4 was ALIGNED 2026-07-21
Relates: 174 (livelock self-heal; this ships its manual escape hatch),
130 (publisher-ack composition — the arm keep-mine lands through),
128 (show-me/take-theirs token flow — the scaffolding keep-mine completes),
173 (two-writer divergence — still reserved; 176 does not touch it)

## 0. Founder mandate (2026-07-21, direct)

Not an algorithm redesign. A LOCAL manual fix is acceptable for the live
savvy-core wedge — the product requirement is LEGIBILITY: "git language is
verbose in a way that's not readable… our log messages aren't always easily
grokkable." Three deliverables:

- **A. `keep-mine`** — the missing resolve verb: "my local git state is the
  truth; publish it and drop the stale pending section."
- **B. Plain-English deferral surfacing** — a user can understand WHY a repo
  is held and WHAT to do, without reading git plumbing.
- **C. Held-skip eligibility defect** — field-observed on the idle Mac:
  `skippedHeld=0` on every pull of a held repo overnight. Root-cause and fix.

## 1. Live evidence

- The Mac's savvy-core wedge (174 §1) persists post-1.7.15: pulls 43–44s,
  `git-apply ~31s`, `skippedHeld=0` across an idle night. `show-me` output:
  28 local-only reflog commits across rewritten PR branches + the rbox-minted
  2026-07-16 stash. v6 supersession correctly refuses (non-FF branch lane).
- `keep-mine` is already a parsed verb returning
  `{status:"unsupported", code:"not-yet-supported"}` (git-cmd.ts:64,150,536),
  with `--force-discard-incoming` reserved for it in the usage text.
- The founder's first instincts under the wedge — "can I reset to
  origin/main?", "should I delete the workspace?" — are the UX bug in vivo:
  nothing surfaced told him the repo was fine and rbox's bookkeeping was the
  stuck part.

## 2. A — `keep-mine`

### Semantics
For a repo with a pending (unapplied incoming) section and/or apply deferral:
confirm an INTENT to publish CURRENT LOCAL git state as the new remote truth.
The intent is executed only by the next ordinary push. Confirmation's ONLY
mutation is creating/replacing the `RESOLUTION-INTENT` sidecar itself; all
USER-VISIBLE refs, index, stash, worktrees, BASE, P, and every OTHER
pre-existing sidecar remain untouched until that push is accepted (the sole
pre-ACK exception: durable idempotent rbox-internal preservation pin refs,
per Non-goals) — belief changes land only in
the accepted-ACK transition 174-B already uses. [r2: 1]

### Mechanism
1. **Inspect, preview, then record intent**: `rbox git resolve <repo>
   keep-mine` inspects the repo and prints the plain summary plus a
   **PRELIMINARY discard preview**, best-effort from pending versus LIVE state
   and labeled "final report is confirmed at publish time." The confirmation
   token binds refs/reflogs, HEAD, index, op-state, stash, oracle receipt,
   canonical config plus its read/ownership disposition, effective ref scope
   and capture policy, repo kind and identity, `stream`, `stateNonce`,
   `repoGen`, and the pending section's `gitIncomingKey(P)` (the section key,
   not the repo map key) — the full show-me binding set PLUS these, never
   replacing it. [r2: 2]
   Those inputs are recomputed immediately before the intent write.
   `--confirm <token>` (with `--force-discard-incoming` when the preliminary
   report contains a non-subsumed lane) writes a token-bound, single-use
   `RESOLUTION-INTENT` sidecar on the RepoRecord, lineage-bound like every 130
   sidecar. It changes no BASE, pending, ref, partial, attempt, or deferral.
   Any bound-input change voids the intent with a plain snapshot-mismatch
   message rather than performing a differently reasoned action.
2. **The next push executes the intent**: intent presence makes the pending
   arm enter capture unconditionally; the pre-probe still refuses a busy repo
   or non-terminal journal recovery per 174. With the FINAL normalized
   candidate in hand, push computes a new directional per-lane discard report
   from pending to candidate. The report is a small typed predicate built on
   `equalOrFastForward` and exact-equality helpers; 174 v6's boolean is not
   reused as a report. CLOSED lane list [r2: 3]: branches =
   pending-to-candidate equal-or-descendant; tags = exact; stash = exact;
   HEAD = exact; ref scope = exact; index presence/content = exact
   directional; complete op-state map = exact directional; canonical config =
   exact directional. Tombstone fields are EXCLUDED from the report because
   the normalizer carries them from P (174-I3) — they are never discarded.
   Each lane is `subsumed`, `not-subsumed`, or `indeterminate`; a
   pending-absent lane is vacuous; indeterminate evidence refuses. Rendering
   may bound detail without dropping the force decision.
   Only lanes recorded by the confirmed intent are exempted from the
   supersession refusal. Every discarded incoming oid reachable locally
   receives take-theirs-grade preservation pins. The 174-I3 tombstone
   retention rule treats P as a normalizer retention source and carries the
   pending section's tombstone chains and generation.
3. **Publish, then clear**: publication proceeds through the ordinary push.
   Only its accepted ACK performs 174-B's ordered clears of pending, partial,
   attempt, predecessor-bound apply deferral, and `RESOLUTION-INTENT`. Every
   capture, upload, HTTP, conflict, state-save, crash, or daemon-stop failure
   before accepted ACK leaves the intent and P intact.
4. **BASE stays on existing authority**: keep-mine never routes BASE through
   manual authority and never invents A/P artifacts. The committed section
   folds through the existing publisher-ack composer arm. At intent time it
   refuses, with a plain explanation, the branch presence/absence shape that
   arm cannot express — a pending branch absent locally that BASE holds
   present — and the reserved-173 non-FF-divergent remote. It does not clear
   either shape.
5. **No locked-proof claim**: keep-mine makes no locked ref assertions. The
   push pipeline's existing brackets are the concurrency boundary; the
   intent token is the staleness guard. Other fail-closed refusals remain
   plain and typed: an in-progress Git operation, degraded mutex, or a
   worktree-ownership hold on the current checkout ref states the reason and
   retry condition in one sentence.

### Eligibility
keep-mine requires a REAL pending section. An apply-deferral-only record
with no P is a typed `no-incoming` refusal with plain copy ("nothing is
waiting to apply here — this hold clears on its own or names a different
fix"). [r2: 4, option b — the simpler arm]

### Non-goals
- No USER-VISIBLE ref mutation, no working-file mutation, no stash mutation.
  rbox-internal keep/pin refs (`refs/rbox-local/keep/*`) ARE created — the
  take-theirs-grade preservation pins — and must be durably written,
  fail-closed, BEFORE publication can commit; a failed publication may leave
  harmless over-protective pins while intent and P remain byte-intact.
  [r2: 5]
- No change to automatic supersession (174-B) or its lanes.
- Not a fleet-wide force: exactly one repo per invocation, token-confirmed.
- 173 (two-writer spurious divergence) stays reserved.
- A divergent branch that is the current checked-out branch remains subject
  to the checkout plane and is refused for 173/manual Git; the field wedge is
  on stale side branches.

## 3. B — Legible deferral surfacing

1. **`rbox status` gets a separate, plain-English companion line.** The
   shared `git deferred` line keeps its exact current byte shape for daemon
   logs and doctor's fail-closed privacy redaction. Human status rendering adds a
   reason-templated companion line only (including the `--git` surface,
   without duplicating its existing guidance); JSON does not change. It says
   the repo is healthy and only rbox's bookkeeping is paused, then presents
   the two verbs: `keep-mine` means "publish my work" and `take-theirs` means
   "discard my local changes and follow incoming." The named fix for keeping
   work is `rbox git resolve <repo> keep-mine`.
2. **show-me output rewrite**: lead with a three-line summary (what happened,
   what is safe, what to do) BEFORE the per-ref detail; per-ref lines get
   human phrasing ("branch X was rewritten locally after the snapshot" not
   "local-only heads/X reflog:"). The detail stays (it is the evidence), the
   summary is the interface. Replace the current "keep-mine is unavailable"
   copy with the same explicit two-verb choice and the named `keep-mine`
   publish-my-work command.
3. **Log-language pass** (bounded): the ~12 highest-frequency git-sync glog
   lines get the same treatment without changing any frozen grammar, not
   merely a prefix. A human clause may use only fields that the grammar's
   consumers already ignore, or a new status-only line; parsed segments are
   never reshaped. Current consumers are explicitly pinned: follow and
   follow-matrix exact assertions, git-sync scheduling/concurrency parsers,
   sync-cmd routing, status parsers, doctor redaction, shared rig fixtures,
   git-held-livelock, git-commit-propagation, git-shapes, daemon-control
   deferral collapse (its snapshot suite pins the shared line), and
   git-entanglement. [r2: 7]

## 4. C — Held-skip eligibility defect (field: skippedHeld=0 on idle Mac)

The field topology records the held repo's own composer-pending disposition
as a merged blocker when its composition is pending. That synthetic blocker
sits outside the `{local-commits, local-stash}` classification allowlist and
prevents the skip even when the repo's own classification blockers are all
allowlisted. This affects that proven field shape, not every pending held
repo.

Neutralize only a blocker with `provenance:"composer"` when the disposition
is pending, the repo's own classification blockers are all allowlisted, AND
the predicate inspects `composedFollow.holds` plus `checkoutComplete`: every
typed composer hold must map ref-for-ref to an allowlisted causal classifier
blocker; any unmatched hold PERSISTS as a blocking typed blocker in the
stored attempt. Never key neutralization on the reason string. [r2: 6] Independent composer failures,
including foreign artifacts and veto gates, remain blocking; a composer
pending disposition without a classification blocker remains ineligible via
the non-empty rule. The rig gains a non-opportunistic assertion: with the
daemon otherwise idle, the second held pull MUST report `skippedHeld>=1`.

### §4 AMENDMENT v5 (rig-forced, 2026-07-21): allowlist admits `local-index`

With the fixture's file plane settled, the rig proved the wedge steady state
carries a THIRD standing blocker: `local-index` — an ahead writer's clean
index projects its own newer HEAD's tree, matching neither the stale base nor
the stale incoming artifact. It is structural to the shape (present on the
live Mac), so `{local-commits, local-stash}` can never fire in the field.
SOUNDNESS: unlike the working tree (never fingerprinted → `local-edits`
stays excluded), the index file IS inside the attempt's gitFingerprint
bracket — any index mutation voids the attempt and forces a full follow.
The allowlist becomes `{local-commits, local-stash, local-index}`; every
other rule (merged non-empty set, composer hold mapping, floor, canary)
unchanged. The rig's non-opportunistic assertion now exercises exactly this
triple. 174 §4.1's allowlist is superseded by this amendment.

## 5. Tests (MUST)

1. Intent lifecycle end-to-end on the 174 rig wedge shape: confirmation
   writes a lineage- and token-bound intent while P and every OTHER
   pre-existing sidecar stay byte-identical;
   config-only, scope-only, pending-key, and other bound-input races void it;
   accepted ACK alone consumes it and clears pending/partial/attempt/deferral;
   follower convergence and resolving-host refs/index/stash identity remain
   unchanged.
2. A pre-ACK failure table covers capture, upload, 422, 409, state-save,
   process crash, and daemon stop; every case leaves intent, P, and every
   OTHER pre-existing sidecar byte-identical (only idempotent rbox-internal
   preservation pins may exist), and retry can publish normally. [r2: 1,5]
3. Refused shapes and pre-probe refusals: BASE-present/pending-present/local-
   absent branch, reserved-173 non-FF-divergent remote, journal non-terminal,
   git-busy, in-progress operation, and contested checkout ref each produce a
   typed plain-English refusal and clear nothing; an apply-deferral-only
   record with no P produces the typed `no-incoming` refusal, writes no
   intent, and its deferral lifecycle is unchanged. [r2: 4]
4. The rig wedge fixture proves directional report correctness for every
   lane, including one-sided absence and indeterminate evidence; force is
   required exactly for authorized non-subsumed lanes. Preservation tests
   prove pins for every locally reachable discarded incoming oid and carry
   of P's tombstone chains plus generation.
5. Grammar-freeze tests pin every consumer enumerated in §3, the exact shared
   daemon/doctor `git deferred` line and privacy boundary, status-only reason
   templates and two-verb guidance, `--git` deduplication, and JSON non-change.
6. Held-skip covers the provenance-gated composer-pending fix, an allowlisted
   field-shape case, composer-pending vacuity, and independent foreign-
   artifact/veto controls, plus the non-opportunistic rig assertion.
7. Field validation: keep-mine on the LIVE savvy-core wedge (founder
   present) — the dry-run that scripts B's copy.

## 6. Rollout

keep-mine ships enabled (it is explicit-invocation only). C's fix rides the
same release; expected Mac effect once BOTH land: idle pulls skip at ~13s
between safety-floor validations, with one full ~43s re-follow per one-hour
safety floor, and the wedge is resolvable in one confirmed command.
