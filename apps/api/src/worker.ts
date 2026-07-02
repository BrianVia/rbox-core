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
import type { AccountDeleteMessage, DeviceNotifyMessage, Env } from "./env.js";
import { authenticate } from "./auth.js";
import { runPhase1 } from "./gc-phase1.js";
import { retentionPrune } from "./retention.js";
import { json, logErr } from "./util.js";
import { startOp } from "./metrics.js";
import { processNotification, sweepNotifications } from "./notify.js";
import { driveAccountDeletion, sweepAccountDeletions } from "./account-delete.js";
import { eq, isDeviceRevoke, type RouteCtx } from "./routes/shared.js";
import { releaseRoutes } from "./routes/release.js";
import { adminRoutes } from "./routes/admin.js";
import { authDeviceRoutes, authPublicRoutes } from "./routes/auth.js";
import { billingRoutes, billingWebhookRoutes } from "./routes/billing.js";
import { webRoutes } from "./routes/web.js";
import { accountLinkPublicRoutes, accountRoutes } from "./routes/account.js";
import { keysRoutes } from "./routes/keys.js";
import { blobsRoutes } from "./routes/blobs.js";
import { syncRoutes } from "./routes/sync.js";
export { WorkspaceSync } from "./workspace-sync.js";

// §33 GRACE_1: the Phase-1 mark→purge grace, sized to exceed the slowest in-flight
// commit + clock skew (founder: ≈1h; the existing manual GC default, worker.ts).
const GRACE_1_MS = 60 * 60 * 1000;

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
   * Scheduled GC (cron, hourly). Plan-driven retention prune → §33 Phase 1, in order:
   * retention sets each workspace's prune floor from its account's plan, then Phase 1
   * (per account, D1-only) marks now-unreachable `blob_refs`, purges those still
   * unreachable past grace (releasing `used_bytes`), and reconciles. Idempotent +
   * fail-safe + fail-closed per account; a thrown phase is logged and the next run retries.
   *
   * §33 founder decision: Phase 2 (canonical R2 + `blobs` reclaim) stays OFF the cron —
   * R2 has no conditional/atomic delete, so a cron R2-delete races a concurrent direct
   * PUT (irreducible TOCTOU). It remains the manual/quiescent `/v1/admin/gc?phase=purge`
   * sweep. Phase 1 NEVER deletes an R2 object; it only condemns last-ref blobs into
   * `gc_candidates` for that manual sweep.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
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
      // `used_bytes` leak) + reconciler. GRACE_1 = 1h (≥ the slowest in-flight commit + skew).
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
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean);
  const ctx: RouteCtx = { req, env, url, seg };

  if (url.pathname === "/health") return jsonResponse({ ok: true, service: "rbox-api" });

  // ---- PUBLIC groups (before authenticate) ----
  let r: Response | null;
  if ((r = await releaseRoutes(ctx))) return r;
  if ((r = await adminRoutes(ctx))) return r;
  if ((r = await authPublicRoutes(ctx))) return r;
  if ((r = await billingWebhookRoutes(ctx))) return r;
  if ((r = await webRoutes(ctx))) return r;
  if ((r = await accountLinkPublicRoutes(ctx))) return r;

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

  // ---- AUTHED groups (Principal-scoped, under the §1.1 gate) ----
  if ((r = await authDeviceRoutes(ctx, p))) return r;
  if ((r = await billingRoutes(ctx, p))) return r;
  if ((r = await accountRoutes(ctx, p))) return r;
  if ((r = await keysRoutes(ctx, p))) return r;
  if ((r = await blobsRoutes(ctx, p))) return r;
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
  "v1", "health", "install.sh", "version", "version.sig", "bin",
  "auth", "device", "start", "poll", "bootstrap", "approve", "devices", "revoke", "pair", "create", "redeem",
  "billing", "checkout", "portal", "stripe", "webhook", "web", "session",
  "account", "usage", "admin", "gc", "plan", "overview", "workspaces",
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
  // design 37: a web OWNER session may delete the account; deleteAccount() re-checks the
  // owner role + confirmation. A non-owner web session is rejected there, not here.
  if (method === "DELETE" && eq(seg, ["v1", "account"])) return true;
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
