# 47 — CLI browser login (device-authorization grant, web-approved)

## Motivation

`rbox login`'s device-code path (design 04, `auth-cmd.ts:62-83`) already authorizes
a new machine without a bootstrap secret: it prints a short user code and polls
until *another terminal* runs `rbox device approve <code>`. That's fine when a
second signed-in terminal is at hand, but the primary use case for this product —
SSH'd into a headless dev box — means the "other terminal" is often not
conveniently reachable, and round-tripping through a second CLI session is more
friction than it needs to be.

The ask: a browser-optional login, shaped like `gh auth login`/`docker login` —
print a URL, auto-open it on a headed machine, offer to copy it for the SSH case,
and let the user approve from whatever browser they actually have open (laptop,
phone, doesn't matter — it doesn't have to be the same machine as the terminal).

Explicitly scoped to **existing accounts only** (see Non-goals). This is a login/
pairing UX change, not a re-architecture of account genesis.

### Why this doesn't need to be paywalled

Backing rationale, so this doesn't quietly turn into "require payment before
sync": R2 storage abuse economics don't justify gating free-tier sync behind
payment. Current R2 pricing (developers.cloudflare.com/r2/pricing, checked
2026-07-02): storage $0.015/GB-month (10 GB free), Class A ops $4.50/million
(1M free), Class B ops $0.36/million (10M free), egress free. 1,000 free
accounts fully maxed at the 2 GiB cap (`plans.ts` — `PLANS.free.storageBytes`)
is ~2,147 GB stored ≈ **$32/month** in raw storage — and that's the adversarial
worst case, not the expected one. rbox explicitly excludes `node_modules`/build
output/caches from sync, so a real tracked workspace tends to be source +
configs — a live paid-plan account's actual usage is ~200 MB against a 50 GB cap.
$32/mo worst-case, with some fraction of those 1,000 converting to paid before
ever approaching that ceiling, is not a number that should shape the auth
architecture. (What *would* matter and isn't covered here: Workers/D1 request
volume from a signup-spam bot scales with account count independent of storage —
that's a rate-limiting/verification problem on the signup path, not a reason to
paywall sync.)

So: login establishes **identity** (and, incidentally, plan — useful for UX
messaging like upgrade prompts) — it does not gate whether sync is allowed to
start.

## The E2EE ceiling this must respect

Restated from design 21 §1, because it's the load-bearing constraint on
anything auth-shaped in this codebase: **the browser has no Master Key and can
never be a roster device** (`21-account-linking.md:66-68`). Admitting a device
into the E2EE roster requires an admission grant signed by an already-enrolled
device; the server — and by extension the web dashboard — cannot mint that
material.

