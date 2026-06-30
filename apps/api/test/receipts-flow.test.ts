import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { startOp } from "../src/metrics.js";
import { validateCommitRefs, commitAccounting } from "../src/commit-accounting.js";
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
