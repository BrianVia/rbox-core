# 318 — `src/engine` is the open-source `@rbox/sync` package

Status: implemented (2026-10-01). Owner: `src/engine/`.
Founder decision, 2026-10-01: make the sync engine an open-source library.

## Rule

`src/engine/` is the package. It has its own `package.json` (`@rbox/sync`, Apache-2.0,
`private: true` until first publish), `README.md` and `LICENSE`. Its production files import
only `node:*`, `bun:*`, the declared dependency `ignore`, and files inside `src/engine/`.
`scripts/guards.ts` (`findEngineBoundaryViolations`) enforces that in CI.

The code stays where it is. Moving it to `packages/sync/` would break the crypto-worker
build path and CI test discovery (`review1-gpt.md` finding 7) for no gain to a consumer.

## What moved out

Product code that had no business in a sync library:

- `detect.ts` became `src/cli/detect.ts` (project detection for `rbox hydrate`).
- `doctor.ts` became `src/cli/host-readiness.ts` (host tool readiness for `rbox hydrate`).
- `pat-token.ts` became `src/cli/pat-token.ts` (the `rbox_pat_` API key format).

`src/json.ts` moved into the engine as `src/engine/json.ts`, since engine files use it. All
importers now point there.

## What stays in, on purpose

- **Git manifest support.** `Manifest.gitRepos`, its validators and `tracked-repo.ts` stay.
  They are part of the wire format and the canonical hash, delta decode calls the
  validators internally (finding 5), and `tracked-repo` protects tracked files from ignore
  purges (finding 4). It shells out to git only when a caller passes known repos.
- **`git-spawn.ts`, `git-discover.ts`, `git-device-stamp.ts`.** Self-contained helpers with
  no product imports. Moving them would churn about 45 importers for nothing.

## What is deferred

- **Node support.** Needs the `bun:ffi` bulk walker isolated behind a lazy import and both
  crypto-worker endpoints adapted (finding 6). Bun-only until then.
- **A push/pull orchestration API.** A naive `CommitHead { latest, commit }` interface
  drops signed-commit verification, stale-epoch and missing-blob recovery, and the
  sidecar/receipt publication order (findings 1–3, 9). Orchestration stays in
  `src/cli/sync/` until a design carries all of that.
- **A normative `FORMAT.md`.** Designs 03, 12, 84 and 114 are the raw material.
- **Publishing.** Needs the `rbox` npm org, then `private` flips to false.

## Validation

- `scripts/guards.test.ts` proves the boundary guard rejects a product import and ignores
  comments and test files. The guard passes on the real tree.
- `scripts/sync-package-smoke.ts` packs the package as npm would, installs the tarball in a
  fresh project, and runs `scripts/sync-package-example.ts`. It scans, reconciles and
  applies a directory through `LocalBlobStore`, and round-trips encryption with a wrong-key
  rejection.
- No wire, hash or behavior change. Typecheck, lint, guards and the full test suite pass.
