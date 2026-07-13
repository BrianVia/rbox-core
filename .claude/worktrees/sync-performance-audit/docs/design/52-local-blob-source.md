# 52 — Local blob source: copy bytes you already have instead of downloading them

Status: draft — spec only, NOT scheduled (founder: stability first).
Depends on: design 03 (blob path), design 12 (full E2EE / convergent encryption),
design 50 (destructive-apply safety / stage-verify-rename discipline), design 44
(mass-delete guard). Sibling of design 53 (both drafted 2026-07-02).

## 0. Origin

The founder (paraphrased from the 2026-07-02 discussion):

> My synced workspace holds ~10+ git worktrees of the same repo (Conductor),
> ~4,300 tracked files each, 99% content-identical across worktrees; only dozens
> of files differ per PR branch. When a second machine pulls a newly-added
> worktree, it downloads ~4,300 blobs that are byte-identical to files already on
> its own disk in sibling worktrees. I want pulls to notice "I already have these
> bytes locally" and copy instead of download.

He explicitly likes this option. **Capture-delay ideas were rejected.** And the
governing constraint, stated plainly: **stability is paramount** — the daemon
only recently stopped hurting his machine (designs 49/50), so this must be
conservative, opt-outable, and *fail-safe to the download path on any doubt*.

This is a pure pull-side, client-only optimization. It changes nothing a server,
a peer, or the E2EE model can observe.

## 1. What a pull does today, and where the waste is

Walking the real code (`src/cli/sync.ts` `pull()`, `src/engine/apply.ts`):

1. `pull()` scans the local tree into `local` (`sync.ts:121`,
   `scanManifest(root, matcher, cache)`) — the freshest on-disk truth, validated
   through the `HashCache` (`src/engine/hashcache.ts`).
2. `reconcile(base, local, remote, …)` (`sync.ts:148`) emits `Action[]` — the
   ones that matter here are `kind: "write"`, each carrying a `FileEntry` with a
   PLAINTEXT `sha256`, an `encSha` (ciphertext address), `size`, and `mode`.
3. `applyActions` (`apply.ts:63`) runs the writes through a bounded pool
   (`poolMap`, default `dlConc = 64`, envable via `RBOX_DOWNLOAD_CONCURRENCY`).
   Each `write` calls `writeEntry` → `stageEntryToTemp` (`apply.ts:180`), which
   for an encrypted file **fetches the ciphertext by `encSha` from R2**
   (`store.getToFile`), decrypts+verifies into a temp, `chmod`, then the
   precondition-checked atomic `fs.rename` publishes it.

For the founder's newly-added worktree, ~4,300 of those `write` actions have a
`sha256` that **already exists on this disk** — in a sibling worktree, at full
plaintext. Yet every one is a round-trip to R2 (`RemoteBlobStore.getToFile`,
`src/cli/remote/api.ts:168`) plus an AES-GCM decrypt. The bytes are sitting three
directories over. That is the entire waste this doc removes.

Key realization that makes this clean: **the copy is plaintext→plaintext.** The
write target's identity is its plaintext `sha256`; a sibling worktree holds that
exact plaintext. Convergent encryption / `encSha` / the KEK are irrelevant to the
copy path — we never touch ciphertext, never decrypt, and don't even need the KEK
for a locally-satisfiable entry. We skip the download *and* the decrypt.

## 2. Decision: the source index is the `local` manifest we already scanned

The puller needs a map `plaintext sha256 → a local path that currently holds it`.
There are three candidates on disk; we pick one, decisively:

- **The last-synced manifest** (`state.lastSyncedManifest`) — rejected as the
  primary source. It is the reconcile *base*, i.e. the tree as of the last sync,
  not as of now. A file it lists may have been edited or deleted since; trusting
  it invites stale sources.
- **The daemon's live in-memory manifest** (`daemon.ts:90`, `this.manifest`) —
  exists only in the daemon, not in one-shot `rbox pull`. Not a portable basis.
- **The `local` manifest `pull()` already computed at `sync.ts:121`** — ✅ chosen.
  It is the freshest possible snapshot (a real scan, `HashCache`-validated), it
  is *already in hand* (zero extra work — we build the index from a manifest we
  computed anyway), and it reflects the same disk the writes are about to touch.

