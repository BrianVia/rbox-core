# §24.1 — Sidecar format + client upload

> Chunk of [§24](../24-blobref-sidecar.md). The data format + how the client produces it.

## Problem
Define a canonical, content-addressed serialization of a commit's blobRef set that (a) is
stable (same set → same bytes → same hash, so it's a normal dedupable blob), (b) is compact,
(c) is cheap for the DO to parse for grant/GC.

## Design
- **Content:** the unique blobRefs, **sorted by encSha** (same normalization as the current
  `normalizeBlobRefs`), as a compact canonical encoding. Candidates: length-prefixed binary
  (`u32 count` then `count × (32-byte encSha ‖ u64 size)`) — ~40 B/blob, half the JSON form —
  or canonical JSON for debuggability. **Prefer binary** for size; it's opaque to humans but
  the server never needs to show it.
- **Address:** `sidecarSha = sha256(sidecarBytes)`. It's stored in R2 like any blob (content
  -addressed). NOT encrypted with the workspace KEK necessarily — it contains encShas
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
- Size cap: a 50k-blob sidecar at ~40 B = ~2 MB — fine as an R2 object (R2 has no small cap);
  it is NOT bound by `MAX_COMMIT_BODY` (that's the D1 row, now O(1)).

## Tests
- round-trip serialize→parse equals the input set (sorted, unique).
- determinism: two clients with the same set produce byte-identical sidecars.
- a tampered sidecar → `sidecarSha` mismatch → rejected at validate (§24.3).

## Depends on / Status
Depends on: §23.2 (blob upload path) for shipping the sidecar. Status: **design**.
