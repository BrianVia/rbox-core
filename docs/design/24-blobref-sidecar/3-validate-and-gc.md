# §24.3 — Server/DO validation + GC roots from the sidecar

> Chunk of [§24](../24-blobref-sidecar.md). The server-side consumer: commit validation
> (feeds §23.4) and garbage collection. **Highest-risk chunk** (GC = data loss if wrong).

## Problem
Two server paths read blobRefs today and must work with the sidecar form:
1. **Commit validation / grant** (§23.4) — needs the ref set to validate receipts + batch-grant.
2. **GC reachability** (`apps/api/src/versions.ts`) — derives the set of blobs a retained
   commit references ("roots") to decide what's reachable vs condemnable.

## Design

### Commit validation (feeds §23.4)
On a `blobRefset` commit:
- Reject early if `count > MAX_BLOB_REFS` or `totalBytes` over the cheap quota check (no
  fetch needed — both are in the signed body, §24.2).
- Fetch the sidecar by `sidecarSha` from R2 (one GET; the sidecar is itself a referenced
  blob that must be present-or-422, like any blob). Verify `sha256(bytes) == sidecarSha`.
- Parse → `[{encSha,size}]`, assert the §24.1 invariants. Hand to §23.4's grant batch.
- Cache the parsed sidecar for the duration of the commit (don't re-fetch for GC in the
  same request).

### GC reachability
GC walks retained commits and unions their referenced blobs. For `blobRefset` commits it
must fetch+parse the sidecar to get that union. Two options:
- **A — fetch on demand:** GC fetches each retained commit's sidecar. Simple, but a full GC
  pass over many commits = many R2 GETs.
- **B — retained-root index:** maintain a compact D1/R2 index of "blobs reachable from the
  current retained set," updated incrementally at commit time, so GC reads the index not
  every sidecar. Faster GC, more moving parts.
Start with **A** (correct + simple); move to **B** only if GC latency/cost shows up.

## Correctness (the data-loss guard)
- GC MUST NOT condemn a blob still referenced by any retained commit. With sidecars, "still
  referenced" requires reading sidecars — a bug that skips a sidecar = wrongful deletion.
  → GC over sidecar commits must fail **closed**: if a retained commit's sidecar is
  unfetchable/unparseable, **abort the GC pass** (don't condemn anything), alert, retry.
- The sidecar of a retained commit is itself reachable (referenced by the commit) → GC must
  also retain the sidecar object, not just the data blobs.

## Tests (worker)
- Sidecar commit: grant path gets the same refs as an equivalent inline commit would.
- GC retains all blobs referenced by a sidecar commit; condemns only truly-unreferenced ones.
- Missing/corrupt sidecar at commit → 422 (not advance). Missing sidecar at GC → abort pass,
  condemn nothing (fail-closed). Sidecar object itself is retained while its commit is retained.

## Depends on / Status
Depends on: §24.1, §24.2, §23.4. Status: **design** — **codex-review the GC fail-closed
logic specifically**; it's the load-bearing correctness risk.
