# Design 186: Continue file sync across case-only path collisions

**Status:** Revised after adversarial review
**Date:** 2026-07-22

## 1. Problem

A case-sensitive source filesystem can contain both `Lucky Meat.md` and
`Lucky meat.md`. A valid rbox file manifest cannot represent both because that
manifest must materialize safely on case-insensitive filesystems. Today the
case-fold duplicate makes the push fail, so unrelated files stop syncing and a
new user can appear stuck during onboarding.

The desired behavior is partial progress:

- skip every member of the ambiguous file group;
- carry forward any previously synced member so the skip never becomes a
  remote deletion;
- publish every unrelated safe file and safe deletion;
- exit successfully and show an advisory warning;
- let the passive daemon loop detect both the problem and its resolution;
- keep the warning visible in `rbox status` without repeating it every daemon
  tick.

Users do not need to run `rbox sync`. The ordinary watcher-driven daemon push
is the primary flow; manual sync is only another supported caller.

## 2. Scope

This change covers ordinary `manifest.files` entries whose full paths are
distinct strings but equal under the existing wire rule, `path.toLowerCase()`.
Groups may contain two or more files and/or symlinks.

It does not weaken wire validation. Incoming manifests remain atomic and
strictly validated. File/descendant collisions, duplicate identical paths,
`gitRepos` key collisions, and case-equivalent paths inside a captured Git
index remain on their existing fail/defer paths. A Git history cannot be made
safe by silently removing individual tracked files; a future Git-specific
change may defer the whole repository while the ordinary file plane proceeds.

## 3. Invariants

1. `validateManifest` continues to reject case-fold duplicate wire paths.
2. No member of an ambiguous local group is newly published.
3. If the applied base contains a member with the same fold key, that exact
   base entry is carried forward. Different casing must not turn a skip into a
   deletion.
4. All downstream decisions—purge checks, diffing, files-first, mass-delete,
   encryption, upload, and commit—operate on the safe publication candidate.
5. Encryption-cache pruning still sees the raw scanned disk paths.
6. A warning is advisory: successful safe progress exits zero and never creates
   a daemon recovery halt.
7. Warning persistence is local-only and can never make sync fail.
8. Resolution is automatic through watcher activity, with the safety scan as a
   backstop.

## 4. Collision classification and safe projection

Add a pure helper beside the existing manifest validation rules. Given file
entries, it groups paths by `path.toLowerCase()`, returns only groups with more
than one distinct path, and sorts paths and groups deterministically. The helper
and validator therefore cannot drift onto different definitions of
case-equivalence.

The shared local-file projection first performs the same non-purge
forward-ignore carry as push, then produces a safe projection against an
applied base:

- remove every current entry whose fold key is ambiguous;
- carry the exact applied-base entry for that fold key, if one exists;
- leave all unrelated entries unchanged.

Push and scan-based status calculations use this one helper with the same
matcher. Status diffs and tracked-file counts are computed from the safe
projection, never the raw ambiguous manifest. Thus both a base `Foo` plus local
`Foo`/`foo` and the ignore-carry case (raw local `foo`, newly ignored base
`Foo`) are healthy with a warning, not a permanent “1 change pending.” The
projection is pure and read-only; status never changes durable warning state.

Do not use locale-sensitive comparison, filesystem probing, Unicode
normalization, or platform-specific casing. This design intentionally matches
the exact existing cross-platform wire contract.

## 5. Publication candidate

In `src/cli/sync/push.ts`, retain `scannedFilePaths` from the raw candidate, then
perform forward-only ignore carry as today. Immediately after ignore carry and
before purge checks/diffing:

1. classify case-fold duplicate groups in the resulting candidate;
2. remove all candidate entries for each ambiguous fold key;
3. if the applied base contains an entry for that fold key, insert that exact
   base entry once;
4. sort the resulting files.

Ignore carry precedes classification because it can itself expose a collision:
a local `foo` plus a newly ignored base `Foo`. Existing `deferManifest` is not
suitable because it matches exact paths and its result means mid-write churn.

