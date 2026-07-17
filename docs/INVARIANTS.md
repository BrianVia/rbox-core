<!-- Agent-drafted catalog (2026-07-17, coverage through design 137-era main).
     Maintenance rule: every merged design adds/updates its promises here.
     Entries marked 'Proven: NONE FOUND' are verified gaps to close. -->

# rbox Engine Invariants

## Sync state & resets

### Pull precedes push

Every sync cycle processes remote changes before publishing local changes, under one workspace mutex.

Enforced: `src/cli/sync/sync.ts:20-67`  
Proven: `src/cli/sync/sync.test.ts`  
Since: 1

### Unreadable is not deleted

A per-file I/O fault carries forward the prior version, while an unreadable directory fails loudly instead of masquerading as an empty workspace.

Enforced: `src/engine/manifest.ts:461-467`; `src/cli/sync/push.ts:66-74`  
Proven: `src/engine/manifest-scan-fault.test.ts`; `src/cli/sync/sync-scan-defer.test.ts`  
Since: 108

### Daemon scans cannot invent mass deletion

Before its first scan, the daemon treats the last synced manifest as current, so a failed startup scan cannot report the whole workspace deleted.

Enforced: `src/cli/daemon/daemon.ts:438-454`  
Proven: `src/cli/daemon/daemon-scan-defer.test.ts`  
Since: 108

### Watcher doubt causes more scanning

Untrusted, interrupted, or contradictory watcher state triggers a real scan and never permits an event-only view to silently lose changes.

Enforced: `src/cli/daemon/daemon.ts:1330-1409`; `src/cli/daemon/policy.ts:45-96`  
Proven: `src/cli/daemon/daemon-watch-degrade.test.ts`; `src/cli/daemon/daemon-safety.test.ts`  
Since: 104

### Manifest deltas fail closed

Every delta is linkage-, base-hash-, result-hash-, path-, and chain-bound checked; malformed or substituted history is rejected rather than partially folded.

Enforced: `src/engine/manifest-delta.ts`; `src/cli/e2ee-remote.ts:303-394`  
Proven: `src/engine/manifest-delta.test.ts`; `src/cli/e2ee-sync.test.ts:245-384`  
Since: 84

### Fast folds trust only verified evidence

Persisted manifests accelerate pulls only when their signed head, chain prefix, account, roster, key epoch, and verified manifest hash agree; doubt falls back to a cold authenticated walk.

Enforced: `src/cli/e2ee-remote.ts:166-215,257-289`  
Proven: `src/cli/e2ee-sync.test.ts:737-763,926-1077,1608-1624`  
Since: 106

### State saves are incarnation-fenced

A delayed save from an old workspace stream or reset incarnation can never overwrite current state.

Enforced: `src/cli/config.ts:500-518`; `src/cli/sync-state.ts:295`  
Proven: `src/cli/sync-state.test.ts:489-521`  
Since: 116

### State packets are all-or-nothing

A state update is rejected as a whole if its global sequence or any repository generation is stale, keeping file and Git truth together.

Enforced: `src/cli/config.ts:520-526`  
Proven: `src/cli/sync-state.test.ts:441-460`  
Since: 116

### Repository generations prevent ABA

Even when repository state changes away and later looks equal again, an old save cannot mistake it for the original state.

Enforced: `src/cli/config.ts:526-551`; `src/cli/sync-state.ts:492`  
Proven: `src/cli/sync-state.test.ts:426`  
Since: 116

### State retries preserve newer truth

A rejected save recomputes against current state at most three times and never regresses a newer sequence or unrelated lane.

Enforced: `src/cli/sync-state.ts:295-329`  
Proven: `src/cli/sync-state.test.ts:539-634`  
Since: 116

### Published-checkout recovery is lane-safe

After Git commits, recovery merges only unchanged apply/config lanes and never replays stale values over newer capture or deferral state.

Enforced: `src/cli/sync-state.ts:361-492`  
Proven: `src/cli/sync-state.test.ts:98-259`  
Since: 116

### Reset creates a fresh lineage

Every reset creates a random nonce and advances the state revision, making all pre-reset work permanently stale.

Enforced: `src/cli/reset-journal.ts:361-389`  
Proven: `src/cli/sync-state.test.ts:509-521`  
Since: 130

### Reset has no missing-state window

Reset journals and durably stages its candidate before atomic installation, and crash recovery restores the exact old or exact new state.

Enforced: `src/cli/reset-journal.ts:272-305`  
Proven: `src/cli/sync-git/reset-journal.test.ts:96-143`  
Since: 130

### Reset preserves intervening state

If active state changes before cutover, reset aborts rather than overwriting those intervening bytes with its stale candidate.

Enforced: `src/cli/reset-journal.ts:272,288-292`  
Proven: `src/cli/sync-git/reset-journal.test.ts:115-124`  
Since: 130

### Reset preserves deletion provenance

Old-lineage absence proof is copied to recovery refs before cutover and retired only after exact new state and its incarnation marker are durable.

Enforced: `src/cli/reset-journal.ts:281,317-325`  
Proven: `src/cli/sync-git/reset-journal.test.ts:214-240`  
Since: 130

### Corrupt reset evidence fails closed

Malformed, oversized, symlinked, hash-mismatched, foreign, or inconsistent reset artifacts stop reset rather than being guessed through.

Enforced: `src/cli/reset-journal.ts:100-144,268-327`  
Proven: `src/cli/sync-git/reset-journal.test.ts:74-86,153-269`  
Since: 130

### Reset requires a real fence

A degraded-unlocked client cannot reset lineage, and reset refuses unresolved or unbound checkout journals.

Enforced: `src/cli/config.ts:1025-1096`  
Proven: `src/cli/sync-state.test.ts:290,712`; `src/cli/sync-git/reset-journal.test.ts:284`  
Since: 130

## Git branch lifecycle

### Clean followers follow checkout

