# 63 — Trust surface: /security explainer, www 525 fix, team "coming soon" consistency

**Status:** draft — design only (no code in this doc; it specifies three small,
independent launch-blockers).
**Depends on:** design 12 (full E2EE, shipped engine + server), design 58 (recovery
kit, implementing). Marketing site is `/tmp/rbox-home` (Astro static → Cloudflare
Pages, `rbox.to`); billing surfaces are `apps/api` + `apps/web` + the `rbox` CLI.
**Origin:** launch readiness. We sell an E2EE product with no page that explains the
E2EE; `www.rbox.to` is dead (HTTP 525); and the Team plan is presented four
different ways across four surfaces, one of which is a live-fire server path.

These three items share one theme — the **trust surface** a prospective user
touches before they type `rbox setup`: what we claim, whether the front door
resolves, and whether our pricing tells the same story everywhere. They're
bundled because each is a self-contained afternoon and none is worth its own doc.

---

## Item A — `/security` E2EE explainer page

### A.1 Problem

rbox's entire differentiation is "our servers never see your code," and the only
place that's spelled out is the privacy policy (`privacy.astro`) — a legal document
nobody reads before signing up. The homepage feature card ("End-to-end encrypted,"
`index.astro:26-30`) makes the claim in two sentences and links nowhere. For a
zero-knowledge product that is a marketing failure: the security story IS the
product, and a skeptical developer (our exact buyer) has nowhere to verify it.

The trap on the other side is **security theater** — a `/security` page that
overclaims ("military-grade," "we can't see anything") is worse than none, because
one honest reader with `grep` destroys our credibility. Design 12 §0/R4 already did
the hard work of stating the threat model honestly; the page must inherit that
honesty, not launder it.

### A.2 Decision

Ship a static `/security` page on rbox-home that explains the E2EE model in plain
words, backed by a **key-claims list** whose every line is true against the shipped
design 12 model — including three mandatory caveats. Honesty is the differentiator;
the page's credibility comes from volunteering the limits, not hiding them. Link it
from the footer and from the homepage E2EE feature card.

