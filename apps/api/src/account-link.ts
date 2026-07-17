import type { Env } from "./env.js";
import type { Principal } from "./authz.js";
import { json, sha256Hex } from "./util.js";
import { verifyClerkJWT } from "./clerk.js";
import { isUniqueViolation, randomHex } from "./auth.js";
import { repointBillingToAccount } from "./stripe.js";
import { dbFor, dirDb } from "./db.js";
import { ipKey, rateLimited } from "./ratelimit.js";
import { fairUseQueueStatement } from "./fairuse.js";

/**
 * Web↔CLI account linking (design 21). A two-phase bind attaches a live Clerk
 * identity C onto a CLI-anchored account X:
 *   START   (dashboard, fresh Clerk JWT)   → mint a single-use ≥128-bit code
 *   REDEEM  (terminal, durable owner token) → record a PENDING proposal (no rebind)
 *   STATUS  (dashboard, fresh Clerk JWT)    → see the proposed target X
 *   CONFIRM (dashboard, fresh Clerk JWT)    → ONE atomic conditional rebind (§4.2.1)
 *
 * The server identity layer only: linking decides WHICH account_id a Clerk session
 * manages — never anything about the Master Key (the browser holds no crypto).
 */

const LINK_TTL_MS = 10 * 60 * 1000; // aligns with PAIR_TTL_MS
const LINK_ACTIVE_CAP = 5; // max in-flight (uncommitted, unexpired) codes per Clerk id
const LINK_PREFIX = "rbox-link_"; // human-recognizable; stripped before hashing
const CODE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(32 random bytes) = 256 bits

