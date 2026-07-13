import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { mintGrant, verifyGrant, GRANT_TTL_MS } from "../src/grants.js";
import { mintReceipt } from "../src/receipts.js";

// §27 download-grant primitive — pure crypto, no D1/R2. crypto.subtle is workerd-global.
const KEY = "g".repeat(40);
const PREV = "h".repeat(40);
const envWith = (k?: string, prev?: string) => ({ RBOX_GRANT_KEY: k, RBOX_GRANT_KEY_PREV: prev }) as Env;
const NOW = 1_700_000_000_000;
const mint = { accountId: "acc_1", workspaceId: "ws_1", nowMs: NOW };
const verify = { accountId: "acc_1", nowMs: NOW };

describe("§27 download grants: mint / verify", () => {
  it("round-trips a freshly minted grant", async () => {
    const env = envWith(KEY);
    const g = await mintGrant(env, mint);
    expect(typeof g).toBe("string");
    expect(await verifyGrant(env, g!, verify)).toEqual({ ok: true });
  });

  it("is honored only for the account it was minted for (account bind)", async () => {
    const env = envWith(KEY);
    const g = await mintGrant(env, mint);
    // The grant's `a` must equal the AUTHENTICATED principal — a different account is rejected,
    // so a stolen grant is useless without also stealing that account's device token.
    expect(await verifyGrant(env, g!, { accountId: "acc_2", nowMs: NOW })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("does NOT bind workspace at verify (blobGet has no ws context)", async () => {
    // A grant minted for ws_1 still verifies — `w` is provenance/audit, not a GET-enforced scope.
    const env = envWith(KEY);
    const g = await mintGrant(env, { ...mint, workspaceId: "ws_other" });
    expect(await verifyGrant(env, g!, verify)).toEqual({ ok: true });
  });

  it("rejects a tampered payload (bad_mac)", async () => {
    const env = envWith(KEY);
    const g = await mintGrant(env, mint);
    const [kid, , mac] = g!.split(".");
    const forged = await mintGrant(env, { ...mint, accountId: "acc_evil" });
    const tampered = `${kid}.${forged!.split(".")[1]}.${mac}`;
    expect((await verifyGrant(env, tampered, verify)).ok).toBe(false);
  });

  it("rejects a tampered MAC (bad_mac)", async () => {
    const env = envWith(KEY);
    const g = await mintGrant(env, mint);
    const [kid, payload] = g!.split(".");
    expect(await verifyGrant(env, `${kid}.${payload}.${btoa("nope")}`, verify)).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("rejects an expired grant", async () => {
    const env = envWith(KEY);
    const g = await mintGrant(env, mint);
    expect(await verifyGrant(env, g!, { accountId: "acc_1", nowMs: NOW + GRANT_TTL_MS + 1 })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a future-dated grant beyond clock skew", async () => {
    const env = envWith(KEY);
    const g = await mintGrant(env, { ...mint, nowMs: NOW + 10 * 60_000 }); // minted 10min ahead
    expect(await verifyGrant(env, g!, verify)).toEqual({ ok: false, reason: "future" });
  });

  it("rejects malformed grants", async () => {
    const env = envWith(KEY);
    expect((await verifyGrant(env, "not-a-grant", verify)).ok).toBe(false);
    expect((await verifyGrant(env, "a.b", verify)).reason).toBe("malformed");
  });

  it("a grant minted under PREV key still verifies; kid matching neither → bad_kid", async () => {
    const g = await mintGrant(envWith(PREV), mint);
    const rotated = envWith(KEY, PREV); // current=KEY, prev=PREV
    expect(await verifyGrant(rotated, g!, verify)).toEqual({ ok: true });
    const stray = await mintGrant(envWith("z".repeat(40)), mint);
    expect((await verifyGrant(rotated, stray!, verify)).reason).toBe("bad_kid");
  });

  it("is BEST-EFFORT (not fail-closed): no/short key ⇒ mint undefined, verify {ok:false} — never throws", async () => {
    // Unlike §23 receipts (which THROW on a missing key), a missing grant key must degrade
    // gracefully to the D1 fallback path, never break the pull.
    expect(await mintGrant(envWith(undefined), mint)).toBeUndefined();
    expect(await mintGrant(envWith("short"), mint)).toBeUndefined();
    const g = await mintGrant(envWith(KEY), mint);
    expect(await verifyGrant(envWith(undefined), g!, verify)).toEqual({ ok: false, reason: "no_key" });
    expect(await verifyGrant(envWith("short"), g!, verify)).toEqual({ ok: false, reason: "no_key" });
  });

  it("domain separation: a §23 receipt string never verifies as a §27 grant", async () => {
    // Same key material, different domain tag ⇒ a receipt MAC can't be replayed as a grant.
    const receiptEnv = { RBOX_RECEIPT_KEY: KEY } as Env;
    const grantEnv = envWith(KEY);
    const receipt = await mintReceipt(receiptEnv, { accountId: "acc_1", encSha: "a".repeat(64), size: 10, nowMs: NOW });
    expect((await verifyGrant(grantEnv, receipt, verify)).ok).toBe(false);
  });
});
