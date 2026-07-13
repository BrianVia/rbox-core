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
  receiptRedeemMax,
  SELECTS_PER_BATCH,
  VALIDATE_IN_LIST_CHUNK,
} from "../src/commit-accounting.js";
import { IN_LIST_CHUNK, STMTS_PER_BATCH } from "../src/d1-batch.js";
import { MAX_MISSING_SHAS_RESPONSE, orderChainFirst, unsatisfiedBlobsBody } from "../src/commit-envelope.js";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { blobKey } from "../src/util.js";
import { multipartComplete } from "../src/blobs.js";
import { serializeRefset } from "../../../src/engine/refset.js";

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
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string; deviceId: string };
}
const authed = (t: string, x: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...x });
const db = () => env.rbox_dev_db;
const used = async (id: string) =>
  Number((await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(id).first())!.used_bytes);

const fakeState = () =>
  {
    const kv = new Map<string, unknown>();
    return {
      setWebSocketAutoResponse() {},
      storage: {
        kv: {
          get: (key: string) => kv.get(key),
          put: (key: string, value: unknown) => kv.set(key, value),
          delete: (key: string) => kv.delete(key),
        },
        sql: { exec: () => ({ toArray: () => [] }) },
        transactionSync(fn: () => void) { fn(); },
        async getAlarm() { return null; },
        async setAlarm() {},
      },
    } as unknown as DurableObjectState;
  };