When files match the applied manifest and no human-local Git work exists, the receiver follows the incoming branch or detached HEAD, index, and operation state.

Enforced: `src/cli/sync-git/follow.ts:1028-1345`  
Proven: `src/cli/sync-git/follow.test.ts:244,760-813`  
Since: 116

### Human checkout work is never clobbered

Local edits, staged or mode-only changes, operations, local-only commits, and local stash defer checkout instead of being overwritten.

Enforced: `src/cli/sync-git/follow.ts:1213-1327`  
Proven: `src/cli/sync-git/follow.test.ts:824-902,1039`  
Since: 116

### Checkout never rewrites working bytes

Git follow changes metadata only; workspace files remain exactly as the file-sync plane produced them.

Enforced: `src/cli/sync-git/follow.ts:1181`; `src/engine/git/checkout-txn.ts:322`  
Proven: `src/cli/sync-git/follow.test.ts:880,985,1387`  
Since: 116

### Current branch is one transaction

The checked-out branch, HEAD, index, and operation state move together after a locked expected-old recheck, or none move.

Enforced: `src/engine/git/checkout-txn.ts:310-322`; `src/cli/sync-git/follow.ts:1157-1275`  
Proven: `src/engine/git/checkout-txn.test.ts:141-224`; `src/cli/sync-git/follow.test.ts:1149-1175`  
Since: 116

### Safe side refs keep progressing

A blocked checkout does not freeze unrelated provably safe refs or remote-tracking state.

Enforced: `src/cli/sync-git/follow.ts:700-856`  
Proven: `src/cli/sync-git/follow.test.ts:912-971,1320`  
Since: 116

### Sibling worktree branches never move

A branch checked out by another linked worktree is held, even when the incoming OID already equals its current OID.

Enforced: `src/engine/git/apply.ts:106-187`  
Proven: `src/engine/git/apply.test.ts:63-176`  
Since: 68

### Displaced commits stay reachable

Before non-fast-forward updates or deletion, rbox pins displaced human history; inability to prove preservation holds the ref.

Enforced: `src/cli/sync-git/follow.ts:794-807`  
Proven: `src/engine/git/apply.test.ts:241-286`; `src/cli/sync-git/follow.test.ts:1366`  
Since: 116

### Remote repository absence preserves local Git

A repository disappearing remotely updates bookkeeping but never deletes the receiver’s local `.git`.

Enforced: `src/engine/git/apply.ts:202`  
Proven: `src/cli/sync-git/git-sync.test.ts:1182,1430,1511`  
Since: 43

### Pointer repositories stay in their lane

A linked-worktree pointer publishes only its own checkout branch and pins, never the main clone’s shared stash or tags.

Enforced: `src/engine/git/capture.ts:171`; `src/engine/git/apply.ts:303`  
Proven: `src/engine/git/apply.test.ts:157`; `src/cli/sync-git/base-composer.test.ts:254`  
Since: 68

### Branch equality is not deletion authority

A branch already equal to incoming never manufactures provenance that could authorize its later deletion.

Enforced: `src/cli/sync-git/follow.ts:704-750`  
Proven: `src/cli/sync-git/follow.test.ts:267`; `src/cli/sync-git/branch-transition.test.ts:61`; `src/cli/sync-git/base-composer.test.ts:83`  
Since: 130

### Branch transitions are expected-old atomic

A branch create, update, or delete and its lineage artifacts land in one expected-old transaction, or none land.

Enforced: `src/cli/sync-git/branch-transition.ts:1`; `src/engine/git/apply.ts:99,526`  
Proven: `src/cli/sync-git/branch-transition.test.ts:25-49`  
Since: 130

### Tombstones authorize exact history only

A stale branch is pruned only when live value, logical BASE, authenticated tombstone history, and locked proof agree; ambiguity preserves it.

Enforced: `src/cli/sync-git/follow.ts:798-841`  
Proven: `src/cli/sync-git/follow.test.ts:277-343`; `src/cli/sync-git/tombstone-attestation.test.ts`  
Since: 130

### BASE has closed authority

Logical branch BASE changes only through the enumerated typed witnesses, and branch and non-branch witnesses cannot substitute for each other.

Enforced: `src/cli/sync-git/base-composer.ts:1`; `src/cli/sync-state.ts:470`  
Proven: `src/cli/sync-git/base-composer.test.ts:75-83,363`; `src/cli/sync-git/base-composer-structure.test.ts`  
Since: 130

### Stale ORIG_HEAD heals only when safe

A stale breadcrumb may be adopted only when no real operation, held ref, indeterminate proof, or later veto remains.

Enforced: `src/cli/sync-git/breadcrumb-veto.ts:4`; `src/cli/sync-git/follow.ts:1203-1221`  
Proven: `src/cli/sync-git/follow.test.ts:419-649`; `src/cli/sync-git/breadcrumb-veto.test.ts:23`  
Since: 126

### ORIG_HEAD is preserved before replacement

A valid stale `ORIG_HEAD` is preserved under a recovery ref, while malformed raw bytes are quarantined before removal.

Enforced: `src/cli/sync-git/follow.ts:1157`; `src/cli/sync-git/orig-head.ts:1-297`  
Proven: `src/cli/sync-git/follow.test.ts:380,499-597`  
Since: 126

### Checkout crash recovery never guesses

Recovery changes exact old/new values only, preserves third-party values as human intervention, and quarantines binding-mismatched or newly created repositories.

Enforced: `src/engine/git/journal.ts:303-367`  
Proven: `src/engine/git/journal.test.ts:157-332`  
Since: 116

### Published journals roll state forward

An intent journal is rollback-only, while a published journal preserves completed Git and returns opaque intent for a fresh state CAS.

Enforced: `src/engine/git/journal.ts:305-347`; `src/cli/sync-state.ts:361`  
Proven: `src/engine/git/journal.test.ts:298`; `src/cli/sync-git/follow.test.ts:1405`; `src/cli/sync-state.test.ts:98`  
Since: 116

