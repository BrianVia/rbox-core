import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlobRetryLaterError } from "./remote.js";
import { putBlobFile } from "./remote/blobs.js";
import { RemoteContext } from "./remote/context.js";
import { putBlobMultipart } from "./remote/multipart.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const retryLater = () =>
  new Response(JSON.stringify({ error: "retry_later" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

test("legacy single PUT surfaces retry_later without an immediate transport retry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gc-retry-"));
  const file = path.join(dir, "blob");
  await fs.writeFile(file, "x");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return retryLater();
  }) as typeof fetch;
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");

  try {
    await expect(putBlobFile(ctx, "a".repeat(64), file, 1)).rejects.toBeInstanceOf(BlobRetryLaterError);
    expect(calls).toBe(1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("multipart COMPLETE retry_later removes its token and does not probe or re-init", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gc-mpu-retry-"));
  const file = path.join(dir, "blob");
  const uploads = path.join(dir, "uploads");
  const sha = "b".repeat(64);
  await fs.writeFile(file, "data");
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  const ctx = new RemoteContext("https://rbox.test", "tok", "ws", "root");
  let initCalls = 0;
  let missingCalls = 0;
  ctx.fetch = async (url) => {
    if (url.endsWith("/multipart")) {
      initCalls++;
      return new Response(JSON.stringify({ uploadId: "up1", partSize: 4 }), { status: 200 });
    }
    if (url.endsWith("/complete")) return retryLater();
    throw new Error(`unexpected request ${url}`);
  };
  ctx.missingBlobs = async () => {
    missingCalls++;
    return [sha];
  };

  try {
    await expect(putBlobMultipart(ctx, sha, file, 4, uploads)).rejects.toBeInstanceOf(BlobRetryLaterError);
    expect(initCalls).toBe(1);
    expect(missingCalls).toBe(0);
    expect(await fs.stat(path.join(uploads, `${sha}.json`)).then(() => true, () => false)).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
