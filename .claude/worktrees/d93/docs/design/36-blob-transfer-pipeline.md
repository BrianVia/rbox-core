# §36 — Blob transfer pipeline Module (one deep Interface, two fewer disk passes)

**Status:** DRAFT v1 — design only, no implementation, **no adversarial review yet**.
First-draft consolidation of the encrypted upload/download pipeline (proposal C1 / D1,
`docs/performance-architecture-proposal.md:316-391, 636-650`). Two concrete, measured
redundant disk passes are removed — the push-side ciphertext **re-read** (`crypto.ts:75`)
and the pull-side `.ct` **intermediate temp** (`apply.ts:140-146`) — behind a small
Module Interface that also becomes the home for §34 adaptive concurrency / retry
classification and §35 phase metrics. **This is the highest-value clean client win: pure
Locality + IO reduction, zero protocol change, zero E2EE change.** Supersedes nothing;
consolidates logic today smeared across `src/cli/sync.ts`, `src/engine/crypto.ts`,
`src/cli/remote.ts`, `src/engine/apply.ts`.

**Implements (forward):** proposal Phase 2 "pipeline depth"; unblocks §34's per-account
rate fairness (the adaptive pool needs one transport chokepoint) and §35's phase metrics
(emitted from inside the pipeline, not reconstructed by callers).

