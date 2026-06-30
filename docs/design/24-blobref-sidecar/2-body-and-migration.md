# §24.2 — Signed-body change + dual-mode migration

> Chunk of [§24](../24-blobref-sidecar.md). Changes the signed `CommitBody` shape without
> breaking existing inline commits.

## Problem
`CommitBody` (`src/engine/e2ee/commit.ts`) currently carries `blobRefs: [{encSha,size}]`
inline, normalized + signed. We need it to instead reference the §24.1 sidecar — but every
existing commit on the server has inline refs and must keep verifying (the chain is
hash-linked and immutable).

## Design — dual-mode body
The body gains an optional sidecar descriptor; **exactly one** of the two forms is present:
```
CommitBody {
  …existing fields…
  // legacy (still valid for old commits):
  blobRefs?: [{ encSha, size }]
  // new (v2):
  blobRefset?: { sidecarSha, count, totalBytes }
}
```
- New clients emit `blobRefset` (sidecar). Old commits keep `blobRefs`.
- The canonical-JSON signing input includes whichever single field is present (JCS over the
  body as-is) — no change to the signing/verify mechanism, just the schema. A signature never
  floats over an implied/default ref set.
- **Strict discriminator (codex M7).** The mode is decided by **own-property presence with a
  valid type** — `blobRefs` is a valid array (legacy inline) XOR `blobRefset` is a valid object
  (v2 sidecar). `blobRefs: null` + `blobRefset`, both present, neither present, or wrong types
  are ALL malformed → rejected before receipts, grant, quota mutation, or head advance. Model
  it as `CommitBodyInline | CommitBodySidecar` (or an explicit `refsKind` tag) and update
  `parseCommit` + chain verification so old clients never silently misread a v2 body.

## Validation parity
- `normalizeBlobRefs` invariants (unique, sorted, valid encSha, valid size) move to the
  sidecar parser (§24.3) for the new form; the old inline path keeps its existing check.
- `MAX_BLOB_REFS` still caps `count`; the sidecar byte size gets its own sane cap.

## Migration / compatibility
- **Read path:** verify accepts both forms (old commits in the chain stay valid forever).
- **Write path:** new CLI always writes `blobRefset`. A min-CLI-version gate ensures the
  server understands it before clients emit it, and the server still enforces exactly-one
  mode for every write before advancing head.
- No data migration of existing commits (immutable, still valid). Only new commits change.

## Correctness
- The body still commits to the full ref set — via `sidecarSha` instead of inline bytes —
  so signature integrity + anti-tamper are unchanged. `sidecarSha` names the whole canonical
  sidecar bytes, not individual payload blobs or an R2 storage checksum.
- `count`/`totalBytes` in the body let the server bound work + pre-check quota WITHOUT
  fetching the sidecar (cheap reject before the R2 GET).

## Tests
- Old inline commit verifies unchanged. New sidecar commit verifies. Bodies with both
  `blobRefs` and `blobRefset`, or with neither field, reject before grant/quota/head advance.
  Tampered `sidecarSha` → fetch+hash mismatch (§24.3) → reject.

## Depends on / Status
Depends on: §24.1. Status: **design (v2, codex-resolved)**. Pairs with §23 (the commit handler reads this).
