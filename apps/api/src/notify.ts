import type { Env } from "./env.js";
import { signinMethodsOf } from "./clerk-signin.js";
import { hmacSha256Hex, logErr } from "./util.js";
import { dbFor, dirDb } from "./db.js";

/**
 * New-device security email (design 16 / 30, slices 4–5).
 *
 * A durable bearer credential minted via pairing-redeem or device-code-claim writes
 * an OUTBOX row in the SAME atomic batch as its `devices` row (see auth.ts
 * `mintDeviceWithNotification`), then best-effort enqueues a job. Delivery is a
 * durable, idempotent, at-least-once path: the Cloudflare Queue consumer (worker.ts
 * `queue()`) and the cron backstop (worker.ts `scheduled()` → `sweepNotifications`)
 * both drive off the D1 outbox — the row, not the queue message, is the source of
 * truth. The actual transactional send is the first-party Cloudflare Email Service
 * `EMAIL` binding from `mail.rbox.to`.
 *
 * The recipient is the account's OWNER(s) (memberships role='owner' → clerk_users →
 * email), never the user whose device joined. Per-recipient delivery rows make a
 * multi-owner fan-out succeed/fail/retry independently; the atomic claim/lease is the
 * send mutex; the address is fetched (cache or live Clerk) at send time and never
 * persisted in the ledger.
 */

const MAX_ATTEMPTS = 6; // bounded delivery retries → then terminal failed-with-alarm (DLQ + log)
const LEASE_MS = 5 * 60 * 1000; // a 'sending' claim older than this is treated as a dead lease
const PII_TTL_MS = 7 * 24 * 60 * 60 * 1000; // purge label/ip/geo this long after creation regardless
const EMAIL_REFRESH_MS = 24 * 60 * 60 * 1000; // throttle the returning-login Clerk email refresh
const LABEL_MAX = 80; // render-time clamp (the projection cap is separate, 256)
const DEFAULT_FROM = "security@mail.rbox.to";
const DEFAULT_APP_URL = "https://app.rbox.to";

// ── outbox + enqueue (called from the mint call sites) ───────────────────────

export interface OutboxFields {
  tokenHash: string;
  deviceId: string;
  accountId: string;
  mintedUserId: string | null;
  label: string | null;
  ip: string | null;
  geo: string | null;
  event: "pair" | "device_code";
  createdAt: number;
  keysGranted?: boolean;
  keyFingerprint?: string | null;
}

/** The outbox INSERT, prepared (not run) so the caller can batch it ATOMICALLY with
 *  the `devices` INSERT — "if the device exists, its notification exists" (§2.3).
 *  `INSERT OR IGNORE` keyed on `token_hash` makes it idempotent under batch retry. */
export function prepareOutboxInsert(env: Env, o: OutboxFields): D1PreparedStatement {
  // device_notifications is account-data → route by the owning account. FLAG (§6f): the
  // caller (auth.ts mint) batches this with the directory-plane `devices` INSERT — one
  // binding at N=1, a cross-plane split under real sharding.
  // design 37: guarded by the SAME account-liveness condition as the device INSERT, so a mint
  // blocked by a mid-flight tombstone writes NEITHER the device NOR its notification (the §2.3
  // coextensivity holds in reverse). `accounts` is same-plane (account-data) here. 'default' bypass
  // matches the device guard.
  return dbFor(env, o.accountId)
    .prepare(
      `INSERT OR IGNORE INTO device_notifications
         (token_hash,device_id,account_id,minted_user_id,label,ip,geo,event,created_at,
          keys_granted,key_fingerprint)
       SELECT ?,?,?,?,?,?,?,?,?,?,?
       WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NULL) OR ? = 'default'`,
    )
    .bind(
      o.tokenHash,
      o.deviceId,
      o.accountId,
      o.mintedUserId,
      o.label,
      o.ip,
      o.geo,
      o.event,
      o.createdAt,
      o.keysGranted ? 1 : 0,
      o.keyFingerprint ?? null,
      o.accountId,
      o.accountId,
    );
}

/** Best-effort enqueue AFTER the batch commits. Never throws into device creation —
 *  a lost enqueue is re-driven by the cron backstop off the durable outbox row. */
export async function enqueueNotify(env: Env, tokenHash: string): Promise<void> {
  try {
    await env.DEVICE_NOTIFY_Q?.send({ tokenHash });
  } catch (e) {
    logErr("device_notify_enqueue_failed", e); // durable outbox + cron backstop re-drive
  }
}

