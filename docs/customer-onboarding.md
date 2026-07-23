# Customer onboarding — end-to-end test script

Manual walkthrough of the full funnel as a real customer would hit it:
stranger → install on machine 1 → sync → install on machine 2 → sync → pay.
Run it against **prod** (rbox.to / app.rbox.to / the released CLI), not a dev
stack — the point is to experience exactly what a paying stranger does.
Companion doc: [funnel.md](funnel.md) — grade reality against it as you go;
anything that surprises you is either a doc fix or the next PR.

## Act 0 — Prep (5 min)

1. **Stripe promo code** (prod Stripe is live-mode): Dashboard → Product
   catalog → Coupons → create **100% off, duration "forever"** → add a
   promotion code like `RBOXTEST`. Checkout already sends
   `allow_promotion_codes: true`, so the test purchase is $0 — Stripe still
   collects a card, it just never charges it.
2. **Fresh identity**: open an **incognito window** (clean sessionStorage
   matters for the pricing deep-link test) and use an email alias like
   `you+funnel1@gmail.com` — Clerk treats it as a brand-new user.
3. **Two machines.** A real second machine gives the honest experience. To
   simulate on one box, run machine-2 commands in a terminal with
   `HOME=$HOME/funnel-m2` exported (the CI-rig pattern) — but **don't enable
   autostart there**; launchd plists in a fake HOME are just litter.
4. Optional API-side visibility, in a spare terminal:
   `cd apps/api && npx wrangler tail rbox-prod-api --env production`.

## Act 1 — Stranger → first machine syncing

1. Visit **rbox.to** in the incognito window. Read it cold — every
   "wait, what?" is a live data point for funnel.md's M1–M5.
2. Make a realistic guinea-pig project on machine 1:

   ```bash
   mkdir ~/funnel-test && cd ~/funnel-test && git init
   echo "console.log('hi')" > index.js
   mkdir node_modules && echo junk > node_modules/junk.js
   echo "SECRET=dont-sync-me" > .env
   echo wip > notes.md
   git add index.js        # a dirty index gives git-state sync something to carry
   ```

3. Install: `curl -fsSL https://rbox.to/install.sh | sh` — expect sha256
   verification and a version print.
4. Run `rbox` → guided menu → **new workspace** → point it at
   `~/funnel-test`.
5. Device-code login: it opens app.rbox.to — **sign UP with the alias
   here**. Checkpoint: this is where the account gets created; the site told
   you to sign up first, and you're proving it didn't need to.
6. Genesis: choose **"This is my first machine — set up encryption now"** →
   the 24-word recovery phrase appears **once**. Save it in a password
   manager. Grade this moment harshly — it's the scariest screen a new user
   sees, and the marketing site never warned them it was coming (M1).
7. Say yes to autostart.

**Checkpoints:** `rbox status` clean/synced · dashboard → Devices shows the
machine · `rbox logs` shows the first push.

## Act 2 — Second machine

1. Install with the same curl one-liner.
2. Machine 1: `rbox pair` → press `c` to copy the complete command (10-min TTL,
   single use — if it expires, just mint another).
3. Machine 2: paste and run `rbox connect <pairing-token>`.
   Checkpoint: **no browser, no phrase** — the token is auth + key material
   in one paste.
4. Choose **sync an existing workspace** → pick it by name → give it a
   directory → pull.

**Checkpoints on machine 2:**

- `index.js` and `notes.md` are there; **`node_modules/` and `.env` are
  not** (ignore defaults + secret exclusion).
- `git status` shows the same dirty index as machine 1 (git-state sync).
- Live loop: `echo change >> notes.md` on machine 2 → appears on machine 1
  within seconds, and vice versa.

## Act 3 — Pay (tests the `?plan=` pricing-CTA handoff, PR #87)

1. In the incognito window (still signed in): **rbox.to → Pricing → "Go
   Pro"**.
2. Expected, with zero further clicks: app.rbox.to flashes, `?plan=pro`
   disappears from the URL, the dashboard appears briefly with a busy state,
   then you're **on Stripe Checkout**. Landing on a plain dashboard instead
   means the handoff regressed.
3. **Cancel-path check first** (30 seconds): hit Back/close from Stripe →
   you should land on the dashboard with **no second auto-redirect**, and
   the manual upgrade cards still work. To re-test the auto path, click "Go
   Pro" on rbox.to again — that's the designed re-entry.
4. Pay: "Add promotion code" → `RBOXTEST` → total $0.00 → enter a card →
   subscribe.
5. Expected: `/billing/success` → dashboard shows **Active subscription ·
   Pro** with "Manage billing".
6. CLI: `rbox usage` on either machine → plan `pro`, caps raised.
7. **Optional, highest-value variant** (second alias, fresh incognito):
   click "Go Pro" as a *total stranger*, sign up mid-flow, and confirm
   checkout auto-fires right after sign-up. That's the cold-buyer leg —
   mock-verified but not yet human-tested on prod.

## Act 4 — Teardown

1. Dashboard → Manage billing → cancel the subscription.
2. Both machines: `rbox untrack ~/funnel-test`, then `rbox uninstall`.
3. Dashboard → Settings → Danger zone → **delete account** (owner-only,
   irreversible — purges the remote data).
4. `rm -rf ~/funnel-test` (and `~/funnel-m2` if you simulated machine 2).
