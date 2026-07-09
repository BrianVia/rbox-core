# 92 - Manifest entry integrity: poison-proof push, quarantine pull, self-healing metadata

Status: Design accepted 2026-07-09 from the field-verified FM/Mac fresh-join
incident. Client-only and wire-compatible. All four parts in section 3 ship as
one correctness change.

Origin: an append-hot 120MB log changed between scan metadata capture and the
encryption read. One internally inconsistent manifest entry then blocked every
fresh join, survived stable rescans, and was resurrected by a device that never
had the file.

Related: design 79 introduced the decompression size cap; designs 82 and 85
cover adjacent cache and scan work. This design owns the scan-to-encrypt
boundary, per-file pull quarantine, metadata healing, and file carry-forward
hygiene.

## 1. Incident and evidence

All incident facts below were field-verified on 2026-07-09.

1. FM scanned
   `Dfinitiv/savvy-core/migration-state/p9-mirror-exec.log` at 120,632,126
   bytes. The append-hot file grew by 3,266 bytes before encryption read it.
   The encrypted snapshot was therefore 120,635,392 bytes.
2. The committed tuple combined the scan-time size with the later snapshot:
   `size = 120632126`, while both the plaintext SHA and encrypted blob described
   the post-append 120,635,392-byte image. The code permits exactly that split:
   `encryptFileToTemp` computes snapshot SHA and size together
   (`src/engine/crypto.ts:179-181`), but both sync-recovery encryption sites
   copy back only the fresh SHA (`src/cli/sync-recovery.ts:213-228` and
   `:281-294`). Nothing compares the snapshot with the scanned `{sha256,size}`.
3. Every fresh join failed at 99% with
   `decompressed plaintext exceeds declared size (120635392 > 120632126)`.
   `apply.ts` passes `entry.size` as the plaintext cap
   (`src/engine/apply.ts:205-219`), and the decompression counter throws at
   `src/engine/crypto.ts:78-88` before plaintext SHA verification at `:309-310`.
   The SHA would have passed because it described those same post-append bytes.
4. One file failure rejected the whole bounded apply pool
   (`src/engine/apply.ts:125-136`; `src/engine/pool.ts:7-16`). Already-renamed
   files remained on disk, but pull never reached its state save
   (`src/cli/sync.ts:285-335`). The rethrown error carried no relative path, and
   the top-level CLI printed only its message (`src/cli/index.ts:13-21`).
5. Two fresh full joins reproduced the same 99% failure. Existing devices did
   not read the blob because they already held content with the matching SHA, so
   they appeared healthy.
6. A stable rescan could not repair the entry. Push comparison delegates to
   `sameContent`, which compares SHA, type, link target, and mode but not size
   (`src/engine/diff.ts:15-47`). Same SHA plus corrected size was therefore a
   no-op at the push gate (`src/cli/sync.ts:535-540`).
7. FM truncated the file and produced a healed sequence 653 entry with size 0.
   The Mac lacked the file on disk. Its pull did not fully apply, and the next
   push carried the older poisoned entry into sequence 654. D1 showed both 653
   and 654 authored by the Mac device identity. The failure was therefore not
   just sticky metadata: an unapplied pull plus stale carry-forward could move
   the head backward for one path.
8. The field remediation that worked was a real content change. Its new SHA
   escaped both SHA-keyed ciphertext reuse and size-blind equality, so a
   consistent successor entry reached the head. That was the only available
   path that stale carry-forward could not resurrect.
9. Within roughly one hour of the first remediation, the same failure recurred
   at 40 times the scale. The Mac's failed pull had moved a live 5.3GB migration
   log aside to a conflict name before verifying the incoming entry. The writer
   held its file descriptor across the rename, so the conflict copy became the
   append-hot file and continued growing at roughly 1.5MB/s. This is direct
   evidence that pull-side move-aside-before-verify damages live user state, not
   merely that it leaves a failed download behind.
10. Backlog pushes then committed that conflict copy with another stale-size
    tuple. FM observed declared size 5,205,792,143 while recovered plaintext had
    already reached 5,205,803,008 bytes, re-deadlocking the fleet. Poison at head
    plus design 91's head-gated push is therefore a proven repeatable
    fleet-wide write deadlock, not a one-off.
