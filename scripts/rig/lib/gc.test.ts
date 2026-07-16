import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatBytes, parseDfAvailableBytes, trimRunDirectories, trimWorkloadCache } from "./gc.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rig-gc-"));
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); });
function entry(name: string, bytes: number, age: number): void {
  const dir = path.join(root, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "data"), "x".repeat(bytes));
  const when = new Date(Date.now() - age); fs.utimesSync(dir, when, when);
}

test("run retention keeps the newest N directories", () => {
  entry("old", 10, 3000); entry("middle", 20, 2000); entry("new", 30, 1000);
  const result = trimRunDirectories(root, 2);
  expect(result.entries).toBe(1); expect(result.bytes).toBeGreaterThanOrEqual(10);
  expect(fs.existsSync(path.join(root, "old"))).toBe(false);
});

test("workload cache evicts LRU entries until below its byte cap", () => {
  entry("old", 100, 3000); entry("new", 100, 1000);
  const oneEntryCap = fs.statSync(path.join(root, "new")).size + fs.statSync(path.join(root, "new", "data")).size;
  const result = trimWorkloadCache(root, oneEntryCap);
  expect(result.entries).toBeGreaterThanOrEqual(1);
  expect(fs.existsSync(path.join(root, "old"))).toBe(false);
  expect(fs.existsSync(path.join(root, "new"))).toBe(true);
});

test("df headroom parser and byte renderer are deterministic", () => {
  expect(parseDfAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 20 80 20% /x\n")).toEqual([80 * 1024]);
  expect(formatBytes(20 * 1024 ** 3)).toBe("20 GiB");
});
