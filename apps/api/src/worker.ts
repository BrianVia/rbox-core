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
 *
 * This file is the THIN entry: env plumbing (fetch/scheduled/queue), the route
 * dispatch, and the shared cross-cutting helpers (route-template telemetry, the
 * web-token gate, CORS). The per-domain matchers live in ./routes/* — each a
 * `(ctx[, p]) => Promise<Response | null>` group called below in the SAME order as
 * the original if-chain (first match wins). The order is load-bearing for the
 * documented overlapping-prefix cases; see ./routes/shared.ts.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AccountDeleteMessage, DeviceNotifyMessage, Env, WorkerEntrypointExports } from "./env.js";
import { authenticate } from "./auth.js";
import { blobBatchGetWithVerifiedGrant } from "./blob-batch.js";
import { blobGetWithVerifiedGrant } from "./blobs.js";
import { runPhase1 } from "./gc-phase1.js";
import { retentionPrune } from "./retention.js";
import { gcMark, gcPurge } from "./versions.js";
import { sweepDiagnostics } from "./diagnostics.js";
import { json, logErr, SHA256_HEX_RE } from "./util.js";
import { startOp } from "./metrics.js";
import { processNotification, sweepNotifications } from "./notify.js";
import { driveAccountDeletion, sweepAccountDeletions } from "./account-delete.js";
import { verifyGrantCredential } from "./grants.js";
import { eq, isDeviceRevoke, type RouteCtx } from "./routes/shared.js";
import { cachedReleaseResponse, releaseRoutes } from "./routes/release.js";
import { adminRoutes } from "./routes/admin.js";
import { authDeviceRoutes, authPublicRoutes } from "./routes/auth.js";
import { billingRoutes, billingWebhookRoutes } from "./routes/billing.js";
import { webRoutes } from "./routes/web.js";
import { accountLinkPublicRoutes, accountRoutes } from "./routes/account.js";
import { keysRoutes } from "./routes/keys.js";
import { blobsRoutes } from "./routes/blobs.js";
import { blobBatchRoutes } from "./routes/blob-batch.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { syncRoutes } from "./routes/sync.js";
export { WorkspaceSync } from "./workspace-sync.js";

export class CachedReleases extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    return cachedReleaseResponse(new URL(req.url), this.env);
  }
}

// §33 GRACE_1: the Phase-1 mark→purge grace. Sized to exceed the slowest in-flight
// FIRST PUBLISH, not the slowest commit: a 123k-file/17GB workspace uploads for
// hours with ZERO commit roots, so every grant looks unreachable until the first
// commit anchors it. At 1h the hourly cron marked 71,742 in-flight grants and
// forced a full re-upload (live incident, 2026-07-07 — the founder's ~/Development
// first publish Sisyphus'd against this all night). 24h keeps GC's leak-closing
// purpose (over-cap partials, abandoned uploads) while never racing a real push;
// the durable fix, if ever needed, is a granted_at keepalive on active sessions.
const GRACE_1_MS = 24 * 60 * 60 * 1000;
export const GC_MARK_UTC_HOUR = 8;
export const GC_PURGE_UTC_HOUR = 9;
export const GC_PHASE2_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { exports: WorkerEntrypointExports }): Promise<Response> {
    const cors = corsHeaders(req, env);
    // CORS preflight: the browser dashboard sends OPTIONS before any cross-origin
    // authed request (Authorization/content-type headers make it non-simple).
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "cache-control": "no-store" } });
    // Wrap env's D1 for the whole request (via op.env) so pre-DO work (authz,
    // account-epoch lookups in route()) is timed + counted into the `request` row.
    // Per-op handlers (blobs.ts) wrap again → their row counts their own D1; the
    // overlap with `request` is intended (request = total worker-side D1).
    const op = startOp(env, "request", `${req.method} ${routeTemplate(new URL(req.url).pathname)}`);
    let res: Response;
    try {
      res = await route(req, op.env, ctx.exports);
    } catch (e) {
      if (e instanceof Response) res = e; // thrown 4xx flows out as itself
      else {
        logErr("unhandled", e); // no raw message/stack (may carry user metadata)
        res = jsonResponse({ error: "internal" }, 500);
      }
    }
    op.done(String(res.status));
    // WebSocket upgrades cannot be re-wrapped; pass the DO fanout path through.
    if (res.status === 101 || res.webSocket) return res;
    // Echo CORS headers on the real response (incl. errors) and default-deny
    // cacheability for non-release responses (design 70).
    const needsCors = Boolean(cors["Access-Control-Allow-Origin"]);
    const needsCacheControl = !res.headers.has("cache-control");
    if (needsCors || needsCacheControl) {
      const h = new Headers(res.headers);
      if (needsCors) for (const [k, v] of Object.entries(cors)) h.set(k, v);
      if (needsCacheControl) h.set("cache-control", "no-store");
      res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  },
  /**
   * Hourly scheduling is keyed to the platform-provided scheduledTime: 08 UTC runs
   * bounded mark; 09 UTC runs fenced P2/P3 then P1 intent stamping; the other 22
   * ticks run regular maintenance. Design 95's publication fence and check-time-
   * anchored receipts make canonical deletion cron-safe. The rollout switch gates
   * only the 09 UTC cron executor; mark and the admin escape hatch stay live.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (hour === GC_MARK_UTC_HOUR) {
      try {
        await gcMark(env, GC_PHASE2_GRACE_MS, event.scheduledTime);
      } catch (e) {
        logErr("scheduled_gc_mark_failed", e);
      }
      return;
    }
    if (hour === GC_PURGE_UTC_HOUR) {
      if (env.RBOX_GC_PURGE_DISABLED !== "1") {
        try {
          // Hour selection is scheduledTime-keyed; lease TTLs and intent stamps use
          // invocation time so a delayed cron delivery cannot create an already-stale lease.
          await gcPurge(env, GC_PHASE2_GRACE_MS);
        } catch (e) {
          logErr("scheduled_gc_purge_failed", e);
        }
      }
      return;
    }
    try {
      // Retention precedes Phase 1 (a just-pruned version's now-unreachable refs become
      // visible to the mark). retentionPrune FAILS CLOSED on the first unreadable DO `/prune`
      // (retention.ts) — so it gets its OWN try: a single broken workspace must NOT skip
      // Phase 1 for every other account (that would defeat §33's per-account isolation;
      // codex round-2). Any workspace left un-pruned just keeps its old floor → its refs stay
      // reachable → not collected this cycle → retried next run.
      await retentionPrune(env);
    } catch (e) {
      logErr("scheduled_retention_failed", e); // no raw message (touches account/workspace metadata)
    }
    try {
      // §33 Phase 1: per-account entitlement prune (closes the design 30 §3 / 07b §d
      // `used_bytes` leak) + reconciler. GRACE_1 = 24h (protects long first publishes).
      // D1-only → cron-safe with the candidate-aware commit barrier. Itself per-account
      // fail-closed (one broken DO aborts only that account) — kept in its OWN try so a
      // retention failure above can't starve it.
      await runPhase1(env, GRACE_1_MS);
    } catch (e) {
      logErr("scheduled_phase1_failed", e); // no raw message (GC touches account/blob metadata)
    }
    try {
      // New-device-email backstop (design 16 §2.4): re-drive outbox rows whose enqueue was
      // lost + pending/failed deliveries, and purge delivered PII. Separate try so a GC
      // failure above never starves the security-alert sweep (and vice-versa).
      await sweepNotifications(env);
    } catch (e) {
      logErr("scheduled_notify_sweep_failed", e); // no raw message (touches device/account metadata)
    }
    try {
      // Diagnostics reports are explicitly plaintext support bundles. Keep the R2/D1
      // TTL tight and bounded per tick; failed item deletes leave their D1 handle for retry.
      await sweepDiagnostics(env);
    } catch (e) {
      logErr("scheduled_diagnostics_sweep_failed", e);
    }
    try {
      // Account-deletion backstop (design 37 §7): hard-purge every account whose grace
      // window has elapsed, in bounded re-entrant chunks (the durable `account_deletions`
      // ledger is the source of truth). Separate try so it never starves / is starved by
      // the sweeps above.
      await sweepAccountDeletions(env);
    } catch (e) {
      logErr("scheduled_account_delete_sweep_failed", e); // no raw message (touches account metadata)
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
  async queue(batch: MessageBatch<DeviceNotifyMessage | AccountDeleteMessage>, env: Env): Promise<void> {
    // Dispatch by queue name — both consumers share this one handler (design 37 §7 reuses
    // the design-16 shape). The message bodies are disjoint; we route on `batch.queue`.
    if (batch.queue.includes("account-delete")) {
      for (const msg of batch.messages as Message<AccountDeleteMessage>[]) {
        try {
          const res = await driveAccountDeletion(env, msg.body.accountId);
          msg.ack();
          // Prompt continuation: re-enqueue only while a chunk made progress (lease
          // released). "blocked"/"skip"/"done" stop the loop; the cron backstop re-drives
          // a blocked (external-outage) row later.
          if (res === "progress" && env.ACCOUNT_DELETE_Q) await env.ACCOUNT_DELETE_Q.send({ accountId: msg.body.accountId }).catch((e) => logErr("account_delete_reenqueue_failed", e));
        } catch (e) {
          logErr("account_delete_consume_failed", e);
          msg.retry();
        }
      }
      return;
    }
    for (const msg of batch.messages as Message<DeviceNotifyMessage>[]) {
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

/**
 * Route dispatch. Groups are tried in the SAME order as the original if-chain
 * (first non-null Response wins), with authenticate() + the §1.1 web-token gate
 * splicing the public groups from the authed ones. Precedence is load-bearing for
 * the documented overlapping-prefix cases (e.g. blobs/check before blobs/:sha);
 * exact-match routes across groups are mutually exclusive.
 */
