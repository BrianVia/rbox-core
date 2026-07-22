## Verdict

The capture-byproduct hypothesis is **killed as the scheduler for tonight’s loop**.

Capture does mutate fingerprint inputs, but the loop’s captures were scheduled by the **pending-supersession state machine**, not fingerprint misses. The repeated `hit99m0u0` plans prove that: nearly every repository—including `Dfinitiv/savvy-core`—hit its fingerprint cache, yet `savvy-core` was force-captured because it was pending.

There are two coupled state-machine defects:

1. `Dfinitiv/savvy-core` is successfully superseded and ACKed, but becomes pending again on the next self-pull. The log cannot expose whether that is a missing publisher-ACK binding, BASE composition hold, or stale BASE persistence because it records no section identity keys.
2. The standing conductor pending has a definite comparison bug: `record.advertised` overwrites PENDING in the expected-previous map, so carrying the exact pending section can still mark the workspace changed and publish another sequence.

No files or live fleet state were changed during this investigation.

## Timeline

The loop began at **20:58 UTC**, not 21:36.

- Flat-meadow ran `[pull-only]` throughout the day, including its 18:09 boot ([log line 1166](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:1166)).
- Mac published sequence 142 at 20:50, carrying `Dfinitiv/savvy-core` after its candidate failed supersession ([Mac line 2284](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2284)).
- Flat pulled that section and followed `savvy-core` at 20:56:37 ([flat line 1433](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:1433)).
- At 20:56:44 the pull-only daemon stopped and restarted **without** `[pull-only]` ([lines 1437–1440](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:1437)).
- Startup already saw conductor’s stash and `savvy-core` local commits ([line 1441](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:1441)).
- First active push captured `savvy-core`, failed conductor supersession, successfully superseded `savvy-core`, and published sequence 143 at 20:58 ([capture summary](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:1452), [ACK](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:1453), [publication](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:1454)).
- Sequence 203 landed at 21:35. Flat restarted; Mac briefly won sequence 204 with **captured 0, carried 101** ([Mac line 2440](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2440)), then flat resumed with sequence 205 ([flat line 2083](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:2083)).
- The same pattern continued through sequences 422 and 423 ([lines 4250–4268](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/fm-daemon-0721.log:4250)).

That is 280 `savvy-core` captures/publications by flat-meadow from 143–423, excluding Mac’s 204, over about 2h50m—roughly one every 36.6 seconds.

The conductor pending predates the loop by more than three hours; it was already deferring around 17:47. It remained harmless while flat was pull-only. Enabling outbound pushes activated the echo.

## What actually differs cycle-to-cycle

The semantic captured identity is:

- `HEAD`
- syncable refs
- `indexTree`
- normalized operation-state hashes

See [`identity.ts:21`](/home/via/Development/Personal/rbox-core/src/engine/git/identity.ts:21) and [`gitIdentityKey`](/home/via/Development/Personal/rbox-core/src/engine/git/identity.ts:95). Internal `refs/rbox-*` are excluded by [`isSyncableRef`](/home/via/Development/Personal/rbox-core/src/engine/manifest-validate.ts:261).

The log does **not** print those OIDs, so it cannot prove which semantic field differed. Operationally, however, the cycles are materially invariant:

- `hit99m0u0`
- 112,614 files
- 112,383 blobs
- identical 7,530,076-byte Git payload
- almost all cycles transferred `ct=0B wire=0B changed=0B`

The only guaranteed per-capture section difference is fresh `generatedAt` ([`capture.ts:326–338`](/home/via/Development/Personal/rbox-core/src/engine/git/capture.ts:326)). Bundle/WIP bytes may also vary, but they are explicitly excluded from semantic identity.

Capture byproducts do affect the cache fingerprint:

| Byproduct | Semantic identity | Fingerprint |
|---|---|---|
| Scratch `refs/rbox-wip/*` | Excluded | Included because the entire `refs` tree and directory times are scanned |
| `git stash create` objects | Excluded | Object store excluded, but Git may refresh the live index |
| Reflogs | Excluded | Entire `logs/refs` tree included |
| `packed-refs` | Syncable refs only | File stat and content included |
| `generatedAt`/bundle bytes | Excluded | Not a disk fingerprint input |

Scratch creation/deletion is at [`pins.ts:33–55`](/home/via/Development/Personal/rbox-core/src/engine/git/pins.ts:33); capture creates WIP and pins at [`capture.ts:263`](/home/via/Development/Personal/rbox-core/src/engine/git/capture.ts:263) and deletes them at [`capture.ts:375`](/home/via/Development/Personal/rbox-core/src/engine/git/capture.ts:375). The fingerprint recursively stats `refs` and `logs/refs`, including directory mtimes, at [`fingerprint.ts:176`](/home/via/Development/Personal/rbox-core/src/cli/sync-git/fingerprint.ts:176) and [`fingerprint.ts:232`](/home/via/Development/Personal/rbox-core/src/cli/sync-git/fingerprint.ts:232).