## Locks & mutexes

### One workspace sync at a time

Normal CLI and daemon syncs use one workspace mutex, and nested operations reuse the held handle instead of reacquiring it.

Enforced: `src/cli/sync-mutex.ts:121-173`  
Proven: `src/cli/sync-mutex.test.ts:94-154`  
Since: 116

### Contention never loses daemon work

A CLI contender fails after bounded retries, while a daemon contender keeps its queued wakeup for a later attempt.

Enforced: `src/cli/sync-mutex.ts:142-160`  
Proven: `src/cli/sync-mutex.test.ts:69-75,164`  
Since: 116

### Unsupported identity degrades explicitly

If safe lock identity is unavailable, ordinary sync records degraded-unlocked operation and disables lock-dependent Git behavior.

Enforced: `src/cli/sync-mutex.ts:105-152`; `src/cli/sync-git/follow.ts:1125`  
Proven: `src/cli/sync-mutex.test.ts:38`; `src/cli/sync-git/follow.test.ts:1125`; `src/cli/sync-state.test.ts:290`  
Since: 118

### Foreign locks are never reaped

Cross-host, malformed, symlinked, unknown-liveness, or not-proven-local markers remain untouched; only positively dead local owners may be broken.

Enforced: `src/engine/git/lockfile.ts:526-555`  
Proven: `src/engine/git/lockfile.test.ts:634-684`  
Since: 118

### Lock ownership is exact

Creation, release, cleanup, and reaping require the exact marker and observation identity, so a replaced or stolen lock is never removed.

Enforced: `src/engine/git/lockfile.ts:503-518`; `src/cli/sync-mutex.ts:167`  
Proven: `src/engine/git/lockfile.test.ts:342-365,484-554`  
Since: 118

### Lock publication is crash-safe

A marker is durably published as complete bytes or not published at all.

Enforced: `src/engine/git/lockfile.ts:503-526`  
Proven: `src/engine/git/lockfile.test.ts:320-354`  
Since: 118

### Lock identity survives reboot

Host/boot history permits safe cleanup of a dead marker from this machine’s prior boot without treating a similar foreign marker as local.

Enforced: `src/engine/git/lockfile.ts:312-432`  
Proven: `src/engine/git/lockfile.test.ts:584-669`  
Since: 118

### Identity failures remain retryable

A transient identity-resolution or persistence failure is never cached as a permanent rejection.

Enforced: `src/engine/git/lockfile.ts:432-441`  
Proven: `src/engine/git/lockfile.test.ts:113,287`  
Since: 118

### Protocol locks have one order

Workspace, chain, operation, reflog, origin, Git, reservation, index, state, and journal locks follow one declared acquisition order and reverse release order.

Enforced: `src/engine/git/protocol-locks.ts:8-133`  
Proven: `src/engine/git/protocol-locks.test.ts:39-109`  
Since: 130

### Multiple repositories lock canonically

Operations spanning shared Git stores lock unique real common directories in byte-sorted order.

Enforced: `src/engine/git/protocol-locks.ts:144-145`  
Proven: `src/engine/git/protocol-locks.test.ts:84`; `src/cli/sync-git/git-sync.test.ts:509`  
Since: 130

### Owned locks do not hide foreign locks

The busy probe ignores only rbox-created Git locks with the exact ownership token; replacement at the same path remains busy.

Enforced: `src/engine/git/checkout-txn.ts:310-312`  
Proven: `src/engine/git/checkout-txn.test.ts:377-423`  
Since: 116

### ORIG_HEAD cleanup is exact

Journal recovery removes only an `ORIG_HEAD.lock` carrying that journal’s ownership ID.

Enforced: `src/engine/git/journal.ts:323-344`  
Proven: `src/engine/git/journal.test.ts:348-432`  
Since: 126

### Lock-health internals stay local

Host-identity ledger contents and underlying lock errors never enter workspace state, diagnostics, or telemetry.

Enforced: `src/cli/sync-mutex.ts:83-105`; `src/engine/git/lockfile.ts:348`  
Proven: NONE FOUND  
Since: 118

## Encryption & keys

### Server-blind workspace contents

File bodies, paths, filenames, manifests, and private keys reach the server only as ciphertext, public material, or opaque wraps.

Enforced: `src/engine/crypto.ts:12-28`; `src/engine/e2ee/manifest-crypto.ts:1-9`; `apps/api/src/keys.ts:6-17`  
Proven: `src/engine/e2ee/e2ee-e2e.test.ts`; `src/engine/e2ee/keys.test.ts`  
Since: 12

### Fresh random root keys

Account master, workspace, and recovery keys are independently generated as 256 random bits.

Enforced: `src/engine/e2ee/keys.ts:58-63`; `src/engine/e2ee/recovery.ts:17-23`; `src/engine/e2ee/session.ts:87-97`  
Proven: NONE FOUND  
Since: 12

### Cryptographic suite is pinned

Version-one objects accept only Ed25519, RSA-OAEP-3072-SHA256, HKDF-SHA256, and AES-256-GCM in their assigned roles.

Enforced: `src/engine/e2ee/roster.ts:24-25,86-90`; `src/engine/e2ee/asym.ts:30-94`; `src/engine/e2ee/primitives.ts:51-82`  
Proven: `src/engine/e2ee/asym.test.ts`; `src/engine/e2ee/primitives.test.ts`; `src/engine/e2ee/roster.test.ts`  
Since: 12

### Signed JSON has one encoding

Signed objects use sorted, whitespace-free canonical JSON and reject duplicate keys, floats, negative numbers, and unsafe integers.

Enforced: `src/engine/e2ee/jcs.ts:15-80,96-153`  
Proven: `src/engine/e2ee/jcs.test.ts`  
Since: 12