/** CF-Connecting-IP snapshot (fetch-only; the consumer/cron never recompute it). */
export function clientIp(req: Request): string | null {
  return req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For") || null;
}

/** Coarse "City, Region, CC" from request.cf (fetch-only; nullable). */
export function clientGeo(req: Request): string | null {
  const cf = (req as { cf?: { city?: string; region?: string; country?: string } }).cf;
  if (!cf) return null;
  const parts = [cf.city, cf.region, cf.country].filter((x): x is string => typeof x === "string" && x.length > 0);
  return parts.length ? parts.join(", ") : null;
}

// ── the consumer: resolve recipients once, then deliver per-recipient ─────────

interface OutboxRow {
  token_hash: string;
  device_id: string;
  account_id: string;
  label: string | null;
  ip: string | null;
  geo: string | null;
  event: string;
  created_at: number;
  resolved_at: number | null;
  keys_granted: number;
  key_fingerprint: string | null;
}

interface DeliveryRow {
  recipient_clerk_id: string;
}

export interface NotifyResult {
  found: boolean;
  sent: number;
  skipped: number;
  failed: number;
}

/** Process one queued/swept notification by its credential `token_hash`. Phase 1:
 *  resolve owners → delivery rows once (frozen at first resolution). Phase 2: deliver
 *  each pending/failed row via the atomic claim → send → settle. The device already
 *  exists and is usable regardless of the outcome here. */
export async function processNotification(env: Env, tokenHash: string, now: number = Date.now()): Promise<NotifyResult> {
  // §32 FLAG: the outbox is account-data, but a queued job carries only token_hash — the
  // owning account is unknown until this row is read. Account-less at N=1 (one shard); a
  // sharded world needs the account/shard on the queue message or a token_hash→shard index.
  const row = await dbFor(env, "")
    .prepare("SELECT token_hash,device_id,account_id,label,ip,geo,event,created_at,resolved_at,keys_granted,key_fingerprint FROM device_notifications WHERE token_hash = ?")
    .bind(tokenHash)
    .first<OutboxRow>();
  if (!row) return { found: false, sent: 0, skipped: 0, failed: 0 };

  if (row.resolved_at === null) await resolveDeliveries(env, row, now);

  // The opt-out read and the pending-deliveries fetch are independent → overlap them.
  const [wants, pending] = await Promise.all([
    accountWantsNotifications(env, row.account_id),
    dbFor(env, row.account_id)
      .prepare("SELECT recipient_clerk_id FROM notification_deliveries WHERE token_hash = ? AND status IN ('pending','failed') AND attempts < ?")
      .bind(tokenHash, MAX_ATTEMPTS)
      .all<DeliveryRow>(),
  ]);
  const disabled = notificationsDisabled(env) || !wants;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const d of pending.results ?? []) {
    const outcome = await deliverOne(env, row, d, now, disabled);
    if (outcome === "sent") sent++;
    else if (outcome === "skipped") skipped++;
    else if (outcome === "failed") failed++;
  }
  return { found: true, sent, skipped, failed };
}

/** Resolve the account's current owners into one delivery row each, then stamp
 *  `resolved_at` — all in one atomic batch so the fan-out is frozen consistently. A
 *  CLI-only account (owner membership, no clerk_users row) yields zero owners → zero
 *  deliveries → terminal "no recipient" (logged, never crashed, §3.3). */
async function resolveDeliveries(env: Env, row: OutboxRow, now: number): Promise<void> {
  const owners = await resolveOwners(env, row.account_id);
  const stmts = await Promise.all(
    owners.map(async (o) =>
      dbFor(env, row.account_id)
        .prepare("INSERT OR IGNORE INTO notification_deliveries (token_hash, recipient_user_id, recipient_clerk_id, idempotency_key, status, attempts) VALUES (?, ?, ?, ?, 'pending', 0)")
        .bind(row.token_hash, o.userId, o.clerkUserId, await idempotencyKey(env, row.token_hash, o.clerkUserId)),
    ),
  );
  stmts.push(dbFor(env, row.account_id).prepare("UPDATE device_notifications SET resolved_at = ? WHERE token_hash = ?").bind(now, row.token_hash));
  await dbFor(env, row.account_id).batch(stmts);
}

