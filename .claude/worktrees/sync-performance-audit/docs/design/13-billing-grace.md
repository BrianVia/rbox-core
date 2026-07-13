# Design 13 — Billing downgrade grace period

**Status:** codex **PASS** (NEEDS-PASS → 2 BLOCKER + 5 SHOULD-FIX resolved in §9
G1–G8 → 2 confirm rounds → PASS). §9 is normative (overrides any earlier prose,
e.g. re-subscribe does NOT clear `grace_until`). Implements
the product decision: **on downgrade we never delete a user's data; we stop new
uploads; downloads keep working; and a 30-day grace window preserves EVERYTHING
(incl. version history) before free-tier retention resumes.**

## 0. What already holds today (so we change the minimum)
Verified in code (`billing.ts`, `versions.ts`, `retention.ts`, `stripe.ts`):
- **Nothing reachable is ever deleted.** GC (`gcMark`/`gcPurge`) only reclaims
  **unreachable** blobs; the DO sequencer **never prunes the head**, so the
  current manifest + its blobs always survive. Downgrade can't delete current files.
- **New uploads over the cap are already blocked**, never destructively:
  `grantEntitlementWithQuota` refuses the charge → HTTP 402; the orphan ciphertext
  is left for GC, committed data untouched. Free cap = 2 GiB (`plans.ts`).
- **Downloads / `pull` are never quota-gated** — blob GET serves regardless of plan.
- **Downgrade trigger exists**: the Stripe webhook flips `accounts.plan` to `free`
  on `customer.subscription.deleted` / non-paying `.updated`.

**So "don't delete + stop new uploads + allow downloads" is ALREADY the behavior
— except for ONE destructive path:** `retentionPrune` (daily cron) sets each
workspace's prune floor from `planFor(plan).retentionDays`. Free is **0 days**, so
the first cron after a downgrade prunes ALL version history down to current-state,
and GC then reclaims those old-version blobs. That's the only "deletion" a
downgrade causes today, and it's immediate. The grace period gates exactly that.

## 1. Policy (precise)
- **t=0 (downgrade):** `plan → free`, but stamp `grace_until = now + 30d`.
- **During grace (`now < grace_until`):** retention does **NOT** prune — the
  account keeps ALL version history (effective `retentionDays = ∞`). New uploads
  over the free cap are blocked (unchanged). Downloads work (unchanged). Nothing
  deleted.
- **After grace (`now ≥ grace_until`):** free-tier retention resumes
  (`retentionDays = 0`) — old **version history** is pruned, but the **current
  state is still never deleted** (reachable + head-protected) and stays
  downloadable indefinitely. New uploads still blocked while over cap.
- **Re-subscribe at any time:** webhook sets `plan → paid` and **clears
  `grace_until`** → full paid retention restored, uploads unblocked under the
  paid cap.

Accepted product tradeoff (flag for confirmation): because we never delete
reachable current data, a downgraded account that had, say, 50 GiB of *current*
files keeps it stored for free indefinitely (only history is trimmed post-grace).
That's the explicit "don't delete anything" cost; a future "archive/cold" tier
could revisit it. Not in scope here.

## 2. Schema
`migrations/0012_billing_grace.sql`:
```sql
ALTER TABLE accounts ADD COLUMN grace_until INTEGER; -- epoch ms; NULL = no grace
```
NULL for free-from-start accounts (they were never paying → no grace, normal free
retention). Non-null only after a paid→free transition.

## 3. Webhook changes (`stripe.ts applyStripeEvent`)
- `customer.subscription.deleted` → on the downgrade UPDATE, also set
  `grace_until = nowMs + GRACE_MS` (30d). Only set when transitioning FROM paying
  (i.e. the row currently has a non-free plan / a bound subscription) so repeated
  deletes / already-free accounts don't keep extending it. Pass `nowMs` (already
  threaded into `stripeWebhook`) so it's testable.
- `customer.subscription.updated` to a non-paying status → same: `plan='free'` +
  set `grace_until` (only if coming from paying).
- `customer.subscription.updated`/`created` to **active/trialing** → set the paid
  plan and **leave `grace_until` untouched** (§9 G6 — clearing it would let a
  cancel within the unexpired window re-grant). The existing ownership guard
  (`WHERE id=? AND (stripe_customer_id IS NULL OR =?)`) stays — grace is set in the
  same guarded UPDATE so it can't be flipped on an account bound to another customer.

