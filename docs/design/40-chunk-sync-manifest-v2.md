# §40 — Chunk/block sync for large-file deltas (manifest v2)

**Status:** PROTOTYPE-TRACK, **GATED — not a committed build.** This is the marquee
architectural bet from the performance proposal (C4 "chunk/block sync" + D3 "chunked file
Module"), written up honestly at first-draft depth (no adversarial review yet). **It must
NOT be built until two gates clear:** (a) **§35 client phase metrics + the large-file-edit
bench corpus** show that large-file deltas are a real, first-order cost for rbox's *actual*
workload — which today's only dogfood (`conductor/workspaces`, 65,421 files / 11,925 unique
blobs / 2.68 GB → 192s push / 433s pull, `perf-improvements.md` §30) does **NOT** confirm,
because that run was small-file / request- and filesystem-bound, not large-file-delta-bound;
and (b) the **target-workload question** (proposal open-question #1: dev monorepos vs
design/media vs VM/image archives vs home-directory backup) is answered. For the small-file
workload we can actually observe, **packfiles (C5) would help more than chunking.** This
design is the plan we execute *if and when* the metrics say large-file editing is where rbox
users live — not before. It also carries **hard dependencies** on §30 (cap-headroom re-pass)
and §12 (manifest-metadata E2EE decision) that must be resolved *before* any ship. Its two gate
docs, §35 (client phase metrics) and §36 (blob-pipeline Module, the reconstruction owner), are
now written as sibling designs — see them for the measurement foundation and the pipeline seam
respectively.

**Implements (forward, conditional):** proposal C4 + D3 (`performance-architecture-proposal.md`
§446-494, §665-679). **Hard-depends on:** §30 (ref caps), §12 (E2EE / shape leak), the §36
blob-pipeline Module (reconstruction owner), §24 (sidecar machinery, reused). **Composes with:**
C5 packfiles (§ interactions).

