# §24 — blobRefs out of the signed commit body → R2 sidecar (P0)

> Status: **design**. Basis: [`22-server-throughput.md`](22-server-throughput.md).
> Unlocks large monorepos (50k files); the current 1 MB commit-body cap is interim.

## Problem
The signed commit body inlines one `{encSha,size}` (~85 B) per unique blob. A ~4k-file
repo is ~350 KB; we raised `MAX_COMMIT_BODY` to 1 MB (≈12k blobs) but a 50k-file repo is
~4 MB and blows D1's row limit. blobRefs don't belong inline in the signed body.

## Target
The signed body carries a **hash + count + totalBytes** of a canonical blobRef **sidecar**;
the sidecar is a normal content-addressed R2 object the client uploads before commit. The
signature still covers the sidecar hash → integrity preserved. Body size becomes O(1).

## Chunks
| # | Chunk | What | Depends |
|---|-------|------|---------|
| 18.1 | [Sidecar format + upload](24-blobref-sidecar/1-sidecar-format.md) | canonical serialization, content-address, client uploads it as a blob | — |
| 18.2 | [Signed-body change + migration](24-blobref-sidecar/2-body-and-migration.md) | body holds `blobRefsSha`+count+bytes; dual-mode (inline OR sidecar) for old commits | 18.1 |
| 18.3 | [Server/DO validate + GC roots](24-blobref-sidecar/3-validate-and-gc.md) | DO fetches+parses sidecar for §23.4 grant + GC `roots()` | 18.1, 18.2 |

## Relationship to §23
§23.4's commit grant needs the ref list. With §24, the server **fetches the sidecar** (one
R2 GET, cached per commit) instead of reading inline body refs. Design §23 and §24 together;
ship §24 in the same protocol pass so 50k-file repos work end-to-end.

## Key risks
- **GC correctness** — `versions.ts` GC currently derives reachable blobs from inline body
  refs. It must now fetch sidecars for retained commits (or maintain a compact retained-root
  index). Getting this wrong = data loss or storage bloat. (18.3, codex-review.)
- **Sidecar availability** — a commit's sidecar must exist in R2 before head advances (treat
  it like any referenced blob: present-or-422).

## Review gate
Codex-review §24 with §23 (shared commit path). Then implement 18.1→18.3, dual-mode so
existing inline commits keep verifying.
