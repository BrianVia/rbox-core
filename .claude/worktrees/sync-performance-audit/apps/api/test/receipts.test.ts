import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { mintReceipt, verifyReceipt, RECEIPT_TTL_MS } from "../src/receipts.js";

// §23.1 receipt primitive — pure crypto, no D1/R2. crypto.subtle is workerd-global.
const KEY = "k".repeat(40);
const PREV = "p".repeat(40);
const envWith = (k?: string, prev?: string) => ({ RBOX_RECEIPT_KEY: k, RBOX_RECEIPT_KEY_PREV: prev }) as Env;
const NOW = 1_700_000_000_000;
const claim = { accountId: "acc_1", encSha: "a".repeat(64), size: 4096, nowMs: NOW };

describe("§23.1 receipts: mint / verify", () => {
  it("round-trips a freshly minted receipt", async () => {
    const env = envWith(KEY);
    const r = await mintReceipt(env, claim);
    expect(await verifyReceipt(env, r, claim)).toEqual({ ok: true, size: claim.size });
  });

  it("rejects a tampered payload (bad_mac)", async () => {
    const env = envWith(KEY);
    const r = await mintReceipt(env, claim);
    const [kid, , mac] = r.split(".");
    // swap in a different valid-looking payload → MAC no longer matches
    const forged = await mintReceipt(env, { ...claim, size: 999 });
    const tampered = `${kid}.${forged.split(".")[1]}.${mac}`;
    expect((await verifyReceipt(env, tampered, claim)).ok).toBe(false);
  });

  it("rejects a tampered MAC (bad_mac)", async () => {
    const env = envWith(KEY);
    const r = await mintReceipt(env, claim);
    const [kid, payload] = r.split(".");
    const res = await verifyReceipt(env, `${kid}.${payload}.${btoa("nope")}`, claim);
    expect(res).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("rejects an expired receipt", async () => {
    const env = envWith(KEY);
    const r = await mintReceipt(env, claim);
    const res = await verifyReceipt(env, r, { ...claim, nowMs: NOW + RECEIPT_TTL_MS + 1 });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a future-dated receipt beyond clock skew", async () => {
    const env = envWith(KEY);
    const r = await mintReceipt(env, { ...claim, nowMs: NOW + 10 * 60_000 }); // minted 10min ahead
    const res = await verifyReceipt(env, r, claim); // verifier's clock is 'now'
    expect(res).toEqual({ ok: false, reason: "future" });
  });

  it("rejects account / sha / size mismatch", async () => {
    const env = envWith(KEY);
    const r = await mintReceipt(env, claim);
    expect((await verifyReceipt(env, r, { ...claim, accountId: "acc_2" })).ok).toBe(false);
    expect((await verifyReceipt(env, r, { ...claim, encSha: "b".repeat(64) })).ok).toBe(false);
    expect((await verifyReceipt(env, r, { ...claim, size: 4097 })).ok).toBe(false);
    expect(await verifyReceipt(env, r, { ...claim, size: 4097 })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects malformed receipts", async () => {
    const env = envWith(KEY);
    expect((await verifyReceipt(env, "not-a-receipt", claim)).ok).toBe(false);
    expect((await verifyReceipt(env, "a.b", claim)).reason).toBe("malformed");
  });

  it("a receipt minted under PREV key still verifies; current-key mismatch → bad_kid", async () => {
    // mint with PREV as the sole key, then verify in an env where PREV is the rotated-out key
    const r = await mintReceipt(envWith(PREV), claim);
    const rotated = envWith(KEY, PREV); // current=KEY, prev=PREV
    expect(await verifyReceipt(rotated, r, claim)).toEqual({ ok: true, size: claim.size });
    // a receipt whose kid matches NEITHER key → bad_kid
    const stray = await mintReceipt(envWith("z".repeat(40)), claim);
    expect((await verifyReceipt(rotated, stray, claim)).reason).toBe("bad_kid");
  });

  it("fails closed when the key is missing or too short", async () => {
    await expect(mintReceipt(envWith(undefined), claim)).rejects.toThrow();
    await expect(mintReceipt(envWith("short"), claim)).rejects.toThrow();
    // a WELL-FORMED receipt cannot be accepted when the verifier has no key
    const r = await mintReceipt(envWith(KEY), claim);
    await expect(verifyReceipt(envWith(undefined), r, claim)).rejects.toThrow();
    await expect(verifyReceipt(envWith("short"), r, claim)).rejects.toThrow();
  });
});
