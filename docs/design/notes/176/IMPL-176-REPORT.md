# Design 176 implementation report

## Outcome

Implemented all four units from `SPEC-176-IMPL.md`, using the aligned
`docs/design/176-wedge-ux-keep-mine.md` semantics wherever the dispatch spec
was silent.

### U1 — keep-mine intent and CLI

- Added a lineage-bound, local-only `resolutionIntent` RepoRecord sidecar.
- The confirmation token binds the complete show-me evidence plus stream,
  state nonce, predecessor repo generation, exact pending section key,
  effective scope, capture policy (including incremental mode), repository
  kind/identity, canonical config ownership/read result, refs/reflogs, HEAD,
  index, operation state, stash, and oracle receipt.
- `keep-mine` is now an inspect -> preliminary discard preview -> exact
  confirmation flow. Force is required iff the preliminary report has a
  not-subsumed lane; an unnecessary force flag is also rejected.
- The full binding is recomputed at the intent-write boundary. The binding
  comparison, intent construction, and generation-CAS state packet are
  contiguous.
- Confirmation writes only the intent sidecar. Tests compare the remaining
  record fields plus refs and index before/after.
- Added typed, clear-nothing refusals for no real P, disabled Git sync,
  degraded serialization, nonterminal journal, Git busy/in-progress state,
  contested linked worktree, BASE/P/local-absence, and reserved current-branch
  non-FF divergence. Stale non-current branches remain eligible with force.

### U2 — ordinary-push execution

- Intent-bearing P enters unconditional fresh capture, bypassing automatic
  pending-supersession and removal-memory suppression without changing the
  design-174 automatic lane.
- Push revalidates the complete binding after capture and again after final
  report construction. Degraded mutex and journal states carry exact P and
  leave every sidecar untouched.
- Added the closed directional report: branch ancestry; exact tags, stash,
  HEAD, ref scope, index presence/content, complete operation-state map, and
  canonical config. P-absent lanes are vacuous; indeterminate evidence fails
  closed; tombstones are excluded and retained by normalization.
- Preservation roots include discarded refs/HEAD/stash, normal index trees,
  every unmerged-index stage object, and full OIDs found in all synced
  operation-state artifacts. Reachable roots receive durable idempotent
  `refs/rbox-local/keep/*` pins before publication.
- Only accepted publisher ACK clears P, partial, attempt, predecessor-bound
  apply deferral, and the exact predecessor intent. BASE advances only through
  the existing publisher-ACK composer arm.
- Pre-ACK tests cover journal/degraded/busy capture refusal, failed artifact
  upload, 409 conflict, repeated 422 response, and transport/process-stop
  failure. P, intent, and other sidecars remain byte-identical; conflict-ref
  hygiene is suppressed for intent captures. Retry ACK converges a fresh
  follower while the resolving host's user refs, index, and stash stay exact.
- P tombstone chains and generation are retained through the accepted result.

### U3 — held-skip eligibility

- Composer blockers now carry typed ref/code identity.
- The own composer-pending blocker is neutralized only when every composer
  hold maps ref-for-ref to an allowlisted causal classifier blocker and
  `checkoutComplete` agrees. Unmatched/foreign/veto holds remain persisted
  blockers. No decision keys on the human reason string.
- The `git-held-livelock` rig scenario now stops the daemon, establishes the
  hold with one explicit pull, and requires `skippedHeld >= 1` on the second
  otherwise-idle pull before healing.

### U4 — language and frozen grammars

- Human status and `status --git` add a separate reason-templated companion
  line while the shared `git deferred` line and JSON remain unchanged.
- Guidance offers `keep-mine` only when a real P exists; apply-deferral-only
  state keeps legacy take-theirs guidance and accurately says keep-mine has
  nothing to publish.
- Show-me now leads with what happened / what is safe / what to do, retains
  humanized evidence detail, and routes keep-mine through preview before a
  confirmation token is offered.