async function route(req: Request, env: Env, exports: WorkerEntrypointExports): Promise<Response> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean);
  const ctx: RouteCtx = { req, env, exports, url, seg };

  if (url.pathname === "/health") return jsonResponse({ ok: true, service: "rbox-api" });

  // ---- PUBLIC groups (before authenticate) ----
  let r: Response | null;
  if ((r = await releaseRoutes(ctx))) return r;
  if ((r = await adminRoutes(ctx))) return r;
  if ((r = await authPublicRoutes(ctx))) return r;
  if ((r = await billingWebhookRoutes(ctx))) return r;
  if ((r = await webRoutes(ctx))) return r;
  if ((r = await accountLinkPublicRoutes(ctx))) return r;

  // §27 Amendment A + §77 P1: a valid download grant is the narrow credential for
  // exactly `GET /v1/blobs/:sha` and `POST /v1/blob-batch/get`. Ordering is
  // load-bearing: verify MAC/TTL first, derive the account id only from the
  // verified grant, and on ANY failure fall through to the normal authenticate()
  // path. Do not move the rest of blobsRoutes pre-auth: check, PUT, and multipart
  // still require a live bearer token.
  const isGrantBlobGet = req.method === "GET" && seg.length === 3 && seg[0] === "v1" && seg[1] === "blobs" && SHA256_HEX_RE.test(seg[2]!);
  const isGrantBlobBatchGet = req.method === "POST" && eq(seg, ["v1", "blob-batch", "get"]);
  if (isGrantBlobGet || isGrantBlobBatchGet) {
    const grant = req.headers.get("x-rbox-download-grant");
    if (grant) {
      const verified = await verifyGrantCredential(env, grant, { nowMs: Date.now() });
      if (verified.ok) {
        if (isGrantBlobGet) return blobGetWithVerifiedGrant(env, seg[2]!, verified.accountId);
        return blobBatchGetWithVerifiedGrant(req, env, verified.accountId);
      }
    }
  }

  // Everything else requires a valid (non-revoked) device token → full Principal.
  const p = await authenticate(req, env);
  if (!p) throw jsonResponse({ error: "unauthorized" }, 401);

  // DEFAULT-DENY token-kind route gate (design 21 §1.1): a short-lived browser
  // `web` session may touch ONLY the exact-match allowlist below. Everything else —
  // crucially the credential-mint routes (`pair/create`, `POST /v1/workspaces`) and
  // all crypto/sync surfaces — is 403, so a web token can never escalate into a
  // durable credential and bypass the E2EE ceiling. `device/approve` is a DELIBERATE
  // exception (design 47, allowlisted below): it doesn't mint a durable credential
  // for the *approving* web session, it only lets that session authorize a PENDING
  // device-code request onto its own account — the exact same
  // authorized-but-not-E2EE-enrolled grant `rbox device approve` (a durable token)
  // already produces today, so it isn't a new escalation.
  if (p.kind === "web" && !webTokenAllowed(req.method, seg)) {
    return jsonResponse({ error: "forbidden", message: "web session not permitted on this route" }, 403);
  }
  if (p.kind === "api_key" && !apiKeyAllowed(req.method, seg)) {
    return jsonResponse({ error: "forbidden_for_api_key" }, 403);
  }

  // ---- AUTHED groups (Principal-scoped, under the §1.1 gate) ----
  if ((r = await authDeviceRoutes(ctx, p))) return r;
  if ((r = await billingRoutes(ctx, p))) return r;
  if ((r = await accountRoutes(ctx, p))) return r;
  if ((r = await keysRoutes(ctx, p))) return r;
  if ((r = await blobBatchRoutes(ctx, p))) return r;
  if ((r = await blobsRoutes(ctx, p))) return r;
  if ((r = await diagnosticsRoutes(ctx, p))) return r;
  if ((r = await syncRoutes(ctx, p))) return r;

  return jsonResponse({ error: "not_found" }, 404);
}