So: build `sourceBySha: Map<string, string>` (sha256 → relPath) once, from
`local.files` where `type === "file"`, immediately after the scan. First writer
wins on collisions; deterministic tie-break by path so the choice is stable and
testable. Pass it into `applyActions` via a new optional `ApplyOptions` field.

**Staleness is expected and handled, not prevented.** Between the scan
(`sync.ts:121`) and the copy (inside the apply pool), the user can edit or delete
the source file. We do **not** try to make the index fresh — we make the *copy*
verified (§3). The index is a hint, exactly as the `HashCache` `(mtime,size)`
tuple is a hint and never identity (`hashcache.ts` header comment). A wrong hint
costs one failed hash and a fallback download; it can never corrupt a target.

## 3. Decision: trust nothing — stage, verify the TEMP, atomic rename, else download

This is the load-bearing safety property. It gets design-50-grade paranoia.

A locally-satisfiable `write` entry is staged through the SAME temp→verify→rename
discipline `writeEntry` already uses for downloads — the copy path is a *different
way to fill the temp*, nothing else changes:

1. `assertWithinRoot` + `mkdir` the dest dir (unchanged from `writeEntry`).
2. **Fill the temp from the local source** (§4 mechanics) instead of from R2.
3. **Verify the TEMP, not the source.** Hash the staged temp bytes with
   `hashFile` (`src/engine/hash.ts`) and require `=== entry.sha256`. We verify
   the bytes that will actually be published — never the source, which can drift
   under us (TOCTOU between "index said this path had sha X" and the copy). This
   mirrors `decryptFileToPath` (`crypto.ts:160`), which hashes its *output* and
   throws on mismatch, and `stageEntryToTemp`'s streaming download, which verifies
   the sha as it lands. Same invariant, same place in the pipeline.
4. **On mismatch (or ANY copy error): remove the temp and fall through to the
   existing download path** for that one entry. No throw, no halt — the pull is
   byte-for-byte identical to today for that entry. Failure degrades to "we did
   an extra local hash, then downloaded anyway." That is the whole blast radius.
5. From a verified temp onward it is the *unchanged* `writeEntry` tail: the final
   `currentEntryAt`/`sameContent` precondition re-check, the conflict-copy of any
   surprise bytes (`conflictName`), the type-flip directory eviction (design 50
   §3), and the atomic `fs.rename(tmp, abs)`. The copy path never reaches around
   any existing guard; it only supplies the temp earlier and network-free.

Why verifying the temp fully closes the TOCTOU: with a reflink clone (§4) the temp
is a **copy-on-write point-in-time snapshot** of the source at clone instant. A
later edit to the source does not touch the reflinked temp (that is what COW
*means*). So hashing the temp verifies exactly the bytes we will publish, and a
source edit that races the clone either (a) landed before the clone → the temp
carries the new bytes → hash mismatch → download, or (b) landed after → the temp
is untouched → hash matches the intended content. Both are safe. There is no
window in which wrong bytes get published.

## 4. Decision: reflink-clone (copy-on-write), fall back to a hashing plain copy — never hardlink

Mechanics of filling the temp from `sourceBySha.get(entry.sha256)`:

- **macOS (APFS):** `fs.copyFile(src, tmp, fs.constants.COPYFILE_FICLONE)`. On
  APFS this is `clonefile(2)` — a metadata-only copy-on-write clone: near-zero
  time, near-zero extra disk, independent COW bytes. `COPYFILE_FICLONE` (not
  `_FICLONE_FORCE`) is *best-effort* — if the clone can't be done it silently
  falls back to a full byte copy, still correct.
- **Linux (btrfs/XFS/bcachefs):** the same `fs.copyFile(src, tmp,
  COPYFILE_FICLONE)` maps to the `FICLONE` ioctl / `copy_file_range` with reflink,
  best-effort with a plain-copy fallback on filesystems without reflink (ext4).
- **Plain-copy fallback (any FS):** stream `src → tmp` through a SHA-256 transform
  so we read the bytes exactly once and get the verification hash for free
  (hash-while-copying). The reflink path can't do this (the clone moves no data),
  so it hashes the temp afterward — but a reflinked temp read is page-cache-warm
  and cheap.
