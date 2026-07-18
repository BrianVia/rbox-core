# 158 — E2E validation loop: dev CLI builds + disposable accounts

Status: DRAFT — documented for later; founder-parked ("we'll do that soon but
not atm", 2026-07-18). Nothing here is dispatched.

## Problem

Validating onboarding/CLI changes today requires either (a) a full CLI release
(tag → sign → publish → fleet install) or (b) a manual from-scratch signup by
a human with a fresh email. The 2026-07-18 validation round
(`docs/validation-2026-07-18-new-user-flow.md`) burned real founder time and
real email addresses, and each iteration on the findings faces the same cost
to re-verify. The rig (`scripts/ux/regress.ts`) covers TUI flows per-PR but
runs against harness-local state — it validates screens and copy, not the real
API/auth/billing path.

## What already exists (build on, don't rebuild)

- **Local binary compile, no release:**
  `bun scripts/release.ts <ver> --targets=linux-x64,darwin-arm64 --no-upload`
  produces the same standalone binaries as the release workflow, from any
  checkout. No tag/signing/R2.
- **Dev backend switch:** `RBOX_API=https://rbox-dev-api.brian-via.workers.dev`
  (src/cli/api-base.ts) routes the whole CLI at dev D1 + dev Clerk
  (`cosmic-phoenix-51`), with a visible ⚠ override banner.
- **Rig/regress:** containerized TUI flows (fresh-setup, pairing-second-device,
  front-door…), already the per-PR gate.
- **Account teardown:** `DELETE /v1/account` owner cascade (tombstone → cron
  purge of Clerk/DO/R2/rows). Proven on real accounts 2026-07-18.
- **Fleet access:** tailscale SSH to the three hosts (memory:
  fleet-ssh-access) for staging dev binaries.

## Gap

Automated **account creation**. Signup is browser-Clerk only, so every truly
fresh-account run needs a human and a new email. Dev Clerk's backend API (we
hold the dev secret) can mint users/sessions programmatically; the device-code
approve endpoint can then be driven with that session token instead of a
browser click.

## To build (in order)

### U1 — `scripts/e2e/mint-account.ts` (S)
Disposable dev account minting + teardown:
- `mint`: Clerk backend API → create user (`e2e+<nonce>@rbox.to`-style) →
  session token → hit the dev API bootstrap path a real first login takes →
  print `{accountId, email, sessionToken}`.
- `burn <accountId>`: drive the existing `DELETE /v1/account` cascade.
- Guards: refuses to run against prod (`RBOX_API` must be the dev worker;
  refuse if unset or prod). Never touches prod Clerk. DEV-secret only.
- Acceptance: mint → CLI `rbox setup` (pairing-token path or device-code
  approved via the session token) completes against dev → burn → rows gone.

### U2 — dev-backed rig scenario chain (M)
A rig scenario (nightly / on-demand, NOT per-PR — needs secrets + network):
mint account → machine A container: `RBOX_API=dev rbox setup` fresh-account
path → machine B container: pair via the post-setup "set up another machine"
flow (validation #19) → sync a file A→B → assert content + daemon state →
burn account. This is true e2e for the CLI onboarding + pairing surface.
- Reuses U1 and the existing container harness; the only new logic is the
  scenario script and secret plumbing (local `~/.secret_env_vars` first; CI
  wiring is a later decision, likely a scheduled workflow with dev-only
  secrets).

### U3 — fleet dev-build staging helper (S)
Script the loop we'll otherwise hand-run per batch: build linux-x64 +
darwin-arm64 from a named ref → scp to the three hosts as `rbox-dev` (NOT
replacing `~/.rbox/bin/rbox`, NOT wired into autostart) → print per-host
one-liner (`RBOX_API=… ./rbox-dev setup`). Founder validates by hand with the
short loop; releases stay explicit and rare.

### Non-goals
- No Playwright/web-signup automation (dashboard churn doesn't justify it yet
  — revisit if web onboarding regresses again).
- No new server/service. Dev stack + Clerk/Stripe test APIs suffice.
- No per-PR CI job hitting the dev API (secret exposure + flake surface;
  nightly/on-demand only).
- Renewal-email testing (validation #22) stays tabled with its feature.

## Open decisions (resolve at implementation time)
- Whether U1 bootstraps via the same HTTP surface a browser login uses or via
  a dev-only admin endpoint (prefer the former — it validates the real path).
- Email domain/naming for disposable users, and whether dev Clerk needs an
  allowlist entry for it.
- Where U2 runs long-term (local nightly cron on this host vs. GitHub
  scheduled workflow).
