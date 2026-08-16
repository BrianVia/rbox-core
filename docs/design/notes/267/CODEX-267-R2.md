# Design 267 r2 review

**Verdict: CHANGES-REQUIRED**

r2 resolves most r1 findings, including the warmed-LRU/`encSha` counterexample, SP-2 preservation, empty-packet compatibility, M2 scope, and withdrawal of M3. Two correctness gaps remain: the elision proof is not bound to the state snapshot accepted by the CAS, and the hash operand is not always the manifest described by `manifestMeta`.

## Findings

### CRITICAL — Elision is not bound to the caller’s loaded state

The predicate is evaluated against the `SyncState` loaded near the start of the pull, but the eventual SQLite CAS is bound to a fresh token sampled only after acquiring the state lock.

`StateSavePacket` carries stream, nonce, sequence, global, and repo transitions—but no caller-observed `stateRevision` or base generation ([sync-state-model.ts:351](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-model.ts:351>)). After locking, the adapter opens the store and samples the current token ([sqlite-state-save.ts:99](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/sqlite-state-save.ts:99>)); it then uses that newly sampled revision/generation as the CAS expectation ([sqlite-state-save.ts:158](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/sqlite-state-save.ts:158>)).

Consequently:

1. Pull A loads revision 10, global sequence `q`, repo generation 4, and proves all sections elidable.
2. Writer B lands a repo/global change before A acquires the state lock.
3. A opens the post-B store. Its transition stage and CAS expectation are built from B’s fresh token.
4. Because A omitted `global`, the global-sequence predicate is disabled ([cas-steps.ts:89](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/cas-steps.ts:89>)).
5. Because A omitted the repo transition, no repo-generation row exists to check ([cas-steps.ts:91](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/cas-steps.ts:91>)).
6. The minimal CAS accepts and increments the live revision.

This also breaks M2: it returns A’s old projection overlaid with the new token’s sequence/revision, while the durable manifest/repository content is B’s. The proposed `returnedState === durableReload` invariant therefore fails under exactly the interleaving §3.3 acknowledges.

The claim that the “next non-elided save” catches the change is not generally true. A later operation may load B’s generation as its ordinary baseline and see no rejection. The state lock serializes mutations, but it does not protect the earlier load→elision-decision interval.

The reset precedent does not authorize this unbound use. Before consuming `acceptedProjection`, that path explicitly re-reads and compares the live lineage tuple while holding the canonical lock ([whole-state-compat.ts:346](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.ts:346>)).

Required revision: bind the elision receipt to the caller-observed authority snapshot—at minimum its nonce and `stateRevision`, and preferably the exact relevant token/generations—and make drift reject into `saveStateSource` recomputation. Add an interleaving test that changes an elided repo and an elided global before lock acquisition, then asserts both recomputation and `returnedState === durableReload`.

### MAJOR — The hash grammar is sound, but r2 hashes the wrong Git representation

`manifestMeta.manifestHash` is soundly defined. It is SHA-256 over the canonical logical, decrypted/folded `Manifest`—not the ciphertext hash and not necessarily the raw `JSON.stringify` byte sequence:

- Snapshot headers use `canonicalManifestHashStreaming(manifest)` ([manifest-delta.ts:340](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/engine/manifest-delta.ts:340>)).
- Delta `resultHash` uses the same function over the target manifest ([manifest-delta.ts:354](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/engine/manifest-delta.ts:354>)).
- Raw heads compute the same canonical hash when constructing metadata ([e2ee-remote.ts:381](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/e2ee-remote.ts:381>)).

The canonicalizer visits every object member, so it binds `encSha`, `comp`, `payloadSha`, `cipherSize`, `size`, `mtimeMs`, and admitted extension fields. A direct execution confirmed that changing each named field changes the hash. The engine hash suite also passed all 18 tests.

Therefore the new check does close the warmed-LRU/`encSha` corruption counterexample: the LRU is irrelevant, and persisted file-row drift makes the self-check fail.

However, the exact expression in r2 is not always comparing the representation described by `manifestMeta`. Durable Git truth is split:

