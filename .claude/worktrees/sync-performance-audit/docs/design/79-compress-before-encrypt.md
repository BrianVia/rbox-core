# 79 - Compress before encrypt: reduce opaque blob bytes safely

Status: Design accepted; prototype VALIDATED on 2026-07-07 on branch
`d79-compress-proto`, commit `6d4298f`, with a full E2EE round-trip through
prod byte-exact. This document is the productionization plan.
Origin: 2026-07-07 corpus compression bench and prod prototype A/B.
Companion/successor: design 80 batch upload/request-floor work. That work is
not in this design.
Depends on: design 12 V4-5 convergent encryption, design 26 batch upload
measurements, design 43 manifest schema gates, design 74 pull lane timing, and
design 77 batched blob transport.

## 1. Problem and evidence

Measured means observed directly on the workload named here. Inferred means the
estimate follows from those measurements but still needs the rollout acceptance
run.

1. **Compression ratio, measured 2026-07-07.** On a real synced manifest
   containing 110,743 files / 6.11 GiB on an M-series Mac, zstd level 3 produced
   a byte-weighted 2.17x reduction, or 54% savings. Level 1 produced 2.11x.
   Level 6 produced 2.21x, only about one percentage point better than level 3,
   and is not worth the extra CPU. Bucketed by file size: files under 4 KiB were
   2.45x, 4-64 KiB were 3.30x, 64 KiB-1 MiB were 1.34x because media dominates
   that bucket, 1-16 MiB were 1.87x, and files over 16 MiB were 2.63x. Compression
   throughput was 300-740 MB/s; decompression throughput was 1-3.5 GB/s.
