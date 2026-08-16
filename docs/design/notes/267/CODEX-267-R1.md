# Adversarial review: design 267

Overall verdict: **CHANGES-REQUIRED**

M1’s central elision proof is not sound against the current fold/cache and reconciliation contracts. M2 is plausible for composer-owned saves, but the design incorrectly assumes every caller possesses a complete accepted projection. M3’s proposed third-hash removal misstates and weakens the #747 artifact-identity invariant.

## Findings

### CRITICAL — M1 has a concrete same-sequence counterexample

The available “fold evidence” does not prove that the durable global manifest equals the composed manifest.

Concrete path:

1. Durable state at sequence `q` has structurally valid `manifestMeta`, but one file row differs from the remote in `encSha`, compression metadata, size, or mtime. This is an existing recovery case: `validManifestMeta` validates only shape, not its content binding ([sync-state-model.ts:102](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-model.ts:102>)). The existing corruption test explicitly demonstrates a structurally valid meta whose manifest hash disagrees with persisted content ([e2ee-sync.test.ts:2054](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/e2ee-sync.test.ts:2054>)).

2. The process-local fold LRU already contains the correct remote manifest. On a same-head pull, `latest()` may return `cachedEvidence` without hashing the supplied persisted base ([e2ee-remote.ts:227](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/e2ee-remote.ts:227>), especially lines 239–247).

3. This exact behavior is pinned by the existing test: the first call with a corrupt fast-fold base cold-walks and populates the cache; the second call passes the same corrupt base yet reports `fold="evidence"` and returns the cached correct manifest with zero fetches ([e2ee-sync.test.ts:1187](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/e2ee-sync.test.ts:1187>)). I ran this targeted test: 1 passed, 6 assertions.

4. Reconcile can still produce zero actions because `sameContent` compares only plaintext hash, type, symlink target, and mode. It deliberately ignores `encSha`, compression fields, size, mtime, and extensions ([diff.ts:15](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/engine/diff.ts:15>)). A direct execution with only `encSha`/`cipherSize` differing returned `[]`.

5. On an unscoped pull, `storedBase` is the correct remote manifest ([pull-scope.ts:39](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/scope/pull-scope.ts:39>)); rule-authority adds nothing without a scope ([pull-scope.ts:70](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/scope/pull-scope.ts:70>)). Therefore all proposed predicates can appear true:

   - `sourceGlobalSeq === snapshot.lastSyncedSequence`;
   - fold reports evidence;
   - zero actions;
   - zero rule-authority writes;

   while `snapshot.lastSyncedManifest !== scoped.storedBase`.

Eliding `global` then suppresses today’s self-healing full save.

If “base-identity proof” is intended to mean “the supplied persisted manifest was hashed and matched this operation,” the design must define that first-class result. Actual `latest()` returns only sequence, manifest, and optional meta ([e2ee-remote.ts:171](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/e2ee-remote.ts:171>)); `LatestTimings.fold` is observation, not integrity authority. This directly violates design 235 §5.2. An O(N) canonical hash would establish the proof, but would need to be admitted honestly as an O(N) pass under §5.9.

This also answers the `encSha` question: zero actions emphatically does not prove exact global equality.

### MAJOR — M1 bypasses the final state authority/fence and changes accepted-save semantics

The proposed empty-packet shortcut says to skip the lock, store open, and CAS. That removes more than expensive staging.

The current SQLite path performs, under the canonical state lock:

- ownership validation;
- write-fence check;
- authority reselection;
- authority-bound store open;
- nonce/revision/generation predicates;
- final ownership recheck before commit.

See [whole-state-compat.ts:251](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.ts:251>) and [write-packet.ts:234](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:234>).

Design 264’s SP-2 contract explicitly requires exact-Q saves on an unsupported, held, erroneous, or lost state lock to refuse before opening or mutating the store ([264-sqlite-behavior-ports.md:129](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/264-sqlite-behavior-ports.md:129>)). M1 would instead return apparent success without even observing that condition. That contradicts design 267’s own protected claim that SP-2 fail-closed saves and fence acquisition remain intact.

It also eliminates current durable effects:

- Every accepted CAS increments `stateRevision`, even without a global section ([write-packet.ts:257](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:257>)).
- A global save advances BASE generation and rewrites `plane_heads` ([cas-steps.ts:133](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/cas-steps.ts:133>)).
- It replaces `last_synced_sequence`, metadata, `manifest_chain`, and meta-wire Git rows atomically ([cas-steps.ts:143](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/cas-steps.ts:143>)).

Those writes are arguably unnecessary for a semantic no-op, but their retirement is a product/compatibility decision. They cannot be described as “no contract change.”

The missing final CAS also means the function can return the old snapshot after another state authority transition. The workspace mutex reduces this race, but the state lock/CAS is the actual owner today.

