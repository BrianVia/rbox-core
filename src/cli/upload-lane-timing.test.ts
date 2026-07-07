import { expect, test } from "bun:test";

test("RBOX_LANE_TIMING=1 push reports upload lane timing for file blobs", () => {
  const code = `
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { push } from "./src/cli/sync.js";
    import { bootstrapOnto, cfgFor, FakeServer, remoteFor } from "./src/cli/e2ee-fake-server.js";
    import { uploadLaneTiming, uploadLaneTimingSummary } from "./src/cli/sync-recovery.js";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-upload-lane-test-"));
    try {
      const server = new FakeServer();
      const secrets = await bootstrapOnto(server, "acct_lane", "dev_lane", 1_900_000_000_000);
      const remote = remoteFor(server, secrets, "acct_lane", "ws_lane", 1_900_000_005_000);
      const cfg = await cfgFor(root, secrets, remote, "ws_lane");

      await fs.writeFile(path.join(root, "a.txt"), "alpha\\n");
      await fs.writeFile(path.join(root, "b.txt"), "bravo\\n");
      await fs.writeFile(path.join(root, "c.txt"), "charlie\\n");

      uploadLaneTiming.encryptMs = 0;
      uploadLaneTiming.uploadMs = 0;
      uploadLaneTiming.blobs = 0;
      uploadLaneTiming.bytes = 0;

      let captured = "";
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, encoding, cb) => {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : undefined);
        if (typeof encoding === "function") encoding();
        if (typeof cb === "function") cb();
        return true;
      };
      try {
        await push(root, cfg, { remote, backoff: async () => {} });
      } finally {
        process.stderr.write = origWrite;
      }

      console.log(JSON.stringify({ captured, summary: uploadLaneTimingSummary(), timing: uploadLaneTiming }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  `;

  const res = Bun.spawnSync(["bun", "-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, RBOX_LANE_TIMING: "1" },
  });
  const stderr = res.stderr.toString();
  expect(res.exitCode, stderr).toBe(0);
  const out = JSON.parse(res.stdout.toString()) as {
    captured: string;
    summary: string;
    timing: { encryptMs: number; uploadMs: number; blobs: number; bytes: number };
  };

  expect(stderr).toBe("");
  expect(out.captured.trim()).toBe(out.summary);
  expect(out.summary).toMatch(/^lane timing \(push\): 3 blobs · encrypt /);
  expect(out.timing.blobs).toBe(3);
  expect(out.timing.bytes).toBeGreaterThan(0);
  expect(out.timing.encryptMs).toBeGreaterThan(0);
  expect(out.timing.uploadMs).toBeGreaterThan(0);
});
