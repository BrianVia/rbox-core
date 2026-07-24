import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import {
  ackKeyDelivery,
  fetchKeyDeliveryRequest,
  pollKeyDelivery,
  publicKeyFingerprint,
  queueKeyDelivery,
  requestIdForDeviceCode,
  submitKeyDeliveryBlob,
  sweepKeyDeliveries,
  type DevicePublicKeys,
} from "../src/auth/key-delivery.js";
import { approveDeviceAuthDev } from "../src/auth/device-code.js";
import { claimDeviceAuthWithEscrow, recoverEscrowedDeviceToken } from "../src/auth/mint.js";
import { revokeDevice } from "../src/auth/devices.js";
import { sha256Hex } from "../src/util.js";
import type { Principal } from "../src/authz.js";

const BASE = "https://example.com";

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

function b64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function keys(seed: number): DevicePublicKeys {
  return {
    encPubKey: b64url(new Uint8Array(384).fill(seed)),
    sigPubKey: b64url(new Uint8Array(32).fill(seed)),
  };
}

interface Boot {
  token: string;
  accountId: string;
  deviceId: string;
  userId: string;
  principal: Principal;
}

async function bootstrap(name: string): Promise<Boot> {
  const response = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string; accountId: string; deviceId: string };
  const row = await env.rbox_dev_db
    .prepare("SELECT user_id FROM devices WHERE device_id=?")
    .bind(body.deviceId)
    .first<{ user_id: string }>();
  const userId = row!.user_id;
  return {
    ...body,
    userId,
    principal: {
      deviceId: body.deviceId,
      accountId: body.accountId,
      userId,
      role: "owner",
      kind: "device",
    },
  };
}

async function seedEpoch(accountId: string, epoch = 0): Promise<void> {
  await env.rbox_dev_db.prepare(
    "INSERT OR IGNORE INTO account_key_states(account_id,account_epoch,signed,created_at) VALUES (?,?,?,?)",
  ).bind(accountId, epoch, `epoch-${epoch}`, Date.now()).run();
}

interface Queued {
  deviceCode: string;
  requestId: string;
  userCode: string;
  proposedDeviceId: string;
  publicKeys: DevicePublicKeys;
  expiresAt: number;
}

async function seedQueued(
  account: Boot,
  suffix: string,
  publicKeys = keys((suffix.charCodeAt(0) % 200) + 1),
  now = Date.now(),
): Promise<Queued> {
  await seedEpoch(account.accountId);
  const deviceCode = (await sha256Hex(`device-code-${account.accountId}-${suffix}`)).slice(0, 64);
  const requestId = await requestIdForDeviceCode(deviceCode);
  const userCode = `KD${suffix.padStart(2, "0")}`.padEnd(8, "A");
  const proposedDeviceId = `dev_kd_${(await sha256Hex(`${account.accountId}:${suffix}`)).slice(0, 24)}`;
  const expiresAt = now + 10 * 60 * 1000;
  await env.rbox_dev_db.prepare(
    `INSERT INTO device_auth
       (device_code,user_code,status,device_id,label,created_at,expires_at,account_id,user_id,
        enc_pub_key,sig_pub_key,pubkeys_captured_at,request_id)
     VALUES (?,?,'pending',?,'key-delivery-test',?,?,?,?,?,?,?,?)`,
  ).bind(
    deviceCode,
    userCode,
    proposedDeviceId,
    now,
    expiresAt,
    null,
    null,
    publicKeys.encPubKey,
    publicKeys.sigPubKey,
    now,
    requestId,
  ).run();
  const queued = await queueKeyDelivery(env, {
    requestId,
    userCode,
    accountId: account.accountId,
    userId: account.userId,
    ...publicKeys,
    fingerprint: b64url(new Uint8Array(32).fill(3)),
    approvalTokenHash: await sha256Hex(`approval-${account.accountId}-${suffix}`),
    approvalFactorVerifiedAt: now,
    accountEpoch: 0,
    now,
    deviceCodeExpiresAt: expiresAt,
  });
  expect(queued.ok).toBe(true);
  return { deviceCode, requestId, userCode, proposedDeviceId, publicKeys, expiresAt };
}

