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
      uploadLaneTiming.queueMs = 0;
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
    timing: { encryptMs: number; uploadMs: number; queueMs: number; blobs: number; bytes: number };
  };

  expect(stderr).toBe("");
  expect(out.captured.trim()).toBe(out.summary);
  expect(out.summary).toMatch(/^lane timing \(push\): 3 blobs · encrypt /);
  expect(out.timing.blobs).toBe(3);
  expect(out.timing.bytes).toBeGreaterThan(0);
  expect(out.timing.encryptMs).toBeGreaterThan(0);
  expect(out.timing.uploadMs).toBeGreaterThan(0);
});

test("batched upload lane timing separates tail queue wait from HTTP upload time", () => {
  const code = `
    import { createHash } from "node:crypto";
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { RboxApi } from "./src/cli/remote.js";
    import { uploadLaneTiming } from "./src/cli/upload-lane-timing.js";

    const sha = (b) => createHash("sha256").update(b).digest("hex");
    const decode = (body) => {
      const out = [];
      for (let off = 0; off < body.byteLength;) {
        const head = body.subarray(off, off + 36);
        off += 36;
        const s = [...head.subarray(0, 32)].map((x) => x.toString(16).padStart(2, "0")).join("");
        const len = new DataView(head.buffer, head.byteOffset + 32, 4).getUint32(0, false);
        out.push({ sha: s, payload: body.subarray(off, off + len) });
        off += len;
      }
      return out;
    };

    uploadLaneTiming.encryptMs = 0;
    uploadLaneTiming.uploadMs = 0;
    uploadLaneTiming.queueMs = 0;
    uploadLaneTiming.blobs = 0;
    uploadLaneTiming.bytes = 0;

    let batchCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith("/v1/blob-batch/put")) return new Response("not found", { status: 404 });
      batchCalls++;
      const body = init.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init.body).arrayBuffer());
      const records = decode(body);
      await new Promise((r) => setTimeout(r, 1));
      return new Response(JSON.stringify({ results: records.map(({ sha, payload }) => ({ sha256: sha, ok: true, sizeBytes: payload.byteLength, receipt: "r-" + sha })) }), { headers: { "content-type": "application/json" } });
    };

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-batch-lane-"));
    try {
      const payload = Buffer.from("tail timing");
      const file = path.join(root, "blob.bin");
      await fs.writeFile(file, payload);
      await new RboxApi("https://api.test", "tok", "ws", "proj").putBlobFile(sha(payload), file, payload.byteLength);
      console.log(JSON.stringify({ batchCalls, timing: uploadLaneTiming }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  `;

  const res = Bun.spawnSync(["bun", "-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, RBOX_LANE_TIMING: "1", RBOX_BATCH_RECORDS: "32" },
  });
  expect(res.exitCode, res.stderr.toString()).toBe(0);
  const out = JSON.parse(res.stdout.toString()) as { batchCalls: number; timing: { uploadMs: number; queueMs: number; blobs: number } };
  expect(out.batchCalls).toBe(1);
  expect(out.timing.blobs).toBe(1);
  expect(out.timing.uploadMs).toBeGreaterThan(0);
  expect(out.timing.queueMs).toBeGreaterThan(out.timing.uploadMs);
});