This flow is a browser-fronted version of the *existing* device-code grant,
which already respects this: a successful device-code login authorizes API
access but does **not** enroll the machine for encryption
(`setup-cmd.ts:15-18`, the `enrollmentOk` hard-stop at `setup-cmd.ts:149-159`).
Routing approval through a web session changes nothing about that — the CLI
still ends at the same "authorized but not enrolled, run `rbox pair`/`rbox
connect`/`rbox recover`" message it prints today. This design adds a friendlier
*front door* to an unchanged back room.

**Precedent for the security shape**: `rbox account link` (design 21 §4) is a
two-phase dashboard-shows-code → CLI-redeems (pending) → dashboard-confirms
ceremony, deliberately not a one-shot exchange, specifically because a single
leaked code must never be sufficient to take over an account. This design's
flow is safe with a *single* confirm (unlike account-link) because approving a
device-code request only ever grants the same authorized-but-unenrolled state
`rbox device approve` already grants today — there is no additional privilege
being exchanged, so there's nothing for a leaked code to escalate into beyond
what device-code approval could already do.

## Flow

1. `rbox login` (unauthenticated), or `rbox setup` → "Log into an existing
   account" → a new "Sign in via browser" option, alongside the existing
   "Paste a pairing token" and "Approve a code" choices
   (`setup-cmd.ts:125-144`).
2. CLI calls `POST /v1/auth/device/start` — **unchanged**, already returns
   `{ deviceCode, userCode, interval: 5, expiresIn: 600 }`
   (`device-code.ts:20-41`).
3. CLI prints:
   ```
   To authorize this device, visit:

       https://app.rbox.to/cli-login?code=XXXX-XXXX

   [o] Open in browser   [c] Copy URL to clipboard   [any key] I'll do it myself
   Waiting for approval…
   ```
   and immediately starts polling `POST /v1/auth/device/poll` at the returned
   `interval` — **unchanged** (`auth-cmd.ts`'s existing poll loop).
   - Attempts `openInBrowser()` opportunistically (best-effort; a headless SSH
     session with a TTY will often still "succeed" spawning `xdg-open` with no
     `$DISPLAY` and silently do nothing — there's no reliable headed/headless
     signal, so we don't gate on one). The interactive prompt is shown
     regardless of whether auto-open fired, so a silent failure never strands
     the user — this is exactly the existing `openInBrowser`/`openAndShow`
     behavior in `subscribe-cmd.ts:19-36`, which already treats "couldn't open"
     as "print the URL," not an error.
   - `[c]` copies the URL (not a second code — see below for why no second
     code is needed).
4. New web page, `app.rbox.to/cli-login?code=XXXX-XXXX`: requires a live Clerk
   session (bounces through sign-in if needed, preserving the `code` query
   param through the redirect). Shows the code for visual confirmation against
   the terminal, plus a device label if `device/start` is extended to surface
   one (nice-to-have, not required for v1), and a single "Approve" button.
5. On approve, the page calls `POST /v1/auth/device/approve { userCode }`
   using the existing web-session bearer — **the same endpoint `rbox device
   approve` already calls** (`device-code.ts:99-109`). The only server change
   required is admitting this one route for `kind=='web'` principals in
   `webTokenAllowed()` (`worker.ts:276-288`); `approveDeviceAuth` itself is
   untouched; it only ever reads `approver.accountId`/`approver.userId`, so it
   doesn't matter whether the approver is a durable CLI device or a web
   session.
6. The CLI's already-running poll (step 3) picks up `status: "approved"` on
   its next tick (≤5s) and completes exactly as it does for CLI-to-CLI
   approval today — same `mintDeviceWithNotification` call, same "authorized
   but not enrolled for encryption, next: `rbox pair`/`rbox connect`/`rbox
   recover`" messaging if this is a fresh, unenrolled machine.

**No local HTTP listener, no localhost redirect, no second/manual code.**
Because approval is poll-driven rather than redirect-driven, the browser
approving from a *different* machine than the terminal (the SSH case) and the
browser approving from the *same* machine both resolve identically — the CLI
never needs to know which happened. This is simpler than the flow this doc
originally sketched (which mirrored Claude Code's redirect/PKCE-shaped login);
that extra machinery isn't needed here because rbox already ships a
poll-based grant type.

## Server change

One line in `webTokenAllowed()` (`worker.ts:276`):

```ts
if (method === "POST" && eq(seg, ["v1", "auth", "device", "approve"])) return true;
```

No new route, no new handler, no schema change. `device_auth` rows already
carry no notion of "who approved" beyond `account_id`/`user_id`
(`device-code.ts:36-39`, `104-106`), so nothing distinguishes a web-approved
device-code from a CLI-approved one server-side — which is correct, since
they grant identically-scoped access.

**Device label — resolved.** `login()` already sets `label = os.hostname()`
and sends it to `device/start` (`auth-cmd.ts:36,62`) — no CLI change needed
there. But that label is only ever returned to the *CLI* today; the web
confirm page only has the `userCode` from the URL query string and has no way
to look up which label it belongs to. That needs one small new **public,
unauthenticated** GET route — it carries no rbox Principal, same category as
the account-link start/status/confirm routes design 21 notes don't need the
`webTokenAllowed` gate:

```ts
// GET /v1/auth/device/lookup?code=XXXX-XXXX -> { label, status } | 404
export async function lookupDeviceAuth(req: Request, env: Env): Promise<Response> {
  const userCode = new URL(req.url).searchParams.get("code")?.toUpperCase();
  if (!userCode) return json({ error: "bad_request" }, 400);
  const row = await dirDb(env)
    .prepare("SELECT label, status, expires_at FROM device_auth WHERE user_code = ?")
    .bind(userCode)
    .first<{ label: string | null; status: string; expires_at: number }>();
  if (!row || (Date.now() > row.expires_at && row.status === "pending")) return json({ error: "not_found" }, 404);
  return json({ label: row.label, status: row.status });
}
```

Returns only a hostname label and a status enum — no account id, no token,
nothing an attacker can do anything with beyond what guessing a valid
`userCode` already lets them do today (confirm a login prompt exists; they
still can't approve it without a Clerk session on the target account). Same
guessability profile as the existing `device/approve` route, not a new
exposure.

## CLI change

- Extract `openInBrowser`/`openAndShow` out of `subscribe-cmd.ts` into a
  shared module (e.g. `src/cli/browser-open.ts`) so `auth-cmd.ts` can reuse it
  instead of duplicating the cross-platform `open`/`xdg-open`/`cmd` spawn
  logic.
- `login()`'s device-code branch (`auth-cmd.ts:62-83`) changes its printed
  instructions from "run `rbox device approve <code>` on an already-signed-in
  machine" to the URL + `[o]`/`[c]` prompt described above. The existing
  "approve from another terminal" path stays available too (some users will
  still prefer it, and it's zero marginal cost to keep) — this is additive,
  not a replacement.
- `setup-cmd.ts`'s "Log into an existing account" step gets a third option,
  "Sign in via browser," calling the same updated `login()`.

## Web change

- New SvelteKit route, `apps/web/src/routes/cli-login/+page.svelte` (or
  similar), gated behind the existing Clerk `signedIn` check
  (`+layout.svelte` already owns the signed-out redirect per the web
  dashboard stack). Reads `code` from the query string, calls the new public
  `GET /v1/auth/device/lookup?code=…` to render "Approve login for
  `<label>`?" (falling back to just showing the code if `label` is null —
  older CLI versions or a non-hostname label), then POSTs to
  `/v1/auth/device/approve` using the existing authenticated fetch pattern
  already used for other web-session dashboard calls.

## Non-goals

- **Self-serve account genesis.** This flow only authorizes a device onto an
  account that already exists. Creating a brand-new account without the
  admin-gated `RBOX_BOOTSTRAP_SECRET` is a separate, larger decision (design
  21 flagged it explicitly as future work, not built —
  `21-account-linking-plan.md:14`) and is out of scope here.
- **E2EE enrollment.** This flow authorizes API access only. It does not
  admit a device to the encryption roster and does not replace `rbox pair`/
  `rbox connect`/`rbox recover` — see "The E2EE ceiling," above.
- **Replacing terminal-to-terminal approval.** `rbox device approve <code>`
  keeps working exactly as it does today; this is an additional front door,
  not a deprecation.
- **Payment gating.** Login checks identity (and surfaces plan for UX), not
  payment status. See "Why this doesn't need to be paywalled," above.

## Open questions

- Rate limiting on `/v1/auth/device/start`, the new public
  `/v1/auth/device/lookup`, and the web-reachable
  `/v1/auth/device/approve` — device-code start/poll presumably already has
  some abuse-resistance given it predates this doc (design 04), but worth
  confirming the web-session path doesn't open a new brute-force angle on
  guessing `userCode` values (8 chars from a 33-char alphabet, collision-
  checked against *pending* codes only per `randomUserCode()` — worth a quick
  gut-check on the guess space vs. the 5-attempt collision retry, though this
  is unchanged from what already ships today).

## Regression coverage

- `webTokenAllowed()`: `POST /v1/auth/device/approve` now returns `true` for
  `kind=='web'`; every other previously-denied route stays denied (guard
  against an overly-broad allowlist edit).
- `approveDeviceAuth` (unchanged): existing tests continue to pass unmodified
  — this design deliberately doesn't touch that function.
- CLI: `login()`'s device-code branch prints the URL/prompt and still
  completes via the unchanged poll loop when the mocked poll response
  transitions to `approved` (no behavior fork needed based on *how* it was
  approved).
- Web: `/cli-login` redirects unauthenticated visitors through Clerk sign-in
  and preserves the `code` param across that round trip.
- `lookupDeviceAuth`: returns `{ label, status }` for a pending code, 404 for
  unknown/expired codes, never leaks `account_id`/`user_id`/tokens.
