import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createWebSession, mintDevice } from "../src/auth.js";
import { processNotification, renderEmail, sanitizeLabel, sweepNotifications } from "../src/notify.js";
import type { Env, EmailSendMessage } from "../src/env.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE = "https://example.com";
const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

interface BootResult {
  token: string;
  accountId: string;
  deviceId: string;
  ownerUserId: string;
}

async function bootstrap(name: string): Promise<BootResult> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(res.status).toBe(200);
  const b = (await res.json()) as { token: string; accountId: string; deviceId: string };
  const owner = await env.rbox_dev_db.prepare("SELECT user_id FROM memberships WHERE account_id = ? AND role = 'owner'").bind(b.accountId).first<{ user_id: string }>();
  return { ...b, ownerUserId: owner!.user_id };
}

/** Make the bootstrap (CLI) account notifiable by attaching a Clerk identity + cached
 *  email to its owner — the bridge `rbox account link` would create. */
async function linkOwnerEmail(accountId: string, userId: string, clerkUserId: string, email: string): Promise<void> {
  await env.rbox_dev_db
    .prepare("INSERT OR REPLACE INTO clerk_users (clerk_user_id, account_id, user_id, created_at, email, email_updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(clerkUserId, accountId, userId, Date.now(), email, Date.now())
    .run();
}

/** An env whose EMAIL binding records every send (so we can assert send-exactly-once).
 *  DEVICE_NOTIFY_Q is stripped so `sweepNotifications` drives delivery INLINE (the
 *  no-queue fallback) deterministically — in this pool the queue consumer isn't invoked. */
function emailEnv(calls: EmailSendMessage[], extra: Partial<Env> = {}): Env {
  return Object.assign({}, env, { DEVICE_NOTIFY_Q: undefined, EMAIL: { send: async (m: EmailSendMessage) => (calls.push(m), { messageId: `msg_${calls.length}` }) } }, extra) as Env;
}

async function redeemPairDevice(boot: BootResult, label: string): Promise<{ token: string; tokenHash: string; deviceId: string }> {
  const create = await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: authed(boot.token, { "content-type": "application/json" }), body: "{}" });
  expect(create.status).toBe(200);
  const { token: pairToken } = (await create.json()) as { token: string };
  const redeem = await SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pairToken, label }) });
  expect(redeem.status).toBe(200);
  const r = (await redeem.json()) as { token: string; deviceId: string };
  return { token: r.token, tokenHash: sha(r.token), deviceId: r.deviceId };
}

async function deviceCodeDevice(boot: BootResult, label: string): Promise<{ token: string; tokenHash: string; deviceId: string }> {
  const start = await SELF.fetch(`${BASE}/v1/auth/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
  const { deviceCode, userCode } = (await start.json()) as { deviceCode: string; userCode: string };
  const approve = await SELF.fetch(`${BASE}/v1/auth/device/approve`, { method: "POST", headers: authed(boot.token, { "content-type": "application/json" }), body: JSON.stringify({ userCode }) });
  expect(approve.status).toBe(200);
  const poll = await SELF.fetch(`${BASE}/v1/auth/device/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode }) });
  const p = (await poll.json()) as { status: string; token: string; deviceId: string };
  expect(p.status).toBe("approved");
  return { token: p.token, tokenHash: sha(p.token), deviceId: p.deviceId };
}

async function outboxRow(tokenHash: string) {
  return env.rbox_dev_db.prepare("SELECT event, account_id, resolved_at, label FROM device_notifications WHERE token_hash = ?").bind(tokenHash).first<{ event: string; account_id: string; resolved_at: number | null; label: string }>();
}
async function deliveries(tokenHash: string) {
  const r = await env.rbox_dev_db.prepare("SELECT recipient_clerk_id, status, attempts FROM notification_deliveries WHERE token_hash = ?").bind(tokenHash).all<{ recipient_clerk_id: string; status: string; attempts: number }>();
  return r.results ?? [];
}

