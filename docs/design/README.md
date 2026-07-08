# rbox — Design docs index & status

One row per design doc. **Status = implementation status** (is it shipped?), not
design-review status — each doc's own header records its codex-review history.

**Legend:** ✅ DONE (in `main`) · 🟡 IN PROGRESS · 🔴 NOT STARTED (design only)

_Last updated: 2026-07-08._

## Shipped (1–15)

| # | Doc | Milestone | Status | Notes |
|---|-----|-----------|--------|-------|
| 01 | [Daemon + Watcher + Live Push](./01-daemon.md) | M1 | ✅ DONE | continuous daemon + DO sequencer; verified cross-machine |
| 02 | [Git State Sync](./02-git-mirroring.md) | M2 | ✅ DONE | git-native bundle sync; opt-in (`syncGit`, default off) |
| 03 | [Production Blob Path](./03-blob-path.md) | M3 | ✅ DONE | multipart + resume; R2 |
| 03b | [Configurable Ignore Patterns](./03b-ignore.md) | M3b | ✅ DONE | `.rboxignore`/`.gitignore`; forward-only |
| 04 | [Self-Hosted Device Tokens](./04-auth.md) | M4 | ✅ DONE | per-device sha256 tokens; `authenticate()` enforces `revoked=0` |
| 05 | [Encryption + Secrets](./05-encryption.md) | M5 | ✅ DONE | **superseded by 12** (full E2EE); delivered there |
| 06 | [Version History, Trash, GC](./06-versions-gc.md) | M6 | ✅ DONE | reachability GC; plan-gated retention |
| 07 | [Multi-Tenancy & Security](./07-multitenancy.md) | M7 | ✅ DONE | cross-tenant isolation 16/16 |
| 07b | [Billing, Plans & Metering](./07b-billing.md) | M7b | ✅ DONE | core autonomous; Stripe provisioned |
| 07c | [Onboarding TUI](./07c-onboarding-tui.md) | M7c | ✅ DONE | zero-dep terminal UX |
| 08 | [Hydration Brain](./08-hydration.md) | M8 | ✅ DONE | live-verified |
| 09 | [Hardening & Scale](./09-hardening-scale.md) | M9 | ✅ DONE | cold-scan scale fix |
| 10 | [Pairing Tokens](./10-pairing.md) | M10 | ✅ DONE | "connect a new machine" |
| 11 | [Web auth (Clerk) + dashboard](./11-web-auth.md) | M11 | ✅ DONE | Clerk JWT → rbox session; prod live |
| 12 | [Full E2EE (zero-knowledge)](./12-full-e2ee.md) | — | ✅ DONE | merged to `main`; epoch *enforcement* works, *rotation op* unbuilt (see prereqs) |
| 13 | [Billing downgrade grace](./13-billing-grace.md) | — | ✅ DONE | migration 0012 |
| 14 | [CI/CD + signed `rbox upgrade`](./14-cicd-upgrade.md) | — | ✅ DONE | `release.yml`; `v0.1.0` shipped |
| 15 | [Web dashboard (SvelteKit)](./15-web-dashboard.md) | — | ✅ DONE | live at `app.rbox.to` |

## Post-launch batch — designed, not built (16–21)

Codex adversarially-reviewed specs. **Implementation: 🔴 NOT STARTED.**

| # | Doc | Status | Depends on | One-liner |
|---|-----|--------|-----------|-----------|
| 16 | [New-device security emails](./16-new-device-emails.md) | 🟢 BUILT | — | "new device added" email; **Cloudflare Email Service** send on `security.rbox.to` |
| 17 | [Account devices/workspaces list](./17-account-devices-workspaces.md) | 🔴 NOT STARTED | P1, P2 | read-only dashboard list; new `GET /v1/account/devices\|workspaces` |
| 18 | [Support email routing](./18-support-email-routing.md) | ✅ SHIPPED (2026-06-30) | — | `support@`/`postmaster@`/`security@` → Gmail via CF Email Routing; migrated off Namecheap; catch-all Drop |
| 19 | [Device revocation](./19-device-revocation.md) | 🔴 NOT STARTED | P1, P3 | revoke web+CLI; access-revoke works, crypto-revoke needs rotation |
| 20 | [CLI/CI API keys](./20-cli-api-keys.md) | 🔴 NOT STARTED | P1, P3 | headless `RBOX_KEY`; **don't GA before P3** |
| 21 | [Account linking / identity](./21-account-linking.md) · [build plan](./21-account-linking-plan.md) | ✅ SHIPPED (PR #2, prod) | — | web↔CLI link (`rbox account link`) + `rbox subscribe` + re-point saga; closes P2 & P4; unblocks 16/17/19 |
| 86 | [Paid-only plans, trial, annual billing](./86-paid-only-trial.md) | ✅ SHIPPED (2026-07-08, PR #159) | 07b, 13 | remove free tier; locked `none` state; 14-day Stripe trial; annual prices |
| 87 | [Agent sync keys](./87-agent-sync-keys.md) | 🔴 NOT STARTED | 20, P3 | `RBOX_KEY` + keyed `rbox setup --workspace` for ephemeral agent VMs; beta pre-P3, **GA gated on P3** |

## Cross-cutting prerequisites (gate the 16–21 batch)

Surfaced independently across multiple specs — these are the real foundation work:

- **P1 — `device_id` uniqueness. ✅ DONE** (migration `0013`, commit `5ef4ba2`). Resolved as a **global** `UNIQUE(device_id)` — reconciles with the E2EE `device_keys` global PK (stricter than the per-account form first proposed here); ids widened to 128-bit; `mintDevice` retries on collision. _Note: 16/17's "non-unique" body language is now stale._
- **P2 — web↔CLI account link. ✅ DONE** (doc **21**, shipped PR #2). `rbox account link` binds a Clerk identity onto the real CLI-born account; `rbox subscribe` lets the CLI pay directly onto it. CLI-born accounts are now linkable/manageable from the dashboard.
- **P3 — E2EE epoch *rotation operation* isn't built.** Full E2EE is merged and epoch *enforcement* works, but no operation bumps the epoch + re-wraps MK for survivors + signs a new roster (genesis writes epoch 0; `e2ee-remote.ts:146` "v1 has no rotation"). So `revoked=1` blocks *new* access but a leaked credential still decrypts *existing* data.
- **P4 — credential-kind route gating. ✅ DONE** (shipped with doc 21, PR #2). `Principal.kind` is derived from `expires_at`, and a default-deny route policy 403s `kind=='web'` tokens on every durable-credential-mint / crypto / sync route — closing the "an ephemeral web session can mint permanent access" gap.

## What remains undone

Everything in **1–15 is shipped.** Open work, in dependency order:

1. ~~**P1** (unique `device_id`)~~ — ✅ **DONE** (migration `0013`). Apply to prod D1 when ready.
2. ~~**P2 / doc 21** (account linking)~~ — ✅ **DONE** (shipped PR #2, prod): `rbox account link` + `rbox subscribe` + re-point saga.
3. ~~**18** (support email)~~ — ✅ **DONE** (2026-06-30): `support@`/`postmaster@`/`security@` → Gmail via Cloudflare Email Routing.
4. **16 / 17** — buildable now (P1 done); full coverage for CLI-born accounts needs P2.
5. ~~**P4** (credential-kind route gate)~~ — ✅ **DONE** (shipped with doc 21).
6. **P3** (epoch rotation) — then **19** (crypto-revoke) and **20** (API-key GA).
