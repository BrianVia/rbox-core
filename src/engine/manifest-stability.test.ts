import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { statsStableAcrossHash } from "./manifest.js";

describe("statsStableAcrossHash", () => {
  let dir: string;
  let stable: Stats;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-stat-stability-"));
    const file = path.join(dir, "file");
    await fs.writeFile(file, "content");
    stable = await fs.lstat(file);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const changed = (key: keyof Stats, value: unknown): Stats => {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(stable)), stable) as Stats;
    Object.defineProperty(copy, key, { configurable: true, value });
    return copy;
  };

  test("accepts identical regular-file stats", () => {
    expect(statsStableAcrossHash(stable, stable)).toBe(true);
  });

  test.each([
    ["size", () => stable.size + 1],
    ["mtimeMs", () => stable.mtimeMs + 1],
    ["ctimeMs", () => stable.ctimeMs + 1],
    ["mode", () => stable.mode ^ 0o100],
    ["ino", () => stable.ino + 1],
    ["dev", () => stable.dev + 1],
  ] as const)("rejects a changed %s", (key, value) => {
    expect(statsStableAcrossHash(stable, changed(key, value()))).toBe(false);
  });

  test("rejects a non-file post-stat", () => {
    const post = changed("isFile", () => false);
    expect(statsStableAcrossHash(stable, post)).toBe(false);
  });
});