**Prior evaluations.** Block/delta sync has been deferred as "future research" at least three
times, and **never rejected**: `docs/perf-improvements.md:141` ("evaluate block-level content
hashes and rsync/Syncthing-style indexes … explicitly *not* part of the current P0"),
`docs/design/26-batch-upload.md:47` ("Not block-level delta sync … separate future research"),
and `docs/learnings.md:157` ("block/delta work are follow-ups, not a redesign … measured additions
on top of the blob/journal split, not a replacement"). The whole-file blob choice is deliberate
(`docs/design/05-encryption.md:26`: convergent DEK so identical plaintext dedups). This is the
first full write-up of the chunked alternative, and it keeps that "measured addition, not
replacement" framing exactly — which is why the gate above is the design, not a footnote to it.

---

## Should we build this? (read this section first)

**The honest tension: we are optimizing a workload we have not confirmed is rbox's.**

Chunk sync makes exactly one thing fast: **editing a small region of a large file.** A 4 KB
change in a 2 GB file should move ~4 KB of chunks, not 2 GB. That is a genuine, physics-level
win — no amount of R2 tuning or client concurrency beats a protocol that stops asking for
whole-file replacement (`performance-architecture-proposal.md` §447-452, the "only way to beat
whole-file physics" line in the priority table, §774).

But the **only real dogfood corpus we have** points the other way. The `conductor/workspaces`
run (`perf-improvements.md` §503-536) was **65,421 files → 11,925 unique blobs → 2.68 GB**, and
its cost was **transfer + 65k filesystem writes**, not large-file deltas:

- Push 192s: "bandwidth/CPU-bound … encrypt pass + ~30 MB/s uplink; the §30 commit added
  negligible wall time."
- Pull 433s: "download + 65k-file write."
- "Commit time was negligible compared with transfer, decrypt, and writing 65k files"
  (`performance-architecture-proposal.md` §66-68).

That is a **many-small-file** shape. Nothing in it is a large file being edited in place. The
whole prior perf cycle's recurring lesson was "**measure end-to-end before believing a design**"
— §23's own 10-round staging design was a 2.4× *regression* until direct-write won, and §26/§27
"failed their own gates" once measured (`perf-improvements.md` §393-410, §447-497). Chunk sync
is a **High-risk / Very-high-impact** bet in the proposal's own table (§774) precisely because
that impact is **conditional on a workload we have not yet seen in our telemetry.**

**Therefore the gate is not optional, it is the design:**

1. **§35 must land first** and the **large-file-edit bench corpus** (proposal Phase 0,
   §723-728) must show that a meaningful fraction of real user bytes are re-uploads of
   *slightly-changed large files*. If §35 says users push monorepos and home directories full
   of small files that rarely mutate in place, **chunk sync is the wrong build** and **C5
   packfiles** (fewer R2 GETs on cold clone, better for the 65k-small-file shape,
   `performance-architecture-proposal.md` §506-538) is the higher-ROI move.
2. **The target-workload question (open-question #1) must be answered.** The chunk-size
   tuning, the threshold, and even whether CDC vs fixed-block is right all depend on whether
   the first-class target is dev monorepos (mostly small source files — chunking barely
   helps), design/media (large, often *fully* rewritten on export — chunking helps only if
   edits are incremental), or VM/image archives (large, genuinely block-mutated — chunking's
   sweet spot). We do not know which yet.

**Recommendation:** keep this on the prototype track. Build §35 + the bench corpus, run the
large-file-edit workload, and only then decide. If the number is there, this design is ready.
If it isn't, this doc is the record of *why we didn't build it*, which is worth as much.

## Problem

rbox stores every file as a **whole-file convergent-encrypted blob.** The content address is
derived from the plaintext: `deriveKeyNonce(kek, plaintextSha)` runs a single
`HKDF-SHA256(ikm=KEK, salt="rbox/blob/v1", info=plaintextSha)` → 44 bytes → 32-byte key +
12-byte nonce (`src/engine/crypto.ts:44-46`), and the stored object is addressed by
`encSha = sha256(ciphertext‖tag)`, "known only after encryption"
(`src/engine/crypto.ts:61-77`). The manifest carries one `encSha` per file
(`src/engine/types.ts:24-27`).

The consequence is unavoidable at the protocol level: **any edit changes the plaintext sha →
a different key AND nonce → entirely different ciphertext → a brand-new `encSha`.** There is
no relationship between the old blob and the new one. So a 4 KB edit in the middle of a 2 GB
file:

- re-hashes 2 GB (scan + the fresh re-hash in `encryptFileToTemp`, `crypto.ts:62`),
- re-encrypts 2 GB to a new ciphertext temp (`crypto.ts:70-71`),
- uploads a new 2 GB blob under a new `encSha`,
- and on every *other* host, downloads that whole 2 GB and decrypt-verifies it against the
  new plaintext sha (`decryptFileToPath`, `crypto.ts:85-111`; `apply.ts:139-144`).

**R2 cannot fix this.** No amount of transfer tuning, presigned URLs (proposal S4), or
multipart parallelism (C2) changes the fact that *the protocol asked for a whole-file
replacement.* This is the single biggest remaining architectural ceiling for large files, and
it is a **byte-volume** ceiling, not a request-overhead or D1 ceiling — the two the last cycle
already cleared. It is invisible in our current dogfood only because that corpus has no large
mutating files (see "Should we build this?").

## Root cause

Convergent whole-file encryption ties the **unit of dedup/transfer** (one blob) to the **unit
of change detection** (the whole file). The two want to be different sizes. A file's *content*
changes locally — a region — but its *address* changes globally, because the address is a hash
of the entire plaintext and the crypto is deliberately all-or-nothing (one GCM stream, tag at
EOF, `crypto.ts:70-72`).

The fix is to make the **blob unit smaller than the file** so a local plaintext change maps to
a local set of changed blobs, while keeping *every other property* of the current scheme —
convergent keys, zero server trust, content-addressed dedup, refset accounting. In other words:
change the *granularity* of the blob, not the *cryptography* of the blob.

The load-bearing subtlety is **where the chunk boundaries fall.** Fixed-offset chunking fails:
inserting one byte near the start of a file shifts every subsequent block, changing every
downstream chunk's plaintext and thus every downstream `encSha` — you'd re-upload the whole
tail, defeating the point. **Content-defined chunking (CDC)** places boundaries based on a
rolling hash of a sliding window of the *content itself*, so an insertion perturbs only the one
or two chunks around the edit and re-synchronizes; the boundaries downstream re-land in the
same content-relative places. That property — insertion/deletion resilience — is the entire
reason to prefer CDC over fixed blocks, and the entire reason chunk sync can beat whole-file
physics.

## Design (manifest v2, behind a version seam)

### 3.1 The version seam

Introduce **manifest v2.** The `Manifest` type (`src/engine/types.ts:73-78`) gains an explicit
version discriminant; today's whole-file manifests are v1 (implicitly). A v2 manifest may
contain **both** whole-file entries (unchanged `FileEntry` with a single `encSha`,
`types.ts:24-27`) **and** chunked entries. The seam is the hard compatibility contract:

- **New clients** read and write v2. They keep emitting v1-shaped whole-file entries for small
  files, so a v2 manifest that happens to contain no chunked files is byte-identical in
  behavior to v1.
- **Existing whole-file blobs stay valid forever.** Nothing migrates eagerly. A legacy large
  file becomes chunked only on its **next write** (see §3.6).
- **Old clients MUST reject an unsupported manifest version cleanly** — fail closed with a
  clear "this workspace uses a newer format; upgrade rbox" error, **never** silently drop the
  chunked entries or, worse, treat a chunked file as an empty/whole-file blob and corrupt the
  tree. This mirrors the E2EE fail-closed discipline: "clients reject … changed KDF/alg
  metadata, never 'repair' … never accept a server-driven downgrade" (`12-full-e2ee.md:343-348`).
  The version gate is checked **before** any manifest entry is acted on, at decrypt/parse time,
  the same place §12 already rejects malformed signed objects.

### 3.2 Which files get chunked

A file is chunked iff its size exceeds `CHUNK_THRESHOLD` (a tunable; a first guess is on the
order of 8-16 MiB, but **this is exactly what the §35 bench corpus must set** — see open
questions). Below the threshold, files stay whole-file blobs: chunking a 40 KB source file adds
CDC + per-chunk-crypto overhead and more refs for no delta benefit, and the small-file corpus
is where **packfiles**, not chunking, is the right lever. The threshold keeps chunking scoped
to the files where the whole-file re-upload actually hurts.

### 3.3 Content-defined chunking

Split the plaintext with a **content-defined chunker** (FastCDC or a Buzhash rolling hash),
target chunk size **1-4 MiB** for workstation files (revisit for VM images and media, where
larger targets may win). New module `src/engine/chunker.ts`:

```
chunkFile(srcPath) -> Chunk[]                 // streams the plaintext once
  Chunk = { plaintextSha, plaintextSize, offset }   // offset for ordered reconstruction
```

CDC parameters (min/avg/max chunk size, the rolling-hash mask) are fixed constants so **every
client chunks identical content identically** — chunk boundaries must be deterministic across
hosts or dedup breaks. (Same discipline as the pinned JCS canonicalization in §12: consensus
requires everyone compute the same bytes, `12-full-e2ee.md:231-237`.)

### 3.4 Per-chunk crypto — identical scheme, smaller unit

**Each chunk is encrypted independently with exactly today's convergent scheme.** For each
chunk, derive `(key, nonce) = HKDF-SHA256(ikm=KEK, salt="rbox/blob/v1", info=chunkPlaintextSha)`
— the **same** `deriveKeyNonce` (`crypto.ts:44-46`), the **same** constant AAD `rbox/blob/v1`
(`crypto.ts:25`), the **same** AES-256-GCM with the tag at EOF (`crypto.ts:70-72`), producing a
chunk `encSha = sha256(chunkCiphertext‖tag)` exactly like `encryptFileToTemp` (`crypto.ts:61-77`).
A chunk is, cryptographically, just a smaller blob.

This means **zero new server trust and zero new crypto primitives.** The server still sees only
encrypted chunk refs (`encSha`s) and their ciphertext sizes — the identical residual it already
sees for whole-file blobs (`12-full-e2ee.md:368-380`). Convergent chunk dedup holds within a
(workspace, keyEpoch) exactly as blob dedup does (`12-full-e2ee.md:126-130`), which is a **bonus
win**: identical chunks across file copies, renames, and near-duplicate files inside a workspace
dedup for free (`performance-architecture-proposal.md` §484). It is **not** GCM nonce reuse: the
`(key,nonce)` pair repeats only for identical chunk plaintext, producing identical ciphertext —
the intended dedup, the same argument §12 makes for whole-file blobs (`12-full-e2ee.md:128-131`).

The convergent-derivation subtlety already handled for whole files (`crypto.ts:62` re-hashes the
real bytes rather than trusting a stale cache) applies per-chunk: the key derives from the chunk
plaintext sha the chunker actually produced this pass, never a cached value.

### 3.5 The chunk-list sidecar (reuse §24 machinery)

A chunked file entry does **not** inline its chunk list in the manifest — a 2 GB file at 1-4 MiB
is ~500-2000 chunks, and inlining that per file would bloat the encrypted manifest. Instead the
entry points to a **chunk-list sidecar**, reusing the §24 blobRef-sidecar machinery
(`24-blobref-sidecar.md`): a content-addressed R2 object in the canonical `rbox-refset-v1`-style
binary encoding (magic ‖ `u32be count` ‖ `count × (…)`, strict-parsed, size-bounded,
descriptor-matched — `24-blobref-sidecar.md:94-102`). The chunk-list sidecar records, per chunk
in order:

- chunk **plaintext size** (for offset math / reconstruction),
- chunk **plaintext sha** (the convergent-key input + per-chunk decrypt-verify target),
- chunk **encrypted sha** (`encSha` — the R2 address + what's charged/GC-rooted),

plus, in the file entry, the **total file plaintext hash** (the whole-file `sha256`, which stays
the file's content identity in `FileEntry.sha256`, `types.ts:13-14`) — the value the reconstructed
file is verified against before publish. The sidecar itself is a blob addressed by its own hash,
uploaded and charged like any other (`24-blobref-sidecar.md:100-108`), and — critically — it is
one of the file entry's refs, so it flows through validate/accounting/GC as an ordinary ref.

The v2 `FileEntry` (chunked variant) therefore carries roughly: `{ path, sha256 (total plaintext),
size, mode, chunkSidecarSha, chunkCount }` and no single `encSha`. All of it rides **inside** the
E2EE-encrypted manifest, so — like the git artifact refs (`types.ts:37-45`) — none of it is
server-visible plaintext *in the manifest*; the shape-leak concern (§ Risks R2) is about the
sidecar object and the chunk refs the server *does* store, not the manifest.

### 3.6 Push (chunk planning)

Live inside the §36 blob-pipeline Module (the D3/C1 "chunked file Module" —
`performance-architecture-proposal.md` §665-679), which must **own** chunking + reconstruction
so it doesn't smear across sync/apply:

1. Scan flags a changed file over `CHUNK_THRESHOLD`.
2. `chunkFile` streams the plaintext once, producing the ordered chunk list (§3.3).
3. For each chunk, derive+encrypt (§3.4) → `encSha` + ciphertext temp.
4. `missingBlobs`/receipts preflight (existing) tells us **which chunk `encSha`s the server
   already has** — the delta. Only missing chunks upload. **This is the whole win:** a 4 KB edit
   yields ~1-2 new chunks; the other ~500-2000 chunk `encSha`s are unchanged and already present.
5. Build + upload the chunk-list sidecar (§3.5).
6. Commit references: the sidecar `encSha` + every chunk `encSha` (present or newly uploaded) +
   the encManifest — all as ordinary blobRefs through the existing signed-commit / §24-sidecar
   path.

A legacy whole-file large file **migrates on this next write**: its old whole-file `encSha` is
simply superseded by the chunked entry; GC reclaims the old whole-file blob once it leaves the
reachable set (`33-per-account-gc.md`), no special migration code.

### 3.7 Pull / restore (reconstruction)

Also owned by the §36 pipeline Module, at the §36/`apply.ts` boundary (`apply.ts:56-121` is the
precondition-checked, atomic-publish writer; reconstruction stages into the same `tmp`-then-`rename`
model, `apply.ts:97-121`):

1. Decrypt the manifest, hit the version gate (§3.1), read the chunked entry + fetch the
   chunk-list sidecar.
2. Compute the **missing** chunk set: chunks whose plaintext already matches on disk (from the
   local file, if present — the delta-download win) or already cached don't refetch; fetch only
   **missing encrypted chunks** by `encSha`.
3. Decrypt each chunk and verify its plaintext sha (per-chunk `decryptFileToPath`-equivalent,
   `crypto.ts:85-111`).
4. **Reconstruct the file in chunk order** into a plaintext temp (offsets from sidecar sizes).
5. **Verify the reconstructed file's total plaintext hash equals the entry's `sha256`** BEFORE
   the atomic publish (`apply.ts:115-121`). This is the whole-file integrity backstop: even if
   chunk boundaries or ordering were wrong, the final hash catches it and the publish is refused
   (fail closed).
6. Atomic `rename` into place (`apply.ts:121`), preserving the existing conflict-copy /
   precondition semantics unchanged.

### 3.8 Commit accounting (reuse §30 refset machinery)

**Chunks are just more blob refs.** `validateCommitRefs` + `commitAccounting`
(`apps/api/src/commit-accounting.ts:53-124`) charge/grant a chunked file's chunk `encSha`s and its
sidecar `encSha` identically to whole-file refs — the have-set / newRefs / super-batch logic is
untouched in *shape*. The server does not know or care that a ref is a chunk. This is the design's
best property: **it changes the client's blob granularity and the manifest format, and touches the
server's accounting only in that there are now more refs per commit** — which is exactly the
problem the Risks section leads with.

## Files

| Area | Change |
|---|---|
| `src/engine/chunker.ts` | **new** — FastCDC/Buzhash content-defined chunker; deterministic params; streams plaintext once → ordered `Chunk[]` (§3.3) |
| `src/engine/types.ts` | manifest **version discriminant** (§3.1); chunked `FileEntry` variant (`chunkSidecarSha`, `chunkCount`, total `sha256`) alongside the whole-file variant (`types.ts:10-28, 73-78`) |
| `src/engine/manifest.ts` | scan/emit v2; threshold gate (§3.2); parse the version seam and **reject unknown versions fail-closed** |
| `src/engine/crypto.ts` | reuse `deriveKeyNonce` (`crypto.ts:44`) + `encryptFileToTemp`/`decryptFileToPath` per-chunk (`crypto.ts:61,85`) — ideally a chunk-range variant to avoid a temp file per chunk (§ open questions) |
| `src/engine/apply.ts` | reconstruction stages into the existing precondition-checked atomic-publish writer (`apply.ts:56-121`); total-hash verify before `rename` (§3.7) |
| §36 blob-pipeline Module (`src/engine/blob-pipeline.ts`, forward) | **owns** chunk planning (§3.6) + reconstruction (§3.7) — the D3 "chunked file Module" (`performance-architecture-proposal.md` §665-679) |
| §24 sidecar machinery | reused for the chunk-list sidecar (`24-blobref-sidecar.md:94-108`) — new sidecar *kind*, same encode/resolve/charge/GC-root path |
| `apps/api/src/commit-accounting.ts` | **no shape change** — chunks are ordinary refs (§3.8); but the **cap constants are the hard dependency** (`commit-accounting.ts:29,37` — Risks R1) |

## Benefits

- **A 4 KB edit in a 2 GB file uploads/downloads a few chunks, not 2 GB** — the headline, and
  the only way to beat whole-file physics (`performance-architecture-proposal.md` §483, §774).
- **Large-file sync becomes protocol-limited by *changed* bytes, not total bytes.**
- **Free intra-workspace chunk dedup** across file copies, renames, and near-duplicate large
  files (convergent chunks, §3.4) — a storage + transfer win beyond the delta case.
- **Zero new server trust, zero new crypto.** Same convergent scheme, same constant AAD, same
  GCM-tag-at-EOF, same "server sees only encrypted refs + sizes" residual (§3.4).
- **Reuses three existing subsystems wholesale:** §24 sidecars, §30 refset accounting, the §36
  pipeline / `apply.ts` atomic-publish boundary. The new surface is one chunker module + a
  manifest version field.

## Risks

These are real and several are **hard blockers to ship**, not caveats.

- **R1 — MORE REFS PER COMMIT (hard dependency on §30).** A 2 GB file at 1-4 MiB chunks is
  **~500-2000 chunk refs for ONE file.** §30's caps are `MAX_REFS_PER_TXN = 3_000`
  (super-batch, `commit-accounting.ts:29`) and `MAX_REFS_PER_COMMIT = 50_000` hard reject
  (`commit-accounting.ts:37`), and §30 explicitly notes 50k is "behind measurement" — only 12k
  is validated on real hardware (`30-large-ref-commit-accounting.md` §5). A workspace with a
  handful of multi-GB chunked files can blow past 50k refs in a single commit. **Chunk sync
  REQUIRES a §30 cap-headroom re-pass** — re-measure the D1 isolate CPU/memory ceiling at the
  ref counts chunking implies (potentially hundreds of thousands), and decide whether the cap
  rises, whether per-file chunk refs get their own sub-sidecar rollup, or whether commits split.
  **This design cannot ship before that re-pass.** State it as a gate.
- **R2 — SHAPE LEAK (decision required before ship; §12 dependency).** Chunk **boundaries +
  sizes + counts leak file structure** to the server. Where whole-file blobs leak one
  ciphertext size per file (`12-full-e2ee.md:368-380`), chunking leaks a *sequence* of
  ciphertext sizes per file — the CDC boundary positions are a fingerprint of the plaintext
  content, and the chunk count ≈ file size. The chunk-list sidecar, if stored as a plaintext
  refset (like today's §24 blobRef sidecar), hands the server the **entire chunk structure**.
  This intersects proposal open-question #2 ("how soon does manifest-metadata E2EE need to
  land? Chunk sync increases the amount of shape metadata unless chunk lists are hidden,"
  `performance-architecture-proposal.md` §824). **Chunk sync must NOT ship before deciding
  whether the chunk-list sidecar itself is encrypted** (E2EE'd like the manifest, not
  plaintext like a §24 refset) — and that decision belongs to §12's future
  manifest-metadata-E2EE work. This is a privacy regression if shipped naively.
- **R3 — MORE R2 OBJECTS (interaction with C5 packfiles).** Many small chunks worsen the
  many-small-object behavior the last cycle already saw hurt the 65k-file pull
  (`perf-improvements.md` §503-536). A chunked large file becomes hundreds of R2 objects.
  Unless combined with **packfiles / chunk aggregation (C5,
  `performance-architecture-proposal.md` §506-538, §524 "small chunks pack well")**, chunk sync
  could trade a whole-file transfer win for a request-count regression on pull. The two designs
  are complementary and may need to land together.
- **R4 — Reconstruction complexity (ownership).** File reconstruction — fetch missing chunks,
  decrypt-verify each, order by offset, verify total hash, atomic publish — is genuinely more
  complex than a single decrypt. It **must be owned by the §36 blob-pipeline Module**, not
  smeared across `apply.ts` and `sync.ts` (that spread is exactly what D1/D3 exist to fix,
  `performance-architecture-proposal.md` §636-679). One module, one Interface, one test surface.
- **R5 — Worst case must not regress whole-file.** A **random full rewrite** of a large file
  (no chunks reusable) pays CDC overhead + per-chunk key derivation + per-chunk GCM setup on
  top of the bytes it would have moved anyway. This must **not perform materially worse than
  the whole-file path.** Per-chunk temp-file churn (a temp per chunk, à la `crypto.ts:68`) is a
  likely culprit and argues for a chunk-range crypto variant that avoids N temp files. The
  validation gate must prove the worst case is ≤ whole-file cost.

## Validation gate (from the proposal, §497-502)

The prototype is not "working" until all of these pass on the §35 bench corpus:

1. **Delta upload.** 2 GB file, modify 4 KB near **beginning / middle / end** → **uploaded
   bytes under 20 MB** in every position (proves CDC localizes the change regardless of edit
   position).
2. **Insertion resilience.** A random insertion that shifts content → **CDC preserves most
   chunks after the edit** (proves content-defined boundaries re-synchronize; a fixed-block
   chunker would fail this).
3. **Cross-host byte-identity.** Push on host A, pull on host B → reconstructed file is
   **byte-identical** (total-hash verify holds, `apply.ts` publish semantics intact).
4. **Worst-case bound.** Random full rewrite of the large file → **≤ whole-file cost** (R5) —
   CDC + per-chunk crypto overhead does not make a genuine full rewrite slower than today.
5. **(Gate-adjacent) Ref-count sanity.** The chunk counts these files produce must fit under
   whatever §30's re-pass sets (R1) — measure it here, not in production.

## Interactions

- **§30 (large-ref accounting) — HARD DEPENDENCY.** Cap headroom must be re-established for the
  ref counts chunking implies (R1). Blocking.
- **§12 (full E2EE) — HARD DEPENDENCY.** The chunk-list sidecar's shape leak forces the
  manifest-metadata-E2EE decision (R2). Blocking on a decision, if not on the full build.
- **§24 (blobRef sidecar) — REUSED.** The chunk-list sidecar is a new *kind* of §24 sidecar;
  same binary encoding, resolve, charge, and GC-root machinery (`24-blobref-sidecar.md:94-160`).
- **§36 blob-pipeline Module (C1/D3) — OWNER.** Chunk planning + reconstruction live here; this
  design assumes §36 exists first. Chunk sync is the reason D3 (the "chunked file Module") is in
  the proposal at all.
- **§35 client phase metrics + bench corpus — GATE.** The decision input. Nothing builds until
  §35 says large-file deltas are real for rbox's workload.
- **C5 packfiles — COMPLEMENT.** May need to land together (R3); small chunks pack well
  (`performance-architecture-proposal.md` §524). Also the *rival* build if §35 says the
  workload is small-file, not large-delta.
- **§33 (per-account GC) — UNCHANGED.** Chunks are ordinary blob refs; superseded whole-file
  blobs and orphaned chunks reclaim through the existing reachability GC with no special-casing.

## Open questions

1. **(THE GATE) What is the first-class target workload** — dev monorepos, design/media,
   VM/image archives, or home-directory backup (proposal open-question #1,
   `performance-architecture-proposal.md` §821)? Chunk size, threshold, and even the
   CDC-vs-fixed decision hinge on this, and **whether we build at all** hinges on §35 confirming
   large-file deltas are a real cost. Until answered, this stays prototype-track.
2. **How soon must manifest-metadata E2EE land** (proposal open-question #2, §824)? Chunk sync
   increases shape metadata (R2). Is the chunk-list sidecar encrypted from day one, or is that a
   later §12 milestone that chunk sync must wait for?
3. **§30 cap-headroom (R1).** What is the real D1-isolate ref ceiling at chunk-implied counts
   (hundreds of thousands)? Does the cap rise, do per-file chunk refs get a rollup sub-sidecar,
   or do large commits split? This must be measured before ship.
4. **Chunk size + threshold.** 1-4 MiB target and an ~8-16 MiB `CHUNK_THRESHOLD` are first
   guesses; the §35 bench corpus sets the real numbers, and they likely differ for source trees
   vs VM images vs media.
5. **Per-chunk crypto without N temp files.** Today's `encryptFileToTemp`/`decryptFileToPath`
   are file-oriented (`crypto.ts:61,85`). A chunk-range crypto variant (encrypt/decrypt a
   plaintext range in memory / into one shared temp) is likely needed to keep the worst case
   (R5) honest and avoid fd/temp explosion on a 2000-chunk file.
