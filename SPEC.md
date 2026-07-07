# SPEC — compress-before-encrypt PROTOTYPE (design-79 exploration, env-gated)

## Objective

Add zstd compression of blob payloads BEFORE AES-GCM encryption, gated behind
`RBOX_COMPRESS=1` (default OFF; when off, behavior must be byte-identical to
today). This is a measurement prototype, not the shipping design — but the
crypto must be done right (see the nonce-reuse constraint below, it is the
whole reason this spec is prescriptive).

Measured prize (real corpus, 110k files / 6.11 GiB, this machine): zstd L3 =
2.17x byte-weighted, 54% transfer savings, compress 300-740 MB/s, decompress
1-3.5 GB/s.

## The cryptographic constraint (non-negotiable)

Current scheme (src/engine/crypto.ts): key+nonce = HKDF(KEK, salt=AAD,
info=plaintextSha). The invariant that makes deterministic (key,nonce) safe is:
**a given (key,nonce) pair only ever encrypts one exact byte sequence** —
because the key derives from the hash of the bytes being encrypted.

If we encrypted the COMPRESSED bytes under a key derived from the PLAINTEXT
sha, the same (key,nonce) could encrypt two different payloads (the raw file
already on the server from an uncompressed-era push, or two zstd versions
emitting different frames) = GCM nonce reuse = catastrophic.

**Therefore: for compressed blobs, derive key+nonce from the sha256 of the
compressed payload (the exact bytes fed to the cipher), and record that hash
in the manifest entry as `payloadSha`.** For uncompressed blobs the payload IS
the plaintext, payloadSha == sha256, nothing is recorded, and the derivation
is bit-identical to today (no migration). AAD stays `rbox/blob/v1` — key
derivation already domain-separates by payload content.

Integrity chain for a compressed blob on pull: derive from entry.payloadSha →
GCM tag authenticates the compressed payload → zstd-decompress → verify
sha256(plaintext) == entry.sha256 (same final check as today). A payload that
decompresses to the wrong plaintext, or fails GCM, or fails to decompress, is
an integrity error exactly like today's mismatch path (remove partial output,
throw).

## Changes

### 1. src/engine/crypto.ts

- `encryptFileToTemp(srcPath, kek, tmpDir?, opts?: { compress?: boolean })`.
  When `opts.compress` and the snapshot qualifies (see heuristic), after the
  snapshot+plaintext-hash steps: compress the snapshot to a second temp file
  via `node:zlib` `createZstdCompress({ level: 3 })` in a stream pipeline
  (files can be >1GB; never buffer whole files), hash the compressed temp,
  and if it does NOT qualify (below), delete it and proceed exactly as today.
  If it qualifies: encrypt the COMPRESSED temp with key+nonce derived from the
  compressed payload's sha, delete both the snapshot and compressed temps,
  and return the extended result.
- Qualify heuristic: plaintext size >= 128 bytes AND compressedSize <
  plaintextSize * 0.95. (Below that, store raw — media/archives/git packs
  fall out here automatically.)
- `EncryptedBlob` gains optional fields: `comp?: "zstd"; payloadSha?: string`
  (present iff compressed; `cipherSize` already exists).
- `decryptFileToPath(ctPath, kek, plaintextSha, destPath, opts?: { comp?:
  "zstd"; payloadSha?: string })`. When comp: derive from `payloadSha`
  (REQUIRED when comp is set — throw if absent), stream decipher →
  `createZstdDecompress()` → destPath in one pipeline, then the existing
  hashFile(destPath) === plaintextSha check. Empty-plaintext special case
  stays raw-only (empty files never qualify for compression).
- Keep the snapshot-first concurrency rationale intact; the compressed temp
  is named like the ct temp (random suffix) in the same dir, cleaned on every
  path (success, error, finally) just like the snapshot.

### 2. src/engine/types.ts — manifest fields

