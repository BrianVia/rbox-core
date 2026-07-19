# Manual validation — new signup / new-user flow (2026-07-18)

Founder-driven from-scratch validation on v1.7.3 (fleet wiped, fresh account).
Running list of issues found. Severity: P0 blocker / P1 should-fix / P2 polish.

## Web UI / dashboard — https://app.rbox.to/dashboard (apps/web + apps/api, PROD)

### 1. "api keys failed (403)" on first web login — P1
On first account creation + web-UI login from the home page, the dashboard shows
**"api keys failed (403)"**.
- (a) **Fix the 403** — the API-keys fetch shouldn't error for a brand-new
  account. Root-cause the endpoint (likely `apps/api` api-keys route) + the
  dashboard call.
- (b) **Don't show the API-keys section at all until telemetry says the user has
  enrolled a device.** Progressive disclosure — a new user with no device has no
  reason to see (or fail on) API keys.

### 2. New-account dashboard shows "no plan / no active plan" with no path forward — P1
The app overview/dashboard says "no plan" / "no active plan". Needs one of:
- A **prominent CTA** ("Start your 14-day trial") right below the plan line, OR
- **Hide the rest of the UI** (Agents & CI-keys sections) so "Start your 14-day
  trial" sits high, right below the plan.
- Until they have a plan, **don't show** 0/1 workspaces, "0d version history", or
  storage-used — there's nothing to show yet, and it reads as an empty/broken app.
Goal: a new user's first screen is "start your trial", not a wall of zeroes.

## SlackPipe internal notifications (apps/api/slackpipes.ts) — IN PROGRESS (subagent)

### 20. Drop account IDs; subscription line → email + coupon — P1
- Onboard msg (`:seedling: New rbox account onboarded — acct_… (web,prod) — email…`):
  remove the `acct_…` ID (keep email/signin/plan).
- Subscription msg (`:moneybag: New subscription — pro on account acct_… (prod)`):
  replace account ID with the customer **email** + whether a **coupon/promo** was
  used (`coupon: <code|none>`).

---
### 21. Dashboard active-subscription price ignores annual cadence — P1
Founder checked out ANNUAL but the active-subscription summary shows "Pro /
Active subscription / **$20/mo**" (the hardcoded monthly price, `PLAN` map
line 90 + `{info.price}` line 154). `usage` payload has NO interval/cadence
field (Usage: plan, usedBytes, storageCap, workspaces, workspaceCap,
retentionDays). Fix needs: (a) apps/api `/v1/account/usage` to expose the
subscription interval (monthly/annual), (b) dashboard to show the matching
price ("$16.67/mo · billed annually" or "$200/yr"). Cross-cutting.

