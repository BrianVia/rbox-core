# §150 — release pipeline fast path without weakening gates

> **Status: agreed — 2026-07-17.** Reduce healthy release latency while retaining the exact
> tested-tree, native-smoke, signed-bytes, and manifest-last publication
> invariants.

## Problem

A healthy release currently spends roughly five minutes rerunning the source
suite and typechecks serially even though the same commit is tested by the
seven-way `CI` workflow on its push to `main`. The publish job then restores a
large package cache for longer than its subsequent frozen install takes, and
`scripts/release.ts` executes independent R2 transfers serially.

The long gaps observed on 2026-07-16/17 were external GitHub scheduling or
billing incidents, not executable steps in this workflow. This design targets
the repeatable healthy-path work; it does not claim to remove GitHub as a
dependency or replace native macOS/ARM64 smoke runners.

## Invariants

1. A release may build or receive signing secrets only after the exact tagged
   commit has a successful `CI` workflow run whose event is `push` and whose
   head branch is `main`. A PR merge-preview SHA, a different commit with a
   similar tree, and a successful run from another event do not qualify.
2. Absence, failure, cancellation, API ambiguity, or timeout fails closed. A
   direct-to-main release commit therefore waits for and requires its own main
   CI run; it never inherits a PR verdict.
3. Tag, `package.json`, and embedded version consistency remains checked before
   signing. All three compiled binaries remain built once, signed once, passed
   through the GitHub artifact, and smoke-tested on their native target.
4. Publication still verifies the signed manifest before any transfer. No
   immutable put, fetch, or hash failure may reach any mutable alias,
   `install.sh`, `version.json`, or signature operation.
5. Only immutable, version-addressed R2 operations may overlap, and only within
   explicit phases. All work
   in a phase settles before the next phase starts, including when one operation
   fails, so no orphaned subprocess continues into a later safety decision.
6. Existing pending main-checkout protections remain normative in the composed
   result: validate the newest changelog entry and reject a newer live semver
   before any mutation; retain workflow-level publication serialization; upload
   and verify immutable data; update mutable aliases and activation metadata;
   reread the exact live version; publish `changelog.md`; then invoke the home
   deploy hook. This branch must be integrated around those changes rather than
   overwrite or weaken them.

## Exact-SHA CI gate

Add `scripts/wait-for-main-ci.ts`, a small testable GitHub API client invoked in
the release build immediately after checkout and Bun setup, before dependency
installation or the signing step. Grant the workflow `actions: read` in
addition to `contents: read`; pass the ephemeral `github.token`, repository,
tagged SHA through environment variables. Before querying, require a full
40-hex commit SHA and require `git rev-parse HEAD` to equal it.

The client queries completed and active runs of `.github/workflows/ci.yml` for
the exact SHA with `head_sha`, `event=push`, `branch=main`, and `per_page=100`.
It sends GitHub's recommended media type and a pinned REST API version, rejects
an unexpectedly larger result set rather than silently ignoring another page,
and independently filters returned data to `event == push`,
`head_branch == main`, and the exact `head_sha`, rather than relying only on
query parameters. A successful qualifying run returns immediately. A queued or
in-progress qualifying run is polled; every non-`completed` status is treated
as active, including new statuses unknown to the client. If qualifying runs are
terminal with no success, the gate fails with their conclusions; if none
appear, it polls until a bounded timeout and then fails. Transient GitHub
5xx/429 responses may retry within one absolute deadline and honor a bounded
`Retry-After`; authentication and other 4xx responses fail immediately.

This is intentionally SHA-based, not PR-run- or tree-cache-based. The repo's CI
triggers on `push` to `main`, including squash-merge commits and direct release
commits. Requiring that run gives the tagged bytes their own verdict. The
documented release flow changes to push the release commit to `main`, wait for
its CI to pass, and only then push the protected tag; simultaneous main+tag
pushes remain safe but make the release gate wait.

Remove the release job's duplicate `bun test ./src/` and two `tsc` invocations.
Do not remove or alter CI, production-deploy, version-consistency, native-smoke,
signature, or fetch-back gates.

## Publish fast path

Remove the Bun cache from both build and publish. The superset cache is written
under a tag ref, so later tags cannot reuse it; the build spends about 15
seconds uploading roughly 836 MB and publish spends 17–32 seconds restoring it.
Retain the exact frozen all-platform install in both jobs because the builder
and `scripts/release.ts --upload-only` imports must resolve from the lockfile.
Measured cold installs take 13–34 seconds in build, while publish's install
after a cache restore takes 2–3 seconds; avoiding the save/restore pair is the
shorter combined critical path.

Extract the immutable R2 orchestration into a testable helper with a narrow
adapter for `put` and `get`. The production adapter invokes the pinned Wrangler
version, drains stdout and bounded stderr concurrently with process execution,
and never prints fetched artifact bytes. Publication phases are:

1. verify the signed local release artifacts, then apply the pending live
   semver rollback check before any mutation;
2. concurrently upload each immutable versioned binary; wait for every
   transfer to settle successfully;
3. concurrently fetch every immutable versioned binary and verify its SHA-256;
   wait for every verification to settle successfully;
4. only after immutable verification, perform the existing mutable operations
   sequentially in deterministic order: each latest alias, `install.sh`, then
   `version.json`, then `version.json.sig` at the terminal boundary;
5. after integration with the pending safeguards, reread the exact live
   version, publish `changelog.md`, and invoke the home deploy hook.

The helper reports every failed operation with its object key, exit status, and
bounded stderr. It must not stop awaiting sibling processes on the first
rejection; synchronous adapter throws are converted to rejected promises only
after every sibling has been launched, and each phase uses `allSettled`.
Concurrency is bounded by the release's small fixed artifact set rather than a
general unbounded pool.

This change does not claim to make the existing separately stored manifest,
signature, and latest aliases failure-atomic. During an interrupted mutable
update, clients continue to fail closed on signature or SHA mismatch and a
same-version rerun repairs the channel. An atomic release pointer plus API/route
change is a separate design. §150 deliberately keeps concurrency away from
that boundary so it introduces no new mixed-state failure mode.

## Tests and validation

- Unit-test CI-run classification: exact successful main push, PR-only success,
  wrong SHA, direct-main pending then success, terminal failure, no-run timeout,
  and transient versus permanent API errors.
- Unit-test publication phase ordering with a fake adapter: transfers overlap;
  verification waits for all puts; activation waits for all hashes; any put,
  get, or hash failure prevents every mutable operation; sibling work settles
  before return; no concurrent operation crosses into mutable activation.
- Run `bun run typecheck` and the focused new tests plus existing release
  verification/watcher-compiled tests.
- Parse workflow YAML and run `actionlint` if available (otherwise use a pinned
  disposable invocation or record the missing validator).
- Execute a local all-target `--no-upload` release build using the existing
  signing setup if available, never invoking R2 publication.
- Inspect the final diff against the pending primary-checkout release changes
  and record integration conflicts rather than overwriting them.
- Update the release/CI workflow headers, `docs/DEPLOYMENTS.md`, and
  `docs/cicd-release-setup.md` so the exact-SHA gate, three targets, lack of a
  manual approval gate, and recommended main-then-tag ordering are accurate.
