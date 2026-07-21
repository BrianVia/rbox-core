import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SignedCommit } from "../engine/e2ee/index.js";
import { CommitRejectedError } from "./remote.js";
import { RemoteContext } from "./remote/context.js";
import { commitSigned, RECEIPT_REDEEM_BATCH_MAX, redeemReceipts } from "./remote/commits.js";
import { beginFirstPublishTiming, firstPublishTiming, firstPublishUploadEnd, firstPublishUploadStart } from "./upload-lane-timing.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const commit: SignedCommit = { body: "{}", commitHash: "a".repeat(64), sig: "sig" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const serverTimings = { totalMs: 7, envelopeMs: 1, accountingMs: 2, sidecarMs: 0, commitMs: 1, mirrorMs: 2, responseMs: 0 };

afterEach(() => beginFirstPublishTiming(false)); // the first-publish timing accumulator is a process-global singleton

test("redeemReceipts drains 12,001 receipts in 5k batches and clears each successful batch", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  for (let i = 0; i < 12_001; i++) ctx.receipts.set(sha(`receipt-${i}`), `r-${i}`);
  const sizes: number[] = [];
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { receipts: Record<string, string> };
    const size = Object.keys(body.receipts).length;
    sizes.push(size);
    return json(200, { granted: size, alreadyEntitled: 0, rejected: 0 });
  };

  const result = await redeemReceipts(ctx);

  expect(sizes).toEqual([RECEIPT_REDEEM_BATCH_MAX, RECEIPT_REDEEM_BATCH_MAX, 2_001]);
  expect(result.map((r) => r.granted)).toEqual([5_000, 5_000, 2_001]);
  expect(ctx.receipts.size).toBe(0);
});

test("commitSigned redeems first and posts an empty receipts map", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(sha("one"), "receipt-one");
  const paths: string[] = [];
  const ordering: string[] = [];
  const commitBodies: unknown[] = [];
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (url, init) => {
    paths.push(url);
    ordering.push(url.endsWith("/receipts/redeem") ? "redeem" : "post");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith("/receipts/redeem")) return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
    commitBodies.push(body);
    return json(200, { sequence: 1, serverTimings });
  };

  await expect(commitSigned(ctx, 0, commit, async () => { ordering.push("arm"); })).resolves.toEqual({ sequence: 1, serverTimings });
  expect(paths.map((p) => new URL(p).pathname)).toEqual([
    "/v1/ws/ws/proj/root/receipts/redeem",
    "/v1/ws/ws/proj/root/manifests",
  ]);
  expect(commitBodies).toEqual([{ parentSequence: 0, commit, receipts: {} }]);
  expect(ordering).toEqual(["redeem", "arm", "post"]);
  expect(ctx.receipts.size).toBe(0);
});

test("commitSigned preserves validated server timings on a conflict", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    json(409, { error: "conflict", head: 4, serverTimings });

  await expect(commitSigned(ctx, 3, commit)).resolves.toEqual({ conflict: true, head: 4, serverTimings });
});

test("commitSigned ignores malformed server timings from an old or mixed server", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    json(200, { sequence: 1, serverTimings: { ...serverTimings, mirrorMs: "slow" } });

  await expect(commitSigned(ctx, 0, commit)).resolves.toEqual({ sequence: 1 });
});

test("commitSigned maps a redeem fence abort to per-blob staging without posting the manifest", async () => {
  const fenced = sha("fenced");
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(fenced, "stale-receipt");
  const paths: string[] = [];
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (url) => {
    paths.push(new URL(url).pathname);
    return json(422, { error: "unsatisfied_blobs", missing: [fenced], missingTotal: 1 });
  };

  let armed = false;
  await expect(commitSigned(ctx, 0, commit, async () => { armed = true; })).resolves.toEqual({
    unsatisfiedBlobs: [fenced],
    unsatisfiedTotal: 1,
  });
  expect(paths).toEqual(["/v1/ws/ws/proj/root/receipts/redeem"]);
  expect(armed).toBe(false);
  expect(ctx.receipts.has(fenced)).toBe(false);
});

test("commitSigned leaves the publication receipt unarmed when redemption fails before POST", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(sha("redeem-failure"), "receipt");
  let armed = false;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (url) => {
    if (url.endsWith("/receipts/redeem")) throw new Error("redeem unavailable");
    throw new Error("manifest POST must not run");
  };

  await expect(commitSigned(ctx, 0, commit, async () => { armed = true; })).rejects.toThrow("redeem unavailable");
  expect(armed).toBe(false);
});

test("redeemReceipts clears the whole caught batch when a 422 omits missing detail", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  const shas = [sha("one"), sha("two")];
  for (const s of shas) ctx.receipts.set(s, `receipt-${s}`);
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => json(422, { error: "unsatisfied_blobs" });

  await expect(redeemReceipts(ctx)).resolves.toEqual([
    { granted: 0, alreadyEntitled: 0, rejected: 0, needsUpload: shas },
  ]);
  expect(ctx.receipts.size).toBe(0);
});