// ---- shared cross-cutting helpers ---------------------------------------

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
  "v1", "health", "install.sh", "agent.sh", "version", "version.sig", "bin",
  "auth", "device", "start", "poll", "bootstrap", "approve", "devices", "revoke", "pair", "create", "redeem",
  "billing", "checkout", "portal", "stripe", "webhook", "web", "session",
  "account", "usage", "admin", "gc", "plan", "overview", "workspaces", "diagnostics",
  "keys", "api", "roster", "admit", "keystate", "workspace",
  "blobs", "blob-batch", "check", "get", "put", "multipart", "part", "complete",
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
  if (method === "POST" && eq(seg, ["v1", "account", "link", "redeem"])) return true; // self-rejects on its own kind=='device' check
  if (method === "POST" && eq(seg, ["v1", "account", "unlink"])) return true; // a web owner may unlink (§5.4)
  // design 37: a web OWNER session may delete the account; deleteAccount() re-checks the
  // owner role + confirmation. A non-owner web session is rejected there, not here.
  if (method === "DELETE" && eq(seg, ["v1", "account"])) return true;
  // design 47: a web session may approve a PENDING device-code request for its OWN
  // account — this is not a new privilege. approveDeviceAuth only ever reads
  // approver.accountId/userId and grants exactly the authorized-but-NOT-E2EE-enrolled
  // state that `rbox device approve` (a durable CLI token) already grants today; it
  // cannot mint E2EE admission material (§1's ceiling is unaffected). This is what
  // lets `rbox login`'s device-code flow be approved from a browser instead of a
  // second terminal.
  if (method === "POST" && eq(seg, ["v1", "auth", "device", "approve"])) return true;
  return false;
}

