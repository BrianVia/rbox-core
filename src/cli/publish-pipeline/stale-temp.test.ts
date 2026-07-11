import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunTempDir, reclaimStaleTemps } from "./stale-temp.js";

test("stale temp sweep ignores embedded process identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-stale-"));
  const parent = path.join(root, ".rbox", "state", "tmp");
  try {
    await fs.mkdir(path.join(parent, `enc-${process.pid}-old`), { recursive: true });
    await fs.mkdir(path.join(parent, "enc-999999-old"));
    await fs.mkdir(path.join(parent, "keep"));
    expect(await reclaimStaleTemps(parent)).toBe(2);
    const run = await createRunTempDir(root);
    expect(path.isAbsolute(run)).toBe(true);
    expect((await fs.stat(run)).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(parent)).filter((name) => name.startsWith("enc-"))).toEqual([path.basename(run)]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
