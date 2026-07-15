import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMetrics, saveMetrics } from "./metrics.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("metrics load is backward compatible and normalizes every counter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-metrics-"));
  roots.push(root);
  const state = path.join(root, ".rbox", "state");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "metrics.json"), JSON.stringify({
    syncs: -1,
    commitConflicts409: 1.5,
    fileConflicts: Number.MAX_SAFE_INTEGER + 1,
  }));
  expect(await loadMetrics(root)).toEqual({ syncs: 0, commitConflicts409: 0, fileConflicts: 0, lockStarved: 0 });

  await saveMetrics(root, { syncs: 1, commitConflicts409: 2, fileConflicts: 3, lockStarved: 4 });
  expect(await loadMetrics(root)).toEqual({ syncs: 1, commitConflicts409: 2, fileConflicts: 3, lockStarved: 4 });
});