I reproduced both cases locally:

- Scratch create/delete changes the fingerprint while `gitIdentityKey` stays identical.
- On an index over 1 MiB, `stash create` can change the stat-based fingerprint while semantic identity stays identical.

These are real cache-idempotence defects, but tonight’s `m0` plans show they only could have caused slow probes—not the repeated captures.

## Why the conductor pending matters

Pending handling is per repository. It does **not** globally force unrelated repositories into `toCapture`.

A pending repository is itself candidate-captured with `forceCapture: true` ([`plan.ts:721–764`](/home/via/Development/Personal/rbox-core/src/cli/sync-git/plan.ts:721)); failed proof restores the exact pending section ([`plan.ts:999`](/home/via/Development/Personal/rbox-core/src/cli/sync-git/plan.ts:999)). Pending pointers also bypass the normal linked-worktree skip ([`plan.ts:894–905`](/home/via/Development/Personal/rbox-core/src/cli/sync-git/plan.ts:894)).

The conductor pending nevertheless keeps the whole workspace publishing because of this bug:

```ts
const prev = { ...base, ...pending };
for (const record of records) {
  if (record.advertised) prev[rel] = record.advertised;
}
```

Although the comment says PENDING should be authoritative, `advertised` overwrites it ([`plan.ts:226–239`](/home/via/Development/Personal/rbox-core/src/cli/sync-git/plan.ts:226)). If advertised section `A` differs from carried pending `P`, outgoing `P` compares against `A`, producing `changed=true`.

Mac’s sequence 204—**captured 0, carried 101**, yet still published—is strong corroboration that carried state alone could advance the sequence.

`Dfinitiv/savvy-core` is a second loop lane: every pull makes it pending, every push force-captures it, proof succeeds, and accepted ACK logs “superseded pending.” Because that log is emitted only after an accepted commit ([`push.ts:793–812`](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:793)), this is not merely a failed-ACK retry. Its next-pull reappearance is a BASE/ACK convergence failure, not capture identity.

## Minimal fix

The minimal causal fix is in the pending state machine, not `capture.ts`:

1. Give PENDING final precedence when constructing `prev`: apply BASE, then advertised, then PENDING—or do not overlay advertised when `pending[rel]` exists.
2. Do not admit pending supersession unless a publisher-ACK binding exists and can terminally advance BASE. Otherwise carry exact P and defer.
3. Add a regression covering: `BASE=B`, `advertised=A`, `pending=P`, failed candidate proof, outgoing exact `P` ⇒ `changed === false`.
4. Add an end-to-end convergence assertion: successful supersession ACK → pending absent, BASE equals candidate → self-pull unchanged → next push is a no-op.

Capture hardening should follow, but alone would not stop this incident:

- Run `stash create` against the staged/copy index rather than the live index.
- Fingerprint only identity-relevant refs and reflogs; exclude `refs/rbox-*` and parent-directory metadata.
- Refresh or invalidate the divergence-cache entry after capture cleanup.

## Why this starved the peer

Every false flat-meadow publication changed the remote parent sequence. Push commit is CAS-bound to `appliedSequence` ([`push.ts:659–703`](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:659)); conflicts force pull-first retries and eventually return “remote is moving faster than we can reconcile” ([`push.ts:727–769`](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:727)), with only five attempts ([`policy.ts:10`](/home/via/Development/Personal/rbox-core/src/cli/sync/policy.ts:10)).

Mac first hit that at 21:41 ([line 2470](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2470)) and reached ×10 by 23:03 ([line 2781](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2781)). With the fixes above, flat’s carried pending becomes a no-op; the remote parent remains stable long enough for the active peer’s push to land.

## Safe immediate mitigation tonight

On the passive replica:

```sh
rbox stop /home/via/Development
rbox start /home/via/Development --pull-only
```

Leaving it stopped is safest; pull-only is acceptable if observation is needed. `--pull-only` is the supported mode for watching remote changes without outbound pushes ([help registry](/home/via/Development/Personal/rbox-core/src/cli/help-registry.ts:131)).

Do **not** manually edit refs, stashes, reflogs, packed-refs, or rbox state. Do not disable `syncGit`; that can publish Git-section removals. Disabling pending supersession alone is also insufficient because the advertised-over-pending comparison can still publish exact carries.