# §42 — Extract the admin surface into a sibling `rbox-admin` Pages project

**Status:** DRAFT v1 — design only, no implementation, no code moves. This doc proposes
lifting rbox's platform-admin surface out of `rbox-core` and into a **new, greenfield sibling
project `../rbox-admin`** — an Access-gated Cloudflare Pages project that serves BOTH the admin
UI and its APIs from one origin (e.g. `admin.rbox.to` + `admin.rbox.to/api/*`). The anchoring
principle is **strict, additive cutover:** build rbox-admin, deploy it, **validate it against
prod behind the Access gate, and only THEN** open a `rbox-core` PR that strips the now-dead admin
code. **Nothing is reverted from core now** — core keeps its three admin routes and keeps working
until rbox-admin is proven in prod. The central open decision is **(A) full move** (rbox-admin
owns the read cockpit *and* the mutating ops, core ends with zero admin surface, at the cost of a
second deployment with data-plane WRITE access + duplicated GC/billing logic) **vs (B) read-only
move** (rbox-admin owns UI + the read cockpit; the rare mutations — `setPlan`, `gc` — stay in core
behind the platform secret, invoked server-side by rbox-admin). **This doc recommends (B) now,
reachable to (A) incrementally.** The metrics **WRITE** path (`metrics.ts` `OpSpan`/`startOp` →
Analytics Engine, wired in `wrangler.jsonc:30,103`) **stays in core** — only the admin READ /
management surface moves.

> Numbering note: `docs/design/` already has a `41-daemon-watcher-scale.md`. This is a distinct
> doc sharing the ordinal; rename to the next free number if that collision matters.

## Problem

rbox's admin surface is small, but it is the **only** part of the API with privileged,
cross-account data access, and it is **structurally entangled** with the tenant data plane it
was bolted onto. Today it is exactly **three routes** in the core Worker (`apps/api/src/worker.ts`):

| route | worker.ts | handler | gate | mutating? |
|-------|-----------|---------|------|-----------|
| `GET /v1/admin/overview` | `:217-221` | `adminOverview` (`admin.ts:450`) | Cloudflare-Access JWT **+ hardcoded email allowlist** (`admin.ts:28,166-173`) | no — read-only cockpit |
| `POST /v1/admin/gc?phase=…` | `:204-216` | `runPhase1`/`gcMark`/`gcPurge`/`retentionPrune` | platform secret `isPlatform` (`authz.ts:68-71`) | **yes** — GC/retention |
| `POST /v1/admin/account/:id/plan` | `:224-227` | `adminSetPlan` (`billing.ts:121-138`) | platform secret | **yes** — billing/plan |

The read cockpit is the entangled one. `adminOverview` (`admin.ts:450-466`) pulls from deep
inside core:

- **Direct D1 reads** via the §32 seam — `dbFor(env, "")` for the account/storage/signup/subscription
  rollup and `dirDb(env)` for the device-liveness join (`admin.ts:190-233`). It reaches straight
  into the `accounts` and `devices` tables, not through any API.
- **`PLAN_MONTHLY_CENTS`** (`plans.ts`) for the D1-derived MRR estimate (`admin.ts:240`).
- **Three best-effort external fetches**, each bounded + never-throwing: Stripe MRR
  (`fetchStripeMrrCents`, `admin.ts:259`), the Cloudflare GraphQL 5xx-rate (`fetchFiveXxRate`,
  `admin.ts:294`), and — **just added in PR #30** (`8a92e60`) — the Analytics Engine op-timing
  read (`fetchServerMetrics`, `admin.ts:387-437`), the §25 read path.

And the SPA that renders all this is **not even in this repo**. It is a "SEPARATE Pages project
with NO bindings" at `admin.rbox.to` (`admin.ts:16-18`) that calls the core API cross-origin —
which is why core carries a bespoke, credentialed CORS branch just for it (`worker.ts:459-473`,
reflecting `env.ADMIN_ALLOWED_ORIGIN` with `Allow-Credentials: true`, the *only* origin granted
credentials). **We do not know where that SPA's source lives** (see Open questions).