/** The account's owner identities (memberships role='owner' → clerk_users), deduped
 *  by the stable Clerk id. An owner with no clerk_users bridge is simply absent. */
export async function resolveOwners(env: Env, accountId: string): Promise<Array<{ userId: string; clerkUserId: string }>> {
  // memberships + clerk_users are BOTH directory-plane, so this JOIN stays on dirDb
  // (the §6f "two-plane read" boundary is between this and the account-shard outbox).
  const rows = await dirDb(env)
    .prepare(
      `SELECT cu.user_id AS user_id, cu.clerk_user_id AS clerk_user_id
       FROM memberships m JOIN clerk_users cu ON cu.account_id = m.account_id AND cu.user_id = m.user_id
       WHERE m.account_id = ? AND m.role = 'owner'`,
    )
    .bind(accountId)
    .all<{ user_id: string; clerk_user_id: string }>();
  const seen = new Set<string>();
  const out: Array<{ userId: string; clerkUserId: string }> = [];
  for (const r of rows.results ?? []) {
    if (seen.has(r.clerk_user_id)) continue;
    seen.add(r.clerk_user_id);
    out.push({ userId: r.user_id, clerkUserId: r.clerk_user_id });
  }
  return out;
}

type DeliverOutcome = "sent" | "skipped" | "failed" | "contended";

/** Atomic claim (the send mutex) → resolve address → send → settle. */
async function deliverOne(env: Env, row: OutboxRow, d: DeliveryRow, now: number, disabled: boolean): Promise<DeliverOutcome> {
  // Claim/lease: the conditional UPDATE is the mutex (D1 serializes writes). A concurrent
  // consumer that loses the race sees changes==0 and skips. Re-claimable only past the lease.
  const claim = await dbFor(env, row.account_id)
    .prepare(
      `UPDATE notification_deliveries SET status = 'sending', claimed_at = ?, attempts = attempts + 1, last_attempt_at = ?
       WHERE token_hash = ? AND recipient_clerk_id = ? AND status IN ('pending','failed') AND (claimed_at IS NULL OR claimed_at < ?)`,
    )
    .bind(now, now, row.token_hash, d.recipient_clerk_id, now - LEASE_MS)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return "contended";

  // Intentionally off (kill-switch or account opt-out) → terminal skipped (§4.2/§3.8).
  if (disabled) return settle(env, row, d.recipient_clerk_id, "skipped", null);

  const email = await ownerEmail(env, d.recipient_clerk_id, now);
  if (email.kind === "absent") return settle(env, row, d.recipient_clerk_id, "skipped", null); // known no verified email
  if (email.kind === "error") return settle(env, row, d.recipient_clerk_id, "failed", null); // transient (Clerk down) → retry

  // A missing EMAIL binding (sending domain not onboarded/entitled) is a RETRYABLE
  // failure with an alarm, never a terminal skip — it self-heals once onboarded (§4.2).
  if (!env.EMAIL) {
    logErr("device_notify_no_email_binding", new Error("EMAIL binding unavailable"));
    return settle(env, row, d.recipient_clerk_id, "failed", null);
  }

  const content = renderEmail({
    label: row.label,
    ip: row.ip,
    geo: row.geo,
    event: row.event,
    createdAt: row.created_at,
    deviceId: row.device_id,
    keysGranted: row.keys_granted === 1,
    keyFingerprint: row.key_fingerprint,
    appUrl: env.RBOX_APP_URL,
  });
  try {
    const res = await env.EMAIL.send({
      to: email.address,
      from: env.RBOX_NOTIFY_FROM || DEFAULT_FROM,
      subject: content.subject,
      html: content.html,
      text: content.text,
      headers: content.headers,
    });
    console.log(JSON.stringify({ event: "device_notify_sent", messageId: res.messageId }));
    return settle(env, row, d.recipient_clerk_id, "sent", now);
  } catch (e) {
    logErr("device_notify_send_failed", e); // 5xx/429/network → retryable failed
    return settle(env, row, d.recipient_clerk_id, "failed", null);
  }
}

async function settle(env: Env, row: OutboxRow, clerkId: string, status: "sent" | "skipped" | "failed", sentAt: number | null): Promise<DeliverOutcome> {
  await dbFor(env, row.account_id).prepare("UPDATE notification_deliveries SET status = ?, sent_at = ? WHERE token_hash = ? AND recipient_clerk_id = ?").bind(status, sentAt, row.token_hash, clerkId).run();
  return status;
}

