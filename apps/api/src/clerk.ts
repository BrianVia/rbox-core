import type { Env } from "./env.js";
import { cappedJson, exactObject, json, utf8Bytes } from "./util.js";
import { capBytesFor } from "./plans.js";
import { AccountGoneError, createWebSession } from "./auth.js";
import { refreshOwnerEmail } from "./notify.js";
import { dbFor, dirDb } from "./db.js";
import { pingNewAccount } from "./slackpipes.js";
import { signinMethodsOf } from "./clerk-signin.js";
import { fairUseQueueStatement } from "./fairuse.js";

/**
 * Web auth via Clerk (M11). The browser signs in with Clerk and POSTs its
 * short-lived session JWT to /v1/web/session; we verify it (JWKS/RS256, exact
 * iss, exp/nbf, azp allowlist), map the Clerk user (sub) to an rbox account/user
 * (idempotent, orphan-free first-login), and return a SHORT-LIVED rbox web
 * session token. That token then drives the normal API via authenticate().
 *
 * No Clerk SDK — raw WebCrypto. Hardened per codex review: alg pinned to RS256,
 * exact kid match (no fallback key), token-supplied jku/x5u ignored, throttled
 * unknown-kid refetch, claims validated against server constants.
 */
const LEEWAY_S = 5;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MIN_MS = 30 * 1000; // throttle forced refetches (anti-amplification)

let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
let lastForcedFetch = 0;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToStr = (s: string): string => new TextDecoder().decode(b64urlToBytes(s));

function jwksUrl(env: Env): string {
  return env.CLERK_JWKS_URL || `${env.CLERK_ISSUER}/.well-known/jwks.json`;
}

async function getJwks(env: Env, force = false): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (!force && jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  // Throttle forced (unknown-kid) refetches so bogus kids can't hammer the JWKS endpoint.
  if (force && jwksCache && now - lastForcedFetch < JWKS_REFETCH_MIN_MS) return jwksCache.keys;
  if (force) lastForcedFetch = now;
  const res = await fetch(jwksUrl(env), { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`jwks fetch ${res.status}`);
  const body = (await res.json()) as { keys: JsonWebKey[] };
  jwksCache = { keys: body.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

export interface ClerkClaims {
  sub: string;
}

/** Verify a Clerk session JWT. Returns the claims on success, else null. */
export async function verifyClerkJWT(env: Env, token: string, nowS: number): Promise<ClerkClaims | null> {
  if (!env.CLERK_ISSUER) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string; typ?: string };
  let payload: { iss?: string; sub?: unknown; exp?: unknown; nbf?: unknown; azp?: unknown };
  try {
    header = JSON.parse(b64urlToStr(h));
    payload = JSON.parse(b64urlToStr(p));
  } catch {
    return null;
  }
  // Guard: JSON.parse can yield null/primitives (valid JSON) — property access on
  // those would throw (→ 500). Require both to be objects.
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;

  // Algorithm + kid pinning (reject alg:none / HS256 confusion; require a kid).
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) return null;
  // (Any token-supplied jku/x5u are simply never read — only our configured JWKS + kid.)

  // Claims, validated against SERVER constants (never the token's own iss).
  if (payload.iss !== env.CLERK_ISSUER) return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (typeof payload.exp !== "number" || nowS > payload.exp + LEEWAY_S) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || nowS < payload.nbf - LEEWAY_S)) return null;
  const allowed = (env.CLERK_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (typeof payload.azp !== "string" || !allowed.includes(payload.azp)) return null; // absent/unlisted azp → reject

  // Signature: match kid exactly (refetch once on miss), verify over raw segments.
  let key = (await getJwks(env)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!key) key = (await getJwks(env, true)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!key) return null;
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
  } catch {
    return null; // malformed key/signature → reject (never 500)
  }
  return { sub: payload.sub };
}

function randomId(prefix: string, bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** POST /v1/web/session { token } — PUBLIC. Verify Clerk JWT → rbox web session. */
export const WEB_SESSION_MAX_BYTES = 128 * 1024;
export function validateWebSessionBody(value: unknown): { token: string } | null {
  if (!exactObject(value, ["token"]) || typeof value.token !== "string") return null;
  if (utf8Bytes(value.token) > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token)) return null;
  return { token: value.token };
}

