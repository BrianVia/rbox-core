import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { enrollViaPairing } from "./e2ee-client.js";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("enrollViaPairing redeem errors", () => {
  test("device_limit_reached 409 explains the pairing token is still valid", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++;
      expect(String(input)).toBe("https://api.test/v1/auth/pair/redeem");
      return new Response(JSON.stringify({ error: "device_limit_reached", cap: 5, plan: "free" }), { status: 409 });
    }) as typeof fetch;

    const secret = Buffer.alloc(32).toString("base64url");
    await expect(enrollViaPairing("https://api.test", `rbox-pair_${"a".repeat(16)}.${secret}`, 1)).rejects.toThrow(
      "device limit reached (5/5 on free) — revoke a device or upgrade; pairing token still valid"
    );
    expect(calls).toBe(1);
  });
});