So the admin surface is spread across `worker.ts`, `admin.ts` (467 lines), `billing.ts`,
`authz.ts`, `plans.ts`, the CORS logic, and a handful of admin-only env vars (`CF_ACCESS_*`,
`CF_AE_TOKEN`, `CF_ANALYTICS_TOKEN`, `ADMIN_ALLOWED_ORIGIN` — `env.ts:106-133`), and its UI is an
orphaned Pages project. **Root cause:** an internal, single-operator cockpit was co-deployed with
the public multi-tenant data plane because it was the fast path. That coupling now means every
admin read shares core's request path, deploy cadence, blast radius, and CORS surface — and the
one credential that can read **every** account's telemetry (`CF_AE_TOKEN`, a read-only
Account-Analytics grant, id `ca166a3e…`) lives on the public API Worker.

## Design

### The shape: one Access-gated origin, UI + API together

`rbox-admin` is a Cloudflare **Pages project** (Pages Functions for the API, or a small Worker
behind the same hostname) fronted by a **Cloudflare Access application** on `admin.rbox.to`. The
Access policy allows exactly one identity (`brian.a.via@gmail.com`) — the IdP gate, not public.

Crucially, rbox-admin serves **its own UI and its own `/api/*` from the same origin**. That single
decision is the biggest structural win (see CORS below) and the frame for everything else.

```
Browser (you, behind Access SSO)
        │  same-origin fetch → admin.rbox.to/api/overview
        ▼
Cloudflare Access (edge gate: SSO, one allowed identity)
        ▼
rbox-admin (Pages + Functions)
  ├─ in-app defense-in-depth: verify Cf-Access-Jwt-Assertion + email allowlist  ← ported from admin.ts
  ├─ read cockpit: D1-READ binding (prod rbox-prod-db)  ──► accounts/devices aggregates
  ├─ metrics reader: CF_AE_TOKEN → AE SQL API (pure HTTPS)
  ├─ Stripe MRR / CF 5xx: bounded best-effort fetches
  └─ (option B) mutations proxied server-side → core /v1/admin/* with x-rbox-platform secret
```

### 1. The central tradeoff — what moves vs what stays

This is the gating decision. Two coherent end-states:

**(A) Full move.** rbox-admin hosts the UI *and every* admin API — overview + `setPlan` + `gc`.
It gets its **own D1 + R2 bindings and the AE token**, and core ends with **zero** admin surface.
The cost is real and structural:

- rbox-admin becomes a **second deployment with data-plane WRITE access** — it can mutate
  `accounts` (plan/`extra_storage_bytes`/`grace_until`, `billing.ts:128-135`) and run destructive
  GC (`gcPurge` deletes R2 objects; `runPhase1` decrements entitlements). Two workers that can
  write the control plane is a larger attack/mistake surface than one.
- The GC and billing logic **lives in core today** and is **not portable as-is**: `adminSetPlan`
  depends on `GRACE_PERIOD_MS`, `PLANS`, `audit()`, and the §32 `dbFor` seam; `gc`
  (`gcMark`/`gcPurge`/`runPhase1`/`retentionPrune`) is coupled to `versions.ts`, `gc-phase1.ts`,
  `retention.ts`, `blob_refs`/`releaseUsage`, and the "no destructive GC while a push is active"
  cron invariant (`worker.ts:69-73`). Moving these means **duplicating or extracting** hundreds of
  lines of the most dangerous code in the system into a second repo, and keeping the two copies in
  lockstep forever. That is exactly the entropy the house rules say to fight.

**(B) Read-only move (recommended).** rbox-admin hosts the UI + the **read cockpit** (overview
aggregates + AE metrics + Stripe/5xx) with a **D1-READ binding**. The two rare **mutating** ops
stay in core, unchanged, behind the platform secret, and rbox-admin invokes them **server-side**
(from its Functions, never the browser) with `x-rbox-platform`:

- `setPlan` is explicitly **interim until Stripe** (`billing.ts:140-142`) — a handful of manual
  calls, ever.
- `gc` is **manual / quiescent** (the destructive `phase=purge` is a hand-run sweep;
  `worker.ts:211-215`), gated on no-active-push.

