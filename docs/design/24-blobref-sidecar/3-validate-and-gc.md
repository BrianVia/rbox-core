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
- First enforce §24.2 mode validity: exactly one of `blobRefs` or `blobRefset` must be
  present (strict own-property, §24.2 M7). Reject both/neither before receipts, accounting,
  or head advance.
- Reject early (cheap, no fetch — both are in the signed body) if `count > MAX_BLOB_REFS` OR
  **`count > MAX_ACCOUNTING_REFS_PER_COMMIT`** (the §23.4 accounting cap, 6000 — codex B3: v1
  caps sidecar commits there too; 50k needs a separate measured large-ref accounting design)
  OR `totalBytes` clearly over the advisory quota remaining.
- **`resolveSidecarBytes` (codex B2 — the §23 staging chicken-and-egg).** The sidecar is
  itself a §23 blob, so it must be readable BEFORE accounting yet durable BEFORE head advance:
  - if `sidecarSha` is already entitled AND `blobs.present=1` → GET canonical `blobKey`;
  - else require a valid **receipt** for `sidecarSha` (in the commit's `receipts` map) and GET
    the account **staging** key; if absent → `422 needs_upload[sidecarSha]`.
  - verify `sha256(bytes) == sidecarSha`; parse (§24.1 strict rules); assert `count`/`Σsize`
    equal the descriptor.
- **Include `sidecarSha` itself in the §23 validate + accounting + promote set** — it is
  charged (server-measured size) and promoted to `present=1` alongside the data refs, so the
  published head's sidecar is durable (never `present=0`). Bill from server-measured sizes,
  NEVER the advisory descriptor (codex M6).
- Hand the parsed `[{encSha,size}]` to §23.4's grant batch. Cache the parsed sidecar for the
  duration of the commit (don't re-fetch for GC in the
  same request).

### GC reachability
> **NOTE (post-§23):** §23.5 already REMOVED the destructive canonical purge from the cron
> (it raced the commit-promote). So "GC roots" here is for the *deferred* canonical dedup-GC
> (or the DO `roots()` consumed by retention), not the per-blob purge §23 deleted. When that
> canonical GC is (re)introduced, it must be sidecar-aware per below.

GC walks retained commits and unions their referenced blobs. For `blobRefset` commits
`roots()` must fetch+parse the sidecar to get that union, and:
- **enforce exact mode** per commit; **include `sidecarSha` itself as a root** (losing the
  sidecar must prevent condemnation, not be papered over);
- **fail CLOSED** — if any retained commit's sidecar is missing, corrupt
  (`sha256(bytes) != sidecarSha`), unparseable, or there's a retained-commit gap, return
  non-2xx → **abort the whole pass, condemn nothing**, alert, retry (codex B5).
- **bound the work (codex M8):** a 2 MB sidecar × many retained commits can blow the DO
  CPU/30s limits. Cap retained-sidecar fetches per pass, R2-`head` the size before GET, use a
  streaming/bounded parser with an exact max-bytes ceiling. If that's insufficient, promote the
  **retained-root index** (Option B: a compact D1/R2 index of "blobs reachable from the current
  retained set," updated at commit time) to v1.

Options for the union: **A — fetch on demand** (simple, correct, bounded per above) vs
**B — retained-root index** (faster, more moving parts). Start with **A**; move to **B** if GC
latency/cost shows up.

## Correctness (the data-loss guard)
- GC MUST NOT condemn a blob still referenced by any retained commit. With sidecars, "still
  referenced" requires reading sidecars — a bug that skips a sidecar = wrongful deletion.
  → GC over sidecar commits must fail **closed**: if any retained commit's sidecar is
  missing, corrupt (`sha256(bytes) != sidecarSha`), or unparseable, **abort condemnation for
  the pass** (don't condemn anything), alert, retry.
- The sidecar object is itself a GC root while its commit is retained. Retaining only the
  data blobs is insufficient; losing the sidecar would make future validation/GC unable to
  prove reachability and must therefore prevent condemnation rather than be papered over.

## Tests (worker)
- Sidecar commit: grant path gets the same refs as an equivalent inline commit would.
- GC retains all blobs referenced by a sidecar commit; condemns only truly-unreferenced ones.
- Missing/corrupt/unparseable sidecar at commit → 422 (not advance).
- Missing/corrupt/unparseable sidecar at GC → abort condemnation, condemn nothing
  (fail-closed).
- Sidecar object itself is retained while its commit is retained; dropping only the sidecar
  must fail a GC pass instead of deleting referenced data blobs.
- Migration rejection: both `blobRefs` and `blobRefset`, or neither field, reject before
  grant/quota/head advance.

## Depends on / Status
Depends on: §24.1, §24.2, §23.4. Status: **IMPLEMENTED** (`apps/api/src/sidecar.ts` resolveSidecarBytes direct-write + `workspace-sync.ts` dual-mode commit handler + sidecar-aware fail-closed `roots()`; tests in `apps/api/test/sidecar-flow.test.ts`). Original GC fail-closed
logic specifically**; it's the load-bearing correctness risk.