### 22. FUTURE — renewal-reminder transactional email — P2 (backlog)
For annual plans, schedule a send / cron that watches for upcoming renewals
**30 days in advance** and sends a transactional email ("Your rbox account is
set to renew in 30 days"). MUST check the customer's actual Stripe status first
— e.g. founder used a promo for 5 years free, so there's no imminent charge;
don't send a renewal notice to someone whose next real charge is years out or
who's mid-trial/comped. Gate on the true next-invoice date from Stripe.

## Status (as of 2026-07-18 evening)
- **SHIPPED to prod:** #1 (403 fix + API-keys gating, PR #323), #2 (no-plan progressive disclosure, #323), #20 (SlackPipe copy, #323), #21 (annual price incl. $200/year total, #324+#325; pre-migration subscribers need a one-time billing_interval backfill), #23 (getting-started auto-expand — was already the behavior).
- **FIXED separately:** gc-phase1 cursor-test flake (batched seeding, PR pending); app.rbox.to deploy path moved to Cloudflare Pages git build (root apps/web, output build) after wrangler-upload cache dropped assets.
- **NEW (this session):** #24 CSP blocks the data:-URI font — add `font-src 'self' data:`; also consider allowing the CF insights beacon or removing it.
- Everything else below — captured, awaiting one-at-a-time iteration.

## Stripe checkout page

### 3. "90-day history" line ambiguous / possibly wrong — P1 (copy correctness)
Checkout shows: `14 days free / Then $200.00 per year starting August 1, 2026 /
rbox Pro / 250GB, 90-day history, advanced hydration / $200.00 / year after`.
The **"90-day history"** claim — align it with the real product value or REMOVE
the line so it's unambiguous. Decide the actual retention and make copy match.

### 4. Checkout shows primary email, not the signed-in secondary — P2 (note only)
Stripe checkout link showed `brian.a.via@gmail.com` (primary) rather than the
secondary `brian.s.via@gmail.com` he signed in with. Founder: "that's fine, just
a note for later." Investigate whether checkout should reflect the account's
actual sign-in email.

## CLI — "log into an existing account" → authorize-machine

### 5. Reorder the "authorize this machine" options — P1
Current order is off. Desired:
  1. sign in via browser
  2. paste a pairing token
  3. approve a code
…AND question whether **"approve a code" even belongs here** — that seems to be
an already-authed action (approving another machine AFTER you're signed in), not
a pre-auth option. Likely remove it from this pre-auth list.

### 6. Browser sign-in: make the URL keyboard-copyable — P1
On the "sign in via browser" step, after hitting `c`, the URL should be
**copyable from the keyboard** (not require a mouse select). Ensure `c`→copy
puts the auth URL on the clipboard / makes it selectable.

## CLI — workspace creation (step 2 of 3)

### 7. Show the "what a workspace is" definition here too — P1 (consistency)
On "create a new workspace from a directory", show the SAME inline workspace
definition we added to `rbox init` this session ("a workspace can be a single
repository or a folder of many repositories, or just a folder"). The TUI `setup`
path is missing it.

### 8. "Which directory should rbox sync?" — add typeahead directory picker — P1
Today it just shows the CWD. Wanted:
- A hint like **"hit enter or start typing"**.
- **Typeahead fuzzy-match** directory selection based on the tree of the current
  folder.
- **Tab** should jump to the next slash point (like unix path completion) so you
  can iterate deeper.
- Watch the edge case: user types something CWD-like but one/two folders deeper.

### 9. "How should rbox handle gitignored files?" — preview what syncs — P2 (explore)
Keep default option #1. Idea: a THIRD option that reads the root `.gitignore`
interactively and **shows the user what will/won't get synced before sync
starts**. Founder's dir has no root `.gitignore` by default — so maybe instead
recursively find ignore patterns and surface a truncated list of what was found.
"Table this for now but worth exploring."

## CLI — progress UX (scan / encrypt / upload)

### 10. Scanning: show growing payload SIZE alongside file count — P1
The scanning spinner shows a growing file count (e.g. 112,000). Also show the
growing **byte size** of the payload discovered.

### 11. Encrypting: show file size alongside progress — P1
Encrypting progress bar looks great; add the **size** dimension too.

### 12. Long-op reassurance message (>10s) — P2
If a step runs longer than ~10s, show a side note like *"initial encryption of
many small files can take time"* (and similar for upload). Reassures the user
it's not hung.

### 13. Uploading: show throughput + ETA — P1
On upload, keep the progress bar; add **throughput rate (MB/s)** and, if
derivable, an **ETA**. Same many-small-files reassurance note applies.

### 14. Progress % must be BYTE-based, not file-count-based — P1
Percentage complete should reflect **payload size** uploaded, not file count
(112k tiny files skews a count-based bar badly).

### 15. Hide the verbose multipart/telemetry line in release builds — P1
During upload, do NOT show the raw `rbox multipart parts bytes` output. And the
whole `rbox push files=… blobs=… ct=… | state-load … scan … encrypt … upload …
| rss …` debug telemetry line must be **dev-builds only**, never shown to a real
user mid-setup.

## CLI — git history + start-sync wording

### 16. Git-history "still uploading" wording — P1
Replace `✗ git history still uploading — will resume` / `! git history did not
finish attaching — the daemon (or rbox push) will resume it` with a calm,
positive: **"Git history will continue uploading in the background."** (Not an
✗/error tone — it's expected.)

### 17. "Start now and resume after reboot" implies you must reboot — P1
The start-sync choice wording is confusing — "resume after reboot" reads like
the user must reboot their machine. Reword to something clear like **"Start
background sync of this workspace"**, and if it also enables boot-persistence,
phrase it as **"…and start syncing on machine boot"** — never implying the user
needs to reboot now. (Same clarity bug class as the CLI onboarding we shipped.)

## CLI — final "rbox is setup" screen + post-setup

### 18. Final screen shows internal IDs, not human names — P1
It prints `workspace: <workspace ID> · device: <device ID>`. Useless to a human.
Show the **plain-English workspace name** the user chose and the **actual
hostname** of this device — not the internal `ws_…`/`dev_…` IDs.

### 19. Don't exit 0 — offer "set up another machine" — P1
After "rbox is setup", instead of exiting, drop into an interactive choice:
  1. Set up another machine right now?
  2. Exit — set up another machine later with `rbox pair` (or whatever the
     pairing command becomes).
(Ties into the deferred pairing flow #5 in onboarding-ux-backlog.)

---
_Themes: (a) hide internal IDs / dev telemetry from real users, show human names
+ byte-based progress; (b) the pairing flow (`rbox pair`) keeps recurring —
notes 5, 19; (c) copy that doesn't imply scary actions (reboot) — note 17.
Pending founder actions to fold in post-validation: this whole set + CLI pairing
flow (#5) + macOS keychain (#6) from onboarding-ux-backlog._

## 2026-07-19 follow-ups (v1.7.4 founder validation)

### 25. Plan unavailable from cache-only brief — IMPLEMENTED-IN-THIS-PR
Fresh signed-in devices had no `account-profile.json`, so bare `rbox` rendered
`plan unavailable`. The interactive bound-workspace front door now makes one
bounded best-effort account fetch on a cold profile and otherwise degrades unchanged.

### 26. Founder front-door menu order — IMPLEMENTED-IN-THIS-PR
The bound-workspace menu now follows the founder order, with complementary
`Sync now` / `Pause syncing` gating, existing setup/pair/usage/log flows, and
`Exit` last. The untracked-directory menu remains unchanged.