So the mutation logic stays where its dependencies already are; **no duplication, no second writer
of consequence** (rbox-admin holds the platform secret and proxies, but the authoritative mutation
still executes in core under core's invariants). Core keeps a **tiny two-route admin-mutation
surface** (`gc`, `setPlan`) and loses the whole read cockpit + CORS + AE token. Less "pure" than
(A), but it removes ~90% of the entangled code (all of `admin.ts`) without spreading write access
or forking GC/billing.

**Recommendation: ship (B).** The founder leans toward full removal from core, and (B) is a
strict subset of the path to (A) — you can promote `setPlan`/`gc` into rbox-admin later, once
there's a reason (e.g. Stripe goes live and `setPlan` dies entirely; GC gets a proper scheduler).
(B) gets the real win now — the privileged **read** surface and the cross-origin CORS branch leave
core, the all-account AE token leaves the public Worker — at a fraction of the risk. **Reaching
(A) is a follow-up, not a prerequisite.** Do not duplicate GC/billing into a second repo on day
one to satisfy purity; earn it.

### 2. How rbox-admin reaches data: a D1-READ binding, not core's API

For the read cockpit, bind rbox-admin's Functions to the **same prod D1 instance** (`rbox-prod-db`)
with a **read-only** binding, and run the aggregate queries directly — they are exactly the
grouped `SELECT`s in `computeAggregates` (`admin.ts:202-233`), which touch only `accounts` and
`devices`. This is cleaner than having rbox-admin call a core `/v1/admin/overview` endpoint,
because:

- it removes a network hop and a shared-failure-domain dependency (the cockpit renders even if the
  public API is degraded — appropriate for an *operations* console);
- it needs **no new public surface** on core;
- D1 read bindings are first-class on Pages Functions.

R2 is **not needed** for the read cockpit — `computeAggregates` never touches R2, and the AE
metrics come over HTTPS, not a binding. R2 would only be needed under **(A)** for `gcPurge`. So
under (B): **one D1-read binding, no R2 binding.**

The AE metrics reader is already effectively portable: `fetchServerMetrics` (`admin.ts:387-437`)
has **zero D1/R2 dependencies** — it is pure HTTPS `POST` to the AE SQL API
(`…/accounts/{CF_ACCOUNT_ID}/analytics_engine/sql`). Port it verbatim, changing only its inputs
from `env.*` to explicit config: `fetchServerMetrics({ aeToken, cfAccountId, dataset })`. (Note:
the `accountId` in that call is the **Cloudflare account id** in the SQL endpoint URL, not an rbox
account — the dataset `rbox_prod_metrics` is platform-wide and grouped by `op` in SQL, not per
tenant.) Config it needs: `CF_AE_TOKEN` (secret, id `ca166a3e…`, read-only Account-Analytics-Read),
`CF_ACCOUNT_ID`, `CF_METRICS_DATASET=rbox_prod_metrics`.

### 3. CORS + `ADMIN_ALLOWED_ORIGIN` disappear entirely

Today the SPA and API are different origins, so core carries a **credentialed CORS branch just for
admin** (`worker.ts:459-473`): reflect `env.ADMIN_ALLOWED_ORIGIN`, `Allow-Credentials: true`,
`Vary: Origin` — the only origin in the whole API granted credentials. When rbox-admin serves its
UI **and** its `/api/*` from **one origin**, those calls are **same-origin**: no preflight, no
`Access-Control-*`, no `ADMIN_ALLOWED_ORIGIN` env var. That entire branch and its env var delete
cleanly in the core-removal PR (step v). This is a concrete simplification, not just a move — it's
a reason to prefer consolidating UI+API in rbox-admin over keeping a separate SPA.

### 4. Security posture: keep defense-in-depth, keep secrets server-side

The Access edge gate is necessary but **not sufficient** — mirror `admin.ts`'s current model
exactly. Every rbox-admin API handler must, **in-app, behind the edge policy**:

1. verify the `Cf-Access-Jwt-Assertion` JWT (RS256, `iss` = team domain, `aud` = the Access app
   AUD, `exp`) against the Access JWKS — port `verifyAccessJwt` + `accessJwks` +
   `normalizeJwks`/`isJwksFresh` (`admin.ts:64-161`, already fail-closed and well-tested), and
2. enforce the **hardcoded** email allowlist (`admin.ts:28,32-36`) — kept in code, not
   env-weakenable, so a misconfigured deploy can't silently widen access.

This matters because rbox-admin holds strictly more privilege than the old SPA: a D1-read binding
to prod and the all-account `CF_AE_TOKEN`. Those secrets + the (option-B) platform secret live
**only on rbox-admin's server side** (Pages secrets / bindings) and **never reach the browser** —
the browser only ever sees rendered aggregates. The AE token can read **every** account's dataset,
so it must stay server-side behind the gate; that is the whole reason to move it off the public
Worker rather than leave it there.

### 5. Shared code: duplicate the one tiny constant, don't build a package

The only core code the read cockpit *needs* that isn't self-contained is `PLAN_MONTHLY_CENTS`
(`plans.ts` — three integers) for the MRR estimate. **Duplicate it** into rbox-admin. Standing up
a shared `@rbox/*` package (monorepo/workspace wiring, versioning, a publish step) to share three
numbers is over-engineering at solo-founder stage — the classic premature-abstraction trap. The
JWT-verification block and `fetchServerMetrics` are copied once and then **owned** by rbox-admin;
they are stable, security-sensitive, and rarely change, so a copy is fine and arguably safer than a
shared dependency that couples the two deploys. If a genuinely shared surface emerges later
(unlikely for an internal console), extract then. Copy the constant; move on.

### 6. Cutover plan (the spine)

Strictly additive, prove-before-remove. Core is untouched until the final step.

- **(i) Scaffold rbox-admin.** New repo `../rbox-admin`; Cloudflare Pages project; a Cloudflare
  **Access application** over its hostname with the one-identity policy; bindings/secrets:
  D1-read → `rbox-prod-db`, `CF_AE_TOKEN` (`ca166a3e…`), `CF_ACCOUNT_ID`, `CF_METRICS_DATASET`,
  `CF_ANALYTICS_TOKEN` + `CF_WORKER_NAME` (for the 5xx panel), `STRIPE_SECRET` (MRR), the
  `CF_ACCESS_*` verification config, and (option B) `RBOX_PLATFORM_SECRET` for server-side proxying.
  **Gate:** Access challenges an anonymous request; the allowlist rejects a non-allowlisted verified
  identity.
- **(ii) Port the read cockpit + metrics + UI.** Move (copy) `computeAggregates`,
  `fetchStripeMrrCents`, `fetchFiveXxRate`, `fetchServerMetrics`, and the JWT-verify block into
  rbox-admin Functions; build (or rebuild) the UI to render `AdminOverview` (`admin.ts:441-446`).
  **Gate:** local/dev preview renders against a dev D1 + dev AE dataset.
- **(iii) Deploy + VALIDATE against prod.** Deploy rbox-admin; behind the Access gate, confirm the
  **AE metrics render** (the `blob.get` D1-vs-R2 split, outcome histogram, commit percentiles) and
  the **D1 aggregates match** what core's live `/v1/admin/overview` returns *right now* (run both,
  diff the numbers). **Gate:** aggregates agree within the sampling window; metrics panels populate;
  Stripe/5xx figures resolve (or degrade to null identically). This is the **prove** step — do not
  proceed until green.