### Key wraps are context-bound

A wrapped key cannot be transplanted to another account, workspace, epoch, recipient, or purpose and still decrypt.

Enforced: `src/engine/e2ee/keys.ts:73-115`; `src/engine/e2ee/session.ts:52-66,141-154`  
Proven: `src/engine/e2ee/keys.test.ts`; `src/engine/e2ee/session.test.ts`  
Since: 12

### Wraps require signed authorization

A fetched master-key wrap opens only when its exact hash is authorized by the verified roster or key-state chain.

Enforced: `src/engine/e2ee/session.ts:246-274`; `src/cli/e2ee-client.ts:244-254`  
Proven: `src/engine/e2ee/pull-verify.test.ts`; `src/engine/e2ee/recovery-admit.test.ts`  
Since: 12

### Blob encryption is convergent per epoch

Identical payload bytes under one workspace-key epoch encrypt identically for deduplication, while different epochs use fresh keys.

Enforced: `src/engine/crypto.ts:12-28,136-144,176-200`  
Proven: `src/engine/crypto.test.ts`; `src/engine/crypto-pool/crypto-fused.test.ts`  
Since: 12

### Blob addresses cover all ciphertext

A blob’s `encSha` is the SHA-256 of its complete ciphertext and GCM tag, and plaintext verification remains mandatory.

Enforced: `src/engine/crypto.ts:193-200,214-227`  
Proven: `src/engine/crypto.test.ts`  
Since: 12

### Encryption uses one immutable source image

Hashing and encryption read one private snapshot, so concurrent editing cannot create ciphertext with a false recorded plaintext hash.

Enforced: `src/engine/crypto.ts:214-266`  
Proven: `src/engine/crypto.test.ts`  
Since: 12

### Authenticated decryption fails closed

Wrong keys, wrong context, modified ciphertext, decompression overflow, or a plaintext-hash mismatch yields no accepted plaintext.

Enforced: `src/engine/e2ee/primitives.ts:61-82`; `src/engine/e2ee/manifest-crypto.ts:50-64`; `src/engine/crypto.ts:76-90,96-106`  
Proven: `src/engine/e2ee/primitives.test.ts`; `src/engine/e2ee/keys.test.ts`; `src/engine/crypto.test.ts`  
Since: 12

### Manifests use fresh nonces

The same manifest encrypts differently on each commit, with authenticated context binding account, workspace, and key epoch.

Enforced: `src/engine/e2ee/manifest-crypto.ts:14-64`  
Proven: `src/engine/e2ee/keys.test.ts`  
Since: 12

### Commit history is signed and pinned

Every commit signs its sequence, parent hash, account, workspace, roster, epoch, manifest, and refs; a head below or different from the local pin is rejected.

Enforced: `src/engine/e2ee/commit.ts:35-67,118-179`; `src/cli/e2ee-remote.ts:434-472`  
Proven: `src/engine/e2ee/commit-dualmode.test.ts`; `src/engine/e2ee/session.test.ts`; `src/cli/e2ee-sync.test.ts`  
Since: 12

### One immutable workspace key per epoch

For a workspace and key epoch, the first stored wrap wins and racing devices must adopt it rather than overwrite it.

Enforced: `apps/api/src/keys.ts:170-196`  
Proven: `apps/api/test/worker.test.ts`  
Since: 12

### Genesis happens exactly once

An account’s first key world can be created once for the authenticated device, and non-interactive login never creates one silently.

Enforced: `apps/api/src/keys.ts:37-76`; `src/cli/auth-cmd.ts:116-183,469-479`  
Proven: `apps/api/test/worker.test.ts`; `src/cli/auth-cmd.test.ts`  
Since: 60

### Genesis is locally crash-safe

The first device saves keys before publication; a lost 409 race removes invalid local keys, while retryable failures preserve recovery material.

Enforced: `src/cli/e2ee-client.ts:64-83`; `src/cli/auth-cmd.ts:122-139`; `src/cli/e2ee-keystore.ts:141-147`  
Proven: `src/cli/auth-cmd.test.ts`  
Since: 60

### Key history is monotone

Roster versions and account-key epochs append exactly one signed step at a time and cannot be replayed, skipped, or overwritten.

Enforced: `apps/api/src/keys.ts:126-167`; `src/engine/e2ee/roster.ts:210-235`; `src/engine/e2ee/epoch.ts:90-115`  
Proven: `apps/api/test/worker.test.ts`; `src/engine/e2ee/roster.test.ts`; `src/engine/e2ee/epoch.test.ts`  
Since: 12

### Epoch changes require prior authority

A new epoch must be signed by a device already active under the preceding epoch, so a newly admitted device cannot authorize its own rotation.

Enforced: `src/engine/e2ee/epoch.ts:107-137`  
Proven: `src/engine/e2ee/epoch.test.ts`  
Since: 31

### Revocation cannot erase cached secrets

Revocation immediately removes API access, but cryptographic eviction requires a later key rotation because already cached keys cannot be recalled.

Enforced: `apps/api/src/auth/devices.ts:15-21`; `apps/api/src/auth/authenticate.ts:33-43`; `src/engine/e2ee/epoch.ts:1-11`  
Proven: `apps/api/test/worker.test.ts` for access; NONE FOUND for end-to-end revoke-and-rotate  
Since: 19

### Recovery phrase is the recovery key

The phrase is a checksummed 24-word encoding of 256 random bits and derives separate wrapping and signing keys.

Enforced: `src/engine/e2ee/recovery.ts:1-71`  
Proven: `src/engine/e2ee/recovery.test.ts`; `src/engine/e2ee/session.test.ts`  
Since: 12

### Recovery still requires login

Possessing the phrase unlocks encryption but does not bypass server authentication and always admits a fresh device principal.