test("commitSigned maps too_many_refs 413 to CommitRejectedError with count and max", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    json(413, { error: "too_many_refs", count: 250_001, max: 250_000 });

  try {
    await commitSigned(ctx, 0, commit);
    throw new Error("expected rejection");
  } catch (e) {
    expect(e).toBeInstanceOf(CommitRejectedError);
    const err = e as CommitRejectedError;
    expect(err.reason).toBe("too_many_refs");
    expect(err.count).toBe(250_001);
    expect(err.max).toBe(250_000);
    expect(err.message).toBe(
      "workspace needs 250,001 blob refs per commit; the server cap is 250,000. Exclude large directories with `rbox ignore` or split the workspace.",
    );
  }
});

test("commitSigned maps body_too_large to CommitRejectedError", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    json(413, { error: "body_too_large", count: 9_000_000, max: 8_388_608 });

  await expect(commitSigned(ctx, 0, commit)).rejects.toBeInstanceOf(CommitRejectedError);
  await commitSigned(ctx, 0, commit).catch((e) => {
    expect((e as CommitRejectedError).reason).toBe("body_too_large");
  });
});

test("commitSigned preserves bounded 422 missingTotal", async () => {
  const missing = sha("missing");
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    json(422, { error: "unsatisfied_blobs", missing: [missing], missingTotal: 12_345 });

  await expect(commitSigned(ctx, 0, commit)).resolves.toEqual({
    unsatisfiedBlobs: [missing],
    unsatisfiedTotal: 12_345,
  });
});

test("finalDrainMs measures only commit-enclosed receipt drains and accumulates", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (url) => {
    if (url.endsWith("/receipts/redeem")) {
      await Bun.sleep(15);
      return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
    }
    return json(200, { sequence: 1 });
  };
  beginFirstPublishTiming(true);
  ctx.receipts.set(sha("direct"), "receipt-direct");
  await redeemReceipts(ctx);
  expect(firstPublishTiming.stats.receiptRedemptionWallMs).toBeGreaterThan(0);
  expect(firstPublishTiming.stats.finalDrainMs).toBe(0);

  ctx.receipts.set(sha("commit-one"), "receipt-one");
  const callT0 = performance.now();
  await commitSigned(ctx, 0, commit);
  const callWall = performance.now() - callT0;
  const afterFirst = firstPublishTiming.stats.finalDrainMs;
  expect(afterFirst).toBeGreaterThan(0);
  expect(afterFirst).toBeLessThanOrEqual(Math.ceil(callWall));

  ctx.receipts.set(sha("commit-two"), "receipt-two");
  await commitSigned(ctx, 1, commit);
  expect(firstPublishTiming.stats.finalDrainMs).toBeGreaterThan(afterFirst);
});

test("redeemReceipts credits only the upload-active parts of a drain", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  for (let i = 0; i <= RECEIPT_REDEEM_BATCH_MAX; i++) ctx.receipts.set(sha(`overlap-${i}`), `r-${i}`);
  let calls = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => {
    calls++;
    if (calls === 1) {
      await Bun.sleep(10);
      firstPublishUploadEnd();
    } else {
      await Bun.sleep(20);
    }
    return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  };
  beginFirstPublishTiming(true);
  firstPublishUploadStart();
  await redeemReceipts(ctx);
  expect(firstPublishTiming.stats.receiptRedemptionOverlapMs).toBeGreaterThan(0);
  expect(firstPublishTiming.stats.receiptRedemptionOverlapMs).toBeLessThan(firstPublishTiming.stats.receiptRedemptionWallMs);
});

test("redeemReceipts with no upload activity records no overlap", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(sha("no-overlap"), "receipt");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => {
    await Bun.sleep(5);
    return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  };
  beginFirstPublishTiming(true);
  await redeemReceipts(ctx);
  expect(firstPublishTiming.stats.receiptRedemptionWallMs).toBeGreaterThan(0);
  expect(firstPublishTiming.stats.receiptRedemptionOverlapMs).toBe(0);
});

test("a drain that starts unmeasured credits nothing to a measurement armed mid-drain", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(sha("late-arm"), "receipt");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => {
    beginFirstPublishTiming(true); // measurement armed while the unmeasured drain is in flight
    await Bun.sleep(5);
    return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  };
  await redeemReceipts(ctx);
  expect(firstPublishTiming.stats.receiptRedemptionWallMs).toBe(0);
  expect(firstPublishTiming.stats.receiptRedemptionOverlapMs).toBe(0);
  expect(firstPublishTiming.stats.finalDrainMs).toBe(0);
});

test("a commit-enclosed drain spanning a disarm/re-arm credits neither measurement", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(sha("span"), "receipt");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (url) => {
    if (url.endsWith("/receipts/redeem")) {
      beginFirstPublishTiming(false); // measurement A ends mid-drain…
      beginFirstPublishTiming(true); // …and measurement B arms before the drain settles
      await Bun.sleep(5);
      return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
    }
    return json(200, { sequence: 1 });
  };
  beginFirstPublishTiming(true);
  await commitSigned(ctx, 0, commit);
  expect(firstPublishTiming.stats.receiptRedemptionWallMs).toBe(0);
  expect(firstPublishTiming.stats.finalDrainMs).toBe(0);
});
