import type { Env } from "./env.js";
import { json, logErr } from "./util.js";
import { PLAN_MONTHLY_CENTS } from "./plans.js";
import { dbFor, dirDb } from "./db.js";

/**
 * TIER 3a — platform-admin cockpit API (design §32). ONE read-only route,
 * `GET /v1/admin/overview`, returning aggregate platform health. This is the ONLY
 * surface with privileged, cross-account data access, so it is gated HARD and with
 * DEFENSE IN DEPTH — never relying on the Cloudflare Access edge policy alone:
 *
 *   1. verify the `Cf-Access-Jwt-Assertion` JWT (RS256, iss = team domain, aud =
 *      the Access app AUD, exp) against the Access certs JWKS, AND
 *   2. enforce an explicit email allow-list (exactly brian.a.via@gmail.com).
 *
 * Either check failing → reject (401 unverified / 403 not-allowlisted). The SPA at
 * admin.rbox.to (a SEPARATE Pages project with NO bindings) calls this and renders
 * the numbers; all privileged reads happen here, behind the gate.
 *
 * The aggregates are READ-ONLY: account/device/storage counts from D1, a D1-derived
 * MRR ESTIMATE alongside a live Stripe-reconciled figure, and a 5xx-rate pulled from
 * the Cloudflare GraphQL Analytics API. The external calls (Stripe, Analytics) are
 * best-effort + bounded — a failure degrades that one figure to null, never 500s.
 */

/** The exact identities allowed to read the cockpit. Hardcoded (not env-weakenable)
 *  so a misconfigured deploy can't silently widen access. */
const ADMIN_ALLOWLIST = ["brian.a.via@gmail.com"] as const;
const LEEWAY_S = 5;
const EXTERNAL_TIMEOUT_MS = 4000;

export function isAllowlisted(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  return ADMIN_ALLOWLIST.includes(e as (typeof ADMIN_ALLOWLIST)[number]);
}

// ── Cloudflare Access JWT verification (RS256, JWKS) ──────────────────────────

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToStr = (s: string): string => new TextDecoder().decode(b64urlToBytes(s));

interface JwksCache {
  keys: JsonWebKey[];
  fetchedAt: number;
}
let jwksCache: JwksCache | null = null;
let lastForcedFetch = 0;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MIN_MS = 30 * 1000; // throttle forced (unknown-kid) refetches (anti-DoS)

/** Coerce a parsed JWKS `keys` field to a list of well-formed key objects. A malformed
 *  body (keys is an object/string/null, …) becomes `[]`, AND any non-object / kid-less
 *  ENTRY (e.g. `{"keys":[null]}`) is dropped — so a bad JWKS shape can never reach the
 *  `.find` predicate's `k.kid` deref and throw a 500; it just yields no matching signing
 *  key → 401. Exported for direct testing. */
export function normalizeJwks(keys: unknown): JsonWebKey[] {
  if (!Array.isArray(keys)) return [];
  return keys.filter((k): k is JsonWebKey => !!k && typeof k === "object" && typeof (k as { kid?: unknown }).kid === "string");
}

/** Whether a cached JWKS may still be served: only while WITHIN its TTL. Past TTL it's
 *  stale and must NOT be trusted — a refetch failure then yields no keys (fail closed),
 *  so a revoked old signer can't be accepted during a JWKS outage. Exported for testing. */
export function isJwksFresh(cache: JwksCache | null, now: number, ttlMs: number): boolean {
  return !!cache && now - cache.fetchedAt < ttlMs;
}

/**
 * Resolve the Access signing keys. NEVER THROWS — fail-closed for auth: any fetch /
 * parse failure resolves to the WITHIN-TTL cache or `[]`, so verifyAccessJwt finds no
 * key → returns null → the route 401s (it must never bubble a 500, which would let a
 * forged-but-iss/aud/exp-valid token reach the error boundary instead of being rejected).
 *
 * Two hardenings: (1) a STALE (past-TTL) cache is never served on a refetch failure —
 * during a JWKS/CF-Access outage the privileged route goes UNAVAILABLE (401) rather than
 * accept a possibly-revoked signer; (2) the parsed `keys` is normalized to an array so a
 * malformed JWKS body can't throw. An unknown kid triggers AT MOST one throttled refetch.
 * `now` is injected so the TTL logic is deterministic (defaults to Date.now()).
 */