`PushAttemptState` carries three separate values: the safe retry candidate, the
raw scanned file-path set used for encryption-cache pruning, and the collision
observation. A 409 or epoch recovery rescan refreshes all three from disk. A 422
retains all three while replacing only the upload retry candidate. The final
collision groups also ride `PushResult` as typed metadata distinct from
`deferred`. An all-collision change produces a successful no-op rather than an
empty commit.

Classification invokes a non-throwing observation sink immediately, while the
workspace sync mutex is still held and before purge, encryption, network, or
commit work. Consequently a later mass-delete halt, quota error, authentication
failure, or exhausted retry does not lose the warning. Observation persistence
is serialized and ordered; an older writer cannot resurrect state after a newer
clear. Failures inside the advisory sink are reported best-effort and swallowed.

## 6. Durable advisory state

Use a dedicated, local-only sidecar:

`.rbox/state/path-warnings.json`

Version 1 is:

```json
{
  "v": 1,
  "fingerprint": "<sha256>",
  "groupCount": 1,
  "pathCount": 2,
  "collisions": [{ "paths": ["Lucky Meat.md", "Lucky meat.md"] }]
}
```

`groupCount` and `pathCount` describe the complete observation. The fingerprint
hashes all canonical sorted raw groups, before display truncation, and includes
no timestamp. Persistence stores at most 100 groups and at most 8 paths per
stored group, with a 64 KiB encoded ceiling; `groupCount`/`pathCount` let the UI
render omitted counts. Collision exclusion itself is never truncated. The JSON
status field has the exact same typed shape under `pathWarnings`; its warning
count means collision groups, not paths.

The reader is 64 KiB bounded, no-follow, exact-shape validated, and treats
absent/corrupt/unsupported data as unavailable. Writes use atomic replacement
with mode `0600`; clearing is idempotent. Persistence failures are reported
best-effort and never change the sync result. Workspace reset removes the
sidecar.

This does not belong in `state.json`, whose generation-CAS contents are sync
correctness state, or only in `activity.json`, which is daemon-owned and cannot
represent a foreground sync writer safely.

## 7. Passive daemon behavior

The daemon records the collision metadata returned by a push, serializes
sidecar updates, and keeps the active collision paths/fold keys in memory. It
also tracks whether its in-memory manifest is complete raw scan truth or the
safe subset retained after a collision push.

- A new nonempty fingerprint writes the sidecar and logs one bounded,
  terminal-sanitized warning.
- Repeated identical fingerprints are silent.
- A changed nonempty fingerprint writes and logs once.
- Clearing deletes the sidecar and resets the in-memory fingerprint without a
  noisy log.
- The same group reappearing after a clear is a new episode and logs once.

Because `doPush` replaces the daemon's in-memory manifest with the committed
safe subset, a later unlink/rename of a skipped path cannot be handled only as
an incremental patch: the surviving sibling may not be present in that subset.
If a watcher batch intersects an active collision group, the daemon performs a
fresh scan before the next push. Intersection includes an exact/fold match, an
event path that is an ancestor of a collision path, or a directory event whose
subtree relationship can invalidate the retained safe subset. Full/safety scans
are also authoritative. Thus deleting or renaming either member or its parent
directory clears or revises the warning and publishes the surviving safe file
without a manual command.

An unrelated incremental watcher batch applied to a retained safe subset is
not authoritative about the absent collision members. Its push preserves the
prior collision observation and may neither rewrite nor clear the sidecar. Only
a complete full/safety scan, or a collision-intersecting batch that first forces
such a scan, may clear or revise an active episode. This avoids the sequence
`collision A -> unrelated edit -> false clear` without making every unrelated
edit pay for a full-tree scan.

If that incomplete incremental candidate itself discovers any new ambiguous
fold group, the daemon forces a complete scan before pushing. The scan reunites
the preserved groups with the new group and becomes the one authoritative
observation. This covers `A active -> unrelated B/b collision -> A+B visible`;
subsequent events under either group participate in the same intersection and
automatic-resolution rules.

Collision paths do not enter `deferredRetryPaths`; that mechanism means files
still changing and intentionally hot-retries for a bounded period.

## 8. User-facing behavior

Foreground `rbox sync` stops its spinner, reports normal safe progress, then
prints one concise advisory such as:

```text
synced with 1 warning
  skipped case-conflicting paths: Lucky Meat.md, Lucky meat.md
  rename or remove one; background sync will pick it up automatically
```

The exit status remains zero.

`rbox status` reads the sidecar in brief, verbose, and JSON modes. The brief
healthy verdict becomes `synced with 1 warning`; stronger states such as a halt,
active transfer, remote lag, or quota warning retain their precedence and show
the path warning as secondary advisory detail. JSON exposes a typed
`pathWarnings` value. Display and log paths are bounded and terminal-sanitized.

Bare `rbox` already invokes the shared brief status before its menu, so the same
warning appears there without another code path.

Full/verbose status runs its current raw scan through non-purge forward-ignore
carry and then classifies/uses the safe projection for counts. That live
read-only observation takes precedence for the current invocation when the
sidecar is absent or stale; it does not write or clear the sidecar. Brief/bare
status intentionally uses the durable sidecar and may retain a just-resolved
warning until the passive loop observes the repair.

## 9. Production caller contract

Every mutation of the sidecar occurs inside the workspace sync mutex:

- setup/init and foreground push/sync use the authoritative scan made by
  `push()` and render returned collision metadata after their spinner stops;
- the daemon uses its watcher-maintained/full-scan manifest, persists each
  authoritative observation before remote work, transition-dedupes its log,
  and preserves an active observation across unrelated incremental pushes;
- ignore-purge uses its post-rule authoritative candidate and may update or
  clear the warning;
- 409 and epoch rescans are authoritative replacements; 422 retries preserve
  the existing observation;
- chain repair and Git-resolution publications that do not own a fresh complete
  file observation preserve the sidecar and may not clear it.

The push API marks whether its input owns authoritative local-file observation;
callers that cannot prove that property default to preservation. Direct test
callers without a mutex use an injected/no-op observation sink and never mutate
production advisory state.

## 10. Tests

### Pure and push tests

- deterministic two- and three-member grouping;
- file/symlink groups;
- genesis collision plus safe additions;
- previously synced member plus a new case variant;
- base spelling different from current spellings;
- collision exposed by ignore carry;
- safe additions and deletions continue;
- mass-delete accounting excludes collision-carried entries;
- all changes colliding is a warning no-op;
- 409 rescan refreshes groups and 422 preserves them.

### Sidecar and surfaces

- round trip, clear, malformed, oversized, symlink, permissions, and racing
  replacement;
- truncation preserves full counts/fingerprint and bounded JSON size;
- workspace reset removes the sidecar;
- setup/init, foreground push/sync, and ignore-purge update the warning while
  repair/non-authoritative callers preserve it;
- a push that later fails remotely still leaves the observed warning visible;
- foreground sync succeeds and renders once after the spinner;
- brief, verbose, JSON, and bare-front-door status remain advisory and sanitize
  hostile path text.

### Daemon and rig

- watcher-created collision publishes unrelated files automatically;
- repeated daemon ticks do not repeat the warning;
- fingerprint transition `A -> A -> B -> clear -> A` logs on the first, third,
  and fifth states only;
- deleting or renaming one member triggers a fresh scan, clears the warning,
  and publishes the survivor without `rbox sync`;
- deleting or renaming a parent directory also forces the authoritative rescan;
- `collision A -> unrelated edit -> A remains visible and is not logged again`;
- `A active -> create B/b -> full scan records A+B -> resolve B/b automatically`;
- two-machine rig proves the receiver gets safe files while neither ambiguous
  file appears, then receives the survivor after resolution.

The existing Git-index case-collision rig remains a separate Git contract and
must not be reinterpreted as proof of ordinary file-plane behavior.

## 11. Ownership and rollout

No sync-engine module ownership changes are intended. The validator continues
to own path admissibility; push owns publication composition; the daemon owns
passive observation; status owns presentation. No `docs/CODEMAP.md` change is
required unless implementation introduces a new module under its governed
engine trees or changes one of those ownership boundaries.

This is client-only and backward compatible: old clients still reject an
invalid incoming manifest, while new clients stop authoring ordinary file
manifests containing case-fold duplicates.
