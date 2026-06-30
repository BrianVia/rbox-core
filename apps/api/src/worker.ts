/**
 * rbox dev control plane.
 *
 *  - blobs: content-addressed in R2 (see blobs.ts). Single streaming PUT with
 *    R2-native sha verification up to ~90MiB; resumable R2 multipart above that
 *    (M3). No large object is buffered in the Worker.
 *  - manifests: commit/latest/connect delegated to the WorkspaceSync Durable
 *    Object (D2/M1) — authoritative sequencer + live notification fanout.
 *  - top-level error boundary turns thrown Responses into real responses.
 *
 * Dev-harness shortcut (documented): auth is a shared bearer token (M4 replaces).
 */
import type { DeviceNotifyMessage, Env } from "./env.js";
import { blobsCheck, blobGet, blobPut, multipartComplete, multipartInit, multipartPart, multipartStatus } from "./blobs.js";
import { accountDevices, accountWorkspaces, approveDeviceAuth, authenticate, bootstrap, createPairToken, listDevices, pollDeviceAuth, redeemPairToken, revokeDevice, startDeviceAuth } from "./auth.js";
import { gcMark, gcPurge, versionsList } from "./versions.js";
import { admitDevice, appendKeyState, appendRoster, bootstrapAccountKeys, getAccountKeys, getWorkspaceKeys, putDeviceKeys, putWorkspaceKey } from "./keys.js";
import { retentionPrune } from "./retention.js";
import { billingCheckout, billingPortal, stripeWebhook } from "./stripe.js";
import { webSession } from "./clerk.js";
import { accountStatus, confirmLink, linkStatus, redeemLink, startLink, unlinkAccount } from "./account-link.js";
import { json, logErr, SHA256_HEX_RE as SHA_RE } from "./util.js";
import { authorizeWorkspace, createWorkspace, isPlatform } from "./authz.js";
import { adminSetPlan, countWorkspaces, planLimitsFor, usage } from "./billing.js";
import { startOp } from "./metrics.js";
import { processNotification, sweepNotifications } from "./notify.js";
export { WorkspaceSync } from "./workspace-sync.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);
    // CORS preflight: the browser dashboard sends OPTIONS before any cross-origin
    // authed request (Authorization/content-type headers make it non-simple).
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    // Wrap env's D1 for the whole request (via op.env) so pre-DO work (authz,
    // account-epoch lookups in route()) is timed + counted into the `request` row.
    // Per-op handlers (blobs.ts) wrap again → their row counts their own D1; the
    // overlap with `request` is intended (request = total worker-side D1).
    const op = startOp(env, "request", `${req.method} ${routeTemplate(new URL(req.url).pathname)}`);
    let res: Response;
    try {
      res = await route(req, op.env);
    } catch (e) {
      if (e instanceof Response) res = e; // thrown 4xx flows out as itself
      else {
        logErr("unhandled", e); // no raw message/stack (may carry user metadata)
        res = jsonResponse({ error: "internal" }, 500);
      }
    }
    op.done(String(res.status));
    // Echo CORS headers on the real response (incl. errors) so the browser fetch
    // resolves instead of failing opaque. No-op when Origin isn't allowlisted.
    if (cors["Access-Control-Allow-Origin"]) {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  },
  /**
   * Scheduled GC (cron). Plan-driven retention prune → mark → purge, in order:
   * retention sets each workspace's prune floor from its account's plan, mark
   * tags now-unreachable canonical objects past a grace window, purge deletes
   * those still unreachable (and decrements usage). Idempotent + fail-safe; a
   * thrown phase is logged and the next run retries.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      await retentionPrune(env);
      // §23 (direct-write): the destructive canonical GC (gcMark/gcPurge, which R2-deletes
      // blob objects) is OFF the cron — it races a concurrent direct PUT (R2 has no
      // conditional delete). Canonical dedup-GC is deferred to a separate quiescent sweep
      // (run manually via /v1/admin/gc while no push is active). (codex scaling review.)
    } catch (e) {
      logErr("scheduled_gc_failed", e); // no raw message (GC touches account/blob metadata)
    }
    try {
      // New-device-email backstop (design 16 §2.4): re-drive outbox rows whose enqueue was
      // lost + pending/failed deliveries, and purge delivered PII. Separate try so a GC
      // failure above never starves the security-alert sweep (and vice-versa).
      await sweepNotifications(env);
    } catch (e) {
      logErr("scheduled_notify_sweep_failed", e); // no raw message (touches device/account metadata)
    }
  },

  /**
   * New-device-email queue consumer (design 16 §2.4). Each message carries only a
   * credential `token_hash`; the authoritative state is the D1 outbox row, which
   * `processNotification` reads, resolves to owners, and delivers per-recipient (the
   * per-delivery atomic claim/lease makes at-least-once redelivery send at most once).
   * `ack()` on success; `retry()` on an UNEXPECTED throw (per-recipient transient
   * failures are already recorded as `failed` inside, to be re-driven by queue+cron).
   */
  async queue(batch: MessageBatch<DeviceNotifyMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processNotification(env, msg.body.tokenHash);
        msg.ack();
      } catch (e) {
        logErr("device_notify_consume_failed", e);
        msg.retry();
      }
    }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/health") return jsonResponse({ ok: true, service: "rbox-api" });

  // ---- Public release distribution (design 14), served from the SEPARATE
  // rbox_releases bucket. Never cache a 404 (a cached 404 could mask a just-
  // published object on the edge — design 14 U7).
  const releaseNotFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  // `curl -fsSL https://api.rbox.to/install.sh | sh`
  if (url.pathname === "/install.sh" && req.method === "GET") {
    const obj = await env.rbox_releases.get("releases/install.sh");
    if (!obj) return releaseNotFound();
    return new Response(obj.body, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  // The signed release manifest + its detached signature (no-cache; `rbox upgrade`
  // verifies the signature against an embedded key before trusting it).
  if ((url.pathname === "/version" || url.pathname === "/version.sig") && req.method === "GET") {
    const key = url.pathname === "/version" ? "releases/version.json" : "releases/version.json.sig";
    const obj = await env.rbox_releases.get(key);
    if (!obj) return releaseNotFound();
    const type = url.pathname === "/version" ? "application/json" : "text/plain; charset=utf-8";
    return new Response(obj.body, { headers: { "content-type": type, "cache-control": "no-cache" } });
  }
  // Binaries: `/bin/rbox-<os>-<arch>` (mutable "latest" alias, short cache — for
  // install.sh only) OR `/bin/v<ver>/rbox-<os>-<arch>` (immutable versioned — what
  // `rbox upgrade` downloads from the signed manifest). Name/version validated.
  if (seg[0] === "bin" && req.method === "GET" && (seg.length === 2 || seg.length === 3)) {
    const versioned = seg.length === 3;
    const ver = versioned ? seg[1]! : null;
    const name = versioned ? seg[2]! : seg[1]!;
    if (!/^rbox-(darwin|linux)-(arm64|x64)$/.test(name)) return releaseNotFound();
    if (versioned && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ver!)) return releaseNotFound();
    const obj = await env.rbox_releases.get(versioned ? `releases/${ver}/${name}` : `releases/${name}`);
    if (!obj) return releaseNotFound();
    const cacheControl = versioned ? "public, max-age=31536000, immutable" : "public, max-age=300";
    return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="rbox"`, "cache-control": cacheControl } });
  }

  // Platform-only internal op (M7): GC requires the PLATFORM secret, NOT a tenant
  // device token. roots/prune are not exposed by the public router (GC calls the DO directly).
  if (req.method === "POST" && eq(seg, ["v1", "admin", "gc"])) {
    if (!isPlatform(req, env)) return jsonResponse({ error: "not_found" }, 404);
    const phase = url.searchParams.get("phase");
    // Plan-driven retention: set per-workspace prune floors from each account's
    // tier; mark/purge then reclaim. Operational order: retention → mark → purge.
    if (phase === "retention") return retentionPrune(env);
    const graceMs = Number(url.searchParams.get("graceMs") ?? String(60 * 60 * 1000));
    return phase === "purge" ? gcPurge(env, graceMs) : gcMark(env, graceMs);
  }
  // POST /v1/admin/account/:id/plan?plan=pro&extraGB=N (platform secret; interim until Stripe).
  if (req.method === "POST" && seg.length === 5 && seg[0] === "v1" && seg[1] === "admin" && seg[2] === "account" && seg[4] === "plan") {
    if (!isPlatform(req, env)) return jsonResponse({ error: "not_found" }, 404);
    return adminSetPlan(env, seg[3]!, url.searchParams.get("plan") ?? "free", Number(url.searchParams.get("extraGB") ?? "0"));
  }

  // Public auth endpoints (EXACT routes only — start the device-authorization flow).
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "start"])) return startDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "poll"])) return pollDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "bootstrap"])) return bootstrap(req, env);
  // Pairing redeem is PUBLIC (the pasted token IS the credential) — exact route.
  if (req.method === "POST" && eq(seg, ["v1", "auth", "pair", "redeem"])) return redeemPairToken(req, env);
  // Stripe webhook is PUBLIC but signature-verified (exact route).
  if (req.method === "POST" && eq(seg, ["v1", "stripe", "webhook"])) return stripeWebhook(req, env, Date.now());
  // Web auth: exchange a Clerk session JWT for an rbox web session (PUBLIC, exact).
  if (req.method === "POST" && eq(seg, ["v1", "web", "session"])) return webSession(req, env, Date.now());

  // Account linking (design 21) — start/status/confirm are PUBLIC: authenticated by
  // a re-verified Clerk JWT (in body, or the Authorization header for the GET), NOT
  // an rbox bearer, so they sit before authenticate() and outside the §1.1 gate.
  if (req.method === "POST" && eq(seg, ["v1", "account", "link", "start"])) return startLink(req, env, Date.now());
  if (req.method === "GET" && eq(seg, ["v1", "account", "link", "status"])) return linkStatus(req, env, Date.now(), url.searchParams.get("pollKey") ?? "");
  if (req.method === "POST" && eq(seg, ["v1", "account", "link", "confirm"])) return confirmLink(req, env, Date.now());

  // Everything else requires a valid (non-revoked) device token → full Principal.
  const p = await authenticate(req, env);
  if (!p) throw jsonResponse({ error: "unauthorized" }, 401);

  // DEFAULT-DENY token-kind route gate (design 21 §1.1): a short-lived browser
  // `web` session may touch ONLY the exact-match allowlist below. Everything else —
  // crucially the credential-mint routes (`pair/create`, `device/approve`,
  // `POST /v1/workspaces`) and all crypto/sync surfaces — is 403, so a web token
  // can never escalate into a durable credential and bypass the E2EE ceiling.
  if (p.kind === "web" && !webTokenAllowed(req.method, seg)) {
    return jsonResponse({ error: "forbidden", message: "web session not permitted on this route" }, 403);
  }

  // Account ops (scoped to the caller's account).
  if (req.method === "POST" && eq(seg, ["v1", "auth", "pair", "create"])) return createPairToken(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "billing", "checkout"])) return billingCheckout(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "billing", "portal"])) return billingPortal(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "approve"])) return approveDeviceAuth(req, env, p);
  if (req.method === "GET" && eq(seg, ["v1", "auth", "devices"])) return listDevices(env, p);
  if (isDeviceRevoke(req.method, seg)) return revokeDevice(env, p, seg[3]!);
  if (req.method === "GET" && eq(seg, ["v1", "account", "usage"])) return usage(env, p);
  // design 22 §2: the web-facing devices/workspaces lists (camelCase, secret-free).
  if (req.method === "GET" && eq(seg, ["v1", "account", "devices"])) return accountDevices(env, p, url);
  if (req.method === "GET" && eq(seg, ["v1", "account", "workspaces"])) return accountWorkspaces(env, p, url);
  // Account linking — AUTHED rbox-bearer routes (under the §1.1 web-token gate).
  if (req.method === "POST" && eq(seg, ["v1", "account", "link", "redeem"])) {
    const b = (await req.json().catch(() => ({}))) as { code?: unknown };
    return redeemLink(env, p, typeof b.code === "string" ? b.code : "");
  }
  if (req.method === "POST" && eq(seg, ["v1", "account", "unlink"])) return unlinkAccount(env, p, Date.now());
  if (req.method === "GET" && eq(seg, ["v1", "account", "status"])) return accountStatus(env, p);
  if (req.method === "POST" && eq(seg, ["v1", "workspaces"])) {
    const limits = await planLimitsFor(env, p.accountId); // workspace-count quota (M7b)
    if ((await countWorkspaces(env, p.accountId)) >= limits.workspaces) {
      return jsonResponse({ error: "quota_exceeded", limit: "workspaces", cap: limits.workspaces }, 402);
    }
    return createWorkspace(env, p, url.searchParams.get("project") ?? "root");
  }

  // E2EE opaque key storage (design 12) — all authed + account-scoped via Principal.
  // The server is zero-knowledge: it stores/serves these blobs verbatim, never decrypts.
  if (seg[0] === "v1" && seg[1] === "keys") {
    if (req.method === "POST" && eq(seg, ["v1", "keys", "bootstrap"])) return bootstrapAccountKeys(env, p, await req.json().catch(() => ({})));
    if (req.method === "GET" && eq(seg, ["v1", "keys", "account"])) return getAccountKeys(env, p);
    if (req.method === "POST" && eq(seg, ["v1", "keys", "device"])) return putDeviceKeys(env, p, await req.json().catch(() => ({})));
    if (req.method === "POST" && eq(seg, ["v1", "keys", "roster"])) return appendRoster(env, p, await req.json().catch(() => ({})));
    // C5: atomic device-keys + roster append (admission) in one D1 batch.
    if (req.method === "POST" && eq(seg, ["v1", "keys", "admit"])) return admitDevice(env, p, await req.json().catch(() => ({})));
    if (req.method === "POST" && eq(seg, ["v1", "keys", "keystate"])) return appendKeyState(env, p, await req.json().catch(() => ({})));
    if (req.method === "POST" && eq(seg, ["v1", "keys", "workspace"])) return putWorkspaceKey(env, p, await req.json().catch(() => ({})));
    if (req.method === "GET" && seg.length === 4 && seg[2] === "workspace") return getWorkspaceKeys(env, p, seg[3]!);
  }

  // POST /v1/blobs/check — entitlement-scoped to the caller's account.
  if (req.method === "POST" && eq(seg, ["v1", "blobs", "check"])) return blobsCheck(req, env, SHA_RE, p.accountId);

  // /v1/blobs/:sha[...] — all entitlement-gated by p.accountId.
  if (seg[0] === "v1" && seg[1] === "blobs" && seg.length >= 3) {
    const sha = seg[2]!;
    if (!SHA_RE.test(sha)) throw badRequest("invalid sha256");
    if (seg.length === 3) {
      if (req.method === "PUT") return blobPut(req, env, sha, p.accountId);
      if (req.method === "GET") return blobGet(env, sha, p.accountId);
    }
    if (seg[3] === "multipart") {
      const uploadId = seg[4];
      if (seg.length === 4 && req.method === "POST") return multipartInit(req, env, sha, p.accountId);
      if (seg.length === 5 && uploadId && req.method === "GET") return multipartStatus(env, sha, uploadId, p.accountId);
      if (seg.length === 7 && uploadId && seg[5] === "part" && req.method === "PUT") return multipartPart(req, env, sha, uploadId, Number(seg[6]), p.accountId);
      if (seg.length === 6 && uploadId && seg[5] === "complete" && req.method === "POST") return multipartComplete(env, sha, uploadId, p.accountId);
    }
  }

  // /v1/ws/:ws/proj/:proj/... — authorize (cross-account → 404) before any access.
  if (seg[0] === "v1" && seg[1] === "ws" && seg[3] === "proj" && seg.length >= 6) {
    const ws = seg[2]!;
    const proj = seg[4]!;
    const action = seg[5]!;
    const write = action === "manifests" && req.method === "POST"; // commit
    const az = await authorizeWorkspace(env, p, ws, proj, write);
    if (!az.ok) return jsonResponse({ error: az.status === 403 ? "forbidden" : "not_found" }, az.status);

    if (seg.length === 6 && action === "versions" && req.method === "GET") {
      return versionsList(env, ws, proj, Number(url.searchParams.get("limit") ?? "50"));
    }
    if (action === "manifests" || action === "latest" || action === "connect" || action === "commits") {
      const stub = env.WORKSPACE_SYNC.get(env.WORKSPACE_SYNC.idFromName(`${ws}/${proj}`));
      if (write) {
        // Commit: forward with the authenticated account (DO does account-scoped
        // blob-existence). Clean header set by the Worker (overrides any client value).
        const headers = new Headers(req.headers);
        headers.set("x-rbox-account", p.accountId);
        // C4: also forward the account's CURRENT key epoch (MAX(account_epoch), 0 if
        // none); the DO asserts the commit's accountEpoch == this inside the txn.
        const epochRow = await env.rbox_dev_db
          .prepare("SELECT MAX(account_epoch) AS epoch FROM account_key_states WHERE account_id = ?")
          .bind(p.accountId)
          .first<{ epoch: number | null }>();
        headers.set("x-rbox-account-epoch", String(epochRow?.epoch ?? 0));
        return stub.fetch(new Request(req, { headers }));
      }
      return stub.fetch(req);
    }
  }

  return jsonResponse({ error: "not_found" }, 404);
}

// ---- helpers ------------------------------------------------------------

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `POST /v1/auth/devices/:deviceId/revoke` — a wildcard route (`:deviceId`) `eq`
 *  can't express, so it has its own matcher used by BOTH the dispatcher and the
 *  web-token allowlist (kept in one place so the two never drift). */
function isDeviceRevoke(method: string, seg: string[]): boolean {
  return method === "POST" && seg.length === 5 && eq([seg[0]!, seg[1]!, seg[2]!, seg[4]!], ["v1", "auth", "devices", "revoke"]);
}

/**
 * Collapse a request path into a low-cardinality, id-free template for telemetry
 * (design doc §5: route templates, params stripped — never raw paths/ids in
 * metric dimensions). ALLOWLIST design, deliberately: only the known static
 * vocabulary of this router passes through; EVERYTHING else is masked. A blocklist
 * of id prefixes is fragile (we mint `acct_`/`user_`/`dev_`/`web_`/`ws_`/`pair_`,
 * and any new prefix would silently leak); an allowlist can't leak an unknown id
 * shape, a user-chosen project name, or an arbitrary unmatched path segment, and
 * it bounds dimension cardinality. e.g.
 * `/v1/ws/ws_ab12/proj/my-dir/manifests/42` → `/v1/ws/:ws/proj/:proj/manifests/:n`.
 * Exported for tests — this privacy contract is load-bearing for the whole layer.
 */
const ROUTE_VOCAB = new Set([
  "v1", "health", "install.sh", "version", "version.sig", "bin",
  "auth", "device", "start", "poll", "bootstrap", "approve", "devices", "revoke", "pair", "create", "redeem",
  "billing", "checkout", "portal", "stripe", "webhook", "web", "session",
  "account", "usage", "admin", "gc", "plan", "workspaces",
  "keys", "roster", "admit", "keystate", "workspace",
  "blobs", "check", "multipart", "part", "complete",
  "ws", "proj", "manifests", "latest", "connect", "commits", "versions", "roots", "prune",
]);
export function routeTemplate(pathname: string): string {
  const parts = pathname.split("/");
  // The project id is the ONE fully user-chosen segment that can spell a vocab word
  // (a project literally named "latest"/"manifests"/even "proj"). Its slot is fixed
  // by the grammar `/v1/ws/:ws/proj/:proj/…`, so pin it by INDEX — using the raw
  // previous string would wrongly clobber the action after a project named "proj".
  const projIdx = parts[2] === "ws" && parts[4] === "proj" ? 5 : -1;
  const masked = parts.map((s, i) => {
    if (s === "") return s;
    if (i === projIdx) return ":proj"; // before the allowlist so a vocab-named project can't leak
    if (ROUTE_VOCAB.has(s)) return s;
    // Release distribution (public, non-sensitive but variable): version + binary.
    if (/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(s)) return ":ver";
    if (/^rbox-(darwin|linux)-(arm64|x64)$/.test(s)) return ":bin";
    if (/^\d+$/.test(s)) return ":n";
    if (/^[0-9a-f]{64}$/.test(s)) return ":sha";
    // Unknown ⇒ dynamic/user-influenced. Label by position for readable dashboards,
    // but ALWAYS to a placeholder — the raw value never survives. (`proj` handled above.)
    switch (parts[i - 1]) {
      case "ws":
      case "workspace": return ":ws";
      case "blobs": return ":sha";
      case "multipart": return ":uploadId";
      case "account":
      case "devices": return ":id";
      default: return ":x";
    }
  });
  return masked.join("/");
}

/**
 * The EXACT (method, path) pairs a `kind=='web'` token may reach (design 21 §1.1).
 * Intentionally NOT a `GET /v1/account/*` wildcard — a future account GET must be
 * added here deliberately, never exposed to the browser by path accident. The
 * PUBLIC link routes (start/status/confirm) aren't here because they carry no rbox
 * Principal (they're verified by Clerk JWT before authenticate, §4.1).
 */
function webTokenAllowed(method: string, seg: string[]): boolean {
  if (method === "GET" && (eq(seg, ["v1", "account", "usage"]) || eq(seg, ["v1", "account", "status"]))) return true;
  if (method === "POST" && (eq(seg, ["v1", "billing", "checkout"]) || eq(seg, ["v1", "billing", "portal"]))) return true;
  if (method === "GET" && eq(seg, ["v1", "auth", "devices"])) return true;
  // design 22 §2.4: the new web-facing reads — exact pairs, NOT a GET /v1/account/* wildcard.
  if (method === "GET" && (eq(seg, ["v1", "account", "devices"]) || eq(seg, ["v1", "account", "workspaces"]))) return true;
  if (isDeviceRevoke(method, seg)) return true;
  if (method === "POST" && eq(seg, ["v1", "account", "link", "redeem"])) return true; // self-rejects on its own kind=='durable' check
  if (method === "POST" && eq(seg, ["v1", "account", "unlink"])) return true; // a web owner may unlink (§5.4)
  return false;
}
function badRequest(message: string): Response {
  return jsonResponse({ error: "bad_request", message }, 400);
}

/**
 * CORS for the web dashboard. The browser dashboard (app.rbox.to in prod,
 * localhost in dev) calls this API cross-origin, so its authed fetches need CORS
 * headers plus an OPTIONS preflight. We reflect ONLY Origins on the
 * CLERK_ALLOWED_ORIGINS allowlist — the same trusted web origins enforced as the
 * Clerk JWT `azp`. CLI clients send no Origin and get no CORS headers (unchanged).
 * Auth is via Bearer token, not cookies, so Allow-Credentials is intentionally
 * omitted.
 */
function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin) return {};
  const allowed = (env.CLERK_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const jsonResponse = json; // worker uses jsonResponse; shared impl is util.json
