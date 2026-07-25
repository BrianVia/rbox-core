import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONTENT_EQUIVALENCE_CACHE_MAX_ENTRIES,
  loadContentEquivalenceCache,
  resetContentEquivalenceCachesForTests,
} from "./content-equivalence-cache.js";

let root: string | undefined;

afterEach(async () => {
  resetContentEquivalenceCachesForTests();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

test("content-equivalence cache persists immutable pair results", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-content-equivalence-cache-"));
  const tip = "a".repeat(40);
  const durable = "b".repeat(40);
  const cache = await loadContentEquivalenceCache(root);
  cache.set(tip, durable, true);
  await cache.save();

  resetContentEquivalenceCachesForTests();
  const reloaded = await loadContentEquivalenceCache(root);
  expect(reloaded.get(tip, durable)).toBe(true);
});

test("content-equivalence cache evicts the least-recently-used pair at its bound", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-content-equivalence-lru-"));
  let clock = 0;
  const { WorkspaceContentEquivalenceCache } = await import("./content-equivalence-cache.js");
  const cache = new WorkspaceContentEquivalenceCache(root, new Map(), () => clock++);
  for (let i = 0; i <= CONTENT_EQUIVALENCE_CACHE_MAX_ENTRIES; i++) {
    cache.set(i.toString(16).padStart(40, "0"), "f".repeat(40), i % 2 === 0);
  }
  expect(cache.get("0".repeat(40), "f".repeat(40))).toBeUndefined();
  expect(cache.get(CONTENT_EQUIVALENCE_CACHE_MAX_ENTRIES.toString(16).padStart(40, "0"), "f".repeat(40))).toBe(true);
  await cache.save();
  const persisted = JSON.parse(await fs.readFile(
    path.join(root, ".rbox", "state", "git-content-equivalence.json"),
    "utf8",
  )) as { entries: Record<string, unknown> };
  expect(Object.keys(persisted.entries)).toHaveLength(CONTENT_EQUIVALENCE_CACHE_MAX_ENTRIES);
});