async function accessJwks(env: Env, force = false, now: number = Date.now()): Promise<JsonWebKey[]> {
  // Hermetic override (tests / pinned keys): use the provided JWKS verbatim (normalized).
  if (env.CF_ACCESS_JWKS) {
    try {
      return normalizeJwks((JSON.parse(env.CF_ACCESS_JWKS) as { keys?: unknown }).keys);
    } catch {
      return [];
    }
  }
  const fresh = isJwksFresh(jwksCache, now, JWKS_TTL_MS);
  if (!force && fresh) return jwksCache!.keys;
  // Forced (unknown-kid) refetch: at most once per JWKS_REFETCH_MIN_MS, and only serve
  // the cache meanwhile if it's STILL fresh — never a stale one.
  if (force && fresh && now - lastForcedFetch < JWKS_REFETCH_MIN_MS) return jwksCache!.keys;
  if (force) lastForcedFetch = now;
  try {
    const url = `${(env.CF_ACCESS_TEAM_DOMAIN ?? "").replace(/\/$/, "")}/cdn-cgi/access/certs`;
    const res = await fetch(url, { cf: { cacheTtl: 3600 } } as RequestInit);
    // Fail closed: serve the cache ONLY if still within TTL, else no keys (→ 401).
    if (!res.ok) return fresh ? jwksCache!.keys : [];
    const body = (await res.json()) as { keys?: unknown };
    jwksCache = { keys: normalizeJwks(body.keys), fetchedAt: now };
    return jwksCache.keys;
  } catch {
    return fresh ? jwksCache!.keys : []; // fetch/parse threw → within-TTL cache or [] (no 500, no stale)
  }
}

export interface AccessClaims {
  email: string;
}

/** Verify a Cloudflare Access application JWT. Returns claims on success, else null.
 *  Fail-closed: an unconfigured Access env (no team domain / aud) → null (never serves). */
export async function verifyAccessJwt(env: Env, token: string, nowS: number): Promise<AccessClaims | null> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return null; // not configured → fail closed
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: { iss?: unknown; aud?: unknown; exp?: unknown; email?: unknown };
  try {
    header = JSON.parse(b64urlToStr(h));
    payload = JSON.parse(b64urlToStr(p));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) return null;

  // Claims validated against SERVER constants (never the token's own values).
  if (payload.iss !== env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, "")) return null;
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(env.CF_ACCESS_AUD) : aud === env.CF_ACCESS_AUD;
  if (!audOk) return null;
  if (typeof payload.exp !== "number" || nowS > payload.exp + LEEWAY_S) return null;
  if (typeof payload.email !== "string" || payload.email.length === 0) return null;

  // Signature: match kid exactly (one forced refetch on miss), verify over raw segments.
  // `nowS*1000` drives the JWKS TTL so a stale cache is never served on a refetch failure.
  const nowMs = nowS * 1000;
  let key = (await accessJwks(env, false, nowMs)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!key) key = (await accessJwks(env, true, nowMs)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!key) return null;
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
  } catch {
    return null;
  }
  return { email: payload.email };
}

/** The gate result: `ok` with the verified email, or a reason → HTTP status. */
type Gate = { ok: true; email: string } | { ok: false; status: 401 | 403 };

async function gate(req: Request, env: Env, nowS: number): Promise<Gate> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion") ?? "";
  if (!token) return { ok: false, status: 401 };
  const claims = await verifyAccessJwt(env, token, nowS);
  if (!claims) return { ok: false, status: 401 };
  if (!isAllowlisted(claims.email)) return { ok: false, status: 403 }; // verified but not allowed
  return { ok: true, email: claims.email };
}

// ── aggregates ────────────────────────────────────────────────────────────────

export interface AdminAggregates {
  totalAccounts: number;
  signups: { last24h: number; last7d: number; last30d: number };
  activeDevices: number; // revoked = 0
  durableDevices: number; // revoked = 0 AND not a short-lived web session
  storageUsedBytes: number;
  activeSubscriptions: number;
  subscriptionsByPlan: Record<string, number>;
  mrrLiveCents: number; // D1-derived estimate (counts × list price)
}

