# 157 — Prefill new-customer checkout with the owner email

Status: **REVIEWED v1**

Source: root `SPEC.md` (validation item 4). Scope is limited to Stripe checkout,
the existing notification email lookup seam, and API acceptance coverage. No
module ownership changes are involved, so `docs/CODEMAP.md` is unchanged.

## Behavior

- For an account without `stripe_customer_id`, resolve the account owner through
  the existing `memberships` → `clerk_users` path in `notify.ts`, then reuse
  `ownerEmail(env, clerkUserId, now)` for its cached/live Clerk lookup.
- Use the mapped owner returned by that path, never `Principal.userId` or a loose
  account-only `clerk_users` query. Zero mapped owners omits the email; if the
  schema ever permits several Clerk-backed owners, use the first resolved owner
  (the current unique account bridge constrains this to at most one).
- If that lookup returns an address, send it to Stripe as `customer_email`.
- If no owner mapping/address is available, `ownerEmail` returns `absent` or
  `error`, or any owner/email lookup operation throws, omit `customer_email` and
  continue creating checkout exactly as before.
- For an account with `stripe_customer_id`, perform no owner-email lookup and
  send only `customer`; never send both Stripe parameters.
- Preserve all existing checkout validation, price resolution, trial, metadata,
  success/cancel URL, and promotion-code behavior.

## Structure

- Export the existing `ownerEmail` lookup from `notify.ts`.
- Export/reuse the existing owner-resolution helper rather than reproducing its
  directory query in `stripe.ts`.
- Add a small best-effort checkout helper in `stripe.ts` that catches failures
  across owner resolution and email lookup, translating every non-success into
  `undefined` for Stripe parameter omission.
- Keep the catch boundary around only owner resolution and `ownerEmail`, including
  D1 cache-read failures. Price resolution and Stripe session failures retain
  their existing error behavior.
- Resolve the email only on the no-customer branch after existing checkout
  guards and price resolution have succeeded.

## Acceptance coverage

Extend `apps/api/test/worker.test.ts` to prove:

1. A new-customer checkout includes URL-encoded `customer_email` when the owner
   membership has a matching `clerk_users` bridge with a cached sign-in email,
   without a Clerk fetch.
2. A new-customer checkout still succeeds and omits `customer_email` when no
   cached email exists and the live Clerk lookup fails.
3. An existing-customer checkout with a mapped uncached owner includes `customer`
   and omits `customer_email`, with an unchanged Clerk fetch count.

Parse Stripe request bodies with `URLSearchParams` and assert exact parameter
keys rather than substring matches.

Run `bun run typecheck` and `bun run test:api` from the worktree.
