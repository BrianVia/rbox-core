import type { Env } from "./env.js";
import { json } from "./util.js";
import { createWebSession } from "./auth.js";

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
export async function webSession(req: Request, env: Env, nowMs: number): Promise<Response> {
  if (!env.CLERK_ISSUER) return json({ error: "web_auth_not_configured" }, 501);
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  if (typeof body.token !== "string") return json({ error: "unauthorized" }, 401);
  const claims = await verifyClerkJWT(env, body.token, Math.floor(nowMs / 1000));
  if (!claims) return json({ error: "unauthorized" }, 401);
  const sub = claims.sub;

  // Already provisioned? A clerk_users row only ever exists AFTER the email gate
  // passed (below), so a returning user is known-verified — no re-check needed.
  let map = await env.rbox_dev_db
    .prepare("SELECT account_id, user_id FROM clerk_users WHERE clerk_user_id = ?")
    .bind(sub)
    .first<{ account_id: string; user_id: string }>();

  if (!map) {
    // First provisioning. Gate on a verified email BEFORE creating anything — run
    // by EVERY concurrent first-login (it's an idempotent read), so the gate can't
    // be raced/bypassed by a "loser" that skips it. FAIL CLOSED: without the Clerk
    // secret we can't verify, so we refuse to provision (no unverified accounts).
    if (!env.CLERK_SECRET_KEY) return json({ error: "web_auth_not_configured" }, 501);
    if (!(await clerkEmailVerified(env, sub))) return json({ error: "email_unverified" }, 403);
    // Claim the mapping (INSERT OR IGNORE = the single gate); only the won
    // candidate ids ever materialize, so a lost race never orphans an account.
    const candAcct = randomId("acct", 8);
    const candUser = randomId("user", 8);
    await env.rbox_dev_db
      .prepare("INSERT OR IGNORE INTO clerk_users (clerk_user_id, account_id, user_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(sub, candAcct, candUser, nowMs)
      .run();
    map = await env.rbox_dev_db
      .prepare("SELECT account_id, user_id FROM clerk_users WHERE clerk_user_id = ?")
      .bind(sub)
      .first<{ account_id: string; user_id: string }>();
    if (!map) return json({ error: "internal" }, 500);
  }

  // Ensure account/user/membership exist for the resolved ids (idempotent; also
  // self-heals partial provisioning and guarantees membership before minting).
  await env.rbox_dev_db.prepare("INSERT OR IGNORE INTO accounts (id, name, plan, created_at) VALUES (?, 'web', 'free', ?)").bind(map.account_id, nowMs).run();
  await env.rbox_dev_db.prepare("INSERT OR IGNORE INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(map.user_id, map.account_id, nowMs).run();
  await env.rbox_dev_db.prepare("INSERT OR IGNORE INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(map.account_id, map.user_id).run();

  const { token } = await createWebSession(env, map.account_id, map.user_id);
  return json({ token, accountId: map.account_id });
}

async function clerkEmailVerified(env: Env, sub: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${sub}`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    if (!res.ok) return false;
    const u = (await res.json()) as { email_addresses?: Array<{ id: string; verification?: { status?: string } }>; primary_email_address_id?: string };
    const primary = u.email_addresses?.find((e) => e.id === u.primary_email_address_id) ?? u.email_addresses?.[0];
    return primary?.verification?.status === "verified";
  } catch {
    return false; // fail closed on provisioning
  }
}
