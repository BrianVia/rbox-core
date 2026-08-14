import { afterEach, beforeEach, expect, test } from "bun:test";
import { RemoteContext } from "./remote/context.js";
import { RECEIPT_REDEEM_BATCH_MAX, RECEIPT_REDEEM_REQUEST_BYTES_MAX, initialReceiptSendCap, redeemReceipts } from "./remote/commits.js";
import { beginFirstPublishTiming, formatFirstPublishStats } from "./upload-lane-timing.js";
import { enterPushSpansForTest, type FirstPublishTiming } from "./push-spans.js";

const originalSendCap = process.env.RBOX_RECEIPT_SEND_CAP;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const key = (i: number) => `sha-${i.toString().padStart(64, "0")}`;

function restoreEnv(): void {
  if (originalSendCap === undefined) delete process.env.RBOX_RECEIPT_SEND_CAP;
  else process.env.RBOX_RECEIPT_SEND_CAP = originalSendCap;
}

// Reset the accumulator, then leave the drain unarmed.
const resetFirstPublishStats = () => {
  beginFirstPublishTiming(false);
  beginFirstPublishTiming(true);
  beginFirstPublishTiming(false);
};

let firstPublishTiming: FirstPublishTiming;
beforeEach(() => { firstPublishTiming = enterPushSpansForTest().firstPublish; });

afterEach(() => {
  resetFirstPublishStats();
  restoreEnv();
});

test("redeemReceipts clamps a raised session cap after a server rollback bounce", async () => {
  process.env.RBOX_RECEIPT_SEND_CAP = "15000";
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  for (let i = 0; i < 15_001; i++) ctx.receipts.set(key(i), `receipt-${i}`);
  const sizes: number[] = [];
  const settled = new Set<string>();
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url, init) => {
    const receipts = (JSON.parse(String(init.body)) as { receipts: Record<string, string> }).receipts;
    const entries = Object.entries(receipts);
    sizes.push(entries.length);
    if (entries.length > RECEIPT_REDEEM_BATCH_MAX) {
      return json(400, { error: "too_many_receipts", max: RECEIPT_REDEEM_BATCH_MAX });
    }
    for (const [sha] of entries) {
      expect(settled.has(sha)).toBe(false);
      settled.add(sha);
    }
    return json(200, { granted: entries.length, alreadyEntitled: 0, rejected: 0 });
  };

  const result = await redeemReceipts(ctx);

  expect(sizes).toEqual([15_000, 5_000, 5_000, 5_000, 1]);
  expect(result.map((r) => r.granted)).toEqual([5_000, 5_000, 5_000, 1]);
  expect(settled.size).toBe(15_001);
  expect(ctx.receipts.size).toBe(0);
  expect(ctx.receiptSendCap).toBe(5_000);
});

test("receipt send cap accepts only trimmed decimal digits and clamps valid values", () => {
  const cases: Array<[string | undefined, number]> = [
    [undefined, 5_000],
    ["", 5_000],
    ["0", 5_000],
    ["1e3", 5_000],
    ["1.0", 5_000],
    ["+12", 5_000],
    [" 12 ", 12],
    ["15001", 15_000],
  ];
  for (const [raw, expected] of cases) {
    if (raw === undefined) delete process.env.RBOX_RECEIPT_SEND_CAP;
    else process.env.RBOX_RECEIPT_SEND_CAP = raw;
    expect(initialReceiptSendCap()).toBe(expected);
  }
});

for (const [label, response] of [
  ["absent", { error: "too_many_receipts" }],
  ["non-numeric", { error: "too_many_receipts", max: "2" }],
  ["non-shrinking", { error: "too_many_receipts", max: 3 }],
] as const) {
  test(`redeemReceipts fails hard when a too_many_receipts max is ${label}`, async () => {
    process.env.RBOX_RECEIPT_SEND_CAP = "3";
    const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
    for (let i = 0; i < 3; i++) ctx.receipts.set(key(i), `receipt-${i}`);
    (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => json(400, response);

    await expect(redeemReceipts(ctx)).rejects.toThrow("invalid non-shrinking");
    expect([...ctx.receipts.keys()]).toEqual([key(0), key(1), key(2)]);
  });
}

test("redeemReceipts bounds repeated server cap shrink bounces", async () => {
  process.env.RBOX_RECEIPT_SEND_CAP = "10";
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  for (let i = 0; i < 10; i++) ctx.receipts.set(key(i), `receipt-${i}`);
  let requests = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url, init) => {
    requests++;
    const count = Object.keys((JSON.parse(String(init.body)) as { receipts: object }).receipts).length;
    return json(400, { error: "too_many_receipts", max: count - 1 });
  };

  await expect(redeemReceipts(ctx)).rejects.toThrow("more than 8 times");
  expect(requests).toBe(9);
  expect(ctx.receipts.size).toBe(10);
});

test("redeemReceipts fails hard on a malformed 422 without looping", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(key(1), "receipt-1");
  let requests = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => {
    requests++;
    return json(422, { missing: [key(2)] });
  };

  await expect(redeemReceipts(ctx)).rejects.toThrow("receipt redeem failed: malformed 422");
  expect([...ctx.receipts.entries()]).toEqual([[key(1), "receipt-1"]]);
  expect(requests).toBe(1);
});

