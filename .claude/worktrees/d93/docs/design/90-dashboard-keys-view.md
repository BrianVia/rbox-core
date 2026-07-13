# Design 90 — Dashboard agent-keys view (manage only)

> **Implementation: 🔴 NOT STARTED** — design only, by explicit instruction
> (working tree kept clean for the reliability flow). Status index:
> [`README.md`](./README.md).

**Status:** DRAFT
**Depends on:** design 87 v1 (shipped 2026-07-08 — the API surface exists on
prod), design 20 §7/R8 (normative: the browser MANAGES keys, never sees or
creates key material).

## 1. Why

Agent keys shipped with CLI-only management. The dashboard is where a user
notices "one of my keys is stale/leaked/unknown" — list, label context, and a
revoke button belong there. Design 20 R8 already settled the boundary: the
web app cannot mint a working key (no MK in the browser), so this view is
deliberately read-and-revoke.

## 2. Surface

New section on the dashboard (apps/web, Svelte, matching the existing
Tailwind v4 + shadcn-svelte light-SaaS style — see the devices list for the
established table idiom):

- **List** (`GET /v1/keys/api` — live on prod): columns `label`,
  `displayPrefix` (e.g. `rbox_pat_pNFofOvu...` — the only key material the
  server has to show; it's a prefix, not a secret), `created`, `last seen`
  (relative — "active 3m ago" is the fleet-health signal, design 87 §4.5),
  `expires` (highlight < 7 days), status pill (`active` / `revoked` /
  `expired`).
- **Revoke** (`POST /v1/keys/api/:deviceId/revoke`): confirm dialog naming
  the label + prefix + last-seen ("Agents using this key lose access
  immediately. Data already synced to them is not recalled."). Revoked rows
  stay listed (struck through) — they're audit context, and the sidecar/
  devices rows persist.
- **Create = instructions, not a button** (design 20 R8): a small callout
  with the two commands —
  `rbox key create-ci --expires 90d --label "<what it's for">` and the
  `RBOX_KEY=… rbox setup --workspace=<name>` join — plus a link to
  rbox.to/docs#agents. No web-initiated issuance in v1 (the
  device-completed handshake remains the documented fast-follow, design 20
  §10 Q5).
- **Empty state:** one-liner pitch ("Give your agents and CI your latest
  working tree — one key, one command") + the same instructions.
- **Plan gating:** none needed client-side beyond honesty — a `none`-plan
  account sees the empty state; creation is already 403'd server-side with
  the subscribe hint (design 87 §5).

## 3. Mechanics

- `apps/web/src/lib/api.ts`: `fetchApiKeys()` / `revokeApiKey(deviceId)` —
  same authed-fetch pattern as the devices calls. Types mirror the server's
  camelCase row (deviceId, label, displayPrefix, createdAt, lastSeenAt,
  expiresAt, revoked).
- Auth: web session tokens are allowed on these routes (api_key principals
  are the ones denied). No new server work.
- Testing: mock-fetch pattern per the PR #77 audit approach (Clerk Turnstile
  blocks automated sign-in); component tests for the revoke confirm flow +
  expiring-soon highlight; the API contract is already covered by
  api-keys.test.ts server-side.

## 4. Out of scope

Web-initiated key creation (design 20 Q5 fast-follow), per-key scopes
(design 20 §6.5), rotation UX (P3 → design 19), usage-per-key metering.