- **Same-filesystem guarantee:** the source (a sibling worktree file) and the temp
  (in the dest dir, `tmpName` beside the target) are both under the workspace
  root, hence the same filesystem *by construction* — the identical guarantee
  design 50 §2 leans on for its trash renames ("Same filesystem as the tree by
  construction"). Reflink and the EXDEV class simply don't arise. If a future
  layout ever crossed a mount, `copyFile` still works (plain copy); only the
  reflink fast-path is lost.

**Why copy, never hardlink.** A hardlink would alias one inode across two
worktrees: a later edit to the pulled file (or to its sibling) would mutate *both*
— editors that truncate-in-place or write-in-place would corrupt the founder's
other worktree silently. The whole point of worktrees is independent working
copies. Reflink/clonefile gives copy-on-write *pointer* semantics: shared storage
until one side is written, then they diverge cleanly. That is exactly the
semantics the founder needs, and it is what "copy" must mean here.

## 5. Decision: scope — which writes are eligible, what is explicitly out

Eligible (routed through the local-source path):

- `kind: "write"` and `kind: "conflict"` actions whose `entry.type === "file"`
  and whose `entry.sha256` is present in `sourceBySha`. Both flow through
  `stageEntryToTemp`, so both benefit from one change at one site.

Explicitly out (keep downloading — decided, not deferred):

- **Symlinks** — no content blob; `stageEntryToTemp` creates the link directly.
- **Git artifacts** (`gitRepos` bundles/index/op-state) — applied by
  `applyGitSections` (`sync.ts:210`), not `writeEntry`. They are ciphertext blobs
  keyed by `encSha` with no plaintext twin in the working tree, they are few, and
  they are re-derivable. Not worth a second code path.
- **The `.conflict` copy bytes themselves** — those are `moveAside` renames of
  *existing local* bytes; already local, already free.
- **Empty files** (`size === 0`, e.g. `.gitkeep`, `__init__.py`) — a legal but
  pointless source (every empty file shares one sha). Harmless if copied, but we
  short-circuit them to a direct empty-temp create; a download of an empty blob is
  also trivial, so either is fine. Minor.

Interaction with the deferred / mid-write paths: none. Push-side per-file *defer*
(`sync-recovery.ts`) and the scan-side *midwrite* discrimination
(`statHashEntry`, `manifest.ts:145`) both concern files churning under a *writer*.
Here the concern is a *source* churning under a *reader*, and §3's verify-the-temp
+ fallback is the complete answer. We add no coupling to those systems.

Note on small files: we do **not** skip local-copy by size. The cost we are
removing is the per-blob R2 *round-trip* (latency), not the byte transfer — a
1 KB file still costs a full GET RTT, which a local reflink+hash beats by orders
of magnitude. Size-gating would forfeit most of the win (the founder's tree is
mostly small source files).

## 6. Decision: config + rollout — opt-in first, default-on with a kill switch after it proves out

Given "stability is paramount," a two-step rollout, not a flag-day:

1. **First release — opt-in.** Gate behind `RBOX_LOCAL_COPY=1` (env) and a
   persisted `localSource?: boolean` on `WorkspaceConfig` (mirrors the existing
   `syncGit`/`trash` opt-in fields in `src/cli/config.ts`, normalized-on-read like
   `trashConfig`). The founder runs his exact Conductor pull with it on, and the
   §7 log line proves the win and the zero-mismatch rate on the real workload.
2. **Second release — default-on with an opt-out kill switch.** Once validated,
   flip the default and keep `RBOX_NO_LOCAL_COPY=1` / `localSource: false` as the
   permanent escape hatch. This is safe to default because the path is
   **fail-safe by construction** (§3): any error, any mismatch, any exotic FS
   falls through to today's exact download. The blast radius of "on" is bounded to
   wasted local hashing.

The kill switch is honored at the single `applyOpts` construction site in
`pull()` — when off, `sourceBySha` is simply not passed, and `applyActions` is
byte-identical to today (no new branch even entered).

**Metrics / log line.** `pull()` already threads a `PhaseReport` and the daemon
already logs a push line. Add per-pull counters (`localCopied`, `downloaded`,
`copyBytes`) surfaced as one line, e.g.:

```
pull: 4,102 local-copied, 161 downloaded (saved ~1.9 GB / ~3,900 R2 round-trips)
```

The daemon logs it and can fold `localCopied` into `lastPull` for `rbox status`.
A copy that *fell back* to download counts as `downloaded` (honest accounting) and,
if verification-mismatch fallbacks ever climb above noise, that is the signal the
source index is being invalidated faster than expected — worth a look, never a
correctness problem.

## 7. Perf model (the motivating case)

Conductor worktree ≈ 4,300 tracked files, working tree ≈ 150–300 MB (`.git` and
`node_modules` are native-pruned / ignored, so they don't enter this at all).

- **Download path (today):** 4,300 R2 GETs at 64-way concurrency ≈ 67 waves; at a
  ~40–80 ms RTT that's a few seconds of pure latency floor, *plus* transferring
  ~200 MB over the user's uplink (≈ 30 s on a 50 Mbps home link, ≈ 1.6 s on
  gigabit), *plus* 4,300 AES-GCM decrypts. Real-world: tens of seconds to a couple
  of minutes, and it competes with the founder's disk/network (the class of pain
  designs 49/50 fought).
