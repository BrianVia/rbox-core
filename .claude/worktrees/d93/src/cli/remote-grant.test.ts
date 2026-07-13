import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { RboxApi } from "./remote.js";

// §27 — the client captures the download grant from the pull handshake (`latestCommit()`)
// and presents it via `x-rbox-download-grant` on every subsequent blob GET, so the server
// can skip the per-blob D1 entitlement read. Old server (no grant field) → no header.

const origFetch = globalThis.fetch;
let calls: { url: string; headers: Record<string, string> }[] = [];

function stub(grantOnLatest: string | undefined): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
    if (u.endsWith("/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sequence: 1, commit: null, ...(grantOnLatest ? { grant: grantOnLatest } : {}) }),
      } as Response;
    }
    // blob GET
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
  }) as unknown as typeof fetch;
}

const api = () => new RboxApi("https://api.test", "durable-token", "ws_1", "proj_1");
const grantHdr = (i: number) => calls[i]!.headers["x-rbox-download-grant"];

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("§27 client download grant", () => {
  test("presents the grant on blob GETs AFTER the pull handshake hands one back", async () => {
    stub("grant-token-abc");
    const a = api();
    await a.latestCommit(); // captures the grant
    await a.getBlob("a".repeat(64));
    await a.getBlob("b".repeat(64));
    // call[0] = /latest (bearer only, no grant sent), call[1]+[2] = blob GETs (grant attached)
    expect(grantHdr(0)).toBeUndefined();
    expect(grantHdr(1)).toBe("grant-token-abc");
    expect(grantHdr(2)).toBe("grant-token-abc");
    // and the bearer is always present
    expect(calls[1]!.headers.authorization).toBe("Bearer durable-token");
  });

  test("sends NO grant header before a handshake, or when the server returns none (old server)", async () => {
    stub(undefined); // old server: /latest has no grant field
    const a = api();
    await a.getBlob("c".repeat(64)); // GET before any latest()
    await a.latestCommit(); // no grant captured
    await a.getBlob("d".repeat(64));
    expect(grantHdr(0)).toBeUndefined(); // pre-handshake GET
    expect(grantHdr(2)).toBeUndefined(); // post-(grantless)-handshake GET
  });
});
