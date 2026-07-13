import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RemoteContext } from "../remote/context.js";
import { ReceiptDrainer } from "./receipt-drainer.js";
import { redeemReceipts } from "../remote/commits.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const port = (ctx: RemoteContext) => ({
  receiptCount: () => ctx.receipts.size,
  redeem: () => redeemReceipts(ctx),
});

test("ReceiptDrainer is single-flight and wakes backlog waiters on drain completion", async () => {
  const ctx = new RemoteContext("https://test", "t", "w", "p");
  ctx.receipts.set(sha("a"), "a");
  ctx.receipts.set(sha("b"), "b");
  ctx.receipts.set(sha("c"), "c");
  let release!: () => void;
  let calls = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  };
  const drainer = new ReceiptDrainer(port(ctx), { threshold: 1, backlogMax: 2, onError() {} });
  drainer.capture();
  drainer.capture();
  const backlog = drainer.waitForBacklog();
  await Promise.resolve();
  expect(calls).toBe(1);
  release();
  await backlog;
  await drainer.flush();
  expect([calls, drainer.backlogMax]).toEqual([1, 2]);
});

test("ReceiptDrainer maybeKick drains below-threshold pre-existing receipts", async () => {
  const ctx = new RemoteContext("https://test", "t", "w", "p");
  ctx.receipts.set(sha("a"), "a");
  let calls = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => {
    calls++;
    return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  };
  const drainer = new ReceiptDrainer(port(ctx), { threshold: 10, backlogMax: 20, onError() {} });
  drainer.maybeKick();
  await drainer.flush();
  expect(calls).toBe(1);
});

test("ReceiptDrainer latches errors and flush rethrows", async () => {
  const ctx = new RemoteContext("https://test", "t", "w", "p");
  ctx.receipts.set(sha("a"), "a");
  const err = new Error("network");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => { throw err; };
  let latched: Error | undefined;
  const drainer = new ReceiptDrainer(port(ctx), { threshold: 1, backlogMax: 2, onError(e) { latched = e; } });
  drainer.capture();
  await expect(drainer.flush()).rejects.toBe(err);
  expect(drainer.error).toBe(err);
  expect(latched).toBe(err);
});

test("ReceiptDrainer accumulates 422 residue until replacement is settled", async () => {
  const address = sha("a");
  const ctx = new RemoteContext("https://test", "t", "w", "p");
  let response = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () =>
    response++ === 0
      ? json(422, { missing: [address] })
      : json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  const drainer = new ReceiptDrainer(port(ctx), { threshold: 10, backlogMax: 20, onError() {} });
  ctx.receipts.set(address, "old");
  expect(await drainer.flush()).toEqual({ needsUpload: [address] });
  ctx.receipts.set(address, "replacement");
  drainer.capture();
  expect(await drainer.flush()).toEqual({ needsUpload: [] });
});

test("ReceiptDrainer preserves a replacement receipt installed during an in-flight drain", async () => {
  const address = sha("generation-safe");
  const ctx = new RemoteContext("https://test", "t", "w", "p");
  ctx.receipts.set(address, "old");
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const sent: string[] = [];
  let calls = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { receipts: Record<string, string> };
    sent.push(body.receipts[address]!);
    calls++;
    if (calls === 1) {
      markFirstStarted();
      await firstHeld;
    }
    return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  };
  const drainer = new ReceiptDrainer(port(ctx), { threshold: 1, backlogMax: 2, onError() {} });
  drainer.capture();
  const flushed = drainer.flush();
  try {
    await firstStarted;
    ctx.receipts.set(address, "replacement");
    releaseFirst();
    expect(await flushed).toEqual({ needsUpload: [] });
    expect(sent).toEqual(["old", "replacement"]);
    expect(ctx.receipts.size).toBe(0);
  } finally {
    releaseFirst();
    await flushed.catch(() => {});
  }
});
