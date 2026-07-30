---
name: account-cleanup
description: "How rbox storage GC actually works, what it will never collect, and the safe procedure for deleting abandoned accounts (verified 2026-07-21 against the live pipeline)"
---

# Account cleanup & GC reality

Use this when someone asks "will old accounts/devices/blobs get garbage
collected?" or wants to reap abandoned test accounts. Short answer: **no
automatic reaping exists — deletion is always owner-driven.**

## What the scheduled GC does (hourly cron `23 * * * *`, worker.ts::scheduled)

- **Phase 1 — per-account reachability** (`apps/api/src/gc-phase1.ts`):
  condemns `blob_refs` UNREACHABLE from the account's own DO roots (leaked
  over-cap partials, head-409 strays) into `gc_candidates`. Never touches
  blobs a live head still references. Never deletes R2 itself.
- **Phase 2 — canonical R2 sweep** (`versions.ts::gcMark` @08:23,
  `gcPurge` @09:23): deletes R2 objects + `blobs` rows for condemned shas.
  This is the pipeline the admin cockpit charts (`fetchGcPipeline`,
  rbox-admin overview.ts) — an orphan sweep, NOT an abandoned-account reaper.
- **Retention prune** (`retention.ts`): plan-window history only, never the
  head — and globally DISABLED (`RBOX_HISTORY_PRUNE_DISABLED="1"` dev+prod).
- **No idle-account reaper. No R2 lifecycle rules** (wrangler.jsonc).
  `accounts.reclaimed_at` = account-linking/Stripe reclaim only, not idleness.

## Identifying what an account owns

- Emails live server-side in `clerk_users.email` / `users.email` (directory
  plane, cached from Clerk); `accounts` has no email column.
- Per-account bytes: `accounts.used_bytes`, visible with email in the admin
  cockpit accounts list (`/v1/admin/overview`). AE has NO account dimension —
  don't try; remote D1 SELECT is classifier-blocked from agents.

## The safe deletion procedure (per account)

1. Sign into the WEB DASHBOARD via Clerk **as that account's email**.
2. Settings → Danger Zone → confirm by typing that account's email (or id).
3. Immediate tombstone: all devices revoked, `deleted_at` stamped,
   `account_deletions` ledger row. Devices stop reporting instantly.
4. After the 7-day grace (`DELETION_GRACE_MS`) the cron hard-purges:
   workspace DOs → blob_refs → orphans → Phase-2 R2 reclaim, uploads, keys/
   notifications/audit/fairuse, devices/memberships/users, the Clerk user,
   Stripe. (`apps/api/src/account-delete.ts`.)
5. Bonus: `finishD1` also deletes `device_sync_state` + `alert_state` rows —
   design-127 fleet alerts from those devices die with the account.

## What NOT to do

- There is NO admin force-delete of an account (`routes/admin.ts` has only
  set-plan, single-workspace purge, GC controls) — deliberate: deletion is
  owner-authenticated + confirmation-gated. Don't build ad-hoc workarounds.
- `DELETE /v1/admin/workspace/:id` (platform secret) purges one workspace's
  DO + condemns its blobs but leaves account/devices/refs — not a cleanup.
- No `rbox account delete` CLI exists (account subcommands: link/status/
  unlink). The dashboard is the path.

## Verifying a deletion took

- Cockpit accounts list: row gone (or `deleted_at` set during grace).
- After grace + the next 09:23 purge: `gc.objects.purged` AE metric ticks;
  cockpit GC pipeline chart shows the candidates drain.