/** All the D1-derived aggregates in a handful of grouped queries. Excludes
 *  tombstoned shells (`reclaimed_at IS NOT NULL`) from account/sub/storage counts. */
export async function computeAggregates(env: Env, now: number): Promise<AdminAggregates> {
  // §32 routing seam: the accounts/storage/signups/subscription aggregates are
  // ACCOUNT-DATA plane reads with no single account in scope (a global rollup), so
  // dbFor(env, ""); the device count is DIRECTORY plane (devices live there, beside
  // memberships/users). Its JOIN to `accounts` for liveness is cross-plane but a no-op
  // at N=1 (both resolve to the one binding) — a real sharding cutover revisits it.
  const acctDb = dbFor(env, "");
  const dir = dirDb(env);
  const d24 = now - 24 * 60 * 60 * 1000;
  const d7 = now - 7 * 24 * 60 * 60 * 1000;
  const d30 = now - 30 * 24 * 60 * 60 * 1000;

  const [accounts, devices, byPlan] = await Promise.all([
    acctDb
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS s24,
           COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS s7,
           COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS s30,
           COALESCE(SUM(used_bytes), 0) AS used,
           COALESCE(SUM(CASE WHEN stripe_subscription_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS subs
         FROM accounts WHERE reclaimed_at IS NULL`,
      )
      .bind(d24, d7, d30)
      .first<{ total: number; s24: number; s7: number; s30: number; used: number; subs: number }>(),
    dir
      .prepare(
        // Only devices on LIVE accounts (join + reclaimed_at IS NULL excludes
        // tombstoned shells), and only un-expired tokens — an expired web_* session
        // (`expires_at <= now`) is rejected by authenticate() so it must not count as
        // active. `durable` is the CLI subset (no expiry), so its liveness is implicit.
        `SELECT
           COALESCE(SUM(CASE WHEN d.revoked = 0 AND (d.expires_at IS NULL OR d.expires_at > ?) THEN 1 ELSE 0 END), 0) AS active,
           COALESCE(SUM(CASE WHEN d.revoked = 0 AND d.expires_at IS NULL THEN 1 ELSE 0 END), 0) AS durable
         FROM devices d JOIN accounts a ON a.id = d.account_id
         WHERE a.reclaimed_at IS NULL`,
      )
      .bind(now)
      .first<{ active: number; durable: number }>(),
    acctDb
      .prepare("SELECT plan, COUNT(*) AS n FROM accounts WHERE stripe_subscription_id IS NOT NULL AND reclaimed_at IS NULL GROUP BY plan")
      .all<{ plan: string; n: number }>(),
  ]);

  const subscriptionsByPlan: Record<string, number> = {};
  let mrrLiveCents = 0;
  for (const r of byPlan.results ?? []) {
    const n = Number(r.n ?? 0);
    subscriptionsByPlan[r.plan] = n;
    mrrLiveCents += n * (PLAN_MONTHLY_CENTS[r.plan] ?? 0);
  }

  return {
    totalAccounts: Number(accounts?.total ?? 0),
    signups: { last24h: Number(accounts?.s24 ?? 0), last7d: Number(accounts?.s7 ?? 0), last30d: Number(accounts?.s30 ?? 0) },
    activeDevices: Number(devices?.active ?? 0),
    durableDevices: Number(devices?.durable ?? 0),
    storageUsedBytes: Number(accounts?.used ?? 0),
    activeSubscriptions: Number(accounts?.subs ?? 0),
    subscriptionsByPlan,
    mrrLiveCents,
  };
}

// ── live Stripe-reconciled MRR (best-effort, bounded, never throws) ───────────

/** Sum the unit_amount × quantity of all ACTIVE Stripe subscription items, in cents.
 *  Returns null when STRIPE_SECRET is absent or any step fails (degraded figure). */
export async function fetchStripeMrrCents(env: Env): Promise<number | null> {
  if (!env.STRIPE_SECRET) return null;
  try {
    const url = "https://api.stripe.com/v1/subscriptions?status=active&limit=100&expand[]=data.items.data.price";
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET}` },
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ items?: { data?: Array<{ quantity?: number; price?: { unit_amount?: number } }> } }> };
    let cents = 0;
    for (const sub of body.data ?? []) {
      for (const item of sub.items?.data ?? []) {
        cents += (item.price?.unit_amount ?? 0) * (item.quantity ?? 1);
      }
    }
    return cents;
  } catch (e) {
    logErr("admin_stripe_mrr_failed", e);
    return null;
  }
}

