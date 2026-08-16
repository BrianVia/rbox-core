# 270 — implementation deviations from the spec

Recorded per review MINOR-7. Each entry: what the spec said, what shipped, why.

## D1 — `held-skip.ts` was decomposed, not re-pinned

Adding the digest pushed `held-skip.ts` past the 400-nonblank-line hard gate
(427). Per the no-ratchet-re-pins rule the fix was decomposition: the blocker
plane — composer→blocker mapping, the eligibility allowlist, the ownership
predicate, blocker sorting, and all three rollout flags — moved to
`held-blockers.ts` (127 lines) with real importer rewires and no pass-through
facade. `held-skip.ts` is 347 lines and now owns only observation, matching, and
the attempt record. Not in the spec; forced by the gate.

## D2 — one bridge re-pin on `sync-state-model.ts` (phase-2 removal expected)

`sync-state-model.ts` was ALREADY inside its 10% ratchet grace before this change
(other lanes grew it from the recorded 446/23328 to ~483/25573). The 2-line
`artifactPlaneDigest` field pushed it 52 bytes over. Re-pinned to the measured
486/25713 with the queued decomposition and pin-restore acceptance written into
the allowlist reason string.

**Phase 2 disposition:** 269's decomposition deletes both the ALLOWED and RATCHET
entries for this file, so the `file-size.test.ts` hunk is to be DROPPED entirely
on the post-269 rebase. This deviation is expected to disappear, not to persist.

## D3 — `GitHeldAttempt` gained a field, and so did the codec coverage ledger

`artifactPlaneDigest?: string` on `GitHeldAttempt`, plus its entry in
`GIT_HELD_ATTEMPT_FIELD_COVERAGE` (`state-plane/codecs/coverage.ts`) — the
coverage guard is compile-time-only and fails the typecheck without it. The
attempt persists as whole-object canonical JSON (`attempt_cjson`), so the field
round-trips; pinned by `held-attempt-state.test.ts`.

This is the digest's storage, explicitly required by §2.3. It is **not** the
`checkoutComplete` widening that §7 D1 closed — that remains unimplemented and
unneeded, exactly as ruled.

## D4 — the composer-fixpoint red-first test is at the decision plane, not e2e

The spec asked for a red-first composer fixpoint through the pull. I probed for a
`follow.test.ts` fixture that naturally mints an *unmapped* composer hold and
could not construct one: every fixture I could build produced either a ref-plane
classification that `causallyMapped` neutralizes, or a pre-composer `defer`. That
is §6-Q3's explicitly out-of-scope question ("why do these repos produce a
composer hold with an EMPTY ref-plane classification at all").

What shipped instead: the red-first control is the kill switch on the same
repository and the same attempt — skips with the flag on, re-follows with it off
(`held-composer-skip.test.ts`, "red-first: a composer missing-branch-proof
fixpoint skips instead of re-following forever"). The e2e differential and
artifact-invalidation cases in `follow.test.ts` run on a ref-plane held fixture
with the digest live. Honest gap: no test drives a composer blocker through
`applyGitSections` end to end.

## D5 — the durable differential normalizes two wall clocks

`attempt.at` and `deferrals.apply.lastSeen` are stamped independently by the two
lanes, so they are normalized out. Every other field the design named — `base`,
`branchBaseOrigins`, `pending`, `partial`, `deferrals`, `idxProj`, and the whole
attempt input set — compares equal after 3 skip cycles versus one re-follow from
the same state. The journal pair is asserted as a no-op via
`publishedJournals === undefined` plus `checkoutJournalPresent === false`.

## D6 — the `pRepaired` fixture uses an empty map, not a synthetic receipt

`partialDisposition` canonicalizes the WHOLE partial, so the presence of the
`pRepaired` member is what moves it; a fabricated 14-field `PRepairReceipt` would
have required a chained type assertion the anti-slop lint rejects. The test
proves the field participates in the disposition, which is the property §2.4
depends on. It does not exercise receipt payload contents.

## D7 — MINOR-2's early-out changes git-spawn counts on refusal paths

Accepted from review: with the flag on, an attempt whose `artifactPlaneDigest` is
absent, or whose `before` fingerprint already has incomplete dependencies, now
refuses WITHOUT a `for-each-ref`. This is a deliberate behavior difference from
the first implementation (which always spawned), pinned both ways: zero plane
reads on the no-digest path, exactly two on the matching path.

## Not deviations — spec/design text corrected rather than followed

- §2.3 lists five namespace prefixes; the work order's prose says "the four rbox
  base/recovery namespaces". Implemented all five per the design body.
- §2.1's phrasing reads as if the digest also avoids widening `GitHeldAttempt`.
  It does not (see D3). Only the `checkoutComplete` guard avoids widening.
- Pin count: 21, not 20 (corrected in the SPEC; commit messages not rewritten).