- Completed exactly twelve bounded log-language additions as ignored suffixes:
  seven config-skip, two conflict, one removed, one pending-carry, and one
  superseded-pending line. No new daemon record grammar was introduced.
- Added an executable grammar-freeze inventory for every consumer named in
  design section 3, plus the exact twelve-clause count fence, doctor privacy,
  and sync-command routing assertions.

## Ownership and review

- Updated `docs/CODEMAP.md` for the new resolution-intent module and the
  changed plan/apply/push ownership.
- Adversarial implementation review iterated through stale-side-branch scope,
  post-capture binding, read-only journal handling, pre-ACK conflict-ref
  mutation, closed-lane projection, preservation roots, preview ordering,
  linked-worktree refusal, degraded serialization, no-P status guidance, and
  final TOCTOU placement. Final review reported no remaining correctness or
  INVIOLABLE violations.
- `git diff --check` is clean.

## Acceptance evidence

- `bun run typecheck` — passed.
- `bun test src/cli src/engine` — passed: 2,663 passed, 16 skipped, 0 failed;
  31,279 expectations across 219 files.
- Literal `bun run test:api` — could not start because Vite attempted to write
  the shared read-only `node_modules/.vite-temp` path (`EROFS`). This is the
  worktree condition anticipated by the dispatch spec.
- Permitted workaround:
  `cd apps/api && WRANGLER_LOG_PATH=/tmp/rbox-176-wrangler.log bunx vitest run --configLoader runner`
  — passed: 46 files, 781 passed, 4 skipped, 0 failed.
- `bun run typecheck:rig` — passed.
- `bun test scripts/rig --timeout 90000` — passed: 136 passed, 0 failed;
  501 expectations across 21 files.
- `bun run rig run git-held-livelock` — environment-blocked before scenario
  startup: permission denied connecting to `/var/run/docker.sock`. The scenario
  implementation and local rig contract tests are green, but no live Docker
  result is claimed.
- The founder-present live savvy-core dry-run requires access to that external
  fleet/workspace and was not available in this worktree environment. No live
  fleet mutation or deployment was attempted.

IMPL-COMPLETE

## v6 adjustment

- Folded REVIEW-176-R5-CODEX.md's accepted fixes into design 176 §4 and
  advanced the design status to `v6 — r5 folded`.
- Held attempts now bracket the exact persisted classification: the trusted
  fingerprint precedes classification, the matching edge follows every
  classifier/composer input, and any race, incomplete dependency enumeration,
  rejected prior attempt, or standing P/P-repair prepass clears rather than
  preserves an attempt. Successful rbox-authored checkout mutations use a
  final classify-only stable bracket.
- `HeldInputObservation` and `GitHeldAttempt` bind effective BASE and incoming
  projections plus the canonical incoming index artifact descriptor. This
  invalidates idxProj-only repairs and same-plaintext locator/encoding changes.
- Held-only fingerprints include the exact referenced split-index
  `sharedindex.*` dependency with the index hash/stat and racy-clean policy;
  unenumerable dependencies fail open without adding subprocesses to the
  generic zero-spawn divergence cache.
- The allowlist is `{local-commits, local-stash, local-index}`. Composer mapping
  remains limited to the exact ref-plane commit/stash causal pairs; the mixed
  triple, unmatched same-ref code, and `checkoutComplete:false` controls are
  pinned.
- Added classification-to-record index repair, local-index positive skip,
  rejected-attempt early-defer, idxProj-only, same-`indexSha` locator, and
  split-index dependency mutation coverage.

Acceptance evidence:

- `bun run typecheck` — passed.
- `bun test src/cli/sync-git` — passed: 436 passed, 6 skipped, 0 failed;
  4,116 expectations across 24 files.
- `bun test src/cli src/engine` — passed: 2,669 passed, 16 skipped, 0 failed;
  31,301 expectations across 219 files.
- Final adversarial review found and closed stale-attempt preservation on both
  rejected-skip early exits and mandatory P/P-repair prepass exits.

V6-ADJUST-COMPLETE
