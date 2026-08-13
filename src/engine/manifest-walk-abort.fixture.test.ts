import { expect, mock, test } from "bun:test";
import realFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DirCacheChild, DirCacheFile } from "./dircache.js";

if (process.env.RBOX_WALK_ABORT_FIXTURE !== "1") {
  test.skip("abort fixture runs in an isolated subprocess", () => {});
} else {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), "rbox-walk-abort-"));
  const blockers = Array.from({ length: 15 }, (_, index) => `blocker-${String(index).padStart(2, "0")}`);
  for (const name of [...blockers, "trigger", "after-a", "after-b"]) await realFs.mkdir(path.join(root, name));
  await realFs.writeFile(path.join(root, "trigger", ".gitignore"), "ignored\n");
  await new Promise((resolve) => setTimeout(resolve, 2_100));

  let releaseBlockers!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseBlockers = resolve; });
  let retryStarted = false;
  const starts: Array<{ rel: string; retry: boolean }> = [];

  mock.module("node:fs/promises", () => ({
    ...realFs,
    async readdir(target: string, options: Parameters<typeof realFs.readdir>[1]) {
      const rel = path.relative(root, target).replaceAll(path.sep, "/") || ".";
      starts.push({ rel, retry: retryStarted });
      if (rel === ".") retryStarted = true;
      if (!retryStarted && blockers.includes(rel)) await blocked;
      if (!retryStarted && rel === "trigger") setTimeout(releaseBlockers, 0);
      return realFs.readdir(target, options);
    },
  }));

  const { DirCache } = await import("./dircache.js");
  const { scanManifest } = await import("./manifest.js");

  test("queued walk tasks stay fenced until the retry", async () => {
    const st = await realFs.lstat(root);
    const children: DirCacheChild[] = [
      ...blockers.map((name): DirCacheChild => ({ name, type: "dir" })),
      { name: "trigger", type: "dir" },
      { name: "after-a", type: "dir" },
      { name: "after-b", type: "dir" },
    ];
    const cacheFile: DirCacheFile = {
      version: 2,
      lastScanStartMs: Date.now(),
      lastUnprunedScanAtMs: Date.now(),
      ruleFiles: [{ relPath: ".gitignore", absent: true }, { relPath: ".rboxignore", absent: true }],
      entries: { "": { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, children } },
    };
    const stats = (await import("./manifest-accounting.js")).createScanStats();
    const manifest = await scanManifest(root, undefined, undefined, undefined, undefined, stats, undefined, undefined, new DirCache(cacheFile), "pruned");

    expect(stats.attempts.map(({ mode }) => mode)).toEqual(["pruned", "unpruned"]);
    expect(starts.filter(({ rel, retry }) => rel.startsWith("after-") && !retry)).toEqual([]);
    expect(manifest.files.some(({ path: rel }) => rel === "trigger/.gitignore")).toBe(true);
    await realFs.rm(root, { recursive: true, force: true });
  });
}
