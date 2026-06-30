import type { Env } from "./env.js";

/**
 * §32 — the D1 routing seam (Phase 0, N=1).
 *
 * Today every control-plane query reaches one D1 binding (`env.rbox_dev_db`,
 * literally named that in BOTH dev and prod). §32 introduces ONE indirection —
 * the only place outside this module that a binding is named — so that *future*
 * account sharding is config + an opt-in data-move, never a 156-site rewrite.
 *
 * Two planes (design 32 §2):
 *
 *   - `dbFor(env, accountId)` — the ACCOUNT-DATA plane. Everything keyed by
 *     `account_id`: commit accounting, `blob_refs`/`blobs`/`gc_candidates`,
 *     `workspaces`/`uploads`, the key/roster/key-state store, `account_notify_prefs`
 *     + the notification outbox, billing/quota, `audit_log`, the `commits` mirror,
 *     and the per-(workspace,project) WorkspaceSync DO. Under real sharding this
 *     resolves to the shard owning `accountId`.
 *
 *   - `dirDb(env)` — the DIRECTORY plane. Credential→account lookups that run
 *     BEFORE the account/shard is known and so can never route by it: `devices`
 *     (+ the `memberships`/`users` that `authenticate` JOINs), `pairing_tokens`,
 *     `device_auth`, `clerk_users`, `account_link_codes`/`account_link_events`,
 *     and `stripe_events` dedup. Read-heavy, write-light — it carries none of the
 *     O(blobs) write volume.
 *
 * At **N=1 both return the identical single binding**, so this refactor is a pure,
 * behavior-preserving re-route. The metrics span still works unchanged: `startOp`
 * (metrics.ts) clones `env` with a span-wrapped `rbox_dev_db`, and callers pass
 * that `op.env` into `dbFor`/`dirDb`, so the resolved binding stays span-wrapped.
 *
 * NOTE on `accountId`: a small number of account-DATA-plane sites have no account
 * id in scope — global cron fan-outs (GC / retention sweeps) and secondary-key
 * lookups (`accounts` by `stripe_customer_id`, `device_notifications` by
 * `token_hash`, `commits` by workspace). §32 defers their true mechanics (per-shard
 * fan-out → §33; a directory secondary index) to a later milestone. They call
 * `dbFor(env, "")` here: plane-correct, account explicitly absent, and a no-op at
 * N=1 (every accountId resolves to the one shard). These are the sites a real
 * sharding cutover must revisit.
 */

/** Account-data plane: the D1 owning `accountId`'s sharded state (§32 §2). At N=1
 *  the single binding, regardless of `accountId`. */
export function dbFor(env: Env, accountId: string): D1Database {
  void accountId; // N=1: a constant function; the id selects the shard once N>1.
  return env.rbox_dev_db;
}

/** Directory plane: the D1 holding credential→account lookups that precede the
 *  account (§32 §2/§3). At N=1 the same single binding as `dbFor`. */
export function dirDb(env: Env): D1Database {
  return env.rbox_dev_db;
}
