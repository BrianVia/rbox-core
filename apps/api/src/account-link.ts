import type { Env } from "./env.js";
import type { Principal } from "./authz.js";
import { json, sha256Hex } from "./util.js";
import { verifyClerkJWT } from "./clerk.js";

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

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function toB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomHex(bytes: number): string {
  return [...randomBytes(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
}

// ── phase: START ─────────────────────────────────────────────────────────────

/** POST /v1/account/link/start — PUBLIC. Fresh Clerk JWT in body. Mint a code
 *  bound to the re-proven Clerk identity C and C's CURRENT account (origin). */
export async function startLink(req: Request, env: Env, nowMs: number): Promise<Response> {
  if (!env.CLERK_ISSUER) return json({ error: "web_auth_not_configured" }, 501);
  const body = (await req.json().catch(() => ({}))) as { clerkToken?: unknown };
  if (typeof body.clerkToken !== "string") return json({ error: "unauthorized" }, 401);
  const claims = await verifyClerkJWT(env, body.clerkToken, Math.floor(nowMs / 1000));
  if (!claims) return json({ error: "unauthorized" }, 401);
  const c = claims.sub;

  // Require an existing web mapping — the dashboard always exchanges /v1/web/session
  // first, so origin_account (NOT NULL) is well-defined (design 21 §4.1, finding 11).
  const map = await env.rbox_dev_db.prepare("SELECT account_id FROM clerk_users WHERE clerk_user_id = ?").bind(c).first<{ account_id: string }>();
  if (!map) return json({ error: "web_session_required" }, 409);

  const secret = toB64url(randomBytes(32));
  const codeHash = await sha256Hex(secret);
  const pollKey = `plk_${randomHex(16)}`;
  const expiresAt = nowMs + LINK_TTL_MS;
  // Atomic active-code cap per Clerk id (mirrors the pairing cap, auth.ts) — a
  // single INSERT…SELECT…WHERE count<cap, so concurrent starts can't both pass.
  const res = await env.rbox_dev_db
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
  if (p.kind !== "durable") return json({ error: "forbidden", message: "link redeem requires a durable CLI device token" }, 403);
  if (p.role !== "owner" || !p.userId) return json({ error: "forbidden", message: "link redeem requires an owner device" }, 403);
  const code = rawCode.startsWith(LINK_PREFIX) ? rawCode.slice(LINK_PREFIX.length) : rawCode;
  if (!CODE_RE.test(code)) return json({ error: "unauthorized" }, 401);
  const hash = await sha256Hex(code);
  const now = Date.now();
  const consumed = await env.rbox_dev_db
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
  const row = await env.rbox_dev_db
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

  const code = await env.rbox_dev_db
    .prepare("SELECT clerk_user_id, origin_account, pending_account, pending_user, pending_device, consumed_at, committed_at, expires_at FROM account_link_codes WHERE poll_key = ?")
    .bind(pollKey)
    .first<CodeRow>();
  if (!code || code.clerk_user_id !== c) return json({ error: "not_found" }, 404);
  const x = code.pending_account;
  const cur = await env.rbox_dev_db.prepare("SELECT account_id FROM clerk_users WHERE clerk_user_id = ?").bind(c).first<{ account_id: string }>();

  // Idempotent re-confirm: already committed to X and C still maps X → success.
  if (code.committed_at && cur?.account_id === x) return json({ account: x });
  if (!code.consumed_at || code.committed_at || !x || !code.pending_user) return json({ error: "conflict" }, 409); // not pending / already committed elsewhere
  if (nowMs > code.expires_at) return json({ error: "expired" }, 401);
  if (!cur || cur.account_id !== code.origin_account) return json({ error: "conflict" }, 409); // concurrent move off origin

  // Reclaim/guard decision over C's CURRENT account (the origin shell).
  let reclaimNeeded = false;
  if (cur.account_id !== x) {
    const curOrigin = (await env.rbox_dev_db.prepare("SELECT origin FROM accounts WHERE id = ?").bind(cur.account_id).first<{ origin: string | null }>())?.origin ?? null;
    if (curOrigin === "web") {
      reclaimNeeded = true;
      if (!(await isReclaimableShell(env, cur.account_id, nowMs))) return json({ error: "origin_account_has_state" }, 409);
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
  const stmts = [
    env.rbox_dev_db
      .prepare(`UPDATE clerk_users SET account_id = ?, user_id = ? WHERE clerk_user_id = ? AND account_id = ? AND ${codeValid}`)
      .bind(x, code.pending_user, c, code.origin_account, pollKey, nowMs, x),
    env.rbox_dev_db.prepare(`UPDATE account_link_codes SET committed_at = ? WHERE poll_key = ? AND committed_at IS NULL AND ${landed}`).bind(nowMs, pollKey, c, x),
    env.rbox_dev_db
      .prepare(`INSERT INTO account_link_events (clerk_user_id, from_account, to_account, method, actor_device, at) SELECT ?, ?, ?, 'cli_link', ?, ? WHERE ${landed}`)
      .bind(c, code.origin_account, x, code.pending_device, nowMs, c, x),
  ];
  if (reclaimNeeded) {
    const shell = cur.account_id;
    stmts.push(
      env.rbox_dev_db.prepare(`UPDATE accounts SET reclaimed_at = ? WHERE id = ? AND ${orphan}`).bind(nowMs, shell, shell),
      env.rbox_dev_db.prepare(`DELETE FROM memberships WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      env.rbox_dev_db.prepare(`DELETE FROM users WHERE account_id = ? AND ${orphan}`).bind(shell, shell),
      env.rbox_dev_db.prepare(`DELETE FROM devices WHERE account_id = ? AND expires_at IS NOT NULL AND ${orphan}`).bind(shell, shell)
    );
  }
  try {
    await env.rbox_dev_db.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) return json({ error: "already_linked" }, 409); // X already mapped by another Clerk id
    throw e;
  }
  const after = await env.rbox_dev_db.prepare("SELECT account_id FROM clerk_users WHERE clerk_user_id = ?").bind(c).first<{ account_id: string }>();
  if (after?.account_id !== x) return json({ error: "conflict" }, 409); // rebind guard no-op'd (concurrent move)
  return json({ account: x });
}

/**
 * A web shell is reclaimable iff EXHAUSTIVELY empty (design 21 §3.4): origin='web',
 * no row in any account-scoped STATE table, and no non-default billing/entitlement
 * value. `commits` has no account_id → checked via the workspaces join. Append-only
 * forensic logs (audit_log, account_link_events) are deliberately EXCLUDED.
 */
async function isReclaimableShell(env: Env, accountId: string, nowMs: number): Promise<boolean> {
  const r = await env.rbox_dev_db
    .prepare(
      `SELECT
         (SELECT origin FROM accounts WHERE id = ?1) AS origin,
         (SELECT plan FROM accounts WHERE id = ?1) AS plan,
         (SELECT stripe_customer_id FROM accounts WHERE id = ?1) AS scid,
         (SELECT stripe_subscription_id FROM accounts WHERE id = ?1) AS ssid,
         (SELECT grace_until FROM accounts WHERE id = ?1) AS grace,
         (SELECT extra_storage_bytes FROM accounts WHERE id = ?1) AS extra,
         (SELECT used_bytes FROM accounts WHERE id = ?1) AS used,
         (SELECT COUNT(*) FROM account_keys WHERE account_id = ?1) AS ak,
         (SELECT COUNT(*) FROM device_keys WHERE account_id = ?1) AS dk,
         (SELECT COUNT(*) FROM rosters WHERE account_id = ?1) AS ro,
         (SELECT COUNT(*) FROM account_key_states WHERE account_id = ?1) AS aks,
         (SELECT COUNT(*) FROM workspace_keys WHERE account_id = ?1) AS wk,
         (SELECT COUNT(*) FROM devices WHERE account_id = ?1 AND expires_at IS NULL) AS durdev,
         (SELECT COUNT(*) FROM workspaces WHERE account_id = ?1) AS ws,
         (SELECT COUNT(*) FROM blob_refs WHERE account_id = ?1) AS br,
         (SELECT COUNT(*) FROM uploads WHERE account_id = ?1) AS up,
         (SELECT COUNT(*) FROM pairing_tokens WHERE account_id = ?1 AND consumed_at IS NULL AND expires_at > ?2) AS pt,
         (SELECT COUNT(*) FROM device_auth WHERE account_id = ?1 AND status IN ('pending','approved') AND expires_at > ?2) AS da,
         (SELECT COUNT(*) FROM commits WHERE workspace_id IN (SELECT workspace_id FROM workspaces WHERE account_id = ?1)) AS cm,
         (SELECT COUNT(*) FROM clerk_users WHERE account_id = ?1) AS cu,
         (SELECT COUNT(*) FROM memberships WHERE account_id = ?1 AND role = 'owner') AS own`
    )
    .bind(accountId, nowMs)
    .first<Record<string, number | string | null>>();
  if (!r) return false;
  if (r.origin !== "web") return false;
  if (r.plan !== "free" || r.scid != null || r.ssid != null || r.grace != null || Number(r.extra) !== 0 || Number(r.used) !== 0) return false;
  for (const k of ["ak", "dk", "ro", "aks", "wk", "durdev", "ws", "br", "up", "pt", "da", "cm"]) if (Number(r[k]) !== 0) return false;
  if (Number(r.cu) > 1 || Number(r.own) > 1) return false; // only this Clerk id + its one owner membership
  return true;
}

// ── unlink + status (Slice 5 / CLI surface) ──────────────────────────────────

/** POST /v1/account/unlink — AUTHED (OWNER on the linked account, durable or web).
 *  Rebinds C → a fresh empty 'web' shell so the Clerk user still has an account.
 *  Blocks if X carries Stripe state (never strand a subscription, §5.4). */
export async function unlinkAccount(env: Env, p: Principal, nowMs: number): Promise<Response> {
  if (p.role !== "owner") return json({ error: "forbidden", message: "unlink requires an owner" }, 403);
  const map = await env.rbox_dev_db.prepare("SELECT clerk_user_id FROM clerk_users WHERE account_id = ?").bind(p.accountId).first<{ clerk_user_id: string }>();
  if (!map) return json({ error: "not_linked" }, 404);
  const billing = await env.rbox_dev_db
    .prepare("SELECT stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = ?")
    .bind(p.accountId)
    .first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>();
  if (billing?.stripe_customer_id || billing?.stripe_subscription_id) return json({ error: "linked_account_has_billing" }, 409);

  const newAcct = `acct_${randomHex(8)}`;
  const newUser = `user_${randomHex(8)}`;
  await env.rbox_dev_db.batch([
    env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, origin, created_at) VALUES (?, 'web', 'free', 'web', ?)").bind(newAcct, nowMs),
    env.rbox_dev_db.prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(newUser, newAcct, nowMs),
    env.rbox_dev_db.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(newAcct, newUser),
    env.rbox_dev_db.prepare("UPDATE clerk_users SET account_id = ?, user_id = ? WHERE clerk_user_id = ? AND account_id = ?").bind(newAcct, newUser, map.clerk_user_id, p.accountId),
    env.rbox_dev_db.prepare("INSERT INTO account_link_events (clerk_user_id, from_account, to_account, method, actor_device, at) VALUES (?, ?, ?, 'unlink', ?, ?)").bind(map.clerk_user_id, p.accountId, newAcct, p.deviceId, nowMs),
  ]);
  return json({ ok: true, account: newAcct });
}

/** GET /v1/account/status — AUTHED. Whether a Clerk identity manages this account. */
export async function accountStatus(env: Env, p: Principal): Promise<Response> {
  const row = await env.rbox_dev_db.prepare("SELECT clerk_user_id FROM clerk_users WHERE account_id = ?").bind(p.accountId).first<{ clerk_user_id: string }>();
  return json({ accountId: p.accountId, linked: !!row });
}
