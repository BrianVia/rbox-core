# Review 157 — Checkout owner email

## Round 1

Verdict: aligned after clarification.

- Reuse `resolveOwners`; do not infer the owner from the request principal.
- Only `ownerEmail`'s `ok` result supplies an address; `absent`, `error`, and
  thrown owner/email lookup failures all omit it.
- Limit the soft-fail catch to lookup work so Stripe and price errors remain
  visible, and never run lookup for an existing Stripe customer.
- Use mapped-owner fixtures and exact form-key assertions. Prove both cached
  success and the existing-customer no-Clerk-call invariant non-vacuously.

The design was revised with each point. Both reviewers are aligned; no second
round is required.