async function claim(account: Boot, queued: Queued, extra: Partial<Parameters<typeof claimDeviceAuthWithEscrow>[1]> = {}) {
  return claimDeviceAuthWithEscrow(env, {
    deviceCode: queued.deviceCode,
    requestId: queued.requestId,
    accountId: account.accountId,
    userId: account.userId,
    label: "target",
    proposedDeviceId: queued.proposedDeviceId,
    expiresAt: queued.expiresAt,
    ip: null,
    geo: null,
    ...extra,
  });
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("design 189 key-delivery state machine", () => {
  test("queue → fetch → single fulfill → stable poll → ACK scrub, with idempotent retries", async () => {
    const account = await bootstrap("kd-transition");
    const queued = await seedQueued(account, "transition", keys(31));
    const minted = await claim(account, queued);
    expect(minted).toBeTruthy();

    const optedOut = await fetchKeyDeliveryRequest(
      jsonRequest("/v1/auth/key-delivery/fetch", { requestId: queued.requestId, keyReleaseOptIn: false }),
      env,
      { ...account.principal, role: "viewer" },
    );
    expect(await optedOut.json()).toEqual({ request: null, keyReleaseEnabled: false });
    const fetch = await fetchKeyDeliveryRequest(
      jsonRequest("/v1/auth/key-delivery/fetch", { requestId: queued.requestId, keyReleaseOptIn: true }),
      env,
      { ...account.principal, role: "viewer" },
    );
    expect(fetch.status).toBe(200);
    expect(await fetch.json()).toMatchObject({
      request: {
        requestId: queued.requestId,
        targetDeviceId: minted!.deviceId,
        encPubKey: queued.publicKeys.encPubKey,
        accountEpoch: 0,
      },
    });

    const wrap = "opaque-device-context-wrap";
    await env.rbox_dev_db.batch([
      env.rbox_dev_db.prepare(
        "INSERT INTO rosters(account_id,version,signed,created_at) VALUES (?,0,'roster-0',?)",
      ).bind(account.accountId, Date.now()),
      env.rbox_dev_db.prepare(
        "INSERT INTO device_keys(device_id,account_id,sig_pubkey,enc_pubkey,mk_wrap,created_at) VALUES (?,?,?,?,?,?)",
      ).bind(
        minted!.deviceId,
        account.accountId,
        queued.publicKeys.sigPubKey,
        queued.publicKeys.encPubKey,
        wrap,
        Date.now(),
      ),
    ]);
    const submitBody = {
      requestId: queued.requestId,
      mkWrapDevice: wrap,
      publishedRosterVersion: 0,
      accountEpoch: 0,
    };
    const submit = await submitKeyDeliveryBlob(
      jsonRequest("/v1/auth/key-delivery/submit", submitBody),
      env,
      account.principal,
    );
    expect(submit.status).toBe(200);
    const exactRetry = await submitKeyDeliveryBlob(
      jsonRequest("/v1/auth/key-delivery/submit", submitBody),
      env,
      account.principal,
    );
    expect(await exactRetry.json()).toMatchObject({ ok: true, alreadyFulfilled: true });
    const conflicting = await submitKeyDeliveryBlob(
      jsonRequest("/v1/auth/key-delivery/submit", { ...submitBody, mkWrapDevice: "different" }),
      env,
      account.principal,
    );
    expect(conflicting.status).toBe(409);

    const firstPoll = await pollKeyDelivery(env, queued.requestId);
    const secondPoll = await pollKeyDelivery(env, queued.requestId);
    expect(firstPoll).toEqual(secondPoll);
    expect(firstPoll).toMatchObject({
      status: "ready",
      requestId: queued.requestId,
      mkWrapDevice: wrap,
      publishedRosterVersion: 0,
      accountEpoch: 0,
    });

    const target: Principal = { ...account.principal, deviceId: minted!.deviceId };
    const ack = await ackKeyDelivery(
      jsonRequest("/v1/auth/key-delivery/ack", { requestId: queued.requestId }),
      env,
      target,
    );
    expect(await ack.json()).toEqual({ ok: true, alreadyDelivered: false });
    const reAck = await ackKeyDelivery(
      jsonRequest("/v1/auth/key-delivery/ack", { requestId: queued.requestId }),
      env,
      target,
    );
    expect(await reAck.json()).toEqual({ ok: true, alreadyDelivered: true });
    const terminal = await env.rbox_dev_db.prepare(
      "SELECT state,wrap_blob,published_roster_version FROM key_delivery WHERE request_id=?",
    ).bind(queued.requestId).first();
    expect(terminal).toEqual({ state: "delivered", wrap_blob: null, published_roster_version: null });
    expect(await recoverEscrowedDeviceToken(env, queued.requestId)).toBeNull();
  });

  test("claim crash recovery and concurrent polls converge on one bearer and one mint", async () => {
    const account = await bootstrap("kd-claim-recovery");
    const crashed = await seedQueued(account, "crash", keys(41));
    await expect(claim(account, crashed, {
      afterCommit: () => {
        throw new Error("injected after claim batch");
      },
    })).rejects.toThrow("injected after claim batch");
    const recovered = await claim(account, crashed);
    expect(recovered).toBeTruthy();
    expect((await recoverEscrowedDeviceToken(env, crashed.requestId))?.token).toBe(recovered!.token);

    const concurrent = await seedQueued(account, "concurrent", keys(42));
    const [left, right] = await Promise.all([claim(account, concurrent), claim(account, concurrent)]);
    expect(left?.token).toBeTruthy();
    expect(right?.token).toBe(left?.token);
    const row = await env.rbox_dev_db.prepare(
      "SELECT target_device_id FROM key_delivery WHERE request_id=?",
    ).bind(concurrent.requestId).first<{ target_device_id: string }>();
    const deviceCount = await env.rbox_dev_db.prepare(
      "SELECT COUNT(*) AS n FROM devices WHERE device_id=?",
    ).bind(row!.target_device_id).first<{ n: number }>();
    const escrowCount = await env.rbox_dev_db.prepare(
      "SELECT COUNT(*) AS n FROM device_token_escrow WHERE request_id=?",
    ).bind(concurrent.requestId).first<{ n: number }>();
    expect(deviceCount?.n).toBe(1);
    expect(escrowCount?.n).toBe(1);
  });

  test("mint collision retargets delivery to the actual device id", async () => {
    const account = await bootstrap("kd-retarget");
    const queued = await seedQueued(account, "collision", keys(51));
    await env.rbox_dev_db.prepare(
      "INSERT INTO devices(token_hash,device_id,label,account_id,user_id,created_at,revoked,expires_at,kind) VALUES (?,?,?,?,?,?,0,NULL,'device')",
    ).bind(
      await sha256Hex("collision-token"),
      queued.proposedDeviceId,
      "collision",
      account.accountId,
      account.userId,
      Date.now(),
    ).run();
    const minted = await claim(account, queued);
    expect(minted?.deviceId).not.toBe(queued.proposedDeviceId);
    const delivery = await env.rbox_dev_db.prepare(
      `SELECT kd.target_device_id,da.device_id AS auth_device_id
       FROM key_delivery kd JOIN device_auth da ON da.request_id=kd.request_id
       WHERE kd.request_id=?`,
    ).bind(queued.requestId).first<{ target_device_id: string; auth_device_id: string }>();
    expect(delivery?.target_device_id).toBe(minted?.deviceId);
    expect(delivery?.auth_device_id).toBe(minted?.deviceId);
  });

  test("revoke atomically fences and scrubs an undelivered target", async () => {
    const account = await bootstrap("kd-revoke");
    const queued = await seedQueued(account, "revoke", keys(61));
    const minted = await claim(account, queued);
    await env.rbox_dev_db.prepare(
      "UPDATE key_delivery SET state='fulfilled',wrap_blob='secret-wrap',published_roster_version=0 WHERE request_id=?",
    ).bind(queued.requestId).run();
    const revoke = await revokeDevice(env, account.principal, minted!.deviceId);
    expect(revoke.status).toBe(200);
    const row = await env.rbox_dev_db.prepare(
      "SELECT state,wrap_blob,published_roster_version FROM key_delivery WHERE request_id=?",
    ).bind(queued.requestId).first();
    expect(row).toEqual({ state: "expired", wrap_blob: null, published_roster_version: null });
    expect(await recoverEscrowedDeviceToken(env, queued.requestId)).toBeNull();
    expect((await pollKeyDelivery(env, queued.requestId))?.status).toBe("expired");
    const fetch = await fetchKeyDeliveryRequest(
      jsonRequest("/v1/auth/key-delivery/fetch", { requestId: queued.requestId, keyReleaseOptIn: true }),
      env,
      account.principal,
    );
    expect(await fetch.json()).toEqual({ request: null });
    const submit = await submitKeyDeliveryBlob(
      jsonRequest("/v1/auth/key-delivery/submit", {
        requestId: queued.requestId,
        mkWrapDevice: "secret-wrap",
        publishedRosterVersion: 0,
        accountEpoch: 0,
      }),
      env,
      account.principal,
    );
    expect(submit.status).not.toBe(200);
    const ack = await ackKeyDelivery(
      jsonRequest("/v1/auth/key-delivery/ack", { requestId: queued.requestId }),
      env,
      { ...account.principal, deviceId: minted!.deviceId },
    );
    expect(ack.status).not.toBe(200);
  });

  test("duplicate live target and per-account active cap are atomic; terminal rows free capacity", async () => {
    const account = await bootstrap("kd-caps");
    const first = await seedQueued(account, "cap-1", keys(71));

    const duplicateCode = (await sha256Hex(`${account.accountId}:duplicate`)).slice(0, 64);
    const duplicateRequest = await requestIdForDeviceCode(duplicateCode);
    await env.rbox_dev_db.prepare(
      `INSERT INTO device_auth
         (device_code,user_code,status,device_id,created_at,expires_at,enc_pub_key,sig_pub_key,pubkeys_captured_at,request_id)
       VALUES (?,'DUPL-0001','pending','dev_dup',?,?,?,?,?,?)`,
    ).bind(
      duplicateCode,
      Date.now(),
      Date.now() + 600_000,
      keys(71).encPubKey,
      keys(71).sigPubKey,
      Date.now(),
      duplicateRequest,
    ).run();
    const duplicateInput = {
      requestId: duplicateRequest,
      userCode: "DUPL-0001",
      accountId: account.accountId,
      userId: account.userId,
      ...keys(71),
      fingerprint: b64url(new Uint8Array(32).fill(4)),
      approvalTokenHash: await sha256Hex("duplicate-approval"),
      approvalFactorVerifiedAt: Date.now(),
      accountEpoch: 0,
      now: Date.now(),
      deviceCodeExpiresAt: Date.now() + 600_000,
    };
    const duplicate = await queueKeyDelivery(env, duplicateInput);
    expect(duplicate).toEqual({ ok: false, reason: "duplicate" });
    // The uniqueness index is state-based, so queueing must first terminalize
    // an elapsed live row and immediately free the same public key.
    await env.rbox_dev_db.prepare(
      "UPDATE key_delivery SET expires_at=? WHERE request_id=?",
    ).bind(Date.now() - 1, first.requestId).run();
    expect((await queueKeyDelivery(env, { ...duplicateInput, now: Date.now() })).ok).toBe(true);

    for (let i = 2; i <= 5; i++) await seedQueued(account, `cap-${i}`, keys(70 + i));
    const sixthCode = (await sha256Hex(`${account.accountId}:sixth`)).slice(0, 64);
    const sixthRequest = await requestIdForDeviceCode(sixthCode);
    await env.rbox_dev_db.prepare(
      `INSERT INTO device_auth
         (device_code,user_code,status,device_id,created_at,expires_at,enc_pub_key,sig_pub_key,pubkeys_captured_at,request_id)
       VALUES (?,'CAP6-0001','pending','dev_cap6',?,?,?,?,?,?)`,
    ).bind(
      sixthCode,
      Date.now(),
      Date.now() + 600_000,
      keys(89).encPubKey,
      keys(89).sigPubKey,
      Date.now(),
      sixthRequest,
    ).run();
    const sixthInput = {
      requestId: sixthRequest,
      userCode: "CAP6-0001",
      accountId: account.accountId,
      userId: account.userId,
      ...keys(89),
      fingerprint: b64url(new Uint8Array(32).fill(5)),
      approvalTokenHash: await sha256Hex("sixth-approval"),
      approvalFactorVerifiedAt: Date.now(),
      accountEpoch: 0,
      now: Date.now(),
      deviceCodeExpiresAt: Date.now() + 600_000,
    };
    expect(await queueKeyDelivery(env, sixthInput)).toEqual({ ok: false, reason: "cap" });
    await env.rbox_dev_db.prepare(
      "UPDATE key_delivery SET state='delivered' WHERE request_id=?",
    ).bind(duplicateRequest).run();
    expect((await queueKeyDelivery(env, sixthInput)).ok).toBe(true);
  });

  test("delivery expiry is clamped to the device-code TTL when queued after login start", async () => {
    // Regression (rig web-pairing, 2026-07-23): device-code expiry is anchored at
    // login-start, delivery TTL at queue-time. With equal 10min TTLs, an unclamped
    // `now + TTL` always lands *after* the device-code expiry, so the CLI rejects
    // the delivery ("outside the device-code TTL") and 189 enroll never completes.
    // The prior tests all queued at Δ=0 (now == device-code start), landing exactly
    // on the boundary — the advancing-clock blind spot. This asserts Δ>0 is clamped.
    const account = await bootstrap("kd-clamp");
    await seedEpoch(account.accountId, 0);
    const start = Date.now();
    const deviceCodeExpiresAt = start + 600_000;
    const code = (await sha256Hex(`${account.accountId}:clamp`)).slice(0, 64);
    const request = await requestIdForDeviceCode(code);
    await env.rbox_dev_db.prepare(
      `INSERT INTO device_auth
         (device_code,user_code,status,device_id,created_at,expires_at,enc_pub_key,sig_pub_key,pubkeys_captured_at,request_id)
       VALUES (?,'CLMP-0001','pending','dev_clmp',?,?,?,?,?,?)`,
    ).bind(code, start, deviceCodeExpiresAt, keys(51).encPubKey, keys(51).sigPubKey, start, request).run();
    const queueNow = start + 120_000; // 2min into the 10min window
    const queued = await queueKeyDelivery(env, {
      requestId: request,
      userCode: "CLMP-0001",
      accountId: account.accountId,
      userId: account.userId,
      ...keys(51),
      fingerprint: b64url(new Uint8Array(32).fill(6)),
      approvalTokenHash: await sha256Hex("clamp-approval"),
      approvalFactorVerifiedAt: queueNow,
      accountEpoch: 0,
      now: queueNow,
      deviceCodeExpiresAt,
    });
    expect(queued.ok).toBe(true);
    // Pinned to the device-code expiry, NOT queueNow + 10min (= start + 12min).
    if (queued.ok) expect(queued.expiresAt).toBe(deviceCodeExpiresAt);
    const row = await env.rbox_dev_db
      .prepare("SELECT expires_at FROM key_delivery WHERE request_id=?")
      .bind(request).first<{ expires_at: number }>();
    expect(row?.expires_at).toBe(deviceCodeExpiresAt);
  });

  describe("design 192 dev-only scriptable approve (approve-dev)", () => {
    const DEV_SECRET = "test-bootstrap-secret";
    async function seedPendingAuth(account: Boot, userCode: string, publicKeys: DevicePublicKeys) {
      await seedEpoch(account.accountId);
      const deviceCode = (await sha256Hex(`da-${account.accountId}-${userCode}`)).slice(0, 64);
      const requestId = await requestIdForDeviceCode(deviceCode);
      const now = Date.now();
      await env.rbox_dev_db.prepare(
        `INSERT INTO device_auth
           (device_code,user_code,status,device_id,label,created_at,expires_at,account_id,user_id,
            enc_pub_key,sig_pub_key,pubkeys_captured_at,request_id)
         VALUES (?,?,'pending',?,'approve-dev-test',?,?,?,?,?,?,?,?)`,
      ).bind(
        deviceCode, userCode, `dev_da_${userCode.replace("-", "")}`, now, now + 600_000,
        null, null, publicKeys.encPubKey, publicKeys.sigPubKey, now, requestId,
      ).run();
      return { deviceCode, requestId };
    }

    test("prod env makes the hook return 404 and never queues a delivery", async () => {
      const account = await bootstrap("da-prod-gate");
      const keys192 = keys(101);
      const { requestId } = await seedPendingAuth(account, "DAAA-AAAB", keys192);
      const fingerprint = await publicKeyFingerprint(keys192);
      const res = await approveDeviceAuthDev(
        jsonRequest("/v1/auth/device/approve-dev", { userCode: "DAAA-AAAB", pubkeyFingerprint: fingerprint, bootstrapSecret: DEV_SECRET }),
        { ...env, RBOX_ENV: "prod" },
        account.principal,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(await env.rbox_dev_db.prepare("SELECT 1 FROM key_delivery WHERE request_id=?").bind(requestId).first()).toBeNull();
      const auth = await env.rbox_dev_db.prepare("SELECT status FROM device_auth WHERE request_id=?").bind(requestId).first<{ status: string }>();
      expect(auth?.status).toBe("pending");
    });

    test("wrong operator secret is unauthorized and never queues (dev env)", async () => {
      const account = await bootstrap("da-bad-secret");
      const keys192 = keys(102);
      const { requestId } = await seedPendingAuth(account, "DAAC-AAAA", keys192);
      const fingerprint = await publicKeyFingerprint(keys192);
      const res = await approveDeviceAuthDev(
        jsonRequest("/v1/auth/device/approve-dev", { userCode: "DAAC-AAAA", pubkeyFingerprint: fingerprint, bootstrapSecret: "not-the-secret" }),
        env,
        account.principal,
      );
      expect(res.status).toBe(401);
      expect(await env.rbox_dev_db.prepare("SELECT 1 FROM key_delivery WHERE request_id=?").bind(requestId).first()).toBeNull();
    });

    test("dev env + operator secret + exact fingerprint atomically approves and queues", async () => {
      const account = await bootstrap("da-happy");
      const keys192 = keys(103);
      const { requestId } = await seedPendingAuth(account, "DAAD-AAAA", keys192);
      const fingerprint = await publicKeyFingerprint(keys192);
      // A fragment mismatch is refused before any queue.
      const mismatch = await approveDeviceAuthDev(
        jsonRequest("/v1/auth/device/approve-dev", { userCode: "DAAD-AAAA", pubkeyFingerprint: "A".repeat(43), bootstrapSecret: DEV_SECRET }),
        env,
        account.principal,
      );
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({ error: "pubkey_binding_mismatch" });
      const res = await approveDeviceAuthDev(
        jsonRequest("/v1/auth/device/approve-dev", { userCode: "DAAD-AAAA", pubkeyFingerprint: fingerprint, bootstrapSecret: DEV_SECRET }),
        env,
        account.principal,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, keyDelivery: { requestId, status: "pending" } });
      const [auth, delivery] = await Promise.all([
        env.rbox_dev_db.prepare("SELECT status,account_id FROM device_auth WHERE request_id=?").bind(requestId).first<{ status: string; account_id: string }>(),
        env.rbox_dev_db.prepare("SELECT state,account_id FROM key_delivery WHERE request_id=?").bind(requestId).first<{ state: string; account_id: string }>(),
      ]);
      expect(auth).toEqual({ status: "approved", account_id: account.accountId });
      expect(delivery).toEqual({ state: "queued", account_id: account.accountId });
    });

    test("first device on an unencrypted account downgrades key-consent to a device-auth sign-in (no error, no delivery)", async () => {
      // Papercut 2026-07-23: the web /cli-login page offers "send keys" whenever
      // the URL carries a #fp, even on a fresh account with no encryption. A
      // key-consent approve then used to 409 "encryption isn't set up". It must
      // instead gracefully sign the device in (device-auth) so the CLI can guide
      // the user to `rbox key genesis`. NOTE: no seedEpoch → account unencrypted.
      const account = await bootstrap("da-no-encryption");
      const keys192 = keys(104);
      const deviceCode = (await sha256Hex(`da-${account.accountId}-DAAE-AAAA`)).slice(0, 64);
      const requestId = await requestIdForDeviceCode(deviceCode);
      const now = Date.now();
      await env.rbox_dev_db.prepare(
        `INSERT INTO device_auth
           (device_code,user_code,status,device_id,label,created_at,expires_at,account_id,user_id,
            enc_pub_key,sig_pub_key,pubkeys_captured_at,request_id)
         VALUES (?,?,'pending',?,'approve-dev-test',?,?,?,?,?,?,?,?)`,
      ).bind(
        deviceCode, "DAAE-AAAA", "dev_da_DAAEAAAA", now, now + 600_000,
        null, null, keys192.encPubKey, keys192.sigPubKey, now, requestId,
      ).run();
      const fingerprint = await publicKeyFingerprint(keys192);
      const res = await approveDeviceAuthDev(
        jsonRequest("/v1/auth/device/approve-dev", { userCode: "DAAE-AAAA", pubkeyFingerprint: fingerprint, bootstrapSecret: DEV_SECRET }),
        env,
        account.principal,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, keyDelivery: null, encryptionAbsent: true });
      const [auth, delivery] = await Promise.all([
        env.rbox_dev_db.prepare("SELECT status,account_id FROM device_auth WHERE request_id=?").bind(requestId).first<{ status: string; account_id: string }>(),
        env.rbox_dev_db.prepare("SELECT 1 FROM key_delivery WHERE request_id=?").bind(requestId).first(),
      ]);
      expect(auth).toEqual({ status: "approved", account_id: account.accountId }); // device-auth sign-in
      expect(delivery).toBeNull(); // NO key delivery queued
    });
  });

  test("expiry, factor-age, and epoch guards terminalize without leaking the blob", async () => {
    const account = await bootstrap("kd-expiry");
    const expired = await seedQueued(account, "expired", keys(91));
    const minted = await claim(account, expired);
    await env.rbox_dev_db.prepare(
      "UPDATE key_delivery SET state='fulfilled',wrap_blob='ttl-secret',published_roster_version=0,expires_at=? WHERE request_id=?",
    ).bind(Date.now() - 1, expired.requestId).run();
    expect((await pollKeyDelivery(env, expired.requestId))?.status).toBe("expired");
    const afterTtl = await env.rbox_dev_db.prepare(
      "SELECT state,wrap_blob FROM key_delivery WHERE request_id=?",
    ).bind(expired.requestId).first();
    expect(afterTtl).toEqual({ state: "expired", wrap_blob: null });
    const ack = await ackKeyDelivery(
      jsonRequest("/v1/auth/key-delivery/ack", { requestId: expired.requestId }),
      env,
      { ...account.principal, deviceId: minted!.deviceId },
    );
    expect([404, 410]).toContain(ack.status);

    const staleFactor = await seedQueued(account, "factor", keys(92));
    await env.rbox_dev_db.prepare(
      "UPDATE key_delivery SET approval_factor_verified_at=? WHERE request_id=?",
    ).bind(Date.now() - 11 * 60_000, staleFactor.requestId).run();
    expect(await sweepKeyDeliveries(env)).toBeGreaterThanOrEqual(1);
    expect((await pollKeyDelivery(env, staleFactor.requestId))?.status).toBe("expired");

    const staleAtClaim = await seedQueued(account, "claim-stale", keys(94));
    await env.rbox_dev_db.prepare(
      "UPDATE key_delivery SET approval_factor_verified_at=? WHERE request_id=?",
    ).bind(Date.now() - 11 * 60_000, staleAtClaim.requestId).run();
    const staleMint = await claim(account, staleAtClaim);
    const staleDelivery = await env.rbox_dev_db.prepare(
      "SELECT target_device_id FROM key_delivery WHERE request_id=?",
    ).bind(staleAtClaim.requestId).first<{ target_device_id: string | null }>();
    const staleNotice = await env.rbox_dev_db.prepare(
      "SELECT keys_granted,key_fingerprint FROM device_notifications WHERE token_hash=?",
    ).bind(staleMint!.tokenHash).first<{ keys_granted: number; key_fingerprint: string | null }>();
    expect(staleDelivery?.target_device_id).toBeNull();
    expect(staleNotice).toEqual({ keys_granted: 0, key_fingerprint: null });
    await pollKeyDelivery(env, staleAtClaim.requestId);
    expect((await recoverEscrowedDeviceToken(env, staleAtClaim.requestId))?.token).toBe(staleMint?.token);

    const staleEpoch = await seedQueued(account, "epoch", keys(93));
    await seedEpoch(account.accountId, 1);
    await sweepKeyDeliveries(env);
    expect((await pollKeyDelivery(env, staleEpoch.requestId))?.status).toBe("expired");
  });
});
