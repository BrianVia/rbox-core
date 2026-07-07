# Design 75 - First-publish encryption address cache

**Status:** v2 proposed, urgent performance fix. **Summary:** cache plaintext-to-ciphertext addresses per E2EE write context so warm first-publish retries skip deterministic encryption for blobs the server already has.

**Driver:** measured live on 2026-07-07: a first publish of a 129k-file / about 17 GB workspace re-encrypted every file on every push attempt. Five failed walls meant about five full AES-GCM passes, about 85 GB of churn, and 15-30 minutes of CPU per attempt.

## 1. Problem

`encryptAndUpload` (`src/cli/sync-recovery.ts`) only avoids re-encryption by carrying `encSha` forward from `base.files`: `baseEnc` maps `f.sha256 -> f.encSha` from `state.lastSyncedManifest`. On first publish, the base manifest is empty until commit 1 succeeds, so every retry treats every file as needing `encryptFileToTemp`.

That means a failed first publish can upload many ciphertext blobs, then lose all local knowledge of their addresses on the next attempt. The next run re-hashes and re-encrypts all 129k files just to rebuild the same `missingBlobs(encShas)` preflight list.

## 2. Facts this relies on

`encryptFileToTemp` (`src/engine/crypto.ts`) is convergent for file blobs. `deriveKeyNonce` derives the AES-256-GCM key and nonce with HKDF-SHA256 over the workspace KEK, constant blob-domain AAD as salt, and `plaintextSha` as info (`src/engine/crypto.ts:41-46`). The encrypt path copies the source to a snapshot, hashes that snapshot, derives key/nonce from the snapshot hash, encrypts with the same AAD, appends the GCM tag, then hashes the ciphertext file containing `ciphertext || tag` to produce `encSha` (`src/engine/crypto.ts:96-113`). Same workspace KEK plus same plaintext therefore deterministically gives the same `encSha` and `cipherSize`; both reviews verified this primitive-level convergence claim.

The file hash work is already mostly `HashCache`'s job: `scanManifest` first asks `cache.lookup(rel, mtimeMs, size)` and only re-hashes on a miss, then records the fresh sha (`src/engine/manifest.ts:187-194`). This design does not claim to save the HashCache-covered hash pass. It saves `encryptFileToTemp`'s snapshot copy, AES-GCM pass, and ciphertext hash for non-missing server blobs.

The KEK is scoped by the actual KEK wrap context. The wrap AAD binds `{ accountId, workspaceId, accountEpoch, keyEpoch }` (`src/engine/e2ee/session.ts:63-66`), and unwrap/create paths pass those fields when opening or publishing workspace KEKs (`src/engine/e2ee/session.ts:142-153`, `src/cli/e2ee-remote.ts:471-488`). In code today, `E2eeRemote.currentKek()` refreshes account state, stores the current key epoch in private `writeEpoch`, and returns only KEK bytes (`src/cli/e2ee-remote.ts:143-154`); `buildAuthedRemote` then attaches only `kek` to the runtime cfg it returns (`src/cli/e2ee-client.ts:233-237`). v2 must expose the write epoch to `encryptAndUpload`; hardcoding `0` is forbidden because it silently works until rotation ships and then reintroduces stale-KEK address reuse.

The persistence pattern is `HashCache`: own `.rbox/state/` file, missing/corrupt loads as empty, dirty tracking, atomic `writeFileAtomic`, `prune(livePaths)`, and optional `beforeRename` guard for non-daemon write-back paths.

## 3. Decision

Add an `EncryptAddressCache` for working-tree file blobs, stored at `.rbox/state/encrypt-cache.json`:

```json
{
  "version": 1,
  "accountId": "acct_...",
  "workspaceId": "ws_...",
  "accountEpoch": 0,
  "keyEpoch": 0,
  "entries": {
    "<plaintextSha>": { "encSha": "<64 hex>", "cipherSize": 12345, "paths": ["src/a.ts"] }
  }
}
```

Lookup identity is `plaintextSha` within the top-level `{ accountId, workspaceId, accountEpoch, keyEpoch }` binding. These four fields mirror the KEK wrap context; any mismatch discards the whole file. `paths` are only eviction refs. On load, discard on wrong version, wrong identity binding, malformed sha/size/path refs, or corrupt JSON.

At 129k distinct plaintext entries, expect about 20-30 MiB without path-heavy duplication, or 30-45 MiB with realistic path refs. That is acceptable next to a 17 GB per-attempt encryption pass.

