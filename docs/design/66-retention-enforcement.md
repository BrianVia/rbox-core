# 66 — Retention enforcement: close the Stripe-reconciliation seam

**Status:** BACK BURNER — design only, no customers yet.
**Depends on:** design 13 (billing downgrade grace, **shipped**, codex PASS),
design 33 (per-account GC Phase 1, **shipped**), design 06 (versions GC).

## 0. Correcting the brief

This doc was scoped assuming retention enforcement doesn't exist yet — it does.
Verified in code:

- `retentionPrune` (`apps/api/src/retention.ts:35-89`) sets each workspace's DO
  prune floor from the owning account's `plans.ts` `retentionDays`, joins
  `accounts.grace_until` for the downgrade-grace skip, and floors off the
  `commits` table (epoch ms) — not the legacy empty `manifests` table.
- It runs every hour, first in the cron, in its own try/catch so one broken
  workspace can't starve GC Phase 1 for every other account
  (`apps/api/src/worker.ts:90-101`, specifically the `await retentionPrune(env)`
  at line 98).
- The DO `prune` handler never drops the head (`workspace-sync.ts:369`:
  `target = Math.min(Number(body.floor ?? 0), head - 1)`).
- Downgrade semantics are shipped and codex-passed, not a design choice left
  open here: **30-day grace** (not 7, see below), `plan → free` +
  `grace_until = now + 30d` stamped in the same guarded UPDATE as the Stripe
  webhook's plan flip (`docs/design/13-billing-grace.md` §1, §9 G1). During
  grace, retention skips entirely (effective `retentionDays = ∞`); after grace,
  free-tier pruning resumes but current state is never touched (head-protected,
  same invariant as always).
- Quota accounting on prune is also shipped: GC Phase 1 (`gc-phase1.ts:138`)
  decrements `used_bytes` when a last-ref blob is purged past its grace window,
  plus a reconciler (`gc-phase1.ts:189`) that re-derives `used_bytes` from
  scratch. This is a general mechanism (any ref losing its last reference,
  retention-triggered or not) — there's no retention-specific accounting to add.

**What's actually stale:** the doc-comment at `apps/api/src/plans.ts:10-12`
still says *"NOTE: not yet ENFORCED... no plan-driven prune runs it yet"* — false
since `retentionPrune` shipped. Also `README.md:101`'s plan table lists Free
retention as **"7 days"**, contradicting both `plans.ts` (`retentionDays: 0`)
and `docs/pricing.md:9` ("No version history — current state only"). Both are
copy bugs, not enforcement gaps; fix opportunistically (§66 doc 67 F touches
`README.md` anyway).

## 1. Problem (the one real gap)

`resolveAccountPlan` (`retention.ts:22-25`) is a hardcoded pass-through of the
stored `accounts.plan` column with an explicit `TODO(stripe)` for live
reconciliation against the actual Stripe subscription. Today `accounts.plan`
is kept in sync by the webhook (`stripe.ts`, confirmed: `customer.subscription.*`
events UPDATE `plan` in the same statement that manages `grace_until`, e.g.
`stripe.ts:207-220`), so the column is *usually* correct. The gap is
self-healing: if a webhook delivery is ever missed (Stripe outage, a dead
letter, a manual DB edit by support), nothing notices — the account keeps
whatever `accounts.plan` says until some other event flips it, with no
periodic check against the source of truth.

## 2. Decision

Defer live Stripe reconciliation. There are no paying customers yet (per
task brief), so the blast radius of a stale-plan-row bug is zero today, and
Stripe's webhook delivery already retries with backoff + signature
verification — the realistic failure mode (a permanently missed webhook) is
rare and currently invisible only in the sense that nothing double-checks it.
Revisit once there's real subscription volume where a missed webhook would
mean an account overstaying a paid tier for free (or the reverse: an
under-billed downgrade).

Immediate, no-cost fix regardless of backburner status: correct the stale
`plans.ts:10-12` comment and the `README.md:101` retention column (tracked
under design 67 F, not duplicated here).

## 3. Mechanism (for whenever this is picked up)

`resolveAccountPlan` becomes:

```ts
const sub = await stripeSubscriptionStatus(env, accountId); // new helper
if (!sub) return storedPlan ?? "free";          // no Stripe subscription on file — stored plan stands
if (sub.status !== "active" && sub.status !== "trialing") return "free"; // lapsed
return sub.plan;                                 // authoritative tier
```

Fail-open to `storedPlan` on any Stripe API error (timeout, 5xx) — a
reconciliation check must never turn a transient Stripe outage into a false
downgrade for a paying customer. This makes reconciliation a periodic
safety-net over the webhook, not a replacement for it: the webhook stays the
primary, low-latency path (a downgrade shouldn't wait for the next hourly
retention cron to take effect), and `resolveAccountPlan` only needs to catch
the case where the webhook never fired at all.

Cost: one Stripe API call per account per `retentionPrune` cron tick. At
today's cross-shard fan-out shape (§32, `retention.ts:36-39`) this is one call
per workspace row, not per account — worth batching or caching per-account
within a single cron run if/when this ships, to avoid N calls for an account
with many workspaces.

## 4. Test plan (for whenever this is picked up)

- Unit `resolveAccountPlan` against a mocked Stripe client: active subscription
  → returns its plan; canceled/past_due → `"free"`; no subscription on file →
  stored plan; Stripe API throws → stored plan (fail-open), not `"free"`.
- Regression: a webhook-missed scenario (stored plan says `pro`, mocked Stripe
  says canceled) → next `retentionPrune` run resolves `"free"` and prunes
  accordingly, without touching `grace_until` (grace is a webhook-side stamp,
  untouched by this reconciliation path).

## 5. Out of scope

- Re-litigating the grace period policy (30 days, skip-entirely-during-grace) —
  settled and shipped in design 13, `codex PASS`.
- Quota accounting on prune/purge — shipped (GC Phase 1 + reconciler,
  `gc-phase1.ts`).
- The hourly cron's ordering/isolation (retention → Phase 1 → notify sweep →
  diagnostics sweep → account-delete sweep, each in its own try/catch) — shipped,
  `worker.ts:90-135`.
- Any UI/CLI surfacing of `graceUntil`/`readOnly` — already returned by
  `GET /v1/account/usage` per design 13 §5.
