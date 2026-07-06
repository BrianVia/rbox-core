import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NetworkError, RboxApi, createRemoteWorkspace } from "./remote.js";

// End-to-end (through RboxApi, above the fetch seam) proof of the per-endpoint retry policy:
//   - a content-addressed blob PUT retries a transient socket close and then succeeds;
//   - the multipart COMPLETE is NOT network-retried — a transient there is absorbed by the
//     existing missingBlobs present-check (the blob published despite the dropped response),
//     NOT by a second complete POST (the deliberate idempotency-safety decision);
//   - a commit 409 (a duplicate after a socket-close-post-apply) passes through as a conflict.
const socketClosed = () =>
  Object.assign(new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"), {
    code: "ECONNRESET",
  });

const resp = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  }) as Response;

const origFetch = globalThis.fetch;
const origAbortSignalTimeout = AbortSignal.timeout;
const SHA = "b".repeat(64);
const BIG = 100 * 1024 * 1024; // > SINGLE_PUT_MAX (90 MiB) → multipart
const api = () => new RboxApi("https://api.test", "tok", "ws_1", "proj_1");

async function readBodyText(body: BodyInit | null | undefined): Promise<string> {
  expect(body).toBeInstanceOf(ReadableStream);
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function stalledBodyResponse(signal: AbortSignal): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  } as Response;
}

function transientAfterPartialBody(bytes: Uint8Array): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        controller.error(socketClosed());
      },
    }),
    { status: 200 }
  );
}

// Speed: collapse the retry backoff so these run instantly.
beforeEach(() => {
  process.env.RBOX_NET_RETRIES = "2";
});
afterEach(() => {
  globalThis.fetch = origFetch;
  (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = origAbortSignalTimeout;
});

describe("blob PUT — transient retry (idempotent, content-addressed)", () => {
  let tmp: string;
  let file: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-net-"));
    file = path.join(tmp, "ct.bin");
    await fs.writeFile(file, "ciphertext");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("a single-PUT that drops once is retried with a fresh unconsumed body stream", async () => {
    let puts = 0;
    const bodies = new Set<BodyInit>();
    const payloads: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        puts++;
        expect(init?.body).toBeTruthy();
        expect(bodies.has(init!.body!)).toBe(false);
        bodies.add(init!.body!);
        payloads.push(await readBodyText(init!.body));
        if (puts === 1) throw socketClosed();
        return resp(200, { receipt: "r1" });
      }
      return resp(200, {});
    }) as unknown as typeof fetch;
    // backoff via a monkeypatched short timer is unnecessary: the default 1s/4s runs, but the test
    // stays fast because only ONE retry fires. Keep the assertion on behavior, not timing.
    await api().putBlobFile(SHA, file, 10);
    expect(puts).toBe(2);
    expect(payloads).toEqual(["ciphertext", "ciphertext"]);
  }, 15_000);
});

describe("buffered blob GET — stalled OK body is inside the retry deadline", () => {
  test("a headers-then-stalled body times out, retries, and succeeds on attempt 2", async () => {
    let gets = 0;
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = (() => {
      const ctrl = new AbortController();
      queueMicrotask(() => ctrl.abort(new DOMException("buffered body stalled", "TimeoutError")));
      return ctrl.signal;
    }) as typeof AbortSignal.timeout;

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      gets++;
      if (gets === 1) return stalledBodyResponse(init!.signal as AbortSignal);
      return new Response("ciphertext", { status: 200 });
    }) as unknown as typeof fetch;

    const out = await api().getBlob(SHA);
    expect(out.toString("utf8")).toBe("ciphertext");
    expect(gets).toBe(2);
  }, 15_000);
});

describe("streaming blob GET — retry starts from a clean destination file", () => {
  let tmp: string;
  let dest: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-net-get-"));
    dest = path.join(tmp, "blob.bin");
    await fs.writeFile(dest, "old destination bytes");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("a partial failed attempt is truncated/recreated before the successful retry", async () => {
    const final = Buffer.from("attempt two complete ciphertext");
    const finalSha = createHash("sha256").update(final).digest("hex");
    let gets = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        gets++;
        if (gets === 1) return transientAfterPartialBody(new TextEncoder().encode("partial attempt one"));
        return new Response(final, { status: 200 });
      }
      return resp(200, {});
    }) as unknown as typeof fetch;

    await api().getBlobToFile(finalSha, dest);
    expect(await fs.readFile(dest, "utf8")).toBe(final.toString("utf8"));
    expect(gets).toBe(2);
  }, 15_000);
});