Enforced: `src/cli/e2ee-client.ts:159-185`; `src/cli/auth-cmd.ts:426-443`; `src/engine/e2ee/session.ts:523-564`  
Proven: `src/cli/auth-cmd.test.ts`; `src/engine/e2ee/recovery-admit.test.ts`  
Since: 12

### Recovery-key caching is opt-in

The recovery key is not cached by default and can be re-shown only where it was explicitly stored.

Enforced: `src/cli/e2ee-keystore.ts:14-17,168-181`; `src/cli/auth-cmd.ts:482-494`  
Proven: `src/cli/e2ee-keystore.test.ts`  
Since: 12

### Secret files are owner-only

Private keys, master keys, recovery keys, workspace keys, pins, and parent directories use owner-only permissions.

Enforced: `src/cli/e2ee-keystore.ts:24-44,93-107,160-171`  
Proven: `src/cli/e2ee-keystore.test.ts`  
Since: 12

### Recovery-kit export is atomic

A recovery kit is owner-readable, atomically written, verified after writing, and never follows a symlink or overwrites a non-file.

Enforced: `src/cli/recovery-kit.ts:112-133,166-177`  
Proven: `src/cli/recovery-kit.test.ts`  
Since: 58

### Headless recovery phrases stay out of logs

When explicitly exporting a headless recovery kit, rbox writes the phrase only to the kit and does not echo it into CI output.

Enforced: `src/cli/auth-cmd.ts:45-59,548-552`  
Proven: NONE FOUND  
Since: 58

### Partial keystores fail safely

A surviving device identity may restore a missing master key only from its signed authorized wrap; a missing identity requires pairing or recovery.

Enforced: `src/cli/e2ee-keystore.ts:69-90`; `src/cli/e2ee-client.ts:233-255`  
Proven: `src/cli/e2ee-keystore.test.ts`; `src/engine/e2ee/pull-verify.test.ts`  
Since: 12

### Packs do not change logical encryption

Packing stores complete opaque per-blob ciphertexts; each blob retains its own key, tag, `encSha`, receipt, quota, and retention identity.

Enforced: `src/engine/blob-pack.ts:1-7`; `apps/api/src/commit-accounting.ts:158-238`  
Proven: `apps/api/test/blob-pack-put.test.ts`; `apps/api/test/blob-pack-redeem.test.ts`; `apps/api/test/blob-pack-read.test.ts`  
Since: 114

### Pack format fails closed

Packs reject malformed headers, bounds, duplicate hashes, oversized members, gaps, overlaps, bad ordering, and non-contiguous extents.

Enforced: `src/engine/blob-pack.ts:11-23,92-138,146-201`  
Proven: `src/engine/blob-pack.test.ts`; `apps/api/test/blob-pack-put.test.ts`  
Since: 114

## Pairing & devices

### Pairing splits server and local secrets

The visible token combines a server lookup value with a 256-bit local secret required to unwrap the master key and prove admission.

Enforced: `src/cli/auth-cmd.ts:364-389`; `src/cli/e2ee-client.ts:122-149`; `src/engine/e2ee/session.ts:428-452`  
Proven: `src/engine/e2ee/e2ee-e2e.test.ts`; NONE FOUND for asserting the real HTTP request omits the local secret  
Since: 12

### Pairing tokens are hashed at rest

The server stores only the SHA-256 digest of the redeemable token identifier.

Enforced: `apps/api/src/auth/pairing.ts:51-75`; `apps/api/migrations/0008_pairing.sql:1-14`  
Proven: NONE FOUND  
Since: 10

### Pairing tokens expire and work once

A token lasts ten minutes and is consumed atomically once; malformed, missing, expired, replayed, and unauthorized tokens fail uniformly.

Enforced: `apps/api/src/auth/pairing.ts:16-18,81-150`  
Proven: `apps/api/test/worker.test.ts`  
Since: 10

### Pairing creation requires live membership

Only a durable authenticated device with a current user membership may create a pairing token.

Enforced: `apps/api/src/auth/pairing.ts:37-44`; `apps/api/src/authz.ts:1-173`  
Proven: `apps/api/test/worker.test.ts`  
Since: 10

### Pairing-token count is bounded

An account may have at most five unconsumed, unexpired pairing tokens, enforced atomically under concurrent creation.

Enforced: `apps/api/src/auth/pairing.ts:16-17,65-76`  
Proven: `apps/api/test/worker.test.ts`  
Since: 10

### Redemption rechecks live authority

Redemption mints nothing unless the creator remains unrevoked, its user remains a member, and the account remains live.

Enforced: `apps/api/src/auth/pairing.ts:119-150`  
Proven: `apps/api/test/worker.test.ts`; `apps/api/test/account-delete.test.ts`  
Since: 10

### Consumed pairing material is scrubbed

Once consumed, stored key-wrap and grant material is nulled even if later authorization checks reject redemption.

Enforced: `apps/api/src/auth/pairing.ts:128-146`  
Proven: NONE FOUND  
Since: 31

### Admission is token-bound

A joining device needs an active administrator’s grant, the pairing-secret proof over the exact addition and wrap, and possession of its own signing key.

Enforced: `src/engine/e2ee/roster.ts:282-317`  
Proven: `src/engine/e2ee/roster.test.ts`  
Since: 12

### Admission grants cannot be reused

A grant identifier may occur only once in roster ancestry and can add at most one device.

Enforced: `src/engine/e2ee/roster.ts:210-233,282-293`  
Proven: `src/engine/e2ee/roster.test.ts`  
Since: 12

### Historical admissions remain verifiable

A legitimate admission already in the immutable roster does not become invalid when its live pairing-token window expires.

Enforced: `src/engine/e2ee/roster.ts:200-208,287-292`; `apps/api/src/auth/pairing.ts:119-126`  
Proven: `src/engine/e2ee/roster.test.ts`  
Since: 31

### Admission publication is atomic

A new device’s public keys and master-key wrap land with the roster version that names them, or none land.

