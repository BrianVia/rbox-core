import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { AccountGoneError, createWebSession, mintDevice, mintDeviceWithNotification } from "../src/auth.js";
import { deleteAccount, driveAccountDeletion, purgeUploadR2, purgeWorkspaceDO, sweepAccountDeletions, DELETION_GRACE_MS, type PurgeDeps } from "../src/account-delete.js";
import type { Principal } from "../src/authz.js";
import type { Env } from "../src/env.js";
import { gcPurge } from "../src/versions.js";
import { retentionPrune } from "../src/retention.js";
import { blobKey } from "../src/util.js";

// Account + data deletion (design 37), against real D1 + R2 (workerd). The external
// erasure (Stripe/Clerk) is injected so we exercise the D1/R2/DO purge without network.
const BASE = "https://example.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const db = () => env.rbox_dev_db;
const authed = (t: string, x: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...x });

/** External + DO steps succeed instantly so a test drain reaches the D1 finish. The DO's
 *  SQLite storage isn't available in this runtime, so `purgeWorkspace` is stubbed (the real
 *  DO `deleteAll` is exercised in production); the D1 mirror deletion is still asserted. */
const purgedWorkspaces: string[] = [];
const OK_DEPS: PurgeDeps = {
  purgeStripe: async () => true,
  deleteClerk: async () => true,
  purgeWorkspace: async (_e, ws, proj) => (purgedWorkspaces.push(`${ws}/${proj}`), true),
  purgeUpload: purgeUploadR2, // exercise the REAL fail-closed R2 abort+staging-delete
};

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string): Promise<{ token: string; accountId: string; deviceId: string; ownerUserId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(res.status).toBe(200);
  const b = (await res.json()) as { token: string; accountId: string; deviceId: string };
  const owner = await db().prepare("SELECT user_id FROM memberships WHERE account_id = ? AND role = 'owner'").bind(b.accountId).first<{ user_id: string }>();
  return { ...b, ownerUserId: owner!.user_id };
}

function ownerPrincipal(accountId: string, userId: string, deviceId: string): Principal {
  return { deviceId, accountId, userId, role: "owner", kind: "durable" };
}
const delReq = (confirm: unknown) => new Request(`${BASE}/v1/account`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm }) });
const count = async (sql: string, ...binds: unknown[]) => Number((await db().prepare(sql).bind(...binds).first<{ n: number }>())!.n);

describe("DELETE /v1/account — owner-gating", () => {
  test("a non-owner (editor) device is rejected 403 and nothing is tombstoned", async () => {
    const a = await bootstrap("gate-owner");
    // A second user with a NON-owner membership + its own device token.
    const editorUser = `user_editor_${sha(a.accountId).slice(0, 8)}`;
    await db().prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(editorUser, a.accountId, Date.now()).run();
    await db().prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'editor')").bind(a.accountId, editorUser).run();
    const { token: editorTok } = await mintDevice(env, a.accountId, editorUser, "dev", "editor-laptop");

    const res = await SELF.fetch(`${BASE}/v1/account`, { method: "DELETE", headers: authed(editorTok, { "content-type": "application/json" }), body: JSON.stringify({ confirm: a.accountId }) });
    expect(res.status).toBe(403);
    const acct = await db().prepare("SELECT deleted_at FROM accounts WHERE id = ?").bind(a.accountId).first<{ deleted_at: number | null }>();
    expect(acct!.deleted_at).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM account_deletions WHERE account_id = ?", a.accountId)).toBe(0);
  });
});

