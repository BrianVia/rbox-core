# 92 - Manifest entry integrity: poison-proof push, self-healing metadata, fail-closed carry

Status: Design accepted 2026-07-09 from the field-verified FM/Mac fresh-join
incident, revised twice: once from two independent design reviews, then
deliberately narrowed to the minimal fix (owner decision, same reasoning as
design 91's simplification — the reviews located all five blockers inside the
per-entry quarantine/pending machinery, which this revision removes from scope).
Client-only and wire-compatible. All parts ship as one correctness change.

Origin: an append-hot 120MB log changed between scan metadata capture and the
encryption read. One internally inconsistent manifest entry then blocked every
fresh join, survived stable rescans, and was resurrected by a device that never
had the file. The same mechanism re-fired the same day at 5.3GB scale.

Related: design 79 introduced the decompression size cap; designs 82 and 85
cover adjacent cache and scan work; design 91's head-gated push turns a
poisoned head into a fleet-wide write deadlock, which is why prevention (not
survival) is the right altitude for this fix.

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
   push carried the older poisoned entry into sequence 654. The failure was
   therefore not just sticky metadata: an unapplied pull plus stale
   carry-forward could move the head backward for one path.
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
    neither the poison nor the rule that ignored it.
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
2. **Push equality ignored repairable metadata.** A corrected size with the
   same SHA was invisible to `diffManifests`, so no successor manifest healed
   the head.
3. **Carry-forward consumed un-applied pulled state.** After a partial apply
   failure, the push path could consult manifest state it had never applied and
   carry a stale entry back over a newer head. That is the sequence-654
   resurrection.
4. **The pull writer damaged the target before verifying the source.** The
   conflict move-aside ran before the incoming entry passed integrity checks,
   so a doomed apply still displaced live user data. The error also named no
   path, which turned a one-file failure into hours of manifest forensics.

## 3. Design - prevent the poison, heal the survivors, fail closed

The fix removes the conditions that mint, preserve, and resurrect a poisoned
entry. It deliberately does NOT add per-entry quarantine or partial-pull
pending state: with creation prevented (3.2), existing lies self-healing (3.3),
and resurrection impossible (3.4), a poisoned head is a state the system no
longer enters, so machinery for surviving one is not worth its permanent
complexity tax (see section 8).

### 3.1 Invariants

- **I1 - one immutable image defines every new entry.** For every newly
  encrypted file, committed `sha256` and `size` equal the SHA and byte count of
  the same immutable encryption snapshot. The cipher descriptor describes that
  snapshot too.
- **I2 - churn defers; it never patches.** If the encryption snapshot differs
  from the scan's expected tuple, that path is deferred. A previously synced
  path carries its coherent base entry; a never-synced path is omitted. The
  implementation never adopts snapshot size or SHA into a mismatched scan entry.
- **I3 - size is push metadata, not reconcile identity.** Same SHA with a
  different size is commit-worthy on push. Reconcile remains byte-identity
  based so a device already holding correct bytes does not manufacture a false
  content conflict.
- **I4 - push consumes only applied state.** No push decision — carry,
  forward-only ignore, purge, defer, mass-delete accounting, or commit
  construction — may read manifest state from a pull that did not fully apply.
  A device that cannot apply the head cannot commit past it.
- **I5 - verify before displace.** The pull writer completes every integrity
  check on the staged incoming entry before the local target, its conflict
  copy, or any obstruction is moved. A failed apply leaves local data exactly
  where it was.
- **I6 - integrity failures name their file.** Every size/SHA/GCM/zstd apply
  failure surfaces the relative path in the thrown error and the CLI output.

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

### 3.3 C - Self-healing push comparator

Do not add size to `sameContent`. Reconcile and apply preconditions use that
function (`src/engine/reconcile.ts:58-66`; `src/engine/apply.ts:163-168`) and
must continue to treat equal bytes as equal even when remote metadata is wrong.

Instead, give `diffManifests` a push-specific equality rule: existing
`sameContent(a,b)` plus `a.size === b.size`. All push/no-op, daemon-change,
status, deferred-change, and mass-delete decisions that already use
`diffManifests` then see same-SHA/different-size as changed, without changing
reconcile semantics. (Appendix A audits every caller.)

The corrected entry may reuse the existing ciphertext descriptor because
encryption address reuse is keyed by plaintext SHA
(`src/cli/sync-recovery.ts:159-178`). The next upgraded writer that scans the
correct bytes therefore commits corrected size metadata without re-encrypting
or requiring an artificial content edit. A successor head immediately heals
fresh joins; retained historical manifests remain immutable and may still
contain the old entry.