This must be a sidecar, not a `HashCache` extension. Reject extending `HashCache` with `encSha` columns because plaintext sha and encrypted address have asymmetric epoch validity: plaintext sha survives key rotation, while `encSha` must not. One file would either over-invalidate the useful hash cache or need per-field validity rules that obscure the security boundary. Also reject persisting attempted manifests into `baseEnc`: five failed walls produce five per-attempt subsets that need merge semantics, and the base-carry path does not have the #109 vanish stat gate. A separate sidecar with one top-level KEK-context header is the clean expression.

Plumbing requirement: change `E2eeRemote.currentKek()` to return at least `{ kek, keyEpoch }`; v2 should expose `accountEpoch` from the same verified account refresh, either in that return value or in a paired current-write-context getter. `buildAuthedRemote` must thread `kek`, `accountId`, `accountEpoch`, and `keyEpoch` onto the runtime cfg object it assembles (`src/cli/e2ee-client.ts:237`), and `sync.ts` already passes that cfg into `encryptAndUpload` (`src/cli/sync.ts:465`). `encryptAndUpload` must load the cache against those cfg fields. It must not synthesize or default `keyEpoch`.

## 4. Push flow

In `encryptAndUpload`, build addresses in this order:

1. Keep base-manifest carry-forward first: if `baseEnc` has `f.sha256`, set `f.encSha` from base.
2. Otherwise consult `EncryptAddressCache.lookup(f.sha256)` after loading the cache for cfg's `{ accountId, remoteWorkspaceId, accountEpoch, keyEpoch }`.
3. On cache hit, cheap-stat the path before accepting it. If it is `ENOENT`, add it to `deferred` like the vanish-defer fix (#109). If `size` or `mtimeMs` changed since the scan, fall through to `encryptFileToTemp`.
4. On accepted hit, set `f.encSha = entry.encSha` and remember `entry.cipherSize` for byte accounting. There is no ciphertext temp.
5. On miss, run `encryptFileToTemp` as today; then update `f.sha256`, `f.encSha`, `ctByEnc`, and record `plaintextSha -> { encSha, cipherSize }`.

Write the cache incrementally during the encrypt phase, not only after a successful commit. Use exactly one debounced serialized writer per process: time-based, about every 10 seconds, plus a final flush. Do not write per worker and do not checkpoint every N entries; eight workers repeatedly serializing a 20-45 MiB JSON file is O(n²) churn that can erase the win. `writeFileAtomic` makes each flushed image corruption-safe, so a crash leaves either the previous valid file or a valid partial cache. The next attempt reuses whatever was flushed.

## 5. Missing blobs and retry semantics

Do not cache ciphertext temp files. They stay per-attempt in the private `rbox-encup-*` dir and are deleted in `finally`.

A cache hit saves the preflight encryption work needed to compute `missingBlobs(encShas)`. If the cached `encSha` is already present server-side, that file does no encryption in this attempt. If the server is missing the blob, `uploadFileWithRetry` follows its existing `!ctByEnc.get(f.encSha)` path: re-encrypt this file's fresh snapshot, adopt the fresh `sha256`/`encSha`, update the cache, and upload that temp.

Frame the win by attempt shape:

- Cold first attempt: no savings. The cache is empty, so the client still snapshots, encrypts, hashes ciphertext, and uploads as today.
- Warm retry after a partial upload: this is the win. Preflight moves from encrypting 129k files / about 17 GB to JSON lookups plus stat checks, and upload-time encryption is limited to the server-missing subset. If a failed wall uploaded 120k blobs, the retry re-encrypts about 9k files, not 129k.
- Total server-side blob loss, such as the GC incident: expect approximately zero encryption savings. The cache can still name the addresses for `missingBlobs`, but every cached address is missing, so the AES pass moves to upload time through the `!ctByEnc` re-encrypt path.

Again, the hash component is not the claimed win: unchanged-path plaintext shas already come from `HashCache` (`src/engine/manifest.ts:187`). This cache avoids snapshot copy + AES + ciphertext hash for cached entries whose blobs are not server-missing.

## 6. Correctness, invalidation, and trust

The cache is correct because `encSha` is a pure function of `(workspace KEK, plaintextSha)` for file blobs. Binding the file to `{ accountId, workspaceId, accountEpoch, keyEpoch }` binds it to the same KEK wrap context. A key rotation changes `keyEpoch`, so old-epoch entries are discarded. An account-epoch change also discards the file rather than relying on stale local assumptions about wrap context.

Content changes invalidate naturally: a new scan produces a different plaintext `sha256`, lookup misses, and `encryptFileToTemp` computes the new address. The cache must not add its own stat-based identity scheme; it consumes the plaintext sha produced by the existing scan/HashCache contract. The cheap stat gate only preserves after-scan vanish/change behavior.

If upload retry re-encryption produces a different `plaintextSha` or `encSha`, that result wins exactly as today. Record it and mutate only that file entry; convergent duplicates still dedupe by `uploaded`.

A syntactically valid wrong mapping is trusted locally, the same trust class as `hashcache.json`. Containment comes from the fresh plaintext-sha key and the existing E2EE verification paths. If a wrong `encSha` points at a server-missing blob, the current `!ctByEnc.get(f.encSha)` upload path re-encrypts this file and heals the mapping before upload. If it points at an existing blob, the committed manifest pairs the freshly computed plaintext `sha256` with that ciphertext address; a receiver decrypts with key/nonce derived from the manifest plaintext sha and then verifies the recovered plaintext hash, so the mismatch is detected rather than silently accepted (`src/engine/crypto.ts:130-161`). Local state tampering is a local compromise, consistent with the E2EE model; deleting the cache or running a deep scan repairs it.

## 7. Eviction and lifecycle

Mirror `HashCache.prune(livePaths)`: remove path refs that left the current manifest and delete entries whose path list becomes empty. When a cache hit or fresh encryption is used for a path, add that path to the entry's refs.

Prune after full scans and after a push builds its final local manifest. Do not prune solely from a deferred commit manifest that omitted never-synced churners; those paths may still be live locally and eligible on the next settled scan.

## 8. Design 73 and #109 interactions

Design 73's byte tracker needs ciphertext sizes before upload starts. This cache supplies `cipherSize` for cache-hit `encSha`s so `bytesTotal` can be unique missing ciphertext bytes without forcing preflight encryption. If `uploadFileWithRetry` re-encrypts to a different `encSha`, revise the tracker total as design 73 section 6 describes; if the file defers, remove unfinished bytes.

The vanish-defer fix (#109) currently relies on `encryptFileToTemp` surfacing `ENOENT`. Cache hits would otherwise skip that read, so the cheap stat gate is required before accepting a hit.

## 9. Security

This cache exposes no new server-visible information. `encSha` and ciphertext sizes are server-visible through blob storage and commit refs. Plaintext shas already live locally in `.rbox/state/hashcache.json` as `HashCacheEntry.sha256`; committed manifests already contain each file's plaintext `sha256` plus optional ciphertext `encSha` (`src/engine/types.ts:10-27`) inside `state.lastSyncedManifest` (`src/cli/config.ts:78-88`, saved at `src/cli/config.ts:204-206`). This cache adds the same sha-to-encSha linkage only for not-yet-committed local entries, whose plaintexts are on the same disk. The file stays under `.rbox/state/` and is never uploaded.

The security boundary is the local machine. A compromised local state file can waste CPU, force reupload, or cause a detected decrypt failure on another device, but it cannot make the server learn plaintext, and it cannot make a receiver silently accept bytes that do not hash to the manifest plaintext sha.

## 10. Verification

- Unit: load rejects corrupt JSON, wrong `accountId`, wrong `workspaceId`, wrong `accountEpoch`, and wrong `keyEpoch`; all degrade to empty.
- Unit: `buildAuthedRemote` threads the current write `keyEpoch` from `currentKek()`/write context into cfg, and `encryptAndUpload` refuses to load/save the cache without it. No test fixture may hardcode `0` except by constructing an explicit current context.
- Unit: cache hit in `encryptAndUpload` sets `encSha` without calling `encryptFileToTemp` when the fake server already has the blob.
- Unit: syntactically valid wrong mapping to a missing blob re-encrypts and updates the cache through the `!ctByEnc` path.
- Unit: syntactically valid wrong mapping to an existing wrong blob yields a decrypt/integrity failure on pull, not silent acceptance.
- Unit: cache hit whose path now returns `ENOENT` is deferred, matching #109.
- Unit: `prune(livePaths)` drops vanished path refs and deletes empty entries.
- Unit: concurrent encrypt workers share one debounced serialized flush path; final flush persists pending entries.
- Integration: kill a first publish after N encryptions, restart, and assert the second encrypt phase calls `encryptFileToTemp` only for unflushed, new, changed, or server-missing-upload files.
- Integration: seed cache for 129k files, mark only K blobs missing in a fake remote, and assert preflight encryption count is zero while upload-time encryption count is K.
- Integration with design 73: cached `cipherSize` contributes to unique missing-byte totals; retry re-encrypt revises totals; deferral removes unfinished bytes.

## 11. Non-goals

- Do not cache ciphertext temp files or plaintext snapshots.
- Do not reuse entries across accounts, workspaces, account epochs, or key epochs.
- Do not change blob crypto, server APIs, or `missingBlobs`.
- Do not fix the existing HashCache same-mtime/same-size residual here.
- Do not add a git-artifact cache in this pass; git artifact refs already carry `sha`, `encSha`, and `cipherSize` inside the encrypted manifest.