- **(iv) Cut `admin.rbox.to` to the new project.** Point the DNS/Pages route + Access app at
  rbox-admin, retiring the old orphaned SPA project. **Gate:** production `admin.rbox.to` serves the
  new UI behind Access and renders live prod data end-to-end.
- **(v) ONLY THEN: open the `rbox-core` removal PR** (below). Until this PR merges, **core still
  has all three routes** — so rollback at any earlier step is "don't cut DNS / revert the DNS cut,"
  and core is never in a broken intermediate state.

**Rollback:** trivial through step (iv) — core is unchanged, so reverting is a DNS/Access flip back
to the old SPA. After step (v) merges, rollback is a standard `git revert` of that one PR (core
regains the routes). At no point is there a window where admin is unavailable *and* core can't serve
it.

### 7. What the core-removal PR (step v) deletes

Scoped inventory so the cleanup PR is mechanical. **Under (B), `gc` + `setPlan` routes STAY;**
everything below is the read-cockpit + CORS + AE-read footprint:

- **`worker.ts`:** the `GET /v1/admin/overview` route (`:217-221`) and its `adminOverview` import.
- **`admin.ts`:** the whole file (`adminOverview`, `computeAggregates`, `fetchStripeMrrCents`,
  `fetchFiveXxRate`, `fetchServerMetrics`, the JWT-verify block, the allowlist) — **all 467 lines**.
- **CORS:** the admin-origin branch (`worker.ts:459-473`) and the `ADMIN_ALLOWED_ORIGIN` env var
  (`env.ts:133`).
- **`fetchServerMetrics` / AE-read config just added in PR #30:** `CF_AE_TOKEN` (`env.ts:121`),
  `CF_METRICS_DATASET` (`env.ts:125`) as a *read* input, and the read token secret on the prod
  Worker. **Keep** `CF_ANALYTICS_TOKEN` only if any non-admin core path uses it (it does not today —
  verify at PR time); it can likely go too.
- **`CF_ACCESS_*`** (`env.ts:106-112`) — used only by the admin JWT gate; removable once no admin
  route remains in core.