describe("new-device email — trigger (outbox on durable mint)", () => {
  test("pairing redeem writes exactly one outbox row (event=pair)", async () => {
    const boot = await bootstrap("notify-pair");
    const dev = await redeemPairDevice(boot, "brian's laptop");
    const row = await outboxRow(dev.tokenHash);
    expect(row).toMatchObject({ event: "pair", account_id: boot.accountId, label: "brian's laptop", resolved_at: null });
    const count = await env.rbox_dev_db.prepare("SELECT COUNT(*) AS n FROM device_notifications WHERE token_hash = ?").bind(dev.tokenHash).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  test("device-code claim writes an outbox row (event=device_code)", async () => {
    const boot = await bootstrap("notify-dc");
    const dev = await deviceCodeDevice(boot, "ci runner");
    expect(await outboxRow(dev.tokenHash)).toMatchObject({ event: "device_code", account_id: boot.accountId });
  });

  test("web sessions and bootstrap create NO outbox row", async () => {
    const boot = await bootstrap("notify-none");
    // bootstrap's own genesis device
    expect(await outboxRow(sha(boot.token))).toBeNull();
    // a short-lived web session mint
    const web = await createWebSession(env, boot.accountId, boot.ownerUserId);
    expect(await outboxRow(sha(web.token))).toBeNull();
    // a plain durable mint (no notification) also writes none
    const plain = await mintDevice(env, boot.accountId, boot.ownerUserId, "dev", "plain");
    expect(await outboxRow(sha(plain.token))).toBeNull();
  });
});

describe("new-device email — recipient resolution + delivery", () => {
  test("resolves to the account OWNER and sends exactly once (idempotent across retries)", async () => {
    const boot = await bootstrap("notify-owner");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_owner", "brian@example.com");
    const dev = await redeemPairDevice(boot, "MacBook Pro");

    const calls: EmailSendMessage[] = [];
    const r1 = await processNotification(emailEnv(calls), dev.tokenHash);
    expect(r1).toMatchObject({ found: true, sent: 1 });
    expect(await deliveries(dev.tokenHash)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("brian@example.com");
    expect(calls[0]!.from).toBe("security@mail.rbox.to");
    expect(calls[0]!.subject).toContain("new device");
    expect(calls[0]!.html).toContain(`highlight=${dev.deviceId}`);

    // At-least-once redelivery → the 'sent' row is not re-selected → no second email.
    const r2 = await processNotification(emailEnv(calls), dev.tokenHash);
    expect(r2.sent).toBe(0);
    expect(calls).toHaveLength(1);
    expect((await deliveries(dev.tokenHash))[0]).toMatchObject({ status: "sent", attempts: 1 });
  });

  test("alerts the OWNER even when a NON-OWNER member's device joins", async () => {
    const boot = await bootstrap("notify-nonowner");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_real_owner", "owner@example.com");
    // a second, non-owner member on the same account, whose device does the joining
    const memberUser = "user_member_1";
    await env.rbox_dev_db.prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(memberUser, boot.accountId, Date.now()).run();
    await env.rbox_dev_db.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'editor')").bind(boot.accountId, memberUser).run();
    const dev = await redeemPairDevice(boot, "member laptop");

    const calls: EmailSendMessage[] = [];
    await processNotification(emailEnv(calls), dev.tokenHash);
    expect(calls.map((c) => c.to)).toEqual(["owner@example.com"]); // the owner, not the member
  });

  // The per-recipient ledger SUPPORTS an N-owner fan-out, but `uq_clerk_users_account`
  // (migration 0014) binds exactly ONE Clerk identity per account, so resolution yields
  // a single recipient today even with several owner memberships. This pins that real
  // constraint (vs. design 16/30's multi-email assumption).
  test("several owner memberships but one Clerk identity → one resolved recipient", async () => {
    const boot = await bootstrap("notify-multi");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_o1", "o1@example.com");
    const o2 = "user_owner_2";
    await env.rbox_dev_db.prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(o2, boot.accountId, Date.now()).run();
    await env.rbox_dev_db.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(boot.accountId, o2).run();
    const dev = await redeemPairDevice(boot, "shared box");

    const calls: EmailSendMessage[] = [];
    const r = await processNotification(emailEnv(calls), dev.tokenHash);
    expect(await deliveries(dev.tokenHash)).toHaveLength(1);
    expect(r.sent).toBe(1);
    expect(calls.map((c) => c.to)).toEqual(["o1@example.com"]);
  });

  test("CLI-only account (no clerk_users bridge) → resolved with zero recipients, never crashes", async () => {
    const boot = await bootstrap("notify-cli-only"); // owner membership, but NO clerk_users row
    const dev = await redeemPairDevice(boot, "headless");
    const calls: EmailSendMessage[] = [];
    const r = await processNotification(emailEnv(calls), dev.tokenHash);
    expect(r).toMatchObject({ found: true, sent: 0 });
    expect(await deliveries(dev.tokenHash)).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await outboxRow(dev.tokenHash))!.resolved_at).not.toBeNull();
  });
});