11. Adding the log to `.rboxignore` could not deliver the cure. Forward-only
    ignore froze the poisoned entry at head, while the `.rboxignore` change rode
    in the same manifest that blocked un-updated pullers: they could receive
    neither the poison nor the rule that ignored it. Per-entry quarantine breaks
    that cycle because the ignore file can apply while the bad entry remains
    pending.
12. The second remediation moved the live log out of the workspace (the rename
    preserved the writer's open descriptor), removed the ignore, pushed the
    deletion, and then restored the ignore. That follows the CLI's existing
    delete-first guidance (`src/cli/ignore-cmd.ts:31-32`).

## 2. Root cause

Four independent safety gaps composed into the incident.

1. **The producer authenticated bytes but not the manifest tuple.** Encryption
   snapshots the live file and makes its SHA and ciphertext internally
   consistent, but it does not require that snapshot to equal the scan result.
   The caller is allowed to combine fresh snapshot SHA with stale scan size.
2. **The consumer's integrity boundary was pull-wide.** GCM, zstd, size, and
   plaintext-SHA failures correctly reject a file, but the rejection escapes
   `poolMap`, aborts unrelated entries, omits the path, and prevents state
   advancement for work already applied.
3. **Push equality ignored repairable metadata.** A corrected size with the
   same SHA was invisible to `diffManifests`, so no successor manifest healed
   the head.
4. **Carry-forward had no per-file applied/pending split.** Pull state was
   effectively all-or-nothing. After a partial apply failure, later push paths
   could consult an older whole-manifest base and carry its entry, even when a
   newer remote entry had already been observed. That is the sequence-654
   resurrection path.

## 3. Design - poison-proof push, quarantine pull, self-healing metadata

### 3.1 Invariants

- **I1 - one immutable image defines every new entry.** For every newly
  encrypted file, committed `sha256` and `size` equal the SHA and byte count of
  the same immutable encryption snapshot. The cipher descriptor describes that
  snapshot too.
- **I2 - churn defers; it never patches.** If the encryption snapshot differs
  from the scan's expected tuple, that path is deferred. A previously synced
  path carries its coherent base entry; a never-synced path is omitted. The
  implementation never adopts snapshot size or SHA into a mismatched scan entry.
- **I3 - integrity remains fail-closed per file.** A remote file is published
  locally only after GCM, zstd, declared-size, and plaintext-SHA verification.
  Quarantine narrows failure scope; it does not bypass or downgrade a check.
- **I4 - verification precedes target mutation.** Co-located staging for a
  target completes every integrity check before that target, its conflict copy,
  or a required ancestor obstruction moves. The shallowest-first ancestor
  pre-pass remains serial; entries that need it stage first, and quarantine
  suppresses their eviction and every dependent prefix delete. Local and
  systemic failures such as `ENOSPC` and `EACCES` remain pull-fatal.
- **I5 - sequence, applied base, and pending truth are distinct.** A pull may
  advance the verified remote sequence after quarantining a file, but that
  path's applied base advances only after the exact remote tuple verifies. The
  newest remote entry is an immutable pending snapshot until verification, a
  successful local-successor commit, or a newer remote deletion resolves it.
- **I6 - pending precedence is three-way.** At a pending path, unchanged local
  state carries pending truth outbound; changed local state, including a true
  deletion, wins outbound while pending truth remains the effective base. Thus
  pending cannot invent a fresh-join deletion or regress to an older base, but a
  real local edit or deletion is the explicit escape hatch. Every retry bypasses
  ordinary reconcile equality and verifies the remote tuple end to end.
- **I7 - size is push metadata, not reconcile identity.** Same SHA with a
  different size is commit-worthy on push. Reconcile remains byte-identity
  based so a device already holding correct bytes does not manufacture a false
  content conflict.

### 3.2 A - Push-side encrypt-time verify and defer

Extend `EncryptFileOptions` with an optional sync expectation:

```ts
expected?: { sha256: string; size: number }
```

It stays optional for non-manifest encryption callers. The sync-local injected
encrypt function type in `sync-recovery.ts` must accept the same options.

Both file-sync encryption calls pass the scanned entry's exact
`{sha256,size}`. Immediately after `copyFile` has completed and snapshot SHA and
size are known (`src/engine/crypto.ts:179-181`), `encryptFileToTemp` compares
both fields. Size detects append/truncate races; SHA detects same-size rewrites
and the remaining precheck-to-copy window.

A mismatch removes the snapshot and other temps through the existing cleanup
path and throws an error with stable code `RBOX_SOURCE_CHANGED`. The two catches
in `encryptAndUpload` recognize the code, not `instanceof`, because crypto
workers serialize and rehydrate codes (`src/engine/crypto-worker.ts:29-43`;
`src/engine/crypto-pool.ts:158-168`). Both encryption sites defer that file:

1. initial changed-file encryption (`src/cli/sync-recovery.ts:189-228`); and
2. upload-time re-encryption for a missing/retried ciphertext
   (`src/cli/sync-recovery.ts:269-300`).

The existing cheap `lstat` gate remains an optimization before expensive
crypto. It requires a regular file whose size and mtime still equal the scan.
`ENOENT`, type change, or metadata mismatch means defer. In particular,
`classifyCacheHit` changes mismatch/non-file from `"encrypt"` to `"defer"`
(`src/cli/sync-recovery.ts:108-119`). A cache miss still reaches the
authoritative snapshot tuple check.

On success, the returned snapshot SHA equals the expected SHA by construction;
the caller may assert that fact but must not rewrite entry metadata. On defer,
the existing `deferManifest` rule retains the old coherent entry or omits a new
one. Cipher-address cache ownership for the deferred path is pruned by the
existing cleanup path. No cache hit may turn a detected source change back into
encryption.

### 3.3 B - Pull-side per-entry quarantine and pending remote state

Introduce `BlobIntegrityError`, carrying:

```ts
code: "RBOX_BLOB_INTEGRITY"
kind: "size" | "plaintext_sha" | "gcm" | "zstd"
```

The four kinds cover the decompressed-size cap/exact declared-size check,
plaintext SHA mismatch, AES-GCM framing/authentication failure, and zstd
framing/decompression failure. Those errors are created at their crypto stage;
the whole decrypt pipeline must not blanket-wrap errors, because local output
errors must retain codes such as `ENOSPC` and `EACCES`. Blob fetch/network
errors also remain pull-fatal.

Crypto workers currently rehydrate every worker exception as generic `Error`.
The worker protocol therefore preserves `kind`, and the parent rehydration
boundary reconstructs `BlobIntegrityError` from `RBOX_BLOB_INTEGRITY`. The
apply layer may then catch the typed class without relying on worker-side
prototype identity. `RBOX_SOURCE_CHANGED` remains code-matched as specified in
section 3.2.

The existing cap runs only in the compressed branch. To make declared size an
entry invariant rather than a compression side effect, staging also verifies
the exact recovered byte count for raw and compressed files. Compressed output
keeps the streaming upper bound before disk growth; the final exact check also
detects short output. A mismatch is `BlobIntegrityError(kind = "size")`.

Isolation exists only at the per-action apply boundary. Inside the `poolMap`
callback (`src/engine/apply.ts:125-136`):

1. stage and verify the entry;
2. on `BlobIntegrityError`, record `{path, entry, error}`, advance progress, and
   continue;
3. rethrow every other error; and
4. publish a verified entry and record its action as applied.

`applyActions` returns an `ApplyResult` with applied actions and quarantined
entries. The catch must not move upward to `pull`, around `poolMap`, or into the
crypto functions; those positions would respectively lose per-entry isolation,
confuse local failures with integrity failures, or weaken verification.

Staging remains at the existing co-located `tmpName` beside the target
(`src/engine/apply.ts:330-334`). Moving it under `.rbox/state` would introduce an
`EXDEV` risk without strengthening the boundary. For each write/conflict action
the target-scoped order becomes:

```text
stage beside target -> verify exact tuple -> final target precondition ->
move conflicting local target if required -> atomic rename into place
```

The existing ancestor-obstruction pre-pass remains serial and
shallowest-first before the write pool (`src/engine/apply.ts:78-101`); its
serialization prevents sibling writes from racing the same obstruction. Make
it quarantine-aware only where needed: entries whose ancestors require
eviction are staged and verified first, serially, before the ancestor moves.
An entry that quarantines does not trigger eviction. All other entries retain
the pre-pass and then enter the bounded pool. Temporary staged data is removed
on quarantine or fatal exit.

Reconcile/apply also treats prefix-related actions as one transactional group.
If a write quarantines, every delete above or below that path is suppressed for
this pull and retried as pending-adjacent work on the next pull. This covers both
required type-flip shapes: remote `foo/child` disappears while poisoned file
`foo` arrives, so the child delete must not run; and local/base file `foo` is
replaced by poisoned `foo/child`, so deletion of `foo` must not run. Shared
manifest validation additionally rejects file/descendant prefix collisions,
including case-folded collisions, extending the existing duplicate-path checks
at `src/engine/manifest-validate.ts:56-70`.

Conflict-copy publication uses exclusive-create/no-replace semantics rather
than the current access-then-rename probe (`src/engine/apply.ts:311-327`). The
final-precondition-to-rename window remains: an editor can save over the target
after the check and before publish (`src/engine/apply.ts:163-182`). That is a
pre-existing limitation and a follow-up, not a syscall-level no-replace publish
change in this design.

For every quarantine, print one loud path-bearing warning, for example:

```text
rbox: quarantined remote file Dfinitiv/.../p9-mirror-exec.log: decompressed
plaintext exceeds declared size (120635392 > 120632126); local path unchanged;
retrying next pull
```

After the pool finishes, pull continues through safe deletes, Git apply, cache
save, and state save. Successfully applied paths remain applied; only
quarantined entries and their suppressed prefix-dependent actions remain
pending. A foreground `pull` or `sync` with one or more quarantines prints a
warning summary and exits with code 3 (`partial`), distinct from success and
fatal failure. The daemon consumes the same partial result as non-fatal and
keeps syncing.

Add local-only `filePendingRemote` beside `gitPendingRemote` in `SyncState`
(`src/cli/config.ts:87-117`):

```ts
filePendingRemote?: Record<string, {
  entry: FileEntry;
  error: { code: "RBOX_BLOB_INTEGRITY"; kind: string; message: string };
}>;
```

Pull state transition for remote sequence `R` is:

- save `lastSyncedSequence = R` after the partial-success pull;
- for applied paths, advance the per-path base to `R`;
- for each quarantined path, retain its prior applied base entry (or absence)
  and set `filePendingRemote[path]` to the newest remote entry and diagnostic;
- deep-clone and freeze that entry at record time so later in-place mutation by
  `encryptAndUpload` cannot alias the pending snapshot;
- retry every still-present pending entry on the next pull by skipping
  reconcile's `sameContent(local, remote)` short-circuit
  (`src/engine/reconcile.ts:58-66`) and staging and verifying the exact remote
  tuple end to end; and
- if a later remote manifest omits the path, remote absence supersedes pending:
  clear the record and reconcile the deletion normally.

Retry keeps ordinary three-way conflict semantics if local changed meanwhile:
the local version is kept as a conflict copy and is never silently overwritten.
Metadata equality can never advance the applied base at a pending path; actual
verification is mandatory, including when restored correct bytes sit behind a
poisoned SHA/size tuple. Pending clears only after the remote entry verifies and
publishes, a changed local successor commits successfully, or the newest remote
deletes it. The persisted diagnostic is bounded to the newest entry per path;
repeated failures update it rather than append history.

A pending path that is also ignored is never scanned. It therefore remains
frozen-but-quarantined rather than gaining a false local-deletion interpretation;
join still succeeds, with a warning that names the pending count/path. The user
resolution is the existing `rbox ignore` workflow: delete first, let the
deletion sync, then ignore (`src/cli/ignore-cmd.ts:31-32`).

### 3.4 C - Self-healing size metadata comparator

Do not add size to `sameContent`. Reconcile and apply preconditions use that
function (`src/engine/reconcile.ts:58-66`; `src/engine/apply.ts:163-168`) and
must continue to treat equal bytes as equal even when remote metadata is wrong.

Instead, give `diffManifests` a push-specific equality rule: existing
`sameContent(a,b)` plus `a.size === b.size`. All push/no-op, daemon-change,
status, deferred-change, and mass-delete decisions that already use
`diffManifests` then see same-SHA/different-size as changed, without changing
reconcile semantics.

The corrected entry may reuse the existing ciphertext descriptor because
encryption address reuse is keyed by plaintext SHA
(`src/cli/sync-recovery.ts:159-178`). The next upgraded writer that scans the
correct bytes therefore commits corrected size metadata without re-encrypting
or requiring an artificial content edit. A successor head immediately heals
fresh joins from the incident's stale-size tuple; retained historical manifests
remain immutable and may still contain the old entry.

This mechanism heals size metadata only. It does not heal present-but-corrupt
ciphertext for GCM or zstd failures: a correct-plaintext device sees reconcile
byte equality and does not download, while SHA-keyed descriptor reuse keeps it
from re-encrypting. Explicit descriptor repair is future work as stated in
sections 7 and 8.

### 3.5 D - Carry-forward hygiene

An un-applied remote manifest never replaces the ordinary applied base
wholesale. The only un-applied file metadata allowed to affect push is the
explicit, path-scoped `filePendingRemote` entry. For each pending path `P`,
compare `scannedLocal[P]` with `appliedBase[P]` using tuple identity, with two
absences equal:

1. **Local unchanged.** The tuples match, or both are absent. The pending entry
   wins in both `outbound[P]` and `effectiveBase[P]`. This includes a fresh join
   where the path never materialized: applied-base absent plus local absent is
   unchanged, not a deletion.
2. **Local changed.** New content, a type change, or applied-base present plus
   local absent is a real local successor. Local wins `outbound[P]`, while the
   pending entry remains `effectiveBase[P]` so the diff registers the successor.
   A successful commit clears pending. Editing or deleting the file locally is
   the user escape hatch; no tombstone or resolution command is added.

Before every push attempt, derive:

```text
effectiveBase = appliedBase overlaid by newest filePendingRemote entries
outbound[P]   = pending[P] when scannedLocal[P] is unchanged from appliedBase[P]
                scannedLocal[P] otherwise
```

Every file carry source and push decision uses those derived views:
forward-only ignore carry, purge checks, diff/no-op, cipher-descriptor reuse,
`deferManifest`, mass-delete checks, and final commit construction. No path may
fall back to a direct `state.lastSyncedManifest` lookup after the views are
built. Before commit, compare serialized tuples against the selected branch:
pending for unchanged local, scanned local for changed local. Pending entries
are deep-cloned/frozen when recorded because `encryptAndUpload` mutates
`FileEntry` objects in place; reference equality would make this assertion
vacuous.

After an unrelated successful commit, a file analogue of
`gitBaseAfterCommit` saves the committed manifest as the new base for ordinary
paths but restores the old applied-base entry/absence at every pending path.
`filePendingRemote` stays persisted. If unchanged pending is the only
difference, `effectiveBase === outbound` and push is a no-op; if local changed,
the pending effective base makes the successor commit-worthy and successful
commit clears the record.

`saveState` is whole-object replacement, so all three state writers preserve
`filePendingRemote`: the pull save (`src/cli/sync.ts:329-336`), the
git-bookkeeping-only no-op save (`src/cli/sync.ts:549-568`), and the post-commit
save (`src/cli/sync.ts:660-671`). The no-op writer is not exempt merely because
it leaves manifest bytes unchanged.

`PushResult.manifest` is committed outbound truth, not necessarily disk truth.
Where the daemon assigns it to `this.manifest` (`src/cli/daemon.ts:514-535`), it
restores the applied-base entry or absence at every still-pending path, matching
the persisted-state rule. Otherwise the daemon could adopt a quarantined remote
entry as its in-memory local tree and suppress the next repair.

This closes the observed resurrection deterministically. After the Mac sees
sequence 653 but cannot apply its healed size-0 entry, its old applied base may
still contain the poison, but `filePendingRemote[path]` contains the newer
sequence-653 entry. With local unchanged, both effective base and outbound use
that newer entry, so push either no-ops or carries it alongside unrelated work.
With a real local edit or deletion, the local successor wins outbound against
the pending effective base and clears pending after commit. Neither branch can
re-emit the older poison at sequence 654.

## 4. Compatibility

- All changes are client-side. Manifest wire shape, encrypted blob format,
  commit schema, server APIs, and workspace identity are unchanged.
- `filePendingRemote` is local sync state, like `gitPendingRemote`; it never
  leaves the device. Existing state loads with the field absent.
- Coworker onboarding and mixed-client fleets require no coordinated server or
  schema migration. An old client still hard-fails if it directly encounters a
  poisoned entry. Once any upgraded writer with the file commits its corrected
  same-SHA/different-size entry, the latest head is healed for old clients too.
- Updated clients do not bless corrupt bytes: they quarantine the one remote
  entry, continue unrelated work, and retry until a verified entry is available.

## 5. Acceptance gates

### 5.1 Deterministic tests

1. **Poison injection.** Pause after scan, append to the source before
   `encryptFileToTemp` snapshots it, then resume. The entry is deferred with
   `RBOX_SOURCE_CHANGED`; no inconsistent tuple is committed. The next settled
   cycle ships an entry whose declared size and SHA match decrypted bytes. Run
   through the crypto-worker path as well as inline crypto.
2. **Quarantine isolation.** Pull a 100-file manifest with one poisoned entry.
   Exactly 99 files apply, one is quarantined, the warning and persisted record
   contain its relative path, local data/ancestors at that path are unchanged,
   and foreground pull exits 3. The daemon treats the same result as non-fatal.
   The next pull retries that entry. Repeat once with a conflict action and once
   with a file-valued ancestor obstruction.
3. **Error boundary.** GCM, zstd, size, and plaintext-SHA failures quarantine.
   `ENOSPC`, `EACCES`, blob fetch failure, and worker crash remain pull-fatal.
   Cover compressed and raw declared-size mismatches.
4. **Pending three-way precedence.** Cover all three local shapes against a
   pending path: unchanged present carries pending; unchanged fresh-join absence
   carries pending and never emits deletion; changed content/type or a true
   base-present/local-absent deletion wins outbound against pending effective
   base and clears pending only after commit. An unrelated push in the unchanged
   case carries pending, never the stale applied entry.
5. **Retry cannot re-bless.** A pending path whose local tuple compares equal to
   remote still stages and verifies the exact remote entry. Correct bytes behind
   poisoned metadata do not clear pending through `sameContent`; local divergence
   during retry produces a conflict copy, never a silent overwrite.
6. **Type-flip grouping.** With base/local `foo/child`, a poisoned remote file
   `foo` quarantines and the child delete does not run. With base/local file
   `foo`, a poisoned remote `foo/child` quarantines and deletion of `foo` does not
   run. Both retry on the next pull. Validation rejects exact and case-folded
   file/descendant manifest collisions.
7. **Staging order and conflict exclusivity.** A quarantined target causes no
   target, conflict-copy, or required-ancestor move; ancestor pre-stage remains
   serial. Two same-name conflict attempts cannot replace one another.
8. **State-writer preservation.** Exercise pull state-save, post-commit
   state-save, and exactly quarantine -> git-bookkeeping-only no-op save ->
   pending survives. Mutation of an outbound `FileEntry` cannot change the
   frozen pending snapshot, and the serialized-tuple assertion detects drift.
9. **Crash boundaries.** Inject a crash immediately before pull state-save and
   after commit but before post-commit state-save, each with a pending path.
   Recovery neither resurrects the old entry nor loses pending state.
10. **Daemon disk truth.** A push result containing a carried pending entry does
    not install it into the daemon's in-memory manifest; the applied-base
    entry/absence remains at that path. Activity, status, ambient status, shell
    state, init/join output, and the daemon line all expose the pending count.
11. **Activity refresh.** A same-head retry may clear pending without changing
    sequence. Verify that a cached activity count may remain stale only until
    the next ordinary activity refresh, then converges to the persisted count.
12. **Metadata heal.** Base and local have the same SHA but different size. Push
   commits the corrected size, reuses the coherent ciphertext descriptor, and
   reconcile on a device already holding the correct bytes produces no false
   conflict.

### 5.2 Per-host gates

1. **FM producer gate.** On the dev build, run the append-between-scan-and-
   encrypt injection against the real append-hot-file shape. Observe a named
   defer, then settle the file and observe one coherent successor commit.
2. **Mac consumer/carry gate.** Start with the file absent, pull a manifest with
   one poisoned entry among ordinary changes, then push an unrelated local
   change. Ordinary files apply; the warning names the quarantined path; the
   outbound manifest contains the newest pending entry, never the older poison
   or a deletion; the retry clears after a healed remote entry arrives.
3. **Ubuntu fresh-join field gate.** Run the existing full-join stress loop to
   two consecutive clean joins from empty local state against the dev head.
   Both joins must reach 100%, report no quarantine, and match the head manifest.
   This loop found this incident and two other bugs; retain two consecutive
   clean Ubuntu full joins as a standing release gate for sync changes.

The deterministic suite, both fleet-host gates, and the Ubuntu standing gate
must pass before release. A quarantine warning in the Ubuntu gate is a failure,
not an acceptable degraded pass: the gate keys on exit code 3, not stderr text.

## 6. Rollout and observability

1. Ship A-D in one client release; partial rollout is not a correctness claim.
2. Validate FM first, then Mac, then run the serialized Ubuntu fresh-join gate
   so no host mutates the shared dev head during another host's check.
3. Log every quarantine with relative path, integrity kind, remote sequence,
   and retry intent. Summarize the count at pull completion and surface it in
   daemon activity without converting the successful partial pull into a halt.
4. Observe that pending counts fall after a healed writer commit and that no
   path's metadata regresses across successor manifests.

## 7. Risks

1. **Permanently hot sources defer repeatedly.** This is deliberate: stale
   carry or omission is safer than inventing a moving manifest tuple. The loud
   path-level defer points the user toward ignore policy.
2. **A genuinely corrupt remote entry can remain pending.** The client keeps
   syncing other files and warns on every pull; an upgraded authoritative writer
   heals it through section 3.4.
3. **Partial state is more complex than whole-manifest state.** The effective
   base/outbound construction and post-commit base restoration are centralized,
   asserted, and covered by the resurrection test so no individual carry site
   can choose stale state.
4. **Mixed clients retain the old failure mode.** This lasts only until an
   upgraded writer publishes corrected metadata; no wire migration can make an
   old puller quarantine.

## 8. Non-goals

1. The `dl-integrity-retry` transport fix in the separate held PR. Network and
   blob-fetch retry policy are unchanged here.
2. Device-mint-per-track hygiene. The D1 author attribution is evidence for
   this incident, not a reason to broaden this design into device lifecycle.
3. Design 85's general midwrite scan work beyond what section 3.2 needs. This
   design closes the scan-to-encrypt publication boundary; it does not redesign
   incremental discovery or scan architecture.

## 9. Open decisions

None. Two independent design reviews (2026-07-09) were adjudicated into this
revision. The material changes from the first draft: pending precedence became
three-way (a real local edit or deletion beats pending and clears it), pending
retries bypass reconcile equality, type-flip deletes are transactionally
suppressed with their quarantined write, all three `saveState` writers preserve
pending, staging stays co-located with the serial ancestor pre-pass intact, and
the self-heal claim is narrowed to size metadata.

## Appendix A. `diffManifests` caller audit (size-sensitivity)

Making `diffManifests` size-sensitive (section 3.4) was audited against every
caller:

| Caller | Consumes | Size-sensitivity effect |
|---|---|---|
| `src/cli/sync.ts:517` purge preflight | `deleted` only | none — safe |
| `src/cli/sync.ts:536` push no-op gate | full diff | required: this is the heal |
| `src/cli/sync.ts:608` post-defer no-op | full diff | safe — deferred paths carry the selected base |
| `src/cli/sync.ts:620` mass-delete count | `deleted` only | none — but the denominator must use the effective base |
| `src/cli/daemon.ts:787` daemon change counts | `changed` | intentional, correct only while `this.manifest` stays disk truth (section 3.5) |
| `src/cli/status-cmd.ts:305` status counts | `changed` | intentional — a size-only repair should show as a change |
| `src/engine/engine.test.ts:155` | test-only | n/a |

The daemon/status trigger sites run outside `runPushAttempt`'s derived views. A
pending path can read as a spurious change there and trigger an echo push
attempt; the authoritative overlay inside the push then no-ops it. That churn
is accepted as intentionally benign — threading the overlay into every
read-only trigger site would spread pending logic for no correctness gain.