## 4. Retention change (`retention.ts`)
`retentionPrune` joins `accounts`; also select `a.grace_until`. Per workspace:
- If `grace_until != NULL AND now < grace_until` → **skip** (no prune; retain all).
- Else use `planFor(resolveAccountPlan(...)).retentionDays` as today.

`resolveAccountPlan` stays the effective-tier seam (still returns the stored plan;
when live-Stripe reconciliation lands there, grace is orthogonal — grace is about
*when* free retention starts biting, not *which* tier). The DO `prune` path is
unchanged (still head-protected). `now` is injected (Date.now in prod) for tests.

## 5. Surface it (so the UX can nudge)
`GET /v1/account/usage` adds `graceUntil` (ms or null) + a derived
`readOnly: used > cap` hint so the dashboard/CLI can show: *"Your plan ended —
your files are safe and downloadable; new uploads are paused. Re-subscribe before
<date> to keep full version history."* (Pure additive response field; no gate.)

## 6. Non-goals / unchanged
- No change to the quota path (uploads already 402 over cap — that IS "stop adding
  new files"). We do NOT add a separate hard read-only flag; over-cap + free is
  the read-only condition, and an under-cap downgraded user legitimately keeps
  using the free tier.
- No deletion anywhere. GC reachability is unchanged.
- Aside (separate 1-line change, same PR): `billingCheckout` gains
  `allow_promotion_codes: true` so a 100%-off coupon code can be entered at
  checkout (for the launch test + real promos). Not part of the grace logic.

## 7. Verification
- Webhook unit (Miniflare): subscription.deleted on a paid account → `plan='free'`
  AND `grace_until ≈ now+30d`; a second delete doesn't extend it; re-activate →
  paid plan AND `grace_until=NULL`; a delete for a customer NOT bound to the
  account → no change (ownership guard).
- Retention unit: an account in-grace → `retentionPrune` skips it (history kept,
  0 pruned); same account past `grace_until` → free pruning runs (history trimmed,
  head/current survives); a free-from-start account (grace NULL) → free pruning as
  today.
- Data-safety assertion: in all cases the head sequence + current-state blobs
  remain reachable (never pruned), and blob GET is never gated.
- `usage` returns `graceUntil` + `readOnly` correctly across active / in-grace /
  expired-grace.

## 9. Resolutions to codex review (NORMATIVE; amends §2–§7)

**G1 [BLOCKER] Grace predicate = pre-update `plan <> 'free'`, in one atomic UPDATE.**
Never key off `stripe_subscription_id` (non-paying `updated` keeps the id). Set
`plan` + `grace_until` in a single guarded UPDATE whose CASE reads the pre-update
row, and **only grant if not already in an unexpired grace** (kills both
at-least-once `deleted` re-extension AND subscribe/cancel re-extension — G6):
```sql
-- customer.subscription.deleted
UPDATE accounts SET
  plan = 'free', stripe_subscription_id = NULL, extra_storage_bytes = 0,   -- G5
  grace_until = CASE WHEN plan <> 'free' AND (grace_until IS NULL OR grace_until < ?nowMs)
                     THEN ?graceEnd ELSE grace_until END
WHERE id = ? AND stripe_customer_id = ? AND stripe_subscription_id = ?;
-- non-paying customer.subscription.updated: same SET, WHERE id=? AND (stripe_customer_id IS NULL OR =?)
```
Re-subscribe (`active`/`trialing`) sets the paid plan and **does NOT touch
`grace_until`** (G6): it's only read when `plan='free'`, and clearing it would let
a cancel within the still-unexpired old window re-grant a fresh 30d (defeating
once-per-window). Preserving it means a subscribe→cancel loop inside 30d hits the
`grace_until < nowMs` guard → no re-grant; only a cancel after the window expires
re-grants (they had a paid/promo month — acceptable). `stripe_events`
success-recording is unchanged → a replay after "UPDATE ok, event-insert failed"
re-runs the UPDATE, but the CASE (`plan<>'free'` is now false, plan already 'free')
no-ops on grace. ✔ idempotent.

**G2 [BLOCKER] Retention floor source → `commits`, epoch-ms, injected clock.**
`retentionPrune` reads `manifests.created_at`, but E2EE commits write `commits`
(`workspace-sync` mirror) — so free retention never runs today. Fix: compute the
floor from `commits` and a millisecond cutoff (the column defaults to
`unixepoch()*1000`), using an injected `nowMs`:
```sql
SELECT MAX(sequence) AS floor FROM commits
WHERE workspace_id=? AND project_id=? AND created_at < ?   -- ? = nowMs - days*86400000
```
(`days=0` → cutoff=`nowMs` → all committed-before-now prunable; DO still caps at
head-1.) This is a pre-existing bug the grace work must fix to mean anything.
Legacy `manifests`-only workspaces (pre-E2EE) are **out of scope** — dev + prod
were greenfield-wiped (design 12 §9), so every live workspace is `commits`-based;
a workspace with no `commits` rows simply yields floor 0 → skip (no prune), which
is safe.

**G3 [SHOULD-FIX] State + DIRECTLY TEST the reachability invariant.** "Nothing
reachable is deleted" holds because GC reachability = each retained commit's
`encManifestSha` + `blobRefs.encSha`, and the client's `buildCommit` sets
`blobRefs` = exactly the current manifest's file encShas (+ the encManifest).
Add a **direct engine unit test**: build a commit from a manifest with N encrypted
files and assert `blobRefs`'s encSha set === the manifest's file-encSha set (the
GC-root invariant) — not just the round-trip. (Round-trip proves decryptability,
not that GC would retain every referenced blob.)

**G4 [SHOULD-FIX] Fail-fast over-cap before R2 ingress.** Add an early storage-cap
check in `blobPut` (single PUT — `content-length` available) and `multipartInit`
(declared `size` available): if `used + incomingSize > cap`, 402 BEFORE writing
canonical R2 — bounds orphan-R2 cost and makes "new uploads stop" immediate. (Use
`used + size > cap`, not `used >= cap`, since the incoming size is known.) The
authoritative charge stays `grantEntitlementWithQuota` at finalize (early check is
fast-fail, not a substitute — it's racy by itself, but the finalize grant is
serialized). This also gives the CLI a clean "you're over your plan" error pre-upload.

**G5 [SHOULD-FIX] Clear `extra_storage_bytes` on downgrade** (in the same UPDATE,
above) so a downgraded free account's cap is actually 2 GiB, not 2 GiB + leftover
paid extras. `storageCap` keeps summing extras (correct for paid).

**G6 [SHOULD-FIX] Bound subscribe/cancel abuse — preserve `grace_until` while paid.**
Resolved by NOT clearing `grace_until` on re-subscribe (see G1): the
`grace_until < nowMs` guard then blocks any re-grant within the unexpired window,
so a subscribe→cancel loop inside 30d can't extend it. A loop spanning >30d
re-grants once (acceptable — a full window elapsed). Stronger future fix (grant
only on `invoice.payment_succeeded` amount>0, never on a 100%-off promo sub) noted
as a follow-up; the promo code is ours (launch/test), not public self-serve.

**G7 [SHOULD-FIX] `adminSetPlan` downgrades reuse the SAME predicate/clock.** When
`adminSetPlan` sets `plan='free'`, apply the identical CASE
(`plan<>'free' AND (grace_until IS NULL OR grace_until < nowMs)`) + clear extras,
so the platform path can't reintroduce extension drift. Only paid→free stamps grace.

**G8 [NICE] `readOnly = used >= cap`** (quota predicate is `used + size <= cap`, so
exactly-at-cap is already read-only for any positive upload).

## 8. Open questions for codex
1. Is "skip retention entirely during grace" right, or should grace retain the
   PREVIOUS paid tier's `retentionDays` (e.g. 90) rather than ∞? (∞-for-30-days is
   simpler and strictly safer for the user; the only cost is storing old-version
   blobs 30d longer.)
2. The downgrade "only set grace_until when coming FROM paying" guard — what's the
   exact, race-safe SQL predicate (e.g. `WHERE plan != 'free' OR stripe_subscription_id IS NOT NULL`)
   so a duplicate/late `subscription.deleted` can't repeatedly push the window out?
3. Storage cost of never deleting reachable current data for a downgraded free
   account (§1 tradeoff) — acceptable, or do we need a post-grace cap-enforcement
   story (which would mean *some* deletion, contradicting "don't delete")?
4. Clock source: webhook uses `nowMs`; retention uses injected `now`. Any
   timezone/`datetime('now')` mismatch with the existing `manifests.created_at`
   window math?
5. Anything that lets grace be abused (e.g. subscribe→immediately cancel loops to
   keep an account perpetually in a no-prune state)?
