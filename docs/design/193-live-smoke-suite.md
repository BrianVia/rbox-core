# 193 — Live smoke suite (pre-promotion gate)

Status: DRAFT stub (2026-07-23). Opened after the 189 web-pairing validation
proved that unit tests with faked boundaries miss real wire/deploy/timing drift.

## Problem

Unit tests mock the boundaries (Clerk, D1 clocks, the daemon, the browser), so
they pass while the *deployed* system is broken. 189 shipped a client-skew login
bug (caught only by the compiled-binary regress) and a delivery-expiry clamp bug
that made web-approved enroll fail **every time** — the unit tests queued at Δ=0
and landed exactly on the boundary, and the manual two-machine test never got far
enough to hit it. We only learned the truth by running the whole stack, headless,
against the deployed dev API. That capability should be permanent, not a one-off.

## Goal

A small suite of **critical-journey** scenarios that run headless against the
**deployed dev** surfaces (API + dashboard) and prove the real thing works, wired
as an automated **pre-promotion gate** so `git push origin main:production` only
happens after the live dev smoke is green. This turns the design-169 "verify on a
dev build before prod" rule from a manual ceremony into a hard gate.

## Scenarios (the first three already exist as building blocks)

1. **web-pairing (CLI/wire)** — `scripts/rig/scenarios/web-pairing.ts` (design
   192). Two containers, dev-gated `approve-dev` hook, asserts 189 enroll + byte
   -identical convergence. Fast wire/crypto coverage.
2. **browser gates** — `apps/web/tests/e2e/cli-login.spec.ts` (branch
   189-browser-e2e). Playwright + `@clerk/testing`: Turnstile-under-CSP + `#fp`
   survival against the deployed dev dashboard.
3. **real web-approve (composed)** — rig containers + a *real* Clerk-authed
   browser approve against `POST /device/approve` (no bypass). The highest
   -fidelity proof; branch 189-e2e-full. This is the one that answers "does the
   actual pairing flow work."

Future: onboarding/genesis first-run, plan-gating, encryption reset (design 169),
sync convergence under churn.

## The enabling primitive — CI-safe account provisioning

Every scenario needs a fresh account (+ plan, + sometimes an enrolled admin).
Raw `wrangler d1` writes need interactive approval and an account-privileged
token — **not** runnable in a scheduled/CI context. So provisioning must be a
**dev-only seed endpoint on the worker** (`provisionAccount({plan, ...})`, gated
prod-impossible exactly like `approve-dev`: `RBOX_ENV==="dev"` + operator secret),
called by each scenario and torn down after (`DELETE /v1/account`). Self-contained,
no special creds, no human. (Founder offered a D1 INSERT/UPDATE mid-run; fold that
into the endpoint rather than a privileged shell write.)

## Where it runs

- **Post-merge on `main`** — Workers Builds already deploys dev on every merge;
  run the suite after, so drift surfaces immediately.
- **Pre-promotion gate** — required-green before promoting `main`→`production`.
- **Later: cron** — synthetic monitoring, so we learn of breakage before a user.

## Open questions

- Runner shape: extend `scripts/rig/rig.ts` to own browser scenarios too, or a
  thin top-level `smoke` runner that invokes rig + Playwright.
- CI wiring: these need Docker + dev secrets + a browser; likely a dedicated
  workflow (not the per-PR shards), gated to `main` / promotion, with the
  dev-only seed endpoint removing the privileged-token dependency.
- Anti-rot: harnesses not in CI rot (regress-gate lesson). The gate wiring is
  what keeps these honest.

## Non-goals

Not replacing unit tests; not a load/perf suite; not prod-mutating (dev only,
self-provisioned + torn down).
