import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { blobGet } from "../src/blobs.js";
import { mintGrant, GRANT_TTL_MS } from "../src/grants.js";
import { blobKey } from "../src/util.js";

// §27 — blobGet's grant short-circuit, against real workerd D1 + R2.
//
// The load-bearing behavioral proof of "served WITHOUT the D1 entitlement read": a blob
// that is PRESENT in R2 but has NO blob_refs row (unentitled) is 404 today, but a VALID
// grant serves it 200 — which can ONLY happen if isEntitled was skipped. Conversely, an
// absent/invalid/expired grant must reproduce the exact legacy D1 gate.

const ACCT = "acc_grant";
const OTHER = "acc_other";
const WS = "ws_grant";

const shaOf = (s: string) => createHash("sha256").update(s).digest("hex");
async function putBlob(sha: string): Promise<void> {
  await env.rbox_dev_blobs.put(blobKey(sha), new TextEncoder().encode(`bytes-${sha}`));
}
const entitle = (acct: string, sha: string) =>
  env.rbox_dev_db.prepare("INSERT OR IGNORE INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(acct, sha).run();

const validGrant = () => mintGrant(env, { accountId: ACCT, workspaceId: WS, nowMs: Date.now() });
const expiredGrant = () => mintGrant(env, { accountId: ACCT, workspaceId: WS, nowMs: Date.now() - GRANT_TTL_MS - 10_000 });
const forgedGrant = () => mintGrant({ RBOX_GRANT_KEY: "x".repeat(40) } as typeof env, { accountId: ACCT, workspaceId: WS, nowMs: Date.now() });

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

describe("§27 blobGet grant short-circuit", () => {
  it("valid grant serves a PRESENT-but-UNENTITLED blob (proves the D1 isEntitled read was skipped)", async () => {
    const sha = shaOf("present-unentitled");
    await putBlob(sha); // in R2, but NO blob_refs row for ACCT
    const res = await blobGet(env, sha, ACCT, (await validGrant())!);
    expect(res.status).toBe(200);
  });

  it("NO grant → the same blob is 404 (legacy D1 entitlement gate unchanged)", async () => {
    const sha = shaOf("present-unentitled"); // same object as above, still no blob_refs
    const res = await blobGet(env, sha, ACCT); // no grant arg
    expect(res.status).toBe(404);
  });

  it("NO grant + ENTITLED → 200 (existing D1 path serves an entitled account)", async () => {
    const sha = shaOf("present-entitled");
    await putBlob(sha);
    await entitle(ACCT, sha);
    const res = await blobGet(env, sha, ACCT);
    expect(res.status).toBe(200);
  });

  it("EXPIRED grant + unentitled → 404 (falls back to D1, which denies)", async () => {
    const sha = shaOf("expired-unentitled");
    await putBlob(sha);
    const res = await blobGet(env, sha, ACCT, (await expiredGrant())!);
    expect(res.status).toBe(404);
  });

  it("EXPIRED grant + ENTITLED → 200 (falls back to D1, which serves — expiry is never a failure)", async () => {
    const sha = shaOf("expired-entitled");
    await putBlob(sha);
    await entitle(ACCT, sha);
    const res = await blobGet(env, sha, ACCT, (await expiredGrant())!);
    expect(res.status).toBe(200);
  });

  it("FORGED grant (wrong key) + unentitled → 404 (not honored, falls back to D1)", async () => {
    const sha = shaOf("forged-unentitled");
    await putBlob(sha);
    const res = await blobGet(env, sha, ACCT, (await forgedGrant())!);
    expect(res.status).toBe(404);
  });

  it("valid grant for a DIFFERENT account is NOT honored (account bind → D1 → 404)", async () => {
    const sha = shaOf("otheracct-unentitled");
    await putBlob(sha);
    // grant minted for OTHER, presented by an ACCT-authenticated caller → mismatch → D1 path → unentitled → 404
    const g = await mintGrant(env, { accountId: OTHER, workspaceId: WS, nowMs: Date.now() });
    const res = await blobGet(env, sha, ACCT, g!);
    expect(res.status).toBe(404);
  });

  it("valid grant but blob absent from R2 → 404 (grant path R2-miss is the same 404, no oracle)", async () => {
    const sha = shaOf("valid-but-absent"); // never put into R2
    const res = await blobGet(env, sha, ACCT, (await validGrant())!);
    expect(res.status).toBe(404);
  });
});