describe("DELETE /v1/account — confirmation gate", () => {
  test("wrong confirm → 400, no tombstone; correct confirm → 200 + tombstone + devices revoked", async () => {
    const a = await bootstrap("confirm");
    const bad = await SELF.fetch(`${BASE}/v1/account`, { method: "DELETE", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ confirm: "definitely-not-it" }) });
    expect(bad.status).toBe(400);
    expect((await db().prepare("SELECT deleted_at FROM accounts WHERE id = ?").bind(a.accountId).first<{ deleted_at: number | null }>())!.deleted_at).toBeNull();

    const ok = await SELF.fetch(`${BASE}/v1/account`, { method: "DELETE", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ confirm: a.accountId }) });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string; purgeAfter: number };
    expect(body.status).toBe("pending");
    const acct = await db().prepare("SELECT deleted_at FROM accounts WHERE id = ?").bind(a.accountId).first<{ deleted_at: number | null }>();
    expect(acct!.deleted_at).not.toBeNull();
    // Every device revoked → the bootstrap token now 401s (authenticate rejects tombstoned).
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND revoked = 0", a.accountId)).toBe(0);
    const after = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) });
    expect(after.status).toBe(401);
  });

  test("email confirm also works (cached clerk_users.email)", async () => {
    const a = await bootstrap("confirm-email");
    await db().prepare("INSERT INTO clerk_users (clerk_user_id, account_id, user_id, created_at, email) VALUES (?, ?, ?, ?, ?)").bind(`user_clerk_${sha(a.accountId).slice(0, 6)}`, a.accountId, a.ownerUserId, Date.now(), "Owner@Example.com").run();
    const p = ownerPrincipal(a.accountId, a.ownerUserId, a.deviceId);
    const res = await deleteAccount(env, p, delReq("owner@example.com"), Date.now()); // case-insensitive match
    expect(res.status).toBe(200);
  });
});

describe("DELETE /v1/account — idempotency", () => {
  // The function-level path models a CONCURRENT double-submit: both requests authenticated
  // before the tombstone landed, so both reach deleteAccount() and the second hits the
  // already-tombstoned branch → 200 idempotent (single tombstone, grace not extended).
  test("concurrent double-call → 200 twice, single tombstone, grace not extended", async () => {
    const a = await bootstrap("idem");
    const p = ownerPrincipal(a.accountId, a.ownerUserId, a.deviceId);
    const t0 = 1_000_000;
    const r1 = await deleteAccount(env, p, delReq(a.accountId), t0);
    expect(r1.status).toBe(200);
    const first = (await r1.json()) as { deletedAt: number; purgeAfter: number };

    const r2 = await deleteAccount(env, p, delReq(a.accountId), t0 + 5_000); // later "now"
    expect(r2.status).toBe(200);
    const second = (await r2.json()) as { deletedAt: number; purgeAfter: number };
    expect(second.deletedAt).toBe(first.deletedAt); // not re-stamped
    expect(second.purgeAfter).toBe(first.purgeAfter); // grace NOT extended

    expect(await count("SELECT COUNT(*) AS n FROM account_deletions WHERE account_id = ?", a.accountId)).toBe(1);
  });

  // The real HTTP contract for a SEQUENTIAL retry (§8): the first DELETE tombstones + revokes
  // every device, so the retried DELETE re-authenticates against a now-tombstoned account and
  // gets 401 — acceptable idempotency (no error, no second tombstone, no extended grace).
  test("retried HTTP DELETE → first 200, second 401 (account no longer authenticable)", async () => {
    const a = await bootstrap("idem-http");
    const del = () => SELF.fetch(`${BASE}/v1/account`, { method: "DELETE", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ confirm: a.accountId }) });
    expect((await del()).status).toBe(200);
    const before = await db().prepare("SELECT deleted_at FROM accounts WHERE id = ?").bind(a.accountId).first<{ deleted_at: number }>();
    expect((await del()).status).toBe(401); // not a 500, not a new tombstone
    const after = await db().prepare("SELECT deleted_at FROM accounts WHERE id = ?").bind(a.accountId).first<{ deleted_at: number }>();
    expect(after!.deleted_at).toBe(before!.deleted_at); // unchanged
  });

  test("double drive → second is a no-op skip (status already done)", async () => {
    const a = await bootstrap("idem-drive");
    await deleteAccount(env, ownerPrincipal(a.accountId, a.ownerUserId, a.deviceId), delReq(a.accountId), Date.now());
    const past = Date.now() + DELETION_GRACE_MS + 1000;
    expect(await driveAccountDeletion(env, a.accountId, past, OK_DEPS)).toBe("done");
    expect(await driveAccountDeletion(env, a.accountId, past, OK_DEPS)).toBe("skip"); // no throw, no-op
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", a.accountId)).toBe(0);
  });
});