2. **Prototype A/B, measured 2026-07-07.** On a 17,504-file / 570 MB source
   corpus pushed to prod over WiFi from a Mac (305 MB of that is files-lane
   plaintext; the rest is `.git` content riding the git lane), files-lane wire
   bytes fell from 305 MB to 62 MB, a 79% reduction and 4.9x effective shrink.
   The signal is in the per-blob upload time: 371.4ms raw vs 368.4ms zstd at
   identical settings — a 79% byte reduction did not move per-request cost at
   all. Wall times: 72s raw, 81s zstd at matched concurrency (the regression
   is the prototype's per-file compression overhead, §5 — not transfer), 69s
   zstd at concurrency 256. Join wall time stayed flat: 32s raw and 30s zstd.
3. **The lane conclusion, measured 2026-07-07.** The small-blob lanes are
   request-bound, with an observed ceiling around 125 blobs/s and no meaningful
   improvement above about 64 effective concurrent requests. This supersedes
   design 26's "byte-bound" reading for the small-blob lane. The old data did
   not distinguish the two theories: on uncompressed blobs, byte-bound and
   request-bound hypotheses looked observationally identical. Compression was
   the controlled experiment that split them.
4. **The direct prize, inferred.** Compression helps most where the path is
   still byte-bound: large encrypted blobs fetched by single GETs. The big
   workspace join has a roughly 71s fetch phase where most bytes ride those
   large-blob GETs. Applying the measured shrink to that lane projects a fetch
   phase around 35-40s and an end-to-end join improvement from about 118s to
   about 85s. This is inferred, not yet measured on the real workspace.
5. **Composition with batching.** The request floor remains design 80's target.
   Compression does not remove per-object request tax. It composes with batching:
   once batching makes the small-blob lanes byte-bound, the measured 4.9x byte
   reduction starts paying there too.

## 2. Cryptographic core

The invariant of the design 12 V4-5 convergent scheme is that a derived
`(key, nonce)` pair must encrypt exactly one byte sequence.

The current raw scheme satisfies that because `src/engine/crypto.ts` derives the
AES-256-GCM key and nonce in one HKDF. `AAD` is the constant
`rbox/blob/v1`; `deriveKeyNonce()` uses that AAD as the HKDF salt and the
SHA-256 of the bytes being encrypted as HKDF info. Today the bytes being
encrypted are the plaintext file bytes, so `encryptFileToTemp()` copies the
source into a snapshot, hashes the snapshot to `plaintextSha`, derives from that
hash, streams the snapshot through AES-GCM, appends the tag, and then hashes
`ciphertext || tag` to produce `encSha`. `decryptFileToPath()` derives the same
pair, verifies the GCM tag, writes the plaintext, hashes the output, and removes
partial output on failure.

The compression trap is deriving from the plaintext hash while encrypting a
compressed frame. That would put different byte sequences under one
`(key, nonce)` pair:

1. a raw-era blob already stored on the server for the same file, and
2. a zstd frame for that same plaintext, or two different zstd-version frames
   for that same plaintext.

AES-GCM nonce reuse is catastrophic: it leaks the XOR of keystreamed plaintexts
and permits GHASH authentication-key recovery. Tests can miss this because both
payloads may individually decrypt and verify.

The fix is to derive from `payloadSha`, the SHA-256 of the exact bytes fed to the
cipher.

1. For a raw blob, `payloadSha == plaintextSha`. The derivation is bit-identical
   to v0.9.6, so existing raw blobs need no migration.
2. For a compressed blob, `payloadSha` is the SHA-256 of the zstd frame. The
   manifest records that value beside the existing plaintext `sha256`.
3. The AAD stays `rbox/blob/v1`; the domain label and ciphertext format do not
   change.

The pull-side integrity chain is then:

1. derive from `payloadSha`;
2. let the GCM tag authenticate the compressed payload;
3. zstd-decompress into the destination temp file;
4. hash the recovered plaintext and require it to equal `entry.sha256`.

Any failure is an integrity error, and any partial output is removed, matching
today's `decryptFileToPath()` posture.

Convergence remains intentionally deterministic within one compression
descriptor and one key epoch (the KEK feeds both key and nonce, so the same
payload under a rotated KEK is a dedup miss across epochs — unchanged from
today). Same KEK plus same plaintext plus same zstd version and level yields
the same zstd frame, the same `payloadSha`, and the same ciphertext, so dedup
remains intact. The cross-domain case is also convergence, not reuse: a raw
file whose plaintext bytes equal another entry's zstd frame derives the same
(key, nonce) and encrypts the SAME bytes — one shared blob, each entry
decrypting correctly through its own descriptor. If a future zstd version emits a different frame for the same plaintext,
that produces a different `payloadSha` and therefore a different `(key, nonce)`.
The result is a dedup miss, never nonce reuse. The storage cost of version drift
is bounded because unchanged files carry their existing descriptors forward;
only newly changed files re-encrypt.

The decompression-bomb posture needs honesty (review finding, both
reviewers): the decrypt pipeline streams `decipher → zstd → destination`, so
decompressed bytes land BEFORE the GCM tag finalizes at stream end —
"authenticated before decompression" is false for a streaming AEAD. GCM
proves a KEK holder produced the payload, not that it is safe to expand: in a
shared-KEK multi-device workspace, one member (or a buggy writer) could
commit an entry that expands to fill co-members' disks before any check
fires. Therefore the read path MUST bound decompressed output to
`entry.size` (commit-chain-authenticated, already carried) and abort the
moment output exceeds it — a small counting transform between the
decompressor and the destination. With the cap, the residual surface is
bounded by the manifest's own declared sizes.

## 3. Manifest format

File entries get an optional compression descriptor:

```ts
comp?: "zstd";
payloadSha?: string; // 64 lowercase hex, required iff comp
cipherSize?: number; // encrypted stored bytes, required iff comp
```

The descriptor is intentionally tied to `comp`. `payloadSha` is required when
`comp` is present and forbidden when it is absent. `cipherSize` is also required
when `comp` is present and forbidden when it is absent. The validator enforces
both directions. `entry.sha256` remains the plaintext identity and final
download check. `entry.encSha` remains the ciphertext address.

The current base `FileEntry` already carries `sha256`, `size`, `mode`, `type`,
and optional `encSha`. Design 79 extends that entry only for compressed file
blobs. Raw entries keep the existing shape and remain readable by the existing
raw decrypt path.

Git artifact refs and git sections got descriptor-aware fields in the prototype,
but the git lane does not compress in this design. Git bundles and packfiles are
already zlib-compressed, and the 0.95 ratio heuristic would reject them
per-file anyway. Skipping the lane avoids spending compression attempts on
multi-hundred-MB bundles. The fields stay available for forward compatibility,
and that compatibility must be real (review findings, both reviewers): the
validator gates git `comp` fields behind schema 4 exactly like file entries
(a schema-3 section carrying them is rejected), git compression fields count
toward the schema-4 stamping rule, and the index-ref construction in
`git/apply.ts` must thread `comp`/`payloadSha` the way the bundle path
(`gitSectionNewestLink`) already does — the prototype drops them there, which
would silently break a future git-lane writer. Capture emits raw git
artifacts.

Commit blob accounting must charge and GC-root the stored encrypted bytes. For
compressed file entries, `blobRefs` contributes `cipherSize`, not plaintext
`size`. This is an accounting correction: the server still sees only opaque
ciphertext addresses and byte counts.

## 4. Compatibility gate - manifestSchema 4

The production change raises `KNOWN_MANIFEST_SCHEMA` from 3 to 4. A manifest
containing any compressed entry must stamp `manifestSchema: 4`, and validation
rejects a compressed entry under schema 1, 2, or 3 with:

```text
compressed entries require manifestSchema >= 4
```

This rides the existing schema gate. Current validation already refuses a
manifest whose `manifestSchema` is greater than `KNOWN_MANIFEST_SCHEMA` with:

```text
manifest schema 4 is newer than this client understands — upgrade rbox
```

That is the desired old-client behavior for v0.9.6 and older: one loud refusal
for the whole manifest, no per-file GCM failures, and no partial local state.

For that guarantee to hold, the gate must sit at the decode boundary (review
finding, both reviewers, the one blocker): today only `pull()` calls
`validateManifest`; `decodeManifestAt()` raw-parses, so `rbox versions` /
`rbox restore` on an old client would reach `decryptFileToPath` with the
wrong derivation and fail per-file GCM — a loud error with the wrong message,
exactly what this section promises cannot happen. Design 79 moves manifest
validation INSIDE the E2EE manifest decode boundary so latest, history,
path-history, and restore all pass the same schema gate.

The stamping rule is:

```ts
manifestSchema = max(gitReposManifestSchema(gitRepos) ?? 1, anyCompEntry ? 4 : 0);
```

In prose: git still determines the schema when compression produced no
compressed entries. Merely enabling the environment flag does not stamp schema 4
if every file stays raw. The first committed compressed entry lifts the manifest
to schema 4.

The sticky consequence is real. Once a compressed entry is committed,
carry-forward preserves its descriptor, and that workspace's manifests remain
schema 4 even if the write flag is later unset. New encryptions go raw, but old
compressed blobs remain referenced. Fully reverting a workspace to schema 3
means touching and re-pushing those files so they re-encrypt raw. That is
acceptable because the gate exists precisely to ensure the fleet is upgraded
before any compressed entry is committed.

A client downgraded below v0.9.7 after compressed entries exist refuses to sync
until it is re-upgraded. This is the same posture as schema 3 pack chains.

## 5. Write-side behavior

Compression applies only to the files lane, inside `encryptFileToTemp()`.

The rule is:

1. take the existing immutable snapshot;
2. compress only when plaintext size is at least 128 bytes;
3. use zstd level 3;
4. accept the compressed payload only when `compressedBytes < 0.95 * plaintextBytes`;
5. otherwise emit the raw blob path.

The ratio test handles media and archives without extension policy. If the file
does not materially shrink, it stays raw and remains byte-for-byte compatible
with the existing derivation.

The descriptor travels as a unit. Three write-side paths reattach an existing
ciphertext to a file entry without re-encrypting: base-manifest carry-forward
(unchanged files), the encrypt-address cache (design 75), and the upload-retry
re-adopt path. Each must copy or clear `comp`/`payloadSha`/`cipherSize`
together with `encSha` — a path that moves `encSha` alone reattaches a
compressed ciphertext without the hash needed to decrypt it. The prototype
implements all three; any future path that reuses an address inherits this
rule.

Level 3 is fixed. The measured corpus had level 6 buying only about one
percentage point over level 3 for roughly twice the CPU, while level 1 gave up
about six points. Level 3 is the knee. It is not configurable: fewer knobs keep
the fleet easier to reason about, and determinism per zstd version matters for
dedup.

Rollout is single-phase (founder decision 2026-07-07: the fleet is two
machines, both owned; breaking-change ceremony is not warranted): **v0.9.7
ships read support always-on and writes default ON**, with `RBOX_COMPRESS=0`
as the opt-out. Operationally: upgrade every machine AND restart its daemon
(a long-running pre-0.9.7 daemon process keeps the old code until restarted —
review finding) before the first compressed push; the schema-4 gate turns any
ordering mistake into a loud upgrade prompt rather than corruption.

The opt-out is scoped precisely (review finding): `RBOX_COMPRESS=0` gates NEW
encryptions only. Base-manifest carry-forward and encrypt-cache hits still
reattach existing compressed descriptors — by design, since the descriptor
describes the ciphertext that exists on the server. Tests must pin both
halves: env-off fresh encryptions are byte-identical to v0.9.6, and env-off
reuse of a compressed base entry keeps its full descriptor.

The prototype exposed one required polish item on small files. Its compressed
path moved from about 4.5ms/blob raw to 13.1ms/blob because every file paid
stream-pipeline setup plus an extra compressed-temp write. Files at or below
4 MiB should compress in memory with `zstdCompressSync()` on the snapshot
buffer, hash that compressed buffer, and encrypt from the buffer without a
compressed temp file. Larger files keep the streaming path. The target is
compressed-path encrypt overhead no worse than about 2x raw.

## 6. Read-side behavior

The read path is descriptor-driven. `stageEntryToTemp()` already owns the file
apply boundary: for encrypted files it fetches by `entry.encSha`, stages a
ciphertext temp, calls `decryptFileToPath()`, then chmods the result. Design 79
keeps that boundary and changes the descriptor passed into it.

For compressed entries, `stageEntryToTemp()` uses `entry.cipherSize` as the
download size hint. The current raw hint is `entry.size + BLOB_CIPHERTEXT_TAG_BYTES`;
that is wrong for compressed entries because plaintext size no longer predicts
stored bytes. The function then passes `comp` and `payloadSha` to the decrypt
path. Decrypt streams:

```text
ciphertext body -> AES-GCM decipher -> zstd decompressor -> destination temp
```

and then verifies the destination plaintext hash against `entry.sha256`. The
decompressor's output is capped at `entry.size` (§2): a counting transform
aborts the pipeline the moment output exceeds the manifest's declared size,
so a hostile or corrupt frame cannot expand past what the commit chain
authorizes. Read support presumes a zstd-capable runtime (`node:zlib`
`createZstdDecompress` — Bun ≥ 1.3.x as shipped in release binaries); the
helper throws a clear error if the runtime lacks it, and that floor is a
prerequisite of the read-support guarantee.

An empty ciphertext body with `comp: "zstd"` is an error. Compressed frames are
never zero bytes, and compression is not even attempted for plaintext below
128 bytes. Empty raw files keep today's tag-only GCM special case.

The batch-transport interaction is deliberately limited. Compressed records are
about 5x smaller in the measured prototype, so a 32-sha batch carries about 5x
fewer bytes against design 77's 8 MiB body cap. Raising records per request is
explicitly deferred to design 80 measurements. The join A/B showed the
small-blob phase is request-bound; the fix is fewer requests, and that lever
belongs with the batch work.

## 7. Rollout and verification

Implementation starts from prototype commit `6d4298f` rebased onto main, then
adds the production polish and gates from this document:

1. schema-4 stamping when any entry (file or git) carries `comp`;
2. validation for `comp`, `payloadSha`, and `cipherSize` on file entries AND
   git sections, including rejection under schema less than 4;
3. manifest validation moved into the E2EE decode boundary
   (`decodeManifestAt`), with a test proving `versions`/`restore` hit the
   schema gate (the review blocker);
4. the decompression output cap at `entry.size` in the decrypt pipeline;
5. the git index-ref descriptor threading in `git/apply.ts` (parity with the
   bundle path);
6. an old-client rejection test by exercising the existing validator gate with
   a schema-4 manifest against a schema-3 client constant;
7. the small-file buffered compression path;
8. fake-server E2EE round-trip coverage for a mixed raw/compressed corpus;
9. an `RBOX_COMPRESS=0` byte-identity pin for fresh encryptions, plus a
   descriptor-carry pin for env-off reuse of compressed base entries.

Release v0.9.7 ships read support plus default-on writes (§5). Upgrade both
machines and restart their daemons, then run the acceptance measurement: a
full-corpus throwaway publish from wired networking with compression on,
followed by a fresh join of it. The projected 118s to about 85s join is
inferred today; that run converts it to measured. Note the existing real
workspace's blobs stay raw until re-pushed — its joins do not speed up until
a migration (re-push or republish-and-rebind), which is a separate decision.

Success criteria:

1. the measured compressed join's fetch phase is materially below the raw
   baseline;
2. no integrity errors across the fleet in normal use;
3. the byte-identity and descriptor-carry pins hold in CI.

## 8. Non-goals

1. No batch upload endpoint and no request-floor work. That is design 80.
2. No git-lane compression. Git packfiles and bundles are already compressed,
   the heuristic rejects them, and the lane stays raw.
3. No dictionary compression, per-extension policy, or configurable zstd level.
   Those were cut because the measurements do not justify the complexity.
4. No server changes. Blobs remain opaque, E2EE holds, and the server does not
   learn that compression happened. As today, object sizes remain visible through
   ciphertext byte counts; design 79 does not change that size-oracle posture.