### MAJOR — M1 is not “JSON/SQLite equivalent by construction”

Global elision with repository transitions is already supported equivalently: it is an ordinary repo-only packet.

An entirely empty packet is different:

- `saveStateSource` always calls the selected packet operation ([sync-state.ts:364](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:364>)).
- The legacy JSON arm preserves the current global section, sanitizes carried records, mints a nonce if necessary, increments `stateRevision`, and republishes the document even when `packet.global` is absent ([legacy-json-store.ts:152](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/legacy-json-store.ts:152>)).
- SQLite likewise builds a transition stage, rebuilds the manifest projection, and increments the revision with no global ([sqlite-state-save.ts:144](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/sqlite-state-save.ts:144>), [write-packet.ts:257](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:257>)).
- The differential harness explicitly pins that a repo-only/global-less packet preserves the global plane and increments the revision ([write-differential.test.ts:239](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-differential.test.ts:239>)).

Therefore:

- Skipping only `saveThroughStore` makes JSON and SQLite diverge.
- Treating every empty `StateSavePacket` as a no-op is invalid: empty packets are used to initialize capable lineage ([whole-state-compat.ts:164](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.ts:164>)) and migrate a legacy reset lineage ([reset-state.ts:429](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/reset-state.ts:429>)).
- The shortcut must be a pull-specific, proof-bearing decision in `saveStateSource` or a narrower operation—not a property inferred from packet emptiness.
- Packet-level `write-differential.test.ts` does not test a skipped call. The new differential gate must run through the real `saveStateSource` orchestration and compare result state, durable state, errors, revisions, and lock/fence outcomes.

I attempted the current differential suite, but the environment refused its `/tmp` fixtures with `EROFS`; that was an environment limitation, not a product test failure.

### MAJOR — M2’s “caller already holds the exact state” premise is false for the public packet operation

The accepted read-back contributes substantially more than CAS-stamped metadata.

It supplies:

- all untouched repository records;
- the existing global manifest for repo-only packets;
- repository records after store-side BASE recomposition and codec admission;
- incremented `repoGen` values;
- reconstructed `lastSyncedManifest.gitRepos`, pending/removal/resolution maps;
- manifest source-shape handling, including present-but-empty `gitRepos`;
- canonical manifest headers and file rows;
- validated/canonical manifest meta, chain, and meta-wire Git rows;
- stripping of obsolete intents and undefined members;
- lineage extras;
- token-derived `stream`, `lastSyncedSequence`, nonce, `stateRevision`, and telemetry binding.

See [read-only.ts:79](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/read-only.ts:79>).

Only the last group is available in `CasResult.token` ([ports.ts:23](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/ports.ts:23>)). `projectAcceptedSavePacket` already enumerates those token fields—stream, sequence, nonce, revision, binding ID ([sqlite-state-save.ts:68](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/sqlite-state-save.ts:68>))—but it still requires a complete caller-supplied projection.

`saveStateSource` has enough information to build such a projection through `projectStateSource`, but `applyStateSavePacket` receives only a possibly partial packet. Several direct callers consume the accepted state:

- capable-lineage initialization needs the minted nonce/revision;
- legacy reset migration installs `migrated.state`;
- push receipt arming assigns `state = installed.state` immediately before POST ([push.ts:797](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/push.ts:797>));
- published-intent recovery returns `result.state` to follow-journal settlement ([sync-state.ts:562](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:562>)).

I found no production consumer intentionally depending on cosmetic JSON key ordering. They do, however, depend on the substantive canonical state described above.

The reset-replacement path is the valid precedent: its caller explicitly provides `acceptedProjection`, the adapter combines it with the token, and the test asserts strict equality with a durable reload ([whole-state-compat.ts:357](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.ts:357>), [whole-state-compat.test.ts:867](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.test.ts:867>)).

M2 needs an explicit operation/interface design covering every direct caller. It cannot simply change `translateCasResult` to return “the packet.”

### MAJOR — M3’s third-hash rationale violates the #747 deletion identity contract

The deletion hash is not redundant with the inode comparison.

`deleteSealedArtifact`:

1. hard-links the named artifact into its private directory;
2. hashes that pinned inode and compares it to `ref.physicalSha256`;
3. reopens the shared name and verifies it is the same inode;
4. only then unlinks it.

See [stage-artifacts.ts:273](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/stage-artifacts.ts:273>).

The hash proves “this inode is the artifact named by the ref.” The inode comparison proves “the shared pathname still names that proven inode.” They prove different facts.

Consumption and deletion also acquire separate stage-lock intervals ([write-packet.ts:185](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:185>)). A replacement or stranded foreign artifact between those intervals would pass a self-comparison of its inode if the hash were removed. The current CODEMAP explicitly assigns `stage-artifacts.ts` “identity-proven deletion.”

