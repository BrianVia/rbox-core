Verdict: CHANGES-REQUIRED

1. HIGH — Stripping at the current seam breaks preflight/422 reupload recovery.

The projection is created at [push.ts:747](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:747), but both preflight residue at [push.ts:749](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:749) and server 422 handling at [push.ts:942](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:942) pass that projected `committed` manifest into `reuploadOutcome`. It becomes `localForRetry` at [push.ts:183](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:183) and replaces `state.local` at [push.ts:374](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:374).

On retry, changed files absent from `baseEnc` enter `toEncrypt` at [sync-recovery.ts:157](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-recovery.ts:157). Their newly populated encryption-cache entry invokes `classifyCacheHit` at [sync-recovery.ts:235](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-recovery.ts:235), or the pipeline equivalent at [pipeline.ts:263](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/publish-pipeline/pipeline.ts:263). That check requires `stat.mtimeMs === file.mtimeMs` at [shared.ts:51](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/publish-pipeline/shared.ts:51). A stripped entry always fails and is deferred. `deferManifest` can then restore the old base entry or omit a new file, followed by the post-deferral no-op exit at [push.ts:753](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:753).

The recovery action must retain the pre-projection local candidate, while the wire target is projected independently. Add explicit preflight-residue and server-422 tests.

2. HIGH — Mixed-fleet convergence is not “one transitional delta per peer/stream.”

An old writer’s current `stampManifestSchemaForCommit` preserves entries verbatim at [push.ts:48](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:48). Pull persists the received manifest at [pull.ts:414](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/pull.ts:414), while successful pushes persist exactly their emitted `committed` shape at [push.ts:1046](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:1046).

Therefore:

- New writer strips mtimes.
- Old writer pulls that manifest, then republishes local mtimes on its next real change.
- New writer pulls those mtimes, then strips them on its next real change.

This repeats for the duration of version skew—and indefinitely for a node using the proposed restore switch. The design needs either rollout gating/qualification, a normalization strategy that does not let old writers reintroduce the ping-pong, or accurate risk language and skew tests.

3. HIGH — Test #6 and the first-deployment acceptance criterion contradict delta semantics.

Only the target is projected at [push.ts:747](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:747). The historical base is reconstructed unchanged and checked against its old hash at [push.ts:785](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:785). Because `fileEntryEqual` compares `mtimeMs` at [manifest-delta.ts:267](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/manifest-delta.ts:267), an old base containing mtimes and a stripped target produce one `set` for every mtime-bearing entry—not `ops=1` when one content change accompanies the scan.

The boot test must first assert the expected N-op transition, consume it, then assert that a subsequent stripped-base one-file change produces one op. Likewise, the first restart after deploying the new build cannot satisfy `ops≈0` unless that stream already received a stripped commit.

Test #5 also cannot normally observe an `mde delta ops=0` line: a candidate differing only in mtimes exits through the mtime-blind no-op before the writer at [push.ts:652](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:652).

4. MED — The daemon does not retain local mtimes after an advancing push.

`pushManifest` returns the projected `committed` manifest at [push.ts:1088](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:1088). The daemon installs that manifest wholesale at [daemon.ts:1911](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:1911). Consequently, all untouched entries lose mtimes until a watcher patch or full scan recreates them.

Design 202’s trusted-pull path can then expose that mtime-less in-memory view at [daemon.ts:2166](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:2166), and `patchManifestFromPull` carries untouched entries through at [manifest-update.ts:103](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/manifest-update.ts:103).

I found no pull-reconcile correctness failure from this alone, but it directly falsifies “the in-memory/scan manifest KEEPS local mtimes” and contributes to finding 1. Either preserve the local manifest returned to daemon callers or explicitly document and test the mtime-less local state.

5. LOW — The design mischaracterizes the design-204 memo.

The memo at [push.ts:790](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:790) is keyed by the applied sequence and base metadata, then hashes only `reconstructedBase` at [push.ts:797](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/push.ts:797). The stripped target hash is not memoized there.

This is coherent during transition: the old base validates against its old hash, while the encoder independently hashes the stripped target. Revise the risk language.

6. LOW — Update the `FileEntry` contract documentation.

Making `mtimeMs` optional does not broadly break constructors or typing, but [types.ts:4](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/types.ts:4) currently implies it is always carried. Document it as optional local-plane metadata deliberately absent from committed manifests.

Verified claims

- Transitional folding is coherent. A replacement entry lacking `mtimeMs` is not deeply equal to the old entry, so the no-op guard at [manifest-delta.ts:501](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/manifest-delta.ts:501) does not fire. The replacement reconstructs the stripped target and passes the result hash at [manifest-delta.ts:519](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/manifest-delta.ts:519).
- `canonicalJson` omits `undefined` object members at [manifest-delta.ts:65](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/manifest-delta.ts:65).
- Validation does not require or inspect `mtimeMs`; [manifest-validate.ts:181](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/manifest-validate.ts:181)–215 accepts absent mtimes.
- Projection is before raw, snapshot, and delta encoding. The base-integrity precondition is not broken merely because the historical base is unstripped and the target is stripped.
- Trusted fast-fold metadata remains hash-consistent.
- Consumer sweep found no app, dashboard, admin, export, doctor, versions, or rig consumer. The only semantic production reader is `classifyCacheHit`; rig comparison explicitly drops mtimes at [manifest-check.ts:24](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/scripts/rig/lib/manifest-check.ts:24).

Validation: 108 focused tests passed, 1 skipped, across manifest delta, sync, and publish-pipeline suites.