test("redeemReceipts slices by exact serialized byte size and sends an oversized singleton", async () => {
  process.env.RBOX_RECEIPT_SEND_CAP = "15000";
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  const oneMiB = "r".repeat(1024 * 1024);
  for (let i = 0; i < 8; i++) ctx.receipts.set(key(i), `${oneMiB}${i}`);
  const bodyBytes: number[] = [];
  const sizes: number[] = [];
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url, init) => {
    const body = String(init.body);
    bodyBytes.push(Buffer.byteLength(body));
    const count = Object.keys((JSON.parse(body) as { receipts: object }).receipts).length;
    sizes.push(count);
    return json(200, { granted: count, alreadyEntitled: 0, rejected: 0 });
  };

  await redeemReceipts(ctx);
  expect(sizes).toEqual([6, 2]);
  expect(bodyBytes.every((bytes) => bytes <= RECEIPT_REDEEM_REQUEST_BYTES_MAX)).toBe(true);

  const oversized = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  oversized.receipts.set(key(99), "x".repeat(RECEIPT_REDEEM_REQUEST_BYTES_MAX + 1));
  let sentCount = 0;
  let sentBytes = 0;
  (oversized as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url, init) => {
    const body = String(init.body);
    sentBytes = Buffer.byteLength(body);
    sentCount = Object.keys((JSON.parse(body) as { receipts: object }).receipts).length;
    return json(413, { error: "body_too_large" });
  };
  await expect(redeemReceipts(oversized)).rejects.toThrow();
  expect(sentCount).toBe(1);
  expect(sentBytes).toBeGreaterThan(RECEIPT_REDEEM_REQUEST_BYTES_MAX);
});

test("default receipt send cap preserves the exact legacy request bodies", async () => {
  delete process.env.RBOX_RECEIPT_SEND_CAP;
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  const all: Array<[string, string]> = [];
  for (let i = 0; i < 12_001; i++) {
    const entry: [string, string] = [key(i), `receipt-${i}`];
    all.push(entry);
    ctx.receipts.set(...entry);
  }
  const bodies: string[] = [];
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url, init) => {
    const body = String(init.body);
    bodies.push(body);
    const count = Object.keys((JSON.parse(body) as { receipts: object }).receipts).length;
    return json(200, { granted: count, alreadyEntitled: 0, rejected: 0 });
  };

  await redeemReceipts(ctx);
  const expected = [all.slice(0, 5_000), all.slice(5_000, 10_000), all.slice(10_000)]
    .map((batch) => JSON.stringify({ receipts: Object.fromEntries(batch) }));
  expect(bodies).toEqual(expected);
});

test("redeem instrumentation counts bounces as requests but not submitted receipts twice", async () => {
  process.env.RBOX_RECEIPT_SEND_CAP = "4";
  const measured = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  for (let i = 0; i < 4; i++) measured.receipts.set(key(i), `receipt-${i}`);
  const sentBodies: string[] = [];
  (measured as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url, init) => {
    const body = String(init.body);
    sentBodies.push(body);
    const count = Object.keys((JSON.parse(body) as { receipts: object }).receipts).length;
    return count > 2
      ? json(400, { error: "too_many_receipts", max: 2 })
      : json(200, { granted: count, alreadyEntitled: 0, rejected: 0 });
  };
  beginFirstPublishTiming(true);
  await redeemReceipts(measured);
  expect(firstPublishTiming.stats.redeemRequestCount).toBe(3);
  expect(firstPublishTiming.stats.redeemReceiptCount).toBe(4);
  expect(firstPublishTiming.stats.redeemMaxEntryBytes).toBeGreaterThan(0);
  expect(firstPublishTiming.stats.redeemMaxRequestBytes).toBe(Math.max(...sentBodies.map((body) => Buffer.byteLength(body))));
  expect(formatFirstPublishStats(firstPublishTiming.stats)).toContain(
    `finalDrain0 rreq3 rcpt4 rentB${firstPublishTiming.stats.redeemMaxEntryBytes} rreqB${firstPublishTiming.stats.redeemMaxRequestBytes} flush0 authn0`,
  );

  resetFirstPublishStats();
  const unmeasured = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  unmeasured.receipts.set(key(10), "receipt");
  (unmeasured as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  await redeemReceipts(unmeasured);
  expect(firstPublishTiming.stats.redeemRequestCount).toBe(0);
  expect(firstPublishTiming.stats.redeemReceiptCount).toBe(0);
  expect(firstPublishTiming.stats.redeemMaxEntryBytes).toBe(0);
  expect(firstPublishTiming.stats.redeemMaxRequestBytes).toBe(0);
});

test("redeem instrumentation counts entries on a definitive generic error response", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(key(1), "receipt-1");
  ctx.receipts.set(key(2), "receipt-2");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    json(400, { error: "bad_request" });
  beginFirstPublishTiming(true);

  await expect(redeemReceipts(ctx)).rejects.toThrow("receipt redeem failed");
  expect(firstPublishTiming.stats.redeemRequestCount).toBe(1);
  expect(firstPublishTiming.stats.redeemReceiptCount).toBe(2);
  expect(ctx.receipts.size).toBe(2);
});

test("redeemReceipts preserves the parsed-null TypeError compatibility edge", async () => {
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  ctx.receipts.set(key(1), "receipt-1");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    new Response("null", { status: 400, headers: { "content-type": "application/json" } });

  const error = await redeemReceipts(ctx).catch((cause) => cause);
  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toBe("null is not an object (evaluating 'body.error')");
  expect(ctx.receipts.size).toBe(1);
});
