import { env, SELF, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mintDevice } from "../src/auth.js";
import { routeTemplate } from "../src/worker.js";
import { billingCheckout, repointBillingToAccount } from "../src/stripe.js";
import { confirmLink } from "../src/account-link.js";
import type { Principal } from "../src/authz.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE = "https://example.com";

// Apply D1 migrations against the local test DB once.
beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

// Each test bootstraps its own account/device so they're isolated.
async function bootstrap(accountName: string): Promise<{ token: string; accountId: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string; deviceId: string };
}

const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

describe("worker integration (real DO + D1 + R2)", () => {
  test("health is public", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  test("unauthenticated request → 401", async () => {
    const res = await SELF.fetch(`${BASE}/v1/account/usage`);
    expect(res.status).toBe(401);
  });

  test("blob entitlement: PUT grants, GET works; a different account 404s the same sha", async () => {
    const a = await bootstrap("acct-blob-a");
    const content = "blob-entitlement-content";
    const s = sha(content);
    const put = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(content.length) }), body: content });
    expect(put.status).toBe(200);
    const get = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { headers: authed(a.token) });
    expect(get.status).toBe(200);
    // A second account never uploaded it → not entitled → 404 (cross-account isolation).
    const b = await bootstrap("acct-blob-b");
    const cross = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { headers: authed(b.token) });
    expect(cross.status).toBe(404);
  });

  // The DO commit sequencer uses `ctx.storage.kv` + `transactionSync` — DO storage
  // APIs newer than the workerd bundled with the pinned vitest-pool-workers (which
  // caps at compat 2025-07-30). These paths are verified LIVE (M1–M7) and the
  // client-side 409/422/retry logic is automated in src/cli/sync.test.ts against a
  // stateful FakeRemote. Re-enable when a pool-workers/runtime with storage.kv lands.
  // Build the new E2EE commit envelope. The server stores it opaquely and does NOT
  // verify the signature/canonicalization, so commitHash/sig can be any well-formed
  // dummies — only encManifestSha + blobRefs.encSha must reference uploaded blobs.
  const signedCommit = (over: {
    accountId: string;
    workspaceId: string;
    deviceId: string;
    seq?: number;
    parentSeq?: number;
    accountEpoch?: number;
    encManifestSha: string;
    blobRefs?: Array<{ encSha: string; size: number }>;
  }) => {
    const seq = over.seq ?? 1;
    const parentSeq = over.parentSeq ?? 0;
    const body = JSON.stringify({
      type: "rbox/commit/v1",
      accountId: over.accountId,
      accountEpoch: over.accountEpoch ?? 0,
      workspaceId: over.workspaceId,
      seq,
      parentSeq,
      parentCommitHash: "0".repeat(64),
      rosterVersion: 0,
      keyEpoch: 0,
      deviceId: over.deviceId,
      encManifestSha: over.encManifestSha,
      blobRefs: over.blobRefs ?? [],
    });
    return { commit: { body, commitHash: "a".repeat(64), sig: "dummy-sig" } };
  };

  test.skip("commit sequencer: clean commit, then a STALE parent → 409 conflict", async () => {
    const a = await bootstrap("acct-commit");
    // Create a workspace (server-owned).
    const wsRes = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(wsRes.status).toBe(200);
    const ws = ((await wsRes.json()) as { workspaceId: string }).workspaceId;

    // Upload the encrypted-manifest blob + a referenced content blob, then commit.
    const manifestSha = sha("enc-manifest");
    const contentSha = sha("commit-payload");
    for (const [c, s] of [["enc-manifest", manifestSha], ["commit-payload", contentSha]] as const) {
      await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(c.length) }), body: c });
    }
    const commitUrl = `${BASE}/v1/ws/${ws}/proj/root/manifests`;
    const env1 = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, encManifestSha: manifestSha, blobRefs: [{ encSha: contentSha, size: 14 }] });
    const c1 = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...env1 }) });
    expect(c1.status).toBe(200);
    expect(((await c1.json()) as { sequence: number }).sequence).toBe(1);

    // Re-commit with the now-stale parent 0 → 409.
    const c2 = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...env1 }) });
    expect(c2.status).toBe(409);
  });

  test.skip("commit referencing an un-uploaded blob → 422 unsatisfied (entitlement-scoped)", async () => {
    const a = await bootstrap("acct-422");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const ghostSha = sha("never-uploaded");
    const envc = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, encManifestSha: ghostSha });
    const res = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/manifests`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...envc }) });
    expect(res.status).toBe(422);
  });

  // C1: commits?since returns the stored chain for (since, head]. Exercises DO
  // storage.kv (unavailable in this runtime — see note above), so it's SKIPPED;
  // verified live. We still pin the contract: each returned entry is a full
  // SignedCommit and they're in ascending sequence from since+1.
  test.skip("commits?since returns the SignedCommit chain from the pinned seq to head", async () => {
    const a = await bootstrap("acct-commits-since");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const commitUrl = `${BASE}/v1/ws/${ws}/proj/root/manifests`;
    // Land two commits (seq 1, 2).
    for (let seq = 1; seq <= 2; seq++) {
      const m = sha(`enc-manifest-${seq}`);
      await SELF.fetch(`${BASE}/v1/blobs/${m}`, { method: "PUT", headers: authed(a.token, { "content-length": String(`enc-manifest-${seq}`.length) }), body: `enc-manifest-${seq}` });
      const env1 = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, seq, parentSeq: seq - 1, encManifestSha: m });
      const c = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: seq - 1, ...env1 }) });
      expect(c.status).toBe(200);
    }
    // since=0 → both commits; since=1 → only seq 2.
    const all = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/commits?since=0`, { headers: authed(a.token) });
    expect(all.status).toBe(200);
    expect(((await all.json()) as { commits: unknown[] }).commits).toHaveLength(2);
    const tail = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/commits?since=1`, { headers: authed(a.token) });
    expect(((await tail.json()) as { commits: Array<{ body: string }> }).commits).toHaveLength(1);
  });

  // C4: a commit signed under a stale/unknown epoch is refused inside the DO's
  // head-advance txn. SKIPPED (DO storage.kv unavailable here); the authoritative
  // guarantee is the client-side roster/epoch check, this is the server backstop.
  test.skip("commit with accountEpoch != current → 409 epoch_stale", async () => {
    const a = await bootstrap("acct-epoch-stale");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    // Account is at epoch 0 (no key-states); a commit claiming epoch 1 is stale.
    const m = sha("enc-manifest-epoch");
    await SELF.fetch(`${BASE}/v1/blobs/${m}`, { method: "PUT", headers: authed(a.token, { "content-length": "17" }), body: "enc-manifest-epoc" });
    const envc = signedCommit({ accountId: a.accountId, workspaceId: ws, deviceId: a.deviceId, accountEpoch: 1, encManifestSha: m });
    const res = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/manifests`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, ...envc }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("epoch_stale");
  });

  test("free plan workspace cap: 2nd workspace → 402 quota_exceeded", async () => {
    const a = await bootstrap("acct-quota");
    const first = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(second.status).toBe(402);
  });

  // ── pairing tokens (M10) ─────────────────────────────────────────────────

  const pairCreate = (token: string) => SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: authed(token) });
  const pairRedeem = (pair: string) =>
    SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair, label: "new-machine" }) });

  test("pair/create requires auth (no token → 401)", async () => {
    const res = await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("pair create → redeem mints a working device on the SAME account", async () => {
    const a = await bootstrap("acct-pair");
    const cr = await pairCreate(a.token);
    expect(cr.status).toBe(200);
    const { token: pair } = (await cr.json()) as { token: string };
    expect(pair.startsWith("rbox-pair_")).toBe(true);

    const rd = await pairRedeem(pair);
    expect(rd.status).toBe(200);
    const { token: deviceToken, deviceId } = (await rd.json()) as { token: string; deviceId: string };
    expect(deviceId.startsWith("dev_")).toBe(true);
    // The minted token authenticates and lands in the creator's account.
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(deviceToken) });
    expect(usage.status).toBe(200);
    expect(((await usage.json()) as { plan: string }).plan).toBe("free");
  });

  test("pairing token is SINGLE-USE (second redeem → 401)", async () => {
    const a = await bootstrap("acct-pair-once");
    const { token: pair } = (await (await pairCreate(a.token)).json()) as { token: string };
    expect((await pairRedeem(pair)).status).toBe(200);
    expect((await pairRedeem(pair)).status).toBe(401); // already consumed
  });

  test("malformed / unknown pairing token → 401", async () => {
    expect((await pairRedeem("rbox-pair_not-hex")).status).toBe(401);
    expect((await pairRedeem(`rbox-pair_${"a".repeat(64)}`)).status).toBe(401); // well-formed but unknown
  });

  test("expired pairing token → 401 (and is not minted)", async () => {
    const a = await bootstrap("acct-pair-exp");
    // Insert a token that's already expired, directly into D1.
    const { createHash } = await import("node:crypto");
    const raw = "b".repeat(64);
    const hash = createHash("sha256").update(raw).digest("hex");
    const past = Date.now() - 1000;
    await env.rbox_dev_db
      .prepare("INSERT INTO pairing_tokens (token_hash, account_id, user_id, created_by, label, created_at, expires_at) VALUES (?, ?, ?, ?, 'x', ?, ?)")
      .bind(hash, a.accountId, "u", a.deviceId, past - 1000, past)
      .run();
    expect((await pairRedeem(`rbox-pair_${raw}`)).status).toBe(401);
  });

  test("revoked creator device → its outstanding token is dead at redeem (fix #1)", async () => {
    const a = await bootstrap("acct-pair-revoke");
    const { token: pair } = (await (await pairCreate(a.token)).json()) as { token: string };
    // Revoke the device that created the token, THEN try to redeem it.
    await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(a.deviceId).run();
    expect((await pairRedeem(pair)).status).toBe(401); // live-authority check fails closed
  });

  test("active-token cap enforced (6th create → 429)", async () => {
    const a = await bootstrap("acct-pair-cap");
    for (let i = 0; i < 5; i++) expect((await pairCreate(a.token)).status).toBe(200);
    expect((await pairCreate(a.token)).status).toBe(429);
  });

  // ── P1: device_id is GLOBALLY unique (migration 0013) ────────────────────
  const insertDevice = (tokenHash: string, deviceId: string, accountId: string) =>
    env.rbox_dev_db
      .prepare("INSERT INTO devices (token_hash, device_id, label, account_id, user_id, created_at) VALUES (?, ?, 'p1', ?, 'u', ?)")
      .bind(tokenHash, deviceId, accountId, Date.now())
      .run();

  test("duplicate device_id in the SAME account is rejected by the unique index", async () => {
    const a = await bootstrap("acct-dev-unique");
    await expect(insertDevice(sha("p1-same-acct"), a.deviceId, a.accountId)).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("duplicate device_id across DIFFERENT accounts is rejected (GLOBAL scope, reconciles device_keys PK)", async () => {
    const a = await bootstrap("acct-dev-unique-a");
    const b = await bootstrap("acct-dev-unique-b");
    // device_keys.device_id is a global PRIMARY KEY, so devices must be global too:
    // the same id may not exist under a second account.
    await expect(insertDevice(sha("p1-cross-acct"), a.deviceId, b.accountId)).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("mintDevice retries to a fresh id when its generated id collides", async () => {
    const a = await bootstrap("acct-mint-retry");
    const collide = "dev_collision_fixed";
    await insertDevice(sha("p1-occupant"), collide, a.accountId); // occupy the first candidate
    let calls = 0;
    const { token, deviceId } = await mintDevice(env, a.accountId, "u", "dev", "retry", null, () =>
      calls++ === 0 ? collide : "dev_fresh_after_retry",
    );
    expect(calls).toBe(2); // first candidate collided → retried exactly once
    expect(deviceId).toBe("dev_fresh_after_retry");
    // The minted token authenticates → the row really landed.
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(token) })).status).toBe(200);
  });

  test("mintDevice gives up after bounded retries when the id never frees up", async () => {
    const a = await bootstrap("acct-mint-exhaust");
    const collide = "dev_always_collide";
    await insertDevice(sha("p1-occupant-2"), collide, a.accountId);
    await expect(mintDevice(env, a.accountId, "u", "dev", "x", null, () => collide)).rejects.toThrow(/exhausted/);
  });

  test("revoking one device revokes EXACTLY one row; siblings keep working", async () => {
    const a = await bootstrap("acct-revoke-one");
    // Add a 2nd device in the same account via pairing.
    const { token: pair } = (await (await pairCreate(a.token)).json()) as { token: string };
    const { token: token2, deviceId: dev2 } = (await (await pairRedeem(pair)).json()) as { token: string; deviceId: string };
    expect(dev2).not.toBe(a.deviceId);
    // Both authenticate before revoke.
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(token2) })).status).toBe(200);
    // Revoke device 2 → unique device_id means exactly one row is touched.
    const rev = await SELF.fetch(`${BASE}/v1/auth/devices/${dev2}/revoke`, { method: "POST", headers: authed(a.token) });
    expect(rev.status).toBe(200);
    expect(((await rev.json()) as { revoked: number }).revoked).toBe(1);
    // Device 2 is now dead; device 1 (sibling) is untouched.
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(token2) })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) })).status).toBe(200);
  });

  // ── Stripe billing (M10) ─────────────────────────────────────────────────

  test("billing/checkout + portal are gated on STRIPE_SECRET (absent → 501)", async () => {
    const a = await bootstrap("acct-bill");
    expect((await SELF.fetch(`${BASE}/v1/billing/checkout?plan=pro`, { method: "POST", headers: authed(a.token) })).status).toBe(501);
    expect((await SELF.fetch(`${BASE}/v1/billing/portal`, { method: "POST", headers: authed(a.token) })).status).toBe(501);
  });

  // Sign a payload exactly as Stripe does: HMAC-SHA256 over `${t}.${body}`.
  async function stripeSig(body: string, secret: string, t: number): Promise<string> {
    const { createHmac } = await import("node:crypto");
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }
  const webhook = (body: string, sig: string) =>
    SELF.fetch(`${BASE}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body });

  test("webhook rejects a bad/forged signature → 400 (no plan change)", async () => {
    const evt = JSON.stringify({ id: "evt_bad", type: "customer.subscription.updated", data: { object: {} } });
    expect((await webhook(evt, "t=123,v1=deadbeef")).status).toBe(400);
  });

  test("webhook flips accounts.plan on an active subscription (valid signature)", async () => {
    const a = await bootstrap("acct-sub");
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_sub_1",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "active", customer: "cus_sub1", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: "rbox_pro_monthly" } }] } } },
    });
    const res = await webhook(body, await stripeSig(body, "whsec_test_secret", t));
    expect(res.status).toBe(200);
    // Confirm via the authed usage endpoint that the plan is now pro.
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) });
    expect(((await usage.json()) as { plan: string }).plan).toBe("pro");
  });

  test("webhook is idempotent (same event id re-delivered → duplicate, applied once)", async () => {
    const a = await bootstrap("acct-idem");
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_dup",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_2", status: "active", customer: "cus_sub2", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: "rbox_solo_monthly" } }] } } },
    });
    const sig = await stripeSig(body, "whsec_test_secret", t);
    expect((await (await webhook(body, sig)).json() as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect((await (await webhook(body, sig)).json() as { duplicate?: boolean }).duplicate).toBe(true); // 2nd = no-op
  });

  test("webhook downgrades to free when subscription is canceled/past_due", async () => {
    const a = await bootstrap("acct-cancel");
    const t = Math.floor(Date.now() / 1000);
    const mk = (id: string, status: string, lk: string) =>
      JSON.stringify({ id, type: "customer.subscription.updated", data: { object: { id: "sub_3", status, customer: "cus_sub3", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: lk } }] } } } });
    const up = mk("evt_up", "active", "rbox_pro_monthly");
    await webhook(up, await stripeSig(up, "whsec_test_secret", t));
    const down = mk("evt_down", "past_due", "rbox_pro_monthly");
    await webhook(down, await stripeSig(down, "whsec_test_secret", t));
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) });
    expect(((await usage.json()) as { plan: string }).plan).toBe("free"); // fail-closed
  });

  // ── downgrade grace period (design 13) ──────────────────────────────────────
  const usageOf = async (token: string) =>
    (await (await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(token) })).json()) as { plan: string; graceUntil: number | null; storageCap: number | null; readOnly: boolean };

  test("downgrade stamps a 30-day grace; a re-delivered downgrade does NOT extend it", async () => {
    const a = await bootstrap("acct-grace");
    const t = Math.floor(Date.now() / 1000);
    const upd = (id: string, status: string) =>
      JSON.stringify({ id, type: "customer.subscription.updated", data: { object: { id: "sub_g", status, customer: "cus_g", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: "rbox_pro_monthly" } }] } } } });
    const up = upd("evt_g_up", "active");
    await webhook(up, await stripeSig(up, "whsec_test_secret", t));
    const down1 = upd("evt_g_d1", "past_due"); // first downgrade → free + grace
    await webhook(down1, await stripeSig(down1, "whsec_test_secret", t));
    const u1 = await usageOf(a.token);
    expect(u1.plan).toBe("free");
    expect(u1.graceUntil).toBeGreaterThan(Date.now());
    // A later subscription.deleted for the same sub must NOT push the window out.
    const down2 = JSON.stringify({ id: "evt_g_d2", type: "customer.subscription.deleted", data: { object: { id: "sub_g", status: "canceled", customer: "cus_g", metadata: { account_id: a.accountId } } } });
    await webhook(down2, await stripeSig(down2, "whsec_test_secret", t));
    const u2 = await usageOf(a.token);
    expect(u2.graceUntil).toBe(u1.graceUntil); // unchanged — once per window
  });

  test("adminSetPlan paid→free clears extra storage AND stamps grace", async () => {
    const GiB = 1024 * 1024 * 1024;
    const a = await bootstrap("acct-admin-grace");
    await SELF.fetch(`${BASE}/v1/admin/account/${a.accountId}/plan?plan=pro&extraGB=100`, { method: "POST", headers: PLAT });
    const u1 = await usageOf(a.token);
    expect(u1.plan).toBe("pro");
    expect(u1.storageCap).toBe(250 * GiB + 100 * GiB); // base + extra
    await SELF.fetch(`${BASE}/v1/admin/account/${a.accountId}/plan?plan=free`, { method: "POST", headers: PLAT });
    const u2 = await usageOf(a.token);
    expect(u2.plan).toBe("free");
    expect(u2.storageCap).toBe(2 * GiB); // extras cleared on downgrade
    expect(u2.graceUntil).toBeGreaterThan(Date.now());
  });

  test("retention SKIPS an in-grace account (history preserved, 0 pruned)", async () => {
    const a = await bootstrap("acct-grace-retain");
    // pro → free puts it in grace; give it a workspace so retention iterates it.
    await SELF.fetch(`${BASE}/v1/admin/account/${a.accountId}/plan?plan=pro`, { method: "POST", headers: PLAT });
    await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    await SELF.fetch(`${BASE}/v1/admin/account/${a.accountId}/plan?plan=free`, { method: "POST", headers: PLAT });
    const res = await SELF.fetch(`${BASE}/v1/admin/gc?phase=retention`, { method: "POST", headers: PLAT });
    const body = (await res.json()) as { inGrace: number; pruned: number };
    expect(body.inGrace).toBeGreaterThanOrEqual(1); // the in-grace workspace was skipped
    expect(body.pruned).toBe(0); // nothing deleted during grace
  });

  // ── web auth via Clerk (M11) ─────────────────────────────────────────────

  // Generate a test RSA key, publish it as the JWKS, and sign Clerk-like JWTs.
  const b64url = (buf: ArrayBuffer | Uint8Array) => {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = ""; for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  let priv: CryptoKey;
  const KID = "test-kid-1";
  const ISS = "https://clerk.test";
  const AZP = "https://app.test";

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    priv = pair.privateKey;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string; use?: string; alg?: string };
    jwk.kid = KID; jwk.use = "sig"; jwk.alg = "RS256";
    const { fetchMock } = await import("cloudflare:test");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://clerk.test").intercept({ path: "/.well-known/jwks.json" }).reply(200, JSON.stringify({ keys: [jwk] })).persist();
    // Clerk Backend API (email verification): every sub verified EXCEPT "user_unverified".
    fetchMock
      .get("https://api.clerk.com")
      .intercept({ path: /^\/v1\/users\//, method: "GET" })
      .reply((opts: { path: string }) => {
        const sub = decodeURIComponent(opts.path.split("/").pop() ?? "");
        const status = sub === "user_unverified" ? "unverified" : "verified";
        return { statusCode: 200, data: JSON.stringify({ primary_email_address_id: "e1", email_addresses: [{ id: "e1", verification: { status } }] }) };
      })
      .persist();
  });

  async function signJwt(payload: Record<string, unknown>, opts: { alg?: string; kid?: string } = {}): Promise<string> {
    const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
    const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    if (header.alg === "none") return `${h}.${p}.`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, sub: "user_clerk_1", azp: AZP, exp: now() + 60, nbf: now() - 5, ...over });
  const webExchange = (token: string) =>
    SELF.fetch(`${BASE}/v1/web/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });

  test("valid Clerk JWT → rbox web session token that authenticates", async () => {
    const res = await webExchange(await signJwt(claims()));
    expect(res.status).toBe(200);
    const { token, accountId } = (await res.json()) as { token: string; accountId: string };
    expect(accountId.startsWith("acct_")).toBe(true);
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(token) });
    expect(usage.status).toBe(200);
  });

  test("same Clerk user logging in twice reuses the SAME account (idempotent)", async () => {
    const a1 = (await (await webExchange(await signJwt(claims({ sub: "user_dup" })))).json()) as { accountId: string };
    const a2 = (await (await webExchange(await signJwt(claims({ sub: "user_dup" })))).json()) as { accountId: string };
    expect(a1.accountId).toBe(a2.accountId);
  });

  test("forged signature → 401", async () => {
    const t = await signJwt(claims({ sub: "user_forge" }));
    const tampered = t.slice(0, -4) + (t.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect((await webExchange(tampered)).status).toBe(401);
  });

  test("alg:none → 401 (algorithm-confusion guard)", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_none" }), { alg: "none" }))).status).toBe(401);
  });

  test("wrong issuer → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_iss", iss: "https://evil.test" })))).status).toBe(401);
  });

  test("expired token → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_exp", exp: now() - 120 })))).status).toBe(401);
  });

  test("disallowed azp (origin) → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_azp", azp: "https://evil.test" })))).status).toBe(401);
  });

  test("absent azp → 401 (web route requires origin binding)", async () => {
    const c = claims({ sub: "u_noazp" }); delete (c as Record<string, unknown>).azp;
    expect((await webExchange(await signJwt(c))).status).toBe(401);
  });

  test("unknown kid → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_kid" }), { kid: "nope" }))).status).toBe(401);
  });

  test("JWT whose header/payload decode to non-objects → 401 (not 500)", async () => {
    const nullHeader = `${b64url(new TextEncoder().encode("null"))}.${b64url(new TextEncoder().encode(JSON.stringify(claims())))}.AAAA`;
    expect((await webExchange(nullHeader)).status).toBe(401);
  });

  test("first-login with an UNVERIFIED email → 403 (abuse gate), no account created", async () => {
    const res = await webExchange(await signJwt(claims({ sub: "user_unverified" })));
    expect(res.status).toBe(403);
    // A subsequent call still 403s (no mapping was claimed → gate re-runs).
    expect((await webExchange(await signJwt(claims({ sub: "user_unverified" })))).status).toBe(403);
  });

  // ── E2EE opaque key storage (design 12) ──────────────────────────────────

  const keysBootstrap = (token: string, deviceId: string, over: Record<string, unknown> = {}) =>
    SELF.fetch(`${BASE}/v1/keys/bootstrap`, {
      method: "POST",
      headers: authed(token, { "content-type": "application/json" }),
      body: JSON.stringify({
        recoveryWrap: "rw",
        recoveryWrapId: "rwid",
        genesisRoster: "roster-v0",
        genesisKeyState: "keystate-0",
        device: { deviceId, sigPubKey: "sig", encPubKey: "enc", mkWrap: "mk" },
        ...over,
      }),
    });

  test("keys bootstrap → account read returns genesis material; second bootstrap → 409", async () => {
    const a = await bootstrap("acct-keys");
    expect((await keysBootstrap(a.token, a.deviceId)).status).toBe(200);

    const acct = await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) });
    expect(acct.status).toBe(200);
    const body = (await acct.json()) as { recoveryWrap: string; rosters: string[]; keyStates: string[]; devices: Array<{ deviceId: string }> };
    expect(body.recoveryWrap).toBe("rw");
    expect(body.rosters).toEqual(["roster-v0"]);
    expect(body.keyStates).toEqual(["keystate-0"]);
    expect(body.devices.map((d) => d.deviceId)).toContain(a.deviceId);

    expect((await keysBootstrap(a.token, a.deviceId)).status).toBe(409); // already bootstrapped
  });

  test("keys bootstrap with a device that isn't the caller's → 403", async () => {
    const a = await bootstrap("acct-keys-spoof");
    expect((await keysBootstrap(a.token, "dev_someone_else")).status).toBe(403);
  });

  test("account keys not found before bootstrap → 404", async () => {
    const a = await bootstrap("acct-keys-empty");
    expect((await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).status).toBe(404);
  });

  test("roster append is monotone: next version OK, replay/skew → 409", async () => {
    const a = await bootstrap("acct-roster");
    await keysBootstrap(a.token, a.deviceId); // genesis roster = v0
    const append = (version: number) =>
      SELF.fetch(`${BASE}/v1/keys/roster`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ version, signed: `roster-v${version}` }) });
    expect((await append(1)).status).toBe(200); // exactly next
    expect((await append(1)).status).toBe(409); // replay (already at 1)
    expect((await append(5)).status).toBe(409); // skips ahead
    expect((await append(2)).status).toBe(200); // next again
    const acct = (await (await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).json()) as { rosters: string[] };
    expect(acct.rosters).toEqual(["roster-v0", "roster-v1", "roster-v2"]);
  });

  test("keystate append is monotone by epoch (next OK, replay → 409)", async () => {
    const a = await bootstrap("acct-keystate");
    await keysBootstrap(a.token, a.deviceId); // genesis keystate = epoch 0
    const append = (accountEpoch: number) =>
      SELF.fetch(`${BASE}/v1/keys/keystate`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ accountEpoch, signed: `ks-${accountEpoch}` }) });
    expect((await append(1)).status).toBe(200);
    expect((await append(1)).status).toBe(409);
  });

  test("workspace keys: put + get round-trips; cross-account get → 404", async () => {
    const a = await bootstrap("acct-wskey");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const put = await SELF.fetch(`${BASE}/v1/keys/workspace`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ workspaceId: ws, keyEpoch: 0, kekWrap: "kek-0" }) });
    expect(put.status).toBe(200);
    const got = await SELF.fetch(`${BASE}/v1/keys/workspace/${ws}`, { headers: authed(a.token) });
    expect(got.status).toBe(200);
    expect((await got.json()) as { keys: unknown[] }).toEqual({ keys: [{ keyEpoch: 0, kekWrap: "kek-0" }] });

    // A different account must not see (or even confirm) the workspace's keys.
    const b = await bootstrap("acct-wskey-other");
    expect((await SELF.fetch(`${BASE}/v1/keys/workspace/${ws}`, { headers: authed(b.token) })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/keys/workspace`, { method: "POST", headers: authed(b.token, { "content-type": "application/json" }), body: JSON.stringify({ workspaceId: ws, keyEpoch: 0, kekWrap: "evil" }) })).status).toBe(404);
  });

  // C3: putWorkspaceKey is an immutable CAS — the FIRST wrap wins and a later
  // caller with a DIFFERENT wrap gets the first one back (adopts it, never an UPDATE).
  test("workspace key CAS: second writer with a different wrap gets the FIRST wrap back", async () => {
    const a = await bootstrap("acct-wskey-cas");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const put = (kekWrap: string) =>
      SELF.fetch(`${BASE}/v1/keys/workspace`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ workspaceId: ws, keyEpoch: 0, kekWrap }) });
    const first = (await (await put("kek-first")).json()) as { keyEpoch: number; kekWrap: string };
    expect(first).toEqual({ keyEpoch: 0, kekWrap: "kek-first" });
    // A second, different wrap for the SAME epoch must NOT overwrite — the winning
    // (first) wrap is returned so the loser converges on it.
    const second = (await (await put("kek-second")).json()) as { keyEpoch: number; kekWrap: string };
    expect(second).toEqual({ keyEpoch: 0, kekWrap: "kek-first" });
    // And the stored value is still the first wrap.
    const got = (await (await SELF.fetch(`${BASE}/v1/keys/workspace/${ws}`, { headers: authed(a.token) })).json()) as { keys: Array<{ keyEpoch: number; kekWrap: string }> };
    expect(got.keys).toEqual([{ keyEpoch: 0, kekWrap: "kek-first" }]);
  });

  // C5: /keys/admit inserts device keys AND appends the roster in one D1 batch.
  const admit = (token: string, deviceId: string, version: number, signed: string) =>
    SELF.fetch(`${BASE}/v1/keys/admit`, {
      method: "POST",
      headers: authed(token, { "content-type": "application/json" }),
      body: JSON.stringify({ device: { deviceId, sigPubKey: "sig", encPubKey: "enc", mkWrap: "mk" }, roster: { version, signed } }),
    });

  test("keys/admit: atomic device-keys + roster append (happy path) lands both", async () => {
    const a = await bootstrap("acct-admit");
    await keysBootstrap(a.token, a.deviceId); // genesis roster = v0
    const res = await admit(a.token, "dev_admitted_1", 1, "roster-v1");
    expect(res.status).toBe(200);
    const acct = (await (await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).json()) as { rosters: string[]; devices: Array<{ deviceId: string }> };
    expect(acct.rosters).toEqual(["roster-v0", "roster-v1"]); // roster appended
    expect(acct.devices.map((d) => d.deviceId)).toContain("dev_admitted_1"); // device stored
  });

  test("keys/admit: wrong roster version → 409 AND leaves NO device_keys row (atomic rollback)", async () => {
    const a = await bootstrap("acct-admit-conflict");
    await keysBootstrap(a.token, a.deviceId); // roster at v0, so next is v1
    // Claim v5 (skips ahead) → roster guard fails → batch applies nothing.
    const res = await admit(a.token, "dev_orphan", 5, "roster-v5");
    expect(res.status).toBe(409);
    // The device must NOT have been written (no orphan referencing an un-rostered wrap).
    const row = await env.rbox_dev_db.prepare("SELECT 1 FROM device_keys WHERE device_id = ?").bind("dev_orphan").first();
    expect(row).toBeNull();
    const acct = (await (await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(a.token) })).json()) as { rosters: string[] };
    expect(acct.rosters).toEqual(["roster-v0"]); // roster unchanged
  });

  // C6: the client owns the tokenId (so the grant binds the exact token); the
  // server stores keyed by it and redeem looks it up.
  test("pair/create with a client tokenId redeems by that same tokenId", async () => {
    const a = await bootstrap("acct-pair-tokenid");
    const tokenId = "clientchosen_tokenid_0001"; // 16–64 url-safe chars
    const cr = await SELF.fetch(`${BASE}/v1/auth/pair/create`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ tokenId, mkWrap: "mk-blob", admissionGrant: "grant-blob" }),
    });
    expect(cr.status).toBe(200);
    const { token } = (await cr.json()) as { token: string };
    expect(token).toBe(`rbox-pair_${tokenId}`); // server adopted the client id verbatim
    // Redeem by the client tokenId → mints a working device + returns the bound material.
    const rd = await SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(rd.status).toBe(200);
    const redeemed = (await rd.json()) as { token: string; deviceId: string; mkWrap: string | null; admissionGrant: string | null };
    expect(redeemed.deviceId.startsWith("dev_")).toBe(true);
    expect(redeemed.mkWrap).toBe("mk-blob");
    expect(redeemed.admissionGrant).toBe("grant-blob");
    // Single-use still holds for the client-supplied id.
    expect((await SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).status).toBe(401);
  });

  test("pair/create rejects a malformed client tokenId → 400", async () => {
    const a = await bootstrap("acct-pair-badid");
    const res = await SELF.fetch(`${BASE}/v1/auth/pair/create`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ tokenId: "too-short" }), // < 16 chars
    });
    expect(res.status).toBe(400);
  });

  test("pairing token carries opaque E2EE material through create → redeem", async () => {
    const a = await bootstrap("acct-pair-e2ee");
    const cr = await SELF.fetch(`${BASE}/v1/auth/pair/create`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify({ mkWrap: "mk-wrap-blob", admissionGrant: "grant-blob" }),
    });
    expect(cr.status).toBe(200);
    const { token: pair } = (await cr.json()) as { token: string };
    const rd = await SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair }) });
    expect(rd.status).toBe(200);
    const redeemed = (await rd.json()) as { mkWrap: string | null; admissionGrant: string | null };
    expect(redeemed.mkWrap).toBe("mk-wrap-blob");
    expect(redeemed.admissionGrant).toBe("grant-blob");
  });

  const PLAT = { "x-rbox-platform": "test-platform-secret" };

  test("retention prune is platform-gated (tenant token → 404)", async () => {
    const a = await bootstrap("acct-ret-gate");
    const res = await SELF.fetch(`${BASE}/v1/admin/gc?phase=retention`, { method: "POST", headers: authed(a.token) });
    expect(res.status).toBe(404);
  });

  test("retention prune runs the plan→floor pass over workspaces (no old versions → 0 pruned)", async () => {
    // Exercises the workspaces⋈accounts join + per-plan cutoff query. The DO
    // prune reclaim itself uses ctx.storage.kv (skipped here; verified live, M6) —
    // with no committed versions there's nothing past the window, so no DO call.
    const a = await bootstrap("acct-ret");
    await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    const res = await SELF.fetch(`${BASE}/v1/admin/gc?phase=retention`, { method: "POST", headers: PLAT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: number; pruned: number };
    expect(body.ok).toBe(true);
    expect(body.workspaces).toBeGreaterThanOrEqual(1); // our workspace was in the pass
    expect(body.pruned).toBe(0); // nothing old enough to prune
  });

  // ── Slice 0: token-kind route gate (design 21 §1.1) ──────────────────────
  // Mint a real short-lived `web` session token (expires_at set) via the Clerk
  // exchange, so the gate sees Principal.kind === 'web'.
  async function webToken(sub: string): Promise<string> {
    const r = await webExchange(await signJwt(claims({ sub })));
    expect(r.status).toBe(200);
    return ((await r.json()) as { token: string }).token;
  }

  test("kind-gate: a web session is 403 on credential-mint + crypto/sync routes", async () => {
    const wt = await webToken("user_gate_block");
    // Credential-mint escalation routes (the ones that would let web act durably).
    expect((await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: authed(wt) })).status).toBe(403);
    expect(
      (await SELF.fetch(`${BASE}/v1/auth/device/approve`, { method: "POST", headers: authed(wt, { "content-type": "application/json" }), body: JSON.stringify({ userCode: "AAAA-AAAA" }) })).status
    ).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(wt) })).status).toBe(403);
    // E2EE key storage + blob mutate/check.
    expect((await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(wt) })).status).toBe(403);
    const s = sha("web-cannot-write");
    expect((await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(wt, { "content-length": "16" }), body: "web-cannot-write" })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/blobs/check`, { method: "POST", headers: authed(wt, { "content-type": "application/json" }), body: JSON.stringify({ shas: [s] }) })).status).toBe(403);
  });

  test("kind-gate is DEFAULT-DENY: a web token is 403 on an unlisted route, not just named crypto ones", async () => {
    const wt = await webToken("user_gate_default");
    // /v1/keys/roster isn't individually enumerated anywhere — default-deny still 403s it.
    const res = await SELF.fetch(`${BASE}/v1/keys/roster`, { method: "POST", headers: authed(wt, { "content-type": "application/json" }), body: JSON.stringify({ version: 1, signed: "x" }) });
    expect(res.status).toBe(403);
  });

  test("kind-gate: a web session IS allowed on the read/billing/device allowlist", async () => {
    const wt = await webToken("user_gate_allow");
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(wt) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/auth/devices`, { headers: authed(wt) })).status).toBe(200);
    // Reaches the billing handler (501 — STRIPE_SECRET absent in tests), proving it's NOT gate-blocked.
    expect((await SELF.fetch(`${BASE}/v1/billing/checkout?plan=pro`, { method: "POST", headers: authed(wt) })).status).toBe(501);
  });

  test("kind-gate: a DURABLE token passes exactly where the web token is blocked", async () => {
    const a = await bootstrap("acct-gate-durable");
    expect((await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: authed(a.token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).status).toBe(200);
  });

  // ── Slice 1: schema + provenance (migration 0014, design 21 §3.2/§6) ──────
  const originOf = async (id: string) =>
    (await env.rbox_dev_db.prepare("SELECT origin FROM accounts WHERE id = ?").bind(id).first<{ origin: string | null }>())?.origin ?? null;

  test("provenance: bootstrap stamps origin='bootstrap'; first web session stamps origin='web'", async () => {
    const a = await bootstrap("acct-origin-boot");
    expect(await originOf(a.accountId)).toBe("bootstrap");
    const r = await webExchange(await signJwt(claims({ sub: "user_origin_web" })));
    const { accountId } = (await r.json()) as { accountId: string };
    expect(await originOf(accountId)).toBe("web");
  });

  test("uq_clerk_users_account: a 2nd Clerk id mapping the SAME account is rejected at the DB", async () => {
    const a = await bootstrap("acct-uq");
    await env.rbox_dev_db
      .prepare("INSERT INTO clerk_users (clerk_user_id, account_id, user_id, created_at) VALUES (?, ?, ?, ?)")
      .bind("user_uq_first", a.accountId, "user_uq_a", Date.now())
      .run();
    await expect(
      env.rbox_dev_db
        .prepare("INSERT INTO clerk_users (clerk_user_id, account_id, user_id, created_at) VALUES (?, ?, ?, ?)")
        .bind("user_uq_second", a.accountId, "user_uq_b", Date.now())
        .run()
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("origin backfill (§6): legacy NULL accounts classify data→bootstrap, empty-clerk→web, ambiguous→NULL", async () => {
    // Seed three pre-0014 (origin NULL) accounts, then run the migration's two
    // classification UPDATEs verbatim and assert the three-way split.
    const seed = (id: string) =>
      env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at) VALUES (?, 'legacy', 'free', ?)").bind(id, Date.now()).run();
    await seed("acct_bf_data");
    await seed("acct_bf_shell");
    await seed("acct_bf_ambig");
    // data-bearing account → must classify 'bootstrap'
    await env.rbox_dev_db.prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES ('ws_bf','root',?,?)").bind("acct_bf_data", Date.now()).run();
    // empty clerk-mapped shell → must classify 'web'
    await env.rbox_dev_db.prepare("INSERT INTO clerk_users (clerk_user_id, account_id, user_id, created_at) VALUES ('user_bf','acct_bf_shell','user_bf',?)").bind(Date.now()).run();
    // acct_bf_ambig is referenced by nothing and not clerk-mapped → stays NULL.
    // Active-only regression guard: a clerk-mapped shell whose ONLY artifact is a
    // CONSUMED pairing token must still classify 'web' (not 'bootstrap') — §3.4/§6
    // block on LIVE tokens only.
    await seed("acct_bf_consumed");
    await env.rbox_dev_db.prepare("INSERT INTO clerk_users (clerk_user_id, account_id, user_id, created_at) VALUES ('user_bfc','acct_bf_consumed','user_bfc',?)").bind(Date.now()).run();
    await env.rbox_dev_db
      .prepare("INSERT INTO pairing_tokens (token_hash, account_id, user_id, created_by, label, created_at, expires_at, consumed_at) VALUES ('bfc_hash','acct_bf_consumed','user_bfc','dev_bfc','x',?,?,?)")
      .bind(Date.now() - 2000, Date.now() - 1000, Date.now() - 1500)
      .run();

    await env.rbox_dev_db
      .prepare(
        `UPDATE accounts SET origin='bootstrap' WHERE origin IS NULL AND (
           id IN (SELECT account_id FROM account_keys) OR id IN (SELECT account_id FROM device_keys)
           OR id IN (SELECT account_id FROM rosters) OR id IN (SELECT account_id FROM account_key_states)
           OR id IN (SELECT account_id FROM workspace_keys) OR id IN (SELECT account_id FROM workspaces)
           OR id IN (SELECT account_id FROM blob_refs) OR id IN (SELECT account_id FROM uploads WHERE account_id IS NOT NULL)
           OR id IN (SELECT account_id FROM pairing_tokens WHERE consumed_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER)*1000)
           OR id IN (SELECT account_id FROM device_auth WHERE account_id IS NOT NULL AND status IN ('pending','approved') AND expires_at > CAST(strftime('%s','now') AS INTEGER)*1000)
           OR id IN (SELECT DISTINCT account_id FROM devices WHERE expires_at IS NULL)
           OR plan != 'free' OR stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL
           OR grace_until IS NOT NULL OR extra_storage_bytes != 0 OR used_bytes != 0 )`
      )
      .run();
    await env.rbox_dev_db.prepare("UPDATE accounts SET origin='web' WHERE origin IS NULL AND id IN (SELECT account_id FROM clerk_users)").run();

    expect(await originOf("acct_bf_data")).toBe("bootstrap");
    expect(await originOf("acct_bf_shell")).toBe("web");
    expect(await originOf("acct_bf_ambig")).toBeNull(); // fail-closed
    expect(await originOf("acct_bf_consumed")).toBe("web"); // consumed token ignored (active-only)
  });

  // §9.5 maintenance invariant (design 21): isReclaimableShell gates a DESTRUCTIVE
  // delete, so EVERY account-scoped table must be categorized — covered (blocks
  // reclaim), cleaned (expected shell rows the reclaim deletes), or excluded
  // (append-only forensic log). This test introspects sqlite_master for tables with
  // an `account_id` column and FAILS when a new one appears uncategorized, forcing
  // isReclaimableShell to be updated rather than trusted to reviewer memory.
  test("every account_id-scoped table is categorized in the reclaim predicate (§9.5)", async () => {
    const tables =
      (await env.rbox_dev_db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results ?? [];
    const accountScoped: string[] = [];
    for (const { name } of tables) {
      const cols = (await env.rbox_dev_db.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>()).results ?? [];
      if (cols.some((c) => c.name === "account_id")) accountScoped.push(name);
    }
    // Non-empty presence BLOCKS reclaim (counted in isReclaimableShell):
    const COVERED = ["account_keys", "device_keys", "rosters", "account_key_states", "workspace_keys", "devices", "workspaces", "blob_refs", "uploads", "pairing_tokens", "device_auth", "clerk_users", "memberships"];
    const EXPECTED_CLEANED = ["users"]; // the shell's own user row, DELETEd on reclaim (not a blocker)
    const EXCLUDED = ["audit_log"]; // append-only forensic log (§3.4) — never blocks
    const known = new Set([...COVERED, ...EXPECTED_CLEANED, ...EXCLUDED]);
    const uncategorized = accountScoped.filter((t) => !known.has(t));
    expect(uncategorized).toEqual([]); // ← a NEW account_id table: categorize it in isReclaimableShell + here
  });

  // ── Slice 2: the link ceremony (design 21 §4) ────────────────────────────
  const freshJwt = (sub: string) => signJwt(claims({ sub }));
  // Provision C's web shell (clerk_users row) the way the dashboard does, return its account.
  async function webShell(sub: string): Promise<string> {
    const r = await webExchange(await freshJwt(sub));
    return ((await r.json()) as { accountId: string }).accountId;
  }
  const linkStart = async (sub: string) =>
    SELF.fetch(`${BASE}/v1/account/link/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkToken: await freshJwt(sub) }) });
  const linkRedeem = (token: string, code: string) =>
    SELF.fetch(`${BASE}/v1/account/link/redeem`, { method: "POST", headers: authed(token, { "content-type": "application/json" }), body: JSON.stringify({ code }) });
  const linkStatusPoll = async (pollKey: string, sub: string) =>
    SELF.fetch(`${BASE}/v1/account/link/status?pollKey=${pollKey}`, { headers: { authorization: `Bearer ${await freshJwt(sub)}` } });
  const linkConfirm = async (sub: string, pollKey: string) =>
    SELF.fetch(`${BASE}/v1/account/link/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkToken: await freshJwt(sub), pollKey }) });
  const clerkMap = async (sub: string) =>
    (await env.rbox_dev_db.prepare("SELECT account_id FROM clerk_users WHERE clerk_user_id = ?").bind(sub).first<{ account_id: string }>())?.account_id ?? null;
  // A durable device token with a NON-owner role in an existing account.
  async function durableNonOwner(accountId: string, role: string): Promise<string> {
    const u = `user_${role}_${Math.random().toString(16).slice(2, 8)}`;
    await env.rbox_dev_db.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, ?)").bind(accountId, u, role).run();
    return (await mintDevice(env, accountId, u, "dev", role)).token;
  }

  test("two-phase happy path: start → redeem (pending, no rebind) → confirm (rebind + shell reclaimed)", async () => {
    const sub = "user_link_happy";
    const shell = await webShell(sub);
    const x = await bootstrap("acct-link-x");
    const start = await linkStart(sub);
    expect(start.status).toBe(200);
    const { code, pollKey } = (await start.json()) as { code: string; pollKey: string };
    expect(code.startsWith("rbox-link_")).toBe(true);

    // REDEEM (durable owner on X) records a pending proposal but rebinds NOTHING.
    const rd = await linkRedeem(x.token, code);
    expect(rd.status).toBe(200);
    expect(((await rd.json()) as { account: string }).account).toBe(x.accountId);
    expect(await clerkMap(sub)).toBe(shell); // still the shell — confirm is mandatory

    // STATUS shows the proposed target before commit.
    const st = await linkStatusPoll(pollKey, sub);
    expect(st.status).toBe(200);
    expect(((await st.json()) as { status: string; pendingAccount: string }).pendingAccount).toBe(x.accountId);

    // CONFIRM (same C) commits the rebind.
    const cf = await linkConfirm(sub, pollKey);
    expect(cf.status).toBe(200);
    expect(await clerkMap(sub)).toBe(x.accountId); // C now manages X

    // The empty shell was reclaimed (tombstoned + memberships gone).
    const reclaimed = await env.rbox_dev_db.prepare("SELECT reclaimed_at FROM accounts WHERE id = ?").bind(shell).first<{ reclaimed_at: number | null }>();
    expect(reclaimed?.reclaimed_at).toBeGreaterThan(0);
    const mem = await env.rbox_dev_db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE account_id = ?").bind(shell).first<{ n: number }>();
    expect(mem?.n).toBe(0);

    // A returning web login now resolves C → X (mints a token on the real account).
    const back = await webExchange(await freshJwt(sub));
    expect(((await back.json()) as { accountId: string }).accountId).toBe(x.accountId);
  });

  test("confirm is MANDATORY: a redeem alone never rebinds clerk_users[C]", async () => {
    const sub = "user_link_noconfirm";
    const shell = await webShell(sub);
    const x = await bootstrap("acct-link-noconfirm");
    const { code } = (await (await linkStart(sub)).json()) as { code: string };
    await linkRedeem(x.token, code);
    expect(await clerkMap(sub)).toBe(shell); // unchanged without confirm
  });

  test("redeem requires DURABLE + OWNER: web owner → 403, durable viewer/admin → 403, durable owner → pending", async () => {
    const sub = "user_link_authz";
    await webShell(sub);
    const x = await bootstrap("acct-link-authz");
    const webOwner = await webToken("user_link_authz_web");
    const viewer = await durableNonOwner(x.accountId, "viewer");
    const admin = await durableNonOwner(x.accountId, "admin");
    const fresh = async () => ((await (await linkStart(sub)).json()) as { code: string }).code;

    expect((await linkRedeem(webOwner, await fresh())).status).toBe(403); // web kind blocked by redeemLink
    expect((await linkRedeem(viewer, await fresh())).status).toBe(403);
    expect((await linkRedeem(admin, await fresh())).status).toBe(403);
    expect((await linkRedeem(x.token, await fresh())).status).toBe(200); // durable owner OK
  });

  test("fresh-JWT gate: start/confirm with an invalid Clerk JWT → 401", async () => {
    const good = await freshJwt("user_link_jwtgate");
    const tampered = good.slice(0, -4) + (good.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect((await SELF.fetch(`${BASE}/v1/account/link/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkToken: tampered }) })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/account/link/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkToken: tampered, pollKey: "plk_x" }) })).status).toBe(401);
  });

  test("single-use: a second redeem of a consumed code → 401; an expired code → 401", async () => {
    const sub = "user_link_single";
    await webShell(sub);
    const x = await bootstrap("acct-link-single");
    const { code } = (await (await linkStart(sub)).json()) as { code: string };
    expect((await linkRedeem(x.token, code)).status).toBe(200);
    expect((await linkRedeem(x.token, code)).status).toBe(401); // already consumed
    // Force-expire a fresh code directly in D1 → redeem rejects.
    const { code: code2, pollKey } = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await env.rbox_dev_db.prepare("UPDATE account_link_codes SET expires_at = ? WHERE poll_key = ?").bind(Date.now() - 1000, pollKey).run();
    expect((await linkRedeem(x.token, code2)).status).toBe(401);
  });

  test("conditional confirm aborts (409 already_linked) when another Clerk id already maps the target X", async () => {
    const sub = "user_link_cond";
    await webShell(sub);
    const x = await bootstrap("acct-link-cond");
    // A different Clerk identity already owns X (manually mapped).
    await env.rbox_dev_db.prepare("INSERT INTO clerk_users (clerk_user_id, account_id, user_id, created_at) VALUES ('user_other_clerk', ?, 'user_other', ?)").bind(x.accountId, Date.now()).run();
    const { code, pollKey } = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    expect((await linkRedeem(x.token, code)).status).toBe(200); // pending recorded
    const cf = await linkConfirm(sub, pollKey);
    expect(cf.status).toBe(409); // uq_clerk_users_account → atomic rollback → already_linked
    expect(((await cf.json()) as { error: string }).error).toBe("already_linked");
  });

  test("re-link guard: confirm onto a 2nd account while C is on a bootstrap account → 409 already_linked", async () => {
    const sub = "user_link_relink";
    await webShell(sub);
    const x1 = await bootstrap("acct-relink-1");
    // Link C → X1 first.
    const a = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x1.token, a.code);
    expect((await linkConfirm(sub, a.pollKey)).status).toBe(200);
    expect(await clerkMap(sub)).toBe(x1.accountId);
    // Now try to link C → X2 without unlinking — blocked.
    const x2 = await bootstrap("acct-relink-2");
    const b = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x2.token, b.code);
    const cf = await linkConfirm(sub, b.pollKey);
    expect(cf.status).toBe(409);
    expect(((await cf.json()) as { error: string }).error).toBe("already_linked");
  });

  test("leaked-code property: a stranger redeeming onto their own account Y only creates a pending proposal; no rebind without C's confirm", async () => {
    const sub = "user_link_leak";
    const shell = await webShell(sub);
    const attackerY = await bootstrap("acct-attacker-y");
    // Attacker leaked C's code and redeems it onto their durable owner account Y.
    const { code, pollKey } = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    expect((await linkRedeem(attackerY.token, code)).status).toBe(200);
    // C is NOT rebound — it's only a pending proposal the victim would see + decline.
    expect(await clerkMap(sub)).toBe(shell);
    const st = await linkStatusPoll(pollKey, sub);
    expect(((await st.json()) as { pendingAccount: string }).pendingAccount).toBe(attackerY.accountId);
    // The attacker cannot confirm (no C Clerk JWT). The victim simply never confirms → no commit.
    expect(await clerkMap(sub)).toBe(shell);
  });

  test("shell reclamation only when empty: a shell with a workspace or a subscription → link BLOCKS (409 origin_account_has_state)", async () => {
    const sub = "user_link_dirtyshell";
    const shell = await webShell(sub);
    const x = await bootstrap("acct-link-dirtyshell");
    // Dirty the shell with a workspace (a real account-scoped state row).
    await env.rbox_dev_db.prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES ('ws_dirty','root',?,?)").bind(shell, Date.now()).run();
    const a = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, a.code);
    const cf = await linkConfirm(sub, a.pollKey);
    expect(cf.status).toBe(409);
    expect(((await cf.json()) as { error: string }).error).toBe("origin_account_has_state");
    expect(await clerkMap(sub)).toBe(shell); // never silently rebound

    // Same for billing state on the shell.
    await env.rbox_dev_db.prepare("DELETE FROM workspaces WHERE account_id = ?").bind(shell).run();
    await env.rbox_dev_db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_dirty' WHERE id = ?").bind(shell).run();
    const b = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, b.code);
    expect((await linkConfirm(sub, b.pollKey)).status).toBe(409);
  });

  test("E2EE untouched: redeem + confirm write NO account_keys / rosters / device_keys rows", async () => {
    const sub = "user_link_e2ee";
    await webShell(sub);
    const x = await bootstrap("acct-link-e2ee");
    const count = async (t: string) => (await env.rbox_dev_db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`).bind(x.accountId).first<{ n: number }>())?.n ?? 0;
    const before = [await count("account_keys"), await count("rosters"), await count("device_keys")];
    const a = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, a.code);
    await linkConfirm(sub, a.pollKey);
    expect([await count("account_keys"), await count("rosters"), await count("device_keys")]).toEqual(before); // unchanged (all 0)
  });

  test("unlink: rebinds C → a fresh shell (X no longer Clerk-mapped); blocks if X carries billing", async () => {
    const sub = "user_link_unlink";
    await webShell(sub);
    const x = await bootstrap("acct-link-unlink");
    const a = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, a.code);
    await linkConfirm(sub, a.pollKey);
    expect(await clerkMap(sub)).toBe(x.accountId);
    // Status reports linked.
    expect(((await (await SELF.fetch(`${BASE}/v1/account/status`, { headers: authed(x.token) })).json()) as { linked: boolean }).linked).toBe(true);

    // Billing on X → unlink blocks.
    await env.rbox_dev_db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_x' WHERE id = ?").bind(x.accountId).run();
    expect((await SELF.fetch(`${BASE}/v1/account/unlink`, { method: "POST", headers: authed(x.token) })).status).toBe(409);
    // Clear billing → unlink succeeds, C moves to a fresh shell.
    await env.rbox_dev_db.prepare("UPDATE accounts SET stripe_customer_id = NULL WHERE id = ?").bind(x.accountId).run();
    const un = await SELF.fetch(`${BASE}/v1/account/unlink`, { method: "POST", headers: authed(x.token) });
    expect(un.status).toBe(200);
    const fresh = ((await un.json()) as { account: string }).account;
    expect(await clerkMap(sub)).toBe(fresh);
    expect(fresh).not.toBe(x.accountId);
    expect(((await (await SELF.fetch(`${BASE}/v1/account/status`, { headers: authed(x.token) })).json()) as { linked: boolean }).linked).toBe(false);
  });

  test("idempotent re-confirm: confirming the SAME committed target again → 200 (not 409)", async () => {
    const sub = "user_link_idem";
    await webShell(sub);
    const x = await bootstrap("acct-link-idem");
    const a = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, a.code);
    expect((await linkConfirm(sub, a.pollKey)).status).toBe(200);
    const again = await linkConfirm(sub, a.pollKey); // same poll key, same target
    expect(again.status).toBe(200);
    expect(((await again.json()) as { account: string }).account).toBe(x.accountId);
  });

  // ── Slice 6: rbox subscribe guard + re-point saga (design 21 §3.4.1/§3.4.2) ──
  // These exercise the Stripe surface, which (a) needs STRIPE_SECRET present and
  // (b) makes outbound Stripe calls. The miniflare binding has STRIPE_SECRET ABSENT
  // (so the 501-gate test elsewhere stays valid) and mutating env.STRIPE_SECRET does
  // NOT reach the SELF worker, so we drive the EXPORTED functions directly with the
  // test env (where the mutation IS visible) and mock Stripe via fetchMock. D1, the
  // Clerk JWKS mock, and the webhook (via SELF) are all real.
  const stripeCalls: { path: string; method: string; body: string }[] = [];
  beforeAll(async () => {
    const { fetchMock } = await import("cloudflare:test");
    const pool = fetchMock.get("https://api.stripe.com");
    pool
      .intercept({ path: /^\/v1\/prices/, method: "GET" })
      .reply(200, JSON.stringify({ data: [{ id: "price_test" }] }))
      .persist();
    pool
      .intercept({ path: /^\/v1\//, method: "POST" })
      .reply((o: { path: string; method: string; body?: unknown }) => {
        stripeCalls.push({ path: o.path, method: o.method, body: String(o.body ?? "") });
        if (o.path.startsWith("/v1/checkout/sessions")) return { statusCode: 200, data: JSON.stringify({ url: "https://checkout.stripe.test/cs_test_123" }) };
        return { statusCode: 200, data: JSON.stringify({ id: "obj_test" }) }; // subscriptions/customers PATCH echo
      })
      .persist();
  });
  // Run `fn` with STRIPE_SECRET present (restored after) and a fresh call log.
  async function withStripe<T>(fn: () => Promise<T>): Promise<T> {
    (env as { STRIPE_SECRET?: string }).STRIPE_SECRET = "sk_test_dummy";
    stripeCalls.length = 0;
    try {
      return await fn();
    } finally {
      delete (env as { STRIPE_SECRET?: string }).STRIPE_SECRET;
    }
  }
  const durablePrincipal = (a: { accountId: string; deviceId: string }, userId = "user_x"): Principal => ({ deviceId: a.deviceId, accountId: a.accountId, userId, role: "owner", kind: "durable" });
  const setBilling = (id: string, cust: string, sub: string, plan = "pro") =>
    env.rbox_dev_db.prepare("UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ? WHERE id = ?").bind(cust, sub, plan, id).run();
  const billingOf = (id: string) =>
    env.rbox_dev_db.prepare("SELECT stripe_customer_id AS cust, stripe_subscription_id AS sub, plan FROM accounts WHERE id = ?").bind(id).first<{ cust: string | null; sub: string | null; plan: string }>();
  // Drive confirmLink DIRECTLY (so the worker sees our STRIPE_SECRET + Stripe mock).
  const confirmDirect = async (sub: string, pollKey: string) =>
    confirmLink(new Request(`${BASE}/v1/account/link/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkToken: await freshJwt(sub), pollKey }) }), env, Date.now());

  test("subscribe guard: an account with a live subscription → 409 already_subscribed, ZERO Stripe calls", async () => {
    const a = await bootstrap("acct-sub-guard");
    await setBilling(a.accountId, "cus_guard", "sub_guard", "pro");
    await withStripe(async () => {
      const res = await billingCheckout(new Request(`${BASE}/v1/billing/checkout?plan=pro`, { method: "POST" }), env, durablePrincipal(a));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("already_subscribed");
      expect(stripeCalls.length).toBe(0); // guard runs before any Stripe call (no double-charge)
    });
  });

  test("subscribe: a free account → checkout bound to ITS OWN account; a canceled/grace account may re-subscribe", async () => {
    const a = await bootstrap("acct-sub-free");
    await withStripe(async () => {
      const res = await billingCheckout(new Request(`${BASE}/v1/billing/checkout?plan=pro`, { method: "POST" }), env, durablePrincipal(a));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { url: string }).url).toContain("checkout.stripe.test");
      // The checkout binds the subscription to THIS account (no shell, no identity).
      const checkout = stripeCalls.find((c) => c.path.startsWith("/v1/checkout/sessions"))!;
      expect(checkout.body).toContain(a.accountId); // client_reference_id + metadata[account_id]
    });
    // A canceled-but-in-grace account (sub NULL, grace set) is NOT blocked.
    await env.rbox_dev_db.prepare("UPDATE accounts SET grace_until = ? WHERE id = ?").bind(Date.now() + 1e6, a.accountId).run();
    await withStripe(async () => {
      const res = await billingCheckout(new Request(`${BASE}/v1/billing/checkout?plan=pro`, { method: "POST" }), env, durablePrincipal(a));
      expect(res.status).toBe(200); // grace ≠ subscribed
    });
  });

  test("re-point happy path: confirm runs the saga → sub metadata→X, shell billing cleared, shell reclaimed, C→X", async () => {
    const sub = "user_repoint_happy";
    const shell = await webShell(sub);
    await setBilling(shell, "cus_rp", "sub_rp", "pro"); // user subscribed on the web shell
    const x = await bootstrap("acct-repoint-x"); // billing-empty CLI account
    const { code, pollKey } = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, code);
    await withStripe(async () => {
      const cf = await confirmDirect(sub, pollKey);
      expect(cf.status).toBe(200);
    });
    // C now manages X; billing moved onto X; the shell was cleared + reclaimed.
    expect(await clerkMap(sub)).toBe(x.accountId);
    const bx = await billingOf(x.accountId);
    expect(bx).toMatchObject({ cust: "cus_rp", sub: "sub_rp", plan: "pro" });
    const bs = await billingOf(shell);
    expect(bs).toMatchObject({ cust: null, sub: null, plan: "free" });
    const reclaimed = await env.rbox_dev_db.prepare("SELECT reclaimed_at FROM accounts WHERE id = ?").bind(shell).first<{ reclaimed_at: number | null }>();
    expect(reclaimed?.reclaimed_at).toBeGreaterThan(0);
    // THE DUAL-ROUTING-KEY FIX: the subscription's Stripe metadata was repointed to X.
    const patch = stripeCalls.find((c) => c.path === "/v1/subscriptions/sub_rp")!;
    expect(patch).toBeTruthy();
    expect(patch.body).toContain(x.accountId); // metadata[account_id]=X
  });

  test("webhook-race: a subscription.updated carrying metadata.account_id=X (post-saga) routes to X, never re-binds the shell", async () => {
    const shell = `acct_race_shell_${Math.random().toString(16).slice(2, 8)}`;
    await env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, origin, created_at) VALUES (?, 'web', 'pro', 'web', ?)").bind(shell, Date.now()).run();
    await setBilling(shell, "cus_race", "sub_race", "pro");
    const x = await bootstrap("acct-race-x");
    await withStripe(async () => {
      expect(await repointBillingToAccount(env, shell, x.accountId, Date.now())).toBe("repointed");
    });
    // Billing now on X, shell cleared. A renewal webhook (metadata→X, as Stripe now holds it) arrives.
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: `evt_race_${shell}`,
      type: "customer.subscription.updated",
      data: { object: { id: "sub_race", status: "active", customer: "cus_race", metadata: { account_id: x.accountId }, items: { data: [{ price: { lookup_key: "rbox_pro_monthly" } }] } } },
    });
    const { createHmac } = await import("node:crypto");
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test_secret").update(`${t}.${body}`).digest("hex")}`;
    expect((await SELF.fetch(`${BASE}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body })).status).toBe(200);
    expect((await billingOf(x.accountId))?.plan).toBe("pro"); // routed to X
    expect((await billingOf(shell))?.cust).toBeNull(); // shell NOT re-bound (the split-brain that the fix prevents)
  });

  test("idempotent replay: re-running the saga after a completed move does nothing (no second Stripe call, no double-bind)", async () => {
    const shell = `acct_idem_shell_${Math.random().toString(16).slice(2, 8)}`;
    await env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, origin, created_at) VALUES (?, 'web', 'pro', 'web', ?)").bind(shell, Date.now()).run();
    await setBilling(shell, "cus_idem", "sub_idem", "pro");
    const x = await bootstrap("acct-idem-x");
    await withStripe(async () => {
      expect(await repointBillingToAccount(env, shell, x.accountId, Date.now())).toBe("repointed");
      const afterFirst = stripeCalls.length;
      expect(afterFirst).toBeGreaterThan(0);
      // Replay: the shell is now billing-empty → nothing to migrate, no Stripe call.
      stripeCalls.length = 0;
      expect(await repointBillingToAccount(env, shell, x.accountId, Date.now())).toBe("not_migratable");
      expect(stripeCalls.length).toBe(0);
    });
    expect((await billingOf(x.accountId))?.sub).toBe("sub_idem"); // exactly one sub on X (no double)
  });

  test("destination_has_subscription: confirm BLOCKS (409, never merges) when X already has a sub; no Stripe write", async () => {
    const sub = "user_repoint_destsub";
    const shell = await webShell(sub);
    await setBilling(shell, "cus_ds", "sub_ds", "pro");
    const x = await bootstrap("acct-destsub-x");
    await setBilling(x.accountId, "cus_x_existing", "sub_x_existing", "solo"); // X already pays
    const { code, pollKey } = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, code);
    await withStripe(async () => {
      const cf = await confirmDirect(sub, pollKey);
      expect(cf.status).toBe(409);
      expect(((await cf.json()) as { error: string }).error).toBe("destination_has_subscription");
      expect(stripeCalls.length).toBe(0); // blocked in preflight, before any metadata update
    });
    expect(await clerkMap(sub)).toBe(shell); // not rebound
    expect((await billingOf(x.accountId))?.sub).toBe("sub_x_existing"); // X's sub untouched
  });

  test("non-billing shell state still BLOCKS even with billing present (saga never half-moves a shell that would block anyway)", async () => {
    const sub = "user_repoint_dirty";
    const shell = await webShell(sub);
    await setBilling(shell, "cus_dirty2", "sub_dirty2", "pro");
    await env.rbox_dev_db.prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES ('ws_rp_dirty','root',?,?)").bind(shell, Date.now()).run();
    const x = await bootstrap("acct-repoint-dirty-x");
    const { code, pollKey } = (await (await linkStart(sub)).json()) as { code: string; pollKey: string };
    await linkRedeem(x.token, code);
    await withStripe(async () => {
      const cf = await confirmDirect(sub, pollKey);
      expect(cf.status).toBe(409);
      expect(((await cf.json()) as { error: string }).error).toBe("origin_account_has_state");
      expect(stripeCalls.length).toBe(0); // ignoreBilling check fails (workspace) → saga not run
    });
    expect((await billingOf(shell))?.sub).toBe("sub_dirty2"); // billing NOT moved off the shell
    expect((await billingOf(x.accountId))?.sub).toBeNull();
  });
});

describe("release distribution (design 14)", () => {
  beforeAll(async () => {
    await env.rbox_releases.put("releases/version.json", '{"version":"0.0.2"}');
    await env.rbox_releases.put("releases/version.json.sig", "sig-bytes");
    await env.rbox_releases.put("releases/install.sh", "#!/bin/sh\n");
    await env.rbox_releases.put("releases/rbox-linux-x64", "LATEST-BIN");
    await env.rbox_releases.put("releases/v0.0.2/rbox-linux-x64", "VERSIONED-BIN");
  });

  test("/version + /version.sig serve from the release bucket, no-cache", async () => {
    const v = await SELF.fetch(`${BASE}/version`);
    expect(v.status).toBe(200);
    expect(v.headers.get("cache-control")).toBe("no-cache");
    expect(((await v.json()) as { version: string }).version).toBe("0.0.2");
    expect((await SELF.fetch(`${BASE}/version.sig`)).status).toBe(200);
  });

  test("versioned binary is immutable-cached; latest alias is short-cached", async () => {
    const versioned = await SELF.fetch(`${BASE}/bin/v0.0.2/rbox-linux-x64`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("cache-control")).toContain("immutable");
    expect(await versioned.text()).toBe("VERSIONED-BIN");
    const latest = await SELF.fetch(`${BASE}/bin/rbox-linux-x64`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("rejects bad name / bad version / path traversal; 404s are no-store", async () => {
    for (const bad of ["/bin/evil", "/bin/v0.0.2/evil", "/bin/notaversion/rbox-linux-x64", "/bin/rbox-windows-x64"]) {
      const r = await SELF.fetch(`${BASE}${bad}`);
      expect(r.status).toBe(404);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    const missing = await SELF.fetch(`${BASE}/bin/v9.9.9/rbox-linux-x64`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });
});

// The telemetry layer's privacy contract: a route template fed to a metric
// dimension must never carry a raw workspace/project/sha/device/account id (design
// doc §5 metadata threat model). These are the dynamic-segment shapes this API mints.
describe("routeTemplate privacy masking", () => {
  const realSha = sha("some-content");
  // Real id prefixes this API actually mints (auth.ts): acct_/user_/dev_/web_, ws_.
  const cases: Array<[string, string]> = [
    [`/v1/ws/ws_ab12cd34/proj/root/manifests/42`, "/v1/ws/:ws/proj/:proj/manifests/:n"],
    [`/v1/ws/ws_ab12cd34/proj/my-secret-dir/latest`, "/v1/ws/:ws/proj/:proj/latest"],
    [`/v1/blobs/${realSha}`, "/v1/blobs/:sha"],
    [`/v1/blobs/${realSha}/multipart/3f9a1c2e-1b4d-4e6a-9c8b-0a1b2c3d4e5f/part/7`, "/v1/blobs/:sha/multipart/:uploadId/part/:n"],
    [`/v1/auth/devices/dev_9f8e7d/revoke`, "/v1/auth/devices/:id/revoke"],
    [`/v1/auth/devices/web_aabb/revoke`, "/v1/auth/devices/:id/revoke"],
    [`/v1/admin/account/acct_11223344/plan`, "/v1/admin/account/:id/plan"],
    [`/v1/keys/workspace/ws_zzz999`, "/v1/keys/workspace/:ws"],
    [`/bin/v0.1.2/rbox-darwin-arm64`, "/bin/:ver/:bin"],
    ["/health", "/health"], // static vocabulary is untouched
    // A project literally NAMED after a vocab word must still be masked (the project
    // id is user-chosen) — positional masking beats the allowlist for the proj slot.
    [`/v1/ws/ws_ab/proj/latest/manifests`, "/v1/ws/:ws/proj/:proj/manifests"],
    [`/v1/ws/ws_ab/proj/account/latest`, "/v1/ws/:ws/proj/:proj/latest"],
    // Project named exactly "proj" must NOT clobber the action after it (index-pinned slot).
    [`/v1/ws/ws_ab/proj/proj/latest`, "/v1/ws/:ws/proj/:proj/latest"],
    // ...but real static routes that share a word with a slot are NOT clobbered:
    ["/v1/account/usage", "/v1/account/usage"],
    ["/v1/blobs/check", "/v1/blobs/check"],
    // Allowlist guarantee: an entirely unknown / user-supplied segment is masked,
    // never echoed — this is the case a blocklist would have leaked.
    ["/v1/totally-made-up/../etc/passwd", "/v1/:x/:x/:x/:x"],
    [`/v1/account/acct_secret_leak`, "/v1/account/:id"],
  ];
  for (const [input, expected] of cases) {
    test(`${input} → ${expected}`, () => {
      const out = routeTemplate(input);
      expect(out).toBe(expected);
      // Belt-and-suspenders: no concrete id/secret survives into the template.
      for (const secret of ["ws_ab12cd34", "my-secret-dir", realSha, "dev_9f8e7d", "web_aabb", "acct_11223344", "acct_secret_leak", "ws_zzz999", "passwd", "made-up"]) {
        if (input.includes(secret)) expect(out).not.toContain(secret);
      }
    });
  }
});

describe("metrics OpSpan / D1 attribution", () => {
  test("span.db proxy counts + times every D1 statement (incl. failures)", async () => {
    const { OpSpan } = await import("../src/metrics.js");
    const span = new OpSpan();
    const db = span.db(env.rbox_dev_db);
    // two successful statements through the proxy
    await db.prepare("SELECT 1").first();
    await db.prepare("SELECT sha256 FROM blobs WHERE sha256 = ?").bind(sha("nope")).all();
    expect(span.dbCalls).toBe(2);
    expect(span.dbMs).toBeGreaterThanOrEqual(0);
    // a failing statement is STILL counted + timed (try/finally), not dropped
    await expect(db.prepare("SELECT * FROM table_that_does_not_exist").all()).rejects.toBeDefined();
    expect(span.dbCalls).toBe(3);
  });

  test("r2 span records on throw; ms + doMs accumulate", async () => {
    const { OpSpan } = await import("../src/metrics.js");
    const span = new OpSpan();
    await span.r2(async () => "ok");
    await expect(span.r2(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    span.doMs += 1; // doMs is set directly (the only DO timing is the synchronous transactionSync)
    expect(span.storeMs).toBeGreaterThanOrEqual(0);
    expect(span.doMs).toBe(1);
    expect(span.ms).toBeGreaterThanOrEqual(0); // span owns its own elapsed clock now
    // bind-chaining through the proxy preserves counting
    const span2 = new OpSpan();
    await span2.db(env.rbox_dev_db).prepare("SELECT ?").bind(1).first();
    expect(span2.dbCalls).toBe(1);
  });
});
