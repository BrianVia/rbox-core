import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RemoteContext } from "../remote/context.js";
import { ReceiptDrainer } from "./receipt-drainer.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("ReceiptDrainer is single-flight and signals drain completion", async () => {
  const ctx = new RemoteContext("https://test", "t", "w", "p");
  ctx.receipts.set(sha("a"), "a");
  let release!: () => void;
  let calls = 0;
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return json(200, { granted: 1, alreadyEntitled: 0, rejected: 0 });
  };
  let completed = 0;
  const drainer = new ReceiptDrainer(ctx, { threshold: 1, backlogMax: 2, onError() {} });
  drainer.onDrainComplete(() => { completed++; });
  drainer.capture();
  drainer.capture();
  await Promise.resolve();
  expect(calls).toBe(1);
  release();
  await drainer.flush();
  expect([calls, completed, drainer.backlogMax]).toEqual([1, 1, 2]);
});

test("ReceiptDrainer latches errors and flush rethrows", async () => {
  const ctx = new RemoteContext("https://test", "t", "w", "p");
  ctx.receipts.set(sha("a"), "a");
  const err = new Error("network");
  (ctx as unknown as { fetch: RemoteContext["fetch"] }).fetch = async () => { throw err; };
  let latched: Error | undefined;
  const drainer = new ReceiptDrainer(ctx, { threshold: 1, backlogMax: 2, onError(e) { latched = e; } });
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
  const drainer = new ReceiptDrainer(ctx, { threshold: 10, backlogMax: 20, onError() {} });
  ctx.receipts.set(address, "old");
  expect(await drainer.flush()).toEqual({ needsUpload: [address] });
  ctx.receipts.set(address, "replacement");
  drainer.capture();
  expect(await drainer.flush()).toEqual({ needsUpload: [] });
});
