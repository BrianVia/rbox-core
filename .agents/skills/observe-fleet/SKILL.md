---
name: observe-fleet
description: How to observe rbox prod/fleet activity — live worker traffic, ws_health/propagation telemetry, and a specific account's device state. Use when asked "what can we see from <user>'s API calls", "is telemetry flowing", "what's the fleet doing", or to debug a customer's sync from the server side.
---

# Observe fleet

Four vantage points on prod, cheapest/safest first. Prod resources:
worker `rbox-prod-api`, D1 `rbox-prod-db`, Analytics Engine dataset for client
telemetry. CF token lives in `~/.secret_env_vars` (`source` it per-command; see
[[operator-secrets]]). Everything here is **read-only** — never mutate prod from
an observation task.

## 1. Admin cockpit — `https://admin.rbox.to` (start here for per-account)

The founder-facing view, and the ONLY clean per-account surface (Analytics
Engine is fleet-only by the design-120 privacy contract, so it can't group by
account). The Accounts table shows, per account: client version, device count,
last device-report time, storage, sync-health flags. The "Sync experience"
panels show fleet propagation apply-delay, first-sync funnel, and (design 170)
the `ws_health` recovery-proxy / reconnect / notify-latency once data has
accumulated. Cloudflare-Access gated; the founder opens it directly. **For "what
is <account> doing", this is usually the fastest answer — ask the founder to
glance at the row, or read it via the D1 query below.**

## 2. Live worker tail — `wrangler tail rbox-prod-api`  (works unprivileged)

Live request stream. Catches telemetry POSTs, exceptions, and request paths in
real time. Run in the background for a bounded window and grep:

```sh
cd apps/api
source ~/.secret_env_vars; export CLOUDFLARE_API_TOKEN
timeout 80 bunx wrangler@latest tail rbox-prod-api --format json 2>&1 \
  | grep -iE "telemetry|cursor|committed|exception|/v1/" | head -40
```

- `POST /v1/telemetry` with `"exceptions": []` = client telemetry (incl. design
  170 `ws_health`) arriving and accepted. Exceptions here = an ingest/schema bug.
- The cursor control frame (design 170) is a WebSocket message to the
  WorkspaceSync DO's `webSocketMessage` handler — it does NOT surface as a
  request in tail (KV read + `ws.send`, no logging), so absence of cursor lines
  in tail is expected, not a problem.
- Tail shows ALL prod traffic (every account) — you cannot filter by account
  here; correlate by timing/path, or use D1 (#4) for a specific account.

## 3. Analytics Engine — fleet telemetry aggregates (fleet-only)

`ws_health` / `propagation` / `upload_lane` etc. land in AE. Query via the admin
cockpit (which already runs the SQL — `rbox-admin/src/lib/server/client-telemetry.ts`)
or, for a raw check, the AE SQL API with the CF token. **No per-account
dimension exists** (design-120 forbids account/device/workspace IDs in AE), so
AE answers "how is the FLEET doing", never "what is <account> doing". Design 171
(future) wires these to a Slack alert cron via `apps/api/src/ns.js`.

## 4. Prod D1 read-only — per-account device state (needs a permission allow)

For "did <account>'s machines upgrade / are they active", query `rbox-prod-db`:

```sh
cd apps/api
source ~/.secret_env_vars; export CLOUDFLARE_API_TOKEN
bunx wrangler@latest d1 execute rbox-prod-db --remote --env production --json \
  --command "SELECT sql FROM sqlite_master WHERE name='devices'"   # confirm columns first
bunx wrangler@latest d1 execute rbox-prod-db --remote --env production --json \
  --command "SELECT device_id, client_version, last_seen_at FROM devices WHERE account_id='<acct_...>' ORDER BY last_seen_at DESC"
```

- **CAVEAT (2026-07-20):** `wrangler d1 execute --remote` against prod is BLOCKED
  by Claude Code's auto-mode permission classifier — it reads as a prod-mutating
  command even for a `SELECT`. To run it, the founder must approve the prompt or
  add a Bash allow-rule (e.g. allow `wrangler d1 execute rbox-prod-db --remote`
  when the command contains only `SELECT`). Do NOT try to bypass the block.
- Confirm exact table/column names with the `sqlite_master` query first — the
  schema evolves via `apps/api/migrations/`.
- Find an account id from the admin cockpit, or `SELECT id FROM accounts` (there
  is no plaintext email column server-side; identity is E2EE — the cockpit
  resolves display email a different way, see design 117).
- STRICTLY read-only: `SELECT` only. Never `INSERT/UPDATE/DELETE` prod.

## Quick recipe by question

- "Did <user> upgrade / are they active?" → cockpit Accounts row, or D1 devices
  (`client_version`, `last_seen_at`).
- "Is telemetry flowing / any ingest errors?" → tail #2 for `/v1/telemetry` +
  `exceptions`.
- "How's fleet sync health / cursor-vs-backstop?" → cockpit Sync-experience
  panels (AE), once `ws_health` has accumulated post-1.7.12 rollout.
- "What's a specific user's live traffic?" → tail #2 and correlate by timing;
  per-account isolation only via D1 (#4).