// ── 5xx rate from the Cloudflare GraphQL Analytics API ────────────────────────

export interface FiveXxRate {
  windowMins: number;
  requests: number;
  errors: number;
  ratePct: number | null;
}

/** Query workersInvocationsAdaptive for the last hour and derive an error rate.
 *  A stateless tail can't judge an aggregate spike (Tier 2 note) — this cron/route
 *  query is where the 5xx-RATE actually lives. Best-effort: null on any failure. */
export async function fetchFiveXxRate(env: Env, now: number): Promise<FiveXxRate | null> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const windowMins = 60;
  const since = new Date(now - windowMins * 60 * 1000).toISOString();
  const script = env.CF_WORKER_NAME ?? "rbox-prod-api";
  const query = `query($tag:String!,$script:String!,$since:Time!){
    viewer { accounts(filter:{accountTag:$tag}) {
      workersInvocationsAdaptive(limit:10000, filter:{scriptName:$script, datetime_geq:$since}) {
        sum { requests errors }
      }
    } }
  }`;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { tag: env.CF_ACCOUNT_ID, script, since } }),
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number; errors?: number } }> }> } };
    };
    const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    let requests = 0;
    let errors = 0;
    for (const r of rows) {
      requests += r.sum?.requests ?? 0;
      errors += r.sum?.errors ?? 0;
    }
    return { windowMins, requests, errors, ratePct: requests > 0 ? (errors / requests) * 100 : null };
  } catch (e) {
    logErr("admin_5xx_rate_failed", e);
    return null;
  }
}

// ── server op-timing metrics from the Analytics Engine SQL API (§25 read path) ─

/** AE SQL timeout — a slow AE query must never hold the cockpit open. Shorter than
 *  the 4s GraphQL/Stripe bound because it fans out three statements in parallel. */
const AE_TIMEOUT_MS = 3000;

export interface ServerMetricsPerOp {
  op: string;
  ops: number;
  p50Ms: number;
  p99Ms: number;
  /** D1 (entitlement/accounting) time at p50 — the headline: for `blob.get` this is the
   *  ~80% of latency spent in D1, vs `r2P50` (R2 open time). */
  d1P50: number;
  r2P50: number;
}
export interface ServerMetrics {
  windowHours: number;
  /** Per-op volume + latency + the D1-vs-R2 split (the headline panel). */
  perOp: ServerMetricsPerOp[];
  /** Coarse outcome histogram (drives the 429/error-rate view; `too_many_refs`, `conflict`, …). */
  outcomes: Array<{ outcome: string; n: number }>;
  /** Commit-path latency percentiles (ok-only), null when no commits in the window. */
  commit: { p50Ms: number; p99Ms: number; commits: number } | null;
  generatedAt: number;
}

/** AE returns UInt64 counts as JSON strings and quantiles as numbers; coerce either to a
 *  finite number (NaN/undefined → 0) so the payload is always clean numerics. */
function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Run one AE SQL statement, returning its `data` rows. Throws on any non-2xx / parse
 *  failure so the caller's single try/catch can degrade the whole block to null. */
