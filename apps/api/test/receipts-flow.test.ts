import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { startOp } from "../src/metrics.js";
import { validateCommitRefs, commitAccounting } from "../src/commit-accounting.js";
import {
  ACCOUNTING_INSERT_CHUNK,
  ACCOUNTING_STATEMENTS_PER_CHUNK,
  CARRIER_REFS,
  MAX_RECEIPTS_PER_REDEEM,
  MAX_REFS_PER_COMMIT,
  MAX_REFS_PER_TXN,
  SELECTS_PER_BATCH,
  VALIDATE_IN_LIST_CHUNK,
} from "../src/commit-accounting.js";
import { IN_LIST_CHUNK, STMTS_PER_BATCH } from "../src/d1-batch.js";
import { MAX_MISSING_SHAS_RESPONSE, unsatisfiedBlobsBody } from "../src/commit-envelope.js";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { blobKey } from "../src/util.js";

// §23.2 (staging PUT) + §23.4 (commit accounting) against real D1 + R2 (workerd).
// The DO head-advance (transactionSync) isn't available in this runtime, so we drive
// the accounting functions directly — they own the catalog+charge+grant+promote that
// the head-advance merely publishes.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE = "https://example.com";
const RCPT = { "x-rbox-protocol": "upload-receipts-v1" };

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string) {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string };
}
const authed = (t: string, x: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...x });
const db = () => env.rbox_dev_db;
const used = async (id: string) =>
  Number((await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(id).first())!.used_bytes);

const fakeState = () =>
  ({
    setWebSocketAutoResponse() {},
    storage: { kv: new Map(), transactionSync(fn: () => void) { fn(); } },
  }) as unknown as DurableObjectState;