- **Do NOT remove** (STAYS in core): the metrics **WRITE** path — `metrics.ts` `OpSpan`/`startOp`
  and the `analytics_engine_datasets` binding (`wrangler.jsonc:30,103`); `PLAN_MONTHLY_CENTS`
  (still used by core? it is used *only* by `admin.ts` today — if so it moves/dies with admin;
  verify no other importer at PR time); and under (B), `gc`/`setPlan` + `isPlatform` +
  `RBOX_PLATFORM_SECRET` + `adminSetPlan`/GC internals.

Under **(A)**, additionally remove the `gc` + `setPlan` routes, `adminSetPlan`, `isPlatform`/
`RBOX_PLATFORM_SECRET` (if nothing else uses it — it gates only admin today), and migrate the GC
internals — but again, that's a later milestone, not this cutover.

## Risks

- **Two writers of the control plane (only under A).** Giving rbox-admin D1/R2 WRITE + duplicated
  GC/billing doubles the surface that can corrupt `accounts` or delete R2 objects. (B) avoids this
  entirely by keeping mutation in core. This is the core reason to prefer (B).
- **Direct D1-read coupling to schema.** rbox-admin's aggregate `SELECT`s bind to the live
  `accounts`/`devices` shape (`reclaimed_at`, `revoked`, `expires_at`, `stripe_subscription_id`,
  `plan`). A core migration that renames/moves those columns silently breaks the cockpit. Mitigation:
  the queries are small and few (`admin.ts:202-233`); keep them in one file and treat schema drift as
  a known coupling. (Calling core's API instead would trade this for a runtime dependency — worse for
  an ops console.) **Note:** under §32's founder decision, `accounts` stays whole on its shard at
  N=1, so a D1-read binding to the one prod DB is correct today; a real shard cutover would need
  rbox-admin to fan out reads, same as core's `dbFor(env,"")` sites.
- **Secret sprawl.** rbox-admin accumulates the AE token, Stripe secret, CF Access config, and
  (B) the platform secret. They're all server-side behind Access, but it's a second place to rotate
  them. Document the set; it's the price of isolating privilege off the public Worker.
- **The all-account AE token.** Moving `CF_AE_TOKEN` to rbox-admin is a *net* security win (off the
  public API), but rbox-admin must be as hardened as the token is powerful — hence keeping the
  in-app JWT+allowlist defense-in-depth, not trusting Access alone.
- **Cutover data-skew false alarm.** In step (iii), core's live `/overview` and rbox-admin's read
  may differ slightly if sampled at different instants (signups tick, `last_seen` moves). Diff
  tolerances, not exact equality, or freeze by comparing the same rolling windows.
- **Lost SPA source ⇒ rebuild cost.** If the current SPA source is unrecoverable (see Open
  questions), step (ii) includes building the UI fresh — more work, but also a chance to co-locate
  it with its API and delete the CORS dance. Scope this before committing a date.

## Open questions for the founder

1. **(A) full move vs (B) read-only move** — the gating decision. Recommendation: **(B) now**
   (UI + read cockpit move; `setPlan`/`gc` stay in core behind the platform secret, proxied
   server-side), promotable to **(A)** later. Confirm, or insist on full removal from core in one
   step (accepting duplicated/extracted GC+billing and a second control-plane writer)?
2. **Where is the current `admin.rbox.to` SPA source?** It is a separate Pages project with no
   known local repo (`admin.ts:16-18`). Is it recoverable (so step ii ports it), or do we **build
   rbox-admin's UI fresh**? This drives the effort estimate for step (ii)/(iv).
3. **Data access: D1-read binding vs core API call.** Recommendation: **D1-read binding** to
   `rbox-prod-db` (no hop, renders under core degradation, no new public surface). Any reason to
   prefer rbox-admin calling a core endpoint instead (e.g. you want a single query owner)?
4. **Shared `PLAN_MONTHLY_CENTS`: duplicate vs package.** Recommendation: **duplicate** the three
   integers; no shared package at this stage. Agree?
5. **Does `setPlan` survive at all?** It's interim-until-Stripe (`billing.ts:140-142`). If Stripe
   goes live first, `setPlan` may die before the extraction lands, collapsing (B)→(A) for free on
   the billing side. Sequence rbox-admin relative to Stripe go-live?
6. **Doc numbering:** `41` collides with `41-daemon-watcher-scale.md`. Renumber this doc?
