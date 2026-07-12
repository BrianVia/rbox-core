# 106 — Manifest fold bootstrap, streaming verification, and bounded memory

Status: implementation design, 2026-07-12. Authoritative task detail remains
`SPEC.md`; this document records the implementation decisions and invariants.

## 1. Failure and scope

`pull()` only supplied `fastFoldBase` after verified evidence already existed,
while `E2eeRemote.latest()` collected first evidence only when local *writer*
MDE capabilities were enabled. A FAST_PULL-only receiver therefore cold-walked
forever. Separately, every fold materialized a full canonical JSON string for
both base and result, and the cold walk retained all ciphertext, plaintext, and
decoded-envelope arrays together.

This fix changes no envelope bytes, signed fields, CAS rules, roots, GC, or
raw-v0 behavior.

## 2. Read capability and observability

Add `recordEvidence?: boolean` to `LatestOptions`. `sync.ts:pull()` reads
`RBOX_MDE_FAST_PULL` once and passes `recordEvidence: true` whenever enabled,
independent of whether prior metadata exists. `latest()` collects metadata when
writer snapshot capability, `recordEvidence`, or `fastFoldBase` is present.
This creates evidence on the first cold pull and the existing state-save packet
persists it atomically after application. The integration regression test uses
real `pull()` twice with writer flags disabled on the receiver and checks both
the persisted validated metadata and second-pull head-only fetch.

Extend `LatestTimings` with the non-sensitive enum `fold`. `decodeManifestAt`
emits `evidence` after a guarded fast fold, `coldwalk` after a non-empty signed
chain walk, and `snapshot`/`raw` for chain-free heads. The formatter appends
` fold=<enum>`.

## 3. Byte-identical streaming hash

`canonicalManifestHashStreaming()` recursively emits the same token stream as
`canonicalJson`: sorted UTF-16 keys, omitted `undefined` object members,
ECMAScript `JSON.stringify` scalar rendering (including fractional numbers),
and rejection of non-finite numbers and lone surrogates in keys and values.
It updates a Node SHA-256 incrementally through a bounded text accumulator,
flushed at a fixed small threshold. No full canonical string or byte array is
constructed.

Reference body serialization remains unchanged. A deterministic fuzz suite
compares streaming hashes with `hashBytes(canonicalManifestBytes(m))`, including
schema presence, git sections, fractional mtimes, Unicode, and matching failure
for lone surrogates in names and values.

All manifest-hash-only sites use the streaming function: snapshot and delta
encoding stamps, snapshot decoding, and fold base/result verification. Existing
`canonicalManifestHash` remains compatible and may delegate to the streaming
implementation; canonical bytes remain the wire/reference definition.

## 4. Exactly-once verification

`foldDelta(base, ops, header, trustedBaseHash?)` skips recomputing the base hash
only when the supplied trusted hash equals `header.baseManifestHash`; otherwise
it computes and checks the base as before. It always computes and checks the
result hash, then validates the result. Inputs are never mutated.

The evidence fast path passes persisted `meta.manifestHash` only after every
existing address/hash/exact-chain guard succeeds. The cold walk begins with
either the terminal snapshot hash already verified by `decodeEnvelope`, or (for
a permitted legacy raw-v0 terminal) computes its streaming hash exactly once.
It passes that hash into the first delta, then passes each successfully verified delta
`resultHash` into the next. Thus every reconstructed manifest is hashed exactly
once per walk and no unauthenticated value becomes trusted.

Guard mismatch continues to demote to cold walk. Guard-pass fold failure remains
a `ManifestChainError`.

## 5. Buffer lifetime and cache

Cold-walk fetches all signed-chain ciphertexts concurrently by address,
preserving per-link missing-blob attribution, then decrypts, decodes, and folds
serially in signed order. Ciphertext slots are cleared as each fold advances,
and no array of plaintexts or decoded envelopes is retained. The one-pass fold
retains the preceding signed address and verified hash, requires each delta
`baseEncSha` to equal that address, and
finally requires the head base to equal the last signed element. Ciphertext
sizes are accumulated as scalars. Before every uncached decode/fold, the remote
unconditionally evicts prior LRU entries; cached hits return before eviction.
The active input remains referenced by the caller and the result is cached only
after verification, so folding has at most input + result live. The LRU remains
capped at two (and in this path refills with only the verified result).

## 6. Tests and gates

- Regression: real `pull()` FAST_PULL-only receiver, evidence valid after pull
  one, head-only fetch and correct applied target on pull two.
- Unit/fuzz: streaming/reference equality, Unicode fail-close, trusted-hash
  mismatch fallback, result verification, and base purity on all failures.
- Timing token coverage for every decode path and formatter output.
- CI benchmark: realistic 124k-entry encrypted-shape manifest, small delta,
  decoded fast fold with trusted base; assert fold under 2 seconds and sampled
  Linux resident-memory growth no greater than two measured manifest-sized
  structures. Define one manifest size as its measured serialized byte size in
  a separate child. After setup, the fold child reports its current-RSS baseline
  and waits; the parent then releases it and samples Linux `VmRSS` throughout
  decode+fold, avoiding lifetime-HWM masking by setup allocations. Print elapsed
  ms, sampled RSS delta KB, and the two-manifest allowance. Fresh Bun processes
  prevent earlier tests from contaminating either measurement.
- Run the exact repro and benchmark against the pre-fix tree for real baseline
  failure/time/RSS evidence, then typecheck, focused tests, and full `bun test
  ./src/` after the fix; record factual results.

String tokens are escaped incrementally with JSON.stringify-identical control,
quote, and backslash spellings. The 64 KiB emitter never splits a valid UTF-16
surrogate pair across hash updates, so even an unbounded scalar cannot create a
document-sized temporary.