describe("hard purge — enumeration + dedup safety + isolation", () => {
  test("erases every account-scoped row; keeps shared blobs; never touches another account", async () => {
    const A = await bootstrap("purge-A");
    const B = await bootstrap("purge-B"); // the bystander that must survive untouched
    const now = Date.now();

    const shaShared = sha("shared-ciphertext"); // referenced by BOTH A and B → must SURVIVE
    const shaOrphan = sha("A-only-ciphertext"); // referenced by A only → must be DELETED
    const shaB = sha("B-only-ciphertext"); // B only → must survive
    for (const [s, size] of [[shaShared, 10], [shaOrphan, 20], [shaB, 30]] as const) {
      await db().prepare("INSERT INTO blobs (sha256, size_bytes, present) VALUES (?, ?, 1)").bind(s, size).run();
      await env.rbox_dev_blobs.put(blobKey(s), new Uint8Array(size));
    }
    await db().batch([
      db().prepare("INSERT INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(A.accountId, shaShared),
      db().prepare("INSERT INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(A.accountId, shaOrphan),
      db().prepare("INSERT INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(B.accountId, shaShared),
      db().prepare("INSERT INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(B.accountId, shaB),
      // §33 per-account prune markers: A has one; B has one that must survive.
      db().prepare("INSERT INTO blob_ref_candidates (account_id, sha256, marked_at) VALUES (?, ?, ?)").bind(A.accountId, shaOrphan, now),
      db().prepare("INSERT INTO blob_ref_candidates (account_id, sha256, marked_at) VALUES (?, ?, ?)").bind(B.accountId, shaB, now),
    ]);

    // A clerk identity + an account-link history keyed by it.
    const clerkA = `user_clerkA_${sha(A.accountId).slice(0, 6)}`;
    // Seed a row in (nearly) every account-scoped table for A.
    await db().batch([
      db().prepare("INSERT INTO clerk_users (clerk_user_id, account_id, user_id, created_at, email) VALUES (?, ?, ?, ?, ?)").bind(clerkA, A.accountId, A.ownerUserId, now, "a@example.com"),
      db().prepare("INSERT INTO account_keys (account_id, recovery_wrap, created_at) VALUES (?, 'w', ?)").bind(A.accountId, now),
      db().prepare("INSERT INTO device_keys (device_id, account_id, created_at) VALUES (?, ?, ?)").bind(`dk_${A.accountId}`, A.accountId, now),
      db().prepare("INSERT INTO workspace_keys (workspace_id, account_id, key_epoch, created_at) VALUES (?, ?, 0, ?)").bind("ws_a", A.accountId, now),
      db().prepare("INSERT INTO rosters (account_id, version, signed, created_at) VALUES (?, 0, 's', ?)").bind(A.accountId, now),
      db().prepare("INSERT INTO account_key_states (account_id, account_epoch, signed, created_at) VALUES (?, 0, 's', ?)").bind(A.accountId, now),
      db().prepare("INSERT INTO pairing_tokens (token_hash, account_id, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`pt_${A.accountId}`, A.accountId, A.ownerUserId, A.deviceId, now, now + 1e6),
      db().prepare("INSERT INTO device_auth (device_code, user_code, status, device_id, account_id, created_at, expires_at) VALUES (?, 'UC-1', 'approved', ?, ?, ?, ?)").bind(`dc_${A.accountId}`, `dev_x_${A.accountId}`, A.accountId, now, now + 1e6),
      db().prepare("INSERT INTO account_notify_prefs (account_id, notify_new_device) VALUES (?, 0)").bind(A.accountId),
      db().prepare("INSERT INTO audit_log (account_id, action, at) VALUES (?, 'x', ?)").bind(A.accountId, now),
      // §5b: platform audit rows store the account id in `target` with account_id NULL.
      db().prepare("INSERT INTO audit_log (account_id, action, target, at) VALUES (NULL, 'account.set_plan', ?, ?)").bind(`${A.accountId}:free`, now),
      db().prepare("INSERT INTO account_link_events (clerk_user_id, to_account, method, at) VALUES (?, ?, 'cli_link', ?)").bind(clerkA, A.accountId, now),
      db().prepare("INSERT INTO account_link_codes (code_hash, poll_key, clerk_user_id, origin_account, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`ch_${A.accountId}`, `pk_${A.accountId}`, clerkA, A.accountId, now, now + 1e6),
    ]);
    // A REAL in-flight multipart upload (so the fail-closed abort actually releases a live MPU)
    // with a real staging object, plus a workspace + commit + manifest + notifications.
    const stagingKey = `staging/${shaOrphan}/x`;
    const mpu = await env.rbox_dev_blobs.createMultipartUpload(stagingKey);
    const upId = mpu.uploadId;
    await env.rbox_dev_blobs.put(stagingKey, new Uint8Array(8));
    const diagKey = `diagnostics/${A.accountId}/diag_delete_me.json`;
    await env.rbox_dev_blobs.put(diagKey, JSON.stringify({ report: true }));
    await db().batch([
      db().prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES (?, 'root', ?, ?)").bind("ws_a", A.accountId, now),
      db().prepare("INSERT INTO commits (workspace_id, project_id, sequence, commit_hash, body, sig) VALUES ('ws_a','root',1,'h','b','s')"),
      db().prepare("INSERT INTO manifests (workspace_id, project_id, sequence, manifest_blob_sha) VALUES ('ws_a','root',1,?)").bind(shaOrphan),
      db().prepare("INSERT INTO uploads (upload_id, sha256, staging_key, part_size, total_parts, size, created_at, account_id) VALUES (?, ?, ?, 8, 1, 8, ?, ?)").bind(upId, shaOrphan, stagingKey, now, A.accountId),
      db().prepare("INSERT INTO upload_parts (upload_id, part_number, etag, size) VALUES (?, 1, 'e', 8)").bind(upId),
      db().prepare("INSERT INTO diagnostics_reports (id, account_id, device_id, created_at, expires_at, r2_key, status, bytes, sha256) VALUES ('diag_del', ?, ?, ?, ?, ?, 'stored', 15, ?)").bind(A.accountId, A.deviceId, now, now + 30 * 24 * 60 * 60 * 1000, diagKey, sha("diag")),
      db().prepare("INSERT INTO device_notifications (token_hash, device_id, account_id, event, created_at) VALUES (?, ?, ?, 'pair', ?)").bind(`th_${A.accountId}`, A.deviceId, A.accountId, now),
      db().prepare("INSERT INTO notification_deliveries (token_hash, recipient_user_id, recipient_clerk_id, idempotency_key) VALUES (?, ?, ?, 'ik')").bind(`th_${A.accountId}`, A.ownerUserId, clerkA),
    ]);

    // Tombstone A, then move purge_after into the past so we can drive at real `now` (keeps
    // gc_candidates.marked_at aligned with the real clock for the gcPurge step below).
    await deleteAccount(env, ownerPrincipal(A.accountId, A.ownerUserId, A.deviceId), delReq(A.accountId), now);
    await db().prepare("UPDATE account_deletions SET purge_after = ? WHERE account_id = ?").bind(now - 1000, A.accountId).run();
    const result = await driveAccountDeletion(env, A.accountId, now, OK_DEPS);
    expect(result).toBe("done");

    // Every account-scoped table is empty for A.
    const tablesByAccount = [
      "accounts WHERE id", "users WHERE account_id", "memberships WHERE account_id", "blob_refs WHERE account_id",
      "account_keys WHERE account_id", "device_keys WHERE account_id", "workspace_keys WHERE account_id",
      "rosters WHERE account_id", "account_key_states WHERE account_id", "devices WHERE account_id",
      "device_auth WHERE account_id", "pairing_tokens WHERE account_id", "uploads WHERE account_id",
      "workspaces WHERE account_id", "clerk_users WHERE account_id", "device_notifications WHERE account_id",
      "account_notify_prefs WHERE account_id", "audit_log WHERE account_id", "blob_ref_candidates WHERE account_id",
      "diagnostics_reports WHERE account_id",
    ];
    for (const t of tablesByAccount) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} = ?`, A.accountId), `${t} should be empty`).toBe(0);
    }
    // §5b: the platform audit row keyed only via `target` (account_id NULL) is also purged.
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE target LIKE ?", `${A.accountId}%`)).toBe(0);
    // The workspace's authoritative DO was purged (then its D1 mirror dropped).
    expect(purgedWorkspaces).toContain("ws_a/root");
    // Joined tables for A purged.
    expect(await count("SELECT COUNT(*) AS n FROM commits WHERE workspace_id = 'ws_a'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM manifests WHERE workspace_id = 'ws_a'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM upload_parts WHERE upload_id = ?", upId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM notification_deliveries WHERE token_hash = ?", `th_${A.accountId}`)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM account_link_events WHERE clerk_user_id = ?", clerkA)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM account_link_codes WHERE clerk_user_id = ?", clerkA)).toBe(0);

    // Per-upload staging object: deleted FAIL-CLOSED (R2 confirmed) before the uploads row.
    expect(await env.rbox_dev_blobs.get(`staging/${shaOrphan}/x`)).toBeNull();
    // Plaintext diagnostics object: deleted before its D1 row is allowed to disappear.
    expect(await env.rbox_dev_blobs.get(diagKey)).toBeNull();

    // §4f race-safety (the CRITICAL fix): account deletion CONDEMNS now-orphaned canonical shas
    // to the existing reachability-GC pipeline — it does NOT inline-delete them (that would race a
    // live account's concurrent receipt-PUT, which writes the canonical R2 object BEFORE any D1
    // ref). So right after the drive the orphan's R2 object + blobs row STILL exist; only a
    // gc_candidates row is added. The actual reclamation is the GC sweep's job (tested in
    // worker.test.ts). Crucially, the SHARED sha (still referenced by LIVE account B) is NEVER
    // condemned — account deletion can't endanger another account's blob.
    expect(await count("SELECT COUNT(*) AS n FROM gc_candidates WHERE sha256 = ?", shaOrphan)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM gc_candidates WHERE sha256 = ?", shaShared)).toBe(0);
    expect(await env.rbox_dev_blobs.get(blobKey(shaOrphan))).not.toBeNull(); // condemned, not inline-deleted
    expect(await count("SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?", shaOrphan)).toBe(1);

    // Shared blob: SURVIVES (B still references it) — never condemned, never deleted.
    expect(await env.rbox_dev_blobs.get(blobKey(shaShared))).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?", shaShared)).toBe(1);

    // Bystander account B is wholly untouched.
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", B.accountId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM blob_refs WHERE account_id = ?", B.accountId)).toBe(2); // shaShared + shaB
    expect(await count("SELECT COUNT(*) AS n FROM blob_ref_candidates WHERE account_id = ?", B.accountId)).toBe(1); // §33 marker survives
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?", B.accountId)).toBe(1);
    expect(await env.rbox_dev_blobs.get(blobKey(shaB))).not.toBeNull();

    // Ledger closed.
    const led = await db().prepare("SELECT status FROM account_deletions WHERE account_id = ?").bind(A.accountId).first<{ status: string }>();
    expect(led!.status).toBe("done");
  });
});

describe("workspace purge — projectId with '/' (finding 3, no wedge)", () => {
  test("purgeWorkspaceDO posts a FIXED /purge path that can't mis-parse for any projectId", async () => {
    const captured: string[] = [];
    const fakeEnv = {
      WORKSPACE_SYNC: {
        idFromName: (name: string) => ({ name }),
        get: (_id: unknown) => ({
          fetch: async (url: string, init: { method: string }) => {
            captured.push(`${init.method} ${new URL(url).pathname}`);
            return new Response(null, { status: 200 });
          },
        }),
      },
    } as unknown as Env;
    const ok = await purgeWorkspaceDO(fakeEnv, "ws1", "weird/project/with/slashes");
    expect(ok).toBe(true);
    // Fixed path — the projectId is NOT embedded in the positionally-parsed URL, so a '/' in it
    // can no longer mis-parse the action segment into a 404 that wedges the driver loop.
    expect(captured).toEqual(["POST /purge"]);
  });

  test("a workspace whose projectId contains '/' purges to done (driver doesn't wedge)", async () => {
    const a = await bootstrap("slash-proj");
    const now = Date.now();
    const proj = "nested/dir/project";
    await db().batch([
      db().prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES ('ws_slash', ?, ?, ?)").bind(proj, a.accountId, now),
      db().prepare("INSERT INTO commits (workspace_id, project_id, sequence, commit_hash, body, sig) VALUES ('ws_slash', ?, 1, 'h', 'b', 's')").bind(proj),
    ]);
    await deleteAccount(env, ownerPrincipal(a.accountId, a.ownerUserId, a.deviceId), delReq(a.accountId), now);
    await db().prepare("UPDATE account_deletions SET purge_after = ? WHERE account_id = ?").bind(now - 1000, a.accountId).run();
    expect(await driveAccountDeletion(env, a.accountId, now, OK_DEPS)).toBe("done");
    expect(purgedWorkspaces).toContain(`ws_slash/${proj}`);
    expect(await count("SELECT COUNT(*) AS n FROM workspaces WHERE account_id = ?", a.accountId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM commits WHERE workspace_id = 'ws_slash'")).toBe(0);
  });
});

describe("drive lease — owner-token CAS (finding 6)", () => {
  test("a fresh foreign lease blocks a concurrent claim and is NOT stolen/reset", async () => {
    const a = await bootstrap("lease");
    const now = Date.now();
    await deleteAccount(env, ownerPrincipal(a.accountId, a.ownerUserId, a.deviceId), delReq(a.accountId), now);
    // Simulate another driver holding a FRESH lease mid-purge.
    await db()
      .prepare("UPDATE account_deletions SET status = 'purging', purge_after = ?, last_attempt_at = ?, lease_token = 'driver-B' WHERE account_id = ?")
      .bind(now - 1000, now, a.accountId)
      .run();
    // A concurrent drive must SKIP (fresh lease held) and leave driver-B's lease intact.
    expect(await driveAccountDeletion(env, a.accountId, now, OK_DEPS)).toBe("skip");
    const row = await db().prepare("SELECT lease_token, last_attempt_at FROM account_deletions WHERE account_id = ?").bind(a.accountId).first<{ lease_token: string; last_attempt_at: number }>();
    expect(row!.lease_token).toBe("driver-B");
    expect(row!.last_attempt_at).toBe(now); // untouched

    // CAS contract the release relies on: only the lease owner may reset last_attempt_at.
    const stale = await db().prepare("UPDATE account_deletions SET last_attempt_at = 0 WHERE account_id = ? AND status = 'purging' AND lease_token = ?").bind(a.accountId, "driver-A").run();
    expect(stale.meta.changes ?? 0).toBe(0); // a stale driver can't blow away the fresh lease
    const owner = await db().prepare("UPDATE account_deletions SET last_attempt_at = 0 WHERE account_id = ? AND status = 'purging' AND lease_token = ?").bind(a.accountId, "driver-B").run();
    expect(owner.meta.changes ?? 0).toBe(1); // the owner can
  });
});

describe("uploads — fail-closed R2 cleanup (finding A)", () => {
  test("a failed MPU abort/staging delete keeps the D1 handle + retries (no premature delete)", async () => {
    const a = await bootstrap("upload-failclosed");
    const now = Date.now();
    await db().batch([
      db().prepare("INSERT INTO uploads (upload_id, sha256, staging_key, part_size, total_parts, size, created_at, account_id) VALUES ('u_fc', ?, 'staging/u_fc', 8, 1, 8, ?, ?)").bind(sha("x"), now, a.accountId),
      db().prepare("INSERT INTO upload_parts (upload_id, part_number, etag, size) VALUES ('u_fc', 1, 'e', 8)"),
    ]);
    await deleteAccount(env, ownerPrincipal(a.accountId, a.ownerUserId, a.deviceId), delReq(a.accountId), now);
    await db().prepare("UPDATE account_deletions SET purge_after = ? WHERE account_id = ?").bind(now - 1000, a.accountId).run();

    // purgeUpload always fails (transient R2 error on abort or staging delete).
    const fail: PurgeDeps = { ...OK_DEPS, purgeUpload: async () => false };
    expect(await driveAccountDeletion(env, a.accountId, now, fail)).toBe("progress"); // NOT done
    // The D1 handle is RETAINED — never deleted before R2 confirms the bytes are gone.
    expect(await count("SELECT COUNT(*) AS n FROM uploads WHERE upload_id = 'u_fc'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM upload_parts WHERE upload_id = 'u_fc'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", a.accountId)).toBe(1); // purge not finished

    // Once R2 confirms (success), the retry cleans the handle and completes.
    const ok: PurgeDeps = { ...OK_DEPS, purgeUpload: async () => true };
    expect(await driveAccountDeletion(env, a.accountId, now, ok)).toBe("done");
    expect(await count("SELECT COUNT(*) AS n FROM uploads WHERE upload_id = 'u_fc'")).toBe(0);
  });

  test("purgeUploadR2 is fail-closed: an abort error returns false and KEEPS the staging object", async () => {
    const key = "staging/purgeR2-fail/obj";
    await env.rbox_dev_blobs.put(key, new Uint8Array(4));
    // A non-existent uploadId makes abort() error (a non-"already-gone" failure) → fail-closed:
    // return false WITHOUT deleting the staging object, so the caller keeps the D1 handle.
    expect(await purgeUploadR2(env, key, "no-such-upload-id")).toBe(false);
    expect(await env.rbox_dev_blobs.get(key)).not.toBeNull(); // pointer NOT deleted before the pointee
  });

  test("purgeUploadR2 happy path: aborts a live MPU + deletes the staging object → true", async () => {
    const key = "staging/purgeR2-ok/obj";
    const mpu = await env.rbox_dev_blobs.createMultipartUpload(key);
    await env.rbox_dev_blobs.put(key, new Uint8Array(4));
    expect(await purgeUploadR2(env, key, mpu.uploadId)).toBe(true); // abort resolves, staging deleted
    expect(await env.rbox_dev_blobs.get(key)).toBeNull();
  });
});

describe("diagnostics purge — fail-closed R2 cleanup", () => {
  test("a failed diagnostics R2 delete keeps the D1 row for retry", async () => {
    const a = await bootstrap("diag-failclosed");
    const now = Date.now();
    const diagKey = `diagnostics/${a.accountId}/diag_retry.json`;
    await env.rbox_dev_blobs.put(diagKey, JSON.stringify({ retry: true }));
    await db()
      .prepare("INSERT INTO diagnostics_reports (id, account_id, device_id, created_at, expires_at, r2_key, status, bytes, sha256) VALUES ('diag_retry', ?, ?, ?, ?, ?, 'stored', 14, ?)")
      .bind(a.accountId, a.deviceId, now, now + 30 * 24 * 60 * 60 * 1000, diagKey, sha("diag_retry"))
      .run();
    await deleteAccount(env, ownerPrincipal(a.accountId, a.ownerUserId, a.deviceId), delReq(a.accountId), now);
    await db().prepare("UPDATE account_deletions SET purge_after = ? WHERE account_id = ?").bind(now - 1000, a.accountId).run();

    const fail: PurgeDeps = { ...OK_DEPS, purgeDiagnostic: async () => false };
    expect(await driveAccountDeletion(env, a.accountId, now, fail)).toBe("progress");
    expect(await count("SELECT COUNT(*) AS n FROM diagnostics_reports WHERE id = 'diag_retry'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", a.accountId)).toBe(1);
    expect(await env.rbox_dev_blobs.get(diagKey)).not.toBeNull();

    expect(await driveAccountDeletion(env, a.accountId, now, OK_DEPS)).toBe("done");
    expect(await count("SELECT COUNT(*) AS n FROM diagnostics_reports WHERE id = 'diag_retry'")).toBe(0);
  });
});

describe("server-internal DO addressing is slash-safe (finding B)", () => {
  test("gcPurge addresses /roots with a FIXED path + ws/proj in the query (no mis-parse)", async () => {
    const captured: URL[] = [];
    const fakeDb = {
      prepare(sql: string) {
        return {
          bind: () => fakeDb.prepare(sql),
          all: async () => ({ results: /FROM workspaces/i.test(sql) ? [{ workspace_id: "ws_b", project_id: "nested/dir/project" }] : [] }),
          first: async () => null,
          run: async () => ({ meta: {} }),
        };
      },
    };
    const fakeEnv = {
      rbox_dev_db: fakeDb,
      rbox_dev_blobs: {},
      WORKSPACE_SYNC: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async (url: string) => (captured.push(new URL(url)), Response.json({ head: 0, pruneFloor: 0, roots: [] })) }) },
    } as unknown as Env;
    await gcPurge(fakeEnv, 0);
    const roots = captured.find((u) => u.pathname === "/roots");
    expect(roots).toBeDefined(); // fixed path — NOT /v1/ws/ws_b/proj/nested/dir/project/roots (which 404s)
    expect(roots!.searchParams.get("ws")).toBe("ws_b");
    expect(roots!.searchParams.get("proj")).toBe("nested/dir/project"); // intact in the query, not split into path segments
  });

  test("retentionPrune addresses /prune with a FIXED path + ws/proj in the query (no mis-parse)", async () => {
    const captured: URL[] = [];
    const fakeDb = {
      prepare(sql: string) {
        return {
          bind: () => fakeDb.prepare(sql),
          all: async () => ({ results: /FROM workspaces w JOIN/i.test(sql) ? [{ ws: "ws_c", proj: "deep/nest/proj", acct: "acct_x", plan: "pro", grace_until: null }] : [] }),
          first: async () => (/FROM commits/i.test(sql) ? { floor: 5 } : null),
          run: async () => ({ meta: {} }),
        };
      },
    };
    const fakeEnv = {
      rbox_dev_db: fakeDb,
      WORKSPACE_SYNC: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async (url: string) => (captured.push(new URL(url)), Response.json({ pruned: 0, pruneFloor: 5 })) }) },
    } as unknown as Env;
    await retentionPrune(fakeEnv, Date.now());
    const prune = captured.find((u) => u.pathname === "/prune");
    expect(prune).toBeDefined();
    expect(prune!.searchParams.get("proj")).toBe("deep/nest/proj");
  });
});

describe("mint paths are liveness-COUPLED to the account (finding: no orphan device for a tombstoned account)", () => {
  // Simulates the TOCTOU: the account is tombstoned by the time the device INSERT runs (i.e.
  // AFTER any caller's pre-mint liveness read). The guarded INSERT must write NO `devices` row
  // and the mint must fail — for ALL mint paths.
  test("durable mint (pair / device-code) into a tombstoned account writes no device + no outbox, and throws", async () => {
    const a = await bootstrap("couple-durable");
    const before = await count("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?", a.accountId);
    // Tombstone the account (as account deletion would, between a liveness read and the insert).
    await db().prepare("UPDATE accounts SET deleted_at = ? WHERE id = ?").bind(Date.now(), a.accountId).run();

    await expect(
      mintDeviceWithNotification(env, { accountId: a.accountId, userId: a.ownerUserId, label: "raced laptop", event: "pair", ip: null, geo: null }),
    ).rejects.toBeInstanceOf(AccountGoneError);

    // No new device row, and (coextensivity) no orphan notification outbox row either.
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?", a.accountId)).toBe(before);
    expect(await count("SELECT COUNT(*) AS n FROM device_notifications WHERE account_id = ?", a.accountId)).toBe(0);
  });

  test("web-session mint into a tombstoned account writes no device and throws", async () => {
    const a = await bootstrap("couple-web");
    const before = await count("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?", a.accountId);
    await db().prepare("UPDATE accounts SET deleted_at = ? WHERE id = ?").bind(Date.now(), a.accountId).run();

    await expect(createWebSession(env, a.accountId, a.ownerUserId)).rejects.toBeInstanceOf(AccountGoneError);
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?", a.accountId)).toBe(before);
  });

  test("a LIVE account still mints normally (the guard is not a regression)", async () => {
    const a = await bootstrap("couple-live");
    const minted = await mintDeviceWithNotification(env, { accountId: a.accountId, userId: a.ownerUserId, label: "ok laptop", event: "pair", ip: null, geo: null });
    expect(minted.deviceId).toBeTruthy();
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE device_id = ?", minted.deviceId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM device_notifications WHERE token_hash = ?", minted.tokenHash)).toBe(1);
  });
});

describe("grace window", () => {
  test("before purge_after the sweep erases nothing (but access is dead); after, it hard-purges", async () => {
    const a = await bootstrap("grace");
    await db().prepare("INSERT INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(a.accountId, sha("grace-blob")).run();
    const ok = await SELF.fetch(`${BASE}/v1/account`, { method: "DELETE", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ confirm: a.accountId }) });
    expect(ok.status).toBe(200);
    const now = Date.now();

    // Within grace: sweep purges nothing, data intact, but the account is inaccessible.
    await sweepAccountDeletions(env, now, OK_DEPS);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", a.accountId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM blob_refs WHERE account_id = ?", a.accountId)).toBe(1);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) })).status).toBe(401);

    // Past grace: the hard purge runs.
    await sweepAccountDeletions(env, now + DELETION_GRACE_MS + 1000, OK_DEPS);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", a.accountId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM blob_refs WHERE account_id = ?", a.accountId)).toBe(0);
  });
});
