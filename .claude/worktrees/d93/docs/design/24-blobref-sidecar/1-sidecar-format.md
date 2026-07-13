# §24.1 — Sidecar format + client upload

> Chunk of [§24](../24-blobref-sidecar.md). The data format + how the client produces it.

## Problem
Define a canonical, content-addressed serialization of a commit's blobRef set that (a) is
stable (same set → same bytes → same hash, so it's a normal dedupable blob), (b) is compact,
(c) is cheap for the DO to parse for grant/GC.

## Design
- **Content — LOCKED canonical encoding (codex B1).** Ambiguity here lets two clients produce
  different `sidecarSha` for the same set, or a parser accept malleable bytes. The format is
  exactly:
  ```
  magic    "rbox-refset-v1"   (14 ASCII bytes, fixed)
  count    u32be              (number of refs)
  refs     count × ( 32 raw sha256 bytes ‖ size u64be )   // 40 bytes/ref
  ```
  with STRICT rules the parser MUST enforce (reject otherwise):
  - refs **sorted ascending by the 32 raw sha bytes**, **no duplicate shas**;
  - **no trailing bytes** (total length is exactly `14 + 4 + 40·count`);
  - `size` is a non-negative `u64` within sane bounds (≤ the per-blob max);
  - after parse, **`count` and `Σsize` MUST equal the body descriptor** (`blobRefset.count`,
    `blobRefset.totalBytes`) — else reject before grant/head-advance.
  Big-endian + fixed widths make the bytes reproducible across clients/languages; the magic
  domain-separates + versions the format. ~40 B/blob (half the JSON form); opaque to humans,
  which is fine — the server never displays it.
- **Address:** `sidecarSha = sha256(sidecarBytes)`, where `sidecarBytes` is the full
  canonical unique/sorted ref set. `sidecarSha` identifies the sidecar object as a whole; it
  is not a per-blob checksum and not an R2 storage checksum. It's stored in R2 like any blob
  (content-addressed). NOT encrypted with the workspace KEK necessarily — it contains encShas
  (already ciphertext addresses) + sizes, which the server already sees in today's body; so
  it can be a plain content blob. (Confirm: does exposing the *set* of encShas as one object
  leak more than the inline body already does? No — same data, same server visibility.)
- **Client:** during push, after computing blobRefs (the unique set, §sync), serialize →
  `sidecarBytes` → upload via the normal blob path (PUT → receipt, §23.2) → put `sidecarSha`
  + `count` + `totalBytes` in the commit body (§24.2).

## Correctness
- Deterministic: identical ref set → identical bytes → identical `sidecarSha` (dedup; a
  no-op re-push reuses it).
- The signed commit body commits to `sidecarSha`, so the sidecar can't be swapped.
- Size cap: a 50k-blob sidecar at ~40 B = ~2 MB — fine as one immutable R2 object for v1
  (R2 has no small cap); it is NOT bound by `MAX_COMMIT_BODY` (that's the D1 row, now O(1)).
  Packing/chunking the sidecar would be only a storage/layout optimization, like Git
  packfiles or backend bucket layouts, and should wait for measured need because it must not
  change `sidecarSha` semantics.

## Tests
- round-trip serialize→parse equals the input set (sorted, unique).
- determinism: two clients with the same set produce byte-identical sidecars.
- a tampered sidecar → `sidecarSha` mismatch → rejected at validate (§24.3).

## Depends on / Status
Depends on: §23.2 (blob upload path) for shipping the sidecar. Status: **IMPLEMENTED** (`src/engine/refset.ts`, shared with the Worker; golden-vector + strict-rejection tests in `src/engine/refset.test.ts`).