// The link code is 256 bits of base64url entropy (§5.3); `randomHex`/`isUniqueViolation`
// are shared with auth.ts (the canonical id-minting + D1 error helpers).
function randomB64url(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── phase: START ─────────────────────────────────────────────────────────────

/** POST /v1/account/link/start — PUBLIC. Fresh Clerk JWT in body. Mint a code
 *  bound to the re-proven Clerk identity C and C's CURRENT account (origin). */
export async function startLink(req: Request, env: Env, nowMs: number): Promise<Response> {
  // Shared per-IP burst cap before code minting.
  const limited = await rateLimited(env.RL_LINK_PAIR, `lp:${ipKey(req)}`);
  if (limited) return limited;
  if (!env.CLERK_ISSUER) return json({ error: "web_auth_not_configured" }, 501);
  const body = (await req.json().catch(() => ({}))) as { clerkToken?: unknown };
  if (typeof body.clerkToken !== "string") return json({ error: "unauthorized" }, 401);
  const claims = await verifyClerkJWT(env, body.clerkToken, Math.floor(nowMs / 1000));
  if (!claims) return json({ error: "unauthorized" }, 401);
  const c = claims.sub;

  // Require an existing web mapping — the dashboard always exchanges /v1/web/session
  // first, so origin_account (NOT NULL) is well-defined (design 21 §4.1, finding 11).
  const map = await dirDb(env).prepare("SELECT account_id FROM clerk_users WHERE clerk_user_id = ?").bind(c).first<{ account_id: string }>();
  if (!map) return json({ error: "web_session_required" }, 409);

  const secret = randomB64url(32);
  const codeHash = await sha256Hex(secret);
  const pollKey = `plk_${randomHex(16)}`;
  const expiresAt = nowMs + LINK_TTL_MS;
  // Atomic active-code cap per Clerk id (mirrors the pairing cap, auth.ts) — a
  // single INSERT…SELECT…WHERE count<cap, so concurrent starts can't both pass.
  const res = await dirDb(env)
    .prepare(
      `INSERT INTO account_link_codes (code_hash, poll_key, clerk_user_id, origin_account, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM account_link_codes WHERE clerk_user_id = ? AND committed_at IS NULL AND expires_at > ?) < ?`
    )
    .bind(codeHash, pollKey, c, map.account_id, nowMs, expiresAt, c, nowMs, LINK_ACTIVE_CAP)
    .run();
  if ((res.meta.changes ?? 0) === 0) return json({ error: "too_many_link_codes", cap: LINK_ACTIVE_CAP }, 429);
  return json({ code: `${LINK_PREFIX}${secret}`, pollKey });
}

// ── phase: REDEEM ────────────────────────────────────────────────────────────

/** POST /v1/account/link/redeem — AUTHED (durable OWNER device token). Phase 1:
 *  atomic single-use consume → record the pending proposal. NOTHING is rebound. */
export async function redeemLink(env: Env, p: Principal, rawCode: string): Promise<Response> {
  // Fail-closed: a web session is also an owner `devices` row, so kind must be
  // durable AND role owner (design 21 §4.2, finding 4). The redeemer is identified
  // by the unique token_hash via authenticate(), so this proof is sound.
  if (p.kind !== "device") return json({ error: "forbidden", message: "link redeem requires a durable CLI device token" }, 403);
  if (p.role !== "owner" || !p.userId) return json({ error: "forbidden", message: "link redeem requires an owner device" }, 403);
  const code = rawCode.startsWith(LINK_PREFIX) ? rawCode.slice(LINK_PREFIX.length) : rawCode;
  if (!CODE_RE.test(code)) return json({ error: "unauthorized" }, 401);
  const hash = await sha256Hex(code);
  const now = Date.now();
  const consumed = await dirDb(env)
    .prepare(
      `UPDATE account_link_codes
       SET consumed_at = ?, pending_account = ?, pending_device = ?, pending_user = ?, pending_at = ?
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING clerk_user_id`
    )
    .bind(now, p.accountId, p.deviceId, p.userId, now, hash, now)
    .first<{ clerk_user_id: string }>();
  if (!consumed) return json({ error: "unauthorized" }, 401); // invalid / expired / already used
  return json({ account: p.accountId });
}

// ── phase: STATUS (poll = the confirm surface) ───────────────────────────────

/** GET /v1/account/link/status?pollKey=… — PUBLIC. Fresh Clerk JWT in the
 *  Authorization header. Reports the proposed target + a fingerprint (drives confirm). */
export async function linkStatus(req: Request, env: Env, nowMs: number, pollKey: string): Promise<Response> {
  if (!env.CLERK_ISSUER) return json({ error: "web_auth_not_configured" }, 501);
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const claims = await verifyClerkJWT(env, header.slice(7), Math.floor(nowMs / 1000));
  if (!claims) return json({ error: "unauthorized" }, 401);
  const row = await dirDb(env)
    .prepare("SELECT clerk_user_id, pending_account, committed_at, expires_at FROM account_link_codes WHERE poll_key = ?")
    .bind(pollKey)
    .first<{ clerk_user_id: string; pending_account: string | null; committed_at: number | null; expires_at: number }>();
  if (!row || row.clerk_user_id !== claims.sub) return json({ error: "not_found" }, 404); // never leak another id's code
  const status = row.committed_at ? "committed" : row.pending_account ? "pending" : nowMs > row.expires_at ? "expired" : "awaiting";
  const fingerprint = row.pending_account ? (await sha256Hex(row.pending_account)).slice(0, 12) : null;
  return json({ status, pendingAccount: row.pending_account, fingerprint });
}

// ── phase: CONFIRM (the one atomic conditional rebind, §4.2.1) ───────────────

interface CodeRow {
  clerk_user_id: string;
  origin_account: string;
  pending_account: string | null;
  pending_user: string | null;
  pending_device: string | null;
  consumed_at: number | null;
  committed_at: number | null;
  expires_at: number;
}

/** POST /v1/account/link/confirm — PUBLIC. Fresh Clerk JWT + pollKey in body.
 *  Phase 2: read-side pre-checks → one self-guarded atomic batch → post-verify. */
export async function confirmLink(req: Request, env: Env, nowMs: number): Promise<Response> {
  if (!env.CLERK_ISSUER) return json({ error: "web_auth_not_configured" }, 501);
  const body = (await req.json().catch(() => ({}))) as { clerkToken?: unknown; pollKey?: unknown };
  if (typeof body.clerkToken !== "string" || typeof body.pollKey !== "string") return json({ error: "unauthorized" }, 401);
  const claims = await verifyClerkJWT(env, body.clerkToken, Math.floor(nowMs / 1000));
  if (!claims) return json({ error: "unauthorized" }, 401);
  const c = claims.sub;
  const pollKey = body.pollKey;

  // The code row and C's current mapping are independent reads (keyed on pollKey
  // and c) → fetch them concurrently (one round-trip latency, not two).
  const [code, cur] = await Promise.all([
    dirDb(env)
      .prepare("SELECT clerk_user_id, origin_account, pending_account, pending_user, pending_device, consumed_at, committed_at, expires_at FROM account_link_codes WHERE poll_key = ?")
      .bind(pollKey)
      .first<CodeRow>(),
    dirDb(env).prepare("SELECT account_id FROM clerk_users WHERE clerk_user_id = ?").bind(c).first<{ account_id: string }>(),
  ]);
  if (!code || code.clerk_user_id !== c) return json({ error: "not_found" }, 404);
  const x = code.pending_account;

  // Idempotent re-confirm: already committed to X and C still maps X → success.
  if (code.committed_at && cur?.account_id === x) return json({ account: x });
  if (!code.consumed_at || code.committed_at || !x || !code.pending_user) return json({ error: "conflict" }, 409); // not pending / already committed elsewhere
  if (nowMs > code.expires_at) return json({ error: "expired" }, 401);
  if (!cur || cur.account_id !== code.origin_account) return json({ error: "conflict" }, 409); // concurrent move off origin

  // Reclaim/guard decision over C's CURRENT account (the origin shell).
  let reclaimNeeded = false;
  if (cur.account_id !== x) {
    // Target X must not already be managed by a DIFFERENT Clerk identity (design
    // §4.2.1 pre-check). Checked HERE, before the billing saga, so a doomed rebind
    // (uq_clerk_users_account) can never leave billing half-moved onto someone
    // else's X (the Stripe/D1 boundary isn't transactional). The atomic batch's
    // UNIQUE index stays the backstop for a concurrent map that races this read.
    const xMap = await dirDb(env).prepare("SELECT clerk_user_id FROM clerk_users WHERE account_id = ?").bind(x).first<{ clerk_user_id: string }>();
    if (xMap && xMap.clerk_user_id !== c) return json({ error: "already_linked" }, 409);

    // One snapshot answers both the full predicate and the ignoreBilling variant.
    const shellState = await loadShellState(env, cur.account_id, nowMs);
    const curOrigin = shellState?.origin ?? null;
    if (curOrigin === "web") {
      reclaimNeeded = true;
      if (!judgeReclaimable(shellState)) {
        // The shell isn't reclaimable as-is. If its ONLY blocker is billing (it's
        // §3.4-empty once the Stripe columns are ignored), run the re-point saga
        // (§3.4.2) to move the subscription onto X — after which the shell is empty
        // and reclaimable below. Any NON-billing state (or a saga that can't run)
        // still blocks: we never half-move a shell that would block anyway.
        if (!judgeReclaimable(shellState, { ignoreBilling: true })) {
          return json({ error: "origin_account_has_state" }, 409);
        }
        const repoint = await repointBillingToAccount(env, cur.account_id, x, nowMs);
        if (repoint === "destination_has_subscription") return json({ error: "destination_has_subscription" }, 409); // never merge two subs
        if (repoint !== "repointed") return json({ error: "origin_account_has_state" }, 409); // unavailable / not_migratable → block
        // Re-read AFTER the saga: it only verifies BILLING columns, so this fresh
        // full read is the only thing that catches non-billing state added in the
        // window between the snapshot above and now (a TOCTOU guard, not a dup check).
        if (!judgeReclaimable(await loadShellState(env, cur.account_id, nowMs))) return json({ error: "origin_account_has_state" }, 409);
      }
    } else if (curOrigin === "bootstrap") {
      return json({ error: "already_linked" }, 409); // C is on a real account; explicit unlink required (§5.4)
    } else {
      return json({ error: "origin_account_has_state" }, 409); // NULL/ambiguous → fail-closed, never strand
    }
  }

  // The one atomic batch. The REBIND (statement 1) re-verifies the FULL code
  // validity INSIDE its own WHERE — pending (consumed, not committed), unexpired,
  // and still proposing X — so the write condition (not just a prior JS read) gates
  // the rebind; and its `account_id = origin_account` clause makes it single-winner
  // (a second concurrent confirm finds C already on X → no-op). Every later write is
  // conditioned on the rebind having landed; a thrown UNIQUE (X already has a Clerk
  // row) rolls the whole batch back. D1 batches run in one atomic transaction.
  const orphan = "NOT EXISTS (SELECT 1 FROM clerk_users WHERE account_id = ?)";
  const landed = "EXISTS (SELECT 1 FROM clerk_users WHERE clerk_user_id = ? AND account_id = ?)";
  const codeValid =
    "EXISTS (SELECT 1 FROM account_link_codes WHERE poll_key = ? AND consumed_at IS NOT NULL AND committed_at IS NULL AND expires_at > ? AND pending_account = ?)";
  // §32 FLAG (§6a): the rebind is the atomic commit and lives on the DIRECTORY plane
  // (clerk_users + account_link_codes + account_link_events + the directory-plane
  // memberships/users/devices shell rows). The reclaim ALSO mutates two account-data rows
  // (`accounts.reclaimed_at`, `account_notify_prefs`) for the origin shell — prepared via
  // dbFor(shell) below. At N=1 every helper returns the one binding, so this is a single
  // atomic batch; under real sharding §6a splits it into a dirDb rebind + a best-effort
  // per-shard teardown. The §6a placement constraint keeps origin + X co-resident.
  const stmts = [
    dirDb(env)
      .prepare(`UPDATE clerk_users SET account_id = ?, user_id = ? WHERE clerk_user_id = ? AND account_id = ? AND ${codeValid}`)
      .bind(x, code.pending_user, c, code.origin_account, pollKey, nowMs, x),
    dirDb(env).prepare(`UPDATE account_link_codes SET committed_at = ? WHERE poll_key = ? AND committed_at IS NULL AND ${landed}`).bind(nowMs, pollKey, c, x),
    dirDb(env)
      .prepare(`INSERT INTO account_link_events (clerk_user_id, from_account, to_account, method, actor_device, at) SELECT ?, ?, ?, 'cli_link', ?, ? WHERE ${landed}`)
      .bind(c, code.origin_account, x, code.pending_device, nowMs, c, x),
  ];
  if (reclaimNeeded) {
    const shell = cur.account_id;
    stmts.push(
      // account-data plane (origin shell's shard) — co-batched here only because N=1.
      dbFor(env, shell).prepare(`UPDATE accounts SET reclaimed_at = ? WHERE id = ? AND ${orphan}`).bind(nowMs, shell, shell),
      dirDb(env).prepare(`DELETE FROM memberships WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dirDb(env).prepare(`DELETE FROM users WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dirDb(env).prepare(`DELETE FROM devices WHERE account_id = ? AND expires_at IS NOT NULL AND ${orphan}`).bind(shell, shell),
      // §9.5: account_notify_prefs is a settings artifact (not a blocker) — clean it on
      // reclaim like the shell's own user row. (device_notifications can't exist on a
      // reclaimable shell — it implies a durable device, which blocks below — so it's a
      // COVERED blocker, not a cleaned row.) account-data plane (origin shell's shard).
      dbFor(env, shell).prepare(`DELETE FROM account_notify_prefs WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      // §33/§9.5: blob_ref_candidates is a transient Phase-1 GC marker. It can only exist
      // alongside a blob_refs row (a COVERED blocker → br>0 fails judgeReclaimable), so this
      // is defensive (no-op on a truly-reclaimable shell), but clean it like the other shell
      // artifacts so no orphan GC marker survives reclaim. account-data plane (shell's shard).
      dbFor(env, shell).prepare(`DELETE FROM blob_ref_candidates WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      // Design 149 §C2: the observe-only scan ledger is derived, rebuildable state —
      // cleaned on reclaim like blob_ref_candidates, never a reclaim blocker. The
      // replacement account is re-queued at its own insert site (unlinkAccount).
      dbFor(env, shell).prepare(`DELETE FROM fairuse_materialize_refs WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dbFor(env, shell).prepare(`DELETE FROM fairuse_root_membership WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dbFor(env, shell).prepare(`DELETE FROM fairuse_sha_last WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dbFor(env, shell).prepare(`DELETE FROM fairuse_workspace_streams WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dbFor(env, shell).prepare(`DELETE FROM fairuse_scans WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dbFor(env, shell).prepare(`DELETE FROM fairuse_leases WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      dbFor(env, shell).prepare(`DELETE FROM fairuse_account_queue WHERE account_id = ? AND ${orphan}`).bind(shell, shell)
    );
  }
  try {
    await dirDb(env).batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) return json({ error: "already_linked" }, 409); // X already mapped by another Clerk id
    throw e;
  }
  const after = await dirDb(env).prepare("SELECT account_id FROM clerk_users WHERE clerk_user_id = ?").bind(c).first<{ account_id: string }>();
  if (after?.account_id !== x) return json({ error: "conflict" }, 409); // rebind guard no-op'd (concurrent move)
  return json({ account: x });
}

/**
 * A web shell is reclaimable iff EXHAUSTIVELY empty (design 21 §3.4): origin='web',
 * no row in any account-scoped STATE table, and no non-default billing/entitlement
 * value. `commits` has no account_id → checked via the workspaces join. Append-only
 * forensic logs (audit_log, account_link_events) are deliberately EXCLUDED.
 *
 * Split into a single exhaustive D1 read (`loadShellState`) and a pure judge
 * (`judgeReclaimable`) so the caller can evaluate BOTH the full predicate and the
 * `ignoreBilling` variant from ONE snapshot (no second identical round-trip, and no
 * TOCTOU gap between the two judgments).
 */
type ShellState = Record<string, number | string | null>;

async function loadShellState(env: Env, accountId: string, nowMs: number): Promise<ShellState | null> {
  // §32 FLAG (§6a): this single SELECT mixes account-data (`accounts` + key/workspace/
  // blob_ref/upload/notification counts) with directory-plane counts (clerk_users,
  // memberships, devices, pairing_tokens, device_auth). Keyed by the shell account, so it
  // routes by dbFor(accountId) at N=1; §6a splits it into two point reads (dirDb identity +
  // dbFor(shell) data) under real sharding.
  return dbFor(env, accountId)
    .prepare(
      `SELECT
         a.origin AS origin, a.plan AS plan, a.stripe_customer_id AS scid,
         a.stripe_subscription_id AS ssid, a.grace_until AS grace,
         a.extra_storage_bytes AS extra, a.used_bytes AS used,
         (SELECT COUNT(*) FROM account_keys WHERE account_id = ?1) AS ak,
         (SELECT COUNT(*) FROM device_keys WHERE account_id = ?1) AS dk,
         (SELECT COUNT(*) FROM rosters WHERE account_id = ?1) AS ro,
         (SELECT COUNT(*) FROM account_key_states WHERE account_id = ?1) AS aks,
         (SELECT COUNT(*) FROM workspace_keys WHERE account_id = ?1) AS wk,
         (SELECT COUNT(*) FROM devices WHERE account_id = ?1 AND expires_at IS NULL) AS durdev,
         (SELECT COUNT(*) FROM api_keys WHERE account_id = ?1) AS apik,
         (SELECT COUNT(*) FROM workspaces WHERE account_id = ?1) AS ws,
         (SELECT COUNT(*) FROM blob_refs WHERE account_id = ?1) AS br,
         (SELECT COUNT(*) FROM uploads WHERE account_id = ?1) AS up,
         (SELECT COUNT(*) FROM pairing_tokens WHERE account_id = ?1 AND consumed_at IS NULL AND expires_at > ?2) AS pt,
         (SELECT COUNT(*) FROM device_auth WHERE account_id = ?1 AND status IN ('pending','approved') AND expires_at > ?2) AS da,
         (SELECT COUNT(*) FROM device_notifications WHERE account_id = ?1) AS dn,
         (SELECT COUNT(*) FROM diagnostics_reports WHERE account_id = ?1) AS dr,
         (SELECT COUNT(*) FROM commits WHERE workspace_id IN (SELECT workspace_id FROM workspaces WHERE account_id = ?1)) AS cm,
         (SELECT COUNT(*) FROM clerk_users WHERE account_id = ?1) AS cu,
         (SELECT COUNT(*) FROM memberships WHERE account_id = ?1 AND role = 'owner') AS own
       FROM accounts a WHERE a.id = ?1`
    )
    .bind(accountId, nowMs)
    .first<ShellState>();
}

/** Pure predicate over a loaded `ShellState`. `ignoreBilling` skips ONLY the
 *  Stripe-controlled columns the re-point saga (§3.4.2) moves (plan, scid, ssid,
 *  grace, extra) — answering "is billing this shell's ONLY blocker?". `used_bytes`
 *  (real stored data) is checked regardless: a shell with data is never "only billing." */
function judgeReclaimable(r: ShellState | null, opts: { ignoreBilling?: boolean } = {}): boolean {
  if (!r) return false; // no such account row → not reclaimable (same as origin != 'web')
  if (r.origin !== "web") return false;
  if (Number(r.used) !== 0) return false;
  if (!opts.ignoreBilling && (r.plan !== "none" || r.scid != null || r.ssid != null || r.grace != null || Number(r.extra) !== 0)) return false;
  // `dr` (diagnostics_reports) blocks fail-closed: only DEVICE principals can create reports,
  // so a "web shell" holding one is not the empty shell this destructive path assumes.
  // `apik` (api_keys) likewise: keys are minted by device principals AND their devices rows
  // carry expires_at, so `durdev` alone would never see them.
  for (const k of ["ak", "dk", "ro", "aks", "wk", "durdev", "apik", "ws", "br", "up", "pt", "da", "dn", "cm", "dr"]) if (Number(r[k]) !== 0) return false;
  if (Number(r.cu) > 1 || Number(r.own) > 1) return false; // only this Clerk id + its one owner membership
  return true;
}

// ── unlink + status (Slice 5 / CLI surface) ──────────────────────────────────

/** POST /v1/account/unlink — AUTHED (OWNER on the linked account, durable or web).
 *  Rebinds C → a fresh empty 'web' shell so the Clerk user still has an account.
 *  Blocks if X carries Stripe state (never strand a subscription, §5.4). */
export async function unlinkAccount(env: Env, p: Principal, nowMs: number): Promise<Response> {
  if (p.role !== "owner") return json({ error: "forbidden", message: "unlink requires an owner" }, 403);
  // The Clerk mapping and the billing state are independent reads on p.accountId → concurrent.
  const [map, billing] = await Promise.all([
    dirDb(env).prepare("SELECT clerk_user_id, user_id FROM clerk_users WHERE account_id = ?").bind(p.accountId).first<{ clerk_user_id: string; user_id: string }>(),
    dbFor(env, p.accountId).prepare("SELECT stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = ?").bind(p.accountId).first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>(),
  ]);
  if (!map) return json({ error: "not_linked" }, 404);
  if (billing?.stripe_customer_id || billing?.stripe_subscription_id) return json({ error: "linked_account_has_billing" }, 409);

  const newAcct = `acct_${randomHex(8)}`;
  const newUser = `user_${randomHex(8)}`;
  // §32 FLAG (§6a): like confirmLink, this batch spans planes — a new account-data `accounts`
  // row (the fresh web shell) plus the directory-plane clerk_users rebind + users/memberships/
  // devices/account_link_events. One atomic batch at N=1; a future cross-plane saga under
  // sharding. Run on dirDb (the rebind is the headline); the accounts INSERT routes by newAcct.
  await dirDb(env).batch([
    // cap_bytes set explicitly so the new shell is quota-guarded immediately —
    // a 0 here would disable accounts_cap_guard (§30 codex BLOCKER 5). The 0016 AFTER INSERT
    // trigger is the catch-all backstop; this keeps the intent visible at the insert site.
    dbFor(env, newAcct).prepare("INSERT INTO accounts (id, name, plan, origin, created_at, cap_bytes) VALUES (?, 'web', 'none', 'web', ?, ?)").bind(newAcct, nowMs, 1),
    fairUseQueueStatement(dbFor(env, newAcct), newAcct, nowMs, "account_created"),
    dirDb(env).prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(newUser, newAcct, nowMs),
    dirDb(env).prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(newAcct, newUser),
    dirDb(env).prepare("UPDATE clerk_users SET account_id = ?, user_id = ? WHERE clerk_user_id = ? AND account_id = ?").bind(newAcct, newUser, map.clerk_user_id, p.accountId),
    // design 22 §4.3: rebinding clerk_users alone leaves the caller's already-minted
    // web_* token valid on X for up to its ~1h TTL — `authenticate()` resolves via
    // `devices`+`memberships`, INDEPENDENT of `clerk_users`. So in the SAME atomic
    // batch revoke the unlinked user's EPHEMERAL web sessions on X (never the durable
    // CLI devices: `expires_at IS NOT NULL`), closing the residual-access window.
    dirDb(env).prepare("UPDATE devices SET revoked = 1 WHERE account_id = ? AND user_id = ? AND expires_at IS NOT NULL").bind(p.accountId, map.user_id),
    dirDb(env).prepare("INSERT INTO account_link_events (clerk_user_id, from_account, to_account, method, actor_device, at) VALUES (?, ?, ?, 'unlink', ?, ?)").bind(map.clerk_user_id, p.accountId, newAcct, p.deviceId, nowMs),
  ]);
  return json({ ok: true, account: newAcct });
}

/** GET /v1/account/status — AUTHED. Whether a Clerk identity manages this account,
 *  plus the current plan tier so the CLI (`rbox status`) can show it at a glance.
 *  `clerk_users` is directory-plane; `accounts.plan` is account-data — each read
 *  routes through its own §32 seam (`dirDb` vs `dbFor`). */
export async function accountStatus(env: Env, p: Principal): Promise<Response> {
  const [row, acct] = await Promise.all([
    dirDb(env).prepare("SELECT clerk_user_id, email, signin_method FROM clerk_users WHERE account_id = ?").bind(p.accountId).first<{ clerk_user_id: string; email: string | null; signin_method: string | null }>(),
    dbFor(env, p.accountId).prepare("SELECT plan FROM accounts WHERE id = ?").bind(p.accountId).first<{ plan: string }>(),
  ]);
  return json({ accountId: p.accountId, linked: !!row, plan: acct?.plan ?? "none", email: row?.email ?? null, signInMethod: row?.signin_method ?? null });
}