Enforced: `apps/api/src/keys.ts:199-237`  
Proven: `apps/api/test/worker.test.ts`  
Since: 12

### Admission retries retain one identity

A roster-race retry rebuilds against the new head using the already persisted device keypair and treats lost success idempotently.

Enforced: `src/cli/e2ee-client.ts:95-119,145-155`  
Proven: NONE FOUND  
Since: 12

### Signed account identity wins

A joining or recovering client rejects any server-returned account ID that differs from the verified signed roster.

Enforced: `src/cli/e2ee-client.ts:56-60,139-149,164-180`  
Proven: NONE FOUND  
Since: 12

### Pairing secrets avoid argv and echo

Pairing tokens enter through a masked prompt, stdin, or environment variable—not command-line arguments—and are not logged.

Enforced: `src/cli/auth-cmd.ts:194-201,402-423`  
Proven: `src/cli/auth-cmd.test.ts` for prompt/stdin; NONE FOUND for the complete no-argv/no-log contract  
Since: 10

### Device credentials are hashed and revocation-aware

The server stores credential hashes and authenticates them only while the device remains unrevoked and unexpired.

Enforced: `apps/api/migrations/0004_auth.sql:1-13`; `apps/api/src/auth/authenticate.ts:33-43`  
Proven: `apps/api/test/worker.test.ts`  
Since: 4

### Device identities are globally unique

A device ID belongs to at most one credential across all accounts, with bounded retries for a random collision.

Enforced: `apps/api/migrations/0013_device_id_unique.sql`; `apps/api/src/auth/mint.ts:8-64`  
Proven: `apps/api/test/worker.test.ts`  
Since: 12

### Device caps count durable devices

Plan limits count durable unrevoked devices, do not count web sessions, and do not burn one-time grants when capacity is unavailable.

Enforced: `apps/api/src/auth/mint.ts:90-143`; `apps/api/src/auth/pairing.ts:101-116`  
Proven: `apps/api/test/abuse-hardening.test.ts`  
Since: 64

### Revocation is account-scoped

Any device may revoke itself, only owners/admins may revoke siblings, cross-account devices appear nonexistent, and retry is idempotent.

Enforced: `apps/api/src/auth/devices.ts:23-57`  
Proven: `apps/api/test/worker.test.ts`  
Since: 19

### Device-key records are immutable

Once a device’s public keys and master-key wrap are stored, later registration cannot replace them.

Enforced: `apps/api/src/keys.ts:107-123`  
Proven: NONE FOUND  
Since: 12

## Deletion safety

### Pull mass deletion fails closed

A pull removing at least 100 files and at least half the baseline changes nothing until explicitly approved.

Enforced: `src/cli/sync/pull.ts:153-166`; `src/cli/sync/policy.ts:11-15`  
Proven: `src/cli/sync/sync.test.ts`; `src/cli/sync/push-guard.test.ts`  
Since: 44

### Push mass deletion fails closed

A push deleting at least 1,000 files and at least 20% of the baseline stops before upload or commit unless explicitly approved.

Enforced: `src/cli/sync/policy.ts:17-35`; `src/cli/sync/push.ts:555-568`  
Proven: `src/cli/sync/push-mass-delete.test.ts`; `src/cli/sync/push-guard.test.ts`; `src/cli/e2ee-sync.test.ts`  
Since: 108

### Delete consent is directional

Permission to publish mass deletion never authorizes a conflict-recovery pull to delete locally.

Enforced: `src/cli/sync/deps.ts:76-85`; `src/cli/main-dispatch.ts:253-254`; `src/cli/sync-cmd.ts:63-65`  
Proven: `src/cli/sync/push-guard.test.ts`  
Since: 50

### Ignored files do not become deletion echoes

An ignored remote path is neither written nor deleted and remains in the baseline so the next push cannot echo a deletion.

Enforced: `src/cli/sync/pull.ts:139-195`; `src/cli/sync/push.ts:63-73`  
Proven: `src/cli/sync/sync.test.ts`  
Since: 72

### Watcher unlinks are verified

An unlink event removes a manifest entry only when the path is actually gone.

Enforced: `src/engine/manifest.ts:263-365`  
Proven: `src/engine/apply-safety.test.ts`  
Since: 50

### Incoming bytes verify before displacement

A file is fully staged and integrity-verified before local bytes move aside, and deletes run after writes.

Enforced: `src/engine/apply.ts:62-70,83-85,133-277`  
Proven: `src/engine/apply-safety.test.ts`  
Since: 50

### Concurrent edits beat remote deletes

A propagated deletion removes only bytes still matching the baseline; locally changed bytes become a conflict copy.

Enforced: `src/engine/apply.ts:393-416`  
Proven: `src/engine/apply-safety.test.ts`  
Since: 44

### Pull deletions are recoverable

Clean propagated deletes and incoming-file directory evictions are atomically renamed into `.rbox/trash`.

Enforced: `src/cli/sync/pull.ts:168-205`; `src/engine/apply.ts:258-272,393-416`; `src/engine/trash.ts:59-97`  
Proven: `src/engine/apply-safety.test.ts`; `src/engine/trash.test.ts`; `src/cli/sync/sync.test.ts`  
Since: 50

### Conflict copies never clobber

Repeated same-path conflicts atomically claim unique destinations rather than overwriting an earlier preserved copy.

Enforced: `src/engine/apply.ts:444-476`  
Proven: `src/engine/apply-safety.test.ts`  
Since: 50

### Trash never re-syncs

Trash lives under hard-pruned `.rbox`, preventing preserved safety copies from scanning, watching, or propagating.

Enforced: `src/engine/trash.ts:6-12`; `src/engine/ignore.ts:150-166`  
Proven: NONE FOUND  
Since: 50

### Active trash cannot be pruned

Pruning skips active and recent batches, treats only old markers as crashed, and removes eligible batches oldest-first.

