# Funnel — stranger → paying customer syncing across two devices

Walkthrough of the acquisition funnel as **shipped** (v0.8.0, 2026-07-06), with
friction findings. Verified against the live site (rbox.to), apps/web, and the
CLI — not against docs or intentions. Update this file when a funnel step
changes.

## The golden path (7 steps, 2 context switches)

### 1. Marketing → account (rbox.to)

Visitor lands on rbox.to, reads, hits `#pricing`. The plan CTAs link to
`https://app.rbox.to/?plan=solo` / `?plan=pro`; the hero "Get started" links to
`#install` (the curl command). Free column → `#install` too.

### 2. Sign up (app.rbox.to)

Signed-out root is a Clerk auth card (`apps/web/src/routes/+page.svelte`);
email or OAuth. The layout owns the signed-in redirect → `/dashboard`.

> ⚠️ **The `?plan=` deep link is dead.** Nothing in apps/web reads a `plan`
> query param — Clerk sign-up plus the layout redirect drop it. A buyer who
> clicked "Go Pro" lands on the generic dashboard and must rediscover the
> upgrade cards themselves. See finding F1.

### 3. Pay (dashboard)

Dashboard shows "Upgrade your plan" cards for free users
(`apps/web/src/routes/dashboard/+page.svelte`, `UPGRADES`). Click →
`startCheckout(plan)` → `POST /v1/billing/checkout?plan=` → Stripe Checkout →
`/billing/success` → dashboard shows "Active subscription" + "Manage billing"
(portal). Team is gated server-side (`PURCHASABLE_PLANS` in
`apps/api/src/plans.ts`) and marked "coming soon" in the UI.

Payment order is flexible — the plan is account-wide, so paying before or
after CLI setup both work. Paying first means quota caps are right from the
first push.

### 4. Install on device 1

```bash
curl -fsSL https://rbox.to/install.sh | sh
```

sha256-pinned per release (design 67). Then:

```bash
rbox            # guided menu
```

### 5. First device = genesis

`rbox setup` → "new workspace" path:

1. Device-code login — browser opens app.rbox.to, user approves the code.
2. Enrollment: **"This is my first machine — set up encryption now"** (design
   60 genesis) → the **24-word recovery phrase is shown once**. This is the
   highest-stakes moment in the funnel.
3. Workspace created, `.rbox/workspace.json` written, first push runs.
4. Autostart offer (launchd/systemd login agent, design 61).

### 6. Second device — pairing token is the short path

On device 1: `rbox pair` → prints a one-time `rbox connect …` command; press `c`
to copy it.
On device 2:

```bash
curl -fsSL https://rbox.to/install.sh | sh
rbox connect <pairing-token>
```

The token does **auth + E2EE enrollment in one step** — no browser, no
recovery phrase. Then "Sync an existing workspace" gives a pick-by-name
picker of the account's workspaces (`setup-cmd.ts:286`), so no workspace-id
copying. Fallbacks: device-code login + recovery phrase, or `rbox init
--workspace <id>` for scripted joins.

### 7. Verify sync

`rbox status` on both machines; touch a file on device 1, watch it appear on
device 2. Daemon handles it live if autostart/`rbox start` is on.

**Total:** one curl per machine, one browser approval (or zero with pairing
token on device 2), one Stripe checkout. That's genuinely competitive.

## Friction findings

| # | Severity | Finding |
|---|---|---|
| F1 | **High** | `app.rbox.to/?plan=solo\|pro` deep links from pricing CTAs are ignored by the app. A buyer with checkout intent gets a generic dashboard. Fix: stash `plan` through the Clerk flow (localStorage or Clerk redirect param) and auto-fire `startCheckout(plan)` on first authed load. |
| F2 | Medium | No funnel ordering guidance. Marketing "Get started" → `#install` (CLI-first) while plan CTAs → app (account-first). Both work, but nothing tells the user "install first, pay whenever." A 4-line quickstart on the pricing section or /docs would remove the hesitation. |
| F3 | Medium | The recovery-phrase moment is a one-time display with no dashboard recovery-status indicator. If the user loses it before enrolling device 2 and loses device 1, the account's data is gone (by design — but the funnel never warns them at the point where a second device would save them). Cheap fix: post-genesis nudge "enroll a second device or store this phrase — either one saves you." |
| F4 | Low | Discovering `rbox pair` requires having read setup's copy. The dashboard **Devices** page could show "Add a device" with the two-command recipe, mirroring the CLI. |
| F5 | Low | CLI 402/quota errors (design 62) report usage and caps but the upgrade pointer to app.rbox.to/dashboard only appears in `rbox usage`. Consider appending the URL to the 402 message itself. |

## Marketing-site audit (rbox.to, live, 2026-07-06)

Is the funnel/setup/pairing flow on the marketing site? **Partially.** What
exists:

- Homepage `#install` ("Getting started"): account-first copy ("Create your
  account at app.rbox.to… then install"), the curl command, and one sentence
  claiming "Adding another machine later is just this one command again — no
  browser required."
- `/docs`: install → `rbox setup` narrative, everyday commands, ignore rules,
  git-state sync, and a **Devices & account** command list (`rbox pair`,
  `rbox connect <pairing-token>`, `rbox recover`, `rbox device list/revoke`).

Gaps, in order of stuck-state severity:

| # | Severity | Gap |
|---|---|---|
| M1 | **High** | **The recovery phrase does not exist on the marketing site.** Nothing warns the user that setup will show a 24-word phrase once, that it must be saved, or that phrase + all devices lost = data unrecoverable (by design). The user meets the highest-stakes moment of the product with zero forewarning, and the site never says "a second device is also a recovery path." |
| M2 | High | **No second-machine walkthrough.** The homepage hand-waves it ("just this one command again" — actually install + `rbox pair` on machine 1 + paste token), and /docs lists pair/connect as bare commands with no narrative. A 3-step "Add your second machine" section is missing from both. |
| M3 | Medium | **Contradictory entry ordering.** Homepage says account-first ("Create your account… then install"); the smoothest real flow is CLI-first (device-code login creates the account). Pricing CTAs push app-first, hero pushes install-first. Pick one canonical order and say it everywhere. |
| M4 | Medium | **No stuck-state guidance anywhere**: lost/expired pairing token (answer: mint a new one, they're one-shot), lost recovery phrase while devices still enrolled (answer: pair a new device now, phrase is only needed at zero devices), abandoned checkout, `rbox device revoke` consequences. |
| M5 | Low | Plans/quotas aren't connected to the CLI on the site — nothing says what hitting a cap looks like (`rbox usage`, 402 with cap details) or that upgrading is at app.rbox.to/dashboard. |

## Recommended canonical order (for docs/marketing copy)

1. `curl -fsSL https://rbox.to/install.sh | sh`
2. `rbox` → new workspace → save the phrase
3. Create account in the browser when the device code opens it (one step, not
   a separate "sign up first")
4. Upgrade at app.rbox.to when you hit a cap — or immediately via the pricing
   CTA once F1 is fixed
5. `rbox pair` → second machine: install, paste token, pick workspace

CLI-first ordering wins because the device-code login *creates* the account as
a side effect — "sign up on the website first" is a redundant instruction.