// ── recipient address resolution (cache → live Clerk, never persisted in ledger) ──

export type EmailLookup = { kind: "ok"; address: string } | { kind: "absent" } | { kind: "error" };
type ClerkLookup =
  | { kind: "ok"; address: string; signinMethod: string | null; clerkUpdatedAt: number }
  | { kind: "absent"; signinMethod: string | null; clerkUpdatedAt: number }
  | { kind: "error" };

/** Resolve the owner's primary verified email for a Clerk id: cached column first,
 *  else one live Clerk fetch (opportunistically caching the result). */
export async function ownerEmail(env: Env, clerkUserId: string, now: number): Promise<EmailLookup> {
  const cached = await dirDb(env).prepare("SELECT email FROM clerk_users WHERE clerk_user_id = ?").bind(clerkUserId).first<{ email: string | null }>();
  if (cached?.email) return { kind: "ok", address: cached.email };
  const fetched = await fetchClerkPrimaryEmail(env, clerkUserId);
  if (fetched.kind === "ok") await cacheOwnerEmail(env, clerkUserId, fetched.address, now);
  return fetched;
}

/** Write-through the cached primary email (fire-and-forget; a cache miss self-heals). */
async function cacheOwnerEmail(env: Env, clerkUserId: string, address: string, now: number): Promise<void> {
  await dirDb(env).prepare("UPDATE clerk_users SET email = ?, email_updated_at = ? WHERE clerk_user_id = ?").bind(address, now, clerkUserId).run().catch(() => {});
}

/** The Clerk Backend API primary-verified-email fetch. `ok` → an address; `absent` →
 *  the user exists but has no verified email (terminal skip); `error` → transient
 *  (config/network/5xx), which must RETRY, never skip a security alert. */