**Prior evaluations.** The double-pass hash has been a flagged *suspect* for cycles, never yet
acted on: `docs/perf-improvements.md:150` ("Encrypt double-pass: `encryptFileToTemp` hashes
plaintext then ciphertext … reuse it? (bench the win first)"), `docs/backlog.md:43`, and
`docs/architecture.html:108` ("double-pass hash (suspect)"). This doc formalizes the fix — but,
consistent with the governing lesson that four times the simple lever beat the complex build, it
stays gated on §35 quantifying the prize (the `encrypt.cthash` phase + temp-bytes written) before
any implementation. It re-opens nothing; it retires a long-standing TODO with a measurement.

---

## Problem

The encrypted transfer path is **shallow across four Modules**, and the seams between them
cost two full disk passes on the two byte-dominated operations rbox has (`perf-improvements`
dogfood: the real `~/conductor/workspaces` push was **65,421 files / 11,925 unique blobs /
2.68 GB ciphertext in 192 s**, and cross-host pull took **433 s** — dominated by transfer,
crypto, and disk, with commit time negligible: proposal `:64-68`). Every avoidable pass
over 2.68 GB is real wall time.

**Push redundancy — the ciphertext is written, then read again just to hash it.**
`encryptFileToTemp` (`crypto.ts:61`) does:

1. `plaintextSha = await hashFile(srcPath)` (`crypto.ts:62`) — a fresh plaintext pass. This
   is **fundamental** and must stay (see Constraints): convergent encryption derives *both*
   the key and the nonce from the plaintext sha in one HKDF (`deriveKeyNonce`, `crypto.ts:44`),
   so a stale/cached hash here breaks convergence outright.
2. stream AES-256-GCM encrypt `srcPath` → temp `.ct`, append the 16-byte auth tag at EOF
   (`crypto.ts:70-73`).
3. `encSha = await hashFile(ctPath)` (`crypto.ts:75`) — **re-reads the entire ciphertext temp
   from disk solely to content-address it.** The bytes were in hand microseconds earlier as
   they streamed through the cipher.

Pass 3 is pure waste: `sha256(ciphertext‖tag)` can be computed in a transform **while writing**
the temp, for free.

**Pull redundancy — the ciphertext lands in a temp only to be immediately re-read and
deleted.** The pull writer stages an encrypted entry (`stageEntryToTemp`, `apply.ts:133`) as:

1. `store.getToFile(entry.encSha, ctTmp)` (`apply.ts:142`) → `getBlobToFile` (`remote.ts:212`)
   streams the network GET into a `.ct` temp, hashing the ciphertext inline to verify `encSha`
   (`remote.ts:215-233`).
2. `decryptFileToPath(ctTmp, kek, entry.sha256, tmp)` (`apply.ts:144`) **re-reads that `.ct`
   temp** end-to-end: reads the trailing 16-byte tag from EOF (`crypto.ts:90-95`), then streams
   the body through the decipher into a plaintext temp (`crypto.ts:108`).
3. `hashFile(destPath)` (`crypto.ts:110`) — a **third** pass, re-reading the plaintext temp to
   verify it hashes to `plaintextSha`.
4. `finally` removes the `.ct` temp (`apply.ts:146`).

So a pulled blob is written to disk **twice** (ciphertext temp + plaintext temp) and read
**three times** (verify-hash on land, decrypt, verify-hash plaintext). The `.ct` intermediate
buys nothing the network stream couldn't feed directly into the decipher — the encSha, the
decryption, and the plaintext sha can all be computed **inline in one pass** as bytes arrive.

**Locality tax.** Because the logic is spread across `sync.ts` (orchestration + encrypt/upload
pools, `sync.ts:104-128`), `crypto.ts` (encrypt/decrypt), `remote.ts` (transport + inline
verify), and `apply.ts` (temp lifetime + atomic publish), a correctness fix that touches temp
files, verification, or retry has to be made in — and kept consistent across — four files.
There is no single Interface a test can drive the way production does, and nowhere to add
adaptive concurrency, retry classification, or phase metrics without threading them through all
four. The proposal names this exactly: "Transfer logic is shallow across many Modules. Callers
coordinate temp files, hashes, progress, concurrency, receipts, and retries." (`:640-642`).

## Root cause

The encrypted-transfer *pipeline* is a real thing — hash → encrypt → address → upload on push,
download → verify → decrypt → verify → stage on pull — but it has **no Module boundary**. It is
expressed as a chain of independently-reasonable functions in different files, each owning one
disk artifact and handing the next function a **path**, not a stream. Passing a path forces the
next stage to re-open and re-read what the previous stage just wrote. The redundant passes are
not a bug in any one function; they are the **cost of the seams** — the price of decomposing a
streaming pipeline along file-handoff lines instead of behind one Interface that owns the whole
byte flow end to end.

## Design

A new deep Module — `src/engine/blob-pipeline.ts` — owns the encrypted transfer pipeline behind
a **small** Interface. It owns temp-file lifetime, hashing, receipts, retry classification,
progress, and (later) concurrency coordination. Its Implementation may contain internal seams
for crypto, transport, and metrics, but callers see only the Interface below.

### 4.1 The Interface

```ts
interface BlobPipeline {
  // PUSH: encrypt one changed file → a verified ciphertext temp ready to upload.
  // Computes plaintextSha (fresh), encSha (inline), cipherSize in ONE write pass.
  encryptFile(srcPath: string, kek: Buffer): Promise<EncryptedBlob>;

  // PUSH: upload a staged ciphertext blob (receipts, backpressure, retry, progress).
  uploadBlob(blob: EncryptedBlob): Promise<void>;

  // PULL: download ciphertext by encSha, decrypt+verify, stage a plaintext temp.
  // ONE pass network→plaintext temp; verifies encSha AND plaintextSha inline.
  stagePlaintext(encSha: string, plaintextSha: string, kek: Buffer): Promise<StagedBlob>;
}

interface EncryptedBlob { plaintextSha: string; encSha: string; ciphertextPath: string; cipherSize: number; }
interface StagedBlob    { plaintextPath: string; } // caller (apply) publishes atomically
```

`EncryptedBlob` is unchanged from today's shape (`crypto.ts:49-54`) — the push win is purely
*how* `encSha` is produced. `StagePlaintext` returns a **plaintext temp path**, not a published
file: the pipeline stages, `apply` publishes (§4.4).

### 4.2 Push — ciphertext sha inline (kill the re-read, `crypto.ts:75`)

`encryptFile` keeps the fundamental plaintext pass (`hashFile(srcPath)`) and the exact HKDF
key/nonce derivation (`deriveKeyNonce`, `crypto.ts:44`), but tees the ciphertext through a
sha256 transform **while it streams to the temp**, so `encSha` falls out at stream end with **no
second read**:

```
plaintextSha = hashFile(srcPath)                 # UNCHANGED — fundamental (Constraints)
(dek, nonce)  = deriveKeyNonce(kek, plaintextSha) # UNCHANGED
h = createHash("sha256")
pipeline(
  createReadStream(srcPath),
  cipher = createCipheriv("aes-256-gcm", dek, nonce).setAAD(AAD),   # AAD unchanged (crypto.ts:25)
  tee(chunk => h.update(chunk)),                  # ciphertext bytes hashed in flight
  createWriteStream(ctPath),
)
tag = cipher.getAuthTag(); appendFile(ctPath, tag); h.update(tag)   # tag hashed too — encSha = sha256(ct‖tag)
encSha = h.digest("hex")                          # was: hashFile(ctPath) — a full re-read
```

The tee is a trivial `Transform` (or a `hash.update` in the write stream's `write` path). Output
bytes are **byte-identical** to today (same key, nonce, AAD, tag placement); only the second disk
read disappears. `encSha` must include the appended tag exactly as `hashFile(ctPath)` did today
(the temp file = `ciphertext ‖ tag`), so we `h.update(tag)` after the body.

### 4.3 Pull — one pass, network → plaintext temp (kill the `.ct` intermediate)

`stagePlaintext` streams the network ciphertext **directly through the decipher into the
plaintext temp**, computing `encSha` (over ciphertext) and `plaintextSha` (over plaintext)
inline. This removes the `.ct` temp entirely (`apply.ts:140-146`) and collapses three reads +
two writes into **one read (network) + one write (plaintext)**.

**The trailing-tag wrinkle (the one piece to get exactly right).** AES-GCM's 16-byte auth tag
sits at EOF and **must** be `setAuthTag()`'d *before* `decipher.final()`. But we are streaming
and don't know we've hit EOF until the stream ends. So the pipeline keeps a **rolling 16-byte
tail buffer**: as ciphertext chunks arrive, everything *except the last 16 bytes seen so far* is
safe to feed to `decipher.update()`; the trailing 16 bytes are held back. At stream end the held
16 bytes are the tag → `decipher.setAuthTag(tail); decipher.final()`.

```
tail = Buffer.alloc(0)                     # holds ≤16 bytes not yet known to be body-vs-tag
encH = sha256(); plainH = sha256()
for await (chunk of networkCiphertextStream):
    encH.update(chunk)                     # encSha = sha256 over ALL ciphertext incl. tag
    buf = concat(tail, chunk)
    if buf.length > 16:
        body = buf[0 : buf.length-16]      # everything but the last 16 bytes is definitely body
        tail = buf[buf.length-16 :]
        out = decipher.update(body); plainH.update(out); plaintextWrite(out)
    else:
        tail = buf                         # not enough to know yet; hold it all
# stream ended: `tail` is exactly the 16-byte tag
decipher.setAuthTag(tail)
out = decipher.final(); plainH.update(out); plaintextWrite(out)   # final() THROWS on bad tag
assert encH.digest() == encSha            # transport integrity (server returned right bytes)
assert plainH.digest() == plaintextSha    # E2EE integrity (recovered the right plaintext)
```

Both verifications happen **without any extra pass**: `encH` over the wire bytes replaces
`getBlobToFile`'s inline verify (`remote.ts:215-233`); `plainH` over the decrypted bytes replaces
`hashFile(destPath)` (`crypto.ts:110`). On any failure — bad tag (`final()` throws), `encSha`
mismatch, `plaintextSha` mismatch, short stream — the partial plaintext temp is removed and the
error propagates, exactly as `decryptFileToPath` does today (`crypto.ts:112-115`).

**Preserve the empty-plaintext case (`crypto.ts:101-106`).** A tag-only ciphertext (empty file:
`.gitkeep`, `__init__.py`) is 16 bytes total → the loop never emits body, `tail` ends as the full
16-byte tag, `decipher.update(∅)` + `setAuthTag(tail)` + `final()` verifies the tag over zero
bytes and writes an empty plaintext. Same semantics as today, no `start/end` range math (which is
why today needs the special-case — the stream form handles it naturally). A stream shorter than
16 bytes total → `tail.length < 16` at end → hard error ("ciphertext too short", matching
`crypto.ts:88`).

### 4.4 Boundary: the pipeline STAGES, `apply` PUBLISHES

The pipeline's pull output is a **verified plaintext temp path** (`StagedBlob.plaintextPath`). It
does **not** publish. `apply.ts` keeps sole ownership of the atomic move and conflict
preservation — the precondition-checked rename that is the heart of rbox's non-destructive pull:

- `writeEntry` (`apply.ts:98`) stages, **re-checks the target against `expectedLocal`**
  (`apply.ts:116-117`), moves surprise bytes aside to a `.conflict` copy if the user edited in
  the scan→apply window (`apply.ts:117-120`), then `fs.rename(tmp, abs)` (`apply.ts:121`).
- This precondition/conflict logic is **not a transfer concern** and stays exactly where it is.
  `stageEntryToTemp` (`apply.ts:133`) simply calls `pipeline.stagePlaintext(...)` for the
  encrypted branch instead of the current `getToFile` + `decryptFileToPath` + `rm .ct` dance
  (`apply.ts:138-149`), receiving a plaintext temp to hand straight to the existing rename path.
  `restoreEntryToPath` (`apply.ts:166`, version restore) uses the same staging call.

The line is bright: **pipeline owns bytes→verified plaintext temp; apply owns temp→published
file.** Neither reaches into the other.

### 4.5 Keep the small-buffer helpers

The in-memory `encryptBytes`/`decryptBytes` helpers stay for tests and for **small
sidecar/manifest blobs** (the encrypted-manifest blob, blobref sidecars) that are already handled
as whole buffers (`remote.ts:268` `putBlobBytes`). The streaming pipeline is for file-content
blobs; forcing 200-byte manifests through a temp-file streaming path would be strictly worse.

### 4.6 Callers

`encryptAndUpload` (`sync.ts:85`) stops calling `encryptFileToTemp` directly (`sync.ts:105,124`)
and drives `pipeline.encryptFile` / `pipeline.uploadBlob` through its existing encrypt/upload
pools (`sync.ts:104-128`). The pools stay in `sync.ts` for now (the pipeline exposes per-blob
ops; §34 later moves the *blob-network* pool inside the pipeline as the adaptive pool — §7). The
missingBlobs preflight (`sync.ts:112-113`) and receipt capture (`remote.ts`) move behind
`uploadBlob` over time; v1 can keep them in `sync.ts` and tighten later without changing the
Interface.

## Constraints (do not weaken E2EE — state plainly)

1. **Key derivation stays from a FRESH plaintext hash.** `encryptFile` keeps
   `hashFile(srcPath)` (`crypto.ts:62`) as the source for `deriveKeyNonce` (`crypto.ts:44`). A
   single HKDF derives **both** key and nonce from the plaintext sha; feeding a cached or stale
   hash would derive the wrong (key, nonce) for the actual bytes — silent convergence break and,
   worse, a nonce that doesn't match the plaintext. **This pass is fundamental and non-negotiable.**
2. **AAD stays the constant `rbox/blob/v1`** (`crypto.ts:25`). Per design 12 V4-5, putting
   path/seq/epoch in blob AAD would turn intended convergence into real GCM nonce reuse. The
   pipeline sets the same constant AAD on cipher and decipher (`crypto.ts:71,97`).
3. **The server still sees only ciphertext.** The pipeline changes client-side disk IO only;
   the wire format (ciphertext ‖ 16-byte tag, addressed by `encSha`) is byte-identical. No new
   plaintext ever crosses the transport.
4. **Byte-identity is a hard output invariant.** Same plaintext + same KEK ⇒ same ciphertext,
   same `encSha`, same tag placement as today. The push change is a hashing optimization, not a
   crypto change; the pull change is a streaming reorganization, not a crypto change.

### The one sharp edge: scan-hash reuse is a SEPARATE, GATED optimization

The proposal floats reusing a fresh scan hash to skip the plaintext rehash in `encryptFile`
(`:340-343, 356-358`). **This is the only genuinely dangerous idea in C1, and it is NOT part of
this consolidation.** It is safe *only* if the pipeline can prove the file is unchanged since the
scan computed that hash — otherwise `deriveKeyNonce` gets a hash of bytes that are no longer on
disk, and the ciphertext no longer decrypts to the current file (Constraint 1). **Recommendation:
v1 always rehashes** (keep `crypto.ts:62` as-is). Hash-reuse is a follow-up, gated behind a proven
freshness check (e.g. stat identity + mtime/inode match against the scan snapshot, single-writer
assumption), tracked separately and measured on its own — it does not ride in on the core Module
consolidation. The consolidation's win (kill the ciphertext re-read + `.ct` intermediate) is
**independent** of it and carries zero E2EE risk.

## Files

- `src/engine/blob-pipeline.ts` — **new** Module. The `BlobPipeline` Interface + streaming
  Implementation (push tee-hash, pull trailing-tail decipher, temp lifetime, verify, progress).
- `src/engine/crypto.ts` — `encryptFileToTemp` (`:61`) becomes the pipeline's push internal
  (inline `encSha`, no `hashFile(ctPath)` at `:75`); `decryptFileToPath` (`:85`) folded into the
  pull streaming path (removing the `.ct` re-read at `:108` and plaintext re-hash at `:110`).
  Keep `deriveKeyNonce` (`:44`), `AAD`/`TAG_BYTES` (`:25-26`), and the buffer helpers (§4.5).
- `src/cli/remote.ts` — `getBlobToFile` (`:212`) is subsumed: the pipeline consumes the raw GET
  `ReadableStream` (`:217`) directly rather than staging a `.ct` temp. `putBlobFile`/receipt
  capture invoked via `uploadBlob`.
- `src/engine/apply.ts` — `stageEntryToTemp` encrypted branch (`:138-149`) calls
  `pipeline.stagePlaintext`; **keep** `writeEntry`'s precondition + conflict + atomic rename
  (`:98-126`) and `restoreEntryToPath` (`:166`) unchanged (§4.4).
- `src/cli/sync.ts` — `encryptAndUpload` (`:85`) drives the pipeline through its existing pools
  (`:104-128`) instead of `encryptFileToTemp` directly.

## Benefits

- **Push:** one full disk read of ciphertext removed per changed blob (2.68 GB of avoidable
  re-reads on the conductor push).
- **Pull:** the `.ct` intermediate gone — **temp bytes written roughly halved** (plaintext-only,
  no ciphertext temp), one disk write + two reads removed per pulled blob. On a 433 s / 2.68 GB
  pull this is the single largest client-side IO cut available without protocol change.
- **Locality:** temp-file, verification, and retry bugs live in one Module with one test surface
  that drives the exact code production drives (proposal `:648-650`).
- **Leverage:** one place to land §34 adaptive concurrency + retry classification and §35 phase
  metrics — instead of threading them through four files.
- **No protocol/E2EE change, no server change, no manifest change.** Pure client IO + structure.

## Interactions

- **§34 (per-account rate fairness).** The pipeline is the natural home for the adaptive
  blob-network pool and retry classification §34 needs: `uploadBlob`/`stagePlaintext` are the
  single transport chokepoint where a `429` + `Retry-After` can throttle-and-retry and where
  5xx/network/malformed responses classify as bounded-retry real errors. v1 ships the Interface;
  §34 fills the pool in without touching callers.
- **§35 (client phase metrics).** The proposal's Phase 0 metrics — encrypt-plaintext-hash,
  encrypt-write, ciphertext-hash, upload wait/wall, download wait/wall, decrypt — are exactly the
  pipeline's internal stage boundaries (proposal `:711-722`). Emitting them **from inside** the
  pipeline is correct-by-construction; reconstructing them in `sync.ts` today is guesswork.
- **`apply.ts` (unchanged boundary).** Atomic publish + conflict preservation stay in apply
  (§4.4). The pipeline never publishes; apply never decrypts.
- **Receipts / §23.** `uploadBlob` owns receipt capture; the receipts wire path and 12h TTL are
  unchanged. Consolidation only moves *where* the client captures the receipt, not the protocol.
- **§30 (large-ref accounting) / §33 (per-account GC).** Server-side, untouched. The pipeline
  changes client disk IO only; `encSha`/`plaintextSha` values, dedup, and ref accounting are
  identical.
- **C2 multipart (future).** Parallel multipart (proposal C2) plugs into `uploadBlob` as an
  upload strategy for large blobs; the trailing-tail decipher on pull is orthogonal to it.
- **C4 chunk sync (future).** When manifest v2 chunks large files, the pipeline is where chunk
  encrypt/decrypt/reconstruct lands (proposal D3 `:665-679`) — the Interface is shaped to absorb
  it (per-chunk `encryptFile`/`stagePlaintext`).

## Validation gate

- **Microbench encrypt/decrypt before/after** on 1 MB / 100 MB / 2 GB corpora — assert wall-time
  drop tracks the removed passes (push: one ciphertext read; pull: one ciphertext write + one
  ciphertext read + one plaintext read).
- **Byte-identity, Mac ↔ Linux.** Encrypt on Mac, pull on Linux (and vice versa): recovered
  plaintext is byte-identical, and `encSha` produced by the new inline path equals `encSha`
  produced by today's `hashFile(ctPath)` for the same input (regression pin against the
  crypto-change fear).
- **Adversarial inputs all fail safely, no partial publish:** wrong GCM tag (`final()` throws),
  wrong `plaintextSha` (mismatch), wrong `encSha` (transport mismatch), short/truncated
  ciphertext (< 16 bytes → "too short"), partial download (stream aborts mid-flight),
  concurrent local edit during pull (apply's precondition recheck moves bytes aside, not the
  pipeline's job — assert the boundary holds). Every failure removes the plaintext temp and
  leaves the target untouched.
- **Empty-plaintext regression:** tag-only ciphertext for `.gitkeep`/`__init__.py` stages an
  empty verified file (matching `crypto.ts:101-106`).
- **Resource metrics:** peak RSS (streaming, so flat regardless of blob size — assert no
  whole-file buffering crept in), fd count (no fd explosion under 64-wide pull), and **temp bytes
  written — expect ~halved on pull** (plaintext-only; the `.ct` intermediate is gone). This is
  the headline empirical claim.
- **E2E dogfood:** re-run the `~/conductor/workspaces` push+pull; assert push+pull wall time
  drops and the pulled tree is byte-identical to source (the design 30 / perf-improvements
  workload).

## Open questions for the founder

1. **v1 scope of `uploadBlob`.** Fold missingBlobs preflight + receipt capture inside the
   pipeline in v1, or keep them in `sync.ts` and only move blob encrypt/stage first (smaller
   diff, Interface still stable)?
2. **Pool ownership.** Keep the encrypt/upload/download pools in `sync.ts`/`apply.ts` for v1 and
   move the *blob-network* pool inside the pipeline when §34 lands, or move it now?
3. **Scan-hash reuse.** Confirm we ship the consolidation with **always-rehash** and treat
   hash-reuse as a separately-gated, separately-measured follow-up (recommended) — not part of
   this Module.
4. **Sidecar/manifest path.** Confirm small encrypted blobs keep the in-memory buffer helpers
   (§4.5) rather than routing through the streaming pipeline.