async function redeem(accountId: string, receipts: Record<string, unknown>): Promise<Response> {
  const sync = new WorkspaceSync(fakeState(), env);
  return (sync as unknown as { redeemReceipts(req: Request): Promise<Response> }).redeemReceipts(
    new Request(`${BASE}/v1/ws/ws/proj/root/receipts/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rbox-account": accountId },
      body: JSON.stringify({ receipts }),
    }),
  );
}

function signedSidecarCommit(over: { accountId: string; workspaceId: string; deviceId: string; count: number }) {
  return {
    body: JSON.stringify({
      type: "rbox/commit/v1",
      accountId: over.accountId,
      accountEpoch: 0,
      workspaceId: over.workspaceId,
      seq: 1,
      parentSeq: 0,
      parentCommitHash: "0".repeat(64),
      rosterVersion: 0,
      keyEpoch: 0,
      deviceId: over.deviceId,
      encManifestSha: sha("manifest"),
      blobRefset: { sidecarSha: sha("sidecar"), count: over.count, totalBytes: 0 },
    }),
    commitHash: "a".repeat(64),
    sig: "dummy",
  };
}

// PUT a blob on the receipts protocol → { receipt }. Returns the receipt string.
async function putStaged(token: string, content: string): Promise<{ sha: string; receipt: string }> {
  const s = sha(content);
  const res = await SELF.fetch(`${BASE}/v1/blobs/${s}`, {
    method: "PUT",
    headers: authed(token, { "content-length": String(content.length), ...RCPT }),
    body: content,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sha256: string; sizeBytes: number; receipt: string };
  expect(body.receipt).toBeTruthy();
  return { sha: s, receipt: body.receipt };
}

describe("§23.2 PUT → canonical + receipt (direct-write, zero D1 on the hot path)", () => {
  test("writes the CANONICAL key directly, returns a receipt, and touches NO accounting tables", async () => {
    const a = await bootstrap("rcpt-put");
    const { sha: s } = await putStaged(a.token, "direct-write-content");

    // canonical object present (direct-write); NO D1 accounting rows.
    expect(await env.rbox_dev_blobs.get(blobKey(s))).toBeTruthy();
    expect(await db().prepare("SELECT 1 FROM blobs WHERE sha256=?").bind(s).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE sha256=?").bind(s).first()).toBeNull();
    expect(await used(a.accountId)).toBe(0); // un-charged until commit
  });
});

describe("§23.4 commit accounting (direct-write: catalog present=1 + charge + grant, no promote)", () => {
  test("a fresh commit charges once, catalogs present=1, grants — no copy", async () => {
    const a = await bootstrap("rcpt-commit");
    const blobs = ["manifest-bytes", "file-a", "file-b"];
    const staged = await Promise.all(blobs.map((c) => putStaged(a.token, c)));
    const shas = staged.map((s) => s.sha);
    const receipts = Object.fromEntries(staged.map((s) => [s.sha, s.receipt]));
    const op = startOp(env, "test");

    const v = await validateCommitRefs(env, op.env.rbox_dev_db, a.accountId, shas, receipts, Date.now());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.newRefs).toHaveLength(3);
    expect(await commitAccounting(op.env.rbox_dev_db, a.accountId, v.newRefs, Date.now())).toEqual({ ok: true });

    expect(await used(a.accountId)).toBe(blobs.reduce((n, c) => n + c.length, 0));
    for (const { sha: s } of staged) {
      const blob = await db().prepare("SELECT present FROM blobs WHERE sha256=?").bind(s).first<{ present: number }>();
      expect(blob?.present).toBe(1); // cataloged present=1 directly
      expect(await env.rbox_dev_blobs.get(blobKey(s))).toBeTruthy(); // canonical (from the PUT)
      expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?").bind(a.accountId, s).first()).toBeTruthy();
    }
  });

  test("re-committing the same refs is idempotent (no double-charge)", async () => {
    const a = await bootstrap("rcpt-idem");
    const staged = await Promise.all(["m", "x", "y"].map((c) => putStaged(a.token, c)));
    const shas = staged.map((s) => s.sha);
    const receipts = Object.fromEntries(staged.map((s) => [s.sha, s.receipt]));
    const op = startOp(env, "test");

    const v1 = await validateCommitRefs(env, op.env.rbox_dev_db, a.accountId, shas, receipts, Date.now());
    if (!v1.ok) throw new Error("validate failed");
    await commitAccounting(op.env.rbox_dev_db, a.accountId, v1.newRefs, Date.now());
    const after1 = await used(a.accountId);

    const v2 = await validateCommitRefs(env, op.env.rbox_dev_db, a.accountId, shas, receipts, Date.now());
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.newRefs).toHaveLength(0); // entitled+present → no new refs
    await commitAccounting(op.env.rbox_dev_db, a.accountId, v2.newRefs, Date.now());
    expect(await used(a.accountId)).toBe(after1);
  });

  test("over-cap commit → overCap, nothing charged/granted (batch rolled back)", async () => {
    const a = await bootstrap("rcpt-cap");
    await db().prepare("UPDATE accounts SET cap_bytes=10 WHERE id=?").bind(a.accountId).run();
    const staged = await Promise.all(["manifest", "bigfile-contents-well-over-ten"].map((c) => putStaged(a.token, c)));
    const shas = staged.map((s) => s.sha);
    const receipts = Object.fromEntries(staged.map((s) => [s.sha, s.receipt]));
    const op = startOp(env, "test");

    const v = await validateCommitRefs(env, op.env.rbox_dev_db, a.accountId, shas, receipts, Date.now());
    if (!v.ok) throw new Error("validate failed");
    const acct = await commitAccounting(op.env.rbox_dev_db, a.accountId, v.newRefs, Date.now());
    expect("overCap" in acct).toBe(true);
    expect(await used(a.accountId)).toBe(0); // batch rolled back
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=?").bind(a.accountId).first()).toBeNull();
    // (the canonical objects the PUTs wrote remain — an accepted single-user orphan, reaped by quiescent GC)
  });

  test("a ref with no receipt and not entitled → needsUpload (422 path)", async () => {
    const a = await bootstrap("rcpt-missing");
    const op = startOp(env, "test");
    const orphan = sha("never-uploaded");
    const v = await validateCommitRefs(env, op.env.rbox_dev_db, a.accountId, [orphan], {}, Date.now());
    expect(v).toEqual({ ok: false, needsUpload: [orphan] });
  });
});

describe("design 71 receipt redemption and ref-scale guards", () => {
  test("static budget math stays inside the documented margins", () => {
    const statementsPerAccountingTxn = Math.ceil(MAX_REFS_PER_TXN / ACCOUNTING_INSERT_CHUNK) * ACCOUNTING_STATEMENTS_PER_CHUNK;
    const maxParams = Math.max(
      ACCOUNTING_INSERT_CHUNK * 3,
      VALIDATE_IN_LIST_CHUNK + 1,
      IN_LIST_CHUNK + 1,
    );
    const preflightSubrequests = Math.ceil(Math.ceil(MAX_REFS_PER_COMMIT / IN_LIST_CHUNK) / STMTS_PER_BATCH);
    const validateSubrequests = Math.ceil(Math.ceil(MAX_REFS_PER_COMMIT / VALIDATE_IN_LIST_CHUNK) / SELECTS_PER_BATCH);
    const accountingSubrequests = Math.ceil(MAX_REFS_PER_COMMIT / MAX_REFS_PER_TXN);
    const commitPathSubrequestsAtMax = preflightSubrequests + validateSubrequests + accountingSubrequests + 1; // D1 mirror

    expect(statementsPerAccountingTxn).toBe(455);
    expect(maxParams).toBeLessThanOrEqual(99);
    expect(commitPathSubrequestsAtMax).toBeLessThanOrEqual(300);
    expect(MAX_RECEIPTS_PER_REDEEM).toBeLessThanOrEqual(5_000);
  });

  test("redeem happy path, then idempotent re-redeem grants 0 and counts already entitled", async () => {
    const a = await bootstrap("rcpt-redeem-ok");
    const staged = await Promise.all(["manifest", "file-a", "file-b"].map((c) => putStaged(a.token, c)));
    const receipts = Object.fromEntries(staged.map((s) => [s.sha, s.receipt]));

    const first = await redeem(a.accountId, receipts);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ granted: 3, alreadyEntitled: 0, rejected: 0 });
    expect(await used(a.accountId)).toBe("manifest".length + "file-a".length + "file-b".length);

    const second = await redeem(a.accountId, receipts);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ granted: 0, alreadyEntitled: 3, rejected: 0 });
    expect(await used(a.accountId)).toBe("manifest".length + "file-a".length + "file-b".length);
  });

  test("redeem rejects invalid HMACs in the response count without granting them", async () => {
    const a = await bootstrap("rcpt-redeem-bad-hmac");
    const good = await putStaged(a.token, "good");
    const bad = await putStaged(a.token, "bad");
    const res = await redeem(a.accountId, { [good.sha]: good.receipt, [bad.sha]: `${bad.receipt.slice(0, -1)}x` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ granted: 1, alreadyEntitled: 0, rejected: 1 });
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?").bind(a.accountId, bad.sha).first()).toBeNull();
  });

  test(">5k receipts are rejected before verification", async () => {
    const a = await bootstrap("rcpt-redeem-too-many");
    const receipts = Object.fromEntries(Array.from({ length: MAX_RECEIPTS_PER_REDEEM + 1 }, (_, i) => [sha(`too-many-${i}`), "receipt"]));
    const res = await redeem(a.accountId, receipts);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too_many_receipts", max: MAX_RECEIPTS_PER_REDEEM });
  });

  test("redeem propagates quota_exceeded with the commit-accounting body", async () => {
    const a = await bootstrap("rcpt-redeem-quota");
    await db().prepare("UPDATE accounts SET cap_bytes=10 WHERE id=?").bind(a.accountId).run();
    const staged = await Promise.all(["manifest", "bigfile-contents-well-over-ten"].map((c) => putStaged(a.token, c)));
    const receipts = Object.fromEntries(staged.map((s) => [s.sha, s.receipt]));
    const res = await redeem(a.accountId, receipts);
    expect(res.status).toBe(402);
    expect((await res.json()) as { error: string; used: number; cap: number }).toMatchObject({ error: "quota_exceeded", cap: 10 });
  });

  test("commit validation succeeds with empty receipts after redeem", async () => {
    const a = await bootstrap("rcpt-redeem-then-commit");
    const staged = await Promise.all(["manifest", "file-a"].map((c) => putStaged(a.token, c)));
    const receipts = Object.fromEntries(staged.map((s) => [s.sha, s.receipt]));
    expect((await redeem(a.accountId, receipts)).status).toBe(200);
    const op = startOp(env, "test");
    const v = await validateCommitRefs(env, op.env.rbox_dev_db, a.accountId, staged.map((s) => s.sha), {}, Date.now());
    expect(v).toEqual({ ok: true, newRefs: [] });
  });

  test("M-inclusive too_many_refs response carries count and max", async () => {
    const a = await bootstrap("refs-cap-count");
    const sync = new WorkspaceSync(fakeState(), env);
    const dataRefs = MAX_REFS_PER_COMMIT - CARRIER_REFS + 1;
    const res = await (sync as unknown as { commit(req: Request, ws: string, proj: string): Promise<Response> }).commit(
      new Request(`${BASE}/v1/ws/ws/proj/root/manifests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1", "x-rbox-account": a.accountId },
        body: JSON.stringify({ parentSequence: 0, commit: signedSidecarCommit({ accountId: a.accountId, workspaceId: "ws", deviceId: a.deviceId, count: dataRefs }), receipts: {} }),
      }),
      "ws",
      "root",
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_many_refs", count: MAX_REFS_PER_COMMIT + 1, max: MAX_REFS_PER_COMMIT });
  });

  test("422 helper always carries missingTotal and caps serialized shas", () => {
    const missing = Array.from({ length: MAX_MISSING_SHAS_RESPONSE + 123 }, (_, i) => sha(`missing-${i}`));
    const body = unsatisfiedBlobsBody(missing);
    expect(body.missing).toHaveLength(MAX_MISSING_SHAS_RESPONSE);
    expect(body.missingTotal).toBe(missing.length);
    expect(body.missing[0]).toBe(missing[0]);
  });
});