This heals SIZE metadata only. A present-but-corrupt ciphertext (GCM/zstd
failure at rest) is not healed by the comparator: reconcile equality means a
correct-plaintext device never re-downloads, and descriptor reuse means it
never re-uploads. Explicit descriptor repair is future work (section 8).

### 3.4 D - Fail-closed carry

Locate and close every path by which manifest state from a pull that did not
fully apply can reach a push decision (the incident's resurrection vector,
section 1.7). The rule is I4: the push base, the design-44 carry overlay,
forward-only ignore carry, purge candidates, `deferManifest` inputs,
mass-delete accounting, and final commit construction all derive from the
persisted applied base (`state.lastSyncedManifest`) only, and that base
advances only when a pull applies completely.

Consequence, stated honestly: a device that cannot apply the head cannot push
(its parent lags and design 91 rejects the commit). One bad entry therefore
wedges that device's writes — loudly, with the path named (I6) — until the
head heals. With 3.2 preventing new poisons and 3.3 healing existing ones from
any device that holds the file (such a device applies its own entry trivially
and is never wedged by it), the wedge is transient and self-resolving. This is
the same fail-closed trade design 91 made for head authority, applied to the
client's write path.

### 3.5 Pull writer hardening

Two local, mechanism-level fixes in `applyActions`/`writeEntry`:

1. **Stage-verify-then-displace (I5).** Staging stays at the existing
   co-located `tmpName` beside the target (`src/engine/apply.ts:330-334`;
   moving it under `.rbox/state` would add an `EXDEV` risk for no gain). The
   per-target order becomes: stage beside target → complete every integrity
   check → final target precondition → move-aside/rename. The serial
   shallowest-first ancestor pre-pass stays exactly where and what it is
   (`src/engine/apply.ts:78-101`) — its serialization prevents sibling writes
   racing one obstruction, and without partial-pull semantics it needs no
   awareness changes. Conflict-name creation uses exclusive-create semantics so
   two same-name conflicts cannot silently replace one another.
2. **Path-bearing integrity errors (I6).** The size-cap, plaintext-SHA, GCM,
   and zstd failures thrown out of staging carry the entry's relative path,
   and the CLI error path prints it. The 120MB incident required decrypting
   the head manifest with a hand-built client just to learn WHICH file was
   poisoned; that must never be necessary again.

Additionally, shared manifest validation rejects file/descendant prefix
collisions (`foo` plus `foo/bar`, including case-folded), closing a
pre-existing malformed-manifest crash class in the same join-robustness theme
(`src/engine/manifest-validate.ts:56`).

## 4. Compatibility

- All changes are client-side. Manifest wire shape, encrypted blob format,
  commit schema, server APIs, and workspace identity are unchanged.
- Coworker onboarding and mixed-client fleets require no coordinated server or
  schema migration. An old client can still mint a poisoned entry until
  upgraded; once any upgraded writer holding the file scans it, the
  size-sensitive comparator (3.3) heals the head for old clients too.

## 5. Acceptance gates

### 5.1 Deterministic tests

1. **Poison injection.** Pause after scan, append to the source before
   `encryptFileToTemp` snapshots it, then resume. The entry is deferred with
   `RBOX_SOURCE_CHANGED`; no inconsistent tuple is committed. The next settled
   cycle ships an entry whose declared size and SHA match decrypted bytes. Run
   through the crypto-worker path as well as inline crypto.
2. **Metadata heal.** Base and local have the same SHA but different size. Push
   commits the corrected size, reuses the coherent ciphertext descriptor, and
   reconcile on a device already holding the correct bytes produces no false
   conflict.
3. **Resurrection regression.** A pull downloads a newer manifest but fails to
   apply one entry. The device's next push MUST NOT consult the un-applied
   manifest: with the applied base lagging the head, the commit is rejected
   (parent mismatch) rather than carrying any entry from the failed pull.
   Exercise the exact sequence-654 shape: base holds the poison, remote holds a
   heal, local lacks the file — no push emits the stale entry or a deletion.
4. **Verify-before-displace.** A poisoned entry arriving as a conflict action
   leaves the local target byte-identical and un-renamed after the failed pull;
   same for a file-valued ancestor obstruction. No conflict copy is created for
   an entry that failed verification.
5. **Path-bearing errors.** Each of size-cap, plaintext-SHA, GCM, and zstd
   apply failures surfaces the relative path in the error and CLI output.
6. **Prefix-collision validation.** A manifest containing `foo` and `foo/bar`
   (and a case-folded variant) is rejected at validation, before apply.

### 5.2 Per-host gates

1. **FM producer gate.** On the dev build, run the append-between-scan-and-
   encrypt injection against the real append-hot-file shape. Observe a named
   defer, then settle the file and observe one coherent successor commit.