async function fetchClerkPrimaryEmail(env: Env, sub: string): Promise<ClerkLookup> {
  if (!env.CLERK_SECRET_KEY) return { kind: "error" }; // can't determine → retry (fail loud)
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${sub}`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    if (!res.ok) return { kind: "error" };
    const u = (await res.json()) as {
      email_addresses?: Array<{ id: string; email_address?: string; verification?: { status?: string } }>;
      primary_email_address_id?: string;
      external_accounts?: Array<{ provider?: string; verification?: { status?: string } }>;
      password_enabled?: boolean;
      updated_at?: number;
    };
    if (typeof u.updated_at !== "number") return { kind: "error" };
    const primary = u.email_addresses?.find((e) => e.id === u.primary_email_address_id) ?? u.email_addresses?.[0];
    const facts = { signinMethod: signinMethodsOf(u), clerkUpdatedAt: u.updated_at };
    if (primary?.verification?.status === "verified" && primary.email_address) return { kind: "ok", address: primary.email_address, ...facts };
    return { kind: "absent", ...facts };
  } catch {
    return { kind: "error" };
  }
}

/** Returning-login email refresh (clerk.ts), throttled by `email_updated_at`. Failure
 *  is non-fatal — it's a cache refresh, not the auth path. Also populates the cache on
 *  first login (NULL `email_updated_at`). */
export async function refreshOwnerEmail(env: Env, sub: string, now: number): Promise<void> {
  const row = await dirDb(env).prepare("SELECT email_updated_at, signin_method_updated_at FROM clerk_users WHERE clerk_user_id = ?").bind(sub).first<{ email_updated_at: number | null; signin_method_updated_at: number | null }>();
  if (!row) return; // no mapping (shouldn't happen post-provision) → nothing to refresh
  // clerk.ts may seed email with NULL email_updated_at; throttle on the timestamp, never email presence.
  if (row.signin_method_updated_at !== null && row.email_updated_at && now - row.email_updated_at < EMAIL_REFRESH_MS) return; // throttled
  const fetched = await fetchClerkPrimaryEmail(env, sub);
  if (fetched.kind === "ok") await cacheOwnerEmail(env, sub, fetched.address, now);
  if (fetched.kind !== "error") {
    await dirDb(env)
      .prepare("UPDATE clerk_users SET signin_method = ?, signin_method_updated_at = ? WHERE clerk_user_id = ? AND (signin_method_updated_at IS NULL OR signin_method_updated_at < ?)")
      .bind(fetched.signinMethod, fetched.clerkUpdatedAt, sub, fetched.clerkUpdatedAt)
      .run()
      .catch(() => {});
  }
}

// ── feature flags ────────────────────────────────────────────────────────────

/** The explicit kill-switch — the ONLY intentional-off path (§4.2). */
export function notificationsDisabled(env: Env): boolean {
  return env.DEVICE_NOTIFICATIONS_DISABLED === "1";
}

/** Account opt-out (default ON — row absent ⇒ enabled). */
async function accountWantsNotifications(env: Env, accountId: string): Promise<boolean> {
  const row = await dbFor(env, accountId).prepare("SELECT notify_new_device FROM account_notify_prefs WHERE account_id = ?").bind(accountId).first<{ notify_new_device: number }>();
  return !row || row.notify_new_device !== 0;
}

async function idempotencyKey(env: Env, tokenHash: string, clerkUserId: string): Promise<string> {
  return hmacSha256Hex(env.NOTIFY_IDEMPOTENCY_PEPPER || "rbox-notify-dev-pepper", `${tokenHash}:${clerkUserId}`);
}

// ── email rendering (render-time sanitization is authoritative) ───────────────

const HTML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c);
}

/** Strip CR/LF + all C0/C1 control chars (header-injection + spoofing guard), collapse
 *  whitespace, clamp, and never let an empty/garbage label render blank. Authoritative
 *  regardless of what was stored — the single chokepoint that makes a hostile label
 *  safe in every sink. */
export function sanitizeLabel(raw: string | null): string {
  if (!raw) return "Unknown device";
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 (0x00-0x1F), DEL + C1 (0x7F-0x9F) → space (header-injection + spoofing guard).
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  const cleaned = out.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  return cleaned.length ? cleaned : "Unknown device";
}

export interface RenderInput {
  label: string | null;
  ip: string | null;
  geo: string | null;
  event: string;
  createdAt: number;
  deviceId: string;
  keysGranted?: boolean;
  keyFingerprint?: string | null;
  appUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** Plain, security-styled. The device label is sanitized and NEVER interpolated into
 *  the Subject (blocks header injection); the revoke link deep-links to the device on
 *  the dashboard (revocation requires an authenticated Clerk session — not a GET). */
export function renderEmail(o: RenderInput): RenderedEmail {
  const label = sanitizeLabel(o.label);
  const when = new Date(o.createdAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const location = o.ip && o.geo ? `${o.ip} · ${o.geo}` : o.ip || o.geo || "location unavailable";
  const how = o.event === "pair" ? "paired from another of your devices" : "approved via a device code";
  const keyLines = o.keysGranted
    ? [
      "Keys:   Encryption-key access was granted",
      ...(o.keyFingerprint ? [`Key fingerprint: ${o.keyFingerprint}`] : []),
      "",
      "Revoke blocks new access; a machine that already received your key keeps what it has, and any in-flight download grant expires within ~5 minutes.",
      "",
    ]
    : [];
  const base = (o.appUrl || DEFAULT_APP_URL).replace(/\/$/, "");
  const revoke = `${base}/devices?highlight=${encodeURIComponent(o.deviceId)}`;
  const settings = `${base}/settings/notifications`;
  const subject = "A new device was added to your rbox account";

  const text = [
    "A new device was added to your rbox account.",
    "",
    `Device: ${label}`,
    `When:   ${when} (times are approximate)`,
    `Where:  ${location}`,
    `How:    ${how}`,
    "",
    ...keyLines,
    "If this wasn't you, sign this device out now:",
    revoke,
    "",
    "You're receiving this because new-device alerts are on for your account.",
    `Manage alerts: ${settings}`,
  ].join("\n");

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">`,
    `<h1 style="font-size:18px;margin:0 0 12px">A new device was added to your rbox account</h1>`,
    `<table style="font-size:14px;line-height:1.6;border-collapse:collapse">`,
    `<tr><td style="color:#64748b;padding-right:12px">Device</td><td><strong>${escapeHtml(label)}</strong></td></tr>`,
    `<tr><td style="color:#64748b;padding-right:12px">When</td><td>${escapeHtml(when)} <span style="color:#94a3b8">(approximate)</span></td></tr>`,
    `<tr><td style="color:#64748b;padding-right:12px">Where</td><td>${escapeHtml(location)}</td></tr>`,
    `<tr><td style="color:#64748b;padding-right:12px">How</td><td>${escapeHtml(how)}</td></tr>`,
    ...(o.keysGranted
      ? [
        `<tr><td style="color:#64748b;padding-right:12px">Keys</td><td>Encryption-key access was granted</td></tr>`,
        ...(o.keyFingerprint
          ? [`<tr><td style="color:#64748b;padding-right:12px">Key fingerprint</td><td><code>${escapeHtml(o.keyFingerprint)}</code></td></tr>`]
          : []),
      ]
      : []),
    `</table>`,
    ...(o.keysGranted
      ? [`<p style="font-size:13px;color:#475569">Revoke blocks new access; a machine that already received your key keeps what it has, and any in-flight download grant expires within ~5 minutes.</p>`]
      : []),
    `<p style="font-size:14px;margin:20px 0 8px">If this wasn't you, sign this device out now:</p>`,
    `<p><a href="${escapeHtml(revoke)}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">This wasn't me — review devices</a></p>`,
    `<p style="font-size:12px;color:#94a3b8;margin-top:24px">You're receiving this because new-device alerts are on for your account. <a href="${escapeHtml(settings)}" style="color:#64748b">Manage alerts</a>.</p>`,
    `</div>`,
  ].join("");

  return { subject, html, text, headers: { "List-Unsubscribe": `<${settings}>` } };
}

