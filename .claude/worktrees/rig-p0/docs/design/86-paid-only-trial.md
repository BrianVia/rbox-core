# Design 86: Paid-only plans, 14-day card-upfront trial, annual billing

**Status:** ✅ Shipped 2026-07-08 (PR #159; prod worker + migration 0021 applied)
**Depends on:** design 07b (billing), design 13 (billing grace)
**Supersedes:** the free tier everywhere (design 07b's `free` row, design 13's downgrade-to-free target)

## Why

Free cloud storage is an abuse magnet, and rbox is run by a single engineer who
does not want to eat a surprise egress/storage bill. The free tier is gone from
marketing (rbox.to already shows paid-only + "why no free plan"). The product
must follow: every account is either **trialing/paying** or **locked**. The
try-before-buy funnel moves to a **14-day Stripe trial with card upfront** —
time-limited storage is not worth abusing. Annual billing (2 months free) ships
at the same time: Solo $80/yr, Pro $200/yr, extra-100GB $30/yr.

Prod reality check (2026-07-08): the production D1 has exactly one account
(the founder's, on `pro`). There is nothing to grandfather. Free can be removed
outright.

## The `none` plan (locked state)

`free` is replaced by `none` — not a tier, a *state*: the account exists,
devices can authenticate, data is readable, writes are refused.

```
none: { storageBytes: 1, workspaces: 1, projects: 1, retentionDays: 0,
        manifestBytes: 16 MiB, devices: 2 }
```

- `storageBytes: 1` (one byte, not zero): `cap_bytes <= 0` disables the SQL cap
  guard (= unlimited), so the locked floor must be a positive number. One byte
  means `wouldExceedCap` and the `accounts_cap_guard` trigger fail every upload
  → 402 `quota_exceeded`; **reads/pulls are untouched** (reads are not
  cap-gated). Cancel = keep your data, pull anytime, push nowhere: winback-
  friendly and bill-safe.
- `devices: 2`: enough to bootstrap a laptop before paying; not enough to farm.
- `workspaces: 1`: lets `rbox setup` create the workspace and hit the paywall
  at first push with a clear message instead of dying earlier with a confusing
  workspace error.
- `retentionDays: 0`: after the 30-day grace (design 13, unchanged), history
  prunes to head. Same as free today.

**Fail closed:** `planFor(null | unknown)` falls back to `PLANS.none` (today it
falls back to `free`). An unrecognized plan string must never grant storage.
The platform `'default'` account (cap_bytes = 0, app-checked, excluded in
migration 0016) is deliberate and untouched.

## Account lifecycle

- **Creation** (all three INSERTs: `bootstrap.ts`, `clerk.ts`, the
  `account-link.ts` unlink-shell, plus the `stripe.ts` repoint saga): plan
  `'none'`, `cap_bytes = capBytesFor("none")`.
- **Trial:** `billingCheckout` adds `subscription_data[trial_period_days]=14`
  **only when `accounts.stripe_customer_id IS NULL`** (first-ever checkout).
  Re-subscribes after cancel get no second trial. Card is collected by Stripe
  checkout in subscription mode as normal. The existing webhook already treats
  `status === "trialing"` as paying (stripe.ts L204) — a trialing account lands
  on its purchased plan with zero new logic.
- **Cancel / dunning / deletion events:** downgrade target changes
  `'free'` → `'none'` in `applyStripeEvent` (subscription.updated non-paying,
  subscription.deleted), `adminSetPlan`, and `graceCase()` (`plan <> 'none'`).
  Grace stamp (30 days) and retention behavior are otherwise design 13
  verbatim.
- **`resolveAccountPlan`:** `storedPlan ?? "none"`.

## Annual billing

- `PLAN_LOOKUP_KEYS` becomes cadence-aware:
  `solo: { monthly: "rbox_solo_monthly", annual: "rbox_solo_annual" }`, same
  for pro; extra storage gains `rbox_extra_100gb_annual`. Team unchanged
  (not purchasable).
- Checkout accepts `?plan=solo&cadence=annual|monthly` (default monthly for
  backward compat). The extra-storage price attached to a subscription must
  match the subscription's interval (Stripe subscriptions do not mix
  intervals): annual subs use the annual extra-storage price.
- Web `plan-intent` carries `{plan, cadence}`; the marketing site already sends
  `?plan=solo&cadence=annual`.
- CLI `rbox subscribe` gains `--annual`.
- **Deploy prerequisite (manual, before merge):** create the three annual
  prices in Stripe with lookup keys `rbox_solo_annual` ($80/yr),
  `rbox_pro_annual` ($200/yr), `rbox_extra_100gb_annual` ($30/yr).
  `priceIdForPlan` resolves by lookup_key, so no code deploy coupling.

## Migration 0021

- Backfill: `UPDATE accounts SET plan = 'none' WHERE plan = 'free'` (no-op in
  prod, cleans dev).
- Recreate the two cap triggers (0014's `accounts_cap_sync`, 0016's
  `accounts_cap_on_insert`) and their CASE: solo/pro/team caps unchanged,
  `ELSE 1` (was `ELSE 2 GiB`), keeping 0016's `id <> 'default'` exclusion on
  the insert trigger. Re-run the cap backfill for `'none'` rows.
- The four duplicated CASE literals (0014 ×2, 0016 ×2) are superseded by 0021's
  trigger recreation; `plans.ts` stays the TS source of truth.

## Surfaces

- **CLI `rbox setup`** (create-account path): after account creation, before
  first sync — print + open the checkout URL ("Start your 14-day free trial —
  card required, cancel anytime"), poll `usage` until `plan !== 'none'`
  (mirror the device-code polling pattern from design 47), then continue. If
  the user bails, finish setup gracefully with: sync disabled until
  `rbox subscribe`.
- **CLI messages:** `account status`/`usage` fallbacks `'free'` → `'none'`
  (render as "no active plan"); push 402 error message says "no active plan —
  run rbox subscribe" when plan is none.
- **Web dashboard:** drop the `free` tier from the PLAN map; `plan === 'none'`
  renders a "Start your 14-day free trial" panel with the solo/pro cards and a
  monthly/annual toggle matching the marketing site. Billing-success polling
  breaks on `plan !== 'none'`.
- **Slack pings:** new-account plan `none`; churn message "locked (grace
  started)" instead of "downgraded to free".
- **Docs:** `docs/pricing.md`, `README.md` plans table lose the Free row and
  gain annual prices + trial line; design README gains this entry.