export async function webSession(req: Request, env: Env, nowMs: number, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  if (!env.CLERK_ISSUER) return json({ error: "web_auth_not_configured" }, 501);
  const parsed = await cappedJson(req, { maxBytes: WEB_SESSION_MAX_BYTES }, validateWebSessionBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const claims = await verifyClerkJWT(env, body.token, Math.floor(nowMs / 1000));
  if (!claims) return json({ error: "unauthorized" }, 401);
  const sub = claims.sub;

  // Already provisioned? A clerk_users row only ever exists AFTER the email gate
  // passed (below), so a returning user is known-verified — no re-check needed.
  let map = await dirDb(env)
    .prepare("SELECT account_id, user_id FROM clerk_users WHERE clerk_user_id = ?")
    .bind(sub)
    .first<{ account_id: string; user_id: string }>();
  const firstLogin = !map;

  if (!map) {
    // First provisioning. Gate on a verified email BEFORE creating anything — run
    // by EVERY concurrent first-login (it's an idempotent read), so the gate can't
    // be raced/bypassed by a "loser" that skips it. FAIL CLOSED: without the Clerk
    // secret we can't verify, so we refuse to provision (no unverified accounts).
    if (!env.CLERK_SECRET_KEY) return json({ error: "web_auth_not_configured" }, 501);
    // One Clerk fetch serves both the fail-closed email-verified GATE and the rich
    // signup ping (email + sign-in method) below — no second round-trip.
    const clerkUser = await fetchClerkUser(env, sub);
    if (!clerkUser.verified) return json({ error: "email_unverified" }, 403);
    // Claim the mapping (INSERT OR IGNORE = the single gate); only the won
    // candidate ids ever materialize, so a lost race never orphans an account.
    const candAcct = randomId("acct", 8);
    const candUser = randomId("user", 8);
    // Seed the email cache from the fetch the verified gate already paid for — the
    // design-16 refresh below skips first logins, and account-status/new-device
    // consumers shouldn't wait for a second login to see an address.
    // email_updated_at stays NULL ("seeded, never refreshed") so notify.ts's
    // returning-login refresh throttle behaves exactly as before this seed existed.
    await dirDb(env)
      .prepare("INSERT OR IGNORE INTO clerk_users (clerk_user_id, account_id, user_id, created_at, signin_method, signin_method_updated_at, email) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(sub, candAcct, candUser, nowMs, clerkUser.signInMethod, clerkUser.clerkUpdatedAt, clerkUser.email)
      .run();
    map = await dirDb(env)
      .prepare("SELECT account_id, user_id FROM clerk_users WHERE clerk_user_id = ?")
      .bind(sub)
      .first<{ account_id: string; user_id: string }>();
    if (!map) return json({ error: "internal" }, 500);

    // First-provision ONLY: materialize the web shell (origin='web', reclaimable —
    // design 21 §3.2). Gating this to `if (!map)` is load-bearing (§3.5): a
    // RETURNING login must NOT re-run the owner INSERT OR IGNORE, or — once this
    // Clerk id is linked to a real account X — every login would silently re-grant
    // owner on X (privilege resurrection). A returning login only resolves + mints.
    // cap_bytes = the materialized §23 hard-cap (kept in sync with the plan by the trigger).
    const accountDb = dbFor(env, map.account_id);
    const [acctIns] = await accountDb.batch([
      accountDb.prepare("INSERT OR IGNORE INTO accounts (id, name, plan, origin, created_at, cap_bytes) VALUES (?, 'web', 'none', 'web', ?, ?)")
        .bind(map.account_id, nowMs, capBytesFor("none")),
      fairUseQueueStatement(accountDb, map.account_id, nowMs, "account_created"),
    ]);
    // users/memberships are directory-plane (authenticate JOINs memberships, §32 §2).
    await dirDb(env).prepare("INSERT OR IGNORE INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(map.user_id, map.account_id, nowMs).run();
    await dirDb(env).prepare("INSERT OR IGNORE INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(map.account_id, map.user_id).run();
    // §32 Tier 1 business ping (best-effort, never throws/blocks) — a new tenant via
    // web first-login. Gate on the accounts INSERT actually creating the row: concurrent
    // first-logins all resolve to the SAME won account_id, so only the one whose
    // INSERT OR IGNORE materialized it (changes > 0) pings — the losers no-op + skip,
    // so a race doesn't emit duplicate "new account" alerts.
    // Rich fields are best-effort: a degraded Clerk fetch (email/method null) just omits
    // those segments. New web accounts are created locked (see the accounts INSERT above).
    if ((acctIns?.meta.changes ?? 0) > 0)
      pingNewAccount(ctx, env, {
        accountId: map.account_id,
        origin: "web",
        email: clerkUser.email,
        signInMethod: clerkUser.signInMethod,
        plan: "none",
      });
  }

  // Refresh the cached owner email for new-device-alert recipient resolution (design 16
  // §3.2), throttled (≤ once/24h) and NON-FATAL — a cache refresh, not the auth path. Only
  // on RETURNING logins: a first login already fetched Clerk for the verified-email gate
  // above, so re-fetching here would just double the round-trip; the cache fills on the
  // next login (or the consumer's live fallback) instead.
  if (!firstLogin) await refreshOwnerEmail(env, sub, nowMs).catch(() => {});

  // design 37: never mint a web session into a tombstoned account (a returning login whose
  // account is mid-deletion). First-login just created the account (live), so this only ever
  // rejects a returning login on a deleted account during its grace window.
  const live = await dbFor(env, map.account_id).prepare("SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NULL").bind(map.account_id).first();
  if (!live) return json({ error: "account_deleted", message: "this account has been deleted" }, 403);

  // design 37: the liveness read above is a fast-fail; the mint itself is liveness-COUPLED, so a
  // tombstone landing between the read and the device insert writes no row and throws here →
  // return the same clean "account deleted" rather than a 500.
  let token: string;
  try {
    ({ token } = await createWebSession(env, map.account_id, map.user_id));
  } catch (e) {
    if (e instanceof AccountGoneError) return json({ error: "account_deleted", message: "this account has been deleted" }, 403);
    throw e;
  }
  return json({ token, accountId: map.account_id });
}

/** Delete a Clerk user as part of account erasure (design 37 §4h). Idempotent +
 *  best-effort: a 404 (already gone) counts as success; any other non-2xx (or no
 *  CLERK_SECRET_KEY configured) returns false so the drain retries rather than leaving the
 *  identity behind. Deleting the user erases their PII at Clerk and signs them out
 *  everywhere. */
export async function deleteClerkUser(env: Env, sub: string): Promise<boolean> {
  if (!env.CLERK_SECRET_KEY) return false; // can't erase the identity → retry (fail loud, never silently skip)
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${sub}`, { method: "DELETE", headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    return res.ok || res.status === 404; // 404 = already deleted → idempotent success
  } catch {
    return false; // network/transient → retry
  }
}

/** The Clerk-user facts needed at provisioning time. `verified` is authoritative for the
 *  fail-closed gate; `email`/`signInMethod` are best-effort ping decoration (null when a
 *  degraded fetch can't determine them — never blocks provisioning). */
interface ClerkUserFacts {
  verified: boolean;
  email: string | null;
  signInMethod: string | null;
  clerkUpdatedAt: number | null;
}

/** Fetch the Clerk user once for the provisioning gate + signup ping. FAIL CLOSED on the
 *  gate (any error ⇒ verified:false ⇒ provisioning refused); the ping fields degrade to
 *  null on the same failures rather than throwing. */
async function fetchClerkUser(env: Env, sub: string): Promise<ClerkUserFacts> {
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${sub}`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    if (!res.ok) return { verified: false, email: null, signInMethod: null, clerkUpdatedAt: null };
    const u = (await res.json()) as {
      email_addresses?: Array<{ id: string; email_address?: string; verification?: { status?: string } }>;
      primary_email_address_id?: string;
      external_accounts?: Array<{ provider?: string; verification?: { status?: string } }>;
      password_enabled?: boolean;
      updated_at?: number;
    };
    const primary = u.email_addresses?.find((e) => e.id === u.primary_email_address_id) ?? u.email_addresses?.[0];
    const verified = primary?.verification?.status === "verified" && typeof u.updated_at === "number";
    return { verified, email: (verified && primary?.email_address) || null, signInMethod: signinMethodsOf(u), clerkUpdatedAt: u.updated_at ?? null };
  } catch {
    return { verified: false, email: null, signInMethod: null, clerkUpdatedAt: null }; // fail closed on provisioning
  }
}
