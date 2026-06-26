# rbox

**Dropbox for devs.** Continuous, dev-aware sync of your working directories across machines — source, configs, and uncommitted git state move; `node_modules`, build output, and secrets stay local and get regenerated per machine.

Built as a **SaaS** on Cloudflare (Workers + D1 + R2 + Durable Objects). The wedge isn't sync — it's *understanding what not to sync, and how to rehydrate the rest.*

## Status

A full vertical slice works and is verified cross-machine (Mac ↔ a remote Linux host) against live Cloudflare:

- **Engine** (`src/engine/`) — content-addressed manifests, three-way reconcile, atomic apply, conflict copies, dev-aware ignore. Unit-tested.
- **Control plane** (`apps/api/`) — Worker API: content-addressed blobs + manifests, optimistic-concurrency conflict detection.
- **Client** (`src/cli/`) — `rbox link / push / pull / sync / status`, with per-device root mapping (Host A's `~/Development` ↔ Host B's `~/code`).

Sync today is manual (`push`/`pull`); the passive watcher daemon is the next milestone. See **[`docs/roadmap.md`](docs/roadmap.md)**.

## Docs

- [`docs/rbox-architecture-v2.md`](docs/rbox-architecture-v2.md) — current design + decision log
- [`docs/roadmap.md`](docs/roadmap.md) — what's done and what's next
- [`docs/pricing.md`](docs/pricing.md) — plans
- [`docs/prior-art-files-sdk.md`](docs/prior-art-files-sdk.md) — storage-layer prior art
- [`docs/rbox-architecture.md`](docs/rbox-architecture.md) — original "CodeSync" draft (superseded)

## Dev

```bash
bun install
bun test            # engine tests
bunx tsc --noEmit   # typecheck
```

The control plane lives in `apps/api/` (deploy with `wrangler deploy`).