`FileEntry` gains:
```ts
/** Payload compression applied before encryption (design 79). Absent = raw. */
comp?: "zstd";
/** sha256 of the compressed payload (the exact encrypted bytes) — the key/nonce
 *  derivation input for compressed blobs. Present iff `comp` is. */
payloadSha?: string;
/** Ciphertext byte length (payload + GCM tag). Present iff `comp` is — used as
 *  the download size hint since `size` no longer predicts it. */
cipherSize?: number;
```
`GitArtifactRef` gains `comp?: "zstd"; payloadSha?: string` (it already has
cipherSize). `GitSection` bundle/index fields: add `bundleComp?/bundlePayloadSha?`
and `indexComp?/indexPayloadSha?` ONLY IF wiring them is mechanical; git
bundles are packfiles (incompressible, heuristic rejects them ~always), so if
threading GitSection gets invasive, SKIP compression for the git lane entirely
(pass compress: false at those call sites) and note it. Files lane is the
prize.

### 3. src/cli/sync-recovery.ts — push lane

- The `baseEnc` carry-forward map (line ~134) must carry the FULL ciphertext
  descriptor as a unit: `{ encSha, comp, payloadSha, cipherSize }` keyed by
  plaintext sha256 — an unchanged file reusing a compressed base entry must
  reproduce all fields; a raw base entry must not sprout them.
- Both `encryptFileToTemp` call sites (initial pool + `uploadFileWithRetry`
  re-encrypt) adopt the new fields onto `f` (set or CLEAR them — a retry that
  no longer qualifies must delete stale comp/payloadSha/cipherSize).
- Compression enabled iff `process.env.RBOX_COMPRESS === "1"` (read once,
  module-level function like the existing env gates). Thread as the `opts`
  param, including through `EncryptFileToTempForSync`.
- `f.cipherSize` set from the encrypt result when comp is set.

### 4. src/engine/apply.ts — pull lane

- `stageEntryToTemp`: size hint becomes `entry.comp ? entry.cipherSize :
  entry.size + BLOB_CIPHERTEXT_TAG_BYTES` (fall back to the plaintext-based
  hint if cipherSize is absent), and pass `{ comp: entry.comp, payloadSha:
  entry.payloadSha }` to `decryptFileToPath`.
- Same for the version-restore writer if it has its own decrypt call.

### 5. src/engine/git/shared.ts — git lane (see §2 caveat)

If GitSection threading is mechanical: pass compress through, adopt fields on
GitArtifactRef, pass comp/payloadSha to decrypt. Otherwise explicitly disable
for the git lane and say so in your report.

### 6. src/engine/manifest-validate.ts

Validate the new optional fields when present: `comp` must be the literal
"zstd"; `payloadSha` must be 64-hex and REQUIRED when comp is set; `cipherSize`
a non-negative integer. Entries without them validate exactly as today.

### 7. src/cli/e2ee-fake-server.ts + tests

Round-trip coverage (bun test):
1. crypto.ts: compress round-trip — encrypt with compress:true on a highly
   compressible file → result has comp/payloadSha, cipherSize < plaintext
   size; decrypt with the fields → bytes identical, plaintextSha verified.
2. Incompressible payload (random bytes) → heuristic rejects → result has NO
   comp fields, ciphertext identical to a compress:false run (byte-equal
   determinism preserved).
3. Nonce-reuse guard: same plaintext encrypted raw and compressed produce
   DIFFERENT (key,nonce) — assert ciphertexts differ and both decrypt
   correctly via their own descriptors.
4. decrypt with comp set but wrong/missing payloadSha → throws, no partial
   output left.
5. Tampered compressed payload (flip a ciphertext byte) → GCM throws.
6. E2EE push→pull round-trip through the fake server with RBOX_COMPRESS=1:
   mixed corpus (compressible text + random binary), pull side reproduces
   bytes exactly; manifest entries show comp only on the compressible ones.
7. Carry-forward: second push with an unchanged compressed file reuses the
   descriptor (no re-encrypt) and the manifest keeps comp/payloadSha.
8. RBOX_COMPRESS unset → produced manifests contain NO new fields anywhere
   (deep scan in the fake-server test).

## Acceptance criteria

- `bun run typecheck` green.
- `bun test ./src/` green from the worktree root (do NOT run `bun test src/`
  — it pulls in apps/web).
- All 8 test behaviors above present and passing.
- With RBOX_COMPRESS unset, `encryptFileToTemp` output is byte-identical to
  today (test 2/8 pin this).

## Do NOT

- Do not touch apps/api (server never sees compression — blobs are opaque).
- Do not change the AAD, HKDF structure for raw blobs, or manifestSchema
  number.
- Do not enable compression by default anywhere.
- Do not buffer whole files for compress/decompress — stream.
- Do not commit.