M1/M2 themselves do not violate #745/#746/#747 because they avoid or leave the stage lifecycle intact. M3’s recommendation does. A founder performance decision alone is insufficient unless it explicitly retires the physical-ref identity guarantee and its threat model.

## Required path-by-path answers

| Path | M1 disposition |
|---|---|
| Ordinary unscoped same-head | Unsound with current evidence interface; warmed-LRU + exact-metadata drift is a counterexample. |
| Scoped, no straddling repo | `storedBase === remote`; same proof problem as unscoped. |
| Scoped with straddling repo | `storedBase !== remote` and pull omits new `manifestMeta`; must be ineligible. The eligibility receipt must bind `storedBase`, not merely remote head. |
| Partial/pending Git | Global is file-only; pending/applied Git lives in repo transitions and manifest meta. Current `observedRepos` normally produces repo sections, so the entire save cannot be skipped. |
| Mass-delete | Safe: guard throws before apply/save ([pull.ts:314](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/pull.ts:314>)). |
| Missing KEK / encrypted head | Safe: refuses before reconcile/save ([pull.ts:279](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/pull.ts:279>)). With a KEK, `encSha` metadata drift remains the counterexample. |
| Degraded workspace mutex | Design says fail closed, but `composeStateSavePacket` currently receives no degradation fact; this must be explicitly threaded. |
| Historical chain-repair adoption | No `manifestMeta` is supplied, so it should fail closed ([chain-repair.ts:51](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/chain-repair.ts:51>)). |
| Resolution/push-conflict recovery | Current pull APIs do not carry a distinct recovery-provenance flag. If recovery is categorically ineligible, that provenance needs a real interface. |

## Save-side effects

- Telemetry binding is minted by a separate singleton operation, not by ordinary save CAS. Elision preserves an existing binding; it does not need to mint one.
- `lastSyncedSequence` is stamped only in `applyGlobal`. A same-sequence no-op does not need to advance it.
- A zero-action pull with a genuinely newer sequence does need advancement. M1’s equality predicate excludes it, and this behavior is explicitly tested ([daemon-activity.test.ts:1671](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/daemon/daemon-activity.test.ts:1671>)).
- `onPullAdopted` fires only when the returned sequence is greater than the loaded state ([pull.ts:497](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/pull.ts:497>)); an equality no-op needs no callback.
- `plane_heads`, `manifest_chain`, and metadata currently get a fresh generation on a full same-head global save. Preserving the old coherent generation is technically sound only after exact global equality is proved, but it remains a deliberate observable behavior change.
- Every accepted packet currently bumps `stateRevision`; skipping that requires explicit approval and compatibility coverage.

## Binding-constraint disposition

- 235 §5.1 op-list span: not invoked by M1/M2.
- §5.2 evidence interface: **violated**; no first-class authenticated base-identity receipt is designed.
- §5.3 rule authority: acknowledged, but the actual reported write-set interface is unspecified.
- §5.4 differential-write machinery: preserved; M1 must never feed partial file rows.
- §5.5 digest contract: preserved by M1/M2.
- §5.6 mass-delete denominator: preserved because the guard runs before save.
- §5.7 `encSha`: **violated** by treating zero actions plus generic fold evidence as exact-manifest proof.
- §5.8 sealed trusted-view provenance: not itself needed to prove global equality, but recovery/degraded eligibility provenance still needs explicit ownership.
- §5.9 O(N)-floor honesty: incomplete. State load remains O(N); a sound content-binding hash may also be O(N). M2 is not yet a proven constant-factor deletion under the public result contract.
- Darwin #745/#746: preserved by M1/M2.
- Darwin/private-artifact #747: **M3 recommendation violates it**.

## Required revisions before alignment

1. Define a first-class `latest()` result proving that this operation verified the supplied persisted base—not merely that the remote head/meta is authentic or an LRU entry exists. Bind it to the exact state token and exact composed `storedBase`.
2. Add the warmed-LRU corruption fixture above, including an `encSha`-only mismatch and zero reconcile actions.
3. Place the empty-save shortcut in a pull-specific proof-bearing operation. Do not infer it from packet emptiness or skip only the SQLite arm.
4. Explicitly decide whether M1 is allowed to retire no-op `stateRevision` increments and SP-2 lock/fence refusal behavior. Until approved, preserve them.
5. For M2, enumerate all direct packet callers and supply a complete accepted projection for each, or retain read-back where no projection exists. Require `returnedState === durableReload` for every accepted shape.
6. Replace M3’s rationale: the third hash is currently the ref-to-inode proof. Do not approve its removal under the existing #747 contract.
7. Extend validation through real `saveStateSource` calls across JSON/SQLite, scoped/unscoped, pending Git, warmed cache corruption, degraded/recovery, exact-Q lock refusal, and no-op revision/generation behavior.

No state-plane behavior, compatibility arm, accepted-result read-back, or artifact hash is approved for deletion under the current draft.