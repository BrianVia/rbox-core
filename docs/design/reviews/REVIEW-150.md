# REVIEW-150 — release pipeline fast path

Adversarial design and implementation review for §150. Acceptance requires
agreement that latency falls without allowing untested, unsmoked, unsigned, or
partially uploaded bytes to become the release channel.

## Round 1

**Gate provenance: PASS with guardrails.** A PR merge-preview SHA never
qualifies. Because `ci.yml` runs on every push to `main`, the squash commit and
every direct release commit receive their own CI run; the release waits for that
exact SHA. The review required independent response filtering, full-SHA/local
HEAD equality, exhaustive result handling, all non-completed statuses treated as
active, pinned API headers, bounded transient retry, and immediate permanent-4xx
failure.

**Publication and simplicity: NEEDS WORK.** The first draft allowed mutable
latest aliases into the concurrent phase, described the existing two-object
activation as safer than it is, removed only the publish cache, and omitted
several canonical documentation updates. A broad atomic-pointer/API redesign
was considered but ruled separate scope because the current clients already
fail closed on mixed state and §150 need not alter that boundary.

**Resolution:** concurrency is now limited to immutable versioned puts and
fetch/hash verification. Every immutable sibling settles before deterministic
sequential aliases, `install.sh`, manifest, and signature. The design explicitly
records the existing non-atomic availability window, makes pending semver and
changelog ordering normative, removes both tag-scoped caches, and names all
documentation updates and test seams.

## Round 2

**Publication: PASS.** Immutable-only concurrency introduces no mixed-state
regression and moves fetch verification before any mutable operation. Required
tests pin sibling settlement, phase ordering, and prevention of all mutable work
after any immutable failure.

**Gate provenance: PASS.** The stricter exact-SHA `main`-push requirement covers
squash merges and direct-to-main commits without trusting PR results or a
path-filtered tree equivalence.

**Simplicity: PASS.** The revised spec removes both tag-scoped caches, requires
the canonical workflow/runbook corrections, keeps a narrow injected adapter,
and avoids a generalized concurrency framework. All design reviewers are
aligned; implementation may proceed against §150.

## Implementation review

**Round 1 — NEEDS WORK.** Gate review found that an absent `Retry-After` header
was parsed as zero and could create a tight retry loop, and that a hung request
could outlive the client's nominal deadline. Publication review found that a
stream failure could reject before the Wrangler child process exited.
Simplicity review found stale setup history and phase-order comments in the
release runbook.

**Resolution.** Missing or malformed `Retry-After` now uses the normal poll
interval, each API request receives an abort signal bounded by the one absolute
deadline, and success after that deadline is rejected. Wrangler exit, output,
and stderr promises now settle together. The release runbook now states current
prerequisites instead of historical secret/artifact status, explicitly includes
the changelog bump, and describes three targets and the actual publish order.

**Round 2 — PASS.** Gate, publication, and simplify/antislop reviewers found no
remaining blocking issue in the rebased diff. The composed implementation
preserves main's changelog validation, pre-mutation semver rollback check,
serialized publication, post-activation exact-version read, changelog upload,
and home deploy hook.

Validation on the rebased branch: 25 focused gate/publication/version/signature
tests, root and API typechecks, script bundling, YAML parsing, pinned
`actionlint`, and a live read-only gate query against the successful current
`origin/main` Actions run. A local three-target signed `--no-upload` build and
native macOS watcher self-test also passed before the final rebase; no R2 write
or deployment was performed.