- `manifestMeta.gitRepos` is the remote meta-wire Git layer.
- `state.lastSyncedManifest.gitRepos` is derived from locally applied repo records and can differ because of pending, removal, suppression, or partial application ([sync-state-model.ts:484](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-model.ts:484>)).

The repository already provides the exact reconstruction primitive for this reason: `manifestFromMeta(lastSyncedManifest, meta)` replaces the local projection with the meta-wire Git layer ([sync-state-model.ts:126](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-model.ts:126>). The push integrity check correctly hashes that reconstructed manifest ([push.ts:754](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/push.ts:754>)).

As written, the predicate is conservative rather than unsafe: equality still proves the full objects match, absent a SHA-256 collision. But it becomes permanently false whenever the local Git projection legitimately differs from meta-wire truth, undermining pending/partial-Git elision and misdescribing the check as the exact persisted-base receipt.

Required revision: hash `manifestFromMeta(state.lastSyncedManifest, persistedMeta)` after establishing whole-meta identity. Preserve the warmed-cache corruption fixture with an `encSha`-only file mismatch.

### MAJOR — Degraded/recovery ineligibility still has no defined provenance interface

r2 says elision carries pull provenance and validates that degraded/recovery pulls perform a full save, but the exhaustive predicate in §3.2 contains no normal-pull/degraded/recovery condition. A degraded pull still possesses sequence, `storedBaseIsRemote`, metadata, manifest, and `all`; it can satisfy every listed predicate.

The current `StateSource` has no action-list, scope-identity, degradation, or recovery-provenance field ([sync-state.ts:87](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:87>)). Merely placing the decision in `saveStateSource` does not make those negative controls fail closed.

Required revision: define the proof-bearing input explicitly—preferably an optional pull-owned elision receipt containing the unfiltered result, scoped-base identity, eligibility provenance, and caller snapshot binding. It must be absent for paths declared ineligible. Alternatively, explicitly approve degraded/recovery elision and remove the contradictory negative-control claim.

## R1 disposition

- Warmed LRU and `encSha` drift: **answered**, subject to using the correct `manifestFromMeta` operand.
- Unfiltered `all` and rule authority: **answered**. `all` is captured before matcher filtering and already includes rule-authority amendments.
- SP-2 lock/fence behavior: **preserved**. The minimal save still enters `saveThroughStore`, acquires/rechecks the lock, reselects authority, opens under the fence, runs the CAS, and performs the final owner check.
- `stateRevision`: **preserved**; every accepted minimal CAS still increments it ([write-packet.ts:261](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:261>)).
- Legacy JSON housekeeping: **preserved**; carried-record sanitation, nonce minting, revision increment, publication, and marker retirement still execute.
- Empty-packet lineage/reset contract: **preserved** because packet emptiness has no special meaning in `applyStateSavePacket`.
- Repo absence semantics: **correctly characterized**. `applyTransitions` only upserts rows present in its TEMP input; omission does not delete a repository ([cas-steps.ts:185](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/cas-steps.ts:185>)).
- Per-cycle `repoGen` consumers: no consumer was found that requires unchanged records to bump as a heartbeat. The blocker is the removed CAS/recompute guard, not a downstream clock dependency.
- M2 token surface: all six named fields exist on `LineageSnapshot` ([ports.ts:23](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/ports.ts:23>)). The existing helper currently overlays only five, so `lineageExtras` would need adding. More importantly, projection reuse is safe only after the snapshot-binding defect above is closed.
- M3/#747: **fully answered**. The deletion hash is preserved; no artifact-lifecycle deletion is approved.
- Fresh BASE generation retirement: explicitly identified as an observable product trade. No additional hidden consumer was found.

## Validation evidence

I ran:

- `bun test src/engine/manifest-delta.test.ts src/cli/manifest-meta.test.ts`
- A direct field-mutation hash probe over `encSha`, compression, payload hash, cipher size, plaintext size, and mtime.

The engine suite passed 18 tests/159 assertions. The seven manifest-meta tests could not create `/tmp` fixtures because this review environment is read-only (`EROFS`); those were environment failures, not product failures.

No state-plane read-back, CAS guard, compatibility behavior, or artifact hash is approved for deletion until the caller-snapshot binding and projection-race findings are resolved.