async function redeem(accountId: string, receipts: Record<string, unknown>, handlerEnv: Env = env): Promise<Response> {
  const sync = new WorkspaceSync(fakeState(), handlerEnv);
  return (sync as unknown as { redeemReceipts(req: Request): Promise<Response> }).redeemReceipts(
    new Request(`${BASE}/v1/ws/ws/proj/root/receipts/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rbox-account": accountId },
      body: JSON.stringify({ receipts }),
    }),
  );
}

function signedSidecarCommit(over: { accountId: string; workspaceId: string; deviceId: string; count: number; manifestChain?: string[] }) {
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
      ...(over.manifestChain ? { manifestChain: over.manifestChain } : {}),
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

async function putStagedBytes(token: string, bytes: Uint8Array): Promise<{ sha: string; receipt: string }> {
  const s = createHash("sha256").update(bytes).digest("hex");
  const res = await SELF.fetch(`${BASE}/v1/blobs/${s}`, {
    method: "PUT",
    headers: authed(token, { "content-length": String(bytes.length), ...RCPT }),
    body: bytes,
  });
  expect(res.status).toBe(200);
  return { sha: s, receipt: ((await res.json()) as { receipt: string }).receipt };
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

  test("open delete intent refuses receipt minting, then succeeds after unwind", async () => {
    const a = await bootstrap("rcpt-put-fence");
    const content = "receipt-fenced-content";
    const s = sha(content);
    await db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(s).run();

    const blocked = await SELF.fetch(`${BASE}/v1/blobs/${s}`, {
      method: "PUT",
      headers: authed(a.token, { "content-length": String(content.length), ...RCPT }),
      body: content,
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: "retry_later" });
    expect(await env.rbox_dev_blobs.get(blobKey(s))).toBeTruthy(); // bytes carry no authority
    await db().prepare("DELETE FROM gc_candidates WHERE sha256=?").bind(s).run();
    expect((await SELF.fetch(`${BASE}/v1/blobs/${s}`, {
      method: "PUT",
      headers: authed(a.token, { "content-length": String(content.length), ...RCPT }),
      body: content,
    })).status).toBe(200);
  });

  test("legacy publish maps the fence abort to retry_later and succeeds after unwind", async () => {
    const a = await bootstrap("legacy-put-fence");
    const content = "legacy-fenced-content";
    const s = sha(content);
    await db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(s).run();
    const put = () => SELF.fetch(`${BASE}/v1/blobs/${s}`, {
      method: "PUT",
      headers: authed(a.token, { "content-length": String(content.length) }),
      body: content,
    });
    const blocked = await put();
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: "retry_later" });
    await db().prepare("DELETE FROM gc_candidates WHERE sha256=?").bind(s).run();
    expect((await put()).status).toBe(200);
  });

  test("legacy multipart COMPLETE maps the fence abort to retry_later and succeeds after unwind", async () => {
    const a = await bootstrap("legacy-multipart-fence");
    const content = new TextEncoder().encode("multipart-fenced-content");
    const s = sha("multipart-fenced-content");
    const stage = async (suffix: string) => {
      const stagingKey = `staging/${s}/${suffix}`;
      const mpu = await env.rbox_dev_blobs.createMultipartUpload(stagingKey);
      const part = await mpu.uploadPart(1, content);
      await db().batch([
        db().prepare("INSERT INTO uploads(upload_id,sha256,staging_key,part_size,total_parts,size,created_at,account_id) VALUES (?,?,?,?,1,?,?,?)")
          .bind(mpu.uploadId, s, stagingKey, content.byteLength, content.byteLength, Date.now(), a.accountId),
        db().prepare("INSERT INTO upload_parts(upload_id,part_number,etag,size) VALUES (?,1,?,?)").bind(mpu.uploadId, part.etag, content.byteLength),
      ]);
      return mpu.uploadId;
    };

    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES (?,'blob',1,2)").bind(s).run();
    const blocked = await multipartComplete(env, s, await stage("blocked"), a.accountId);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: "retry_later" });
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?").bind(a.accountId, s).first()).toBeNull();

    await db().prepare("DELETE FROM gc_candidates WHERE sha256=?").bind(s).run();
    const ok = await multipartComplete(env, s, await stage("retry"), a.accountId);
    expect(ok.status).toBe(200);
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?").bind(a.accountId, s).first()).not.toBeNull();
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

  // §3.5.4 truncation on the FENCE path is structurally vacuous: a delete-fence
  // abort returns exactly the caught super-batch (≤ MAX_REFS_PER_TXN = 3,000
  // entries, commit-accounting.ts), which can never exceed
  // MAX_MISSING_SHAS_RESPONSE (10,000) — so `missing` cannot truncate there.
  // The >10k truncation boundary is exercised end-to-end on the
  // validateCommitRefs path (the only producer that can exceed the cap); this
  // test pins the fence path's chain-first ordering through the exact
  // production composition instead.
  test("one fenced chain sha aborts a multi-sha accounting batch and chain-first handler formatting keeps it first", async () => {
    const a = await bootstrap("rcpt-fence-atomic");
    const refs = [{ sha: sha("fence-data"), size: 7 }, { sha: sha("fence-chain"), size: 9 }];
    const chainShas = [refs[1]!.sha];
    await db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(chainShas[0]).run();
    const acct = await commitAccounting(db(), a.accountId, refs, Date.now());
    expect(acct).toEqual({ needsUpload: refs.map((r) => r.sha) });
    if (!("needsUpload" in acct)) throw new Error("expected delete-fence abort");
    expect(unsatisfiedBlobsBody(orderChainFirst(acct.needsUpload, chainShas))).toEqual({
      error: "unsatisfied_blobs", missing: [chainShas[0], refs[0]!.sha], missingTotal: 2,
    });
    expect(await db().prepare("SELECT 1 FROM blobs WHERE sha256 IN (?,?)").bind(...refs.map((r) => r.sha)).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=?").bind(a.accountId).first()).toBeNull();
    expect(await used(a.accountId)).toBe(0);
  });

  test("blob_refs and blobs-present fence triggers cover their exact publication writes", async () => {
    const a = await bootstrap("fence-trigger-shapes");
    const open = sha("trigger-open");
    const sibling = sha("trigger-sibling");
    await db().batch([
      db().prepare("INSERT INTO blobs(sha256, size_bytes, present) VALUES (?, 1, 0)").bind(open),
      db().prepare("INSERT INTO blobs(sha256, size_bytes, present) VALUES (?, 1, 1)").bind(sibling),
      db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(open),
    ]);

    await expect(db().prepare("UPDATE blobs SET present=1 WHERE sha256=?").bind(open).run()).rejects.toThrow(/rbox_delete_fence/);
    expect(Number((await db().prepare("SELECT present FROM blobs WHERE sha256=?").bind(open).first())!.present)).toBe(0);

    await expect(db().batch([
      db().prepare("INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES (?, ?, 1)").bind(a.accountId, sibling),
      db().prepare("INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES (?, ?, 1)").bind(a.accountId, open),
    ])).rejects.toThrow(/rbox_delete_fence/);
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=?").bind(a.accountId).first()).toBeNull();
  });

  test("validateCommitRefs steers an entitled open-intent sha to needsUpload", async () => {
    const a = await bootstrap("rcpt-fence-steer");
    const staged = await putStaged(a.token, "steering-content");
    expect(await commitAccounting(db(), a.accountId, [{ sha: staged.sha, size: "steering-content".length }], Date.now())).toEqual({ ok: true });
    await db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(staged.sha).run();
    expect(await validateCommitRefs(env, db(), a.accountId, [staged.sha], {}, Date.now())).toEqual({ ok: false, needsUpload: [staged.sha] });
  });

  test("blobs/check reports open intents missing in receipts and legacy modes", async () => {
    const a = await bootstrap("blob-check-fence-steer");
    const staged = await putStaged(a.token, "check-steering-content");
    expect(await commitAccounting(db(), a.accountId, [{ sha: staged.sha, size: "check-steering-content".length }], Date.now())).toEqual({ ok: true });
    await db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(staged.sha).run();
    for (const headers of [{}, RCPT]) {
      const res = await SELF.fetch(`${BASE}/v1/blobs/check`, {
        method: "POST",
        headers: authed(a.token, { "content-type": "application/json", ...headers }),
        body: JSON.stringify({ shas: [staged.sha] }),
      });
      expect(res.status).toBe(200);
      // §109: the receipts-mode response also carries an uploadGrant; the missing
      // steering must be identical in both modes.
      expect(((await res.json()) as { missing: string[] }).missing).toEqual([staged.sha]);
    }
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

    // Design 114 adds up to four placement statements per 33-ref chunk while
    // preserving the existing whole-super-batch failure unit.
    expect(statementsPerAccountingTxn).toBe(819);
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

  test("redeem converts a fence abort to the partial-redeem 422 shape", async () => {
    const a = await bootstrap("rcpt-redeem-fence");
    const staged = await Promise.all(["redeem-fence-a", "redeem-fence-b"].map((c) => putStaged(a.token, c)));
    await db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(staged[1]!.sha).run();
    const res = await redeem(a.accountId, Object.fromEntries(staged.map((s) => [s.sha, s.receipt])));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "unsatisfied_blobs", missing: staged.map((s) => s.sha), missingTotal: 2 });
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=?").bind(a.accountId).first()).toBeNull();
  });

  test("redeem rejects invalid HMACs in the response count without granting them", async () => {
    const a = await bootstrap("rcpt-redeem-bad-hmac");
    const good = await putStaged(a.token, "good");
    const bad = await putStaged(a.token, "bad");
    // Deterministic tamper: flip a MID-MAC character. Flipping the FINAL base64
    // char is not enough — decoders discard the unused low bits of the last
    // symbol, so adjacent chars can decode to the identical MAC byte (flaked in
    // CI twice, 2026-07-07: the "tampered" receipt verified and granted:2).
    // A middle character always carries 6 meaningful bits.
    const i = bad.receipt.length - 10;
    const tampered = `${bad.receipt.slice(0, i)}${bad.receipt[i] === "A" ? "B" : "A"}${bad.receipt.slice(i + 1)}`;
    const res = await redeem(a.accountId, { [good.sha]: good.receipt, [bad.sha]: tampered });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ granted: 1, alreadyEntitled: 0, rejected: 1 });
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?").bind(a.accountId, bad.sha).first()).toBeNull();
  });

  test(">5k receipts are rejected before verification", async () => {
    const a = await bootstrap("rcpt-redeem-too-many");
    const atCap = Object.fromEntries(Array.from({ length: MAX_RECEIPTS_PER_REDEEM }, (_, i) => [`invalid-${i}`, "receipt"]));
    const accepted = await redeem(a.accountId, atCap);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ granted: 0, alreadyEntitled: 0, rejected: MAX_RECEIPTS_PER_REDEEM });

    const receipts = Object.fromEntries(Array.from({ length: MAX_RECEIPTS_PER_REDEEM + 1 }, (_, i) => [sha(`too-many-${i}`), "receipt"]));
    const res = await redeem(a.accountId, receipts);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too_many_receipts", max: MAX_RECEIPTS_PER_REDEEM });
  });

  test("configured receipt-redeem cap accepts 15k and rejects 15,001", async () => {
    const a = await bootstrap("rcpt-redeem-raised-cap");
    const handlerEnv = { ...env, RBOX_RECEIPT_REDEEM_MAX: "15000" } as Env;
    const atCap = Object.fromEntries(Array.from({ length: 15_000 }, (_, i) => [`invalid-${i}`, "receipt"]));
    const accepted = await redeem(a.accountId, atCap, handlerEnv);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ granted: 0, alreadyEntitled: 0, rejected: 15_000 });

    atCap["one-too-many"] = "receipt";
    const rejected = await redeem(a.accountId, atCap, handlerEnv);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "too_many_receipts", max: 15_000 });
  });

  test("receiptRedeemMax parses positive integers and clamps the rollout cap", () => {
    const configured = (value: string | undefined) => receiptRedeemMax({ ...env, RBOX_RECEIPT_REDEEM_MAX: value } as Env);
    expect(configured(undefined)).toBe(5_000);
    expect(configured(" 1 ")).toBe(1);
    expect(configured("15000")).toBe(15_000);
    expect(configured("999999")).toBe(15_000);
    expect(configured("abc")).toBe(5_000);
    expect(configured("0")).toBe(5_000);
    expect(configured("-5")).toBe(5_000);
  });

  test("redeem emits numeric phase splits without changing the shared metric layout", async () => {
    const a = await bootstrap("rcpt-redeem-phase-metrics");
    const staged = await putStaged(a.token, "phase-metric");
    const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    const handlerEnv = {
      ...env,
      rbox_metrics: { writeDataPoint: (point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) => points.push(point) } as AnalyticsEngineDataset,
    } as Env;
    const res = await redeem(a.accountId, { [staged.sha]: staged.receipt }, handlerEnv);
    expect(res.status).toBe(200);
    const phase = points.find((point) => point.indexes?.[0] === "receipts.redeem.phases");
    expect(phase?.blobs).toEqual(["receipts.redeem.phases", "ok"]);
    expect(phase?.doubles).toHaveLength(9);
    expect(phase?.doubles?.every((value) => typeof value === "number" && value >= 0)).toBe(true);
    expect(phase?.doubles?.slice(4)).toEqual([
      1,
      JSON.stringify({ receipts: { [staged.sha]: staged.receipt } }).length,
      1,
      0,
      0,
    ]);
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

  test("manifestChain entries participate in the sidecar ref budget", async () => {
    const a = await bootstrap(`chain-budget-${crypto.randomUUID()}`);
    const chain = [sha("chain-budget-a"), sha("chain-budget-b")];
    const count = MAX_REFS_PER_COMMIT - CARRIER_REFS - chain.length + 1;
    const sync = new WorkspaceSync(fakeState(), env);
    const res = await (sync as unknown as { commit(req: Request, ws: string, proj: string): Promise<Response> }).commit(
      new Request(`${BASE}/v1/ws/ws/proj/root/manifests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1", "x-rbox-account": a.accountId },
        body: JSON.stringify({ parentSequence: 0, commit: signedSidecarCommit({ accountId: a.accountId, workspaceId: "ws", deviceId: a.deviceId, count, manifestChain: chain }), receipts: {} }),
      }), "ws", "root",
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

  test("chain-first partition survives missing-response truncation", () => {
    const chainSha = sha("chain-miss");
    const missing = [...Array.from({ length: MAX_MISSING_SHAS_RESPONSE + 123 }, (_, i) => sha(`data-missing-${i}`)), chainSha];
    const body = unsatisfiedBlobsBody(orderChainFirst(missing, [chainSha]));
    expect(body.missing[0]).toBe(chainSha);
    expect(body.missing).toHaveLength(MAX_MISSING_SHAS_RESPONSE);
    expect(body.missingTotal).toBe(missing.length);
  });

  test("real commit handler keeps a missing chain link ahead of a truncated 10k+ data miss set", async () => {
    const a = await bootstrap(`chain-truncation-${crypto.randomUUID()}`);
    const refs = Array.from({ length: MAX_MISSING_SHAS_RESPONSE + 1 }, (_, i) => ({
      encSha: sha(`handler-data-missing-${i}`),
      size: 1,
    }));
    const sidecarBytes = serializeRefset(refs);
    const sidecar = await putStagedBytes(a.token, sidecarBytes);
    const chainSha = sha("handler-chain-missing");
    const manifestSha = sha("handler-manifest-missing");
    const commit = signedSidecarCommit({
      accountId: a.accountId,
      workspaceId: "ws",
      deviceId: a.deviceId,
      count: refs.length,
      manifestChain: [chainSha],
    });
    const parsed = JSON.parse(commit.body) as Record<string, unknown>;
    parsed.encManifestSha = manifestSha;
    parsed.blobRefset = {
      sidecarSha: sidecar.sha,
      count: refs.length,
      totalBytes: refs.length,
    };
    commit.body = JSON.stringify(parsed);

    const sync = new WorkspaceSync(fakeState(), env);
    const res = await (sync as unknown as { commit(req: Request, ws: string, proj: string): Promise<Response> }).commit(
      new Request(`${BASE}/v1/ws/ws/proj/root/manifests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1", "x-rbox-account": a.accountId },
        body: JSON.stringify({ parentSequence: 0, commit, receipts: { [sidecar.sha]: sidecar.receipt } }),
      }), "ws", "root",
    );

    expect(res.status).toBe(422);
    const body = await res.json() as { missing: string[]; missingTotal: number };
    expect(body.missing).toHaveLength(MAX_MISSING_SHAS_RESPONSE);
    expect(body.missing[0]).toBe(chainSha);
    expect(body.missingTotal).toBe(refs.length + 2); // data refs + manifest carrier + chain link
  }, 30_000);

  test("legacy commit reports a prune-marked chain link as the first missing ref", async () => {
    const a = await bootstrap(`legacy-marked-chain-${crypto.randomUUID()}`);
    const chain = await putStaged(a.token, "legacy-marked-chain-bytes");
    await db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES (?,?,1)").bind(chain.sha, 25).run();
    await db().prepare("INSERT INTO blob_refs(account_id,sha256,granted_at) VALUES (?,?,?)").bind(a.accountId, chain.sha, Date.now()).run();
    await db().prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES (?,?,?)").bind(a.accountId, chain.sha, Date.now()).run();

    const commit = signedSidecarCommit({ accountId: a.accountId, workspaceId: "ws", deviceId: a.deviceId, count: 0, manifestChain: [chain.sha] });
    const parsed = JSON.parse(commit.body) as Record<string, unknown>;
    delete parsed.blobRefset;
    parsed.blobRefs = [];
    commit.body = JSON.stringify(parsed);
    const sync = new WorkspaceSync(fakeState(), env);
    const res = await (sync as unknown as { commit(req: Request, ws: string, proj: string): Promise<Response> }).commit(
      new Request(`${BASE}/v1/ws/ws/proj/root/manifests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rbox-account": a.accountId },
        body: JSON.stringify({ parentSequence: 0, commit }),
      }), "ws", "root",
    );

    expect(res.status).toBe(422);
    const body = await res.json() as { missing: string[] };
    expect(body.missing[0]).toBe(chain.sha);
    expect(body.missing).toContain(chain.sha);
  });
});