/**
 * The exact route family an agent API key may reach (design 20 R2 + design 87 R2).
 * It is intentionally narrower than "all authed routes": the key is a full E2EE
 * device cryptographically, but the server still blocks account management,
 * billing, pairing/device minting, and workspace creation.
 */
function apiKeyAllowed(method: string, seg: string[]): boolean {
  if (method === "GET" && (eq(seg, ["v1", "account", "usage"]) || eq(seg, ["v1", "account", "workspaces"]))) return true;
  if (seg[0] === "v1" && seg[1] === "ws") return true;
  if (seg[0] === "v1" && (seg[1] === "blobs" || seg[1] === "blob-batch")) return true;
  if (seg[0] === "v1" && seg[1] === "keys") {
    // POST admit is the key's one-time SELF-admission during `rbox key create-ci`
    // (admitAgentDevice runs under the new PAT bearer). The other mutating keys
    // routes — bootstrap (genesis), device, roster, keystate (epoch), workspace
    // (KEK publication) — are admin surface a leaked key must not reach. The
    // crypto layer rejects unsigned mutations anyway; this is defense in depth.
    if (method === "POST" && eq(seg, ["v1", "keys", "admit"])) return true;
    if (method === "GET" && (eq(seg, ["v1", "keys", "account"]) || (seg.length === 4 && seg[2] === "workspace"))) return true;
  }
  return false;
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
  // The admin cockpit SPA (admin.rbox.to) calls /v1/admin/* cross-origin and relies
  // on the Cloudflare Access SSO cookie, so it needs credentialed CORS. It's a
  // SEPARATE allowlist from the Clerk dashboard origins and is the only origin granted
  // Allow-Credentials.
  const adminOrigin = env.ADMIN_ALLOWED_ORIGIN?.trim();
  if (adminOrigin && origin === adminOrigin) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  const allowed = (env.CLERK_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const jsonResponse = json; // worker uses jsonResponse; shared impl is util.json