This doc specifies the **outline + claims list**, not final copy (copy is a
follow-up, written to match rbox-home's existing voice — confident, concrete,
developer-to-developer, no adjectives it can't back up; see `index.astro` hero and
`privacy.astro`'s "The short version: we cannot read your files").

### A.3 Mechanism — page outline

New `src/pages/security.astro` using the same `LegalLayout` (or a lighter marketing
layout) as privacy. Sections, top to bottom:

1. **Lede — "How we can't read your code."** One paragraph restating the homepage
   claim and promising the page proves it rather than asserting it.
2. **What the server sees vs. can't see** (two columns / two lists, the core
   artifact). Source of truth: design 12 §0 + R4.
   - *Can't see:* file contents, names, paths, directory tree, modes, mtimes,
     symlink targets, git refs/branch names/commit messages, the manifest itself.
   - *Can see (honest residual):* that an account/workspace exists; per-commit blob
     **count**; **each blob's size** — ciphertext length is plaintext length plus a
     small constant (GCM tag), so per-file sizes are effectively visible, just not
     which *file* a size belongs to (codex review 2026-07-03: do NOT list "per-file
     sizes" under can't-see — the earlier draft did, contradicting its own caveat 3);
     **commit timing/cadence**; which pseudonymous **device id** committed; total
     stored bytes (billing needs it); account **email** (via Clerk); Stripe customer
     reference + plan.
3. **How it works — the key hierarchy in plain words.** No wire formats. Design 12
   §1:
   - A random **master key (MK)** is generated on your first device and never sent
     to us.
   - MK wraps a **per-workspace key (KEK)**; a device with MK can open all its
     workspace keys.
   - Files are encrypted with **per-file keys** (AES-256-GCM) derived from the KEK.
   - **Keys never leave your devices.** We store only wrapped (encrypted) copies we
     can't open. **There is no escrow** — no master password, no backdoor, no
     "reset" we can perform.
4. **Recovery — the 24-word phrase.** Design 58 semantics: a recovery phrase
   generated on-device at setup, shown once, saved as a recovery-kit file. It is
   the only way back in if every device is lost — and because we never see it,
   losing it *and* all devices means the data is gone. State this as a deliberate
   property, matching `privacy.astro:49-55`.
5. **The honest caveats** (MANDATORY — the section that earns trust):
   - **(1) Convergent-encryption equality leak.** Identical files encrypt to
     identical ciphertext *within one workspace* (this is what enables dedup). So
     the server can tell that two blobs are byte-for-byte identical — an "is this
     exact file present" oracle — without learning what either contains. Design 12
     §0/R4/V4-5 documents this as an accepted tradeoff; the page states it plainly.
     Cross-workspace/cross-account correlation is **not** possible (per-workspace
     KEK). Padding/size-bucketing is named as future hardening, not claimed now.
   - **(2) Device revoke ≠ key rotation (yet).** Revoking a device kills its access
     token immediately (it 401s on the next call) but does **not** cryptographically
     evict the MK/KEKs it already cached — epoch rotation on revoke is designed but
     unbuilt (`apps/api/src/auth/devices.ts:14-18`, design 22 §1.3/§4.2). The page
     must not imply revoke retroactively locks out a compromised device from data
     it already holds. Say what revoke does ("stops that device from syncing new
     changes") and what it doesn't yet ("re-encrypt existing data under a new key").
   - **(3) Metadata we do see.** A compact restatement of the "can see" list from
     §2 — file counts, ciphertext sizes, sync timing, device ids, and your account
     email — so the caveat isn't buried in a two-column diagram.
6. **What this means for you / threat model in one line.** A compromised or compelled
   rbox server can deny service, withhold or reorder commits, or serve stale
   ciphertext — but it **cannot decrypt your files or forge a commit your client
   will accept** (design 12 §0 trust model). Close by linking the privacy policy for
   the legal treatment.

**Linking (both required):**
- Footer nav (`index.astro:311-317`): add `<a href="/security/">Security</a>`
  alongside Privacy/Terms.
- E2EE feature card (`index.astro:26-30`): make the card body link to `/security/`
  ("→ How our encryption works"), turning the unclickable claim into the entry
  point.

### A.4 Key-claims list (the copy-review checklist)

Every claim below must survive a `grep` of everything a faithful server stores
(design 12 §11 proves this holds today). The copy writer treats this as the
contract; anything not on it doesn't go on the page.

| Claim | True because |
|---|---|
| Files encrypted on-device before upload | design 12 §0, blob + manifest E2EE |
| Server stores only ciphertext + minimal envelope | §4/§5, opaque manifest |
| Keys (MK/KEK) never sent to server in cleartext | §1 |
| No escrow / no backdoor / no master password | §8, R6; privacy.astro:49-55 |
| Recovery = 24-word phrase, shown once, we never see it | §8, design 58 |
| Lost phrase + all devices ⇒ unrecoverable (by design) | §8 |
| Server *can* see blob counts, per-blob sizes (≈ exact plaintext sizes, unlinked from names), timing, device ids | R4 (caveat 3) |
| Identical files → identical ciphertext within a workspace | R4/V4-5 (caveat 1) |
| Device revoke stops access but doesn't yet rotate keys | devices.ts:14-18 (caveat 2) |
| Account email visible via Clerk; card data only at Stripe | privacy.astro:58-92 |
| Compromised server can't decrypt or forge accepted state | §0 trust model |

---

## Item B — `www.rbox.to` returns HTTP 525

### B.1 Problem

`www.rbox.to` returns **HTTP 525 (SSL handshake failed)** today. A `www` DNS record
is proxied through Cloudflare (orange-cloud) on the `rbox.to` zone, but `www` is not
a configured custom domain on the Pages project, so Cloudflare's edge has no origin
cert to complete the TLS handshake for that hostname → 525. Anyone who types
`www.rbox.to` (browsers still autocomplete it, links still carry it) hits a raw SSL
error — the worst possible first impression for a security product.

### B.2 Decision

Redirect `www` → apex with a **zone-level Redirect Rule** (301/308,
`www.rbox.to/*` → `https://rbox.to/$1`). One canonical host, no duplicate content,
no second cert to babysit. Rejected alternative: adding `www` as a second Pages
custom domain — it works but serves the identical site on two hostnames, which
splits SEO signal and forces canonical-tag maintenance for zero user benefit. The
apex is already canonical everywhere (`astro.config.mjs` `site: "https://rbox.to"`,
`trailingSlash: "always"`); the redirect keeps it that way.

Note: this can't be fixed inside rbox-home's `public/_redirects` — that file only
matches **paths** on a host Pages already serves, and `www` never reaches the Pages
project (that's the bug). It's a **zone** fix, so rbox-home stays untouched.

### B.3 Mechanism — exact Cloudflare steps

Preferred path — **Redirect Rule** (dashboard: Rules → Redirect Rules → Create):
- Name: `www → apex`.
- When incoming requests match: **Hostname equals `www.rbox.to`**.
- Then: **Dynamic redirect**, Type 301 (permanent), expression
  `concat("https://rbox.to", http.request.uri.path)`, **Preserve query string** on.
- Deploy. Verify: `curl -sI https://www.rbox.to/` → `301` with
  `location: https://rbox.to/`, and the apex still 200s.
- Prerequisite: a proxied `www` DNS record must exist (CNAME `www` → `rbox.to`,
  orange-cloud) so the edge terminates TLS for `www` before the rule runs. If the
  525 is instead from a *missing* `www` record, add that CNAME first; the Universal
  SSL cert for the zone already covers `www`.

**State as of 2026-07-03 (partially applied):** the root cause was a proxied CNAME
`www → parkingpage.namecheap.com` (registrar leftover) — Cloudflare couldn't TLS to
Namecheap's parking origin, hence 525. The CNAME has been repointed to `rbox.to`
(proxied) via the API (`CLOUDFLARE_API_TOKEN` has DNS edit). `www` now returns
**522** — expected, because the token lacks Zone → Rules and Pages scope, so the
redirect rule could not be created. **Remaining step (founder, ~60s, dashboard):**
create the Redirect Rule above (Rules → Redirect Rules), or alternatively add `www`
as a Pages custom domain (rejected option, §B.2). Verify with the curl checks below.

---

## Item C — Team plan "coming soon" consistency

### C.1 Problem — current state (verified)

The Team plan is presented four ways across four surfaces, and one of them is a
live server path:

- **rbox-home pricing** (`index.astro:82-95`, 246-263): Team card is **visible**,
  priced `$12 / user / mo`, carries a `comingSoon: true` flag → renders a "Coming
  soon" badge and a **disabled, non-clickable** button (`btn-disabled`,
  `aria-disabled`). This surface is already correct.
- **Web dashboard** (`apps/web/src/routes/dashboard/+page.svelte`): the upgrade grid
  (`UPGRADES`) offers **only** solo/pro checkout buttons; Team appears solely as a
  footnote — *"Need a team? Team plans with roles & per-seat billing are coming
  soon."* (`:276-278`). `checkout()` is typed `'solo' | 'pro'` (`:63`). Correct.
- **CLI** (`src/cli/subscribe-cmd.ts:15`): `const PLANS = ["solo", "pro"]` — `rbox
  subscribe team` is rejected client-side with "unknown plan." Correct.
- **API plan tables** (`apps/api/src/plans.ts`): `team` exists in `PLANS` (limits),
  `PLAN_MONTHLY_CENTS`, and — critically — **`PLAN_LOOKUP_KEYS.team =
  "rbox_team_seat_monthly"` (`:59`)**.

**Is team checkout reachable server-side? YES.** `billingCheckout`
(`apps/api/src/stripe.ts:60-101`) reads `plan` from the query and gates only on
`if (!PLAN_LOOKUP_KEYS[plan])` (`:63`). Because `PLAN_LOOKUP_KEYS` contains `team`,
a raw `POST /v1/billing/checkout?plan=team` **passes the guard**. It then calls
`priceIdForPlan(env, "team")`; today that returns null (no active Stripe price for
`rbox_team_seat_monthly`) → `500 price_unavailable`. So it fails *by accident of
missing Stripe config*, not by intent. The day someone creates that price (e.g.
prepping the real Team launch), a hand-crafted request — or a curious user hitting
the API directly, bypassing the CLI/web allowlists — would mint a real team
subscription with `quantity: 1`, i.e. an unpriced, half-built product. The two
clients' allowlists are a coincidence, not a guarantee.

### C.2 Decision

Team **stays visible everywhere as "coming soon"** — it's a real roadmap item and a
useful demand signal, so we don't hide it. But *purchasable* and *advertised* are
separated: no surface offers a working Team checkout, and the **server rejects Team
checkout intent explicitly** rather than relying on a missing Stripe price. The
guard lives at the choke point (`billingCheckout`), so it holds regardless of which
client (or non-client) calls it.

### C.3 Mechanism

1. **Server guard (the load-bearing change).** In `billingCheckout`, gate on a
   dedicated *purchasable* allowlist, not on `PLAN_LOOKUP_KEYS` membership. Simplest
   form: a `const PURCHASABLE_PLANS = new Set(["solo", "pro"])` in `plans.ts`
   (single source of truth), and change the `:63` check to reject any plan not in
   it — returning the existing `400 { error: "bad_request", message: "unknown or
   non-purchasable plan" }`. Team then 400s deliberately ("not yet available"),
   before any Stripe call, even after a `rbox_team_seat_monthly` price exists. Keep
   `team` in `PLANS`/`PLAN_MONTHLY_CENTS`/`PLAN_LOOKUP_KEYS` so limits, the admin
   MRR estimate, and the future webhook→plan mapping (`planForLookupKey`) all keep
   working the moment Team ships — flipping the launch is then a one-line add to
   `PURCHASABLE_PLANS`, not a scramble.
2. **rbox-home:** already correct (§C.1). No change beyond confirming the copy
   matches the dashboard footnote ("roles & per-seat billing, coming soon").
3. **Web dashboard:** already correct. No change.
4. **CLI:** already correct. Optionally, when `rbox subscribe team` is typed, print
   "Team plans are coming soon — solo and pro are available today" instead of the
   generic "unknown plan," so the CLI message matches the other surfaces' framing.
   Cosmetic, not required.

The net: Team reads identically ("coming soon, per-seat, roles & audit log") on
every surface a human sees, and the one surface a script can reach now says no on
purpose.

---

## Security & privacy

- **Item A is the security-sensitive one.** The risk is *overclaiming*, and the
  mitigation is the mandatory caveats (§A.3.5) + the claims-list contract (§A.4):
  no line ships that a `grep` of stored data could falsify. The page reduces risk
  by making the true model legible instead of leaving users to assume more or less
  than we deliver. No new attack surface — it's a static page.
- **Item C** closes a small integrity gap: an unpriced product path that was
  guarded only by two clients' allowlists and a missing Stripe price. The guard
  moves the "no" to the server, before any Stripe interaction, eliminating the
  window where creating a price silently opens a checkout. No PII or auth change.
- **Item B** removes a raw TLS error on a hostname that carries the brand; a 301 to
  the canonical host leaks nothing and touches no user data.

## Test plan

- **A (page):** it's static — the test is editorial. A reviewer walks the §A.4
  claims list against design 12 (§0/R4/§11) and `devices.ts:14-18`; any claim not
  provable is cut or softened. Confirm both links resolve (footer + feature card →
  `/security/`) and the page renders in the site's dark theme. No automated test
  warranted for static marketing copy.
- **B (www):** `curl -sI https://www.rbox.to/` returns `301` → `location:
  https://rbox.to/`; `curl -sI https://www.rbox.to/privacy/` preserves the path;
  apex still `200`s; no `525` on either host. Re-check after DNS/rule propagation.
- **C (guard) — the one worth a real test:** a unit/integration test on
  `billingCheckout` asserting `POST /v1/billing/checkout?plan=team` → `400`
  (`non-purchasable`) **even with `STRIPE_SECRET` set and a `rbox_team_seat_monthly`
  price present** (i.e. the guard, not the missing price, is what rejects). Regression
  test that `solo`/`pro` still reach a Stripe session. Confirm CLI (`subscribe team`)
  and web (no Team button) unchanged.

## Out of scope

- **Key rotation on device revoke** (design 22 §1.3/§4.2, caveat 2's underlying fix)
  — the `/security` page *documents* the current ceiling honestly; it does not build
  the rotation. That remains its own milestone.
- **Metadata-hardening** (size bucketing, padding, cover traffic — design 12 R4
  future work). The page names it as "future," makes no present claim.
- **Actually launching the Team plan** — pricing finalization, per-seat quantity
  wiring, roles/permissions, audit log, the `rbox_team_seat_monthly` Stripe price.
  This doc only makes "coming soon" *consistent and safe*; it does not ship Team.
- **A second canonical host / www-served content** (the rejected Pages-custom-domain
  alternative in §B.2).
- **Final marketing copy for `/security`** — this doc specifies outline + claims;
  the prose is a follow-up against the checklist.
