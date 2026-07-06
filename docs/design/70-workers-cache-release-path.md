# 70 — Workers Cache in front of the release path

**Status:** implementing.
**Depends on:** design 14 (release distribution, shipped), design 64 (abuse
hardening — RL_RELEASE, shipped).

## 1. Problem

The release routes (`apps/api/src/routes/release.ts`) already emit correct
cache headers — `public, max-age=300` on `install.sh` and the latest-alias
binaries, `public, max-age=31536000, immutable` on versioned binaries,
`no-store` on 404s (design 14 U7). But a Worker on a custom domain has no
cache in front of it, so those headers do nothing at the edge: every
`curl install.sh | sh` and every binary download executes the Worker and
streams the object from R2's single region. For a global install funnel
that's avoidable latency on the exact requests we most want to be fast.

Cloudflare's **Workers Cache** (GA 2026-07-06) puts a tiered edge cache in
front of Worker entrypoints, driven by the `Cache-Control` headers we already
send. This doc adopts it for the release path only.

## 2. Decision: gateway pattern, not naive enable

The naive adoption — top-level `"cache": { "enabled": true }` and nothing
else — is explicitly anti-recommended by the CF docs for a worker like ours:
with cache in front of the default entrypoint, **every** request consults the
lower + upper cache tiers before the Worker runs, including the entire
authenticated sync surface whose responses are never cacheable. That is a
pure latency tax on the hot path (a standing perf workstream, §35–40). It
would also serve release cache hits without executing the Worker at all,
silently disabling RL_RELEASE and the `rbox_metrics` request rows the funnel
reads.

Instead we use the documented **gateway pattern**
(developers.cloudflare.com/workers/cache/examples/):

- The **default entrypoint keeps cache disabled** — sync, auth, billing,
  blobs are never even looked up in the cache. Zero change to the hot path.
- A new named entrypoint **`CachedReleases`** (a `WorkerEntrypoint` exported
  from `worker.ts`) serves the cacheable release objects from R2. Workers
  Cache is enabled in front of it.
- The gateway matches the release routes, applies **RL_RELEASE first**, then
  forwards via `ctx.exports.CachedReleases.fetch(req)`. On a cache hit the
  loopback fetch returns the edge-cached body and `CachedReleases` never
  runs — but the gateway always runs, so rate limiting and per-request
  metrics keep working exactly as today.

## 3. Scope

**Cached via `CachedReleases`:**

- `GET /install.sh` — now `public, max-age=300, stale-while-revalidate=3600`:
  serve the (5-min) stale copy instantly while revalidating in the
  background; the install one-liner never waits on R2.
- `GET /bin/rbox-<os>-<arch>` (latest alias) — `public, max-age=300`,
  unchanged. **No SWR here**: install.sh verifies the artifact sha256 against
  the fresh manifest, and a stale-while-revalidate window would widen the
  post-release span where a stale binary fails that check.
- `GET /bin/v<ver>/rbox-<os>-<arch>` — `public, max-age=31536000, immutable`,
  unchanged. The big win: versioned binaries become immutable edge hits
  worldwide.
- 404s stay `no-store` (design 14 U7 — a cached 404 must not mask a
  just-published object).

**Deliberately NOT cached:**

- `GET /version`, `GET /version.sig` — stay in the gateway, `no-cache` as
  today. `rbox upgrade` must see a fresh signed manifest; the pair must not
  be cached independently (a mismatched manifest/signature pair fails
  verification).
- Everything authenticated, the device-auth flow, webhooks — untouched by
  the cache (gateway entrypoint has cache disabled).

## 4. Default-deny hygiene guard

Nothing outside `release.ts` sets `Cache-Control` today. At the single
egress of the gateway `fetch()` (`worker.ts`), set `cache-control: no-store`
on any response that lacks the header. This is not what keeps the sync path
out of Workers Cache (the exports map does that); it is belt-and-suspenders
against any intermediary cache and against a future config flip of the
default entrypoint. WebSocket upgrades (`status === 101` / `res.webSocket`,
the DO fanout path in `ws-fanout.ts`) pass through untouched — a 101 cannot
be re-wrapped.

## 5. Config

`wrangler.jsonc` (wrangler 4.106.0 ≥ required 4.69), **both top-level and
repeated in `env.production`** (named envs do not inherit siblings — same
rule as the ratelimits blocks):

```jsonc
"cache": { "enabled": true },
"exports": {
  "default":        { "type": "worker", "cache": { "enabled": false } },
  "CachedReleases": { "type": "worker", "cache": { "enabled": true } }
}
```

## 6. Accepted trade-offs / non-issues

- **Cache is keyed per Worker (+ entrypoint + version), not per zone** — dev
  (`rbox-dev-api`) and prod (`rbox-prod-api`) caches are fully separate.
- **512 MB cacheable-size launch limit** — binaries are far under.
- **Pricing** — cache hits bill request-rate only, no CPU; no new SKU. The
  gateway still runs per request, so our request count is unchanged.
- **Purge** — not wired up. `max-age=300` on the mutable objects bounds
  staleness to the same 5-minute window clients already tolerate; releases
  are not so frequent that we need `ctx.cache.purge()`. Revisit if release
  cadence changes.
- **`ctx.exports` needs NO compatibility flag** — `enable_ctx_exports`
  became default on 2025-11-17, and current workerd treats *specifying* the
  defaulted flag as a startup error. Our compat date (2026-06-23) covers it.
- **Test-runtime bump (rode along)** — `@cloudflare/vitest-pool-workers`
  0.8.59 → 0.12.21 (newest line that keeps vitest 2.x; workerd 2026-03-10),
  required for the loopback path to run under vitest. Two side effects: the
  gc-phase1 "broken DO" fixture had leaned on the old runtime lacking
  `storage.kv` and was rewritten as an explicit broken-namespace stub, and
  the DO-driven tests skipped for that same gap can likely be unskipped now
  (follow-up, not this change).

## 7. Verification

- `npm run typecheck` + `cd apps/api && vitest run` green (PR gate — the
  only test gate before prod, per AGENTS.md).
- New tests: header assertions for all release routes (SWR on install.sh,
  immutable on versioned bin, no-store 404), no-store guard on authed +
  unmatched routes, 101 passthrough unbroken (existing
  `workspace-sync-ws.test.ts` stays green), RL_RELEASE still enforced ahead
  of the forward.
- Dev-first (AGENTS.md): deploy `rbox-dev-api`, confirm a second
  `GET /install.sh` / versioned-binary fetch returns a cache HIT and that a
  sync round-trip still works, before merging (merge → prod via Workers
  Builds).
