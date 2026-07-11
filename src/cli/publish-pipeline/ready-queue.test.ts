import { expect, test } from "bun:test";
import type { FileEntry } from "../../engine/index.js";
import { EOF, ReadyQueue, type ReadyBlob } from "./ready-queue.js";

const blob = (n: number): ReadyBlob => ({
  file: { path: `f${n}`, type: "file", mode: 0o644, size: n } as FileEntry,
  encSha: String(n), cipherSize: n, path: `p${n}`, diskCharge: n, release() {},
});

test("ReadyQueue pushes, pulls, applies backpressure, then emits EOF", async () => {
  const queue = new ReadyQueue({ maxItems: 1 });
  await queue.push(blob(1));
  let pushed = false;
  const pending = queue.push(blob(2)).then(() => { pushed = true; });
  await Promise.resolve();
  expect(pushed).toBe(false);
  expect(await queue.pull()).toMatchObject({ encSha: "1" });
  await pending;
  queue.closeForWriting();
  expect(await queue.pull()).toMatchObject({ encSha: "2" });
  expect(await queue.pull()).toBe(EOF);
});

test("ReadyQueue close resolves an already-waiting pull with EOF", async () => {
  const queue = new ReadyQueue();
  const pull = queue.pull();
  queue.closeForWriting();
  expect(await pull).toBe(EOF);
  await expect(queue.push(blob(1))).rejects.toThrow("closed");
});

test("ReadyQueue abort wakes blocked pushes and pulls", async () => {
  const full = new ReadyQueue({ maxItems: 1 });
  await full.push(blob(1));
  const blockedPush = full.push(blob(2));
  const empty = new ReadyQueue();
  const blockedPull = empty.pull();
  const pushRejected = blockedPush.catch((error) => error);
  const pullRejected = blockedPull.catch((error) => error);
  const err = new Error("abort");
  full.abort(err);
  empty.abort(err);
  expect(await pushRejected).toBe(err);
  expect(await pullRejected).toBe(err);
});
