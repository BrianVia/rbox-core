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
`sidecarSha` is the hash of the full canonical ref set (unique, sorted blobRefs), not a
per-blob checksum and not a checksum of whatever R2 storage layout happens to hold it. The
signature still covers the sidecar hash → integrity preserved. Body size becomes O(1).

This matches the useful precedent from Dropbox/Git/Syncthing: identity is derived from
canonical content/metadata bytes, while the backend may store those bytes as one object,
packed objects, buckets, or some later optimized layout without changing the identity.
For v1, the 50k-file target is small enough for a single immutable R2 sidecar object
(~2 MB with the binary encoding). Packing/chunking sidecars is a future storage
optimization only if measurements show it is needed.

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
  index). GC must fail closed: if any retained sidecar is missing, corrupt, or unparseable,
  the pass aborts before condemning anything; the sidecar object itself is a root while its
  commit is retained. Getting this wrong = data loss or storage bloat. (18.3, codex-review.)
- **Sidecar availability** — a commit's sidecar must exist in R2 before head advances (treat
  it like any referenced blob: present-or-422).

## Review gate
Codex-review §24 with §23 (shared commit path). Then implement 18.1→18.3, dual-mode so
existing inline commits keep verifying.

---

## Benchmarking this change (against **dev**, not prod)

Validate on the **dev** worker `rbox-dev-api` — real Cloudflare D1/R2/DO, the only place
the latency/contention this change targets actually shows up (local Miniflare has ~0
network latency and would hide it). The dev deploy is a **separate, manual** step —
**do NOT push to `main` to test**: push-to-`main` auto-deploys *prod* (`deploy-api.yml`).

```bash
# on a branch/worktree with the change (server + the client binary if it's a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api (dev only; prod untouched)
bun build --compile --target=bun-darwin-arm64 \      # match your platform; only if the client changed
  ./src/cli/index.ts --outfile /tmp/rbox
bun scripts/bench/push-sweep.ts --bin /tmp/rbox \
  --remote https://rbox-dev-api.brian-via.workers.dev --conc 8,16,32,64
```

- **Compare base vs head back-to-back** (deploy baseline → sweep → deploy change → sweep) so
  dev's shared-instance noise cancels — relative deltas are valid even though absolute dev
  numbers wander vs prod.
- **Drive the path this change affects:** push via `push-sweep.ts`; pull/clone-side changes
  by timing a fresh `rbox init --workspace <id>` into an empty dir (a clone-sweep is a TODO).
- **Success metric = this doc's Target/Goal section.** Once the §25 server metrics are live on
  dev you can read the server-side split (`d1Calls` / `d1Ms` / `r2Ms` per op) directly instead
  of inferring it from client wall-time — land §25 on dev first.
- Only merge to `main` (→ prod) once it's proven on dev.
- For an **isolated, repeatable** target (no contention with other dev work, wipe-and-repeat),
  set up a dedicated `[env.bench]` → `rbox-bench-api` + throwaway `rbox-bench-db`/`-blobs` and
  point `--remote` at it. (See the README "Benchmarking" section.)

---

## v2 — codex adversarial review resolutions (2026-06-30)

Codex reviewed §24 against the SHIPPED §23 path → NEEDS-WORK (5 BLOCKER + 3 MAJOR). Two
BLOCKERs were actually bugs in §23's code (promote-failure didn't fail the commit; the cron
still ran the destructive canonical GC) — both **fixed** in §23 (commit `38aba82`). The §24
design resolutions:

- **B1 — lock the canonical sidecar encoding (§24.1).** `rbox-refset-v1` magic, `u32be count`,
  then exactly `count × (32 raw sha bytes ‖ u64be size)`, strict lexicographic sha order, NO
  duplicates, NO trailing bytes, safe int bounds; the parser MUST reject anything else and MUST
  assert parsed `count`/Σsize equal the body descriptor. Determinism = dedupable blob + stable
  `sidecarSha`.
- **B2 — resolve the sidecar staging chicken-and-egg (§24.1/§24.3).** The sidecar is itself a
  §23 blob: a `resolveSidecarBytes` step runs BEFORE accounting — if `sidecarSha` is already
  entitled+`present=1` → GET canonical; else require a valid receipt + GET the account staging
  key, verify `sha256==sidecarSha`, parse. Then include `sidecarSha` in the §23 validate +
  accounting + promote set (charged, promoted to `present=1`) so the published head's sidecar is
  durable, not `present=0`.
- **B3 — 50k vs the 6000 accounting cap (§24.3).** v1 caps sidecar commits at
  `MAX_ACCOUNTING_REFS_PER_COMMIT` (6000) like inline; the "50k files" headline needs a separate
  *measured* large-ref accounting design (bounded D1 set-checks, chunked promote, a post-accounting
  `present=1` barrier over ALL refs) — explicitly future work, not claimed by v1.
- **B4 (was §23 bug) — FIXED:** promote failure → commit 422, head not advanced.
- **B5 (was §23 bug) — partially FIXED:** cron canonical GC removed. REMAINING for §24 impl:
  `roots()` must, for `blobRefset` commits, fetch+hash+parse the sidecar, include `sidecarSha`
  itself as a root, and fail **closed** (non-2xx → abort the whole GC pass) on any
  missing/corrupt/unparseable sidecar.
- **M6 — descriptors are advisory only.** `count`/`totalBytes` gate an early cheap reject; NEVER
  accepted for billing. Bill from server-measured ciphertext sizes (receipts / `blobs.size_bytes`)
  including the sidecar object's own measured size; after parse, require exact count/Σ match.
- **M7 — strict dual-mode discriminator.** `CommitBodyInline | CommitBodySidecar` via a strict
  own-property exactly-one rule (or an explicit `refsKind`); reject both/neither before
  receipts/accounting/head-advance; update `parseCommit` + chain verification.
- **M8 — GC DoS at scale.** Fetch-on-demand `roots()` needs a per-pass retained-sidecar cap, an
  R2 `head` size check before GET, a streaming/bounded parser, or the retained-root index (Option
  B) promoted to v1 if measurements demand it.

> **Sequencing:** §24 implementation MODIFIES the §23 commit path (sidecar replaces inline refs),
> so it lands AFTER §23 merges. This review + the two §23 bug fixes it surfaced are the immediate
> value; full §24 design re-review happens when its implementation begins.