describe("multipart complete — NOT network-retried; present-check absorbs a lost response", () => {
  let tmp: string;
  let file: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-net-mp-"));
    file = path.join(tmp, "big.bin");
    await fs.writeFile(file, "x");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("a socket close on complete does NOT fire a second complete — recovery is the present-check", async () => {
    let completes = 0;
    let checks = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/multipart") && method === "POST") return resp(200, { uploadId: "up1", partSize: BIG }); // 1 part
      if (u.includes("/part/") && method === "PUT") return resp(200, {});
      if (u.endsWith("/complete") && method === "POST") {
        completes++;
        throw socketClosed(); // response lost — but the server may have published the blob
      }
      if (u.endsWith("/blobs/check") && method === "POST") {
        checks++;
        return resp(200, { missing: [] }); // present-check: the blob landed despite the drop
      }
      return resp(200, {});
    }) as unknown as typeof fetch;

    await api().putBlobFile(SHA, file, BIG); // resolves via the present-check, no throw
    expect(completes).toBe(1); // exactly ONE complete attempt — NOT auto-retried at the network layer
    expect(checks).toBeGreaterThanOrEqual(1); // the present-check is what absorbed the lost response
  }, 15_000);

  test("if the blob is genuinely absent after a complete drop, the friendly NetworkError surfaces", async () => {
    let completes = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/multipart") && method === "POST") return resp(200, { uploadId: "up1", partSize: BIG });
      if (u.includes("/part/") && method === "PUT") return resp(200, {});
      if (u.endsWith("/complete") && method === "POST") {
        completes++;
        throw socketClosed();
      }
      if (u.endsWith("/blobs/check") && method === "POST") return resp(200, { missing: [SHA] }); // still missing
      return resp(200, {});
    }) as unknown as typeof fetch;

    const err = await api().putBlobFile(SHA, file, BIG).catch((e) => e);
    // putBlobMultipart's second attempt (fresh init) also drops on complete → NetworkError, not the
    // raw Bun string. completes fired twice: once per multipart attempt (never a network retry).
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).not.toContain("verbose: true");
    expect(completes).toBe(2);
  }, 20_000);
});

describe("commit 409 — a duplicate after socket-close-post-apply passes through as a conflict", () => {
  test("the network layer returns the 409 Response; commit() maps it to { conflict }", async () => {
    let posts = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        posts++;
        return resp(409, { head: 42 }); // stale parent (our own already-applied commit)
      }
      return resp(200, {});
    }) as unknown as typeof fetch;
    const out = await api().commit(41, "dev1", { version: 1, files: [] } as never);
    expect(out.conflict).toBe(true);
    expect(out.head).toBe(42);
    expect(posts).toBe(1); // a Response is never retried — no double-submit
  });
});

describe("minting calls — retry-exhausted hint does not claim re-run safety", () => {
  test("workspace create says to check status/workspaces before re-running", async () => {
    globalThis.fetch = (async () => {
      throw socketClosed();
    }) as unknown as typeof fetch;
    const err = await createRemoteWorkspace("https://api.test", "tok", "proj_1").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain("creating the workspace");
    expect((err as Error).message).toContain("may or may not have completed");
    expect((err as Error).message).toContain("`rbox status` or your workspaces list");
    expect((err as Error).message).not.toContain("already-uploaded data is skipped");
  });

  test("pair create says to check device list for pair tokens before re-running", async () => {
    globalThis.fetch = (async () => {
      throw socketClosed();
    }) as unknown as typeof fetch;
    const err = await api().pairCreate({ tokenId: "tok_pair_1", mkWrap: "mk", admissionGrant: "grant" }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain("creating a pairing token");
    expect((err as Error).message).toContain("may or may not have completed");
    expect((err as Error).message).toContain("`rbox device list` for pair tokens");
    expect((err as Error).message).not.toContain("already-uploaded data is skipped");
  });
});
