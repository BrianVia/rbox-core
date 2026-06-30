# §23 — Upload receipts + commit-time batched accounting (P0)

> Status: **design** (pre-codex-review). Basis: [`22-server-throughput.md`](22-server-throughput.md).
> **The single biggest server-side throughput win.** Decomposed into independently
> shippable chunks (`23-upload-receipts/`).

## Problem (one paragraph)
Every blob `PUT` does ~5 D1 round-trips; a 1041-blob push ≈ ~5,200 D1 round-trips and D1
is single-threaded per DB — the measured plateau (conc≥32 flat, conc=4 threw "connection
lost"). Root cause (Dropbox Magic Pocket / FileJournal): **the content server mutates
metadata on every PUT.** Fix: R2 = dumb content store; sequencing+accounting move to a
batched step at commit (the metadata journal).

## Target
- `PUT` → auth + R2 sha-verified put + return an **upload receipt**. **Zero D1 on the hot path.**
- **Commit** validates refs (entitled OR valid receipt) and does **one batched D1 transaction**.
- Per-blob D1: ~5 → 0 on PUT; per-commit D1: O(blobs) → O(chunks). Bench target: lift the
  conc-32 plateau on `scripts/bench/push-sweep.ts`.

## Chunks (implement / review in order)
| # | Chunk | What | Depends |
|---|-------|------|---------|
| 17.1 | [Receipt primitive](23-upload-receipts/1-receipt-primitive.md) | HMAC mint/verify, rotation, TTL | — |
| 17.2 | [PUT → R2-only](23-upload-receipts/2-put-r2-only.md) | drop per-PUT D1; return receipt; legacy fallback | 17.1 |
| 17.3 | [missingBlobs receipts](23-upload-receipts/3-missingblobs-receipts.md) | present-but-unentitled → receipt; advisory quota | 17.1 |
| 17.4 | [Commit grant batch](23-upload-receipts/4-commit-grant-batch.md) | validate + one D1 `batch()` + quota gate | 17.1–17.3 |
| 17.5 | [Quota + orphan GC](23-upload-receipts/5-quota-and-orphan-gc.md) | commit-time charge; RECEIPT_TTL < GC grace; reclaim | 17.4 |
| 17.6 | [Accounting concurrency](23-upload-receipts/6-accounting-concurrency.md) | exactly-once charge; D1-RETURNING vs Account DO | 17.4 |

## Key risks (carried in the chunks)
- **17.6 is the load-bearing risk** — exactly-once `used_bytes` under concurrent same-account
  commits. Spike D1 `RETURNING`-in-batch first; fall back to an AccountAccounting DO.
- **Quota moves to commit-time** → orphan R2 bytes; mitigated by `RECEIPT_TTL < GC_GRACE` +
  the reconciliation worker (17.5, backlog #7).
- **Protocol change** → ship server+client together; keep a legacy per-PUT-grant fallback
  behind a CLI-version flag, deprecate after adoption.

## Review gate
Run this whole §23 (overview + 6 chunks) back through **codex adversarially** before code —
especially 17.4 + 17.6 (the grant transaction + concurrency). Then implement chunk-by-chunk
behind the legacy fallback, deploy dev, and re-bench each step.

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
