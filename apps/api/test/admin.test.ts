import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { adminOverview, computeAggregates, isAllowlisted, isJwksFresh, normalizeJwks, verifyAccessJwt } from "../src/admin.js";
import type { Env } from "../src/env.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TEAM = "https://rbox.cloudflareaccess.com";
const AUD = "test-access-aud";
const ALLOWED = "brian.a.via@gmail.com";

let jwks: string;
let signingKey: CryptoKey;
const KID = "test-kid-1";

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signingKey = kp.privateKey;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey & { kid?: string };
  pub.kid = KID;
  pub.alg = "RS256";
  jwks = JSON.stringify({ keys: [pub] });
});

// ── JWT signing helpers (mirror Cloudflare Access's RS256 app token) ──────────
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlStr = (s: string): string => b64url(new TextEncoder().encode(s));

async function signJwt(payload: Record<string, unknown>, kid = KID): Promise<string> {
  const h = b64urlStr(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64urlStr(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, signingKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: TEAM, aud: [AUD], exp: nowS() + 3600, email: ALLOWED, ...over };
}

const accessEnv = (): Env => Object.assign({}, env, { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, CF_ACCESS_JWKS: jwks }) as Env;

function reqWith(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token;
  return new Request("https://api.rbox.to/v1/admin/overview", { headers });
}

describe("admin route — Access JWT + allow-list authz (defense in depth)", () => {
  test("missing Access JWT → 401", async () => {
    const res = await adminOverview(reqWith(null), accessEnv());
    expect(res.status).toBe(401);
  });

  test("garbage / unsigned token → 401", async () => {
    expect((await adminOverview(reqWith("not-a-jwt"), accessEnv())).status).toBe(401);
    expect((await adminOverview(reqWith("a.b.c"), accessEnv())).status).toBe(401);
  });

  test("validly-signed JWT but email NOT allow-listed → 403", async () => {
    const token = await signJwt(claims({ email: "intruder@evil.test" }));
    const res = await adminOverview(reqWith(token), accessEnv());
    expect(res.status).toBe(403);
  });

  test("valid signature, allow-listed email, but wrong aud → 401", async () => {
    const token = await signJwt(claims({ aud: ["some-other-app"] }));
    expect((await adminOverview(reqWith(token), accessEnv())).status).toBe(401);
  });

  test("expired token → 401", async () => {
    const token = await signJwt(claims({ exp: nowS() - 60 }));
    expect((await adminOverview(reqWith(token), accessEnv())).status).toBe(401);
  });

  test("token signed by an UNKNOWN key (kid not in JWKS) → 401", async () => {
    const token = await signJwt(claims(), "rogue-kid");
    expect((await adminOverview(reqWith(token), accessEnv())).status).toBe(401);
  });

  test("unconfigured Access env (no team domain/aud) fail-closes → 401", async () => {
    const token = await signJwt(claims());
    const bare = Object.assign({}, env) as Env; // no CF_ACCESS_* set
    expect((await adminOverview(reqWith(token), bare)).status).toBe(401);
  });

  test("JWKS fetch failure (empty cache) fail-closes → 401 (never a 500)", async () => {
    // Team domain + aud are configured, but NO CF_ACCESS_JWKS override, so the verifier
    // must fetch certs from an unresolvable domain → that failure must NOT bubble a 500;
    // it must produce no signing key → 401. (A forged-but-claims-valid token must reject.)
    const token = await signJwt(claims());
    const noCerts = Object.assign({}, env, {
      CF_ACCESS_TEAM_DOMAIN: "https://nonexistent-team-rbox-test.cloudflareaccess.example",
      CF_ACCESS_AUD: AUD,
    }) as Env;
    const res = await adminOverview(reqWith(token), noCerts);
    expect(res.status).toBe(401);
  });

  test("(b) malformed JWKS body (keys not an array) → 401, never a 500", async () => {
    // Without normalization, the override path would hand a non-array `keys` to `.find`
    // and throw → adminOverview would reject (→ a 500 at the worker boundary). It must 401.
    const token = await signJwt(claims());
    const malformed = Object.assign({}, env, {
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: AUD,
      CF_ACCESS_JWKS: '{"keys":{"oops":"not-an-array"}}',
    }) as Env;
    const res = await adminOverview(reqWith(token), malformed);
    expect(res.status).toBe(401);
  });

  test("(b2) JWKS array with bad entries (null / kid-less) → 401, never a 500", async () => {
    const token = await signJwt(claims());
    for (const badKeys of ['{"keys":[null]}', '{"keys":[{"kty":"RSA"}]}', '{"keys":[null,42,"x"]}']) {
      const e = Object.assign({}, env, { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, CF_ACCESS_JWKS: badKeys }) as Env;
      const res = await adminOverview(reqWith(token), e);
      expect(res.status).toBe(401); // a null/kid-less entry must not deref k.kid → 500
    }
  });

  test("(a) past-TTL cache + failing refetch → no stale-key accept (null/401), but within-TTL transient failure still serves", async () => {
    // Live fetch path (no CF_ACCESS_JWKS override). Use a far-past base time so the cache
    // this test populates is always stale relative to real wall-clock → no cross-test leak.
    const live = Object.assign({}, env, { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }) as Env;
    const base = 1000; // seconds

    // 1) a successful certs fetch populates the cache (fetchedAt = base)
    globalThis.fetch = (async () => new Response(jwks, { status: 200 })) as typeof fetch;
    const ok = await verifyAccessJwt(live, await signJwt(claims({ exp: base + 3600 })), base);
    expect(ok?.email).toBe(ALLOWED);

    // 2) +2h later (past the 1h TTL) the refetch FAILS → must NOT serve the stale key → null
    globalThis.fetch = (async () => {
      throw new Error("JWKS outage");
    }) as typeof fetch;
    const stale = await verifyAccessJwt(live, await signJwt(claims({ exp: base + 7200 + 3600 })), base + 7200);
    expect(stale).toBeNull();

    // 3) a transient failure WITHIN the TTL still serves the cached key (acceptable tradeoff)
    const within = await verifyAccessJwt(live, await signJwt(claims({ exp: base + 60 + 3600 })), base + 60);
    expect(within?.email).toBe(ALLOWED);
  });

  test("allow-listed identity → 200 with the expected aggregate shape", async () => {
    const token = await signJwt(claims());
    const res = await adminOverview(reqWith(token), accessEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const k of ["totalAccounts", "activeDevices", "durableDevices", "storageUsedBytes", "activeSubscriptions", "subscriptionsByPlan", "mrrLiveCents", "signups", "generatedAt"]) {
      expect(body).toHaveProperty(k);
    }
    // No STRIPE_SECRET / CF_ANALYTICS_TOKEN in the test env → those degrade to null.
    expect(body.mrrStripeCents).toBeNull();
    expect(body.fiveXxRate).toBeNull();
    expect(body.signups).toHaveProperty("last24h");
  });
});

describe("isAllowlisted — exact, case-insensitive, single identity", () => {
  test("accepts only the one allow-listed address", () => {
    expect(isAllowlisted(ALLOWED)).toBe(true);
    expect(isAllowlisted("BRIAN.A.VIA@GMAIL.COM")).toBe(true); // case-insensitive
    expect(isAllowlisted(" brian.a.via@gmail.com ")).toBe(true); // trimmed
    expect(isAllowlisted("brian.a.via@gmail.com.evil.test")).toBe(false);
    expect(isAllowlisted("someone@else.test")).toBe(false);
    expect(isAllowlisted(null)).toBe(false);
    expect(isAllowlisted("")).toBe(false);
  });
});

describe("JWKS hardening helpers (fail-closed)", () => {
  test("normalizeJwks coerces any non-array to [] and drops bad entries (no k.kid deref 500)", () => {
    expect(normalizeJwks([{ kid: "a" }])).toHaveLength(1);
    expect(normalizeJwks({ oops: 1 })).toEqual([]);
    expect(normalizeJwks(null)).toEqual([]);
    expect(normalizeJwks(undefined)).toEqual([]);
    expect(normalizeJwks("keys")).toEqual([]);
    expect(normalizeJwks(42)).toEqual([]);
    // bad ENTRIES inside a real array are filtered out (null / non-object / kid-less)
    expect(normalizeJwks([null, 42, "x", { kty: "RSA" }])).toEqual([]);
    expect(normalizeJwks([null, { kid: "good" }, { kty: "RSA" }])).toHaveLength(1);
  });

  test("isJwksFresh: cache is trusted only within its TTL (stale → false)", () => {
    const ttl = 3_600_000;
    const cache = { keys: [], fetchedAt: 1_000_000 };
    expect(isJwksFresh(cache, 1_000_000 + 60_000, ttl)).toBe(true); // within TTL
    expect(isJwksFresh(cache, 1_000_000 + ttl - 1, ttl)).toBe(true); // edge, still fresh
    expect(isJwksFresh(cache, 1_000_000 + ttl + 1, ttl)).toBe(false); // past TTL → stale
    expect(isJwksFresh(null, 1_000_000, ttl)).toBe(false); // no cache
  });
});

describe("verifyAccessJwt — claim validation", () => {
  test("accepts a well-formed token and returns the email", async () => {
    const token = await signJwt(claims());
    const c = await verifyAccessJwt(accessEnv(), token, nowS());
    expect(c?.email).toBe(ALLOWED);
  });
  test("rejects a token whose iss is not our team domain", async () => {
    const token = await signJwt(claims({ iss: "https://evil.cloudflareaccess.com" }));
    expect(await verifyAccessJwt(accessEnv(), token, nowS())).toBeNull();
  });
});

describe("computeAggregates — correctness against seeded D1 (delta-based)", () => {
  test("counts new accounts, storage, devices, subs, and MRR by their delta", async () => {
    const now = Date.now();
    const before = await computeAggregates(env, now);

    // Seed two fresh accounts: one free (100 bytes, no sub), one on 'solo' with a sub
    // (200 bytes). One non-reclaimed each.
    const a1 = `acct_seed_${crypto.randomUUID().replace(/-/g, "")}`;
    const a2 = `acct_seed_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.rbox_dev_db.batch([
      env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at, used_bytes) VALUES (?, 'a1', 'free', ?, 100)").bind(a1, now),
      env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at, used_bytes, stripe_customer_id, stripe_subscription_id) VALUES (?, 'a2', 'solo', ?, 200, 'cus_seed', 'sub_seed')").bind(a2, now),
    ]);
    // Two devices on a1: one active (durable), one revoked.
    await env.rbox_dev_db.batch([
      env.rbox_dev_db.prepare("INSERT INTO devices (token_hash, device_id, account_id, created_at, revoked, expires_at) VALUES (?, 'dev_s1', ?, ?, 0, NULL)").bind(`th_${crypto.randomUUID()}`, a1, now),
      env.rbox_dev_db.prepare("INSERT INTO devices (token_hash, device_id, account_id, created_at, revoked, expires_at) VALUES (?, 'dev_s2', ?, ?, 1, NULL)").bind(`th_${crypto.randomUUID()}`, a1, now),
    ]);

    const after = await computeAggregates(env, now);
    expect(after.totalAccounts - before.totalAccounts).toBe(2);
    expect(after.storageUsedBytes - before.storageUsedBytes).toBe(300);
    expect(after.activeSubscriptions - before.activeSubscriptions).toBe(1);
    expect(after.activeDevices - before.activeDevices).toBe(1); // revoked one excluded
    expect(after.durableDevices - before.durableDevices).toBe(1);
    expect(after.signups.last24h - before.signups.last24h).toBe(2);
    expect(after.mrrLiveCents - before.mrrLiveCents).toBe(800); // one 'solo' sub × $8.00
  });

  test("device count excludes expired web sessions and devices on tombstoned accounts", async () => {
    const now = Date.now();
    const before = await computeAggregates(env, now);

    const live = `acct_dlive_${crypto.randomUUID().replace(/-/g, "")}`;
    const dead = `acct_ddead_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.rbox_dev_db.batch([
      env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at) VALUES (?, 'live', 'free', ?)").bind(live, now),
      env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at, reclaimed_at) VALUES (?, 'dead', 'free', ?, ?)").bind(dead, now, now),
    ]);
    await env.rbox_dev_db.batch([
      // live account: one durable CLI device, one LIVE web session, one EXPIRED web session
      env.rbox_dev_db.prepare("INSERT INTO devices (token_hash, device_id, account_id, created_at, revoked, expires_at) VALUES (?, 'dev_cli', ?, ?, 0, NULL)").bind(`th_${crypto.randomUUID()}`, live, now),
      env.rbox_dev_db.prepare("INSERT INTO devices (token_hash, device_id, account_id, created_at, revoked, expires_at) VALUES (?, 'dev_web_live', ?, ?, 0, ?)").bind(`th_${crypto.randomUUID()}`, live, now, now + 3_600_000),
      env.rbox_dev_db.prepare("INSERT INTO devices (token_hash, device_id, account_id, created_at, revoked, expires_at) VALUES (?, 'dev_web_exp', ?, ?, 0, ?)").bind(`th_${crypto.randomUUID()}`, live, now, now - 1_000),
      // tombstoned account: a non-revoked durable device that must NOT be counted
      env.rbox_dev_db.prepare("INSERT INTO devices (token_hash, device_id, account_id, created_at, revoked, expires_at) VALUES (?, 'dev_dead', ?, ?, 0, NULL)").bind(`th_${crypto.randomUUID()}`, dead, now),
    ]);

    const after = await computeAggregates(env, now);
    // active = durable CLI + live web session (expired web + dead-account device excluded)
    expect(after.activeDevices - before.activeDevices).toBe(2);
    // durable = the one live CLI device (dead-account durable excluded)
    expect(after.durableDevices - before.durableDevices).toBe(1);
  });

  test("tombstoned (reclaimed) accounts are excluded from totals", async () => {
    const now = Date.now();
    const before = await computeAggregates(env, now);
    const dead = `acct_dead_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.rbox_dev_db
      .prepare("INSERT INTO accounts (id, name, plan, created_at, used_bytes, reclaimed_at) VALUES (?, 'dead', 'free', ?, 999, ?)")
      .bind(dead, now, now)
      .run();
    const after = await computeAggregates(env, now);
    expect(after.totalAccounts - before.totalAccounts).toBe(0);
    expect(after.storageUsedBytes - before.storageUsedBytes).toBe(0);
  });
});
