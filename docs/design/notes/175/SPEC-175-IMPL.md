# SPEC — design 175 implementation (Linux git-ref side-channel)

Authoritative contract: `docs/design/175-git-ref-sidechannel.md` (ALIGNED v4).
It is decision-complete — implement it EXACTLY; do not invent policy, do not
"simplify" a contract sentence. Where this spec and the design differ, the
design wins. This is critical engine/daemon plumbing: correctness and the
invariants outrank speed.

## INVIOLABLE (violation = hard failure)

1. Ref/lock/structure/candidate signals NEVER enter `pendingEvents`,
   `onRawEvent`, the manifest, or upload (design invariant 1).
2. Scanner/manifest `.git` exclusion untouched (invariant 2). `isGitRefSignal`
   main-path behavior byte-identical on every platform (invariant 3/6).
3. `process.platform === "linux"` gates BOTH registry construction and floor
   eligibility; zero side-channel handles on darwin (invariant 6).
4. Every contract sentence in the design's Registry / Floor / Reftable /
   Telemetry sections is implemented as written (epoch pump, generation
   dirtiness, close fence, dir-backed-only floor formula, config-authority
   reftable + `GIT_FINGERPRINT_SCHEMA_VERSION` bump, provenance snapshot
   boundaries, `onGitBusyDeferred` episode semantics).

## Unit order (sequential; each unit ends with its tests green)

U1 — Classifier + debouncer payload: shared exported tail table;
`classifyRefEvent(role, tail)`; repo-candidate lifecycle classes (exact
`.git` segment, create/update/delete); `SignalDebouncer.push(reason,
candidate?)` with bounded per-owner `{dirty, discover}` map + atomic flush
snapshot. Equivalence test vs `isGitRefSignal` on the non-lock subset.

U2 — `src/cli/daemon/git-ref-watch.ts` registry: roles/ownership graph,
generations + forced dirtiness, epoch-serialized reconcile pump with
completeness-bit snapshots, realpath+containment check, admission walk +
budgets, backoff (1s ×2 cap 60s ±20% jitter, single earliest timer,
fake-clock tests), reader-death latch, close fence (incl. late-result test).

U3 — Sync seams: `SyncDeps.onGitReposDiscovered` (awaited, both discovery
sites incl. genesis, additive upserts) + `SyncDeps.onGitBusyDeferred`;
`packed-refs.lock` into `gitBusy` + fingerprint; reftable config-authority
helper in `gitPreflight` + registry pre-attach; `GIT_FINGERPRINT_SCHEMA_VERSION`
bump; seeded-old-cache regression test.

U4 — Daemon wiring: registry lifecycle, arm-then-push handshake (real
`planGitSections` push), `gitSafetyFloorRequired` (dir-backed only) with
imperative `pinSafetyFloor()` on every enumerated false→true transition site,
`requestPush(reason)` conversion of ALL direct `want.push` sites, provenance
snapshot at dequeue + terminal-success recording, busy-retry episodes
(+2s/+8s absolute).

U5 — Telemetry cross-surface: client `git_capture {signalPushes,
candidatePushes, scanPushes}` accumulator + queue; `apps/api` contract mirror
+ normalization + AE layout + ingest test; drift test stays exact-equality
green; one documented admin AE query.

U6 — Gates + docs: CI job `bun-refwatch-contract` (ubuntu, pinned Bun,
source-run probe); compiled probe in linux-x64/linux-arm64 release smoke
legs; darwin leg zero-handle assertion; rig Dockerfile Bun 1.3.5→1.3.14
(+comment fix); rig rounds `small-repo-empty`/`big-repo-empty` tightened to
event-driven; `docs/CODEMAP.md` entry for git-ref-watch.ts; product-level
integration flood test (design test 13).

## Acceptance (run ALL, paste outputs; never report done on red)

- `bun run typecheck`
- `bun test ./src/cli/ ./src/engine/` — all green incl. the design's 14 test
  groups
- `cd apps/api && WRANGLER_LOG_PATH=/tmp/w.log bunx vitest run --configLoader runner`
- `bun scripts/probe/bun-refwatch-contract.ts` (still 3/3 + compiled)
- `git diff --check`
- The rig scenario is run by the orchestrator (docker unavailable in your
  sandbox) — do NOT mark it done; list it as pending-orchestrator.

## Out of scope / DO NOT TOUCH

capture/bundle/encrypt/upload/apply/purge internals; identity gating;
manifest scan semantics; macOS behavior; chokidar side-channel; reftable
fingerprint support (refusal only); designs 173/174; D1 migrations; no new
dependencies. No design docs — implement from THIS spec + the design.
