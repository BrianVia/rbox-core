import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { resolveSidecarBytes } from "../src/sidecar.js";
import { mintReceipt } from "../src/receipts.js";
import { blobKey } from "../src/util.js";
import { serializeRefset } from "../../../src/engine/refset.js";

// §24.3 — resolveSidecarBytes against real D1 + R2 (workerd). Direct-write: the sidecar is a
// normal canonical blob the client PUT + got a receipt for; the resolver gates entitlement,
// fetches, bounds, hashes, parses, and asserts the descriptor — failing CLOSED on any mismatch.

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
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
  return (await res.json()) as { token: string; accountId: string };
}

// PUT raw bytes on the receipts protocol → receipt.
async function putBytes(token: string, bytes: Uint8Array): Promise<string> {
  const s = sha(bytes);
  const res = await SELF.fetch(`${BASE}/v1/blobs/${s}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-length": String(bytes.length), ...RCPT },
    body: bytes,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { receipt: string }).receipt;
}

const refSet = (n: number) => Array.from({ length: n }, (_, i) => ({ encSha: sha(`ref-${i}`), size: i + 1 }));
const descriptor = (refs: { encSha: string; size: number }[], sidecarSha: string) => ({
  sidecarSha,
  count: refs.length,
  totalBytes: refs.reduce((a, r) => a + r.size, 0),
});

describe("resolveSidecarBytes (§24.3) — direct-write, fail-closed", () => {
  test("happy path: uploaded sidecar + receipt → exact data-ref shas", async () => {
    const a = await bootstrap("sc-ok");
    const refs = refSet(5);
    const bytes = serializeRefset(refs);
    const scSha = sha(bytes);
    const receipt = await putBytes(a.token, bytes);

    const r = await resolveSidecarBytes(env, env.rbox_dev_db, a.accountId, descriptor(refs, scSha), { [scSha]: receipt }, Date.now());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // returns the data refs in canonical order; sidecarSha itself is NOT in the list (caller adds it).
    expect(new Set(r.refShas)).toEqual(new Set(refs.map((x) => x.encSha)));
    expect(r.refShas).not.toContain(scSha);
  });

  test("no receipt + not entitled → needsUpload (never probes R2)", async () => {
    const a = await bootstrap("sc-unauth");
    const refs = refSet(3);
    const bytes = serializeRefset(refs);
    const scSha = sha(bytes);
    await env.rbox_dev_blobs.put(blobKey(scSha), bytes); // object exists, but account can't prove ownership
    const r = await resolveSidecarBytes(env, env.rbox_dev_db, a.accountId, descriptor(refs, scSha), {}, Date.now());
    expect(r).toEqual({ ok: false, needsUpload: [scSha] });
  });

  test("descriptor count/size disagreement with the bytes → badSidecar (advisory never trusted)", async () => {
    const a = await bootstrap("sc-mismatch");
    const refs = refSet(4);
    const bytes = serializeRefset(refs);
    const scSha = sha(bytes);
    const receipt = await putBytes(a.token, bytes);
    // claim 6 refs for a 4-ref object → size bound rejects before parse
    const r = await resolveSidecarBytes(env, env.rbox_dev_db, a.accountId, { sidecarSha: scSha, count: 6, totalBytes: 99 }, { [scSha]: receipt }, Date.now());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("badSidecar" in r).toBe(true);
  });

  test("entitled (receipt) but R2 bytes don't hash to sidecarSha → badSidecar", async () => {
    const a = await bootstrap("sc-corrupt");
    const refs = refSet(2);
    const realBytes = serializeRefset(refs);
    const scSha = sha(realBytes);
    // Mint a receipt for scSha (size = the real length) but store WRONG bytes under that key.
    const wrong = serializeRefset(refSet(2).map((r, i) => ({ ...r, size: r.size + 100 + i })));
    await env.rbox_dev_blobs.put(blobKey(scSha), wrong);
    const receipt = await mintReceipt(env, { accountId: a.accountId, encSha: scSha, size: wrong.length, nowMs: Date.now() });
    const r = await resolveSidecarBytes(env, env.rbox_dev_db, a.accountId, descriptor(refs, scSha), { [scSha]: receipt }, Date.now());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("badSidecar" in r).toBe(true);
  });
});