- **Local-source path (this doc):** 4,300 `clonefile`/`FICLONE` ops (metadata-only
  on APFS — effectively free) + 4,300 SHA-256 verifications of ~200 MB total.
  SHA-256 at ~1–2 GB/s ≈ 0.1–0.2 s of hashing; zero bytes over the wire; zero
  decrypts. Total: **well under a second, no network.**

The hashing cost is the one thing that does **not** go away — it is the price of
the §3 safety property and we pay it deliberately. But it is local, page-cache
warm, and runs under the daemon's CPU nice 10 + IO throttle (design 49), so it is
invisible next to the round-trips it replaces.

## 8. Non-goals

- **No server changes.** Not one byte of the Worker/R2/D1 surface moves. The
  server cannot tell a local-copied pull from a downloaded one.
- **No cross-workspace dedup.** The source index is built only from *this*
  workspace's own `local` scan. We never read another workspace's tree.
- **No change to push.** Upload, convergent encryption, receipts, git capture,
  the mass-delete guard — all untouched.
- **No change to the E2EE model.** No new plaintext leaves the machine; the copy
  is plaintext→plaintext *inside* the root where plaintext already lives.
  Zero-knowledge is a server property and is unaffected.
- **No new trust in the `HashCache` or the base manifest.** The index is a hint;
  identity is still the verified content hash of the published bytes.
- **No capture-delay / batching** (founder rejected).

## 9. Test plan sketch

Engine (`apply.ts`), deterministic, no network:

- Local source present + matching → target published from the reflink temp, **no
  `store.getToFile` call** (assert via a counting fake `BlobStore`), `mode`
  preserved, bytes correct.
- Source present but **edited to different bytes** after the index was built →
  temp hash mismatch → falls back to `store.getToFile`, target still correct.
- Source **deleted** between index and copy → `copyFile` ENOENT → clean fallback
  to download.
- Copy path still honors every `writeEntry` guard: the scan→apply-window conflict
  copy (`sameContent` false → `conflictName`), the type-flip directory eviction
  (design 50 §3), `assertWithinRoot`, and temp cleanup on throw.
- Plain-copy fallback FS (COPYFILE_FICLONE unsupported) → hash-while-copying still
  verifies and publishes.
- Kill switch: `localSource:false` / `RBOX_NO_LOCAL_COPY` → `sourceBySha` never
  passed, behavior byte-identical to today (fake store sees every GET).

Integration (`sync.ts`):

- Two-worktree fixture: pull a new worktree whose files match an existing sibling
  → counters report all-local-copied, zero downloads, tree byte-identical to a
  download-only pull of the same manifest (differential test: local-copy pull ==
  forced-download pull).
- Symlinks and git sections still download / apply exactly as before.

Live validation (the real bar): the founder pulls a freshly-added Conductor
worktree on his second machine with `RBOX_LOCAL_COPY=1` and watches the §7 log
line report ~4,100 local-copied / dozens downloaded, sub-second, no network spike.

## 10. Staged rollout

1. Engine: `sourceBySha` plumbing + the copy-verify-fallback branch in
   `stageEntryToTemp`/`writeEntry`, behind the opt-in flag. Ships dark-ish.
2. Founder validates on the Conductor workload (§9 live bar); tune nothing unless
   the mismatch-fallback rate is non-trivial.
3. Flip default-on + document the `RBOX_NO_LOCAL_COPY` kill switch. Fold
   `localCopied` into `rbox status`'s `lastPull`.

Out of scope for all three: any server/GC/download-grant interaction (design 27 is
orthogonal — it removes a D1 read from GETs we are now *not making at all*), any
cross-workspace sourcing, and any change to the push or E2EE paths.
