# Design 245: versioned RboxBar release artifact

## Contract

Every `v*` tag produces a macOS 14+ universal `RboxBar.app`, archives it with
`ditto`, and publishes the immutable object
`releases/v<version>/RboxBar-<version>.zip`. Stable tags additionally update
`releases/RboxBar.zip`; prerelease tags do not.

Protected behavior:

- `bundle.sh` still defaults to the host architecture and version `0.1.0`.
- Ad-hoc signing, the app output path, the CLI smoke matrix, signed manifests,
  installers, changelog flow, and release channel schemas do not change.
- The Ubuntu `publish` job remains the sole R2 writer. Every immutable upload,
  including the app zip, completes before any mutable RboxBar alias update.
- A failed app build or architecture/version assertion fails closed before
  publication.

## Ownership and interfaces

`macos/RboxBar/scripts/bundle.sh` owns app assembly. Its existing no-argument
interface gains two optional environment inputs: `RBOXBAR_VERSION` and
`RBOXBAR_ARCHS=universal`. No new mode exists when the variables are unset.

`.github/workflows/release.yml` owns release orchestration. A secret-free
`rboxbar` build job mirrors the tagged-SHA CI gate, validates the bundle, and
uploads one workflow artifact. The existing `publish` job downloads it and
uses the already-pinned Wrangler release uploader convention. The immutable
zip upload precedes `release.ts --upload-only`; the stable-only alias follows
it. This preserves the invariant that an immutable failure cannot be followed
by mutable publication.

No module ownership changes under the sync-engine trees, so `CODEMAP.md` does
not change. There are no safe deletion candidates in scope.

## Requirement challenges and exclusions

Universal compilation adds release time but is required for one distributable
Mac app and avoids a second architecture-specific channel. Developer ID
signing/notarization, app management through `rbox upgrade`, installer copy,
and app auto-update would each add new trust or lifecycle ownership; they are
explicitly deferred rather than approximated here.

## Validation

- `bash -n` and workflow YAML parsing.
- Static assertions for job dependencies, artifact paths, stable/prerelease
  guards, and immutable-before-mutable ordering.
- A real universal build on `dfinitiv-macbook-pro`, asserting both Mach-O
  architectures and the stamped version, followed by cleanup and a clean
  remote worktree.
- `bun run lint:affected` and final staged-diff review.

Crash/compatibility/performance gates are proportional to this CI-only change:
workflow artifact loss and build failure fail closed; unset environment inputs
exercise compatibility; the real universal build is the performance and
packaging smoke. No supported behavior, migration, fast path, or release
format is approved for deletion or retirement.