// ── cron backstop: re-drive both layers + purge PII ──────────────────────────

/** The durable backstop (worker.ts `scheduled`). Re-drives (a) outbox rows whose
 *  enqueue was lost (`resolved_at IS NULL`, no delivery rows yet) and (b) pending/failed
 *  deliveries under the attempt cap (reverting dead 'sending' leases first), then purges
 *  PII for terminal/expired events. The outbox row is the source of truth. */
export async function sweepNotifications(env: Env, now: number = Date.now()): Promise<{ reEnqueued: number; purged: number }> {
  // §32 FLAG: the cron sweep scans device_notifications / notification_deliveries across
  // ALL accounts — an account-data-plane CROSS-SHARD fan-out (§6f/§33). Account-less at N=1
  // (the one shard); a sharded world fans this out over liveShards.
  // Revert dead leases so they re-enter the pending/failed selection.
  await dbFor(env, "").prepare("UPDATE notification_deliveries SET status = 'failed' WHERE status = 'sending' AND claimed_at < ?").bind(now - LEASE_MS).run();

  const unresolved = await dbFor(env, "").prepare("SELECT token_hash FROM device_notifications WHERE resolved_at IS NULL LIMIT 200").all<{ token_hash: string }>();
  const retry = await dbFor(env, "").prepare("SELECT DISTINCT token_hash FROM notification_deliveries WHERE status IN ('pending','failed') AND attempts < ? LIMIT 200").bind(MAX_ATTEMPTS).all<{ token_hash: string }>();

  const tokenHashes = new Set<string>();
  for (const r of unresolved.results ?? []) tokenHashes.add(r.token_hash);
  for (const r of retry.results ?? []) tokenHashes.add(r.token_hash);

  let reEnqueued = 0;
  for (const th of tokenHashes) {
    if (env.DEVICE_NOTIFY_Q) await env.DEVICE_NOTIFY_Q.send({ tokenHash: th }).catch((e) => logErr("device_notify_reenqueue_failed", e));
    else await processNotification(env, th, now).catch((e) => logErr("device_notify_sweep_process_failed", e)); // no queue (e.g. tests) → drive inline
    reEnqueued++;
  }

  // Projection purge: null label/ip/geo/fingerprint once no non-terminal delivery remains for the event,
  // or past the TTL. Keep only non-PII audit fields (token_hash, device_id, ids, ts).
  const purge = await dbFor(env, "") // §32 FLAG: global PII purge across all accounts (see above).
    .prepare(
      `UPDATE device_notifications SET label=NULL,ip=NULL,geo=NULL,key_fingerprint=NULL
       WHERE (label IS NOT NULL OR ip IS NOT NULL OR geo IS NOT NULL OR key_fingerprint IS NOT NULL)
         AND (created_at < ?
              OR (resolved_at IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM notification_deliveries d
                    WHERE d.token_hash = device_notifications.token_hash AND d.status IN ('pending','sending','failed') AND d.attempts < ?)))`,
    )
    .bind(now - PII_TTL_MS, MAX_ATTEMPTS)
    .run();
  return { reEnqueued, purged: purge.meta.changes ?? 0 };
}