Enforced: `src/engine/trash.ts:14-28,109-185`  
Proven: `src/engine/trash.test.ts`  
Since: 50

### Trash restore cannot overwrite or escape

Restore rejects unsafe or symlink-escaping paths and diverts collisions to unique conflict names.

Enforced: `src/engine/trash.ts:42-49,229-297`  
Proven: `src/engine/trash.test.ts`  
Since: 50

### Version restore preserves replaced bytes

Historical restore stages and verifies first, publishes atomically, and preserves the replaced live copy when trash is available.

Enforced: `src/engine/apply.ts:353-390`  
Proven: `src/cli/versions-restore.test.ts`  
Since: 12

### Account deletion requires live owner confirmation

Only a currently verified owner who retypes the account ID or verified email may schedule deletion.

Enforced: `apps/api/src/account-delete.ts:122-150,170-179`  
Proven: `apps/api/test/account-delete.test.ts`  
Since: 37

### Account tombstoning is immediate and idempotent

Deletion atomically tombstones the account, revokes devices, and records a fixed seven-day purge deadline that retries cannot extend.

Enforced: `apps/api/src/account-delete.ts:140-167`  
Proven: `apps/api/test/account-delete.test.ts`  
Since: 37

### Account purge is leased and resumable

Hard purge starts only after grace, processes bounded chunks, and uses token-checked leases so stale workers cannot interfere with fresh ones.

Enforced: `apps/api/src/account-delete.ts:182-206,320-330,401-430`  
Proven: `apps/api/test/account-delete.test.ts`  
Since: 37

### External erasure fails closed

Failed Stripe, Clerk, upload, diagnostic, or workspace erasure keeps its durable retry handle instead of falsely declaring completion.

Enforced: `apps/api/src/account-delete.ts:208-221,254-313`  
Proven: `apps/api/test/account-delete.test.ts`  
Since: 37

### Shared blobs go through GC

Account deletion removes only that account’s entitlement and condemns newly orphaned blobs through reachability GC rather than racing an inline object delete.

Enforced: `apps/api/src/account-delete.ts:224-251`  
Proven: `apps/api/test/account-delete.test.ts`; `apps/api/test/gc-purge.test.ts`  
Since: 37

### Final account erasure is ordered

Workspace authorities and external objects are erased before one idempotent final batch removes account-scoped keys, devices, telemetry, alerts, audit rows, and the account row last.

Enforced: `apps/api/src/account-delete.ts:296-317,333-398`  
Proven: `apps/api/test/account-delete.test.ts`  
Since: 37

### Packed receipts are deletion-fenced

A packed receipt is minted only after pack/member verification and a fail-closed check that neither the logical blob nor physical pack has deletion intent.

Enforced: `apps/api/src/blob-pack.ts:205-240,268-420`  
Proven: `apps/api/test/blob-pack-put.test.ts`; `apps/api/test/blob-pack-redeem.test.ts`  
Since: 114

### Addressable packs are never deleted

Pack GC can open and execute deletion only when no active blob location references the pack, and it rechecks that fact under its lease.

Enforced: `apps/api/src/pack-gc.ts:201-262,282-366`  
Proven: `apps/api/test/pack-gc.test.ts`  
Since: 114

### Mixed packed and canonical storage remains readable

A blob without packed placement falls back to its canonical object, allowing old clients, old blobs, and rollback-safe readers to coexist.

Enforced: `apps/api/src/blob-pack.ts:54-135`; `apps/api/src/blobs.ts`  
Proven: `apps/api/test/blob-pack-read.test.ts`  
Since: 114

## Telemetry & alerts

### Telemetry cannot identify customer data

Ingest accepts only bounded numbers and closed enums; arbitrary strings, paths, identifiers, hashes, extra fields, and numeric poison are dropped.

Enforced: `apps/api/src/telemetry-ingest.ts:22-62,87-162`  
Proven: `apps/api/test/telemetry-ingest.test.ts`; `src/cli/telemetry/contract.test.ts`  
Since: 120

### Telemetry never breaks sync

Recording, writes, transport, and server failures are best effort and cannot escape into synchronization correctness.

Enforced: `apps/api/src/telemetry-ingest.ts:100-110`; `src/cli/telemetry/queue.ts:40-90`; `src/cli/telemetry/sync-state.ts:61-102`  
Proven: `src/cli/telemetry/queue.test.ts`; `apps/api/test/telemetry-ingest.test.ts`  
Since: 120

### Telemetry is bounded and device-only

Ingest requires a device principal, shares a per-device limiter, caps bodies at 32 KiB, and caps telemetry/state batches at 64/32 records.

Enforced: `apps/api/src/telemetry-ingest.ts:10-15,164-217,259-300`  
Proven: `apps/api/test/telemetry-ingest.test.ts`  
Since: 120

### Telemetry kill switch means no network

`RBOX_TELEMETRY=0` is checked at enqueue, report, flush, and send boundaries.

Enforced: `src/cli/telemetry/contract.ts`; `src/cli/telemetry/queue.ts:40-42,61-63`; `src/cli/telemetry/sync-state.ts:61-68`  
Proven: `src/cli/telemetry/queue.test.ts`; `src/cli/telemetry/sync-state.test.ts`  
Since: 120

### Rare signals survive busy telemetry

Safety events coalesce without eviction, capability retains its latest value, and priority families flush before high-volume lane samples.

Enforced: `src/cli/telemetry/queue.ts:19-27,43-51,64-73,114-124`  
Proven: `src/cli/telemetry/queue.test.ts`  
Since: 120

### Failed telemetry stays queued

Network and server failures retain samples, 429 pauses sends for 240 seconds, and only acceptance or a permanent non-429 4xx discards an attempt.

Enforced: `src/cli/telemetry/queue.ts:55-107`  
Proven: `src/cli/telemetry/queue.test.ts`  
Since: 120

### Telemetry drops are observable

