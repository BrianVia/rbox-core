# SPEC 189 · Unit 4 — web approval page (step-up + fragment compare + CSP)

Implement the WEB half of design 189. READ the aligned doc
docs/design/189-web-approved-pairing.md (§3 steps 2-3, §5.1-5.3 & 5.7, §8) and
WIRE-189.md (Unit 1's endpoint/field shapes — bind to THOSE). Do NOT touch
apps/api, src/cli, or the daemon. This is the TASTE-SENSITIVE unit — the parent
Fable session owns the copy + CSP decisions and will run a visual-validation
loop; implement to the design intent below and expect a review pass.

## Objective

Turn the cli-login approval page into a KEY-CONSENT surface that: preserves the
fingerprint fragment across the Clerk bounce, performs a fresh Clerk step-up,
AUTOMATICALLY verifies the server-returned pubkeys hash to the fragment `fp`
(no typing), and on a match + explicit consent calls approve with keyConsent — or
falls back to device-auth-only when there is no fragment (manual navigation).

## Files / areas (verify anchors)

- `apps/web/src/routes/cli-login/+page.ts` — the FRAGMENT-PRESERVATION gap:
  today (~:23-30) it rebuilds the signed-out redirect with only `?code=` and
  DROPS location.hash where `fp` lives. FIX: preserve the fragment across the
  redirect (the loader runs client-side, ssr=false, so it can read
  location.hash). This is the remaining #412 gap.
- `apps/web/src/routes/cli-login/+page.svelte` — the approval card: today
  (~:96-110) it DISCLAIMS key delivery. New behavior when a fragment binding is
  present: after step-up, fetch the server pubkeys (WIRE-189 echo endpoint),
  compute the JCS-hash fingerprint client-side, compare to `fp` automatically,
  and render a KEY-CONSENT approve ("Approve and send this machine your
  encryption keys") that calls approve with keyConsent=true. NO fingerprint
  typed, NO code typed — the compare is automatic; the human action is the tap.
  When NO fragment: keep today's device-auth-only copy and approve WITHOUT
  keyConsent.
- `apps/web/src/lib/api.ts` — approveDeviceAuth (~:264-279): add keyConsent +
  whatever binding the server requires; the fresh Clerk step-up (a real Clerk
  JWT/step-up, not the cached bearer — §5.3) per WIRE-189.
- `apps/web/src/lib/clerk.ts` / auth — wire the step-up (re-verification) call.
- CSP: a ROUTE-SPECIFIC strict policy for the approval route (the global
  apps/web/static/_headers allows unsafe-inline/eval for Clerk; the approval page
  needs its own tighter boundary compatible with Clerk). Text-only rendering, no
  {@html}/innerHTML anywhere on this surface.

## Design intent (taste — the parent will validate visually)

- The approval screen is a SINGLE clear task: what machine, what it means
  ("send this machine your encryption keys" — non-scary, non-developer copy,
  consistent with the v1.8.0 genesis copy tone), one primary Approve action.
- The automatic fingerprint match is INVISIBLE on success (no codes shown); only
  a MISMATCH surfaces a clear "this doesn't match the machine you started on —
  do not approve" warning.
- Manual-navigation (no fragment) path clearly grants sign-in only, not keys.
- Non-developer legibility bar (two less-technical external users).

## Hard constraints

1. Fragment REQUIRED for key delivery; manual navigation = device-auth only
   (never keys). The server enforces this too; the page must not send keyConsent
   without a verified fragment match.
2. Fresh Clerk step-up before key consent; a cached bearer alone is rejected.
3. No typed codes anywhere; the fingerprint compare is automatic.
4. Text-only rendering + route-specific strict CSP + no {@html}.
5. Same-origin only; keep the #412 open-redirect guard (safeInternalPath) intact.

## Acceptance criteria

- `apps/web` `npm run check` (svelte-check) clean.
- New vitest unit tests: fragment preserved across the cli-login redirect; the
  JCS-hash fingerprint compare (match -> keyConsent path; mismatch -> warn, no
  approve; absent fragment -> device-auth-only, no keyConsent); the step-up is
  required before key consent.
- Parent Fable session runs the visual-validation loop on the approval page
  before this unit is accepted.

Do NOT commit; leave the tree dirty for review here.