describe("new-device email — skipped vs failed (fail loud, never silently drop)", () => {
  test("DEVICE_NOTIFICATIONS_DISABLED=1 → skipped, no send", async () => {
    const boot = await bootstrap("notify-killswitch");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_kill", "k@example.com");
    const dev = await redeemPairDevice(boot, "x");
    const calls: EmailSendMessage[] = [];
    const r = await processNotification(emailEnv(calls, { DEVICE_NOTIFICATIONS_DISABLED: "1" }), dev.tokenHash);
    expect(r).toMatchObject({ skipped: 1, sent: 0 });
    expect(calls).toHaveLength(0);
    expect((await deliveries(dev.tokenHash))[0]!.status).toBe("skipped");
  });

  test("account opt-out (notify_new_device=0) → skipped", async () => {
    const boot = await bootstrap("notify-optout");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_opt", "o@example.com");
    await env.rbox_dev_db.prepare("INSERT INTO account_notify_prefs (account_id, notify_new_device) VALUES (?, 0)").bind(boot.accountId).run();
    const dev = await redeemPairDevice(boot, "x");
    const calls: EmailSendMessage[] = [];
    const r = await processNotification(emailEnv(calls), dev.tokenHash);
    expect(r.skipped).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("missing EMAIL binding (domain not onboarded) → FAILED (retryable), never skipped", async () => {
    const boot = await bootstrap("notify-nobinding");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_nb", "nb@example.com");
    const dev = await redeemPairDevice(boot, "x");
    const r = await processNotification(Object.assign({}, env, { EMAIL: undefined }) as Env, dev.tokenHash);
    expect(r.failed).toBe(1);
    const d = (await deliveries(dev.tokenHash))[0]!;
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(1);
  });
});

describe("new-device email — cron backstop", () => {
  test("sweep re-drives an outbox row whose enqueue was lost (no delivery rows yet)", async () => {
    const boot = await bootstrap("notify-sweep");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_sweep", "s@example.com");
    const dev = await redeemPairDevice(boot, "swept");
    // Simulate the lost enqueue: the outbox row exists, unresolved, with no deliveries.
    expect((await outboxRow(dev.tokenHash))!.resolved_at).toBeNull();
    expect(await deliveries(dev.tokenHash)).toHaveLength(0);

    const calls: EmailSendMessage[] = [];
    await sweepNotifications(emailEnv(calls));
    expect(calls.some((c) => c.to === "s@example.com")).toBe(true);
    expect((await outboxRow(dev.tokenHash))!.resolved_at).not.toBeNull();
  });

  test("PII purge nulls label/ip/geo once the event is terminally delivered", async () => {
    const boot = await bootstrap("notify-purge");
    await linkOwnerEmail(boot.accountId, boot.ownerUserId, "user_clerk_purge", "p@example.com");
    const dev = await redeemPairDevice(boot, "purge-me");
    const calls: EmailSendMessage[] = [];
    await processNotification(emailEnv(calls), dev.tokenHash); // → sent (terminal)
    await sweepNotifications(emailEnv(calls)); // purge pass
    const row = await env.rbox_dev_db.prepare("SELECT label, ip, geo, device_id FROM device_notifications WHERE token_hash = ?").bind(dev.tokenHash).first<{ label: string | null; ip: string | null; geo: string | null; device_id: string }>();
    expect(row!.label).toBeNull();
    expect(row!.device_id).toBe(dev.deviceId); // non-PII audit field kept
  });
});

describe("new-device email — content & label sanitization", () => {
  test("subject is fixed, body has the revoke deep-link, label is HTML-escaped", () => {
    const out = renderEmail({ label: 'evil "<b>" device', ip: "203.0.113.7", geo: "Austin, TX, US", event: "pair", createdAt: 1719600000000, deviceId: "dev_abc123", appUrl: "https://app.rbox.to" });
    expect(out.subject).toBe("A new device was added to your rbox account");
    expect(out.subject).not.toContain("device device"); // label never in subject
    expect(out.html).toContain("https://app.rbox.to/devices?highlight=dev_abc123");
    expect(out.html).toContain("&lt;b&gt;"); // escaped, not a live tag
    expect(out.html).not.toContain("<b>");
    expect(out.text).toContain("203.0.113.7 · Austin, TX, US");
    expect(out.headers["List-Unsubscribe"]).toContain("/settings/notifications");
  });


  test("sanitizeLabel strips CR/LF + control chars (header-injection guard) and clamps", () => {
    expect(sanitizeLabel("good\r\nSubject: spoofed")).toBe("good Subject: spoofed");
    expect(sanitizeLabel("tab\tdevice\u0000null")).toBe("tab device null");
    expect(sanitizeLabel("")).toBe("Unknown device");
    expect(sanitizeLabel(null)).toBe("Unknown device");
    expect(sanitizeLabel("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});