Every validation or cap drop emits a low-cardinality counter, and clients report nonzero drops without echoing payload contents.

Enforced: `apps/api/src/telemetry-ingest.ts:160-168,200-216,263-300`; `src/cli/telemetry/queue.ts:84-89`; `src/cli/telemetry/sync-state.ts:92-101`  
Proven: `apps/api/test/telemetry-ingest.test.ts`; `src/cli/telemetry/queue.test.ts`; `src/cli/telemetry/sync-state.test.ts`  
Since: 120

### Propagation uses one clock

Propagation measures notification-to-successful-apply using two timestamps from the same subscriber daemon, never cross-machine clocks.

Enforced: `src/cli/daemon/daemon.ts:1244-1247,2062-2068`  
Proven: NONE FOUND  
Since: 120

### Shutdown cannot delay integrity

The daemon finishes active sync work before a final telemetry flush and bounds that best-effort flush to 1.5 seconds.

Enforced: `src/cli/daemon/daemon.ts:655-663`  
Proven: NONE FOUND  
Since: 120

### Fleet drift reports no paths

Reports use opaque per-root binding IDs, closed reasons, same-clock ages, and authorized device/workspace upserts.

Enforced: `src/cli/telemetry/sync-state.ts:6-38,66-93`; `apps/api/src/telemetry-ingest.ts:219-300`  
Proven: `src/cli/telemetry/sync-state.test.ts`; `apps/api/test/telemetry-ingest.test.ts`  
Since: 120

### Fleet metadata cannot be poisoned

The server stores only bounded valid client versions; missing or invalid headers never erase a known version, and metadata failure cannot fail authentication.

Enforced: `src/cli/remote/context.ts:50-53`; `apps/api/src/auth/authenticate.ts:55-77`  
Proven: `apps/api/test/auth-version.test.ts`; `src/cli/remote/context.test.ts`  
Since: 119

### Telemetry state leaves with its owner

Device revocation and account deletion remove that device’s state and alerts, while workspace purge removes only matching workspace/project rows.

Enforced: `apps/api/src/auth/devices.ts:39-50`; `apps/api/src/account-delete.ts:350-365`; `apps/api/src/ws-purge.ts:112-133`  
Proven: `apps/api/test/worker.test.ts`; `apps/api/test/account-delete.test.ts`; `apps/api/test/ws-purge.test.ts`  
Since: 120

### Slack pings never affect authoritative work

Product pings run outside response dependency, time out after five seconds, retry one timeout/5xx once, and never throw to callers.

Enforced: `apps/api/src/slackpipes.ts:13-17,58-135`  
Proven: `apps/api/test/slackpipes.test.ts`  
Since: 122

### Slack failure logging is secret-safe

Terminal failure logs once, makes at most one alerts-channel attempt, never recurses, and excludes webhook URLs, response bodies, raw errors, and stacks.

Enforced: `apps/api/src/slackpipes.ts:63-125`  
Proven: `apps/api/test/slackpipes.test.ts`  
Since: 122

### Fleet drift requires positive resolution

Fresh deferral over 24 hours opens drift; stale data neither opens nor resolves it, and only fresh cleared evidence closes it.

Enforced: `apps/api/src/fleet-alerts.ts:283-316`  
Proven: `apps/api/test/fleet-alerts.test.ts`  
Since: 127

### Reporting-stopped is latched per device

A device stale for 2.5 hours opens one incident that resolves only on a fresh report or lifecycle removal, never through further aging.

Enforced: `apps/api/src/fleet-alerts.ts:250-281`  
Proven: `apps/api/test/fleet-alerts.test.ts`  
Since: 127

### Alert delivery is deduplicated before sending

Fire, resolve, and renotify claims use conditional database writes first, so concurrent evaluators issue at most one send per claim window.

Enforced: `apps/api/src/fleet-alerts.ts:134-220`  
Proven: `apps/api/test/fleet-alerts.test.ts`  
Since: 127

### Alert flaps and reminders are bounded

A reopen within two hours continues the incident, resolution emits once, and reminders occur daily through day seven before remaining silently open.

Enforced: `apps/api/src/fleet-alerts.ts:156-220`  
Proven: `apps/api/test/fleet-alerts.test.ts`  
Since: 127

### Fleet alerts disclose no paths or identities

Messages sanitize labels, escape markup, omit path/email-like values and project names, and carry only bounded labels, opaque IDs, enums, counts, and durations.

Enforced: `apps/api/src/fleet-alerts.ts:64-89,286-314`; `apps/api/src/notify.ts:336-350`  
Proven: `apps/api/test/fleet-alerts.test.ts`  
Since: 127

### Development fleet never pages

Development evaluation may record incident state but never emits a Slack fleet alert.

Enforced: `apps/api/src/fleet-alerts.ts:124-132`  
Proven: `apps/api/test/fleet-alerts.test.ts`  
Since: 127

### Alert failure cannot block maintenance

Fleet-alert evaluation is independently caught so failures do not prevent GC, retention, notifications, or account-deletion maintenance.

Enforced: `apps/api/src/worker.ts:108-198`  
Proven: NONE FOUND for the later-maintenance-after-throw clause  
Since: 127

### Device creation cannot lose its security alert

A durable new credential and notification outbox row are written atomically, and cron redrives a lost queue enqueue.

Enforced: `apps/api/src/auth/mint.ts:176-192`; `apps/api/src/notify.ts:47-75,421-454`  
Proven: `apps/api/test/notify.test.ts`  
Since: 30

### New-device alerts are owner-scoped and idempotent

Security email fans out only to account owners, freezes recipients atomically, and uses conditional leases to prevent duplicate delivery.

Enforced: `apps/api/src/notify.ts:115-206`  
Proven: `apps/api/test/notify.test.ts`  
Since: 30

<!-- Audit completed read-only in 3m 20s; no files were written. -->
