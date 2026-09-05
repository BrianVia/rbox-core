# 296 — Admit only SHA-1 Git object format before capture

Status: implemented and aligned after three review rounds. This is an
admission-only slice; it adds no wire, manifest, cache, state, or conversion
mechanism.

## Owner and smallest primitive

`src/cli/sync-git/preflight.ts:gitPreflight` remains the sole owner of repository
shape admission. A sibling `gitObjectFormat(repoDir)` query reuses the existing
`gitRefStorage` authority pattern: run
`git config --local --get extensions.objectFormat`; exit 1 means the key is
authoritatively absent and therefore Git's default `sha1`, while any other
failure means unreadable evidence and throws. The only admitted values are an
absent key and explicit `sha1`. `sha256` and any unknown configured value are
unsupported.

`gitPreflight` performs this query immediately after ref-storage admission. An
unreadable query returns the existing non-structural retry result with
`repository object-format config could not be read — retry after Git
configuration is readable`. A non-SHA-1 result returns the existing structural
refusal shape with `SHA-256 object format is unsupported — rbox syncs SHA-1
repositories only (convert or exclude this repository)`. No adapter gains a
second admission path or error channel.

`RepoCaptureAttempt.classify` lets a forced `FingerprintHitProbeResult` stand in
for `gitPreflight`; that fast path is kept. It is safe because the fingerprint
already stat-tokens `.git/config`, so converting a repository invalidates its
record, and because `GIT_FINGERPRINT_SCHEMA_VERSION` is bumped 9 → 10 so every
record written before object-format admission misses once and is re-probed by
the new preflight. No cache field or record shape changes. This bump also
discharges G3b's carry/invalidation duty: the cached probe already carries
`preflightOk`/`preflightStructural`, and the config token plus schema version
are the dependency evidence G3b asked for.

## Protected semantics and state handling

- Ordinary and explicit-SHA-1 repositories continue through every existing
  preflight check and capture path unchanged.
- Probe failure never implies SHA-1. No layout, OID width, command capability,
  or bundle behavior substitutes for local Git config authority.
- Ref-storage refusal remains first. Object-format refusal occurs before later
  capture work, so no bundle, stash, encryption, or upload can begin.
- The existing receiver follow path also calls the shared preflight owner before
  preparing/importing artifacts or mutating refs. A non-SHA-1 receiver is
  intentionally deferred through its existing `unsupported` structural result;
  its BASE/PENDING and local Git state remain untouched. Clean materialization
  into an absent target is unaffected because there is no existing repository
  format to admit.
- `RepoCaptureAttempt.classify` keeps its existing structural policy. With a
  BASE and no PENDING, refusal emits `structural-refusal` with `removed: true`
  and `repoAbsent: true`; the publication projection drops the section, while
  the local repo record/base remains available for recovery and is not deleted.
  With PENDING, refusal defers and carries that pending section. Repairing the
  repository to SHA-1 makes a fresh preflight eligible without a state
  migration.
- Existing commands, structural-refusal presentation, safety checks, cache
  records, crash recovery, wire compatibility and the forced cache-hit fast
  path are preserved. One-time cost of the schema bump: every repo re-runs the
  cheap preflight/probe on first classification after upgrade (no capture).
  Old clients remain unchanged and may attempt SHA-256 capture.

No functionality or compatibility path is approved for deletion. There are no
safe deletion candidates in this slice.

## Gates

Focused real-repository tests cover default SHA-1, explicit SHA-1, SHA-256,
unknown values, and unreadable config (skipped when root prevents a meaningful
permission test). The SHA-256 fixture observes Git subprocesses and proves that
no `bundle` or `stash` command follows refusal. The capture-boundary case
(a repository converted after it was synced) is covered by the existing
fingerprint `.git/config` stat token plus the schema bump: a converted or
pre-admission record cannot hit, so classification reaches the new preflight
and the existing structural-drop path (`RepoCaptureAttempt` structural tests).

The receiver gate is the same `gitPreflight` call and result asserted by the
focused tests; source-order inspection in `apply.ts` verifies it precedes
`prepareFollowerBranchProtocol`, artifact import, and ref mutation. Existing
follow structural-refusal coverage remains the mutation/state differential
gate; the full sync-git suite is run before commit.

Acceptance is:

```sh
bun test src/cli/sync-git/preflight.test.ts src/cli/sync-git/repo-capture-attempt.test.ts
bun run typecheck
bun run lint:affected
```

The focused test is the differential/compatibility gate. No durable write or
external effect is added, so crash injection is unchanged. The new query adds
one small Git config read on preflight; forced cache hits keep skipping it.
The repository rig remains the integration gate required by the development
flow.

## Challenged and deferred requirements

Automatic conversion is rejected because it mutates user repository identity
and storage. Inferring format from a failed probe is rejected because it fails
open. Adding a manifest format field or cache schema is unnecessary for early
refusal. G3b's cache carry/invalidation is discharged here by the existing
config stat token and the schema bump; G7 remains responsible for actual
SHA-256 transport and receiver support.

Rollback is a source revert. It requires no state deletion, migration, protocol
rollback, or cleanup because this slice writes no new durable data.

## Implemented validation

The focused acceptance passed with **4 pass, 0 fail, 14 assertions**. Root, API,
and scripts typecheck passed. `lint:affected` inspected four changed TypeScript
files and exited 0 with no warnings. The full `src/cli/sync-git` suite passed
with **1,423 pass, 8 skip, 0 fail, 12,128 assertions**.

`bun run rig doctor` passed every required host/API check. `bun run rig run all`
could not start scenarios because its global dangling-image sweep tried to
delete an old rig-labelled image still referenced by four unrelated stopped
`ux-rg-*` containers. Those containers were left untouched; this is an
environmental integration-gate block, not a product or test failure.