2. **Mac heal gate.** Seed a same-SHA/wrong-size base entry; verify the next
   push commits the corrected size and other devices reconcile with no false
   conflict.
3. **Ubuntu fresh-join field gate.** Run the existing full-join stress loop to
   two consecutive clean joins from empty local state against the dev head.
   Both joins must reach 100% and match the head manifest. This loop found this
   incident and two other bugs; retain two consecutive clean Ubuntu full joins
   as a standing release gate for sync changes.

## 6. Rollout and observability

1. Ship all parts in one client release.
2. Validate FM first, then Mac, then run the serialized Ubuntu fresh-join gate
   so no host mutates the shared dev head during another host's check.
3. Log every `RBOX_SOURCE_CHANGED` defer with the relative path; a permanently
   hot source that defers on every cycle points the user toward ignore policy
   (`rbox ignore`), and the daemon's existing activity surface shows the
   deferred count.

## 7. Risks

1. **Permanently hot sources defer repeatedly.** This is deliberate: stale
   carry or omission is safer than inventing a moving manifest tuple. The loud
   path-level defer points the user toward ignore policy.
2. **A device that cannot apply the head cannot push (I4).** Deliberate
   fail-closed trade, mirroring design 91: transient by construction because
   3.2 stops new poisons and 3.3 heals stragglers from any file-holding device.
   If the field ever produces an unhealable head entry (e.g. corrupt ciphertext
   at rest with no surviving plaintext holder), that is the evidence gate for
   the deferred quarantine design (section 8), not a reason to pre-build it.
3. **Mixed clients retain the old failure mode until upgraded.** No wire
   migration can make an old client verify at encrypt time; the heal comparator
   on any upgraded writer bounds the damage window.

## 8. Non-goals (deliberate)

1. **Per-entry pull quarantine and pending-state carry.** A fully reviewed
   design for surviving a poisoned head (typed `BlobIntegrityError` quarantine,
   `filePendingRemote`, three-way pending precedence, transactional type-flip
   grouping) exists at git commit `5cee557` of this file. It drew all five
   review blockers, adds a permanent state machine to the sync core, and
   defends against a state that 3.2/3.3/3.4 prevent from arising. It is
   evidence-gated: revisit only if an unhealed poisoned head occurs in the
   field after this design ships.
2. **Explicit ciphertext descriptor repair** (re-encrypt when a local
   plaintext matches a pending entry's SHA) — future work, same evidence gate.
3. The `dl-integrity-retry` transport fix in the separate held PR. Network and
   blob-fetch retry policy are unchanged here.
4. Device-mint-per-track hygiene.
5. Design 85's general midwrite scan work beyond what 3.2 needs. The
   scan-internal `lstat`→`hashFile` window remains a distinct, open poison
   vector routed to design 85 — 3.2's encrypt-time check catches the
   scan→encrypt window only.

## Appendix A. `diffManifests` caller audit (size-sensitivity)

Making `diffManifests` size-sensitive (section 3.3) was audited against every
caller:

| Caller | Consumes | Size-sensitivity effect |
|---|---|---|
| `src/cli/sync.ts:517` purge preflight | `deleted` only | none — safe |
| `src/cli/sync.ts:536` push no-op gate | full diff | required: this is the heal |
| `src/cli/sync.ts:608` post-defer no-op | full diff | safe — deferred paths carry the selected base |
| `src/cli/sync.ts:620` mass-delete count | `deleted` only | none — safe |
| `src/cli/daemon.ts:787` daemon change counts | `changed` | intentional — a size-only repair should register as a change |
| `src/cli/status-cmd.ts:305` status counts | `changed` | intentional — same |
| `src/engine/engine.test.ts:155` | test-only | n/a |

## Appendix B. Field-gate findings (2026-07-09 run)

All three §5.2 gates passed on dev builds (`0.9.14-dev+7bc1f4f` Mac,
`+745b97f` Ubuntu) against a throwaway dev-API account. Two findings worth
retaining:

1. **The join-fatal poison is zstd-gated.** The declared-size cap lives in the
   decompression counter, so a poisoned entry on an INCOMPRESSIBLE (raw-stored)
   file never trips it: the plaintext SHA matches and the join succeeds with
   the size lie riding along until the 3.3 comparator heals it — annoying
   metadata, not an outage. Only compressible files (the incident was a text
   log) produce the fresh-join brick. Consequence for test harnesses: a poison
   repro MUST use compressible data or it will silently "pass".
2. A live append-hot producer heals via a fresh coherent successor entry (the
   file grew past the poisoned snapshot), not the same-SHA/size-only commit —
   both converge the head; the same-SHA path is pinned by the §5.1.2
   deterministic test.
