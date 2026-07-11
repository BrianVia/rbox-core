import { expect, test } from "bun:test";
import { ResourceBudget } from "./budget.js";

test("ResourceBudget reserves, blocks FIFO, reconciles, and releases", async () => {
  const budget = new ResourceBudget(5);
  await budget.reserve(4);
  let first = false;
  let second = false;
  const a = budget.reserve(3).then(() => { first = true; });
  const b = budget.reserve(1).then(() => { second = true; });
  await Promise.resolve();
  expect([first, second]).toEqual([false, false]);
  budget.reconcile(4, 2);
  await a;
  expect([first, second, budget.used]).toEqual([true, false, 5]);
  budget.release(3);
  await b;
  expect(budget.used).toBe(3);
  expect(budget.highWater).toBe(5);
});

test("ResourceBudget admits one oversize reservation only at zero", async () => {
  const budget = new ResourceBudget(3);
  await budget.reserve(8);
  expect([budget.used, budget.highWater]).toEqual([8, 8]);
  let admitted = false;
  const pending = budget.reserve(1).then(() => { admitted = true; });
  await Promise.resolve();
  expect(admitted).toBe(false);
  budget.release(8);
  await pending;
  expect(budget.used).toBe(1);
  expect(budget.highWater).toBeLessThanOrEqual(budget.cap + 8);
});

test("ResourceBudget close rejects pending and future reserves", async () => {
  const budget = new ResourceBudget(1);
  await budget.reserve(1);
  const err = new Error("closed");
  const pending = budget.reserve(1);
  budget.close(err);
  await expect(pending).rejects.toBe(err);
  await expect(budget.reserve(1)).rejects.toBe(err);
});

test("ResourceBudget disabled axis remains uncharged", async () => {
  const budget = new ResourceBudget(0);
  await budget.reserve(99);
  budget.reconcile(99, 50);
  budget.release(50);
  expect([budget.used, budget.highWater]).toEqual([0, 0]);
});