export async function aeSql(env: Env, token: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: sql,
    signal: AbortSignal.timeout(AE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ae_sql_${res.status}`);
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return body.data ?? [];
}

// ── design-102 shadow-soak gate ──────────────────────────────────────────────

export interface DeltaSoak {
  sinceHours: number;
  commitDelta: {
    divergence: { events: number; harmfulTotal: number };
    benignMarkerDivergence: { events: number; total: number };
    fallback: { byReason: Record<string, number>; total: number };
    highSeverity: { fence_violation: number; parent_unreadable: number; delta_error: number };
    admitStmts: { count: number; p50: number; p95: number };
    sizes: { count: number };
  };
  commits: { total: number };
}

type AeSql = typeof aeSql;

/** Read the numeric-only design-102 soak counters from the real positional AE schema.
 * Throws when AE rejects a query; the route converts that to analytics_unavailable. */
export async function fetchDeltaSoak(env: Env, sinceHours: number, query: AeSql = aeSql): Promise<DeltaSoak> {
  const token = env.CF_ANALYTICS_TOKEN!;
  const dataset = env.CF_METRICS_DATASET ?? (env.RBOX_ENV === "dev" ? "rbox_dev_metrics" : "rbox_prod_metrics");
  if (!/^[A-Za-z0-9_]+$/.test(dataset)) throw new Error("invalid_metrics_dataset");
  const win = `timestamp > NOW() - INTERVAL '${sinceHours}' HOUR`;

  const [summaryRows, admitRows, fallbackRows, severityRows, commitRows] = await Promise.all([
    query(
      env,
      token,
      `SELECT
         sumIf(_sample_interval, blob2 = 'divergence') AS divergence_events,
         sumIf(double2 * _sample_interval, blob2 = 'divergence') AS harmful_total,
         sumIf(_sample_interval, blob2 = 'benign_marker_divergence') AS benign_events,
         sumIf(double2 * _sample_interval, blob2 = 'benign_marker_divergence') AS benign_total,
         sumIf(_sample_interval, blob2 = 'sizes') AS sizes_count
       FROM ${dataset} WHERE index1 = 'commit.delta' AND ${win}`,
    ),
    query(
      env,
      token,
      `SELECT sum(_sample_interval) AS n,
         round(quantileExactWeighted(0.50)(double4, _sample_interval)) AS p50,
         round(quantileExactWeighted(0.95)(double4, _sample_interval)) AS p95
       FROM ${dataset} WHERE index1 = 'commit.delta' AND blob2 = 'admit_stmts' AND ${win}`,
    ),
    query(
      env,
      token,
      `SELECT blob3 AS reason, sum(_sample_interval) AS n
       FROM ${dataset} WHERE index1 = 'commit.delta' AND blob2 = 'fallback' AND ${win}
       GROUP BY reason ORDER BY reason`,
    ),
    query(
      env,
      token,
      `SELECT blob2 AS outcome, sum(_sample_interval) AS n
       FROM ${dataset} WHERE index1 = 'commit.delta'
         AND blob2 IN ('fence_violation', 'parent_unreadable', 'delta_error') AND ${win}
       GROUP BY outcome`,
    ),
    query(
      env,
      token,
      `SELECT sum(_sample_interval) AS total FROM ${dataset}
       WHERE blob1 = 'commit' AND blob3 = 'ok' AND ${win}`,
    ),
  ]);

  const summary = summaryRows[0] ?? {};
  const admit = admitRows[0] ?? {};
  const byReason: Record<string, number> = {};
  let fallbackTotal = 0;
  for (const row of fallbackRows) {
    const reason = String(row.reason ?? "");
    if (!reason) continue;
    const n = num(row.n);
    byReason[reason] = n;
    fallbackTotal += n;
  }
  const highSeverity = { fence_violation: 0, parent_unreadable: 0, delta_error: 0 };
  for (const row of severityRows) {
    const outcome = String(row.outcome ?? "") as keyof typeof highSeverity;
    if (outcome in highSeverity) highSeverity[outcome] = num(row.n);
  }

  return {
    sinceHours,
    commitDelta: {
      divergence: { events: num(summary.divergence_events), harmfulTotal: num(summary.harmful_total) },
      benignMarkerDivergence: { events: num(summary.benign_events), total: num(summary.benign_total) },
      fallback: { byReason, total: fallbackTotal },
      highSeverity,
      admitStmts: { count: num(admit.n), p50: num(admit.p50), p95: num(admit.p95) },
      sizes: { count: num(summary.sizes_count) },
    },
    commits: { total: num(commitRows[0]?.total) },
  };
}

/**
 * Server op-timing metrics for the cockpit (§25 read path). Runs the AE SQL queries that
 * surface per-op latency with the D1-vs-R2 split, the outcome histogram, and commit-path
 * percentiles over a rolling 24h window. BEST-EFFORT + BOUNDED, mirroring fetchFiveXxRate:
 * absent token/account or ANY query failure → null (the field is simply absent from
 * /overview), never a throw. The dimensions read here are already §25-privacy-safe
 * (op/route/outcome + numeric measures only — no ids/paths/hashes).
 */
export async function fetchServerMetrics(env: Env): Promise<ServerMetrics | null> {
  const token = env.CF_AE_TOKEN;
  if (!token || !env.CF_ACCOUNT_ID) return null;
  // Dataset name is interpolated into SQL; it's operator-set (never user input), but pin it
  // to an identifier charset so a stray value can't reshape the statement.
  const dataset = env.CF_METRICS_DATASET ?? "rbox_prod_metrics";
  if (!/^[A-Za-z0-9_]+$/.test(dataset)) return null;
  const windowHours = 24;
  const win = `timestamp > NOW() - INTERVAL '${windowHours}' HOUR`;
  try {
    const [perOpRows, outcomeRows, commitRows] = await Promise.all([
      aeSql(
        env,
        token,
        `SELECT blob1 AS op, sum(_sample_interval) AS ops,
           round(quantileWeighted(0.50)(double1,_sample_interval)) AS p50_ms,
           round(quantileWeighted(0.99)(double1,_sample_interval)) AS p99_ms,
           round(quantileWeighted(0.50)(double2,_sample_interval)) AS d1_p50,
           round(quantileWeighted(0.50)(double3,_sample_interval)) AS r2_p50
         FROM ${dataset} WHERE ${win} GROUP BY op ORDER BY ops DESC`,
      ),
      aeSql(env, token, `SELECT blob3 AS outcome, sum(_sample_interval) AS n FROM ${dataset} WHERE ${win} GROUP BY outcome ORDER BY n DESC`),
      aeSql(
        env,
        token,
        `SELECT round(quantileWeighted(0.50)(double1,_sample_interval)) AS p50_ms,
           round(quantileWeighted(0.99)(double1,_sample_interval)) AS p99_ms,
           sum(_sample_interval) AS commits
         FROM ${dataset} WHERE blob1 = 'commit' AND blob3 = 'ok' AND ${win}`,
      ),
    ]);

    const perOp: ServerMetricsPerOp[] = perOpRows.map((r) => ({
      op: String(r.op ?? ""),
      ops: num(r.ops),
      p50Ms: num(r.p50_ms),
      p99Ms: num(r.p99_ms),
      d1P50: num(r.d1_p50),
      r2P50: num(r.r2_p50),
    }));
    const outcomes = outcomeRows.map((r) => ({ outcome: String(r.outcome ?? ""), n: num(r.n) }));
    const c = commitRows[0];
    const commits = c ? num(c.commits) : 0;
    const commit = c && commits > 0 ? { p50Ms: num(c.p50_ms), p99Ms: num(c.p99_ms), commits } : null;

    return { windowHours, perOp, outcomes, commit, generatedAt: Date.now() };
  } catch (e) {
    logErr("admin_server_metrics_failed", e);
    return null;
  }
}

// ── the route ─────────────────────────────────────────────────────────────────

export interface AdminOverview extends AdminAggregates {
  mrrStripeCents: number | null;
  fiveXxRate: FiveXxRate | null;
  serverMetrics: ServerMetrics | null;
  generatedAt: number;
}

/** GET /v1/admin/overview — Access-gated + allow-listed; returns the read-only
 *  platform aggregates. Exported for direct unit testing of the authz + shape. */
export async function adminOverview(req: Request, env: Env, nowMs: number = Date.now()): Promise<Response> {
  const g = await gate(req, env, Math.floor(nowMs / 1000));
  if (!g.ok) return json({ error: g.status === 401 ? "unauthorized" : "forbidden" }, g.status);

  // D1 aggregates are authoritative + cheap; the two external figures are
  // best-effort and resolve to null on failure (already non-throwing), so one slow
  // dependency never blocks the others.
  const [aggregates, mrrStripeCents, fiveXxRate, serverMetrics] = await Promise.all([
    computeAggregates(env, nowMs),
    fetchStripeMrrCents(env),
    fetchFiveXxRate(env, nowMs),
    fetchServerMetrics(env),
  ]);

  const overview: AdminOverview = { ...aggregates, mrrStripeCents, fiveXxRate, serverMetrics, generatedAt: nowMs };
  return json(overview);
}
