import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteContext } from "./context.js";
import { startFakeMultipartServer } from "./multipart-fake-server.js";
import { readMultipartServerTimings } from "./multipart-metrics.js";
import { putBlobMultipart } from "./multipart.js";

const METRIC_SHAPE = /^rbox multipart parts=\d+ bytes=\d+ partWall p50=\d+ p95=\d+ max=\d+ sum=\d+ms gap p50=\d+ p95=\d+ max=\d+ sum=\d+ms complete=\d+ms retries=\d+ reinit=\d+(?: srv total=\d+ assemble=\d+ reread=\d+ acct=\d+)?$/;
const previousMetricsEnv = process.env.RBOX_METRICS;

afterEach(() => {
  if (previousMetricsEnv === undefined) delete process.env.RBOX_METRICS;
  else process.env.RBOX_METRICS = previousMetricsEnv;
});

async function makeBlob(size: number): Promise<{ dir: string; file: string; sha: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-multipart-instrumentation-"));
  const file = path.join(dir, "private-source-name.bin");
  // Deterministic bytes make failures reproducible; the fake server independently hashes
  // the assembled upload, so this still exercises the real streaming upload path.
  const bytes = Buffer.alloc(size, 0xa7);
  await fs.writeFile(file, bytes);
  return { dir, file, sha: createHash("sha256").update(bytes).digest("hex") };
}

describe("multipart client instrumentation", () => {
  test("a real three-part upload emits exactly one numbers-only line with server timings", async () => {
    process.env.RBOX_METRICS = "1";
    const blob = await makeBlob(24 * 1024 * 1024);
    const server = await startFakeMultipartServer({ partSize: 8 * 1024 * 1024, partLatencyMs: 1 });
    const lines: string[] = [];
    try {
      const ctx = new RemoteContext(server.baseUrl, "test-token", "test-workspace", "test-project", (line) => lines.push(line));
      await putBlobMultipart(ctx, blob.sha, blob.file, 24 * 1024 * 1024);

      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line).toContain("parts=3");
      expect(line).toMatch(/bytes=[1-9]\d*/);
      expect(line).toMatch(/complete=\d+ms/);
      expect(line).toMatch(/ srv total=\d+ assemble=\d+ reread=\d+ acct=\d+$/);
      expect(line).toMatch(METRIC_SHAPE);

      // No content address, file location, or path-like token may escape into telemetry.
      expect(line).not.toContain(blob.sha);
      expect(line).not.toMatch(/[0-9a-fA-F]{40,}/);
      expect(line).not.toContain(blob.file);
      for (const segment of blob.file.split(path.sep).filter((part) => part.length > 3)) {
        expect(line).not.toContain(segment);
      }
      expect(line).not.toMatch(/[\\/]/);
      expect(server.stats.completedParts).toBe(3);
    } finally {
      await server.close();
      await fs.rm(blob.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an old server omitting serverTimings still emits without the srv suffix", async () => {
    process.env.RBOX_METRICS = "1";
    const blob = await makeBlob(32);
    const server = await startFakeMultipartServer({ partSize: 16, includeServerTimings: false });
    const lines: string[] = [];
    try {
      await putBlobMultipart(new RemoteContext(server.baseUrl, "token", "workspace", "project", (line) => lines.push(line)), blob.sha, blob.file, 32);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(METRIC_SHAPE);
      expect(lines[0]).not.toContain(" srv ");
      expect(readMultipartServerTimings(undefined)).toBeUndefined();
    } finally {
      await server.close();
      await fs.rm(blob.dir, { recursive: true, force: true });
    }
  });

  test("RBOX_METRICS=0 emits nothing and the upload still succeeds (pre-101 behavior)", async () => {
    process.env.RBOX_METRICS = "0";
    const blob = await makeBlob(32);
    const server = await startFakeMultipartServer({ partSize: 16 });
    const lines: string[] = [];
    try {
      await putBlobMultipart(new RemoteContext(server.baseUrl, "token", "workspace", "project", (line) => lines.push(line)), blob.sha, blob.file, 32);
      expect(lines).toEqual([]);
      expect(server.stats.completedParts).toBe(2);
    } finally {
      await server.close();
      await fs.rm(blob.dir, { recursive: true, force: true });
    }
  });

  test("one transient part failure is counted and the upload succeeds", async () => {
    process.env.RBOX_METRICS = "1";
    const blob = await makeBlob(32);
    const server = await startFakeMultipartServer({ partSize: 16, failPartOnce: 1 });
    const lines: string[] = [];
    try {
      await putBlobMultipart(new RemoteContext(server.baseUrl, "token", "workspace", "project", (line) => lines.push(line)), blob.sha, blob.file, 32);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("retries=1");
      expect(server.stats.transientFailures).toBe(1);
      expect(server.stats.completeRequests).toBe(1);
      expect(server.stats.completedParts).toBe(2);
    } finally {
      await server.close();
      await fs.rm(blob.dir, { recursive: true, force: true });
    }
  }, 30_000);
});
