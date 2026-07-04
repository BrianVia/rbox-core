import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatBinaryBytes } from "./quota-format.js";
import { RboxApi } from "./remote.js";
import { QuotaExceededError, readQuotaExceeded, translateRemoteError } from "./remote/errors.js";

const GiB = 1024 * 1024 * 1024;
const BIG = 100 * 1024 * 1024; // > SINGLE_PUT_MAX (90 MiB) → forces multipart
const SHA = "a".repeat(64);
const origFetch = globalThis.fetch;

function resp(status: number, body: unknown, reads?: { n: number }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      if (reads) reads.n++;
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    json: async () => body,
  } as Response;
}

describe("readQuotaExceeded", () => {
  test("storage quota 402 maps to a typed quota error", async () => {
    const reads = { n: 0 };
    const { quota, text } = await readQuotaExceeded(resp(402, { error: "quota_exceeded", used: 2 * GiB, cap: 2 * GiB }, reads));
    expect(reads.n).toBe(1);
    expect(text).toBe(JSON.stringify({ error: "quota_exceeded", used: 2 * GiB, cap: 2 * GiB }));
    expect(quota).toBeInstanceOf(QuotaExceededError);
    expect(quota?.kind).toBe("storage");
    expect(quota?.used).toBe(2 * GiB);
    expect(quota?.cap).toBe(2 * GiB);
  });

  test("workspace quota discriminator maps to workspaces kind", async () => {
    const { quota } = await readQuotaExceeded(resp(402, { error: "quota_exceeded", limit: "workspaces", cap: 1 }));
    expect(quota).toBeInstanceOf(QuotaExceededError);
    expect(quota?.kind).toBe("workspaces");
    expect(quota?.cap).toBe(1);
  });

  test("non-quota 402 and non-402 bodies pass through with preserved text", async () => {
    const nonQuota = await readQuotaExceeded(resp(402, { error: "payment_required", detail: "other" }));
    expect(nonQuota.quota).toBeNull();
    expect(nonQuota.text).toBe('{"error":"payment_required","detail":"other"}');

    const sha = await readQuotaExceeded(resp(400, { error: "sha_mismatch" }));
    expect(sha.quota).toBeNull();
    expect(sha.text).toBe('{"error":"sha_mismatch"}');
  });

  test("multipart complete 402 quota_exceeded maps to a typed quota error", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-remote-quota-test-"));
    const file = path.join(tmp, "ct.bin");
    const completeReads = { n: 0 };
    await fs.writeFile(file, "ciphertext-bytes");
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        if (u.endsWith("/multipart") && method === "POST") return resp(200, { uploadId: "up1", partSize: BIG });
        if (u.includes("/part/")) return resp(200, {});
        if (u.endsWith("/complete")) return resp(402, { error: "quota_exceeded", used: 2 * GiB, cap: 2 * GiB }, completeReads);
        if (u.endsWith("/blobs/check")) return resp(200, { missing: [SHA] });
        throw new Error(`unexpected fetch: ${method} ${u}`);
      }) as unknown as typeof fetch;

      const err = await new RboxApi("https://api.test", "durable-token", "ws_1", "proj_1")
        .putBlobFile(SHA, file, BIG)
        .catch((e) => e);
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect(err.message).toContain("Out of storage");
      expect(err.message).not.toContain("quota_exceeded");
      expect(completeReads.n).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("translateRemoteError", () => {
  test("friendly mappings cover common statuses while 402 preserves the raw fallback", () => {
    expect(translateRemoteError(401, "latest failed")).toBe("signed out — run rbox login");
    expect(translateRemoteError(403, "latest failed")).toBe("not permitted");
    expect(translateRemoteError(404, "latest failed", undefined, "workspace not found — check you're in the right directory")).toBe("workspace not found — check you're in the right directory");
    expect(translateRemoteError(503, "latest failed", "busy")).toBe("rbox servers are having trouble — try again shortly");
    expect(translateRemoteError(402, "usage failed", "{\"error\":\"payment_required\"}")).toBe('usage failed: 402 {"error":"payment_required"}');
  });
});

describe("quota formatting", () => {
  test("storage and workspace quota errors match the upgrade copy", () => {
    expect(new QuotaExceededError("storage", 2 * GiB, 2 * GiB).message).toBe(
      "Out of storage — 2.0 GiB of 2.0 GiB used. Upgrade with `rbox subscribe solo` (50 GiB), or free up space and run `rbox sync`."
    );
    expect(new QuotaExceededError("workspaces", undefined, 1).message).toBe(
      "Workspace limit reached — plan allows 1. Upgrade with `rbox subscribe solo` for unlimited workspaces."
    );
  });

  test("binary byte formatter uses 1024-based units and one decimal above bytes", () => {
    expect(formatBinaryBytes(1023)).toBe("1023 B");
    expect(formatBinaryBytes(1024)).toBe("1.0 KiB");
    expect(formatBinaryBytes(1536 * 1024 * 1024)).toBe("1.5 GiB");
    expect(formatBinaryBytes(2 * GiB)).toBe("2.0 GiB");
  });
});
